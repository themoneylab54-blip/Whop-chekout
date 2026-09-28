import "server-only";
import { DeadlineError, notePartial } from "./deadline";
import { z } from "zod";
import { Prisma, type CheckoutQuote, type CheckoutSession, type Store } from "@prisma/client";
import { db } from "./db";
import { thankYouReturnUrl } from "./checkout-domain";
import { env } from "./env";
import {
  checkDiscount,
  computeTotals,
  giftLine,
  giftProgress,
  giftTitle,
  offerBaseLines,
  parseQuantityTiers,
  quantityBreakForLines,
  ratesForCountry,
  subtotal,
  type CartLine,
  type GiftTier,
  type QuantityBreak,
  type DiscountInput,
  type RateInput,
  type Totals,
} from "./pricing";
import { createPaidOrder, findOrderByPayment, findOrderForSession, priceCart, ShopifyError, tagOrder, type Address, type OrderCustomer } from "./shopify";
import { log, recordEvent } from "./log";
import { mirrorRefund } from "./refunds";
import { defer } from "./deferred";
import { noteCheckoutFailure } from "./fallback";
import { rateLimit } from "./ratelimit";
import { pickupPointSchema, type PickupPoint } from "./pickup";
import { sendPurchaseConversions } from "./conversions";
import { applyAppCosts } from "./costs";
import { submitDisputeEvidence } from "./disputes";
import { createCheckoutConfiguration, MethodUnavailableError } from "./whop";
import { designFor } from "./experiments";
import { loadCheckoutLayout, loadInterception, loadTheme, paypalExpressAllowed } from "./layout";
import { automaticDiscountFor, automaticStackFor, CALIBRATION_SETTLE_MS, canReadShopifyDiscounts, lookupShopifyCode, lookupShopifyCodeWithRetry, needsCollections, productCollections, shopifyCodeAsDiscount, shopifyCodeUses, type ShopifyCodeDiscount } from "./shopify-discounts";
import { overridesFor, withAddOnOverrides, withProtectionOverride } from "./checkout-tests";
import { PAYPAL_SERVER_IN_FLIGHT_MS } from "./paypal-timing";
import { chargePlan, chargeFallback, toShopCents, type ChargePlan } from "./charge";
import { recordIncident } from "./incidents";
import { GOOGLE_ADJUST_DUE } from "./google-conversions";
import { recordOrderCustomer } from "./shopify-history";
import { carryCartExtras, cartHeldByApp, type CartContext } from "./cart-fidelity";

/* ------------------------------------------------------------------ */
/* Input validation                                                    */
/* ------------------------------------------------------------------ */

/** Per line, when the buyer edits quantities on the checkout. */
export const MAX_LINE_QTY = 20;
/** Lines in one checkout (cart + products added on the checkout). */
const MAX_LINES = 30;

export const addressSchema = z.object({
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  address1: z.string().trim().min(1).max(200),
  address2: z.string().trim().max(200).optional().nullable(),
  city: z.string().trim().min(1).max(100),
  province: z.string().trim().max(100).optional().nullable(),
  zip: z.string().trim().min(1).max(20),
  countryCode: z.string().trim().length(2).toUpperCase(),
  phone: z.string().trim().max(30).optional().nullable(),
});

export const quoteSchema = z.object({
  countryCode: z.string().length(2).toUpperCase().nullable().optional(),
  /** New quantities by variant id (the buyer changed them on the checkout); 0 removes a line. */
  quantities: z.record(z.string().max(80), z.number().int().min(0).max(MAX_LINE_QTY)).optional(),
  shippingRateId: z.string().max(40).nullable().optional(),
  discountCode: z.string().trim().max(60).nullable().optional(),
  addOnIds: z.array(z.string().max(40)).max(20).default([]),
  /** Shipping protection toggle (checkout block); missing = the block's default. */
  protection: z.boolean().optional(),
  /** "paypal": a checkout offering PayPal only (express PayPal button); missing = every method. */
  method: z.enum(["paypal"]).nullable().optional(),
});
export type QuoteInput = z.infer<typeof quoteSchema>;

export const paySchema = quoteSchema.extend({
  email: z.string().trim().email().max(200),
  acceptsMarketing: z.boolean().default(false),
  acceptsTerms: z.boolean().default(false),
  address: addressSchema,
  note: z.string().trim().max(1000).nullable().optional(),
  /** The Whop checkout the page is about to submit. */
  checkoutConfigurationId: z.string().max(100).nullable().optional(),
  /** Relay point, required when the chosen rate is a pickup rate. */
  pickupPoint: pickupPointSchema.nullable().optional(),
});
export type PayInput = z.infer<typeof paySchema>;

/* ------------------------------------------------------------------ */
/* Quote                                                               */
/* ------------------------------------------------------------------ */

export type Quote = {
  totals: Totals;
  rates: (RateInput & { effectiveCents: number })[];
  shippingRateId: string | null;
  /** `source`: the app's own code list, or a Shopify discount code (recorded as such on the order). */
  discount: { code: string; type: DiscountInput["type"]; source?: "app" | "shopify"; oncePerCustomer?: boolean } | null;
  /** Shopify automatic discounts honored on this exact cart (part of totals.discountCents). */
  automaticDiscount: { cents: number; titles: string[] } | null;
  /** Charged in the buyer's currency (store option): what Whop will charge, at which rate. */
  charge: ChargePlan | null;
  discountError: string | null;
  /** discount_invalid | discount_minimum | discount_exhausted | … — localized by the checkout. */
  discountErrorCode: string | null;
  addOnIds: string[];
  /** Price of each selected bump as quoted (an A/B test's arm B can change it): the paid snapshot uses these. */
  addOnPrices: Record<string, number>;
  /** Order bumps whose display rules match this cart (the page shows only these). */
  eligibleAddOnIds: string[];
  /** Lines the quote was computed on (quantities may differ from the cart). */
  lines: CartLine[];
  /** Quantity break reached, and the next one ("add 1 more item to save 15%"); `missing` items in its scope. */
  volumeBreak: { current: QuantityBreak | null; next: QuantityBreak | null; missing?: number | null };
  /** Free gifts: earned (their lines are in `lines`, flagged `gift`) and the next one to earn. */
  gifts: { earned: Pick<GiftTier, "title" | "variantId">[]; next: { title: string; missingQty: number | null; missingCents: number | null } | null };
  /** Shipping protection block: offered (price for this cart) and whether it is in the total. */
  protection: { selected: boolean; priceCents: number } | null;
  /** Custom order lines without an AddOn row (shipping protection), snapshotted with the add-ons. */
  extraAddOns: { id: string; title: string; priceCents: number; variantId: null; costCents: null }[];
  /** The cart is fixed as a whole (an app's prices, gifts, offers or bundles): no line changed, removed or added. */
  cartLocked?: boolean;
  /** The Shopify cart's automatic discount no longer applies (the buyer changed the lines): its titles. */
  automaticDiscountLost?: string[];
  /**
   * The Shopify cart's own code isn't applied here (`reason`: the discount error code, or
   * "discount_amount" when it takes off less than in the cart). `blocking`: the code lowered the
   * cart and, for these very lines, the checkout would charge more than the cart showed (or Shopify
   * couldn't be asked, twice): payment is refused (assertPayable) — back to the cart / Shopify's checkout.
   */
  cartCodeLost?: { code: string; reason: string; blocking: boolean };
};

/** Id of the shipping protection in the paid snapshot's add-ons (Shopify line "Protection colis"). */
export const PROTECTION_ADDON_ID = "shipping_protection";

/** Order-bump display rules (AddOn.showIf). Missing rules = always shown. */
const showIfSchema = z
  .object({
    minSubtotalCents: z.number().int().nonnegative().optional(),
    maxSubtotalCents: z.number().int().nonnegative().optional(),
    productIds: z.array(z.string()).optional(),
    countries: z.array(z.string().length(2)).optional(),
  })
  .partial();

export function addOnEligible(showIf: unknown, ctx: { subtotalCents: number; productIds: string[]; country: string | null }): boolean {
  const parsed = showIfSchema.safeParse(showIf ?? {});
  if (!parsed.success) return true;
  const r = parsed.data;
  if (r.minSubtotalCents != null && ctx.subtotalCents < r.minSubtotalCents) return false;
  if (r.maxSubtotalCents != null && ctx.subtotalCents > r.maxSubtotalCents) return false;
  if (r.productIds?.length && !r.productIds.some((id) => ctx.productIds.includes(id))) return false;
  if (r.countries?.length && ctx.country && !r.countries.map((c) => c.toUpperCase()).includes(ctx.country.toUpperCase())) return false;
  return true;
}

/**
 * Whether the checkout's cart is fixed as a whole: an app's line (price, gift, discounted offer,
 * bundle, hidden key) or a variant split over several lines — they hold for this exact set of lines
 * only. A plain cart's sitewide automatic discount doesn't fix it: a change drops that discount. Pure.
 */
export function cartFrozen(lines: CartLine[]): boolean {
  return cartHeldByApp(lines);
}

/**
 * Applies quantity changes: re-prices the changed cart with Shopify (price and stock
 * are never taken from the browser) and saves it on the session. Unchanged → as is.
 */
async function linesFor(session: SessionWithStore, quantities: Record<string, number> | undefined): Promise<CartLine[]> {
  // Free gifts are re-derived by every quote: never a buyer line (a paid session's lines hold them).
  const stored = (session.lines as unknown as CartLine[]).filter((l) => !l.gift);
  // An app's price, gift or offer holds for this exact cart only: the whole cart is then fixed (no
  // quantity change, no line removed or added) — else a line's app price would survive removing the
  // lines it depended on, or a locked gift lose its discount. A plain cart's automatic discount
  // simply stops applying once the lines change (automaticDiscountFor: same items only).
  const frozen = cartFrozen(stored);
  const current = frozen ? stored.map((l) => (l.locked ? l : { ...l, locked: true })) : stored;
  if (!quantities || frozen) return current;
  // A line the Shopify cart fixed (app price, properties, bundle) keeps its quantity: changed from the cart only.
  const wanted = current.map((l) => ({ variantId: l.variantId, quantity: l.locked ? l.quantity : (quantities[l.variantId] ?? l.quantity) }));
  // Products added from the checkout ("Complétez votre commande"): new variant ids.
  const known = new Set(current.map((l) => l.variantId));
  const added = Object.entries(quantities)
    .filter(([id, qty]) => !known.has(id) && qty > 0 && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id))
    .slice(0, Math.max(0, MAX_LINES - current.length))
    .map(([variantId, quantity]) => ({ variantId, quantity }));
  if (!added.length && wanted.every((w, i) => w.quantity === current[i].quantity)) return current;
  const kept = [...wanted, ...added].filter((w) => w.quantity > 0);
  if (!kept.length) throw new CheckoutError("empty_cart", "Votre panier est vide.");
  // Re-priced lines keep what the cart gave them (properties, bundle components, app price as a ceiling).
  const priced = carryCartExtras(current, await priceCart(session.store, kept));
  if (!priced.length) throw new CheckoutError("empty_cart", "Ces articles ne sont plus disponibles.");
  // Products the merchant keeps on Shopify's checkout can't be added here either.
  const excluded = loadInterception(session.store.interception).excludedHandles;
  if (priced.some((l) => !known.has(l.variantId) && (excluded.includes(l.productHandle) || l.giftCard || (l.requiresComponents && !l.components?.length)))) {
    throw new CheckoutError("empty_cart", "Ce produit ne peut pas être ajouté ici.");
  }
  // Capped at the stock (a locked bundle line stays whole: its components and price are for that quantity).
  const lines = priced.map((l) => (!l.locked && l.inventory != null && l.inventory > 0 && l.quantity > l.inventory ? { ...l, quantity: l.inventory } : l));
  const saved = await db.checkoutSession.updateMany({
    where: { id: session.id, status: { not: "PAID" } },
    data: { lines: lines as unknown as Prisma.InputJsonValue, subtotalCents: subtotal(lines) },
  });
  if (!saved.count) throw new CheckoutError("already_paid", "Cette commande est déjà payée.");
  session.lines = lines as unknown as Prisma.JsonValue;
  return lines;
}

type SessionWithStore = CheckoutSession & { store: Store };

/** Shopify prices of the earned gifts (then set to 0). Any failure drops the gift, never the quote. */
async function giftLinesFor(session: SessionWithStore, earned: GiftTier[]): Promise<CartLine[]> {
  if (!earned.length) return [];
  try {
    const priced = await priceCart(session.store, earned.map((g) => ({ variantId: g.variantId, quantity: 1 })));
    return earned
      .map((g) => priced.find((l) => l.variantId === g.variantId))
      .filter((l): l is CartLine => !!l && (l.inventory == null || l.inventory > 0))
      .map(giftLine);
  } catch (err) {
    log.warn("checkout.gift_pricing_failed", "Gift tier could not be priced: left out of the quote", { sessionId: session.id, err });
    return [];
  }
}

/** A limited Shopify code whose uses (Shopify's count + this app's ledger) reached its limit. */
const DISCOUNT_EXHAUSTED = "Ce code promo a atteint sa limite d'utilisation";

export async function quoteSession(session: SessionWithStore, input: QuoteInput): Promise<Quote> {
  const buyerLines = await linesFor(session, session.status === "PAID" ? undefined : input.quantities);
  // The Shopify cart's own code (a /discount/CODE link, Fast Bundle's code) while the buyer has typed
  // none (null; "" = removed): looked up like a typed code, kept only when valid — else left out
  // without a buyer-facing error (journaled).
  const cartCode = input.discountCode == null ? ((session.cartContext as CartContext | null)?.discountCodes?.[0] ?? null) : null;
  const discountCode = input.discountCode || cartCode;
  const [allRates, storeAddOns, discountRow, design, overrides] = await Promise.all([
    db.shippingRate.findMany({ where: { storeId: session.storeId }, orderBy: { position: "asc" } }),
    db.addOn.findMany({ where: { storeId: session.storeId, active: true } }),
    discountCode
      ? db.discountCode.findFirst({
          where: { storeId: session.storeId, code: { equals: discountCode, mode: "insensitive" } },
        })
      : null,
    designFor(session.store, session),
    // Checkout A/B tests: arm B's tiers, order-bump prices / visibility, protection pricing.
    overridesFor(session),
  ]);
  const allAddOns = withAddOnOverrides(storeAddOns, overrides);

  // Quantity breaks v2: percent tiers (maybe scoped to products) and free gifts.
  const tiers = parseQuantityTiers(overrides.breaks ?? session.store.quantityBreaks);
  // An app's bundle price or gift already is an offer: the checkout's own gifts count the other lines.
  const progress = giftProgress(tiers.gifts, offerBaseLines(buyerLines));
  const gifts = await giftLinesFor(session, progress.earned);
  const lines = [...buyerLines, ...gifts];

  const rates = ratesForCountry(allRates, input.countryCode ?? null);
  const rate = rates.find((r) => r.id === input.shippingRateId) ?? rates[0] ?? null;

  let discount: DiscountInput | null = null;
  let discountSource: "app" | "shopify" = "app";
  let shopifyCode: ShopifyCodeDiscount | null = null;
  let discountError: string | null = null;
  let discountErrorCode: string | null = null;
  if (discountCode) {
    // One message for unknown, inactive, expired or used-up codes: don't help guess private codes.
    const invalid = "Code promo invalide ou expiré";
    if (!discountRow && session.store.shopifyDiscountCodes && session.store.shopifyAccessToken && canReadShopifyDiscounts(session.store)) {
      // Not one of the app's codes: a code created in Shopify (amount off / free shipping).
      // The Shopify cart's own code is asked twice when Shopify doesn't answer (never silently dropped).
      const found = cartCode && discountCode === cartCode ? await lookupShopifyCodeWithRetry(session.store, discountCode) : await lookupShopifyCode(session.store, discountCode);
      if (found === "unavailable") {
        // Shopify couldn't be asked: not an invalid code, the buyer can retry.
        discountError = "Impossible de vérifier ce code pour le moment, réessayez.";
        discountErrorCode = "discount_unavailable";
      } else if (typeof found === "string") {
        discountError = invalid;
        discountErrorCode = "discount_invalid";
      } else {
        const collections = needsCollections(found)
          ? await productCollections(session.store, buyerLines.map((l) => l.productId)).catch(() => new Map<string, string[]>())
          : new Map<string, string[]>();
        // A limited code: this app's own paid uses count on top of Shopify's (see shopifyCodeUses).
        const limited = found.usageLimit != null;
        const [ledgerUses, recentLedgerUses] = limited
          ? await Promise.all([
              shopifyCodeLedgerUses(db, session.storeId, found.code, session.id),
              shopifyCodeLedgerUses(db, session.storeId, found.code, session.id, recentSince(found.checkedAt)),
            ])
          : [0, 0];
        const applied = shopifyCodeAsDiscount(found, buyerLines, collections, {
          country: input.countryCode ?? null,
          ledgerUses,
          recentLedgerUses,
          countsApiOrders: session.store.shopifyCountsApiOrders ?? null,
        });
        if (applied.ok) {
          discount = applied.discount;
          discountSource = "shopify";
          shopifyCode = found;
        } else if (applied.reason === "exhausted") {
          discountError = DISCOUNT_EXHAUSTED;
          discountErrorCode = "discount_exhausted";
        } else {
          discountError = applied.reason === "minimum" ? "Le montant minimum pour ce code n'est pas atteint" : invalid;
          discountErrorCode = applied.reason === "minimum" ? "discount_minimum" : "discount_invalid";
        }
      }
    } else if (!discountRow) {
      discountError = invalid;
      discountErrorCode = "discount_invalid";
    } else {
      const sub = subtotal(buyerLines);
      const check = checkDiscount(discountRow, sub);
      if (check.ok) discount = discountRow;
      else if (check.reason.includes("minimum")) {
        discountError = check.reason;
        discountErrorCode = "discount_minimum";
      } else {
        discountError = invalid;
        discountErrorCode = "discount_invalid";
      }
    }
  }

  const ruleCtx = { subtotalCents: subtotal(buyerLines), productIds: buyerLines.map((l) => l.productId), country: input.countryCode ?? null };
  const eligible = allAddOns.filter((a) => addOnEligible(a.showIf, ruleCtx));
  const addOns = eligible.filter((a) => input.addOnIds.includes(a.id));

  // Shipping protection: offered by the checkout's block, priced here (never by the browser).
  const found = loadCheckoutLayout(design.checkoutLayout).blocks.find((b) => b.type === "shipping_protection" && !b.hidden);
  const block = found?.type === "shipping_protection" ? { ...found, props: withProtectionOverride(found.props, overrides) } : null;
  const protectionBlock = block && lines.some((l) => l.requiresShipping) ? block : null;
  const protectionOn = !!protectionBlock && (input.protection ?? protectionBlock.props.defaultOn);
  // Automatic discounts Shopify computed for this very cart (verified when the checkout opened).
  let automatic = automaticDiscountFor(session.cartDiscounts, buyerLines, session.currency);
  // Stacking (Shopify's combinesWith, the app's settings): only needed when discounts meet.
  const automaticStack =
    automatic.cents > 0 && (discount || tiers.breaks.length) && canReadShopifyDiscounts(session.store) ? await automaticStackFor(session.store, automatic.titles) : null;
  const stack = { automaticDiscountCents: automatic.cents, automaticStack, breaksCombineWithCodes: session.store.breaksCombineWithCodes, automaticLineCents: automatic.lineCents };
  let totals = computeTotals({ lines, rate, discount, addOns, quantityBreaks: tiers.breaks, protection: protectionOn ? protectionBlock!.props : null, ...stack });
  let offered = protectionBlock ? computeTotals({ lines, rate, discount, addOns: [], quantityBreaks: tiers.breaks, protection: protectionBlock.props, ...stack }) : null;
  // A code that doesn't combine with the automatic discount making an app's gift free (Kaching, BOGOS)
  // would have the buyer pay for that gift: the code is refused instead.
  if (totals.dropped?.includes("automatic") && discount && buyerLines.some((l) => l.appGift)) {
    discount = null;
    shopifyCode = null;
    totals = computeTotals({ lines, rate, discount, addOns, quantityBreaks: tiers.breaks, protection: protectionOn ? protectionBlock!.props : null, ...stack });
    offered = protectionBlock ? computeTotals({ lines, rate, discount, addOns: [], quantityBreaks: tiers.breaks, protection: protectionBlock.props, ...stack }) : null;
    discountError = "Ce code ne se cumule pas avec la remise qui rend gratuit le cadeau de votre panier : il n'est pas appliqué";
    discountErrorCode = "discount_not_combinable_gift";
  }
  // A discount that doesn't combine with the others was left out (the best combination for the buyer is kept).
  if (totals.dropped?.includes("code") && discount) {
    discount = null;
    shopifyCode = null;
    discountError = "Ce code ne se cumule pas avec les remises déjà appliquées : la remise la plus avantageuse est conservée";
    discountErrorCode = "discount_not_combinable";
  }
  if (totals.dropped?.includes("automatic")) automatic = { cents: 0, titles: [] };
  // The cart's own code that doesn't apply here: left out of the code field (the buyer never typed
  // it), journaled, and said (cartCodeLost). A code that lowered the cart (codeCheck, verified when the
  // checkout opened) blocks payment when these very lines would cost more than the cart showed, or
  // when Shopify couldn't be asked: never silently charged more.
  let cartCodeLost: Quote["cartCodeLost"];
  if (cartCode && !input.discountCode) {
    const check = (session.cartContext as CartContext | null)?.codeCheck;
    const required = !!check && check.code.toUpperCase() === cartCode.toUpperCase();
    const overCart = required && sameCodeCart(check!.items, buyerLines) && totals.subtotalCents - totals.discountCents > check!.totalCents;
    if (discountError) {
      await noteCartCodeDropped(session, cartCode, discountErrorCode);
      cartCodeLost = { code: cartCode, reason: discountErrorCode ?? "discount_invalid", blocking: required && (discountErrorCode === "discount_unavailable" || overCart) };
      discountError = null;
      discountErrorCode = null;
    } else if (overCart) {
      await noteCartCodeDropped(session, cartCode, "discount_amount");
      cartCodeLost = { code: cartCode, reason: "discount_amount", blocking: true };
    }
  }
  // The Shopify cart's automatic discount stopped applying because the buyer changed the lines.
  const cartAutomatic = session.cartDiscounts as { totalCents?: unknown; titles?: unknown } | null;
  const automaticLost =
    !!cartAutomatic && Number(cartAutomatic.totalCents) > 0 && !totals.dropped?.includes("automatic") && automatic.cents === 0
      ? (Array.isArray(cartAutomatic.titles) ? cartAutomatic.titles.map(String).slice(0, 5) : [])
      : null;
  const volumeBreak = quantityBreakForLines(tiers.breaks, offerBaseLines(buyerLines));
  const protectionCents = totals.protectionCents ?? 0;
  const discountedSub = totals.subtotalCents - totals.discountCents;
  const quote: Quote = {
    totals,
    rates: rates.map((r) => ({
      ...r,
      effectiveCents:
        (discount?.type === "FREE_SHIPPING" && (discount.maxShippingCents == null || r.priceCents <= discount.maxShippingCents)) ||
        (r.freeOverCents != null && discountedSub >= r.freeOverCents)
          ? 0
          : r.priceCents,
    })),
    shippingRateId: rate?.id ?? null,
    discount: discount
      ? { code: discount.code, type: discount.type, ...(discountSource === "shopify" ? { source: "shopify" as const, oncePerCustomer: !!shopifyCode?.oncePerCustomer } : {}) }
      : null,
    automaticDiscount: automatic.cents > 0 ? { cents: automatic.cents, titles: automatic.titles } : null,
    charge: await chargePlan(session.store, input.countryCode ?? null, totals.totalCents),
    discountError,
    discountErrorCode,
    addOnIds: addOns.map((a) => a.id),
    addOnPrices: Object.fromEntries(addOns.map((a) => [a.id, a.priceCents])),
    eligibleAddOnIds: eligible.map((a) => a.id),
    lines,
    volumeBreak: totals.dropped?.includes("breaks") ? { ...volumeBreak, current: null } : volumeBreak,
    gifts: {
      earned: progress.earned.filter((g) => gifts.some((l) => l.variantId === g.variantId)).map((g) => ({ title: giftTitle(g, session.lang), variantId: g.variantId })),
      next: progress.next ? { title: giftTitle(progress.next.tier, session.lang), missingQty: progress.next.missingQty, missingCents: progress.next.missingCents } : null,
    },
    protection: protectionBlock ? { selected: protectionCents > 0, priceCents: offered?.protectionCents ?? 0 } : null,
    extraAddOns: protectionCents > 0 ? [{ id: PROTECTION_ADDON_ID, title: "Protection colis", priceCents: protectionCents, variantId: null, costCents: null }] : [],
    ...(cartFrozen(buyerLines) ? { cartLocked: true } : {}),
    ...(automaticLost ? { automaticDiscountLost: automaticLost } : {}),
    ...(cartCodeLost ? { cartCodeLost } : {}),
  };
  // The Shopify code as read (limits, usage count): frozen on the snapshot, never sent to the browser.
  if (shopifyCode && discountSource === "shopify") shopifyCodeOf.set(quote, shopifyCode);
  return quote;
}

/** Whether the checkout's buyer lines are still the ones the cart's code was verified on. Pure. */
function sameCodeCart(items: { variantId: string; quantity: number }[], lines: CartLine[]): boolean {
  const key = (id: string) => id.match(/(\d+)\D*$/)?.[1] ?? id;
  const qty = (list: { variantId: string; quantity: number }[]) => {
    const m = new Map<string, number>();
    for (const l of list) m.set(key(l.variantId), (m.get(key(l.variantId)) ?? 0) + l.quantity);
    return m;
  };
  const a = qty(items);
  const b = qty(lines.filter((l) => !l.gift));
  return a.size === b.size && [...a].every(([k, n]) => b.get(k) === n);
}

/** A code the Shopify cart carried that the checkout can't apply: journaled once per store and hour. */
async function noteCartCodeDropped(session: SessionWithStore, code: string, reason: string | null) {
  if (!(await rateLimit(`journal:cart_code_dropped:${session.storeId}`, 1, 3600_000))) return;
  await recordEvent({
    storeId: session.storeId,
    sessionId: session.id,
    level: "warn",
    kind: "cart.discount_code_dropped",
    message: `Code du panier Shopify « ${code.slice(0, 60)} » non repris au checkout (${reason ?? "inapplicable"}) : vérifiez qu'il existe dans Shopify et que la lecture des codes Shopify est activée.`,
    data: { code: code.slice(0, 60), reason },
  });
}

/** Shopify code behind a quote (server side only: the quote itself goes to the browser). */
const shopifyCodeOf = new WeakMap<Quote, ShopifyCodeDiscount>();

/** Snapshot columns of a Shopify code's limits (the ledger check in markPaid reads them). */
function shopifyCodeLimits(code: ShopifyCodeDiscount | undefined) {
  if (!code) return {};
  return {
    shopifyCodeUsageLimit: code.usageLimit,
    shopifyCodeUsageCount: code.usageCount,
    shopifyCodeCheckedAt: code.checkedAt ?? new Date(),
    shopifyCodeOncePerCustomer: code.oncePerCustomer,
  };
}

/* ------------------------------------------------------------------ */
/* One-page checkout: prepare the Whop checkout, then confirm & pay    */
/* ------------------------------------------------------------------ */

/** Buyer-facing error: `code` lets the checkout show it in the buyer's language. */
export class CheckoutError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** A checkout session can be paid for this long after the cart left the store. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Upper bound on Whop configurations per session (each price change creates one). */
const MAX_QUOTES_PER_SESSION = 60;

function assertPayable(session: SessionWithStore, quote: Quote, input: QuoteInput) {
  if (session.status === "PAID") throw new CheckoutError("already_paid", "Cette commande est déjà payée");
  if (Date.now() - session.createdAt.getTime() > SESSION_TTL_MS) {
    throw new CheckoutError("expired", "Cette page de paiement a expiré. Retournez au panier pour recommencer.");
  }
  const lines = session.lines as unknown as CartLine[];
  if (lines.length === 0) throw new CheckoutError("empty_cart", "Votre panier est vide");
  if (input.discountCode && quote.discountError) throw new CheckoutError(quote.discountErrorCode ?? "discount_invalid", quote.discountError);
  // The Shopify cart's code can't be honored for this cart: never charged more than the cart showed.
  if (quote.cartCodeLost?.blocking) {
    throw quote.cartCodeLost.reason === "discount_unavailable"
      ? new CheckoutError("discount_unavailable", "Impossible de vérifier le code de votre panier pour le moment, réessayez.")
      : new CheckoutError("cart_code_lost", `Le code « ${quote.cartCodeLost.code} » de votre panier ne peut pas être appliqué ici. Retournez au panier pour finaliser votre commande.`);
  }
  if (lines.some((l) => l.requiresShipping) && !quote.shippingRateId) {
    throw new CheckoutError("no_shipping", "Nous ne livrons pas encore dans ce pays");
  }
  if (quote.totals.totalCents < 50) throw new CheckoutError("minimum_amount", "Montant minimum non atteint");
}

/** Everything that changes what the buyer pays or receives. Same fingerprint = same Whop checkout. */
export function quoteFingerprint(quote: Pick<Quote, "totals" | "shippingRateId" | "discount" | "addOnIds"> & { lines?: CartLine[]; charge?: ChargePlan | null }): string {
  const t = quote.totals;
  return [
    // Same total with other quantities is another order: never reuse its Whop checkout.
    ...(quote.lines ? [quote.lines.map((l) => `${l.variantId}x${l.quantity}@${l.unitPriceCents}`).join(",")] : []),
    t.totalCents,
    t.subtotalCents,
    t.discountCents,
    t.shippingCents,
    t.addOnsCents,
    quote.shippingRateId ?? "",
    quote.discount?.code.toUpperCase() ?? "",
    [...quote.addOnIds].sort().join(","),
    // Charged in another currency: another Whop configuration (older fingerprints unchanged).
    ...(quote.charge ? [`${quote.charge.currency}${quote.charge.totalCents}`] : []),
  ].join("|");
}

/**
 * Fingerprint of the snapshot holding a quote's Whop checkout. A PayPal-only checkout charges
 * exactly the same thing but is another Whop configuration: its own snapshot (same content,
 * suffixed fingerprint), so a buyer going back to the card gets the regular checkout again.
 */
export function snapshotFingerprint(quote: Parameters<typeof quoteFingerprint>[0], method?: "paypal" | null, returnUrl?: string | null): string {
  return quoteFingerprint(quote) + (method === "paypal" ? "|m:paypal" : "") + returnHostSuffix(returnUrl);
}

/** Whether a snapshot fingerprint is a PayPal-only checkout's (segments: "…|m:paypal|h:host"). Pure. */
export function isPaypalFingerprint(fingerprint: string | null | undefined): boolean {
  return !!fingerprint && fingerprint.split("|").includes("m:paypal");
}

/**
 * The Whop configuration also carries the return URL (thank-you page): one made for the checkout
 * domain is never reused from APP_URL's host (loader fallback) and vice versa. APP_URL's host adds
 * nothing (fingerprints of stores without a checkout domain unchanged). Pure.
 */
function returnHostSuffix(returnUrl: string | null | undefined, appUrl = env.appUrl): string {
  if (!returnUrl) return "";
  try {
    const host = new URL(returnUrl).hostname.toLowerCase();
    return host === new URL(appUrl).hostname.toLowerCase() ? "" : `|h:${host}`;
  } catch {
    return "";
  }
}

/**
 * Where Whop's last word on PayPal is kept: per store AND charged currency (PayPal support
 * depends on it), so a refusal in one currency never hides the button for the others.
 */
export function paypalSettingKey(storeId: string, currency: string): string {
  return `paypal:${storeId}:${currency.toUpperCase()}`;
}

/** Whether the store's checkout offers PayPal in this currency (as Whop last said); unknown = yes. */
export async function paypalOffered(storeId: string, currency: string): Promise<boolean> {
  const row = await db.appSetting.findUnique({ where: { key: paypalSettingKey(storeId, currency) } });
  // "off" (Whop's regular checkouts without PayPal) hides it; a refusal ("off:<date>") only for its 24 h.
  const v = row?.value;
  return !(v === "off" || refusalHolds(v));
}

/** A PayPal-only checkout Whop refused hides the button for a day, whatever regular checkouts say. */
const PAYPAL_REFUSED_MS = 24 * 3600_000;

/** Whether a remembered PayPal value is a refusal still holding the button hidden (24 h). Pure. */
function refusalHolds(value: string | null | undefined, now = Date.now()): boolean {
  return !!value?.startsWith("off:") && now - Date.parse(value.slice(4)) < PAYPAL_REFUSED_MS;
}

async function rememberPaypal(storeId: string, currency: string, offered: boolean, refused = false) {
  const key = paypalSettingKey(storeId, currency);
  const prev = await db.appSetting.findUnique({ where: { key } });
  if (offered && refusalHolds(prev?.value)) return;
  const value = offered ? "on" : refused ? `off:${new Date().toISOString()}` : "off";
  if (prev?.value === value) return;
  await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  // Whop refused a PayPal-only checkout: told once to the merchant (journal + alert), not at every
  // buyer (a refusal already holding the button hidden says nothing new).
  if (refused && !refusalHolds(prev?.value)) {
    await recordEvent({
      storeId,
      level: "warn",
      kind: "paypal.refused",
      message: `Whop a refusé PayPal (${currency.toUpperCase()}) : le bouton PayPal express est masqué 24 h. Vérifiez PayPal dans Whop → Paramètres → Moyens de paiement, puis « Réactiver PayPal » sur la page Whop.`,
      data: { currency: currency.toUpperCase() },
      alert: true,
    });
  }
}

/** PayPal refusals currently hiding the express button, by charged currency (dashboard > Whop). */
export async function paypalRefusals(storeId: string): Promise<{ currency: string; since: Date | null }[]> {
  const rows = await db.appSetting.findMany({ where: { key: { startsWith: `paypal:${storeId}:` } } });
  return rows
    .filter((r) => r.value === "off" || refusalHolds(r.value))
    .map((r) => ({ currency: r.key.slice(`paypal:${storeId}:`.length), since: r.value.startsWith("off:") ? new Date(r.value.slice(4)) : null }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

/**
 * One dashboard line per currency where PayPal express is hidden, each with its own state: refused
 * by Whop on its own date (held 24 h), or simply not offered. `fmt` formats a date (store's zone). Pure.
 */
export function paypalHiddenLines(hidden: { currency: string; since: Date | null }[], fmt: (d: Date) => string): string[] {
  return hidden.map((h) => `${h.currency} : ${h.since ? `refusé par Whop le ${fmt(h.since)} (masqué 24 h)` : "Whop ne le propose pas"}`);
}

/** Forgets what Whop said about PayPal for the store (every currency): the next checkout asks again. */
export async function clearPaypalRefusals(storeId: string): Promise<number> {
  return (await db.appSetting.deleteMany({ where: { key: { startsWith: `paypal:${storeId}:` } } })).count;
}

/**
 * Returns the Whop checkout configuration for the current quote, creating it (and a
 * frozen snapshot of what it charges) when this exact quote was never prepared.
 * The snapshot — not the session's latest state — later drives the Shopify order, so
 * racing requests or a stale wallet button can never pay for one thing and ship another.
 */
export async function prepareSession(session: SessionWithStore, input: QuoteInput, opts: { host?: string | null } = {}) {
  const quote = await quoteSession(session, input);
  assertPayable(session, quote, input);
  const method = input.method === "paypal" ? ("paypal" as const) : null;
  // The currency Whop charges (buyer's when the store charges in it): PayPal is remembered per currency.
  const chargeCurrency = quote.charge?.currency ?? session.currency;
  // The merchant's choice (builder > Paiement express): PayPal off, or the express section off or
  // hidden (where its button lives) = no PayPal-only checkout at all.
  const design = await designFor(session.store, session);
  const paypalAllowed = paypalExpressAllowed(loadTheme(design.theme, session.store.name), loadCheckoutLayout(design.checkoutLayout));
  if (method === "paypal" && (!paypalAllowed || !(await paypalOffered(session.storeId, chargeCurrency)))) {
    throw new CheckoutError("paypal_unavailable", "PayPal n'est pas disponible pour cette commande.");
  }
  // Paid through the loader's APP_URL fallback: back to APP_URL (?via=app), not the unreachable domain.
  const redirectUrl = thankYouReturnUrl(session.store, session.id, opts.host);
  const fingerprint = snapshotFingerprint(quote, method, redirectUrl);

  let snapshot = await db.checkoutQuote.findFirst({
    where: { sessionId: session.id, fingerprint },
    orderBy: { createdAt: "desc" },
  });
  if (!snapshot) {
    // Local-currency option on, but this buyer is charged in the shop's currency (no fresh ECB rate).
    if (!quote.charge && session.store.chargeLocalCurrency && input.countryCode) {
      const why = await chargeFallback(session.store, input.countryCode);
      if (why) {
        await recordIncident({
          storeId: session.storeId,
          sessionId: session.id,
          kind: "fx.charge_fallback",
          message: `Paiement proposé en ${session.currency} au lieu de ${why.currency} (${why.reason === "stale_rates" ? "taux BCE de plus de 3 jours" : why.reason === "no_rates" ? "taux BCE indisponibles" : "pas de taux pour cette devise"}).`,
          data: why,
        });
      }
    }
    const count = await db.checkoutQuote.count({ where: { sessionId: session.id } });
    if (count >= MAX_QUOTES_PER_SESSION) {
      throw new CheckoutError("too_many_changes", "Trop de modifications sur cette commande. Retournez au panier pour recommencer.");
    }
    const [rate, addOns] = await Promise.all([
      quote.shippingRateId ? db.shippingRate.findUnique({ where: { id: quote.shippingRateId } }) : null,
      db.addOn.findMany({ where: { id: { in: quote.addOnIds } } }),
    ]);
    const whop = await tagFailureSource(createCheckoutConfiguration(session.store, {
      sessionId: session.id,
      storeId: session.storeId,
      // Buyer's currency when the store charges in it (rate frozen on the snapshot below).
      totalCents: quote.charge?.totalCents ?? quote.totals.totalCents,
      currency: chargeCurrency,
      title: `Commande ${session.store.name}`,
      redirectUrl,
      country: input.countryCode ?? null,
      ...(method ? { methods: [method] } : {}),
    }).catch(async (err) => {
      // PayPal-only checkout refused (or PayPal dropped): the button hides; the regular form stays.
      // Only a clear refusal lands here (whop.ts rethrows 5xx/429/timeouts as is: nothing remembered).
      // A refusal that doesn't name PayPal / the payment method: unavailable for this session only
      // (the buyer keeps the card; nothing remembered for the store).
      if (err instanceof MethodUnavailableError) {
        if (err.remember) await rememberPaypal(session.storeId, chargeCurrency, false, true);
        throw new CheckoutError("paypal_unavailable", "PayPal n'est pas disponible pour cette commande.");
      }
      throw err;
    }), "whop");
    // Whether Whop offers PayPal, as this new checkout says (the express button follows it).
    if (typeof whop.paypal === "boolean") await rememberPaypal(session.storeId, chargeCurrency, whop.paypal);
    snapshot = await db.checkoutQuote.create({
      data: {
        sessionId: session.id,
        whopCheckoutId: whop.id,
        fingerprint,
        currency: session.currency,
        subtotalCents: quote.totals.subtotalCents,
        discountCents: quote.totals.discountCents,
        shippingCents: quote.totals.shippingCents,
        addOnsCents: quote.totals.addOnsCents,
        totalCents: quote.totals.totalCents,
        shippingRateId: rate?.id ?? null,
        shippingRateName: rate?.name ?? null,
        shippingCostCents: rate?.costCents ?? null,
        shippingCountries: rate?.countries ?? [],
        discountCode: quote.discount?.code ?? null,
        // Only when the code really made shipping free: a rate above its maximum stays paid, and
        // Shopify's free-shipping code would zero it (the order total would then not be what was paid).
        discountFreeShipping: quote.discount?.type === "FREE_SHIPPING" && !!rate && quote.totals.shippingCents === 0,
        discountSource: quote.discount ? (quote.discount.source ?? "app") : null,
        codeDiscountCents: quote.discount ? (quote.totals.codeDiscountCents ?? 0) : null,
        automaticDiscountCents: quote.totals.automaticDiscountCents ?? 0,
        chargeCurrency: quote.charge?.currency ?? null,
        chargeTotalCents: quote.charge?.totalCents ?? null,
        chargeFxRate: quote.charge?.rate ?? null,
        ...shopifyCodeLimits(shopifyCodeOf.get(quote)),
        // Shipping protection: a custom line of the Shopify order, like a variant-less add-on.
        addOns: [...addOns.map((a) => ({ id: a.id, title: a.title, priceCents: quote.addOnPrices[a.id] ?? a.priceCents, variantId: a.variantId, costCents: a.costCents })), ...quote.extraAddOns],
        lines: quote.lines as unknown as Prisma.InputJsonValue,
        addOnIds: addOns.map((a) => a.id),
      },
    });
  }

  // Never over a payment that landed meanwhile (webhook during the Shopify/Whop round-trips).
  const prepared = await db.checkoutSession.updateMany({
    where: { id: session.id, status: { not: "PAID" } },
    data: {
      ...quoteFields(quote),
      preparedTotalCents: quote.totals.totalCents,
      whopCheckoutId: snapshot.whopCheckoutId,
      preparedAt: session.preparedAt ?? new Date(),
    },
  });
  if (!prepared.count) throw new CheckoutError("already_paid", "Cette commande est déjà payée.");
  return { checkoutConfigurationId: snapshot.whopCheckoutId, totals: quote.totals, quote, paypal: paypalAllowed && (await paypalOffered(session.storeId, chargeCurrency)) };
}

function quoteFields(quote: Quote) {
  return {
    shippingRateId: quote.shippingRateId,
    discountCode: quote.discount?.code ?? null,
    addOnIds: quote.addOnIds,
    subtotalCents: quote.totals.subtotalCents,
    discountCents: quote.totals.discountCents,
    shippingCents: quote.totals.shippingCents,
    addOnsCents: quote.totals.addOnsCents,
    totalCents: quote.totals.totalCents,
  };
}

/**
 * The method of a payment possibly still going through: a PAYING session whose last attempt (the
 * "Pay" click or a PayPal window from Whop's own button) is under PAYPAL_SERVER_IN_FLIGHT_MS old.
 * The method is stored, not guessed from session.whopCheckoutId (a later prepare, e.g. from a second
 * tab, replaces it): a PayPal confirm stamps paypalWindowAt with its payClickedAt, so the window
 * being the latest attempt (or tied with the click) means PayPal; a card/wallet confirm leaves
 * paypalWindowAt older. paypalBeatAt (the heartbeat of an open PayPal window, or a late popup of
 * ours after a "blocked" verdict) is liveness only and always means PayPal: the latest of the three
 * times decides. A FAILED session (a failed card) or an OPEN one (a blocked window dropped by the
 * paypal-window route) counts only a PayPal window or beat after that attempt's click: "paypal".
 * Null when nothing is in flight (PAID, ABANDONED, an OPEN/FAILED one without a later window or beat,
 * or an old attempt). The one formula for the status route's paymentInFlight and confirmSession. Pure.
 */
export function inFlightMethod(
  session: Pick<CheckoutSession, "status" | "payClickedAt" | "paypalWindowAt" | "paypalBeatAt">,
  now = Date.now(),
): "paypal" | "other" | null {
  const clicked = session.payClickedAt?.getTime() ?? 0;
  const paypalAt = Math.max(session.paypalWindowAt?.getTime() ?? 0, session.paypalBeatAt?.getTime() ?? 0);
  if (session.status === "FAILED" || session.status === "OPEN") {
    return paypalAt > clicked && now - paypalAt < PAYPAL_SERVER_IN_FLIGHT_MS ? "paypal" : null;
  }
  if (session.status !== "PAYING") return null;
  const last = Math.max(clicked, paypalAt);
  if (!last || now - last >= PAYPAL_SERVER_IN_FLIGHT_MS) return null;
  return paypalAt >= clicked ? "paypal" : "other";
}

type InFlightFields = Pick<CheckoutSession, "status" | "payClickedAt" | "paypalWindowAt" | "paypalBeatAt">;

/** Refuses a confirm with another method than the payment in flight (see inFlightMethod). */
function assertNoOtherInFlight(session: InFlightFields, method: PayInput["method"]) {
  const inFlight = inFlightMethod(session);
  if (inFlight && inFlight !== (method === "paypal" ? "paypal" : "other")) {
    throw new CheckoutError("payment_in_flight", "Un paiement est déjà en cours de validation, patientez quelques secondes.");
  }
}

/**
 * Saves the buyer's details right before the embedded Whop form is submitted.
 * If the checkout the page holds doesn't charge exactly the current quote, returns
 * a fresh one instead so the buyer is never charged a stale amount.
 */
export async function confirmSession(session: SessionWithStore, input: PayInput, opts: { host?: string | null } = {}) {
  // A payment still going through with another method (e.g. a PayPal window in a second tab):
  // never a second charge on top of it. The same method (a card retried) and a FAILED session pass
  // (unless a PayPal window opened after the failed card). Checked again atomically below.
  assertNoOtherInFlight(session, input.method);
  const quoteInput = { ...input, countryCode: input.address.countryCode };
  const quote = await quoteSession(session, quoteInput);
  assertPayable(session, quote, quoteInput);
  const design = await designFor(session.store, session);
  const theme = loadTheme(design.theme, session.store.name);
  if (theme.requireTerms && !input.acceptsTerms) {
    throw new CheckoutError("terms_required", "Veuillez accepter les conditions générales de vente.");
  }
  // PayPal express switched off by the merchant: not even through a PayPal checkout prepared before.
  if (input.method === "paypal" && !paypalExpressAllowed(theme, loadCheckoutLayout(design.checkoutLayout))) {
    throw new CheckoutError("paypal_unavailable", "PayPal n'est pas disponible pour cette commande.");
  }
  // Shopify "once per customer" codes: not if this e-mail already paid an order with it here.
  if (quote.discount?.oncePerCustomer) {
    const used = await db.checkoutSession.count({
      where: { storeId: session.storeId, status: "PAID", id: { not: session.id }, email: { equals: input.email, mode: "insensitive" }, discountCode: { equals: quote.discount.code, mode: "insensitive" } },
    });
    if (used > 0) throw new CheckoutError("discount_invalid", "Code promo invalide ou expiré");
  }
  const chosenRate = quote.rates.find((r) => r.id === quote.shippingRateId);
  const pickup = chosenRate?.kind === "pickup";
  if (pickup && !input.pickupPoint) throw new CheckoutError("pickup_required", "Choisissez votre point relais.");
  if (pickup && input.pickupPoint!.countryCode !== input.address.countryCode) {
    throw new CheckoutError("pickup_required", "Choisissez un point relais dans votre pays de livraison.");
  }

  const configId = input.checkoutConfigurationId ?? session.whopCheckoutId;
  const snapshot = configId
    ? await db.checkoutQuote.findUnique({ where: { whopCheckoutId: configId } })
    : null;
  // The checkout must charge this quote AND offer the chosen method (PayPal-only or regular).
  if (!snapshot || snapshot.sessionId !== session.id || snapshot.fingerprint !== snapshotFingerprint(quote, input.method, thankYouReturnUrl(session.store, session.id, opts.host))) {
    const prepared = await prepareSession(session, quoteInput, opts);
    return { ready: false as const, checkoutConfigurationId: prepared.checkoutConfigurationId, totals: prepared.totals };
  }

  const clickedAt = new Date();
  const data = {
    ...quoteFields(quote),
    whopCheckoutId: snapshot.whopCheckoutId,
    preparedTotalCents: snapshot.totalCents,
    status: "PAYING" as const,
    payClickedAt: clickedAt,
    // The in-flight method (inFlightMethod): a PayPal confirm opens a PayPal window too.
    ...(input.method === "paypal" ? { paypalWindowAt: clickedAt } : {}),
    termsAcceptedAt: input.acceptsTerms ? new Date() : null,
    email: input.email,
    acceptsMarketing: input.acceptsMarketing,
    shippingAddress: input.address as Prisma.InputJsonValue,
    pickupPoint: pickup ? (input.pickupPoint as Prisma.InputJsonValue) : Prisma.DbNull,
    note: input.note || null,
  };
  // The in-flight check above, made atomic: written only if no attempt (a "Pay" click or a PayPal
  // window) landed since the times it read. Two simultaneous confirms with different methods can't
  // both pass: the loser reads the winner's attempt and is refused (payment_in_flight); the same
  // method (a double click) goes through on the next round.
  let seen: InFlightFields = session;
  for (let round = 0; ; round++) {
    const confirmed = await db.checkoutSession.updateMany({
      where: { id: session.id, status: { not: "PAID" }, payClickedAt: seen.payClickedAt, paypalWindowAt: seen.paypalWindowAt, paypalBeatAt: seen.paypalBeatAt },
      data,
    });
    if (confirmed.count) break;
    const now = await db.checkoutSession.findUnique({ where: { id: session.id }, select: { status: true, payClickedAt: true, paypalWindowAt: true, paypalBeatAt: true } });
    if (!now || now.status === "PAID") throw new CheckoutError("already_paid", "Cette commande est déjà payée.");
    assertNoOtherInFlight(now, input.method);
    // Attempts keep landing (never in practice): refused like one in flight, the buyer retries.
    if (round >= 2) throw new CheckoutError("payment_in_flight", "Un paiement est déjà en cours de validation, patientez quelques secondes.");
    seen = now;
  }
  if (input.method === "paypal") log.info("checkout.pay_method", "Paiement lancé avec PayPal (bouton express)", { storeId: session.storeId, sessionId: session.id, method: "paypal" });
  return { ready: true as const, checkoutConfigurationId: snapshot.whopCheckoutId, totals: quote.totals };
}

/* ------------------------------------------------------------------ */
/* Webhook handlers                                                    */
/* ------------------------------------------------------------------ */

type PaymentAddress = {
  name: string | null;
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
};

export type PaymentBuyer = {
  email: string | null;
  /** Shipping address collected by Whop (express wallets). Wins over the form's, except for PayPal (paid after the form). */
  shippingAddress?: PaymentAddress | null;
  /** Billing address: only used when nothing better is known. */
  address: PaymentAddress | null;
  phone: string | null;
};

/** Express wallets (Apple Pay, Google Pay) pay without our form: take the buyer from the payment. */
export function addressFromPayment(buyer: Pick<PaymentBuyer, "address" | "phone"> & Partial<PaymentBuyer>): Address | null {
  const a = buyer.address;
  if (!a?.line1 || !a.city || !a.country) return null;
  const [firstName, ...rest] = (a.name ?? "").trim().split(/\s+/);
  return {
    firstName: firstName || "Client",
    lastName: rest.join(" ") || "-",
    address1: a.line1,
    address2: a.line2,
    city: a.city,
    province: a.state,
    zip: a.postal_code ?? "",
    countryCode: a.country.toUpperCase().slice(0, 2),
    phone: buyer.phone,
  };
}

export type PaymentInfo = {
  id: string;
  /** Settlement amount (`total`). */
  totalCents: number | null;
  currency: string | null;
  /** What the buyer was charged in their currency (`presentment_total`), when Whop sends it. */
  presentmentCents?: number | null;
  presentmentCurrency?: string | null;
  checkoutConfigurationId?: string | null;
  /** Saved payment method, used for one-click post-purchase offers. */
  memberId?: string | null;
  paymentMethodId?: string | null;
  /** card, apple_pay, paypal, klarna… (analytics) */
  paymentMethodType?: string | null;
  /** Whop's fee on the payment, in cents (net-margin analytics). */
  feeCents?: number | null;
  buyer?: PaymentBuyer;
};

/** Reasons a paid order must be looked at by a human before it goes to Shopify. */
export function reviewReasons(
  snapshot: { totalCents: number; currency: string; shippingCountries: string[]; shippingRateId: string | null },
  payment: Pick<PaymentInfo, "totalCents" | "currency" | "presentmentCents" | "presentmentCurrency">,
  address: Address | null,
): string[] {
  const reasons: string[] = [];
  const cur = snapshot.currency.toUpperCase();
  // Compare in the checkout's currency: presentment first (what the buyer paid), then settlement.
  const amount =
    payment.presentmentCents != null && payment.presentmentCurrency?.toUpperCase() === cur
      ? payment.presentmentCents
      : payment.totalCents != null && payment.currency?.toUpperCase() === cur
        ? payment.totalCents
        : null;
  if (payment.totalCents == null && payment.presentmentCents == null) {
    reasons.push("montant ou devise du paiement illisible");
  } else if (amount != null && amount < snapshot.totalCents) {
    // amount == null (neither amount in the checkout's currency, e.g. adaptive pricing on a
    // USD-settling account) is safe only because markPaid ties the payment to our own
    // checkout configuration, whose price Whop enforces; an unknown one is held there.
    reasons.push(`montant payé (${amount}) inférieur au total (${snapshot.totalCents})`);
  }
  if (
    snapshot.shippingRateId &&
    address &&
    snapshot.shippingCountries.length > 0 &&
    !snapshot.shippingCountries.includes(address.countryCode.toUpperCase())
  ) {
    reasons.push(`pays de livraison ${address.countryCode} non couvert par le tarif payé`);
  }
  return reasons;
}

/**
 * Marks the session paid and creates the Shopify order. Safe to call repeatedly and
 * concurrently (webhook redeliveries, reconciliation). Never throws for a Shopify
 * failure: the payment is recorded and the sync is retried in the background.
 *
 * With `deferSync`, returns true when the caller must run `syncOrderSafely` itself
 * (the webhook does it after answering Whop).
 */
export async function markPaid(
  sessionId: string,
  payment: PaymentInfo,
  opts: {
    deferSync?: boolean;
    /** Set by this call: `paidNow` when it marked the session paid (false: already paid, e.g. a duplicate payment). */
    outcome?: { paidNow?: boolean };
  } = {},
): Promise<boolean> {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error(`Session ${sessionId} introuvable`);

  if (session.status === "PAID") return alreadyPaid(session, payment, opts);

  // The configuration that was actually paid decides what the order contains.
  const configId = payment.checkoutConfigurationId ?? session.whopCheckoutId;
  const snapshot = configId ? await db.checkoutQuote.findUnique({ where: { whopCheckoutId: configId } }) : null;
  const paid = snapshot && snapshot.sessionId === sessionId ? snapshot : null;

  const walletAddress = payment.buyer?.shippingAddress
    ? addressFromPayment({ address: payment.buyer.shippingAddress, phone: payment.buyer.phone })
    : null;
  // PayPal is paid after our form (express PayPal button included): the address the buyer typed
  // (or the relay point's) was chosen for this order and wins over PayPal's account address.
  const formAddress = session.shippingAddress as Address | null;
  const paidWithPaypal = payment.paymentMethodType === "paypal" || isPaypalFingerprint(paid?.fingerprint);
  const address =
    (paidWithPaypal ? formAddress : null) ??
    walletAddress ??
    formAddress ??
    (payment.buyer ? addressFromPayment(payment.buyer) : null);

  // Charged in the buyer's currency: Whop's amounts are in that currency (compared as such, fee converted back).
  const charged = paid?.chargeCurrency && paid.chargeTotalCents != null ? { currency: paid.chargeCurrency, totalCents: paid.chargeTotalCents, rate: paid.chargeFxRate } : null;
  const reasons = reviewReasons(
    paid ? (charged ? { ...paid, currency: charged.currency, totalCents: charged.totalCents } : paid) : { totalCents: session.totalCents, currency: session.currency, shippingCountries: [], shippingRateId: null },
    payment,
    address,
  );
  const feeCents =
    payment.feeCents != null && charged && payment.currency?.toUpperCase() === charged.currency.toUpperCase() ? toShopCents(payment.feeCents, charged.rate) : payment.feeCents;
  if (!paid) reasons.push("configuration de paiement inconnue");
  // A physical order with no shipping address from the wallet nor from our form (e.g. Google Pay
  // express: Whop collects no shipping address there): never shipped to a guess silently. Held for
  // review, with the billing address (if any) as a starting point for the merchant.
  const paidLines = (paid?.lines ?? session.lines) as { requiresShipping?: boolean }[] | null;
  const shipsGoods = Array.isArray(paidLines) && paidLines.some((l) => l?.requiresShipping);
  if (shipsGoods && !walletAddress && !formAddress) {
    reasons.push(address ? "adresse de livraison absente du paiement (adresse de facturation reprise, à confirmer)" : "adresse de livraison absente du paiement");
  }

  // One transaction: PAID, the discount use and the review decision become visible
  // together, so a concurrent delivery can never see "PAID, no hold" and sync an
  // order that should have been held.
  const outcome = await db.$transaction(async (tx) => {
    const transition = await tx.checkoutSession.updateMany({
      where: { id: sessionId, status: { not: "PAID" } },
      data: {
        status: "PAID",
        paidAt: new Date(),
        whopPaymentId: payment.id,
        whopMemberId: payment.memberId ?? null,
        whopPaymentMethodId: payment.paymentMethodId ?? null,
        paymentMethodType: payment.paymentMethodType ?? null,
        whopFeeCents: feeCents ?? null,
        syncError: null,
        email: session.email ?? payment.buyer?.email ?? null,
        ...(address ? { shippingAddress: address as Prisma.InputJsonValue } : {}),
        ...(paid
          ? {
              paidQuoteId: paid.id,
              chargeCurrency: paid.chargeCurrency,
              chargeFxRate: paid.chargeFxRate,
              whopCheckoutId: paid.whopCheckoutId,
              shippingRateId: paid.shippingRateId,
              discountCode: paid.discountCode,
              addOnIds: paid.addOnIds,
              subtotalCents: paid.subtotalCents,
              discountCents: paid.discountCents,
              shippingCents: paid.shippingCents,
              addOnsCents: paid.addOnsCents,
              totalCents: paid.totalCents,
              // What was paid for, even if quantities changed in another tab afterwards.
              ...(paid.lines ? { lines: paid.lines as Prisma.InputJsonValue } : {}),
            }
          : {}),
      },
    });
    if (transition.count === 0) return null;
    const all = [...reasons];
    // Shopify codes count their uses in Shopify (the order carries the code), not in the app's list.
    if (paid?.discountCode && paid.discountSource !== "shopify") {
      // Atomic: a code with one use left can't be consumed twice.
      const used = await tx.$executeRaw`
        UPDATE "DiscountCode" SET "usageCount" = "usageCount" + 1
        WHERE "storeId" = ${session.storeId} AND "code" = ${paid.discountCode}
          AND ("usageLimit" IS NULL OR "usageCount" < "usageLimit")`;
      if (used === 0) all.push(`code promo ${paid.discountCode} déjà épuisé au moment du paiement`);
    }
    // Shopify codes: this app's own ledger (Shopify's count only moves once the orders exist).
    if (paid?.discountCode && paid.discountSource === "shopify") all.push(...(await claimShopifyCodeUse(tx, session.storeId, sessionId, session.email ?? payment.buyer?.email ?? null, paid)));
    const reviewNote = all.length ? `À vérifier : ${all.join(" ; ")}. Remboursez dans Whop ou synchronisez la commande manuellement.` : null;
    if (reviewNote) await tx.checkoutSession.update({ where: { id: sessionId }, data: { reviewNote } });
    return { reviewNote };
  });
  // Lost the race: another delivery marked it paid first (its decision is committed).
  if (!outcome) return markPaid(sessionId, payment, opts);
  if (opts.outcome) opts.outcome.paidNow = true;
  // Costs entered in the app ("Coûts produits") win over Shopify's: applied before anything reads the margin.
  await applyAppCosts(sessionId);

  await recordEvent({
    storeId: session.storeId,
    sessionId,
    kind: "payment.succeeded",
    message: `Paiement ${payment.id} reçu (${(paid?.totalCents ?? session.totalCents) / 100} ${session.currency})`,
  });
  const conversions = () =>
    sendPurchaseConversions(sessionId).catch((err) => log.error("conversions.failed", "Server-side purchase event failed", { sessionId, err }));
  if (!defer("conversions.purchase", conversions)) await conversions();

  if (outcome.reviewNote) {
    await recordEvent({ storeId: session.storeId, sessionId, level: "warn", kind: "review.hold", message: outcome.reviewNote, alert: true });
    return false;
  }
  if (opts.deferSync) return true;
  await syncOrderSafely(sessionId);
  return false;
}

/**
 * Records a paid use of a Shopify code in the ledger, under a per-code transaction lock, and
 * returns why the order must be held: the code's usage limit reached (see shopifyCodeUses: Shopify's
 * count read with the quote plus every other use in the ledger) or a "once per customer" code
 * already used by this e-mail. The use is recorded either way (a held order may still be shipped).
 */
export async function claimShopifyCodeUse(
  tx: Prisma.TransactionClient,
  storeId: string,
  sessionId: string,
  email: string | null,
  q: Pick<CheckoutQuote, "discountCode" | "shopifyCodeUsageLimit" | "shopifyCodeUsageCount" | "shopifyCodeCheckedAt" | "shopifyCodeOncePerCustomer">,
): Promise<string[]> {
  if (!q.discountCode) return [];
  const code = q.discountCode.toUpperCase();
  const to = email?.trim().toLowerCase() || null;
  // Two payments of the same code decide one after the other (each sees the other's use).
  await tx.$queryRaw`SELECT 1 FROM (SELECT pg_advisory_xact_lock(hashtext(${`shopify-code:${storeId}:${code}`}))) AS l`;
  const reasons: string[] = [];
  if (q.shopifyCodeOncePerCustomer && to) {
    const [inLedger, paidBefore] = await Promise.all([
      tx.shopifyCodeUse.count({ where: { storeId, code, email: to, sessionId: { not: sessionId } } }),
      tx.checkoutSession.count({
        where: { storeId, status: "PAID", id: { not: sessionId }, email: { equals: to, mode: "insensitive" }, discountCode: { equals: code, mode: "insensitive" } },
      }),
    ]);
    if (inLedger + paidBefore > 0) reasons.push(`code Shopify ${code} (« une fois par client ») déjà utilisé par ${to}`);
  }
  if (q.shopifyCodeUsageLimit != null) {
    const calibrated = (await tx.store.findUnique({ where: { id: storeId }, select: { shopifyCountsApiOrders: true } }))?.shopifyCountsApiOrders ?? null;
    const used = shopifyCodeUses(
      q.shopifyCodeUsageCount ?? 0,
      await shopifyCodeLedgerUses(tx, storeId, code, sessionId),
      calibrated,
      calibrated === true ? await shopifyCodeLedgerUses(tx, storeId, code, sessionId, recentSince(q.shopifyCodeCheckedAt)) : 0,
    );
    if (used + 1 > q.shopifyCodeUsageLimit) reasons.push(`code Shopify ${code} : limite de ${q.shopifyCodeUsageLimit} utilisation(s) atteinte au moment du paiement`);
  }
  // Shopify's count as read with the paid quote, before this use: calibrates shopifyCountsApiOrders.
  await tx.shopifyCodeUse.createMany({ data: [{ storeId, code, sessionId, email: to, createdAt: new Date(), shopifyCountBefore: q.shopifyCodeUsageCount ?? null }], skipDuplicates: true });
  return reasons;
}

/**
 * Paid uses of a Shopify code in this app's ledger (the code is stored upper-cased), this checkout's
 * excluded; with `since`, only the uses recorded from then on.
 */
export function shopifyCodeLedgerUses(client: Prisma.TransactionClient | typeof db, storeId: string, code: string, exceptSessionId: string, since?: Date): Promise<number> {
  return client.shopifyCodeUse.count({ where: { storeId, code: code.toUpperCase(), sessionId: { not: exceptSessionId }, ...(since ? { createdAt: { gte: since } } : {}) } });
}

/**
 * Ledger uses possibly missing from a Shopify count read at `checkedAt`: those recorded after it, and
 * those within the settle lag before it (Shopify updates asyncUsageCount asynchronously). Unknown read
 * time: all of them (epoch).
 */
function recentSince(checkedAt: Date | null | undefined): Date {
  return checkedAt ? new Date(checkedAt.getTime() - CALIBRATION_SETTLE_MS) : new Date(0);
}

async function alreadyPaid(session: CheckoutSession, payment: PaymentInfo, opts: { deferSync?: boolean }): Promise<boolean> {
  if (session.whopPaymentId && session.whopPaymentId !== payment.id) {
    // A second payment for the same cart (e.g. wallet + card): keep the first order
    // going, and flag the extra payment for a refund without blocking anything.
    const added = await db.$executeRaw`
      UPDATE "CheckoutSession" SET "extraPaymentIds" = array_append("extraPaymentIds", ${payment.id})
      WHERE id = ${session.id} AND NOT (${payment.id} = ANY("extraPaymentIds"))`;
    if (added > 0) {
      await recordEvent({
        storeId: session.storeId,
        sessionId: session.id,
        level: "warn",
        kind: "payment.duplicate",
        message: `Paiement supplémentaire ${payment.id} reçu pour un panier déjà payé — à rembourser dans Whop.`,
        alert: true,
      });
    }
    return false;
  }
  if (session.reviewNote || session.shopifyOrderId) return false;
  if (opts.deferSync) return true;
  await syncOrderSafely(session.id);
  return false;
}

/** Minutes to wait before each automatic retry of a failed Shopify sync. */
// Starts at 5 min: Shopify's order search is eventually consistent, so an order created
// by a timed-out attempt must be findable before we try again.
export const SYNC_BACKOFF_MINUTES = [5, 15, 60, 180, 360, 720, 1440];

/**
 * Runs syncOrder; failures are already recorded and scheduled for retry, so they don't
 * propagate. True when this run took the lease (created, skipped or a recorded failure).
 */
export async function syncOrderSafely(sessionId: string): Promise<boolean> {
  try {
    return await syncOrder(sessionId);
  } catch (err) {
    /* recorded in syncOrder */
    if (!(err instanceof DeadlineError)) return true;
    // Out of time (lease released, nothing sent): the job reports partial, the retry job backstops it.
    notePartial();
    return false;
  }
}

export type SyncSkipReason = "refunded" | "dispute_lost";

/**
 * A paid order that must not be created in Shopify any more: fully refunded before its
 * creation (nothing to ship), or its chargeback lost (the money is gone).
 */
export function syncSkipReason(o: { refundedCents: number; paidCents: number; disputeStatus: string | null }): SyncSkipReason | null {
  if (o.paidCents > 0 && o.refundedCents >= o.paidCents) return "refunded";
  if (o.disputeStatus === "lost") return "dispute_lost";
  return null;
}

export function syncSkipMessage(reason: SyncSkipReason, what = "Commande"): string {
  return reason === "refunded"
    ? `${what} remboursée avant création : commande non créée dans Shopify (rien à expédier).`
    : `${what} dont le litige est perdu avant création : commande non créée dans Shopify (fonds rendus au client).`;
}

/** Shopify's order search (tag lookup) needs a few minutes to see a new order. */
export const AMBIGUOUS_WAIT_MS = 5 * 60_000;
/** Lease on a Shopify order creation (sessions and one-click offers). */
export const SYNC_LEASE_MS = 2 * 60_000;

/** An order creation failed with a definite answer from Shopify (validation), not a timeout. */
export function isDefiniteOrderError(err: unknown): boolean {
  return err instanceof ShopifyError && err.message.startsWith("Création de la commande");
}

/**
 * Creates the Shopify order for a paid session if it doesn't exist yet. Returns whether
 * this run took the lease (false: nothing to do, or another run is on it).
 */
export async function syncOrder(sessionId: string): Promise<boolean> {
  // Take a short lease so concurrent webhook retries can't double-create the order.
  const leaseExpired = new Date(Date.now() - SYNC_LEASE_MS);
  const claim = await db.checkoutSession.updateMany({
    where: {
      id: sessionId,
      status: "PAID",
      shopifyOrderId: null,
      // A payment held for review is only synced after the merchant clears the hold.
      reviewNote: null,
      // Linked to an order created by hand: never create another one.
      syncHandledAt: null,
      AND: [
        { OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: leaseExpired } }] },
        // After an ambiguous failure (Shopify may have created the order), wait until its tag
        // search is consistent — manual retries included — so the lookup can find it.
        { OR: [{ syncAmbiguousAt: null }, { syncAmbiguousAt: { lt: new Date(Date.now() - AMBIGUOUS_WAIT_MS) } }] },
      ],
    },
    data: { syncStartedAt: new Date() },
  });
  if (claim.count === 0) return false;

  const session = await db.checkoutSession.findUniqueOrThrow({ where: { id: sessionId }, include: { store: true } });
  let order: { id: string; name: string; oversold?: boolean; customer?: OrderCustomer | null } | null = null;
  let creating = false;
  try {
    // Idempotency: an earlier attempt may have created the order and then failed to record it.
    // If this lookup fails we must not guess: the error goes to the retry backoff.
    order = await findOrderForSession(session.store, session.id);
    // After an ambiguous attempt (timeout), a second, independent lookup by the Whop payment
    // (source identifier / payment tag) before creating anything.
    if (!order && session.syncAmbiguousAt && session.whopPaymentId) order = await findOrderByPayment(session.store, { sessionId: session.id, paymentId: session.whopPaymentId });
    const skip = order ? null : syncSkipReason({ refundedCents: session.refundedCents, paidCents: session.totalCents, disputeStatus: session.disputeStatus });
    if (skip) {
      await skipSync(session, skip);
      return true;
    }
    if (!order) {
      const input = await buildOrderInput(session);
      // Write-ahead: from here on the order may exist even if this run dies (timeout, crash)
      // before recording it; retries then wait for Shopify's search to see it.
      await db.checkoutSession.update({ where: { id: sessionId }, data: { syncAmbiguousAt: new Date() } });
      creating = true;
      order = await createPaidOrder(session.store, input);
    }
  } catch (err) {
    if (err instanceof DeadlineError) {
      // Not a failure: release the lease, the next run retries without spending an attempt.
      // (Thrown before the request was sent: nothing can have been created.)
      await db.checkoutSession.update({ where: { id: sessionId }, data: { syncStartedAt: null, ...(creating ? { syncAmbiguousAt: null } : {}) } });
      throw err;
    }
    const attempts = session.syncAttempts + 1;
    const delay = SYNC_BACKOFF_MINUTES[attempts - 1];
    const message = err instanceof Error ? err.message.slice(0, 1000) : String(err);
    await db.checkoutSession.update({
      where: { id: sessionId },
      data: {
        syncError: message,
        syncStartedAt: null,
        syncAttempts: attempts,
        nextSyncAt: delay != null ? new Date(Date.now() + Math.max(delay * 60_000, creating ? AMBIGUOUS_WAIT_MS : 0)) : null,
        // orderCreate failed without a Shopify answer (timeout, network, 5xx): it may exist
        // (the write-ahead mark stays, refreshed); a definite refusal created nothing.
        ...(creating ? { syncAmbiguousAt: isDefiniteOrderError(err) ? null : new Date() } : {}),
      },
    });
    await recordEvent({
      storeId: session.storeId,
      sessionId,
      level: "error",
      kind: delay != null ? "sync.failed" : "sync.gave_up",
      message:
        delay != null
          ? `Commande payée non créée dans Shopify (essai ${attempts}) : ${message}. Nouvel essai automatique dans ${delay} min.`
          : `Commande payée toujours absente de Shopify après ${attempts} essais : ${message}. Action manuelle requise.`,
      // Alert on the first failure and when retries are exhausted, not on every retry.
      alert: attempts === 1 || delay == null,
      err,
    });
    throw err;
  }

  // The order exists in Shopify now: never release the lease without recording it,
  // or a retry could create it twice (the tag lookup covers the lease-expiry case).
  for (let i = 0; ; i++) {
    try {
      await db.checkoutSession.update({
        where: { id: sessionId },
        data: { shopifyOrderId: order.id, shopifyOrderName: order.name, shopifyOrderAt: new Date(), syncError: null, syncStartedAt: null, nextSyncAt: null, syncAmbiguousAt: null },
      });
      break;
    } catch (err) {
      if (i >= 2) throw err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  // Buyer's orders on the Shopify store before this one (new vs returning in analytics). Never throws.
  await recordOrderCustomer(session, order);
  await afterOrderCreated(session, order);
  return true;
}

/**
 * Marks a paid order as handled without a Shopify order (fully refunded / chargeback lost
 * before creation): no retry, not counted as waiting, journaled and alerted once.
 */
async function skipSync(session: SessionWithStore, reason: SyncSkipReason) {
  const done = await db.checkoutSession.updateMany({
    where: { id: session.id, shopifyOrderId: null, syncHandledAt: null },
    data: { syncHandledAt: new Date(), syncSkippedReason: reason, syncStartedAt: null, nextSyncAt: null, syncError: null, syncAmbiguousAt: null },
  });
  if (!done.count) return;
  await recordEvent({
    storeId: session.storeId,
    sessionId: session.id,
    level: "warn",
    kind: "sync.skipped",
    message: `${syncSkipMessage(reason)} Aucune action requise, sauf si le client doit tout de même être livré.`,
    data: { reason, refundedCents: session.refundedCents, totalCents: session.totalCents, disputeStatus: session.disputeStatus },
    alert: true,
  });
}

async function afterOrderCreated(session: SessionWithStore, order: { id: string; name: string; oversold?: boolean }) {
  const sessionId = session.id;
  await recordEvent({ storeId: session.storeId, sessionId, kind: "order.synced", message: `Commande ${order.name} créée dans Shopify` });
  if (order.oversold) {
    await recordEvent({
      storeId: session.storeId,
      sessionId,
      level: "warn",
      kind: "order.oversold",
      message: `${order.name} payée alors que le stock Shopify était épuisé : commande créée quand même (tag « stock-insuffisant »). Réassortissez ou remboursez le client.`,
      alert: true,
    });
  }

  // Refunds or disputes that arrived before (or while) the order was being created:
  // re-read now that shopifyOrderId is recorded, so none can slip between the two.
  try {
    await mirrorRefunds(sessionId, { force: true });
    const fresh = await db.checkoutSession.findUniqueOrThrow({ where: { id: sessionId }, select: { disputed: true } });
    if (fresh.disputed) {
      await tagOrder(session.store, order.id, ["litige-whop"]);
      await db.checkoutSession.update({ where: { id: sessionId }, data: { disputeTaggedAt: new Date() } });
    }
  } catch (err) {
    log.error("sync.replay_failed", "Replaying refund/dispute on the new order failed", { sessionId, err });
  }
}

async function buildOrderInput(session: SessionWithStore) {
  const snapshot = session.paidQuoteId ? await db.checkoutQuote.findUnique({ where: { id: session.paidQuoteId } }) : null;
  let addOns: { title: string; priceCents: number; variantId: string | null }[];
  let shipping: { title: string; priceCents: number } | null;
  let freeShipping: boolean;
  if (snapshot) {
    addOns = snapshot.addOns as unknown as typeof addOns;
    shipping = snapshot.shippingRateId ? { title: snapshot.shippingRateName ?? "Livraison", priceCents: snapshot.shippingCents } : null;
    freeShipping = snapshot.discountFreeShipping;
  } else {
    // Sessions paid before quote snapshots existed.
    const [rate, liveAddOns, discount] = await Promise.all([
      session.shippingRateId ? db.shippingRate.findUnique({ where: { id: session.shippingRateId } }) : null,
      db.addOn.findMany({ where: { id: { in: session.addOnIds } } }),
      session.discountCode ? db.discountCode.findFirst({ where: { storeId: session.storeId, code: session.discountCode } }) : null,
    ]);
    addOns = liveAddOns.map((a) => ({ title: a.title, priceCents: a.priceCents, variantId: a.variantId }));
    shipping = session.shippingRateId ? { title: rate?.name ?? "Livraison", priceCents: session.shippingCents } : null;
    freeShipping = discount?.type === "FREE_SHIPPING" && session.shippingCents === 0;
  }
  return {
    sessionId: session.id,
    currency: session.currency,
    email: session.email ?? "",
    acceptsMarketing: session.acceptsMarketing,
    buyerNote: session.note,
    // The Shopify cart's note and attributes (bundle / gift / delivery apps read them on the order).
    cart: (session.cartContext as CartContext | null) ?? null,
    // Titles of Shopify's automatic discounts (bundle apps' deals) the paid amount includes: stated on
    // the order (orderCreate has no per-line discount; their amounts are folded into the line prices).
    automaticTitles:
      (snapshot?.automaticDiscountCents ?? 0) > 0 && Array.isArray((session.cartDiscounts as { titles?: unknown } | null)?.titles)
        ? ((session.cartDiscounts as { titles: unknown[] }).titles.map(String).slice(0, 5))
        : [],
    shippingAddress: session.shippingAddress as Address | null,
    pickupPoint: (session.pickupPoint as PickupPoint | null) ?? null,
    lines: ((snapshot?.lines as unknown as CartLine[] | null) ?? session.lines) as unknown as CartLine[],
    addOns,
    // Code and/or quantity break: folded into line prices so Shopify's total matches what was paid.
    // The paid snapshot is the truth (the session row may have been re-quoted since).
    discount: (() => {
      const code = snapshot ? snapshot.discountCode : session.discountCode;
      const cents = snapshot ? snapshot.discountCents : session.discountCents;
      if (!(code || cents > 0)) return null;
      // A Shopify code is recorded as the order's discount code (its amount taken by Shopify);
      // the rest (quantity breaks, automatic discounts) stays folded into the line prices.
      const native =
        snapshot?.discountSource === "shopify" && code && !freeShipping && (snapshot.codeDiscountCents ?? 0) > 0 ? { nativeCodeCents: snapshot.codeDiscountCents! } : {};
      return { code: code ?? "REMISE-QUANTITE", amountCents: cents, freeShipping: !!code && freeShipping, ...native };
    })(),
    // Shopify's automatic discount as paid, on the lines the cart put it on (the rest is spread by value).
    automaticDiscount: (() => {
      const cents = snapshot?.automaticDiscountCents ?? 0;
      if (!(cents > 0)) return null;
      const lines = ((snapshot?.lines as unknown as CartLine[] | null) ?? (session.lines as unknown as CartLine[])) ?? [];
      const { lineCents } = automaticDiscountFor(session.cartDiscounts, lines, session.currency);
      return { cents, ...(lineCents ? { lineCents } : {}) };
    })(),
    shipping,
    totalCents: snapshot?.totalCents ?? session.totalCents,
    whopPaymentId: session.whopPaymentId ?? "",
    test: session.store.testMode,
  };
}

/**
 * Applies one Whop refund, exactly once per refund id: the id marker and the amount
 * are written in one transaction (a crash can't keep one without the other).
 * Mirroring to Shopify is a separate, retryable step.
 */
export async function recordRefund(sessionId: string, refundCents: number, refundId: string, chargeCents: number | null = null) {
  if (refundCents <= 0 && !(chargeCents && chargeCents > 0)) return;
  let amountCents = refundCents;
  const applied = await applyRefundOnce(refundId, async (tx) => {
    // Charged in the buyer's currency: the refund is counted in that currency, and "fully refunded"
    // is decided there, so partial refunds converted back one by one can't drift off the total.
    if (chargeCents != null) {
      const [row] = await tx.$queryRaw<{ totalCents: number; refundedCents: number; refundedChargeCents: number; chargeTotalCents: number | null }[]>`
        SELECT s."totalCents", s."refundedCents", s."refundedChargeCents", q."chargeTotalCents"
        FROM "CheckoutSession" s LEFT JOIN "CheckoutQuote" q ON q.id = s."paidQuoteId"
        WHERE s.id = ${sessionId} FOR UPDATE OF s`;
      if (row?.chargeTotalCents != null) {
        const left = Math.max(0, row.totalCents - row.refundedCents);
        // Whole charge refunded: exactly what remains in the shop currency; else never all of it.
        amountCents = row.refundedChargeCents + chargeCents >= row.chargeTotalCents ? left : Math.min(amountCents, Math.max(0, left - 1));
      }
    }
    // A new refund restarts mirroring from a clean slate (no backoff inherited).
    const session = await tx.checkoutSession.update({
      where: { id: sessionId },
      data: {
        refundedCents: { increment: amountCents },
        ...(chargeCents != null ? { refundedChargeCents: { increment: chargeCents } } : {}),
        refundMirrorAttempts: 0,
        nextRefundMirrorAt: null,
        lastRefundAt: new Date(),
        // The Google Ads conversion's value changed: adjusted by the tick.
        ...GOOGLE_ADJUST_DUE,
      },
    });
    // Dated record: "refunds of the period" and the CSV use the refund's own date.
    await tx.refundRecord.create({ data: { id: refundId, storeId: session.storeId, sessionId, amountCents, currency: session.currency } });
    return session;
  });
  if (!applied) return;
  await recordEvent({
    storeId: applied.storeId,
    sessionId,
    kind: "refund.recorded",
    message: `Remboursement Whop de ${amountCents / 100} ${applied.currency} enregistré`,
  });
  if (!applied.shopifyOrderId && !applied.syncHandledAt) {
    // Paid, not in Shopify yet: fully refunded now, it must never be created.
    await settleUnsyncedSession(sessionId);
  }
  if (applied.syncSkippedReason) return; // deliberately not created in Shopify: nothing to report there
  if (applied.syncHandledAt && !applied.shopifyOrderId) {
    // Order created by hand: nothing to mirror automatically, the merchant must do it.
    await recordEvent({
      storeId: applied.storeId,
      sessionId,
      level: "warn",
      kind: "refund.manual_order",
      message: `Remboursement Whop de ${formatAmount(amountCents, applied.currency)} : reportez-le à la main sur ${applied.shopifyOrderName ?? "la commande créée à la main"} dans Shopify (commande liée à la main, pas de report automatique).`,
      data: { refundId, amountCents },
      alert: true,
    });
    return;
  }
  if (!defer("refund.mirror", () => mirrorRefunds(sessionId, { force: true }))) await mirrorRefunds(sessionId, { force: true });
}

/**
 * A paid session without a Shopify order that just became fully refunded or lost its
 * dispute: settled now when nothing can have been created (no creation in flight, no
 * ambiguous attempt; an order held for review was never attempted). Otherwise the sync
 * is made due, and it looks the order up before deciding (see syncOrder).
 */
export async function settleUnsyncedSession(sessionId: string) {
  const s = await db.checkoutSession.findUnique({ where: { id: sessionId } });
  if (!s || s.status !== "PAID" || s.shopifyOrderId || s.syncHandledAt) return;
  const reason = syncSkipReason({ refundedCents: s.refundedCents, paidCents: s.totalCents, disputeStatus: s.disputeStatus });
  if (!reason) return;
  const leaseFree = { OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(Date.now() - SYNC_LEASE_MS) } }] };
  if (!s.syncAmbiguousAt) {
    const settled = await db.checkoutSession.updateMany({
      where: { id: sessionId, shopifyOrderId: null, syncHandledAt: null, syncAmbiguousAt: null, ...leaseFree },
      data: { syncHandledAt: new Date(), syncSkippedReason: reason, syncStartedAt: null, nextSyncAt: null, syncError: null },
    });
    if (settled.count) {
      await recordEvent({
        storeId: s.storeId,
        sessionId,
        level: "warn",
        kind: "sync.skipped",
        message: `${syncSkipMessage(reason)}${s.reviewNote ? " (paiement qui était mis de côté pour vérification)" : ""} Aucune action requise.`,
        data: { reason, refundedCents: s.refundedCents, totalCents: s.totalCents, disputeStatus: s.disputeStatus },
        alert: true,
      });
      return;
    }
  }
  // Maybe created by an ambiguous attempt, or being created: the sync decides after its lookup.
  if (!s.reviewNote) await db.checkoutSession.updateMany({ where: { id: sessionId, shopifyOrderId: null, syncHandledAt: null }, data: { nextSyncAt: new Date() } });
}

/**
 * Runs `apply` once per refund id (marker row `refund:<id>` in the same transaction, under
 * the owning store). Null if already applied. A refund belongs to one payment, hence to one
 * store: the marker can't be written by two stores for the same refund.
 */
export async function applyRefundOnce<T>(refundId: string, apply: (tx: Prisma.TransactionClient) => Promise<T & { storeId: string }>): Promise<T | null> {
  try {
    return await db.$transaction(async (tx) => {
      const result = await apply(tx);
      await tx.webhookEvent.create({ data: { id: `refund:${refundId}`, storeId: result.storeId, type: "refund", processedAt: new Date() } });
      return result;
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
    throw err;
  }
}

/** Reports refunds not yet on the Shopify order (see refunds.ts). Never throws. */
export function mirrorRefunds(sessionId: string, opts: { force?: boolean } = {}): Promise<number> {
  return mirrorRefund("session", sessionId, opts);
}

/**
 * The order's timeline shows why a buyer couldn't pay: a refusal (expired, empty cart,
 * invalid code…) at info level, an unexpected failure (Whop/Shopify down) as an error
 * with an alert (grouped per store every 15 min, so an outage pings once).
 */
export type CheckoutFailureSource = "whop" | "shopify";
const FAILURE_SOURCE = Symbol.for("whop-checkout.failureSource");

/** Marks the errors of a call with the provider they come from (kept when rethrown as is). */
export async function tagFailureSource<T>(p: Promise<T>, source: CheckoutFailureSource): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (err && typeof err === "object") (err as Record<symbol, unknown>)[FAILURE_SOURCE] = source;
    throw err;
  }
}

/**
 * Which side a checkout init failure comes from: Shopify (pricing, stock, the cart: ShopifyError or a
 * call tagged "shopify") or Whop (the checkout configuration — and anything unclassified, which keeps
 * the safe behaviour of sending buyers to Shopify's own checkout). Pure.
 */
export function checkoutFailureSource(err: unknown): CheckoutFailureSource {
  const tagged = err && typeof err === "object" ? (err as Record<symbol, unknown>)[FAILURE_SOURCE] : undefined;
  if (tagged === "whop" || tagged === "shopify") return tagged;
  return err instanceof ShopifyError ? "shopify" : "whop";
}

export async function journalCheckoutFailure(session: Pick<CheckoutSession, "id" | "storeId">, stage: "prepare" | "pay", err: unknown) {
  if (err instanceof CheckoutError) {
    await recordEvent({ storeId: session.storeId, sessionId: session.id, kind: "checkout.rejected", message: `Paiement bloqué (${err.code}) : ${err.message}`, data: { stage, code: err.code } });
    return;
  }
  // Shopify couldn't price the cart: its own incident (journal + alert, grouped), never counted towards
  // the automatic fallback — Shopify's own checkout wouldn't work better, and a Shopify hiccup must
  // not flip the storefront back and forth.
  if (checkoutFailureSource(err) === "shopify") {
    await recordIncident({
      storeId: session.storeId,
      sessionId: session.id,
      kind: "checkout.shopify_failed",
      message: `Le formulaire de paiement n'a pas pu s'ouvrir (${stage}) : Shopify n'a pas pu calculer le panier (${err instanceof Error ? err.message.slice(0, 200) : String(err)}). Le client peut réessayer.`,
      data: { stage, source: "shopify", err: err instanceof Error ? err.message : String(err) },
      err,
    });
    return;
  }
  // One row per session per 10 min (a buyer retrying during an outage); the failure still counts below.
  if (!(await rateLimit(`journal:init_failed:${session.id}`, 1, 10 * 60_000))) {
    await noteCheckoutFailure(session.storeId);
    return;
  }
  await recordEvent({
    storeId: session.storeId,
    sessionId: session.id,
    level: "error",
    kind: "checkout.init_failed",
    message: `Le formulaire de paiement n'a pas pu s'ouvrir (${stage}) : ${err instanceof Error ? err.message : String(err)}`,
    data: { stage, source: "whop", err: err instanceof Error ? err.message : String(err) },
    alert: true,
    // The Error itself (stack, type) goes to Sentry; the journal keeps its message only (data above).
    err,
  });
  await noteCheckoutFailure(session.storeId);
}

export async function recordDispute(sessionId: string, disputeId: string | null, dueAt: Date | null = null) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session) return;
  // Atomic "first time": concurrent deliveries can't alert twice.
  const first = await db.checkoutSession.updateMany({ where: { id: sessionId, disputed: false }, data: { disputed: true, disputeOpenedAt: new Date() } });
  if (first.count) {
    if (session.shopifyOrderId) {
      const orderId = session.shopifyOrderId;
      // Backstopped by the tick (disputeTaggedAt stays null until Shopify confirms).
      const tag = () =>
        tagOrder(session.store, orderId, ["litige-whop"])
          .then(() => db.checkoutSession.update({ where: { id: sessionId }, data: { disputeTaggedAt: new Date() } }))
          .catch((err) => log.warn("dispute.tag_failed", "Could not tag the disputed Shopify order (the tick retries)", { sessionId, err }));
      if (!defer("dispute.tag", tag)) await tag();
    } else if (session.syncHandledAt && !session.syncSkippedReason) {
      await recordEvent({
        storeId: session.storeId,
        sessionId,
        level: "warn",
        kind: "dispute.manual_order",
        message: `Litige sur ${session.shopifyOrderName ?? "une commande créée à la main"} (commande liée à la main) : ajoutez le tag « litige-whop » dans Shopify et fournissez le numéro de suivi à la main dans Whop (aucun envoi automatique).`,
        data: { disputeId },
        alert: true,
      });
    }
    await recordEvent({
      storeId: session.storeId,
      sessionId,
      level: "warn",
      kind: "dispute.created",
      message: `Litige ouvert sur ${session.shopifyOrderName ?? "une commande"} (${session.totalCents / 100} ${session.currency})${
        dueAt ? `, réponse attendue avant le ${dueAt.toISOString().slice(0, 10)}` : ""
      }`,
      data: { disputeId },
      alert: true,
    });
  }
  if (!disputeId) return;
  const set = await db.checkoutSession.updateMany({ where: { id: sessionId, disputeId: null }, data: { disputeId, disputeDueAt: dueAt } });
  if (!set.count && session.disputeId !== disputeId) {
    // A second dispute on the same payment: the automatic evidence covers the first one only.
    await recordEvent({ storeId: session.storeId, sessionId, level: "error", kind: "dispute.second", message: `Deuxième litige (${disputeId}) sur cette commande : répondez-y dans Whop.`, alert: true });
    return;
  }
  // Submit now if the parcel is already tracked; otherwise the tick waits for tracking (never past the due date).
  if (set.count && session.store.autoDisputeEvidence && session.trackingNumber && !session.disputeEvidenceAt) {
    const evidence = async () => submitDisputeEvidence(await db.checkoutSession.findUniqueOrThrow({ where: { id: sessionId }, include: { store: true } }), disputeId);
    if (!defer("dispute.evidence", evidence)) await evidence();
  }
}

/** "12,50 €" for journal messages. */
export function formatAmount(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${cents / 100} ${currency}`;
  }
}
