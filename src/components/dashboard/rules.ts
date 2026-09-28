/**
 * Pure helpers shared by the dashboard's server pages and client editors (no "use client"):
 * quantity-break tiers and order-bump display rules, validated and summarised in French.
 */

export type Tier = { minQty: number; percent: number };
export const MAX_TIERS = 5;

const pct = (p: number) => `${String(p).replace(".", ",")}\u00a0%`;
const num = (v: string) => Number(v.trim().replace(",", "."));

/** Same rules as parseQuantityBreaks (src/lib/pricing.ts), plus unique and increasing tiers. One message per row (null = valid). */
export function tierErrors(rows: { minQty: string; percent: string }[]): (string | null)[] {
  const errors: (string | null)[] = rows.map((r) => {
    const q = num(r.minQty);
    const p = num(r.percent);
    if (!r.minQty.trim() || !Number.isInteger(q) || q < 2 || q > 100) return "Nombre d'articles : entier de 2 à 100";
    if (!r.percent.trim() || !Number.isFinite(p) || p <= 0 || p > 50) return "Remise : plus de 0 et au plus 50 %";
    if (!/^\d+([.,]\d)?$/.test(r.percent.trim())) return "Remise : une décimale au plus (ex. 12,5)";
    return null;
  });
  const seen = new Set<number>();
  rows.forEach((r, i) => {
    if (errors[i]) return;
    const q = num(r.minQty);
    if (seen.has(q)) errors[i] = `Il y a déjà un palier dès ${q} articles`;
    seen.add(q);
  });
  // A bigger quantity must give a bigger discount (the best reached tier wins at checkout).
  const valid = rows.map((r, i) => ({ i, q: num(r.minQty), p: num(r.percent) })).filter(({ i }) => !errors[i]);
  valid.sort((a, b) => a.q - b.q);
  for (let k = 1; k < valid.length; k++) {
    if (valid[k].p <= valid[k - 1].p) errors[valid[k].i] = `La remise doit dépasser −${pct(valid[k - 1].p)} (palier dès ${valid[k - 1].q} articles)`;
  }
  return errors;
}

/** "2 articles : −10 % · 3 articles : −15 %". */
export function tiersSentence(tiers: Tier[]): string {
  return [...tiers]
    .sort((a, b) => a.minQty - b.minQty)
    .map((t) => `${t.minQty} articles : −${pct(t.percent)}`)
    .join(" · ");
}

/* ------------------------------------------------------------------ */
/* Order-bump display rules (AddOn.showIf)                              */
/* ------------------------------------------------------------------ */

export type ShowIf = {
  minSubtotalCents?: number;
  maxSubtotalCents?: number;
  /** Shopify product GIDs (gid://shopify/Product/…). */
  productIds?: string[];
  countries?: string[];
  /** Dashboard-only: product titles by GID, to summarise the rule without calling Shopify. */
  productTitles?: Record<string, string>;
};

/** Common delivery countries offered as checkboxes (France first). */
export const RULE_COUNTRIES: [string, string][] = [
  ["FR", "France"],
  ["BE", "Belgique"],
  ["CH", "Suisse"],
  ["LU", "Luxembourg"],
  ["DE", "Allemagne"],
  ["ES", "Espagne"],
  ["IT", "Italie"],
  ["NL", "Pays-Bas"],
  ["PT", "Portugal"],
  ["AT", "Autriche"],
  ["IE", "Irlande"],
  ["MC", "Monaco"],
];
const COUNTRY_NAMES = Object.fromEntries(RULE_COUNTRIES);

export function readShowIf(raw: unknown): ShowIf {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined);
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);
  const titles = r.productTitles && typeof r.productTitles === "object" && !Array.isArray(r.productTitles) ? (r.productTitles as Record<string, string>) : undefined;
  return {
    minSubtotalCents: int(r.minSubtotalCents),
    maxSubtotalCents: int(r.maxSubtotalCents),
    productIds: strings(r.productIds),
    countries: strings(r.countries),
    productTitles: titles,
  };
}

export function hasRules(s: ShowIf): boolean {
  return s.minSubtotalCents != null || s.maxSubtotalCents != null || !!s.productIds?.length || !!s.countries?.length;
}

/** "Affichée si panier ≥ 40 € et contient Bougie Ambre", or null when always shown. */
export function showIfSummary(s: ShowIf, money: (cents: number) => string): string | null {
  const parts: string[] = [];
  if (s.minSubtotalCents != null && s.maxSubtotalCents != null) parts.push(`panier entre ${money(s.minSubtotalCents)} et ${money(s.maxSubtotalCents)}`);
  else if (s.minSubtotalCents != null) parts.push(`panier ≥ ${money(s.minSubtotalCents)}`);
  else if (s.maxSubtotalCents != null) parts.push(`panier ≤ ${money(s.maxSubtotalCents)}`);
  if (s.productIds?.length) {
    const names = s.productIds.map((id) => s.productTitles?.[id] ?? `produit #${id.split("/").pop()}`);
    parts.push(`contient ${names.length > 2 ? `${names.slice(0, 2).join(", ")} ou ${names.length - 2} autre${names.length > 3 ? "s" : ""}` : names.join(" ou ")}`);
  }
  if (s.countries?.length) {
    const names = s.countries.map((c) => COUNTRY_NAMES[c] ?? c);
    parts.push(`livraison en ${names.length > 3 ? `${names.slice(0, 3).join(", ")}…` : names.join(", ")}`);
  }
  if (!parts.length) return null;
  const last = parts.pop()!;
  return `Affichée si ${parts.length ? `${parts.join(", ")} et ${last}` : last}`;
}
