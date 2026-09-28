import "server-only";
import { extFetch } from "./ext";
import type { Store } from "@prisma/client";
import { shopifyGraphql } from "./shopify";
import { db } from "./db";
import { log, recordEvent } from "./log";
import { recordIncident } from "./incidents";
import { externalCoveredUntil, externalImportStatus } from "./shopify-history";
import { rateLimit } from "./ratelimit";
import { productKey, subtotal, type CartLine, type Combines, type DiscountClass, type DiscountInput } from "./pricing";
import { cartMerchandiseCents, reconcileCart, type CartContext, type CartJs as FidelityCartJs, type UnsupportedCartReason } from "./cart-fidelity";

/*
 * Shopify's own discounts on the Whop checkout.
 *
 * 1. Discount codes created in Shopify (not in the app's "Codes promo" list): looked up with the
 *    Admin API (`codeDiscountNodeByCode`, scope read_discounts) and applied by the quote when they
 *    are an "amount off products" (percentage / fixed amount, once or on each item) or a free
 *    shipping code, for all buyers, active, under their usage limit, with their minimum (subtotal
 *    or quantity), their product / variant / collection scope and shipping countries. "Once per
 *    customer" is checked on this app's own paid orders with the buyer's e-mail. Buy X get Y,
 *    app-function discounts and codes limited to customer segments are refused (they can't be
 *    verified here). The code is recorded on the Shopify order as the order's discount code.
 *
 * 2. Automatic discounts: only the amounts Shopify itself computed for the buyer's cart
 *    (/cart.js), re-read server-side with the cart token (never the browser's figures), and only
 *    while the checkout's lines are exactly that cart's lines. A changed quantity drops them.
 *
 * Lookups are cached briefly in memory (per instance): codes 60 s, collections 10 min.
 */

const CODE_TTL_MS = 60_000;
const COLLECTIONS_TTL_MS = 10 * 60_000;
const CACHE_MAX = 500;

type Scope = { productIds: string[]; variantIds: string[]; collectionIds: string[] };

export type ShopifyCodeDiscount = {
  code: string;
  title: string;
  type: DiscountInput["type"];
  /** percent 0–100, or cents (fixed amount). */
  value: number;
  /** Fixed amount taken off each eligible item instead of once. */
  appliesOnEachItem: boolean;
  minSubtotalCents: number | null;
  minQuantity: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  usageCount: number;
  active: boolean;
  oncePerCustomer: boolean;
  /** Eligible items: null = all; else product / variant / collection ids (GIDs). */
  scope: Scope | null;
  /** Free shipping: countries (ISO) it applies to, null = all. */
  countries: string[] | null;
  /** Free shipping: maximum shipping price covered (cents), null = any. */
  maxShippingCents: number | null;
  /** Shopify class: amount off products / buy X get Y = "product", amount off order = "order", free shipping = "shipping". */
  discountClass: DiscountClass;
  /** Shopify's combinesWith (what the code stacks with); null when Shopify didn't say (combine). */
  combinesWith: Combines | null;
  /** Buy X get Y: what must be bought, what is discounted and how (amount computed per cart). */
  bxgy?: Bxgy;
  /** When Shopify was asked (usageCount is as of then); set by lookupShopifyCode. */
  checkedAt?: Date;
};

/** The read_discounts scope was granted (Shopify codes can be looked up). Pure. */
export function canReadShopifyDiscounts(store: { shopifyScopes?: string | null }): boolean {
  return (store.shopifyScopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .some((s) => s === "read_discounts" || s === "write_discounts");
}

export type Bxgy = {
  /** Items to buy (quantity) or amount to spend (cents) on the "buy" items. */
  buyQuantity: number | null;
  buyAmountCents: number | null;
  buyScope: Scope | null;
  /** Items discounted per application, and the effect on each (percent 0–100, or cents). */
  getQuantity: number;
  getScope: Scope | null;
  percent: number | null;
  amountCents: number | null;
  /** Amount effect: off each discounted item (true) or once per application. */
  amountEach: boolean;
  /** Maximum applications per order (null = as many as the cart allows). */
  usesPerOrderLimit: number | null;
};

/** Why a Shopify code was refused (null = usable as parsed). */
/** "unavailable": Shopify couldn't be asked (outage, scope missing) — not the buyer's fault. */
export type Unsupported = "not_found" | "unsupported_type" | "customer_restricted" | "currency" | "unavailable";

type Money = { amount?: string | number; currencyCode?: string } | null | undefined;
const cents = (m: Money) => (m?.amount == null ? null : Math.round(Number(m.amount) * 100));

type ItemsNode = { __typename?: string; products?: { nodes?: { id: string }[] }; productVariants?: { nodes?: { id: string }[] }; collections?: { nodes?: { id: string }[] } } | undefined;
function scopeOf(items: ItemsNode): Scope | null {
  const ids = (c?: { nodes?: { id: string }[] }) => (c?.nodes ?? []).map((n) => n.id);
  return items?.__typename === "DiscountProducts"
    ? { productIds: ids(items.products), variantIds: ids(items.productVariants), collectionIds: [] }
    : items?.__typename === "DiscountCollections"
      ? { productIds: [], variantIds: [], collectionIds: ids(items.collections) }
      : null;
}

/** Shopify's `combinesWith` object, or null when absent. Pure. */
export function combinesOf(raw: unknown): Combines | null {
  const c = raw as { productDiscounts?: unknown; orderDiscounts?: unknown; shippingDiscounts?: unknown } | null | undefined;
  if (!c || typeof c !== "object") return null;
  return { product: c.productDiscounts === true, order: c.orderDiscounts === true, shipping: c.shippingDiscounts === true };
}

/** Parses the `codeDiscountNodeByCode` answer. Pure, exported for tests. */
export function parseCodeDiscount(code: string, data: unknown, shopCurrency: string): ShopifyCodeDiscount | Unsupported {
  const node = (data as { codeDiscountNodeByCode?: { codeDiscount?: Record<string, unknown> | null } | null } | null)?.codeDiscountNodeByCode;
  const d = node?.codeDiscount as Record<string, unknown> | undefined | null;
  if (!d) return "not_found";
  const type = d.__typename;
  if (type !== "DiscountCodeBasic" && type !== "DiscountCodeFreeShipping" && type !== "DiscountCodeBxgy") return "unsupported_type";
  // Codes limited to some customers or segments can't be checked before the payment.
  if ((d.context as { __typename?: string } | undefined)?.__typename !== "DiscountBuyerSelectionAll") return "customer_restricted";
  const min = d.minimumRequirement as { __typename?: string; greaterThanOrEqualToSubtotal?: Money; greaterThanOrEqualToQuantity?: string | number } | null;
  if (min?.__typename === "DiscountMinimumSubtotal" && min.greaterThanOrEqualToSubtotal?.currencyCode && min.greaterThanOrEqualToSubtotal.currencyCode !== shopCurrency) return "currency";
  // The code as written in Shopify (lookups are case-insensitive), recorded on the order.
  const canonical = (d.codes as { nodes?: { code?: string }[] } | undefined)?.nodes?.find((n) => n.code?.toUpperCase() === code.toUpperCase())?.code;
  const base = {
    code: canonical ?? code.toUpperCase(),
    title: String(d.title ?? code),
    minSubtotalCents: min?.__typename === "DiscountMinimumSubtotal" ? cents(min.greaterThanOrEqualToSubtotal) : null,
    minQuantity: min?.__typename === "DiscountMinimumQuantity" ? Math.floor(Number(min.greaterThanOrEqualToQuantity)) || null : null,
    startsAt: d.startsAt ? new Date(String(d.startsAt)) : null,
    endsAt: d.endsAt ? new Date(String(d.endsAt)) : null,
    usageLimit: d.usageLimit == null ? null : Number(d.usageLimit),
    usageCount: Number(d.asyncUsageCount ?? 0),
    active: d.status === "ACTIVE",
    oncePerCustomer: !!d.appliesOncePerCustomer,
    combinesWith: combinesOf(d.combinesWith),
  };
  if (type === "DiscountCodeFreeShipping") {
    const dest = d.destinationSelection as { __typename?: string; countries?: string[]; includeRestOfWorld?: boolean } | undefined;
    return {
      ...base,
      type: "FREE_SHIPPING",
      value: 0,
      appliesOnEachItem: false,
      scope: null,
      countries: dest?.__typename === "DiscountCountries" && !dest.includeRestOfWorld ? (dest.countries ?? []).map((c) => String(c).toUpperCase()) : null,
      maxShippingCents: cents(d.maximumShippingPrice as Money),
      discountClass: "shipping",
    };
  }
  if (type === "DiscountCodeBxgy") {
    const buys = d.customerBuys as { value?: Record<string, unknown>; items?: ItemsNode } | undefined;
    const gets = d.customerGets as { value?: Record<string, unknown>; items?: ItemsNode } | undefined;
    const bv = buys?.value;
    const buyQuantity = bv?.__typename === "DiscountQuantity" ? Math.floor(Number(bv.quantity)) || null : null;
    // DiscountPurchaseAmount.amount is a Decimal in the shop's currency.
    const buyAmountCents = bv?.__typename === "DiscountPurchaseAmount" && bv.amount != null ? Math.round(Number(bv.amount) * 100) : null;
    const gv = gets?.value;
    if (gv?.__typename !== "DiscountOnQuantity" || (!buyQuantity && !buyAmountCents)) return "unsupported_type";
    const getQuantity = Math.floor(Number((gv.quantity as { quantity?: unknown } | undefined)?.quantity)) || 0;
    const effect = gv.effect as Record<string, unknown> | undefined;
    let percent: number | null = null;
    let amountCents: number | null = null;
    let amountEach = true;
    if (effect?.__typename === "DiscountPercentage") percent = Math.round(Number(effect.percentage) * 10_000) / 100;
    else if (effect?.__typename === "DiscountAmount") {
      const m = effect.amount as Money;
      if (m?.currencyCode && m.currencyCode !== shopCurrency) return "currency";
      amountCents = cents(m) ?? 0;
      amountEach = effect.appliesOnEachItem !== false;
    } else return "unsupported_type";
    if (getQuantity < 1 || !((percent ?? 0) > 0 || (amountCents ?? 0) > 0)) return "unsupported_type";
    const limit = d.usesPerOrderLimit == null ? null : Math.floor(Number(d.usesPerOrderLimit)) || null;
    return {
      ...base,
      // The amount depends on the cart: computed by bxgyDiscountCents when the code is applied.
      type: "FIXED",
      value: 0,
      appliesOnEachItem: false,
      scope: scopeOf(gets?.items),
      countries: null,
      maxShippingCents: null,
      discountClass: "product",
      bxgy: { buyQuantity, buyAmountCents, buyScope: scopeOf(buys?.items), getQuantity, getScope: scopeOf(gets?.items), percent, amountCents, amountEach, usesPerOrderLimit: limit },
    };
  }
  const gets = d.customerGets as { value?: Record<string, unknown>; items?: ItemsNode } | undefined;
  const value = gets?.value;
  let kind: "PERCENT" | "FIXED";
  let amount: number;
  let each = false;
  if (value?.__typename === "DiscountPercentage") {
    kind = "PERCENT";
    // Shopify gives 0.1 for 10 %.
    amount = Math.round(Number(value.percentage) * 10_000) / 100;
  } else if (value?.__typename === "DiscountAmount") {
    const m = value.amount as Money;
    if (m?.currencyCode && m.currencyCode !== shopCurrency) return "currency";
    kind = "FIXED";
    amount = cents(m) ?? 0;
    each = !!value.appliesOnEachItem;
  } else return "unsupported_type";
  const scope = scopeOf(gets?.items);
  // "Amount off order" discounts apply to all items (AllDiscountItems); "amount off products" to a selection.
  const discountClass: DiscountClass = gets?.items?.__typename === "AllDiscountItems" || !gets?.items?.__typename ? "order" : "product";
  return { ...base, type: kind, value: amount, appliesOnEachItem: each, scope, countries: null, maxShippingCents: null, discountClass };
}

const COMBINES = `combinesWith { productDiscounts orderDiscounts shippingDiscounts }`;
const ITEMS = `__typename ... on DiscountProducts { products(first: 100) { nodes { id } } productVariants(first: 100) { nodes { id } } } ... on DiscountCollections { collections(first: 50) { nodes { id } } }`;

export const CODE_QUERY = `query($code: String!, $search: String) {
  codeDiscountNodeByCode(code: $code) {
    id
    codeDiscount {
      __typename
      ... on DiscountCodeBasic {
        title status startsAt endsAt usageLimit asyncUsageCount appliesOncePerCustomer
        codes(first: 1, query: $search) { nodes { code } }
        context { __typename }
        ${COMBINES}
        minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } } ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity } }
        customerGets {
          value { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem } }
          items { ${ITEMS} }
        }
      }
      ... on DiscountCodeBxgy {
        title status startsAt endsAt usageLimit asyncUsageCount appliesOncePerCustomer usesPerOrderLimit
        codes(first: 1, query: $search) { nodes { code } }
        context { __typename }
        ${COMBINES}
        customerBuys {
          value { __typename ... on DiscountQuantity { quantity } ... on DiscountPurchaseAmount { amount } }
          items { ${ITEMS} }
        }
        customerGets {
          value { __typename ... on DiscountOnQuantity { quantity { quantity } effect { __typename ... on DiscountPercentage { percentage } ... on DiscountAmount { amount { amount currencyCode } appliesOnEachItem } } } }
          items { ${ITEMS} }
        }
      }
      ... on DiscountCodeFreeShipping {
        title status startsAt endsAt usageLimit asyncUsageCount appliesOncePerCustomer
        codes(first: 1, query: $search) { nodes { code } }
        context { __typename }
        ${COMBINES}
        minimumRequirement { __typename ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount currencyCode } } ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity } }
        destinationSelection { __typename ... on DiscountCountries { countries includeRestOfWorld } }
        maximumShippingPrice { amount }
      }
    }
  }
}`;

type Cached<T> = { at: number; value: T };
const codeCache = new Map<string, Cached<ShopifyCodeDiscount | Unsupported>>();
const collectionCache = new Map<string, Cached<string[]>>();
/** Negative cache of failed lookups (Shopify down, scope missing): key → failure time. */
const failedLookups = new Map<string, number>();
const LOOKUP_FAILURE_TTL_MS = 30_000;

function remember<T>(map: Map<string, Cached<T>>, key: string, value: T) {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value as string);
  map.set(key, { at: Date.now(), value });
}

/** Test hook: forget every cached lookup. */
export function clearShopifyDiscountCache() {
  codeCache.clear();
  collectionCache.clear();
  autoCache.clear();
  failedLookups.clear();
}

type LookupStore = Pick<Store, "id" | "shopDomain" | "shopifyAccessToken" | "shopCurrency">;

/** lookupShopifyCode, asked once more (past the failure cache) when Shopify couldn't answer. */
export async function lookupShopifyCodeWithRetry(store: LookupStore, code: string): Promise<ShopifyCodeDiscount | Unsupported> {
  const first = await lookupShopifyCode(store, code);
  return first === "unavailable" ? lookupShopifyCode(store, code, { retry: true }) : first;
}

/**
 * The Shopify discount behind a code (cached 60 s, misses too), or why it can't be used. A
 * Shopify failure (missing read_discounts scope, outage) is "unavailable" (cached 30 s), journaled.
 */

export async function lookupShopifyCode(store: LookupStore, code: string, opts: { retry?: boolean } = {}): Promise<ShopifyCodeDiscount | Unsupported> {
  const key = `${store.id}:${code.trim().toUpperCase()}`;
  const hit = codeCache.get(key);
  if (hit && Date.now() - hit.at < CODE_TTL_MS) return hit.value;
  // A recent lookup failure: answered from memory for 30 s (an outage isn't hammered per keystroke),
  // except for the one retry of a code the Shopify cart carried (`retry`).
  const failed = failedLookups.get(key);
  if (failed && !opts.retry && Date.now() - failed < LOOKUP_FAILURE_TTL_MS) return "unavailable";
  let value: ShopifyCodeDiscount | Unsupported;
  try {
    value = parseCodeDiscount(code.trim(), await shopifyGraphql(store, CODE_QUERY, { code: code.trim(), search: `code:${JSON.stringify(code.trim())}` }), store.shopCurrency);
  } catch (err) {
    if (failedLookups.size >= CACHE_MAX) failedLookups.delete(failedLookups.keys().next().value as string);
    failedLookups.set(key, Date.now());
    await recordIncident({
      storeId: store.id,
      kind: "discount.shopify_lookup_failed",
      message: `Code promo Shopify impossible à vérifier (Shopify injoignable ou autorisation read_discounts manquante) : l'acheteur est invité à réessayer. ${err instanceof Error ? err.message.slice(0, 200) : ""}`.trim(),
      data: { err: err instanceof Error ? err.message : String(err) },
    });
    return "unavailable";
  }
  // When it was read: the usage count is Shopify's as of now (the paid order's ledger counts from here).
  if (typeof value !== "string") {
    value.checkedAt = new Date();
    // A fresh count from Shopify: learn whether it includes the orders this app creates (once per store).
    await calibrateShopifyCodeCount(store.id, value.code, value.usageCount).catch((err) =>
      log.warn("discount.calibration_failed", "Could not calibrate Shopify's code usage count", { storeId: store.id, err }),
    );
  }
  remember(codeCache, key, value);
  return value;
}

/** A use is compared with Shopify's count once this old (asyncUsageCount is updated asynchronously). */
export const CALIBRATION_SETTLE_MS = 10 * 60_000;
/** Shopify's count still not risen this long after a use: it doesn't count the orders this app creates. */
export const CALIBRATION_GIVE_UP_MS = 60 * 60_000;
/** A decision is checked again this often (and at once when Shopify's count contradicts it). */
export const CALIBRATION_RECHECK_MS = 30 * 86_400_000;

/**
 * One observation of Shopify's count against a reference use. `verified`: final. A "counts" (true)
 * observation first waits for the outside orders import to cover its window (no outside use of the
 * code there, else it is dropped as inconclusive).
 */
export type CalibrationVote = { ref: string; code: string; decision: boolean; windowFrom: number; windowTo: number; verified: boolean };
export type CalibrationState = { votes: CalibrationVote[]; /** Last time the decision was confirmed (or taken). */ checkedAt?: number };

const calibrationKey = (storeId: string) => `shopify-code-calibration:${storeId}`;

async function readCalibration(storeId: string): Promise<CalibrationState> {
  const row = await db.appSetting.findUnique({ where: { key: calibrationKey(storeId) } });
  try {
    const v = row ? (JSON.parse(row.value) as CalibrationState) : null;
    return v && Array.isArray(v.votes) ? v : { votes: [] };
  } catch {
    return { votes: [] };
  }
}

async function writeCalibration(storeId: string, state: CalibrationState) {
  const key = calibrationKey(storeId);
  const value = JSON.stringify({ ...state, votes: state.votes.slice(-6) });
  await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

/**
 * What Shopify's count says about one reference use (pure): Shopify's count rose by exactly our uses
 * since the reference → "counts" (still to be verified against the outside orders of the window);
 * rose by less than our uses CALIBRATION_GIVE_UP_MS after it → "doesn't count" (final: outside uses
 * only ever add); anything else (more than ours: outside uses or both, or too early) → nothing.
 */
export function calibrationObservation(o: { rise: number; ours: number; ageMs: number }): boolean | null {
  if (o.ours <= 0) return null;
  if (o.rise === o.ours) return true;
  if (o.rise < o.ours && o.ageMs >= CALIBRATION_GIVE_UP_MS) return false;
  return null;
}

/**
 * The decision the verified votes support (pure): two votes of different references agreeing (the
 * latest two distinct ones), else null. A vote contradicting an earlier one leaves no decision.
 */
export function calibrationDecision(votes: CalibrationVote[]): boolean | null {
  const verified = votes.filter((v) => v.verified);
  const last = verified.at(-1);
  if (!last) return null;
  const other = [...verified].reverse().find((v) => v.ref !== last.ref);
  return other && other.decision === last.decision ? last.decision : null;
}

/**
 * Per-store calibration of shopifyCodeUses: whether Shopify's asyncUsageCount counts the orders this
 * app creates (orderCreate). Called with each fresh count read from Shopify (lookupShopifyCode).
 *  - Reference = the latest use of the code whose Shopify order exists, at least CALIBRATION_SETTLE_MS
 *    old, with Shopify's count read before it (ShopifyCodeUse.shopifyCountBefore); `rise` = Shopify's
 *    count now minus that one, `ours` = our uses of the code since (with their order).
 *  - "Counts" only on an exact match (rise = ours) AND no order placed outside this checkout with that
 *    code in the window (ExternalOrder.discountCodes, once the daily import has covered the window:
 *    until then the vote waits) — a use in Shopify's own checkout, the POS or a draft would otherwise
 *    look like one of ours. "Doesn't count" when the count rose by less than ours an hour later.
 *  - Decided only when two different references agree; journaled.
 *  - Re-checked every 30 days, and at once when a count contradicts "counts" (Shopify's count below our
 *    own settled uses): a contradiction resets it to unknown (uses added again, the safe side).
 * Returns the decision taken now (true / false), or null.
 */
export async function calibrateShopifyCodeCount(storeId: string, code: string, usageCount: number, now = Date.now()): Promise<boolean | null> {
  const store = await db.store.findUnique({ where: { id: storeId }, select: { shopifyCountsApiOrders: true } });
  if (!store) return null;
  const current = store.shopifyCountsApiOrders;
  const upper = code.trim().toUpperCase();
  const state = await readCalibration(storeId);
  const withOrder = async (sessionIds: string[]) =>
    new Set((await db.checkoutSession.findMany({ where: { id: { in: sessionIds } , shopifyOrderId: { not: null } }, select: { id: true } })).map((x) => x.id));

  // "Counts" contradicted: Shopify's count is below our own settled uses of the code (it can't be, if
  // it counted them). Back to unknown at once (safe: uses added).
  if (current === true) {
    const settled = await db.shopifyCodeUse.findMany({ where: { storeId, code: upper, createdAt: { lte: new Date(now - CALIBRATION_SETTLE_MS) } }, select: { sessionId: true }, take: 500 });
    const counted = (await withOrder(settled.map((u) => u.sessionId))).size;
    if (counted > usageCount) {
      await resetCalibration(storeId, current, state, `code ${upper} : ${usageCount} utilisation(s) selon Shopify pour ${counted} commande(s) créée(s) ici`);
      return null;
    }
  }
  const recheckDue = current == null || !state.checkedAt || now - state.checkedAt >= CALIBRATION_RECHECK_MS;

  // New observation from this count.
  if (recheckDue) {
    const uses = await db.shopifyCodeUse.findMany({
      where: { storeId, code: upper, createdAt: { lte: new Date(now - CALIBRATION_SETTLE_MS), gte: new Date(now - 7 * 86_400_000) } },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    const ordered = uses.length ? await withOrder(uses.map((u) => u.sessionId)) : new Set<string>();
    const counted = uses.filter((u) => ordered.has(u.sessionId));
    const ref = counted.find((u) => u.shopifyCountBefore != null);
    if (ref) {
      const ours = counted.filter((u) => u.createdAt >= ref.createdAt).length;
      const rise = usageCount - ref.shopifyCountBefore!;
      const decision = calibrationObservation({ rise, ours, ageMs: now - ref.createdAt.getTime() });
      if (decision != null && !state.votes.some((v) => v.ref === ref.id && (v.decision === decision || v.verified))) {
        state.votes = state.votes.filter((v) => v.ref !== ref.id);
        // "Doesn't count" is final; "counts" waits for the outside orders of its window.
        state.votes.push({ ref: ref.id, code: upper, decision, windowFrom: ref.createdAt.getTime(), windowTo: now, verified: !decision });
      }
    }
  }

  // Pending "counts" votes whose window the outside orders import now covers.
  const pending = state.votes.filter((v) => !v.verified);
  if (pending.length) {
    const coveredUntil = externalCoveredUntil(await externalImportStatus(storeId));
    for (const v of pending) {
      if (coveredUntil == null || coveredUntil < v.windowTo) continue;
      const outside = await db.externalOrder.count({ where: { storeId, discountCodes: { has: v.code }, orderedAt: { gte: new Date(v.windowFrom - CALIBRATION_SETTLE_MS), lte: new Date(v.windowTo) } } });
      if (outside > 0) state.votes = state.votes.filter((x) => x !== v);
      else v.verified = true;
    }
  }

  const decided = calibrationDecision(state.votes);
  if (decided == null) {
    await writeCalibration(storeId, state);
    return null;
  }
  if (current === decided) {
    // Re-check agreed: confirmed for another 30 days.
    state.checkedAt = now;
    state.votes = [];
    await writeCalibration(storeId, state);
    return null;
  }
  if (current != null) {
    // A re-check contradicts the decision: back to unknown (added), the new votes keep counting.
    await resetCalibration(storeId, current, { votes: state.votes.slice(-1) }, "deux nouvelles vérifications disent le contraire");
    return null;
  }
  const set = await db.store.updateMany({ where: { id: storeId, shopifyCountsApiOrders: null }, data: { shopifyCountsApiOrders: decided } });
  if (!set.count) return null;
  await writeCalibration(storeId, { votes: [], checkedAt: now });
  const refs = state.votes.filter((v) => v.verified && v.decision === decided).slice(-2);
  await recordEvent({
    storeId,
    kind: "discount.shopify_count_calibrated",
    message: decided
      ? `Codes promo Shopify : le compteur d'utilisations de Shopify inclut les commandes créées par ce checkout (vérifié deux fois, sans utilisation du code hors checkout sur la période). Les limites d'utilisation comptent désormais le plus grand des deux compteurs (plus les utilisations trop récentes pour Shopify), sans double comptage. Nouvelle vérification dans 30 jours.`
      : `Codes promo Shopify : le compteur d'utilisations de Shopify n'inclut pas les commandes créées par ce checkout (vérifié deux fois, 1 h après les utilisations). Les limites d'utilisation continuent d'additionner les deux compteurs.`,
    data: { countsApiOrders: decided, codes: refs.map((v) => v.code), references: refs.map((v) => v.ref) },
  });
  return decided;
}

/** Back to "not calibrated" (Shopify's count and the ledger added: never a use past the limit), journaled. */
async function resetCalibration(storeId: string, was: boolean, state: CalibrationState, why: string) {
  const reset = await db.store.updateMany({ where: { id: storeId, shopifyCountsApiOrders: was }, data: { shopifyCountsApiOrders: null } });
  await writeCalibration(storeId, { votes: state.votes });
  if (!reset.count) return;
  await recordEvent({
    storeId,
    level: "warn",
    kind: "discount.shopify_count_recalibrating",
    message: `Codes promo Shopify : le calibrage du compteur d'utilisations est remis à zéro (${why}). En attendant une nouvelle vérification, les limites d'utilisation additionnent le compteur de Shopify et celui de ce checkout (jamais de dépassement).`,
    data: { was, why },
  });
}

/** Collections (GIDs) of each product, from the Admin API, cached 10 min per product. */
export async function productCollections(store: LookupStore, productIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const missing: string[] = [];
  for (const id of [...new Set(productIds.filter((p) => /^gid:\/\/shopify\/Product\/\d+$/.test(p)))]) {
    const hit = collectionCache.get(`${store.id}:${id}`);
    if (hit && Date.now() - hit.at < COLLECTIONS_TTL_MS) out.set(id, hit.value);
    else missing.push(id);
  }
  if (missing.length) {
    const data = await shopifyGraphql<{ nodes: ({ id?: string; collections?: { nodes: { id: string }[] } } | null)[] }>(
      store,
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id collections(first: 50) { nodes { id } } } } }`,
      { ids: missing.slice(0, 100) },
    );
    for (const n of data.nodes ?? []) {
      if (!n?.id) continue;
      const cols = (n.collections?.nodes ?? []).map((c) => c.id);
      out.set(n.id, cols);
      remember(collectionCache, `${store.id}:${n.id}`, cols);
    }
    for (const id of missing) if (!out.has(id)) out.set(id, []);
  }
  return out;
}

/** Lines a Shopify code applies to (collections resolved by the caller). Pure. */
export function eligibleLines(d: Pick<ShopifyCodeDiscount, "scope">, lines: CartLine[], collectionsOf: Map<string, string[]>): CartLine[] {
  const buyer = lines.filter((l) => !l.gift);
  if (!d.scope) return buyer;
  const products = new Set(d.scope.productIds.map(productKey));
  const variants = new Set(d.scope.variantIds.map(productKey));
  const cols = new Set(d.scope.collectionIds);
  return buyer.filter(
    (l) => products.has(productKey(l.productId)) || variants.has(productKey(l.variantId)) || (collectionsOf.get(l.productId) ?? []).some((c) => cols.has(c)),
  );
}

/** Whether the code's scopes name collections (their products' collections must then be fetched). Pure. */
export function needsCollections(d: ShopifyCodeDiscount): boolean {
  return !!(d.scope?.collectionIds.length || d.bxgy?.buyScope?.collectionIds.length || d.bxgy?.getScope?.collectionIds.length);
}

/**
 * Amount of a buy X get Y code on these lines, like Shopify: per application, the `getQuantity`
 * cheapest "get" items are discounted, and `buyQuantity` other "buy" items (most expensive first)
 * must be in the cart — an item never counts both as bought and as discounted. A minimum purchase
 * amount on the "buy" items allows one application. Capped by usesPerOrderLimit. Pure.
 */
export function bxgyDiscountCents(b: Bxgy, lines: CartLine[], collectionsOf: Map<string, string[]>): number {
  const buyer = lines.filter((l) => !l.gift && l.quantity > 0);
  const inBuy = new Set(eligibleLines({ scope: b.buyScope }, buyer, collectionsOf));
  const inGet = new Set(eligibleLines({ scope: b.getScope }, buyer, collectionsOf));
  const units = buyer.flatMap((l) => Array.from({ length: l.quantity }, () => ({ price: l.unitPriceCents, buy: inBuy.has(l), get: inGet.has(l), used: false })));
  const effect = (prices: number[]) => {
    const sum = prices.reduce((a, p) => a + p, 0);
    if (b.percent != null) return Math.min(sum, prices.reduce((a, p) => a + Math.round((p * Math.min(100, b.percent!)) / 100), 0));
    const amount = b.amountCents ?? 0;
    return b.amountEach ? prices.reduce((a, p) => a + Math.min(p, amount), 0) : Math.min(sum, amount);
  };
  const cheapestGet = () => units.filter((u) => u.get && !u.used).sort((x, y) => x.price - y.price);
  let total = 0;
  if (b.buyAmountCents != null) {
    const spent = units.filter((u) => u.buy).reduce((a, u) => a + u.price, 0);
    if (spent < b.buyAmountCents) return 0;
    const picked = cheapestGet().slice(0, b.getQuantity);
    return picked.length ? effect(picked.map((u) => u.price)) : 0;
  }
  const limit = b.usesPerOrderLimit ?? Infinity;
  for (let applied = 0; applied < limit; applied++) {
    const gets = cheapestGet().slice(0, b.getQuantity);
    if (gets.length < b.getQuantity) break;
    gets.forEach((u) => (u.used = true));
    const buys = units.filter((u) => u.buy && !u.used).sort((x, y) => y.price - x.price).slice(0, b.buyQuantity ?? 0);
    if (buys.length < (b.buyQuantity ?? 0)) {
      gets.forEach((u) => (u.used = false));
      break;
    }
    buys.forEach((u) => (u.used = true));
    total += effect(gets.map((u) => u.price));
  }
  return total;
}

/**
 * Uses of a Shopify code with a usage limit, as this app counts them (pure). Shopify's asyncUsageCount
 * plus this app's ledger (ShopifyCodeUse: every paid use of the code here) — unless the store is
 * calibrated as "Shopify counts the orders this app creates" (Store.shopifyCountsApiOrders, see
 * calibrateShopifyCodeCount: exact match twice, no outside use, re-checked every 30 days):
 *  - not calibrated / false: asyncUsageCount + ledger. If Shopify doesn't count our orders, that's the
 *    real count; if it does, ours count twice and a code is exhausted early — never used past its limit;
 *  - true: Shopify's count includes our uses only once its asynchronous count has caught up. Uses of the
 *    ledger newer than the last count read (less the settle lag, `recentLedgerUses`) aren't in it yet:
 *    max(asyncUsageCount + recent, ledger) — never below either count, no double counting.
 */
export function shopifyCodeUses(asyncUsageCount: number, ledgerUses: number, countsApiOrders?: boolean | null, recentLedgerUses = 0): number {
  const shopify = Math.max(0, asyncUsageCount);
  const ledger = Math.max(0, ledgerUses);
  if (countsApiOrders === true) return Math.max(shopify + Math.min(ledger, Math.max(0, recentLedgerUses)), ledger);
  return shopify + ledger;
}

/**
 * A Shopify code as the quote's DiscountInput, or the reason it doesn't apply to this cart
 * ("invalid" for anything but an unmet minimum, so private codes can't be probed). Pure.
 */
export function shopifyCodeAsDiscount(
  d: ShopifyCodeDiscount,
  lines: CartLine[],
  collectionsOf: Map<string, string[]>,
  ctx: {
    country: string | null;
    now?: Date;
    /** This app's other paid uses of the code (ledger), added to Shopify's count (see shopifyCodeUses). */
    ledgerUses?: number;
    /** Of those, the ones newer than Shopify's count read (less the settle lag): not in Shopify's count yet. */
    recentLedgerUses?: number;
    /** Store.shopifyCountsApiOrders (see calibrateShopifyCodeCount). */
    countsApiOrders?: boolean | null;
  },
): { ok: true; discount: DiscountInput } | { ok: false; reason: "invalid" | "minimum" | "exhausted" } {
  const now = ctx.now ?? new Date();
  if (!d.active || (d.startsAt && now < d.startsAt) || (d.endsAt && now > d.endsAt)) return { ok: false, reason: "invalid" };
  if (d.usageLimit != null && shopifyCodeUses(d.usageCount, ctx.ledgerUses ?? 0, ctx.countsApiOrders, ctx.recentLedgerUses ?? ctx.ledgerUses ?? 0) >= d.usageLimit) return { ok: false, reason: "exhausted" };
  const buyer = lines.filter((l) => !l.gift);
  const stack = { discountClass: d.discountClass, ...(d.combinesWith ? { combinesWith: d.combinesWith } : {}) };
  if (d.bxgy) {
    // Buy X get Y: nothing to discount yet = "minimum" (the buyer can add items), like an unmet minimum.
    const off = bxgyDiscountCents(d.bxgy, buyer, collectionsOf);
    if (off <= 0) return { ok: false, reason: eligibleLines({ scope: d.bxgy.getScope }, buyer, collectionsOf).length ? "minimum" : "invalid" };
    return {
      ok: true,
      discount: { code: d.code, type: "FIXED", value: off, minSubtotalCents: null, startsAt: null, endsAt: null, usageLimit: null, usageCount: 0, active: true, ...stack },
    };
  }
  const eligible = eligibleLines(d, buyer, collectionsOf);
  if (!eligible.length) return { ok: false, reason: "invalid" };
  // Shopify's minimums count the eligible items (all items when the code applies to all).
  if (d.minSubtotalCents != null && subtotal(eligible) < d.minSubtotalCents) return { ok: false, reason: "minimum" };
  if (d.minQuantity != null && eligible.reduce((n, l) => n + l.quantity, 0) < d.minQuantity) return { ok: false, reason: "minimum" };
  if (d.type === "FREE_SHIPPING" && d.countries && ctx.country && !d.countries.includes(ctx.country.toUpperCase())) return { ok: false, reason: "invalid" };
  const all = subtotal(buyer);
  const share = all > 0 ? subtotal(eligible) / all : 0;
  const items = eligible.reduce((n, l) => n + l.quantity, 0);
  return {
    ok: true,
    discount: {
      code: d.code,
      type: d.type,
      value: d.type === "FIXED" && d.appliesOnEachItem ? d.value * items : d.value,
      minSubtotalCents: null,
      startsAt: null,
      endsAt: null,
      usageLimit: null,
      usageCount: 0,
      active: true,
      scopeShare: share < 1 ? share : undefined,
      // Scoped code: computed on the eligible lines' own remaining value (see eligibleRemaining).
      eligibleVariantIds: share < 1 ? eligible.map((l) => l.variantId) : undefined,
      maxShippingCents: d.maxShippingCents ?? undefined,
      ...stack,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Stacking rules of the cart's automatic discounts                    */
/* ------------------------------------------------------------------ */

const autoCache = new Map<string, Cached<{ cls: DiscountClass; combinesWith: Combines } | null>>();

/**
 * Class and combinesWith of automatic discounts found by title (`discountNodes`), merged:
 * they combine with a class only if every one of them does; the class is "product" unless all are
 * of one other class. Null when none was recognized (unknown: combine, the previous behavior). Pure.
 */
export function parseAutomaticStack(data: unknown, titles: string[]): { cls: DiscountClass; combinesWith: Combines } | null {
  const nodes = (data as { discountNodes?: { nodes?: { discount?: Record<string, unknown> | null }[] } } | null)?.discountNodes?.nodes;
  if (!Array.isArray(nodes)) return null;
  const wanted = new Set(titles.map((t) => t.trim().toLowerCase()));
  const found: { cls: DiscountClass; combinesWith: Combines }[] = [];
  for (const n of nodes) {
    const d = n?.discount;
    if (!d || !wanted.has(String(d.title ?? "").trim().toLowerCase())) continue;
    const combinesWith = combinesOf(d.combinesWith);
    if (!combinesWith) continue;
    const t = d.__typename;
    const cls: DiscountClass | null =
      t === "DiscountAutomaticFreeShipping"
        ? "shipping"
        : t === "DiscountAutomaticBxgy"
          ? "product"
          : t === "DiscountAutomaticBasic"
            ? (d.customerGets as { items?: { __typename?: string } } | undefined)?.items?.__typename === "AllDiscountItems"
              ? "order"
              : "product"
            : null;
    if (cls) found.push({ cls, combinesWith });
  }
  if (!found.length) return null;
  const classes = new Set(found.map((f) => f.cls));
  return {
    cls: classes.size === 1 ? found[0].cls : "product",
    combinesWith: {
      product: found.every((f) => f.combinesWith.product),
      order: found.every((f) => f.combinesWith.order),
      shipping: found.every((f) => f.combinesWith.shipping),
    },
  };
}

export const AUTOMATIC_QUERY = `query($q: String!) {
  discountNodes(first: 10, query: $q) {
    nodes {
      discount {
        __typename
        ... on DiscountAutomaticBasic { title combinesWith { productDiscounts orderDiscounts shippingDiscounts } customerGets { items { __typename } } }
        ... on DiscountAutomaticBxgy { title combinesWith { productDiscounts orderDiscounts shippingDiscounts } }
        ... on DiscountAutomaticFreeShipping { title combinesWith { productDiscounts orderDiscounts shippingDiscounts } }
      }
    }
  }
}`;

/**
 * Stacking rules of the automatic discounts Shopify applied to the cart (looked up by their titles,
 * cached 10 min). Any failure reads as unknown (null: they combine, as before).
 */
export async function automaticStackFor(store: LookupStore, titles: string[]): Promise<{ cls: DiscountClass; combinesWith: Combines } | null> {
  const list = [...new Set(titles.map((t) => t.trim()).filter(Boolean))].slice(0, 5);
  if (!list.length || !store.shopifyAccessToken) return null;
  const key = `${store.id}:${list.map((t) => t.toLowerCase()).sort().join("|")}`;
  const hit = autoCache.get(key);
  if (hit && Date.now() - hit.at < COLLECTIONS_TTL_MS) return hit.value;
  let value: { cls: DiscountClass; combinesWith: Combines } | null = null;
  try {
    const q = list.map((t) => `title:${JSON.stringify(t)}`).join(" OR ");
    value = parseAutomaticStack(await shopifyGraphql(store, AUTOMATIC_QUERY, { q }), list);
  } catch (err) {
    log.warn("discount.automatic_lookup_failed", "Could not read the automatic discounts' combination rules", { storeId: store.id, err });
    return null;
  }
  remember(autoCache, key, value);
  return value;
}

/* ------------------------------------------------------------------ */
/* Automatic discounts Shopify computed for the cart (/cart.js)         */
/* ------------------------------------------------------------------ */

export type CartDiscounts = {
  /** The cart's lines when Shopify computed the discounts: they only hold for exactly these. */
  items: { variantId: string; quantity: number }[];
  totalCents: number;
  titles: string[];
  at: string;
  /** Currency of the amounts (the cart's = the shop's; older rows don't have it). */
  currency?: string;
  /** Line-level part per variant (each capped at that line's shop-currency price). */
  lineCents?: Record<string, number>;
};

type CartJs = FidelityCartJs;

const variantGidOf = (id: unknown) => {
  const s = String(id ?? "");
  return s.startsWith("gid://") ? s : `gid://shopify/ProductVariant/${s}`;
};

/** A checkout line as priced by the Admin API (shop currency). */
export type PricedLine = { variantId: string; quantity: number; unitPriceCents: number };

/**
 * Automatic discounts of a /cart.js body (amounts in cents, as Shopify's AJAX API gives them):
 * line-level and cart-level allocations of type "automatic" only (codes are handled apart).
 * With the checkout's `lines` (shop-currency prices), every cart item must be one of them and a
 * line's allocations are capped at that line's price; the cart-level part at what remains.
 * Null when there is none (or an item isn't a checkout line). Pure, exported for tests.
 */
export function automaticDiscountsOf(cart: CartJs, lines?: PricedLine[]): CartDiscounts | null {
  const titles = new Set<string>();
  const priceOf = new Map<string, number>();
  for (const l of lines ?? []) priceOf.set(productKey(l.variantId), (priceOf.get(productKey(l.variantId)) ?? 0) + l.unitPriceCents * l.quantity);
  const lineCents: Record<string, number> = {};
  let lineTotal = 0;
  for (const item of cart.items ?? []) {
    const v = variantGidOf(item.variant_id ?? item.id);
    let amount = 0;
    for (const a of item.line_level_discount_allocations ?? []) {
      if (a.discount_application?.type !== "automatic") continue;
      const cents = Math.round(Number(a.amount ?? 0));
      if (cents > 0) {
        amount += cents;
        if (a.discount_application.title) titles.add(a.discount_application.title);
      }
    }
    if (amount <= 0) continue;
    if (lines) {
      const price = priceOf.get(productKey(v));
      // A discounted cart item that isn't a checkout line: the figures don't describe this checkout.
      if (price == null) return null;
      amount = Math.min(amount, Math.max(0, price - (lineCents[v] ?? 0)));
    }
    lineCents[v] = (lineCents[v] ?? 0) + amount;
    lineTotal += amount;
  }
  let cartLevel = 0;
  for (const app of cart.cart_level_discount_applications ?? []) {
    if (app.type !== "automatic") continue;
    const amount = Math.round(Number(app.total_allocated_amount ?? 0));
    if (amount > 0) {
      cartLevel += amount;
      if (app.title) titles.add(app.title);
    }
  }
  if (lines) cartLevel = Math.min(cartLevel, Math.max(0, [...priceOf.values()].reduce((a, b) => a + b, 0) - lineTotal));
  const total = lineTotal + cartLevel;
  if (total <= 0) return null;
  const items = new Map<string, number>();
  for (const i of cart.items ?? []) {
    const v = variantGidOf(i.variant_id ?? i.id);
    items.set(v, (items.get(v) ?? 0) + Math.max(0, Math.floor(Number(i.quantity ?? 0))));
  }
  return {
    items: [...items].map(([variantId, quantity]) => ({ variantId, quantity })),
    totalCents: total,
    titles: [...titles].slice(0, 5),
    at: new Date().toISOString(),
    ...(cart.currency ? { currency: String(cart.currency).toUpperCase() } : {}),
    ...(lineTotal > 0 ? { lineCents } : {}),
  };
}

/** Same set of variants and quantities (a variant on several lines counts once, quantities summed). Pure. */
export function sameItems(a: { variantId: string; quantity: number }[], b: { variantId: string; quantity: number }[]): boolean {
  const key = (x: { variantId: string; quantity: number }[]) => {
    const qty = new Map<string, number>();
    for (const i of x) if (i.quantity > 0) qty.set(productKey(i.variantId), (qty.get(productKey(i.variantId)) ?? 0) + i.quantity);
    return [...qty]
      .map(([k, n]) => `${k}x${n}`)
      .sort()
      .join(",");
  };
  return key(a) === key(b);
}

/**
 * Re-reads the cart from the storefront with its token (Shopify's AJAX cart API, 3 s) and keeps
 * its automatic discounts when its lines are the checkout's and its currency is the shop's (a
 * cart shown in another currency — Shopify Markets — has amounts that aren't the checkout's).
 * Null on any doubt; failures are journaled (the buyer loses the discount).
 */
/**
 * The buyer's cart re-read from the storefront with its token (Shopify's AJAX cart API, 3 s by
 * default): the server's own figures, never the browser's. Null on failure (journaled; `alert`
 * false for a cart that looked plain: it goes on at the variants' prices, nothing is at stake).
 */
export async function readCartJs(
  store: Pick<Store, "id" | "shopDomain">,
  cartToken: string,
  opts: { timeoutMs?: number; alert?: boolean } = {},
): Promise<CartJs | null> {
  if (!store.shopDomain || !/^[\w\-?=&%.:]{8,300}$/.test(cartToken)) return null;
  try {
    const res = await extFetch("shopify", "cart.js", `https://${store.shopDomain}/cart.js`, {
      headers: { Accept: "application/json", Cookie: `cart=${cartToken}` },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 3000),
      cache: "no-store",
      redirect: "error",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const cart = (await res.json()) as CartJs;
    if (!cart || typeof cart !== "object" || !Array.isArray(cart.items)) throw new Error("unexpected cart body");
    return cart;
  } catch (err) {
    await recordIncident({
      storeId: store.id,
      kind: "discount.cart_read_failed",
      message: `Panier Shopify impossible à relire : ses remises automatiques et prix d'app ne sont pas repris au checkout (${err instanceof Error ? err.message.slice(0, 200) : String(err)}).`,
      data: { err: err instanceof Error ? err.message : String(err), ...(opts.alert === false ? { plainCart: true } : {}) },
      ...(opts.alert === false ? { alert: false } : {}),
    });
    return null;
  }
}

/** Automatic discounts of a re-read cart for these lines, or null (currency mismatch journaled). */
async function discountsOfCart(store: Pick<Store, "id" | "shopCurrency">, cart: CartJs, lines: PricedLine[]): Promise<CartDiscounts | null> {
  const currency = String(cart.currency ?? "").toUpperCase();
  if (currency !== store.shopCurrency.toUpperCase()) {
    // Only when it would have mattered (the cart shows automatic discounts): once per store every 10 min.
    if (automaticDiscountsOf(cart) && (await rateLimitOnce(`journal:cart_currency:${store.id}`))) {
      await recordEvent({
        storeId: store.id,
        kind: "discount.cart_currency_mismatch",
        message: `Remises automatiques Shopify ignorées : panier en ${currency || "devise inconnue"}, boutique en ${store.shopCurrency} (montants non comparables).`,
        data: { cartCurrency: currency || null, shopCurrency: store.shopCurrency },
      });
    }
    return null;
  }
  const found = automaticDiscountsOf(cart, lines);
  if (!found || !sameItems(found.items, lines)) return null;
  return found;
}

/**
 * Re-reads the cart and keeps its automatic discounts when its lines are the checkout's and its
 * currency is the shop's (a cart shown in another currency — Shopify Markets — has amounts that
 * aren't the checkout's). Null on any doubt; failures are journaled (the buyer loses the discount).
 */
export async function verifiedCartDiscounts(
  store: Pick<Store, "id" | "shopDomain" | "shopCurrency">,
  cartToken: string,
  lines: PricedLine[],
): Promise<CartDiscounts | null> {
  const cart = await readCartJs(store, cartToken);
  return cart ? discountsOfCart(store, cart, lines) : null;
}

export type VerifiedCart =
  | { status: "unreadable" }
  | { status: "unsupported"; reason: UnsupportedCartReason; detail?: string; cart: CartJs }
  | {
      status: "ok";
      lines: CartLine[];
      discounts: CartDiscounts | null;
      context: CartContext | null;
      adjustedCents: number;
      cart: CartJs;
    };

/**
 * The checkout's lines made faithful to the buyer's Shopify cart, re-read server-side: line
 * properties, prices an app set (Cart Transform, never above the variant's), bundle components,
 * cart note / attributes, and (`discounts`) the automatic discounts Shopify computed — on the
 * app-adjusted prices. "unsupported": the cart can't be represented, Shopify's checkout takes it.
 */
export async function verifiedCart(
  store: Pick<Store, "id" | "shopDomain" | "shopCurrency">,
  cartToken: string,
  lines: CartLine[],
  opts: { discounts: boolean; cart?: Promise<CartJs | null> },
): Promise<VerifiedCart> {
  const cart = await (opts.cart ?? readCartJs(store, cartToken));
  if (!cart) return { status: "unreadable" };
  const rec = reconcileCart(cart, lines, store.shopCurrency);
  if (!rec.ok) return { status: "unsupported", reason: rec.reason, ...(rec.detail ? { detail: rec.detail } : {}), cart };
  const priced = rec.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceCents: l.unitPriceCents }));
  const discounts = opts.discounts ? await discountsOfCart(store, cart, priced) : null;
  // Last safety net: this exact cart, in the shop's currency, must never cost more here than in
  // Shopify's cart (its discount codes aside) — an app's price we couldn't read would show here.
  const cartCents = cartMerchandiseCents(cart);
  if (rec.matches && cartCents != null && String(cart.currency ?? "").toUpperCase() === store.shopCurrency.toUpperCase()) {
    const ours = priced.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0) - (discounts?.totalCents ?? 0);
    if (ours > cartCents) return { status: "unsupported", reason: "price_unreconciled", detail: `${ours} > ${cartCents}`, cart };
  }
  return { status: "ok", lines: rec.lines, discounts, context: rec.context, adjustedCents: rec.adjustedCents, cart };
}

function rateLimitOnce(key: string): Promise<boolean> {
  return rateLimit(key, 1, 10 * 60_000);
}

/**
 * Automatic discount still valid for these checkout lines (same items, same currency; each
 * line's part capped at its current price, the total at their subtotal), or 0. Pure.
 */
export function automaticDiscountFor(raw: unknown, lines: CartLine[], currency?: string): { cents: number; titles: string[]; lineCents?: Record<string, number> } {
  const d = raw as CartDiscounts | null;
  if (!d || !Array.isArray(d.items) || !(d.totalCents > 0)) return { cents: 0, titles: [] };
  if (currency && d.currency && d.currency.toUpperCase() !== currency.toUpperCase()) return { cents: 0, titles: [] };
  const buyer = lines.filter((l) => !l.gift);
  if (!sameItems(d.items, buyer)) return { cents: 0, titles: [] };
  let cents = Math.round(d.totalCents);
  let lineCents: Record<string, number> | undefined;
  if (d.lineCents && typeof d.lineCents === "object") {
    let over = 0;
    lineCents = {};
    for (const [variantId, part] of Object.entries(d.lineCents)) {
      const line = buyer.filter((l) => productKey(l.variantId) === productKey(variantId)).reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
      const asked = Math.round(Number(part) || 0);
      over += Math.max(0, asked - line);
      // Per line, capped at the line (scoped codes are computed on each line's remaining value).
      lineCents[variantId] = Math.max(0, Math.min(line, asked));
    }
    cents -= over;
  }
  return { cents: Math.max(0, Math.min(subtotal(buyer), cents)), titles: Array.isArray(d.titles) ? d.titles.map(String).slice(0, 5) : [], ...(lineCents ? { lineCents } : {}) };
}
