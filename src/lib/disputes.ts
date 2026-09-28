import "server-only";
import type { CheckoutSession, Store } from "@prisma/client";
import { db } from "./db";
import { loadTheme } from "./layout";
import { log, recordEvent } from "./log";
import type { CartLine } from "./pricing";
import { orderTracking, type Address } from "./shopify";
import { refundPayment, storeClient } from "./whop";

/*
 * Dispute shield: everything that keeps chargebacks (and the Whop account) under control.
 * - tracking numbers from Shopify fulfillments are pushed to Whop (proof of delivery)
 * - when a dispute opens, evidence is filled and submitted automatically
 * - early fraud warnings can trigger an automatic refund before they become disputes
 */

type SessionWithStore = CheckoutSession & { store: Store };

/** Pushes the first tracking number of the Shopify order to the Whop payment. */
export async function pushTracking(session: SessionWithStore): Promise<boolean> {
  if (!session.shopifyOrderId || !session.whopPaymentId) return false;
  await db.checkoutSession.update({ where: { id: session.id }, data: { trackingCheckedAt: new Date() } });
  const tracking = await orderTracking(session.store, session.shopifyOrderId);
  const first = tracking[0];
  if (!first) return false;
  await storeClient(session.store).shipments.create({
    account_id: session.store.whopAccountId ?? undefined,
    payment_id: session.whopPaymentId,
    tracking_number: first.number,
  });
  await db.checkoutSession.update({
    where: { id: session.id },
    data: { trackingNumber: first.number, trackingPushedAt: new Date() },
  });
  await recordEvent({
    storeId: session.storeId,
    sessionId: session.id,
    kind: "tracking.pushed",
    message: `Suivi ${first.number}${first.company ? ` (${first.company})` : ""} transmis à Whop pour ${session.shopifyOrderName ?? "la commande"}`,
  });
  return true;
}

/** Text evidence built from what the checkout knows: order, delivery, consent, policies. */
export function buildEvidence(session: CheckoutSession, tracking: { number: string; company: string | null; url: string | null }[], policyUrls: string[]) {
  const a = session.shippingAddress as Address | null;
  const lines = session.lines as unknown as CartLine[];
  const money = (c: number) => `${(c / 100).toFixed(2)} ${session.currency}`;
  const notes = [
    `Commande ${session.shopifyOrderName ?? session.id} payée le ${session.paidAt?.toISOString().slice(0, 10) ?? "?"} pour ${money(session.totalCents)}.`,
    tracking.length
      ? `Expédiée : ${tracking.map((t) => `${t.company ?? "transporteur"} ${t.number}${t.url ? ` (${t.url})` : ""}`).join(", ")}.`
      : "Numéro de suivi non encore disponible.",
    session.termsAcceptedAt ? `Le client a accepté les CGV le ${session.termsAcceptedAt.toISOString()}.` : null,
    session.clientIp ? `Adresse IP lors de la commande : ${session.clientIp}.` : null,
    a ? `Adresse de livraison : ${[a.address1, a.address2, `${a.zip} ${a.city}`, a.countryCode].filter(Boolean).join(", ")}.` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    customer_email_address: session.email,
    customer_name: a ? `${a.firstName} ${a.lastName}`.trim() : null,
    billing_address: a ? [a.address1, a.address2, a.zip, a.city, a.countryCode].filter(Boolean).join(", ") : null,
    product_description: lines.map((l) => `${l.quantity} × ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`).join("; ").slice(0, 1000),
    service_date: (session.paidAt ?? session.createdAt).toISOString().slice(0, 10),
    refund_policy_disclosure: policyUrls.length
      ? `Politiques affichées au moment du paiement : ${policyUrls.join(" · ")}`
      : "Politique de retour de 14 jours affichée sur la boutique.",
    notes: notes.slice(0, 2000),
  };
}

/** Fills and submits the dispute's evidence in Whop. Never throws. */
export async function submitDisputeEvidence(session: SessionWithStore, disputeId: string) {
  try {
    const tracking = session.shopifyOrderId ? await orderTracking(session.store, session.shopifyOrderId).catch(() => []) : [];
    const theme = loadTheme(session.store.theme, session.store.name);
    const evidence = buildEvidence(session, tracking, theme.policyLinks.map((p) => p.url));
    const client = storeClient(session.store);
    await client.disputes.update({ id: disputeId, evidence });
    await client.disputes.submit({ id: disputeId });
    await db.checkoutSession.update({ where: { id: session.id }, data: { disputeEvidenceAt: new Date() } });
    await recordEvent({
      storeId: session.storeId,
      sessionId: session.id,
      kind: "dispute.evidence_submitted",
      message: `Preuves envoyées automatiquement pour le litige ${disputeId}${tracking.length ? " (avec suivi)" : ""}`,
    });
  } catch (err) {
    await recordEvent({
      storeId: session.storeId,
      sessionId: session.id,
      level: "warn",
      kind: "dispute.evidence_failed",
      message: `Envoi automatique des preuves impossible (${err instanceof Error ? err.message : String(err)}) : répondez au litige dans Whop.`,
      alert: true,
    });
  }
}

/**
 * Early fraud warning from the card network: refunding now avoids a chargeback
 * (fee + dispute ratio). Only when the merchant opted in.
 */
export async function handleDisputeAlert(storeId: string, alert: { id?: string; payment_id?: string | null; type?: string; amount?: number }) {
  const session = alert.payment_id
    ? await db.checkoutSession.findUnique({ where: { whopPaymentId: alert.payment_id }, include: { store: true } })
    : null;
  if (!session || session.storeId !== storeId) return;
  const kind = alert.type === "early_fraud_warning" ? "alerte de fraude" : "alerte de litige";
  if (session.store.autoRefundFraudAlerts && session.refundedCents < session.totalCents && session.whopPaymentId) {
    try {
      await refundPayment(session.store, session.whopPaymentId);
      await recordEvent({
        storeId,
        sessionId: session.id,
        level: "warn",
        kind: "dispute_alert.refunded",
        message: `${kind} reçue sur ${session.shopifyOrderName ?? "une commande"} : remboursée automatiquement pour éviter un litige.`,
        alert: true,
      });
      return;
    } catch (err) {
      log.error("dispute_alert.refund_failed", "Automatic refund failed", { sessionId: session.id, err });
    }
  }
  await recordEvent({
    storeId,
    sessionId: session.id,
    level: "warn",
    kind: "dispute_alert.created",
    message: `${kind} reçue sur ${session.shopifyOrderName ?? "une commande"} (${session.totalCents / 100} ${session.currency}) : un remboursement rapide évite souvent un litige.`,
    alert: true,
  });
}
