"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { importAdSpend, saveSpendRows } from "@/lib/adspend";
import { parseSpendCsv } from "@/lib/adspend-csv";
import { isDay, setExperimentMetric } from "@/lib/analytics";
import { recordEvent } from "@/lib/log";
import { flashBack } from "@/lib/flash-back";
import { flashUrl, issueField, type FlashParams } from "@/lib/flash";
import { endOfferTest } from "@/lib/offer-tests";
import { endCheckoutTest, startCheckoutTest } from "@/lib/checkout-tests";
import { addDays, tzOf, zonedDay } from "@/lib/time";
import { encrypt } from "@/lib/crypto";
import { changeConversionAction, retryAbandonedGoogleConversions } from "@/lib/google-conversions";
import { conversionActionName, googleCustomerId } from "@/lib/adspend-google";
import { googleAdsAuthUrl, googleAdsOperator, googleAdsRedirectUri, parseAccountChoice, signGoogleAdsState } from "@/lib/google-ads-oauth";

/*
 * Ad spend settings, manual entries and CSV import (Growth page, "Dépenses publicitaires"),
 * the costs used by the P&L (Settings › Coûts) and the A/B test primary metric (Analytics).
 */

const growthPath = (storeId: string) => `/dashboard/stores/${storeId}/growth`;

function back(storeId: string, params: FlashParams): never {
  redirect(flashUrl(growthPath(storeId), params, "#adspend"));
}

/** Amounts typed in euros: "12,50", "1 250" (at most 2 decimals: "4,905" is refused, not rounded). */
const DECIMAL_EUROS = /^\d+(?:[.,]\d{0,2})?$/;

async function getStore(storeId: string) {
  await requireAdmin();
  const store = await db.store.findUnique({ where: { id: storeId }, select: { id: true, shopCurrency: true, timezone: true } });
  if (!store) redirect("/dashboard");
  return store;
}

const optionalId = (re: RegExp, message: string) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/\s/g, ""))
    .refine((v) => v === "" || re.test(v), message)
    .transform((v) => v || null);

const accountsSchema = z.object({
  metaAdAccountId: optionalId(/^(act_)?\d{5,20}$/, "Identifiant de compte Meta invalide (ex. act_123456789012345 ou 123456789012345).").transform((v) => v?.replace(/^act_/, "") ?? null),
  tiktokAdvertiserId: optionalId(/^\d{5,25}$/, "Identifiant d'annonceur TikTok invalide (chiffres uniquement)."),
});

export async function saveAdAccountsAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const parsed = accountsSchema.safeParse({ metaAdAccountId: String(fd.get("metaAdAccountId") ?? ""), tiktokAdvertiserId: String(fd.get("tiktokAdvertiserId") ?? "") });
  if (!parsed.success) back(storeId, { error: parsed.error.issues[0]?.message ?? "Valeurs invalides", field: issueField(parsed.error.issues) });
  await db.store.update({ where: { id: storeId }, data: parsed.data });
  revalidatePath(growthPath(storeId));
  back(storeId, { ok: "Comptes publicitaires enregistrés. L'import des dépenses se fait automatiquement toutes les heures." });
}

/**
 * Google Ads API credentials (Growth page › Dépenses publicitaires): customer id and optional
 * manager (MCC) id in clear, the developer token, OAuth client secret and refresh token encrypted
 * like the other tokens. A blank secret keeps the stored one; "Supprimer" erases it.
 */
export async function saveGoogleAdsAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const current = await db.store.findUnique({
    where: { id: storeId },
    select: { googleAdsDeveloperToken: true, googleAdsClientSecret: true, googleAdsRefreshToken: true },
  });
  const text = (k: string) => String(fd.get(k) ?? "").trim();
  const customerRaw = text("googleAdsCustomerId");
  const loginRaw = text("googleAdsLoginCustomerId");
  const customer = customerRaw ? googleCustomerId(customerRaw) : null;
  const login = loginRaw ? googleCustomerId(loginRaw) : null;
  if (customerRaw && !customer) back(storeId, { error: "Identifiant client Google Ads invalide : 10 chiffres (ex. 123-456-7890), en haut à droite de Google Ads.", field: "googleAdsCustomerId" });
  if (loginRaw && !login) back(storeId, { error: "Identifiant du compte administrateur (MCC) invalide : 10 chiffres, ou laissez vide.", field: "googleAdsLoginCustomerId" });
  const clientId = text("googleAdsClientId");
  if (clientId && !/^[\w.-]{10,200}\.apps\.googleusercontent\.com$/.test(clientId)) back(storeId, { error: "ID client OAuth invalide (se termine par .apps.googleusercontent.com).", field: "googleAdsClientId" });
  const secret = (key: "googleAdsDeveloperToken" | "googleAdsClientSecret" | "googleAdsRefreshToken") => {
    if (fd.get(`${key}Clear`) === "on") return null;
    const v = text(key);
    if (v && v.length > 512) back(storeId, { error: "Valeur trop longue.", field: key });
    return v ? encrypt(v) : (current?.[key] ?? null);
  };
  const data = {
    googleAdsCustomerId: customer,
    googleAdsLoginCustomerId: login,
    googleAdsClientId: clientId || null,
    googleAdsDeveloperToken: secret("googleAdsDeveloperToken"),
    googleAdsClientSecret: secret("googleAdsClientSecret"),
    googleAdsRefreshToken: secret("googleAdsRefreshToken"),
  };
  await db.store.update({ where: { id: storeId }, data });
  const complete = data.googleAdsCustomerId && data.googleAdsClientId && data.googleAdsDeveloperToken && data.googleAdsClientSecret && data.googleAdsRefreshToken;
  await recordEvent({ storeId, kind: "adspend.google_saved", message: complete ? "Connexion Google Ads enregistrée (import des dépenses activé)." : "Réglages Google Ads enregistrés (incomplets : import inactif)." });
  revalidatePath(growthPath(storeId));
  back(storeId, complete ? { ok: "Google Ads connecté : les dépenses sont importées toutes les heures. Lancez « Importer maintenant » pour vérifier." } : { ok: "Réglages Google Ads enregistrés. Complétez les 5 champs pour activer l'import." });
}

/** "Connecter Google Ads": to Google's consent screen with a signed, 15-minute state. */
export async function connectGoogleAdsAction(storeId: string) {
  const adminId = await requireAdmin();
  await getStore(storeId);
  const op = googleAdsOperator();
  if (!op) back(storeId, { error: "Connexion Google Ads indisponible sur ce serveur : saisissez les identifiants dans « Avancé »." });
  redirect(googleAdsAuthUrl(op, signGoogleAdsState(storeId, adminId), googleAdsRedirectUri()));
}

/** Account picked after the OAuth connection ("1234567890", or "id:managerId" through an MCC). */
export async function selectGoogleAdsAccountAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const choice = parseAccountChoice(String(fd.get("googleAdsAccount") ?? ""));
  if (!choice) back(storeId, { error: "Choisissez le compte publicitaire Google Ads." });
  await db.store.update({ where: { id: storeId }, data: { googleAdsCustomerId: choice.customerId, googleAdsLoginCustomerId: choice.loginId } });
  await recordEvent({ storeId, kind: "adspend.google_saved", message: `Compte Google Ads ${choice.customerId.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3")} choisi : import des dépenses activé.` });
  revalidatePath(growthPath(storeId));
  back(storeId, { ok: "Compte Google Ads enregistré : les dépenses sont importées toutes les heures. Lancez « Importer maintenant » pour vérifier." });
}

/** "Déconnecter": forgets every Google Ads value (tokens included); imported spend stays. */
export async function disconnectGoogleAdsAction(storeId: string) {
  await getStore(storeId);
  await db.store.update({
    where: { id: storeId },
    data: { googleAdsCustomerId: null, googleAdsLoginCustomerId: null, googleAdsClientId: null, googleAdsClientSecret: null, googleAdsDeveloperToken: null, googleAdsRefreshToken: null },
  });
  await recordEvent({ storeId, kind: "adspend.google_saved", message: "Google Ads déconnecté (dépenses déjà importées conservées)." });
  revalidatePath(growthPath(storeId));
  back(storeId, { ok: "Google Ads déconnecté. Les dépenses déjà importées sont conservées." });
}

/** Google Ads offline conversions: the conversion action receiving the paid orders (empty = off). */
export async function saveGoogleConversionAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const store = await db.store.findUnique({ where: { id: storeId }, select: { googleAdsCustomerId: true } });
  const raw = String(fd.get("googleAdsConversionAction") ?? "").trim();
  const conversionAction = raw ? conversionActionName(raw, store?.googleAdsCustomerId) : null;
  if (raw && !conversionAction) back(storeId, { error: "Action de conversion invalide : son identifiant numérique (compte Google Ads connecté) ou customers/1234567890/conversionActions/987654321." });
  // A new action: the orders of the last 60 days not uploaded yet are tried again against it.
  const { reset } = await changeConversionAction(storeId, conversionAction);
  await recordEvent({
    storeId,
    kind: "adspend.google_conversions",
    message: conversionAction ? `Conversions hors ligne Google Ads activées (${conversionAction})${reset ? ` : ${reset} commande(s) récente(s) seront renvoyées` : ""}.` : "Conversions hors ligne Google Ads désactivées.",
  });
  revalidatePath(growthPath(storeId));
  back(storeId, {
    ok: conversionAction
      ? `Conversions hors ligne activées : les commandes payées venant de Google Ads sont envoyées à chaque passage de la maintenance.${reset ? ` ${reset} commande(s) des 60 derniers jours non envoyée(s) seront réessayée(s).` : ""}`
      : "Conversions hors ligne désactivées.",
  });
}

/** "Relancer les conversions abandonnées": Google Ads uploads and adjustments given up get their tries back. */
export async function retryGoogleConversionsAction(storeId: string) {
  await getStore(storeId);
  const { uploads, adjustments } = await retryAbandonedGoogleConversions(storeId);
  await recordEvent({
    storeId,
    kind: "adspend.google_conversions",
    message: `Conversions Google Ads relancées à la main : ${uploads} envoi(s) et ${adjustments} ajustement(s) réessayé(s) au prochain passage de la maintenance.`,
  });
  revalidatePath(growthPath(storeId));
  back(storeId, {
    ok: uploads + adjustments
      ? `${uploads} conversion(s) et ${adjustments} ajustement(s) seront réessayés au prochain passage de la maintenance (5 à 10 min).`
      : "Aucune conversion abandonnée à relancer.",
  });
}

export async function importAdSpendNowAction(storeId: string) {
  await getStore(storeId);
  const rows = await importAdSpend(Date.now() + 30_000, { storeId, force: true });
  revalidatePath(growthPath(storeId));
  back(storeId, { ok: `Import terminé : ${new Intl.NumberFormat("fr-FR").format(rows)} ligne(s) campagne × jour mises à jour. Consultez le statut ci-dessous.` });
}

const entrySchema = z.object({
  day: z.string().refine(isDay, "Date invalide"),
  platform: z.enum(["meta", "tiktok", "google", "other"]),
  campaign: z.string().trim().min(1, "Nom de campagne requis").max(120, "Nom de campagne trop long (120 caractères max.)"),
  amount: z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s\u00a0€]/g, ""))
    .transform((v) => (DECIMAL_EUROS.test(v) ? Number(v.replace(",", ".")) : NaN))
    .refine((v) => Number.isFinite(v) && v >= 0 && v <= 1_000_000, "Montant invalide (ex. 125 ou 49,90 ; 2 décimales max.)")
    .transform((v) => Math.round(v * 100)),
});

export async function addAdSpendAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  const parsed = entrySchema.safeParse({
    day: String(fd.get("day") ?? ""),
    platform: String(fd.get("platform") ?? ""),
    campaign: String(fd.get("campaign") ?? ""),
    amount: String(fd.get("amount") ?? ""),
  });
  if (!parsed.success) back(storeId, { error: parsed.error.issues[0]?.message ?? "Valeurs invalides", field: issueField(parsed.error.issues) });
  const { day, platform, campaign, amount } = parsed.data;
  // "Today" in the store's time zone (days of the ad spend rows).
  const today = zonedDay(new Date(), tzOf(store));
  if (day > today || day < addDays(today, -400)) back(storeId, { error: "Date hors plage (pas dans le futur, 400 jours maximum).", field: "day" });
  // Keyed on the campaign name: typing the same day + campaign again corrects the amount.
  const campaignId = `manual:${campaign.toLowerCase()}`.slice(0, 190);
  await db.adSpend.upsert({
    where: { storeId_day_platform_campaignId: { storeId, day, platform, campaignId } },
    create: { storeId, day, platform, campaignId, campaignName: campaign, spendCents: amount, currency: store.shopCurrency },
    update: { campaignName: campaign, spendCents: amount },
  });
  await recordEvent({ storeId, kind: "adspend.manual", message: `Dépense saisie : ${campaign} (${platform}) le ${day}` });
  revalidatePath(growthPath(storeId));
  back(storeId, { ok: "Dépense enregistrée." });
}

export async function deleteAdSpendAction(storeId: string, id: string) {
  await getStore(storeId);
  const row = await db.adSpend.findFirst({ where: { id, storeId } });
  if (!row) back(storeId, { error: "Ligne introuvable" });
  await db.adSpend.delete({ where: { id: row.id } });
  revalidatePath(growthPath(storeId));
  back(storeId, { ok: "Dépense supprimée." });
}

/** Bulk import: "jour;plateforme;campagne;montant[;devise]" pasted or uploaded (re-validated here). */
export async function importAdSpendCsvAction(storeId: string, fd: FormData) {
  const store = await getStore(storeId);
  let text = String(fd.get("csv") ?? "");
  const file = fd.get("file");
  if (!text.trim() && file instanceof File && file.size > 0) {
    if (file.size > 1_000_000) back(storeId, { error: "Fichier trop volumineux (1 Mo maximum)." });
    text = await file.text();
  }
  if (!text.trim()) back(storeId, { error: "Collez des lignes ou choisissez un fichier CSV." });
  const { rows, errors } = parseSpendCsv(text, zonedDay(new Date(), tzOf(store)));
  if (!rows.length) back(storeId, { error: `Aucune ligne valide.${errors[0] ? ` Ligne ${errors[0].line} : ${errors[0].message}` : ""}` });
  let written = 0;
  const unconverted = new Set<string>();
  const platforms = [...new Set(rows.map((r) => r.platform))];
  for (const platform of platforms) {
    const saved = await saveSpendRows(
      storeId,
      store.shopCurrency,
      platform,
      rows
        .filter((r) => r.platform === platform)
        .map((r) => ({ day: r.day, campaignId: `manual:${r.campaign.toLowerCase()}`.slice(0, 190), campaignName: r.campaign, spendCents: r.amountCents, currency: r.currency ?? store.shopCurrency })),
    );
    written += saved.written;
    saved.unconverted.forEach((c) => unconverted.add(c));
  }
  const rejected = errors.filter((e) => !e.message.startsWith("Doublon")).length;
  await recordEvent({ storeId, kind: "adspend.csv", message: `Import CSV des dépenses : ${written} ligne(s)${rejected ? `, ${rejected} rejetée(s)` : ""}` });
  revalidatePath(growthPath(storeId));
  const fmt = new Intl.NumberFormat("fr-FR");
  back(storeId, {
    ok: `${fmt.format(written)} dépense(s) importée(s) ou corrigée(s).${rejected ? ` ${fmt.format(rejected)} ligne(s) rejetée(s).` : ""}`,
    error: unconverted.size ? `Aucun taux de change disponible pour ${[...unconverted].join(", ")} : ces montants restent dans leur devise. Réessayez plus tard.` : undefined,
  });
}

/* ---------------------------- Settings › Coûts ---------------------------- */

const money = (label: string, max: number) =>
  z
    .string()
    .trim()
    .transform((v) => v.replace(/[\s\u00a0€]/g, ""))
    .transform((v) => (v === "" ? 0 : DECIMAL_EUROS.test(v) ? Number(v.replace(",", ".")) : NaN))
    .refine((v) => Number.isFinite(v) && v >= 0 && v <= max, `${label} : montant invalide (0 à ${new Intl.NumberFormat("fr-FR").format(max)}).`)
    .transform((v) => Math.round(v * 100));

const costsSchema = z.object({
  fixedCostsMonthly: money("Frais fixes mensuels", 1_000_000),
  disputeFee: money("Frais par litige", 1_000),
});

export async function saveCostsAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = `/dashboard/stores/${storeId}/settings`;
  const parsed = costsSchema.safeParse({ fixedCostsMonthly: String(fd.get("fixedCostsMonthly") ?? ""), disputeFee: String(fd.get("disputeFee") ?? "") });
  if (!parsed.success) redirect(flashUrl(path, { error: parsed.error.issues[0]?.message ?? "Valeurs invalides", field: issueField(parsed.error.issues) }, "#couts"));
  await db.store.update({ where: { id: storeId }, data: { fixedCostsMonthlyCents: parsed.data.fixedCostsMonthly, disputeFeeCents: parsed.data.disputeFee } });
  revalidatePath(path);
  revalidatePath(`/dashboard/stores/${storeId}/analytics`);
  redirect(`${path}?${new URLSearchParams({ ok: "Coûts enregistrés : ils s'appliquent à la rentabilité dans Analytics." })}#couts`);
}

/* ---------------------- Settings › Attribution & supplier ---------------------- */

export async function saveAttributionAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const path = `/dashboard/stores/${storeId}/settings`;
  const days = Number(fd.get("attributionDays"));
  if (![1, 7, 28].includes(days)) redirect(flashUrl(path, { error: "Fenêtre d'attribution invalide (1, 7 ou 28 jours).", field: "attributionDays" }, "#attribution"));
  const supplierPaidAtPayment = fd.get("supplierPaidAtPayment") === "on";
  await db.store.update({ where: { id: storeId }, data: { attributionDays: days, supplierPaidAtPayment } });
  await recordEvent({ storeId, kind: "settings.attribution", message: `Attribution : dernier clic pub sur ${days} j ; fournisseur payé au paiement : ${supplierPaidAtPayment ? "oui" : "non"}` });
  revalidatePath(path);
  revalidatePath(`/dashboard/stores/${storeId}/analytics`);
  redirect(`${path}?${new URLSearchParams({ ok: "Attribution et coûts fournisseur enregistrés : Analytics en tient compte immédiatement (fenêtre : sur les prochains checkouts)." })}#attribution`);
}

/* ------------------------------ A/B test metric ------------------------------ */

export async function setExperimentMetricAction(storeId: string, experimentId: string, fd: FormData) {
  await getStore(storeId);
  const path = `/dashboard/stores/${storeId}/analytics`;
  const metric = String(fd.get("metric") ?? "");
  // Back to the same period / filters (hidden `back` field), tests tab.
  const to = (params: { ok?: string; error?: string }) => flashBack(fd.get("back"), path, `${path}?tab=tests`, { tab: "tests", ...params });
  const exp = await db.experiment.findFirst({ where: { id: experimentId, storeId }, select: { id: true } });
  if (!exp || (metric !== "profit" && metric !== "revenue")) redirect(to({ error: "Métrique invalide" }));
  await setExperimentMetric(exp.id, metric);
  await recordEvent({ storeId, kind: "experiment.metric", message: `Test A/B : métrique principale = ${metric === "profit" ? "marge par visiteur" : "CA par visiteur"}` });
  revalidatePath(path);
  redirect(to({ ok: "Métrique principale du test enregistrée." }));
}

/* ------------------------------ Offer A/B tests ------------------------------ */

/** "Promouvoir B" / "Garder A" on an offer test (Analytics › Produits › offers). */
export async function endOfferTestAction(storeId: string, blockId: string, keep: "A" | "B", fd: FormData) {
  await getStore(storeId);
  const back = String(fd.get("back") ?? "");
  const target = back.startsWith(`/dashboard/stores/${storeId}/analytics`) ? back : `/dashboard/stores/${storeId}/analytics?tab=produits`;
  const sep = target.includes("?") ? "&" : "?";
  const done = await endOfferTest(storeId, blockId, keep === "B" ? "B" : "A", "manual");
  revalidatePath(`/dashboard/stores/${storeId}`, "layout");
  redirect(
    `${target}${sep}${new URLSearchParams(
      done
        ? { ok: keep === "B" ? "Variante B promue : elle devient l'offre (publiée, version ajoutée à l'historique)." : "Variante A conservée : le test de l'offre est arrêté." }
        : { error: "Ce test n'est plus actif sur la page de remerciement publiée." },
    )}#offres`,
  );
}

/* ------------------------------------------------------------------ */
/* Checkout A/B tests (quantity breaks, order bump, protection price)  */
/* ------------------------------------------------------------------ */

/** Back to the tests tab with the same period / filters; `flash=ct` routes the message to the panel. */
const testsBack = (storeId: string, fd: FormData | undefined, params: Record<string, string | undefined>) => {
  const base = `/dashboard/stores/${storeId}/analytics`;
  return redirect(flashBack(fd?.get("back"), base, `${base}?tab=tests`, { tab: "tests", flash: "ct", ...params }, "#tests-checkout"));
};

/** "2:10, 3:15" (items:percent) → percent tiers. */
function tiersFromText(text: string): { minQty: number; percent: number }[] | null {
  const parts = text.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean);
  const tiers = parts.map((p) => {
    const m = /^(\d{1,3})\s*[:=x×]\s*(\d{1,2}(?:[.,]\d)?)\s*%?$/.exec(p);
    return m ? { minQty: Number(m[1]), percent: Number(m[2].replace(",", ".")) } : null;
  });
  return tiers.length && tiers.every(Boolean) ? (tiers as { minQty: number; percent: number }[]) : null;
}

const euros = (v: FormDataEntryValue | null) => {
  const raw = String(v ?? "").replace(/[\s\u00a0€%]/g, "");
  if (!DECIMAL_EUROS.test(raw)) return NaN;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

/** Field of a checkout test's refusal (shown inline next to it). */
function checkoutTestErrorField(kind: string, error: string): string | undefined {
  if (/^Protection B/.test(error)) return kind === "protection" ? "price" : undefined;
  if (/^Part de B/.test(error)) return "split";
  if (/^Paliers B/.test(error)) return "tiers";
  if (/option à tester/.test(error)) return "targetId";
  if (/^Option B/.test(error)) return "price";
  return undefined;
}

export async function startCheckoutTestAction(storeId: string, fd: FormData) {
  await getStore(storeId);
  const kind = String(fd.get("kind") ?? "");
  let configB: unknown = null;
  if (kind === "breaks") {
    configB = tiersFromText(String(fd.get("tiers") ?? ""));
    if (!configB) testsBack(storeId, fd, { error: "Paliers B illisibles : écrivez par exemple « 2:10, 3:15 » (articles:remise %).", field: "tiers" });
  } else if (kind === "addon") {
    const hidden = fd.get("hidden") === "on";
    const price = String(fd.get("price") ?? "").trim();
    if (price && Number.isNaN(euros(price))) testsBack(storeId, fd, { error: "Prix B invalide (ex. 4,90 ; 2 décimales max.)", field: "price" });
    configB = { ...(price ? { priceCents: Math.round(euros(price) * 100) } : {}), ...(hidden ? { hidden: true } : {}) };
  } else if (kind === "protection") {
    configB = {
      priceMode: fd.get("priceMode") === "percent" ? "percent" : "fixed",
      price: euros(fd.get("price")),
      percent: euros(fd.get("percent")),
      minPrice: euros(fd.get("minPrice")),
      maxPrice: euros(fd.get("maxPrice") || "0"),
    };
  }
  const r = await startCheckoutTest(storeId, {
    kind,
    targetId: String(fd.get("targetId") ?? "") || null,
    name: String(fd.get("name") ?? ""),
    splitB: Number(fd.get("split") ?? 50),
    configB,
  });
  revalidatePath(`/dashboard/stores/${storeId}/analytics`);
  if (!r.ok) testsBack(storeId, fd, { error: r.error, field: checkoutTestErrorField(kind, r.error) });
  testsBack(storeId, fd, { ok: "Test lancé : les nouveaux checkouts sont répartis entre A et B (le même visiteur garde sa variante)." });
}

export async function endCheckoutTestAction(storeId: string, testId: string, keep: "A" | "B", fd?: FormData) {
  await getStore(storeId);
  const done = await endCheckoutTest(storeId, testId, keep === "B" ? "B" : "A");
  revalidatePath(`/dashboard/stores/${storeId}`, "layout");
  testsBack(storeId, fd, done ? { ok: keep === "B" ? "Variante B promue : elle devient le réglage de la boutique." : "Variante A conservée : le test est arrêté." } : { error: "Ce test n'est plus en cours." });
}
