import "server-only";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { sendAlert } from "./notify";

type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

/** One JSON line per log: searchable in Vercel's log explorer (filter on kind, sessionId…). */
function emit(level: Level, kind: string, message: string, fields: Fields = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, kind, message, ...fields }, (_k, v) =>
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
        data: e.data ? (JSON.parse(JSON.stringify(e.data)) as Prisma.InputJsonValue) : undefined,
      },
    });
  } catch (err) {
    emit("error", "eventlog.write_failed", "Could not write the event log", { err });
  }
  if (e.alert && e.storeId) {
    try {
      await sendAlert(e.storeId, e.message, e.sessionId ?? null);
    } catch (err) {
      emit("error", "alert.failed", "Could not send the alert", { err });
    }
  }
}
