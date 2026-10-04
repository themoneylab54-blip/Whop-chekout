import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/*
 * Stripe money flow (phase 3) against a real Postgres: the Connect webhook (signature → markPaid →
 * Shopify order with the Stripe gateway), duplicate PaymentIntents, the stale-failure rule, refunds
 * (dashboard → refundStripe, charge.refunded → counted once, mirrored), disputes (tag, evidence,
 * outcome), one-click offers off session (paid, authentication_required), the reconciliation of a
 * missed payment, fees in the margin, and the replay of a failed Stripe event. Stripe's and Shopify's
 * APIs are mocked; webhook signatures are real. Test data: sm_.
 */

const stripeApi = vi.hoisted(() => ({
  retrievePaymentIntent: vi.fn(),
  refundStripe: vi.fn(),
  listChargeRefunds: vi.fn(),
  submitStripeDispute: vi.fn(),
  chargeOffSession: vi.fn(),
  listStripeEvents: vi.fn(),
  retrieveStripeEvent: vi.fn(),
}));
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
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendTelegram: vi.fn() }));
const afters = vi.hoisted(() => [] as (() => unknown)[]);

class Redirect extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afters.push(fn);
  },
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), requireAdmin: async () => "admin", currentAdminId: async () => "admin", currentUser: async () => (await import("../session-stub")).ownerUser() }));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), ...stripeApi }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const APP = "https://checkout.example.com";
const WEBHOOK_SECRET = "whsec_sm_integration_secret";

describe.skipIf(!hasDb)("Stripe money flow (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { buildOrderCreateInput } = await import("@/lib/shopify");
  const webhookRoute = await import("@/app/api/webhooks/stripe/route");
  const { handleStripeEvent, reconcileStripe } = await import("@/lib/stripe-webhooks");
  const { replayStaleEvents, STALE_CLAIM_MS } = await import("@/lib/webhooks");
  const { acceptUpsell, UpsellError } = await import("@/lib/upsell");
  const actions = await import("@/app/dashboard/actions");
  const { feeCents } = await import("@/lib/charge");
  const { marginContext, storeFeeRate } = await import("@/lib/conversions");
  const { syncOrderSafely } = await import("@/lib/checkout");

  const created: string[] = [];
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const ctx = { params: Promise.resolve({}) };
  const saved: Record<string, string | undefined> = {};
  const line = { variantId: "gid://shopify/ProductVariant/42", productId: "p", productHandle: "sweat", title: "Sweat", variantTitle: null, sku: null, imageUrl: null, quantity: 1, unitPriceCents: 5000, compareAtCents: null, inventory: null, requiresShipping: true };
  const address = { firstName: "Ana", lastName: "Bel", address1: "1 rue", city: "Paris", zip: "75001", countryCode: "FR" };
  /** PaymentIntents Stripe "holds" (retrievePaymentIntent answers from here). */
  const pis = new Map<string, Stripe.PaymentIntent>();

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `sm_${rnd()}`,
        enabled: true,
        testMode: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_sm",
        whopProductId: `prod_sm_${rnd()}`,
        whopApiKey: encrypt("k"),
        shopDomain: `sm-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        stripeAccountId: `acct_sm_${rnd()}`,
        stripeConnectedAt: new Date(),
        stripeLivemode: false,
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  /** A checkout whose Stripe PaymentIntent was created for its quote (what prepareSession writes). */
  async function makeSession(storeId: string, extra: Record<string, unknown> = {}) {
    const s = await db.checkoutSession.create({
      data: { storeId, currency: "EUR", lines: [line], subtotalCents: 5000, totalCents: 5490, email: "buyer@example.com", shippingAddress: address, paymentProvider: "stripe", ...extra },
    });
    const piId = `pi_sm_${rnd()}`;
    await db.checkoutQuote.create({
      data: {
        sessionId: s.id,
        whopCheckoutId: `strpq_${s.id}_${rnd()}`,
        provider: "stripe",
        stripePaymentIntentId: piId,
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
    await db.checkoutSession.update({ where: { id: s.id }, data: { stripePaymentIntentId: piId } });
    return { session: s, piId };
  }

  function paymentIntent(id: string, meta: Record<string, string>, extra: Partial<Stripe.PaymentIntent> = {}): Stripe.PaymentIntent {
    const pi = {
      id,
      object: "payment_intent",
      amount: 5490,
      amount_received: 5490,
      currency: "eur",
      status: "succeeded",
      created: Math.floor(Date.now() / 1000),
      customer: "cus_sm",
      payment_method: "pm_sm",
      // Card saved for one-click offers (what prepare asks when the thank-you page has offers).
      setup_future_usage: "off_session",
      metadata: meta,
      receipt_email: "buyer@example.com",
      shipping: null,
      last_payment_error: null,
      latest_charge: {
        id: `ch_${id}`,
        object: "charge",
        amount: 5490,
        currency: "eur",
        payment_method: "pm_sm",
        payment_method_details: { type: "card", card: { wallet: null } },
        billing_details: { email: "buyer@example.com", address: null, name: null, phone: null },
        balance_transaction: { id: `txn_${id}`, object: "balance_transaction", currency: "eur", fee: 180, exchange_rate: null },
        shipping: null,
        receipt_email: null,
      },
      ...extra,
    } as unknown as Stripe.PaymentIntent;
    pis.set(id, pi);
    return pi;
  }

  function event(type: string, account: string, object: unknown, extra: Record<string, unknown> = {}): Stripe.Event {
    return { id: `evt_sm_${rnd()}`, object: "event", type, account, livemode: false, created: Math.floor(Date.now() / 1000), api_version: Stripe.API_VERSION, data: { object }, ...extra } as unknown as Stripe.Event;
  }

  function signed(evt: Stripe.Event) {
    const payload = JSON.stringify(evt);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    return new Request(`${APP}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
  }

  async function post(evt: Stripe.Event) {
    const res = await webhookRoute.POST(signed(evt), ctx);
    // The follow-ups the route leaves for after the answer (Shopify order, mirrors…).
    while (afters.length) await afters.shift()!();
    return res;
  }

  /** Handles a payment_intent.succeeded the way the route does (order created right after). */
  async function pay(store: Awaited<ReturnType<typeof makeStore>>, sessionId: string, piId: string) {
    const syncId = await handleStripeEvent(event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(piId, { checkout_session_id: sessionId, store_id: store.id })), store);
    if (syncId) await syncOrderSafely(syncId);
  }

  async function flashOf(run: () => Promise<unknown>): Promise<{ ok?: string; error?: string }> {
    try {
      await run();
    } catch (err) {
      if (!(err instanceof Redirect)) throw err;
      const q = new URL(err.url, "http://x").searchParams;
      return { ok: q.get("ok") ?? undefined, error: q.get("error") ?? undefined };
    }
    throw new Error("no redirect");
  }

  beforeAll(() => {
    for (const [k, v] of Object.entries({ STRIPE_TEST_SECRET_KEY: "sk_test_sm", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_sm", STRIPE_TEST_CLIENT_ID: "ca_test_sm", STRIPE_TEST_WEBHOOK_SECRET: WEBHOOK_SECRET })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    afters.length = 0;
    stripeApi.retrievePaymentIntent.mockImplementation(async (_s: unknown, id: string) => {
      const pi = pis.get(id);
      if (!pi) throw Object.assign(new Error("No such payment_intent"), { statusCode: 404 });
      return pi;
    });
    stripeApi.listStripeEvents.mockResolvedValue({ data: [], hasMore: false });
    stripeApi.submitStripeDispute.mockResolvedValue({ id: "du_x" });
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.orderTracking.mockResolvedValue([]);
    shopify.createRefund.mockResolvedValue(undefined);
    shopify.orderRefundedCents.mockImplementation(async (_st: unknown, orderId: string) =>
      shopify.createRefund.mock.calls.filter((c) => c[1] === orderId).reduce((sum, c) => sum + Number(c[2]), 0),
    );
    shopify.createPaidOrder.mockImplementation(async (_st: unknown, input: { sessionId: string }) => ({ id: `gid://shopify/Order/${input.sessionId}`, name: `#${input.sessionId.slice(-4)}` }));
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await db.refundRecord.deleteMany({ where: { storeId: { in: created } } });
    await db.webhookEvent.deleteMany({ where: { storeId: { in: created } } });
    await db.appSetting.deleteMany({ where: { OR: created.flatMap((id) => [{ key: `stripe-reconcile:${id}` }, { key: `stripe-reconcile-run:${id}` }]) } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    await db.$disconnect();
  });

  it("payment_intent.succeeded (signed webhook) → markPaid → a Shopify order with the Stripe gateway and tags", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id);
    const pi = paymentIntent(piId, { checkout_session_id: session.id, store_id: store.id });
    const evt = event("payment_intent.succeeded", store.stripeAccountId!, { ...pi, latest_charge: `ch_${piId}` });
    const res = await post(evt);
    expect(res.status).toBe(200);

    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row).toMatchObject({
      status: "PAID",
      paymentProvider: "stripe",
      whopPaymentId: piId,
      stripePaymentIntentId: piId,
      stripeCustomerId: "cus_sm",
      stripePaymentMethodId: "pm_sm",
      providerFeeCents: 180,
      whopFeeCents: null,
      paymentMethodType: "card",
      reviewNote: null,
    });
    expect(feeCents(row)).toBe(180);
    expect(stripeApi.retrievePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), piId);
    // The order was created after the answer, through the Stripe gateway.
    expect(row.shopifyOrderId ?? (await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).shopifyOrderId).toBeTruthy();
    const mainCall = shopify.createPaidOrder.mock.calls.find((c) => c[1].sessionId === session.id)!;
    const input = mainCall[1];
    expect(input.provider).toBe("stripe");
    // The checkout's own order keeps Shopify's confirmation (default options).
    expect(mainCall[2]).toBeUndefined();
    const order = buildOrderCreateInput(input) as { transactions: { gateway: string; authorizationCode: string }[]; tags: string[]; note: string };
    expect(order.transactions[0]).toMatchObject({ gateway: "Stripe", authorizationCode: piId });
    expect(order.tags).toEqual(expect.arrayContaining(["whop-checkout", "stripe-checkout", `wp-${piId}`]));
    expect(order.note).toContain(`Payé via Stripe — paiement ${piId}`);
    const ev = await db.eventLog.findFirst({ where: { sessionId: session.id, kind: "payment.succeeded" } });
    expect(ev?.message).toMatch(/Paiement Stripe pi_sm_/);

    // A redelivery is a duplicate: nothing recorded twice.
    expect((await post(evt)).status).toBe(200);
    expect(shopify.createPaidOrder.mock.calls.filter((c) => c[1].sessionId === session.id)).toHaveLength(1);
  });

  it("a second PaymentIntent for a paid cart is flagged as a duplicate (stripe:pi_…), never a second order", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id);
    await handleStripeEvent(event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(piId, { checkout_session_id: session.id, store_id: store.id })), store);
    const other = paymentIntent(`pi_sm_dup_${rnd()}`, { checkout_session_id: session.id, store_id: store.id });
    await handleStripeEvent(event("payment_intent.succeeded", store.stripeAccountId!, other), store);
    await handleStripeEvent(event("payment_intent.succeeded", store.stripeAccountId!, other), store);
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.whopPaymentId).toBe(piId);
    expect(row.extraPaymentIds).toEqual([`stripe:${other.id}`]);
    const dup = await db.eventLog.findMany({ where: { sessionId: session.id, kind: "payment.duplicate" } });
    expect(dup).toHaveLength(1);
    expect(dup[0].message).toMatch(/à rembourser dans Stripe/);

    // Its refund is recognised as the duplicate's (nothing to mirror in Shopify).
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, { id: `re_dup_${rnd()}`, object: "refund", status: "succeeded", amount: 5490, currency: "eur", payment_intent: other.id }), store);
    expect(await db.eventLog.count({ where: { sessionId: session.id, kind: "refund.extra_payment" } })).toBe(1);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).refundedCents).toBe(0);
  });

  it("payment_intent.payment_failed: an earlier attempt's failure never marks a newer attempt FAILED", async () => {
    const store = await makeStore();
    const now = Date.now();
    const { session, piId } = await makeSession(store.id, { status: "PAYING", payClickedAt: new Date(now) });
    const failed = paymentIntent(piId, { checkout_session_id: session.id, store_id: store.id }, { status: "requires_payment_method", last_payment_error: { message: "Your card was declined.", payment_method: { type: "card" } } as Stripe.PaymentIntent.LastPaymentError });
    // Failure of an attempt made a minute before the latest "Pay" click: stale.
    await handleStripeEvent(event("payment_intent.payment_failed", store.stripeAccountId!, failed, { created: Math.floor((now - 60_000) / 1000) }), store);
    let row = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe("PAYING");
    expect(row.paymentFailedAt).toBeInstanceOf(Date);
    expect((await db.eventLog.findFirst({ where: { sessionId: session.id, kind: "payment.failed" } }))?.message).toMatch(/tentative antérieure/);
    // The current attempt's own failure (after the click): FAILED.
    await handleStripeEvent(event("payment_intent.payment_failed", store.stripeAccountId!, failed, { created: Math.floor((now + 2000) / 1000) }), store);
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.status).toBe("FAILED");
    expect((await db.eventLog.findMany({ where: { sessionId: session.id, kind: "payment.failed" }, orderBy: { createdAt: "desc" } }))[0].message).toBe("Paiement refusé : Your card was declined. (card)");
  });

  it("refund from the dashboard goes to Stripe; charge.refunded is counted once (RefundRecord stripe) and mirrored", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id);
    await pay(store, session.id, piId);
    const paid = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(paid.shopifyOrderId).toBeTruthy();

    stripeApi.refundStripe.mockResolvedValue({ id: "re_x", status: "succeeded" });
    // Refunded in the payment's mode (a test payment: session.test), even after the store went live.
    expect(paid.test).toBe(true);
    await db.store.update({ where: { id: store.id }, data: { testMode: false } });
    const fd = new FormData();
    fd.set("amount", "10,00");
    fd.set("nonce", "n1");
    const flash = await flashOf(() => actions.refundOrderAction(store.id, session.id, fd));
    await db.store.update({ where: { id: store.id }, data: { testMode: true } });
    expect(flash.ok).toMatch(/demandé à Stripe/);
    expect(stripeApi.refundStripe).toHaveBeenCalledWith(expect.objectContaining({ id: store.id, testMode: true }), piId, 1000, `refund_${session.id}_n1`, "EUR");

    // Stripe's webhook for it (the charge's refunds listed from Stripe).
    const refundId = `re_sm_${rnd()}`;
    stripeApi.listChargeRefunds.mockResolvedValue([{ id: refundId, object: "refund", status: "succeeded", amount: 1000, currency: "eur", payment_intent: piId }]);
    const evt = event("charge.refunded", store.stripeAccountId!, { id: `ch_${piId}`, object: "charge", payment_intent: piId, amount: 5490, amount_refunded: 1000, currency: "eur" });
    expect((await post(evt)).status).toBe(200);
    const rec = await db.refundRecord.findUniqueOrThrow({ where: { id: `stripe:${refundId}` } });
    expect(rec).toMatchObject({ provider: "stripe", amountCents: 1000, sessionId: session.id });
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).refundedCents).toBe(1000);
    expect(shopify.createRefund).toHaveBeenCalledWith(expect.anything(), paid.shopifyOrderId, 1000, "Remboursé via Stripe", [], { provider: "stripe" });
    // The same refund again (charge.refund.updated): never counted twice.
    await post(event("charge.refund.updated", store.stripeAccountId!, { id: refundId, object: "refund", status: "succeeded", amount: 1000, currency: "eur", payment_intent: piId }));
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).refundedCents).toBe(1000);
    expect(shopify.createRefund).toHaveBeenCalledTimes(1);
  });

  it("a refund arriving before its payment is recorded asks Stripe to retry (503), kept for the replay", async () => {
    const store = await makeStore();
    const { piId } = await makeSession(store.id);
    const evt = event("charge.refund.updated", store.stripeAccountId!, { id: `re_early_${rnd()}`, object: "refund", status: "succeeded", amount: 100, currency: "eur", payment_intent: piId });
    const res = await post(evt);
    expect(res.status).toBe(503);
    const row = await db.webhookEvent.findUniqueOrThrow({ where: { storeId_id: { storeId: store.id, id: `stripe:${evt.id}` } } });
    expect(row.processedAt).toBeNull();
    expect(row.lastError).toMatch(/pas encore enregistré/);
  });

  it("charge.dispute.created → dispute recorded, litige-stripe tag, evidence submitted to Stripe; closed lost → outcome", async () => {
    const store = await makeStore({ autoDisputeEvidence: true });
    const { session, piId } = await makeSession(store.id, { clientIp: "203.0.113.9" });
    await pay(store, session.id, piId);
    await db.checkoutSession.update({ where: { id: session.id }, data: { trackingNumber: "TRK123" } });
    shopify.orderTracking.mockResolvedValue([{ number: "TRK123", company: "Colissimo", url: null }]);
    const due = Math.floor(Date.now() / 1000) + 7 * 86400;
    const dispute = { id: `du_sm_${rnd()}`, object: "dispute", amount: 5490, currency: "eur", status: "needs_response", payment_intent: piId, charge: `ch_${piId}`, evidence_details: { due_by: due } };
    await handleStripeEvent(event("charge.dispute.created", store.stripeAccountId!, dispute), store);
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row).toMatchObject({ disputed: true, disputeId: dispute.id });
    expect(row.disputeDueAt?.getTime()).toBe(due * 1000);
    expect(row.disputeEvidenceAt).toBeInstanceOf(Date);
    expect(shopify.tagOrder).toHaveBeenCalledWith(expect.anything(), row.shopifyOrderId, ["litige-stripe"]);
    expect(stripeApi.submitStripeDispute).toHaveBeenCalledTimes(1);
    const [, disputeId, evidence] = stripeApi.submitStripeDispute.mock.calls[0];
    expect(disputeId).toBe(dispute.id);
    expect(evidence).toMatchObject({ customer_email_address: "buyer@example.com", customer_name: "Ana Bel", shipping_tracking_number: "TRK123", shipping_carrier: "Colissimo", customer_purchase_ip: "203.0.113.9" });
    expect(evidence.uncategorized_text).toContain(piId);
    expect(evidence.product_description).toContain("Sweat");

    await handleStripeEvent(event("charge.dispute.closed", store.stripeAccountId!, { ...dispute, status: "lost" }), store);
    const after = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(after).toMatchObject({ disputeStatus: "lost", disputeLostCents: 5490 });
    expect(await db.eventLog.count({ where: { sessionId: session.id, kind: "dispute.lost" } })).toBe(1);
  });

  describe("one-click offer off session", () => {
    const layout = {
      blocks: [{ id: "up1", type: "upsell", props: { badge: "", title: "Chaussettes", text: "", variantId: "77", imageUrl: "", price: 9.9, compareAt: 0, buttonText: "Oui", declineText: "Non" } }],
    };

    async function paidSession() {
      const store = await makeStore({ thankYouLayout: layout });
      const { session, piId } = await makeSession(store.id);
      await pay(store, session.id, piId);
      shopify.priceCart.mockResolvedValue([{ ...line, variantId: "gid://shopify/ProductVariant/77", title: "Chaussettes" }]);
      return { store, full: await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id }, include: { store: true } }) };
    }

    it("charges the saved payment method (confirm + off_session) once and creates the offer's order", async () => {
      const { store, full } = await paidSession();
      stripeApi.chargeOffSession.mockImplementation(async (_s: unknown, c: { metadata: Record<string, string> }) => paymentIntent(`pi_sm_up_${rnd()}`, c.metadata, { amount: 990, amount_received: 990 }));
      const first = await acceptUpsell(full, "up1");
      const second = await acceptUpsell(full, "up1");
      expect(first.status).toBe("paid");
      expect(second.status).toBe("paid");
      expect(stripeApi.chargeOffSession).toHaveBeenCalledTimes(1);
      const [scoped, c] = stripeApi.chargeOffSession.mock.calls[0];
      const charge = await db.upsellCharge.findFirstOrThrow({ where: { sessionId: full.id } });
      // This deployment's host (the other deployments' webhooks ignore it), in the checkout payment's mode.
      expect(c).toMatchObject({
        amountCents: 990,
        currency: "EUR",
        customer: "cus_sm",
        paymentMethod: "pm_sm",
        idempotencyKey: `upsell_${charge.id}_0`,
        metadata: { upsell_charge_id: charge.id, checkout_session_id: full.id, store_id: store.id, app_host: "checkout.example.com" },
      });
      expect(full.test).toBe(true);
      expect(scoped).toMatchObject({ id: store.id, testMode: true });
      expect(charge).toMatchObject({ status: "PAID", provider: "stripe", whopFeeCents: 180 });
      expect(charge.whopPaymentId).toMatch(/^pi_sm_up_/);
      const call = shopify.createPaidOrder.mock.calls.find((x) => x[1].sessionId === `upsell-${charge.id}`)!;
      const input = call[1];
      expect(input.provider).toBe("stripe");
      expect(input.test).toBe(true);
      // A separate offer order is a separate charge: Shopify's confirmation is sent (default options).
      expect(call[2]?.sendReceipt ?? true).toBe(true);
    });

    it("authentication_required (3-D Secure asked): the offer fails gracefully, nothing charged, buyer told", async () => {
      const { full } = await paidSession();
      stripeApi.chargeOffSession.mockRejectedValue(
        Object.assign(new Error("This payment requires authentication."), { type: "StripeCardError", code: "authentication_required", statusCode: 402, payment_intent: { id: "pi_sm_sca" } }),
      );
      const err = await acceptUpsell(full, "up1").catch((e) => e);
      expect(err).toBeInstanceOf(UpsellError);
      expect(err.code).toBe("upsell_authentication_required");
      const charge = await db.upsellCharge.findFirstOrThrow({ where: { sessionId: full.id } });
      expect(charge).toMatchObject({ status: "FAILED", whopPaymentId: "pi_sm_sca", provider: "stripe" });
      expect(await db.eventLog.count({ where: { sessionId: full.id, kind: "upsell.authentication_required" } })).toBe(1);
      expect(shopify.createPaidOrder.mock.calls.some((x) => x[1].sessionId === `upsell-${charge.id}`)).toBe(false);
    });
  });

  it("stripeReconciled: a payment whose webhook never came is marked paid (once), journaled", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id);
    const evt = event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(piId, { checkout_session_id: session.id, store_id: store.id }));
    stripeApi.listStripeEvents.mockImplementation(async (s: { id: string }) => (s.id === store.id ? { data: [evt], hasMore: false } : { data: [], hasMore: false }));
    await reconcileStripe(Date.now() + 20_000);
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row).toMatchObject({ status: "PAID", whopPaymentId: piId, paymentProvider: "stripe" });
    expect(row.shopifyOrderId).toBeTruthy();
    expect(await db.eventLog.count({ where: { sessionId: session.id, kind: "reconcile.healed" } })).toBe(1);
    expect(await db.appSetting.findUnique({ where: { key: `stripe-reconcile:${store.id}` } })).not.toBeNull();
    // Next walk: the event is known (no second handling, no Stripe call for it).
    stripeApi.retrievePaymentIntent.mockClear();
    await reconcileStripe(Date.now() + 20_000);
    expect(stripeApi.retrievePaymentIntent).not.toHaveBeenCalled();
    expect(await db.eventLog.count({ where: { sessionId: session.id, kind: "reconcile.healed" } })).toBe(1);
    // The webhook arriving late is a duplicate.
    expect((await post(evt)).status).toBe(200);
    expect(shopify.createPaidOrder.mock.calls.filter((c) => c[1].sessionId === session.id)).toHaveLength(1);
  });

  it("fees: Stripe's fee counts like Whop's in the margin (feeCents, fee rate, margin context)", async () => {
    const store = await makeStore();
    await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", status: "PAID", paidAt: new Date(), totalCents: 10000, lines: [], paymentProvider: "stripe", providerFeeCents: 500 } });
    expect(await storeFeeRate(store.id)).toBeCloseTo(0.05, 5);
    expect(feeCents({ whopFeeCents: null, providerFeeCents: 250 })).toBe(250);
    expect(feeCents({ whopFeeCents: 120, providerFeeCents: null })).toBe(120);
    const m = await marginContext({ storeId: store.id, paidQuoteId: null, shippingRateId: null, whopFeeCents: null, providerFeeCents: 321 });
    expect(m.feeCents).toBe(321);
  });

  it("a failed Stripe event is replayed by the tick's Stripe replay (stored copy, or re-read from Stripe when truncated)", async () => {
    const store = await makeStore();
    const a = await makeSession(store.id);
    const b = await makeSession(store.id);
    const evtA = event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(a.piId, { checkout_session_id: a.session.id, store_id: store.id }));
    const evtB = event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(b.piId, { checkout_session_id: b.session.id, store_id: store.id }));
    const old = new Date(Date.now() - STALE_CLAIM_MS - 60_000);
    await db.webhookEvent.createMany({
      data: [
        { id: `stripe:${evtA.id}`, storeId: store.id, type: evtA.type, payload: JSON.parse(JSON.stringify(evtA)), receivedAt: old, attempts: 1, lastError: "boom" },
        { id: `stripe:${evtB.id}`, storeId: store.id, type: evtB.type, payload: { truncated: true, length: 600000 }, receivedAt: old, attempts: 1, lastError: "boom" },
      ],
    });
    stripeApi.retrieveStripeEvent.mockImplementation(async (_s: unknown, id: string) => (id === evtB.id ? evtB : null));
    const n = await replayStaleEvents(Date.now() + 20_000, "stripe");
    expect(n).toBeGreaterThanOrEqual(2);
    expect(stripeApi.retrieveStripeEvent).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), evtB.id);
    for (const s of [a.session, b.session]) expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PAID");
    expect(await db.webhookEvent.count({ where: { storeId: store.id, processedAt: null } })).toBe(0);
    const replayed = await db.eventLog.findMany({ where: { storeId: store.id, kind: "webhook.replayed" } });
    expect(replayed.map((r) => r.message).every((m) => m.startsWith("Événement Stripe payment_intent.succeeded rejoué"))).toBe(true);
  });
});
