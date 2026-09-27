import { AlertTriangle, ArrowRight, Blocks, CheckCircle2, PlugZap, ShoppingBag } from "lucide-react";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { SHOPIFY_SCOPES, oauthCallbackUrl } from "@/lib/shopify";
import { Badge, Card, CopyField, Flash, Input, Label, PageHeader, SubmitButton, buttonClass } from "@/components/ui";
import { disconnectShopifyAction, startShopifyInstallAction } from "../../../../actions";

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
      <PageHeader icon={ShoppingBag} iconColor="#16a34a" title="Shopify" description="Votre boutique, où les commandes payées sont créées automatiquement." />
      <Flash ok={sp.connected ? "Boutique connectée et script installé automatiquement." : sp.ok} error={sp.error} />

      {connected && (
        <Card
          title={store.shopDomain}
          description={`Connectée le ${store.shopifyConnectedAt!.toLocaleDateString("fr-FR")} · devise ${store.shopCurrency}`}
          actions={<Badge color="green">Connectée</Badge>}
          className="mb-6"
        >
          <ul className="mb-5 space-y-2 text-sm">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <span>
                Autorisations : <span className="font-mono text-xs text-zinc-600">{store.shopifyScopes}</span>
              </span>
            </li>
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
              <SubmitButton variant="danger" confirm="Déconnecter la boutique ? Le checkout Whop sera désactivé.">
                Déconnecter
              </SubmitButton>
            </form>
          </div>
        </Card>
      )}

      {showForm && (
        <div className="grid gap-6 lg:grid-cols-2">
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

          <Card icon={PlugZap} title="2. Connectez la boutique" description="On redirige vers Shopify pour approuver l'installation, puis tout est automatique.">
            <form action={startShopifyInstallAction.bind(null, store.id)} className="space-y-4">
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
            </form>
          </Card>
        </div>
      )}
    </>
  );
}
