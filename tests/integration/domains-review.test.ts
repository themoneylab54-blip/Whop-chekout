import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Checkout domains, review fixes against a real Postgres: the session POST's request key (a retry of
 * the same click gets the same session and one conversion), saving an unchanged domain retries the
 * Vercel step and the check, the apex confirmation, the Whop configuration keyed by its return host,
 * the tick's order (checks before removals) and its due-first selection of retired domains, and the
 * root of a checkout domain. Shopify, Whop, conversions and notifications are mocked; the network
 * is a stubbed fetch. Test data: domr_.
 */

const afterQueue = vi.hoisted(() => [] as (() => unknown)[]);
const shopify = vi.hoisted(() => ({ priceCart: vi.fn() }));
const whop = vi.hoisted(() => ({ registerApplePayDomain: vi.fn(), unregisterApplePayDomain: vi.fn(), createCheckoutConfiguration: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendTelegram: vi.fn() }));
const conversions = vi.hoisted(() => ({ sendCheckoutConversions: vi.fn() }));

class Redirect extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn) }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), requireAdmin: async () => "admin" }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));
vi.mock("@/lib/conversions", async (orig) => ({ ...(await orig<typeof import("@/lib/conversions")>()), ...conversions }));

const hasDb = !!process.env.DATABASE_URL;
const APP_HOST = "checkout.example.com";

async function flashOf(run: () => Promise<unknown>): Promise<{ ok?: string; error?: string; field?: string }> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Redirect)) throw err;
    const q = new URL(err.url, "http://x").searchParams;
    return { ok: q.get("ok") ?? undefined, error: q.get("error") ?? undefined, field: q.get("field") ?? undefined };
  }
  throw new Error("no redirect");
}

describe.skipIf(!hasDb)("checkout domains, review fixes (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { recheckCheckoutDomains, removeRetiredDomains, retireCheckoutDomain, retiredDomainOwner, RETIRED_DOMAIN_GRACE_MS } = await import("@/lib/checkout-domain-check");
  const { prepareSession, snapshotFingerprint } = await import("@/lib/checkout");
  const actions = await import("@/app/dashboard/actions");
  const pingRoute = await import("@/app/.well-known/whop-checkout-ping/route");
  const sessionsRoute = await import("@/app/api/public/sessions/route");
  const homeRoute = await import("@/app/api/public/domain-home/route");

  const created: string[] = [];
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const line = { variantId: "gid://shopify/ProductVariant/31", productId: "gid://shopify/Product/31", productHandle: "robe", title: "Robe", variantTitle: null, sku: null, imageUrl: null, quantity: 1, unitPriceCents: 4000, compareAtCents: null, inventory: null, requiresShipping: false, giftCard: false };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `domr_${rnd()}`,
        enabled: true,
        testMode: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_domr",
        whopProductId: `prod_domr_${rnd()}`,
        whopApiKey: encrypt("k"),
        shopDomain: `domr-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  type Call = { url: URL; method: string };
  /** Pings answered by this app's route for `routed` hosts; the Vercel API by `vercel` (default 200 {}). */
  function stubNetwork(routed: Set<string>, vercel: (c: Call) => Response = () => Response.json({ name: "x", verified: true })) {
    const calls: Call[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const call = { url, method: init?.method ?? "GET" };
        calls.push(call);
        if (url.hostname === "api.vercel.com") return vercel(call);
        if (!routed.has(url.hostname)) return new Response("The deployment could not be found on Vercel. DEPLOYMENT_NOT_FOUND", { status: 404 });
        return pingRoute.GET(new Request(url, { headers: { host: url.host } }));
      }),
    );
    return calls;
  }

  const post = (store: { publicId: string }, body: Record<string, unknown>, host = APP_HOST) =>
    sessionsRoute.POST(
      new Request(`https://${host}/api/public/sessions`, {
        method: "POST",
        headers: { host, "content-type": "application/json", "x-forwarded-for": `10.29.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
        body: JSON.stringify({ store: store.publicId, items: [{ variant_id: 31, quantity: 1 }], ...body }),
      }),
      { params: Promise.resolve({}) },
    );

  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    return fd;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    afterQueue.length = 0;
    whop.registerApplePayDomain.mockResolvedValue({ id: "pmd_1", status: "verified" });
    shopify.priceCart.mockResolvedValue([line]);
    conversions.sendCheckoutConversions.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await db.appSetting.deleteMany({ where: { key: { startsWith: "checkout-domain:retired:checkout.domr-" } } });
    await db.eventLog.deleteMany({ where: { storeId: { in: created } } });
    await db.alertOutbox.deleteMany({ where: { storeId: { in: created } } });
    await db.appSetting.deleteMany({ where: { OR: created.map((id) => ({ key: { contains: id } })) } });
    await db.checkoutSession.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("request key: a retry of the same click (other host, or while the first still runs) gets the same session and one conversion", async () => {
    const domain = `checkout.domr-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain, checkoutDomainVerifiedAt: new Date() });
    const key = `k${rnd()}${rnd()}${rnd()}`;
    const first = (await (await post(store, { requestKey: key }, domain)).json()) as { id: string; url: string; visitorId: string };
    // The checkout domain timed out in the browser: the loader retries on APP_URL with the same key.
    const retry = await post(store, { requestKey: key, visitorId: first.visitorId });
    expect(retry.status).toBe(200);
    const again = (await retry.json()) as { id: string; url: string; visitorId: string; replayed?: boolean };
    expect(again).toMatchObject({ id: first.id, url: first.url, visitorId: first.visitorId, replayed: true });
    expect(await db.checkoutSession.count({ where: { storeId: store.id, requestKey: key } })).toBe(1);

    // Both requests in flight at once (slow Shopify pricing): one session, the other request answers it.
    const key2 = `k${rnd()}${rnd()}${rnd()}`;
    shopify.priceCart.mockImplementation(() => new Promise((r) => setTimeout(() => r([line]), 60)));
    const both = await Promise.all([post(store, { requestKey: key2 }, domain), post(store, { requestKey: key2 })]);
    const ids = await Promise.all(both.map(async (r) => ((await r.json()) as { id: string }).id));
    expect(both.map((r) => r.status)).toEqual([200, 200]);
    expect(ids[0]).toBe(ids[1]);
    expect(await db.checkoutSession.count({ where: { storeId: store.id, requestKey: key2 } })).toBe(1);

    // InitiateCheckout: once per session, never for the replays.
    await Promise.all(afterQueue.map((fn) => fn()));
    expect(conversions.sendCheckoutConversions.mock.calls.map((c) => c[0]).sort()).toEqual([first.id, ids[0]].sort());

    // Without a key (older loader): a new session each time; the key is per store; a malformed key is refused.
    const a = (await (await post(store, {})).json()) as { id: string };
    const b = (await (await post(store, {})).json()) as { id: string };
    expect(a.id).not.toBe(b.id);
    const other = await makeStore();
    const theirs = (await (await post(other, { requestKey: key })).json()) as { id: string };
    expect(theirs.id).not.toBe(first.id);
    expect((await post(store, { requestKey: "short" })).status).toBe(400);
  });

  it("saving an unchanged domain retries the Vercel step and the check; a healthy one is left alone", async () => {
    vi.stubEnv("VERCEL_API_TOKEN", "tok");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_domr");
    vi.stubEnv("VERCEL_TEAM_ID", "");
    const domain = `checkout.domr-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain, checkoutDomainError: "vercel:Vercel n'a pas pu ajouter le domaine (timeout)." });
    const calls = stubNetwork(new Set([domain]));
    const flash = await flashOf(() => actions.saveCheckoutDomainAction(store.id, form({ checkoutDomain: domain })));
    expect(flash.ok).toContain("Domaine vérifié");
    expect(calls.some((c) => c.url.hostname === "api.vercel.com" && c.method === "POST" && c.url.pathname.endsWith("/prj_domr/domains"))).toBe(true);
    expect(calls.some((c) => c.url.hostname === domain)).toBe(true);
    const after = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.checkoutDomainVerifiedAt).not.toBeNull();
    expect(after.checkoutDomainError).toBeNull();

    // Verified and healthy: "inchangé", nothing called.
    calls.length = 0;
    expect((await flashOf(() => actions.saveCheckoutDomainAction(store.id, form({ checkoutDomain: domain })))).ok).toBe("Domaine du checkout inchangé");
    expect(calls).toEqual([]);

    // Vercel still refusing: its message, recorded as a "vercel" error.
    const pending = await makeStore({ checkoutDomain: `checkout.domr-${rnd()}.test`, checkoutDomainError: "vercel:ancien refus" });
    stubNetwork(new Set(), () => Response.json({ error: { code: "forbidden", message: "nope" } }, { status: 403 }));
    const refused = await flashOf(() => actions.saveCheckoutDomainAction(pending.id, form({ checkoutDomain: pending.checkoutDomain! })));
    expect(refused).toMatchObject({ field: "checkoutDomain", error: expect.stringContaining("Vercel n'a pas pu ajouter") });
    expect((await db.store.findUniqueOrThrow({ where: { id: pending.id } })).checkoutDomainError).toMatch(/^vercel:Vercel n'a pas pu ajouter/);
  });

  it("\"Vérifier\" adds the domain back to the Vercel project when Vercel doesn't know it (404)", async () => {
    vi.stubEnv("VERCEL_API_TOKEN", "tok");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_domr");
    vi.stubEnv("VERCEL_TEAM_ID", "");
    const domain = `checkout.domr-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain });
    const calls = stubNetwork(new Set([domain]), (c) =>
      c.method === "GET" && c.url.pathname.includes("/domains/") ? Response.json({ error: { code: "not_found", message: "missing" } }, { status: 404 }) : Response.json({ name: domain, verified: true }),
    );
    const flash = await flashOf(() => actions.verifyCheckoutDomainAction(store.id));
    expect(flash.ok).toContain("Domaine vérifié");
    expect(calls.filter((c) => c.url.hostname === "api.vercel.com" && c.method === "POST")).toHaveLength(1);

    // Known to Vercel: never re-added.
    const other = await makeStore({ checkoutDomain: `checkout.domr-${rnd()}.test` });
    const calls2 = stubNetwork(new Set([other.checkoutDomain!]));
    await flashOf(() => actions.verifyCheckoutDomainAction(other.id));
    expect(calls2.filter((c) => c.url.hostname === "api.vercel.com" && c.method === "POST")).toHaveLength(0);
  });

  it("an apex domain is only saved with the explicit confirmation", async () => {
    const store = await makeStore();
    stubNetwork(new Set());
    const apex = `domr-${rnd()}.test`;
    const refused = await flashOf(() => actions.saveCheckoutDomainAction(store.id, form({ checkoutDomain: apex })));
    expect(refused).toMatchObject({ field: "checkoutDomain", error: expect.stringContaining("remplacera votre site principal") });
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomain).toBeNull();
    const saved = await flashOf(() => actions.saveCheckoutDomainAction(store.id, form({ checkoutDomain: apex, confirmApex: "on" })));
    expect(saved.error).toBeUndefined();
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomain).toBe(apex);
    // Saving it again (the card keeps the box checked for an apex): unchanged, never refused.
    expect((await flashOf(() => actions.saveCheckoutDomainAction(store.id, form({ checkoutDomain: apex, confirmApex: "on" })))).error ?? "").not.toContain("racine");
  });

  it("a domain another store retired less than 48 h ago can't be claimed; its own store can take it back", async () => {
    stubNetwork(new Set());
    const owner = await makeStore();
    const other = await makeStore();
    const domain = `checkout.domr-${rnd()}.test`;
    await retireCheckoutDomain(owner.id, domain);
    const refused = await flashOf(() => actions.saveCheckoutDomainAction(other.id, form({ checkoutDomain: domain })));
    expect(refused.field).toBe("checkoutDomain");
    expect(refused.error).toContain("vient d'être retiré par une autre boutique");
    expect(refused.error).toContain("48 h");
    expect((await db.store.findUniqueOrThrow({ where: { id: other.id } })).checkoutDomain).toBeNull();
    expect(await retiredDomainOwner(domain)).toBe(owner.id);
    // The store that retired it may take it back (unretired).
    const back = await flashOf(() => actions.saveCheckoutDomainAction(owner.id, form({ checkoutDomain: domain })));
    expect(back.error).toBeUndefined();
    const saved = await db.store.findUniqueOrThrow({ where: { id: owner.id } });
    expect(saved.checkoutDomain).toBe(domain);
    expect(saved.checkoutDomainPendingSince).not.toBeNull();
    expect(await retiredDomainOwner(domain)).toBeNull();
  });

  it("a Whop configuration made for the checkout domain is never reused from APP_URL's host (return URL), and vice versa", async () => {
    const domain = `checkout.domr-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain, checkoutDomainVerifiedAt: new Date() });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Standard", countries: [], priceCents: 0 } });
    const { id } = (await (await post(store, {}, domain)).json()) as { id: string };
    const session = await db.checkoutSession.findUniqueOrThrow({ where: { id }, include: { store: true } });
    let n = 0;
    whop.createCheckoutConfiguration.mockImplementation(async () => ({ id: `ch_domr_${rnd()}_${++n}`, purchaseUrl: null }));
    const onDomain = await prepareSession(session, { addOnIds: [], countryCode: "FR" }, { host: domain });
    const onApp = await prepareSession(session, { addOnIds: [], countryCode: "FR" }, { host: APP_HOST });
    expect(onApp.checkoutConfigurationId).not.toBe(onDomain.checkoutConfigurationId);
    expect(whop.createCheckoutConfiguration.mock.calls.map((c) => (c[1] as { redirectUrl: string }).redirectUrl)).toEqual([`https://${domain}/c/${id}/merci`, `https://${APP_HOST}/c/${id}/merci?via=app`]);
    // Each host gets its own configuration back (no third one).
    expect((await prepareSession(session, { addOnIds: [], countryCode: "FR" }, { host: domain })).checkoutConfigurationId).toBe(onDomain.checkoutConfigurationId);
    expect((await prepareSession(session, { addOnIds: [], countryCode: "FR" }, { host: APP_HOST })).checkoutConfigurationId).toBe(onApp.checkoutConfigurationId);
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(2);

    // Stores without a checkout domain (return URL on APP_URL): fingerprints unchanged.
    const quote = { shippingRateId: null, discount: null, addOnIds: [], totals: { totalCents: 4000 } } as unknown as Parameters<typeof snapshotFingerprint>[0];
    expect(snapshotFingerprint(quote, null, `https://${APP_HOST}/c/x/merci`)).toBe(snapshotFingerprint(quote, null));
    expect(snapshotFingerprint(quote, null, `https://${domain}/c/x/merci`)).toBe(`${snapshotFingerprint(quote, null)}|h:${domain}`);
  });

  it("tick: domain checks run before the Vercel removals; retired domains are picked due-first, never hidden by a backlog", async () => {
    vi.stubEnv("VERCEL_API_TOKEN", "tok");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_domr");
    vi.stubEnv("VERCEL_TEAM_ID", "");
    const store = await makeStore();
    const now = new Date();
    // A backlog of domains retired just now (not due), then one retired 49 h ago (due).
    for (let i = 0; i < 60; i++) await retireCheckoutDomain(store.id, `checkout.domr-backlog-${rnd()}-${i}.test`, now);
    const due = `checkout.domr-due-${rnd()}.test`;
    await retireCheckoutDomain(store.id, due, new Date(now.getTime() - RETIRED_DOMAIN_GRACE_MS - 3600_000));
    const calls = stubNetwork(new Set());
    await removeRetiredDomains(Date.now() + 5_000, now);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => decodeURIComponent(c.url.pathname.split("/").pop()!))).toContain(due);
    expect(await retiredDomainOwner(due)).toBeNull();

    // Order inside a tick run.
    const domain = `checkout.domr-${rnd()}.test`;
    await makeStore({ checkoutDomain: domain });
    const due2 = `checkout.domr-due-${rnd()}.test`;
    await retireCheckoutDomain(store.id, due2, new Date(now.getTime() - RETIRED_DOMAIN_GRACE_MS - 3600_000));
    const order = stubNetwork(new Set([domain]));
    await recheckCheckoutDomains(Date.now() + 5_000);
    const ping = order.findIndex((c) => c.url.hostname === domain);
    const del = order.findIndex((c) => c.method === "DELETE");
    expect(ping).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(ping);
  });

  it("the root of a checkout domain sends the buyer to the store's site (404 on an unknown host)", async () => {
    const domain = `checkout.domr-${rnd()}.test`;
    await makeStore({ checkoutDomain: domain, storefrontHost: "www.domr-shop.test" });
    const res = await homeRoute.GET(new Request(`https://${domain}/api/public/domain-home`, { headers: { host: domain } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://www.domr-shop.test/");
    const unknown = await homeRoute.GET(new Request("https://nobody.domr.test/api/public/domain-home", { headers: { host: "nobody.domr.test" } }));
    expect(unknown.status).toBe(404);
  });
});
