import type { Metadata } from "next";
import { Globe2, KeyRound, Mail, Smartphone, Wallet } from "lucide-react";
import { notFound } from "next/navigation";
import { DirtyForm } from "@/components/dashboard/DirtyForm";
import { requireStoreAccess, roleCan } from "@/lib/access";
import { OwnerOnlyNote } from "@/components/dashboard/OwnerOnly";
import { daysAgo, tzOf } from "@/lib/time";
import { db } from "@/lib/db";
import { applePayDomainStatuses, OPTIONAL_PAYMENT_METHODS, whopCustomerEmailsStatus, whopEmailsControls, whopProductTitle, whopSupportEmailsMessage, whopWebhookUrl, WHOP_WEBHOOK_EVENTS } from "@/lib/whop";
import { checkoutHostOf } from "@/lib/checkout-domain";
import { Badge, Card, CopyButton, Flash, Input, Label, PageHeader, SubmitButton, Textarea, buttonClass } from "@/components/ui";
import { CopyField } from "@/components/dashboard/CopyField";
import { env as appEnv } from "@/lib/env";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { formatDate, formatDateTime } from "@/components/dashboard/format";
import { paypalHiddenLines, paypalRefusals } from "@/lib/checkout";
import {
  connectWhopAction,
  disconnectWhopAction,
  reactivatePaypalAction,
  refreshWhopWebhookAction,
  savePaymentMethodsAction,
  setupApplePayAction,
  setWhopCustomerEmailsAction,
} from "../../../../actions";

export const metadata: Metadata = { title: "Whop" };

export default async function WhopPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; edit?: string; emails?: string }>;
}) {
  const { storeId } = await params;
  const { user } = await requireStoreAccess(storeId, "view");
  // The Whop connection (API key) is the account owner's; so is the Apple Pay file, which serves
  // every store (an owner with every store).
  const isOwner = roleCan(user.role, "owner");
  const canApplePayFile = isOwner && user.allStores;
  const sp = await searchParams;
  const [store, applePayFile, methodsRejected, paypalHidden, lastEmailsEvent] = await Promise.all([
    db.store.findUnique({ where: { id: storeId } }),
    db.appSetting.findUnique({ where: { key: "apple_pay_domain_association" } }),
    // Recent rejection of the optional methods (last 7 days).
    db.eventLog.findFirst({ where: { storeId, kind: "payment_methods.rejected", createdAt: { gt: daysAgo(7) } }, orderBy: { createdAt: "desc" }, select: { createdAt: true, data: true } }),
    // PayPal express hidden because Whop refused it (24 h hold) or said it's off, by currency.
    paypalRefusals(storeId),
    // Last switch of Whop's buyer e-mails (or Whop's refusal of it), last 7 days.
    db.eventLog.findFirst({
      where: { storeId, kind: { in: ["whop.customer_emails", "whop.customer_emails_refused"] }, createdAt: { gt: daysAgo(7) } },
      orderBy: { createdAt: "desc" },
      select: { kind: true },
    }),
  ]);
  if (!store) notFound();
  const connected = !!store.whopConnectedAt;
  const emailsRefused = sp.emails === "refused" || lastEmailsEvent?.kind === "whop.customer_emails_refused";
  // Where buyers pay: the store's verified checkout domain (checkout.seyuna.com), else APP_URL's host.
  const appHost = new URL(appEnv.appUrl).hostname;
  const checkoutHost = checkoutHostOf(store);
  const applePayHosts = [...new Set([checkoutHost, appHost])];
  const [applePay, whopEmails] = await Promise.all([
    connected && applePayFile ? applePayDomainStatuses(store, applePayHosts) : null,
    // Whop's own buyer e-mails (account-wide): true = Whop sends its receipt too, null = unknown (cached).
    connected ? whopCustomerEmailsStatus(store) : null,
  ]);
  const env = store.testMode ? "sandbox" : "production";
  const emailsControls = whopEmailsControls(whopEmails);

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
            <Info k="Produit Whop" v={store.whopProductId} />
            <Info k="Webhook" v={store.whopWebhookId} />
          </dl>
          <p className="mb-5 text-xs text-zinc-500" data-testid="whop-product-name">
            Le produit Whop est renommé automatiquement au nom de votre boutique Shopify (« {whopProductTitle(store.name)} ») : c&apos;est ce nom que vos clients voient sur le reçu et le relevé Whop. Il suit le nom de la boutique s&apos;il change.
          </p>
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
            {isOwner && (
              <a href="?edit=1" className={buttonClass("secondary")}>
                Changer de clé API
              </a>
            )}
            {isOwner && (
              <form action={refreshWhopWebhookAction.bind(null, store.id)}>
                <SubmitButton variant="secondary" title="À faire après une mise à jour de l'app : ajoute les nouveaux événements (alertes de fraude…)">
                  Mettre à jour le webhook
                </SubmitButton>
              </form>
            )}
            {isOwner && (
              <form action={disconnectWhopAction.bind(null, store.id)}>
                <ConfirmButton
                  title="Déconnecter Whop ?"
                  description="Le checkout Whop sera désactivé et vos clients repasseront par le checkout Shopify. Le webhook et le produit Whop de la boutique seront retirés de Whop."
                  confirmLabel="Déconnecter"
                >
                  Déconnecter
                </ConfirmButton>
              </form>
            )}
          </div>
          {!isOwner && <OwnerOnlyNote className="mt-3">changer de clé API, mettre à jour le webhook (il utilise la clé API Whop) ou déconnecter Whop.</OwnerOnlyNote>}
        </Card>
      )}

      {connected && (
        <Card
          id="whop-emails"
          icon={Mail}
          iconColor="#0f766e"
          title="E-mails envoyés par Whop à vos clients"
          description="Whop peut envoyer son propre reçu en plus de la confirmation de commande de Shopify : vos clients reçoivent alors deux e-mails."
          actions={
            <Badge color={whopEmails === false ? "green" : whopEmails ? "amber" : "zinc"}>{whopEmails === false ? "Coupés" : whopEmails ? "Activés" : "État inconnu"}</Badge>
          }
          className="mb-6"
        >
          <p className="text-sm text-zinc-700" data-testid="whop-emails-status">
            {whopEmails === false
              ? "Whop n'envoie pas d'e-mail à vos clients : ils reçoivent uniquement la confirmation de Shopify."
              : whopEmails
                ? "Whop envoie son reçu à vos clients, en plus de la confirmation de Shopify."
                : "Whop n'a pas indiqué l'état de ce réglage pour l'instant (rechargez la page plus tard)."}
          </p>
          <p className="mt-2 text-xs text-zinc-500">Ce réglage concerne tout votre compte Whop, pas seulement cette boutique.</p>
          {isOwner ? (
            <div className="mt-4 flex flex-wrap items-center gap-3" data-testid="whop-emails-actions">
              {emailsControls.main === "off" ? (
                <form action={setWhopCustomerEmailsAction.bind(null, store.id, false)}>
                  <ConfirmButton
                    title="Couper les e-mails Whop ?"
                    description="Ce réglage s'applique à tout votre compte Whop : les acheteurs de vos autres produits Whop ne recevront plus non plus les e-mails de Whop. Vos clients reçoivent déjà la confirmation de Shopify."
                    confirmLabel="Couper les e-mails Whop"
                    variant="secondary"
                    tone="default"
                  >
                    Couper les e-mails Whop
                  </ConfirmButton>
                </form>
              ) : (
                <form action={setWhopCustomerEmailsAction.bind(null, store.id, true)}>
                  <SubmitButton variant="secondary">Réactiver les e-mails Whop</SubmitButton>
                </form>
              )}
              {emailsControls.link === "on" && (
                // Unknown state: re-enabling stays possible, discreetly (the double e-mail is the usual problem).
                <form action={setWhopCustomerEmailsAction.bind(null, store.id, true)}>
                  <button type="submit" className="text-xs text-zinc-500 underline underline-offset-2 hover:text-zinc-800">
                    Réactiver
                  </button>
                </form>
              )}
            </div>
          ) : (
            <OwnerOnlyNote className="mt-3">couper ou réactiver les e-mails de Whop (réglage de tout le compte Whop).</OwnerOnlyNote>
          )}
          {emailsRefused && whopEmails !== false && (
            <div className="mt-4 rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-900 ring-1 ring-amber-600/20" data-testid="whop-emails-refused">
              <p className="font-medium">Whop n&apos;a pas accepté le changement depuis l&apos;app. Deux solutions :</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-5">
                <li>
                  Ouvrez{" "}
                  <a href={store.testMode ? "https://sandbox.whop.com/dashboard" : "https://whop.com/dashboard"} target="_blank" rel="noreferrer" className="font-medium underline">
                    votre dashboard Whop
                  </a>{" "}
                  → <strong>Paramètres</strong> et cherchez les e-mails envoyés aux clients (reçus de paiement) : désactivez-les.
                </li>
                <li>Si l&apos;option n&apos;y figure pas, écrivez au support Whop (chat en bas à droite du dashboard Whop) avec le message ci-dessous.</li>
                <li>Une fois fait, rechargez cette page : l&apos;état passe à « Coupés » (jusqu&apos;à 10 minutes).</li>
              </ol>
              <div className="mt-3">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-amber-900">Message pour le support Whop</span>
                  <CopyButton value={whopSupportEmailsMessage(store.whopAccountId)} />
                </div>
                <pre className="rounded-md bg-white/70 p-2.5 font-sans text-xs whitespace-pre-wrap text-zinc-800 ring-1 ring-amber-600/15">{whopSupportEmailsMessage(store.whopAccountId)}</pre>
              </div>
            </div>
          )}
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
            {canApplePayFile ? (
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
            ) : (
              <div className="space-y-3">
                <OwnerOnlyNote>le fichier Apple Pay sert à toutes les boutiques du compte : seul le propriétaire (accès à toutes les boutiques) l&apos;installe.</OwnerOnlyNote>
                {/* The file installed, registering this store's own domain stays open to its admins. */}
                {applePayFile && (
                  <form action={setupApplePayAction.bind(null, store.id)}>
                    <SubmitButton variant="secondary">Vérifier le domaine</SubmitButton>
                  </form>
                )}
              </div>
            )}
            {applePay && (
              <ul aria-label="État Apple Pay par domaine" className="mt-4 space-y-1.5 text-sm">
                {applePayHosts.map((h) => (
                  <li key={h} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 font-mono text-xs break-all text-zinc-700">
                      {h}
                      {h === checkoutHost && applePayHosts.length > 1 ? " (domaine du checkout)" : ""}
                    </span>
                    <Badge color={applePay[h] === "verified" ? "green" : applePay[h] === "absent" ? "zinc" : "amber"}>
                      {applePay[h] === "verified" ? "Vérifié" : applePay[h] === "absent" ? "Non enregistré" : "En attente Apple"}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card icon={Wallet} iconColor="#0ea5e9" title="PayPal, Google Pay & autres" description="Proposés automatiquement dans le formulaire de paiement dès qu'ils sont actifs sur votre compte Whop.">
            {paypalHidden.length > 0 && (
              <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-600/20" data-testid="paypal-hidden">
                <p>Bouton PayPal express masqué :</p>
                {/* Each currency with its own state and date (refusals differ per currency). */}
                <ul className="mt-1 list-disc space-y-0.5 pl-5">
                  {paypalHiddenLines(paypalHidden, (d) => formatDateTime(d, false, tzOf(store))).map((line, i) => (
                    <li key={paypalHidden[i].currency}>{line}</li>
                  ))}
                </ul>
                <p className="mt-1">Une fois PayPal actif dans Whop, réactivez-le sans attendre.</p>
                <form action={reactivatePaypalAction.bind(null, store.id)} className="mt-2">
                  <SubmitButton variant="secondary">Réactiver PayPal</SubmitButton>
                </form>
              </div>
            )}
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
              <li>Collez-la ici. On crée automatiquement le produit caché (renommé automatiquement au nom de votre boutique Shopify, celui que vos clients voient sur le reçu Whop) et le webhook : rien à configurer dans Whop.</li>
            </ol>
            <p className="mt-4 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
              La boutique est en mode <strong>{store.testMode ? "test" : "production"}</strong> : utilisez une clé{" "}
              {store.testMode ? "sandbox" : "de production"}. Le mode se change dans Réglages.
            </p>
          </Card>
          <Card brand="whop" title="Connecter Whop">
            {isOwner ? (
              <DirtyForm label="Connexion Whop" action={connectWhopAction.bind(null, store.id)} className="space-y-4">
                <div>
                  <Label htmlFor="apiKey">Clé API Whop ({env})</Label>
                  <Input id="apiKey" name="apiKey" type="password" autoComplete="off" required placeholder="apik_…" />
                </div>
                <SubmitButton className="w-full">Connecter et configurer automatiquement</SubmitButton>
                <p className="text-xs text-zinc-500">La clé et le secret du webhook sont chiffrés avant d&apos;être enregistrés.</p>
              </DirtyForm>
            ) : (
              <OwnerOnlyNote>seul le propriétaire peut enregistrer la clé API Whop et connecter le compte.</OwnerOnlyNote>
            )}
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
