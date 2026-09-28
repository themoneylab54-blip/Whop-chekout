import "server-only";
import type { Store } from "@prisma/client";
import { db } from "./db";
import { markPaid, syncOrderSafely } from "./checkout";
import { pushTracking } from "./disputes";
import { log, recordEvent } from "./log";
import { paymentInfoFromWhop, storeClient } from "./whop";

/*
 * Background maintenance, run by Vercel Cron and opportunistically by live traffic
 * (at most every few minutes). Every job is idempotent and bounded, so overlapping
 * runs are harmless.
 *
 *  1. reconcile  — pull recent paid Whop payments and heal any missed webhook
 *  2. retries    — re-run failed Shopify syncs whose backoff has elapsed
 *  3. tracking   — push Shopify tracking numbers to Whop (dispute shield)
 *  4. cleanup    — expired rate-limit rows
 */

const TICK_KEY = "tick:last";
const MIN_INTERVAL_MS = 4 * 60 * 1000;

/** Runs the tick if the last one is older than a few minutes (atomic claim). */
export async function maybeTick(): Promise<boolean> {
  const cutoff = new Date(Date.now() - MIN_INTERVAL_MS).toISOString();
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

export async function runTick(): Promise<TickReport> {
  const report: TickReport = {};
  const started = Date.now();
  const jobs: [string, () => Promise<number>][] = [
    ["reconciled", reconcilePayments],
    ["syncRetried", retrySyncs],
    ["trackingPushed", pushTrackingNumbers],
    ["cleaned", cleanup],
  ];
  for (const [name, job] of jobs) {
    try {
      report[name] = await job();
    } catch (err) {
      report[name] = `error: ${err instanceof Error ? err.message : String(err)}`;
      log.error("tick.job_failed", `Background job ${name} failed`, { err });
    }
  }
  report.ms = Date.now() - started;
  await db.appSetting.upsert({
    where: { key: "tick:report" },
    create: { key: "tick:report", value: JSON.stringify({ at: new Date().toISOString(), ...report }) },
    update: { value: JSON.stringify({ at: new Date().toISOString(), ...report }) },
  });
  log.info("tick.done", "Background tick finished", report);
  return report;
}

/* 1. Reconciliation ---------------------------------------------------------- */

async function reconcilePayments(): Promise<number> {
  const stores = await db.store.findMany({ where: { whopConnectedAt: { not: null }, whopProductId: { not: null } } });
  let healed = 0;
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();
  for (const store of stores) {
    try {
      healed += await reconcileStore(store, since);
    } catch (err) {
      log.warn("reconcile.store_failed", "Whop reconciliation failed for a store", { storeId: store.id, err });
    }
  }
  return healed;
}

async function reconcileStore(store: Store, since: string): Promise<number> {
  const client = storeClient(store);
  let healed = 0;
  let seen = 0;
  const page = await client.payments.list({
    account_id: store.whopAccountId ?? undefined,
    product_id: store.whopProductId ?? undefined,
    status: "paid",
    created_after: since,
    first: 50,
  });
  for await (const p of page) {
    if (++seen > 200) break;
    const data = p as unknown as Record<string, unknown>;
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    if (typeof metadata.upsell_id === "string") continue; // handled by the upsell flow
    const sessionId =
      (typeof metadata.checkout_session_id === "string" ? metadata.checkout_session_id : null) ??
      (p.checkout_configuration_id
        ? (await db.checkoutQuote.findUnique({ where: { whopCheckoutId: p.checkout_configuration_id }, select: { sessionId: true } }))?.sessionId
        : null);
    if (!sessionId) continue;
    const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, select: { storeId: true, status: true, whopPaymentId: true } });
    if (!session || session.storeId !== store.id) continue;
    if (session.status === "PAID" && session.whopPaymentId) continue; // already known (or flagged as duplicate)
    await markPaid(sessionId, paymentInfoFromWhop(data));
    healed++;
    await recordEvent({
      storeId: store.id,
      sessionId,
      level: "warn",
      kind: "reconcile.healed",
      message: `Paiement ${p.id} récupéré par la réconciliation (webhook manquant)`,
    });
  }
  return healed;
}

/* 2. Shopify sync retries ---------------------------------------------------- */

async function retrySyncs(): Promise<number> {
  const due = await db.checkoutSession.findMany({
    where: {
      status: "PAID",
      shopifyOrderId: null,
      reviewNote: null,
      OR: [
        { nextSyncAt: { lte: new Date() } },
        // paid but never attempted (e.g. crash between PAID and sync)
        { syncAttempts: 0, paidAt: { lt: new Date(Date.now() - 3 * 60_000) } },
      ],
    },
    select: { id: true },
    take: 20,
    orderBy: { paidAt: "asc" },
  });
  for (const s of due) await syncOrderSafely(s.id);
  return due.length;
}

/* 3. Tracking → Whop ---------------------------------------------------------- */

async function pushTrackingNumbers(): Promise<number> {
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
  const { count } = await db.rateLimit.deleteMany({ where: { resetAt: { lt: new Date(Date.now() - 3600_000) } } });
  return count;
}

/** Health summary for the dashboard. */
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
