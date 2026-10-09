import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CartLine } from "@/lib/pricing";

/*
 * Bundle / upsell / personalization apps against a real Postgres: the storefront's cart (/cart.js,
 * mocked) re-read by the session route, Kaching's discount-function mode, a Cart Transform price
 * (merge mode), personalization properties, carts charged as Shopify's cart charges them (journaled), locked
 * quantities on the quote, and the paid order's input (properties, cart note / attributes, the
 * charged amount). Shopify's Admin API and Whop are mocked. Test data is prefixed bnd_ and deleted.
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
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendBuyerEmail: vi.fn() }));

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("bundle apps (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { quoteSession, prepareSession, markPaid } = await import("@/lib/checkout");
  const { buildOrderCreateInput } = await import("@/lib/shopify");
  const sessionsRoute = await import("@/app/api/public/sessions/route");

  const created: string[] = [];
  const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
  const PRICES: Record<string, number> = { "11": 3000, "12": 1500 };
  // Kaching's real line property (two underscores, JSON), paid line of a deal.
  const KB = JSON.stringify({ deal: "54Jy", main: true, id: "3FLa", bid: "0f83", ab: "B" });
  const address = { firstName: "Léa", lastName: "Martin", address1: "1 rue X", city: "Paris", zip: "75001", countryCode: "FR" };

  async function makeStore() {
    const store = await db.store.create({
      data: {
        name: `bnd_${Math.random().toString(36).slice(2, 8)}`,
        enabled: true,
        testMode: false,
        vatExempt: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_bnd",
        whopProductId: "prod_bnd",
        whopApiKey: encrypt("k"),
        shopDomain: `bnd-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
      },
    });
    created.push(store.id);
    return store;
  }

  let ip = 0;
  const post = (body: Record<string, unknown>) =>
    sessionsRoute.POST(
      new Request("https://x.test/api/public/sessions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": `10.77.0.${++ip}` },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({}) },
    );
  const stubCart = (cart: unknown) => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith("/cart.js")) return new Response(JSON.stringify(cart), { status: 200 });
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/77", name: "#77" });
    // One line per variant, quantities summed (as the real priceCart).
    shopify.priceCart.mockImplementation(async (_s: unknown, raw: { variantId: string | number; quantity: number }[]) =>
      [...raw.reduce((m, i) => m.set(String(i.variantId).replace(/\D/g, ""), (m.get(String(i.variantId).replace(/\D/g, "")) ?? 0) + i.quantity), new Map<string, number>())]
        .map(([variantId, quantity]) => ({ variantId, quantity }))
        .map((i) => {
        const n = String(i.variantId).replace(/\D/g, "");
        return {
          variantId: V(Number(n)),
          productId: `gid://shopify/Product/${n}`,
          productHandle: `p${n}`,
          title: n === "11" ? "Bracelet" : "Pochette",
          variantTitle: null,
          sku: null,
          imageUrl: null,
          quantity: i.quantity,
          unitPriceCents: PRICES[n] ?? 1000,
          compareAtCents: null,
          inventory: null,
          requiresShipping: true,
        };
      }),
    );
    whop.createCheckoutConfiguration.mockImplementation(async () => ({ id: `ch_bnd_${Math.random().toString(36).slice(2)}`, purchaseUrl: null }));
  });

  afterAll(async () => {
    await db.eventLog.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("the loader's warm-up answers at once: no session, no rate limit spent", async () => {
    const before = await db.checkoutSession.count();
    const res = await post({ warm: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ warm: true });
    expect(await db.checkoutSession.count()).toBe(before);
    expect(await db.rateLimit.count({ where: { key: `session:ip:10.77.0.${ip}` } })).toBe(0);
  });

  it("app line (hidden key) + personalization: properties and cart context on the order, cart fixed; a lower price with only a hidden key is charged at the variant's price", async () => {
    const store = await makeStore();
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    // Fast Bundle / Kaching merge mode: 2 × 30 € sold 2 × 25 €, no discount allocation, no components:
    // nothing the buyer can't forge explains that price (another market's could) → the variant's price,
    // on this checkout (never Shopify's).
    stubCart({
      token: "bnd-token-1",
      currency: "EUR",
      total_price: 6500,
      items: [{ variant_id: 11, quantity: 2, price: 2500, final_price: 2500, final_line_price: 5000, original_line_price: 5000, line_level_discount_allocations: [], properties: { _bundle_id: "fb_9" } }, { variant_id: 12, quantity: 1, final_line_price: 1500, line_level_discount_allocations: [] }],
    });
    const lower = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 2, properties: { _bundle_id: "fb_9" } }, { variant_id: 12, quantity: 1 }], cartToken: "bnd-token-1", appPricing: true });
    expect(lower.status).toBe(200);
    const lowered = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await lower.json()) as { id: string }).id } });
    expect(lowered.subtotalCents).toBe(7500);
    expect((lowered.lines as unknown as CartLine[]).map((l) => [l.variantId, l.quantity, l.unitPriceCents, l.cartPriced, l.locked])).toEqual([
      [V(11), 2, 3000, true, true],
      [V(12), 1, 1500, true, true],
    ]);
    expect((lowered.lines as unknown as CartLine[])[0].appPrice).toBeUndefined();
    expect(lowered.cartContext).toMatchObject({ cartPriced: { reason: "price_unverified", discounted: false } });
    expect((await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "cart.priced_as_shopify_cart" } })).message).toContain("sans signe vérifiable");

    const fetchMock = stubCart({
      token: "bnd-token-1",
      currency: "EUR",
      total_price: 7500,
      note: "Paquet cadeau",
      attributes: { "Date de livraison": "2026-10-02", _app_ref: "r1" },
      items: [
        // An app's line at the variant's price.
        { variant_id: 11, quantity: 2, price: 3000, final_price: 3000, final_line_price: 6000, original_line_price: 6000, line_level_discount_allocations: [], properties: { _bundle_id: "fb_9", Gravure: "Léa" } },
        { variant_id: 12, quantity: 1, price: 1500, final_price: 1500, final_line_price: 1500, original_line_price: 1500, line_level_discount_allocations: [], properties: {} },
      ],
    });
    const res = await post({
      store: store.publicId,
      // The browser's figures don't matter: only properties, and the server re-reads everything.
      items: [
        { variant_id: 11, quantity: 2, properties: { _bundle_id: "fb_9", Gravure: "Léa" } },
        { variant_id: 12, quantity: 1 },
      ],
      cartToken: "bnd-token-1",
      appPricing: true,
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { id } = (await res.json()) as { id: string };
    const session = await db.checkoutSession.findUniqueOrThrow({ where: { id }, include: { store: true } });
    expect(session.subtotalCents).toBe(7500);
    expect(session.cartContext).toEqual({ note: "Paquet cadeau", attributes: [{ key: "Date de livraison", value: "2026-10-02" }, { key: "_app_ref", value: "r1" }] });
    // Unknown hidden keys: a redacted snapshot kept for support (no buyer text, no token).
    const snap = await db.cartSnapshot.findUniqueOrThrow({ where: { sessionId: id } });
    expect(snap.unknownKeys).toEqual(["_app_ref", "_bundle_id"]);
    expect(JSON.stringify(snap.data)).not.toMatch(/Léa|Paquet cadeau|bnd-token-1/);
    // Both carts' unknown keys journaled (once a day per set of keys).
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "cart.apps_detected" } })).toBe(2);

    // An app's line (hidden key) holds for this exact cart: every line is fixed, a change (even
    // removing the other line) is ignored and adds nothing.
    expect((session.lines as unknown as CartLine[]).every((l) => l.locked)).toBe(true);
    const q = await quoteSession(session, { addOnIds: [], quantities: { [V(11)]: 5, [V(12)]: 2 } });
    const bundle = q.lines.find((l) => l.variantId === V(11))!;
    expect(bundle).toMatchObject({ quantity: 2, unitPriceCents: 3000, locked: true });
    expect(bundle.appPrice).toBeUndefined();
    expect(q.lines.find((l) => l.variantId === V(12))).toMatchObject({ quantity: 1, locked: true });
    expect([q.totals.subtotalCents, q.cartLocked]).toEqual([7500, true]);
    const removed = await quoteSession(session, { addOnIds: [], quantities: { [V(12)]: 0, [V(13)]: 1 } });
    expect(removed.lines.map((l) => [l.variantId, l.quantity])).toEqual([
      [V(11), 2],
      [V(12), 1],
    ]);
    expect(removed.totals.subtotalCents).toBe(7500);

    const prepared = await prepareSession(session, { addOnIds: [], quantities: { [V(11)]: 2, [V(12)]: 1 } });
    expect(whop.createCheckoutConfiguration.mock.calls[0][1]).toMatchObject({ totalCents: 7500 });
    await db.checkoutSession.update({ where: { id }, data: { email: "lea@bnd.test", shippingAddress: address } });
    await markPaid(id, { id: `pay_${id}`, totalCents: 7500, currency: "eur", checkoutConfigurationId: prepared.checkoutConfigurationId });
    const paid = await db.checkoutSession.findUniqueOrThrow({ where: { id } });
    expect([paid.status, paid.reviewNote, paid.totalCents]).toEqual(["PAID", null, 7500]);

    const input = shopify.createPaidOrder.mock.calls[0][1];
    expect(input.cart).toEqual(session.cartContext);
    const order = buildOrderCreateInput(input);
    const items = order.lineItems as { variantId: string; quantity: number; priceSet: { shopMoney: { amount: string } }; properties?: unknown }[];
    expect(items.find((i) => i.variantId === V(11))).toMatchObject({ quantity: 2, priceSet: { shopMoney: { amount: "30.00" } }, properties: [{ name: "_bundle_id", value: "fb_9" }, { name: "Gravure", value: "Léa" }] });
    expect(items.reduce((s, i) => s + Math.round(Number(i.priceSet.shopMoney.amount) * 100) * i.quantity, 0)).toBe(7500);
    expect(order.customAttributes).toEqual([{ key: "Date de livraison", value: "2026-10-02" }, { key: "_app_ref", value: "r1" }]);
    expect(order.note).toContain("Note du panier : Paquet cadeau");
    expect(order.tags).toContain(`wc-${id}`);
  });

  it("Kaching discount-function mode: the automatic allocation is honored, the line keeps its price", async () => {
    const store = await makeStore();
    stubCart({
      token: "bnd-token-2",
      currency: "EUR",
      total_price: 7200,
      items: [
        {
          variant_id: 11,
          quantity: 3,
          price: 3000,
          final_price: 2400,
          final_line_price: 7200,
          original_line_price: 9000,
          properties: { __kaching_bundles: KB },
          line_level_discount_allocations: [{ amount: 1800, discount_application: { type: "automatic", title: "Kaching Bundle -20%" } }],
        },
      ],
    });
    const res = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 3, properties: { __kaching_bundles: KB } }], cartToken: "bnd-token-2", automaticDiscounts: true });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const session = await db.checkoutSession.findUniqueOrThrow({ where: { id }, include: { store: true } });
    const q = await quoteSession(session, { addOnIds: [] });
    expect(q.lines[0]).toMatchObject({ unitPriceCents: 3000, locked: true });
    expect(q.automaticDiscount).toEqual({ cents: 1800, titles: ["Kaching Bundle -20%"] });
    expect(q.totals.totalCents).toBe(7200);
    expect((await db.cartSnapshot.findUniqueOrThrow({ where: { sessionId: id } })).apps).toEqual(["automatic_discount", "kaching"]);
  });

  it("safety net: a cart Shopify prices lower than its lines (a cart-level app price) is charged as the cart says", async () => {
    const store = await makeStore();
    // A cart-level app price we can't see per line (total below the lines).
    stubCart({ token: "bnd-token-7", currency: "EUR", total_price: 2000, items: [{ variant_id: 11, quantity: 1, final_line_price: 3000, line_level_discount_allocations: [], properties: { __kaching_bundles: "{}" } }] });
    const res = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1, properties: { __kaching_bundles: "{}" } }], cartToken: "bnd-token-7" });
    expect(res.status).toBe(200);
    const s = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await res.json()) as { id: string }).id } });
    expect([s.subtotalCents, (s.lines as unknown as CartLine[])[0].unitPriceCents]).toEqual([2000, 2000]);
    expect(s.cartContext).toMatchObject({ cartPriced: { reason: "price_unreconciled", discounted: true } });
    // Cart Transform parent (has_components) whose components the AJAX cart doesn't list.
    stubCart({ token: "bnd-token-8", currency: "EUR", total_price: 3000, items: [{ variant_id: 11, quantity: 1, final_line_price: 3000, has_components: true, line_level_discount_allocations: [] }] });
    const merged = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-8", appPricing: true });
    expect(merged.status).toBe(200);
    const m = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await merged.json()) as { id: string }).id } });
    // The parent is ordered (its components' stock isn't decremented: said in the journal).
    expect((m.lines as unknown as CartLine[])[0]).toMatchObject({ variantId: V(11), unitPriceCents: 3000, cartPriced: true });
    expect((m.lines as unknown as CartLine[])[0].components).toBeUndefined();
    const entry = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "cart.priced_as_shopify_cart", data: { path: ["reason"], equals: "bundle_components_unresolved" } } });
    expect(entry.data).toMatchObject({ apps: ["cart_transform"] });
    expect(entry.message).toContain("stock des composants");
  });

  it("an app's surcharge is charged as the cart says, a buy-now bundle at the variant's price; only an unreadable app cart is refused (retry)", async () => {
    const store = await makeStore();
    // An app's surcharge (cart price above the variant's) on a personalized line.
    stubCart({ token: "bnd-token-3", currency: "EUR", items: [{ variant_id: 11, quantity: 1, final_line_price: 3900, line_level_discount_allocations: [], properties: { Gravure: "Léa" } }] });
    const res = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1, properties: { Gravure: "Léa" } }], cartToken: "bnd-token-3" });
    expect(res.status).toBe(200);
    const surcharged = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await res.json()) as { id: string }).id } });
    expect((surcharged.lines as unknown as CartLine[])[0]).toMatchObject({ unitPriceCents: 3900, cartPriced: true, properties: [{ name: "Gravure", value: "Léa" }] });
    expect(surcharged.subtotalCents).toBe(3900);
    const entry = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "cart.priced_as_shopify_cart" } });
    expect(entry.message).toContain("supplément");

    // Bundle bought with "buy now" (no cart to read its price): the variant's own price, its properties kept.
    const buyNow = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1, properties: { _kaching_bundle_id: "kb" } }] });
    expect(buyNow.status).toBe(200);
    const b = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await buyNow.json()) as { id: string }).id } });
    expect((b.lines as unknown as CartLine[])[0]).toMatchObject({ unitPriceCents: 3000, locked: true, properties: [{ name: "_kaching_bundle_id", value: "kb" }] });
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "cart.catalog_priced" } })).toBe(1);

    // Cart unreadable (asked twice) while it holds an app's bundle: refused for a retry, never Shopify's checkout.
    const failing = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", failing);
    const unreadable = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1, properties: { _bundle: "x" } }], cartToken: "bnd-token-4", appPricing: true });
    const refusal = (await unreadable.json()) as { reason: string; native?: boolean };
    expect([unreadable.status, refusal.reason, refusal.native]).toEqual([409, "cart_unreadable", undefined]);
    expect(failing).toHaveBeenCalledTimes(2);

    // A plain cart unreadable: goes on as before (no discounts), properties from the storefront.
    const plain = await post({ store: store.publicId, items: [{ variant_id: 12, quantity: 1, properties: { Couleur: "Bleu" } }], cartToken: "bnd-token-5", note: "Merci" });
    expect(plain.status).toBe(200);
    const s = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await plain.json()) as { id: string }).id } });
    expect([(s.lines as { properties?: unknown }[])[0].properties, s.cartContext]).toEqual([[{ name: "Couleur", value: "Bleu" }], { note: "Merci" }]);
  });

  it("a cart token is always re-read, whatever the browser's flags (Cart Transform price without properties)", async () => {
    const store = await makeStore();
    // Lower, no verified sign on the line (Markets / B2B price list, tax-inclusive price): another
    // market's price is never kept — the variant's price, on this checkout, journaled.
    let fetchMock = stubCart({ token: "bnd-token-6", currency: "EUR", total_price: 2500, items: [{ variant_id: 11, quantity: 1, price: 2500, final_price: 2500, final_line_price: 2500, original_line_price: 2500, line_level_discount_allocations: [] }] });
    const lower = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-6" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lower.status).toBe(200);
    const low = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await lower.json()) as { id: string }).id } });
    expect((low.lines as unknown as CartLine[])[0]).toMatchObject({ unitPriceCents: 3000, cartPriced: true });
    expect((low.lines as unknown as CartLine[])[0].appPrice).toBeUndefined();
    expect(await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "cart.priced_as_shopify_cart" } })).toMatchObject({ data: { reason: "price_unverified", detail: V(11) } });
    // Higher: the markup isn't lost.
    stubCart({ token: "bnd-token-6", currency: "EUR", total_price: 3500, items: [{ variant_id: 11, quantity: 1, final_line_price: 3500, line_level_discount_allocations: [] }] });
    const higher = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-6" });
    expect(higher.status).toBe(200);
    const high = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await higher.json()) as { id: string }).id } });
    expect((high.lines as unknown as CartLine[])[0]).toMatchObject({ unitPriceCents: 3500, cartPriced: true });
    // Subscription line forged as a one-time purchase (no selling_plan sent, appPricing true): refused.
    stubCart({ token: "bnd-token-6", currency: "EUR", total_price: 2400, items: [{ variant_id: 11, quantity: 1, final_line_price: 2400, line_level_discount_allocations: [], selling_plan_allocation: { selling_plan: { id: 9 }, price: 2400 } }] });
    const sub = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-6", appPricing: true });
    expect([sub.status, ((await sub.json()) as { reason: string }).reason]).toEqual([409, "subscription"]);
    // A plain cart at the variant's price: fine.
    fetchMock = stubCart({ token: "bnd-token-6", currency: "EUR", total_price: 1500, items: [{ variant_id: 12, quantity: 1, final_line_price: 1500, line_level_discount_allocations: [] }] });
    const plain = await post({ store: store.publicId, items: [{ variant_id: 12, quantity: 1 }], cartToken: "bnd-token-6" });
    expect(plain.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an item the re-read cart doesn't hold keeps the storefront's properties (direct API call)", async () => {
    const store = await makeStore();
    stubCart({ token: "bnd-token-9", currency: "EUR", items: [] });
    const res = await post({ store: store.publicId, items: [{ variant_id: 12, quantity: 1, properties: { Prénom: "Tom" } }], cartToken: "bnd-token-9" });
    expect(res.status).toBe(200);
    const s = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await res.json()) as { id: string }).id } });
    expect((s.lines as unknown as CartLine[])[0]).toMatchObject({ properties: [{ name: "Prénom", value: "Tom" }], locked: true });
    // A bundle app's line the cart doesn't hold (its price can't be read there): the variant's own price.
    const bundle = await post({ store: store.publicId, items: [{ variant_id: 12, quantity: 1, properties: { _kaching_bundle_id: "kb" } }], cartToken: "bnd-token-9" });
    expect(bundle.status).toBe(200);
    const bs = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await bundle.json()) as { id: string }).id } });
    expect((bs.lines as unknown as CartLine[])[0]).toMatchObject({ variantId: V(12), unitPriceCents: 1500, locked: true, properties: [{ name: "_kaching_bundle_id", value: "kb" }] });
  });

  it("the checkout's quantity break doesn't stack on a Kaching discount-function bundle (appDiscounted)", async () => {
    const store = await makeStore();
    await db.store.update({ where: { id: store.id }, data: { quantityBreaks: [{ minQty: 3, percent: 10 }] } });
    stubCart({
      token: "bnd-token-10",
      currency: "EUR",
      total_price: 7500,
      items: [
        {
          variant_id: 11,
          quantity: 3,
          price: 3000,
          final_price: 2500,
          final_line_price: 7500,
          original_line_price: 9000,
          line_level_discount_allocations: [{ amount: 1500, discount_application: { type: "automatic", title: "Kaching 3 pour 75" } }],
          properties: { __kaching_bundles: KB },
        },
      ],
    });
    const res = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 3, properties: { __kaching_bundles: KB } }], cartToken: "bnd-token-10", automaticDiscounts: true });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const session = await db.checkoutSession.findUniqueOrThrow({ where: { id }, include: { store: true } });
    expect((session.lines as unknown as CartLine[])[0]).toMatchObject({ appDiscounted: true, locked: true });
    const q = await quoteSession(session, { addOnIds: [] });
    expect([q.totals.subtotalCents, q.totals.volumeDiscountCents, q.totals.totalCents, q.volumeBreak?.current ?? null, q.cartLocked]).toEqual([9000, 0, 7500, null, true]);
  });
  it("I + G: Kaching BXGY on one variant → two order lines; a code that would drop the gift's automatic discount is refused", async () => {
    const store = await makeStore();
    await db.store.update({ where: { id: store.id }, data: { shopifyScopes: "read_products,read_discounts" } });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    await db.discountCode.create({ data: { storeId: store.id, code: "BNDMOITIE", type: "PERCENT", value: 60 } });
    // The gift's automatic discount combines with nothing (Shopify's settings).
    shopify.shopifyGraphql.mockResolvedValue({
      discountNodes: { nodes: [{ discount: { __typename: "DiscountAutomaticBxgy", title: "Kaching Gift", combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false } } }] },
    });
    const paidKb = JSON.stringify({ deal: "bx", main: true, id: "a1" });
    const freeKb = JSON.stringify({ deal: "bx", bxgy: true, id: "a2" });
    stubCart({
      token: "bnd-token-11",
      currency: "EUR",
      total_price: 3000,
      items: [
        { variant_id: 11, quantity: 1, price: 3000, final_price: 3000, final_line_price: 3000, original_line_price: 3000, line_level_discount_allocations: [], properties: { __kaching_bundles: paidKb } },
        {
          variant_id: 11,
          quantity: 1,
          price: 3000,
          final_price: 0,
          final_line_price: 0,
          original_line_price: 3000,
          line_level_discount_allocations: [{ amount: 3000, discount_application: { type: "automatic", title: "Kaching Gift" } }],
          properties: { __kaching_bundles: freeKb },
        },
      ],
    });
    const res = await post({
      store: store.publicId,
      items: [
        { variant_id: 11, quantity: 1, properties: { __kaching_bundles: paidKb } },
        { variant_id: 11, quantity: 1, properties: { __kaching_bundles: freeKb } },
      ],
      cartToken: "bnd-token-11",
      automaticDiscounts: true,
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const session = await db.checkoutSession.findUniqueOrThrow({ where: { id }, include: { store: true } });
    expect((session.lines as unknown as CartLine[]).map((l) => [l.variantId, l.quantity, !!l.appGift, !!l.locked])).toEqual([
      [V(11), 1, false, true],
      [V(11), 1, true, true],
    ]);
    const q = await quoteSession(session, { addOnIds: [] });
    expect([q.totals.subtotalCents, q.automaticDiscount?.cents, q.totals.totalCents, q.cartLocked]).toEqual([6000, 3000, 3000, true]);
    // 60 % off would beat the gift's discount — and have the buyer pay for the gift: refused.
    const coded = await quoteSession(session, { addOnIds: [], discountCode: "BNDMOITIE" });
    expect([coded.discount, coded.discountErrorCode, coded.automaticDiscount?.cents, coded.totals.totalCents]).toEqual([null, "discount_not_combinable_gift", 3000, 3000]);
    expect(coded.discountError).toContain("cadeau");

    const prepared = await prepareSession(session, { addOnIds: [] });
    await db.checkoutSession.update({ where: { id }, data: { email: "bx@bnd.test", shippingAddress: address } });
    await markPaid(id, { id: `pay_${id}`, totalCents: 3000, currency: "eur", checkoutConfigurationId: prepared.checkoutConfigurationId });
    const order = buildOrderCreateInput(shopify.createPaidOrder.mock.calls[0][1]);
    const items = order.lineItems as { variantId: string; quantity: number; priceSet: { shopMoney: { amount: string } }; properties?: { name: string; value: string }[] }[];
    expect(items.map((i) => [i.variantId, i.quantity, i.priceSet.shopMoney.amount, i.properties?.[0]?.value])).toEqual([
      [V(11), 1, "30.00", paidKb],
      [V(11), 1, "0.00", freeKb],
    ]);
  });

  it("H + D: the cart's discount code is kept when valid (removable), dropped quietly otherwise; a plain automatic discount doesn't fix the cart", async () => {
    const store = await makeStore();
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    await db.discountCode.create({ data: { storeId: store.id, code: "BNDFAST10", type: "PERCENT", value: 10 } });
    const cart = (code: string) => ({
      token: "bnd-token-12",
      currency: "EUR",
      total_price: 2430,
      discount_codes: [{ code, applicable: true }],
      items: [
        {
          variant_id: 11,
          quantity: 1,
          final_line_price: 2430,
          line_level_discount_allocations: [
            { amount: 270, discount_application: { type: "discount_code", title: code } },
            { amount: 300, discount_application: { type: "automatic", title: "Soldes" } },
          ],
        },
      ],
    });
    stubCart(cart("BNDFAST10"));
    const res = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-12", automaticDiscounts: true });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const session = await db.checkoutSession.findUniqueOrThrow({ where: { id }, include: { store: true } });
    expect(session.cartContext).toEqual({ discountCodes: ["BNDFAST10"], codeCheck: { code: "BNDFAST10", totalCents: 2430, items: [{ variantId: V(11), quantity: 1 }] } });
    // D: a sitewide automatic discount on a plain cart doesn't lock it.
    expect((session.lines as unknown as CartLine[])[0].locked).toBeUndefined();
    const q = await quoteSession(session, { addOnIds: [] });
    expect([q.discount?.code, q.automaticDiscount?.cents, q.totals.totalCents, q.discountError, q.cartLocked]).toEqual(["BNDFAST10", 300, 3000 - 300 - 270, null, undefined]);
    // Removed by the buyer (""): not re-applied.
    const removed = await quoteSession(session, { addOnIds: [], discountCode: "" });
    expect([removed.discount, removed.totals.totalCents]).toEqual([null, 2700]);
    // D: a change drops the automatic discount, and says so.
    const changed = await quoteSession(session, { addOnIds: [], discountCode: "", quantities: { [V(11)]: 2 } });
    expect([changed.automaticDiscount, changed.automaticDiscountLost, changed.totals.totalCents]).toEqual([null, ["Soldes"], 6000]);

    // 1: a code that lowered the cart but can't be verified here (unknown here, Shopify codes not read):
    // the cart charged as Shopify charges it, its automatic discount in the price; the code goes through
    // the checkout's own code pipeline (validated, limits counted) — here it doesn't apply, said.
    stubCart(cart("BNDUNKNOWN"));
    const other = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-12" });
    expect(other.status).toBe(200);
    const o = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await other.json()) as { id: string }).id }, include: { store: true } });
    expect((o.lines as unknown as CartLine[])[0]).toMatchObject({ unitPriceCents: 2700, cartPriced: true, locked: true });
    expect(o.cartContext).toMatchObject({ discountCodes: ["BNDUNKNOWN"], cartPriced: { reason: "code_unsupported", discounted: true } });
    expect(o.cartDiscounts).toBeNull();
    const priced = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "cart.priced_as_shopify_cart" }, orderBy: { createdAt: "desc" } });
    expect(priced.message).toContain("code promo du panier Shopify impossible à vérifier");
    expect(priced.data).toMatchObject({ reason: "code_unsupported", detail: "BNDUNKNOWN: Shopify codes not read" });
    // The quote: the automatic discount already in the price (none on top); the cart's code tried like a
    // typed one and, invalid here, dropped with a notice (never charged silently).
    const oq = await quoteSession(o, { addOnIds: [] });
    expect([oq.totals.subtotalCents, oq.totals.totalCents, oq.automaticDiscount, oq.cartLocked]).toEqual([2700, 2700, null, true]);
    expect(oq.cartCodeLost).toEqual({ code: "BNDUNKNOWN", reason: "discount_invalid", blocking: false });
    // Another code than the cart's own: refused (it can't be checked against the cart's automatic discount).
    const typed = await quoteSession(o, { addOnIds: [], discountCode: "BNDFAST10" });
    expect([typed.discount, typed.discountErrorCode, typed.totals.totalCents]).toEqual([null, "discount_cart_priced", 2700]);
    // Two codes that both lowered the cart: the checkout applies the first it can verify (a valid app code here).
    stubCart({
      ...cart("BNDFAST10"),
      total_price: 2330,
      items: [{ ...cart("BNDFAST10").items[0], final_line_price: 2330, line_level_discount_allocations: [...cart("BNDFAST10").items[0].line_level_discount_allocations, { amount: 100, discount_application: { type: "discount_code", title: "OTHER" } }] }],
    });
    const two = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-12" });
    expect(two.status).toBe(200);
    const t = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await two.json()) as { id: string }).id } });
    expect([(t.lines as unknown as CartLine[])[0].unitPriceCents, (t.cartContext as { discountCodes?: string[] }).discountCodes]).toEqual([2700, ["BNDFAST10", "OTHER"]]);
    const tq = await quoteSession({ ...t, store: o.store }, { addOnIds: [] });
    expect([tq.discount?.code, tq.totals.totalCents]).toEqual(["BNDFAST10", 2430]);
    // The cart's code takes off exactly what it took off in Shopify's cart (25.00 there, where Shopify
    // combined it with the automatic discount), not the checkout's own 10 % (27.00); counted as a use.
    stubCart({
      ...cart("BNDFAST10"),
      total_price: 2350,
      items: [
        {
          ...cart("BNDFAST10").items[0],
          final_line_price: 2350,
          line_level_discount_allocations: [
            { amount: 250, discount_application: { type: "discount_code", title: "BNDFAST10" } },
            { amount: 300, discount_application: { type: "automatic", title: "Soldes" } },
            { amount: 100, discount_application: { type: "discount_code", title: "OTHER" } },
          ],
        },
      ],
    });
    const exact = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-12" });
    const e = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await exact.json()) as { id: string }).id }, include: { store: true } });
    expect(e.cartContext).toMatchObject({ discountCodes: ["BNDFAST10", "OTHER"], cartPriced: { codeCents: { BNDFAST10: 250, OTHER: 100 } } });
    const eq = await quoteSession(e, { addOnIds: [] });
    expect([eq.discount?.code, eq.totals.discountCents, eq.totals.totalCents]).toEqual(["BNDFAST10", 250, 2450]);
    // The other code that took money off in the cart (unknown here): one code applies here, that one is said.
    expect(eq.cartCodeLost).toEqual({ code: "OTHER", reason: "discount_invalid", blocking: false });
  });

  it("several codes in the cart: the first that applies here is kept (exact amount), one that took nothing is skipped, a lost one is said as the cart wrote it", async () => {
    const store = await makeStore();
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 500 } });
    await db.discountCode.createMany({
      data: [
        { storeId: store.id, code: "BNDGOOD", type: "PERCENT", value: 10 },
        { storeId: store.id, code: "BNDNOTHING", type: "PERCENT", value: 50 },
        { storeId: store.id, code: "BNDSHIP", type: "FREE_SHIPPING", value: 0 },
      ],
    });
    const cart = (codes: string[], allocations: { amount: number; discount_application: { type: string; title: string } }[]) => {
      const off = allocations.reduce((s, a) => s + a.amount, 0);
      return {
        token: "bnd-token-40",
        currency: "EUR",
        total_price: 3000 - off,
        discount_codes: codes.map((code) => ({ code, applicable: true })),
        items: [{ variant_id: 11, quantity: 1, final_line_price: 3000 - off, line_level_discount_allocations: allocations }],
      };
    };
    const open = async (c: unknown) => {
      stubCart(c);
      const res = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-40" });
      expect(res.status).toBe(200);
      return db.checkoutSession.findUniqueOrThrow({ where: { id: ((await res.json()) as { id: string }).id }, include: { store: true } });
    };

    // Two codes lowered the cart (Shopify combined them): "bndLost" (unknown here, the larger) first,
    // then BNDGOOD; BNDSHIP listed too. BNDGOOD applies for exactly its 1.50; the lost one is said, as written.
    const two = await open(cart(["bndLost", "BNDGOOD", "BNDSHIP"], [
      { amount: 200, discount_application: { type: "discount_code", title: "bndLost" } },
      { amount: 150, discount_application: { type: "discount_code", title: "BNDGOOD" } },
    ]));
    expect(two.cartContext).toMatchObject({ discountCodes: ["bndLost", "BNDGOOD", "BNDSHIP"], cartPriced: { codeCents: { BNDLOST: 200, BNDGOOD: 150 }, codesTakenOff: ["bndLost", "BNDGOOD"] } });
    const q = await quoteSession(two, { addOnIds: [] });
    expect([q.discount?.code, q.totals.discountCents, q.totals.shippingCents, q.totals.totalCents]).toEqual(["BNDGOOD", 150, 500, 3000 - 150 + 500]);
    expect(q.cartCodeLost).toEqual({ code: "bndLost", reason: "discount_invalid", blocking: false });
    expect([q.discountError, q.discountErrorCode]).toEqual([null, null]);

    // One code lowered the cart (unknown here); BNDNOTHING took nothing there (Shopify didn't combine
    // it): skipped silently, never applied for its 50 %; the free-shipping code applies (its own rule).
    const ship = await open(cart(["bndLost", "BNDNOTHING", "BNDSHIP"], [{ amount: 200, discount_application: { type: "discount_code", title: "bndLost" } }]));
    expect(ship.cartContext).toMatchObject({ discountCodes: ["bndLost", "BNDNOTHING", "BNDSHIP"], cartPriced: { codesTakenOff: ["bndLost"] } });
    const s = await quoteSession(ship, { addOnIds: [] });
    expect([s.discount?.code, s.discount?.type, s.totals.discountCents, s.totals.shippingCents, s.totals.totalCents]).toEqual(["BNDSHIP", "FREE_SHIPPING", 0, 0, 3000]);
    expect(s.cartCodeLost).toEqual({ code: "bndLost", reason: "discount_invalid", blocking: false });

    // The free-shipping code not applied while another code is: said too (the buyer loses it).
    const both = await open(cart(["BNDGOOD", "BNDSHIP"], [{ amount: 300, discount_application: { type: "discount_code", title: "BNDGOOD" } }]));
    const b = await quoteSession(both, { addOnIds: [] });
    expect([b.discount?.code, b.totals.totalCents, b.cartCodeLost]).toEqual(["BNDGOOD", 3000 - 300 + 500, { code: "BNDSHIP", reason: "discount_not_combinable", blocking: false }]);
    expect(await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "cart.discount_code_dropped" } })).toMatchObject({ data: { code: "bndLost", reason: "discount_invalid" } });

    // Shopify can't be asked about the code that took the most off (asked twice): no other code
    // meanwhile, payment waits for it ("réessayez") — never charged more.
    const { clearShopifyDiscountCache } = await import("@/lib/shopify-discounts");
    const reading = await db.store.update({ where: { id: store.id }, data: { shopifyDiscountCodes: true, shopifyScopes: "read_products,read_discounts" } });
    clearShopifyDiscountCache();
    shopify.shopifyGraphql.mockRejectedValue(new Error("Shopify 503"));
    const waiting = await quoteSession({ ...two, store: reading }, { addOnIds: [] });
    expect([waiting.discount, waiting.cartCodeLost]).toEqual([null, { code: "bndLost", reason: "discount_unavailable", blocking: true }]);
    expect(shopify.shopifyGraphql).toHaveBeenCalledTimes(2);
    await expect(prepareSession({ ...two, store: reading }, { addOnIds: [], countryCode: "FR" })).rejects.toMatchObject({ code: "discount_unavailable" });
    shopify.shopifyGraphql.mockReset();
  });

  it("a cart permalink's ?discount=CODE is offered to the quote like the cart's own code (validated there); a malformed one is left out, the cart still sold", async () => {
    const store = await makeStore();
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    await db.discountCode.create({ data: { storeId: store.id, code: "BNDLINK", type: "PERCENT", value: 10 } });
    const res = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], discountCode: " bndlink " });
    expect(res.status).toBe(200);
    const s = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await res.json()) as { id: string }).id }, include: { store: true } });
    expect(s.cartContext).toEqual({ discountCodes: ["bndlink"] });
    const q = await quoteSession(s, { addOnIds: [] });
    expect([q.discount?.code, q.totals.totalCents, q.cartCodeLost]).toEqual(["BNDLINK", 2700, undefined]);
    // Removable like the cart's own code.
    expect((await quoteSession(s, { addOnIds: [], discountCode: "" })).totals.totalCents).toBe(3000);
    // An unknown one: said, never blocking (it lowered no cart).
    const unknown = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], discountCode: "BNDNOPE" });
    const u = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await unknown.json()) as { id: string }).id }, include: { store: true } });
    expect((await quoteSession(u, { addOnIds: [] })).cartCodeLost).toEqual({ code: "BNDNOPE", reason: "discount_invalid", blocking: false });
    // Not a code (markup, too long, a sentence the notice would repeat): left out.
    for (const discountCode of ["<b>" + "x".repeat(80), "Appelez le 06 12 34 56 78"]) {
      const odd = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], discountCode });
      expect(odd.status).toBe(200);
      const o = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await odd.json()) as { id: string }).id } });
      expect(o.cartContext).toBeNull();
    }
  });

  it("a cart's amount-off code on a line raised to the variant's price takes off its own amount, never more (a percentage scales)", async () => {
    const store = await makeStore();
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    await db.discountCode.createMany({
      data: [
        { storeId: store.id, code: "BNDFIVE", type: "FIXED", value: 500 },
        { storeId: store.id, code: "BNDTWENTY", type: "PERCENT", value: 20 },
      ],
    });
    // Another market's 25.00 for a 30.00 variant (no sign it's an app's: raised), the code's amount off.
    const open = async (code: string, off: number) => {
      stubCart({
        token: "bnd-token-50",
        currency: "EUR",
        total_price: 2500 - off,
        discount_codes: [{ code, applicable: true }],
        items: [{ variant_id: 11, quantity: 1, price: 2500, original_line_price: 2500, final_line_price: 2500 - off, line_level_discount_allocations: [{ amount: off, discount_application: { type: "discount_code", title: code } }] }],
      });
      const res = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-50" });
      expect(res.status).toBe(200);
      return db.checkoutSession.findUniqueOrThrow({ where: { id: ((await res.json()) as { id: string }).id }, include: { store: true } });
    };
    const fixed = await open("BNDFIVE", 500);
    expect(fixed.cartContext).toMatchObject({ cartPriced: { raised: true, codeCents: { BNDFIVE: 600 } } });
    const f = await quoteSession(fixed, { addOnIds: [] });
    // 30.00 − 5.00 (not the 6.00 its share of the raised line would be).
    expect([f.discount?.code, f.totals.discountCents, f.totals.totalCents, f.cartPricesAdjusted]).toEqual(["BNDFIVE", 500, 2500, true]);
    // 20 % off: 5.00 of 25.00 in the cart, 6.00 of the 30.00 charged.
    const pct = await quoteSession(await open("BNDTWENTY", 500), { addOnIds: [] });
    expect([pct.discount?.code, pct.totals.discountCents, pct.totals.totalCents]).toEqual(["BNDTWENTY", 600, 2400]);
  });

  it("a cart charged as Shopify charges it: its own code that took nothing there takes nothing here (typed again: said)", async () => {
    const store = await makeStore();
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    await db.discountCode.create({ data: { storeId: store.id, code: "BNDNOSTACK", type: "PERCENT", value: 10 } });
    // An app's surcharge (cart-priced) and a code Shopify lists as applicable but didn't apply (not combinable).
    stubCart({ token: "bnd-token-30", currency: "EUR", total_price: 3900, discount_codes: [{ code: "BNDNOSTACK", applicable: true }], items: [{ variant_id: 11, quantity: 1, final_line_price: 3900, line_level_discount_allocations: [], properties: { Gravure: "Tom" } }] });
    const res = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1, properties: { Gravure: "Tom" } }], cartToken: "bnd-token-30" });
    expect(res.status).toBe(200);
    const s = await db.checkoutSession.findUniqueOrThrow({ where: { id: ((await res.json()) as { id: string }).id }, include: { store: true } });
    expect(s.cartContext).toMatchObject({ discountCodes: ["BNDNOSTACK"], cartPriced: { reason: "price_higher", codesTakenOff: [] } });
    const q = await quoteSession(s, { addOnIds: [] });
    expect([q.discount, q.totals.totalCents, q.cartCodeLost]).toEqual([null, 3900, undefined]);
    const typed = await quoteSession(s, { addOnIds: [], discountCode: "BNDNOSTACK" });
    expect([typed.discount, typed.discountErrorCode, typed.totals.totalCents]).toEqual([null, "discount_not_combinable", 3900]);
  });

  it("1: a verified cart code dropped later is never hidden: payment blocked on the same cart (non-transient, or Shopify unreachable twice), a notice after a buyer's change", async () => {
    const { clearShopifyDiscountCache } = await import("@/lib/shopify-discounts");
    const store = await makeStore();
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    const row = await db.discountCode.create({ data: { storeId: store.id, code: "BNDLOST10", type: "PERCENT", value: 10 } });
    stubCart({
      token: "bnd-token-20",
      currency: "EUR",
      total_price: 2700,
      items: [{ variant_id: 11, quantity: 1, final_line_price: 2700, line_level_discount_allocations: [{ amount: 300, discount_application: { type: "discount_code", title: "BNDLOST10" } }] }],
    });
    const res = await post({ store: store.publicId, items: [{ variant_id: 11, quantity: 1 }], cartToken: "bnd-token-20" });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const session = await db.checkoutSession.findUniqueOrThrow({ where: { id }, include: { store: true } });
    expect((await quoteSession(session, { addOnIds: [] })).totals.totalCents).toBe(2700);

    // The code was deactivated meanwhile: not a buyer's field error, but payment is refused (30 € > 27 €).
    await db.discountCode.update({ where: { id: row.id }, data: { active: false } });
    const lost = await quoteSession(session, { addOnIds: [] });
    expect([lost.discount, lost.discountError, lost.cartCodeLost, lost.totals.totalCents]).toEqual([null, null, { code: "BNDLOST10", reason: "discount_invalid", blocking: true }, 3000]);
    await expect(prepareSession(session, { addOnIds: [], countryCode: "FR" })).rejects.toMatchObject({ code: "cart_code_lost" });
    expect(await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "cart.discount_code_dropped" } })).toMatchObject({ data: { code: "BNDLOST10", reason: "discount_invalid" } });
    // The buyer removed it ("") on purpose: no block.
    expect((await quoteSession(session, { addOnIds: [], discountCode: "" })).cartCodeLost).toBeUndefined();
    // The buyer changed the lines (a plain cart): said, not blocking.
    const changed = await quoteSession(session, { addOnIds: [], quantities: { [V(11)]: 2 } });
    expect(changed.cartCodeLost).toEqual({ code: "BNDLOST10", reason: "discount_invalid", blocking: false });

    // Transient: Shopify's code lookup fails, asked twice, then payment is refused ("réessayez"), never charged more.
    await db.checkoutSession.update({ where: { id }, data: { lines: session.lines as object } });
    await db.discountCode.delete({ where: { id: row.id } });
    const shopifyStore = await db.store.update({ where: { id: store.id }, data: { shopifyDiscountCodes: true, shopifyScopes: "read_products,read_discounts" } });
    clearShopifyDiscountCache();
    shopify.shopifyGraphql.mockRejectedValue(new Error("Shopify 503"));
    const s2 = { ...(await db.checkoutSession.findUniqueOrThrow({ where: { id } })), store: shopifyStore };
    s2.lines = (s2.lines as unknown as CartLine[]).map((l) => ({ ...l, quantity: 1 })) as never;
    const transient = await quoteSession(s2, { addOnIds: [] });
    expect(transient.cartCodeLost).toEqual({ code: "BNDLOST10", reason: "discount_unavailable", blocking: true });
    expect(shopify.shopifyGraphql).toHaveBeenCalledTimes(2);
    await expect(prepareSession(s2, { addOnIds: [], countryCode: "FR" })).rejects.toMatchObject({ code: "discount_unavailable" });
    shopify.shopifyGraphql.mockReset();
  });

  it("3: an unreadable cart the storefront saw discounted automatically is refused for a retry (never Shopify's checkout)", async () => {
    const store = await makeStore();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("oops", { status: 500 })),
    );
    const res = await post({ store: store.publicId, items: [{ variant_id: 12, quantity: 1 }], cartToken: "bnd-token-21", automaticDiscounts: true });
    expect([res.status, ((await res.json()) as { reason: string }).reason]).toEqual([409, "cart_unreadable"]);
  });

  it("F: a plain cart's re-read gives up after 1.5 s without an alert and goes on at the variants' prices", async () => {
    const store = await makeStore();
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    vi.stubGlobal("fetch", hang);
    const started = Date.now();
    const plain = await post({ store: store.publicId, items: [{ variant_id: 12, quantity: 1 }], cartToken: "bnd-token-13" });
    const took = Date.now() - started;
    expect(plain.status).toBe(200);
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(2800);
    const incident = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "discount.cart_read_failed" } });
    expect(incident.data).toMatchObject({ plainCart: true });
  }, 15_000);
});
