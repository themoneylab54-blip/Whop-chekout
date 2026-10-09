import "server-only";
import { createHash } from "node:crypto";
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
import { createPaidOrder, disputeTag, findOrderByPayment, findOrderForSession, priceCart, ShopifyError, tagOrder, type Address, type OrderCustomer } from "./shopify";
import { log, recordEvent } from "./log";
import { mirrorRefund } from "./refunds";
import { defer } from "./deferred";
import { noteCheckoutFailure } from "./fallback";
import { rateLimit } from "./ratelimit";
import { pickupPointSchema, type PickupPoint } from "./pickup";
import { sendPurchaseConversions } from "./conversions";
import { applyAppCosts } from "./costs";
import { submitDisputeEvidence } from "./disputes";
import { createCheckoutConfiguration, MethodUnavailableError, storeClient } from "./whop";
import { designFor } from "./experiments";
import { loadCheckoutLayout, loadInterception, loadThankYouLayout, loadTheme, paypalExpressAllowed, upsellSellable } from "./layout";
import { chooseProvider, PROVIDER_NAMES, providerOrder, type PaymentProvider } from "./payment-provider";
import {
  cancelOpenPaymentIntents,
  createOrUpdatePaymentIntent,
  ensureStripeCustomer,
  fingerprintTag,
  isStripeMissing,
  isStripeRejection,
  paymentInfoFromStripe,
  retrievePaymentIntent,
  STRIPE_CLEANUP_CALL,
  STRIPE_PAGE_CALL,
  stripeFor,
  stripeShipping,
  type CheckoutPaymentIntent,
} from "./stripe";
import { afterResponse } from "./route";
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
  /** Stripe: the PaymentIntent the page's Payment Element is about to confirm. */
  paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9]+$/).max(100).nullable().optional(),
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
  /** Some lines of a cart charged as Shopify charges it are at the variant's price, not the cart's lower one. */
  cartPricesAdjusted?: boolean;
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
const NOT_COMBINABLE = "Ce code ne se cumule pas avec les remises déjà appliquées : la remise la plus avantageuse est conservée";

/** A code looked up for this cart: the discount it gives, or why it doesn't apply. */
type CodeTry =
  | { ok: true; discount: DiscountInput; source: "app" | "shopify"; shopifyCode: ShopifyCodeDiscount | null }
  | { ok: false; error: string; errorCode: string };

export async function quoteSession(session: SessionWithStore, input: QuoteInput): Promise<Quote> {
  // The code the buyer typed, or — none typed (null; "" = removed) — the Shopify cart's own codes (a
  // /discount/CODE link, Fast Bundle's code), in the cart's order, 3 at most: each looked up like a
  // typed code, the first that applies kept. The others are left out without a field error
  // (journaled, and said: cartCodeLost).
  const context = session.cartContext as CartContext | null;
  const fromCart = input.discountCode == null;
  const candidates = input.discountCode ? [input.discountCode] : fromCart ? (context?.discountCodes ?? []).slice(0, 3) : [];
  // The store's settings are read while the lines are (re)priced: none of them depends on the lines.
  const loads = Promise.all([
    db.shippingRate.findMany({ where: { storeId: session.storeId }, orderBy: { position: "asc" } }),
    db.addOn.findMany({ where: { storeId: session.storeId, active: true } }),
    candidates.length
      ? db.discountCode.findMany({
          where: { storeId: session.storeId, OR: candidates.map((code) => ({ code: { equals: code, mode: "insensitive" as const } })) },
        })
      : [],
    designFor(session.store, session),
    // Checkout A/B tests: arm B's tiers, order-bump prices / visibility, protection pricing.
    overridesFor(session),
  ]);
  // Handled at once: a read failing while the lines are still priced is no unhandled rejection
  // (still thrown by the await below; a failing line re-pricing wins, its error is the quote's).
  loads.catch(() => undefined);
  const buyerLines = await linesFor(session, session.status === "PAID" ? undefined : input.quantities);
  const [allRates, storeAddOns, discountRows, design, overrides] = await loads;
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
  const same = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();
  const cartsOwn = (code: string) => (context?.discountCodes ?? []).some((c) => same(c, code));
  const takenOff = context?.cartPriced?.codesTakenOff;
  const codeCheck = context?.codeCheck;
  // A cart code that lowered the cart (verified when the checkout opened, or taken off in a cart charged
  // as Shopify charges it): never dropped silently, nor while Shopify can't be asked about it.
  const required = (code: string) => (!!codeCheck && same(codeCheck.code, code)) || !!takenOff?.some((c) => same(c, code));

  // One message for unknown, inactive, expired or used-up codes: don't help guess private codes.
  const invalid = "Code promo invalide ou expiré";
  const tryCode = async (code: string, retry: boolean): Promise<CodeTry> => {
    const row = discountRows.find((r) => same(r.code, code));
    if (!row && session.store.shopifyDiscountCodes && session.store.shopifyAccessToken && canReadShopifyDiscounts(session.store)) {
      // Not one of the app's codes: a code created in Shopify (amount off / free shipping).
      const found = retry ? await lookupShopifyCodeWithRetry(session.store, code) : await lookupShopifyCode(session.store, code);
      // Shopify couldn't be asked: not an invalid code, the buyer can retry.
      if (found === "unavailable") return { ok: false, error: "Impossible de vérifier ce code pour le moment, réessayez.", errorCode: "discount_unavailable" };
      if (typeof found === "string") return { ok: false, error: invalid, errorCode: "discount_invalid" };
      const collections = needsCollections(found)
        ? await productCollections(session.store, buyerLines.map((l) => l.productId)).catch(() => new Map<string, string[]>())
        : new Map<string, string[]>();
      // A limited code: this app's own paid uses count on top of Shopify's (see shopifyCodeUses).
      const [ledgerUses, recentLedgerUses] =
        found.usageLimit != null
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
      if (applied.ok) return { ok: true, discount: applied.discount, source: "shopify", shopifyCode: found };
      if (applied.reason === "exhausted") return { ok: false, error: DISCOUNT_EXHAUSTED, errorCode: "discount_exhausted" };
      return applied.reason === "minimum"
        ? { ok: false, error: "Le montant minimum pour ce code n'est pas atteint", errorCode: "discount_minimum" }
        : { ok: false, error: invalid, errorCode: "discount_invalid" };
    }
    if (!row) return { ok: false, error: invalid, errorCode: "discount_invalid" };
    const check = checkDiscount(row, subtotal(buyerLines));
    if (check.ok) return { ok: true, discount: row, source: "app", shopifyCode: null };
    return check.reason.includes("minimum") ? { ok: false, error: check.reason, errorCode: "discount_minimum" } : { ok: false, error: invalid, errorCode: "discount_invalid" };
  };
  // A cart charged as Shopify charges it: one of its own codes (validated: limits, uses) takes off
  // exactly what it took off in Shopify's cart (codeCents, at each line's rate), where Shopify combined
  // it with the discounts now in the prices — an amount-off code never more than its own amount (a line
  // raised to the variant's price scales a percentage, not a fixed amount); one that took nothing there
  // (not combinable, its minimum…) takes nothing here either (null). A free-shipping code keeps its own rule.
  const asCartPriced = (d: DiscountInput): DiscountInput | null => {
    if (!context?.cartPriced || d.type === "FREE_SHIPPING" || !cartsOwn(d.code)) return d;
    const amounts = context.cartPriced.codeCents;
    const cents = amounts?.[d.code.toUpperCase()];
    if (cents && cents > 0) return { ...d, type: "FIXED", value: d.type === "FIXED" ? Math.min(cents, d.value) : cents, scopeShare: undefined, eligibleVariantIds: undefined };
    // Money off there without amounts kept (a checkout opened before they were): its own computation.
    return !amounts && takenOff?.some((c) => same(c, d.code)) ? d : null;
  };

  // The cart's codes not applied here, and why (one is said: cartCodeLost); the cart's code applied;
  // the one payment waits for (Shopify couldn't be asked about it).
  const notApplied: { code: string; reason: string }[] = [];
  let appliedCartCode: string | null = null;
  let waitFor: string | null = null;
  if (input.discountCode && context?.cartPriced?.discounted && !cartsOwn(input.discountCode)) {
    // A cart charged as Shopify's cart charged it, its automatic discounts already in the prices: only
    // the cart's own codes on top (Shopify combined them with those discounts); another code can't be
    // checked against what the cart applied.
    discountError = "Les remises de votre panier sont déjà appliquées : un autre code ne peut pas s'y ajouter.";
    discountErrorCode = "discount_cart_priced";
  } else if (candidates.length) {
    // Looked up together (no added wait). The Shopify cart's first code, and any that lowered the cart,
    // are asked twice when Shopify doesn't answer (never silently dropped).
    const tries = await Promise.all(candidates.map((code, k) => tryCode(code, fromCart && (k === 0 || required(code)))));
    for (const [k, code] of candidates.entries()) {
      const tried = tries[k];
      const kept = tried.ok ? asCartPriced(tried.discount) : null;
      if (!fromCart) {
        // The typed code: applied, or the field's error (one the cart's own prices took nothing for: not combinable).
        if (tried.ok && kept) {
          discount = kept;
          discountSource = tried.source;
          shopifyCode = tried.shopifyCode;
        } else {
          discountError = tried.ok ? NOT_COMBINABLE : tried.error;
          discountErrorCode = tried.ok ? "discount_not_combinable" : tried.errorCode;
        }
      } else if (tried.ok && kept && !discount && !waitFor) {
        discount = kept;
        discountSource = tried.source;
        shopifyCode = tried.shopifyCode;
        appliedCartCode = code;
      } else if (!tried.ok || kept) {
        // Invalid here, or valid too while one code applies here.
        notApplied.push({ code, reason: tried.ok ? "discount_not_combinable" : tried.errorCode });
        // Shopify can't be asked about a code that lowered the cart, ahead of any that applies: no later
        // code meanwhile, payment waits for it (cartCodeLost).
        if (!tried.ok && tried.errorCode === "discount_unavailable" && required(code) && !discount && !waitFor) waitFor = code;
      }
      // Valid, but it took nothing in Shopify's cart (its own prices): nothing lost, nothing said.
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
    discountError = NOT_COMBINABLE;
    discountErrorCode = "discount_not_combinable";
  }
  if (totals.dropped?.includes("automatic")) automatic = { cents: 0, titles: [] };
  // The cart's own codes that don't apply here: left out of the code field (the buyer never typed
  // them), journaled, and one said (cartCodeLost), a code that lowered the cart first. Payment is
  // blocked when these very lines would cost more than the cart showed with its verified code
  // (codeCheck), or while Shopify can't be asked about a code that lowered it: never charged more.
  let cartCodeLost: Quote["cartCodeLost"];
  if (fromCart && candidates.length) {
    // The cart's code applied above, then left out with the totals (it doesn't combine here).
    if (appliedCartCode && !discount) notApplied.unshift({ code: appliedCartCode, reason: discountErrorCode ?? "discount_not_combinable" });
    discountError = null;
    discountErrorCode = null;
    // Codes that lowered Shopify's cart beyond the 3 looked up: one code applies here.
    for (const c of takenOff ?? []) if (!candidates.some((x) => same(x, c))) notApplied.push({ code: c, reason: "discount_not_combinable" });
    const overCart = !!codeCheck && sameCodeCart(codeCheck.items, buyerLines) && totals.subtotalCents - totals.discountCents > codeCheck.totalCents;
    const checkedLost = codeCheck ? notApplied.find((n) => same(n.code, codeCheck.code)) : undefined;
    const lost = notApplied.find((n) => required(n.code)) ?? notApplied[0];
    if (waitFor) cartCodeLost = { code: waitFor, reason: "discount_unavailable", blocking: true };
    else if (overCart) cartCodeLost = { code: checkedLost?.code ?? codeCheck!.code, reason: checkedLost?.reason ?? "discount_amount", blocking: true };
    else if (lost) cartCodeLost = { code: lost.code, reason: lost.reason, blocking: false };
    if (cartCodeLost) await noteCartCodeDropped(session, cartCodeLost.code, cartCodeLost.reason);
  }
  // The Shopify cart's automatic discount stopped applying because the buyer changed the lines.
  const cartAutomatic = session.cartDiscounts as { totalCents?: unknown; titles?: unknown } | null;
  const automaticLost =
    !!cartAutomatic && Number(cartAutomatic.totalCents) > 0 && !totals.dropped?.includes("automatic") && automatic.cents === 0
      ? (Array.isArray(cartAutomatic.titles) ? cartAutomatic.titles.map(String).slice(0, 5) : [])
      : null;
  // A cart fixed as a whole (an app's lines, the Shopify cart's prices) can't take more items: no
  // "add N more" nudge then (a tier still counts what it holds).
  const frozen = cartFrozen(buyerLines);
  const reached = quantityBreakForLines(tiers.breaks, offerBaseLines(buyerLines));
  const volumeBreak = frozen ? { ...reached, next: null, missing: null } : reached;
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
      next: progress.next && !frozen ? { title: giftTitle(progress.next.tier, session.lang), missingQty: progress.next.missingQty, missingCents: progress.next.missingCents } : null,
    },
    protection: protectionBlock ? { selected: protectionCents > 0, priceCents: offered?.protectionCents ?? 0 } : null,
    extraAddOns: protectionCents > 0 ? [{ id: PROTECTION_ADDON_ID, title: "Protection colis", priceCents: protectionCents, variantId: null, costCents: null }] : [],
    ...(frozen ? { cartLocked: true } : {}),
    ...(automaticLost ? { automaticDiscountLost: automaticLost } : {}),
    ...(cartCodeLost ? { cartCodeLost } : {}),
    ...(context?.cartPriced?.raised ? { cartPricesAdjusted: true } : {}),
  };
  // The Shopify code as read (limits, usage count): frozen on the snapshot, never sent to the browser.
  if (shopifyCode && discountSource === "shopify") shopifyCodeOf.set(quote, shopifyCode);
  // The design the quote was priced with: prepareSession reuses it (one read per prepare).
  designOf.set(quote, design);
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
    message:
      reason === "discount_not_combinable"
        ? `Code du panier Shopify « ${code.slice(0, 60)} » non repris au checkout : il ne se cumule pas avec la remise appliquée (un seul code par commande) ; l'acheteur en est informé.`
        : `Code du panier Shopify « ${code.slice(0, 60)} » non repris au checkout (${reason ?? "inapplicable"}) : vérifiez qu'il existe dans Shopify et que la lecture des codes Shopify est activée.`,
    data: { code: code.slice(0, 60), reason },
  });
}

/** Shopify code behind a quote (server side only: the quote itself goes to the browser). */
const shopifyCodeOf = new WeakMap<Quote, ShopifyCodeDiscount>();
/** The design (theme, layouts) a quote was computed with, kept off the Quote itself. */
const designOf = new WeakMap<Quote, Awaited<ReturnType<typeof designFor>>>();

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
 * The processor is part of it: a Stripe snapshot (its PaymentIntent) is never taken for a Whop one
 * and vice versa. Whop's fingerprints are unchanged; a PaymentIntent carries no return URL (the page
 * passes it when confirming), so a Stripe one has no host suffix nor PayPal-only variant.
 */
export function snapshotFingerprint(quote: Parameters<typeof quoteFingerprint>[0], method?: "paypal" | null, returnUrl?: string | null, provider: PaymentProvider = "whop"): string {
  if (provider === "stripe") return `${quoteFingerprint(quote)}|p:stripe`;
  return quoteFingerprint(quote) + (method === "paypal" ? "|m:paypal" : "") + returnHostSuffix(returnUrl);
}

/** Whether a snapshot fingerprint is a PayPal-only checkout's (segments: "…|m:paypal|h:host"). Pure. */
export function isPaypalFingerprint(fingerprint: string | null | undefined): boolean {
  return !!fingerprint && fingerprint.split("|").includes("m:paypal");
}

/**
 * Appended to the fingerprint of a Whop snapshot whose configuration was deleted (the session
 * switched to Stripe, see deleteSessionWhopCheckouts): no quote's fingerprint ends so, the snapshot
 * is never reused (prepare) nor confirmed ready (confirm). Keeps its other segments (PayPal).
 */
export const DELETED_SUFFIX = "|x:deleted";

/** Whether a snapshot fingerprint is a deleted Whop configuration's (see DELETED_SUFFIX). Pure. */
export function isDeletedFingerprint(fingerprint: string | null | undefined): boolean {
  return !!fingerprint && fingerprint.endsWith(DELETED_SUFFIX);
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
 *
 * The processor (see providerFor): Whop as always, or Stripe (a PaymentIntent per snapshot, see
 * prepareStripe). `opts.provider` forces one (the per-session switch after a failure); never another
 * processor than the session's under a payment in flight.
 */
export async function prepareSession(session: SessionWithStore, input: QuoteInput, opts: PrepareOptions = {}): Promise<PrepareResult> {
  // The request's start: the wait for another request's checkout is bounded from it (SNAPSHOT_WAIT_MS).
  const startedAt = opts.startedAt ?? Date.now();
  // Whop's last word on PayPal, read while the quote is computed when the charged currency is known
  // up front (the shop's; a store charging in the buyer's currency waits for the quote's).
  const shopPaypal = session.store.chargeLocalCurrency ? null : paypalOffered(session.storeId, session.currency);
  shopPaypal?.catch(() => undefined);
  const quote = await quoteSession(session, input);
  assertPayable(session, quote, input);
  const provider = providerFor(session, opts.provider);
  const method = input.method === "paypal" ? ("paypal" as const) : null;
  // The currency Whop charges (buyer's when the store charges in it): PayPal is remembered per currency.
  const chargeCurrency = quote.charge?.currency ?? session.currency;
  // The merchant's choice (builder > Paiement express): PayPal off, or the express section off or
  // hidden (where its button lives) = no PayPal-only checkout at all. The quote's own design (one read).
  const design = designOf.get(quote) ?? (await designFor(session.store, session));
  const paypalAllowed = paypalExpressAllowed(loadTheme(design.theme, session.store.name), loadCheckoutLayout(design.checkoutLayout));
  // Whop's word on PayPal, read once per prepare (again only when this prepare changed it, below).
  let paypalStored: Promise<boolean> | null = shopPaypal && chargeCurrency.toUpperCase() === session.currency.toUpperCase() ? shopPaypal : null;
  const paypalNow = () => (paypalStored ??= paypalOffered(session.storeId, chargeCurrency));
  // PayPal-only checkouts are Whop's (the express PayPal button): Stripe offers PayPal in its own form.
  if (method === "paypal" && (provider !== "whop" || !paypalAllowed || !(await paypalNow()))) {
    throw new CheckoutError("paypal_unavailable", "PayPal n'est pas disponible pour cette commande.");
  }
  // Anything failing on the Stripe path is Stripe's side (as anything unclassified is Whop's on its
  // path), except the database's own errors: never counted as a Stripe outage.
  if (provider === "stripe") return tagFailureSource(prepareStripe(session, quote, input, design), "stripe", isDbError);
  // Paid through the loader's APP_URL fallback: back to APP_URL (?via=app), not the unreachable domain.
  const redirectUrl = thankYouReturnUrl(session.store, session.id, opts.host);
  const fingerprint = snapshotFingerprint(quote, method, redirectUrl);

  // Switching back from Stripe: the session's Whop configurations were deleted at the switch to
  // Stripe (deleteSessionWhopCheckouts, maybe still running): never reused, a fresh one. Those
  // deleted are also marked (their fingerprint no longer matches any quote), so never found later.
  const findSnapshot = () =>
    session.paymentProvider === "stripe"
      ? Promise.resolve(null)
      : db.checkoutQuote.findFirst({
          where: { sessionId: session.id, fingerprint, whopCheckoutId: { not: null } },
          orderBy: { createdAt: "desc" },
        });
  let snapshot = await findSnapshot();
  let remembered: Promise<void> | null = null;
  if (!snapshot) {
    // Another request is creating this very checkout (the early prepare at the session's creation, a
    // second tab, a double load): its configuration is waited for and reused, never a second one.
    let claim = await claimSnapshot(session.id, fingerprint, startedAt);
    if (!claim.owned) {
      // Waits while the other request is alive (its claim kept fresh), up to SNAPSHOT_WAIT_MS from this
      // request's start (then a Whop failure: Stripe takes over when usable, else the page retries);
      // takes the creation over atomically only once that request is gone without a snapshot.
      const waited = await waitForSnapshot(claim.key, findSnapshot, startedAt);
      snapshot = waited.snapshot;
      if (waited.claim) claim = waited.claim;
      // The other request may have saved Whop's new word on PayPal meanwhile: read afresh.
      paypalStored = null;
    }
    // The claim kept fresh while Whop answers (however slow): a waiting request never mistakes this
    // one for a crashed one, so never creates a second configuration.
    const heartbeat = claim.held && !snapshot ? keepSnapshotClaim(claim.key) : null;
    try {
      if (!snapshot) {
        const base = await newSnapshotBase(session, quote, input);
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
        // Whether Whop offers PayPal, as this new checkout says (the express button follows it): saved
        // alongside the snapshot, and read again afterwards.
        if (typeof whop.paypal === "boolean") {
          remembered = rememberPaypal(session.storeId, chargeCurrency, whop.paypal);
          remembered.catch(() => undefined);
          paypalStored = null;
        }
        snapshot = await db.checkoutQuote.create({ data: { ...base, whopCheckoutId: whop.id, fingerprint, provider: "whop" } });
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      // Awaited (one quick delete): a waiting request sees the claim gone at once, and no claim row
      // outlives the request (stale ones are swept by the tick anyway).
      if (claim.held) await releaseSnapshotClaim(claim.key);
    }
  }
  if (!snapshot) throw new CheckoutError("init_failed", "Le paiement n'a pas pu être initialisé. Réessayez.");
  // A Whop snapshot always holds its configuration (only Stripe ones have none).
  const configId = snapshot.whopCheckoutId!;

  // Never over a payment that landed meanwhile (webhook during the Shopify/Whop round-trips).
  const [prepared] = await Promise.all([
    db.checkoutSession.updateMany({
      // An early prepare only fills a session nothing touched since it was read: once the page's own
      // prepare ran (preparedAt), or switched the processor / configuration, the page's wins.
      // Any prepare only writes over the processor it read: another tab that switched the session to
      // Stripe meanwhile is never overwritten blind (its PaymentIntent left open under a Whop checkout).
      where: opts.early
        ? { id: session.id, status: { not: "PAID" }, preparedAt: null, paymentProvider: session.paymentProvider, whopCheckoutId: session.whopCheckoutId }
        : { id: session.id, status: { not: "PAID" }, paymentProvider: session.paymentProvider },
      data: {
        ...quoteFields(quote),
        preparedTotalCents: quote.totals.totalCents,
        whopCheckoutId: configId,
        paymentProvider: "whop",
        // An early prepare (before the page loaded) readies the checkout without marking the form shown.
        ...(opts.early ? {} : { preparedAt: session.preparedAt ?? new Date() }),
      },
    }),
    remembered,
  ]);
  if (!prepared.count) {
    // The session changed under this prepare (paid, another tab's prepare or processor switch): read afresh.
    const fresh = await db.checkoutSession.findUnique({ where: { id: session.id }, include: { store: true } });
    // Now on Stripe: the Whop configuration just made (and any other of the session's) never stays
    // live next to its PaymentIntent: marked deleted and deleted (after the answer), as at a switch.
    if (fresh && fresh.status !== "PAID" && fresh.paymentProvider === "stripe") deleteSessionWhopCheckouts(fresh);
    // The early prepare steps aside quietly: the page prepared meanwhile (its Whop snapshot stays
    // reusable by fingerprint; the session keeps what the page set), or switched it to Stripe.
    if (opts.early) return { provider: "whop", checkoutConfigurationId: configId, totals: quote.totals, quote, paypal: paypalAllowed && (await paypalNow()) };
    if (!fresh || fresh.status === "PAID") throw new CheckoutError("already_paid", "Cette commande est déjà payée.");
    // The page's prepare: once more on the session as it is now (its processor: Stripe's form after
    // another tab's switch); changed again meanwhile → a retryable error (the page retries 5xx).
    if (opts.reread) throw new CheckoutError(SESSION_CHANGED, "La commande vient de changer dans un autre onglet. Réessayez.");
    return prepareSession(fresh, input, { ...opts, reread: true });
  }
  // Switched away from Stripe (per-session switch, Stripe disconnected): its PaymentIntents still
  // open are canceled (after the answer), so a stale tab can never pay on Stripe on top of this Whop checkout.
  if (session.paymentProvider === "stripe") cancelSessionPaymentIntents(session);
  return { provider: "whop", checkoutConfigurationId: configId, totals: quote.totals, quote, paypal: paypalAllowed && (await paypalNow()) };
}

/** A claim not refreshed for this long is a crashed request's: taken over. */
const SNAPSHOT_CLAIM_MS = 15_000;
/** How often the creating request refreshes its claim (well within SNAPSHOT_CLAIM_MS). */
const SNAPSHOT_HEARTBEAT_MS = 4_000;
/**
 * How long a request waits at most (measured from its start) for the checkout another live one is
 * creating. Past it, a Whop failure (whop_claim_timeout): the buyer switches to Stripe when usable,
 * well within the 60 s function, else the page retries (5xx) — never a second configuration.
 */
const SNAPSHOT_WAIT_MS = 22_000;
const SNAPSHOT_POLL_MS = 150;
/** The prepare/pay functions' budget (their maxDuration), from the request's start. */
const PREPARE_BUDGET_MS = 60_000;
/** A claim is taken over (Whop called by this request) only with at least this much of the budget left. */
const TAKEOVER_MIN_LEFT_MS = 25_000;
/** Claim rows (`prep:*`) older than this are swept by the tick (a crash between claim and release). */
export const SNAPSHOT_CLAIM_SWEEP_MS = 15 * 60 * 1000;

/** Test hooks: shorter claim timings (the slow-Whop tests). */
export const snapshotClaimTimings = {
  claimMs: SNAPSHOT_CLAIM_MS,
  heartbeatMs: SNAPSHOT_HEARTBEAT_MS,
  waitMs: SNAPSHOT_WAIT_MS,
  pollMs: SNAPSHOT_POLL_MS,
  budgetMs: PREPARE_BUDGET_MS,
  takeoverMinLeftMs: TAKEOVER_MIN_LEFT_MS,
};

/** Whether enough of the request's budget is left to take a claim over (and call Whop itself). */
function takeoverAllowed(startedAt: number): boolean {
  return startedAt + snapshotClaimTimings.budgetMs - Date.now() >= snapshotClaimTimings.takeoverMinLeftMs;
}

/** The wait for another request's checkout ran out: Whop's failure (the per-session switch, the store's failover count). */
function claimTimeout(): Error {
  return withFailureSource(new Error("whop_claim_timeout"), "whop");
}

type SnapshotClaim = { key: string; owned: boolean; held: boolean };

function snapshotClaimKey(sessionId: string, fingerprint: string): string {
  return `prep:${sessionId}:${createHash("sha256").update(fingerprint).digest("base64url").slice(0, 22)}`;
}

/**
 * Claims the creation of a session's checkout for one fingerprint (a row of AppSetting, shared by
 * every server instance): `owned` when this request creates it, else another one is on it; `held`
 * when the claim row is this request's (released after). A claim row is taken over atomically only
 * when stale (its request stopped refreshing it). A database failure never blocks the checkout
 * (owned, not held: the request goes on as without the claim).
 */
async function claimSnapshot(sessionId: string, fingerprint: string, startedAt: number): Promise<SnapshotClaim> {
  return tryClaim(snapshotClaimKey(sessionId, fingerprint), { takeover: takeoverAllowed(startedAt) });
}

/**
 * The claim itself, entirely through Prisma: every timestamp of the claim rows (written here, by the
 * heartbeat, compared here and in waitForSnapshot) goes through the same Prisma mapping of the
 * `timestamp` column (UTC), whatever the database session's time zone. A fresh row inserted
 * (createMany skipDuplicates: one insert wins), else a stale one taken over (a single conditional
 * UPDATE: Postgres re-checks `updatedAt < stale` on the locked row, so one taker wins) unless
 * `takeover` is false. Exported for the tests.
 */
export async function tryClaim(key: string, opts: { takeover?: boolean } = {}): Promise<SnapshotClaim> {
  try {
    const now = new Date();
    const inserted = await db.appSetting.createMany({ data: [{ key, value: "claimed", updatedAt: now }], skipDuplicates: true });
    if (inserted.count > 0) return { key, owned: true, held: true };
    if (opts.takeover === false) return { key, owned: false, held: false };
    const stale = new Date(now.getTime() - snapshotClaimTimings.claimMs);
    const taken = await db.appSetting.updateMany({ where: { key, updatedAt: { lt: stale } }, data: { value: "claimed", updatedAt: now } });
    return { key, owned: taken.count > 0, held: taken.count > 0 };
  } catch (err) {
    log.warn("checkout.prepare_claim_failed", "Could not claim the checkout's creation", { key, err });
    return { key, owned: true, held: false };
  }
}

/** Refreshes the claim while this request waits on Whop (best effort; cleared in the finally). */
function keepSnapshotClaim(key: string): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void db.appSetting.updateMany({ where: { key }, data: { updatedAt: new Date() } }).catch(() => undefined);
  }, snapshotClaimTimings.heartbeatMs);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** The claim dropped. Best effort (never fails the prepare). */
async function releaseSnapshotClaim(key: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { key } }).catch(() => undefined);
}

/** Drops claim rows left by crashed requests (tick maintenance). Returns how many. */
export async function sweepSnapshotClaims(now = new Date()): Promise<number> {
  const before = new Date(now.getTime() - SNAPSHOT_CLAIM_SWEEP_MS);
  return (await db.appSetting.deleteMany({ where: { key: { startsWith: "prep:" }, updatedAt: { lt: before } } })).count;
}

/**
 * Waits for the snapshot another request is creating: found → reused. Its claim gone without a
 * snapshot (that request failed) or stale (crashed) → taken over atomically (`claim`: this request
 * now creates it; another waiter that won the takeover is waited for in turn), only while enough of
 * the request's budget is left (TAKEOVER_MIN_LEFT_MS). Still nothing SNAPSHOT_WAIT_MS after the
 * request's start, or too late to take over → whop_claim_timeout, a Whop failure (prepareWithFailover
 * switches the buyer to Stripe when usable, else the page retries; never a second configuration).
 */
async function waitForSnapshot(key: string, find: () => Promise<CheckoutQuote | null>, startedAt: number): Promise<{ snapshot: CheckoutQuote | null; claim?: SnapshotClaim }> {
  const { waitMs, pollMs, claimMs } = snapshotClaimTimings;
  const until = startedAt + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(pollMs, until - Date.now()))));
    const [found, row] = await Promise.all([find(), db.appSetting.findUnique({ where: { key }, select: { updatedAt: true } }).catch(() => undefined)]);
    if (found) return { snapshot: found };
    // Gone, stale or unreadable: try to take over (atomic: only one waiter wins).
    if (row === undefined || !row || Date.now() - row.updatedAt.getTime() > claimMs) {
      const again = await find();
      if (again) return { snapshot: again };
      if (!takeoverAllowed(startedAt)) throw claimTimeout();
      const claim = await tryClaim(key);
      if (claim.owned) return { snapshot: null, claim };
    }
  }
  const last = await find();
  if (last) return { snapshot: last };
  throw claimTimeout();
}

export type PrepareOptions = {
  host?: string | null;
  /** Prepared ahead of the page (at the session's creation): the session isn't marked prepared (preparedAt). */
  early?: boolean;
  /** Forces the processor (per-session switch after a failure); see providerFor. */
  provider?: PaymentProvider | null;
  /** When the request started (ms epoch; default: the prepare's own start): bounds the wait for another request's checkout. */
  startedAt?: number;
  /** Internal: already re-run once on a fresh read of the session (it changed under the first run). */
  reread?: boolean;
};

/** Code of the error a prepare throws when the session keeps changing under it (another tab): retryable (5xx). */
export const SESSION_CHANGED = "session_changed";

/**
 * The wait for another request's Whop checkout ran out (whop_claim_timeout) and no switch to Stripe
 * applied: Whop is unavailable for now. Answered apart (503 whop_unavailable): the page stops its
 * silent retries (each would wait as long again) and offers « réessayer ». Pure.
 */
export function isWhopUnavailable(err: unknown): boolean {
  return err instanceof Error && !(err instanceof CheckoutError) && err.message === "whop_claim_timeout" && checkoutFailureSource(err) === "whop";
}

/** The prepare/pay routes' answer to an error other than a refusal (CheckoutError): its status and body. */
export function failureResponse(err: unknown, fallback: string): { status: number; body: { error: string; code: string } } {
  if (isWhopUnavailable(err)) return { status: 503, body: { error: "Le paiement est momentanément indisponible. Réessayez dans un instant.", code: "whop_unavailable" } };
  if (err instanceof CheckoutError && err.code === SESSION_CHANGED) return { status: 503, body: { error: err.message, code: err.code } };
  if (err instanceof CheckoutError) return { status: 400, body: { error: err.message, code: err.code } };
  return { status: 502, body: { error: fallback, code: "init_failed" } };
}

/** What the page needs to mount Stripe's Payment Element on the connected account. */
export type StripeClientConfig = {
  clientSecret: string;
  paymentIntentId: string;
  publishableKey: string;
  stripeAccount: string;
  /** The PaymentIntent's own amount (Stripe's smallest unit) and currency: the page refreshes its wallets when they change. */
  amount?: number;
  currency?: string;
};

export type PrepareResult =
  | { provider: "whop"; checkoutConfigurationId: string; totals: Totals; quote: Quote; paypal: boolean; stripe?: undefined }
  | { provider: "stripe"; checkoutConfigurationId?: undefined; totals: Totals; quote: Quote; paypal: false; stripe: StripeClientConfig };

/**
 * The processor a prepare (or confirm) of this session uses:
 * - `requested` (per-session switch) or the session's forcedProvider (admin « Tester le secours »
 *   session): that one, or an error when it isn't usable (never the other one silently);
 * - a session already prepared keeps its processor while it stays usable ("sessions on Stripe finish
 *   on Stripe": a store-level failover or recovery never swaps the form under a buyer);
 * - otherwise the store's choice (chooseProvider: mode, failover, connections).
 * Never another processor than the one of a payment still in flight (payment_in_flight). No processor
 * usable: an error attributed to the mode's primary (counts towards Shopify's own checkout).
 */
export function providerFor(session: SessionWithStore, requested?: PaymentProvider | null): PaymentProvider {
  const forced = requested ?? session.forcedProvider;
  let provider: PaymentProvider | null = null;
  if (forced) {
    provider = chooseProvider(session.store, { forced })?.provider ?? null;
    if (!provider) throw withFailureSource(new Error(`${PROVIDER_NAMES[forced]} n'est pas disponible pour cette boutique`), forced);
  } else {
    if (session.preparedAt) provider = chooseProvider(session.store, { forced: session.paymentProvider })?.provider ?? null;
    provider ??= chooseProvider(session.store)?.provider ?? null;
    if (!provider) throw withFailureSource(new Error("Aucun processeur de paiement connecté (Whop ou Stripe)"), providerOrder(session.store.paymentMode)[0]);
  }
  if (provider !== session.paymentProvider && inFlightMethod(session) !== null) {
    throw new CheckoutError("payment_in_flight", "Un paiement est déjà en cours de validation, patientez quelques secondes.");
  }
  return provider;
}

/** Whether the thank-you page offers a one-click offer (the card is then saved for it). */
function offersOneClick(design: { thankYouLayout: unknown }): boolean {
  return loadThankYouLayout(design.thankYouLayout).blocks.some((b) => b.type === "upsell" && !b.hidden && upsellSellable(b.props as Parameters<typeof upsellSellable>[0]));
}

/**
 * Everything a new snapshot freezes (processor-independent): what is charged and shipped. Checks the
 * per-session cap first, and journals a local-currency fallback.
 */
async function newSnapshotBase(session: SessionWithStore, quote: Quote, input: QuoteInput) {
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
  const [count, rate, addOns] = await Promise.all([
    db.checkoutQuote.count({ where: { sessionId: session.id } }),
    quote.shippingRateId ? db.shippingRate.findUnique({ where: { id: quote.shippingRateId } }) : null,
    db.addOn.findMany({ where: { id: { in: quote.addOnIds } } }),
  ]);
  if (count >= MAX_QUOTES_PER_SESSION) {
    throw new CheckoutError("too_many_changes", "Trop de modifications sur cette commande. Retournez au panier pour recommencer.");
  }
  return {
    sessionId: session.id,
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
  } satisfies Omit<Prisma.CheckoutQuoteUncheckedCreateInput, "fingerprint">;
}

/** The PaymentIntent target of a quote: the charged amount and currency (buyer's when the store charges in it). */
function stripeTarget(session: SessionWithStore, quote: Quote, fingerprint: string) {
  return { fingerprint, amountCents: quote.charge?.totalCents ?? quote.totals.totalCents, currency: quote.charge?.currency ?? session.currency };
}

/**
 * Ties a PaymentIntent to its snapshot: the one it now charges (a PaymentIntent updated in place
 * moves from the previous snapshot to this one: CheckoutQuote.stripePaymentIntentId is unique), the
 * snapshot created when new. Returns the snapshot.
 *
 * Two requests of the same session racing (two tabs, a double prepare) get the same PaymentIntent
 * (idempotent creation) and may both write it: the loser's unique violation (P2002 on
 * stripePaymentIntentId) is resolved by running the move once more, then by re-reading the snapshot
 * that now holds it. Never an outage: an unresolved conflict is a refusal (CheckoutError), which
 * neither switches processor nor counts towards the failover.
 */
export async function attachPaymentIntent(sessionId: string, snapshot: CheckoutQuote | null, create: (() => Prisma.CheckoutQuoteUncheckedCreateInput) | null, piId: string): Promise<CheckoutQuote> {
  if (snapshot?.stripePaymentIntentId === piId) return snapshot;
  const move = () =>
    db.$transaction(async (tx) => {
      await tx.checkoutQuote.updateMany({ where: { stripePaymentIntentId: piId, sessionId, ...(snapshot ? { id: { not: snapshot.id } } : {}) }, data: { stripePaymentIntentId: null } });
      if (snapshot) return tx.checkoutQuote.update({ where: { id: snapshot.id }, data: { stripePaymentIntentId: piId } });
      return tx.checkoutQuote.create({ data: { ...create!(), stripePaymentIntentId: piId } });
    });
  const conflict = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
  try {
    return await move();
  } catch (err) {
    if (!conflict(err)) throw err;
  }
  // The other request committed meanwhile: its row already holds this PaymentIntent for this session.
  const held = await db.checkoutQuote.findUnique({ where: { stripePaymentIntentId: piId } });
  const wanted = snapshot?.fingerprint ?? create?.().fingerprint;
  if (held && held.sessionId === sessionId && held.fingerprint === wanted) return held;
  try {
    return await move();
  } catch (err) {
    if (!conflict(err)) throw err;
    const again = await db.checkoutQuote.findUnique({ where: { stripePaymentIntentId: piId } });
    if (again && again.sessionId === sessionId) return again;
    throw new CheckoutError("init_failed", "Le paiement n'a pas pu être initialisé. Réessayez.");
  }
}

/** The page's Stripe configuration for a PaymentIntent (publishable key of the store's mode, connected account, the PaymentIntent's own amount and currency). */
export function stripeClientConfig(session: SessionWithStore, pi: Pick<CheckoutPaymentIntent, "id" | "clientSecret"> & Partial<Pick<CheckoutPaymentIntent, "amount" | "currency">>): StripeClientConfig {
  const { publishableKey, stripeAccount } = stripeFor(session.store);
  return {
    clientSecret: pi.clientSecret,
    paymentIntentId: pi.id,
    publishableKey,
    stripeAccount,
    ...(pi.amount != null && pi.currency ? { amount: pi.amount, currency: pi.currency } : {}),
  };
}

/**
 * Whether the Stripe ids the session recorded (PaymentIntent, Customer, and its snapshots'
 * PaymentIntents) belong to another connected account or mode than the store's now (Stripe
 * reconnected to another account, test ↔ live switch): they are then ignored (never retrieved,
 * updated nor canceled with this account's keys: "no such PaymentIntent" would read as a Stripe
 * failure), and the next Stripe prepare starts afresh. A session without a recorded account (none
 * prepared on Stripe since 0037) is judged by its mode only. Pure.
 */
export function stripeIdsStale(session: Pick<CheckoutSession, "stripeAccountId" | "test"> & { store: Pick<Store, "stripeAccountId" | "testMode"> }): boolean {
  return (!!session.stripeAccountId && session.stripeAccountId !== session.store.stripeAccountId) || session.test !== session.store.testMode;
}

/** Budget of a cleanup call on Whop, after the answer: short, no retry. */
const WHOP_CLEANUP_CALL = { timeoutInSeconds: 3, maxRetries: 0 } as const;

/**
 * The session's Stripe PaymentIntents still open (current and previous ones recorded on its
 * snapshots) canceled, best effort, AFTER the answer (never in the buyer's request: Stripe may be the
 * processor that just failed), each call short and never retried: the buyer now pays with Whop.
 * Skipped when those ids belong to another account or mode (stripeIdsStale).
 */
function cancelSessionPaymentIntents(session: SessionWithStore): void {
  if (stripeIdsStale(session)) return;
  afterResponse(async () => {
    try {
      const quotes = await db.checkoutQuote.findMany({ where: { sessionId: session.id, stripePaymentIntentId: { not: null } }, select: { stripePaymentIntentId: true } });
      await cancelOpenPaymentIntents(session.store, [session.stripePaymentIntentId, ...quotes.map((q) => q.stripePaymentIntentId)], STRIPE_CLEANUP_CALL);
    } catch (err) {
      log.warn("checkout.pi_cancel_failed", "Could not cancel the session's Stripe PaymentIntents after a switch to Whop", { sessionId: session.id, err });
    }
  });
}

/**
 * The session's Whop checkout configurations deleted, best effort, AFTER the answer (never in the
 * buyer's request: Whop may be the processor that just failed), one short call each, no retry: the
 * buyer now pays with Stripe, and a stale tab (or Whop's own express buttons still on it) can never
 * pay on Whop on top. A configuration already gone counts as deleted.
 *
 * Their snapshots are marked deleted first (DELETED_SUFFIX on the fingerprint: no quote matches it
 * any more, so neither a prepare nor a confirm ever reuses them; whopCheckoutId stays, a late payment
 * webhook still finds its snapshot). Only those that existed at the switch (a Whop configuration
 * created afterwards, the buyer switched back meanwhile, is never touched).
 */
function deleteSessionWhopCheckouts(session: SessionWithStore): void {
  if (!session.store.whopApiKey) return;
  const switchedAt = new Date();
  afterResponse(async () => {
    let ids: string[] = [];
    try {
      const quotes = await db.checkoutQuote.findMany({
        where: { sessionId: session.id, provider: "whop", whopCheckoutId: { not: null }, createdAt: { lte: switchedAt } },
        select: { id: true, whopCheckoutId: true, fingerprint: true },
      });
      await Promise.all(
        quotes
          .filter((q) => !isDeletedFingerprint(q.fingerprint))
          .map((q) => db.checkoutQuote.updateMany({ where: { id: q.id, fingerprint: q.fingerprint }, data: { fingerprint: `${q.fingerprint}${DELETED_SUFFIX}` } })),
      );
      ids = [...new Set([session.whopCheckoutId, ...quotes.map((q) => q.whopCheckoutId)].filter((id): id is string => !!id))];
    } catch (err) {
      log.warn("checkout.whop_delete_failed", "Could not list the session's Whop checkouts after a switch to Stripe", { sessionId: session.id, err });
      return;
    }
    await Promise.all(
      ids.map(async (id) => {
        try {
          await storeClient(session.store).checkoutConfigurations.delete({ id }, WHOP_CLEANUP_CALL);
        } catch (err) {
          const status = (err as { status?: unknown; statusCode?: unknown }).status ?? (err as { statusCode?: unknown }).statusCode;
          // Already gone: deleted.
          if (status !== 404) log.warn("checkout.whop_delete_failed", "Could not delete a Whop checkout after the session switched to Stripe", { sessionId: session.id, checkoutConfigurationId: id, err });
        }
      }),
    );
  });
}

/**
 * A PaymentIntent of the session met succeeded by a prepare or a confirm (the webhook late or lost):
 * the session is marked paid from it (markPaid, idempotent, like the webhook and the status route),
 * then the page is told (already_paid: the thank-you page). Should that fail (Stripe, the database),
 * the buyer waits instead (payment_in_flight: the webhook finishes it), never a new form over a
 * payment made. Always throws a CheckoutError (a refusal: never a switch of processor).
 */
async function settlePaidPaymentIntent(session: SessionWithStore, paymentIntentId: string): Promise<never> {
  let paid = false;
  try {
    const pi = await retrievePaymentIntent(session.store, paymentIntentId);
    if (pi.status === "succeeded" && pi.metadata?.checkout_session_id === session.id) {
      const syncLater = await markPaid(session.id, paymentInfoFromStripe(pi), { deferSync: true });
      if (syncLater) afterResponse(() => syncOrderSafely(session.id));
      paid = true;
    }
  } catch (err) {
    log.warn("checkout.pi_settle_failed", "Could not mark the session paid from its succeeded PaymentIntent", { sessionId: session.id, paymentIntentId, err });
  }
  if (paid) throw new CheckoutError("already_paid", "Cette commande est déjà payée.");
  throw new CheckoutError("payment_in_flight", "Un paiement est déjà en cours de validation, patientez quelques secondes.");
}

/** A PaymentIntent paid or with a payment going through: settled (already_paid) or waited on (payment_in_flight), never replaced. */
async function assertPaymentIntentIdle(session: SessionWithStore, pi: Pick<CheckoutPaymentIntent, "id" | "status">): Promise<void> {
  if (pi.status === "succeeded") await settlePaidPaymentIntent(session, pi.id);
  // Processing (bank debit, wallet), authorized (requires_capture): see stripe.ts PI_SETTLING.
  if (pi.status === "processing" || pi.status === "requires_capture") throw new CheckoutError("payment_in_flight", "Un paiement est déjà en cours de validation, patientez quelques secondes.");
}

/**
 * prepareSession on Stripe: the snapshot of this quote and its PaymentIntent (see
 * createOrUpdatePaymentIntent: the session's PaymentIntent updated in place when nothing was submitted
 * on it and nothing is in flight, else a new one). Stripe's errors are tagged "stripe".
 */
async function prepareStripe(session: SessionWithStore, quote: Quote, input: QuoteInput, design: { thankYouLayout: unknown }): Promise<PrepareResult> {
  const fingerprint = snapshotFingerprint(quote, null, null, "stripe");
  let snapshot = await db.checkoutQuote.findFirst({ where: { sessionId: session.id, fingerprint }, orderBy: { createdAt: "desc" } });
  const base = snapshot ? null : await newSnapshotBase(session, quote, input);
  // Ids of another connected account or mode (reconnection, test ↔ live): ignored, a fresh start.
  const stale = stripeIdsStale(session);
  const sessionPiId = stale ? null : session.stripePaymentIntentId;
  const existingId = stale ? null : (snapshot?.stripePaymentIntentId ?? sessionPiId);
  // A payment was submitted on the session's PaymentIntent, and this prepare is for another one (the
  // total changed since): that one is checked first, a payment made or going through on it is never
  // left behind for a new form.
  // One gone from the account (404: deleted) has nothing on it: nothing to check.
  if (sessionPiId && sessionPiId !== existingId && session.payClickedAt) {
    const current = await tagFailureSource(retrievePaymentIntent(session.store, sessionPiId), "stripe").catch((err: unknown) => {
      if (isStripeMissing(err)) return null;
      throw err;
    });
    if (current) await assertPaymentIntentIdle(session, current);
  }
  // Never a PaymentIntent changed (nor canceled) under a payment being submitted (another tab's): a new one then.
  const idle = inFlightMethod(session) === null;
  const paymentIntent = (customerId: string | null) =>
    tagFailureSource(
      createOrUpdatePaymentIntent(session.store, session, stripeTarget(session, quote, fingerprint), {
        existingId,
        reusable: idle,
        // The PaymentIntent a new one replaces: canceled while nothing was submitted on it.
        cancelReplaced: idle,
        saveCard: offersOneClick(design),
        buyer: { customerId },
      }),
      "stripe",
    );
  // The session's Customer gone from the account ("No such customer"): dropped (the confirm creates a fresh one).
  let customerGone = false;
  const pi = await paymentIntent(stale ? null : session.stripeCustomerId).catch((err: unknown) => {
    if (stale || !session.stripeCustomerId || !isStripeMissing(err, "customer")) throw err;
    customerGone = true;
    return paymentIntent(null);
  });
  // Paid or going through (createOrUpdatePaymentIntent never replaces such a PaymentIntent): marked
  // paid (already_paid) or waited on (payment_in_flight), never a new form over it.
  await assertPaymentIntentIdle(session, pi);
  snapshot = await attachPaymentIntent(session.id, snapshot, base && (() => ({ ...base, fingerprint, provider: "stripe" })), pi.id);
  const prepared = await db.checkoutSession.updateMany({
    where: { id: session.id, status: { not: "PAID" } },
    data: {
      ...quoteFields(quote),
      preparedTotalCents: quote.totals.totalCents,
      paymentProvider: "stripe",
      stripePaymentIntentId: pi.id,
      // The other account's (or mode's) Customer is dropped: the confirm creates this account's.
      ...(stale || customerGone ? { stripeCustomerId: null } : {}),
      ...stripePiFields(session, pi),
      preparedAt: session.preparedAt ?? new Date(),
    },
  });
  if (!prepared.count) throw new CheckoutError("already_paid", "Cette commande est déjà payée.");
  // Switched away from Whop (per-session switch, Whop disconnected): its checkouts are deleted (after
  // the answer), so a stale tab or Whop's express buttons can never pay on Whop on top of this PaymentIntent.
  // Not only the checkout this request read: another tab's (or the early prepare's) Whop checkout written
  // in between is listed from the session's snapshots too (nothing to list: no Whop call).
  if (session.paymentProvider === "whop") deleteSessionWhopCheckouts(session);
  return { provider: "stripe", totals: quote.totals, quote, paypal: false, stripe: stripeClientConfig(session, pi) };
}

/**
 * What the session records of its PaymentIntent: the connected account it lives on (a later
 * reconnection to another account never loses it) and whether the card is saved for off-session
 * offers (setup_future_usage "off_session").
 */
function stripePiFields(session: SessionWithStore, pi: Pick<CheckoutPaymentIntent, "offSessionSaved">) {
  // The mode too (`test`): a session carried over a test ↔ live switch pays in the store's mode now
  // (its analytics follow), and its ids are no longer judged stale (stripeIdsStale) once replaced.
  return { stripeAccountId: session.store.stripeAccountId, test: session.store.testMode, stripeOffSessionSaved: pi.offSessionSaved };
}

/**
 * The processor a failed prepare can switch to for this session, or null: an unexpected failure
 * (never a refusal) of Whop or Stripe, the other processor usable for the store (mode, connection),
 * nothing in flight, no PayPal-only checkout asked, not a forced (test) session. Pure.
 */
export function switchTarget(session: SessionWithStore, input: Pick<QuoteInput, "method">, err: unknown): PaymentProvider | null {
  if (err instanceof CheckoutError || input.method === "paypal" || session.forcedProvider) return null;
  const source = checkoutFailureSource(err);
  if (source === "shopify") return null;
  if (inFlightMethod(session) !== null) return null;
  const alt: PaymentProvider = source === "whop" ? "stripe" : "whop";
  return chooseProvider(session.store, { forced: alt }) ? alt : null;
}

/**
 * prepareSession with the per-session instant failover: when the processor fails (Whop down, Stripe
 * down) and the other one is usable (see switchTarget), the failure is journaled (it counts towards
 * the store-level failover), the same prepare runs again on the other processor in the same request,
 * and the switch is journaled (checkout.provider_switched, once per session per 10 min). The buyer
 * simply gets the other processor's form. Throws the (unjournaled) error when no switch applies or
 * the other processor fails too.
 */
export async function prepareWithFailover(session: SessionWithStore, input: QuoteInput, opts: PrepareOptions & { stage?: "prepare" | "pay" } = {}): Promise<PrepareResult & { switchedFrom?: PaymentProvider }> {
  // The processor this attempt uses (a failure of the other one's is no reason to switch to it).
  let attempted: PaymentProvider | null = null;
  try {
    attempted = providerFor(session, opts.provider);
  } catch {
    attempted = null;
  }
  // One clock for the whole request (the switch's own prepare included).
  opts = { ...opts, startedAt: opts.startedAt ?? Date.now() };
  try {
    return await prepareSession(session, input, opts);
  } catch (err) {
    if (checkoutFailureSource(err) !== attempted) throw err;
    return switchAfterFailure(session, input, opts, err);
  }
}

/**
 * The per-session switch after a processor failure `err` (prepare, or the Pay click): when
 * switchTarget allows it (re-checked on a fresh read: a payment may have started meanwhile in
 * another tab, never switched under it), the failure is journaled, the other processor prepared and
 * the switch journaled (checkout.provider_switched, once per session per 10 min). Throws `err` as is
 * (unjournaled) otherwise, or the other processor's error when it fails too.
 */
async function switchAfterFailure(session: SessionWithStore, input: QuoteInput, opts: PrepareOptions & { stage?: "prepare" | "pay" }, err: unknown): Promise<PrepareResult & { switchedFrom?: PaymentProvider }> {
  const from = checkoutFailureSource(err);
  if (from === "shopify" || !switchTarget(session, input, err)) throw err;
  const fresh = await db.checkoutSession.findUnique({ where: { id: session.id }, include: { store: true } });
  const alt = fresh ? switchTarget(fresh, input, err) : null;
  if (!fresh || !alt) throw err;
  // Leaving Stripe on a page (re)load: a payment submitted earlier (past the in-flight window, e.g.
  // a delayed method still processing) is checked first, never a Whop form on top of it.
  if (from === "stripe" && (opts.stage ?? "prepare") === "prepare" && (await checkPaymentIntentBeforeSwitch(fresh)) === "unreachable") throw err;
  await journalCheckoutFailure(session, opts.stage ?? "prepare", err);
  const result = await prepareSession(fresh, input, { ...opts, provider: alt });
  await journalSwitch(session, from, alt, opts.stage ?? "prepare", err instanceof Error ? err.message : String(err));
  return { ...result, switchedFrom: from };
}

async function journalSwitch(session: Pick<CheckoutSession, "id" | "storeId">, from: PaymentProvider, to: PaymentProvider, stage: string, why: string, message?: string) {
  if (!(await rateLimit(`journal:provider_switched:${session.id}`, 1, 10 * 60_000))) return;
  await recordEvent({
    storeId: session.storeId,
    sessionId: session.id,
    level: "warn",
    kind: "checkout.provider_switched",
    message: message ?? `${PROVIDER_NAMES[from]} n'a pas pu ouvrir le paiement : ce client paie avec ${PROVIDER_NAMES[to]} (bascule automatique, même page).`,
    data: { from, to, stage, err: why.slice(0, 300) },
  });
}

/**
 * Before leaving Stripe for Whop on a session where a payment was submitted: the session's
 * PaymentIntent is checked (paid → settled, going through → payment_in_flight, gone → nothing on
 * it). "unreachable" when Stripe's API could not answer: the caller never switches blind then (a
 * delayed method, e.g. SEPA, may still be processing on it).
 */
async function checkPaymentIntentBeforeSwitch(session: SessionWithStore): Promise<"ok" | "unreachable"> {
  if (!session.payClickedAt || !session.stripePaymentIntentId || stripeIdsStale(session)) return "ok";
  const piId = session.stripePaymentIntentId;
  let current: Awaited<ReturnType<typeof retrievePaymentIntent>> | null;
  try {
    current = await retrievePaymentIntent(session.store, piId, STRIPE_PAGE_CALL);
  } catch (e) {
    if (!isStripeMissing(e)) {
      log.warn("checkout.switch_check", "Could not check the session's PaymentIntent before switching to Whop", { sessionId: session.id, paymentIntentId: piId, err: e });
      return "unreachable";
    }
    current = null;
  }
  if (current) await assertPaymentIntentIdle(session, { id: current.id, status: current.status });
  return "ok";
}

/** Journal kind of a payment form that could not load in the buyer's browser (Stripe.js blocked or down). */
export const CLIENT_FAILED_KIND = "checkout.client_failed";
/** A browser failure report counts only from a session served a Stripe form (snapshot created) within this time. */
export const CLIENT_FAILED_SERVED_MS = 5 * 60_000;

/**
 * The page could not load Stripe's form in the buyer's browser (Stripe.js blocked, timed out or
 * failed: `clientFailed: "stripe"` on /prepare). The buyer is switched to Whop when it is usable
 * (same rules as a server failure: nothing in flight, not a PayPal-only checkout, not a forced test
 * session); the failure is journaled (checkout.client_failed, once per session per 10 min) and
 * counted apart (noteCheckoutFailure with its own kind: one buyer's ad blocker never flips the store;
 * three sessions within 10 min do). Otherwise the regular prepare runs (the page says Stripe's form
 * could not load).
 */
export async function prepareAfterClientFailure(session: SessionWithStore, input: QuoteInput, opts: PrepareOptions = {}): Promise<PrepareResult & { switchedFrom?: PaymentProvider }> {
  if (session.paymentProvider !== "stripe") return prepareWithFailover(session, input, opts);
  const why = "Le formulaire Stripe n'a pas pu se charger dans le navigateur du client (Stripe.js bloqué ou indisponible)";
  if (await rateLimit(`journal:client_failed:${session.id}`, 1, 10 * 60_000)) {
    // The report comes from the page (forgeable): it counts towards the store only for a session
    // this server served a Stripe form to moments ago (a Stripe snapshot of it created recently).
    const served = await db.checkoutQuote.findFirst({
      where: { sessionId: session.id, provider: "stripe", createdAt: { gt: new Date(Date.now() - CLIENT_FAILED_SERVED_MS) } },
      select: { id: true },
    });
    await recordEvent({
      storeId: session.storeId,
      sessionId: session.id,
      level: "warn",
      kind: CLIENT_FAILED_KIND,
      message: `${why}.`,
      data: { source: "stripe", stage: "client", ...(session.forcedProvider ? { forced: true } : {}), ...(served ? {} : { unverified: true }) },
    });
    if (!session.forcedProvider && served) await noteCheckoutFailure(session.storeId, "stripe", CLIENT_FAILED_KIND);
  }
  const err = withFailureSource(new Error(why), "stripe");
  if (!switchTarget(session, input, err)) return prepareWithFailover(session, input, opts);
  // A payment was submitted on its PaymentIntent (e.g. the form loaded, then failed on a later
  // load): paid → settled (already_paid), going through → waited on (payment_in_flight), never a
  // Whop form on top. Stripe's API unreachable too: no switch without that check (the regular prepare).
  if ((await checkPaymentIntentBeforeSwitch(session)) === "unreachable") return prepareWithFailover(session, input, opts);
  const result = await prepareSession(session, input, { ...opts, provider: "whop" });
  await journalSwitch(session, "stripe", "whop", "client", why, "Le formulaire Stripe n'a pas pu se charger chez ce client : il paie avec Whop (bascule automatique, même page).");
  return { ...result, switchedFrom: "stripe" };
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

type InFlightFields = Pick<CheckoutSession, "status" | "payClickedAt" | "paypalWindowAt" | "paypalBeatAt" | "paymentProvider">;

/**
 * inFlightMethod with the processor of that attempt: the session's paymentProvider, stamped by the
 * confirm that started it (a prepare never changes it under a payment in flight, see providerFor). Pure.
 */
export function inFlightAttempt(session: InFlightFields, now = Date.now()): { method: "paypal" | "other"; provider: PaymentProvider } | null {
  const method = inFlightMethod(session, now);
  return method ? { method, provider: session.paymentProvider } : null;
}

/**
 * Refuses a confirm with another method or another processor than the payment in flight (see
 * inFlightAttempt): a Stripe payment going through blocks a Whop confirm and vice versa.
 */
function assertNoOtherInFlight(session: InFlightFields, method: PayInput["method"], provider: PaymentProvider) {
  const inFlight = inFlightAttempt(session);
  if (inFlight && (inFlight.method !== (method === "paypal" ? "paypal" : "other") || inFlight.provider !== provider)) {
    throw new CheckoutError("payment_in_flight", "Un paiement est déjà en cours de validation, patientez quelques secondes.");
  }
}

/**
 * Saves the buyer's details right before the embedded Whop form is submitted.
 * If the checkout the page holds doesn't charge exactly the current quote, returns
 * a fresh one instead so the buyer is never charged a stale amount.
 */
export async function confirmSession(session: SessionWithStore, input: PayInput, opts: { host?: string | null; startedAt?: number } = {}): Promise<ConfirmOutcome> {
  // The processor this session pays with now (see providerFor: sticky, forced, or the store's).
  const provider = providerFor(session);
  // A payment still going through with another method or processor (e.g. a PayPal window in a
  // second tab): never a second charge on top of it. The same method (a card retried) and a FAILED
  // session pass (unless a PayPal window opened after the failed card). Checked again atomically below.
  assertNoOtherInFlight(session, input.method, provider);
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

  const expected =
    provider === "stripe" ? snapshotFingerprint(quote, null, null, "stripe") : snapshotFingerprint(quote, input.method, thankYouReturnUrl(session.store, session.id, opts.host));
  const configId = input.checkoutConfigurationId ?? session.whopCheckoutId;
  // The page's Whop checkout, or its Stripe PaymentIntent (whichever processor the session uses now).
  const snapshot =
    provider === "stripe"
      ? input.paymentIntentId
        ? await db.checkoutQuote.findUnique({ where: { stripePaymentIntentId: input.paymentIntentId } })
        : null
      : configId
        ? await db.checkoutQuote.findUnique({ where: { whopCheckoutId: configId } })
        : null;
  // The checkout must charge this quote AND offer the chosen method (PayPal-only or regular) on
  // this processor. Otherwise a fresh one (nothing was submitted yet: the per-session switch applies).
  // Stripe: a PaymentIntent (and Customer) of another connected account or mode (reconnection, test ↔
  // live switch, see stripeIdsStale) is never confirmed: a fresh one on the store's account first.
  // Whop: a configuration deleted at a switch to Stripe (marked, or the session still on Stripe:
  // its deletion may be running) is never ready: a fresh one first.
  const whopDeleted = provider === "whop" && (session.paymentProvider === "stripe" || isDeletedFingerprint(snapshot?.fingerprint));
  if (!snapshot || snapshot.sessionId !== session.id || snapshot.provider !== provider || snapshot.fingerprint !== expected || whopDeleted || (provider === "stripe" && stripeIdsStale(session))) {
    return notReady(await prepareWithFailover(session, quoteInput, { ...opts, stage: "pay" }));
  }

  // Stripe: the buyer's Customer (the saved card of a one-click offer hangs on it) and shipping go on
  // the PaymentIntent before the page confirms it. The app asks for no Stripe receipt (no
  // receipt_email), but an account with « Paiements réussis » customer e-mails on still e-mails the
  // Customer: the merchant turns it off in Stripe (dashboard Stripe page, « Reçus Stripe »).
  let stripeFields: ({ stripePaymentIntentId: string; stripeCustomerId: string } & ReturnType<typeof stripePiFields>) | null = null;
  let stripeConfig: StripeClientConfig | null = null;
  if (provider === "stripe") {
    let customerId: string;
    let pi: CheckoutPaymentIntent;
    try {
      // One Customer per session (see ensureStripeCustomer), its e-mail kept up to date. `replaces`:
      // the Customer a PaymentIntent call said is gone (deleted on the account): a fresh one.
      const customer = (replaces?: string) =>
        tagFailureSource(
          ensureStripeCustomer(session.store, {
            email: input.email,
            name: `${input.address.firstName} ${input.address.lastName}`.trim(),
            sessionId: session.id,
            customerId: session.stripeCustomerId,
            previousEmail: session.email,
            replaces,
          }),
          "stripe",
        );
      // Recorded at once (not only with the Pay click below): a PaymentIntent call failing next, or
      // the PaymentIntent replaced, never leaves a Customer the session forgets (and re-creates).
      const remember = async (id: string) => {
        if (id !== session.stripeCustomerId) await db.checkoutSession.updateMany({ where: { id: session.id, status: { not: "PAID" } }, data: { stripeCustomerId: id } });
      };
      const paymentIntent = (id: string) =>
        tagFailureSource(
          createOrUpdatePaymentIntent(session.store, session, stripeTarget(session, quote, expected), {
            existingId: snapshot.stripePaymentIntentId,
            reusable: false,
            cancelReplaced: true,
            saveCard: offersOneClick(design),
            buyer: { email: input.email, customerId: id, shipping: stripeShipping(input.address) },
          }),
          "stripe",
        );
      customerId = await customer();
      await remember(customerId);
      try {
        pi = await paymentIntent(customerId);
      } catch (err) {
        // The recorded Customer is gone from the account ("No such customer"): a fresh one, once.
        if (!isStripeMissing(err, "customer")) throw err;
        customerId = await customer(customerId);
        await remember(customerId);
        pi = await paymentIntent(customerId);
      }
    } catch (err) {
      // Stripe failing at the Pay click (nothing submitted yet): this buyer is switched to Whop when
      // it is usable (switchAfterFailure: journaled, counted), the page shows Whop's form first.
      if (err instanceof CheckoutError || checkoutFailureSource(err) !== "stripe") throw err;
      return notReady(await switchAfterFailure(session, quoteInput, { ...opts, stage: "pay" }, err));
    }
    // Paid meanwhile (webhook late or lost): marked paid here (already_paid); going through: waited on.
    await assertPaymentIntentIdle(session, pi);
    // Its PaymentIntent was canceled meanwhile: a new one, which the page mounts first.
    if (pi.id !== snapshot.stripePaymentIntentId) {
      await attachPaymentIntent(session.id, snapshot, null, pi.id);
      await db.checkoutSession.updateMany({ where: { id: session.id, status: { not: "PAID" } }, data: { stripePaymentIntentId: pi.id, stripeCustomerId: customerId, paymentProvider: "stripe", ...stripePiFields(session, pi) } });
      return { ready: false, provider: "stripe", totals: quote.totals, stripe: stripeClientConfig(session, pi) };
    }
    stripeFields = { stripePaymentIntentId: pi.id, stripeCustomerId: customerId, ...stripePiFields(session, pi) };
    stripeConfig = stripeClientConfig(session, pi);
  }

  const clickedAt = new Date();
  const data = {
    ...quoteFields(quote),
    ...(provider === "whop" ? { whopCheckoutId: snapshot.whopCheckoutId } : stripeFields),
    // The processor of this attempt (inFlightAttempt): another one is refused while it is in flight.
    paymentProvider: provider,
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
    const now = await db.checkoutSession.findUnique({ where: { id: session.id }, select: { status: true, payClickedAt: true, paypalWindowAt: true, paypalBeatAt: true, paymentProvider: true } });
    if (!now || now.status === "PAID") throw new CheckoutError("already_paid", "Cette commande est déjà payée.");
    assertNoOtherInFlight(now, input.method, provider);
    // Attempts keep landing (never in practice): refused like one in flight, the buyer retries.
    if (round >= 2) throw new CheckoutError("payment_in_flight", "Un paiement est déjà en cours de validation, patientez quelques secondes.");
    seen = now;
  }
  if (input.method === "paypal") log.info("checkout.pay_method", "Paiement lancé avec PayPal (bouton express)", { storeId: session.storeId, sessionId: session.id, method: "paypal" });
  if (stripeConfig) return { ready: true, provider: "stripe", totals: quote.totals, stripe: stripeConfig };
  return { ready: true, provider: "whop", checkoutConfigurationId: snapshot.whopCheckoutId!, totals: quote.totals };
}

/**
 * confirmSession's answer: `ready` = the page submits its form now; otherwise the fresh checkout it
 * must show first (Whop configuration, or Stripe PaymentIntent: maybe on the other processor after a
 * per-session switch, `switchedFrom`).
 */
export type ConfirmOutcome =
  | { ready: boolean; provider: "whop"; checkoutConfigurationId: string; totals: Totals; stripe?: undefined; switchedFrom?: PaymentProvider }
  | { ready: boolean; provider: "stripe"; checkoutConfigurationId?: undefined; totals: Totals; stripe: StripeClientConfig; switchedFrom?: PaymentProvider };

function notReady(prepared: PrepareResult & { switchedFrom?: PaymentProvider }): ConfirmOutcome {
  const switched = prepared.switchedFrom ? { switchedFrom: prepared.switchedFrom } : {};
  return prepared.provider === "stripe"
    ? { ready: false, provider: "stripe", totals: prepared.totals, stripe: prepared.stripe, ...switched }
    : { ready: false, provider: "whop", checkoutConfigurationId: prepared.checkoutConfigurationId, totals: prepared.totals, ...switched };
}

/**
 * The prepare / pay routes' JSON for a prepared checkout: Whop's configuration as always, or what the
 * page needs to mount Stripe's Payment Element (client secret, publishable key of the store's mode,
 * connected account). `environment` stays for Whop's embed.
 */
export function paymentPayload(r: { provider: PaymentProvider; checkoutConfigurationId?: string; stripe?: StripeClientConfig; switchedFrom?: PaymentProvider }, store: Pick<Store, "testMode">) {
  const environment = store.testMode ? ("sandbox" as const) : ("production" as const);
  const switched = r.switchedFrom ? { switchedFrom: r.switchedFrom } : {};
  if (r.provider === "stripe" && r.stripe) {
    return { provider: "stripe" as const, checkoutConfigurationId: null, ...r.stripe, environment, ...switched };
  }
  return { provider: "whop" as const, checkoutConfigurationId: r.checkoutConfigurationId ?? null, environment, ...switched };
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
  /** Processor of the payment (absent: Whop, the historical one). */
  provider?: "whop" | "stripe";
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
  /** The processor's fee on the payment, in cents (net-margin analytics). */
  feeCents?: number | null;
  /** Stripe only: the Customer and the saved PaymentMethod (one-click offers, off-session). */
  stripeCustomerId?: string | null;
  stripePaymentMethodId?: string | null;
  /** Stripe only: the PaymentIntent's metadata.fingerprint (hash of the snapshot it charges, see fingerprintTag). */
  stripeFingerprint?: string | null;
  /** Stripe only: whether the paid PaymentIntent saved the card off session (setup_future_usage). */
  stripeOffSessionSaved?: boolean | null;
  /** Stripe only: the payment's mode (the event's / PaymentIntent's `livemode`); null when unknown. */
  livemode?: boolean | null;
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

  const stripe = payment.provider === "stripe";
  // The configuration that was actually paid decides what the order contains: Whop's checkout
  // configuration, or the quote the Stripe PaymentIntent was created (or last updated) for.
  let snapshot: CheckoutQuote | null;
  let snapshotMismatch: string | null = null;
  if (stripe) {
    snapshot = await stripeSnapshot(sessionId, payment);
    if (!snapshot && payment.stripeFingerprint) snapshotMismatch = `le paiement Stripe ne correspond à aucun récapitulatif enregistré (empreinte ${payment.stripeFingerprint.slice(0, 12)})`;
  } else {
    const configId = payment.checkoutConfigurationId ?? session.whopCheckoutId;
    snapshot = configId ? await db.checkoutQuote.findUnique({ where: { whopCheckoutId: configId } }) : null;
  }
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
  if (!paid) reasons.push(snapshotMismatch ?? "configuration de paiement inconnue");
  // A physical order with no shipping address from the wallet nor from our form (e.g. Google Pay
  // express: Whop collects no shipping address there): never shipped to a guess silently. Held for
  // review, with the billing address (if any) as a starting point for the merchant.
  const paidLines = (paid?.lines ?? session.lines) as { requiresShipping?: boolean }[] | null;
  const shipsGoods = Array.isArray(paidLines) && paidLines.some((l) => l?.requiresShipping);
  if (shipsGoods && !walletAddress && !formAddress) {
    reasons.push(address ? "adresse de livraison absente du paiement (adresse de facturation reprise, à confirmer)" : "adresse de livraison absente du paiement");
  }
  // A Stripe payment of the other mode than the store's (a test payment on a live store, or a live one
  // on a store in test mode): held. The order's Shopify test flag follows the payment's own mode
  // (session.test, set below), so a test payment never becomes a real order.
  const paymentLivemode = stripe && typeof payment.livemode === "boolean" ? payment.livemode : null;
  if (paymentLivemode != null) {
    const store = await db.store.findUnique({ where: { id: session.storeId }, select: { testMode: true } });
    if (store && paymentLivemode === store.testMode) reasons.push("paiement Stripe en mode test/production différent de la boutique");
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
        // The processor's payment id (Whop "pay_…" or Stripe "pi_…"): every lookup by payment id
        // (refunds, disputes, duplicates, the Shopify order's payment tag) reads this column.
        whopPaymentId: payment.id,
        paymentProvider: stripe ? "stripe" : "whop",
        whopMemberId: payment.memberId ?? null,
        whopPaymentMethodId: payment.paymentMethodId ?? null,
        paymentMethodType: payment.paymentMethodType ?? null,
        // Whop's fee in its historical column, any other processor's in providerFeeCents (see feeCents()).
        whopFeeCents: stripe ? null : (feeCents ?? null),
        ...(stripe
          ? {
              stripePaymentIntentId: payment.id,
              stripeCustomerId: payment.stripeCustomerId ?? null,
              stripePaymentMethodId: payment.stripePaymentMethodId ?? null,
              // The paid PaymentIntent decides (not the last one prepared): only a card it saved off session is charged in one click.
              ...(payment.stripeOffSessionSaved != null ? { stripeOffSessionSaved: payment.stripeOffSessionSaved } : {}),
              providerFeeCents: feeCents ?? null,
              // The payment's mode decides whether its order is a Shopify test order.
              ...(paymentLivemode != null ? { test: !paymentLivemode } : {}),
            }
          : {}),
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
    const reviewNote = all.length ? `À vérifier : ${all.join(" ; ")}. Remboursez dans ${stripe ? "Stripe" : "Whop"} ou synchronisez la commande manuellement.` : null;
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
    message: `Paiement ${stripe ? "Stripe" : "Whop"} ${payment.id} reçu (${(paid?.totalCents ?? session.totalCents) / 100} ${session.currency})`,
    data: { paymentId: payment.id, provider: stripe ? "stripe" : "whop" },
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

/**
 * The snapshot a Stripe PaymentIntent paid: the quote it is attached to, when the PaymentIntent's own
 * metadata (fingerprint hash, written with its amount) agrees; else this session's quote whose
 * fingerprint has that hash (the PaymentIntent was moved to another snapshot after the payment was
 * submitted, or a later attach lost the race); else none (held for review by markPaid). A
 * PaymentIntent without the metadata (older ones) keeps the attached quote.
 */
async function stripeSnapshot(sessionId: string, payment: Pick<PaymentInfo, "id" | "stripeFingerprint">): Promise<CheckoutQuote | null> {
  const attached = await db.checkoutQuote.findUnique({ where: { stripePaymentIntentId: payment.id } });
  const tag = payment.stripeFingerprint;
  if (!tag) return attached;
  if (attached && attached.sessionId === sessionId && fingerprintTag(attached.fingerprint) === tag) return attached;
  const candidates = await db.checkoutQuote.findMany({ where: { sessionId, provider: "stripe" }, orderBy: { createdAt: "desc" } });
  const match = candidates.find((q) => fingerprintTag(q.fingerprint) === tag) ?? null;
  if (match) {
    log.warn("stripe.snapshot_mismatch", "Stripe PaymentIntent paid another snapshot than the one attached: the matching one is used", { sessionId, paymentId: payment.id, attached: attached?.id ?? null, used: match.id });
  }
  return match;
}

/** Prefix of Stripe payment ids in CheckoutSession.extraPaymentIds ("stripe:pi_…"). */
export const STRIPE_EXTRA_PREFIX = "stripe:";

/** How a duplicate payment is kept in extraPaymentIds: Whop's id as is, Stripe's prefixed. Pure. */
export function extraPaymentId(payment: Pick<PaymentInfo, "id" | "provider">): string {
  return payment.provider === "stripe" ? `${STRIPE_EXTRA_PREFIX}${payment.id}` : payment.id;
}

/**
 * The processor's fee on a paid checkout (Whop's or another processor's), null when unknown.
 * Same as charge.ts `feeCents`, re-exported where the payment is recorded. Pure.
 */
export { feeCents } from "./charge";

async function alreadyPaid(session: CheckoutSession, payment: PaymentInfo, opts: { deferSync?: boolean }): Promise<boolean> {
  if (session.whopPaymentId && session.whopPaymentId !== payment.id) {
    // A second payment for the same cart (e.g. wallet + card, or Whop then Stripe): keep the first
    // order going, and flag the extra payment for a refund without blocking anything. A Stripe
    // payment is kept as "stripe:pi_…" (never mistaken for a Whop id).
    const stripe = payment.provider === "stripe";
    const extraId = extraPaymentId(payment);
    const added = await db.$executeRaw`
      UPDATE "CheckoutSession" SET "extraPaymentIds" = array_append("extraPaymentIds", ${extraId})
      WHERE id = ${session.id} AND NOT (${extraId} = ANY("extraPaymentIds"))`;
    if (added > 0) {
      await recordEvent({
        storeId: session.storeId,
        sessionId: session.id,
        level: "warn",
        kind: "payment.duplicate",
        message: `Paiement ${stripe ? "Stripe" : "Whop"} supplémentaire ${payment.id} reçu pour un panier déjà payé — à rembourser dans ${stripe ? "Stripe" : "Whop"}.`,
        data: { paymentId: payment.id, provider: stripe ? "stripe" : "whop" },
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
      await tagOrder(session.store, order.id, [disputeTag(session.paymentProvider)]);
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
    // The order's gateway, tags and note follow the processor that was paid.
    provider: session.paymentProvider,
    // A Stripe payment's own mode (session.test, set by markPaid from its livemode): a test payment is
    // never a real order, even on a store switched to live since. Whop: the store's mode.
    test: session.paymentProvider === "stripe" ? session.test : session.store.testMode,
  };
}

/**
 * Applies one Whop / Stripe refund, exactly once per refund id (Stripe's are "stripe:re_…"): the id
 * marker and the amount are written in one transaction (a crash can't keep one without the other).
 * Mirroring to Shopify is a separate, retryable step.
 */
export async function recordRefund(sessionId: string, refundCents: number, refundId: string, chargeCents: number | null = null, provider: "whop" | "stripe" = "whop") {
  const via = provider === "stripe" ? "Stripe" : "Whop";
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
    await tx.refundRecord.create({ data: { id: refundId, storeId: session.storeId, sessionId, amountCents, currency: session.currency, provider } });
    return session;
  });
  if (!applied) return;
  await recordEvent({
    storeId: applied.storeId,
    sessionId,
    kind: "refund.recorded",
    message: `Remboursement ${via} de ${amountCents / 100} ${applied.currency} enregistré`,
    data: { refundId, provider },
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
      message: `Remboursement ${via} de ${formatAmount(amountCents, applied.currency)} : reportez-le à la main sur ${applied.shopifyOrderName ?? "la commande créée à la main"} dans Shopify (commande liée à la main, pas de report automatique).`,
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
export type CheckoutFailureSource = "whop" | "stripe" | "shopify";
const FAILURE_SOURCE = Symbol.for("whop-checkout.failureSource");

/** Marks an error with the provider it comes from (see tagFailureSource). */
export function withFailureSource<E>(err: E, source: CheckoutFailureSource): E {
  if (err && typeof err === "object") (err as Record<symbol, unknown>)[FAILURE_SOURCE] = source;
  return err;
}

/**
 * Marks the errors of a call with the provider they come from (kept when rethrown as is). An error
 * already tagged inside the call keeps its tag (the innermost call knows best), and a refusal
 * (CheckoutError) is never attributed to a processor.
 */
export async function tagFailureSource<T>(p: Promise<T>, source: CheckoutFailureSource, except?: (err: unknown) => boolean): Promise<T> {
  try {
    return await p;
  } catch (err) {
    const tagged = err && typeof err === "object" && FAILURE_SOURCE in (err as object);
    throw tagged || err instanceof CheckoutError || except?.(err) ? err : withFailureSource(err, source);
  }
}

/** Whether an error is the database's (Prisma): never a processor's failure. Pure. */
export function isDbError(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError ||
    err instanceof Prisma.PrismaClientUnknownRequestError ||
    err instanceof Prisma.PrismaClientInitializationError ||
    err instanceof Prisma.PrismaClientRustPanicError ||
    err instanceof Prisma.PrismaClientValidationError
  );
}

/**
 * Which side a checkout init failure comes from: Shopify (pricing, stock, the cart: ShopifyError or a
 * call tagged "shopify"), Stripe (a PaymentIntent call, tagged "stripe") or Whop (the checkout
 * configuration — and anything unclassified, which keeps the safe behaviour of sending buyers to
 * Shopify's own checkout). Pure.
 */
export function checkoutFailureSource(err: unknown): CheckoutFailureSource {
  const tagged = err && typeof err === "object" ? (err as Record<symbol, unknown>)[FAILURE_SOURCE] : undefined;
  if (tagged === "whop" || tagged === "stripe" || tagged === "shopify") return tagged;
  return err instanceof ShopifyError ? "shopify" : "whop";
}

export async function journalCheckoutFailure(session: Pick<CheckoutSession, "id" | "storeId"> & Partial<Pick<CheckoutSession, "forcedProvider">>, stage: "prepare" | "pay", err: unknown) {
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
  // Whop or Stripe: counted per processor (store-level failover, then Shopify's own checkout).
  const source = checkoutFailureSource(err) === "stripe" ? ("stripe" as const) : ("whop" as const);
  // Not counted towards the store: a forced session (« Tester le secours » by the merchant), and a
  // Stripe refusal of this one request (4xx: currency, amount too small, idempotency, invalid request:
  // Stripe answered, it isn't down). Both still journaled (and may have switched this buyer).
  const forced = !!session.forcedProvider;
  const rejected = source === "stripe" && isStripeRejection(err);
  const counts = !forced && !rejected;
  // One row per session per processor per 10 min (a buyer retrying during an outage); the failure still counts below.
  if (!(await rateLimit(`journal:init_failed:${source === "stripe" ? "stripe:" : ""}${session.id}`, 1, 10 * 60_000))) {
    if (counts) await noteCheckoutFailure(session.storeId, source);
    return;
  }
  const code = rejected ? (err as { code?: unknown }).code : undefined;
  await recordEvent({
    storeId: session.storeId,
    sessionId: session.id,
    level: counts ? "error" : "warn",
    kind: "checkout.init_failed",
    message: `Le formulaire de paiement ${PROVIDER_NAMES[source]} n'a pas pu s'ouvrir (${stage}) : ${err instanceof Error ? err.message : String(err)}${rejected ? " (refus de Stripe pour cette commande, non compté comme une panne)" : forced ? " (session de test « Tester le secours », non comptée)" : ""}`,
    data: { stage, source, err: err instanceof Error ? err.message : String(err), ...(forced ? { forced: true } : {}), ...(rejected ? { rejected: true, ...(typeof code === "string" ? { code } : {}) } : {}) },
    alert: counts,
    // The Error itself (stack, type) goes to Sentry; the journal keeps its message only (data above).
    err,
  });
  if (counts) await noteCheckoutFailure(session.storeId, source);
}

export async function recordDispute(sessionId: string, disputeId: string | null, dueAt: Date | null = null) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session) return;
  const via = session.paymentProvider === "stripe" ? "Stripe" : "Whop";
  const tagName = disputeTag(session.paymentProvider);
  // Atomic "first time": concurrent deliveries can't alert twice.
  const first = await db.checkoutSession.updateMany({ where: { id: sessionId, disputed: false }, data: { disputed: true, disputeOpenedAt: new Date() } });
  if (first.count) {
    if (session.shopifyOrderId) {
      const orderId = session.shopifyOrderId;
      // Backstopped by the tick (disputeTaggedAt stays null until Shopify confirms).
      const tag = () =>
        tagOrder(session.store, orderId, [tagName])
          .then(() => db.checkoutSession.update({ where: { id: sessionId }, data: { disputeTaggedAt: new Date() } }))
          .catch((err) => log.warn("dispute.tag_failed", "Could not tag the disputed Shopify order (the tick retries)", { sessionId, err }));
      if (!defer("dispute.tag", tag)) await tag();
    } else if (session.syncHandledAt && !session.syncSkippedReason) {
      await recordEvent({
        storeId: session.storeId,
        sessionId,
        level: "warn",
        kind: "dispute.manual_order",
        message: `Litige sur ${session.shopifyOrderName ?? "une commande créée à la main"} (commande liée à la main) : ajoutez le tag « ${tagName} » dans Shopify et fournissez le numéro de suivi à la main dans ${via} (aucun envoi automatique).`,
        data: { disputeId },
        alert: true,
      });
    }
    await recordEvent({
      storeId: session.storeId,
      sessionId,
      level: "warn",
      kind: "dispute.created",
      message: `Litige ${via} ouvert sur ${session.shopifyOrderName ?? "une commande"} (${session.totalCents / 100} ${session.currency})${
        dueAt ? `, réponse attendue avant le ${dueAt.toISOString().slice(0, 10)}` : ""
      }`,
      data: { disputeId, provider: session.paymentProvider },
      alert: true,
    });
  }
  if (!disputeId) return;
  const set = await db.checkoutSession.updateMany({ where: { id: sessionId, disputeId: null }, data: { disputeId, disputeDueAt: dueAt } });
  if (!set.count && session.disputeId !== disputeId) {
    // A second dispute on the same payment: the automatic evidence covers the first one only.
    await recordEvent({ storeId: session.storeId, sessionId, level: "error", kind: "dispute.second", message: `Deuxième litige (${disputeId}) sur cette commande : répondez-y dans ${via}.`, alert: true });
    return;
  }
  // Submit now if the parcel is already tracked; otherwise the tick waits for tracking (never past the due date).
  if (set.count && session.store.autoDisputeEvidence && session.trackingNumber && !session.disputeEvidenceAt) {
    const evidence = async () => submitDisputeEvidence(await db.checkoutSession.findUniqueOrThrow({ where: { id: sessionId }, include: { store: true } }), disputeId);
    if (!defer("dispute.evidence", evidence)) await evidence();
  }
}

/**
 * A declined payment attempt (Whop payment.failed, Stripe payment_intent.payment_failed). A late
 * failure of an earlier attempt never erases a newer one (a "Pay" click or a PayPal window after this
 * attempt): the session keeps that attempt's state (PAYING, in flight). `attemptAt` is when the failed
 * attempt was made (Whop: the payment's created_at; Stripe: the failure event's time); unknown =
 * counted as the latest. The rule, per time:
 * - payClickedAt (our confirm, always BEFORE the attempt it makes): newer only when later than
 *   attemptAt + 1 s. The 1 s covers second-precision (truncated) timestamps, so the current
 *   attempt's own failure is never "older"; a retry clicked 2 s after is newer.
 * - paypalWindowAt (a window from Whop's own button: the payment is created by that click, our
 *   stamp lands AFTER it): newer only when later than attemptAt + 5 s.
 * - paypalBeatAt (heartbeat / late popup): liveness only, never an attempt, never compared.
 */
export async function recordPaymentFailure(storeId: string, sessionId: string, attemptAt: Date | null, reason: string) {
  const notNewer: Prisma.CheckoutSessionWhereInput = attemptAt
    ? {
        AND: [
          { OR: [{ payClickedAt: null }, { payClickedAt: { lte: new Date(attemptAt.getTime() + 1000) } }] },
          { OR: [{ paypalWindowAt: null }, { paypalWindowAt: { lte: new Date(attemptAt.getTime() + 5000) } }] },
        ],
      }
    : {};
  const changed = await db.checkoutSession.updateMany({
    where: { id: sessionId, status: { not: "PAID" }, ...notNewer },
    data: { status: "FAILED", paymentFailedAt: new Date() },
  });
  // In the order's timeline: why the bank refused (the buyer can still retry).
  if (changed.count) {
    await recordEvent({ storeId, sessionId, kind: "payment.failed", message: `Paiement refusé${reason}` });
  } else if (attemptAt && (await db.checkoutSession.count({ where: { id: sessionId, status: { not: "PAID" } } }))) {
    // A real decline all the same: counted by the analytics (paymentFailedAt, first one only),
    // the status of the newer attempt left alone.
    await db.checkoutSession.updateMany({ where: { id: sessionId, status: { not: "PAID" }, paymentFailedAt: null }, data: { paymentFailedAt: new Date() } });
    await recordEvent({ storeId, sessionId, kind: "payment.failed", message: `Paiement refusé${reason} — tentative antérieure, un nouvel essai est en cours.` });
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
