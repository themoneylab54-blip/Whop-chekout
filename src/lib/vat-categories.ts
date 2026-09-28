import "server-only";
import { db } from "./db";
import { isVatCategory, type VatCategory } from "./vat";

/*
 * Per-variant VAT categories (ProductVat), set on the "Coûts produits" page: a variant without a row
 * is at the standard rate. Used by analytics (SQL), the orders export and the "profit" conversion
 * value (blendedVatRate).
 */

/** variantId → category, reduced categories only (standard is the default). */
export async function loadVatCategories(storeId: string): Promise<Map<string, VatCategory>> {
  const rows = await db.productVat.findMany({ where: { storeId, NOT: { category: "standard" } }, select: { variantId: true, category: true } });
  return new Map(rows.filter((r) => isVatCategory(r.category)).map((r) => [r.variantId, r.category as VatCategory]));
}

/** Sets a variant's category ("standard" removes the row). Throws on an unknown category. */
export async function setVariantVatCategory(storeId: string, variantId: string, category: string, title?: string | null): Promise<void> {
  if (!isVatCategory(category)) throw new Error("Catégorie de TVA inconnue.");
  if (category === "standard") {
    await db.productVat.deleteMany({ where: { storeId, variantId } });
    return;
  }
  await db.productVat.upsert({
    where: { storeId_variantId: { storeId, variantId } },
    create: { storeId, variantId, category, title: title?.slice(0, 200) ?? null },
    update: { category, ...(title ? { title: title.slice(0, 200) } : {}) },
  });
}
