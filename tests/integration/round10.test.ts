import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Round 10 (product) against a real Postgres: discount stacking (app codes, quantity breaks, a
 * Shopify buy X get Y code), checkout A/B tests (tiers, bump price) through quote → snapshot →
 * stats → promote, the daily margin on the refund date, IP-only visitor-country funnel and its
 * coverage, platform-reported vs real ROAS (Meta import), Google Ads offline conversions, claim
 * photos / replacement orders / decision e-mails, returning buyers across the store network with
 * the operator's Resend account, subscription carts, distinct new customers and a store in
 * another time zone. Shopify, Whop, notifications and HTTP are mocked. Test data: pr10fix_.
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
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn() }));

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void Promise.resolve().then(fn) }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const DAY = 86_400_000;

describe.skipIf(!hasDb)("round 10 (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { storeAnalytics, checkoutTestResults, sendDailyReport, parisDayStart } = await import("@/lib/analytics");
  const { zonedDay, zonedHour, addDays } = await import("@/lib/time");
  const { quoteSession, prepareSession } = await import("@/lib/checkout");
  const { clearShopifyDiscountCache } = await import("@/lib/shopify-discounts");
  const { startCheckoutTest, endCheckoutTest, assignCheckoutTests } = await import("@/lib/checkout-tests");
  const { importAdSpend } = await import("@/lib/adspend");
  const { uploadGoogleConversions } = await import("@/lib/google-conversions");
  const { submitBuyerClaim, decideClaim, createReplacementOrder, buyerPhotoUrl } = await import("@/lib/claims");
  const { deliverLoginCode, verifyLoginCode } = await import("@/lib/returning");
  const photoRoute = await import("@/app/api/public/claim-photos/[photoId]/route");
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
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `pr10fix_${Math.random().toString(36).slice(2, 8)}`,
        testMode: false,
        vatExempt: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_pr10",
        whopProductId: "prod_pr10",
        whopApiKey: encrypt("k"),
        shopDomain: `pr10fix-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  async function paidOrder(storeId: string, s: Record<string, unknown> = {}, addOns: unknown[] = []) {
    const session = await db.checkoutSession.create({
      data: { storeId, currency: "EUR", status: "PAID", lines: [line()], subtotalCents: 5000, totalCents: 5000, paidAt: new Date(), email: "buyer@pr10fix.test", shippingAddress: address, ...s } as never,
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
        lines: (s.lines ?? [line()]) as never,
      },
    });
    return db.checkoutSession.update({ where: { id: session.id }, data: { paidQuoteId: q.id } });
  }

  const openSession = async (storeId: string, data: Record<string, unknown> = {}) =>
    db.checkoutSession.findUniqueOrThrow({
      where: { id: (await db.checkoutSession.create({ data: { storeId, currency: "EUR", lines: [line({ quantity: 2 })], subtotalCents: 10000, ...data } as never })).id },
      include: { store: true },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    clearShopifyDiscountCache();
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) => items.map((i) => line({ variantId: String(i.variantId), quantity: i.quantity })));
    whop.createCheckoutConfiguration.mockImplementation(async () => ({ id: `ch_pr10_${Math.random().toString(36).slice(2)}`, purchaseUrl: null }));
    notify.sendEmail.mockResolvedValue(true);
  });

  afterAll(async () => {
    await db.buyerLoginCode.deleteMany({ where: { storeId: { in: created } } });
    await db.rateLimit.deleteMany({ where: { OR: [{ key: { contains: "pr10fix" } }, { key: { startsWith: "claim:ip:10.0.0." } }] } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    await db.appSetting.deleteMany({ where: { key: { in: created.flatMap((id) => [`adspend:${id}`, `daily-report:${id}`]) } } });
  });

  it("discount stacking: app code not combinable, best for the buyer; Shopify buy X get Y code", async () => {
    const store = await makeStore({ quantityBreaks: [{ minQty: 2, percent: 20 }] });
    await db.discountCode.createMany({
      data: [
        { storeId: store.id, code: "PR10SOLO", type: "PERCENT", value: 10, combinesWithBreaks: false },
        { storeId: store.id, code: "PR10BIG", type: "PERCENT", value: 30, combinesWithBreaks: false },
        { storeId: store.id, code: "PR10PLUS", type: "PERCENT", value: 10 },
      ],
    });
    const s = await openSession(store.id);
    const solo = await quoteSession(s, { discountCode: "PR10SOLO", addOnIds: [] });
    expect([solo.discountErrorCode, solo.discount, solo.totals.discountCents, solo.volumeBreak.current?.percent]).toEqual(["discount_not_combinable", null, 2000, 20]);
    const big = await quoteSession(s, { discountCode: "PR10BIG", addOnIds: [] });
    expect([big.discountError, big.discount?.code, big.totals.discountCents, big.volumeBreak.current]).toEqual([null, "PR10BIG", 3000, null]);
    const plus = await quoteSession(s, { discountCode: "PR10PLUS", addOnIds: [] });
    expect(plus.totals.discountCents).toBe(2000 + 800);
    // Store setting off: no code stacks with the breaks.
    await db.store.update({ where: { id: store.id }, data: { breaksCombineWithCodes: false } });
    const off = await quoteSession({ ...s, store: { ...s.store, breaksCombineWithCodes: false } }, { discountCode: "PR10PLUS", addOnIds: [] });
    expect(off.discountErrorCode).toBe("discount_not_combinable");

    // A Shopify BXGY code (buy 2, get 1 free), not combinable with product discounts: vs the 20 % break.
    const plain = await makeStore({ shopifyScopes: "read_products,read_discounts", shopifyDiscountCodes: true });
    const three = await openSession(plain.id, { lines: [line({ quantity: 2, unitPriceCents: 3000 }), line({ variantId: "gid://shopify/ProductVariant/12", unitPriceCents: 1000 })] });
    shopify.shopifyGraphql.mockImplementation(async (_s: unknown, query: string) =>
      query.includes("codeDiscountNodeByCode")
        ? {
            codeDiscountNodeByCode: {
              codeDiscount: {
                __typename: "DiscountCodeBxgy",
                title: "B2G1",
                status: "ACTIVE",
                asyncUsageCount: 0,
                context: { __typename: "DiscountBuyerSelectionAll" },
                codes: { nodes: [{ code: "B2G1" }] },
                combinesWith: { productDiscounts: false, orderDiscounts: true, shippingDiscounts: true },
                customerBuys: { value: { __typename: "DiscountQuantity", quantity: "2" }, items: { __typename: "AllDiscountItems" } },
                customerGets: { value: { __typename: "DiscountOnQuantity", quantity: { quantity: "1" }, effect: { __typename: "DiscountPercentage", percentage: 1 } }, items: { __typename: "AllDiscountItems" } },
              },
            },
          }
        : {},
    );
    const q = await quoteSession(three, { discountCode: "b2g1", addOnIds: [] });
    expect([q.discount?.code, q.discount?.source, q.totals.discountCents]).toEqual(["B2G1", "shopify", 1000]);
  });

  it("checkout A/B tests: tiers and bump price per arm, paid snapshot, stats and promotion", async () => {
    const store = await makeStore({ quantityBreaks: [{ minQty: 2, percent: 10 }] });
    const bump = await db.addOn.create({ data: { storeId: store.id, title: "Garantie", priceCents: 990 } });
    const breaks = await startCheckoutTest(store.id, { kind: "breaks", name: "Paliers", splitB: 50, configB: [{ minQty: 2, percent: 25 }] });
    const addon = await startCheckoutTest(store.id, { kind: "addon", targetId: bump.id, name: "Prix option", splitB: 50, configB: { priceCents: 490 } });
    expect(breaks.ok && addon.ok).toBe(true);
    if (!breaks.ok || !addon.ok) return;
    expect(await startCheckoutTest(store.id, { kind: "breaks", name: "x", splitB: 50, configB: [{ minQty: 3, percent: 5 }] })).toMatchObject({ ok: false });
    const arms = await assignCheckoutTests(store.id, "visitorpr10fix0001");
    expect(Object.keys(arms ?? {}).sort()).toEqual([addon.id, breaks.id].sort());

    const inB = await openSession(store.id, { checkoutTestArms: { [breaks.id]: "B", [addon.id]: "B" }, visitorId: "vB" });
    const inA = await openSession(store.id, { checkoutTestArms: { [breaks.id]: "A", [addon.id]: "A" }, visitorId: "vA" });
    const qb = await quoteSession(inB, { addOnIds: [bump.id], countryCode: "FR" });
    const qa = await quoteSession(inA, { addOnIds: [bump.id], countryCode: "FR" });
    expect([qb.totals.volumeDiscountCents, qb.totals.addOnsCents]).toEqual([2500, 490]);
    expect([qa.totals.volumeDiscountCents, qa.totals.addOnsCents]).toEqual([1000, 990]);
    // The paid snapshot keeps the arm's bump price (drives the Shopify order and analytics).
    await db.shippingRate.create({ data: { storeId: store.id, name: "Std", countries: [], priceCents: 0 } });
    const prepared = await prepareSession(inB, { addOnIds: [bump.id], countryCode: "FR" });
    const snap = await db.checkoutQuote.findFirstOrThrow({ where: { sessionId: inB.id, whopCheckoutId: (prepared as { whopCheckoutId?: string }).whopCheckoutId ?? undefined } });
    expect((snap.addOns as { id: string; priceCents: number }[]).find((a) => a.id === bump.id)?.priceCents).toBe(490);

    // Stats: one paid visitor in each arm (margin per visitor from the Analytics engine).
    for (const [arm, total] of [["A", 9000], ["B", 7500]] as const) {
      await paidOrder(store.id, { checkoutTestArms: { [breaks.id]: arm }, visitorId: `pay${arm}`, totalCents: total, subtotalCents: total, whopFeeCents: 0, lines: [line({ unitCostCents: 1000, requiresShipping: false })] });
      await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [], checkoutTestArms: { [breaks.id]: arm }, visitorId: `browse${arm}` } });
    }
    const test = await db.checkoutTest.findUniqueOrThrow({ where: { id: breaks.id } });
    const r = await checkoutTestResults(test);
    expect(r.stats.map((x) => [x.variant, x.visitors, x.orders])).toEqual([
      ["A", 3, 1],
      ["B", 3, 1],
    ]);
    expect(r.metric).toBe("profit");
    expect(r.stats[0].profitCents).toBe(9000 - 1000);

    expect(await endCheckoutTest(store.id, breaks.id, "B")).toBe(true);
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).quantityBreaks).toEqual([{ minQty: 2, percent: 25 }]);
    expect(await endCheckoutTest(store.id, breaks.id, "A")).toBe(false);
    await endCheckoutTest(store.id, addon.id, "B");
    expect((await db.addOn.findUniqueOrThrow({ where: { id: bump.id } })).priceCents).toBe(490);
  });

  it("daily margin on the refund date adds up to the P&L in both modes", async () => {
    const store = await makeStore({ fulfillmentFeeCents: 100 });
    const d1 = new Date(Date.now() - 4 * DAY);
    const d2 = new Date(Date.now() - 1 * DAY);
    const protection = [{ id: "shipping_protection", title: "Protection colis", priceCents: 300, variantId: null, costCents: null }];
    const o1 = await paidOrder(store.id, { paidAt: d1, createdAt: d1, whopFeeCents: 150, refundedCents: 2000, lines: [line({ unitCostCents: 1500 })], trackingNumber: "TRK1" }, protection);
    await db.refundRecord.create({ data: { id: `pr10fix_re_${o1.id}`, storeId: store.id, sessionId: o1.id, amountCents: 2000, currency: "EUR", createdAt: d2 } });
    await paidOrder(store.id, { paidAt: d2, createdAt: d2, whopFeeCents: 150, lines: [line({ unitCostCents: 1500 })] });
    // A buyer claim decided later than it was reported: the refund-date view dates it at the decision.
    await db.protectionClaim.create({ data: { storeId: store.id, sessionId: o1.id, kind: "reship", costCents: 700, status: "approved", source: "buyer", createdAt: d1, decidedAt: d2 } });
    const a = await storeAnalytics(store.id, { since: new Date(Date.now() - 6 * DAY), until: new Date(Date.now() + 60_000), includeTest: false });
    const sum = (f: (d: (typeof a.daily)[number]) => number) => a.daily.reduce((s, d) => s + f(d), 0);
    expect(sum((d) => d.netCents)).toBe(a.profit.grossProfitCents);
    const byRefundDate = a.profit.grossProfitCents + a.money.refundedHtCents - a.refundsByDate.htCents + a.profit.claimsCents - a.claimsByDate.cents;
    expect(sum((d) => d.netByRefundDateCents)).toBe(byRefundDate);
    const day1 = a.daily.find((d) => d.day === zonedDay(d1))!;
    const day2 = a.daily.find((d) => d.day === zonedDay(d2))!;
    // The refund and the claim leave o1's day and land on the day they cost.
    expect(day1.netByRefundDateCents - day1.netCents).toBe(2000 + 700);
    expect(day2.netByRefundDateCents - day2.netCents).toBe(-2000 - 700);
    expect([day2.refundsByDateHtCents, day2.claimsByDateCents]).toEqual([2000, 700]);
  });

  it("visitor-country funnel: IP country only, with its coverage; new customers are distinct buyers", async () => {
    const store = await makeStore();
    await paidOrder(store.id, { geoCountry: "BE", createdAt: new Date(Date.now() - 3600_000), email: "new@pr10fix.test" });
    await paidOrder(store.id, { geoCountry: "BE", createdAt: new Date(Date.now() - 1800_000), email: "new@pr10fix.test" });
    await db.checkoutSession.createMany({
      data: [
        { storeId: store.id, currency: "EUR", lines: [], geoCountry: "FR" },
        { storeId: store.id, currency: "EUR", lines: [], shippingAddress: { countryCode: "DE" } },
      ],
    });
    const a = await storeAnalytics(store.id, { since: new Date(Date.now() - DAY), until: new Date(Date.now() + 60_000), includeTest: false });
    expect(Object.fromEntries(a.funnelBy.country.map((g) => [g.group, g.sessions]))).toEqual({ BE: 2, FR: 1, inconnu: 1 });
    expect(a.geoCoverage).toEqual({ sessions: 4, located: 3, share: 0.75 });
    expect(a.customers).toMatchObject({ newCustomers: 1, newOrders: 1, returningCustomers: 1, returningOrders: 1 });
    expect(a.ads.newCustomers).toBe(1);
  });

  it("platform-reported conversions: Meta import and platform vs real ROAS per campaign", async () => {
    const store = await makeStore({ metaAdAccountId: "123456789", metaAccessToken: encrypt("tok") });
    const day = zonedDay(new Date());
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const level = new URL(url).searchParams.get("level");
        const fields = new URL(url).searchParams.get("fields") ?? "";
        expect(fields).toContain("action_values");
        const ids = level === "campaign" ? { campaign_id: "777", campaign_name: "pr10 Promo" } : level === "adset" ? { adset_id: "8", adset_name: "S" } : { ad_id: "9", ad_name: "A" };
        return new Response(
          JSON.stringify({
            data: [{ date_start: day, ...ids, spend: "40.00", account_currency: "EUR", actions: [{ action_type: "omni_purchase", value: "4" }], action_values: [{ action_type: "omni_purchase", value: "300" }], purchase_roas: [{ action_type: "omni_purchase", value: "7.5" }] }],
          }),
          { status: 200 },
        );
      }),
    );
    await importAdSpend(Date.now() + 30_000, { storeId: store.id, force: true });
    const row = await db.adSpend.findFirstOrThrow({ where: { storeId: store.id, campaignId: "777" } });
    expect([row.platformConversions, row.platformConversionValueCents, row.platformRoas]).toEqual([4, 30000, 7.5]);
    await paidOrder(store.id, { utm: { utm_source: "facebook", utm_campaign: "pr10 Promo" }, totalCents: 6000 });
    const a = await storeAnalytics(store.id, { since: parisDayStart(day), until: new Date(Date.now() + 60_000), includeTest: false });
    const p = a.platformVsReal.find((x) => x.campaign === "pr10 Promo")!;
    expect(p).toMatchObject({ spendCents: 4000, platformConversions: 4, realOrders: 1, realRevenueCents: 6000, matched: true });
    expect(p.platformRoas).toBeCloseTo(7.5);
    expect(p.realRoas).toBeCloseTo(1.5);
    expect(p.overAttribution).toBeCloseTo(5);
  });

  it("Google Ads offline conversions: ClickConversion upload, consent, idempotent per order", async () => {
    const store = await makeStore({
      googleAdsCustomerId: "1234567890",
      googleAdsDeveloperToken: encrypt("dev"),
      googleAdsClientId: "abc.apps.googleusercontent.com",
      googleAdsClientSecret: encrypt("sec"),
      googleAdsRefreshToken: encrypt("ref"),
      googleAdsConversionAction: "customers/1234567890/conversionActions/555",
      pixelRequireConsent: true,
    });
    const ok = await paidOrder(store.id, { utm: { gclid: "Cj0KCQjwpr10fix" }, tracking: { marketing: true }, email: "Jo@pr10fix.test", totalCents: 4990 });
    const noConsent = await paidOrder(store.id, { utm: { wbraid: "wbraidpr10fix" }, tracking: { marketing: false } });
    await paidOrder(store.id, { utm: { utm_source: "google" } });
    const uploads: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "ya29" }), { status: 200 });
        expect(url).toContain("/customers/1234567890:uploadClickConversions");
        uploads.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ results: [{}] }), { status: 200 });
      }),
    );
    expect(await uploadGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(1);
    const conv = (uploads[0].conversions as Record<string, unknown>[])[0];
    expect(conv).toMatchObject({ conversionAction: "customers/1234567890/conversionActions/555", gclid: "Cj0KCQjwpr10fix", orderId: ok.id, conversionValue: 49.9, currencyCode: "EUR" });
    expect((conv.userIdentifiers as { hashedEmail: string }[])[0].hashedEmail).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: ok.id } })).googleAdsUploadedAt).not.toBeNull();
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: noConsent.id } })).googleAdsUploadError).toContain("consentement");
    // Next run: nothing left to send.
    expect(await uploadGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(0);
    expect(uploads).toHaveLength(1);
  });

  it("claims: photos uploaded and served by signed link; reship creates one 0 € order; the buyer is told in their language", async () => {
    // Rate-limit windows outlive a run: start clean so reruns are deterministic.
    await db.rateLimit.deleteMany({ where: { key: { startsWith: "claim:ip:10.0.0." } } });
    const store = await makeStore({ resendApiKey: encrypt("re_x"), emailFrom: "shop@pr10fix.test" });
    const protection = [{ id: "shipping_protection", title: "Protection colis", priceCents: 300, variantId: null, costCents: null }];
    const s = await paidOrder(store.id, { email: "c@pr10fix.test", lang: "en", shopifyOrderName: "#1001" }, protection);
    expect(await submitBuyerClaim(s.id, { email: "c@pr10fix.test", reason: "lost", photos: [{ type: "image/jpeg", data: png }] })).toEqual({ ok: false, error: "photo_type" });

    // Multipart through the public route (the checkout's form).
    const fd = new FormData();
    fd.set("email", "c@pr10fix.test");
    fd.set("reason", "damaged");
    fd.set("details", "Carton écrasé");
    fd.append("photos", new File([new Uint8Array(png)], "colis.png", { type: "image/png" }));
    const res = await claimRoute.POST(new Request(`https://x.test/api/public/sessions/${s.id}/claim`, { method: "POST", body: fd, headers: { "x-forwarded-for": "10.0.0.10" } }), { params: Promise.resolve({ id: s.id }) });
    expect(res.status).toBe(200);
    const claim = await db.protectionClaim.findFirstOrThrow({ where: { sessionId: s.id }, include: { photos: true } });
    expect(claim.photos.map((p) => [p.mime, p.size])).toEqual([["image/png", png.length]]);

    // Buyer link: signed; a forged one is refused.
    const url = new URL(buyerPhotoUrl(claim.photos[0].id), "https://x.test");
    const img = await photoRoute.GET(new Request(url), { params: Promise.resolve({ photoId: claim.photos[0].id }) });
    expect([img.status, img.headers.get("content-type"), img.headers.get("x-content-type-options")]).toEqual([200, "image/png", "nosniff"]);
    url.searchParams.set("t", "forged");
    expect((await photoRoute.GET(new Request(url), { params: Promise.resolve({ photoId: claim.photos[0].id }) })).status).toBe(403);

    // Approve as a reship with a replacement order.
    const calls: string[] = [];
    shopify.shopifyGraphql.mockImplementation(async (_s: unknown, query: string, vars: Record<string, unknown>) => {
      calls.push(query.includes("orderCreate") ? "create" : "search");
      if (query.includes("orderCreate")) {
        const order = vars.order as { discountCode: unknown; tags: string[] };
        expect(order.discountCode).toEqual({ itemPercentageDiscountCode: { code: "REMPLACEMENT", percentage: 100 } });
        expect(order.tags).toContain(`sinistre-${claim.id}`);
        return { orderCreate: { order: { id: "gid://shopify/Order/555", name: "#1002" }, userErrors: [] } };
      }
      return { orders: { nodes: [] } };
    });
    const r = await decideClaim(store.id, s.id, claim.id, { approve: true, kind: "reship", costCents: 1800, replacement: true });
    expect(r).toEqual({ replacement: { id: "gid://shopify/Order/555", name: "#1002" }, emailed: true });
    expect(calls).toEqual(["search", "create"]);
    const after = await db.protectionClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect([after.replacementOrderName, after.buyerNotifiedAt != null]).toEqual(["#1002", true]);
    expect(notify.sendEmail).toHaveBeenCalledTimes(1);
    const mail = notify.sendEmail.mock.calls[0][1] as { to: string; subject: string; text: string };
    expect([mail.to, mail.subject]).toEqual(["c@pr10fix.test", "Your report for order #1001"]);
    expect(mail.text).toContain("replacement order #1002");
    // Idempotent: the linked order is returned, nothing new is created.
    expect(await createReplacementOrder(store.id, claim.id)).toEqual({ id: "gid://shopify/Order/555", name: "#1002" });
    expect(calls).toHaveLength(2);
  });

  it("returning buyer across the store network, e-mailed through the operator's Resend account", async () => {
    const shopA = await makeStore({ storeNetwork: true, returningBuyerCode: true });
    const shopB = await makeStore({ storeNetwork: true, returningBuyerCode: true, name: "pr10fix Boutique B" });
    const outside = await makeStore({ storeNetwork: false, returningBuyerCode: true });
    await paidOrder(shopA.id, { email: "fidele@pr10fix.test", shippingAddress: { ...address, city: "Lyon" } });
    vi.stubEnv("OPERATOR_RESEND_API_KEY", "re_operator");
    vi.stubEnv("OPERATOR_EMAIL_FROM", "Réseau <noreply@op-pr10fix.test>");
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe("https://api.resend.com/emails");
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer re_operator");
        sent.push(JSON.parse(String(init?.body)));
        return new Response("{}", { status: 200 });
      }),
    );
    const onB = await openSession(shopB.id);
    await deliverLoginCode(onB, "Fidele@pr10fix.test");
    expect(sent).toHaveLength(1);
    expect(sent[0].from).toBe("pr10fix Boutique B <noreply@op-pr10fix.test>");
    const code = /(\d{6})/.exec(String(sent[0].text))![1];
    expect((await verifyLoginCode(onB, "fidele@pr10fix.test", code))?.address.city).toBe("Lyon");
    // A store outside the network never finds the other stores' buyers.
    const onOutside = await openSession(outside.id);
    await deliverLoginCode(onOutside, "fidele@pr10fix.test");
    expect(sent).toHaveLength(1);
  });

  it("subscription and gift card carts go to Shopify's checkout", async () => {
    const post = (items: unknown[]) =>
      sessionsRoute.POST(new Request("https://x.test/api/public/sessions", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.0.0.11" }, body: JSON.stringify({ store: "pr10fix_nostore", items }) }), {
        params: Promise.resolve({}),
      });
    const sub = await post([{ variant_id: 1, quantity: 1, selling_plan: 42 }]);
    expect([sub.status, (await sub.json()).reason]).toEqual([409, "selling_plan"]);
    const gift = await post([{ variant_id: 1, quantity: 1, gift_card: true }]);
    expect([gift.status, (await gift.json()).fallback]).toEqual([409, true]);
  });

  it("a store in another time zone: its days, hours and the 07:00 daily report", async () => {
    const tz = "America/New_York";
    const store = await makeStore({ timezone: tz, enabled: true });
    // 2026-09-09 20:00 UTC = 16:00 in New York (same day), 22:00 in Paris.
    const paidAt = new Date("2026-09-09T02:30:00Z"); // 22:30 on the 8th in New York, 04:30 on the 9th in Paris
    await paidOrder(store.id, { paidAt, createdAt: paidAt });
    const a = await storeAnalytics(store.id, { since: new Date("2026-09-07T00:00:00Z"), until: new Date("2026-09-11T00:00:00Z"), includeTest: false });
    const day = a.daily.find((d) => d.orders > 0)!;
    expect(day.day).toBe("2026-09-08");
    expect(a.heatmap.find((c) => c.sessions > 0)?.hour).toBe(zonedHour(paidAt, tz));
    expect(zonedHour(paidAt, tz)).toBe(22);
    // Daily report: 06:00 in New York (12:00 in Paris) is too early for this store.
    expect(await sendDailyReport(Date.now() + 60_000, new Date("2026-09-09T10:00:00Z"), { storeId: store.id })).toBe(0);
    // 08:00 in New York: yesterday (the 8th, New York time) is reported.
    expect(await sendDailyReport(Date.now() + 60_000, new Date("2026-09-09T12:00:00Z"), { storeId: store.id })).toBe(1);
    const report = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "report.daily" } });
    expect((report.data as { day: string }).day).toBe(addDays("2026-09-09", -1));
  });
});
