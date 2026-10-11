import type { Labels } from "./i18n";

/*
 * The checkout languages and their helpers, without the texts themselves (i18n holds those, all six
 * languages, for the server and the dashboard): what the buyer's page imports. Pure.
 */

/**
 * What the average shown above imported reviews covers: true = every published review (full
 * Judge.me import, store-wide Shopify metafields), "file" = every review of the imported CSV,
 * { recent } = only the N most recent reviews read (partial Judge.me import; N pre-formatted),
 * "store" = every published review of the store (Shopify metafields of the active products),
 * "store-partial" = part of them (Shopify read capped at 2 000 products or cut short).
 */
export type ReviewsNoteSummary = boolean | "file" | "store" | "store-partial" | { recent: string };

/** The six checkout languages. */
export const LANG_CODES = ["fr", "en", "de", "es", "it", "nl"] as const;
export type Lang = (typeof LANG_CODES)[number];
export const LANGS: { code: Lang; label: string }[] = [
  { code: "fr", label: "Français" },
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "es", label: "Español" },
  { code: "it", label: "Italiano" },
  { code: "nl", label: "Nederlands" },
];

/** BCP-47 locale for number/date formatting. */
export function localeOf(lang: Lang): string {
  return { fr: "fr-FR", en: "en-US", de: "de-DE", es: "es-ES", it: "it-IT", nl: "nl-NL" }[lang] ?? "fr-FR";
}

/** Localized message for an API error code, falling back to the server text. */
export function errorText(L: Pick<Labels, "errors" | "error">, body: { code?: string; error?: string } | null | undefined): string {
  return (body?.code && L.errors[body.code]) || body?.error || L.error;
}

/** Brand names of payment methods (same in every language). */
const METHOD_BRANDS: Record<string, string> = {
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  paypal: "PayPal",
  klarna: "Klarna",
  afterpay_clearpay: "Afterpay / Clearpay",
  affirm: "Affirm",
  alma: "Alma",
  oney_3x: "Oney 3x",
  oney_4x: "Oney 4x",
  scalapay: "Scalapay",
  bancontact: "Bancontact",
  ideal: "iDEAL",
  twint: "TWINT",
  eps: "EPS",
  p24: "Przelewy24",
  blik: "BLIK",
  crypto: "Crypto",
  whop_pay: "Whop Pay",
  cashapp: "Cash App Pay",
};

/** Buyer-facing name of a Whop payment method type ("card" → "Carte bancaire"). */
export function paymentMethodName(type: string | null | undefined, L: Pick<Labels, "methodCard" | "methodSepa" | "methodBank">): string | null {
  if (!type) return null;
  const t = type.toLowerCase();
  if (t === "card" || t === "credit_card" || t === "debit_card") return L.methodCard;
  if (t === "sepa_debit" || t === "sepa") return L.methodSepa;
  if (t === "bank_transfer" || t === "customer_balance") return L.methodBank;
  return METHOD_BRANDS[t] ?? t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Countries offered when a shipping rate covers "all countries". */
export const DEFAULT_COUNTRIES = [
  "FR", "BE", "CH", "LU", "MC", "DE", "AT", "NL", "ES", "PT", "IT", "IE", "GB", "DK", "SE", "NO", "FI",
  "PL", "CZ", "SK", "HU", "RO", "BG", "GR", "HR", "SI", "EE", "LV", "LT", "CY", "MT", "IS",
  "US", "CA", "AU", "NZ", "JP", "SG", "HK", "AE", "IL", "MA", "TN", "DZ", "SN", "CI", "RE", "GP", "MQ", "GF", "YT", "NC", "PF",
];

// Server (Node ICU) and browsers disagree on a few names: pin them to avoid hydration mismatches.
const PINNED_NAMES: Record<string, string> = { HK: "Hong Kong", MO: "Macao", PS: "Palestine" };

export function countryName(code: string, lang: Lang) {
  if (PINNED_NAMES[code]) return PINNED_NAMES[code];
  try {
    return new Intl.DisplayNames([lang], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** First supported language in an Accept-Language header (or navigator.languages), French by default. */
export function pickLang(prefs: string | readonly string[] | null | undefined): Lang {
  const list = typeof prefs === "string" ? prefs.split(",").map((p) => p.split(";")[0]) : (prefs ?? []);
  for (const raw of list) {
    const code = raw.trim().slice(0, 2).toLowerCase();
    if (isLang(code)) return code;
  }
  return "fr";
}

/** True for one of the six checkout languages. */
export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && (LANG_CODES as readonly string[]).includes(v);
}

/**
 * Best supported language of an Accept-Language header, honouring q-values
 * ("de-CH;q=0.9, en;q=0.8" → "de"); null when none of the six is accepted.
 */
export function matchAcceptLanguage(header: string | null | undefined): Lang | null {
  if (!header) return null;
  const prefs = header
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const qp = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const q = qp ? Number(qp.slice(2)) : 1;
      return { code: tag.trim().slice(0, 2).toLowerCase(), q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((p) => p.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return prefs.find((p) => isLang(p.code))?.code as Lang | undefined ?? null;
}

/** Cookie remembering the language a buyer picked with the footer switcher (checkout origin, /c). */
export const LANG_COOKIE = "wc_lang";

/**
 * Checkout language: `?lang=` → the buyer's earlier choice (cookie) → Accept-Language
 * best match → the store's default.
 */
export function resolveCheckoutLang(input: {
  query?: string | string[] | null;
  cookie?: string | null;
  acceptLanguage?: string | null;
  fallback: Lang;
}): Lang {
  const q = Array.isArray(input.query) ? input.query[0] : input.query;
  if (isLang(q)) return q;
  if (isLang(input.cookie)) return input.cookie;
  return matchAcceptLanguage(input.acceptLanguage) ?? input.fallback;
}

/**
 * Countries named by the browser's locales, most preferred first: "de-DE,de;q=0.9,en-US;q=0.8"
 * → ["DE", "US"]. Language-only tags ("de") and script/numeric regions ("zh-Hant", "es-419")
 * name no country. Used to pre-select the shipping country when the IP country is unknown.
 */
export function localeCountries(acceptLanguage: string | null | undefined): string[] {
  if (!acceptLanguage) return [];
  const tags = acceptLanguage
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((t) => t.tag && t.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  const out: string[] = [];
  for (const { tag } of tags) {
    const region = tag
      .split(/[-_]/)
      .slice(1)
      .find((s) => /^[a-z]{2}$/i.test(s));
    const code = region?.toUpperCase();
    if (code && !out.includes(code)) out.push(code);
  }
  return out;
}
