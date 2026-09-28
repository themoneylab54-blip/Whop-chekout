/*
 * Prefill of a shipping-protection claim's cost ("Coût pour vous"): a reship costs the selected
 * replacement items at their purchase cost (unit cost × quantity) plus the carrier cost of the
 * order's shipping rate. Items without a known cost are left out and reported. Pure (shared by the
 * server page and the client field).
 */

export type ClaimCostItem = { key: string; /** Unit cost × quantity; null when unknown. */ costCents: number | null };

export function claimCostEstimate(
  items: ClaimCostItem[],
  selected: ReadonlySet<string> | null,
  carrierCents: number | null,
): { cents: number; missing: number; itemsCents: number; carrierCents: number } {
  const chosen = selected ? items.filter((i) => selected.has(i.key)) : items;
  const itemsCents = chosen.reduce((t, i) => t + (i.costCents ?? 0), 0);
  const missing = chosen.filter((i) => i.costCents == null).length;
  const carrier = chosen.length && carrierCents != null ? Math.max(0, carrierCents) : 0;
  return { cents: itemsCents + carrier, missing, itemsCents, carrierCents: carrier };
}

/** 1850 → "18,50" (the claim field's format). Pure. */
export function centsToField(cents: number): string {
  return (Math.max(0, Math.round(cents)) / 100).toFixed(2).replace(".", ",");
}
