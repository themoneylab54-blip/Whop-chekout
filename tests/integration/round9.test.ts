import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Round 9 (product) against a real Postgres: the daily P&L adds up to the margin (claims
 * included), claims by claim date, fees and margin per payment method, the visitor-country
 * filter, margin-based offer test aggregates, the Google Ads import (fetch mocked), Shopify
 * discount codes and automatic cart discounts through quote → prepare → paid → order input,
 * charging in the buyer's currency, returning-buyer e-mail codes, buyer protection claims and
 * the automatic "frequently bought together" offer. Shopify, Whop and notifications are mocked.
 * Test data is prefixed pr9fix_ and deleted at the end.
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

describe.skipIf(!hasDb)("round 9 (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { storeAnalytics, dailySeries } = await import("@/lib/analytics");
  const { parisDay } = await import("@/lib/time");
  const { offerArmAggregates, offerTests } = await import("@/lib/offer-tests");
  const { importAdSpend } = await import("@/lib/adspend");
  const { quoteSession, prepareSession, confirmSession, markPaid, CheckoutError } = await import("@/lib/checkout");
  const { clearShopifyDiscountCache, verifiedCartDiscounts } = await import("@/lib/shopify-discounts");
  const { requestLoginCode, verifyLoginCode } = await import("@/lib/returning");
  const { submitBuyerClaim, decideClaim } = await import("@/lib/claims");
  const { frequentlyBoughtWith, resolveAutoOffers, upsellContextFor } = await import("@/lib/offer-auto");

  const created: string[] = [];
  let savedFx: { value: string } | null = null;

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
        name: `pr9fix_${Math.random().toString(36).slice(2, 8)}`,
        testMode: false,
        vatExempt: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_pr9",
        whopProductId: "prod_pr9",
        whopApiKey: encrypt("k"),
        shopDomain: `pr9fix-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
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
      data: { storeId, currency: "EUR", status: "PAID", lines: [line()], subtotalCents: 5000, totalCents: 5000, paidAt: new Date(), email: "buyer@pr9fix.test", shippingAddress: address, ...s } as never,
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
      },
    });
    return db.checkoutSession.update({ where: { id: session.id }, data: { paidQuoteId: q.id } });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    clearShopifyDiscountCache();
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/9001", name: "#9001" });
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) =>
      items.map((i) => line({ variantId: String(i.variantId), productId: `gid://shopify/Product/${String(i.variantId).replace(/\D/g, "").slice(0, 1)}`, quantity: i.quantity })),
    );
    whop.createCheckoutConfiguration.mockImplementation(async () => ({ id: `ch_pr9_${Math.random().toString(36).slice(2)}`, purchaseUrl: null }));
  });

  afterAll(async () => {
    await db.buyerLoginCode.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    await db.appSetting.deleteMany({ where: { key: { in: created.map((id) => `adspend:${id}`) } } });
    if (savedFx) await db.appSetting.upsert({ where: { key: "fx:ecb" }, create: { key: "fx:ecb", value: savedFx.value }, update: { value: savedFx.value } });
    else await db.appSetting.deleteMany({ where: { key: "fx:ecb" } });
  });

  it("daily P&L rows add up to the margin, with approved claims only; claims by claim date; fees and margin per method", async () => {
    const store = await makeStore({ fulfillmentFeeCents: 100, disputeFeeCents: 1500 });
    const d1 = new Date(Date.now() - 3 * DAY);
    const d2 = new Date(Date.now() - 2 * DAY);
    const protection = [{ id: "shipping_protection", title: "Protection colis", priceCents: 300, variantId: null, costCents: null }];
    const o1 = await paidOrder(store.id, { paidAt: d1, createdAt: d1, whopFeeCents: 180, paymentMethodType: "card", lines: [line({ unitCostCents: 2000 })] }, protection);
    await paidOrder(store.id, {
      paidAt: d2,
      createdAt: d2,
      whopFeeCents: 250,
      paymentMethodType: "klarna",
      lines: [line({ unitCostCents: 1500 })],
      disputed: true,
      disputeStatus: "lost",
      disputeLostCents: 1000,
    });
    await db.protectionClaim.create({ data: { storeId: store.id, sessionId: o1.id, kind: "reship", costCents: 900, createdAt: d2 } });
    // A buyer's report still pending: never a cost.
    await db.protectionClaim.create({ data: { storeId: store.id, sessionId: o1.id, kind: "reship", costCents: 0, status: "pending", source: "buyer", reason: "lost" } });

    const since = new Date(Date.now() - 5 * DAY);
    const until = new Date(Date.now() + 60_000);
    const a = await storeAnalytics(store.id, { since, until, includeTest: false });
    const days = a.daily.filter((d) => d.orders > 0);
    expect(days).toHaveLength(2);
    for (const d of days) {
      expect(d.revenueHtBeforeDisputesCents - d.disputeLostHtCents).toBe(d.revenueHtCents);
      expect(d.revenueHtCents - d.feesCents - d.costsCents - d.disputeFeesCents - d.claimsCents).toBe(d.netCents);
      expect(d.disputesCents).toBe(d.disputeLostHtCents + d.disputeFeesCents);
    }
    expect(a.daily.reduce((s, d) => s + d.netCents, 0)).toBe(a.profit.grossProfitCents);
    expect(a.daily.reduce((s, d) => s + d.claimsCents, 0)).toBe(900);
    expect(a.profit.claimsCents).toBe(900);
    // o1 day: 5000 − 180 fee − 2000 product − 100 preparation − 900 claim.
    expect(days.find((d) => d.day === parisDay(d1))!.netCents).toBe(5000 - 180 - 2000 - 100 - 900);
    // The claim is dated d2 (claim-date view), the order d1.
    expect(a.claimsByDate).toEqual({ cents: 900, count: 1 });
    const recent = await storeAnalytics(store.id, { since: new Date(d2.getTime() - 3600_000), until, includeTest: false });
    expect(recent.claimsByDate.cents).toBe(900);
    expect(recent.profit.claimsCents).toBe(0);
    // Series used by the overview: same rows.
    const series = await dailySeries(store.id, parisDay(since), parisDay(new Date()), false);
    expect(series.reduce((s, d) => s + d.claimsCents, 0)).toBe(900);

    const card = a.methods.find((m) => m.method === "card")!;
    const klarna = a.methods.find((m) => m.method === "klarna")!;
    expect([card.feesCents, card.grossCents, card.feeKnownOrders]).toEqual([180, 5000, 1]);
    expect(klarna.profitCents).toBe(5000 - 1000 - 250 - 1500 - 100 - 1500);
    expect(card.profitCents + klarna.profitCents).toBe(a.profit.grossProfitCents);
  });

  it("filters on the visitor's country (IP), distinct from the shipping country", async () => {
    const store = await makeStore();
    await paidOrder(store.id, { geoCountry: "BE", shippingAddress: address });
    await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()], geoCountry: "FR" } });
    const range = { since: new Date(Date.now() - DAY), until: new Date(Date.now() + 60_000), includeTest: false };
    const be = await storeAnalytics(store.id, { ...range, filters: { geo: "BE" } });
    expect([be.sessions, be.orders]).toEqual([1, 1]);
    // Shipped to France, visited from Belgium: the shipping-country filter disagrees.
    const shippedBe = await storeAnalytics(store.id, { ...range, filters: { country: "BE" } });
    expect(shippedBe.orders).toBe(0);
    const all = await storeAnalytics(store.id, range);
    expect(all.funnelBy.country.map((g) => g.group).sort()).toEqual(["BE", "FR"]);
  });

  it("offer test aggregates carry margin per impression (cost × quantity + Whop fee)", async () => {
    const store = await makeStore();
    for (const [arm, cost] of [["o1", 1000], ["o1:B", 400]] as const) {
      const s = await paidOrder(store.id, { upsellShownBlocks: [arm], paidAt: new Date(Date.now() - DAY) });
      await db.upsellCharge.create({ data: { sessionId: s.id, blockId: arm, title: "Offre", variantId: "v", amountCents: 2000, quantity: 2, costCents: cost, whopFeeCents: 60, status: "PAID" } });
    }
    const aggs = await offerArmAggregates({ id: store.id, vatExempt: true, vatDomesticOnly: false }, new Date(Date.now() - 5 * DAY), new Date(), false);
    expect(aggs.get("o1")).toMatchObject({ takes: 1, costedTakes: 1, sumCents: 2000, profitSumCents: 2000 - 2000 - 60 });
    expect(aggs.get("o1:B")).toMatchObject({ profitSumCents: 2000 - 800 - 60 });
    const [t] = offerTests(aggs, new Map([["o1", 50]]));
    expect(t.metric).toBe("profit");
    expect(t.b.profitPerImpressionCents).toBe(1140);
  });

  it("imports Google Ads spend (OAuth refresh + searchStream) into the campaign rows", async () => {
    const store = await makeStore({
      googleAdsCustomerId: "1234567890",
      googleAdsLoginCustomerId: "9876543210",
      googleAdsDeveloperToken: encrypt("dev-token"),
      googleAdsClientId: "abc.apps.googleusercontent.com",
      googleAdsClientSecret: encrypt("secret"),
      googleAdsRefreshToken: encrypt("refresh"),
    });
    const day = parisDay(new Date());
    const calls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "ya29.x" }), { status: 200 });
        const q = JSON.parse(String(init?.body)).query as string;
        const results = q.includes("FROM campaign")
          ? [{ campaign: { id: "555", name: "Search FR" }, metrics: { costMicros: "42500000" }, segments: { date: day }, customer: { currencyCode: "EUR" } }]
          : q.includes("FROM ad_group ")
            ? [{ adGroup: { id: "66", name: "Sweat" }, metrics: { costMicros: "42500000" }, segments: { date: day }, customer: { currencyCode: "EUR" } }]
            : [{ adGroupAd: { ad: { id: "77", name: "RSA 1" } }, metrics: { costMicros: "42500000" }, segments: { date: day }, customer: { currencyCode: "EUR" } }];
        return new Response(JSON.stringify([{ results }]), { status: 200 });
      }),
    );
    const written = await importAdSpend(Date.now() + 30_000, { storeId: store.id, force: true });
    expect(written).toBe(1);
    const rows = await db.adSpend.findMany({ where: { storeId: store.id }, orderBy: { campaignId: "asc" } });
    expect(rows.map((r) => [r.platform, r.campaignId, r.spendCents])).toEqual([
      ["google", "555", 4250],
      ["google", "ad:77", 4250],
      ["google", "adset:66", 4250],
    ]);
    // One OAuth exchange for the three reports; developer and manager ids sent.
    expect(calls.filter((c) => c.url.includes("oauth2")).length).toBe(1);
    const report = calls.find((c) => c.url.includes("googleAds:searchStream"))!;
    expect(report.url).toContain("/customers/1234567890/googleAds:searchStream");
    expect(report.init?.headers).toMatchObject({ Authorization: "Bearer ya29.x", "developer-token": "dev-token", "login-customer-id": "9876543210" });
    const status = await db.appSetting.findUnique({ where: { key: `adspend:${store.id}` } });
    expect(JSON.parse(status!.value).platforms.google).toMatchObject({ ok: true, rows: 1, details: 2 });
  });

  it("applies a Shopify discount code end to end: quote, snapshot, no app usage count, order discount code, once per customer", async () => {
    const store = await makeStore({ shopifyDiscountCodes: true, shopifyScopes: "read_products,read_discounts" });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    shopify.shopifyGraphql.mockResolvedValue({
      codeDiscountNodeByCode: {
        codeDiscount: {
          __typename: "DiscountCodeBasic",
          title: "Rentrée",
          status: "ACTIVE",
          startsAt: "2026-01-01T00:00:00Z",
          endsAt: null,
          usageLimit: null,
          asyncUsageCount: 0,
          appliesOncePerCustomer: true,
          context: { __typename: "DiscountBuyerSelectionAll" },
          minimumRequirement: null,
          customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 }, items: { __typename: "AllDiscountItems", allItems: true } },
        },
      },
    });
    const session = await db.checkoutSession.create({
      data: { storeId: store.id, currency: "EUR", lines: [line({ quantity: 2 })], subtotalCents: 10000 },
      include: { store: true },
    });
    const quote = await quoteSession(session, { discountCode: "rentree", addOnIds: [] });
    expect(quote.discount).toMatchObject({ code: "RENTREE", source: "shopify", oncePerCustomer: true });
    expect([quote.totals.discountCents, quote.totals.totalCents]).toEqual([1000, 9000]);
    // Cached: a second quote doesn't call Shopify again.
    await quoteSession(session, { discountCode: "RENTREE", addOnIds: [] });
    expect(shopify.shopifyGraphql).toHaveBeenCalledTimes(1);

    const prepared = await prepareSession(session, { discountCode: "RENTREE", addOnIds: [] });
    const snap = await db.checkoutQuote.findUniqueOrThrow({ where: { whopCheckoutId: prepared.checkoutConfigurationId } });
    expect([snap.discountSource, snap.codeDiscountCents, snap.automaticDiscountCents]).toEqual(["shopify", 1000, 0]);

    await db.checkoutSession.update({ where: { id: session.id }, data: { email: "buyer@pr9fix.test", shippingAddress: address } });
    await markPaid(session.id, { id: `pay_${session.id}`, totalCents: 9000, currency: "eur", checkoutConfigurationId: prepared.checkoutConfigurationId });
    const paid = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect([paid.status, paid.reviewNote, paid.discountCode]).toEqual(["PAID", null, "RENTREE"]);
    const input = shopify.createPaidOrder.mock.calls[0][1];
    expect(input.discount).toMatchObject({ code: "RENTREE", amountCents: 1000, nativeCodeCents: 1000 });

    // Same e-mail, same "once per customer" code on another checkout: refused at pay time.
    const again = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()], subtotalCents: 5000 }, include: { store: true } });
    await expect(
      confirmSession(again, { discountCode: "RENTREE", addOnIds: [], email: "BUYER@pr9fix.test", acceptsMarketing: false, acceptsTerms: true, address }),
    ).rejects.toBeInstanceOf(CheckoutError);
  });

  it("honors Shopify's automatic cart discounts only as re-read from the cart and for the same lines", async () => {
    const store = await makeStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toBe(`https://${store.shopDomain}/cart.js`);
        expect((init?.headers as Record<string, string>).Cookie).toBe("cart=c1-token?key=abc");
        return new Response(
          JSON.stringify({ currency: "EUR", items: [{ variant_id: 11, quantity: 2, line_level_discount_allocations: [{ amount: 1500, discount_application: { type: "automatic", title: "Soldes" } }] }] }),
          { status: 200 },
        );
      }),
    );
    const found = await verifiedCartDiscounts(store, "c1-token?key=abc", [{ variantId: "gid://shopify/ProductVariant/11", quantity: 2, unitPriceCents: 5000 }]);
    expect(found).toMatchObject({ totalCents: 1500, titles: ["Soldes"] });
    expect(await verifiedCartDiscounts(store, "c1-token?key=abc", [{ variantId: "gid://shopify/ProductVariant/11", quantity: 3, unitPriceCents: 5000 }])).toBeNull();

    const session = await db.checkoutSession.create({
      data: { storeId: store.id, currency: "EUR", lines: [line({ quantity: 2 })], subtotalCents: 10000, cartDiscounts: found as never },
      include: { store: true },
    });
    const q = await quoteSession(session, { addOnIds: [] });
    expect(q.automaticDiscount).toEqual({ cents: 1500, titles: ["Soldes"] });
    expect(q.totals.totalCents).toBe(8500);
    // The buyer adds one: Shopify's figure no longer applies.
    const changed = await quoteSession(session, { addOnIds: [], quantities: { "gid://shopify/ProductVariant/11": 3 } });
    expect([changed.automaticDiscount, changed.totals.totalCents]).toEqual([null, 15000]);
  });

  it("charges in the buyer's currency at the ECB rate and reads Whop's amounts back", async () => {
    savedFx = await db.appSetting.findUnique({ where: { key: "fx:ecb" }, select: { value: true } });
    const fx = { date: new Date().toISOString().slice(0, 10), rates: { EUR: 1, CHF: 0.95 }, fetchedAt: new Date().toISOString() };
    await db.appSetting.upsert({ where: { key: "fx:ecb" }, create: { key: "fx:ecb", value: JSON.stringify(fx) }, update: { value: JSON.stringify(fx) } });
    const store = await makeStore({ chargeLocalCurrency: true });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    const session = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()], subtotalCents: 5000 }, include: { store: true } });
    const q = await quoteSession(session, { countryCode: "CH", addOnIds: [] });
    expect(q.charge).toEqual({ currency: "CHF", totalCents: 4750, rate: 0.95 });
    const prepared = await prepareSession(session, { countryCode: "CH", addOnIds: [] });
    expect(whop.createCheckoutConfiguration.mock.calls[0][1]).toMatchObject({ totalCents: 4750, currency: "CHF" });
    await db.checkoutSession.update({ where: { id: session.id }, data: { email: "ch@pr9fix.test", shippingAddress: { ...address, countryCode: "CH" } } });
    await markPaid(session.id, { id: `pay_${session.id}`, totalCents: 4750, currency: "chf", feeCents: 190, checkoutConfigurationId: prepared.checkoutConfigurationId });
    const paid = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect([paid.reviewNote, paid.totalCents, paid.chargeCurrency, paid.chargeFxRate, paid.whopFeeCents]).toEqual([null, 5000, "CHF", 0.95, 200]);
    // Without the option: charged in EUR.
    const plain = await makeStore();
    const s2 = await db.checkoutSession.create({ data: { storeId: plain.id, currency: "EUR", lines: [line()], subtotalCents: 5000 }, include: { store: true } });
    expect((await quoteSession(s2, { countryCode: "CH", addOnIds: [] })).charge).toBeNull();
  });

  it("returning buyer: e-mail code (hashed, 10 min, tries) fills the last paid order's details, nothing before", async () => {
    const store = await makeStore({ returningBuyerCode: true, resendApiKey: encrypt("re_x"), emailFrom: "Shop <a@b.fr>" });
    await paidOrder(store.id, { email: "fidele@pr9fix.test", shippingAddress: { ...address, city: "Lyon" }, acceptsMarketing: true, paidAt: new Date(Date.now() - 20 * DAY) });
    const session = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()], lang: "en" }, include: { store: true } });
    notify.sendEmail.mockResolvedValue(true);

    // Unknown e-mail: same answer, no e-mail, no code.
    expect(await requestLoginCode(session, "nobody@pr9fix.test")).toBe("sent");
    expect(notify.sendEmail).not.toHaveBeenCalled();

    expect(await requestLoginCode(session, "Fidele@pr9fix.test")).toBe("sent");
    expect(notify.sendEmail).toHaveBeenCalledTimes(1);
    const mail = notify.sendEmail.mock.calls[0][1] as { to: string; subject: string; text: string };
    expect(mail.to).toBe("fidele@pr9fix.test");
    expect(mail.subject).toContain("sign-in code");
    const code = /(\d{6})/.exec(mail.text)![1];
    const row = await db.buyerLoginCode.findFirstOrThrow({ where: { sessionId: session.id } });
    expect(row.codeHash).not.toContain(code);
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(9 * 60_000);

    const wrong = code === "000000" ? "111111" : "000000";
    expect(await verifyLoginCode(session, "fidele@pr9fix.test", wrong)).toBeNull();
    expect((await db.buyerLoginCode.findUniqueOrThrow({ where: { id: row.id } })).attempts).toBe(1);
    const buyer = await verifyLoginCode(session, "fidele@pr9fix.test", code);
    expect(buyer).toMatchObject({ email: "fidele@pr9fix.test", acceptsMarketing: true, address: { city: "Lyon" } });
    // Single use.
    expect(await verifyLoginCode(session, "fidele@pr9fix.test", code)).toBeNull();

    // Five wrong tries lock the code, even the right one afterwards.
    await requestLoginCode(session, "fidele@pr9fix.test");
    const code2 = /(\d{6})/.exec((notify.sendEmail.mock.calls[1][1] as { text: string }).text)![1];
    const bad = code2 === "999999" ? "888888" : "999999";
    for (let i = 0; i < 5; i++) await verifyLoginCode(session, "fidele@pr9fix.test", bad);
    expect(await verifyLoginCode(session, "fidele@pr9fix.test", code2)).toBeNull();

    // Store option off: nothing is sent.
    const off = await makeStore();
    const s2 = await db.checkoutSession.create({ data: { storeId: off.id, currency: "EUR", lines: [line()] }, include: { store: true } });
    expect(await requestLoginCode(s2, "fidele@pr9fix.test")).toBe("disabled");
  });

  it("buyer reports a delivery problem (pending, alert), the merchant approves it: only then it costs", async () => {
    const store = await makeStore();
    const protection = [{ id: "shipping_protection", title: "Protection colis", priceCents: 300, variantId: null, costCents: null }];
    const s = await paidOrder(store.id, { email: "c@pr9fix.test" }, protection);
    const noProtection = await paidOrder(store.id, { email: "c@pr9fix.test" });

    expect(await submitBuyerClaim(noProtection.id, { email: "c@pr9fix.test", reason: "lost" })).toEqual({ ok: false, error: "closed" });
    expect(await submitBuyerClaim(s.id, { email: "other@pr9fix.test", reason: "lost" })).toEqual({ ok: false, error: "email" });
    const r = await submitBuyerClaim(s.id, { email: "C@pr9fix.test", reason: "damaged", details: "Carton écrasé", photoUrl: "https://img.example.com/x.jpg" });
    expect(r.ok).toBe(true);
    expect(await submitBuyerClaim(s.id, { email: "c@pr9fix.test", reason: "lost" })).toEqual({ ok: false, error: "pending" });
    const claim = await db.protectionClaim.findFirstOrThrow({ where: { sessionId: s.id } });
    expect([claim.status, claim.source, claim.costCents, claim.reason, claim.photoUrl]).toEqual(["pending", "buyer", 0, "damaged", "https://img.example.com/x.jpg"]);
    const ev = await db.eventLog.findFirstOrThrow({ where: { sessionId: s.id, kind: "protection.claim_reported" } });
    expect(ev.message).toContain("colis ou article abîmé");

    const range = { since: new Date(Date.now() - DAY), until: new Date(Date.now() + 60_000), includeTest: false };
    expect((await storeAnalytics(store.id, range)).profit.claimsCents).toBe(0);
    await decideClaim(store.id, s.id, claim.id, { approve: true, kind: "reship", costCents: 1800 });
    expect((await storeAnalytics(store.id, range)).profit.claimsCents).toBe(1800);
    await expect(decideClaim(store.id, s.id, claim.id, { approve: false })).rejects.toThrow("déjà traité");

    // Out of the 30-day window: closed.
    const old = await paidOrder(store.id, { email: "c@pr9fix.test", paidAt: new Date(Date.now() - 40 * DAY) }, protection);
    expect(await submitBuyerClaim(old.id, { email: "c@pr9fix.test", reason: "lost" })).toEqual({ ok: false, error: "closed" });
  });

  it("automatic offer: the product most bought with the order's products, before this order, not already in it", async () => {
    const store = await makeStore();
    const p = (n: number) => line({ productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}${n}`, title: `Produit ${n}` });
    const past = new Date(Date.now() - 5 * DAY);
    await paidOrder(store.id, { lines: [p(1), p(2)], paidAt: past, email: "r@pr9fix.test" });
    await paidOrder(store.id, { lines: [p(1), p(2)], paidAt: past });
    await paidOrder(store.id, { lines: [p(1), p(3)], paidAt: past });
    await paidOrder(store.id, { lines: [p(2), p(3)], paidAt: past });
    const mine = await paidOrder(store.id, { lines: [p(1)], email: "r@pr9fix.test" });
    // Paid after this order: must not change its pick.
    await paidOrder(store.id, { lines: [p(1), p(3)], paidAt: new Date(Date.now() + 60_000) });
    await paidOrder(store.id, { lines: [p(1), p(3)], paidAt: new Date(Date.now() + 60_000) });

    const fbt = await frequentlyBoughtWith(store.id, ["gid://shopify/Product/1"], { before: mine.paidAt!, excludeSessionId: mine.id });
    expect(fbt.map((c) => [c.productId, c.orders])).toEqual([["gid://shopify/Product/2", 2]]);

    const auto = { id: "u1", type: "upsell", hidden: false, props: { title: "", imageUrl: "", variantId: "", productSource: "auto", priceMode: "percent", discountPercent: 20, conditions: { productIds: [], countries: [], customer: "returning" } } } as never;
    const [resolved] = await resolveAutoOffers(store, mine, [auto]);
    expect((resolved as { props: { variantId: string } }).props.variantId).toBe("gid://shopify/ProductVariant/22");
    // Nothing bought together with product 9: the automatic offer is dropped.
    const lonely = await paidOrder(store.id, { lines: [p(9)] });
    expect(await resolveAutoOffers(store, lonely, [auto])).toEqual([]);

    const ctx = await upsellContextFor(store, mine, [auto]);
    expect([ctx.returning, ctx.units]).toEqual([true, 1]);
  });
});
