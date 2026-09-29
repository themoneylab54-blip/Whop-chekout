import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "./db";

/*
 * Per-provider call metrics (observability). Every external call is already logged as `ext.call`
 * (provider, status, duration); log.ts hands each one to `noteProviderCall`, which only adds it to an
 * in-memory buffer (no I/O). The buffer is written in one batched upsert per request (route()'s
 * after()), at the end of each background tick, or at most once a minute from anywhere else, into
 * ProviderMetric: one row per provider and 5-minute bucket (calls, errors, timeouts, a fixed-bucket
 * latency histogram, last success / error). A failed write is dropped: metrics never block or break
 * the money path. Health, the "Services externes" card and the provider alert read the rows.
 */

export const PROVIDER_LABELS: Record<string, string> = {
  shopify: "Shopify",
  whop: "Whop",
  stripe: "Stripe",
  meta: "Meta",
  tiktok: "TikTok",
  google_ads: "Google Ads",
  ga4: "Google Analytics 4",
  ecb: "BCE (taux de change)",
  resend: "Resend (e-mails)",
  telegram: "Telegram",
  mondial_relay: "Mondial Relay",
  judgeme: "Judge.me (avis)",
};

export const BUCKET_MS = 5 * 60_000;
/** Upper bounds (ms) of the latency histogram's buckets h0..h6; h7 counts the slower calls. */
export const LATENCY_BOUNDS = [250, 500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;
const FLUSH_EVERY_MS = 60_000;

type Agg = {
  provider: string;
  bucket: number;
  calls: number;
  errors: number;
  timeouts: number;
  totalMs: number;
  maxMs: number;
  h: number[];
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
};

const buffer = new Map<string, Agg>();
let lastFlush = Date.now();

export type CallOutcome = { error: boolean; timeout: boolean; message: string | null };

/**
 * Whether a logged call counts as an error: no answer (network, timeout), 5xx, 429 (throttled) or an
 * authentication refusal (401 / 403: the connection is broken). Other 4xx are the provider's definite
 * answer to a bad request (a 404 lookup, a validation error), not an outage. Pure.
 */
export function callOutcome(c: { status?: unknown; err?: unknown }): CallOutcome {
  if (c.err != null) {
    const e = c.err as { name?: unknown; message?: unknown; cause?: { name?: unknown; code?: unknown } };
    const text = `${String(e.name ?? "")} ${String(e.message ?? c.err)} ${String(e.cause?.name ?? "")} ${String(e.cause?.code ?? "")}`;
    const timeout = /timeout|timed out|aborted|ETIMEDOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT/i.test(text);
    return { error: true, timeout, message: scrub(String(e.message ?? c.err)) || (timeout ? "délai dépassé" : "sans réponse") };
  }
  const status = typeof c.status === "number" ? c.status : Number(c.status);
  if (!Number.isFinite(status)) return { error: false, timeout: false, message: null };
  const error = status >= 500 || status === 429 || status === 401 || status === 403;
  return { error, timeout: status === 504 || status === 408, message: error ? `HTTP ${status}` : null };
}

/** Removes what must never be stored or sent (e-mails, tokens, long ids, URLs with secrets). Pure. */
export function scrub(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, (u) => u.replace(/[?#].*$/, "").replace(/\/bot[^/]+/, "/bot…"))
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b(Bearer|Basic)\s+\S+/gi, "$1 [secret]")
    .replace(/\b(shpat|shpss|shpca|apik|sk|pk|rk|whsec|re)_[A-Za-z0-9_-]{8,}/g, "[secret]")
    .replace(/\b(access_token|api_secret|token|key|secret|password)=([^&\s]+)/gi, "$1=[secret]")
    .replace(/\b[A-Za-z0-9+/_-]{32,}={0,2}/g, "[secret]")
    // Phone and card numbers (10 to 19 digits, separators allowed); dates (8 digits) stay.
    .replace(/(?<![\d:])(?:\+?\d[ .-]?){9,18}\d(?![\d:])/g, "[nombre]")
    .trim()
    .slice(0, 300);
}

/** Histogram bucket of a duration. Pure. */
export function latencyBucket(ms: number): number {
  const i = LATENCY_BOUNDS.findIndex((b) => ms <= b);
  return i === -1 ? LATENCY_BOUNDS.length : i;
}

/**
 * Records one external call in the buffer (called by log.ts for every `ext.call` line). Cheap and
 * never throws; starts a background flush when the last one is over a minute old.
 */
export function noteProviderCall(provider: string, c: { ms?: unknown; status?: unknown; err?: unknown }, now = Date.now()): void {
  try {
    if (!provider || typeof provider !== "string") return;
    const ms = Math.max(0, Math.round(Number(c.ms) || 0));
    const outcome = callOutcome(c);
    const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;
    const key = `${provider}|${bucket}`;
    let a = buffer.get(key);
    if (!a) {
      a = { provider: provider.slice(0, 40), bucket, calls: 0, errors: 0, timeouts: 0, totalMs: 0, maxMs: 0, h: Array(LATENCY_BOUNDS.length + 1).fill(0), lastOkAt: null, lastErrorAt: null, lastError: null };
      buffer.set(key, a);
    }
    a.calls++;
    a.totalMs += ms;
    a.maxMs = Math.max(a.maxMs, ms);
    a.h[latencyBucket(ms)]++;
    if (outcome.error) {
      a.errors++;
      if (outcome.timeout) a.timeouts++;
      a.lastErrorAt = now;
      a.lastError = outcome.message;
    } else a.lastOkAt = now;
    if (now - lastFlush > FLUSH_EVERY_MS) void flushProviderMetrics();
  } catch {
    /* metrics never break a call */
  }
}

/** Buffered rows not written yet (tests). */
export function pendingProviderMetrics(): number {
  return buffer.size;
}

/**
 * Writes the buffer in one statement (upsert per provider and bucket, counters added). Never throws;
 * a failed write is dropped (the rows are observability only). Returns the rows written.
 */
export async function flushProviderMetrics(): Promise<number> {
  lastFlush = Date.now();
  if (!buffer.size) return 0;
  const rows = [...buffer.values()];
  buffer.clear();
  try {
    const values = rows.map(
      (r) => Prisma.sql`(${r.provider}, ${new Date(r.bucket)}, ${r.calls}, ${r.errors}, ${r.timeouts}, ${BigInt(r.totalMs)}, ${r.maxMs},
        ${r.h[0]}, ${r.h[1]}, ${r.h[2]}, ${r.h[3]}, ${r.h[4]}, ${r.h[5]}, ${r.h[6]}, ${r.h[7]},
        ${r.lastOkAt ? new Date(r.lastOkAt) : null}::timestamp, ${r.lastErrorAt ? new Date(r.lastErrorAt) : null}::timestamp, ${r.lastError})`,
    );
    await db.$executeRaw`
      INSERT INTO "ProviderMetric" ("provider", "bucket", "calls", "errors", "timeouts", "totalMs", "maxMs",
        "h0", "h1", "h2", "h3", "h4", "h5", "h6", "h7", "lastOkAt", "lastErrorAt", "lastError")
      VALUES ${Prisma.join(values)}
      ON CONFLICT ("provider", "bucket") DO UPDATE SET
        "calls" = "ProviderMetric"."calls" + EXCLUDED."calls",
        "errors" = "ProviderMetric"."errors" + EXCLUDED."errors",
        "timeouts" = "ProviderMetric"."timeouts" + EXCLUDED."timeouts",
        "totalMs" = "ProviderMetric"."totalMs" + EXCLUDED."totalMs",
        "maxMs" = GREATEST("ProviderMetric"."maxMs", EXCLUDED."maxMs"),
        "h0" = "ProviderMetric"."h0" + EXCLUDED."h0", "h1" = "ProviderMetric"."h1" + EXCLUDED."h1",
        "h2" = "ProviderMetric"."h2" + EXCLUDED."h2", "h3" = "ProviderMetric"."h3" + EXCLUDED."h3",
        "h4" = "ProviderMetric"."h4" + EXCLUDED."h4", "h5" = "ProviderMetric"."h5" + EXCLUDED."h5",
        "h6" = "ProviderMetric"."h6" + EXCLUDED."h6", "h7" = "ProviderMetric"."h7" + EXCLUDED."h7",
        "lastOkAt" = GREATEST("ProviderMetric"."lastOkAt", EXCLUDED."lastOkAt"),
        "lastError" = CASE WHEN EXCLUDED."lastErrorAt" IS NOT NULL AND ("ProviderMetric"."lastErrorAt" IS NULL OR EXCLUDED."lastErrorAt" >= "ProviderMetric"."lastErrorAt")
          THEN EXCLUDED."lastError" ELSE "ProviderMetric"."lastError" END,
        "lastErrorAt" = GREATEST("ProviderMetric"."lastErrorAt", EXCLUDED."lastErrorAt")`;
    return rows.length;
  } catch (err) {
    console.warn(JSON.stringify({ t: new Date().toISOString(), level: "warn", kind: "metrics.flush_failed", message: "Provider metrics dropped", rows: rows.length, err: err instanceof Error ? err.message : String(err) }));
    return 0;
  }
}

/* ---------- Reading ---------- */

export type ProviderStats = {
  provider: string;
  label: string;
  calls: number;
  errors: number;
  timeouts: number;
  /** errors / calls, null without calls. */
  errorRate: number | null;
  /** Upper bound of the histogram bucket holding the percentile (ms); null without calls. */
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number;
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
};

type Row = {
  provider: string;
  calls: number;
  errors: number;
  timeouts: number;
  maxMs: number;
  h: number[];
  lastOkAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
};

/** Latency percentile from the histogram: the upper bound of the bucket holding it (the slowest call past the last bound). Pure. */
export function percentileMs(h: number[], p: number, maxMs: number): number | null {
  const total = h.reduce((a, n) => a + n, 0);
  if (!total) return null;
  const rank = Math.ceil(total * p);
  let seen = 0;
  for (let i = 0; i < h.length; i++) {
    seen += h[i];
    // No call was slower than maxMs: a bucket's bound never overstates it.
    if (seen >= rank) return i < LATENCY_BOUNDS.length ? Math.min(LATENCY_BOUNDS[i], maxMs) : maxMs;
  }
  return maxMs;
}

/** Rolled-up rows of one provider → its stats. Pure. */
export function statsOf(provider: string, rows: Row[]): ProviderStats {
  const h = Array(LATENCY_BOUNDS.length + 1).fill(0) as number[];
  let calls = 0;
  let errors = 0;
  let timeouts = 0;
  let maxMs = 0;
  let lastOkAt: Date | null = null;
  let lastErrorAt: Date | null = null;
  let lastError: string | null = null;
  for (const r of rows) {
    calls += r.calls;
    errors += r.errors;
    timeouts += r.timeouts;
    maxMs = Math.max(maxMs, r.maxMs);
    r.h.forEach((n, i) => (h[i] += n));
    if (r.lastOkAt && (!lastOkAt || r.lastOkAt > lastOkAt)) lastOkAt = r.lastOkAt;
    if (r.lastErrorAt && (!lastErrorAt || r.lastErrorAt > lastErrorAt)) {
      lastErrorAt = r.lastErrorAt;
      lastError = r.lastError;
    }
  }
  return {
    provider,
    label: PROVIDER_LABELS[provider] ?? provider,
    calls,
    errors,
    timeouts,
    errorRate: calls ? errors / calls : null,
    p50Ms: percentileMs(h, 0.5, maxMs),
    p95Ms: percentileMs(h, 0.95, maxMs),
    maxMs,
    lastOkAt,
    lastErrorAt,
    lastError,
  };
}

/** Per-provider stats over the last `ms` (buckets that started in the window), busiest first. */
export async function providerStats(ms: number, now = Date.now()): Promise<ProviderStats[]> {
  const since = new Date(Math.floor((now - ms) / BUCKET_MS) * BUCKET_MS);
  const rows = await db.providerMetric.findMany({ where: { bucket: { gte: since } } });
  const by = new Map<string, Row[]>();
  for (const r of rows) {
    const list = by.get(r.provider) ?? [];
    list.push({ ...r, h: [r.h0, r.h1, r.h2, r.h3, r.h4, r.h5, r.h6, r.h7] });
    by.set(r.provider, list);
  }
  return [...by.entries()].map(([p, list]) => statsOf(p, list)).sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));
}

/** A provider is degraded: error rate over 20 % on at least 10 calls, or p95 over 8 s. */
export const DEGRADED_ERROR_RATE = 0.2;
export const DEGRADED_MIN_CALLS = 10;
export const DEGRADED_P95_MS = 8_000;

/** Why a provider's last hour is degraded, or null. Pure. */
export function providerDegraded(s: Pick<ProviderStats, "calls" | "errors" | "p95Ms">): string | null {
  if (s.calls >= DEGRADED_MIN_CALLS && s.errors / s.calls > DEGRADED_ERROR_RATE) return `${Math.round((100 * s.errors) / s.calls)} % d'erreurs sur ${s.calls} appels`;
  if (s.p95Ms != null && s.p95Ms > DEGRADED_P95_MS) return `p95 ${(s.p95Ms / 1000).toFixed(1)} s`;
  return null;
}

/** Buckets older than this are purged by the tick's cleanup. */
export const METRICS_RETENTION_MS = 14 * 86_400_000;

export async function purgeProviderMetrics(now = Date.now()): Promise<number> {
  return (await db.providerMetric.deleteMany({ where: { bucket: { lt: new Date(now - METRICS_RETENTION_MS) } } })).count;
}
