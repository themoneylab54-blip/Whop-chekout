import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

export const FONTS = [
  "Inter",
  "DM Sans",
  "Manrope",
  "Poppins",
  "Montserrat",
  "Lato",
  "Nunito",
  "Playfair Display",
  "Lora",
  "System",
] as const;

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const optionalColor = color.or(z.literal("")).default("");
// http(s) only: these URLs end up in <img src> and <a href> on the checkout.
const url = z
  .string()
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v) && URL.canParse(v), "URL http(s) attendue")
  .or(z.literal(""));

/** Checkout languages (labels in components/checkout/i18n.ts). */
export const LANGUAGES = ["fr", "en", "de", "es", "it", "nl"] as const;
export type Language = (typeof LANGUAGES)[number];

export const themeSchema = z.object({
  language: z.enum(LANGUAGES).default("fr"),
  font: z.enum(FONTS).default("Inter"),
  headingFont: z.enum([...FONTS, "same"]).default("same"),
  fontScale: z.enum(["sm", "md", "lg"]).default("md"),
  radius: z.number().int().min(0).max(24).default(10),
  accentColor: color.default("#111827"),
  // second color: turns buttons into a gradient
  accentColor2: optionalColor,
  textColor: color.default("#111827"),
  borderColor: color.default("#d4d4d8"),
  buttonShape: z.enum(["default", "pill", "square"]).default("default"),
  buttonShadow: z.boolean().default(true),
  inputStyle: z.enum(["outlined", "filled", "underline"]).default("outlined"),
  headerBackground: color.default("#ffffff"),
  headerBorder: z.boolean().default(true),
  summarySide: z.enum(["right", "left"]).default("right"),
  summaryImages: z.boolean().default(true),
  contentWidth: z.enum(["narrow", "normal", "wide"]).default("normal"),
  pageBackground: optionalColor,
  formBackground: optionalColor,
  summaryBackground: color.or(z.literal("")).default("#f7f7f8"),
  storeName: z.string().max(80).default(""),
  showStoreName: z.boolean().default(true),
  headerAlign: z.enum(["left", "center", "right"]).default("center"),
  logoUrl: url.default(""),
  logoHeight: z.number().int().min(16).max(120).default(40),
  trustLine: z.string().max(200).default(""),
  // Apple Pay / Google Pay buttons at the top of the checkout
  expressCheckout: z.boolean().default(true),
  payButtonText: z.string().max(40).default(""),
  policyLinks: z.array(z.object({ label: z.string().max(60), url })).max(8).default([]),
  // --- EU consumer law ---
  // "J'accepte les CGV" checkbox before paying (proof kept for disputes)
  requireTerms: z.boolean().default(true),
  termsUrl: url.default(""),
  // "TVA incluse" under the total
  vatNote: z.string().max(60).default("TVA incluse"),
  // 14-day withdrawal right reminder on the thank-you page
  withdrawalNotice: z.boolean().default(true),
});
export type Theme = z.infer<typeof themeSchema>;

/**
 * Self-hosted stylesheet for a theme font (latin + latin-ext, 400–700, font-display: swap).
 * Files live in public/fonts: no request to Google Fonts from the checkout (GDPR).
 */
export function fontHref(font: Theme["font"]) {
  if (font === "System") return null;
  return `/fonts/${font.toLowerCase().replace(/\s+/g, "-")}.css`;
}

/** Stylesheets for the body font and, when different, the heading font. */
export function themeFontHrefs(theme: Pick<Theme, "font" | "headingFont">): string[] {
  const fonts = [fontHref(theme.font)];
  if (theme.headingFont !== "same" && theme.headingFont !== theme.font) fonts.push(fontHref(theme.headingFont));
  return fonts.filter((f): f is string => !!f);
}

/** Icon keys available in blocks (rendered with Lucide in src/components/icons.tsx). */
export const ICON_KEYS = [
  "shield",
  "truck",
  "lock",
  "heart",
  "check",
  "refresh",
  "star",
  "gift",
  "clock",
  "package",
  "sparkles",
  "leaf",
  "support",
  "card",
  "zap",
  "award",
  "thumbs",
  "users",
  "globe",
  "return",
] as const;
export type IconKey = (typeof ICON_KEYS)[number];
const iconKey = z.enum(ICON_KEYS);

/* ------------------------------------------------------------------ */
/* Block style (shared by every block)                                 */
/* ------------------------------------------------------------------ */

export const blockStyleSchema = z.object({
  spacing: z.enum(["default", "none", "sm", "md", "lg"]).default("default"),
  align: z.enum(["default", "left", "center", "right"]).default("default"),
  textSize: z.enum(["default", "sm", "md", "lg"]).default("default"),
  textColor: z.enum(["default", "muted", "brand", "white"]).default("default"),
  background: z.enum(["none", "light", "brand", "dark"]).default("none"),
  divider: z.enum(["none", "top", "bottom", "both"]).default("none"),
  card: z.boolean().default(false),
  customBackground: optionalColor,
  customText: optionalColor,
});
export type BlockStyle = z.infer<typeof blockStyleSchema>;

/* ------------------------------------------------------------------ */
/* Blocks                                                              */
/* ------------------------------------------------------------------ */

/**
 * Merchant translations of a block's texts: language → prop path ("title", "badges.0.label")
 * → text. Missing or empty = the base text (automatically translated when it is a shipped
 * default). Applied at render time for the buyer's language (components/checkout/localize.ts).
 */
export const MAX_TRANSLATED_FIELDS = 80;
export const blockTranslationsSchema = z.partialRecord(
  z.enum(LANGUAGES),
  z
    .record(z.string().max(80), z.string().max(2000))
    .refine((o) => Object.keys(o).length <= MAX_TRANSLATED_FIELDS, "Trop de traductions pour ce bloc"),
);
export type BlockTranslations = z.infer<typeof blockTranslationsSchema>;

const base = {
  id: z.string().min(1).max(40),
  i18n: blockTranslationsSchema.optional(),
  hidden: z.boolean().default(false),
  placement: z.enum(["form", "summary"]).default("form"),
  // thank-you page only
  position: z.enum(["above", "below"]).default("below"),
  style: blockStyleSchema.default(blockStyleSchema.parse({})),
};

const titled = z.object({ title: z.string().max(120).default("") });

/** Post-purchase offer targeting, checked against the paid order (amounts in major units). */
export const upsellConditionsSchema = z.object({
  minSubtotal: z.number().min(0).max(1_000_000).optional(),
  maxSubtotal: z.number().min(0).max(1_000_000).optional(),
  /** Shopify product GIDs: at least one must be in the order. */
  productIds: z.array(z.string().min(1).max(120)).max(50).default([]),
  /** ISO codes of the shipping country. */
  countries: z.array(z.string().length(2)).max(60).default([]),
  /** Shopify collection GIDs: at least one product of the order must be in one of them. */
  collectionIds: z.array(z.string().min(1).max(120)).max(20).optional(),
  /** Names of the chosen collections / variants (chips in the builder). */
  titles: z.record(z.string().max(120), z.string().max(160)).optional(),
  /** Shopify variant GIDs: at least one must be in the order. */
  variantIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  /** "new": first paid order on the store (by e-mail); "returning": at least one before. */
  customer: z.enum(["any", "new", "returning"]).optional(),
  /** Units bought (free gifts excluded). */
  minUnits: z.number().int().min(1).max(999).optional(),
  maxUnits: z.number().int().min(1).max(999).optional(),
});
export type UpsellConditions = z.infer<typeof upsellConditionsSchema>;

/** Units a buyer may take in one click. */
export const MAX_OFFER_QUANTITY = 10;
const offerPriceMode = z.enum(["fixed", "percent"]);

/** Arm B of an offer A/B test: its own product, price and texts. */
export const offerArmSchema = z.object({
  enabled: z.boolean().default(false),
  /** Share of visitors who see B, in %. */
  split: z.number().int().min(1).max(99).default(50),
  variantId: z.string().max(120).default(""),
  productId: z.string().max(120).optional(),
  imageUrl: url.default(""),
  badge: z.string().max(60).default(""),
  title: z.string().max(120).default(""),
  text: z.string().max(400).default(""),
  buttonText: z.string().max(60).default(""),
  priceMode: offerPriceMode.default("fixed"),
  price: z.number().min(0).max(100000).default(0),
  discountPercent: z.number().min(1).max(90).default(20),
  compareAt: z.number().min(0).max(100000).default(0),
  /** Stop the test and keep the winner automatically once it is significant (same rule as design tests). */
  autoPromote: z.boolean().optional(),
});
export type OfferArmProps = z.infer<typeof offerArmSchema>;

/** Post-purchase survey answers ("Comment nous avez-vous connu ?"). */
export const SURVEY_KEYS = ["facebook", "instagram", "tiktok", "google", "youtube", "friend", "other"] as const;
export type SurveyKey = (typeof SURVEY_KEYS)[number];
export const SURVEY_OTHER_MAX = 80;

/**
 * Validated survey answer: one of the keys, or "other:<free text>" (≤ 80 chars, trimmed,
 * control characters removed). `enabled` limits to the options the merchant shows. Null = invalid.
 */
export function normalizeSurveyAnswer(raw: unknown, enabled: readonly string[] = SURVEY_KEYS): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  const [key, ...rest] = value.split(":");
  if (!(SURVEY_KEYS as readonly string[]).includes(key) || !enabled.includes(key)) return null;
  if (rest.length === 0) return key;
  if (key !== "other") return null;
  const text = rest.join(":").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (text.length > SURVEY_OTHER_MAX) return null;
  return text ? `other:${text}` : "other";
}

/** Products of the "Complétez votre commande" block. */
export const MAX_RECOMMENDATIONS = 4;

/**
 * Shopify variant GID from what a merchant may paste (GID, numeric id, admin URL
 * …/variants/123), or null when it isn't one. Pure.
 */
export function variantGidOf(raw: string): string | null {
  const t = raw.trim();
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(t)) return t;
  const n = /^\d{1,20}$/.test(t) ? t : (/\/variants\/(\d{1,20})(?:\D*)$/.exec(t)?.[1] ?? null);
  return n ? `gid://shopify/ProductVariant/${n}` : null;
}

export const blockSchema = z.discriminatedUnion("type", [
  // Fixed checkout sections: reorderable, never removable.
  z.object({
    ...base,
    type: z.literal("express"),
    // Apple Pay / Google Pay area. `enabled` hides it without removing the section.
    props: z
      .object({ enabled: z.boolean().default(true), title: z.string().max(120).default(""), dividerLabel: z.string().max(40).default("") })
      .default({ enabled: true, title: "", dividerLabel: "" }),
  }),
  z.object({ ...base, type: z.literal("contact"), props: titled.default({ title: "" }) }),
  z.object({ ...base, type: z.literal("delivery"), props: titled.default({ title: "" }) }),
  z.object({ ...base, type: z.literal("shipping_method"), props: titled.default({ title: "" }) }),
  z.object({ ...base, type: z.literal("payment"), props: titled.default({ title: "" }) }),

  // Fixed thank-you sections: reorderable, never removable.
  z.object({ ...base, type: z.literal("ty_confirmation"), props: titled.default({ title: "" }) }),
  z.object({ ...base, type: z.literal("ty_details"), props: titled.default({ title: "" }) }),
  z.object({ ...base, type: z.literal("ty_summary"), props: titled.default({ title: "" }) }),

  z.object({ ...base, type: z.literal("order_addons"), props: titled.default({ title: "" }) }),
  z.object({
    ...base,
    type: z.literal("text"),
    props: z.object({ heading: z.string().max(200), body: z.string().max(2000) }),
  }),
  z.object({
    ...base,
    type: z.literal("image"),
    props: z.object({
      url,
      alt: z.string().max(200),
      size: z.enum(["sm", "md", "lg", "full"]).default("full"),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("testimonial"),
    props: z.object({
      quote: z.string().max(1000),
      author: z.string().max(100),
      photoUrl: url,
      stars: z.number().int().min(1).max(5),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("rating"),
    props: z.object({
      /** null until the merchant enters their real score: the block stays off the live checkout. */
      score: z.number().min(0).max(5).nullable(),
      count: z.number().int().min(0),
      label: z.string().max(120),
      /** Set once the merchant typed a score (tells a real 4.8 from the old invented default). */
      scoreSet: z.boolean().optional(),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("trust_badges"),
    props: z.object({
      badges: z.array(z.object({ label: z.string().max(60), iconUrl: url })).max(8),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("guarantee"),
    props: z.object({ title: z.string().max(120), text: z.string().max(1000) }),
  }),
  z.object({
    ...base,
    type: z.literal("faq"),
    props: z.object({ items: z.array(z.object({ q: z.string().max(200), a: z.string().max(2000) })).max(20) }),
  }),
  z.object({
    ...base,
    type: z.literal("value_props"),
    // icon: an IconKey (legacy layouts may still hold an emoji, rendered as text)
    props: z.object({ items: z.array(z.object({ icon: z.string().max(16), label: z.string().max(80) })).max(8) }),
  }),
  z.object({
    ...base,
    type: z.literal("payment_icons"),
    props: z.object({
      label: z.string().max(80),
      methods: z.array(z.enum(["visa", "mastercard", "amex", "applepay", "gpay", "sepa", "crypto"])).max(8),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("announcement"),
    props: z.object({ text: z.string().max(300) }),
  }),
  z.object({
    ...base,
    type: z.literal("countdown"),
    // A real end date: the block hides itself once it has passed. No fake evergreen timers.
    props: z.object({ label: z.string().max(200), endsAt: z.string().max(40) }),
  }),
  z.object({
    ...base,
    type: z.literal("low_stock"),
    // Shown only when real Shopify inventory of a cart item is at or below the threshold.
    props: z.object({ message: z.string().max(200), threshold: z.number().int().min(1).max(100) }),
  }),
  z.object({
    ...base,
    type: z.literal("why_us"),
    props: z.object({
      title: z.string().max(120),
      rows: z
        .array(
          z.object({
            icon: iconKey,
            title: z.string().max(80),
            text: z.string().max(300),
          }),
        )
        .max(8),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("free_shipping_bar"),
    // threshold in major units; 0 = use the lowest "free over" of the shipping rates
    props: z.object({ message: z.string().max(200), success: z.string().max(200), threshold: z.number().min(0).max(100000) }),
  }),
  z.object({
    ...base,
    type: z.literal("delivery_estimate"),
    props: z.object({
      label: z.string().max(120),
      minDays: z.number().int().min(0).max(60),
      maxDays: z.number().int().min(0).max(90),
      businessDays: z.boolean(),
      showTimeline: z.boolean(),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("reviews"),
    props: z.object({
      title: z.string().max(120),
      layout: z.enum(["carousel", "stack"]),
      items: z
        .array(z.object({ name: z.string().max(80), text: z.string().max(800), stars: z.number().int().min(1).max(5), verified: z.boolean() }))
        .max(20),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("comparison"),
    props: z.object({
      title: z.string().max(120),
      usLabel: z.string().max(40),
      themLabel: z.string().max(40),
      rows: z.array(z.object({ label: z.string().max(80), us: z.boolean(), them: z.boolean() })).max(12),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("video"),
    props: z.object({ url, caption: z.string().max(200) }),
  }),
  z.object({
    ...base,
    type: z.literal("logos"),
    props: z.object({ title: z.string().max(120), logos: z.array(z.object({ imageUrl: url, alt: z.string().max(80) })).max(10) }),
  }),
  z.object({
    ...base,
    type: z.literal("stats"),
    props: z.object({ items: z.array(z.object({ value: z.string().max(20), label: z.string().max(60) })).max(4) }),
  }),
  z.object({
    ...base,
    type: z.literal("benefits"),
    props: z.object({
      title: z.string().max(120),
      columns: z.union([z.literal(2), z.literal(3)]),
      items: z.array(z.object({ icon: iconKey, title: z.string().max(80), text: z.string().max(200) })).max(9),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("secure_badge"),
    props: z.object({ text: z.string().max(120), subtext: z.string().max(160) }),
  }),
  z.object({
    ...base,
    type: z.literal("order_note"),
    // Buyer's free text, copied into the Shopify order note
    props: z.object({ title: z.string().max(120), placeholder: z.string().max(160) }),
  }),
  z.object({
    ...base,
    type: z.literal("support"),
    props: z.object({
      title: z.string().max(120),
      text: z.string().max(300),
      email: z.string().max(120),
      phone: z.string().max(40),
      whatsapp: z.string().max(40),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("spacer"),
    props: z.object({ size: z.number().int().min(4).max(120), line: z.boolean() }),
  }),
  z.object({
    ...base,
    type: z.literal("button_link"),
    props: z.object({ label: z.string().max(60), url, variant: z.enum(["solid", "outline"]) }),
  }),
  z.object({
    ...base,
    type: z.literal("coupon"),
    props: z.object({ title: z.string().max(120), text: z.string().max(300), code: z.string().max(40) }),
  }),
  z.object({
    ...base,
    type: z.literal("upsell"),
    // One-click post-purchase offer, charged on the card saved during checkout
    props: z.object({
      badge: z.string().max(60),
      title: z.string().max(120),
      text: z.string().max(400),
      variantId: z.string().max(120),
      // Shopify product of the variant (filled by the picker): "exclude if already bought".
      productId: z.string().max(120).optional(),
      // "auto": the product most often bought with this order's products (past paid orders),
      // at discountPercent off its live price; "manual" (default): variantId.
      productSource: z.enum(["manual", "auto"]).optional(),
      imageUrl: url,
      // "fixed": `price`; "percent": `discountPercent` off the live Shopify price (priced at accept time).
      priceMode: offerPriceMode.default("fixed"),
      price: z.number().min(0).max(100000),
      discountPercent: z.number().min(1).max(90).default(20),
      compareAt: z.number().min(0).max(100000),
      buttonText: z.string().max(60),
      declineText: z.string().max(60),
      // Targeting: shown only when the paid order matches (empty = always).
      conditions: upsellConditionsSchema.default({ productIds: [], countries: [] }),
      // Hidden when the offered product is already in the paid order.
      excludePurchased: z.boolean().default(false),
      // Upsell block offered after "No thanks" (downsell). Empty = none.
      declineNextId: z.string().max(40).optional(),
      // Upsell block offered after "Yes" (next step of the funnel). Empty = none.
      acceptNextId: z.string().max(40).optional(),
      // The buyer may take up to this many units (quantity selector when > 1).
      maxQuantity: z.number().int().min(1).max(MAX_OFFER_QUANTITY).default(1),
      // Offer-level A/B test: `split` % of visitors see arm B (sticky per visitor).
      variantB: offerArmSchema.optional(),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("recommendations"),
    // "Complétez votre commande": 1-4 Shopify variants added to the cart in one tap
    // (priced live by Shopify on the checkout page; title "" = translated default).
    props: z.object({
      title: z.string().max(120).default(""),
      items: z
        .array(z.object({ variantId: z.string().max(120), title: z.string().max(120).default(""), imageUrl: url.default("") }))
        .max(MAX_RECOMMENDATIONS)
        .default([]),
      hideIfInCart: z.boolean().default(true),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("shipping_protection"),
    // Paid parcel protection (loss, theft, damage), an order line priced server-side.
    props: z.object({
      title: z.string().max(120).default(""),
      text: z.string().max(300).default(""),
      priceMode: offerPriceMode.default("fixed"),
      price: z.number().min(0).max(1000).default(2.9),
      percent: z.number().min(0).max(50).default(3),
      minPrice: z.number().min(0).max(1000).default(1.9),
      // 0 = no maximum
      maxPrice: z.number().min(0).max(1000).default(0),
      // EU consumer law: extra paid options must not be pre-ticked (default off).
      defaultOn: z.boolean().default(false),
      // Shown on the thank-you page ("Colis protégé").
      claimText: z.string().max(600).default(""),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("survey"),
    // Thank-you page: "Comment nous avez-vous connu ?" (one tap, stored on the order).
    props: z.object({
      question: z.string().max(160).default(""),
      options: z.array(z.enum(SURVEY_KEYS)).max(SURVEY_KEYS.length).default([...SURVEY_KEYS]),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("social"),
    props: z.object({
      title: z.string().max(120),
      instagram: url,
      tiktok: url,
      facebook: url,
      youtube: url,
    }),
  }),
]);

export type Block = z.infer<typeof blockSchema>;
export type BlockType = Block["type"];
export type BlockOf<T extends BlockType> = Extract<Block, { type: T }>;

export const FIXED_CHECKOUT_BLOCKS = ["express", "contact", "delivery", "shipping_method", "payment"] as const;
export function isFixed(type: BlockType): boolean {
  return (FIXED_CHECKOUT_BLOCKS as readonly string[]).includes(type);
}

/** Built-in sections of the thank-you page, in their default order. */
export const FIXED_THANK_YOU_BLOCKS = ["ty_confirmation", "ty_details", "ty_summary"] as const;
export function isFixedThankYou(type: BlockType): boolean {
  return (FIXED_THANK_YOU_BLOCKS as readonly string[]).includes(type);
}
/** Fixed section of either page: reorderable, never removed or duplicated. */
export function isFixedSection(type: BlockType): boolean {
  return isFixed(type) || isFixedThankYou(type);
}

/** Blocks that can be added from the palette, per page. */
/**
 * Widgets that make no sense twice on one page (a second free-shipping bar or
 * reviews carousel only pushes the payment down). Duplicates are dropped on load
 * and the builder refuses to add them.
 */
export const SINGLETON_BLOCKS: ReadonlySet<BlockType> = new Set<BlockType>([
  "announcement",
  "countdown",
  "free_shipping_bar",
  "delivery_estimate",
  "low_stock",
  "order_note",
  "secure_badge",
  "payment_icons",
  "comparison",
  "why_us",
  "stats",
  "reviews",
  "guarantee",
  "benefits",
  "trust_badges",
  "coupon",
  "order_addons",
  "recommendations",
  "shipping_protection",
  "survey",
]);

/** Keeps the first block of each singleton type. */
export function dedupeSingletons(blocks: Block[]): Block[] {
  return blocks.filter((b, i, all) => !SINGLETON_BLOCKS.has(b.type) || all.findIndex((x) => x.type === b.type) === i);
}

export const CHECKOUT_PALETTE: BlockType[] = [
  "order_addons",
  "recommendations",
  "shipping_protection",
  "free_shipping_bar",
  "delivery_estimate",
  "order_note",
  "secure_badge",
  "reviews",
  "benefits",
  "comparison",
  "stats",
  "logos",
  "video",
  "support",
  "spacer",
  "announcement",
  "text",
  "image",
  "testimonial",
  "rating",
  "trust_badges",
  "guarantee",
  "faq",
  "value_props",
  "payment_icons",
  "countdown",
  "low_stock",
  "why_us",
];
export const THANK_YOU_PALETTE: BlockType[] = [
  "upsell",
  "survey",
  "coupon",
  "button_link",
  "social",
  "delivery_estimate",
  "reviews",
  "benefits",
  "stats",
  "video",
  "support",
  "spacer",
  "text",
  "image",
  "testimonial",
  "rating",
  "trust_badges",
  "guarantee",
  "faq",
  "value_props",
  "why_us",
];

/** Blocks that only make sense on one page. */
const CHECKOUT_ONLY: ReadonlySet<BlockType> = new Set<BlockType>(["order_addons", "order_note", "recommendations", "shipping_protection"]);
const THANK_YOU_ONLY: ReadonlySet<BlockType> = new Set<BlockType>(["survey"]);

export const layoutSchema = z.object({ blocks: z.array(blockSchema).max(40) });
export type Layout = z.infer<typeof layoutSchema>;

/** Checkout layouts must contain every fixed section exactly once. */
export const checkoutLayoutSchema = layoutSchema
  .refine((l) => FIXED_CHECKOUT_BLOCKS.every((t) => l.blocks.filter((b) => b.type === t).length === 1), {
    message: "Paiement express, Contact, Livraison, Méthode de livraison et Paiement sont obligatoires",
  })
  .refine((l) => l.blocks.every((b) => !isFixedThankYou(b.type) && !THANK_YOU_ONLY.has(b.type)), {
    message: "Les sections de la page de remerciement ne peuvent pas être sur le checkout",
  });
export const thankYouLayoutSchema = layoutSchema
  .refine((l) => l.blocks.every((b) => !isFixed(b.type) && (b.type === "order_addons" || !CHECKOUT_ONLY.has(b.type))), {
    message: "Les sections du checkout ne peuvent pas être sur la page de remerciement",
  })
  .refine((l) => FIXED_THANK_YOU_BLOCKS.every((t) => l.blocks.filter((b) => b.type === t).length <= 1), {
    message: "Chaque section de la page de remerciement ne peut apparaître qu'une fois",
  });

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export function newBlockId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const DEFAULT_PROPS: { [T in BlockType]: BlockOf<T>["props"] } = {
  express: { enabled: true, title: "", dividerLabel: "" },
  contact: { title: "" },
  delivery: { title: "" },
  shipping_method: { title: "" },
  payment: { title: "" },
  ty_confirmation: { title: "" },
  ty_details: { title: "" },
  ty_summary: { title: "" },
  order_addons: { title: "" },
  text: { heading: "Titre", body: "Votre texte ici." },
  image: { url: "", alt: "", size: "full" },
  testimonial: {
    quote: "Livraison rapide et produit conforme, je recommande.",
    author: "Client vérifié",
    photoUrl: "",
    stars: 5,
  },
  rating: { score: null, count: 0, label: "note moyenne de nos clients" },
  trust_badges: {
    badges: [
      { label: "Paiement sécurisé", iconUrl: "" },
      { label: "Satisfait ou remboursé 30 jours", iconUrl: "" },
      { label: "Retours faciles", iconUrl: "" },
    ],
  },
  guarantee: {
    title: "Satisfait ou remboursé",
    text: "Pas satisfait ? Retournez le produit sous 30 jours et on vous rembourse.",
  },
  faq: {
    items: [
      { q: "Quand vais-je recevoir ma commande ?", a: "Les commandes partent sous 24 à 48 h ouvrées." },
      { q: "Puis-je retourner mon produit ?", a: "Oui, vous avez 30 jours pour changer d'avis." },
    ],
  },
  value_props: {
    items: [
      { icon: "truck", label: "Livraison offerte" },
      { icon: "return", label: "Retours faciles" },
      { icon: "lock", label: "Paiement sécurisé" },
    ],
  },
  payment_icons: { label: "Moyens de paiement acceptés", methods: ["visa", "mastercard", "amex", "applepay", "gpay"] },
  announcement: { text: "Livraison offerte dès 50 € d'achat" },
  countdown: { label: "L'offre se termine dans :", endsAt: "" },
  low_stock: { message: "Plus que {n} en stock", threshold: 10 },
  why_us: {
    title: "Pourquoi nous ?",
    rows: [
      { icon: "shield", title: "Garantie 30 jours", text: "Remboursé si vous n'êtes pas satisfait." },
      { icon: "truck", title: "Expédition rapide", text: "Préparée et expédiée sous 48 h." },
      { icon: "lock", title: "Paiement sécurisé", text: "Transactions chiffrées de bout en bout." },
    ],
  },
  free_shipping_bar: {
    message: "Plus que {amount} pour profiter de la livraison offerte",
    success: "Bravo, la livraison est offerte !",
    threshold: 0,
  },
  delivery_estimate: { label: "Livraison estimée", minDays: 3, maxDays: 5, businessDays: true, showTimeline: true },
  reviews: {
    title: "Ce que disent nos clients",
    layout: "carousel",
    items: [
      { name: "Camille R.", text: "Commande reçue en 3 jours, qualité au top. Je recommande !", stars: 5, verified: true },
      { name: "Yanis B.", text: "Service client réactif et produit conforme aux photos.", stars: 5, verified: true },
    ],
  },
  comparison: {
    title: "Pourquoi nous choisir",
    usLabel: "Nous",
    themLabel: "Les autres",
    rows: [
      { label: "Livraison offerte", us: true, them: false },
      { label: "Satisfait ou remboursé 30 jours", us: true, them: false },
      { label: "Service client 7j/7", us: true, them: true },
    ],
  },
  video: { url: "", caption: "" },
  logos: { title: "Ils parlent de nous", logos: [] },
  stats: {
    items: [
      { value: "+10 000", label: "clients satisfaits" },
      { value: "4,8/5", label: "note moyenne" },
      { value: "48 h", label: "expédition" },
    ],
  },
  benefits: {
    title: "",
    columns: 3,
    items: [
      { icon: "truck", title: "Livraison rapide", text: "Expédiée sous 48 h" },
      { icon: "shield", title: "Garantie 30 jours", text: "Satisfait ou remboursé" },
      { icon: "support", title: "Support 7j/7", text: "Une vraie équipe à l'écoute" },
    ],
  },
  secure_badge: { text: "Paiement 100 % sécurisé", subtext: "Vos données sont chiffrées et ne sont jamais stockées." },
  order_note: { title: "Une précision sur votre commande ?", placeholder: "Instructions de livraison, message cadeau…" },
  support: { title: "Besoin d'aide ?", text: "Notre équipe vous répond en moins de 24 h.", email: "", phone: "", whatsapp: "" },
  spacer: { size: 24, line: false },
  button_link: { label: "Continuer mes achats", url: "", variant: "solid" },
  coupon: { title: "Merci ! Voici un cadeau", text: "Profitez de -10 % sur votre prochaine commande.", code: "MERCI10" },
  recommendations: { title: "", items: [], hideIfInCart: true },
  social: { title: "Suivez-nous", instagram: "", tiktok: "", facebook: "", youtube: "" },
  upsell: {
    badge: "Offre réservée à votre commande",
    title: "Ajoutez-le à votre colis",
    text: "Expédié avec votre commande, sans frais de livraison supplémentaires. Un clic, sans ressaisir votre carte.",
    variantId: "",
    imageUrl: "",
    priceMode: "fixed",
    price: 19.9,
    discountPercent: 20,
    compareAt: 29.9,
    buttonText: "Oui, ajouter à ma commande",
    declineText: "Non merci",
    conditions: { productIds: [], countries: [] },
    excludePurchased: false,
    maxQuantity: 1,
  },
  shipping_protection: {
    title: "",
    text: "",
    priceMode: "fixed",
    price: 2.9,
    percent: 3,
    minPrice: 1.9,
    maxPrice: 0,
    defaultOn: false,
    claimText: "Colis perdu, volé ou abîmé ? Écrivez-nous dans les 14 jours suivant la livraison prévue avec votre numéro de commande (et une photo en cas de casse) : nous le renvoyons ou vous remboursons.",
  },
  survey: { question: "", options: [...SURVEY_KEYS] },
};

/** Where a new block goes by default: cross-sell cards sit in the summary, the rest in the form. */
const DEFAULT_PLACEMENT: Partial<Record<BlockType, Block["placement"]>> = { recommendations: "summary" };

export function createBlock<T extends BlockType>(type: T, overrides: Partial<Block> = {}): BlockOf<T> {
  return blockSchema.parse({
    id: newBlockId(),
    type,
    props: structuredClone(DEFAULT_PROPS[type]),
    ...(DEFAULT_PLACEMENT[type] ? { placement: DEFAULT_PLACEMENT[type] } : {}),
    ...overrides,
  }) as BlockOf<T>;
}

/**
 * Block added by a loader or a default layout. Its id is the type (these blocks exist once
 * per page), so loading the same saved data twice gives the same layout: the builder can
 * tell a real edit from a normalisation.
 */
function builtInBlock<T extends BlockType>(type: T, overrides: Partial<Block> = {}): BlockOf<T> {
  return createBlock(type, { ...overrides, id: type });
}

export function defaultCheckoutLayout(): Layout {
  return {
    blocks: [
      builtInBlock("express"),
      builtInBlock("contact"),
      builtInBlock("delivery"),
      builtInBlock("shipping_method"),
      builtInBlock("order_addons"),
      builtInBlock("payment"),
      builtInBlock("trust_badges", { placement: "summary" }),
    ],
  };
}

export function defaultThankYouLayout(): Layout {
  return { blocks: FIXED_THANK_YOU_BLOCKS.map((t) => builtInBlock(t)) };
}

export function defaultTheme(storeName = ""): Theme {
  return themeSchema.parse({ storeName });
}

/* ------------------------------------------------------------------ */
/* Safe loaders (DB JSON -> typed, never throws)                       */
/* ------------------------------------------------------------------ */

/**
 * Parses an object, dropping only the fields that fail instead of rejecting everything,
 * so one outdated value never wipes a whole saved design.
 */
function lenientObject<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> | null {
  let value: Record<string, unknown> = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
  for (let i = 0; i < 20; i++) {
    const parsed = schema.safeParse(value);
    if (parsed.success) return parsed.data;
    const bad = new Set(parsed.error.issues.map((issue) => issue.path[0]).filter((k): k is string => typeof k === "string"));
    if (bad.size === 0) return null;
    value = Object.fromEntries(Object.entries(value).filter(([k]) => !bad.has(k)));
  }
  return null;
}

export function loadTheme(raw: unknown, storeName = ""): Theme {
  const theme = lenientObject(themeSchema, raw) ?? defaultTheme(storeName);
  // Until a name is set in the builder, show the store's own name.
  return theme.storeName ? theme : { ...theme, storeName };
}

/* ---------- "Note globale" (rating) block ---------- */

/** The score new rating blocks used to get before scores became opt-in (an invented 4.8). */
export const LEGACY_RATING_DEFAULT_SCORE = 4.8;

/**
 * Old layouts: a rating block still carrying the invented default (4.8 with 0 reviews, never
 * edited) is treated as "not filled in yet" instead of showing a made-up score to buyers.
 * Any other value, a review count, or a score the merchant typed (scoreSet) is kept as is.
 */
export function migrateRatingProps(props: BlockOf<"rating">["props"]): BlockOf<"rating">["props"] {
  if (props.score === LEGACY_RATING_DEFAULT_SCORE && props.count === 0 && !props.scoreSet) return { ...props, score: null };
  return props;
}

/** True once the block has a real score to show (1 to 5: a 0 is "no rating", never shown to buyers). */
export function ratingIsSet(props: BlockOf<"rating">["props"]): props is BlockOf<"rating">["props"] & { score: number } {
  return typeof props.score === "number" && Number.isFinite(props.score) && props.score >= 1;
}

/** "4,8" (fr), "4.8" (en), "4,8" (de): one decimal in the buyer's locale. */
export function formatRatingScore(score: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(score);
}

function migrateBlock(b: Block): Block {
  return b.type === "rating" ? { ...b, props: migrateRatingProps(b.props) } : b;
}

/** Keeps every valid block (repairing props/style when possible) and drops only broken ones. */
function loadBlocks(raw: unknown): Block[] {
  return loadRawBlocks(raw).map(migrateBlock);
}

function loadRawBlocks(raw: unknown): Block[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { blocks?: unknown }).blocks) ? (raw as { blocks: unknown[] }).blocks : [];
  const blocks: Block[] = [];
  for (const item of list.slice(0, 40)) {
    const direct = blockSchema.safeParse(item);
    if (direct.success) {
      blocks.push(direct.data);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const b = item as Record<string, unknown>;
    const type = b.type as BlockType;
    if (!(type in DEFAULT_PROPS)) continue;
    const props = { ...structuredClone(DEFAULT_PROPS[type]), ...(typeof b.props === "object" && b.props ? b.props : {}) };
    const repaired =
      blockSchema.safeParse({ ...b, props }).data ??
      blockSchema.safeParse({ ...b, props, style: undefined }).data ??
      blockSchema.safeParse({ id: b.id ?? newBlockId(), type, hidden: b.hidden, placement: b.placement, position: b.position, props: DEFAULT_PROPS[type] }).data;
    if (repaired) blocks.push(repaired);
  }
  return blocks;
}

export function loadCheckoutLayout(raw: unknown): Layout {
  if (raw == null) return defaultCheckoutLayout();
  // Fixed sections and the order-bump list exist at most once.
  const single = (t: Block["type"]) => isFixed(t) || t === "order_addons";
  const blocks = dedupeSingletons(loadBlocks(raw))
    .filter((b) => !isFixedThankYou(b.type) && !THANK_YOU_ONLY.has(b.type))
    .filter((b, i, all) => !single(b.type) || all.findIndex((x) => x.type === b.type) === i);
  // Every fixed section must exist exactly once: re-add missing ones before "payment".
  for (const type of FIXED_CHECKOUT_BLOCKS) {
    if (type === "express" || blocks.some((b) => b.type === type)) continue;
    const pay = blocks.findIndex((b) => b.type === "payment");
    blocks.splice(type === "payment" || pay < 0 ? blocks.length : pay, 0, builtInBlock(type));
  }
  // Layouts saved before the express section existed: it sat at the top of Contact.
  if (!blocks.some((b) => b.type === "express")) {
    blocks.splice(Math.max(0, blocks.findIndex((b) => b.type === "contact")), 0, builtInBlock("express"));
  }
  return { blocks };
}

export function loadThankYouLayout(raw: unknown): Layout {
  if (raw == null) return defaultThankYouLayout();
  const blocks = dedupeSingletons(loadBlocks(raw))
    .filter((b) => !isFixed(b.type) && !CHECKOUT_ONLY.has(b.type))
    .filter((b, i, all) => !isFixedThankYou(b.type) || all.findIndex((x) => x.type === b.type) === i);
  const missing = FIXED_THANK_YOU_BLOCKS.filter((t) => !blocks.some((b) => b.type === t));
  if (missing.length === FIXED_THANK_YOU_BLOCKS.length) {
    // Layouts saved before the sections were blocks: "above" blocks, the sections, then "below".
    const above = blocks.filter((b) => b.position === "above");
    const below = blocks.filter((b) => b.position !== "above");
    return { blocks: [...above, ...missing.map((t) => builtInBlock(t)), ...below] };
  }
  // Some sections present: re-add each missing one right after its predecessor (or before its successor).
  for (const type of missing) {
    const order = FIXED_THANK_YOU_BLOCKS.indexOf(type);
    const prev = FIXED_THANK_YOU_BLOCKS.slice(0, order).reverse().map((t) => blocks.findIndex((b) => b.type === t)).find((i) => i >= 0);
    const next = FIXED_THANK_YOU_BLOCKS.slice(order + 1).map((t) => blocks.findIndex((b) => b.type === t)).find((i) => i >= 0);
    blocks.splice(prev != null ? prev + 1 : (next ?? blocks.length), 0, builtInBlock(type));
  }
  return { blocks };
}

/* ------------------------------------------------------------------ */
/* Post-purchase funnels: "Yes" → acceptNextId, "No thanks" → declineNextId */
/* ------------------------------------------------------------------ */

/** Offers one buyer can see in a row in one slot (the root and two follow-ups). */
export const MAX_OFFER_DEPTH = 3;

type UpsellLike = { id: string; type: string; props: object };
const declineOf = (b: UpsellLike) => (b.props as { declineNextId?: string }).declineNextId || undefined;
const acceptOf = (b: UpsellLike) => (b.props as { acceptNextId?: string }).acceptNextId || undefined;
const answered = (s: string | undefined) => s === "PAID" || s === "PENDING";

function upsellsOf<B extends UpsellLike>(blocks: readonly B[]) {
  return blocks.filter((b) => b.type === "upsell");
}

/** Ids of offers that follow another one (after a "Yes" or a "No thanks"): they never open a slot. */
export function downsellTargets(blocks: readonly UpsellLike[]): Set<string> {
  const ups = upsellsOf(blocks);
  const ids = new Set(ups.map((b) => b.id));
  const targets = new Set<string>();
  for (const b of ups) {
    for (const next of [declineOf(b), acceptOf(b)]) if (next && next !== b.id && ids.has(next)) targets.add(next);
  }
  return targets;
}

/** Offers that open a chain (shown first, in their own slot on the page). */
export function upsellRoots<B extends UpsellLike>(blocks: readonly B[]): B[] {
  const targets = downsellTargets(blocks);
  return upsellsOf(blocks).filter((b) => !targets.has(b.id));
}

/**
 * Walk of the slot opened by `rootId`: offers already accepted on the way (their
 * confirmation stays), and the offer now waiting for an answer. After "Yes" the funnel
 * goes to `acceptNextId`, after "No thanks" to `declineNextId`; cycle-safe, at most
 * MAX_OFFER_DEPTH offers. `ok` says whether an offer may be shown to this buyer.
 */
export function offerTrail(
  blocks: readonly UpsellLike[],
  rootId: string,
  states: Readonly<Record<string, string | undefined>>,
  ok: (id: string) => boolean,
): { accepted: string[]; current: string | null } {
  const byId = new Map(upsellsOf(blocks).map((b) => [b.id, b]));
  const seen = new Set<string>();
  const accepted: string[] = [];
  let id: string | undefined = rootId;
  while (id && !seen.has(id) && seen.size < MAX_OFFER_DEPTH) {
    seen.add(id);
    const block = byId.get(id);
    if (!block || !ok(id)) break;
    const state = states[id];
    if (state === "DECLINED") id = declineOf(block);
    else if (answered(state)) {
      accepted.push(id);
      id = acceptOf(block);
    } else return { accepted, current: id };
  }
  return { accepted, current: null };
}

/**
 * The offer to show in the slot of `rootId`: the one waiting for an answer, else the last
 * accepted one (its confirmation). Null = nothing left to show in this slot.
 */
export function currentOffer(
  blocks: readonly UpsellLike[],
  rootId: string,
  states: Readonly<Record<string, string | undefined>>,
  ok: (id: string) => boolean,
): string | null {
  const trail = offerTrail(blocks, rootId, states, ok);
  return trail.current ?? trail.accepted.at(-1) ?? null;
}

/** True when `id` may be offered right now: it is the current offer of one of the chains. */
export function offerReachable(
  blocks: readonly UpsellLike[],
  id: string,
  states: Readonly<Record<string, string | undefined>>,
  ok: (id: string) => boolean,
): boolean {
  return upsellRoots(blocks).some((root) => currentOffer(blocks, root.id, states, ok) === id);
}

/** Would pointing one of `fromId`'s next offers at `nextId` loop back to `fromId` (through either answer)? */
export function downsellCycle(blocks: readonly UpsellLike[], fromId: string, nextId: string): boolean {
  const byId = new Map(upsellsOf(blocks).map((b) => [b.id, b]));
  const seen = new Set<string>();
  const queue = [nextId];
  while (queue.length) {
    const id = queue.shift()!;
    if (id === fromId) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    const b = byId.get(id);
    if (b) queue.push(...[declineOf(b), acceptOf(b)].filter((x): x is string => !!x));
  }
  return false;
}

/** Longest run of offers from `id` (itself included), cycle-safe: above MAX_OFFER_DEPTH the tail is never shown. */
export function funnelDepth(blocks: readonly UpsellLike[], id: string, seen: ReadonlySet<string> = new Set()): number {
  const b = upsellsOf(blocks).find((x) => x.id === id);
  if (!b || seen.has(id)) return 0;
  const next = new Set(seen).add(id);
  return 1 + Math.max(0, ...[declineOf(b), acceptOf(b)].filter((x): x is string => !!x).map((n) => funnelDepth(blocks, n, next)));
}

/* ---------- Offer arms (A/B) and prices, shared by the server and the thank-you page ---------- */

export type OfferArm = "A" | "B";
type OfferPropsLike = { variantId: string; priceMode?: "fixed" | "percent"; price: number; discountPercent?: number; productSource?: "manual" | "auto" };

/**
 * A variant and a price are set (percent mode: priced live by Shopify). An "automatique" offer
 * picks its product per order: only a percent off the live price makes sense for it.
 */
export function upsellSellable(p: OfferPropsLike): boolean {
  if (p.productSource === "auto") return (p.priceMode ?? "fixed") === "percent" && (p.discountPercent ?? 0) > 0;
  if (!p.variantId.trim()) return false;
  return (p.priceMode ?? "fixed") === "percent" ? (p.discountPercent ?? 0) > 0 : p.price > 0;
}

/** Arm B is tested: enabled and sellable. */
export function offerHasB(block: Pick<BlockOf<"upsell">, "props">): boolean {
  const b = block.props.variantB;
  return !!b?.enabled && upsellSellable(b);
}

/** Props of the arm a visitor sees (B overrides product, price and texts; empty texts fall back to A). */
export function offerArmProps(block: Pick<BlockOf<"upsell">, "props">, arm: OfferArm): BlockOf<"upsell">["props"] {
  const p = block.props;
  const b = p.variantB;
  if (arm === "A" || !b || !offerHasB(block)) return p;
  return {
    ...p,
    // Arm B always offers its own chosen product (never the automatic pick of A).
    productSource: "manual",
    variantId: b.variantId,
    productId: b.productId,
    imageUrl: b.imageUrl,
    badge: b.badge || p.badge,
    title: b.title || p.title,
    text: b.text || p.text,
    buttonText: b.buttonText || p.buttonText,
    priceMode: b.priceMode,
    price: b.price,
    discountPercent: b.discountPercent,
    compareAt: b.compareAt,
  };
}

/** Key of an arm in upsellShownBlocks / UpsellCharge.blockId: "<id>" for A, "<id>:B" for B. */
export const armKey = (blockId: string, arm: OfferArm) => (arm === "B" ? `${blockId}:B` : blockId);
export function parseArmKey(key: string): { blockId: string; arm: OfferArm } {
  return key.endsWith(":B") ? { blockId: key.slice(0, -2), arm: "B" } : { blockId: key, arm: "A" };
}

/**
 * Unit price in cents: the fixed price, or `discountPercent` off the live Shopify price
 * (null when that price is unknown: never a made-up amount).
 */
export function offerUnitCents(p: OfferPropsLike, liveUnitCents: number | null | undefined): number | null {
  if ((p.priceMode ?? "fixed") === "fixed") return Math.round(p.price * 100);
  if (liveUnitCents == null || liveUnitCents <= 0) return null;
  const pct = Math.min(90, Math.max(1, p.discountPercent ?? 0));
  return Math.max(1, Math.round((liveUnitCents * (100 - pct)) / 100));
}

/* ------------------------------------------------------------------ */
/* Interception settings (read by the storefront loader)               */
/* ------------------------------------------------------------------ */

export const interceptionSchema = z.object({
  cartCheckout: z.boolean().default(true),
  cartDrawer: z.boolean().default(true),
  buyNow: z.boolean().default(true),
  addToCartDirect: z.boolean().default(false),
  customSelectors: z.string().max(1000).default(""),
  // Shopify product handles that keep the native checkout
  excludedHandles: z.array(z.string().max(255)).max(200).default([]),
});
export type Interception = z.infer<typeof interceptionSchema>;

export function loadInterception(raw: unknown): Interception {
  const parsed = interceptionSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : interceptionSchema.parse({});
}
