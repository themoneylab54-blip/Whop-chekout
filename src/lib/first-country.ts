import { countryName, DEFAULT_COUNTRIES, localeCountries, type Lang } from "@/components/checkout/i18n";

/** The country a checkout language falls back to (last resort of the pre-selected country). */
export const LANG_COUNTRY: Record<string, string> = { fr: "FR", en: "GB", de: "DE", es: "ES", it: "IT", nl: "NL" };

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

/**
 * What the checkout page (c/[id]/page.tsx) knows before rendering about the visitor's country: whether
 * the IP country is shipped to (`served`), else the browser locale's shipped country. When neither,
 * the store's main market is needed (`needsPrimary`). Pure.
 */
export function countryHints(rates: { countries: string[] }[], ipCountry: string | null, acceptLanguage: string | null): { served: boolean; localeCountry: string | null; needsPrimary: boolean } {
  const shipsTo = (code: string) => rates.some((r) => (r.countries.length ? r.countries : DEFAULT_COUNTRIES).includes(code));
  const served = ipCountry != null && shipsTo(ipCountry);
  const localeCountry = served ? null : (localeCountries(acceptLanguage).find(shipsTo) ?? null);
  return { served, localeCountry, needsPrimary: !served && !localeCountry };
}

/**
 * The country the checkout pre-selects (CheckoutView's first address, hence its first /prepare): the
 * IP country when shipped to, else the browser locale's country, else the store's main market, else
 * the language's country, else the first listed — never just the alphabetically first. Pure.
 */
export function pickFirstCountry(
  countries: readonly string[],
  hints: { initialCountry?: string | null; localeCountry?: string | null; primaryCountry?: string | null; language?: string | null },
): string {
  const has = (code: string | null | undefined) => (code && countries.includes(code) ? code : null);
  return (
    has(hints.initialCountry) ??
    has(hints.localeCountry) ??
    has(hints.primaryCountry) ??
    has(hints.language ? LANG_COUNTRY[hints.language] : null) ??
    countries[0] ??
    "FR"
  );
}
