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
  radius: z.number().int().min(0).max(24).default(10),
  accentColor: color.default("#111827"),
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
    props: z.object({ items: z.array(z.object({ icon: z.string().max(8), label: z.string().max(80) })).max(8) }),
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
            icon: z.enum(["shield", "star", "truck", "lock", "heart", "check", "refresh"]),
            title: z.string().max(80),
            text: z.string().max(300),
          }),
        )
        .max(8),
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
export const thankYouLayoutSchema = layoutSchema.refine((l) => l.blocks.every((b) => !isFixed(b.type)), {
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
      { icon: "🚚", label: "Livraison offerte" },
      { icon: "↩️", label: "Retours faciles" },
      { icon: "🔒", label: "Paiement sécurisé" },
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

export function loadTheme(raw: unknown, storeName = ""): Theme {
  const parsed = themeSchema.safeParse(raw ?? {});
  const theme = parsed.success ? parsed.data : defaultTheme(storeName);
  // Until a name is set in the builder, show the store's own name.
  return theme.storeName ? theme : { ...theme, storeName };
}

export function loadCheckoutLayout(raw: unknown): Layout {
  const parsed = checkoutLayoutSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultCheckoutLayout();
}

export function loadThankYouLayout(raw: unknown): Layout {
  const parsed = thankYouLayoutSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultThankYouLayout();
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
