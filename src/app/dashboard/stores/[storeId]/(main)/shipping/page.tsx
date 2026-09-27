import { Pencil, Plus, Truck } from "lucide-react";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { centsToDecimal, formatMoney } from "@/lib/pricing";
import { Badge, Card, EmptyState, Flash, Input, Label, PageHeader, SubmitButton } from "@/components/ui";
import { deleteRateAction, saveRateAction } from "../../../../actions";

export default async function ShippingPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { storeId } = await params;
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId }, include: { shippingRates: { orderBy: { position: "asc" } } } });
  if (!store) notFound();
  const money = (c: number) => formatMoney(c, store.shopCurrency);

  return (
    <>
      <PageHeader
        icon={Truck}
        iconColor="#0ea5e9"
        title="Livraison"
        description="Les pays livrés et leurs tarifs. Le coût s'ajoute au montant encaissé par Whop et apparaît sur la commande Shopify."
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="space-y-4">
        {store.shippingRates.map((r) => (
          <Card key={r.id}>
            <details>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                <span>
                  <span className="font-medium">{r.name}</span>
                  {r.deliveryTime && <span className="ml-2 text-sm text-zinc-500">{r.deliveryTime}</span>}
                  <span className="mt-0.5 block text-xs text-zinc-500">
                    {r.countries.length ? r.countries.join(", ") : "Tous les pays"}
                    {r.freeOverCents != null && ` · offert dès ${money(r.freeOverCents)}`}
                  </span>
                </span>
                <span className="flex items-center gap-3">
                  {!r.active && <Badge>Inactif</Badge>}
                  <span className="font-semibold">{r.priceCents ? money(r.priceCents) : "Offert"}</span>
                  <span className="inline-flex items-center gap-1 text-sm text-zinc-400">
                    <Pencil className="h-3.5 w-3.5" /> Modifier
                  </span>
                </span>
              </summary>
              <div className="mt-4 border-t border-zinc-100 pt-4">
                <RateForm storeId={store.id} rate={r} />
                <form action={deleteRateAction.bind(null, store.id, r.id)} className="mt-3">
                  <SubmitButton variant="danger" size="sm">
                    Supprimer ce tarif
                  </SubmitButton>
                </form>
              </div>
            </details>
          </Card>
        ))}
        {store.shippingRates.length === 0 && (
          <div className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
            <EmptyState icon={Truck} title="Aucun tarif de livraison">
              Ajoutez-en au moins un : sans tarif, le checkout ne peut pas livrer les produits physiques.
            </EmptyState>
          </div>
        )}
        <Card icon={Plus} title="Ajouter un tarif">
          <RateForm storeId={store.id} />
        </Card>
      </div>
    </>
  );
}

function RateForm({
  storeId,
  rate,
}: {
  storeId: string;
  rate?: { id: string; name: string; deliveryTime: string | null; countries: string[]; priceCents: number; freeOverCents: number | null; active: boolean };
}) {
  return (
    <form action={saveRateAction.bind(null, storeId)} className="grid gap-4 sm:grid-cols-2">
      {rate && <input type="hidden" name="id" value={rate.id} />}
      <div>
        <Label>Nom</Label>
        <Input name="name" defaultValue={rate?.name ?? "Standard"} required />
      </div>
      <div>
        <Label>Délai affiché</Label>
        <Input name="deliveryTime" defaultValue={rate?.deliveryTime ?? "3 à 5 jours ouvrés"} />
      </div>
      <div>
        <Label>Prix</Label>
        <Input name="price" inputMode="decimal" defaultValue={rate ? centsToDecimal(rate.priceCents) : "0"} required />
      </div>
      <div>
        <Label hint="Laisser vide = jamais offert">Offert dès (sous-total)</Label>
        <Input name="freeOver" inputMode="decimal" defaultValue={rate?.freeOverCents != null ? centsToDecimal(rate.freeOverCents) : ""} />
      </div>
      <div className="sm:col-span-2">
        <Label hint="Codes pays ISO séparés par des virgules (FR, BE, CH…). Vide = tous les pays.">Pays</Label>
        <Input name="countries" defaultValue={rate?.countries.join(", ") ?? "FR"} className="font-mono" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={rate?.active ?? true} className="h-4 w-4" /> Actif
      </label>
      <div className="sm:col-span-2">
        <SubmitButton>{rate ? "Enregistrer" : "Ajouter le tarif"}</SubmitButton>
      </div>
    </form>
  );
}
