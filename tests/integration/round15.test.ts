import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Round 15 (reliability / observability) against a real Postgres: money jobs bounded by their own slice
 * (a slow Shopify can't starve the Whop-side jobs, its calls are cut at the job's deadline), per-store
 * rotation, an offer's payment adopted when its refund arrives first, the offer route answering before
 * Shopify, non-money rotation and starved jobs, Shopify-side checkout failures kept off the fallback,
 * deadline refusals never journaled as failures, per-provider metrics (health, alert, purge), Sentry
 * scrubbing, and the Shopify code count calibration (outside uses, re-checks). Whop, part of Shopify
 * and notifications are mocked; Shopify's GraphQL client is the real one over a stubbed fetch. Test data
 * is prefixed t15fix_ and deleted at the end.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
  orderPayments: vi.fn(),
}));
const whop = vi.hoisted(() => ({ list: vi.fn(), retrieve: vi.fn(), create: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn() }));
const afterQueue = vi.hoisted(() => [] as (() => unknown)[]);

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn) }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({
  ...(await orig<typeof import("@/lib/whop")>()),
  storeClient: () => ({
    payments: {
      list: async (params: Record<string, unknown>) => ({ data: (await whop.list(params)) as unknown[], response: { page_info: { has_next_page: false, end_cursor: null } } }),
      retrieve: (p: { id: string }) => whop.retrieve(p),
      create: (...a: unknown[]) => whop.create(...a),
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

describe.skipIf(!hasDb)("round 15 reliability & observability (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { DeadlineError } = await import("@/lib/deadline");
  const { withLogContext } = await import("@/lib/log");
  const { runTick, rotateStores, starvedJobs, cleanup } = await import("@/lib/tick");
  const { handleEvent, RetryLater } = await import("@/lib/webhooks");
  const { sweepPendingUpsells, retryOfferBalances } = await import("@/lib/upsell");
  const { journalCheckoutFailure } = await import("@/lib/checkout");
  const { ShopifyError } = await vi.importActual<typeof import("@/lib/shopify")>("@/lib/shopify");
  const realShopify = await vi.importActual<typeof import("@/lib/shopify")>("@/lib/shopify");
  const metrics = await import("@/lib/metrics");
  const { providersHealth, providersOverview, watchProviders } = await import("@/lib/providers");
  const { extFetch } = await import("@/lib/ext");
  const { route } = await import("@/lib/route");
  const { resetSentryDedupe } = await import("@/lib/sentry");
  const { calibrateShopifyCodeCount } = await import("@/lib/shopify-discounts");
  const { storeAnalytics, resolveRange, parisDayStart } = await import("@/lib/analytics");
  const { addDays, zonedDay } = await import("@/lib/time");
  const healthRoute = await import("@/app/api/health/route");
  const upsellRoute = await import("@/app/api/public/sessions/[id]/upsell/route");

  const created: string[] = [];
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const TZ = "Europe/Paris";
  const startedAt = new Date();

  const line = (o: Record<string, unknown> = {}) => ({
    variantId: "gid://shopify/ProductVariant/15",
    productId: "gid://shopify/Product/15",
    productHandle: "bonnet",
    title: "Bonnet",
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
        name: `t15fix_${rnd()}`,
        testMode: false,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_t15",
        whopProductId: `prod_t15_${rnd()}`,
        whopApiKey: encrypt("k"),
        shopDomain: `t15fix-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        shopifyScopes: "read_products,write_orders,read_discounts,write_order_edits",
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

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
        whopPaymentId: `pay_t15_${rnd()}`,
        email: `b-${rnd()}@t15fix.test`,
        shippingAddress: { firstName: "A", lastName: "B", address1: "1 rue X", city: "Paris", zip: "75001", countryCode: "FR" },
        ...data,
      } as never,
    });

  /** A fetch that never answers Shopify (until its abort signal fires) and answers 200 elsewhere. */
  const shopifyWaits: { host: string; ms: number }[] = [];
  const slowShopifyFetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes(".myshopify.com")) {
      const t0 = Date.now();
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        const fail = () => {
          shopifyWaits.push({ host: new URL(String(url)).host, ms: Date.now() - t0 });
          reject(signal!.reason);
        };
        if (signal?.aborted) fail();
        signal?.addEventListener("abort", fail);
      });
    }
    return Promise.resolve(new Response("{}", { status: 200 }));
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    afterQueue.length = 0;
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockRejectedValue(new Error("unexpected order"));
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) => items.map((i) => line({ variantId: i.variantId, quantity: i.quantity })));
    whop.list.mockResolvedValue([]);
    whop.retrieve.mockRejectedValue(Object.assign(new Error("not found"), { statusCode: 404 }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.eventLog.deleteMany({ where: { kind: { in: ["tick.job_starved", "provider.degraded"] }, createdAt: { gte: startedAt } } });
    await db.providerMetric.deleteMany({ where: { provider: { startsWith: "t15fix_" } } });
    await db.appSetting.deleteMany({ where: { OR: [...created.map((id) => ({ key: { contains: id } })), { key: { startsWith: "tick-rotate:t15fix_" } }, { key: { startsWith: "provider-alert:t15fix_" } }] } });
    await db.rateLimit.deleteMany({ where: { OR: created.map((id) => ({ key: { contains: id } })) } });
    await db.webhookEvent.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("1: a slow Shopify can't keep the Whop-side money jobs from running, and only spends its own jobs' slices", async () => {
    // (No Shopify history import for this store: only the money jobs call Shopify.)
    const store = await makeStore({ shopifyConnectedAt: null });
    // Due for its Shopify order (Shopify-side), an offer charge to settle (Whop) and a missed payment (Whop).
    const due = await paidOrder(store.id, { paidAt: new Date(Date.now() - 10 * MIN) });
    const charge = await db.upsellCharge.create({
      data: { sessionId: due.id, blockId: "b", title: "Écharpe", variantId: "v", amountCents: 900, whopPaymentId: `pay_c_${due.id}`, chargeStartedAt: new Date(Date.now() - 10 * MIN), createdAt: new Date(Date.now() - 10 * MIN) },
    });
    const missed = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()], subtotalCents: 6000, totalCents: 6000 } });
    whop.list.mockImplementation(async (p: { product_id?: string }) =>
      p.product_id === store.whopProductId
        ? [{ id: `pay_h_${missed.id}`, status: "paid", paid_at: new Date().toISOString(), created_at: new Date().toISOString(), product_id: store.whopProductId, metadata: { checkout_session_id: missed.id }, total: 60, currency: "eur" }]
        : [],
    );
    whop.retrieve.mockImplementation(async ({ id }: { id: string }) => ({ id, status: "paid" }));
    // Every order lookup goes through the real Shopify client, whose fetch never answers.
    shopify.findOrderForSession.mockImplementation(async (s: Parameters<typeof realShopify.shopifyGraphql>[0]) => {
      await realShopify.shopifyGraphql(s, "query { orders(first: 1) { nodes { id } } }");
      return null;
    });
    vi.stubGlobal("fetch", slowShopifyFetch);
    shopifyWaits.length = 0;
    const report = await runTick(30_000, { moneyJobMs: 1_500, overrunMs: 1_600 });
    // The Whop-side jobs ran in full, before any Shopify-side one.
    expect(report.upsellsSwept).toBe(1);
    expect(report.reconciled).toBe(1);
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe("PAID");
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: missed.id } })).status).toBe("PAID");
    const order = Object.keys(report);
    expect(order.indexOf("reconciled")).toBeLessThan(order.indexOf("syncRetried"));
    expect(order.indexOf("upsellsSwept")).toBeLessThan(order.indexOf("followUps"));
    // Shopify was called (and cut) in several jobs, each bounded by its slice + overrun (≈ 3.1 s), so
    // the money jobs after them still ran: nothing was skipped for lack of time.
    // Round 17: the first hang opens the run's Shopify breaker, so later Shopify calls fail fast (no fetch).
    const shopifyCalls = slowShopifyFetch.mock.calls.filter((c) => String(c[0]).includes(".myshopify.com"));
    expect(shopifyCalls.length).toBeGreaterThanOrEqual(1);
    for (const name of ["refundsMirrored", "disputesTagged", "trackingPushed", "disputeEvidence"]) expect(String(report[name])).not.toMatch(/time budget used/);
    // Each hanging call was cut at its job's deadline (slice + overrun ≈ 3.1 s), never at the 12 s timeout.
    // (Other stores' non-money imports may call Shopify too: only this store's money-job calls are checked.)
    const mine = shopifyWaits.filter((w) => w.host === store.shopDomain);
    expect(mine.length).toBeGreaterThanOrEqual(1);
    for (const w of mine) expect(w.ms).toBeLessThan(3_300);
    // Shopify never answered (cut at the job's deadline) and no time was left for its retry: the real
    // transient failure is the outcome (round 16), a counted try with its backoff — not a silent deferral.
    // Round 17: once the run's Shopify breaker is open, this order's retry fails fast without spending a
    // try (DeadlineError): either its own call hung (a counted try with backoff) or it waits for the next run.
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: due.id } });
    expect(row.syncAttempts).toBeLessThanOrEqual(1);
    if (row.syncAttempts === 1) expect(row.nextSyncAt).not.toBeNull();
    expect(row.shopifyOrderId).toBeNull();
  }, 70_000);

  it("1: the Shopify client honours the money job's deadline, not only the run's hard deadline", async () => {
    const store = await makeStore();
    vi.stubGlobal("fetch", slowShopifyFetch);
    const t0 = Date.now();
    const call = withLogContext({ hardDeadline: Date.now() + 50_000, jobDeadline: Date.now() + 3_500 }, () => realShopify.shopifyGraphql(store, "query { shop { name } }"));
    // The first attempt was cut at the job's deadline; no time for the retry: its real (transient)
    // failure is thrown, never a DeadlineError (round 16).
    await expect(call).rejects.toMatchObject({ transient: true });
    await expect(call).rejects.toBeInstanceOf(ShopifyError);
    expect(Date.now() - t0).toBeLessThan(5_000);
    // A non-idempotent mutation needs an 8 s window: refused at once, never sent.
    slowShopifyFetch.mockClear();
    const mutation = withLogContext({ jobDeadline: Date.now() + 5_000 }, () => realShopify.shopifyGraphql(store, "mutation { orderCreate { order { id } } }", {}, { retry: false }));
    await expect(mutation).rejects.toBeInstanceOf(DeadlineError);
    expect(slowShopifyFetch).not.toHaveBeenCalled();
  });

  it("1: per-store jobs start from a rotating store", async () => {
    const stores = [{ id: "t15fix_a" }, { id: "t15fix_b" }, { id: "t15fix_c" }];
    const first = await rotateStores("t15fix_job", stores);
    expect(first.list.map((s) => s.id)).toEqual(["t15fix_a", "t15fix_b", "t15fix_c"]);
    // Stopped after one store: the next run starts with the second.
    await first.advance(1);
    const second = await rotateStores("t15fix_job", stores);
    expect(second.list.map((s) => s.id)).toEqual(["t15fix_b", "t15fix_c", "t15fix_a"]);
    // All done: the start still moves (no store is always first).
    await second.advance(3);
    expect((await rotateStores("t15fix_job", stores)).list[0].id).toBe("t15fix_c");
  });

  it("2: a refund arriving before the offer's payment id is recorded settles the offer as refunded (no Shopify order)", async () => {
    const store = await makeStore();
    const s = await paidOrder(store.id);
    const charge = await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "b", title: "Bonnet", variantId: "v", amountCents: 700, chargeStartedAt: new Date(Date.now() - 10 * MIN) } });
    const paymentId = `pay_adopt_${s.id}`;
    await handleEvent("refund.created", { id: `re_adopt_${s.id}`, payment: { id: paymentId, metadata: { upsell_id: charge.id } }, status: "succeeded", amount: 7, currency: "eur" }, store.id);
    let row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    // Adopted: the refund is the offer's own, not an "earlier attempt".
    expect(row).toMatchObject({ whopPaymentId: paymentId, refundedCents: 700, status: "PENDING" });
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "refund.extra_payment" } })).toBe(0);
    // The sweep learns it was paid: settled as refunded, never created in Shopify.
    whop.retrieve.mockResolvedValue({ id: paymentId, status: "paid" });
    await sweepPendingUpsells(Date.now() + 10_000);
    row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row).toMatchObject({ status: "PAID", shopifyOrderId: null, syncSkippedReason: "refunded" });
    expect(row.syncHandledAt).not.toBeNull();
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    // A second, unknown payment for the same offer is not attributed on a guess.
    await expect(
      handleEvent("refund.created", { id: `re_other_${s.id}`, payment: { id: `pay_other_${s.id}`, metadata: { upsell_id: charge.id } }, status: "succeeded", amount: 7, currency: "eur" }, store.id),
    ).rejects.toBeInstanceOf(RetryLater);
  });

  it("3: the offer route answers « paid » as soon as Whop confirms; the Shopify order is created after the response", async () => {
    const store = await makeStore({
      thankYouLayout: { blocks: [{ id: "up1", type: "upsell", props: { badge: "", title: "Chaussettes", text: "", variantId: "77", imageUrl: "", price: 9.9, compareAt: 0, buttonText: "Oui", declineText: "Non" } }] },
    });
    const s = await paidOrder(store.id, { whopMemberId: "mem_t15", whopPaymentMethodId: "pm_t15", shopifyOrderName: "#1500" });
    whop.create.mockResolvedValue({ id: `pay_route_${s.id}`, status: "paid", recovery_url: null });
    let release: (v: { id: string; name: string }) => void = () => undefined;
    shopify.createPaidOrder.mockImplementation(() => new Promise((r) => (release = r)));
    const res = await upsellRoute.POST(
      new Request("https://x/api", { method: "POST", headers: { "x-forwarded-for": `10.15.${Math.floor(Math.random() * 200)}.1` }, body: JSON.stringify({ blockId: "up1", accept: true }) }),
      { params: Promise.resolve({ id: s.id }) },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "paid", orderName: null });
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    const charge = await db.upsellCharge.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(charge).toMatchObject({ status: "PAID", whopPaymentId: `pay_route_${s.id}`, shopifyOrderId: null });
    // After the response: the order is created (bounded by the function's limit).
    expect(afterQueue.length).toBeGreaterThanOrEqual(1);
    const running = Promise.all(afterQueue.splice(0).map((fn) => fn()));
    await vi.waitFor(() => expect(shopify.createPaidOrder).toHaveBeenCalledTimes(1));
    release({ id: "gid://shopify/Order/1501", name: "#1501" });
    await running;
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).shopifyOrderName).toBe("#1501");
  });

  it("4: non-money jobs start from a rotating offset; one skipped for over 6 h is journaled once and shown in health", async () => {
    const keys = ["tick:job-ran", "tick:non-money-offset", "tick:starved-alert", "tick:report"];
    const saved = await db.appSetting.findMany({ where: { key: { in: keys } } });
    try {
      await db.appSetting.deleteMany({ where: { key: { in: keys } } });
      await db.appSetting.create({ data: { key: "tick:job-ran", value: JSON.stringify({ cleaned: new Date(Date.now() - 7 * HOUR).toISOString() }) } });
      await db.appSetting.create({ data: { key: "tick:non-money-offset", value: "3" } });
      vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
      // No time at all: every job is skipped.
      const report = await runTick(1);
      expect(report.cleaned).toBe("skipped: time budget used");
      // Next run starts one job further (the first one of this run couldn't start).
      expect((await db.appSetting.findUniqueOrThrow({ where: { key: "tick:non-money-offset" } })).value).toBe("4");
      expect((await starvedJobs()).map((j) => j.name)).toEqual(["cleaned"]);
      const logged = await db.eventLog.findMany({ where: { kind: "tick.job_starved", createdAt: { gte: startedAt } } });
      expect(logged).toHaveLength(1);
      expect(logged[0].message).toContain("« cleaned »");
      // Throttled: a second starved run doesn't journal again.
      await runTick(1);
      expect(await db.eventLog.count({ where: { kind: "tick.job_starved", createdAt: { gte: startedAt } } })).toBe(1);
      // The report order: rotated non-money jobs, money jobs first.
      const normal = await runTick(30_000);
      const order = Object.keys(normal);
      expect(order.indexOf("disputeEvidence")).toBeLessThan(order.indexOf("conversionsRetried"));
      // Having run, it's no longer starved.
      expect(await starvedJobs()).toEqual([]);
    } finally {
      await db.appSetting.deleteMany({ where: { key: { in: keys } } });
      if (saved.length) await db.appSetting.createMany({ data: saved.map((s) => ({ key: s.key, value: s.value })) });
    }
  }, 40_000);

  it("5: Shopify pricing failures are their own incident and never trip the fallback; Whop failures do", async () => {
    const store = await makeStore({ autoFallback: true });
    const sessions = await Promise.all([1, 2, 3].map(() => db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()], subtotalCents: 6000 } })));
    for (const s of sessions) await journalCheckoutFailure(s, "prepare", new ShopifyError("Shopify API 503: unavailable", true));
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).fallbackActiveAt).toBeNull();
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "checkout.init_failed" } })).toBe(0);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "checkout.shopify_failed" } })).toBe(1);
    // Whop can't open checkouts (tagged by prepareSession): journaled, the storefront stays ours.
    const { tagFailureSource } = await import("@/lib/checkout");
    for (const s of sessions) {
      const err = await tagFailureSource(Promise.reject(new Error("Whop 503")), "whop").catch((e: unknown) => e);
      await journalCheckoutFailure(s, "prepare", err);
    }
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).fallbackActiveAt).toBeNull();
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "checkout.init_failed" } })).toBe(3);
  });

  it("6: an offer balance out of time spends no try and journals nothing; a sweep refused for time journals no « uncertain »", async () => {
    const store = await makeStore();
    const s = await paidOrder(store.id, { shopifyOrderId: `gid://shopify/Order/${rnd()}`, shopifyOrderName: "#1510" });
    const merged = await db.upsellCharge.create({
      data: { sessionId: s.id, blockId: "m", title: "Gants", variantId: "v", amountCents: 500, status: "PAID", whopPaymentId: `pay_m_${s.id}`, orderMode: "merged", shopifyOrderId: s.shopifyOrderId, createdAt: new Date(Date.now() - 10 * MIN) },
    });
    shopify.orderPayments.mockRejectedValue(new DeadlineError("Shopify orderPayments"));
    const partial: { partial?: boolean } = {};
    await withLogContext({ tickPartial: partial }, () => retryOfferBalances(Date.now() + 10_000));
    expect(partial.partial).toBe(true);
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: merged.id } })).balanceAttempts).toBe(0);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: { startsWith: "upsell.merge_unpaid" } } })).toBe(0);

    // A charge whose answer was never received: the replay is refused by the client for lack of time.
    const pending = await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "p", title: "Écharpe", variantId: "v", amountCents: 900, chargeStartedAt: new Date(Date.now() - 10 * MIN) } });
    whop.create.mockRejectedValue(new DeadlineError("Whop"));
    const p2: { partial?: boolean } = {};
    await withLogContext({ tickPartial: p2 }, () => sweepPendingUpsells(Date.now() + 10_000));
    expect(p2.partial).toBe(true);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "upsell.uncertain" } })).toBe(0);
    expect(await db.upsellCharge.findUniqueOrThrow({ where: { id: pending.id } })).toMatchObject({ status: "PENDING", error: null, whopPaymentId: null });
  });

  it("7: a money job stopped by its slice reports « partial », never done", async () => {
    const store = await makeStore();
    for (let i = 0; i < 3; i++) await paidOrder(store.id, { paidAt: new Date(Date.now() - (20 + i) * MIN) });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    shopify.findOrderForSession.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 700));
      return { id: `gid://shopify/Order/${rnd()}`, name: "#15xx" };
    });
    const report = await runTick(30_000, { moneyJobMs: 1_000 });
    expect(String(report.syncRetried)).toMatch(/^skipped: partial/);
  }, 40_000);

  it("8: provider calls are rolled up per 5-min bucket (errors, latency) and read by health", async () => {
    const t = Date.now();
    for (let i = 0; i < 8; i++) metrics.noteProviderCall("t15fix_pay", { ms: 120, status: 200 }, t);
    for (let i = 0; i < 4; i++) metrics.noteProviderCall("t15fix_pay", { ms: 9_000, status: 503 }, t);
    metrics.noteProviderCall("t15fix_pay", { ms: 10_000, err: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) }, t);
    // An external call through extFetch feeds the same rollup (the ext.call log line).
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad gateway", { status: 502 })));
    await extFetch("t15fix_ext" as never, "op", "https://t15fix.invalid/x?access_token=secret");
    // Written by this flush (or by a background one it raced with).
    await metrics.flushProviderMetrics();
    await vi.waitFor(async () => expect(await db.providerMetric.findFirst({ where: { provider: "t15fix_pay" } })).toMatchObject({ calls: 13, errors: 5, timeouts: 1, h0: 8, h6: 5 }));
    await vi.waitFor(async () => expect(await db.providerMetric.findFirst({ where: { provider: "t15fix_ext" } })).not.toBeNull());
    const row = await db.providerMetric.findFirstOrThrow({ where: { provider: "t15fix_pay" } });
    expect(row.lastError).toMatch(/timeout/);
    expect((await db.providerMetric.findFirstOrThrow({ where: { provider: "t15fix_ext" } })).errors).toBe(1);
    const h = (await providersHealth()).find((p) => p.provider === "t15fix_pay")!;
    expect(h.errorRate).toBeCloseTo(5 / 13);
    expect(h.p95Ms).toBe(10_000);
    expect(h.degraded).toContain("d'erreurs");
    expect((await providersOverview()).find((p) => p.provider === "t15fix_pay")!.day.calls).toBe(13);
    // /api/health: providers section + a degraded line (past the probe's 10 s cache).
    const real = Date.now;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + 61_000);
    try {
      const res = await healthRoute.GET(new Request("https://x/api/health"), { params: Promise.resolve({}) });
      const body = (await res.json()) as { degraded: string[]; providers: Record<string, { calls: number; degraded: boolean; p95Ms: number }> };
      expect(body.providers.t15fix_pay).toMatchObject({ calls: 13, degraded: true, p95Ms: 10_000 });
      expect(body.degraded.join(" ")).toContain("provider t15fix_pay degraded");
    } finally {
      spy.mockRestore();
    }
    // Retention: buckets older than 14 days are purged by the cleanup.
    await db.providerMetric.create({ data: { provider: "t15fix_old", bucket: new Date(Date.now() - 15 * DAY), calls: 1 } });
    await cleanup();
    expect(await db.providerMetric.count({ where: { provider: "t15fix_old" } })).toBe(0);
  });

  it("8: a provider failing for 15 minutes alerts once (throttled); a burst that just started doesn't", async () => {
    await makeStore({ alertEmail: "ops@t15fix.test" });
    const bucket = (ago: number) => new Date(Math.floor((Date.now() - ago) / metrics.BUCKET_MS) * metrics.BUCKET_MS);
    for (const ago of [10 * MIN, 5 * MIN, 0]) await db.providerMetric.create({ data: { provider: "t15fix_down", bucket: bucket(ago), calls: 6, errors: 4, lastErrorAt: new Date(), lastError: "HTTP 503" } });
    await db.providerMetric.create({ data: { provider: "t15fix_burst", bucket: bucket(0), calls: 20, errors: 20 } });
    expect(await watchProviders(Date.now() + 10_000)).toBeGreaterThanOrEqual(1);
    const alerts = await db.eventLog.findMany({ where: { kind: "provider.degraded", createdAt: { gte: startedAt } } });
    const providers = alerts.map((a) => (a.data as { provider?: string }).provider);
    expect(providers).toContain("t15fix_down");
    expect(providers).not.toContain("t15fix_burst");
    expect(alerts.find((a) => (a.data as { provider?: string }).provider === "t15fix_down")!.message).toContain("HTTP 503");
    // Throttled: at most one per provider per hour.
    await watchProviders(Date.now() + 10_000);
    expect(await db.eventLog.count({ where: { kind: "provider.degraded", createdAt: { gte: startedAt }, data: { path: ["provider"], equals: "t15fix_down" } } })).toBe(1);
  });

  it("8: an unhandled route error is sent to Sentry (when configured) without personal data", async () => {
    const saved = { dsn: process.env.SENTRY_DSN, rate: process.env.SENTRY_SAMPLE_RATE };
    process.env.SENTRY_DSN = "https://abc123@o1.ingest.sentry.io/42";
    delete process.env.SENTRY_SAMPLE_RATE;
    resetSentryDedupe();
    const sent = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", sent);
    try {
      const handler = route("t15fix.route", async () => {
        throw new Error("boom for buyer@t15fix.test with token shpat_abcdefghijklmnopqrstu and card 4242 4242 4242 4242");
      });
      const res = await handler(new Request("https://x/api"), { params: Promise.resolve({}) });
      expect(res.status).toBe(500);
      for (const fn of afterQueue.splice(0)) await fn();
      expect(sent).toHaveBeenCalledTimes(1);
      const [url, init] = sent.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://o1.ingest.sentry.io/api/42/envelope/");
      const body = String(init.body);
      expect(body).toContain("route:t15fix.route");
      expect(body).toContain("boom for [email]");
      expect(body).not.toContain("buyer@t15fix.test");
      expect(body).not.toContain("shpat_");
      expect(body).not.toContain("4242 4242");
      // The same error again within a minute: deduplicated.
      await handler(new Request("https://x/api"), { params: Promise.resolve({}) });
      for (const fn of afterQueue.splice(0)) await fn();
      expect(sent).toHaveBeenCalledTimes(1);
    } finally {
      if (saved.dsn === undefined) delete process.env.SENTRY_DSN;
      else process.env.SENTRY_DSN = saved.dsn;
      if (saved.rate !== undefined) process.env.SENTRY_SAMPLE_RATE = saved.rate;
    }
  });

  describe("9: Shopify code count calibration", () => {
    const covered = (storeId: string) =>
      db.appSetting.create({
        data: { key: `external-orders:${storeId}`, value: JSON.stringify({ since: new Date().toISOString(), after: null, runStartedAt: new Date(Date.now() + MIN).toISOString(), lastRunAt: new Date(Date.now() + MIN).toISOString(), imported: 1 }) },
      });
    const use = async (storeId: string, ago: number, before: number) => {
      const s = await paidOrder(storeId, { discountCode: "CAL15", shopifyOrderId: `gid://shopify/Order/${rnd()}` });
      return db.shopifyCodeUse.create({ data: { storeId, code: "CAL15", sessionId: s.id, email: s.email, shopifyCountBefore: before, createdAt: new Date(Date.now() - ago) } });
    };
    const outside = (storeId: string, ago: number) =>
      db.externalOrder.create({ data: { storeId, shopifyOrderId: `gid://shopify/Order/t15${rnd()}`, name: "#pos", orderedAt: new Date(Date.now() - ago), currency: "EUR", totalCents: 1000, htCents: 833, sourceName: "pos", discountCodes: ["CAL15"] } });

    it("an outside use of the code in the window never passes for one of ours (no false « counts »)", async () => {
      const store = await makeStore({ shopifyDiscountCodes: true });
      await covered(store.id);
      // Shopify doesn't count our orders; a POS sale used the code meanwhile: +1 for our 1 — twice.
      await use(store.id, 20 * MIN, 5);
      await outside(store.id, 15 * MIN);
      expect(await calibrateShopifyCodeCount(store.id, "cal15", 6)).toBeNull();
      await use(store.id, 12 * MIN, 6);
      await outside(store.id, 11 * MIN);
      expect(await calibrateShopifyCodeCount(store.id, "cal15", 7)).toBeNull();
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).shopifyCountsApiOrders).toBeNull();
      // Import not covering the window yet: an exact match waits (never decided on a guess).
      const waiting = await makeStore({ shopifyDiscountCodes: true });
      await use(waiting.id, 20 * MIN, 5);
      await use(waiting.id, 12 * MIN, 6);
      expect(await calibrateShopifyCodeCount(waiting.id, "cal15", 7)).toBeNull();
      const state = JSON.parse((await db.appSetting.findUniqueOrThrow({ where: { key: `shopify-code-calibration:${waiting.id}` } })).value) as { votes: { verified: boolean }[] };
      expect(state.votes.every((v) => !v.verified)).toBe(true);
    });

    it("« counts » contradicted by Shopify's count, or two re-checks after 30 days, goes back to unknown (uses added)", async () => {
      // Shopify's count below our own settled uses: impossible if it counted them.
      const store = await makeStore({ shopifyDiscountCodes: true, shopifyCountsApiOrders: true });
      await db.appSetting.create({ data: { key: `shopify-code-calibration:${store.id}`, value: JSON.stringify({ votes: [], checkedAt: Date.now() }) } });
      for (let i = 0; i < 3; i++) await use(store.id, (30 + i) * MIN, 2 + i);
      expect(await calibrateShopifyCodeCount(store.id, "cal15", 2)).toBeNull();
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).shopifyCountsApiOrders).toBeNull();
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "discount.shopify_count_recalibrating" } })).toBe(1);

      // Decided 31 days ago: re-checked; two references now say "doesn't count" → reset.
      const old = await makeStore({ shopifyDiscountCodes: true, shopifyCountsApiOrders: true });
      await db.appSetting.create({ data: { key: `shopify-code-calibration:${old.id}`, value: JSON.stringify({ votes: [], checkedAt: Date.now() - 31 * DAY }) } });
      await use(old.id, 2 * HOUR, 5);
      expect(await calibrateShopifyCodeCount(old.id, "cal15", 5)).toBeNull();
      expect((await db.store.findUniqueOrThrow({ where: { id: old.id } })).shopifyCountsApiOrders).toBe(true);
      await use(old.id, 90 * MIN, 5);
      await calibrateShopifyCodeCount(old.id, "cal15", 5);
      expect((await db.store.findUniqueOrThrow({ where: { id: old.id } })).shopifyCountsApiOrders).toBeNull();
      expect(await db.eventLog.count({ where: { storeId: old.id, kind: "discount.shopify_count_recalibrating" } })).toBe(1);

      // Not due yet (confirmed recently): a lookup changes nothing.
      const fresh = await makeStore({ shopifyDiscountCodes: true, shopifyCountsApiOrders: true });
      await db.appSetting.create({ data: { key: `shopify-code-calibration:${fresh.id}`, value: JSON.stringify({ votes: [], checkedAt: Date.now() - DAY }) } });
      await use(fresh.id, 2 * HOUR, 5);
      await use(fresh.id, 90 * MIN, 5);
      await calibrateShopifyCodeCount(fresh.id, "cal15", 6);
      expect((await db.store.findUniqueOrThrow({ where: { id: fresh.id } })).shopifyCountsApiOrders).toBe(true);
    });
  });

  it("analytics: days before the outside orders import's coverage are unknown (null), the partial ROAS note has the window's amount", async () => {
    const store = await makeStore();
    const today = zonedDay(new Date(), TZ);
    const noon = (d: string) => new Date(parisDayStart(d, TZ).getTime() + 12 * HOUR);
    const yesterday = addDays(today, -1);
    const early = addDays(today, -4);
    await db.appSetting.create({
      data: {
        key: `external-orders:${store.id}`,
        value: JSON.stringify({ since: new Date().toISOString(), after: null, runStartedAt: null, lastRunAt: new Date().toISOString(), imported: 2, coveredFrom: new Date(parisDayStart(addDays(today, -2), TZ).getTime() + 6 * HOUR).toISOString() }),
      },
    });
    await paidOrder(store.id, { paidAt: noon(yesterday) });
    const ext = (day: string, cents: number) =>
      db.externalOrder.create({ data: { storeId: store.id, shopifyOrderId: `gid://shopify/Order/t15${rnd()}`, name: "#w", orderedAt: noon(day), currency: "EUR", totalCents: cents, htCents: Math.round(cents / 1.2), countryCode: "FR", sourceName: "web" } });
    await ext(yesterday, 12000);
    await ext(early, 12000);
    const range = resolveRange({ range: "custom", from: addDays(today, -6), to: today }, today, "30d", TZ);
    const a = await storeAnalytics(store.id, { since: range.since, until: range.until, includeTest: false });
    expect(a.daily.find((d) => d.day === early)).toMatchObject({ externalRevenueHtCents: null, externalOrders: null });
    expect(a.daily.find((d) => d.day === yesterday)).toMatchObject({ externalRevenueHtCents: 10000, externalOrders: 1 });
    expect(a.daily.find((d) => d.day === addDays(today, -2))).toMatchObject({ externalRevenueHtCents: null });
    expect(a.leakage).toMatchObject({ partial: true, orders: 2, revenueHtCents: 20000, windowOrders: 1, windowRevenueHtCents: 10000 });
  });
});
