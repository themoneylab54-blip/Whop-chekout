import "server-only";
import { extFetch } from "./ext";
import { db } from "./db";
import { log } from "./log";
import { timeLeft } from "./deadline";

/*
 * Foreign exchange: ECB daily euro reference rates (published around 16:00 CET on TARGET
 * working days). Refreshed by the background tick (every 12 h) and cached in AppSetting `fx:ecb`;
 * buyers only read that cache (never wait on the ECB). When the ECB can't be reached the last cached
 * rates are used (charge.ts refuses them past 3 days), never a made-up rate.
 * Cross rates go through EUR: amount × rate(to) ÷ rate(from).
 */

const ECB_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const CACHE_KEY = "fx:ecb";
const TTL_MS = 12 * 3600_000;
const TIMEOUT_MS = 10_000;

export type FxRates = {
  /** Reference date of the rates ("YYYY-MM-DD"). */
  date: string;
  /** Units of currency per 1 EUR (EUR = 1). */
  rates: Record<string, number>;
  fetchedAt: string;
  /** True when the ECB could not be reached and older cached rates are returned. */
  stale?: boolean;
};

/** Parses the ECB daily XML (`<Cube time="…">` and `<Cube currency="USD" rate="1.08"/>`). Pure: exported for tests. */
export function parseEcbXml(xml: string): { date: string; rates: Record<string, number> } | null {
  const date = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]/.exec(xml)?.[1];
  const rates: Record<string, number> = { EUR: 1 };
  const re = /<Cube\s+currency=['"]([A-Z]{3})['"]\s+rate=['"]([0-9.]+)['"]\s*\/?>/g;
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const r = Number(m[2]);
    if (Number.isFinite(r) && r > 0) rates[m[1]] = r;
  }
  if (!date || Object.keys(rates).length < 2) return null;
  return { date, rates };
}

/** Rate to multiply an amount in `from` by to get `to` (via EUR), or null when a currency is unknown. Pure. */
export function crossRate(from: string, to: string, rates: Record<string, number>): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return 1;
  const rf = rates[f];
  const rt = rates[t];
  if (!rf || !rt) return null;
  return rt / rf;
}

/** Converts cents between currencies (rounded to the cent), or null without a rate. Pure. */
export function convertCents(cents: number, from: string, to: string, rates: Record<string, number>): number | null {
  const r = crossRate(from, to, rates);
  return r == null ? null : Math.round(cents * r);
}

async function readCache(): Promise<FxRates | null> {
  const row = await db.appSetting.findUnique({ where: { key: CACHE_KEY } }).catch(() => null);
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as FxRates;
    return v && typeof v.rates === "object" ? v : null;
  } catch {
    return null;
  }
}

const ATTEMPT_KEY = "fx:ecb:attempt";
/** After a failed ECB fetch, no new attempt before this (the tick retries; buyers never wait on it). */
export const FX_FAILURE_BACKOFF_MS = 15 * 60_000;
/** The only wait a buyer can see: no cached rates at all (first use), once per backoff. */
const BUYER_WAIT_MS = 1_500;
let lastBuyerAttempt = 0;

/** Tests: forget the per-instance throttle of the buyer's one-time wait. */
export function resetFxThrottle() {
  lastBuyerAttempt = 0;
}

export type FxAttempt = { at: string; ok: boolean; error?: string };

export async function lastFxAttempt(): Promise<FxAttempt | null> {
  const row = await db.appSetting.findUnique({ where: { key: ATTEMPT_KEY } }).catch(() => null);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as FxAttempt;
  } catch {
    return null;
  }
}

async function saveAttempt(a: FxAttempt) {
  const value = JSON.stringify(a);
  await db.appSetting.upsert({ where: { key: ATTEMPT_KEY }, create: { key: ATTEMPT_KEY, value }, update: { value } }).catch(() => undefined);
}

/**
 * Fetches the ECB rates when the cache is older than 12 h (background tick; `force` = now), at
 * most once per FX_FAILURE_BACKOFF_MS after a failure (lastAttemptAt; `backoff: false` for a job
 * that is itself throttled, like the hourly ad spend import). Deadline-aware in a
 * bounded run. On failure: the last cached copy (stale) or null.
 */
export async function refreshEcbRates(opts: { force?: boolean; timeoutMs?: number; backoff?: boolean } = {}): Promise<FxRates | null> {
  const cached = await readCache();
  if (cached && !opts.force && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS) return cached;
  if (!opts.force && opts.backoff !== false) {
    const last = await lastFxAttempt();
    if (last && !last.ok && Date.now() - Date.parse(last.at) < FX_FAILURE_BACKOFF_MS) return cached ? { ...cached, stale: true } : null;
  }
  const left = timeLeft();
  if (left != null && left < 3_000) return cached ? { ...cached, stale: true } : null;
  const timeout = Math.max(500, Math.min(opts.timeoutMs ?? TIMEOUT_MS, left == null ? Infinity : left - 2_000));
  try {
    const res = await extFetch("ecb", "daily rates", ECB_URL, { signal: AbortSignal.timeout(timeout), cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const parsed = parseEcbXml(await res.text());
    if (!parsed) throw new Error("réponse BCE illisible");
    const value: FxRates = { ...parsed, fetchedAt: new Date().toISOString() };
    await db.appSetting.upsert({ where: { key: CACHE_KEY }, create: { key: CACHE_KEY, value: JSON.stringify(value) }, update: { value: JSON.stringify(value) } });
    await saveAttempt({ at: new Date().toISOString(), ok: true });
    return value;
  } catch (err) {
    log.warn("fx.fetch_failed", "ECB rates fetch failed", { err });
    await saveAttempt({ at: new Date().toISOString(), ok: false, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    return cached ? { ...cached, stale: true } : null;
  }
}

/**
 * ECB reference rates for the buyer's path (checkout, quote, thank-you page): the cached copy,
 * whatever its age (charge.ts refuses rates over 3 days old; the tick keeps them fresh). Only
 * when nothing was ever cached: one short fetch (≤ 1.5 s), at most once per backoff.
 */
export async function ecbRates(): Promise<FxRates | null> {
  const cached = await readCache();
  if (cached) return cached;
  if (Date.now() - lastBuyerAttempt < FX_FAILURE_BACKOFF_MS) return null;
  lastBuyerAttempt = Date.now();
  return refreshEcbRates({ timeoutMs: BUYER_WAIT_MS });
}

/** Cached rates without any fetch (health, tick checks). */
export function cachedEcbRates(): Promise<FxRates | null> {
  return readCache();
}
