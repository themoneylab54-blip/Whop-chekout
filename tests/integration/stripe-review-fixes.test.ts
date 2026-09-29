import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Stripe checkout review fixes, against a real Postgres (Stripe, Whop, Shopify, notifications
 * mocked): Whop configurations deleted at a switch to Stripe never reused (prepare) nor confirmed
 * ready; the Stripe Customer recorded at once; objects gone from the Stripe account (404) treated as
 * missing; the Stripe.js browser failure never switching over a payment made or going through; the
 * database's errors never counted as Stripe's. Test data: srf_.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
}));
const whopDelete = vi.hoisted(() => vi.fn());
const whop = vi.hoisted(() => ({ createCheckoutConfiguration: vi.fn(), storeClient: vi.fn() }));
const stripeApi = vi.hoisted(() => ({
  createOrUpdatePaymentIntent: vi.fn(),
  ensureStripeCustomer: vi.fn(),
  probeStripe: vi.fn(),
  retrievePaymentIntent: vi.fn(),
  cancelOpenPaymentIntents: vi.fn(),
}));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendTelegram: vi.fn() }));

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void Promise.resolve().then(fn) }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), ...stripeApi }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const STRIPE_ENV = { STRIPE_TEST_SECRET_KEY: "sk_test_srf", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_srf", STRIPE_TEST_CLIENT_ID: "ca_test_srf" };

describe.skipIf(!hasDb)("Stripe checkout review fixes (integration)", async () => {
  const { Prisma } = await import("@prisma/client");
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { prepareSession, confirmSession, checkoutFailureSource, DELETED_SUFFIX } = await import("@/lib/checkout");
  const { STRIPE_PAGE_CALL } = await import("@/lib/stripe");
  const prepareRoute = await import("@/app/api/public/sessions/[id]/prepare/route");

  const created: string[] = [];
  const line = {
    variantId: "gid://shopify/ProductVariant/78",
    productId: "gid://shopify/Product/8",
    productHandle: "srf-mug",
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
  const buyer = { addOnIds: [], email: "buyer@srf.test", acceptsMarketing: false, acceptsTerms: true, address };
  const whopOn = { whopConnectedAt: new Date(), whopAccountId: "biz_srf", whopProductId: "prod_srf", whopApiKey: encrypt("k") };
  const stripeOn = { stripeAccountId: "acct_srf", stripeConnectedAt: new Date(), stripeLivemode: false };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `srf_${Math.random().toString(36).slice(2, 8)}`,
        testMode: true,
        vatExempt: true,
        shopDomain: `srf-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
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
      headers: { host: "checkout.example.com", "content-type": "application/json", "x-forwarded-for": `10.79.${ip++ % 250}.1` },
      body: JSON.stringify(body),
    });
  const missing = (param?: string) => Object.assign(new Error(param ? `No such ${param}` : "No such object"), { statusCode: param ? 400 : 404, code: "resource_missing", type: "StripeInvalidRequestError", ...(param ? { param } : {}) });
  /** A session that submitted a card payment on Stripe that then failed (nothing in flight). */
  async function clickedStripeSession(store: { id: string }) {
    const session = await makeSession(store);
    const prepared = await prepareSession(session, { addOnIds: [] });
    expect(prepared.provider).toBe("stripe");
    expect((await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: prepared.stripe!.paymentIntentId })).ready).toBe(true);
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "FAILED" } });
    return { session, piId: prepared.stripe!.paymentIntentId };
  }

  let piCount = 0;
  const piFingerprint = new Map<string, string>();

  beforeAll(() => {
    Object.assign(process.env, STRIPE_ENV);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    stripeApi.createOrUpdatePaymentIntent.mockReset();
    stripeApi.ensureStripeCustomer.mockReset();
    stripeApi.retrievePaymentIntent.mockReset();
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/9903", name: "#9903" });
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) => items.map((i) => ({ ...line, quantity: i.quantity })));
    whop.createCheckoutConfiguration.mockImplementation(async () => ({ id: `ch_srf_${Math.random().toString(36).slice(2)}`, purchaseUrl: null, paypal: true }));
    whopDelete.mockResolvedValue(undefined);
    whop.storeClient.mockReturnValue({ checkoutConfigurations: { delete: whopDelete } });
    stripeApi.ensureStripeCustomer.mockResolvedValue("cus_srf");
    stripeApi.probeStripe.mockResolvedValue(undefined);
    stripeApi.cancelOpenPaymentIntents.mockResolvedValue([]);
    stripeApi.createOrUpdatePaymentIntent.mockImplementation(
      async (_store: unknown, _s: unknown, target: { fingerprint: string; amountCents: number; currency: string }, opts: { existingId?: string | null; reusable?: boolean }) => {
        const existing = opts.existingId && piFingerprint.has(opts.existingId) ? opts.existingId : null;
        const id = existing && (piFingerprint.get(existing) === target.fingerprint || opts.reusable) ? existing : `pi_srf${++piCount}`;
        piFingerprint.set(id, target.fingerprint);
        return { id, clientSecret: `${id}_secret_x`, status: "requires_payment_method", customerId: null, amount: target.amountCents, currency: target.currency.toLowerCase(), offSessionSaved: false };
      },
    );
  });

  afterAll(async () => {
    await db.appSetting.deleteMany({ where: { OR: created.flatMap((id) => [{ key: { contains: id } }]) } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });

  it("Whop → Stripe → Whop: the deleted configuration is marked and never reused; a fresh one instead, and confirming the old one is never ready", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn });
    const session = await makeSession(store);
    const onWhop = await prepareSession(session, { addOnIds: [] });
    const oldConfig = onWhop.checkoutConfigurationId!;
    await prepareSession(await fresh(session.id), { addOnIds: [] }, { provider: "stripe" });
    await vi.waitFor(() => expect(whopDelete).toHaveBeenCalledWith({ id: oldConfig }, expect.anything()));
    const old = await db.checkoutQuote.findUniqueOrThrow({ where: { whopCheckoutId: oldConfig } });
    expect(old.fingerprint.endsWith(DELETED_SUFFIX)).toBe(true);

    // Even unmarked (the deletion still running), a switch back never reuses it: a fresh configuration.
    await db.checkoutQuote.update({ where: { id: old.id }, data: { fingerprint: old.fingerprint.slice(0, -DELETED_SUFFIX.length) } });
    whop.createCheckoutConfiguration.mockClear();
    const back = await prepareSession(await fresh(session.id), { addOnIds: [] }, { provider: "whop" });
    expect(back.provider).toBe("whop");
    expect(back.checkoutConfigurationId).not.toBe(oldConfig);
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);
    // Staying on Whop now: the fresh one is reused.
    expect((await prepareSession(await fresh(session.id), { addOnIds: [] })).checkoutConfigurationId).toBe(back.checkoutConfigurationId);
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(1);

    // A stale tab confirming the deleted (marked) configuration: not ready, the fresh one instead.
    await db.checkoutQuote.update({ where: { id: old.id }, data: { fingerprint: `${old.fingerprint.replace(DELETED_SUFFIX, "")}${DELETED_SUFFIX}` } });
    const stale = await confirmSession(await fresh(session.id), { ...buyer, checkoutConfigurationId: oldConfig });
    expect(stale).toMatchObject({ ready: false, provider: "whop", checkoutConfigurationId: back.checkoutConfigurationId });
    // The fresh one confirms.
    expect(await confirmSession(await fresh(session.id), { ...buyer, checkoutConfigurationId: back.checkoutConfigurationId })).toMatchObject({ ready: true, provider: "whop" });
  });

  it("a Whop confirm while the session is still on Stripe (Stripe disconnected): never ready on its old configuration", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn });
    const session = await makeSession(store);
    const oldConfig = (await prepareSession(session, { addOnIds: [] })).checkoutConfigurationId!;
    // The old configuration's deletion never ran (unmarked) and the session is on Stripe.
    whopDelete.mockImplementation(() => new Promise(() => undefined));
    await prepareSession(await fresh(session.id), { addOnIds: [] }, { provider: "stripe" });
    await db.checkoutQuote.updateMany({ where: { whopCheckoutId: oldConfig }, data: { fingerprint: (await db.checkoutQuote.findUniqueOrThrow({ where: { whopCheckoutId: oldConfig } })).fingerprint.replace(DELETED_SUFFIX, "") } });
    await db.store.update({ where: { id: store.id }, data: { stripeAccountId: null, stripeConnectedAt: null } });
    const r = await confirmSession(await fresh(session.id), { ...buyer, checkoutConfigurationId: oldConfig });
    expect(r.ready).toBe(false);
    expect(r.provider).toBe("whop");
    expect(r.checkoutConfigurationId).not.toBe(oldConfig);
  });

  it("the Stripe Customer is recorded right after its creation, even when the PaymentIntent call fails next", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const prepared = await prepareSession(session, { addOnIds: [] });
    stripeApi.createOrUpdatePaymentIntent.mockRejectedValueOnce(Object.assign(new Error("Stripe 500"), { statusCode: 500 }));
    await expect(confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: prepared.stripe!.paymentIntentId })).rejects.toThrow("Stripe 500");
    expect((await fresh(session.id)).stripeCustomerId).toBe("cus_srf");
  });

  it("the PaymentIntent canceled meanwhile: the new one and the Customer are recorded", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const prepared = await prepareSession(session, { addOnIds: [] });
    stripeApi.createOrUpdatePaymentIntent.mockResolvedValueOnce({ id: "pi_srf_repl", clientSecret: "pi_srf_repl_secret", status: "requires_payment_method", customerId: "cus_srf", amount: 3000, currency: "eur", offSessionSaved: false });
    const r = await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: prepared.stripe!.paymentIntentId });
    expect(r).toMatchObject({ ready: false, provider: "stripe" });
    const s = await fresh(session.id);
    expect([s.stripePaymentIntentId, s.stripeCustomerId]).toEqual(["pi_srf_repl", "cus_srf"]);
  });

  it("confirm: the session's Customer gone from the account ('No such customer'): a fresh one, recorded, then ready", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const prepared = await prepareSession(session, { addOnIds: [] });
    stripeApi.ensureStripeCustomer.mockResolvedValueOnce("cus_srf_gone").mockResolvedValueOnce("cus_srf_new");
    stripeApi.createOrUpdatePaymentIntent.mockRejectedValueOnce(missing("customer"));
    const r = await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: prepared.stripe!.paymentIntentId });
    expect(r).toMatchObject({ ready: true, provider: "stripe" });
    expect(stripeApi.ensureStripeCustomer.mock.calls[1][1]).toMatchObject({ replaces: "cus_srf_gone" });
    expect(stripeApi.createOrUpdatePaymentIntent.mock.calls.at(-1)![3].buyer.customerId).toBe("cus_srf_new");
    expect((await fresh(session.id)).stripeCustomerId).toBe("cus_srf_new");
  });

  it("prepare: the session's Customer gone is dropped (no customer on the PaymentIntent); the session's PaymentIntent gone (404) is not checked", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const { session } = await clickedStripeSession(store);
    expect((await fresh(session.id)).stripeCustomerId).toBe("cus_srf");
    stripeApi.createOrUpdatePaymentIntent.mockRejectedValueOnce(missing("customer"));
    const again = await prepareSession(await fresh(session.id), { addOnIds: [] });
    expect(again.provider).toBe("stripe");
    expect(stripeApi.createOrUpdatePaymentIntent.mock.calls.at(-1)![3].buyer.customerId).toBeNull();
    expect((await fresh(session.id)).stripeCustomerId).toBeNull();

    // The session's (clicked) PaymentIntent deleted on the account: nothing to settle or wait on.
    await db.checkoutSession.update({ where: { id: session.id }, data: { stripePaymentIntentId: "pi_srf_deleted" } });
    stripeApi.retrievePaymentIntent.mockRejectedValueOnce(missing());
    expect((await prepareSession(await fresh(session.id), { addOnIds: [] })).provider).toBe("stripe");
    expect(stripeApi.retrievePaymentIntent).toHaveBeenCalledWith(expect.anything(), "pi_srf_deleted");
  });

  it("Stripe.js failing after a Pay click: the PaymentIntent is checked first (short call); going through → waited on, paid → settled, never a Whop form on top", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn, paymentMode: "stripe_primary" });
    const clientFailed = (id: string) => prepareRoute.POST(post(id, "prepare", { addOnIds: [], countryCode: "FR", clientFailed: "stripe" }), ctx(id));

    // Processing: payment_in_flight, still on Stripe.
    const one = await clickedStripeSession(store);
    stripeApi.retrievePaymentIntent.mockResolvedValueOnce({ id: one.piId, status: "processing", metadata: { checkout_session_id: one.session.id } });
    const r1 = await clientFailed(one.session.id);
    expect(r1.status).toBe(400);
    expect((await r1.json()).code).toBe("payment_in_flight");
    expect(stripeApi.retrievePaymentIntent).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), one.piId, STRIPE_PAGE_CALL);
    expect((await fresh(one.session.id)).paymentProvider).toBe("stripe");
    expect(whop.createCheckoutConfiguration).not.toHaveBeenCalled();

    // Succeeded (webhook late): marked paid, already_paid.
    const two = await clickedStripeSession(store);
    const paidPi = { id: two.piId, object: "payment_intent", status: "succeeded", amount: 3000, amount_received: 3000, currency: "eur", customer: null, payment_method: null, receipt_email: "buyer@srf.test", metadata: { checkout_session_id: two.session.id }, latest_charge: null, shipping: null };
    stripeApi.retrievePaymentIntent.mockResolvedValue(paidPi);
    const r2 = await clientFailed(two.session.id);
    expect((await r2.json()).code).toBe("already_paid");
    expect((await fresh(two.session.id)).status).toBe("PAID");
    expect(whop.createCheckoutConfiguration).not.toHaveBeenCalled();
    stripeApi.retrievePaymentIntent.mockReset();

    // Stripe's API unreachable too: no switch without the check (the regular prepare, on Stripe).
    const three = await clickedStripeSession(store);
    stripeApi.retrievePaymentIntent.mockRejectedValueOnce(Object.assign(new Error("Request timed out"), { type: "StripeConnectionError" }));
    const r3 = await clientFailed(three.session.id);
    expect(await r3.json()).toMatchObject({ provider: "stripe" });
    expect(whop.createCheckoutConfiguration).not.toHaveBeenCalled();

    // Idle (the card failed) or gone: switched to Whop.
    const four = await clickedStripeSession(store);
    stripeApi.retrievePaymentIntent.mockResolvedValueOnce({ id: four.piId, status: "requires_payment_method", metadata: { checkout_session_id: four.session.id } });
    expect(await (await clientFailed(four.session.id)).json()).toMatchObject({ provider: "whop", switchedFrom: "stripe" });
    const five = await clickedStripeSession(store);
    stripeApi.retrievePaymentIntent.mockRejectedValueOnce(missing());
    expect(await (await clientFailed(five.session.id)).json()).toMatchObject({ provider: "whop", switchedFrom: "stripe" });
  });

  it("a Stripe failure on a page reload after a Pay click: the PaymentIntent is checked before switching to Whop (processing → waited on, unreachable → no switch, idle → switched)", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn, paymentMode: "stripe_primary" });
    const reload = (id: string) => prepareRoute.POST(post(id, "prepare", { addOnIds: [], countryCode: "FR" }), ctx(id));
    const stripeDown = () => stripeApi.createOrUpdatePaymentIntent.mockRejectedValueOnce(Object.assign(new Error("Stripe 500"), { statusCode: 500 }));

    // A delayed method still processing on it: payment_in_flight, never a Whop form.
    const one = await clickedStripeSession(store);
    stripeDown();
    stripeApi.retrievePaymentIntent.mockResolvedValueOnce({ id: one.piId, status: "processing", metadata: { checkout_session_id: one.session.id } });
    const r1 = await reload(one.session.id);
    expect((await r1.json()).code).toBe("payment_in_flight");
    expect(whop.createCheckoutConfiguration).not.toHaveBeenCalled();

    // Stripe's API unreachable for the check too: no blind switch.
    const two = await clickedStripeSession(store);
    stripeDown();
    stripeApi.retrievePaymentIntent.mockRejectedValueOnce(Object.assign(new Error("Request timed out"), { type: "StripeConnectionError" }));
    const r2 = await reload(two.session.id);
    expect(r2.ok).toBe(false);
    expect(whop.createCheckoutConfiguration).not.toHaveBeenCalled();
    expect((await fresh(two.session.id)).paymentProvider).toBe("stripe");

    // Idle (the card failed): switched to Whop.
    const three = await clickedStripeSession(store);
    stripeDown();
    stripeApi.retrievePaymentIntent.mockResolvedValueOnce({ id: three.piId, status: "requires_payment_method", metadata: { checkout_session_id: three.session.id } });
    expect(await (await reload(three.session.id)).json()).toMatchObject({ provider: "whop", switchedFrom: "stripe" });
  });

  it("a database error on the Stripe path is never counted as a Stripe failure", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const spy = vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Timed out fetching a new connection", { code: "P2024", clientVersion: "test" }));
    try {
      const err = await prepareSession(session, { addOnIds: [] }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(checkoutFailureSource(err)).not.toBe("stripe");
    } finally {
      spy.mockRestore();
    }
    // A Stripe error still is.
    stripeApi.createOrUpdatePaymentIntent.mockRejectedValueOnce(Object.assign(new Error("Stripe 500"), { statusCode: 500 }));
    expect(checkoutFailureSource(await prepareSession(await fresh(session.id), { addOnIds: [] }).catch((e: unknown) => e))).toBe("stripe");
  });
});
