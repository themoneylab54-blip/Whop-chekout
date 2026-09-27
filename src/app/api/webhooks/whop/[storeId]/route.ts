import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { json } from "@/lib/http";
import { markPaid, recordDispute, recordRefund, type PaymentBuyer } from "@/lib/checkout";
import { eventType, moneyToCents, verifyWhopWebhook, type WhopEvent } from "@/lib/whop";

export const dynamic = "force-dynamic";

/**
 * Whop → app. Must be reachable at this exact URL: a redirect drops the POST body.
 * Returns 2xx only once the event is fully handled so Whop retries on failure.
 */
export async function POST(req: Request, ctx: { params: Promise<{ storeId: string }> }) {
  const { storeId } = await ctx.params;
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store?.whopWebhookSecret) return json({ error: "unknown store" }, { status: 404 });

  const raw = await req.text();
  let evt: WhopEvent;
  try {
    evt = verifyWhopWebhook(raw, req.headers, decrypt(store.whopWebhookSecret));
  } catch {
    return json({ error: "invalid signature" }, { status: 401 });
  }

  const webhookId = req.headers.get("webhook-id") ?? evt.id ?? null;
  const type = eventType(evt);
  if (webhookId && (await db.webhookEvent.findUnique({ where: { id: webhookId } }))) {
    return json({ ok: true, duplicate: true });
  }

  const data = (evt.data ?? {}) as Record<string, unknown>;
  try {
    await handle(type, data, store.id);
  } catch (err) {
    console.error(`whop webhook ${type} failed`, err);
    return json({ error: "processing failed" }, { status: 500 });
  }

  if (webhookId) {
    try {
      await db.webhookEvent.create({ data: { id: webhookId, storeId, type } });
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    }
  }
  return json({ ok: true });
}

async function handle(type: string, data: Record<string, unknown>, storeId: string) {
  switch (type) {
    case "payment.succeeded": {
      const sessionId = await sessionIdFor(data, storeId);
      if (!sessionId) return; // not one of our checkouts (e.g. another product on this Whop account)
      const total = (data.total ?? data.final_amount) as { currency?: string } | number | undefined;
      const user = (data.user ?? null) as { email?: string } | null;
      await markPaid(sessionId, {
        id: String(data.id),
        totalCents: moneyToCents(total),
        currency: typeof total === "object" && total?.currency ? total.currency : typeof data.currency === "string" ? data.currency : null,
        checkoutConfigurationId: typeof data.checkout_configuration_id === "string" ? data.checkout_configuration_id : null,
        buyer: {
          email: (typeof data.customer_email === "string" ? data.customer_email : null) ?? user?.email ?? null,
          shippingAddress: (data.shipping_address ?? null) as PaymentBuyer["address"],
          address: (data.shipping_address ?? data.billing_address ?? null) as PaymentBuyer["address"],
          phone: typeof data.customer_phone === "string" ? data.customer_phone : null,
        },
      });
      return;
    }
    case "payment.failed": {
      const sessionId = await sessionIdFor(data, storeId);
      if (sessionId) {
        await db.checkoutSession.updateMany({
          where: { id: sessionId, status: { not: "PAID" } },
          data: { status: "FAILED" },
        });
      }
      return;
    }
    case "refund.created":
    case "refund.updated": {
      if (data.status && data.status !== "succeeded") return;
      const paymentId = typeof data.payment_id === "string" ? data.payment_id : null;
      const session = paymentId ? await db.checkoutSession.findUnique({ where: { whopPaymentId: paymentId } }) : null;
      if (!session || session.storeId !== storeId) return;
      const amount = moneyToCents(data.amount) ?? 0;
      // Each refund id is applied once; the marker doubles as a lock against concurrent deliveries.
      const marker = `refund:${String(data.id ?? "")}`;
      try {
        await db.webhookEvent.create({ data: { id: marker, storeId, type: "refund" } });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
        throw err;
      }
      try {
        await recordRefund(session.id, amount);
      } catch (err) {
        await db.webhookEvent.delete({ where: { id: marker } });
        throw err;
      }
      return;
    }
    case "dispute.created": {
      const payment = data.payment as { id?: string } | undefined;
      const paymentId = (typeof data.payment_id === "string" ? data.payment_id : payment?.id) ?? null;
      const session = paymentId ? await db.checkoutSession.findUnique({ where: { whopPaymentId: paymentId } }) : null;
      if (session && session.storeId === storeId) await recordDispute(session.id);
      return;
    }
    default:
      return;
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
