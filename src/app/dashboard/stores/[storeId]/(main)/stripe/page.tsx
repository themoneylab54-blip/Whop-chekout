import type { Metadata } from "next";
import { ArrowLeftRight, FlaskConical, KeyRound, Route, Smartphone } from "lucide-react";
import { notFound } from "next/navigation";
import { DirtyForm } from "@/components/dashboard/DirtyForm";
import { requireAdmin } from "@/lib/auth";
import { tzOf } from "@/lib/time";
import { db } from "@/lib/db";
import { Badge, Card, Flash, PageHeader, SubmitButton, buttonClass } from "@/components/ui";
import { CopyField } from "@/components/dashboard/CopyField";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { formatDate, formatDateTime } from "@/components/dashboard/format";
import { PAYMENT_MODE_LABELS, providerConnected, storeLive, stripeUnusableReason } from "@/lib/payment-provider";
import { missingStripeEnv, stripeConfigured, stripeEnvNames, stripeModeOf } from "@/lib/stripe-config";
import {
  retrieveAccount,
  stripeDomainStatuses,
  stripeRedirectUri,
  stripeWalletHosts,
  stripeWebhookStatus,
  stripeWebhookUrl,
  STRIPE_PAGE_CALL,
  STRIPE_WEBHOOK_EVENTS,
  type StripeDomainState,
} from "@/lib/stripe";
import { applyChargesEnabled, disconnectBlockMessage, stripeConnectionMode, stripeDisconnectBlockers } from "@/lib/stripe-connection";
import { log } from "@/lib/log";
import { disconnectStripeAction, registerStripeDomainsAction, repairStripeWebhookAction, savePaymentModeAction } from "../../../../actions";

export const metadata: Metadata = { title: "Stripe" };

const MODES = [
  {
    id: "whop_primary",
    hint: "Recommandé. Whop encaisse comme aujourd'hui ; si Whop tombe, Stripe prend le relais sur la même page, sans que le client s'en aperçoive.",
  },
  { id: "stripe_primary", hint: "Stripe encaisse d'abord ; Whop ne sert que si Stripe ne répond plus." },
  { id: "stripe_only", hint: "Seul Stripe encaisse. Si Stripe tombe, vos clients passent par le checkout Shopify." },
] as const;

/** Journal lines of the switches between processors (and to Shopify's checkout). */
const SWITCH_KINDS = [
  "checkout.provider_switched",
  "checkout.provider_test",
  "payment_mode.changed",
  "store.mode_changed",
  "stripe.connected",
  "stripe.disconnected",
  "stripe.deauthorized",
  "stripe.webhook_setup_failed",
  "stripe.webhook_repaired",
  "stripe.charges_disabled",
  "stripe.charges_enabled",
];

export default async function StripePage({ params, searchParams }: { params: Promise<{ storeId: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  await requireAdmin();
  const { storeId } = await params;
  const sp = await searchParams;
  const [store, switches] = await Promise.all([
    db.store.findUnique({ where: { id: storeId } }),
    db.eventLog.findMany({
      where: { storeId, OR: [{ kind: { in: SWITCH_KINDS } }, { kind: { startsWith: "fallback." } }] },
      orderBy: { createdAt: "desc" },
      take: 15,
      select: { id: true, createdAt: true, level: true, message: true },
    }),
  ]);
  if (!store) notFound();
  const tz = tzOf(store);
  const mode = stripeModeOf(store);
  const configured = stripeConfigured(mode);
  const connected = !!store.stripeAccountId && !!store.stripeConnectedAt;
  const hosts = connected ? stripeWalletHosts(store) : [];
  // Apple Pay domains are read / registered with the keys of the store's mode: only when the connection
  // covers that mode (a test-mode connection can't be reached with the live keys).
  const walletReady = connected && configured && (store.testMode || store.stripeLivemode === true);
  // Live details from Stripe (short timeout, no retry: never block the page; shown as unknown when
  // Stripe doesn't answer), the webhook's state and what a disconnect would cut short.
  // The account is read with the keys of the mode it was connected in (a live connection stays
  // readable after the store switched to test mode).
  const connectionMode = stripeConnectionMode(store);
  const [account, domains, webhook, blockers] = await Promise.all([
    connected && stripeConfigured(connectionMode)
      ? retrieveAccount(store.stripeAccountId!, connectionMode, STRIPE_PAGE_CALL).catch((err) => {
          log.warn("stripe.account_read_failed", "Stripe account details unavailable", { storeId, err });
          return null;
        })
      : null,
    walletReady ? stripeDomainStatuses(store, hosts, STRIPE_PAGE_CALL).catch((): Record<string, StripeDomainState> | null => null) : null,
    connected && configured ? stripeWebhookStatus(mode, STRIPE_PAGE_CALL).catch(() => null) : null,
    connected ? stripeDisconnectBlockers(store.id) : null,
  ]);
  // Stripe's answer refreshes whether the account can charge (journaled when it changed).
  if (account && connected) await applyChargesEnabled(store, account.chargesEnabled, "page").catch(() => false);
  // The account's name too (saved without it when Stripe didn't answer at connection time, or renamed since).
  if (account && connected && account.id === store.stripeAccountId && account.name && account.name !== store.stripeAccountName) {
    await db.store.updateMany({ where: { id: store.id, stripeAccountId: account.id }, data: { stripeAccountName: account.name } }).catch(() => undefined);
  }
  const chargesEnabled = account?.chargesEnabled ?? store.stripeChargesEnabled;
  const current = { ...store, stripeChargesEnabled: chargesEnabled };
  const usable = providerConnected(current, "stripe");
  const unusable = stripeUnusableReason(current);
  const blockedMessage = blockers ? disconnectBlockMessage(blockers) : null;
  // Hand-made: missing only when Stripe answered that no enabled endpoint is at this URL.
  const webhookMissing = !!webhook && (webhook.manual ? webhook.manualFound === false : !webhook.stored);
  // What a « Déconnecter » leaves: Whop able to charge, or nothing (the checkout goes back to Shopify's).
  const whopLeft = providerConnected(store, "whop");

  return (
    <>
      <PageHeader brand="stripe" title="Stripe" description="Deuxième moyen d'encaisser : si Whop tombe, Stripe prend le relais sur la même page de paiement. Votre compte Stripe, vos fonds." />
      {/* Both can come back at once (e.g. domains registered, webhook to repair): each shown in its own tone. */}
      <Flash ok={sp.ok} />
      <Flash error={sp.error} />

      {!configured && (
        <Card icon={KeyRound} iconColor="#635BFF" title="Stripe n'est pas encore activé sur le serveur" className="mb-6" actions={<Badge color="amber">À configurer</Badge>}>
          <p className="mb-3 text-sm text-zinc-700">
            À faire une seule fois par la personne qui gère l&apos;application (pas par boutique). La boutique est en mode{" "}
            <strong>{mode === "test" ? "test" : "production"}</strong> : ce sont les clés {mode === "test" ? "de test" : "live"} qui manquent.
          </p>
          <ol className="list-decimal space-y-2 pl-5 text-sm text-zinc-700">
            <li>
              Dans Stripe (le compte de la plateforme), activez <strong>Connect</strong>, puis <strong>Paramètres → Connect → OAuth</strong> : copiez le{" "}
              <strong>client_id</strong> (commence par <code className="font-mono text-xs">ca_</code>) et ajoutez cette adresse de redirection :
              <div className="mt-2">
                <CopyField label="URL de redirection OAuth" value={stripeRedirectUri()} />
              </div>
            </li>
            <li>
              Dans Vercel → <strong>Settings → Environment Variables</strong>, ajoutez (jamais dans un message ou un e-mail) :
              <ul className="mt-1.5 flex flex-wrap gap-1.5">
                {missingStripeEnv(mode).map((name) => (
                  <li key={name} className="rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-[11px] text-zinc-700 ring-1 ring-zinc-900/5 ring-inset">
                    {name}
                  </li>
                ))}
              </ul>
              <p className="mt-1.5 text-xs text-zinc-500">
                Clé secrète (<code className="font-mono">sk_…</code>) et clé publiable (<code className="font-mono">pk_…</code>) : Stripe → Développeurs → Clés API.
              </p>
            </li>
            <li>Redéployez l&apos;application, puis revenez ici : le bouton « Se connecter avec Stripe » apparaîtra.</li>
          </ol>
          <p className="mt-4 rounded-lg bg-zinc-50 p-3 text-xs text-zinc-600">
            Le webhook Stripe est créé automatiquement à la première connexion. <code className="font-mono">{stripeEnvNames(mode).webhookSecret}</code> n&apos;est utile que si vous
            créez le webhook vous-même.
          </p>
        </Card>
      )}

      {configured && !connected && (
        <Card brand="stripe" title="Connecter votre compte Stripe" className="mb-6" actions={<Badge color="zinc">Non connecté</Badge>}>
          <ul className="mb-5 list-disc space-y-1.5 pl-5 text-sm text-zinc-700">
            <li>Vous êtes redirigé vers Stripe : connectez-vous (ou créez un compte), puis acceptez.</li>
            <li>Les paiements arrivent directement sur votre compte Stripe, avec vos frais Stripe habituels.</li>
            <li>Rien d&apos;autre à configurer : le webhook et Apple Pay sont réglés automatiquement.</li>
          </ul>
          {/* A POST (Origin checked): no link elsewhere can start a connection; the route redirects to Stripe. */}
          <form action="/api/stripe/connect/start" method="post">
            <input type="hidden" name="store" value={store.id} />
            <button type="submit" className={buttonClass("primary")}>
              Se connecter avec Stripe
            </button>
          </form>
          <p className="mt-3 text-xs text-zinc-500">Mode {mode === "test" ? "test : utilisez un compte Stripe en mode test" : "production"}. Le mode se change dans Réglages.</p>
        </Card>
      )}

      {connected && (
        <Card
          brand="stripe"
          title="Compte Stripe connecté"
          description={`Connecté le ${formatDate(store.stripeConnectedAt!, tz)}`}
          actions={<Badge color={usable ? "green" : "amber"}>{usable ? "Connecté" : chargesEnabled === false ? "Paiements pas encore activés" : "Inutilisable"}</Badge>}
          className="mb-6"
        >
          {!usable && unusable && <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-600/20">{unusable}</p>}
          <dl className="mb-5 grid grid-cols-[minmax(0,1fr)] gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Info k="Compte" v={account?.name ?? store.stripeAccountName} />
            <Info k="Identifiant" v={store.stripeAccountId} mono />
            <Info k="Mode" v={store.stripeLivemode === true ? "Live" : store.stripeLivemode === false ? "Test" : "—"} />
            <div>
              <dt className="text-xs text-zinc-500">Paiements</dt>
              <dd className="mt-0.5">
                {account == null ? (
                  <span className="text-xs text-zinc-500">Stripe ne répond pas</span>
                ) : account.chargesEnabled ? (
                  <Badge color="green">Activés</Badge>
                ) : (
                  <Badge color="amber">À activer dans Stripe</Badge>
                )}
              </dd>
            </div>
          </dl>
          {configured && (
            <div className="mb-5 rounded-lg bg-zinc-50 p-3 ring-1 ring-zinc-900/5">
              <dl className="grid grid-cols-[minmax(0,1fr)] gap-3 text-sm sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-xs text-zinc-500">Liaison Stripe (webhook)</dt>
                  <dd className="mt-0.5">
                    {webhook?.manual ? (
                      webhook.manualFound === false ? (
                        <Badge color="amber">Créé à la main : introuvable chez Stripe</Badge>
                      ) : webhook.manualFound ? (
                        <Badge color="green">Créé à la main</Badge>
                      ) : (
                        <Badge color="zinc">Créé à la main (non vérifié)</Badge>
                      )
                    ) : webhook?.stored ? (
                      <Badge color="green">En place</Badge>
                    ) : (
                      <Badge color="amber">Absente</Badge>
                    )}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-xs text-zinc-500">Dernier événement Stripe reçu</dt>
                  <dd className="mt-0.5 text-sm text-zinc-800">
                    {store.lastStripeWebhookAt ? formatDateTime(store.lastStripeWebhookAt, false, tz) : <span className="text-zinc-500">Aucun pour l&apos;instant</span>}
                  </dd>
                </div>
              </dl>
              {webhookMissing && (
                <p className="mt-3 text-sm text-amber-900">
                  Sans cette liaison, Stripe ne prévient pas l&apos;application des paiements : ils ne sont confirmés que par la vérification périodique (quelques minutes de retard).
                </p>
              )}
              <form action={repairStripeWebhookAction.bind(null, store.id)} className="mt-3">
                <SubmitButton variant="secondary">Réparer la liaison Stripe</SubmitButton>
              </form>
            </div>
          )}
          <details className="mb-5 text-sm">
            <summary className="cursor-pointer text-xs font-medium text-zinc-600 hover:text-zinc-900">Détails techniques</summary>
            <div className="mt-3">
              <p id="stripe-events" className="mb-1.5 text-xs text-zinc-500">
                Événements écoutés ({STRIPE_WEBHOOK_EVENTS.length})
              </p>
              <ul aria-labelledby="stripe-events" className="mb-4 flex flex-wrap gap-1.5">
                {STRIPE_WEBHOOK_EVENTS.map((e) => (
                  <li key={e} className="max-w-full rounded-md bg-zinc-100 px-2 py-0.5 font-mono text-[11px] break-all text-zinc-700 ring-1 ring-zinc-900/5 ring-inset">
                    {e}
                  </li>
                ))}
              </ul>
              <CopyField label="URL du webhook (créé automatiquement, commun à toutes les boutiques)" value={stripeWebhookUrl()} />
            </div>
          </details>
          {blockedMessage && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-600/20">{blockedMessage}</p>}
          <div className="flex flex-wrap gap-2">
            <form action={disconnectStripeAction.bind(null, store.id)}>
              <ConfirmButton
                title="Déconnecter Stripe ?"
                description={
                  <>
                    Stripe ne servira plus à encaisser ni de secours. Le mode de paiement repasse à « Whop principal ».
                    {whopLeft ? "" : " Whop n'étant pas connecté, le checkout sera désactivé : vos clients passeront par le checkout Shopify."} Votre compte Stripe et son argent ne
                    sont pas touchés.
                    <br />
                    <br />
                    Les remboursements et litiges de vos commandes Stripe passées ne seront plus synchronisés automatiquement : suivez-les dans votre dashboard Stripe.
                    {blockedMessage && (
                      <label className="mt-3 flex items-start gap-2 font-medium text-amber-900">
                        <input type="checkbox" name="force" className="mt-0.5 h-4 w-4 accent-red-600" />
                        <span>Déconnecter quand même</span>
                      </label>
                    )}
                  </>
                }
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
          icon={Smartphone}
          iconColor="#0f172a"
          title="Apple Pay & Google Pay (Stripe)"
          description="Les domaines où vos clients paient doivent être enregistrés sur votre compte Stripe pour afficher Apple Pay."
          className="mb-6"
        >
          {!walletReady ? (
            <p className="text-sm text-amber-900">{unusable ?? "Stripe n'est pas utilisable dans le mode actuel de la boutique : voir ci-dessus."}</p>
          ) : hosts.length === 0 ? (
            <p className="mb-4 text-sm text-zinc-600">
              Aucun domaine à enregistrer : le checkout est servi sur une adresse locale. Configurez un domaine du checkout vérifié (Réglages) ou une APP_URL publique.
            </p>
          ) : domains ? (
            <ul aria-label="État Apple Pay par domaine (Stripe)" className="mb-4 space-y-1.5 text-sm">
              {hosts.map((h) => {
                const d = domains[h] ?? { status: "absent", error: null };
                return (
                  <li key={h} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 font-mono text-xs break-all text-zinc-700">{h}</span>
                    <Badge color={d.status === "active" ? "green" : d.status === "absent" ? "zinc" : "amber"}>
                      {d.status === "active" ? "Actif" : d.status === "absent" ? "Non enregistré" : "En attente"}
                    </Badge>
                    {d.error && <span className="w-full text-xs break-words text-amber-800">Stripe : {d.error}</span>}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mb-4 text-sm text-zinc-600">État indisponible : Stripe ne répond pas pour l&apos;instant.</p>
          )}
          {walletReady && (
            <form action={registerStripeDomainsAction.bind(null, store.id)}>
              <SubmitButton variant="secondary">Enregistrer les domaines</SubmitButton>
            </form>
          )}
        </Card>
      )}

      <Card
        id="mode"
        icon={Route}
        iconColor="#635BFF"
        title="Mode de paiement"
        description="Quel processeur encaisse en premier. Le secours ne sert que si le premier ne répond plus ; en dernier recours, vos clients passent par le checkout Shopify."
        className="mb-6"
      >
        {store.providerFailoverAt && (
          <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-600/20">
            Bascule active depuis le {formatDateTime(store.providerFailoverAt, false, tz)}
            {store.providerFailoverReason ? ` : ${store.providerFailoverReason}` : ""}. Les nouveaux paiements passent par le processeur de secours ; retour automatique dès que le
            principal répond.
          </p>
        )}
        {!whopLeft && store.paymentMode !== "stripe_only" && usable && (
          <p className="mb-4 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900 ring-1 ring-sky-600/20">
            {storeLive(current)
              ? "Whop n'est pas connecté : Stripe encaisse tous les paiements, sans secours (en dernier recours, vos clients passent par le checkout Shopify)."
              : "Whop n'est pas connecté : Stripe encaissera seul, sans secours, une fois le checkout mis en ligne (Vue d'ensemble)."}
          </p>
        )}
        <DirtyForm label="Mode de paiement" action={savePaymentModeAction.bind(null, store.id)} className="space-y-4">
          <fieldset>
            <legend className="sr-only">Mode de paiement</legend>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-2 lg:grid-cols-3 [&>*]:min-w-0">
              {MODES.map((m) => {
                const needsStripe = m.id !== "whop_primary";
                const disabled = needsStripe && !usable && store.paymentMode !== m.id;
                return (
                  <label
                    key={m.id}
                    htmlFor={`mode-${m.id}`}
                    className={`flex items-start gap-2.5 rounded-xl p-3 ring-1 ring-zinc-900/[.07] transition has-[:checked]:bg-indigo-50/60 has-[:checked]:ring-indigo-500/40 ${
                      disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer hover:ring-zinc-900/20"
                    }`}
                  >
                    <input
                      type="radio"
                      name="paymentMode"
                      value={m.id}
                      id={`mode-${m.id}`}
                      defaultChecked={store.paymentMode === m.id}
                      disabled={disabled}
                      className="mt-0.5 h-4 w-4 accent-indigo-600"
                    />
                    <span>
                      <span className="block text-sm font-medium">
                        {PAYMENT_MODE_LABELS[m.id]}
                        {m.id === "whop_primary" ? " (recommandé)" : ""}
                      </span>
                      <span className="block text-xs text-zinc-500">{m.hint}</span>
                      {disabled && <span className="mt-1 block text-xs font-medium text-amber-800">{connected && chargesEnabled === false ? "Paiements Stripe pas encore activés." : "Connectez Stripe pour choisir ce mode."}</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>
        </DirtyForm>
      </Card>

      {usable && (
        <Card
          id="test"
          icon={FlaskConical}
          iconColor="#635BFF"
          title="Tester le secours"
          description="Ouvre votre checkout, tel que vos clients le voient, forcé sur Stripe, avec un produit d'un panier récent."
          className="mb-6"
        >
          <p className="mb-4 text-sm text-zinc-600">
            {store.testMode
              ? "Mode test : payez avec une carte de test Stripe (4242 4242 4242 4242, date future, CVC au choix). La commande Shopify créée est une commande de test."
              : "Mode live : le paiement est réel. Remboursez-le ensuite depuis la commande."}
          </p>
          <form action="/api/stripe/test-checkout" method="post" target="_blank">
            <input type="hidden" name="store" value={store.id} />
            <SubmitButton variant="secondary" confirm={store.testMode ? undefined : "Mode live : ce paiement de test sera réel. Continuer ?"}>
              Tester le secours (s&apos;ouvre dans un nouvel onglet)
            </SubmitButton>
            <p className="mt-2 text-xs text-zinc-500">
              Si le test ne peut pas démarrer, le nouvel onglet affiche cette page avec la raison. Ce paiement n&apos;est compté ni dans vos statistiques ni dans vos conversions publicitaires.
            </p>
          </form>
        </Card>
      )}

      <Card icon={ArrowLeftRight} iconColor="#0ea5e9" title="Journal des bascules" description="Passages d'un processeur à l'autre, vers le checkout Shopify de secours, et changements de connexion.">
        {switches.length === 0 ? (
          <p className="text-sm text-zinc-600">Aucune bascule pour l&apos;instant.</p>
        ) : (
          <ul className="divide-y divide-zinc-100">
            {switches.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0 sm:flex-row sm:items-baseline sm:gap-3">
                <time dateTime={e.createdAt.toISOString()} className="shrink-0 text-xs text-zinc-500 tabular-nums">
                  {formatDateTime(e.createdAt, false, tz)}
                </time>
                <span className={`min-w-0 text-sm break-words ${e.level === "error" ? "text-red-700" : e.level === "warn" ? "text-amber-800" : "text-zinc-700"}`}>{e.message}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

function Info({ k, v, mono }: { k: string; v: string | null; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-zinc-500">{k}</dt>
      <dd className={`${mono ? "font-mono text-xs" : "text-sm"} break-all text-zinc-800`}>{v ?? <span className="font-sans text-zinc-500">Non renseigné</span>}</dd>
    </div>
  );
}
