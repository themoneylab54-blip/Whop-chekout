/**
 * Deterministic fr-FR money/number formatting for client components.
 *
 * `Intl` output depends on the ICU build: Node and Chromium disagree on spaces (U+00A0 vs
 * U+202F) and on compact notation ("12 k €" vs "12 k€"), which breaks hydration (#418) when a
 * client component formats on both sides. These helpers use no Intl at all, so the server
 * render and the browser render are byte-identical.
 */

const NBSP = " ";
/** fr-FR thousands separator (narrow no-break space), as modern ICU prints it. */
const GROUP = " ";

const SYMBOLS: Record<string, string> = {
  EUR: "€",
  USD: "$US",
  GBP: "£GB",
  CHF: "CHF",
  CAD: "$CA",
  AUD: "$AU",
  JPY: "JPY",
  SEK: "SEK",
  NOK: "NOK",
  DKK: "DKK",
  PLN: "PLN",
};

function symbol(currency: string) {
  return SYMBOLS[currency.toUpperCase()] ?? currency.toUpperCase();
}

function group(intDigits: string) {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
}

/** 1234.5 → "1 234,5" (at most `decimals` decimals, trailing zeros trimmed unless `fixed`). */
function num(value: number, decimals: number, fixed = false) {
  const neg = value < 0;
  const [i, d = ""] = Math.abs(value).toFixed(decimals).split(".");
  const dec = fixed ? d : d.replace(/0+$/, "");
  return `${neg ? "−" : ""}${group(i)}${dec ? `,${dec}` : ""}`;
}

/** 1234 → "1 234". */
export function stableNumber(n: number): string {
  return num(Math.round(n), 0);
}

/** 123450 cents → "1 235 €". */
export function stableCentsRound(cents: number, currency: string): string {
  return `${num(Math.round(cents / 100), 0)}${NBSP}${symbol(currency)}`;
}

/** 123450 cents → "1 234,50 €". */
export function stableCents(cents: number, currency: string): string {
  return `${num(cents / 100, 2, true)}${NBSP}${symbol(currency)}`;
}

/** 1234500 cents → "12,3 k €" (axis labels). */
export function stableCentsCompact(cents: number, currency: string): string {
  const v = cents / 100;
  const abs = Math.abs(v);
  const s = symbol(currency);
  if (abs < 1_000) return `${num(Math.round(v), 0)}${NBSP}${s}`;
  if (abs < 1_000_000) return `${num(v / 1_000, 1)}${NBSP}k${NBSP}${s}`;
  if (abs < 1_000_000_000) return `${num(v / 1_000_000, 1)}${NBSP}M${NBSP}${s}`;
  return `${num(v / 1_000_000_000, 1)}${NBSP}Md${NBSP}${s}`;
}

/** "3 commandes" / "1 commande" (French: 0 and 1 are singular). */
export function stablePlural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${stableNumber(n)} ${Math.abs(n) > 1 ? pluralWord : word}`;
}
