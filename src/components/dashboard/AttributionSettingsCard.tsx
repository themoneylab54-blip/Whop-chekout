import type { Store } from "@prisma/client";
import { MousePointerClick } from "lucide-react";
import { Card, Label, Toggle } from "@/components/ui";
import { saveAttributionAction } from "@/app/dashboard/stores/[storeId]/(main)/analytics/actions";
import { DirtyForm } from "./DirtyForm";

export const ATTRIBUTION_DAYS = [1, 7, 28] as const;

/**
 * Settings › "Attribution & coûts fournisseur": paid-ad attribution window (1 / 7 / 28 days) and
 * whether the supplier is paid at payment (dropshipping: a refunded, never-shipped order keeps
 * its product cost in Analytics).
 */
export function AttributionSettingsCard({ store }: { store: Pick<Store, "id" | "attributionDays" | "supplierPaidAtPayment"> }) {
  return (
    <div id="attribution" className="scroll-mt-36 lg:scroll-mt-8">
      <Card
        icon={MousePointerClick}
        iconColor="#f97316"
        title="Attribution pub & coûts fournisseur"
        description="Comment Analytics rattache une vente à une pub, et ce que coûte une commande remboursée avant expédition."
      >
        <DirtyForm label="Attribution" action={saveAttributionAction.bind(null, store.id)} className="space-y-4">
          <div>
            <Label
              htmlFor="attributionDays"
              hint="Un achat est attribué au dernier clic sur une pub (UTM, fbclid, gclid, ttclid) s'il a eu lieu dans cette fenêtre ; au-delà, il est « direct / inconnu ». 7 jours = la fenêtre par défaut de Meta."
            >
              Fenêtre d&apos;attribution (dernier clic pub)
            </Label>
            <select
              id="attributionDays"
              name="attributionDays"
              defaultValue={String(store.attributionDays)}
              className="min-h-10 w-full max-w-xs rounded-xl border border-zinc-200 bg-white px-3 text-sm shadow-[0_1px_1px_rgba(16,24,40,.04)]"
            >
              {ATTRIBUTION_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 1 ? "1 jour" : `${d} jours`}
                </option>
              ))}
            </select>
          </div>
          <div className="border-t border-zinc-100">
            <Toggle
              name="supplierPaidAtPayment"
              defaultChecked={store.supplierPaidAtPayment}
              label="Fournisseur payé dès le paiement (dropshipping)"
              hint="Activez si vous passez la commande fournisseur au moment du paiement : une commande remboursée avant expédition garde alors son coût produit (l'argent versé au fournisseur est perdu). Désactivé : une commande entièrement remboursée et jamais expédiée ne coûte rien (stock récupéré)."
            />
          </div>
        </DirtyForm>
      </Card>
    </div>
  );
}
