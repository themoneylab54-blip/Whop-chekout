import "server-only";
import { createHash } from "node:crypto";
import type { CheckoutSession, Prisma, Store } from "@prisma/client";
import { db } from "./db";
import { decrypt } from "./crypto";
import { env } from "./env";
import { log, recordEvent } from "./log";
import type { CartLine } from "./pricing";
import type { Address } from "./shopify";

/*
 * Server-side ad conversions (Meta Conversions API, TikTok Events API).
 * Buyers never reach Shopify's thank-you page any more, so the storefront pixels
 * can't see purchases: we send them from the server with the same event_id as the
 * checkout page's browser pixel (so platforms deduplicate), hashed identity for
 * matching, and per-platform retries in the background tick.
 */

/** Browser identifiers captured by the storefront loader. */
export type Tracking = {
  fbp?: string;
  fbc?: string;
  ttp?: string;
  ttclid?: string;
  /** Shopify Customer Privacy API answer on the storefront: false = refused, null/absent = no banner. */
  marketing?: boolean | null;
};

type Session = CheckoutSession & { store: Store };
type Platform = "meta" | "tiktok";
type PixelStatus = Partial<Record<Platform, "sent" | "failed">>;

/** A conversion to report: the checkout itself, its purchase, or a post-purchase offer. */
export type ConversionEvent = {
  kind: "purchase" | "checkout";
  /** Dedupe key shared with the browser pixel. */
  eventId: string;
  time: Date;
  valueCents: number;
  lines: { variantId: string; productId: string; title: string; quantity: number; unitPriceCents: number }[];
};

const sha = (v: string | null | undefined) => (v ? createHash("sha256").update(v.trim().toLowerCase()).digest("hex") : undefined);

/** Country calling codes for the markets these stores ship to (national numbers start with 0). */
const CALLING_CODES: Record<string, string> = {
  FR: "33", BE: "32", CH: "41", LU: "352", MC: "377", DE: "49", AT: "43", NL: "31", ES: "34", PT: "351", IT: "39", IE: "353",
  GB: "44", DK: "45", SE: "46", NO: "47", FI: "358", PL: "48", CZ: "420", SK: "421", HU: "36", RO: "40", BG: "359", GR: "30",
  HR: "385", SI: "386", EE: "372", LV: "371", LT: "370", CY: "357", MT: "356", MA: "212", DZ: "213", TN: "216", SN: "221",
  CI: "225", RE: "262", GP: "590", MQ: "596", GF: "594", YT: "262", NC: "687", PF: "689", US: "1", CA: "1", AU: "61", AE: "971",
};

/** "06 12 34 56 78" + FR → "33612345678" (E.164 without "+", as Meta and TikTok expect before hashing). */
export function e164(phone: string | null | undefined, country: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  const trimmed = phone.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return undefined;
  if (trimmed.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  const cc = country ? CALLING_CODES[country.toUpperCase()] : undefined;
  if (cc && digits.startsWith("0")) digits = digits.slice(1);
  return cc && !digits.startsWith(cc) ? cc + digits : digits;
}

const numericId = (gid: string) => gid.split("/").pop() ?? gid;

/** Meta content id: plain variant id, or the Shopify Facebook-channel catalog format. */
function contentId(store: Store, line: ConversionEvent["lines"][number], country: string) {
  return store.metaContentIdFormat === "shopify"
    ? `shopify_${country}_${numericId(line.productId)}_${numericId(line.variantId)}`
    : numericId(line.variantId);
}

export function sessionEvent(session: Session, kind: "purchase" | "checkout"): ConversionEvent {
  const lines = session.lines as unknown as CartLine[];
  return {
    kind,
    eventId: `${kind}-${session.id}`,
    time: kind === "purchase" && session.paidAt ? session.paidAt : session.createdAt,
    valueCents: kind === "purchase" ? session.totalCents : session.subtotalCents,
    lines,
  };
}

export function metaPayload(session: Session, e: ConversionEvent) {
  const t = (session.tracking ?? {}) as Tracking;
  const a = session.shippingAddress as Address | null;
  const country = a?.countryCode ?? "FR";
  return {
    data: [
      {
        event_name: e.kind === "purchase" ? "Purchase" : "InitiateCheckout",
        event_time: Math.floor(e.time.getTime() / 1000),
        event_id: e.eventId,
        action_source: "website",
        event_source_url: `${env.appUrl}/c/${session.id}`,
        user_data: {
          em: sha(session.email) ? [sha(session.email)] : undefined,
          ph: sha(e164(a?.phone, a?.countryCode)) ? [sha(e164(a?.phone, a?.countryCode))] : undefined,
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
          value: e.valueCents / 100,
          content_type: "product",
          content_ids: e.lines.map((l) => contentId(session.store, l, country)),
          contents: e.lines.map((l) => ({ id: contentId(session.store, l, country), quantity: l.quantity, item_price: l.unitPriceCents / 100 })),
          num_items: e.lines.reduce((s, l) => s + l.quantity, 0),
          order_id: e.kind === "purchase" ? e.eventId : undefined,
        },
      },
    ],
    ...(session.store.metaTestEventCode ? { test_event_code: session.store.metaTestEventCode } : {}),
  };
}

export function tiktokPayload(session: Session, e: ConversionEvent) {
  const t = (session.tracking ?? {}) as Tracking;
  const a = session.shippingAddress as Address | null;
  const phone = e164(a?.phone, a?.countryCode);
  return {
    event_source: "web",
    event_source_id: session.store.tiktokPixelId,
    data: [
      {
        event: e.kind === "purchase" ? "CompletePayment" : "InitiateCheckout",
        event_time: Math.floor(e.time.getTime() / 1000),
        event_id: e.eventId,
        user: {
          email: sha(session.email),
          phone: sha(phone ? `+${phone}` : null),
          external_id: sha(session.email),
          ip: session.clientIp ?? undefined,
          user_agent: session.userAgent ?? undefined,
          ttp: t.ttp,
          ttclid: t.ttclid,
        },
        properties: {
          currency: session.currency,
          value: e.valueCents / 100,
          content_type: "product",
          contents: e.lines.map((l) => ({ content_id: numericId(l.variantId), content_name: l.title, quantity: l.quantity, price: l.unitPriceCents / 100 })),
          order_id: e.kind === "purchase" ? e.eventId : undefined,
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
    const code = (JSON.parse(text) as { code?: number }).code;
    if (code && code !== 0) throw new Error(`TikTok ${code}: ${text.slice(0, 300)}`);
  }
}

function platforms(store: Store): Platform[] {
  return [
    ...(store.metaPixelId && store.metaAccessToken ? (["meta"] as const) : []),
    ...(store.tiktokPixelId && store.tiktokAccessToken ? (["tiktok"] as const) : []),
  ];
}

async function sendTo(platform: Platform, session: Session, e: ConversionEvent) {
  const s = session.store;
  if (platform === "meta") {
    await post(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(s.metaPixelId!)}/events?access_token=${encodeURIComponent(decrypt(s.metaAccessToken!))}`,
      metaPayload(session, e),
    );
  } else {
    await post("https://business-api.tiktok.com/open_api/v1.3/event/track/", tiktokPayload(session, e), { "Access-Token": decrypt(s.tiktokAccessToken!) });
  }
}

/** Consent: a refusal on the storefront banner always wins; strict mode also needs an explicit yes. */
export function consentAllows(session: CheckoutSession & { store: Pick<Store, "pixelRequireConsent"> }) {
  const marketing = ((session.tracking ?? {}) as Tracking).marketing;
  return session.store.pixelRequireConsent ? marketing === true : marketing !== false;
}

/**
 * Purchase event: sends to every platform not yet acknowledged, records the status per
 * platform, and leaves failures for the background retry (Meta and TikTok dedupe by
 * event_id, so a retry after an unseen success is harmless).
 */
export async function sendPurchaseConversions(sessionId: string) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session || session.status !== "PAID" || session.pixelSentAt || !consentAllows(session)) return;
  const status = (session.pixelStatus ?? {}) as PixelStatus;
  const pending = platforms(session.store).filter((p) => status[p] !== "sent");
  if (!pending.length) return;
  const event = sessionEvent(session, "purchase");
  const results = await Promise.allSettled(pending.map((p) => sendTo(p, session, event)));
  const errors: string[] = [];
  results.forEach((r, i) => {
    status[pending[i]] = r.status === "fulfilled" ? "sent" : "failed";
    if (r.status === "rejected") errors.push(`${pending[i]} : ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });
  const done = platforms(session.store).every((p) => status[p] === "sent");
  const updated = await db.checkoutSession.update({
    where: { id: sessionId },
    data: { pixelStatus: status as Prisma.InputJsonValue, pixelAttempts: { increment: 1 }, ...(done ? { pixelSentAt: new Date() } : {}) },
  });
  const sent = pending.filter((p) => status[p] === "sent");
  if (sent.length) await recordEvent({ storeId: session.storeId, sessionId, kind: "conversion.sent", message: `Achat envoyé à ${sent.join(" + ")}` });
  if (errors.length) {
    await recordEvent({
      storeId: session.storeId,
      sessionId,
      level: "warn",
      kind: "conversion.failed",
      message: `Envoi de l'achat impossible (essai ${updated.pixelAttempts}, nouvel essai automatique) : ${errors.join(" | ")}`,
      alert: updated.pixelAttempts === 1,
    });
  }
}

/** Background retry: purchases whose conversion failed, within Meta's 7-day window. */
export async function retryConversions(deadline: number): Promise<number> {
  const due = await db.checkoutSession.findMany({
    where: {
      status: "PAID",
      pixelSentAt: null,
      pixelAttempts: { gt: 0, lt: 5 },
      paidAt: { gt: new Date(Date.now() - 6.5 * 24 * 3600_000) },
      updatedAt: { lt: new Date(Date.now() - 5 * 60_000) },
    },
    select: { id: true },
    take: 25,
  });
  let n = 0;
  for (const s of due) {
    if (Date.now() > deadline) break;
    await sendPurchaseConversions(s.id).catch((err) => log.warn("conversion.retry_failed", "Conversion retry failed", { sessionId: s.id, err }));
    n++;
  }
  return n;
}

/** Post-purchase offer accepted: its own Purchase event (own dedupe id). Best effort. */
export async function sendUpsellConversions(chargeId: string) {
  const charge = await db.upsellCharge.findUnique({ where: { id: chargeId }, include: { session: { include: { store: true } } } });
  if (!charge || charge.status !== "PAID" || !consentAllows(charge.session)) return;
  const event: ConversionEvent = {
    kind: "purchase",
    eventId: `upsell-${charge.id}`,
    time: charge.createdAt,
    valueCents: charge.amountCents,
    lines: [{ variantId: charge.variantId, productId: "", title: charge.title, quantity: 1, unitPriceCents: charge.amountCents }],
  };
  const results = await Promise.allSettled(platforms(charge.session.store).map((p) => sendTo(p, charge.session, event)));
  for (const r of results) if (r.status === "rejected") log.warn("conversion.upsell_failed", "Upsell conversion failed", { chargeId, err: r.reason });
}

/** InitiateCheckout when the buyer lands on the checkout. Best effort. */
export async function sendCheckoutConversions(sessionId: string) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session || !consentAllows(session)) return;
  const event = sessionEvent(session, "checkout");
  const results = await Promise.allSettled(platforms(session.store).map((p) => sendTo(p, session, event)));
  for (const r of results) if (r.status === "rejected") log.warn("conversion.checkout_failed", "InitiateCheckout event failed", { sessionId, err: r.reason });
}

/** Test button in the dashboard: sends an InitiateCheckout for the latest checkout. */
export async function testConversions(storeId: string) {
  const session = await db.checkoutSession.findFirst({ where: { storeId }, orderBy: { createdAt: "desc" }, include: { store: true } });
  if (!session) throw new Error("Aucun checkout encore créé : ouvrez d'abord le checkout depuis la boutique.");
  const list = platforms(session.store);
  const event = { ...sessionEvent(session, "checkout"), eventId: `test-${Date.now()}` };
  const results = await Promise.allSettled(list.map((p) => sendTo(p, session, event)));
  const errors = results.flatMap((r, i) => (r.status === "rejected" ? [`${list[i]} : ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []));
  if (errors.length) throw new Error(errors.join(" | "));
  return list.length;
}

/** Props for the browser pixel on our pages, or null when there is nothing to fire. */
export function browserPixel(session: Session, kind: "purchase" | "checkout") {
  const s = session.store;
  if (!(s.metaPixelId || s.tiktokPixelId) || !consentAllows(session)) return null;
  const e = sessionEvent(session, kind);
  const country = (session.shippingAddress as Address | null)?.countryCode ?? "FR";
  return {
    metaPixelId: s.metaPixelId,
    tiktokPixelId: s.tiktokPixelId,
    event: {
      kind,
      eventId: e.eventId,
      value: e.valueCents / 100,
      currency: session.currency,
      contentIds: e.lines.map((l) => contentId(s, l, country)),
      variantIds: e.lines.map((l) => numericId(l.variantId)),
    },
  };
}
