import "server-only";
import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { decrypt } from "./crypto";
import { recordEvent } from "./log";
import { recordIncident } from "./incidents";
import { DeadlineError, notePartial, stopForTime } from "./deadline";
import {
  conversionActionName,
  googleAccessToken,
  googleDateTime,
  GoogleApiError,
  googleErrorScope,
  GooglePartialFailure,
  uploadClickConversion,
  uploadConversionAdjustment,
  type GoogleAdsCredentials,
  type GoogleErrorScope,
} from "./adspend-google";

/*
 * Google Ads offline conversions: every paid order that came from a Google Ads click (gclid, or
 * gbraid / wbraid for iOS app and web-to-app clicks, kept by the storefront loader) is uploaded
 * as a ClickConversion (`customers/{id}:uploadClickConversions`) to the conversion action set in
 * the store's settings, with the order's amount and currency, dated at the payment. The order id
 * is our checkout id: Google deduplicates on it, so a retried upload never counts twice.
 * Test orders are never uploaded. Consent: the same rule as the Meta / TikTok events — when the
 * store requires marketing consent, only with it; otherwise unless the buyer refused — for the
 * conversion and for the hashed e-mail (enhanced conversions) alike.
 * Runs from the background tick, 5 tries per order, 60 days back. An error of the whole account
 * (see RunSampler: a known account-level code, or the same error on the first orders of a run, whatever
 * the HTTP status) stops the store's run without spending their tries, and alerts. Refunds, dispute
 * outcomes and one-click offers flag the order (googleAdsAdjustDue, tries given back), then the
 * conversion is adjusted (uploadConversionAdjustments by order id): RETRACTION when the order is fully
 * refunded or its dispute lost, RESTATEMENT to the new value otherwise.
 */

const LOOKBACK_DAYS = 60;
const MAX_ATTEMPTS = 5;
const BATCH = 50;
/** Time kept before the run's hard deadline to start one more order (one Google call). */
const RESERVE_MS = 12_000;
/**
 * The same orders stopping a store's run this many times in a row (an unknown error sampled as the
 * account's, never a known account-level code): they are the problem, not the account — each gets a
 * try spent, so the queue (ordered by tries, then payment) moves past them.
 */
export const HEAD_STOP_LIMIT = 3;
/** Orders of a run failing with the same account-wide error before the store's run stops. */
export const ACCOUNT_ERROR_SAMPLE = 3;
/** Adjustments wait until Google has processed the conversion (CONVERSION_NOT_FOUND before). */
export const ADJUST_AFTER_MS = 6 * 3600_000;
const ADJUST_BACKOFF_H = [1, 6, 24, 48];
export const MAX_ADJUST_ATTEMPTS = ADJUST_BACKOFF_H.length + 1;
export const MAX_UPLOAD_ATTEMPTS = MAX_ATTEMPTS;
/** Errors written on orders closed without a try (nothing will ever be sent): not "abandoned". */
export const UPLOAD_NOT_APPLICABLE = ["consentement marketing absent", "pas d'identifiant de clic"];
/** A pending upload older than this (paid) isn't being drained: the probe reports it. */
export const UPLOAD_OVERDUE_MS = 6 * 3600_000;

/**
 * Written together with anything that changes an order's conversion value (refund, dispute outcome,
 * offer paid or refunded): the adjustment job re-checks the order, with its tries given back (a new
 * target value is a new adjustment, even after giving up on the previous one).
 */
export const GOOGLE_ADJUST_DUE = { googleAdsAdjustDue: true, googleAdsAdjustAttempts: 0, googleAdsAdjustNextAt: null } as const;

/** Flags an order's conversion for adjustment (writers on other tables: offers). Never throws. */
export async function markGoogleAdjustDue(sessionId: string): Promise<void> {
  await db.checkoutSession.updateMany({ where: { id: sessionId }, data: GOOGLE_ADJUST_DUE }).catch(() => undefined);
}

type Touch = { gclid?: string; gbraid?: string; wbraid?: string };

/** Click id of a touch (last touch first, else the first one), or null. Pure. */
export function googleClickOf(utm: unknown, firstUtm?: unknown): Touch | null {
  for (const raw of [utm, firstUtm]) {
    const t = (raw ?? {}) as Record<string, unknown>;
    const pick = (k: string) => (typeof t[k] === "string" && /^[\w\-.~]{10,300}$/.test(t[k] as string) ? (t[k] as string) : undefined);
    const click = { gclid: pick("gclid"), gbraid: pick("gbraid"), wbraid: pick("wbraid") };
    if (click.gclid || click.gbraid || click.wbraid) return click;
  }
  return null;
}

/** SHA-256 of an e-mail normalized as Google asks (trimmed, lower case; gmail dots removed). Pure. */
export function hashEmailForGoogle(email: string): string {
  let e = email.trim().toLowerCase();
  const [local, domain] = e.split("@");
  if (domain === "gmail.com" || domain === "googlemail.com") e = `${local.replace(/\./g, "")}@${domain}`;
  return createHash("sha256").update(e).digest("hex");
}

/**
 * Upload allowed, and e-mail allowed, per the store's consent setting and the buyer's banner answer:
 * the Meta / TikTok rule (consentAllows) — consent required: only with it; else unless refused. Pure.
 */
export function googleConsent(requireConsent: boolean, marketing: boolean | null | undefined): { upload: boolean; email: boolean } {
  const ok = requireConsent ? marketing === true : marketing !== false;
  return { upload: ok, email: ok };
}

/** A Google error that concerns the whole account, not one order (HTTP 4xx other than 429). Pure. */
export function accountWideStatus(err: unknown): number | null {
  const status = err instanceof GoogleApiError ? err.status : null;
  return status != null && status >= 400 && status < 500 && status !== 429 ? status : null;
}

/** Scope of an upload / adjustment failure from Google's error codes (partial failure or HTTP body). Pure. */
export function failureScope(err: unknown): GoogleErrorScope {
  if (err instanceof GooglePartialFailure) return err.scope;
  if (err instanceof GoogleApiError && err.codes.length) return googleErrorScope(err.codes, err.message);
  return "unknown";
}

type Failure = { id: string; message: string };

/**
 * One store's run over its orders: decides for each failure whether it is the order's (its try is
 * spent) or the account's (the run stops, no try spent: the caller journals the incident and alerts).
 *  - a known account-level code (conversion action missing / disabled, customer data terms, allowlist,
 *    authentication / authorization) → the account's, at once, at any point of the run;
 *  - a known order-level code (click id, dates, order id) → the order's;
 *  - anything else (HTTP error, network, an unknown partial failure) during the run's first failures
 *    is held back: the same message on ACCOUNT_ERROR_SAMPLE orders in a row is the account's, whatever
 *    the HTTP status; a success, an order-level failure or another message releases them as per order.
 * Residual risk: an unknown per-order error identical on the run's first orders stops the run (no try
 * lost, alerted, "Relancer les conversions abandonnées" once fixed) instead of spending their tries.
 */
export class RunSampler {
  private held: Failure[] = [];
  private sampling = true;
  constructor(private readonly spend: (f: Failure) => Promise<void>) {}

  async succeeded() {
    if (this.sampling) await this.release();
  }

  /** The account-wide failure (the run must stop; `ids` show the error, no try spent), or null. */
  async failed(id: string, err: unknown, message: string): Promise<{ ids: string[]; message: string; scope: GoogleErrorScope; status: number | null } | null> {
    const scope = failureScope(err);
    const status = err instanceof GoogleApiError ? err.status : null;
    if (scope === "account") {
      const ids = [...this.held.filter((h) => h.message === message).map((h) => h.id), id];
      // Held failures with another message: per order after all.
      for (const h of this.held.filter((h) => h.message !== message)) await this.spend(h);
      this.held = [];
      return { ids, message, scope, status };
    }
    if (!this.sampling) {
      await this.spend({ id, message });
      return null;
    }
    this.held.push({ id, message });
    if (scope === "order" || this.held.some((h) => h.message !== message)) {
      await this.release();
      return null;
    }
    if (this.held.length >= ACCOUNT_ERROR_SAMPLE) {
      const ids = this.held.map((h) => h.id);
      this.held = [];
      return { ids, message, scope, status };
    }
    return null;
  }

  /** End of the run (batch or time budget) with fewer failures than the sample: per order after all. */
  async finish() {
    if (this.held.length) await this.release();
  }

  private async release() {
    this.sampling = false;
    const held = this.held;
    this.held = [];
    for (const f of held) await this.spend(f);
  }
}

/** Journals a store's account-wide Google error (upload or adjustment run stopped, nothing lost). */
async function accountError(storeId: string, what: "uploads" | "adjustments", stop: { message: string; scope: GoogleErrorScope; status: number | null }) {
  await recordIncident({
    storeId,
    kind: "google.conversions_account_error",
    message:
      what === "uploads"
        ? `Google Ads refuse toutes les conversions hors ligne (${stop.message}) : envoi suspendu, rien n'est perdu (nouvel essai au prochain passage). Vérifiez le jeton développeur, l'accès au compte et l'action de conversion.`
        : `Google Ads refuse les ajustements de conversions (${stop.message}) : ajustements suspendus, rien n'est perdu (nouvel essai au prochain passage). Vérifiez l'accès au compte et l'action de conversion.`,
    data: { status: stop.status, scope: stop.scope, err: stop.message, what },
    everyMs: 6 * 3600_000,
  });
}

/**
 * First (and later) failed tries of an upload or adjustment, before giving up: a throttled journal row
 * (no alert: the automation retries), so the health tile's "échec(s) sur 24 h" shows tries in progress.
 */
async function retrying(storeId: string, sessionId: string, what: "upload" | "adjustment", attempts: number, max: number, message: string) {
  await recordIncident({
    storeId,
    sessionId,
    kind: "google.conversion_retrying",
    message: `${what === "upload" ? "Conversion hors ligne" : "Ajustement de conversion"} Google Ads en échec (essai ${attempts}/${max}, nouvel essai automatique) : ${message}`,
    data: { what, attempts, err: message },
    alert: false,
    everyMs: 3600_000,
  });
}

const googleStores = (storeId?: string) =>
  db.store.findMany({
    where: {
      ...(storeId ? { id: storeId } : {}),
      googleAdsConversionAction: { not: null },
      googleAdsCustomerId: { not: null },
      googleAdsRefreshToken: { not: null },
      googleAdsDeveloperToken: { not: null },
      googleAdsClientId: { not: null },
      googleAdsClientSecret: { not: null },
    },
  });

type GoogleStore = Awaited<ReturnType<typeof googleStores>>[number];

function credentialsOf(store: GoogleStore): GoogleAdsCredentials {
  return {
    customerId: store.googleAdsCustomerId!,
    loginCustomerId: store.googleAdsLoginCustomerId,
    developerToken: decrypt(store.googleAdsDeveloperToken!),
    clientId: store.googleAdsClientId!,
    clientSecret: decrypt(store.googleAdsClientSecret!),
    refreshToken: decrypt(store.googleAdsRefreshToken!),
  };
}

/** Access token, or null after journaling the incident (the store's run is skipped). */
async function tokenFor(store: GoogleStore, creds: GoogleAdsCredentials): Promise<string | null> {
  try {
    return await googleAccessToken(creds);
  } catch (err) {
    // Out of time before the call: not a connection problem (the caller stops, retried next run).
    if (err instanceof DeadlineError) throw err;
    await recordIncident({
      storeId: store.id,
      kind: "google.conversions_auth_failed",
      message: `Google Ads : connexion refusée (jeton OAuth), conversions hors ligne non envoyées. Reconnectez Google Ads dans Pub & pixels › Dépenses publicitaires. ${err instanceof Error ? err.message.slice(0, 200) : ""}`.trim(),
      data: { err: err instanceof Error ? err.message : String(err) },
      everyMs: 6 * 3600_000,
    });
    return null;
  }
}

/**
 * Head-of-line guard: records a run stopped by the same orders (sorted ids) as the previous stops;
 * true when they stopped HEAD_STOP_LIMIT runs in a row (the counter restarts). Known account-level
 * codes never count (the account really is the problem).
 */
async function sameHeadStopped(storeId: string, what: "uploads" | "adjustments", ids: string[], scope: GoogleErrorScope): Promise<boolean> {
  const key = `google-stop:${storeId}:${what}`;
  if (scope === "account") {
    await db.appSetting.deleteMany({ where: { key } });
    return false;
  }
  const head = [...ids].sort().join(",");
  const row = await db.appSetting.findUnique({ where: { key } });
  let prev: { head: string; count: number } | null = null;
  try {
    prev = row ? (JSON.parse(row.value) as { head: string; count: number }) : null;
  } catch {
    prev = null;
  }
  const count = prev?.head === head ? prev.count + 1 : 1;
  const reached = count >= HEAD_STOP_LIMIT;
  const value = JSON.stringify({ head, count: reached ? 0 : count });
  await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  return reached;
}

/** A run went through (or failed per order): the head-of-line streak is over. */
async function clearHeadStops(storeId: string, what: "uploads" | "adjustments") {
  await db.appSetting.deleteMany({ where: { key: `google-stop:${storeId}:${what}` } });
}

export async function uploadGoogleConversions(deadline: number, opts: { storeId?: string } = {}): Promise<number> {
  const stores = await googleStores(opts.storeId);
  let uploaded = 0;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  for (const store of stores) {
    if (stopForTime(deadline, RESERVE_MS)) break;
    const action = conversionActionName(store.googleAdsConversionAction, store.googleAdsCustomerId);
    if (!action) continue;
    // Test orders are never sent to Google (even in test mode: they aren't real conversions).
    const ids = await db.$queryRaw<{ id: string }[]>`
      SELECT s.id FROM "CheckoutSession" s
      WHERE s."storeId" = ${store.id} AND s.status = 'PAID' AND s."paidAt" >= ${since} AND s."test" = false
        AND s."googleAdsUploadedAt" IS NULL AND s."googleAdsUploadAttempts" < ${MAX_ATTEMPTS}
        AND (s.utm ?| array['gclid','gbraid','wbraid'] OR s."firstUtm" ?| array['gclid','gbraid','wbraid'])
      ORDER BY s."googleAdsUploadAttempts" ASC, s."paidAt" ASC LIMIT ${BATCH}`;
    if (!ids.length) continue;
    const creds = credentialsOf(store);
    let token: string | null;
    try {
      token = await tokenFor(store, creds);
    } catch (err) {
      if (err instanceof DeadlineError) {
        notePartial();
        break;
      }
      throw err;
    }
    if (!token) continue;
    // Fewest tries first: orders that keep failing never hold the queue ahead of fresh ones.
    const sessions = await db.checkoutSession.findMany({ where: { id: { in: ids.map((r) => r.id) } }, orderBy: [{ googleAdsUploadAttempts: "asc" }, { paidAt: "asc" }] });
    const spend = async (f: { id: string; message: string }) => {
      const row = await db.checkoutSession.update({ where: { id: f.id }, data: { googleAdsUploadAttempts: { increment: 1 }, googleAdsUploadError: f.message }, select: { googleAdsUploadAttempts: true } });
      if (row.googleAdsUploadAttempts >= MAX_ATTEMPTS)
        await recordEvent({ storeId: store.id, sessionId: f.id, level: "warn", kind: "google.conversion_failed", message: `Conversion hors ligne Google Ads non envoyée après ${MAX_ATTEMPTS} essais : ${f.message}` });
      else await retrying(store.id, f.id, "upload", row.googleAdsUploadAttempts, MAX_ATTEMPTS, f.message);
    };
    const sampler = new RunSampler(spend);
    let stopped = false;
    let progressed = false;
    for (const s of sessions) {
      if (stopForTime(deadline, RESERVE_MS)) break;
      const click = googleClickOf(s.utm, s.firstUtm);
      const consent = googleConsent(store.pixelRequireConsent, (s.tracking as { marketing?: boolean | null } | null)?.marketing);
      if (!click || !consent.upload) {
        // Nothing to send for this order, ever: closed without a try.
        await db.checkoutSession.update({ where: { id: s.id }, data: { googleAdsUploadAttempts: MAX_ATTEMPTS, googleAdsUploadError: click ? UPLOAD_NOT_APPLICABLE[0] : UPLOAD_NOT_APPLICABLE[1] } });
        continue;
      }
      const valueCents = s.totalCents || s.subtotalCents;
      try {
        await uploadClickConversion(creds, token, {
          conversionAction: action,
          ...click,
          conversionDateTime: googleDateTime(s.paidAt ?? s.updatedAt),
          conversionValue: Math.round(valueCents) / 100,
          currencyCode: s.currency,
          orderId: s.id,
          ...(consent.email && s.email ? { hashedEmail: hashEmailForGoogle(s.email) } : {}),
        });
        await db.checkoutSession.update({ where: { id: s.id }, data: { googleAdsUploadedAt: new Date(), googleAdsUploadError: null, googleAdsValueCents: valueCents } });
        uploaded++;
        progressed = true;
        await sampler.succeeded();
      } catch (err) {
        // Out of time before the call: no try spent, the rest waits for the next run.
        if (err instanceof DeadlineError) {
          notePartial();
          break;
        }
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        const stop = await sampler.failed(s.id, err, message);
        if (stop) {
          // The account refuses every order: stop here, no try spent (the error is shown on them) —
          // unless the same orders stopped the last runs: then they are the problem, a try is spent.
          await db.checkoutSession.updateMany({ where: { id: { in: stop.ids } }, data: { googleAdsUploadError: stop.message } });
          if (await sameHeadStopped(store.id, "uploads", stop.ids, stop.scope)) {
            for (const id of stop.ids) await spend({ id, message: stop.message });
            await recordEvent({
              storeId: store.id,
              level: "warn",
              kind: "google.head_of_line",
              message: `Conversions Google Ads : les mêmes ${stop.ids.length} commande(s) bloquent l'envoi depuis ${HEAD_STOP_LIMIT} passages (${stop.message}) : un essai leur est compté et les autres commandes passent devant.`,
              data: { ids: stop.ids, what: "uploads" },
            });
          } else await accountError(store.id, "uploads", stop);
          stopped = true;
          break;
        }
        progressed = true;
      }
    }
    if (!stopped) {
      await sampler.finish();
      if (progressed) await clearHeadStops(store.id, "uploads");
    }
  }
  return uploaded;
}

/* ------------------------------------------------------------------ */
/* Adjustments: refunds, lost disputes, one-click offers                */
/* ------------------------------------------------------------------ */

/**
 * The adjustment an uploaded conversion needs now, or null: RETRACTION when the order is fully
 * refunded or its dispute lost; else RESTATEMENT when its value (paid − refunded, plus the paid
 * one-click offers net of their refunds and lost disputes) differs from what Google has. Pure.
 */
export function googleAdjustmentFor(s: {
  totalCents: number;
  subtotalCents: number;
  refundedCents: number;
  disputeStatus: string | null;
  googleAdsValueCents: number | null;
  offers: { status: string; amountCents: number; refundedCents: number; disputeLostCents: number }[];
}): { type: "RETRACTION" } | { type: "RESTATEMENT"; valueCents: number } | null {
  const paid = s.totalCents || s.subtotalCents;
  const uploaded = s.googleAdsValueCents ?? paid;
  if (s.disputeStatus === "lost" || (paid > 0 && s.refundedCents >= paid)) return { type: "RETRACTION" };
  const offers = s.offers.filter((o) => o.status === "PAID").reduce((n, o) => n + Math.max(0, o.amountCents - o.refundedCents - o.disputeLostCents), 0);
  const value = Math.max(0, paid - s.refundedCents) + offers;
  return value === uploaded ? null : { type: "RESTATEMENT", valueCents: value };
}

/**
 * Tick job: sends the adjustments uploaded conversions need (see googleAdjustmentFor), once each
 * (the value Google has is recorded; a retraction is final), with a backoff on failures, within the
 * tick's deadline. Candidates are the orders flagged by the writers that change a value
 * (googleAdsAdjustDue: refund, dispute outcome, offer paid or refunded), whatever their age within the
 * 60 days; the flag is cleared once adjusted or found unchanged. Test orders are never uploaded, so
 * never adjusted. An account-wide error stops the store's run without spending tries (RunSampler).
 */
export async function adjustGoogleConversions(deadline: number, opts: { storeId?: string } = {}): Promise<number> {
  const stores = await googleStores(opts.storeId);
  let sent = 0;
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const settled = new Date(Date.now() - ADJUST_AFTER_MS);
  for (const store of stores) {
    if (stopForTime(deadline, RESERVE_MS)) break;
    const action = conversionActionName(store.googleAdsConversionAction, store.googleAdsCustomerId);
    if (!action) continue;
    const candidates = await db.checkoutSession.findMany({
      where: {
        storeId: store.id,
        googleAdsAdjustDue: true,
        test: false,
        paidAt: { gte: since },
        googleAdsUploadedAt: { not: null, lte: settled },
        googleAdsRetractedAt: null,
        googleAdsAdjustAttempts: { lt: MAX_ADJUST_ATTEMPTS },
        OR: [{ googleAdsAdjustNextAt: null }, { googleAdsAdjustNextAt: { lte: new Date() } }],
      },
      include: { upsells: { select: { status: true, amountCents: true, refundedCents: true, disputeLostCents: true } } },
      // Fewest tries first: adjustments that keep failing never hold the queue ahead of fresh ones.
      orderBy: [{ googleAdsAdjustAttempts: "asc" }, { paidAt: "asc" }],
      take: BATCH * 4,
    });
    const todo: { s: (typeof candidates)[number]; adj: NonNullable<ReturnType<typeof googleAdjustmentFor>> }[] = [];
    for (const s of candidates) {
      const adj = googleAdjustmentFor({ ...s, offers: s.upsells });
      // Value unchanged (e.g. a dispute won): nothing to send; cleared unless it changed meanwhile.
      if (!adj) await db.checkoutSession.updateMany({ where: { id: s.id, updatedAt: s.updatedAt }, data: { googleAdsAdjustDue: false } });
      else if (todo.length < BATCH) todo.push({ s, adj });
    }
    if (!todo.length) continue;
    const creds = credentialsOf(store);
    let token: string | null;
    try {
      token = await tokenFor(store, creds);
    } catch (err) {
      if (err instanceof DeadlineError) {
        notePartial();
        break;
      }
      throw err;
    }
    if (!token) continue;
    const byId = new Map(todo.map((t) => [t.s.id, t]));
    const spend = async (f: { id: string; message: string }) => {
      const t = byId.get(f.id)!;
      const attempts = t.s.googleAdsAdjustAttempts + 1;
      const delayH = ADJUST_BACKOFF_H[attempts - 1];
      await db.checkoutSession.update({
        where: { id: f.id },
        data: { googleAdsAdjustAttempts: attempts, googleAdsAdjustError: f.message, googleAdsAdjustNextAt: delayH != null ? new Date(Date.now() + delayH * 3600_000) : null },
      });
      if (delayH == null)
        await recordEvent({ storeId: store.id, sessionId: f.id, level: "warn", kind: "google.adjustment_failed", message: `Ajustement de la conversion Google Ads (${t.adj.type === "RETRACTION" ? "retrait" : "nouvelle valeur"}) non envoyé après ${attempts} essais : ${f.message}` });
      else await retrying(store.id, f.id, "adjustment", attempts, MAX_ADJUST_ATTEMPTS, f.message);
    };
    const sampler = new RunSampler(spend);
    let stopped = false;
    let progressed = false;
    for (const { s, adj } of todo) {
      if (stopForTime(deadline, RESERVE_MS)) break;
      try {
        await uploadConversionAdjustment(creds, token, {
          conversionAction: action,
          orderId: s.id,
          type: adj.type,
          adjustmentDateTime: googleDateTime(new Date()),
          ...(adj.type === "RESTATEMENT" ? { restatementValue: { adjustedValue: adj.valueCents / 100, currencyCode: s.currency } } : {}),
        });
        const data = {
          ...(adj.type === "RETRACTION" ? { googleAdsRetractedAt: new Date(), googleAdsValueCents: 0 } : { googleAdsValueCents: adj.valueCents }),
          googleAdsAdjustAttempts: 0,
          googleAdsAdjustError: null,
          googleAdsAdjustNextAt: null,
        };
        // The flag is cleared only if nothing changed the order since it was read (else re-checked next time).
        const cleared = await db.checkoutSession.updateMany({ where: { id: s.id, updatedAt: s.updatedAt }, data: { ...data, googleAdsAdjustDue: false } });
        if (!cleared.count) await db.checkoutSession.update({ where: { id: s.id }, data });
        sent++;
        progressed = true;
        await sampler.succeeded();
      } catch (err) {
        if (err instanceof DeadlineError) {
          notePartial();
          break;
        }
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        const stop = await sampler.failed(s.id, err, message);
        if (stop) {
          await db.checkoutSession.updateMany({ where: { id: { in: stop.ids } }, data: { googleAdsAdjustError: stop.message } });
          if (await sameHeadStopped(store.id, "adjustments", stop.ids, stop.scope)) {
            for (const id of stop.ids) await spend({ id, message: stop.message });
            await recordEvent({
              storeId: store.id,
              level: "warn",
              kind: "google.head_of_line",
              message: `Ajustements Google Ads : les mêmes ${stop.ids.length} commande(s) bloquent l'envoi depuis ${HEAD_STOP_LIMIT} passages (${stop.message}) : un essai leur est compté et les autres commandes passent devant.`,
              data: { ids: stop.ids, what: "adjustments" },
            });
          } else await accountError(store.id, "adjustments", stop);
          stopped = true;
          break;
        }
        progressed = true;
      }
    }
    if (!stopped) {
      await sampler.finish();
      if (progressed) await clearHeadStops(store.id, "adjustments");
    }
  }
  return sent;
}

/**
 * Orders of the last 60 days never uploaded get their tries back (they failed against an old action,
 * during an account problem since fixed, or were waiting for one). Orders closed without a try (no
 * click id, no consent) are re-checked and closed again.
 */
export async function resetGoogleUploads(storeId: string): Promise<number> {
  const r = await db.checkoutSession.updateMany({
    where: { storeId, status: "PAID", googleAdsUploadedAt: null, paidAt: { gte: new Date(Date.now() - LOOKBACK_DAYS * 86_400_000) }, googleAdsUploadAttempts: { gt: 0 } },
    data: { googleAdsUploadAttempts: 0, googleAdsUploadError: null },
  });
  return r.count;
}

/** Adjustments that failed (given up or backing off), last 60 days: tries given back, due at the next run. */
export async function resetGoogleAdjustments(storeId: string): Promise<number> {
  const r = await db.checkoutSession.updateMany({
    where: { storeId, googleAdsUploadedAt: { not: null }, googleAdsRetractedAt: null, paidAt: { gte: new Date(Date.now() - LOOKBACK_DAYS * 86_400_000) }, googleAdsAdjustAttempts: { gt: 0 } },
    data: { ...GOOGLE_ADJUST_DUE, googleAdsAdjustError: null },
  });
  return r.count;
}

/** Saves the store's conversion action; when it changes to another one, never-uploaded recent orders and failed adjustments get their tries back. */
export async function changeConversionAction(storeId: string, conversionAction: string | null): Promise<{ changed: boolean; reset: number }> {
  const before = await db.store.findUnique({ where: { id: storeId }, select: { googleAdsConversionAction: true } });
  await db.store.update({ where: { id: storeId }, data: { googleAdsConversionAction: conversionAction } });
  const changed = (before?.googleAdsConversionAction ?? null) !== conversionAction;
  if (!changed || !conversionAction) return { changed, reset: 0 };
  await resetGoogleAdjustments(storeId);
  return { changed, reset: await resetGoogleUploads(storeId) };
}

/** "Relancer les conversions abandonnées": uploads and adjustments given up (or failing) tried again. */
export async function retryAbandonedGoogleConversions(storeId: string): Promise<{ uploads: number; adjustments: number }> {
  const [uploads, adjustments] = await Promise.all([
    db.checkoutSession.updateMany({
      where: {
        storeId,
        status: "PAID",
        test: false,
        googleAdsUploadedAt: null,
        paidAt: { gte: new Date(Date.now() - LOOKBACK_DAYS * 86_400_000) },
        googleAdsUploadAttempts: { gt: 0 },
        OR: [{ googleAdsUploadError: null }, { googleAdsUploadError: { notIn: UPLOAD_NOT_APPLICABLE } }],
      },
      data: { googleAdsUploadAttempts: 0, googleAdsUploadError: null },
    }),
    resetGoogleAdjustments(storeId),
  ]);
  // A fixed account: the next run isn't held back by the incident's throttle window, and the
  // head-of-line streaks start over.
  await db.rateLimit.deleteMany({ where: { key: `incident:${storeId}:google.conversions_account_error` } });
  await db.appSetting.deleteMany({ where: { key: { in: [`google-stop:${storeId}:uploads`, `google-stop:${storeId}:adjustments`] } } });
  return { uploads: uploads.count, adjustments };
}

export type GoogleBacklog = {
  /** Waiting for their upload (not given up), paid more than UPLOAD_OVERDUE_MS ago: not being drained. */
  uploadsOverdue: number;
  /** Uploads given up (tries spent), last 60 days: "Relancer les conversions abandonnées". */
  uploadsAbandoned: number;
  /** Adjustments given up (value change never reported to Google). */
  adjustmentsAbandoned: number;
};

/** Google offline conversions needing attention, for a store or all the stores with conversions on. */
export async function googleBacklog(storeId?: string): Promise<GoogleBacklog> {
  const stores = await db.store.findMany({ where: { ...(storeId ? { id: storeId } : {}), googleAdsConversionAction: { not: null } }, select: { id: true } });
  if (!stores.length) return { uploadsOverdue: 0, uploadsAbandoned: 0, adjustmentsAbandoned: 0 };
  const ids = stores.map((st) => st.id);
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000);
  const [rows, adjustmentsAbandoned] = await Promise.all([
    db.$queryRaw<{ overdue: bigint; abandoned: bigint }[]>`
      SELECT count(*) FILTER (WHERE s."googleAdsUploadAttempts" < ${MAX_ATTEMPTS} AND s."paidAt" < ${new Date(Date.now() - UPLOAD_OVERDUE_MS)}) AS overdue,
             count(*) FILTER (WHERE s."googleAdsUploadAttempts" >= ${MAX_ATTEMPTS} AND (s."googleAdsUploadError" IS NULL OR s."googleAdsUploadError" NOT IN (${Prisma.join(UPLOAD_NOT_APPLICABLE)}))) AS abandoned
      FROM "CheckoutSession" s
      WHERE s."storeId" IN (${Prisma.join(ids)}) AND s.status = 'PAID' AND s."test" = false AND s."paidAt" >= ${since} AND s."googleAdsUploadedAt" IS NULL
        AND (s.utm ?| array['gclid','gbraid','wbraid'] OR s."firstUtm" ?| array['gclid','gbraid','wbraid'])`,
    db.checkoutSession.count({
      where: { storeId: { in: ids }, googleAdsAdjustDue: true, googleAdsRetractedAt: null, googleAdsUploadedAt: { not: null }, paidAt: { gte: since }, googleAdsAdjustAttempts: { gte: MAX_ADJUST_ATTEMPTS } },
    }),
  ]);
  return { uploadsOverdue: Number(rows[0]?.overdue ?? 0), uploadsAbandoned: Number(rows[0]?.abandoned ?? 0), adjustmentsAbandoned };
}

export type GoogleConversionsHealth = { configured: boolean; pending: number; failed24h: number; lastSuccessAt: Date | null; incidents24h: number } & GoogleBacklog;

/** Google offline conversions at a glance (health tile): waiting, failed in 24 h, last upload. */
export async function googleConversionsHealth(store: { id: string; googleAdsConversionAction: string | null; googleAdsCustomerId: string | null }): Promise<GoogleConversionsHealth> {
  const configured = !!conversionActionName(store.googleAdsConversionAction, store.googleAdsCustomerId);
  if (!configured) return { configured, pending: 0, failed24h: 0, lastSuccessAt: null, incidents24h: 0, uploadsOverdue: 0, uploadsAbandoned: 0, adjustmentsAbandoned: 0 };
  const day = new Date(Date.now() - 86_400_000);
  const [pending, failed, last, incidents, queue] = await Promise.all([
    db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "CheckoutSession" s
      WHERE s."storeId" = ${store.id} AND s.status = 'PAID' AND s."test" = false AND s."paidAt" >= ${new Date(Date.now() - LOOKBACK_DAYS * 86_400_000)}
        AND s."googleAdsUploadedAt" IS NULL AND s."googleAdsUploadAttempts" < ${MAX_ATTEMPTS}
        AND (s.utm ?| array['gclid','gbraid','wbraid'] OR s."firstUtm" ?| array['gclid','gbraid','wbraid'])`,
    // Given up, and tries failing now (throttled journal rows: at least one failure in the hour).
    db.eventLog.count({ where: { storeId: store.id, kind: { in: ["google.conversion_failed", "google.adjustment_failed", "google.conversion_retrying"] }, createdAt: { gt: day } } }),
    db.checkoutSession.findFirst({ where: { storeId: store.id, googleAdsUploadedAt: { not: null } }, orderBy: { googleAdsUploadedAt: "desc" }, select: { googleAdsUploadedAt: true } }),
    db.eventLog.count({ where: { storeId: store.id, kind: { in: ["google.conversions_auth_failed", "google.conversions_account_error"] }, createdAt: { gt: day } } }),
    googleBacklog(store.id),
  ]);
  return { configured, pending: Number(pending[0]?.n ?? 0), failed24h: failed, lastSuccessAt: last?.googleAdsUploadedAt ?? null, incidents24h: incidents, ...queue };
}
