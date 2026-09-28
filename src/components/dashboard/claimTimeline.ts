import { REASON_LABELS, type BuyerReason } from "@/lib/claims";

/**
 * Order-page wording of the delivery-protection journal events. The journal message is written
 * for the store-wide log ("… sur la commande #1001 — à accepter ou refuser sur la fiche
 * commande"); on the order's own timeline it only says what happened.
 */
export function claimTimelineLabel(kind: string, message: string, data: unknown): string | null {
  if (!kind.startsWith("protection.")) return null;
  const d = (data && typeof data === "object" ? data : {}) as { reason?: string };
  if (kind === "protection.claim_reported") {
    const reason = d.reason && d.reason in REASON_LABELS ? REASON_LABELS[d.reason as BuyerReason] : null;
    const quote = /— (« .* ») — à accepter/.exec(message)?.[1];
    return `Le client signale un problème de livraison${reason ? ` : ${reason}` : ""}${quote ? ` — ${quote}` : ""}.`;
  }
  if (kind === "protection.claim_rejected") return "Signalement du client refusé (non compté en sinistre).";
  if (kind === "protection.claim_approved") return message.replace(/^Signalement accepté/, "Signalement du client accepté");
  if (kind === "protection.claim_deleted") return "Sinistre supprimé (retiré de la rentabilité).";
  return null;
}
