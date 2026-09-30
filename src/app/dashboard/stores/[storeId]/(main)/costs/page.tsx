import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Calculator, Coins, FileUp, History, PackageSearch, Percent, RefreshCw, Trash2 } from "lucide-react";
import { requireStoreAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { SINCE_ALWAYS, variantCostOverview, variantNumber, type CostSource, type VariantCost } from "@/lib/costs";
import { tzOf, zonedDay } from "@/lib/time";
import { Badge, Card, EmptyState, Flash, Label, PageHeader, Select, SubmitButton, Textarea } from "@/components/ui";
import { STANDARD_VAT_RATES, VAT_CATEGORIES, type VatCategory } from "@/lib/vat";
import { MoneyInput } from "@/components/dashboard/MoneyInput";
import { countryName } from "@/components/dashboard/countries";
import { DirtySubmit } from "@/components/dashboard/DirtyForm";
import { centsToField } from "@/components/dashboard/money";
import { formatCents } from "@/components/dashboard/format";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { saveCostAction, deleteCostAction, importCostsCsvAction, recomputeCostsAction, saveVatCategoryAction } from "./actions";

export const metadata: Metadata = { title: "Coûts produits" };

const WINDOW_DAYS = 90;

const SOURCE: Record<CostSource, { label: string; color: "green" | "blue" | "red"; title: string }> = {
  app: { label: "Saisi", color: "blue", title: "Coût saisi ici : il remplace celui de Shopify (nouvelles commandes et commandes passées à partir de sa date d'effet)" },
  shopify: { label: "Shopify", color: "green", title: "Coût par article renseigné dans Shopify, repris à chaque commande tant qu'aucun coût n'est saisi ici" },
  missing: { label: "Manquant", color: "red", title: "Aucun coût : la marge de ce produit est surestimée" },
};

export default async function CostsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; show?: string }>;
}) {
  const { storeId } = await params;
  await requireStoreAccess(storeId, "view");
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId }, select: { id: true, shopCurrency: true, supplierPaidAtPayment: true, timezone: true, vatExempt: true, vatDomesticOnly: true } });
  if (!store) notFound();
  const [rows, vatRows] = await Promise.all([variantCostOverview(storeId, WINDOW_DAYS), db.productVat.findMany({ where: { storeId }, select: { variantId: true, category: true } })]);
  const vatOf = new Map(vatRows.map((r) => [r.variantId, r.category]));
  const reduced = vatRows.filter((r) => r.category !== "standard").length;
  const onlyMissing = sp.show === "manquants";
  const shown = onlyMissing ? rows.filter((r) => r.source === "missing" || r.missingLines > 0) : rows;
  const count = (s: CostSource) => rows.filter((r) => r.source === s).length;
  const missingLines = rows.reduce((t, r) => t + r.missingLines, 0);
  const fixable = rows.filter((r) => r.missingLines > 0 && r.source === "app").length;
  const money = (c: number) => formatCents(c, store.shopCurrency);
  const base = `/dashboard/stores/${storeId}/costs`;
  // Days in the store's time zone (Paris by default).
  const tz = tzOf(store);
  const today = zonedDay(new Date(), tz);

  return (
    <>
      <PageHeader
        icon={Coins}
        iconColor="#0ea5e9"
        title="Coûts produits"
        description="Le coût d'achat de chaque variante vendue : sans lui, marges et ROAS de rentabilité sont surestimés. Un coût saisi ici prime sur celui de Shopify et s'applique dès l'enregistrement aux nouvelles commandes comme aux commandes passées."
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label={`Variantes vendues (${WINDOW_DAYS} j)`} value={rows.filter((r) => r.orders > 0).length} />
        <Stat label="Coût Shopify" value={count("shopify")} tone="green" />
        <Stat label="Coût saisi ici" value={count("app")} tone="blue" />
        <Stat label="Coût manquant" value={count("missing")} tone={count("missing") ? "red" : undefined} hint={missingLines ? `${missingLines} ligne(s) de commande sans coût` : "toutes les lignes ont un coût"} />
      </div>

      <div className="mb-6 grid grid-cols-[minmax(0,1fr)] items-start gap-6 lg:grid-cols-[1.4fr_1fr] [&>*]:min-w-0">
        <Card
          icon={RefreshCw}
          iconColor="#059669"
          title="Recalculer les coûts"
          description="Fait automatiquement à chaque enregistrement ou import, et chaque heure pour les commandes récentes. Applique le coût saisi ici en vigueur à la date du paiement aux lignes, offres post-achat et options déjà payées : il complète les coûts manquants et remplace ceux de Shopify (qui reviennent si vous supprimez le coût saisi)."
        >
          <form action={recomputeCostsAction.bind(null, storeId)} className="flex flex-wrap items-center gap-3">
            <SubmitButton>
              <RefreshCw className="h-4 w-4" aria-hidden /> Recalculer maintenant
            </SubmitButton>
            <span className="text-xs text-zinc-500">
              {missingLines
                ? `${missingLines} ligne(s) sans coût sur ${WINDOW_DAYS} j${fixable ? `, dont des variantes déjà saisies (${fixable}) : à recalculer` : ""}.`
                : "Aucune ligne sans coût sur la période."}
            </span>
          </form>
          <p className="mt-3 text-xs text-zinc-500">
            {store.supplierPaidAtPayment
              ? "Fournisseur payé dès le paiement : une commande remboursée avant expédition garde son coût produit."
              : "Une commande entièrement remboursée et jamais expédiée ne compte aucun coût produit."}{" "}
            <Link href={`/dashboard/stores/${storeId}/settings#attribution`} className="text-indigo-700 underline">
              Changer
            </Link>
          </p>
        </Card>

        <Card id="import" icon={FileUp} iconColor="#6366f1" title="Importer un CSV" description="Une ligne par variante : variant_id;coût (ex. 44012345678901;12,50).">
          <form action={importCostsCsvAction.bind(null, storeId)} className="space-y-3">
            <div>
              <Label htmlFor="costs-csv">Lignes « variant_id;coût »</Label>
              <Textarea id="costs-csv" name="csv" rows={4} placeholder={"variant_id;coût\n44012345678901;12,50\n44012345678902;8,90"} className="font-mono text-xs" />
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs font-medium text-zinc-700">
                ou un fichier .csv
                <input type="file" name="file" accept=".csv,text/csv,text/plain" className="mt-1 block w-full max-w-[16rem] text-xs file:mr-2 file:rounded-md file:border-0 file:bg-zinc-100 file:px-2 file:py-1.5" />
              </label>
              <label className="text-xs font-medium text-zinc-700">
                En vigueur à partir du
                <input type="date" lang="fr" name="effectiveFrom" max={today} className="mt-1 block rounded-lg border border-zinc-200 px-2 py-1.5 text-sm" />
              </label>
            </div>
            <p className="text-[11px] text-zinc-500">Date vide : depuis toujours (s&apos;applique aussi aux anciennes commandes). Identifiant : celui de la variante Shopify (chiffres) ou son GID.</p>
            <SubmitButton variant="secondary">Importer</SubmitButton>
          </form>
        </Card>
      </div>

      <VatCard reduced={reduced} vatExempt={store.vatExempt} domesticOnly={store.vatDomesticOnly} storeId={storeId} />

      <Card
        icon={PackageSearch}
        iconColor="#0ea5e9"
        title={`Variantes vendues sur ${WINDOW_DAYS} jours`}
        description="Coût actuel et sa source. Modifiez un coût directement dans la ligne ; une date d'effet crée un nouveau coût à partir de ce jour (les commandes plus anciennes gardent l'ancien)."
        actions={
          <span className="inline-flex rounded-lg bg-zinc-100 p-0.5 text-xs">
            <Link href={base} aria-current={!onlyMissing ? "true" : undefined} className={`rounded-md px-2.5 py-1.5 ${!onlyMissing ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-600"}`}>
              Toutes ({rows.length})
            </Link>
            <Link
              href={`${base}?show=manquants`}
              aria-current={onlyMissing ? "true" : undefined}
              className={`rounded-md px-2.5 py-1.5 ${onlyMissing ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-600"}`}
            >
              À compléter ({rows.filter((r) => r.source === "missing" || r.missingLines > 0).length})
            </Link>
          </span>
        }
      >
        {shown.length === 0 ? (
          <EmptyState icon={Calculator} title={onlyMissing ? "Rien à compléter" : `Aucune vente sur ${WINDOW_DAYS} jours`}>
            {onlyMissing ? "Toutes les variantes vendues ont un coût." : "Les variantes apparaîtront ici dès les premières commandes."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-zinc-100" aria-label="Coûts par variante">
            <li className="hidden grid-cols-[minmax(0,1fr)_6rem_7rem_minmax(0,22rem)] gap-4 pb-2 text-xs font-medium text-zinc-500 lg:grid" aria-hidden>
              <span>Variante</span>
              <span className="text-right">Vendus</span>
              <span className="text-right">Coût actuel</span>
              <span>Nouveau coût</span>
            </li>
            {shown.map((r) => (
              <VariantRow key={r.variantId} r={r} storeId={storeId} currency={store.shopCurrency} money={money} today={today} tz={tz} vat={vatOf.get(r.variantId) ?? "standard"} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: number; hint?: string; tone?: "green" | "blue" | "red" }) {
  const color = tone === "red" ? "text-rose-700" : tone === "green" ? "text-emerald-700" : tone === "blue" ? "text-indigo-700" : "text-zinc-900";
  return (
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${color}`}>{new Intl.NumberFormat("fr-FR").format(value)}</p>
      {hint && <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}

/** Reduced VAT rates: what the categories are and their rates per EU country (unknown → standard rate). */
function VatCard({ reduced, vatExempt, domesticOnly, storeId }: { reduced: number; vatExempt: boolean; domesticOnly: boolean; storeId: string }) {
  const cats = (Object.keys(VAT_CATEGORIES) as VatCategory[]).filter((k) => k !== "standard");
  const countries = [...new Set(cats.flatMap((k) => Object.keys(VAT_CATEGORIES[k].rates)))].sort((a, b) => (a === "FR" ? -1 : b === "FR" ? 1 : a.localeCompare(b)));
  const pctFr = (v: number) => `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(v)} %`;
  return (
    <Card
      id="tva"
      icon={Percent}
      iconColor="#8b5cf6"
      className="mb-6"
      title="TVA à taux réduit"
      description={
        vatExempt
          ? "Boutique en franchise de TVA : aucun taux n'est appliqué, la catégorie des variantes n'a pas d'effet."
          : `Alimentation, livres, presse… : choisissez la catégorie de TVA des variantes concernées dans la liste ci-dessous (« TVA »). Le CA HT de chaque commande retire alors la TVA ligne par ligne, livraison et options au prorata${reduced ? ` (${reduced} variante(s) à taux réduit)` : ""}.`
      }
    >
      <details className="text-xs text-zinc-600">
        <summary className="cursor-pointer font-medium text-indigo-700">Taux appliqués par pays de livraison</summary>
        <p className="mt-2">
          {domesticOnly
            ? "Ventes UE sous le seuil OSS (Paramètres) : le taux français de la catégorie s'applique à toute l'Union européenne."
            : "Au-delà du seuil OSS, le taux de la catégorie dans le pays de livraison. Pays absent du tableau : taux normal du pays (signalé dans Analytics comme taux inconnu)."}{" "}
          Hors UE : 0 % (exportation). Vérifiez les taux de vos produits auprès de votre comptable : ceux-ci sont les taux courants 2026 des catégories.
        </p>
        <div className="relative mt-2 overflow-x-auto" tabIndex={0} role="region" aria-label="Taux de TVA par catégorie et par pays">
          <table className="min-w-[36rem] text-left tabular-nums">
            <caption className="sr-only">Taux de TVA par catégorie et par pays de livraison</caption>
            <thead>
              <tr className="text-zinc-600">
                <th scope="col" className="py-1 pr-3 font-medium">Catégorie</th>
                {countries.map((c) => (
                  <th key={c} scope="col" className="px-1.5 py-1 font-medium">
                    {/* Compact code on screen, the full country name for screen readers. */}
                    <span aria-hidden="true">{c}</span>
                    <span className="sr-only">{countryName(c)}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-zinc-100">
                <th scope="row" className="py-1 pr-3 font-normal">
                  {VAT_CATEGORIES.standard.label}
                </th>
                {countries.map((c) => (
                  <td key={c} className="px-1.5 py-1">
                    {STANDARD_VAT_RATES[c] != null ? pctFr(STANDARD_VAT_RATES[c]) : "—"}
                  </td>
                ))}
              </tr>
              {cats.map((k) => (
                <tr key={k} className="border-t border-zinc-100">
                  <th scope="row" className="py-1 pr-3 font-normal">
                    {VAT_CATEGORIES[k].label}
                  </th>
                  {countries.map((c) => {
                    const v = (VAT_CATEGORIES[k].rates as Record<string, number>)[c];
                    return (
                      <td key={c} className={`px-1.5 py-1 ${v == null ? "text-zinc-600 italic" : ""}`}>
                        {v == null ? (
                          <>
                            normal<span aria-hidden="true">*</span>
                            <span className="sr-only"> (taux réduit inconnu : taux normal du pays appliqué)</span>
                          </>
                        ) : (
                          pctFr(v)
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-zinc-600">
          <span aria-hidden="true">* </span>
          <em>normal</em> : aucun taux réduit connu pour cette catégorie dans ce pays, le taux normal du pays s&apos;applique (première ligne du tableau) et
          Analytics le signale comme taux inconnu.
        </p>
        <p className="mt-2">
          Les commandes passées sont recalculées à l&apos;affichage : rien à relancer.{" "}
          <a href={`/dashboard/stores/${storeId}/analytics`} className="text-indigo-700 underline">
            Voir Analytics
          </a>
        </p>
      </details>
    </Card>
  );
}

function VariantRow({ r, storeId, currency, money, today, tz, vat }: { r: VariantCost; storeId: string; currency: string; money: (c: number) => string; today: string; tz: string; vat: string }) {
  const src = SOURCE[r.source];
  const fieldId = `cost-${variantNumber(r.variantId)}`;
  const dateLabel = (d: Date) => (d.getTime() === SINCE_ALWAYS.getTime() ? "depuis toujours" : `à partir du ${d.toLocaleDateString("fr-FR", { timeZone: tz })}`);
  return (
    <li id={`v-${encodeURIComponent(r.variantId)}`} className="grid grid-cols-[minmax(0,1fr)] scroll-mt-24 gap-3 py-3 lg:grid-cols-[minmax(0,1fr)_6rem_7rem_minmax(0,22rem)] lg:items-center lg:gap-4">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-zinc-900" title={r.title}>
          {r.title}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
          <span title={src.title}>
            <Badge color={src.color}>{src.label}</Badge>
          </span>
          <span className="font-mono">#{variantNumber(r.variantId)}</span>
          {r.missingLines > 0 && <span className="text-rose-700">{r.missingLines} ligne(s) sans coût</span>}
          {r.source === "app" && r.shopifyCents != null && <span>Shopify : {money(r.shopifyCents)}</span>}
        </p>
      </div>
      <p className="text-sm text-zinc-600 tabular-nums lg:text-right">
        <span className="lg:hidden">Vendus : </span>
        <span className="whitespace-nowrap">{r.units} u.</span> · <span className="whitespace-nowrap">{r.orders} cmd</span>
      </p>
      <p className="text-sm font-semibold tabular-nums lg:text-right">
        <span className="font-normal text-zinc-600 lg:hidden">Coût actuel : </span>
        {r.currentCents == null ? <span className="text-rose-700">—</span> : money(r.currentCents)}
      </p>
      <div className="min-w-0">
        <form action={saveCostAction.bind(null, storeId)} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="variantId" value={r.variantId} />
          <input type="hidden" name="title" value={r.title} />
          <div className="w-28">
            <label htmlFor={fieldId} className="sr-only">
              Nouveau coût unitaire de {r.title}
              {r.currentCents != null ? ` (actuel : ${money(r.currentCents)})` : ""}
            </label>
            {/* Empty field, the current cost as a hint: typing a value is always a new cost. */}
            <MoneyInput id={fieldId} name="cost" currency={currency} required placeholder={centsToField(r.currentCents) || "0,00"} />
          </div>
          <label className="text-[11px] text-zinc-500">
            <span className="sr-only">Date d&apos;effet pour {r.title} (vide : depuis toujours)</span>
            <input type="date" lang="fr" name="effectiveFrom" max={today} title="Date d'effet (vide : depuis toujours)" className="block rounded-lg border border-zinc-200 px-2 py-2 text-sm text-zinc-700" />
          </label>
          <DirtySubmit />
        </form>
        <form action={saveVatCategoryAction.bind(null, storeId)} className="mt-1.5 flex flex-wrap items-center gap-2">
          <input type="hidden" name="variantId" value={r.variantId} />
          <input type="hidden" name="title" value={r.title} />
          <label htmlFor={`vat-${variantNumber(r.variantId)}`} className="text-[11px] text-zinc-500">
            TVA<span className="sr-only"> de {r.title}</span>
          </label>
          <Select id={`vat-${variantNumber(r.variantId)}`} name="vatCategory" defaultValue={vat} className="!w-auto max-w-[16rem] !py-1 text-xs">
            {(Object.keys(VAT_CATEGORIES) as VatCategory[]).map((k) => (
              <option key={k} value={k}>
                {VAT_CATEGORIES[k].label}
              </option>
            ))}
          </Select>
          <DirtySubmit />
        </form>
        {r.history.length > 0 && (
          <details className="mt-1.5 text-xs">
            <summary className="inline-flex cursor-pointer items-center gap-1 text-zinc-500 hover:text-zinc-800">
              <History className="h-3.5 w-3.5" aria-hidden /> Historique ({r.history.length})
            </summary>
            <ul className="mt-1.5 space-y-1">
              {r.history.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-2 rounded-lg bg-zinc-50 px-2 py-1">
                  <span>
                    <span className="font-medium tabular-nums">{money(h.costCents)}</span> {dateLabel(h.effectiveFrom)}
                  </span>
                  <form action={deleteCostAction.bind(null, storeId, h.id)}>
                    <ConfirmButton
                      title="Supprimer ce coût ?"
                      description={`${money(h.costCents)}, ${dateLabel(h.effectiveFrom)}. Recalculez ensuite pour mettre à jour les commandes complétées avec ce coût.`}
                      variant="ghost"
                      size="sm"
                      aria-label={`Supprimer le coût ${money(h.costCents)} ${dateLabel(h.effectiveFrom)}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </ConfirmButton>
                  </form>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </li>
  );
}
