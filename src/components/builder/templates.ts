import {
  blockSchema,
  blockStyleSchema,
  createBlock,
  dedupeSingletons,
  defaultTheme,
  signedWithStore,
  type Block,
  type BlockOf,
  type BlockStyle,
  type BlockType,
  type Layout,
  type Theme,
} from "@/lib/layout";
import { arrangeCheckout } from "@/components/checkout/CheckoutView";
import { isPlaceholderTextBody, isPlaceholderTextHeading } from "@/lib/legacy-sample";

/** Per-block settings a template may set on top of the block's defaults. */
export type SpecOverrides = Partial<Pick<Block, "placement" | "position">> & {
  style?: Partial<BlockStyle>;
  /** Merged over the block's default props (only for blocks the page doesn't have yet). */
  props?: Record<string, unknown>;
};
export type Spec = [BlockType, SpecOverrides?];

export type TemplateCategory = "minimal" | "premium" | "conversion" | "thematic";
export const TEMPLATE_CATEGORIES: { key: TemplateCategory; label: string }[] = [
  { key: "minimal", label: "Minimal" },
  { key: "premium", label: "Premium" },
  { key: "conversion", label: "Conversion" },
  { key: "thematic", label: "Thématique" },
];

/**
 * The look a template sets: colors, fonts, shapes, header style and column layout. Everything
 * else in the theme is the merchant's content and is never touched by a template: logo, banner
 * image and header mode, store name, language, trust line, button text, policy / terms links,
 * VAT note, express checkout and legal toggles, and the text size (fontScale: a readability choice).
 */
export const TEMPLATE_STYLE_KEYS = [
  "font",
  "headingFont",
  "radius",
  "accentColor",
  "accentColor2",
  "textColor",
  "borderColor",
  "buttonShape",
  "buttonShadow",
  "inputStyle",
  "headerBackground",
  "headerBorder",
  "headerAlign",
  "summarySide",
  "summaryImages",
  "contentWidth",
  "pageBackground",
  "formBackground",
  "summaryBackground",
] as const satisfies readonly (keyof Theme)[];
export type TemplateStyle = Pick<Theme, (typeof TEMPLATE_STYLE_KEYS)[number]>;

export type Template = {
  id: string;
  name: string;
  description: string;
  /** Block types in order, shown as a preview list in the menu. */
  summary: string;
  /** The block stack, drawn as a mini thumbnail. */
  spec: Spec[];
  category: TemplateCategory;
  /** Complete look applied with the blocks. Absent: blocks only, the style is kept. */
  style?: TemplateStyle;
  /**
   * Page blocks this template hides (never deletes): Minimal's add-ons, and the default trust
   * badges wherever the template adds its own reassurance (secure badge, value props, payment logos).
   */
  hides?: readonly BlockType[];
  /** One-line "idéal pour" tag shown on the card (« Trafic mobile », « Panier élevé »…). */
  idealFor?: string;
  /** `storeName` signs a message block the template creates (see signedWithStore). */
  build: (current: Layout, ctx?: BuildContext) => Layout;
};

/** What a template build needs from the builder: the store name signs a message it creates. */
export type BuildContext = { storeName?: string };

/**
 * The old « Simple » note as that template created it: « Titre » / « Votre texte ici. » (the
 * loader now empties those exact placeholder words, so it loads blank).
 */
const untouchedNote = (p: { heading: string; body: string }) =>
  (p.heading.trim() === "" || isPlaceholderTextHeading(p.heading)) && (p.body.trim() === "" || isPlaceholderTextBody(p.body));

/**
 * The Text block an earlier « Simple » template made as its note (right after the confirmation,
 * or right before it in the first version), only while untouched (its shipped « Titre » / « Votre
 * texte ici. »): reused as the message so the page keeps one note. A note the merchant wrote stays
 * their Text block, as written (never moved into a message, never cut).
 */
function oldNote(blocks: Block[]): BlockOf<"text"> | null {
  const c = blocks.findIndex((b) => b.type === "ty_confirmation");
  if (c < 0) return null;
  for (const b of [blocks[c + 1], blocks[c - 1]]) {
    if (b?.type === "text" && untouchedNote(b.props)) return b;
  }
  return null;
}

/**
 * The untouched old note as a message block: same id, visibility, place and style, the message's
 * own shipped texts (translated for buyers). Not signed: the note had no signature.
 */
function noteAsMessage(b: BlockOf<"text">): Block {
  const { type: _t, props: _p, i18n: _i, ...rest } = b;
  void _t;
  void _p;
  void _i;
  return blockSchema.parse({ ...rest, type: "message", props: createBlock("message").props }) as Block;
}

/**
 * The page's block each spec entry reuses (null: created), and the blocks the spec doesn't list.
 * A thank-you page without a message reuses the old « Simple » note (oldNote) as its message.
 */
function matchSpec(spec: Spec[], current: Layout): { reused: (Block | null)[]; pool: Block[] } {
  const pool = [...current.blocks];
  const reused = spec.map(([type]) => {
    const at = pool.findIndex((b) => b.type === type);
    return at >= 0 ? pool.splice(at, 1)[0] : null;
  });
  const m = spec.findIndex(([type]) => type === "message");
  if (m >= 0 && !reused[m]) {
    const note = oldNote(current.blocks);
    const at = note ? pool.indexOf(note) : -1;
    if (at >= 0) reused[m] = pool.splice(at, 1)[0];
  }
  return { reused, pool };
}

const SHIPPED_BADGES = createBlock("trust_badges").props.badges;

/**
 * Whether a template may hide this block of a hidden type: the default trust badges only while
 * untouched (shipped labels, no icon, no translation); badges the merchant edited stay shown.
 */
function templateMayHide(b: Block, hide: ReadonlySet<BlockType>): boolean {
  if (!hide.has(b.type)) return false;
  if (b.type !== "trust_badges") return true;
  const badges = b.props.badges;
  const untouched =
    badges.length === SHIPPED_BADGES.length && badges.every((x, i) => x.label.trim() === SHIPPED_BADGES[i].label && !x.iconUrl) && !Object.keys(b.i18n ?? {}).length;
  return untouched;
}

/** A block hidden by a template, shown again (marker dropped). */
function shown<B extends Block>(b: B): B {
  const { hiddenByTemplate: _h, ...rest } = b;
  void _h;
  return { ...rest, hidden: false } as B;
}

/**
 * Builds a layout from a spec. Blocks the page already has are reused as the merchant left them:
 * fixed sections (and their custom titles) as they are, other blocks with their texts, products,
 * translations, style, placement and hidden state (the template only orders them). Only blocks
 * the page doesn't have are created, from their translated defaults, with the template's style,
 * placement and props. Blocks the template doesn't list (a text, an image, a FAQ, the add-ons…)
 * are kept too, next to the block they followed (see keepOthers).
 *
 * `hide`: types of the unlisted blocks the template hides (never deletes), marked with its id
 * (`hiddenByTemplate`). A block still carrying such a marker from an earlier template is shown
 * again unless this template hides it too; a block the merchant hid stays hidden.
 */
export function fromSpec(spec: Spec[], current: Layout, opts: { hide?: readonly BlockType[]; templateId?: string; storeName?: string } = {}): Layout {
  const { reused, pool } = matchSpec(spec, current);
  const hide = new Set(opts.hide ?? []);
  const blocks = spec.map(([type, o = {}], i) => {
    const existing = reused[i];
    if (existing) {
      const b = existing.type !== type ? noteAsMessage(existing as BlockOf<"text">) : existing;
      return b.hiddenByTemplate ? shown(b) : b;
    }
    const fresh = createBlock(type, { ...(o.placement ? { placement: o.placement } : {}), ...(o.position ? { position: o.position } : {}) });
    const style = { ...blockStyleSchema.parse({}), ...fresh.style, ...o.style };
    return signedWithStore(blockSchema.parse({ ...fresh, style, props: { ...fresh.props, ...o.props } }) as Block, opts.storeName);
  });
  const others = pool.map((b) => {
    if (templateMayHide(b, hide)) return b.hidden && !b.hiddenByTemplate ? b : { ...b, hidden: true, hiddenByTemplate: opts.templateId ?? "template" };
    return b.hiddenByTemplate ? shown(b) : b;
  });
  const kept = dedupeSingletons(keepOthers(blocks, others, current.blocks));
  // A reused one-click offer may point to a follow-up offer the template dropped.
  const ids = new Set(kept.map((b) => b.id));
  return {
    blocks: kept.map((b) => {
      if (b.type !== "upsell") return b;
      const { acceptNextId, declineNextId } = b.props;
      if ((!acceptNextId || ids.has(acceptNextId)) && (!declineNextId || ids.has(declineNextId))) return b;
      return {
        ...b,
        props: {
          ...b.props,
          acceptNextId: acceptNextId && ids.has(acceptNextId) ? acceptNextId : undefined,
          declineNextId: declineNextId && ids.has(declineNextId) ? declineNextId : undefined,
        },
      };
    }),
  };
}

/**
 * The page's blocks a template doesn't list, unchanged, each after the block it followed before
 * (the nearest earlier one the template kept, and the blocks the template adds right after it),
 * else at the top: a FAQ under the payment stays under it, a text after Contact stays there, a
 * banner above everything stays on top.
 */
function keepOthers(built: Block[], others: Block[], before: Block[]): Block[] {
  if (others.length === 0) return built;
  const out = [...built];
  const had = new Set(before.map((b) => b.id));
  for (const b of others) {
    const i = before.findIndex((x) => x.id === b.id);
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const anchor = out.findIndex((x) => x.id === before[j].id);
      if (anchor >= 0) {
        at = anchor + 1;
        break;
      }
    }
    // Blocks the template adds right after the anchor stay attached to it (an offer right
    // after the confirmation stays above the fold).
    while (at < out.length && !had.has(out[at].id)) at += 1;
    out.splice(at, 0, b);
  }
  return out;
}

/** Page blocks a template doesn't list: kept by fromSpec (the confirmation dialog names them). */
export function blocksKeptAside(spec: Spec[], current: Layout): Block[] {
  return matchSpec(spec, current).pool;
}

const COLUMNS_CACHE = new WeakMap<Spec[], { form: BlockType[]; summary: BlockType[] }>();

/**
 * The two columns of a checkout template as the page really draws them on a computer (see
 * arrangeCheckout): the form column (sections, top banners, then what shows under the payment)
 * and the summary column (cross-sells, blocks placed there, then reassurance widgets).
 */
export function renderedColumns(spec: Spec[]): { form: BlockType[]; summary: BlockType[] } {
  // Memoized per spec (template specs are module constants): the Modèles menu re-renders its
  // thumbnails on every hover, and each arrangement builds a whole layout.
  const cached = COLUMNS_CACHE.get(spec);
  if (cached) return cached;
  const a = arrangeCheckout(fromSpec(spec, { blocks: [] }).blocks);
  const types = (list: Block[]) => list.map((b) => b.type);
  const columns = {
    form: [...types(a.main), ...types(a.after)],
    summary: [...(a.recommendations ? ["recommendations" as const] : []), ...types(a.summary), ...types(a.side)],
  };
  COLUMNS_CACHE.set(spec, columns);
  return columns;
}

/** The hovered template to keep once the builder's open popover changes: none unless Modèles is open. */
export function previewAfterPopover<T>(popover: string | null, preview: T | null): T | null {
  return popover === "templates" ? preview : null;
}

/** The theme after applying a template: its look, the merchant's content untouched. */
export function applyTemplateTheme(current: Theme, t: Pick<Template, "style">): Theme {
  if (!t.style) return current;
  const style = Object.fromEntries(TEMPLATE_STYLE_KEYS.map((k) => [k, t.style![k]]));
  return { ...current, ...style };
}

/** "Idéal pour" tag of each template id (a styled checkout and its thank-you page share it). */
const IDEAL_FOR: Record<string, string> = {
  "clean-minimal": "Marques épurées",
  "classic-two-columns": "Tout catalogue",
  "compact-mobile": "Trafic mobile",
  "dark-premium": "Marques DTC",
  "luxury-black-gold": "Panier élevé",
  "nude-editorial": "Mode & lifestyle",
  "trust-max": "Nouvelle boutique",
  "urgency-promo": "Soldes & lancements",
  "funnel-one-product": "Produit unique",
  "sport-performance": "Sport & fitness",
  "soft-beauty": "Beauté & cosmétique",
  "nature-eco": "Produits naturels",
  minimal: "Achat rapide",
  trust: "Trafic publicitaire",
  conversion: "Hausse du panier",
  simple: "Toute boutique",
  loyalty: "Rachat & fidélité",
  upsell: "Hausse du panier",
};

/** Reassurance blocks that repeat the default trust badges (« Paiement sécurisé »…): those are hidden. */
const REASSURANCE: readonly BlockType[] = ["secure_badge", "value_props", "payment_icons"];

function template(t: Omit<Template, "build">): Template {
  const idealFor = t.idealFor ?? IDEAL_FOR[t.id];
  const ownTrust = t.spec.some(([type]) => REASSURANCE.includes(type));
  const hides = [...new Set([...(t.hides ?? []), ...(ownTrust ? (["trust_badges"] as const) : [])])];
  return {
    ...t,
    ...(idealFor ? { idealFor } : {}),
    ...(hides.length ? { hides } : {}),
    build: (c, ctx) => fromSpec(t.spec, c, { hide: hides, templateId: t.id, storeName: ctx?.storeName }),
  };
}

/** Visible page blocks a template hides (named in the confirmation dialog). */
export function blocksHiddenBy(t: Pick<Template, "spec" | "hides">, current: Layout): Block[] {
  const hide = new Set(t.hides ?? []);
  return blocksKeptAside(t.spec, current).filter((b) => templateMayHide(b, hide) && !b.hidden);
}

/** Blocks an earlier template hid that this one shows again (named in the confirmation dialog). */
export function blocksShownBy(t: Pick<Template, "spec" | "hides">, current: Layout): Block[] {
  const hide = new Set(t.hides ?? []);
  const aside = new Set(blocksKeptAside(t.spec, current));
  return current.blocks.filter((b) => b.hidden && b.hiddenByTemplate && !(aside.has(b) && templateMayHide(b, hide)));
}

/**
 * The « Actuel » badge: the template last applied on this page, while the shared style still is
 * its look (a styled template applied on the other page changes it for both).
 */
export function isCurrentTemplate(t: Pick<Template, "id" | "style">, appliedId: string | null | undefined, theme: Theme): boolean {
  if (canonicalTemplateId(appliedId) !== t.id) return false;
  return !t.style || TEMPLATE_STYLE_KEYS.every((k) => theme[k] === t.style![k]);
}

/** What the minimal templates leave out: paid options and a second row of reassurance. */
const MINIMAL_HIDES: readonly BlockType[] = ["order_addons", "trust_badges"];

const BASE = defaultTheme();
/** A complete look: the defaults, with the template's choices on top. */
function look(overrides: Partial<TemplateStyle>): TemplateStyle {
  const all = { ...BASE, ...overrides };
  return Object.fromEntries(TEMPLATE_STYLE_KEYS.map((k) => [k, all[k]])) as TemplateStyle;
}

const TOP: Spec[] = [["express"], ["contact"], ["delivery"], ["shipping_method"]];
const SUMMARY = { placement: "summary" } as const;

/*
 * What a template creates renders live exactly as the builder shows it, so its example texts make
 * no precise promise (no « 30 jours », « 48 h » or « livraison offerte » the merchant didn't set):
 * neutral wording, all shipped defaults (translated for buyers, see localize.ts DEFAULT_TEXTS).
 * No invented figures (stats) or quotes (testimonial) either; reviews blocks start empty.
 */
/** The thank-you note: one per page, a card, right after the confirmation (or its offer). */
const MESSAGE: Spec = ["message", { style: { card: true } }];
/**
 * No refund or returns promise the merchant didn't make, and no contact line the page gives no way
 * to act on: what every order gets anyway (the confirmation e-mail and the tracking).
 */
const GUARANTEE = { props: { title: "Commande suivie", text: "Vous recevez un e-mail de confirmation et le suivi de votre colis." } };
const VALUE_PROPS = {
  items: [
    { icon: "truck", label: "Suivi de commande" },
    { icon: "lock", label: "Paiement sécurisé" },
  ],
};
/** Two columns, no « Paiement sécurisé » (the page's trust badges / secure badge already say it). */
const BENEFITS = {
  props: {
    columns: 2,
    items: [
      { icon: "truck", title: "Suivi de commande", text: "Vous recevez un e-mail de suivi dès l'expédition de votre commande." },
      { icon: "support", title: "Service client", text: "Un souci ? Notre équipe vous répond." },
    ],
  },
};
const FAQ = {
  props: {
    items: [
      { q: "Quand vais-je recevoir ma commande ?", a: "Vous recevez un e-mail de suivi dès l'expédition de votre commande." },
      { q: "Quand vais-je recevoir ma confirmation ?", a: "Juste après le paiement, par e-mail." },
    ],
  },
};
/**
 * A gift for the next order, without any code or discount: nothing shows live until the merchant
 * types a code that exists (the title doesn't thank twice: the confirmation already does).
 */
const COUPON: Spec = ["coupon", { props: { title: "Un cadeau pour votre prochaine commande", text: "À utiliser lors de votre prochaine commande.", code: "" } }];
/**
 * A timer per visitor: shows live as in the builder (a date timer without its date shows nothing).
 * Its example text claims no offer end the merchant never set: the cart is held (editable).
 */
const COUNTDOWN: Spec = ["countdown", { props: { mode: "evergreen", label: "Votre panier est réservé pendant {timer}" } }];

/**
 * Styled templates: a checkout layout, its matching thank-you page and a look. Inspired by the
 * structure, spacing and color feel of well-converting checkouts (Shopify Plus DTC brands,
 * funnel builders, Baymard guidelines: see the research notes), never their logos or names.
 * Every look passes WCAG AA for text and buttons (tests/templates.test.ts).
 */
type Styled = {
  id: string;
  name: string;
  category: TemplateCategory;
  description: string;
  style: TemplateStyle;
  /** Checkout blocks hidden by the template (see Template.hides). */
  hides?: readonly BlockType[];
  checkout: { summary: string; spec: Spec[] };
  thankYou: { summary: string; spec: Spec[] };
};

const STYLED: Styled[] = [
  {
    id: "clean-minimal",
    name: "Minimal épuré",
    category: "minimal",
    description: "Police système, beaucoup de blanc, bouton pilule bleu. Pour les marques tech ou design qui misent sur la sobriété.",
    style: look({
      font: "System",
      headingFont: "same",
      radius: 12,
      accentColor: "#0066cc",
      textColor: "#1d1d1f",
      borderColor: "#c7c7cc",
      buttonShape: "pill",
      buttonShadow: false,
      headerBackground: "#ffffff",
      headerBorder: true,
      headerAlign: "center",
      contentWidth: "narrow",
      summaryBackground: "#f5f5f7",
    }),
    hides: MINIMAL_HIDES,
    checkout: {
      summary: "Paiement express · Contact · Adresse · Livraison · Paiement + badge sécurisé (récapitulatif ; sous le bouton sur mobile)",
      spec: [...TOP, ["payment"], ["secure_badge", { style: { align: "center" } }]],
    },
    thankYou: {
      summary: "Confirmation · Message personnalisé · Adresse · Récapitulatif",
      spec: [["ty_confirmation"], MESSAGE, ["ty_details"], ["ty_summary"]],
    },
  },
  {
    id: "classic-two-columns",
    name: "Classique 2 colonnes",
    category: "minimal",
    description: "La mise en page classique des boutiques en ligne : logo à gauche, récapitulatif gris à droite, champs sobres. Rassurant car familier pour l'acheteur.",
    style: look({
      font: "Inter",
      headingFont: "same",
      radius: 5,
      accentColor: "#1773b0",
      textColor: "#1a1a1a",
      borderColor: "#c9c9c9",
      buttonShape: "default",
      buttonShadow: false,
      headerBackground: "#ffffff",
      headerBorder: true,
      headerAlign: "left",
      summarySide: "right",
      summaryBackground: "#f5f5f5",
    }),
    checkout: {
      summary: "Paiement express · Contact · Adresse · Livraison · Options · Paiement + logos de paiement (récapitulatif ; sous le bouton sur mobile)",
      spec: [...TOP, ["order_addons"], ["payment"], ["payment_icons"]],
    },
    thankYou: {
      summary: "Confirmation · Message personnalisé · Adresse · Récapitulatif",
      spec: [["ty_confirmation"], MESSAGE, ["ty_details"], ["ty_summary"]],
    },
  },
  {
    id: "compact-mobile",
    name: "Mobile compact",
    category: "minimal",
    description: "Colonne étroite, champs remplis et photos des produits dans le récapitulatif : le paiement arrive vite sur petit écran. Pour un trafic majoritairement mobile (réseaux sociaux).",
    style: look({
      font: "DM Sans",
      headingFont: "same",
      radius: 10,
      accentColor: "#111827",
      textColor: "#111827",
      borderColor: "#d1d5db",
      buttonShape: "default",
      buttonShadow: true,
      inputStyle: "filled",
      headerBackground: "#ffffff",
      headerBorder: true,
      headerAlign: "center",
      summaryImages: true,
      contentWidth: "narrow",
      summaryBackground: "#f4f4f5",
    }),
    checkout: {
      summary: "Barre livraison offerte · Paiement express · Contact · Adresse · Livraison · Paiement + logos de paiement (récapitulatif ; sous le bouton sur mobile)",
      spec: [["free_shipping_bar"], ...TOP, ["payment"], ["payment_icons"]],
    },
    thankYou: {
      summary: "Confirmation · Message personnalisé · Adresse · Récapitulatif · Code promo cadeau",
      spec: [["ty_confirmation"], MESSAGE, ["ty_details"], ["ty_summary"], COUPON],
    },
  },
  {
    id: "dark-premium",
    name: "DTC premium sombre",
    category: "premium",
    description: "En-tête noir, boutons anthracite en dégradé, avis et garantie dans le récapitulatif. Pour une marque DTC qui veut paraître haut de gamme (logo clair conseillé).",
    style: look({
      font: "Manrope",
      headingFont: "same",
      radius: 8,
      accentColor: "#18181b",
      accentColor2: "#3f3f46",
      textColor: "#18181b",
      borderColor: "#d4d4d8",
      buttonShape: "default",
      buttonShadow: true,
      headerBackground: "#0a0a0a",
      headerBorder: false,
      headerAlign: "center",
      summaryBackground: "#f4f4f5",
    }),
    checkout: {
      summary: "Paiement express · Contact · Adresse · Livraison · Paiement + badge sécurisé, garantie et avis (récapitulatif ; sous le bouton sur mobile)",
      spec: [...TOP, ["payment"], ["secure_badge"], ["guarantee", GUARANTEE], ["reviews", SUMMARY]],
    },
    thankYou: {
      summary: "Confirmation · Offre post-achat · Message personnalisé · Adresse · Récapitulatif",
      spec: [["ty_confirmation"], ["upsell"], MESSAGE, ["ty_details"], ["ty_summary"]],
    },
  },
  {
    id: "luxury-black-gold",
    name: "Luxe noir & or",
    category: "premium",
    description: "Titres à empattements, noir profond, filets or et boutons noir-bronze, angles droits. Pour la joaillerie, les montres, la parfumerie (logo clair conseillé).",
    style: look({
      font: "Lato",
      headingFont: "Playfair Display",
      radius: 0,
      accentColor: "#111111",
      accentColor2: "#6b5220",
      textColor: "#1c1917",
      // Real gold lines (cards, separators); fields get a darker boundary (fieldBorderColor, 3:1).
      borderColor: "#c9a646",
      buttonShape: "square",
      buttonShadow: false,
      headerBackground: "#0b0b0b",
      headerBorder: false,
      headerAlign: "center",
      pageBackground: "#fdfbf7",
      summaryBackground: "#f5efe3",
    }),
    checkout: {
      summary: "Paiement express · Contact · Adresse · Livraison · Paiement + badge sécurisé, garantie et avis (récapitulatif ; sous le bouton sur mobile)",
      spec: [...TOP, ["payment"], ["secure_badge", { style: { card: true } }], ["guarantee", GUARANTEE], ["reviews", SUMMARY]],
    },
    thankYou: {
      summary: "Confirmation · Message personnalisé · Adresse · Récapitulatif",
      spec: [["ty_confirmation"], MESSAGE, ["ty_details"], ["ty_summary"]],
    },
  },
  {
    id: "nude-editorial",
    name: "Nude éditorial",
    category: "premium",
    description: "Tons sable et taupe, champs soulignés, angles droits, très peu de blocs. L'esprit des marques mode minimalistes (lingerie, prêt-à-porter).",
    style: look({
      font: "DM Sans",
      headingFont: "same",
      radius: 0,
      accentColor: "#3d3530",
      textColor: "#2b2622",
      borderColor: "#a89a8d",
      buttonShape: "square",
      buttonShadow: false,
      inputStyle: "underline",
      headerBackground: "#faf7f3",
      headerBorder: true,
      headerAlign: "center",
      pageBackground: "#faf7f3",
      summaryBackground: "#f5f0ea",
    }),
    checkout: {
      summary: "Paiement express · Contact · Adresse · Livraison · Paiement + avantages (récapitulatif ; sous le bouton sur mobile)",
      spec: [...TOP, ["payment"], ["value_props", { ...SUMMARY, props: VALUE_PROPS }]],
    },
    thankYou: {
      summary: "Confirmation · Message personnalisé · Adresse · Récapitulatif",
      spec: [["ty_confirmation"], MESSAGE, ["ty_details"], ["ty_summary"]],
    },
  },
  {
    id: "trust-max",
    name: "Confiance max",
    category: "conversion",
    description: "Moyens de paiement, badge sécurisé et garantie juste sous le bouton sur mobile, puis vos avis : pour une marque encore peu connue ou un panier élevé.",
    style: look({
      font: "Inter",
      headingFont: "same",
      radius: 8,
      accentColor: "#1d4ed8",
      textColor: "#0f172a",
      borderColor: "#cbd5e1",
      buttonShape: "default",
      buttonShadow: true,
      headerBackground: "#ffffff",
      headerBorder: true,
      headerAlign: "center",
      summaryBackground: "#f1f5f9",
    }),
    checkout: {
      summary: "Paiement express · Contact · Adresse · Livraison · Paiement + logos de paiement, badge sécurisé, garantie et avis (récapitulatif ; sous le bouton sur mobile)",
      // No parcel protection: a paid option is the merchant's choice, never added by a template.
      spec: [...TOP, ["payment"], ["payment_icons"], ["secure_badge"], ["guarantee", GUARANTEE], ["reviews", SUMMARY]],
    },
    thankYou: {
      summary: "Confirmation · Message personnalisé · Question « Comment nous avez-vous connu ? » · Adresse · Récapitulatif",
      spec: [["ty_confirmation"], MESSAGE, ["survey"], ["ty_details"], ["ty_summary"]],
    },
  },
  {
    id: "urgency-promo",
    name: "Urgence & promo",
    category: "conversion",
    description: "Compte à rebours par visiteur en haut, stock réel juste au-dessus du paiement (aussi sur mobile), barre livraison offerte (selon vos tarifs) dans le récapitulatif. Pour les soldes, le Black Friday ou un lancement.",
    style: look({
      font: "Poppins",
      headingFont: "same",
      radius: 8,
      accentColor: "#c2410c",
      textColor: "#111827",
      borderColor: "#d1d5db",
      buttonShape: "default",
      buttonShadow: true,
      headerBackground: "#ffffff",
      headerBorder: true,
      headerAlign: "center",
      summaryBackground: "#fffaf5",
    }),
    checkout: {
      summary:
        "Minuteur · Paiement express · Contact · Adresse · Livraison · Order bump · Stock faible · Paiement + suggestions, barre livraison offerte, avis et badge sécurisé (récapitulatif ; suggestions au-dessus du paiement, le reste sous le bouton sur mobile)",
      // Low stock sits right above the payment (with the countdown, the two short banners
      // allowed there), so mobile buyers see it before the pay button, not under it.
      spec: [
        COUNTDOWN,
        ...TOP,
        ["order_addons"],
        ["low_stock"],
        ["payment"],
        ["secure_badge"],
        ["recommendations", SUMMARY],
        ["free_shipping_bar", SUMMARY],
        ["reviews", SUMMARY],
      ],
    },
    thankYou: {
      summary: "Confirmation · Offre post-achat · Message personnalisé · Code promo cadeau · Adresse · Récapitulatif",
      spec: [["ty_confirmation"], ["upsell"], MESSAGE, COUPON, ["ty_details"], ["ty_summary"]],
    },
  },
  {
    id: "funnel-one-product",
    name: "Funnel produit unique",
    category: "conversion",
    description: "Style tunnel de vente : order bump juste avant le paiement, bouton vert, FAQ sous le paiement ; garantie et vos avis dans le récapitulatif (sous le bouton sur mobile). Pour un produit phare vendu via publicité.",
    style: look({
      font: "Inter",
      headingFont: "Poppins",
      radius: 6,
      accentColor: "#15803d",
      textColor: "#111827",
      borderColor: "#d1d5db",
      buttonShape: "default",
      buttonShadow: true,
      headerBackground: "#ffffff",
      headerBorder: true,
      headerAlign: "center",
      summaryBackground: "#f0fdf4",
    }),
    checkout: {
      summary:
        "Paiement express · Contact · Adresse · Livraison · Order bump · Paiement · FAQ + garantie et avis (récapitulatif ; sous le bouton sur mobile, avant la FAQ)",
      spec: [
        ...TOP,
        ["order_addons", { style: { background: "brand" } }],
        ["payment"],
        ["guarantee", { ...GUARANTEE, style: { card: true } }],
        ["faq", FAQ],
        ["reviews", SUMMARY],
      ],
    },
    thankYou: {
      summary: "Confirmation · Offre post-achat · Message personnalisé · Adresse · Récapitulatif",
      spec: [["ty_confirmation"], ["upsell"], MESSAGE, ["ty_details"], ["ty_summary"]],
    },
  },
  {
    id: "sport-performance",
    name: "Sport & performance",
    category: "thematic",
    description: "Noir et blanc contrasté, titres Montserrat, boutons pilule : l'esprit des marques de sportswear. Pour le fitness, l'outdoor, la nutrition sportive.",
    style: look({
      font: "Inter",
      headingFont: "Montserrat",
      radius: 10,
      accentColor: "#000000",
      textColor: "#0a0a0a",
      borderColor: "#d4d4d4",
      buttonShape: "pill",
      buttonShadow: false,
      headerBackground: "#000000",
      headerBorder: false,
      headerAlign: "center",
      summaryBackground: "#f5f5f5",
    }),
    checkout: {
      summary: "Paiement express · Contact · Adresse · Livraison · Options · Paiement + avantages et avis (récapitulatif ; sous le bouton sur mobile)",
      spec: [...TOP, ["order_addons"], ["payment"], ["benefits", { ...SUMMARY, ...BENEFITS }], ["reviews", SUMMARY]],
    },
    thankYou: {
      summary: "Confirmation · Message personnalisé · Adresse · Récapitulatif · Code promo cadeau",
      spec: [["ty_confirmation"], MESSAGE, ["ty_details"], ["ty_summary"], COUPON],
    },
  },
  {
    id: "soft-beauty",
    name: "Beauté douce (pastel)",
    category: "thematic",
    description: "Rose poudré, titres Playfair, boutons pilule et champs remplis. Pour la cosmétique, le soin, les accessoires (esprit marques beauté DTC).",
    style: look({
      font: "DM Sans",
      headingFont: "Playfair Display",
      radius: 16,
      accentColor: "#9d174d",
      textColor: "#3b1f2b",
      borderColor: "#e7c3d0",
      buttonShape: "pill",
      buttonShadow: true,
      inputStyle: "filled",
      headerBackground: "#fff5f7",
      headerBorder: false,
      headerAlign: "center",
      pageBackground: "#fffafb",
      summaryBackground: "#fdf0f3",
    }),
    checkout: {
      summary: "Barre livraison offerte · Paiement express · Contact · Adresse · Livraison · Options · Paiement + suggestions et avis (récapitulatif ; suggestions au-dessus du paiement, avis sous le bouton sur mobile)",
      spec: [["free_shipping_bar"], ...TOP, ["order_addons"], ["payment"], ["recommendations", SUMMARY], ["reviews", SUMMARY]],
    },
    thankYou: {
      summary: "Confirmation · Message personnalisé · Code promo cadeau · Adresse · Récapitulatif",
      spec: [["ty_confirmation"], MESSAGE, COUPON, ["ty_details"], ["ty_summary"]],
    },
  },
  {
    id: "nature-eco",
    name: "Nature & éco",
    category: "thematic",
    description: "Crème et vert forêt, titres Lora, arrondis doux. Pour les produits naturels, bio, durables (esprit marques écoresponsables).",
    style: look({
      font: "Nunito",
      headingFont: "Lora",
      radius: 12,
      accentColor: "#2f5d3a",
      textColor: "#1f2a1f",
      borderColor: "#cfc8b8",
      buttonShape: "pill",
      buttonShadow: false,
      headerBackground: "#f7f4ec",
      headerBorder: true,
      headerAlign: "center",
      pageBackground: "#fbf9f4",
      summaryBackground: "#f4f0e6",
    }),
    checkout: {
      summary: "Paiement express · Contact · Adresse · Livraison · Paiement + avantages, garantie et avis (récapitulatif ; sous le bouton sur mobile)",
      spec: [...TOP, ["payment"], ["benefits", { ...SUMMARY, ...BENEFITS }], ["guarantee", { ...SUMMARY, ...GUARANTEE }], ["reviews", SUMMARY]],
    },
    thankYou: {
      summary: "Confirmation · Message personnalisé · Adresse · Récapitulatif · Question « Comment nous avez-vous connu ? »",
      spec: [["ty_confirmation"], MESSAGE, ["ty_details"], ["ty_summary"], ["survey"]],
    },
  },
];

const LAYOUT_ONLY_CHECKOUT: Template[] = [
  template({
    id: "minimal",
    name: "Minimal",
    category: "minimal",
    description: "L'essentiel, sans distraction : idéal pour un panier simple. Garde votre style.",
    summary: "Paiement express · Contact · Adresse · Mode de livraison · Paiement + badge sécurisé (récapitulatif ; sous le bouton sur mobile)",
    spec: [...TOP, ["payment"], ["secure_badge"]],
    hides: MINIMAL_HIDES,
  }),
  template({
    id: "trust",
    name: "Confiance",
    category: "conversion",
    description: "Rassure les nouveaux clients avec des preuves et une garantie. Garde votre style.",
    summary: "Minimal + logos de paiement, badge sécurisé, avantages, avis et garantie (récapitulatif ; sous le bouton sur mobile)",
    spec: [
      ...TOP,
      ["payment"],
      ["payment_icons"],
      ["secure_badge"],
      ["benefits", { ...SUMMARY, ...BENEFITS }],
      ["reviews", SUMMARY],
      ["guarantee", { ...SUMMARY, ...GUARANTEE }],
    ],
  }),
  template({
    id: "conversion",
    name: "Conversion",
    category: "conversion",
    description: "Pousse le panier moyen et l'urgence : minuteur par visiteur, barre livraison offerte selon vos tarifs. Garde votre style.",
    summary: "Minuteur et barre livraison offerte en haut, order bump, « Complétez votre commande » + badge sécurisé et avis (récapitulatif)",
    spec: [
      COUNTDOWN,
      ["free_shipping_bar"],
      ...TOP,
      ["order_addons"],
      ["payment"],
      ["secure_badge"],
      ["recommendations", SUMMARY],
      ["reviews", SUMMARY],
    ],
  }),
];

export const CHECKOUT_TEMPLATES: Template[] = [
  ...LAYOUT_ONLY_CHECKOUT,
  ...STYLED.map((s) =>
    template({ id: s.id, name: s.name, category: s.category, description: s.description, style: s.style, ...(s.hides ? { hides: s.hides } : {}), ...s.checkout }),
  ),
];

export const THANK_YOU_TEMPLATES: Template[] = [
  template({
    id: "simple",
    name: "Simple",
    category: "minimal",
    description: "Un remerciement clair et un mot personnel. Garde votre style.",
    summary: "Confirmation · Message personnalisé · Adresse · Récapitulatif",
    spec: [["ty_confirmation"], MESSAGE, ["ty_details"], ["ty_summary"]],
  }),
  template({
    id: "loyalty",
    name: "Fidélisation",
    category: "conversion",
    description: "Donne une raison de revenir : un mot personnel et un code promo pour la prochaine commande. Garde votre style.",
    summary: "Confirmation · Message personnalisé · Code promo cadeau · Adresse · Récapitulatif",
    spec: [["ty_confirmation"], MESSAGE, COUPON, ["ty_details"], ["ty_summary"]],
  }),
  template({
    id: "upsell",
    name: "Upsell",
    category: "conversion",
    description: "Offre post-achat en un clic, puis un mot personnel. Garde votre style.",
    // The offer right after the confirmation: visible without scrolling on mobile.
    summary: "Confirmation · Offre post-achat · Message personnalisé · Adresse · Récapitulatif",
    spec: [["ty_confirmation"], ["upsell"], MESSAGE, ["ty_details"], ["ty_summary"]],
  }),
  // The page that goes with each styled checkout template (same look, same id).
  ...STYLED.map((s) =>
    template({
      id: s.id,
      name: s.name,
      category: s.category,
      description: `La page de remerciement assortie au checkout « ${s.name} » (mêmes couleurs, polices et boutons).`,
      style: s.style,
      ...s.thankYou,
    }),
  ),
];

/** Former template ids (saved in drafts as the applied template) → current id. */
const TEMPLATE_ID_ALIASES: Record<string, string> = { "apple-minimal": "clean-minimal" };
/** A stored template id in its current form (renamed ids are mapped). */
export function canonicalTemplateId(id: string | null | undefined): string | null {
  if (!id) return null;
  return TEMPLATE_ID_ALIASES[id] ?? id;
}

/** The styled checkout template that goes with a thank-you template (same id, same look), else null. */
export function matchingCheckout(t: Pick<Template, "id">): Template | null {
  return STYLED.some((s) => s.id === t.id) ? (CHECKOUT_TEMPLATES.find((x) => x.id === t.id) ?? null) : null;
}

/** The thank-you template that goes with a styled checkout template (same id, same look), else null. */
export function matchingThankYou(t: Pick<Template, "id">): Template | null {
  return STYLED.some((s) => s.id === t.id) ? (THANK_YOU_TEMPLATES.find((x) => x.id === t.id) ?? null) : null;
}
