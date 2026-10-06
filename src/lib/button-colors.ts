import type { Theme } from "./layout";
import { bestTextOn, contrastRatio, readableOn } from "./contrast";

/*
 * Button colors of the checkout and thank-you pages, as CSS variables set on the page root
 * (CheckoutView themeVars):
 *  - --pay-*  : the Pay button and the sticky « Continuer vers le paiement » (pay flow),
 *  - --btn-*  : every other primary button (Ajouter, upsell accept, button link, Continuer mes achats…),
 *  - --btn2-* : secondary buttons (discount « Appliquer »), outline (as before) or solid.
 * Every color left empty follows the accent: the values are then exactly the accent ones
 * (--accent-bg / --accent-fg / --btn-shadow as they were), so older stores look identical.
 * Express wallets (Apple Pay, Google Pay, PayPal) keep their brand colors and use none of these.
 */

type ButtonTheme = Pick<
  Theme,
  "accentColor" | "accentColor2" | "buttonShadow" | "payButtonColor" | "payButtonColor2" | "payButtonTextColor" | "buttonColor" | "buttonTextColor" | "secondaryButtonStyle"
>;

const HEX = /^#[0-9a-f]{6}$/i;
const hex = (v: string | undefined | null) => (v && HEX.test(v) ? v : "");

/** The gradient a button paints (a flat "gradient" for a single color, as --accent-bg always was). */
export function buttonGradient(c1: string, c2: string): string {
  return c2 ? `linear-gradient(135deg, ${c1}, ${c2})` : `linear-gradient(${c1}, ${c1})`;
}

/** Drop shadow tinted with the button's own color (same recipe as the accent one). */
export function buttonShadow(c: string, on: boolean): string {
  return on ? `0 10px 24px -10px ${c}b3, inset 0 1px 0 rgba(255,255,255,.18)` : "none";
}

/** Colors the Pay button really uses: its own, else the accent (with the accent's gradient). */
export function payButtonColors(t: ButtonTheme): { bg: string; bg2: string; fg: string } {
  const own = hex(t.payButtonColor);
  const bg = own || t.accentColor;
  const bg2 = own ? hex(t.payButtonColor2) : hex(t.accentColor2);
  // Automatic text: on the merchant's own color, the more readable of black / white (both ends);
  // on the accent, the accent's rule as before (stores without own colors look identical).
  return { bg, bg2, fg: hex(t.payButtonTextColor) || (own ? bestTextOn(bg, bg2) : readableOn(bg)) };
}

/** Colors of the other primary buttons: their own, else the accent (with the accent's gradient). */
export function otherButtonColors(t: ButtonTheme): { bg: string; bg2: string; fg: string } {
  const own = hex(t.buttonColor);
  const bg = own || t.accentColor;
  const bg2 = own ? "" : hex(t.accentColor2);
  return { bg, bg2, fg: hex(t.buttonTextColor) || (own ? bestTextOn(bg) : readableOn(bg)) };
}

export function buttonVars(t: ButtonTheme): Record<string, string> {
  const pay = payButtonColors(t);
  const btn = otherButtonColors(t);
  const solid = t.secondaryButtonStyle === "solid";
  return {
    "--pay-bg": buttonGradient(pay.bg, pay.bg2),
    "--pay-fg": pay.fg,
    "--pay-shadow": buttonShadow(pay.bg, t.buttonShadow),
    "--btn-bg": buttonGradient(btn.bg, btn.bg2),
    "--btn-fg": btn.fg,
    // Outline buttons (button link « Contour »): border and text in the button color.
    "--btn-color": btn.bg,
    "--btn-shadow": buttonShadow(btn.bg, t.buttonShadow),
    // Secondary: outline = white, neutral-300 border, neutral-900 text (neutral-500 disabled), as before.
    "--btn2-bg": solid ? buttonGradient(btn.bg, btn.bg2) : "linear-gradient(#ffffff, #ffffff)",
    "--btn2-fg": solid ? btn.fg : "#171717",
    "--btn2-border": solid ? "transparent" : "#d4d4d4",
    "--btn2-off-fg": solid ? btn.fg : "#737373",
    "--btn2-off-opacity": solid ? "0.6" : "1",
  };
}

/** Builder hint: black or white text, whichever reads better on the button (both gradient ends). */
export function suggestTextColor(bg: string, bg2 = ""): "#111111" | "#ffffff" {
  return bestTextOn(bg, bg2);
}

/** Lowest contrast of a button label over its background (both gradient ends). */
export function buttonContrast(bg: string, bg2: string, fg: string): number {
  return Math.min(...[bg, bg2].filter((c) => HEX.test(c)).map((c) => contrastRatio(fg, c)));
}
