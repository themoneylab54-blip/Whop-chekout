import "server-only";
import { z } from "zod";
import type { CheckoutSession, Prisma, Store } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import {
  checkDiscount,
  computeTotals,
  ratesForCountry,
  type CartLine,
  type DiscountInput,
  type RateInput,
  type Totals,
} from "./pricing";
import { createPaidOrder, createRefund, tagOrder, type Address } from "./shopify";
import { createCheckoutConfiguration } from "./whop";

/* ------------------------------------------------------------------ */
/* Input validation                                                    */
/* ------------------------------------------------------------------ */

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
  shippingRateId: z.string().max(40).nullable().optional(),
  discountCode: z.string().trim().max(60).nullable().optional(),
  addOnIds: z.array(z.string().max(40)).max(20).default([]),
});
export type QuoteInput = z.infer<typeof quoteSchema>;

export const paySchema = quoteSchema.extend({
  email: z.string().trim().email().max(200),
  acceptsMarketing: z.boolean().default(false),
  address: addressSchema,
  note: z.string().trim().max(1000).nullable().optional(),
  /** The Whop checkout the page is about to submit. */
  checkoutConfigurationId: z.string().max(100).nullable().optional(),
});
export type PayInput = z.infer<typeof paySchema>;

/* ------------------------------------------------------------------ */
/* Quote                                                               */
/* ------------------------------------------------------------------ */

export type Quote = {
  totals: Totals;
  rates: (RateInput & { effectiveCents: number })[];
  shippingRateId: string | null;
  discount: { code: string; type: DiscountInput["type"] } | null;
  discountError: string | null;
  addOnIds: string[];
};

type SessionWithStore = CheckoutSession & { store: Store };

export async function quoteSession(session: SessionWithStore, input: QuoteInput): Promise<Quote> {
  const lines = session.lines as unknown as CartLine[];
  const [allRates, addOns, discountRow] = await Promise.all([
    db.shippingRate.findMany({ where: { storeId: session.storeId }, orderBy: { position: "asc" } }),
    db.addOn.findMany({ where: { storeId: session.storeId, active: true, id: { in: input.addOnIds } } }),
    input.discountCode
      ? db.discountCode.findFirst({
          where: { storeId: session.storeId, code: { equals: input.discountCode, mode: "insensitive" } },
        })
      : null,
  ]);

  const rates = ratesForCountry(allRates, input.countryCode ?? null);
  const rate = rates.find((r) => r.id === input.shippingRateId) ?? rates[0] ?? null;

  let discount: DiscountInput | null = null;
  let discountError: string | null = null;
  if (input.discountCode) {
    // One message for unknown, inactive, expired or used-up codes: don't help guess private codes.
    const invalid = "Code promo invalide ou expiré";
    if (!discountRow) discountError = invalid;
    else {
      const sub = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
      const check = checkDiscount(discountRow, sub);
      if (check.ok) discount = discountRow;
      else discountError = check.reason.includes("minimum") ? check.reason : invalid;
    }
  }

  const totals = computeTotals({ lines, rate, discount, addOns });
  const discountedSub = totals.subtotalCents - totals.discountCents;
  return {
    totals,
    rates: rates.map((r) => ({
      ...r,
      effectiveCents:
        discount?.type === "FREE_SHIPPING" || (r.freeOverCents != null && discountedSub >= r.freeOverCents) ? 0 : r.priceCents,
    })),
    shippingRateId: rate?.id ?? null,
    discount: discount ? { code: discount.code, type: discount.type } : null,
    discountError,
    addOnIds: addOns.map((a) => a.id),
  };
}

/* ------------------------------------------------------------------ */
/* One-page checkout: prepare the Whop checkout, then confirm & pay    */
/* ------------------------------------------------------------------ */

export class CheckoutError extends Error {}

/** A checkout session can be paid for this long after the cart left the store. */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Upper bound on Whop configurations per session (each price change creates one). */
const MAX_QUOTES_PER_SESSION = 60;

function assertPayable(session: SessionWithStore, quote: Quote, input: QuoteInput) {
  if (session.status === "PAID") throw new CheckoutError("Cette commande est déjà payée");
  if (Date.now() - session.createdAt.getTime() > SESSION_TTL_MS) {
    throw new CheckoutError("Cette page de paiement a expiré. Retournez au panier pour recommencer.");
  }
  const lines = session.lines as unknown as CartLine[];
  if (lines.length === 0) throw new CheckoutError("Votre panier est vide");
  if (input.discountCode && quote.discountError) throw new CheckoutError(quote.discountError);
  if (lines.some((l) => l.requiresShipping) && !quote.shippingRateId) {
    throw new CheckoutError("Nous ne livrons pas encore dans ce pays");
  }
  if (quote.totals.totalCents < 50) throw new CheckoutError("Montant minimum non atteint");
}

/** Everything that changes what the buyer pays or receives. Same fingerprint = same Whop checkout. */
export function quoteFingerprint(quote: Pick<Quote, "totals" | "shippingRateId" | "discount" | "addOnIds">): string {
  const t = quote.totals;
  return [
    t.totalCents,
    t.subtotalCents,
    t.discountCents,
    t.shippingCents,
    t.addOnsCents,
    quote.shippingRateId ?? "",
    quote.discount?.code.toUpperCase() ?? "",
    [...quote.addOnIds].sort().join(","),
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
    const count = await db.checkoutQuote.count({ where: { sessionId: session.id } });
    if (count >= MAX_QUOTES_PER_SESSION) {
      throw new CheckoutError("Trop de modifications sur cette commande. Retournez au panier pour recommencer.");
    }
    const [rate, addOns] = await Promise.all([
      quote.shippingRateId ? db.shippingRate.findUnique({ where: { id: quote.shippingRateId } }) : null,
      db.addOn.findMany({ where: { id: { in: quote.addOnIds } } }),
    ]);
    const whop = await createCheckoutConfiguration(session.store, {
      sessionId: session.id,
      storeId: session.storeId,
      totalCents: quote.totals.totalCents,
      currency: session.currency,
      title: `Commande ${session.store.name}`,
      redirectUrl: `${env.appUrl}/c/${session.id}/merci`,
    });
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
        shippingCountries: rate?.countries ?? [],
        discountCode: quote.discount?.code ?? null,
        discountFreeShipping: quote.discount?.type === "FREE_SHIPPING",
        addOns: addOns.map((a) => ({ id: a.id, title: a.title, priceCents: a.priceCents, variantId: a.variantId })),
        addOnIds: addOns.map((a) => a.id),
      },
    });
  }

  await db.checkoutSession.update({
    where: { id: session.id },
    data: {
      ...quoteFields(quote),
      preparedTotalCents: quote.totals.totalCents,
      whopCheckoutId: snapshot.whopCheckoutId,
    },
  });
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

  const configId = input.checkoutConfigurationId ?? session.whopCheckoutId;
  const snapshot = configId
    ? await db.checkoutQuote.findUnique({ where: { whopCheckoutId: configId } })
    : null;
  if (!snapshot || snapshot.sessionId !== session.id || snapshot.fingerprint !== quoteFingerprint(quote)) {
    const prepared = await prepareSession(session, quoteInput);
    return { ready: false as const, checkoutConfigurationId: prepared.checkoutConfigurationId, totals: prepared.totals };
  }

  await db.checkoutSession.update({
    where: { id: session.id },
    data: {
      ...quoteFields(quote),
      whopCheckoutId: snapshot.whopCheckoutId,
      preparedTotalCents: snapshot.totalCents,
      status: "PAYING",
      email: input.email,
      acceptsMarketing: input.acceptsMarketing,
      shippingAddress: input.address as Prisma.InputJsonValue,
      note: input.note || null,
    },
  });
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
  totalCents: number | null;
  currency: string | null;
  checkoutConfigurationId?: string | null;
  buyer?: PaymentBuyer;
};

/** Reasons a paid order must be looked at by a human before it goes to Shopify. */
export function reviewReasons(
  snapshot: { totalCents: number; currency: string; shippingCountries: string[]; shippingRateId: string | null },
  payment: Pick<PaymentInfo, "totalCents" | "currency">,
  address: Address | null,
): string[] {
  const reasons: string[] = [];
  if (payment.totalCents == null || !payment.currency) {
    reasons.push("montant ou devise du paiement illisible");
  } else if (payment.currency.toUpperCase() === snapshot.currency.toUpperCase() && payment.totalCents < snapshot.totalCents) {
    reasons.push(`montant payé (${payment.totalCents}) inférieur au total (${snapshot.totalCents})`);
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

/** Marks the session paid and creates the Shopify order. Safe to call repeatedly. */
export async function markPaid(sessionId: string, payment: PaymentInfo) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error(`Session ${sessionId} introuvable`);

  if (session.status === "PAID") {
    if (session.whopPaymentId && session.whopPaymentId !== payment.id) {
      // A second payment for the same cart (e.g. wallet + card): keep the first, flag the extra one.
      const note = `Paiement supplémentaire ${payment.id} reçu pour ce panier — à rembourser dans Whop.`;
      if (!session.reviewNote?.includes(payment.id)) {
        await db.checkoutSession.update({
          where: { id: sessionId },
          data: { reviewNote: session.reviewNote ? `${session.reviewNote}\n${note}` : note },
        });
      }
      return;
    }
    if (!session.reviewNote) await syncOrder(sessionId);
    return;
  }

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

  const reasons = reviewReasons(
    paid ?? {
      totalCents: session.totalCents,
      currency: session.currency,
      shippingCountries: [],
      shippingRateId: null,
    },
    payment,
    address,
  );
  if (!paid) reasons.push("configuration de paiement inconnue");

  const transition = await db.checkoutSession.updateMany({
    where: { id: sessionId, status: { not: "PAID" } },
    data: {
      status: "PAID",
      paidAt: new Date(),
      whopPaymentId: payment.id,
      syncError: null,
      email: session.email ?? payment.buyer?.email ?? null,
      ...(address ? { shippingAddress: address as Prisma.InputJsonValue } : {}),
      ...(paid
        ? {
            paidQuoteId: paid.id,
            whopCheckoutId: paid.whopCheckoutId,
            shippingRateId: paid.shippingRateId,
            discountCode: paid.discountCode,
            addOnIds: paid.addOnIds,
            subtotalCents: paid.subtotalCents,
            discountCents: paid.discountCents,
            shippingCents: paid.shippingCents,
            addOnsCents: paid.addOnsCents,
            totalCents: paid.totalCents,
          }
        : {}),
    },
  });
  if (transition.count === 0) return markPaid(sessionId, payment); // lost a race: re-run as "already paid"

  if (paid?.discountCode) {
    // Atomic: a code with one use left can't be consumed twice.
    const used = await db.$executeRaw`
      UPDATE "DiscountCode" SET "usageCount" = "usageCount" + 1
      WHERE "storeId" = ${session.storeId} AND "code" = ${paid.discountCode}
        AND ("usageLimit" IS NULL OR "usageCount" < "usageLimit")`;
    if (used === 0) reasons.push(`code promo ${paid.discountCode} déjà épuisé au moment du paiement`);
  }

  if (reasons.length) {
    await db.checkoutSession.update({
      where: { id: sessionId },
      data: { reviewNote: `À vérifier : ${reasons.join(" ; ")}. Remboursez dans Whop ou synchronisez la commande manuellement.` },
    });
    return;
  }
  await syncOrder(sessionId);
}

/** Creates the Shopify order for a paid session if it doesn't exist yet. */
export async function syncOrder(sessionId: string) {
  // Take a short lease so concurrent webhook retries can't double-create the order.
  const leaseExpired = new Date(Date.now() - 2 * 60 * 1000);
  const claim = await db.checkoutSession.updateMany({
    where: {
      id: sessionId,
      status: "PAID",
      shopifyOrderId: null,
      OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: leaseExpired } }],
    },
    data: { syncStartedAt: new Date() },
  });
  if (claim.count === 0) return;

  const session = await db.checkoutSession.findUniqueOrThrow({ where: { id: sessionId }, include: { store: true } });
  try {
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
        session.discountCode
          ? db.discountCode.findFirst({ where: { storeId: session.storeId, code: session.discountCode } })
          : null,
      ]);
      addOns = liveAddOns.map((a) => ({ title: a.title, priceCents: a.priceCents, variantId: a.variantId }));
      shipping = session.shippingRateId ? { title: rate?.name ?? "Livraison", priceCents: session.shippingCents } : null;
      freeShipping = discount?.type === "FREE_SHIPPING";
    }
    const order = await createPaidOrder(session.store, {
      sessionId: session.id,
      currency: session.currency,
      email: session.email ?? "",
      acceptsMarketing: session.acceptsMarketing,
      buyerNote: session.note,
      shippingAddress: session.shippingAddress as Address | null,
      lines: session.lines as unknown as CartLine[],
      addOns,
      discount: session.discountCode
        ? { code: session.discountCode, amountCents: session.discountCents, freeShipping }
        : null,
      shipping,
      totalCents: session.totalCents,
      whopPaymentId: session.whopPaymentId ?? "",
      test: session.store.testMode,
    });
    await db.checkoutSession.update({
      where: { id: sessionId },
      data: { shopifyOrderId: order.id, shopifyOrderName: order.name, syncError: null, syncStartedAt: null },
    });
    // Refunds or disputes that arrived before the order existed.
    try {
      if (session.refundedCents > 0) {
        await createRefund(session.store, order.id, session.refundedCents, "Remboursé via Whop");
      }
      if (session.disputed) await tagOrder(session.store, order.id, ["litige-whop"]);
    } catch (err) {
      console.error("replaying refund/dispute on new order failed", err);
    }
  } catch (err) {
    await db.checkoutSession.update({
      where: { id: sessionId },
      data: { syncError: err instanceof Error ? err.message.slice(0, 1000) : String(err), syncStartedAt: null },
    });
    throw err;
  }
}

/**
 * Applies one Whop refund. Called once per refund id (the webhook holds a marker),
 * so it adds `amountCents` rather than recomputing a delta.
 */
export async function recordRefund(sessionId: string, amountCents: number) {
  if (amountCents <= 0) return;
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session) return;
  // Mirror to Shopify first: if that fails the webhook is retried and nothing was counted yet.
  if (session.shopifyOrderId) {
    await createRefund(session.store, session.shopifyOrderId, amountCents, "Remboursé via Whop");
  }
  await db.checkoutSession.update({ where: { id: sessionId }, data: { refundedCents: { increment: amountCents } } });
}

export async function recordDispute(sessionId: string) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session || session.disputed) return;
  await db.checkoutSession.update({ where: { id: sessionId }, data: { disputed: true } });
  if (session.shopifyOrderId) await tagOrder(session.store, session.shopifyOrderId, ["litige-whop"]);
}
