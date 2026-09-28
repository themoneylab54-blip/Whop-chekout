import { localeOf, type Lang } from "./i18n";

/*
 * "≈ 52,30 CHF" under the total for buyers whose country pays in another currency.
 * Informative only: the card is charged in the checkout currency, the bank converts.
 * Pure (no server import): rates are computed on the checkout page from @/lib/fx.
 */

/** Countries whose buyers get the estimate, and their currency. */
export const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  CH: "CHF",
  GB: "GBP",
  SE: "SEK",
  DK: "DKK",
  NO: "NOK",
  PL: "PLN",
  CZ: "CZK",
  HU: "HUF",
  RO: "RON",
  // Bulgaria pays in euros since 2026-01-01: no estimate.
  US: "USD",
  CA: "CAD",
};

/** Multiplier from the checkout currency to each local currency (only those with a known rate). */
export type LocalRates = Record<string, number>;

/** Currencies nobody writes with cents: shown rounded to the unit. */
const NO_DECIMALS = new Set(["HUF", "CZK"]);

/**
 * Builds the multipliers for every local currency at once from a cross-rate function
 * (e.g. `(from, to) => crossRate(from, to, ecb.rates)`); the checkout currency itself is left out.
 */
export function localRatesFor(checkoutCurrency: string, cross: (from: string, to: string) => number | null): LocalRates {
  const from = checkoutCurrency.toUpperCase();
  const out: LocalRates = {};
  for (const cur of new Set(Object.values(COUNTRY_CURRENCY))) {
    if (cur === from) continue;
    const r = cross(from, cur);
    if (r != null && Number.isFinite(r) && r > 0) out[cur] = r;
  }
  return out;
}

/**
 * The estimate line's amount ("52,30 CHF" in the checkout's locale) and currency, or null when
 * the country pays in the checkout currency, isn't listed, or has no rate.
 */
export function localEstimate(
  totalCents: number,
  country: string | null | undefined,
  checkoutCurrency: string,
  rates: LocalRates | null | undefined,
  lang: Lang,
): { amount: string; currency: string } | null {
  const cur = country ? COUNTRY_CURRENCY[country.toUpperCase()] : undefined;
  if (!cur || !rates || cur === checkoutCurrency.toUpperCase() || totalCents <= 0) return null;
  const rate = rates[cur];
  if (!rate || !Number.isFinite(rate) || rate <= 0) return null;
  const value = (totalCents / 100) * rate;
  const digits = NO_DECIMALS.has(cur) ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {};
  try {
    return { amount: new Intl.NumberFormat(localeOf(lang), { style: "currency", currency: cur, currencyDisplay: "code", ...digits }).format(value), currency: cur };
  } catch {
    return null;
  }
}
