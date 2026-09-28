import { Prisma } from "@prisma/client";

/*
 * VAT for profit analytics. Checkout prices are VAT-inclusive (EU B2C): revenue "HT" is
 * the amount paid divided by (1 + standard rate of the delivery country), the place of
 * taxation for EU distance sales above the 10 k€ OSS threshold. Reduced rates (books,
 * food, press…) apply per variant through its VAT category (ProductVat, "Coûts produits" page):
 * an order's rate is then the average of its lines' rates weighted by their amounts (shipping and
 * options follow the goods pro rata). A category whose rate isn't known for a destination uses
 * that country's standard rate (flagged in the coverage). A VAT-exempt store (micro-entreprise
 * "franchise en base") uses 0 %.
 *
 * Whop is the merchant of record: depending on the account it may collect and remit
 * the VAT itself. Either way the merchant's economic revenue is the amount excluding VAT.
 *
 * Below the 10 k€ EU distance-selling (OSS) threshold, a French seller charges French VAT on
 * every EU order (`vatDomesticOnly`): every EU destination (and Monaco) then uses the home rate.
 *
 * Destinations outside the EU VAT area (Switzerland, the UK, Norway, the US, the French overseas
 * departments…) are exports: no French/EU VAT, so 0 % (import taxes, if any, are the buyer's or
 * the carrier's). Only an unknown destination falls back to the home rate (conservative).
 */

/** Standard VAT rates in percent (EU-27 as of 2026, plus Monaco). */
export const STANDARD_VAT_RATES: Readonly<Record<string, number>> = {
  AT: 20,
  BE: 21,
  BG: 20,
  CY: 19,
  CZ: 21,
  DE: 19,
  DK: 25,
  EE: 24,
  ES: 21,
  FI: 25.5,
  FR: 20,
  GR: 24,
  HR: 25,
  HU: 27,
  IE: 23,
  IT: 22,
  LT: 21,
  LU: 17,
  LV: 21,
  MT: 18,
  NL: 21,
  PL: 23,
  PT: 23,
  RO: 21,
  SE: 25,
  SI: 22,
  SK: 23,
  // Monaco is in the French VAT territory.
  MC: 20,
};

/** Home country of the stores (French merchants). */
export const HOME_COUNTRY = "FR";

/** EU-27 member states plus Monaco (French VAT territory): destinations taxed at home under the OSS threshold. */
export const EU_VAT_AREA: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK", "MC",
]);

export type VatOptions = { vatExempt?: boolean; homeCountry?: string; /** EU sales under the OSS threshold: home rate for every EU destination. */ domesticOnly?: boolean };

/** Standard rate as a fraction (0.2) for a delivery country: its EU rate, 0 outside the EU (export), home when unknown. */
export function vatRate(country: string | null | undefined, opts: VatOptions = {}): number {
  if (opts.vatExempt) return 0;
  const home = STANDARD_VAT_RATES[(opts.homeCountry ?? HOME_COUNTRY).toUpperCase()] ?? 20;
  const cc = country?.trim().toUpperCase();
  if (!cc) return home / 100;
  if (!EU_VAT_AREA.has(cc)) return 0;
  if (opts.domesticOnly) return home / 100;
  return (STANDARD_VAT_RATES[cc] ?? home) / 100;
}

/** VAT-inclusive cents → { ht, vat } (rounded to the cent, ht + vat = ttc). */
export function splitVat(ttcCents: number, rate: number): { htCents: number; vatCents: number } {
  const htCents = Math.round(ttcCents / (1 + rate));
  return { htCents, vatCents: ttcCents - htCents };
}

/**
 * SQL expression of the rate (fraction, numeric) for a country expression, e.g.
 * `vatRateSql(Prisma.sql\`s."shippingAddress"->>'countryCode'\`, store.vatExempt)`.
 */
export function vatRateSql(country: Prisma.Sql, vatExempt = false, homeCountry = HOME_COUNTRY, domesticOnly = false): Prisma.Sql {
  if (vatExempt) return Prisma.sql`0::numeric`;
  const homePct = STANDARD_VAT_RATES[homeCountry.toUpperCase()] ?? 20;
  const home = homePct / 100;
  const cases = [...EU_VAT_AREA].map((cc) => Prisma.sql`WHEN ${cc} THEN ${(domesticOnly ? homePct : (STANDARD_VAT_RATES[cc] ?? homePct)) / 100}::numeric`);
  // Unknown destination: home rate; any other country is outside the EU (export, 0 %).
  return Prisma.sql`(CASE upper(COALESCE(trim(${country}), '')) WHEN '' THEN ${home}::numeric ${Prisma.join(cases, " ")} ELSE 0::numeric END)`;
}

/* ------------------------------------------------------------------ */
/* Reduced rates (VAT categories)                                      */
/* ------------------------------------------------------------------ */

/**
 * VAT categories a variant can be put in, with the rate (percent) per destination where it is
 * known (2026 rates of the common reduced categories). A destination missing from a category's
 * table uses its standard rate and is counted as "rate unknown" in the coverage. "standard" is the
 * default of every variant.
 */
export const VAT_CATEGORIES = {
  standard: { label: "Taux normal", rates: {} as Readonly<Record<string, number>> },
  food: {
    label: "Alimentation (hors alcool)",
    rates: { FR: 5.5, MC: 5.5, BE: 6, DE: 7, NL: 9, AT: 10, IT: 10, ES: 10, PT: 6, LU: 3, IE: 0 } as Readonly<Record<string, number>>,
  },
  books: {
    label: "Livres (papier et numériques)",
    rates: { FR: 5.5, MC: 5.5, BE: 6, DE: 7, NL: 9, AT: 10, IT: 4, ES: 4, PT: 6, LU: 3, IE: 0 } as Readonly<Record<string, number>>,
  },
  intermediate: { label: "Taux intermédiaire 10 % (France)", rates: { FR: 10, MC: 10 } as Readonly<Record<string, number>> },
  press: { label: "Presse / médicaments remboursables 2,1 % (France)", rates: { FR: 2.1, MC: 2.1 } as Readonly<Record<string, number>> },
} as const;
export type VatCategory = keyof typeof VAT_CATEGORIES;

export function isVatCategory(v: unknown): v is VatCategory {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(VAT_CATEGORIES, v);
}

/**
 * Rate (fraction) of a category for a delivery country, and whether the category's rate is known
 * there (false: the standard rate was used). Same destination rules as vatRate. Pure.
 */
export function categoryVatRate(category: string | null | undefined, country: string | null | undefined, opts: VatOptions = {}): { rate: number; known: boolean } {
  const std = vatRate(country, opts);
  if (opts.vatExempt || !category || category === "standard" || !isVatCategory(category)) return { rate: std, known: true };
  const homeCc = (opts.homeCountry ?? HOME_COUNTRY).toUpperCase();
  const cc = country?.trim().toUpperCase();
  // Exports stay at 0 %; an unknown destination and EU sales under the OSS threshold use the home rates.
  if (cc && !EU_VAT_AREA.has(cc)) return { rate: 0, known: true };
  const taxedIn = !cc || opts.domesticOnly ? homeCc : cc;
  const pct = (VAT_CATEGORIES[category].rates as Record<string, number>)[taxedIn];
  return pct == null ? { rate: std, known: false } : { rate: pct / 100, known: true };
}

/**
 * Rate of an order whose lines may carry reduced categories: the lines' rates weighted by their
 * amounts (quantity × unit price). Without priced lines, the destination's standard rate. Pure.
 */
export function blendedVatRate(
  lines: { variantId?: string | null; quantity: number; unitPriceCents: number }[],
  categoryOf: (variantId: string) => string | null | undefined,
  country: string | null | undefined,
  opts: VatOptions = {},
): { rate: number; known: boolean } {
  let weight = 0;
  let sum = 0;
  let known = true;
  for (const l of lines) {
    const w = Math.max(0, l.quantity) * Math.max(0, l.unitPriceCents);
    if (!w) continue;
    const r = categoryVatRate(l.variantId ? categoryOf(l.variantId) : null, country, opts);
    known &&= r.known;
    weight += w;
    sum += w * r.rate;
  }
  return weight ? { rate: sum / weight, known } : { rate: vatRate(country, opts), known: true };
}

/**
 * SQL rate (fraction) of a category expression for a country expression: the category's known rate
 * at the place of taxation, else vatRateSql's rate. Same rules as categoryVatRate.
 */
export function categoryVatRateSql(country: Prisma.Sql, category: Prisma.Sql, vatExempt = false, homeCountry = HOME_COUNTRY, domesticOnly = false): Prisma.Sql {
  const std = vatRateSql(country, vatExempt, homeCountry, domesticOnly);
  if (vatExempt) return std;
  const home = homeCountry.toUpperCase();
  const cc = Prisma.sql`upper(COALESCE(trim(${country}), ''))`;
  // Place of taxation: home for an unknown destination (and every EU one under the OSS threshold).
  const taxed = domesticOnly ? Prisma.sql`${home}::text` : Prisma.sql`(CASE WHEN ${cc} = '' THEN ${home}::text ELSE ${cc} END)`;
  const branches = (Object.keys(VAT_CATEGORIES) as VatCategory[])
    .filter((k) => k !== "standard" && Object.keys(VAT_CATEGORIES[k].rates).length)
    .map((k) => {
      const rates = VAT_CATEGORIES[k].rates as Record<string, number>;
      const whens = Object.entries(rates).map(([c, pct]) => Prisma.sql`WHEN ${c} THEN ${pct / 100}::numeric`);
      return Prisma.sql`WHEN ${k} THEN (CASE ${taxed} ${Prisma.join(whens, " ")} ELSE ${std} END)`;
    });
  // Exports (known country outside the EU VAT area) stay at the standard expression's 0 %.
  return Prisma.sql`(CASE WHEN ${cc} <> '' AND ${cc} NOT IN (${Prisma.join([...EU_VAT_AREA])}) THEN ${std} ELSE (CASE ${category} ${Prisma.join(branches, " ")} ELSE ${std} END) END)`;
}

/** SQL boolean: the category's rate is known at the place of taxation (standard, exports and exempt stores always are). */
export function categoryVatKnownSql(country: Prisma.Sql, category: Prisma.Sql, vatExempt = false, homeCountry = HOME_COUNTRY, domesticOnly = false): Prisma.Sql {
  if (vatExempt) return Prisma.sql`true`;
  const home = homeCountry.toUpperCase();
  const cc = Prisma.sql`upper(COALESCE(trim(${country}), ''))`;
  const taxed = domesticOnly ? Prisma.sql`${home}::text` : Prisma.sql`(CASE WHEN ${cc} = '' THEN ${home}::text ELSE ${cc} END)`;
  const branches = (Object.keys(VAT_CATEGORIES) as VatCategory[])
    .filter((k) => k !== "standard")
    .map((k) => {
      const known = Object.keys(VAT_CATEGORIES[k].rates);
      return Prisma.sql`WHEN ${k} THEN ${known.length ? Prisma.sql`${taxed} IN (${Prisma.join(known)})` : Prisma.sql`false`}`;
    });
  return Prisma.sql`(CASE WHEN ${cc} <> '' AND ${cc} NOT IN (${Prisma.join([...EU_VAT_AREA])}) THEN true ELSE (CASE ${category} ${Prisma.join(branches, " ")} ELSE true END) END)`;
}
