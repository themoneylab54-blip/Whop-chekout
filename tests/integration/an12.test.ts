import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Analytics round 12 against a real Postgres: platform ROAS vs POAS per conversion value mode (A1),
 * fallback periods and orders placed outside this checkout (A2), the buyers' Shopify history for new
 * vs returning (A3), the 13-month ad spend history and the CAC window (A4), zone labels in exports
 * (A5) and reduced VAT rates (A8). Shopify, Whop, the ad platforms and notifications are mocked.
 * Test data is prefixed an12fix_ and deleted at the end.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  tagOrder: vi.fn(),
  shopifyGraphql: vi.fn(),
}));
const whop = vi.hoisted(() => ({ createCheckoutConfiguration: vi.fn(), deleteConfig: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendBuyerEmail: vi.fn() }));

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({
  ...(await orig<typeof import("@/lib/whop")>()),
  createCheckoutConfiguration: whop.createCheckoutConfiguration,
  storeClient: () => ({ checkoutConfigurations: { delete: whop.deleteConfig } }),
}));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), requireAdmin: async () => ({ id: "admin" }) }));

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("analytics round 12 (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { DeadlineError } = await import("@/lib/deadline");
  const { addDays, zonedDay, zonedDayStart } = await import("@/lib/time");
  const { storeAnalytics, storeCohorts, dailySeries, resolveRange } = await import("@/lib/analytics");
  const { importAdSpend, backfillAdSpend, adSpendBackfillStatus, spendCoverage, BACKFILL_DAYS } = await import("@/lib/adspend");
  const { recordValueModeChange } = await import("@/lib/value-mode");
  const { noteCheckoutFailure, probeFallbacks } = await import("@/lib/fallback");
  const { importExternalOrders, externalImportStatus, backfillShopifyCustomers, customersBackfillStatus } = await import("@/lib/shopify-history");
  const { syncOrder } = await import("@/lib/checkout");
  const { profitValueCents } = await import("@/lib/conversions");
  const exportRoute = await import("@/app/dashboard/stores/[storeId]/orders/export/route");

  const created: string[] = [];
  const tz = "Europe/Paris";
  const today = zonedDay(new Date(), tz);
  /** Noon (Paris) of a day `n` days ago. */
  const noon = (n: number) => new Date(zonedDayStart(addDays(today, -n), tz).getTime() + 12 * 3600_000);
  const rnd = () => Math.random().toString(36).slice(2, 10);

  const line = (o: Record<string, unknown> = {}) => ({
    variantId: "gid://shopify/ProductVariant/11",
    productId: "gid://shopify/Product/1",
    title: "Sweat",
    variantTitle: null,
    quantity: 1,
    unitPriceCents: 6000,
    unitCostCents: 1000,
    requiresShipping: true,
    ...o,
  });
  const address = (countryCode = "FR") => ({ firstName: "Alex", lastName: "Martin", address1: "1 rue X", city: "Paris", zip: "75001", countryCode });

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({ data: { name: `an12fix_${rnd()}`, testMode: false, ...data } });
    created.push(store.id);
    return store;
  }

  const connected = () => ({
    shopDomain: `an12fix-${Date.now()}-${rnd()}.myshopify.com`,
    shopifyAccessToken: encrypt("t"),
    shopifyConnectedAt: new Date(),
  });

  async function paidOrder(storeId: string, s: Record<string, unknown> = {}) {
    const lines = (s.lines as unknown[]) ?? [line()];
    const total = (s.totalCents as number) ?? 6000;
    const session = await db.checkoutSession.create({
      data: { storeId, currency: "EUR", status: "PAID", lines, subtotalCents: total, totalCents: total, whopFeeCents: 0, paidAt: new Date(), shippingAddress: address(), ...s } as never,
    });
    const q = await db.checkoutQuote.create({
      data: {
        sessionId: session.id,
        whopCheckoutId: `ch_${session.id}`,
        fingerprint: "f",
        currency: "EUR",
        subtotalCents: total,
        discountCents: 0,
        shippingCents: 0,
        addOnsCents: 0,
        totalCents: total,
        shippingCostCents: 0,
        addOns: [],
        addOnIds: [],
      } as never,
    });
    return db.checkoutSession.update({ where: { id: session.id }, data: { paidQuoteId: q.id } });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    shopify.shopifyGraphql.mockReset();
    whop.createCheckoutConfiguration.mockReset();
    vi.unstubAllGlobals();
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    const keys = created.flatMap((id) => [`adspend:${id}`, `value-mode:${id}`, `adspend-backfill:${id}`, `shopify-customers:${id}`, `external-orders:${id}`, `fallback-probe:${id}`]);
    await db.appSetting.deleteMany({ where: { key: { in: keys } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("A1: records the value mode per imported day and compares profit-mode conversions to our margin (POAS)", async () => {
    const store = await makeStore({ metaAdAccountId: "an12", metaAccessToken: encrypt("tok"), conversionValueMode: "profit" });
    // Switched from revenue to profit at noon, 3 days ago.
    await recordValueModeChange(store.id, "revenue", "profit", noon(3));
    const day = (n: number) => addDays(today, -n);
    const insights = [
      { date_start: day(5), campaign_id: "c1", campaign_name: "Automne", spend: "30.00", actions: [{ action_type: "purchase", value: "2" }], action_values: [{ action_type: "purchase", value: "150.00" }] },
      { date_start: day(3), campaign_id: "c1", campaign_name: "Automne", spend: "10.00", actions: [{ action_type: "purchase", value: "1" }], action_values: [{ action_type: "purchase", value: "20.00" }] },
      { date_start: day(1), campaign_id: "c1", campaign_name: "Automne", spend: "20.00", actions: [{ action_type: "purchase", value: "3" }], action_values: [{ action_type: "purchase", value: "60.00" }] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.hostname !== "graph.facebook.com") throw new Error(`unexpected fetch ${url}`);
        return new Response(JSON.stringify({ data: url.searchParams.get("level") === "campaign" ? insights.map((r) => ({ ...r, account_currency: "EUR" })) : [] }));
      }),
    );
    await importAdSpend(Date.now() + 60_000, { storeId: store.id, force: true });
    const rows = await db.adSpend.findMany({ where: { storeId: store.id }, orderBy: { day: "asc" } });
    expect(rows.map((r) => [r.day, r.valueMode])).toEqual([
      [day(5), "revenue"],
      [day(3), "mixed"],
      [day(1), "profit"],
    ]);

    // Our orders of the campaign: one on the revenue day, one on the profit day (margin 5000 − 1000 = 4000 HT each).
    const utm = { utm_source: "facebook", utm_campaign: "Automne" };
    await paidOrder(store.id, { email: "a@an12fix.test", paidAt: noon(5), createdAt: noon(5), utm });
    await paidOrder(store.id, { email: "b@an12fix.test", paidAt: noon(1), createdAt: noon(1), utm });
    const range = resolveRange({ range: "7d" }, today, "7d", tz);
    const a = await storeAnalytics(store.id, { since: range.since, until: range.until, includeTest: false });
    const by = new Map(a.platformVsReal.map((r) => [r.valueMode, r]));
    expect([...by.keys()].sort()).toEqual(["profit", "revenue", "unknown"]);
    // Profit day: the platform's 60 € are a margin, compared to our margin of the d-1 order (no VAT ratio).
    expect(by.get("profit")).toMatchObject({ split: true, spendCents: 2000, platformValueHtCents: 6000, realOrders: 1, realProfitCents: 4000, platformRoas: 3, realRoas: 2, overAttribution: 1.5 });
    // Revenue day: TTC value taken HT at our orders' ratio (5000 / 6000), against our CA HT.
    expect(by.get("revenue")).toMatchObject({ split: true, spendCents: 3000, platformValueHtCents: 12500, realOrders: 1, realRevenueHtCents: 5000 });
    expect(by.get("unknown")).toMatchObject({ spendCents: 1000, realOrders: 0 });
  });

  it("A2: logs fallback periods, flags their days, and imports the orders placed outside this checkout (resuming after the deadline)", async () => {
    const store = await makeStore({ autoFallback: true, ...connected() });
    for (let i = 0; i < 3; i++) await db.eventLog.create({ data: { storeId: store.id, sessionId: `an12fix_s${i}_${rnd()}`, level: "warn", kind: "checkout.init_failed", message: "x" } });
    await noteCheckoutFailure(store.id);
    const open = await db.fallbackPeriod.findFirstOrThrow({ where: { storeId: store.id } });
    expect(open.endedAt).toBeNull();
    expect(open.reason).toContain("3 clients");
    // Whop answers again: the probe switches back and closes the period.
    await db.store.update({ where: { id: store.id }, data: { fallbackActiveAt: new Date(Date.now() - 10 * 60_000) } });
    whop.createCheckoutConfiguration.mockResolvedValue({ id: "ch_probe_an12", purchaseUrl: null });
    await probeFallbacks(Date.now() + 20_000);
    expect((await db.fallbackPeriod.findUniqueOrThrow({ where: { id: open.id } })).endedAt).not.toBeNull();
    expect(await db.fallbackPeriod.count({ where: { storeId: store.id } })).toBe(1);

    // Outside orders: page 1, then the run is cut by the deadline; the next run resumes from the cursor.
    const ours = await paidOrder(store.id, { email: "c@an12fix.test", shopifyOrderId: "gid://shopify/Order/7002" });
    const order = (id: string, o: Record<string, unknown> = {}) => ({
      id: `gid://shopify/Order/${id}`,
      name: `#${id}`,
      createdAt: new Date().toISOString(),
      processedAt: new Date().toISOString(),
      sourceName: "web",
      tags: [],
      test: false,
      cancelledAt: null,
      currentTotalPriceSet: { shopMoney: { amount: "120.00", currencyCode: "EUR" } },
      shippingAddress: { countryCodeV2: "FR" },
      ...o,
    });
    const queries: Record<string, unknown>[] = [];
    let cut = true;
    shopify.shopifyGraphql.mockImplementation(async (_s: unknown, q: string, v: Record<string, unknown>) => {
      if (!q.includes("orders(")) throw new Error("unexpected query");
      queries.push(v);
      if (!v.after)
        return { orders: { pageInfo: { hasNextPage: true, endCursor: "cur1" }, nodes: [order("7001"), order("7009", { tags: ["whop-checkout"], sourceName: "whop-checkout" })] } };
      if (cut) throw new DeadlineError("Shopify orders");
      // Linked to one of our sessions (created by hand then linked), a test order, a cancelled one.
      return { orders: { pageInfo: { hasNextPage: false, endCursor: "cur2" }, nodes: [order("7002"), order("7003", { test: true }), order("7004", { cancelledAt: new Date().toISOString() })] } };
    });
    await importExternalOrders(Date.now() + 60_000, { storeId: store.id });
    let st = await externalImportStatus(store.id);
    expect(st).toMatchObject({ after: "cur1", lastRunAt: null, imported: 1 });
    expect(String(queries[0].q)).toContain("-tag:whop-checkout");
    cut = false;
    await importExternalOrders(Date.now() + 60_000, { storeId: store.id });
    st = await externalImportStatus(store.id);
    expect(st?.after).toBeNull();
    expect(st?.lastRunAt).not.toBeNull();
    expect(queries.at(-1)?.after).toBe("cur1");
    expect(await db.externalOrder.count({ where: { storeId: store.id } })).toBe(4);
    // Daily: not again before 24 h.
    const calls = shopify.shopifyGraphql.mock.calls.length;
    await importExternalOrders(Date.now() + 60_000, { storeId: store.id });
    expect(shopify.shopifyGraphql.mock.calls.length).toBe(calls);

    await db.adSpend.create({ data: { storeId: store.id, day: today, platform: "meta", campaignId: "x", campaignName: "x", spendCents: 3000, currency: "EUR" } });
    const range = resolveRange({ range: "today" }, today, "today", tz);
    const a = await storeAnalytics(store.id, { since: range.since, until: range.until, includeTest: false });
    // Ours: 6000 TTC → 5000 HT. Outside: #7001 only (10000 HT): linked, test and cancelled ones left out.
    expect(a.revenueHtCents).toBe(5000);
    expect(a.leakage).toMatchObject({ orders: 1, revenueCents: 12000, revenueHtCents: 10000, error: null });
    expect(a.leakage!.share).toBeCloseTo(10000 / 15000);
    expect(a.ads.roasInclExternal).toBeCloseTo(15000 / 3000);
    expect(a.fallback.periods).toHaveLength(1);
    expect(a.fallback.days).toEqual([today]);
    expect(a.daily.find((d) => d.day === today)).toMatchObject({ fallback: true, externalOrders: 1, externalRevenueHtCents: 10000 });
    expect((await dailySeries(store.id, addDays(today, -2), today, false)).map((d) => d.fallback)).toEqual([false, false, true]);
    // A source filter: outside orders carry no source, no leakage figure.
    const filtered = await storeAnalytics(store.id, { since: range.since, until: range.until, includeTest: false, filters: { source: "facebook" } });
    expect(filtered.leakage).toBeNull();
    void ours;
  });

  it("A3: counts buyers who already ordered on the Shopify store as returning (order creation + customers backfill)", async () => {
    const store = await makeStore({ ...connected(), shopifyScopes: "write_orders" });
    // Order created by this app for a buyer with an older Shopify order.
    const s = await paidOrder(store.id, { email: "Ret@an12fix.test", whopPaymentId: `pay_an12_${rnd()}` });
    shopify.createPaidOrder.mockResolvedValue({
      id: "gid://shopify/Order/8001",
      name: "#8001",
      customer: { id: "gid://shopify/Customer/1", numberOfOrders: "2", orders: { nodes: [{ id: "gid://shopify/Order/10", createdAt: "2025-03-01T10:00:00Z" }] } },
    });
    await syncOrder(s.id);
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect([row.shopifyOrderId, row.shopifyPriorOrders]).toEqual(["gid://shopify/Order/8001", 1]);
    expect(await db.shopifyCustomer.findUniqueOrThrow({ where: { storeId_email: { storeId: store.id, email: "ret@an12fix.test" } } })).toMatchObject({
      numberOfOrders: 2,
      firstOrderAt: new Date("2025-03-01T10:00:00Z"),
    });

    // Customers backfill (two pages): old@ ordered before; a customer without an e-mail is skipped.
    shopify.shopifyGraphql.mockImplementation(async (_s: unknown, q: string, v: Record<string, unknown>) => {
      if (!q.includes("customers(")) throw new Error("unexpected query");
      return v.after
        ? { customers: { pageInfo: { hasNextPage: false, endCursor: "k2" }, nodes: [{ id: "c9", numberOfOrders: "1", defaultEmailAddress: null, orders: { nodes: [] } }] } }
        : { customers: { pageInfo: { hasNextPage: true, endCursor: "k1" }, nodes: [{ id: "c2", numberOfOrders: "4", defaultEmailAddress: { emailAddress: "old@an12fix.test" }, orders: { nodes: [{ createdAt: "2024-11-11T10:00:00Z" }] } }] } };
    });
    await backfillShopifyCustomers(Date.now() + 60_000, { storeId: store.id });
    expect(await customersBackfillStatus(store.id)).toMatchObject({ state: "done", customers: 1 });
    await paidOrder(store.id, { email: "old@an12fix.test" });
    await paidOrder(store.id, { email: "new@an12fix.test" });
    const range = resolveRange({ range: "today" }, today, "today", tz);
    const a = await storeAnalytics(store.id, { since: range.since, until: range.until, includeTest: false });
    expect(a.customers).toMatchObject({ newCustomers: 1, returningCustomers: 2, newOrders: 1, returningOrders: 2 });
    expect(a.customerHistory).toMatchObject({ state: "done", customers: 1, shopifyReturningOrders: 2 });
    // Cohorts and CAC: those two are no acquisition.
    const c = await storeCohorts(store.id, false);
    expect(c.shopifyReturning).toBe(2);
    expect(c.months.reduce((t, m) => t + m.customers, 0)).toBe(1);
    expect(c.history.state).toBe("done");
  });

  it("A4: imports 13 months of ad spend backwards in chunks, and computes the CAC only over the covered days", async () => {
    const store = await makeStore({ metaAdAccountId: "an12b", metaAccessToken: encrypt("tok") });
    const ranges: { since: string; until: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = new URL(String(input));
        if (url.hostname !== "graph.facebook.com") throw new Error(`unexpected fetch ${url}`);
        const r = JSON.parse(url.searchParams.get("time_range")!) as { since: string; until: string };
        ranges.push(r);
        return new Response(JSON.stringify({ data: [{ date_start: r.since, campaign_id: "k1", campaign_name: "Hiver", spend: "40.00", account_currency: "EUR" }] }));
      }),
    );
    expect(await backfillAdSpend(Date.now() + 60_000, { storeId: store.id })).toBe(1);
    const firstCursor = addDays(today, -6 - 31);
    expect(ranges).toEqual([{ since: firstCursor, until: addDays(today, -7) }]);
    let st = await adSpendBackfillStatus(store.id);
    expect(st?.platforms.meta).toMatchObject({ account: "an12b", cursor: firstCursor, done: false, target: addDays(today, -(BACKFILL_DAYS - 1)) });
    await backfillAdSpend(Date.now() + 60_000, { storeId: store.id });
    expect(ranges[1]).toEqual({ since: addDays(firstCursor, -31), until: addDays(firstCursor, -1) });
    expect(await spendCoverage(store.id, today)).toEqual({ from: addDays(firstCursor, -31), backfilling: true });

    // CAC: customers acquired before the covered days don't count against the spend.
    const utm = { utm_source: "facebook", utm_campaign: "Hiver" };
    await paidOrder(store.id, { email: "early@an12fix.test", paidAt: noon(200), createdAt: noon(200), utm });
    await paidOrder(store.id, { email: "late@an12fix.test", paidAt: noon(10), createdAt: noon(10), utm });
    const c = await storeCohorts(store.id, false);
    expect(c.cacFrom).toBe(addDays(firstCursor, -31));
    expect(c.backfilling).toBe(true);
    expect(c.cacDays).toBeLessThan(365);
    const fb = c.bySource.find((r) => r.source === "facebook")!;
    expect(fb).toMatchObject({ customers: 2, spendCents: 8000, cacCents: 8000 });
    expect(c.blended).toMatchObject({ customers: 1, spendCents: 8000, cacCents: 8000 });

    // A new ad account starts over; the target reached ends the import.
    await db.store.update({ where: { id: store.id }, data: { metaAdAccountId: "an12c" } });
    await backfillAdSpend(Date.now() + 60_000, { storeId: store.id });
    st = await adSpendBackfillStatus(store.id);
    expect(st?.platforms.meta).toMatchObject({ account: "an12c", cursor: firstCursor });
    st!.platforms.meta!.cursor = addDays(st!.platforms.meta!.target, 5);
    await db.appSetting.update({ where: { key: `adspend-backfill:${store.id}` }, data: { value: JSON.stringify(st) } });
    await backfillAdSpend(Date.now() + 60_000, { storeId: store.id });
    expect((await adSpendBackfillStatus(store.id))?.platforms.meta).toMatchObject({ done: true, cursor: st!.platforms.meta!.target });
    expect((await spendCoverage(store.id, today)).backfilling).toBe(false);
  });

  it("A8 + A5: reduced VAT categories in CA HT, the orders export and the profit value; export headers in the store's zone", async () => {
    const store = await makeStore({ timezone: "America/New_York" });
    const food = "gid://shopify/ProductVariant/food";
    await db.productVat.create({ data: { storeId: store.id, variantId: food, category: "food", title: "Café" } });
    const lines = [line({ variantId: food, quantity: 2, unitPriceCents: 1000, unitCostCents: 200 }), line({ unitPriceCents: 2000, unitCostCents: 500 })];
    await paidOrder(store.id, { email: "v@an12fix.test", lines, totalCents: 4000 });
    // Food to Hungary: no known reduced rate there, standard rate (27 %), flagged.
    await paidOrder(store.id, { email: "h@an12fix.test", lines: [line({ variantId: food, unitPriceCents: 1270 })], totalCents: 1270, shippingAddress: address("HU") });
    const rate = (2000 * 0.055 + 2000 * 0.2) / 4000;
    const range = resolveRange({ range: "today" }, zonedDay(new Date(), "America/New_York"), "today", "America/New_York");
    const a = await storeAnalytics(store.id, { since: range.since, until: range.until, includeTest: false });
    expect(a.revenueHtCents).toBe(Math.round(4000 / (1 + rate)) + 1000);
    expect(a.vat).toEqual({ reduced: true, reducedOrders: 2, unknownRateOrders: 1 });

    const res = await exportRoute.GET(new Request(`https://x.test/dashboard/stores/${store.id}/orders/export?days=2`), { params: Promise.resolve({ storeId: store.id }) });
    const csv = await res.text();
    const [header] = csv.split(/\r?\n/);
    expect(header).toContain("Date (heure de New York)");
    expect(header).toContain("Remboursements (date heure de New York : montant)");
    expect(csv).toContain((Math.round(4000 / (1 + rate)) / 100).toFixed(2).replace(".", ","));

    // Profit conversion value: same blended rate.
    const sessionLike = { shippingAddress: address(), store: { vatExempt: false, vatDomesticOnly: false } } as never;
    const margin = { shipCostCents: 0, bumpCostCents: 0, feeCents: 0, feeRate: 0, vatCategories: new Map([[food, "food"]]) };
    expect(profitValueCents(sessionLike, 4000, lines as never, margin)).toBe(Math.round(4000 / (1 + rate)) - 900);
    expect(profitValueCents(sessionLike, 4000, lines as never, { ...margin, vatCategories: undefined })).toBe(Math.round(4000 / 1.2) - 900);
  });
});
