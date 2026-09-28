import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Round 11 (reliability) against a real Postgres: automatic cart discounts only in the shop's
 * currency and capped per line, the Shopify code ledger (usage limit / once per customer) under
 * concurrent payments, free-shipping codes above their maximum shipping price, automatic offers
 * pinned to the product shown, ECB rates off the buyer's path, the sign-in code route answering
 * before any lookup (and its daily failure cap), refunds counted in the charged currency, the
 * Google Ads import under the tick's deadline, Shopify codes gated on the read_discounts scope and
 * the degradation counters in health. Shopify, Whop and notifications are mocked.
 * Test data is prefixed r11fix_ and deleted at the end.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
  shopifyGraphql: vi.fn(),
}));
const whop = vi.hoisted(() => ({ createCheckoutConfiguration: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn() }));
const afterQueue = vi.hoisted(() => [] as (() => unknown)[]);

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterQueue.push(fn) }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const DAY = 86_400_000;

describe.skipIf(!hasDb)("round 11 reliability (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { withLogContext } = await import("@/lib/log");
  const { quoteSession, prepareSession, markPaid } = await import("@/lib/checkout");
  const { clearShopifyDiscountCache, verifiedCartDiscounts, automaticDiscountFor, automaticDiscountsOf } = await import("@/lib/shopify-discounts");
  const { buildOrderCreateInput } = await import("@/lib/shopify");
  const { acceptUpsell, UpsellError } = await import("@/lib/upsell");
  const { ecbRates, resetFxThrottle } = await import("@/lib/fx");
  const { fxUpkeep, whopRefundAmount } = await import("@/lib/charge");
  const { deliverLoginCode, verifyLoginCode, MAX_FAILED_VERIFY_PER_DAY } = await import("@/lib/returning");
  const { handleEvent } = await import("@/lib/webhooks");
  const { importAdSpend } = await import("@/lib/adspend");
  const { boundedTimeout, DeadlineError } = await import("@/lib/deadline");
  const { storeHealth } = await import("@/lib/health");
  const loginRoute = await import("@/app/api/public/sessions/[id]/login-code/route");
  const healthRoute = await import("@/app/api/health/route");

  const created: string[] = [];
  const savedFx = await db.appSetting.findMany({ where: { key: { in: ["fx:ecb", "fx:ecb:attempt"] } } });

  const line = (o: Record<string, unknown> = {}) => ({
    variantId: "gid://shopify/ProductVariant/11",
    productId: "gid://shopify/Product/1",
    productHandle: "sweat",
    title: "Sweat",
    variantTitle: null,
    sku: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 5000,
    compareAtCents: null,
    inventory: null,
    requiresShipping: true,
    ...o,
  });
  const address = { firstName: "Alex", lastName: "Martin", address1: "1 rue X", city: "Paris", zip: "75001", countryCode: "FR" };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `r11fix_${Math.random().toString(36).slice(2, 8)}`,
        testMode: false,
        vatExempt: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_r11",
        whopProductId: "prod_r11",
        whopApiKey: encrypt("k"),
        shopDomain: `r11fix-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        shopifyScopes: "read_products,write_orders,read_discounts",
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  const shopifyCode = (o: Record<string, unknown> = {}) => ({
    codeDiscountNodeByCode: {
      codeDiscount: {
        __typename: "DiscountCodeBasic",
        title: "Code",
        status: "ACTIVE",
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: null,
        usageLimit: null,
        asyncUsageCount: 0,
        appliesOncePerCustomer: false,
        context: { __typename: "DiscountBuyerSelectionAll" },
        minimumRequirement: null,
        customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 }, items: { __typename: "AllDiscountItems", allItems: true } },
        ...o,
      },
    },
  });

  /** A session prepared with `code`, ready to be paid (e-mail and address saved). */
  async function preparedWith(storeId: string, code: string, email: string, input: Record<string, unknown> = {}) {
    const s = await db.checkoutSession.create({ data: { storeId, currency: "EUR", lines: [line()], subtotalCents: 5000 }, include: { store: true } });
    const prepared = await prepareSession(s, { discountCode: code, addOnIds: [], countryCode: "FR", ...input });
    await db.checkoutSession.update({ where: { id: s.id }, data: { email, shippingAddress: address } });
    return { session: s, configId: prepared.checkoutConfigurationId, totals: prepared.totals };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    afterQueue.length = 0;
    clearShopifyDiscountCache();
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/1101", name: "#1101" });
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) =>
      items.map((i) => line({ variantId: String(i.variantId), quantity: i.quantity })),
    );
    whop.createCheckoutConfiguration.mockImplementation(async () => ({ id: `ch_r11_${Math.random().toString(36).slice(2)}`, purchaseUrl: null }));
  });

  afterAll(async () => {
    await db.buyerLoginCode.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    await db.appSetting.deleteMany({ where: { key: { in: ["fx:ecb", "fx:ecb:attempt", ...created.map((id) => `adspend:${id}`)] } } });
    for (const row of savedFx) await db.appSetting.create({ data: { key: row.key, value: row.value } });
  });

  it("drops automatic cart discounts of a cart in another currency (HUF) and caps them per line", async () => {
    const store = await makeStore();
    const lines = [{ variantId: "gid://shopify/ProductVariant/11", quantity: 2, unitPriceCents: 5000 }];
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));

    // Shopify Markets: the cart is shown in forints, its discount is 1 500 000 fillér — not euro cents.
    body = { currency: "HUF", items: [{ variant_id: 11, quantity: 2, line_level_discount_allocations: [{ amount: 1_500_000, discount_application: { type: "automatic", title: "Soldes" } }] }] };
    expect(await verifiedCartDiscounts(store, "c1-token?key=abc", lines)).toBeNull();
    const ev = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "discount.cart_currency_mismatch" } });
    expect(ev.message).toContain("HUF");

    // Same currency, but an allocation above the line's own price: capped at the line (10 000).
    body = { currency: "EUR", items: [{ variant_id: 11, quantity: 2, line_level_discount_allocations: [{ amount: 15_000, discount_application: { type: "automatic", title: "Soldes" } }] }] };
    const capped = await verifiedCartDiscounts(store, "c1-token?key=abc", lines);
    expect(capped).toMatchObject({ totalCents: 10_000, currency: "EUR", lineCents: { "gid://shopify/ProductVariant/11": 10_000 } });

    // A discounted item that isn't a checkout line: nothing is trusted.
    expect(
      automaticDiscountsOf(
        { currency: "EUR", items: [{ variant_id: 99, quantity: 1, line_level_discount_allocations: [{ amount: 500, discount_application: { type: "automatic" } }] }] },
        lines,
      ),
    ).toBeNull();

    // At quote time: another checkout currency, or a line re-priced lower, never over-discounts.
    const saved = { items: [{ variantId: "gid://shopify/ProductVariant/11", quantity: 2 }], totalCents: 3000, titles: ["Soldes"], at: "", currency: "EUR", lineCents: { "gid://shopify/ProductVariant/11": 3000 } };
    expect(automaticDiscountFor(saved, [line({ quantity: 2 })] as never, "HUF").cents).toBe(0);
    expect(automaticDiscountFor(saved, [line({ quantity: 2, unitPriceCents: 1000 })] as never, "EUR").cents).toBe(2000);
    expect(automaticDiscountFor(saved, [line({ quantity: 2 })] as never, "EUR").cents).toBe(3000);

    // The cart can't be re-read: journaled (the buyer loses the discount), counted in health.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    expect(await verifiedCartDiscounts(store, "c1-token?key=abc", lines)).toBeNull();
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "discount.cart_read_failed" } })).toBe(1);
    const tile = (await storeHealth(store.id)).find((i) => i.key === "degraded")!;
    expect([tile.ok, tile.detail]).toEqual([false, expect.stringContaining("relecture(s) du panier")]);
  });

  it("Shopify code usage limit: two payments landing together for the last use, one is held", async () => {
    const store = await makeStore({ shopifyDiscountCodes: true });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    // 5 uses allowed, 4 already counted by Shopify: one left.
    shopify.shopifyGraphql.mockResolvedValue(shopifyCode({ usageLimit: 5, asyncUsageCount: 4 }));
    const a = await preparedWith(store.id, "LAST1", "a@r11fix.test");
    const b = await preparedWith(store.id, "LAST1", "b@r11fix.test");
    const snap = await db.checkoutQuote.findUniqueOrThrow({ where: { whopCheckoutId: a.configId } });
    expect([snap.discountSource, snap.shopifyCodeUsageLimit, snap.shopifyCodeUsageCount]).toEqual(["shopify", 5, 4]);
    expect(snap.shopifyCodeCheckedAt).toBeInstanceOf(Date);

    await Promise.all(
      [a, b].map((p) => markPaid(p.session.id, { id: `pay_${p.session.id}`, totalCents: p.totals.totalCents, currency: "eur", checkoutConfigurationId: p.configId })),
    );
    const rows = await db.checkoutSession.findMany({ where: { id: { in: [a.session.id, b.session.id] } }, select: { status: true, reviewNote: true } });
    expect(rows.every((r) => r.status === "PAID")).toBe(true);
    const held = rows.filter((r) => r.reviewNote);
    expect(held).toHaveLength(1);
    expect(held[0].reviewNote).toContain("limite de 5 utilisation(s) atteinte");
    expect(shopify.createPaidOrder).toHaveBeenCalledTimes(1);
    expect(await db.shopifyCodeUse.count({ where: { storeId: store.id, code: "LAST1" } })).toBe(2);
  });

  it("Shopify code once per customer: the same e-mail paying twice at once, one is held", async () => {
    const store = await makeStore({ shopifyDiscountCodes: true });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    shopify.shopifyGraphql.mockResolvedValue(shopifyCode({ appliesOncePerCustomer: true }));
    const a = await preparedWith(store.id, "ONCE", "same@r11fix.test");
    const b = await preparedWith(store.id, "ONCE", "Same@r11fix.test");
    await Promise.all(
      [a, b].map((p) => markPaid(p.session.id, { id: `pay_${p.session.id}`, totalCents: p.totals.totalCents, currency: "eur", checkoutConfigurationId: p.configId })),
    );
    const rows = await db.checkoutSession.findMany({ where: { id: { in: [a.session.id, b.session.id] } }, select: { reviewNote: true } });
    const held = rows.filter((r) => r.reviewNote);
    expect(held).toHaveLength(1);
    expect(held[0].reviewNote).toContain("une fois par client");
    // Another buyer: fine.
    const c = await preparedWith(store.id, "ONCE", "other@r11fix.test");
    await markPaid(c.session.id, { id: `pay_${c.session.id}`, totalCents: c.totals.totalCents, currency: "eur", checkoutConfigurationId: c.configId });
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: c.session.id } })).reviewNote).toBeNull();
  });

  it("free-shipping code above its maximum shipping price: shipping stays paid, the Shopify order total is what was paid", async () => {
    const store = await makeStore({ shopifyDiscountCodes: true });
    const pricey = await db.shippingRate.create({ data: { storeId: store.id, name: "Express", countries: [], priceCents: 990 } });
    const cheap = await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 490, position: 1 } });
    shopify.shopifyGraphql.mockResolvedValue({
      codeDiscountNodeByCode: {
        codeDiscount: {
          __typename: "DiscountCodeFreeShipping",
          title: "Port offert",
          status: "ACTIVE",
          startsAt: "2026-01-01T00:00:00Z",
          endsAt: null,
          usageLimit: null,
          asyncUsageCount: 0,
          appliesOncePerCustomer: false,
          context: { __typename: "DiscountBuyerSelectionAll" },
          minimumRequirement: null,
          destinationSelection: { __typename: "DiscountCountryAll", allCountries: true },
          maximumShippingPrice: { amount: "5.00" },
        },
      },
    });
    const over = await preparedWith(store.id, "PORT5", "fs@r11fix.test", { shippingRateId: pricey.id });
    expect(over.totals.shippingCents).toBe(990);
    const snap = await db.checkoutQuote.findUniqueOrThrow({ where: { whopCheckoutId: over.configId } });
    expect(snap.discountFreeShipping).toBe(false);
    await markPaid(over.session.id, { id: `pay_${over.session.id}`, totalCents: over.totals.totalCents, currency: "eur", checkoutConfigurationId: over.configId });
    const input = shopify.createPaidOrder.mock.calls[0][1];
    expect(input.discount).toMatchObject({ code: "PORT5", freeShipping: false });
    const order = buildOrderCreateInput(input);
    expect(order.discountCode).toBeUndefined();
    const items = order.lineItems as { quantity: number; priceSet: { shopMoney: { amount: string } } }[];
    const shipping = order.shippingLines as { priceSet: { shopMoney: { amount: string } } }[];
    const orderTotal = items.reduce((s, l) => s + l.quantity * Math.round(Number(l.priceSet.shopMoney.amount) * 100), 0) + shipping.reduce((s, l) => s + Math.round(Number(l.priceSet.shopMoney.amount) * 100), 0);
    expect(orderTotal).toBe(over.totals.totalCents);

    // Under the maximum: shipping free, recorded as Shopify's free-shipping code.
    const under = await preparedWith(store.id, "PORT5", "fs2@r11fix.test", { shippingRateId: cheap.id });
    expect(under.totals.shippingCents).toBe(0);
    expect((await db.checkoutQuote.findUniqueOrThrow({ where: { whopCheckoutId: under.configId } })).discountFreeShipping).toBe(true);
  });

  it("automatic offer: accepting charges only the product the page showed", async () => {
    const auto = {
      id: "auto1",
      type: "upsell",
      props: { badge: "", title: "", text: "", variantId: "", imageUrl: "", price: 0, compareAt: 0, buttonText: "Oui", declineText: "Non", productSource: "auto", priceMode: "percent", discountPercent: 20 },
    };
    const store = await makeStore({ thankYouLayout: { blocks: [auto] } });
    const p = (n: number) => line({ productId: `gid://shopify/Product/${n}`, variantId: `gid://shopify/ProductVariant/${n}${n}` });
    const past = new Date(Date.now() - 5 * DAY);
    for (let i = 0; i < 2; i++)
      await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", status: "PAID", lines: [p(1), p(2)], subtotalCents: 10000, totalCents: 10000, paidAt: past } as never });
    const mine = await db.checkoutSession.create({
      data: { storeId: store.id, currency: "EUR", status: "PAID", lines: [p(1)], subtotalCents: 5000, totalCents: 5000, paidAt: new Date(), whopMemberId: "mem_1", whopPaymentMethodId: "pm_1", whopPaymentId: `pay_auto_${Date.now()}` } as never,
      include: { store: true },
    });
    // Each accept re-picks (Shopify prices the candidate), then prices the accepted variant: none left.
    shopify.priceCart.mockImplementation(async () => []);

    const err = async (variantId?: string) => {
      shopify.priceCart.mockImplementationOnce(async () => [p(2)]);
      try {
        await acceptUpsell(mine, "auto1", 1, variantId);
        return null;
      } catch (e) {
        return e instanceof UpsellError ? e : Promise.reject(e);
      }
    };
    // The page showed another product (the pick moved since): refused before any charge.
    const moved = await err("gid://shopify/ProductVariant/33");
    expect([moved?.code, moved?.message]).toEqual(["upsell_unavailable", expect.stringContaining("a changé")]);
    // No variant sent for an automatic offer: refused too.
    expect((await err(undefined))?.code).toBe("upsell_unavailable");
    // The one shown: passes the check (then Shopify has no stock left in this test).
    expect((await err("gid://shopify/ProductVariant/22"))?.code).toBe("upsell_sold_out");
    expect(await db.upsellCharge.count({ where: { sessionId: mine.id } })).toBe(0);
  });

  it("ECB rates: buyers read the cache (at most one 1.5 s wait when there is none), the tick refreshes and alerts when stale", async () => {
    await db.appSetting.deleteMany({ where: { key: { in: ["fx:ecb", "fx:ecb:attempt"] } } });
    resetFxThrottle();
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason ?? new Error("aborted")))),
    );
    vi.stubGlobal("fetch", hang);
    const t0 = Date.now();
    expect(await ecbRates()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(2_500);
    // Failure remembered: the next buyer doesn't wait at all.
    const t1 = Date.now();
    expect(await ecbRates()).toBeNull();
    expect(Date.now() - t1).toBeLessThan(300);
    expect(hang).toHaveBeenCalledTimes(1);

    // Cached rates, even old: read without any fetch.
    const old = { date: new Date(Date.now() - 10 * DAY).toISOString().slice(0, 10), rates: { EUR: 1, CHF: 0.95 }, fetchedAt: new Date().toISOString() };
    await db.appSetting.create({ data: { key: "fx:ecb", value: JSON.stringify(old) } });
    hang.mockClear();
    expect((await ecbRates())?.date).toBe(old.date);
    expect(hang).not.toHaveBeenCalled();

    // Rates over 3 days old while a store charges in local currency: its Swiss buyer pays in EUR,
    // the fallback and the staleness are journaled, health says so.
    const store = await makeStore({ chargeLocalCurrency: true, enabled: true });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    const s = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()], subtotalCents: 5000 }, include: { store: true } });
    const prepared = await prepareSession(s, { countryCode: "CH", addOnIds: [] });
    expect(prepared.quote.charge).toBeNull();
    expect(whop.createCheckoutConfiguration.mock.calls[0][1]).toMatchObject({ currency: "EUR", totalCents: 5000 });
    const fallback = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "fx.charge_fallback" } });
    expect(fallback.message).toContain("CHF");
    await fxUpkeep();
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "fx.stale" } })).toBe(1);
    const tile = (await storeHealth(store.id)).find((i) => i.key === "degraded")!;
    expect([tile.ok, tile.detail]).toEqual([false, expect.stringContaining("Taux BCE")]);
  });

  it("sign-in code: the route answers before any lookup, same body for everyone; wrong codes are capped per day", async () => {
    // Rate-limit windows outlive a run (10 min): start from a clean slate so reruns are deterministic.
    await db.rateLimit.deleteMany({ where: { key: { startsWith: "otp:" }, OR: [{ key: { contains: "@r11fix.test" } }, { key: { startsWith: "otp:ip:10.1." } }] } });
    const store = await makeStore({ returningBuyerCode: true, resendApiKey: encrypt("re_x"), emailFrom: "Shop <a@b.fr>" });
    await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", status: "PAID", lines: [line()], paidAt: new Date(Date.now() - DAY), email: "fidele@r11fix.test", shippingAddress: address } as never });
    const session = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()], lang: "fr" } });
    notify.sendEmail.mockResolvedValue(true);
    const call = (email: string) =>
      loginRoute.POST(new Request("https://x/api", { method: "POST", headers: { "x-forwarded-for": `10.1.${Math.floor(Math.random() * 200)}.1` }, body: JSON.stringify({ email }) }), {
        params: Promise.resolve({ id: session.id }),
      });
    const known = await call("fidele@r11fix.test");
    const unknown = await call("nobody@r11fix.test");
    expect([known.status, await known.json()]).toEqual([200, { sent: true }]);
    expect([unknown.status, await unknown.json()]).toEqual([200, { sent: true }]);
    // Nothing looked up nor sent yet: that work runs after the response.
    expect(notify.sendEmail).not.toHaveBeenCalled();
    expect(await db.buyerLoginCode.count({ where: { sessionId: session.id } })).toBe(0);
    expect(afterQueue).toHaveLength(2);
    for (const fn of afterQueue.splice(0)) await fn();
    expect(notify.sendEmail).toHaveBeenCalledTimes(1);
    const code = /(\d{6})/.exec((notify.sendEmail.mock.calls[0][1] as { text: string }).text)![1];

    // A failed e-mail is journaled (and counted in health).
    notify.sendEmail.mockRejectedValueOnce(new Error("Resend 401: invalid key"));
    await deliverLoginCode({ ...session, store }, "fidele@r11fix.test");
    expect((await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "returning.email_failed" } })).message).toContain("Resend 401");

    // Daily cap: after MAX wrong codes for this e-mail, even a right one is refused, and none is sent.
    notify.sendEmail.mockClear();
    const s2 = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()] } });
    await deliverLoginCode({ ...s2, store }, "fidele@r11fix.test");
    const fresh = /(\d{6})/.exec((notify.sendEmail.mock.calls[0][1] as { text: string }).text)![1];
    const wrong = (c: string) => (c === "000000" ? "111111" : "000000");
    for (let i = 0; i < MAX_FAILED_VERIFY_PER_DAY; i++) {
      if (i % 4 === 0) await deliverLoginCode({ ...s2, store }, "fidele@r11fix.test"); // new codes: the 5-try budget alone isn't the limit
      await verifyLoginCode(s2, "fidele@r11fix.test", wrong(fresh));
    }
    notify.sendEmail.mockClear();
    await deliverLoginCode({ ...s2, store }, "fidele@r11fix.test");
    expect(notify.sendEmail).not.toHaveBeenCalled();
    expect(await verifyLoginCode(session, "fidele@r11fix.test", code)).toBeNull();
  });

  it("refunds of an order charged in CHF: counted in CHF, the last partial refund closes it exactly", async () => {
    const store = await makeStore();
    const s = await db.checkoutSession.create({
      data: { storeId: store.id, currency: "EUR", status: "PAID", lines: [line()], subtotalCents: 5000, totalCents: 5000, paidAt: new Date(), whopPaymentId: `pay_chf_${Date.now()}`, chargeCurrency: "CHF", chargeFxRate: 0.9501, reviewNote: "hold" } as never,
    });
    const q = await db.checkoutQuote.create({
      data: { sessionId: s.id, whopCheckoutId: `ch_chf_${s.id}`, fingerprint: "f", currency: "EUR", subtotalCents: 5000, discountCents: 0, shippingCents: 0, addOnsCents: 0, totalCents: 5000, chargeCurrency: "CHF", chargeTotalCents: 4751, chargeFxRate: 0.9501, addOns: [], addOnIds: [] },
    });
    await db.checkoutSession.update({ where: { id: s.id }, data: { paidQuoteId: q.id } });
    const refund = (id: string, chf: number) => handleEvent("refund.created", { id, status: "succeeded", amount: chf, currency: "chf", payment: { id: s.whopPaymentId } }, store.id);

    // Dashboard: half of 50 € → 2 375 CHF; the rest is then exactly 4 751 − 2 375.
    const first = whopRefundAmount({ amountCents: 2500, totalCents: 5000, refundedCents: 0, chargeTotalCents: 4751, refundedChargeCents: 0, rate: 0.9501 });
    expect(first).toBe(2375);
    await refund(`re_a_${s.id}`, first! / 100);
    let row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect([row.refundedChargeCents, row.refundedCents]).toEqual([2375, 2500]);
    const rest = whopRefundAmount({ amountCents: 5000 - row.refundedCents, totalCents: 5000, refundedCents: row.refundedCents, chargeTotalCents: 4751, refundedChargeCents: row.refundedChargeCents, rate: 0.9501 });
    expect(rest).toBe(2376);
    // 2 376 CHF at 0.9501 is 2 500.79 €: rounded it would be 2 501 (5 001 in all); counted as the exact rest.
    await refund(`re_b_${s.id}`, rest! / 100);
    row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect([row.refundedChargeCents, row.refundedCents]).toEqual([4751, 5000]);
    expect(row.syncSkippedReason).toBe("refunded");
    const records = await db.refundRecord.findMany({ where: { sessionId: s.id } });
    expect(records.reduce((n, r) => n + r.amountCents, 0)).toBe(5000);
    // A partial refund never reads as the whole order before the charge is fully refunded.
    expect(whopRefundAmount({ amountCents: 4999, totalCents: 5000, refundedCents: 0, chargeTotalCents: 4751, refundedChargeCents: 0, rate: 0.9501 })).toBe(4750);
  });

  it("Google Ads import respects the tick's hard deadline: not started, not a failure, retried next run", async () => {
    const store = await makeStore({
      googleAdsCustomerId: "1234567890",
      googleAdsDeveloperToken: encrypt("dev"),
      googleAdsClientId: "abc.apps.googleusercontent.com",
      googleAdsClientSecret: encrypt("secret"),
      googleAdsRefreshToken: encrypt("refresh"),
    });
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await withLogContext({ hardDeadline: Date.now() + 2_000 }, () => importAdSpend(Date.now() + 60_000, { storeId: store.id, force: true }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "adspend.import_failed" } })).toBe(0);
    const status = JSON.parse((await db.appSetting.findUniqueOrThrow({ where: { key: `adspend:${store.id}` } })).value);
    expect(Date.parse(status.at)).toBe(0); // not throttled: the next run imports it

    expect(withLogContext({ hardDeadline: Date.now() + 8_000 }, () => boundedTimeout(10_000, "x"))).toBeLessThanOrEqual(7_000);
    expect(() => withLogContext({ hardDeadline: Date.now() + 1_000 }, () => boundedTimeout(10_000, "x"))).toThrow(DeadlineError);
    expect(boundedTimeout(10_000, "x")).toBe(10_000);
  });

  it("Shopify codes: gated on the read_discounts scope; a failed lookup says 'try again' (cached 30 s) and shows in health", async () => {
    // Option on, scope missing: Shopify is never asked.
    const noScope = await makeStore({ shopifyDiscountCodes: true, shopifyScopes: "read_products,write_orders", enabled: true });
    const s1 = await db.checkoutSession.create({ data: { storeId: noScope.id, currency: "EUR", lines: [line()], subtotalCents: 5000 }, include: { store: true } });
    const q1 = await quoteSession(s1, { discountCode: "SHOPCODE", addOnIds: [] });
    expect(q1.discountErrorCode).toBe("discount_invalid");
    expect(shopify.shopifyGraphql).not.toHaveBeenCalled();
    expect((await storeHealth(noScope.id)).find((i) => i.key === "discount_scope")).toMatchObject({ ok: false });
    // The default is now off.
    expect((await makeStore()).shopifyDiscountCodes).toBe(false);

    const store = await makeStore({ shopifyDiscountCodes: true });
    shopify.shopifyGraphql.mockRejectedValue(new Error("Shopify injoignable"));
    const s2 = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()], subtotalCents: 5000 }, include: { store: true } });
    const q2 = await quoteSession(s2, { discountCode: "SHOPCODE", addOnIds: [] });
    expect([q2.discountErrorCode, q2.discount]).toEqual(["discount_unavailable", null]);
    await quoteSession(s2, { discountCode: "SHOPCODE", addOnIds: [] });
    expect(shopify.shopifyGraphql).toHaveBeenCalledTimes(1);
    await expect(prepareSession(s2, { discountCode: "SHOPCODE", addOnIds: [] })).rejects.toMatchObject({ code: "discount_unavailable" });
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "discount.shopify_lookup_failed" } })).toBe(1);

    const res = await healthRoute.GET(new Request("https://x/api/health"), { params: Promise.resolve({}) });
    const body = (await res.json()) as { degraded: string[]; status: string };
    expect(body.degraded.some((d) => d.startsWith("discount.shopify_lookup_failed"))).toBe(true);
    expect(body.degraded.some((d) => d.includes("without the read_discounts scope"))).toBe(true);
  });
});
