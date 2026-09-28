import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Round 12 (correctness) against a real Postgres: the Shopify code usage limit with a lagging
 * Shopify count, claim photo uploads under Vercel's body limit, replacement orders (no duplicate
 * after a timeout, full content, lines chosen by the merchant), Google Ads offline conversions
 * (test orders, account-wide errors, adjustments, health), partial refunds in whole-unit
 * currencies, checkout tests (atomic promote, one running per element, arm A frozen, signed
 * visitor ids) and store time zones. Shopify, Whop, Google and notifications are mocked.
 * Test data is prefixed c12fix_ and deleted at the end.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
  shopifyGraphql: vi.fn(),
}));
const whop = vi.hoisted(() => ({ createCheckoutConfiguration: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendBuyerEmail: vi.fn() }));
const afterQueue = vi.hoisted(() => [] as (() => unknown)[]);

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn) }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const MIN = 60_000;
const DAY = 86_400_000;

describe.skipIf(!hasDb)("round 12 correctness (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { prepareSession, markPaid, quoteSession } = await import("@/lib/checkout");
  const { clearShopifyDiscountCache } = await import("@/lib/shopify-discounts");
  const { ShopifyError } = await import("@/lib/shopify");
  const { decideClaim, createReplacementOrder } = await import("@/lib/claims");
  const { uploadGoogleConversions, adjustGoogleConversions, changeConversionAction } = await import("@/lib/google-conversions");
  const { startCheckoutTest, endCheckoutTest } = await import("@/lib/checkout-tests");
  const { storeHealth } = await import("@/lib/health");
  const { verifyVisitorId } = await import("@/lib/visitor");
  const { isStorableTimeZone, sqlTimeZone } = await import("@/lib/time-db");
  const claimRoute = await import("@/app/api/public/sessions/[id]/claim/route");
  const sessionsRoute = await import("@/app/api/public/sessions/route");

  const created: string[] = [];

  const line = (o: Record<string, unknown> = {}) => ({
    variantId: "gid://shopify/ProductVariant/11",
    productId: "gid://shopify/Product/1",
    productHandle: "sweat",
    title: "Sweat",
    variantTitle: null,
    sku: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 5000,
    compareAtCents: null,
    inventory: null,
    requiresShipping: true,
    ...o,
  });
  const address = { firstName: "Alex", lastName: "Martin", address1: "1 rue X", city: "Paris", zip: "75001", countryCode: "FR" };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `c12fix_${Math.random().toString(36).slice(2, 8)}`,
        testMode: false,
        vatExempt: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_c12",
        whopProductId: "prod_c12",
        whopApiKey: encrypt("k"),
        shopDomain: `c12fix-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        shopifyScopes: "read_products,write_orders,read_discounts",
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  const shopifyCode = (o: Record<string, unknown> = {}) => ({
    codeDiscountNodeByCode: {
      codeDiscount: {
        __typename: "DiscountCodeBasic",
        title: "Code",
        status: "ACTIVE",
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: null,
        usageLimit: null,
        asyncUsageCount: 0,
        appliesOncePerCustomer: false,
        context: { __typename: "DiscountBuyerSelectionAll" },
        minimumRequirement: null,
        customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 }, items: { __typename: "AllDiscountItems", allItems: true } },
        ...o,
      },
    },
  });

  async function preparedWith(storeId: string, code: string, email: string) {
    const s = await db.checkoutSession.create({ data: { storeId, currency: "EUR", lines: [line()], subtotalCents: 5000 }, include: { store: true } });
    const prepared = await prepareSession(s, { discountCode: code, addOnIds: [], countryCode: "FR" });
    await db.checkoutSession.update({ where: { id: s.id }, data: { email, shippingAddress: address } });
    return { session: s, configId: prepared.checkoutConfigurationId, totals: prepared.totals };
  }

  /** A past paid use of `code` recorded in the ledger, its Shopify order recorded at `orderAt` (null: not created). */
  async function pastUse(storeId: string, code: string, o: { orderAt: Date | null; usedAt: Date }) {
    const s = await db.checkoutSession.create({
      data: {
        storeId,
        currency: "EUR",
        lines: [line()],
        status: "PAID",
        paidAt: o.usedAt,
        discountCode: code,
        ...(o.orderAt ? { shopifyOrderId: `gid://shopify/Order/${Math.floor(Math.random() * 1e9)}`, shopifyOrderName: "#9", shopifyOrderAt: o.orderAt } : {}),
      },
    });
    await db.shopifyCodeUse.create({ data: { storeId, code, sessionId: s.id, email: `past-${s.id}@c12fix.test`, createdAt: o.usedAt } });
    return s;
  }


  /** A paid order with its paid snapshot (lines, add-ons). */
  async function paidOrder(storeId: string, data: Record<string, unknown> = {}, addOns: unknown[] = []) {
    const session = await db.checkoutSession.create({
      data: { storeId, currency: "EUR", status: "PAID", lines: [line()], subtotalCents: 5000, totalCents: 5000, paidAt: new Date(), shippingAddress: address, ...data } as never,
    });
    const q = await db.checkoutQuote.create({
      data: {
        sessionId: session.id,
        whopCheckoutId: `ch_${session.id}`,
        fingerprint: "f",
        currency: "EUR",
        subtotalCents: session.subtotalCents,
        discountCents: 0,
        shippingCents: 0,
        addOnsCents: 0,
        totalCents: session.totalCents,
        addOns: addOns as never,
        addOnIds: [],
        lines: (data.lines ?? [line()]) as never,
      },
    });
    return db.checkoutSession.update({ where: { id: session.id }, data: { paidQuoteId: q.id } });
  }

  const googleStore = (data: Record<string, unknown> = {}) =>
    makeStore({
      googleAdsCustomerId: "1234567890",
      googleAdsDeveloperToken: encrypt("dev"),
      googleAdsClientId: "abc.apps.googleusercontent.com",
      googleAdsClientSecret: encrypt("sec"),
      googleAdsRefreshToken: encrypt("ref"),
      googleAdsConversionAction: "customers/1234567890/conversionActions/555",
      ...data,
    });

  /** Google's endpoints: OAuth token, click uploads and adjustments answered by the given handlers. */
  function stubGoogle(h: { token?: () => Response; upload?: (body: Record<string, unknown>) => Response; adjust?: (body: Record<string, unknown>) => Response }) {
    const calls = { upload: [] as Record<string, unknown>[], adjust: [] as Record<string, unknown>[] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("https://oauth2.googleapis.com/token")) return h.token ? h.token() : new Response(JSON.stringify({ access_token: "ya29" }), { status: 200 });
        const body = JSON.parse(String(init?.body));
        if (url.endsWith(":uploadClickConversions")) {
          calls.upload.push(body);
          return h.upload ? h.upload(body) : new Response(JSON.stringify({ results: [{}] }), { status: 200 });
        }
        if (url.endsWith(":uploadConversionAdjustments")) {
          calls.adjust.push(body);
          return h.adjust ? h.adjust(body) : new Response(JSON.stringify({ results: [{}] }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    return calls;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    afterQueue.length = 0;
    clearShopifyDiscountCache();
    // Reruns start clean: the rate-limit windows these tests hit.
    await db.rateLimit.deleteMany({ where: { OR: [{ key: { startsWith: "claim:" } }, { key: { startsWith: "incident:" } }, { key: { startsWith: "session:ip:" } }] } });
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/1201", name: "#1201" });
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) =>
      items.map((i) => line({ variantId: String(i.variantId), quantity: i.quantity })),
    );
    whop.createCheckoutConfiguration.mockImplementation(async () => ({ id: `ch_c12_${Math.random().toString(36).slice(2)}`, purchaseUrl: null }));
  });

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("Shopify code usage limit: Shopify's count plus the whole ledger (round 13), never one use too many", async () => {
    // Round 13: our paid uses are always added to Shopify's count (API orders may not be counted).
    const store = await makeStore({ shopifyDiscountCodes: true });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    await pastUse(store.id, "LAG5", { orderAt: new Date(Date.now() - 2 * MIN), usedAt: new Date(Date.now() - 3 * MIN) });
    // 5 allowed, Shopify says 3, one use in the ledger: the 5th use is allowed.
    shopify.shopifyGraphql.mockResolvedValue(shopifyCode({ usageLimit: 5, asyncUsageCount: 3 }));
    const a = await preparedWith(store.id, "LAG5", "a@c12fix.test");
    // Another checkout paid the code meanwhile (ledger 2): 3 + 2 + 1 > 5, this payment is held.
    await pastUse(store.id, "LAG5", { orderAt: null, usedAt: new Date() });
    await markPaid(a.session.id, { id: `pay_${a.session.id}`, totalCents: a.totals.totalCents, currency: "eur", checkoutConfigurationId: a.configId });
    const held = await db.checkoutSession.findUniqueOrThrow({ where: { id: a.session.id } });
    expect(held.reviewNote).toContain("limite de 5 utilisation(s) atteinte");
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();

    // Even an hour-old order (Shopify may have counted it) still counts: exhausted early, never over.
    const other = await makeStore({ shopifyDiscountCodes: true });
    await db.shippingRate.create({ data: { storeId: other.id, name: "Poste", countries: [], priceCents: 0 } });
    await pastUse(other.id, "LAG5", { orderAt: new Date(Date.now() - 60 * MIN), usedAt: new Date(Date.now() - 61 * MIN) });
    shopify.shopifyGraphql.mockResolvedValue(shopifyCode({ usageLimit: 5, asyncUsageCount: 4 }));
    await expect(preparedWith(other.id, "LAG5", "b@c12fix.test")).rejects.toMatchObject({ code: "discount_exhausted" });
  });

  it("claim photos: a body over 4.4 MB gets a JSON 413 the form understands (with or without Content-Length)", async () => {
    const post = (body: BodyInit, headers: Record<string, string> = {}) =>
      claimRoute.POST(new Request("https://x.test/api/public/sessions/c12fix_s/claim", { method: "POST", body, headers: { "x-forwarded-for": "10.12.0.1", ...headers } }), { params: Promise.resolve({ id: "c12fix_s" }) });
    const fd = new FormData();
    fd.set("email", "a@c12fix.test");
    fd.set("reason", "lost");
    fd.append("photos", new File([new Uint8Array(100)], "a.jpg", { type: "image/jpeg" }));
    const declared = await post(fd, { "content-length": String(5_000_000) });
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({ code: "photo_size" });
    // No trustworthy Content-Length: the photos themselves are measured.
    const big = new FormData();
    big.set("email", "a@c12fix.test");
    big.set("reason", "lost");
    for (let i = 0; i < 3; i++) big.append("photos", new File([new Uint8Array(1_500_000)], `p${i}.jpg`, { type: "image/jpeg" }));
    const measured = await post(big);
    expect(measured.status).toBe(413);
    expect(measured.headers.get("content-type")).toContain("application/json");
    expect(await measured.json()).toMatchObject({ code: "photo_size" });
  });

  it("replacement order: kept lease after a timeout, found by its source identifier (no duplicate), with the chosen items", async () => {
    const store = await makeStore();
    const bump = { id: "bump1", title: "Chaussettes", priceCents: 500, variantId: "gid://shopify/ProductVariant/5", costCents: null };
    const protection = { id: "shipping_protection", title: "Protection colis", priceCents: 300, variantId: null, costCents: null };
    const s = await paidOrder(store.id, { lines: [line({ quantity: 2 })], shopifyOrderName: "#1200" }, [bump, protection]);
    const offer = await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "b1", title: "Casquette", variantId: "gid://shopify/ProductVariant/7", amountCents: 2000, status: "PAID", orderMode: "merged" } });
    await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "b2", title: "Sac", variantId: "gid://shopify/ProductVariant/8", amountCents: 1500, refundedCents: 1500, status: "PAID", orderMode: "merged" } });
    const claim = await db.protectionClaim.create({ data: { storeId: store.id, sessionId: s.id, kind: "reship", costCents: 0, status: "pending", source: "buyer", reason: "lost" } });

    const orders: Record<string, unknown>[] = [];
    let found: unknown[] = [];
    shopify.shopifyGraphql.mockImplementation(async (_s: unknown, query: string, vars: Record<string, unknown>) => {
      if (query.includes("orderCreate")) {
        orders.push(vars.order as Record<string, unknown>);
        throw new ShopifyError("Shopify injoignable : The operation was aborted due to timeout", true);
      }
      expect(vars.q).toBe(`tag:'sinistre-${claim.id}' OR source_identifier:'claim:${claim.id}'`);
      return { orders: { nodes: found } };
    });
    // The merchant unticked the socks.
    const r = await decideClaim(store.id, s.id, claim.id, { approve: true, kind: "reship", costCents: 1800, replacement: true, replacementKeys: ["line:0", `offer:${offer.id}`] });
    expect(r.replacement).toMatchObject({ error: expect.stringContaining("peut-être été créée") });
    expect(orders).toHaveLength(1);
    const items = (orders[0].lineItems as { variantId: string; quantity: number }[]).map((l) => [l.variantId, l.quantity]);
    expect(items).toEqual([
      ["gid://shopify/ProductVariant/11", 2],
      ["gid://shopify/ProductVariant/7", 1],
    ]);
    expect(orders[0].sourceIdentifier).toBe(`claim:${claim.id}`);
    let row = await db.protectionClaim.findUniqueOrThrow({ where: { id: claim.id } });
    // The lease is kept: a click right away can't create a second order.
    expect(row.replacementStartedAt).not.toBeNull();
    expect(row.replacementError).toContain("incertaine");
    expect(row.replacementLines).toEqual(["line:0", `offer:${offer.id}`]);
    // Round 13: the anti-duplicate wait (5 min after the uncertain attempt) refuses any new try.
    expect(row.replacementAmbiguousAt).toBeInstanceOf(Date);
    await expect(createReplacementOrder(store.id, claim.id)).rejects.toThrow(/anti-doublon.*Réessayez dans 5 min/);
    expect(orders).toHaveLength(1);

    // The wait is over; Shopify's search shows the order by its source identifier (the tag index lags).
    await db.protectionClaim.update({ where: { id: claim.id }, data: { replacementStartedAt: new Date(Date.now() - 6 * MIN), replacementAmbiguousAt: new Date(Date.now() - 6 * MIN) } });
    found = [{ id: "gid://shopify/Order/777", name: "#1201", tags: [], sourceIdentifier: `claim:${claim.id}` }];
    expect(await createReplacementOrder(store.id, claim.id)).toEqual({ id: "gid://shopify/Order/777", name: "#1201" });
    expect(orders).toHaveLength(1);
    row = await db.protectionClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect([row.replacementOrderName, row.replacementStartedAt, row.replacementError]).toEqual(["#1201", null, null]);

    // A definite refusal (userErrors): nothing was created, the lease is released at once.
    const s2 = await paidOrder(store.id, {}, [bump]);
    const claim2 = await db.protectionClaim.create({ data: { storeId: store.id, sessionId: s2.id, kind: "reship", costCents: 0, status: "pending", source: "buyer", reason: "lost" } });
    found = [];
    shopify.shopifyGraphql.mockImplementation(async (_s: unknown, query: string, vars: Record<string, unknown>) => {
      if (query.includes("orderCreate")) {
        orders.push(vars.order as Record<string, unknown>);
        return { orderCreate: { order: null, userErrors: [{ field: ["order", "email"], message: "Email is invalid" }] } };
      }
      return { orders: { nodes: [] } };
    });
    const r2 = await decideClaim(store.id, s2.id, claim2.id, { approve: true, kind: "reship", costCents: 900, replacement: true });
    expect(r2.replacement).toMatchObject({ error: "Shopify : Email is invalid" });
    // No selection saved: every item (the bump included).
    expect((orders[1].lineItems as { variantId: string }[]).map((l) => l.variantId)).toEqual(["gid://shopify/ProductVariant/11", "gid://shopify/ProductVariant/5"]);
    const row2 = await db.protectionClaim.findUniqueOrThrow({ where: { id: claim2.id } });
    expect([row2.replacementStartedAt, row2.replacementError]).toEqual([null, "Shopify : Email is invalid"]);
    await expect(createReplacementOrder(store.id, claim2.id)).rejects.toThrow("Email is invalid");
    expect(orders).toHaveLength(3);
  });

  it("Google offline conversions: never test orders; an account-wide 4xx stops the run without spending tries, and alerts", async () => {
    // Test mode, test order: never uploaded.
    const testStore = await googleStore({ testMode: true });
    await paidOrder(testStore.id, { test: true, utm: { gclid: "Cj0KCQjwc12fixTEST" } });
    let calls = stubGoogle({});
    expect(await uploadGoogleConversions(Date.now() + 30_000, { storeId: testStore.id })).toBe(0);
    expect(calls.upload).toHaveLength(0);

    const store = await googleStore();
    const day = (n: number) => new Date(Date.now() - n * DAY);
    const orders = [];
    for (let i = 0; i < 4; i++) orders.push(await paidOrder(store.id, { utm: { gclid: `Cj0KCQjwc12fix${i}xx` }, paidAt: day(4 - i) }));
    calls = stubGoogle({ upload: () => new Response(JSON.stringify({ error: { message: "The developer token is not approved." } }), { status: 403 }) });
    expect(await uploadGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(0);
    // Three orders tried (the sample), the fourth not even asked; no try spent.
    expect(calls.upload).toHaveLength(3);
    const rows = await db.checkoutSession.findMany({ where: { id: { in: orders.map((o) => o.id) } }, orderBy: { paidAt: "asc" } });
    expect(rows.map((r) => r.googleAdsUploadAttempts)).toEqual([0, 0, 0, 0]);
    expect(rows[0].googleAdsUploadError).toContain("developer token is not approved");
    expect(rows[3].googleAdsUploadError).toBeNull();
    const incident = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "google.conversions_account_error" } });
    expect(incident.message).toContain("envoi suspendu");
    expect(notify.sendAlert).toHaveBeenCalled();

    // A per-order error (partial failure) is spent on that order only; the others go through.
    calls = stubGoogle({
      upload: (body) =>
        (body.conversions as { gclid: string }[])[0].gclid.endsWith("0xx")
          ? new Response(JSON.stringify({ partialFailureError: { message: "UNPARSEABLE_GCLID" } }), { status: 200 })
          : new Response(JSON.stringify({ results: [{}] }), { status: 200 }),
    });
    expect(await uploadGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(3);
    const after = await db.checkoutSession.findMany({ where: { id: { in: orders.map((o) => o.id) } }, orderBy: { paidAt: "asc" } });
    expect(after.map((r) => [r.googleAdsUploadAttempts, r.googleAdsUploadedAt != null])).toEqual([
      [1, false],
      [0, true],
      [0, true],
      [0, true],
    ]);
    expect(after[1].googleAdsValueCents).toBe(5000);

    // OAuth refused: journaled incident, nothing sent.
    calls = stubGoogle({ token: () => new Response(JSON.stringify({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), { status: 400 }) });
    expect(await uploadGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(0);
    expect((await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "google.conversions_auth_failed" } })).message).toContain("Reconnectez Google Ads");

    // Health: the Google line on the "Pub & pixels" tile, red after the incidents.
    const tile = (await storeHealth(store.id)).find((i) => i.key === "pixels")!;
    expect(tile.ok).toBe(false);
    // Round 13: the order's first failed try counts at once (tries in progress), and it's overdue (paid 4 days ago).
    expect(tile.detail).toMatch(/Google Ads \(conversions hors ligne\) : 1 en attente · 1 échec\(s\) sur 24 h · 2 erreur\(s\) de compte \/ connexion · 1 en attente depuis plus de 6 h · dernier envoi/);
    // …and not on the "degraded" tile.
    expect((await storeHealth(store.id)).find((i) => i.key === "degraded")!.detail).not.toContain("Google");

    // A new conversion action: tries given back to the recent orders never uploaded (not older than 60 days).
    const old = await paidOrder(store.id, { utm: { gclid: "Cj0KCQjwc12fixOLD" }, paidAt: day(70), googleAdsUploadAttempts: 5, googleAdsUploadError: "x" });
    expect(await changeConversionAction(store.id, "customers/1234567890/conversionActions/555")).toEqual({ changed: false, reset: 0 });
    expect(await changeConversionAction(store.id, "customers/1234567890/conversionActions/556")).toEqual({ changed: true, reset: 1 });
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: orders[0].id } })).googleAdsUploadAttempts).toBe(0);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: old.id } })).googleAdsUploadAttempts).toBe(5);
  });

  it("Google conversion adjustments: retraction, restatement (refund, offers), once each, with a backoff", async () => {
    const store = await googleStore();
    const uploaded = (data: Record<string, unknown>) =>
      // Round 13: candidates are the orders flagged by the writers (refund, dispute, offer).
      paidOrder(store.id, { utm: { gclid: "Cj0KCQjwc12fixADJ" }, totalCents: 10_000, subtotalCents: 10_000, googleAdsUploadedAt: new Date(Date.now() - 7 * 3600_000), googleAdsValueCents: 10_000, googleAdsAdjustDue: true, ...data });
    const refunded = await uploaded({ refundedCents: 10_000 });
    const lost = await uploaded({ disputeStatus: "lost" });
    const partial = await uploaded({ refundedCents: 2500 });
    const withOffer = await uploaded({});
    await db.upsellCharge.create({ data: { sessionId: withOffer.id, blockId: "b1", title: "Casquette", variantId: "gid://shopify/ProductVariant/7", amountCents: 3000, status: "PAID" } });
    const tooRecent = await uploaded({ refundedCents: 2500, googleAdsUploadedAt: new Date(Date.now() - 3600_000) });
    const unchanged = await uploaded({});
    const testOrder = await uploaded({ test: true, refundedCents: 10_000 });

    let calls = stubGoogle({});
    expect(await adjustGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(4);
    const sent = new Map(calls.adjust.map((b) => [(b.conversionAdjustments as { orderId: string }[])[0].orderId, (b.conversionAdjustments as Record<string, unknown>[])[0]]));
    expect(sent.get(refunded.id)).toMatchObject({ adjustmentType: "RETRACTION", conversionAction: "customers/1234567890/conversionActions/555" });
    expect(sent.get(lost.id)).toMatchObject({ adjustmentType: "RETRACTION" });
    expect(sent.get(partial.id)).toMatchObject({ adjustmentType: "RESTATEMENT", restatementValue: { adjustedValue: 75, currencyCode: "EUR" } });
    expect(sent.get(withOffer.id)).toMatchObject({ adjustmentType: "RESTATEMENT", restatementValue: { adjustedValue: 130, currencyCode: "EUR" } });
    for (const id of [tooRecent.id, unchanged.id, testOrder.id]) expect(sent.has(id)).toBe(false);
    const r = await db.checkoutSession.findUniqueOrThrow({ where: { id: refunded.id } });
    expect([r.googleAdsRetractedAt != null, r.googleAdsValueCents]).toEqual([true, 0]);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: partial.id } })).googleAdsValueCents).toBe(7500);

    // Idempotent: nothing more to send.
    calls = stubGoogle({});
    expect(await adjustGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(0);
    expect(calls.adjust).toHaveLength(0);

    // A new refund, Google down: the try is counted, retried after the backoff (not on the next tick).
    await db.checkoutSession.update({ where: { id: partial.id }, data: { refundedCents: 5000, googleAdsAdjustDue: true } });
    calls = stubGoogle({ adjust: () => new Response("{}", { status: 503 }) });
    expect(await adjustGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(0);
    const failed = await db.checkoutSession.findUniqueOrThrow({ where: { id: partial.id } });
    expect([failed.googleAdsAdjustAttempts, failed.googleAdsAdjustNextAt! > new Date(), failed.googleAdsValueCents]).toEqual([1, true, 7500]);
    calls = stubGoogle({});
    expect(await adjustGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(0);
    await db.checkoutSession.update({ where: { id: partial.id }, data: { googleAdsAdjustNextAt: new Date(Date.now() - 1000) } });
    expect(await adjustGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(1);
    expect((calls.adjust[0].conversionAdjustments as Record<string, unknown>[])[0]).toMatchObject({ restatementValue: { adjustedValue: 50 } });
    const done = await db.checkoutSession.findUniqueOrThrow({ where: { id: partial.id } });
    expect([done.googleAdsValueCents, done.googleAdsAdjustAttempts, done.googleAdsAdjustError]).toEqual([5000, 0, null]);
  });

  it("checkout tests: one running per element (index), promote atomic, arm A keeps the settings of the start", async () => {
    const store = await makeStore({ name: "c12fix_fail_store", quantityBreaks: [{ minQty: 2, percent: 10 }] });
    const both = await Promise.all([0, 1].map(() => startCheckoutTest(store.id, { kind: "breaks", name: "Paliers", splitB: 50, configB: [{ minQty: 2, percent: 20 }] })));
    expect(both.filter((r) => r.ok)).toHaveLength(1);
    expect(both.find((r) => !r.ok)).toMatchObject({ error: "Un test de cet élément est déjà en cours." });
    const test = await db.checkoutTest.findFirstOrThrow({ where: { storeId: store.id, status: "RUNNING" } });
    await expect(db.checkoutTest.create({ data: { storeId: store.id, kind: "breaks", name: "x", configB: [] } })).rejects.toThrow();

    // Arm A keeps the start's tiers even after the store's are edited mid-test.
    await db.store.update({ where: { id: store.id }, data: { quantityBreaks: [{ minQty: 2, percent: 30 }] } });
    const armA = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line({ quantity: 2 })], subtotalCents: 10_000, checkoutTestArms: { [test.id]: "A" } }, include: { store: true } });
    const armB = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line({ quantity: 2 })], subtotalCents: 10_000, checkoutTestArms: { [test.id]: "B" } }, include: { store: true } });
    const outside = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line({ quantity: 2 })], subtotalCents: 10_000 }, include: { store: true } });
    expect((await quoteSession(armA, { addOnIds: [] })).totals.volumeDiscountCents).toBe(1000);
    expect((await quoteSession(armB, { addOnIds: [] })).totals.volumeDiscountCents).toBe(2000);
    expect((await quoteSession(outside, { addOnIds: [] })).totals.volumeDiscountCents).toBe(3000);

    // Promote B while the store row can't be written: nothing changes (the test keeps running).
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION c12fix_block_store() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'c12fix blocked'; END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(`CREATE TRIGGER c12fix_block_store BEFORE UPDATE ON "Store" FOR EACH ROW WHEN (OLD.name = 'c12fix_fail_store') EXECUTE FUNCTION c12fix_block_store()`);
    try {
      await expect(endCheckoutTest(store.id, test.id, "B")).rejects.toThrow(/c12fix blocked/);
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS c12fix_block_store ON "Store"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS c12fix_block_store()`);
    }
    expect((await db.checkoutTest.findUniqueOrThrow({ where: { id: test.id } })).status).toBe("RUNNING");
    expect(await endCheckoutTest(store.id, test.id, "B")).toBe(true);
    const [t, s] = await Promise.all([db.checkoutTest.findUniqueOrThrow({ where: { id: test.id } }), db.store.findUniqueOrThrow({ where: { id: store.id } })]);
    expect([t.status, t.winner, s.quantityBreaks]).toEqual(["STOPPED", "B", [{ minQty: 2, percent: 20 }]]);
    // Stopped: another test of the element can start.
    expect((await startCheckoutTest(store.id, { kind: "breaks", name: "Paliers 2", splitB: 50, configB: [{ minQty: 3, percent: 25 }] })).ok).toBe(true);
  });

  it("A/B arms come from a server-signed visitor id, never one the browser picked", async () => {
    const store = await makeStore({ enabled: true });
    const t = await startCheckoutTest(store.id, { kind: "breaks", name: "Paliers", splitB: 50, configB: [{ minQty: 2, percent: 20 }] });
    expect(t.ok).toBe(true);
    const post = (visitorId?: string) =>
      sessionsRoute.POST(
        new Request("https://x.test/api/public/sessions", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "10.12.0.2" },
          body: JSON.stringify({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], ...(visitorId ? { visitorId } : {}) }),
        }),
        { params: Promise.resolve({}) },
      );
    const forged = await post("chosenbythebrowser123");
    expect(forged.status).toBe(200);
    const a = (await forged.json()) as { id: string; visitorId: string };
    const id = verifyVisitorId(a.visitorId);
    expect(id).not.toBeNull();
    const sa = await db.checkoutSession.findUniqueOrThrow({ where: { id: a.id } });
    expect(sa.visitorId).toBe(id);
    expect(sa.visitorId).not.toBe("chosenbythebrowser123");
    expect(Object.keys(sa.checkoutTestArms as object)).toHaveLength(1);
    // The signed id comes back: same visitor, same arms.
    const again = (await (await post(a.visitorId)).json()) as { id: string; visitorId: string };
    expect(again.visitorId).toBe(a.visitorId);
    const sb = await db.checkoutSession.findUniqueOrThrow({ where: { id: again.id } });
    expect([sb.visitorId, sb.checkoutTestArms]).toEqual([sa.visitorId, sa.checkoutTestArms]);
  });

  it("time zones: saved only when Postgres knows them; queries use the store's zone when valid", async () => {
    expect(await isStorableTimeZone("Asia/Tokyo")).toBe(true);
    expect(await isStorableTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(await isStorableTimeZone("Europe/Paris'; DROP")).toBe(false);
    expect(await sqlTimeZone({ timezone: "America/New_York" })).toBe("America/New_York");
    expect(await sqlTimeZone({ timezone: "Mars/Olympus_Mons" })).toBe("Europe/Paris");
    expect(await sqlTimeZone(null)).toBe("Europe/Paris");
  });
});
