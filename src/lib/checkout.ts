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
    if (!discountRow) discountError = "Code promo invalide";
    else {
      const sub = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
      const check = checkDiscount(discountRow, sub);
      if (check.ok) discount = discountRow;
      else discountError = check.reason;
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

function assertPayable(session: SessionWithStore, quote: Quote, input: QuoteInput) {
  if (session.status === "PAID") throw new CheckoutError("Cette commande est déjà payée");
  const lines = session.lines as unknown as CartLine[];
  if (lines.length === 0) throw new CheckoutError("Votre panier est vide");
  if (input.discountCode && quote.discountError) throw new CheckoutError(quote.discountError);
  if (lines.some((l) => l.requiresShipping) && !quote.shippingRateId) {
    throw new CheckoutError("Nous ne livrons pas encore dans ce pays");
  }
  if (quote.totals.totalCents < 50) throw new CheckoutError("Montant minimum non atteint");
}

/**
 * Freezes the current quote on the session and returns a Whop checkout configuration
 * for exactly that total. Called when the page opens and whenever the total changes;
 * reuses the existing configuration when nothing that affects the price moved.
 */
export async function prepareSession(session: SessionWithStore, input: QuoteInput) {
  const quote = await quoteSession(session, input);
  assertPayable(session, quote, input);
  const total = quote.totals.totalCents;

  let checkoutConfigurationId = session.whopCheckoutId;
  if (!checkoutConfigurationId || session.preparedTotalCents !== total) {
    const whop = await createCheckoutConfiguration(session.store, {
      sessionId: session.id,
      storeId: session.storeId,
      totalCents: total,
      currency: session.currency,
      title: `Commande ${session.store.name}`,
      redirectUrl: `${env.appUrl}/c/${session.id}/merci`,
    });
    checkoutConfigurationId = whop.id;
  }

  await db.checkoutSession.update({
    where: { id: session.id },
    data: {
      shippingRateId: quote.shippingRateId,
      discountCode: quote.discount?.code ?? null,
      addOnIds: quote.addOnIds,
      subtotalCents: quote.totals.subtotalCents,
      discountCents: quote.totals.discountCents,
      shippingCents: quote.totals.shippingCents,
      addOnsCents: quote.totals.addOnsCents,
      totalCents: total,
      preparedTotalCents: total,
      whopCheckoutId: checkoutConfigurationId,
    },
  });
  return { checkoutConfigurationId, totals: quote.totals, quote };
}

/**
 * Saves the buyer's details right before the embedded Whop form is submitted.
 * If the total no longer matches the prepared checkout, returns a fresh one instead
 * so the buyer is never charged a stale amount.
 */
export async function confirmSession(session: SessionWithStore, input: PayInput) {
  const quoteInput = { ...input, countryCode: input.address.countryCode };
  const quote = await quoteSession(session, quoteInput);
  assertPayable(session, quote, quoteInput);

  if (!session.whopCheckoutId || session.preparedTotalCents !== quote.totals.totalCents) {
    const prepared = await prepareSession(session, quoteInput);
    return { ready: false as const, checkoutConfigurationId: prepared.checkoutConfigurationId, totals: prepared.totals };
  }

  await db.checkoutSession.update({
    where: { id: session.id },
    data: {
      status: "PAYING",
      email: input.email,
      acceptsMarketing: input.acceptsMarketing,
      shippingAddress: input.address as Prisma.InputJsonValue,
    },
  });
  return { ready: true as const, checkoutConfigurationId: session.whopCheckoutId, totals: quote.totals };
}

/* ------------------------------------------------------------------ */
/* Webhook handlers                                                    */
/* ------------------------------------------------------------------ */

/** Marks the session paid and creates the Shopify order. Safe to call repeatedly. */
export type PaymentBuyer = {
  email: string | null;
  address: {
    name: string | null;
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    country: string | null;
  } | null;
  phone: string | null;
};

/** Express wallets (Apple Pay, Google Pay) pay without our form: take the buyer from the payment. */
export function addressFromPayment(buyer: PaymentBuyer): Address | null {
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

export async function markPaid(
  sessionId: string,
  payment: { id: string; totalCents: number | null; currency: string | null; buyer?: PaymentBuyer },
) {
  let session = await db.checkoutSession.findUnique({ where: { id: sessionId } });
  if (!session) throw new Error(`Session ${sessionId} introuvable`);
  if (payment.buyer && (!session.email || !session.shippingAddress)) {
    const address = session.shippingAddress ? null : addressFromPayment(payment.buyer);
    session = await db.checkoutSession.update({
      where: { id: sessionId },
      data: {
        ...(!session.email && payment.buyer.email ? { email: payment.buyer.email } : {}),
        ...(address ? { shippingAddress: address as Prisma.InputJsonValue } : {}),
      },
    });
  }
  const sameCurrency = payment.currency?.toUpperCase() === session.currency.toUpperCase();
  if (sameCurrency && payment.totalCents != null && payment.totalCents < session.totalCents) {
    // Never create a paid order for less than the frozen total.
    await db.checkoutSession.update({
      where: { id: sessionId },
      data: { syncError: `Montant payé (${payment.totalCents}) inférieur au total (${session.totalCents})`, whopPaymentId: payment.id },
    });
    return;
  }
  const transition = await db.checkoutSession.updateMany({
    where: { id: sessionId, status: { not: "PAID" } },
    data: { status: "PAID", paidAt: new Date(), whopPaymentId: payment.id, syncError: null },
  });
  if (transition.count === 1 && session.discountCode) {
    await db.discountCode.updateMany({
      where: { storeId: session.storeId, code: session.discountCode },
      data: { usageCount: { increment: 1 } },
    });
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
    const [rate, addOns] = await Promise.all([
      session.shippingRateId ? db.shippingRate.findUnique({ where: { id: session.shippingRateId } }) : null,
      db.addOn.findMany({ where: { id: { in: session.addOnIds } } }),
    ]);
    const discount = session.discountCode
      ? await db.discountCode.findFirst({ where: { storeId: session.storeId, code: session.discountCode } })
      : null;
    const order = await createPaidOrder(session.store, {
      sessionId: session.id,
      currency: session.currency,
      email: session.email ?? "",
      acceptsMarketing: session.acceptsMarketing,
      shippingAddress: session.shippingAddress as Address | null,
      lines: session.lines as unknown as CartLine[],
      addOns: addOns.map((a) => ({ title: a.title, priceCents: a.priceCents, variantId: a.variantId })),
      discount: session.discountCode
        ? {
            code: session.discountCode,
            amountCents: session.discountCents,
            freeShipping: discount?.type === "FREE_SHIPPING",
          }
        : null,
      shipping: rate ? { title: rate.name, priceCents: session.shippingCents } : null,
      totalCents: session.totalCents,
      whopPaymentId: session.whopPaymentId ?? "",
      test: session.store.testMode,
    });
    await db.checkoutSession.update({
      where: { id: sessionId },
      data: { shopifyOrderId: order.id, shopifyOrderName: order.name, syncError: null, syncStartedAt: null },
    });
  } catch (err) {
    await db.checkoutSession.update({
      where: { id: sessionId },
      data: { syncError: err instanceof Error ? err.message.slice(0, 1000) : String(err), syncStartedAt: null },
    });
    throw err;
  }
}

export async function recordRefund(sessionId: string, refundedCents: number) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session) return;
  const delta = refundedCents - session.refundedCents;
  if (delta <= 0) return;
  await db.checkoutSession.update({ where: { id: sessionId }, data: { refundedCents } });
  if (session.shopifyOrderId) {
    await createRefund(session.store, session.shopifyOrderId, delta, "Remboursé via Whop");
  }
}

export async function recordDispute(sessionId: string) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session || session.disputed) return;
  await db.checkoutSession.update({ where: { id: sessionId }, data: { disputed: true } });
  if (session.shopifyOrderId) await tagOrder(session.store, session.shopifyOrderId, ["litige-whop"]);
}
