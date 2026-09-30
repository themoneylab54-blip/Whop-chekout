import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { STORE_ACCESS_ERRORS } from "@/lib/team-rules";

/*
 * Team access fixes on store actions, against a real Postgres through the real session code (cookie
 * jar faked): an order of another store can't be re-synced through a store the user may open (IDOR);
 * a test / production switch that resets Whop / Stripe, the account-wide Apple Pay file, the
 * platform's Stripe webhook are the owner's; the account-wide maintenance run needs every store; a
 * refused action goes back to the page it came from; tab titles don't leak other stores' names.
 * Test data is prefixed saf_ and deleted at the end.
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
// The account-wide maintenance run is observed, never run for real here.
const tick = vi.hoisted(() => ({ runs: 0 }));
vi.mock("@/lib/tick", async (orig) => ({
  ...(await orig<typeof import("@/lib/tick")>()),
  runTick: async () => {
    tick.runs++;
    return {};
  },
}));

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

describe.skipIf(!hasDb)("store access fixes (integration)", async () => {
  const { db } = await import("@/lib/db");
  const auth = await import("@/lib/auth");
  const access = await import("@/lib/access");
  const actions = await import("@/app/dashboard/actions");
  const { APPLE_PAY_ASSOCIATION_KEY } = await import("@/lib/checkout-domain-check");
  const tag = `saf_${Math.random().toString(36).slice(2, 8)}`;
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
    tick.runs = 0;
  });

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: stores } } });
    await db.adminUser.deleteMany({ where: { id: { in: users } } });
  });

  describe("resyncOrderAction: the order must be the store's (IDOR)", () => {
    it("another store's order through a store the user may open: refused, nothing touched", async () => {
      const [a, b] = [await store(), await store()];
      const other = await db.checkoutSession.create({ data: { storeId: b.id, currency: "EUR", lines: [], status: "PAID", reviewNote: "à vérifier" } });
      const admin = await limited("admin", [a.id]);
      await as(admin.id);
      const r = await redirectOf(() => actions.resyncOrderAction(a.id, other.id));
      expect(r).toMatchObject({ path: `/dashboard/stores/${a.id}/orders`, error: "Commande introuvable" });
      expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: other.id } })).reviewNote).toBe("à vérifier");
      // And through its own store: not one of the user's.
      expect(await redirectOf(() => actions.resyncOrderAction(b.id, other.id))).toMatchObject({ path: "/dashboard" });
      expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: other.id } })).reviewNote).toBe("à vérifier");
    });

    it("an owner with every store: still refused across stores (the id must match the store)", async () => {
      const [a, b] = [await store(), await store()];
      const other = await db.checkoutSession.create({ data: { storeId: b.id, currency: "EUR", lines: [], status: "PAID", reviewNote: "x" } });
      await as((await user("owner")).id);
      expect(await redirectOf(() => actions.resyncOrderAction(a.id, other.id))).toMatchObject({ error: "Commande introuvable" });
      expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: other.id } })).reviewNote).toBe("x");
    });

    it("the store's own unpaid order: reviewed note cleared, answered on the order page", async () => {
      const a = await store();
      const own = await db.checkoutSession.create({ data: { storeId: a.id, currency: "EUR", lines: [], reviewNote: "y" } });
      await as((await limited("admin", [a.id])).id);
      const r = await redirectOf(() => actions.resyncOrderAction(a.id, own.id));
      expect(r.path).toBe(`/dashboard/stores/${a.id}/orders/${own.id}`);
      expect(r.error).toBeTruthy();
      expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: own.id } })).reviewNote).toBeNull();
    });

    it("retryShopifySyncAction / markOrderHandledAction: another store's order is not found", async () => {
      const [a, b] = [await store(), await store()];
      const other = await db.checkoutSession.create({ data: { storeId: b.id, currency: "EUR", lines: [], status: "PAID" } });
      await as((await limited("admin", [a.id])).id);
      expect(await redirectOf(() => actions.retryShopifySyncAction(a.id, other.id))).toMatchObject({ error: "Commande introuvable" });
      expect((await redirectOf(() => actions.markOrderHandledAction(a.id, other.id, form({ orderName: "#1001" })))).error).toMatch(/introuvable/);
      expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: other.id } })).syncHandledAt).toBeNull();
    });
  });

  describe("test / production switch: owner only once Whop or Stripe is connected", () => {
    it("admin refused with Whop connected (keys kept), and through the save bar", async () => {
      const s = await store({ testMode: false, whopConnectedAt: new Date(), whopApiKey: "enc", whopAccountId: "biz_1" });
      await as((await user("admin")).id);
      const r = await redirectOf(() => actions.saveSettingsAction(s.id, form({ name: "Renamed", testMode: "on" })));
      expect(r.path).toBe(`/dashboard/stores/${s.id}/settings`);
      expect(r.error).toMatch(/propriétaire du compte/);
      expect(r.search.get("field")).toBe("testMode");
      const after = await db.store.findUniqueOrThrow({ where: { id: s.id } });
      expect(after).toMatchObject({ testMode: false, whopApiKey: "enc", whopAccountId: "biz_1", name: s.name });
      expect(after.whopConnectedAt).toBeInstanceOf(Date);

      const batch = form({ __section: "Boutique", "Boutique::name": "Renamed", "Boutique::testMode": "on" });
      const rb = await redirectOf(() => actions.saveSettingsBatchAction(s.id, batch));
      expect(rb.error).toMatch(/^Boutique : .*propriétaire du compte/);
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).testMode).toBe(false);
    });

    it("admin refused with Stripe connected", async () => {
      const s = await store({ testMode: true, stripeAccountId: `acct_${tag}` });
      await as((await user("admin")).id);
      expect((await redirectOf(() => actions.saveSettingsAction(s.id, form({ name: s.name })))).error).toMatch(/propriétaire du compte/);
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).testMode).toBe(true);
    });

    it("admin: other settings still saved when the mode doesn't change; a switch with nothing connected is allowed", async () => {
      const s = await store({ testMode: false, whopConnectedAt: new Date() });
      await as((await user("admin")).id);
      expect(await redirectOf(() => actions.saveSettingsAction(s.id, form({ name: `${tag}_renamed` })))).toMatchObject({ ok: "Réglages enregistrés" });
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).name).toBe(`${tag}_renamed`);
      const bare = await store({ testMode: false });
      expect(await redirectOf(() => actions.saveSettingsAction(bare.id, form({ name: bare.name, testMode: "on" })))).toMatchObject({ ok: "Réglages enregistrés" });
      expect((await db.store.findUniqueOrThrow({ where: { id: bare.id } })).testMode).toBe(true);
    });

    it("owner may switch (Stripe connected, no Whop to tear down)", async () => {
      const s = await store({ testMode: false, stripeAccountId: `acct_${tag}_o`, stripeLivemode: true });
      await as((await user("owner")).id);
      const r = await redirectOf(() => actions.saveSettingsAction(s.id, form({ name: s.name, testMode: "on" })));
      expect(r.error ?? "").not.toMatch(/propriétaire du compte/);
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).testMode).toBe(true);
    });
  });

  describe("account-wide parts", () => {
    it("Apple Pay file: refused to an admin and to an owner limited to some stores; the setting is untouched", async () => {
      const before = await db.appSetting.findUnique({ where: { key: APPLE_PAY_ASSOCIATION_KEY } });
      const s = await store({ whopConnectedAt: new Date() });
      await as((await user("admin")).id);
      const r = await redirectOf(() => actions.setupApplePayAction(s.id, form({ association: `${tag}-file` })));
      expect(r).toMatchObject({ path: `/dashboard/stores/${s.id}/whop` });
      expect(r.error).toContain(access.OWNER_ONLY_ERROR);
      await as((await limited("owner", [s.id])).id);
      expect((await redirectOf(() => actions.setupApplePayAction(s.id, form({ association: `${tag}-file` })))).error).toContain(access.OWNER_ONLY_ERROR);
      const after = await db.appSetting.findUnique({ where: { key: APPLE_PAY_ASSOCIATION_KEY } });
      expect(after?.value ?? null).toBe(before?.value ?? null);
    });

    it("« Réparer la liaison Stripe » (platform webhook): owner only", async () => {
      const s = await store({ stripeAccountId: `acct_${tag}_w` });
      await as((await user("admin")).id);
      expect(await redirectOf(() => actions.repairStripeWebhookAction(s.id))).toMatchObject({ path: `/dashboard/stores/${s.id}`, error: "owner_only" });
      // A code in the URL; the page shows its fixed text.
      expect(STORE_ACCESS_ERRORS.owner_only).toBe(access.OWNER_ONLY_ERROR);
    });

    it("« Enregistrer les domaines » stays open to admins (the store's own domains)", async () => {
      const s = await store();
      await as((await user("admin")).id);
      expect(await redirectOf(() => actions.registerStripeDomainsAction(s.id))).toMatchObject({ error: "Connectez Stripe d'abord" });
    });

    it("maintenance run: refused to a user limited to some stores, run for one with every store", async () => {
      const s = await store();
      await as((await limited("admin", [s.id])).id);
      const r = await redirectOf(() => actions.runTickAction(s.id));
      expect(r.path).toBe(`/dashboard/stores/${s.id}/journal`);
      expect(r.error).toMatch(/toutes les boutiques/);
      expect(tick.runs).toBe(0);
      await as((await user("admin")).id);
      expect((await redirectOf(() => actions.runTickAction(s.id))).ok).toMatch(/Maintenance terminée/);
      expect(tick.runs).toBe(1);
    });
  });

  describe("a refused action goes back where it was clicked", () => {
    it("viewer: back to the referring sub-page of the store (old flash dropped); another page → the overview", async () => {
      const s = await store();
      await as((await user("viewer")).id);
      reqHeaders.current = new Headers({ referer: `http://localhost/dashboard/stores/${s.id}/settings?tab=x&ok=old` });
      const r = await redirectOf(() => actions.saveSettingsAction(s.id, form({ name: "x" })));
      expect(r.path).toBe(`/dashboard/stores/${s.id}/settings`);
      expect(r.search.get("tab")).toBe("x");
      expect(r.search.get("ok")).toBeNull();
      expect(r.error).toBe("read_only");
      expect(STORE_ACCESS_ERRORS[r.error as "read_only"]).toBe(access.READ_ONLY_ERROR);
      reqHeaders.current = new Headers({ referer: `http://localhost/dashboard/stores/${s.id}x/settings` });
      expect((await redirectOf(() => actions.saveSettingsAction(s.id, form({ name: "x" })))).path).toBe(`/dashboard/stores/${s.id}`);
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).name).toBe(s.name);
    });

    it("admin on an owner-only action: back to the page with the owner-only refusal", async () => {
      const s = await store({ whopConnectedAt: new Date() });
      await as((await user("admin")).id);
      reqHeaders.current = new Headers({ referer: `http://localhost/dashboard/stores/${s.id}/whop` });
      expect(await redirectOf(() => actions.disconnectWhopAction(s.id))).toMatchObject({ path: `/dashboard/stores/${s.id}/whop`, error: "owner_only" });
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).whopConnectedAt).toBeInstanceOf(Date);
    });
  });

  describe("tab titles don't disclose a store outside the user's scope", () => {
    it("layout, overview, order and builder metadata", async () => {
      const [mine, other] = [await store(), await store()];
      const order = await db.checkoutSession.create({ data: { storeId: other.id, currency: "EUR", lines: [], status: "PAID", shopifyOrderName: "#SECRET" } });
      await as((await limited("viewer", [mine.id])).id);
      const layout = await import("@/app/dashboard/stores/[storeId]/(main)/layout");
      const overview = await import("@/app/dashboard/stores/[storeId]/(main)/page");
      const orderPage = await import("@/app/dashboard/stores/[storeId]/(main)/orders/[sessionId]/page");
      const builder = await import("@/app/dashboard/stores/[storeId]/builder/[page]/page");
      const p = <T,>(v: T) => ({ params: Promise.resolve(v) });
      expect(JSON.stringify(await layout.generateMetadata(p({ storeId: other.id })))).not.toContain(other.name);
      expect(JSON.stringify(await layout.generateMetadata(p({ storeId: mine.id })))).toContain(mine.name);
      expect(JSON.stringify(await overview.generateMetadata(p({ storeId: other.id })))).not.toContain(other.name);
      expect(JSON.stringify(await orderPage.generateMetadata(p({ storeId: other.id, sessionId: order.id })))).not.toContain("#SECRET");
      expect(JSON.stringify(await builder.generateMetadata(p({ storeId: other.id, page: "checkout" })))).not.toContain(other.name);
      expect(JSON.stringify(await builder.generateMetadata(p({ storeId: mine.id, page: "checkout" })))).toContain(mine.name);
    });
  });
});
