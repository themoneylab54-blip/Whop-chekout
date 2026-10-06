import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Express buttons sooner: the Whop checkout prepared right after the session's creation (after()),
 * with the input of the page's first /prepare, which then reuses it (same fingerprint, no second
 * Whop configuration), including when both run at once (the claim). Real Postgres; Shopify and
 * Whop mocked. Test data: eprep_.
 */

const shopify = vi.hoisted(() => ({ priceCart: vi.fn() }));
const whop = vi.hoisted(() => ({ createCheckoutConfiguration: vi.fn(), storeClient: vi.fn() }));
const stripeApi = vi.hoisted(() => ({
  createOrUpdatePaymentIntent: vi.fn(),
  ensureStripeCustomer: vi.fn(),
  probeStripe: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  cancelOpenPaymentIntents: vi.fn(),
}));
const afterQueue = vi.hoisted(() => [] as (() => unknown)[]);

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn) }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), ...stripeApi }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), sendAlert: vi.fn(), sendEmail: vi.fn() }));

const hasDb = !!process.env.DATABASE_URL;

describe("firstLoadCountry: the country the page pre-selects (CheckoutView's rules)", async () => {
  const { firstLoadCountry, pageProtectionDefault } = await import("@/lib/early-prepare");
  const { pickFirstCountry, checkoutCountries, countryHints } = await import("@/lib/first-country");
  const { createBlock, defaultCheckoutLayout } = await import("@/lib/layout");
  const rates = [{ countries: ["FR", "BE"] }];
  const fr = { language: "fr" as const };

  it("the IP country when shipped to, else the browser locale's, else the main market, else the language's, else the first listed", async () => {
    expect(await firstLoadCountry(rates, "BE", "fr-FR", fr)).toBe("BE");
    expect(await firstLoadCountry(rates, "US", "fr-BE,fr;q=0.9", fr)).toBe("BE");
    expect(await firstLoadCountry(rates, null, "nl-BE", fr)).toBe("BE");
    // Neither served: the store's main market (asked only then), not the language's country.
    const primary = vi.fn(async () => "BE");
    expect(await firstLoadCountry(rates, "US", "en-US", { language: "fr", primary })).toBe("BE");
    expect(primary).toHaveBeenCalledTimes(1);
    primary.mockClear();
    expect(await firstLoadCountry(rates, "FR", "en-US", { language: "fr", primary })).toBe("FR");
    expect(primary).not.toHaveBeenCalled();
    // No main market: a rate dedicated to one or two countries (merchant's first), else the
    // language's country, else the most common market shipped to — never the alphabetically first.
    expect(await firstLoadCountry(rates, null, null, fr)).toBe("FR");
    expect(await firstLoadCountry([{ countries: ["DE", "BE"] }], null, null, { language: "en" })).toBe("DE");
    expect(await firstLoadCountry([{ countries: ["DZ", "MA", "US"] }], "FR", "fr-FR", { language: "fr", primary: async () => null })).toBe("US");
    // A failing main-market lookup never throws.
    expect(await firstLoadCountry(rates, "US", null, { language: "fr", primary: async () => Promise.reject(new Error("db")) })).toBe("FR");
    // A rate for every country: the IP country as is.
    expect(await firstLoadCountry([{ countries: [] }], "DE", null, fr)).toBe("DE");
  });

  it("the same helpers as CheckoutView's first address (pickFirstCountry over the page's sorted list)", () => {
    const codes = checkoutCountries([{ countries: ["DE", "BE"], active: true }, { countries: ["NL"], active: false }], "fr").map((c) => c.code);
    // Sorted by name in the checkout's language (Allemagne, Belgique), inactive rates left out.
    expect(codes).toEqual(["DE", "BE"]);
    expect(pickFirstCountry(codes, { initialCountry: "US", localeCountry: null, primaryCountry: "BE", language: "fr" })).toBe("BE");
    expect(countryHints(rates, "US", "en-US")).toEqual({ served: false, localeCountry: null, needsPrimary: true });
  });

  it("the protection the page sends on load: the visible block's default, nothing without the block", () => {
    const layout = defaultCheckoutLayout();
    expect(pageProtectionDefault({ ...layout, blocks: layout.blocks.filter((b) => b.type !== "shipping_protection") })).toBeUndefined();
    const on = createBlock("shipping_protection");
    (on.props as { defaultOn: boolean }).defaultOn = true;
    expect(pageProtectionDefault({ ...layout, blocks: [...layout.blocks.filter((b) => b.type !== "shipping_protection"), on] })).toBe(true);
    expect(pageProtectionDefault({ ...layout, blocks: [...layout.blocks.filter((b) => b.type !== "shipping_protection"), { ...on, hidden: true }] })).toBeUndefined();
  });
});

describe.skipIf(!hasDb)("early prepare at session creation (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { createBlock, defaultCheckoutLayout } = await import("@/lib/layout");
  const { prepareAhead } = await import("@/lib/early-prepare");
  const sessionsRoute = await import("@/app/api/public/sessions/route");
  const prepareRoute = await import("@/app/api/public/sessions/[id]/prepare/route");

  const created: string[] = [];
  const line = {
    variantId: "gid://shopify/ProductVariant/11",
    productId: "gid://shopify/Product/1",
    productHandle: "bougie",
    title: "Bougie",
    variantTitle: null,
    sku: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 3900,
    compareAtCents: null,
    inventory: null,
    requiresShipping: true,
  };
  let ip = 0;
  const nextIp = () => `10.77.${Math.floor(++ip / 200)}.${ip % 200}`;

  async function makeStore(extra: Record<string, unknown> = {}) {
    // The shipping protection block on by default: the page sends `protection: true`, the early prepare leaves it to the quote.
    const layout = defaultCheckoutLayout();
    const protection = createBlock("shipping_protection");
    (protection.props as { defaultOn: boolean }).defaultOn = true;
    layout.blocks.splice(1, 0, protection);
    const store = await db.store.create({
      data: {
        name: `eprep_${Math.random().toString(36).slice(2, 8)}`,
        enabled: true,
        testMode: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_eprep",
        whopProductId: "prod_eprep",
        whopApiKey: encrypt("k"),
        shopDomain: `eprep-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        checkoutLayout: layout as never,
        ...extra,
      },
    });
    created.push(store.id);
    await db.shippingRate.create({ data: { storeId: store.id, name: "Colissimo", countries: ["FR", "BE"], priceCents: 490, position: 0 } });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Express", countries: ["FR"], priceCents: 990, position: 1 } });
    return store;
  }

  /** The storefront loader's request: the IP country and locale headers of the buyer's browser. */
  async function createSession(publicId: string) {
    const res = await sessionsRoute.POST(
      new Request("https://checkout.example.com/api/public/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": nextIp(), "x-vercel-ip-country": "FR", "accept-language": "fr-FR,fr;q=0.9" },
        body: JSON.stringify({ store: publicId, items: [{ variant_id: 11, quantity: 1 }] }),
      }),
      { params: Promise.resolve({}) },
    );
    expect(res.status).toBe(200);
    return (await res.json()).id as string;
  }

  /** The page's first /prepare, exactly as CheckoutView sends it on load. */
  function pagePrepare(sessionId: string, over: Record<string, unknown> = {}) {
    return prepareRoute.POST(
      new Request(`https://checkout.example.com/api/public/sessions/${sessionId}/prepare`, {
        method: "POST",
        headers: { "content-type": "application/json", host: "checkout.example.com", "x-forwarded-for": nextIp() },
        body: JSON.stringify({ countryCode: "FR", shippingRateId: null, discountCode: null, addOnIds: [], protection: true, ...over }),
      }),
      { params: Promise.resolve({ id: sessionId }) },
    );
  }

  const runAfter = async () => {
    const jobs = afterQueue.splice(0);
    await Promise.all(jobs.map((fn) => fn()));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    afterQueue.length = 0;
    shopify.priceCart.mockResolvedValue([line]);
    let n = 0;
    whop.createCheckoutConfiguration.mockImplementation(async (_store: unknown, opts: { sessionId: string }) => {
      await new Promise((r) => setTimeout(r, 200));
      return { id: `ch_eprep_${opts.sessionId}_${++n}`, purchaseUrl: null, paypal: true };
    });
    whop.storeClient.mockReturnValue({ checkoutConfigurations: { delete: vi.fn().mockResolvedValue(undefined) } });
    stripeApi.ensureStripeCustomer.mockResolvedValue("cus_eprep");
    stripeApi.probeStripe.mockResolvedValue(undefined);
    stripeApi.cancelOpenPaymentIntents.mockResolvedValue([]);
    let pi = 0;
    stripeApi.createOrUpdatePaymentIntent.mockImplementation(async (_store: unknown, _s: unknown, target: { amountCents: number; currency: string }) => {
      const id = `pi_eprep${Date.now().toString(36)}_${++pi}`;
      return { id, clientSecret: `${id}_secret_x`, status: "requires_payment_method", customerId: null, amount: target.amountCents, currency: target.currency.toLowerCase(), offSessionSaved: true };
    });
  });

  afterAll(async () => {
    await db.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: "prep:" } }, ...created.map((id) => ({ key: { startsWith: `paypal:${id}:` } }))] } });
    await db.rateLimit.deleteMany({ where: { key: { contains: "10.77." } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("the page's first /prepare reuses the checkout prepared at the session's creation (same fingerprint)", async () => {
    const store = await makeStore();
    const id = await createSession(store.publicId);
    expect(afterQueue.length).toBeGreaterThan(0);
    await runAfter();
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
    const early = await db.checkoutQuote.findMany({ where: { sessionId: id } });
    expect(early).toHaveLength(1);
    // Ready, but not marked as shown to the buyer (the funnel's "form ready" stays the page's).
    const before = await db.checkoutSession.findUniqueOrThrow({ where: { id } });
    expect(before.preparedAt).toBeNull();
    expect(before.whopCheckoutId).toBe(early[0].whopCheckoutId);
    // Its return URL is the checkout page's own host (the loader's answer).
    expect(whop.createCheckoutConfiguration.mock.calls[0][1]).toMatchObject({ country: "FR", redirectUrl: `https://checkout.example.com/c/${id}/merci` });

    const res = await pagePrepare(id);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.checkoutConfigurationId).toBe(early[0].whopCheckoutId);
    expect(body.paypal).toBe(true);
    // No second Whop configuration, no second snapshot: the same fingerprint.
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
    const after = await db.checkoutQuote.findMany({ where: { sessionId: id } });
    expect(after.map((q) => q.fingerprint)).toEqual([early[0].fingerprint]);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id } })).preparedAt).not.toBeNull();
    expect(await db.appSetting.count({ where: { key: { startsWith: `prep:${id}:` } } })).toBe(0);
  });

  it("the page's /prepare arriving while the early one still waits on Whop waits for it (one configuration)", async () => {
    const store = await makeStore();
    const id = await createSession(store.publicId);
    afterQueue.length = 0;
    const ahead = prepareAhead(id, { ipCountry: "FR", acceptLanguage: "fr-FR" });
    await new Promise((r) => setTimeout(r, 60));
    const [ok, res] = await Promise.all([ahead, pagePrepare(id)]);
    expect(ok).toBe(true);
    expect(res.status).toBe(200);
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
    const quotes = await db.checkoutQuote.findMany({ where: { sessionId: id } });
    expect(quotes).toHaveLength(1);
    expect((await res.json()).checkoutConfigurationId).toBe(quotes[0].whopCheckoutId);
  });

  it("the page prepared first with another input (Express): the early prepare finishing last leaves the session as the page set it", async () => {
    const store = await makeStore();
    const id = await createSession(store.publicId);
    afterQueue.length = 0;
    const express = await db.shippingRate.findFirstOrThrow({ where: { storeId: store.id, name: "Express" } });
    // The early prepare's Whop call is slow; the page's (another fingerprint: no claim to wait on) is quick.
    let n = 0;
    whop.createCheckoutConfiguration.mockImplementation(async (_store: unknown, opts: { sessionId: string }) => {
      const call = ++n;
      await new Promise((r) => setTimeout(r, call === 1 ? 600 : 20));
      return { id: `ch_eprep_race_${opts.sessionId}_${call}`, purchaseUrl: null, paypal: true };
    });
    const ahead = prepareAhead(id, { ipCountry: "FR", acceptLanguage: "fr-FR" });
    await new Promise((r) => setTimeout(r, 100));
    const res = await pagePrepare(id, { shippingRateId: express.id });
    expect(res.status).toBe(200);
    const pageConfig = (await res.json()).checkoutConfigurationId;
    const afterPage = await db.checkoutSession.findUniqueOrThrow({ where: { id } });
    expect(afterPage.whopCheckoutId).toBe(pageConfig);
    expect(afterPage.preparedAt).not.toBeNull();
    // The early one ends last: quietly steps aside (no already_paid), the session unchanged.
    await expect(ahead).resolves.toBe(true);
    const final = await db.checkoutSession.findUniqueOrThrow({ where: { id } });
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(2);
    expect(final.whopCheckoutId).toBe(pageConfig);
    expect(final.preparedTotalCents).toBe(afterPage.preparedTotalCents);
    expect(final.shippingRateId).toBe(express.id);
    expect(final.preparedAt?.getTime()).toBe(afterPage.preparedAt?.getTime());
  });

  it("an early prepare that fails leaves nothing behind: the page prepares as usual", async () => {
    const store = await makeStore();
    const id = await createSession(store.publicId);
    whop.createCheckoutConfiguration.mockRejectedValueOnce(Object.assign(new Error("Whop down"), { status: 503 }));
    await runAfter();
    expect(await db.checkoutQuote.count({ where: { sessionId: id } })).toBe(0);
    expect(await db.appSetting.count({ where: { key: { startsWith: `prep:${id}:` } } })).toBe(0);
    // Nothing journaled for the store (the page's own prepare handles a processor failure).
    expect(await db.eventLog.count({ where: { sessionId: id } })).toBe(0);
    const res = await pagePrepare(id);
    expect(res.status).toBe(200);
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(2);
  });

  it("main market ≠ IP country, protection on by default: the early prepare's fingerprint is the page's first one", async () => {
    const store = await makeStore();
    // The store's main market: Belgium (its paid orders), while the first rate starts with France.
    const paid = await createSession(store.publicId);
    await db.checkoutSession.update({ where: { id: paid }, data: { status: "PAID", shippingAddress: { countryCode: "BE" } as never } });
    const id = await createSession(store.publicId);
    afterQueue.length = 0;
    vi.clearAllMocks();
    // A US visitor (not shipped to) with an English browser: the page pre-selects the main market.
    expect(await prepareAhead(id, { ipCountry: "US", acceptLanguage: "en-US,en;q=0.9" })).toBe(true);
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
    expect(whop.createCheckoutConfiguration.mock.calls[0][1]).toMatchObject({ country: "BE" });
    const early = await db.checkoutQuote.findMany({ where: { sessionId: id } });
    expect(early).toHaveLength(1);
    // Protection on (the block's default) in the early snapshot, as on the page.
    expect((early[0] as unknown as { addOns: { id: string }[] }).addOns.some((a) => a.id === "shipping_protection")).toBe(true);
    // The page's first /prepare: Belgium, protection: true (its default).
    const res = await pagePrepare(id, { countryCode: "BE", protection: true });
    expect(res.status).toBe(200);
    expect((await res.json()).checkoutConfigurationId).toBe(early[0].whopCheckoutId);
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
    const all = await db.checkoutQuote.findMany({ where: { sessionId: id } });
    expect(new Set(all.map((q) => q.fingerprint))).toEqual(new Set([early[0].fingerprint]));
  });

  describe("a slow Whop never makes a second configuration", async () => {
    const { isDeletedFingerprint, snapshotClaimTimings, sweepSnapshotClaims } = await import("@/lib/checkout");
    const saved = { ...snapshotClaimTimings };
    const slow = (ms: number) => {
      let n = 0;
      whop.createCheckoutConfiguration.mockImplementation(async (_store: unknown, opts: { sessionId: string }) => {
        await new Promise((r) => setTimeout(r, ms));
        return { id: `ch_eprep_slow_${opts.sessionId}_${++n}`, purchaseUrl: null, paypal: true };
      });
    };
    afterEach(() => Object.assign(snapshotClaimTimings, saved));

    it("Whop slower than the claim's lifetime: the page's /prepare keeps waiting (claim kept fresh), one configuration", async () => {
      Object.assign(snapshotClaimTimings, { claimMs: 500, heartbeatMs: 120, waitMs: 8_000, pollMs: 50 });
      const store = await makeStore();
      const id = await createSession(store.publicId);
      afterQueue.length = 0;
      slow(1_800);
      const ahead = prepareAhead(id, { ipCountry: "FR", acceptLanguage: "fr-FR" });
      await new Promise((r) => setTimeout(r, 100));
      const [ok, res] = await Promise.all([ahead, pagePrepare(id)]);
      expect(ok).toBe(true);
      expect(res.status).toBe(200);
      expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
      const quotes = await db.checkoutQuote.findMany({ where: { sessionId: id } });
      expect(quotes).toHaveLength(1);
      expect((await res.json()).checkoutConfigurationId).toBe(quotes[0].whopCheckoutId);
      // The claim released before the answers (awaited).
      expect(await db.appSetting.count({ where: { key: { startsWith: `prep:${id}:` } } })).toBe(0);
    });

    it("two waiters of a crashed request (stale claim): one takes over atomically, the other reuses its configuration", async () => {
      Object.assign(snapshotClaimTimings, { claimMs: 300, heartbeatMs: 100, waitMs: 8_000, pollMs: 50 });
      const store = await makeStore();
      const id = await createSession(store.publicId);
      afterQueue.length = 0;
      // A first page prepare creates the claim key's shape: read it from a quick run, then simulate a crash.
      slow(400);
      const first = pagePrepare(id);
      await new Promise((r) => setTimeout(r, 100));
      const claimRow = await db.appSetting.findFirstOrThrow({ where: { key: { startsWith: `prep:${id}:` } } });
      await first;
      await db.checkoutQuote.deleteMany({ where: { sessionId: id } });
      vi.clearAllMocks();
      slow(600);
      // The crashed request's claim: still there, no longer refreshed.
      await db.appSetting.create({ data: { key: claimRow.key, value: "claimed", updatedAt: new Date(Date.now() - 200) } });
      const [a, b] = await Promise.all([pagePrepare(id), pagePrepare(id)]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
      const [ja, jb] = await Promise.all([a.json(), b.json()]);
      expect(ja.checkoutConfigurationId).toBe(jb.checkoutConfigurationId);
    });

    it("the other request still alive past the longest wait, no Stripe: Whop unavailable (503, not retried by the page), never a second configuration", async () => {
      Object.assign(snapshotClaimTimings, { claimMs: 5_000, heartbeatMs: 1_000, waitMs: 400, pollMs: 50 });
      const store = await makeStore();
      const id = await createSession(store.publicId);
      afterQueue.length = 0;
      slow(1_500);
      const ahead = prepareAhead(id, { ipCountry: "FR", acceptLanguage: "fr-FR" });
      await new Promise((r) => setTimeout(r, 100));
      const t0 = Date.now();
      const res = await pagePrepare(id);
      // Bounded from the request's start (not 55 s), and its own code: the page stops its silent
      // retries (each would wait as long again) and shows « paiement indisponible / réessayer ».
      expect(Date.now() - t0).toBeLessThan(1_200);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("whop_unavailable");
      await ahead;
      expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
      // Journaled as Whop's failure (counts towards the store's failover).
      const journal = await db.eventLog.findFirst({ where: { sessionId: id, kind: "checkout.init_failed" } });
      expect(journal?.data).toMatchObject({ source: "whop" });
    });

    describe("Stripe connected", () => {
      const STRIPE_ENV = { STRIPE_TEST_SECRET_KEY: "sk_test_eprep", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_eprep", STRIPE_TEST_CLIENT_ID: "ca_test_eprep" };
      beforeAll(() => void Object.assign(process.env, STRIPE_ENV));
      afterAll(() => {
        for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
      });

      it("Whop hanging under the early prepare's claim: the page's /prepare switches to Stripe within its budget", async () => {
        Object.assign(snapshotClaimTimings, { claimMs: 5_000, heartbeatMs: 1_000, waitMs: 500, pollMs: 50 });
        const store = await makeStore({ stripeAccountId: "acct_eprep", stripeConnectedAt: new Date(), stripeLivemode: false });
        const id = await createSession(store.publicId);
        afterQueue.length = 0;
        slow(3_000);
        const ahead = prepareAhead(id, { ipCountry: "FR", acceptLanguage: "fr-FR" });
        await new Promise((r) => setTimeout(r, 100));
        const t0 = Date.now();
        const res = await pagePrepare(id);
        expect(Date.now() - t0).toBeLessThan(2_000);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ provider: "stripe", switchedFrom: "whop" });
        expect(stripeApi.createOrUpdatePaymentIntent).toHaveBeenCalledTimes(1);
        const journal = await db.eventLog.findFirst({ where: { sessionId: id, kind: "checkout.init_failed" } });
        expect(journal?.data).toMatchObject({ source: "whop" });
        // The early prepare finishing later never takes the session back to Whop.
        await ahead;
        expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
        expect((await db.checkoutSession.findUniqueOrThrow({ where: { id } })).paymentProvider).toBe("stripe");
        // Nor leaves its Whop configuration live next to the PaymentIntent: marked deleted, deleted at Whop.
        await runAfter();
        const whopQuotes = await db.checkoutQuote.findMany({ where: { sessionId: id, provider: "whop" } });
        expect(whopQuotes).toHaveLength(1);
        expect(isDeletedFingerprint(whopQuotes[0].fingerprint)).toBe(true);
        const deleted = whop.storeClient.mock.results.flatMap((r) => (r.value.checkoutConfigurations.delete as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].id));
        expect(deleted).toContain(whopQuotes[0].whopCheckoutId);
      });

      it("another tab switches the session to Stripe while this /prepare waits on Whop: never written back to Whop, Stripe's form answered, the new Whop configuration deleted", async () => {
        const store = await makeStore({ stripeAccountId: "acct_eprep", stripeConnectedAt: new Date(), stripeLivemode: false });
        const id = await createSession(store.publicId);
        // No early prepare: this page's /prepare makes the Whop configuration itself (slowly).
        afterQueue.length = 0;
        slow(600);
        const pending = pagePrepare(id);
        await new Promise((r) => setTimeout(r, 200));
        // The other tab's switch (its Stripe prepare done meanwhile): on Stripe, prepared, its PaymentIntent open.
        await db.checkoutSession.update({ where: { id }, data: { paymentProvider: "stripe", preparedAt: new Date(), stripePaymentIntentId: "pi_other_tab" } });
        const res = await pending;
        expect(res.status).toBe(200);
        // The session as it is now: Stripe's form (its PaymentIntent), not a Whop checkout.
        expect(await res.json()).toMatchObject({ provider: "stripe" });
        const session = await db.checkoutSession.findUniqueOrThrow({ where: { id } });
        expect(session.paymentProvider).toBe("stripe");
        expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
        await runAfter();
        // Never a Stripe PaymentIntent canceled under the other tab (this request never wrote Whop).
        expect(stripeApi.cancelOpenPaymentIntents).not.toHaveBeenCalled();
        // The Whop configuration this request made: marked deleted and deleted at Whop (no live leftover).
        const whopQuotes = await db.checkoutQuote.findMany({ where: { sessionId: id, provider: "whop" } });
        expect(whopQuotes).toHaveLength(1);
        expect(isDeletedFingerprint(whopQuotes[0].fingerprint)).toBe(true);
        const deleted = whop.storeClient.mock.results.flatMap((r) => (r.value.checkoutConfigurations.delete as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].id));
        expect(deleted).toContain(whopQuotes[0].whopCheckoutId);
      });
    });

    it("too little of the request's budget left: a stale claim is never taken over (the tagged Whop failure instead)", async () => {
      // Never 25 s left of a 1 s budget: no takeover at all.
      Object.assign(snapshotClaimTimings, { claimMs: 300, heartbeatMs: 100, waitMs: 8_000, pollMs: 50, budgetMs: 1_000 });
      const store = await makeStore();
      const id = await createSession(store.publicId);
      afterQueue.length = 0;
      // The claim key's shape, read from a quick run (then its snapshot dropped).
      slow(400);
      const first = pagePrepare(id);
      await new Promise((r) => setTimeout(r, 100));
      const claimRow = await db.appSetting.findFirstOrThrow({ where: { key: { startsWith: `prep:${id}:` } } });
      expect((await first).status).toBe(200);
      await db.checkoutQuote.deleteMany({ where: { sessionId: id } });
      vi.clearAllMocks();
      slow(50);
      // A crashed request's claim, stale.
      await db.appSetting.create({ data: { key: claimRow.key, value: "claimed", updatedAt: new Date(Date.now() - 2_000) } });
      const res = await pagePrepare(id);
      expect(res.status).toBe(503);
      expect((await res.json()).code).toBe("whop_unavailable");
      expect(whop.createCheckoutConfiguration).not.toHaveBeenCalled();
      await db.appSetting.deleteMany({ where: { key: claimRow.key } });
    });

    it("the tick sweeps claim rows older than 15 min (a crash between claim and release)", async () => {
      const old = `prep:eprep_sweep_old:${Date.now()}`;
      const fresh = `prep:eprep_sweep_new:${Date.now()}`;
      await db.appSetting.create({ data: { key: old, value: "claimed", updatedAt: new Date(Date.now() - 16 * 60_000) } });
      await db.appSetting.create({ data: { key: fresh, value: "claimed", updatedAt: new Date(Date.now() - 60_000) } });
      expect(await sweepSnapshotClaims()).toBeGreaterThanOrEqual(1);
      expect(await db.appSetting.count({ where: { key: old } })).toBe(0);
      expect(await db.appSetting.count({ where: { key: fresh } })).toBe(1);
      const { cleanup } = await import("@/lib/tick");
      await db.appSetting.update({ where: { key: fresh }, data: { updatedAt: new Date(Date.now() - 20 * 60_000) } });
      await cleanup();
      expect(await db.appSetting.count({ where: { key: fresh } })).toBe(0);
    });
  });
});
