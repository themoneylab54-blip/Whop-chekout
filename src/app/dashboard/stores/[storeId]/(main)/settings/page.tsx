import { Settings, Store, Trash2 } from "lucide-react";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { Card, Flash, Input, Label, PageHeader, SubmitButton, Toggle } from "@/components/ui";
import { deleteStoreAction, saveSettingsAction } from "../../../../actions";

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { storeId } = await params;
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) notFound();

  return (
    <>
      <PageHeader icon={Settings} iconColor="#71717a" title="Réglages" />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="max-w-2xl space-y-6">
        <Card icon={Store} title="Boutique">
          <form action={saveSettingsAction.bind(null, store.id)} className="space-y-4">
            <div>
              <Label htmlFor="name">Nom interne</Label>
              <Input id="name" name="name" defaultValue={store.name} required />
            </div>
            <div className="border-t border-zinc-100">
              <Toggle
                name="testMode"
                defaultChecked={store.testMode}
                label="Mode test"
                hint="Paiements Whop sandbox (aucun débit réel) et commandes Shopify marquées « test ». Changer de mode demande de reconnecter Whop avec la clé correspondante."
              />
            </div>
            <SubmitButton>Enregistrer</SubmitButton>
          </form>
        </Card>

        <Card icon={Trash2} iconColor="#dc2626" title="Supprimer la boutique" description="Retire le script de la boutique Shopify, supprime le webhook Whop et efface toutes les données (commandes comprises) de cet outil.">
          <form action={deleteStoreAction.bind(null, store.id)}>
            <SubmitButton variant="danger" confirm={`Supprimer définitivement « ${store.name} » et toutes ses données ?`}>
              Supprimer définitivement {store.name}
            </SubmitButton>
          </form>
        </Card>
      </div>
    </>
  );
}
