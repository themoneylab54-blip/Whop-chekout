import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Express PayPal against a real Postgres: prepare with method "paypal" gets its own PayPal-only
 * Whop checkout (own snapshot, same content), confirm pays with it, a buyer going back to the card
 * gets the regular checkout again, markPaid treats the PayPal checkout like any other, and a store
 * where Whop refuses PayPal hides it. Whop and Shopify are mocked. Test data is prefixed pp_.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
}));
const whop = vi.hoisted(() => ({ createCheckoutConfiguration: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn() }));

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void Promise.resolve().then(fn) }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("express PayPal (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { MethodUnavailableError } = await import("@/lib/whop");
  const { prepareSession, confirmSession, markPaid, CheckoutError, paypalSettingKey, isPaypalFingerprint } = await import("@/lib/checkout");

  const created: string[] = [];
  const line = {
    variantId: "gid://shopify/ProductVariant/77",
    productId: "gid://shopify/Product/7",
    productHandle: "pp-mug",
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
  const buyer = { addOnIds: [], email: "buyer@pp.test", acceptsMarketing: false, acceptsTerms: true, address };

  async function makeSession(currency = "EUR", extra: { store?: Record<string, unknown>; lines?: (typeof line)[] } = {}) {
    const store = await db.store.create({
      data: {
        ...extra.store,
        name: `pp_${Math.random().toString(36).slice(2, 8)}`,
        testMode: true,
        vatExempt: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_pp",
        whopProductId: "prod_pp",
        whopApiKey: encrypt("k"),
        shopDomain: `pp-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
      },
    });
    created.push(store.id);
    return db.checkoutSession.create({ data: { storeId: store.id, currency, lines: extra.lines ?? [line], subtotalCents: 3000 }, include: { store: true } });
  }
  const fresh = (id: string) => db.checkoutSession.findUniqueOrThrow({ where: { id }, include: { store: true } });

  beforeEach(() => {
    vi.clearAllMocks();
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/7001", name: "#7001" });
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) => items.map((i) => ({ ...line, quantity: i.quantity })));
    whop.createCheckoutConfiguration.mockImplementation(async (_store: unknown, o: { methods?: string[] }) => ({
      id: `ch_pp_${o.methods?.join("") ?? "all"}_${Math.random().toString(36).slice(2)}`,
      purchaseUrl: null,
      paypal: true,
    }));
  });

  afterAll(async () => {
    await db.appSetting.deleteMany({ where: { OR: created.flatMap((id) => [{ key: { startsWith: `paypal:${id}` } }, { key: `methods-dropped:${id}` }]) } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("prepares a PayPal-only checkout for the same quote, pays with it, and switches back to the regular one", async () => {
    const session = await makeSession();
    const regular = await prepareSession(session, { addOnIds: [] });
    expect(regular.paypal).toBe(true);
    expect(whop.createCheckoutConfiguration.mock.calls[0][1].methods).toBeUndefined();

    const paypal = await prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" });
    expect(paypal.checkoutConfigurationId).not.toBe(regular.checkoutConfigurationId);
    expect(paypal.paypal).toBe(true);
    const call = whop.createCheckoutConfiguration.mock.calls[1][1];
    expect(call.methods).toEqual(["paypal"]);
    // Same session, amount, currency and return page as the regular checkout.
    expect({ ...call, methods: undefined }).toEqual({ ...whop.createCheckoutConfiguration.mock.calls[0][1], methods: undefined });

    const [a, b] = await Promise.all([
      db.checkoutQuote.findUniqueOrThrow({ where: { whopCheckoutId: regular.checkoutConfigurationId } }),
      db.checkoutQuote.findUniqueOrThrow({ where: { whopCheckoutId: paypal.checkoutConfigurationId } }),
    ]);
    expect(b.fingerprint).toBe(`${a.fingerprint}|m:paypal`);
    expect([b.totalCents, b.subtotalCents, b.currency]).toEqual([a.totalCents, a.subtotalCents, a.currency]);
    expect((await fresh(session.id)).whopCheckoutId).toBe(paypal.checkoutConfigurationId);

    // Prepared again (same quote): reused, no new Whop checkout — for each method.
    expect((await prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" })).checkoutConfigurationId).toBe(paypal.checkoutConfigurationId);
    expect((await prepareSession(await fresh(session.id), { addOnIds: [] })).checkoutConfigurationId).toBe(regular.checkoutConfigurationId);
    expect(whop.createCheckoutConfiguration).toHaveBeenCalledTimes(2);

    // The PayPal checkout paid with a regular choice (back to the card): the regular one instead.
    const back = await confirmSession(await fresh(session.id), { ...buyer, checkoutConfigurationId: paypal.checkoutConfigurationId });
    expect(back).toMatchObject({ ready: false, checkoutConfigurationId: regular.checkoutConfigurationId });
    // And the other way round.
    const toPaypal = await confirmSession(await fresh(session.id), { ...buyer, method: "paypal", checkoutConfigurationId: regular.checkoutConfigurationId });
    expect(toPaypal).toMatchObject({ ready: false, checkoutConfigurationId: paypal.checkoutConfigurationId });

    const ok = await confirmSession(await fresh(session.id), { ...buyer, method: "paypal", checkoutConfigurationId: paypal.checkoutConfigurationId });
    expect(ok).toMatchObject({ ready: true, checkoutConfigurationId: paypal.checkoutConfigurationId });
    const paying = await fresh(session.id);
    expect([paying.status, paying.whopCheckoutId, paying.email]).toEqual(["PAYING", paypal.checkoutConfigurationId, "buyer@pp.test"]);

    // Webhook: the PayPal checkout is an ordinary snapshot of this session.
    await markPaid(session.id, { id: `pay_pp_${session.id}`, totalCents: 3000, currency: "eur", paymentMethodType: "paypal", checkoutConfigurationId: paypal.checkoutConfigurationId });
    const paid = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect([paid.status, paid.paidQuoteId, paid.reviewNote]).toEqual(["PAID", b.id, null]);
    expect(shopify.createPaidOrder).toHaveBeenCalledTimes(1);
  });

  it("hides PayPal once Whop refuses it: prepare says so and a PayPal prepare is rejected without calling Whop", async () => {
    const session = await makeSession();
    whop.createCheckoutConfiguration.mockImplementationOnce(async () => {
      throw new MethodUnavailableError(["paypal"]);
    });
    const err = await prepareSession(session, { addOnIds: [], method: "paypal" }).catch((e) => e);
    expect(err).toBeInstanceOf(CheckoutError);
    expect(err.code).toBe("paypal_unavailable");

    // A regular checkout saying PayPal is on doesn't bring the button back for a day.
    const regular = await prepareSession(await fresh(session.id), { addOnIds: [] });
    expect(regular.paypal).toBe(false);
    await db.appSetting.update({ where: { key: paypalSettingKey(session.storeId, "EUR") }, data: { value: `off:${new Date(Date.now() - 25 * 3600_000).toISOString()}` } });
    const later = await db.checkoutSession.create({ data: { storeId: session.storeId, currency: "EUR", lines: [{ ...line, quantity: 3 }], subtotalCents: 9000 }, include: { store: true } });
    expect((await prepareSession(later, { addOnIds: [] })).paypal).toBe(true);

    whop.createCheckoutConfiguration.mockImplementationOnce(async () => ({ id: `ch_pp_nopaypal_${session.id}`, purchaseUrl: null, paypal: false }));
    const other = await db.checkoutSession.create({ data: { storeId: session.storeId, currency: "EUR", lines: [{ ...line, quantity: 2 }], subtotalCents: 6000 }, include: { store: true } });
    expect((await prepareSession(other, { addOnIds: [] })).paypal).toBe(false);
    const calls = whop.createCheckoutConfiguration.mock.calls.length;
    await expect(prepareSession(await fresh(other.id), { addOnIds: [], method: "paypal" })).rejects.toMatchObject({ code: "paypal_unavailable" });
    expect(whop.createCheckoutConfiguration.mock.calls.length).toBe(calls);
  });

  it("PayPal switched off by the merchant (Paiements express): prepare says so and refuses the PayPal method, pay too", async () => {
    // Allowed first: a PayPal checkout exists for this quote.
    const session = await makeSession();
    const pp = await prepareSession(session, { addOnIds: [], method: "paypal" });
    expect(pp.paypal).toBe(true);

    // The merchant turns PayPal express off (other express settings left at their defaults).
    await db.store.update({ where: { id: session.storeId }, data: { theme: { expressMethods: { paypal: false } } } });
    const regular = await prepareSession(await fresh(session.id), { addOnIds: [] });
    expect(regular.paypal).toBe(false);
    const calls = whop.createCheckoutConfiguration.mock.calls.length;
    await expect(prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" })).rejects.toMatchObject({ code: "paypal_unavailable" });
    // Not even with the PayPal checkout prepared before the switch.
    await expect(
      confirmSession(await fresh(session.id), { ...buyer, method: "paypal", checkoutConfigurationId: pp.checkoutConfigurationId }),
    ).rejects.toMatchObject({ code: "paypal_unavailable" });
    expect(whop.createCheckoutConfiguration.mock.calls.length).toBe(calls);
    expect((await fresh(session.id)).status).not.toBe("PAYING");
    // The card (regular checkout) still pays.
    expect(await confirmSession(await fresh(session.id), { ...buyer, checkoutConfigurationId: regular.checkoutConfigurationId })).toMatchObject({ ready: true });
  });

  it("the express section switched off or hidden (where the PayPal button lives): no PayPal-only checkout, prepare nor pay", async () => {
    const { loadCheckoutLayout } = await import("@/lib/layout");
    for (const patch of [{ theme: { expressCheckout: false } }, { enabled: false }, { hidden: true }] as const) {
      const session = await makeSession();
      const pp = await prepareSession(session, { addOnIds: [], method: "paypal" });
      expect(pp.paypal).toBe(true);
      const blocks = loadCheckoutLayout(null).blocks.map((b) =>
        b.type === "express" ? { ...b, hidden: "hidden" in patch ? patch.hidden : b.hidden, props: { ...b.props, enabled: "enabled" in patch ? patch.enabled : true } } : b,
      );
      await db.store.update({ where: { id: session.storeId }, data: { checkoutLayout: { blocks }, theme: "theme" in patch ? patch.theme : {} } });
      const regular = await prepareSession(await fresh(session.id), { addOnIds: [] });
      expect(regular.paypal).toBe(false);
      await expect(prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" })).rejects.toMatchObject({ code: "paypal_unavailable" });
      await expect(
        confirmSession(await fresh(session.id), { ...buyer, method: "paypal", checkoutConfigurationId: pp.checkoutConfigurationId }),
      ).rejects.toMatchObject({ code: "paypal_unavailable" });
      expect((await fresh(session.id)).status).not.toBe("PAYING");
    }
  });

  it("a transient Whop failure (5xx) on the PayPal checkout never hides PayPal", async () => {
    const session = await makeSession();
    const outage = Object.assign(new Error("Service Unavailable"), { statusCode: 503 });
    whop.createCheckoutConfiguration.mockRejectedValueOnce(outage);
    const err = await prepareSession(session, { addOnIds: [], method: "paypal" }).catch((e) => e);
    expect(err).not.toMatchObject({ code: "paypal_unavailable" });
    expect(await db.appSetting.findUnique({ where: { key: paypalSettingKey(session.storeId, "EUR") } })).toBeNull();
    // Next try goes to Whop again and works.
    const ok = await prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" });
    expect(ok.paypal).toBe(true);
  });

  it("a refusal that doesn't name PayPal makes it unavailable for this session only (nothing remembered)", async () => {
    const session = await makeSession();
    whop.createCheckoutConfiguration.mockImplementationOnce(async () => {
      throw new MethodUnavailableError(["paypal"], false);
    });
    await expect(prepareSession(session, { addOnIds: [], method: "paypal" })).rejects.toMatchObject({ code: "paypal_unavailable" });
    expect(await db.appSetting.findUnique({ where: { key: paypalSettingKey(session.storeId, "EUR") } })).toBeNull();
    // The store keeps offering PayPal (other buyers, a later try).
    expect((await prepareSession(await fresh(session.id), { addOnIds: [] })).paypal).toBe(true);
  });

  it("remembers PayPal per currency: a refusal in EUR doesn't hide it in USD", async () => {
    const eur = await makeSession("EUR");
    whop.createCheckoutConfiguration.mockImplementationOnce(async () => {
      throw new MethodUnavailableError(["paypal"]);
    });
    await expect(prepareSession(eur, { addOnIds: [], method: "paypal" })).rejects.toMatchObject({ code: "paypal_unavailable" });
    expect((await db.appSetting.findUniqueOrThrow({ where: { key: paypalSettingKey(eur.storeId, "EUR") } })).value).toMatch(/^off:/);

    const usd = await db.checkoutSession.create({ data: { storeId: eur.storeId, currency: "USD", lines: [line], subtotalCents: 3000 }, include: { store: true } });
    const res = await prepareSession(usd, { addOnIds: [], method: "paypal" });
    expect(res.paypal).toBe(true);
    expect(whop.createCheckoutConfiguration.mock.calls.at(-1)?.[1]).toMatchObject({ currency: "USD", methods: ["paypal"] });
    // EUR still hidden (no Whop call).
    const calls = whop.createCheckoutConfiguration.mock.calls.length;
    await expect(prepareSession(await fresh(eur.id), { addOnIds: [], method: "paypal" })).rejects.toMatchObject({ code: "paypal_unavailable" });
    expect(whop.createCheckoutConfiguration.mock.calls.length).toBe(calls);
  });

  it("Whop silent about PayPal (null) never turns a remembered 'off' back on", async () => {
    const session = await makeSession();
    await db.appSetting.create({ data: { key: paypalSettingKey(session.storeId, "EUR"), value: "off" } });
    whop.createCheckoutConfiguration.mockImplementationOnce(async () => ({ id: `ch_pp_silent_${session.id}`, purchaseUrl: null, paypal: null }));
    expect((await prepareSession(session, { addOnIds: [] })).paypal).toBe(false);
    expect((await db.appSetting.findUniqueOrThrow({ where: { key: paypalSettingKey(session.storeId, "EUR") } })).value).toBe("off");
  });

  it("an expired refusal (off:<date> over 24 h old) no longer hides PayPal, even left in place", async () => {
    const { paypalOffered } = await import("@/lib/checkout");
    const session = await makeSession();
    const key = paypalSettingKey(session.storeId, "EUR");
    await db.appSetting.create({ data: { key, value: `off:${new Date(Date.now() - 25 * 3600_000).toISOString()}` } });
    expect(await paypalOffered(session.storeId, "EUR")).toBe(true);
    // A PayPal prepare goes to Whop again (no stale rejection).
    const pp = await prepareSession(session, { addOnIds: [], method: "paypal" });
    expect(pp.paypal).toBe(true);
    // Still holding (under 24 h) or a plain "off": hidden.
    await db.appSetting.update({ where: { key }, data: { value: `off:${new Date(Date.now() - 3600_000).toISOString()}` } });
    expect(await paypalOffered(session.storeId, "EUR")).toBe(false);
    await db.appSetting.update({ where: { key }, data: { value: "off" } });
    expect(await paypalOffered(session.storeId, "EUR")).toBe(false);
    await db.appSetting.delete({ where: { key } });
    expect(await paypalOffered(session.storeId, "EUR")).toBe(true);
  });

  it("markPaid keeps the form's address for a PayPal payment (not PayPal's account address)", async () => {
    const session = await makeSession();
    const paypal = await prepareSession(session, { addOnIds: [], method: "paypal" });
    await confirmSession(await fresh(session.id), { ...buyer, method: "paypal", checkoutConfigurationId: paypal.checkoutConfigurationId });
    const paypalAddress = { name: "Other Person", line1: "9 PayPal St", line2: null, city: "Lyon", state: null, postal_code: "69001", country: "FR" };
    await markPaid(session.id, {
      id: `pay_ppaddr_${session.id}`,
      totalCents: 3000,
      currency: "eur",
      paymentMethodType: "paypal",
      checkoutConfigurationId: paypal.checkoutConfigurationId,
      buyer: { email: "pp@paypal.test", shippingAddress: paypalAddress, address: paypalAddress, phone: null },
    });
    const paid = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(paid.status).toBe("PAID");
    expect(paid.shippingAddress).toMatchObject({ address1: "1 rue X", city: "Paris", firstName: "Alex" });
  });

  it("markPaid still knows a PayPal checkout made on the store's checkout domain (host suffix after the method)", async () => {
    const domain = `checkout.pp-${Math.random().toString(36).slice(2, 8)}.test`;
    const session = await makeSession("EUR", { store: { checkoutDomain: domain, checkoutDomainVerifiedAt: new Date() } });
    const paypal = await prepareSession(session, { addOnIds: [], method: "paypal" }, { host: domain });
    const snap = await db.checkoutQuote.findUniqueOrThrow({ where: { whopCheckoutId: paypal.checkoutConfigurationId } });
    expect(snap.fingerprint).toMatch(new RegExp(`\\|m:paypal\\|h:${domain.replace(/\./g, "\\.")}$`));
    expect(isPaypalFingerprint(snap.fingerprint)).toBe(true);
    expect(isPaypalFingerprint(snap.fingerprint.replace("|m:paypal", ""))).toBe(false);
    await confirmSession(await fresh(session.id), { ...buyer, method: "paypal", checkoutConfigurationId: paypal.checkoutConfigurationId }, { host: domain });
    // Whop doesn't say the method: only the fingerprint tells it was the PayPal-only checkout.
    const walletAddress = { name: "Other Person", line1: "9 PayPal St", line2: null, city: "Lyon", state: null, postal_code: "69001", country: "FR" };
    await markPaid(session.id, {
      id: `pay_ppdom_${session.id}`,
      totalCents: 3000,
      currency: "eur",
      paymentMethodType: null,
      checkoutConfigurationId: paypal.checkoutConfigurationId,
      buyer: { email: "pp@paypal.test", shippingAddress: walletAddress, address: walletAddress, phone: null },
    });
    const paid = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(paid.status).toBe("PAID");
    expect(paid.shippingAddress).toMatchObject({ address1: "1 rue X", city: "Paris" });
  });

  it("status route: paymentInFlight only within 30 s of the Pay click on a PAYING session, never the timestamp", async () => {
    const statusRoute = await import("@/app/api/public/sessions/[id]/status/route");
    const session = await makeSession();
    const ctx = { params: Promise.resolve({ id: session.id }) };
    const get = async () => {
      const res = await statusRoute.GET(new Request(`https://checkout.example.com/api/public/sessions/${session.id}/status`, { headers: { host: "checkout.example.com" } }), ctx);
      expect(res.status).toBe(200);
      return (await res.json()) as Record<string, unknown>;
    };
    const set = (data: { status?: "OPEN" | "PAYING" | "PAID"; payClickedAt?: Date | null }) => db.checkoutSession.update({ where: { id: session.id }, data });

    let body = await get();
    expect(body.paymentInFlight).toBe(false);
    await set({ status: "PAYING", payClickedAt: new Date(Date.now() - 5_000) });
    body = await get();
    expect(body).toMatchObject({ status: "PAYING", paymentInFlight: true });
    expect(body).not.toHaveProperty("payClickedAt");
    expect(JSON.stringify(body)).not.toMatch(/payClickedAt/);
    await set({ payClickedAt: new Date(Date.now() - 29_000) });
    expect((await get()).paymentInFlight).toBe(true);
    await set({ payClickedAt: new Date(Date.now() - 31_000) });
    body = await get();
    expect(body.paymentInFlight).toBe(false);
    expect(body).not.toHaveProperty("payClickedAt");
    // PAYING without a click time, or already PAID: nothing in flight.
    await set({ payClickedAt: null });
    expect((await get()).paymentInFlight).toBe(false);
    await set({ status: "PAID", payClickedAt: new Date() });
    expect(await get()).toMatchObject({ status: "PAID", paymentInFlight: false });
  });

  it("paypal-window route: a window from Whop's own button reports the payment in flight (confirmed, unpaid sessions only; host-guarded)", async () => {
    const statusRoute = await import("@/app/api/public/sessions/[id]/status/route");
    const windowRoute = await import("@/app/api/public/sessions/[id]/paypal-window/route");
    const session = await makeSession();
    const ctx = { params: Promise.resolve({ id: session.id }) };
    const ip = `10.79.${Math.floor(Math.random() * 250)}.1`;
    const post = (host = "checkout.example.com", extra: Record<string, string> = {}) =>
      windowRoute.POST(new Request(`https://${host}/api/public/sessions/${session.id}/paypal-window`, { method: "POST", headers: { host, "x-forwarded-for": ip, ...extra } }), ctx);
    const inFlight = async () => ((await (await statusRoute.GET(new Request(`https://checkout.example.com/api/public/sessions/${session.id}/status`, { headers: { host: "checkout.example.com" } }), ctx)).json()) as { paymentInFlight: boolean }).paymentInFlight;
    const set = (data: { status?: "OPEN" | "PAYING" | "PAID" | "FAILED" | "ABANDONED"; payClickedAt?: Date | null; paypalWindowAt?: Date | null; whopCheckoutId?: string | null }) =>
      db.checkoutSession.update({ where: { id: session.id }, data });

    // Never confirmed (no Pay click, no checkout): nothing marked.
    expect(await (await post()).json()).toMatchObject({ ok: true, marked: false });
    expect((await fresh(session.id)).status).toBe("OPEN");
    // Confirmed long ago (the first window blocked), then Whop's button opens PayPal: in flight again.
    const clickedAt = new Date(Date.now() - 5 * 60_000);
    await set({ status: "FAILED", payClickedAt: clickedAt, whopCheckoutId: `ch_pw_${session.id}` });
    expect(await inFlight()).toBe(false);
    // Cross-site requests (another site making the buyer's browser post): refused, nothing touched.
    expect((await post("checkout.example.com", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post("checkout.example.com", { origin: "https://evil.test" })).status).toBe(403);
    expect((await post("checkout.example.com", { origin: "null" })).status).toBe(403);
    expect((await fresh(session.id)).status).toBe("FAILED");
    // The page's own same-origin fetch: marked. A FAILED session stays FAILED (only the window time).
    expect(await (await post("checkout.example.com", { "sec-fetch-site": "same-origin", origin: "https://checkout.example.com" })).json()).toMatchObject({ ok: true, marked: true });
    const marked = await fresh(session.id);
    expect(marked.status).toBe("FAILED");
    // The buyer's own "Pay" click (order timeline) is left alone; the window has its own time.
    expect(marked.payClickedAt?.getTime()).toBe(clickedAt.getTime());
    expect(marked.paypalWindowAt).toBeInstanceOf(Date);
    // The status route counts that window for the FAILED session too…
    expect(await inFlight()).toBe(true);
    // …but only a window after the failed attempt, and only within 30 s.
    await set({ paypalWindowAt: new Date(clickedAt.getTime() - 1_000) });
    expect(await inFlight()).toBe(false);
    await set({ payClickedAt: new Date(Date.now() - 40_000), paypalWindowAt: new Date(Date.now() - 31_000) });
    expect(await inFlight()).toBe(false);
    // An OPEN/PAYING session is (re)marked PAYING.
    await set({ status: "OPEN", payClickedAt: clickedAt, paypalWindowAt: null });
    expect(await (await post()).json()).toMatchObject({ ok: true, marked: true });
    expect((await fresh(session.id)).status).toBe("PAYING");
    expect(await inFlight()).toBe(true);
    // In flight from the later of the two: an old window after a recent click, or the reverse.
    await set({ paypalWindowAt: new Date(Date.now() - 31_000) });
    expect(await inFlight()).toBe(false);
    await set({ payClickedAt: new Date(Date.now() - 5_000) });
    expect(await inFlight()).toBe(true);
    await set({ payClickedAt: clickedAt, paypalWindowAt: new Date(Date.now() - 5_000) });
    expect(await inFlight()).toBe(true);
    // An abandoned session is never brought back to PAYING.
    await set({ status: "ABANDONED", paypalWindowAt: null });
    expect(await (await post()).json()).toMatchObject({ ok: true, marked: false });
    expect(await fresh(session.id)).toMatchObject({ status: "ABANDONED", paypalWindowAt: null });
    // Another store's checkout domain: 404, nothing touched.
    await set({ status: "OPEN" });
    expect((await post("pay.someone-else.test")).status).toBe(404);
    expect((await fresh(session.id)).status).toBe("OPEN");
    // Already paid: stays paid.
    await set({ status: "PAID" });
    expect(await (await post()).json()).toMatchObject({ ok: true, marked: false });
    expect((await fresh(session.id)).status).toBe("PAID");
    // Rate-limited per session.
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await post()).status;
    expect(last).toBe(429);
  });

  it("pay refuses another method while a payment is in flight (payment_in_flight); the same method and a FAILED session pass", async () => {
    const { inFlightMethod } = await import("@/lib/checkout");
    const session = await makeSession();
    const regular = await prepareSession(session, { addOnIds: [] });
    const paypal = await prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" });
    const card = async () => confirmSession(await fresh(session.id), { ...buyer, checkoutConfigurationId: regular.checkoutConfigurationId });
    const pp = async () => confirmSession(await fresh(session.id), { ...buyer, method: "paypal", checkoutConfigurationId: paypal.checkoutConfigurationId });
    const method = async () => inFlightMethod(await fresh(session.id));

    // PayPal confirmed (window open): the card is refused, PayPal again passes.
    expect(await pp()).toMatchObject({ ready: true });
    expect(await method()).toBe("paypal");
    await expect(card()).rejects.toMatchObject({ code: "payment_in_flight" });
    expect(await pp()).toMatchObject({ ready: true });
    // A later prepare (second tab) replacing whopCheckoutId doesn't change the in-flight method.
    await prepareSession(await fresh(session.id), { addOnIds: [] });
    await expect(card()).rejects.toMatchObject({ code: "payment_in_flight" });

    // Over 30 s: nothing in flight any more, the card passes.
    await db.checkoutSession.update({ where: { id: session.id }, data: { payClickedAt: new Date(Date.now() - 31_000), paypalWindowAt: new Date(Date.now() - 31_000) } });
    expect(await card()).toMatchObject({ ready: true });
    expect(await method()).toBe("other");
    // Card in flight: a card retry passes, PayPal is refused.
    expect(await card()).toMatchObject({ ready: true });
    await expect(pp()).rejects.toMatchObject({ code: "payment_in_flight" });
    // The card failed (webhook): any method passes, card retry included.
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "FAILED" } });
    expect(await method()).toBeNull();
    expect(await card()).toMatchObject({ ready: true });
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "FAILED" } });
    expect(await pp()).toMatchObject({ ready: true });
    // A PayPal window from Whop's own button after a card click: PayPal is the latest attempt.
    expect(inFlightMethod({ status: "PAYING", payClickedAt: new Date(Date.now() - 10_000), paypalWindowAt: new Date(Date.now() - 2_000), paypalBeatAt: null })).toBe("paypal");
    expect(inFlightMethod({ status: "PAYING", payClickedAt: new Date(Date.now() - 2_000), paypalWindowAt: new Date(Date.now() - 10_000), paypalBeatAt: null })).toBe("other");
    expect(inFlightMethod({ status: "OPEN", payClickedAt: new Date(), paypalWindowAt: null, paypalBeatAt: null })).toBeNull();
  });

  it("one formula: a FAILED card then a fresh PayPal window (Whop's button) refuses a card confirm, as the status route says", async () => {
    const { inFlightMethod } = await import("@/lib/checkout");
    const statusRoute = await import("@/app/api/public/sessions/[id]/status/route");
    const session = await makeSession();
    const regular = await prepareSession(session, { addOnIds: [] });
    const ctx = { params: Promise.resolve({ id: session.id }) };
    const inFlight = async () => ((await (await statusRoute.GET(new Request(`https://checkout.example.com/api/public/sessions/${session.id}/status`, { headers: { host: "checkout.example.com" } }), ctx)).json()) as { paymentInFlight: boolean }).paymentInFlight;
    const card = async () => confirmSession(await fresh(session.id), { ...buyer, checkoutConfigurationId: regular.checkoutConfigurationId });
    const clicked = new Date(Date.now() - 20_000);
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "FAILED", payClickedAt: clicked, paypalWindowAt: new Date(Date.now() - 2_000) } });
    expect(inFlightMethod(await fresh(session.id))).toBe("paypal");
    expect(await inFlight()).toBe(true);
    await expect(card()).rejects.toMatchObject({ code: "payment_in_flight" });
    // The window older than the failed click, or over 30 s old: nothing in flight, the card passes.
    await db.checkoutSession.update({ where: { id: session.id }, data: { paypalWindowAt: new Date(clicked.getTime() - 1_000) } });
    expect(inFlightMethod(await fresh(session.id))).toBeNull();
    expect(await inFlight()).toBe(false);
    await db.checkoutSession.update({ where: { id: session.id }, data: { payClickedAt: new Date(Date.now() - 60_000), paypalWindowAt: new Date(Date.now() - 31_000) } });
    expect(await inFlight()).toBe(false);
    expect(await card()).toMatchObject({ ready: true });
    // Pure: the same answers for every status the route can see.
    const now = Date.now();
    const at = (ago: number) => new Date(now - ago);
    for (const [s, click, win, want] of [
      ["FAILED", at(20_000), at(2_000), "paypal"],
      ["FAILED", at(2_000), at(20_000), null],
      ["FAILED", at(2_000), at(2_000), null],
      ["FAILED", at(60_000), at(31_000), null],
      ["PAYING", at(2_000), null, "other"],
      ["OPEN", at(2_000), at(2_000), null],
      ["PAID", at(2_000), at(2_000), null],
      ["ABANDONED", at(2_000), at(2_000), null],
    ] as const) {
      expect(inFlightMethod({ status: s, payClickedAt: click, paypalWindowAt: win, paypalBeatAt: null }, now), `${s}`).toBe(want);
    }
    // The heartbeat (paypalBeatAt): liveness only, always PayPal, the latest of the three times.
    for (const [s, click, win, beat, want] of [
      // A long PayPal window: click and window 5 min old, a beat 5 s ago keeps it in flight.
      ["PAYING", at(300_000), at(300_000), at(5_000), "paypal"],
      ["PAYING", at(300_000), at(300_000), at(31_000), null],
      // A card clicked after the last beat: the card is the latest attempt.
      ["PAYING", at(2_000), at(300_000), at(10_000), "other"],
      // A late popup after a "blocked" verdict (session back to OPEN): only a beat after the click.
      ["OPEN", at(4_000), null, at(1_000), "paypal"],
      ["OPEN", at(4_000), null, at(10_000), null],
      ["OPEN", at(60_000), null, at(31_000), null],
      // A FAILED card, then a PayPal window still beating.
      ["FAILED", at(20_000), null, at(2_000), "paypal"],
      ["FAILED", at(2_000), null, at(20_000), null],
      ["PAID", at(2_000), at(2_000), at(1_000), null],
      ["ABANDONED", at(2_000), null, at(1_000), null],
    ] as const) {
      expect(inFlightMethod({ status: s, payClickedAt: click, paypalWindowAt: win, paypalBeatAt: beat }, now), `${s} beat`).toBe(want);
    }
  });

  it("two simultaneous confirms with different methods: only one passes, the other gets payment_in_flight", async () => {
    const session = await makeSession();
    const regular = await prepareSession(session, { addOnIds: [] });
    const paypal = await prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" });
    for (let i = 0; i < 3; i++) {
      // Both read the same state (nothing in flight) before either writes.
      await db.checkoutSession.update({ where: { id: session.id }, data: { status: "OPEN", payClickedAt: null, paypalWindowAt: null } });
      const s = await fresh(session.id);
      const results = await Promise.allSettled([
        confirmSession(s, { ...buyer, checkoutConfigurationId: regular.checkoutConfigurationId }),
        confirmSession(s, { ...buyer, method: "paypal", checkoutConfigurationId: paypal.checkoutConfigurationId }),
      ]);
      const ok = results.filter((r) => r.status === "fulfilled");
      const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
      expect(ok).toHaveLength(1);
      expect((ok[0] as PromiseFulfilledResult<{ ready: boolean }>).value).toMatchObject({ ready: true });
      expect(refused).toHaveLength(1);
      expect(refused[0].reason).toMatchObject({ code: "payment_in_flight" });
      // The session holds the winner's method.
      const winner = results[0].status === "fulfilled" ? "other" : "paypal";
      const { inFlightMethod } = await import("@/lib/checkout");
      expect(inFlightMethod(await fresh(session.id))).toBe(winner);
    }
    // The same method twice at once (a double click): both go through.
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "OPEN", payClickedAt: null, paypalWindowAt: null } });
    const s = await fresh(session.id);
    const same = await Promise.all([
      confirmSession(s, { ...buyer, checkoutConfigurationId: regular.checkoutConfigurationId }),
      confirmSession(s, { ...buyer, checkoutConfigurationId: regular.checkoutConfigurationId }),
    ]);
    expect(same.map((r) => r.ready)).toEqual([true, true]);
  });

  it("a late payment.failed of an earlier attempt never erases a newer one (created before the latest click or window)", async () => {
    const { handleEvent, paymentCreatedAt } = await import("@/lib/webhooks");
    const { inFlightMethod } = await import("@/lib/checkout");
    const session = await makeSession();
    const failed = (createdAt: unknown) => handleEvent("payment.failed", { id: `pay_f_${Math.random().toString(36).slice(2)}`, metadata: { checkout_session_id: session.id }, created_at: createdAt, failure_message: "declined" }, session.storeId);
    // A newer PayPal attempt (confirm 2 s ago); the failure is of a card payment created 10 s ago.
    const clicked = new Date(Date.now() - 2_000);
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "PAYING", payClickedAt: clicked, paypalWindowAt: clicked } });
    await failed(new Date(Date.now() - 10_000).toISOString());
    let s = await fresh(session.id);
    expect(s.status).toBe("PAYING");
    // A real decline all the same: counted for the analytics (the status of the newer attempt kept).
    expect(s.paymentFailedAt).toBeInstanceOf(Date);
    const firstFailedAt = s.paymentFailedAt!.getTime();
    expect(inFlightMethod(s)).toBe("paypal");
    // Journaled all the same (as an earlier attempt).
    const events = await db.eventLog.findMany({ where: { sessionId: session.id, kind: "payment.failed" } });
    expect(events).toHaveLength(1);
    expect(events[0].message).toMatch(/tentative antérieure/);
    // A window from Whop's button after the failed payment counts too (a click before it doesn't save it).
    await db.checkoutSession.update({ where: { id: session.id }, data: { payClickedAt: new Date(Date.now() - 60_000), paypalWindowAt: new Date(Date.now() - 1_000) } });
    await failed(Math.floor((Date.now() - 10_000) / 1000));
    expect((await fresh(session.id)).status).toBe("PAYING");
    // Only the first decline's time is kept by a stale one (never moved forward).
    expect((await fresh(session.id)).paymentFailedAt?.getTime()).toBe(firstFailedAt);
    // The failure of the latest attempt (created after its click): FAILED.
    await failed(new Date(Date.now()).toISOString());
    s = await fresh(session.id);
    expect(s.status).toBe("FAILED");
    expect(s.paymentFailedAt).toBeInstanceOf(Date);
    // No creation time: counted as the latest (as before).
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "PAYING", paymentFailedAt: null, payClickedAt: new Date(), paypalWindowAt: null } });
    await failed(undefined);
    expect((await fresh(session.id)).status).toBe("FAILED");
    // A paid session is never touched.
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "PAID" } });
    await failed(new Date().toISOString());
    expect((await fresh(session.id)).status).toBe("PAID");
    // Creation time formats.
    expect(paymentCreatedAt({ created_at: "2026-01-02T03:04:05Z" })?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(paymentCreatedAt({ created_at: 1767323045 })?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(paymentCreatedAt({ created_at: 1767323045000 })?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(paymentCreatedAt({ created_at: "1767323045" })?.toISOString()).toBe("2026-01-02T03:04:05.000Z");
    expect(paymentCreatedAt({ created_at: "nope" })).toBeNull();
    expect(paymentCreatedAt({})).toBeNull();
  });

  it("payment.failed stale rule: payClickedAt strict (created_at + 1 s), paypalWindowAt 5 s, paypalBeatAt never compared", async () => {
    const { handleEvent } = await import("@/lib/webhooks");
    const session = await makeSession();
    const failed = (createdAt: unknown) => handleEvent("payment.failed", { id: `pay_t_${Math.random().toString(36).slice(2)}`, metadata: { checkout_session_id: session.id }, created_at: createdAt, failure_message: "declined" }, session.storeId);
    const S = Math.floor(Date.now() / 1000) * 1000 - 60_000;
    const at = (ms: number) => new Date(S + ms);
    type Row = [label: string, times: { payClickedAt: Date | null; paypalWindowAt: Date | null; paypalBeatAt?: Date | null }, createdAt: number, want: "FAILED" | "PAYING"];
    const rows: Row[] = [
      // Whop's created_at is second precision (truncated): the click 700 ms into that very second.
      ["card, created_at = click second", { payClickedAt: at(700), paypalWindowAt: null }, S, "FAILED"],
      ["PayPal confirm, created_at = click second", { payClickedAt: at(700), paypalWindowAt: at(700) }, S, "FAILED"],
      // A slow submit: the payment created 3 s after the click. Still this attempt.
      ["click 3 s before creation", { payClickedAt: at(700), paypalWindowAt: null }, S + 3_000, "FAILED"],
      // The payment created 3 s before the latest click: an earlier attempt.
      ["created 3 s before the click", { payClickedAt: at(3_700), paypalWindowAt: null }, S, "PAYING"],
      // A quick card retry: the first payment created at S (clicked S+0.1), the retry clicked 2 s
      // later: the first failure never marks FAILED while the retry is in flight.
      ["card retry 2 s later", { payClickedAt: at(2_100), paypalWindowAt: null }, S, "PAYING"],
      ["PayPal retry 2 s later", { payClickedAt: at(2_100), paypalWindowAt: at(2_100) }, S, "PAYING"],
      // Whop's own button: the payment created by that click, our window stamp lands after it.
      ["Whop window stamped 3 s after creation", { payClickedAt: at(-60_000), paypalWindowAt: at(3_000) }, S, "FAILED"],
      ["Whop window 6 s after creation", { payClickedAt: at(-60_000), paypalWindowAt: at(6_000) }, S, "PAYING"],
      // The heartbeat of a long PayPal window (beat 40 s after the payment): the current attempt's
      // own failure all the same.
      ["heartbeat long after", { payClickedAt: at(700), paypalWindowAt: at(700), paypalBeatAt: at(40_000) }, S, "FAILED"],
      ["late popup beat after a card click", { payClickedAt: at(700), paypalWindowAt: null, paypalBeatAt: at(5_000) }, S, "FAILED"],
    ];
    for (const [label, times, createdAt, want] of rows) {
      await db.checkoutSession.update({ where: { id: session.id }, data: { status: "PAYING", paymentFailedAt: null, paypalBeatAt: null, ...times } });
      await failed(Math.floor(createdAt / 1000));
      const s = await fresh(session.id);
      expect(s.status, label).toBe(want);
      // A real decline either way: counted by the analytics.
      expect(s.paymentFailedAt, label).toBeInstanceOf(Date);
    }
  });

  it("paypal-window { blocked: true }: our PayPal confirm's attempt is dropped (card switch at once); nothing else is touched", async () => {
    const statusRoute = await import("@/app/api/public/sessions/[id]/status/route");
    const windowRoute = await import("@/app/api/public/sessions/[id]/paypal-window/route");
    const session = await makeSession();
    const regular = await prepareSession(session, { addOnIds: [] });
    const paypal = await prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" });
    const ctx = { params: Promise.resolve({ id: session.id }) };
    const ip = `10.80.${Math.floor(Math.random() * 250)}.1`;
    const blocked = (host = "checkout.example.com", extra: Record<string, string> = {}) =>
      windowRoute.POST(
        new Request(`https://${host}/api/public/sessions/${session.id}/paypal-window`, {
          method: "POST",
          headers: { host, "x-forwarded-for": ip, "content-type": "application/json", ...extra },
          body: JSON.stringify({ blocked: true }),
        }),
        ctx,
      );
    const inFlight = async () => ((await (await statusRoute.GET(new Request(`https://checkout.example.com/api/public/sessions/${session.id}/status`, { headers: { host: "checkout.example.com" } }), ctx)).json()) as { paymentInFlight: boolean }).paymentInFlight;
    const card = async () => confirmSession(await fresh(session.id), { ...buyer, checkoutConfigurationId: regular.checkoutConfigurationId });
    const pp = async () => confirmSession(await fresh(session.id), { ...buyer, method: "paypal", checkoutConfigurationId: paypal.checkoutConfigurationId });

    // PayPal confirmed, its window blocked: the card is refused until the server is told.
    expect(await pp()).toMatchObject({ ready: true });
    await expect(card()).rejects.toMatchObject({ code: "payment_in_flight" });
    // Same guards as the window signal: cross-site and another store's domain refused, nothing touched.
    expect((await blocked("checkout.example.com", { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await blocked("pay.someone-else.test")).status).toBe(404);
    expect(await inFlight()).toBe(true);
    const before = await fresh(session.id);
    expect(await (await blocked()).json()).toMatchObject({ ok: true, cleared: true });
    const after = await fresh(session.id);
    expect(after).toMatchObject({ status: "OPEN", paypalWindowAt: null });
    // The buyer's click stays in the order's timeline.
    expect(after.payClickedAt?.getTime()).toBe(before.payClickedAt?.getTime());
    expect(await inFlight()).toBe(false);
    // The card now passes at once, and PayPal again too.
    expect(await card()).toMatchObject({ ready: true });
    // A card attempt since (window older than the click): a late "blocked" leaves it alone.
    await db.checkoutSession.update({ where: { id: session.id }, data: { paypalWindowAt: new Date(Date.now() - 10_000) } });
    const cardState = await fresh(session.id);
    expect(await (await blocked()).json()).toMatchObject({ ok: true, cleared: false });
    expect(await fresh(session.id)).toMatchObject({ status: "PAYING", paypalWindowAt: cardState.paypalWindowAt, payClickedAt: cardState.payClickedAt });
    // A window from Whop's own button since (window after the click): left alone too.
    await db.checkoutSession.update({ where: { id: session.id }, data: { paypalWindowAt: new Date() } });
    expect(await (await blocked()).json()).toMatchObject({ ok: true, cleared: false });
    expect(await inFlight()).toBe(true);
    // A FAILED or PAID session: never touched.
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "FAILED", paypalWindowAt: (await fresh(session.id)).payClickedAt } });
    expect(await (await blocked()).json()).toMatchObject({ ok: true, cleared: false });
    expect((await fresh(session.id)).status).toBe("FAILED");
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "PAID" } });
    expect(await (await blocked()).json()).toMatchObject({ ok: true, cleared: false });
    expect((await fresh(session.id)).status).toBe("PAID");
    // Shares the route's rate limit.
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await blocked()).status;
    expect(last).toBe(429);
  });

  it("paypal-window { beat } / { closed }: liveness only (paypalBeatAt), never an attempt; closed ends it ~10 s later; confirm's CAS sees a beat", async () => {
    const statusRoute = await import("@/app/api/public/sessions/[id]/status/route");
    const windowRoute = await import("@/app/api/public/sessions/[id]/paypal-window/route");
    const { inFlightMethod } = await import("@/lib/checkout");
    const { PAYPAL_AFTER_WINDOW_MS, PAYPAL_SERVER_IN_FLIGHT_MS } = await import("@/lib/paypal-timing");
    const session = await makeSession();
    const regular = await prepareSession(session, { addOnIds: [] });
    const paypal = await prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" });
    const ctx = { params: Promise.resolve({ id: session.id }) };
    const ip = `10.81.${Math.floor(Math.random() * 250)}.1`;
    const post = (body: unknown, extra: Record<string, string> = {}) =>
      windowRoute.POST(
        new Request(`https://checkout.example.com/api/public/sessions/${session.id}/paypal-window`, {
          method: "POST",
          headers: { host: "checkout.example.com", "x-forwarded-for": ip, "content-type": "application/json", ...extra },
          body: JSON.stringify(body),
        }),
        ctx,
      );
    const inFlight = async () => ((await (await statusRoute.GET(new Request(`https://checkout.example.com/api/public/sessions/${session.id}/status`, { headers: { host: "checkout.example.com" } }), ctx)).json()) as { paymentInFlight: boolean }).paymentInFlight;
    const card = async (s?: Awaited<ReturnType<typeof fresh>>) => confirmSession(s ?? (await fresh(session.id)), { ...buyer, checkoutConfigurationId: regular.checkoutConfigurationId });
    const pp = async () => confirmSession(await fresh(session.id), { ...buyer, method: "paypal", checkoutConfigurationId: paypal.checkoutConfigurationId });

    // Never confirmed: no beat.
    expect(await (await post({ beat: true })).json()).toMatchObject({ ok: true, beat: false });
    expect((await fresh(session.id)).paypalBeatAt).toBeNull();
    // Cross-site: refused, nothing touched.
    expect((await post({ beat: true }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    // Our PayPal confirm, then a long window: click and window 5 min old, a beat now keeps it in
    // flight (the card refused) without touching the attempt's times or status.
    expect(await pp()).toMatchObject({ ready: true });
    const old = new Date(Date.now() - 5 * 60_000);
    await db.checkoutSession.update({ where: { id: session.id }, data: { payClickedAt: old, paypalWindowAt: old } });
    expect(await inFlight()).toBe(false);
    expect(await (await post({ beat: true })).json()).toMatchObject({ ok: true, beat: true });
    let s = await fresh(session.id);
    expect(s).toMatchObject({ status: "PAYING", payClickedAt: old, paypalWindowAt: old });
    expect(s.paypalBeatAt).toBeInstanceOf(Date);
    expect(inFlightMethod(s)).toBe("paypal");
    expect(await inFlight()).toBe(true);
    await expect(card()).rejects.toMatchObject({ code: "payment_in_flight" });
    // Window closed: the beat is lowered so it counts ~10 s more, no longer.
    const closedAt = Date.now();
    expect(await (await post({ closed: true })).json()).toMatchObject({ ok: true, lowered: true });
    s = await fresh(session.id);
    const lowered = s.paypalBeatAt!.getTime();
    expect(lowered).toBeGreaterThanOrEqual(closedAt - (PAYPAL_SERVER_IN_FLIGHT_MS - PAYPAL_AFTER_WINDOW_MS) - 50);
    expect(lowered).toBeLessThanOrEqual(Date.now() - (PAYPAL_SERVER_IN_FLIGHT_MS - PAYPAL_AFTER_WINDOW_MS));
    expect(inFlightMethod(s)).toBe("paypal");
    expect(inFlightMethod(s, closedAt + PAYPAL_AFTER_WINDOW_MS + 100)).toBeNull();
    // Never raised: an older beat stays as it is.
    const older = new Date(Date.now() - 25_000);
    await db.checkoutSession.update({ where: { id: session.id }, data: { paypalBeatAt: older } });
    expect(await (await post({ closed: true })).json()).toMatchObject({ ok: true, lowered: false });
    expect((await fresh(session.id)).paypalBeatAt?.getTime()).toBe(older.getTime());

    // confirmSession's compare-and-set includes the beat: a FAILED card read before a beat landed
    // (nothing in flight in that read) is refused once the beat is seen.
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "FAILED", payClickedAt: old, paypalWindowAt: null, paypalBeatAt: null } });
    const stale = await fresh(session.id);
    expect(inFlightMethod(stale)).toBeNull();
    expect(await (await post({ beat: true })).json()).toMatchObject({ ok: true, beat: true });
    // A FAILED session stays FAILED (a beat is no attempt).
    expect((await fresh(session.id)).status).toBe("FAILED");
    await expect(card(stale)).rejects.toMatchObject({ code: "payment_in_flight" });
    // An OPEN one (a blocked window dropped, then our popup opening late): stays OPEN, in flight.
    await db.checkoutSession.update({ where: { id: session.id }, data: { status: "OPEN", payClickedAt: new Date(Date.now() - 4_000), paypalBeatAt: null } });
    expect(await (await post({ beat: true })).json()).toMatchObject({ ok: true, beat: true });
    expect((await fresh(session.id)).status).toBe("OPEN");
    expect(await inFlight()).toBe(true);
    await expect(card()).rejects.toMatchObject({ code: "payment_in_flight" });
    // Paid or abandoned: never.
    for (const status of ["PAID", "ABANDONED"] as const) {
      await db.checkoutSession.update({ where: { id: session.id }, data: { status, paypalBeatAt: null } });
      expect(await (await post({ beat: true })).json(), status).toMatchObject({ ok: true, beat: false });
      expect((await fresh(session.id)).paypalBeatAt, status).toBeNull();
    }
  });

  it("dashboard banner: one line per hidden currency, each with its own state and date", async () => {
    const { paypalHiddenLines } = await import("@/lib/checkout");
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    expect(
      paypalHiddenLines(
        [
          { currency: "EUR", since: new Date("2026-09-27T10:00:00Z") },
          { currency: "GBP", since: null },
          { currency: "USD", since: new Date("2026-09-28T08:00:00Z") },
        ],
        fmt,
      ),
    ).toEqual(["EUR : refusé par Whop le 2026-09-27 (masqué 24 h)", "GBP : Whop ne le propose pas", "USD : refusé par Whop le 2026-09-28 (masqué 24 h)"]);
    expect(paypalHiddenLines([], fmt)).toEqual([]);
  });

  it("/pay with method paypal and a stale checkout answers paypal_unavailable once Whop refused PayPal meanwhile", async () => {
    const payRoute = await import("@/app/api/public/sessions/[id]/pay/route");
    const session = await makeSession();
    const regular = await prepareSession(session, { addOnIds: [] });
    await prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" });
    // Whop refused a PayPal-only checkout in the meantime (another buyer): held off for a day.
    await db.appSetting.upsert({
      where: { key: paypalSettingKey(session.storeId, "EUR") },
      create: { key: paypalSettingKey(session.storeId, "EUR"), value: `off:${new Date().toISOString()}` },
      update: { value: `off:${new Date().toISOString()}` },
    });
    const calls = whop.createCheckoutConfiguration.mock.calls.length;
    // The page still holds a checkout whose fingerprint isn't this PayPal quote's (stale): the
    // server would prepare a fresh PayPal one, and refuses instead.
    const res = await payRoute.POST(
      new Request(`https://checkout.example.com/api/public/sessions/${session.id}/pay`, {
        method: "POST",
        headers: { host: "checkout.example.com", "content-type": "application/json", "x-forwarded-for": `10.77.${Math.floor(Math.random() * 250)}.1` },
        body: JSON.stringify({ ...buyer, method: "paypal", checkoutConfigurationId: regular.checkoutConfigurationId }),
      }),
      { params: Promise.resolve({ id: session.id }) },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "paypal_unavailable" });
    expect(whop.createCheckoutConfiguration.mock.calls.length).toBe(calls);
    expect((await fresh(session.id)).status).not.toBe("PAYING");
  });

  it("a PayPal refusal is journaled (and alerted) once, listed on the dashboard, and 'Réactiver PayPal' clears it", async () => {
    const { paypalRefusals, clearPaypalRefusals } = await import("@/lib/checkout");
    const session = await makeSession();
    const refuse = () =>
      whop.createCheckoutConfiguration.mockImplementationOnce(async () => {
        throw new MethodUnavailableError(["paypal"]);
      });
    refuse();
    await expect(prepareSession(session, { addOnIds: [], method: "paypal" })).rejects.toMatchObject({ code: "paypal_unavailable" });
    const events = () => db.eventLog.findMany({ where: { storeId: session.storeId, kind: "paypal.refused" } });
    expect(await events()).toHaveLength(1);
    expect((await events())[0].message).toMatch(/Réactiver PayPal/);
    // Still held: further PayPal prepares are refused without Whop, and nothing new is journaled.
    await expect(prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" })).rejects.toMatchObject({ code: "paypal_unavailable" });
    expect(await events()).toHaveLength(1);
    const held = await paypalRefusals(session.storeId);
    expect(held).toHaveLength(1);
    expect(held[0].currency).toBe("EUR");
    expect(held[0].since).toBeInstanceOf(Date);

    // The merchant brings PayPal back: Whop is asked again at once.
    expect(await clearPaypalRefusals(session.storeId)).toBe(1);
    expect(await paypalRefusals(session.storeId)).toEqual([]);
    const ok = await prepareSession(await fresh(session.id), { addOnIds: [], method: "paypal" });
    expect(ok.paypal).toBe(true);
    // Refused again later: a new journal entry (the hold had been lifted).
    const other = await db.checkoutSession.create({ data: { storeId: session.storeId, currency: "EUR", lines: [{ ...line, quantity: 2 }], subtotalCents: 6000 }, include: { store: true } });
    refuse();
    await expect(prepareSession(other, { addOnIds: [], method: "paypal" })).rejects.toMatchObject({ code: "paypal_unavailable" });
    expect(await events()).toHaveLength(2);
  });

  it("holds a physical wallet order with no shipping address for review, with the billing address", async () => {
    const shipped = { ...line, requiresShipping: true };
    const session = await makeSession("EUR", { lines: [shipped] });
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) => items.map((i) => ({ ...shipped, quantity: i.quantity })));
    await db.shippingRate.create({ data: { storeId: session.storeId, name: "Standard", priceCents: 0, countries: [] } });
    const prepared = await prepareSession(await fresh(session.id), { addOnIds: [], countryCode: "FR" });
    // Google Pay express: no shipping address from Whop, no form address on the session.
    const billing = { name: "Gina Pay", line1: "5 rue Billing", line2: null, city: "Nantes", state: null, postal_code: "44000", country: "FR" };
    await markPaid(session.id, {
      id: `pay_gp_${session.id}`,
      totalCents: 3000,
      currency: "eur",
      paymentMethodType: "google_pay",
      checkoutConfigurationId: prepared.checkoutConfigurationId,
      buyer: { email: "gp@wallet.test", shippingAddress: null, address: billing, phone: null },
    });
    const paid = await db.checkoutSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(paid.status).toBe("PAID");
    expect(paid.reviewNote).toContain("adresse de livraison absente");
    expect(paid.shippingAddress).toMatchObject({ address1: "5 rue Billing", city: "Nantes" });
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
  });
});
