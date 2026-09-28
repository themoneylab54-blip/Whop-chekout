import { describe, expect, it } from "vitest";
import {
  cartCodeAllocations,
  cartMerchandiseCents,
  MAX_KNOWN_APP_VALUE,
  cartDiscountCodes,
  cartHeldByApp,
  isBundleHintKey,
  boundedCartSnapshot,
  carryCartExtras,
  detectCartApps,
  oversizedHiddenProperties,
  redactedCartSnapshot,
  componentsOf,
  hasBundleHint,
  reconcileCart,
  sanitizeCartContext,
  sanitizeProperties,
  splitOverComponents,
  withClientProperties,
  type CartJs,
} from "@/lib/cart-fidelity";
import { computeTotals, giftProgress, offerBaseLines, quantityBreakForLines, visibleProperties, type CartLine, type GiftTier, type QuantityBreak } from "@/lib/pricing";
import { allocateOrderDiscount, buildOrderCreateInput, type PaidOrderInput } from "@/lib/shopify";
import { automaticDiscountFor, automaticDiscountsOf, sameItems } from "@/lib/shopify-discounts";

/*
 * Bundle / upsell / personalization apps (Kaching Bundles, Fast Bundle, Bundler, Zepto,
 * EasyBundle, product options): /cart.js payloads in the shapes Shopify's AJAX Cart API documents,
 * reconciled with the Admin API's prices, down to the Shopify order input.
 */

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const line = (o: Partial<CartLine> = {}): CartLine => ({
  variantId: V(11),
  productId: "gid://shopify/Product/1",
  productHandle: "serum",
  title: "Sérum",
  variantTitle: null,
  sku: null,
  imageUrl: null,
  quantity: 1,
  unitPriceCents: 3000,
  compareAtCents: null,
  inventory: null,
  requiresShipping: true,
  ...o,
});
const item = (o: Record<string, unknown> = {}) => ({ variant_id: 11, quantity: 1, price: 3000, original_price: 3000, final_price: 3000, final_line_price: 3000, original_line_price: 3000, properties: {}, line_level_discount_allocations: [], ...o });

describe("oversized values", () => {
  it("a hidden value over 2000 characters is left out whole (never cut into invalid JSON)", () => {
    const big = JSON.stringify({ deal: "x", pad: "y".repeat(2100) });
    expect(sanitizeProperties({ _app_blob: big, _ok: "1", Gravure: "z".repeat(300) })).toEqual([
      { name: "_ok", value: "1" },
      { name: "Gravure", value: "z".repeat(255) },
    ]);
    expect(oversizedHiddenProperties({ _app_blob: big, _ok: "1" })).toEqual(["_app_blob"]);
    const exact = "a".repeat(2000);
    expect(sanitizeProperties({ _k: exact })).toEqual([{ name: "_k", value: exact }]);
  });

  it("a snapshot stays within its size cap, cart-level summary first", () => {
    const items = Array.from({ length: 50 }, (_, i) => item({ variant_id: i + 1, properties: { _app: "p".repeat(450), Gravure: "Léa" } }));
    const cart: CartJs = { currency: "EUR", total_price: 1000, items };
    expect(JSON.stringify(boundedCartSnapshot(cart, 1_000_000))).toBe(JSON.stringify(redactedCartSnapshot(cart)));
    for (const cap of [8000, 3000, 200]) {
      const snap = boundedCartSnapshot(cart, cap);
      expect(JSON.stringify(snap).length).toBeLessThanOrEqual(cap);
      expect(snap).toMatchObject({ currency: "EUR", truncated: { items: 50 } });
      expect(JSON.stringify(snap)).not.toMatch(/Léa/);
    }
  });
});

describe("line item properties", () => {
  it("keeps every key byte for byte (hidden ones too), stringifies values, drops null ones, caps count and length", () => {
    const props = sanitizeProperties({ Gravure: "Léa", _kaching_bundle_id: "kb_1", _qty: 3, _gift: true, Vide: "", Nul: null, Upload: "https://cdn.shopify.com/s/files/x/photo.png", Obj: { a: 1 } });
    expect(props).toEqual([
      { name: "Gravure", value: "Léa" },
      { name: "_kaching_bundle_id", value: "kb_1" },
      { name: "_qty", value: "3" },
      { name: "_gift", value: "true" },
      { name: "Vide", value: "" },
      { name: "Upload", value: "https://cdn.shopify.com/s/files/x/photo.png" },
      { name: "Obj", value: '{"a":1}' },
    ]);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "x".repeat(400)]));
    const capped = sanitizeProperties(many);
    expect(capped).toHaveLength(25);
    expect(capped[0].value).toHaveLength(255);
    // Kaching's JSON (two underscores) is kept whole, even past 255 characters.
    const kaching = JSON.stringify({ deal: "54Jy", main: true, id: "3FLa", bid: "0f83".repeat(80), ab: "B" });
    expect(sanitizeProperties({ __kaching_bundles: kaching, " Espace ": "x" })).toEqual([
      { name: "__kaching_bundles", value: kaching },
      { name: " Espace ", value: "x" },
    ]);
    expect(visibleProperties({ properties: props })).toEqual([
      { name: "Gravure", value: "Léa" },
      { name: "Upload", value: "https://cdn.shopify.com/s/files/x/photo.png" },
      { name: "Obj", value: '{"a":1}' },
    ]);
  });

  it("cart note and attributes", () => {
    expect(sanitizeCartContext("  Emballage cadeau svp ", { "Gift wrap": "Yes", Vide: "" })).toEqual({ note: "Emballage cadeau svp", attributes: [{ key: "Gift wrap", value: "Yes" }, { key: "Vide", value: "" }] });
    expect(sanitizeCartContext("", {})).toBeNull();
  });

  it("bundle hints on hidden keys only", () => {
    expect(hasBundleHint(sanitizeProperties({ _kaching_bundle_id: "1" }))).toBe(true);
    expect(hasBundleHint(sanitizeProperties({ _bundle: "fb_1" }))).toBe(true);
    expect(hasBundleHint(sanitizeProperties({ Bundle: "visible" }))).toBe(false);
    expect(hasBundleHint(sanitizeProperties({ Gravure: "Léa" }))).toBe(false);
  });
});

describe("reconcileCart", () => {
  it("personalization: properties carried, price untouched, quantity locked", () => {
    const r = reconcileCart({ currency: "EUR", note: "Merci", items: [item({ properties: { Gravure: "Léa", _upload_id: "u1" } })] }, [line()], "EUR");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines[0]).toMatchObject({ unitPriceCents: 3000, locked: true, properties: [{ name: "Gravure", value: "Léa" }, { name: "_upload_id", value: "u1" }] });
    expect(r.lines[0].appPrice).toBeUndefined();
    expect([r.adjustedCents, r.context]).toEqual([0, { note: "Merci" }]);
  });

  it("Kaching discount-function mode: the allocation is a discount (no app price), the price stays the variant's", () => {
    const cart: CartJs = {
      currency: "EUR",
      items: [
        item({
          quantity: 3,
          final_price: 2400,
          final_line_price: 7200,
          original_line_price: 9000,
          properties: { _kaching_bundle_id: "kb_42" },
          line_level_discount_allocations: [{ amount: 1800, discount_application: { type: "automatic", title: "Kaching -20%" } }],
        }),
      ],
    };
    const r = reconcileCart(cart, [line({ quantity: 3 })], "EUR");
    expect(r.ok && r.lines[0]).toMatchObject({ unitPriceCents: 3000, locked: true });
    expect(r.ok && r.lines[0].appPrice).toBeUndefined();
    // The automatic discount is what the quote applies (on those prices).
    expect(automaticDiscountsOf(cart, [{ variantId: V(11), quantity: 3, unitPriceCents: 3000 }])).toMatchObject({ totalCents: 1800, titles: ["Kaching -20%"] });
  });

  it("Cart Transform update with only a hidden key (anyone can add one): Shopify's checkout, never charged above the cart", () => {
    const cart: CartJs = {
      currency: "EUR",
      items: [item({ quantity: 2, price: 2500, final_price: 2500, final_line_price: 5000, original_line_price: 5000, properties: { _bundle: "fb_7", "Offre": "Duo" } })],
    };
    expect(reconcileCart(cart, [line({ quantity: 2 })], "EUR")).toMatchObject({ ok: false, reason: "price_unverified", detail: V(11) });
  });

  it("a lower price is kept only on bundle components Shopify expanded, never on an automatic allocation", () => {
    // Lower base price + Kaching's automatic discount on the same line: the allocation is added back,
    // what remains (25 € for a 30 € variant) has no verified sign → Shopify's checkout.
    const auto = reconcileCart(
      { currency: "EUR", items: [item({ quantity: 2, final_line_price: 4400, properties: { __kaching_bundles: "{}" }, line_level_discount_allocations: [{ amount: 600, discount_application: { type: "automatic", title: "Kaching" } }] })] },
      [line({ quantity: 2 })],
      "EUR",
    );
    expect(auto).toMatchObject({ ok: false, reason: "price_unverified" });
    // Probe: EUR variant at 100 €, cart at 90 € (Markets price list) with a sitewide 10 % automatic
    // discount (81 € + 9 € allocation): the 90 € base is unverified, never charged 100 € − 9 €.
    const probe = reconcileCart(
      { currency: "EUR", items: [item({ price: 9000, final_price: 8100, final_line_price: 8100, original_line_price: 9000, line_level_discount_allocations: [{ amount: 900, discount_application: { type: "automatic", title: "Soldes 10 %" } }] })] },
      [line({ unitPriceCents: 10000 })],
      "EUR",
    );
    expect(probe).toMatchObject({ ok: false, reason: "price_unverified", detail: V(11) });
    // Bundle components (Cart Transform expand): Shopify's own figures, kept.
    const comps = reconcileCart(
      { currency: "EUR", items: [item({ final_line_price: 2500, item_components: [{ variant_id: 51, quantity: 1, final_line_price: 2500 }] })] },
      [line()],
      "EUR",
    );
    expect(comps.ok && comps.lines[0]).toMatchObject({ unitPriceCents: 2500, appPrice: { unitCents: 2500, originalUnitCents: 3000 } });
    // A discount code's allocation isn't one (the buyer's, and the checkout doesn't carry the cart's codes as such).
    const code = reconcileCart(
      { currency: "EUR", items: [item({ final_line_price: 2000, properties: { _bundle: "x" }, line_level_discount_allocations: [{ amount: 500, discount_application: { type: "discount_code", title: "X" } }] })] },
      [line()],
      "EUR",
    );
    expect(code).toMatchObject({ ok: false, reason: "price_unverified" });
  });

  it("app price and an automatic discount on the same line: only the price change is an app price", () => {
    const cart: CartJs = {
      currency: "EUR",
      items: [
        item({
          quantity: 1,
          final_line_price: 2200,
          properties: { _bundle: "fb_7" },
          item_components: [{ variant_id: 51, quantity: 1, final_line_price: 2500 }],
          line_level_discount_allocations: [{ amount: 300, discount_application: { type: "automatic", title: "Soldes" } }],
        }),
      ],
    };
    const r = reconcileCart(cart, [line()], "EUR");
    expect(r.ok && r.lines[0].unitPriceCents).toBe(2500);
    if (!r.ok) return;
    expect(automaticDiscountsOf(cart, [{ variantId: V(11), quantity: 1, unitPriceCents: r.lines[0].unitPriceCents }])?.totalCents).toBe(300);
  });

  it("price higher in the cart than the variant's (plain line, same currency): refused, the markup isn't lost", () => {
    expect(reconcileCart({ currency: "EUR", items: [item({ final_line_price: 3500 })] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "price_higher", detail: V(11) });
    expect(reconcileCart({ currency: "EUR", items: [item({ quantity: 2, final_line_price: 6200 })] }, [line({ quantity: 2 })], "EUR")).toMatchObject({ ok: false, reason: "price_higher" });
    // Another currency (Markets): amounts not comparable, a plain line keeps the shop's price.
    expect(reconcileCart({ currency: "CHF", items: [item({ final_line_price: 3500 })] }, [line()], "EUR")).toMatchObject({ ok: true });
    // Same price: fine.
    expect(reconcileCart({ currency: "EUR", items: [item()] }, [line()], "EUR")).toMatchObject({ ok: true, adjustedCents: 0 });
  });

  it("refuses what it can't represent", () => {
    // Higher cart price (an app's surcharge) on a line with properties.
    expect(reconcileCart({ currency: "EUR", items: [item({ final_line_price: 3500, properties: { Gravure: "Léa" } })] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "price_higher" });
    // App price that doesn't divide by the quantity.
    const autoAlloc = [{ amount: 300, discount_application: { type: "automatic" } }];
    const parts = [{ variant_id: 51, quantity: 3, final_line_price: 7700 }];
    expect(reconcileCart({ currency: "EUR", items: [item({ quantity: 3, final_line_price: 7700, properties: { _bundle: "x" }, item_components: parts, line_level_discount_allocations: autoAlloc })] }, [line({ quantity: 3 })], "EUR")).toMatchObject({
      ok: false,
      reason: "price_not_divisible",
    });
    // A bundle parent (components) split over two lines.
    const comps = [{ variant_id: 51, quantity: 1, final_line_price: 3000 }];
    expect(reconcileCart({ currency: "EUR", items: [item({ item_components: comps }), item({ item_components: comps, properties: { a: "1" } })] }, [line({ quantity: 2 })], "EUR")).toMatchObject({
      ok: false,
      reason: "split_lines",
    });
    // Bundle in another currency (Markets): prices can't be compared.
    expect(reconcileCart({ currency: "CHF", items: [item({ properties: { _kaching_bundle_id: "1" } })] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "currency_mismatch" });
    // Bundle parent the Admin API didn't price.
    expect(reconcileCart({ currency: "EUR", items: [item({ variant_id: 99, properties: { _bundle: "x" } })] }, [], "EUR")).toMatchObject({ ok: false, reason: "unknown_line" });
    // The cart changed since the storefront sent it (and it holds an app's line, or a markup).
    expect(reconcileCart({ currency: "EUR", items: [item({ quantity: 2, final_line_price: 5000, properties: { _bundle: "x" } })] }, [line({ quantity: 1 })], "EUR")).toMatchObject({ ok: false, reason: "cart_changed" });
    expect(reconcileCart({ currency: "EUR", items: [item({ quantity: 2, final_line_price: 7000 })] }, [line({ quantity: 1 })], "EUR")).toMatchObject({ ok: false, reason: "cart_changed" });
    expect(reconcileCart({ currency: "EUR", items: [item({ quantity: 2, final_line_price: 5000 })] }, [line({ quantity: 1 })], "EUR")).toMatchObject({ ok: false, reason: "cart_changed" });
    // A plain changed cart at the variants' prices: the checkout's lines, as before.
    expect(reconcileCart({ currency: "EUR", items: [item({ quantity: 2, final_line_price: 6000 })] }, [line({ quantity: 1 })], "EUR")).toMatchObject({ ok: true, matches: false });
  });

  it("plain lines keep today's behavior (other currency, identical duplicate lines merged)", () => {
    const r = reconcileCart({ currency: "CHF", items: [item({ final_line_price: 2800, properties: { Gravure: "Léa" } })] }, [line()], "EUR");
    expect(r.ok && r.lines[0]).toMatchObject({ unitPriceCents: 3000, properties: [{ name: "Gravure", value: "Léa" }] });
    const merged = reconcileCart({ currency: "EUR", items: [item(), item()] }, [line({ quantity: 2 })], "EUR");
    expect(merged.ok && merged.lines[0].unitPriceCents).toBe(3000);
    expect(merged.ok && merged.lines[0].locked).toBeUndefined();
  });

  it("expanded bundle with priced components: ordered as components; unpriced or quantity > 1 refused", () => {
    const withComponents = item({
      variant_id: 50,
      final_line_price: 4000,
      price: 4000,
      item_components: [
        { variant_id: 51, quantity: 1, final_line_price: 3000, title: "Sérum" },
        { variant_id: 52, quantity: 2, final_line_price: 2000, title: "Crème" },
      ],
    });
    const parent = line({ variantId: V(50), title: "Coffret", unitPriceCents: 4500 });
    const r = reconcileCart({ currency: "EUR", items: [withComponents] }, [parent], "EUR");
    expect(r.ok && r.lines[0]).toMatchObject({
      unitPriceCents: 4000,
      locked: true,
      components: [
        { variantId: V(51), quantity: 1, weightCents: 3000 },
        { variantId: V(52), quantity: 2, weightCents: 2000 },
      ],
    });
    expect(componentsOf({ components: [{ variant_id: 51, quantity: 1 }] })).toBe("invalid");
    expect(reconcileCart({ currency: "EUR", items: [{ ...withComponents, item_components: [{ variant_id: 51, quantity: 1 }] }] }, [parent], "EUR")).toMatchObject({ ok: false, reason: "bundle_components_unpriced" });
    expect(reconcileCart({ currency: "EUR", items: [{ ...withComponents, quantity: 2, final_line_price: 8000 }] }, [{ ...parent, quantity: 2 }], "EUR")).toMatchObject({ ok: false, reason: "bundle_quantity" });
  });
});

describe("research-driven rules (Cart Transform, app gifts, app quantities, safety net)", () => {
  it("has_components without components (AJAX cart): refused, the parent variant is never ordered", () => {
    expect(reconcileCart({ currency: "EUR", items: [item({ has_components: true })] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "bundle_components_unresolved" });
    expect(reconcileCart({ currency: "EUR", items: [item({ has_components: false })] }, [line()], "EUR")).toMatchObject({ ok: true });
  });

  it("Kaching / BOGOS gift lines: free through a discount allocation is fine, not free is refused", () => {
    const gift = { __kaching_bundles: JSON.stringify({ id: "3FLa", deal: "54Jy", gift: "MLo3" }) };
    const free = item({ properties: gift, final_line_price: 0, line_level_discount_allocations: [{ amount: 3000, discount_application: { type: "automatic", title: "Cadeau" } }] });
    const r = reconcileCart({ currency: "EUR", items: [free] }, [line()], "EUR");
    expect(r.ok && r.lines[0]).toMatchObject({ unitPriceCents: 3000, locked: true });
    expect(reconcileCart({ currency: "EUR", items: [item({ properties: gift })] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "gift_not_discounted" });
    expect(reconcileCart({ currency: "EUR", items: [item({ properties: { _bogos_trigger_type: "gift", _bogos_trigger_id: "1" } })] }, [line()], "EUR")).toMatchObject({
      ok: false,
      reason: "gift_not_discounted",
    });
  });

  it("app-set quantities are locked (Zepto fee product, BOGOS cloned gift)", () => {
    const zepto = reconcileCart({ currency: "EUR", items: [item({ quantity: 500, price: 1, final_line_price: 500, product_type: "PPLR_HIDDEN_PRODUCT" })] }, [line({ quantity: 500, unitPriceCents: 1 })], "EUR");
    expect(zepto.ok && zepto.lines[0].locked).toBe(true);
    const clone = reconcileCart({ currency: "EUR", items: [item({ final_line_price: 0, price: 0, handle: "bougie-sca_clone_freegift" })] }, [line({ unitPriceCents: 0 })], "EUR");
    expect(clone.ok && clone.lines[0]).toMatchObject({ unitPriceCents: 0, locked: true });
  });

  it("cart merchandise total leaves discount codes out", () => {
    expect(
      cartMerchandiseCents({
        total_price: 4000,
        items: [item({ line_level_discount_allocations: [{ amount: 500, discount_application: { type: "discount_code", title: "BIENVENUE" } }, { amount: 300, discount_application: { type: "automatic" } }] })],
        cart_level_discount_applications: [{ type: "discount_code", total_allocated_amount: 200 }],
      }),
    ).toBe(4700);
    expect(cartMerchandiseCents({ items: [] })).toBeNull();
  });

  it("detects known apps and unknown hidden keys; the snapshot drops the token and what the buyer typed", () => {
    const cart: CartJs = {
      token: "secret-token?key=abc",
      currency: "EUR",
      total_price: 3000,
      note: "Mon adresse perso",
      attributes: { __bogos_tracking: "12-34", "Date de livraison": "demain" },
      items: [
        item({ properties: { __kaching_bundles: "{}", Gravure: "Léa", _rapi_x: "1" }, has_components: false }),
        item({ variant_id: 12, properties: { __upcartUpsell: "true" }, line_level_discount_allocations: [{ amount: 100, discount_application: { type: "automatic", title: "Deal" } }] }),
        item({ variant_id: 13, has_components: true, product_type: "PPLR_HIDDEN_PRODUCT" }),
      ],
    };
    expect(detectCartApps(cart)).toEqual({ apps: ["automatic_discount", "bogos", "cart_transform", "kaching", "upcart", "zepto"], unknownKeys: ["_rapi_x"] });
    const snap = redactedCartSnapshot(cart);
    expect(JSON.stringify(snap)).not.toContain("secret-token");
    expect(JSON.stringify(snap)).not.toContain("Léa");
    expect(JSON.stringify(snap)).not.toContain("Mon adresse");
    expect(snap).toMatchObject({ note: "[17 car.]", attributes: { __bogos_tracking: "12-34", "Date de livraison": "[6 car.]" } });
    expect((snap.items as { properties: Record<string, string> }[])[0].properties).toEqual({ __kaching_bundles: "{}", Gravure: "[3 car.]", _rapi_x: "1" });
  });
});

describe("re-review fixes (subscriptions, price lists, stacked offers, gifts paid by a code)", () => {
  it("subscription (selling plan) and gift card lines go to Shopify's checkout, whatever the browser sent", () => {
    // A "subscribe -20%" line: its lower price is the selling plan's, never a one-time purchase's.
    const sub = item({ final_price: 2400, final_line_price: 2400, selling_plan_allocation: { selling_plan: { id: 7, name: "Tous les mois" }, price: 2400 } });
    expect(reconcileCart({ currency: "EUR", items: [sub] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "subscription", detail: V(11) });
    // Even with an app's key on the line, or the line absent from the checkout's lines.
    expect(reconcileCart({ currency: "EUR", items: [{ ...sub, properties: { _bundle: "x" } }] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "subscription" });
    expect(reconcileCart({ currency: "EUR", items: [item(), { ...sub, variant_id: 12 }] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "subscription", detail: V(12) });
    expect(reconcileCart({ currency: "EUR", items: [item({ gift_card: true })] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "subscription" });
    // No selling plan: a plain line.
    expect(reconcileCart({ currency: "EUR", items: [item({ selling_plan_allocation: null, gift_card: false })] }, [line()], "EUR")).toMatchObject({ ok: true });
  });

  it("a lower cart price without a verified sign (Markets / B2B price list, tax-inclusive, hidden key alone) goes to Shopify's checkout: never kept, never charged above the cart", () => {
    expect(reconcileCart({ currency: "EUR", items: [item({ final_price: 2550, final_line_price: 2550 })] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "price_unverified", detail: V(11) });
    // A visible (buyer) property isn't an app's sign either.
    expect(reconcileCart({ currency: "EUR", items: [item({ final_line_price: 2550, properties: { Gravure: "Léa" } })] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "price_unverified" });
    // Nor a hidden key alone: the buyer can set one.
    expect(reconcileCart({ currency: "EUR", items: [item({ final_line_price: 1000, properties: { _kaching_bundle_id: "forged" } })] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "price_unverified" });
    // An automatic discount (Kaching discount function, Shopify sale) on a plain line is an allocation, not a price: fine.
    const auto = reconcileCart({ currency: "EUR", items: [item({ final_line_price: 2400, line_level_discount_allocations: [{ amount: 600, discount_application: { type: "automatic" } }] })] }, [line()], "EUR");
    expect(auto.ok && auto.lines[0].unitPriceCents).toBe(3000);
    expect(auto.ok && auto.lines[0].appPrice).toBeUndefined();
    // Bundle components are an app's sign.
    const bundle = item({ final_line_price: 2500, item_components: [{ variant_id: 51, quantity: 1, final_line_price: 2500 }] });
    expect(reconcileCart({ currency: "EUR", items: [bundle] }, [line()], "EUR")).toMatchObject({ ok: true, adjustedCents: 500 });
  });

  it("an app's gift made free only by a discount code (not carried by the checkout) is refused", () => {
    const gift = { __kaching_bundles: JSON.stringify({ id: "3FLa", gift: "MLo3" }) };
    const byCode = item({ properties: gift, final_line_price: 0, line_level_discount_allocations: [{ amount: 3000, discount_application: { type: "discount_code", title: "CADEAU" } }] });
    expect(reconcileCart({ currency: "EUR", items: [byCode] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "gift_not_discounted" });
    const byFunction = item({ properties: gift, final_line_price: 0, line_level_discount_allocations: [{ amount: 3000, discount_application: { type: "automatic", title: "Cadeau" } }] });
    const r = reconcileCart({ currency: "EUR", items: [byFunction] }, [line()], "EUR");
    expect(r.ok && r.lines[0]).toMatchObject({ appGift: true, locked: true });
    // The gift mark survives a re-pricing.
    expect(r.ok && carryCartExtras(r.lines, [line()])[0].appGift).toBe(true);
  });

  it("the checkout's quantity breaks and gifts leave out lines an app already priced (no double discount)", () => {
    const tiers: QuantityBreak[] = [{ minQty: 3, percent: 10 }];
    const bundle = line({ quantity: 3, unitPriceCents: 2500, compareAtCents: 3000, appPrice: { unitCents: 2500, originalUnitCents: 3000 }, locked: true });
    const appGift = line({ variantId: V(14), quantity: 1, appGift: true, locked: true });
    const plain = line({ variantId: V(12), unitPriceCents: 1000 });
    // Kaching bundle of 3 at its bundle price: the "3 bought = -10%" tier isn't reached by it.
    const onlyBundle = computeTotals({ lines: [bundle, appGift, plain], rate: null, discount: null, addOns: [], quantityBreaks: tiers });
    expect([onlyBundle.subtotalCents, onlyBundle.volumeDiscountCents]).toEqual([7500 + 3000 + 1000, 0]);
    expect(quantityBreakForLines(tiers, offerBaseLines([bundle, appGift, plain])).current).toBeNull();
    // Three plain items reach it, discounted on their own value only.
    const three = computeTotals({ lines: [bundle, appGift, { ...plain, quantity: 3 }], rate: null, discount: null, addOns: [], quantityBreaks: tiers });
    expect(three.volumeDiscountCents).toBe(300);
    // Checkout gifts: counted on the same base.
    const gifts: GiftTier[] = [{ type: "gift", minQty: 3, variantId: V(99), title: "Pochette" }];
    expect(giftProgress(gifts, offerBaseLines([bundle, appGift, plain])).earned).toEqual([]);
    expect(giftProgress(gifts, offerBaseLines([bundle, { ...plain, quantity: 3 }])).earned).toHaveLength(1);
  });
});

describe("without a readable cart (buy now)", () => {
  it("keeps the form's properties, refuses a bundle app's line and split lines", () => {
    const ok = withClientProperties([line()], [{ variant_id: 11, properties: { Prénom: "Léa" } }]);
    expect(ok.ok && ok.lines[0]).toMatchObject({ properties: [{ name: "Prénom", value: "Léa" }], locked: true });
    expect(withClientProperties([line()], [{ variant_id: 11, properties: { _kaching_bundle_id: "1" } }])).toMatchObject({ ok: false, reason: "bundle_without_cart" });
    expect(withClientProperties([line({ quantity: 2 })], [{ variant_id: 11, properties: { a: "1" } }, { variant_id: 11, properties: { a: "2" } }])).toMatchObject({ ok: false, reason: "split_lines" });
  });
});

describe("re-pricing keeps the cart's extras", () => {
  it("app price stays a ceiling, never above the variant's current price", () => {
    const prev = [line({ unitPriceCents: 2500, compareAtCents: 3000, appPrice: { unitCents: 2500, originalUnitCents: 3000 }, locked: true, properties: [{ name: "_bundle", value: "x" }] }), line({ variantId: V(12) })];
    const same = carryCartExtras(prev, [line(), line({ variantId: V(12) })]);
    expect(same[0]).toMatchObject({ unitPriceCents: 2500, locked: true, properties: [{ name: "_bundle", value: "x" }], appPrice: { unitCents: 2500 } });
    // The variant got cheaper than the bundle price: the lower price wins, no app price left.
    const cheaper = carryCartExtras(prev, [line({ unitPriceCents: 2000 }), line({ variantId: V(12) })]);
    expect([cheaper[0].unitPriceCents, cheaper[0].appPrice]).toEqual([2000, undefined]);
  });

  it("price tampering: an app price doesn't survive removing or changing the lines it depended on", () => {
    const prev = [line({ unitPriceCents: 2500, compareAtCents: 3000, appPrice: { unitCents: 2500, originalUnitCents: 3000 }, locked: true }), line({ variantId: V(12) })];
    // Buyer sets the unlocked line B to 0 (removed): A goes back to the variant's price.
    const removed = carryCartExtras(prev, [line()]);
    expect([removed[0].unitPriceCents, removed[0].appPrice, removed[0].locked]).toEqual([3000, undefined, true]);
    // B's quantity changed, or a product added: same.
    expect(carryCartExtras(prev, [line(), line({ variantId: V(12), quantity: 3 })])[0].unitPriceCents).toBe(3000);
    expect(carryCartExtras(prev, [line(), line({ variantId: V(12) }), line({ variantId: V(13) })])[0].appPrice).toBeUndefined();
  });
});

describe("Shopify order input", () => {
  const base: PaidOrderInput = {
    sessionId: "s1",
    currency: "EUR",
    email: "a@b.fr",
    acceptsMarketing: false,
    shippingAddress: null,
    lines: [],
    addOns: [],
    discount: null,
    shipping: null,
    totalCents: 0,
    whopPaymentId: "pay_1",
    test: false,
  };

  it("line-specific automatic discount goes to its own line first, the rest spread by value; sums to what was charged", () => {
    const lines = [line({ variantId: V(11), quantity: 2, unitPriceCents: 3000 }), line({ variantId: V(12), quantity: 1, unitPriceCents: 4000 })];
    // Kaching deal of 1800 on line A only, plus a 1000 code folded in: 2800 in all.
    const alloc = allocateOrderDiscount(lines, 2800, { cents: 1800, lineCents: { [V(11)]: 1800 } });
    // Rest (1000) spread over what's left: A 4200, B 4000.
    expect(alloc).toEqual([1800 + 512, 488]);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(2800);
    // Proportional only (old behavior) would have put 1600 on A and 1200 on B.
    const order = buildOrderCreateInput({
      ...base,
      lines,
      discount: { code: "REMISE", amountCents: 2800, freeShipping: false },
      automaticDiscount: { cents: 1800, lineCents: { [V(11)]: 1800 } },
      totalCents: 10000 - 2800,
    });
    const items = order.lineItems as { variantId: string; quantity: number; priceSet: { shopMoney: { amount: string } } }[];
    const cents = (v: string) => items.filter((i) => i.variantId === v).reduce((s, i) => s + Math.round(Number(i.priceSet.shopMoney.amount) * 100) * i.quantity, 0);
    expect([cents(V(11)), cents(V(12))]).toEqual([6000 - 2312, 4000 - 488]);
    expect(cents(V(11)) + cents(V(12))).toBe(7200);
  });

  it("per-line automatic parts are capped at the line and at the folded total, and always sum exactly", () => {
    const lines = [line({ variantId: V(11), unitPriceCents: 1000 }), line({ variantId: V(12), unitPriceCents: 999, quantity: 3 }), line({ variantId: V(13), unitPriceCents: 0, gift: true })];
    for (const [folded, auto, lineCents] of [
      [500, 500, { [V(12)]: 500 }],
      [1500, 1500, { [V(11)]: 1400 }], // more than line A: 1000 on A, the rest spread
      [700, 900, { [V(11)]: 900 }], // folded total below the automatic figure: capped
      [3001, 0, {}],
      [1234, 1234, { [V(99)]: 1234 }], // unknown line: all spread
    ] as [number, number, Record<string, number>][]) {
      const alloc = allocateOrderDiscount(lines, folded, { cents: auto, lineCents });
      expect(alloc.reduce((a, b) => a + b, 0)).toBe(folded);
      alloc.forEach((a, i) => expect(a).toBeLessThanOrEqual(lines[i].unitPriceCents * lines[i].quantity));
      expect(alloc.every((a) => a >= 0)).toBe(true);
    }
    expect(allocateOrderDiscount(lines, 1500, { cents: 1500, lineCents: { [V(11)]: 1400 } })[0]).toBe(1000);
  });

  it("line properties, cart attributes and note, app price stated; idempotency tags unchanged", () => {
    const order = buildOrderCreateInput({
      ...base,
      buyerNote: "Sonner 2 fois",
      cart: { note: "Emballage cadeau", attributes: [{ key: "Gift wrap", value: "Yes" }] },
      lines: [line({ quantity: 2, unitPriceCents: 2500, appPrice: { unitCents: 2500, originalUnitCents: 3000 }, properties: [{ name: "Gravure", value: "Léa" }, { name: "_kaching_bundle_id", value: "kb" }] })],
      totalCents: 5000,
    });
    expect(order.lineItems).toEqual([
      {
        variantId: V(11),
        sku: undefined,
        requiresShipping: true,
        properties: [{ name: "Gravure", value: "Léa" }, { name: "_kaching_bundle_id", value: "kb" }],
        quantity: 2,
        priceSet: { shopMoney: { amount: "25.00", currencyCode: "EUR" } },
      },
    ]);
    expect(order.customAttributes).toEqual([{ key: "Gift wrap", value: "Yes" }]);
    expect(order.note).toMatch(/^Note du client : Sonner 2 fois\n\nNote du panier : Emballage cadeau\n\nPayé via Whop/);
    expect(order.note).toContain("prix de lot fixés par une app du panier Shopify (−10.00 EUR");
    expect(order.tags).toEqual(["whop-checkout", "wc-s1", "wp-pay_1"]);
    expect(order.sourceIdentifier).toBe("s1");
  });

  it("bundle components share the line's paid amount exactly (discount folded in)", () => {
    const order = buildOrderCreateInput({
      ...base,
      lines: [
        line({
          variantId: V(50),
          title: "Coffret",
          unitPriceCents: 4000,
          components: [
            { variantId: V(51), quantity: 1, weightCents: 3000 },
            { variantId: V(52), quantity: 2, weightCents: 2000 },
          ],
          properties: [{ name: "_bundle", value: "b1" }],
        }),
      ],
      discount: { code: "MOINS10", amountCents: 401, freeShipping: false },
      totalCents: 3599,
    });
    const items = order.lineItems as { variantId: string; quantity: number; priceSet: { shopMoney: { amount: string } }; properties: unknown }[];
    const total = items.reduce((s, i) => s + Math.round(Number(i.priceSet.shopMoney.amount) * 100) * i.quantity, 0);
    expect(total).toBe(3599);
    // 3599 over weights 3000 / 2000: 2159 and 1440 (2 × 7.20); the parent itself isn't ordered.
    expect(items.map((i) => [i.variantId, i.quantity, i.priceSet.shopMoney.amount])).toEqual([
      [V(51), 1, "21.59"],
      [V(52), 2, "7.20"],
    ]);
    expect(items[0].properties).toEqual([{ name: "Lot", value: "Coffret" }, { name: "_bundle", value: "b1" }]);
  });

  it("splitOverComponents adds up exactly", () => {
    expect(splitOverComponents(1000, [{ variantId: "a", quantity: 1, weightCents: 1 }, { variantId: "b", quantity: 1, weightCents: 1 }, { variantId: "c", quantity: 1, weightCents: 1 }])).toEqual([334, 333, 333]);
    expect(splitOverComponents(7, [{ variantId: "a", quantity: 1, weightCents: 0 }, { variantId: "b", quantity: 1, weightCents: 0 }])).toEqual([4, 3]);
  });
});

describe("3rd review policy (verified signs, split lines, freeze, cart codes)", () => {
  const auto = (amount: number, title = "Kaching") => [{ amount, discount_application: { type: "automatic", title } }];

  it("C: bundle hints are whole words of hidden keys (known app keys kept)", () => {
    for (const k of ["_kaching_bundle_id", "__kaching_bundles", "_bundle", "_bundle_id", "_sb_parent", "_fbb_id", "__upcartUpsell", "_bogos_trigger_type", "__freegift_attributes", "_free_gift", "_pplr_preview", "_deal", "_offer_id", "_mix-match", "_BundleId", "_bxgy"]) {
      expect([k, isBundleHintKey(k)]).toEqual([k, true]);
    }
    for (const k of ["_dealer_id", "_packaging", "_offerings", "_mixer", "_fbclid", "_combos_x2", "Bundle", "deal", "_gift_note"]) {
      expect([k, isBundleHintKey(k)]).toEqual([k, false]);
    }
    expect(hasBundleHint(sanitizeProperties({ _dealer_id: "7", _packaging: "kraft" }))).toBe(false);
    // Such a line is plain: it doesn't fix the cart.
    const r = reconcileCart({ currency: "EUR", items: [item({ properties: { _packaging: "kraft" } })] }, [line()], "EUR");
    expect(r.ok && [r.lines[0].unitPriceCents, cartHeldByApp(r.lines)]).toEqual([3000, false]);
  });

  it("A: same variant on two plain lines with different engravings: two checkout lines, each with its properties", () => {
    const r = reconcileCart(
      { currency: "EUR", items: [item({ quantity: 2, final_line_price: 6000, properties: { Gravure: "Léa" } }), item({ properties: { Gravure: "Tom" } })] },
      [line({ quantity: 3 })],
      "EUR",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => [l.variantId, l.quantity, l.unitPriceCents, l.properties, l.locked])).toEqual([
      [V(11), 2, 3000, [{ name: "Gravure", value: "Léa" }], true],
      [V(11), 1, 3000, [{ name: "Gravure", value: "Tom" }], true],
    ]);
    // One variant on several lines: the cart is fixed as a whole (a re-pricing would merge them).
    expect(cartHeldByApp(r.lines)).toBe(true);
    // The cart's figures still describe the checkout (quantities summed per variant).
    expect(sameItems([{ variantId: V(11), quantity: 3 }], r.lines)).toBe(true);
  });

  it("I: Kaching BXGY on one variant (paid line + free line, automatic allocation on the gift): two order lines", () => {
    const paid = item({ properties: { __kaching_bundles: JSON.stringify({ deal: "d1", main: true }) } });
    const free = item({ final_line_price: 0, properties: { __kaching_bundles: JSON.stringify({ deal: "d1", bxgy: true }) }, line_level_discount_allocations: auto(3000, "Kaching BXGY") });
    const cart: CartJs = { currency: "EUR", total_price: 3000, items: [paid, free] };
    const r = reconcileCart(cart, [line({ quantity: 2 })], "EUR");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines.map((l) => [l.quantity, l.unitPriceCents, !!l.appGift, !!l.locked])).toEqual([
      [1, 3000, false, true],
      [1, 3000, true, true],
    ]);
    const priced = r.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceCents: l.unitPriceCents }));
    const found = automaticDiscountsOf(cart, priced);
    expect(found).toMatchObject({ totalCents: 3000 });
    expect(automaticDiscountFor(found, r.lines, "EUR").cents).toBe(3000);
    // The gift's discount lands on the gift line of the order.
    expect(allocateOrderDiscount(r.lines, 3000, { cents: 3000, lineCents: { [V(11)]: 3000 } })).toEqual([0, 3000]);
    // A free line only a discount code makes free is still refused.
    const byCode = { ...free, line_level_discount_allocations: [{ amount: 3000, discount_application: { type: "discount_code", title: "X" } }] };
    expect(reconcileCart({ currency: "EUR", items: [paid, byCode] }, [line({ quantity: 2 })], "EUR")).toMatchObject({ ok: false, reason: "gift_not_discounted" });
  });

  it("B: a gift priced free by a Cart Transform without a verified sign: refused", () => {
    const gift = item({ price: 0, final_price: 0, final_line_price: 0, properties: { __kaching_bundles: JSON.stringify({ gift: "g1" }) } });
    expect(reconcileCart({ currency: "EUR", items: [gift] }, [line()], "EUR")).toMatchObject({ ok: false, reason: "price_unverified" });
  });

  it("E: Kaching discount-function lines are marked appDiscounted and stay out of the checkout's breaks and gifts", () => {
    const r = reconcileCart(
      { currency: "EUR", items: [item({ quantity: 3, final_line_price: 7200, properties: { _kaching_bundle_id: "kb" }, line_level_discount_allocations: auto(1800) }), item({ variant_id: 12, properties: {} })] },
      [line({ quantity: 3 }), line({ variantId: V(12) })],
      "EUR",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.lines[0]).toMatchObject({ unitPriceCents: 3000, appDiscounted: true, locked: true });
    expect(r.lines[0].appPrice).toBeUndefined();
    expect(r.lines[1].appDiscounted).toBeUndefined();
    expect(offerBaseLines(r.lines).map((l) => l.variantId)).toEqual([V(12)]);
    expect(quantityBreakForLines([{ minQty: 3, percent: 10 }], offerBaseLines(r.lines)).current).toBeNull();
    // A plain line with a sitewide automatic discount isn't an app's offer.
    const plain = reconcileCart({ currency: "EUR", items: [item({ final_line_price: 2700, line_level_discount_allocations: auto(300, "Soldes") })] }, [line()], "EUR");
    expect(plain.ok && [plain.lines[0].appDiscounted, plain.lines[0].locked]).toEqual([undefined, undefined]);
    // The mark survives a re-pricing.
    expect(carryCartExtras(r.lines, [line({ quantity: 3 }), line({ variantId: V(12) })])[0].appDiscounted).toBe(true);
  });

  it("D: only an app's lines fix the cart, not a plain sitewide automatic discount", () => {
    expect(cartHeldByApp([line(), line({ variantId: V(12) })])).toBe(false);
    expect(cartHeldByApp([line({ properties: [{ name: "Gravure", value: "Léa" }] })])).toBe(false);
    expect(cartHeldByApp([line({ appPrice: { unitCents: 2500, originalUnitCents: 3000 } })])).toBe(true);
    expect(cartHeldByApp([line({ appGift: true })])).toBe(true);
    expect(cartHeldByApp([line({ appDiscounted: true })])).toBe(true);
    expect(cartHeldByApp([line({ components: [{ variantId: V(51), quantity: 1, weightCents: 1 }] })])).toBe(true);
    expect(cartHeldByApp([line({ properties: [{ name: "_bundle", value: "x" }] })])).toBe(true);
    // A checkout gift line of the same variant doesn't count as a split.
    expect(cartHeldByApp([line(), line({ gift: true, unitPriceCents: 0 })])).toBe(false);
  });

  it("H: the cart's discount codes (discount_codes, code allocations), applicable ones, deduplicated", () => {
    expect(
      cartDiscountCodes({
        discount_codes: [{ code: "FASTBUNDLE10", applicable: true }, { code: "OLD", applicable: false }],
        items: [item({ line_level_discount_allocations: [{ amount: 100, discount_application: { type: "discount_code", title: "fastbundle10" } }, { amount: 50, discount_application: { type: "automatic", title: "Soldes" } }] })],
        cart_level_discount_applications: [{ type: "discount_code", title: "BIENVENUE" }],
      }),
    ).toEqual(["FASTBUNDLE10", "BIENVENUE"]);
    expect(cartDiscountCodes({ items: [] })).toEqual([]);
  });
});

describe("round 5 review", () => {
  it("1: the codes that lowered the cart, with their amounts (line allocations + cart-level), largest first", () => {
    expect(
      cartCodeAllocations({
        discount_codes: [{ code: "FREESHIP", applicable: true }],
        items: [
          item({ line_level_discount_allocations: [{ amount: 300, discount_application: { type: "discount_code", title: "bienvenue" } }, { amount: 200, discount_application: { type: "automatic", title: "Soldes" } }] }),
          item({ variant_id: 12, line_level_discount_allocations: [{ amount: 100, discount_application: { type: "discount_code", title: "BIENVENUE" } }] }),
        ],
        cart_level_discount_applications: [{ type: "discount_code", title: "VIP", total_allocated_amount: 500 }, { type: "automatic", title: "x", total_allocated_amount: 900 }],
      }),
    ).toEqual([
      { code: "VIP", cents: 500 },
      { code: "bienvenue", cents: 400 },
    ]);
    // An applicable code that took nothing off (free shipping): nothing to reproduce on the merchandise.
    expect(cartCodeAllocations({ discount_codes: [{ code: "FREESHIP", applicable: true }], items: [item()] })).toEqual([]);
  });

  it("5: an automatic allocation on a line with any hidden key (unknown app) is an app's offer: frozen, out of the checkout's breaks", () => {
    const r = reconcileCart(
      { currency: "EUR", items: [item({ final_line_price: 2700, properties: { _xyz_ref: "a1" }, line_level_discount_allocations: [{ amount: 300, discount_application: { type: "automatic", title: "Offre" } }] })] },
      [line()],
      "EUR",
    );
    expect(r.ok && r.lines[0]).toMatchObject({ appDiscounted: true, locked: true, unitPriceCents: 3000 });
    if (!r.ok) return;
    expect(cartHeldByApp(r.lines)).toBe(true);
    expect(offerBaseLines(r.lines)).toEqual([]);
    // A visible property alone (engraving) with a sitewide automatic discount: not an app's offer.
    const plain = reconcileCart(
      { currency: "EUR", items: [item({ final_line_price: 2700, properties: { Gravure: "Léa" }, line_level_discount_allocations: [{ amount: 300, discount_application: { type: "automatic", title: "Soldes" } }] })] },
      [line()],
      "EUR",
    );
    expect(plain.ok && plain.lines[0].appDiscounted).toBeUndefined();
  });

  it("6: a known app's attribution key is kept verbatim up to 16 KB; other hidden keys keep the 2000 rule", () => {
    const kaching = JSON.stringify({ deal: "x", pad: "y".repeat(5000) });
    expect(sanitizeProperties({ __kaching_bundles: kaching, _other: kaching })).toEqual([{ name: "__kaching_bundles", value: kaching }]);
    expect(oversizedHiddenProperties({ __kaching_bundles: kaching, _other: kaching })).toEqual(["_other"]);
    // Other known apps' keys too (BOGOS, Simple Bundles).
    expect(sanitizeProperties({ _bogos_data: kaching, _sb_bundle: kaching }).map((p) => p.name)).toEqual(["_bogos_data", "_sb_bundle"]);
    const huge = "z".repeat(MAX_KNOWN_APP_VALUE + 1);
    expect(sanitizeProperties({ __kaching_bundles: huge })).toEqual([]);
    expect(oversizedHiddenProperties({ __kaching_bundles: huge })).toEqual(["__kaching_bundles"]);
  });

  it("4: a variant Shopify sells through its components only (requiresComponents) without components from the cart", () => {
    const parent = line({ requiresComponents: true });
    expect(reconcileCart({ currency: "EUR", items: [item()] }, [parent], "EUR")).toMatchObject({ ok: false, reason: "bundle_components_unresolved", detail: V(11) });
    expect(withClientProperties([parent], [{ variant_id: 11 }])).toMatchObject({ ok: false, reason: "bundle_components_unresolved" });
    // With its components from the cart: fine.
    const ok = reconcileCart({ currency: "EUR", items: [item({ item_components: [{ variant_id: 51, quantity: 1, final_line_price: 3000 }] })] }, [parent], "EUR");
    expect(ok.ok && ok.lines[0].components?.length).toBe(1);
  });
});
