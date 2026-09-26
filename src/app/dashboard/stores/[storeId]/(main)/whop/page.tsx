import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { whopWebhookUrl, WHOP_WEBHOOK_EVENTS } from "@/lib/whop";
import { Badge, Card, CopyField, Flash, Input, Label, PageHeader, SubmitButton } from "@/components/ui";
import { connectWhopAction, disconnectWhopAction } from "../../../../actions";

export default async function WhopPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; edit?: string }>;
}) {
  const { storeId } = await params;
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) notFound();
  const connected = !!store.whopConnectedAt;
  const env = store.testMode ? "sandbox" : "production";

  return (
    <>
      <PageHeader title="Whop" description="Le compte qui encaisse chaque paiement. Votre compte, vos fonds." />
      <Flash ok={sp.ok} error={sp.error} />

      {connected && (
        <Card
          title="Compte Whop connecté"
          description={`Environnement ${env} · connecté le ${store.whopConnectedAt!.toLocaleDateString("fr-FR")}`}
          actions={<Badge color="green">Connecté</Badge>}
          className="mb-6"
        >
          <dl className="mb-5 grid gap-3 text-sm sm:grid-cols-2">
            <Info k="Compte" v={store.whopAccountId} />
            <Info k="Produit « Checkout »" v={store.whopProductId} />
            <Info k="Webhook" v={store.whopWebhookId} />
            <Info k="Événements" v={WHOP_WEBHOOK_EVENTS.join(", ")} />
          </dl>
          <CopyField label="URL du webhook (créé automatiquement)" value={whopWebhookUrl(store.id)} />
          <div className="mt-5 flex flex-wrap gap-2">
            <a href="?edit=1" className="inline-flex items-center rounded-lg border border-zinc-300 bg-white px-4 py-2 text-sm font-medium hover:bg-zinc-50">
              Changer de clé API
            </a>
            <form action={disconnectWhopAction.bind(null, store.id)}>
              <SubmitButton variant="danger" confirm="Déconnecter Whop ? Le checkout Whop sera désactivé.">
                Déconnecter
              </SubmitButton>
            </form>
          </div>
        </Card>
      )}

      {(!connected || sp.edit === "1") && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Où trouver la clé API ?">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-zinc-700">
              <li>
                Ouvrez{" "}
                <a href={store.testMode ? "https://sandbox.whop.com/dashboard" : "https://whop.com/dashboard"} target="_blank" rel="noreferrer" className="font-medium underline">
                  votre dashboard Whop {store.testMode ? "(sandbox)" : ""}
                </a>{" "}
                → <strong>Developer</strong> → <strong>API keys</strong>.
              </li>
              <li>
                Créez une clé <strong>Company API key</strong> avec les permissions produits, plans, checkout, paiements et webhooks.
              </li>
              <li>Collez-la ici. On crée automatiquement le produit « Checkout » caché et le webhook : rien à configurer dans Whop.</li>
            </ol>
            <p className="mt-4 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
              La boutique est en mode <strong>{store.testMode ? "test" : "production"}</strong> : utilisez une clé{" "}
              {store.testMode ? "sandbox" : "de production"}. Le mode se change dans Réglages.
            </p>
          </Card>
          <Card title="Connecter Whop">
            <form action={connectWhopAction.bind(null, store.id)} className="space-y-4">
              <div>
                <Label htmlFor="apiKey">Clé API Whop ({env})</Label>
                <Input id="apiKey" name="apiKey" type="password" autoComplete="off" required placeholder="apik_…" />
              </div>
              <SubmitButton className="w-full">Connecter et configurer automatiquement</SubmitButton>
              <p className="text-xs text-zinc-500">La clé et le secret du webhook sont chiffrés avant d&apos;être enregistrés.</p>
            </form>
          </Card>
        </div>
      )}
    </>
  );
}

function Info({ k, v }: { k: string; v: string | null }) {
  return (
    <div>
      <dt className="text-xs text-zinc-500">{k}</dt>
      <dd className="truncate font-mono text-xs">{v ?? "—"}</dd>
    </div>
  );
}
