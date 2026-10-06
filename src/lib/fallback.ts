import "server-only";
import { db } from "./db";
import { DeadlineError, notePartial, stopForTime } from "./deadline";
import { log, recordEvent } from "./log";
import { createCheckoutConfiguration, storeClient } from "./whop";
import { probeStripe } from "./stripe";
import { chooseProvider, PROVIDER_NAMES, providerConnected, providerOrder, type PaymentProvider, type ProviderStore } from "./payment-provider";
import type { Store } from "@prisma/client";

/*
 * Safety net: when Whop can't open checkouts (outage, frozen account, revoked key),
 * the storefront goes back to Shopify's own checkout automatically, so no sale is
 * lost; a background probe switches the custom checkout back on once Whop answers.
 */

const WINDOW_MS = 10 * 60_000;
/** Distinct buyers who hit an init failure within the window before switching. */
const TRIGGER = 3;
/** Minimum time in fallback before probing (avoid flapping). */
const PROBE_AFTER_MS = 5 * 60_000;

/*
 * History of the fallback periods (FallbackPeriod): analytics flag those days (sales went through
 * Shopify's own checkout, outside this app's figures). Best effort: never blocks the switch itself.
 */

/** Opens a period (the store just switched to Shopify's checkout). Never throws. */
export async function openFallbackPeriod(storeId: string, startedAt: Date, reason: string | null): Promise<void> {
  try {
    const open = await db.fallbackPeriod.findFirst({ where: { storeId, endedAt: null, kind: "fallback" }, select: { id: true } });
    if (!open) await db.fallbackPeriod.create({ data: { storeId, startedAt, reason: reason?.slice(0, 300) ?? null, kind: "fallback" } });
  } catch (err) {
    log.warn("fallback.period_failed", "Could not record the fallback period", { storeId, err });
  }
}

/** Closes the open period (the custom checkout is back). Never throws. */
export async function closeFallbackPeriod(storeId: string, endedAt = new Date()): Promise<void> {
  try {
    await db.fallbackPeriod.updateMany({ where: { storeId, endedAt: null, kind: "fallback" }, data: { endedAt } });
  } catch (err) {
    log.warn("fallback.period_failed", "Could not close the fallback period", { storeId, err });
  }
}

/**
 * The checkout was switched off (enabled true → false: by hand, or by a disconnection) or back on:
 * opens / closes a "disabled" period (FallbackPeriod kind "disabled"), shown on the analytics charts
 * like the automatic fallback — sales of those hours went through Shopify's own checkout. Idempotent
 * (one open period at most), never throws.
 */
export async function recordCheckoutEnabled(storeId: string, wasEnabled: boolean, enabled: boolean, reason: string | null = null): Promise<void> {
  if (wasEnabled === enabled) return;
  try {
    if (!enabled) {
      const open = await db.fallbackPeriod.findFirst({ where: { storeId, endedAt: null, kind: "disabled" }, select: { id: true } });
      if (!open) await db.fallbackPeriod.create({ data: { storeId, startedAt: new Date(), reason: reason?.slice(0, 300) ?? null, kind: "disabled" } });
    } else {
      await db.fallbackPeriod.updateMany({ where: { storeId, endedAt: null, kind: "disabled" }, data: { endedAt: new Date() } });
    }
  } catch (err) {
    log.warn("fallback.period_failed", "Could not record the checkout's disabled period", { storeId, err });
  }
}

/** The processor a journaled init failure was attributed to (rows written before Stripe: Whop). Pure. */
export function failureSourceOf(data: unknown): PaymentProvider {
  const source = data && typeof data === "object" ? (data as { source?: unknown }).source : undefined;
  return source === "stripe" ? "stripe" : "whop";
}

/** The processor new sessions of the store use by its mode alone: the secondary during a failover, else the primary. Pure. */
export function activeProvider(store: Pick<Store, "paymentMode" | "providerFailoverAt">): PaymentProvider {
  const [primary, secondary] = providerOrder(store.paymentMode);
  return store.providerFailoverAt && secondary ? secondary : primary;
}

/**
 * The processor new sessions of the store really use now (chooseProvider: mode, failover AND
 * connections): Stripe when Whop is disconnected under "Whop principal", so Stripe's failures count
 * then. Falls back to activeProvider when none is usable. Pure.
 */
export function effectiveProvider(store: ProviderStore): PaymentProvider {
  return chooseProvider(store)?.provider ?? activeProvider(store);
}

/**
 * A journaled failure row that never counts towards the store (forced test session, a processor's
 * refusal, a browser failure report from a session not served that processor's form moments before). Pure.
 */
export function uncountedFailure(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const d = data as { forced?: unknown; rejected?: unknown; unverified?: unknown };
  return d.forced === true || d.rejected === true || d.unverified === true;
}

/** Hysteresis: after a failover ends, failures from before the end never flip the store again. */
export const REFAILOVER_GUARD_MS = 10 * 60_000;
/** A failover starting again within this time of the previous one's end is journaled without a new alert (one alert per cycle). */
export const FLAP_QUIET_MS = 60 * 60_000;
export const providerCycleKey = (storeId: string) => `provider-cycle:${storeId}`;
type ProviderCycle = { clearedAt?: number | null; switchedAt?: number | null; alerted?: boolean };

async function readCycle(storeId: string): Promise<ProviderCycle | null> {
  try {
    const row = await db.appSetting.findUnique({ where: { key: providerCycleKey(storeId) } });
    return row ? (JSON.parse(row.value) as ProviderCycle) : null;
  } catch {
    return null;
  }
}

async function writeCycle(storeId: string, cycle: ProviderCycle): Promise<void> {
  const key = providerCycleKey(storeId);
  const value = JSON.stringify(cycle);
  await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch((err: unknown) => log.warn("fallback.cycle_failed", "Could not record the failover cycle", { storeId, err }));
}

/** Records the end of a failover (probe, or the primary seen working): the hysteresis starts. Returns whether its end alerts. */
export async function noteFailoverCleared(storeId: string, at = Date.now()): Promise<boolean> {
  const cycle = await readCycle(storeId);
  await writeCycle(storeId, { ...cycle, clearedAt: at });
  return cycle?.alerted !== false;
}

/**
 * Called after an unexpected checkout init failure of a processor (Whop by default). Never throws.
 * Failures are counted per processor (distinct buyers within 10 min, none of its checkouts created
 * meanwhile). When the processor new sessions use reaches the threshold:
 * - it is the mode's primary and the secondary is usable → store-level failover (providerFailoverAt:
 *   new sessions pay with the secondary on the same page; journal fallback.provider_switched + alert);
 * - otherwise (the secondary failing too during a failover, or no usable secondary) → Shopify's own
 *   checkout (fallbackActiveAt, when the automatic fallback is on), as before.
 * Failures of the other processor (sessions already switched, a sticky session) never flip the store.
 * The processor "new sessions use" is the effective one (effectiveProvider: connections included).
 *
 * `kind`: the journal rows counted. "checkout.init_failed" (the server couldn't open the payment)
 * by default; "checkout.client_failed" (the processor's form couldn't load in the buyer's browser)
 * is counted apart, never mixed with server failures, and "working" then means a buyer of that
 * processor got as far as the Pay click. Rows of forced test sessions and processor refusals never
 * count (uncountedFailure).
 *
 * During a failover, the secondary failing while the primary created checkouts in the window (its
 * sticky sessions work): the failover ends (back to the primary) instead of Shopify's checkout.
 * Hysteresis: within 10 min of a failover's end, only failures after that end count; a failover
 * starting again within the hour is journaled without a new alert (one alert per cycle).
 */
export async function noteCheckoutFailure(storeId: string, source: PaymentProvider = "whop", kind = "checkout.init_failed") {
  try {
    const store = await db.store.findUnique({ where: { id: storeId } });
    if (!store || store.fallbackActiveAt) return;
    if (source !== effectiveProvider(store)) return;
    const [primary, secondary] = providerOrder(store.paymentMode);
    const canFailover = source === primary && !store.providerFailoverAt && !!secondary && providerConnected(store, secondary);
    const other: PaymentProvider = source === "whop" ? "stripe" : "whop";
    const otherBack = !!store.providerFailoverAt && other === primary && providerConnected(store, other);
    // A form failing in buyers' browsers (reported by the page, so forgeable, and often an ad
    // blocker): at most a switch between processors, never Shopify's own checkout.
    const client = kind !== "checkout.init_failed";
    if (!canFailover && !otherBack && (client || !store.autoFallback)) return;
    const now = Date.now();
    const cycle = canFailover ? await readCycle(storeId) : null;
    const clearedAt = cycle?.clearedAt ?? 0;
    // Hysteresis: right after a failover ended, only failures since its end count.
    const since = new Date(canFailover && now - clearedAt < REFAILOVER_GUARD_MS ? Math.max(now - WINDOW_MS, clearedAt) : now - WINDOW_MS);
    const [rows, working, otherWorking] = await Promise.all([
      db.eventLog.findMany({ where: { storeId, kind, createdAt: { gt: since } }, select: { sessionId: true, data: true } }),
      client
        ? // The form loaded for someone meanwhile (a Pay click on this processor): one buyer's browser.
          db.checkoutSession.count({ where: { storeId, paymentProvider: source, payClickedAt: { gt: since } } })
        : // Any checkout of this processor created meanwhile means it works (a single buyer's problem).
          db.checkoutQuote.count({ where: { createdAt: { gt: since }, provider: source, session: { storeId } } }),
      otherBack ? db.checkoutQuote.count({ where: { createdAt: { gt: since }, provider: other, session: { storeId } } }) : Promise.resolve(0),
    ]);
    const failing = new Set(rows.filter((r) => failureSourceOf(r.data) === source && !uncountedFailure(r.data)).map((r) => r.sessionId)).size;
    if (failing < TRIGGER || working > 0) return;
    const name = PROVIDER_NAMES[source];
    if (canFailover) {
      const to = secondary!;
      const reason = `${failing} clients n'ont pas pu ouvrir le paiement ${name} en 10 min`;
      const on = await db.store.updateMany({ where: { id: storeId, providerFailoverAt: null, fallbackActiveAt: null }, data: { providerFailoverAt: new Date(), providerFailoverReason: reason } });
      if (on.count) {
        // Flapping (it ended less than an hour ago): journaled, but the merchant was already alerted.
        const alert = !(clearedAt && now - clearedAt < FLAP_QUIET_MS);
        await writeCycle(storeId, { clearedAt: clearedAt || null, switchedAt: now, alerted: alert });
        await recordEvent({
          storeId,
          level: "error",
          kind: "fallback.provider_switched",
          message: `${name} ne répond plus (${failing} échecs en 10 min) : vos nouveaux clients paient avec ${PROVIDER_NAMES[to]}, sur la même page. Retour automatique à ${name} dès qu'il fonctionne.`,
          data: { from: source, to, failures: failing, ...(client ? { kind } : {}) },
          alert,
        });
      }
      return;
    }
    // The secondary fails during a failover, but the primary's sticky sessions keep creating checkouts:
    // the primary works again, new sessions go back to it (not to Shopify's checkout).
    if (otherBack && otherWorking > 0) {
      const off = await db.store.updateMany({ where: { id: storeId, providerFailoverAt: store.providerFailoverAt, fallbackActiveAt: null }, data: { providerFailoverAt: null, providerFailoverReason: null } });
      if (off.count) {
        await db.appSetting.deleteMany({ where: { key: providerProbeKey(storeId) } });
        const alert = await noteFailoverCleared(storeId, now);
        await recordEvent({
          storeId,
          level: "warn",
          kind: "fallback.provider_cleared",
          message: `${name} ne répond plus (${failing} échecs en 10 min) mais ${PROVIDER_NAMES[other]} fonctionne à nouveau : vos nouveaux clients paient de nouveau avec ${PROVIDER_NAMES[other]}.`,
          data: { provider: other, failing: source, failures: failing },
          alert,
        });
      }
      return;
    }
    // Never Shopify's checkout on its own: the buyers stay on ours (the merchant is alerted by the
    // failures themselves, and the processor failover above keeps them paying when it can).
  } catch (err) {
    log.error("fallback.check_failed", "Could not evaluate the checkout fallback", { storeId, err });
  }
}

/** Probe spacing while Whop stays down: 10 min, then doubling, capped at 1 h. */
export const PROBE_BASE_MS = 10 * 60_000;
export const PROBE_MAX_MS = 60 * 60_000;
export const probeKey = (storeId: string) => `fallback-probe:${storeId}`;

type ProbeState = { at: number; failures: number };

/** Is a probe due for this store (never more often than the spacing above)? */
function probeDue(state: ProbeState | null, now = Date.now()) {
  if (!state) return true;
  return now - state.at >= Math.min(PROBE_BASE_MS * 2 ** Math.max(0, state.failures - 1), PROBE_MAX_MS);
}

/**
 * Background probe: can Whop open a checkout again? Then switch back. Each probe creates
 * one real (hidden) checkout configuration, so probes are spaced (10 min, doubling up to
 * 1 h while Whop keeps failing) instead of running on every tick, and the probe's
 * configuration is deleted right after.
 */
export async function probeFallbacks(deadline: number): Promise<number> {
  const cutoff = new Date(Date.now() - PROBE_AFTER_MS);
  const stores = await db.store.findMany({ where: { OR: [{ fallbackActiveAt: { lt: cutoff } }, { fallbackActiveAt: null, providerFailoverAt: { lt: cutoff } }] } });
  let restored = 0;
  for (const store of stores) {
    if (stopForTime(deadline)) break;
    // Shopify's own checkout on: its probe (one key per episode); else a processor failover's.
    const onShopify = !!store.fallbackActiveAt;
    const episodeAt = (store.fallbackActiveAt ?? store.providerFailoverAt)!;
    const key = onShopify ? probeKey(store.id) : providerProbeKey(store.id);
    const row = await db.appSetting.findUnique({ where: { key } });
    let state: ProbeState | null = null;
    try {
      state = row ? (JSON.parse(row.value) as ProbeState) : null;
    } catch {
      state = null;
    }
    // A probe state older than this fallback episode belongs to an earlier one.
    if (state && state.at < episodeAt.getTime()) state = null;
    if (!probeDue(state)) continue;
    const mark = (failures: number) => {
      const value = JSON.stringify({ at: Date.now(), failures } satisfies ProbeState);
      return db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    };
    // Written before the call: a probe killed mid-flight still counts for the spacing.
    await mark(state?.failures ?? 0);
    const [primary, secondary] = providerOrder(store.paymentMode);
    // On Shopify's checkout: whichever processor answers first (primary first) brings the custom
    // checkout back. During a failover only: the primary (its recovery ends the failover).
    const usable = providerOrder(store.paymentMode).filter((p) => providerConnected(store, p));
    const candidates: PaymentProvider[] = onShopify ? (usable.length ? usable : [primary]) : [primary];
    let working: PaymentProvider | null = null;
    let lastErr: unknown = null;
    let outOfTime = false;
    for (const p of candidates) {
      try {
        await probeProvider(store, p);
        working = p;
        break;
      } catch (err) {
        // Out of time or the processor suspended for this run (breaker): not a probe result, retried next run.
        if (err instanceof DeadlineError) {
          outOfTime = true;
          break;
        }
        lastErr = err;
      }
    }
    if (outOfTime) {
      notePartial();
      break;
    }
    if (!working) {
      await mark((state?.failures ?? 0) + 1);
      log.info("fallback.still_down", onShopify ? "Processors still failing, staying on Shopify checkout" : `${PROVIDER_NAMES[primary]} still failing, staying on the secondary processor`, {
        storeId: store.id,
        failures: (state?.failures ?? 0) + 1,
        err: lastErr,
      });
      continue;
    }
    await db.appSetting.deleteMany({ where: { key } });
    if (onShopify) {
      // The secondary answered while the primary still fails: the custom checkout comes back on it.
      const failover = working !== primary && !store.providerFailoverAt ? { providerFailoverAt: new Date(), providerFailoverReason: `${PROVIDER_NAMES[primary]} toujours indisponible à la sortie du checkout Shopify` } : {};
      const primaryBack = working === primary && store.providerFailoverAt ? { providerFailoverAt: null, providerFailoverReason: null } : {};
      const off = await db.store.updateMany({ where: { id: store.id, fallbackActiveAt: store.fallbackActiveAt }, data: { fallbackActiveAt: null, fallbackReason: null, ...failover, ...primaryBack } });
      if (off.count) {
        restored++;
        await closeFallbackPeriod(store.id);
        if (working === primary && store.providerFailoverAt) await noteFailoverCleared(store.id);
        const minutes = Math.round((Date.now() - store.fallbackActiveAt!.getTime()) / 60_000);
        await recordEvent({
          storeId: store.id,
          level: "warn",
          kind: "fallback.cleared",
          message: `${PROVIDER_NAMES[working]} fonctionne à nouveau : checkout personnalisé réactivé (après ${minutes} min sur le checkout Shopify).${working !== primary ? ` Les paiements passent par ${PROVIDER_NAMES[working]} tant que ${PROVIDER_NAMES[primary]} ne répond pas.` : ""}`,
          data: { provider: working },
          alert: true,
        });
      }
      continue;
    }
    const off = await db.store.updateMany({ where: { id: store.id, providerFailoverAt: store.providerFailoverAt }, data: { providerFailoverAt: null, providerFailoverReason: null } });
    if (off.count) {
      restored++;
      const minutes = Math.round((Date.now() - store.providerFailoverAt!.getTime()) / 60_000);
      // Hysteresis starts; a flapping cycle (journaled without alert) ends without one either.
      const alert = await noteFailoverCleared(store.id);
      await recordEvent({
        storeId: store.id,
        level: "warn",
        kind: "fallback.provider_cleared",
        message: `${PROVIDER_NAMES[primary]} fonctionne à nouveau : les nouveaux clients paient de nouveau avec ${PROVIDER_NAMES[primary]} (après ${minutes} min sur ${secondary ? PROVIDER_NAMES[secondary] : "le secours"}). Les paiements déjà ouverts sur ${secondary ? PROVIDER_NAMES[secondary] : "le secours"} se terminent sur place.`,
        data: { provider: primary },
        alert,
      });
    }
  }
  return restored;
}

export const providerProbeKey = (storeId: string) => `provider-probe:${storeId}`;

/**
 * One recovery probe of a processor; throws when it still fails. Whop: the same call the checkout
 * makes (a hidden 1 € plan, never shown to anyone, deleted right after). Stripe: the connected
 * account answers and can take payments.
 */
async function probeProvider(store: Store, p: PaymentProvider): Promise<void> {
  if (p === "stripe") return probeStripe(store);
  const probeId = (
    await createCheckoutConfiguration(store, {
      sessionId: `probe_${store.id}`,
      storeId: store.id,
      totalCents: 100,
      currency: store.shopCurrency,
      title: "Vérification automatique",
      redirectUrl: "https://example.invalid/probe",
    })
  ).id;
  // Clean up: the probe's configuration is never used by anyone.
  try {
    if (probeId) await storeClient(store).checkoutConfigurations.delete({ id: probeId });
  } catch (err) {
    log.info("fallback.probe_cleanup_failed", "Could not delete the probe checkout configuration", { storeId: store.id, err });
  }
}
