import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * The checkout-creation claim (prepareSession's tryClaim) whatever the database session's time
 * zone: its rows are written by Prisma (UTC in a `timestamp` column) and compared by the claim, so
 * a session in Europe/Paris (ahead of UTC) never sees a live claim as stale (a second Whop
 * configuration), nor one behind UTC a stale claim as live (a crashed request never taken over).
 * One pooled connection (connection_limit=1) so `SET TIME ZONE` holds for every query. Test data: prep:tz_.
 */

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  const url = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL) : null;
  url?.searchParams.set("connection_limit", "1");
  return { db: new PrismaClient(url ? { datasourceUrl: url.toString() } : undefined) };
});

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("snapshot claim under a non-UTC database session (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { tryClaim, snapshotClaimTimings } = await import("@/lib/checkout");
  const prefix = `prep:tz_${Date.now()}_`;

  afterAll(async () => {
    await db.appSetting.deleteMany({ where: { key: { startsWith: prefix } } });
    await db.$disconnect();
  });

  for (const zone of ["Europe/Paris", "America/New_York", "Asia/Kolkata"]) {
    it(`${zone}: a live claim is never stolen, a stale one is taken over, a fresh key is claimed once`, async () => {
      await db.$executeRawUnsafe(`SET TIME ZONE '${zone}'`);
      const [{ tz }] = await db.$queryRawUnsafe<{ tz: string }[]>("SELECT current_setting('TimeZone') AS tz");
      expect(tz).toBe(zone);
      const tag = zone.replace(/\W/g, "");

      // Live: refreshed just now by its request (the heartbeat writes through Prisma).
      const live = `${prefix}${tag}_live`;
      const liveAt = new Date(Date.now() - 1_000);
      await db.appSetting.create({ data: { key: live, value: "claimed", updatedAt: liveAt } });
      expect(await tryClaim(live)).toMatchObject({ owned: false, held: false });
      expect((await db.appSetting.findUniqueOrThrow({ where: { key: live } })).updatedAt.getTime()).toBe(liveAt.getTime());

      // Stale: not refreshed past the claim's lifetime (by seconds, far less than any zone's offset).
      const stale = `${prefix}${tag}_stale`;
      await db.appSetting.create({ data: { key: stale, value: "claimed", updatedAt: new Date(Date.now() - snapshotClaimTimings.claimMs - 3_000) } });
      const before = Date.now();
      expect(await tryClaim(stale)).toMatchObject({ owned: true, held: true });
      const taken = await db.appSetting.findUniqueOrThrow({ where: { key: stale } });
      expect(Math.abs(taken.updatedAt.getTime() - before)).toBeLessThan(5_000);
      // Just taken over: live now for the next one.
      expect(await tryClaim(stale)).toMatchObject({ owned: false });
      // Too late in the request to take over: a stale claim is left alone.
      await db.appSetting.update({ where: { key: stale }, data: { updatedAt: new Date(Date.now() - snapshotClaimTimings.claimMs - 3_000) } });
      expect(await tryClaim(stale, { takeover: false })).toMatchObject({ owned: false });

      // A fresh key: claimed once, the second request finds it live.
      const fresh = `${prefix}${tag}_fresh`;
      expect(await tryClaim(fresh)).toMatchObject({ owned: true, held: true });
      expect(await tryClaim(fresh)).toMatchObject({ owned: false });
      const row = await db.appSetting.findUniqueOrThrow({ where: { key: fresh } });
      expect(Math.abs(row.updatedAt.getTime() - Date.now())).toBeLessThan(5_000);
    });
  }
});
