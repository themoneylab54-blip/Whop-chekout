import type { Store } from "@prisma/client";
import { AlertTriangle, CheckCircle2, RefreshCw, Trash2, Wallet, XCircle } from "lucide-react";
import { db } from "@/lib/db";
import { AD_PLATFORMS, CAMPAIGN_ROWS, adSpendBackfillStatus, adSpendStatus } from "@/lib/adspend";
import { addDays, tzOf, zonedDay, zoneLabel } from "@/lib/time";
import { Card, Input, Label, LearnMore, Select, SubmitButton } from "@/components/ui";
import {
  addAdSpendAction,
  connectGoogleAdsAction,
  deleteAdSpendAction,
  disconnectGoogleAdsAction,
  importAdSpendCsvAction,
  importAdSpendNowAction,
  saveAdAccountsAction,
  saveGoogleAdsAction,
  retryGoogleConversionsAction,
  saveGoogleConversionAction,
  selectGoogleAdsAccountAction,
} from "@/app/dashboard/stores/[storeId]/(main)/analytics/actions";
import { decrypt } from "@/lib/crypto";
import { googleBacklog } from "@/lib/google-conversions";
import { googleAdsAccessToken, googleAdsOperator, listGoogleAdsAccounts, type GoogleAdsAccount } from "@/lib/google-ads-oauth";
import { SecretInput } from "./SecretInput";
import { ConfirmButton } from "./ConfirmButton";
import { AdSpendCsvImport } from "./AdSpendCsvImport";
import { DirtyForm } from "./DirtyForm";
import { DataTable } from "./AnalyticsKit";
import { formatCents, formatDateTime } from "./format";

/**
 * Growth page › "Dépenses publicitaires": ad accounts, import status, manual entries, CSV import,
 * last 14 days. Foreign-currency spend shows its original amount (converted at the ECB rate);
 * spend that could not be converted blocks with a red warning.
 */
const dashedId = (id: string) => id.replace(/^(\d{3})(\d{3})(\d{4})$/, "$1-$2-$3");
const accountValue = (a: GoogleAdsAccount) => (a.loginId ? `${a.id}:${a.loginId}` : a.id);

/** Accounts for the picker after "Connecter Google Ads" (live, bounded by the helpers' timeouts). */
async function pickableGoogleAccounts(
  op: NonNullable<ReturnType<typeof googleAdsOperator>>,
  refreshTokenEncrypted: string,
): Promise<{ ok: true; accounts: GoogleAdsAccount[] } | { ok: false; error: string }> {
  try {
    const token = await googleAdsAccessToken(op, decrypt(refreshTokenEncrypted));
    return { ok: true, accounts: await listGoogleAdsAccounts(op, token) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "erreur Google" };
  }
}

export async function AdSpendSection({ store }: { store: Store }) {
  const today = zonedDay(new Date(), tzOf(store));
  const from = addDays(today, -13);
  const [status, rows, unconverted, googleQueue, backfill] = await Promise.all([
    adSpendStatus(store.id),
    db.adSpend.findMany({ where: { storeId: store.id, day: { gte: from, lte: today }, ...CAMPAIGN_ROWS }, orderBy: [{ day: "desc" }, { spendCents: "desc" }] }),
    db.adSpend.groupBy({ by: ["currency"], where: { storeId: store.id, AND: [CAMPAIGN_ROWS, { NOT: { currency: store.shopCurrency } }] }, _count: { _all: true }, _min: { day: true }, _max: { day: true } }),
    store.googleAdsConversionAction ? googleBacklog(store.id) : null,
    adSpendBackfillStatus(store.id),
  ]);
  const shortDay = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const googleAbandoned = (googleQueue?.uploadsAbandoned ?? 0) + (googleQueue?.adjustmentsAbandoned ?? 0);
  const money = (c: number) => formatCents(c, store.shopCurrency);
  const days = Array.from({ length: 14 }, (_, i) => addDays(today, -i));
  const platforms = ["meta", "tiktok", "google", "other"] as const;
  const bucket = (p: string) => (p === "meta" || p === "tiktok" || p === "google" ? p : "other");
  const byDay = new Map(days.map((d) => [d, { meta: 0, tiktok: 0, google: 0, other: 0 }]));
  // Original amounts of converted spend, per day × platform (shown on hover).
  const originals = new Map<string, string[]>();
  for (const r of rows) {
    const b = byDay.get(r.day);
    if (b) b[bucket(r.platform)] += r.spendCents;
    if (r.originalCurrency && r.originalSpendCents != null && r.fxRate != null) {
      const k = `${r.day}|${bucket(r.platform)}`;
      originals.set(k, [...(originals.get(k) ?? []), `${formatCents(r.originalSpendCents, r.originalCurrency)} à ${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 4 }).format(r.fxRate)}`]);
    }
  }
  const manual = rows.filter((r) => r.campaignId.startsWith("manual:"));
  const total = rows.reduce((s, r) => s + r.spendCents, 0);
  const unconvertedRows = unconverted.reduce((a, r) => a + r._count._all, 0);
  const metaReady = !!store.metaAccessToken;
  const tiktokReady = !!store.tiktokAccessToken;
  const googleFields = [store.googleAdsCustomerId, store.googleAdsClientId, store.googleAdsDeveloperToken, store.googleAdsClientSecret, store.googleAdsRefreshToken];
  const googleReady = googleFields.every(Boolean);
  const googleStarted = googleFields.some(Boolean);
  const anyAccount = !!(store.metaAdAccountId || store.tiktokAdvertiserId || googleReady);
  // "Connecter Google Ads" (operator's Google app in env); the manual fields stay under "Avancé".
  const googleOp = googleAdsOperator();
  const googleOAuth = !!googleOp;
  const googleViaOAuth = !!googleOp && store.googleAdsClientId === googleOp.clientId && !!store.googleAdsRefreshToken;
  const googlePick = googleViaOAuth && !store.googleAdsCustomerId;
  const googleAccounts = googlePick && googleOp ? await pickableGoogleAccounts(googleOp, store.googleAdsRefreshToken!) : { ok: true as const, accounts: [] };

  return (
    <Card
      icon={Wallet}
      iconColor="#16a34a"
      title="Dépenses publicitaires"
      description="Pour calculer ROAS, CPA et bénéfice net après pub dans Analytics."
    >
      <LearnMore className="-mt-2 mb-3">
        Les dépenses Meta, TikTok et Google Ads des 7 derniers jours sont importées automatiquement toutes les heures ; les autres (influence…) se saisissent à la main ou par
        import CSV.
      </LearnMore>
      {unconvertedRows > 0 && (
        <div role="alert" className="mb-4 flex items-start gap-2 rounded-xl bg-red-50 px-3.5 py-3 text-sm text-red-900 ring-1 ring-red-600/20">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <strong className="font-semibold">Dépenses non converties : ROAS et bénéfice après pub sont faux.</strong> {unconvertedRows} ligne(s) en{" "}
            {unconverted.map((u) => u.currency).join(", ")} (du {new Date(`${unconverted[0]._min.day}T12:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC" })} au{" "}
            {new Date(`${unconverted[unconverted.length - 1]._max.day}T12:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC" })}) n&apos;ont pas pu être converties en{" "}
            {store.shopCurrency} : le taux de change BCE n&apos;était pas disponible. Relancez « Importer maintenant » (ou réimportez le CSV) dès que possible.
          </span>
        </div>
      )}
      <DirtyForm label="Comptes publicitaires" action={saveAdAccountsAction.bind(null, store.id)} className="space-y-4">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="metaAdAccountId" hint="Gestionnaire de publicités › menu des comptes (act_…). Le jeton Meta ci-dessus doit avoir la permission ads_read.">
              ID du compte publicitaire Meta
            </Label>
            <Input id="metaAdAccountId" name="metaAdAccountId" defaultValue={store.metaAdAccountId ?? ""} inputMode="numeric" placeholder="act_123456789012345" />
            {store.metaAdAccountId && !metaReady && <p className="mt-1 text-xs text-amber-700">Ajoutez le jeton d&apos;accès Meta ci-dessus pour lancer l&apos;import.</p>}
          </div>
          <div>
            <Label htmlFor="tiktokAdvertiserId" hint="TikTok Ads Manager › Compte › ID de l'annonceur. Jeton : TikTok for Business (Marketing API, lecture des rapports).">
              ID annonceur TikTok
            </Label>
            <Input id="tiktokAdvertiserId" name="tiktokAdvertiserId" defaultValue={store.tiktokAdvertiserId ?? ""} inputMode="numeric" placeholder="7012345678901234567" />
            {store.tiktokAdvertiserId && !tiktokReady && <p className="mt-1 text-xs text-amber-700">Ajoutez le jeton TikTok ci-dessus pour lancer l&apos;import.</p>}
          </div>
        </div>
      </DirtyForm>

      <section aria-labelledby="google-ads-title" className="mt-5 space-y-3 border-t border-zinc-100 pt-4">
        <div className="flex flex-wrap items-center gap-2">
          <h3 id="google-ads-title" className="text-sm font-medium text-zinc-800">
            Google Ads
          </h3>
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${googleReady ? "bg-emerald-50 text-emerald-800" : googleStarted ? "bg-amber-50 text-amber-800" : "bg-zinc-100 text-zinc-600"}`}>
            {googleReady ? "connecté" : googlePick ? "compte à choisir" : googleStarted ? "incomplet" : "non connecté"}
          </span>
        </div>
        {googleOAuth ? (
          googleReady ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-700">
              <span>
                Compte <strong className="font-medium text-zinc-900 tabular-nums">{dashedId(store.googleAdsCustomerId!)}</strong>
                {store.googleAdsLoginCustomerId && <span className="text-zinc-500"> via le compte administrateur {dashedId(store.googleAdsLoginCustomerId)}</span>}
              </span>
              {googleViaOAuth && (
                <span className="ml-auto flex flex-wrap gap-2">
                  <form action={connectGoogleAdsAction.bind(null, store.id)}>
                    <SubmitButton size="sm" variant="secondary">
                      Changer de compte
                    </SubmitButton>
                  </form>
                  <form action={disconnectGoogleAdsAction.bind(null, store.id)}>
                    <ConfirmButton size="sm" variant="secondary" title="Déconnecter Google Ads ?" description="L'import des dépenses Google Ads s'arrête. Les dépenses déjà importées sont conservées." confirmLabel="Déconnecter">
                      Déconnecter
                    </ConfirmButton>
                  </form>
                </span>
              )}
            </div>
          ) : googlePick ? (
            googleAccounts.ok && googleAccounts.accounts.length ? (
              <form action={selectGoogleAdsAccountAction.bind(null, store.id)} className="flex flex-wrap items-end gap-2">
                <div className="min-w-0 flex-1 sm:max-w-sm">
                  <Label htmlFor="googleAdsAccount" hint="Les comptes auxquels votre connexion Google a accès.">
                    Compte publicitaire Google Ads
                  </Label>
                  <Select id="googleAdsAccount" name="googleAdsAccount" required defaultValue={googleAccounts.accounts.find((a) => !a.manager) ? accountValue(googleAccounts.accounts.find((a) => !a.manager)!) : ""}>
                    {googleAccounts.accounts.map((a) => (
                      <option key={accountValue(a)} value={accountValue(a)} disabled={a.manager}>
                        {a.name ? `${a.name} · ` : ""}
                        {dashedId(a.id)}
                        {a.currency ? ` · ${a.currency}` : ""}
                        {a.manager ? " (compte administrateur)" : a.loginId ? ` (via ${dashedId(a.loginId)})` : ""}
                      </option>
                    ))}
                  </Select>
                </div>
                <SubmitButton>Utiliser ce compte</SubmitButton>
              </form>
            ) : (
              <div role="alert" className="flex flex-wrap items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-600/20">
                <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  {googleAccounts.ok ? "Aucun compte publicitaire accessible avec ce compte Google." : `Liste des comptes indisponible : ${googleAccounts.error}`}
                </span>
                <form action={connectGoogleAdsAction.bind(null, store.id)}>
                  <SubmitButton size="sm" variant="secondary">
                    Reconnecter
                  </SubmitButton>
                </form>
              </div>
            )
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <form action={connectGoogleAdsAction.bind(null, store.id)}>
                <SubmitButton>Connecter Google Ads</SubmitButton>
              </form>
              <p className="min-w-[16rem] flex-1 text-xs text-zinc-500">Connectez-vous avec le compte Google qui gère vos publicités, puis choisissez le compte : rien à copier.</p>
            </div>
          )
        ) : (
          <p className="text-xs text-zinc-500">
            La connexion en un clic n&apos;est pas configurée sur ce serveur : ouvrez « Configurer manuellement » pour saisir les identifiants.
          </p>
        )}
        <details className="group rounded-lg ring-1 ring-zinc-900/5" open={(googleStarted && !googleViaOAuth && !googleReady) || undefined}>
          <summary className="flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none">
            Configurer manuellement (identifiants API)
          </summary>
          <div className="px-3 pb-3">
          <DirtyForm label="Google Ads" action={saveGoogleAdsAction.bind(null, store.id)} className="mt-3 space-y-4">
            {/* How to get the 5 values by hand. */}
            <details className="text-xs leading-relaxed text-zinc-600">
                <summary className="cursor-pointer text-indigo-700">Comment obtenir ces 5 valeurs (15 min, une seule fois)</summary>
                <ol className="mt-1.5 list-decimal space-y-1 pl-4">
                  <li>
                    <strong>Jeton développeur</strong> : dans un compte administrateur (MCC) Google Ads › Outils › Centre API. Demandez l&apos;accès « Basic » (le niveau « Test » ne lit
                    pas les vrais comptes).
                  </li>
                  <li>
                    <strong>ID client et code secret OAuth</strong> : console.cloud.google.com › activez « Google Ads API » › Identifiants › Créer un ID client OAuth (type « Application
                    Web », URI de redirection https://developers.google.com/oauthplayground).
                  </li>
                  <li>
                    <strong>Jeton d&apos;actualisation</strong> : sur developers.google.com/oauthplayground, roue dentée › « Use your own OAuth credentials » (ID et secret ci-dessus), scope{" "}
                    <code>https://www.googleapis.com/auth/adwords</code>, autorisez avec le compte Google qui voit le compte publicitaire, puis « Exchange authorization code for tokens » :
                    copiez le <em>refresh token</em>.
                  </li>
                  <li>
                    <strong>ID client Google Ads</strong> : les 10 chiffres en haut à droite du compte publicitaire (123-456-7890) ; <strong>ID administrateur</strong> seulement si vous
                    y accédez via un MCC.
                  </li>
                </ol>
                <p className="mt-1">
                  Dépenses lues avec l&apos;API Google Ads (campagnes, groupes d&apos;annonces et annonces, par jour), converties au taux BCE si le compte facture dans une autre devise. Les
                  secrets sont chiffrés et jamais réaffichés.
                </p>
              </details>
            <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="googleAdsCustomerId" hint="10 chiffres, en haut à droite de Google Ads">
                  ID client Google Ads
                </Label>
                <Input id="googleAdsCustomerId" name="googleAdsCustomerId" defaultValue={store.googleAdsCustomerId ?? ""} inputMode="numeric" placeholder="123-456-7890" />
              </div>
              <div>
                <Label htmlFor="googleAdsLoginCustomerId" hint="Facultatif : compte administrateur (MCC) par lequel vous accédez au compte">
                  ID administrateur (MCC)
                </Label>
                <Input id="googleAdsLoginCustomerId" name="googleAdsLoginCustomerId" defaultValue={store.googleAdsLoginCustomerId ?? ""} inputMode="numeric" placeholder="987-654-3210" />
              </div>
              <div>
                <Label htmlFor="googleAdsDeveloperToken" hint="Centre API du compte MCC (accès Basic)">
                  Jeton développeur
                </Label>
                <SecretInput name="googleAdsDeveloperToken" stored={!!store.googleAdsDeveloperToken} />
              </div>
              <div>
                <Label htmlFor="googleAdsClientId" hint="Google Cloud › Identifiants › ID client OAuth">
                  ID client OAuth
                </Label>
                <Input id="googleAdsClientId" name="googleAdsClientId" defaultValue={store.googleAdsClientId ?? ""} placeholder="123…apps.googleusercontent.com" autoComplete="off" />
              </div>
              <div>
                <Label htmlFor="googleAdsClientSecret" hint="Code secret du même ID client OAuth">
                  Code secret OAuth
                </Label>
                <SecretInput name="googleAdsClientSecret" stored={!!store.googleAdsClientSecret} />
              </div>
              <div>
                <Label htmlFor="googleAdsRefreshToken" hint="OAuth Playground, scope …/auth/adwords">
                  Jeton d&apos;actualisation (refresh token)
                </Label>
                <SecretInput name="googleAdsRefreshToken" stored={!!store.googleAdsRefreshToken} />
              </div>
            </div>
          </DirtyForm>
          </div>
        </details>
        {/* Offline conversions: outside "Avancé", so stores connected with the OAuth button set it too. */}
        <DirtyForm label="Conversions Google Ads" action={saveGoogleConversionAction.bind(null, store.id)} className="space-y-2">
          <Label
            htmlFor="googleAdsConversionAction"
            hint="Facultatif : Objectifs › Conversions › action de type « Importation › Clics » ; son identifiant (ctId dans l'URL) ou customers/…/conversionActions/…"
          >
            Action de conversion hors ligne (commandes payées)
          </Label>
          <Input id="googleAdsConversionAction" name="googleAdsConversionAction" defaultValue={store.googleAdsConversionAction ?? ""} placeholder="987654321" autoComplete="off" />
          <LearnMore>
            Chaque commande payée venant d&apos;un clic Google Ads (gclid, gbraid, wbraid) est envoyée à Google avec son montant, dédoublonnée par numéro de commande (jamais les
            commandes de test), puis ajustée après un remboursement, un litige perdu ou une offre post-achat. Même règle de consentement que Meta et TikTok, pour la conversion comme
            pour l&apos;e-mail haché (conversions améliorées) : avec « consentement requis », seulement si le client a accepté le suivi marketing ; sinon, sauf s&apos;il l&apos;a refusé.
          </LearnMore>
        </DirtyForm>
        {googleQueue && googleAbandoned > 0 && (
          <div role="status" className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-amber-50 px-3.5 py-3 text-sm text-amber-900 ring-1 ring-amber-600/20">
            <span className="flex min-w-0 items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>
                {googleQueue.uploadsAbandoned > 0 && `${googleQueue.uploadsAbandoned} conversion(s) hors ligne abandonnée(s) après 5 essais`}
                {googleQueue.uploadsAbandoned > 0 && googleQueue.adjustmentsAbandoned > 0 && " · "}
                {googleQueue.adjustmentsAbandoned > 0 && `${googleQueue.adjustmentsAbandoned} ajustement(s) (remboursement, litige, offre) abandonné(s)`}. Une fois le problème réglé
                (compte, action de conversion, jeton), relancez-les : elles repartent au prochain passage de la maintenance.
              </span>
            </span>
            <form action={retryGoogleConversionsAction.bind(null, store.id)}>
              <SubmitButton size="sm" variant="secondary">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Relancer les conversions abandonnées
              </SubmitButton>
            </form>
          </div>
        )}
      </section>

      <div className="mt-4 rounded-xl bg-zinc-50 p-3 text-sm ring-1 ring-zinc-900/5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-medium text-zinc-800">Dernier import</p>
          {anyAccount && (
            <form action={importAdSpendNowAction.bind(null, store.id)}>
              <SubmitButton size="sm" variant="secondary">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Importer maintenant
              </SubmitButton>
            </form>
          )}
        </div>
        {!status ? (
          <p className="mt-1 text-xs text-zinc-500">{anyAccount ? "Pas encore d'import : il démarre au prochain passage de la tâche de fond." : "Aucun compte publicitaire connecté."}</p>
        ) : (
          <ul className="mt-1.5 space-y-1 text-xs">
            <li className="text-zinc-500">{formatDateTime(new Date(status.at), false, tzOf(store))}</li>
            {(Object.entries(status.platforms) as [keyof typeof AD_PLATFORMS, { ok: boolean; rows: number; details?: number; detailError?: string; error?: string; currency?: string; unconverted?: string[] }][]).map(([p, s]) => (
              <li key={p} className={`flex items-start gap-1.5 ${s.ok ? "text-emerald-800" : "text-red-800"}`}>
                {s.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />}
                <span>
                  {AD_PLATFORMS[p]} : {s.ok ? `${s.rows} ligne(s) campagne × jour importée(s)` : `échec — ${s.error}`}
                  {s.ok && s.details != null && ` · ${s.details} ligne(s) ad set / publicité (tableau Créas d'Analytics)`}
                  {s.ok && s.detailError && ` · détail ad sets / publicités non importé : ${s.detailError}`}
                  {s.currency &&
                    (s.unconverted?.length
                      ? ` · compte en ${s.currency} : taux de change indisponible, montants non convertis`
                      : ` · compte en ${s.currency}, converti en ${store.shopCurrency} au taux BCE du jour`)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {backfill && Object.keys(backfill.platforms).length > 0 && (
          <ul className="mt-1.5 space-y-1 text-xs text-zinc-600" aria-label="Historique des dépenses">
            {(Object.entries(backfill.platforms) as [keyof typeof AD_PLATFORMS, NonNullable<(typeof backfill.platforms)["meta"]>][]).map(([p, b]) => (
              <li key={p}>
                Historique {AD_PLATFORMS[p]} :{" "}
                {b.done
                  ? `importé sur 13 mois (depuis le ${shortDay(b.target)})`
                  : `import en cours, dépenses connues depuis le ${shortDay(b.cursor)} (objectif : ${shortDay(b.target)}, un mois par passage)`}
                {b.error && <span className="text-red-800"> · dernier essai en échec : {b.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6 border-t border-zinc-100 pt-4">
        <p className="mb-2 text-sm font-medium text-zinc-800">Saisir une dépense</p>
        <form action={addAdSpendAction.bind(null, store.id)} className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[150px_140px_1fr_120px_auto] sm:items-end">
          <div>
            <Label htmlFor="as-day">Jour</Label>
            <Input id="as-day" name="day" type="date" lang="fr" required defaultValue={today} max={today} aria-describedby="as-day-hint" />
          </div>
          <div>
            <Label htmlFor="as-platform">Plateforme</Label>
            <Select id="as-platform" name="platform" defaultValue={googleReady ? "other" : "google"}>
              {(Object.keys(AD_PLATFORMS) as (keyof typeof AD_PLATFORMS)[]).map((p) => (
                <option key={p} value={p}>
                  {AD_PLATFORMS[p]}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="as-campaign">Campagne</Label>
            <Input id="as-campaign" name="campaign" required maxLength={120} placeholder="automne" />
          </div>
          <div>
            <Label htmlFor="as-amount">Montant ({store.shopCurrency})</Label>
            <Input id="as-amount" name="amount" required inputMode="decimal" placeholder="120,50" />
          </div>
          <SubmitButton>Ajouter</SubmitButton>
        </form>
        <p id="as-day-hint" className="mt-1.5 text-xs text-zinc-500">
          Jour au format jj/mm/aaaa ({zoneLabel(store.timezone)}), aujourd&apos;hui au plus tard.
        </p>
        <p className="mt-0.5 text-xs text-zinc-500">
          Campagne : idéalement identique à l&apos;utm_campaign de vos liens. Saisir à nouveau le même jour et la même campagne corrige le montant.
        </p>
      </div>

      <div className="mt-6 border-t border-zinc-100 pt-4">
        <p className="mb-2 text-sm font-medium text-zinc-800">Importer plusieurs jours (CSV)</p>
        <AdSpendCsvImport action={importAdSpendCsvAction.bind(null, store.id)} currency={store.shopCurrency} today={today} />
      </div>

      <div className="mt-6 border-t border-zinc-100 pt-4">
        <p className="mb-2 text-sm font-medium text-zinc-800">
          14 derniers jours{total > 0 && <> · <span className="tabular-nums">{money(total)}</span></>}
        </p>
        {total === 0 ? (
          // Nothing spent (or imported) yet: one line instead of 14 rows of dashes.
          <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-sm text-zinc-500">
            Aucune dépense sur les 14 derniers jours.{" "}
            {anyAccount ? "Les dépenses importées apparaîtront ici après le prochain import." : "Connectez un compte publicitaire ou saisissez une dépense ci-dessus."}
          </p>
        ) : (
          <>
            {originals.size > 0 && (
              <p className="mb-2 text-xs text-zinc-500">
                <span aria-hidden>†</span> Montant converti depuis une autre devise au taux BCE : survolez-le pour voir le montant d&apos;origine.
              </p>
            )}
            <DataTable
              caption="Dépenses publicitaires par jour"
              columns={[{ label: "Jour" }, { label: "Meta" }, { label: "TikTok" }, { label: "Google" }, { label: "Autres" }, { label: "Total" }]}
              empty=""
              rows={days.map((d) => {
                const b = byDay.get(d)!;
                const t = platforms.reduce((s, p) => s + b[p], 0);
                return {
                  key: d,
                  muted: t === 0,
                  cells: [
                    new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }),
                    ...platforms.map((p) => {
                      if (!b[p]) return "—";
                      const orig = originals.get(`${d}|${p}`);
                      return orig ? (
                        <span key={p} title={`Montant d'origine : ${orig.join(" ; ")}`} className="cursor-help underline decoration-dotted underline-offset-2">
                          {money(b[p])}
                          <span aria-hidden>†</span>
                          <span className="sr-only"> (converti depuis {orig.join(" ; ")})</span>
                        </span>
                      ) : (
                        money(b[p])
                      );
                    }),
                    t ? money(t) : "—",
                  ],
                };
              })}
            />
          </>
        )}
        {manual.length > 0 && (
          <>
            <p className="mt-5 mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Saisies manuelles</p>
            <ul className="divide-y divide-zinc-100 text-sm">
              {manual.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{r.campaignName}</span>
                    <span className="text-xs text-zinc-500">
                      {AD_PLATFORMS[r.platform as keyof typeof AD_PLATFORMS] ?? r.platform} · {new Date(`${r.day}T12:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC" })}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    <span className="tabular-nums" title={r.originalCurrency && r.originalSpendCents != null ? `Montant d'origine : ${formatCents(r.originalSpendCents, r.originalCurrency)}` : undefined}>
                      {r.currency !== store.shopCurrency ? formatCents(r.spendCents, r.currency) : money(r.spendCents)}
                    </span>
                    <form action={deleteAdSpendAction.bind(null, store.id, r.id)}>
                      <button className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-red-50 hover:text-red-700" aria-label={`Supprimer la dépense ${r.campaignName} du ${r.day}`}>
                        <Trash2 className="h-4 w-4" aria-hidden />
                      </button>
                    </form>
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </Card>
  );
}
