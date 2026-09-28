import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { starvedJobs, TICK_STALE_MS, tickStatus } from "./tick";
import { MAX_MIRROR_ATTEMPTS } from "./refunds";
import { OUTBOX_MAX_ATTEMPTS } from "./log";
import { REPLAY_BACKOFF_MINUTES } from "./webhooks";
import { UPSELL_REPLAY_LIMIT_MS } from "./upsell";
import { TRACKING_WARN_AFTER } from "./disputes";
import { incidentCounts, incidentLines } from "./incidents";
import { fxHealth } from "./charge";
import { canReadShopifyDiscounts } from "./shopify-discounts";
import { googleConversionsHealth } from "./google-conversions";
import { stuckImportMessage, stuckImports } from "./shopify-history";

export type HealthItem = { key: string; label: string; ok: boolean | null; detail: string; href?: string };

const ago = (d: Date | string | null) => {
  if (!d) return "aucun pour l'instant";
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (min < 1) return "à l'instant";
  if (min < 60) return `il y a ${min} min`;
  const h = Math.round(min / 60);
  return h < 48 ? `il y a ${h} h` : `il y a ${Math.round(h / 24)} j`;
};

const MIN = 60_000;
/**
 * A retried item counts as stuck ("down") only once overdue for its own scheduled retry by more
 * than this (the tick runs every 5-10 min and a scheduler can run late); before that it is a
 * normal backoff ("degraded").
 */
export const OVERDUE_GRACE_MS = 20 * MIN;

export type Backlog = {
  /** Overdue for their scheduled retry (the automation isn't draining them). */
  offersUnsynced: number;
  /** Waiting for their next scheduled retry (normal backoff). */
  offersBackingOff: number;
  /** Merged offers whose Whop payment isn't recorded on the shared Shopify order yet. */
  offersUnpaidBalance: number;
  offersStuck: number;
  refundsUnmirrored: number;
  refundsBackingOff: number;
  webhooksUnprocessed: number;
  disputesNeedAction: number;
  reconcileStale: string[];
  reconcilePartial: string[];
  reviewHolds: number;
  alertsUndelivered: number;
  /** Past their last try: a human must retry or mark them handled. */
  alertsGaveUp: number;
  refundsGaveUp: number;
  /** Paid orders / offers whose Shopify order creation gave up (retry, or link an order made by hand). */
  syncGaveUp: number;
  offersGaveUp: number;
  /** Stores whose refund or dispute healing hasn't run for 6 h. */
  healingStale: string[];
  badSignatures1h: number;
  webhooksGaveUp: number;
  /** Disputed Shopify orders the "litige-whop" tag could not be added to (a human tags them). */
  disputeTagsGaveUp: number;
  /** Tracking numbers never pushed to Whop (a human adds them in Whop). */
  trackingGaveUp: number;
  /** Tracking pushes failing repeatedly, still retried (every 6 h). */
  trackingFailing: number;
  /** Approved reships whose 0 € replacement order failed or had an uncertain outcome (a human retries). */
  replacementsFailed: number;
};

/**
 * Money-path backlog (everything that should drain by itself): a non-zero value
 * that stays means a job is failing. Shared by the dashboard and /api/health.
 */
export async function backlog(storeId?: string): Promise<Backlog> {
  const sessionStore = storeId ? { storeId } : {};
  const offerStore = storeId ? { session: { storeId } } : {};
  const storeFilter = storeId ? Prisma.sql`AND s."storeId" = ${storeId}` : Prisma.empty;
  const offerFilter = storeId ? Prisma.sql`AND s."storeId" = ${storeId}` : Prisma.empty;
  const syncGaveUpWhere = { status: "PAID" as const, shopifyOrderId: null, reviewNote: null, syncHandledAt: null, syncAttempts: { gt: 0 }, nextSyncAt: null };
  const offerGaveUpWhere = { status: "PAID", shopifyOrderId: null, syncHandledAt: null, syncAttempts: { gt: 0 }, nextSyncAt: null };
  const grace = new Date(Date.now() - OVERDUE_GRACE_MS);
  const offerRetrying = { ...offerStore, status: "PAID", shopifyOrderId: null, syncHandledAt: null, createdAt: { lt: new Date(Date.now() - 30 * MIN) }, NOT: offerGaveUpWhere };
  const [offersUnsynced, offersBackingOff, offersUnpaidBalance, offersStuck, refunds, refundsBackingOffRows, webhooksUnprocessed, disputes, stores, reviewHolds, alertsUndelivered, badSignatures1h, webhooksGaveUp, refundsGaveUpRows, alertsGaveUp, syncGaveUp, offersGaveUp, tagsGaveUp, trackingGaveUp, trackingFailing, replacementsFailed] = await Promise.all([
    // Still retrying (gave-up and hand-linked ones are counted apart): overdue vs. backing off.
    db.upsellCharge.count({ where: { ...offerRetrying, OR: [{ nextSyncAt: null }, { nextSyncAt: { lt: grace } }] } }),
    db.upsellCharge.count({ where: { ...offerRetrying, nextSyncAt: { gte: grace } } }),
    db.upsellCharge.count({ where: { ...offerStore, orderMode: "merged", balanceSettledAt: null, createdAt: { lt: new Date(Date.now() - 10 * MIN) } } }),
    // Stuck = no answer from Whop past the replay window, or unconfirmed for a day
    // (a buyer still in 3-D Secure is normal for up to 24 h).
    db.upsellCharge.count({
      where: {
        ...offerStore,
        status: "PENDING",
        OR: [
          { whopPaymentId: null, chargeStartedAt: { lt: new Date(Date.now() - UPSELL_REPLAY_LIMIT_MS) } },
          { chargeStartedAt: { lt: new Date(Date.now() - 24 * 60 * MIN) } },
        ],
      },
    }),
    // Overdue for their next mirror (or never scheduled) vs. waiting for it (backoff).
    db.$queryRaw<{ n: bigint }[]>`
      SELECT (SELECT count(*) FROM "CheckoutSession" s WHERE s."refundedCents" > 0 AND s."shopifyOrderId" IS NOT NULL AND s."refundedCents" > s."refundMirroredCents" AND s."refundMirrorAttempts" < ${MAX_MIRROR_ATTEMPTS} AND COALESCE(s."lastRefundAt", s."updatedAt") < now() - interval '30 minutes' AND (s."nextRefundMirrorAt" IS NULL OR s."nextRefundMirrorAt" < ${grace}) ${storeFilter})
           + (SELECT count(*) FROM "UpsellCharge" c JOIN "CheckoutSession" s ON s.id = c."sessionId" WHERE c."refundedCents" > 0 AND c."shopifyOrderId" IS NOT NULL AND c."refundedCents" > c."refundMirroredCents" AND c."refundMirrorAttempts" < ${MAX_MIRROR_ATTEMPTS} AND (c."refundMirrorStartedAt" IS NULL OR c."refundMirrorStartedAt" < now() - interval '10 minutes') AND COALESCE(c."lastRefundAt", c."createdAt") < now() - interval '30 minutes' AND (c."nextRefundMirrorAt" IS NULL OR c."nextRefundMirrorAt" < ${grace}) ${offerFilter}) AS n`,
    db.$queryRaw<{ n: bigint }[]>`
      SELECT (SELECT count(*) FROM "CheckoutSession" s WHERE s."shopifyOrderId" IS NOT NULL AND s."refundedCents" > s."refundMirroredCents" AND s."refundMirrorAttempts" < ${MAX_MIRROR_ATTEMPTS} AND s."nextRefundMirrorAt" >= ${grace} ${storeFilter})
           + (SELECT count(*) FROM "UpsellCharge" c JOIN "CheckoutSession" s ON s.id = c."sessionId" WHERE c."shopifyOrderId" IS NOT NULL AND c."refundedCents" > c."refundMirroredCents" AND c."refundMirrorAttempts" < ${MAX_MIRROR_ATTEMPTS} AND c."nextRefundMirrorAt" >= ${grace} ${offerFilter}) AS n`,
    // Stuck = unprocessed and not waiting for a scheduled retry (or overdue for it).
    db.webhookEvent.count({
      where: {
        ...(storeId ? { storeId } : {}),
        processedAt: null,
        receivedAt: { lt: new Date(Date.now() - 10 * MIN) },
        attempts: { lte: REPLAY_BACKOFF_MINUTES.length },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lt: new Date(Date.now() - 30 * MIN) } }],
      },
    }),
    Promise.all([
      db.checkoutSession.count({
        where: {
          ...sessionStore,
          disputeId: { not: null },
          disputeEvidenceAt: null,
          AND: [{ OR: [{ disputeStatus: null }, { disputeStatus: { notIn: ["won", "lost", "closed"] } }] }],
          OR: [
            { disputeEvidenceTries: { gte: 3 } },
            { disputeDueAt: { lt: new Date(Date.now() + 24 * 60 * MIN) } },
            { store: { autoDisputeEvidence: false } },
            // No due date known and open for 2 days: its deadline may be near.
            { disputeDueAt: null, disputeOpenedAt: { lt: new Date(Date.now() - 2 * 24 * 60 * MIN) } },
          ],
        },
      }),
      db.upsellCharge.count({
        where: {
          ...offerStore,
          disputeId: { not: null },
          disputeEvidenceAt: null,
          AND: [{ OR: [{ disputeStatus: null }, { disputeStatus: { notIn: ["won", "lost", "closed"] } }] }],
          OR: [
            { disputeEvidenceTries: { gte: 3 } },
            { disputeDueAt: { lt: new Date(Date.now() + 24 * 60 * MIN) } },
            { session: { store: { autoDisputeEvidence: false } } },
            { disputeDueAt: null, disputeOpenedAt: { lt: new Date(Date.now() - 2 * 24 * 60 * MIN) } },
          ],
        },
      }),
    ]),
    db.store.findMany({
      where: { ...(storeId ? { id: storeId } : {}), whopConnectedAt: { not: null }, whopProductId: { not: null } },
      select: { id: true, name: true, whopConnectedAt: true },
    }),
    // Settled holds (refunded / lost before creation) aren't waiting for anyone.
    db.checkoutSession.count({ where: { ...sessionStore, status: "PAID", shopifyOrderId: null, syncHandledAt: null, reviewNote: { not: null } } }),
    db.alertOutbox.count({ where: { ...(storeId ? { storeId } : {}), sentAt: null, attempts: { lt: OUTBOX_MAX_ATTEMPTS }, createdAt: { lt: new Date(Date.now() - 10 * MIN) } } }),
    db.eventLog.count({ where: { ...(storeId ? { storeId } : {}), kind: "webhook.bad_signature", createdAt: { gt: new Date(Date.now() - 60 * MIN) } } }),
    db.webhookEvent.count({ where: { ...(storeId ? { storeId } : {}), processedAt: null, attempts: { gt: REPLAY_BACKOFF_MINUTES.length } } }),
    // Gave up (a human must look): refund mirrors and alerts past their last try.
    db.$queryRaw<{ n: bigint }[]>`
      SELECT (SELECT count(*) FROM "CheckoutSession" s WHERE s."refundedCents" > 0 AND s."shopifyOrderId" IS NOT NULL AND s."refundedCents" > s."refundMirroredCents" AND s."refundMirrorAttempts" >= ${MAX_MIRROR_ATTEMPTS} ${storeFilter})
           + (SELECT count(*) FROM "UpsellCharge" c JOIN "CheckoutSession" s ON s.id = c."sessionId" WHERE c."refundedCents" > 0 AND c."shopifyOrderId" IS NOT NULL AND c."refundedCents" > c."refundMirroredCents" AND c."refundMirrorAttempts" >= ${MAX_MIRROR_ATTEMPTS} ${offerFilter}) AS n`,
    db.alertOutbox.count({ where: { ...(storeId ? { storeId } : {}), sentAt: null, attempts: { gte: OUTBOX_MAX_ATTEMPTS } } }),
    db.checkoutSession.count({ where: { ...sessionStore, ...syncGaveUpWhere } }),
    db.upsellCharge.count({ where: { ...offerStore, ...offerGaveUpWhere } }),
    Promise.all([
      db.checkoutSession.count({ where: { ...sessionStore, disputeTaggedAt: null, disputeTagGaveUpAt: { not: null } } }),
      db.upsellCharge.count({ where: { ...offerStore, disputeTaggedAt: null, disputeTagGaveUpAt: { not: null } } }),
    ]),
    db.checkoutSession.count({ where: { ...sessionStore, trackingPushedAt: null, trackingGaveUpAt: { not: null } } }),
    db.checkoutSession.count({ where: { ...sessionStore, trackingPushedAt: null, trackingGaveUpAt: null, trackingPushAttempts: { gte: TRACKING_WARN_AFTER } } }),
    db.protectionClaim.count({ where: { ...(storeId ? { storeId } : {}), status: "approved", kind: "reship", replacementOrderId: null, replacementError: { not: null } } }),
  ]);
  const marks = await db.appSetting.findMany({
    where: { key: { in: stores.flatMap((st) => [`reconcile:${st.id}`, `reconcile-run:${st.id}`, `refund-mark:${st.id}`, `dispute-scan:${st.id}`]) } },
  });
  const byKey = new Map(marks.map((m) => [m.key, m]));
  // A mark untouched for 3 h while the scheduler runs means reconciliation keeps failing.
  const reconcileStale = stores
    .filter((st) => {
      const mark = byKey.get(`reconcile:${st.id}`);
      if (!process.env.CRON_SECRET) return false;
      // Never written at all 3 h after connecting counts as stale too (failing since day one).
      const since = mark ? mark.updatedAt : st.whopConnectedAt;
      return !!since && Date.now() - since.getTime() > 3 * 60 * MIN;
    })
    .map((st) => st.name);
  // Refund and dispute healing: their marks must move too (a revoked scope stops them silently).
  const healingStale = stores
    .filter((st) => {
      if (!process.env.CRON_SECRET || !st.whopConnectedAt || Date.now() - st.whopConnectedAt.getTime() < 6 * 60 * MIN) return false;
      return [`refund-mark:${st.id}`, `dispute-scan:${st.id}`].some((k) => {
        const m = byKey.get(k);
        return !m || Date.now() - m.updatedAt.getTime() > 6 * 60 * MIN;
      });
    })
    .map((st) => st.name);
  const reconcilePartial = stores
    .filter((st) => {
      const run = byKey.get(`reconcile-run:${st.id}`);
      return !!run && Date.now() - run.updatedAt.getTime() > 60 * MIN;
    })
    .map((st) => st.name);
  return {
    offersUnsynced,
    offersBackingOff,
    offersUnpaidBalance,
    offersStuck,
    refundsUnmirrored: Number(refunds[0]?.n ?? 0),
    refundsBackingOff: Number(refundsBackingOffRows[0]?.n ?? 0),
    webhooksUnprocessed,
    disputesNeedAction: disputes[0] + disputes[1],
    reconcileStale,
    reconcilePartial,
    reviewHolds,
    alertsUndelivered,
    alertsGaveUp,
    refundsGaveUp: Number(refundsGaveUpRows[0]?.n ?? 0),
    syncGaveUp,
    offersGaveUp,
    healingStale,
    badSignatures1h,
    webhooksGaveUp,
    disputeTagsGaveUp: tagsGaveUp[0] + tagsGaveUp[1],
    trackingGaveUp,
    trackingFailing,
    replacementsFailed,
  };
}

/** Live health checks shown on the overview and the Journal page. */
export async function storeHealth(storeId: string): Promise<HealthItem[]> {
  const base = `/dashboard/stores/${storeId}`;
  const [store, unsynced, oldestUnsynced, holds, lastPaid, tick, failedConversions, queue, offerModes] = await Promise.all([
    db.store.findUnique({ where: { id: storeId } }),
    // Hand-linked orders (syncHandledAt) exist in Shopify: not waiting for anything.
    db.checkoutSession.count({ where: { storeId, status: "PAID", shopifyOrderId: null, reviewNote: null, syncHandledAt: null } }),
    db.checkoutSession.findFirst({
      where: { storeId, status: "PAID", shopifyOrderId: null, reviewNote: null, syncHandledAt: null },
      orderBy: { paidAt: "asc" },
      select: { paidAt: true },
    }),
    db.checkoutSession.count({ where: { storeId, status: "PAID", shopifyOrderId: null, syncHandledAt: null, reviewNote: { not: null } } }),
    db.checkoutSession.findFirst({ where: { storeId, status: "PAID" }, orderBy: { paidAt: "desc" }, select: { paidAt: true } }),
    tickStatus(),
    db.eventLog.count({ where: { storeId, kind: "conversion.failed", createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } } }),
    backlog(storeId),
    // Merged into the checkout's order vs. their own order, last 30 days.
    db.upsellCharge.groupBy({
      by: ["orderMode"],
      where: { session: { storeId }, orderMode: { not: null }, createdAt: { gt: new Date(Date.now() - 30 * 24 * 60 * MIN) } },
      _count: { _all: true },
    }),
  ]);
  if (!store) return [];
  const [google, starved] = await Promise.all([googleConversionsHealth(store), starvedJobs().catch(() => [])]);
  const googleOk =
    !google.configured || (google.failed24h === 0 && google.incidents24h === 0 && google.uploadsAbandoned === 0 && google.adjustmentsAbandoned === 0 && google.uploadsOverdue === 0);
  // "Google : 3 en attente · 1 échec (24 h) · dernier envoi il y a 2 h" (+ what waits for the merchant)
  const googleLine = google.configured
    ? `Google Ads (conversions hors ligne) : ${google.pending} en attente · ${google.failed24h} échec(s) sur 24 h${google.incidents24h ? ` · ${google.incidents24h} erreur(s) de compte / connexion` : ""}${
        google.uploadsOverdue ? ` · ${google.uploadsOverdue} en attente depuis plus de 6 h` : ""
      }${google.uploadsAbandoned ? ` · ${google.uploadsAbandoned} abandonnée(s) (« Relancer les conversions abandonnées »)` : ""}${
        google.adjustmentsAbandoned ? ` · ${google.adjustmentsAbandoned} ajustement(s) abandonné(s)` : ""
      } · dernier envoi ${ago(google.lastSuccessAt)}`
    : null;
  const mergedN = offerModes.find((m) => m.orderMode === "merged")?._count._all ?? 0;
  const separateN = offerModes.find((m) => m.orderMode === "separate")?._count._all ?? 0;
  const mergeRatio = mergedN + separateN ? ` · 30 j : ${mergedN} ajoutée(s) à la commande d'origine, ${separateN} en commande séparée (${Math.round((100 * mergedN) / (mergedN + separateN))} % fusionnées)` : "";
  const tickAge = tick.at ? Date.now() - new Date(tick.at).getTime() : Infinity;
  // A live store without a recent tick has no safety net (missed webhooks, retries, refunds).
  const live = store.enabled && !!store.whopConnectedAt && !!store.shopifyConnectedAt;
  const tickStale = tickAge > TICK_STALE_MS;
  const tickFailed = tick.report ? Object.values(tick.report).some((v) => typeof v === "string" && v.startsWith("error")) : false;
  const tickSkipped = tick.report ? Object.entries(tick.report).filter(([, v]) => typeof v === "string" && v.startsWith("skipped")).map(([k]) => k) : [];
  const offerIssues = [
    queue.offersUnsynced + queue.offersBackingOff && `${queue.offersUnsynced + queue.offersBackingOff} offre(s) payée(s) sans commande Shopify`,
    queue.offersStuck && `${queue.offersStuck} offre(s) sans réponse de Whop`,
  ].filter(Boolean);
  const moneyIssues = [
    queue.refundsUnmirrored + queue.refundsBackingOff && `${queue.refundsUnmirrored + queue.refundsBackingOff} remboursement(s) pas encore reportés dans Shopify`,
    queue.webhooksUnprocessed && `${queue.webhooksUnprocessed} événement(s) Whop inachevé(s)`,
    queue.webhooksGaveUp && `${queue.webhooksGaveUp} événement(s) Whop abandonné(s) : à relancer ou traiter à la main`,
    queue.refundsGaveUp && `${queue.refundsGaveUp} remboursement(s) jamais reportés dans Shopify : à relancer ou reporter à la main`,
    queue.healingStale.length && "vérification des remboursements / litiges bloquée depuis plus de 6 h",
    queue.badSignatures1h && `${queue.badSignatures1h} webhook(s) refusé(s) (signature) cette dernière heure : reconnectez Whop si cela continue`,
    queue.reconcilePartial.length && "vérification des paiements en cours de rattrapage",
    queue.reconcileStale.length && "vérification des paiements bloquée depuis plus de 3 h",
  ].filter(Boolean);
  const items: HealthItem[] = [
    ...(store.fallbackActiveAt
      ? [
          {
            key: "fallback",
            label: "Checkout de secours",
            ok: false,
            detail: `Actif depuis ${ago(store.fallbackActiveAt)} : ${store.fallbackReason ?? "Whop indisponible"}. Retour automatique dès que Whop répond.`,
            href: `${base}/journal`,
          } satisfies HealthItem,
        ]
      : []),
    {
      key: "shopify",
      label: "Script Shopify",
      ok: store.shopifyConnectedAt ? !!store.scriptTagId : false,
      detail: !store.shopifyConnectedAt ? "Shopify non connecté" : store.scriptTagId ? "Installé sur la boutique" : "Non installé",
      href: `${base}/shopify`,
    },
    {
      key: "webhook",
      label: "Webhook Whop",
      ok: store.whopConnectedAt ? (lastPaid?.paidAt && store.lastWebhookAt ? store.lastWebhookAt >= lastPaid.paidAt : store.lastWebhookAt != null || !lastPaid) : false,
      detail: store.whopConnectedAt
        ? store.lastWebhookAt
          ? `Dernier événement reçu ${ago(store.lastWebhookAt)}`
          : "Aucun événement reçu pour l'instant"
        : "Whop non connecté",
      href: `${base}/whop`,
    },
    {
      key: "sync",
      label: "Commandes vers Shopify",
      ok: unsynced === 0,
      detail:
        unsynced === 0
          ? "Toutes synchronisées"
          : `${unsynced} en attente depuis ${ago(oldestUnsynced?.paidAt ?? null).replace("il y a ", "")} (nouvel essai automatique)`,
      href: `${base}/orders`,
    },
    {
      key: "review",
      label: "Paiements à vérifier",
      ok: holds === 0,
      detail: holds === 0 ? "Aucun" : `${holds} paiement(s) mis de côté`,
      href: `${base}/orders`,
    },
    {
      key: "offers",
      label: "Offres post-achat",
      ok: offerIssues.length === 0,
      detail: offerIssues.length ? `${offerIssues.join(" · ")} (nouvel essai automatique)` : "Toutes traitées",
      href: `${base}/orders`,
    },
    {
      key: "offer_merge",
      label: "Offres ajoutées aux commandes",
      ok: queue.offersUnpaidBalance ? false : store.mergeOffersIntoOrder || mergedN ? true : null,
      detail: queue.offersUnpaidBalance
        ? `${queue.offersUnpaidBalance} offre(s) ajoutée(s) à la commande d'origine dont le paiement Whop n'est pas enregistré dans Shopify (solde « à payer ») : nouvel essai automatique, sinon marquez le montant payé dans Shopify${mergeRatio}`
        : store.mergeOffersIntoOrder
          ? `Activé (fenêtre de ${store.offerMergeWindowMin} min après la commande)${mergeRatio || " · aucune offre pour l'instant"}`
          : `Désactivé : chaque offre a sa propre commande Shopify${mergeRatio}`,
      href: queue.offersUnpaidBalance ? `${base}/orders` : `${base}/shopify`,
    },
    {
      key: "money",
      label: "Remboursements et paiements",
      ok: moneyIssues.length === 0,
      detail: moneyIssues.length ? moneyIssues.join(" · ") : "Tout est à jour",
      href: `${base}/journal`,
    },
    {
      key: "disputes",
      label: "Litiges",
      ok: queue.disputesNeedAction === 0 && queue.disputeTagsGaveUp === 0,
      detail:
        queue.disputesNeedAction === 0 && queue.disputeTagsGaveUp === 0
          ? "Aucun litige à traiter à la main"
          : [
              queue.disputesNeedAction && `${queue.disputesNeedAction} litige(s) à traiter dans Whop (échéance proche ou envoi automatique impossible)`,
              queue.disputeTagsGaveUp && `${queue.disputeTagsGaveUp} commande(s) en litige sans le tag « litige-whop » : à ajouter à la main dans Shopify`,
            ]
              .filter(Boolean)
              .join(" · "),
      href: queue.disputeTagsGaveUp ? `${base}/journal` : `${base}/orders`,
    },
    {
      key: "tracking",
      label: "Suivi vers Whop",
      ok: store.pushTracking ? queue.trackingGaveUp === 0 && queue.trackingFailing === 0 : null,
      detail: !store.pushTracking
        ? "Envoi du suivi désactivé"
        : queue.trackingGaveUp
          ? `${queue.trackingGaveUp} numéro(s) de suivi jamais transmis à Whop : à ajouter à la main dans Whop${queue.trackingFailing ? ` · ${queue.trackingFailing} en échec répété (nouvel essai automatique)` : ""}`
          : queue.trackingFailing
            ? `${queue.trackingFailing} envoi(s) de suivi en échec répété (nouvel essai automatique toutes les 6 h)`
            : "Numéros de suivi transmis automatiquement",
      href: `${base}/journal`,
    },
    {
      key: "tick",
      label: "Maintenance automatique",
      ok: tick.at ? !tickStale && !tickFailed && tickSkipped.length === 0 && starved.length === 0 : live ? false : null,
      detail: !tick.at
        ? live
          ? "Jamais exécutée alors que la boutique est en ligne : configurez CRON_SECRET et un planificateur toutes les 5 à 10 min (voir README)"
          : "Pas encore exécutée"
        : tickStale
          ? `Dernier passage ${ago(tick.at)} (plus de ${TICK_STALE_MS / 60_000} min) : vérifiez le planificateur (GitHub Actions « Background tick ») et CRON_SECRET${live ? " — paiements manqués, relances et remboursements ne sont plus rattrapés" : ""}`
        : tickFailed
          ? `Dernier passage ${ago(tick.at)} avec une erreur (voir le journal)`
        : starved.length
          ? `Dernier passage ${ago(tick.at)} : ${starved.map((j) => `« ${j.name} »`).join(", ")} reportée(s) faute de temps depuis plus de ${Math.floor(Math.max(...starved.map((j) => j.ageMs)) / 3600_000)} h`
          : tickSkipped.length
            ? `Dernier passage ${ago(tick.at)} : ${tickSkipped.length} tâche(s) reportée(s) faute de temps (rattrapées au prochain passage)`
          : `Dernier passage ${ago(tick.at)}`,
      href: `${base}/journal`,
    },
    {
      key: "pixels",
      label: "Pub & pixels",
      ok: store.metaPixelId || store.tiktokPixelId || google.configured ? failedConversions === 0 && googleOk : null,
      detail:
        [
          store.metaPixelId || store.tiktokPixelId
            ? failedConversions === 0
              ? [store.metaPixelId && "Meta", store.tiktokPixelId && "TikTok"].filter(Boolean).join(" + ") + " actifs"
              : `${failedConversions} envoi(s) en échec sur 24 h`
            : null,
          googleLine,
        ]
          .filter(Boolean)
          .join(" · ") || "Non configurés",
      href: `${base}/growth`,
    },
    {
      key: "alerts",
      label: "Alertes",
      ok: store.alertEmail || store.telegramChatId ? queue.alertsUndelivered === 0 && queue.alertsGaveUp === 0 : false,
      detail:
        !store.alertEmail && !store.telegramChatId
          ? "Aucun canal configuré : vous ne serez prévenu de rien"
          : queue.alertsGaveUp
            ? `${queue.alertsGaveUp} alerte(s) jamais délivrée(s) : vérifiez Telegram / e-mail, puis « Relancer » dans le Journal`
            : queue.alertsUndelivered
            ? `${queue.alertsUndelivered} alerte(s) non délivrée(s) : vérifiez Telegram / e-mail (nouvel essai automatique)`
            : [store.telegramChatId && "Telegram", store.alertEmail && "e-mail"].filter(Boolean).join(" + ") + " actifs",
      href: `${base}/settings`,
    },
  ];
  items.push(...(await degradationItems(store, base)));
  return items;
}

/**
 * Checkout features running degraded (round 11): Shopify codes without the read_discounts scope,
 * lookups / cart re-reads / sign-in e-mails failing, buyers charged in the shop currency for lack
 * of fresh ECB rates. Shown as tiles; the probe lists the same under "degraded".
 */
async function degradationItems(
  store: { id: string; shopifyConnectedAt: Date | null; shopifyScopes: string | null; shopifyDiscountCodes: boolean; chargeLocalCurrency: boolean },
  base: string,
): Promise<HealthItem[]> {
  const [counts, fx] = await Promise.all([incidentCounts(store.id), store.chargeLocalCurrency ? fxHealth() : null]);
  const items: HealthItem[] = [];
  if (store.shopifyConnectedAt && !canReadShopifyDiscounts(store)) {
    items.push({
      key: "discount_scope",
      label: "Codes promo Shopify",
      ok: store.shopifyDiscountCodes ? false : null,
      detail: store.shopifyDiscountCodes
        ? "Activés, mais l'autorisation « read_discounts » manque : les codes créés dans Shopify ne peuvent pas être vérifiés (l'acheteur voit « réessayez »). Reconnectez Shopify pour l'accorder."
        : "Autorisation « read_discounts » non accordée : seuls les codes de l'onglet Offres sont acceptés.",
      href: `${base}/shopify`,
    });
  }
  // Background imports failing for days: their own tile (analytics incomplete), with the reason.
  const stuck = store.shopifyConnectedAt || counts["import.background_failed"] ? await stuckImports(store.id) : [];
  if (stuck.length) {
    items.push({
      key: "imports",
      label: "Imports en arrière-plan",
      ok: false,
      detail: stuck.map((x) => stuckImportMessage(x.what, x.error, x.since)).join(" · "),
      href: `${base}/journal`,
    });
  }
  // Google Ads incidents are shown on the "Pub & pixels" tile, stuck imports on their own.
  const lines = incidentLines(counts, (k) => !k.startsWith("google.") && !k.startsWith("import."));
  const fxStale = !!fx && !fx.fresh;
  items.push({
    key: "degraded",
    label: "Remises, devises et e-mails",
    ok: lines.length || fxStale ? false : true,
    detail: [
      fxStale && `Taux BCE ${fx!.date ? `du ${fx!.date}` : "absents"} (plus de 3 jours) : paiement dans la devise de la boutique en attendant`,
      ...lines,
    ]
      .filter(Boolean)
      .join(" · ") || "Aucune dégradation sur 24 h",
    href: `${base}/journal`,
  });
  return items;
}

export type GaveUpItem = {
  kind: "sync" | "offer_sync" | "refund" | "offer_refund" | "alert" | "webhook" | "dispute_tag" | "offer_dispute_tag" | "tracking";
  id: string;
  label: string;
  detail: string;
  at: Date;
  href?: string;
};

/** Every item the automation gave up on, one row each, so the journal can act per item. */
export async function gaveUpItems(storeId: string, take = 20): Promise<GaveUpItem[]> {
  const orderHref = (sessionId: string) => `/dashboard/stores/${storeId}/orders/${sessionId}`;
  const [syncs, offerSyncs, refunds, offerRefunds, alerts, webhooks, tags, offerTags, tracking] = await Promise.all([
    db.checkoutSession.findMany({
      where: { storeId, status: "PAID", shopifyOrderId: null, reviewNote: null, syncHandledAt: null, syncAttempts: { gt: 0 }, nextSyncAt: null },
      select: { id: true, email: true, syncError: true, updatedAt: true },
      orderBy: { updatedAt: "desc" },
      take,
    }),
    db.upsellCharge.findMany({
      where: { session: { storeId }, status: "PAID", shopifyOrderId: null, syncHandledAt: null, syncAttempts: { gt: 0 }, nextSyncAt: null },
      select: { id: true, sessionId: true, createdAt: true, error: true },
      orderBy: { createdAt: "desc" },
      take,
    }),
    db.$queryRaw<{ id: string; email: string | null; refundedCents: number; refundMirroredCents: number; currency: string; updatedAt: Date }[]>`
      SELECT id, email, "refundedCents", "refundMirroredCents", currency, COALESCE("lastRefundAt", "updatedAt") AS "updatedAt" FROM "CheckoutSession"
      WHERE "storeId" = ${storeId} AND "refundedCents" > 0 AND "shopifyOrderId" IS NOT NULL AND "refundedCents" > "refundMirroredCents" AND "refundMirrorAttempts" >= ${MAX_MIRROR_ATTEMPTS}
      ORDER BY "updatedAt" DESC LIMIT ${take}`,
    db.$queryRaw<{ id: string; sessionId: string; refundedCents: number; refundMirroredCents: number; currency: string; updatedAt: Date }[]>`
      SELECT c.id, c."sessionId", c."refundedCents", c."refundMirroredCents", s.currency, COALESCE(c."lastRefundAt", c."createdAt") AS "updatedAt" FROM "UpsellCharge" c JOIN "CheckoutSession" s ON s.id = c."sessionId"
      WHERE s."storeId" = ${storeId} AND c."refundedCents" > 0 AND c."shopifyOrderId" IS NOT NULL AND c."refundedCents" > c."refundMirroredCents" AND c."refundMirrorAttempts" >= ${MAX_MIRROR_ATTEMPTS}
      ORDER BY c."createdAt" DESC LIMIT ${take}`,
    db.alertOutbox.findMany({ where: { storeId, sentAt: null, attempts: { gte: OUTBOX_MAX_ATTEMPTS } }, orderBy: { createdAt: "desc" }, take }),
    db.webhookEvent.findMany({
      where: { storeId, processedAt: null, attempts: { gt: REPLAY_BACKOFF_MINUTES.length } },
      select: { id: true, type: true, lastError: true, receivedAt: true },
      orderBy: { receivedAt: "desc" },
      take,
    }),
    db.checkoutSession.findMany({
      where: { storeId, disputeTaggedAt: null, disputeTagGaveUpAt: { not: null } },
      select: { id: true, shopifyOrderName: true, disputeTagGaveUpAt: true },
      orderBy: { disputeTagGaveUpAt: "desc" },
      take,
    }),
    db.upsellCharge.findMany({
      where: { session: { storeId }, disputeTaggedAt: null, disputeTagGaveUpAt: { not: null } },
      select: { id: true, sessionId: true, title: true, shopifyOrderName: true, disputeTagGaveUpAt: true },
      orderBy: { disputeTagGaveUpAt: "desc" },
      take,
    }),
    db.checkoutSession.findMany({
      where: { storeId, trackingPushedAt: null, trackingGaveUpAt: { not: null } },
      select: { id: true, shopifyOrderName: true, trackingPushError: true, trackingGaveUpAt: true },
      orderBy: { trackingGaveUpAt: "desc" },
      take,
    }),
  ]);
  const eur = (c: number, cur: string) => `${(c / 100).toFixed(2).replace(".", ",")} ${cur}`;
  const items: GaveUpItem[] = [
    ...syncs.map((s) => ({
      kind: "sync" as const,
      id: s.id,
      label: `Commande Shopify jamais créée${s.email ? ` · ${s.email}` : ""}`,
      detail: s.syncError ?? "Création abandonnée après plusieurs essais.",
      at: s.updatedAt,
      href: orderHref(s.id),
    })),
    ...offerSyncs.map((c) => ({
      kind: "offer_sync" as const,
      id: c.id,
      label: "Offre 1 clic payée, commande Shopify jamais créée",
      detail: c.error ?? "Création abandonnée après plusieurs essais.",
      at: c.createdAt,
      href: orderHref(c.sessionId),
    })),
    ...refunds.map((s) => ({
      kind: "refund" as const,
      id: s.id,
      label: `Remboursement non reporté dans Shopify${s.email ? ` · ${s.email}` : ""}`,
      detail: `${eur(s.refundedCents - s.refundMirroredCents, s.currency)} remboursé(s) via Whop, absent(s) de Shopify.`,
      at: s.updatedAt,
      href: orderHref(s.id),
    })),
    ...offerRefunds.map((c) => ({
      kind: "offer_refund" as const,
      id: c.id,
      label: "Remboursement d'offre 1 clic non reporté dans Shopify",
      detail: `${eur(c.refundedCents - c.refundMirroredCents, c.currency)} remboursé(s) via Whop, absent(s) de Shopify.`,
      at: c.updatedAt,
      href: orderHref(c.sessionId),
    })),
    ...alerts.map((a) => ({
      kind: "alert" as const,
      id: a.id,
      label: `Alerte jamais délivrée · ${a.kind}`,
      detail: `${a.message.slice(0, 140)}${a.lastError ? ` — ${a.lastError.slice(0, 120)}` : ""}`,
      at: a.createdAt,
      href: a.sessionId ? orderHref(a.sessionId) : undefined,
    })),
    ...webhooks.map((w) => ({
      kind: "webhook" as const,
      id: w.id,
      label: `Événement Whop non traité · ${w.type}`,
      detail: w.lastError?.slice(0, 200) ?? "Traitement abandonné après plusieurs essais.",
      at: w.receivedAt,
    })),
    ...tags.map((t) => ({
      kind: "dispute_tag" as const,
      id: t.id,
      label: `Tag « litige-whop » non ajouté${t.shopifyOrderName ? ` · ${t.shopifyOrderName}` : ""}`,
      detail: "Ajoutez le tag à la main dans Shopify (pour ne pas expédier ni rembourser deux fois), puis « Traité ».",
      at: t.disputeTagGaveUpAt!,
      href: orderHref(t.id),
    })),
    ...offerTags.map((t) => ({
      kind: "offer_dispute_tag" as const,
      id: t.id,
      label: `Tag « litige-whop » non ajouté sur l'offre « ${t.title} »${t.shopifyOrderName ? ` · ${t.shopifyOrderName}` : ""}`,
      detail: "Ajoutez le tag à la main dans Shopify, puis « Traité ».",
      at: t.disputeTagGaveUpAt!,
      href: orderHref(t.sessionId),
    })),
    ...tracking.map((t) => ({
      kind: "tracking" as const,
      id: t.id,
      label: `Suivi jamais transmis à Whop${t.shopifyOrderName ? ` · ${t.shopifyOrderName}` : ""}`,
      detail: `${t.trackingPushError?.slice(0, 160) ?? "Envoi abandonné après plusieurs essais."} Ajoutez le suivi dans Whop, puis « Traité ».`,
      at: t.trackingGaveUpAt!,
      href: orderHref(t.id),
    })),
  ];
  return items.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, take);
}
