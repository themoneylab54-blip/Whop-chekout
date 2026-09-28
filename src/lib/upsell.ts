import "server-only";
import { Prisma, type CheckoutSession, type Store } from "@prisma/client";
import { db } from "./db";
import { loadThankYouLayout, type BlockOf } from "./layout";
import { sendUpsellConversions } from "./conversions";
import { submitDisputeEvidence } from "./disputes";
import { designFor } from "./experiments";
import { SYNC_BACKOFF_MINUTES } from "./checkout";
import { log, recordEvent } from "./log";
import { createPaidOrder, createRefund, findOrderForSession, priceCart, tagOrder, type Address } from "./shopify";
import { centsToDecimal } from "./pricing";
import { statementDescriptor, storeClient } from "./whop";

/*
 * One-click post-purchase offer. The checkout saves the buyer's payment method
 * (setupFutureUsage "off_session"); the thank-you page offers one product and, on
 * "Yes", charges that saved method through Whop — no card to type again. A paid
 * offer becomes its own Shopify order, linked to the first one.
 */

/** How long after payment the offer can be accepted. */
export const UPSELL_WINDOW_MS = 60 * 60 * 1000;

type SessionWithStore = CheckoutSession & { store: Store };
export type UpsellBlock = BlockOf<"upsell">;

/** Upsell blocks that are actually sellable (a variant and a price are set). */
export function activeUpsells(store: Pick<Store, "thankYouLayout">): UpsellBlock[] {
  return loadThankYouLayout(store.thankYouLayout).blocks.filter(
    (b): b is UpsellBlock => b.type === "upsell" && !b.hidden && !!b.props.variantId.trim() && b.props.price > 0,
  );
}

export function upsellEligible(session: CheckoutSession, now = Date.now()) {
  return (
    session.status === "PAID" &&
    !!session.whopMemberId &&
    !!session.whopPaymentMethodId &&
    !!session.paidAt &&
    now - session.paidAt.getTime() < UPSELL_WINDOW_MS
  );
}

export class UpsellError extends Error {}

export type UpsellResult =
  | { status: "paid"; orderName: string | null }
  | { status: "action"; url: string }
  | { status: "pending" }
  | { status: "declined" };

export async function declineUpsell(session: SessionWithStore, blockId: string) {
  const design = await designFor(session.store, session);
  const block = activeUpsells({ thankYouLayout: design.thankYouLayout }).find((b) => b.id === blockId);
  if (!block) throw new UpsellError("Offre introuvable");
  await db.upsellCharge
    .create({
      data: {
        sessionId: session.id,
        blockId,
        title: block.props.title,
        variantId: block.props.variantId,
        amountCents: Math.round(block.props.price * 100),
        status: "DECLINED",
      },
    })
    .catch((err) => {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    });
  return { status: "declined" as const };
}

export async function acceptUpsell(session: SessionWithStore, blockId: string): Promise<UpsellResult> {
  if (!upsellEligible(session)) throw new UpsellError("Cette offre n'est plus disponible");
  const store = session.store;
  const design = await designFor(store, session);
  const block = activeUpsells({ thankYouLayout: design.thankYouLayout }).find((b) => b.id === blockId);
  if (!block) throw new UpsellError("Offre introuvable");
  if (!store.whopAccountId || !store.whopProductId) throw new UpsellError("Paiement indisponible");

  const [line] = await priceCart(store, [{ variantId: block.props.variantId, quantity: 1 }]);
  if (!line) throw new UpsellError("Ce produit n'est plus disponible");
  const amountCents = Math.round(block.props.price * 100);

  // One charge per offer and session: a double click can't charge twice.
  let charge;
  try {
    charge = await db.upsellCharge.create({
      data: { sessionId: session.id, blockId, title: line.title, variantId: line.variantId, productId: line.productId, amountCents },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const existing = await db.upsellCharge.findUniqueOrThrow({ where: { sessionId_blockId: { sessionId: session.id, blockId } } });
    if (existing.status === "PAID") return { status: "paid", orderName: existing.shopifyOrderName };
    if (existing.status === "DECLINED") throw new UpsellError("Offre déjà refusée");
    if (existing.status === "PENDING") return { status: "pending" };
    // FAILED: a new attempt, with a new idempotency key.
    const retried = await db.upsellCharge.updateMany({
      where: { id: existing.id, status: "FAILED" },
      data: { status: "PENDING", error: null, whopPaymentId: null, chargeAttempts: { increment: 1 } },
    });
    if (retried.count === 0) return { status: "pending" };
    charge = await db.upsellCharge.findUniqueOrThrow({ where: { id: existing.id } });
  }
  return chargeWhop(session, charge);
}

type Charge = Awaited<ReturnType<typeof db.upsellCharge.findUniqueOrThrow>>;

/** Whop answered with a client error: nothing was charged. Anything else (timeout, 5xx) is uncertain. */
function definitelyRejected(err: unknown) {
  const status = (err as { statusCode?: number }).statusCode;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 409 && status !== 429;
}

/**
 * Charges the saved payment method. The Idempotency-Key is fixed per attempt, so the
 * SDK's automatic retries and the background sweep's replay can never charge twice.
 */
async function chargeWhop(session: SessionWithStore, charge: Charge): Promise<UpsellResult> {
  const store = session.store;
  const a = session.shippingAddress as Address | null;
  let payment;
  try {
    payment = await storeClient(store).payments.create(
      {
        account_id: store.whopAccountId!,
        member_id: session.whopMemberId,
        payment_method_id: session.whopPaymentMethodId,
        plan: {
          product_id: store.whopProductId!,
          plan_type: "one_time",
          currency: session.currency.toLowerCase() as "eur",
          initial_price: Number(centsToDecimal(charge.amountCents)),
          force_create_new_plan: true,
          visibility: "hidden",
          title: `Offre : ${charge.title}`.slice(0, 80),
        },
        metadata: { checkout_session_id: session.id, upsell_id: charge.id },
        statement_descriptor: statementDescriptor(store.statementDescriptor || store.name) ?? undefined,
        shipping_address: a
          ? {
              name: `${a.firstName} ${a.lastName}`.trim(),
              line1: a.address1,
              line2: a.address2 ?? null,
              city: a.city,
              state: a.province ?? null,
              postal_code: a.zip,
              country: a.countryCode,
            }
          : undefined,
      },
      { idempotencyKey: `upsell_${charge.id}_${charge.chargeAttempts}` },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (definitelyRejected(err)) {
      await db.upsellCharge.update({ where: { id: charge.id }, data: { status: "FAILED", error: message.slice(0, 500) } });
      await recordEvent({ storeId: store.id, sessionId: session.id, level: "warn", kind: "upsell.failed", message: `Offre post-achat refusée par Whop : ${message}` });
      throw new UpsellError("Le paiement n'a pas pu être effectué. Aucun montant n'a été débité.");
    }
    // Unknown outcome: stay PENDING; the sweep replays the same key to learn the result.
    await db.upsellCharge.update({ where: { id: charge.id }, data: { error: message.slice(0, 500) } });
    await recordEvent({ storeId: store.id, sessionId: session.id, level: "warn", kind: "upsell.uncertain", message: `Réponse de Whop incertaine pour une offre post-achat (${message}) : vérification automatique en cours.` });
    return { status: "pending" };
  }
  return applyPayment(charge.id, store.id, payment);
}

async function applyPayment(chargeId: string, storeId: string, payment: { id: string; status: string; recovery_url?: string | null }): Promise<UpsellResult> {
  await db.upsellCharge.update({ where: { id: chargeId }, data: { whopPaymentId: payment.id } });
  if (payment.status === "paid") {
    const done = await markUpsellPaid(chargeId, payment.id, storeId);
    return { status: "paid", orderName: done?.shopifyOrderName ?? null };
  }
  if (["void", "uncollectible"].includes(payment.status)) {
    await markUpsellFailed(chargeId, storeId, `Paiement ${payment.status}`, payment.id);
    throw new UpsellError("Le paiement a été refusé. Aucun montant n'a été débité.");
  }
  // 3-D Secure or similar: the buyer confirms on Whop, the webhook (or the sweep) finishes the job.
  if (payment.recovery_url) return { status: "action", url: payment.recovery_url };
  return { status: "pending" };
}

/**
 * Resolves offers stuck in PENDING (lost webhook, crash, timeout): asks Whop for the
 * payment, or replays the same idempotent request when we never learned its id.
 */
export async function sweepPendingUpsells(deadline: number): Promise<number> {
  const stuck = await db.upsellCharge.findMany({
    where: { status: "PENDING", createdAt: { lt: new Date(Date.now() - 5 * 60_000) } },
    include: { session: { include: { store: true } } },
    take: 20,
    orderBy: { createdAt: "asc" },
  });
  let resolved = 0;
  for (const c of stuck) {
    if (Date.now() > deadline) break;
    const storeId = c.session.storeId;
    try {
      if (c.whopPaymentId) {
        const p = await storeClient(c.session.store).payments.retrieve({ id: c.whopPaymentId });
        if (p.status === "paid") await markUpsellPaid(c.id, p.id, storeId);
        else if (["void", "uncollectible"].includes(p.status)) await markUpsellFailed(c.id, storeId, `Paiement ${p.status}`, p.id);
        else if (Date.now() - c.createdAt.getTime() > 24 * 3600_000) await markUpsellFailed(c.id, storeId, "Jamais confirmé par le client", p.id);
        else continue;
      } else if (Date.now() - c.createdAt.getTime() < 23 * 3600_000) {
        // Same key as the original request: Whop returns the original result, no new charge.
        await chargeWhop(c.session, c).catch(() => undefined);
      } else {
        await db.upsellCharge.update({ where: { id: c.id }, data: { status: "FAILED", error: "Issue inconnue" } });
        await recordEvent({
          storeId,
          sessionId: c.sessionId,
          level: "error",
          kind: "upsell.gave_up",
          message: `Offre post-achat « ${c.title} » : impossible de savoir si le client a été débité. Vérifiez dans Whop.`,
          alert: true,
        });
      }
      resolved++;
    } catch (err) {
      log.warn("upsell.sweep_failed", "Could not resolve a pending upsell", { chargeId: c.id, err });
    }
  }
  return resolved;
}

/** Marks an offer paid and creates its Shopify order. Idempotent (webhook + direct call). */
export async function markUpsellPaid(chargeId: string, paymentId: string, storeId: string) {
  const found = await db.upsellCharge.findUnique({ where: { id: chargeId }, include: { session: { include: { store: true } } } });
  if (!found || found.session.storeId !== storeId) return null;
  await db.upsellCharge.updateMany({ where: { id: chargeId, status: { not: "PAID" } }, data: { status: "PAID", whopPaymentId: paymentId } });
  if (found.shopifyOrderId) return found;

  // Lease: the webhook, the direct accept and the tick can race; only one creates the order.
  const claim = await db.upsellCharge.updateMany({
    where: {
      id: chargeId,
      shopifyOrderId: null,
      OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(Date.now() - 2 * 60_000) } }],
    },
    data: { syncStartedAt: new Date() },
  });
  if (claim.count === 0) return db.upsellCharge.findUnique({ where: { id: chargeId } });
  const charge = found;

  const session = charge.session;
  const ref = `upsell-${charge.id}`;
  try {
    // A failed lookup must not lead to creating the order (it may already exist): retry later.
    const existing = await findOrderForSession(session.store, ref);
    const [line] = await priceCart(session.store, [{ variantId: charge.variantId, quantity: 1 }]);
    const order =
      existing ??
      (await createPaidOrder(session.store, {
        sessionId: ref,
        currency: session.currency,
        email: session.email ?? "",
        acceptsMarketing: session.acceptsMarketing,
        buyerNote: `Offre post-achat acceptée — liée à ${session.shopifyOrderName ?? session.id}`,
        shippingAddress: session.shippingAddress as Address | null,
        lines: [
          {
            ...(line ?? {
              variantId: charge.variantId,
              productId: "",
              productHandle: "",
              title: charge.title,
              variantTitle: null,
              sku: null,
              imageUrl: null,
              inventory: null,
              requiresShipping: true,
            }),
            quantity: 1,
            unitPriceCents: charge.amountCents,
            compareAtCents: null,
          },
        ],
        addOns: [],
        discount: null,
        shipping: null,
        totalCents: charge.amountCents,
        whopPaymentId: paymentId,
        test: session.store.testMode,
      }));
    const updated = await db.upsellCharge.update({
      where: { id: charge.id },
      data: { shopifyOrderId: order.id, shopifyOrderName: order.name, error: null, syncStartedAt: null, nextSyncAt: null },
    });
    await sendUpsellConversions(updated.id).catch(() => undefined);
    await recordEvent({
      storeId,
      sessionId: session.id,
      kind: "upsell.paid",
      message: `Offre post-achat acceptée : ${charge.title} (${charge.amountCents / 100} ${session.currency}) → ${order.name}`,
    });
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const attempts = charge.syncAttempts + 1;
    const delay = SYNC_BACKOFF_MINUTES[attempts - 1];
    await db.upsellCharge.update({
      where: { id: charge.id },
      data: {
        error: message.slice(0, 500),
        syncAttempts: attempts,
        syncStartedAt: null,
        nextSyncAt: delay != null ? new Date(Date.now() + delay * 60_000) : null,
      },
    });
    await recordEvent({
      storeId,
      sessionId: session.id,
      level: "error",
      kind: delay != null ? "upsell.sync_failed" : "upsell.gave_up",
      message:
        delay != null
          ? `Offre post-achat payée mais commande Shopify non créée (essai ${attempts}) : ${message}. Nouvel essai automatique dans ${delay} min.`
          : `Offre post-achat payée toujours absente de Shopify après ${attempts} essais : ${message}. Créez-la à la main.`,
      alert: attempts === 1 || delay == null,
    });
    return null;
  }
}

/** Declined card, 3-D Secure abandoned…: the buyer may try again. */
export async function markUpsellFailed(chargeId: string, storeId: string, reason: string | null, paymentId: string | null) {
  const charge = await db.upsellCharge.findUnique({ where: { id: chargeId }, include: { session: true } });
  if (!charge || charge.session.storeId !== storeId || charge.status === "PAID") return;
  // Only the attempt that failed: a late failure of an earlier try must not free a
  // charge whose current payment (e.g. in 3-D Secure) may still succeed.
  const changed = await db.upsellCharge.updateMany({
    where: { id: chargeId, status: "PENDING", ...(paymentId ? { whopPaymentId: paymentId } : {}) },
    data: { status: "FAILED", error: (reason ?? "Paiement refusé").slice(0, 500) },
  });
  if (changed.count === 0) return;
  await recordEvent({ storeId, sessionId: charge.sessionId, kind: "upsell.declined_by_bank", message: `Offre post-achat refusée par la banque : ${reason ?? "sans motif"}` });
}

/** Background retry of paid offers whose Shopify order could not be created. */
export async function retryUpsellSyncs(deadline: number): Promise<number> {
  const due = await db.upsellCharge.findMany({
    where: {
      status: "PAID",
      shopifyOrderId: null,
      whopPaymentId: { not: null },
      OR: [{ nextSyncAt: { lte: new Date() } }, { syncAttempts: 0, createdAt: { lt: new Date(Date.now() - 3 * 60_000) } }],
    },
    include: { session: { select: { storeId: true } } },
    take: 10,
    orderBy: { createdAt: "asc" },
  });
  let done = 0;
  for (const c of due) {
    if (Date.now() > deadline) break;
    await markUpsellPaid(c.id, c.whopPaymentId!, c.session.storeId);
    done++;
  }
  return done;
}

/** Refund on an offer's payment: mirrored on the offer's own Shopify order, once per refund id. */
export async function recordUpsellRefund(paymentId: string, storeId: string, refundId: string, amountCents: number) {
  const charge = await db.upsellCharge.findUnique({ where: { whopPaymentId: paymentId }, include: { session: { include: { store: true } } } });
  if (!charge || charge.session.storeId !== storeId || amountCents <= 0) return;
  const marker = `refund:${refundId}`;
  try {
    await db.webhookEvent.create({ data: { id: marker, storeId, type: "refund" } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }
  try {
    if (charge.shopifyOrderId) await createRefund(charge.session.store, charge.shopifyOrderId, amountCents, "Remboursé via Whop");
    await db.upsellCharge.update({ where: { id: charge.id }, data: { refundedCents: { increment: amountCents } } });
  } catch (err) {
    await db.webhookEvent.delete({ where: { id: marker } });
    throw err;
  }
  await recordEvent({ storeId, sessionId: charge.sessionId, kind: "refund.recorded", message: `Offre post-achat remboursée (${amountCents / 100} ${charge.session.currency})` });
}

export async function recordUpsellDispute(paymentId: string, storeId: string, disputeId: string | null) {
  const charge = await db.upsellCharge.findUnique({ where: { whopPaymentId: paymentId }, include: { session: { include: { store: true } } } });
  if (!charge || charge.session.storeId !== storeId) return;
  const first = await db.upsellCharge.updateMany({ where: { id: charge.id, disputed: false }, data: { disputed: true } });
  if (first.count === 0) return;
  if (charge.shopifyOrderId) await tagOrder(charge.session.store, charge.shopifyOrderId, ["litige-whop"]).catch(() => undefined);
  await recordEvent({
    storeId,
    sessionId: charge.sessionId,
    level: "warn",
    kind: "dispute.created",
    message: `Litige ouvert sur une offre post-achat (${charge.title}, ${charge.amountCents / 100} ${charge.session.currency})`,
    alert: true,
  });
  if (disputeId && charge.session.store.autoDisputeEvidence) {
    await submitDisputeEvidence(charge.session, disputeId, {
      id: charge.id,
      title: charge.title,
      amountCents: charge.amountCents,
      paidAt: charge.createdAt,
      shopifyOrderId: charge.shopifyOrderId,
    });
  }
}

/** Counts the offer as shown (acceptance rate = accepted / shown). */
export async function markUpsellShown(sessionId: string) {
  await db.checkoutSession.updateMany({ where: { id: sessionId, upsellShownAt: null }, data: { upsellShownAt: new Date() } });
}
