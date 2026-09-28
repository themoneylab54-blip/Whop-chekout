import "server-only";
import { DeadlineError, notePartial, partialNoted, stopForTime } from "./deadline";
import { fairByStore } from "./rotation";
import { Prisma, type CheckoutSession, type Store } from "@prisma/client";
import { db } from "./db";
import { armKey, loadThankYouLayout, offerArmProps, offerHasB, offerReachable, offerUnitCents, parseArmKey, upsellSellable, MAX_OFFER_QUANTITY, type BlockOf, type OfferArm } from "./layout";
import { sendUpsellConversions } from "./conversions";
import { bucketOf, designFor } from "./experiments";
import { AMBIGUOUS_WAIT_MS, applyRefundOnce, formatAmount, isDefiniteOrderError, SYNC_BACKOFF_MINUTES, SYNC_LEASE_MS, syncSkipMessage, syncSkipReason, type SyncSkipReason } from "./checkout";
import { log, recordEvent } from "./log";
import { mirrorRefund } from "./refunds";
import { GOOGLE_ADJUST_DUE, markGoogleAdjustDue } from "./google-conversions";
import { offerCostSnapshot } from "./costs";
import { defer } from "./deferred";
import {
  addVariantToOrder,
  createPaidOrder,
  findOfferLine,
  findOrderByPayment,
  findOrderForSession,
  legacyOfferMarker,
  offerBalanceState,
  offerMarker,
  offerMergeRefusal,
  OrderEditNotCommittedError,
  orderForEdit,
  orderPayments,
  payOrderBalance,
  priceCart,
  ShopifyError,
  tagOrder,
  type Address,
} from "./shopify";
import { centsToDecimal, productKey, type CartLine } from "./pricing";
import { paymentInfoFromWhop, statementDescriptor, storeClient } from "./whop";
import { resolveAutoOffers, upsellContextFor } from "./offer-auto";

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
  return loadThankYouLayout(store.thankYouLayout).blocks.filter((b): b is UpsellBlock => b.type === "upsell" && !b.hidden && upsellSellable(b.props));
}

/* ---------- Offer A/B arms (pure) ---------- */

/** Sticky key of a buyer for offer tests: the storefront visitor id, else the session. */
export function visitorKeyOf(session: Pick<CheckoutSession, "id" | "visitorId">): string {
  return session.visitorId || session.id;
}

/** Arm a visitor sees: same hash as the design A/B tests (experiments.ts), per offer block. */
export function offerArmFor(block: Pick<UpsellBlock, "id" | "props">, visitorKey: string): OfferArm {
  if (!offerHasB(block)) return "A";
  return bucketOf(visitorKey, `upsell:${block.id}`) < (block.props.variantB?.split ?? 50) ? "B" : "A";
}

export function offerArmsFor(blocks: UpsellBlock[], visitorKey: string): Record<string, OfferArm> {
  return Object.fromEntries(blocks.map((b) => [b.id, offerArmFor(b, visitorKey)]));
}

/** Answers per offer block id (charges of arm B are stored as "<id>:B"). */
export function chargeStates(charges: { blockId: string; status: string }[]): Record<string, string> {
  return Object.fromEntries(charges.map((c) => [parseArmKey(c.blockId).blockId, c.status]));
}

/* ---------- Targeting (pure: unit-tested without a database) ---------- */

/** What an offer's conditions are checked against: the paid order. */
export type UpsellContext = {
  subtotalCents: number;
  productIds: string[];
  country: string | null;
  variantIds?: string[];
  /** Units bought (free gifts excluded). */
  units?: number;
  /** Collections of the order's products (offer-auto.ts: only loaded when an offer targets collections). */
  collectionIds?: string[];
  /** Had a paid order on the store before this one (same e-mail); undefined = not known. */
  returning?: boolean;
};

export function upsellContextOf(session: Pick<CheckoutSession, "lines" | "subtotalCents" | "shippingAddress" | "pickupPoint">): UpsellContext {
  const lines = (Array.isArray(session.lines) ? session.lines : []) as unknown as CartLine[];
  const address = session.shippingAddress as { countryCode?: string } | null;
  const pickup = session.pickupPoint as { countryCode?: string } | null;
  const variantIds = lines.map((l) => l.variantId).filter(Boolean);
  return {
    subtotalCents: session.subtotalCents || lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0),
    productIds: lines.map((l) => l.productId).filter(Boolean),
    ...(variantIds.length ? { variantIds } : {}),
    units: lines.reduce((n, l) => n + (l.gift ? 0 : Math.max(0, l.quantity)), 0),
    country: (address?.countryCode || pickup?.countryCode || "").toUpperCase() || null,
  };
}

const variantKey = (id: string) => id.trim().match(/(\d+)\D*$/)?.[1] ?? id.trim();

/** Is the arm's product already in the paid order (by product, else by variant)? */
export function offerAlreadyBought(block: Pick<UpsellBlock, "props">, ctx: UpsellContext, arm: OfferArm = "A"): boolean {
  const p = offerArmProps(block, arm);
  if (p.productId && ctx.productIds.some((id) => productKey(id) === productKey(p.productId!))) return true;
  return !!p.variantId && (ctx.variantIds ?? []).some((id) => variantKey(id) === variantKey(p.variantId));
}

/** Targeting of one offer: subtotal range (major units), products in the order, shipping country, not already bought. */
export function upsellConditionsMet(block: Pick<UpsellBlock, "props">, ctx: UpsellContext, arm: OfferArm = "A"): boolean {
  if (block.props.excludePurchased && offerAlreadyBought(block, ctx, arm)) return false;
  const c = block.props.conditions;
  if (!c) return true;
  if (c.minSubtotal != null && ctx.subtotalCents < Math.round(c.minSubtotal * 100)) return false;
  if (c.maxSubtotal != null && c.maxSubtotal > 0 && ctx.subtotalCents > Math.round(c.maxSubtotal * 100)) return false;
  if (c.productIds.length) {
    const inOrder = new Set(ctx.productIds.map(productKey));
    if (!c.productIds.some((id) => inOrder.has(productKey(id)))) return false;
  }
  if (c.countries.length && !(ctx.country && c.countries.some((x) => x.toUpperCase() === ctx.country))) return false;
  if (c.variantIds?.length) {
    const inOrder = new Set((ctx.variantIds ?? []).map(variantKey));
    if (!c.variantIds.some((id) => inOrder.has(variantKey(id)))) return false;
  }
  // Unknown collections or customer history fail closed: never shown on a guess.
  if (c.collectionIds?.length && !(ctx.collectionIds ?? []).some((id) => c.collectionIds!.some((x) => variantKey(x) === variantKey(id)))) return false;
  if (c.customer === "new" && ctx.returning !== false) return false;
  if (c.customer === "returning" && ctx.returning !== true) return false;
  const units = ctx.units ?? 0;
  if (c.minUnits != null && units < c.minUnits) return false;
  if (c.maxUnits != null && units > c.maxUnits) return false;
  return true;
}

/** Ids of the active offers whose targeting matches this order (chains are resolved separately). */
export function matchingUpsellIds(blocks: UpsellBlock[], ctx: UpsellContext, arms: Record<string, OfferArm> = {}): string[] {
  return blocks.filter((b) => upsellConditionsMet(b, ctx, arms[b.id] ?? "A")).map((b) => b.id);
}

/**
 * May `blockId` be offered now? It must match its targeting and be the current offer of
 * its chain: a downsell only after the offer before it was declined, a next step only
 * after the one before it was accepted.
 */
export function upsellOfferable(
  blocks: UpsellBlock[],
  blockId: string,
  ctx: UpsellContext,
  states: Record<string, string | undefined>,
  arms: Record<string, OfferArm> = {},
): boolean {
  const matching = new Set(matchingUpsellIds(blocks, ctx, arms));
  return offerReachable(blocks, blockId, states, (id) => matching.has(id));
}

/** Quantity the buyer asked for, or null when outside 1..maxQuantity. */
export function upsellQuantity(block: Pick<UpsellBlock, "props">, quantity: unknown): number | null {
  const q = quantity == null ? 1 : Number(quantity);
  const max = Math.min(MAX_OFFER_QUANTITY, Math.max(1, block.props.maxQuantity ?? 1));
  return Number.isInteger(q) && q >= 1 && q <= max ? q : null;
}

/**
 * Amount charged for `quantity` units of the offer's arm: the fixed unit price, or the
 * percent off Shopify's live unit price (null when that price is unknown).
 */
export function upsellAmountCents(block: Pick<UpsellBlock, "props">, quantity: number, liveUnitCents?: number | null, arm: OfferArm = "A"): number | null {
  const unit = offerUnitCents(offerArmProps(block, arm), liveUnitCents);
  return unit == null ? null : unit * quantity;
}

export function upsellEligible(session: CheckoutSession, now = Date.now()) {
  return (
    session.status === "PAID" &&
    // Never a second charge on an order held for review, disputed or refunded.
    session.reviewNote == null &&
    !session.disputed &&
    session.refundedCents === 0 &&
    !!session.whopMemberId &&
    !!session.whopPaymentMethodId &&
    !!session.paidAt &&
    now - session.paidAt.getTime() < UPSELL_WINDOW_MS
  );
}

/** Buyer-facing refusal; `code` lets the thank-you page show it in the buyer's language. */
export class UpsellError extends Error {
  constructor(
    message: string,
    readonly code = "upsell_unavailable",
  ) {
    super(message);
  }
}

export type UpsellResult =
  | { status: "paid"; orderName: string | null }
  | { status: "action"; url: string }
  | { status: "pending" }
  | { status: "declined" };

export async function declineUpsell(session: SessionWithStore, blockId: string) {
  const design = await designFor(session.store, session);
  // "Automatique" offers: the product picked for this order (same pick as the thank-you page).
  const block = (await resolveAutoOffers(session.store, session, activeUpsells({ thankYouLayout: design.thankYouLayout }))).find((b) => b.id === blockId);
  if (!block) throw new UpsellError("Offre introuvable", "upsell_unavailable");
  const arm = offerArmFor(block, visitorKeyOf(session));
  const p = offerArmProps(block, arm);
  await db.upsellCharge
    .create({
      data: {
        sessionId: session.id,
        blockId: armKey(blockId, arm),
        title: p.title,
        variantId: p.variantId,
        // Percent offers have no price until Shopify prices them: 0 on a decline.
        amountCents: offerUnitCents(p, null) ?? 0,
        status: "DECLINED",
      },
    })
    .catch((err) => {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    });
  return { status: "declined" as const };
}

/**
 * `shownVariantId`: the variant the thank-you page displayed. An automatic offer re-picks its
 * product at accept time (new paid orders, stock); a different pick than the one shown is refused
 * (the buyer must never be charged for a product they didn't see). Required for automatic offers.
 */
export async function acceptUpsell(session: SessionWithStore, blockId: string, requestedQuantity: number = 1, shownVariantId?: string | null): Promise<UpsellResult> {
  if (!upsellEligible(session)) throw new UpsellError("Cette offre n'est plus disponible", "upsell_expired");
  const store = session.store;
  const design = await designFor(store, session);
  const offers = await resolveAutoOffers(store, session, activeUpsells({ thankYouLayout: design.thankYouLayout }));
  const block = offers.find((b) => b.id === blockId);
  if (!block) throw new UpsellError("Offre introuvable", "upsell_unavailable");
  const quantity = upsellQuantity(block, requestedQuantity);
  if (quantity == null) throw new UpsellError("Quantité invalide", "upsell_quantity");
  if (!store.whopAccountId || !store.whopProductId) throw new UpsellError("Paiement indisponible", "upsell_unavailable");
  // The arm is decided here (sticky per visitor), never by the browser.
  const visitor = visitorKeyOf(session);
  const arms = offerArmsFor(offers, visitor);
  const arm = arms[blockId] ?? "A";
  const props = offerArmProps(block, arm);
  if ((shownVariantId != null || block.props.productSource === "auto") && (!shownVariantId || productKey(shownVariantId) !== productKey(props.variantId))) {
    throw new UpsellError("Cette offre a changé : rechargez la page pour voir la nouvelle", "upsell_unavailable");
  }
  const key = armKey(blockId, arm);
  // Targeting and chain order: a downsell only after a decline, a next step only after a "Yes".
  const answered = await db.upsellCharge.findMany({ where: { sessionId: session.id }, select: { blockId: true, status: true } });
  const states = chargeStates(answered);
  // Already accepted (double click, retry): answered below from the existing charge.
  const already = states[blockId] === "PAID" || states[blockId] === "PENDING";
  if (!already && !upsellOfferable(offers, blockId, await upsellContextFor(store, session, offers), states, arms)) {
    throw states[blockId] === "DECLINED"
      ? new UpsellError("Offre déjà refusée", "upsell_declined")
      : new UpsellError("Cette offre n'est pas disponible pour votre commande", "upsell_unavailable");
  }

  const [line] = await priceCart(store, [{ variantId: props.variantId, quantity }]);
  if (!line) throw new UpsellError("Ce produit n'est plus disponible", "upsell_sold_out");
  if (line.inventory != null && line.inventory > 0 && line.inventory < quantity) throw new UpsellError("Stock insuffisant pour cette quantité", "upsell_stock");
  // Server-side price: fixed, or the percent off Shopify's price right now.
  const amountCents = upsellAmountCents(block, quantity, line.unitPriceCents, arm);
  if (amountCents == null || amountCents <= 0) throw new UpsellError("Ce produit n'est plus disponible", "upsell_sold_out");

  // Unit cost: the app's ("Coûts produits") wins over Shopify's (analytics multiply by quantity).
  const cost = await offerCostSnapshot(store.id, line.variantId, line.unitCostCents);
  // One charge per offer and session: a double click can't charge twice.
  let charge;
  try {
    charge = await db.upsellCharge.create({
      data: {
        sessionId: session.id,
        blockId: key,
        title: line.title,
        variantId: line.variantId,
        productId: line.productId,
        amountCents,
        quantity,
        costCents: cost.costCents,
        costSource: cost.costSource,
        shopifyCostCents: cost.shopifyCostCents,
        chargeStartedAt: new Date(),
      },
    });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const existing = await db.upsellCharge.findUniqueOrThrow({ where: { sessionId_blockId: { sessionId: session.id, blockId: key } } });
    if (existing.status === "PAID") return { status: "paid", orderName: existing.shopifyOrderName };
    if (existing.status === "DECLINED") throw new UpsellError("Offre déjà refusée", "upsell_declined");
    if (existing.status === "PENDING") return { status: "pending" };
    // FAILED: a new attempt, with a new idempotency key.
    const retried = await db.upsellCharge.updateMany({
      where: { id: existing.id, status: "FAILED", whopPaymentId: existing.whopPaymentId },
      // Nothing was charged: the new attempt may be for another quantity. The earlier
      // payment id is kept so a late refund/dispute on it is still attributed.
      data: {
        status: "PENDING",
        error: null,
        whopPaymentId: null,
        ...(existing.whopPaymentId ? { previousPaymentIds: { push: existing.whopPaymentId } } : {}),
        chargeAttempts: { increment: 1 },
        chargeStartedAt: new Date(),
        nextCheckAt: null,
        amountCents,
        quantity,
      },
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
          title: `Offre : ${charge.quantity > 1 ? `${charge.quantity} × ` : ""}${charge.title}`.slice(0, 80),
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
    // Refused to start for lack of time (background run): nothing was sent, nothing is uncertain.
    if (err instanceof DeadlineError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (definitelyRejected(err)) {
      await db.upsellCharge.update({ where: { id: charge.id }, data: { status: "FAILED", error: message.slice(0, 500) } });
      await recordEvent({ storeId: store.id, sessionId: session.id, level: "warn", kind: "upsell.failed", message: `Offre post-achat refusée par Whop : ${message}` });
      throw new UpsellError("Le paiement n'a pas pu être effectué. Aucun montant n'a été débité.", "upsell_payment_failed");
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
    const done = await markUpsellPaid(chargeId, payment.id, storeId, paymentInfoFromWhop(payment as unknown as Record<string, unknown>).feeCents);
    return { status: "paid", orderName: done?.shopifyOrderName ?? null };
  }
  if (["void", "uncollectible"].includes(payment.status)) {
    await markUpsellFailed(chargeId, storeId, `Paiement ${payment.status}`, payment.id);
    throw new UpsellError("Le paiement a été refusé. Aucun montant n'a été débité.", "upsell_card_declined");
  }
  // 3-D Secure or similar: the buyer confirms on Whop, the webhook (or the sweep) finishes the job.
  if (payment.recovery_url) return { status: "action", url: payment.recovery_url };
  return { status: "pending" };
}

/**
 * Resolves offers stuck in PENDING (lost webhook, crash, timeout): asks Whop for the
 * payment, or replays the same idempotent request when we never learned its id.
 * A replay is only allowed while the offer could still have been accepted: a
 * request that never reached Whop must not turn into a charge hours later.
 */
export const UPSELL_REPLAY_LIMIT_MS = UPSELL_WINDOW_MS + 10 * 60_000;

export async function sweepPendingUpsells(deadline: number): Promise<number> {
  const stuck = await db.upsellCharge.findMany({
    where: {
      status: "PENDING",
      AND: [
        { OR: [{ chargeStartedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, { chargeStartedAt: null, createdAt: { lt: new Date(Date.now() - 5 * 60_000) } }] },
        // Charges waiting on the buyer (3-D Secure) are re-checked every 15 min, not every tick.
        { OR: [{ nextCheckAt: null }, { nextCheckAt: { lte: new Date() } }] },
      ],
    },
    include: { session: { include: { store: true } } },
    take: 20,
    // Uncertain charges (no payment id yet) first: their replay window is short.
    orderBy: [{ whopPaymentId: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
  });
  let resolved = 0;
  for (const c of stuck) {
    if (stopForTime(deadline)) break;
    const storeId = c.session.storeId;
    const age = Date.now() - (c.chargeStartedAt ?? c.createdAt).getTime();
    try {
      if (c.whopPaymentId) {
        const p = await storeClient(c.session.store).payments.retrieve({ id: c.whopPaymentId });
        if (p.status === "paid") await markUpsellPaid(c.id, p.id, storeId, paymentInfoFromWhop(p as unknown as Record<string, unknown>).feeCents);
        else if (["void", "uncollectible"].includes(p.status)) await markUpsellFailed(c.id, storeId, `Paiement ${p.status}`, p.id);
        else if (age > 24 * 3600_000) await markUpsellFailed(c.id, storeId, "Jamais confirmé par le client", p.id);
        else {
          await db.upsellCharge.update({ where: { id: c.id }, data: { nextCheckAt: new Date(Date.now() + 15 * 60_000) } });
          continue;
        }
      } else if (age < UPSELL_REPLAY_LIMIT_MS) {
        // Same key as the original request: Whop returns the original result, no new charge. A refusal
        // is recorded by chargeWhop; out of time, nothing was sent (retried next run, not journaled).
        await chargeWhop(c.session, c).catch((err) => {
          if (err instanceof DeadlineError) throw err;
        });
      } else {
        const gaveUp = await db.upsellCharge.updateMany({ where: { id: c.id, status: "PENDING", whopPaymentId: null }, data: { status: "FAILED", error: "Issue inconnue" } });
        if (gaveUp.count === 1) {
          await recordEvent({
            storeId,
            sessionId: c.sessionId,
            level: "error",
            kind: "upsell.gave_up",
            message: `Offre post-achat « ${c.title} » : réponse de Whop jamais reçue, aucun nouvel essai (trop tard). Vérifiez dans Whop si le client a été débité.`,
            alert: true,
          });
        }
      }
      resolved++;
    } catch (err) {
      if (err instanceof DeadlineError) {
        notePartial();
        break;
      }
      log.warn("upsell.sweep_failed", "Could not resolve a pending upsell", { chargeId: c.id, err });
    }
  }
  return resolved;
}

/** Marks an offer paid and creates its Shopify order. Idempotent (webhook + direct call). */
export async function markUpsellPaid(chargeId: string, paymentId: string, storeId: string, feeCents?: number | null) {
  const found = await db.upsellCharge.findUnique({ where: { id: chargeId }, include: { session: { include: { store: true } } } });
  if (!found || found.session.storeId !== storeId) return null;
  // Already paid by another payment: a second charge for the same offer. Never overwrite; tell.
  if (found.status === "PAID" && found.whopPaymentId && found.whopPaymentId !== paymentId) {
    await reportDuplicateOffer(found, paymentId, storeId);
    return found;
  }
  const became = await db.upsellCharge.updateMany({
    where: { id: chargeId, status: { not: "PAID" } },
    data: { status: "PAID", whopPaymentId: paymentId, ...(feeCents != null ? { whopFeeCents: feeCents } : {}) },
  });
  if (became.count === 0) {
    // Lost a race with another payment's webhook (e.g. a late 3-D Secure of an earlier attempt).
    const now = await db.upsellCharge.findUniqueOrThrow({ where: { id: chargeId } });
    if (now.whopPaymentId && now.whopPaymentId !== paymentId) {
      await reportDuplicateOffer({ ...found, ...now }, paymentId, storeId);
      return now;
    }
  }
  // Offer paid: the order's Google Ads conversion value grows (adjusted by the tick).
  if (became.count) await markGoogleAdjustDue(found.sessionId);
  if (feeCents != null && found.whopFeeCents == null) await db.upsellCharge.update({ where: { id: chargeId }, data: { whopFeeCents: feeCents } });
  // Linked by hand to an order the merchant created: never create another one.
  if (found.syncHandledAt) return found;
  // From a webhook: the Shopify order is created after the answer to Whop (the tick backstops it).
  if (!found.shopifyOrderId && defer("upsell.order", () => markUpsellPaid(chargeId, paymentId, storeId, feeCents))) return found;
  if (found.shopifyOrderId) return found;

  // Lease: the webhook, the direct accept and the tick can race; only one creates the order.
  const claim = await db.upsellCharge.updateMany({
    where: {
      id: chargeId,
      shopifyOrderId: null,
      syncHandledAt: null,
      AND: [
        { OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(Date.now() - SYNC_LEASE_MS) } }] },
        // After an ambiguous attempt, wait until Shopify's search can see an order it created.
        { OR: [{ syncAmbiguousAt: null }, { syncAmbiguousAt: { lt: new Date(Date.now() - AMBIGUOUS_WAIT_MS) } }] },
      ],
    },
    data: { syncStartedAt: new Date() },
  });
  if (claim.count === 0) return db.upsellCharge.findUnique({ where: { id: chargeId } });
  const charge = found;

  const session = charge.session;
  const ref = `upsell-${charge.id}`;
  let creating = false;
  try {
    // A failed lookup must not lead to creating the order (it may already exist): retry later.
    let existing = await findOrderForSession(session.store, ref);
    // After an ambiguous attempt: a second, independent lookup by the Whop payment.
    if (!existing && charge.syncAmbiguousAt) existing = await findOrderByPayment(session.store, { sessionId: ref, paymentId });
    // The checkout's own order found under the offer's key (offers merged before the distinct merge
    // tag carried the offer's own lookup tag): the offer is in that order, never a separate one.
    const inCheckoutOrder = !!existing && !!session.shopifyOrderId && existing.id === session.shopifyOrderId;
    if (inCheckoutOrder) existing = null;
    // (Not after a merge whose outcome is unknown: the offer may already be in the checkout's order.)
    const pendingMerge = !!charge.shopifyLineItemId?.startsWith("pending:");
    // Refunded in full (or chargeback lost) before its order was created: never create it.
    const skipIfSettled = async () => {
      const fresh = await db.upsellCharge.findUniqueOrThrow({ where: { id: charge.id }, select: { refundedCents: true, disputeStatus: true } });
      const skip = syncSkipReason({ refundedCents: fresh.refundedCents, paidCents: charge.amountCents, disputeStatus: fresh.disputeStatus });
      if (!skip) return false;
      await skipOfferSync(charge.id, storeId, session.id, charge.title, skip);
      return true;
    };
    if (!existing && !pendingMerge && !inCheckoutOrder && (await skipIfSettled())) return db.upsellCharge.findUnique({ where: { id: charge.id } });
    const quantity = Math.max(1, charge.quantity);
    // Merged mode: the offer goes into the checkout's own Shopify order (one parcel), unless a
    // separate order already exists for it or the order can't be edited (then: its own order).
    if (!existing) {
      const merged = await mergeOfferIntoOrder(session, charge, quantity, { resume: inCheckoutOrder });
      if (merged === "defer") {
        // The checkout's order is still being created: the offer waits for it (no try spent).
        await db.upsellCharge.update({ where: { id: charge.id }, data: { syncStartedAt: null, nextSyncAt: new Date(Date.now() + OFFER_MERGE_WAIT_MS) } });
        log.info("upsell.merge_deferred", "Offer waits for the checkout's Shopify order", { chargeId: charge.id });
        return db.upsellCharge.findUnique({ where: { id: charge.id } });
      }
      if (merged) {
        const updated = await db.upsellCharge.update({
          where: { id: charge.id },
          data: {
            shopifyOrderId: merged.orderId,
            shopifyOrderName: merged.orderName,
            shopifyLineItemId: merged.lineItemId,
            orderMode: "merged",
            balanceSettledAt: merged.paid ? new Date() : null,
            error: null,
            syncStartedAt: null,
            nextSyncAt: null,
            syncAmbiguousAt: null,
          },
        });
        await sendUpsellConversions(updated.id).catch(() => undefined);
        if (updated.refundedCents > updated.refundMirroredCents) await mirrorUpsellRefunds(updated.id, { force: true });
        await recordEvent({
          storeId,
          sessionId: session.id,
          kind: "upsell.paid",
          message: `Offre post-achat acceptée : ${charge.title} (${charge.amountCents / 100} ${session.currency}) → ajoutée à ${merged.orderName}${merged.paid ? "" : " (paiement Whop pas encore enregistré sur la commande : nouvel essai automatique)"}`,
          data: { chargeId: charge.id, orderMode: "merged" },
        });
        return updated;
      }
      // Not merged after all (an ambiguous merge that never committed): a refund that arrived
      // meanwhile still settles the offer before a separate order is created.
      if ((pendingMerge || inCheckoutOrder) && (await skipIfSettled())) return db.upsellCharge.findUnique({ where: { id: charge.id } });
    }
    const [line] = await priceCart(session.store, [{ variantId: charge.variantId, quantity }]);
    if (!existing) {
      // Write-ahead: the order may exist from here on even if this run dies before recording it.
      await db.upsellCharge.update({ where: { id: charge.id }, data: { syncAmbiguousAt: new Date() } });
      creating = true;
    }
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
            quantity,
            // amountCents = unit price × quantity (exact: the unit price is in cents).
            unitPriceCents: Math.round(charge.amountCents / quantity),
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
      data: { shopifyOrderId: order.id, shopifyOrderName: order.name, orderMode: "separate", shopifyLineItemId: null, error: null, syncStartedAt: null, nextSyncAt: null, syncAmbiguousAt: null },
    });
    await sendUpsellConversions(updated.id).catch(() => undefined);
    // A refund that arrived before the order existed is reported now.
    if (updated.refundedCents > updated.refundMirroredCents) await mirrorUpsellRefunds(updated.id, { force: true });
    await recordEvent({
      storeId,
      sessionId: session.id,
      kind: "upsell.paid",
      message: `Offre post-achat acceptée : ${charge.title} (${charge.amountCents / 100} ${session.currency}) → ${order.name}`,
      data: { chargeId: charge.id, orderMode: "separate" },
    });
    return updated;
  } catch (err) {
    if (err instanceof DeadlineError) {
      // Refused before sending: nothing was created. The tick job reports partial (and stops its loop).
      await db.upsellCharge.update({ where: { id: charge.id }, data: { syncStartedAt: null, ...(creating ? { syncAmbiguousAt: null } : {}) } });
      notePartial();
      return null;
    }
    const message = err instanceof Error ? err.message : String(err);
    const attempts = charge.syncAttempts + 1;
    const delay = SYNC_BACKOFF_MINUTES[attempts - 1];
    await db.upsellCharge.update({
      where: { id: charge.id },
      data: {
        error: message.slice(0, 500),
        syncAttempts: attempts,
        syncStartedAt: null,
        nextSyncAt: delay != null ? new Date(Date.now() + Math.max(delay * 60_000, creating ? AMBIGUOUS_WAIT_MS : 0)) : null,
        // No Shopify answer: the order may exist (mark refreshed); a definite refusal created nothing.
        ...(creating ? { syncAmbiguousAt: isDefiniteOrderError(err) ? null : new Date() } : {}),
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
      err,
    });
    return null;
  }
}

/** Offer order deliberately not created (refunded / lost before creation): handled, journaled, alerted once. */
async function skipOfferSync(chargeId: string, storeId: string, sessionId: string, title: string, reason: SyncSkipReason, where: Prisma.UpsellChargeWhereInput = {}) {
  const done = await db.upsellCharge.updateMany({
    where: { id: chargeId, shopifyOrderId: null, syncHandledAt: null, ...where },
    data: { syncHandledAt: new Date(), syncSkippedReason: reason, syncStartedAt: null, nextSyncAt: null, error: null, syncAmbiguousAt: null },
  });
  if (!done.count) return false;
  await recordEvent({
    storeId,
    sessionId,
    level: "warn",
    kind: "upsell.sync_skipped",
    message: `${syncSkipMessage(reason, `Offre post-achat « ${title} »`)} Aucune action requise.`,
    data: { reason, chargeId },
    alert: true,
  });
  return true;
}

/**
 * A paid offer without a Shopify order that just became fully refunded or lost its
 * dispute: settled at once when nothing can have been created, else its sync is made
 * due (it looks the order up first).
 */
export async function settleUnsyncedOffer(chargeId: string) {
  const c = await db.upsellCharge.findUnique({ where: { id: chargeId }, include: { session: { select: { storeId: true } } } });
  if (!c || c.status !== "PAID" || c.shopifyOrderId || c.syncHandledAt) return;
  const reason = syncSkipReason({ refundedCents: c.refundedCents, paidCents: c.amountCents, disputeStatus: c.disputeStatus });
  if (!reason) return;
  if (!c.syncAmbiguousAt) {
    const leaseFree = { syncAmbiguousAt: null, OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: new Date(Date.now() - SYNC_LEASE_MS) } }] };
    if (await skipOfferSync(c.id, c.session.storeId, c.sessionId, c.title, reason, leaseFree)) return;
  }
  await db.upsellCharge.updateMany({ where: { id: chargeId, shopifyOrderId: null, syncHandledAt: null }, data: { nextSyncAt: new Date() } });
}

/** Retry delay of an offer waiting for its checkout's Shopify order (merged mode). */
export const OFFER_MERGE_WAIT_MS = 2 * 60_000;

/**
 * Merged mode, the checkout's own Shopify order not created yet: "defer" (the offer waits for it,
 * retried in OFFER_MERGE_WAIT_MS) while that order is still on its way — paid, not held for review,
 * not settled by hand or skipped — and the merge window (from the payment) isn't over; otherwise why
 * the offer gets its own order. Pure.
 */
export function offerMergeWait(
  session: { status: string; paidAt: Date | null; reviewNote: string | null; syncHandledAt: Date | null },
  opts: { windowMin: number; offerCreatedAt: Date; now?: number },
): "defer" | string {
  const now = opts.now ?? Date.now();
  if (session.status !== "PAID") return "commande d'origine non payée";
  if (session.reviewNote) return "commande d'origine mise de côté pour vérification";
  if (session.syncHandledAt) return "commande d'origine traitée à la main";
  const from = (session.paidAt ?? opts.offerCreatedAt).getTime();
  if (now - from >= opts.windowMin * 60_000) return `commande d'origine pas encore créée ${opts.windowMin} min après le paiement`;
  return "defer";
}

/**
 * Adds a paid offer to the checkout's own Shopify order (order edit), idempotently:
 *  - only when the store opted in ("Ajouter les offres à la commande d'origine"), within the merge
 *    window after the order's creation, on an open, unfulfilled order without a fulfillment hold
 *    or a supplier tag (DSers, AutoDS…): an order already sent to the supplier would never ship it;
 *  - the offer's line is recognised by the marker in its discount, or — after a write-ahead
 *    snapshot of the order's line ids — as a new line of the variant;
 *  - before the commit, the snapshot and syncAmbiguousAt are written: a commit whose outcome is
 *    unknown throws, and the retry finds the line instead of adding it twice (never a fallback then);
 *    a transient failure before the commit clears them and throws (retried with backoff);
 *  - the Whop payment is recorded on the order's balance once (see settleOfferBalance).
 * `resume`: the offer is known to be in the order already (found under its key): only its line
 * and payment are completed, never a second add, never a separate order.
 * Returns null when the offer must get its own order.
 */
async function mergeOfferIntoOrder(
  session: SessionWithStore,
  charge: { id: string; variantId: string; amountCents: number; shopifyLineItemId: string | null; createdAt: Date },
  quantity: number,
  opts: { resume?: boolean } = {},
): Promise<{ orderId: string; orderName: string; lineItemId: string; paid: boolean } | null | "defer"> {
  const store = session.store;
  const resume = !!opts.resume;
  const mergeOn = store.mergeOffersIntoOrder && (store.shopifyScopes ?? "").split(",").map((x) => x.trim()).includes("write_order_edits");
  // Every fallback to a separate order while merging is on is journaled (the ratio on the health tile
  // and the journal must explain each one).
  const skipped = async (reason: string, orderName?: string | null) => {
    log.info("upsell.merge_skipped", `Offer gets its own order: ${reason}`, { chargeId: charge.id });
    await recordEvent({
      storeId: store.id,
      sessionId: session.id,
      kind: "upsell.merge_skipped",
      message: `Offre non ajoutée à ${orderName ?? "la commande d'origine"} (${reason}) : elle aura sa propre commande Shopify.`,
      data: { chargeId: charge.id, reason },
    });
  };
  if (!session.shopifyOrderId) {
    if (!mergeOn || resume || charge.shopifyLineItemId?.startsWith("pending:")) return null;
    const decision = offerMergeWait(session, { windowMin: store.offerMergeWindowMin, offerCreatedAt: charge.createdAt });
    if (decision === "defer") return "defer";
    await skipped(decision);
    return null;
  }
  const marker = offerMarker(charge.id);
  const markers = [marker, legacyOfferMarker(charge.id)];
  const before = charge.shopifyLineItemId?.startsWith("pending:") ? new Set(charge.shopifyLineItemId.slice("pending:".length).split(",").filter(Boolean)) : null;
  // A new add needs the merchant's opt-in and the order-edit permission (stores connected before
  // it keep separate orders until re-authorized); an offer possibly in the order is always looked up.
  const mayAdd =
    !resume &&
    !session.syncHandledAt &&
    store.mergeOffersIntoOrder &&
    (store.shopifyScopes ?? "").split(",").map((x) => x.trim()).includes("write_order_edits");
  if (!mayAdd && !before && !resume) {
    if (mergeOn && session.syncHandledAt) await skipped("commande d'origine liée à la main");
    return null;
  }
  let order: Awaited<ReturnType<typeof orderForEdit>>;
  try {
    order = await orderForEdit(store, session.shopifyOrderId);
  } catch (err) {
    // Unreadable for now (network, 5xx, time budget): retry later. After a commit of unknown outcome
    // the offer may be in the order: retry, never a second order. Only Shopify's definite refusal
    // to show the order sends a new offer to its own order.
    if (before || resume || !(err instanceof ShopifyError) || err.transient) throw err;
    log.warn("upsell.merge_lookup_failed", "Checkout order unreadable: the offer gets its own order", { chargeId: charge.id, err });
    await skipped(`commande d'origine illisible : ${err.message.slice(0, 120)}`);
    return null;
  }
  let line = order ? findOfferLine(order, markers, charge.variantId, before) : null;
  // Merged before the write-ahead snapshot existed, with no discount to carry the marker: the last
  // line of the variant is the offer's.
  if (!line && resume && order) line = order.lines.filter((l) => l.variantId === charge.variantId).at(-1) ?? null;
  if (!line) {
    if (resume) throw new ShopifyError("Offre marquée sur la commande d'origine mais sa ligne est introuvable pour l'instant (nouvel essai)");
    const clearPending = async () => {
      if (before) await db.upsellCharge.update({ where: { id: charge.id }, data: { shopifyLineItemId: null } });
    };
    if (!mayAdd) {
      await clearPending();
      return null;
    }
    const refusal = offerMergeRefusal(order, { windowMin: store.offerMergeWindowMin, fallbackCreatedAt: session.paidAt });
    if (refusal || !order) {
      await clearPending();
      await skipped(refusal ?? "commande d'origine introuvable", order?.name);
      return null;
    }
    // Write-ahead: the order's lines before the edit, and "outcome may be unknown" from here.
    const snapshot = new Set(order.lines.map((l) => l.id));
    await db.upsellCharge.update({ where: { id: charge.id }, data: { shopifyLineItemId: `pending:${[...snapshot].join(",")}`, syncAmbiguousAt: new Date() } });
    let r: Awaited<ReturnType<typeof addVariantToOrder>>;
    try {
      r = await addVariantToOrder(store, { orderId: order.id, variantId: charge.variantId, quantity, amountCents: charge.amountCents, currency: session.currency, marker });
    } catch (err) {
      if (err instanceof OrderEditNotCommittedError) {
        // Nothing committed: no consistency wait, no snapshot; retried with backoff (no fallback).
        await db.upsellCharge.update({ where: { id: charge.id }, data: { shopifyLineItemId: null, syncAmbiguousAt: null } });
        throw err.cause;
      }
      throw err;
    }
    if (r.status === "refused") {
      await db.upsellCharge.update({ where: { id: charge.id }, data: { shopifyLineItemId: null, syncAmbiguousAt: null } });
      await recordEvent({
        storeId: store.id,
        sessionId: session.id,
        kind: "upsell.merge_refused",
        message: `Offre non ajoutée à ${order.name} (${r.reason}) : elle aura sa propre commande Shopify.`,
        data: { chargeId: charge.id, reason: r.reason },
      });
      return null;
    }
    order = await orderForEdit(store, order.id);
    line = order ? findOfferLine(order, markers, charge.variantId, snapshot) : null;
    if (!line || !order) throw new ShopifyError("Offre ajoutée à la commande mais ligne introuvable pour l'instant (nouvel essai)");
  }
  const target = order!;
  if (!target.tags.includes(marker)) await tagOrder(store, target.id, [marker]).catch((err) => log.warn("upsell.merge_tag_failed", "Could not tag the merged order", { chargeId: charge.id, err }));
  // Out of time for the balance: the offer is merged all the same; its payment is recorded by the
  // balance retry job (retryOfferBalances), without a false "unpaid" alert.
  const balance = await settleOfferBalance(store, target.id, charge.amountCents, session.currency, marker).catch((err) => {
    if (err instanceof DeadlineError) return { paid: false as const, reason: "temps de maintenance épuisé", deadline: true };
    throw err;
  });
  if (!balance.paid && !("deadline" in balance)) {
    await recordEvent({
      storeId: store.id,
      sessionId: session.id,
      level: "warn",
      kind: "upsell.merge_unpaid",
      message: `Offre ajoutée à ${target.name} mais le paiement Whop n'a pas pu y être enregistré (${balance.reason}) : nouvel essai automatique ; sinon marquez le solde comme payé dans Shopify.`,
      data: { chargeId: charge.id },
      alert: true,
    });
  }
  return { orderId: target.id, orderName: target.name, lineItemId: line.id, paid: balance.paid };
}

/**
 * Records one merged offer's Whop payment on the shared order, at most once: an existing payment
 * carrying the offer's marker (a previous run, a crash after paying) is never paid again, another
 * offer's balance is never taken (exact amount only), and a failed payment is re-checked before it
 * is reported. `paid` = the order owes nothing for this offer.
 */
async function settleOfferBalance(store: Store, orderId: string, amountCents: number, currency: string, marker: string): Promise<{ paid: true } | { paid: false; reason: string }> {
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));
  let state: ReturnType<typeof offerBalanceState>;
  try {
    const p = await orderPayments(store, orderId);
    if (!p) return { paid: false, reason: "commande introuvable" };
    state = offerBalanceState(p, marker, amountCents);
    if (state === "mismatch") return { paid: false, reason: `solde de la commande (${formatAmount(p.outstandingCents, currency)}) inférieur au montant de l'offre (${formatAmount(amountCents, currency)})` };
  } catch (err) {
    // Out of time before asking Shopify: not a failure (the caller retries, no try spent, not journaled).
    if (err instanceof DeadlineError) throw err;
    return { paid: false, reason: reason(err) };
  }
  if (state !== "due") return { paid: true };
  try {
    await payOrderBalance(store, orderId, amountCents, currency, marker);
    return { paid: true };
  } catch (err) {
    // Refused to start (no time left): nothing was recorded on the order.
    if (err instanceof DeadlineError) throw err;
    // The payment may have gone through (timeout): look again before reporting it missing.
    const again = await orderPayments(store, orderId).catch((e) => {
      if (e instanceof DeadlineError) throw e;
      return null;
    });
    const now = again ? offerBalanceState(again, marker, amountCents) : null;
    if (now === "paid" || now === "settled") return { paid: true };
    return { paid: false, reason: reason(err) };
  }
}

/** Tries left to record a merged offer's payment on the shared order before a human must. */
export const MAX_BALANCE_ATTEMPTS = 5;

/** Background retry of merged offers whose Whop payment isn't recorded on the shared order yet. */
export async function retryOfferBalances(deadline: number): Promise<number> {
  const due = await db.upsellCharge.findMany({
    where: {
      orderMode: "merged",
      shopifyOrderId: { not: null },
      balanceSettledAt: null,
      balanceAttempts: { lt: MAX_BALANCE_ATTEMPTS },
      createdAt: { lt: new Date(Date.now() - 5 * 60_000) },
      // Backoff after a failed try (like the order sync): a balance Shopify keeps refusing isn't retried on
      // every run, and never hides the due ones behind it.
      OR: [{ nextBalanceAt: null }, { nextBalanceAt: { lte: new Date() } }],
    },
    include: { session: { include: { store: true } } },
    take: 10,
    orderBy: [{ nextBalanceAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
  });
  let settled = 0;
  for (const c of due) {
    if (stopForTime(deadline)) break;
    // Claim this attempt (two runs never pay the same balance concurrently).
    const claim = await db.upsellCharge.updateMany({ where: { id: c.id, balanceSettledAt: null, balanceAttempts: c.balanceAttempts }, data: { balanceAttempts: { increment: 1 } } });
    if (claim.count === 0) continue;
    let r: Awaited<ReturnType<typeof settleOfferBalance>>;
    try {
      r = await settleOfferBalance(c.session.store, c.shopifyOrderId!, c.amountCents, c.session.currency, offerMarker(c.id));
    } catch (err) {
      if (!(err instanceof DeadlineError)) throw err;
      // Out of time: the try is given back (never counted towards giving up), retried next run.
      await db.upsellCharge.updateMany({ where: { id: c.id, balanceSettledAt: null, balanceAttempts: c.balanceAttempts + 1 }, data: { balanceAttempts: c.balanceAttempts } });
      notePartial();
      break;
    }
    if (r.paid) {
      await db.upsellCharge.update({ where: { id: c.id }, data: { balanceSettledAt: new Date(), nextBalanceAt: null } });
      await recordEvent({ storeId: c.session.storeId, sessionId: c.sessionId, kind: "upsell.merge_paid", message: `Paiement Whop de l'offre « ${c.title} » enregistré sur ${c.shopifyOrderName ?? "la commande d'origine"}.` });
      settled++;
      continue;
    }
    const attempts = c.balanceAttempts + 1;
    const delay = SYNC_BACKOFF_MINUTES[attempts - 1];
    await db.upsellCharge.update({ where: { id: c.id }, data: { nextBalanceAt: attempts < MAX_BALANCE_ATTEMPTS && delay != null ? new Date(Date.now() + delay * 60_000) : null } });
    if (attempts < MAX_BALANCE_ATTEMPTS) {
      log.warn("upsell.merge_unpaid_retry", "Merged offer's balance not recorded on the order yet (retried after backoff)", { chargeId: c.id, attempts, delayMinutes: delay, reason: r.reason });
    } else {
      await recordEvent({
        storeId: c.session.storeId,
        sessionId: c.sessionId,
        level: "error",
        kind: "upsell.merge_unpaid_gave_up",
        message: `Paiement Whop de l'offre « ${c.title} » (${formatAmount(c.amountCents, c.session.currency)}) toujours absent de ${c.shopifyOrderName ?? "la commande d'origine"} (${r.reason}) : marquez ce montant comme payé dans Shopify.`,
        data: { chargeId: c.id },
        alert: true,
      });
    }
  }
  return settled;
}

/** A second payment for an offer that is already paid: alert once per payment, keep the id for refunds. */
async function reportDuplicateOffer(charge: { id: string; sessionId: string; title: string; whopPaymentId: string | null; previousPaymentIds: string[] }, paymentId: string, storeId: string) {
  if (charge.previousPaymentIds.includes(paymentId)) return;
  await db.upsellCharge.update({ where: { id: charge.id }, data: { previousPaymentIds: { push: paymentId } } });
  await recordEvent({
    storeId,
    sessionId: charge.sessionId,
    level: "error",
    kind: "payment.duplicate",
    message: `Offre « ${charge.title} » payée deux fois (${charge.whopPaymentId} et ${paymentId}) : remboursez le doublon ${paymentId} dans Whop.`,
    data: { paymentId, chargeId: charge.id },
    alert: true,
  });
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
      syncHandledAt: null,
      whopPaymentId: { not: null },
      // Offers of an order held for review wait with it.
      session: { reviewNote: null },
      OR: [{ nextSyncAt: { lte: new Date() } }, { syncAttempts: 0, createdAt: { lt: new Date(Date.now() - 3 * 60_000) } }],
    },
    include: { session: { select: { storeId: true } } },
    take: 30,
    // Never tried first, then the longest overdue; stores in turn (rotated from run to run), so one
    // poisoned offer (or store) can't hold the batch.
    orderBy: [{ nextSyncAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
  });
  const { list, advance } = await fairByStore(
    "upsellRetried",
    due.map((c) => ({ ...c, storeId: c.session.storeId })),
  );
  let done = 0;
  try {
    for (const c of list.slice(0, 10)) {
      if (stopForTime(deadline)) break;
      await markUpsellPaid(c.id, c.whopPaymentId!, c.storeId);
      // Out of time inside (lease released, nothing sent): the rest waits for the next run.
      if (partialNoted()) break;
      done++;
    }
  } finally {
    await advance();
  }
  return done;
}

/** Refund on an offer's payment: counted once per refund id, then mirrored on the offer's own Shopify order. */
export async function recordUpsellRefund(chargeId: string, refundId: string, amountCents: number) {
  if (amountCents <= 0) return;
  const applied = await applyRefundOnce(refundId, async (tx) => {
    const charge = await tx.upsellCharge.update({
      where: { id: chargeId },
      data: { refundedCents: { increment: amountCents }, refundMirrorAttempts: 0, nextRefundMirrorAt: null, lastRefundAt: new Date() },
      include: { session: { select: { storeId: true, currency: true } } },
    });
    await tx.refundRecord.create({
      data: { id: refundId, storeId: charge.session.storeId, sessionId: charge.sessionId, chargeId: charge.id, amountCents, currency: charge.session.currency },
    });
    // The order's Google Ads conversion value changed (offer refunded): adjusted by the tick.
    await tx.checkoutSession.update({ where: { id: charge.sessionId }, data: GOOGLE_ADJUST_DUE });
    return { ...charge, storeId: charge.session.storeId };
  });
  if (!applied) return;
  await recordEvent({
    storeId: applied.storeId,
    sessionId: applied.sessionId,
    kind: "refund.recorded",
    message: `Offre post-achat « ${applied.title} » remboursée (${amountCents / 100} ${applied.session.currency})`,
  });
  if (!applied.shopifyOrderId && !applied.syncHandledAt && applied.status === "PAID") await settleUnsyncedOffer(chargeId);
  if (applied.syncSkippedReason) return;
  if (applied.syncHandledAt && !applied.shopifyOrderId) {
    await recordEvent({
      storeId: applied.storeId,
      sessionId: applied.sessionId,
      level: "warn",
      kind: "refund.manual_order",
      message: `Remboursement Whop de ${formatAmount(amountCents, applied.session.currency)} sur l'offre « ${applied.title} » : reportez-le à la main sur ${applied.shopifyOrderName ?? "sa commande créée à la main"} dans Shopify (commande liée à la main, pas de report automatique).`,
      data: { refundId, amountCents, chargeId },
      alert: true,
    });
    return;
  }
  if (!defer("refund.mirror", () => mirrorUpsellRefunds(chargeId, { force: true }))) await mirrorUpsellRefunds(chargeId, { force: true });
}

/** Offer refunds on the offer's own Shopify order (see refunds.ts). Never throws. */
export function mirrorUpsellRefunds(chargeId: string, opts: { force?: boolean } = {}): Promise<number> {
  return mirrorRefund("offer", chargeId, opts);
}

/**
 * Dispute on an offer's own payment. Evidence goes later, from the tick: once the
 * offer's order is tracked, or before Whop's due date.
 */
export async function recordUpsellDispute(paymentId: string, storeId: string, disputeId: string | null, dueAt: Date | null = null) {
  const charge = await db.upsellCharge.findUnique({ where: { whopPaymentId: paymentId }, include: { session: { include: { store: true } } } });
  if (!charge || charge.session.storeId !== storeId) return;
  if (disputeId && !charge.disputeId) {
    await db.upsellCharge.update({ where: { id: charge.id }, data: { disputeId, disputeDueAt: dueAt } });
  }
  const first = await db.upsellCharge.updateMany({ where: { id: charge.id, disputed: false }, data: { disputed: true, disputeOpenedAt: new Date() } });
  if (first.count === 0) {
    if (disputeId && charge.disputeId && disputeId !== charge.disputeId) {
      await recordEvent({ storeId, sessionId: charge.sessionId, level: "error", kind: "dispute.second", message: `Deuxième litige (${disputeId}) sur l'offre « ${charge.title} » : répondez-y dans Whop.`, alert: true });
    }
    return;
  }
  if (charge.shopifyOrderId) {
    const orderId = charge.shopifyOrderId;
    // Backstopped by the tick (disputeTaggedAt stays null until Shopify confirms).
    const tag = () =>
      tagOrder(charge.session.store, orderId, ["litige-whop"])
        .then(() => db.upsellCharge.update({ where: { id: charge.id }, data: { disputeTaggedAt: new Date() } }))
        .catch((err) => log.warn("dispute.tag_failed", "Could not tag the disputed offer order (the tick retries)", { chargeId: charge.id, err }));
    if (!defer("dispute.tag", tag)) await tag();
  } else if (charge.syncHandledAt && !charge.syncSkippedReason) {
    await recordEvent({
      storeId,
      sessionId: charge.sessionId,
      level: "warn",
      kind: "dispute.manual_order",
      message: `Litige sur l'offre « ${charge.title} » (commande ${charge.shopifyOrderName ?? "créée à la main"}, liée à la main) : ajoutez le tag « litige-whop » dans Shopify et fournissez le numéro de suivi à la main dans Whop (aucun envoi automatique).`,
      data: { disputeId },
      alert: true,
    });
  }
  await recordEvent({
    storeId,
    sessionId: charge.sessionId,
    level: "warn",
    kind: "dispute.created",
    message: `Litige ouvert sur une offre post-achat (${charge.title}, ${charge.amountCents / 100} ${charge.session.currency})${
      charge.session.store.autoDisputeEvidence ? " : preuves envoyées automatiquement dès le suivi connu, ou avant l'échéance." : "."
    }`,
    alert: true,
  });
}

/** Counts the offers as shown (acceptance rate = accepted / shown, per offer block). */
export async function markUpsellShown(sessionId: string, blockIds: string[] = []) {
  await db.checkoutSession.updateMany({ where: { id: sessionId, upsellShownAt: null }, data: { upsellShownAt: new Date() } });
  const ids = [...new Set(blockIds)].slice(0, 10);
  if (ids.length) {
    await db.$executeRaw`
      UPDATE "CheckoutSession" SET "upsellShownBlocks" = ARRAY(SELECT DISTINCT unnest("upsellShownBlocks" || ${ids}::text[]))
      WHERE id = ${sessionId}`;
  }
}
