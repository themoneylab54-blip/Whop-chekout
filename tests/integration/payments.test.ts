import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * End-to-end tests of the money path against a real Postgres (CI service or local
 * DATABASE_URL), with Shopify, Whop and outgoing notifications mocked.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  createRefund: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
  orderTracking: vi.fn(),
}));
const whop = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  shipments: vi.fn(),
  disputeUpdate: vi.fn(),
  disputeSubmit: vi.fn(),
  refund: vi.fn(),
}));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn() }));

vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({
  ...(await orig<typeof import("@/lib/whop")>()),
  refundPayment: whop.refund,
  storeClient: () => ({
    payments: {
      list: async () => ({
        async *[Symbol.asyncIterator]() {
          for (const p of await whop.list()) yield p;
        },
      }),
      create: whop.create,
    },
    shipments: { create: whop.shipments },
    disputes: { update: whop.disputeUpdate, submit: whop.disputeSubmit },
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
    shopify.orderTracking.mockResolvedValue([]);
    shopify.createPaidOrder.mockRejectedValue(new Error("unexpected order"));
    whop.list.mockResolvedValue([]);
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

    // Backoff elapsed: the background tick retries and succeeds.
    await db.checkoutSession.update({ where: { id: s.id }, data: { nextSyncAt: new Date(Date.now() - 1000) } });
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
    shopify.orderTracking.mockResolvedValue([{ number: "6A1", company: "Colissimo", url: null }]);
    await recordDispute(s.id, "dsp_1");
    expect(whop.disputeUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: "dsp_1" }));
    expect(whop.disputeSubmit).toHaveBeenCalledWith({ id: "dsp_1" });
    await runTick();
    expect(whop.shipments).toHaveBeenCalledWith(expect.objectContaining({ payment_id: expect.stringMatching(/^pay_dis_/), tracking_number: "6A1" }));
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

    await db.checkoutSession.update({ where: { id: s.id }, data: { nextSyncAt: new Date(Date.now() - 1000) } });
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
    await db.$executeRaw`UPDATE "CheckoutSession" SET "updatedAt" = now() - interval '10 minutes' WHERE id = ${s.id}`;
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
      await recordRefund(s.id, 1000);
      return { id: "gid://shopify/Order/70", name: "#1070" };
    });
    shopify.createRefund.mockResolvedValue(undefined);
    await markPaid(s.id, { id: `pay_rf_${s.id}`, totalCents: 5490, currency: "eur", checkoutConfigurationId: `ch_${s.id}` });
    await recordRefund(s.id, 500);
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

  it("shares the rate limit through the database", async () => {
    const key = `it:${Date.now()}`;
    expect(await rateLimit(key, 2)).toBe(true);
    expect(await rateLimit(key, 2)).toBe(true);
    expect(await rateLimit(key, 2)).toBe(false);
    await db.rateLimit.delete({ where: { key } });
  });
});
