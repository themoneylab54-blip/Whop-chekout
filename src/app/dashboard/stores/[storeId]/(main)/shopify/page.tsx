import type { Metadata } from "next";
import { AlertTriangle, ArrowRight, Blocks, CheckCircle2, PackagePlus } from "lucide-react";
import { notFound } from "next/navigation";
import { DirtyForm } from "@/components/dashboard/DirtyForm";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { SHOPIFY_SCOPES, oauthCallbackUrl } from "@/lib/shopify";
import { Badge, Card, Flash, Input, Label, PageHeader, SubmitButton, Toggle, buttonClass } from "@/components/ui";
import { CopyField } from "@/components/dashboard/CopyField";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { formatDate } from "@/components/dashboard/format";
import { tzOf } from "@/lib/time";
import { disconnectShopifyAction, saveOfferMergeAction, startShopifyInstallAction } from "../../../../actions";

export const metadata: Metadata = { title: "Shopify" };

export default async function ShopifyPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; connected?: string; edit?: string }>;
}) {
  await requireAdmin();
  const { storeId } = await params;
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) notFound();
  const connected = !!store.shopifyConnectedAt;
  const showForm = !connected || sp.edit === "1";

  return (
    <>
      <PageHeader brand="shopify" title="Shopify" description="Votre boutique, où les commandes payées sont créées automatiquement." />
      <Flash ok={sp.connected ? "Boutique connectée et script installé automatiquement." : sp.ok} error={sp.error} />

      {connected && (
        <Card
          title={store.shopDomain}
          description={`Connectée le ${formatDate(store.shopifyConnectedAt!, tzOf(store))} · devise ${store.shopCurrency}`}
          actions={<Badge color="green">Connectée</Badge>}
          className="mb-6"
        >
          <ul className="mb-5 space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <span className="min-w-0">
                Autorisations :{" "}
                <span className="font-mono text-xs break-all text-zinc-600">{store.shopifyScopes?.split(",").join(", ") ?? "—"}</span>
              </span>
            </li>
            {!(store.shopifyScopes ?? "").split(",").map((x) => x.trim()).includes("write_order_edits") && (
              <li className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <span className="min-w-0">
                  Autorisation « write_order_edits » manquante : les offres post-achat ne peuvent pas être ajoutées à la commande d&apos;origine (réglage « Offres
                  post-achat » ci-dessous) et ont leur propre commande. Ajoutez-la aux « Access scopes » de l&apos;app (ci-dessous) puis reconnectez la boutique.
                </span>
              </li>
            )}
            {store.shopifyScopes && !store.shopifyScopes.split(",").map((x) => x.trim()).includes("read_discounts") && (
              <li className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <span className="min-w-0">
                  Autorisation « read_discounts » manquante : les codes promo créés dans Shopify ne sont pas reconnus au checkout (seuls ceux de l&apos;onglet Offres le sont).
                  Ajoutez-la aux « Access scopes » de l&apos;app (ci-dessous) puis reconnectez la boutique.
                </span>
              </li>
            )}
            <li className="flex items-start gap-2">
              {store.scriptTagId ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />}
              {store.scriptTagId ? "Script d'interception installé sur la boutique" : "Script non installé — voir l'onglet Interception"}
            </li>
            {store.storefrontHost && (
              <li className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" /> Domaine de la vitrine : {store.storefrontHost}
              </li>
            )}
          </ul>
          <div className="flex flex-wrap gap-2">
            <a href="?edit=1" className={buttonClass("secondary")}>
              Mettre à jour la connexion / changer de domaine
            </a>
            <form action={disconnectShopifyAction.bind(null, store.id)}>
              <ConfirmButton
                title="Déconnecter la boutique Shopify ?"
                description="Le script d'interception sera retiré et le checkout Whop désactivé : vos clients repasseront par le checkout Shopify."
                confirmLabel="Déconnecter"
              >
                Déconnecter
              </ConfirmButton>
            </form>
          </div>
        </Card>
      )}

      {connected && (
        <Card
          icon={PackagePlus}
          iconColor="#10b981"
          title="Offres post-achat (1 clic)"
          description="Où va une offre acceptée sur la page de remerciement : dans la commande d'origine, ou dans sa propre commande Shopify."
          className="mb-6"
        >
          <DirtyForm label="Offres post-achat" action={saveOfferMergeAction.bind(null, store.id)} className="space-y-4">
            <Toggle
              name="mergeOffersIntoOrder"
              defaultChecked={store.mergeOffersIntoOrder}
              label="Ajouter les offres à la commande d'origine"
              hint={
                <>
                  Activé : l&apos;offre est ajoutée à la commande Shopify du checkout (un seul colis, son paiement Whop enregistré sur la commande), seulement pendant la
                  fenêtre ci-dessous, sur une commande non expédiée, sans blocage de traitement ni tag fournisseur. Sinon, ou désactivé : l&apos;offre a sa propre
                  commande Shopify, liée à la première. <strong>Dropshipping (DSers, AutoDS, Zendrop, CJ…)</strong> : si votre app transmet les commandes au
                  fournisseur automatiquement, une offre ajoutée après cette transmission ne serait jamais expédiée — laissez désactivé, ou gardez une fenêtre
                  plus courte que le délai de transmission de votre app.
                </>
              }
            />
            <div>
              <Label htmlFor="offerMergeWindowMin" hint="Au-delà de ce délai après la création de la commande d'origine, l'offre a toujours sa propre commande.">
                Fenêtre d&apos;ajout (minutes)
              </Label>
              <Input id="offerMergeWindowMin" name="offerMergeWindowMin" type="number" min={1} max={1440} step={1} defaultValue={store.offerMergeWindowMin} className="max-w-32" />
            </div>
            {store.mergeOffersIntoOrder && !(store.shopifyScopes ?? "").split(",").map((x) => x.trim()).includes("write_order_edits") && (
              <p className="flex items-start gap-2 text-xs text-amber-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> Autorisation « write_order_edits » manquante : les offres gardent leur propre commande
                jusqu&apos;à la reconnexion de la boutique.
              </p>
            )}
          </DirtyForm>
        </Card>
      )}

      {showForm && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Card icon={Blocks} title="1. Créez l'app dans Shopify" description="Une seule fois par boutique, environ 3 minutes.">
            <ol className="mb-5 list-decimal space-y-2 pl-5 text-sm text-zinc-700">
              <li>
                Ouvrez le{" "}
                <a href="https://dev.shopify.com/dashboard" target="_blank" rel="noreferrer" className="font-medium underline">
                  Dev Dashboard Shopify
                </a>{" "}
                → <strong>Create app</strong>. Donnez-lui un nom, par exemple « Checkout ».
              </li>
              <li>Dans la version de l&apos;app, collez l&apos;<strong>App URL</strong> et la <strong>Redirect URL</strong> ci-dessous.</li>
              <li>Dans <strong>Access scopes</strong>, collez la liste des autorisations.</li>
              <li>
                <strong>Release</strong> la version, puis dans <strong>Distribution</strong>, choisissez <em>Custom distribution</em> et votre
                domaine .myshopify.com.
              </li>
              <li>
                Dans <strong>Settings</strong>, copiez le <strong>Client ID</strong> et le <strong>Client secret</strong>.
              </li>
            </ol>
            <div className="space-y-3">
              <CopyField label="App URL" value={env.appUrl} />
              <CopyField label="Redirect URL" value={oauthCallbackUrl()} />
              <CopyField label="Access scopes" value={SHOPIFY_SCOPES.join(",")} />
            </div>
          </Card>

          <Card brand="shopify" title="2. Connectez la boutique" description="On redirige vers Shopify pour approuver l'installation, puis tout est automatique.">
            <DirtyForm label="Connexion Shopify" action={startShopifyInstallAction.bind(null, store.id)} className="space-y-4">
              <div>
                <Label htmlFor="shopDomain" hint="L'adresse en .myshopify.com (Paramètres → Domaines)">
                  Domaine de la boutique
                </Label>
                <Input id="shopDomain" name="shopDomain" placeholder="ma-boutique.myshopify.com" defaultValue={store.shopDomain ?? ""} required />
              </div>
              <div>
                <Label htmlFor="clientId">Client ID</Label>
                <Input id="clientId" name="clientId" defaultValue={store.shopifyClientId ?? ""} required autoComplete="off" />
              </div>
              <div>
                <Label htmlFor="clientSecret" hint={store.shopifyClientSecret ? "Laissez vide pour garder le secret enregistré" : undefined}>
                  Client secret
                </Label>
                <Input
                  id="clientSecret"
                  name="clientSecret"
                  type="password"
                  autoComplete="off"
                  required={!store.shopifyClientSecret}
                  placeholder={store.shopifyClientSecret ? "••••••••••••" : ""}
                />
              </div>
              <SubmitButton className="w-full">
                Enregistrer et installer sur Shopify <ArrowRight className="h-4 w-4" />
              </SubmitButton>
              <p className="text-xs text-zinc-500">
                Le secret est chiffré (AES-256) avant d&apos;être enregistré. Après approbation, le script d&apos;interception est installé
                automatiquement : aucune modification du thème n&apos;est nécessaire.
              </p>
            </DirtyForm>
          </Card>
        </div>
      )}
    </>
  );
}
