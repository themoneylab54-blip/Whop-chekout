import type { SessionStatus } from "@prisma/client";
import { Badge } from "@/components/ui";

export function StatusBadge({ status, disputed }: { status: SessionStatus; disputed: boolean }) {
  if (disputed) return <Badge color="red">Litige</Badge>;
  const map: Record<SessionStatus, [string, "green" | "amber" | "red" | "zinc" | "blue"]> = {
    PAID: ["Payé", "green"],
    PAYING: ["Paiement en cours", "blue"],
    OPEN: ["Checkout ouvert", "zinc"],
    FAILED: ["Échoué", "red"],
    ABANDONED: ["Abandonné", "zinc"],
  };
  const [label, color] = map[status];
  return <Badge color={color}>{label}</Badge>;
}

export function SyncBadge({ s }: { s: { status: SessionStatus; shopifyOrderName: string | null; reviewNote: string | null; syncError: string | null } }) {
  if (s.status !== "PAID")
    return (
      <span className="text-zinc-500" title="Pas de commande Shopify tant que le paiement n'est pas reçu">
        <span aria-hidden>—</span>
        <span className="sr-only">Pas de commande Shopify (non payé)</span>
      </span>
    );
  if (s.shopifyOrderName) return <span className="font-medium">{s.shopifyOrderName}</span>;
  if (s.reviewNote) return <Badge color="amber">À vérifier</Badge>;
  return <Badge color={s.syncError ? "red" : "blue"}>{s.syncError ? "Échec — nouvel essai auto" : "Création en cours"}</Badge>;
}
