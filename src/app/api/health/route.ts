import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { backlog, OVERDUE_GRACE_MS } from "@/lib/health";
import { route } from "@/lib/route";
import { starvedJobs, TICK_JOBS, TICK_STALE_MS, tickStatus } from "@/lib/tick";
import { incidentCounts } from "@/lib/incidents";
import { fxHealth } from "@/lib/charge";
import { canReadShopifyDiscounts } from "@/lib/shopify-discounts";
import { googleBacklog, UPLOAD_OVERDUE_MS } from "@/lib/google-conversions";
import { stuckImports } from "@/lib/shopify-history";
import { providersHealth, sustainedFailures } from "@/lib/providers";
import { scrub } from "@/lib/metrics";
import { safeEqual } from "@/lib/crypto";
import { PROVIDER_STORE_SELECT, storeLive } from "@/lib/payment-provider";

export const dynamic = "force-dynamic";

type Body = Record<string, unknown> & { ok: boolean };
/** The probe is public: its table scans run at most every 10 s per instance. */
let cached: { at: number; body: Body; details: Record<string, unknown> } | null = null;
const CACHE_MS = 10_000;

/**
 * Uptime probe for an external monitor (UptimeRobot, Better Stack…). Exposes no business data.
 * - 503, status "down": database unreachable, background tick stale while a store is live,
 *   a store on the fallback checkout, a burst of bad webhook signatures, a tick job
 *   erroring, or a money-path backlog the automation isn't draining (`down` lists why).
 * - 200, status "degraded": everything runs, but items the automation gave up on (already
 *   alerted) wait for a human (`needsAction` lists them), or items wait for their next scheduled
 *   retry (normal backoff, `retrying` lists them). A retried item only counts as "down" once
 *   overdue for its own retry time (nextSyncAt / nextRefundMirrorAt) by more than the grace.
 * - 200, status "degraded" too: checkout features running degraded (`degraded`: Shopify code
 *   lookups / cart re-reads / sign-in e-mails failing, ECB rates stale while a store charges in
 *   local currency, Shopify codes on without the read_discounts scope, Google Ads conversions
 *   failing or pending too long). Google Ads uploads / adjustments given up, a Google Ads account
 *   or connection error and failed / uncertain replacement orders are in `needsAction`.
 * - 200, status "degraded" too: an external provider failing over the last hour (`providers`: calls,
 *   error rate, p95 latency, last success per provider; degraded when > 20 % errors over ≥ 10 calls or
 *   p95 > 8 s; `failingSustained`: > 20 % errors for 15 min, evaluated here as well as by the tick), or a
 *   background job skipped for lack of time for more than 6 h. A money job skipped for more than 1 h is "down".
 * - Public output carries job names and codes only, never raw error text or store names; a caller
 *   sending `Authorization: Bearer $CRON_SECRET` also gets `details` (the failing jobs' errors, scrubbed).
 * - 200, status "ok": nothing to do.
 */
async function handle(req: Request) {
  if (cached && Date.now() - cached.at < CACHE_MS) return respond(req, { ...cached.body, cached: true }, cached.details);
  const started = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    return json({ ok: false, status: "down", db: false, reasons: ["database unreachable"], down: ["database unreachable"], needsAction: [] }, { status: 503 });
  }
  const tick = await tickStatus();
  const tickAgeMin = tick.at ? Math.round((Date.now() - new Date(tick.at).getTime()) / 60_000) : null;
  // Still being retried (gave-up and hand-linked orders are reported apart): overdue for the
  // scheduled retry (the automation isn't draining it) vs. waiting for it (normal backoff).
  const grace = new Date(Date.now() - OVERDUE_GRACE_MS);
  const retryingSessions = { status: "PAID" as const, shopifyOrderId: null, reviewNote: null, syncHandledAt: null, paidAt: { lt: new Date(Date.now() - 30 * 60_000) } };
  const [unsyncedOld, syncBackingOff] = await Promise.all([
    db.checkoutSession.count({ where: { ...retryingSessions, OR: [{ syncAttempts: 0 }, { nextSyncAt: { lt: grace } }] } }),
    db.checkoutSession.count({ where: { ...retryingSessions, syncAttempts: { gt: 0 }, nextSyncAt: { gte: grace } } }),
  ]);
  // Background maintenance is what recovers missed webhooks, failed syncs and refunds: a
  // live store (enabled, Whop and Shopify connected) without a recent tick is unprotected,
  // whatever the configuration (no scheduler, CRON_SECRET missing or wrong).
  // Live = a processor able to charge (Whop, or Stripe alone): candidates in SQL, the rule in JS.
  const liveStores = (
    await db.store.findMany({
      where: { enabled: true, shopifyConnectedAt: { not: null }, OR: [{ whopConnectedAt: { not: null } }, { stripeAccountId: { not: null } }] },
      select: { enabled: true, shopifyConnectedAt: true, ...PROVIDER_STORE_SELECT },
    })
  ).filter((s) => storeLive(s)).length;
  const tickFresh = tick.at != null && Date.now() - new Date(tick.at).getTime() <= TICK_STALE_MS;
  const tickOk = liveStores === 0 || tickFresh;
  const tickReason = tickOk
    ? null
    : tick.at
      ? `background tick last ran ${tickAgeMin} min ago (> ${TICK_STALE_MS / 60_000} min) while ${liveStores} store(s) are live: check the scheduler (GitHub Actions tick.yml / cron) and CRON_SECRET`
      : `background tick never ran while ${liveStores} store(s) are live: set CRON_SECRET and a scheduler calling /api/cron/tick every 5-10 min`;
  const entries = tick.report ? Object.entries(tick.report) : [];
  // Public output: job names only. The error text (it may name a store, an order, a provider's
  // answer) is only shown, scrubbed, to a caller holding CRON_SECRET (`details`).
  const tickErrorEntries = entries.filter(([, v]) => typeof v === "string" && v.startsWith("error"));
  const tickErrors = tickErrorEntries.map(([k]) => k);
  const tickSkipped = entries.filter(([, v]) => typeof v === "string" && v.startsWith("skipped")).map(([k]) => k);
  const queue = await backlog();
  // Stores silently running on Shopify's checkout because Whop is failing.
  const fallbackActive = await db.store.count({ where: { fallbackActiveAt: { not: null } } });
  // "down" (503): the app can't protect payments right now — tick stale, fallback on,
  // webhooks rejected, a job erroring, or a backlog the automation isn't draining.
  const down = [
    tickReason,
    tickErrors.length ? `tick job errors: ${tickErrors.join(", ")}` : null,
    fallbackActive ? `${fallbackActive} store(s) on the fallback checkout` : null,
    // One stray unsigned request isn't an outage; a rotated secret fails every delivery.
    queue.badSignatures1h >= 3 ? `${queue.badSignatures1h} webhook(s) with a bad signature in the last hour` : null,
    unsyncedOld ? `${unsyncedOld} paid order(s) missing in Shopify for > 30 min, overdue for their retry` : null,
    queue.offersUnsynced ? `${queue.offersUnsynced} paid offer(s) missing in Shopify, overdue for their retry` : null,
    queue.offersStuck ? `${queue.offersStuck} offer charge(s) without an answer from Whop` : null,
    queue.refundsUnmirrored ? `${queue.refundsUnmirrored} refund(s) not yet reported in Shopify, overdue for their retry` : null,
    queue.webhooksUnprocessed ? `${queue.webhooksUnprocessed} Whop event(s) unprocessed` : null,
    queue.alertsUndelivered ? `${queue.alertsUndelivered} alert(s) undelivered` : null,
    queue.healingStale.length ? "refund/dispute reconciliation stale" : null,
    queue.reconcileStale.length ? "payment reconciliation stale" : null,
  ].filter((r): r is string => !!r);
  const [incidents, fx, codeStores, google] = await Promise.all([
    incidentCounts(),
    fxHealth(),
    db.store.findMany({ where: { shopifyDiscountCodes: true, shopifyConnectedAt: { not: null }, enabled: true }, select: { shopifyScopes: true } }),
    googleBacklog(),
  ]);
  // Google Ads account / connection errors wait for the merchant (reconnect, fix the account): needsAction.
  const accountKinds = ["google.conversions_account_error", "google.conversions_auth_failed"];
  // "needs action" (200, status "degraded"): the automation gave up on these items and
  // already alerted; they wait for a human (Journal → "Relancer" / "Traité").
  const needsAction = [
    queue.webhooksGaveUp ? `${queue.webhooksGaveUp} Whop event(s) given up` : null,
    queue.alertsGaveUp ? `${queue.alertsGaveUp} alert(s) given up` : null,
    queue.refundsGaveUp ? `${queue.refundsGaveUp} refund mirror(s) given up` : null,
    queue.syncGaveUp ? `${queue.syncGaveUp} order sync(s) given up` : null,
    queue.offersGaveUp ? `${queue.offersGaveUp} offer sync(s) given up` : null,
    queue.disputeTagsGaveUp ? `${queue.disputeTagsGaveUp} disputed order(s) not tagged in Shopify (given up)` : null,
    queue.trackingGaveUp ? `${queue.trackingGaveUp} tracking number(s) never pushed to Whop (given up)` : null,
    queue.trackingFailing ? `${queue.trackingFailing} tracking push(es) failing repeatedly` : null,
    queue.disputesNeedAction ? `${queue.disputesNeedAction} dispute(s) to answer in Whop` : null,
    queue.reviewHolds ? `${queue.reviewHolds} payment(s) held for review` : null,
    queue.offersUnpaidBalance ? `${queue.offersUnpaidBalance} merged offer(s) whose Whop payment isn't recorded on the Shopify order (unpaid balance)` : null,
    queue.replacementsFailed ? `${queue.replacementsFailed} replacement order(s) (shipping protection claims) failed or with an uncertain outcome: retry from the order page` : null,
    google.uploadsAbandoned ? `${google.uploadsAbandoned} Google Ads offline conversion(s) given up (Pub & pixels → "Relancer les conversions abandonnées")` : null,
    google.adjustmentsAbandoned ? `${google.adjustmentsAbandoned} Google Ads conversion adjustment(s) given up (refund / dispute / offer not reported to Google)` : null,
    incidents["google.conversions_account_error"] ? `Google Ads account error: offline conversions suspended (${incidents["google.conversions_account_error"]} in 24 h)` : null,
    incidents["google.conversions_auth_failed"] ? `Google Ads connection refused: offline conversions not sent (${incidents["google.conversions_auth_failed"]} in 24 h)` : null,
  ].filter((r): r is string => !!r);
  // Normal backoff (200, status "degraded"): failed once, next retry scheduled and not overdue.
  const retrying = [
    syncBackingOff ? `${syncBackingOff} paid order(s) waiting for their next Shopify retry` : null,
    queue.offersBackingOff ? `${queue.offersBackingOff} paid offer(s) waiting for their next Shopify retry` : null,
    queue.refundsBackingOff ? `${queue.refundsBackingOff} refund mirror(s) waiting for their next retry` : null,
  ].filter((r): r is string => !!r);
  // Checkout features running degraded (200, status "degraded"): Shopify code lookups, cart
  // re-reads, sign-in e-mails failing, buyers charged in the shop currency (ECB rates stale).
  const scopeMissing = codeStores.filter((st) => !canReadShopifyDiscounts(st)).length;
  // Background imports (buyers' history, outside orders, ad spend history) failing for more than 48 h.
  const importStores = await db.store.findMany({ where: { shopifyConnectedAt: { not: null } }, select: { id: true } });
  const stuck = (await Promise.all(importStores.map((st) => stuckImports(st.id)))).flat();
  // Evaluated here too (not only by the tick's watchProviders job): a provider failing for 15 min shows
  // even when the tick itself is late or starved.
  const [providers, starved, failing] = await Promise.all([providersHealth().catch(() => []), starvedJobs().catch(() => []), sustainedFailures().catch(() => [])]);
  const moneyJobs = new Set(TICK_JOBS.filter((j) => j.money).map((j) => j.name));
  const starvedMoney = starved.filter((s) => moneyJobs.has(s.name));
  const starvedOthers = starved.filter((s) => !moneyJobs.has(s.name));
  const degraded = [
    fx.optionStores && !fx.fresh ? `ECB rates ${fx.date ? `from ${fx.date}` : "missing"} (> 3 days) while ${fx.optionStores} store(s) charge in local currency: buyers charged in the shop currency` : null,
    scopeMissing ? `${scopeMissing} store(s) accept Shopify discount codes without the read_discounts scope` : null,
    stuck.length ? `${stuck.length} background import(s) failing for > 48 h (${[...new Set(stuck.map((x) => x.what))].join(", ")})` : null,
    google.uploadsOverdue ? `${google.uploadsOverdue} Google Ads offline conversion(s) paid > ${UPLOAD_OVERDUE_MS / 3600_000} h ago still not uploaded` : null,
    ...(Object.entries(incidents) as [string, number][]).filter(([kind, n]) => n > 0 && !accountKinds.includes(kind) && !(kind === "import.background_failed" && stuck.length)).map(([kind, n]) => `${kind}: ${n} in 24 h`),
    ...providers.filter((p) => p.degraded).map((p) => `provider ${p.provider} degraded over the last hour (${p.errors}/${p.calls} errors, p95 ${p.p95Ms ?? "?"} ms)`),
    ...failing.map((f) => `provider ${f.provider} failing for 15 min (${f.errors}/${f.calls} errors)`),
    starvedOthers.length ? `background job(s) skipped for lack of time for > 6 h: ${starvedOthers.map((s) => s.name).join(", ")}` : null,
  ].filter((r): r is string => !!r);
  // A money job (payments, orders, refunds, disputes) skipped for lack of time for > 1 h: not protected.
  if (starvedMoney.length) down.push(`money job(s) skipped for lack of time for > 1 h: ${starvedMoney.map((s) => s.name).join(", ")}`);
  const ok = down.length === 0;
  const status = !ok ? "down" : needsAction.length || retrying.length || degraded.length ? "degraded" : "ok";
  const body: Body = {
    ok,
    status,
    db: true,
    reasons: [...down, ...needsAction, ...retrying, ...degraded],
    down,
    needsAction,
    retrying,
    degraded,
    fxRatesDate: fx.date,
    incidents24h: incidents,
    liveStores,
    tickAgeMin,
    tickErrors,
    tickSkipped,
    unsyncedOver30min: unsyncedOld,
    syncBackingOff,
    offersBackingOff: queue.offersBackingOff,
    refundsBackingOff: queue.refundsBackingOff,
    offersUnpaidBalance: queue.offersUnpaidBalance,
    reviewHolds: queue.reviewHolds,
    replacementsFailed: queue.replacementsFailed,
    googleUploadsOverdue: google.uploadsOverdue,
    googleUploadsAbandoned: google.uploadsAbandoned,
    googleAdjustmentsAbandoned: google.adjustmentsAbandoned,
    offersUnsynced: queue.offersUnsynced,
    offersStuck: queue.offersStuck,
    refundsUnmirrored: queue.refundsUnmirrored,
    webhooksUnprocessed: queue.webhooksUnprocessed,
    // Needs a human (gave up) vs. still retrying on its own (webhooksUnprocessed).
    webhooksGaveUp: queue.webhooksGaveUp,
    webhookBadSignatures1h: queue.badSignatures1h,
    fallbackActive,
    alertsUndelivered: queue.alertsUndelivered,
    // Need a human (retry or mark handled from the Journal page).
    alertsGaveUp: queue.alertsGaveUp,
    refundsGaveUp: queue.refundsGaveUp,
    syncGaveUp: queue.syncGaveUp,
    offersGaveUp: queue.offersGaveUp,
    disputeTagsGaveUp: queue.disputeTagsGaveUp,
    trackingGaveUp: queue.trackingGaveUp,
    trackingFailing: queue.trackingFailing,
    healingStale: queue.healingStale.length,
    disputesNeedAction: queue.disputesNeedAction,
    reconcileStale: queue.reconcileStale.length,
    reconcileCatchingUp: queue.reconcilePartial.length,
    // External providers over the last hour (no business data: counts, rates, latencies, times).
    providers: Object.fromEntries(
      providers.map((p) => [
        p.provider,
        {
          calls: p.calls,
          errors: p.errors,
          timeouts: p.timeouts,
          errorRate: p.errorRate == null ? null : Math.round(p.errorRate * 1000) / 1000,
          p95Ms: p.p95Ms,
          lastOkAt: p.lastOkAt?.toISOString() ?? null,
          degraded: !!p.degraded,
          failingSustained: failing.some((f) => f.provider === p.provider),
        },
      ]),
    ),
    starvedJobs: starved.map((s) => s.name),
    starvedMoneyJobs: starvedMoney.map((s) => s.name),
    ms: Date.now() - started,
  };
  // Operator-only details (scrubbed): the failing jobs' error text.
  const details = { tickErrors: Object.fromEntries(tickErrorEntries.map(([k, v]) => [k, scrub(String(v).slice(7))])) };
  cached = { at: Date.now(), body, details };
  return respond(req, body, details);
}

/** The public body; with `Authorization: Bearer $CRON_SECRET`, plus the scrubbed details. */
function respond(req: Request, body: Body, details: Record<string, unknown>) {
  const secret = process.env.CRON_SECRET;
  const authorized = !!secret && safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
  return json(authorized ? { ...body, details } : body, { status: body.ok ? 200 : 503 });
}

export const GET = route("health", handle);
