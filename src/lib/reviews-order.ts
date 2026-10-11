import type { ReviewItem } from "./layout";

/*
 * The review helpers the checkout and thank-you pages run in the buyer's browser (the order of the
 * reviews for the cart, the transparency line's source), apart from the import code of the
 * dashboard (reviews-import, which re-exports them): the payment page never downloads the CSV and
 * Judge.me parsers. Pure.
 */

/** Numeric Shopify product id ("gid://shopify/Product/123", "123"), or undefined. */
export function productIdOf(v: string | number | undefined | null): string | undefined {
  const m = /(\d{1,20})\s*$/.exec(String(v ?? "").trim());
  return m ? m[1] : undefined;
}

/**
 * Where the imported reviews among `items` come from, for the buyer-facing transparency line:
 * "judgeme" when they all come from the Judge.me API, "app" when any comes from a CSV export
 * (a review app not named), null when none is imported (hand-typed only: no line).
 */
export function importedReviewsOrigin(items: Pick<ReviewItem, "source">[]): "judgeme" | "app" | null {
  const imported = items.filter((r) => r.source === "csv" || r.source === "judgeme");
  if (imported.length === 0) return null;
  return imported.every((r) => r.source === "judgeme") ? "judgeme" : "app";
}

/* ------------------------------------------------------------------ */
/* Per-cart order                                                      */
/* ------------------------------------------------------------------ */

export type CartProducts = { handles: string[]; productIds: string[] };

/** The cart's products, as the reviews name them (handles lowercased, numeric ids). */
export function cartProductsOf(lines: { productHandle?: string | null; productId?: string | null; gift?: boolean }[]): CartProducts {
  const buyer = lines.filter((l) => !l.gift);
  return {
    handles: [...new Set(buyer.map((l) => String(l.productHandle ?? "").toLowerCase()).filter(Boolean))],
    productIds: [...new Set(buyer.map((l) => productIdOf(l.productId)).filter((v): v is string => !!v))],
  };
}

/**
 * Reviews of the products in the cart first, then the general ones (no product), then the other
 * products'. Stable: the merchant's order is kept within each group.
 */
export function orderReviewsForCart<T extends Pick<ReviewItem, "productHandle" | "productId">>(items: T[], cart: CartProducts | null | undefined): T[] {
  if (!cart || (cart.handles.length === 0 && cart.productIds.length === 0)) return items;
  const handles = new Set(cart.handles.map((h) => h.toLowerCase()));
  const ids = new Set(cart.productIds);
  const rank = (r: T) => {
    if ((r.productHandle && handles.has(r.productHandle.toLowerCase())) || (r.productId && ids.has(r.productId))) return 0;
    return r.productHandle || r.productId ? 2 : 1;
  };
  return items
    .map((r, i) => ({ r, i, k: rank(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}
