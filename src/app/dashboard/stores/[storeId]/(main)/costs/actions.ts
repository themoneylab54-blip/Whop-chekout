"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireStoreAction } from "@/lib/store-guard";
import { parisDayStart } from "@/lib/analytics";
import { parseCsvDay, parseCsvAmount } from "@/lib/adspend-csv";
import { MAX_COST_CENTS, SINCE_ALWAYS, deleteProductCost, normalizeVariantId, parseCostCsv, recomputeMissingCosts, setProductCost } from "@/lib/costs";
import { recordEvent } from "@/lib/log";
import { flashUrl, type FlashParams } from "@/lib/flash";
import { tzOf, zonedDay } from "@/lib/time";
import { isVatCategory, VAT_CATEGORIES } from "@/lib/vat";
import { setVariantVatCategory } from "@/lib/vat-categories";

/* "Coûts produits": costs per variant (inline or CSV) and the back-fill of past orders. */

const costsPath = (storeId: string) => `/dashboard/stores/${storeId}/costs`;
const fmt = new Intl.NumberFormat("fr-FR");

/** Applies the saved costs to the paid orders right away (the merchant has nothing to click). */
async function applyNow(storeId: string): Promise<string> {
  try {
    const r = await recomputeMissingCosts(storeId);
    revalidatePath(`/dashboard/stores/${storeId}/analytics`);
    const touched = r.linesFilled + r.linesUpdated + r.chargesFilled + r.bumpsFilled;
    return touched ? ` Appliqué à ${fmt.format(touched)} ligne(s) de commandes déjà payées.` : " Aucune commande payée à mettre à jour.";
  } catch {
    return " Application aux commandes passées reportée (le traitement automatique s'en charge).";
  }
}

function back(storeId: string, params: FlashParams, hash = ""): never {
  redirect(flashUrl(costsPath(storeId), params, hash));
}

/** Signed in, may edit the store: its time zone (effective dates are days of that zone). */
async function guard(storeId: string): Promise<string> {
  const { store } = await requireStoreAction(storeId, "edit");
  return tzOf(store);
}

/** "" → since always; "2026-09-01" / "01/09/2026" → midnight of that day in the store's zone (not in the future). */
function effectiveDate(raw: string, tz: string): Date | "invalid" {
  if (!raw.trim()) return SINCE_ALWAYS;
  const day = parseCsvDay(raw);
  if (!day || day > zonedDay(new Date(), tz)) return "invalid";
  return parisDayStart(day, tz);
}

export async function saveCostAction(storeId: string, fd: FormData) {
  const tz = await guard(storeId);
  const variantId = normalizeVariantId(String(fd.get("variantId") ?? ""));
  const rawCost = String(fd.get("cost") ?? "").replace(/[\s\u00a0€]/g, "");
  // "12,505" or "1.250" is refused rather than rounded / read as 1,25: 2 decimals at most.
  const cents = /[.,]\d{3,}$/.test(rawCost) ? null : parseCsvAmount(rawCost);
  const at = effectiveDate(String(fd.get("effectiveFrom") ?? ""), tz);
  if (!variantId) back(storeId, { error: "Variante invalide." });
  if (cents == null || cents > MAX_COST_CENTS) back(storeId, { error: "Coût invalide : 2 décimales au maximum (ex. 12,50).", field: "cost" }, `#v-${encodeURIComponent(variantId)}`);
  if (at === "invalid") back(storeId, { error: "Date d'effet invalide (pas dans le futur).", field: "effectiveFrom" }, `#v-${encodeURIComponent(variantId)}`);
  const title = String(fd.get("title") ?? "").trim() || null;
  await setProductCost(storeId, { variantId, costCents: cents, effectiveFrom: at, title });
  await recordEvent({ storeId, kind: "costs.saved", message: `Coût produit ${title ?? variantId} : ${(cents / 100).toFixed(2)} ${at === SINCE_ALWAYS ? "depuis toujours" : `à partir du ${zonedDay(at, tz)}`}` });
  const applied = await applyNow(storeId);
  revalidatePath(costsPath(storeId));
  back(storeId, { ok: `Coût enregistré.${applied}` }, `#v-${encodeURIComponent(variantId)}`);
}

export async function deleteCostAction(storeId: string, id: string) {
  await guard(storeId);
  const ok = await deleteProductCost(storeId, id);
  const applied = ok ? await applyNow(storeId) : "";
  revalidatePath(costsPath(storeId));
  back(storeId, ok ? { ok: `Coût supprimé : les commandes reprennent le coût Shopify (ou restent sans coût).${applied}` } : { error: "Coût introuvable." });
}

export async function importCostsCsvAction(storeId: string, fd: FormData) {
  const tz = await guard(storeId);
  let text = String(fd.get("csv") ?? "");
  const file = fd.get("file");
  if (!text.trim() && file instanceof File && file.size > 0) {
    if (file.size > 1_000_000) back(storeId, { error: "Fichier trop volumineux (1 Mo maximum).", field: "file" }, "#import");
    text = await file.text();
  }
  if (!text.trim()) back(storeId, { error: "Collez des lignes « variant_id;coût » ou choisissez un fichier CSV.", field: "csv" }, "#import");
  const at = effectiveDate(String(fd.get("effectiveFrom") ?? ""), tz);
  if (at === "invalid") back(storeId, { error: "Date d'effet invalide (pas dans le futur).", field: "effectiveFrom" }, "#import");
  const { rows, errors } = parseCostCsv(text);
  if (!rows.length) back(storeId, { error: `Aucune ligne valide.${errors[0] ? ` Ligne ${errors[0].line} : ${errors[0].message}` : ""}`, field: "csv" }, "#import");
  for (const r of rows) await setProductCost(storeId, { variantId: r.variantId, costCents: r.costCents, effectiveFrom: at });
  const rejected = errors.filter((e) => !e.message.startsWith("Doublon"));
  await recordEvent({ storeId, kind: "costs.csv", message: `Import CSV des coûts produits : ${rows.length} variante(s)${rejected.length ? `, ${rejected.length} ligne(s) rejetée(s)` : ""}` });
  const applied = await applyNow(storeId);
  revalidatePath(costsPath(storeId));
  back(
    storeId,
    {
      ok: `${fmt.format(rows.length)} coût(s) importé(s).${applied}`,
      error: rejected.length ? `${fmt.format(rejected.length)} ligne(s) rejetée(s), dont ligne ${rejected[0].line} : ${rejected[0].message}` : undefined,
    },
    "#import",
  );
}

export async function recomputeCostsAction(storeId: string) {
  await guard(storeId);
  const r = await recomputeMissingCosts(storeId);
  await recordEvent({
    storeId,
    kind: "costs.recomputed",
    message: `Coûts recalculés : ${r.linesFilled} ligne(s) complétée(s), ${r.linesUpdated} mise(s) à jour, ${r.chargesFilled} offre(s) ; ${r.linesMissing + r.chargesMissing} sans coût`,
    data: r,
  });
  revalidatePath(costsPath(storeId));
  revalidatePath(`/dashboard/stores/${storeId}/analytics`);
  const missing = r.linesMissing + r.chargesMissing;
  back(storeId, {
    ok:
      `Recalcul terminé : ${fmt.format(r.linesFilled)} ligne(s) de commande complétée(s) sur ${fmt.format(r.sessions)} commande(s)` +
      `${r.linesUpdated ? `, ${fmt.format(r.linesUpdated)} mise(s) à jour` : ""}, ${fmt.format(r.chargesFilled)} offre(s) post-achat complétée(s)${r.bumpsFilled ? `, ${fmt.format(r.bumpsFilled)} option(s)` : ""}.` +
      (missing ? ` ${fmt.format(missing)} ligne(s) restent sans coût (aucun coût saisi pour ces variantes à la date de la commande).` : " Plus aucune ligne sans coût."),
  });
}

/** VAT category of a variant (reduced rates): applies to every order's CA HT, past ones included (computed at query time). */
export async function saveVatCategoryAction(storeId: string, fd: FormData) {
  await guard(storeId);
  const variantId = normalizeVariantId(String(fd.get("variantId") ?? ""));
  const category = String(fd.get("vatCategory") ?? "");
  if (!variantId) back(storeId, { error: "Variante invalide." });
  if (!isVatCategory(category)) back(storeId, { error: "Catégorie de TVA inconnue.", field: "vatCategory" }, `#v-${encodeURIComponent(variantId)}`);
  const title = String(fd.get("title") ?? "").trim() || null;
  await setVariantVatCategory(storeId, variantId, category, title);
  await recordEvent({ storeId, kind: "vat.category", message: `TVA de ${title ?? variantId} : ${VAT_CATEGORIES[category].label}` });
  revalidatePath(`/dashboard/stores/${storeId}/analytics`);
  revalidatePath(costsPath(storeId));
  back(storeId, { ok: `TVA « ${VAT_CATEGORIES[category].label} » enregistrée : le CA HT de toutes les commandes de cette variante en tient compte.` }, `#v-${encodeURIComponent(variantId)}`);
}
