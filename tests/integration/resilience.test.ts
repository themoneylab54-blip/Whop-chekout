import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Whop } from "@whop/sdk";

/*
 * Failure paths of the money pipeline against a real Postgres: crashes in the middle
 * of a refund mirror, failed/early webhooks kept and replayed, duplicate payments,
 * refund reconciliation and overlapping maintenance runs.
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
const whop = vi.hoisted(() => ({ list: vi.fn(), refunds: vi.fn(), retrieve: vi.fn(), refund: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn() }));

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    void Promise.resolve().then(fn);
  },
}));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({
  ...(await orig<typeof import("@/lib/whop")>()),
  // Signature checks are covered elsewhere: here the body is the event.
  verifyWhopWebhook: (raw: string) => JSON.parse(raw),
  refundPayment: whop.refund,
  storeClient: () => ({
    payments: {
      list: async () => ({ data: await whop.list(), response: { page_info: { has_next_page: false, end_cursor: null } } }),
      retrieve: whop.retrieve,
    },
    refunds: { list: async () => ({ data: await whop.refunds(), response: { page_info: { has_next_page: false, end_cursor: null } } }) },
    shipments: { create: vi.fn() },
    disputes: { update: vi.fn(), submit: vi.fn(), list: async () => ({ data: [], response: { page_info: { has_next_page: false, end_cursor: null } } }) },
  }),
}));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("resilience (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { runTick } = await import("@/lib/tick");
  const { handleEvent, replayStaleEvents } = await import("@/lib/webhooks");
  const { encrypt } = await import("@/lib/crypto");
  const { POST: webhook } = await import("@/app/api/webhooks/whop/[storeId]/route");
  const created: string[] = [];
  const line = { variantId: "gid://shopify/ProductVariant/42", productId: "p", productHandle: "h", title: "Sweat", variantTitle: null, sku: null, imageUrl: null, quantity: 1, unitPriceCents: 5000, compareAtCents: null, inventory: null, requiresShipping: true };

  async function makeStore() {
    const store = await db.store.create({
      data: {
        name: "Résilience",
        whopConnectedAt: new Date(),
        whopAccountId: "biz_1",
        whopProductId: `prod_res_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        whopApiKey: encrypt("k"),
        whopWebhookSecret: encrypt("s"),
        shopDomain: `res-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
      },
    });
    created.push(store.id);
    return store;
  }

  async function paidSession(storeId: string, extra: Record<string, unknown> = {}) {
    return db.checkoutSession.create({
      data: {
        storeId,
        currency: "EUR",
        lines: [line],
        subtotalCents: 5000,
        totalCents: 5490,
        status: "PAID",
        paidAt: new Date(),
        whopPaymentId: `pay_${Math.random().toString(36).slice(2)}`,
        shopifyOrderId: `gid://shopify/Order/${Math.floor(Math.random() * 1e9)}`,
        shopifyOrderName: "#9001",
        pixelAttempts: 5,
        ...extra,
      },
    });
  }

  const post = (storeId: string, id: string, body: unknown) =>
    webhook(new Request(`http://x/api/webhooks/whop/${storeId}`, { method: "POST", headers: { "webhook-id": id }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ storeId }),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.orderTracking.mockResolvedValue([]);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.orderRefundedCents.mockImplementation(async (_st: unknown, orderId: string) =>
      shopify.createRefund.mock.calls.filter((c) => c[1] === orderId).reduce((sum, c) => sum + Number(c[2]), 0),
    );
    whop.list.mockResolvedValue([]);
    whop.refunds.mockResolvedValue([]);
  });

  afterAll(async () => {
    await db.refundRecord.deleteMany({ where: { storeId: { in: created } } });
    await db.webhookEvent.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("never loses a refund when the run dies between the claim and Shopify", async () => {
    const store = await makeStore();
    // State left by a run killed after taking the lease: nothing marked as mirrored.
    const s = await paidSession(store.id, { refundedCents: 1000, refundMirrorStartedAt: new Date(Date.now() - 10 * 60_000) });
    shopify.createRefund.mockResolvedValue(undefined);
    await runTick();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.refundMirroredCents).toBe(1000);
    expect(shopify.createRefund).toHaveBeenCalledTimes(1);
    expect(shopify.createRefund.mock.calls[0][2]).toBe(1000);
  });

  it("does not refund twice when Shopify applied it but the answer was lost", async () => {
    const store = await makeStore();
    const s = await paidSession(store.id, { refundedCents: 700 });
    shopify.orderRefundedCents.mockResolvedValue(700); // already in Shopify
    await runTick();
    expect(shopify.createRefund).not.toHaveBeenCalled();
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundMirroredCents).toBe(700);
  });

  it("backs off a failing refund mirror and keeps it visible", async () => {
    const store = await makeStore();
    const s = await paidSession(store.id, { refundedCents: 500 });
    shopify.createRefund.mockRejectedValue(new Error("Shopify 422"));
    await runTick();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.refundMirroredCents).toBe(0);
    expect(row.refundMirrorAttempts).toBe(1);
    expect(row.nextRefundMirrorAt!.getTime()).toBeGreaterThan(Date.now());
    expect(row.refundMirrorStartedAt).toBeNull();
    const { backlog } = await import("@/lib/health");
    await db.checkoutSession.update({ where: { id: s.id }, data: { updatedAt: new Date(Date.now() - 3600_000) } });
    // Visible as a normal backoff (health "degraded") until overdue for its retry ("down").
    expect(await backlog(store.id)).toMatchObject({ refundsUnmirrored: 0, refundsBackingOff: 1 });
    await db.checkoutSession.update({ where: { id: s.id }, data: { nextRefundMirrorAt: new Date(Date.now() - 3600_000), updatedAt: new Date(Date.now() - 3600_000) } });
    expect(await backlog(store.id)).toMatchObject({ refundsUnmirrored: 1, refundsBackingOff: 0 });
  });

  it("keeps an early refund webhook and replays it once the payment is known", async () => {
    const store = await makeStore();
    const paymentId = `pay_early_${Date.now()}`;
    whop.retrieve.mockResolvedValue({ id: paymentId, metadata: { checkout_session_id: "x" }, product_id: store.whopProductId });
    // Real webhook shape: the payment is embedded, the amount is a number with its currency.
    const evt = { type: "refund.created", data: { id: `re_${paymentId}`, payment: { id: paymentId, metadata: {} }, status: "succeeded", amount: 10, currency: "eur" } };
    const res = await post(store.id, `wh_${paymentId}`, evt);
    expect(res.status).toBe(503);
    const kept = await db.webhookEvent.findFirstOrThrow({ where: { id: `wh_${paymentId}` } });
    // Whop's delivery failed: counted apart, the local replay budget is untouched but scheduled.
    expect(kept.deliveries).toBe(1);
    expect(kept.attempts).toBe(0);
    expect(kept.nextAttemptAt).not.toBeNull();
    expect(kept.processedAt).toBeNull();
    // The payment gets recorded; the local replay applies the refund without Whop.
    const s = await paidSession(store.id, { whopPaymentId: paymentId });
    await db.webhookEvent.updateMany({ where: { id: kept.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    shopify.createRefund.mockResolvedValue(undefined);
    expect(await replayStaleEvents(Date.now() + 10_000)).toBe(1);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(1000);
    expect((await db.webhookEvent.findFirstOrThrow({ where: { id: kept.id } })).processedAt).not.toBeNull();
  });

  it("answers 409 while another delivery holds a fresh claim, and 200 once done", async () => {
    const store = await makeStore();
    await db.webhookEvent.create({ data: { id: "wh_busy_" + store.id, storeId: store.id, type: "payment.failed" } });
    expect((await post(store.id, "wh_busy_" + store.id, { type: "payment.failed", data: { id: "p" } })).status).toBe(409);
    await db.webhookEvent.updateMany({ where: { id: "wh_busy_" + store.id }, data: { processedAt: new Date() } });
    const again = await post(store.id, "wh_busy_" + store.id, { type: "payment.failed", data: { id: "p" } });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ duplicate: true });
  });

  it("journals refunds and disputes on a duplicate payment instead of retrying or dropping them", async () => {
    const store = await makeStore();
    const dup = `pay_dup_${store.id}`;
    const s = await paidSession(store.id, { extraPaymentIds: [dup] });
    const refund = { id: `re_dup_${store.id}`, payment: { id: dup }, status: "succeeded", amount: 54.9, currency: "eur" };
    await handleEvent("refund.created", refund, store.id);
    await handleEvent("refund.created", refund, store.id);
    expect(shopify.createRefund).not.toHaveBeenCalled();
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "refund.extra_payment" } })).toBe(1);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(0);
    await handleEvent("dispute.created", { id: `dp_dup_${store.id}`, payment: { id: dup } }, store.id);
    const d = await db.eventLog.findFirstOrThrow({ where: { sessionId: s.id, kind: "dispute.created" } });
    expect(d.level).toBe("error");
    expect(notify.sendAlert).toHaveBeenCalled();
  });

  it("recovers a refund whose webhook never came, through refund reconciliation", async () => {
    const store = await makeStore();
    const s = await paidSession(store.id);
    shopify.createRefund.mockResolvedValue(undefined);
    whop.refunds.mockResolvedValue([
      // List API shape: payment_id, money objects (settlement + original).
      { id: `re_rec_${s.id}`, payment_id: s.whopPaymentId, status: "succeeded", amount: { amount: "5.00", currency: "eur" }, original_amount: { amount: "5.00", currency: "eur" }, created_at: new Date().toISOString() },
    ]);
    await runTick();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.refundedCents).toBe(500);
    expect(row.refundMirroredCents).toBe(500);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "reconcile.refund_healed" } })).toBe(1);
  });

  it("switches the storefront to Shopify's checkout when Whop keeps failing", async () => {
    const { journalCheckoutFailure } = await import("@/lib/checkout");
    const store = await makeStore();
    const sessions = await Promise.all([1, 2, 3].map(() => db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line], subtotalCents: 5000 } })));
    for (const s of sessions.slice(0, 2)) await journalCheckoutFailure(s, "prepare", new Error("Whop 503"));
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).fallbackActiveAt).toBeNull();
    await journalCheckoutFailure(sessions[2], "prepare", new Error("Whop 503"));
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).fallbackActiveAt).not.toBeNull();
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "fallback.activated" } })).toBe(1);
  });

  it("journals one init failure per session per 10 min (retries during an outage)", async () => {
    const { journalCheckoutFailure } = await import("@/lib/checkout");
    const store = await makeStore();
    const s = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line], subtotalCents: 5000 } });
    for (let i = 0; i < 3; i++) await journalCheckoutFailure(s, "prepare", new Error("Whop 503"));
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "checkout.init_failed" } })).toBe(1);
  });

  it("never mirrors a refund in another currency than the order", async () => {
    const store = await makeStore();
    const s = await paidSession(store.id);
    await handleEvent("refund.created", { id: `re_usd_${s.id}`, payment: { id: s.whopPaymentId }, status: "succeeded", amount: 54, currency: "usd" }, store.id);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(0);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "refund.currency_mismatch" } })).toBe(1);
    // The list shape carries the original amount in the order's currency: that one is used.
    await handleEvent("refund.created", { id: `re_mix_${s.id}`, payment_id: s.whopPaymentId, status: "succeeded", amount: { amount: "5.40", currency: "usd" }, original_amount: { amount: "5.00", currency: "eur" } }, store.id);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(500);
    expect(await db.refundRecord.count({ where: { sessionId: s.id } })).toBe(1);
  });

  it("opens a dispute from an update whose creation was never received, and records a loss", async () => {
    const store = await makeStore();
    const s = await paidSession(store.id);
    await handleEvent("dispute.updated", { id: `dp_up_${s.id}`, payment: { id: s.whopPaymentId }, status: "lost", amount: 54.9, currency: "eur" }, store.id);
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.disputed).toBe(true);
    expect(row.disputeId).toBe(`dp_up_${s.id}`);
    expect(row.disputeStatus).toBe("lost");
    expect(row.disputeLostCents).toBe(5490);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "dispute.lost" } })).toBe(1);
  });

  it("attributes a refund of an earlier offer attempt (a known previous payment); an unknown one of a paid offer is retried", async () => {
    const store = await makeStore();
    const s = await paidSession(store.id);
    const charge = await db.upsellCharge.create({
      data: { sessionId: s.id, blockId: "b", title: "Bonnet", variantId: "v", amountCents: 700, status: "PAID", whopPaymentId: `pay_new_${s.id}`, previousPaymentIds: [`pay_old_${s.id}`] },
    });
    await handleEvent("refund.created", { id: `re_old_${s.id}`, payment: { id: `pay_old_${s.id}`, metadata: { upsell_id: charge.id } }, status: "succeeded", amount: 7, currency: "eur" }, store.id);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "refund.extra_payment" } })).toBe(1);
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).refundedCents).toBe(0);
    // Named by its metadata only, neither the recorded payment nor a known earlier attempt: not attributed on a guess.
    const { RetryLater } = await import("@/lib/webhooks");
    await expect(
      handleEvent("refund.created", { id: `re_other_${s.id}`, payment: { id: `pay_other_${s.id}`, metadata: { upsell_id: charge.id } }, status: "succeeded", amount: 7, currency: "eur" }, store.id),
    ).rejects.toBeInstanceOf(RetryLater);
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).refundedCents).toBe(0);
  });

  it("never overwrites a payment that lands during a checkout request", async () => {
    const { quoteSession } = await import("@/lib/checkout");
    const store = await makeStore();
    const s = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line], subtotalCents: 5000, totalCents: 5000 } });
    // The webhook marks it paid while Shopify re-prices the new quantity.
    shopify.priceCart.mockImplementation(async () => {
      await db.checkoutSession.update({ where: { id: s.id }, data: { status: "PAID", paidAt: new Date() } });
      return [{ ...line, quantity: 2 }];
    });
    const full = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id }, include: { store: true } });
    await expect(quoteSession(full, { quantities: { [line.variantId]: 2 }, addOnIds: [] })).rejects.toMatchObject({ code: "already_paid" });
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.status).toBe("PAID");
    expect((row.lines as unknown as { quantity: number }[])[0].quantity).toBe(1);
  });

  it("adds a recommended product from the checkout, priced by Shopify", async () => {
    const { quoteSession } = await import("@/lib/checkout");
    const store = await makeStore();
    const s = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line], subtotalCents: 5000, totalCents: 5000 } });
    const extra = { ...line, variantId: "gid://shopify/ProductVariant/77", productId: "p77", title: "Bougie", unitPriceCents: 1500 };
    shopify.priceCart.mockImplementation(async (_st: unknown, items: { variantId: string; quantity: number }[]) =>
      items.map((i) => ({ ...(i.variantId === extra.variantId ? extra : line), quantity: i.quantity })),
    );
    const full = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id }, include: { store: true } });
    const q = await quoteSession(full, { quantities: { [extra.variantId]: 1, "not-a-gid": 3 }, addOnIds: [] });
    expect(q.lines.map((l) => l.variantId)).toEqual([line.variantId, extra.variantId]);
    expect(q.totals.subtotalCents).toBe(6500);
  });

  it("handles SDK-typed webhook payloads: refund.created (RefundLegacy)", async () => {
    const store = await makeStore();
    const s = await paidSession(store.id);
    shopify.createRefund.mockResolvedValue(undefined);
    const payload = {
      amount: 12.5,
      created_at: new Date().toISOString(),
      currency: "eur",
      id: `re_typed_${s.id}`,
      payment: { id: s.whopPaymentId!, metadata: { checkout_session_id: s.id } } as unknown as Whop.RefundLegacy.Payment,
      provider: "stripe",
      provider_created_at: null,
      reference_status: null,
      reference_type: null,
      reference_value: null,
      status: "succeeded",
    } satisfies Omit<Whop.RefundLegacy, "provider" | "status" | "currency"> & Record<string, unknown>;
    await handleEvent("refund.created", payload as unknown as Record<string, unknown>, store.id);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(1250);
  });

  it("never refunds a Visa RDR alert (the issuer already refunded), even with auto-refund on", async () => {
    const store = await makeStore();
    await db.store.update({ where: { id: store.id }, data: { autoRefundFraudAlerts: true } });
    const s = await paidSession(store.id);
    const alert = {
      account_id: null,
      amount: 54.9,
      card_brand: "visa",
      created_at: new Date().toISOString(),
      currency: "eur",
      fee_charged: false,
      id: `da_${s.id}`,
      issuer: null,
      payment_id: s.whopPaymentId,
      product_id: null,
      reported_at: new Date().toISOString(),
      transaction_at: null,
      type: "rapid_dispute_resolution",
      updated_at: new Date().toISOString(),
    } satisfies Whop.DisputeAlert;
    await handleEvent("dispute_alert.created", alert as unknown as Record<string, unknown>, store.id);
    expect(whop.refund).not.toHaveBeenCalled();
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "dispute_alert.rdr" } })).toBe(1);
    // An early fraud warning is refunded, with an idempotency key per alert.
    await handleEvent("dispute_alert.created", { ...alert, id: `da2_${s.id}`, type: "early_fraud_warning" } as unknown as Record<string, unknown>, store.id);
    expect(whop.refund).toHaveBeenCalledWith(expect.anything(), s.whopPaymentId, undefined, `alert_refund_${s.whopPaymentId}`);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).alertRefundPendingAt).toBeNull();
  });

  it("never submits evidence for a dispute that is already closed", async () => {
    const { submitDueDisputeEvidence } = await import("@/lib/disputes");
    const store = await makeStore();
    await db.store.update({ where: { id: store.id }, data: { autoDisputeEvidence: true } });
    const s = await paidSession(store.id, { disputed: true, disputeId: `dp_closed_${Date.now()}`, disputeStatus: "won", trackingNumber: "6A1", disputeOpenedAt: new Date(Date.now() - 5 * 86400_000) });
    await submitDueDisputeEvidence(Date.now() + 10_000);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).disputeEvidenceTries).toBe(0);
  });

  it("alerts when two payments for one offer race, instead of losing one", async () => {
    const { markUpsellPaid } = await import("@/lib/upsell");
    const store = await makeStore();
    const s = await paidSession(store.id);
    const charge = await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "race", title: "Bonnet", variantId: "v", amountCents: 700, status: "PENDING" } });
    shopify.findOrderForSession.mockResolvedValue({ id: "gid://shopify/Order/88", name: "#1088" });
    shopify.priceCart.mockResolvedValue([]);
    await Promise.all([markUpsellPaid(charge.id, `pay_a_${s.id}`, store.id), markUpsellPaid(charge.id, `pay_b_${s.id}`, store.id)]);
    const row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row.status).toBe("PAID");
    expect(row.previousPaymentIds).toHaveLength(1);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "payment.duplicate" } })).toBe(1);
  });

  it("does not count a run out of time as a failed Shopify sync", async () => {
    const { DeadlineError } = await import("@/lib/deadline");
    const { syncOrderSafely } = await import("@/lib/checkout");
    const store = await makeStore();
    const s = await paidSession(store.id, { shopifyOrderId: null, shopifyOrderName: null });
    // What the Shopify client throws when the run's hard deadline is too close.
    shopify.findOrderForSession.mockRejectedValueOnce(new DeadlineError("Shopify orders"));
    await syncOrderSafely(s.id);
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.syncAttempts).toBe(0);
    expect(row.syncStartedAt).toBeNull();
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: { startsWith: "sync." } } })).toBe(0);
  });

  it("runs one maintenance at a time", async () => {
    const [a, b] = await Promise.all([runTick(), runTick()]);
    expect([a.skipped, b.skipped].filter(Boolean)).toHaveLength(1);
  });
});
