/**
 * Decimal fields typed by French merchants ("4,7", "2,5 %"): parsed as text so a comma is
 * never silently dropped by <input type="number">, and never clamped behind their back.
 */
export type DecimalParse =
  | { kind: "empty" }
  | { kind: "ok"; value: number }
  | { kind: "invalid" }
  | { kind: "range"; value: number };

/** "4,7" | "4.7" | " 4,70 " | "2,5 %" → number; out-of-range values are reported, not capped. */
export function parseDecimal(raw: string, opts: { min?: number; max?: number } = {}): DecimalParse {
  const v = raw.replace(/[\s  %]/g, "");
  if (!v) return { kind: "empty" };
  if (!/^[+-]?(\d+([.,]\d*)?|[.,]\d+)$/.test(v)) return { kind: "invalid" };
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n)) return { kind: "invalid" };
  if ((opts.min != null && n < opts.min) || (opts.max != null && n > opts.max)) return { kind: "range", value: n };
  return { kind: "ok", value: n };
}

/** 4.7 → "4,7" (French decimal comma, no trailing zeros, no grouping). */
export function formatDecimalField(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return String(Math.round(value * 1000) / 1000).replace(".", ",");
}

/** "0 à 5" with French decimals, for inline range errors. */
export function decimalRangeLabel(min?: number, max?: number): string {
  if (min != null && max != null) return `entre ${formatDecimalField(min)} et ${formatDecimalField(max)}`;
  if (min != null) return `supérieure ou égale à ${formatDecimalField(min)}`;
  if (max != null) return `inférieure ou égale à ${formatDecimalField(max)}`;
  return "";
}

/** Rating block: a score of 0 means "no rating", not a real one; the editor asks for 1 to 5. */
export const RATING_MIN_SCORE = 1;
/** Below this, a displayed rating tends to hurt more than it helps. */
export const RATING_LOW_SCORE = 3.5;

/** Warning under the rating's score field (null when the score is fine or not set). */
export function ratingScoreWarning(score: number | null | undefined): string | null {
  if (score == null || !Number.isFinite(score) || score < RATING_MIN_SCORE) return null;
  return score < RATING_LOW_SCORE ? "Une note basse peut freiner l'achat : affichez-la seulement si elle aide vos clients à décider." : null;
}

/** Largest review count accepted (a typo guard, far above any real store). */
export const MAX_REVIEW_COUNT = 10_000_000;

export type CountParse = { kind: "empty" } | { kind: "ok"; value: number } | { kind: "invalid" } | { kind: "range"; value: number };

/**
 * A whole number typed as text: digits, optionally grouped by spaces ("1 250", "12 500", with
 * normal, non-breaking or narrow spaces). Anything else ("1,5", "1.250", "abc", "-3") is invalid.
 */
export function parseCount(raw: string, opts: { max?: number } = {}): CountParse {
  const v = raw.trim();
  if (!v) return { kind: "empty" };
  if (!/^\d{1,3}(?:[   ]?\d{3})*$|^\d+$/.test(v)) return { kind: "invalid" };
  const n = Number(v.replace(/[   ]/g, ""));
  if (!Number.isSafeInteger(n)) return { kind: "invalid" };
  if (opts.max != null && n > opts.max) return { kind: "range", value: n };
  return { kind: "ok", value: n };
}

/** 1250 → "1 250" (plain spaces, easy to edit again). */
export function formatCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "";
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
