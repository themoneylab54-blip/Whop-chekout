import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { storeFlashMessage } from "@/lib/team-rules";

/*
 * Team access against a real Postgres, through the real session code (cookie jar faked): session
 * revocation (sessionVersion, disabled user), the store scope (allStores vs StoreAccess), viewers
 * refused on edits, admins refused on owner-only actions (payment connections, API keys), store
 * creation granting access to a limited creator, setup creating the owner and the migration's data
 * step. Test data is prefixed team_ and deleted at the end.
 */

const hasDb = !!process.env.DATABASE_URL;

/** Shaped like Next's redirect error. */
class Redirect extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

/** The browser's cookies (one browser at a time). */
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async (orig) => ({
  ...(await orig<typeof import("next/headers")>()),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));

/** Where an action redirected to (path + flash). */
async function redirectOf(run: () => Promise<unknown>): Promise<{ path: string; ok?: string; error?: string }> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Redirect)) throw err;
    const u = new URL(err.url, "http://x");
    return { path: u.pathname, ok: u.searchParams.get("ok") ?? undefined, error: u.searchParams.get("error") ?? undefined };
  }
  throw new Error("no redirect");
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

describe.skipIf(!hasDb)("team access (integration)", async () => {
  const { db } = await import("@/lib/db");
  const auth = await import("@/lib/auth");
  const access = await import("@/lib/access");
  const actions = await import("@/app/dashboard/actions");
  const tag = `team_${Math.random().toString(36).slice(2, 8)}`;
  const stores: string[] = [];
  const users: string[] = [];

  async function store(data: Record<string, unknown> = {}) {
    const s = await db.store.create({ data: { name: `${tag}_store`, ...data } });
    stores.push(s.id);
    return s;
  }
  async function user(role: "owner" | "admin" | "viewer", data: Record<string, unknown> = {}) {
    const u = await db.adminUser.create({ data: { email: `${tag}_${role}_${users.length}@test.local`, passwordHash: await auth.hashPassword("secret-password"), role, ...data } });
    users.push(u.id);
    return u;
  }
  /** Signs `id` in on the faked browser. */
  async function as(id: string) {
    jar.clear();
    expect(await auth.signIn(id)).toBe(true);
  }

  beforeEach(() => jar.clear());

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: stores } } });
    await db.adminUser.deleteMany({ where: { id: { in: users } } });
  });

  describe("sessions", () => {
    it("sign in → current user; lastLoginAt recorded", async () => {
      const u = await user("admin");
      await as(u.id);
      expect(await auth.currentUser()).toMatchObject({ id: u.id, role: "admin", allStores: true, hasPassword: true, googleLinked: false });
      expect(await auth.requireAdmin()).toBe(u.id);
      expect((await db.adminUser.findUniqueOrThrow({ where: { id: u.id } })).lastLoginAt).toBeInstanceOf(Date);
    });

    it("a bumped session version signs every earlier cookie out (stale sv refused)", async () => {
      const u = await user("admin");
      await as(u.id);
      const stale = jar.get("wc_session");
      expect(await auth.bumpSessionVersion(u.id)).toBe(1);
      expect(await auth.currentUser()).toBeNull();
      expect(await redirectOf(() => auth.requireAdmin())).toMatchObject({ path: "/login" });
      // Signing in again issues a cookie for the new version; the old one stays refused.
      await as(u.id);
      expect((await auth.currentUser())?.id).toBe(u.id);
      expect(await auth.sessionUser(await auth.readSession(stale))).toBeNull();
    });

    it("a disabled user is refused, cookie or password", async () => {
      const u = await user("admin");
      await as(u.id);
      await db.adminUser.update({ where: { id: u.id }, data: { disabledAt: new Date() } });
      expect(await auth.currentUser()).toBeNull();
      expect(await auth.signIn(u.id)).toBe(false);
      expect(await auth.login(u.email, "secret-password")).toBe(false);
    });

    it("password login: right password only; a Google-only account (no password) can't", async () => {
      const u = await user("viewer");
      expect(await auth.login(u.email, "wrong-password")).toBe(false);
      expect(await auth.login(u.email.toUpperCase(), "secret-password")).toBe(true);
      const google = await user("viewer", { passwordHash: null, googleSub: `${tag}_sub` });
      expect(await auth.login(google.email, "")).toBe(false);
    });

    it("password login is limited per (e-mail, IP): past the limit even the right password is refused from that IP — not from another one", async () => {
      const u = await user("viewer");
      // Unique per run (the shared limiter's rows outlive the test).
      const ip = `${tag}-ip-a`;
      for (let i = 0; i < auth.LOGIN_EMAIL_IP_LIMIT.limit; i++) expect(await auth.loginWithPassword(u.email, "wrong-password", ip)).toEqual({ ok: false, reason: "invalid" });
      expect(await auth.loginWithPassword(u.email.toUpperCase(), "secret-password", ip)).toEqual({ ok: false, reason: "rate" });
      // Someone else's failed attempts don't lock the member out: from its own IP it still signs in.
      expect(await auth.loginWithPassword(u.email, "secret-password", `${tag}-ip-b`)).toMatchObject({ ok: true });
      // Another address isn't affected; the limiter's keys never hold the e-mail nor the IP.
      const other = await user("viewer");
      expect(await auth.loginWithPassword(other.email, "secret-password", ip)).toMatchObject({ ok: true });
      expect(await db.rateLimit.count({ where: { OR: [{ key: { contains: u.email } }, { key: { contains: ip } }] } })).toBe(0);
      // 13 bcrypt comparisons at cost 12: more than the default 5 s on a slow machine.
    }, 30_000);

    it("…with a much higher per-e-mail ceiling, whatever the IP (10 per 15 min per IP, 100 per 15 min in all)", async () => {
      expect(auth.LOGIN_EMAIL_IP_LIMIT).toEqual({ limit: 10, windowMs: 15 * 60_000 });
      expect(auth.LOGIN_EMAIL_LIMIT).toEqual({ limit: 100, windowMs: 15 * 60_000 });
      const u = await user("viewer");
      // 100 attempts spread over many IPs already counted for this e-mail.
      const { email: key } = auth.loginLimitKeys(u.email, "any");
      await db.rateLimit.create({ data: { key, count: auth.LOGIN_EMAIL_LIMIT.limit, resetAt: new Date(Date.now() + 10 * 60_000) } });
      expect(await auth.loginWithPassword(u.email, "secret-password", `${tag}-ip-c`)).toEqual({ ok: false, reason: "rate" });
      await db.rateLimit.delete({ where: { key } });
    });

    it("current-password checks of a signed-in member: 10 per 15 minutes", async () => {
      expect(auth.ACCOUNT_PASSWORD_LIMIT).toEqual({ limit: 10, windowMs: 15 * 60_000 });
      const u = await user("admin");
      for (let i = 0; i < 10; i++) expect(await auth.accountPasswordAllowed(u.id)).toBe(true);
      expect(await auth.accountPasswordAllowed(u.id)).toBe(false);
      const row = await db.rateLimit.findUniqueOrThrow({ where: { key: `account-password:${u.id}` } });
      expect(row.resetAt.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);
    });

    it("a cookie from before session versions (no sv) is refused, even for an account still at version 0", async () => {
      const u = await user("admin");
      expect(u.sessionVersion).toBe(0);
      const { SignJWT } = await import("jose");
      const legacy = await new SignJWT({ sub: u.id }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode("test"));
      expect(await auth.readSession(legacy)).toBeNull();
      const odd = await new SignJWT({ sub: u.id, sv: "0" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode("test"));
      expect(await auth.readSession(odd)).toBeNull();
      // A current cookie still works.
      expect((await auth.sessionUser(await auth.readSession(await auth.signSession(u.id, 0))))?.id).toBe(u.id);
    });
  });

  describe("store scope", () => {
    it("allStores sees every store; a limited user only its StoreAccess stores (others look missing)", async () => {
      const [a, b] = [await store(), await store()];
      const limited = await user("admin", { allStores: false, storeAccess: { create: { storeId: a.id } } });
      const everyone = await user("viewer");
      const mine = (u: { id: string; allStores: boolean }) =>
        db.store.findMany({ where: { AND: [access.accessibleStoreWhere(u), { id: { in: [a.id, b.id] } }] }, select: { id: true } }).then((r) => r.map((s) => s.id).sort());
      expect(await mine(limited)).toEqual([a.id]);
      expect(await mine(everyone)).toEqual([a.id, b.id].sort());
      expect(await access.canAccessStore(limited, a.id)).toBe(true);
      expect(await access.canAccessStore(limited, b.id)).toBe(false);

      await as(limited.id);
      expect((await access.requireStoreAccess(a.id, "edit")).store.id).toBe(a.id);
      expect(await redirectOf(() => access.requireStoreAccess(b.id, "view"))).toMatchObject({ path: "/dashboard" });
      expect(await access.checkStoreAccess(b.id, "view")).toMatchObject({ ok: false, reason: "notFound" });
      // Its actions on the other store are refused too.
      expect(await redirectOf(() => actions.setEnabledAction(b.id, false))).toMatchObject({ path: "/dashboard" });
    });

    it("signed out: /login", async () => {
      const s = await store();
      expect(await access.checkStoreAccess(s.id, "view")).toMatchObject({ ok: false, reason: "login" });
      expect(await redirectOf(() => actions.setEnabledAction(s.id, false))).toMatchObject({ path: "/login" });
    });
  });

  describe("roles on actions", () => {
    it("a viewer opens the store but every edit is refused (nothing saved)", async () => {
      const s = await store({ enabled: true });
      const viewer = await user("viewer");
      await as(viewer.id);
      expect((await access.requireStoreAccess(s.id, "view")).store.id).toBe(s.id);
      const refused = await redirectOf(() => actions.setEnabledAction(s.id, false));
      // A code in the URL (the store pages show its fixed text), never the text itself.
      expect(refused).toMatchObject({ path: `/dashboard/stores/${s.id}`, error: "read_only" });
      expect(storeFlashMessage(refused.error)).toBe(access.READ_ONLY_ERROR);
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).enabled).toBe(true);
      expect(await redirectOf(() => actions.createDiscountAction(s.id, form({ code: `${tag}_code`, type: "PERCENT", value: "10" })))).toMatchObject({ error: "read_only" });
      expect(await db.discountCode.count({ where: { storeId: s.id } })).toBe(0);
      // Nor can it create a store.
      // /dashboard gets a code (its fixed text is shown there), never the text itself.
      expect(await redirectOf(() => actions.createStoreAction(form({ name: `${tag}_viewer` })))).toMatchObject({ path: "/dashboard", error: "create_store" });
      expect(await db.store.count({ where: { name: `${tag}_viewer` } })).toBe(0);
    });

    it("an admin edits but is refused owner actions: payment / platform connections, API keys, deletion", async () => {
      const connectedAt = new Date();
      const s = await store({ shopifyConnectedAt: connectedAt, shopDomain: `${tag}.myshopify.com` });
      const admin = await user("admin");
      await as(admin.id);
      expect(await redirectOf(() => actions.disconnectShopifyAction(s.id))).toMatchObject({ path: `/dashboard/stores/${s.id}`, error: "owner_only" });
      expect(storeFlashMessage("owner_only")).toBe(access.OWNER_ONLY_ERROR);
      expect(await redirectOf(() => actions.connectWhopAction(s.id, form({ apiKey: "whop_key" })))).toMatchObject({ error: "owner_only" });
      expect(await redirectOf(() => actions.disconnectStripeAction(s.id))).toMatchObject({ error: "owner_only" });
      expect(await redirectOf(() => actions.deleteStoreAction(s.id))).toMatchObject({ error: "owner_only" });
      const after = await db.store.findUniqueOrThrow({ where: { id: s.id } });
      expect(after.shopifyConnectedAt?.getTime()).toBe(connectedAt.getTime());
      expect(after.whopApiKey).toBeNull();

      // Pixels: the IDs save, an access token is the owner's.
      expect(await redirectOf(() => actions.saveTrackingAction(s.id, form({ metaPixelId: "123456789", metaAccessToken: "EAAB-token" })))).toMatchObject({ error: /propriétaire/ });
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).metaAccessToken).toBeNull();
      expect(await redirectOf(() => actions.saveTrackingAction(s.id, form({ metaPixelId: "123456789" })))).toMatchObject({ ok: "Pixels enregistrés" });
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).metaPixelId).toBe("123456789");

      // An owner may.
      const owner = await user("owner");
      await as(owner.id);
      expect(await redirectOf(() => actions.saveTrackingAction(s.id, form({ metaPixelId: "123456789", metaAccessToken: "EAAB-token" })))).toMatchObject({ ok: "Pixels enregistrés" });
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).metaAccessToken).not.toBeNull();
    });

    it("createStoreAction: a limited admin gets access to the store it creates; an allStores admin needs no row", async () => {
      const limited = await user("admin", { allStores: false });
      await as(limited.id);
      const res = await redirectOf(() => actions.createStoreAction(form({ name: `${tag}_limited` })));
      const created = await db.store.findFirstOrThrow({ where: { name: `${tag}_limited` } });
      stores.push(created.id);
      expect(res.path).toBe(`/dashboard/stores/${created.id}/shopify`);
      expect(await db.storeAccess.findMany({ where: { storeId: created.id } })).toEqual([{ userId: limited.id, storeId: created.id }]);
      expect(await access.canAccessStore(limited, created.id)).toBe(true);

      const full = await user("admin");
      await as(full.id);
      await redirectOf(() => actions.createStoreAction(form({ name: `${tag}_full` })));
      const other = await db.store.findFirstOrThrow({ where: { name: `${tag}_full` } });
      stores.push(other.id);
      expect(await db.storeAccess.count({ where: { storeId: other.id } })).toBe(0);
    });
  });

  describe("owner at setup and in the migration", () => {
    it("setup creates the first account as owner (and signs it in)", async () => {
      // Setup only runs on an empty team: the accounts already there are put back afterwards.
      const { setupAction } = await import("@/app/setup/actions");
      const saved = await db.adminUser.findMany({ include: { storeAccess: true } });
      await db.adminUser.deleteMany({});
      try {
        const email = `${tag}_setup@test.local`;
        const res = await redirectOf(() => setupAction(form({ email, password: "a-long-password", confirm: "a-long-password" })));
        expect(res.path).toBe("/dashboard");
        const created = await db.adminUser.findUniqueOrThrow({ where: { email } });
        users.push(created.id);
        expect(created.role).toBe("owner");
        expect((await auth.currentUser())?.id).toBe(created.id);
      } finally {
        await db.adminUser.deleteMany({ where: { email: `${tag}_setup@test.local` } });
        for (const { storeAccess, ...u } of saved) {
          await db.adminUser.create({ data: { ...u, storeAccess: { create: storeAccess.map((a) => ({ storeId: a.storeId })) } } });
        }
      }
    });

    it("0040: every account's session version is bumped once — cookies from before versions (no sv) are dead, password sign-in still works", async () => {
      const sql = readFileSync(path.join(__dirname, "../../prisma/migrations/0040_session_version_bump/migration.sql"), "utf8");
      const step = sql.slice(sql.indexOf('UPDATE "AdminUser"')).trim();
      expect(step).toBe('UPDATE "AdminUser" SET "sessionVersion" = "sessionVersion" + 1;');
      const { SignJWT } = await import("jose");
      const rolledBack = new Error("rollback");
      let after: { a: number; b: number } | null = null;
      const a = await user("owner");
      const b = await user("admin", { sessionVersion: 3 });
      const legacy = await new SignJWT({ sub: a.id }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("1h").sign(new TextEncoder().encode("test"));
      // Refused on their own too (no `sv`), whatever the account's version.
      expect(await auth.readSession(legacy)).toBeNull();
      await db
        .$transaction(async (tx) => {
          await tx.$executeRawUnsafe(step);
          const rows = await tx.adminUser.findMany({ where: { id: { in: [a.id, b.id] } }, select: { id: true, sessionVersion: true } });
          after = { a: rows.find((r) => r.id === a.id)!.sessionVersion, b: rows.find((r) => r.id === b.id)!.sessionVersion };
          throw rolledBack;
        })
        .catch((err) => {
          if (err !== rolledBack) throw err;
        });
      expect(after).toEqual({ a: 1, b: 4 });
      // Applied for real on these two accounts: the legacy cookie is refused, a fresh sign-in works.
      await db.adminUser.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { sessionVersion: { increment: 1 } } });
      expect(await auth.sessionUser(await auth.readSession(legacy))).toBeNull();
      expect(await auth.login(a.email, "secret-password")).toBe(true);
      expect((await auth.currentUser())?.id).toBe(a.id);
    });

    it("data step: the oldest account becomes owner, the others stay admin with every store", async () => {
      const sql = readFileSync(path.join(__dirname, "../../prisma/migrations/0038_team_access/migration.sql"), "utf8");
      const step = sql.slice(sql.indexOf('UPDATE "AdminUser"')).trim();
      expect(step).toMatch(/^UPDATE "AdminUser" SET "role" = 'owner'/);
      const rolledBack = new Error("rollback");
      let roles: { email: string; role: string; allStores: boolean }[] = [];
      await db
        .$transaction(async (tx) => {
          await tx.adminUser.deleteMany({});
          const base = Date.UTC(2026, 0, 1);
          for (const [i, name] of ["second", "first", "third"].entries()) {
            await tx.adminUser.create({ data: { email: `${tag}_${name}@test.local`, createdAt: new Date(base + [1, 0, 2][i] * 60_000) } });
          }
          await tx.$executeRawUnsafe(step);
          roles = await tx.adminUser.findMany({ orderBy: { createdAt: "asc" }, select: { email: true, role: true, allStores: true } });
          throw rolledBack;
        })
        .catch((err) => {
          if (err !== rolledBack) throw err;
        });
      expect(roles).toEqual([
        { email: `${tag}_first@test.local`, role: "owner", allStores: true },
        { email: `${tag}_second@test.local`, role: "admin", allStores: true },
        { email: `${tag}_third@test.local`, role: "admin", allStores: true },
      ]);
    });
  });
});
