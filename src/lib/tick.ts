import "server-only";
import type { Store } from "@prisma/client";
import { db } from "./db";
import { markPaid, syncOrderSafely } from "./checkout";
import { pushTracking } from "./disputes";
import { retryUpsellSyncs } from "./upsell";
import { retryConversions } from "./conversions";
import { log, recordEvent } from "./log";
import { paymentInfoFromWhop, storeClient } from "./whop";

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
const MIN_INTERVAL_MS = 4 * 60 * 1000;
/** Whole tick must fit in the 60 s function limit, with margin for the report. */
export const TICK_BUDGET_MS = 40_000;

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

export async function runTick(budgetMs = TICK_BUDGET_MS): Promise<TickReport> {
  const report: TickReport = {};
  const started = Date.now();
  const deadline = started + budgetMs;
  const jobs: [string, Job][] = [
    ["syncRetried", retrySyncs],
    ["upsellRetried", retryUpsellSyncs],
    ["conversionsRetried", retryConversions],
    ["reconciled", reconcilePayments],
    ["trackingPushed", pushTrackingNumbers],
    ["cleaned", cleanup],
  ];
  const failures: string[] = [];
  try {
    for (const [name, job] of jobs) {
      if (Date.now() > deadline) {
        report[name] = "skipped: time budget used";
        continue;
      }
      try {
        report[name] = await job(deadline);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report[name] = `error: ${message}`;
        failures.push(`${name} (${message})`);
        log.error("tick.job_failed", `Background job ${name} failed`, { err });
      }
    }
  } finally {
    report.ms = Date.now() - started;
    const value = JSON.stringify({ at: new Date().toISOString(), ...report });
    await db.appSetting
      .upsert({ where: { key: "tick:report" }, create: { key: "tick:report", value }, update: { value } })
      .catch((err) => log.error("tick.report_failed", "Could not save the tick report", { err }));
    log.info("tick.done", "Background tick finished", report);
  }
  if (failures.length) await alertEveryStore(`Maintenance automatique en échec : ${failures.join(" ; ")}`);
  return report;
}

/** Platform problems concern every store: alert each one that has a channel (throttled). */
async function alertEveryStore(message: string) {
  const stores = await db.store.findMany({
    where: { OR: [{ alertEmail: { not: null } }, { telegramChatId: { not: null } }] },
    select: { id: true },
  });
  for (const s of stores) {
    await recordEvent({ storeId: s.id, level: "error", kind: "tick.job_failed", message, alert: true });
  }
}

/* 1. Shopify sync retries ---------------------------------------------------- */

async function retrySyncs(deadline: number): Promise<number> {
  const due = await db.checkoutSession.findMany({
    where: {
      status: "PAID",
      shopifyOrderId: null,
      reviewNote: null,
      OR: [
        { nextSyncAt: { lte: new Date() } },
        // paid but never attempted (webhook's after-response sync cut short, crash…)
        { syncAttempts: 0, paidAt: { lt: new Date(Date.now() - 3 * 60_000) } },
      ],
    },
    select: { id: true },
    take: 25,
    orderBy: { paidAt: "asc" },
  });
  let done = 0;
  for (const s of due) {
    if (Date.now() > deadline) break;
    await syncOrderSafely(s.id);
    done++;
  }
  return done;
}

/* 2. Reconciliation ---------------------------------------------------------- */

const MAX_LOOKBACK_MS = 7 * 24 * 3600_000;
const FIRST_LOOKBACK_MS = 48 * 3600_000;
/** Payments can show up in the list a little after their creation time. */
const OVERLAP_MS = 15 * 60_000;

async function reconcilePayments(deadline: number): Promise<number> {
  const stores = await db.store.findMany({ where: { whopConnectedAt: { not: null }, whopProductId: { not: null } } });
  let healed = 0;
  for (const store of stores) {
    if (Date.now() > deadline) break;
    try {
      healed += await reconcileStore(store, deadline);
    } catch (err) {
      log.warn("reconcile.store_failed", "Whop reconciliation failed for a store", { storeId: store.id, err });
      throw err;
    }
  }
  return healed;
}

type WhopPayment = Record<string, unknown> & { id: string; created_at?: string; checkout_configuration_id?: string | null };

async function reconcileStore(store: Store, deadline: number): Promise<number> {
  const markKey = `reconcile:${store.id}`;
  const mark = await db.appSetting.findUnique({ where: { key: markKey } });
  const floor = Date.now() - MAX_LOOKBACK_MS;
  const from = Math.max(floor, mark ? new Date(mark.value).getTime() - OVERLAP_MS : Date.now() - FIRST_LOOKBACK_MS);

  const page = await storeClient(store).payments.list({
    account_id: store.whopAccountId ?? undefined,
    product_id: store.whopProductId ?? undefined,
    status: "paid",
    created_after: new Date(from).toISOString(),
    order: "created_at",
    direction: "asc",
    first: 50,
  });

  let healed = 0;
  let newest = mark ? new Date(mark.value).getTime() : from;
  let batch: WhopPayment[] = [];
  let seen = 0;
  const flush = async () => {
    healed += await healBatch(store, batch);
    for (const p of batch) if (p.created_at) newest = Math.max(newest, new Date(p.created_at).getTime());
    batch = [];
  };
  for await (const p of page) {
    batch.push(p as unknown as WhopPayment);
    if (batch.length >= 50) await flush();
    // Oldest first: stopping early is safe, the mark only advances past what was checked.
    if (++seen >= 500 || Date.now() > deadline) break;
  }
  if (batch.length) await flush();
  await db.appSetting.upsert({
    where: { key: markKey },
    create: { key: markKey, value: new Date(newest).toISOString() },
    update: { value: new Date(newest).toISOString() },
  });
  return healed;
}

/** Resolves a batch of Whop payments to sessions in two queries and heals the unknown ones. */
async function healBatch(store: Store, payments: WhopPayment[]): Promise<number> {
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
    await markPaid(sessionId, paymentInfoFromWhop(p));
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

/* 3. Tracking → Whop ---------------------------------------------------------- */

async function pushTrackingNumbers(deadline: number): Promise<number> {
  const sessions = await db.checkoutSession.findMany({
    where: {
      status: "PAID",
      shopifyOrderId: { not: null },
      whopPaymentId: { not: null },
      trackingPushedAt: null,
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
    if (Date.now() > deadline) break;
    try {
      if (await pushTracking(s)) pushed++;
    } catch (err) {
      log.warn("tracking.push_failed", "Could not push tracking to Whop", { sessionId: s.id, err });
    }
  }
  return pushed;
}

/* 4. Cleanup ------------------------------------------------------------------ */

async function cleanup(): Promise<number> {
  const day = 24 * 3600_000;
  const [limits, events, webhooks] = await Promise.all([
    db.rateLimit.deleteMany({ where: { resetAt: { lt: new Date(Date.now() - 3600_000) } } }),
    db.eventLog.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - 365 * day) } } }),
    db.webhookEvent.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - 180 * day) } } }),
  ]);
  return limits.count + events.count + webhooks.count;
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
