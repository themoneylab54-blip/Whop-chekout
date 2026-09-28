import type { CartLine } from "@/lib/pricing";

/*
 * "Complétez votre commande": products the merchant suggests, added to the cart in one tap.
 * Pure helpers shared by the checkout page (server) and the checkout view (browser).
 */

/** A suggested product as the checkout shows it: a Shopify-priced line (quantity 1). */
export type RecommendationView = CartLine;

/** Lines the checkout accepts (server: checkout.ts MAX_LINES). */
export const MAX_CART_LINES = 30;

/**
 * Merges the block's items with Shopify's live data, in the merchant's order: unavailable or
 * unknown variants and excluded products drop out; the merchant's title wins when set, the
 * live photo wins over the saved one.
 */
export function mergeRecommendations(
  items: { variantId: string; title: string; imageUrl: string }[],
  priced: CartLine[],
  excludedHandles: readonly string[] = [],
): RecommendationView[] {
  const byId = new Map(priced.map((l) => [l.variantId, l]));
  const seen = new Set<string>();
  const out: RecommendationView[] = [];
  for (const it of items) {
    const live = byId.get(it.variantId);
    if (!live || seen.has(it.variantId) || excludedHandles.includes(live.productHandle)) continue;
    seen.add(it.variantId);
    out.push({
      ...live,
      quantity: 1,
      title: it.title.trim() || live.title,
      // The merchant's title already names the variant: no second line under it.
      variantTitle: it.title.trim() ? null : live.variantTitle,
      imageUrl: live.imageUrl ?? (it.imageUrl || null),
    });
  }
  return out;
}

/** Suggestions to show now: those not in the cart (when asked), none once the cart is full. */
export function visibleRecommendations(
  recos: readonly RecommendationView[],
  cart: readonly Pick<CartLine, "variantId" | "quantity">[],
  hideIfInCart: boolean,
): RecommendationView[] {
  const inCart = new Set(cart.filter((l) => l.quantity > 0).map((l) => l.variantId));
  if (inCart.size >= MAX_CART_LINES) return recos.filter((r) => inCart.has(r.variantId) && !hideIfInCart);
  return hideIfInCart ? recos.filter((r) => !inCart.has(r.variantId)) : [...recos];
}

/** Sample suggestions for the builder preview (the block's own picks, else placeholders). */
export function sampleRecommendations(
  items: { variantId: string; title: string; imageUrl: string }[],
  fallbackTitles: string[],
): RecommendationView[] {
  const source = items.length
    ? items.map((it, i) => ({ id: it.variantId || `sample-${i}`, title: it.title || fallbackTitles[i % fallbackTitles.length], imageUrl: it.imageUrl || null }))
    : fallbackTitles.slice(0, 2).map((title, i) => ({ id: `sample-${i}`, title, imageUrl: null }));
  const prices = [1990, 1490, 2490, 990];
  return source.map((s, i) => ({
    variantId: s.id,
    productId: s.id,
    productHandle: "",
    title: s.title,
    variantTitle: null,
    sku: null,
    imageUrl: s.imageUrl,
    quantity: 1,
    unitPriceCents: prices[i % prices.length],
    compareAtCents: i === 0 ? 2490 : null,
    inventory: null,
    requiresShipping: true,
  }));
}
