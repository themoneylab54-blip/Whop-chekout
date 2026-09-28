import type { DayFlagKind } from "./chartFlags";

/*
 * Caveats of a chart day, shared by the Overview and Analytics charts (same wording, same pattern):
 * the automatic Shopify fallback and / or the Whop checkout switched off by hand. Pure.
 */

export const FALLBACK_FLAG = "Checkout Shopify de secours actif : ventes hors de ce checkout";
export const DISABLED_FLAG = "Checkout Whop désactivé : ventes sur le checkout Shopify, hors de ce checkout";

/** Tooltip remark of a flagged day (undefined when the day has no caveat). */
export function dayFlag(d: { fallback?: boolean; disabled?: boolean }): string | undefined {
  return [d.fallback && FALLBACK_FLAG, d.disabled && DISABLED_FLAG].filter(Boolean).join(" · ") || undefined;
}

/** Which caveat, for the pattern of the shaded day and the chart legend. */
export function dayFlagKind(d: { fallback?: boolean; disabled?: boolean }): DayFlagKind | undefined {
  return d.fallback && d.disabled ? "both" : d.disabled ? "disabled" : d.fallback ? "fallback" : undefined;
}
