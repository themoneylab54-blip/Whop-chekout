import type { CartLine, LineComponent, LineProperty } from "./pricing";

/*
 * Cart line fidelity for bundle / upsell / personalization apps (Kaching Bundles, Fast Bundle,
 * Bundler, Zepto, EasyBundle, product options…). Pure, exported for tests.
 *
 * Read from Shopify's AJAX cart (/cart.js, documented fields only, every one guarded):
 *  - items[].properties: carried to the Shopify order line (hidden "_…" keys included: apps rely on
 *    them, Shopify hides them from the buyer); the others are shown on the checkout.
 *  - items[].final_line_price + line_level_discount_allocations: a line Shopify prices lower than the
 *    variant keeps that price only on a sign the buyer can't forge (bundle components Shopify
 *    expanded; an automatic allocation is added back, never a sign); otherwise (Markets / B2B price list, a hidden key alone)
 *    the cart goes to Shopify's checkout (never charged more than the cart showed, never less than
 *    verified). A higher cart price is refused too (an app's markup would be lost). Only the server's own re-read of the cart, never the browser's.
 *  - items[].item_components / components (bundle parents expanded by Cart Transform): the order
 *    gets the component variants at their share of the line when the cart gives their prices.
 *  - note / attributes: to the order's note and additional details.
 * Anything that can't be represented faithfully sends the buyer to Shopify's own checkout.
 */

export const MAX_PROPERTIES = 25;
export const MAX_PROPERTY_VALUE = 255;
/**
 * Hidden ("_…") values are app data (Kaching's `__kaching_bundles` JSON…): kept verbatim up to
 * this, never cut (a truncated JSON is invalid app data) — a longer one is left out.
 */
export const MAX_HIDDEN_VALUE = 2000;
/**
 * Known apps' attribution keys (`__kaching_bundles`, BOGOS, UpCart, Simple Bundles, Fast Bundle,
 * Zepto: see APP_SIGNALS) are the app's own offer data: kept verbatim up to this (16 KB) instead.
 */
export const MAX_KNOWN_APP_VALUE = 16_000;
const MAX_PROPERTY_NAME = 255;
const MAX_ATTRIBUTES = 25;
const MAX_NOTE = 1000;
const MAX_COMPONENTS = 30;

export type UnsupportedCartReason =
  | "currency_mismatch"
  | "split_lines"
  | "unknown_line"
  | "cart_changed"
  | "price_higher"
  | "price_not_divisible"
  | "bundle_components_unpriced"
  | "bundle_components_unresolved"
  | "bundle_quantity"
  | "gift_not_discounted"
  | "price_unreconciled"
  | "price_unverified"
  | "bundle_without_cart"
  | "cart_unreadable"
  | "code_unsupported"
  | "subscription";

/** Dashboard / journal wording of each reason (French, merchant-facing). */
export const UNSUPPORTED_REASON_TEXT: Record<UnsupportedCartReason, string> = {
  currency_mismatch: "panier affiché dans une autre devise que la boutique : prix de lot non vérifiables",
  split_lines: "même variante sur plusieurs lignes aux propriétés ou prix différents",
  unknown_line: "ligne de lot introuvable ou indisponible dans Shopify",
  cart_changed: "le panier Shopify ne correspond plus aux articles envoyés",
  price_higher: "prix du panier Shopify plus élevé que le prix de la variante (supplément d'app non reproductible)",
  price_not_divisible: "prix de lot non divisible par la quantité",
  bundle_components_unpriced: "composants de lot sans prix exploitables",
  bundle_components_unresolved: "lot Cart Transform (has_components) dont /cart.js ne donne pas les composants : commander la variante parente fausserait le stock",
  gift_not_discounted: "cadeau d'app (Kaching, BOGOS…) sans remise dans le panier : l'acheteur le paierait",
  price_unreconciled: "total du checkout supérieur au total du panier Shopify",
  price_unverified:
    "prix du panier Shopify plus bas que le prix de la variante sans signe vérifiable d'une app (liste de prix Markets / B2B, prix TTC par pays, ou clé d'app seule) : le checkout ne facture jamais plus que le panier",
  bundle_quantity: "lot en quantité supérieure à 1 (répartition des composants ambiguë)",
  bundle_without_cart: "lot d'app sans panier Shopify vérifiable (achat direct)",
  cart_unreadable: "panier Shopify illisible alors qu'il contient un lot d'app ou une remise automatique",
  code_unsupported:
    "code promo du panier Shopify impossible à reproduire au checkout (code inconnu, lecture des codes Shopify désactivée, Shopify injoignable, plusieurs codes ou autre devise) : l'acheteur paierait plus que le panier",
  subscription: "abonnement (selling plan) ou carte cadeau dans le panier : vendus par le checkout Shopify uniquement",
};

export type CartJsItem = {
  id?: number | string;
  variant_id?: number | string;
  key?: string;
  quantity?: number;
  title?: string;
  price?: number;
  final_price?: number;
  final_line_price?: number;
  line_price?: number;
  original_line_price?: number;
  properties?: Record<string, unknown> | null;
  line_level_discount_allocations?: { amount?: number; discount_application?: { type?: string; title?: string } }[];
  item_components?: unknown;
  components?: unknown;
  selling_plan_allocation?: unknown;
  gift_card?: boolean;
  /** Cart Transform merge / expand parent (its components aren't in the AJAX cart). */
  has_components?: boolean;
  handle?: string;
  product_type?: string;
};

export type CartJs = {
  token?: string;
  currency?: string;
  note?: string | null;
  attributes?: Record<string, unknown> | null;
  items?: CartJsItem[];
  cart_level_discount_applications?: { type?: string; title?: string; total_allocated_amount?: number }[];
  /** Codes applied to the cart (/discount/CODE links, Fast Bundle's cookie code…). */
  discount_codes?: { code?: string; applicable?: boolean }[];
  total_price?: number;
};

/**
 * Cart-level data copied to the Shopify order; `discountCodes`: the codes the Shopify cart carried
 * (offered to the checkout's Shopify-code lookup, never trusted as a discount by themselves).
 */
export type CartContext = {
  note?: string;
  attributes?: { key: string; value: string }[];
  discountCodes?: string[];
  /**
   * The cart's code that lowered its price (verified reproducible when the checkout opened): while
   * the lines are still `items`, the checkout never charges more merchandise than `totalCents`
   * (the cart's total_price) — else payment is blocked (quote `cartCodeLost`).
   */
  codeCheck?: { code: string; totalCents: number; items: { variantId: string; quantity: number }[] };
};

const gidOf = (id: unknown) => {
  const s = String(id ?? "");
  return s.startsWith("gid://") ? s : `gid://shopify/ProductVariant/${s}`;
};
const keyOf = (id: string) => id.match(/(\d+)\D*$/)?.[1] ?? id;

const str = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
};

const propertyEntries = (raw: unknown): [string, unknown][] =>
  !raw || typeof raw !== "object"
    ? []
    : Array.isArray(raw)
      ? raw.map((p) => [String((p as { name?: unknown; key?: unknown })?.name ?? (p as { key?: unknown })?.key ?? ""), (p as { value?: unknown })?.value])
      : Object.entries(raw as Record<string, unknown>);

/** Longest value a hidden key keeps (a known app's attribution key: 16 KB, any other: 2000). */
const hiddenCap = (name: string) => (APP_SIGNALS.some(([, t]) => t(name)) ? MAX_KNOWN_APP_VALUE : MAX_HIDDEN_VALUE);

/**
 * Line item properties as the order takes them, byte for byte (names untouched, hidden "_…" / "__…"
 * keys included): string values (numbers / booleans as text, objects as JSON), null ones dropped,
 * at most 25 per line, names and visible values cut at 255; a hidden value over 2000 characters
 * (16 KB for a known app's key) is left out whole (see oversizedHiddenProperties). Pure.
 */
export function sanitizeProperties(raw: unknown): LineProperty[] {
  const out: LineProperty[] = [];
  for (const [name, value] of propertyEntries(raw)) {
    const n = name.slice(0, MAX_PROPERTY_NAME);
    const raw = str(value);
    if (!n.trim() || raw == null) continue;
    if (n.startsWith("_") && raw.length > hiddenCap(n)) continue;
    const v = n.startsWith("_") ? raw : raw.slice(0, MAX_PROPERTY_VALUE);
    out.push({ name: n, value: v });
    if (out.length >= MAX_PROPERTIES) break;
  }
  return out;
}

/** Names of the hidden properties sanitizeProperties leaves out (value over its cap, see hiddenCap). Pure. */
export function oversizedHiddenProperties(raw: unknown): string[] {
  return propertyEntries(raw)
    .filter(([n, v]) => n.startsWith("_") && (str(v)?.length ?? 0) > hiddenCap(n.slice(0, MAX_PROPERTY_NAME)))
    .map(([n]) => n.slice(0, 60));
}

/** Cart attributes / note as the order takes them (25 attributes, 255 chars each; note 1000). Pure. */
export function sanitizeCartContext(note: unknown, attributes: unknown): CartContext | null {
  const n = typeof note === "string" ? note.trim().slice(0, MAX_NOTE) : "";
  const attrs = sanitizeProperties(attributes).slice(0, MAX_ATTRIBUTES).map((p) => ({ key: p.name, value: p.value }));
  if (!n && !attrs.length) return null;
  return { ...(n ? { note: n } : {}), ...(attrs.length ? { attributes: attrs } : {}) };
}

/**
 * Words of the hidden property names bundle / offer apps use (Kaching, Fast Bundle, Bundler, Zepto,
 * EasyBundle, BOGOS, UpCart…), matched as whole words of the name ("_", "-", camelCase): "_deal_id"
 * is one, "_dealer_id" / "_packaging" aren't.
 */
const HINT_WORDS = new Set([
  "bundle", "bundles", "bundled", "bundler", "kaching", "bogos", "bogo", "bxgy", "upcart", "freegift", "fbb", "fastbundle",
  "zepto", "pplr", "deal", "deals", "offer", "offers", "upsell", "mix", "combo", "pack", "packs",
]);

/** Whether a property name is a bundle / offer app's hidden key (whole words only). Pure. */
export function isBundleHintKey(name: string): boolean {
  if (!name.startsWith("_")) return false;
  if (/^_sb_/.test(name)) return true;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((w, i) => HINT_WORDS.has(w) || (w === "free" && words[i + 1] === "gift"));
}

/** Whether a line's properties look like a bundle / offer app's (its price may be the app's). Pure. */
export function hasBundleHint(properties: LineProperty[] | undefined): boolean {
  return (properties ?? []).some((p) => isBundleHintKey(p.name));
}

type Normalized = {
  variantId: string;
  quantity: number;
  properties: LineProperty[];
  finalLineCents: number | null;
  allocatedCents: number;
  /** Part of allocatedCents from automatic discounts (the ones the checkout carries; codes aren't). */
  autoAllocatedCents: number;
  components: LineComponent[] | "invalid" | "unresolved" | null;
  /** Quantity an app set and the buyer mustn't change (Zepto fee product, BOGOS cloned gift). */
  appQuantity: boolean;
  /** An app's free gift (Kaching gift / BXGY line, BOGOS function gift). */
  appGift: boolean;
  /** A bundle / offer app's hidden key on the line (even one left out for its size). */
  hint: boolean;
  /** Any hidden ("_…") key on the line (an app's data, even one left out for its size). */
  hidden: boolean;
  /** Subscription (selling plan) or gift card line: Shopify's checkout only. */
  shopifyOnly: boolean;
};

/** Kaching's `__kaching_bundles` JSON of a line (read whole, whatever its size), or null. */
function kachingOf(properties: unknown): Record<string, unknown> | null {
  const raw = str(propertyEntries(properties).find(([n]) => n === "__kaching_bundles")?.[1]);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

/** Bundle components of a cart item (item_components, or components in other cart shapes). Pure. */
export function componentsOf(item: CartJsItem): LineComponent[] | "invalid" | null {
  const raw = Array.isArray(item.item_components) ? item.item_components : Array.isArray(item.components) ? item.components : null;
  if (!raw || raw.length === 0) return null;
  if (raw.length > MAX_COMPONENTS) return "invalid";
  const out: LineComponent[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    const id = c?.variant_id ?? c?.id;
    const quantity = num(c?.quantity);
    const weight = num(c?.final_line_price) ?? num(c?.line_price) ?? num(c?.original_line_price) ?? (num(c?.final_price ?? c?.price) != null && quantity ? num(c?.final_price ?? c?.price)! * quantity : null);
    if (id == null || !/^\d+$|^gid:\/\/shopify\/ProductVariant\/\d+$/.test(String(id)) || !quantity || quantity <= 0 || weight == null || weight < 0) return "invalid";
    out.push({ variantId: gidOf(id), quantity, weightCents: weight, title: typeof c.title === "string" ? c.title.slice(0, 200) : null });
  }
  if (out.reduce((s, c) => s + c.weightCents, 0) <= 0) return "invalid";
  return out;
}

function normalize(item: CartJsItem): Normalized {
  let allocated = 0;
  let automatic = 0;
  for (const a of item.line_level_discount_allocations ?? []) {
    const cents = Math.max(0, num(a?.amount) ?? 0);
    allocated += cents;
    if (a?.discount_application?.type === "automatic") automatic += cents;
  }
  return {
    variantId: gidOf(item.variant_id ?? item.id),
    quantity: Math.max(0, Math.floor(Number(item.quantity ?? 0))),
    properties: sanitizeProperties(item.properties),
    finalLineCents: num(item.final_line_price),
    allocatedCents: allocated,
    autoAllocatedCents: automatic,
    // has_components without a readable list: the AJAX cart doesn't give Cart Transform components.
    components: componentsOf(item) ?? (item.has_components === true ? "unresolved" : null),
    appQuantity: item.product_type === "PPLR_HIDDEN_PRODUCT" || /-sca_clone_freegift/.test(String(item.handle ?? "")),
    appGift: (() => {
      const k = kachingOf(item.properties);
      return (!!k && (k.gift != null || k.bxgy === true)) || sanitizeProperties(item.properties).some((p) => p.name === "_bogos_trigger_type" && p.value === "gift");
    })(),
    hint: propertyEntries(item.properties).some(([n]) => isBundleHintKey(n)),
    hidden: propertyEntries(item.properties).some(([n]) => n.startsWith("_")),
    shopifyOnly: item.selling_plan_allocation != null || item.gift_card === true,
  };
}

export type Reconciled =
  /** `matches`: the checkout's lines are exactly the cart's (its totals describe this checkout). */
  | { ok: true; lines: CartLine[]; adjustedCents: number; context: CartContext | null; matches: boolean }
  | { ok: false; reason: UnsupportedCartReason; detail?: string };

/** Two cart lines of a variant that are one line for the checkout (same properties and unit price). */
function mergeable(a: Normalized, b: Normalized): boolean {
  return (
    JSON.stringify(a.properties) === JSON.stringify(b.properties) &&
    !a.components &&
    !b.components &&
    a.appGift === b.appGift &&
    (a.finalLineCents == null) === (b.finalLineCents == null) &&
    (a.finalLineCents == null || (a.finalLineCents + a.allocatedCents) * b.quantity === (b.finalLineCents! + b.allocatedCents) * a.quantity)
  );
}

/**
 * Whether a lower cart price may be kept as an app's price: only on a sign the buyer can't forge —
 * bundle components Shopify expanded (their prices explain the parent's). An automatic discount
 * never explains a lower base price (deltaOf already adds every allocation back: what remains is
 * the line's own price, e.g. a Markets price list), and a hidden property alone (typed into a form,
 * added by a script) never lowers what is charged.
 */
const verifiedAppSign = (i: Normalized) => Array.isArray(i.components);

/**
 * Checkout lines (priced by the Admin API, shop currency) made faithful to the Shopify cart the
 * server re-read: properties, app prices (never above the variant's, lower only on a verified sign),
 * bundle components, locked quantities. Cart lines of one variant that differ (engravings, Kaching's
 * paid + free lines) become separate checkout lines. Refuses (→ Shopify's checkout) what it can't
 * represent. Pure.
 */
export function reconcileCart(cart: CartJs, lines: CartLine[], shopCurrency: string): Reconciled {
  const context = sanitizeCartContext(cart.note, cart.attributes);
  const items = (cart.items ?? []).map(normalize).filter((i) => i.quantity > 0);
  // A subscription line's price is its selling plan's (a one-time purchase at that price would be a
  // fraud), a gift card is issued by Shopify's checkout: neither can be sold here.
  const shopifyOnly = items.find((i) => i.shopifyOnly);
  if (shopifyOnly) return { ok: false, reason: "subscription", detail: shopifyOnly.variantId };

  // Cart lines per variant: identical ones merged, different ones kept apart (one checkout line each).
  const byVariant = new Map<string, Normalized[]>();
  for (const i of items) {
    const k = keyOf(i.variantId);
    const group = byVariant.get(k) ?? [];
    const same = group.find((p) => mergeable(p, i));
    if (same) {
      same.quantity += i.quantity;
      same.allocatedCents += i.allocatedCents;
      same.autoAllocatedCents += i.autoAllocatedCents;
      same.finalLineCents = same.finalLineCents == null ? null : same.finalLineCents + (i.finalLineCents ?? 0);
      same.appQuantity ||= i.appQuantity;
      same.hint ||= i.hint;
      same.hidden ||= i.hidden;
    } else group.push({ ...i });
    byVariant.set(k, group);
  }
  const entries = [...byVariant.values()].flat();
  // A bundle parent split over several lines: its components can't be told apart.
  for (const group of byVariant.values()) {
    if (group.length > 1 && group.some((i) => i.components)) return { ok: false, reason: "split_lines", detail: group[0].variantId };
  }

  const relevant = (i: Normalized) => !!i.components || i.appGift || i.hint || hasBundleHint(i.properties);
  const sameCurrency = String(cart.currency ?? "").toUpperCase() === shopCurrency.toUpperCase();
  if (!sameCurrency && entries.some(relevant)) return { ok: false, reason: "currency_mismatch", detail: String(cart.currency ?? "") };

  const lineOf = new Map(lines.map((l) => [keyOf(l.variantId), l]));
  for (const i of entries) {
    // A cart item Shopify's Admin API didn't price (unavailable, hidden bundle parent…).
    if (!lineOf.has(keyOf(i.variantId)) && relevant(i)) return { ok: false, reason: "unknown_line", detail: i.variantId };
  }
  const cartQty = (k: string) => (byVariant.get(k) ?? []).reduce((s, i) => s + i.quantity, 0);
  const matchesCart = lines.every((l) => l.gift || cartQty(keyOf(l.variantId)) === l.quantity) && [...byVariant.keys()].every((k) => lineOf.has(k));
  // What the cart charges less (> 0) or more (< 0) than the variant's price for a cart line.
  const deltaOf = (i: Normalized) => {
    const l = lineOf.get(keyOf(i.variantId));
    return !l || !sameCurrency || i.finalLineCents == null ? 0 : l.unitPriceCents * i.quantity - (i.finalLineCents + i.allocatedCents);
  };
  // The checkout's lines aren't this cart's: fine for plain lines at the variant's price, not for a
  // different cart price, an app's line or split lines.
  if (!matchesCart && (entries.some((i) => relevant(i) || deltaOf(i) !== 0) || [...byVariant.values()].some((g) => g.length > 1))) {
    return { ok: false, reason: "cart_changed" };
  }

  let adjustedCents = 0;
  const out: CartLine[] = [];
  for (const l of lines) {
    const group = byVariant.get(keyOf(l.variantId));
    // A bundle parent Shopify sells through its components only: ordering the parent alone would be wrong stock.
    if (l.requiresComponents && !l.gift && !group?.some((i) => Array.isArray(i.components))) {
      return { ok: false, reason: "bundle_components_unresolved", detail: l.variantId };
    }
    if (!group || l.gift) {
      out.push(l);
      continue;
    }
    const split = group.length > 1;
    for (const i of group) {
      let line: CartLine = { ...l, quantity: split ? i.quantity : l.quantity };
      if (i.properties.length) line.properties = i.properties;
      if (i.components === "invalid") return { ok: false, reason: "bundle_components_unpriced", detail: l.variantId };
      if (i.components === "unresolved") return { ok: false, reason: "bundle_components_unresolved", detail: l.variantId };
      if (sameCurrency && i.finalLineCents != null && i.quantity === line.quantity) {
        // What Shopify charges for the line before discounts: its final price plus every allocation.
        const delta = deltaOf(i);
        if (delta < 0) {
          // A higher cart price: an app's markup, or a price the merchant just changed. Charging the
          // variant's price would lose the markup; Shopify's checkout charges what the cart says.
          return { ok: false, reason: "price_higher", detail: l.variantId };
        } else if (delta > 0 && verifiedAppSign(i)) {
          if (delta % line.quantity !== 0) return { ok: false, reason: "price_not_divisible", detail: l.variantId };
          const unit = l.unitPriceCents - delta / line.quantity;
          line = {
            ...line,
            unitPriceCents: unit,
            compareAtCents: Math.max(l.compareAtCents ?? 0, l.unitPriceCents),
            appPrice: { unitCents: unit, originalUnitCents: l.unitPriceCents },
          };
          adjustedCents += delta;
        } else if (delta > 0) {
          // Lower without a verified sign (Markets / B2B price list, tax-inclusive pricing, or an app
          // key anyone could add): never kept, never charged above what the cart showed → Shopify's checkout.
          return { ok: false, reason: "price_unverified", detail: l.variantId };
        }
      }
      // An app's gift the cart doesn't discount automatically (lost its tags, or only a discount code
      // the checkout doesn't carry makes it free): the buyer would pay for it.
      if (i.appGift && i.autoAllocatedCents === 0 && !line.appPrice && line.unitPriceCents > 0) {
        return { ok: false, reason: "gift_not_discounted", detail: l.variantId };
      }
      if (i.components) {
        if (line.quantity !== 1) return { ok: false, reason: "bundle_quantity", detail: l.variantId };
        line.components = i.components;
      }
      if (i.appGift) line.appGift = true;
      // Kaching's discount-function mode: Shopify's automatic discount on an app's line (any hidden
      // key: an app's data, known or not) is its offer — frozen, left out of the checkout's own breaks.
      else if (!line.appPrice && i.autoAllocatedCents > 0 && (relevant(i) || i.hidden)) line.appDiscounted = true;
      if (split || line.properties || line.appPrice || line.components || i.appQuantity || i.appGift) line.locked = true;
      out.push(line);
    }
  }
  return { ok: true, lines: out, adjustedCents, context, matches: matchesCart };
}

/**
 * Discount codes the Shopify cart carries (applicable ones of `discount_codes`, and the titles of
 * code allocations): at most 3, 60 characters each. Pure.
 */
export function cartDiscountCodes(cart: CartJs): string[] {
  const codes: string[] = [];
  const add = (v: unknown) => {
    const c = typeof v === "string" ? v.trim() : "";
    if (c && c.length <= 60 && !codes.some((x) => x.toUpperCase() === c.toUpperCase())) codes.push(c);
  };
  for (const d of Array.isArray(cart.discount_codes) ? cart.discount_codes : []) if (d?.applicable !== false) add(d?.code);
  for (const it of cart.items ?? []) for (const a of it.line_level_discount_allocations ?? []) if (a?.discount_application?.type === "discount_code") add(a.discount_application.title);
  for (const app of cart.cart_level_discount_applications ?? []) if (app?.type === "discount_code") add(app.title);
  return codes.slice(0, 3);
}

/**
 * The discount codes that lowered the cart (line allocations and cart-level applications of type
 * discount_code), with their amounts, largest first. Pure.
 */
export function cartCodeAllocations(cart: CartJs): { code: string; cents: number }[] {
  const by = new Map<string, { code: string; cents: number }>();
  const add = (title: unknown, amount: unknown) => {
    const cents = Math.max(0, num(amount) ?? 0);
    const code = typeof title === "string" ? title.trim() : "";
    if (cents <= 0) return;
    const k = code.toUpperCase();
    const prev = by.get(k);
    by.set(k, { code: prev?.code ?? code, cents: (prev?.cents ?? 0) + cents });
  };
  for (const it of cart.items ?? []) for (const a of it.line_level_discount_allocations ?? []) if (a?.discount_application?.type === "discount_code") add(a.discount_application.title, a.amount);
  for (const app of cart.cart_level_discount_applications ?? []) if (app?.type === "discount_code") add(app.title, app.total_allocated_amount);
  return [...by.values()].sort((a, b) => b.cents - a.cents);
}

/**
 * Whether a checkout's lines hold for their exact cart only (no quantity change, no line removed or
 * added): an app's price, gift, discounted offer, bundle components, an app's hidden key, or one
 * variant split over several lines. A plain cart with a sitewide automatic discount isn't: a change
 * just drops that discount (it no longer describes the cart). Pure.
 */
export function cartHeldByApp(lines: CartLine[]): boolean {
  const buyer = lines.filter((l) => !l.gift);
  const keys = buyer.map((l) => keyOf(l.variantId));
  return (
    buyer.some((l) => !!l.appPrice || !!l.appGift || !!l.appDiscounted || !!l.components?.length || hasBundleHint(l.properties)) || new Set(keys).size !== keys.length
  );
}

/**
 * What Shopify's cart charges for the merchandise, discount codes left out: total_price plus every
 * non-automatic allocation. Null when unknown. A code that lowered the cart is checked apart: verified
 * reproducible when the checkout opens (else `code_unsupported`), then held to the cart's total_price
 * by the quote (CartContext.codeCheck). Pure.
 */
export function cartMerchandiseCents(cart: CartJs): number | null {
  const total = num(cart.total_price);
  if (total == null) return null;
  let codes = 0;
  for (const it of cart.items ?? []) {
    for (const a of it.line_level_discount_allocations ?? []) if (a?.discount_application?.type !== "automatic") codes += Math.max(0, num(a?.amount) ?? 0);
  }
  for (const app of cart.cart_level_discount_applications ?? []) if (app?.type !== "automatic") codes += Math.max(0, num(app?.total_allocated_amount) ?? 0);
  return total + codes;
}

/* ------------------------------------------------------------------ */
/* Known apps, unknown keys, diagnostic snapshot                        */
/* ------------------------------------------------------------------ */

const APP_SIGNALS: [app: string, test: (key: string) => boolean][] = [
  ["kaching", (k) => /^__kaching/.test(k)],
  ["bogos", (k) => /^_+bogos|^__freegift_attributes$/.test(k)],
  ["upcart", (k) => /^__upcart/i.test(k)],
  ["simple_bundles", (k) => /^_sb_/.test(k)],
  ["fast_bundle", (k) => /^_+(fb|fbb|fast_?bundle)/i.test(k)],
  ["zepto", (k) => /^_+pplr|^_?zepto/i.test(k)],
];

/**
 * Apps recognized in a cart (by their documented keys, product types, handles, Cart Transform
 * lines) and the hidden keys nobody recognized (journaled so they can be learned). Pure.
 */
export function detectCartApps(cart: CartJs): { apps: string[]; unknownKeys: string[] } {
  const apps = new Set<string>();
  const unknown = new Set<string>();
  const see = (key: string) => {
    if (!key.startsWith("_")) return;
    const hit = APP_SIGNALS.find(([, t]) => t(key));
    if (hit) apps.add(hit[0]);
    else unknown.add(key.slice(0, 60));
  };
  for (const it of cart.items ?? []) {
    for (const k of Object.keys(it.properties ?? {})) see(k);
    if (it.product_type === "PPLR_HIDDEN_PRODUCT") apps.add("zepto");
    if (/-sca_clone_freegift/.test(String(it.handle ?? ""))) apps.add("bogos");
    if (it.has_components === true || componentsOf(it)) apps.add("cart_transform");
    if ((it.line_level_discount_allocations ?? []).some((a) => a?.discount_application?.type === "automatic")) apps.add("automatic_discount");
    if ((it.line_level_discount_allocations ?? []).some((a) => a?.discount_application?.type === "discount_code")) apps.add("discount_code");
  }
  for (const k of Object.keys(cart.attributes ?? {})) see(k);
  if ((cart.cart_level_discount_applications ?? []).some((a) => a?.type === "automatic")) apps.add("automatic_discount");
  return { apps: [...apps].sort(), unknownKeys: [...unknown].sort().slice(0, 20) };
}

/**
 * The cart as the merchant can send it to support: amounts, variants, discount titles and hidden
 * app keys kept; the cart token dropped; what the buyer typed (visible properties, note, visible
 * attributes) replaced by its length. Pure.
 */
export function redactedCartSnapshot(cart: CartJs): Record<string, unknown> {
  const redact = (raw: Record<string, unknown> | null | undefined) =>
    Object.fromEntries(
      Object.entries(raw ?? {})
        .slice(0, 40)
        .map(([k, v]) => [k.slice(0, 120), k.startsWith("_") ? (str(v) ?? "").slice(0, 500) : `[${(str(v) ?? "").length} car.]`]),
    );
  return {
    currency: cart.currency ?? null,
    total_price: cart.total_price ?? null,
    note: cart.note ? `[${String(cart.note).length} car.]` : null,
    attributes: redact(cart.attributes),
    cart_level_discount_applications: (cart.cart_level_discount_applications ?? []).slice(0, 10).map((a) => ({ type: a?.type, title: a?.title, total_allocated_amount: a?.total_allocated_amount })),
    items: (cart.items ?? []).slice(0, 50).map((it) => ({
      variant_id: it.variant_id ?? it.id ?? null,
      quantity: it.quantity ?? null,
      handle: it.handle ?? null,
      product_type: it.product_type ?? null,
      price: it.price ?? null,
      final_price: it.final_price ?? null,
      final_line_price: it.final_line_price ?? null,
      original_line_price: it.original_line_price ?? null,
      has_components: it.has_components ?? null,
      components: Array.isArray(it.item_components ?? it.components) ? ((it.item_components ?? it.components) as unknown[]).length : null,
      properties: redact(it.properties),
      line_level_discount_allocations: (it.line_level_discount_allocations ?? []).slice(0, 10).map((a) => ({ amount: a?.amount, type: a?.discount_application?.type, title: a?.discount_application?.title })),
    })),
  };
}

/**
 * redactedCartSnapshot within `maxBytes` of JSON: fewer items, then items without properties, then
 * the cart-level summary only (`truncated` says what was cut). Pure.
 */
export function boundedCartSnapshot(cart: CartJs, maxBytes: number): Record<string, unknown> {
  const full = redactedCartSnapshot(cart);
  const size = (v: unknown) => JSON.stringify(v).length;
  if (size(full) <= maxBytes) return full;
  const items = full.items as Record<string, unknown>[];
  const lean = items.map((it) => ({ ...it, properties: `[${Object.keys((it.properties as Record<string, unknown>) ?? {}).length} propriétés]` }));
  for (const list of [items, lean]) {
    for (let n = list.length; n > 0; n = Math.floor(n / 2)) {
      const cut = { ...full, attributes: list === lean ? `[${Object.keys(full.attributes as object).length} attributs]` : full.attributes, items: list.slice(0, n), truncated: { items: items.length, kept: n } };
      if (size(cut) <= maxBytes) return cut;
    }
  }
  return { currency: full.currency, total_price: full.total_price, truncated: { items: items.length, kept: 0 } };
}

/**
 * Lines of a checkout created without a readable cart (buy now, cart unreadable): the properties
 * the storefront sent (never prices). Refuses a bundle app's line (its price can't be verified). Pure.
 */
export function withClientProperties(
  lines: CartLine[],
  items: { variant_id: string | number; properties?: unknown }[],
): { ok: true; lines: CartLine[] } | { ok: false; reason: UnsupportedCartReason; detail?: string } {
  const byVariant = new Map<string, LineProperty[]>();
  for (const it of items) {
    const k = keyOf(gidOf(it.variant_id));
    const props = sanitizeProperties(it.properties);
    const prev = byVariant.get(k);
    if (prev && JSON.stringify(prev) !== JSON.stringify(props)) return { ok: false, reason: "split_lines", detail: gidOf(it.variant_id) };
    byVariant.set(k, props);
  }
  if ([...byVariant.values()].some((p) => hasBundleHint(p))) return { ok: false, reason: "bundle_without_cart" };
  // A bundle parent sold through its components only, without components from a cart.
  const parent = lines.find((l) => l.requiresComponents && !l.gift && !l.components?.length);
  if (parent) return { ok: false, reason: "bundle_components_unresolved", detail: parent.variantId };
  return {
    ok: true,
    lines: lines.map((l) => {
      const props = byVariant.get(keyOf(l.variantId));
      return props?.length ? { ...l, properties: props, locked: true } : l;
    }),
  };
}

/**
 * After a re-pricing (quantity change, product added): each line keeps what the cart gave it
 * (properties, bundle components, locked quantity) and its app price stays capped at what the
 * cart showed — never above the variant's current price either — only while the lines are still
 * exactly the cart's. Pure.
 */
export function carryCartExtras(previous: CartLine[], priced: CartLine[]): CartLine[] {
  const prev = new Map(previous.map((l) => [keyOf(l.variantId), l]));
  // An app price holds for the cart it was computed on: once any line is removed, added or changed,
  // every line goes back to the variant's price (the checkout freezes such carts anyway).
  const sameCart = previous.length === priced.length && priced.every((l) => prev.get(keyOf(l.variantId))?.quantity === l.quantity);
  return priced.map((l) => {
    const p = prev.get(keyOf(l.variantId));
    if (!p) return l;
    const line: CartLine = { ...l };
    if (p.properties?.length) line.properties = p.properties;
    if (p.components?.length) line.components = p.components;
    if (p.locked) line.locked = true;
    if (p.appGift) line.appGift = true;
    if (p.appDiscounted) line.appDiscounted = true;
    if (sameCart && p.appPrice && p.appPrice.unitCents < l.unitPriceCents) {
      line.appPrice = { unitCents: p.appPrice.unitCents, originalUnitCents: l.unitPriceCents };
      line.compareAtCents = Math.max(l.compareAtCents ?? 0, l.unitPriceCents);
      line.unitPriceCents = p.appPrice.unitCents;
    }
    return line;
  });
}

/**
 * Splits `totalCents` over the components in proportion to their weights (largest remainders:
 * the parts add up exactly). Pure.
 */
export function splitOverComponents(totalCents: number, components: LineComponent[]): number[] {
  const weight = components.reduce((s, c) => s + Math.max(0, c.weightCents), 0);
  if (weight <= 0) {
    const base = Math.floor(totalCents / components.length);
    return components.map((_, i) => base + (i < totalCents - base * components.length ? 1 : 0));
  }
  const exact = components.map((c) => (totalCents * Math.max(0, c.weightCents)) / weight);
  const parts = exact.map(Math.floor);
  let rest = totalCents - parts.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rest > 0 && k < order.length; k++, rest--) parts[order[k][1]]++;
  return parts;
}
