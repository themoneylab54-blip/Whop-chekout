import "server-only";
import { breakerOpen, DeadlineError, notePartial, stopForTime } from "./deadline";
import { defer } from "./deferred";
import type { CheckoutSession, Store } from "@prisma/client";
import { db } from "./db";
import { designFor } from "./experiments";
import { paymentOwner, resolvePayment } from "./payments";
import { loadTheme } from "./layout";
import { log, recordEvent } from "./log";
import type { CartLine } from "./pricing";
import { disputeTag, orderTracking, ShopifyError, tagOrder, type Address } from "./shopify";
import { refundPayment, storeClient, whopCallOptions } from "./whop";
import { refundStripe, stripeForMode, submitStripeDispute } from "./stripe";
import type Stripe from "stripe";

/*
 * Dispute shield: everything that keeps chargebacks (and the Whop account) under control.
 * - tracking numbers from Shopify fulfillments are pushed to Whop (proof of delivery)
 * - when a dispute opens, evidence is filled and submitted automatically
 * - early fraud warnings can trigger an automatic refund before they become disputes
 */

type SessionWithStore = CheckoutSession & { store: Store };

/**
 * The store as Stripe calls about this checkout's payment must see it: on the connected account the
 * PaymentIntent was created on (kept on the session: still right after a disconnect or a new account),
 * in the payment's own mode (session.test, set from its livemode: still right after a mode switch).
 */
function stripeStoreOf(session: SessionWithStore): Store {
  return stripeForMode(session.store, !session.test, session.stripeAccountId);
}

/**
 * Pushes the first tracking number of the Shopify order to the Whop payment. Stripe payments: only
 * recorded here (no push; the number goes with the dispute evidence).
 */
export async function pushTracking(session: SessionWithStore): Promise<boolean> {
  if (!session.shopifyOrderId || !session.whopPaymentId) return false;
  // Claim (overlapping runs must not create the Whop shipment twice).
  const claim = await db.checkoutSession.updateMany({
    where: {
      id: session.id,
      trackingPushedAt: null,
      OR: [{ trackingCheckedAt: null }, { trackingCheckedAt: { lt: new Date(Date.now() - 5 * 60_000) } }],
    },
    data: { trackingCheckedAt: new Date() },
  });
  if (claim.count === 0) return false;
  const tracking = await orderTracking(session.store, session.shopifyOrderId);
  const first = tracking[0];
  if (!first) return false;
  if (session.paymentProvider === "stripe") {
    // Stripe has no shipment API (Whop-only push): the number is kept for the dispute evidence
    // (shipping_tracking_number / shipping_carrier), sent with it if the payment is ever disputed.
    await db.checkoutSession.update({ where: { id: session.id }, data: { trackingNumber: first.number, trackingPushedAt: new Date(), trackingPushError: null } });
    await recordEvent({
      storeId: session.storeId,
      sessionId: session.id,
      kind: "tracking.recorded",
      message: `Suivi ${first.number}${first.company ? ` (${first.company})` : ""} enregistré pour ${session.shopifyOrderName ?? "la commande"} (preuve de livraison en cas de litige Stripe)`,
    });
    return true;
  }
  // Idempotency key: a run killed before recording the push can't create the shipment twice.
  await storeClient(session.store).shipments.create(
    {
      account_id: session.store.whopAccountId ?? undefined,
      payment_id: session.whopPaymentId,
      tracking_number: first.number,
    },
    { ...whopCallOptions("Whop suivi"), idempotencyKey: `ship_${session.id}_${first.number}`.slice(0, 200) },
  );
  await db.checkoutSession.update({
    where: { id: session.id },
    data: { trackingNumber: first.number, trackingPushedAt: new Date(), trackingPushError: null },
  });
  await recordEvent({
    storeId: session.storeId,
    sessionId: session.id,
    kind: "tracking.pushed",
    message: `Suivi ${first.number}${first.company ? ` (${first.company})` : ""} transmis à Whop pour ${session.shopifyOrderName ?? "la commande"}`,
  });
  return true;
}

/** Failed tracking pushes are journaled from this try on (one failure is often transient). */
export const TRACKING_WARN_AFTER = 3;
/** Past this many failed tries (one every 6 h), the push is given up: the merchant adds the tracking in Whop. */
export const TRACKING_MAX_ATTEMPTS = 6;

/**
 * A tracking push failed (Shopify or Whop error): counted, journaled from the 3rd try
 * (warn, alert once), given up after TRACKING_MAX_ATTEMPTS (error, alert). The claim's
 * trackingCheckedAt spaces the retries (6 h).
 */
export async function recordTrackingFailure(session: Pick<CheckoutSession, "id" | "storeId" | "shopifyOrderName" | "trackingPushAttempts">, err: unknown) {
  const reason = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  const attempts = session.trackingPushAttempts + 1;
  const gaveUp = attempts >= TRACKING_MAX_ATTEMPTS;
  await db.checkoutSession.update({
    where: { id: session.id },
    data: { trackingPushAttempts: attempts, trackingPushError: reason, ...(gaveUp ? { trackingGaveUpAt: new Date() } : {}) },
  });
  if (gaveUp) {
    await recordEvent({
      storeId: session.storeId,
      sessionId: session.id,
      level: "error",
      kind: "tracking.gave_up",
      message: `Suivi de ${session.shopifyOrderName ?? "la commande"} jamais transmis à Whop après ${attempts} essais (${reason}) : ajoutez le numéro de suivi à la main dans Whop (preuve de livraison en cas de litige).`,
      data: { attempts },
      alert: true,
    });
  } else if (attempts >= TRACKING_WARN_AFTER) {
    await recordEvent({
      storeId: session.storeId,
      sessionId: session.id,
      level: "warn",
      kind: "tracking.push_failed",
      message: `Envoi du suivi de ${session.shopifyOrderName ?? "la commande"} à Whop en échec (essai ${attempts}/${TRACKING_MAX_ATTEMPTS} : ${reason}) : nouvel essai automatique dans 6 h.`,
      data: { attempts },
      alert: attempts === TRACKING_WARN_AFTER,
    });
  }
  return { attempts, gaveUp };
}

type OfferEvidence = {
  id: string;
  title: string;
  amountCents: number;
  paidAt: Date;
  shopifyOrderId: string | null;
  shopifyOrderName: string | null;
  /** The offer's own payment (Stripe: its PaymentIntent), cited in the evidence instead of the checkout's. */
  paymentId?: string | null;
};

/** Text evidence built from what the checkout knows: order, delivery, consent, policies. */
export function buildEvidence(
  session: CheckoutSession,
  tracking: { number: string; company: string | null; url: string | null }[],
  policyUrls: string[],
  opts: { withdrawalShown?: boolean; offer?: Omit<OfferEvidence, "id" | "shopifyOrderId"> & { shopifyOrderName?: string | null } } = {},
) {
  const a = session.shippingAddress as Address | null;
  const lines = session.lines as unknown as CartLine[];
  const money = (c: number) => `${(c / 100).toFixed(2)} ${session.currency}`;
  const offer = opts.offer;
  const notes = [
    offer
      ? `Achat contesté : offre post-achat « ${offer.title} » (${money(offer.amountCents)}) acceptée en un clic par le client le ${offer.paidAt.toISOString().slice(0, 10)}, juste après sa commande ${session.shopifyOrderName ?? session.id} (${money(session.totalCents)}). Commande distincte${offer.shopifyOrderName ? ` ${offer.shopifyOrderName}` : ""}, livrée à la même adresse.`
      : `Commande ${session.shopifyOrderName ?? session.id} payée le ${session.paidAt?.toISOString().slice(0, 10) ?? "?"} pour ${money(session.totalCents)}.`,
    tracking.length
      ? `Expédiée : ${tracking.map((t) => `${t.company ?? "transporteur"} ${t.number}${t.url ? ` (${t.url})` : ""}`).join(", ")}.`
      : "Numéro de suivi non encore disponible.",
    session.termsAcceptedAt ? `Le client a accepté les CGV le ${session.termsAcceptedAt.toISOString()}.` : null,
    session.clientIp ? `Adresse IP lors de la commande : ${session.clientIp}.` : null,
    a ? `Adresse de livraison : ${[a.address1, a.address2, `${a.zip} ${a.city}`, a.countryCode].filter(Boolean).join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    customer_email_address: session.email,
    customer_name: a ? `${a.firstName} ${a.lastName}`.trim() : null,
    billing_address: a ? [a.address1, a.address2, a.zip, a.city, a.countryCode].filter(Boolean).join(", ") : null,
    product_description: (offer
      ? `1 × ${offer.title} (offre post-achat)`
      : lines.map((l) => `${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`).join("; ")
    ).slice(0, 1000),
    service_date: (offer?.paidAt ?? session.paidAt ?? session.createdAt).toISOString().slice(0, 10),
    // Only claim what the buyer was actually shown.
    cancellation_policy_disclosure: opts.withdrawalShown
      ? "Droit de rétractation de 14 jours à compter de la réception, rappelé au client sur la page de confirmation de commande."
      : "Droit de rétractation de 14 jours à compter de la réception, conformément aux conditions générales de vente.",
    refund_policy_disclosure: policyUrls.length
      ? `Politiques affichées au moment du paiement : ${policyUrls.join(" · ")}`
      : "Conditions de retour et de remboursement prévues par les conditions générales de vente de la boutique.",
    notes: notes.slice(0, 2000),
  };
}

/**
 * The same evidence in Stripe's fields (disputes.update): the buyer, the delivery (address, carrier,
 * tracking numbers), the product, the purchase IP, the policies, and the order's story (receipt /
 * order reference) as uncategorized text. Empty fields are left out. Pure.
 */
export function stripeEvidence(
  session: Pick<CheckoutSession, "id" | "shopifyOrderName" | "clientIp" | "shippingAddress" | "whopPaymentId"> & Partial<Pick<CheckoutSession, "lines" | "trackingPushedAt">>,
  tracking: { number: string; company: string | null; url: string | null; shippedAt?: string | null }[],
  base: ReturnType<typeof buildEvidence>,
  offer?: { paymentId?: string | null; shopifyOrderName?: string | null } | null,
): Stripe.DisputeUpdateParams.Evidence {
  const a = session.shippingAddress as Address | null;
  // Physical goods (shipped lines, or a parcel tracked): Stripe's shipping_date; a service's date otherwise.
  const lines = Array.isArray(session.lines) ? (session.lines as { requiresShipping?: boolean }[]) : [];
  const physical = tracking.length > 0 || lines.some((l) => l?.requiresShipping);
  // The shipping date: the first Shopify fulfillment's creation (of this order, or of the offer's own
  // order); else when the tracking number was first seen (checkout order only); else none — left out
  // rather than claiming the payment's date as a shipping date (not shipped yet, or date unknown).
  const fulfilledMs = tracking.map((t) => (t.shippedAt ? Date.parse(t.shippedAt) : NaN)).filter((ms) => Number.isFinite(ms));
  const shippedOn = fulfilledMs.length
    ? new Date(Math.min(...fulfilledMs)).toISOString().slice(0, 10)
    : !offer && session.trackingPushedAt
      ? session.trackingPushedAt.toISOString().slice(0, 10)
      : undefined;
  // An offer is its own payment (its own PaymentIntent and order): cited instead of the checkout's.
  const paymentRef = offer ? (offer.paymentId ?? null) : session.whopPaymentId;
  const orderRef = offer ? (offer.shopifyOrderName ?? `offre post-achat de la commande ${session.shopifyOrderName ?? session.id}`) : (session.shopifyOrderName ?? session.id);
  const out: Record<string, string | undefined> = {
    customer_email_address: base.customer_email_address ?? undefined,
    customer_name: base.customer_name ?? undefined,
    billing_address: base.billing_address ?? undefined,
    product_description: base.product_description || undefined,
    ...(physical ? { shipping_date: shippedOn } : { service_date: base.service_date }),
    shipping_address: a ? [`${a.firstName} ${a.lastName}`.trim(), a.address1, a.address2, `${a.zip} ${a.city}`, a.countryCode].filter(Boolean).join(", ") : undefined,
    shipping_carrier: tracking.find((t) => t.company)?.company ?? undefined,
    shipping_tracking_number: tracking.length ? tracking.map((t) => t.number).join(", ").slice(0, 500) : undefined,
    customer_purchase_ip: session.clientIp ?? undefined,
    cancellation_policy_disclosure: base.cancellation_policy_disclosure,
    refund_policy_disclosure: base.refund_policy_disclosure,
    uncategorized_text: `${base.notes}\nRéférence : commande ${orderRef}${paymentRef ? `, paiement ${paymentRef}` : ""}.`.slice(0, 20_000),
  };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => typeof v === "string" && v.trim() !== "")) as Stripe.DisputeUpdateParams.Evidence;
}

/** After this many failed automatic submissions, the merchant answers in Whop (or Stripe). */
export const MAX_EVIDENCE_TRIES = 3;

/**
 * Fills and submits the dispute's evidence in Whop, with the design the buyer
 * actually saw (A/B variant included). Never throws; returns whether it was sent.
 * Failures are retried by the tick with backoff; the merchant is alerted once,
 * when automatic submission gives up.
 */
export async function submitDisputeEvidence(session: SessionWithStore, disputeId: string, offer?: OfferEvidence): Promise<boolean> {
  // Lease: overlapping runs (tick, webhook) must not submit the same evidence twice.
  const leaseWhere = {
    disputeEvidenceAt: null,
    OR: [{ disputeEvidenceStartedAt: null }, { disputeEvidenceStartedAt: { lt: new Date(Date.now() - 5 * 60_000) } }],
  };
  const lease = offer
    ? await db.upsellCharge.updateMany({ where: { id: offer.id, ...leaseWhere }, data: { disputeEvidenceStartedAt: new Date() } })
    : await db.checkoutSession.updateMany({ where: { id: session.id, ...leaseWhere }, data: { disputeEvidenceStartedAt: new Date() } });
  if (lease.count === 0) return false;
  try {
    const orderId = offer ? offer.shopifyOrderId : session.shopifyOrderId;
    const tracking = orderId ? await evidenceTracking(session, orderId, offer) : [];
    const design = await designFor(session.store, session);
    const theme = loadTheme(design.theme, session.store.name);
    const evidence = buildEvidence(session, tracking, theme.policyLinks.map((p) => p.url), {
      withdrawalShown: theme.withdrawalNotice,
      offer,
    });
    if (session.paymentProvider === "stripe") {
      // The dispute read, then the evidence filled and submitted (submit: true) on the connected account
      // the payment was made on — unless it was already answered (in Stripe) or needs no response.
      const res = await submitStripeDispute(stripeStoreOf(session), disputeId, stripeEvidence(session, tracking, evidence, offer ?? null));
      if ("skipped" in res) {
        const done = { disputeEvidenceAt: new Date(), disputeEvidenceStartedAt: null };
        if (offer) await db.upsellCharge.update({ where: { id: offer.id }, data: done });
        else await db.checkoutSession.update({ where: { id: session.id }, data: done });
        await recordEvent({
          storeId: session.storeId,
          sessionId: session.id,
          kind: "dispute.evidence_skipped",
          message: `Litige ${disputeId}${offer ? ` (offre « ${offer.title} »)` : ""} déjà traité dans Stripe (${res.skipped}) : aucune preuve envoyée automatiquement.`,
          data: { disputeId },
        });
        return false;
      }
    } else {
      const client = storeClient(session.store);
      // Each call bounded by the time left when it starts (the tracking read above may have used some).
      await client.disputes.update({ id: disputeId, evidence }, whopCallOptions("Whop litige"));
      await client.disputes.submit({ id: disputeId }, whopCallOptions("Whop litige"));
    }
    const done = { disputeEvidenceAt: new Date(), disputeEvidenceStartedAt: null };
    if (offer) await db.upsellCharge.update({ where: { id: offer.id }, data: done });
    else await db.checkoutSession.update({ where: { id: session.id }, data: done });
    await recordEvent({
      storeId: session.storeId,
      sessionId: session.id,
      kind: "dispute.evidence_submitted",
      message: `Preuves envoyées automatiquement pour le litige ${disputeId}${offer ? ` (offre « ${offer.title} »)` : ""}${tracking.length ? " (avec suivi)" : ""}`,
    });
    return true;
  } catch (err) {
    if (err instanceof DeadlineError) {
      const release = { disputeEvidenceStartedAt: null };
      if (offer) await db.upsellCharge.update({ where: { id: offer.id }, data: release });
      else await db.checkoutSession.update({ where: { id: session.id }, data: release });
      notePartial();
      return false;
    }
    const failed = { disputeEvidenceTries: { increment: 1 }, disputeLastTryAt: new Date(), disputeEvidenceStartedAt: null };
    const updated = offer
      ? await db.upsellCharge.update({ where: { id: offer.id }, data: failed })
      : await db.checkoutSession.update({ where: { id: session.id }, data: failed });
    const last = updated.disputeEvidenceTries >= MAX_EVIDENCE_TRIES;
    await recordEvent({
      storeId: session.storeId,
      sessionId: session.id,
      level: last ? "error" : "warn",
      kind: last ? "dispute.evidence_gave_up" : "dispute.evidence_failed",
      message: last
        ? `Envoi automatique des preuves impossible après ${updated.disputeEvidenceTries} essais (${err instanceof Error ? err.message : String(err)}) : répondez au litige ${disputeId} dans ${session.paymentProvider === "stripe" ? "Stripe" : "Whop"}${updated.disputeDueAt ? ` avant le ${updated.disputeDueAt.toISOString().slice(0, 10)}` : ""}.`
        : `Envoi des preuves du litige ${disputeId} en échec (essai ${updated.disputeEvidenceTries}/${MAX_EVIDENCE_TRIES}, ${err instanceof Error ? err.message : String(err)}) : nouvel essai automatique.`,
      alert: last,
      err,
    });
    return false;
  }
}

type Tracking = { number: string; company: string | null; url: string | null; shippedAt?: string | null }[];

/**
 * The parcel's tracking for the evidence, read from Shopify. A read failure is never swallowed blindly:
 * - DeadlineError: rethrown (the lease is released, the next run retries without spending a try);
 * - a checkout order: falls back to the tracking number the tracking push stored (already sent to Whop);
 * - a one-click offer (nothing stored): a transient failure (Shopify down, throttled) is rethrown — a
 *   counted try with backoff (1 h, 4 h) — unless the evidence is due anyway (close to the due date,
 *   waited long enough) or this is the last try: then it goes without tracking rather than not at all.
 */
export async function evidenceTracking(session: SessionWithStore, orderId: string, offer?: { id: string }): Promise<Tracking> {
  try {
    return await orderTracking(session.store, orderId);
  } catch (err) {
    // Out of time: rethrown — unless Shopify hung earlier in this run (its breaker is open): then it is a
    // Shopify failure like any other below, so the evidence (a Whop call, due date) isn't held by Shopify.
    if (err instanceof DeadlineError && !breakerOpen("shopify")) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    if (!offer) {
      log.warn("dispute.tracking_read_failed", "Tracking read failed: evidence uses the stored tracking number", { sessionId: session.id, stored: !!session.trackingNumber, err });
      return session.trackingNumber ? [{ number: session.trackingNumber, company: null, url: null }] : [];
    }
    const charge = await db.upsellCharge.findUnique({
      where: { id: offer.id },
      select: { disputeDueAt: true, disputeOpenedAt: true, disputeEvidenceTries: true },
    });
    const transient = err instanceof ShopifyError ? err.transient : true;
    const dueAnyway = !!charge && evidenceDue({ ...charge, openedAt: charge.disputeOpenedAt ?? new Date(), lastTryAt: null, tracked: false });
    const lastTry = !!charge && charge.disputeEvidenceTries + 1 >= MAX_EVIDENCE_TRIES;
    // Shopify suspended for this run (breaker): waits for the next run without spending a try.
    if (err instanceof DeadlineError && !dueAnyway && !lastTry) throw err;
    if (transient && !dueAnyway && !lastTry) throw new ShopifyError(`Suivi Shopify illisible : ${reason}`, true);
    log.warn("dispute.tracking_read_failed", "Tracking read failed: offer evidence sent without tracking", { sessionId: session.id, chargeId: offer.id, dueAnyway, lastTry, err });
    return [];
  }
}

const HOUR = 3600_000;
/** Evidence waits for a tracking number, but never past this margin before the due date. */
const DUE_MARGIN_MS = 48 * HOUR;
/** Without a due date from Whop, evidence waits at most this long for tracking. */
const MAX_WAIT_MS = 3 * 24 * HOUR;

/** Should the evidence go now? Tracked parcel, due date close, or waited long enough. Failed tries back off 1h, 4h. */
export function evidenceDue(
  d: { disputeDueAt: Date | null; disputeEvidenceTries: number; openedAt: Date; lastTryAt: Date | null; tracked: boolean },
  now = Date.now(),
) {
  if (d.disputeEvidenceTries >= MAX_EVIDENCE_TRIES) return false;
  if (d.lastTryAt && now - d.lastTryAt.getTime() < (d.disputeEvidenceTries === 1 ? 1 : 4) * HOUR) return false;
  if (d.tracked) return true;
  if (d.disputeDueAt) return d.disputeDueAt.getTime() - now < DUE_MARGIN_MS;
  return now - d.openedAt.getTime() >= MAX_WAIT_MS;
}

/**
 * evidenceDue's timing conditions as a query filter (tries left, backoff over, and — unless the parcel
 * is tracked — due date close or waited long enough), so the batch only holds disputes due now: a
 * head of disputes waiting for tracking or backing off can never hide the due ones behind it.
 */
export function evidenceDueWhere(now = Date.now()) {
  const backoffOver = {
    OR: [{ disputeLastTryAt: null }, { disputeEvidenceTries: 1, disputeLastTryAt: { lte: new Date(now - HOUR) } }, { disputeLastTryAt: { lte: new Date(now - 4 * HOUR) } }],
  };
  const dueAnyway = {
    OR: [{ disputeDueAt: { lt: new Date(now + DUE_MARGIN_MS) } }, { disputeDueAt: null, disputeOpenedAt: { lte: new Date(now - MAX_WAIT_MS) } }],
  };
  // dueAnyway's exact complement, spelled out (SQL's NOT over NULL columns would drop rows).
  const notDueAnyway = {
    OR: [
      { disputeDueAt: { gte: new Date(now + DUE_MARGIN_MS) } },
      { disputeDueAt: null, OR: [{ disputeOpenedAt: null }, { disputeOpenedAt: { gt: new Date(now - MAX_WAIT_MS) } }] },
    ],
  };
  return { backoffOver, dueAnyway, notDueAnyway };
}

/** Oldest disputes first (closest due date first), for sessions and one-click offers. */
export async function submitDueDisputeEvidence(deadline: number): Promise<number> {
  const { backoffOver, dueAnyway, notDueAnyway } = evidenceDueWhere();
  const open = { disputeId: { not: null }, disputeEvidenceAt: null, disputeEvidenceTries: { lt: MAX_EVIDENCE_TRIES } };
  // A finished dispute (won/lost/closed) can't take evidence any more.
  const unfinished = { OR: [{ disputeStatus: null }, { disputeStatus: { notIn: ["won", "lost", "closed"] } }] };
  const [sessions, offersDue] = await Promise.all([
    db.checkoutSession.findMany({
      where: {
        ...open,
        store: { autoDisputeEvidence: true },
        // Tracking comes from the tracking push job (no Shopify call per dispute per tick).
        AND: [unfinished, backoffOver, { OR: [{ trackingNumber: { not: null } }, dueAnyway] }],
      },
      include: { store: true },
      orderBy: [{ disputeDueAt: { sort: "asc", nulls: "last" } }, { paidAt: "asc" }],
      take: 10,
    }),
    // Offers: the ones due anyway (due date close, or none and waited long enough — decided in SQL, like
    // the sessions), in a batch of their own, so offers still waiting for tracking can never fill the batch
    // ahead of them.
    db.upsellCharge.findMany({
      where: { ...open, session: { store: { autoDisputeEvidence: true } }, AND: [unfinished, backoffOver, dueAnyway] },
      include: { session: { include: { store: true } } },
      orderBy: [{ disputeDueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
      take: 10,
    }),
  ]);
  // Then those whose tracking (read from Shopify) could make them due: never due anyway, with an order.
  const tracking = await db.upsellCharge.findMany({
    where: { ...open, id: { notIn: offersDue.map((c) => c.id) }, shopifyOrderId: { not: null }, session: { store: { autoDisputeEvidence: true } }, AND: [unfinished, backoffOver, notDueAnyway] },
    include: { session: { include: { store: true } } },
    orderBy: [{ disputeDueAt: { sort: "asc", nulls: "last" } }, { createdAt: "asc" }],
    take: 10,
  });
  const offers = [...offersDue, ...tracking];
  let n = 0;
  // Timing lives in columns (not in journal text): opened when first seen, last failed try.
  const timing = (d: { disputeOpenedAt: Date | null; disputeLastTryAt: Date | null }) => ({ openedAt: d.disputeOpenedAt ?? new Date(), lastTryAt: d.disputeLastTryAt });
  for (const s of sessions) {
    if (stopForTime(deadline)) break;
    if (!evidenceDue({ ...s, ...timing(s), tracked: !!s.trackingNumber })) continue;
    if (await submitDisputeEvidence(s, s.disputeId!)) n++;
  }
  for (const c of offers) {
    if (stopForTime(deadline)) break;
    const store = c.session.store;
    // Shopify is asked only when tracking could change the decision (not already due).
    const dueAnyway = evidenceDue({ ...c, ...timing(c), tracked: false });
    let tracked = false;
    if (!dueAnyway && c.shopifyOrderId) {
      try {
        tracked = !!(await orderTracking(store, c.shopifyOrderId))[0]?.number;
      } catch (err) {
        // Out of time: the rest waits for the next run (never read as "not tracked").
        if (err instanceof DeadlineError) {
          notePartial();
          break;
        }
        // Unknown for now: it waits (not due yet) and is looked at again next run.
        log.warn("dispute.tracking_read_failed", "Could not read an offer's tracking: evidence waits", { chargeId: c.id, err });
        continue;
      }
    }
    if (!dueAnyway && !evidenceDue({ ...c, ...timing(c), tracked })) continue;
    const ok = await submitDisputeEvidence(c.session, c.disputeId!, {
      id: c.id,
      title: c.title,
      amountCents: c.amountCents,
      paidAt: c.createdAt,
      shopifyOrderId: c.shopifyOrderId,
      shopifyOrderName: c.shopifyOrderName,
      paymentId: c.whopPaymentId,
    });
    if (ok) n++;
  }
  return n;
}

/** Whop's deadline for evidence, when the event carries it. */
export function disputeDueDate(data: Record<string, unknown>): Date | null {
  // Webhook shape: evidence_due_at; list API shape: needs_response_by.
  const v = data.evidence_due_at ?? data.needs_response_by;
  const t = typeof v === "string" ? new Date(v) : null;
  return t && Number.isFinite(t.getTime()) ? t : null;
}

/**
 * Early fraud warning from the card network: refunding now avoids a chargeback
 * (fee + dispute ratio). Only when the merchant opted in.
 */
export async function handleDisputeAlert(storeId: string, alert: { id?: string; payment_id?: string | null; type?: string; amount?: number }) {
  // Whop alert types: fraud (early fraud warning), dispute, dispute_rdr (Visa RDR: the
  // issuer already refunded the buyer — refunding again would pay twice).
  // Whop alert types: early_fraud_warning (TC40/SAFE), dispute_alert (pre-dispute notice),
  // rapid_dispute_resolution (Visa RDR: the network already refunded the buyer — refunding
  // again would pay twice; nothing is left to do).
  const rdr = alert.type === "rapid_dispute_resolution" || alert.type === "dispute_rdr";
  const kind = alert.type === "early_fraud_warning" || alert.type === "fraud" ? "alerte de fraude" : rdr ? "remboursement bancaire automatique (Visa RDR)" : "alerte de litige";
  const target = alert.payment_id ? await resolvePayment(storeId, alert.payment_id) : null;
  if (!target) {
    // Another store on the same Whop account: it gets the same alert and handles it.
    const owner = alert.payment_id ? await paymentOwner(storeId, { paymentId: alert.payment_id, productId: (alert as { product_id?: string | null }).product_id ?? null }) : null;
    if (owner?.kind === "sibling") {
      const other = await db.store.findUnique({ where: { id: owner.storeId }, select: { name: true } });
      await recordEvent({ storeId, kind: "dispute_alert.other_store", message: `${kind} sur un paiement de la boutique « ${other?.name ?? owner.storeId} » (même compte Whop) : traitée par celle-ci.`, data: { paymentId: alert.payment_id ?? null } });
      return;
    }
    await recordEvent({
      storeId,
      level: "warn",
      kind: "dispute_alert.foreign",
      message: `${kind} reçue sur un paiement Whop inconnu de cette boutique (${alert.payment_id ?? "sans paiement"}) : vérifiez dans Whop.`,
      alert: true,
    });
    return;
  }
  const session = await db.checkoutSession.findUniqueOrThrow({ where: { id: target.sessionId }, include: { store: true } });
  // Offers and duplicate payments are refunded by hand (their amounts differ from the order's).
  if (target.kind !== "session") {
    await recordEvent({
      storeId,
      sessionId: session.id,
      level: "warn",
      kind: "dispute_alert.created",
      message: `${kind} reçue sur ${target.kind === "offer" ? "une offre post-achat" : target.kind === "offer_attempt" ? "un ancien essai d'offre" : "un paiement en double"} (${alert.payment_id}) de ${session.shopifyOrderName ?? "cette commande"} : un remboursement rapide dans Whop évite souvent un litige.`,
      alert: true,
    });
    return;
  }
  if (rdr) {
    await recordEvent({
      storeId,
      sessionId: session.id,
      level: "warn",
      kind: "dispute_alert.rdr",
      message: `${session.shopifyOrderName ?? "Une commande"} a été remboursée directement par la banque du client (Visa RDR) : rien à faire dans Whop. Annulez ou ajustez la commande dans Shopify si elle n'est pas encore expédiée.`,
      data: { alertId: alert.id ?? null },
      alert: true,
    });
    return;
  }
  if (session.store.autoRefundFraudAlerts && session.refundedCents < session.totalCents && session.whopPaymentId) {
    // Persist the decision before answering Whop: the refund itself runs after the answer,
    // and the tick retries it until Whop confirms (same key per payment: never refunded twice,
    // even when an early-fraud warning and a dispute alert both arrive).
    await db.checkoutSession.updateMany({
      where: { id: session.id, alertRefundPendingAt: null },
      data: { alertRefundPendingAt: new Date(), alertRefundKey: `alert_refund_${session.whopPaymentId}`, alertRefundAttempts: 0, alertRefundNextAt: null },
    });
    await recordEvent({
      storeId,
      sessionId: session.id,
      level: "warn",
      kind: "dispute_alert.refund_scheduled",
      message: `${kind} reçue sur ${session.shopifyOrderName ?? "une commande"} : remboursement automatique en cours pour éviter un litige.`,
    });
    const run = () => runAlertRefund(session.id);
    if (!defer("dispute_alert.refund", run)) await run();
    return;
  }
  await recordEvent({
    storeId,
    sessionId: session.id,
    level: "warn",
    kind: "dispute_alert.created",
    message: `${kind} reçue sur ${session.shopifyOrderName ?? "une commande"} (${session.totalCents / 100} ${session.currency}) : un remboursement rapide évite souvent un litige.`,
    alert: true,
  });
}

const ALERT_REFUND_GIVE_UP_MS = 24 * 3600_000;
/** Minutes before each retry of a failed fraud-alert refund (the tick only retries due ones). */
export const ALERT_REFUND_BACKOFF_MINUTES = [5, 15, 30, 60, 120, 240];

/** A fraud-alert refund lease older than this belongs to a run that died (a refund call is bounded well under it). */
const ALERT_REFUND_LEASE_MS = 5 * 60_000;

/**
 * Executes a pending fraud-alert refund (idempotent per payment). Never throws. Leased
 * (alertRefundStartedAt): the webhook's after-response run and the tick's retry never send it at the
 * same time. Skipped once the payment is disputed: the chargeback already takes the money back, a
 * refund on top would pay the buyer twice.
 */
export async function runAlertRefund(sessionId: string): Promise<boolean> {
  const s = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!s?.alertRefundPendingAt || !s.alertRefundKey || !s.whopPaymentId) return false;
  const done = { alertRefundPendingAt: null, alertRefundNextAt: null, alertRefundStartedAt: null };
  if (s.refundedCents >= s.totalCents) {
    await db.checkoutSession.update({ where: { id: sessionId }, data: done });
    return true;
  }
  const lease = await db.checkoutSession.updateMany({
    where: {
      id: sessionId,
      alertRefundPendingAt: { not: null },
      OR: [{ alertRefundStartedAt: null }, { alertRefundStartedAt: { lt: new Date(Date.now() - ALERT_REFUND_LEASE_MS) } }],
    },
    data: { alertRefundStartedAt: new Date() },
  });
  if (lease.count === 0) return false;
  // Re-read under the lease: a dispute (or a refund) may have landed since the decision.
  const now = await db.checkoutSession.findUnique({ where: { id: sessionId }, select: { disputed: true, refundedCents: true, totalCents: true, alertRefundPendingAt: true } });
  if (!now?.alertRefundPendingAt) {
    await db.checkoutSession.update({ where: { id: sessionId }, data: { alertRefundStartedAt: null } });
    return false;
  }
  if (now.disputed) {
    await db.checkoutSession.update({ where: { id: sessionId }, data: done });
    await recordEvent({
      storeId: s.storeId,
      sessionId,
      level: "warn",
      kind: "dispute_alert.refund_skipped",
      message: `Remboursement automatique de ${s.shopifyOrderName ?? "la commande"} annulé : un litige est déjà ouvert sur ce paiement (la banque reprend déjà l'argent, rembourser en plus paierait deux fois). Répondez au litige dans Whop.`,
    });
    return false;
  }
  if (now.refundedCents >= now.totalCents) {
    await db.checkoutSession.update({ where: { id: sessionId }, data: done });
    return true;
  }
  try {
    if (s.paymentProvider === "stripe") await refundStripe(stripeStoreOf(s), s.whopPaymentId, undefined, s.alertRefundKey);
    else await refundPayment(s.store, s.whopPaymentId, undefined, s.alertRefundKey);
    await db.checkoutSession.update({ where: { id: sessionId }, data: done });
    await recordEvent({
      storeId: s.storeId,
      sessionId,
      level: "warn",
      kind: "dispute_alert.refunded",
      message: `${s.shopifyOrderName ?? "La commande"} a été remboursée automatiquement (alerte de la banque) pour éviter un litige.`,
      alert: true,
    });
    return true;
  } catch (err) {
    if (err instanceof DeadlineError) {
      // Refused before sending: the lease is given back, retried next run.
      await db.checkoutSession.update({ where: { id: sessionId }, data: { alertRefundStartedAt: null } });
      notePartial();
      return false;
    }
    const reason = err instanceof Error ? err.message : String(err);
    const gaveUp = Date.now() - s.alertRefundPendingAt.getTime() > ALERT_REFUND_GIVE_UP_MS;
    const attempts = s.alertRefundAttempts + 1;
    const delay = ALERT_REFUND_BACKOFF_MINUTES[Math.min(attempts, ALERT_REFUND_BACKOFF_MINUTES.length) - 1];
    const next = new Date(Date.now() + delay * 60_000);
    await db.checkoutSession.update({
      where: { id: sessionId },
      data: gaveUp ? { ...done, alertRefundAttempts: attempts } : { alertRefundAttempts: attempts, alertRefundNextAt: next, alertRefundStartedAt: null },
    });
    await recordEvent({
      storeId: s.storeId,
      sessionId,
      level: gaveUp ? "error" : "warn",
      kind: gaveUp ? "dispute_alert.refund_failed" : "dispute_alert.refund_retry",
      message: gaveUp
        ? `Remboursement automatique impossible depuis 24 h (${attempts} essais, ${reason}) : remboursez dans Whop pour éviter un litige.`
        : `Remboursement automatique en échec (essai ${attempts} : ${reason}) : nouvel essai dans ${delay} min.`,
      // Alert on the first failure (a human may want to refund at once) and when giving up.
      alert: gaveUp || attempts === 1,
      err,
    });
    return false;
  }
}

/** Tick backstop: fraud-alert refunds decided but not confirmed (cut-short webhook, Whop error). */
export async function retryAlertRefunds(deadline: number): Promise<number> {
  const due = await db.checkoutSession.findMany({
    where: {
      alertRefundPendingAt: { lt: new Date(Date.now() - 2 * 60_000) },
      OR: [{ alertRefundNextAt: null }, { alertRefundNextAt: { lte: new Date() } }],
      AND: [{ OR: [{ alertRefundStartedAt: null }, { alertRefundStartedAt: { lt: new Date(Date.now() - ALERT_REFUND_LEASE_MS) } }] }],
    },
    select: { id: true },
    orderBy: { alertRefundPendingAt: "asc" },
    take: 10,
  });
  let n = 0;
  for (const d of due) {
    if (stopForTime(deadline)) break;
    if (await runAlertRefund(d.id)) n++;
  }
  return n;
}

/** Minutes before each retry of the "litige-whop" tag; past the list, it gives up (a human tags it). */
export const DISPUTE_TAG_BACKOFF_MINUTES = [10, 30, 120, 360, 1440];
export const DISPUTE_TAG_MAX_ATTEMPTS = DISPUTE_TAG_BACKOFF_MINUTES.length + 1;

/**
 * Tick backstop of the "litige-whop" tag on disputed Shopify orders: the tag is added
 * after the webhook's answer (deferred), which a cut-short function can lose. Failures
 * back off; after DISPUTE_TAG_MAX_ATTEMPTS the order is given up loudly (journal + alert,
 * health counter) instead of being retried on every tick forever.
 */
export async function tagDisputedOrders(deadline: number): Promise<number> {
  const since = new Date(Date.now() - 180 * 24 * 3600_000);
  const due = { disputed: true, shopifyOrderId: { not: null }, disputeTaggedAt: null, disputeTagGaveUpAt: null, disputeOpenedAt: { gt: since }, OR: [{ nextDisputeTagAt: null }, { nextDisputeTagAt: { lte: new Date() } }] };
  const [sessions, offers] = await Promise.all([
    db.checkoutSession.findMany({ where: due, include: { store: true }, take: 10, orderBy: { disputeOpenedAt: "asc" } }),
    db.upsellCharge.findMany({ where: due, include: { session: { include: { store: true } } }, take: 10, orderBy: { disputeOpenedAt: "asc" } }),
  ]);
  type Item = { store: Store; orderId: string; orderName: string | null; sessionId: string; attempts: number; tag: string; ref: { sessionId: string } | { chargeId: string }; update: (data: { disputeTaggedAt?: Date; disputeTagAttempts?: number; nextDisputeTagAt?: Date | null; disputeTagGaveUpAt?: Date }) => Promise<unknown> };
  const items: Item[] = [
    ...sessions.map((s) => ({ store: s.store, orderId: s.shopifyOrderId!, orderName: s.shopifyOrderName, sessionId: s.id, attempts: s.disputeTagAttempts, tag: disputeTag(s.paymentProvider), ref: { sessionId: s.id }, update: (data: object) => db.checkoutSession.update({ where: { id: s.id }, data }) })),
    ...offers.map((c) => ({ store: c.session.store, orderId: c.shopifyOrderId!, orderName: c.shopifyOrderName, sessionId: c.sessionId, attempts: c.disputeTagAttempts, tag: disputeTag(c.provider), ref: { chargeId: c.id }, update: (data: object) => db.upsellCharge.update({ where: { id: c.id }, data }) })),
  ];
  let n = 0;
  for (const it of items) {
    if (stopForTime(deadline)) break;
    try {
      await tagOrder(it.store, it.orderId, [it.tag]);
      await it.update({ disputeTaggedAt: new Date(), nextDisputeTagAt: null });
      n++;
    } catch (err) {
      if (err instanceof DeadlineError) {
        notePartial();
        break;
      }
      const attempts = it.attempts + 1;
      const delay = DISPUTE_TAG_BACKOFF_MINUTES[attempts - 1];
      const reason = err instanceof Error ? err.message : String(err);
      if (delay == null) {
        await it.update({ disputeTagAttempts: attempts, nextDisputeTagAt: null, disputeTagGaveUpAt: new Date() });
        await recordEvent({
          storeId: it.store.id,
          sessionId: it.sessionId,
          level: "warn",
          kind: "dispute.tag_gave_up",
          message: `Tag « ${it.tag} » impossible à ajouter sur ${it.orderName ?? "la commande Shopify"} après ${attempts} essais (${reason}) : ajoutez-le à la main dans Shopify pour ne pas expédier ni rembourser deux fois.`,
          data: { ...it.ref, attempts },
          alert: true,
        });
      } else {
        await it.update({ disputeTagAttempts: attempts, nextDisputeTagAt: new Date(Date.now() + delay * 60_000) });
        log.warn("dispute.tag_failed", `Could not tag the disputed Shopify order (retry in ${delay} min)`, { ...it.ref, attempts, err });
      }
    }
  }
  return n;
}
