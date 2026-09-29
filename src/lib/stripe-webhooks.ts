import "server-only";
import type Stripe from "stripe";
import { Prisma, type Store } from "@prisma/client";
import { db } from "./db";
import { applyRefundOnce, formatAmount, markPaid, recordDispute, recordPaymentFailure, recordRefund, syncOrderSafely } from "./checkout";
import { DeadlineError, notePartial, stopForTime } from "./deadline";
import { defer } from "./deferred";
import { recordIncident } from "./incidents";
import { env } from "./env";
import { log, recordEvent } from "./log";
import { paymentOwner, refundAmounts, resolvePayment, type PaymentTarget } from "./payments";
import { rateLimit } from "./ratelimit";
import { RetryLater } from "./retry-later";
import { rotateStores } from "./rotation";
import { listChargeRefunds, listStripeEvents, paymentInfoFromStripe, retrievePaymentIntent, retrieveStripeEvent, retrieveStripeRefund, stripeAmountToCents, stripeConfigured, stripeForMode } from "./stripe";
import { applyChargesEnabled, detectRevokedStripeAccount, forgetStripeAccount, markPastStripeAccountRevoked } from "./stripe-connection";
import { markUpsellFailed, markUpsellPaid, recordUpsellDispute, recordUpsellRefund } from "./upsell";
import { alreadyDisputed, recordDisputeOutcome, STRIPE_EVENT_PREFIX } from "./webhooks";

/*
 * Stripe (Connect) event handling, shared by the webhook route, the background replay of events whose
 * handling failed (webhooks.ts replayStaleEvents, "stripe:" ids) and the reconciliation (events the
 * webhook never delivered). Everything goes through the same idempotent money functions as Whop's:
 * markPaid, recordRefund / applyRefundOnce, recordDispute and the offers' equivalents.
 *
 * The payment id recorded for a Stripe payment is its PaymentIntent id ("pi_…", in the same column as
 * Whop's payment ids), refunds are "stripe:re_…" and disputes keep Stripe's own id ("du_…" / "dp_…").
 */

type Outcome = { paidNow?: boolean };
/**
 * Where the event comes from: Stripe's own delivery (fresh), or a copy handled later (the background
 * replay of a stored copy, the reconciliation's listing) whose objects may be stale by now.
 */
export type StripeEventSource = "webhook" | "replay" | "reconcile";

const idOf = (v: string | { id: string } | null | undefined): string | null => (typeof v === "string" ? v : (v?.id ?? null));

/** Handles one event of a store's connected account; returns a session id whose Shopify order must be created next. */
export async function handleStripeEvent(event: Stripe.Event, currentStore: Store, opts: { outcome?: Outcome; source?: StripeEventSource } = {}): Promise<string | null> {
  // A refund snapshot from a later copy (replay, reconciliation) is checked against Stripe before it is counted.
  const recheck = !!opts.source && opts.source !== "webhook";
  // Money events are read on the account they happened on: a past account of the store (disconnected /
  // replaced, still mapped for its orders' refunds and disputes) keeps working. And in the mode they
  // happened in: a test event of a live connection (which covers both modes), or an event from before
  // the store's test mode switch, is read back with that mode's keys, never the store's current ones.
  const store = stripeForMode(currentStore, typeof event.livemode === "boolean" ? event.livemode : null, event.account);
  if (store.testMode !== currentStore.testMode) {
    log.info("stripe.mode_mismatch", `Stripe ${event.livemode ? "live" : "test"} event on a store in ${currentStore.testMode ? "test" : "live"} mode: handled with the event's mode`, {
      storeId: currentStore.id,
      eventId: event.id,
      type: event.type,
    });
  }
  // The account the event comes from, when the store has let go of it since (journal wording).
  const past = event.account && event.account !== currentStore.stripeAccountId ? event.account : null;
  // A PaymentIntent another deployment created (staging / production on one Stripe platform): not ours.
  if (event.type.startsWith("payment_intent.")) {
    const host = await foreignPaymentHost((event.data.object as Stripe.PaymentIntent).metadata);
    if (host) {
      await ignoreForeignHost(host, { eventId: event.id, storeId: currentStore.id });
      return null;
    }
  }
  switch (event.type) {
    case "payment_intent.succeeded":
      return onPaymentSucceeded(store, event.data.object, opts.outcome, typeof event.livemode === "boolean" ? event.livemode : null);
    case "payment_intent.payment_failed":
      await onPaymentFailed(store, event.data.object, event.created);
      return null;
    case "charge.refunded":
      await onChargeRefunded(store, event.data.object, past, recheck);
      return null;
    case "charge.refund.updated":
      await applyStripeRefund(store, event.data.object, null, { recheck });
      return null;
    case "charge.dispute.created":
    case "charge.dispute.updated":
    case "charge.dispute.closed":
      await onDispute(store, event.type, event.data.object, past);
      return null;
    case "account.application.deauthorized":
      await onDeauthorized(event, currentStore);
      return null;
    case "account.updated":
      // Only the current connection's flag (a past account's changes don't matter any more).
      if (event.account && event.account === currentStore.stripeAccountId) {
        await applyChargesEnabled(currentStore, (event.data.object as Stripe.Account).charges_enabled === true, "webhook");
      }
      return null;
    default:
      log.info("stripe.event_ignored", `Stripe event ${event.type} ignored`, { storeId: store.id, eventId: event.id });
      return null;
  }
}

/**
 * Stripe revoked the app's access to an account. Always judged against the store as it is NOW (the
 * webhook, the replay and the reconciliation all pass the current row): an account the store no
 * longer uses (replaced, disconnected) only marks that past account revoked; a revocation older than
 * the current connection (reconnected since: late delivery, redelivery, replay) is ignored; a
 * test-mode revocation leaves a live connection in place. Otherwise the store forgets the account.
 */
async function onDeauthorized(event: Stripe.Event, store: Store) {
  const account = event.account ?? null;
  if (account && account !== store.stripeAccountId) {
    await markPastStripeAccountRevoked(store.id, account);
    log.info("stripe.deauthorized_past", "Stripe deauthorization of an account the store no longer uses: the current connection stays", { storeId: store.id, account });
    return;
  }
  if (!store.stripeAccountId) return; // already forgotten (redelivery, replay)
  // Compared in whole seconds (Stripe's `created` precision): a revocation in the connection's own
  // second counts as current.
  if (store.stripeConnectedAt && event.created < Math.floor(store.stripeConnectedAt.getTime() / 1000)) {
    log.info("stripe.deauthorized_stale", "Stripe deauthorization older than the current connection ignored", { storeId: store.id, eventId: event.id });
    return;
  }
  // A test-mode revocation leaves a live connection in place (a live connection covers both modes).
  if (!event.livemode && store.stripeLivemode === true) {
    log.info("stripe.deauthorized_test_only", "Test-mode Stripe deauthorization ignored: the live connection stays", { storeId: store.id });
    return;
  }
  await forgetStripeAccount(store, {
    by: "stripe",
    message: `Stripe a retiré l'accès de l'app au compte « ${store.stripeAccountName ?? store.stripeAccountId} » (révoqué depuis Stripe) : Stripe n'est plus utilisé pour encaisser. Reconnectez-le depuis la page Stripe.`,
  });
}

/** This deployment's host(s) from APP_URL (host and hostname, lower-cased); none when unreadable. */
function deploymentHosts(): string[] {
  try {
    const u = new URL(env.appUrl);
    return [...new Set([u.host.toLowerCase(), u.hostname.toLowerCase()])];
  } catch {
    return [];
  }
}

/**
 * The other deployment a PaymentIntent was created by (metadata app_host set and not this deployment's
 * APP_URL host: staging and production sharing one Stripe platform), else null. Pure given `hosts`.
 */
export function foreignAppHost(metadata: Record<string, unknown> | null | undefined, hosts: string[] = deploymentHosts()): string | null {
  const h = metadata?.app_host;
  if (typeof h !== "string" || !h.trim() || !hosts.length) return null;
  return hosts.includes(h.trim().toLowerCase()) ? null : h.trim();
}

/**
 * foreignAppHost, unless the PaymentIntent's checkout (checkout_session_id) or one-click offer
 * (upsell_charge_id) is in this database: then it is ours all the same (APP_URL changed since it was
 * created, e.g. a new domain), handled, and a warning logged (hourly per host). Else the other host.
 */
export async function foreignPaymentHost(metadata: Record<string, unknown> | null | undefined, hosts?: string[]): Promise<string | null> {
  const host = foreignAppHost(metadata, hosts);
  if (!host) return null;
  const sessionId = typeof metadata?.checkout_session_id === "string" && metadata.checkout_session_id ? metadata.checkout_session_id : null;
  const chargeId = typeof metadata?.upsell_charge_id === "string" && metadata.upsell_charge_id ? metadata.upsell_charge_id : null;
  const [session, charge] = await Promise.all([
    sessionId ? db.checkoutSession.findUnique({ where: { id: sessionId }, select: { id: true } }) : null,
    chargeId ? db.upsellCharge.findUnique({ where: { id: chargeId }, select: { id: true } }) : null,
  ]);
  if (!session && !charge) return host;
  if (await rateLimit(`stripe:app-host-changed:${host}`, 1, 60 * 60_000)) {
    log.warn("stripe.app_host_changed", `Stripe PaymentIntent tagged with another host (${host}) but its checkout is in this database: handled (APP_URL changed?)`, {
      host,
      sessionId,
      chargeId,
    });
  }
  return null;
}

/** Another deployment's PaymentIntent: ignored, logged at most once an hour per host (never the merchant's journal). */
async function ignoreForeignHost(host: string, what: { eventId?: string; paymentId?: string | null; storeId?: string }) {
  if (await rateLimit(`stripe:foreign-host:${host}`, 1, 60 * 60_000)) {
    log.info("stripe.foreign_host", `Stripe event of another deployment (${host}) ignored`, { host, ...what });
  }
}

/**
 * The metadata of a PaymentIntent a refund or dispute points at that this store doesn't know (yet):
 * read from Stripe (offer / checkout / store / deployment tags), null when unreadable.
 */
async function paymentMetadata(store: Store, paymentId: string): Promise<Record<string, string> | null> {
  try {
    return (await retrievePaymentIntent(store, paymentId)).metadata ?? null;
  } catch (err) {
    if (err instanceof DeadlineError) throw err;
    log.warn("stripe.pi_retrieve_failed", "PaymentIntent of a refund / dispute unreadable: attributed from the database only", { storeId: store.id, paymentId, err });
    return null;
  }
}

/**
 * The event of a store sharing the connected account with this one (metadata store_id of another
 * store): handled by that store's own copy, ignored here.
 */
function otherStore(pi: Pick<Stripe.PaymentIntent, "metadata">, store: Pick<Store, "id">): boolean {
  const owner = pi.metadata?.store_id;
  return !!owner && owner !== store.id;
}

/** This store's checkout of a PaymentIntent: its metadata, else the PaymentIntent recorded on the session or one of its quotes. */
async function sessionForPayment(storeId: string, pi: Pick<Stripe.PaymentIntent, "id" | "metadata">): Promise<string | null> {
  const fromMeta = pi.metadata?.checkout_session_id || null;
  const s = await db.checkoutSession.findFirst({
    where: { storeId, OR: [...(fromMeta ? [{ id: fromMeta }] : []), { stripePaymentIntentId: pi.id }, { quotes: { some: { stripePaymentIntentId: pi.id } } }] },
    select: { id: true },
  });
  return s?.id ?? null;
}

/**
 * The PaymentIntent with its charge and balance transaction (method, billing details, fee). Stripe
 * unreachable: the event's own copy (the payment is recorded all the same, its fee stays unknown).
 */
async function fullPaymentIntent(store: Store, pi: Stripe.PaymentIntent): Promise<Stripe.PaymentIntent> {
  if (pi.latest_charge && typeof pi.latest_charge === "object" && typeof pi.latest_charge.balance_transaction === "object") return pi;
  try {
    return await retrievePaymentIntent(store, pi.id);
  } catch (err) {
    if (err instanceof DeadlineError) throw err;
    log.warn("stripe.pi_retrieve_failed", "PaymentIntent unreadable: recorded from the event (fee unknown)", { storeId: store.id, paymentId: pi.id, err });
    return pi;
  }
}

async function onPaymentSucceeded(store: Store, pi: Stripe.PaymentIntent, outcome?: Outcome, livemode: boolean | null = null): Promise<string | null> {
  if (otherStore(pi, store)) return null;
  const meta = pi.metadata ?? {};
  // One-click post-purchase offers are separate PaymentIntents on the same session.
  if (meta.upsell_charge_id) {
    const full = await fullPaymentIntent(store, pi);
    await markUpsellPaid(meta.upsell_charge_id, pi.id, store.id, paymentInfoFromStripe(full).feeCents);
    return null;
  }
  const sessionId = await sessionForPayment(store.id, pi);
  if (!sessionId) {
    if (meta.checkout_session_id) {
      const owner = await db.checkoutSession.findUnique({ where: { id: meta.checkout_session_id }, select: { storeId: true } });
      if (owner && owner.storeId !== store.id) return null; // another store on the same Stripe account
      // Metadata says it's one of our checkouts but the session is unknown: never drop it silently.
      await recordEvent({
        storeId: store.id,
        level: "error",
        kind: "payment.unknown_session",
        message: `Paiement Stripe ${pi.id} reçu pour un checkout introuvable (${meta.checkout_session_id}) : vérifiez-le dans Stripe et créez la commande à la main si besoin.`,
        data: { paymentId: pi.id, provider: "stripe" },
        alert: true,
      });
    }
    return null; // otherwise: not one of our checkouts (another sale on this Stripe account)
  }
  const full = await fullPaymentIntent(store, pi);
  // The event's mode (always set by Stripe) wins over the PaymentIntent copy's: markPaid holds a
  // payment of the other mode than the store's and makes its Shopify order a test one if it was.
  const info = paymentInfoFromStripe(full);
  return (await markPaid(sessionId, { ...info, livemode: livemode ?? info.livemode ?? null }, { deferSync: true, outcome })) ? sessionId : null;
}

async function onPaymentFailed(store: Store, pi: Stripe.PaymentIntent, createdSec: number) {
  if (otherStore(pi, store)) return;
  const meta = pi.metadata ?? {};
  const error = pi.last_payment_error;
  if (meta.upsell_charge_id) {
    // A declined one-click offer (normally already recorded by the charge's own answer).
    await markUpsellFailed(meta.upsell_charge_id, store.id, error?.message ?? null, pi.id);
    return;
  }
  const sessionId = await sessionForPayment(store.id, pi);
  if (!sessionId) return;
  const method = error?.payment_method?.type ?? null;
  const reason = `${error?.message ? ` : ${error.message}` : ""}${method ? ` (${method})` : ""}`;
  // Stripe keeps one PaymentIntent across the buyer's attempts: the attempt's time is the failure
  // event's (Unix seconds), compared like Whop's payment creation (see recordPaymentFailure).
  await recordPaymentFailure(store.id, sessionId, Number.isFinite(createdSec) && createdSec > 0 ? new Date(createdSec * 1000) : null, reason);
}

async function onChargeRefunded(store: Store, charge: Stripe.Charge, past: string | null = null, recheck = false) {
  // The event's charge embeds its refunds only on older API versions (and only the first page).
  const embedded = charge.refunds;
  let refunds: Stripe.Refund[];
  // Listed from Stripe just now: current, no re-read needed. The embedded copy is a snapshot.
  let snapshot = false;
  if (embedded && !embedded.has_more && embedded.data.length) {
    refunds = embedded.data;
    snapshot = true;
  } else {
    try {
      refunds = await listChargeRefunds(store, charge.id);
    } catch (err) {
      if (!past || err instanceof DeadlineError) throw err;
      // An account the store let go of (access maybe revoked): the refund can't be read back here.
      await recordEvent({
        storeId: store.id,
        level: "error",
        kind: "refund.past_account",
        message: `Remboursement Stripe sur le paiement ${idOf(charge.payment_intent) ?? charge.id}, illisible sur l'ancien compte Stripe ${past} (${err instanceof Error ? err.message : String(err)}) : vérifiez-le dans Stripe et reportez-le à la main dans Shopify.`,
        data: { chargeId: charge.id, paymentId: idOf(charge.payment_intent), account: past },
        alert: true,
      });
      return;
    }
  }
  for (const r of refunds) await applyStripeRefund(store, r, charge, { recheck: recheck && snapshot });
}

/** Marker: Stripe said this refund failed / was canceled before the app ever counted it (out-of-order events). */
const refundFailedKey = (id: string) => `stripe:refund-failed:${id}`;

/** The status Stripe reported for a refund marked failed before it was counted ("failed" / "canceled"), else null. */
async function refundKnownFailed(refundId: string): Promise<"failed" | "canceled" | null> {
  const row = await db.appSetting.findUnique({ where: { key: refundFailedKey(refundId) }, select: { value: true } });
  if (!row) return null;
  try {
    return (JSON.parse(row.value) as { status?: string }).status === "canceled" ? "canceled" : "failed";
  } catch {
    return "failed";
  }
}

/**
 * A succeeded snapshot from a later copy (replay, reconciliation): the refund as Stripe has it now.
 * Failed / canceled since → not to be counted. Unreadable (timeout, access): counted from the snapshot
 * (the failure marker still guards the out-of-order case).
 */
async function refundNowReversed(store: Store, refund: Stripe.Refund): Promise<Stripe.Refund | null> {
  try {
    const now = await retrieveStripeRefund(store, refund.id);
    return now.status === "failed" || now.status === "canceled" ? now : null;
  } catch (err) {
    if (err instanceof DeadlineError) throw err;
    log.warn("stripe.refund_recheck_failed", "Stripe refund unreadable before counting a replayed copy: counted from the copy", { storeId: store.id, refundId: refund.id, err });
    return null;
  }
}

/**
 * A refund Stripe reports failed or canceled. Already counted (it had succeeded first: e.g. the
 * buyer's card was closed): the counts stay as they are — never undone nor counted twice — and the
 * merchant is alerted once to check the order (Shopify refund, re-refund). Never counted: nothing to do.
 */
async function onRefundReversed(store: Store, refund: Stripe.Refund) {
  const refundId = `stripe:${refund.id}`;
  const applied = await db.webhookEvent.findFirst({ where: { id: `refund:${refundId}` }, select: { storeId: true } });
  if (!applied) {
    // Remembered, so a « succeeded » copy of it arriving after this (out of order, replay,
    // reconciliation) is never counted (applyStripeRefund checks it).
    await db.appSetting.createMany({ data: [{ key: refundFailedKey(refund.id), value: JSON.stringify({ status: refund.status, at: new Date().toISOString() }) }], skipDuplicates: true });
    log.info("stripe.refund_not_applied", `Stripe refund ${refund.status} before it was counted: nothing to undo, never counted later`, { storeId: store.id, refundId });
    return;
  }
  if (applied.storeId !== store.id) return; // another store's (shared account): alerted there
  // Once per refund (redeliveries, charge.refunded listing it again, the reconciliation).
  const markerKey = `stripe:refund-reversed:${refund.id}`;
  try {
    await db.appSetting.create({ data: { key: markerKey, value: new Date().toISOString() } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
    throw err;
  }
  try {
    await alertRefundReversed(store, refund, refundId);
  } catch (err) {
    // The alert never went out: the marker goes too, so the event's retry (Stripe's redelivery, the
    // replay, the reconciliation) alerts again instead of finding it "already alerted".
    await db.appSetting.deleteMany({ where: { key: markerKey } }).catch((e) => log.error("stripe.refund_reversed_marker", "Reversed-refund marker left after a failed alert", { refundId, err: e }));
    throw err;
  }
}

async function alertRefundReversed(store: Store, refund: Stripe.Refund, refundId: string) {
  const record = await db.refundRecord.findUnique({ where: { id: refundId }, select: { sessionId: true, amountCents: true, currency: true } });
  // A duplicate payment's / earlier offer attempt's refund has no refund record: its order is the
  // checkout the payment belongs to (the alert links to it).
  const paymentId = idOf(refund.payment_intent);
  const sessionId = record?.sessionId ?? (paymentId ? ((await resolvePayment(store.id, paymentId).catch(() => null))?.sessionId ?? null) : null);
  const cents = stripeAmountToCents(refund.amount, refund.currency);
  await recordEvent({
    storeId: store.id,
    sessionId,
    level: "error",
    kind: "refund.reversed",
    message: `Remboursement Stripe annulé/échoué : vérifiez la commande. Le remboursement ${refund.id}${
      cents != null ? ` (${formatAmount(cents, refund.currency.toUpperCase())})` : ""
    } est passé « ${refund.status === "canceled" ? "annulé" : "échoué"} » dans Stripe${refund.failure_reason ? ` (${refund.failure_reason})` : ""} après avoir été compté : le client n'a peut-être pas été remboursé. Il reste compté dans l'app ; remboursez à nouveau dans Stripe si besoin.`,
    data: { refundId, paymentId: idOf(refund.payment_intent), status: refund.status },
    alert: true,
  });
  // recordEvent never throws (a failed journal write is only logged): the entry must be there, else
  // the caller drops the marker and the event is retried.
  const written = await db.eventLog.findFirst({ where: { storeId: store.id, kind: "refund.reversed", data: { path: ["refundId"], equals: refundId } }, select: { id: true } });
  if (!written) throw new Error(`alerte du remboursement annulé ${refund.id} non enregistrée`);
}

/**
 * One Stripe refund, once it succeeded (a pending one comes back as charge.refund.updated): counted
 * once per refund id ("stripe:re_…") on the checkout, the offer, or a duplicate payment. A refund
 * failed / canceled after it was counted is alerted (onRefundReversed), never counted again.
 */
export async function applyStripeRefund(store: Store, refund: Stripe.Refund, charge?: Stripe.Charge | null, opts: { recheck?: boolean } = {}) {
  if (refund.status === "failed" || refund.status === "canceled") return onRefundReversed(store, refund);
  if (refund.status !== "succeeded") return;
  const refundId = `stripe:${refund.id}`;
  // Already reported failed / canceled (events out of order): this older « succeeded » copy never counts.
  if (await refundKnownFailed(refund.id)) {
    log.warn("stripe.refund_failed_skipped", "Stripe refund reported failed/canceled earlier: its succeeded copy is not counted", { storeId: store.id, refundId });
    return;
  }
  // A copy handled later (replay, reconciliation): Stripe's current status decides.
  if (opts.recheck) {
    const reversed = await refundNowReversed(store, refund);
    if (reversed) {
      log.warn("stripe.refund_stale_copy", `Stripe refund now ${reversed.status}: its succeeded copy is not counted`, { storeId: store.id, refundId });
      return onRefundReversed(store, reversed);
    }
  }
  const paymentId = idOf(refund.payment_intent) ?? idOf(charge?.payment_intent ?? null);
  let target = paymentId ? await resolvePayment(store.id, paymentId) : null;
  let metadata: Record<string, string> | null = null;
  if (!target && paymentId) {
    // Unknown here: the PaymentIntent's own metadata (a one-click offer whose answer was never
    // recorded, another store, another deployment) decides.
    metadata = await paymentMetadata(store, paymentId);
    const foreign = await foreignPaymentHost(metadata);
    if (foreign) return ignoreForeignHost(foreign, { paymentId, storeId: store.id });
    if (metadata && otherStore({ metadata }, store)) return;
    if (metadata) target = await resolvePayment(store.id, paymentId, metadata);
  }
  if (!target) {
    // Not (yet) known: if it is one of ours, retry once the payment is recorded.
    const owner = paymentId ? await paymentOwner(store.id, { paymentId, metadata }) : null;
    if (owner?.kind === "ours") {
      // Journaled once an hour per refund (Stripe's redeliveries and the replay retry it meanwhile).
      if (await rateLimit(`stripe:refund-early:${refund.id}`, 1, 60 * 60_000)) {
        await recordEvent({ storeId: store.id, level: "warn", kind: "refund.early", message: `Remboursement Stripe ${refund.id} reçu avant son paiement : réessai automatique.`, data: { refundId, paymentId } });
      }
      throw new RetryLater(`paiement ${paymentId} pas encore enregistré`);
    }
    if (owner?.kind === "sibling") return;
    await recordEvent({
      storeId: store.id,
      level: paymentId ? "info" : "warn",
      kind: "refund.foreign",
      message: paymentId
        ? `Remboursement Stripe ${refund.id} d'un paiement qui n'est pas un checkout de cette boutique (${paymentId}) : ignoré.`
        : `Remboursement Stripe ${refund.id} reçu sans paiement : vérifiez-le dans Stripe.`,
      data: { refundId, paymentId },
    });
    return;
  }
  // Stripe refunds in the charged currency: only an amount in the order's currency (or the charge
  // currency of an order charged in the buyer's) may be recorded.
  const cents = stripeAmountToCents(refund.amount, refund.currency);
  const amounts = cents == null ? null : refundAmounts(target.currency, { amount: cents / 100, currency: refund.currency.toUpperCase() }, "charge" in target ? target.charge : undefined);
  if (!amounts) {
    await recordEvent({
      storeId: store.id,
      sessionId: target.sessionId,
      level: "error",
      kind: "refund.currency_mismatch",
      message: `Remboursement Stripe ${refund.id} reçu dans une autre devise que la commande (${refund.currency.toUpperCase()} ≠ ${target.currency}) : reportez-le à la main dans Shopify.`,
      data: { refundId, paymentId },
      alert: true,
    });
    return;
  }
  if (target.kind === "session") await recordRefund(target.sessionId, amounts.cents, refundId, amounts.chargeCents, "stripe");
  else if (target.kind === "offer") await recordUpsellRefund(target.chargeId, refundId, amounts.cents, "stripe");
  else {
    // A duplicate payment (flagged "à rembourser") or an earlier offer attempt: the order was paid
    // once, nothing to mirror in Shopify.
    const done = await applyRefundOnce(refundId, async () => ({ storeId: store.id }));
    if (done) {
      await recordEvent({
        storeId: store.id,
        sessionId: target.sessionId,
        kind: "refund.extra_payment",
        message: `${target.kind === "extra" ? "Paiement en double" : "Ancien essai d'offre"} ${paymentId} remboursé dans Stripe (${formatAmount(amounts.cents, target.currency)}) : rien à reporter dans Shopify.`,
        data: { refundId, paymentId },
      });
    }
  }
  // Its failure reported while it was being counted (concurrent deliveries): alerted like a refund
  // failed after it was counted (once, see onRefundReversed).
  const failedMeanwhile = await refundKnownFailed(refund.id);
  if (failedMeanwhile) await onRefundReversed(store, { ...refund, status: failedMeanwhile });
}

/** Stripe's dispute status as the app's outcome (won / lost / closed), null while it is open. Pure. */
export function stripeDisputeOutcome(status: string | null | undefined): "won" | "lost" | "closed" | null {
  if (status === "won" || status === "lost") return status;
  // An inquiry closed without a chargeback, or a dispute prevented (e.g. by an early refund).
  if (status === "warning_closed" || status === "prevented") return "closed";
  return null;
}

async function onDispute(store: Store, type: "charge.dispute.created" | "charge.dispute.updated" | "charge.dispute.closed", d: Stripe.Dispute, past: string | null = null) {
  const paymentId = idOf(d.payment_intent);
  let target: PaymentTarget | null = paymentId ? await resolvePayment(store.id, paymentId) : null;
  let metadata: Record<string, string> | null = null;
  if (!target && paymentId) {
    // Unknown here: the PaymentIntent's own metadata decides (see applyStripeRefund).
    metadata = await paymentMetadata(store, paymentId);
    const foreign = await foreignPaymentHost(metadata);
    if (foreign) return ignoreForeignHost(foreign, { paymentId, storeId: store.id });
    if (metadata && otherStore({ metadata }, store)) return;
    if (metadata) target = await resolvePayment(store.id, paymentId, metadata);
  }
  if (!target) {
    const owner = paymentId ? await paymentOwner(store.id, { paymentId, metadata }) : null;
    if (owner?.kind === "ours") {
      // Journaled once an hour per dispute (each of its events is retried meanwhile).
      if (await rateLimit(`stripe:dispute-early:${d.id}`, 1, 60 * 60_000)) {
        await recordEvent({ storeId: store.id, level: "warn", kind: "dispute.early", message: `Litige Stripe ${d.id} reçu avant son paiement : réessai automatique.`, data: { disputeId: d.id, paymentId } });
      }
      throw new RetryLater(`paiement ${paymentId} pas encore enregistré`);
    }
    if (owner?.kind === "sibling") return;
    await recordEvent({
      storeId: store.id,
      level: "warn",
      kind: "dispute.foreign",
      message: `Litige Stripe ${d.id} reçu sur un paiement qui n'est pas un checkout de cette boutique (${paymentId ?? "sans paiement"}) : à traiter dans Stripe.`,
      data: { disputeId: d.id, paymentId },
      alert: type === "charge.dispute.created",
    });
    return;
  }
  const dueAt = d.evidence_details?.due_by ? new Date(d.evidence_details.due_by * 1000) : null;
  // An update for a dispute we never saw open (lost charge.dispute.created): open it first.
  if (type === "charge.dispute.created" || !(await alreadyDisputed(target))) {
    if (past && (target.kind === "session" || target.kind === "offer")) {
      await recordEvent({
        storeId: store.id,
        sessionId: target.sessionId,
        level: "warn",
        kind: "dispute.past_account",
        message: `Litige Stripe ${d.id} sur un paiement de l'ancien compte Stripe ${past} : les preuves sont envoyées sur ce compte ; si l'app n'y a plus accès (envoi en échec), répondez directement dans Stripe${
          dueAt ? ` avant le ${dueAt.toISOString().slice(0, 10)}` : ""
        }.`,
        data: { disputeId: d.id, paymentId, account: past },
        alert: true,
      });
    }
    if (target.kind === "session") await recordDispute(target.sessionId, d.id, dueAt);
    else if (target.kind === "offer") await recordUpsellDispute(paymentId!, store.id, d.id, dueAt);
    else {
      await recordEvent({
        storeId: store.id,
        sessionId: target.sessionId,
        level: "error",
        kind: "dispute.created",
        message: `Litige Stripe ouvert sur ${target.kind === "extra" ? "un paiement en double" : "un ancien essai d'offre"} (${paymentId}) : répondez dans Stripe${
          dueAt ? ` avant le ${dueAt.toISOString().slice(0, 10)}` : ""
        } — un remboursement de ce paiement clôt souvent le litige.`,
        data: { disputeId: d.id, paymentId },
        alert: true,
      });
    }
  }
  const outcome = stripeDisputeOutcome(d.status);
  if (outcome) {
    // The lost amount in the dispute's currency, read like a Whop event's (`amount` in units + `currency`).
    const cents = stripeAmountToCents(d.amount, d.currency);
    await recordDisputeOutcome(store.id, target, d.id, { status: outcome, ...(cents != null ? { amount: cents / 100, currency: d.currency.toUpperCase() } : {}) });
  }
}

/**
 * Background replay of a Stripe event whose handling failed or was interrupted: from its stored copy,
 * or — when that copy was truncated — re-read from Stripe.
 */
export async function replayStripeEvent(storeId: string, eventId: string, payload: unknown): Promise<string | null> {
  const store = await db.store.findUniqueOrThrow({ where: { id: storeId } });
  const stored = payload as (Partial<Stripe.Event> & { truncated?: boolean }) | null;
  const usable = !!stored && !stored.truncated && typeof stored.type === "string" && !!stored.data?.object;
  if (usable) return handleStripeEvent(stored as Stripe.Event, store, { source: "replay" });
  // Truncated copy: re-read on the account and in the mode it was delivered for (kept by safePayload),
  // not the store's current ones (a past account, a mode switch since).
  const account = typeof stored?.account === "string" && stored.account ? stored.account : null;
  const livemode = typeof stored?.livemode === "boolean" ? stored.livemode : null;
  if (!account && !store.stripeAccountId) throw new Error("copie de l'événement tronquée et compte Stripe déconnecté : impossible de le relire");
  const event = await retrieveStripeEvent(stripeForMode(store, livemode, account), eventId);
  // Re-read from Stripe, but an event's object is its snapshot at the time: still a later copy.
  return handleStripeEvent(account && !event.account ? { ...event, account } : event, store, { source: "replay" });
}

/* ------------------------------------------------------------------ */
/* Reconciliation                                                      */
/* ------------------------------------------------------------------ */

/** First walk of a store (no mark yet): this far back. Stripe keeps events 30 days. */
const FIRST_LOOKBACK_MS = 48 * 3600_000;
const MAX_LOOKBACK_MS = 29 * 24 * 3600_000;
/** Events can show up in the list a little after their creation time. */
const OVERLAP_MS = 15 * 60_000;
const MAX_PAGES_PER_RUN = 3;
/** An event that keeps failing stops holding the mark back after this long (the merchant is told). */
const BLOCK_MAX_MS = 24 * 3600_000;

type StripeReconcileRun = { stopAt: number; newest: number; cursor: string | null; startedAt: number; blockedAt: number | null };

/**
 * Tick job: payments, refunds and disputes whose Stripe webhook never came (endpoint deleted, secret
 * rotated, outage). Per connected store, walks the account's events of those types (newest first)
 * down to a per-store mark (`stripe-reconcile:<store>`, AppSetting) and runs each one this store hasn't
 * handled yet through the webhook's own handler. Events are listed by the time they happened (a
 * payment's success, a refund's, a dispute's change), so a PaymentIntent created long before it was
 * paid is never missed. A walk cut short resumes from its cursor (`stripe-reconcile-run:<store>`).
 * Returns the payments healed.
 */
export async function reconcileStripe(deadline: number): Promise<number> {
  const all = await db.store.findMany({ where: { stripeAccountId: { not: null }, stripeConnectedAt: { not: null } } });
  const { list: stores, advance } = await rotateStores("stripeReconciled", all);
  let healed = 0;
  let processed = 0;
  for (const store of stores) {
    if (stopForTime(deadline)) break;
    try {
      if (!(await reconcilableNow(store))) {
        processed++;
        continue;
      }
      healed += await reconcileStripeStore(store, deadline);
      processed++;
    } catch (err) {
      if (err instanceof DeadlineError) {
        notePartial();
        break;
      }
      processed++;
      await stripeReconcileFailed(store, err);
    }
  }
  await advance(processed);
  return healed;
}

/**
 * Why the reconciliation can't read a store's Stripe account in its current mode, null when it can:
 * that mode's platform keys missing, or a live store whose connection is a test-mode one (live keys
 * can't read it: its 401 must not pass for a revocation). Pure (env passed in).
 */
export function stripeReconcileBlocker(store: Pick<Store, "testMode" | "stripeLivemode">, source: Record<string, string | undefined> = process.env): string | null {
  const mode = store.testMode ? "test" : "live";
  if (!stripeConfigured(mode, source)) return `les clés Stripe ${mode === "test" ? "de test" : "de production"} manquent sur le serveur`;
  if (!store.testMode && store.stripeLivemode === false) return "le compte Stripe a été connecté en mode test alors que la boutique est en production";
  return null;
}

/**
 * Whether the reconciliation reads this store now. Not readable: skipped, journaled and alerted once
 * per reason (marker `stripe-reconcile-skip:<store>`), not every run; the marker goes once it is readable again.
 */
async function reconcilableNow(store: Store): Promise<boolean> {
  const key = `stripe-reconcile-skip:${store.id}`;
  const reason = stripeReconcileBlocker(store);
  if (!reason) {
    await db.appSetting.deleteMany({ where: { key } });
    return true;
  }
  const previous = await db.appSetting.findUnique({ where: { key }, select: { value: true } });
  if (previous?.value === reason) return false;
  await db.appSetting.upsert({ where: { key }, create: { key, value: reason }, update: { value: reason } });
  await recordEvent({
    storeId: store.id,
    level: "warn",
    kind: "reconcile.stripe_skipped",
    message: `Vérification des paiements Stripe suspendue : ${reason}. Les webhooks Stripe restent la seule source tant que ce n'est pas corrigé (voir la page Stripe).`,
    data: { reason },
    alert: true,
  });
  return false;
}

/** HTTP status of a Stripe SDK error, or null when Stripe never answered. Pure. */
export function stripeStatus(err: unknown): number | null {
  const v = (err as { statusCode?: unknown } | null)?.statusCode;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** "auth" (401/403: access revoked or keys wrong), "transient" (timeout, no answer, 429, 5xx) or "other". Pure. */
export function stripeFailureKind(err: unknown): "auth" | "transient" | "other" {
  const status = stripeStatus(err);
  const type = (err as { type?: unknown } | null)?.type;
  if (status === 401 || status === 403 || type === "StripeAuthenticationError" || type === "StripePermissionError") return "auth";
  if (status != null) return status === 408 || status === 429 || status >= 500 ? "transient" : "other";
  const name = err instanceof Error ? err.name : "";
  if (type === "StripeConnectionError" || type === "StripeRateLimitError" || name === "TimeoutError" || name === "AbortError") return "transient";
  return "other";
}

async function stripeReconcileFailed(store: Store, err: unknown) {
  const kind = stripeFailureKind(err);
  const message = err instanceof Error ? err.message : String(err);
  log.warn("reconcile.stripe_failed", "Stripe reconciliation failed for a store", { storeId: store.id, failure: kind, err });
  if (kind === "transient") {
    notePartial();
    await recordIncident({
      storeId: store.id,
      kind: "reconcile.stripe_slow",
      message: `Stripe lent ou indisponible : vérification des paiements Stripe reportée au prochain passage (${message.slice(0, 200)}).`,
      data: { status: stripeStatus(err) },
      alert: false,
      everyMs: 30 * 60_000,
      err,
    });
    return;
  }
  // Access revoked in Stripe without the deauthorization webhook: the store forgets the account
  // (journaled and alerted there) instead of an hourly « Reconnectez Stripe » forever.
  if (kind === "auth" && (await detectRevokedStripeAccount(store).catch(() => false))) return;
  // A lasting failure (access revoked, server keys missing) is journaled and alerted hourly, not every run.
  if (!(await rateLimit(`stripe-reconcile-failed:${store.id}`, 1, 60 * 60_000))) return;
  await recordEvent({
    storeId: store.id,
    level: kind === "auth" ? "error" : "warn",
    kind: "reconcile.stripe_failed",
    message:
      kind === "auth"
        ? `Vérification des paiements Stripe refusée par Stripe (${stripeStatus(err) ?? "accès refusé"}) : ${message}. Reconnectez Stripe depuis la page Stripe.`
        : `Vérification des paiements Stripe impossible : ${message}. Nouvel essai au prochain passage.`,
    data: { failure: kind, status: stripeStatus(err) },
    alert: true,
    err,
  });
}

async function reconcileStripeStore(store: Store, deadline: number): Promise<number> {
  const markKey = `stripe-reconcile:${store.id}`;
  const runKey = `stripe-reconcile-run:${store.id}`;
  const [mark, pending] = await Promise.all([db.appSetting.findUnique({ where: { key: markKey } }), db.appSetting.findUnique({ where: { key: runKey } })]);
  let run: StripeReconcileRun | null = null;
  try {
    run = pending ? (JSON.parse(pending.value) as StripeReconcileRun) : null;
  } catch {
    run = null;
  }
  const markMs = mark ? new Date(mark.value).getTime() : NaN;
  const stopAt = run?.stopAt ?? Math.max(Date.now() - MAX_LOOKBACK_MS, Number.isFinite(markMs) ? markMs - OVERLAP_MS : Date.now() - FIRST_LOOKBACK_MS);
  let newest = Math.max(run?.newest ?? 0, Number.isFinite(markMs) ? markMs : 0);
  let cursor = run?.cursor ?? null;
  let blockedAt = run?.blockedAt ?? null;
  const walkStartedAt = run?.startedAt ?? Date.now();
  let healed = 0;
  let complete = false;
  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    if (page > 0 && stopForTime(deadline)) break;
    const res = await listStripeEvents(store, stopAt / 1000, cursor);
    // Events this store already handled (webhook, replay, an earlier walk): skipped without a Stripe call.
    const seen = new Set(
      (await db.webhookEvent.findMany({ where: { storeId: store.id, id: { in: res.data.map((e) => `${STRIPE_EVENT_PREFIX}${e.id}`) } }, select: { id: true } })).map((r) => r.id),
    );
    for (const event of res.data) {
      const at = event.created * 1000;
      newest = Math.max(newest, at);
      const key = `${STRIPE_EVENT_PREFIX}${event.id}`;
      if (seen.has(key)) continue;
      if (stopForTime(deadline)) throw new DeadlineError("événements Stripe");
      const outcome: Outcome = {};
      try {
        const syncId = await handleStripeEvent(event, store, { outcome, source: "reconcile" });
        if (syncId && !defer("order.sync", () => syncOrderSafely(syncId))) await syncOrderSafely(syncId);
      } catch (err) {
        if (err instanceof DeadlineError) throw err;
        // Not attributable yet (payment not recorded), or failing: the mark stays before it (retried
        // next run) for a day at most; then it stops holding the walk and a human is told.
        if (Date.now() - at < BLOCK_MAX_MS) {
          blockedAt = blockedAt == null ? at : Math.min(blockedAt, at);
          log.warn("reconcile.stripe_event_failed", `Stripe event ${event.type} not reconciled yet`, { storeId: store.id, eventId: event.id, err });
        } else {
          await recordEvent({
            storeId: store.id,
            level: "error",
            kind: "reconcile.stripe_event_failed",
            message: `Événement Stripe ${event.type} (${event.id}) impossible à traiter depuis 24 h (${err instanceof Error ? err.message : String(err)}) : vérifiez-le dans Stripe.`,
            data: { eventId: event.id, type: event.type },
            alert: true,
          });
        }
        continue;
      }
      // Remembered as handled: the webhook arriving late (or the next walk's overlap) skips it.
      await db.webhookEvent.createMany({ data: [{ id: key, storeId: store.id, type: event.type, processedAt: new Date(), payload: { reconciled: true } }], skipDuplicates: true });
      if (event.type === "payment_intent.succeeded" && outcome.paidNow) {
        healed++;
        const pi = event.data.object as Stripe.PaymentIntent;
        const sessionId = await sessionForPayment(store.id, pi);
        await recordEvent({
          storeId: store.id,
          sessionId,
          level: "warn",
          kind: "reconcile.healed",
          message: `Paiement Stripe ${pi.id} récupéré par la réconciliation : le webhook Stripe n'était pas arrivé.`,
          data: { paymentId: pi.id, provider: "stripe" },
          alert: true,
        });
      }
    }
    if (!res.hasMore || !res.data.length) {
      complete = true;
      break;
    }
    cursor = res.data[res.data.length - 1].id;
  }
  if (complete) {
    // Newest first: the mark only moves once the walk reached it; never past an event still failing.
    const value = new Date(blockedAt != null ? blockedAt - 1000 : Math.max(newest, walkStartedAt - OVERLAP_MS)).toISOString();
    await db.appSetting.upsert({ where: { key: markKey }, create: { key: markKey, value }, update: { value } });
    if (pending) await db.appSetting.delete({ where: { key: runKey } }).catch(() => undefined);
  } else {
    const value = JSON.stringify({ stopAt, newest, cursor, startedAt: walkStartedAt, blockedAt } satisfies StripeReconcileRun);
    await db.appSetting.upsert({ where: { key: runKey }, create: { key: runKey, value }, update: { value } });
    notePartial();
    log.info("reconcile.stripe_partial", "Stripe reconciliation paused, will resume from cursor", { storeId: store.id });
  }
  return healed;
}
