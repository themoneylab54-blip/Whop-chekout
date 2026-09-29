import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { syncOrderSafely } from "@/lib/checkout";
import { collectDeferred, runDeferred } from "@/lib/deferred";
import { json } from "@/lib/http";
import { log, logContext, recordEvent, withLogContext } from "@/lib/log";
import { flushProviderMetrics } from "@/lib/metrics";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/route";
import { verifyStripeWebhook } from "@/lib/stripe";
import { foreignPaymentHost, handleStripeEvent } from "@/lib/stripe-webhooks";
import { storesForStripeAccount } from "@/lib/stripe-connection";
import { claimEvent, eventKey, failEvent, recordGaveUp, RetryLater, STRIPE_EVENT_PREFIX } from "@/lib/webhooks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Stripe → app: the platform's single Connect endpoint (events of every connected account, live and
 * test). The raw body is verified against the stored signing secrets (then the env fallbacks), the
 * store(s) resolved from `event.account`, and each store claims its own copy (WebhookEvent
 * "stripe:<event id>", per store) before handling, like Whop's.
 *
 * Handled (stripe-webhooks.ts, shared with the replay and the reconciliation): payment_intent.succeeded
 * (markPaid, or the one-click offer's markUpsellPaid), payment_intent.payment_failed (the stale-attempt
 * rule), charge.refunded / charge.refund.updated (refunds counted once, mirrored in Shopify),
 * charge.dispute.* (disputes, evidence, outcomes) and account.application.deauthorized (the store
 * forgets the account, loudly). Database writes only before the answer; the Shopify order and the other
 * follow-ups run after it (after()), each backstopped by the tick. A failed event answers 500 (503 when
 * its payment isn't recorded yet) so Stripe redelivers, and the tick's Stripe replay retries it too.
 * An account no store knows is acknowledged too (200: Stripe would retry a 4xx for days), journaled once.
 * An account a store let go of (disconnected / replaced, < 120 days) still maps to it. A PaymentIntent
 * whose metadata app_host names another deployment (and whose checkout / offer this database doesn't
 * have: APP_URL may have changed since) is acknowledged and ignored (logged hourly). An
 * event of the other mode than the store's is handled with its own mode's keys (stripeForMode).
 */
async function handle(req: Request) {
  const startedAt = Date.now();
  const requestId = (logContext().requestId as string | undefined) ?? null;
  const raw = await req.text();
  const verified = await verifyStripeWebhook(raw, req.headers.get("stripe-signature"));
  if (!verified) {
    // Wrong secret (endpoint re-created elsewhere) or a forged request: never a store's journal (no
    // store is known before verification), logged at most a few times a minute per sender.
    if (await rateLimit(`badsig:stripe:${clientIp(req)}`, 3)) log.warn("webhook.bad_signature", "Stripe webhook refused (invalid signature)", { requestId, bytes: raw.length });
    return json({ error: "invalid signature" }, { status: 400 });
  }
  const { event, mode } = verified;
  const account = event.account ?? null;
  if (!account) {
    log.info("stripe.platform_event", `Stripe platform event ${event.type} ignored`, { eventId: event.id, mode });
    return json({ ok: true, ignored: true });
  }
  // A PaymentIntent of another deployment sharing this Stripe platform (staging / production): not ours
  // (unless its checkout / offer is in this database: APP_URL changed since, see foreignPaymentHost).
  if (event.type.startsWith("payment_intent.")) {
    const host = await foreignPaymentHost((event.data.object as { metadata?: Record<string, unknown> | null }).metadata);
    if (host) {
      if (await rateLimit(`stripe:foreign-host:${host}`, 1, 60 * 60_000)) log.info("stripe.foreign_host", `Stripe event of another deployment (${host}) ignored`, { eventId: event.id, host, mode });
      return json({ ok: true, ignored: true });
    }
  }
  // The stores connected to the account now, then those it was connected to before (its past orders'
  // refunds and disputes, see storesForStripeAccount).
  const { current, past } = await storesForStripeAccount(account);
  const stores = [...current, ...past];
  if (!stores.length) {
    await journalUnknownAccount(account, event.type, event.id);
    return json({ ok: true, unknownAccount: true });
  }

  const key = `${STRIPE_EVENT_PREFIX}${event.id}`;
  let inFlight = false;
  let failed = false;
  let retry = false;
  // Slow follow-ups (Shopify orders, refund mirrors, dispute tags/evidence, conversions) run after the answer.
  const later: Awaited<ReturnType<typeof collectDeferred>>["later"] = [];
  const syncIds: string[] = [];
  for (const store of stores) {
    const claim = await claimEvent(key, store.id, event.type, raw);
    if (claim === "done") continue;
    if (claim === "in_flight") {
      inFlight = true;
      continue;
    }
    try {
      const { result: syncId, later: tasks } = await withLogContext({ requestId, webhookId: key, event: event.type, storeId: store.id }, () =>
        collectDeferred(() => handleStripeEvent(event, store)),
      );
      later.push(...tasks);
      if (syncId) syncIds.push(syncId);
      await db.webhookEvent.update({ where: eventKey(store.id, key), data: { processedAt: new Date(), lastError: null, nextAttemptAt: null } });
      // Stripe's own freshness mark (lastWebhookAt is Whop's: the Whop webhook tile reads it).
      if (store.stripeAccountId === account) await db.store.update({ where: { id: store.id }, data: { lastStripeWebhookAt: new Date() } }).catch(() => undefined);
      log.info("webhook.handled", `Stripe webhook ${event.type}`, { storeId: store.id, webhookId: key, requestId, mode, deferred: tasks.map((t) => t.name) });
    } catch (err) {
      failed = true;
      // Kept (payload included): Stripe's redelivery takes it over, and the tick's Stripe replay retries
      // it with backoff even if Stripe gives up.
      const outcome = await failEvent(store.id, key, err, "webhook").catch(() => null);
      if (outcome?.newlyGaveUp) await recordGaveUp(store.id, key, event.type, outcome, err);
      if (err instanceof RetryLater) {
        retry = true;
        continue;
      }
      if (!outcome?.gaveUp) {
        await recordEvent({
          storeId: store.id,
          level: "error",
          kind: "webhook.failed",
          message: `Événement Stripe ${event.type} non traité (${err instanceof Error ? err.message : String(err)}) : ${
            outcome?.nextAttemptAt ? "rejeu automatique programmé (et nouvel envoi de Stripe)" : "nouvel envoi de Stripe attendu"
          }.`,
          data: { webhookId: key, requestId, dataId: (event.data.object as { id?: string }).id ?? null },
          alert: true,
          err,
        });
      }
    }
  }
  if (later.length || syncIds.length) {
    // Follow-ups share the function's 60 s: external calls refuse to start past this point.
    const hardDeadline = startedAt + 55_000;
    after(() =>
      withLogContext({ requestId, webhookId: key, event: event.type, hardDeadline }, async () => {
        await runDeferred(later, (name, err) => log.error("webhook.deferred_failed", `Deferred ${name} failed (the tick retries it)`, { name, err }));
        for (const id of syncIds) await syncOrderSafely(id);
        await flushProviderMetrics();
      }),
    );
  }
  if (failed) return json({ error: retry ? "retry later" : "processing failed", retry }, { status: retry ? 503 : 500 });
  // Another invocation holds a fresh claim: Stripe retries later instead of this one acknowledging.
  if (inFlight) return json({ ok: false, inFlight: true }, { status: 409 });
  return json({ ok: true });
}

/** Events of an account no store has (disconnected, or connected elsewhere): one journal line per account. */
async function journalUnknownAccount(account: string, type: string, eventId: string) {
  // The revocation of an account no store uses any more (disconnected here, then the app removed in
  // Stripe): expected, never a journal line.
  if (type === "account.application.deauthorized") {
    log.info("stripe.unknown_account_deauthorized", "Stripe deauthorization of an account no store has", { account, eventId });
    return;
  }
  try {
    await db.appSetting.create({ data: { key: `stripe:unknown-account:${account}`, value: new Date().toISOString() } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      log.info("stripe.unknown_account", `Stripe event ${type} for an account no store has`, { account, eventId });
      return;
    }
    throw err;
  }
  await recordEvent({
    storeId: null,
    level: "warn",
    kind: "stripe.unknown_account",
    message: `Événements Stripe reçus pour le compte ${account}, qui n'est connecté à aucune boutique (déconnecté, ou connecté ailleurs) : ignorés.`,
    data: { account, type, eventId },
  });
}

export const POST = route("webhooks.stripe", handle);
