import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Round 8 (product) against a real Postgres: app costs applied at payment, the profit
 * conversion value = the Analytics margin, offer A/B statistics / promotion / auto-promotion,
 * the attribution window at query time, the geo-IP funnel, protection claims, ad-spend VAT for
 * VAT-exempt stores, and one-click offers merged into the checkout's Shopify order (Shopify mocked)
 * with their refunds mirrored on the shared order.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  createRefund: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
  orderTracking: vi.fn(),
  orderRefundedCents: vi.fn(),
  orderRefunds: vi.fn(),
  orderForEdit: vi.fn(),
  addVariantToOrder: vi.fn(),
  payOrderBalance: vi.fn(),
  orderPayments: vi.fn(),
}));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn() }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    void Promise.resolve().then(fn);
  },
}));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const DAY = 86_400_000;

describe.skipIf(!hasDb)("round 8 (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { markPaid } = await import("@/lib/checkout");
  const { storeAnalytics, resolveRange } = await import("@/lib/analytics");
  const { setProductCost, fillRecentCosts, offerCostSnapshot } = await import("@/lib/costs");
  const { marginContext, profitValueCents } = await import("@/lib/conversions");
  const { endOfferTest, autoPromoteOffers } = await import("@/lib/offer-tests");
  const { loadThankYouLayout } = await import("@/lib/layout");
  const { recordClaim } = await import("@/lib/claims");
  const { markUpsellPaid, recordUpsellRefund } = await import("@/lib/upsell");
  const { recordRefund } = await import("@/lib/checkout");
  const { offerRefundMarker } = await import("@/lib/refunds");
  const created: string[] = [];
  const rnd = () => Math.random().toString(36).slice(2);
  const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
  const line = (o: Record<string, unknown> = {}) => ({
    variantId: V(42),
    productId: "gid://shopify/Product/7",
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
  const today = () => resolveRange({ range: "today" });

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `R8 ${rnd()}`,
        testMode: false,
        shopDomain: `r8-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        whopAccountId: "biz_r8",
        whopProductId: `prod_r8_${rnd()}`,
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }
  async function paid(storeId: string, data: Record<string, unknown> = {}) {
    return db.checkoutSession.create({
      data: {
        storeId,
        currency: "EUR",
        lines: [line()],
        subtotalCents: 5000,
        totalCents: 5000,
        status: "PAID",
        paidAt: new Date(),
        whopPaymentId: `pay_${rnd()}`,
        whopFeeCents: 0,
        pixelAttempts: 5,
        shippingAddress: { firstName: "A", lastName: "B", address1: "1 rue", city: "Paris", zip: "75001", countryCode: "FR" },
        ...data,
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    notify.sendAlert.mockResolvedValue({ delivered: ["telegram"], failed: [] });
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.priceCart.mockResolvedValue([]);
    shopify.createRefund.mockResolvedValue(undefined);
    shopify.orderRefundedCents.mockResolvedValue(0);
    shopify.orderRefunds.mockResolvedValue([]);
    shopify.payOrderBalance.mockResolvedValue(undefined);
    shopify.orderPayments.mockResolvedValue({ outstandingCents: 0, transactions: [] });
    shopify.createPaidOrder.mockRejectedValue(new Error("unexpected order"));
  });

  afterAll(async () => {
    await db.eventLog.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  /* Costs ---------------------------------------------------------------------------- */

  it("applies app costs at payment (over Shopify's), to bumps, to offers, and from the tick", async () => {
    const store = await makeStore();
    await setProductCost(store.id, { variantId: V(42), costCents: 1234 });
    await setProductCost(store.id, { variantId: V(5), costCents: 300 });
    const s = await db.checkoutSession.create({
      data: { storeId: store.id, currency: "EUR", lines: [line({ unitCostCents: 999 })], subtotalCents: 5000, totalCents: 5990, email: "b@example.com", pixelAttempts: 5 },
    });
    await db.checkoutQuote.create({
      data: {
        sessionId: s.id,
        whopCheckoutId: `ch_${s.id}`,
        fingerprint: "f",
        currency: "EUR",
        subtotalCents: 5000,
        discountCents: 0,
        shippingCents: 0,
        addOnsCents: 990,
        totalCents: 5990,
        shippingCountries: [],
        lines: [line({ unitCostCents: 999 })],
        addOns: [{ id: "bump1", title: "Chaussettes", priceCents: 990, variantId: V(5), costCents: null }],
        addOnIds: ["bump1"],
      },
    });
    await markPaid(s.id, { id: `pay_${s.id}`, totalCents: 5990, currency: "eur", checkoutConfigurationId: `ch_${s.id}` }, { deferSync: true });
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect((row.lines as { unitCostCents: number; unitCostSource: string; shopifyUnitCostCents: number }[])[0]).toMatchObject({ unitCostCents: 1234, unitCostSource: "app", shopifyUnitCostCents: 999 });
    const q = await db.checkoutQuote.findUniqueOrThrow({ where: { id: row.paidQuoteId! } });
    expect((q.addOns as { costCents: number; costSource: string }[])[0]).toMatchObject({ costCents: 300, costSource: "app" });
    // One-click offer at accept time: the app cost wins, Shopify's is kept aside.
    expect(await offerCostSnapshot(store.id, V(42), 800)).toEqual({ costCents: 1234, costSource: "app", shopifyCostCents: 800 });
    expect(await offerCostSnapshot(store.id, V(99), 800)).toEqual({ costCents: 800, costSource: null, shopifyCostCents: null });

    // A recent order that missed the payment-time pass (cost entered afterwards) is filled by the tick.
    const late = await paid(store.id, { lines: [line({ variantId: V(77) })] });
    await setProductCost(store.id, { variantId: V(77), costCents: 450 });
    expect(await fillRecentCosts(Date.now() + 30_000)).toBeGreaterThan(0);
    expect(((await db.checkoutSession.findUniqueOrThrow({ where: { id: late.id } })).lines as { unitCostCents: number }[])[0].unitCostCents).toBe(450);
  });

  it("sends as profit value exactly the order's margin in Analytics", async () => {
    const store = await makeStore({ conversionValueMode: "profit", fulfillmentFeeCents: 150 });
    const rate = await db.shippingRate.create({ data: { storeId: store.id, name: "Colissimo", countries: [], priceCents: 490, costCents: 450 } });
    const s = await paid(store.id, {
      lines: [line({ unitCostCents: 1200, quantity: 2, unitPriceCents: 2500 })],
      subtotalCents: 5000,
      totalCents: 6480,
      whopFeeCents: 230,
      shippingRateId: rate.id,
      shippingAddress: { firstName: "A", lastName: "B", address1: "1", city: "Bruxelles", zip: "1000", countryCode: "BE" },
    });
    const q = await db.checkoutQuote.create({
      data: {
        sessionId: s.id,
        whopCheckoutId: `ch_${s.id}`,
        fingerprint: "f",
        currency: "EUR",
        subtotalCents: 5000,
        discountCents: 0,
        shippingCents: 490,
        addOnsCents: 990,
        totalCents: 6480,
        shippingRateId: rate.id,
        shippingCostCents: 450,
        shippingCountries: [],
        addOns: [{ id: "b", title: "Option", priceCents: 990, variantId: null, costCents: 310 }],
        addOnIds: ["b"],
      },
    });
    await db.checkoutSession.update({ where: { id: s.id }, data: { paidQuoteId: q.id } });
    const session = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id }, include: { store: true } });
    const value = profitValueCents(session, session.totalCents, session.lines as never, await marginContext(session));
    const t = today();
    const a = await storeAnalytics(store.id, { since: t.since, until: t.until, includeTest: false });
    expect(a.orders).toBe(1);
    expect(value).toBe(a.profit.grossProfitCents);
    // 6480 / 1.21 = 5355 HT − 230 fee − 2400 products − 310 bump − 450 carrier − 150 preparation.
    expect(value).toBe(5355 - 230 - 2400 - 310 - 450 - 150);
  });

  /* Offer A/B tests ------------------------------------------------------------------ */

  const upsellBlock = (autoPromote = false) => ({
    id: "u1",
    type: "upsell",
    hidden: false,
    props: {
      badge: "Offre",
      title: "Chaussettes",
      text: "",
      variantId: V(1),
      imageUrl: "",
      priceMode: "fixed",
      price: 20,
      discountPercent: 20,
      compareAt: 0,
      buttonText: "Oui",
      declineText: "Non",
      variantB: { enabled: true, split: 50, variantId: V(2), imageUrl: "", badge: "", title: "Bonnet", text: "", buttonText: "", priceMode: "fixed", price: 25, discountPercent: 20, compareAt: 0, autoPromote },
    },
  });

  async function armSessions(storeId: string, key: string, n: number, takes: number, amountCents: number, at: Date) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(`r8${rnd()}${i}`);
    await db.checkoutSession.createMany({
      data: ids.map((id) => ({ id, storeId, currency: "EUR", lines: [line()], subtotalCents: 5000, totalCents: 5000, status: "PAID" as const, paidAt: at, createdAt: at, upsellShownBlocks: [key] })),
    });
    await db.upsellCharge.createMany({
      data: ids.slice(0, takes).map((sessionId) => ({ sessionId, blockId: key, title: "Offre", variantId: V(1), amountCents, status: "PAID" })),
    });
  }

  it("computes the offer test statistics in Analytics and promotes arm B by hand", async () => {
    const store = await makeStore({ thankYouLayout: { blocks: [upsellBlock()] }, draftThankYouLayout: { blocks: [upsellBlock()] } });
    const t = today();
    const at = new Date(Math.max(t.since.getTime() + 60_000, Date.now() - 60_000));
    await armSessions(store.id, "u1", 30, 3, 2400, at);
    await armSessions(store.id, "u1:B", 28, 7, 3000, at);
    const a = await storeAnalytics(store.id, { since: t.since, until: t.until, includeTest: false });
    expect(a.offerTests).toHaveLength(1);
    const test = a.offerTests[0];
    expect(test).toMatchObject({ offerId: "u1", offerTitle: "Chaussettes", live: true, split: 50, a: { impressions: 30, takes: 3 }, b: { impressions: 28, takes: 7 } });
    // CA HT per impression, net: 3 × 2000 HT / 30 and 7 × 2500 HT / 28.
    expect(test.a.revenuePerImpressionHtCents).toBe(200);
    expect(test.b.revenuePerImpressionHtCents).toBe(625);
    expect(test.decision).toEqual({ kind: "waiting", reason: "too_early" });

    expect(await endOfferTest(store.id, "u1", "B", "manual")).toBe(true);
    const after = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    for (const raw of [after.thankYouLayout, after.draftThankYouLayout]) {
      const b = loadThankYouLayout(raw).blocks.find((x) => x.id === "u1");
      expect(b?.type === "upsell" && [b.props.variantId, b.props.price, b.props.title, b.props.variantB?.enabled]).toEqual([V(2), 25, "Bonnet", false]);
    }
    expect(await db.layoutVersion.count({ where: { storeId: store.id, label: { contains: "variante B promue" } } })).toBe(1);
    // Nothing left to promote.
    expect(await endOfferTest(store.id, "u1", "B", "manual")).toBe(false);
  });

  it("auto-promotes a significant winner after 7 days and 200 impressions per arm", async () => {
    const store = await makeStore({ thankYouLayout: { blocks: [upsellBlock(true)] } });
    const at = new Date(Date.now() - 10 * DAY);
    await armSessions(store.id, "u1", 400, 12, 2400, at);
    await armSessions(store.id, "u1:B", 400, 60, 3000, at);
    expect(await autoPromoteOffers()).toBeGreaterThanOrEqual(1);
    const b = loadThankYouLayout((await db.store.findUniqueOrThrow({ where: { id: store.id } })).thankYouLayout).blocks.find((x) => x.id === "u1")!;
    expect(b.type === "upsell" && [b.props.variantId, b.props.variantB?.enabled]).toEqual([V(2), false]);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "offer_test.decided" } })).toBe(1);
  });

  /* Attribution window, geo funnel ----------------------------------------------------- */

  it("applies the attribution window at query time on the dated touch", async () => {
    const store = await makeStore({ attributionDays: 7 });
    const touch = (daysAgo: number) => ({ utm_source: "facebook", utm_campaign: "hiver", ts: new Date(Date.now() - daysAgo * DAY).toISOString() });
    await paid(store.id, { utm: touch(3) });
    await paid(store.id, { utm: touch(20) });
    await paid(store.id, { utm: { utm_source: "tiktok" } }); // undated (older loader): always counts
    const t = today();
    const by = async (days?: number) => {
      const a = await storeAnalytics(store.id, { since: t.since, until: t.until, includeTest: false }, { attributionDays: days, rowLimit: Infinity });
      return Object.fromEntries(a.sources.map((r) => [r.source, r.orders]));
    };
    expect(await by()).toEqual({ facebook: 1, "direct / inconnu": 1, tiktok: 1 });
    expect(await by(1)).toEqual({ "direct / inconnu": 2, tiktok: 1 });
    expect(await by(28)).toEqual({ facebook: 2, tiktok: 1 });
    const a = await storeAnalytics(store.id, { since: t.since, until: t.until, includeTest: false }, { attributionDays: 28 });
    expect(a.attribution).toEqual({ touch: "last", days: 28, storeDays: 7 });
  });

  it("keeps old touches at session creation and records the IP country for the funnel", async () => {
    const { POST } = await import("@/app/api/public/sessions/route");
    const store = await makeStore({ enabled: true, shopifyConnectedAt: new Date(), whopConnectedAt: new Date() });
    shopify.priceCart.mockResolvedValueOnce([line()]);
    const ts = String(Date.now() - 20 * DAY);
    const res = await POST(
      new Request("http://x/api/public/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-vercel-ip-country": "be", "x-forwarded-for": `10.8.${Math.floor(Math.random() * 250)}.1` },
        body: JSON.stringify({ store: store.publicId, items: [{ variant_id: 42, quantity: 1 }], utm: { utm_source: "facebook", ts } }),
      }),
      { params: Promise.resolve({}) } as never,
    );
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const s = await db.checkoutSession.findUniqueOrThrow({ where: { id } });
    expect(s.geoCountry).toBe("BE");
    expect((s.utm as { utm_source: string; ts: string }).ts).toBe(new Date(Number(ts)).toISOString());
    const t = today();
    const a = await storeAnalytics(store.id, { since: t.since, until: t.until, includeTest: false });
    // No address typed yet: the funnel by country uses the IP country.
    expect(a.funnelBy.country.map((g) => g.group)).toContain("BE");
    // The 20-day-old click is outside the store's 7-day window.
    expect(a.funnelBy.source.map((g) => g.group)).not.toContain("facebook");
  });

  /* Claims, ad VAT ------------------------------------------------------------------- */

  it("records protection claims against the order's margin and the protection P&L", async () => {
    const store = await makeStore();
    const s = await paid(store.id, { totalCents: 5290, addOnsCents: 290 });
    const q = await db.checkoutQuote.create({
      data: {
        sessionId: s.id,
        whopCheckoutId: `ch_${s.id}`,
        fingerprint: "f",
        currency: "EUR",
        subtotalCents: 5000,
        discountCents: 0,
        shippingCents: 0,
        addOnsCents: 290,
        totalCents: 5290,
        shippingCountries: [],
        addOns: [{ id: "shipping_protection", title: "Protection colis", priceCents: 290, variantId: null, costCents: null }],
        addOnIds: [],
      },
    });
    await db.checkoutSession.update({ where: { id: s.id }, data: { paidQuoteId: q.id } });
    const t = today();
    const before = await storeAnalytics(store.id, { since: t.since, until: t.until, includeTest: false });
    await recordClaim(store.id, s.id, { kind: "reship", costCents: 1850, note: "Colis perdu" });
    await expect(recordClaim(store.id, s.id, { kind: "reship", costCents: -1 })).rejects.toThrow(/Coût invalide/);
    const open = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()] } });
    await expect(recordClaim(store.id, open.id, { kind: "refund", costCents: 100 })).rejects.toThrow(/non payée/);
    const after = await storeAnalytics(store.id, { since: t.since, until: t.until, includeTest: false });
    expect(after.profit.claimsCents).toBe(1850);
    expect(after.profit.grossProfitCents).toBe(before.profit.grossProfitCents - 1850);
    expect(after.protection).toEqual({ orders: 1, revenueHtCents: 242, claims: 1, claimsCents: 1850, resultCents: 242 - 1850 });
  });

  it("adds the non-reclaimable VAT to the ad spend of a VAT-exempt store", async () => {
    const store = await makeStore({ vatExempt: true, adSpendVatNonReclaimable: true });
    const t = today();
    await db.adSpend.create({ data: { storeId: store.id, day: t.from, platform: "meta", campaignId: "c1", campaignName: "Hiver", spendCents: 10_000, currency: "EUR" } });
    await paid(store.id);
    const a = await storeAnalytics(store.id, { since: t.since, until: t.until, includeTest: false });
    expect(a.ads.spendCents).toBe(12_000);
    await db.store.update({ where: { id: store.id }, data: { adSpendVatNonReclaimable: false } });
    expect((await storeAnalytics(store.id, { since: t.since, until: t.until, includeTest: false })).ads.spendCents).toBe(10_000);
  });

  /* One-click offer merged into the checkout's order ----------------------------------- */

  const order = (lines: { id: string; variantId: string; discounts?: string[] }[], extra: Record<string, unknown> = {}) => ({
    id: "gid://shopify/Order/500",
    name: "#1500",
    fulfillmentStatus: "UNFULFILLED",
    cancelled: false,
    closed: false,
    tags: [],
    outstandingCents: 0,
    lines: lines.map((l) => ({ quantity: 1, discounts: [], ...l })),
    ...extra,
  });

  async function offerSetup(extra: Record<string, unknown> = {}) {
    const store = await makeStore({ shopifyScopes: "read_products,write_orders,write_order_edits", mergeOffersIntoOrder: true, ...extra });
    const s = await paid(store.id, { shopifyOrderId: "gid://shopify/Order/500", shopifyOrderName: "#1500", email: "b@example.com" });
    const charge = await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "u1", title: "Bonnet", variantId: V(9), amountCents: 1500, status: "PENDING", pixelAttempts: 5 } });
    return { store, s, charge };
  }

  it("adds a paid offer to the original order, pays its balance and mirrors its refund on its line", async () => {
    const { store, s, charge } = await offerSetup();
    shopify.orderForEdit
      .mockResolvedValueOnce(order([{ id: "L1", variantId: V(42) }]))
      .mockResolvedValueOnce(order([{ id: "L1", variantId: V(42) }, { id: "L2", variantId: V(9), discounts: [`Offre post-achat wc-offer-in-${charge.id}`] }], { outstandingCents: 1500 }));
    shopify.addVariantToOrder.mockResolvedValueOnce({ status: "committed" });
    shopify.orderPayments.mockResolvedValueOnce({ outstandingCents: 1500, transactions: [] });
    await markUpsellPaid(charge.id, `pay_${charge.id}`, store.id);
    const row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row).toMatchObject({ orderMode: "merged", shopifyOrderId: "gid://shopify/Order/500", shopifyOrderName: "#1500", shopifyLineItemId: "L2", syncAmbiguousAt: null });
    expect(shopify.addVariantToOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orderId: "gid://shopify/Order/500", variantId: V(9), quantity: 1, amountCents: 1500, marker: `wc-offer-in-${charge.id}` }));
    expect(shopify.payOrderBalance).toHaveBeenCalledWith(expect.anything(), "gid://shopify/Order/500", 1500, "EUR", `wc-offer-in-${charge.id}`);
    expect(shopify.tagOrder).toHaveBeenCalledWith(expect.anything(), "gid://shopify/Order/500", [`wc-offer-in-${charge.id}`]);
    expect(row.balanceSettledAt).not.toBeNull();
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();

    // Offer refunded in full: refunded on its line of the original order, marked in the note.
    await recordUpsellRefund(charge.id, `rf_${rnd()}`, 1500);
    expect(shopify.createRefund).toHaveBeenLastCalledWith(expect.anything(), "gid://shopify/Order/500", 1500, `Remboursé via Whop ${offerRefundMarker(charge.id)}`, [{ lineItemId: "L2", quantity: 1 }], { marker: `wc-offer-in-${charge.id}` });
    // The checkout's own refund on the same order doesn't count the offer's refund as its own.
    shopify.orderRefunds.mockResolvedValue([{ note: `Remboursé via Whop ${offerRefundMarker(charge.id)}`, cents: 1500 }]);
    await recordRefund(s.id, 1000, `rf_${rnd()}`);
    expect(shopify.createRefund).toHaveBeenLastCalledWith(expect.anything(), "gid://shopify/Order/500", 1000, "Remboursé via Whop", []);
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).refundMirroredCents).toBe(1500);
  });

  it("never adds the offer twice after a commit of unknown outcome", async () => {
    const { store, charge } = await offerSetup();
    const { ShopifyError } = await import("@/lib/shopify");
    shopify.orderForEdit.mockResolvedValueOnce(order([{ id: "L1", variantId: V(42) }]));
    shopify.addVariantToOrder.mockRejectedValueOnce(new ShopifyError("Shopify injoignable : timeout"));
    await markUpsellPaid(charge.id, `pay_${charge.id}`, store.id);
    let row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row.shopifyOrderId).toBeNull();
    expect(row.shopifyLineItemId).toBe("pending:L1");
    expect(row.syncAmbiguousAt).not.toBeNull();
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    // Retry after the consistency wait: the new line (not in the snapshot) is the offer's.
    await db.upsellCharge.update({ where: { id: charge.id }, data: { syncAmbiguousAt: new Date(Date.now() - 6 * 60_000), nextSyncAt: null } });
    shopify.orderForEdit.mockResolvedValueOnce(order([{ id: "L1", variantId: V(42) }, { id: "L7", variantId: V(9) }]));
    await markUpsellPaid(charge.id, `pay_${charge.id}`, store.id);
    row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row).toMatchObject({ orderMode: "merged", shopifyLineItemId: "L7", syncAmbiguousAt: null });
    expect(shopify.addVariantToOrder).toHaveBeenCalledTimes(1);
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
  });

  it("falls back to a separate order when the original is shipped, the edit is refused or the scope is missing", async () => {
    const created = { id: "gid://shopify/Order/901", name: "#1901" };
    shopify.priceCart.mockResolvedValue([line({ variantId: V(9) })]);
    // Shipped already.
    let { store, charge } = await offerSetup();
    shopify.createPaidOrder.mockResolvedValueOnce(created);
    shopify.orderForEdit.mockResolvedValueOnce(order([{ id: "L1", variantId: V(42) }], { fulfillmentStatus: "FULFILLED" }));
    await markUpsellPaid(charge.id, `pay_${charge.id}`, store.id);
    expect(await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).toMatchObject({ orderMode: "separate", shopifyOrderId: created.id, shopifyLineItemId: null });
    expect(shopify.addVariantToOrder).not.toHaveBeenCalled();
    // Edit refused before its commit.
    ({ store, charge } = await offerSetup());
    shopify.createPaidOrder.mockResolvedValueOnce(created);
    shopify.orderForEdit.mockResolvedValueOnce(order([{ id: "L1", variantId: V(42) }]));
    shopify.addVariantToOrder.mockResolvedValueOnce({ status: "refused", reason: "The order cannot be edited" });
    await markUpsellPaid(charge.id, `pay_${charge.id}`, store.id);
    expect(await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).toMatchObject({ orderMode: "separate", syncAmbiguousAt: null });
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "upsell.merge_refused" } })).toBe(1);
    // Store connected before the order-edit permission.
    ({ store, charge } = await offerSetup({ shopifyScopes: "read_products,write_orders" }));
    shopify.createPaidOrder.mockResolvedValueOnce(created);
    await markUpsellPaid(charge.id, `pay_${charge.id}`, store.id);
    expect(await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).toMatchObject({ orderMode: "separate" });
    expect(shopify.orderForEdit).toHaveBeenCalledTimes(2);
  });
});
