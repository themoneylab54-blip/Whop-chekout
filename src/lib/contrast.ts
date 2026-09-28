import type { Theme } from "./layout";

/*
 * WCAG 2.x contrast of a checkout theme. Mirrors how components/checkout/CheckoutView.tsx
 * paints the page (themeVars / StoreHeader): button text is black or white by perceived
 * brightness, secondary text is the text color mixed 70/30 with white, cards are white,
 * placeholders are the text color at 65% over the field.
 */

const HEX = /^#[0-9a-f]{6}$/i;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: [number, number, number]) {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`;
}

export function luminance(hex: string): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = rgb(hex);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  if (!HEX.test(a) || !HEX.test(b)) return 1;
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Same rule as CheckoutView's readableOn: text drawn on a brand color. */
export function readableOn(hex: string): "#111111" | "#ffffff" {
  const [r, g, b] = rgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? "#111111" : "#ffffff";
}

/** color-mix(in srgb, a p%, b): the checkout's --muted is the text color 70% + white. */
export function mix(a: string, b: string, p: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex([0, 1, 2].map((i) => x[i] * p + y[i] * (1 - p)) as [number, number, number]);
}

const STATUS_COLORS: [string, string][] = [
  ["savings text", "#007a55"],
  ["error text", "#c10007"],
  ["stock text", "#ca3500"],
];

/** StoreHeader's "Ma boutique" color on a dark header. */
export const HEADER_PLACEHOLDER_ON_DARK = "#d4d4d4";
/** globals.css: .wc-input::placeholder is the text color at 65% opacity. */
const PLACEHOLDER_ALPHA = 0.65;

/** WCAG 1.4.11: a form field's boundary against what surrounds it. */
export const FIELD_BOUNDARY_MIN = 3;

/**
 * Border drawn around form fields (--field-border, globals.css .wc-input): the theme's border
 * color when it already stands out 3:1 against the form background, else that color darkened
 * toward the text color just enough to. Dividers and cards keep the lighter --border.
 */
export function fieldBorderColor(theme: Pick<Theme, "borderColor" | "textColor" | "formBackground" | "pageBackground">): string {
  const around = theme.formBackground || theme.pageBackground || "#ffffff";
  const border = HEX.test(theme.borderColor) ? theme.borderColor : "#d4d4d8";
  if (!HEX.test(theme.textColor) || contrastRatio(border, around) >= FIELD_BOUNDARY_MIN) return border;
  for (let p = 0.05; p < 1; p += 0.05) {
    const c = mix(theme.textColor, border, p);
    if (contrastRatio(c, around) >= FIELD_BOUNDARY_MIN) return c;
  }
  return theme.textColor;
}

export type ContrastCheck = { what: string; fg: string; bg: string; ratio: number; min: number };

/** Every text / button pairing the checkout draws with this theme, with its AA minimum. */
export function themeContrastChecks(theme: Theme): ContrastCheck[] {
  const page = theme.pageBackground || "#ffffff";
  const surfaces: [string, string][] = [
    ["page", page],
    ["form", theme.formBackground || page],
    ["summary", theme.summaryBackground || page],
    // Cards (reviews, badges, add-ons…) are always white.
    ["card", "#ffffff"],
  ];
  const muted = mix(theme.textColor, "#ffffff", 0.7);
  const checks: ContrastCheck[] = [];
  const add = (what: string, fg: string, bg: string, min: number) => checks.push({ what, fg, bg, ratio: contrastRatio(fg, bg), min });
  for (const [name, bg] of surfaces) {
    add(`text on ${name}`, theme.textColor, bg, 4.5);
    add(`muted text on ${name}`, muted, bg, 4.5);
    // Brand-colored text and icons (links, "brand" block text, check marks)
    add(`accent on ${name}`, theme.accentColor, bg, 4.5);
    // Fixed status colors drawn straight on the theme's surfaces (Tailwind v4 palette):
    // savings / success (emerald-700), errors (red-700), low stock (orange-700).
    for (const [label, fg] of STATUS_COLORS) add(`${label} on ${name}`, fg, bg, 4.5);
  }
  const onAccent = readableOn(theme.accentColor);
  add("button text on accent", onAccent, theme.accentColor, 4.5);
  if (theme.accentColor2) {
    // Gradient buttons: the label must read on both ends.
    add("button text on accent 2", onAccent, theme.accentColor2, 4.5);
    // Gradient-clipped stat numbers (large bold text)
    add("accent 2 on card", theme.accentColor2, "#ffffff", 3);
  }
  // Store name in the header: white on dark headers, else the text color.
  const darkHeader = readableOn(theme.headerBackground) === "#ffffff";
  const headerText = darkHeader ? "#ffffff" : theme.textColor;
  add("store name on header", headerText, theme.headerBackground, 4.5);
  // "Ma boutique" placeholder of a store without a name (StoreHeader): light grey on dark headers, else muted.
  add("store name placeholder on header", darkHeader ? HEADER_PLACEHOLDER_ON_DARK : muted, theme.headerBackground, 4.5);
  // Form fields (globals.css .wc-input): white, filled (text 5% over white) or underlined (no fill).
  const inputBg = theme.inputStyle === "filled" ? mix(theme.textColor, "#ffffff", 0.05) : theme.inputStyle === "underline" ? theme.formBackground || page : "#ffffff";
  add("input text", theme.textColor, inputBg, 4.5);
  add("input placeholder", mix(theme.textColor, inputBg, PLACEHOLDER_ALPHA), inputBg, 4.5);
  // Field boundary (non-text, 3:1): outlined, filled and underlined fields all keep a real
  // border (globals.css), measured against the form background around them.
  add("field border on form", fieldBorderColor(theme), theme.formBackground || page, FIELD_BOUNDARY_MIN);
  return checks;
}

export function contrastFailures(theme: Theme): ContrastCheck[] {
  return themeContrastChecks(theme).filter((c) => c.ratio < c.min);
}
