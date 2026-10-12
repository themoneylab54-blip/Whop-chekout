import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * rateLimitReached against a real Postgres: a shared row another instance wrote (6 h left) is found
 * reached, then answered from this instance's memory for the whole window Postgres reports (the row
 * deleted meanwhile), and asked again only once that window is over — the SQL's window (its type and
 * its units, milliseconds) end to end. Only the browser's clock is faked (Postgres keeps its own).
 */

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("rateLimitReached (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { rateLimitReached } = await import("@/lib/ratelimit");
  const key = `rlr_${Math.random().toString(36).slice(2, 10)}`;
  afterAll(async () => {
    vi.useRealTimers();
    await db.rateLimit.deleteMany({ where: { key } });
  });

  it("a shared count reached: kept in memory for the window Postgres reports, asked again after it", async () => {
    await db.$executeRaw`INSERT INTO "RateLimit" ("key", "count", "resetAt") VALUES (${key}, 1, (now() AT TIME ZONE 'UTC') + make_interval(secs => 21600))`;
    const t0 = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: t0 });
    expect(await rateLimitReached(key, 1)).toBe(true);
    await db.rateLimit.deleteMany({ where: { key } });
    // From memory now (the row is gone): reached until the window's end, not before.
    expect(await rateLimitReached(key, 1)).toBe(true);
    vi.setSystemTime(t0 + 21_600_000 - 60_000);
    expect(await rateLimitReached(key, 1)).toBe(true);
    vi.setSystemTime(t0 + 21_600_000 + 60_000);
    expect(await rateLimitReached(key, 1)).toBe(false);
  });
});
