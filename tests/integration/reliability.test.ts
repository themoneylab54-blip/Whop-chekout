import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Reliability round 9 against a real Postgres: per-store webhook claims on a shared Whop
 * account, orders refunded / lost before their Shopify creation, backoff and give-up of
 * dispute tags and tracking pushes, the resumable dispute scan, the stale-tick alarm,
 * /api/health's down vs degraded split, refund aging, the spaced fallback probe and the
 * second duplicate-order guard.
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
  disputes: vi.fn(),
  retrieve: vi.fn(),
  refund: vi.fn(),
  shipment: vi.fn(),
  createConfig: vi.fn(),
  deleteConfig: vi.fn(),
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
  verifyWhopWebhook: (raw: string) => JSON.parse(raw),
  refundPayment: whop.refund,
  createCheckoutConfiguration: whop.createConfig,
  storeClient: (store: { id?: string }) => ({
    payments: {
      list: async () => ({ data: await whop.list(), response: { page_info: { has_next_page: false, end_cursor: null } } }),
      retrieve: whop.retrieve,
    },
    refunds: { list: async () => ({ data: await whop.refunds(), response: { page_info: { has_next_page: false, end_cursor: null } } }) },
    shipments: { create: whop.shipment },
    checkoutConfigurations: { delete: whop.deleteConfig },
    disputes: { update: vi.fn(), submit: vi.fn(), list: (req: Record<string, unknown>) => whop.disputes(store, req) },
  }),
}));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const flush = () => new Promise((r) => setTimeout(r, 80));
const emptyPage = { data: [], response: { page_info: { has_next_page: false, end_cursor: null } } };

describe.skipIf(!hasDb)("reliability round (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { runTick, warnIfTickStale, resetTickStaleCheck } = await import("@/lib/tick");
  const { encrypt } = await import("@/lib/crypto");
  const { POST: webhook } = await import("@/app/api/webhooks/whop/[storeId]/route");
  const created: string[] = [];
  const line = { variantId: "gid://shopify/ProductVariant/42", productId: "p", productHandle: "h", title: "Sweat", variantTitle: null, sku: null, imageUrl: null, quantity: 1, unitPriceCents: 5000, compareAtCents: null, inventory: null, requiresShipping: true };
  const rnd = () => Math.random().toString(36).slice(2);

  async function makeStore(extra: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `Rel ${rnd()}`,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_shared_rel",
        whopProductId: `prod_rel_${Date.now()}_${rnd()}`,
        whopApiKey: encrypt("k"),
        whopWebhookSecret: encrypt("s"),
        shopDomain: `rel-${Date.now()}-${rnd()}.myshopify.com`,
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
  const freshTick = async () => {
    const value = JSON.stringify({ at: new Date().toISOString() });
    await db.appSetting.upsert({ where: { key: "tick:report" }, create: { key: "tick:report", value }, update: { value } });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    notify.sendAlert.mockResolvedValue({ delivered: ["telegram"], failed: [] });
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.createPaidOrder.mockImplementation(async () => ({ id: `gid://shopify/Order/${Math.floor(Math.random() * 1e9)}`, name: "#2001" }));
    shopify.orderTracking.mockResolvedValue([]);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.priceCart.mockResolvedValue([]);
    shopify.createRefund.mockResolvedValue(undefined);
    shopify.orderRefundedCents.mockResolvedValue(0);
    whop.list.mockResolvedValue([]);
    whop.refunds.mockResolvedValue([]);
    whop.disputes.mockResolvedValue(emptyPage);
    whop.shipment.mockResolvedValue({});
    whop.deleteConfig.mockResolvedValue({});
    // Dispute scans of this file's stores are driven explicitly by the scan test.
    await db.appSetting.deleteMany({ where: { key: { startsWith: "dispute-scan-run:" }, OR: created.map((id) => ({ key: { contains: id } })) } });
  });

  afterAll(async () => {
    await db.eventLog.deleteMany({ where: { storeId: { in: created } } });
    await db.alertOutbox.deleteMany({ where: { storeId: { in: created } } });
    await db.refundRecord.deleteMany({ where: { storeId: { in: created } } });
    await db.webhookEvent.deleteMany({ where: { storeId: { in: created } } });
    await db.appSetting.deleteMany({ where: { OR: [...created.map((id) => ({ key: { contains: id } })), { key: "tick:stale-alert" }] } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    await freshTick();
  });

  /* 1. Per-store webhook claims ------------------------------------------------------ */

  it("claims the same webhook id per store: store B still applies its refund after store A saw the id", async () => {
    const a = await makeStore();
    const b = await makeStore();
    const s = await paidSession(b.id);
    const id = `wh_shared_${rnd()}`;
    const refund = { type: "refund.created", data: { id: `re_${rnd()}`, status: "succeeded", amount: 12, currency: "eur", payment: { id: s.whopPaymentId, metadata: { checkout_session_id: s.id } } } };
    const r1 = await post(a.id, id, refund);
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ ok: true });
    const r2 = await post(b.id, id, refund);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toEqual({ ok: true }); // not { duplicate: true }
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(1200);
    expect(await db.webhookEvent.count({ where: { id } })).toBe(2);
    // A real redelivery to B is still a duplicate for B.
    expect(await (await post(b.id, id, refund)).json()).toEqual({ ok: true, duplicate: true });
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).refundedCents).toBe(1200);
  });

  it("claims per store on the one-click offer path too", async () => {
    const a = await makeStore();
    const b = await makeStore();
    const s = await paidSession(b.id);
    const charge = await db.upsellCharge.create({ data: { sessionId: s.id, blockId: "wh", title: "Bonnet", variantId: "v", amountCents: 700, status: "PENDING" } });
    const id = `wh_offer_${rnd()}`;
    const evt = { type: "payment.succeeded", data: { id: `pay_o_${rnd()}`, metadata: { upsell_id: charge.id, checkout_session_id: s.id }, total: 7, currency: "eur" } };
    expect((await post(a.id, id, evt)).status).toBe(200);
    expect((await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } })).status).toBe("PENDING");
    const r = await post(b.id, id, evt);
    expect(await r.json()).toEqual({ ok: true });
    await flush();
    const row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row.status).toBe("PAID");
    expect(row.shopifyOrderId).not.toBeNull();
  });

  /* 2. Refunded / lost before the Shopify order ------------------------------------ */

  it("never creates a Shopify order for a session refunded in full before creation, and doesn't count it as pending", async () => {
    const { syncOrder } = await import("@/lib/checkout");
    const { backlog, storeHealth } = await import("@/lib/health");
    const a = await makeStore({ telegramChatId: "1", telegramBotToken: encrypt("x") });
    const s = await paidSession(a.id, { shopifyOrderId: null, shopifyOrderName: null, refundedCents: 5490, syncAttempts: 2, nextSyncAt: new Date(Date.now() - 1000) });
    expect(await syncOrder(s.id)).toBe(true);
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.syncHandledAt).not.toBeNull();
    expect(row.syncSkippedReason).toBe("refunded");
    expect(row.nextSyncAt).toBeNull();
    const evt = await db.eventLog.findFirstOrThrow({ where: { sessionId: s.id, kind: "sync.skipped" } });
    expect(evt.message).toContain("remboursée avant création : commande non créée dans Shopify");
    expect(alertsFor(a.id).length).toBeGreaterThanOrEqual(1);
    // Not pending anywhere: layout badge / "À traiter" / health tiles / gave-up counters.
    expect(await db.checkoutSession.count({ where: { storeId: a.id, status: "PAID", shopifyOrderId: null, syncHandledAt: null } })).toBe(0);
    const q = await backlog(a.id);
    expect(q.syncGaveUp).toBe(0);
    expect(q.reviewHolds).toBe(0);
    expect((await storeHealth(a.id)).find((h) => h.key === "sync")?.ok).toBe(true);
    // The tick's retry never picks it up again.
    await runTick();
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "sync.skipped" } })).toBe(1);
  });

  it("settles a gave-up order at once when the refund arrives, and skips a lost dispute", async () => {
    const { recordRefund, syncOrder } = await import("@/lib/checkout");
    const a = await makeStore();
    const gaveUp = await paidSession(a.id, { shopifyOrderId: null, shopifyOrderName: null, syncAttempts: 7, nextSyncAt: null, syncError: "Shopify 500" });
    await recordRefund(gaveUp.id, 5490, `re_full_${rnd()}`);
    let row = await db.checkoutSession.findUniqueOrThrow({ where: { id: gaveUp.id } });
    expect(row.syncSkippedReason).toBe("refunded");
    expect(row.lastRefundAt).not.toBeNull();
    // No "report the refund by hand on the hand-made order" for an order that doesn't exist.
    expect(await db.eventLog.count({ where: { sessionId: gaveUp.id, kind: "refund.manual_order" } })).toBe(0);

    // A partial refund doesn't stop the order.
    const partial = await paidSession(a.id, { shopifyOrderId: null, shopifyOrderName: null });
    await recordRefund(partial.id, 1000, `re_part_${rnd()}`);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: partial.id } })).syncHandledAt).toBeNull();

    // Lost chargeback before creation (webhook outcome).
    const lost = await paidSession(a.id, { shopifyOrderId: null, shopifyOrderName: null, reviewNote: "À vérifier : pays" });
    const res = await post(a.id, `wh_lost_${rnd()}`, { type: "dispute.updated", data: { id: `dp_${rnd()}`, status: "lost", payment: { id: lost.whopPaymentId }, amount: 54.9, currency: "eur" } });
    expect(res.status).toBe(200);
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: lost.id } });
    expect(row.syncSkippedReason).toBe("dispute_lost");
    await db.checkoutSession.update({ where: { id: lost.id }, data: { reviewNote: null } });
    await syncOrder(lost.id);
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
  });

  it("never creates the Shopify order of an offer refunded in full before creation", async () => {
    const { markUpsellPaid } = await import("@/lib/upsell");
    const a = await makeStore();
    const s = await paidSession(a.id);
    const charge = await db.upsellCharge.create({
      data: { sessionId: s.id, blockId: "rf", title: "Bonnet", variantId: "v", amountCents: 700, status: "PAID", whopPaymentId: `pay_o_${rnd()}`, refundedCents: 700, syncAttempts: 1, nextSyncAt: new Date() },
    });
    await markUpsellPaid(charge.id, charge.whopPaymentId!, a.id);
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    const row = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(row.syncSkippedReason).toBe("refunded");
    expect(row.syncHandledAt).not.toBeNull();
    const evt = await db.eventLog.findFirstOrThrow({ where: { sessionId: s.id, kind: "upsell.sync_skipped" } });
    expect(evt.message).toContain("remboursée avant création : commande non créée dans Shopify");
    expect((await (await import("@/lib/health")).backlog(a.id)).offersUnsynced).toBe(0);
  });

  /* 3. Sync retries count claims; dispute tags back off and give up ----------------- */

  it("counts only the syncs that took the lease", async () => {
    const { syncOrderSafely } = await import("@/lib/checkout");
    const a = await makeStore();
    const held = await paidSession(a.id, { shopifyOrderId: null, shopifyOrderName: null, syncStartedAt: new Date(), nextSyncAt: new Date(Date.now() - 1000) });
    expect(await syncOrderSafely(held.id)).toBe(false);
    const free = await paidSession(a.id, { shopifyOrderId: null, shopifyOrderName: null });
    expect(await syncOrderSafely(free.id)).toBe(true);
    expect(shopify.createPaidOrder).toHaveBeenCalledTimes(1);
  });

  it("backs off the dispute tag, then gives up loudly once, with a health counter and a manual retry", async () => {
    const { tagDisputedOrders, DISPUTE_TAG_MAX_ATTEMPTS } = await import("@/lib/disputes");
    const { backlog, gaveUpItems } = await import("@/lib/health");
    const { gaveUpItem } = await import("@/lib/maintenance");
    const a = await makeStore();
    const s = await paidSession(a.id, { disputed: true, disputeOpenedAt: new Date() });
    shopify.tagOrder.mockRejectedValue(new Error("Shopify 503"));
    await tagDisputedOrders(Date.now() + 10_000);
    let row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.disputeTagAttempts).toBe(1);
    expect(row.nextDisputeTagAt!.getTime()).toBeGreaterThan(Date.now());
    // Not due: not retried on the next tick.
    const mine = () => shopify.tagOrder.mock.calls.filter((c) => c[1] === s.shopifyOrderId).length;
    const before = mine();
    await tagDisputedOrders(Date.now() + 10_000);
    expect(mine()).toBe(before);
    for (let i = 1; i < DISPUTE_TAG_MAX_ATTEMPTS; i++) {
      await db.checkoutSession.update({ where: { id: s.id }, data: { nextDisputeTagAt: new Date(Date.now() - 1000) } });
      await tagDisputedOrders(Date.now() + 10_000);
    }
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.disputeTagAttempts).toBe(DISPUTE_TAG_MAX_ATTEMPTS);
    expect(row.disputeTagGaveUpAt).not.toBeNull();
    const gave = await db.eventLog.findMany({ where: { sessionId: s.id, kind: "dispute.tag_gave_up" } });
    expect(gave).toHaveLength(1);
    expect(gave[0].level).toBe("warn");
    expect(alertsFor(a.id).length).toBeGreaterThanOrEqual(1);
    expect((await backlog(a.id)).disputeTagsGaveUp).toBe(1);
    expect((await gaveUpItems(a.id)).some((it) => it.kind === "dispute_tag" && it.id === s.id)).toBe(true);
    // Given up: the tick leaves it alone.
    await tagDisputedOrders(Date.now() + 10_000);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "dispute.tag_gave_up" } })).toBe(1);
    // "Relancer": a fresh budget, and it succeeds.
    shopify.tagOrder.mockResolvedValue(undefined);
    expect(await gaveUpItem(a.id, "dispute_tag", s.id, false)).toBe(1);
    await tagDisputedOrders(Date.now() + 10_000);
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.disputeTaggedAt).not.toBeNull();
    expect((await backlog(a.id)).disputeTagsGaveUp).toBe(0);
  });

  /* 4. Resumable dispute scan ----------------------------------------------------------- */

  it("resumes a cut-short dispute scan from its cursor and only marks the scan after the last page", async () => {
    const { DeadlineError } = await import("@/lib/deadline");
    const a = await makeStore();
    const s = await paidSession(a.id);
    const pages: Record<string, unknown>[] = [];
    let cut = true;
    whop.disputes.mockImplementation(async (store: { id: string }, req: { after?: string }) => {
      if (store.id !== a.id) return emptyPage;
      pages.push(req);
      if (!req.after) return { data: [], response: { page_info: { has_next_page: true, end_cursor: "c1" } } };
      if (cut) throw new DeadlineError("litiges"); // the budget ran out on page 2
      return { data: [{ id: `dp_p2_${rnd()}`, status: "needs_response", payment: { id: s.whopPaymentId } }], response: { page_info: { has_next_page: false, end_cursor: null } } };
    });
    await runTick();
    expect(await db.appSetting.findUnique({ where: { key: `dispute-scan:${a.id}` } })).toBeNull();
    const run = await db.appSetting.findUniqueOrThrow({ where: { key: `dispute-scan-run:${a.id}` } });
    expect(JSON.parse(run.value).cursor).toBe("c1");
    // Next tick: resumes at page 2 (not from the start), completes, marks the scan.
    cut = false;
    pages.length = 0;
    await runTick();
    expect(pages).toHaveLength(1);
    expect(pages[0].after).toBe("c1");
    expect(await db.appSetting.findUnique({ where: { key: `dispute-scan:${a.id}` } })).not.toBeNull();
    expect(await db.appSetting.findUnique({ where: { key: `dispute-scan-run:${a.id}` } })).toBeNull();
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).disputed).toBe(true);
  });

  it("walks every page of a long dispute list (no 3-page cap)", async () => {
    const a = await makeStore();
    const s = await paidSession(a.id);
    let calls = 0;
    whop.disputes.mockImplementation(async (store: { id: string }, req: { after?: string }) => {
      if (store.id !== a.id) return emptyPage;
      calls++;
      const n = req.after ? Number(req.after) : 0;
      if (n < 5) return { data: [], response: { page_info: { has_next_page: true, end_cursor: String(n + 1) } } };
      return { data: [{ id: `dp_p6_${rnd()}`, status: "needs_response", payment: { id: s.whopPaymentId } }], response: { page_info: { has_next_page: false, end_cursor: null } } };
    });
    await runTick();
    expect(calls).toBe(6);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).disputed).toBe(true);
    expect(await db.appSetting.findUnique({ where: { key: `dispute-scan:${a.id}` } })).not.toBeNull();
  });

  /* 5. Tracking push failures ---------------------------------------------------------- */

  it("journals repeated tracking push failures from the 3rd, then gives up with a health counter", async () => {
    const { TRACKING_MAX_ATTEMPTS } = await import("@/lib/disputes");
    const { backlog } = await import("@/lib/health");
    const a = await makeStore();
    const s = await paidSession(a.id);
    shopify.orderTracking.mockImplementation(async (_store: unknown, orderId: string) => (orderId === s.shopifyOrderId ? [{ number: "TRK1", company: "Colissimo", url: null }] : []));
    whop.shipment.mockRejectedValue(new Error("Whop 500"));
    for (let i = 0; i < TRACKING_MAX_ATTEMPTS; i++) {
      await db.checkoutSession.update({ where: { id: s.id }, data: { trackingCheckedAt: null } });
      await runTick();
      const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
      expect(row.trackingPushAttempts).toBe(i + 1);
      if (i === 1) expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "tracking.push_failed" } })).toBe(0);
      if (i === 2) {
        expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "tracking.push_failed" } })).toBe(1);
        expect((await backlog(a.id)).trackingFailing).toBe(1);
      }
    }
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.trackingGaveUpAt).not.toBeNull();
    expect(row.trackingPushError).toContain("Whop 500");
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "tracking.gave_up", level: "error" } })).toBe(1);
    const q = await backlog(a.id);
    expect(q.trackingGaveUp).toBe(1);
    expect(q.trackingFailing).toBe(0);
    // Given up: no more tries.
    await db.checkoutSession.update({ where: { id: s.id }, data: { trackingCheckedAt: null } });
    const before = whop.shipment.mock.calls.length;
    await runTick();
    expect(whop.shipment.mock.calls.length).toBe(before);
  });

  /* 6. Observability --------------------------------------------------------------------- */

  it("alerts tick.stale (throttled) when a webhook arrives and the tick is stale while a store is live", async () => {
    const a = await makeStore({ enabled: true, shopifyConnectedAt: new Date(), telegramChatId: "1", telegramBotToken: encrypt("x") });
    const value = JSON.stringify({ at: new Date(Date.now() - 2 * 3600_000).toISOString() });
    await db.appSetting.upsert({ where: { key: "tick:report" }, create: { key: "tick:report", value }, update: { value } });
    await db.appSetting.deleteMany({ where: { key: "tick:stale-alert" } });
    resetTickStaleCheck();
    const res = await post(a.id, `wh_stale_${rnd()}`, { type: "payment.failed", data: { id: `pay_${rnd()}` } });
    expect(res.status).toBe(200);
    await flush();
    const evt = await db.eventLog.findFirstOrThrow({ where: { storeId: a.id, kind: "tick.stale" } });
    expect(evt.level).toBe("error");
    expect(evt.message).toContain("planificateur");
    expect(alertsFor(a.id).length).toBeGreaterThanOrEqual(1);
    // Throttled: once per 6 h across instances (a dashboard load right after doesn't alert again).
    resetTickStaleCheck();
    expect(await warnIfTickStale(a.id)).toBe(false);
    expect(await db.eventLog.count({ where: { storeId: a.id, kind: "tick.stale" } })).toBe(1);
    // Fresh tick: nothing to say.
    await freshTick();
    await db.appSetting.deleteMany({ where: { key: "tick:stale-alert" } });
    resetTickStaleCheck();
    expect(await warnIfTickStale(a.id)).toBe(false);
    await db.store.update({ where: { id: a.id }, data: { enabled: false } });
  });

  it("/api/health: 200 degraded for gave-up items awaiting a human, 503 down for a burst of bad signatures", async () => {
    const { GET } = await import("@/app/api/health/route");
    const a = await makeStore();
    await paidSession(a.id, { trackingGaveUpAt: new Date(), trackingPushAttempts: 6 });
    await freshTick();
    const res = await GET(new Request("http://x/api/health"), { params: Promise.resolve({}) } as never);
    const body = (await res.json()) as { ok: boolean; status: string; down: string[]; needsAction: string[]; trackingGaveUp: number };
    expect(body.down).toEqual([]);
    expect(res.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.ok).toBe(true);
    expect(body.trackingGaveUp).toBeGreaterThanOrEqual(1);
    expect(body.needsAction.join(" ")).toMatch(/tracking number\(s\) never pushed/);
    // Bad signatures burst: down (past the 10 s cache).
    await db.eventLog.createMany({ data: [1, 2, 3].map(() => ({ storeId: a.id, level: "error", kind: "webhook.bad_signature", message: "x" })) });
    const real = Date.now;
    const spy = vi.spyOn(Date, "now").mockImplementation(() => real() + 11_000);
    try {
      const down = await GET(new Request("http://x/api/health"), { params: Promise.resolve({}) } as never);
      expect(down.status).toBe(503);
      const b2 = (await down.json()) as { status: string; down: string[] };
      expect(b2.status).toBe("down");
      expect(b2.down.join(" ")).toMatch(/bad signature/);
    } finally {
      spy.mockRestore();
    }
    await db.eventLog.deleteMany({ where: { storeId: a.id, kind: "webhook.bad_signature" } });
  });

  it("ages unmirrored refunds by the refund's own time, not by unrelated row updates", async () => {
    const { backlog } = await import("@/lib/health");
    const a = await makeStore();
    const old = new Date(Date.now() - 2 * 3600_000);
    // Touched just now (tracking check, pixel retry…) but refunded 2 h ago: overdue.
    await paidSession(a.id, { refundedCents: 500, lastRefundAt: old });
    expect((await backlog(a.id)).refundsUnmirrored).toBe(1);
    // Refunded just now, on an old row: not overdue yet.
    const b = await makeStore();
    const s = await paidSession(b.id);
    await db.$executeRaw`UPDATE "CheckoutSession" SET "updatedAt" = ${old}, "refundedCents" = 500, "lastRefundAt" = now() WHERE id = ${s.id}`;
    expect((await backlog(b.id)).refundsUnmirrored).toBe(0);
  });

  /* 7. Fallback probe and the second duplicate guard -------------------------------------- */

  it("spaces the fallback probe (no Whop checkout per tick) and deletes the probe configuration", async () => {
    const { probeFallbacks, probeKey } = await import("@/lib/fallback");
    const a = await makeStore({ fallbackActiveAt: new Date(Date.now() - 10 * 60_000), fallbackReason: "test" });
    whop.createConfig.mockRejectedValue(new Error("Whop 503"));
    await probeFallbacks(Date.now() + 10_000);
    expect(whop.createConfig).toHaveBeenCalledTimes(1);
    // Next ticks within the spacing: no new checkout configuration.
    await probeFallbacks(Date.now() + 10_000);
    await probeFallbacks(Date.now() + 10_000);
    expect(whop.createConfig).toHaveBeenCalledTimes(1);
    const state = JSON.parse((await db.appSetting.findUniqueOrThrow({ where: { key: probeKey(a.id) } })).value);
    expect(state.failures).toBe(1);
    // Spacing elapsed: probed again; Whop answers, fallback cleared, probe config deleted.
    await db.appSetting.update({ where: { key: probeKey(a.id) }, data: { value: JSON.stringify({ at: Date.now() - 11 * 60_000, failures: 1 }) } });
    whop.createConfig.mockResolvedValue({ id: "ch_probe_1", purchaseUrl: null });
    expect(await probeFallbacks(Date.now() + 10_000)).toBeGreaterThanOrEqual(1);
    expect(whop.createConfig).toHaveBeenCalledTimes(2);
    expect(whop.deleteConfig).toHaveBeenCalledWith({ id: "ch_probe_1" });
    expect((await db.store.findUniqueOrThrow({ where: { id: a.id } })).fallbackActiveAt).toBeNull();
    expect(await db.appSetting.findUnique({ where: { key: probeKey(a.id) } })).toBeNull();
  });

  it("looks the order up by Whop payment after an ambiguous attempt before creating another", async () => {
    const { syncOrder } = await import("@/lib/checkout");
    const a = await makeStore();
    const clear = await paidSession(a.id, { shopifyOrderId: null, shopifyOrderName: null });
    await syncOrder(clear.id);
    expect(shopify.findOrderByPayment).not.toHaveBeenCalled(); // no ambiguity: tag lookup only
    vi.clearAllMocks();
    shopify.findOrderForSession.mockResolvedValue(null); // tag search still blind to it
    shopify.findOrderByPayment.mockResolvedValueOnce({ id: "gid://shopify/Order/777", name: "#1777" });
    const s = await paidSession(a.id, { shopifyOrderId: null, shopifyOrderName: null, syncAmbiguousAt: new Date(Date.now() - 6 * 60_000), syncAttempts: 1 });
    await syncOrder(s.id);
    expect(shopify.findOrderByPayment).toHaveBeenCalledWith(expect.anything(), { sessionId: s.id, paymentId: s.whopPaymentId });
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.shopifyOrderId).toBe("gid://shopify/Order/777");
    expect(row.syncAmbiguousAt).toBeNull();
  });
});
