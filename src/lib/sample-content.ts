import { honestReviewItem, type Block, type ReviewItem } from "@/lib/layout";
import { isPlaceholderTextBody, isPlaceholderTextHeading, isPlaceholderWhyUsRow, isSampleReview } from "@/lib/legacy-sample";

/**
 * What the live page shows is what the builder shows. Pure (server and browser). Nothing is
 * hidden because it looks like an example, and no example text is flagged: the merchant's texts,
 * figures, promises, coupon code, testimonial or announcement render live as written. The only
 * example content that never reaches buyers is invented reviews (new reviews blocks start empty;
 * the example reviews Camille R. / Yanis B. never show live) and the untouched example content of
 * blocks tagged `sample` by an earlier version, which buyers never saw (layout.ts loadBlocks →
 * migrateLegacySample).
 */

export { isSampleReview, SAMPLE_COUPON_CODE } from "@/lib/legacy-sample";

/** A text block's parts buyers see: the old shipped placeholders (« Titre », « Votre texte ici. ») never show. */
export function liveTextParts(props: { heading: string; body: string }): { heading: string; body: string } {
  return {
    heading: isPlaceholderTextHeading(props.heading) ? "" : props.heading.trim() ? props.heading : "",
    body: isPlaceholderTextBody(props.body) ? "" : props.body.trim() ? props.body : "",
  };
}
/** « Pourquoi nous » rows buyers see: blank rows and the old « Titre » / « Texte » rows never show. */
export function liveWhyUsRows<T extends { title: string; text: string }>(rows: T[]): T[] {
  return rows.filter((r) => !isPlaceholderWhyUsRow(r));
}
/** Key figures buyers see: an item without value or label (« Ajouter un chiffre », not filled in) never shows. */
export function liveStatItems<T extends { value: string; label: string }>(items: T[]): T[] {
  return items.filter((it) => it.value.trim() !== "" || it.label.trim() !== "");
}

/** A block tagged `sample` by an earlier version (the loader drops the tag: see migrateLegacySample). */
export function isSampleTagged(block: Pick<Block, "sample">): boolean {
  return block.sample === true;
}

/**
 * Reviews buyers see. The shipped example reviews (exact invented name and text: Camille R.,
 * Yanis B.) never show, tagged block or not; a block still tagged `sample` shows none of its
 * items. Every other review the merchant kept shows as written; reviews left without text are
 * skipped.
 */
export function liveReviewItems<T extends { name: string; text: string }>(block: { sample?: true; props: { items: T[] } }): T[] {
  if (isSampleTagged(block)) return [];
  return block.props.items.filter((it) => it.text.trim() !== "" && !isSampleReview(it));
}

/**
 * Reviews as rendered (builder and live, tagged block or not): "Achat vérifié" only on a review
 * imported from a review app whose text and stars are still as imported (honestReviewItem), and
 * never on a shipped example review (old untagged blocks included).
 */
export function honestReviewItems<T extends { name: string; text: string; verified: boolean; source?: string; stars?: number; importSig?: string }>(items: T[]): T[] {
  return items.map((it) => {
    if (!it.verified) return it;
    if (isSampleReview(it)) return { ...it, verified: false };
    return honestReviewItem(it as T & { source?: ReviewItem["source"] });
  });
}

export const NEVER_OFFERED_LOGOS_WARNING = "Logos SEPA / crypto : ces moyens ne sont pas proposés sur ce checkout, ils ne sont jamais affichés — retirez-les";
/** Payment logos of means this checkout never offers (SEPA, crypto): filtered out live. */
export function neverOfferedLogos(methods: readonly string[]): string[] {
  return methods.filter((m) => m === "sepa" || m === "crypto");
}

/**
 * The layout as sent to the buyer's browser (live checkout / thank-you page): each reviews block
 * keeps only the reviews buyers can see (liveReviewItems: no example review, no empty one), and a
 * hidden one none. Every live review is still sent: the « Voir plus » pagination and the per-cart
 * ordering (reviews of the products in the cart first) run in the browser over the whole list.
 * Nothing else changes.
 */
export function liveLayoutPayload<L extends { blocks: Block[] }>(layout: L): L {
  if (!layout.blocks.some((b) => b.type === "reviews")) return layout;
  return {
    ...layout,
    blocks: layout.blocks.map((b) => (b.type === "reviews" ? { ...b, props: { ...b.props, items: b.hidden ? [] : liveReviewItems(b) } } : b)),
  };
}
