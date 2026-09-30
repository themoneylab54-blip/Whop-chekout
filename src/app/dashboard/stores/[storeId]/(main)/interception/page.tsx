import type { Metadata } from "next";
import { Boxes, Code2, Crosshair, ExternalLink, LifeBuoy, MousePointerClick, ScanEye } from "lucide-react";
import { notFound } from "next/navigation";
import { DirtyForm } from "@/components/dashboard/DirtyForm";
import { requireStoreAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { loadInterception } from "@/lib/layout";
import { loaderUrl } from "@/lib/shopify";
import { Badge, Card, Flash, Label, PageHeader, SubmitButton, Textarea, Toggle, buttonClass } from "@/components/ui";
import { CopyField } from "@/components/dashboard/CopyField";
import { reinstallScriptAction, saveInterceptionAction } from "../../../../actions";

export const metadata: Metadata = { title: "Interception" };

export default async function InterceptionPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { storeId } = await params;
  await requireStoreAccess(storeId, "view");
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) notFound();
  const i = loadInterception(store.interception);
  const shopUrl = store.storefrontHost ? `https://${store.storefrontHost}` : store.shopDomain ? `https://${store.shopDomain}` : null;

  return (
    <>
      <PageHeader
        icon={Crosshair}
        title="Interception"
        description="Choisissez quels boutons de la boutique ouvrent votre checkout Whop. Tout est automatique : aucune modification du thème."
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[1.3fr_1fr] [&>*]:min-w-0">
        <Card icon={MousePointerClick} title="Boutons interceptés" description="Les changements sont actifs sur la boutique en quelques secondes.">
          <DirtyForm label="Boutons interceptés" action={saveInterceptionAction.bind(null, store.id)}>
            <div className="divide-y divide-zinc-100">
              <Toggle name="cartCheckout" defaultChecked={i.cartCheckout} label="Bouton « Paiement » de la page panier" hint="Le bouton Checkout de /cart." />
              <Toggle name="cartDrawer" defaultChecked={i.cartDrawer} label="Bouton « Paiement » du tiroir panier" hint="Cart drawer et notification d'ajout au panier." />
              <Toggle name="buyNow" defaultChecked={i.buyNow} label="« Acheter maintenant » sur la fiche produit" hint="Envoie uniquement ce produit au checkout, sans toucher au panier." />
              <Toggle
                name="addToCartDirect"
                defaultChecked={i.addToCartDirect}
                label="« Ajouter au panier » → checkout direct"
                hint="Pour les boutiques mono-produit : l'ajout au panier ouvre directement le paiement."
              />
            </div>
            <div className="mt-4 space-y-4 border-t border-zinc-100 pt-4">
              <div>
                <Label htmlFor="customSelectors" hint="Pour un thème exotique : un sélecteur CSS par ligne (ex. .mon-bouton-paiement).">
                  Sélecteurs personnalisés
                </Label>
                <Textarea id="customSelectors" name="customSelectors" rows={3} defaultValue={i.customSelectors} className="font-mono text-xs" />
              </div>
              <div>
                <Label htmlFor="excludedHandles" hint="Handles de produits qui gardent le checkout Shopify (un par ligne). Si le panier en contient un, on laisse Shopify gérer.">
                  Produits exclus
                </Label>
                <Textarea id="excludedHandles" name="excludedHandles" rows={3} defaultValue={i.excludedHandles.join("\n")} className="font-mono text-xs" />
              </div>
            </div>
          </DirtyForm>
        </Card>

        <div className="space-y-6">
          <Card icon={Code2} iconColor="#0ea5e9" title="Script sur la boutique" actions={<Badge color={store.scriptTagId ? "green" : "amber"}>{store.scriptTagId ? "Installé" : "Non installé"}</Badge>}>
            <p className="mb-4 text-sm text-zinc-600">
              Le script est injecté automatiquement via l&apos;API Shopify à la connexion. S&apos;il a été supprimé, réinstallez-le en un clic.
            </p>
            <form action={reinstallScriptAction.bind(null, store.id)}>
              <SubmitButton variant="secondary" disabled={!store.shopifyConnectedAt}>
                Vérifier / réinstaller le script
              </SubmitButton>
            </form>
          </Card>

          <Card icon={ScanEye} iconColor="#10b981" title="Tester l'interception">
            <p className="mb-4 text-sm text-zinc-600">
              Ouvre la boutique en mode test : les boutons détectés sont entourés en vert et un badge confirme que l&apos;interception est active.
            </p>
            {shopUrl ? (
              <a
                href={`${shopUrl}/?whopco_debug=1`}
                target="_blank"
                rel="noreferrer"
                className={buttonClass("primary")}
              >
                Ouvrir la boutique en mode test <ExternalLink className="h-4 w-4" />
              </a>
            ) : (
              <p className="text-sm text-zinc-500">Connectez d&apos;abord Shopify.</p>
            )}
          </Card>

          <Card icon={Boxes} iconColor="#8b5cf6" title="Apps de lots, upsell et personnalisation" description="Kaching Bundles, Fast Bundle, Bundler, Zepto, EasyBundle, options produit…">
            <ul className="list-disc space-y-1.5 pl-5 text-sm text-zinc-600">
              <li>Les propriétés des lignes du panier (gravure, fichiers, clés cachées « _… » des apps) et les attributs / la note du panier sont repris sur la commande Shopify ; les propriétés visibles s&apos;affichent au checkout.</li>
              <li>Les remises des apps (fonctions de remise) et les prix de lot fixés par une app (Cart Transform) sont relus côté serveur dans le panier Shopify : l&apos;acheteur paie exactement le prix du panier, jamais plus.</li>
              <li>La quantité d&apos;un lot ou d&apos;un article personnalisé se modifie depuis le panier (bouton désactivé au checkout).</li>
              <li>
                Un panier impossible à reproduire fidèlement (lot inconnu, prix supérieur ou non réconciliable, autre devise, lot en quantité &gt; 1, même article sur plusieurs lignes) part sur le checkout Shopify natif, comme les abonnements et cartes cadeaux, avec une entrée « cart.unsupported_app_pricing » au journal.
              </li>
            </ul>
          </Card>

          <Card icon={LifeBuoy} iconColor="#71717a" title="Plan B : installation manuelle" description="Seulement si votre thème bloque le script automatique.">
            <p className="mb-3 text-sm text-zinc-600">
              Shopify → Boutique en ligne → Thèmes → Modifier le code → <code>theme.liquid</code>, collez cette ligne juste avant{" "}
              <code>&lt;/head&gt;</code> :
            </p>
            <CopyField label="Ligne à coller dans theme.liquid" value={`<script src="${loaderUrl(store.publicId)}" defer></script>`} />
          </Card>
        </div>
      </div>
    </>
  );
}
