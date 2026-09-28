import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma, type Store } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { log, recordEvent } from "./log";
import { AMBIGUOUS_WAIT_MS, formatAmount } from "./checkout";
import { escapeHtml, sendBuyerEmail, sendEmail } from "./notify";
import { ShopifyError, shopifyGraphql, type Address } from "./shopify";
import { DeadlineError } from "./deadline";
import type { CartLine } from "./pricing";

/*
 * Shipping-protection claims: a protected parcel is lost, stolen or damaged and the merchant
 * makes it right (sends it again, or refunds outside the Whop refund: voucher, transfer…).
 * The cost is recorded on the order: it lowers the order's margin in Analytics (like refunds,
 * on the order's date) and feeds the protection P&L (protection revenue − claims).
 * A refund made through Whop is already counted as a refund: it is not a claim cost.
 */

export const CLAIM_KINDS = { reship: "Renvoi du colis", refund: "Remboursement hors Whop" } as const;
export type ClaimKind = keyof typeof CLAIM_KINDS;
export const MAX_CLAIM_CENTS = 100_000_00;

export type ClaimInput = { kind: string; costCents: number | null; note?: string | null };

/** Validated claim, or the error to show. Pure. */
export function checkClaim(i: ClaimInput): { ok: true; kind: ClaimKind; costCents: number; note: string | null } | { ok: false; error: string } {
  if (!(i.kind in CLAIM_KINDS)) return { ok: false, error: "Type de sinistre invalide." };
  if (i.costCents == null || !Number.isInteger(i.costCents) || i.costCents <= 0 || i.costCents > MAX_CLAIM_CENTS) return { ok: false, error: "Coût invalide (ex. 12,50)." };
  const note = i.note?.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300) || null;
  return { ok: true, kind: i.kind as ClaimKind, costCents: i.costCents, note };
}

/** Records a claim on a paid order of the store. Throws a readable error. */
export async function recordClaim(storeId: string, sessionId: string, input: ClaimInput) {
  const checked = checkClaim(input);
  if (!checked.ok) throw new Error(checked.error);
  const session = await db.checkoutSession.findFirst({ where: { id: sessionId, storeId, status: "PAID" }, select: { id: true, currency: true, shopifyOrderName: true } });
  if (!session) throw new Error("Commande introuvable ou non payée.");
  const claim = await db.protectionClaim.create({ data: { storeId, sessionId, kind: checked.kind, costCents: checked.costCents, note: checked.note } });
  await recordEvent({
    storeId,
    sessionId,
    kind: "protection.claim",
    message: `Sinistre déclaré (${CLAIM_KINDS[checked.kind].toLowerCase()}) : ${formatAmount(checked.costCents, session.currency)}${checked.note ? ` — ${checked.note}` : ""}`,
    data: { claimId: claim.id, kind: checked.kind, costCents: checked.costCents },
  });
  return claim;
}

export async function deleteClaim(storeId: string, sessionId: string, claimId: string): Promise<boolean> {
  const r = await db.protectionClaim.deleteMany({ where: { id: claimId, storeId, sessionId } });
  if (r.count) await recordEvent({ storeId, sessionId, kind: "protection.claim_deleted", message: "Sinistre supprimé" });
  return r.count > 0;
}

/* ------------------------------------------------------------------ */
/* Buyer self-serve reports (order status page) → merchant decision    */
/* ------------------------------------------------------------------ */

/** Days after payment during which a protected buyer can report a delivery problem. */
export const CLAIM_WINDOW_DAYS = 30;
export const BUYER_REASONS = ["lost", "stolen", "damaged", "wrong", "other"] as const;
export type BuyerReason = (typeof BUYER_REASONS)[number];
export const REASON_LABELS: Record<BuyerReason, string> = {
  lost: "colis perdu / jamais reçu",
  stolen: "colis volé",
  damaged: "colis ou article abîmé",
  wrong: "article manquant ou erroné",
  other: "autre",
};
const MAX_BUYER_CLAIMS = 3;

export type BuyerClaimInput = { email: string; reason: string; details?: string | null; photoUrl?: string | null; photos?: ClaimPhotoInput[] };

/* ------------------------------------------------------------------ */
/* Photos (uploaded by the buyer, kept in Postgres)                    */
/* ------------------------------------------------------------------ */

export const MAX_CLAIM_PHOTOS = 3;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
/** Whole claim request (photos + fields), under Vercel's 4.5 MB function body limit. */
export const MAX_CLAIM_BODY_BYTES = 4_400_000;
export type ClaimPhotoInput = { type: string; data: Buffer };
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"] as const;

/** The image type of a file from its first bytes (never the declared type alone), or null. Pure. */
export function sniffImage(data: Buffer): (typeof PHOTO_TYPES)[number] | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 12 && data.subarray(0, 4).toString("latin1") === "RIFF" && data.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (data.length >= 6 && /^GIF8[79]a$/.test(data.subarray(0, 6).toString("latin1"))) return "image/gif";
  if (data.length >= 12 && data.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = data.subarray(8, 12).toString("latin1");
    if (/^(heic|heix|hevc|hevx|heim|heis)$/.test(brand)) return "image/heic";
    if (/^(mif1|msf1)$/.test(brand)) return "image/heif";
  }
  return null;
}

/** Photos checked: at most 3, 5 MB each, real images (declared type and content agree). Pure. */
export function checkClaimPhotos(photos: ClaimPhotoInput[]): { ok: true; photos: { mime: string; data: Buffer }[] } | { ok: false; error: "photo_count" | "photo_size" | "photo_type" } {
  if (photos.length > MAX_CLAIM_PHOTOS) return { ok: false, error: "photo_count" };
  const out: { mime: string; data: Buffer }[] = [];
  for (const p of photos) {
    if (!p.data.length || p.data.length > MAX_PHOTO_BYTES) return { ok: false, error: "photo_size" };
    const sniffed = sniffImage(p.data);
    const declared = p.type.toLowerCase().split(";")[0].trim();
    // HEIC / HEIF are one family (phones label them either way); anything else must match exactly.
    const family = (t: string) => (t === "image/heif" ? "image/heic" : t);
    if (!sniffed || !(PHOTO_TYPES as readonly string[]).includes(declared) || family(declared) !== family(sniffed)) return { ok: false, error: "photo_type" };
    out.push({ mime: sniffed, data: p.data });
  }
  return { ok: true, photos: out };
}

/**
 * Content-Disposition of a stored photo: browsers can't show HEIC / HEIF inline (most would show
 * a broken page), so those are downloaded as a file; other images are shown inline. Pure.
 */
export function photoDisposition(photoId: string, mime: string): string {
  return /^image\/hei[cf]$/i.test(mime) ? `attachment; filename="photo-${photoId.replace(/[^\w-]/g, "")}.${mime.toLowerCase().endsWith("heif") ? "heif" : "heic"}"` : "inline";
}

/** Signature of a photo link for the buyer (expires; bound to the photo id). Pure. */
export function photoToken(photoId: string, expires: number, secret = env.sessionSecret): string {
  return createHmac("sha256", secret).update(`claim-photo\n${photoId}\n${expires}`).digest("base64url");
}

/** Buyer link to a photo, valid `ttlMs` (7 days by default). */
export function buyerPhotoUrl(photoId: string, ttlMs = 7 * 86_400_000, now = Date.now()): string {
  const e = Math.floor((now + ttlMs) / 1000) * 1000;
  return `/api/public/claim-photos/${photoId}?e=${e}&t=${photoToken(photoId, e)}`;
}

/** A buyer photo link is genuine and not expired. Pure. */
export function checkPhotoToken(photoId: string, expires: string | null, token: string | null, now = Date.now()): boolean {
  const e = Number(expires);
  if (!token || !Number.isFinite(e) || e < now || e > now + 31 * 86_400_000) return false;
  const a = Buffer.from(photoToken(photoId, e));
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Validated buyer report, or null. Photo: an https link only (no upload). Pure. */
export function checkBuyerClaim(i: BuyerClaimInput): { reason: BuyerReason; details: string | null; photoUrl: string | null } | null {
  if (!(BUYER_REASONS as readonly string[]).includes(i.reason)) return null;
  const details = i.details?.replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").trim().slice(0, 1000) || null;
  let photoUrl: string | null = null;
  if (i.photoUrl?.trim()) {
    try {
      const u = new URL(i.photoUrl.trim());
      if (u.protocol !== "https:" || u.href.length > 500) return null;
      photoUrl = u.href;
    } catch {
      return null;
    }
  }
  return { reason: i.reason as BuyerReason, details, photoUrl };
}

/** The buyer's words for the journal line: one line, ≤ 200 chars, no trailing punctuation (the line goes on after it). Pure. */
export function journalExcerpt(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  const strip = (t: string) => t.replace(/[\s.,;:!?…]+$/u, "") || t;
  return one.length > 200 ? `${strip(one.slice(0, 199))}…` : strip(one);
}

/** Whether a paid order can still be reported: protection bought, within the window. Pure. */
export function claimWindowOpen(paidAt: Date | null, protectionBought: boolean, now = new Date()): boolean {
  return !!paidAt && protectionBought && now.getTime() - paidAt.getTime() <= CLAIM_WINDOW_DAYS * 86_400_000;
}

/** Shipping protection in the paid snapshot's add-ons. */
export async function protectionBought(paidQuoteId: string | null): Promise<boolean> {
  if (!paidQuoteId) return false;
  const q = await db.checkoutQuote.findUnique({ where: { id: paidQuoteId }, select: { addOns: true } });
  return Array.isArray(q?.addOns) && (q.addOns as { id?: string }[]).some((a) => a?.id === "shipping_protection");
}

/**
 * A buyer's report from the order status page: a pending claim (cost 0 until the merchant
 * approves it, never counted in the P&L before) and a merchant alert. Returns an error code
 * ("closed" | "email" | "invalid" | "pending" | "limit") or the claim id.
 */
export async function submitBuyerClaim(
  sessionId: string,
  input: BuyerClaimInput,
): Promise<{ ok: true; id: string } | { ok: false; error: "closed" | "email" | "invalid" | "pending" | "limit" | "photo_count" | "photo_size" | "photo_type" }> {
  const s = await db.checkoutSession.findUnique({
    where: { id: sessionId },
    select: { id: true, storeId: true, status: true, paidAt: true, paidQuoteId: true, email: true, shopifyOrderName: true, protectionClaims: { select: { status: true, source: true } } },
  });
  if (!s || s.status !== "PAID" || !claimWindowOpen(s.paidAt, await protectionBought(s.paidQuoteId))) return { ok: false, error: "closed" };
  // The order's e-mail proves the reporter is the buyer (the page link alone isn't enough).
  if (!s.email || s.email.trim().toLowerCase() !== input.email.trim().toLowerCase()) return { ok: false, error: "email" };
  const checked = checkBuyerClaim(input);
  if (!checked) return { ok: false, error: "invalid" };
  const photos = checkClaimPhotos(input.photos ?? []);
  if (!photos.ok) return { ok: false, error: photos.error };
  const buyerClaims = s.protectionClaims.filter((c) => c.source === "buyer");
  if (buyerClaims.some((c) => c.status === "pending")) return { ok: false, error: "pending" };
  if (buyerClaims.length >= MAX_BUYER_CLAIMS) return { ok: false, error: "limit" };
  let claim: { id: string };
  try {
    claim = await db.protectionClaim.create({
      data: {
        storeId: s.storeId,
        sessionId,
        kind: "reship",
        costCents: 0,
        status: "pending",
        source: "buyer",
        reason: checked.reason,
        note: checked.details,
        photoUrl: checked.photoUrl,
        photos: { create: photos.photos.map((p) => ({ storeId: s.storeId, mime: p.mime, size: p.data.length, data: new Uint8Array(p.data) })) },
      },
      select: { id: true },
    });
  } catch (err) {
    // Two submissions at once (double click, two tabs): one pending claim per order (partial unique
    // index ProtectionClaim_pending_session_key). The first one stands; no second alert.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const existing = await db.protectionClaim.findFirst({ where: { sessionId, status: "pending" }, select: { id: true } });
      if (existing) return { ok: true, id: existing.id };
    }
    throw err;
  }
  await recordEvent({
    storeId: s.storeId,
    sessionId,
    level: "warn",
    kind: "protection.claim_reported",
    message: `Protection colis : le client signale « ${REASON_LABELS[checked.reason]} » sur la commande ${s.shopifyOrderName ?? sessionId}${checked.details ? ` — « ${journalExcerpt(checked.details)} »` : ""} — à accepter ou refuser sur la fiche commande.`,
    data: { claimId: claim.id, reason: checked.reason, photoUrl: checked.photoUrl, photos: photos.photos.length },
    alert: true,
  });
  return { ok: true, id: claim.id };
}

/**
 * Merchant decision on a buyer's report. Approve: kind (reship / refund) and its cost, then it
 * counts in the P&L like any claim; reject: stays at 0. Only a pending claim can be decided.
 */
export async function decideClaim(
  storeId: string,
  sessionId: string,
  claimId: string,
  decision:
    | { approve: true; kind: string; costCents: number | null; note?: string | null; replacement?: boolean; /** Items kept for the replacement order (keys of replacementItems); absent = all. */ replacementKeys?: string[] | null }
    | { approve: false; note?: string | null },
): Promise<{ replacement?: { id: string; name: string } | { error: string }; emailed: boolean }> {
  const claim = await db.protectionClaim.findFirst({ where: { id: claimId, storeId, sessionId }, include: { session: { select: { currency: true } } } });
  if (!claim || claim.status !== "pending") throw new Error("Signalement introuvable ou déjà traité.");
  if (decision.approve) {
    const checked = checkClaim({ kind: decision.kind, costCents: decision.costCents, note: decision.note ?? claim.note });
    if (!checked.ok) throw new Error(checked.error);
    const r = await db.protectionClaim.updateMany({
      where: { id: claimId, status: "pending" },
      data: {
        status: "approved",
        kind: checked.kind,
        costCents: checked.costCents,
        note: checked.note,
        decidedAt: new Date(),
        ...(decision.replacementKeys ? { replacementLines: decision.replacementKeys.slice(0, 200) } : {}),
      },
    });
    if (!r.count) throw new Error("Signalement déjà traité.");
    await recordEvent({
      storeId,
      sessionId,
      kind: "protection.claim_approved",
      message: `Signalement accepté (${CLAIM_KINDS[checked.kind].toLowerCase()}) : ${formatAmount(checked.costCents, claim.session.currency)} comptés en sinistre.`,
      data: { claimId, kind: checked.kind, costCents: checked.costCents },
    });
    // A reship can go out as a 0 € Shopify order (tagged, linked to the claim), then the buyer is told.
    let replacement: { id: string; name: string } | { error: string } | undefined;
    if (checked.kind === "reship" && decision.replacement) {
      replacement = await createReplacementOrder(storeId, claimId).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
    }
    const emailed = await notifyBuyerOfDecision(claimId);
    return { replacement, emailed };
  } else {
    const note = decision.note?.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300) || claim.note;
    const r = await db.protectionClaim.updateMany({ where: { id: claimId, status: "pending" }, data: { status: "rejected", note, decidedAt: new Date() } });
    if (!r.count) throw new Error("Signalement déjà traité.");
    await recordEvent({ storeId, sessionId, kind: "protection.claim_rejected", message: "Signalement de livraison refusé.", data: { claimId } });
    return { emailed: await notifyBuyerOfDecision(claimId) };
  }
}

/* ------------------------------------------------------------------ */
/* Reship: a 0 € replacement order in Shopify                          */
/* ------------------------------------------------------------------ */

const REPLACEMENT_LEASE_MS = 2 * 60_000;

/**
 * Anti-duplicate wait after an orderCreate whose outcome is unknown (timeout, network, 5xx): Shopify's
 * order search needs a few minutes to see an order it may have created, so no new try (manual ones
 * included) before this; the next try looks the order up first.
 */
export const REPLACEMENT_AMBIGUOUS_WAIT_MS = AMBIGUOUS_WAIT_MS;

/** Whole minutes left before a replacement order can be tried again after an ambiguous attempt (0: now). Pure. */
export function replacementWaitMinutes(ambiguousAt: Date | null, now = Date.now()): number {
  if (!ambiguousAt) return 0;
  const left = ambiguousAt.getTime() + REPLACEMENT_AMBIGUOUS_WAIT_MS - now;
  return left > 0 ? Math.ceil(left / 60_000) : 0;
}

/** Merchant-facing refusal during the anti-duplicate wait. Pure. */
export function replacementWaitMessage(minutes: number): string {
  return `Vérification anti-doublon : la dernière tentative n'a pas eu de réponse sûre de Shopify. Réessayez dans ${minutes} min (la commande sera d'abord recherchée dans Shopify, sans doublon).`;
}
export const claimTag = (claimId: string) => `sinistre-${claimId}`;

/** orderCreate input of a replacement: the paid lines again, 100 % off, free shipping, tagged. Pure. */
export function replacementOrderInput(o: {
  claimId: string;
  currency: string;
  email: string | null;
  address: Address | null;
  lines: Pick<CartLine, "variantId" | "quantity" | "requiresShipping" | "unitPriceCents">[];
  originalName: string | null;
  test: boolean;
}): Record<string, unknown> {
  const money = (cents: number) => ({ shopMoney: { amount: (cents / 100).toFixed(2), currencyCode: o.currency } });
  const a = o.address;
  const address = a
    ? { firstName: a.firstName, lastName: a.lastName, address1: a.address1, address2: a.address2 || undefined, city: a.city, provinceCode: a.province || undefined, zip: a.zip, countryCode: a.countryCode, phone: a.phone || undefined }
    : undefined;
  return {
    currency: o.currency,
    ...(o.email ? { email: o.email } : {}),
    financialStatus: "PAID",
    lineItems: o.lines.filter((l) => l.quantity > 0).map((l) => ({ variantId: l.variantId, quantity: l.quantity, requiresShipping: l.requiresShipping, priceSet: money(l.unitPriceCents) })),
    // 100 % off every item: the order totals 0 and still shows what was sent again.
    discountCode: { itemPercentageDiscountCode: { code: "REMPLACEMENT", percentage: 100 } },
    shippingLines: [{ title: "Renvoi (protection colis)", code: "renvoi", source: "whop-checkout", priceSet: money(0) }],
    shippingAddress: address,
    billingAddress: address,
    sourceName: "whop-checkout",
    sourceIdentifier: `claim:${o.claimId}`,
    tags: ["whop-checkout", "remplacement", "protection-colis", claimTag(o.claimId), ...(o.test ? ["test"] : [])],
    note: `Commande de remplacement (sinistre protection colis) de la commande ${o.originalName ?? ""}`.trim(),
    test: o.test,
  };
}

export type ReplacementItem = {
  /** "line:<i>" (paid snapshot line), "addon:<id>" (order bump with a product), "offer:<id>" (offer added to the order). */
  key: string;
  title: string;
  variantId: string;
  quantity: number;
  unitPriceCents: number;
  requiresShipping: boolean;
};

/**
 * Everything the buyer received in the parcel, as replacement order items: the paid snapshot's lines
 * (free gifts included), its order bumps that are products (variantId; the shipping protection
 * isn't), and the one-click offers added to the same Shopify order (merged), paid and not fully
 * refunded. Pure.
 */
export function replacementItems(
  lines: CartLine[],
  addOns: { id?: string; title?: string; priceCents?: number; variantId?: string | null }[],
  offers: { id: string; title: string; variantId: string; quantity: number; amountCents: number; refundedCents: number; status: string; orderMode: string | null }[],
): ReplacementItem[] {
  const out: ReplacementItem[] = [];
  lines.forEach((l, i) => {
    if (l.quantity > 0 && l.variantId) out.push({ key: `line:${i}`, title: l.variantTitle ? `${l.title} · ${l.variantTitle}` : l.title, variantId: l.variantId, quantity: l.quantity, unitPriceCents: l.unitPriceCents, requiresShipping: l.requiresShipping });
  });
  for (const a of addOns) {
    if (!a?.id || !a.variantId) continue;
    out.push({ key: `addon:${a.id}`, title: String(a.title ?? a.id), variantId: a.variantId, quantity: 1, unitPriceCents: Math.max(0, Number(a.priceCents) || 0), requiresShipping: true });
  }
  for (const o of offers) {
    if (o.status !== "PAID" || o.orderMode !== "merged" || o.refundedCents >= o.amountCents || !o.variantId) continue;
    const quantity = Math.max(1, o.quantity);
    out.push({ key: `offer:${o.id}`, title: o.title, variantId: o.variantId, quantity, unitPriceCents: Math.round(o.amountCents / quantity), requiresShipping: true });
  }
  return out;
}

/** The replacement items of a claim's order (the merchant's selection when one was saved). */
export async function claimReplacementItems(sessionId: string, selected: unknown): Promise<ReplacementItem[]> {
  const session = await db.checkoutSession.findUniqueOrThrow({ where: { id: sessionId }, select: { lines: true, paidQuoteId: true, upsells: true } });
  const quote = session.paidQuoteId ? await db.checkoutQuote.findUnique({ where: { id: session.paidQuoteId }, select: { lines: true, addOns: true } }) : null;
  const all = replacementItems(
    ((quote?.lines ?? session.lines) as unknown as CartLine[]) ?? [],
    Array.isArray(quote?.addOns) ? (quote.addOns as { id?: string; title?: string; priceCents?: number; variantId?: string | null }[]) : [],
    session.upsells.map((u) => ({ id: u.id, title: u.title, variantId: u.variantId, quantity: u.quantity, amountCents: u.amountCents, refundedCents: u.refundedCents, status: u.status, orderMode: u.orderMode })),
  );
  if (!Array.isArray(selected)) return all;
  const keep = new Set(selected.filter((k): k is string => typeof k === "string"));
  return all.filter((i) => keep.has(i.key));
}

/** A Shopify refusal of the order (userErrors): nothing was created, the lease can be released. */
class ReplacementRefused extends Error {}

/**
 * Creates (once) the 0 € replacement order of an approved reship claim and links it to the claim.
 * Idempotent: an order already linked, or found by the claim's tag after an ambiguous failure, is
 * returned; a lease keeps two clicks from creating two orders.
 */
export async function createReplacementOrder(storeId: string, claimId: string): Promise<{ id: string; name: string }> {
  const claim = await db.protectionClaim.findFirst({ where: { id: claimId, storeId }, include: { session: { include: { store: true } } } });
  if (!claim || claim.status !== "approved" || claim.kind !== "reship") throw new Error("Sinistre introuvable ou pas un renvoi accepté.");
  if (claim.replacementOrderId) return { id: claim.replacementOrderId, name: claim.replacementOrderName ?? claim.replacementOrderId };
  const store = claim.session.store;
  const wait = replacementWaitMinutes(claim.replacementAmbiguousAt);
  if (wait > 0) throw new Error(replacementWaitMessage(wait));
  const leased = await db.protectionClaim.updateMany({
    where: {
      id: claimId,
      replacementOrderId: null,
      AND: [
        { OR: [{ replacementStartedAt: null }, { replacementStartedAt: { lt: new Date(Date.now() - REPLACEMENT_LEASE_MS) } }] },
        // Atomic with the check above: an ambiguous attempt recorded meanwhile keeps this one out.
        { OR: [{ replacementAmbiguousAt: null }, { replacementAmbiguousAt: { lt: new Date(Date.now() - REPLACEMENT_AMBIGUOUS_WAIT_MS) } }] },
      ],
    },
    data: { replacementStartedAt: new Date() },
  });
  if (!leased.count) {
    const now = await db.protectionClaim.findUnique({ where: { id: claimId }, select: { replacementAmbiguousAt: true } });
    const left = replacementWaitMinutes(now?.replacementAmbiguousAt ?? null);
    if (left > 0) throw new Error(replacementWaitMessage(left));
    throw new Error(
      claim.replacementError
        ? "La dernière tentative n'a pas eu de réponse sûre de Shopify : réessayez dans quelques minutes (la commande sera d'abord recherchée, sans doublon)."
        : "Commande de remplacement déjà en cours de création.",
    );
  }
  const link = async (order: { id: string; name: string }) => {
    await db.protectionClaim.update({ where: { id: claimId }, data: { replacementOrderId: order.id, replacementOrderName: order.name, replacementStartedAt: null, replacementError: null, replacementAmbiguousAt: null } });
    await recordEvent({ storeId, sessionId: claim.sessionId, kind: "protection.replacement_created", message: `Commande de remplacement ${order.name} créée dans Shopify (0 €, étiquette ${claimTag(claimId)}).`, data: { claimId, orderId: order.id } });
    return { id: order.id, name: order.name };
  };
  // Once orderCreate was sent, a failure without Shopify's answer (timeout, network, 5xx) may hide
  // a created order: the lease is then kept (only the error is recorded) until it expires, and the
  // next try looks the order up first.
  let sent = false;
  try {
    // A previous try may have created it without recording it (timeout): look it up by its tag and
    // its source identifier first (two independent indexes).
    const source = `claim:${claimId}`;
    const found = await shopifyGraphql<{ orders: { nodes: { id: string; name: string; tags: string[]; sourceIdentifier?: string | null }[] } }>(
      store,
      `query($q: String!) { orders(first: 5, query: $q) { nodes { id name tags sourceIdentifier } } }`,
      { q: `tag:'${claimTag(claimId)}' OR source_identifier:'${source}'` },
    );
    const existing = found.orders?.nodes?.find((o) => o.tags.includes(claimTag(claimId)) || o.sourceIdentifier === source);
    if (existing) return await link(existing);
    const lines = await claimReplacementItems(claim.sessionId, claim.replacementLines);
    if (!lines.length) throw new ReplacementRefused("aucun article à renvoyer (sélection vide)");
    const order = replacementOrderInput({
      claimId,
      currency: claim.session.currency,
      email: claim.session.email,
      address: claim.session.shippingAddress as unknown as Address | null,
      lines,
      originalName: claim.session.shopifyOrderName,
      test: claim.session.test,
    });
    const create = (inventoryBehaviour: string) =>
      shopifyGraphql<{ orderCreate: { order: { id: string; name: string } | null; userErrors: { field: string[] | null; message: string }[] } }>(
        store,
        `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) { orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } } }`,
        { order, options: { inventoryBehaviour, sendReceipt: false, sendFulfillmentReceipt: true } },
        { retry: false },
      );
    sent = true;
    let data = await create("DECREMENT_OBEYING_POLICY");
    if (data.orderCreate.userErrors?.length && data.orderCreate.userErrors.every((e) => /stock|inventor|quantit|disponib|available/i.test(e.message))) data = await create("BYPASS");
    if (data.orderCreate.userErrors?.length || !data.orderCreate.order) throw new ReplacementRefused(`Shopify : ${data.orderCreate.userErrors.map((e) => e.message).join("; ") || "commande non créée"}`);
    return await link(data.orderCreate.order);
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    const uncertain = sent && replacementOutcomeUncertain(err);
    await db.protectionClaim.update({
      where: { id: claimId },
      // Uncertain: the lease stays (restarted now), so no retry can create a second order before it
      // expires; the retry then finds the order by its tag / source identifier if it exists.
      // The anti-duplicate wait (replacementAmbiguousAt) then refuses any new try for AMBIGUOUS_WAIT_MS.
      data: uncertain
        ? { replacementStartedAt: new Date(), replacementAmbiguousAt: new Date(), replacementError: `${message} (réponse de Shopify incertaine)` }
        : { replacementStartedAt: null, replacementAmbiguousAt: null, replacementError: message },
    });
    await recordEvent({
      storeId,
      sessionId: claim.sessionId,
      level: "warn",
      kind: "protection.replacement_failed",
      message: uncertain
        ? `Commande de remplacement peut-être créée (réponse de Shopify incertaine : ${message}). Réessayez dans ${REPLACEMENT_AMBIGUOUS_WAIT_MS / 60_000} min depuis la fiche commande : elle sera d'abord recherchée dans Shopify, sans doublon.`
        : `Commande de remplacement non créée : ${message}. Réessayez depuis la fiche commande.`,
      data: { claimId, uncertain },
    });
    throw new Error(uncertain ? `${message} — la commande a peut-être été créée : réessayez dans ${REPLACEMENT_AMBIGUOUS_WAIT_MS / 60_000} min (vérification anti-doublon : elle sera d'abord recherchée dans Shopify)` : message);
  }
}

/**
 * Whether a failed orderCreate may still have created the order: anything but Shopify's own refusal
 * (userErrors, or a definite API answer such as a GraphQL error / 4xx) or a call never sent
 * (DeadlineError). Network errors, timeouts, aborts and 5xx are uncertain. Pure.
 */
export function replacementOutcomeUncertain(err: unknown): boolean {
  if (err instanceof ReplacementRefused || err instanceof DeadlineError) return false;
  if (err instanceof ShopifyError) return err.transient;
  return true;
}

/* ------------------------------------------------------------------ */
/* Decision e-mail to the buyer (their checkout language)              */
/* ------------------------------------------------------------------ */

type Lang = "fr" | "en" | "de" | "es" | "it" | "nl";
type DecisionMail = { order: string; shop: string; amount?: string; replacement?: string | null; note?: string | null };

const DECISION_MAIL: Record<Lang, { subject: (m: DecisionMail) => string; reship: (m: DecisionMail) => string; refund: (m: DecisionMail) => string; rejected: (m: DecisionMail) => string; note: string; bye: (shop: string) => string }> = {
  fr: {
    subject: (m) => `Votre signalement pour la commande ${m.order}`,
    reship: (m) => `Bonne nouvelle : votre signalement pour la commande ${m.order} est accepté. Nous vous renvoyons votre commande${m.replacement ? ` (commande de remplacement ${m.replacement})` : ""}, sans frais.`,
    refund: (m) => `Bonne nouvelle : votre signalement pour la commande ${m.order} est accepté. Vous êtes remboursé de ${m.amount}.`,
    rejected: (m) => `Nous avons examiné votre signalement pour la commande ${m.order} : il n'a malheureusement pas pu être accepté.`,
    note: "Message de la boutique",
    bye: (s) => `L'équipe ${s}`,
  },
  en: {
    subject: (m) => `Your report for order ${m.order}`,
    reship: (m) => `Good news: your report for order ${m.order} has been accepted. We are sending your order again${m.replacement ? ` (replacement order ${m.replacement})` : ""}, free of charge.`,
    refund: (m) => `Good news: your report for order ${m.order} has been accepted. You are refunded ${m.amount}.`,
    rejected: (m) => `We have reviewed your report for order ${m.order}: unfortunately it could not be accepted.`,
    note: "Message from the shop",
    bye: (s) => `The ${s} team`,
  },
  de: {
    subject: (m) => `Ihre Meldung zur Bestellung ${m.order}`,
    reship: (m) => `Gute Nachricht: Ihre Meldung zur Bestellung ${m.order} wurde angenommen. Wir senden Ihnen Ihre Bestellung kostenlos erneut zu${m.replacement ? ` (Ersatzbestellung ${m.replacement})` : ""}.`,
    refund: (m) => `Gute Nachricht: Ihre Meldung zur Bestellung ${m.order} wurde angenommen. Sie erhalten ${m.amount} zurück.`,
    rejected: (m) => `Wir haben Ihre Meldung zur Bestellung ${m.order} geprüft: Leider konnte sie nicht angenommen werden.`,
    note: "Nachricht des Shops",
    bye: (s) => `Ihr ${s}-Team`,
  },
  es: {
    subject: (m) => `Tu aviso sobre el pedido ${m.order}`,
    reship: (m) => `Buenas noticias: tu aviso sobre el pedido ${m.order} ha sido aceptado. Te volvemos a enviar tu pedido sin coste${m.replacement ? ` (pedido de sustitución ${m.replacement})` : ""}.`,
    refund: (m) => `Buenas noticias: tu aviso sobre el pedido ${m.order} ha sido aceptado. Te reembolsamos ${m.amount}.`,
    rejected: (m) => `Hemos revisado tu aviso sobre el pedido ${m.order}: lamentablemente no ha podido ser aceptado.`,
    note: "Mensaje de la tienda",
    bye: (s) => `El equipo de ${s}`,
  },
  it: {
    subject: (m) => `La tua segnalazione per l'ordine ${m.order}`,
    reship: (m) => `Buone notizie: la tua segnalazione per l'ordine ${m.order} è stata accettata. Ti rispediamo l'ordine senza costi${m.replacement ? ` (ordine sostitutivo ${m.replacement})` : ""}.`,
    refund: (m) => `Buone notizie: la tua segnalazione per l'ordine ${m.order} è stata accettata. Ti rimborsiamo ${m.amount}.`,
    rejected: (m) => `Abbiamo esaminato la tua segnalazione per l'ordine ${m.order}: purtroppo non è stato possibile accettarla.`,
    note: "Messaggio del negozio",
    bye: (s) => `Il team di ${s}`,
  },
  nl: {
    subject: (m) => `Je melding over bestelling ${m.order}`,
    reship: (m) => `Goed nieuws: je melding over bestelling ${m.order} is geaccepteerd. We sturen je bestelling kosteloos opnieuw${m.replacement ? ` (vervangende bestelling ${m.replacement})` : ""}.`,
    refund: (m) => `Goed nieuws: je melding over bestelling ${m.order} is geaccepteerd. Je krijgt ${m.amount} terug.`,
    rejected: (m) => `We hebben je melding over bestelling ${m.order} bekeken: helaas kon die niet worden geaccepteerd.`,
    note: "Bericht van de winkel",
    bye: (s) => `Het team van ${s}`,
  },
};

/** Subject and text of the decision e-mail in the buyer's language (French by default). Pure. */
export function decisionEmail(
  lang: string | null | undefined,
  d: { status: "approved" | "rejected"; kind: string; order: string; shop: string; amount?: string; replacement?: string | null; note?: string | null },
): { subject: string; text: string } {
  const l = ((["fr", "en", "de", "es", "it", "nl"] as const).find((x) => x === (lang ?? "").slice(0, 2).toLowerCase()) ?? "fr") as Lang;
  const t = DECISION_MAIL[l];
  const body = d.status === "rejected" ? t.rejected(d) : d.kind === "refund" ? t.refund(d) : t.reship(d);
  const note = d.note?.trim() ? `\n\n${t.note} : ${d.note.trim()}` : "";
  return { subject: t.subject(d), text: `${body}${note}\n\n${t.bye(d.shop)}` };
}

/**
 * Tells a buyer who reported a problem what was decided (once per claim: buyerNotifiedAt), through
 * the store's Resend account or the operator's. Never throws: false when nothing was sent.
 */
export async function notifyBuyerOfDecision(claimId: string): Promise<boolean> {
  const claim = await db.protectionClaim.findUnique({ where: { id: claimId }, include: { session: { include: { store: true } } } });
  if (!claim || claim.source !== "buyer" || claim.buyerNotifiedAt || claim.status === "pending" || !claim.session.email) return false;
  const s = claim.session;
  const store: Pick<Store, "resendApiKey" | "emailFrom" | "name"> = s.store;
  const { subject, text } = decisionEmail(s.lang, {
    status: claim.status === "approved" ? "approved" : "rejected",
    kind: claim.kind,
    order: s.shopifyOrderName ?? `#${s.id.slice(-6).toUpperCase()}`,
    shop: s.store.name,
    amount: new Intl.NumberFormat(s.lang ?? "fr-FR", { style: "currency", currency: s.currency }).format(claim.costCents / 100),
    replacement: claim.replacementOrderName,
    note: claim.status === "rejected" ? claim.note : null,
  });
  // Claimed first: two decisions racing never send two e-mails.
  const claimed = await db.protectionClaim.updateMany({ where: { id: claimId, buyerNotifiedAt: null }, data: { buyerNotifiedAt: new Date() } });
  if (!claimed.count) return false;
  try {
    const mail = { to: s.email!, subject, text, html: `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>` };
    const sent = await (store.resendApiKey && store.emailFrom ? sendEmail(store, mail) : sendBuyerEmail(store, mail));
    if (!sent) await db.protectionClaim.update({ where: { id: claimId }, data: { buyerNotifiedAt: null } });
    return sent;
  } catch (err) {
    await db.protectionClaim.update({ where: { id: claimId }, data: { buyerNotifiedAt: null } });
    log.warn("protection.decision_email_failed", "Claim decision e-mail failed", { claimId, err });
    await recordEvent({ storeId: s.storeId, sessionId: s.id, level: "warn", kind: "protection.decision_email_failed", message: "E-mail de décision du sinistre non envoyé au client (vérifiez la clé Resend)." });
    return false;
  }
}

