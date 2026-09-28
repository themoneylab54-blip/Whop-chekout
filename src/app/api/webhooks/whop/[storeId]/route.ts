import { after } from "next/server";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { json } from "@/lib/http";
import { syncOrderSafely } from "@/lib/checkout";
import { collectDeferred, runDeferred } from "@/lib/deferred";
import { log, logContext, recordEvent, withLogContext } from "@/lib/log";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/route";
import { flushProviderMetrics } from "@/lib/metrics";
import { warnIfTickStale } from "@/lib/tick";
import { tzOf, zoneLabel } from "@/lib/time";
import { claimEvent, eventKey, failEvent, handleEvent, recordGaveUp, RetryLater } from "@/lib/webhooks";
import { eventType, verifyWhopWebhook, type WhopEvent } from "@/lib/whop";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Whop → app. Must be reachable at this exact URL: a redirect drops the POST body.
 * The event is claimed first (so concurrent redeliveries run once) and applied with
 * database writes only, then answered fast; slow follow-ups (Shopify order, refund
 * mirroring, dispute tagging/evidence, ad conversions, alerts) run after the answer,
 * and the background tick backstops each of them.
 */
async function handle(req: Request, ctx: { params: Promise<{ storeId: string }> }) {
  const startedAt = Date.now();
  const { storeId } = await ctx.params;
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store?.whopWebhookSecret) {
    log.warn("webhook.unknown_store", "Whop webhook for an unknown or disconnected store", { storeId });
    return json({ error: "unknown store" }, { status: 404 });
  }
  // Same id as the response's x-request-id header (set by route()); the webhook id is its own field.
  const requestId = (logContext().requestId as string | undefined) ?? null;

  const raw = await req.text();
  let evt: WhopEvent;
  try {
    evt = verifyWhopWebhook(raw, req.headers, decrypt(store.whopWebhookSecret));
  } catch {
    // Usually a rotated secret or a webhook set up from another environment: payments are
    // still healed by reconciliation, but the merchant must reconnect. Journaled at most a
    // few times per minute per sender, so unauthenticated requests can't flood the journal.
    if (await rateLimit(`badsig:${storeId}:${clientIp(req)}`, 3)) {
      await recordEvent({
        storeId,
        level: "error",
        kind: "webhook.bad_signature",
        message: "Webhook Whop refusé (signature invalide) : reconnectez Whop depuis la page Whop pour mettre à jour le secret.",
        data: { requestId, bytes: raw.length },
        alert: true,
      });
    }
    return json({ error: "invalid signature" }, { status: 401 });
  }

  const webhookId = req.headers.get("webhook-id") ?? evt.id ?? null;
  const type = eventType(evt);
  const data = (evt.data ?? {}) as Record<string, unknown>;

  // Claim before handling: a concurrent redelivery hits the (store, webhook id) key and stops
  // here. Per store: a sibling store on the same Whop account gets the same id for its own copy.
  if (webhookId) {
    const claim = await claimEvent(webhookId, storeId, type, raw);
    if (claim === "done") return json({ ok: true, duplicate: true });
    // Still being handled elsewhere: ask Whop to come back rather than acknowledge.
    if (claim === "in_flight") return json({ ok: false, inFlight: true }, { status: 409 });
  }
  await db.store.update({ where: { id: store.id }, data: { lastWebhookAt: new Date() } }).catch(() => undefined);

  let syncSessionId: string | null;
  let later: Awaited<ReturnType<typeof collectDeferred>>["later"];
  try {
    ({ result: syncSessionId, later } = await withLogContext({ requestId, webhookId, event: type }, () => collectDeferred(() => handleEvent(type, data, store.id))));
  } catch (err) {
    // Keep the event (payload included): Whop's redelivery can take it over at once, and
    // the background replay retries it with backoff even if Whop gives up. Whop's own
    // redeliveries never spend the local replay budget.
    const outcome = webhookId
      ? await failEvent(store.id, webhookId, err, "webhook").catch((e) => {
          log.error("webhook.fail_record_failed", "Could not record the failed event", { webhookId, err: e });
          return null;
        })
      : null;
    if (outcome?.newlyGaveUp && webhookId) await recordGaveUp(storeId, webhookId, type, outcome, err);
    if (err instanceof RetryLater) return json({ error: err.message, retry: true }, { status: 503 });
    if (!outcome?.gaveUp) {
      const next = outcome?.nextAttemptAt
        ? `rejeu automatique à ${outcome.nextAttemptAt.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: tzOf(store) })} (${zoneLabel(tzOf(store))}) (et nouvel envoi de Whop)`
        : webhookId
          ? "nouvel envoi de Whop attendu"
          : "événement sans identifiant, non conservé : vérifiez-le dans Whop";
      await recordEvent({
        storeId,
        level: "error",
        kind: "webhook.failed",
        message: `Événement Whop ${type} non traité (${err instanceof Error ? err.message : String(err)}) : ${next}.`,
        data: { webhookId, requestId, dataId: data.id ?? null },
        alert: true,
        err,
      });
    }
    return json({ error: "processing failed" }, { status: 500 });
  }
  if (webhookId) {
    await db.webhookEvent
      .update({ where: eventKey(store.id, webhookId), data: { processedAt: new Date(), lastError: null, nextAttemptAt: null } })
      .catch((err) => log.error("webhook.mark_processed_failed", "Handled event not marked processed (it may be replayed)", { webhookId, err }));
  }
  log.info("webhook.handled", `Whop webhook ${type}`, { storeId, webhookId, requestId, dataId: data.id, deferred: later.map((t) => t.name) });

  const id = syncSessionId;
  // Follow-ups share the function's 60 s: external calls refuse to start past this point.
  const hardDeadline = startedAt + 55_000;
  after(() =>
    withLogContext({ requestId, webhookId, event: type, hardDeadline }, async () => {
      await runDeferred(later, (name, err) => log.error("webhook.deferred_failed", `Deferred ${name} failed (the tick retries it)`, { name, err }));
      if (id) await syncOrderSafely(id);
      // Webhooks arrive but maintenance doesn't run: say so (throttled).
      await warnIfTickStale(store.id);
      await flushProviderMetrics();
    }),
  );
  return json({ ok: true });
}

export const POST = route("webhooks.whop", handle);
