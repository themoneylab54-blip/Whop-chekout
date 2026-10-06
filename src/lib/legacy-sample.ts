import type { Block } from "./layout";
import { DEFAULT_TEXTS } from "@/components/checkout/localize";

/**
 * Example content earlier versions shipped, recognised by its exact values: the example reviews
 * (invented customers, by name and text: never shown to buyers, never "Achat vérifié"), and the
 * example figures, testimonial, coupon, announcement and placeholder text of blocks tagged `sample`
 * (migrateLegacySample). Used by the loader and the reviews code. Pure (server and browser). Imports no runtime value from layout.ts, which calls it
 * from its loader.
 */

/**
 * A shipped default in any buyer language, plus the French value earlier versions shipped (kept
 * literally: the loader must recognise old example content even if the current defaults change).
 */
const shipped = (key: string, fr: string) =>
  new Set<string>([fr, ...Object.values(DEFAULT_TEXTS).map((t) => (t as Record<string, string | undefined>)[key]?.trim() ?? "")].filter(Boolean));
const SAMPLE_REVIEWS: { name: string; texts: Set<string> }[] = [
  { name: "Camille R.", texts: shipped("review1", "Commande reçue en 3 jours, qualité au top. Je recommande !") },
  { name: "Yanis B.", texts: shipped("review2", "Service client réactif et produit conforme aux photos.") },
];
/** Example key figures earlier versions shipped; "48 h" only with its shipped label (a real "48 h" dispatch time stays). */
const SAMPLE_STAT_VALUES = new Set<string>([...shipped("statCustomersValue", "+10 000"), ...shipped("statRatingValue", "4,8/5")]);
const SAMPLE_DISPATCH_VALUE = "48 h";
const SAMPLE_DISPATCH_LABELS = shipped("statDispatch", "expédition");
const SAMPLE_TESTIMONIALS = shipped("testimonialQuote", "Livraison rapide et produit conforme, je recommande.");
const SAMPLE_ANNOUNCEMENTS = shipped("announcement", "Livraison offerte dès 50 € d'achat");
const SAMPLE_TEXT_HEADINGS = shipped("textHeading", "Titre");
const SAMPLE_TEXT_BODIES = shipped("textBody", "Votre texte ici.");
/** The example coupon code the coupon block ships with (a plain default, shown as written). */
export const SAMPLE_COUPON_CODE = "MERCI10";

/** A shipped example review (the invented customer with the shipped text). */
export function isSampleReview(item: { name: string; text: string }): boolean {
  const name = item.name.trim();
  const text = item.text.trim();
  return SAMPLE_REVIEWS.some((r) => r.name === name && r.texts.has(text));
}

/**
 * The placeholder parts earlier versions put in a new text block (« Titre », « Votre texte ici. »,
 * exact values): never shown live, tagged block or not (new text blocks start empty).
 */
export function isPlaceholderTextHeading(heading: string): boolean {
  return SAMPLE_TEXT_HEADINGS.has(heading.trim());
}
export function isPlaceholderTextBody(body: string): boolean {
  return SAMPLE_TEXT_BODIES.has(body.trim());
}
/** A « Pourquoi nous » row as earlier versions added it (« Titre » / « Texte »), or a blank one: not shown live. */
export function isPlaceholderWhyUsRow(row: { title: string; text: string }): boolean {
  const title = row.title.trim();
  const text = row.text.trim();
  return (title === "" && text === "") || (title === "Titre" && text === "Texte");
}

/** An example key figure earlier versions shipped ("+10 000", "4,8/5", "48 h expédition"). */
export function isSampleStat(item: { value: string; label?: string }): boolean {
  const value = item.value.trim();
  if (SAMPLE_STAT_VALUES.has(value)) return true;
  return value === SAMPLE_DISPATCH_VALUE && item.label != null && SAMPLE_DISPATCH_LABELS.has(item.label.trim());
}

/**
 * Untagged blocks: the placeholder words earlier versions put in a new text block (« Titre »,
 * « Votre texte ici. ») or a new « Pourquoi nous » row (« Titre » / « Texte »), exact values, load
 * empty. The builder then shows its placeholders and buyers see nothing (an empty part, row or
 * text block is not rendered live), so the builder and the live page stay the same. Everything
 * else is unchanged.
 */
function clearOldPlaceholders(b: Block): Block {
  if (b.type === "text") {
    const heading = isPlaceholderTextHeading(b.props.heading);
    const body = isPlaceholderTextBody(b.props.body);
    if (!heading && !body) return b;
    return { ...b, props: { ...b.props, heading: heading ? "" : b.props.heading, body: body ? "" : b.props.body } };
  }
  if (b.type === "why_us" && b.props.rows.some((r) => r.title.trim() === "Titre" && r.text.trim() === "Texte")) {
    return { ...b, props: { ...b.props, rows: b.props.rows.map((r) => (r.title.trim() === "Titre" && r.text.trim() === "Texte" ? { ...r, title: "", text: "" } : r)) } };
  }
  return b;
}

function untag<B extends Block>(b: B, props: B["props"] = b.props, hidden = b.hidden): B {
  const { sample: _s, ...rest } = b;
  void _s;
  return { ...rest, hidden, props } as B;
}

/**
 * A block tagged `sample` by an earlier version: it was created with example content, never
 * edited, and buyers never saw that example content. The tag is dropped, and only what still
 * holds the exact shipped example values stays out of buyers' sight, so a deploy never shows
 * invented content on a live page:
 *   - reviews: the example reviews (Camille R., Yanis B.) and empty ones are removed;
 *   - stats: the example figures are removed; a block holding nothing else is hidden instead
 *     (its figures kept for the merchant to edit);
 *   - text: a placeholder part (« Titre », « Votre texte ici. ») is emptied when the other part is
 *     the merchant's own; a placeholder-only block is hidden;
 *   - testimonial (example quote), coupon (MERCI10 never confirmed), announcement (example
 *     text): hidden, content kept.
 * Hidden blocks show as hidden in the builder (the merchant can show them again). Anything the
 * merchant changed shows as written. Untagged blocks only lose the exact old placeholder words
 * (clearOldPlaceholders).
 */
export function migrateLegacySample(b: Block): Block {
  if (b.sample !== true) return clearOldPlaceholders(b);
  const hide = () => untag(b, b.props, true);
  switch (b.type) {
    case "reviews":
      return untag(b, { ...b.props, items: b.props.items.filter((it) => it.text.trim() !== "" && !isSampleReview(it)) });
    case "stats": {
      const own = b.props.items.filter((it) => !isSampleStat(it));
      if (own.length === 0 && b.props.items.length > 0) return hide();
      return untag(b, { ...b.props, items: own });
    }
    case "text": {
      const heading = SAMPLE_TEXT_HEADINGS.has(b.props.heading.trim());
      const body = SAMPLE_TEXT_BODIES.has(b.props.body.trim());
      if (!heading && !body) return untag(b);
      const ownHeading = !heading && b.props.heading.trim() !== "";
      const ownBody = !body && b.props.body.trim() !== "";
      // Placeholder only: hidden, and emptied like an untagged one (stable when loaded again).
      if (!ownHeading && !ownBody) return untag(b, { ...b.props, heading: "", body: "" }, true);
      return untag(b, { ...b.props, heading: heading ? "" : b.props.heading, body: body ? "" : b.props.body });
    }
    case "testimonial":
      return SAMPLE_TESTIMONIALS.has(b.props.quote.trim()) ? hide() : untag(b);
    case "coupon":
      return b.props.code.trim().toUpperCase() === SAMPLE_COUPON_CODE && b.props.codeConfirmed !== true ? hide() : untag(b);
    case "announcement":
      return SAMPLE_ANNOUNCEMENTS.has(b.props.text.trim()) ? hide() : untag(b);
    default:
      return untag(b);
  }
}
