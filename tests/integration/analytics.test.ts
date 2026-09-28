import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The metric engine against a real Postgres (isolated test DB): HT/VAT, full costs, offers per
 * block, funnel, filters, ad spend attribution, overview = analytics, cohorts, A/B aggregates,
 * drill-down and the ad spend import (fetch mocked). Notifications are mocked.
 */

const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn() }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("analytics (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { parisDay } = await import("@/lib/time");
  const {
    storeAnalytics,
    resolveRange,
    storeCohorts,
    experimentResults,
    drillSessionIds,
    storeSummary,
    setExperimentMetric,
    fixedCostsFor,
    notifyAnomalies,
    sendDailyReport,
    parisDayStart,
    notifyStopLoss,
    filterOptions,
  } = await import("@/lib/analytics");
  const { addDays } = await import("@/lib/time");
  const { createBlock } = await import("@/lib/layout");
  const { overviewStats } = await import("@/lib/dashboard-stats");
  const { importAdSpend } = await import("@/lib/adspend");

  const created: string[] = [];
  const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148";
  const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120";
  const line = (o: Record<string, unknown> = {}) => ({
    variantId: "gid://shopify/ProductVariant/42",
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

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({ data: { name: "Analytics IT", testMode: false, ...data } });
    created.push(store.id);
    return store;
  }

  async function paidOrder(storeId: string, s: Record<string, unknown>, quote: Record<string, unknown> = {}) {
    const session = await db.checkoutSession.create({ data: { storeId, currency: "EUR", status: "PAID", lines: [line()], ...s } as never });
    const q = await db.checkoutQuote.create({
      data: {
        sessionId: session.id,
        whopCheckoutId: `ch_${session.id}`,
        fingerprint: "f",
        currency: "EUR",
        subtotalCents: session.subtotalCents,
        discountCents: 0,
        shippingCents: session.shippingCents,
        addOnsCents: session.addOnsCents,
        totalCents: session.totalCents,
        addOns: [],
        addOnIds: [],
        ...quote,
      } as never,
    });
    return db.checkoutSession.update({ where: { id: session.id }, data: { paidQuoteId: q.id } });
  }

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: created } } });
    await db.appSetting.deleteMany({ where: { key: { in: [...created.map((id) => `adspend:${id}`), "fx:ecb"] } } });
    for (const id of created)
      await db.appSetting.deleteMany({
        where: {
          OR: [
            { key: { startsWith: `anomaly:${id}:` } },
            { key: { startsWith: `alert:${id}:` } },
            { key: `anomaly-scan:${id}` },
            { key: `daily-report:${id}` },
            { key: `stoploss-scan:${id}` },
            { key: { startsWith: `stoploss:${id}:` } },
            { key: `nosales:${id}` },
            { key: `failspike:${id}` },
            { key: { startsWith: `disputerate:${id}:` } },
          ],
        },
      });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("computes HT, VAT, full costs, offers per block, funnel, customers and ad spend on one basis", async () => {
    const store = await makeStore({ fulfillmentFeeCents: 150 });
    const today = resolveRange({ range: "today" });
    // Close to now but inside today (Paris), whatever the time of day.
    const at = (minAgo: number) => new Date(Math.max(today.since.getTime() + 60_000, Date.now() - minAgo * 60_000));
    const rate = await db.shippingRate.create({ data: { storeId: store.id, name: "Colissimo", countries: [], priceCents: 490, costCents: 400 } });

    // Old order of b@x: makes b@x a returning customer today.
    await paidOrder(store.id, { email: "b@x.test", paidAt: new Date(Date.now() - 10 * 86_400_000), createdAt: new Date(Date.now() - 10 * 86_400_000), subtotalCents: 3000, totalCents: 3000 });

    // O1 — France, mobile, facebook/Automne, refunded shipping, one offer accepted (partly refunded) and one declined.
    const o1 = await paidOrder(
      store.id,
      {
        email: "a@x.test",
        visitorId: "v1",
        userAgent: MOBILE_UA,
        createdAt: at(9),
        paidAt: at(8),
        emailEnteredAt: at(9),
        subtotalCents: 5000,
        shippingCents: 490,
        totalCents: 5490,
        refundedCents: 490,
        whopFeeCents: 200,
        shippingRateId: rate.id,
        lines: [line({ unitCostCents: 2000 })],
        shippingAddress: { countryCode: "FR", firstName: "A", lastName: "B" },
        utm: { utm_source: "facebook", utm_campaign: "Automne", utm_id: "c1" },
        upsellShownAt: at(7),
        upsellShownBlocks: ["b1", "b2"],
      },
      { shippingCostCents: 400, shippingRateId: rate.id },
    );
    await db.upsellCharge.create({
      data: { sessionId: o1.id, blockId: "b1", title: "Bonnet", variantId: "v", amountCents: 700, quantity: 1, status: "PAID", whopFeeCents: 50, costCents: 200, refundedCents: 100 },
    });
    await db.upsellCharge.create({ data: { sessionId: o1.id, blockId: "b2", title: "Écharpe", variantId: "v2", amountCents: 900, status: "DECLINED" } });

    // O2 — Belgium (21 %), desktop, tiktok/ugc, an order bump with a cost, legacy offer impression (no block ids), returning buyer.
    await paidOrder(
      store.id,
      {
        email: "B@x.test",
        visitorId: "v2",
        userAgent: DESKTOP_UA,
        createdAt: at(6),
        paidAt: at(5),
        subtotalCents: 5500,
        addOnsCents: 300,
        totalCents: 5800,
        whopFeeCents: 180,
        paymentMethodType: "card",
        lines: [line({ quantity: 2, unitPriceCents: 2750, unitCostCents: 1000 })],
        shippingAddress: { countryCode: "BE" },
        utm: { utm_source: "tiktok", utm_campaign: "ugc" },
        upsellShownAt: at(4),
      },
      { shippingCostCents: 350, addOns: [{ id: "ad1", title: "Protection", priceCents: 300, variantId: null, costCents: 50 }] },
    );

    // Test order (excluded), and two open checkouts.
    await paidOrder(store.id, { test: true, email: "t@x.test", paidAt: at(3), createdAt: at(3), subtotalCents: 9900, totalCents: 9900 });
    const s4 = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [], visitorId: "v1", userAgent: DESKTOP_UA, createdAt: at(4), emailEnteredAt: at(4) } });
    await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [], visitorId: "v3", userAgent: DESKTOP_UA, createdAt: at(3) } });

    const day = parisDay(new Date());
    await db.adSpend.createMany({
      data: [
        { storeId: store.id, day, platform: "meta", campaignId: "c9", campaignName: "AUTOMNE", spendCents: 1000, currency: "EUR" },
        { storeId: store.id, day, platform: "meta", campaignId: "c1", campaignName: "Renamed", spendCents: 300, currency: "EUR" },
        { storeId: store.id, day, platform: "google", campaignId: "g1", campaignName: "Brand", spendCents: 200, currency: "EUR" },
      ],
    });

    const a = await storeAnalytics(store.id, { since: today.since, until: today.until, prevSince: today.prevSince, includeTest: false });
    // O1: net 5490 + 700 − 490 − 100 = 5600 → HT 4667; O2: 5800 → HT round(5800 / 1.21) = 4793.
    expect(a.orders).toBe(2);
    expect(a.revenueCents).toBe(11400);
    expect(a.revenueHtCents).toBe(4667 + 4793);
    expect(a.vatCents).toBe(11400 - 9460);
    expect(a.upsellRevenueCents).toBe(600);
    expect(a.feesCents).toBe(200 + 50 + 180);
    expect(a.feesKnown).toBe(true);
    expect(a.profit.cogsCents).toBe(2000 + 200 + 2000);
    expect(a.profit.bumpCostCents).toBe(50);
    expect(a.profit.shippingCostCents).toBe(750);
    expect(a.profit.fulfilmentCents).toBe(300);
    const profit = 9460 - 430 - 4200 - 50 - 750 - 300;
    expect(a.profit.grossProfitCents).toBe(profit);
    expect(a.profit.complete).toBe(true);
    expect(a.aovCents).toBe(5700);
    expect(a.risk.refundedCents).toBe(590);
    expect(a.customers).toMatchObject({ newOrders: 1, returningOrders: 1 });
    expect(a.daily.find((d) => d.day === day)).toMatchObject({ orders: 2, revenueHtCents: 9460, netCents: profit, spendCents: 1500 });

    // Offers: impressions per block on the orders' payment date, plus the legacy order for every block.
    expect(a.offers.find((o) => o.blockId === "b1")).toMatchObject({ title: "Bonnet", impressions: 2, paid: 1, takeRate: 0.5, revenueCents: 600, estimated: true });
    expect(a.offers.find((o) => o.blockId === "b2")).toMatchObject({ impressions: 2, paid: 0, declined: 1, takeRate: 0 });
    expect(a.upsell).toMatchObject({ shown: 2, accepted: 1, legacyShown: 1 });

    // Visitors: v1 (paid + another checkout), v2 (paid), v3 → 2 / 3; checkouts: 2 / 4.
    expect(a.sessions).toBe(4);
    expect(a.visitors).toBe(3);
    expect(a.cvr).toBeCloseTo(2 / 3);
    expect(a.checkoutCvr).toBeCloseTo(0.5);
    expect(a.abandoned).toBe(2);
    // Only the recorded step shows (no fake drop for steps never measured).
    expect(a.funnel).toEqual([
      { key: "opened", label: "Checkout ouvert", count: 4 },
      { key: "email", label: "E-mail saisi", count: 3 },
      { key: "paid", label: "Payé", count: 2 },
    ]);

    // Ad spend: by campaign name (case-insensitive) and utm_id; the rest is unattributed.
    const fb = a.sources.find((r) => r.source === "facebook")!;
    expect(fb).toMatchObject({ campaign: "Automne", orders: 1, revenueHtCents: 4667, spendCents: 1300, cpaCents: 1300 });
    expect(fb.roas).toBeCloseTo(4667 / 1300);
    expect(fb.profitAfterAdsCents).toBe(fb.profitCents - 1300);
    expect(a.ads.spendCents).toBe(1500);
    expect(a.ads.unattributed).toEqual([{ platform: "google", campaign: "Brand", spendCents: 200 }]);
    expect(a.ads.netAfterAdsCents).toBe(profit - 1500);
    expect(a.sources.reduce((s, r) => s + r.revenueHtCents, 0)).toBe(a.revenueHtCents);

    // Filters apply to every metric.
    const be = await storeAnalytics(store.id, { since: today.since, until: today.until, includeTest: false, filters: { country: "BE" } });
    expect([be.orders, be.revenueHtCents, be.ads.available]).toEqual([1, 4793, false]);
    const mobile = await storeAnalytics(store.id, { since: today.since, until: today.until, includeTest: false, filters: { device: "mobile" } });
    expect([mobile.orders, mobile.sessions, mobile.revenueCents]).toEqual([1, 1, 5600]);
    const tiktok = await storeAnalytics(store.id, { since: today.since, until: today.until, includeTest: false, filters: { source: "tiktok" } });
    expect([tiktok.orders, tiktok.ads.spendCents, tiktok.ads.unattributed.length]).toEqual([1, 0, 0]);

    // Test orders only when asked (store in test mode).
    const withTest = await storeAnalytics(store.id, { since: today.since, until: today.until, includeTest: true });
    expect(withTest.orders).toBe(3);

    // Overview and cross-store summary use the same engine.
    const ov = await overviewStats(store.id, today, false);
    expect([ov.analytics.revenueHtCents, ov.analytics.orders, ov.analytics.aovCents]).toEqual([a.revenueHtCents, a.orders, a.aovCents]);
    expect(ov.daily).toHaveLength(7);
    expect(ov.daily.at(-1)).toMatchObject({ date: today.to, orders: 2, revenueHtCents: 9460 });
    const sum = await storeSummary(store.id, today, false);
    expect([sum.revenueHtCents, sum.profitCents, sum.netAfterAdsCents, sum.orders]).toEqual([9460, profit, profit - 1500, 2]);
    expect([sum.roas, sum.previous.orders]).toEqual([9460 / 1500, 0]);

    // Drill-down to the Orders list.
    expect(await drillSessionIds(store.id, { source: "facebook" }, { since: today.since, until: today.until })).toEqual([o1.id]);
    expect((await drillSessionIds(store.id, { product: "gid://shopify/Product/7" }, { since: today.since, until: today.until, includeTest: false })).length).toBe(2);
    expect(await drillSessionIds(store.id, { device: "desktop", country: "BE" })).toHaveLength(1);
    expect(await drillSessionIds(store.id, { method: "inconnu" }, { since: today.since, until: today.until, includeTest: false })).toEqual(expect.arrayContaining([o1.id, s4.id]));

    // Cohorts: two customers, b@x acquired 10 days ago and back today.
    const cohorts = await storeCohorts(store.id, false);
    expect(cohorts.months.reduce((s, m) => s + m.customers, 0)).toBe(2);
    expect(cohorts.bySource.map((r) => r.source).sort()).toEqual(["direct / inconnu", "facebook"]);
  });

  it("marks profit incomplete when a cost is unknown, and the previous period as not comparable", async () => {
    const store = await makeStore();
    const today = resolveRange({ range: "today" });
    const yesterday = new Date(today.since.getTime() - 3600_000);
    await paidOrder(store.id, { paidAt: yesterday, createdAt: yesterday, subtotalCents: 1000, totalCents: 1000, whopFeeCents: 30, shippingAddress: { countryCode: "FR" } });
    await paidOrder(store.id, { paidAt: new Date(Math.max(today.since.getTime() + 60_000, Date.now() - 60_000)), subtotalCents: 2000, totalCents: 2000, lines: [line({ unitCostCents: 500 })], whopFeeCents: 60 }, { shippingCostCents: 100 });
    const a = await storeAnalytics(store.id, { since: today.since, until: today.until, prevSince: today.prevSince, includeTest: false });
    expect(a.profit.complete).toBe(true);
    // Yesterday: no unit cost and no shipping cost → incomplete, so no fake comparison.
    expect(a.previous.orders).toBe(1);
    // Still compared, as an estimate: 1000 TTC → 833 HT − 30 of fees (unknown costs count 0).
    expect(a.previous.profitCents).toBe(833 - 30);
    expect(a.previous.profitEstimated).toBe(true);
    expect(a.previous.profitIncomplete).toBe(true);
  });

  it("aggregates A/B results per visitor in SQL with a winsorized revenue per visitor", async () => {
    const store = await makeStore();
    const version = await db.layoutVersion.create({ data: { storeId: store.id, label: "B", theme: {}, checkoutLayout: {}, thankYouLayout: {} } });
    const exp = await db.experiment.create({ data: { storeId: store.id, name: "T", versionId: version.id, splitB: 50, startedAt: new Date(Date.now() - 3 * 86_400_000) } });
    const rows = [];
    for (let i = 0; i < 40; i++) {
      const variant = i % 2 ? "B" : "A";
      const paid = i < 10;
      rows.push({
        storeId: store.id,
        currency: "EUR",
        lines: [],
        experimentId: exp.id,
        variant,
        visitorId: `x${i}`,
        status: paid ? ("PAID" as const) : ("OPEN" as const),
        paidAt: paid ? new Date() : null,
        totalCents: paid ? (i === 0 ? 1_000_000 : 5000) : 0,
        userAgent: i % 4 < 2 ? MOBILE_UA : DESKTOP_UA,
      });
    }
    // A second checkout of a visitor: still one visitor.
    rows.push({ ...rows[20], status: "OPEN" as const, paidAt: null, totalCents: 0 });
    await db.checkoutSession.createMany({ data: rows });
    const r = await experimentResults(exp);
    const [a, b] = r.stats;
    expect([a.visitors, b.visitors]).toEqual([20, 20]);
    expect([a.orders, b.orders]).toEqual([5, 5]);
    expect(a.revenueCents).toBe(1_000_000 + 4 * 5000);
    // The 1 000 € order is capped at the buyers' 99th percentile.
    expect(a.rpv).toBeLessThan(1_020_000 / 20);
    expect(r.capCents).toBeGreaterThan(5000);
    expect(b.rpv).toBeCloseTo(25000 / 20);
    expect(a.mobile!.visitors + a.desktop!.visitors).toBe(20);
    expect(r.decision).toEqual({ kind: "waiting", reason: "too_early" });
    // No cost at all on these orders (no fee, no lines): profit = HT − dispute fees; costs unknown → revenue decides by default.
    expect(r.costsComplete).toBe(false);
    expect(r.metric).toBe("revenue");
    expect(b.ppv).toBeCloseTo(Math.round(5000 / 1.2) * 5 / 20, 0);
    await setExperimentMetric(exp.id, "profit");
    const r2 = await experimentResults(exp);
    expect([r2.metric, r2.metricChosen]).toEqual(["profit", true]);
  });

  it("deducts lost disputes and dispute fees, dates refunds, prorates fixed costs and measures bumps and offers", async () => {
    const down = createBlock("upsell");
    const up = createBlock("upsell");
    (up.props as { declineNextId?: string }).declineNextId = down.id;
    const store = await makeStore({ disputeFeeCents: 1500, fixedCostsMonthlyCents: 3000_00, thankYouLayout: { blocks: [up, down] } });
    const today = resolveRange({ range: "today" });
    const at = (minAgo: number) => new Date(Math.max(today.since.getTime() + 60_000, Date.now() - minAgo * 60_000));
    const full = { whopFeeCents: 0, lines: [line({ unitCostCents: 1000, requiresShipping: false })], shippingAddress: { countryCode: "FR" } };
    // D1: 6000 TTC, dispute lost (6000), fee 15 €. D2: 3000 TTC, dispute won (fee only). D3: 1200 TTC, bump shown + taken, offer up declined then down paid.
    const d1 = await paidOrder(store.id, { ...full, email: "d1@x.test", paidAt: at(9), createdAt: at(9), subtotalCents: 6000, totalCents: 6000, disputed: true, disputeStatus: "lost", disputeLostCents: 6000 });
    await paidOrder(store.id, { ...full, email: "d2@x.test", paidAt: at(8), createdAt: at(8), subtotalCents: 3000, totalCents: 3000, disputed: true, disputeStatus: "won", addOnsShown: ["ad1"] });
    const d3 = await paidOrder(
      store.id,
      { ...full, email: "d3@x.test", paidAt: at(7), createdAt: at(7), subtotalCents: 1000, addOnsCents: 200, totalCents: 1200, addOnsShown: ["ad1"], upsellShownBlocks: [up.id, down.id], upsellShownAt: at(6) },
      { addOns: [{ id: "ad1", title: "Protection", priceCents: 200, variantId: null, costCents: 50 }] },
    );
    await db.upsellCharge.create({ data: { sessionId: d3.id, blockId: up.id, title: "Grand", variantId: "v", amountCents: 3000, status: "DECLINED" } });
    await db.upsellCharge.create({ data: { sessionId: d3.id, blockId: down.id, title: "Petit", variantId: "v", amountCents: 1200, quantity: 2, status: "PAID", whopFeeCents: 0, costCents: 300 } });
    // An order paid 20 days ago, refunded today (RefundRecord), and an old refund without record.
    const old = await paidOrder(store.id, { ...full, email: "o@x.test", paidAt: new Date(Date.now() - 20 * 86_400_000), createdAt: new Date(Date.now() - 20 * 86_400_000), subtotalCents: 2400, totalCents: 2400, refundedCents: 2400 });
    await db.refundRecord.create({ data: { id: `rf_${old.id}`, storeId: store.id, sessionId: old.id, amountCents: 2400, currency: "EUR", createdAt: at(1) } });
    await db.checkoutSession.update({ where: { id: d3.id }, data: { refundedCents: 120 } });

    const a = await storeAnalytics(store.id, { since: today.since, until: today.until, prevSince: today.prevSince, includeTest: false });
    // Revenue: 6000 − 6000 (lost) + 3000 + (1200 − 120) + 1200 = 5280 TTC.
    expect(a.revenueCents).toBe(5280);
    expect(a.money.disputeLostCents).toBe(6000);
    expect(a.money.disputeLostHtCents).toBe(5000);
    expect([a.money.disputes, a.money.disputeFeesCents]).toEqual([2, 3000]);
    expect(a.risk.disputes).toBe(2);
    // Margin: HT 0 + 2500 + 900 + 1000 − costs (1000 × 3 lines + bump 50 + offer 300 × 2) − 2 × 15 € of dispute fees.
    const ht = 0 + 2500 + Math.round(1080 / 1.2) + 1000;
    expect(a.revenueHtCents).toBe(ht);
    expect(a.profit.grossProfitCents).toBe(ht - 3000 - 50 - 600 - 3000);
    expect(a.daily.find((d) => d.day === today.to)).toMatchObject({ disputesCents: 5000 + 3000, feesCents: 0, costsCents: 3650 });

    // Refunds on the refund date: today's record (2400) + the 120 without record (order date).
    expect(a.money.refundedCents).toBe(120);
    expect(a.refundsByDate).toMatchObject({ cents: 2400 + 120, htCents: 2000 + 100, count: 2, fallbackCents: 120, fallbackOrders: 1 });

    // Fixed costs: one day of 3000 € / month.
    expect(a.fixedCosts.periodCents).toBe(fixedCostsFor(3000_00, today.from, today.to));
    expect(a.fixedCosts.netAfterFixedCents).toBe(a.profit.grossProfitCents - a.ads.spendCents - a.fixedCosts.periodCents);

    // Bump: shown on 2 orders (D1 recorded nothing: legacy → shown too, estimated), taken once.
    expect(a.addOns).toEqual([
      expect.objectContaining({ id: "ad1", title: "Protection", orders: 1, shown: 3, estimated: true, revenueHtCents: Math.round(200 / 1.2), costCents: 50, marginCents: Math.round(200 / 1.2) - 50 }),
    ]);
    expect(a.addOns[0].attachRate).toBeCloseTo(1 / 3);
    // Offers: the downsell is flagged, margin = HT − cost × quantity, revenue per impression.
    const dn = a.offers.find((o) => o.blockId === down.id)!;
    expect(dn).toMatchObject({ downsell: true, paid: 1, revenueHtCents: 1000, marginCents: 1000 - 600, impressions: 1, revenuePerImpressionHtCents: 1000, takeRateRange: null });
    expect(a.offers.find((o) => o.blockId === up.id)).toMatchObject({ downsell: false, declined: 1, paid: 0 });
    // Heatmap and funnel split.
    expect(a.heatmap.reduce((s, c) => s + c.sessions, 0)).toBe(a.sessions);
    expect(a.heatmap.reduce((s, c) => s + c.revenueHtCents, 0)).toBe(a.revenueHtCents);
    expect(a.funnelBy.source.map((g) => g.group)).toEqual(["direct / inconnu"]);

    // Codes: margin and AOV per code.
    await db.checkoutSession.update({ where: { id: d1.id }, data: { discountCode: "ETE" } });
    const withCode = await storeAnalytics(store.id, { since: today.since, until: today.until, includeTest: false });
    expect(withCode.codes).toEqual([expect.objectContaining({ code: "ETE", orders: 1, revenueCents: 0, aovCents: 0, profitCents: 0 - 1000 - 1500 })]);

    // LTV / CAC: spend attributed to the source over the window ÷ new customers.
    await db.checkoutSession.updateMany({ where: { storeId: store.id }, data: { utm: { utm_source: "facebook", utm_campaign: "Automne" } } });
    await db.adSpend.create({ data: { storeId: store.id, day: today.to, platform: "meta", campaignId: "c1", campaignName: "automne", spendCents: 8000, currency: "EUR" } });
    const c = await storeCohorts(store.id, false);
    const fb = c.bySource.find((r) => r.source === "facebook")!;
    expect(fb).toMatchObject({ customers: 4, spendCents: 8000, cacCents: 2000 });
  });

  it("converts foreign-currency ad spend with ECB rates, or keeps it flagged without a rate", async () => {
    const store = await makeStore({ metaAdAccountId: "777", metaAccessToken: encrypt("usd-tok") });
    const d = parisDay(new Date());
    await db.appSetting.deleteMany({ where: { key: "fx:ecb" } });
    let ecbUp = true;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "www.ecb.europa.eu") {
        if (!ecbUp) return new Response("down", { status: 503 });
        return new Response(`<Cube><Cube time='2026-09-25'><Cube currency='USD' rate='1.25'/></Cube></Cube>`, { status: 200 });
      }
      if (url.pathname.includes("act_777")) return new Response(JSON.stringify({ data: [{ campaign_id: "u1", campaign_name: "US", spend: "12.50", account_currency: "USD", date_start: d }] }));
      return new Response(JSON.stringify({ data: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    ecbUp = false;
    await importAdSpend(Date.now() + 60_000, { storeId: store.id, force: true });
    let row = await db.adSpend.findFirstOrThrow({ where: { storeId: store.id } });
    expect([row.spendCents, row.currency, row.originalCurrency, row.fxRate]).toEqual([1250, "USD", "USD", null]);
    const a = await storeAnalytics(store.id, { ...resolveRange({ range: "today" }), includeTest: false });
    expect(a.ads.unconverted).toEqual({ rows: 1, currencies: ["USD"] });
    ecbUp = true;
    await importAdSpend(Date.now() + 60_000, { storeId: store.id, force: true });
    row = await db.adSpend.findFirstOrThrow({ where: { storeId: store.id } });
    expect([row.spendCents, row.currency, row.originalSpendCents, row.originalCurrency]).toEqual([1000, "EUR", 1250, "USD"]);
    expect(row.fxRate).toBeCloseTo(0.8);
    // Cached for 12 h: no second ECB call.
    fetchMock.mockClear();
    await importAdSpend(Date.now() + 60_000, { storeId: store.id, force: true });
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("ecb.europa.eu"))).toBe(false);
  });

  it("imports Meta and TikTok spend, paginates, and isolates a failing store", async () => {
    const ok = await makeStore({ metaAdAccountId: "123", metaAccessToken: encrypt("meta-tok"), tiktokAdvertiserId: "456", tiktokAccessToken: encrypt("tt-tok") });
    const bad = await makeStore({ metaAdAccountId: "999", metaAccessToken: encrypt("bad") });
    const d = parisDay(new Date());
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(init?.signal).toBeDefined();
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (url.hostname === "graph.facebook.com") {
        if (url.pathname.includes("act_999")) return json({ error: { message: "Invalid OAuth access token" } }, 400);
        if (!url.pathname.includes("act_123")) return json({ data: [] });
        expect(url.searchParams.get("access_token")).toBe("meta-tok");
        expect(JSON.parse(url.searchParams.get("time_range")!)).toMatchObject({ until: d });
        // Ad set and ad levels (creative table), stored with prefixed ids next to the campaigns.
        if (url.searchParams.get("level") === "adset") return json({ data: [{ adset_id: "s1", adset_name: "Broad", campaign_id: "m1", spend: "10.00", account_currency: "EUR", date_start: d }] });
        if (url.searchParams.get("level") === "ad") return json({ data: [{ ad_id: "a1", ad_name: "Hook", adset_id: "s1", spend: "6.00", account_currency: "EUR", date_start: d }] });
        expect(url.searchParams.get("level")).toBe("campaign");
        if (url.searchParams.get("after") === "p2") return json({ data: [{ campaign_id: "m2", campaign_name: "Hiver", spend: "4.00", account_currency: "EUR", date_start: d }] });
        const next = new URL(url);
        next.searchParams.set("after", "p2");
        return json({ data: [{ campaign_id: "m1", campaign_name: "Automne", spend: "12.34", account_currency: "EUR", date_start: d }], paging: { next: next.toString() } });
      }
      if (url.hostname === "business-api.tiktok.com") {
        expect((init?.headers as Record<string, string>)["Access-Token"]).toBe("tt-tok");
        const level = url.searchParams.get("data_level");
        if (level === "AUCTION_ADGROUP") return json({ code: 0, data: { list: [{ dimensions: { adgroup_id: "g1", stat_time_day: `${d} 00:00:00` }, metrics: { spend: "7.5", adgroup_name: "FR" } }] } });
        // The ad level fails: the campaign and ad group rows stay imported.
        if (level === "AUCTION_AD") return json({ code: 40100, message: "Rate limited" });
        expect(level).toBe("AUCTION_CAMPAIGN");
        return json({ code: 0, message: "OK", data: { list: [{ dimensions: { campaign_id: "t1", stat_time_day: `${d} 00:00:00` }, metrics: { spend: "7.5", campaign_name: "ugc" } }], page_info: { total_page: 1 } } });
      }
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    // Other stores of the test DB may be configured too: only ours are asserted.
    await importAdSpend(Date.now() + 60_000);
    const rows = await db.adSpend.findMany({ where: { storeId: ok.id }, orderBy: [{ platform: "asc" }, { campaignId: "asc" }] });
    expect(rows.map((r) => [r.platform, r.campaignId, r.campaignName, r.spendCents, r.day])).toEqual([
      ["meta", "ad:a1", "Hook", 600, d],
      ["meta", "adset:s1", "Broad", 1000, d],
      ["meta", "m1", "Automne", 1234, d],
      ["meta", "m2", "Hiver", 400, d],
      ["tiktok", "adset:g1", "FR", 750, d],
      ["tiktok", "t1", "ugc", 750, d],
    ]);
    // Totals use campaign rows only.
    const spent = await storeAnalytics(ok.id, { ...resolveRange({ range: "today" }), includeTest: false });
    expect(spent.ads.spendCents).toBe(1234 + 400 + 750);
    expect(spent.creatives.map((c) => [c.level, c.name, c.spendCents])).toEqual([
      ["adset", "Broad", 1000],
      ["adset", "FR", 750],
      ["ad", "Hook", 600],
    ]);
    const failure = await db.eventLog.findFirst({ where: { storeId: bad.id, kind: "adspend.import_failed" } });
    expect(failure?.message).toContain("Invalid OAuth access token");
    expect(notify.sendAlert).toHaveBeenCalled();
    const status = JSON.parse((await db.appSetting.findUniqueOrThrow({ where: { key: `adspend:${ok.id}` } })).value);
    expect(status.platforms).toMatchObject({ meta: { ok: true, rows: 2, details: 2 }, tiktok: { ok: true, rows: 1, details: 1, detailError: expect.stringContaining("Rate limited") } });

    // Hourly throttle, unless forced; re-import updates in place (no duplicates).
    fetchMock.mockClear();
    await importAdSpend(Date.now() + 60_000, { storeId: ok.id });
    expect(fetchMock).not.toHaveBeenCalled();
    await importAdSpend(Date.now() + 60_000, { storeId: ok.id, force: true });
    expect(await db.adSpend.count({ where: { storeId: ok.id } })).toBe(6);
  });
  it("attributes previous-period spend to the filtered source, and prices ad sets, POAS and blended CAC", async () => {
    const store = await makeStore();
    const today = resolveRange({ range: "today" });
    const at = (minAgo: number) => new Date(Math.max(today.since.getTime() + 60_000, Date.now() - minAgo * 60_000));
    const prevAt = new Date(today.since.getTime() - 3600_000);
    const fb = { utm_source: "facebook", utm_campaign: "Automne", utm_content: "Hook A", utm_term: "broad" };
    const full = { whopFeeCents: 0, lines: [line({ unitCostCents: 1000, requiresShipping: false })], shippingAddress: { countryCode: "FR" } };
    // Yesterday: one facebook order (6000 TTC → 5000 HT), one tiktok order.
    await paidOrder(store.id, { ...full, email: "p1@x.test", paidAt: prevAt, createdAt: prevAt, subtotalCents: 6000, totalCents: 6000, utm: fb });
    await paidOrder(store.id, { ...full, email: "p2@x.test", paidAt: prevAt, createdAt: prevAt, subtotalCents: 1200, totalCents: 1200, utm: { utm_source: "tiktok", utm_campaign: "ugc" } });
    // Today: two facebook orders (2 × 5000 HT, margin 4000 each) from new customers.
    await paidOrder(store.id, { ...full, email: "n1@x.test", paidAt: at(5), createdAt: at(6), subtotalCents: 6000, totalCents: 6000, utm: fb });
    await paidOrder(store.id, { ...full, email: "n2@x.test", paidAt: at(4), createdAt: at(5), subtotalCents: 6000, totalCents: 6000, utm: { ...fb, utm_content: "999" } });
    await db.adSpend.createMany({
      data: [
        { storeId: store.id, day: today.prevTo, platform: "meta", campaignId: "c1", campaignName: "automne", spendCents: 2000, currency: "EUR" },
        { storeId: store.id, day: today.prevTo, platform: "tiktok", campaignId: "t1", campaignName: "ugc", spendCents: 700, currency: "EUR" },
        { storeId: store.id, day: today.to, platform: "meta", campaignId: "c1", campaignName: "automne", spendCents: 5000, currency: "EUR" },
        { storeId: store.id, day: today.to, platform: "tiktok", campaignId: "t1", campaignName: "ugc", spendCents: 1000, currency: "EUR" },
        // Detail rows: never in any total.
        { storeId: store.id, day: today.to, platform: "meta", campaignId: "adset:s1", campaignName: "Broad", spendCents: 5000, currency: "EUR" },
        { storeId: store.id, day: today.to, platform: "meta", campaignId: "ad:111", campaignName: "hook a", spendCents: 3000, currency: "EUR" },
        { storeId: store.id, day: today.to, platform: "meta", campaignId: "ad:999", campaignName: "Static", spendCents: 2000, currency: "EUR" },
      ],
    });
    const period = { since: today.since, until: today.until, prevSince: today.prevSince, includeTest: false };

    const all = await storeAnalytics(store.id, period);
    expect([all.ads.spendCents, all.previous.spendCents]).toEqual([6000, 2700]);
    expect(all.daily.find((d) => d.day === today.to)?.spendCents).toBe(6000);
    // Blended CAC: all spend ÷ new customers of the period.
    expect([all.ads.newCustomers, all.ads.blendedCacCents]).toEqual([2, 3000]);
    // Break-even ROAS and POAS per source: margin 8000 on 10000 HT → break-even 1.25; POAS 8000 / 5000.
    const row = all.sources.find((r) => r.source === "facebook")!;
    // 2 orders and 5000 spent < 2 × 4000 (margin per order): too early to judge, even at POAS 1.6.
    expect(row).toMatchObject({ spendCents: 5000, breakEvenRoas: 1.25, poas: 1.6, verdict: "early" });
    expect(all.ads.breakEvenCpaCents).toBe(4000);
    // Ad sets and ads: utm_term → ad set, utm_content (name or id) → ad.
    expect(all.creatives.map((c) => [c.level, c.name, c.spendCents, c.orders, c.revenueHtCents])).toEqual([
      ["adset", "Broad", 5000, 2, 10000],
      ["ad", "hook a", 3000, 1, 5000],
      ["ad", "Static", 2000, 1, 5000],
    ]);
    expect(all.creatives[1]).toMatchObject({ profitCents: 4000, profitAfterAdsCents: 1000, cpaCents: 3000 });

    // Source filter: previous spend attributed like the current one (no more 0 → wrong deltas).
    const f = await storeAnalytics(store.id, { ...period, filters: { source: "facebook" } });
    expect([f.ads.spendCents, f.previous.spendCents]).toEqual([5000, 2000]);
    expect(f.previous.roas).toBeCloseTo(5000 / 2000);
    expect(f.previous.netAfterAdsCents).toBe(4000 - 2000);
    expect(f.daily.find((d) => d.day === today.to)?.spendCents).toBe(5000);
    expect(f.ads.platforms).toEqual([{ platform: "meta", spendCents: 5000 }]);
    // Only the platform that can be behind the source.
    expect(f.creatives.every((c) => c.platform === "meta")).toBe(true);
    const t = await storeAnalytics(store.id, { ...period, filters: { source: "tiktok" } });
    // No tiktok checkout today: today's tiktok spend stays unattributed; yesterday's matches yesterday's order.
    expect([t.ads.spendCents, t.previous.spendCents, t.creatives.length]).toEqual([0, 700, 0]);
    expect(all.ads.unattributed).toEqual([{ platform: "tiktok", campaign: "ugc", spendCents: 1000 }]);
    // Cross-store summary: campaign rows only, fixed costs prorated.
    const sum = await storeSummary(store.id, today, false);
    expect(sum.spendCents).toBe(6000);

    // Country / device filter: spend can't be split, no creative table.
    const fr = await storeAnalytics(store.id, { ...period, filters: { country: "FR" } });
    expect([fr.ads.available, fr.creatives.length, fr.ads.blendedCacCents]).toEqual([false, 0, null]);
  });

  it("zeroes the costs of a refunded order never shipped, reports offer margins as marge produit and applies French VAT under the OSS threshold", async () => {
    const store = await makeStore({ fulfillmentFeeCents: 200, vatDomesticOnly: true });
    const today = resolveRange({ range: "today" });
    const at = (minAgo: number) => new Date(Math.max(today.since.getTime() + 60_000, Date.now() - minAgo * 60_000));
    const rate = await db.shippingRate.create({ data: { storeId: store.id, name: "Colissimo", countries: [], priceCents: 0, costCents: 500 } });
    const base = { whopFeeCents: 100, lines: [line({ unitCostCents: 2000 })], shippingRateId: rate.id, subtotalCents: 6000, totalCents: 6000 };
    // R1: fully refunded, no tracking → no product, carrier or preparation cost (Whop fee stays).
    await paidOrder(store.id, { ...base, email: "r1@x.test", paidAt: at(9), createdAt: at(9), refundedCents: 6000, shippingAddress: { countryCode: "DE" } }, { shippingCostCents: 500 });
    // R2: fully refunded but shipped (tracking number) → costs stay.
    await paidOrder(store.id, { ...base, email: "r2@x.test", paidAt: at(8), createdAt: at(8), refundedCents: 6000, trackingNumber: "6A123", shippingAddress: { countryCode: "DE" } }, { shippingCostCents: 500 });
    // K: kept, shipped to Germany: French VAT (20 %) under the OSS threshold; an offer with its own Whop fee.
    const k = await paidOrder(store.id, { ...base, email: "k@x.test", paidAt: at(7), createdAt: at(7), shippingAddress: { countryCode: "DE" }, upsellShownBlocks: ["o1"], upsellShownAt: at(6) }, { shippingCostCents: 500 });
    await db.upsellCharge.create({ data: { sessionId: k.id, blockId: "o1", title: "Bonnet", variantId: "v", amountCents: 1200, status: "PAID", whopFeeCents: 80, costCents: 300 } });

    const a = await storeAnalytics(store.id, { since: today.since, until: today.until, includeTest: false });
    // HT: only K and its offer remain: (6000 + 1200) / 1.2 (not / 1.19).
    expect(a.revenueHtCents).toBe(6000);
    expect(a.profit.cogsCents).toBe(2000 + 2000 + 300);
    expect(a.profit.shippingCostCents).toBe(500 + 500);
    expect(a.profit.fulfilmentCents).toBe(200 + 200);
    expect(a.feesCents).toBe(100 * 3 + 80);
    expect(a.profit.complete).toBe(true);
    // Marge produit (CA HT − cost), like products and options: the offer's fee is in the net margin only.
    expect(a.offers.find((o) => o.blockId === "o1")).toMatchObject({ revenueHtCents: 1000, marginCents: 1000 - 300 });
    const product = a.products.find((p) => p.productId === "gid://shopify/Product/7")!;
    expect(product.marginCents).toBe(product.revenueHtCents - 2000 * 2);
    expect(a.countries).toEqual([expect.objectContaining({ country: "DE", revenueHtCents: 6000, vatCents: 1200 })]);
  });

  it("raises anomaly alerts once a day and sends one daily report per store after 7:00 Paris", async () => {
    const store = await makeStore({ enabled: true, name: "Alertes IT" });
    const today = parisDay(new Date());
    const rows = [];
    // 20 orders over the last 7 days, 3 refunded (15 %), none before: refund anomaly.
    for (let i = 0; i < 20; i++) {
      const day = addDays(today, -1 - (i % 7));
      const t = new Date(parisDayStart(day).getTime() + 10 * 3600_000);
      rows.push({ storeId: store.id, currency: "EUR", lines: [], status: "PAID" as const, paidAt: t, createdAt: t, email: `c${i}@x.test`, subtotalCents: 3000, totalCents: 3000, refundedCents: i < 3 ? 3000 : 0 });
    }
    await db.checkoutSession.createMany({ data: rows });
    const deadline = Date.now() + 60_000;
    expect(await notifyAnomalies(deadline, new Date(), { storeId: store.id })).toBe(1);
    const events = await db.eventLog.findMany({ where: { storeId: store.id, kind: "analytics.anomaly" } });
    expect(events).toHaveLength(1);
    expect(events[0].message).toMatch(/Remboursements en hausse/);
    expect(notify.sendAlert).toHaveBeenCalled();
    // Same day: nothing new.
    expect(await notifyAnomalies(deadline, new Date(), { storeId: store.id })).toBe(0);
    expect(await db.appSetting.findUnique({ where: { key: `anomaly-scan:${store.id}` } })).toMatchObject({ value: today });

    // Before 7:00 Paris: no report; after: one, then none the same day.
    const morning = (h: number) => new Date(parisDayStart(today).getTime() + h * 3600_000 + 60_000);
    expect(await sendDailyReport(deadline, morning(6), { storeId: store.id })).toBe(0);
    expect(await sendDailyReport(deadline, morning(8), { storeId: store.id })).toBe(1);
    expect(await sendDailyReport(deadline, morning(9), { storeId: store.id })).toBe(0);
    const report = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "report.daily" } });
    const yesterdayOrders = rows.filter((r) => parisDay(r.paidAt) === addDays(today, -1));
    expect(report.message).toContain(`${yesterdayOrders.length} commande`);
    expect(report.message).toMatch(/Anomalies : Remboursements en hausse/);
    expect(report.data).toMatchObject({ day: addDays(today, -1), orders: yesterdayOrders.length });
  });
  it("keeps the product cost of a refunded, never-shipped order when the supplier is paid at payment", async () => {
    const today = resolveRange({ range: "today" });
    const at = new Date(Math.max(today.since.getTime() + 60_000, Date.now() - 5 * 60_000));
    const order = { whopFeeCents: 100, lines: [line({ unitCostCents: 2000 })], subtotalCents: 6000, totalCents: 6000, refundedCents: 6000, paidAt: at, createdAt: at, shippingAddress: { countryCode: "FR" } };
    const kept = await makeStore({ supplierPaidAtPayment: true, fulfillmentFeeCents: 200 });
    const back = await makeStore({ fulfillmentFeeCents: 200 });
    await paidOrder(kept.id, { ...order, email: "s@x.test" });
    await paidOrder(back.id, { ...order, email: "s@x.test" });
    const period = { since: today.since, until: today.until, includeTest: false };
    const [a, b] = await Promise.all([storeAnalytics(kept.id, period), storeAnalytics(back.id, period)]);
    // Supplier paid: the goods are lost (2000), but no carrier or preparation for a parcel never sent.
    expect([a.profit.cogsCents, a.profit.fulfilmentCents, a.profit.grossProfitCents, a.profit.complete]).toEqual([2000, 0, -100 - 2000, true]);
    expect(a.products[0].marginCents).toBe(-2000);
    expect([b.profit.cogsCents, b.profit.grossProfitCents]).toEqual([0, -100]);
  });

  it("splits conversion by checkout language and shipping country, filters by language, and reads the survey", async () => {
    const store = await makeStore();
    const today = resolveRange({ range: "today" });
    const at = (minAgo: number) => new Date(Math.max(today.since.getTime() + 60_000, Date.now() - minAgo * 60_000));
    const full = { whopFeeCents: 0, lines: [line({ unitCostCents: 1000, requiresShipping: false })], subtotalCents: 6000, totalCents: 6000 };
    await paidOrder(store.id, { ...full, email: "a@x.test", lang: "fr", createdAt: at(9), paidAt: at(8), shippingAddress: { countryCode: "FR" }, surveyAnswer: "instagram" });
    await paidOrder(store.id, { ...full, email: "b@x.test", lang: "fr-FR", createdAt: at(9), paidAt: at(8), shippingAddress: { countryCode: "FR" }, surveyAnswer: "instagram", utm: { utm_source: "instagram" } });
    await paidOrder(store.id, { ...full, email: "c@x.test", lang: "en", createdAt: at(9), paidAt: at(8), shippingAddress: { countryCode: "GB" }, surveyAnswer: "friend" });
    await paidOrder(store.id, { ...full, email: "d@x.test", createdAt: at(9), paidAt: at(8), shippingAddress: { countryCode: "FR" } });
    await db.checkoutSession.createMany({
      data: [
        { storeId: store.id, currency: "EUR", lines: [], lang: "fr", createdAt: at(7) },
        { storeId: store.id, currency: "EUR", lines: [], lang: "en", createdAt: at(7), shippingAddress: { countryCode: "GB" } },
        { storeId: store.id, currency: "EUR", lines: [], lang: "en", createdAt: at(7) },
      ],
    });
    const period = { since: today.since, until: today.until, includeTest: false };
    const a = await storeAnalytics(store.id, period);
    const paid = (g: { funnel: { key: string; count: number }[] }) => g.funnel.find((f) => f.key === "paid")!.count;
    expect(Object.fromEntries(a.funnelBy.lang.map((g) => [g.group, [g.sessions, paid(g)]]))).toEqual({ fr: [3, 2], en: [3, 1], inconnu: [1, 1] });
    // The visitor-country funnel only uses the IP country (round 10): the shipping address, typed by
    // buyers only, would make every typed country look like it converts. No IP country here → "inconnu",
    // and a coverage of 0 % (the page hides the rates below 80 %).
    expect(Object.fromEntries(a.funnelBy.country.map((g) => [g.group, [g.sessions, paid(g)]]))).toEqual({ inconnu: [7, 4] });
    expect(a.geoCoverage).toEqual({ sessions: 7, located: 0, share: 0 });
    // Language filter: every metric follows it, ad spend can't be split by language.
    const en = await storeAnalytics(store.id, { ...period, filters: { lang: "en" } });
    expect([en.sessions, en.orders, en.ads.available, en.fixedCosts.available]).toEqual([3, 1, false, false]);
    expect((await filterOptions(store.id, false)).langs.sort()).toEqual(["en", "fr"]);
    // Survey: answers × UTM source, coverage.
    expect([a.survey.orders, a.survey.answered]).toEqual([4, 3]);
    expect(a.survey.answers[0]).toMatchObject({ answer: "instagram", orders: 2, revenueHtCents: 10000 });
    expect(a.survey.answers[0].utm).toEqual([
      { source: "direct / inconnu", orders: 1 },
      { source: "instagram", orders: 1 },
    ]);
    expect(a.survey.answers[1]).toMatchObject({ answer: "friend", orders: 1 });
  });

  it("switches the sources table between last and first paid touch", async () => {
    const store = await makeStore();
    const today = resolveRange({ range: "today" });
    const at = new Date(Math.max(today.since.getTime() + 60_000, Date.now() - 5 * 60_000));
    const full = { whopFeeCents: 0, lines: [line({ unitCostCents: 1000, requiresShipping: false })], subtotalCents: 6000, totalCents: 6000, paidAt: at, createdAt: at };
    await paidOrder(store.id, { ...full, email: "a@x.test", utm: { utm_source: "tiktok", utm_campaign: "retarget" }, firstUtm: { utm_source: "facebook", utm_campaign: "prospect" } });
    await paidOrder(store.id, { ...full, email: "b@x.test", utm: { utm_source: "google", utm_campaign: "marque" } });
    await db.adSpend.create({ data: { storeId: store.id, day: today.to, platform: "meta", campaignId: "p1", campaignName: "prospect", spendCents: 3000, currency: "EUR" } });
    const period = { since: today.since, until: today.until, includeTest: false };
    const last = await storeAnalytics(store.id, period);
    const first = await storeAnalytics(store.id, period, { touch: "first" });
    expect(last.attribution).toEqual({ touch: "last", days: 7, storeDays: 7 });
    expect(first.attribution.touch).toBe("first");
    expect(last.sources.map((r) => `${r.source}/${r.campaign}/${r.orders}`).sort()).toEqual(["google/marque/1", "tiktok/retarget/1"]);
    expect(first.sources.map((r) => `${r.source}/${r.campaign}/${r.orders}`).sort()).toEqual(["facebook/prospect/1", "google/marque/1"]);
    // Spend follows the attribution model: "prospect" matches only the first touch.
    expect(last.ads.unattributed.map((u) => u.campaign)).toEqual(["prospect"]);
    expect(first.sources.find((r) => r.source === "facebook")?.spendCents).toBe(3000);
  });

  it("counts an order that answered an offer as having seen one (offers headline = table basis)", async () => {
    const store = await makeStore();
    const today = resolveRange({ range: "today" });
    const at = new Date(Math.max(today.since.getTime() + 60_000, Date.now() - 5 * 60_000));
    // Offer declined, but the display was never recorded.
    const o = await paidOrder(store.id, { email: "a@x.test", paidAt: at, createdAt: at, subtotalCents: 3000, totalCents: 3000 });
    await db.upsellCharge.create({ data: { sessionId: o.id, blockId: "x1", title: "Bonnet", variantId: "v", amountCents: 900, status: "DECLINED" } });
    const a = await storeAnalytics(store.id, { since: today.since, until: today.until, includeTest: false });
    expect(a.upsell.shown).toBe(1);
    expect(a.offers[0]).toMatchObject({ blockId: "x1", impressions: 1, declined: 1 });
  });

  it("lists A/B offer arms under their offer and labels shipping protection", async () => {
    const store = await makeStore();
    await db.store.update({ where: { id: store.id }, data: { thankYouLayout: { blocks: [{ id: "up1", type: "upsell", props: { title: "Bougie mini" } }] } } });
    const today = resolveRange({ range: "today" });
    const at = new Date(Math.max(today.since.getTime() + 60_000, Date.now() - 5 * 60_000));
    const base = { paidAt: at, createdAt: at, subtotalCents: 3000, totalCents: 3290 };
    const protection = { addOns: [{ id: "shipping_protection", title: "Protection colis", priceCents: 290, variantId: null, costCents: null }] };
    const a1 = await paidOrder(store.id, { ...base, email: "a@x.test", upsellShownBlocks: ["up1"] }, protection);
    const b1 = await paidOrder(store.id, { ...base, email: "b@x.test", upsellShownBlocks: ["up1:B"] });
    await paidOrder(store.id, { ...base, email: "c@x.test", upsellShownBlocks: ["up1:B"] });
    await db.upsellCharge.create({ data: { sessionId: a1.id, blockId: "up1", title: "Bougie", variantId: "v", amountCents: 900, status: "DECLINED" } });
    await db.upsellCharge.create({ data: { sessionId: b1.id, blockId: "up1:B", title: "Bougie B", variantId: "v", amountCents: 900, status: "PAID" } });
    const a = await storeAnalytics(store.id, { since: today.since, until: today.until, includeTest: false });
    expect(a.upsell.shown).toBe(3);
    expect(a.offers.map((o) => [o.blockId, o.offerId, o.arm, o.title, o.impressions, o.paid])).toEqual([
      ["up1", "up1", "A", "Bougie mini · variante A", 1, 0],
      ["up1:B", "up1", "B", "Bougie mini · variante B", 2, 1],
    ]);
    const p = a.addOns.find((x) => x.id === "shipping_protection");
    expect(p).toMatchObject({ title: "Protection colis", protection: true, orders: 1, estimated: true });
    expect(p!.marginCents).not.toBeNull();
    // No purchase cost to enter for the protection: the P&L doesn't flag options as missing a cost.
    expect(a.profit.missing).not.toContain("bumps");
  });

  it("raises stop-loss, no-sales, failed-payment and dispute-rate alerts once", async () => {
    const store = await makeStore({ enabled: true });
    const now = new Date();
    const today = parisDay(now);
    const h = 3600_000;
    // 30-day baseline: 100 checkouts, 20 paid (3000 TTC, 2500 HT, margin 2500 per order), 2 of them disputed.
    const base = Array.from({ length: 100 }, (_, i) => {
      const t = new Date(now.getTime() - (5 + (i % 20)) * 24 * h);
      return {
        storeId: store.id,
        currency: "EUR",
        lines: [],
        createdAt: t,
        ...(i < 20 ? { status: "PAID" as const, paidAt: t, subtotalCents: 3000, totalCents: 3000, whopFeeCents: 0, disputed: i < 2, disputeOpenedAt: i < 2 ? t : null } : {}),
      };
    });
    await db.checkoutSession.createMany({ data: base });
    // Last payment 5 h ago, then 20 checkouts without any payment (≈ 4 expected at 20 %).
    await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [], status: "PAID", paidAt: new Date(now.getTime() - 5 * h), createdAt: new Date(now.getTime() - 5 * h - 60_000), totalCents: 3000, subtotalCents: 3000 } });
    await db.checkoutSession.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({
        storeId: store.id,
        currency: "EUR",
        lines: [],
        createdAt: new Date(now.getTime() - 4 * h + i * 60_000),
        // 6 declined payments in the last 2 hours.
        ...(i < 6 ? { status: "FAILED" as const, paymentFailedAt: new Date(now.getTime() - 30 * 60_000 - i * 60_000) } : {}),
      })),
    });
    // Today: 5000 on a campaign without any order (> 1.5 × 2500), 2000 on another (below the threshold).
    await db.adSpend.createMany({
      data: [
        { storeId: store.id, day: today, platform: "meta", campaignId: "h1", campaignName: "Hiver", spendCents: 5000, currency: "EUR" },
        { storeId: store.id, day: today, platform: "meta", campaignId: "p1", campaignName: "Petit", spendCents: 2000, currency: "EUR" },
      ],
    });
    const deadline = Date.now() + 60_000;
    expect(await notifyStopLoss(deadline, now, { storeId: store.id })).toBe(4);
    const events = await db.eventLog.findMany({ where: { storeId: store.id, kind: { startsWith: "analytics." } }, orderBy: { createdAt: "asc" } });
    const byKind = Object.fromEntries(events.map((e) => [e.kind, e]));
    expect(Object.keys(byKind).sort()).toEqual(["analytics.dispute_rate", "analytics.failed_spike", "analytics.no_sales", "analytics.stoploss"]);
    expect(byKind["analytics.stoploss"].message).toMatch(/Campagne Hiver : 50\s€ dépensés aujourd'hui, 0 commande/);
    expect(byKind["analytics.no_sales"].message).toMatch(/0 paiement depuis 5 h malgré 20 checkouts ouverts/);
    expect(byKind["analytics.failed_spike"].message).toMatch(/6 paiements refusés en 2 h/);
    expect(byKind["analytics.dispute_rate"].message).toMatch(/critique/);
    expect(byKind["analytics.dispute_rate"].level).toBe("error");
    expect(notify.sendAlert).toHaveBeenCalled();
    // Same hour: skipped; next scan the same day: every alert is deduplicated.
    expect(await notifyStopLoss(deadline, now, { storeId: store.id })).toBe(0);
    await db.appSetting.delete({ where: { key: `stoploss-scan:${store.id}` } });
    expect(await notifyStopLoss(deadline, now, { storeId: store.id })).toBe(0);
  });
});
