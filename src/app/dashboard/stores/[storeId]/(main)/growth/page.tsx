import { notFound } from "next/navigation";
import { Megaphone, Radar } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Flash, Input, Label, PageHeader, Select, SubmitButton, Toggle } from "@/components/ui";
import { SecretInput } from "@/components/dashboard/SecretInput";
import { saveTrackingAction, testTrackingAction } from "../../../../actions";

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

  return (
    <>
      <PageHeader
        icon={Megaphone}
        iconColor="#f97316"
        title="Pixels publicitaires"
        description="Donnez à vos pubs Meta et TikTok les achats qu'elles ne voient plus depuis que le paiement se fait hors de Shopify."
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="grid max-w-3xl gap-6">
        <Card
          icon={Radar}
          iconColor="#2563eb"
          title="Pixels côté serveur (Meta & TikTok)"
          description="Vos clients ne passent plus par la page de remerciement Shopify : sans ceci, Meta et TikTok ne voient aucun achat et optimisent à l'aveugle. Chaque achat est envoyé depuis le serveur (e-mail/téléphone hachés, identifiants _fbp/_fbc/_ttp), dédoublonné avec votre pixel navigateur. Le même événement est aussi envoyé par le pixel navigateur sur la page de paiement (dédoublonné), et renvoyé automatiquement en cas d'échec."
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
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="metaContentIdFormat" hint="« Catalogue Shopify » si vos pubs dynamiques utilisent le catalogue synchronisé par l'app Facebook de Shopify.">
                  Identifiants produits Meta
                </Label>
                <Select id="metaContentIdFormat" name="metaContentIdFormat" defaultValue={store.metaContentIdFormat}>
                  <option value="variant">ID de variante</option>
                  <option value="shopify">Catalogue Shopify (shopify_FR_produit_variante)</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="metaCatalogCountry" hint="Le pays de votre catalogue Meta (celui de la boutique), pour les identifiants « Catalogue Shopify ».">
                  Pays du catalogue
                </Label>
                <Input id="metaCatalogCountry" name="metaCatalogCountry" defaultValue={store.metaCatalogCountry} maxLength={2} className="w-24 uppercase" />
              </div>
            </div>
            <div className="border-y border-zinc-100">
              <Toggle
                name="pixelRequireConsent"
                defaultChecked={store.pixelRequireConsent}
                label="Exiger un consentement explicite"
                hint="Recommandé si votre bannière cookies Shopify est active : aucun envoi tant que le client n'a pas accepté le marketing. Un refus est toujours respecté."
              />
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

      </div>
    </>
  );
}
