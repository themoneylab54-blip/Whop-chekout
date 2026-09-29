import "server-only";
import { db } from "./db";
import { moneyToCents } from "./whop";
import { toShopCents } from "./charge";
import { RetryLater } from "./retry-later";

/** Checkout charged in the buyer's currency: Whop amounts come in `currency`, converted back at `rate`. */
export type ChargeFx = { currency: string; rate: number };

export type PaymentTarget =
  | { kind: "session"; sessionId: string; currency: string; charge?: ChargeFx }
  | { kind: "extra"; sessionId: string; currency: string; charge?: ChargeFx }
  | { kind: "offer"; sessionId: string; chargeId: string; currency: string }
  /** An earlier attempt of a one-click offer (the charge was retried with a new payment). */
  | { kind: "offer_attempt"; sessionId: string; chargeId: string; currency: string };

/**
 * Which of this store's records a Whop payment belongs to: a checkout, a duplicate
 * payment of one, a one-click offer, or an earlier attempt of an offer. The payment's
 * own metadata (when the event carries it) is the fallback for offers: a charge still waiting
 * for its payment id adopts it; any other unknown payment of an offer throws RetryLater.
 */
export async function resolvePayment(storeId: string, paymentId: string, metadata?: Record<string, unknown> | null): Promise<PaymentTarget | null> {
  const session = await db.checkoutSession.findFirst({
    where: { storeId, OR: [{ whopPaymentId: paymentId }, { extraPaymentIds: { hasSome: extraKeys(paymentId) } }] },
    select: { id: true, whopPaymentId: true, currency: true, chargeCurrency: true, chargeFxRate: true },
  });
  if (session)
    return {
      kind: session.whopPaymentId === paymentId ? "session" : "extra",
      sessionId: session.id,
      currency: session.currency,
      ...(session.chargeCurrency && session.chargeFxRate ? { charge: { currency: session.chargeCurrency, rate: session.chargeFxRate } } : {}),
    };
  const upsellId = offerIdOf(metadata);
  const charge = await db.upsellCharge.findFirst({
    where: { session: { storeId }, OR: [{ whopPaymentId: paymentId }, { previousPaymentIds: { has: paymentId } }, ...(upsellId ? [{ id: upsellId }] : [])] },
    select: { id: true, sessionId: true, status: true, whopPaymentId: true, previousPaymentIds: true, session: { select: { currency: true } } },
  });
  if (!charge) return null;
  const target = { sessionId: charge.sessionId, chargeId: charge.id, currency: charge.session.currency };
  if (charge.whopPaymentId === paymentId) return { kind: "offer", ...target };
  // An earlier attempt of the offer (the charge was retried with a new payment).
  if (charge.previousPaymentIds.includes(paymentId)) return { kind: "offer_attempt", ...target };
  // Found by the payment's metadata only: the charge's answer from Whop was never recorded (timeout,
  // crash) — this payment is the current attempt's. Adopted atomically while the charge still waits
  // for it (PENDING, no payment id), so a refund or dispute arriving first lands on the offer itself.
  if (charge.whopPaymentId == null && charge.status === "PENDING") {
    const adopted = await db.upsellCharge.updateMany({ where: { id: charge.id, status: "PENDING", whopPaymentId: null }, data: { whopPaymentId: paymentId } });
    if (adopted.count) return { kind: "offer", ...target };
    const now = await db.upsellCharge.findUnique({ where: { id: charge.id }, select: { whopPaymentId: true, previousPaymentIds: true } });
    if (now?.whopPaymentId === paymentId) return { kind: "offer", ...target };
    if (now?.previousPaymentIds.includes(paymentId)) return { kind: "offer_attempt", ...target };
  }
  // Another payment than the one recorded, not a known earlier attempt: not attributable yet.
  throw new RetryLater(`paiement ${paymentId} de l'offre ${charge.id} pas encore enregistré`);
}

/** The one-click offer a payment's metadata names: Whop's `upsell_id`, Stripe's `upsell_charge_id`. Pure. */
export function offerIdOf(metadata: Record<string, unknown> | null | undefined): string | null {
  for (const key of ["upsell_id", "upsell_charge_id"]) {
    const v = metadata?.[key];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

/**
 * How a payment id can appear in CheckoutSession.extraPaymentIds: as is (Whop), and — for a Stripe
 * PaymentIntent — prefixed "stripe:" (see checkout.ts extraPaymentId). Pure.
 */
export function extraKeys(paymentId: string): string[] {
  return paymentId.startsWith("pi_") ? [paymentId, `stripe:${paymentId}`] : [paymentId];
}

/** The payment id of a refund/dispute event, whatever its shape (webhook: `payment.id`; list API: `payment_id`). */
export function eventPaymentId(data: Record<string, unknown>): string | null {
  if (typeof data.payment_id === "string" && data.payment_id) return data.payment_id;
  const p = data.payment as { id?: unknown } | null | undefined;
  return typeof p?.id === "string" && p.id ? p.id : null;
}

/** The payment's metadata when the event embeds the payment (webhook shape). */
export function eventPaymentMetadata(data: Record<string, unknown>): Record<string, unknown> | null {
  const p = data.payment as { metadata?: unknown } | null | undefined;
  return p && typeof p.metadata === "object" && p.metadata ? (p.metadata as Record<string, unknown>) : null;
}

/**
 * The refunded amount in the order's currency, or null when no amount in that
 * currency is available (a settlement-currency amount must never be mirrored as if
 * it were in the shop's currency). Handles the webhook shape (amount number + currency)
 * and the list shape (amount/original_amount money objects).
 */
export function refundAmountIn(currency: string, data: Record<string, unknown>, charge?: ChargeFx): number | null {
  return refundAmounts(currency, data, charge)?.cents ?? null;
}

/**
 * The refunded amount in the order's currency and, for an order charged in the buyer's currency,
 * in that currency too (`chargeCents`, the exact figure the refund ledger counts). The charged
 * currency is preferred there: it is what the buyer got back (a shop-currency figure next to it may
 * be Whop's settlement conversion); the shop amount is then converted at the paid quote's rate.
 */
export function refundAmounts(currency: string, data: Record<string, unknown>, charge?: ChargeFx): { cents: number; chargeCents: number | null } | null {
  if (charge && charge.currency.toUpperCase() !== currency.toUpperCase()) {
    const foreign = amountIn(charge.currency, data);
    if (foreign != null) return { cents: toShopCents(foreign, charge.rate), chargeCents: foreign };
  }
  const direct = amountIn(currency, data);
  return direct == null ? null : { cents: direct, chargeCents: null };
}

function amountIn(currency: string, data: Record<string, unknown>): number | null {
  const want = currency.toUpperCase();
  const candidates: { amount: unknown; currency: unknown }[] = [];
  if (typeof data.amount === "number" || typeof data.amount === "string") candidates.push({ amount: data.amount, currency: data.currency });
  for (const key of ["amount", "original_amount"]) {
    const m = data[key] as { amount?: unknown; currency?: unknown } | null | undefined;
    if (m && typeof m === "object") candidates.push({ amount: m.amount, currency: m.currency });
  }
  for (const c of candidates) {
    if (typeof c.currency === "string" && c.currency.toUpperCase() === want) {
      const cents = moneyToCents(c.amount);
      if (cents != null) return cents;
    }
  }
  return null;
}

/**
 * Who a Whop payment belongs to, judged from our own database. A Whop account can back
 * several stores and its webhooks and lists are account-wide, so every store sees the
 * others' payments, refunds and disputes:
 *  - "ours": recorded here, or its metadata names one of this store's checkouts/offers,
 *    or it was made on this store's Whop product;
 *  - "sibling": the same, for another store of this app (handled there: stay quiet);
 *  - "foreign": another product of the account, not a store of this app;
 *  - "unknown": nothing to decide on (e.g. no metadata nor product in the event).
 */
export type PaymentOwner = { kind: "ours" } | { kind: "sibling"; storeId: string } | { kind: "foreign" } | { kind: "unknown" };

export async function paymentOwner(
  storeId: string,
  p: { paymentId?: string | null; metadata?: Record<string, unknown> | null; productId?: string | null },
): Promise<PaymentOwner> {
  const decide = (owner: string | null | undefined): PaymentOwner | null => (owner ? (owner === storeId ? { kind: "ours" } : { kind: "sibling", storeId: owner }) : null);
  if (p.paymentId) {
    const session = await db.checkoutSession.findFirst({
      where: {
        OR: [
          { whopPaymentId: p.paymentId },
          { extraPaymentIds: { hasSome: extraKeys(p.paymentId) } },
          // A Stripe PaymentIntent created for a checkout (paid or not yet).
          ...(p.paymentId.startsWith("pi_") ? [{ stripePaymentIntentId: p.paymentId }, { quotes: { some: { stripePaymentIntentId: p.paymentId } } }] : []),
        ],
      },
      select: { storeId: true },
    });
    const bySession = decide(session?.storeId);
    if (bySession) return bySession;
    const charge = await db.upsellCharge.findFirst({
      where: { OR: [{ whopPaymentId: p.paymentId }, { previousPaymentIds: { has: p.paymentId } }] },
      select: { session: { select: { storeId: true } } },
    });
    const byCharge = decide(charge?.session.storeId);
    if (byCharge) return byCharge;
  }
  const upsellId = offerIdOf(p.metadata);
  if (upsellId) {
    const charge = await db.upsellCharge.findUnique({ where: { id: upsellId }, select: { session: { select: { storeId: true } } } });
    const owner = decide(charge?.session.storeId);
    if (owner) return owner;
  }
  const sessionId = typeof p.metadata?.checkout_session_id === "string" ? p.metadata.checkout_session_id : null;
  if (sessionId) {
    const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, select: { storeId: true } });
    const owner = decide(session?.storeId);
    if (owner) return owner;
  }
  if (p.productId) {
    const stores = await db.store.findMany({ where: { whopProductId: p.productId }, select: { id: true } });
    if (stores.some((s) => s.id === storeId)) return { kind: "ours" };
    return stores.length ? { kind: "sibling", storeId: stores[0].id } : { kind: "foreign" };
  }
  return { kind: "unknown" };
}

/** The product a Whop payment (or an event embedding one) was made on, when present. */
export function eventProductId(data: Record<string, unknown>): string | null {
  if (typeof data.product_id === "string" && data.product_id) return data.product_id;
  const p = data.payment as { product_id?: unknown; product?: { id?: unknown } | null } | null | undefined;
  if (typeof p?.product_id === "string" && p.product_id) return p.product_id;
  if (typeof p?.product?.id === "string" && p.product.id) return p.product.id;
  const prod = data.product as { id?: unknown } | null | undefined;
  return typeof prod?.id === "string" && prod.id ? prod.id : null;
}
