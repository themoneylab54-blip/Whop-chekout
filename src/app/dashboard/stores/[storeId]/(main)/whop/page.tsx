import type { Metadata } from "next";
import { Globe2, KeyRound, Smartphone, Wallet } from "lucide-react";
import { notFound } from "next/navigation";
import { DirtyForm } from "@/components/dashboard/DirtyForm";
import { requireAdmin } from "@/lib/auth";
import { daysAgo, tzOf } from "@/lib/time";
import { db } from "@/lib/db";
import { OPTIONAL_PAYMENT_METHODS, whopWebhookUrl, WHOP_WEBHOOK_EVENTS } from "@/lib/whop";
import { Badge, Card, Flash, Input, Label, PageHeader, SubmitButton, Textarea, buttonClass } from "@/components/ui";
import { CopyField } from "@/components/dashboard/CopyField";
import { env as appEnv } from "@/lib/env";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { formatDate, formatDateTime } from "@/components/dashboard/format";
import { connectWhopAction, disconnectWhopAction, refreshWhopWebhookAction, savePaymentMethodsAction, setupApplePayAction } from "../../../../actions";

export const metadata: Metadata = { title: "Whop" };

export default async function WhopPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; edit?: string }>;
}) {
  await requireAdmin();
  const { storeId } = await params;
  const sp = await searchParams;
  const [store, applePayFile, methodsRejected] = await Promise.all([
    db.store.findUnique({ where: { id: storeId } }),
    db.appSetting.findUnique({ where: { key: "apple_pay_domain_association" } }),
    // Recent rejection of the optional methods (last 7 days).
    db.eventLog.findFirst({ where: { storeId, kind: "payment_methods.rejected", createdAt: { gt: daysAgo(7) } }, orderBy: { createdAt: "desc" }, select: { createdAt: true, data: true } }),
  ]);
  if (!store) notFound();
  const connected = !!store.whopConnectedAt;
  const checkoutHost = new URL(appEnv.appUrl).hostname;
  const env = store.testMode ? "sandbox" : "production";

  return (
    <>
      <PageHeader brand="whop" title="Whop" description="Le compte qui encaisse chaque paiement. Votre compte, vos fonds." />
      <Flash ok={sp.ok} error={sp.error} />

      {connected && (
        <Card
          title="Compte Whop connecté"
          description={`Environnement ${env} · connecté le ${formatDate(store.whopConnectedAt!, tzOf(store))}`}
          actions={<Badge color="green">Connecté</Badge>}
          className="mb-6"
        >
          <dl className="mb-5 grid grid-cols-[minmax(0,1fr)] gap-3 text-sm sm:grid-cols-3">
            <Info k="Compte" v={store.whopAccountId} />
            <Info k="Produit « Checkout »" v={store.whopProductId} />
            <Info k="Webhook" v={store.whopWebhookId} />
          </dl>
          <div className="mb-5">
            <p id="whop-events" className="mb-1.5 text-xs text-zinc-500">
              Événements écoutés ({WHOP_WEBHOOK_EVENTS.length})
            </p>
            <ul aria-labelledby="whop-events" className="flex flex-wrap gap-1.5">
              {WHOP_WEBHOOK_EVENTS.map((e) => (
                <li key={e} className="max-w-full rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-[11px] break-all text-zinc-700 ring-1 ring-zinc-900/5 ring-inset">
                  {e}
                </li>
              ))}
            </ul>
          </div>
          <CopyField label="URL du webhook (créé automatiquement)" value={whopWebhookUrl(store.id)} />
          <div className="mt-5 flex flex-wrap gap-2">
            <a href="?edit=1" className={buttonClass("secondary")}>
              Changer de clé API
            </a>
            <form action={refreshWhopWebhookAction.bind(null, store.id)}>
              <SubmitButton variant="secondary" title="À faire après une mise à jour de l'app : ajoute les nouveaux événements (alertes de fraude…)">
                Mettre à jour le webhook
              </SubmitButton>
            </form>
            <form action={disconnectWhopAction.bind(null, store.id)}>
              <ConfirmButton
                title="Déconnecter Whop ?"
                description="Le checkout Whop sera désactivé et vos clients repasseront par le checkout Shopify. Le webhook et le produit « Checkout » seront retirés de Whop."
                confirmLabel="Déconnecter"
              >
                Déconnecter
              </ConfirmButton>
            </form>
          </div>
        </Card>
      )}

      {connected && (
        <div className="mb-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Card
            icon={Smartphone}
            iconColor="#0f172a"
            title="Apple Pay"
            description={`Affiche le bouton Apple Pay sur Safari, iPhone et Mac. Domaine : ${checkoutHost}`}
            actions={<Badge color={applePayFile ? "blue" : "zinc"}>{applePayFile ? "Fichier installé" : "À configurer"}</Badge>}
          >
            <ol className="mb-4 list-decimal space-y-1.5 pl-5 text-sm text-zinc-700">
              <li>
                Dans Whop : <strong>Paramètres → Checkout → Apple Pay for embedded checkout</strong> → <strong>Self-hosted verification</strong>.
              </li>
              <li>Téléchargez le fichier de vérification, ouvrez-le avec un éditeur de texte et copiez tout son contenu.</li>
              <li>Collez-le ci-dessous puis cliquez sur le bouton : on l&apos;installe et on enregistre le domaine chez Whop.</li>
            </ol>
            <DirtyForm label="Apple Pay" action={setupApplePayAction.bind(null, store.id)} className="space-y-3">
              <Label htmlFor="association">Fichier de vérification Apple Pay</Label>
              <Textarea
                id="association"
                name="association"
                rows={4}
                placeholder={applePayFile ? "Fichier déjà installé — collez-en un nouveau pour le remplacer" : "Contenu du fichier apple-developer-merchantid-domain-association"}
                className="font-mono text-xs"
              />
              <SubmitButton>{applePayFile ? "Vérifier le domaine" : "Installer et vérifier"}</SubmitButton>
            </DirtyForm>
          </Card>
          <Card icon={Wallet} iconColor="#0ea5e9" title="PayPal, Google Pay & autres" description="Proposés automatiquement dans le formulaire de paiement dès qu'ils sont actifs sur votre compte Whop.">
            <ul className="space-y-2 text-sm text-zinc-700">
              <li>
                <strong>PayPal</strong> : activez-le dans Whop → <strong>Paramètres → Moyens de paiement</strong>. Il apparaît ensuite tout seul au checkout.
              </li>
              <li>
                <strong>Google Pay</strong> : s&apos;affiche automatiquement sur Chrome et Android quand le client a une carte enregistrée.
              </li>
              <li>
                <strong>Paiement express</strong> : les boutons Apple Pay / Google Pay en haut du checkout s&apos;activent ou se masquent dans{" "}
                <strong>Design du checkout → Thème &amp; textes</strong>.
              </li>
            </ul>
          </Card>
        </div>
      )}

      {connected && (
        <Card
          icon={Globe2}
          iconColor="#8b5cf6"
          title="Paiements locaux & en plusieurs fois"
          description="Ajoutez les moyens préférés de chaque pays. Whop ne montre chacun qu'aux clients des pays concernés, et seulement s'il est activé sur votre compte (sinon il est ignoré sans bloquer le paiement)."
          className="mb-6"
        >
          {methodsRejected && (
            <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-600/20">
              Le {formatDateTime(methodsRejected.createdAt, false, tzOf(store))}, Whop n&apos;a pas
              activé : <strong>{((methodsRejected.data as { dropped?: string[] } | null)?.dropped ?? []).join(", ") || "un moyen de la liste"}</strong>. Activez-les
              dans Whop → Paramètres → Moyens de paiement, ou décochez-les. Les autres moyens restent proposés.
            </p>
          )}
          <DirtyForm label="Paiements locaux" action={savePaymentMethodsAction.bind(null, store.id)}>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2 lg:grid-cols-3 [&>*]:min-w-0">
              {OPTIONAL_PAYMENT_METHODS.map((m) => (
                <label
                  key={m.id}
                  htmlFor={`method-${m.id}`}
                  className="flex cursor-pointer items-start gap-2.5 rounded-xl p-3 ring-1 ring-zinc-900/[.07] transition hover:ring-zinc-900/20 has-[:checked]:bg-indigo-50/60 has-[:checked]:ring-indigo-500/40"
                >
                  <input type="checkbox" name="methods" value={m.id} id={`method-${m.id}`} defaultChecked={store.paymentMethods.includes(m.id)} className="mt-0.5 h-4 w-4 accent-indigo-600" />
                  <span>
                    <span className="block text-sm font-medium">{m.label}</span>
                    <span className="block text-xs text-zinc-500">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </DirtyForm>
        </Card>
      )}

      {(!connected || sp.edit === "1") && (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Card icon={KeyRound} title="Où trouver la clé API ?">
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
          <Card brand="whop" title="Connecter Whop">
            <DirtyForm label="Connexion Whop" action={connectWhopAction.bind(null, store.id)} className="space-y-4">
              <div>
                <Label htmlFor="apiKey">Clé API Whop ({env})</Label>
                <Input id="apiKey" name="apiKey" type="password" autoComplete="off" required placeholder="apik_…" />
              </div>
              <SubmitButton className="w-full">Connecter et configurer automatiquement</SubmitButton>
              <p className="text-xs text-zinc-500">La clé et le secret du webhook sont chiffrés avant d&apos;être enregistrés.</p>
            </DirtyForm>
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
      <dd className="font-mono text-xs break-all text-zinc-800">{v ?? <span className="font-sans text-zinc-500">Non renseigné</span>}</dd>
    </div>
  );
}
