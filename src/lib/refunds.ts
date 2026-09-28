import "server-only";
import { DeadlineError, notePartial, stopForTime } from "./deadline";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { recordEvent } from "./log";
import { createRefund, offerMarker, orderRefundedCents, orderRefunds } from "./shopify";

/*
 * Reports Whop refunds on the Shopify order (a checkout's, or a one-click offer's own
 * order). Crash-safe by construction:
 *  1. a short lease is taken (webhook, order sync and tick can all call this);
 *  2. Shopify's own refunded total is read, and only what is missing is refunded;
 *  3. only then is the amount marked as mirrored.
 * A run killed at any point leaves the amount unmirrored: the next run re-checks
 * Shopify first, so nothing is lost and nothing is refunded twice. Failures back off
 * and give up (with an alert that is never grouped) after MAX_ATTEMPTS.
 */

export type MirrorTarget = "session" | "offer";

/** Lease on one refund mirror (a claim older than this belongs to a run that died). */
export const REFUND_MIRROR_LEASE_MS = 5 * 60_000;
export const MIRROR_BACKOFF_MINUTES = [5, 15, 60, 180, 720];
export const MAX_MIRROR_ATTEMPTS = MIRROR_BACKOFF_MINUTES.length + 1;

const TABLE: Record<MirrorTarget, Prisma.Sql> = {
  session: Prisma.raw(`"CheckoutSession"`),
  offer: Prisma.raw(`"UpsellCharge"`),
};

type Claimed = { refunded: number; mirrored: number; attempts: number };

async function claim(target: MirrorTarget, id: string, force: boolean): Promise<Claimed | null> {
  const t = TABLE[target];
  const due = force ? Prisma.empty : Prisma.sql`AND ("nextRefundMirrorAt" IS NULL OR "nextRefundMirrorAt" <= now())`;
  const rows = await db.$queryRaw<Claimed[]>`
    UPDATE ${t} SET "refundMirrorStartedAt" = now()
    WHERE id = ${id} AND "shopifyOrderId" IS NOT NULL AND "refundedCents" > "refundMirroredCents"
      AND ("refundMirrorStartedAt" IS NULL OR "refundMirrorStartedAt" < ${new Date(Date.now() - REFUND_MIRROR_LEASE_MS)})
      ${due}
    RETURNING "refundedCents" AS refunded, "refundMirroredCents" AS mirrored, "refundMirrorAttempts" AS attempts`;
  return rows[0] ?? null;
}

/** Note marker of a merged offer's refunds on the checkout's order ("[offre <id>]"). */
export const offerRefundMarker = (chargeId: string) => `[offre ${chargeId}]`;
const OFFER_MARK = "[offre ";

type Ctx = {
  store: Awaited<ReturnType<typeof db.store.findUniqueOrThrow>>;
  sessionId: string;
  orderId: string;
  orderName: string | null;
  currency: string;
  what: string;
  /** Merged offer: its refunds carry this marker and target its line of the checkout's order. */
  marker?: string;
  line?: { lineItemId: string; quantity: number; amountCents: number };
  /** Merged offer: marker of its own manual payment on the shared order (the refund's parent). */
  paymentMarker?: string;
  /** The checkout's order also holds merged offers: their (marked) refunds aren't the order's. */
  sharesOrder?: boolean;
};

async function context(target: MirrorTarget, id: string): Promise<Ctx> {
  if (target === "session") {
    const s = await db.checkoutSession.findUniqueOrThrow({ where: { id }, include: { store: true } });
    const merged = await db.upsellCharge.count({ where: { sessionId: s.id, orderMode: "merged" } });
    return { store: s.store, sessionId: s.id, orderId: s.shopifyOrderId!, orderName: s.shopifyOrderName, currency: s.currency, what: "la commande Shopify", sharesOrder: merged > 0 };
  }
  const c = await db.upsellCharge.findUniqueOrThrow({ where: { id }, include: { session: { include: { store: true } } } });
  if (c.orderMode === "merged") {
    return {
      store: c.session.store,
      sessionId: c.sessionId,
      orderId: c.shopifyOrderId!,
      orderName: c.shopifyOrderName,
      currency: c.session.currency,
      what: "la commande d'origine (ligne de l'offre)",
      marker: offerRefundMarker(c.id),
      paymentMarker: offerMarker(c.id),
      line: c.shopifyLineItemId && !c.shopifyLineItemId.startsWith("pending:") ? { lineItemId: c.shopifyLineItemId, quantity: Math.max(1, c.quantity), amountCents: c.amountCents } : undefined,
    };
  }
  return { store: c.session.store, sessionId: c.sessionId, orderId: c.shopifyOrderId!, orderName: c.shopifyOrderName, currency: c.session.currency, what: "la commande de l'offre" };
}

/**
 * What Shopify already holds for this target: the order's refunded total; on an order shared
 * with merged offers, a merged offer counts only its marked refunds and the checkout the rest. Pure.
 */
export function alreadyRefunded(refunds: { note: string; cents: number }[], ctx: Pick<Ctx, "marker" | "sharesOrder">): number {
  if (ctx.marker) return refunds.filter((r) => r.note.includes(ctx.marker!)).reduce((t, r) => t + r.cents, 0);
  if (ctx.sharesOrder) return refunds.filter((r) => !r.note.includes(OFFER_MARK)).reduce((t, r) => t + r.cents, 0);
  return refunds.reduce((t, r) => t + r.cents, 0);
}

/**
 * Mirrors what is missing. `force` ignores the backoff (a new refund just arrived).
 * Returns the amount refunded in Shopify by this call. Never throws.
 */
export async function mirrorRefund(target: MirrorTarget, id: string, opts: { force?: boolean } = {}): Promise<number> {
  const claimed = await claim(target, id, !!opts.force);
  if (!claimed) return 0;
  const refunded = Number(claimed.refunded);
  const ctx = await context(target, id);
  const t = TABLE[target];
  try {
    const already = ctx.marker || ctx.sharesOrder ? alreadyRefunded(await orderRefunds(ctx.store, ctx.orderId), ctx) : await orderRefundedCents(ctx.store, ctx.orderId);
    // What Shopify lacks, never more than what we haven't mirrored yet.
    const missing = Math.min(refunded - Number(claimed.mirrored), refunded - already);
    if (missing > 0) {
      // A merged offer refunded in full also returns its line (no restock); partial refunds are an amount.
      const lineItems = ctx.line && already === 0 && missing >= ctx.line.amountCents ? [{ lineItemId: ctx.line.lineItemId, quantity: ctx.line.quantity }] : [];
      const note = ctx.marker ? `Remboursé via Whop ${ctx.marker}` : "Remboursé via Whop";
      // A merged offer's refund goes against its own payment on the shared order (see planRefundTransactions).
      if (ctx.paymentMarker) await createRefund(ctx.store, ctx.orderId, missing, note, lineItems, { marker: ctx.paymentMarker });
      else await createRefund(ctx.store, ctx.orderId, missing, note, lineItems);
    }
    await db.$executeRaw`
      UPDATE ${t} SET "refundMirroredCents" = GREATEST("refundMirroredCents", ${refunded}), "refundMirrorStartedAt" = NULL,
        "refundMirrorAttempts" = 0, "nextRefundMirrorAt" = NULL
      WHERE id = ${id}`;
    await recordEvent({
      storeId: ctx.store.id,
      sessionId: ctx.sessionId,
      kind: "refund.mirrored",
      message:
        missing > 0
          ? `Remboursement de ${missing / 100} ${ctx.currency} reporté sur ${ctx.orderName ?? ctx.what}`
          : `Remboursement déjà présent sur ${ctx.orderName ?? ctx.what} (rien à refaire)`,
    });
    return Math.max(0, missing);
  } catch (err) {
    if (err instanceof DeadlineError) {
      await db.$executeRaw`UPDATE ${t} SET "refundMirrorStartedAt" = NULL WHERE id = ${id}`;
      notePartial();
      return 0;
    }
    const attempts = Number(claimed.attempts) + 1;
    const delay = MIRROR_BACKOFF_MINUTES[attempts - 1];
    const next = delay != null ? new Date(Date.now() + delay * 60_000) : null;
    await db.$executeRaw`
      UPDATE ${t} SET "refundMirrorStartedAt" = NULL, "refundMirrorAttempts" = ${attempts}, "nextRefundMirrorAt" = ${next}
      WHERE id = ${id}`;
    const reason = err instanceof Error ? err.message : String(err);
    await recordEvent({
      storeId: ctx.store.id,
      sessionId: ctx.sessionId,
      level: delay != null ? "warn" : "error",
      kind: delay != null ? "refund.mirror_failed" : "refund.mirror_gave_up",
      message:
        delay != null
          ? `Remboursement non reporté sur ${ctx.orderName ?? ctx.what} pour l'instant (${reason}) : nouvel essai dans ${delay} min.`
          : `Remboursement toujours absent de ${ctx.orderName ?? ctx.what} après ${attempts} essais (${reason}) : reportez-le à la main dans Shopify.`,
      alert: attempts === 1 || delay == null,
      err,
    });
    return 0;
  }
}

/** Background retry for both kinds, due ones first. */
export async function retryRefundMirrors(deadline: number): Promise<number> {
  let n = 0;
  for (const target of ["session", "offer"] as const) {
    const t = TABLE[target];
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM ${t}
      WHERE "refundedCents" > 0 AND "shopifyOrderId" IS NOT NULL AND "refundedCents" > "refundMirroredCents"
        AND "refundMirrorAttempts" < ${MAX_MIRROR_ATTEMPTS}
        AND ("nextRefundMirrorAt" IS NULL OR "nextRefundMirrorAt" <= now())
      ORDER BY "nextRefundMirrorAt" ASC NULLS FIRST LIMIT 20`;
    for (const r of rows) {
      if (stopForTime(deadline)) return n;
      if ((await mirrorRefund(target, r.id)) > 0) n++;
    }
  }
  return n;
}
