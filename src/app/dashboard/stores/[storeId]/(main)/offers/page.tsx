import { PackagePlus, Percent, Plus, Ticket, Trash2 } from "lucide-react";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/pricing";
import { Badge, Card, Flash, Input, Label, PageHeader, Select, SubmitButton } from "@/components/ui";
import {
  createAddOnAction,
  createDiscountAction,
  deleteAddOnAction,
  deleteDiscountAction,
  toggleAddOnAction,
  toggleDiscountAction,
} from "../../../../actions";

export default async function OffersPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { storeId } = await params;
  const sp = await searchParams;
  const store = await db.store.findUnique({
    where: { id: storeId },
    include: { discounts: { orderBy: { createdAt: "desc" } }, addOns: { orderBy: { position: "asc" } } },
  });
  if (!store) notFound();
  const money = (c: number) => formatMoney(c, store.shopCurrency);

  return (
    <>
      <PageHeader icon={Percent} iconColor="#ec4899" title="Promos & options" description="Codes promo et options à ajouter en un clic au checkout pour augmenter le panier moyen." />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <Card icon={Ticket} iconColor="#ec4899" title="Codes promo">
            {store.discounts.length === 0 ? (
              <p className="text-sm text-zinc-500">Aucun code. Le champ « Code promo » n&apos;apparaît au checkout que s&apos;il existe au moins un code actif.</p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {store.discounts.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-3">
                    <span>
                      <span className="font-mono text-sm font-semibold">{d.code}</span>{" "}
                      {!d.active && <Badge>Inactif</Badge>}
                      <span className="block text-xs text-zinc-500">
                        {d.type === "PERCENT" ? `−${d.value} %` : d.type === "FIXED" ? `−${money(d.value)}` : "Livraison offerte"}
                        {d.minSubtotalCents != null && ` · dès ${money(d.minSubtotalCents)}`}
                        {d.endsAt && ` · jusqu'au ${d.endsAt.toLocaleDateString("fr-FR")}`}
                        {` · ${d.usageCount}${d.usageLimit ? `/${d.usageLimit}` : ""} utilisation(s)`}
                      </span>
                    </span>
                    <span className="flex gap-1.5">
                      <form action={toggleDiscountAction.bind(null, store.id, d.id)}>
                        <SubmitButton variant="secondary" size="sm">
                          {d.active ? "Désactiver" : "Activer"}
                        </SubmitButton>
                      </form>
                      <form action={deleteDiscountAction.bind(null, store.id, d.id)}>
                        <SubmitButton variant="danger" size="sm" aria-label="Supprimer">
                          <Trash2 className="h-3.5 w-3.5" />
                        </SubmitButton>
                      </form>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card icon={Plus} title="Nouveau code promo">
            <form action={createDiscountAction.bind(null, store.id)} className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label>Code</Label>
                <Input name="code" placeholder="BIENVENUE10" required className="font-mono uppercase" />
              </div>
              <div>
                <Label>Type</Label>
                <Select name="type" defaultValue="PERCENT">
                  <option value="PERCENT">Pourcentage</option>
                  <option value="FIXED">Montant fixe</option>
                  <option value="FREE_SHIPPING">Livraison offerte</option>
                </Select>
              </div>
              <div>
                <Label hint="% ou montant, ignoré pour la livraison offerte">Valeur</Label>
                <Input name="value" inputMode="decimal" defaultValue="10" />
              </div>
              <div>
                <Label hint="Facultatif">Minimum d&apos;achat</Label>
                <Input name="minSubtotal" inputMode="decimal" />
              </div>
              <div>
                <Label hint="Facultatif">Expire le</Label>
                <Input name="endsAt" type="date" />
              </div>
              <div>
                <Label hint="Facultatif">Utilisations max.</Label>
                <Input name="usageLimit" type="number" min={1} />
              </div>
              <div className="sm:col-span-2">
                <SubmitButton>Créer le code</SubmitButton>
              </div>
            </form>
          </Card>
        </div>

        <div className="space-y-6">
          <Card icon={PackagePlus} iconColor="#8b5cf6" title="Options au checkout (order bumps)" description="Affichées par le bloc « Options » du builder, une case à cocher chacune.">
            {store.addOns.length === 0 ? (
              <p className="text-sm text-zinc-500">Aucune option. Exemples : emballage cadeau, livraison prioritaire, garantie étendue, 2ᵉ produit à prix réduit.</p>
            ) : (
              <ul className="divide-y divide-zinc-100">
                {store.addOns.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-3 py-3">
                    <span className="min-w-0">
                      <span className="text-sm font-medium">{a.title}</span> {!a.active && <Badge>Inactif</Badge>}
                      <span className="block truncate text-xs text-zinc-500">
                        +{money(a.priceCents)}
                        {a.variantId ? " · produit Shopify" : " · frais (sans produit)"}
                        {a.description && ` · ${a.description}`}
                      </span>
                    </span>
                    <span className="flex gap-1.5">
                      <form action={toggleAddOnAction.bind(null, store.id, a.id)}>
                        <SubmitButton variant="secondary" size="sm">
                          {a.active ? "Désactiver" : "Activer"}
                        </SubmitButton>
                      </form>
                      <form action={deleteAddOnAction.bind(null, store.id, a.id)}>
                        <SubmitButton variant="danger" size="sm" aria-label="Supprimer">
                          <Trash2 className="h-3.5 w-3.5" />
                        </SubmitButton>
                      </form>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card icon={Plus} title="Nouvelle option">
            <form action={createAddOnAction.bind(null, store.id)} className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Label>Titre</Label>
                <Input name="title" placeholder="Livraison prioritaire" required />
              </div>
              <div className="sm:col-span-2">
                <Label hint="Facultatif">Description</Label>
                <Input name="description" placeholder="Expédiée en premier, sous 24 h" />
              </div>
              <div>
                <Label>Prix</Label>
                <Input name="price" inputMode="decimal" placeholder="2,99" required />
              </div>
              <div>
                <Label hint="Facultatif : ajoute ce produit à la commande Shopify">ID de variante Shopify</Label>
                <Input name="variantId" placeholder="44556677889900" className="font-mono" />
              </div>
              <div className="sm:col-span-2">
                <Label hint="Facultatif">Image (URL)</Label>
                <Input name="imageUrl" type="url" placeholder="https://…" />
              </div>
              <div className="sm:col-span-2">
                <SubmitButton>Ajouter l&apos;option</SubmitButton>
              </div>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
