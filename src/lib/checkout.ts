import "server-only";
import { DeadlineError, notePartial } from "./deadline";
import { z } from "zod";
import { Prisma, type CheckoutQuote, type CheckoutSession, type Store } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import {
  checkDiscount,
  computeTotals,
  giftLine,
  giftProgress,
  giftTitle,
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
import { createCheckoutConfiguration } from "./whop";
import { designFor } from "./experiments";
import { loadCheckoutLayout, loadInterception, loadTheme } from "./layout";
import { automaticDiscountFor, automaticStackFor, CALIBRATION_SETTLE_MS, canReadShopifyDiscounts, lookupShopifyCode, needsCollections, productCollections, shopifyCodeAsDiscount, shopifyCodeUses, type ShopifyCodeDiscount } from "./shopify-discounts";
import { overridesFor, withAddOnOverrides, withProtectionOverride } from "./checkout-tests";
import { chargePlan, chargeFallback, toShopCents, type ChargePlan } from "./charge";
import { recordIncident } from "./incidents";
import { GOOGLE_ADJUST_DUE } from "./google-conversions";
import { recordOrderCustomer } from "./shopify-history";

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
 * Applies quantity changes: re-prices the changed cart with Shopify (price and stock
 * are never taken from the browser) and saves it on the session. Unchanged → as is.
 */
async function linesFor(session: SessionWithStore, quantities: Record<string, number> | undefined): Promise<CartLine[]> {
  // Free gifts are re-derived by every quote: never a buyer line (a paid session's lines hold them).
  const current = (session.lines as unknown as CartLine[]).filter((l) => !l.gift);
  if (!quantities) return current;
  const wanted = current.map((l) => ({ variantId: l.variantId, quantity: quantities[l.variantId] ?? l.quantity }));
  // Products added from the checkout ("Complétez votre commande"): new variant ids.
  const known = new Set(current.map((l) => l.variantId));
  const added = Object.entries(quantities)
    .filter(([id, qty]) => !known.has(id) && qty > 0 && /^gid:\/\/shopify\/ProductVariant\/\d+$/.test(id))
    .slice(0, Math.max(0, MAX_LINES - current.length))
    .map(([variantId, quantity]) => ({ variantId, quantity }));
  if (!added.length && wanted.every((w, i) => w.quantity === current[i].quantity)) return current;
  const kept = [...wanted, ...added].filter((w) => w.quantity > 0);
  if (!kept.length) throw new CheckoutError("empty_cart", "Votre panier est vide.");
  const priced = await priceCart(session.store, kept);
  if (!priced.length) throw new CheckoutError("empty_cart", "Ces articles ne sont plus disponibles.");
  // Products the merchant keeps on Shopify's checkout can't be added here either.
  const excluded = loadInterception(session.store.interception).excludedHandles;
  if (priced.some((l) => !known.has(l.variantId) && (excluded.includes(l.productHandle) || l.giftCard))) {
    throw new CheckoutError("empty_cart", "Ce produit ne peut pas être ajouté ici.");
  }
  const lines = priced.map((l) => (l.inventory != null && l.inventory > 0 && l.quantity > l.inventory ? { ...l, quantity: l.inventory } : l));
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
  const [allRates, storeAddOns, discountRow, design, overrides] = await Promise.all([
    db.shippingRate.findMany({ where: { storeId: session.storeId }, orderBy: { position: "asc" } }),
    db.addOn.findMany({ where: { storeId: session.storeId, active: true } }),
    input.discountCode
      ? db.discountCode.findFirst({
          where: { storeId: session.storeId, code: { equals: input.discountCode, mode: "insensitive" } },
        })
      : null,
    designFor(session.store, session),
    // Checkout A/B tests: arm B's tiers, order-bump prices / visibility, protection pricing.
    overridesFor(session),
  ]);
  const allAddOns = withAddOnOverrides(storeAddOns, overrides);

  // Quantity breaks v2: percent tiers (maybe scoped to products) and free gifts.
  const tiers = parseQuantityTiers(overrides.breaks ?? session.store.quantityBreaks);
  const progress = giftProgress(tiers.gifts, buyerLines);
  const gifts = await giftLinesFor(session, progress.earned);
  const lines = [...buyerLines, ...gifts];

  const rates = ratesForCountry(allRates, input.countryCode ?? null);
  const rate = rates.find((r) => r.id === input.shippingRateId) ?? rates[0] ?? null;

  let discount: DiscountInput | null = null;
  let discountSource: "app" | "shopify" = "app";
  let shopifyCode: ShopifyCodeDiscount | null = null;
  let discountError: string | null = null;
  let discountErrorCode: string | null = null;
  if (input.discountCode) {
    // One message for unknown, inactive, expired or used-up codes: don't help guess private codes.
    const invalid = "Code promo invalide ou expiré";
    if (!discountRow && session.store.shopifyDiscountCodes && session.store.shopifyAccessToken && canReadShopifyDiscounts(session.store)) {
      // Not one of the app's codes: a code created in Shopify (amount off / free shipping).
      const found = await lookupShopifyCode(session.store, input.discountCode);
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
  const totals = computeTotals({ lines, rate, discount, addOns, quantityBreaks: tiers.breaks, protection: protectionOn ? protectionBlock!.props : null, ...stack });
  const offered = protectionBlock ? computeTotals({ lines, rate, discount, addOns: [], quantityBreaks: tiers.breaks, protection: protectionBlock.props, ...stack }) : null;
  // A discount that doesn't combine with the others was left out (the best combination for the buyer is kept).
  if (totals.dropped?.includes("code") && discount) {
    discount = null;
    shopifyCode = null;
    discountError = "Ce code ne se cumule pas avec les remises déjà appliquées : la remise la plus avantageuse est conservée";
    discountErrorCode = "discount_not_combinable";
  }
  if (totals.dropped?.includes("automatic")) automatic = { cents: 0, titles: [] };
  const volumeBreak = quantityBreakForLines(tiers.breaks, buyerLines);
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
  };
  // The Shopify code as read (limits, usage count): frozen on the snapshot, never sent to the browser.
  if (shopifyCode && discountSource === "shopify") shopifyCodeOf.set(quote, shopifyCode);
  return quote;
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
 * Returns the Whop checkout configuration for the current quote, creating it (and a
 * frozen snapshot of what it charges) when this exact quote was never prepared.
 * The snapshot — not the session's latest state — later drives the Shopify order, so
 * racing requests or a stale wallet button can never pay for one thing and ship another.
 */
export async function prepareSession(session: SessionWithStore, input: QuoteInput) {
  const quote = await quoteSession(session, input);
  assertPayable(session, quote, input);
  const fingerprint = quoteFingerprint(quote);

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
      currency: quote.charge?.currency ?? session.currency,
      title: `Commande ${session.store.name}`,
      redirectUrl: `${env.appUrl}/c/${session.id}/merci`,
      country: input.countryCode ?? null,
    }), "whop");
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
  return { checkoutConfigurationId: snapshot.whopCheckoutId, totals: quote.totals, quote };
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
 * Saves the buyer's details right before the embedded Whop form is submitted.
 * If the checkout the page holds doesn't charge exactly the current quote, returns
 * a fresh one instead so the buyer is never charged a stale amount.
 */
export async function confirmSession(session: SessionWithStore, input: PayInput) {
  const quoteInput = { ...input, countryCode: input.address.countryCode };
  const quote = await quoteSession(session, quoteInput);
  assertPayable(session, quote, quoteInput);
  const theme = loadTheme((await designFor(session.store, session)).theme, session.store.name);
  if (theme.requireTerms && !input.acceptsTerms) {
    throw new CheckoutError("terms_required", "Veuillez accepter les conditions générales de vente.");
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
  if (!snapshot || snapshot.sessionId !== session.id || snapshot.fingerprint !== quoteFingerprint(quote)) {
    const prepared = await prepareSession(session, quoteInput);
    return { ready: false as const, checkoutConfigurationId: prepared.checkoutConfigurationId, totals: prepared.totals };
  }

  const confirmed = await db.checkoutSession.updateMany({
    where: { id: session.id, status: { not: "PAID" } },
    data: {
      ...quoteFields(quote),
      whopCheckoutId: snapshot.whopCheckoutId,
      preparedTotalCents: snapshot.totalCents,
      status: "PAYING",
      payClickedAt: new Date(),
      termsAcceptedAt: input.acceptsTerms ? new Date() : null,
      email: input.email,
      acceptsMarketing: input.acceptsMarketing,
      shippingAddress: input.address as Prisma.InputJsonValue,
      pickupPoint: pickup ? (input.pickupPoint as Prisma.InputJsonValue) : Prisma.DbNull,
      note: input.note || null,
    },
  });
  if (!confirmed.count) throw new CheckoutError("already_paid", "Cette commande est déjà payée.");
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
  /** Shipping address collected by Whop (express wallets). Wins over the form's. */
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
  const address =
    walletAddress ??
    (session.shippingAddress as Address | null) ??
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
