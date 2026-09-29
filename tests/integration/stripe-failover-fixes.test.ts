import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Checkout + Stripe failover hardening, against a real Postgres (Stripe, Whop, Shopify, notifications
 * mocked): no double charge across processors (Whop checkouts deleted / PaymentIntents canceled on a
 * switch), the Pay-click switch after a Stripe failure, Stripe.js failing in the browser
 * (clientFailed), what counts towards the store-level failover (effective provider, Stripe refusals,
 * forced sessions, client failures apart), ending a failover when the primary works again, the
 * hysteresis, the P2002 race on a PaymentIntent, and the status route checking previous
 * PaymentIntents. Test data: sfx_.
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
const STRIPE_ENV = { STRIPE_TEST_SECRET_KEY: "sk_test_sfx", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_sfx", STRIPE_TEST_CLIENT_ID: "ca_test_sfx" };

describe.skipIf(!hasDb)("checkout + Stripe failover hardening (integration)", async () => {
  const { Prisma } = await import("@prisma/client");
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { prepareSession, confirmSession, journalCheckoutFailure, withFailureSource, attachPaymentIntent, CheckoutError } = await import("@/lib/checkout");
  const { noteFailoverCleared } = await import("@/lib/fallback");
  const { STRIPE_PAGE_CALL } = await import("@/lib/stripe");
  const prepareRoute = await import("@/app/api/public/sessions/[id]/prepare/route");
  const payRoute = await import("@/app/api/public/sessions/[id]/pay/route");
  const statusRoute = await import("@/app/api/public/sessions/[id]/status/route");

  const created: string[] = [];
  const line = {
    variantId: "gid://shopify/ProductVariant/77",
    productId: "gid://shopify/Product/7",
    productHandle: "sfx-mug",
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
  const buyer = { addOnIds: [], email: "buyer@sfx.test", acceptsMarketing: false, acceptsTerms: true, address };
  const whopOn = { whopConnectedAt: new Date(), whopAccountId: "biz_sfx", whopProductId: "prod_sfx", whopApiKey: encrypt("k") };
  const stripeOn = { stripeAccountId: "acct_sfx", stripeConnectedAt: new Date(), stripeLivemode: false };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `sfx_${Math.random().toString(36).slice(2, 8)}`,
        testMode: true,
        vatExempt: true,
        shopDomain: `sfx-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
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
  const storeOf = (id: string) => db.store.findUniqueOrThrow({ where: { id } });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
  let ip = 1;
  const post = (id: string, path: string, body: unknown) =>
    new Request(`https://checkout.example.com/api/public/sessions/${id}/${path}`, {
      method: "POST",
      headers: { host: "checkout.example.com", "content-type": "application/json", "x-forwarded-for": `10.78.${ip++ % 250}.1` },
      body: JSON.stringify(body),
    });
  const stripeErr = (msg: string, extra: Record<string, unknown> = {}) => withFailureSource(Object.assign(new Error(msg), extra), "stripe");

  let piCount = 0;
  const piFingerprint = new Map<string, string>();

  beforeAll(() => {
    Object.assign(process.env, STRIPE_ENV);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/9902", name: "#9902" });
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) => items.map((i) => ({ ...line, quantity: i.quantity })));
    whop.createCheckoutConfiguration.mockImplementation(async () => ({ id: `ch_sfx_${Math.random().toString(36).slice(2)}`, purchaseUrl: null, paypal: true }));
    whopDelete.mockResolvedValue(undefined);
    whop.storeClient.mockReturnValue({ checkoutConfigurations: { delete: whopDelete } });
    stripeApi.ensureStripeCustomer.mockResolvedValue("cus_sfx");
    stripeApi.probeStripe.mockResolvedValue(undefined);
    stripeApi.cancelOpenPaymentIntents.mockResolvedValue([]);
    stripeApi.createOrUpdatePaymentIntent.mockImplementation(
      async (_store: unknown, _s: unknown, target: { fingerprint: string; amountCents: number; currency: string }, opts: { existingId?: string | null; reusable?: boolean; saveCard?: boolean }) => {
        const existing = opts.existingId && piFingerprint.has(opts.existingId) ? opts.existingId : null;
        const id = existing && (piFingerprint.get(existing) === target.fingerprint || opts.reusable) ? existing : `pi_sfx${++piCount}`;
        piFingerprint.set(id, target.fingerprint);
        return { id, clientSecret: `${id}_secret_x`, status: "requires_payment_method", customerId: null, amount: target.amountCents, currency: target.currency.toLowerCase(), offSessionSaved: true };
      },
    );
  });

  afterAll(async () => {
    await db.appSetting.deleteMany({ where: { OR: created.flatMap((id) => [{ key: { contains: id } }]) } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    for (const k of Object.keys(STRIPE_ENV)) delete process.env[k];
  });

  it("a switch Whop → Stripe deletes the session's Whop checkouts; Stripe → Whop cancels its open PaymentIntents", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn });
    const session = await makeSession(store);
    const onWhop = await prepareSession(session, { addOnIds: [] });
    expect(onWhop.provider).toBe("whop");
    const onStripe = await prepareSession(await fresh(session.id), { addOnIds: [] }, { provider: "stripe" });
    expect(onStripe.provider).toBe("stripe");
    // After the answer (after()), one short call, never retried.
    await vi.waitFor(() => expect(whopDelete).toHaveBeenCalledWith({ id: onWhop.checkoutConfigurationId }, { timeoutInSeconds: 3, maxRetries: 0 }));
    // Recorded on the session: the PaymentIntent's account and whether the card is saved off session.
    const s = await fresh(session.id);
    expect([s.stripeAccountId, s.stripeOffSessionSaved]).toEqual(["acct_sfx", true]);
    // Staying on Stripe: nothing deleted again.
    whopDelete.mockClear();
    await prepareSession(await fresh(session.id), { addOnIds: [] });
    expect(whopDelete).not.toHaveBeenCalled();

    const back = await prepareSession(await fresh(session.id), { addOnIds: [] }, { provider: "whop" });
    expect(back.provider).toBe("whop");
    await vi.waitFor(() =>
      expect(stripeApi.cancelOpenPaymentIntents).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), expect.arrayContaining([onStripe.stripe!.paymentIntentId]), { timeout: 3_000, maxNetworkRetries: 0 }),
    );
  });

  it("the cleanup runs after the answer: a Whop deletion failing or hanging never fails nor delays the prepare, and is not retried", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn });
    const session = await makeSession(store);
    await prepareSession(session, { addOnIds: [] });
    whopDelete.mockRejectedValueOnce(Object.assign(new Error("Whop 503"), { status: 503 }));
    expect((await prepareSession(await fresh(session.id), { addOnIds: [] }, { provider: "stripe" })).provider).toBe("stripe");
    await vi.waitFor(() => expect(whopDelete).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(whopDelete).toHaveBeenCalledTimes(1);

    // Whop hanging (it just failed): the Stripe prepare answers without waiting for it.
    const other = await makeSession(store);
    await prepareSession(other, { addOnIds: [] });
    whopDelete.mockReset();
    whopDelete.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    expect((await prepareSession(await fresh(other.id), { addOnIds: [] }, { provider: "stripe" })).provider).toBe("stripe");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a switch to Whop never cancels PaymentIntents of another account or mode (stale ids)", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn });
    const session = await makeSession(store);
    await prepareSession(session, { addOnIds: [] }, { provider: "stripe" });
    await db.store.update({ where: { id: store.id }, data: { stripeAccountId: "acct_sfx_other" } });
    expect((await prepareSession(await fresh(session.id), { addOnIds: [] }, { provider: "whop" })).provider).toBe("whop");
    await new Promise((r) => setTimeout(r, 20));
    expect(stripeApi.cancelOpenPaymentIntents).not.toHaveBeenCalled();
  });

  it("Stripe failing at the Pay click switches this buyer to Whop (not ready, journaled)", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn, paymentMode: "stripe_primary" });
    const session = await makeSession(store);
    const prepared = await prepareSession(session, { addOnIds: [] });
    expect(prepared.provider).toBe("stripe");
    stripeApi.ensureStripeCustomer.mockRejectedValueOnce(new Error("Stripe 500"));
    const res = await payRoute.POST(post(session.id, "pay", { ...buyer, paymentIntentId: prepared.stripe!.paymentIntentId }), ctx(session.id));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ready: false, provider: "whop", switchedFrom: "stripe" });
    const s = await fresh(session.id);
    expect([s.status, s.paymentProvider]).toEqual(["OPEN", "whop"]);
    const kinds = (await db.eventLog.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "asc" } })).map((e) => e.kind);
    expect(kinds).toEqual(["checkout.init_failed", "checkout.provider_switched"]);
  });

  it("Stripe.js failing in the browser (clientFailed): switched to Whop, journaled apart; the store fails over only after 3 sessions", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn, paymentMode: "stripe_primary" });
    for (let i = 0; i < 3; i++) {
      const session = await makeSession(store);
      expect((await prepareSession(session, { addOnIds: [] })).provider).toBe("stripe");
      const res = await prepareRoute.POST(post(session.id, "prepare", { addOnIds: [], countryCode: "FR", clientFailed: "stripe" }), ctx(session.id));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ provider: "whop", switchedFrom: "stripe" });
      const events = await db.eventLog.findMany({ where: { sessionId: session.id }, select: { kind: true, data: true } });
      expect(events.map((e) => e.kind).sort()).toEqual(["checkout.client_failed", "checkout.provider_switched"]);
      // Never counted as a server failure.
      expect(events.some((e) => e.kind === "checkout.init_failed")).toBe(false);
      expect((await storeOf(store.id)).providerFailoverAt == null).toBe(i < 2);
    }
    const s = await storeOf(store.id);
    expect(s.providerFailoverAt).not.toBeNull();
    expect(s.fallbackActiveAt).toBeNull();
  });

  it("forged browser failures: only sessions served a Stripe form moments ago count; never Shopify's own checkout", async () => {
    // Sessions not served a Stripe form recently (their Stripe snapshot is old): switched, never counted.
    const store = await makeStore({ ...whopOn, ...stripeOn, paymentMode: "stripe_primary" });
    for (let i = 0; i < 3; i++) {
      const session = await makeSession(store);
      await prepareSession(session, { addOnIds: [] });
      await db.checkoutQuote.updateMany({ where: { sessionId: session.id }, data: { createdAt: new Date(Date.now() - 30 * 60_000) } });
      const res = await prepareRoute.POST(post(session.id, "prepare", { addOnIds: [], countryCode: "FR", clientFailed: "stripe" }), ctx(session.id));
      expect(await res.json()).toMatchObject({ provider: "whop", switchedFrom: "stripe" });
      const row = await db.eventLog.findFirstOrThrow({ where: { sessionId: session.id, kind: "checkout.client_failed" } });
      expect(row.data).toMatchObject({ unverified: true });
    }
    expect((await storeOf(store.id)).providerFailoverAt).toBeNull();

    // Stripe only (no processor to fail over to) with the automatic fallback on: browser failures
    // never send the store to Shopify's checkout, however many.
    const only = await makeStore({ ...stripeOn, paymentMode: "stripe_only", autoFallback: true });
    for (let i = 0; i < 4; i++) {
      const session = await makeSession(only);
      await prepareSession(session, { addOnIds: [] });
      const res = await prepareRoute.POST(post(session.id, "prepare", { addOnIds: [], countryCode: "FR", clientFailed: "stripe" }), ctx(session.id));
      expect((await res.json()).provider).toBe("stripe");
    }
    const s = await storeOf(only.id);
    expect([s.providerFailoverAt, s.fallbackActiveAt]).toEqual([null, null]);
  });

  it("Stripe refusals (4xx) and forced test sessions never count towards the store", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn, paymentMode: "stripe_primary", autoFallback: true });
    for (let i = 0; i < 3; i++) {
      await journalCheckoutFailure(await makeSession(store), "prepare", stripeErr("amount_too_small", { statusCode: 400, type: "StripeInvalidRequestError", code: "amount_too_small" }));
    }
    let s = await storeOf(store.id);
    expect([s.providerFailoverAt, s.fallbackActiveAt]).toEqual([null, null]);
    const row = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "checkout.init_failed" } });
    expect(row.data).toMatchObject({ source: "stripe", rejected: true, code: "amount_too_small" });

    for (let i = 0; i < 3; i++) await journalCheckoutFailure(await makeSession(store, { forcedProvider: "stripe" }), "prepare", stripeErr("Stripe 500"));
    s = await storeOf(store.id);
    expect([s.providerFailoverAt, s.fallbackActiveAt]).toEqual([null, null]);
    // A real outage still counts (the rows above are ignored: exactly 3 new sessions needed).
    for (let i = 0; i < 2; i++) await journalCheckoutFailure(await makeSession(store), "prepare", stripeErr("Stripe 500"));
    expect((await storeOf(store.id)).providerFailoverAt).toBeNull();
    await journalCheckoutFailure(await makeSession(store), "prepare", stripeErr("Stripe 500"));
    expect((await storeOf(store.id)).providerFailoverAt).not.toBeNull();
  });

  it("Stripe effectively primary (Whop disconnected under « Whop principal »): its failures count", async () => {
    const store = await makeStore({ ...stripeOn, autoFallback: true });
    for (let i = 0; i < 3; i++) await journalCheckoutFailure(await makeSession(store), "prepare", stripeErr("Stripe 500"));
    expect((await storeOf(store.id)).fallbackActiveAt).not.toBeNull();
  });

  it("during a failover, the secondary failing while the primary's sessions keep working ends the failover (not Shopify)", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn, autoFallback: true, providerFailoverAt: new Date(Date.now() - 20 * 60_000), providerFailoverReason: "test" });
    // A sticky Whop session created a Whop checkout meanwhile.
    const sticky = await makeSession(store, { preparedAt: new Date(), paymentProvider: "whop" });
    expect((await prepareSession(sticky, { addOnIds: [] })).provider).toBe("whop");
    for (let i = 0; i < 3; i++) await journalCheckoutFailure(await makeSession(store), "prepare", stripeErr("Stripe 500"));
    const s = await storeOf(store.id);
    expect([s.providerFailoverAt, s.fallbackActiveAt]).toEqual([null, null]);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "fallback.provider_cleared" } })).toBe(1);
  });

  it("hysteresis: right after a failover ended, only new failures count, and a new failover within the hour doesn't alert again", async () => {
    const store = await makeStore({ ...whopOn, ...stripeOn });
    for (let i = 0; i < 2; i++) await journalCheckoutFailure(await makeSession(store), "prepare", new Error("Whop 503"));
    await noteFailoverCleared(store.id);
    await journalCheckoutFailure(await makeSession(store), "prepare", new Error("Whop 503"));
    // 3 failures in 10 min, but only 1 since the failover ended: no switch.
    expect((await storeOf(store.id)).providerFailoverAt).toBeNull();
    for (let i = 0; i < 2; i++) await journalCheckoutFailure(await makeSession(store), "prepare", new Error("Whop 503"));
    expect((await storeOf(store.id)).providerFailoverAt).not.toBeNull();
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "fallback.provider_switched" } })).toBe(1);
    // Flapping: journaled, no alert queued for the switch.
    expect(await db.alertOutbox.count({ where: { storeId: store.id, kind: "fallback.provider_switched" } })).toBe(0);
  });

  it("P2002 on the PaymentIntent (two requests racing): resolved to the snapshot holding it; another session's is a refusal", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const base = { sessionId: session.id, currency: "EUR", subtotalCents: 3000, discountCents: 0, shippingCents: 0, addOnsCents: 0, totalCents: 3000, addOns: [], provider: "stripe" as const };
    const held = await db.checkoutQuote.create({ data: { ...base, fingerprint: "fp_race", stripePaymentIntentId: "pi_sfx_race" } });
    const spy = vi.spyOn(db, "$transaction").mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" }));
    try {
      const got = await attachPaymentIntent(session.id, null, () => ({ ...base, fingerprint: "fp_race" }), "pi_sfx_race");
      expect(got.id).toBe(held.id);
    } finally {
      spy.mockRestore();
    }
    const other = await makeSession(store);
    const err = await attachPaymentIntent(other.id, null, () => ({ ...base, sessionId: other.id, fingerprint: "fp_other" }), "pi_sfx_race").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CheckoutError);
  });

  it("status route: a previous PaymentIntent of the session that succeeded marks it paid", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const one = await prepareSession(session, { addOnIds: [] });
    const oldPi = one.stripe!.paymentIntentId;
    // The total changed with a payment in flight: a new PaymentIntent, the old one kept on its snapshot.
    await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: oldPi });
    const two = await prepareSession(await fresh(session.id), { addOnIds: [], quantities: { [line.variantId]: 2 } });
    const newPi = two.stripe!.paymentIntentId;
    expect(newPi).not.toBe(oldPi);
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "PAYING" } });
    stripeApi.retrievePaymentIntent.mockImplementation(async (_s: unknown, id: string) =>
      id === oldPi
        ? { id, object: "payment_intent", status: "succeeded", amount: 3000, amount_received: 3000, currency: "eur", customer: null, payment_method: null, receipt_email: "buyer@sfx.test", metadata: { checkout_session_id: session.id }, latest_charge: null, shipping: null }
        : { id, status: "requires_payment_method", metadata: { checkout_session_id: session.id } },
    );
    const body = await (await statusRoute.GET(new Request(`https://checkout.example.com/api/public/sessions/${session.id}/status`, { headers: { host: "checkout.example.com" } }), ctx(session.id))).json();
    expect(body.status).toBe("PAID");
    expect(stripeApi.retrievePaymentIntent.mock.calls.map((c) => c[1])).toEqual([newPi, oldPi]);
    // Short page calls, never retried.
    expect(stripeApi.retrievePaymentIntent.mock.calls.map((c) => c[2])).toEqual([STRIPE_PAGE_CALL, STRIPE_PAGE_CALL]);
  });

  it("status route: the PaymentIntent checks run in parallel, one failing or slow never hides a paid one", async () => {
    const store = await makeStore({ ...stripeOn, paymentMode: "stripe_only" });
    const session = await makeSession(store);
    const oldPi = (await prepareSession(session, { addOnIds: [] })).stripe!.paymentIntentId;
    await confirmSession(await fresh(session.id), { ...buyer, paymentIntentId: oldPi });
    const newPi = (await prepareSession(await fresh(session.id), { addOnIds: [], quantities: { [line.variantId]: 2 } })).stripe!.paymentIntentId;
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "PAYING" } });
    const started: string[] = [];
    let releaseNew: () => void = () => undefined;
    stripeApi.retrievePaymentIntent.mockImplementation(async (_s: unknown, id: string) => {
      started.push(id);
      if (id === newPi) {
        // The current one hangs, then times out.
        await new Promise<void>((r) => (releaseNew = r));
        throw Object.assign(new Error("Request timed out"), { type: "StripeConnectionError" });
      }
      return { id, object: "payment_intent", status: "succeeded", amount: 3000, amount_received: 3000, currency: "eur", customer: null, payment_method: null, receipt_email: null, metadata: { checkout_session_id: session.id }, latest_charge: null, shipping: null };
    });
    const pending = statusRoute.GET(new Request(`https://checkout.example.com/api/public/sessions/${session.id}/status`, { headers: { host: "checkout.example.com" } }), ctx(session.id));
    // Both started before the hanging one answered: parallel.
    await vi.waitFor(() => expect(started).toEqual([newPi, oldPi]));
    releaseNew();
    const body = await (await pending).json();
    expect(body.status).toBe("PAID");
    expect(statusRoute.maxDuration).toBe(30);
  });
});
