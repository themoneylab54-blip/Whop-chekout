/**
 * Shared fr-FR formatters for the dashboard: one place for numbers, money, percents and dates,
 * so every page reads "16,7 %" and "1 234,50 €" the same way.
 */

const LOCALE = "fr-FR";
const TZ = "Europe/Paris";

const intFmt = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const pctFmt = new Intl.NumberFormat(LOCALE, { style: "percent", minimumFractionDigits: 0, maximumFractionDigits: 1 });
const moneyCache = new Map<string, Intl.NumberFormat>();

function moneyFmt(currency: string, variant: "full" | "round" | "compact") {
  const key = `${currency}:${variant}`;
  let f = moneyCache.get(key);
  if (!f) {
    f =
      variant === "compact"
        ? new Intl.NumberFormat(LOCALE, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1, signDisplay: "negative" })
        : // signDisplay "negative": an amount that rounds to zero reads "0 €", never "-0 €".
          new Intl.NumberFormat(LOCALE, { style: "currency", currency, maximumFractionDigits: variant === "round" ? 0 : 2, signDisplay: "negative" });
    moneyCache.set(key, f);
  }
  return f;
}

/** 1234 → "1 234". */
export function formatNumber(n: number): string {
  return intFmt.format(n);
}

/** 0.1667 → "16,7 %". */
export function formatPercent(ratio: number): string {
  return pctFmt.format(ratio);
}

/** 123450 cents → "1 234,50 €". */
export function formatCents(cents: number, currency: string): string {
  return moneyFmt(currency, "full").format(cents / 100);
}

/** 123450 cents → "1 235 €" (no decimals, for KPIs and tooltips). */
export function formatCentsRound(cents: number, currency: string): string {
  return moneyFmt(currency, "round").format(cents / 100);
}

/** 1234500 cents → "12,3 k €" (axis labels). */
export function formatCentsCompact(cents: number, currency: string): string {
  return moneyFmt(currency, "compact").format(cents / 100);
}

/** Relative change between two periods, or null when there is nothing to compare with. */
export function delta(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return (current - previous) / Math.abs(previous);
}

/** +0.125 → "+12,5 %", −0.3 → "−30 %". */
export function formatDelta(ratio: number): string {
  const s = formatPercent(Math.abs(ratio));
  // A change that rounds to 0 is shown as "0 %", never "−0 %" / "+0 %".
  if (s === formatPercent(0)) return s;
  return ratio > 0 ? `+${s}` : ratio < 0 ? `−${s}` : s;
}

/**
 * A deduction ("Frais Whop −12,00 €"): "−" + amount, but a zero reads "0,00 €" (never "−0,00 €")
 * and a negative deduction (a credit) reads "+…".
 */
export function formatDeduction(cents: number, format: (cents: number) => string): string {
  if (cents === 0 || Object.is(cents, -0)) return format(0);
  return cents > 0 ? `−${format(cents)}` : `+${format(-cents)}`;
}

/** "28/09/2026 14:05" in the store's time zone (Paris by default). */
export function formatDateTime(d: Date, withSeconds = false, tz: string = TZ): string {
  return d.toLocaleString(LOCALE, { dateStyle: "short", timeStyle: withSeconds ? "medium" : "short", timeZone: tz });
}

/** "28/09/2026" in the store's time zone (Paris by default). */
export function formatDate(d: Date, tz: string = TZ): string {
  return d.toLocaleDateString(LOCALE, { timeZone: tz });
}

/** "s" when n > 1 (French plural: 0 and 1 are singular). */
export function plural(n: number, word: string, pluralWord = `${word}s`): string {
  return `${formatNumber(n)} ${Math.abs(n) > 1 ? pluralWord : word}`;
}
