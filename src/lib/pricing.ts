/**
 * Pure checkout math. Every amount is an integer number of minor units (cents)
 * so totals never drift through floating point. Nothing here trusts the browser:
 * lines come from Shopify's Admin API, rates/codes/add-ons from the database.
 */

export type CartLine = {
  variantId: string; // gid://shopify/ProductVariant/…
  productId: string;
  productHandle: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPriceCents: number;
  compareAtCents: number | null;
  inventory: number | null; // null when not tracked
  requiresShipping: boolean;
  /** Shopify unit cost (margin analytics); null when not set. */
  unitCostCents?: number | null;
  /** Free gift of a quantity-break tier: priced 0, compareAtCents = its real price. Never a buyer line. */
  gift?: boolean;
  /** Shopify gift card product (sold on Shopify's checkout only). */
  giftCard?: boolean;
  /**
   * Line item properties of the Shopify cart line (personalization, bundle apps' hidden `_…` keys),
   * copied to the Shopify order line. Never priced: they change nothing to the amounts here.
   */
  properties?: LineProperty[];
  /**
   * Unit price an app set on the Shopify cart (Cart Transform: bundle / "merge" modes), lower than
   * the variant's price, as re-read server-side from /cart.js. `unitPriceCents` is already that
   * price; `originalUnitCents` is the variant's own price (shown struck through, journaled).
   */
  appPrice?: { unitCents: number; originalUnitCents: number };
  /** An app's free gift from the Shopify cart (Kaching gift / BXGY, BOGOS): never counts for the checkout's own offers. */
  appGift?: boolean;
  /**
   * A bundle / offer app's line Shopify discounts automatically (Kaching discount-function mode: an
   * app's hidden key plus an automatic allocation): already an offer, left out of the checkout's own.
   */
  appDiscounted?: boolean;
  /**
   * Bundle parent expanded by Shopify (Cart Transform): the order gets these component variants
   * (inventory), sharing the line's paid amount in proportion to `weightCents` (their prices in
   * the cart). `quantity` is the component's total quantity for the whole line.
   */
  components?: LineComponent[];
  /** Quantity fixed by the Shopify cart (app pricing, properties, bundle): changed from the cart only. */
  locked?: boolean;
  /**
   * Shopify's ProductVariant.requiresComponents: a bundle parent sold only through its components
   * (Shopify Bundles, Cart Transform). Without components from the cart it can't be ordered here.
   */
  requiresComponents?: boolean;
};

export type LineProperty = { name: string; value: string };
export type LineComponent = { variantId: string; quantity: number; weightCents: number; title?: string | null };

/** Properties shown to the buyer: Shopify hides the ones whose name starts with "_". Pure. */
export function visibleProperties(l: Pick<CartLine, "properties">): LineProperty[] {
  return (l.properties ?? []).filter((p) => p && typeof p.name === "string" && !p.name.startsWith("_") && typeof p.value === "string" && p.value !== "");
}

export type RateInput = {
  id: string;
  name: string;
  deliveryTime: string | null;
  countries: string[];
  priceCents: number;
  freeOverCents: number | null;
  active: boolean;
  /** "home" | "pickup" (relay point chosen on the checkout). */
  kind?: string;
};

export type DiscountInput = {
  code: string;
  type: "PERCENT" | "FIXED" | "FREE_SHIPPING";
  value: number;
  minSubtotalCents: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  usageCount: number;
  active: boolean;
  /**
   * Share (0–1) of the merchandise the code applies to, when it is limited to some products
   * (Shopify codes scoped to products / collections); absent = all of it.
   */
  scopeShare?: number;
  /**
   * The lines (variant ids) the code applies to, when it is limited to some products: the code is
   * then computed on those lines' own value left after the automatic and quantity-break discounts
   * allocated to each line (not on a share of the whole cart's remainder).
   */
  eligibleVariantIds?: string[];
  /** Free shipping only for rates up to this price (Shopify's "maximum shipping price"). */
  maxShippingCents?: number;
  /**
   * Shopify's discount class: "product" (amount off products, buy X get Y), "order" (amount off
   * the order) or "shipping". Absent: order for PERCENT / FIXED, shipping for FREE_SHIPPING.
   */
  discountClass?: DiscountClass;
  /** Shopify's combinesWith of the code (absent = combines with everything, the app's default). */
  combinesWith?: Combines;
  /** App codes: "cumulable avec les remises quantité" (absent = true). */
  combinesWithBreaks?: boolean;
};

/* ------------------------------------------------------------------ */
/* Discount stacking (Shopify's combinesWith)                           */
/* ------------------------------------------------------------------ */

export type DiscountClass = "product" | "order" | "shipping";
export type Combines = { product: boolean; order: boolean; shipping: boolean };
export const COMBINES_ALL: Combines = { product: true, order: true, shipping: true };

/** Class of a code: its Shopify class, else order (percent / fixed) or shipping (free shipping). Pure. */
export function codeClass(d: Pick<DiscountInput, "type" | "discountClass">): DiscountClass {
  return d.discountClass ?? (d.type === "FREE_SHIPPING" ? "shipping" : "order");
}

/**
 * One discount of the stack. `combinesWith` is its rule against each class (Shopify semantics);
 * `withBreaks` / `withCodes` override it against the app's quantity breaks / the code, for the
 * settings that only concern those (app code "cumulable avec les remises quantité", store setting).
 */
export type StackPart = { key: "automatic" | "breaks" | "code"; cls: DiscountClass; combinesWith: Combines; withBreaks?: boolean; withCodes?: boolean };

function accepts(x: StackPart, y: StackPart): boolean {
  if (y.key === "breaks" && x.withBreaks != null) return x.withBreaks;
  if (y.key === "code" && x.withCodes != null) return x.withCodes;
  return x.combinesWith[y.cls];
}

/** Two discounts combine when each allows the other's class (like Shopify). Pure. */
export function canCombine(a: StackPart, b: StackPart): boolean {
  return accepts(a, b) && accepts(b, a);
}

/** Every subset of the parts whose members all combine pairwise (the empty set included). Pure. */
export function combinableSets<T extends StackPart>(parts: T[]): T[][] {
  const out: T[][] = [];
  for (let mask = 0; mask < 1 << parts.length; mask++) {
    const set = parts.filter((_, i) => mask & (1 << i));
    if (set.every((a, i) => set.slice(i + 1).every((b) => canCombine(a, b)))) out.push(set);
  }
  return out;
}

export type AddOnInput = { id: string; title: string; priceCents: number; active: boolean };

export type Totals = {
  subtotalCents: number;
  /** Includes the automatic quantity-break discount (volumeDiscountCents). */
  discountCents: number;
  volumeDiscountCents?: number;
  /** Shopify automatic discounts of the cart (part of discountCents). */
  automaticDiscountCents?: number;
  /** The discount code's part of discountCents. */
  codeDiscountCents?: number;
  shippingCents: number;
  /** Order bumps, shipping protection included (protectionCents). */
  addOnsCents: number;
  /** Shipping protection (part of addOnsCents). */
  protectionCents?: number;
  totalCents: number;
  itemCount: number;
  /**
   * Discounts left out because they don't combine (Shopify's combinesWith, the app's settings):
   * the best combination for the buyer was kept, like Shopify does.
   */
  dropped?: ("automatic" | "breaks" | "code")[];
};

/** Why a cart must stay on Shopify's checkout (subscription or gift card line), or null. Pure. */
export function unsupportedCart(items: { selling_plan?: string | number | null; gift_card?: boolean }[]): "selling_plan" | "gift_card" | null {
  if (items.some((i) => i.selling_plan != null && String(i.selling_plan) !== "")) return "selling_plan";
  if (items.some((i) => i.gift_card === true)) return "gift_card";
  return null;
}

export function subtotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
}

/** Items the buyer chose (free gifts are not counted). */
export function itemCount(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + (l.gift ? 0 : l.quantity), 0);
}

export type DiscountCheck = { ok: true } | { ok: false; reason: string };

export function checkDiscount(d: DiscountInput, subtotalCents: number, now = new Date()): DiscountCheck {
  if (!d.active) return { ok: false, reason: "Ce code n'est plus actif" };
  if (d.startsAt && now < d.startsAt) return { ok: false, reason: "Ce code n'est pas encore valable" };
  if (d.endsAt && now > d.endsAt) return { ok: false, reason: "Ce code a expiré" };
  if (d.usageLimit != null && d.usageCount >= d.usageLimit) return { ok: false, reason: "Ce code a atteint sa limite" };
  if (d.minSubtotalCents != null && subtotalCents < d.minSubtotalCents)
    return { ok: false, reason: "Le montant minimum pour ce code n'est pas atteint" };
  return { ok: true };
}

/** Discount applied to merchandise only (never shipping or add-ons). */
export function discountAmount(d: DiscountInput | null, subtotalCents: number): number {
  if (!d) return 0;
  // A code limited to some products only discounts their share of the merchandise.
  const base = d.scopeShare != null ? Math.round(subtotalCents * clamp(d.scopeShare, 0, 1)) : subtotalCents;
  if (d.type === "PERCENT") return Math.min(base, Math.round((base * clamp(d.value, 0, 100)) / 100));
  if (d.type === "FIXED") return Math.min(base, Math.max(0, d.value));
  return 0;
}

export function ratesForCountry(rates: RateInput[], country: string | null): RateInput[] {
  return rates.filter((r) => r.active && (r.countries.length === 0 || (country != null && r.countries.includes(country))));
}

export function shippingAmount(
  rate: RateInput | null,
  discountedSubtotalCents: number,
  discount: DiscountInput | null,
  needsShipping: boolean,
): number {
  if (!needsShipping || !rate) return 0;
  if (discount?.type === "FREE_SHIPPING" && (discount.maxShippingCents == null || rate.priceCents <= discount.maxShippingCents)) return 0;
  if (rate.freeOverCents != null && discountedSubtotalCents >= rate.freeOverCents) return 0;
  return rate.priceCents;
}

/* ------------------------------------------------------------------ */
/* Quantity breaks v2 (Store.quantityBreaks JSON)                      */
/* ------------------------------------------------------------------ */

/**
 * "Buy 2, save 10%": automatic tiers on the number of items. `productIds` scopes a tier
 * to some products (a hand-picked "collection"): only those items count, and only their
 * subtotal is discounted. Stored as `[{minQty, percent, productIds?}]` (older stores: no scope).
 *
 * Formats (`kind`, absent = "percent"):
 *  - "percent": −percent % on the scoped subtotal from minQty items;
 *  - "amount": −amountCents per item (`per: "unit"`) or per complete group of minQty items
 *    (`per: "bundle"`), from minQty items;
 *  - "price": every complete group of minQty items costs priceCents ("2 pour 49 €"); the most
 *    expensive items are grouped first, the rest stays at its price;
 *  - "bxgy": buy minQty, get freeQty free: for every minQty + freeQty items, the freeQty
 *    cheapest are free.
 * A tier never discounts more than its scope's subtotal, and never a free gift.
 */
export type BreakKind = "percent" | "amount" | "price" | "bxgy";
export type QuantityBreak = {
  minQty: number;
  percent: number;
  productIds?: string[];
  kind?: BreakKind;
  /** "amount": cents off (per item or per group of minQty items). */
  amountCents?: number;
  per?: "unit" | "bundle";
  /** "price": price of a group of minQty items. */
  priceCents?: number;
  /** "bxgy": items offered for every minQty bought. */
  freeQty?: number;
};

export const breakKind = (b: Pick<QuantityBreak, "kind">): BreakKind => b.kind ?? "percent";

/** Items needed to reach a tier (bxgy: the bought + the free ones). Pure. */
export function tierThreshold(b: QuantityBreak): number {
  return breakKind(b) === "bxgy" ? b.minQty + (b.freeQty ?? 1) : b.minQty;
}

/**
 * Free gift tier: from `minQty` items or `minSubtotalCents` (merchandise before discounts,
 * scoped like a break), the gift variant is added at 0 (priced by Shopify, shown at its real
 * price struck through). Stored as `{type: "gift", minQty | minSubtotalCents, variantId, title}`.
 */
export type GiftTier = {
  type: "gift";
  minQty?: number;
  minSubtotalCents?: number;
  variantId: string;
  title: string;
  productIds?: string[];
  /** Name in the buyer's language: { [lang]: { title } } (the Shopify line keeps the product's own title). */
  i18n?: Record<string, { title: string }>;
};

/** Checkout languages a gift name can be translated to (same codes as components/checkout/i18n). */
const GIFT_LANGS = new Set(["fr", "en", "de", "es", "it", "nl"]);

/** Valid gift-name translations, or undefined. Pure. */
export function giftI18nOf(raw: unknown): Record<string, { title: string }> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, { title: string }> = {};
  for (const [lang, v] of Object.entries(raw as Record<string, unknown>)) {
    const t = v && typeof v === "object" ? (v as { title?: unknown }).title : undefined;
    if (GIFT_LANGS.has(lang) && typeof t === "string" && t.trim()) out[lang] = { title: t.trim().slice(0, 120) };
  }
  return Object.keys(out).length ? out : undefined;
}

/** A gift tier's name in the buyer's language (the merchant's translation, else the name as typed). Pure. */
export function giftTitle(tier: Pick<GiftTier, "title" | "i18n">, lang: string | null | undefined): string {
  return (lang && tier.i18n?.[lang]?.title) || tier.title;
}

export const MAX_PERCENT_TIERS = 20;
export const MAX_GIFT_TIERS = 10;
/**
 * Bounds of a tier (server validation and dashboard fields): discount up to 90 %, a tier from 2
 * to 1 000 items (a gift from 1), "X bought" up to 100 with up to 50 free.
 */
export const TIER_LIMITS = { maxPercent: 90, maxQty: 1000, maxBuy: 100, maxFree: 50 } as const;
const MAX_SCOPE_PRODUCTS = 50;

/** "gid://shopify/Product/123" and "123" name the same product. */
export const productKey = (id: string) => id.trim().match(/(\d+)\D*$/)?.[1] ?? id.trim();

function scopeOf(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = [...new Set(raw.filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter((x) => x && x.length <= 120))].slice(0, MAX_SCOPE_PRODUCTS);
  return ids.length ? ids : undefined;
}

function variantGid(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(t)) return t;
  return /^\d{1,20}$/.test(t) ? `gid://shopify/ProductVariant/${t}` : null;
}

const isGiftRaw = (b: unknown) => !!b && typeof b === "object" && (b as { type?: unknown }).type === "gift";

const MAX_TIER_CENTS = 10_000_000;

/** A tier of any format with valid values, or null. Pure. */
function parseBreak(r: Record<string, unknown>): QuantityBreak | null {
  const kind = r.kind == null ? "percent" : r.kind;
  const minQty = Math.floor(Number(r.minQty));
  let tier: QuantityBreak;
  if (kind === "percent") {
    const percent = Number(r.percent);
    if (!(minQty >= 2 && minQty <= TIER_LIMITS.maxQty && percent > 0 && percent <= TIER_LIMITS.maxPercent)) return null;
    tier = { minQty, percent };
  } else if (kind === "amount") {
    const amountCents = Math.round(Number(r.amountCents));
    const per = r.per === "bundle" ? "bundle" : r.per === "unit" ? "unit" : null;
    if (!(minQty >= 2 && minQty <= TIER_LIMITS.maxQty && per && amountCents >= 1 && amountCents <= MAX_TIER_CENTS)) return null;
    tier = { minQty, percent: 0, kind, amountCents, per };
  } else if (kind === "price") {
    const priceCents = Math.round(Number(r.priceCents));
    if (!(minQty >= 2 && minQty <= TIER_LIMITS.maxQty && priceCents >= 1 && priceCents <= MAX_TIER_CENTS)) return null;
    tier = { minQty, percent: 0, kind, priceCents };
  } else if (kind === "bxgy") {
    const freeQty = Math.floor(Number(r.freeQty ?? 1));
    if (!(minQty >= 1 && minQty <= TIER_LIMITS.maxBuy && freeQty >= 1 && freeQty <= TIER_LIMITS.maxFree)) return null;
    tier = { minQty, percent: 0, kind, freeQty };
  } else return null;
  const scope = scopeOf(r.productIds);
  if (scope) tier.productIds = scope;
  return tier;
}

/** Discount tiers of Store.quantityBreaks, every format (gift tiers are read by parseGiftTiers). */
export function parseQuantityBreaks(raw: unknown): QuantityBreak[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((b) => !isGiftRaw(b))
    .map((b) => parseBreak((b ?? {}) as Record<string, unknown>))
    .filter((b): b is QuantityBreak => !!b)
    .sort((a, b) => tierThreshold(a) - tierThreshold(b));
}

/** Gift tiers of Store.quantityBreaks; invalid entries are dropped. */
export function parseGiftTiers(raw: unknown): GiftTier[] {
  if (!Array.isArray(raw)) return [];
  const gifts: GiftTier[] = [];
  for (const b of raw) {
    if (!isGiftRaw(b)) continue;
    const r = b as Record<string, unknown>;
    const variantId = variantGid(r.variantId);
    const title = typeof r.title === "string" ? r.title.trim().slice(0, 120) : "";
    if (!variantId || !title) continue;
    const tier: GiftTier = { type: "gift", variantId, title };
    const qty = Math.floor(Number(r.minQty));
    const cents = Math.round(Number(r.minSubtotalCents));
    if (r.minQty != null && qty >= 1 && qty <= TIER_LIMITS.maxQty) tier.minQty = qty;
    else if (r.minSubtotalCents != null && cents >= 1 && cents <= 100_000_000) tier.minSubtotalCents = cents;
    else continue;
    const scope = scopeOf(r.productIds);
    if (scope) tier.productIds = scope;
    const i18n = giftI18nOf(r.i18n);
    if (i18n) tier.i18n = i18n;
    gifts.push(tier);
  }
  return gifts.slice(0, MAX_GIFT_TIERS);
}

export function parseQuantityTiers(raw: unknown): { breaks: QuantityBreak[]; gifts: GiftTier[] } {
  return { breaks: parseQuantityBreaks(raw), gifts: parseGiftTiers(raw) };
}

/** Buyer lines a tier applies to: all of them, or only the scoped products. Gifts never count. */
export function scopedLines(lines: CartLine[], productIds?: string[]): CartLine[] {
  const buyer = lines.filter((l) => !l.gift);
  if (!productIds?.length) return buyer;
  const keys = new Set(productIds.map(productKey));
  return buyer.filter((l) => keys.has(productKey(l.productId || "")));
}

/**
 * Server-side validation of a quantity-breaks payload (dashboard save): the stored JSON,
 * or a message. Percent tiers: 2–100 items, 0–50 %, unique per scope, bigger quantity =
 * bigger discount. Gift tiers: one threshold, a variant and a title.
 */
export function validateQuantityTiers(raw: unknown): { ok: true; tiers: (QuantityBreak | GiftTier)[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "Paliers illisibles" };
  const percents = raw.filter((b) => !isGiftRaw(b));
  const giftsRaw = raw.filter(isGiftRaw);
  if (percents.length > MAX_PERCENT_TIERS) return { ok: false, error: `${MAX_PERCENT_TIERS} paliers de remise maximum` };
  if (giftsRaw.length > MAX_GIFT_TIERS) return { ok: false, error: `${MAX_GIFT_TIERS} cadeaux maximum` };
  for (const r of percents) {
    if (parseBreak((r ?? {}) as Record<string, unknown>)) continue;
    const kind = (r as { kind?: unknown })?.kind;
    // A bundle-price tier saved without its price: say exactly what's missing.
    const price = Number((r as { priceCents?: unknown })?.priceCents);
    if (kind === "price" && !(price > 0)) return { ok: false, error: "Indiquez le prix du lot (ex. 2 pour 49 €)" };
    return {
      ok: false,
      error:
        kind === "amount"
          ? `Palier « montant » invalide : 2 à ${TIER_LIMITS.maxQty} articles, un montant de plus de 0, par article ou par lot`
          : kind === "price"
            ? `Palier « prix du lot » invalide : 2 à ${TIER_LIMITS.maxQty} articles et un prix de plus de 0 (ex. 2 pour 49 €)`
            : kind === "bxgy"
              ? `Palier « X achetés, Y offerts » invalide : 1 à ${TIER_LIMITS.maxBuy} achetés, 1 à ${TIER_LIMITS.maxFree} offerts`
              : `Palier de remise invalide : 2 à ${TIER_LIMITS.maxQty} articles, remise de plus de 0 et au plus ${TIER_LIMITS.maxPercent} %`,
    };
  }
  const breaks = parseQuantityBreaks(percents);
  for (const b of breaks) if (breakKind(b) === "percent" && !Number.isInteger(b.percent * 10)) return { ok: false, error: "Remise : une décimale au plus (ex. 12,5)" };
  // Per scope: unique thresholds (two tiers at one quantity: which one applies is ambiguous). A
  // bigger quantity giving a smaller discount is the merchant's choice: tierOrderWarnings says so.
  for (const list of tiersByScope(breaks)) {
    for (let i = 1; i < list.length; i++) {
      if (tierThreshold(list[i]) === tierThreshold(list[i - 1])) return { ok: false, error: `Il y a déjà un palier dès ${tierThreshold(list[i])} articles` };
    }
  }
  const gifts = parseGiftTiers(giftsRaw);
  if (gifts.length !== giftsRaw.length) return { ok: false, error: "Cadeau invalide : choisissez un produit, un nom et un seuil (articles ou montant)" };
  return { ok: true, tiers: [...breaks, ...gifts] };
}

/** Tiers grouped by product scope (same products = same group), each sorted by threshold. Pure. */
function tiersByScope(breaks: QuantityBreak[]): QuantityBreak[][] {
  const byScope = new Map<string, QuantityBreak[]>();
  for (const b of breaks) {
    const key = (b.productIds ?? []).map(productKey).sort().join(",");
    byScope.set(key, [...(byScope.get(key) ?? []), b]);
  }
  return [...byScope.values()].map((list) => [...list].sort((a, b) => tierThreshold(a) - tierThreshold(b)));
}

/**
 * Information lines (dashboard, plain grey text, never a warning): a percent tier for more items
 * that gives no more than the tier before it (buyers who add items would not save more). Saving
 * is never refused for it. Pure.
 */
export function tierOrderWarnings(breaks: QuantityBreak[]): string[] {
  const out: string[] = [];
  for (const list of tiersByScope(breaks)) {
    const pcts = list.filter((b) => breakKind(b) === "percent");
    for (let i = 1; i < pcts.length; i++) {
      if (pcts[i].percent <= pcts[i - 1].percent)
        out.push(`Palier dès ${pcts[i].minQty} articles : ${String(pcts[i].percent).replace(".", ",")} %, pas plus que le palier précédent (${String(pcts[i - 1].percent).replace(".", ",")} %)`);
    }
  }
  return out;
}

/** The tier reached (best percent) and the next one, for "add 1 more item to save 15%". */
export function quantityBreakFor(breaks: QuantityBreak[], items: number): { current: QuantityBreak | null; next: QuantityBreak | null } {
  const reached = breaks.filter((b) => items >= b.minQty);
  const current = reached.reduce<QuantityBreak | null>((best, b) => (!best || b.percent > best.percent ? b : best), null);
  const next = breaks.find((b) => b.minQty > items && b.percent > (current?.percent ?? 0)) ?? null;
  return { current, next };
}

/** Unit prices of the scoped items, most expensive first (one entry per item). */
function unitPrices(lines: CartLine[]): number[] {
  return lines.flatMap((l) => Array.from({ length: Math.max(0, l.quantity) }, () => l.unitPriceCents)).sort((a, b) => b - a);
}

/** Discount of one tier on these lines (its scope only; 0 below its threshold). Pure. */
export function breakDiscountCents(tier: QuantityBreak, lines: CartLine[]): number {
  const scoped = scopedLines(lines, tier.productIds);
  const sub = subtotal(scoped);
  const items = itemCount(scoped);
  const kind = breakKind(tier);
  if (kind === "percent") return Math.min(sub, Math.round((sub * tier.percent) / 100));
  if (items < tierThreshold(tier)) return 0;
  if (kind === "amount") {
    const times = tier.per === "bundle" ? Math.floor(items / tier.minQty) : items;
    return Math.min(sub, times * (tier.amountCents ?? 0));
  }
  const prices = unitPrices(scoped);
  if (kind === "price") {
    let off = 0;
    const groups = Math.floor(items / tier.minQty);
    for (let g = 0; g < groups; g++) {
      const group = prices.slice(g * tier.minQty, (g + 1) * tier.minQty).reduce((a, b) => a + b, 0);
      off += Math.max(0, group - (tier.priceCents ?? group));
    }
    return Math.min(sub, off);
  }
  // bxgy: for every minQty + freeQty items, the freeQty cheapest of the cart are free.
  const free = Math.floor(items / tierThreshold(tier)) * (tier.freeQty ?? 1);
  return Math.min(sub, prices.slice(prices.length - free).reduce((a, b) => a + b, 0));
}

/** "2 pour 49 €"-style description parts of a tier, for the checkout and the dashboard. Pure. */
export type BreakDeal =
  | { kind: "percent"; percent: number }
  | { kind: "amount"; amountCents: number; per: "unit" | "bundle"; minQty: number }
  | { kind: "price"; minQty: number; priceCents: number }
  | { kind: "bxgy"; buy: number; free: number };

export function breakDeal(b: QuantityBreak): BreakDeal {
  switch (breakKind(b)) {
    case "amount":
      return { kind: "amount", amountCents: b.amountCents ?? 0, per: b.per === "bundle" ? "bundle" : "unit", minQty: b.minQty };
    case "price":
      return { kind: "price", minQty: b.minQty, priceCents: b.priceCents ?? 0 };
    case "bxgy":
      return { kind: "bxgy", buy: b.minQty, free: b.freeQty ?? 1 };
    default:
      return { kind: "percent", percent: b.percent };
  }
}

/**
 * Lines the checkout's own quantity breaks and gifts count and discount: an app's bundle price or
 * gift already is an offer (no combination rules with ours: counting them would discount twice). Pure.
 */
export function offerBaseLines(lines: CartLine[]): CartLine[] {
  return lines.filter((l) => !l.gift && !l.appPrice && !l.appGift && !l.appDiscounted);
}

/**
 * Scoped version of quantityBreakFor: each tier counts its own items. The reached tier
 * with the biggest discount applies; `next` is the closest better tier and `missing`
 * the items still to add (in its scope).
 */
export function quantityBreakForLines(
  breaks: QuantityBreak[],
  lines: CartLine[],
): { current: QuantityBreak | null; next: QuantityBreak | null; missing: number | null } {
  let current: QuantityBreak | null = null;
  let best = -1;
  for (const b of breaks) {
    if (itemCount(scopedLines(lines, b.productIds)) < tierThreshold(b)) continue;
    const cents = breakDiscountCents(b, lines);
    // A tier that saves nothing on this cart (e.g. a bundle price above the items' price) isn't "reached".
    if (cents <= 0 && breakKind(b) !== "percent") continue;
    if (cents > best || (cents === best && current && b.percent > current.percent)) {
      best = cents;
      current = b;
    }
  }
  let next: QuantityBreak | null = null;
  let missing: number | null = null;
  for (const b of breaks) {
    const gap = tierThreshold(b) - itemCount(scopedLines(lines, b.productIds));
    if (gap <= 0) continue;
    // Only a better tier is worth a nudge: a bigger percent, or (other formats) a bigger threshold than the reached one.
    if (current && (breakKind(b) === "percent" && breakKind(current) === "percent" ? b.percent <= current.percent : tierThreshold(b) <= tierThreshold(current))) continue;
    if (missing == null || gap < missing || (gap === missing && next && b.percent > next.percent)) {
      next = b;
      missing = gap;
    }
  }
  return { current, next, missing };
}

/** Gifts earned by these lines, and the closest one still to earn ("12 € more for …"). */
export function giftProgress(
  gifts: GiftTier[],
  lines: CartLine[],
): { earned: GiftTier[]; next: { tier: GiftTier; missingQty: number | null; missingCents: number | null } | null } {
  const earned: GiftTier[] = [];
  let next: { tier: GiftTier; missingQty: number | null; missingCents: number | null } | null = null;
  let nextRatio = Infinity;
  for (const g of gifts) {
    const scoped = scopedLines(lines, g.productIds);
    const have = g.minQty != null ? itemCount(scoped) : subtotal(scoped);
    const need = g.minQty ?? g.minSubtotalCents ?? Infinity;
    if (have >= need) {
      if (!earned.some((e) => e.variantId === g.variantId)) earned.push(g);
      continue;
    }
    // Closest in relative terms (items and amounts don't compare directly).
    const ratio = (need - have) / need;
    if (ratio < nextRatio) {
      nextRatio = ratio;
      next = { tier: g, missingQty: g.minQty != null ? need - have : null, missingCents: g.minQty == null ? need - have : null };
    }
  }
  if (next && earned.some((e) => e.variantId === next!.tier.variantId)) next = null;
  return { earned, next };
}

/** The Shopify-priced gift variant as an order line: free, its real price shown struck through. */
export function giftLine(priced: CartLine): CartLine {
  return { ...priced, quantity: 1, unitPriceCents: 0, compareAtCents: priced.unitPriceCents > 0 ? priced.unitPriceCents : null, gift: true };
}

/* ------------------------------------------------------------------ */
/* Shipping protection (checkout block, priced server-side)            */
/* ------------------------------------------------------------------ */

/** Amounts in major units (like the layout): fixed price, or a percent of the merchandise with min/max (0 = no max). */
export type ProtectionPricing = { priceMode: "fixed" | "percent"; price: number; percent: number; minPrice: number; maxPrice: number };

/** Price of the shipping protection for this merchandise amount (after discounts). */
export function protectionPriceCents(p: ProtectionPricing, merchandiseCents: number): number {
  if (merchandiseCents <= 0) return 0;
  if (p.priceMode === "fixed") return Math.max(0, Math.round(p.price * 100));
  let cents = Math.round((merchandiseCents * clamp(p.percent, 0, 100)) / 100);
  const min = Math.max(0, Math.round(p.minPrice * 100));
  const max = Math.round(p.maxPrice * 100);
  if (cents < min) cents = min;
  if (max > 0 && cents > max) cents = Math.max(min, max);
  return cents;
}

export function computeTotals(input: {
  lines: CartLine[];
  rate: RateInput | null;
  discount: DiscountInput | null;
  addOns: AddOnInput[];
  quantityBreaks?: QuantityBreak[];
  /** Shipping protection chosen by the buyer (priced on the discounted merchandise). */
  protection?: ProtectionPricing | null;
  /** Automatic discounts Shopify computed for this exact cart (verified server-side), cents. */
  automaticDiscountCents?: number;
  /** Class and combinesWith of those automatic discounts (Admin API); absent = combine with everything. */
  automaticStack?: { cls: DiscountClass; combinesWith: Combines } | null;
  /** Store setting: the quantity breaks stack with discount codes (absent = true). */
  breaksCombineWithCodes?: boolean;
  /** Shopify's automatic discount per line (variant id → cents), when known; else spread by value. */
  automaticLineCents?: Record<string, number>;
}): Totals {
  const sub = subtotal(input.lines);
  const needsShipping = input.lines.some((l) => l.requiresShipping);
  const automaticCents = Math.min(sub, Math.max(0, Math.round(input.automaticDiscountCents ?? 0)));
  const offerLines = offerBaseLines(input.lines);
  const tier = quantityBreakForLines(input.quantityBreaks ?? [], offerLines).current;
  const tierCents = tier ? breakDiscountCents(tier, offerLines) : 0;

  // The discounts present, with their stacking rules. Order of application: Shopify's automatic
  // discounts, then the quantity break, then the code on what remains (never beyond the subtotal).
  const parts: StackPart[] = [];
  if (automaticCents > 0) parts.push({ key: "automatic", cls: input.automaticStack?.cls ?? "product", combinesWith: input.automaticStack?.combinesWith ?? COMBINES_ALL });
  if (tierCents > 0) parts.push({ key: "breaks", cls: "product", combinesWith: COMBINES_ALL, withCodes: input.breaksCombineWithCodes ?? true });
  if (input.discount) {
    parts.push({
      key: "code",
      cls: codeClass(input.discount),
      combinesWith: input.discount.combinesWith ?? COMBINES_ALL,
      ...(input.discount.combinesWithBreaks === false ? { withBreaks: false } : {}),
    });
  }

  const evaluate = (set: StackPart[]) => {
    const has = (k: StackPart["key"]) => set.some((p) => p.key === k);
    const auto = has("automatic") ? automaticCents : 0;
    const volume = has("breaks") ? Math.min(sub - auto, tierCents) : 0;
    const code = has("code") ? input.discount : null;
    const codeCents =
      code?.eligibleVariantIds && code.type !== "FREE_SHIPPING"
        ? discountAmount({ ...code, scopeShare: undefined }, eligibleRemaining(input.lines, code.eligibleVariantIds, auto, input.automaticLineCents, volume, tier))
        : discountAmount(code, sub - auto - volume);
    const discountCents = auto + volume + codeCents;
    const shippingCents = shippingAmount(input.rate, sub - discountCents, code, needsShipping);
    return { set, auto, volume, codeCents, discountCents, shippingCents, saved: discountCents - shippingCents };
  };
  // Best combination for the buyer (most saved, shipping included); on a tie, the one with more discounts.
  let best = evaluate(parts);
  if (!combinableSets(parts).some((set) => set.length === parts.length)) {
    best = combinableSets(parts)
      .map(evaluate)
      .reduce((a, b) => (b.saved > a.saved || (b.saved === a.saved && b.set.length > a.set.length) ? b : a));
  }
  const dropped = parts.filter((p) => !best.set.includes(p)).map((p) => p.key);
  const { auto: automaticDiscountCents, volume: volumeDiscountCents, codeCents: codeDiscountCents, discountCents, shippingCents } = best;
  const protectionCents = input.protection && needsShipping ? protectionPriceCents(input.protection, sub - discountCents) : 0;
  const addOnsCents = input.addOns.filter((a) => a.active).reduce((s, a) => s + a.priceCents, 0) + protectionCents;
  return {
    subtotalCents: sub,
    discountCents,
    volumeDiscountCents,
    ...(automaticDiscountCents > 0 ? { automaticDiscountCents } : {}),
    ...(codeDiscountCents > 0 ? { codeDiscountCents } : {}),
    shippingCents,
    addOnsCents,
    ...(protectionCents > 0 ? { protectionCents } : {}),
    totalCents: sub - discountCents + shippingCents + addOnsCents,
    itemCount: itemCount(input.lines),
    ...(dropped.length ? { dropped } : {}),
  };
}

/**
 * Value left on the lines a product-scoped code applies to, after the automatic discount (per line
 * when Shopify said, else spread by value over the buyer's lines) and the quantity break (spread
 * over its own scope's lines) are taken off each line. Pure.
 */
export function eligibleRemaining(
  lines: CartLine[],
  eligibleVariantIds: string[],
  automaticCents: number,
  automaticLineCents: Record<string, number> | undefined,
  volumeCents: number,
  tier: QuantityBreak | null,
): number {
  const left = lines.map((l) => (l.gift ? 0 : l.unitPriceCents * l.quantity));
  const take = (idx: number[], cents: number) => {
    if (cents <= 0 || !idx.length) return;
    const parts = allocateDiscount(idx.map((i) => lines[i]), cents);
    idx.forEach((i, k) => (left[i] = Math.max(0, left[i] - parts[k])));
  };
  const buyer = lines.map((l, i) => (l.gift ? -1 : i)).filter((i) => i >= 0);
  if (automaticCents > 0) {
    const known = automaticLineCents ? Object.entries(automaticLineCents) : [];
    if (known.length) {
      // Shopify's own allocation, capped at the automatic total actually applied.
      let budget = automaticCents;
      for (const [variantId, cents] of known) {
        const idx = buyer.filter((i) => productKey(lines[i].variantId) === productKey(variantId));
        const part = Math.min(budget, Math.max(0, Math.round(cents)));
        take(idx, part);
        budget -= part;
      }
      if (budget > 0) take(buyer, budget);
    } else take(buyer, automaticCents);
  }
  if (volumeCents > 0 && tier) {
    const scoped = new Set(scopedLines(offerBaseLines(lines), tier.productIds));
    take(buyer.filter((i) => scoped.has(lines[i])), volumeCents);
  }
  const eligible = new Set(eligibleVariantIds.map(productKey));
  return buyer.filter((i) => eligible.has(productKey(lines[i].variantId))).reduce((n, i) => n + left[i], 0);
}

/** Distributes a merchandise discount across lines (largest remainder), for Shopify line prices. */
export function allocateDiscount(lines: CartLine[], discountCents: number): number[] {
  const totals = lines.map((l) => l.unitPriceCents * l.quantity);
  const sum = totals.reduce((a, b) => a + b, 0);
  if (sum === 0 || discountCents === 0) return lines.map(() => 0);
  const raw = totals.map((t) => (t * discountCents) / sum);
  const floored = raw.map(Math.floor);
  let remainder = discountCents - floored.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (remainder <= 0) break;
    floored[i] += 1;
    remainder -= 1;
  }
  return floored;
}

export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function decimalToCents(value: string | number): number {
  return Math.round(Number(value) * 100);
}

export function formatMoney(cents: number, currency: string, locale = "fr-FR"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
