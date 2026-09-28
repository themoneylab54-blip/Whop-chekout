import { BellRing, Settings, ShieldCheck, Store, Trash2 } from "lucide-react";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Flash, Input, Label, PageHeader, SubmitButton, Toggle } from "@/components/ui";
import { deleteStoreAction, saveAlertsAction, saveSettingsAction, saveShieldAction, testAlertAction } from "../../../../actions";
import { SecretInput } from "@/components/dashboard/SecretInput";

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  await requireAdmin();
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

        <Card
          icon={BellRing}
          iconColor="#f59e0b"
          title="Alertes"
          description="Soyez prévenu tout de suite : commande payée non créée dans Shopify, paiement à vérifier, litige, alerte de fraude, double paiement."
        >
          <form action={saveAlertsAction.bind(null, store.id)} className="space-y-4">
            <div>
              <Label htmlFor="alertEmail">E-mail d&apos;alerte</Label>
              <Input id="alertEmail" name="alertEmail" type="email" defaultValue={store.alertEmail ?? ""} placeholder="vous@exemple.fr" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="resendApiKey" hint="Pour les alertes par e-mail : resend.com → API Keys">
                  Clé API Resend
                </Label>
                <SecretInput name="resendApiKey" stored={!!store.resendApiKey} placeholder="re_…" />
              </div>
              <div>
                <Label htmlFor="emailFrom" hint="Adresse de votre domaine vérifié dans Resend">
                  Expéditeur
                </Label>
                <Input id="emailFrom" name="emailFrom" defaultValue={store.emailFrom ?? ""} placeholder="Alertes <alertes@maboutique.fr>" />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="telegramBotToken" hint="Créez un bot avec @BotFather, collez son jeton">
                  Jeton du bot Telegram
                </Label>
                <SecretInput name="telegramBotToken" stored={!!store.telegramBotToken} placeholder="123456:ABC…" />
              </div>
              <div>
                <Label htmlFor="telegramChatId" hint="Écrivez à @userinfobot pour connaître votre ID">
                  Votre ID Telegram
                </Label>
                <Input id="telegramChatId" name="telegramChatId" defaultValue={store.telegramChatId ?? ""} inputMode="numeric" placeholder="123456789" />
              </div>
            </div>
            <SubmitButton>Enregistrer</SubmitButton>
          </form>
          <form action={testAlertAction.bind(null, store.id)} className="mt-3 border-t border-zinc-100 pt-3">
            <SubmitButton size="sm" variant="secondary">
              Envoyer une alerte de test
            </SubmitButton>
          </form>
        </Card>

        <Card
          icon={ShieldCheck}
          iconColor="#10b981"
          title="Bouclier anti-litiges"
          description="Protège votre compte Whop : moins de litiges, et des litiges gagnés plus souvent."
        >
          <form action={saveShieldAction.bind(null, store.id)} className="space-y-4">
            <div className="divide-y divide-zinc-100 border-y border-zinc-100">
              <Toggle
                name="pushTracking"
                defaultChecked={store.pushTracking}
                label="Transmettre les numéros de suivi à Whop"
                hint="Dès qu'une commande est expédiée dans Shopify, son suivi est rattaché au paiement Whop (preuve de livraison)."
              />
              <Toggle
                name="autoDisputeEvidence"
                defaultChecked={store.autoDisputeEvidence}
                label="Répondre automatiquement aux litiges"
                hint="Commande, suivi, acceptation des CGV, IP et adresse sont envoyés comme preuves dès l'ouverture du litige."
              />
              <Toggle
                name="autoRefundFraudAlerts"
                defaultChecked={store.autoRefundFraudAlerts}
                label="Rembourser automatiquement les alertes de fraude"
                hint="Quand la banque signale une fraude probable, rembourser tout de suite évite le litige (frais + taux de litige)."
              />
            </div>
            <div>
              <Label htmlFor="statementDescriptor" hint="5 à 22 lettres/chiffres, ex. le nom de votre boutique. Appliqué aux nouveaux produits Whop et aux offres post-achat.">
                Libellé sur le relevé bancaire
              </Label>
              <Input id="statementDescriptor" name="statementDescriptor" defaultValue={store.statementDescriptor ?? ""} placeholder="MA BOUTIQUE" className="uppercase" />
            </div>
            <SubmitButton>Enregistrer</SubmitButton>
          </form>
        </Card>

        <Card icon={Trash2} iconColor="#dc2626" title="Supprimer la boutique" description="Retire le script Shopify et le webhook Whop, puis efface la boutique de cet outil. Impossible s'il existe des commandes payées : désactivez plutôt le checkout.">
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
