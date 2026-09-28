/** Money field helpers shared by server pages and client inputs (no "use client"). */

/**
 * "12,5" | "12.50" | "1 234,5" → cents, or null when empty / not a number / more than 2 decimals
 * ("2,999" stays as typed and is flagged, never silently rounded to 3,00).
 */
export function parseMoney(value: string): number | null {
  const v = value.replace(/[\s\u00a0\u202f€$£]/g, "").replace(",", ".");
  if (!v || !/^\d*(?:\.\d{0,2})?$/.test(v) || v === ".") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** 1250 → "12,50" (fr-FR, no currency sign: the input shows it). */
export function centsToField(cents: number | null | undefined): string {
  if (cents == null) return "";
  return (cents / 100).toFixed(2).replace(".", ",");
}

export function currencySymbol(currency: string): string {
  try {
    return (
      new Intl.NumberFormat("fr-FR", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).formatToParts(0).find((p) => p.type === "currency")?.value ?? currency
    );
  } catch {
    return currency;
  }
}
