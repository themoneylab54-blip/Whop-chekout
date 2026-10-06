import { countryName, DEFAULT_COUNTRIES, localeCountries, type Lang } from "@/components/checkout/i18n";

/**
 * The country a checkout language falls back to (last resort of the pre-selected country). English
 * is spoken in many markets: the USA (the largest), and a store's dedicated rate beats it
 * (LANGUAGE_AMBIGUOUS, pickFirstCountry).
 */
export const LANG_COUNTRY: Record<string, string> = { fr: "FR", en: "US", de: "DE", es: "ES", it: "IT", nl: "NL" };

/** Languages that don't point to one country: the store's dedicated rate says more about the buyer. */
const LANGUAGE_AMBIGUOUS: ReadonlySet<string> = new Set(["en"]);

/**
 * The checkout's country list, as its select shows it (CheckoutView): every country when an active
 * rate has none, else the active rates' own, sorted by name in the checkout's language. Pure.
 */
export function checkoutCountries(rates: { countries: string[]; active?: boolean }[], language: Lang): { code: string; name: string }[] {
  const active = rates.filter((r) => r.active !== false);
  const all = active.some((r) => r.countries.length === 0);
  const list = all ? DEFAULT_COUNTRIES : [...new Set(active.flatMap((r) => r.countries))];
  return (list.length ? list : DEFAULT_COUNTRIES)
    .map((c) => ({ code: c, name: countryName(c, language) }))
    .sort((a, b) => a.name.localeCompare(b.name, language));
}

/** Whether one of these (active) rates ships to `code` (a rate without countries ships to the default list). Pure. */
export function shipsToCountry(rates: readonly { countries: readonly string[] }[], code: string): boolean {
  return rates.some((r) => (r.countries.length ? r.countries : DEFAULT_COUNTRIES).includes(code));
}

/**
 * What the checkout page (c/[id]/page.tsx) knows before rendering about the visitor's country: whether
 * the IP country is shipped to (`served`), else the browser locale's shipped country. When neither,
 * the store's main market is needed (`needsPrimary`). Pure.
 */
export function countryHints(rates: { countries: string[] }[], ipCountry: string | null, acceptLanguage: string | null): { served: boolean; localeCountry: string | null; needsPrimary: boolean } {
  const shipsTo = (code: string) => shipsToCountry(rates, code);
  const served = ipCountry != null && shipsTo(ipCountry);
  const localeCountry = served ? null : (localeCountries(acceptLanguage).find(shipsTo) ?? null);
  return { served, localeCountry, needsPrimary: !served && !localeCountry };
}

/**
 * Countries most checkouts sell to, in order: when nothing about the visitor or the store points
 * to one, the first of these the store ships to, before the list's alphabetically first (« Algérie »
 * in French, « Afghanistan » in English…), which is almost never the buyer's.
 */
export const POPULAR_COUNTRIES = ["US", "FR", "GB", "DE", "CA", "AU", "ES", "IT", "BE", "NL", "CH", "IE", "AT", "PT", "SE", "DK", "NO", "FI", "PL", "NZ", "LU"] as const;

/**
 * The store's own market from its shipping setup, known without any lookup: the first country of
 * the first dedicated rate in the merchant's order (`position`, else the list's order) — an active
 * home-delivery rate with one or two countries — e.g. US for "USA 4,90 $ + International 14,90 $".
 * Pickup rates are skipped (a relay network says little about who buys). Null when every rate
 * ships to many countries or everywhere: a long typed list's first code (often alphabetical) says
 * nothing. Pure.
 */
export function storeMarketOf(rates: readonly { countries: readonly string[]; active?: boolean; kind?: string | null; position?: number | null }[]): string | null {
  const ordered = rates
    .map((r, i) => ({ r, at: r.position ?? i, i }))
    .sort((x, y) => x.at - y.at || x.i - y.i)
    .map((x) => x.r);
  const dedicated = ordered.find((r) => r.active !== false && r.kind !== "pickup" && r.countries.length > 0 && r.countries.length <= 2);
  return dedicated?.countries[0] ?? null;
}

/**
 * The country the checkout pre-selects (CheckoutView's first address, hence its first /prepare): the
 * IP country when shipped to, else the browser locale's country, else the store's main market (its
 * paid orders), else the language's country, else its shipping setup's dedicated country
 * (`rateCountry`: known even when the main market lookup times out; it comes before the language
 * when that language is spoken in many markets: an English checkout with a UK rate is British), else the most common market it ships to,
 * else the first listed — never just the alphabetically first while anything better is known. Pure.
 */
export function pickFirstCountry(
  countries: readonly string[],
  hints: { initialCountry?: string | null; localeCountry?: string | null; primaryCountry?: string | null; rateCountry?: string | null; language?: string | null },
): string {
  const has = (code: string | null | undefined) => (code && countries.includes(code) ? code : null);
  return (
    has(hints.initialCountry) ??
    has(hints.localeCountry) ??
    has(hints.primaryCountry) ??
    (hints.language && LANGUAGE_AMBIGUOUS.has(hints.language) ? has(hints.rateCountry) : null) ??
    // The checkout's language says more about the buyer than the shipping setup, when shipped to.
    has(hints.language ? LANG_COUNTRY[hints.language] : null) ??
    has(hints.rateCountry) ??
    POPULAR_COUNTRIES.find((c) => countries.includes(c)) ??
    countries[0] ??
    "FR"
  );
}
