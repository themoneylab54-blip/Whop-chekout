import { SAMPLE_CONTENT_BLOCKS, type Block, type BlockType, type Language as Lang } from "@/lib/layout";
import { DEFAULT_TEXTS, localizeBlock, textFields } from "@/components/checkout/localize";

/**
 * Sample content shipped with the blocks that would be false for the buyer if published as is.
 * Pure (server and browser). Two levels:
 *   - sampleWarnings: fabricated proof (reviews, testimonial, key figures, coupon code, the
 *     example announcement, placeholder text). Never shown to buyers: the live page treats it
 *     as empty (isEmptyInLive / liveReviewItems / liveStatItems), and the builder lists it as a
 *     setup warning ("remplacez-les … pour les afficher"). Publishing is never blocked.
 *     Only blocks tagged Block.sample (created from the palette or a template since then) are
 *     hidden: a block published before keeps rendering as it did (a deploy never changes a live
 *     page) and its example content is listed in amber with the promises.
 *   - promiseWarnings: example commitments (refund period, free shipping, dispatch time,
 *     support hours, delivery estimate). Listed in amber, never blocking.
 */

type FrTexts = (typeof DEFAULT_TEXTS)["fr"];
/** A shipped default in any buyer language (the live page renders localized props). */
const shipped = (key: keyof FrTexts) => new Set<string>(Object.values(DEFAULT_TEXTS).map((t) => t[key].trim()));
/** The shipped example reviews: each invented name with its own text (in any buyer language). */
const SAMPLE_REVIEWS: { name: string; texts: Set<string> }[] = [
  { name: "Camille R.", texts: shipped("review1") },
  { name: "Yanis B.", texts: shipped("review2") },
];
/** Key figures shipped as examples; "48 h" only with its shipped label (a real "48 h" dispatch time stays). */
const SAMPLE_STAT_VALUES = new Set<string>([...shipped("statCustomersValue"), ...shipped("statRatingValue")]);
const SAMPLE_DISPATCH_VALUE = "48 h";
const SAMPLE_DISPATCH_LABELS = shipped("statDispatch");
const SAMPLE_TESTIMONIALS = shipped("testimonialQuote");
const SAMPLE_ANNOUNCEMENTS = shipped("announcement");
const SAMPLE_TEXT_HEADINGS = shipped("textHeading");
const SAMPLE_TEXT_BODIES = shipped("textBody");
/** The example coupon code shipped with the block: it exists in no store. */
export const SAMPLE_COUPON_CODE = "MERCI10";

/** A shipped example review (the invented customer with the shipped text): never shown to buyers. */
export function isSampleReview(item: { name: string; text: string }): boolean {
  const name = item.name.trim();
  const text = item.text.trim();
  return SAMPLE_REVIEWS.some((r) => r.name === name && r.texts.has(text));
}

/** A shipped example key figure ("+10 000", "4,8/5", "48 h expédition"): never shown to buyers. */
export function isSampleStat(item: { value: string; label?: string }): boolean {
  const value = item.value.trim();
  if (SAMPLE_STAT_VALUES.has(value)) return true;
  return value === SAMPLE_DISPATCH_VALUE && item.label != null && SAMPLE_DISPATCH_LABELS.has(item.label.trim());
}

/**
 * True when the block was created with shipped example content since the live page hides it
 * (Block.sample). Blocks published before carry no flag: their content is shown as it always
 * was, and flagged in amber in the builder (promiseWarnings) instead of being hidden.
 */
export function isSampleTagged(block: Pick<Block, "sample">): boolean {
  return block.sample === true;
}

/**
 * Reviews buyers see: a tagged block drops its shipped examples and any review left blank; an
 * untagged block (published before) renders every item exactly as it always did.
 */
export function liveReviewItems<T extends { name: string; text: string }>(block: { sample?: true; props: { items: T[] } }): T[] {
  if (!isSampleTagged(block)) return block.props.items;
  return block.props.items.filter((it) => it.text.trim() !== "" && !isSampleReview(it));
}

/**
 * Reviews as rendered (builder and live, tagged block or not): "Achat vérifié" is never shown
 * on a shipped example review (old untagged blocks included) nor on one typed in the builder.
 */
export function honestReviewItems<T extends { name: string; text: string; verified: boolean; source?: string }>(items: T[]): T[] {
  return items.map((it) => (it.verified && (isSampleReview(it) || (it.source !== "csv" && it.source !== "judgeme")) ? { ...it, verified: false } : it));
}

/** Key figures buyers see: without the shipped examples of a tagged block. */
export function liveStatItems<T extends { value: string; label?: string }>(block: { sample?: true; props: { items: T[] } }): T[] {
  return isSampleTagged(block) ? block.props.items.filter((it) => !isSampleStat(it)) : block.props.items;
}

/** Which parts of a text block are the shipped placeholder ("Titre", "Votre texte ici."). */
function sampleTextParts(props: { heading: string; body: string }): { heading: boolean; body: boolean } {
  return { heading: SAMPLE_TEXT_HEADINGS.has(props.heading.trim()), body: SAMPLE_TEXT_BODIES.has(props.body.trim()) };
}

/**
 * A text block's texts for buyers: a placeholder part of a tagged block is emptied (the
 * merchant's own heading shows without "Votre texte ici.", and the other way round).
 */
export function liveTextProps<P extends { heading: string; body: string }>(block: { sample?: true; props: P }): P {
  if (!isSampleTagged(block)) return block.props;
  const parts = sampleTextParts(block.props);
  if (!parts.heading && !parts.body) return block.props;
  return { ...block.props, heading: parts.heading ? "" : block.props.heading, body: parts.body ? "" : block.props.body };
}

/** The block still holds shipped example content (tagged or not). */
function hasSampleContent(block: Block): boolean {
  switch (block.type) {
    case "reviews":
      return block.props.items.some(isSampleReview);
    case "stats":
      return block.props.items.some(isSampleStat);
    case "text": {
      const p = sampleTextParts(block.props);
      return p.heading || p.body;
    }
    default:
      return sampleContentOnly(block);
  }
}

/** Nothing but shipped example content is left in the block (whatever its tag). */
function sampleContentOnly(block: Block): boolean {
  switch (block.type) {
    case "reviews":
      return block.props.items.filter((it) => !isSampleReview(it) && it.text.trim() !== "").length === 0;
    case "stats":
      return block.props.items.every(isSampleStat);
    case "testimonial":
      return SAMPLE_TESTIMONIALS.has(block.props.quote.trim());
    case "coupon":
      // The merchant confirmed the code exists in their store (confirmCouponCode): real content.
      return block.props.code.trim().toUpperCase() === SAMPLE_COUPON_CODE && block.props.codeConfirmed !== true;
    case "announcement":
      return SAMPLE_ANNOUNCEMENTS.has(block.props.text.trim());
    case "text": {
      // Hidden only when neither part is the merchant's own (a placeholder or empty).
      const p = sampleTextParts(block.props);
      return (p.heading || p.body) && (p.heading || !block.props.heading.trim()) && (p.body || !block.props.body.trim());
    }
    default:
      return false;
  }
}

/**
 * True when a tagged block (Block.sample) has nothing but sample content left for buyers
 * (sample reviews / figures only, the example testimonial, coupon code, announcement or a
 * placeholder-only text): the live page skips it, like a countdown without an end date.
 * Untagged blocks (published before sample content was hidden) are never skipped.
 */
export function isSampleOnly(block: Block): boolean {
  return isSampleTagged(block) && sampleContentOnly(block);
}

/** The block in its base language and in every language it has translations for. */
function withTranslations(block: Block): Block[] {
  const langs = Object.keys(block.i18n ?? {}) as Lang[];
  return [block, ...langs.map((l) => localizeBlock(block, l))];
}

/**
 * Shipped example commitments (refund period, free shipping, dispatch time, support hours):
 * binding promises the merchant may not actually offer.
 */
const SAMPLE_PROMISE_KEYS = [
  "moneyBack30",
  "moneyBack",
  "guaranteeText",
  "easyReturns",
  "freeShipping",
  "guarantee30",
  "refundedIfUnhappy",
  "fastDispatch",
  "dispatched48",
  "fastDelivery",
  "shipped48",
  "support7",
  "support7Short",
  "faqA1",
  "faqA2",
  "supportText",
] as const satisfies readonly (keyof FrTexts)[];
/** In every buyer language: a merchant translation may still hold a shipped promise. */
const SAMPLE_PROMISES = new Set<string>(SAMPLE_PROMISE_KEYS.flatMap((k) => [...shipped(k)]));
/** Blocks whose shipped copy states a commitment (guarantee, benefits, value props, badges, support…). */
const PROMISE_BLOCKS: ReadonlySet<BlockType> = new Set<BlockType>([
  "guarantee",
  "benefits",
  "value_props",
  "trust_badges",
  "why_us",
  "comparison",
  "faq",
  "support",
  "delivery_estimate",
]);
export const SAMPLE_PROMISE_WARNING = "Promesse d'exemple : vérifiez qu'elle correspond à votre politique";
export const SAMPLE_DELIVERY_WARNING = "Délai d'exemple (3 à 5 jours) : indiquez votre vrai délai de livraison";
export const SAMPLE_PAYMENT_ICONS_WARNING = "Logos de paiement : vérifiez qu'ils correspondent aux moyens acceptés";
export const NEVER_OFFERED_LOGOS_WARNING = "Logos SEPA / crypto : ces moyens ne sont pas proposés sur ce checkout, ils ne sont jamais affichés — retirez-les";
/** Payment logos of means this checkout never offers (SEPA, crypto): filtered out live. */
export function neverOfferedLogos(methods: readonly string[]): string[] {
  return methods.filter((m) => m === "sepa" || m === "crypto");
}
/** The payment logos' shipped list (DEFAULT_PROPS.payment_icons). */
const SAMPLE_PAYMENT_METHODS = ["visa", "mastercard", "amex", "applepay", "gpay"];
/** The delivery estimate's shipped delay (DEFAULT_PROPS.delivery_estimate). */
const SAMPLE_DELIVERY_DAYS = { minDays: 3, maxDays: 5 };

/**
 * Visible blocks still showing an example commitment the merchant may not offer: 30-day refund,
 * free shipping, 48 h dispatch, 24 h support reply, the 3–5 day delivery estimate, the shipped
 * payment logos (Amex, Apple Pay… the store may not accept)… A warning
 * (amber), not a publishing gate: the merchant checks it matches their policy.
 */
export function promiseWarnings(blocks: Block[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of blocks) {
    if (b.hidden) continue;
    // Shipped logos (Amex, Apple Pay, Google Pay…) the store may not accept.
    if (b.type === "payment_icons") {
      const m = b.props.methods;
      if (neverOfferedLogos(m).length) out[b.id] = NEVER_OFFERED_LOGOS_WARNING;
      else if (m.length === SAMPLE_PAYMENT_METHODS.length && SAMPLE_PAYMENT_METHODS.every((x) => m.includes(x as (typeof m)[number])))
        out[b.id] = SAMPLE_PAYMENT_ICONS_WARNING;
      continue;
    }
    // Example content of a block published before sample content was hidden: still shown to
    // buyers as it always was (never hidden on a deploy), to check like a promise.
    if (!isSampleTagged(b) && SAMPLE_CONTENT_BLOCKS.has(b.type)) {
      const shown = withTranslations(b).find(hasSampleContent);
      if (shown) out[b.id] = VISIBLE_SAMPLE_WARNINGS[shown.type as SampleType](shown);
      continue;
    }
    if (!PROMISE_BLOCKS.has(b.type)) continue;
    if (b.type === "delivery_estimate") {
      if (b.props.minDays === SAMPLE_DELIVERY_DAYS.minDays && b.props.maxDays === SAMPLE_DELIVERY_DAYS.maxDays) out[b.id] = SAMPLE_DELIVERY_WARNING;
    } else if (textFields(b.props).some((f) => SAMPLE_PROMISES.has(f.value.trim())) || translatedValues(b).some((v) => SAMPLE_PROMISES.has(v.trim())))
      out[b.id] = SAMPLE_PROMISE_WARNING;
  }
  return out;
}

/** Every merchant translation of the block (all languages). */
function translatedValues(b: Block): string[] {
  return Object.values(b.i18n ?? {}).flatMap((fields) => Object.values(fields ?? {}));
}

type SampleType = "reviews" | "stats" | "testimonial" | "coupon" | "announcement" | "text";
/** Amber wording for example content buyers still see (untagged blocks published before). */
const VISIBLE_SAMPLE_WARNINGS: Record<SampleType, (b: Block) => string> = {
  reviews: () => "Avis d'exemple visibles par vos clients : remplacez-les par vos vrais avis",
  stats: () => "Chiffres d'exemple visibles par vos clients : remplacez-les par vos vrais chiffres",
  testimonial: () => "Témoignage d'exemple visible par vos clients : remplacez-le par un vrai témoignage",
  coupon: () => `Code d'exemple ${SAMPLE_COUPON_CODE} visible par vos clients : vérifiez qu'il existe dans votre boutique`,
  announcement: () => "Annonce d'exemple (livraison offerte dès 50 €) visible par vos clients : vérifiez qu'elle correspond à votre offre",
  text: () => "Texte d'exemple (« Titre », « Votre texte ici. ») visible par vos clients : écrivez le vôtre",
};

/** Setup wording for a tagged block's example content (hidden from buyers until replaced). */
function hiddenSampleWarning(b: Block): string | null {
  switch (b.type) {
    case "reviews":
      return "Avis d'exemple : remplacez-les par vos vrais avis pour les afficher";
    case "stats":
      return "Chiffres d'exemple : remplacez-les par vos vrais chiffres pour les afficher";
    case "testimonial":
      return "Témoignage d'exemple : remplacez-le par un vrai témoignage client pour l'afficher";
    case "coupon":
      return `Code d'exemple ${SAMPLE_COUPON_CODE} : indiquez un code promo qui existe dans votre boutique pour l'afficher`;
    case "announcement":
      return "Annonce d'exemple (livraison offerte dès 50 €) : indiquez votre vraie offre pour l'afficher";
    case "text": {
      const p = sampleTextParts(b.props);
      const parts = [p.heading && "« Titre »", p.body && "« Votre texte ici. »"].filter(Boolean).join(", ");
      return p.heading && p.body
        ? `Texte d'exemple (${parts}) : écrivez le vôtre pour l'afficher`
        : `Texte d'exemple (${parts}) masqué pour vos clients : écrivez le vôtre pour l'afficher`;
    }
    default:
      return null;
  }
}

/**
 * Visible tagged blocks (Block.sample) still holding shipped example content that would fake
 * proof or offers for the buyer: sample reviews and testimonial (invented customers), sample
 * key figures ("+10 000 clients", "48 h"), the example coupon code, the example free-shipping
 * announcement and the placeholder text ("Titre", "Votre texte ici."), in the base text or a
 * translation. Buyers never see it (hidden in the live page): a setup warning asks the merchant
 * to replace it to show the block. Untagged blocks get an amber promiseWarnings entry instead.
 */
export function sampleWarnings(blocks: Block[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of blocks) {
    if (b.hidden || !isSampleTagged(b) || !SAMPLE_CONTENT_BLOCKS.has(b.type)) continue;
    const found = withTranslations(b).find(hasSampleContent);
    const text = found && hiddenSampleWarning(found);
    if (text) out[b.id] = text;
  }
  return out;
}

/**
 * Untagged visible blocks still showing shipped example content to buyers (published before
 * sample content was hidden): the amber "… d'exemple visible(s) par vos clients" entries.
 */
export function visibleSampleIds(blocks: Block[]): string[] {
  return blocks.filter((b) => !b.hidden && !isSampleTagged(b) && SAMPLE_CONTENT_BLOCKS.has(b.type) && withTranslations(b).some(hasSampleContent)).map((b) => b.id);
}

/**
 * "Masquer les exemples": tags those blocks (Block.sample) so their example content is hidden
 * from buyers, like a block created since. Explicit merchant action (undoable in the builder).
 */
export function hideVisibleSamples(blocks: Block[]): Block[] {
  const ids = new Set(visibleSampleIds(blocks));
  return ids.size ? blocks.map((b) => (ids.has(b.id) ? ({ ...b, sample: true } as Block) : b)) : blocks;
}

/**
 * A duplicated block is a new block: tagged (Block.sample) when it still holds shipped example
 * content, even if its source was published before the tag existed.
 */
export function tagDuplicate(copy: Block): Block {
  if (isSampleTagged(copy) || !SAMPLE_CONTENT_BLOCKS.has(copy.type) || !withTranslations(copy).some(hasSampleContent)) return copy;
  return { ...copy, sample: true } as Block;
}

type CouponBlock = Extract<Block, { type: "coupon" }>;

/**
 * « Ce code existe dans ma boutique »: the example code is real in this store. Marks the code
 * confirmed (sampleContentOnly then treats it as real content: shown live, no warning) but keeps
 * the tag: typing another code drops the confirmation, and re-typing the example code afterwards
 * hides it from buyers again instead of showing an unconfirmed example code.
 */
export function confirmCouponCode(block: CouponBlock): CouponBlock {
  return { ...block, props: { ...block.props, codeConfirmed: true } };
}

/** Undoes confirmCouponCode: only the confirmation is dropped (the tag is left as it was). */
export function unconfirmCouponCode(block: CouponBlock): CouponBlock {
  const { codeConfirmed: _c, ...props } = block.props;
  void _c;
  return { ...block, props };
}
