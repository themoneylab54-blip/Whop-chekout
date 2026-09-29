import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { applyRefundOnce, markPaid, recordDispute, recordPaymentFailure, recordRefund, settleUnsyncedSession, syncOrderSafely } from "./checkout";
import { disputeDueDate, handleDisputeAlert } from "./disputes";
import { log, recordEvent, withLogContext } from "./log";
import { DeadlineError, notePartial, stopForTime } from "./deadline";
import { defer } from "./deferred";
import { RetryLater } from "./retry-later";
import { GOOGLE_ADJUST_DUE, markGoogleAdjustDue } from "./google-conversions";
import { eventPaymentId, eventPaymentMetadata, eventProductId, paymentOwner, refundAmountIn, refundAmounts, resolvePayment, type PaymentOwner, type PaymentTarget } from "./payments";
import { markUpsellFailed, markUpsellPaid, recordUpsellDispute, recordUpsellRefund, settleUnsyncedOffer } from "./upsell";
import { eventType, paymentInfoFromWhop, storeClient, type WhopEvent } from "./whop";

/*
 * Whop event handling, shared by the webhook route and the background replay of
 * events whose handling was interrupted (crash, timeout).
 */

export { RetryLater };

/**
 * The run's time budget ran out (DeadlineError), directly or behind a RetryLater raised because Whop
 * couldn't be asked in time: not a failure of the event (no replay attempt spent, nothing journaled).
 */
export function isDeadline(err: unknown): boolean {
  return err instanceof DeadlineError || (err instanceof RetryLater && (err as { cause?: unknown }).cause instanceof DeadlineError);
}

/** Handles one event; returns a session id whose Shopify order must be created next. */
export async function handleEvent(type: string, data: Record<string, unknown>, storeId: string): Promise<string | null> {
  switch (type) {
    case "payment.succeeded": {
      // One-click post-purchase offers are separate payments on the same session.
      const metadata = (data.metadata ?? {}) as Record<string, unknown>;
      if (typeof metadata.upsell_id === "string") {
        await markUpsellPaid(metadata.upsell_id, String(data.id), storeId, paymentInfoFromWhop(data).feeCents);
        return null;
      }
      const sessionId = await sessionIdFor(data, storeId);
      if (!sessionId) {
        if (typeof metadata.checkout_session_id === "string") {
          // Webhooks are account-wide: another store on the same Whop account handles its own.
          const owner = await paymentOwner(storeId, { paymentId: typeof data.id === "string" ? data.id : null, metadata, productId: eventProductId(data) });
          if (owner.kind === "sibling") {
            await journalOtherStore(storeId, owner, "payment", `Paiement Whop ${String(data.id)}`, { paymentId: String(data.id) });
            return null;
          }
          // Metadata says it's one of our checkouts but the session is unknown: never drop it silently.
          await recordEvent({
            storeId,
            level: "error",
            kind: "payment.unknown_session",
            message: `Paiement Whop ${String(data.id)} reçu pour un checkout introuvable (${metadata.checkout_session_id}) : vérifiez-le dans Whop et créez la commande à la main si besoin.`,
            data: { paymentId: String(data.id) },
            alert: true,
          });
        }
        return null; // otherwise: not one of our checkouts (another product on this Whop account)
      }
      return (await markPaid(sessionId, paymentInfoFromWhop(data), { deferSync: true })) ? sessionId : null;
    }
    case "payment.failed": {
      const metadata = (data.metadata ?? {}) as Record<string, unknown>;
      if (typeof metadata.upsell_id === "string") {
        // A declined one-click offer: free the slot so the buyer can try again.
        await markUpsellFailed(
          metadata.upsell_id,
          storeId,
          typeof data.failure_message === "string" ? data.failure_message : null,
          typeof data.id === "string" ? data.id : null,
        );
        return null;
      }
      const sessionId = await sessionIdFor(data, storeId);
      if (sessionId) {
        // A late failure of an earlier attempt never erases a newer one: see recordPaymentFailure
        // (Whop's created_at is the attempt's time; our own PayPal confirm stamps paypalWindowAt
        // equal to its click, which the strict payClickedAt rule already covers).
        const reason = `${typeof data.failure_message === "string" && data.failure_message ? ` : ${data.failure_message}` : ""}${
          typeof data.payment_method_type === "string" ? ` (${data.payment_method_type})` : ""
        }`;
        await recordPaymentFailure(storeId, sessionId, paymentCreatedAt(data), reason);
      }
      return null;
    }
    case "refund.created":
    case "refund.updated": {
      if (data.status && data.status !== "succeeded") return null;
      // Webhooks embed the payment (`payment.id`); the list API has `payment_id`.
      const paymentId = eventPaymentId(data);
      const refundId = typeof data.id === "string" && data.id ? data.id : null;
      const target = paymentId ? await resolvePayment(storeId, paymentId, eventPaymentMetadata(data)) : null;
      if (!target) {
        // Not (yet) known: if it is one of ours, have Whop retry once the payment is recorded.
        const owner = paymentId ? await ownerOfEventPayment(storeId, paymentId, data) : null;
        if (owner?.kind === "ours") {
          await recordEvent({ storeId, level: "warn", kind: "refund.early", message: `Remboursement ${refundId ?? ""} reçu avant son paiement : réessai automatique.`, data: { refundId, paymentId } });
          throw new RetryLater(`paiement ${paymentId} pas encore enregistré`);
        }
        if (owner?.kind === "sibling") {
          await journalOtherStore(storeId, owner, "refund", `Remboursement ${refundId ?? ""}`, { refundId, paymentId });
          return null;
        }
        await recordEvent({
          storeId,
          level: paymentId ? "info" : "warn",
          kind: "refund.foreign",
          message: paymentId
            ? `Remboursement ${refundId ?? ""} d'un paiement Whop qui n'est pas un checkout de cette boutique (${paymentId}) : ignoré.`
            : `Remboursement ${refundId ?? ""} reçu sans identifiant de paiement : vérifiez-le dans Whop.`,
          data: { refundId, paymentId, keys: Object.keys(data).slice(0, 30) },
        });
        return null;
      }
      // Only an amount in the order's currency may be recorded (never a settlement-currency one).
      const amounts = refundAmounts(target.currency, data, "charge" in target ? target.charge : undefined);
      const amount = amounts?.cents ?? null;
      if (amount == null || !refundId) {
        await recordEvent({
          storeId,
          sessionId: target.sessionId,
          level: "error",
          kind: amount == null && refundId ? "refund.currency_mismatch" : "refund.unreadable",
          message:
            amount == null && refundId
              ? `Remboursement Whop ${refundId} reçu dans une autre devise que la commande (${String(data.currency ?? (data.amount as { currency?: string } | null)?.currency ?? "?").toUpperCase()} ≠ ${target.currency}) : reportez-le à la main dans Shopify.`
              : `Remboursement Whop ${refundId ?? "sans identifiant"} reçu sans montant lisible : vérifiez-le et reportez-le dans Shopify.`,
          data: { refundId, paymentId },
          alert: true,
        });
        return null;
      }
      if (target.kind === "session") await recordRefund(target.sessionId, amount, refundId, amounts?.chargeCents ?? null);
      else if (target.kind === "offer") await recordUpsellRefund(target.chargeId, refundId, amount);
      else {
        // A duplicate payment (flagged "à rembourser") or an earlier offer attempt: the
        // order was paid once, nothing to mirror in Shopify.
        const done = await applyRefundOnce(refundId, async () => ({ storeId }));
        if (done) {
          await recordEvent({
            storeId,
            sessionId: target.sessionId,
            kind: "refund.extra_payment",
            message: `${target.kind === "extra" ? "Paiement en double" : "Ancien essai d'offre"} ${paymentId} remboursé (${amount / 100} ${target.currency}) : rien à reporter dans Shopify.`,
            data: { refundId, paymentId },
          });
        }
      }
      return null;
    }
    case "dispute.created":
    case "dispute.updated": {
      const paymentId = eventPaymentId(data);
      const disputeId = typeof data.id === "string" ? data.id : null;
      const target = paymentId ? await resolvePayment(storeId, paymentId, eventPaymentMetadata(data)) : null;
      if (!target) {
        const owner = paymentId ? await ownerOfEventPayment(storeId, paymentId, data) : null;
        if (owner?.kind === "ours") {
          await recordEvent({ storeId, level: "warn", kind: "dispute.early", message: `Litige ${disputeId ?? ""} reçu avant son paiement : réessai automatique.`, data: { disputeId, paymentId } });
          throw new RetryLater(`paiement ${paymentId} pas encore enregistré`);
        }
        if (owner?.kind === "sibling") {
          await journalOtherStore(storeId, owner, "dispute", `Litige ${disputeId ?? ""}`, { disputeId, paymentId });
          return null;
        }
        await recordEvent({
          storeId,
          level: "warn",
          kind: "dispute.foreign",
          message: `Litige ${disputeId ?? ""} reçu sur un paiement Whop qui n'est pas un checkout de cette boutique (${paymentId ?? "sans paiement"}) : à traiter dans Whop.`,
          data: { disputeId, paymentId },
          alert: type === "dispute.created",
        });
        return null;
      }
      // An update for a dispute we never saw open (lost dispute.created): open it first.
      if (type === "dispute.created" || !(await alreadyDisputed(target))) {
        if (target.kind === "session") await recordDispute(target.sessionId, disputeId, disputeDueDate(data));
        else if (target.kind === "offer") await recordUpsellDispute(paymentId!, storeId, disputeId, disputeDueDate(data));
        else {
          await recordEvent({
            storeId,
            sessionId: target.sessionId,
            level: "error",
            kind: "dispute.created",
            message: `Litige ouvert sur ${target.kind === "extra" ? "un paiement en double" : "un ancien essai d'offre"} (${paymentId}) : répondez dans Whop${
              disputeDueDate(data) ? ` avant le ${disputeDueDate(data)!.toISOString().slice(0, 10)}` : ""
            } — un remboursement de ce paiement clôt souvent le litige.`,
            data: { disputeId, paymentId },
            alert: true,
          });
        }
      }
      if (type === "dispute.updated") await recordDisputeOutcome(storeId, target, disputeId, data);
      return null;
    }
    case "dispute_alert.created": {
      await handleDisputeAlert(storeId, data as Parameters<typeof handleDisputeAlert>[1]);
      return null;
    }
    default:
      return null;
  }
}

export async function alreadyDisputed(target: PaymentTarget): Promise<boolean> {
  if (target.kind === "session") return !!(await db.checkoutSession.findUnique({ where: { id: target.sessionId }, select: { disputed: true } }))?.disputed;
  if (target.kind === "offer") return !!(await db.upsellCharge.findUnique({ where: { id: target.chargeId }, select: { disputed: true } }))?.disputed;
  return true; // duplicates/attempts: journaled only, nothing to open
}

/**
 * Won/lost/closed: recorded on the order (a lost dispute is money gone: profit
 * analytics subtract it) and journaled; a lost one alerts. Idempotent per status. Shared with
 * Stripe's disputes (stripe-webhooks.ts), whose `data` carries the lost amount the same way.
 */
export async function recordDisputeOutcome(storeId: string, target: PaymentTarget, disputeId: string | null, data: Record<string, unknown>) {
  const status = typeof data.status === "string" ? data.status : null;
  if (!status || !["won", "lost", "closed"].includes(status)) return;
  const lostCents = status === "lost" ? (refundAmountIn(target.currency, data, "charge" in target ? target.charge : undefined) ?? null) : 0;
  let changed = 1;
  if (target.kind === "session") {
    const s = await db.checkoutSession.findUnique({ where: { id: target.sessionId }, select: { totalCents: true } });
    changed = (
      await db.checkoutSession.updateMany({
        where: { id: target.sessionId, OR: [{ disputeStatus: null }, { disputeStatus: { not: status } }] },
        // A lost dispute (or a later outcome) changes the Google Ads conversion's value.
        data: { disputeStatus: status, disputeLostCents: status === "lost" ? (lostCents ?? s?.totalCents ?? 0) : 0, ...GOOGLE_ADJUST_DUE },
      })
    ).count;
  } else if (target.kind === "offer") {
    const c = await db.upsellCharge.findUnique({ where: { id: target.chargeId }, select: { amountCents: true } });
    changed = (
      await db.upsellCharge.updateMany({
        where: { id: target.chargeId, OR: [{ disputeStatus: null }, { disputeStatus: { not: status } }] },
        data: { disputeStatus: status, disputeLostCents: status === "lost" ? (lostCents ?? c?.amountCents ?? 0) : 0 },
      })
    ).count;
    if (changed) await markGoogleAdjustDue(target.sessionId);
  }
  if (target.kind === "extra" || target.kind === "offer_attempt") {
    // No row to hold the status: journal each outcome once per dispute.
    const first = await db.appSetting.createMany({ data: [{ key: `dispute-outcome:${disputeId ?? target.sessionId}:${status}`, value: new Date().toISOString() }], skipDuplicates: true });
    changed = first.count;
  }
  if (!changed) return;
  // Lost before its Shopify order existed: the order must never be created now.
  if (status === "lost" && target.kind === "session") await settleUnsyncedSession(target.sessionId);
  if (status === "lost" && target.kind === "offer") await settleUnsyncedOffer(target.chargeId);
  const label = status === "won" ? "gagné (fonds restitués)" : status === "lost" ? "perdu (fonds rendus au client)" : "clos";
  await recordEvent({
    storeId,
    sessionId: target.sessionId,
    level: status === "lost" ? "error" : "info",
    kind: `dispute.${status}`,
    message: `Litige ${disputeId ?? ""} ${label}${status === "lost" ? " : pensez à annuler ou rembourser la commande dans Shopify." : "."}`,
    data: { disputeId },
    alert: status === "lost",
  });
}

/** Finds our session from the payment's metadata, falling back to the checkout configuration id. */
async function sessionIdFor(data: Record<string, unknown>, storeId: string): Promise<string | null> {
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;
  const fromMeta = typeof metadata.checkout_session_id === "string" ? metadata.checkout_session_id : null;
  const configId = typeof data.checkout_configuration_id === "string" ? data.checkout_configuration_id : null;
  const session = await db.checkoutSession.findFirst({
    where: {
      storeId,
      OR: [
        ...(fromMeta ? [{ id: fromMeta }] : []),
        ...(configId ? [{ whopCheckoutId: configId }, { quotes: { some: { whopCheckoutId: configId } } }] : []),
      ],
    },
    select: { id: true },
  });
  return fromMeta || configId ? (session?.id ?? null) : null;
}

/**
 * When Whop created the payment (`created_at`: an ISO date, or Unix seconds/ms), null when absent
 * or unreadable. Pure.
 */
export function paymentCreatedAt(data: Record<string, unknown>): Date | null {
  const v = data.created_at;
  const ms = typeof v === "number" && Number.isFinite(v) ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" && v ? (/^\d+$/.test(v) ? Number(v) * (v.length <= 10 ? 1000 : 1) : Date.parse(v)) : NaN;
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null;
}

/** Keeps the raw event for audit and replay (bounded size; a truncated one can't be replayed). */
export const MAX_PAYLOAD = 512_000;
export function safePayload(raw: string) {
  if (raw.length > MAX_PAYLOAD) {
    // A Stripe event keeps what re-reading it needs: its connected account and its mode (whose keys).
    const marker: { truncated: true; length: number; account?: string; livemode?: boolean } = { truncated: true, length: raw.length };
    try {
      const p = JSON.parse(raw) as { account?: unknown; livemode?: unknown } | null;
      if (typeof p?.account === "string" && p.account) marker.account = p.account;
      if (typeof p?.livemode === "boolean") marker.livemode = p.livemode;
    } catch {
      // unreadable: the bare marker
    }
    return marker;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 2000) };
  }
}


/** A claim not marked processed after this long is considered abandoned (crash, timeout). */
export const STALE_CLAIM_MS = 3 * 60_000;

export type ClaimResult = "claimed" | "done" | "in_flight";

/** WebhookEvent ids of Stripe events: "stripe:<event id>" (never mixed with Whop's delivery ids). */
export const STRIPE_EVENT_PREFIX = "stripe:";

/** Primary key of a claimed event: per store (a shared Whop account delivers the same id to each store). */
export const eventKey = (storeId: string, webhookId: string) => ({ storeId_id: { storeId, id: webhookId } });

/**
 * Claims a webhook id for this store before handling. "done": already handled here
 * (answer 200). "in_flight": another invocation holds a fresh claim (answer 409 so Whop
 * retries later instead of giving up). A stale claim is taken over. The claim is per
 * store: the same delivery id reaching a sibling store on the same Whop account is that
 * store's own event, never a duplicate of this one.
 */
export async function claimEvent(webhookId: string, storeId: string, type: string, raw: string): Promise<ClaimResult> {
  try {
    await db.webhookEvent.create({ data: { id: webhookId, storeId, type, payload: safePayload(raw) } });
    return "claimed";
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
  }
  const takeover = await db.webhookEvent.updateMany({
    where: { storeId, id: webhookId, processedAt: null, receivedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) } },
    data: { receivedAt: new Date() },
  });
  if (takeover.count === 1) {
    const row = await db.webhookEvent.findUnique({ where: eventKey(storeId, webhookId), select: { lastError: true } });
    // A previously failed event being redelivered is expected; an abandoned claim is not.
    if (row?.lastError) log.info("webhook.redelivered", `Whop redelivered failed event ${type}`, { webhookId });
    else
      await recordEvent({
        storeId,
        level: "warn",
        kind: "webhook.stale_claim",
        message: `Événement ${webhookId.startsWith(STRIPE_EVENT_PREFIX) ? "Stripe" : "Whop"} ${type} resté inachevé (interruption) : repris.`,
        data: { webhookId },
      });
    return "claimed";
  }
  const row = await db.webhookEvent.findUnique({ where: eventKey(storeId, webhookId), select: { processedAt: true } });
  return row?.processedAt ? "done" : "in_flight";
}

/**
 * Who the payment of a refund/dispute event belongs to: decided from our database
 * (payment, checkout or offer ids, product), else asked of Whop.
 */
async function ownerOfEventPayment(storeId: string, paymentId: string, data: Record<string, unknown>): Promise<PaymentOwner> {
  const local = await paymentOwner(storeId, { paymentId, metadata: eventPaymentMetadata(data), productId: eventProductId(data) });
  if (local.kind !== "unknown") return local;
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store?.whopApiKey) return { kind: "foreign" };
  try {
    const p = await storeClient(store).payments.retrieve({ id: paymentId });
    const owner = await paymentOwner(storeId, { metadata: (p.metadata ?? null) as Record<string, unknown> | null, productId: p.product_id ?? null });
    return owner.kind === "unknown" ? { kind: "foreign" } : owner;
  } catch (err) {
    // The background run's time budget: not "Whop unreachable" (the caller releases its claim).
    if (err instanceof DeadlineError) throw err;
    // Only "this payment doesn't exist here" means foreign. Anything else (timeout, 5xx,
    // 429) is unknown: retry later rather than drop one of our refunds for good.
    if ((err as { statusCode?: number }).statusCode === 404) return { kind: "foreign" };
    throw new RetryLater(`Whop injoignable pour vérifier le paiement ${paymentId}`, { cause: err });
  }
}

/** An event of another store sharing this Whop account: journaled here for the record, never alerted. */
async function journalOtherStore(storeId: string, owner: { storeId: string }, what: "payment" | "refund" | "dispute", label: string, data: Record<string, string | null>) {
  const other = await db.store.findUnique({ where: { id: owner.storeId }, select: { name: true } });
  await recordEvent({
    storeId,
    kind: `${what}.other_store`,
    message: `${label} de la boutique « ${other?.name ?? owner.storeId} » (même compte Whop) : traité par celle-ci, ignoré ici.`,
    data: { ...data, ownerStoreId: owner.storeId },
  });
}

export const REPLAY_BACKOFF_MINUTES = [2, 10, 30, 120, 360, 1440];
/** A failing event is given up this long after its first receipt, whatever its counters. */
export const MAX_EVENT_AGE_MS = 72 * 3600_000;
/** `attempts` value of an event given up (the queries treat anything above the backoff list as such). */
export const GAVE_UP_ATTEMPTS = REPLAY_BACKOFF_MINUTES.length + 1;

export type FailOutcome = {
  /** Local replays that failed (Whop's redeliveries are counted apart, in `deliveries`). */
  attempts: number;
  deliveries: number;
  gaveUp: boolean;
  /** Gave up just now (alert once, not on every later redelivery). */
  newlyGaveUp: boolean;
  /** Next local replay, when one is scheduled. */
  nextAttemptAt: Date | null;
};

/**
 * Handling failed: keep the row (payload included) and mark it immediately takeable by
 * Whop's redelivery. `source` says who ran it: a failed local replay spends the local
 * budget (backoff list); a failed Whop delivery doesn't (Whop retries on its own schedule),
 * it only makes sure a local replay is scheduled. Given up once the local budget is spent
 * or 72 h after the first receipt, whichever comes first.
 */
export async function failEvent(storeId: string, webhookId: string, err: unknown, source: "webhook" | "replay" = "replay"): Promise<FailOutcome> {
  const row = await db.webhookEvent.findUnique({ where: eventKey(storeId, webhookId), select: { attempts: true, deliveries: true, firstReceivedAt: true, nextAttemptAt: true } });
  const wasGaveUp = (row?.attempts ?? 0) >= GAVE_UP_ATTEMPTS;
  const attempts = (row?.attempts ?? 0) + (source === "replay" ? 1 : 0);
  const deliveries = (row?.deliveries ?? 0) + (source === "webhook" ? 1 : 0);
  let next: Date | null;
  if (source === "replay") {
    const delay = REPLAY_BACKOFF_MINUTES[attempts - 1];
    next = delay != null ? new Date(Date.now() + delay * 60_000) : null;
  } else {
    // Keep a local replay already scheduled; otherwise schedule the next one.
    const delay = REPLAY_BACKOFF_MINUTES[attempts];
    next = row?.nextAttemptAt && row.nextAttemptAt > new Date() ? row.nextAttemptAt : delay != null ? new Date(Date.now() + delay * 60_000) : null;
  }
  const aged = !!row?.firstReceivedAt && Date.now() - row.firstReceivedAt.getTime() > MAX_EVENT_AGE_MS;
  const gaveUp = wasGaveUp || aged || (source === "replay" && next == null);
  await db.webhookEvent.update({
    where: eventKey(storeId, webhookId),
    data: {
      attempts: gaveUp ? Math.max(attempts, GAVE_UP_ATTEMPTS) : attempts,
      deliveries,
      lastError: (err instanceof Error ? err.message : String(err)).slice(0, 500),
      receivedAt: new Date(Date.now() - STALE_CLAIM_MS - 1000),
      nextAttemptAt: gaveUp ? null : next,
    },
  });
  return { attempts, deliveries, gaveUp, newlyGaveUp: gaveUp && !wasGaveUp, nextAttemptAt: gaveUp ? null : next };
}

/** Journal line (and alert) for an event given up: a human must look at it in Whop. */
export async function recordGaveUp(storeId: string, webhookId: string, type: string, outcome: FailOutcome, err: unknown) {
  const via = webhookId.startsWith(STRIPE_EVENT_PREFIX) ? "Stripe" : "Whop";
  await recordEvent({
    storeId,
    level: "error",
    kind: "webhook.gave_up",
    message: `Événement ${via} ${type} (${webhookId}) abandonné après ${outcome.attempts} rejeu(x) local(aux) et ${outcome.deliveries} envoi(s) de ${via} (${
      err instanceof Error ? err.message : String(err)
    }) : plus aucun essai automatique. Vérifiez-le dans ${via}, puis « Relancer » ou « Traité » dans le Journal.`,
    data: { webhookId, attempts: outcome.attempts, deliveries: outcome.deliveries },
    alert: true,
  });
}

/**
 * Background replay of events whose handling was interrupted (crash) or failed and
 * that the processor may have stopped retrying. Gives up after the backoff list, loudly.
 * `provider`: Whop's events (their delivery ids), or Stripe's ("stripe:evt_…", replayed from the
 * stored event, re-read from Stripe when the stored copy was truncated) — two tick jobs, so a
 * hanging Whop never holds Stripe's replays (and the other way round).
 */
export async function replayStaleEvents(deadline: number, provider: "whop" | "stripe" = "whop"): Promise<number> {
  const stripe = provider === "stripe";
  const via = stripe ? "Stripe" : "Whop";
  const stale = await db.webhookEvent.findMany({
    where: {
      processedAt: null,
      receivedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) },
      attempts: { lt: GAVE_UP_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
      ...(stripe
        ? { id: { startsWith: STRIPE_EVENT_PREFIX } }
        : { NOT: [{ id: { startsWith: "refund:" } }, { id: { startsWith: "refund-skip:" } }, { id: { startsWith: STRIPE_EVENT_PREFIX } }] }),
    },
    take: 20,
    orderBy: { receivedAt: "asc" },
  });
  let n = 0;
  for (const e of stale) {
    if (stopForTime(deadline)) break;
    const taken = await db.webhookEvent.updateMany({ where: { storeId: e.storeId, id: e.id, processedAt: null, receivedAt: e.receivedAt }, data: { receivedAt: new Date() } });
    if (taken.count === 0) continue;
    const evt = (e.payload ?? {}) as WhopEvent & { truncated?: boolean };
    const type = stripe ? e.type : eventType(evt) || e.type;
    if (evt.truncated && !stripe) {
      await db.webhookEvent.update({ where: eventKey(e.storeId, e.id), data: { attempts: GAVE_UP_ATTEMPTS, lastError: "payload tronqué" } });
      await recordEvent({ storeId: e.storeId, level: "error", kind: "webhook.gave_up", message: `Événement Whop ${type} (${e.id}) trop volumineux pour être rejoué : vérifiez-le dans Whop.`, alert: true });
      continue;
    }
    try {
      const syncId = await withLogContext({ webhookId: e.id, event: type, replay: true }, async () => {
        if (!stripe) return handleEvent(type, (evt.data ?? {}) as Record<string, unknown>, e.storeId);
        // Loaded lazily: stripe-webhooks.ts builds on this module (no import cycle at load time).
        const { replayStripeEvent } = await import("./stripe-webhooks");
        return replayStripeEvent(e.storeId, e.id.slice(STRIPE_EVENT_PREFIX.length), e.payload);
      });
      await db.webhookEvent.update({ where: eventKey(e.storeId, e.id), data: { processedAt: new Date(), lastError: null, nextAttemptAt: null } });
      // Inside the tick's Whop-side phase the Shopify order is created by its follow-ups job.
      if (syncId && !defer("order.sync", () => syncOrderSafely(syncId))) await syncOrderSafely(syncId);
      await recordEvent({ storeId: e.storeId, level: "warn", kind: "webhook.replayed", message: `Événement ${via} ${type} rejoué automatiquement${e.attempts ? ` (après ${e.attempts} échec(s))` : " (interrompu)"}.` });
      n++;
    } catch (err) {
      if (isDeadline(err)) {
        // Out of time before the event could be handled: the claim is given back as it was (due at the
        // next run), no replay attempt spent, nothing journaled.
        await db.webhookEvent.updateMany({ where: { storeId: e.storeId, id: e.id, processedAt: null }, data: { receivedAt: e.receivedAt } });
        notePartial();
        break;
      }
      const outcome = await failEvent(e.storeId, e.id, err, "replay");
      if (outcome.newlyGaveUp) await recordGaveUp(e.storeId, e.id, type, outcome, err);
      else if (!outcome.gaveUp)
        await recordEvent({
          storeId: e.storeId,
          level: "warn",
          kind: "webhook.replay_failed",
          message: `Rejeu de l'événement ${via} ${type} en échec (rejeu ${outcome.attempts}) : ${err instanceof Error ? err.message : String(err)}. Prochain rejeu ${
            outcome.nextAttemptAt ? `à ${outcome.nextAttemptAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" })}` : "bientôt"
          }.`,
          data: { webhookId: e.id },
        });
    }
  }
  return n;
}
