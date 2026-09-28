import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { Megaphone, Radar } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Flash, Input, Label, LearnMore, PageHeader, Select, SubmitButton, Toggle } from "@/components/ui";
import { DirtyForm } from "@/components/dashboard/DirtyForm";
import { SecretInput } from "@/components/dashboard/SecretInput";
import { AdSpendSection } from "@/components/dashboard/AdSpendSection";
import { saveTrackingAction, testTrackingAction } from "../../../../actions";

export const metadata: Metadata = { title: "Pub & pixels" };

const VALUE_MODES = [
  { value: "revenue", title: "Montant de la commande", text: "Le total TTC payé par le client. Le choix standard, comparable à vos rapports Shopify." },
  {
    value: "profit",
    title: "Marge HT",
    text: "La marge HT de la commande, calculée comme dans Analytics. Pour enchérir sur la rentabilité (POAS) plutôt que sur le chiffre d'affaires.",
  },
] as const;

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
        title="Pub & pixels"
        description="Donnez à vos pubs Meta et TikTok les achats qu'elles ne voient plus depuis que le paiement se fait hors de Shopify."
      />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="grid grid-cols-[minmax(0,1fr)] max-w-3xl gap-6">
        <Card
          icon={Radar}
          iconColor="#2563eb"
          title="Pixels côté serveur (Meta & TikTok)"
          description="Sans ceci, Meta et TikTok ne voient aucun achat (vos clients ne passent plus par la page de remerciement Shopify) et optimisent à l'aveugle."
        >
          <LearnMore className="-mt-2 mb-3">
            Chaque achat est envoyé depuis le serveur (e-mail/téléphone hachés, identifiants _fbp/_fbc/_ttp), dédoublonné avec votre pixel navigateur. Le même événement est aussi
            envoyé par le pixel navigateur sur la page de paiement (dédoublonné), et renvoyé automatiquement en cas d&apos;échec.
          </LearnMore>
          <DirtyForm label="Pixels" action={saveTrackingAction.bind(null, store.id)} className="space-y-4">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
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
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="ga4MeasurementId" hint="Google Analytics → Admin → Flux de données → ID de mesure">
                  ID de mesure GA4
                </Label>
                <Input id="ga4MeasurementId" name="ga4MeasurementId" defaultValue={store.ga4MeasurementId ?? ""} placeholder="G-XXXXXXXXXX" />
              </div>
              <div>
                <Label htmlFor="ga4ApiSecret" hint="Même écran → Secrets de l'API Measurement Protocol → Créer. Les achats (et débuts de checkout) sont envoyés côté serveur, rattachés au visiteur de la boutique.">
                  Secret API Measurement Protocol
                </Label>
                <SecretInput name="ga4ApiSecret" stored={!!store.ga4ApiSecret} />
              </div>
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
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
            <fieldset aria-describedby="conversionValueMode-hint">
              <legend className="text-[13px] font-medium text-zinc-800">Valeur de conversion envoyée</legend>
              <p id="conversionValueMode-hint" className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                La valeur des achats transmise à Meta et TikTok. Avec la marge, les campagnes « valeur » optimisent votre bénéfice.
              </p>
              <LearnMore>
                Marge HT = total HT moins frais Whop, coût des produits et des options, coût transporteur et frais de préparation. GA4 reçoit toujours le chiffre d&apos;affaires
                comme <code>value</code> (vos rapports de revenus et les conversions importées dans Google Ads restent justes) et, en mode marge, la marge dans le paramètre
                personnalisé <code>profit</code> (à déclarer comme métrique personnalisée dans GA4 › Administration › Définitions personnalisées). Dans tous les cas, pour qu&apos;elle soit juste, renseignez le coût de
                vos produits (page{" "}
                <Link href={`/dashboard/stores/${storeId}/costs`} className="text-indigo-700 underline">
                  Coûts produits
                </Link>
                , ou le coût unitaire dans Shopify), le coût transporteur de vos tarifs de livraison et vos frais de préparation. Les rapports Meta et TikTok afficheront alors la marge, pas le
                chiffre d&apos;affaires.
              </LearnMore>
              <div className="mt-2.5 grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
                {VALUE_MODES.map((m) => (
                  <label
                    key={m.value}
                    className="flex cursor-pointer items-start gap-3 rounded-xl p-3.5 ring-1 ring-zinc-200 transition hover:bg-zinc-50 has-[:checked]:bg-indigo-50/60 has-[:checked]:ring-2 has-[:checked]:ring-indigo-500 has-[:focus-visible]:ring-4 has-[:focus-visible]:ring-indigo-500/30"
                  >
                    <input
                      type="radio"
                      name="conversionValueMode"
                      value={m.value}
                      defaultChecked={(store.conversionValueMode === "profit" ? "profit" : "revenue") === m.value}
                      className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-zinc-900">{m.title}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-zinc-500">{m.text}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </DirtyForm>
          <form action={testTrackingAction.bind(null, store.id)} className="mt-3 border-t border-zinc-100 pt-3">
            <SubmitButton variant="secondary" size="sm">
              Envoyer un événement de test
            </SubmitButton>
          </form>
        </Card>

        {/* Dépenses publicitaires (ROAS / bénéfice après pub) */}
        <div id="adspend" className="scroll-mt-6">
          <AdSpendSection store={store} />
        </div>
      </div>
    </>
  );
}
