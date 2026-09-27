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

export const themeSchema = z.object({
  language: z.enum(["fr", "en"]).default("fr"),
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
});
export type Theme = z.infer<typeof themeSchema>;

export function fontHref(font: Theme["font"]) {
  if (font === "System") return null;
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font)}:wght@400;500;600;700&display=swap`;
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

const base = {
  id: z.string().min(1).max(40),
  hidden: z.boolean().default(false),
  placement: z.enum(["form", "summary"]).default("form"),
  // thank-you page only
  position: z.enum(["above", "below"]).default("below"),
  style: blockStyleSchema.default(blockStyleSchema.parse({})),
};

const titled = z.object({ title: z.string().max(120).default("") });

export const blockSchema = z.discriminatedUnion("type", [
  // Fixed checkout sections: reorderable, never removable.
  z.object({ ...base, type: z.literal("contact"), props: titled.default({ title: "" }) }),
  z.object({ ...base, type: z.literal("delivery"), props: titled.default({ title: "" }) }),
  z.object({ ...base, type: z.literal("shipping_method"), props: titled.default({ title: "" }) }),
  z.object({ ...base, type: z.literal("payment"), props: titled.default({ title: "" }) }),

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
      score: z.number().min(0).max(5),
      count: z.number().int().min(0),
      label: z.string().max(120),
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

export const FIXED_CHECKOUT_BLOCKS = ["contact", "delivery", "shipping_method", "payment"] as const;
export function isFixed(type: BlockType): boolean {
  return (FIXED_CHECKOUT_BLOCKS as readonly string[]).includes(type);
}

/** Blocks that can be added from the palette, per page. */
export const CHECKOUT_PALETTE: BlockType[] = [
  "order_addons",
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

export const layoutSchema = z.object({ blocks: z.array(blockSchema).max(40) });
export type Layout = z.infer<typeof layoutSchema>;

/** Checkout layouts must contain every fixed section exactly once. */
export const checkoutLayoutSchema = layoutSchema.refine(
  (l) => FIXED_CHECKOUT_BLOCKS.every((t) => l.blocks.filter((b) => b.type === t).length === 1),
  { message: "Contact, Livraison, Méthode de livraison et Paiement sont obligatoires" },
);
export const thankYouLayoutSchema = layoutSchema.refine((l) => l.blocks.every((b) => !isFixed(b.type) && b.type !== "order_note"), {
  message: "Les sections du checkout ne peuvent pas être sur la page de remerciement",
});

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

export function newBlockId(): string {
  return Math.random().toString(36).slice(2, 10);
}

const DEFAULT_PROPS: { [T in BlockType]: BlockOf<T>["props"] } = {
  contact: { title: "" },
  delivery: { title: "" },
  shipping_method: { title: "" },
  payment: { title: "" },
  order_addons: { title: "" },
  text: { heading: "Titre", body: "Votre texte ici." },
  image: { url: "", alt: "", size: "full" },
  testimonial: {
    quote: "Livraison rapide et produit conforme, je recommande.",
    author: "Client vérifié",
    photoUrl: "",
    stars: 5,
  },
  rating: { score: 4.8, count: 0, label: "note moyenne de nos clients" },
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
  social: { title: "Suivez-nous", instagram: "", tiktok: "", facebook: "", youtube: "" },
};

export function createBlock<T extends BlockType>(type: T, overrides: Partial<Block> = {}): BlockOf<T> {
  return blockSchema.parse({
    id: newBlockId(),
    type,
    props: structuredClone(DEFAULT_PROPS[type]),
    ...overrides,
  }) as BlockOf<T>;
}

export function defaultCheckoutLayout(): Layout {
  return {
    blocks: [
      createBlock("contact"),
      createBlock("delivery"),
      createBlock("shipping_method"),
      createBlock("order_addons"),
      createBlock("payment"),
      createBlock("trust_badges", { placement: "summary" }),
    ],
  };
}

export function defaultThankYouLayout(): Layout {
  return { blocks: [] };
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

/** Keeps every valid block (repairing props/style when possible) and drops only broken ones. */
function loadBlocks(raw: unknown): Block[] {
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
  const blocks = loadBlocks(raw).filter((b, i, all) => !single(b.type) || all.findIndex((x) => x.type === b.type) === i);
  // Every fixed section must exist exactly once: re-add missing ones before "payment".
  for (const type of FIXED_CHECKOUT_BLOCKS) {
    if (!blocks.some((b) => b.type === type)) {
      const pay = blocks.findIndex((b) => b.type === "payment");
      blocks.splice(type === "payment" || pay < 0 ? blocks.length : pay, 0, createBlock(type));
    }
  }
  return { blocks };
}

export function loadThankYouLayout(raw: unknown): Layout {
  if (raw == null) return defaultThankYouLayout();
  return { blocks: loadBlocks(raw).filter((b) => !isFixed(b.type) && b.type !== "order_addons" && b.type !== "order_note") };
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
