import "server-only";
import { type Breakers, DeadlineError, isTimeoutError, notePartial, stopForTime } from "./deadline";
import type { Store } from "@prisma/client";
import { db } from "./db";
import { markPaid, syncOrder, syncOrderSafely } from "./checkout";
import { retryRefundMirrors } from "./refunds";
import { probeFallbacks } from "./fallback";
import { backfillAdSpend, importAdSpend } from "./adspend";
import { shopifyHistoryUpkeep } from "./shopify-history";
import { adjustGoogleConversions, GOOGLE_ADJUST_DUE, markGoogleAdjustDue, uploadGoogleConversions } from "./google-conversions";
import { pushTracking, recordTrackingFailure, retryAlertRefunds, submitDueDisputeEvidence, tagDisputedOrders } from "./disputes";
import { autoPromoteExperiments, notifyAnomalies, notifyStopLoss, sendDailyReport, sendLateLeakageAlerts } from "./analytics";
import { markUpsellPaid, retryOfferBalances, retryUpsellSyncs, sweepPendingUpsells } from "./upsell";
import { handleEvent, replayStaleEvents, RetryLater } from "./webhooks";
import { eventPaymentId, eventPaymentMetadata, paymentOwner, refundAmountIn, resolvePayment } from "./payments";
import { retryConversions } from "./conversions";
import { fxUpkeep } from "./charge";
import { fillRecentCosts } from "./costs";
import { autoPromoteOffers } from "./offer-tests";
import { deliverPendingAlerts, log, logContext, recordEvent, withLogContext } from "./log";
import { collectDeferred, defer } from "./deferred";
import { flushProviderMetrics, purgeProviderMetrics } from "./metrics";
import { watchProviders } from "./providers";
import { captureException, flushCaptures } from "./sentry";
import { recordIncident } from "./incidents";
import { paymentInfoFromWhop, storeClient, whopCallOptions } from "./whop";
import { fairByStore, rotateJobs, rotateStores, roundRobinByStore } from "./rotation";
import { recheckCheckoutDomains } from "./checkout-domain-check";

export { rotateJobs, rotateStores, roundRobinByStore };

/*
 * Background maintenance, run by Vercel Cron / an external scheduler, and
 * opportunistically by dashboard visits (at most every few minutes). Every job is
 * idempotent and bounded by a shared time budget, so a slow Shopify or Whop can
 * never make the run exceed the function limit, and overlapping runs are harmless.
 *
 *  1. retries    — re-run failed Shopify syncs whose backoff has elapsed
 *  2. reconcile  — pull new paid Whop payments (per-store high-water mark) and
 *                  heal any missed webhook
 *  3. tracking   — push Shopify tracking numbers to Whop (dispute shield)
 *  4. cleanup    — expired rate-limit rows, old journal entries and webhook copies
 */

const TICK_KEY = "tick:last";
/** A live store whose last tick is older than this is unprotected (health answers 503). */
export const TICK_STALE_MS = 30 * 60_000;
const MIN_INTERVAL_MS = 4 * 60 * 1000;
/**
 * Whole tick must fit in the 60 s function limit: no new item starts after the
 * budget, and one external call is bounded (Shopify 2 x 12 s, Whop 2 x 12 s).
 */
export const TICK_BUDGET_MS = 30_000;
const LOCK_KEY = "tick:lock";
/** No external call starts after this (maxDuration 60 s, margin for the report). */
const HARD_LIMIT_MS = 50_000;
/** A lock older than this belongs to a run that died (function limit is 60 s). */
const LOCK_STALE_MS = 90_000;

let lastLocalCheck = 0;

/** Runs the tick if the last one is older than a few minutes (cheap, then atomic claim). */
export async function maybeTick(): Promise<boolean> {
  // Per-instance throttle: busy instances don't touch the shared row on every request.
  if (Date.now() - lastLocalCheck < 60_000) return false;
  lastLocalCheck = Date.now();
  const cutoff = new Date(Date.now() - MIN_INTERVAL_MS).toISOString();
  const last = await db.appSetting.findUnique({ where: { key: TICK_KEY }, select: { value: true } });
  if (last && last.value >= cutoff) return false;
  const now = new Date().toISOString();
  const claimed = await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${TICK_KEY}, ${now}, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
    WHERE "AppSetting"."value" < ${cutoff}`;
  if (claimed === 0) return false;
  await runTick();
  return true;
}

export type TickReport = Record<string, number | string>;
type Job = (deadline: number) => Promise<number>;

/** One tick at a time (cron, scheduler and dashboard visits can overlap). */
async function acquireLock(runId: string): Promise<boolean> {
  const stale = new Date(Date.now() - LOCK_STALE_MS).toISOString();
  const claimed = await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${LOCK_KEY}, ${`${new Date().toISOString()}|${runId}`}, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
    WHERE "AppSetting"."value" = '' OR "AppSetting"."value" < ${stale}`;
  return claimed > 0;
}

async function releaseLock(runId: string) {
  await db.appSetting.updateMany({ where: { key: LOCK_KEY, value: { endsWith: `|${runId}` } }, data: { value: "" } }).catch(() => undefined);
}

export async function runTick(budgetMs = TICK_BUDGET_MS, opts: RunOpts = {}): Promise<TickReport> {
  const started = Date.now();
  const runId = `tick_${started.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  if (!(await acquireLock(runId))) {
    log.info("tick.busy", "Another maintenance run is in progress");
    return { skipped: "another run in progress" };
  }
  try {
    return await runJobs(runId, started, budgetMs, opts);
  } finally {
    await releaseLock(runId);
  }
}

/**
 * Time slice of each job that isn't on the money path (conversions, analytics, imports, reports): no new
 * item starts after it, so a backlog there (a slow ad platform, thousands of rows to import) can never
 * starve the jobs after it. The item already started may finish (bounded by the run's hard deadline).
 */
export const NON_MONEY_JOB_MS = 5_000;

/**
 * Time slice of each money job: no new item (store, order, refund…) starts after it, and — unlike the
 * other jobs — its external calls are bounded too (`jobDeadline` in the log context, honoured by the
 * Shopify, Whop and ad-platform clients): at most MONEY_JOB_OVERRUN_MS past the slice. One slow
 * provider can then only spend its own job's slice, never the time of the money jobs after it.
 */
export const MONEY_JOB_MS = 8_000;
export const MONEY_JOB_OVERRUN_MS = 4_000;

/**
 * Cap of the whole Whop-side phase (every `whopSide` job together): no Whop-side job starts, and none of
 * their calls runs, past this much time after the first one started. With the per-run Whop breaker (the
 * first Whop call that hangs suspends the others), a slow or hanging Whop can never starve the Shopify-side
 * money jobs (order creation, refund mirrors) that come after it.
 */
export const WHOP_PHASE_MS = 15_000;

/** Report value of a job cut short by its time budget (counted with the skipped jobs by health). */
export const PARTIAL_PREFIX = "skipped: partial";

type JobSpec = {
  name: string;
  job: Job;
  money: boolean;
  /**
   * Whop-side money job (reconciliation, sweeps, fraud-alert refunds): run before the Shopify-side ones,
   * with its Shopify follow-ups (order creation, refund mirror, dispute tag…) collected instead of run
   * inline, then run by the `followUps` job (each is also backstopped by its own retry job below).
   */
  whopSide?: boolean;
  /**
   * Reserved slice: the job still runs, for this long, once the run's budget is used (never past the
   * run's hard deadline, with a margin for the report). For work with a hard external due date.
   */
  reservedMs?: number;
};

/**
 * The run's jobs, in order. Money first: payments, orders, refunds and disputes never wait behind
 * conversions or analytics. Within money, the Whop-side jobs run first (a slow Shopify can never keep
 * a missed payment, an offer charge or a refund from being noticed), then the Shopify-side retries.
 * Each money job gets MONEY_JOB_MS, each `money: false` job NON_MONEY_JOB_MS at most; the non-money
 * jobs start from a rotating offset (none is always last), and one skipped for more than 6 h is
 * journaled and shown in health.
 */
export const TICK_JOBS: JobSpec[] = [
  { name: "alertsDelivered", job: deliverPendingAlerts, money: true },
  // External providers' error rates (ProviderMetric): alerted when one stays high for 15 min. Cheap and
  // DB-only: run among the first jobs, so a provider outage is alerted even on runs the outage slows down.
  { name: "providersWatched", job: watchProviders, money: true },
  { name: "fallbackProbed", job: probeFallbacks, money: true, whopSide: true },
  { name: "upsellsSwept", job: sweepPendingUpsells, money: true, whopSide: true },
  { name: "reconciled", job: reconcilePayments, money: true, whopSide: true },
  { name: "refundsReconciled", job: reconcileRefunds, money: true, whopSide: true },
  { name: "disputesReconciled", job: reconcileDisputes, money: true, whopSide: true },
  { name: "alertRefunds", job: retryAlertRefunds, money: true, whopSide: true },
  { name: "webhooksReplayed", job: replayStaleEvents, money: true, whopSide: true },
  // The Shopify follow-ups the Whop-side jobs just collected (orders of healed payments, mirrors…).
  { name: "followUps", job: runFollowUps, money: true },
  // Disputes have a hard due date: tracking, then evidence (a freshly tracked parcel makes its evidence
  // due right away), ahead of the Shopify retry jobs (independent of them: tracking needs an existing
  // order, evidence a dispute). The evidence keeps a reserved slice even once the budget is used.
  { name: "trackingPushed", job: pushTrackingNumbers, money: true },
  { name: "disputeEvidence", job: submitDueDisputeEvidence, money: true, reservedMs: 4_000 },
  // Paid orders missing in Shopify and refunds missing there: a reserved slice too, so a slow run (Whop
  // hanging, a backlog) can't leave them waiting run after run.
  { name: "syncRetried", job: retrySyncs, money: true, reservedMs: 4_000 },
  { name: "upsellRetried", job: retryUpsellSyncs, money: true },
  { name: "offerBalancesPaid", job: retryOfferBalances, money: true },
  { name: "refundsMirrored", job: retryRefundMirrors, money: true, reservedMs: 3_000 },
  { name: "disputesTagged", job: tagDisputedOrders, money: true },
  // Ad conversions (their own backoff clock, pixelNextAttemptAt): after every money job.
  { name: "conversionsRetried", job: retryConversions, money: false },
  // ECB rates off the buyer's path (buyers only read the cache): before the jobs converting spend.
  { name: "fxRefreshed", job: fxUpkeep, money: false },
  { name: "experiments", job: autoPromoteExperiments, money: false },
  { name: "offerTests", job: autoPromoteOffers, money: false },
  { name: "costsApplied", job: fillRecentCosts, money: false },
  { name: "adSpend", job: importAdSpend, money: false },
  // Offline conversions of paid Google Ads clicks (ClickConversion upload, idempotent per order), then
  // their adjustments (retraction or new value): before the history backfills, which can be long.
  { name: "googleConversions", job: uploadGoogleConversions, money: false },
  { name: "googleAdjustments", job: adjustGoogleConversions, money: false },
  // Analytics history: 13 months of ad spend (backwards, one chunk per run), the buyers' Shopify
  // order history (once per connection) and the daily import of orders placed outside this checkout.
  { name: "adSpendBackfill", job: backfillAdSpend, money: false },
  { name: "shopifyHistory", job: shopifyHistoryUpkeep, money: false },
  { name: "anomalies", job: notifyAnomalies, money: false },
  { name: "stopLoss", job: notifyStopLoss, money: false },
  { name: "dailyReport", job: sendDailyReport, money: false },
  // A day's leakage the report had to hold (import not yet past the day): alerted once the import is.
  { name: "leakageAlerts", job: sendLateLeakageAlerts, money: false },
  // Checkout domains (checkout.seyuna.com…): pending ones every 10 min, verified ones hourly (alert when one stops answering); retired ones removed from Vercel after 48 h.
  { name: "checkoutDomains", job: recheckCheckoutDomains, money: false },
  { name: "cleaned", job: cleanup, money: false },
];

const NON_MONEY_OFFSET_KEY = "tick:non-money-offset";

/** Follow-ups collected from the Whop-side jobs of the current run (see runFollowUps). */
type FollowUp = Awaited<ReturnType<typeof collectDeferred>>["later"][number];
const followUpsKey = "tickFollowUps";

/**
 * Runs the Shopify follow-ups collected from this run's Whop-side jobs: alerts first, then orders,
 * refund mirrors, dispute tags, conversions — within the job's slice. What's left is dropped: each has
 * its own backstop job (retrySyncs, retryUpsellSyncs, retryRefundMirrors, tagDisputedOrders…).
 */
async function runFollowUps(deadline: number): Promise<number> {
  const tasks = (logContext()[followUpsKey] as FollowUp[] | undefined) ?? [];
  const ordered = [...tasks.filter((t) => t.name.startsWith("alert.")), ...tasks.filter((t) => !t.name.startsWith("alert."))];
  let n = 0;
  while (ordered.length) {
    if (stopForTime(deadline)) break;
    const t = ordered.shift()!;
    try {
      await t.run();
      n++;
    } catch (err) {
      if (err instanceof DeadlineError) {
        notePartial();
        break;
      }
      log.error("tick.follow_up_failed", `Follow-up ${t.name} failed (its retry job backstops it)`, { name: t.name, err });
    }
  }
  if (ordered.length) log.info("tick.follow_ups_left", "Follow-ups left to their retry jobs", { left: ordered.map((t) => t.name) });
  tasks.length = 0;
  return n;
}

/** Last run (completed or partial) of each job, for the starvation check. */
const JOB_RAN_KEY = "tick:job-ran";
/** A non-money job skipped for lack of time for longer than this is journaled and shown in health. */
export const JOB_STARVED_MS = 6 * 3600_000;
/** A money job (payments, orders, refunds, disputes) skipped for longer than this: journaled, alerted, health "down". */
export const MONEY_JOB_STARVED_MS = 3600_000;
/** Room left before the hard deadline, after a reserved slice, for the report and the lock release. */
const RESERVED_MARGIN_MS = 2_000;

/** Starvation threshold of a job: 1 h for a money job, 6 h for the others. */
export function starvedAfter(name: string): number {
  return TICK_JOBS.find((j) => j.name === name)?.money ? MONEY_JOB_STARVED_MS : JOB_STARVED_MS;
}

type RunOpts = { moneyJobMs?: number; overrunMs?: number; hardLimitMs?: number; whopPhaseMs?: number };

async function runJobs(runId: string, started: number, budgetMs: number, opts: RunOpts = {}): Promise<TickReport> {
  const report: TickReport = {};
  const deadline = started + budgetMs;
  const hardDeadline = started + (opts.hardLimitMs ?? HARD_LIMIT_MS);
  const moneyMs = opts.moneyJobMs ?? MONEY_JOB_MS;
  const overrunMs = opts.overrunMs ?? MONEY_JOB_OVERRUN_MS;
  const whopPhaseMs = opts.whopPhaseMs ?? WHOP_PHASE_MS;
  // Per-run circuit breakers (see tripBreaker): shared by every job of this run.
  const breakers: Breakers = {};
  let whopPhaseEnd: number | null = null;
  const failures: string[] = [];
  const errors: { name: string; err: unknown }[] = [];
  const followUps: FollowUp[] = [];
  const money = TICK_JOBS.filter((j) => j.money);
  const others = TICK_JOBS.filter((j) => !j.money);
  const offset = Number((await db.appSetting.findUnique({ where: { key: NON_MONEY_OFFSET_KEY } }).catch(() => null))?.value) || 0;
  const order = [...money, ...rotateJobs(others, offset)];
  const ran: string[] = [];
  try {
    for (const { name, job, money: isMoney, whopSide, reservedMs } of order) {
      // Past the budget, a job with a reserved slice still runs if the hard deadline leaves room for it.
      const reserved = Date.now() > deadline && !!reservedMs && hardDeadline - Date.now() > reservedMs + overrunMs + RESERVED_MARGIN_MS;
      if (Date.now() > deadline && !reserved) {
        report[name] = "skipped: time budget used";
        continue;
      }
      if (whopSide) {
        whopPhaseEnd ??= Date.now() + whopPhaseMs;
        if (Date.now() >= whopPhaseEnd) {
          report[name] = "skipped: time budget used (Whop phase)";
          continue;
        }
      }
      // Each job gets its own slice of the budget (never past the run's). A money job's calls are
      // bounded to its slice (+ overrun) too; the others' only by the run's hard deadline. A Whop-side
      // job (and its calls) never runs past the Whop phase's cap.
      let jobDeadline = reserved ? Date.now() + reservedMs! : Math.min(deadline, Date.now() + (isMoney ? moneyMs : NON_MONEY_JOB_MS));
      let callDeadline = Math.min(hardDeadline, jobDeadline + overrunMs);
      if (whopSide && whopPhaseEnd != null) {
        jobDeadline = Math.min(jobDeadline, whopPhaseEnd);
        callDeadline = Math.min(callDeadline, whopPhaseEnd);
      }
      const partial: { partial?: boolean } = {};
      const ctx = {
        tickRun: runId,
        job: name,
        // hardDeadline: external clients refuse to start a call that couldn't finish before the
        // function limit, so one slow item can't get the run killed.
        hardDeadline,
        ...(isMoney ? { jobDeadline: callDeadline } : {}),
        tickPartial: partial,
        breakers,
        [followUpsKey]: followUps,
      };
      try {
        const n = await withLogContext(ctx, async () => {
          if (!whopSide) return job(jobDeadline);
          // Whop-side: Shopify work is collected for the follow-ups job instead of run inline.
          const { result, later } = await collectDeferred(() => job(jobDeadline));
          followUps.push(...later);
          return result;
        });
        // Stopped by its time budget with work left: reported (and counted) as skipped, not done.
        report[name] = partial.partial ? `${PARTIAL_PREFIX} (${n} done, rest next run)` : n;
        ran.push(name);
      } catch (err) {
        if (err instanceof DeadlineError) {
          report[name] = "skipped: time budget used";
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        report[name] = `error: ${message}`;
        failures.push(`${name} (${message})`);
        errors.push({ name, err });
        ran.push(name);
        log.error("tick.job_failed", `Background job ${name} failed`, { err });
      }
    }
  } finally {
    // A provider that hung this run (its calls were suspended after the first timeout): in the report.
    const open = (Object.keys(breakers) as (keyof Breakers)[]).map((p) => `${p} (${breakers[p]!.what})`);
    if (open.length) report.breakers = `open: ${open.join(", ")}`;
    report.ms = Date.now() - started;
    const value = JSON.stringify({ at: new Date().toISOString(), ...report });
    await db.appSetting
      .upsert({ where: { key: "tick:report" }, create: { key: "tick:report", value }, update: { value } })
      .catch((err) => log.error("tick.report_failed", "Could not save the tick report", { err }));
    log.info("tick.done", "Background tick finished", report);
    // Next run starts the non-money jobs at the first one this run couldn't start (else the next one).
    const firstSkipped = rotateJobs(others, offset).findIndex((j) => !ran.includes(j.name));
    const nextOffset = (offset + (firstSkipped === -1 ? 1 : Math.max(1, firstSkipped))) % Math.max(1, others.length);
    await db.appSetting
      .upsert({ where: { key: NON_MONEY_OFFSET_KEY }, create: { key: NON_MONEY_OFFSET_KEY, value: String(nextOffset) }, update: { value: String(nextOffset) } })
      .catch(() => undefined);
    await noteJobRuns(order.map((j) => j.name), ran).catch((err) => log.warn("tick.job_runs_failed", "Could not record the jobs' last runs", { err }));
    await flushProviderMetrics();
  }
  if (failures.length) await alertEveryStore(`Maintenance automatique en échec : ${failures.join(" ; ")}`);
  // Optional external error tracking (SENTRY_DSN): each failed job, scrubbed.
  await Promise.allSettled([...errors.map((e) => captureException(e.err, { where: `tick:${e.name}`, job: e.name })), flushCaptures()]);
  return report;
}

/**
 * Records when each non-money job last ran; one not run for JOB_STARVED_MS (always skipped for lack of
 * time) is journaled once per 6 h (health shows it meanwhile). A job never seen before starts its clock now.
 */
async function noteJobRuns(names: string[], ran: string[]) {
  const row = await db.appSetting.findUnique({ where: { key: JOB_RAN_KEY } });
  let last: Record<string, string> = {};
  try {
    last = row ? (JSON.parse(row.value) as Record<string, string>) : {};
  } catch {
    last = {};
  }
  const now = new Date().toISOString();
  for (const n of names) if (ran.includes(n) || !last[n]) last[n] = now;
  const value = JSON.stringify(last);
  await db.appSetting.upsert({ where: { key: JOB_RAN_KEY }, create: { key: JOB_RAN_KEY, value }, update: { value } });
  const starved = starvedFrom(last, names);
  if (!starved.length) return;
  const money = starved.filter((j) => starvedAfter(j.name) === MONEY_JOB_STARVED_MS);
  const others = starved.filter((j) => starvedAfter(j.name) !== MONEY_JOB_STARVED_MS);
  // Money jobs and the others are alerted apart (one never silences the other), each at most every 6 h.
  if (money.length) await alertStarved("tick:starved-money-alert", money, true, now);
  if (others.length) await alertStarved("tick:starved-alert", others, false, now);
}

async function alertStarved(key: string, starved: { name: string; ageMs: number }[], money: boolean, now: string) {
  const cutoff = new Date(Date.now() - JOB_STARVED_MS).toISOString();
  const claimed = await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${key}, ${now}, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
    WHERE "AppSetting"."value" < ${cutoff}`;
  if (!claimed) return;
  const store = await db.store.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
  const age = (ms: number) => (ms >= 2 * 3600_000 ? `${Math.round(ms / 3600_000)} h` : `${Math.round(ms / 60_000)} min`);
  const message = money
    ? `Maintenance automatique : tâche(s) de paiement ${starved.map((s) => `« ${s.name} » (dernier passage il y a ${age(s.ageMs)})`).join(", ")} reportée(s) faute de temps : paiements, commandes, remboursements ou litiges ne sont plus rattrapés. Vérifiez la durée des passages (journal) et le planificateur (toutes les 5 min).`
    : `Maintenance automatique : ${starved.map((s) => `« ${s.name} » (dernier passage il y a ${age(s.ageMs)})`).join(", ")} toujours reportée(s) faute de temps. Vérifiez la durée des passages (journal) ou planifiez-les plus souvent.`;
  const kind = money ? "tick.money_job_starved" : "tick.job_starved";
  // A starved money job reaches Sentry too: a synthetic error grouped by kind (one issue, whatever the jobs).
  const err = money ? Object.assign(new Error(`Money job(s) starved: ${starved.map((s) => s.name).join(", ")}`), { name: "MoneyJobStarved" }) : undefined;
  if (store) await recordEvent({ storeId: store.id, level: money ? "error" : "warn", kind, message, data: { jobs: starved.map((s) => s.name) }, alert: true, err, fingerprint: [kind] });
  else if (money) log.error(kind, message, { err });
  else log.warn(kind, message);
}

/** Jobs not run for longer than their threshold (starvedAfter: 1 h money, 6 h others), from the last-run map. Pure. */
export function starvedFrom(last: Record<string, string>, names: string[], now = Date.now(), after: (name: string) => number = starvedAfter): { name: string; ageMs: number }[] {
  return names
    .map((name) => ({ name, ageMs: last[name] ? now - Date.parse(last[name]) : 0 }))
    .filter((s) => Number.isFinite(s.ageMs) && s.ageMs > after(s.name));
}

/**
 * Jobs skipped for lack of time past their threshold (health): money jobs over 1 h, the others over 6 h.
 * Measured at the last tick (not now): a tick that stopped running is reported as such (tick stale),
 * not as every job starving.
 */
export async function starvedJobs(): Promise<{ name: string; ageMs: number }[]> {
  const [row, tick] = await Promise.all([db.appSetting.findUnique({ where: { key: JOB_RAN_KEY } }), tickStatus()]);
  if (!row) return [];
  try {
    const at = tick.at ? Date.parse(tick.at) : Date.now();
    return starvedFrom(JSON.parse(row.value) as Record<string, string>, TICK_JOBS.map((j) => j.name), Number.isFinite(at) ? at : Date.now());
  } catch {
    return [];
  }
}

/**
 * Platform problems (not tied to one store): one alert through the first store that
 * has alert channels — this is a single-operator app, so every store reaches the
 * same person; alerting each store would just repeat it.
 */
async function alertEveryStore(message: string) {
  const store = await db.store.findFirst({
    where: { OR: [{ alertEmail: { not: null } }, { telegramChatId: { not: null } }] },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (store) await recordEvent({ storeId: store.id, level: "error", kind: "tick.job_failed", message, alert: true });
  else log.error("tick.job_failed", message);
}

/* Stale-tick alarm ------------------------------------------------------------ */

/** A stale tick alerts at most this often (health keeps answering 503 meanwhile). */
export const TICK_STALE_ALERT_EVERY_MS = 6 * 3600_000;
const TICK_STALE_ALERT_KEY = "tick:stale-alert";
let lastStaleCheck = 0;

/** Tests: forget the per-instance throttle. */
export function resetTickStaleCheck() {
  lastStaleCheck = 0;
}

/**
 * Called on traffic that proves the app is up (a Whop webhook, a dashboard page): if a
 * store is live and background maintenance hasn't run for TICK_STALE_MS, the scheduler
 * is broken and nothing is being healed any more. Pushes a `tick.stale` alert, at most
 * once per 6 h across instances. Cheap: at most one check per minute per instance.
 * Never throws. True when it alerted.
 */
export async function warnIfTickStale(storeId?: string): Promise<boolean> {
  if (Date.now() - lastStaleCheck < 60_000) return false;
  lastStaleCheck = Date.now();
  try {
    const tick = await tickStatus();
    const age = tick.at ? Date.now() - new Date(tick.at).getTime() : Infinity;
    if (age <= TICK_STALE_MS) return false;
    const live = await db.store.findMany({ where: { enabled: true, whopConnectedAt: { not: null }, shopifyConnectedAt: { not: null } }, select: { id: true, name: true } });
    if (!live.length) return false;
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - TICK_STALE_ALERT_EVERY_MS).toISOString();
    const claimed = await db.$executeRaw`
      INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${TICK_STALE_ALERT_KEY}, ${now}, now())
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
      WHERE "AppSetting"."value" < ${cutoff}`;
    if (claimed === 0) return false;
    // Single-operator app: the store at hand if it has alert channels, else the first one that does.
    const target =
      (storeId && (await db.store.findFirst({ where: { id: storeId, OR: [{ alertEmail: { not: null } }, { telegramChatId: { not: null } }] }, select: { id: true } }))) ||
      (await db.store.findFirst({ where: { OR: [{ alertEmail: { not: null } }, { telegramChatId: { not: null } }] }, orderBy: { createdAt: "asc" }, select: { id: true } })) ||
      (storeId ? { id: storeId } : { id: live[0].id });
    const since = tick.at ? `depuis ${Math.round(age / 60_000)} min` : "jamais";
    await recordEvent({
      storeId: target.id,
      level: "error",
      kind: "tick.stale",
      message: `Maintenance automatique arrêtée (dernier passage : ${since}) alors que ${live.length} boutique(s) sont en ligne : paiements manqués, relances Shopify et remboursements ne sont plus rattrapés. Vérifiez le planificateur (GitHub Actions « Background tick ») et CRON_SECRET.`,
      data: { tickAt: tick.at, liveStores: live.length },
      alert: true,
    });
    return true;
  } catch (err) {
    log.error("tick.stale_check_failed", "Could not check the background tick's freshness", { err });
    return false;
  }
}

/* 1. Shopify sync retries ---------------------------------------------------- */

export async function retrySyncs(deadline: number): Promise<number> {
  const due = await db.checkoutSession.findMany({
    where: {
      status: "PAID",
      shopifyOrderId: null,
      reviewNote: null,
      // Linked by hand, or deliberately not created (refunded / lost before creation).
      syncHandledAt: null,
      OR: [
        { nextSyncAt: { lte: new Date() } },
        // paid but never attempted (webhook's after-response sync cut short, crash…)
        { syncAttempts: 0, paidAt: { lt: new Date(Date.now() - 3 * 60_000) } },
      ],
    },
    select: { id: true, storeId: true },
    take: 60,
    // Never tried first, then the longest overdue retry; stores in turn (rotated from run to run),
    // so one poisoned or slow order (or store) can't hold the whole batch.
    orderBy: [{ nextSyncAt: { sort: "asc", nulls: "first" } }, { paidAt: "asc" }],
  });
  const { list, advance } = await fairByStore("syncRetried", due);
  let done = 0;
  try {
    for (const s of list.slice(0, 25)) {
      if (stopForTime(deadline)) break;
      try {
        // Only runs that actually took the lease count (another run may hold it, or the wait
        // after an ambiguous attempt is still running).
        if (await syncOrder(s.id)) done++;
      } catch (err) {
        // Out of time (nothing was sent, the lease is released): the rest waits for the next run.
        if (err instanceof DeadlineError) {
          notePartial();
          break;
        }
        done++; // a real failure: recorded (attempt, backoff, journal) by syncOrder
      }
    }
  } finally {
    await advance();
  }
  return done;
}

/* 2. Reconciliation ---------------------------------------------------------- */

const MAX_LOOKBACK_MS = 7 * 24 * 3600_000;
const FIRST_LOOKBACK_MS = 48 * 3600_000;
/** Payments can show up in the list a little after their creation time. */
const OVERLAP_MS = 15 * 60_000;

async function reconcilePayments(deadline: number): Promise<number> {
  const all = await db.store.findMany({ where: { whopConnectedAt: { not: null }, whopProductId: { not: null } } });
  const { list: stores, advance } = await rotateStores("reconciled", all);
  let healed = 0;
  let processed = 0;
  const failed: string[] = [];
  for (const store of stores) {
    if (stopForTime(deadline)) break;
    try {
      healed += await reconcileStore(store, deadline);
      processed++;
    } catch (err) {
      if (err instanceof DeadlineError) {
        notePartial();
        break;
      }
      processed++;
      // One store's Whop problem must not stop the others.
      const message = err instanceof Error ? err.message : String(err);
      const kind = whopFailureKind(err);
      log.warn("reconcile.store_failed", "Whop reconciliation failed for a store", { storeId: store.id, failure: kind, err });
      if (kind === "transient") {
        // Whop slow or down (timeout, no answer, 5xx, throttled): resumed next run, journaled without alert.
        notePartial();
        await whopSlow(store.id, "paiements", err);
        continue;
      }
      failed.push(store.name);
      await recordEvent({
        storeId: store.id,
        level: "error",
        kind: "reconcile.failed",
        message:
          kind === "auth"
            ? `Vérification des paiements Whop refusée par Whop (${whopStatus(err)}) : ${message}. Clé API Whop à vérifier (Réglages › Whop).`
            : `Vérification des paiements Whop impossible : ${message}. Nouvel essai au prochain passage ; vérifiez la connexion Whop si l'erreur persiste.`,
        data: { failure: kind, status: whopStatus(err) },
        alert: true,
        err,
      });
    }
  }
  await advance(processed);
  if (failed.length && failed.length === stores.length) throw new Error(`réconciliation impossible pour ${failed.join(", ")}`);
  return healed;
}

/** HTTP status of a Whop SDK error (WhopError.statusCode), or null when Whop never answered. Pure. */
export function whopStatus(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const e = err as { statusCode?: unknown; status?: unknown };
  const v = typeof e.statusCode === "number" ? e.statusCode : typeof e.status === "number" ? e.status : null;
  return v != null && Number.isFinite(v) ? v : null;
}

/**
 * What a failed Whop call says about the store: "auth" (401 / 403: the API key or its permissions — the
 * merchant must act), "transient" (Whop slow or down: a timeout, no HTTP answer at all, 408 / 429 / 5xx —
 * retried next run, never a configuration alert) or "other" (any other answer or error). Pure.
 */
export function whopFailureKind(err: unknown): "auth" | "transient" | "other" {
  const status = whopStatus(err);
  if (status === 401 || status === 403) return "auth";
  if (status != null) return status === 408 || status === 429 || status >= 500 ? "transient" : "other";
  const name = err instanceof Error ? err.name : "";
  // The SDK's errors without a status: timeout (WhopTimeoutError) or no answer (network, aborted).
  if (name.startsWith("Whop") || isTimeoutError(err) || (err instanceof TypeError && /fetch|network|socket/i.test(err.message))) return "transient";
  return "other";
}

/** Whop slow or down during a reconciliation: journaled at most every 30 min per store (health counts it), no alert. */
async function whopSlow(storeId: string, what: string, err: unknown) {
  await recordIncident({
    storeId,
    kind: "reconcile.whop_slow",
    message: `Whop lent ou indisponible : vérification des ${what} reportée au prochain passage (${err instanceof Error ? err.message.slice(0, 200) : String(err)}).`,
    data: { what, status: whopStatus(err) },
    alert: false,
    everyMs: 30 * 60_000,
    err,
  });
}

/** A refunds / disputes reconciliation failure: transient → whopSlow; 401/403 → configuration alert (error); else warn + alert. */
async function reconcileFailed(storeId: string, kind: string, what: string, err: unknown) {
  const failure = whopFailureKind(err);
  const message = err instanceof Error ? err.message : String(err);
  if (failure === "transient") {
    notePartial();
    await whopSlow(storeId, what, err);
    return;
  }
  await recordEvent({
    storeId,
    level: failure === "auth" ? "error" : "warn",
    kind,
    message:
      failure === "auth"
        ? `Vérification des ${what} Whop refusée par Whop (${whopStatus(err)}) : ${message}. Clé API Whop à vérifier (Réglages › Whop).`
        : `Vérification des ${what} Whop impossible : ${message}`,
    data: { failure, status: whopStatus(err) },
    alert: true,
    err,
  });
}

type WhopPayment = Record<string, unknown> & { id: string; created_at?: string; paid_at?: string | null; checkout_configuration_id?: string | null; product_id?: string | null };

/**
 * A walk that couldn't reach the high-water mark in one run (budget, >500 payments)
 * is resumed from Whop's page cursor next time, with the same stop point, so a
 * burst of payments can never leave older ones unchecked forever.
 */
type ReconcileRun = { stopAt: number; newest: number; cursor: string | null; /** When the walk's first page was read. */ startedAt?: number };
const PAGE_SIZE = 50;
const MAX_PER_RUN = 500;

async function reconcileStore(store: Store, deadline: number): Promise<number> {
  // Walk payments by *payment* time, newest first, down to the high-water mark: a
  // payment created long ago but settled just now (Klarna, SEPA, late 3-D Secure) is
  // still seen. Creation is bounded to 7 days, the longest settlement we care about.
  const markKey = `reconcile:${store.id}`;
  const runKey = `reconcile-run:${store.id}`;
  const [mark, pending] = await Promise.all([db.appSetting.findUnique({ where: { key: markKey } }), db.appSetting.findUnique({ where: { key: runKey } })]);
  let run: ReconcileRun | null = null;
  try {
    run = pending ? (JSON.parse(pending.value) as ReconcileRun) : null;
  } catch {
    run = null;
  }
  const stopAt = run?.stopAt ?? (mark ? new Date(mark.value).getTime() - OVERLAP_MS : Date.now() - FIRST_LOOKBACK_MS);
  let newest = Math.max(run?.newest ?? 0, mark ? new Date(mark.value).getTime() : 0);
  let cursor = run?.cursor ?? null;
  // Everything paid before the walk's first page (less the listing lag) is covered once it completes.
  // A resumed walk of an older version (no start time) covers down to its stop point.
  const walkStartedAt = run ? (run.startedAt ?? stopAt + OVERLAP_MS) : Date.now();

  const client = storeClient(store);
  let healed = 0;
  let seen = 0;
  let complete = false;
  while (true) {
    let options: ReturnType<typeof whopCallOptions>;
    try {
      // Bounded by the time left now (not when the client was created): a walk of several pages
      // stops cleanly here, its cursor saved below, instead of starting a call that can't finish.
      options = whopCallOptions("Whop paiements");
    } catch (err) {
      if (!(err instanceof DeadlineError) || seen === 0) throw err;
      break;
    }
    const page = await client.payments.list({
      account_id: store.whopAccountId ?? undefined,
      product_id: store.whopProductId ?? undefined,
      status: "paid",
      created_after: new Date(Date.now() - MAX_LOOKBACK_MS).toISOString(),
      order: "paid_at",
      direction: "desc",
      first: PAGE_SIZE,
      ...(cursor ? { after: cursor } : {}),
    }, options);
    const batch: WhopPayment[] = [];
    let reachedMark = false;
    for (const raw of page.data as unknown as WhopPayment[]) {
      const paidAt = paymentTime(raw);
      if (paidAt != null && paidAt < stopAt) {
        reachedMark = true; // reached what previous runs covered
        break;
      }
      batch.push(raw);
      if (paidAt != null) newest = Math.max(newest, paidAt);
    }
    if (batch.length) healed += await healBatch(store, batch);
    seen += batch.length;
    const info = page.response.page_info;
    const next = info?.has_next_page ? (info.end_cursor ?? null) : null;
    if (reachedMark || !next) {
      complete = true;
      break;
    }
    cursor = next;
    if (seen >= MAX_PER_RUN || stopForTime(deadline)) break;
  }

  if (complete) {
    // Newest first: only advance the mark after reaching it, or unchecked payments would be skipped.
    // Written on every completed walk, even without any payment (a new or quiet store): the mark's
    // freshness is what health watches, and the walk did cover everything paid before it started.
    const value = new Date(reconcileMarkAfterWalk(newest, walkStartedAt)).toISOString();
    await db.appSetting.upsert({ where: { key: markKey }, create: { key: markKey, value }, update: { value } });
    if (pending) await db.appSetting.delete({ where: { key: runKey } }).catch(() => undefined);
  } else {
    const value = JSON.stringify({ stopAt, newest, cursor, startedAt: walkStartedAt } satisfies ReconcileRun);
    await db.appSetting.upsert({ where: { key: runKey }, create: { key: runKey, value }, update: { value } });
    // Payments left for the next run: this job reports "partial" (counted with the skipped ones).
    notePartial();
    log.info("reconcile.partial", "Reconciliation paused, will resume from cursor", { storeId: store.id, seen });
  }
  return healed;
}

/**
 * High-water mark after a completed walk: the newest payment seen, or — when there was none (or it is
 * older) — the walk's start less the listing lag, so a store without payments keeps a fresh mark and
 * the next walk doesn't re-read an ever longer window. Never earlier than what the walk covered. Pure.
 */
export function reconcileMarkAfterWalk(newest: number, walkStartedAt: number): number {
  return Math.max(newest, walkStartedAt - OVERLAP_MS);
}

function paymentTime(p: WhopPayment): number | null {
  const v = (p.paid_at as string | null | undefined) ?? p.created_at;
  const t = v ? new Date(v).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
}

/** Resolves a batch of Whop payments to sessions in two queries and heals the unknown ones. */
async function healBatch(store: Store, all: WhopPayment[]): Promise<number> {
  // The list is filtered by product, but never trust it blindly: another store may share the account.
  const payments = all.filter((p) => !p.product_id || p.product_id === store.whopProductId);
  // One-click offers: a paid offer whose webhook never came is completed here too.
  const offers = payments.filter((p) => typeof (p.metadata as Record<string, unknown> | null)?.upsell_id === "string");
  if (offers.length) {
    const charges = await db.upsellCharge.findMany({
      where: { id: { in: offers.map((p) => String((p.metadata as Record<string, unknown>).upsell_id)) }, status: { not: "PAID" }, session: { storeId: store.id } },
      select: { id: true },
    });
    const open = new Set(charges.map((c) => c.id));
    for (const p of offers) {
      const id = String((p.metadata as Record<string, unknown>).upsell_id);
      if (open.has(id)) await markUpsellPaid(id, p.id, store.id, paymentInfoFromWhop(p).feeCents);
    }
  }
  const relevant = payments.filter((p) => typeof (p.metadata as Record<string, unknown> | null)?.upsell_id !== "string");
  const configIds = relevant.map((p) => p.checkout_configuration_id).filter((v): v is string => !!v);
  const [quotes, known] = await Promise.all([
    configIds.length
      ? db.checkoutQuote.findMany({ where: { whopCheckoutId: { in: configIds } }, select: { whopCheckoutId: true, sessionId: true } })
      : [],
    db.checkoutSession.findMany({
      where: { storeId: store.id, OR: [{ whopPaymentId: { in: relevant.map((p) => p.id) } }, { extraPaymentIds: { hasSome: relevant.map((p) => p.id) } }] },
      select: { whopPaymentId: true, extraPaymentIds: true },
    }),
  ]);
  const knownIds = new Set(known.flatMap((k) => [k.whopPaymentId, ...k.extraPaymentIds]));
  const byConfig = new Map(quotes.map((q) => [q.whopCheckoutId, q.sessionId]));
  const candidates = relevant
    .filter((p) => !knownIds.has(p.id))
    .map((p) => {
      const meta = (p.metadata as Record<string, unknown> | null)?.checkout_session_id;
      return { p, sessionId: typeof meta === "string" ? meta : p.checkout_configuration_id ? byConfig.get(p.checkout_configuration_id) : undefined };
    })
    .filter((c): c is { p: WhopPayment; sessionId: string } => !!c.sessionId);
  if (!candidates.length) return 0;
  const sessions = await db.checkoutSession.findMany({
    where: { id: { in: candidates.map((c) => c.sessionId) }, storeId: store.id },
    select: { id: true },
  });
  const mine = new Set(sessions.map((s) => s.id));
  let healed = 0;
  for (const { p, sessionId } of candidates) {
    if (!mine.has(sessionId)) continue;
    const outcome: { paidNow?: boolean } = {};
    // The Shopify order is created after the Whop-side jobs (tick follow-ups), never inline here.
    if (await markPaid(sessionId, paymentInfoFromWhop(p), { outcome, deferSync: true })) {
      if (!defer("order.sync", () => syncOrderSafely(sessionId))) await syncOrderSafely(sessionId);
    }
    // Already paid (a second payment for the cart, alerted as payment.duplicate, or a webhook that
    // landed meanwhile): nothing was healed, no second alert.
    if (!outcome.paidNow) continue;
    healed++;
    await recordEvent({
      storeId: store.id,
      sessionId,
      level: "warn",
      kind: "reconcile.healed",
      message: `Paiement ${p.id} récupéré par la réconciliation : le webhook Whop n'était pas arrivé.`,
      alert: true,
    });
  }
  return healed;
}

/**
 * Refunds made in Whop reach us by webhook; this catches the ones whose webhook never
 * came (bad secret, outage). Walks refunds by creation time from a per-store mark and
 * applies each through the same handler (idempotent per refund id). The list is
 * account-wide: refunds of another store sharing the account are skipped silently.
 * Refunds still pending are remembered one by one (`refund-pending:`) and re-checked
 * until final, so a lost `refund.updated` can never lose them.
 */
async function reconcileRefunds(deadline: number): Promise<number> {
  const all = await db.store.findMany({ where: { whopConnectedAt: { not: null }, whopProductId: { not: null } } });
  const { list: stores, advance } = await rotateStores("refundsReconciled", all);
  let applied = 0;
  let processed = 0;
  for (const store of stores) {
    if (stopForTime(deadline)) break;
    const key = `refund-mark:${store.id}`;
    const mark = await db.appSetting.findUnique({ where: { key } });
    const since = new Date((mark ? new Date(mark.value).getTime() : Date.now() - FIRST_LOOKBACK_MS) - OVERLAP_MS);
    let cursor: string | undefined;
    let newest = mark ? new Date(mark.value).getTime() : 0;
    let blockedAt: number | null = null;
    // Reached the last page: everything created before the walk started (less the listing lag) is covered.
    const walkStartedAt = Date.now();
    let complete = false;
    try {
      applied += await recheckPendingRefunds(store, deadline);
      for (let page = 0; page < 4; page++) {
        if (stopForTime(deadline)) break;
        const res = await storeClient(store).refunds.list({
          account_id: store.whopAccountId ?? undefined,
          created_after: since.toISOString(),
          order: "created_at",
          direction: "asc",
          first: 50,
          ...(cursor ? { after: cursor } : {}),
        }, whopCallOptions("Whop remboursements"));
        for (const r of res.data) {
          if (stopForTime(deadline)) throw new DeadlineError("remboursements");
          const created = new Date(r.created_at).getTime();
          const data = r as unknown as Record<string, unknown>;
          const paymentId = eventPaymentId(data);
          if (!(await isDone(store.id, r.id))) {
            // Another store of this app on the same Whop account: its own reconciliation handles it.
            const owner = paymentId ? await paymentOwner(store.id, { paymentId, metadata: eventPaymentMetadata(data) }) : null;
            if (owner?.kind === "sibling") await markSkipped(store.id, r.id);
            else if (r.status !== "succeeded") {
              if (["pending", "requires_action"].includes(String(r.status))) await rememberPending(store.id, r.id, created);
              else await markSkipped(store.id, r.id); // failed / canceled: nothing to apply
            } else {
              try {
                if (await applyListedRefund(store.id, data)) applied++;
              } catch (err) {
                if (!(err instanceof RetryLater)) throw err;
                if (Date.now() - created < UNRESOLVED_AFTER_MS) blockedAt ??= created; // payment not recorded yet: retry from here
                else await reportUnresolvedRefund(store.id, r.id, paymentId);
              }
            }
          }
          if (blockedAt == null) newest = Math.max(newest, created);
        }
        const info = res.response.page_info;
        if (!info?.has_next_page || !info.end_cursor) {
          complete = true;
          break;
        }
        cursor = info.end_cursor;
      }
    } catch (err) {
      if (err instanceof DeadlineError) {
        notePartial();
        break;
      }
      processed++;
      log.warn("reconcile.refunds_failed", "Refund reconciliation failed for a store", { storeId: store.id, err });
      await reconcileFailed(store.id, "reconcile.refunds_failed", "remboursements", err);
      continue;
    }
    // Resume from the first refund that couldn't be applied yet, else from the newest seen — or, after a
    // complete walk (an empty or quiet store included), from the walk's start less the listing lag: the
    // mark moves (health watches it) and later walks don't re-read an ever longer window.
    const value = new Date(
      blockedAt != null ? blockedAt - 1000 : complete ? reconcileMarkAfterWalk(newest, walkStartedAt) : newest || walkStartedAt - OVERLAP_MS,
    ).toISOString();
    await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
    processed++;
  }
  await advance(processed);
  return applied;
}

/**
 * Applied (`refund:<id>`, written under the owning store, looked up across stores) or already
 * looked at by this store (`refund-skip:<store>:<id>`). A legacy "skipped" row under the
 * shared key never means applied.
 */
async function isDone(storeId: string, refundId: string): Promise<boolean> {
  const n = await db.webhookEvent.count({
    where: { OR: [{ id: `refund:${refundId}`, type: { not: "refund.skipped" } }, { storeId, id: `refund-skip:${storeId}:${refundId}` }] },
  });
  return n > 0;
}

/**
 * Per-store marker: the applied-refund marker (`refund:<id>`) is shared by every store,
 * so a store skipping another store's refund must never write that one.
 */
async function markSkipped(storeId: string, refundId: string) {
  await db.webhookEvent.createMany({ data: [{ id: `refund-skip:${storeId}:${refundId}`, storeId, type: "refund.skipped", processedAt: new Date() }], skipDuplicates: true });
}

/** Applies a listed succeeded refund; true when it was applied now (webhook missed). */
async function applyListedRefund(storeId: string, data: Record<string, unknown>): Promise<boolean> {
  const id = String(data.id);
  await handleEvent("refund.created", data, storeId);
  if (await db.webhookEvent.findFirst({ where: { id: `refund:${id}`, type: { not: "refund.skipped" } }, select: { id: true } })) {
    await recordEvent({ storeId, level: "warn", kind: "reconcile.refund_healed", message: `Remboursement Whop ${id} récupéré par la réconciliation (webhook manquant).` });
    return true;
  }
  // Not one of ours (another product on the account) or already journaled (currency,
  // unreadable): remember it, so later runs skip it silently.
  await markSkipped(storeId, id);
  return false;
}

const PENDING_PREFIX = "refund-pending:";
/** A refund still pending after this long is dropped from the watch list (the merchant is told). */
const PENDING_WATCH_MS = 14 * 24 * 3600_000;
const PENDING_RECHECK_MS = 30 * 60_000;

async function rememberPending(storeId: string, refundId: string, createdAt: number) {
  await db.appSetting.createMany({
    data: [{ key: `${PENDING_PREFIX}${storeId}:${refundId}`, value: JSON.stringify({ createdAt, checkedAt: Date.now() }) }],
    skipDuplicates: true,
  });
}

/** Re-checks remembered pending refunds one by one (Whop's refunds.retrieve) until final or 14 days old. */
async function recheckPendingRefunds(store: Store, deadline: number): Promise<number> {
  const rows = await db.appSetting.findMany({ where: { key: { startsWith: `${PENDING_PREFIX}${store.id}:` } }, orderBy: { updatedAt: "asc" }, take: 20 });
  let applied = 0;
  for (const row of rows) {
    if (stopForTime(deadline)) break;
    const refundId = row.key.slice(`${PENDING_PREFIX}${store.id}:`.length);
    let state: { createdAt: number; checkedAt: number };
    try {
      state = JSON.parse(row.value) as typeof state;
    } catch {
      state = { createdAt: row.updatedAt.getTime(), checkedAt: 0 };
    }
    const drop = () => db.appSetting.delete({ where: { key: row.key } }).catch(() => undefined);
    if (await isDone(store.id, refundId)) {
      await drop();
      continue;
    }
    if (Date.now() - state.checkedAt < PENDING_RECHECK_MS) continue;
    const r = (await storeClient(store).refunds.retrieve({ id: refundId }, whopCallOptions("Whop remboursements"))) as unknown as Record<string, unknown>;
    if (r.status === "succeeded") {
      try {
        if (await applyListedRefund(store.id, r)) applied++;
        await drop();
      } catch (err) {
        if (!(err instanceof RetryLater)) throw err;
      }
    } else if (r.status === "failed" || r.status === "canceled") {
      await markSkipped(store.id, refundId);
      await drop();
    } else if (Date.now() - state.createdAt > PENDING_WATCH_MS) {
      await drop();
      await recordEvent({
        storeId: store.id,
        level: "warn",
        kind: "refund.pending_expired",
        message: `Remboursement Whop ${refundId} toujours « ${String(r.status)} » après 14 jours : plus suivi automatiquement. Vérifiez-le dans Whop et reportez-le dans Shopify s'il aboutit.`,
        data: { refundId },
        alert: true,
      });
      continue;
    }
    if (r.status !== "succeeded" && r.status !== "failed" && r.status !== "canceled") {
      await db.appSetting.update({ where: { key: row.key }, data: { value: JSON.stringify({ createdAt: state.createdAt, checkedAt: Date.now() }) } });
    }
  }
  return applied;
}

/** A refund still unattributable after a day stops blocking the walk (the merchant is told once). */
const UNRESOLVED_AFTER_MS = 24 * 3600_000;

async function reportUnresolvedRefund(storeId: string, refundId: string, paymentId: string | null | undefined) {
  const key = `refund-unresolved:${refundId}`;
  const first = await db.appSetting.createMany({ data: [{ key, value: new Date().toISOString() }], skipDuplicates: true });
  if (!first.count) return;
  await recordEvent({
    storeId,
    level: "error",
    kind: "refund.unresolved",
    message: `Remboursement Whop ${refundId} (paiement ${paymentId ?? "?"}) impossible à rattacher à une commande depuis 24 h : vérifiez-le dans Whop et reportez-le dans Shopify si besoin.`,
    data: { refundId, paymentId },
    alert: true,
  });
}

/**
 * Disputes reach us by webhook; this catches openings and outcomes whose webhook never
 * came (rotated secret, outage). A full walk starts at most hourly per store; everything
 * goes through the same idempotent handlers. A walk cut short (time budget, many pages)
 * is resumed from Whop's page cursor on the next tick (`dispute-scan-run:`), and the scan
 * mark (`dispute-scan:`, watched by health) is only written once a walk has reached the
 * last page: a partial walk never counts as a scan.
 */
type DisputeScanRun = { since: string; cursor: string | null; firstScan: boolean; pages: number };
const DISPUTE_SCAN_EVERY_MS = 60 * 60_000;
const DISPUTE_LOOKBACK_MS = 120 * 24 * 3600_000;

async function reconcileDisputes(deadline: number): Promise<number> {
  const all = await db.store.findMany({ where: { whopConnectedAt: { not: null }, whopProductId: { not: null } } });
  const { list: stores, advance } = await rotateStores("disputesReconciled", all);
  let healed = 0;
  let processed = 0;
  for (const store of stores) {
    if (stopForTime(deadline)) break;
    const key = `dispute-scan:${store.id}`;
    const runKey = `dispute-scan-run:${store.id}`;
    const [last, pending] = await Promise.all([db.appSetting.findUnique({ where: { key } }), db.appSetting.findUnique({ where: { key: runKey } })]);
    let run: DisputeScanRun | null = null;
    try {
      run = pending ? (JSON.parse(pending.value) as DisputeScanRun) : null;
    } catch {
      run = null;
    }
    // A walk in progress resumes at once; a new one starts hourly.
    if (!run && last && Date.now() - new Date(last.value).getTime() < DISPUTE_SCAN_EVERY_MS) {
      processed++;
      continue;
    }
    const state: DisputeScanRun = run ?? { since: new Date(Date.now() - DISPUTE_LOOKBACK_MS).toISOString(), cursor: null, firstScan: !last, pages: 0 };
    let complete = false;
    try {
      while (!stopForTime(deadline)) {
        const res = await storeClient(store).disputes.list({
          account_id: store.whopAccountId ?? undefined,
          created_after: state.since,
          first: 50,
          ...(state.cursor ? { after: state.cursor } : {}),
        }, whopCallOptions("Whop litiges"));
        for (const d of res.data) healed += await reconcileOneDispute(store, d as unknown as Record<string, unknown> & { id: string; status?: string }, state.firstScan);
        state.pages++;
        const info = res.response.page_info;
        if (!info?.has_next_page || !info.end_cursor) {
          complete = true;
          break;
        }
        // Saved after each page: a crash or timeout resumes here, never from the start.
        state.cursor = info.end_cursor;
        await db.appSetting.upsert({ where: { key: runKey }, create: { key: runKey, value: JSON.stringify(state) }, update: { value: JSON.stringify(state) } });
      }
      if (complete) {
        const value = new Date().toISOString();
        await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
        await db.appSetting.deleteMany({ where: { key: runKey } });
      } else {
        log.info("reconcile.disputes_partial", "Dispute scan paused, will resume from cursor", { storeId: store.id, pages: state.pages });
      }
      processed++;
    } catch (err) {
      if (err instanceof DeadlineError) {
        notePartial();
        break;
      }
      processed++;
      log.warn("reconcile.disputes_failed", "Dispute reconciliation failed for a store", { storeId: store.id, err });
      await reconcileFailed(store.id, "reconcile.disputes_failed", "litiges", err);
    }
  }
  await advance(processed);
  return healed;
}

/** One listed dispute through the webhook handlers; 1 when its opening was missed (healed). */
async function reconcileOneDispute(store: Store, d: Record<string, unknown> & { id: string; status?: string }, firstScan: boolean): Promise<number> {
  const data = d;
  const paymentId = eventPaymentId(data);
  let target: Awaited<ReturnType<typeof resolvePayment>>;
  try {
    target = paymentId ? await resolvePayment(store.id, paymentId, eventPaymentMetadata(data)) : null;
  } catch (err) {
    // An offer's payment not recorded yet (charge still in flight): the next hourly scan sees it again.
    if (err instanceof RetryLater) return 0;
    throw err;
  }
  if (!target || target.kind === "extra" || target.kind === "offer_attempt") return 0;
  const row =
    target.kind === "session"
      ? await db.checkoutSession.findUnique({ where: { id: target.sessionId }, select: { disputed: true, disputeStatus: true } })
      : await db.upsellCharge.findUnique({ where: { id: target.chargeId }, select: { disputed: true, disputeStatus: true } });
  const final = ["won", "lost", "closed"].includes(String(d.status));
  if (row && !row.disputed && final) {
    // Already over (typically found by the very first scan of a store): recorded for
    // the analytics and journaled, but no "dispute opened" alert for a closed case.
    await recordClosedDispute(store.id, target, d.id, String(d.status), data, firstScan);
    if (!firstScan) await handleEvent("dispute.updated", data, store.id); // a missed outcome still alerts (lost)
    return 0;
  }
  let healed = 0;
  if (row && !row.disputed) {
    await handleEvent("dispute.created", data, store.id);
    healed = 1;
    await recordEvent({ storeId: store.id, sessionId: target.sessionId, level: "warn", kind: "reconcile.dispute_healed", message: `Litige ${d.id} récupéré par la réconciliation (webhook manquant).` });
  }
  if (final && row?.disputeStatus !== d.status) await handleEvent("dispute.updated", data, store.id);
  return healed;
}

/** Marks a dispute found already closed; on the first scan its outcome is written quietly too. */
async function recordClosedDispute(
  storeId: string,
  target: { kind: "session"; sessionId: string; currency: string } | { kind: "offer"; sessionId: string; chargeId: string; currency: string },
  disputeId: string,
  status: string,
  data: Record<string, unknown>,
  withOutcome: boolean,
) {
  const lost = status === "lost" ? refundAmountIn(target.currency, data) : 0;
  const base = { disputed: true, disputeOpenedAt: new Date(), disputeId, disputeTaggedAt: new Date() };
  if (target.kind === "session") {
    const s = await db.checkoutSession.findUnique({ where: { id: target.sessionId }, select: { totalCents: true } });
    await db.checkoutSession.updateMany({
      where: { id: target.sessionId, disputed: false },
      data: { ...base, ...(withOutcome ? { disputeStatus: status, disputeLostCents: status === "lost" ? (lost ?? s?.totalCents ?? 0) : 0, ...GOOGLE_ADJUST_DUE } : {}) },
    });
  } else {
    const c = await db.upsellCharge.findUnique({ where: { id: target.chargeId }, select: { amountCents: true } });
    const written = await db.upsellCharge.updateMany({
      where: { id: target.chargeId, disputed: false },
      data: { ...base, ...(withOutcome ? { disputeStatus: status, disputeLostCents: status === "lost" ? (lost ?? c?.amountCents ?? 0) : 0 } : {}) },
    });
    if (written.count && withOutcome) await markGoogleAdjustDue(target.sessionId);
  }
  await recordEvent({
    storeId,
    sessionId: target.sessionId,
    kind: "reconcile.dispute_closed",
    message: `Litige ${disputeId} déjà clos (${status === "won" ? "gagné" : status === "lost" ? "perdu" : "clos"}) retrouvé par la vérification des litiges : enregistré, rien à faire.`,
    data: { disputeId, status },
  });
}

/* 3. Tracking → Whop ---------------------------------------------------------- */

async function pushTrackingNumbers(deadline: number): Promise<number> {
  const sessions = await db.checkoutSession.findMany({
    where: {
      status: "PAID",
      shopifyOrderId: { not: null },
      whopPaymentId: { not: null },
      trackingPushedAt: null,
      trackingGaveUpAt: null,
      paidAt: { gt: new Date(Date.now() - 45 * 24 * 3600_000) },
      store: { pushTracking: true },
      OR: [{ trackingCheckedAt: null }, { trackingCheckedAt: { lt: new Date(Date.now() - 6 * 3600_000) } }],
    },
    include: { store: true },
    take: 20,
    orderBy: { paidAt: "asc" },
  });
  let pushed = 0;
  for (const s of sessions) {
    if (stopForTime(deadline)) break;
    try {
      if (await pushTracking(s)) pushed++;
    } catch (err) {
      if (err instanceof DeadlineError) {
        // The claim set trackingCheckedAt: give it back so the next run tries again soon.
        await db.checkoutSession.update({ where: { id: s.id }, data: { trackingCheckedAt: null } });
        notePartial();
        break;
      }
      log.warn("tracking.push_failed", "Could not push tracking to Whop", { sessionId: s.id, attempts: s.trackingPushAttempts + 1, err });
      await recordTrackingFailure(s, err).catch((e) => log.error("tracking.fail_record_failed", "Could not record the tracking failure", { sessionId: s.id, err: e }));
    }
  }
  return pushed;
}

/* 4. Cleanup ------------------------------------------------------------------ */

/** WebhookEvent rows that are idempotency markers, never webhook copies: kept forever. */
export const PERMANENT_WEBHOOK_MARKERS = ["refund:", "refund-skip:"];

export async function cleanup(): Promise<number> {
  const day = 24 * 3600_000;
  const [limits, events, webhooks, alerts, metrics] = await Promise.all([
    db.rateLimit.deleteMany({ where: { resetAt: { lt: new Date(Date.now() - 3600_000) } } }),
    db.eventLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 365 * day) } } }),
    // Webhook copies only: the refund / skipped-refund markers (id "refund:…", "refund-skip:…") are
    // permanent idempotency keys — purging them would let a replayed refund count twice.
    db.webhookEvent.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - 180 * day) }, NOT: PERMANENT_WEBHOOK_MARKERS.map((prefix) => ({ id: { startsWith: prefix } })) } }),
    db.alertOutbox.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 30 * day) } } }),
    // Provider metrics (5-min buckets): 14 days.
    purgeProviderMetrics(),
  ]);
  // Redacted /cart.js copies (bundle apps diagnostics): 7 days.
  const snapshots = await db.cartSnapshot.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 7 * day) } } });
  return limits.count + events.count + webhooks.count + alerts.count + metrics + snapshots.count;
}

/** Last tick report, for the dashboard and /api/health. */
export async function tickStatus(): Promise<{ at: string | null; report: TickReport | null }> {
  const row = await db.appSetting.findUnique({ where: { key: "tick:report" } });
  if (!row) return { at: null, report: null };
  try {
    const parsed = JSON.parse(row.value) as TickReport & { at: string };
    return { at: parsed.at, report: parsed };
  } catch {
    return { at: null, report: null };
  }
}
