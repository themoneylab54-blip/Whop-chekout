import type { Lang } from "./i18n-core";

/*
 * Whop's card form ends with its own footer, « Propulsé par Whop | Conditions | Confidentialité ».
 * Whop gives merchants no setting to remove it (its page carries a per-checkout flag,
 * whop_checkout_branding, that Whop alone sets), so a store that chose to hide it gets the bottom of
 * the form's frame clipped by the footer's height. The frame is another site's page (nothing inside
 * can be read or styled), so that height comes from Whop's layout, measured (Chromium, Whop's Inter at
 * 12 px, line-height 1.2, on Whop's real form in every checkout language): the footer is the form's
 * last element, a centered row that wraps — one line, or two on a narrow frame. The server lets the
 * checkout clip only while Whop's own page still draws this exact footer for that store
 * (lib/whop-footer): any change there and the footer simply shows.
 *
 * Not seen by that check: a change of Whop's styles alone (same markup), and a variant Whop would show
 * some buyers only (by cookie). Whop's fonts are allowed for (TEXT_WIDER, TEXT_NARROWER).
 */

/**
 * Whop's footer per checkout language, as Whop writes and draws it: its words (« … Whop », the terms
 * and privacy links) and the one-line widths (px) of its items (« … » with Whop's logo, the divider,
 * the two links). The widths are these words': a word changed is a width to measure again.
 */
export const WHOP_FOOTER: Record<Lang, { powered: string; terms: string; privacy: string; widths: readonly number[] }> = {
  fr: { powered: "Propulsé par Whop", terms: "Conditions", privacy: "Confidentialité", widths: [139.78, 1, 60.84, 82.14] },
  en: { powered: "Powered by Whop", terms: "Terms", privacy: "Privacy", widths: [134.88, 1, 35.41, 42.05] },
  de: { powered: "Angetrieben von Whop", terms: "Bedingungen", privacy: "Datenschutz", widths: [161.64, 1, 75.27, 71.31] },
  es: { powered: "Impulsado por Whop", terms: "Términos", privacy: "Privacidad", widths: [148.97, 1, 52.61, 59.91] },
  it: { powered: "Powered by Whop", terms: "Termini", privacy: "Privacy", widths: [134.88, 1, 41.98, 42.05] },
  nl: { powered: "Aangedreven door Whop", terms: "Voorwaarden", privacy: "Privacy", widths: [172.97, 1, 75.81, 42.05] },
};

/** Gap between the footer's items, and between its lines (gap-4). */
const GAP = 16;
/** Whop's padding on each side of its form (its default, checked by the server). */
const PAD_X = 16;
/** Above the footer (mt-3). */
const MARGIN_TOP = 12;
/** The line holding the divider (h-4); the other lines are text only (12 px × 1.2). */
const DIVIDER_LINE = 16;
const TEXT_LINE = 14.4;
/** Under the footer, Whop's empty last element after its column gap (gap-6). */
const BELOW = 24;
/** Above the footer is a blank gap (24 px, 8 px under Whop's terms line): a few of its pixels are clipped too (rounding, never content). */
const SAFETY = 3;
/** Whop's logo in the first item (1.1em high, after a 4 px margin): the same whatever the font. */
const LOGO = 64.34;
/**
 * How much wider or narrower than measured Whop's text may come out with the answer still sure.
 * Measured (Chromium, Whop's own CSS): while Whop's Inter loads, its fallback draws the text within
 * +1 % (Arial, size-adjusted: iOS, macOS, Windows) or 5 to 7 % narrower (Roboto: Android, where there
 * is no Arial); browsers draw Inter itself within about 1 % of each other. A wider text can only add
 * a line, and a sliver of the footer shows (the safe side). A narrower one can save a line, and the
 * clip, then a line too tall, would cut into the form above the footer (its total, Whop's terms
 * line): a wider margin on that side.
 */
const TEXT_WIDER = 1.02;
const TEXT_NARROWER = 0.91;
/** How much the frame may be narrowed (each side) to stay clear of a wrap point. */
const MAX_INSET = 8;

/** Lines of a centered, wrapping row of items `widths` (gap `GAP`) in `available` px, and whether the divider sits on the first one. Pure. */
export function footerLines(widths: readonly number[], available: number): { lines: number; dividerFirst: boolean } {
  let lines = 1;
  let used = 0;
  let dividerLine = 1;
  widths.forEach((w, i) => {
    if (used > 0 && used + GAP + w > available) {
      lines++;
      used = w;
    } else used = used > 0 ? used + GAP + w : w;
    if (i === 1) dividerLine = lines;
  });
  return { lines, dividerFirst: dividerLine === 1 };
}

/** The footer's item widths with their text `k` times as wide (Whop's logo and the divider unchanged). Pure. */
export function withTextScaled(widths: readonly number[], k: number): number[] {
  return widths.map((w, i) => (i === 0 ? LOGO + (w - LOGO) * k : i === 1 ? w : w * k));
}

/**
 * How to show Whop's form without its footer in a frame `width` px wide: `inset`, px of padding
 * on each side (the frame narrowed just enough when its width sits too close to a wrap point), and
 * `clip`, px cut off the bottom of the frame. Null when the language isn't measured, the frame is too
 * narrow for the measured layouts (one or two lines), or no width nearby gives a sure answer (the
 * footer then shows). Pure.
 */
export function whopFooterFit(lang: string, width: number): { inset: number; clip: number } | null {
  const widths = WHOP_FOOTER[lang as Lang]?.widths;
  if (!widths || !(width > 0)) return null;
  for (let inset = 0; inset <= MAX_INSET; inset++) {
    const available = width - 2 * inset - 2 * PAD_X;
    const at = footerLines(widths, available);
    // Narrowing the frame only adds lines: past two, no measured layout left.
    if (at.lines > 2) return null;
    // Sure only when the same lines come out with the text a little wider and notably narrower.
    if (footerLines(withTextScaled(widths, TEXT_WIDER), available).lines !== at.lines) continue;
    if (footerLines(withTextScaled(widths, TEXT_NARROWER), available).lines !== at.lines) continue;
    if (!at.dividerFirst) return null;
    const row = DIVIDER_LINE + (at.lines - 1) * (GAP + TEXT_LINE);
    return { inset, clip: Math.ceil(BELOW + MARGIN_TOP + row + SAFETY) };
  }
  return null;
}
