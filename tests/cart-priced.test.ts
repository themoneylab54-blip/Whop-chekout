import { describe, expect, it } from "vitest";
import { cartHeldByApp, cartPricedLines, type CartJs } from "@/lib/cart-fidelity";
import { computeTotals, offerBaseLines, type CartLine, type LineComponent } from "@/lib/pricing";
import { buildOrderCreateInput, type PaidOrderInput } from "@/lib/shopify";

/*
 * A cart the checkout can't represent line by line (an app's price, a bundle, a code it couldn't
 * verify, another currency) is charged as Shopify's cart charges it: one locked line per cart line,
 * never below the variant's price without a sign the buyer can't forge, the cart's codes left to the
 * checkout's own code pipeline. Only subscriptions and gift cards stay Shopify's.
 */

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const line = (o: Partial<CartLine> = {}): CartLine => ({
  variantId: V(11),
  productId: "gid://shopify/Product/1",
  productHandle: "doudoune",
  title: "Doudoune",
  variantTitle: "S",
  sku: "DD-S",
  imageUrl: "https://cdn.shopify.com/a.jpg",
  quantity: 1,
  unitPriceCents: 3000,
  compareAtCents: 4000,
  inventory: 5,
  requiresShipping: true,
  ...o,
});
const item = (o: Record<string, unknown> = {}) => ({
  variant_id: 11,
  quantity: 1,
  price: 3000,
  final_price: 3000,
  final_line_price: 3000,
  original_line_price: 3000,
  properties: {},
  line_level_discount_allocations: [],
  ...o,
});
const auto = (amount: number, title = "Soldes") => ({ amount, discount_application: { type: "automatic", title } });
const code = (amount: number, title: string) => ({ amount, discount_application: { type: "discount_code", title } });
const cartOf = (items: Record<string, unknown>[], o: Partial<CartJs> = {}): CartJs => {
  const sum = items.reduce((s, i) => s + Number(i.final_line_price ?? 0), 0);
  return { currency: "EUR", items, total_price: sum, ...o } as CartJs;
};
const ok = (r: ReturnType<typeof cartPricedLines>) => {
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r;
};
const charged = (lines: CartLine[]) => lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);

describe("cartPricedLines: the cart as Shopify charges it", () => {
  it("an app's surcharge (cart price above the variant's): charged as the cart says, not refused", () => {
    const r = ok(cartPricedLines(cartOf([item({ final_price: 3900, final_line_price: 3900, original_line_price: 3900, price: 3900, properties: { Gravure: "Léa" } })]), [line()], "EUR"));
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ variantId: V(11), quantity: 1, unitPriceCents: 3900, locked: true, cartPriced: true, properties: [{ name: "Gravure", value: "Léa" }] });
    // A compare-at below the charged price would show a fake saving.
    expect(r.lines[0].compareAtCents).toBe(4000);
    expect(r.lines[0].appPrice).toBeUndefined();
    expect(r.discounted).toBe(false);
  });

  it("a lower cart price without a sign the buyer can't forge (another market's price list, tax-inclusive price, an app's price alone) is never kept: the variant's price, said", () => {
    const r = ok(cartPricedLines(cartOf([item({ price: 2500, final_price: 2500, final_line_price: 2500, original_line_price: 2500, properties: { _bundle_id: "x" } })]), [line()], "EUR"));
    expect(r.lines[0]).toMatchObject({ unitPriceCents: 3000, cartPriced: true });
    expect(r.lines[0].appPrice).toBeUndefined();
    expect(r.raised).toBe(true);
    // Its automatic discount kept in proportion: 20 % off a 25.00 market price → 20 % off the 30.00 price.
    const discounted = ok(cartPricedLines(cartOf([item({ price: 2500, final_price: 2000, final_line_price: 2000, original_line_price: 2500, line_level_discount_allocations: [auto(500)] })]), [line()], "EUR"));
    expect(discounted.lines[0].unitPriceCents).toBe(2400);
  });

  it("Shopify's own signs keep a lower price: a bundle flagged has_components, a line Shopify prices at 0 (an app's gift)", () => {
    const flagged = ok(cartPricedLines(cartOf([item({ final_price: 2400, final_line_price: 2400, has_components: true })]), [line()], "EUR"));
    expect([flagged.lines[0].unitPriceCents, flagged.raised]).toEqual([2400, false]);
    const gift = ok(cartPricedLines(cartOf([item({ price: 0, final_price: 0, final_line_price: 0, original_line_price: 0 })]), [line()], "EUR"));
    expect([gift.lines[0].unitPriceCents, gift.raised]).toEqual([0, false]);
  });

  it("a lower price on bundle components Shopify expanded is kept, the variant's price struck through", () => {
    const components = [
      { variant_id: 21, quantity: 1, final_line_price: 1500 },
      { variant_id: 22, quantity: 1, final_line_price: 1000 },
    ];
    const r = ok(cartPricedLines(cartOf([item({ final_price: 2500, final_line_price: 2500, item_components: components })]), [line()], "EUR"));
    expect(r.lines[0]).toMatchObject({ unitPriceCents: 2500, appPrice: { unitCents: 2500, originalUnitCents: 3000 }, compareAtCents: 4000 });
    expect(r.lines[0].components?.map((c) => c.variantId)).toEqual([V(21), V(22)]);
  });

  it("automatic and cart-level discounts are in the prices; the cart's codes are not (the checkout applies them like a typed code)", () => {
    const cart = cartOf(
      [
        item({ quantity: 2, final_line_price: 4700, original_line_price: 6000, line_level_discount_allocations: [auto(1000), code(300, "BIENVENUE")] }),
        item({ variant_id: 12, price: 1500, final_price: 1500, final_line_price: 1500, original_line_price: 1500 }),
      ],
      // Cart-level: an automatic 400 and the code's 200 (total = 6200 - 400 - 200).
      { cart_level_discount_applications: [{ type: "automatic", title: "-400", total_allocated_amount: 400 }, { type: "discount_code", title: "BIENVENUE", total_allocated_amount: 200 }], total_price: 5600 },
    );
    const r = ok(cartPricedLines(cart, [line({ quantity: 2 }), line({ variantId: V(12), unitPriceCents: 1500, compareAtCents: null })], "EUR"));
    // Line 1: 6000 − 1000 automatic − its share of the 400 (5000 / 6500 → 308); line 2: 1500 − 92.
    expect(r.lines.map((l) => [l.quantity, l.unitPriceCents])).toEqual([
      [2, 2346],
      [1, 1408],
    ]);
    // 6000 + 1500 − 1000 − 400 = 6100 (codes left to the checkout), rounded down by at most a cent per unit.
    expect(6100 - charged(r.lines)).toBeGreaterThanOrEqual(0);
    expect(6100 - charged(r.lines)).toBeLessThan(2);
    expect(r.discounted).toBe(true);
    // What the code took off in Shopify's cart (line + cart level): applied for exactly that by the quote.
    expect(r.codeCents).toEqual({ BIENVENUE: 500 });
  });

  it("never more than the cart: a line total that doesn't divide by its quantity is rounded down", () => {
    const r = ok(cartPricedLines(cartOf([item({ quantity: 3, final_line_price: 8000, original_line_price: 9000, line_level_discount_allocations: [auto(1000)] })]), [line({ quantity: 3 })], "EUR"));
    expect(r.lines[0]).toMatchObject({ quantity: 3, unitPriceCents: 2666 });
    expect(8000 - charged(r.lines)).toBeGreaterThanOrEqual(0);
    expect(8000 - charged(r.lines)).toBeLessThan(3);
  });

  it("a cart line the Admin API didn't price (unavailable, archived) can't be sold here", () => {
    expect(cartPricedLines(cartOf([item({ variant_id: 99 })]), [line()], "EUR")).toMatchObject({ ok: false, reason: "unknown_line", detail: V(99) });
  });

  it("the same variant on two cart lines (paid + gift made free by an automatic discount): two lines, the cart fixed", () => {
    const cart = cartOf([item({ properties: { _deal: "A" } }), item({ final_line_price: 0, final_price: 0, line_level_discount_allocations: [auto(3000, "Gift")], properties: { _deal: "A", _gift: "1" } })]);
    const r = ok(cartPricedLines(cart, [line({ quantity: 2 })], "EUR"));
    expect(r.lines.map((l) => [l.quantity, l.unitPriceCents])).toEqual([
      [1, 3000],
      [1, 0],
    ]);
    expect(cartHeldByApp(r.lines)).toBe(true);
  });

  it("a bundle parent Shopify sells only through its components: its components ordered (scaled to the quantity), never the parent alone", () => {
    const parts: LineComponent[] = [
      { variantId: V(31), quantity: 1, weightCents: 2000, title: "Bonnet" },
      { variantId: V(32), quantity: 2, weightCents: 2000, title: "Gants" },
    ];
    const parent = line({ variantId: V(30), requiresComponents: true, quantity: 2 });
    const cart = cartOf([item({ variant_id: 30, quantity: 2, final_line_price: 6000, has_components: true })]);
    const r = ok(cartPricedLines(cart, [parent], "EUR", new Map([[V(30), parts]])));
    expect(r.lines[0].components).toEqual([
      { variantId: V(31), quantity: 2, weightCents: 4000, title: "Bonnet" },
      { variantId: V(32), quantity: 4, weightCents: 4000, title: "Gants" },
    ]);
    // Without components from the Admin API: refused (an order of the parent alone would be wrong).
    expect(cartPricedLines(cart, [parent], "EUR")).toMatchObject({ ok: false, reason: "bundle_components_unresolved" });
    // An app's expanded bundle bought twice (not a Shopify Bundles parent): the variant itself.
    const two = ok(cartPricedLines(cartOf([item({ quantity: 2, final_line_price: 6000, item_components: [{ variant_id: 21, quantity: 1, final_line_price: 3000 }] })]), [line({ quantity: 2 })], "EUR"));
    expect(two.lines[0].components).toBeUndefined();
  });

  it("another currency: the cart's discount ratio on the shop's price, never below it otherwise", () => {
    // 20 % off by an automatic discount in USD, applied to the EUR price.
    const discounted = cartOf([item({ price: 3300, final_price: 2640, final_line_price: 2640, original_line_price: 3300, line_level_discount_allocations: [auto(660)] })], { currency: "USD" });
    expect(ok(cartPricedLines(discounted, [line()], "EUR")).lines[0].unitPriceCents).toBe(2400);
    // A lower USD price without a discount (a market price list): the EUR variant's price.
    const listed = cartOf([item({ price: 2640, final_price: 2640, final_line_price: 2640, original_line_price: 2640 })], { currency: "USD" });
    expect(ok(cartPricedLines(listed, [line()], "EUR")).lines[0].unitPriceCents).toBe(3000);
    // A line Shopify prices at 0 (an app's gift) stays free in any currency.
    const gift = cartOf([item({ price: 0, final_price: 0, final_line_price: 0, original_line_price: 0 })], { currency: "USD" });
    expect(ok(cartPricedLines(gift, [line()], "EUR")).lines[0].unitPriceCents).toBe(0);
    // The codes that took money off are known in any currency (their cents only in the shop's).
    const coded = cartOf([item({ final_line_price: 2700, line_level_discount_allocations: [code(300, "TEN")] })], { currency: "USD" });
    expect(ok(cartPricedLines(coded, [line()], "EUR"))).toMatchObject({ codeCents: {}, codesTakenOff: ["TEN"] });
  });

  it("subscriptions and gift cards stay Shopify's; an empty or unpriced cart can't be charged", () => {
    expect(cartPricedLines(cartOf([item({ selling_plan_allocation: { selling_plan: { id: 1 } } })]), [line()], "EUR")).toMatchObject({ ok: false, reason: "subscription" });
    expect(cartPricedLines(cartOf([item({ gift_card: true })]), [line()], "EUR")).toMatchObject({ ok: false, reason: "subscription" });
    expect(cartPricedLines(cartOf([]), [line()], "EUR")).toMatchObject({ ok: false, reason: "cart_changed" });
    expect(cartPricedLines(cartOf([item({ final_line_price: undefined, final_price: undefined })]), [line()], "EUR")).toMatchObject({ ok: false, reason: "cart_unreadable" });
  });

  it("the checkout's own breaks and gifts leave those lines out (their offer is the cart's)", () => {
    const r = ok(cartPricedLines(cartOf([item({ quantity: 3, final_line_price: 9000, original_line_price: 9000 })]), [line({ quantity: 3 })], "EUR"));
    expect(offerBaseLines(r.lines)).toEqual([]);
    const totals = computeTotals({ lines: r.lines, rate: null, discount: null, addOns: [], quantityBreaks: [{ minQty: 2, percent: 10 }] });
    expect(totals.volumeDiscountCents).toBe(0);
    expect(totals.totalCents).toBe(9000);
  });

  it("the Shopify order: lines at the cart's prices, the reason stated in the note", () => {
    const r = ok(cartPricedLines(cartOf([item({ final_price: 3900, final_line_price: 3900, original_line_price: 3900, price: 3900 })]), [line()], "EUR"));
    const order = buildOrderCreateInput({
      sessionId: "s1",
      currency: "EUR",
      email: "a@b.c",
      acceptsMarketing: false,
      cart: { cartPriced: { reason: "price_higher", discounted: false } },
      shippingAddress: null,
      lines: r.lines,
      addOns: [],
      shipping: null,
      discount: null,
      totalCents: 3900,
      whopPaymentId: "pay_1",
      provider: "whop",
      test: false,
    } as unknown as PaidOrderInput);
    expect((order.lineItems as { priceSet: { shopMoney: { amount: string } }; quantity: number }[]).map((l) => [l.quantity, l.priceSet.shopMoney.amount])).toEqual([[1, "39.00"]]);
    expect(String(order.note)).toContain("lignes au prix du panier Shopify");
  });
});

describe("bundleComponents: a Shopify Bundles parent's components from the Admin API", () => {
  it("per parent unit, weighted by their prices; a parent without components is left out", async () => {
    const { vi } = await import("vitest");
    const { bundleComponents } = await import("@/lib/shopify");
    const { encrypt } = await import("@/lib/crypto");
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: {
            nodes: [
              {
                __typename: "ProductVariant",
                id: V(30),
                productVariantComponents: {
                  nodes: [
                    { quantity: 1, productVariant: { id: V(31), title: "Default Title", price: "20.00", product: { title: "Bonnet", hasOnlyDefaultVariant: true } } },
                    { quantity: 2, productVariant: { id: V(32), title: "M", price: "10.00", product: { title: "Gants", hasOnlyDefaultVariant: false } } },
                  ],
                },
              },
              { __typename: "ProductVariant", id: V(40), productVariantComponents: { nodes: [] } },
              null,
            ],
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const found = await bundleComponents({ shopDomain: "b.myshopify.com", shopifyAccessToken: encrypt("tok") }, [V(30), "40", V(30)]);
      expect([...found.keys()]).toEqual([V(30)]);
      expect(found.get(V(30))).toEqual([
        { variantId: V(31), quantity: 1, weightCents: 2000, title: "Bonnet" },
        { variantId: V(32), quantity: 2, weightCents: 2000, title: "Gants — M" },
      ]);
      // One request, the parents deduplicated.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
      expect(body.variables.ids).toEqual([V(30), V(40)]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
