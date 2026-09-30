import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AlertTriangle, BellRing, Mail, Check, Copy, LifeBuoy, Minus, PiggyBank, Settings, ShieldCheck, ShoppingCart, Store, Trash2 } from "lucide-react";
import { notFound } from "next/navigation";
import { DirtyForm, SaveAllWith } from "@/components/dashboard/DirtyForm";
import { requireStoreAccess, roleCan } from "@/lib/access";
import { OwnerOnlyNote } from "@/components/dashboard/OwnerOnly";
import { db } from "@/lib/db";
import { Card, Flash, Input, Label, PageHeader, Select, SubmitButton, Toggle } from "@/components/ui";
import { TIME_ZONES, tzOf } from "@/lib/time";
import { EU_VAT_AREA, STANDARD_VAT_RATES } from "@/lib/vat";
import { countryName } from "@/components/dashboard/countries";
import { operatorMailer } from "@/lib/notify";
import { MoneyInput } from "@/components/dashboard/MoneyInput";
import { centsToField } from "@/components/dashboard/money";
import { SectionNav, type Section } from "@/components/dashboard/SectionNav";
import { formatDateTime } from "@/components/dashboard/format";
import {
  clearFallbackAction,
  cloneStoreAction,
  deleteStoreAction,
  saveAlertsAction,
  saveCheckoutOptionsAction,
  saveFallbackAction,
  saveMarginsAction,
  saveOperatorMailAction,
  saveSettingsBatchAction,
  saveSettingsAction,
  saveShieldAction,
  saveCheckoutDomainAction,
  testAlertAction,
  verifyCheckoutDomainAction,
} from "../../../../actions";
import { CheckoutDomainCard } from "@/components/dashboard/CheckoutDomainCard";
import { env } from "@/lib/env";
import { vercelConfig } from "@/lib/vercel-domains";
import { SecretInput } from "@/components/dashboard/SecretInput";
import { OwnerBoundInput } from "@/components/dashboard/OwnerBoundInput";
import { ownerBoundLocked } from "@/lib/owner-bound";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { CostsSettingsCard } from "@/components/dashboard/CostsSettingsCard";
import { AttributionSettingsCard } from "@/components/dashboard/AttributionSettingsCard";

/** Countries a store can be established in for VAT (EU member states and Monaco), French first. */
const HOME_COUNTRIES = ["FR", ...[...EU_VAT_AREA].filter((c) => c !== "FR" && STANDARD_VAT_RATES[c] != null).sort((a, b) => countryName(a).localeCompare(countryName(b), "fr"))];

export const metadata: Metadata = { title: "Réglages" };

export default async function SettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { storeId } = await params;
  const { user } = await requireStoreAccess(storeId, "view");
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId } });
  const paidOrders = await db.checkoutSession.count({ where: { storeId, status: "PAID" } });
  if (!store) notFound();
  // API keys, the operator's mail account, deleting the store and a mode switch that resets the
  // payment connections are the account owner's (the actions refuse the others).
  const isOwner = roleCan(user.role, "owner");
  const modeLocked = !isOwner && !!(store.whopConnectedAt || store.stripeAccountId);
  const operator = await operatorMailer();
  const alertChannel = !!(store.alertEmail && store.resendApiKey) || !!(store.telegramBotToken && store.telegramChatId);

  return (
    <>
      <PageHeader
        icon={Settings}
        iconColor="#71717a"
        title="Réglages"
        description="Modifiez un réglage : la barre « Enregistrer » apparaît en bas de l'écran et enregistre toutes les sections modifiées."
      />
      <Flash ok={sp.ok} error={sp.error} />
      <SaveAllWith action={saveSettingsBatchAction.bind(null, store.id)} />
      <div className="lg:grid lg:grid-cols-[168px_minmax(0,1fr)] lg:gap-10">
        <SectionNav sections={SECTIONS} label="Sections des réglages" />
        <div className="max-w-2xl min-w-0 space-y-6">
          <Anchor id="boutique">
            <Card icon={Store} title="Boutique">
              <DirtyForm label="Boutique" action={saveSettingsAction.bind(null, store.id)} className="space-y-4">
                <div>
                  <Label htmlFor="name">Nom interne</Label>
                  <Input id="name" name="name" defaultValue={store.name} required />
                </div>
                <div>
                  <Label htmlFor="timezone" hint="Jours et heures des analytics, du rapport quotidien, des alertes et de la carte jour × heure">
                    Fuseau horaire
                  </Label>
                  <Select id="timezone" name="timezone" defaultValue={tzOf(store)}>
                    {[...new Set([tzOf(store), ...TIME_ZONES])].map((tz) => (
                      <option key={tz} value={tz}>
                        {tz.replace(/_/g, " ")}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="border-t border-zinc-100">
                  {modeLocked ? (
                    // Switching tears the payment connections down: owner only. The current mode is sent as is.
                    <div className="py-3.5">
                      {store.testMode && <input type="hidden" name="testMode" value="on" />}
                      <p className="text-sm font-medium text-zinc-900">Mode {store.testMode ? "test" : "production"}</p>
                      <OwnerOnlyNote className="mt-2">changer de mode déconnecte Whop et change la connexion Stripe.</OwnerOnlyNote>
                    </div>
                  ) : (
                    <Toggle
                      name="testMode"
                      defaultChecked={store.testMode}
                      label="Mode test"
                      hint="Paiements Whop sandbox (aucun débit réel) et commandes Shopify marquées « test ». Changer de mode demande de reconnecter Whop avec la clé correspondante."
                    />
                  )}
                </div>
              </DirtyForm>
            </Card>
          </Anchor>

          <Anchor id="domaine">
            <CheckoutDomainCard
              store={store}
              appHost={new URL(env.appUrl).hostname}
              vercelAuto={!!vercelConfig()}
              timeZone={tzOf(store)}
              saveAction={saveCheckoutDomainAction.bind(null, store.id)}
              verifyAction={verifyCheckoutDomainAction.bind(null, store.id)}
            />
          </Anchor>

          <Anchor id="checkout">
            <Card
              icon={ShoppingCart}
              iconColor="#6366f1"
              title="Options du checkout"
              description="Codes promo Shopify, devise de paiement et reconnaissance des clients sur un autre appareil."
            >
              <DirtyForm label="Options du checkout" action={saveCheckoutOptionsAction.bind(null, store.id)} className="divide-y divide-zinc-100">
                <Toggle
                  name="shopifyDiscountCodes"
                  defaultChecked={store.shopifyDiscountCodes}
                  label="Accepter les codes promo créés dans Shopify"
                  hint="Un code inconnu de l'onglet Offres est vérifié dans Shopify."
                  more="Remise en % ou montant fixe, livraison gratuite ; minimum, produits/collections, limite d'utilisation, une fois par client. Il apparaît comme code promo sur la commande Shopify. Les remises automatiques Shopify du panier sont aussi reprises telles que Shopify les a calculées."
                />
                <Toggle
                  name="chargeLocalCurrency"
                  defaultChecked={store.chargeLocalCurrency}
                  label="Débiter les clients étrangers dans leur devise"
                  hint={`CHF, GBP, USD… au taux BCE du jour ; vos chiffres restent en ${store.shopCurrency}.`}
                  more={`Suisse (CHF), Royaume-Uni (GBP), Suède, Danemark, Norvège, Pologne, Tchéquie, Hongrie, Roumanie, États-Unis, Canada : le total en ${store.shopCurrency} est converti au taux de référence BCE du jour (arrondi au centime supérieur) et Whop débite dans la devise du client. Commande Shopify, analytics et remboursements restent en ${store.shopCurrency}. Désactivé : le client est débité en ${store.shopCurrency} et voit un montant indicatif dans sa devise.`}
                />
                <Toggle
                  name="returningBuyerCode"
                  defaultChecked={store.returningBuyerCode}
                  label="« Déjà client ? » : code par e-mail"
                  hint="Un code à 6 chiffres remplit l'adresse de sa dernière commande."
                  more="Sur un nouvel appareil, le client saisit son e-mail et reçoit un code à 6 chiffres (valable 10 minutes) qui remplit ses coordonnées et son adresse de sa dernière commande payée. Rien n'est affiché avant la saisie du bon code. Envoi par votre compte Resend (section Alertes), à défaut par celui de l'opérateur (section Réseau)."
                />
                <Toggle
                  name="storeNetwork"
                  defaultChecked={store.storeNetwork}
                  label="Réseau de boutiques"
                  hint="« Déjà client ? » reconnaît aussi les acheteurs de vos autres boutiques du réseau."
                  more="Le code par e-mail retrouve la dernière commande payée du client dans toutes les boutiques de ce compte qui ont activé le réseau (jamais dans une boutique qui ne l'a pas activé). Comme sur une seule boutique, rien n'est révélé avant la saisie du bon code."
                />
                <Toggle
                  name="breaksCombineWithCodes"
                  defaultChecked={store.breaksCombineWithCodes}
                  label="Remises quantité cumulables avec les codes promo"
                  hint="Désactivé : le client a la remise quantité ou le code, la plus avantageuse."
                  more="Les remises quantité comptent comme une remise produit. Un code Shopify suit ses propres règles de cumul (« Combinaisons » dans Shopify : remises produit, commande, livraison) ; un code de l'onglet Offres suit sa case « Cumulable avec les remises quantité ». Quand deux remises ne se cumulent pas, la meilleure pour le client est appliquée, comme sur le checkout Shopify."
                />
              </DirtyForm>
            </Card>
          </Anchor>

          <Anchor id="reseau">
            <Card icon={Mail} iconColor="#0ea5e9" title="Réseau : e-mails clients de l'opérateur" description="Un seul compte Resend pour les e-mails clients de toutes vos boutiques (codes « Déjà client ? », suivi des sinistres).">
              <p className="mb-3 text-sm text-zinc-600">
                {operator
                  ? `Compte de l'opérateur actif (${operator.source === "env" ? "variables d'environnement OPERATOR_RESEND_API_KEY / OPERATOR_EMAIL_FROM" : "réglage enregistré"}) : expéditeur ${operator.from}.`
                  : "Aucun compte de l'opérateur : chaque boutique utilise sa propre clé Resend (section Alertes)."}{" "}
                Une boutique avec sa propre clé l&apos;utilise en priorité.
              </p>
              {operator?.source !== "env" && !isOwner && <OwnerOnlyNote>le compte Resend de l&apos;opérateur sert à toutes les boutiques.</OwnerOnlyNote>}
              {operator?.source !== "env" && isOwner && (
                <form action={saveOperatorMailAction.bind(null, store.id)} className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="operatorResendApiKey" hint="Commence par re_">
                      Clé API Resend de l&apos;opérateur
                    </Label>
                    <SecretInput name="operatorResendApiKey" stored={!!operator} />
                  </div>
                  <div>
                    <Label htmlFor="operatorEmailFrom" hint="Domaine vérifié chez Resend ; le nom affiché est celui de la boutique">
                      Expéditeur
                    </Label>
                    <Input id="operatorEmailFrom" name="operatorEmailFrom" defaultValue={operator?.from ?? ""} placeholder="noreply@mondomaine.fr" autoComplete="off" />
                  </div>
                  <div className="sm:col-span-2">
                    <SubmitButton size="sm">Enregistrer le compte de l&apos;opérateur</SubmitButton>
                  </div>
                </form>
              )}
            </Card>
          </Anchor>

          <Anchor id="secours">
            <Card
              icon={LifeBuoy}
              iconColor="#f59e0b"
              title="Checkout de secours"
              description="Si Whop ne répond plus, vos clients passent automatiquement par le checkout Shopify : aucune vente perdue."
            >
              {store.fallbackActiveAt && (
                <div role="alert" className="mb-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-600/25">
                  <p className="flex items-start gap-2 font-semibold">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                    Checkout Shopify actif depuis le {formatDateTime(store.fallbackActiveAt, false, tzOf(store))}
                  </p>
                  {store.fallbackReason && <p className="mt-1 pl-6 text-amber-800">{store.fallbackReason}</p>}
                  <p className="mt-1 pl-6 text-xs text-amber-800">
                    Le checkout Whop revient tout seul dès qu&apos;il répond. Vous pouvez aussi le réactiver maintenant si le problème est réglé.
                  </p>
                  <form action={clearFallbackAction.bind(null, store.id)} className="mt-3 pl-6">
                    <SubmitButton size="sm">Réactiver maintenant</SubmitButton>
                  </form>
                </div>
              )}
              <DirtyForm label="Checkout de secours" action={saveFallbackAction.bind(null, store.id)} className="space-y-4">
                <div className="border-y border-zinc-100">
                  <Toggle
                    name="autoFallback"
                    defaultChecked={store.autoFallback}
                    label="Basculer automatiquement sur le checkout Shopify"
                    hint="Si 3 clients n'arrivent pas à ouvrir le paiement Whop en 10 minutes, la boutique utilise le checkout Shopify. Une vérification toutes les quelques minutes remet le checkout Whop dès qu'il fonctionne. Vous êtes prévenu par vos alertes."
                  />
                </div>
              </DirtyForm>
            </Card>
          </Anchor>

          <Anchor id="marges">
            <Card
              icon={PiggyBank}
              iconColor="#10b981"
              title="Marges & coûts"
              description="Pour calculer votre bénéfice réel dans Analytics. Rien ne change pour vos clients."
            >
              <DirtyForm label="Marges & coûts" action={saveMarginsAction.bind(null, store.id)} className="space-y-4">
                <div className="max-w-xs">
                  <Label htmlFor="homeCountry" hint="Pays où votre entreprise est immatriculée à la TVA : taux appliqué quand le pays de livraison est inconnu et aux ventes UE sous le seuil OSS">
                    Pays d&apos;établissement (TVA)
                  </Label>
                  <Select id="homeCountry" name="homeCountry" defaultValue={store.homeCountry || "FR"}>
                    {HOME_COUNTRIES.map((cc) => (
                      <option key={cc} value={cc}>
                        {countryName(cc)} ({String(STANDARD_VAT_RATES[cc]).replace(".", ",")} %)
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="divide-y divide-zinc-100 border-y border-zinc-100">
                  <Toggle
                    name="vatExempt"
                    defaultChecked={store.vatExempt}
                    label="Franchise en base de TVA (prix sans TVA)"
                    hint="Micro-entreprise non assujettie : votre chiffre d'affaires n'est pas diminué de la TVA. Sinon, la TVA du pays de livraison est retirée pour calculer le CA hors taxes."
                  />
                  <Toggle
                    name="vatDomesticOnly"
                    defaultChecked={store.vatDomesticOnly}
                    label="Ventes UE sous le seuil OSS (10 000 €) : TVA de votre pays sur toutes les ventes UE"
                    hint="Tant que vos ventes à distance vers les autres pays de l'UE restent sous 10 000 € par an, vous facturez la TVA de votre pays d'établissement partout dans l'UE : le CA hors taxes est calculé avec ce taux au lieu de celui du pays de livraison. Sans effet avec la franchise en base."
                  />
                  <Toggle
                    name="adSpendVatNonReclaimable"
                    defaultChecked={store.adSpendVatNonReclaimable}
                    label="TVA sur la pub non récupérable (franchise en base)"
                    hint="En franchise, la TVA autoliquidée sur les factures Meta, TikTok ou Google (émises depuis l'Irlande) est due sans pouvoir être déduite : les dépenses pub comptent alors 20 % de plus dans Analytics (ROAS, CPA, bénéfice après pub). Sans effet hors franchise."
                  />
                </div>
                <div className="max-w-xs">
                  <Label htmlFor="fulfillmentFee" hint="Emballage, étiquette, préparation… déduit de chaque commande payée">
                    Coût de préparation par commande
                  </Label>
                  <MoneyInput
                    id="fulfillmentFee"
                    name="fulfillmentFee"
                    currency={store.shopCurrency}
                    placeholder="0,00"
                    defaultValue={centsToField(store.fulfillmentFeeCents)}
                  />
                </div>
              </DirtyForm>
            </Card>
          </Anchor>

          <CostsSettingsCard store={store} />
          <AttributionSettingsCard store={store} />

          <Anchor id="alertes">
            <Card
              icon={BellRing}
              iconColor="#f59e0b"
              title="Alertes"
              description="Soyez prévenu tout de suite : commande payée non créée dans Shopify, paiement à vérifier, litige, alerte de fraude, double paiement."
            >
              <DirtyForm label="Alertes" action={saveAlertsAction.bind(null, store.id)} className="space-y-4">
                <div>
                  <Label htmlFor="alertEmail">E-mail d&apos;alerte</Label>
                  <Input id="alertEmail" name="alertEmail" type="email" defaultValue={store.alertEmail ?? ""} placeholder="vous@exemple.fr" />
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="resendApiKey" hint="Pour les alertes par e-mail : resend.com → API Keys">
                      Clé API Resend
                    </Label>
                    <SecretInput name="resendApiKey" stored={!!store.resendApiKey} placeholder="re_…" locked={!isOwner} />
                  </div>
                  <div>
                    <Label htmlFor="emailFrom" hint="Adresse de votre domaine vérifié dans Resend">
                      Expéditeur
                    </Label>
                    <OwnerBoundInput
                      locked={ownerBoundLocked(user.role, !!store.resendApiKey)}
                      id="emailFrom"
                      name="emailFrom"
                      defaultValue={store.emailFrom ?? ""}
                      placeholder="Alertes <alertes@maboutique.fr>"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="telegramBotToken" hint="Créez un bot avec @BotFather, collez son jeton">
                      Jeton du bot Telegram
                    </Label>
                    <SecretInput name="telegramBotToken" stored={!!store.telegramBotToken} placeholder="123456:ABC…" locked={!isOwner} />
                  </div>
                  <div>
                    <Label htmlFor="telegramChatId" hint="Écrivez à @userinfobot pour connaître votre ID">
                      Votre ID Telegram
                    </Label>
                    <OwnerBoundInput
                      locked={ownerBoundLocked(user.role, !!store.telegramBotToken)}
                      id="telegramChatId"
                      name="telegramChatId"
                      defaultValue={store.telegramChatId ?? ""}
                      inputMode="numeric"
                      placeholder="123456789"
                    />
                  </div>
                </div>
              </DirtyForm>
              <form action={testAlertAction.bind(null, store.id)} className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-zinc-100 pt-3">
                <SubmitButton size="sm" variant="secondary" disabled={!alertChannel}>
                  Envoyer une alerte de test
                </SubmitButton>
                {!alertChannel && <span className="text-xs text-zinc-500">Enregistrez d&apos;abord un canal (Telegram ou e-mail + clé Resend).</span>}
              </form>
            </Card>
          </Anchor>

          <Anchor id="litiges">
            <Card
              icon={ShieldCheck}
              iconColor="#10b981"
              title="Bouclier anti-litiges"
              description="Protège votre compte Whop : moins de litiges, et des litiges gagnés plus souvent."
            >
              <DirtyForm label="Bouclier anti-litiges" action={saveShieldAction.bind(null, store.id)} className="space-y-4">
                <div className="divide-y divide-zinc-100 border-y border-zinc-100">
                  <Toggle
                    name="pushTracking"
                    defaultChecked={store.pushTracking}
                    label="Transmettre les numéros de suivi à Whop"
                    hint="Dès qu'une commande est expédiée dans Shopify, son suivi est rattaché au paiement Whop (preuve de livraison)."
                  />
                  <Toggle
                    name="autoDisputeEvidence"
                    defaultChecked={store.autoDisputeEvidence}
                    label="Répondre automatiquement aux litiges"
                    hint="Commande, suivi, acceptation des CGV, IP et adresse sont envoyés comme preuves dès l'ouverture du litige."
                  />
                  <Toggle
                    name="autoRefundFraudAlerts"
                    defaultChecked={store.autoRefundFraudAlerts}
                    label="Rembourser automatiquement les alertes de fraude"
                    hint="Quand la banque signale une fraude probable, rembourser tout de suite évite le litige (frais + taux de litige)."
                  />
                </div>
                <div>
                  <Label
                    htmlFor="statementDescriptor"
                    hint="Affiché « WHOP*VOTRE NOM » (17 caractères après WHOP*). Appliqué aux nouveaux produits Whop et aux offres post-achat."
                  >
                    Libellé sur le relevé bancaire
                  </Label>
                  <Input
                    id="statementDescriptor"
                    name="statementDescriptor"
                    defaultValue={store.statementDescriptor ?? ""}
                    placeholder="MA BOUTIQUE"
                    className="uppercase"
                  />
                </div>
              </DirtyForm>
            </Card>
          </Anchor>

          <Anchor id="dupliquer">
            <Card
              icon={Copy}
              title="Dupliquer la boutique"
              description="Lancez une nouvelle boutique avec les mêmes réglages en quelques secondes, puis connectez-y son Shopify et son Whop."
            >
              <div className="grid grid-cols-[minmax(0,1fr)] gap-4 text-sm sm:grid-cols-2">
                <div>
                  <p className="mb-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Copié</p>
                  <ul className="space-y-1 text-zinc-700">
                    {CLONED.map((x) => (
                      <li key={x} className="flex items-start gap-2">
                        <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" aria-hidden />
                        {x}
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="mb-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Non copié</p>
                  <ul className="space-y-1 text-zinc-700">
                    {NOT_CLONED.map((x) => (
                      <li key={x} className="flex items-start gap-2">
                        <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />
                        {x}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <form action={cloneStoreAction.bind(null, store.id)} className="mt-4 border-t border-zinc-100 pt-4">
                <ConfirmButton
                  variant="secondary"
                  tone="default"
                  title={`Dupliquer « ${store.name} » ?`}
                  description={`Une nouvelle boutique « ${store.name} (copie) » est créée hors ligne, en mode test, avec le design, la livraison, les options, les codes promo, les coûts, les IDs des pixels et les alertes de celle-ci. Shopify, Whop, les jetons des pixels et Mondial Relay restent à connecter ; aucune commande ni statistique n'est copiée. Cette boutique-ci ne change pas.`}
                  confirmLabel="Dupliquer la boutique"
                  className="h-auto max-w-full text-left"
                >
                  <Copy className="h-4 w-4" aria-hidden /> Dupliquer cette configuration vers une nouvelle boutique
                </ConfirmButton>
              </form>
            </Card>
          </Anchor>

          <Anchor id="danger">
            <Card
              icon={Trash2}
              iconColor="#dc2626"
              title="Zone de danger · Supprimer la boutique"
              description="Retire le script Shopify et le webhook Whop, puis efface la boutique de cet outil. Impossible s'il existe des commandes payées : désactivez plutôt le checkout."
            >
              {paidOrders > 0 && (
                <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">
                  {paidOrders} commande{paidOrders > 1 ? "s" : ""} payée{paidOrders > 1 ? "s" : ""} : la boutique ne peut pas être supprimée (ce sont des pièces comptables).
                  Désactivez plutôt le checkout dans « Boutique » ci-dessus.
                </p>
              )}
              {isOwner ? (
                <form action={deleteStoreAction.bind(null, store.id)}>
                  <ConfirmButton
                    disabled={paidOrders > 0}
                    title={`Supprimer définitivement « ${store.name} » ?`}
                    description="Le script Shopify et le webhook Whop sont retirés, puis la boutique et tous ses réglages sont effacés. Cette action est irréversible."
                    confirmLabel="Supprimer la boutique"
                  >
                    <Trash2 className="h-4 w-4" aria-hidden /> Supprimer la boutique
                  </ConfirmButton>
                </form>
              ) : (
                <OwnerOnlyNote>seul le propriétaire peut supprimer une boutique.</OwnerOnlyNote>
              )}
            </Card>
          </Anchor>
        </div>
      </div>
    </>
  );
}

const SECTIONS: Section[] = [
  { id: "boutique", label: "Boutique" },
  { id: "domaine", label: "Domaine du checkout" },
  { id: "checkout", label: "Options du checkout" },
  { id: "reseau", label: "Réseau" },
  { id: "secours", label: "Checkout de secours" },
  { id: "marges", label: "Marges & coûts" },
  { id: "couts", label: "Coûts", optional: true },
  { id: "attribution", label: "Attribution" },
  { id: "alertes", label: "Alertes" },
  { id: "litiges", label: "Litiges" },
  { id: "dupliquer", label: "Dupliquer" },
  { id: "danger", label: "Zone de danger" },
];

/** What "Dupliquer la boutique" copies (see cloneStoreAction). */
const CLONED = [
  "Design du checkout et de la page de remerciement",
  "Interception",
  "Tarifs de livraison",
  "Options et codes promo (compteurs remis à zéro)",
  "Remises par quantité",
  "Marges, coûts et TVA",
  "IDs des pixels et valeur de conversion",
  "Alertes, checkout de secours et bouclier anti-litiges",
];
const NOT_CLONED = [
  "Connexions Shopify et Whop",
  "Domaine du checkout",
  "Jetons des pixels (Meta, TikTok, GA4)",
  "Identifiants Mondial Relay",
  "Libellé bancaire",
  "Commandes, statistiques et dépenses pub",
];

/** Scroll target of a section (clears the sticky bars on phones). */
function Anchor({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div id={id} className="scroll-mt-36 lg:scroll-mt-8">
      {children}
    </div>
  );
}
