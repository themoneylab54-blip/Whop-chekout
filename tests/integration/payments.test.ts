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
  const { markPaid, recordDispute, SYNC_BACKOFF_MINUTES } = await import("@/lib/checkout");
  const { runTick } = await import("@/lib/tick");
  const { acceptUpsell } = await import("@/lib/upsell");
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

  it("sends each abandoned-checkout e-mail once", async () => {
    const store = await makeStore({ recoveryEnabled: true, recoveryConsentOnly: false, resendApiKey: encrypt("re_x"), emailFrom: "Shop <a@shop.fr>" });
    const s = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line], subtotalCents: 5000, email: "lost@example.com" } });
    await db.$executeRaw`UPDATE "CheckoutSession" SET "updatedAt" = now() - interval '2 hours' WHERE id = ${s.id}`;
    notify.sendEmail.mockResolvedValue(true);
    await runTick();
    await runTick();
    const mine = notify.sendEmail.mock.calls.filter((c) => c[1].to === "lost@example.com");
    expect(mine).toHaveLength(1);
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.recoveryStage).toBe(1);
    expect(row.status).toBe("ABANDONED");
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

  it("shares the rate limit through the database", async () => {
    const key = `it:${Date.now()}`;
    expect(await rateLimit(key, 2)).toBe(true);
    expect(await rateLimit(key, 2)).toBe(true);
    expect(await rateLimit(key, 2)).toBe(false);
    await db.rateLimit.delete({ where: { key } });
  });
});
