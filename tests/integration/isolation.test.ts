import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Reliability round against a real Postgres: several stores sharing one Whop account
 * (account-wide webhooks and lists), webhook give-up, the alert outbox, hand-linked
 * orders and the manual recovery actions, fraud-alert refunds and the write-ahead
 * ambiguity guard of Shopify order creation.
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
  refunds: vi.fn(),
  refundRetrieve: vi.fn(),
  disputes: vi.fn(),
  retrieve: vi.fn(),
  refund: vi.fn(),
}));
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
    refunds: {
      list: async () => ({ data: await whop.refunds(), response: { page_info: { has_next_page: false, end_cursor: null } } }),
      retrieve: whop.refundRetrieve,
    },
    shipments: { create: vi.fn() },
    disputes: { update: vi.fn(), submit: vi.fn(), list: async () => ({ data: await whop.disputes(), response: { page_info: { has_next_page: false, end_cursor: null } } }) },
  }),
}));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const flush = () => new Promise((r) => setTimeout(r, 50));

describe.skipIf(!hasDb)("isolation and recovery (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { runTick } = await import("@/lib/tick");
  const { handleEvent, replayStaleEvents, GAVE_UP_ATTEMPTS, MAX_EVENT_AGE_MS } = await import("@/lib/webhooks");
  const { encrypt } = await import("@/lib/crypto");
  const { POST: webhook } = await import("@/app/api/webhooks/whop/[storeId]/route");
  const created: string[] = [];
  const line = { variantId: "gid://shopify/ProductVariant/42", productId: "p", productHandle: "h", title: "Sweat", variantTitle: null, sku: null, imageUrl: null, quantity: 1, unitPriceCents: 5000, compareAtCents: null, inventory: null, requiresShipping: true };
  const rnd = () => Math.random().toString(36).slice(2);

  async function makeStore(extra: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `Iso ${rnd()}`,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_shared",
        whopProductId: `prod_iso_${Date.now()}_${rnd()}`,
        whopApiKey: encrypt("k"),
        whopWebhookSecret: encrypt("s"),
        shopDomain: `iso-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        ...extra,
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
        whopPaymentId: `pay_${rnd()}`,
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
  const alertsFor = (storeId: string) => notify.sendAlert.mock.calls.filter((c) => c[0] === storeId);
  const kinds = async (storeId: string) => (await db.eventLog.findMany({ where: { storeId }, orderBy: { createdAt: "asc" } })).map((e) => `${e.level}:${e.kind}`);

  beforeEach(() => {
    vi.clearAllMocks();
    notify.sendAlert.mockResolvedValue({ delivered: ["telegram"], failed: [] });
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.orderTracking.mockResolvedValue([]);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.priceCart.mockResolvedValue([]);
    shopify.createRefund.mockResolvedValue(undefined);
    shopify.orderRefundedCents.mockResolvedValue(0);
    whop.list.mockResolvedValue([]);
    whop.refunds.mockResolvedValue([]);
    whop.disputes.mockResolvedValue([]);
  });

  afterAll(async () => {
    await db.eventLog.deleteMany({ where: { storeId: { in: created } } });
    await db.alertOutbox.deleteMany({ where: { storeId: { in: created } } });
    await db.refundRecord.deleteMany({ where: { storeId: { in: created } } });
    await db.webhookEvent.deleteMany({ where: { storeId: { in: created } } });
    await db.appSetting.deleteMany({ where: { OR: created.map((id) => ({ key: { contains: id } })) } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  /* Two stores on one Whop account ------------------------------------------------ */

  it("ignores another store's payment, refund and dispute quietly (200, info journal, no alert)", async () => {
    const a = await makeStore();
    const b = await makeStore();
    const s = await paidSession(b.id);
    const r1 = await post(a.id, `wh_${rnd()}`, { type: "payment.succeeded", data: { id: s.whopPaymentId, metadata: { checkout_session_id: s.id }, total: 54.9, currency: "eur" } });
    expect(r1.status).toBe(200);
    // Refund with the payment's metadata (webhook shape), then one with the product only.
    const refund = { id: `re_${rnd()}`, status: "succeeded", amount: 10, currency: "eur", payment: { id: s.whopPaymentId, metadata: { checkout_session_id: s.id } } };
    const r2 = await post(a.id, `wh_${rnd()}`, { type: "refund.created", data: refund });
    expect(r2.status).toBe(200);
    const r3 = await post(a.id, `wh_${rnd()}`, { type: "dispute.created", data: { id: `dp_${rnd()}`, payment: { id: `pay_unknown_${rnd()}`, product_id: b.whopProductId } } });
    expect(r3.status).toBe(200);
    await flush();
    expect(await kinds(a.id)).toEqual(["info:payment.other_store", "info:refund.other_store", "info:dispute.other_store"]);
    expect(alertsFor(a.id)).toHaveLength(0);
    expect(await db.alertOutbox.count({ where: { storeId: a.id } })).toBe(0);
    expect(whop.retrieve).not.toHaveBeenCalled();
    // The owner still applies it (A's pass wrote no shared marker).
    const r4 = await post(b.id, `wh_${rnd()}`, { type: "refund.created", data: refund });
    expect(r4.status).toBe(200);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(1000);
  });

  it("asks Whop when the event says too little, and treats a sibling store's product as not ours", async () => {
    const a = await makeStore();
    const b = await makeStore();
    whop.retrieve.mockResolvedValue({ id: "pay_x", metadata: {}, product_id: b.whopProductId });
    const res = await post(a.id, `wh_${rnd()}`, { type: "refund.created", data: { id: `re_${rnd()}`, status: "succeeded", amount: 5, currency: "eur", payment: { id: `pay_${rnd()}` } } });
    expect(res.status).toBe(200);
    expect(await kinds(a.id)).toEqual(["info:refund.other_store"]);
  });

  it("reconciles account-wide refund lists per store: no stall, no false alert, the owner applies it", async () => {
    const a = await makeStore();
    const b = await makeStore();
    const s = await paidSession(b.id);
    const old = new Date(Date.now() - 30 * 3600_000).toISOString();
    await db.appSetting.create({ data: { key: `refund-mark:${a.id}`, value: new Date(Date.now() - 31 * 3600_000).toISOString() } });
    // List shape: payment_id only. Created 30 h ago (previously: RetryLater, stall, then "unresolved").
    const r = { id: `re_list_${rnd()}`, payment_id: s.whopPaymentId, status: "succeeded", amount: { amount: "5.00", currency: "eur" }, created_at: old };
    whop.refunds.mockResolvedValue([r]);
    await runTick();
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(500);
    expect(await db.eventLog.count({ where: { storeId: a.id, kind: { in: ["refund.unresolved", "refund.early"] } } })).toBe(0);
    expect(alertsFor(a.id)).toHaveLength(0);
    const mark = await db.appSetting.findUniqueOrThrow({ where: { key: `refund-mark:${a.id}` } });
    expect(new Date(mark.value).getTime()).toBeGreaterThanOrEqual(new Date(old).getTime());
    expect((await db.webhookEvent.findFirstOrThrow({ where: { id: `refund:${r.id}` } })).storeId).toBe(b.id);
  });

  it("never lets a legacy 'not ours' marker under the shared refund key block the owner", async () => {
    const a = await makeStore();
    const b = await makeStore();
    const s = await paidSession(b.id);
    const refundId = `re_legacy_${rnd()}`;
    // Migration 0014 moves these to refund-skip:<store>:<id>; one left behind is harmless.
    await db.webhookEvent.create({ data: { id: `refund:${refundId}`, storeId: a.id, type: "refund.skipped", processedAt: new Date() } });
    await handleEvent("refund.created", { id: refundId, payment: { id: s.whopPaymentId }, status: "succeeded", amount: 5, currency: "eur" }, b.id);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(500);
    expect(await db.webhookEvent.count({ where: { storeId: b.id, id: `refund:${refundId}`, type: "refund" } })).toBe(1);
  });

  it("keeps watching a pending refund after the walk moved on, and applies it once it succeeds", async () => {
    const a = await makeStore();
    const s = await paidSession(a.id);
    const refundId = `re_pend_${rnd()}`;
    whop.refunds.mockResolvedValue([{ id: refundId, payment_id: s.whopPaymentId, status: "pending", amount: { amount: "3.00", currency: "eur" }, created_at: new Date().toISOString() }]);
    await runTick();
    const key = `refund-pending:${a.id}:${refundId}`;
    expect(await db.appSetting.count({ where: { key } })).toBe(1);
    // refund.updated is lost; the list no longer shows it (the mark moved past it).
    whop.refunds.mockResolvedValue([]);
    await db.appSetting.update({ where: { key }, data: { value: JSON.stringify({ createdAt: Date.now(), checkedAt: 0 }) } });
    whop.refundRetrieve.mockResolvedValue({ id: refundId, payment_id: s.whopPaymentId, status: "succeeded", amount: { amount: "3.00", currency: "eur" } });
    await runTick();
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(300);
    expect(await db.appSetting.count({ where: { key } })).toBe(0);
  });

  it("records disputes found already closed on the first scan without a 'dispute opened' alert", async () => {
    const a = await makeStore();
    const s = await paidSession(a.id);
    whop.disputes.mockResolvedValue([{ id: `dp_old_${rnd()}`, status: "won", payment: { id: s.whopPaymentId }, amount: 54.9, currency: "eur" }]);
    await runTick();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.disputed).toBe(true);
    expect(row.disputeStatus).toBe("won");
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "dispute.created" } })).toBe(0);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "reconcile.dispute_closed" } })).toBe(1);
    expect(alertsFor(a.id)).toHaveLength(0);
  });

  /* Webhook give-up ------------------------------------------------------------------ */

  it("never spends the local replay budget on Whop's redeliveries", async () => {
    const a = await makeStore();
    whop.retrieve.mockRejectedValue(Object.assign(new Error("Whop 500"), { statusCode: 500 }));
    const id = `wh_budget_${rnd()}`;
    const evt = { type: "refund.created", data: { id: `re_${rnd()}`, status: "succeeded", amount: 1, currency: "eur", payment: { id: `pay_${rnd()}` } } };
    for (let i = 0; i < 3; i++) expect((await post(a.id, id, evt)).status).toBe(503);
    const row = await db.webhookEvent.findFirstOrThrow({ where: { id } });
    expect(row.deliveries).toBe(3);
    expect(row.attempts).toBe(0);
    expect(row.nextAttemptAt).not.toBeNull();
    expect(await db.eventLog.count({ where: { storeId: a.id, kind: "webhook.gave_up" } })).toBe(0);
  });

  it("alerts once when an event gives up through Whop's redeliveries (72 h)", async () => {
    const a = await makeStore();
    whop.retrieve.mockRejectedValue(Object.assign(new Error("Whop 500"), { statusCode: 500 }));
    const id = `wh_old_${rnd()}`;
    const evt = { type: "refund.created", data: { id: `re_${rnd()}`, status: "succeeded", amount: 1, currency: "eur", payment: { id: `pay_${rnd()}` } } };
    const long = new Date(Date.now() - MAX_EVENT_AGE_MS - 3600_000);
    await db.webhookEvent.create({ data: { id, storeId: a.id, type: evt.type, payload: evt, firstReceivedAt: long, receivedAt: long, attempts: 2, lastError: "x" } });
    expect((await post(a.id, id, evt)).status).toBe(503);
    await flush();
    const row = await db.webhookEvent.findFirstOrThrow({ where: { id } });
    expect(row.attempts).toBe(GAVE_UP_ATTEMPTS);
    expect(row.nextAttemptAt).toBeNull();
    const gave = await db.eventLog.findMany({ where: { storeId: a.id, kind: "webhook.gave_up" } });
    expect(gave).toHaveLength(1);
    expect(gave[0].message).toContain("plus aucun essai automatique");
    expect(alertsFor(a.id).length).toBeGreaterThanOrEqual(1);
    // Later redeliveries don't alert again.
    await db.webhookEvent.updateMany({ where: { id }, data: { receivedAt: long } });
    await post(a.id, id, evt);
    expect(await db.eventLog.count({ where: { storeId: a.id, kind: "webhook.gave_up" } })).toBe(1);
    // A non-retryable failure that gave up doesn't claim "nouvel essai automatique".
    expect(await db.eventLog.count({ where: { storeId: a.id, kind: "webhook.failed" } })).toBe(0);
  });

  it("gives up after the local replay budget, loudly and once", async () => {
    const a = await makeStore();
    whop.retrieve.mockRejectedValue(Object.assign(new Error("Whop 500"), { statusCode: 500 }));
    const id = `wh_local_${rnd()}`;
    const evt = { type: "refund.created", data: { id: `re_${rnd()}`, status: "succeeded", amount: 1, currency: "eur", payment: { id: `pay_${rnd()}` } } };
    const stale = new Date(Date.now() - 3600_000);
    await db.webhookEvent.create({ data: { id, storeId: a.id, type: evt.type, payload: evt, receivedAt: stale, attempts: GAVE_UP_ATTEMPTS - 1, nextAttemptAt: stale, lastError: "x" } });
    await replayStaleEvents(Date.now() + 10_000);
    expect((await db.webhookEvent.findFirstOrThrow({ where: { id } })).attempts).toBe(GAVE_UP_ATTEMPTS);
    expect(await db.eventLog.count({ where: { storeId: a.id, kind: "webhook.gave_up" } })).toBe(1);
    await replayStaleEvents(Date.now() + 10_000);
    expect(await db.eventLog.count({ where: { storeId: a.id, kind: "webhook.gave_up" } })).toBe(1);
  });

  /* Alert outbox ------------------------------------------------------------------- */

  it("delivers a fresh alert even when the app clock runs ahead of the database's", async () => {
    const { recordEvent } = await import("@/lib/log");
    const a = await makeStore();
    const real = Date.now;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + 30_000);
    try {
      await recordEvent({ storeId: a.id, level: "error", kind: "sync.gave_up", message: "test skew", alert: true });
    } finally {
      spy.mockRestore();
    }
    const row = await db.alertOutbox.findFirstOrThrow({ where: { storeId: a.id } });
    expect(row.sentAt).not.toBeNull();
    expect(alertsFor(a.id)).toHaveLength(1);
  });

  it("reports a leased or sent alert as not claimed, and a failure as failed", async () => {
    const { deliverAlert } = await import("@/lib/log");
    const a = await makeStore();
    const leased = await db.alertOutbox.create({ data: { storeId: a.id, kind: "k", message: "m", nextAttemptAt: new Date(Date.now() + 120_000) } });
    expect(await deliverAlert(leased.id)).toBe("not_claimed");
    const sent = await db.alertOutbox.create({ data: { storeId: a.id, kind: "k", message: "m", sentAt: new Date(), nextAttemptAt: new Date(0) } });
    expect(await deliverAlert(sent.id)).toBe("not_claimed");
    expect(notify.sendAlert).not.toHaveBeenCalled();
    const due = await db.alertOutbox.create({ data: { storeId: a.id, kind: "k", message: "m", nextAttemptAt: new Date(0) } });
    notify.sendAlert.mockRejectedValueOnce(new Error("Telegram down"));
    expect(await deliverAlert(due.id)).toBe("failed");
    expect((await db.alertOutbox.findUniqueOrThrow({ where: { id: due.id } })).attempts).toBe(1);
    // Now leased by the failure's backoff: a concurrent run can't send it.
    expect(await deliverAlert(due.id)).toBe("not_claimed");
  });

  /* Fraud-alert refunds -------------------------------------------------------------- */

  it("persists a fraud-alert refund and retries it with backoff, journaling each try once", async () => {
    const { retryAlertRefunds } = await import("@/lib/disputes");
    const a = await makeStore({ autoRefundFraudAlerts: true });
    const s = await paidSession(a.id);
    whop.refund.mockRejectedValueOnce(new Error("Whop 502"));
    await handleEvent("dispute_alert.created", { id: `da_${rnd()}`, payment_id: s.whopPaymentId, type: "early_fraud_warning" }, a.id);
    let row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.alertRefundPendingAt).not.toBeNull();
    expect(row.alertRefundAttempts).toBe(1);
    expect(row.alertRefundNextAt!.getTime()).toBeGreaterThan(Date.now());
    // Not due yet: the tick neither calls Whop nor journals again.
    await db.checkoutSession.update({ where: { id: s.id }, data: { alertRefundPendingAt: new Date(Date.now() - 3 * 60_000) } });
    await retryAlertRefunds(Date.now() + 10_000);
    expect(whop.refund).toHaveBeenCalledTimes(1);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "dispute_alert.refund_retry" } })).toBe(1);
    // Due: refunded with the same idempotency key.
    whop.refund.mockResolvedValueOnce({});
    await db.checkoutSession.update({ where: { id: s.id }, data: { alertRefundNextAt: new Date(Date.now() - 1000) } });
    await retryAlertRefunds(Date.now() + 10_000);
    expect(whop.refund).toHaveBeenLastCalledWith(expect.anything(), s.whopPaymentId, undefined, `alert_refund_${s.whopPaymentId}`);
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.alertRefundPendingAt).toBeNull();
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "dispute_alert.refunded" } })).toBe(1);
  });

  /* Hand-linked orders and per-item recovery ----------------------------------------- */

  it("links an order by hand, never creates another one, and asks for refunds/disputes to be reported by hand", async () => {
    const { linkOrderByHand } = await import("@/lib/maintenance");
    const { syncOrder, recordRefund, recordDispute } = await import("@/lib/checkout");
    const { storeHealth } = await import("@/lib/health");
    const a = await makeStore();
    const s = await paidSession(a.id, { shopifyOrderId: null, shopifyOrderName: null, syncAttempts: 7, nextSyncAt: null, syncStartedAt: new Date() });
    // An automatic creation holds the lease: linking now could make two orders.
    expect(await linkOrderByHand(a.id, s.id, "1234")).toEqual({ ok: false, reason: "in_progress" });
    await db.checkoutSession.update({ where: { id: s.id }, data: { syncStartedAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await linkOrderByHand(a.id, s.id, "1234")).toEqual({ ok: true });
    await syncOrder(s.id);
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    expect((await storeHealth(a.id)).find((h) => h.key === "sync")?.ok).toBe(true);

    await recordRefund(s.id, 1250, `re_hand_${rnd()}`);
    const refundEvt = await db.eventLog.findFirstOrThrow({ where: { sessionId: s.id, kind: "refund.manual_order" } });
    expect(refundEvt.level).toBe("warn");
    expect(refundEvt.message).toContain("#1234");
    expect(refundEvt.message).toMatch(/12,50\s€/);
    expect(shopify.createRefund).not.toHaveBeenCalled();
    await recordDispute(s.id, `dp_hand_${rnd()}`);
    const disputeEvt = await db.eventLog.findFirstOrThrow({ where: { sessionId: s.id, kind: "dispute.manual_order" } });
    expect(disputeEvt.message).toContain("suivi");
    expect(alertsFor(a.id).length).toBeGreaterThanOrEqual(2);
  });

  it("retries one gave-up item without ever releasing a live lease", async () => {
    const { gaveUpItem, retryGaveUp } = await import("@/lib/maintenance");
    const { MAX_MIRROR_ATTEMPTS } = await import("@/lib/refunds");
    const a = await makeStore();
    const live = new Date();
    const gaveUp = await paidSession(a.id, { refundedCents: 500, refundMirrorAttempts: MAX_MIRROR_ATTEMPTS, refundMirrorStartedAt: live });
    const backingOff = await paidSession(a.id, { refundedCents: 500, refundMirrorAttempts: 2, nextRefundMirrorAt: new Date(Date.now() + 3600_000) });
    expect(await gaveUpItem(a.id, "refund", backingOff.id, false)).toBe(0);
    expect(await gaveUpItem(a.id, "refund", gaveUp.id, false)).toBe(1);
    let row = await db.checkoutSession.findUniqueOrThrow({ where: { id: gaveUp.id } });
    expect(row.refundMirrorAttempts).toBe(0);
    expect(row.refundMirrorStartedAt?.getTime()).toBe(live.getTime());

    const sync = await paidSession(a.id, { shopifyOrderId: null, syncAttempts: 7, nextSyncAt: null, syncStartedAt: live });
    expect(await gaveUpItem(a.id, "sync", sync.id, false)).toBe(1);
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: sync.id } });
    expect(row.syncStartedAt?.getTime()).toBe(live.getTime());
    expect(row.nextSyncAt).not.toBeNull();
    const staleSync = await paidSession(a.id, { shopifyOrderId: null, syncAttempts: 7, nextSyncAt: null, syncStartedAt: new Date(Date.now() - 10 * 60_000) });
    expect(await gaveUpItem(a.id, "sync", staleSync.id, false)).toBe(1);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: staleSync.id } })).syncStartedAt).toBeNull();

    // "Relancer tout" leaves items still in their backoff alone.
    await retryGaveUp(a.id);
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: backingOff.id } });
    expect(row.refundMirrorAttempts).toBe(2);
    expect(row.nextRefundMirrorAt!.getTime()).toBeGreaterThan(Date.now());

    // "Traité": the refund counts as reported.
    const handled = await paidSession(a.id, { refundedCents: 800, refundMirrorAttempts: MAX_MIRROR_ATTEMPTS });
    expect(await gaveUpItem(a.id, "refund", handled.id, true)).toBe(1);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: handled.id } })).refundMirroredCents).toBe(800);

    // A gave-up Whop event gets a fresh budget and a fresh 72 h window.
    const id = `wh_item_${rnd()}`;
    await db.webhookEvent.create({ data: { id, storeId: a.id, type: "x", attempts: GAVE_UP_ATTEMPTS, firstReceivedAt: new Date(0), deliveries: 9 } });
    expect(await gaveUpItem(a.id, "webhook", id, false)).toBe(1);
    const evt = await db.webhookEvent.findFirstOrThrow({ where: { id } });
    expect(evt.attempts).toBe(0);
    expect(evt.firstReceivedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("an offer marked handled is never created in Shopify", async () => {
    const { gaveUpItem } = await import("@/lib/maintenance");
    const { markUpsellPaid } = await import("@/lib/upsell");
    const a = await makeStore();
    const s = await paidSession(a.id);
    const charge = await db.upsellCharge.create({
      data: { sessionId: s.id, blockId: "b", title: "Bonnet", variantId: "v", amountCents: 700, status: "PAID", whopPaymentId: `pay_o_${rnd()}`, syncAttempts: 7 },
    });
    expect(await gaveUpItem(a.id, "offer_sync", charge.id, true)).toBe(1);
    await markUpsellPaid(charge.id, charge.whopPaymentId!, a.id);
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    expect(shopify.findOrderForSession).not.toHaveBeenCalled();
  });

  /* Ambiguous order creation --------------------------------------------------------- */

  it("marks an offer's order creation ambiguous before sending it, and waits before retrying", async () => {
    const { markUpsellPaid } = await import("@/lib/upsell");
    const { ShopifyError } = await import("@/lib/shopify");
    const a = await makeStore();
    const s = await paidSession(a.id);
    const charge = await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "amb", title: "Bonnet", variantId: "v", amountCents: 700, status: "PENDING" } });
    const payment = `pay_amb_${rnd()}`;
    let markedBefore = false;
    shopify.createPaidOrder.mockImplementationOnce(async () => {
      markedBefore = !!(await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).syncAmbiguousAt;
      throw new ShopifyError("Shopify injoignable : timeout");
    });
    await markUpsellPaid(charge.id, payment, a.id);
    expect(markedBefore).toBe(true);
    let row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row.syncAmbiguousAt).not.toBeNull();
    expect(row.nextSyncAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + 4 * 60_000);
    // Retried at once (manual retry, tick): refused until Shopify's search can see the order.
    await markUpsellPaid(charge.id, payment, a.id);
    expect(shopify.createPaidOrder).toHaveBeenCalledTimes(1);
    expect(shopify.findOrderForSession).toHaveBeenCalledTimes(1);
    // Past the wait: the lookup finds the order the timed-out call created.
    await db.upsellCharge.update({ where: { id: charge.id }, data: { syncAmbiguousAt: new Date(Date.now() - 6 * 60_000) } });
    shopify.findOrderForSession.mockResolvedValueOnce({ id: "gid://shopify/Order/555", name: "#1555" });
    await markUpsellPaid(charge.id, payment, a.id);
    row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row.shopifyOrderId).toBe("gid://shopify/Order/555");
    expect(row.syncAmbiguousAt).toBeNull();
    expect(shopify.createPaidOrder).toHaveBeenCalledTimes(1);
  });

  it("clears the ambiguity mark on a definite Shopify refusal (sessions and offers)", async () => {
    const { syncOrderSafely } = await import("@/lib/checkout");
    const { ShopifyError } = await import("@/lib/shopify");
    const a = await makeStore();
    const s = await paidSession(a.id, { shopifyOrderId: null, shopifyOrderName: null });
    let markedBefore = false;
    shopify.createPaidOrder.mockImplementationOnce(async () => {
      markedBefore = !!(await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).syncAmbiguousAt;
      throw new ShopifyError("Création de la commande: email invalide");
    });
    await syncOrderSafely(s.id);
    expect(markedBefore).toBe(true);
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.syncAmbiguousAt).toBeNull();
    expect(row.syncAttempts).toBe(1);
  });

  it("tags a disputed order from the tick when the deferred tagging was lost", async () => {
    const { recordDispute } = await import("@/lib/checkout");
    const a = await makeStore();
    const s = await paidSession(a.id);
    shopify.tagOrder.mockRejectedValueOnce(new Error("Shopify 503"));
    await recordDispute(s.id, `dp_tag_${rnd()}`);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).disputeTaggedAt).toBeNull();
    await runTick();
    expect(shopify.tagOrder).toHaveBeenLastCalledWith(expect.anything(), s.shopifyOrderId, ["litige-whop"]);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).disputeTaggedAt).not.toBeNull();
  });

  /* Health and job order ------------------------------------------------------------- */

  it("answers 503 when a live store has no recent tick, whatever CRON_SECRET says", async () => {
    const { GET } = await import("@/app/api/health/route");
    const { storeHealth } = await import("@/lib/health");
    const a = await makeStore({ enabled: true, shopifyConnectedAt: new Date() });
    const value = JSON.stringify({ at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    await db.appSetting.upsert({ where: { key: "tick:report" }, create: { key: "tick:report", value }, update: { value } });
    const saved = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await GET(new Request("http://x/api/health"), { params: Promise.resolve({}) } as never);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { reasons: string[] };
      expect(body.reasons.join(" ")).toMatch(/tick last ran \d+ min ago/);
    } finally {
      if (saved !== undefined) process.env.CRON_SECRET = saved;
    }
    const tile = (await storeHealth(a.id)).find((h) => h.key === "tick")!;
    expect(tile.ok).toBe(false);
    expect(tile.detail).toContain("planificateur");
    await db.store.update({ where: { id: a.id }, data: { enabled: false } });
  });

  it("runs the money jobs before the analytics ones", async () => {
    const report = await runTick();
    const order = Object.keys(report);
    for (const money of ["reconciled", "refundsReconciled", "disputesReconciled", "alertRefunds", "disputesTagged", "trackingPushed", "disputeEvidence"])
      for (const analytics of ["experiments", "adSpend", "anomalies", "stopLoss", "dailyReport"]) expect(order.indexOf(money)).toBeLessThan(order.indexOf(analytics));
  });
});
