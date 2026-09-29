import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import type { CheckoutSession } from "@prisma/client";

/*
 * Stripe money flow, second pass: environment / mode scoping (app_host, livemode), accounts shared by
 * stores or let go of (past accounts), unknown offer PaymentIntents, refunds failed after they
 * succeeded, the buyer's currency, signing secret rotation, reconciliation paging with a blocked
 * mark, the paid snapshot's fingerprint, dispute evidence (shipping_date, already answered), the
 * one-click offer rules, and fees across currencies. Stripe's and Shopify's APIs are mocked; webhook
 * signatures are real. Test data: ss_.
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

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afters.push(fn);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), ...stripeApi }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const APP = "https://checkout.example.com";
const OLD_SECRET = "whsec_ss_old_env_secret";
const NEW_SECRET = "whsec_ss_new_stored_secret";
const LIVE_SECRET = "whsec_ss_live_env_secret";

/* ------------------------------------------------------------------ */
/* Pure rules                                                          */
/* ------------------------------------------------------------------ */

describe("Stripe money rules (pure)", async () => {
  const { stripeFeeCents, stripeForMode, stripeDisputeClosedReason } = await import("@/lib/stripe");
  const { upsellEligible, definitelyRejected, stripeOfferGiveUp, STRIPE_PROCESSING_MAX_MS } = await import("@/lib/upsell");
  const { stripeEvidence, buildEvidence } = await import("@/lib/disputes");
  const { foreignAppHost } = await import("@/lib/stripe-webhooks");
  const { offerIdOf } = await import("@/lib/payments");

  const bt = (currency: string, fee: number, exchange_rate: number | null) => ({ id: "txn", object: "balance_transaction", currency, fee, exchange_rate }) as unknown as Stripe.BalanceTransaction;

  it("stripeFeeCents: the settlement currency's decimals, then Stripe's rate (EUR, JPY both ways)", () => {
    // Same currency.
    expect(stripeFeeCents({ currency: "eur", balance_transaction: bt("eur", 180, null) })).toBe(180);
    expect(stripeFeeCents({ currency: "jpy", balance_transaction: bt("jpy", 36, null) })).toBe(3600);
    // JPY charge settled in EUR: 0,35 € at 0.0062 €/¥ = 56,45 ¥ (5645 app cents), never re-scaled as yen.
    expect(stripeFeeCents({ currency: "jpy", balance_transaction: bt("eur", 35, 0.0062) })).toBe(5645);
    // EUR charge settled in JPY: 30 ¥ at 160 ¥/€ = 0,1875 € → 19 cents.
    expect(stripeFeeCents({ currency: "eur", balance_transaction: bt("jpy", 30, 160) })).toBe(19);
    // USD charge settled in EUR.
    expect(stripeFeeCents({ currency: "usd", balance_transaction: bt("eur", 180, 0.909) })).toBe(198);
    expect(stripeFeeCents({ currency: "usd", balance_transaction: bt("eur", 180, null) })).toBeNull();
    expect(stripeFeeCents({ currency: "usd", balance_transaction: "txn_x" as unknown as Stripe.BalanceTransaction })).toBeNull();
  });

  it("stripeForMode: the event's mode and account for the API calls, the store untouched otherwise", () => {
    const store = { id: "s", testMode: false, stripeAccountId: "acct_now" };
    expect(stripeForMode(store, true)).toBe(store);
    expect(stripeForMode(store, null)).toBe(store);
    expect(stripeForMode(store, false)).toEqual({ id: "s", testMode: true, stripeAccountId: "acct_now" });
    expect(stripeForMode(store, true, "acct_old")).toEqual({ id: "s", testMode: false, stripeAccountId: "acct_old" });
    expect(store.testMode).toBe(false);
  });

  it("foreignAppHost: another deployment's PaymentIntent only when app_host is set and differs", () => {
    expect(foreignAppHost({ app_host: "staging.example.com" }, ["checkout.example.com"])).toBe("staging.example.com");
    expect(foreignAppHost({ app_host: "Checkout.Example.com" }, ["checkout.example.com"])).toBeNull();
    expect(foreignAppHost({}, ["checkout.example.com"])).toBeNull();
    expect(foreignAppHost(null, ["checkout.example.com"])).toBeNull();
    // Default: APP_URL's host.
    expect(foreignAppHost({ app_host: "checkout.example.com" })).toBeNull();
    expect(foreignAppHost({ app_host: "other.example.com" })).toBe("other.example.com");
  });

  it("offerIdOf: Whop's upsell_id and Stripe's upsell_charge_id", () => {
    expect(offerIdOf({ upsell_id: "u1" })).toBe("u1");
    expect(offerIdOf({ upsell_charge_id: "u2" })).toBe("u2");
    expect(offerIdOf({ checkout_session_id: "s" })).toBeNull();
    expect(offerIdOf(null)).toBeNull();
  });

  it("upsellEligible (Stripe): only a card the PaymentIntent saved off session", () => {
    const base = {
      status: "PAID",
      reviewNote: null,
      disputed: false,
      refundedCents: 0,
      paymentProvider: "stripe",
      stripeCustomerId: "cus",
      stripePaymentMethodId: "pm",
      paidAt: new Date(),
    } as unknown as CheckoutSession;
    expect(upsellEligible({ ...base, stripeOffSessionSaved: true })).toBe(true);
    expect(upsellEligible({ ...base, stripeOffSessionSaved: false })).toBe(false);
    expect(upsellEligible({ ...base, stripeOffSessionSaved: null })).toBe(false);
  });

  it("definitelyRejected: Stripe's idempotency error is an unknown outcome, never a refusal", () => {
    expect(definitelyRejected(Object.assign(new Error("Keys for idempotent requests can only be used with the same parameters"), { type: "StripeIdempotencyError", statusCode: 400 }))).toBe(false);
    expect(definitelyRejected(Object.assign(new Error("bad"), { type: "StripeInvalidRequestError", statusCode: 400 }))).toBe(true);
    expect(definitelyRejected(Object.assign(new Error("boom"), { statusCode: 500 }))).toBe(false);
  });

  it("stripeOfferGiveUp: processing waits up to 7 days, anything else open 24 h", () => {
    const H = 3600_000;
    expect(stripeOfferGiveUp("processing", 30 * H)).toBeNull();
    expect(stripeOfferGiveUp("processing", STRIPE_PROCESSING_MAX_MS - H)).toBeNull();
    expect(stripeOfferGiveUp("processing", STRIPE_PROCESSING_MAX_MS + H)?.journal).toMatch(/en traitement.*7 jours/);
    expect(stripeOfferGiveUp("requires_confirmation", 23 * H)).toBeNull();
    expect(stripeOfferGiveUp("requires_confirmation", 25 * H)?.journal).toMatch(/jamais confirmé/);
  });

  it("stripeDisputeClosedReason: answered already, or no response expected", () => {
    expect(stripeDisputeClosedReason({ status: "needs_response", evidence_details: { submission_count: 0 } })).toBeNull();
    expect(stripeDisputeClosedReason({ status: "warning_needs_response", evidence_details: { submission_count: 0 } })).toBeNull();
    expect(stripeDisputeClosedReason({ status: "needs_response", evidence_details: { submission_count: 1 } })).toMatch(/déjà envoyées/);
    expect(stripeDisputeClosedReason({ status: "under_review", evidence_details: { submission_count: 0 } })).toMatch(/under_review/);
    expect(stripeDisputeClosedReason({ status: "won" })).toMatch(/won/);
  });

  it("stripeEvidence: shipping_date for physical goods, service_date otherwise; an offer cites its own PaymentIntent", () => {
    const address = { firstName: "Ana", lastName: "Bel", address1: "1 rue", city: "Paris", zip: "75001", countryCode: "FR" };
    const session = {
      id: "cs_1",
      currency: "EUR",
      totalCents: 5490,
      shopifyOrderName: "#1001",
      clientIp: null,
      email: "b@example.com",
      shippingAddress: address,
      whopPaymentId: "pi_checkout",
      paidAt: new Date("2026-09-01T10:00:00Z"),
      createdAt: new Date("2026-09-01T09:00:00Z"),
      termsAcceptedAt: null,
      trackingPushedAt: new Date("2026-09-03T08:00:00Z"),
      lines: [{ quantity: 1, title: "Sweat", variantTitle: null, requiresShipping: true }],
    } as unknown as CheckoutSession;
    const base = buildEvidence(session, [], []);
    const physical = stripeEvidence(session, [{ number: "TRK", company: "Colissimo", url: null }], base);
    expect(physical.shipping_date).toBe("2026-09-03");
    expect(physical.service_date).toBeUndefined();
    expect(physical.uncategorized_text).toContain("pi_checkout");

    const digital = stripeEvidence({ ...session, lines: [{ quantity: 1, title: "Ebook", variantTitle: null, requiresShipping: false }], trackingPushedAt: null } as unknown as CheckoutSession, [], base);
    expect(digital.service_date).toBe("2026-09-01");
    expect(digital.shipping_date).toBeUndefined();

    const offer = { title: "Chaussettes", amountCents: 990, paidAt: new Date("2026-09-01T10:05:00Z"), shopifyOrderName: "#1002" };
    const offerBase = buildEvidence(session, [], [], { offer });
    const forOffer = stripeEvidence(session, [], offerBase, { paymentId: "pi_offer", shopifyOrderName: "#1002" });
    expect(forOffer.uncategorized_text).toContain("pi_offer");
    expect(forOffer.uncategorized_text).not.toContain("pi_checkout");
    expect(forOffer.uncategorized_text).toContain("#1002");
    // No fulfillment / tracking date for the offer: shipping_date left out (never the payment's date), no service_date either.
    expect(forOffer.shipping_date).toBeUndefined();
    expect(forOffer.service_date).toBeUndefined();
    const unshipped = stripeEvidence({ ...session, trackingPushedAt: null } as unknown as CheckoutSession, [], base);
    expect(unshipped.shipping_date).toBeUndefined();
    expect(unshipped.shipping_address).toContain("1 rue");

    // The Shopify fulfillment's creation wins (earliest parcel), for the checkout and for an offer's own order.
    const fulfilled = [
      { number: "TRK2", company: null, url: null, shippedAt: "2026-09-02T18:00:00Z" },
      { number: "TRK3", company: null, url: null, shippedAt: "2026-09-04T09:00:00Z" },
    ];
    expect(stripeEvidence(session, fulfilled, base).shipping_date).toBe("2026-09-02");
    expect(stripeEvidence(session, [fulfilled[1]], offerBase, { paymentId: "pi_offer" }).shipping_date).toBe("2026-09-04");
    // Unreadable date: trackingPushedAt as before.
    expect(stripeEvidence(session, [{ number: "TRK", company: null, url: null, shippedAt: "nope" }], base).shipping_date).toBe("2026-09-03");
  });

  it("safePayload: a truncated copy keeps the Stripe event's account and mode", async () => {
    const { safePayload, MAX_PAYLOAD } = await import("@/lib/webhooks");
    const big = JSON.stringify({ id: "evt_big", account: "acct_big", livemode: true, pad: "x".repeat(MAX_PAYLOAD) });
    expect(safePayload(big)).toEqual({ truncated: true, length: big.length, account: "acct_big", livemode: true });
    const unreadable = `{${"x".repeat(MAX_PAYLOAD)}`;
    expect(safePayload(unreadable)).toEqual({ truncated: true, length: unreadable.length });
  });
});

/* ------------------------------------------------------------------ */
/* Against the database                                                */
/* ------------------------------------------------------------------ */

describe.skipIf(!hasDb)("Stripe scoping and money edge cases (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const webhookRoute = await import("@/app/api/webhooks/stripe/route");
  const { handleStripeEvent, reconcileStripe } = await import("@/lib/stripe-webhooks");
  const { syncOrderSafely } = await import("@/lib/checkout");
  const { fingerprintTag } = await import("@/lib/stripe");

  const created: string[] = [];
  const settingKeys: string[] = [];
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const ctx = { params: Promise.resolve({}) };
  const saved: Record<string, string | undefined> = {};
  let savedWebhookSetting: string | null = null;
  const line = { variantId: "gid://shopify/ProductVariant/42", productId: "p", productHandle: "sweat", title: "Sweat", variantTitle: null, sku: null, imageUrl: null, quantity: 1, unitPriceCents: 5000, compareAtCents: null, inventory: null, requiresShipping: true };
  const address = { firstName: "Ana", lastName: "Bel", address1: "1 rue", city: "Paris", zip: "75001", countryCode: "FR" };
  const pis = new Map<string, Stripe.PaymentIntent>();

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `ss_${rnd()}`,
        enabled: true,
        testMode: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_ss",
        whopProductId: `prod_ss_${rnd()}`,
        whopApiKey: encrypt("k"),
        shopDomain: `ss-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        stripeAccountId: `acct_ss_${rnd()}`,
        stripeConnectedAt: new Date(),
        stripeLivemode: false,
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  async function makeSession(storeId: string, opts: { session?: Record<string, unknown>; quote?: Record<string, unknown>; fingerprint?: string } = {}) {
    const s = await db.checkoutSession.create({
      data: { storeId, currency: "EUR", lines: [line], subtotalCents: 5000, totalCents: 5490, email: "buyer@example.com", shippingAddress: address, paymentProvider: "stripe", ...opts.session },
    });
    const piId = `pi_ss_${rnd()}`;
    const quote = await db.checkoutQuote.create({
      data: {
        sessionId: s.id,
        whopCheckoutId: `strpq_${s.id}_${rnd()}`,
        provider: "stripe",
        stripePaymentIntentId: piId,
        fingerprint: opts.fingerprint ?? "f",
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
        ...opts.quote,
      },
    });
    await db.checkoutSession.update({ where: { id: s.id }, data: { stripePaymentIntentId: piId } });
    return { session: s, piId, quote };
  }

  function paymentIntent(id: string, meta: Record<string, string>, extra: Partial<Stripe.PaymentIntent> = {}, charge: Record<string, unknown> = {}): Stripe.PaymentIntent {
    const amount = (extra.amount as number | undefined) ?? 5490;
    const currency = (extra.currency as string | undefined) ?? "eur";
    const pi = {
      id,
      object: "payment_intent",
      amount,
      amount_received: amount,
      currency,
      status: "succeeded",
      created: Math.floor(Date.now() / 1000),
      customer: "cus_ss",
      payment_method: "pm_ss",
      setup_future_usage: "off_session",
      metadata: meta,
      receipt_email: "buyer@example.com",
      shipping: null,
      last_payment_error: null,
      latest_charge: {
        id: `ch_${id}`,
        object: "charge",
        amount,
        currency,
        payment_method: "pm_ss",
        payment_method_details: { type: "card", card: { wallet: null } },
        billing_details: { email: "buyer@example.com", address: null, name: null, phone: null },
        balance_transaction: { id: `txn_${id}`, object: "balance_transaction", currency: "eur", fee: 180, exchange_rate: null },
        shipping: null,
        receipt_email: null,
        ...charge,
      },
      ...extra,
    } as unknown as Stripe.PaymentIntent;
    pis.set(id, pi);
    return pi;
  }

  function event(type: string, account: string, object: unknown, extra: Record<string, unknown> = {}): Stripe.Event {
    return { id: `evt_ss_${rnd()}`, object: "event", type, account, livemode: false, created: Math.floor(Date.now() / 1000), api_version: Stripe.API_VERSION, data: { object }, ...extra } as unknown as Stripe.Event;
  }

  function signed(evt: Stripe.Event, secret = OLD_SECRET) {
    const payload = JSON.stringify(evt);
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
    return new Request(`${APP}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
  }

  async function post(evt: Stripe.Event, secret?: string) {
    const res = await webhookRoute.POST(signed(evt, secret), ctx);
    while (afters.length) await afters.shift()!();
    return res;
  }

  async function pay(store: { id: string; stripeAccountId: string | null } & Record<string, unknown>, sessionId: string, piId: string, extra: Partial<Stripe.PaymentIntent> = {}, charge: Record<string, unknown> = {}) {
    const full = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    const account = (extra as { account?: string }).account ?? full.stripeAccountId!;
    const syncId = await handleStripeEvent(event("payment_intent.succeeded", account, paymentIntent(piId, { checkout_session_id: sessionId, store_id: store.id }, extra, charge)), full);
    if (syncId) await syncOrderSafely(syncId);
  }

  const kinds = async (where: Record<string, unknown>) => (await db.eventLog.findMany({ where, select: { kind: true, message: true, level: true } })).map((e) => e.kind);

  beforeAll(async () => {
    for (const [k, v] of Object.entries({
      STRIPE_TEST_SECRET_KEY: "sk_test_ss",
      STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_ss",
      STRIPE_TEST_CLIENT_ID: "ca_test_ss",
      STRIPE_TEST_WEBHOOK_SECRET: OLD_SECRET,
      STRIPE_SECRET_KEY: "sk_live_ss",
      STRIPE_PUBLISHABLE_KEY: "pk_live_ss",
      STRIPE_CLIENT_ID: "ca_live_ss",
      STRIPE_WEBHOOK_SECRET: LIVE_SECRET,
    })) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    // The endpoint's current secret, stored by the app (rotation: the env keeps the previous one).
    savedWebhookSetting = (await db.appSetting.findUnique({ where: { key: "stripe:webhook:test" } }))?.value ?? null;
    const value = JSON.stringify({ id: "we_ss", url: `${APP}/api/webhooks/stripe`, secret: encrypt(NEW_SECRET) });
    await db.appSetting.upsert({ where: { key: "stripe:webhook:test" }, create: { key: "stripe:webhook:test", value }, update: { value } });
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
    shopify.orderRefundedCents.mockResolvedValue(0);
    shopify.createPaidOrder.mockImplementation(async (_st: unknown, input: { sessionId: string }) => ({ id: `gid://shopify/Order/${input.sessionId}`, name: `#${input.sessionId.slice(-4)}` }));
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (savedWebhookSetting == null) await db.appSetting.deleteMany({ where: { key: "stripe:webhook:test" } });
    else await db.appSetting.update({ where: { key: "stripe:webhook:test" }, data: { value: savedWebhookSetting } });
    await db.refundRecord.deleteMany({ where: { storeId: { in: created } } });
    await db.webhookEvent.deleteMany({ where: { storeId: { in: created } } });
    await db.appSetting.deleteMany({
      where: { OR: [...created.flatMap((id) => [{ key: `stripe-reconcile:${id}` }, { key: `stripe-reconcile-run:${id}` }, { key: `stripe:past-accounts:${id}` }]), { key: { in: settingKeys } }] },
    });
    await db.store.deleteMany({ where: { id: { in: created } } });
    await db.$disconnect();
  });

  it("app_host of another deployment: acknowledged (200), nothing claimed nor paid; this deployment's host is paid", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id);
    // The other deployment's own checkout (not in this database; see the APP_URL change case below).
    const foreign = event(
      "payment_intent.succeeded",
      store.stripeAccountId!,
      paymentIntent(`pi_ss_staging_${rnd()}`, { checkout_session_id: `cs_staging_${rnd()}`, store_id: store.id, app_host: "staging.example.com" }),
    );
    const res = await post(foreign);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ignored: true });
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).status).not.toBe("PAID");
    expect(await db.webhookEvent.count({ where: { storeId: store.id, id: `stripe:${foreign.id}` } })).toBe(0);
    // The reconciliation's path (the handler itself) ignores it too.
    expect(await handleStripeEvent(foreign, store)).toBeNull();
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).status).not.toBe("PAID");
    expect(await db.eventLog.count({ where: { storeId: store.id } })).toBe(0);

    const ours = event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(piId, { checkout_session_id: session.id, store_id: store.id, app_host: "checkout.example.com" }));
    expect((await post(ours)).status).toBe(200);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("PAID");
  });

  it("livemode mismatch: the event's mode is used for Stripe calls (test event on a live store, live event on a test store)", async () => {
    const live = await makeStore({ testMode: false, stripeLivemode: true });
    const { session, piId } = await makeSession(live.id);
    const pi = paymentIntent(piId, { checkout_session_id: session.id, store_id: live.id });
    // latest_charge as an id: the handler must read the PaymentIntent back (with the event's mode).
    const res = await post(event("payment_intent.succeeded", live.stripeAccountId!, { ...pi, latest_charge: `ch_${piId}` }, { livemode: false }));
    expect(res.status).toBe(200);
    expect(stripeApi.retrievePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ id: live.id, testMode: true, stripeAccountId: live.stripeAccountId }), piId);
    // A test payment on a live store: recorded, held for review, and its order (if the merchant syncs
    // it) a Shopify test order — never a real one.
    const a = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(a).toMatchObject({ status: "PAID", test: true });
    expect(a.reviewNote).toContain("paiement Stripe en mode test/production différent de la boutique");
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
    expect(await kinds({ sessionId: session.id, kind: "review.hold" })).toEqual(["review.hold"]);
    // The store itself is untouched.
    expect((await db.store.findUniqueOrThrow({ where: { id: live.id } })).testMode).toBe(false);

    const test = await makeStore({ testMode: true });
    const b = await makeSession(test.id, { session: { test: true } });
    const piB = paymentIntent(b.piId, { checkout_session_id: b.session.id, store_id: test.id });
    stripeApi.retrievePaymentIntent.mockClear();
    const syncId = await handleStripeEvent(event("payment_intent.succeeded", test.stripeAccountId!, { ...piB, latest_charge: `ch_${b.piId}` }, { livemode: true }), test);
    expect(stripeApi.retrievePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ id: test.id, testMode: false }), b.piId);
    // A live payment on a store in test mode: held too, its order flagged live (the payment's mode).
    expect(syncId).toBeNull();
    const bRow = await db.checkoutSession.findUniqueOrThrow({ where: { id: b.session.id } });
    expect(bRow).toMatchObject({ status: "PAID", test: false });
    expect(bRow.reviewNote).toContain("mode test/production différent");

    // Same mode as the store: paid without a hold, the order a test one on a test store.
    const c = await makeSession(test.id);
    expect(await handleStripeEvent(event("payment_intent.succeeded", test.stripeAccountId!, paymentIntent(c.piId, { checkout_session_id: c.session.id, store_id: test.id }), { livemode: false }), test)).toBe(c.session.id);
    await syncOrderSafely(c.session.id);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: c.session.id } })).reviewNote).toBeNull();
    expect(shopify.createPaidOrder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: c.session.id, test: true }));
  });

  it("webhook health: lastStripeWebhookAt is set, Whop's lastWebhookAt is left alone", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id);
    expect((await post(event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(piId, { checkout_session_id: session.id, store_id: store.id })))).status).toBe(200);
    const row = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(row.lastStripeWebhookAt).toBeInstanceOf(Date);
    expect(row.lastWebhookAt).toBeNull();
  });

  it("signing secret rotation: the stored secret, the previous one (env) and the live one all verify; others are refused", async () => {
    const store = await makeStore();
    for (const secret of [NEW_SECRET, OLD_SECRET, LIVE_SECRET]) {
      const { session, piId } = await makeSession(store.id);
      const res = await post(event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(piId, { checkout_session_id: session.id, store_id: store.id })), secret);
      expect(res.status).toBe(200);
      expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("PAID");
    }
    const { session, piId } = await makeSession(store.id);
    const res = await post(event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(piId, { checkout_session_id: session.id, store_id: store.id })), "whsec_ss_unknown");
    expect(res.status).toBe(400);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).status).not.toBe("PAID");
  });

  it("a Stripe account shared by two stores: each store handles its own payments and refunds, the other stays quiet", async () => {
    const account = `acct_ss_shared_${rnd()}`;
    const a = await makeStore({ stripeAccountId: account });
    const b = await makeStore({ stripeAccountId: account });
    const { session, piId } = await makeSession(a.id);
    expect((await post(event("payment_intent.succeeded", account, paymentIntent(piId, { checkout_session_id: session.id, store_id: a.id })))).status).toBe(200);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("PAID");

    const refundId = `re_ss_${rnd()}`;
    expect((await post(event("charge.refund.updated", account, { id: refundId, object: "refund", status: "succeeded", amount: 1000, currency: "eur", payment_intent: piId }))).status).toBe(200);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).refundedCents).toBe(1000);
    // Store B (same account): nothing journaled, nothing counted; both copies processed.
    expect(await kinds({ storeId: b.id })).toEqual([]);
    expect(await db.webhookEvent.count({ where: { storeId: b.id, processedAt: { not: null } } })).toBe(2);
    expect((await db.store.findUniqueOrThrow({ where: { id: b.id } })).lastStripeWebhookAt).toBeInstanceOf(Date);
  });

  it("an offer's PaymentIntent unknown to the database: read from Stripe, its upsell_charge_id adopts it, the refund lands on the offer", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id);
    await pay(store, session.id, piId);
    const charge = await db.upsellCharge.create({ data: { sessionId: session.id, blockId: "up1", title: "Chaussettes", variantId: "77", amountCents: 990, status: "PENDING", provider: "stripe", chargeStartedAt: new Date() } });
    const offerPi = `pi_ss_offer_${rnd()}`;
    paymentIntent(offerPi, { checkout_session_id: session.id, store_id: store.id, upsell_charge_id: charge.id }, { amount: 990 });
    const refundId = `re_ss_${rnd()}`;
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, { id: refundId, object: "refund", status: "succeeded", amount: 990, currency: "eur", payment_intent: offerPi }), store);
    expect(stripeApi.retrievePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), offerPi);
    const after = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id } });
    expect(after).toMatchObject({ whopPaymentId: offerPi, refundedCents: 990 });
    expect(await db.refundRecord.findUnique({ where: { id: `stripe:${refundId}` } })).toMatchObject({ chargeId: charge.id, provider: "stripe" });

    // A dispute on another store's offer PaymentIntent (metadata store_id): quiet.
    const other = `pi_ss_other_${rnd()}`;
    paymentIntent(other, { store_id: "someone_else", upsell_charge_id: "nope" });
    await handleStripeEvent(event("charge.dispute.created", store.stripeAccountId!, { id: `du_ss_${rnd()}`, object: "dispute", amount: 990, currency: "eur", status: "needs_response", payment_intent: other }), store);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "dispute.foreign" } })).toBe(0);
  });

  it("a refund failed after it succeeded: alerted once (« annulé/échoué »), never counted twice nor undone", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id);
    await pay(store, session.id, piId);
    const refund = { id: `re_ss_${rnd()}`, object: "refund", status: "succeeded", amount: 1000, currency: "eur", payment_intent: piId };
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, refund), store);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).refundedCents).toBe(1000);
    const failed = { ...refund, status: "failed", failure_reason: "expired_or_canceled_card" };
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, failed), store);
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, failed), store);
    // charge.refunded listing it again (failed): still once.
    stripeApi.listChargeRefunds.mockResolvedValue([failed]);
    await handleStripeEvent(event("charge.refunded", store.stripeAccountId!, { id: `ch_${piId}`, object: "charge", payment_intent: piId, amount: 5490, currency: "eur" }), store);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).refundedCents).toBe(1000);
    const alerts = await db.eventLog.findMany({ where: { storeId: store.id, kind: "refund.reversed" } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ level: "error", sessionId: session.id });
    expect(alerts[0].message.startsWith("Remboursement Stripe annulé/échoué : vérifiez la commande")).toBe(true);
    settingKeys.push(`stripe:refund-reversed:${refund.id}`);

    // A refund that failed before it was ever counted: nothing to say.
    const never = { id: `re_ss_${rnd()}`, object: "refund", status: "failed", amount: 500, currency: "eur", payment_intent: piId };
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, never), store);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "refund.reversed" } })).toBe(1);
  });

  it("a reversed-refund alert whose journal write failed: the marker is dropped, the retry alerts once", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id);
    await pay(store, session.id, piId);
    const refund = { id: `re_ss_${rnd()}`, object: "refund", status: "succeeded", amount: 1000, currency: "eur", payment_intent: piId };
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, refund), store);
    settingKeys.push(`stripe:refund-reversed:${refund.id}`);
    const failed = { ...refund, status: "canceled" };
    const spy = vi.spyOn(db.eventLog, "create").mockRejectedValueOnce(new Error("journal down"));
    await expect(handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, failed), store)).rejects.toThrow(/non enregistrée/);
    spy.mockRestore();
    expect(await db.appSetting.findUnique({ where: { key: `stripe:refund-reversed:${refund.id}` } })).toBeNull();
    // The event's retry (redelivery / replay / reconciliation): alerted now, and only once.
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, failed), store);
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, failed), store);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "refund.reversed" } })).toBe(1);
    expect(await db.appSetting.findUnique({ where: { key: `stripe:refund-reversed:${refund.id}` } })).not.toBeNull();
  });

  it("APP_URL changed: a PaymentIntent tagged with the old host whose checkout is in this database is handled (webhook, handler, refunds)", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id);
    const evt = event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(piId, { checkout_session_id: session.id, store_id: store.id, app_host: "old-domain.example.com" }));
    const res = await post(evt);
    expect(res.status).toBe(200);
    expect(await res.json()).not.toMatchObject({ ignored: true });
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("PAID");
    // A refund of it is counted as usual.
    const refund = { id: `re_ss_${rnd()}`, object: "refund", status: "succeeded", amount: 500, currency: "eur", payment_intent: piId };
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, refund), store);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).refundedCents).toBe(500);

    // The old host with a checkout this database doesn't have: still another deployment's (ignored).
    const b = await makeSession(store.id);
    const foreign = event("payment_intent.succeeded", store.stripeAccountId!, paymentIntent(b.piId, { checkout_session_id: `cs_elsewhere_${rnd()}`, store_id: store.id, app_host: "old-domain.example.com" }));
    expect(await (await post(foreign)).json()).toMatchObject({ ignored: true });
    expect(await handleStripeEvent(foreign, store)).toBeNull();
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: b.session.id } })).status).not.toBe("PAID");
  });

  it("replay of a truncated copy: re-read on the stored account and mode, even after a disconnect", async () => {
    const old = `acct_ss_trunc_${rnd()}`;
    const store = await makeStore({ testMode: true, stripeAccountId: null, stripeConnectedAt: null });
    const { replayStripeEvent } = await import("@/lib/stripe-webhooks");
    stripeApi.retrieveStripeEvent.mockResolvedValue({ id: "evt_ss_trunc", object: "event", type: "customer.created", livemode: true, created: Math.floor(Date.now() / 1000), data: { object: {} } });
    await expect(replayStripeEvent(store.id, "evt_ss_trunc", { truncated: true, length: 600_000, account: old, livemode: true })).resolves.toBeNull();
    expect(stripeApi.retrieveStripeEvent).toHaveBeenCalledWith(expect.objectContaining({ id: store.id, stripeAccountId: old, testMode: false }), "evt_ss_trunc");
    // A bare marker (older copy) on a disconnected store: impossible, said so.
    await expect(replayStripeEvent(store.id, "evt_ss_trunc", { truncated: true, length: 600_000 })).rejects.toThrow(/tronquée/);
  });

  it("buyer's currency: fee converted back, refunds counted in the charged currency, a lost dispute converted to the shop's", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id, { quote: { chargeCurrency: "USD", chargeTotalCents: 6039, chargeFxRate: 1.1 } });
    // Charged 60,39 USD, settled in EUR (fee 1,80 € at 0.909 €/$ = 1,98 $, i.e. 1,80 € back in the shop currency).
    await pay(store, session.id, piId, { amount: 6039, currency: "usd" }, { balance_transaction: { id: "txn_fx", object: "balance_transaction", currency: "eur", fee: 180, exchange_rate: 0.909 } });
    const paid = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(paid).toMatchObject({ status: "PAID", reviewNote: null, chargeCurrency: "USD", chargeFxRate: 1.1, providerFeeCents: 180 });

    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, { id: `re_ss_${rnd()}`, object: "refund", status: "succeeded", amount: 1100, currency: "usd", payment_intent: piId }), store);
    const refunded = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(refunded).toMatchObject({ refundedCents: 1000, refundedChargeCents: 1100 });

    const dispute = { id: `du_ss_${rnd()}`, object: "dispute", amount: 6039, currency: "usd", status: "needs_response", payment_intent: piId, evidence_details: { due_by: Math.floor(Date.now() / 1000) + 86400 * 7 } };
    await handleStripeEvent(event("charge.dispute.created", store.stripeAccountId!, dispute), store);
    await handleStripeEvent(event("charge.dispute.closed", store.stripeAccountId!, { ...dispute, status: "lost" }), store);
    expect(await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ disputed: true, disputeStatus: "lost", disputeLostCents: 5490 });
    // An amount in a third currency is never recorded as if it were the shop's.
    await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, { id: `re_ss_${rnd()}`, object: "refund", status: "succeeded", amount: 500, currency: "gbp", payment_intent: piId }), store);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).refundedCents).toBe(1000);
    expect(await db.eventLog.count({ where: { sessionId: session.id, kind: "refund.currency_mismatch" } })).toBe(1);
  });

  it("markPaid: the PaymentIntent's fingerprint picks the snapshot it paid; an unknown one holds the order for review", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id, { fingerprint: "fp_a" });
    const other = await db.checkoutQuote.create({
      data: {
        sessionId: session.id,
        whopCheckoutId: `strpq_${session.id}_${rnd()}`,
        provider: "stripe",
        fingerprint: "fp_b",
        currency: "EUR",
        subtotalCents: 5000,
        discountCents: 0,
        shippingCents: 0,
        addOnsCents: 0,
        totalCents: 5000,
        shippingRateId: "r2",
        shippingRateName: "Retrait",
        shippingCountries: ["FR"],
        addOns: [],
        addOnIds: [],
      },
    });
    await pay(store, session.id, piId, { amount: 5000, metadata: { checkout_session_id: session.id, store_id: store.id, fingerprint: fingerprintTag("fp_b") } });
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row).toMatchObject({ status: "PAID", paidQuoteId: other.id, totalCents: 5000, shippingRateId: "r2", reviewNote: null });

    const b = await makeSession(store.id, { fingerprint: "fp_c" });
    await pay(store, b.session.id, b.piId, { metadata: { checkout_session_id: b.session.id, store_id: store.id, fingerprint: fingerprintTag("fp_unknown") } });
    const held = await db.checkoutSession.findUniqueOrThrow({ where: { id: b.session.id } });
    expect(held.status).toBe("PAID");
    expect(held.paidQuoteId).toBeNull();
    expect(held.reviewNote).toMatch(/ne correspond à aucun récapitulatif/);
    expect(held.shopifyOrderId).toBeNull();

    // The attached snapshot whose fingerprint matches: used as is.
    const c = await makeSession(store.id, { fingerprint: "fp_d" });
    await pay(store, c.session.id, c.piId, { metadata: { checkout_session_id: c.session.id, store_id: store.id, fingerprint: fingerprintTag("fp_d") } });
    expect(await db.checkoutSession.findUniqueOrThrow({ where: { id: c.session.id } })).toMatchObject({ paidQuoteId: c.quote.id, reviewNote: null });
  });

  it("the paid PaymentIntent decides whether the card was saved off session (one-click offers)", async () => {
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id, { session: { stripeOffSessionSaved: true } });
    await pay(store, session.id, piId, { setup_future_usage: null });
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).stripeOffSessionSaved).toBe(false);
  });

  it("dispute evidence: shipping_date sent; a dispute already answered in Stripe is not resubmitted (journaled)", async () => {
    const store = await makeStore({ autoDisputeEvidence: true });
    const { session, piId } = await makeSession(store.id);
    await pay(store, session.id, piId);
    await db.checkoutSession.update({ where: { id: session.id }, data: { trackingNumber: "TRK1", trackingPushedAt: new Date("2026-09-20T10:00:00Z") } });
    shopify.orderTracking.mockResolvedValue([{ number: "TRK1", company: "Colissimo", url: null }]);
    stripeApi.submitStripeDispute.mockResolvedValue({ skipped: "preuves déjà envoyées (1 envoi)" });
    const dispute = { id: `du_ss_${rnd()}`, object: "dispute", amount: 5490, currency: "eur", status: "needs_response", payment_intent: piId, evidence_details: { due_by: Math.floor(Date.now() / 1000) + 7 * 86400 } };
    await handleStripeEvent(event("charge.dispute.created", store.stripeAccountId!, dispute), store);
    while (afters.length) await afters.shift()!();
    expect(stripeApi.submitStripeDispute).toHaveBeenCalledTimes(1);
    const [scoped, , evidence] = stripeApi.submitStripeDispute.mock.calls[0];
    // In the payment's mode (a test payment: session.test), on its account.
    expect(scoped).toMatchObject({ id: store.id, stripeAccountId: store.stripeAccountId, testMode: true });
    expect(evidence).toMatchObject({ shipping_date: "2026-09-20", shipping_tracking_number: "TRK1" });
    expect(evidence.service_date).toBeUndefined();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(row.disputeEvidenceAt).toBeInstanceOf(Date);
    expect(row.disputeEvidenceTries).toBe(0);
    const skipped = await db.eventLog.findFirstOrThrow({ where: { sessionId: session.id, kind: "dispute.evidence_skipped" } });
    expect(skipped.message).toMatch(/déjà traité dans Stripe/);
    expect(await db.eventLog.count({ where: { sessionId: session.id, kind: "dispute.evidence_submitted" } })).toBe(0);
  });

  it("an account the store let go of: its events still map to the store, on that account; unreadable refunds tell the merchant to act in Stripe", async () => {
    const old = `acct_ss_old_${rnd()}`;
    const store = await makeStore();
    const { session, piId } = await makeSession(store.id, { session: { stripeAccountId: old } });
    await pay(store, session.id, piId, { account: old } as Partial<Stripe.PaymentIntent>);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("PAID");
    await db.appSetting.create({ data: { key: `stripe:past-accounts:${store.id}`, value: JSON.stringify([{ id: old, until: new Date(Date.now() + 86400_000).toISOString(), revoked: true }]) } });

    const dispute = { id: `du_ss_${rnd()}`, object: "dispute", amount: 5490, currency: "eur", status: "needs_response", payment_intent: piId, evidence_details: { due_by: Math.floor(Date.now() / 1000) + 7 * 86400 } };
    expect((await post(event("charge.dispute.created", old, dispute))).status).toBe(200);
    expect(await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ disputed: true, disputeId: dispute.id });
    const note = await db.eventLog.findFirstOrThrow({ where: { sessionId: session.id, kind: "dispute.past_account" } });
    expect(note.message).toMatch(new RegExp(`ancien compte Stripe ${old}.*répondez directement dans Stripe`));

    stripeApi.listChargeRefunds.mockRejectedValue(Object.assign(new Error("The provided key does not have access to account"), { statusCode: 403, type: "StripePermissionError" }));
    expect((await post(event("charge.refunded", old, { id: `ch_${piId}`, object: "charge", payment_intent: piId, amount: 5490, amount_refunded: 5490, currency: "eur" }))).status).toBe(200);
    expect(stripeApi.listChargeRefunds).toHaveBeenCalledWith(expect.objectContaining({ id: store.id, stripeAccountId: old }), `ch_${piId}`);
    const refundNote = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "refund.past_account" } });
    expect(refundNote.message).toMatch(/vérifiez-le dans Stripe/);
    // A past account's events never refresh the current connection's webhook health.
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).lastStripeWebhookAt).toBeNull();
    // The current connection is untouched by the old account's revocation.
    await post(event("account.application.deauthorized", old, { id: "ca_x", object: "application" }));
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeAccountId).toBe(store.stripeAccountId);
  });

  it("reconciliation paging: a failing event holds the mark across pages, the others are handled; healed on the next walk", async () => {
    const store = await makeStore();
    const acct = store.stripeAccountId!;
    const now = Math.floor(Date.now() / 1000);
    const a = await makeSession(store.id);
    const b = await makeSession(store.id);
    const c = await makeSession(store.id);
    paymentIntent(b.piId, { checkout_session_id: b.session.id, store_id: store.id });
    const e3 = event("payment_intent.succeeded", acct, paymentIntent(a.piId, { checkout_session_id: a.session.id, store_id: store.id }), { created: now - 60 });
    // A refund of a payment not recorded yet: RetryLater, the mark must stay before it.
    const e2 = event("charge.refund.updated", acct, { id: `re_ss_${rnd()}`, object: "refund", status: "succeeded", amount: 100, currency: "eur", payment_intent: b.piId }, { created: now - 1800 });
    const e1 = event("payment_intent.succeeded", acct, paymentIntent(c.piId, { checkout_session_id: c.session.id, store_id: store.id }), { created: now - 7200 });
    stripeApi.listStripeEvents.mockImplementation(async (s: { id: string }, _since: number, cursor?: string | null) => {
      if (s.id !== store.id) return { data: [], hasMore: false };
      return cursor === e2.id ? { data: [e1], hasMore: false } : { data: [e3, e2], hasMore: true };
    });
    await reconcileStripe(Date.now() + 20_000);
    expect(stripeApi.listStripeEvents).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), expect.any(Number), e2.id);
    for (const s of [a.session, c.session]) expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("PAID");
    const handled = (await db.webhookEvent.findMany({ where: { storeId: store.id }, select: { id: true } })).map((r) => r.id).sort();
    expect(handled).toEqual([`stripe:${e1.id}`, `stripe:${e3.id}`].sort());
    const mark = await db.appSetting.findUniqueOrThrow({ where: { key: `stripe-reconcile:${store.id}` } });
    expect(new Date(mark.value).getTime()).toBe(e2.created * 1000 - 1000);
    expect(await db.appSetting.findUnique({ where: { key: `stripe-reconcile-run:${store.id}` } })).toBeNull();

    // The payment gets recorded: the next walk handles the refund and moves the mark past it.
    await pay(store, b.session.id, b.piId);
    await reconcileStripe(Date.now() + 20_000);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: b.session.id } })).refundedCents).toBe(100);
    const moved = await db.appSetting.findUniqueOrThrow({ where: { key: `stripe-reconcile:${store.id}` } });
    expect(new Date(moved.value).getTime()).toBeGreaterThan(e2.created * 1000);
    expect(await db.webhookEvent.count({ where: { storeId: store.id, id: `stripe:${e2.id}` } })).toBe(1);
  });
});
