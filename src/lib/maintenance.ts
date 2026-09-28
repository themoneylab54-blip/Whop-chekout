import "server-only";
import { db } from "./db";
import { SYNC_LEASE_MS } from "./checkout";
import { OUTBOX_MAX_ATTEMPTS } from "./log";
import { MAX_MIRROR_ATTEMPTS, REFUND_MIRROR_LEASE_MS } from "./refunds";
import { GAVE_UP_ATTEMPTS } from "./webhooks";

/*
 * Manual recovery of what the automation gave up on (Journal page): "Relancer" puts an
 * item back into its retry schedule, "Traité" records that the merchant handled it by
 * hand. Only items that actually gave up are touched, and a live lease (an order being
 * created, a refund being mirrored right now) is never released: the run holding it may
 * still succeed, and releasing it could create a duplicate order or refund.
 */

export const GAVE_UP_KINDS = ["sync", "offer_sync", "refund", "offer_refund", "alert", "webhook", "dispute_tag", "offer_dispute_tag", "tracking"] as const;
export type GaveUpKind = (typeof GAVE_UP_KINDS)[number];

const staleSync = () => new Date(Date.now() - SYNC_LEASE_MS);
const staleMirror = () => new Date(Date.now() - REFUND_MIRROR_LEASE_MS);

/** Every gave-up item of a store back into its retry schedule. Returns how many. */
export async function retryGaveUp(storeId: string): Promise<number> {
  // Shopify order creation that gave up: back into the retry schedule (lookup first, so no
  // duplicate; the ambiguity wait after a timeout still applies in the claim).
  const syncWhere = { storeId, status: "PAID" as const, shopifyOrderId: null, reviewNote: null, syncHandledAt: null, syncAttempts: { gt: 0 }, nextSyncAt: null };
  const offerSyncWhere = { session: { storeId }, status: "PAID", shopifyOrderId: null, syncHandledAt: null, syncAttempts: { gt: 0 }, nextSyncAt: null };
  await Promise.all([
    db.checkoutSession.updateMany({ where: { ...syncWhere, syncStartedAt: { lt: staleSync() } }, data: { syncStartedAt: null } }),
    db.upsellCharge.updateMany({ where: { ...offerSyncWhere, syncStartedAt: { lt: staleSync() } }, data: { syncStartedAt: null } }),
  ]);
  const [syncs, offerSyncs] = await Promise.all([
    db.checkoutSession.updateMany({ where: syncWhere, data: { syncAttempts: 0, nextSyncAt: new Date() } }),
    db.upsellCharge.updateMany({ where: offerSyncWhere, data: { syncAttempts: 0, nextSyncAt: new Date() } }),
  ]);
  // Refund mirrors that gave up only (one still in its backoff keeps its schedule).
  const mirrorWhere = { refundMirrorAttempts: { gte: MAX_MIRROR_ATTEMPTS }, shopifyOrderId: { not: null } };
  await Promise.all([
    db.checkoutSession.updateMany({ where: { storeId, ...mirrorWhere, refundMirrorStartedAt: { lt: staleMirror() } }, data: { refundMirrorStartedAt: null } }),
    db.upsellCharge.updateMany({ where: { session: { storeId }, ...mirrorWhere, refundMirrorStartedAt: { lt: staleMirror() } }, data: { refundMirrorStartedAt: null } }),
  ]);
  // Dispute tags and tracking pushes that gave up: a fresh budget, due now.
  const [tags, offerTags, tracking] = await Promise.all([
    db.checkoutSession.updateMany({ where: { storeId, disputeTaggedAt: null, disputeTagGaveUpAt: { not: null } }, data: { disputeTagGaveUpAt: null, disputeTagAttempts: 0, nextDisputeTagAt: null } }),
    db.upsellCharge.updateMany({ where: { session: { storeId }, disputeTaggedAt: null, disputeTagGaveUpAt: { not: null } }, data: { disputeTagGaveUpAt: null, disputeTagAttempts: 0, nextDisputeTagAt: null } }),
    db.checkoutSession.updateMany({ where: { storeId, trackingPushedAt: null, trackingGaveUpAt: { not: null } }, data: { trackingGaveUpAt: null, trackingPushAttempts: 0, trackingCheckedAt: null } }),
  ]);
  const [sessions, offers, alerts, events] = await Promise.all([
    db.checkoutSession.updateMany({ where: { storeId, ...mirrorWhere }, data: { refundMirrorAttempts: 0, nextRefundMirrorAt: null } }),
    db.upsellCharge.updateMany({ where: { session: { storeId }, ...mirrorWhere }, data: { refundMirrorAttempts: 0, nextRefundMirrorAt: null } }),
    // Only alerts that gave up (a leased one in flight must not be sent twice).
    db.alertOutbox.updateMany({ where: { storeId, sentAt: null, attempts: { gte: OUTBOX_MAX_ATTEMPTS } }, data: { attempts: 0, nextAttemptAt: new Date(0) } }),
    // Whop events that gave up: a fresh budget (and a fresh 72 h window).
    db.webhookEvent.updateMany({
      where: { storeId, processedAt: null, attempts: { gte: GAVE_UP_ATTEMPTS } },
      data: { attempts: 0, deliveries: 0, nextAttemptAt: null, firstReceivedAt: new Date() },
    }),
  ]);
  return syncs.count + offerSyncs.count + sessions.count + offers.count + alerts.count + events.count + tags.count + offerTags.count + tracking.count;
}

/** The merchant handled every gave-up item by hand (refund reported in Shopify, event checked in Whop). */
export async function markGaveUpHandled(storeId: string): Promise<number> {
  const [tags, offerTags, tracking] = await Promise.all([
    db.checkoutSession.updateMany({ where: { storeId, disputeTaggedAt: null, disputeTagGaveUpAt: { not: null } }, data: { disputeTaggedAt: new Date() } }),
    db.upsellCharge.updateMany({ where: { session: { storeId }, disputeTaggedAt: null, disputeTagGaveUpAt: { not: null } }, data: { disputeTaggedAt: new Date() } }),
    // Added in Whop by hand: counted as pushed (no tracking number known here).
    db.checkoutSession.updateMany({ where: { storeId, trackingPushedAt: null, trackingGaveUpAt: { not: null } }, data: { trackingPushedAt: new Date() } }),
  ]);
  const [sessions, offers, alerts, events] = await Promise.all([
    db.$executeRaw`UPDATE "CheckoutSession" SET "refundMirroredCents" = "refundedCents", "refundMirrorAttempts" = 0 WHERE "storeId" = ${storeId} AND "refundMirrorAttempts" >= ${MAX_MIRROR_ATTEMPTS}`,
    db.$executeRaw`UPDATE "UpsellCharge" c SET "refundMirroredCents" = c."refundedCents", "refundMirrorAttempts" = 0 FROM "CheckoutSession" s WHERE s.id = c."sessionId" AND s."storeId" = ${storeId} AND c."refundMirrorAttempts" >= ${MAX_MIRROR_ATTEMPTS}`,
    db.alertOutbox.updateMany({ where: { storeId, sentAt: null, attempts: { gte: OUTBOX_MAX_ATTEMPTS } }, data: { sentAt: new Date(), lastError: "marquée comme traitée" } }),
    db.webhookEvent.updateMany({
      where: { storeId, processedAt: null, attempts: { gte: GAVE_UP_ATTEMPTS } },
      data: { processedAt: new Date(), lastError: "marqué comme traité à la main" },
    }),
  ]);
  return sessions + offers + alerts.count + events.count + tags.count + offerTags.count + tracking.count;
}

/**
 * One gave-up item: retry it (`handled` false) or mark it handled by hand. Returns how
 * many rows changed (0: already retried/handled, or not a gave-up item of this store).
 * A missing Shopify order is "handled" by linking the hand-made order (linkOrderByHand).
 */
export async function gaveUpItem(storeId: string, kind: GaveUpKind, id: string, handled: boolean): Promise<number> {
  const owned = { session: { storeId } };
  if (kind === "sync") {
    if (handled) return 0;
    const where = { id, storeId, status: "PAID" as const, shopifyOrderId: null, syncHandledAt: null, syncAttempts: { gt: 0 }, nextSyncAt: null };
    await db.checkoutSession.updateMany({ where: { ...where, syncStartedAt: { lt: staleSync() } }, data: { syncStartedAt: null } });
    return (await db.checkoutSession.updateMany({ where, data: { syncAttempts: 0, nextSyncAt: new Date() } })).count;
  }
  if (kind === "offer_sync") {
    const where = { id, ...owned, status: "PAID", shopifyOrderId: null, syncHandledAt: null, syncAttempts: { gt: 0 }, nextSyncAt: null };
    if (handled) return (await db.upsellCharge.updateMany({ where, data: { syncHandledAt: new Date(), error: null } })).count;
    await db.upsellCharge.updateMany({ where: { ...where, syncStartedAt: { lt: staleSync() } }, data: { syncStartedAt: null } });
    return (await db.upsellCharge.updateMany({ where, data: { syncAttempts: 0, nextSyncAt: new Date() } })).count;
  }
  if (kind === "refund") {
    if (handled)
      return db.$executeRaw`UPDATE "CheckoutSession" SET "refundMirroredCents" = "refundedCents", "refundMirrorAttempts" = 0 WHERE id = ${id} AND "storeId" = ${storeId} AND "refundMirrorAttempts" >= ${MAX_MIRROR_ATTEMPTS}`;
    const where = { id, storeId, refundMirrorAttempts: { gte: MAX_MIRROR_ATTEMPTS } };
    await db.checkoutSession.updateMany({ where: { ...where, refundMirrorStartedAt: { lt: staleMirror() } }, data: { refundMirrorStartedAt: null } });
    return (await db.checkoutSession.updateMany({ where, data: { refundMirrorAttempts: 0, nextRefundMirrorAt: null } })).count;
  }
  if (kind === "offer_refund") {
    if (handled)
      return db.$executeRaw`UPDATE "UpsellCharge" c SET "refundMirroredCents" = c."refundedCents", "refundMirrorAttempts" = 0 FROM "CheckoutSession" s WHERE c.id = ${id} AND s.id = c."sessionId" AND s."storeId" = ${storeId} AND c."refundMirrorAttempts" >= ${MAX_MIRROR_ATTEMPTS}`;
    const where = { id, ...owned, refundMirrorAttempts: { gte: MAX_MIRROR_ATTEMPTS } };
    await db.upsellCharge.updateMany({ where: { ...where, refundMirrorStartedAt: { lt: staleMirror() } }, data: { refundMirrorStartedAt: null } });
    return (await db.upsellCharge.updateMany({ where, data: { refundMirrorAttempts: 0, nextRefundMirrorAt: null } })).count;
  }
  if (kind === "dispute_tag" || kind === "offer_dispute_tag") {
    const where = { id, disputeTaggedAt: null, disputeTagGaveUpAt: { not: null } };
    const data = handled ? { disputeTaggedAt: new Date() } : { disputeTagGaveUpAt: null, disputeTagAttempts: 0, nextDisputeTagAt: null };
    return kind === "dispute_tag"
      ? (await db.checkoutSession.updateMany({ where: { ...where, storeId }, data })).count
      : (await db.upsellCharge.updateMany({ where: { ...where, ...owned }, data })).count;
  }
  if (kind === "tracking") {
    return (
      await db.checkoutSession.updateMany({
        where: { id, storeId, trackingPushedAt: null, trackingGaveUpAt: { not: null } },
        data: handled ? { trackingPushedAt: new Date() } : { trackingGaveUpAt: null, trackingPushAttempts: 0, trackingCheckedAt: null },
      })
    ).count;
  }
  if (kind === "alert") {
    return (
      await db.alertOutbox.updateMany({
        where: { id, storeId, sentAt: null, attempts: { gte: OUTBOX_MAX_ATTEMPTS } },
        data: handled ? { sentAt: new Date(), lastError: "marquée comme traitée" } : { attempts: 0, nextAttemptAt: new Date(0) },
      })
    ).count;
  }
  return (
    await db.webhookEvent.updateMany({
      where: { id, storeId, processedAt: null, attempts: { gte: GAVE_UP_ATTEMPTS } },
      data: handled
        ? { processedAt: new Date(), lastError: "marqué comme traité à la main" }
        : { attempts: 0, deliveries: 0, nextAttemptAt: null, firstReceivedAt: new Date() },
    })
  ).count;
}

/**
 * The merchant created the Shopify order by hand: link it so nothing ever creates another
 * one. Refused while an automatic creation holds its lease (it may be creating the order
 * right now: the merchant would end up with two).
 */
export async function linkOrderByHand(
  storeId: string,
  sessionId: string,
  orderName: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "already_linked" | "in_progress" }> {
  const s = await db.checkoutSession.findFirst({ where: { id: sessionId, storeId }, select: { status: true, shopifyOrderId: true, syncHandledAt: true, syncStartedAt: true } });
  if (!s || s.status !== "PAID") return { ok: false, reason: "not_found" };
  if (s.shopifyOrderId || s.syncHandledAt) return { ok: false, reason: "already_linked" };
  if (s.syncStartedAt && s.syncStartedAt > staleSync()) return { ok: false, reason: "in_progress" };
  const name = orderName.startsWith("#") ? orderName : `#${orderName}`;
  const done = await db.checkoutSession.updateMany({
    where: { id: sessionId, storeId, status: "PAID", shopifyOrderId: null, syncHandledAt: null, OR: [{ syncStartedAt: null }, { syncStartedAt: { lt: staleSync() } }] },
    data: { syncHandledAt: new Date(), shopifyOrderName: name, syncError: null, nextSyncAt: null },
  });
  return done.count ? { ok: true } : { ok: false, reason: "in_progress" };
}
