import "server-only";
import { db } from "./db";
import { log } from "./log";

/**
 * Fixed-window rate limiting for the public endpoints (quote, prepare, pay, session
 * creation, login). A per-instance memory check absorbs bursts for free; the shared
 * Postgres counter makes the limit hold across every serverless instance.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

function memoryHit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  if (buckets.size > 10_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

/** Returns true when the call is allowed. Fails open if the database is unreachable. */
export async function rateLimit(key: string, limit: number, windowMs = 60_000): Promise<boolean> {
  if (!memoryHit(key, limit, windowMs)) return false;
  try {
    // The window is computed by Postgres itself, in UTC, whatever the session time zone.
    const seconds = Math.ceil(windowMs / 1000);
    const rows = await db.$queryRaw<{ count: number }[]>`
      INSERT INTO "RateLimit" ("key", "count", "resetAt")
      VALUES (${key}, 1, (now() AT TIME ZONE 'UTC') + make_interval(secs => ${seconds}))
      ON CONFLICT ("key") DO UPDATE SET
        "count" = CASE WHEN "RateLimit"."resetAt" <= (now() AT TIME ZONE 'UTC') THEN 1 ELSE "RateLimit"."count" + 1 END,
        "resetAt" = CASE WHEN "RateLimit"."resetAt" <= (now() AT TIME ZONE 'UTC') THEN EXCLUDED."resetAt" ELSE "RateLimit"."resetAt" END
      RETURNING "count"`;
    return (rows[0]?.count ?? 0) <= limit;
  } catch (err) {
    log.warn("ratelimit.db_failed", "Shared rate limit unavailable, using memory only", { err });
    return true;
  }
}

export function clientIp(req: Request | Headers): string {
  const h = req instanceof Headers ? req : req.headers;
  const fwd = h.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}
