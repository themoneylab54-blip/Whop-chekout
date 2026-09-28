"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { parseCsvAmount } from "@/lib/adspend-csv";
import { createReplacementOrder, decideClaim, deleteClaim, recordClaim } from "@/lib/claims";
import { humanizeError } from "@/lib/humanize-error";
import { flashUrl, type FlashParams } from "@/lib/flash";

/* Order page › "Déclarer un sinistre" (shipping protection claims). */

const orderPath = (storeId: string, sessionId: string) => `/dashboard/stores/${storeId}/orders/${sessionId}`;

function back(storeId: string, sessionId: string, params: FlashParams): never {
  redirect(flashUrl(orderPath(storeId, sessionId), params, "#sinistres"));
}

/** A claim cost as typed: "12,50" → 1250; "12,505" (more than 2 decimals) → null, refused rather than rounded. */
function claimCost(fd: FormData): number | null {
  const raw = String(fd.get("cost") ?? "").replace(/[\s\u00a0€]/g, "");
  return /[.,]\d{3,}$/.test(raw) ? null : parseCsvAmount(raw);
}

/** Field of a claim validation message (shown inline next to it). */
function claimField(message: string): string | undefined {
  if (/^Coût invalide/.test(message)) return "cost";
  if (/^Type de sinistre/.test(message)) return "kind";
  return undefined;
}

export async function declareClaimAction(storeId: string, sessionId: string, fd: FormData) {
  await requireAdmin();
  try {
    await recordClaim(storeId, sessionId, {
      kind: String(fd.get("kind") ?? ""),
      costCents: claimCost(fd),
      note: String(fd.get("note") ?? ""),
    });
  } catch (err) {
    back(storeId, sessionId, { error: err instanceof Error ? err.message : "Sinistre non enregistré.", field: err instanceof Error ? claimField(err.message) : undefined });
  }
  revalidatePath(orderPath(storeId, sessionId));
  revalidatePath(`/dashboard/stores/${storeId}/analytics`);
  back(storeId, sessionId, { ok: "Sinistre enregistré : son coût est déduit de la marge de la commande et du résultat de la protection colis dans Analytics." });
}

export async function deleteClaimAction(storeId: string, sessionId: string, claimId: string) {
  await requireAdmin();
  const ok = await deleteClaim(storeId, sessionId, claimId);
  revalidatePath(orderPath(storeId, sessionId));
  revalidatePath(`/dashboard/stores/${storeId}/analytics`);
  back(storeId, sessionId, ok ? { ok: "Sinistre supprimé." } : { error: "Sinistre introuvable." });
}

/** Accept a buyer's delivery report: its solution and cost then count as a claim. */
export async function approveClaimAction(storeId: string, sessionId: string, claimId: string, fd: FormData) {
  await requireAdmin();
  let result: Awaited<ReturnType<typeof decideClaim>> | null = null;
  try {
    result = await decideClaim(storeId, sessionId, claimId, {
      approve: true,
      kind: String(fd.get("kind") ?? ""),
      costCents: claimCost(fd),
      note: String(fd.get("note") ?? "") || null,
      replacement: fd.get("replacement") === "on",
      // The items ticked for the replacement order (the list is only in the form when there are items).
      replacementKeys: fd.get("rlines") === "1" ? fd.getAll("rline").map(String) : null,
    });
  } catch (err) {
    back(storeId, sessionId, { error: err instanceof Error ? err.message : "Décision non enregistrée.", field: err instanceof Error ? claimField(err.message) : undefined });
  }
  revalidatePath(orderPath(storeId, sessionId));
  revalidatePath(`/dashboard/stores/${storeId}/analytics`);
  const r = result?.replacement;
  const replacement = !r ? "" : "error" in r ? ` Commande de remplacement non créée. ${humanizeError(r.error).text} Réessayez ci-dessous.` : ` Commande de remplacement ${r.name} créée dans Shopify (0 €).`;
  const mail = result?.emailed ? " Le client a été prévenu par e-mail." : " E-mail au client non envoyé (pas de compte Resend) : prévenez-le de la solution.";
  if (r && "error" in r) back(storeId, sessionId, { error: `Signalement accepté.${replacement}${mail}` });
  back(storeId, sessionId, { ok: `Signalement accepté : son coût est compté en sinistre.${replacement}${mail}` });
}

/** Retry of the 0 € replacement order of an approved reship. */
export async function createReplacementAction(storeId: string, sessionId: string, claimId: string) {
  await requireAdmin();
  let name = "";
  try {
    name = (await createReplacementOrder(storeId, claimId)).name;
  } catch (err) {
    back(storeId, sessionId, { error: err instanceof Error ? `Commande de remplacement non créée. ${humanizeError(err.message).text}` : "Commande de remplacement non créée." });
  }
  revalidatePath(orderPath(storeId, sessionId));
  back(storeId, sessionId, { ok: `Commande de remplacement ${name} créée dans Shopify (0 €).` });
}

/** Refuse a buyer's delivery report (nothing is counted). */
export async function rejectClaimAction(storeId: string, sessionId: string, claimId: string, fd: FormData) {
  await requireAdmin();
  try {
    const r = await decideClaim(storeId, sessionId, claimId, { approve: false, note: String(fd.get("note") ?? "") || null });
    revalidatePath(orderPath(storeId, sessionId));
    back(storeId, sessionId, { ok: r.emailed ? "Signalement refusé : le client a été prévenu par e-mail." : "Signalement refusé (e-mail au client non envoyé : pas de compte Resend)." });
  } catch (err) {
    if (err instanceof Error && /NEXT_REDIRECT/.test(err.message)) throw err;
    back(storeId, sessionId, { error: err instanceof Error ? err.message : "Décision non enregistrée." });
  }
}
