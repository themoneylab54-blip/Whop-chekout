/*
 * Best-slot ranking of the day × hour heatmap. Pure (shared by the component and the tests).
 *
 * A raw conversion rate over a handful of checkouts is noise (2 paid out of 3 = 67 %). Slots are
 * ranked by the lower bound of the 95 % Wilson score interval of their conversion, and only slots
 * with at least BEST_SLOT_MIN_CHECKOUTS opened checkouts are candidates.
 */

export const BEST_SLOT_MIN_CHECKOUTS = 30;

/** Lower bound of the Wilson score interval of k successes out of n (z = 1.96 → 95 %). */
export function wilsonLowerBound(k: number, n: number, z = 1.96): number {
  if (n <= 0) return 0;
  const p = Math.min(1, Math.max(0, k / n));
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export type HeatSlot = { dow: number; hour: number; sessions: number; orders: number; revenueHtCents: number };

/**
 * The `limit` best slots: by Wilson lower bound of the conversion ("conversion"), or by CA HT
 * ("revenue"), among slots with ≥ minCheckouts checkouts. `score` is what the ranking used.
 */
export function bestSlots<T extends HeatSlot>(
  cells: T[],
  metric: "conversion" | "revenue",
  limit = 3,
  minCheckouts = BEST_SLOT_MIN_CHECKOUTS,
): { cell: T; score: number; rate: number }[] {
  return cells
    .filter((c) => c.sessions >= minCheckouts)
    .map((c) => ({ cell: c, rate: c.orders / c.sessions, score: metric === "revenue" ? c.revenueHtCents : wilsonLowerBound(c.orders, c.sessions) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.cell.sessions - a.cell.sessions)
    .slice(0, limit);
}
