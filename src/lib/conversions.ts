import "server-only";
import { createHash } from "node:crypto";
import type { CheckoutSession, Store } from "@prisma/client";
import { db } from "./db";
import { decrypt } from "./crypto";
import { env } from "./env";
import { log, recordEvent } from "./log";
import type { CartLine } from "./pricing";
import type { Address } from "./shopify";

/*
 * Server-side ad conversions (Meta Conversions API, TikTok Events API).
 * Buyers never reach Shopify's thank-you page any more, so the storefront pixels
 * can't see purchases: we send them from the server, with the same event_id the
 * browser would use (the session id) so platforms deduplicate.
 */

/** Browser identifiers captured by the storefront loader. */
export type Tracking = {
  fbp?: string;
  fbc?: string;
  ttp?: string;
  ttclid?: string;
  /** Shopify Customer Privacy API answer on the storefront: false = refused. */
  marketing?: boolean | null;
};

const sha = (v: string | null | undefined) => (v ? createHash("sha256").update(v.trim().toLowerCase()).digest("hex") : undefined);
const digits = (v: string | null | undefined) => (v ? v.replace(/\D/g, "") : undefined);

type Session = CheckoutSession & { store: Store };

export function metaPayload(session: Session, eventName: "Purchase" | "InitiateCheckout", now = Date.now()) {
  const t = (session.tracking ?? {}) as Tracking;
  const a = session.shippingAddress as Address | null;
  const lines = session.lines as unknown as CartLine[];
  const value = (eventName === "Purchase" ? session.totalCents : session.subtotalCents) / 100;
  return {
    data: [
      {
        event_name: eventName,
        event_time: Math.floor((eventName === "Purchase" && session.paidAt ? session.paidAt.getTime() : now) / 1000),
        event_id: `${eventName === "Purchase" ? "purchase" : "checkout"}-${session.id}`,
        action_source: "website",
        event_source_url: `${env.appUrl}/c/${session.id}`,
        user_data: {
          em: sha(session.email) ? [sha(session.email)] : undefined,
          ph: sha(digits(a?.phone)) ? [sha(digits(a?.phone))] : undefined,
          fn: sha(a?.firstName),
          ln: sha(a?.lastName),
          ct: sha(a?.city?.replace(/\s/g, "")),
          zp: sha(a?.zip?.replace(/\s/g, "")),
          country: sha(a?.countryCode),
          external_id: sha(session.email),
          client_ip_address: session.clientIp ?? undefined,
          client_user_agent: session.userAgent ?? undefined,
          fbp: t.fbp,
          fbc: t.fbc,
        },
        custom_data: {
          currency: session.currency,
          value,
          content_type: "product",
          content_ids: lines.map((l) => l.variantId.split("/").pop()),
          contents: lines.map((l) => ({ id: l.variantId.split("/").pop(), quantity: l.quantity, item_price: l.unitPriceCents / 100 })),
          num_items: lines.reduce((s, l) => s + l.quantity, 0),
          order_id: eventName === "Purchase" ? (session.shopifyOrderName ?? session.id) : undefined,
        },
      },
    ],
    ...(session.store.metaTestEventCode ? { test_event_code: session.store.metaTestEventCode } : {}),
  };
}

export function tiktokPayload(session: Session, eventName: "CompletePayment" | "InitiateCheckout", now = Date.now()) {
  const t = (session.tracking ?? {}) as Tracking;
  const a = session.shippingAddress as Address | null;
  const lines = session.lines as unknown as CartLine[];
  return {
    event_source: "web",
    event_source_id: session.store.tiktokPixelId,
    data: [
      {
        event: eventName,
        event_time: Math.floor((eventName === "CompletePayment" && session.paidAt ? session.paidAt.getTime() : now) / 1000),
        event_id: `${eventName === "CompletePayment" ? "purchase" : "checkout"}-${session.id}`,
        user: {
          email: sha(session.email),
          phone: sha(a?.phone ? `+${digits(a.phone)}` : null),
          external_id: sha(session.email),
          ip: session.clientIp ?? undefined,
          user_agent: session.userAgent ?? undefined,
          ttp: t.ttp,
          ttclid: t.ttclid,
        },
        properties: {
          currency: session.currency,
          value: (eventName === "CompletePayment" ? session.totalCents : session.subtotalCents) / 100,
          content_type: "product",
          contents: lines.map((l) => ({ content_id: l.variantId.split("/").pop(), content_name: l.title, quantity: l.quantity, price: l.unitPriceCents / 100 })),
          order_id: eventName === "CompletePayment" ? session.id : undefined,
        },
        page: { url: `${env.appUrl}/c/${session.id}` },
      },
    ],
  };
}

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  // TikTok answers 200 with a non-zero `code` on errors.
  if (url.includes("tiktok")) {
    const code = (JSON.parse(text) as { code?: number; message?: string }).code;
    if (code && code !== 0) throw new Error(`TikTok ${code}: ${text.slice(0, 300)}`);
  }
}

async function send(session: Session, kind: "purchase" | "checkout") {
  const s = session.store;
  const tasks: Promise<unknown>[] = [];
  if (s.metaPixelId && s.metaAccessToken) {
    tasks.push(
      post(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(s.metaPixelId)}/events?access_token=${encodeURIComponent(decrypt(s.metaAccessToken))}`,
        metaPayload(session, kind === "purchase" ? "Purchase" : "InitiateCheckout"),
      ).then(() => "meta"),
    );
  }
  if (s.tiktokPixelId && s.tiktokAccessToken) {
    tasks.push(
      post("https://business-api.tiktok.com/open_api/v1.3/event/track/", tiktokPayload(session, kind === "purchase" ? "CompletePayment" : "InitiateCheckout"), {
        "Access-Token": decrypt(s.tiktokAccessToken),
      }).then(() => "tiktok"),
    );
  }
  const results = await Promise.allSettled(tasks);
  return results;
}

function allowed(session: CheckoutSession) {
  // Respect a refusal given on the storefront's cookie banner.
  return ((session.tracking ?? {}) as Tracking).marketing !== false;
}

/** Purchase event, sent once per session (atomic claim on pixelSentAt). */
export async function sendPurchaseConversions(sessionId: string) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session || session.status !== "PAID" || !allowed(session)) return;
  if (!(session.store.metaPixelId || session.store.tiktokPixelId)) return;
  const claim = await db.checkoutSession.updateMany({ where: { id: sessionId, pixelSentAt: null }, data: { pixelSentAt: new Date() } });
  if (claim.count === 0) return;
  const results = await send(session, "purchase");
  const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  const sent = results.filter((r): r is PromiseFulfilledResult<unknown> => r.status === "fulfilled").map((r) => r.value);
  if (sent.length) {
    await recordEvent({ storeId: session.storeId, sessionId, kind: "conversion.sent", message: `Achat envoyé à ${sent.join(" + ")}` });
  }
  if (failed.length) {
    await recordEvent({
      storeId: session.storeId,
      sessionId,
      level: "warn",
      kind: "conversion.failed",
      message: `Envoi de l'achat aux pixels impossible : ${failed.map((f) => String(f.reason?.message ?? f.reason)).join(" | ")}`,
    });
  }
}

/** InitiateCheckout event when the buyer lands on the checkout. Best effort. */
export async function sendCheckoutConversions(sessionId: string) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session || !allowed(session) || !(session.store.metaPixelId || session.store.tiktokPixelId)) return;
  const results = await send(session, "checkout");
  for (const r of results) {
    if (r.status === "rejected") log.warn("conversion.checkout_failed", "InitiateCheckout event failed", { sessionId, err: r.reason });
  }
}

/** Test button in the dashboard: sends a test InitiateCheckout-like ping. */
export async function testConversions(storeId: string) {
  const session = await db.checkoutSession.findFirst({ where: { storeId }, orderBy: { createdAt: "desc" }, include: { store: true } });
  if (!session) throw new Error("Aucun checkout encore créé : ouvrez d'abord le checkout depuis la boutique.");
  const results = await send(session, "checkout");
  const errors = results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => String(r.reason?.message ?? r.reason));
  if (errors.length) throw new Error(errors.join(" | "));
  return results.length;
}
