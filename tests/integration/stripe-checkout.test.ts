import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Checkout on Stripe and the automatic failover, against a real Postgres: prepare / confirm on a
 * Stripe PaymentIntent (snapshot per provider, CAS and in-flight rules across processors), the
 * per-session instant switch in the prepare and pay routes, the store-level failover
 * (providerFailoverAt, then Shopify's own checkout only when the secondary fails too), the recovery
 * probe, the config / sessions routes with Stripe only, and the status route's PaymentIntent
 * fallback. Stripe's API, Whop, Shopify and notifications are mocked. Test data: sco_.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
}));
const whop = vi.hoisted(() => ({ createCheckoutConfiguration: vi.fn(), storeClient: vi.fn() }));
const stripeApi = vi.hoisted(() => ({
  createOrUpdatePaymentIntent: vi.fn(),
  ensureStripeCustomer: vi.fn(),
  probeStripe: vi.fn(),
  retrievePaymentIntent: vi.fn(),
}));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendTelegram: vi.fn() }));

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void Promise.resolve().then(fn) }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), ...stripeApi }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const STRIPE_ENV = { STRIPE_TEST_SECRET_KEY: "sk_test_sco", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_sco", STRIPE_TEST_CLIENT_ID: "ca_test_sco" };

describe.skipIf(!hasDb)("checkout on Stripe and failover (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { prepareSession, confirmSession, journalCheckoutFailure, CheckoutError, snapshotFingerprint, stripeIdsStale } = await import("@/lib/checkout");
  const { noteCheckoutFailure, probeFallbacks } = await import("@/lib/fallback");
  const prepareRoute = await import("@/app/api/public/sessions/[id]/prepare/route");
  const payRoute = await import("@/app/api/public/sessions/[id]/pay/route");
  const statusRoute = await import("@/app/api/public/sessions/[id]/status/route");
  const configRoute = await import("@/app/api/public/stores/[publicId]/config/route");

  const created: string[] = [];
  const line = {
    variantId: "gid://shopify/ProductVariant/88",
    productId: "gid://shopify/Product/8",
    productHandle: "sco-mug",
    title: "Mug",
    variantTitle: null,
    sku: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 3000,
    compareAtCents: null,
    inventory: null,
    requiresShipping: false,
  };
  const address = { firstName: "Alex", lastName: "Martin", address1: "1 rue X", city: "Paris", zip: "75001", countryCode: "FR" };
  const buyer = { addOnIds: [], email: "buyer@sco.test", acceptsMarketing: false, acceptsTerms: true, address };
  const whopOn = { whopConnectedAt: new Date(), whopAccountId: "biz_sco", whopProductId: "prod_sco", whopApiKey: encrypt("k") };
  const stripeOn = { stripeAccountId: "acct_sco", stripeConnectedAt: new Date(), stripeLivemode: false };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `sco_${Math.random().toString(36).slice(2, 8)}`,
        testMode: true,
        vatExempt: true,
        shopDomain: `sco-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }
  async function makeSession(store: { id: string }, extra: Record<string, unknown> = {}) {
    return db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line], subtotalCents: 3000, ...extra }, include: { store: true } });
  }
  const fresh = (id: string) => db.checkoutSession.findUniqueOrThrow({ where: { id }, include: { store: true } });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let ip = 1;
  const post = (id: string, path: string, body: unknown) =>
    new Request(`https://checkout.example.com/api/public/sessions/${id}/${path}`, {
      method: "POST",
      headers: { host: "checkout.example.com", "content-type": "application/json", "x-forwarded-for": `10.77.${ip++ % 250}.1` },
      body: JSON.stringify(body),
    });

  // PaymentIntents as the mock hands them out (status per id, settable by a test).
  const piStatus = new Map<string, string>();
  const piFingerprint = new Map<string, string>();
  let piCount = 0;

  beforeAll(() => {
    Object.assign(process.env, STRIPE_ENV);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/9901", name: "#9901" });
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) => items.map((i) => ({ ...line, quantity: i.quantity })));
    whop.createCheckoutConfiguration.mockImplementation(async () => ({ id: `ch_sco_${Math.random().toString(36).slice(2)}`, purchaseUrl: null, paypal: true }));
    whop.storeClient.mockReturnValue({ checkoutConfigurations: { delete: async () => undefined } });
    stripeApi.ensureStripeCustomer.mockResolvedValue("cus_sco");
    stripeApi.probeStripe.mockResolvedValue(undefined);
    // Like createOrUpdatePaymentIntent: the existing one when it charges this snapshot, updated in
    // place when reusable, else a new one.
    stripeApi.createOrUpdatePaymentIntent.mockImplementation(
      async (_store: unknown, _s: unknown, target: { fingerprint: string; amountCents: number; currency: string }, opts: { existingId?: string | null; reusable?: boolean }) => {
        const existing = opts.existingId && piFingerprint.has(opts.existingId) ? opts.existingId : null;
        const id = existing && (piFingerprint.get(existing) === target.fingerprint || opts.reusable) ? existing : `pi_sco${++piCount}`;
        piFingerprint.set(id, target.fingerprint);
        if (!piStatus.has(id)) piStatus.set(id, "requires_payment_method");
        return { id, clientSecret: `${id}_secret_x`, status: piStatus.get(id), customerId: null, amount: target.amountCents, currency: target.currency.toLowerCase() };
      },
    );
  });

  afterAll(async () => {
    await db.appSetting.deleteMany({ where: { OR: created.flatMap((id) => [{ key: { contains: id } }]) } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });

  it("stripe_only: prepare creates a PaymentIntent snapshot (provider stripe) and the route answers with what Stripe.js needs", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const res = await prepareRoute.POST(post(session.id, "prepare", { addOnIds: [], countryCode: "FR" }), ctx(session.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ provider: "stripe", checkoutConfigurationId: null, publishableKey: "pk_test_sco", stripeAccount: "acct_sco", paypal: false, totals: { totalCents: 3000 } });
    expect(body.clientSecret).toMatch(/^pi_sco\d+_secret/);
    expect(whop.createCheckoutConfiguration).not.toHaveBeenCalled();
    const [call] = stripeApi.createOrUpdatePaymentIntent.mock.calls;
    expect(call[2]).toMatchObject({ amountCents: 3000, currency: "EUR" });
    expect(call[2].fingerprint).toMatch(/\|p:stripe$/);

    const snap = await db.checkoutQuote.findUniqueOrThrow({ where: { stripePaymentIntentId: body.paymentIntentId } });
    expect([snap.provider, snap.whopCheckoutId, snap.sessionId]).toEqual(["stripe", null, session.id]);
    const s = await fresh(session.id);
    expect([s.paymentProvider, s.stripePaymentIntentId, s.preparedAt != null]).toEqual(["stripe", body.paymentIntentId, true]);

    // Same quote again: the same snapshot and PaymentIntent (no new row).
    const again = await prepareSession(await fresh(session.id), { addOnIds: [] });
    expect(again.stripe?.paymentIntentId).toBe(body.paymentIntentId);
    expect(await db.checkoutQuote.count({ where: { sessionId: session.id } })).toBe(1);
    // A PayPal-only (Whop) checkout is never asked of Stripe.
    await expect(prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" })).rejects.toMatchObject({ code: "paypal_unavailable" });
  });

  it("a new total moves the same PaymentIntent to the new snapshot (updated in place when nothing is in flight)", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const one = await prepareSession(session, { addOnIds: [] });
    const two = await prepareSession(await fresh(session.id), { addOnIds: [], quantities: { [line.variantId]: 2 } });
    expect(two.stripe?.paymentIntentId).toBe(one.stripe?.paymentIntentId);
    expect(stripeApi.createOrUpdatePaymentIntent.mock.calls[1][3]).toMatchObject({ existingId: one.stripe?.paymentIntentId, reusable: true });
    const snaps = await db.checkoutQuote.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "asc" } });
    expect(snaps.map((q) => [q.totalCents, q.stripePaymentIntentId])).toEqual([
      [3000, null],
      [6000, one.stripe?.paymentIntentId],
    ]);
  });

  it("confirm on Stripe: stale PaymentIntent → a fresh one, then ready (Customer, PAYING, provider stamped); PI already paid → already_paid", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const prepared = await prepareSession(session, { addOnIds: [] });
    const pi = prepared.stripe!.paymentIntentId;

    const stale = await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: "pi_unknown" });
    expect(stale).toMatchObject({ ready: false, provider: "stripe" });

    const ok = await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: pi });
    expect(ok).toMatchObject({ ready: true, provider: "stripe", stripe: { paymentIntentId: pi, publishableKey: "pk_test_sco" } });
    expect(stripeApi.ensureStripeCustomer).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), expect.objectContaining({ email: "buyer@sco.test", sessionId: session.id }));
    const last = stripeApi.createOrUpdatePaymentIntent.mock.calls.at(-1)!;
    expect(last[3]).toMatchObject({ existingId: pi, reusable: false, buyer: { email: "buyer@sco.test", customerId: "cus_sco", shipping: { name: "Alex Martin" } } });
    const paying = await fresh(session.id);
    expect([paying.status, paying.paymentProvider, paying.stripePaymentIntentId, paying.stripeCustomerId, paying.email]).toEqual(["PAYING", "stripe", pi, "cus_sco", "buyer@sco.test"]);

    // Paid meanwhile (webhook late): the confirm marks the session paid from it, then says already paid.
    piStatus.set(pi, "succeeded");
    stripeApi.retrievePaymentIntent.mockResolvedValue({
      id: pi,
      object: "payment_intent",
      status: "succeeded",
      amount: 3000,
      amount_received: 3000,
      currency: "eur",
      customer: "cus_sco",
      payment_method: null,
      receipt_email: "buyer@sco.test",
      metadata: { checkout_session_id: session.id },
      latest_charge: null,
      shipping: null,
    });
    await expect(confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: pi })).rejects.toMatchObject({ code: "already_paid" });
    const paid = await fresh(session.id);
    expect([paid.status, paid.stripePaymentIntentId]).toEqual(["PAID", pi]);
  });

  it("prepare over a PaymentIntent paid or going through: never replaced — processing → payment_in_flight, succeeded → marked paid, already_paid", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const pi = (await prepareSession(session, { addOnIds: [] })).stripe!.paymentIntentId;
    // Processing (a bank debit), even for another total: the buyer waits, no new PaymentIntent.
    piStatus.set(pi, "processing");
    const before = piCount;
    await expect(prepareSession(await fresh(session.id), { addOnIds: [], quantities: { [line.variantId]: 2 } })).rejects.toMatchObject({ code: "payment_in_flight" });
    await expect(prepareSession(await fresh(session.id), { addOnIds: [] })).rejects.toMatchObject({ code: "payment_in_flight" });
    expect(piCount).toBe(before);
    expect((await fresh(session.id)).stripePaymentIntentId).toBe(pi);
    // Its route answer: a refusal (400 payment_in_flight), never counted as a Stripe failure.
    const res = await prepareRoute.POST(post(session.id, "prepare", { addOnIds: [], countryCode: "FR" }), ctx(session.id));
    expect([res.status, (await res.json()).code]).toEqual([400, "payment_in_flight"]);

    // Succeeded (webhook late or lost): marked paid from the PaymentIntent, the page is told.
    piStatus.set(pi, "succeeded");
    stripeApi.retrievePaymentIntent.mockResolvedValue({
      id: pi,
      object: "payment_intent",
      status: "succeeded",
      amount: 3000,
      amount_received: 3000,
      currency: "eur",
      customer: null,
      payment_method: null,
      receipt_email: null,
      metadata: { checkout_session_id: session.id },
      latest_charge: null,
      shipping: null,
    });
    await expect(prepareSession(await fresh(session.id), { addOnIds: [] })).rejects.toMatchObject({ code: "already_paid" });
    expect((await fresh(session.id)).status).toBe("PAID");
    expect(piCount).toBe(before);
  });

  it("stale Stripe ids (another connected account, or a test ↔ live switch): ignored, a fresh PaymentIntent and Customer", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store, { test: true });
    const one = (await prepareSession(session, { addOnIds: [] })).stripe!.paymentIntentId;
    await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: one });
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "OPEN", payClickedAt: null } });
    // Reconnected to another Stripe account.
    await db.store.update({ where: { id: store.id }, data: { stripeAccountId: "acct_sco_other" } });
    stripeApi.createOrUpdatePaymentIntent.mockClear();
    // The page still holds the old PaymentIntent: never confirmed, a fresh one on the new account first.
    const stale = await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: one });
    expect(stale).toMatchObject({ ready: false, provider: "stripe" });
    const [call] = stripeApi.createOrUpdatePaymentIntent.mock.calls;
    expect(call[3]).toMatchObject({ existingId: null, buyer: { customerId: null } });
    const two = stale.stripe!.paymentIntentId;
    expect(two).not.toBe(one);
    const s = await fresh(session.id);
    expect([s.stripeAccountId, s.stripePaymentIntentId, s.stripeCustomerId]).toEqual(["acct_sco_other", two, null]);
    // Then the confirm goes through on the new PaymentIntent.
    expect(await confirmSession(s, { ...buyer, paymentIntentId: two })).toMatchObject({ ready: true, stripe: { paymentIntentId: two, stripeAccount: "acct_sco_other" } });

    // Mode switched (test ↔ live) with the same account: stale too; a session never prepared on Stripe
    // (no account recorded) is judged by its mode only.
    const acct = { stripeAccountId: "acct_x", test: true, store: { stripeAccountId: "acct_x", testMode: true } };
    expect(stripeIdsStale(acct)).toBe(false);
    expect(stripeIdsStale({ ...acct, store: { ...acct.store, testMode: false } })).toBe(true);
    expect(stripeIdsStale({ ...acct, stripeAccountId: null })).toBe(false);
    expect(stripeIdsStale({ ...acct, store: { ...acct.store, stripeAccountId: "acct_y" } })).toBe(true);
  });

  it("in flight across processors: a Stripe attempt blocks a Whop confirm and vice versa", async () => {
    // Stripe in flight, Stripe then disconnected: the session would now pay with Whop → refused.
    const store = await makeStore({ ...whopOn, ...stripeOn, paymentMode: "stripe_primary" });
    const session = await makeSession(store);
    const prepared = await prepareSession(session, { addOnIds: [] });
    await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: prepared.stripe!.paymentIntentId });
    await db.store.update({ where: { id: store.id }, data: { stripeAccountId: null, stripeConnectedAt: null } });
    await expect(confirmSession(await fresh(session.id), { ...buyer })).rejects.toMatchObject({ code: "payment_in_flight" });
    await expect(prepareSession(await fresh(session.id), { addOnIds: [] })).rejects.toMatchObject({ code: "payment_in_flight" });

    // Whop in flight, the store then set to Stripe only → a Stripe confirm is refused.
    const store2 = await makeStore({ ...whopOn, ...stripeOn });
    const s2 = await makeSession(store2);
    const whopPrepared = await prepareSession(s2, { addOnIds: [] });
    expect(whopPrepared.provider).toBe("whop");
    await confirmSession(await fresh(s2.id), { ...buyer, checkoutConfigurationId: whopPrepared.checkoutConfigurationId });
    await db.store.update({ where: { id: store2.id }, data: { paymentMode: "stripe_only" } });
    await expect(confirmSession(await fresh(s2.id), { ...buyer, paymentIntentId: "pi_x" })).rejects.toMatchObject({ code: "payment_in_flight" });
  });

  it("whop_primary: Whop failing at prepare switches this buyer to Stripe in the same request, journaled", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn });
    const session = await makeSession(store);
    whop.createCheckoutConfiguration.mockRejectedValueOnce(new Error("Whop 503"));
    const res = await prepareRoute.POST(post(session.id, "prepare", { addOnIds: [], countryCode: "FR" }), ctx(session.id));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ provider: "stripe", switchedFrom: "whop", stripeAccount: "acct_sco" });
    const events = await db.eventLog.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => e.kind)).toEqual(["checkout.init_failed", "checkout.provider_switched"]);
    expect(events[0].data).toMatchObject({ source: "whop" });
    // Sticky: the next prepare stays on Stripe (Whop is not asked again).
    const calls = whop.createCheckoutConfiguration.mock.calls.length;
    expect((await prepareSession(await fresh(session.id), { addOnIds: [] })).provider).toBe("stripe");
    expect(whop.createCheckoutConfiguration.mock.calls.length).toBe(calls);
  });

  it("stripe_primary: Stripe failing switches to Whop; the pay route switches too before any payment", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn, paymentMode: "stripe_primary" });
    const session = await makeSession(store);
    stripeApi.createOrUpdatePaymentIntent.mockRejectedValueOnce(new Error("Stripe 500"));
    const res = await prepareRoute.POST(post(session.id, "prepare", { addOnIds: [], countryCode: "FR" }), ctx(session.id));
    expect(await res.json()).toMatchObject({ provider: "whop", switchedFrom: "stripe" });
    expect((await db.eventLog.findFirstOrThrow({ where: { sessionId: session.id, kind: "checkout.init_failed" } })).data).toMatchObject({ source: "stripe" });

    // Pay: the page holds a stale Whop checkout (other quantity), Whop now fails → Stripe, not ready.
    const other = await makeSession(await makeStore({ ...whopOn, ...stripeOn }));
    const first = await prepareSession(other, { addOnIds: [] });
    whop.createCheckoutConfiguration.mockRejectedValueOnce(new Error("Whop down"));
    const pay = await payRoute.POST(post(other.id, "pay", { ...buyer, quantities: { [line.variantId]: 2 }, checkoutConfigurationId: first.checkoutConfigurationId }), ctx(other.id));
    expect(pay.status).toBe(200);
    expect(await pay.json()).toMatchObject({ ready: false, provider: "stripe", switchedFrom: "whop" });
    expect((await fresh(other.id)).status).toBe("OPEN");
  });

  it("no switch while a payment is in flight, nor for a refusal", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn });
    const session = await makeSession(store, { status: "PAYING", payClickedAt: new Date(), preparedAt: new Date() });
    whop.createCheckoutConfiguration.mockRejectedValueOnce(new Error("Whop 503"));
    const res = await prepareRoute.POST(post(session.id, "prepare", { addOnIds: [], countryCode: "FR" }), ctx(session.id));
    expect(res.status).toBe(502);
    expect(stripeApi.createOrUpdatePaymentIntent).not.toHaveBeenCalled();
    expect(await db.eventLog.count({ where: { sessionId: session.id, kind: "checkout.provider_switched" } })).toBe(0);

    const refused = await makeSession(store);
    whop.createCheckoutConfiguration.mockRejectedValueOnce(new CheckoutError("too_many_changes", "x"));
    expect((await prepareRoute.POST(post(refused.id, "prepare", { addOnIds: [], countryCode: "FR" }), ctx(refused.id))).status).toBe(400);
    expect(stripeApi.createOrUpdatePaymentIntent).not.toHaveBeenCalled();
  });

  it("store level: Whop failing → providerFailoverAt (Stripe for new sessions); Stripe failing too → still never Shopify's checkout", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn, autoFallback: true });
    for (let i = 0; i < 3; i++) await journalCheckoutFailure(await makeSession(store), "prepare", new Error(`Whop 503 #${i}`));
    let s = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(s.providerFailoverAt).not.toBeNull();
    expect(s.fallbackActiveAt).toBeNull();
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "fallback.provider_switched" } })).toBe(1);
    // New sessions pay with Stripe.
    expect((await prepareSession(await makeSession(store), { addOnIds: [] })).provider).toBe("stripe");
    await db.checkoutQuote.deleteMany({ where: { session: { storeId: store.id } } });

    // More Whop failures change nothing more; Stripe failing too never sends buyers to Shopify.
    await noteCheckoutFailure(store.id, "whop");
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).fallbackActiveAt).toBeNull();
    const { withFailureSource } = await import("@/lib/checkout");
    for (let i = 0; i < 3; i++) await journalCheckoutFailure(await makeSession(store), "prepare", withFailureSource(new Error(`Stripe 500 #${i}`), "stripe"));
    s = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect(s.fallbackActiveAt).toBeNull();
  });

  it("store level without a usable Stripe: never Shopify's checkout", async () => {
    const store = await makeStore({ ...whopOn, autoFallback: true });
    for (let i = 0; i < 3; i++) await journalCheckoutFailure(await makeSession(store), "prepare", new Error("Whop 503"));
    const s = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect([s.providerFailoverAt, s.fallbackActiveAt]).toEqual([null, null]);
  });

  it("recovery probe: the primary answering clears providerFailoverAt; still failing keeps it", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn, providerFailoverAt: new Date(Date.now() - 10 * 60_000), providerFailoverReason: "test" });
    whop.createCheckoutConfiguration.mockRejectedValueOnce(new Error("still down"));
    await probeFallbacks(Date.now() + 10_000);
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).providerFailoverAt).not.toBeNull();
    // Next probe (spacing elapsed): Whop answers.
    await db.appSetting.deleteMany({ where: { key: `provider-probe:${store.id}` } });
    await probeFallbacks(Date.now() + 10_000);
    const s = await db.store.findUniqueOrThrow({ where: { id: store.id } });
    expect([s.providerFailoverAt, s.providerFailoverReason]).toEqual([null, null]);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "fallback.provider_cleared" } })).toBe(1);

    // stripe_only on Shopify's checkout: Stripe's probe brings the custom checkout back.
    const onShopify = await makeStore({ ...stripeOn, paymentMode: "stripe_only", fallbackActiveAt: new Date(Date.now() - 10 * 60_000) });
    await probeFallbacks(Date.now() + 10_000);
    expect(stripeApi.probeStripe).toHaveBeenCalled();
    expect((await db.store.findUniqueOrThrow({ where: { id: onShopify.id } })).fallbackActiveAt).toBeNull();
  });

  it("config route: live with Stripe only (no Whop); off without any processor", async () => {
    const config = async (publicId: string) =>
      (await (await configRoute.GET(new Request(`https://checkout.example.com/api/public/stores/${publicId}/config`), { params: Promise.resolve({ publicId }) })).json()) as { enabled: boolean };
    const stripeOnly = await makeStore({ ...stripeOn, paymentMode: "stripe_only", enabled: true });
    expect((await config(stripeOnly.publicId)).enabled).toBe(true);
    const whopPrimaryNoWhop = await makeStore({ ...stripeOn, enabled: true });
    expect((await config(whopPrimaryNoWhop.publicId)).enabled).toBe(true);
    const none = await makeStore({ enabled: true });
    expect((await config(none.publicId)).enabled).toBe(false);
    // A session of the Stripe-only store opens on Stripe.
    const s = await makeSession(stripeOnly);
    expect((await prepareSession(s, { addOnIds: [] })).provider).toBe("stripe");
  });

  it("forced (admin « Tester le secours ») session: Stripe even when Whop is the primary; never switched to Whop", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn });
    const s = await makeSession(store, { forcedProvider: "stripe" });
    expect((await prepareSession(s, { addOnIds: [] })).provider).toBe("stripe");
    stripeApi.createOrUpdatePaymentIntent.mockRejectedValueOnce(new Error("Stripe 500"));
    const res = await prepareRoute.POST(post(s.id, "prepare", { addOnIds: [], countryCode: "FR", quantities: { [line.variantId]: 3 } }), ctx(s.id));
    expect(res.status).toBe(502);
    expect(whop.createCheckoutConfiguration).not.toHaveBeenCalled();
  });

  it("status route: a PAYING Stripe session whose PaymentIntent succeeded is marked paid (webhook late)", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const prepared = await prepareSession(session, { addOnIds: [] });
    const pi = prepared.stripe!.paymentIntentId;
    await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: pi });
    stripeApi.retrievePaymentIntent.mockResolvedValue({
      id: pi,
      object: "payment_intent",
      status: "succeeded",
      amount: 3000,
      amount_received: 3000,
      currency: "eur",
      customer: "cus_sco",
      payment_method: "pm_sco",
      receipt_email: "buyer@sco.test",
      // The snapshot's fingerprint hash, as prepare writes it (markPaid checks it against the paid snapshot).
      metadata: {
        checkout_session_id: session.id,
        store_id: store.id,
        fingerprint: (await import("@/lib/stripe")).fingerprintTag((await db.checkoutQuote.findUniqueOrThrow({ where: { stripePaymentIntentId: pi } })).fingerprint),
      },
      latest_charge: null,
      shipping: null,
    });
    const res = await statusRoute.GET(new Request(`https://checkout.example.com/api/public/sessions/${session.id}/status`, { headers: { host: "checkout.example.com" } }), ctx(session.id));
    const body = await res.json();
    expect(body.status).toBe("PAID");
    expect(body.paymentInFlight).toBe(false);
    const paid = await fresh(session.id);
    expect([paid.status, paid.paymentProvider, paid.stripePaymentIntentId]).toEqual(["PAID", "stripe", pi]);
    expect(paid.paidQuoteId).toBe((await db.checkoutQuote.findUniqueOrThrow({ where: { stripePaymentIntentId: pi } })).id);

    // Not succeeded: nothing changes.
    const other = await makeSession(store);
    const p2 = await prepareSession(other, { addOnIds: [] });
    await confirmSession(await fresh(other.id), { ...buyer, paymentIntentId: p2.stripe!.paymentIntentId });
    stripeApi.retrievePaymentIntent.mockResolvedValue({ id: p2.stripe!.paymentIntentId, status: "requires_action", metadata: { checkout_session_id: other.id } });
    const r2 = await (await statusRoute.GET(new Request(`https://checkout.example.com/api/public/sessions/${other.id}/status`, { headers: { host: "checkout.example.com" } }), ctx(other.id))).json();
    expect(r2.status).toBe("PAYING");
  });

  it("snapshot fingerprints differ per processor (a Whop snapshot is never taken for a Stripe one)", async () => {
    const quote = { totals: { totalCents: 3000, subtotalCents: 3000, discountCents: 0, shippingCents: 0, addOnsCents: 0 }, shippingRateId: null, discount: null, addOnIds: [] } as unknown as Parameters<typeof snapshotFingerprint>[0];
    expect(snapshotFingerprint(quote, null, null)).not.toBe(snapshotFingerprint(quote, null, null, "stripe"));
    expect(snapshotFingerprint(quote, null, null, "whop")).toBe(snapshotFingerprint(quote, null, null));
  });
});
