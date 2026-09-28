import { ChevronDown, Filter } from "lucide-react";
import { Label } from "@/components/ui";
import { MoneyInput } from "./MoneyInput";
import { centsToField } from "./money";
import { ProductMultiPicker } from "./ProductMultiPicker";
import { countryName } from "./countries";
import { RULE_COUNTRIES, hasRules, type ShowIf } from "./rules";

/**
 * « Conditions d'affichage » of an order bump (AddOn.showIf), in a disclosure that opens by
 * itself when rules exist: subtotal range, products in the cart, delivery countries.
 */
export function AddOnRulesFields({ prefix, storeId, currency, rules }: { prefix: string; storeId: string; currency: string; rules?: ShowIf }) {
  const id = (k: string) => `${prefix}-${k}`;
  const r = rules ?? {};
  const countries = new Set(r.countries ?? []);
  const extra = [...countries].filter((c) => !RULE_COUNTRIES.some(([code]) => code === c));
  const products = (r.productIds ?? []).map((pid) => ({ id: pid, title: r.productTitles?.[pid] ?? `Produit #${pid.split("/").pop()}` }));

  return (
    <details className="group/rules rounded-xl ring-1 ring-zinc-200 sm:col-span-2" open={hasRules(r)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-xl px-3 text-sm font-medium text-zinc-800 hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
        <Filter className="h-4 w-4 text-zinc-500" aria-hidden />
        <span className="flex-1">Conditions d&apos;affichage</span>
        <span className="text-xs font-normal text-zinc-500">{hasRules(r) ? "Actives" : "Toujours affichée"}</span>
        <ChevronDown className="h-4 w-4 text-zinc-500 transition group-open/rules:rotate-180" aria-hidden />
      </summary>
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 border-t border-zinc-200 p-3 sm:grid-cols-2">
        <p className="text-xs leading-relaxed text-zinc-500 sm:col-span-2">
          L&apos;option n&apos;apparaît au checkout que si toutes les conditions remplies ci-dessous sont vraies. Laissez vide pour l&apos;afficher à tout le monde.
        </p>
        <div>
          <Label htmlFor={id("ruleMin")} hint="Sous-total du panier, facultatif">
            Panier minimum
          </Label>
          <MoneyInput id={id("ruleMin")} name="ruleMinSubtotal" currency={currency} placeholder="ex. 40" defaultValue={centsToField(r.minSubtotalCents)} />
        </div>
        <div>
          <Label htmlFor={id("ruleMax")} hint="Facultatif">
            Panier maximum
          </Label>
          <MoneyInput id={id("ruleMax")} name="ruleMaxSubtotal" currency={currency} placeholder="ex. 150" defaultValue={centsToField(r.maxSubtotalCents)} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor={id("ruleProducts")} hint="Au moins un de ces produits (n'importe quelle variante). Vide = tous les paniers.">
            Seulement si le panier contient
          </Label>
          <ProductMultiPicker storeId={storeId} name="ruleProducts" inputId={id("ruleProducts")} initial={products} />
        </div>
        <fieldset className="sm:col-span-2">
          <legend className="mb-1.5 block text-[13px] font-medium text-zinc-800">
            Pays de livraison
            <span className="mt-0.5 block text-xs font-normal text-zinc-500">Aucun coché = tous les pays. Tant que le client n&apos;a pas saisi son adresse, l&apos;option est affichée.</span>
          </legend>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 sm:grid-cols-3">
            {RULE_COUNTRIES.map(([code, label]) => (
              <label key={code} htmlFor={id(`c-${code}`)} className="flex min-h-9 items-center gap-2 text-sm">
                <input id={id(`c-${code}`)} type="checkbox" name="ruleCountries" value={code} defaultChecked={countries.has(code)} className="h-4 w-4 accent-indigo-600" />
                <span>
                  {label} <span className="font-mono text-xs text-zinc-500">{code}</span>
                </span>
              </label>
            ))}
            {extra.map((code) => (
              <label key={code} htmlFor={id(`c-${code}`)} className="flex min-h-9 items-center gap-2 text-sm">
                <input id={id(`c-${code}`)} type="checkbox" name="ruleCountries" value={code} defaultChecked className="h-4 w-4 accent-indigo-600" />
                <span>
                  {countryName(code)} <span className="font-mono text-xs text-zinc-500">{code}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </details>
  );
}
