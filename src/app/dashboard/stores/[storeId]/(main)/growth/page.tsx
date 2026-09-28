import { notFound } from "next/navigation";
import { Mail, Megaphone, Radar } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { daysAgo } from "@/lib/time";
import { db } from "@/lib/db";
import { Card, Flash, Input, Label, PageHeader, SubmitButton, Toggle } from "@/components/ui";
import { SecretInput } from "@/components/dashboard/SecretInput";
import { saveRecoveryAction, saveTrackingAction, testTrackingAction } from "../../../../actions";

export default async function GrowthPage({
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
  const since = daysAgo(30);
  const [sent, recovered] = await Promise.all([
    db.checkoutSession.count({ where: { storeId, recoveryStage: { gt: 0 }, createdAt: { gte: since } } }),
    db.checkoutSession.count({ where: { storeId, recoveryStage: { gt: 0 }, status: "PAID", createdAt: { gte: since } } }),
  ]);

  return (
    <>
      <PageHeader
        icon={Megaphone}
        iconColor="#f97316"
        title="Pixels & relances"
        description="Donnez à vos pubs les achats qu'elles ne voient plus, et récupérez les paniers abandonnés."
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="grid max-w-3xl gap-6">
        <Card
          icon={Radar}
          iconColor="#2563eb"
          title="Pixels côté serveur (Meta & TikTok)"
          description="Vos clients ne passent plus par la page de remerciement Shopify : sans ceci, Meta et TikTok ne voient aucun achat et optimisent à l'aveugle. Chaque achat est envoyé depuis le serveur (e-mail/téléphone hachés, identifiants _fbp/_fbc/_ttp), dédoublonné avec votre pixel navigateur. Un refus sur la bannière cookies Shopify est respecté."
        >
          <form action={saveTrackingAction.bind(null, store.id)} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="metaPixelId" hint="Gestionnaire d'événements → votre pixel → ID">
                  ID du pixel Meta
                </Label>
                <Input id="metaPixelId" name="metaPixelId" defaultValue={store.metaPixelId ?? ""} inputMode="numeric" placeholder="123456789012345" />
              </div>
              <div>
                <Label htmlFor="metaAccessToken" hint="Paramètres du pixel → API Conversions → Générer un jeton">
                  Jeton d&apos;accès Meta
                </Label>
                <SecretInput name="metaAccessToken" stored={!!store.metaAccessToken} placeholder="EAAB…" />
              </div>
              <div>
                <Label htmlFor="metaTestEventCode" hint="Facultatif, pour vérifier dans « Événements de test ». Videz-le ensuite.">
                  Code d&apos;événement test Meta
                </Label>
                <Input id="metaTestEventCode" name="metaTestEventCode" defaultValue={store.metaTestEventCode ?? ""} placeholder="TEST12345" />
              </div>
              <div />
              <div>
                <Label htmlFor="tiktokPixelId" hint="TikTok Ads → Événements → Pixel code">
                  Code du pixel TikTok
                </Label>
                <Input id="tiktokPixelId" name="tiktokPixelId" defaultValue={store.tiktokPixelId ?? ""} placeholder="C1ABCDEF2GHIJ3KLMNOP" />
              </div>
              <div>
                <Label htmlFor="tiktokAccessToken" hint="Paramètres du pixel → Events API → Générer un jeton">
                  Jeton TikTok Events API
                </Label>
                <SecretInput name="tiktokAccessToken" stored={!!store.tiktokAccessToken} />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <SubmitButton>Enregistrer</SubmitButton>
            </div>
          </form>
          <form action={testTrackingAction.bind(null, store.id)} className="mt-3 border-t border-zinc-100 pt-3">
            <SubmitButton variant="secondary" size="sm">
              Envoyer un événement de test
            </SubmitButton>
          </form>
        </Card>

        <Card
          icon={Mail}
          iconColor="#10b981"
          title="Relance des paniers abandonnés"
          description={`L'e-mail est enregistré dès qu'il est saisi. Deux relances : 1 h puis 24 h après l'abandon (la 2ᵉ avec votre code promo si vous en choisissez un). 30 derniers jours : ${sent} relancé(s), ${recovered} récupéré(s).`}
        >
          <form action={saveRecoveryAction.bind(null, store.id)} className="space-y-4">
            <div className="divide-y divide-zinc-100 border-y border-zinc-100">
              <Toggle name="recoveryEnabled" defaultChecked={store.recoveryEnabled} label="Activer les relances automatiques" />
              <Toggle
                name="recoveryConsentOnly"
                defaultChecked={store.recoveryConsentOnly}
                label="Seulement aux clients ayant accepté les e-mails marketing"
                hint="Recommandé dans l'UE (RGPD / CNIL). Désactivez à vos risques si vous considérez la relance comme un e-mail de service."
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="resendApiKey" hint="resend.com → API Keys (domaine d'envoi vérifié requis)">
                  Clé API Resend
                </Label>
                <SecretInput name="resendApiKey" stored={!!store.resendApiKey} placeholder="re_…" />
              </div>
              <div>
                <Label htmlFor="emailFrom" hint="Doit utiliser votre domaine vérifié dans Resend">
                  Expéditeur
                </Label>
                <Input id="emailFrom" name="emailFrom" defaultValue={store.emailFrom ?? ""} placeholder="Ma Boutique <contact@maboutique.fr>" />
              </div>
              <div>
                <Label htmlFor="recoveryCode" hint="Facultatif · à créer d'abord dans Promos & options">
                  Code promo de la 2ᵉ relance
                </Label>
                <Input id="recoveryCode" name="recoveryCode" defaultValue={store.recoveryCode ?? ""} placeholder="REVIENS10" className="uppercase" />
              </div>
            </div>
            <SubmitButton>Enregistrer</SubmitButton>
          </form>
        </Card>
      </div>
    </>
  );
}
