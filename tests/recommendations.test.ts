import { describe, expect, it } from "vitest";
import {
  CHECKOUT_PALETTE,
  checkoutLayoutSchema,
  createBlock,
  dedupeSingletons,
  defaultCheckoutLayout,
  loadCheckoutLayout,
  loadThankYouLayout,
  SINGLETON_BLOCKS,
  THANK_YOU_PALETTE,
  thankYouLayoutSchema,
  variantGidOf,
} from "@/lib/layout";
import type { CartLine } from "@/lib/pricing";
import { localEstimate, localRatesFor } from "@/components/checkout/localCurrency";
import { MAX_CART_LINES, mergeRecommendations, sampleRecommendations, visibleRecommendations } from "@/components/checkout/recommendations";
import { arrangeCheckout } from "@/components/checkout/CheckoutView";
import { crossRate } from "@/lib/fx";

const gid = (n: number) => `gid://shopify/ProductVariant/${n}`;

function line(n: number, over: Partial<CartLine> = {}): CartLine {
  return {
    variantId: gid(n),
    productId: `gid://shopify/Product/${n}`,
    productHandle: `p-${n}`,
    title: `Produit ${n}`,
    variantTitle: null,
    sku: null,
    imageUrl: `https://cdn.example.com/${n}.jpg`,
    quantity: 1,
    unitPriceCents: 1000 + n,
    compareAtCents: null,
    inventory: null,
    requiresShipping: true,
    ...over,
  };
}

describe("recommendations block (layout)", () => {
  it("is created in the summary, empty, hiding products already in the cart", () => {
    const b = createBlock("recommendations");
    expect(b.placement).toBe("summary");
    expect(b.props).toEqual({ title: "", items: [], hideIfInCart: true });
    // An explicit placement still wins (templates).
    expect(createBlock("recommendations", { placement: "form" }).placement).toBe("form");
    // Other blocks keep the form default.
    expect(createBlock("faq").placement).toBe("form");
  });

  it("is a checkout-only singleton in the palette", () => {
    expect(SINGLETON_BLOCKS.has("recommendations")).toBe(true);
    expect(CHECKOUT_PALETTE).toContain("recommendations");
    expect(THANK_YOU_PALETTE).not.toContain("recommendations");
    const a = createBlock("recommendations");
    const b = createBlock("recommendations");
    expect(dedupeSingletons([a, b]).map((x) => x.id)).toEqual([a.id]);
  });

  it("accepts 0 to 4 items, refuses more", () => {
    const layout = defaultCheckoutLayout();
    const block = createBlock("recommendations");
    const items = (n: number) => Array.from({ length: n }, (_, i) => ({ variantId: gid(i + 1), title: "", imageUrl: "" }));
    const withItems = (n: number) => ({ blocks: [...layout.blocks, { ...block, props: { ...block.props, items: items(n) } }] });
    expect(checkoutLayoutSchema.safeParse(withItems(4)).success).toBe(true);
    expect(checkoutLayoutSchema.safeParse(withItems(5)).success).toBe(false);
  });

  it("keeps stored layouts working: unknown blocks ignored, duplicates dropped, thank-you refused", () => {
    const base = defaultCheckoutLayout();
    const reco = { id: "r1", type: "recommendations", props: { items: [{ variantId: gid(1) }] } };
    const loaded = loadCheckoutLayout({ blocks: [...base.blocks, { id: "x", type: "from_the_future", props: {} }, reco, { ...reco, id: "r2" }] });
    const recos = loaded.blocks.filter((b) => b.type === "recommendations");
    expect(recos).toHaveLength(1);
    expect(recos[0].type === "recommendations" && recos[0].props).toEqual({ title: "", items: [{ variantId: gid(1), title: "", imageUrl: "" }], hideIfInCart: true });
    expect(loaded.blocks.some((b) => (b.type as string) === "from_the_future")).toBe(false);
    expect(loadThankYouLayout({ blocks: [reco] }).blocks.some((b) => b.type === "recommendations")).toBe(false);
    expect(thankYouLayoutSchema.safeParse({ blocks: [createBlock("recommendations")] }).success).toBe(false);
  });

  it("has its own spot on the checkout, whatever its placement", () => {
    const layout = defaultCheckoutLayout();
    const reco = createBlock("recommendations", { placement: "form" });
    const arranged = arrangeCheckout([...layout.blocks, reco]);
    expect(arranged.recommendations?.id).toBe(reco.id);
    expect([...arranged.main, ...arranged.side, ...arranged.after, ...arranged.summary].some((b) => b.id === reco.id)).toBe(false);
    expect(arrangeCheckout([...layout.blocks, { ...reco, hidden: true }]).recommendations).toBeNull();
  });

  it("normalises pasted variant ids to GIDs", () => {
    expect(variantGidOf("44871234567890")).toBe(gid(44871234567890));
    expect(variantGidOf(` ${gid(12)} `)).toBe(gid(12));
    expect(variantGidOf("https://admin.shopify.com/store/x/products/1/variants/987")).toBe(gid(987));
    expect(variantGidOf("gid://shopify/Product/12")).toBeNull();
    expect(variantGidOf("abc")).toBeNull();
    expect(variantGidOf("")).toBeNull();
  });
});

describe("recommendations (checkout)", () => {
  const items = [
    { variantId: gid(1), title: "Bougie offerte", imageUrl: "https://saved.example.com/1.jpg" },
    { variantId: gid(2), title: "", imageUrl: "https://saved.example.com/2.jpg" },
    { variantId: gid(3), title: "", imageUrl: "" },
    { variantId: gid(4), title: "", imageUrl: "" },
  ];

  it("merges live Shopify data in the merchant's order, dropping unavailable and excluded products", () => {
    const priced = [line(2, { imageUrl: null, variantTitle: "Rouge", quantity: 1 }), line(1, { compareAtCents: 2000 }), line(4)];
    const merged = mergeRecommendations(items, priced, ["p-4"]);
    expect(merged.map((r) => r.variantId)).toEqual([gid(1), gid(2)]);
    expect(merged[0]).toMatchObject({ title: "Bougie offerte", variantTitle: null, unitPriceCents: 1001, compareAtCents: 2000, imageUrl: "https://cdn.example.com/1.jpg" });
    // Shopify title/variant when the merchant left the title empty; saved photo when Shopify has none.
    expect(merged[1]).toMatchObject({ title: "Produit 2", variantTitle: "Rouge", imageUrl: "https://saved.example.com/2.jpg", quantity: 1 });
  });

  it("hides products already in the cart (when asked) and everything once the cart is full", () => {
    const recos = [line(1), line(2)];
    expect(visibleRecommendations(recos, [line(1)], true).map((r) => r.variantId)).toEqual([gid(2)]);
    expect(visibleRecommendations(recos, [line(1, { quantity: 0 })], true)).toHaveLength(2);
    expect(visibleRecommendations(recos, [line(1)], false)).toHaveLength(2);
    const full = Array.from({ length: MAX_CART_LINES }, (_, i) => line(100 + i));
    expect(visibleRecommendations(recos, full, true)).toEqual([]);
  });

  it("has sample cards for the builder preview", () => {
    expect(sampleRecommendations([], ["A", "B"]).map((r) => r.title)).toEqual(["A", "B"]);
    const picked = sampleRecommendations([{ variantId: gid(9), title: "Mon produit", imageUrl: "" }], ["A"]);
    expect(picked).toHaveLength(1);
    expect(picked[0]).toMatchObject({ variantId: gid(9), title: "Mon produit", imageUrl: null });
    expect(picked[0].unitPriceCents).toBeGreaterThan(0);
  });
});

describe("local-currency estimate", () => {
  const ecb = { EUR: 1, CHF: 0.94, GBP: 0.85, USD: 1.1, HUF: 400, SEK: 11.5 };
  const rates = localRatesFor("EUR", (f, t) => crossRate(f, t, ecb));

  it("builds multipliers for the listed currencies that have a rate, never the checkout's own", () => {
    expect(rates).toEqual({ CHF: 0.94, GBP: 0.85, USD: 1.1, HUF: 400, SEK: 11.5 });
    const fromUsd = localRatesFor("USD", (f, t) => crossRate(f, t, ecb));
    expect(fromUsd.USD).toBeUndefined();
    expect(fromUsd.CHF).toBeCloseTo(0.94 / 1.1, 10);
  });

  it("formats the converted total in the checkout's locale", () => {
    expect(localEstimate(5564, "CH", "EUR", rates, "fr")).toEqual({ amount: "52,30 CHF", currency: "CHF" });
    expect(localEstimate(10000, "GB", "EUR", rates, "en")?.amount).toBe("GBP\u00a085.00");
    // Codes, not symbols: "£GB" / "$US" read badly, "$" is ambiguous (CAD, USD).
    // Forint without cents.
    expect(localEstimate(1000, "HU", "EUR", rates, "fr")?.amount).toBe("4 000 HUF");
  });

  it("is hidden for the checkout's currency, unlisted countries, missing rates or an empty total", () => {
    expect(localEstimate(1000, "FR", "EUR", rates, "fr")).toBeNull();
    expect(localEstimate(1000, "US", "USD", { USD: 1 }, "fr")).toBeNull();
    expect(localEstimate(1000, "CA", "EUR", rates, "fr")).toBeNull(); // no CAD rate
    expect(localEstimate(1000, "CH", "EUR", null, "fr")).toBeNull();
    expect(localEstimate(0, "CH", "EUR", rates, "fr")).toBeNull();
    expect(localEstimate(1000, null, "EUR", rates, "fr")).toBeNull();
  });
});
