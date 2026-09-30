import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Team access review fixes on store actions, against a real Postgres through the real session code
 * (cookie jar faked): the checkout-domain conflict names the other store only to a user who may open
 * it; « Mettre à jour le webhook » (Whop, with the owner's API key) is the owner's; a clone copies the
 * Resend / Telegram keys only when the owner makes it. Test data is prefixed sar_ and deleted at the end.
 */

const hasDb = !!process.env.DATABASE_URL;

class Redirect extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

const jar = vi.hoisted(() => new Map<string, string>());
const reqHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", async (orig) => ({
  ...(await orig<typeof import("next/headers")>()),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => reqHeaders.current,
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));
async function redirectOf(run: () => Promise<unknown>): Promise<{ path: string; search: URLSearchParams; ok?: string; error?: string }> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Redirect)) throw err;
    const u = new URL(err.url, "http://x");
    return { path: u.pathname, search: u.searchParams, ok: u.searchParams.get("ok") ?? undefined, error: u.searchParams.get("error") ?? undefined };
  }
  throw new Error("no redirect");
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

describe.skipIf(!hasDb)("store access review fixes (integration)", async () => {
  const { db } = await import("@/lib/db");
  const auth = await import("@/lib/auth");
  const access = await import("@/lib/access");
  const actions = await import("@/app/dashboard/actions");
  const tag = `sar_${Math.random().toString(36).slice(2, 8)}`;
  const stores: string[] = [];
  const users: string[] = [];

  async function store(data: Record<string, unknown> = {}) {
    const s = await db.store.create({ data: { name: `${tag}_store_${stores.length}`, ...data } });
    stores.push(s.id);
    return s;
  }
  async function user(role: "owner" | "admin" | "viewer", data: Record<string, unknown> = {}) {
    const u = await db.adminUser.create({ data: { email: `${tag}_${role}_${users.length}@test.local`, passwordHash: null, role, ...data } });
    users.push(u.id);
    return u;
  }
  /** A user limited to `storeIds`. */
  async function limited(role: "owner" | "admin" | "viewer", storeIds: string[]) {
    return user(role, { allStores: false, storeAccess: { create: storeIds.map((storeId) => ({ storeId })) } });
  }
  async function as(id: string) {
    jar.clear();
    expect(await auth.signIn(id)).toBe(true);
  }

  beforeEach(() => {
    jar.clear();
    reqHeaders.current = new Headers();
  });

  afterAll(async () => {
    await db.store.deleteMany({ where: { OR: [{ id: { in: stores } }, { name: { startsWith: tag } }] } });
    await db.adminUser.deleteMany({ where: { id: { in: users } } });
  });

  describe("checkout domain taken by another store: its name only for users who may open it", () => {
    const domain = () => `pay-${Math.random().toString(36).slice(2, 8)}.${tag.replace("_", "-")}.example.com`;

    it("a user limited to other stores gets the generic message, nothing saved", async () => {
      const d = domain();
      const [mine, other] = [await store(), await store()];
      await db.store.update({ where: { id: other.id }, data: { checkoutDomain: d } });
      await as((await limited("admin", [mine.id])).id);
      const r = await redirectOf(() => actions.saveCheckoutDomainAction(mine.id, form({ checkoutDomain: d })));
      expect(r).toMatchObject({ path: `/dashboard/stores/${mine.id}/settings`, error: "Ce domaine est déjà utilisé par une autre boutique." });
      expect(r.search.get("field")).toBe("checkoutDomain");
      expect(r.error).not.toContain(other.name);
      expect((await db.store.findUniqueOrThrow({ where: { id: mine.id } })).checkoutDomain).toBeNull();
    });

    it("named for a user with every store, and for a limited user who may open that store", async () => {
      const d = domain();
      const [mine, other] = [await store(), await store()];
      await db.store.update({ where: { id: other.id }, data: { checkoutDomain: d } });
      await as((await user("admin")).id);
      expect((await redirectOf(() => actions.saveCheckoutDomainAction(mine.id, form({ checkoutDomain: d })))).error).toBe(`${d} est déjà le domaine du checkout de la boutique « ${other.name} ».`);
      await as((await limited("admin", [mine.id, other.id])).id);
      expect((await redirectOf(() => actions.saveCheckoutDomainAction(mine.id, form({ checkoutDomain: d })))).error).toContain(`« ${other.name} »`);
      expect((await db.store.findUniqueOrThrow({ where: { id: mine.id } })).checkoutDomain).toBeNull();
    });
  });

  describe("« Mettre à jour le webhook » Whop: owner only", () => {
    it("admin (every store): refused, webhook and secret untouched", async () => {
      const s = await store({ whopConnectedAt: new Date(), whopApiKey: "enc", whopWebhookId: "hook_1", whopWebhookSecret: "sec_1" });
      await as((await user("admin")).id);
      reqHeaders.current = new Headers({ referer: `http://localhost/dashboard/stores/${s.id}/whop` });
      expect(await redirectOf(() => actions.refreshWhopWebhookAction(s.id))).toMatchObject({ path: `/dashboard/stores/${s.id}/whop`, error: "owner_only" });
      expect(access.storeRefusalCode("owner")).toBe("owner_only");
      expect(await db.store.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ whopApiKey: "enc", whopWebhookId: "hook_1", whopWebhookSecret: "sec_1" });
    });

    it("owner: allowed past the access check", async () => {
      const s = await store();
      await as((await user("owner")).id);
      expect(await redirectOf(() => actions.refreshWhopWebhookAction(s.id))).toMatchObject({ path: `/dashboard/stores/${s.id}/whop`, error: "Connectez Whop d'abord" });
    });
  });

  describe("cloneStoreAction: Resend / Telegram keys copied only by the owner", () => {
    const secrets = { alertEmail: "ops@test.local", emailFrom: "shop@test.local", resendApiKey: "enc-resend", telegramBotToken: "enc-telegram", telegramChatId: "42" };
    const copyOf = async (sourceId: string) => {
      const r = await redirectOf(() => actions.cloneStoreAction(sourceId));
      const id = r.path.split("/")[3];
      expect(id).toBeTruthy();
      expect(id).not.toBe(sourceId);
      stores.push(id);
      return db.store.findUniqueOrThrow({ where: { id } });
    };

    it("admin: addresses and chat copied, keys left out (the source keeps them)", async () => {
      const s = await store(secrets);
      await as((await limited("admin", [s.id])).id);
      const copy = await copyOf(s.id);
      expect(copy).toMatchObject({ alertEmail: "ops@test.local", emailFrom: "shop@test.local", telegramChatId: "42", resendApiKey: null, telegramBotToken: null });
      expect(await db.store.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ resendApiKey: "enc-resend", telegramBotToken: "enc-telegram" });
      const ev = await db.eventLog.findFirst({ where: { storeId: copy.id, kind: "store.cloned_from" } });
      expect(ev?.message).toMatch(/sans les clés Resend et Telegram/);
    });

    it("owner: keys copied too", async () => {
      const s = await store(secrets);
      await as((await user("owner")).id);
      const copy = await copyOf(s.id);
      expect(copy).toMatchObject({ resendApiKey: "enc-resend", telegramBotToken: "enc-telegram", telegramChatId: "42" });
    });
  });
});
