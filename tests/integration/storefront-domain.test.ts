import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The storefront domain kept as Shopify has it, against a real Postgres (Shopify's shop info mocked):
 * a moved shop's domain is saved over the row as read (a store without a domain too: IS NULL) and
 * journaled once; one saved in another form is rewritten, not journaled; a reconnection to another
 * shop meanwhile is never overwritten with the previous shop's domain; the tick asks the stores never
 * checked before the old checks, records each check and asks a store again only once due; out of time,
 * or with Shopify's breaker open (through the real Shopify client: no call sent), nothing is recorded,
 * the store first next run; a checkout from an unknown host asks once within the store's 10 min, and a
 * host asked about lately is not asked about again from another instance (the shared rate-limit table)
 * without spending the store's window. Test data is prefixed sfd_ and deleted at the end.
 */

const hasDb = !!process.env.DATABASE_URL;

const shopify = vi.hoisted(() => ({ getShopInfo: vi.fn() }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));

describe.skipIf(!hasDb)("storefront domain (integration)", async () => {
  const { db } = await import("@/lib/db");
  const sd = await import("@/lib/storefront-domain");
  const { DeadlineError } = await import("@/lib/deadline");
  const { withLogContext } = await import("@/lib/log");
  const tag = `sfd_${Math.random().toString(36).slice(2, 8)}`;
  const stores: string[] = [];
  const select = { id: true, shopDomain: true, shopifyAccessToken: true, storefrontHost: true } as const;

  /** A connected store of this test, as the code reads it. */
  async function connected(i: number, storefrontHost: string | null) {
    const s = await db.store.create({
      data: { name: `${tag}_${i}`, shopDomain: `${tag}-${i}.myshopify.com`, shopifyAccessToken: `enc_${tag}_${i}`, shopifyConnectedAt: new Date(), storefrontHost },
    });
    stores.push(s.id);
    return db.store.findUniqueOrThrow({ where: { id: s.id }, select });
  }
  const row = (id: string) => db.store.findUniqueOrThrow({ where: { id }, select: { storefrontHost: true, storefrontHostCheckedAt: true, shopDomain: true } });
  const journal = (storeId: string) => db.eventLog.findMany({ where: { storeId, kind: "shopify.storefront_domain" } });
  /** Shopify's answer per shop: this test's shops as `hosts` says (by store name suffix), any other shop on its own domain (nothing changes there). */
  function shopsOn(hosts: Record<string, string | Error>) {
    shopify.getShopInfo.mockImplementation(async (s: { id: string; shopDomain: string | null; storefrontHost?: string | null }) => {
      const mine = Object.entries(hosts).find(([suffix]) => s.shopDomain === `${tag}-${suffix}.myshopify.com`);
      if (mine && mine[1] instanceof Error) throw mine[1];
      const host = mine ? (mine[1] as string) : (s.storefrontHost ?? null);
      return { name: "Shop", currencyCode: "EUR", primaryDomain: host ? { host, sslEnabled: true } : null };
    });
  }
  /** One tick job run (hard deadline and partial holder as the tick sets them). */
  async function tickRun(hardMs = 50_000) {
    const holder: { partial?: boolean } = {};
    const checked = await withLogContext({ tickPartial: holder, hardDeadline: Date.now() + hardMs }, () => sd.checkStorefrontDomains(Date.now() + 10_000));
    return { checked, partial: !!holder.partial };
  }
  /** Tick runs until this test's store `id` was checked (other connected stores of the database come in turn too). */
  async function tickUntilChecked(id: string) {
    for (let i = 0; i < 20; i++) {
      await tickRun();
      if ((await row(id)).storefrontHostCheckedAt) return;
    }
    throw new Error("never checked");
  }

  // A block body: a function returned by beforeEach is run as its cleanup (mockReset returns the mock).
  beforeEach(() => {
    shopify.getShopInfo.mockReset();
  });
  afterAll(async () => {
    await db.eventLog.deleteMany({ where: { storeId: { in: stores } } });
    for (const id of stores) await db.rateLimit.deleteMany({ where: { key: { startsWith: `storefront-domain:${id}` } } });
    await db.store.deleteMany({ where: { id: { in: stores } } });
  });

  it("a moved shop: saved over the row as read (a store without a domain too), journaled once", async () => {
    const moved = await connected(1, "xn--sovline-dya.fr");
    expect(await sd.saveStorefrontHost(moved, "soveline.fr", "tick")).toBe(true);
    expect((await row(moved.id)).storefrontHost).toBe("soveline.fr");
    // The row read is stale now: a second save over it changes nothing, journals nothing.
    expect(await sd.saveStorefrontHost(moved, "soveline.fr", "tick")).toBe(false);
    const entries = await journal(moved.id);
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toContain("sovéline.fr → soveline.fr");

    const none = await connected(2, null);
    expect(await sd.saveStorefrontHost(none, "soveline.fr", "dashboard")).toBe(true);
    expect((await row(none.id)).storefrontHost).toBe("soveline.fr");
  });

  it("the same domain saved in another form by an older connection: rewritten at its check, not journaled", async () => {
    const raw = await connected(11, "Sovéline.FR");
    shopsOn({ "11": "xn--sovline-dya.fr" });
    await tickUntilChecked(raw.id);
    expect((await row(raw.id)).storefrontHost).toBe("xn--sovline-dya.fr");
    expect(await journal(raw.id)).toHaveLength(0);
  });

  it("a reconnection to another shop meanwhile (same domain kept): the previous shop's answer never written over it", async () => {
    const read = await connected(3, "brand.example.com");
    // The merchant moves brand.example.com to another shop and reconnects the store to it.
    await db.store.update({ where: { id: read.id }, data: { shopDomain: `${tag}-3b.myshopify.com`, shopifyAccessToken: `enc_${tag}_3b`, storefrontHost: "brand.example.com" } });
    // A check that read the row before, with the old shop's token: that shop's domain is now its myshopify address.
    expect(await sd.saveStorefrontHost(read, `${tag}-3.myshopify.com`, "tick")).toBe(false);
    expect(await row(read.id)).toMatchObject({ storefrontHost: "brand.example.com", shopDomain: `${tag}-3b.myshopify.com` });
    expect(await journal(read.id)).toHaveLength(0);
  });

  it("the tick: each due store checked and recorded, asked again only once due; a moved shop saved", async () => {
    const moved = await connected(4, "old.example.com");
    shopsOn({ "4": "new.example.com" });
    await tickUntilChecked(moved.id);
    const after = await row(moved.id);
    expect(after.storefrontHost).toBe("new.example.com");
    expect(after.storefrontHostCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    const askedOf = () => shopify.getShopInfo.mock.calls.filter(([s]) => (s as { id: string }).id === moved.id).length;
    expect(askedOf()).toBe(1);
    // Not due again before DOMAIN_CHECK_EVERY_MS.
    await tickRun();
    await tickRun();
    expect(askedOf()).toBe(1);
    // Due again once its last check is that old.
    await db.store.update({ where: { id: moved.id }, data: { storefrontHostCheckedAt: new Date(Date.now() - sd.DOMAIN_CHECK_EVERY_MS - 1_000) } });
    for (let i = 0; i < 20 && askedOf() < 2; i++) await tickRun();
    expect(askedOf()).toBe(2);
    expect((await row(moved.id)).storefrontHostCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("the order of the checks: a store never checked is asked before one checked hours ago", async () => {
    const fresh = await connected(7, "fresh.example.com");
    const old = await connected(8, "old8.example.com");
    await db.store.update({ where: { id: old.id }, data: { storefrontHostCheckedAt: new Date(Date.now() - sd.DOMAIN_CHECK_EVERY_MS - 3600_000) } });
    shopsOn({});
    const order = () => shopify.getShopInfo.mock.calls.map(([s]) => (s as { id: string }).id).filter((id) => id === fresh.id || id === old.id);
    for (let i = 0; i < 20 && order().length < 2; i++) await tickRun();
    expect(order()).toEqual([fresh.id, old.id]);
  });

  it("out of time (a DeadlineError from Shopify's call): nothing recorded for the store, the run partial; it comes first next run", async () => {
    const late = await connected(5, "late.example.com");
    shopsOn({ "5": new DeadlineError("Shopify shop : Shopify ne répond pas, appels suspendus pour ce passage") });
    let partial = false;
    for (let i = 0; i < 20 && !shopify.getShopInfo.mock.calls.some(([s]) => (s as { id: string }).id === late.id); i++) partial = (await tickRun()).partial;
    expect(partial).toBe(true);
    expect((await row(late.id)).storefrontHostCheckedAt).toBeNull();
    // Next run (Shopify back): never checked, so among the first; recorded this time.
    shopsOn({ "5": "late.example.com" });
    await tickUntilChecked(late.id);
    expect((await row(late.id)).storefrontHost).toBe("late.example.com");
  });

  it("Shopify's breaker open for the run (the real Shopify client): no call sent, nothing recorded, the run partial", async () => {
    const { encrypt } = await import("@/lib/crypto");
    const actual = await vi.importActual<typeof import("@/lib/shopify")>("@/lib/shopify");
    const store = await connected(9, "breaker.example.com");
    await db.store.update({ where: { id: store.id }, data: { shopifyAccessToken: encrypt("tok") } });
    shopify.getShopInfo.mockImplementation((s: Parameters<typeof actual.getShopInfo>[0]) => actual.getShopInfo(s));
    const sent = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", sent);
    try {
      const holder: { partial?: boolean } = {};
      const breakers = { shopify: { at: Date.now(), what: "Shopify orders (a hang earlier in this run)" } };
      const checked = await withLogContext({ tickPartial: holder, hardDeadline: Date.now() + 50_000, breakers }, () => sd.checkStorefrontDomains(Date.now() + 10_000));
      expect({ checked, partial: !!holder.partial }).toEqual({ checked: 0, partial: true });
      expect(sent).not.toHaveBeenCalled();
      expect((await row(store.id)).storefrontHostCheckedAt).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a checkout from an unknown host: Shopify asked once within the store's 10 min (the real limiter)", async () => {
    const moved = await connected(6, "xn--sovline-dya.fr");
    shopsOn({ "6": "soveline.fr" });
    await sd.recheckStorefrontHost(moved, "soveline.fr");
    await sd.recheckStorefrontHost(moved, "soveline.fr");
    await sd.recheckStorefrontHost(moved, "soveline.de");
    expect(shopify.getShopInfo).toHaveBeenCalledTimes(1);
    expect(await row(moved.id)).toMatchObject({ storefrontHost: "soveline.fr" });
    expect((await row(moved.id)).storefrontHostCheckedAt).not.toBeNull();
    expect((await journal(moved.id))[0].data).toMatchObject({ from: "xn--sovline-dya.fr", to: "soveline.fr", why: "unknown_host" });
  });

  it("the same host again, from another instance once the store's 10 min are over: not asked about again (its 6 h, shared), and the store's window left for a new host", async () => {
    const shop = await connected(10, "xn--sovline-dya.fr");
    shopsOn({ "10": "xn--sovline-dya.fr" });
    await sd.recheckStorefrontHost(shop, "soveline.de");
    expect(shopify.getShopInfo).toHaveBeenCalledTimes(1);
    // The store's window over; another serverless instance (its own memory of the limits).
    await db.rateLimit.updateMany({ where: { key: `storefront-domain:${shop.id}` }, data: { resetAt: new Date(Date.now() - 60_000) } });
    vi.resetModules();
    const other = await import("@/lib/storefront-domain");
    await other.recheckStorefrontHost(shop, "soveline.de");
    expect(shopify.getShopInfo).toHaveBeenCalledTimes(1);
    // A host never asked about: the store's window is still there for it.
    await other.recheckStorefrontHost(shop, "soveline.com");
    expect(shopify.getShopInfo).toHaveBeenCalledTimes(2);
    // The host's 6 h over (and the store's 10 min): asked about again, from yet another instance.
    await db.rateLimit.updateMany({ where: { key: { in: [`storefront-domain:${shop.id}`, `storefront-domain:${shop.id}:soveline.de`] } }, data: { resetAt: new Date(Date.now() - 60_000) } });
    vi.resetModules();
    await (await import("@/lib/storefront-domain")).recheckStorefrontHost(shop, "soveline.de");
    expect(shopify.getShopInfo).toHaveBeenCalledTimes(3);
  });
});
