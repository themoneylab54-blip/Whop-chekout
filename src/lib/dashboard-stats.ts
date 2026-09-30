import "server-only";
import { addDays, tzOf } from "./time";
import type { Prisma } from "@prisma/client";
import { db } from "./db";
import { PROVIDER_STORE_SELECT, storeLive, storeReady } from "./payment-provider";
import { crossRate, ecbRates, type FxRates } from "./fx";
import { dailySeries, includeTestFor, resolveRange, storeAnalytics, storeSummary, summaryAnomalies, type Analytics, type Anomaly, type DayRange, type StoreSummary, type SummaryFigures } from "./analytics";

/** One merchant day (Europe/Paris) of the overview chart and sparklines. */
export type DayStats = {
  /** "YYYY-MM-DD" in Paris. */
  date: string;
  /** CA TTC net of refunds (offers included) of the orders paid that day. */
  revenueCents: number;
  revenueHtCents: number;
  /** Profit of that day's orders (CA HT − fees − costs). */
  profitCents: number;
  /** The storefront was on Shopify's own checkout (fallback) during part of the day. */
  fallback?: boolean;
  /** The checkout was switched off by hand during part of the day (sales on Shopify's checkout). */
  disabled?: boolean;
  /** Paid orders (counted on paidAt). */
  orders: number;
  /** Checkouts opened that day (counted on createdAt). */
  started: number;
  /** Checkouts opened that day and not paid. */
  abandoned: number;
};

export type OverviewStats = {
  /** Same numbers as the Analytics page for the same period and test filter. */
  analytics: Analytics;
  /** Every day of the chart window (≥ 7 days, ending with the period), oldest first, zero-filled. */
  daily: DayStats[];
};

/**
 * Overview numbers: a thin layer over `storeAnalytics` so both pages always agree, plus a
 * daily series over at least 7 days (so "today" still shows a trend).
 */
export async function overviewStats(storeId: string, range: DayRange, includeTest: boolean, chartDays = 7): Promise<OverviewStats> {
  const chartFrom = range.days >= chartDays ? range.from : addDays(range.to, -(chartDays - 1));
  const [analytics, series] = await Promise.all([
    storeAnalytics(storeId, { since: range.since, until: range.until, prevSince: range.prevSince, includeTest }),
    range.days >= chartDays ? null : dailySeries(storeId, chartFrom, range.to, includeTest),
  ]);
  const daily = (series ?? analytics.daily).map((d) => ({
    date: d.day,
    revenueCents: d.revenueCents,
    revenueHtCents: d.revenueHtCents,
    profitCents: d.netCents,
    fallback: d.fallback,
    disabled: d.disabled,
    orders: d.orders,
    started: d.sessions,
    abandoned: d.abandoned,
  }));
  return { analytics, daily };
}

/* ------------------------------------------------------------------ */
/* Cross-store view                                                    */
/* ------------------------------------------------------------------ */

export const STORE_SORTS = ["name", "ca", "orders", "cvr", "margin", "spend", "roas", "poas", "net", "netfixed"] as const;
export type StoreSort = (typeof STORE_SORTS)[number];

export type CrossStoreRow = {
  id: string;
  name: string;
  currency: string;
  live: boolean;
  /** Shopify and Whop connected (health checks apply). */
  ready: boolean;
  testMode: boolean;
  includeTest: boolean;
  summary: StoreSummary;
  /** Same alerts as the store's Analytics page, for the period. */
  anomalies: Anomaly[];
  /** Profit after ads per Paris day of the period (store currency). */
  daily: { day: string; netAfterAdsCents: number }[];
};

type TotalKeys = "orders" | "revenueHtCents" | "profitCents" | "spendCents" | "netAfterAdsCents" | "fixedCostsCents" | "netAfterFixedCents";

export type CrossStoreTotals = {
  /** Currency of the totals: the stores' one, or EUR when they differ (converted at the ECB rate). */
  currency: string;
  converted: boolean;
  /** Reference date of the ECB rates used, when converted. */
  rateDate: string | null;
  /** Stores left out because no rate was available for their currency. */
  skipped: string[];
  now: Pick<SummaryFigures, TotalKeys>;
  previous: Pick<SummaryFigures, TotalKeys>;
  estimated: boolean;
  /** Profit after ads of all stores per Paris day (totals currency). */
  daily: { day: string; netAfterAdsCents: number }[];
};

const sortValue: Record<Exclude<StoreSort, "name">, (s: StoreSummary) => number | null> = {
  ca: (s) => s.revenueHtCents,
  orders: (s) => s.orders,
  cvr: (s) => (s.visitors ? s.cvr : null),
  margin: (s) => s.profitCents,
  spend: (s) => s.spendCents,
  roas: (s) => s.roas,
  poas: (s) => s.poas,
  net: (s) => s.netAfterAdsCents,
  netfixed: (s) => s.netAfterFixedCents,
};

/** Sorts store rows (missing values last, whatever the direction). Pure: exported for tests. */
export function sortStores<T extends { name: string; summary: StoreSummary }>(rows: T[], sort: StoreSort, dir: "asc" | "desc"): T[] {
  const k = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort === "name") return k * a.name.localeCompare(b.name, "fr");
    const va = sortValue[sort](a.summary);
    const vb = sortValue[sort](b.summary);
    if (va == null && vb == null) return a.name.localeCompare(b.name, "fr");
    if (va == null) return 1;
    if (vb == null) return -1;
    return k * (va - vb) || a.name.localeCompare(b.name, "fr");
  });
}

/**
 * Totals across stores. Same currency → plain sums; otherwise every amount is converted to EUR
 * with `rates` (ECB, units per EUR); stores whose currency has no rate are left out (listed).
 * Pure: exported for tests.
 */
export function crossStoreTotals(rows: (Pick<CrossStoreRow, "name" | "currency" | "summary"> & { daily?: CrossStoreRow["daily"] })[], rates: FxRates | null): CrossStoreTotals {
  const currencies = new Set(rows.map((r) => r.currency.toUpperCase()));
  const converted = currencies.size > 1;
  const currency = converted ? "EUR" : (rows[0]?.currency ?? "EUR");
  const keys = ["orders", "revenueHtCents", "profitCents", "spendCents", "netAfterAdsCents", "fixedCostsCents", "netAfterFixedCents"] as const;
  const zero = (): Pick<SummaryFigures, TotalKeys> => ({ orders: 0, revenueHtCents: 0, profitCents: 0, spendCents: 0, netAfterAdsCents: 0, fixedCostsCents: 0, netAfterFixedCents: 0 });
  const now = zero();
  const previous = zero();
  const skipped: string[] = [];
  const daily = new Map<string, number>();
  let estimated = false;
  for (const r of rows) {
    const rate = converted ? (rates ? crossRate(r.currency, "EUR", rates.rates) : null) : 1;
    if (rate == null) {
      skipped.push(r.name);
      continue;
    }
    for (const k of keys) {
      now[k] += k === "orders" ? r.summary[k] : Math.round((r.summary[k] ?? 0) * rate);
      previous[k] += k === "orders" ? r.summary.previous[k] : Math.round((r.summary.previous[k] ?? 0) * rate);
    }
    for (const d of r.daily ?? []) daily.set(d.day, (daily.get(d.day) ?? 0) + Math.round(d.netAfterAdsCents * rate));
    if (!r.summary.complete || !r.summary.previous.complete) estimated = true;
  }
  return {
    currency,
    converted,
    rateDate: converted ? (rates?.date ?? null) : null,
    skipped,
    now,
    previous,
    estimated,
    daily: [...daily.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, netAfterAdsCents]) => ({ day, netAfterAdsCents })),
  };
}

/**
 * The period of the cross-store view in a store's own time zone: the same days (a preset such as
 * "7 derniers jours" ends on that zone's today), so its summary and its daily series count the same
 * orders as its own Analytics page. Pure.
 */
export function storeRange(range: DayRange, tz: string): DayRange {
  return resolveRange(range.key === "custom" ? { range: "custom", from: range.from, to: range.to } : { range: range.key }, undefined, "30d", tz);
}

/** Every store's summary for a period (+ the previous one) and the totals: the cross-store page and its CSV. */
export async function crossStoreStats(
  range: DayRange,
  // The stores the viewer may open (accessibleStoreWhere); default every store.
  where: Prisma.StoreWhereInput = {},
): Promise<{ rows: CrossStoreRow[]; totals: CrossStoreTotals; zones: string[] }> {
  const stores = await db.store.findMany({
    where,
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, shopCurrency: true, enabled: true, shopifyConnectedAt: true, timezone: true, ...PROVIDER_STORE_SELECT },
  });
  const rows = await Promise.all(
    stores.map(async (s) => {
      const includeTest = includeTestFor(s);
      // Each store's own days (its time zone), never Paris days applied to a store elsewhere.
      const own = storeRange(range, tzOf(s));
      const [summary, series] = await Promise.all([storeSummary(s.id, own, includeTest), dailySeries(s.id, own.from, own.to, includeTest)]);
      return {
        id: s.id,
        name: s.name,
        currency: s.shopCurrency,
        // Any processor able to charge (a Stripe-only store never connects Whop).
        live: storeLive(s),
        ready: storeReady(s),
        testMode: s.testMode,
        includeTest,
        summary,
        anomalies: summaryAnomalies(summary),
        daily: series.map((d) => ({ day: d.day, netAfterAdsCents: d.netCents - d.spendCents })),
      };
    }),
  );
  const multi = new Set(rows.map((r) => r.currency.toUpperCase())).size > 1;
  const rates = multi ? await ecbRates() : null;
  return { rows, totals: crossStoreTotals(rows, rates), zones: [...new Set(stores.map((s) => tzOf(s)))] };
}
