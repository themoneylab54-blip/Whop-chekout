import type { Store } from "@prisma/client";
import { Receipt } from "lucide-react";
import { Card, Label } from "@/components/ui";
import { saveCostsAction } from "@/app/dashboard/stores/[storeId]/(main)/analytics/actions";
import { DirtyForm } from "./DirtyForm";
import { MoneyInput } from "./MoneyInput";
import { centsToField } from "./money";

/** Settings › "Coûts": monthly fixed costs and the bank fee per dispute (Analytics P&L). */
export function CostsSettingsCard({ store }: { store: Pick<Store, "id" | "shopCurrency" | "fixedCostsMonthlyCents" | "disputeFeeCents"> }) {
  return (
    <div id="couts" className="scroll-mt-36 lg:scroll-mt-8">
      <Card
        icon={Receipt}
        iconColor="#0ea5e9"
        title="Coûts"
        description="Frais fixes et frais de litige : déduits dans Analytics pour afficher votre résultat net réel."
      >
        <DirtyForm label="Coûts" action={saveCostsAction.bind(null, store.id)} className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="fixedCostsMonthly" hint="Abonnements (Shopify, applis, outils), salaires, loyer… Répartis au prorata des jours de la période.">
              Frais fixes par mois
            </Label>
            <MoneyInput id="fixedCostsMonthly" name="fixedCostsMonthly" currency={store.shopCurrency} placeholder="0,00" defaultValue={centsToField(store.fixedCostsMonthlyCents)} />
          </div>
          <div>
            <Label htmlFor="disputeFee" hint="Facturés par la banque à chaque litige (chargeback), gagné ou perdu. 15 € par défaut.">
              Frais par litige
            </Label>
            <MoneyInput id="disputeFee" name="disputeFee" currency={store.shopCurrency} placeholder="15,00" defaultValue={centsToField(store.disputeFeeCents)} />
          </div>
        </DirtyForm>
      </Card>
    </div>
  );
}
