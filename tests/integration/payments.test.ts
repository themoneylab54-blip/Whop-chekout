import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * End-to-end tests of the money path against a real Postgres (CI service or local
 * DATABASE_URL), with Shopify, Whop and outgoing notifications mocked.
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
}));
const whop = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  shipments: vi.fn(),
  disputeUpdate: vi.fn(),
  disputeSubmit: vi.fn(),
  refund: vi.fn(),
  refunds: vi.fn(),
}));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn() }));

vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({
  ...(await orig<typeof import("@/lib/whop")>()),
  refundPayment: whop.refund,
  storeClient: () => ({
    payments: {
      // Cursor pages like Whop's: `after` is the index where the next page starts.
      list: async (params: { first?: number; after?: string; product_id?: string }) => {
        const all = (await whop.list(params)) as unknown[];
        const start = params.after ? Number(params.after) : 0;
        const size = params.first ?? 50;
        const data = all.slice(start, start + size);
        const more = start + size < all.length;
        return { data, response: { page_info: { has_next_page: more, end_cursor: more ? String(start + size) : null } } };
      },
      create: whop.create,
    },
    refunds: { list: async () => ({ data: await whop.refunds(), response: { page_info: { has_next_page: false, end_cursor: null } } }) },
    shipments: { create: whop.shipments },
    disputes: { update: whop.disputeUpdate, submit: whop.disputeSubmit, list: async () => ({ data: [], response: { page_info: { has_next_page: false, end_cursor: null } } }) },
  }),
}));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("payments (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { markPaid, recordDispute, recordRefund, SYNC_BACKOFF_MINUTES } = await import("@/lib/checkout");
  const { runTick } = await import("@/lib/tick");
  const { acceptUpsell, markUpsellFailed, markUpsellPaid } = await import("@/lib/upsell");
  const { recordEvent } = await import("@/lib/log");
  const { rateLimit } = await import("@/lib/ratelimit");
  const { encrypt } = await import("@/lib/crypto");

  const created: string[] = [];
  const line = { variantId: "gid://shopify/ProductVariant/42", productId: "p", productHandle: "sweat", title: "Sweat", variantTitle: null, sku: null, imageUrl: null, quantity: 1, unitPriceCents: 5000, compareAtCents: null, inventory: null, requiresShipping: true };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: "Test intégration",
        whopConnectedAt: new Date(),
        whopAccountId: "biz_1",
        whopProductId: "prod_1",
        whopApiKey: encrypt("k"),
        shopDomain: `it-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  async function makePaidReadySession(storeId: string, extra: Record<string, unknown> = {}) {
    const s = await db.checkoutSession.create({
      data: {
        storeId,
        currency: "EUR",
        lines: [line],
        subtotalCents: 5000,
        totalCents: 5490,
        email: "buyer@example.com",
        shippingAddress: { firstName: "A", lastName: "B", address1: "1 rue", city: "Paris", zip: "75001", countryCode: "FR" },
        ...extra,
      },
    });
    await db.checkoutQuote.create({
      data: {
        sessionId: s.id,
        whopCheckoutId: `ch_${s.id}`,
        fingerprint: "f",
        currency: "EUR",
        subtotalCents: 5000,
        discountCents: 0,
        shippingCents: 490,
        addOnsCents: 0,
        totalCents: 5490,
        shippingRateId: "r1",
        shippingRateName: "Colissimo",
        shippingCountries: ["FR"],
        addOns: [],
        addOnIds: [],
      },
    });
    return s;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.orderTracking.mockResolvedValue([]);
    shopify.tagOrder.mockResolvedValue(undefined);
    // Shopify's refunded total = what createRefund has applied to that order so far.
    shopify.orderRefundedCents.mockImplementation(async (_st: unknown, orderId: string) =>
      shopify.createRefund.mock.calls.filter((c) => c[1] === orderId).reduce((sum, c) => sum + Number(c[2]), 0),
    );
    shopify.createPaidOrder.mockRejectedValue(new Error("unexpected order"));
    whop.list.mockResolvedValue([]);
    whop.refunds.mockResolvedValue([]);
  });

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("records a failed Shopify sync, schedules a retry and alerts once, then heals on retry", async () => {
    const store = await makeStore();
    const s = await makePaidReadySession(store.id);
    shopify.createPaidOrder.mockRejectedValueOnce(new Error("Shopify API 503"));
    await markPaid(s.id, { id: `pay_${s.id}`, totalCents: 5490, currency: "eur", checkoutConfigurationId: `ch_${s.id}` });

    let row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.status).toBe("PAID");
    expect(row.shopifyOrderId).toBeNull();
    expect(row.syncAttempts).toBe(1);
    expect(row.nextSyncAt!.getTime() - Date.now()).toBeGreaterThan((SYNC_BACKOFF_MINUTES[0] - 0.2) * 60_000);
    expect(notify.sendAlert).toHaveBeenCalledTimes(1);

    // A 503 on orderCreate is ambiguous (Shopify may have created it): no retry before its search is consistent.
    expect(row.syncAmbiguousAt).not.toBeNull();
    expect(row.nextSyncAt!.getTime() - Date.now()).toBeGreaterThan(4.8 * 60_000);
    await db.checkoutSession.update({ where: { id: s.id }, data: { nextSyncAt: new Date(Date.now() - 1000) } });
    await runTick();
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).shopifyOrderId).toBeNull();

    // Backoff and consistency window elapsed: the background tick retries and succeeds.
    await db.checkoutSession.update({ where: { id: s.id }, data: { nextSyncAt: new Date(Date.now() - 1000), syncAmbiguousAt: new Date(Date.now() - 6 * 60_000) } });
    // The tick scans every store: answer only for this test's session.
    shopify.createPaidOrder.mockImplementation(async (_store: unknown, input: { sessionId: string }) => {
      if (input.sessionId !== s.id) throw new Error("not this test");
      return { id: "gid://shopify/Order/1", name: "#1001" };
    });
    await runTick();
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.shopifyOrderName).toBe("#1001");
    expect(row.nextSyncAt).toBeNull();
    const kinds = (await db.eventLog.findMany({ where: { sessionId: s.id } })).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["payment.succeeded", "sync.failed", "order.synced"]));
  });

  it("adopts an order that already exists in Shopify instead of creating a duplicate", async () => {
    const store = await makeStore();
    const s = await makePaidReadySession(store.id);
    shopify.findOrderForSession.mockResolvedValueOnce({ id: "gid://shopify/Order/9", name: "#1009", tags: [] });
    await markPaid(s.id, { id: `pay_${s.id}`, totalCents: 5490, currency: "eur", checkoutConfigurationId: `ch_${s.id}` });
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).shopifyOrderName).toBe("#1009");
  });

  it("reconciliation recovers a payment whose webhook never arrived", async () => {
    const store = await makeStore();
    const s = await makePaidReadySession(store.id);
    whop.list.mockResolvedValue([
      {
        id: `pay_rec_${s.id}`,
        metadata: { checkout_session_id: s.id },
        checkout_configuration_id: `ch_${s.id}`,
        total: { amount: "54.90", currency: "eur" },
        customer_email: "buyer@example.com",
      },
    ]);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/2", name: "#1002" });
    await runTick();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.status).toBe("PAID");
    expect(row.whopPaymentId).toBe(`pay_rec_${s.id}`);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "reconcile.healed" } })).toBe(1);
  });

  it("charges a one-click upsell once and creates its own Shopify order", async () => {
    const store = await makeStore({
      thankYouLayout: {
        blocks: [
          {
            id: "up1",
            type: "upsell",
            props: { badge: "", title: "Chaussettes", text: "", variantId: "77", imageUrl: "", price: 9.9, compareAt: 0, buttonText: "Oui", declineText: "Non" },
          },
        ],
      },
    });
    const s = await makePaidReadySession(store.id, {
      status: "PAID",
      paidAt: new Date(),
      whopPaymentId: `pay_up_${Date.now()}`,
      whopMemberId: "mem_1",
      whopPaymentMethodId: "pm_1",
      shopifyOrderName: "#1003",
    });
    shopify.priceCart.mockResolvedValue([{ ...line, variantId: "gid://shopify/ProductVariant/77", title: "Chaussettes" }]);
    whop.create.mockResolvedValue({ id: `pay_upsell_${s.id}`, status: "paid", recovery_url: null });
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/4", name: "#1004" });
    const full = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id }, include: { store: true } });

    const first = await acceptUpsell(full, "up1");
    const second = await acceptUpsell(full, "up1");
    expect(first).toEqual({ status: "paid", orderName: "#1004" });
    expect(second).toEqual({ status: "paid", orderName: "#1004" });
    expect(whop.create).toHaveBeenCalledTimes(1);
    const call = whop.create.mock.calls[0][0];
    expect(call).toMatchObject({ member_id: "mem_1", payment_method_id: "pm_1", plan: { initial_price: 9.9 } });
    expect(shopify.createPaidOrder.mock.calls[0][1]).toMatchObject({ totalCents: 990, shipping: null });
  });

  it("submits dispute evidence automatically and pushes tracking to Whop", async () => {
    const store = await makeStore();
    const s = await makePaidReadySession(store.id, {
      status: "PAID",
      paidAt: new Date(),
      whopPaymentId: `pay_dis_${Date.now()}`,
      shopifyOrderId: "gid://shopify/Order/5",
      shopifyOrderName: "#1005",
    });
    // No tracking yet: evidence waits (stronger once the parcel is tracked).
    await recordDispute(s.id, "dsp_1");
    expect(whop.disputeSubmit).not.toHaveBeenCalled();
    shopify.orderTracking.mockResolvedValue([{ number: "6A1", company: "Colissimo", url: null }]);
    await runTick();
    // Each Whop call carries its own request options (timeout from the time left when it starts).
    expect(whop.disputeUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: "dsp_1" }), expect.objectContaining({ timeoutInSeconds: expect.any(Number) }));
    expect(whop.disputeSubmit).toHaveBeenCalledWith({ id: "dsp_1" }, expect.objectContaining({ timeoutInSeconds: expect.any(Number) }));
    expect(whop.shipments).toHaveBeenCalledWith(
      expect.objectContaining({ payment_id: expect.stringMatching(/^pay_dis_/), tracking_number: "6A1" }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^ship_/) }),
    );
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.disputed).toBe(true);
    expect(row.disputeEvidenceAt).not.toBeNull();
    expect(row.trackingNumber).toBe("6A1");
  });

  it("never syncs a held payment, even with concurrent deliveries", async () => {
    const store = await makeStore();
    const s = await makePaidReadySession(store.id);
    const underpaid = { id: `pay_low_${s.id}`, totalCents: 100, currency: "eur", checkoutConfigurationId: `ch_${s.id}` };
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/66", name: "#1066" });
    await Promise.all([markPaid(s.id, underpaid), markPaid(s.id, underpaid), markPaid(s.id, underpaid)]);
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.status).toBe("PAID");
    expect(row.reviewNote).toMatch(/inférieur/);
    expect(row.shopifyOrderId).toBeNull();
    expect(shopify.createPaidOrder.mock.calls.filter((c) => c[1].sessionId === s.id)).toHaveLength(0);
  });

  it("a second payment is flagged without blocking the first order", async () => {
    const store = await makeStore();
    const s = await makePaidReadySession(store.id);
    shopify.createPaidOrder.mockRejectedValueOnce(new Error("Shopify API 503"));
    await markPaid(s.id, { id: `payA_${s.id}`, totalCents: 5490, currency: "eur", checkoutConfigurationId: `ch_${s.id}` });
    await markPaid(s.id, { id: `payB_${s.id}`, totalCents: 5490, currency: "eur", checkoutConfigurationId: `ch_${s.id}` });
    await markPaid(s.id, { id: `payB_${s.id}`, totalCents: 5490, currency: "eur", checkoutConfigurationId: `ch_${s.id}` });
    let row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.whopPaymentId).toBe(`payA_${s.id}`);
    expect(row.extraPaymentIds).toEqual([`payB_${s.id}`]);
    expect(row.reviewNote).toBeNull();

    await db.checkoutSession.update({ where: { id: s.id }, data: { nextSyncAt: new Date(Date.now() - 1000), syncAmbiguousAt: new Date(Date.now() - 6 * 60_000) } });
    shopify.createPaidOrder.mockImplementation(async (_s: unknown, input: { sessionId: string }) => {
      if (input.sessionId !== s.id) throw new Error("not this test");
      return { id: "gid://shopify/Order/67", name: "#1067" };
    });
    await runTick();
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.shopifyOrderName).toBe("#1067");
  });

  it("does not create an order when the idempotency lookup fails", async () => {
    const store = await makeStore();
    const s = await makePaidReadySession(store.id);
    shopify.findOrderForSession.mockRejectedValueOnce(new Error("Shopify API throttled"));
    await markPaid(s.id, { id: `pay_lk_${s.id}`, totalCents: 5490, currency: "eur", checkoutConfigurationId: `ch_${s.id}` });
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.syncAttempts).toBe(1);
    expect(row.nextSyncAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
  });

  it("lets the buyer retry an offer the bank declined", async () => {
    const store = await makeStore({
      thankYouLayout: {
        blocks: [{ id: "up2", type: "upsell", props: { badge: "", title: "Gants", text: "", variantId: "88", imageUrl: "", price: 5, compareAt: 0, buttonText: "Oui", declineText: "Non" } }],
      },
    });
    const s = await makePaidReadySession(store.id, {
      status: "PAID",
      paidAt: new Date(),
      whopPaymentId: `pay_up2_${Date.now()}`,
      whopMemberId: "mem_2",
      whopPaymentMethodId: "pm_2",
    });
    shopify.priceCart.mockResolvedValue([{ ...line, variantId: "gid://shopify/ProductVariant/88", title: "Gants" }]);
    whop.create.mockResolvedValueOnce({ id: `pay_upA_${s.id}`, status: "pending", recovery_url: null });
    const full = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id }, include: { store: true } });
    expect(await acceptUpsell(full, "up2")).toEqual({ status: "pending" });
    const charge = await db.upsellCharge.findFirstOrThrow({ where: { sessionId: s.id } });
    await markUpsellFailed(charge.id, store.id, "insufficient_funds", `pay_upA_${s.id}`);
    whop.create.mockResolvedValueOnce({ id: `pay_upB_${s.id}`, status: "paid", recovery_url: null });
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/68", name: "#1068" });
    expect(await acceptUpsell(full, "up2")).toEqual({ status: "paid", orderName: "#1068" });
    expect(whop.create).toHaveBeenCalledTimes(2);
  });

  it("groups repeated alerts of the same kind", async () => {
    const store = await makeStore();
    await recordEvent({ storeId: store.id, level: "error", kind: "sync.failed", message: "a", alert: true });
    await recordEvent({ storeId: store.id, level: "error", kind: "sync.failed", message: "b", alert: true });
    await recordEvent({ storeId: store.id, level: "warn", kind: "review.hold", message: "c", alert: true });
    await recordEvent({ storeId: store.id, level: "warn", kind: "review.hold", message: "d", alert: true });
    expect(notify.sendAlert).toHaveBeenCalledTimes(3); // 1 grouped sync.failed + 2 review holds (never grouped)
    expect(await db.eventLog.count({ where: { storeId: store.id } })).toBe(4);
  });

  it("retries a purchase conversion that failed", async () => {
    const store = await makeStore({ metaPixelId: "123", metaAccessToken: encrypt("tok") });
    const s = await makePaidReadySession(store.id);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/69", name: "#1069" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("boom", { status: 500 }));
    await markPaid(s.id, { id: `pay_px_${s.id}`, totalCents: 5490, currency: "eur", checkoutConfigurationId: `ch_${s.id}` });
    let row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.pixelSentAt).toBeNull();
    expect(row.pixelStatus).toEqual({ meta: "failed" });
    // The failed try scheduled its own retry (backoff on pixelNextAttemptAt, never the updatedAt clock): elapsed.
    expect(row.pixelNextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    await db.checkoutSession.update({ where: { id: s.id }, data: { pixelNextAttemptAt: new Date(Date.now() - 60_000) } });
    fetchSpy.mockImplementation(async (url) =>
      String(url).includes("graph.facebook.com") ? new Response('{"events_received":1}', { status: 200 }) : new Response("{}", { status: 200 }),
    );
    await runTick();
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.pixelSentAt).not.toBeNull();
    expect(row.pixelStatus).toEqual({ meta: "sent" });
    fetchSpy.mockRestore();
  });

  it("mirrors a refund exactly once, even when it arrives during the order sync", async () => {
    const store = await makeStore();
    const s = await makePaidReadySession(store.id);
    // The refund lands while orderCreate is in flight.
    shopify.createPaidOrder.mockImplementation(async (_st: unknown, input: { sessionId: string }) => {
      if (input.sessionId !== s.id) throw new Error("not this test");
      await recordRefund(s.id, 1000, `re_a_${s.id}`);
      return { id: "gid://shopify/Order/70", name: "#1070" };
    });
    shopify.createRefund.mockResolvedValue(undefined);
    await markPaid(s.id, { id: `pay_rf_${s.id}`, totalCents: 5490, currency: "eur", checkoutConfigurationId: `ch_${s.id}` });
    await recordRefund(s.id, 500, `re_b_${s.id}`);
    await runTick();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.refundedCents).toBe(1500);
    expect(row.refundMirroredCents).toBe(1500);
    const mine = shopify.createRefund.mock.calls.filter((c) => c[1] === "gid://shopify/Order/70");
    expect(mine.reduce((sum, c) => sum + c[2], 0)).toBe(1500);
  });

  it("creates an upsell order once under concurrent calls, and never after a failed lookup", async () => {
    const store = await makeStore();
    const s = await makePaidReadySession(store.id, { status: "PAID", paidAt: new Date(), whopPaymentId: `pay_ul_${Date.now()}` });
    const charge = await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "b", title: "X", variantId: "gid://shopify/ProductVariant/1", amountCents: 500 } });
    shopify.priceCart.mockResolvedValue([line]);
    shopify.findOrderForSession.mockRejectedValueOnce(new Error("throttled"));
    await markUpsellPaid(charge.id, `pay_c_${charge.id}`, store.id);
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    await db.upsellCharge.update({ where: { id: charge.id }, data: { nextSyncAt: null } });
    shopify.createPaidOrder.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return { id: "gid://shopify/Order/71", name: "#1071" };
    });
    await Promise.all([markUpsellPaid(charge.id, `pay_c_${charge.id}`, store.id), markUpsellPaid(charge.id, `pay_c_${charge.id}`, store.id)]);
    expect(shopify.createPaidOrder).toHaveBeenCalledTimes(1);
  });

  it("ignores a late failure of an earlier upsell attempt", async () => {
    const store = await makeStore();
    const s = await makePaidReadySession(store.id, { status: "PAID", paidAt: new Date(), whopPaymentId: `pay_ug_${Date.now()}` });
    const charge = await db.upsellCharge.create({
      data: { sessionId: s.id, blockId: "b", title: "X", variantId: "1", amountCents: 500, whopPaymentId: `pay_new_${s.id}` },
    });
    await markUpsellFailed(charge.id, store.id, "old attempt", `pay_old_${s.id}`);
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe("PENDING");
  });

  it("charges offers with an idempotency key and resolves uncertain ones by replaying it", async () => {
    const store = await makeStore({
      thankYouLayout: {
        blocks: [{ id: "up3", type: "upsell", props: { badge: "", title: "Bonnet", text: "", variantId: "99", imageUrl: "", price: 7, compareAt: 0, buttonText: "Oui", declineText: "Non" } }],
      },
    });
    const s = await makePaidReadySession(store.id, { status: "PAID", paidAt: new Date(), whopPaymentId: `pay_up3_${Date.now()}`, whopMemberId: "m", whopPaymentMethodId: "pm" });
    shopify.priceCart.mockResolvedValue([{ ...line, variantId: "gid://shopify/ProductVariant/99", title: "Bonnet" }]);
    // Timeout: outcome unknown → stays pending, no second charge on retry click.
    whop.create.mockRejectedValueOnce(Object.assign(new Error("timeout"), { statusCode: undefined }));
    const full = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id }, include: { store: true } });
    expect(await acceptUpsell(full, "up3")).toEqual({ status: "pending" });
    expect(await acceptUpsell(full, "up3")).toEqual({ status: "pending" });
    expect(whop.create).toHaveBeenCalledTimes(1);
    const key = whop.create.mock.calls[0][1].idempotencyKey;
    expect(key).toMatch(/^upsell_/);
    // The sweep replays the same key and learns it was paid.
    const charge = await db.upsellCharge.findFirstOrThrow({ where: { sessionId: s.id } });
    await db.upsellCharge.update({ where: { id: charge.id }, data: { chargeStartedAt: new Date(Date.now() - 10 * 60_000) } });
    whop.create.mockResolvedValueOnce({ id: `pay_up3b_${s.id}`, status: "paid", recovery_url: null });
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/73", name: "#1073" });
    await runTick();
    expect(whop.create.mock.calls[1][1].idempotencyKey).toBe(key);
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe("PAID");
  });

  it("never replays an offer charge after the acceptance window", async () => {
    const store = await makeStore({
      thankYouLayout: {
        blocks: [{ id: "up4", type: "upsell", props: { badge: "", title: "Gants", text: "", variantId: "98", imageUrl: "", price: 9, compareAt: 0, buttonText: "Oui", declineText: "Non" } }],
      },
    });
    const s = await makePaidReadySession(store.id, { status: "PAID", paidAt: new Date(), whopPaymentId: `pay_up4_${Date.now()}`, whopMemberId: "m", whopPaymentMethodId: "pm" });
    shopify.priceCart.mockResolvedValue([{ ...line, variantId: "gid://shopify/ProductVariant/98", title: "Gants", unitCostCents: 300 }]);
    whop.create.mockRejectedValueOnce(Object.assign(new Error("timeout"), { statusCode: undefined }));
    const full = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id }, include: { store: true } });
    expect(await acceptUpsell(full, "up4")).toEqual({ status: "pending" });
    const charge = await db.upsellCharge.findFirstOrThrow({ where: { sessionId: s.id } });
    expect(charge.costCents).toBe(300);
    await db.upsellCharge.update({ where: { id: charge.id }, data: { chargeStartedAt: new Date(Date.now() - 3 * 3600_000) } });
    await runTick();
    expect(whop.create).toHaveBeenCalledTimes(1);
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe("FAILED");
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "upsell.gave_up" } })).toBe(1);
  });

  it("keeps reconciling other stores when one store's Whop call fails", async () => {
    const bad = await makeStore();
    const good = await makeStore();
    const s = await makePaidReadySession(good.id);
    shopify.createPaidOrder.mockImplementation(async (_st: unknown, input: { sessionId: string }) => {
      if (input.sessionId !== s.id) throw new Error("not this test");
      return { id: "gid://shopify/Order/72", name: "#1072" };
    });
    const payment = { id: `pay_iso_${s.id}`, metadata: { checkout_session_id: s.id }, checkout_configuration_id: `ch_${s.id}`, total: { amount: "54.90", currency: "eur" } };
    let calls = 0;
    whop.list.mockImplementation(async () => {
      calls++;
      if (calls === 1) throw new Error("Whop 401");
      return [payment];
    });
    // Order stores so the failing one goes first.
    await db.store.update({ where: { id: bad.id }, data: { createdAt: new Date(0) } });
    await runTick();
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PAID");
    expect(await db.eventLog.count({ where: { kind: "reconcile.failed" } })).toBeGreaterThan(0);
  });

  it("resumes a long reconciliation from Whop's cursor instead of restarting", async () => {
    const store = await makeStore({ whopProductId: `prod_many_${Date.now()}` });
    const now = Date.now();
    const payments = Array.from({ length: 520 }, (_, i) => ({ id: `pay_many_${store.id}_${i}`, paid_at: new Date(now - i * 1000).toISOString(), metadata: {} }));
    const pages: (string | undefined)[] = [];
    whop.list.mockImplementation(async (params: { product_id?: string; after?: string }) => {
      if (params.product_id !== store.whopProductId) return [];
      pages.push(params.after);
      return payments;
    });
    await runTick();
    const run = await db.appSetting.findUnique({ where: { key: `reconcile-run:${store.id}` } });
    expect(run).not.toBeNull();
    expect(await db.appSetting.findUnique({ where: { key: `reconcile:${store.id}` } })).toBeNull();
    await db.appSetting.update({ where: { key: "tick:last" }, data: { value: new Date(0).toISOString() } }).catch(() => undefined);
    pages.length = 0;
    await runTick();
    // Second run starts where the first stopped, then finishes and sets the mark.
    expect(pages[0]).toBe(JSON.parse(run!.value).cursor);
    expect(await db.appSetting.findUnique({ where: { key: `reconcile-run:${store.id}` } })).toBeNull();
    expect(await db.appSetting.findUnique({ where: { key: `reconcile:${store.id}` } })).not.toBeNull();
    await db.appSetting.deleteMany({ where: { key: { in: [`reconcile:${store.id}`, `reconcile-run:${store.id}`] } } });
  });

  it("shares the rate limit through the database", async () => {
    const key = `it:${Date.now()}`;
    expect(await rateLimit(key, 2)).toBe(true);
    expect(await rateLimit(key, 2)).toBe(true);
    expect(await rateLimit(key, 2)).toBe(false);
    await db.rateLimit.delete({ where: { key } });
  });
});
