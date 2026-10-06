import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Checkout domains against a real Postgres: the verification route's store token, the check that
 * verifies a domain (journal + Apple Pay registered with Whop), session creation and the loader's
 * config on the verified domain, the Whop return URL, and the tick's re-check (a verified domain that
 * stops answering falls back to APP_URL with an alert; a pending one is verified once it answers).
 * Shopify, Whop and notifications are mocked; the network is a stubbed fetch. Test data: dom_.
 */

const afterQueue = vi.hoisted(() => [] as (() => unknown)[]);
const shopify = vi.hoisted(() => ({ priceCart: vi.fn() }));
const whop = vi.hoisted(() => ({ registerApplePayDomain: vi.fn(), unregisterApplePayDomain: vi.fn(), createCheckoutConfiguration: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendTelegram: vi.fn() }));

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn) }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const DAY = 86_400_000;

describe.skipIf(!hasDb)("checkout domains (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { domainToken, checkoutBaseUrl } = await import("@/lib/checkout-domain");
  const { checkStoreDomain, pingDomain, recheckCheckoutDomains, retireCheckoutDomain, unretireCheckoutDomain, removeRetiredDomains, retiredDomainOwner, APPLE_PAY_ASSOCIATION_KEY, RETIRED_DOMAIN_GRACE_MS } = await import(
    "@/lib/checkout-domain-check"
  );
  const prepareRoute = await import("@/app/api/public/sessions/[id]/prepare/route");
  const { prepareSession } = await import("@/lib/checkout");
  const pingRoute = await import("@/app/.well-known/whop-checkout-ping/route");
  const sessionsRoute = await import("@/app/api/public/sessions/route");
  const configRoute = await import("@/app/api/public/stores/[publicId]/config/route");

  const created: string[] = [];
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const line = { variantId: "gid://shopify/ProductVariant/31", productId: "gid://shopify/Product/31", productHandle: "robe", title: "Robe", variantTitle: null, sku: null, imageUrl: null, quantity: 1, unitPriceCents: 4000, compareAtCents: null, inventory: null, requiresShipping: false, giftCard: false };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `dom_${rnd()}`,
        enabled: true,
        testMode: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_dom",
        whopProductId: `prod_dom_${rnd()}`,
        whopApiKey: encrypt("k"),
        shopDomain: `dom-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  /** The network: https://<host>/.well-known/whop-checkout-ping answered by this app's route for `routed` hosts. */
  function stubNetwork(routed: Set<string>, down: Set<string> = new Set()) {
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (down.has(url.hostname)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
      if (!routed.has(url.hostname)) return new Response("The deployment could not be found on Vercel. DEPLOYMENT_NOT_FOUND", { status: 404 });
      return pingRoute.GET(new Request(url, { headers: { host: url.host } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    afterQueue.length = 0;
    whop.registerApplePayDomain.mockResolvedValue({ id: "pmd_1", status: "verified" });
    shopify.priceCart.mockResolvedValue([line]);
  });

  // Apple Pay registration needs Apple's association file installed (restored after the tests).
  let associationCreated = false;
  beforeAll(async () => {
    const r = await db.appSetting.createMany({ data: [{ key: APPLE_PAY_ASSOCIATION_KEY, value: "apple-association-test" }], skipDuplicates: true });
    associationCreated = r.count > 0;
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (associationCreated) await db.appSetting.deleteMany({ where: { key: APPLE_PAY_ASSOCIATION_KEY } });
    await db.appSetting.deleteMany({ where: { key: { startsWith: "checkout-domain:retired:checkout.dom-" } } });
    await db.eventLog.deleteMany({ where: { storeId: { in: created } } });
    await db.alertOutbox.deleteMany({ where: { storeId: { in: created } } });
    await db.appSetting.deleteMany({ where: { OR: created.map((id) => ({ key: { contains: id } })) } });
    await db.checkoutSession.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("the ping route answers the token of the store owning the host, 404 elsewhere", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain });
    const res = await pingRoute.GET(new Request(`https://${domain}/.well-known/whop-checkout-ping`, { headers: { host: `${domain.toUpperCase()}:443` } }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe(domainToken(store.id, domain));
    const other = await pingRoute.GET(new Request("https://checkout.example.com/.well-known/whop-checkout-ping", { headers: { host: "checkout.example.com" } }));
    expect(other.status).toBe(404);
  });

  it("verifies a routed domain: verifiedAt set, journal, Apple Pay registered for that domain", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain });
    stubNetwork(new Set([domain]));
    const result = await checkStoreDomain(store.id, { vercel: false });
    expect(result).toEqual({ verified: true, message: null, domain });
    const after = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.checkoutDomainVerifiedAt).not.toBeNull();
    expect(after.checkoutDomainError).toBeNull();
    expect(after.checkoutDomainCheckedAt).not.toBeNull();
    expect(whop.registerApplePayDomain).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), domain);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "checkout_domain.verified" } })).toBe(1);
    // Checked again: no second journal entry nor Apple Pay call.
    await checkStoreDomain(store.id, { vercel: false });
    expect(whop.registerApplePayDomain).toHaveBeenCalledTimes(1);
  });

  it("a domain that isn't routed (DNS missing, other Vercel project, other store's token) stays unverified with a French reason", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain });
    stubNetwork(new Set(), new Set([domain]));
    let r = await checkStoreDomain(store.id, { vercel: false });
    expect(r.verified).toBe(false);
    expect(r.message).toContain("CNAME");
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomainError).toMatch(/^dns:/);

    stubNetwork(new Set());
    r = await checkStoreDomain(store.id, { vercel: false });
    expect(r.message).toContain("Vercel → Settings → Domains");
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomainError).toMatch(/^mismatch:/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(domainToken("another-store", domain), { status: 200 })));
    expect((await pingDomain(store.id, domain)).ok).toBe(false);
    expect(whop.registerApplePayDomain).not.toHaveBeenCalled();
  });

  it("session creation, the loader config and the Whop return URL use the verified domain (APP_URL before)", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain });
    const post = () =>
      sessionsRoute.POST(
        new Request("https://checkout.example.com/api/public/sessions", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `10.26.${Math.floor(Math.random() * 250)}.1` },
          body: JSON.stringify({ store: store.publicId, items: [{ variant_id: 31, quantity: 1 }] }),
        }),
        { params: Promise.resolve({}) },
      );
    const config = async () =>
      (await (await configRoute.GET(new Request(`https://checkout.example.com/api/public/stores/${store.publicId}/config`), { params: Promise.resolve({ publicId: store.publicId }) })).json()) as { sessionEndpoint: string };

    const before = (await (await post()).json()) as { id: string; url: string };
    expect(before.url).toBe(`https://checkout.example.com/c/${before.id}`);
    expect((await config()).sessionEndpoint).toBe("https://checkout.example.com/api/public/sessions");

    await db.store.update({ where: { id: store.id }, data: { checkoutDomainVerifiedAt: new Date() } });
    const res = await post();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; url: string };
    expect(body.url).toBe(`https://${domain}/c/${body.id}`);
    expect((await config()).sessionEndpoint).toBe(`https://${domain}/api/public/sessions`);

    // Whop's embedded checkout returns the buyer to the thank-you page on the store's domain.
    whop.createCheckoutConfiguration.mockResolvedValue({ id: "ch_dom_1", purchaseUrl: null });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Standard", countries: [], priceCents: 0 } });
    const session = await db.checkoutSession.findUniqueOrThrow({ where: { id: body.id }, include: { store: true } });
    await prepareSession(session, { addOnIds: [], countryCode: "FR" });
    expect(whop.createCheckoutConfiguration.mock.calls[0][1]).toMatchObject({ redirectUrl: `https://${domain}/c/${body.id}/merci` });
    expect(checkoutBaseUrl(session.store)).toBe(`https://${domain}`);

    // Paid on APP_URL (the loader's fallback: domain unreachable for this buyer): back to APP_URL with ?via=app.
    const viaApp = (await (await post()).json()) as { id: string };
    whop.createCheckoutConfiguration.mockResolvedValue({ id: "ch_dom_2", purchaseUrl: null });
    const s2 = await db.checkoutSession.findUniqueOrThrow({ where: { id: viaApp.id }, include: { store: true } });
    await prepareSession(s2, { addOnIds: [], countryCode: "FR" }, { host: "checkout.example.com" });
    expect(whop.createCheckoutConfiguration.mock.calls.at(-1)![1]).toMatchObject({ redirectUrl: `https://checkout.example.com/c/${viaApp.id}/merci?via=app` });
  });

  it("tick: a verified domain that stops answering falls back to APP_URL (alert) after failing on two runs, then is re-verified", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain, checkoutDomainVerifiedAt: new Date(Date.now() - 2 * DAY), checkoutDomainCheckedAt: new Date(Date.now() - 2 * DAY) });
    const fetchMock = stubNetwork(new Set(), new Set([domain]));
    const n = await recheckCheckoutDomains(Date.now() + 5_000);
    expect(n).toBeGreaterThanOrEqual(1);
    // First failing run: one ping, the failure recorded, the domain still in use (one blip is not enough).
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(domain))).toHaveLength(1);
    const struck = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(struck.checkoutDomainVerifiedAt).not.toBeNull();
    expect(struck.checkoutDomainError).toMatch(/^dns:/);
    expect(checkoutBaseUrl(struck)).toBe(`https://${domain}`);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "checkout_domain.lost" } })).toBe(0);
    // Same run window: not re-checked; the next run 11 minutes later fails again → un-verified.
    await recheckCheckoutDomains(Date.now() + 5_000);
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomainVerifiedAt).not.toBeNull();
    await recheckCheckoutDomains(Date.now() + 5_000, new Date(Date.now() + 11 * 60_000));
    const lost = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(lost.checkoutDomainVerifiedAt).toBeNull();
    expect(checkoutBaseUrl(lost)).toBe("https://checkout.example.com");
    const alert = await db.eventLog.findFirst({ where: { storeId: store.id, kind: "checkout_domain.lost" } });
    expect(alert?.level).toBe("error");
    expect(alert?.message).toContain(domain);
    expect(await db.alertOutbox.count({ where: { storeId: store.id, kind: "checkout_domain.lost" } })).toBe(1);

    // Checked just now: not re-checked before 10 minutes.
    stubNetwork(new Set([domain]));
    await recheckCheckoutDomains(Date.now() + 5_000, new Date(Date.now() + 12 * 60_000));
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomainVerifiedAt).toBeNull();
    // 22 minutes later: answering again, verified again.
    await recheckCheckoutDomains(Date.now() + 5_000, new Date(Date.now() + 22 * 60_000));
    const back = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(back.checkoutDomainVerifiedAt).not.toBeNull();
    expect(back.checkoutDomainError).toBeNull();
  });

  it("tick: a verified domain that fails once then answers again is never un-verified", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain, checkoutDomainVerifiedAt: new Date(Date.now() - 2 * DAY), checkoutDomainCheckedAt: new Date(Date.now() - 2 * DAY) });
    stubNetwork(new Set(), new Set([domain]));
    await recheckCheckoutDomains(Date.now() + 5_000);
    stubNetwork(new Set([domain]));
    await recheckCheckoutDomains(Date.now() + 5_000, new Date(Date.now() + 11 * 60_000));
    const after = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(after.checkoutDomainVerifiedAt).not.toBeNull();
    expect(after.checkoutDomainError).toBeNull();
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "checkout_domain.lost" } })).toBe(0);
    // A later single failure is again only a first strike.
    stubNetwork(new Set(), new Set([domain]));
    await recheckCheckoutDomains(Date.now() + 5_000, new Date(Date.now() + 2 * 3600_000));
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomainVerifiedAt).not.toBeNull();
  });

  it("\"Vérifier\" clicked twice during a short outage never un-verifies: the second strike needs ≥ 10 min", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain, checkoutDomainVerifiedAt: new Date(Date.now() - 2 * DAY), checkoutDomainCheckedAt: new Date(Date.now() - 2 * DAY) });
    stubNetwork(new Set(), new Set([domain]));
    const t0 = new Date();
    expect(await checkStoreDomain(store.id, { now: t0, vercel: false })).toMatchObject({ verified: true, domain });
    const second = await checkStoreDomain(store.id, { now: new Date(t0.getTime() + 20_000), vercel: false });
    expect(second).toMatchObject({ verified: true, domain });
    expect(second.message).toBeTruthy();
    const kept = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(kept.checkoutDomainVerifiedAt).not.toBeNull();
    // The first strike's time is kept: the tick's next run makes the real second check on time.
    expect(kept.checkoutDomainCheckedAt?.getTime()).toBe(t0.getTime());
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "checkout_domain.lost" } })).toBe(0);
    expect(await checkStoreDomain(store.id, { now: new Date(t0.getTime() + 11 * 60_000), vercel: false })).toMatchObject({ verified: false });
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomainVerifiedAt).toBeNull();
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "checkout_domain.lost" } })).toBe(1);
  });

  it("a check that ends after the domain was changed records nothing and sends no event", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const next = `checkout.dom-${rnd()}.test`;
    // Pending domain answering: the merchant switches domains while the ping is in flight.
    const pending = await makeStore({ checkoutDomain: domain });
    const routed = new Set([domain]);
    const fetchMock = stubNetwork(routed);
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string | URL) => {
      await db.store.update({ where: { id: pending.id }, data: { checkoutDomain: next, checkoutDomainVerifiedAt: null } });
      return inner(input);
    });
    expect(await checkStoreDomain(pending.id, { vercel: false })).toMatchObject({ verified: false, domain: null });
    const p = await db.store.findUniqueOrThrow({ where: { id: pending.id } });
    expect(p.checkoutDomain).toBe(next);
    expect(p.checkoutDomainVerifiedAt).toBeNull();
    expect(await db.eventLog.count({ where: { storeId: pending.id, kind: "checkout_domain.verified" } })).toBe(0);
    expect(whop.registerApplePayDomain).not.toHaveBeenCalled();

    // Verified domain on its second failure: the domain is changed during the check → no "lost" alert.
    const old = `checkout.dom-${rnd()}.test`;
    const other = `checkout.dom-${rnd()}.test`;
    const t0 = new Date(Date.now() - 20 * 60_000);
    const verifiedStore = await makeStore({ checkoutDomain: old, checkoutDomainVerifiedAt: new Date(Date.now() - 2 * DAY), checkoutDomainCheckedAt: t0, checkoutDomainError: "dns:down" });
    const down = stubNetwork(new Set(), new Set([old]));
    const downImpl = down.getMockImplementation()!;
    down.mockImplementation(async (input: string | URL) => {
      await db.store.update({ where: { id: verifiedStore.id }, data: { checkoutDomain: other, checkoutDomainVerifiedAt: null, checkoutDomainError: null } });
      return downImpl(input);
    });
    expect(await checkStoreDomain(verifiedStore.id, { vercel: false })).toMatchObject({ verified: false, domain: null });
    expect(await db.eventLog.count({ where: { storeId: verifiedStore.id, kind: "checkout_domain.lost" } })).toBe(0);
    expect((await db.store.findUniqueOrThrow({ where: { id: verifiedStore.id } })).checkoutDomainError).toBeNull();
  });

  it("tick: a healthy verified domain is re-checked every hour only; a store without domain is never pinged", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain, checkoutDomainVerifiedAt: new Date(), checkoutDomainCheckedAt: new Date() });
    await makeStore();
    const fetchMock = stubNetwork(new Set([domain]));
    await recheckCheckoutDomains(Date.now() + 5_000);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(domain))).toHaveLength(0);
    await recheckCheckoutDomains(Date.now() + 5_000, new Date(Date.now() + 30 * 60_000));
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(domain))).toHaveLength(0);
    await recheckCheckoutDomains(Date.now() + 5_000, new Date(Date.now() + 3600_000 + 60_000));
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes(domain))).toHaveLength(1);
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomainVerifiedAt).not.toBeNull();
  });

  it("Apple Pay: not registered while no Apple association file is installed", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain });
    stubNetwork(new Set([domain]));
    const saved = await db.appSetting.findUnique({ where: { key: APPLE_PAY_ASSOCIATION_KEY } });
    await db.appSetting.deleteMany({ where: { key: APPLE_PAY_ASSOCIATION_KEY } });
    try {
      expect((await checkStoreDomain(store.id, { vercel: false })).verified).toBe(true);
      expect(whop.registerApplePayDomain).not.toHaveBeenCalled();
    } finally {
      if (saved) await db.appSetting.create({ data: { key: saved.key, value: saved.value } });
    }
  });

  it("a certificate error without the Vercel API tells the merchant to add the domain in Vercel", async () => {
    vi.stubEnv("VERCEL_API_TOKEN", "");
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain });
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } }))));
    const r = await checkStoreDomain(store.id);
    expect(r.message).toContain("Vercel → Settings → Domains");
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomainError).toMatch(/^tls:/);
    vi.unstubAllEnvs();
  });

  it("a changed or removed domain stays on Vercel 48 h, then the tick removes it (unless a store uses it again)", async () => {
    vi.stubEnv("VERCEL_API_TOKEN", "tok");
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_dom");
    vi.stubEnv("VERCEL_TEAM_ID", "");
    const deleted: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.hostname === "api.vercel.com" && init?.method === "DELETE") deleted.push(decodeURIComponent(url.pathname.split("/").pop()!));
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const store = await makeStore();
    const old = `checkout.dom-${rnd()}.test`;
    const reused = `checkout.dom-${rnd()}.test`;
    const now = new Date();
    await retireCheckoutDomain(store.id, old, now);
    await retireCheckoutDomain(store.id, reused, now);
    expect(await retiredDomainOwner(old)).toBe(store.id);

    await removeRetiredDomains(Date.now() + 5_000, new Date(now.getTime() + RETIRED_DOMAIN_GRACE_MS - 60_000));
    expect(deleted).toEqual([]);

    // Another store takes `reused` meanwhile: only forgotten, never removed from Vercel.
    await makeStore({ checkoutDomain: reused });
    await removeRetiredDomains(Date.now() + 5_000, new Date(now.getTime() + RETIRED_DOMAIN_GRACE_MS + 60_000));
    expect(deleted).toEqual([old]);
    // Also removed from the retiring store's Whop Apple Pay domains (not the one another store uses).
    expect(whop.unregisterApplePayDomain.mock.calls.map((c) => c[1])).toEqual([old]);
    expect(await retiredDomainOwner(old)).toBeNull();
    expect(await retiredDomainOwner(reused)).toBeNull();

    // Saved again before the removal: unretired.
    await retireCheckoutDomain(store.id, old, now);
    await unretireCheckoutDomain(old);
    expect(await retiredDomainOwner(old)).toBeNull();
    vi.unstubAllEnvs();
  });

  it("public session APIs answer 404 on another store's checkout domain (APP_URL, local, own and just-retired domains pass)", async () => {
    const mine = `checkout.dom-${rnd()}.test`;
    const theirs = `checkout.dom-${rnd()}.test`;
    const retired = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: mine, checkoutDomainVerifiedAt: new Date() });
    await makeStore({ checkoutDomain: theirs, checkoutDomainVerifiedAt: new Date() });
    await retireCheckoutDomain(store.id, retired);
    const create = (host: string) =>
      sessionsRoute.POST(
        new Request(`https://${host.split(":")[0]}/api/public/sessions`, {
          method: "POST",
          headers: { host, "content-type": "application/json", "x-forwarded-for": `10.27.${Math.floor(Math.random() * 250)}.1` },
          body: JSON.stringify({ store: store.publicId, items: [{ variant_id: 31, quantity: 1 }] }),
        }),
        { params: Promise.resolve({}) },
      );
    const foreign = await create(theirs);
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toMatchObject({ reason: "foreign_host" });
    expect((await create("unknown-shop.example.org")).status).toBe(404);
    for (const host of ["checkout.example.com", "localhost:5109", "whop-chekout-git-x.vercel.app", mine, retired]) {
      expect((await create(host)).status, host).toBe(200);
    }
    const created = await db.checkoutSession.findFirstOrThrow({ where: { storeId: store.id }, orderBy: { createdAt: "desc" } });
    const prepare = (host: string) =>
      prepareRoute.POST(
        new Request(`https://${host}/api/public/sessions/${created.id}/prepare`, { method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ addOnIds: [], countryCode: "FR" }) }),
        { params: Promise.resolve({ id: created.id }) },
      );
    expect((await prepare(theirs)).status).toBe(404);

    // The other session APIs (thank-you page, "Déjà client ?", funnel beacon, relay points, claims).
    const at = (host: string, path: string, init: RequestInit = {}) => new Request(`https://${host}/api/public/sessions/${created.id}/${path}`, { ...init, headers: { host, "content-type": "application/json", "x-forwarded-for": `10.28.${Math.floor(Math.random() * 250)}.1`, ...(init.headers ?? {}) } });
    const ctx = { params: Promise.resolve({ id: created.id }) };
    const statusRoute = await import("@/app/api/public/sessions/[id]/status/route");
    const progressRoute = await import("@/app/api/public/sessions/[id]/progress/route");
    const pickupRoute = await import("@/app/api/public/sessions/[id]/pickup-points/route");
    const loginRoute = await import("@/app/api/public/sessions/[id]/login-code/route");
    const verifyRoute = await import("@/app/api/public/sessions/[id]/login-code/verify/route");
    const claimRoute = await import("@/app/api/public/sessions/[id]/claim/route");
    const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
    // A fresh e-mail per run: the login-code route rate-limits per e-mail before any lookup.
    const email = `dom-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
    expect((await statusRoute.GET(at(theirs, "status"), ctx)).status).toBe(404);
    expect((await statusRoute.GET(at(mine, "status"), ctx)).status).toBe(200);
    expect((await statusRoute.GET(at("checkout.example.com", "status"), ctx)).status).toBe(200);
    expect((await progressRoute.POST(at(theirs, "progress", post({ step: "email" })), ctx)).status).toBe(404);
    expect((await progressRoute.POST(at(mine, "progress", post({ step: "email" })), ctx)).status).toBe(200);
    expect((await pickupRoute.GET(at(theirs, "pickup-points?country=FR&zip=75001"), ctx)).status).toBe(404);
    expect((await loginRoute.POST(at(theirs, "login-code", post({ email })), ctx)).status).toBe(404);
    expect((await verifyRoute.POST(at(theirs, "login-code/verify", post({ email, code: "123456" })), ctx)).status).toBe(404);
    expect((await verifyRoute.POST(at(mine, "login-code/verify", post({ email, code: "123456" })), ctx)).status).toBe(400);
    expect((await claimRoute.POST(at(theirs, "claim", post({ email, reason: "damaged" })), ctx)).status).toBe(404);
  });

  /** Pings of `domain`: `answers` in order ("timeout" = the fetch times out, "ok" = routed to this app). */
  function stubPings(domain: string, answers: ("timeout" | "ok")[]) {
    let i = 0;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname !== domain) return new Response("DEPLOYMENT_NOT_FOUND", { status: 404 });
      const a = answers[Math.min(i++, answers.length - 1)];
      if (a === "timeout") throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return pingRoute.GET(new Request(url, { headers: { host: url.host } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    return () => fetchMock.mock.calls.filter(([u]) => String(u).includes(domain)).length;
  }

  it("tick: a timeout (cold start) is retried once in the same run before it counts as a failed check", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain, checkoutDomainVerifiedAt: new Date(Date.now() - 2 * DAY), checkoutDomainCheckedAt: new Date(Date.now() - 2 * DAY) });
    let pings = stubPings(domain, ["timeout", "ok"]);
    await recheckCheckoutDomains(Date.now() + 5_000);
    expect(pings()).toBe(2);
    const healthy = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(healthy.checkoutDomainVerifiedAt).not.toBeNull();
    expect(healthy.checkoutDomainError).toBeNull();

    // Two timeouts in the run: now a (first) failed check, recorded as a timeout.
    pings = stubPings(domain, ["timeout", "timeout"]);
    // Other test stores are due at that time too (5 per run): a few runs at the same instant.
    const later = new Date(Date.now() + 2 * 3600_000);
    for (let i = 0; i < 4; i++) await recheckCheckoutDomains(Date.now() + 5_000, later);
    expect(pings()).toBe(2);
    const struck = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(struck.checkoutDomainVerifiedAt).not.toBeNull();
    expect(struck.checkoutDomainError).toMatch(/^timeout:/);

    // No time left in the job's slice for the retry: a verified domain's timeout is not a strike.
    pings = stubPings(domain, ["timeout"]);
    const before = struck.checkoutDomainCheckedAt!.getTime();
    const r = await checkStoreDomain(store.id, { now: new Date(Date.now() + 3 * 3600_000), vercel: false, timeoutMs: 50, timeoutRetry: { deadline: Date.now() } });
    expect(r).toMatchObject({ verified: true, message: null });
    expect(pings()).toBe(1);
    const untouched = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(untouched.checkoutDomainVerifiedAt).not.toBeNull();
    expect(untouched.checkoutDomainCheckedAt!.getTime()).toBe(before);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "checkout_domain.lost" } })).toBe(0);
  });

  it("verified again within 24 h of the last verification (a flap): no second journal entry, no Apple Pay re-registration", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    const store = await makeStore({ checkoutDomain: domain });
    stubNetwork(new Set([domain]));
    expect((await checkStoreDomain(store.id, { vercel: false })).verified).toBe(true);
    expect(whop.registerApplePayDomain).toHaveBeenCalledTimes(1);
    const verifiedEvents = () => db.eventLog.count({ where: { storeId: store.id, kind: "checkout_domain.verified" } });
    expect(await verifiedEvents()).toBe(1);

    // Lost on two separate checks, then back.
    stubNetwork(new Set(), new Set([domain]));
    const t0 = Date.now();
    await checkStoreDomain(store.id, { now: new Date(t0), vercel: false });
    await checkStoreDomain(store.id, { now: new Date(t0 + 11 * 60_000), vercel: false });
    const lost = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(lost.checkoutDomainVerifiedAt).toBeNull();
    expect(lost.checkoutDomainPendingSince?.getTime()).toBe(t0 + 11 * 60_000);
    stubNetwork(new Set([domain]));
    expect((await checkStoreDomain(store.id, { now: new Date(t0 + 22 * 60_000), vercel: false })).verified).toBe(true);
    expect(await verifiedEvents()).toBe(1);
    expect(whop.registerApplePayDomain).toHaveBeenCalledTimes(1);
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).checkoutDomainPendingSince).toBeNull();

    // The last verification is more than 24 h old: a real transition again (journal + Apple Pay).
    await db.eventLog.updateMany({ where: { storeId: store.id, kind: "checkout_domain.verified" }, data: { createdAt: new Date(t0 - 25 * 3600_000) } });
    await db.store.update({ where: { id: store.id }, data: { checkoutDomainVerifiedAt: null } });
    expect((await checkStoreDomain(store.id, { vercel: false })).verified).toBe(true);
    expect(await verifiedEvents()).toBe(2);
    expect(whop.registerApplePayDomain).toHaveBeenCalledTimes(2);
  });

  it("tick: pending domains back off — every 10 min for 48 h, hourly until 7 days, then daily", async () => {
    const now = Date.now();
    const pending = async (pendingForMs: number, checkedAgoMs: number) => {
      const domain = `checkout.dom-${rnd()}.test`;
      await makeStore({ checkoutDomain: domain, checkoutDomainPendingSince: new Date(now - pendingForMs), checkoutDomainCheckedAt: new Date(now - checkedAgoMs) });
      return domain;
    };
    const fresh = await pending(3600_000, 11 * 60_000); // due (10 min)
    const slowNotDue = await pending(3 * DAY, 20 * 60_000); // hourly: not yet
    const slowDue = await pending(3 * DAY, 61 * 60_000); // hourly: due
    const dailyNotDue = await pending(8 * DAY, 2 * 3600_000); // daily: not yet
    const dailyDue = await pending(8 * DAY, 25 * 3600_000); // daily: due
    const fetchMock = stubNetwork(new Set());
    // Other test stores may be due too (5 per run): a few runs at the same instant.
    for (let i = 0; i < 4; i++) await recheckCheckoutDomains(Date.now() + 5_000, new Date(now));
    const pinged = (d: string) => fetchMock.mock.calls.filter(([u]) => String(u).includes(d)).length;
    expect(pinged(fresh)).toBe(1);
    expect(pinged(slowDue)).toBe(1);
    expect(pinged(dailyDue)).toBe(1);
    expect(pinged(slowNotDue)).toBe(0);
    expect(pinged(dailyNotDue)).toBe(0);
  });

  it("checkoutDomain is unique across stores", async () => {
    const domain = `checkout.dom-${rnd()}.test`;
    await makeStore({ checkoutDomain: domain });
    await expect(makeStore({ checkoutDomain: domain })).rejects.toMatchObject({ code: "P2002" });
  });
});
