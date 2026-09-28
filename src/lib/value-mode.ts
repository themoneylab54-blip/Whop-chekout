import "server-only";
import { db } from "./db";
import { addDays, zonedDayStart } from "./time";

/*
 * The conversion value the ad platforms receive (Store.conversionValueMode): the order amount
 * ("revenue", ROAS bidding) or its margin HT ("profit", POAS bidding, Meta and TikTok only; Google
 * Ads and GA4 always get the revenue). Every change is kept (AppSetting `value-mode:<storeId>`) so
 * the ad spend import can record, per day, which value the platform's reported conversion value is
 * (AdSpend.valueMode): a platform "ROAS" is a POAS on the days it received margins.
 */

export type ValueMode = "revenue" | "profit";
/** A day's value mode: one of the modes, or "mixed" when it changed during that day. */
export type DayValueMode = ValueMode | "mixed";
export type ModeChange = { at: string; from: ValueMode; to: ValueMode };

const key = (storeId: string) => `value-mode:${storeId}`;
const HISTORY_MAX = 50;

export const asValueMode = (v: unknown): ValueMode => (v === "profit" ? "profit" : "revenue");

export async function valueModeHistory(storeId: string): Promise<ModeChange[]> {
  const row = await db.appSetting.findUnique({ where: { key: key(storeId) } });
  if (!row) return [];
  try {
    const list = JSON.parse(row.value) as ModeChange[];
    return Array.isArray(list) ? list.filter((c) => c && typeof c.at === "string").sort((a, b) => a.at.localeCompare(b.at)) : [];
  } catch {
    return [];
  }
}

/** Records a change of the store's value mode (no-op when unchanged). */
export async function recordValueModeChange(storeId: string, from: unknown, to: unknown, at = new Date()): Promise<void> {
  const a = asValueMode(from);
  const b = asValueMode(to);
  if (a === b) return;
  const list = [...(await valueModeHistory(storeId)), { at: at.toISOString(), from: a, to: b }].slice(-HISTORY_MAX);
  const value = JSON.stringify(list);
  await db.appSetting.upsert({ where: { key: key(storeId) }, create: { key: key(storeId), value }, update: { value } });
}

/** Mode in effect at an instant, from the changes and the current mode. Pure. */
export function modeAt(history: ModeChange[], current: ValueMode, at: number): ValueMode {
  const next = history.find((c) => Date.parse(c.at) > at);
  return next ? next.from : current;
}

/**
 * Mode of a platform's conversions on a day of the store's time zone: the mode in effect all day,
 * or "mixed" when it changed during the day. Google Ads always receives the revenue. Pure.
 */
export function dayValueMode(platform: string, day: string, history: ModeChange[], current: ValueMode, tz: string): DayValueMode {
  if (platform === "google") return "revenue";
  const start = zonedDayStart(day, tz).getTime();
  const end = zonedDayStart(addDays(day, 1), tz).getTime();
  if (history.some((c) => Date.parse(c.at) >= start && Date.parse(c.at) < end)) return "mixed";
  return modeAt(history, current, start);
}
