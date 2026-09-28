import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Round 14 (correctness) against a real Postgres: reconciliation / refund / dispute marks of a store
 * without payments (health), the ad-conversion backoff and time budget, merged offers waiting for the
 * checkout's order, ad spend cut by the time budget (no false alert, backfill resumed at once), a
 * webhook replay out of time (no attempt spent), the Google head-of-line guard, dispute evidence due
 * in SQL, the Shopify code count calibration (both outcomes), stuck imports, the outside orders'
 * covered window and channels, the home country, checkout periods switched off by hand, and the
 * profit value without product costs. Shopify, Whop, Google and notifications are mocked. Test data is
 * prefixed c14fix_ and deleted at the end.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
  shopifyGraphql: vi.fn(),
  orderForEdit: vi.fn(),
  addVariantToOrder: vi.fn(),
}));
const whop = vi.hoisted(() => ({ list: vi.fn(), retrieve: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendBuyerEmail: vi.fn() }));

vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({
  ...(await orig<typeof import("@/lib/whop")>()),
  storeClient: () => ({
    payments: {
      list: async (params: Record<string, unknown>) => ({ data: (await whop.list(params)) as unknown[], response: { page_info: { has_next_page: false, end_cursor: null } } }),
      retrieve: (p: { id: string }) => whop.retrieve(p),
    },
    refunds: { list: async () => ({ data: [], response: { page_info: { has_next_page: false, end_cursor: null } } }) },
    disputes: { list: async () => ({ data: [], response: { page_info: { has_next_page: false, end_cursor: null } } }) },
    shipments: { create: vi.fn() },
  }),
}));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 86_400_000;

describe.skipIf(!hasDb)("round 14 correctness (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { DeadlineError } = await import("@/lib/deadline");
  const { logContext, withLogContext } = await import("@/lib/log");
  const { runTick } = await import("@/lib/tick");
  const { backlog, storeHealth } = await import("@/lib/health");
  const { retryConversions, sendPurchaseConversions, sendUpsellConversions } = await import("@/lib/conversions");
  const { markUpsellPaid } = await import("@/lib/upsell");
  const { importAdSpend, backfillAdSpend, adSpendBackfillStatus } = await import("@/lib/adspend");
  const { replayStaleEvents } = await import("@/lib/webhooks");
  const google = await import("@/lib/google-conversions");
  const { evidenceDueWhere } = await import("@/lib/disputes");
  const { clearShopifyDiscountCache, lookupShopifyCode } = await import("@/lib/shopify-discounts");
  const { backfillShopifyCustomers } = await import("@/lib/shopify-history");
  const { storeAnalytics, resolveRange, parisDayStart } = await import("@/lib/analytics");
  const { recordCheckoutEnabled, openFallbackPeriod } = await import("@/lib/fallback");
  const { addDays, zonedDay } = await import("@/lib/time");

  const created: string[] = [];
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const TZ = "Europe/Paris";

  const line = (o: Record<string, unknown> = {}) => ({
    variantId: "gid://shopify/ProductVariant/14",
    productId: "gid://shopify/Product/14",
    productHandle: "sweat",
    title: "Sweat",
    variantTitle: null,
    sku: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 6000,
    compareAtCents: null,
    inventory: null,
    requiresShipping: true,
    ...o,
  });

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `c14fix_${rnd()}`,
        testMode: false,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_c14",
        whopProductId: `prod_c14_${rnd()}`,
        whopApiKey: encrypt("k"),
        shopDomain: `c14fix-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        shopifyScopes: "read_products,write_orders,read_discounts,write_order_edits",
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  /** A paid checkout (6000 TTC to France = 5000 HT unless said otherwise). */
  const paidOrder = (storeId: string, data: Record<string, unknown> = {}) =>
    db.checkoutSession.create({
      data: {
        storeId,
        currency: "EUR",
        status: "PAID",
        lines: [line()],
        subtotalCents: 6000,
        totalCents: 6000,
        paidAt: new Date(),
        email: `b-${rnd()}@c14fix.test`,
        shippingAddress: { firstName: "A", lastName: "B", address1: "1 rue X", city: "Paris", zip: "75001", countryCode: "FR" },
        ...data,
      } as never,
    });

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

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    clearShopifyDiscountCache();
    await db.rateLimit.deleteMany({ where: { key: { startsWith: "incident:" } } });
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/1401", name: "#1401" });
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) => items.map((i) => line({ variantId: i.variantId, quantity: i.quantity })));
    whop.list.mockResolvedValue([]);
    whop.retrieve.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.appSetting.deleteMany({ where: { OR: created.map((id) => ({ key: { contains: id } })) } });
    await db.rateLimit.deleteMany({ where: { OR: created.map((id) => ({ key: { contains: id } })) } });
    await db.webhookEvent.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("P1: a store without any payment keeps fresh reconciliation, refund and dispute marks (health stays up)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const connectedAt = new Date(Date.now() - 4 * HOUR);
    const quiet = await makeStore({ whopConnectedAt: connectedAt });
    // Another quiet store whose mark is 5 h old (no payment since): it moves forward too.
    const old = await makeStore({ whopConnectedAt: connectedAt });
    await db.appSetting.create({ data: { key: `reconcile:${old.id}`, value: new Date(Date.now() - 5 * HOUR).toISOString() } });
    await db.$executeRaw`UPDATE "AppSetting" SET "updatedAt" = now() - interval '5 hours' WHERE key = ${`reconcile:${old.id}`}`;
    const started = Date.now();
    await runTick();
    for (const st of [quiet, old]) {
      const mark = await db.appSetting.findUniqueOrThrow({ where: { key: `reconcile:${st.id}` } });
      expect(Date.parse(mark.value)).toBeGreaterThanOrEqual(started - 15 * MIN - 1000);
      expect(Date.now() - mark.updatedAt.getTime()).toBeLessThan(MIN);
      expect(await db.appSetting.findUnique({ where: { key: `refund-mark:${st.id}` } })).not.toBeNull();
      expect(await db.appSetting.findUnique({ where: { key: `dispute-scan:${st.id}` } })).not.toBeNull();
    }
    // The refund walk's mark moved to the walk's start too (not left at "now − overlap" of its first run forever).
    expect(Date.parse((await db.appSetting.findUniqueOrThrow({ where: { key: `refund-mark:${quiet.id}` } })).value)).toBeGreaterThanOrEqual(started - 15 * MIN - 1000);
    const saved = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "c14";
    try {
      const q = await backlog(quiet.id);
      expect(q.reconcileStale).toEqual([]);
      expect(q.healingStale).toEqual([]);
      expect((await backlog(old.id)).reconcileStale).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = saved;
    }
  });

  it("P1/P2: ad conversions back off on their own clock, stop on the time budget without spending a try (partial)", async () => {
    const store = await makeStore({ metaPixelId: "123", metaAccessToken: encrypt("tok") });
    const s = await paidOrder(store.id, { paidAt: new Date(Date.now() - 20 * MIN) });
    const fetchMock = vi.fn(async () => new Response("boom", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    await sendPurchaseConversions(s.id);
    let row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.pixelAttempts).toBe(1);
    expect(row.pixelNextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 4 * MIN);
    // Not due yet: another writer touching updatedAt doesn't make it due either.
    await db.checkoutSession.update({ where: { id: s.id }, data: { email: "touched@c14fix.test" } });
    await retryConversions(Date.now() + 30_000);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).pixelAttempts).toBe(1);

    // Due, but the run is out of time: DeadlineError, no try spent.
    await db.checkoutSession.update({ where: { id: s.id }, data: { pixelNextAttemptAt: new Date(Date.now() - MIN) } });
    const calls = fetchMock.mock.calls.length;
    await expect(withLogContext({ hardDeadline: Date.now() + 1_000 }, () => retryConversions(Date.now() + 30_000))).rejects.toBeInstanceOf(DeadlineError);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).pixelAttempts).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(calls);
    // The job's own slice used up: reported partial, nothing done.
    const holder: { partial?: boolean } = {};
    expect(await withLogContext({ tickPartial: holder }, () => retryConversions(Date.now() - 1))).toBe(0);
    expect(holder.partial).toBe(true);

    // Due and in time: sent.
    fetchMock.mockImplementation(async () => new Response('{"events_received":1}', { status: 200 }));
    await retryConversions(Date.now() + 30_000);
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.pixelSentAt).not.toBeNull();
    expect(row.pixelNextAttemptAt).toBeNull();

    // One-click offers back off too.
    const charge = await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "u1", title: "Bonnet", variantId: "gid://shopify/ProductVariant/9", amountCents: 1500, status: "PAID" } });
    fetchMock.mockImplementation(async () => new Response("boom", { status: 500 }));
    await sendUpsellConversions(charge.id);
    const c = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(c.pixelAttempts).toBe(1);
    expect(c.pixelNextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 4 * MIN);
  });

  it("profit mode without product costs: no value to Meta, journaled once a day", async () => {
    const store = await makeStore({ metaPixelId: "123", metaAccessToken: encrypt("tok"), conversionValueMode: "profit" });
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response('{"events_received":1}', { status: 200 });
      }),
    );
    const a = await paidOrder(store.id, { lines: [line({ unitCostCents: null })] });
    const b = await paidOrder(store.id, { lines: [line()] });
    await sendPurchaseConversions(a.id);
    await sendPurchaseConversions(b.id);
    const data = bodies.map((x) => (x.data as { custom_data: Record<string, unknown> }[])[0].custom_data);
    expect(data).toHaveLength(2);
    for (const d of data) {
      expect(d).not.toHaveProperty("value");
      expect(d.currency).toBe("EUR");
    }
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "conversion.profit_unknown" } })).toBe(1);
    // Costs known: the margin (5000 HT − 3 % fee estimate − 2000 cost).
    const c = await paidOrder(store.id, { lines: [line({ unitCostCents: 2000 })] });
    await sendPurchaseConversions(c.id);
    expect((bodies.at(-1)!.data as { custom_data: Record<string, unknown> }[])[0].custom_data.value).toBe((5000 - 180 - 2000) / 100);
  });

  it("P2: merged mode waits for the checkout's own order within the window, then journals the separate order", async () => {
    const store = await makeStore({ mergeOffersIntoOrder: true, offerMergeWindowMin: 10 });
    const s = await paidOrder(store.id, { paidAt: new Date() });
    const charge = await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "u1", title: "Bonnet", variantId: "gid://shopify/ProductVariant/9", amountCents: 1500, status: "PENDING", pixelAttempts: 5 } });
    await markUpsellPaid(charge.id, `pay_c14_${charge.id}`, store.id);
    let row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row).toMatchObject({ status: "PAID", shopifyOrderId: null, syncAttempts: 0, syncStartedAt: null, orderMode: null });
    expect(row.nextSyncAt!.getTime()).toBeGreaterThan(Date.now() + MIN);
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    expect(shopify.orderForEdit).not.toHaveBeenCalled();

    // The checkout's order still isn't there once the window is over: its own order, journaled.
    await db.checkoutSession.update({ where: { id: s.id }, data: { paidAt: new Date(Date.now() - 20 * MIN) } });
    await db.upsellCharge.update({ where: { id: charge.id }, data: { nextSyncAt: new Date(Date.now() - MIN) } });
    await markUpsellPaid(charge.id, `pay_c14_${charge.id}`, store.id);
    row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row).toMatchObject({ orderMode: "separate", shopifyOrderId: "gid://shopify/Order/1401" });
    const skipped = await db.eventLog.findMany({ where: { storeId: store.id, kind: "upsell.merge_skipped" } });
    expect(skipped).toHaveLength(1);
    expect(skipped[0].message).toContain("pas encore créée");

    // Merging off: no wait, no journal line.
    const off = await makeStore({ mergeOffersIntoOrder: false });
    const s2 = await paidOrder(off.id);
    const c2 = await db.upsellCharge.create({ data: { sessionId: s2.id, blockId: "u1", title: "Bonnet", variantId: "gid://shopify/ProductVariant/9", amountCents: 1500, status: "PENDING", pixelAttempts: 5 } });
    await markUpsellPaid(c2.id, `pay_c14_${c2.id}`, off.id);
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: c2.id } })).orderMode).toBe("separate");
    expect(await db.eventLog.count({ where: { storeId: off.id, kind: "upsell.merge_skipped" } })).toBe(0);
  });

  it("P2: ad spend cut by the time budget is postponed (no false alert), the backfill chunk resumes on the next run", async () => {
    const store = await makeStore({ metaAdAccountId: "act_14", metaAccessToken: encrypt("m") });
    // Page 1 answers; "time passes" (the run's hard deadline gets close); page 2 can't start.
    const fetchMock = vi.fn(async (url: string) => {
      const ctx = logContext();
      if (typeof ctx.hardDeadline === "number") ctx.hardDeadline = Date.now() + 5_000;
      const day = new URL(url).searchParams.get("time_range") ? JSON.parse(new URL(url).searchParams.get("time_range")!).since : "2026-09-01";
      return new Response(JSON.stringify({ data: [{ date_start: day, campaign_id: "c1", campaign_name: "C1", spend: "10.00", account_currency: "EUR" }], paging: { next: `${url}&after=p2` } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const holder: { partial?: boolean } = {};
    await withLogContext({ hardDeadline: Date.now() + 40_000, tickPartial: holder }, () => importAdSpend(Date.now() + 60_000, { storeId: store.id, force: true }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(holder.partial).toBe(true);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "adspend.import_failed" } })).toBe(0);
    const status = JSON.parse((await db.appSetting.findUniqueOrThrow({ where: { key: `adspend:${store.id}` } })).value);
    expect(Date.parse(status.at)).toBe(0);
    expect(status.platforms.meta).toBeUndefined();

    // History backfill: the same cut is not an error (no 6 h wait)…
    const cut: { partial?: boolean } = {};
    await withLogContext({ hardDeadline: Date.now() + 40_000, tickPartial: cut }, () => backfillAdSpend(Date.now() + 60_000, { storeId: store.id }));
    let st = await adSpendBackfillStatus(store.id);
    expect(st?.platforms.meta?.error).toBeUndefined();
    expect(cut.partial).toBe(true);
    const cursor = st!.platforms.meta!.cursor;
    // …the next run imports the chunk right away.
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await backfillAdSpend(Date.now() + 60_000, { storeId: store.id });
    st = await adSpendBackfillStatus(store.id);
    expect(st!.platforms.meta!.cursor < cursor).toBe(true);
    expect(st!.platforms.meta!.error).toBeUndefined();
  });

  it("P3: a webhook replay out of time spends no attempt, journals nothing and gives its claim back", async () => {
    const store = await makeStore();
    whop.retrieve.mockImplementation(async () => {
      throw new DeadlineError("Whop");
    });
    const id = `wh_c14_${rnd()}`;
    const evt = { type: "refund.created", data: { id: `re_c14_${rnd()}`, status: "succeeded", amount: 1, currency: "eur", payment: { id: `pay_c14_${rnd()}` } } };
    const receivedAt = new Date(Date.now() - 30 * DAY);
    await db.webhookEvent.create({ data: { id, storeId: store.id, type: evt.type, payload: evt, receivedAt, attempts: 1, lastError: "x" } });
    const holder: { partial?: boolean } = {};
    await withLogContext({ hardDeadline: Date.now() + 40_000, tickPartial: holder }, () => replayStaleEvents(Date.now() + 30_000));
    const row = await db.webhookEvent.findFirstOrThrow({ where: { storeId: store.id, id } });
    expect(whop.retrieve).toHaveBeenCalled();
    expect(row).toMatchObject({ attempts: 1, processedAt: null, lastError: "x" });
    expect(row.receivedAt.getTime()).toBe(receivedAt.getTime());
    expect(holder.partial).toBe(true);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: { in: ["webhook.replay_failed", "webhook.gave_up", "refund.early"] } } })).toBe(0);
  });

  it("P3: the same orders stopping the Google upload three runs in a row get a try spent; the queue moves on", async () => {
    const store = await googleStore();
    const orders: Awaited<ReturnType<typeof paidOrder>>[] = [];
    for (let i = 0; i < 4; i++) orders.push(await paidOrder(store.id, { paidAt: new Date(Date.now() - (5 - i) * HOUR), utm: { gclid: `Cj0KCQc14fix${i}ABCDEFG` } }));
    const bad = new Set(orders.slice(0, 3).map((o) => o.id));
    const uploaded: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "ya29" }), { status: 200 });
        const body = JSON.parse(String(init?.body)) as { conversions: { orderId: string }[] };
        const orderId = body.conversions[0].orderId;
        if (bad.has(orderId)) return new Response(JSON.stringify({ error: { code: 500, message: "Internal error encountered.", status: "INTERNAL" } }), { status: 500 });
        uploaded.push(orderId);
        return new Response(JSON.stringify({ results: [{}] }), { status: 200 });
      }),
    );
    const attempts = async () => (await db.checkoutSession.findMany({ where: { id: { in: orders.map((o) => o.id) } }, orderBy: { paidAt: "asc" } })).map((o) => o.googleAdsUploadAttempts);
    for (let run = 1; run <= 2; run++) {
      expect(await google.uploadGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(0);
      expect(await attempts()).toEqual([0, 0, 0, 0]);
    }
    expect(await google.uploadGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(0);
    expect(await attempts()).toEqual([1, 1, 1, 0]);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "google.head_of_line" } })).toBe(1);
    // Fewest tries first: the fresh order is uploaded now.
    expect(await google.uploadGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(1);
    expect(uploaded).toEqual([orders[3].id]);
    // "Relancer": tries back and the streak starts over.
    await db.appSetting.upsert({ where: { key: `google-stop:${store.id}:uploads` }, create: { key: `google-stop:${store.id}:uploads`, value: '{"head":"x","count":2}' }, update: {} });
    await google.retryAbandonedGoogleConversions(store.id);
    expect(await db.appSetting.findUnique({ where: { key: `google-stop:${store.id}:uploads` } })).toBeNull();
  });

  it("P3: dispute evidence due is selected in SQL (a head of disputes waiting for tracking can't hide it)", async () => {
    const store = await makeStore();
    const now = Date.now();
    const waiting: Awaited<ReturnType<typeof paidOrder>>[] = [];
    for (let i = 0; i < 11; i++)
      waiting.push(await paidOrder(store.id, { disputeId: `dp_c14_w${i}_${rnd()}`, disputed: true, disputeOpenedAt: new Date(now - HOUR), disputeDueAt: new Date(now + 4 * DAY + i * MIN) }));
    const backingOff = await paidOrder(store.id, { disputeId: `dp_c14_b_${rnd()}`, disputed: true, disputeOpenedAt: new Date(now - 5 * DAY), disputeDueAt: new Date(now + DAY), disputeEvidenceTries: 1, disputeLastTryAt: new Date(now - 10 * MIN) });
    const due = await paidOrder(store.id, { disputeId: `dp_c14_d_${rnd()}`, disputed: true, disputeOpenedAt: new Date(now - 4 * DAY), disputeDueAt: null });
    const tracked = await paidOrder(store.id, { disputeId: `dp_c14_t_${rnd()}`, disputed: true, disputeOpenedAt: new Date(now - HOUR), disputeDueAt: new Date(now + 9 * DAY), trackingNumber: "TRK14" });
    const { backoffOver, dueAnyway } = evidenceDueWhere(now);
    const picked = await db.checkoutSession.findMany({
      where: { storeId: store.id, disputeId: { not: null }, AND: [backoffOver, { OR: [{ trackingNumber: { not: null } }, dueAnyway] }] },
      orderBy: [{ disputeDueAt: { sort: "asc", nulls: "last" } }, { paidAt: "asc" }],
      take: 10,
    });
    expect(picked.map((p) => p.id).sort()).toEqual([due.id, tracked.id].sort());
    expect(picked.some((p) => p.id === backingOff.id || waiting.some((w) => w.id === p.id))).toBe(false);
  });

  it("P3: Shopify code count calibration — counted (max) or not counted (sum), two confirmations, journaled once", async () => {
    const code = (usage: number) => ({
      codeDiscountNodeByCode: {
        codeDiscount: {
          __typename: "DiscountCodeBasic",
          title: "Code",
          status: "ACTIVE",
          startsAt: "2026-01-01T00:00:00Z",
          endsAt: null,
          usageLimit: 10,
          asyncUsageCount: usage,
          appliesOncePerCustomer: false,
          context: { __typename: "DiscountBuyerSelectionAll" },
          minimumRequirement: null,
          customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 }, items: { __typename: "AllDiscountItems", allItems: true } },
        },
      },
    });
    const use = async (storeId: string, ago: number) => {
      const s = await paidOrder(storeId, { discountCode: "CAL14", shopifyOrderId: `gid://shopify/Order/${rnd()}` });
      return db.shopifyCodeUse.create({ data: { storeId, code: "CAL14", sessionId: s.id, email: s.email, shopifyCountBefore: 5, createdAt: new Date(Date.now() - ago) } });
    };
    // The outside orders import has covered the windows (no order outside this checkout used the code).
    const covered = (storeId: string) =>
      db.appSetting.upsert({
        where: { key: `external-orders:${storeId}` },
        create: { key: `external-orders:${storeId}`, value: JSON.stringify({ since: new Date().toISOString(), after: null, runStartedAt: new Date(Date.now() + MIN).toISOString(), lastRunAt: new Date(Date.now() + MIN).toISOString(), imported: 0 }) },
        update: {},
      });
    // Shopify's count rose by exactly our use, twice (two references), nothing outside: it counts them.
    const counted = await makeStore({ shopifyDiscountCodes: true });
    await covered(counted.id);
    await use(counted.id, 15 * MIN);
    shopify.shopifyGraphql.mockResolvedValue(code(6));
    await lookupShopifyCode(counted, "cal14");
    // One reference is not enough (round 15: two confirmations).
    expect((await db.store.findUniqueOrThrow({ where: { id: counted.id } })).shopifyCountsApiOrders).toBeNull();
    const second = await paidOrder(counted.id, { discountCode: "CAL14", shopifyOrderId: `gid://shopify/Order/${rnd()}` });
    await db.shopifyCodeUse.create({ data: { storeId: counted.id, code: "CAL14", sessionId: second.id, email: second.email, shopifyCountBefore: 6, createdAt: new Date(Date.now() - 12 * MIN) } });
    clearShopifyDiscountCache();
    shopify.shopifyGraphql.mockResolvedValue(code(7));
    await lookupShopifyCode(counted, "cal14");
    expect((await db.store.findUniqueOrThrow({ where: { id: counted.id } })).shopifyCountsApiOrders).toBe(true);
    expect(await db.eventLog.count({ where: { storeId: counted.id, kind: "discount.shopify_count_calibrated" } })).toBe(1);

    // Not risen 15 min after: undecided (still added)… and still not risen after 1 h, twice: it doesn't.
    const notCounted = await makeStore({ shopifyDiscountCodes: true });
    const u = await use(notCounted.id, 15 * MIN);
    shopify.shopifyGraphql.mockResolvedValue(code(5));
    await lookupShopifyCode(notCounted, "cal14");
    expect((await db.store.findUniqueOrThrow({ where: { id: notCounted.id } })).shopifyCountsApiOrders).toBeNull();
    await db.shopifyCodeUse.update({ where: { id: u.id }, data: { createdAt: new Date(Date.now() - 3 * HOUR) } });
    clearShopifyDiscountCache();
    await lookupShopifyCode(notCounted, "cal14");
    expect((await db.store.findUniqueOrThrow({ where: { id: notCounted.id } })).shopifyCountsApiOrders).toBeNull();
    await use(notCounted.id, 2 * HOUR);
    clearShopifyDiscountCache();
    await lookupShopifyCode(notCounted, "cal14");
    expect((await db.store.findUniqueOrThrow({ where: { id: notCounted.id } })).shopifyCountsApiOrders).toBe(false);
    const logs = await db.eventLog.findMany({ where: { storeId: notCounted.id, kind: "discount.shopify_count_calibrated" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].message).toContain("n'inclut pas");
    // Decided: later lookups within 30 days don't change it.
    clearShopifyDiscountCache();
    shopify.shopifyGraphql.mockResolvedValue(code(9));
    await lookupShopifyCode(notCounted, "cal14");
    expect((await db.store.findUniqueOrThrow({ where: { id: notCounted.id } })).shopifyCountsApiOrders).toBe(false);
  });

  it("P3: an import failing for more than 48 h raises an incident (Protected Customer Data) and a health tile", async () => {
    const store = await makeStore();
    const since = new Date(Date.now() - 3 * DAY).toISOString();
    await db.appSetting.create({
      data: {
        key: `shopify-customers:${store.id}`,
        value: JSON.stringify({ state: "error", cursor: null, customers: 0, startedAt: since, doneAt: new Date(Date.now() - 2 * DAY).toISOString(), error: "old", errorSince: since, connectedAt: store.shopifyConnectedAt!.toISOString() }),
      },
    });
    shopify.shopifyGraphql.mockRejectedValue(new Error("Access denied for customers field. This app is not approved to access the Customer object."));
    await backfillShopifyCustomers(Date.now() + 60_000, { storeId: store.id });
    const st = JSON.parse((await db.appSetting.findUniqueOrThrow({ where: { key: `shopify-customers:${store.id}` } })).value);
    expect(st.errorSince).toBe(since);
    const incidents = await db.eventLog.findMany({ where: { storeId: store.id, kind: "import.background_failed" } });
    expect(incidents).toHaveLength(1);
    expect(incidents[0].message).toContain("Protected Customer Data");
    const tile = (await storeHealth(store.id)).find((h) => h.key === "imports");
    expect(tile).toMatchObject({ ok: false });
    expect(tile!.detail).toContain("historique des clients");
    // A recent error (< 48 h) is not an incident yet.
    const fresh = await makeStore();
    await backfillShopifyCustomers(Date.now() + 60_000, { storeId: fresh.id });
    expect(await db.eventLog.count({ where: { storeId: fresh.id, kind: "import.background_failed" } })).toBe(0);
    expect((await storeHealth(fresh.id)).find((h) => h.key === "imports")).toBeUndefined();
  });

  it("outside orders: share and ROAS over the covered days only, web apart from POS, daily web series", async () => {
    const store = await makeStore();
    const today = zonedDay(new Date(), TZ);
    const noon = (d: string) => new Date(parisDayStart(d, TZ).getTime() + 12 * HOUR);
    const yesterday = addDays(today, -1);
    const early = addDays(today, -4);
    // Import covering from the middle of today − 2: the share starts on yesterday.
    await db.appSetting.create({
      data: {
        key: `external-orders:${store.id}`,
        value: JSON.stringify({ since: new Date().toISOString(), after: null, runStartedAt: null, lastRunAt: new Date().toISOString(), imported: 3, coveredFrom: new Date(parisDayStart(addDays(today, -2), TZ).getTime() + 6 * HOUR).toISOString() }),
      },
    });
    await paidOrder(store.id, { paidAt: noon(early) });
    await paidOrder(store.id, { paidAt: noon(yesterday) });
    const ext = (id: string, day: string, sourceName: string, cents: number) =>
      db.externalOrder.create({ data: { storeId: store.id, shopifyOrderId: `gid://shopify/Order/c14${id}${rnd()}`, name: `#${id}`, orderedAt: noon(day), currency: "EUR", totalCents: cents, htCents: Math.round(cents / 1.2), countryCode: "FR", sourceName } });
    await ext("1", yesterday, "web", 12000);
    await ext("2", early, "web", 12000);
    await ext("3", yesterday, "pos", 2400);
    await db.adSpend.create({ data: { storeId: store.id, day: yesterday, platform: "meta", campaignId: "c", campaignName: "c", spendCents: 3000, currency: "EUR" } });
    await db.adSpend.create({ data: { storeId: store.id, day: early, platform: "meta", campaignId: "c", campaignName: "c", spendCents: 1000, currency: "EUR" } });
    const range = resolveRange({ range: "custom", from: addDays(today, -6), to: today }, today, "30d", TZ);
    const a = await storeAnalytics(store.id, { since: range.since, until: range.until, includeTest: false });
    expect(a.revenueHtCents).toBe(10000);
    expect(a.leakage).toMatchObject({ orders: 2, revenueHtCents: 20000, partial: true, windowFrom: yesterday });
    expect(a.leakage!.channels.pos).toEqual({ orders: 1, revenueCents: 2400, revenueHtCents: 2000 });
    // Covered days only: yesterday's 10 000 outside vs 5 000 ours (the early day is before the import's start).
    expect(a.leakage!.share).toBeCloseTo(10000 / 15000);
    expect(a.ads.roasInclExternal).toBeCloseTo(15000 / 3000);
    expect(a.daily.find((d) => d.day === yesterday)).toMatchObject({ externalRevenueHtCents: 10000, externalOrders: 1 });
    // A period entirely before the import's start: no share at all.
    const before = resolveRange({ range: "custom", from: addDays(today, -6), to: addDays(today, -3) }, today, "30d", TZ);
    const b = await storeAnalytics(store.id, { since: before.since, until: before.until, includeTest: false });
    expect(b.leakage!.share).toBeNull();
    expect(b.ads.roasInclExternal).toBeNull();
  });

  it("home country: VAT of an unknown destination is the store's own", async () => {
    const store = await makeStore({ homeCountry: "DE" });
    await paidOrder(store.id, { totalCents: 11900, subtotalCents: 11900, shippingAddress: null });
    const today = zonedDay(new Date(), TZ);
    const range = resolveRange({ range: "today" }, today, "today", TZ);
    const a = await storeAnalytics(store.id, { since: range.since, until: range.until, includeTest: false });
    expect(a.revenueHtCents).toBe(10000);
  });

  it("checkout switched off by hand: a 'désactivé' period on the charts, apart from the automatic fallback", async () => {
    const store = await makeStore({ enabled: true });
    await recordCheckoutEnabled(store.id, true, false, "Checkout Whop désactivé à la main");
    await recordCheckoutEnabled(store.id, false, false);
    // The automatic fallback isn't mistaken for it (and vice versa).
    await openFallbackPeriod(store.id, new Date(), "Whop en panne");
    expect(await db.fallbackPeriod.count({ where: { storeId: store.id, kind: "disabled", endedAt: null } })).toBe(1);
    expect(await db.fallbackPeriod.count({ where: { storeId: store.id, kind: "fallback", endedAt: null } })).toBe(1);
    const today = zonedDay(new Date(), TZ);
    const range = resolveRange({ range: "today" }, today, "today", TZ);
    const a = await storeAnalytics(store.id, { since: range.since, until: range.until, includeTest: false });
    expect(a.disabled.periods).toHaveLength(1);
    expect(a.disabled.periods[0].reason).toContain("main");
    expect(a.disabled.days).toEqual([today]);
    expect(a.fallback.periods).toHaveLength(1);
    expect(a.daily.find((d) => d.day === today)).toMatchObject({ disabled: true, fallback: true });
    await recordCheckoutEnabled(store.id, false, true);
    expect(await db.fallbackPeriod.count({ where: { storeId: store.id, kind: "disabled", endedAt: null } })).toBe(0);
    expect(await db.fallbackPeriod.count({ where: { storeId: store.id, kind: "fallback", endedAt: null } })).toBe(1);
  });
});
