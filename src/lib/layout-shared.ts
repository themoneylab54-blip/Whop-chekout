import type { BlockOf, ExpressMethods, HeaderMode, ReviewItem, Theme } from "./layout";

/*
 * The layout's constants and pure helpers that run in the buyer's browser (checkout blocks,
 * express buttons, post-purchase offers), without zod: layout.ts builds every schema with zod
 * when it loads, so a single value imported from there ships zod and all the schemas with the
 * page. layout.ts re-exports everything here (server code and tests import from "@/lib/layout"
 * as before); the types stay there, imported with `import type` (erased at build). Imports no
 * runtime value from a module that imports zod.
 */

/* ---------- Express payment buttons (top of the checkout) ---------- */

/** Whop's express wallets, one button each (PayPal is our own button next to them). */
export const EXPRESS_WALLETS = ["apple-pay", "google-pay", "whop-pay"] as const;
export type ExpressWallet = (typeof EXPRESS_WALLETS)[number];

/**
 * The merchant's express buttons as expressMethodsSchema.parse (layout.ts) reads them, without zod:
 * each field falls back to its default on its own (missing, undefined or a stray value), unknown
 * keys are dropped, and anything but an object throws. Kept in step with the schema by
 * tests/layout-shared.test.ts. Pure.
 */
export function expressMethodsOf(raw: unknown): ExpressMethods {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new TypeError("Express buttons: an object is expected");
  const m = raw as Record<string, unknown>;
  const on = (v: unknown) => (typeof v === "boolean" ? v : true);
  const googlePay = (v: unknown): ExpressMethods["googlePay"] => (v === "off" || v === "auto" || v === "always" ? v : "auto");
  // Read in the schema's key order, once each.
  return { applePay: on(m.applePay), googlePay: googlePay(m.googlePay), whopPay: on(m.whopPay), paypal: on(m.paypal) };
}

/**
 * The express buttons to show, from the merchant's choice and the cart. Pure.
 * `paypal` is the merchant's permission only: Whop must also offer PayPal on the store.
 */
export function expressMethodsShown(
  settings: Partial<ExpressMethods> | null | undefined,
  cart: { shippable: boolean },
): { wallets: ExpressWallet[]; paypal: boolean } {
  // Parsed, never spread: a key left undefined or holding a stray value gets its default.
  const s = expressMethodsOf(settings ?? {});
  const googlePay = s.googlePay === "always" || (s.googlePay === "auto" && !cart.shippable);
  const on: Record<ExpressWallet, boolean> = { "apple-pay": s.applePay, "google-pay": googlePay, "whop-pay": s.whopPay };
  return { wallets: EXPRESS_WALLETS.filter((m) => on[m]), paypal: s.paypal };
}

/**
 * Whether the cart has anything to ship, for expressMethodsShown: the buyer's lines and the free
 * gifts (they ship too), a line at quantity 0 (being removed) counting for nothing. Pure.
 */
export function cartShippable(...groups: readonly (readonly { requiresShipping?: boolean; quantity: number }[])[]): boolean {
  return groups.some((lines) => lines.some((l) => !!l.requiresShipping && l.quantity > 0));
}

/**
 * Apple Pay / Google Pay logos next to the Payment title: only wallets the buyer can really use.
 * Off when the express section is off or a relay point is chosen (the wallets are hidden then);
 * live (`rendered` = the wallets whose Whop button actually showed on this device), only those;
 * in the builder preview (`rendered` = null), the merchant's settings. Pure.
 */
export function offeredWalletsFor(opts: {
  walletsOn: boolean;
  pickupSelected: boolean;
  configured: readonly ExpressWallet[];
  rendered: readonly ExpressWallet[] | null;
}): { applePay: boolean; googlePay: boolean } {
  const on = (m: ExpressWallet) => opts.walletsOn && !opts.pickupSelected && opts.configured.includes(m) && (opts.rendered === null || opts.rendered.includes(m));
  return { applePay: on("apple-pay"), googlePay: on("google-pay") };
}

/* ---------- Theme ---------- */

/**
 * The header's content. Themes saved before the choice existed keep their look: a logo URL
 * means "logo", otherwise the store name. A banner without an image falls back the same way.
 */
export function headerModeOf(theme: Pick<Theme, "headerMode" | "logoUrl" | "bannerUrl">): HeaderMode {
  if (theme.headerMode === "banner") return theme.bannerUrl ? "banner" : theme.logoUrl ? "logo" : "name";
  if (theme.headerMode) return theme.headerMode;
  return theme.logoUrl ? "logo" : "name";
}

/**
 * Self-hosted stylesheet for a theme font (latin + latin-ext, 400–700, font-display: swap).
 * Files live in public/fonts: no request to Google Fonts from the checkout (GDPR).
 */
export function fontHref(font: Theme["font"]) {
  if (font === "System") return null;
  return `/fonts/${font.toLowerCase().replace(/\s+/g, "-")}.css`;
}

/* ---------- Blocks: limits and pure helpers ---------- */

/** Units a buyer may take in one click. */
export const MAX_OFFER_QUANTITY = 50;

/** Most reviews in one "Avis clients" block. */
export const MAX_REVIEW_ITEMS = 300;
/** Longest review fields the schema accepts (the builder's fields stop there, imports cut there). */
export const REVIEW_LIMITS = { name: 120, text: 5000, title: 300 } as const;

/**
 * "Achat vérifié" comes only from a review app (CSV export or Judge.me): a review typed in the
 * builder (source manual or none) is never shown as verified, whatever was saved.
 */
export function honestReviewItem<T extends Pick<ReviewItem, "verified" | "source"> & Partial<Pick<ReviewItem, "text" | "stars" | "importSig">>>(item: T): T {
  if (!item.verified) return item;
  const imported = item.source === "csv" || item.source === "judgeme";
  // Imported then rewritten (text or stars no longer as the customer wrote them): not verified.
  const rewritten = imported && !!item.importSig && reviewSignature({ stars: item.stars ?? 0, text: item.text ?? "" }) !== item.importSig;
  return imported && !rewritten ? item : { ...item, verified: false };
}

/**
 * Fingerprint (FNV-1a, 8 hex) of a review's stars and text, whitespace and line endings
 * normalized: a fixed typo in spacing does not count as a rewrite, a changed word does.
 */
export function reviewSignature(item: { stars: number; text: string }): string {
  const s = `${item.stars}|${item.text.replace(/\s+/g, " ").trim()}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Longest free text of the survey's "other" answer (normalizeSurveyAnswer). */
export const SURVEY_OTHER_MAX = 80;

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

/* ---------- "Note globale" (rating) block ---------- */

/** True once the block has a real score to show (1 to 5: a 0 is "no rating", never shown to buyers). */
export function ratingIsSet(props: BlockOf<"rating">["props"]): props is BlockOf<"rating">["props"] & { score: number } {
  return typeof props.score === "number" && Number.isFinite(props.score) && props.score >= 1;
}

/**
 * "4,8" (fr), "4.8" (en), "4,8" (de): one decimal in the buyer's locale, floored (4.96 → "4,9",
 * never rounded up to "5,0": a score is never shown higher than it is).
 */
export function formatRatingScore(score: number, locale: string): string {
  const floored = Number.isFinite(score) ? Math.floor(score * 10 + 1e-9) / 10 : score;
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(floored);
}

/* ------------------------------------------------------------------ */
/* Post-purchase funnels: "Yes" → acceptNextId, "No thanks" → declineNextId */
/* ------------------------------------------------------------------ */

/** Offers one buyer can see in a row in one slot (the root and four follow-ups). */
export const MAX_OFFER_DEPTH = 5;

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
