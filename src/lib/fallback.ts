import "server-only";
import { db } from "./db";
import { DeadlineError, notePartial, stopForTime } from "./deadline";
import { log, recordEvent } from "./log";
import { createCheckoutConfiguration, storeClient } from "./whop";

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

/** Called after an unexpected checkout init failure. Never throws. */
export async function noteCheckoutFailure(storeId: string) {
  try {
    const store = await db.store.findUnique({ where: { id: storeId }, select: { autoFallback: true, fallbackActiveAt: true } });
    if (!store?.autoFallback || store.fallbackActiveAt) return;
    const since = new Date(Date.now() - WINDOW_MS);
    const [failing, working] = await Promise.all([
      db.eventLog.findMany({ where: { storeId, kind: "checkout.init_failed", createdAt: { gt: since } }, select: { sessionId: true }, distinct: ["sessionId"] }),
      // Any Whop checkout created meanwhile means Whop works (a single buyer's problem).
      db.checkoutQuote.count({ where: { createdAt: { gt: since }, session: { storeId } } }),
    ]);
    if (failing.length < TRIGGER || working > 0) return;
    const startedAt = new Date();
    const reason = `${failing.length} clients n'ont pas pu ouvrir le paiement Whop en 10 min`;
    const on = await db.store.updateMany({
      where: { id: storeId, fallbackActiveAt: null, autoFallback: true },
      data: { fallbackActiveAt: startedAt, fallbackReason: reason },
    });
    if (on.count) {
      await openFallbackPeriod(storeId, startedAt, reason);
      await recordEvent({
        storeId,
        level: "error",
        kind: "fallback.activated",
        message: `Whop ne répond plus (${failing.length} échecs en 10 min) : vos clients passent temporairement par le checkout Shopify. Retour automatique dès que Whop fonctionne.`,
        alert: true,
      });
    }
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
  const stores = await db.store.findMany({ where: { fallbackActiveAt: { lt: new Date(Date.now() - PROBE_AFTER_MS) } } });
  let restored = 0;
  for (const store of stores) {
    if (stopForTime(deadline)) break;
    const key = probeKey(store.id);
    const row = await db.appSetting.findUnique({ where: { key } });
    let state: ProbeState | null = null;
    try {
      state = row ? (JSON.parse(row.value) as ProbeState) : null;
    } catch {
      state = null;
    }
    // A probe state older than this fallback episode belongs to an earlier one.
    if (state && state.at < store.fallbackActiveAt!.getTime()) state = null;
    if (!probeDue(state)) continue;
    const mark = (failures: number) => {
      const value = JSON.stringify({ at: Date.now(), failures } satisfies ProbeState);
      return db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    };
    // Written before the call: a probe killed mid-flight still counts for the spacing.
    await mark(state?.failures ?? 0);
    let probeId: string | null = null;
    try {
      // Same call the checkout makes (a hidden 1 € plan, never shown to anyone).
      probeId = (
        await createCheckoutConfiguration(store, {
          sessionId: `probe_${store.id}`,
          storeId: store.id,
          totalCents: 100,
          currency: store.shopCurrency,
          title: "Vérification automatique",
          redirectUrl: "https://example.invalid/probe",
        })
      ).id;
    } catch (err) {
      // Out of time or Whop suspended for this run (breaker): not a probe result, retried next run.
      if (err instanceof DeadlineError) {
        notePartial();
        break;
      }
      await mark((state?.failures ?? 0) + 1);
      log.info("fallback.still_down", "Whop still failing, staying on Shopify checkout", { storeId: store.id, failures: (state?.failures ?? 0) + 1, err });
      continue;
    }
    // Clean up: the probe's configuration is never used by anyone.
    try {
      if (probeId) await storeClient(store).checkoutConfigurations.delete({ id: probeId });
    } catch (err) {
      log.info("fallback.probe_cleanup_failed", "Could not delete the probe checkout configuration", { storeId: store.id, err });
    }
    await db.appSetting.deleteMany({ where: { key } });
    const off = await db.store.updateMany({ where: { id: store.id, fallbackActiveAt: store.fallbackActiveAt }, data: { fallbackActiveAt: null, fallbackReason: null } });
    if (off.count) {
      restored++;
      await closeFallbackPeriod(store.id);
      const minutes = Math.round((Date.now() - store.fallbackActiveAt!.getTime()) / 60_000);
      await recordEvent({ storeId: store.id, level: "warn", kind: "fallback.cleared", message: `Whop fonctionne à nouveau : checkout personnalisé réactivé (après ${minutes} min sur le checkout Shopify).`, alert: true });
    }
  }
  return restored;
}
