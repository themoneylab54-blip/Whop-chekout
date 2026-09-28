import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { sendAlert } from "./notify";
import { defer } from "./deferred";
import { noteProviderCall } from "./metrics";
import { forwardLoggedError, forwardLoggedMessage } from "./sentry";

type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

/**
 * Correlation context (request id, webhook id, session id…) merged into every log
 * line and journal entry written while it is active, including code run later
 * through `after()` when wrapped with `withLogContext` again.
 */
const context = new AsyncLocalStorage<Fields>();

export function withLogContext<T>(fields: Fields, fn: () => T): T {
  return context.run({ ...context.getStore(), ...fields }, fn);
}

export function logContext(): Fields {
  return context.getStore() ?? {};
}

/** One JSON line per log: searchable in Vercel's log explorer (filter on kind, sessionId…). */
function emit(level: Level, kind: string, message: string, fields: Fields = {}, forward = true) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, kind, message, ...logContext(), ...fields }, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message, stack: v.stack?.split("\n").slice(0, 5).join("\n") } : v,
  );
  if (level === "error") {
    console.error(line);
    // Optional external error tracking (SENTRY_DSN): an error line carrying the error itself.
    if (forward && fields.err !== undefined) forwardLoggedError(kind, fields.err, logContext());
  }
  else if (level === "warn") console.warn(line);
  else console.log(line);
  // Every external call (Shopify, Whop, ad platforms…) feeds the per-provider metrics (buffered, no I/O).
  if (kind === "ext.call" && typeof fields.provider === "string") {
    noteProviderCall(fields.provider, fields);
    // The request / run counts its own calls: route() flushes the metrics after answering only then.
    const holder = logContext().extCalls as { n: number } | undefined;
    if (holder && typeof holder === "object") holder.n++;
  }
}

export const log = {
  info: (kind: string, message: string, fields?: Fields) => emit("info", kind, message, fields),
  warn: (kind: string, message: string, fields?: Fields) => emit("warn", kind, message, fields),
  error: (kind: string, message: string, fields?: Fields) => emit("error", kind, message, fields),
};

/**
 * Records a business event in the store's journal (EventLog), logs it, and — for
 * warnings/errors flagged `alert` — pings the merchant (e-mail / Telegram).
 * Never throws: observability must not break the payment path.
 */
export async function recordEvent(e: {
  storeId: string | null;
  sessionId?: string | null;
  level?: Level;
  kind: string;
  message: string;
  data?: Fields;
  alert?: boolean;
  /**
   * The error behind the entry: in the log line and forwarded to Sentry (levels warn and error), never in
   * the journal. An entry at level error without one is forwarded as a message event (fingerprint: kind).
   */
  err?: unknown;
  /** Sentry grouping of the forwarded error (e.g. [kind] for a synthetic error); default: by stack trace. */
  fingerprint?: string[];
}) {
  const level = e.level ?? "info";
  emit(level, e.kind, e.message, { storeId: e.storeId, sessionId: e.sessionId, ...e.data, ...(e.err !== undefined ? { err: e.err } : {}) }, false);
  // Optional external error tracking (SENTRY_DSN): money-path failures and every error entry. Never throws.
  const ctx = logContext();
  if (e.err !== undefined && level !== "info") forwardLoggedError(e.kind, e.err, ctx, { level: level === "warn" ? "warning" : "error", fingerprint: e.fingerprint });
  else if (level === "error") forwardLoggedMessage(e.kind, e.message, ctx);
  try {
    await db.eventLog.create({
      data: {
        storeId: e.storeId,
        sessionId: e.sessionId ?? null,
        level,
        kind: e.kind,
        message: e.message.slice(0, 2000),
        data: (JSON.parse(JSON.stringify({ ...logContext(), ...e.data })) as Prisma.InputJsonValue) ?? undefined,
      },
    });
  } catch (err) {
    emit("error", "eventlog.write_failed", "Could not write the event log", { err });
  }
  if (e.alert && e.storeId) {
    try {
      if (await claimAlertSlot(e.storeId, e.kind)) {
        // Outbox first: an alert survives a function killed mid-send (the tick retries it).
        let outboxId: string | null = null;
        try {
          outboxId = (
            await db.alertOutbox.create({
              // Due a minute in the past: the claim compares with the database's now(), and an
              // app clock ahead of it must not make a fresh alert look "not yet due".
              data: { storeId: e.storeId, sessionId: e.sessionId ?? null, kind: e.kind, message: e.message.slice(0, 2000), nextAttemptAt: dueNow() },
              select: { id: true },
            })
          ).id;
        } catch (err) {
          emit("error", "alert.outbox_failed", "Could not queue the alert, sending directly", { err });
        }
        const storeId = e.storeId;
        const deliver = outboxId
          ? async () => {
              const r = await deliverAlert(outboxId!);
              // Leased by another run (the tick): it sends it; nothing lost, but say so.
              if (r === "not_claimed") emit("info", "alert.not_claimed", "Queued alert already being delivered elsewhere", { storeId, kind: e.kind, outboxId });
            }
          : () => sendAlert(storeId, e.message, e.sessionId ?? null);
        if (!defer("alert.deliver", deliver)) await deliver();
      } else await noteGrouped(e.storeId, e.kind);
    } catch (err) {
      emit("error", "alert.failed", "Could not send the alert", { err });
    }
  }
}

/**
 * A throttled alert isn't lost: it's counted, and a digest ("+N of this kind") is sent
 * once the grouping window closes.
 */
async function noteGrouped(storeId: string, kind: string) {
  const key = `alert-grouped:${storeId}:${kind}`;
  await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${key}, '1', now())
    ON CONFLICT ("key") DO UPDATE SET "value" = ("AppSetting"."value"::int + 1)::text, "updatedAt" = now()`;
  emit("info", "alert.throttled", "Alert grouped with a recent one of the same kind", { storeId, kind });
}

/** A due date safely in the past for the database clock (the app and database clocks may differ). */
function dueNow(): Date {
  return new Date(Date.now() - 60_000);
}

export type DeliverResult = "sent" | "failed" | "not_claimed";

/**
 * Delivers one queued alert; on failure schedules a retry. Never throws.
 * "not_claimed": already sent, or leased by another run (it isn't sent here).
 */
export async function deliverAlert(id: string): Promise<DeliverResult> {
  // Lease: the post-response delivery and the tick's retry can't both send it.
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE "AlertOutbox" SET "nextAttemptAt" = now() + interval '2 minutes'
    WHERE id = ${id} AND "sentAt" IS NULL AND "nextAttemptAt" <= now()
    RETURNING id`;
  if (!claimed.length) return "not_claimed";
  const a = await db.alertOutbox.findUnique({ where: { id } });
  if (!a || a.sentAt) return "not_claimed";
  try {
    const sent = await sendAlert(a.storeId, a.message, a.sessionId);
    await db.alertOutbox.update({ where: { id }, data: { sentAt: new Date(), attempts: { increment: 1 }, lastError: null } });
    // Partly delivered (e.g. Telegram ok, e-mail down): delivered, but report the broken channel.
    if (sent?.failed.length) emit("warn", "alert.channel_failed", `Alert not delivered on ${sent.failed.join(", ")}`, { storeId: a.storeId, kind: a.kind, delivered: sent.delivered });
    return "sent";
  } catch (err) {
    const attempts = a.attempts + 1;
    const delay = OUTBOX_BACKOFF_MINUTES[attempts - 1];
    await db.alertOutbox
      .update({
        where: { id },
        data: { attempts, lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500), nextAttemptAt: new Date(Date.now() + (delay ?? 0) * 60_000) },
      })
      .catch(() => undefined);
    emit(delay == null ? "error" : "warn", delay == null ? "alert.gave_up" : "alert.undelivered", `Alert not delivered (try ${attempts})`, { storeId: a.storeId, kind: a.kind, err });
    return "failed";
  }
}

/** Kinds that must always ping: each one needs its own action from the merchant. */
const NEVER_THROTTLED = new Set([
  // Deduplicated at the source (per campaign/day, per day, per week).
  "analytics.stoploss",
  "analytics.no_sales",
  "analytics.failed_spike",
  "analytics.dispute_rate",
  "review.hold",
  "payment.duplicate",
  "dispute.created",
  "dispute_alert.created",
  "dispute_alert.refunded",
  "refund.unreadable",
  "sync.gave_up",
  "upsell.gave_up",
  "webhook.stale_claim",
  "dispute.evidence_gave_up",
  "dispute.lost",
  "dispute.second",
  "refund.mirror_gave_up",
  "webhook.gave_up",
  "payment.unknown_session",
  // Hand-linked orders: each refund/dispute needs its own manual report in Shopify.
  "refund.manual_order",
  "dispute.manual_order",
  "refund.pending_expired",
  // Once a day per store at most (deduped upstream): never grouped away.
  "analytics.anomaly",
  "report.daily",
  // Throttled at the source (one per provider per hour, one per 6 h).
  "provider.degraded",
  "tick.job_starved",
]);
const ALERT_WINDOW_MS = 15 * 60_000;

/**
 * At most one alert per store and kind every 15 minutes (a Shopify outage must not
 * send one message per order). Everything stays in the journal regardless.
 */
async function claimAlertSlot(storeId: string, kind: string): Promise<boolean> {
  if (NEVER_THROTTLED.has(kind)) return true;
  const key = `alert:${storeId}:${kind}`;
  const now = new Date().toISOString();
  const cutoff = new Date(Date.now() - ALERT_WINDOW_MS).toISOString();
  const claimed = await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${key}, ${now}, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
    WHERE "AppSetting"."value" < ${cutoff}`;
  return claimed > 0;
}


/** Same as deadline.ts's notePartial (log.ts can't import it: deadline.ts reads the log context). */
function notePartialRun() {
  const holder = logContext().tickPartial as { partial?: boolean } | undefined;
  if (holder && typeof holder === "object") holder.partial = true;
}

export const OUTBOX_BACKOFF_MINUTES = [2, 10, 30, 120];
export const OUTBOX_MAX_ATTEMPTS = OUTBOX_BACKOFF_MINUTES.length + 1;

/** Retries queued alerts (every channel failed, or the send was cut short), then sends digests of grouped ones. */
export async function deliverPendingAlerts(deadline: number): Promise<number> {
  const due = await db.alertOutbox.findMany({
    where: { sentAt: null, attempts: { lt: OUTBOX_MAX_ATTEMPTS }, nextAttemptAt: { lte: new Date() } },
    orderBy: { createdAt: "asc" },
    select: { id: true },
    take: 20,
  });
  let sent = 0;
  for (const a of due) {
    if (Date.now() > deadline) {
      notePartialRun();
      break;
    }
    if ((await deliverAlert(a.id)) === "sent") sent++;
  }
  // Digests: "+N alerts of this kind" once the 15-minute window has closed.
  const grouped = await db.appSetting.findMany({ where: { key: { startsWith: "alert-grouped:" } } });
  for (const g of grouped) {
    if (Date.now() > deadline) {
      notePartialRun();
      break;
    }
    const [, storeId, kind] = g.key.split(":");
    const slot = await db.appSetting.findUnique({ where: { key: `alert:${storeId}:${kind}` } });
    if (slot && Date.now() - new Date(slot.value).getTime() < ALERT_WINDOW_MS) continue;
    // Read-and-delete in one statement: increments arriving meanwhile start a new count.
    const taken = await db.$queryRaw<{ value: string }[]>`DELETE FROM "AppSetting" WHERE key = ${g.key} RETURNING value`;
    const count = Number(taken[0]?.value) || 0;
    if (!count || !(await db.store.findUnique({ where: { id: storeId }, select: { id: true } }))) continue;
    const row = await db.alertOutbox.create({
      data: { storeId, kind: `${kind}.digest`, message: `+${count} autre(s) alerte(s) « ${kind} » ces dernières minutes : détail dans le journal.`, nextAttemptAt: dueNow() },
      select: { id: true },
    });
    if ((await deliverAlert(row.id)) === "sent") sent++;
  }
  return sent;
}
