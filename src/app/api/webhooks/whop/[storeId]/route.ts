import { after } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { json } from "@/lib/http";
import { markPaid, recordDispute, recordRefund, syncOrderSafely } from "@/lib/checkout";
import { handleDisputeAlert } from "@/lib/disputes";
import { log, recordEvent } from "@/lib/log";
import { markUpsellFailed, markUpsellPaid, recordUpsellDispute, recordUpsellRefund } from "@/lib/upsell";
import { eventType, paymentInfoFromWhop, moneyToCents, verifyWhopWebhook, type WhopEvent } from "@/lib/whop";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Whop → app. Must be reachable at this exact URL: a redirect drops the POST body.
 * The event is claimed first (so concurrent redeliveries run once), handled, and
 * answered; the Shopify order is then created after the response. Returns 5xx only
 * when recording the event itself failed, so Whop retries it.
 */
export async function POST(req: Request, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store?.whopWebhookSecret) return json({ error: "unknown store" }, { status: 404 });
  const requestId = req.headers.get("x-vercel-id") ?? req.headers.get("webhook-id") ?? null;

  const raw = await req.text();
  let evt: WhopEvent;
  try {
    evt = verifyWhopWebhook(raw, req.headers, decrypt(store.whopWebhookSecret));
  } catch {
    log.warn("webhook.bad_signature", "Rejected a Whop webhook with an invalid signature", { storeId, requestId, bytes: raw.length });
    return json({ error: "invalid signature" }, { status: 401 });
  }

  const webhookId = req.headers.get("webhook-id") ?? evt.id ?? null;
  const type = eventType(evt);
  const data = (evt.data ?? {}) as Record<string, unknown>;

  // Claim before handling: a concurrent redelivery hits the unique key and stops here.
  if (webhookId) {
    try {
      await db.webhookEvent.create({ data: { id: webhookId, storeId, type, payload: safePayload(raw) } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return json({ ok: true, duplicate: true });
      throw err;
    }
  }
  await db.store.update({ where: { id: store.id }, data: { lastWebhookAt: new Date() } }).catch(() => undefined);

  let syncSessionId: string | null;
  try {
    syncSessionId = await handle(type, data, store.id);
  } catch (err) {
    // Release the claim so Whop's retry can run it again, and make the failure visible.
    if (webhookId) await db.webhookEvent.delete({ where: { id: webhookId } }).catch(() => undefined);
    await recordEvent({
      storeId,
      level: "error",
      kind: "webhook.failed",
      message: `Événement Whop ${type} non traité (${err instanceof Error ? err.message : String(err)}). Whop va le renvoyer.`,
      data: { webhookId, requestId, dataId: data.id ?? null },
      alert: true,
    });
    return json({ error: "processing failed" }, { status: 500 });
  }
  log.info("webhook.handled", `Whop webhook ${type}`, { storeId, webhookId, requestId, dataId: data.id });

  // Shopify can be slow or down: create the order after answering Whop.
  // If this is cut short, the background tick retries it.
  if (syncSessionId) {
    const id = syncSessionId;
    after(() => syncOrderSafely(id));
  }
  return json({ ok: true });
}

/** Handles one event; returns a session id whose Shopify order must be created next. */
async function handle(type: string, data: Record<string, unknown>, storeId: string): Promise<string | null> {
  switch (type) {
    case "payment.succeeded": {
      // One-click post-purchase offers are separate payments on the same session.
      const metadata = (data.metadata ?? {}) as Record<string, unknown>;
      if (typeof metadata.upsell_id === "string") {
        await markUpsellPaid(metadata.upsell_id, String(data.id), storeId);
        return null;
      }
      const sessionId = await sessionIdFor(data, storeId);
      if (!sessionId) return null; // not one of our checkouts (e.g. another product on this Whop account)
      return (await markPaid(sessionId, paymentInfoFromWhop(data), { deferSync: true })) ? sessionId : null;
    }
    case "payment.failed": {
      const metadata = (data.metadata ?? {}) as Record<string, unknown>;
      if (typeof metadata.upsell_id === "string") {
        // A declined one-click offer: free the slot so the buyer can try again.
        await markUpsellFailed(metadata.upsell_id, storeId, typeof data.failure_message === "string" ? data.failure_message : null);
        return null;
      }
      const sessionId = await sessionIdFor(data, storeId);
      if (sessionId) {
        await db.checkoutSession.updateMany({
          where: { id: sessionId, status: { not: "PAID" } },
          data: { status: "FAILED", paymentFailedAt: new Date() },
        });
      }
      return null;
    }
    case "refund.created":
    case "refund.updated": {
      if (data.status && data.status !== "succeeded") return null;
      const paymentId = typeof data.payment_id === "string" ? data.payment_id : null;
      const session = paymentId ? await db.checkoutSession.findUnique({ where: { whopPaymentId: paymentId } }) : null;
      if (!session || session.storeId !== storeId) {
        // Refund of a one-click post-purchase offer (its own payment and Shopify order).
        const amount = moneyToCents(data.amount);
        if (paymentId && amount != null) await recordUpsellRefund(paymentId, storeId, String(data.id ?? ""), amount);
        return null;
      }
      const amount = moneyToCents(data.amount);
      if (amount == null) {
        // Never drop a refund silently: tell the merchant to check it by hand.
        await recordEvent({
          storeId,
          sessionId: session.id,
          level: "error",
          kind: "refund.unreadable",
          message: `Remboursement Whop ${String(data.id ?? "")} reçu sans montant lisible : vérifiez-le et reportez-le dans Shopify.`,
          alert: true,
        });
        return null;
      }
      // Each refund id is applied once; the marker doubles as a lock against concurrent deliveries.
      const marker = `refund:${String(data.id ?? "")}`;
      try {
        await db.webhookEvent.create({ data: { id: marker, storeId, type: "refund" } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return null;
        throw err;
      }
      try {
        await recordRefund(session.id, amount);
      } catch (err) {
        await db.webhookEvent.delete({ where: { id: marker } });
        throw err;
      }
      return null;
    }
    case "dispute.created": {
      const payment = data.payment as { id?: string } | undefined;
      const paymentId = (typeof data.payment_id === "string" ? data.payment_id : payment?.id) ?? null;
      const session = paymentId ? await db.checkoutSession.findUnique({ where: { whopPaymentId: paymentId } }) : null;
      if (session && session.storeId === storeId) await recordDispute(session.id, typeof data.id === "string" ? data.id : null);
      else if (paymentId) await recordUpsellDispute(paymentId, storeId);
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

/** Keeps the raw event for audit (bounded size). */
function safePayload(raw: string) {
  if (raw.length > 50_000) return { truncated: true, length: raw.length };
  try {
    return JSON.parse(raw);
  } catch {
    return { raw: raw.slice(0, 2000) };
  }
}

