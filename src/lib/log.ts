import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { sendAlert } from "./notify";

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
function emit(level: Level, kind: string, message: string, fields: Fields = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, kind, message, ...logContext(), ...fields }, (_k, v) =>
    v instanceof Error ? { name: v.name, message: v.message, stack: v.stack?.split("\n").slice(0, 5).join("\n") } : v,
  );
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
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
}) {
  const level = e.level ?? "info";
  emit(level, e.kind, e.message, { storeId: e.storeId, sessionId: e.sessionId, ...e.data });
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
        try {
          await sendAlert(e.storeId, e.message, e.sessionId ?? null);
        } catch (err) {
          // Not delivered: free the slot so the next occurrence tries again.
          await releaseAlertSlot(e.storeId, e.kind);
          throw err;
        }
      } else emit("info", "alert.throttled", "Alert grouped with a recent one of the same kind", { storeId: e.storeId, kind: e.kind });
    } catch (err) {
      emit("error", "alert.failed", "Could not send the alert", { err });
    }
  }
}

/** Kinds that must always ping: each one needs its own action from the merchant. */
const NEVER_THROTTLED = new Set([
  "review.hold",
  "payment.duplicate",
  "dispute.created",
  "dispute_alert.created",
  "dispute_alert.refunded",
  "refund.unreadable",
  "sync.gave_up",
  "upsell.gave_up",
  "webhook.stale_claim",
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

async function releaseAlertSlot(storeId: string, kind: string) {
  if (NEVER_THROTTLED.has(kind)) return;
  await db.appSetting.deleteMany({ where: { key: `alert:${storeId}:${kind}` } }).catch(() => undefined);
}
