import "server-only";
import { extFetch } from "./ext";
import { createHash } from "node:crypto";
import type { CheckoutSession, Prisma, Store } from "@prisma/client";
import { db } from "./db";
import { decrypt } from "./crypto";
import { env } from "./env";
import { log, recordEvent } from "./log";
import { boundedTimeout, DeadlineError, stopForTime } from "./deadline";
import type { CartLine } from "./pricing";
import { blendedVatRate, splitVat, vatRate } from "./vat";
import { loadVatCategories } from "./vat-categories";
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
  /** GA4 client id from the _ga cookie. */
  ga?: string;
  /** Shopify Customer Privacy API answer on the storefront: false = refused, null/absent = no banner. */
  marketing?: boolean | null;
};

type Session = CheckoutSession & { store: Store };
type Platform = "meta" | "tiktok" | "ga4";
type PixelStatus = Partial<Record<Platform, "sent" | "failed">>;

/** A conversion to report: the checkout itself, its purchase, or a post-purchase offer. */
export type ConversionEvent = {
  kind: "purchase" | "checkout" | "payment_info";
  /** Dedupe key shared with the browser pixel. */
  eventId: string;
  time: Date;
  valueCents: number;
  /**
   * "Profit" value mode: the order's revenue (TTC) and margin. Meta/TikTok get the margin as their
   * value (POAS bidding); GA4 keeps `value` = revenue (its revenue reports and imported Google Ads
   * conversions stay true) and gets the margin as the custom `profit` parameter.
   */
  revenueCents?: number;
  profitCents?: number;
  /**
   * "Profit" mode, but a product cost of the order is unknown: no margin can be computed, and the
   * revenue must not stand in for it (POAS bidding would read revenue as profit). Meta / TikTok get
   * no value at all, GA4 its revenue without the `profit` parameter; journaled once a day per store.
   */
  profitUnknown?: boolean;
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
/** Countries where the leading 0 is part of the number itself (not a trunk prefix). */
const KEEP_LEADING_ZERO = new Set(["IT", "SM", "VA"]);

export function e164(phone: string | null | undefined, country: string | null | undefined): string | undefined {
  if (!phone) return undefined;
  const trimmed = phone.trim().replace(/\(0\)/g, "");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return undefined;
  if (trimmed.startsWith("+")) return digits;
  if (digits.startsWith("00")) return digits.slice(2);
  const cc = country ? CALLING_CODES[country.toUpperCase()] : undefined;
  if (!cc) return digits;
  // Already international without "+" (e.g. "33612345678"): only when long enough to hold
  // a country code on top of a national number, so "3xx…" national numbers aren't mistaken.
  if (digits.startsWith(cc) && digits.length >= cc.length + 9 && !digits.startsWith("0")) return digits;
  if (digits.startsWith("0") && !KEEP_LEADING_ZERO.has(country!.toUpperCase())) digits = digits.slice(1);
  return cc + digits;
}

const numericId = (gid: string) => gid.split("/").pop() ?? gid;

/** Meta content id: plain variant id, or the Shopify Facebook-channel catalog format. */
function contentId(store: Store, line: ConversionEvent["lines"][number], country: string) {
  return store.metaContentIdFormat === "shopify"
    ? `shopify_${country}_${numericId(line.productId)}_${numericId(line.variantId)}`
    : numericId(line.variantId);
}

export function sessionEvent(session: Session, kind: "purchase" | "checkout", margin?: MarginContext): ConversionEvent {
  const lines = session.lines as unknown as CartLine[];
  const total = kind === "purchase" ? session.totalCents : session.subtotalCents;
  const profitMode = session.store.conversionValueMode === "profit";
  const unknown = profitMode && !costsKnown(lines);
  const profit = profitMode && !unknown ? profitValueCents(session, total, lines, margin) : null;
  return {
    kind,
    eventId: `${kind}-${session.id}`,
    time: kind === "purchase" && session.paidAt ? session.paidAt : session.createdAt,
    valueCents: profit ?? total,
    ...(profit != null ? { revenueCents: total, profitCents: profit } : {}),
    ...(unknown ? { revenueCents: total, profitUnknown: true } : {}),
    lines,
  };
}

/** Every (non-free) line has a known product cost: the margin can be computed. Pure. */
export function costsKnown(lines: Pick<CartLine, "unitCostCents" | "quantity">[]): boolean {
  return lines.every((l) => !(l.quantity > 0) || (l.unitCostCents != null && Number.isFinite(l.unitCostCents)));
}

/** "Profit" mode without the product costs of an order: journaled at most once a day per store (never alerted). */
async function noteProfitUnknown(storeId: string, what: string) {
  const day = new Date().toISOString().slice(0, 10);
  const key = `profit-unknown:${storeId}`;
  const first = await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${key}, ${day}, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
    WHERE "AppSetting"."value" < ${day}`.catch(() => 0);
  if (!first) return;
  await recordEvent({
    storeId,
    level: "warn",
    kind: "conversion.profit_unknown",
    message: `Valeur de conversion « marge » : coût produit inconnu pour ${what}. Aucune valeur n'est envoyée à Meta / TikTok pour ces commandes (le CA ne remplace jamais la marge), GA4 reçoit le CA sans la marge. Renseignez les coûts dans Coûts produits (ou le coût unitaire dans Shopify).`,
    data: { what },
  });
}

/**
 * Costs of an order that aren't on its lines, as Analytics counts them (see ordersCte in
 * analytics.ts): carrier cost of the paid quote's rate, order-bump costs, and Whop's fee
 * (the recorded one, else an estimate from the store's recent payments).
 */
export type MarginContext = {
  shipCostCents: number;
  bumpCostCents: number;
  feeCents: number | null;
  feeRate: number;
  /** Reduced-rate variants of the store (Coûts produits › TVA): the order's HT uses its lines' blended rate. */
  vatCategories?: Map<string, string>;
};

/** Whop's fee rate used when a payment's fee isn't known yet (card + platform, conservative). */
export const DEFAULT_FEE_RATE = 0.03;

/** Fee rate of the store's recent payments (recorded fees ÷ amounts), else DEFAULT_FEE_RATE. */
export async function storeFeeRate(storeId: string): Promise<number> {
  const [r] = await db.$queryRaw<{ fee: number | null; total: number | null }[]>`
    SELECT sum("whopFeeCents")::float8 AS fee, sum("totalCents")::float8 AS total FROM (
      SELECT "whopFeeCents", "totalCents" FROM "CheckoutSession"
      WHERE "storeId" = ${storeId} AND status = 'PAID' AND "whopFeeCents" IS NOT NULL AND "totalCents" > 0
      ORDER BY "paidAt" DESC NULLS LAST LIMIT 200
    ) x`;
  const rate = r?.total ? Number(r.fee ?? 0) / Number(r.total) : NaN;
  return Number.isFinite(rate) && rate >= 0 && rate < 0.3 ? rate : DEFAULT_FEE_RATE;
}

/** Margin context of a paid checkout (paid quote's carrier and bump costs, fee). */
export async function marginContext(session: Pick<CheckoutSession, "storeId" | "paidQuoteId" | "shippingRateId" | "whopFeeCents">): Promise<MarginContext> {
  const quote = session.paidQuoteId
    ? await db.checkoutQuote.findUnique({ where: { id: session.paidQuoteId }, select: { shippingCostCents: true, shippingRateId: true, addOns: true } })
    : null;
  const rateId = quote?.shippingRateId ?? session.shippingRateId;
  const rateCost = quote?.shippingCostCents ?? (rateId ? ((await db.shippingRate.findUnique({ where: { id: rateId }, select: { costCents: true } }))?.costCents ?? null) : null);
  const bumps = Array.isArray(quote?.addOns) ? (quote.addOns as { costCents?: unknown }[]) : [];
  const vatCategories = await loadVatCategories(session.storeId).catch(() => undefined);
  return {
    ...(vatCategories?.size ? { vatCategories } : {}),
    shipCostCents: rateCost ?? 0,
    bumpCostCents: bumps.reduce((t, a) => t + (typeof a?.costCents === "number" ? a.costCents : 0), 0),
    feeCents: session.whopFeeCents ?? null,
    feeRate: session.whopFeeCents == null ? await storeFeeRate(session.storeId) : DEFAULT_FEE_RATE,
  };
}

/**
 * "Profit" value mode (for POAS bidding): the order's margin HT with the same definition as
 * Analytics — total without VAT, minus Whop's fee (estimated when not known yet), product costs
 * (the app's "Coûts produits" or Shopify's unit cost, per line), order-bump costs, the carrier
 * cost of the paid rate and the per-order preparation fee. Unknown costs count as 0; never negative.
 */
export function profitValueCents(
  session: Pick<Session, "shippingAddress" | "store">,
  totalCents: number,
  lines: CartLine[],
  margin: MarginContext = { shipCostCents: 0, bumpCostCents: 0, feeCents: null, feeRate: DEFAULT_FEE_RATE },
  opts: { fulfilment?: boolean } = {},
): number {
  const a = session.shippingAddress as Address | null;
  const vatOpts = { vatExempt: session.store.vatExempt, domesticOnly: session.store.vatDomesticOnly, homeCountry: session.store.homeCountry || undefined };
  const categories = margin.vatCategories;
  const rate = categories?.size ? blendedVatRate(lines, (v) => categories.get(v), a?.countryCode, vatOpts).rate : vatRate(a?.countryCode, vatOpts);
  const ht = splitVat(totalCents, rate).htCents;
  const cogs = lines.reduce((sum, l) => sum + (l.unitCostCents ?? 0) * l.quantity, 0);
  const fee = margin.feeCents ?? Math.round(totalCents * margin.feeRate);
  const fulfil = opts.fulfilment === false ? 0 : (session.store.fulfillmentFeeCents ?? 0);
  return Math.max(0, ht - fee - cogs - margin.bumpCostCents - margin.shipCostCents - fulfil);
}

export function metaPayload(session: Session, e: ConversionEvent) {
  const t = (session.tracking ?? {}) as Tracking;
  const a = session.shippingAddress as Address | null;
  const country = session.store.metaCatalogCountry || "FR";
  return {
    data: [
      {
        event_name: e.kind === "purchase" ? "Purchase" : e.kind === "payment_info" ? "AddPaymentInfo" : "InitiateCheckout",
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
          ...(e.profitUnknown ? {} : { value: e.valueCents / 100 }),
          content_type: "product",
          content_ids: e.lines.map((l) => contentId(session.store, l, country)),
          contents: e.lines.map((l) => ({ id: contentId(session.store, l, country), quantity: l.quantity, item_price: l.unitPriceCents / 100 })),
          num_items: e.lines.reduce((s, l) => s + l.quantity, 0),
          order_id: e.kind === "purchase" ? e.eventId : undefined,
        },
      },
    ],
    // Test orders go to Meta's "Test events" only; live orders are never marked as tests.
    ...(session.test && session.store.metaTestEventCode ? { test_event_code: session.store.metaTestEventCode } : {}),
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
        event: e.kind === "purchase" ? "CompletePayment" : e.kind === "payment_info" ? "AddPaymentInfo" : "InitiateCheckout",
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
          ...(e.profitUnknown ? {} : { value: e.valueCents / 100 }),
          content_type: "product",
          contents: e.lines.map((l) => ({ content_id: numericId(l.variantId), content_name: l.title, quantity: l.quantity, price: l.unitPriceCents / 100 })),
          order_id: e.kind === "purchase" ? e.eventId : undefined,
        },
        page: { url: `${env.appUrl}/c/${session.id}` },
      },
    ],
  };
}

/** GA4 Measurement Protocol (purchases made outside the storefront keep their attribution). */
export function ga4Payload(session: Session, e: ConversionEvent) {
  const t = (session.tracking ?? {}) as Tracking;
  return {
    client_id: t.ga ?? `${Math.abs(hashCode(session.visitorId ?? session.id))}.${Math.floor(session.createdAt.getTime() / 1000)}`,
    timestamp_micros: e.time.getTime() * 1000,
    events: [
      {
        name: e.kind === "purchase" ? "purchase" : e.kind === "payment_info" ? "add_payment_info" : "begin_checkout",
        params: {
          currency: session.currency,
          // Always the revenue: in "profit" mode the margin goes in the custom `profit` parameter
          // (register it as a custom metric in GA4 to report on it), never in `value`.
          value: (e.revenueCents ?? e.valueCents) / 100,
          ...(e.profitCents != null ? { profit: e.profitCents / 100 } : {}),
          ...(e.kind === "purchase" ? { transaction_id: e.eventId } : {}),
          items: e.lines.map((l) => ({ item_id: numericId(l.variantId), item_name: l.title, price: l.unitPriceCents / 100, quantity: l.quantity })),
        },
      },
    ],
  };
}

function hashCode(v: string) {
  let h = 0;
  for (let i = 0; i < v.length; i++) h = (Math.imul(31, h) + v.charCodeAt(i)) | 0;
  return h;
}

/** One ad-platform call: 8 s, never past a background run's hard deadline (see boundedTimeout). */
const PIXEL_TIMEOUT_MS = 8_000;

async function post(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = PIXEL_TIMEOUT_MS) {
  const provider = url.includes("tiktok") ? "tiktok" : url.includes("google-analytics") ? "ga4" : "meta";
  const res = await extFetch(provider, "conversion event", url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
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

function configured(store: Store): Platform[] {
  return [
    ...(store.metaPixelId && store.metaAccessToken ? (["meta"] as const) : []),
    ...(store.tiktokPixelId && store.tiktokAccessToken ? (["tiktok"] as const) : []),
    ...(store.ga4MeasurementId && store.ga4ApiSecret ? (["ga4"] as const) : []),
  ];
}

/**
 * Where a checkout's events may go. A test order only reaches Meta, and only in its
 * test-events mode (it lands in "Test events", not in reporting); TikTok has no
 * equivalent, so test orders never reach it.
 */
export function platformsFor(session: { test: boolean; store: Store }): Platform[] {
  const list = configured(session.store);
  if (!session.test) return list;
  return session.store.metaTestEventCode ? list.filter((p) => p === "meta") : [];
}

async function sendTo(platform: Platform, session: Session, e: ConversionEvent, timeoutMs = PIXEL_TIMEOUT_MS) {
  const s = session.store;
  if (platform === "meta") {
    await post(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(s.metaPixelId!)}/events?access_token=${encodeURIComponent(decrypt(s.metaAccessToken!))}`,
      metaPayload(session, e),
      {},
      timeoutMs,
    );
  } else if (platform === "tiktok") {
    await post("https://business-api.tiktok.com/open_api/v1.3/event/track/", tiktokPayload(session, e), { "Access-Token": decrypt(s.tiktokAccessToken!) }, timeoutMs);
  } else {
    await post(
      `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(s.ga4MeasurementId!)}&api_secret=${encodeURIComponent(decrypt(s.ga4ApiSecret!))}`,
      ga4Payload(session, e),
      {},
      timeoutMs,
    );
  }
}

/** Background retries of a failed purchase event: minutes after each failed try (then given up). */
export const PIXEL_BACKOFF_MINUTES = [5, 30, 120, 360];

/** When a purchase event whose `attempts`-th try just failed is due again (null: no try left). Pure. */
export function pixelNextAttempt(attempts: number, now = Date.now()): Date | null {
  if (attempts >= MAX_PIXEL_ATTEMPTS) return null;
  const min = PIXEL_BACKOFF_MINUTES[Math.min(attempts, PIXEL_BACKOFF_MINUTES.length) - 1] ?? PIXEL_BACKOFF_MINUTES[0];
  return new Date(now + min * 60_000);
}

/** Consent: a refusal on the storefront banner always wins; strict mode also needs an explicit yes. */
export function consentAllows(session: CheckoutSession & { store: Pick<Store, "pixelRequireConsent" | "metaTestEventCode"> }) {
  // Test-mode orders never reach the ad platforms (except in Meta's test-events mode).
  if (session.test && !session.store.metaTestEventCode) return false;
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
  if (!session || session.status !== "PAID" || session.pixelSentAt) return;
  const status = (session.pixelStatus ?? {}) as PixelStatus;
  const pending = consentAllows(session) ? platformsFor(session).filter((p) => status[p] !== "sent") : [];
  if (!pending.length) {
    // Nothing may or can be sent (consent refused, test order, no pixel): settled, never retried.
    if (session.pixelAttempts < MAX_PIXEL_ATTEMPTS && !platformsFor(session).some((p) => status[p] === "failed")) {
      await db.checkoutSession.update({ where: { id: sessionId }, data: { pixelAttempts: MAX_PIXEL_ATTEMPTS } });
    }
    return;
  }
  // Inside the background tick: bounded by its hard deadline; refused (DeadlineError, no try spent) when too late.
  const timeoutMs = boundedTimeout(PIXEL_TIMEOUT_MS, "conversions publicitaires");
  const event = sessionEvent(session, "purchase", session.store.conversionValueMode === "profit" ? await marginContext(session) : undefined);
  if (event.profitUnknown) await noteProfitUnknown(session.storeId, `la commande ${session.shopifyOrderName ?? session.id}`);
  const results = await Promise.allSettled(pending.map((p) => sendTo(p, session, event, timeoutMs)));
  const errors: string[] = [];
  results.forEach((r, i) => {
    status[pending[i]] = r.status === "fulfilled" ? "sent" : "failed";
    if (r.status === "rejected") errors.push(`${pending[i]} : ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
  });
  const done = platformsFor(session).every((p) => status[p] === "sent");
  const updated = await db.checkoutSession.update({
    where: { id: sessionId },
    data: {
      pixelStatus: status as Prisma.InputJsonValue,
      pixelAttempts: { increment: 1 },
      // The retry's own clock (never updatedAt, which every other writer touches).
      pixelNextAttemptAt: done ? null : pixelNextAttempt(session.pixelAttempts + 1),
      ...(done ? { pixelSentAt: new Date() } : {}),
    },
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

/** After this many tries (or when nothing may be sent), a purchase is never retried. */
export const MAX_PIXEL_ATTEMPTS = 5;

/**
 * Background retry: purchases (and one-click offers) whose conversion failed, within Meta's 7-day
 * window, each on its own backoff (pixelNextAttemptAt), oldest due first. A time budget running out
 * stops the job without spending a try (the rest is reported partial and resumed next run).
 */
export async function retryConversions(deadline: number): Promise<number> {
  const now = new Date();
  const due = await db.checkoutSession.findMany({
    where: {
      status: "PAID",
      pixelSentAt: null,
      pixelAttempts: { lt: MAX_PIXEL_ATTEMPTS },
      paidAt: { gt: new Date(Date.now() - 6.5 * 24 * 3600_000) },
      AND: [
        { OR: [{ pixelNextAttemptAt: null }, { pixelNextAttemptAt: { lte: now } }] },
        // Also never attempted (crash between payment and the first send), once settled.
        { OR: [{ pixelAttempts: { gt: 0 } }, { paidAt: { lt: new Date(Date.now() - 10 * 60_000) } }] },
      ],
    },
    select: { id: true },
    orderBy: [{ pixelNextAttemptAt: { sort: "asc", nulls: "first" } }, { paidAt: "asc" }],
    take: 25,
  });
  let n = 0;
  for (const s of due) {
    if (stopForTime(deadline)) return n;
    try {
      await sendPurchaseConversions(s.id);
    } catch (err) {
      if (err instanceof DeadlineError) throw err;
      log.warn("conversion.retry_failed", "Conversion retry failed", { sessionId: s.id, err });
    }
    n++;
  }
  const upsells = await db.upsellCharge.findMany({
    where: {
      status: "PAID",
      pixelSentAt: null,
      pixelAttempts: { lt: MAX_PIXEL_ATTEMPTS },
      createdAt: { gt: new Date(Date.now() - 6.5 * 24 * 3600_000) },
      AND: [
        { OR: [{ pixelNextAttemptAt: null }, { pixelNextAttemptAt: { lte: now } }] },
        { OR: [{ pixelAttempts: { gt: 0 } }, { createdAt: { lt: new Date(Date.now() - 10 * 60_000) } }] },
      ],
    },
    select: { id: true },
    orderBy: [{ pixelNextAttemptAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
    take: 25,
  });
  for (const u of upsells) {
    if (stopForTime(deadline)) return n;
    try {
      await sendUpsellConversions(u.id);
    } catch (err) {
      if (err instanceof DeadlineError) throw err;
      log.warn("conversion.upsell_retry_failed", "Upsell conversion retry failed", { chargeId: u.id, err });
    }
    n++;
  }
  return n;
}

/** Post-purchase offer accepted: its own Purchase event (own dedupe id), retried by the tick. */
export async function sendUpsellConversions(chargeId: string) {
  const charge = await db.upsellCharge.findUnique({ where: { id: chargeId }, include: { session: { include: { store: true } } } });
  if (!charge || charge.status !== "PAID" || charge.pixelSentAt) return;
  const list = consentAllows(charge.session) ? platformsFor(charge.session) : [];
  if (!list.length) {
    await db.upsellCharge.update({ where: { id: chargeId }, data: { pixelAttempts: MAX_PIXEL_ATTEMPTS } });
    return;
  }
  const timeoutMs = boundedTimeout(PIXEL_TIMEOUT_MS, "conversions publicitaires");
  const profitMode = charge.session.store.conversionValueMode === "profit";
  // Offer cost unknown: no margin, and its revenue never stands in for it.
  const costUnknown = profitMode && charge.costCents == null;
  if (costUnknown) await noteProfitUnknown(charge.session.storeId, `l'offre « ${charge.title} »`);
  const upsellProfit =
    profitMode && !costUnknown
      ? profitValueCents(
          charge.session,
          charge.amountCents,
          [{ unitCostCents: charge.costCents, quantity: charge.quantity } as unknown as CartLine],
          // Ships with the order: no carrier cost, bump or second preparation fee; its own Whop fee.
          { shipCostCents: 0, bumpCostCents: 0, feeCents: charge.whopFeeCents, feeRate: charge.whopFeeCents == null ? await storeFeeRate(charge.session.storeId) : DEFAULT_FEE_RATE },
          { fulfilment: false },
        )
      : null;
  const event: ConversionEvent = {
    kind: "purchase",
    eventId: `upsell-${charge.id}`,
    time: charge.createdAt,
    ...(upsellProfit != null ? { revenueCents: charge.amountCents, profitCents: upsellProfit } : {}),
    ...(costUnknown ? { revenueCents: charge.amountCents, profitUnknown: true } : {}),
    valueCents: upsellProfit ?? charge.amountCents,
    lines: [
      {
        variantId: charge.variantId,
        productId: charge.productId ?? "",
        title: charge.title,
        quantity: charge.quantity,
        unitPriceCents: Math.round(charge.amountCents / Math.max(1, charge.quantity)),
      },
    ],
  };
  // Meta/TikTok dedupe by event id, so resending to every platform on retry is harmless.
  const results = await Promise.allSettled(list.map((p) => sendTo(p, charge.session, event, timeoutMs)));
  const ok = results.every((r) => r.status === "fulfilled");
  await db.upsellCharge.update({
    where: { id: chargeId },
    data: { pixelAttempts: { increment: 1 }, pixelNextAttemptAt: ok ? null : pixelNextAttempt(charge.pixelAttempts + 1), ...(ok ? { pixelSentAt: new Date() } : {}) },
  });
  for (const r of results) if (r.status === "rejected") log.warn("conversion.upsell_failed", "Upsell conversion failed", { chargeId, err: r.reason });
}

/** AddPaymentInfo when the buyer submits the payment form (strong signal for ad delivery). Best effort. */
export async function sendPaymentInfoConversions(sessionId: string) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session || session.status === "PAID" || !consentAllows(session)) return;
  const event: ConversionEvent = { ...sessionEvent(session, "checkout"), kind: "payment_info", eventId: `payinfo-${session.id}`, time: new Date(), valueCents: session.totalCents || session.subtotalCents };
  const results = await Promise.allSettled(platformsFor(session).map((p) => sendTo(p, session, event)));
  for (const r of results) if (r.status === "rejected") log.warn("conversion.payment_info_failed", "AddPaymentInfo event failed", { sessionId, err: r.reason });
}

/** InitiateCheckout when the buyer lands on the checkout. Best effort. */
export async function sendCheckoutConversions(sessionId: string) {
  const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
  if (!session || !consentAllows(session)) return;
  const event = sessionEvent(session, "checkout");
  const results = await Promise.allSettled(platformsFor(session).map((p) => sendTo(p, session, event)));
  for (const r of results) if (r.status === "rejected") log.warn("conversion.checkout_failed", "InitiateCheckout event failed", { sessionId, err: r.reason });
}

/** Test button in the dashboard: sends an InitiateCheckout for the latest checkout. */
export async function testConversions(storeId: string) {
  const session = await db.checkoutSession.findFirst({ where: { storeId }, orderBy: { createdAt: "desc" }, include: { store: true } });
  if (!session) throw new Error("Aucun checkout encore créé : ouvrez d'abord le checkout depuis la boutique.");
  // Connection check on every configured platform; flagged as a test so Meta files it
  // under "Test events" when a test code is set.
  const list = configured(session.store);
  const event = { ...sessionEvent(session, "checkout"), eventId: `test-${Date.now()}` };
  const results = await Promise.allSettled(list.map((p) => sendTo(p, { ...session, test: true }, event)));
  const errors = results.flatMap((r, i) => (r.status === "rejected" ? [`${list[i]} : ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`] : []));
  if (errors.length) throw new Error(errors.join(" | "));
  return list.length;
}

/** Props for the browser pixel on our pages, or null when there is nothing to fire. */
export function browserPixel(session: Session, kind: "purchase" | "checkout", margin?: MarginContext) {
  const s = session.store;
  // The browser pixel can't be put in test mode: test orders never fire it.
  if (!(s.metaPixelId || s.tiktokPixelId) || session.test || !consentAllows(session)) return null;
  const e = sessionEvent(session, kind, margin);
  const country = s.metaCatalogCountry || "FR";
  return {
    metaPixelId: s.metaPixelId,
    tiktokPixelId: s.tiktokPixelId,
    event: {
      kind,
      eventId: e.eventId,
      // Profit mode without the product costs: no value (the server-side event carries none either).
      value: e.profitUnknown ? null : e.valueCents / 100,
      currency: session.currency,
      contentIds: e.lines.map((l) => contentId(s, l, country)),
      variantIds: e.lines.map((l) => numericId(l.variantId)),
    },
  };
}
