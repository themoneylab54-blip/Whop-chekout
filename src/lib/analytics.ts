import "server-only";
import { stopForTime } from "./deadline";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { recordEvent } from "./log";
import { CAMPAIGN_ROWS, DETAIL_PREFIX, spendCoverage, spendLevel } from "./adspend";
import { addDays, DEFAULT_TZ, tzOf, zonedDay, zonedDayStart, zonedHour } from "./time";
import { sqlTimeZone } from "./time-db";
import { customersBackfillStatus, externalCoveredUntil, externalImportStatus, externalLastCompletedAt, externalScope, type CustomersBackfill } from "./shopify-history";
import { categoryVatKnownSql, categoryVatRateSql, HOME_COUNTRY, vatRate, vatRateSql } from "./vat";
import { loadThankYouLayout, offerHasB, parseArmKey, type BlockOf } from "./layout";
import { offerArmAggregates, offerTests, type OfferTest } from "./offer-tests";
import {
  MIN_TEST_DAYS,
  analyze,
  autoPromoteThreshold,
  decide,
  remainingDays,
  PRIMARY_METRIC_LABEL,
  type Decision,
  type PrimaryMetric,
  type VariantStats,
  type Verdict,
} from "./experiments";

export { autoPromoteThreshold };

/*
 * Checkout analytics: the one metric engine behind the overview, the Analytics page, the
 * cross-store view and the exports. Everything is a SQL aggregate (no row cap).
 *
 * Definitions (identical everywhere):
 *  - Days are Paris calendar days; a period is [Paris midnight of `from`, Paris midnight after `to`).
 *  - Money is counted on the payment date (paidAt) of PAID checkouts. One-click offers belong to
 *    their order (same date). Revenue is net of refunds.
 *  - "CA TTC" = amount paid − refunds; "CA HT" = CA TTC ÷ (1 + standard VAT rate of the delivery
 *    country; 0 for VAT-exempt stores; home-country rate when unknown; the French rate for every
 *    EU destination when the store sells under the OSS threshold), rounded per order.
 *  - Profit = CA HT − Whop fees − product costs (lines + offers) − order-bump costs − carrier
 *    cost − fulfilment fee. Unknown costs count as 0 and make the result "incomplete". A fully
 *    refunded order that was never shipped (no tracking number) has no product, carrier or
 *    fulfilment cost.
 *  - Traffic (checkouts, visitors, funnel) is counted on the opening date (createdAt).
 *    "Conversion checkout" = visitors with a paid checkout ÷ unique visitors who opened a checkout.
 *  - Ad spend totals use campaign-level rows only (ad set / ad rows feed the creative table).
 *  - Test checkouts are excluded unless the store is in test mode (or asked for).
 *  - Filters (source, country, device) apply to every metric.
 */

/* ------------------------------------------------------------------ */
/* Periods (Paris days, DST-safe)                                      */
/* ------------------------------------------------------------------ */

/** UTC instant of 00:00 on a "YYYY-MM-DD" day in the store's time zone (Paris by default). */
export function parisDayStart(day: string, tz = DEFAULT_TZ): Date {
  return zonedDayStart(day, tz);
}

export const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDay(v: unknown): v is string {
  if (typeof v !== "string" || !DAY_RE.test(v)) return false;
  const d = new Date(`${v}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Number of Paris days in [from, to], inclusive. */
export function dayCount(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}

export function daysBetween(from: string, to: string): string[] {
  const n = Math.max(0, dayCount(from, to));
  return Array.from({ length: n }, (_, i) => addDays(from, i));
}

export const PRESETS = {
  today: { label: "Aujourd'hui", long: "aujourd'hui" },
  yesterday: { label: "Hier", long: "hier" },
  "7d": { label: "7 j", long: "7 derniers jours" },
  "30d": { label: "30 j", long: "30 derniers jours" },
  "90d": { label: "90 j", long: "90 derniers jours" },
} as const;
export type PresetKey = keyof typeof PRESETS;

export type DayRange = {
  key: PresetKey | "custom";
  /** Inclusive Paris days. */
  from: string;
  to: string;
  days: number;
  label: string;
  since: Date;
  until: Date;
  prevFrom: string;
  prevTo: string;
  prevSince: Date;
  /** Set when a custom range was invalid and the default was used. */
  error?: string;
};

const MAX_DAYS = 366;

/** Paris-day range from the ?range= / ?from=&to= search params (defaults to 30 days). */
export function resolveRange(sp: { range?: string; from?: string; to?: string }, todayIn?: string, fallback: PresetKey = "30d", tz = DEFAULT_TZ): DayRange {
  const today = todayIn ?? zonedDay(new Date(), tz);
  let key: DayRange["key"] = sp.range && sp.range in PRESETS ? (sp.range as PresetKey) : fallback;
  let from: string;
  let to: string;
  let error: string | undefined;
  if (sp.range === "custom" || (!sp.range && (sp.from || sp.to))) {
    const f = sp.from;
    const t = sp.to || today;
    if (!isDay(f) || !isDay(t)) error = "Dates invalides : format attendu JJ/MM/AAAA.";
    else if (f > t) error = "La date de début doit précéder la date de fin.";
    else if (t > today) error = "La date de fin ne peut pas être dans le futur.";
    else if (dayCount(f, t) > MAX_DAYS) error = "Période trop longue : 366 jours maximum.";
    if (!error) {
      key = "custom";
      from = f as string;
      to = t;
    }
  }
  if (key !== "custom" || error) {
    if (key === "custom") key = fallback;
    const k = key as PresetKey;
    to = k === "yesterday" ? addDays(today, -1) : today;
    const n = k === "today" || k === "yesterday" ? 1 : Number.parseInt(k, 10);
    from = addDays(to, -(n - 1));
  }
  const days = dayCount(from!, to!);
  const prevTo = addDays(from!, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  const fmt = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
  return {
    key,
    from: from!,
    to: to!,
    days,
    label: key === "custom" ? (from! === to! ? fmt(from!) : `${fmt(from!)} – ${fmt(to!)}`) : PRESETS[key].long,
    since: parisDayStart(from!, tz),
    until: parisDayStart(addDays(to!, 1), tz),
    prevFrom,
    prevTo,
    prevSince: parisDayStart(prevFrom, tz),
    error,
  };
}

/* Paid-ad touches (storefront loader → session route) */

export const TOUCH_KEYS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "utm_id", "fbclid", "gclid", "gbraid", "wbraid", "ttclid", "msclkid"]);

/**
 * Keeps the known keys of a touch; drops it when older than `days` (null: no limit) or dated in
 * the future. Touches without "ts" (older loaders, current page's URL) are kept as they are.
 */
export function touchWithin(raw: Record<string, string> | undefined, days: number | null, now = Date.now()): Record<string, string> | null {
  if (!raw) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) if (TOUCH_KEYS.has(k) && v.trim()) out[k] = v;
  if (!Object.keys(out).length) return null;
  const ts = Number(raw.ts);
  if (raw.ts != null) {
    if (!Number.isFinite(ts) || ts > now + 86_400_000) return null;
    if (days != null && now - ts > days * 86_400_000) return null;
    out.ts = new Date(ts).toISOString();
  }
  return out;
}

/** Test orders are shown only when the store itself is in test mode (unless forced). */
export function includeTestFor(store: { testMode: boolean }, param?: string): boolean {
  return param === "1" || (param !== "0" && store.testMode);
}

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type Filters = {
  source?: string;
  /** Shipping country (address typed on the checkout). */
  country?: string;
  device?: "mobile" | "desktop";
  /** Checkout language ("fr", "en"… or "inconnu"). */
  lang?: string;
  /**
   * Visitor's country (IP geolocation at checkout opening only; "inconnu" without one):
   * the dimension of the "conversion par pays du visiteur" funnel, distinct from `country`.
   */
  geo?: string;
};

export type Period = {
  since: Date;
  until: Date;
  includeTest: boolean;
  filters?: Filters;
  /** Start of the comparison period (ends at `since`); defaults to the same duration. */
  prevSince?: Date;
};

export type CostPart = "fees" | "products" | "bumps" | "shipping";

export type MoneyTotals = {
  orders: number;
  /** Amount paid (orders + offers), before refunds, VAT included. */
  grossCents: number;
  refundedCents: number;
  /** Refunds excluding VAT (order-date basis). */
  refundedHtCents: number;
  /** Amount paid − refunds, before lost disputes (TTC / HT). */
  paidNetCents: number;
  paidNetHtCents: number;
  /** Lost disputes (money taken back by the bank), TTC and HT. */
  disputeLostCents: number;
  disputeLostHtCents: number;
  /** Disputed orders + offers (any outcome) and their bank fees (store.disputeFeeCents each). */
  disputes: number;
  disputeFeesCents: number;
  /** CA TTC: net of refunds and lost disputes, VAT included. */
  revenueCents: number;
  /** CA HT. */
  revenueHtCents: number;
  vatCents: number;
  upsellRevenueCents: number;
  upsellAccepted: number;
  feesCents: number;
  productCostCents: number;
  bumpCostCents: number;
  shippingCostCents: number;
  fulfilmentCents: number;
  /** Shipping-protection claims paid by the merchant (reship / refund) on the period's orders, and their number. */
  claimsCents: number;
  claims: number;
  /** CA HT − fees − all costs − dispute fees − protection claims. */
  profitCents: number;
  /** Share of cost inputs that are known (fees, units, bumps, shipping). */
  coverage: Record<CostPart, number>;
  missing: CostPart[];
  complete: boolean;
};

export type PlatformValueMode = "revenue" | "profit" | "unknown";

/** Buyers' Shopify order history (new vs returning beyond this app's orders): backfill state. */
export type CustomerHistory = { state: "none" | "running" | "done" | "error"; customers: number; error?: string };

export type FunnelGroup = { group: string; sessions: number; visitors: number; paidVisitors: number; funnel: { key: string; label: string; count: number }[] };

export type Analytics = {
  currency: string;
  vatExempt: boolean;
  sessions: number;
  visitors: number;
  paidVisitors: number;
  orders: number;
  revenueCents: number;
  revenueHtCents: number;
  vatCents: number;
  grossCents: number;
  upsellRevenueCents: number;
  feesCents: number;
  feesKnown: boolean;
  /** Net TTC ÷ orders (offers included). */
  aovCents: number;
  aovHtCents: number;
  /** Paid visitors ÷ visitors. */
  cvr: number;
  /** Paid checkouts ÷ checkouts opened. */
  checkoutCvr: number;
  abandoned: number;
  money: MoneyTotals;
  profit: {
    cogsCents: number;
    bumpCostCents: number;
    shippingCostCents: number;
    fulfilmentCents: number;
    /** Shipping-protection claims (reship / refund). */
    claimsCents: number;
    costCoverage: number;
    grossProfitCents: number;
    /** Profit ÷ CA HT. */
    marginRate: number;
    complete: boolean;
    missing: CostPart[];
  };
  ads: {
    /** False when a country/device filter is active: spend can't be split that way. */
    available: boolean;
    spendCents: number;
    platforms: { platform: string; spendCents: number }[];
    /** CA HT ÷ spend. */
    roas: number | null;
    /** Spend ÷ orders. */
    cpaCents: number | null;
    /** Profit ÷ spend. */
    poas: number | null;
    /** Break-even ROAS HT of the period (1 ÷ margin rate before ads). */
    breakEvenRoas: number | null;
    /** Break-even CPA: margin per order before ads of the period (null without orders). */
    breakEvenCpaCents: number | null;
    /** Verdict of all the ads of the view (same sample-size rule as the rows). */
    verdict: AdVerdict | null;
    /** Blended new-customer CAC: all spend of the period ÷ new customers (first order on the store). */
    blendedCacCents: number | null;
    newCustomers: number;
    netAfterAdsCents: number;
    unattributed: { platform: string; campaign: string; spendCents: number }[];
    lastDay: string | null;
    /** Spend rows of the period in another currency than the store's, without exchange rate. */
    unconverted: { rows: number; currencies: string[] };
    /** ROAS HT counting the Shopify orders placed outside this checkout too (the ads also brought them); null without leakage data. */
    roasInclExternal: number | null;
    /** First day from which every connected platform's spend is known (history import), and whether it is still running. */
    coverageFrom: string | null;
    backfilling: boolean;
  };
  previous: {
    sessions: number;
    visitors: number;
    orders: number;
    revenueCents: number;
    revenueHtCents: number;
    cvr: number;
    checkoutCvr: number;
    aovCents: number;
    abandoned: number;
    /** Null when the previous period had no order; an estimate when its costs are incomplete (profitEstimated). */
    profitCents: number | null;
    profitIncomplete: boolean;
    profitEstimated: boolean;
    spendCents: number;
    netAfterAdsCents: number | null;
    roas: number | null;
    refundRate: number;
    tx: number;
  };
  /** Monthly fixed costs prorated per day of the period (not split by source/country/device). */
  fixedCosts: { monthlyCents: number; periodCents: number; available: boolean; netAfterFixedCents: number };
  /** Refunds dated in the period (RefundRecord), older refunds without a record at the order date. */
  refundsByDate: { cents: number; htCents: number; count: number; fallbackCents: number; fallbackOrders: number };
  /**
   * Approved shipping-protection claims dated in the period (claim date), whatever the order's
   * date: the "date du remboursement" view of the P&L counts claims like refunds, when they cost.
   */
  claimsByDate: { cents: number; count: number };
  heatmap: { dow: number; hour: number; sessions: number; orders: number; revenueHtCents: number }[];
  /**
   * Funnel per device (mobile / desktop / inconnu), per source (top 4 + "Autres (n)"), per checkout
   * language (top 6 + autres) and per shipping country (top 8 + autres; no address yet = "inconnu").
   */
  funnelBy: { device: FunnelGroup[]; source: FunnelGroup[]; lang: FunnelGroup[]; country: FunnelGroup[] };
  /**
   * Share of the period's checkouts with an IP country (visitor-country funnel). Below
   * GEO_COVERAGE_MIN the per-country rates are hidden: the unknown ones could change them all.
   */
  geoCoverage: { sessions: number; located: number; share: number };
  /** Paid-ad attribution model of the sources table and the store's window. */
  attribution: { touch: "last" | "first"; /** Window applied (days). */ days: number; /** The store's default window (Réglages). */ storeDays: number };
  /**
   * Post-purchase survey ("Comment nous avez-vous connu ?") on the period's paid orders: per answer,
   * orders, CA HT and the UTM source that most of those orders carried.
   */
  survey: {
    orders: number;
    answered: number;
    answers: { answer: string; orders: number; revenueHtCents: number; utm: { source: string; orders: number }[] }[];
  };
  /**
   * Per Paris day (orders on their payment date, like the KPIs). `netCents` = marge nette of the
   * day's orders, and every row adds up exactly:
   *   revenueHtBeforeDisputesCents − disputeLostHtCents = revenueHtCents
   *   revenueHtCents − feesCents − costsCents − disputeFeesCents − claimsCents = netCents
   * `disputesCents` = lost disputes HT + dispute fees (kept for the charts).
   */
  daily: {
    day: string;
    sessions: number;
    abandoned: number;
    orders: number;
    revenueCents: number;
    revenueHtCents: number;
    /** CA HT before lost disputes (paid − refunds). */
    revenueHtBeforeDisputesCents: number;
    vatCents: number;
    feesCents: number;
    /** Products, options, carrier and preparation. */
    costsCents: number;
    disputeLostHtCents: number;
    disputeFeesCents: number;
    disputesCents: number;
    /** Shipping-protection claims (approved) on the day's orders. */
    claimsCents: number;
    netCents: number;
    spendCents: number;
    /** Refunds HT of the day's orders (order-date basis, part of the day's CA HT). */
    refundsHtCents: number;
    /** Refunds HT made that day (RefundRecord date; older refunds without a record: their order's day). */
    refundsByDateHtCents: number;
    /** Approved protection claims decided that day (decision date; merchant-typed claims: their date). */
    claimsByDateCents: number;
    /**
     * Marge nette of the day with refunds and claims on the day they cost ("date du remboursement"):
     * netCents + refundsHtCents − refundsByDateHtCents + claimsCents − claimsByDateCents. Adds up to
     * the P&L's refund-date margin over the period.
     */
    netByRefundDateCents: number;
    /** The storefront was on Shopify's own checkout (fallback) during part of the day. */
    fallback: boolean;
    /** The checkout was switched off by hand (Store.enabled = false) during part of the day. */
    disabled: boolean;
    /**
     * Shopify online-store orders placed outside this checkout that day (sourceName "web": CA HT, count);
     * null on the days the import doesn't cover (before its first day, or never imported): unknown, not 0.
     */
    externalRevenueHtCents: number | null;
    externalOrders: number | null;
  }[];
  timeToPurchase: { medianMin: number | null; p75Min: number | null };
  /**
   * New = first paid order on the store in the period (per e-mail); returning = already paid before.
   * `newCustomers` / `returningCustomers` are distinct buyers (e-mails), the orders are counted apart
   * (a new customer ordering twice in the period is 1 new customer, 1 new order and 1 returning order).
   */
  customers: { newCustomers: number; returningCustomers: number; newOrders: number; returningOrders: number; newRevenueCents: number; returningRevenueCents: number };
  /**
   * Returning also counts buyers who had ordered on the Shopify store before (native checkout,
   * before this app): from the order this app created (shopifyPriorOrders) and the one-time customers
   * backfill (ShopifyCustomer). `shopifyReturningOrders` = orders returning only because of that history.
   */
  customerHistory: CustomerHistory & { shopifyReturningOrders: number };
  /**
   * Shopify orders placed outside this checkout on the period (ExternalOrder, imported daily): count
   * and CA (TTC / HT, net of refunds, no costs), and their share of all the store's CA HT. Null when
   * a filter is active (they carry no source, device…) or the store's Shopify isn't connected.
   */
  leakage: {
    /** Online-store orders (Shopify sourceName "web": the storefront's own checkout) of the period. */
    orders: number;
    revenueCents: number;
    revenueHtCents: number;
    /**
     * Web outside CA HT ÷ (this checkout's CA HT + web outside CA HT), over the days the import covers
     * ([max(period start, coveredFrom), period end), whole days): null when it covers none of them.
     */
    share: number | null;
    /** The share and the ROAS incl. outside orders only cover part of the period (from `windowFrom`). */
    partial: boolean;
    windowFrom: string | null;
    /** Online outside orders and CA HT of the days the share / ROAS cover (= the period's unless `partial`). */
    windowOrders: number;
    windowRevenueHtCents: number;
    /** Same, CA TTC (net of refunds). */
    windowRevenueCents: number;
    /** Every channel of the outside orders: web (counted above), POS, draft orders, anything else (apps, mobile…). */
    channels: Record<ExternalChannel, { orders: number; revenueCents: number; revenueHtCents: number }>;
    /** Last daily import run, completed or not (null: never), first day covered, and the last import error. */
    lastImportAt: string | null;
    /** End of the last import run that completed (null: none yet): "Dernier import complet". */
    lastCompletedAt: string | null;
    /**
     * Orders placed before this instant are all imported (start of the last completed run; a later failed or
     * partial run never moves it): a day's leakage is only judged once it is past the day's end.
     */
    coveredUntil: string | null;
    /**
     * Online outside orders placed while the storefront was on Shopify's own checkout (automatic fallback or
     * checkout switched off: FallbackPeriod), in the period, and their CA HT over the share's days: explained
     * leakage, left out of the alert (share of the online CA HT in `fallbackShare`).
     */
    fallbackOrders: number;
    fallbackRevenueHtCents: number;
    fallbackShare: number | null;
    coveredFrom: string | null;
    error: string | null;
  } | null;
  /**
   * Periods when the storefront was on Shopify's own checkout (fallback) overlapping the period: sales
   * of those hours are outside this checkout's figures. `days` = days of the period touched.
   */
  fallback: { periods: { startedAt: string; endedAt: string | null; minutes: number; reason: string | null }[]; days: string[] };
  /** Periods when the checkout was switched off by hand (Store.enabled = false): sales went to Shopify's checkout. */
  disabled: { periods: { startedAt: string; endedAt: string | null; minutes: number; reason: string | null }[]; days: string[] };
  /** Reduced VAT rates (ProductVat): orders with a reduced line, and those whose reduced rate is unknown at the destination (standard rate used). */
  vat: { reduced: boolean; reducedOrders: number; unknownRateOrders: number };
  offers: {
    /** Key of the row: the block id, "<id>:B" for arm B of an A/B-tested offer. */
    blockId: string;
    /** The offer block the row belongs to (arms of one offer share it and are listed together). */
    offerId: string;
    /** Arm of an A/B-tested offer; null when the offer has a single arm on the period. */
    arm: "A" | "B" | null;
    /** Offer title, with " · variante A/B" for the arms of a tested offer (exports). */
    title: string;
    /** Offer title alone (the block's title in the thank-you page). */
    offerTitle: string;
    impressions: number;
    paid: number;
    declined: number;
    failed: number;
    takeRate: number;
    /** Take rate bounds when legacy checkouts make impressions uncertain: [lowest, highest]. */
    takeRateRange: [number, number] | null;
    revenueCents: number;
    revenueHtCents: number;
    /** Marge produit: CA HT − product cost (cost × quantity); null when a cost is missing. */
    marginCents: number | null;
    /** CA HT per impression (upper bound of impressions when estimated). */
    revenuePerImpressionHtCents: number;
    /** Shown only when the buyer declined another offer (target of a declineNextId). */
    downsell: boolean;
    /** Impressions include legacy checkouts that didn't record which offer was shown. */
    estimated: boolean;
  }[];
  funnel: { key: string; label: string; count: number }[];
  failedPayments: number;
  sources: {
    source: string;
    campaign: string;
    sessions: number;
    visitors: number;
    paidVisitors: number;
    orders: number;
    revenueCents: number;
    revenueHtCents: number;
    profitCents: number;
    spendCents: number;
    roas: number | null;
    cpaCents: number | null;
    /** Margin before ads ÷ spend. */
    poas: number | null;
    /** 1 ÷ margin rate before ads of the source's orders (the store's when it has none). */
    breakEvenRoas: number | null;
    verdict: AdVerdict | null;
    profitAfterAdsCents: number;
    other?: boolean;
  }[];
  /** Ad sets and ads (imported from Meta / TikTok) matched to orders by utm_content / utm_term. */
  creatives: CreativeRow[];
  /** Per campaign: what the ad platform reports (purchases, value, ROAS) vs our real orders (see platformVsReal). */
  platformVsReal: {
    platform: string;
    campaign: string;
    /**
     * Value the platform received for these conversions (AdSpend.valueMode): "revenue" (order amount:
     * ROAS), "profit" (margin HT, Store.conversionValueMode "profit": the platform's figure is a POAS,
     * compared to our margin), "unknown" (imported before it was recorded, or the mode changed that day).
     */
    valueMode: PlatformValueMode;
    /** The platform's mode changed within the period: our orders are split by the day each mode was in effect. */
    split: boolean;
    /** Our margin (profit before ads) of the orders counted on this row. */
    realProfitCents: number;
    spendCents: number;
    platformConversions: number;
    platformValueCents: number;
    realOrders: number;
    /** Our CA TTC (net of refunds) of the orders attributed to the campaign. */
    realRevenueCents: number;
    /** The same CA, HT (what every ROAS of the dashboard uses). */
    realRevenueHtCents: number;
    /** The platform's value (TTC: pixels report what the buyer paid), taken HT at our orders' HT ÷ TTC ratio. */
    platformValueHtCents: number;
    /** HT, like the sources table: platform value HT ÷ spend, and our CA HT ÷ spend. */
    platformRoas: number | null;
    realRoas: number | null;
    /** Platform value ÷ our CA, both HT (Infinity: the platform reports sales we have none of). */
    overAttribution: number | null;
    /** The campaign matched a source row (utm_campaign / utm_id); else our orders are unknown (0). */
    matched: boolean;
  }[];
  /**
   * Per Whop payment method: orders, CA, Whop fees (fee rate = fees ÷ gross paid), marge nette of those
   * orders (same definition as the KPI) and how many orders have a known fee.
   */
  methods: {
    method: string;
    orders: number;
    revenueCents: number;
    revenueHtCents: number;
    grossCents: number;
    feesCents: number;
    feeKnownOrders: number;
    profitCents: number;
  }[];
  countries: { country: string; orders: number; revenueCents: number; revenueHtCents: number; vatCents: number; profitCents: number; other?: boolean }[];
  products: {
    other?: boolean;
    productId: string;
    title: string;
    units: number;
    orders: number;
    revenueCents: number;
    revenueHtCents: number;
    /** CA HT − product cost; null when some units have no cost. */
    marginCents: number | null;
    refundRate: number;
  }[];
  addOns: {
    id: string;
    title: string;
    /** Shipping protection (checkout block, no AddOn row): displays aren't recorded, "shown" = orders to ship. */
    protection?: boolean;
    /** Paid orders that took the option. */
    orders: number;
    /** Paid orders that were shown the option (all orders for legacy checkouts: see estimated). */
    shown: number;
    /** Taken ÷ shown. */
    attachRate: number;
    estimated: boolean;
    revenueCents: number;
    revenueHtCents: number;
    costCents: number | null;
    /** CA HT − cost; null when the cost is missing. */
    marginCents: number | null;
  }[];
  /** Shipping protection P&L: its revenue HT on the period's orders − the claims paid on them. Null when never sold nor claimed. */
  protection: { orders: number; revenueHtCents: number; claims: number; claimsCents: number; resultCents: number } | null;
  /** A/B tests of one-click offers (arm B), with the design-test statistics per offer. */
  offerTests: (OfferTest & { offerTitle: string; /** Arm B still live on the thank-you page (can be promoted). */ live: boolean; autoPromote: boolean })[];
  codes: { code: string; orders: number; discountCents: number; revenueCents: number; revenueHtCents: number; profitCents: number; aovCents: number }[];
  upsell: { shown: number; accepted: number; revenueCents: number; legacyShown: number };
  risk: { refundedCents: number; refundRate: number; disputes: number; disputeRate: number; reviewHolds: number; /** Payments (orders + offers). */ tx: number };
  /**
   * Visitors and conversion per visitor on mobile / desktop (null without visitors: "—", never 0 %), and the
   * checkouts without a user agent (no device: counted in neither).
   */
  devices: { mobile: number; desktop: number; mobileCvr: number | null; desktopCvr: number | null; unknownSessions: number };
};

/* ------------------------------------------------------------------ */
/* SQL building blocks                                                 */
/* ------------------------------------------------------------------ */

const n = (v: unknown) => Number(v ?? 0);
const ratio = (a: number, b: number) => (b ? a / b : 0);

/** Source / campaign / utm_id of a UTM JSON column (last touch: s.utm; first touch: s."firstUtm", else s.utm). */
const sourceOf = (u: Prisma.Sql) => Prisma.sql`COALESCE(NULLIF(lower(trim(${u}->>'utm_source')), ''),
  CASE WHEN ${u} ? 'fbclid' THEN 'facebook (clic pub)'
       WHEN ${u} ? 'ttclid' THEN 'tiktok (clic pub)'
       WHEN ${u} ? 'gclid' OR ${u} ? 'gbraid' OR ${u} ? 'wbraid' THEN 'google (clic pub)'
       WHEN ${u} ? 'msclkid' THEN 'bing (clic pub)'
       ELSE 'direct / inconnu' END)`;
const campaignOf = (u: Prisma.Sql) => Prisma.sql`COALESCE(NULLIF(trim(${u}->>'utm_campaign'), ''), '—')`;
const utmIdOf = (u: Prisma.Sql) => Prisma.sql`NULLIF(trim(${u}->>'utm_id'), '')`;
const LAST_UTM = Prisma.sql`s.utm`;
const FIRST_UTM = Prisma.sql`COALESCE(s."firstUtm", s.utm)`;

/** Attribution windows offered on the Acquisition tab (days a paid click keeps credit). */
export const ATTRIBUTION_WINDOWS = [1, 7, 28] as const;

/**
 * A touch column restricted to the attribution window, applied at query time: a touch dated
 * ("ts", stored with every touch) more than `days` before the checkout opened counts as none
 * (direct). Undated touches (older loaders) always count. `days` null = no window.
 */
export function windowedTouch(u: Prisma.Sql, days: number | null | undefined): Prisma.Sql {
  if (days == null) return u;
  return Prisma.sql`(CASE WHEN (${u}->>'ts') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' AND (${u}->>'ts')::timestamptz < s."createdAt" - make_interval(days => ${Math.max(0, Math.round(days))}::int) THEN NULL ELSE ${u} END)`;
}

/** Attribution expressions of the session aliased `s` (last and first paid touch) within the context's window. */
function attr(c: Pick<Ctx, "touchDays">) {
  const last = windowedTouch(LAST_UTM, c.touchDays);
  const first = windowedTouch(FIRST_UTM, c.touchDays);
  return {
    source: sourceOf(last),
    campaign: campaignOf(last),
    utmId: utmIdOf(last),
    content: Prisma.sql`NULLIF(lower(trim(${last}->>'utm_content')), '')`,
    term: Prisma.sql`NULLIF(lower(trim(${last}->>'utm_term')), '')`,
    firstSource: sourceOf(first),
    firstCampaign: campaignOf(first),
    firstUtmId: utmIdOf(first),
  };
}
/** Checkout language ("fr-FR" → "fr"), "inconnu" when not recorded. */
const LANG = Prisma.sql`COALESCE(NULLIF(lower(split_part(trim(s.lang), '-', 1)), ''), 'inconnu')`;
/**
 * Visitor's country for the "conversion par pays du visiteur" funnel: only the IP country recorded
 * when the checkout opened ("inconnu" without one). Never the shipping address: only buyers who got
 * that far typed one, which would inflate the conversion of the countries they typed.
 */
const FUNNEL_COUNTRY = Prisma.sql`COALESCE(NULLIF(upper(s."geoCountry"), ''), 'inconnu')`;
const COUNTRY = Prisma.sql`COALESCE(NULLIF(upper(s."shippingAddress"->>'countryCode'), ''), '—')`;
const MOBILE = Prisma.sql`(s."userAgent" ~* '(Mobi|Android|iPhone)')`;
/** The context's time zone as a SQL literal (validated IANA name: safe to inline). */
const zoneOf = (c: Pick<Ctx, "tz">) => Prisma.raw(`'${tzOf({ timezone: c.tz })}'`);
/** A timestamp column in the store's local time. */
const local = (col: Prisma.Sql, c: Pick<Ctx, "tz">) => Prisma.sql`((${col} AT TIME ZONE 'UTC') AT TIME ZONE ${zoneOf(c)})`;
const day = (col: Prisma.Sql, c: Pick<Ctx, "tz">) => Prisma.sql`to_char(${local(col, c)}, 'YYYY-MM-DD')`;


type Ctx = {
  storeId: string;
  includeTest: boolean;
  filters: Filters;
  vatExempt: boolean;
  vatDomesticOnly?: boolean;
  /** Store.homeCountry: VAT of unknown destinations and of EU sales under the OSS threshold (FR when absent). */
  homeCountry?: string;
  fulfilmentFeeCents: number;
  disputeFeeCents: number;
  /** Store.supplierPaidAtPayment: a refunded, never-shipped order keeps its product cost. */
  supplierPaid?: boolean;
  /** Attribution window (days) applied to the paid touches; null/undefined = no window. */
  touchDays?: number | null;
  /** Ad spend multiplier: 1 + home VAT rate for a VAT-exempt store that can't reclaim the VAT on its ads, else 1. */
  adVatFactor?: number;
  /** The store's time zone (days, hours); Paris when absent. */
  tz?: string;
  /** Some variants have a reduced VAT category (ProductVat): orders take their lines' blended rate. */
  reducedVat?: boolean;
};

/** Ad spend multiplier of a store (see Ctx.adVatFactor). Pure. */
export function adSpendVatFactor(store: { vatExempt: boolean; adSpendVatNonReclaimable: boolean; homeCountry?: string | null } | null | undefined): number {
  return store?.vatExempt && store.adSpendVatNonReclaimable ? 1 + vatRate(store.homeCountry || HOME_COUNTRY) : 1;
}
const scaled = (cents: number | null | undefined, f = 1) => Math.round((cents ?? 0) * f);

const SHIP_COUNTRY = Prisma.sql`s."shippingAddress"->>'countryCode'`;
/** Lines of the session aliased `s` with their VAT category (x = line, pv.category null = standard). */
const VAT_LINES = Prisma.sql`jsonb_array_elements(CASE WHEN jsonb_typeof(s.lines) = 'array' THEN s.lines ELSE '[]'::jsonb END) x
  LEFT JOIN "ProductVat" pv ON pv."storeId" = s."storeId" AND pv."variantId" = x->>'variantId'`;

/**
 * VAT rate (fraction) of the session aliased `s`, per the store's VAT settings: the destination's
 * standard rate, or, when the store has reduced-rate variants, its lines' rates weighted by their
 * amounts (see blendedVatRate).
 */
const rateOf = (c: Ctx) => {
  const std = vatRateSql(SHIP_COUNTRY, c.vatExempt, c.homeCountry || HOME_COUNTRY, c.vatDomesticOnly);
  if (!c.reducedVat || c.vatExempt) return std;
  const r = categoryVatRateSql(SHIP_COUNTRY, Prisma.sql`pv.category`, c.vatExempt, c.homeCountry || HOME_COUNTRY, c.vatDomesticOnly);
  return Prisma.sql`COALESCE((SELECT sum(w * r) / NULLIF(sum(w), 0) FROM (
      SELECT GREATEST(COALESCE((x->>'quantity')::int, 0) * COALESCE((x->>'unitPriceCents')::int, 0), 0)::numeric AS w, ${r} AS r FROM ${VAT_LINES}
    ) vz), ${std})`;
};

/** SQL booleans of the session aliased `s`: some line has a reduced category / some line's reduced rate is unknown at its destination. */
const vatFlagsOf = (c: Ctx) =>
  !c.reducedVat || c.vatExempt
    ? { reduced: Prisma.sql`false`, unknown: Prisma.sql`false` }
    : {
        reduced: Prisma.sql`EXISTS (SELECT 1 FROM ${VAT_LINES} WHERE COALESCE(pv.category, 'standard') <> 'standard')`,
        unknown: Prisma.sql`EXISTS (SELECT 1 FROM ${VAT_LINES} WHERE NOT ${categoryVatKnownSql(SHIP_COUNTRY, Prisma.sql`COALESCE(pv.category, 'standard')`, c.vatExempt, c.homeCountry || HOME_COUNTRY, c.vatDomesticOnly)})`,
      };

/** Minimal context (no store settings): for queries that don't compute money. */
const bareCtx = (storeId: string, includeTest: boolean, filters: Filters = {}, touchDays: number | null = null): Ctx => ({
  storeId,
  includeTest,
  filters,
  vatExempt: false,
  fulfilmentFeeCents: 0,
  disputeFeeCents: 0,
  touchDays,
});

/**
 * SQL boolean on an order row `m` (id, email, paid_at): the buyer had already ordered on the Shopify
 * store before paying it — their Shopify order count when this app created the order, or their
 * oldest known Shopify order (customers backfill / earlier orders) dated before the payment.
 */
function shopifyReturningSql(storeId: string): Prisma.Sql {
  return Prisma.sql`(COALESCE((SELECT x."shopifyPriorOrders" FROM "CheckoutSession" x WHERE x.id = m.id), 0) > 0
    OR EXISTS (SELECT 1 FROM "ShopifyCustomer" sc WHERE sc."storeId" = ${storeId} AND sc.email = m.email AND sc."firstOrderAt" < m.paid_at))`;
}

/** Store, test and dimension filters on a session aliased `s`. */
function scope(c: Ctx): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`s."storeId" = ${c.storeId}`];
  if (!c.includeTest) parts.push(Prisma.sql`s."test" = false`);
  if (c.filters.source) parts.push(Prisma.sql`${attr(c).source} = ${c.filters.source}`);
  if (c.filters.country) parts.push(Prisma.sql`${COUNTRY} = ${c.filters.country}`);
  if (c.filters.device === "mobile") parts.push(Prisma.sql`s."userAgent" IS NOT NULL AND ${MOBILE}`);
  if (c.filters.device === "desktop") parts.push(Prisma.sql`s."userAgent" IS NOT NULL AND NOT ${MOBILE}`);
  if (c.filters.lang) parts.push(Prisma.sql`${LANG} = ${c.filters.lang}`);
  if (c.filters.geo) parts.push(Prisma.sql`${FUNNEL_COUNTRY} = ${c.filters.geo}`);
  return Prisma.join(parts, " AND ");
}

/**
 * One row per paid order of [from, to) with every money column the dashboards need.
 * Used as `WITH m AS (…)`.
 */
function ordersCte(c: Ctx, from: Date, to: Date): Prisma.Sql {
  return ordersCteWhere(c, Prisma.sql`${scope(c)} AND s.status = 'PAID' AND s."paidAt" >= ${from} AND s."paidAt" < ${to}`);
}

/** Lost amount of a dispute: the recorded loss, or the whole net amount when none was recorded, capped at the net. */
const lostSql = (status: Prisma.Sql, lost: Prisma.Sql, net: Prisma.Sql) =>
  Prisma.sql`(CASE WHEN ${status} = 'lost' THEN LEAST(COALESCE(NULLIF(${lost}, 0), GREATEST(${net}, 0)), GREATEST(${net}, 0)) ELSE 0 END)`;

/** Same as ordersCte for any set of paid checkouts (`where` on the session aliased `s`). */
function ordersCteWhere(c: Ctx, where: Prisma.Sql): Prisma.Sql {
  const rate = rateOf(c);
  const A = attr(c);
  return Prisma.sql`WITH m0 AS (
    SELECT s.id, s."paidAt" AS paid_at, s."createdAt" AS created_at, lower(s.email) AS email,
           ${A.source} AS source, ${A.campaign} AS campaign, ${A.utmId} AS utm_id, ${A.content} AS utm_content, ${A.term} AS utm_term,
           ${A.firstSource} AS f_source, ${A.firstCampaign} AS f_campaign, ${A.firstUtmId} AS f_utm_id,
           NULLIF(lower(trim(s."surveyAnswer")), '') AS survey,
           EXISTS (SELECT 1 FROM "UpsellCharge" ua WHERE ua."sessionId" = s.id) AS offer_answered,
           (s."trackingNumber" IS NOT NULL AND s."trackingNumber" <> '') AS tracked,
           COALESCE(NULLIF(s."paymentMethodType", ''), 'inconnu') AS method, ${COUNTRY} AS country,
           s."discountCode" AS code, s."discountCents" AS discount,
           (s."reviewNote" IS NOT NULL) AS held,
           (s."upsellShownAt" IS NOT NULL OR cardinality(s."upsellShownBlocks") > 0) AS offer_shown,
           (s."upsellShownAt" IS NOT NULL AND cardinality(s."upsellShownBlocks") = 0) AS offer_legacy,
           COALESCE(NULLIF(s."totalCents", 0), s."subtotalCents") AS order_gross,
           s."refundedCents" AS order_refunded,
           s."whopFeeCents" AS order_fee,
           s.disputed AS order_disputed,
           ${lostSql(Prisma.sql`s."disputeStatus"`, Prisma.sql`s."disputeLostCents"`, Prisma.sql`(COALESCE(NULLIF(s."totalCents", 0), s."subtotalCents") - s."refundedCents")`)} AS order_lost,
           ${rate} AS rate, ${vatFlagsOf(c).reduced} AS vat_reduced, ${vatFlagsOf(c).unknown} AS vat_unknown,
           o.n AS offers, o.gross AS offer_gross, o.refunded AS offer_refunded, o.fee AS offer_fee, o.with_fee AS offer_with_fee,
           o.cost AS offer_cost, o.units AS offer_units, o.costed_units AS offer_costed, o.disputes AS offer_disputes, o.refunds AS offer_refunds, o.lost AS offer_lost,
           l.cost AS line_cost, l.units AS line_units, l.costed_units AS line_costed, l.ships,
           b.cost AS bump_cost_raw, b.n AS bumps, b.costed AS bumps_costed_raw,
           COALESCE(q."shippingCostCents", sr."costCents") AS ship_cost,
           -- Shipping-protection claims (reship / refund paid by the merchant), on the order's date like refunds.
           -- Only approved claims cost something (a buyer's pending report is not a cost yet).
           (SELECT COALESCE(sum(pc."costCents"), 0) FROM "ProtectionClaim" pc WHERE pc."sessionId" = s.id AND pc.status = 'approved')::bigint AS claim_cost
    FROM "CheckoutSession" s
    LEFT JOIN "CheckoutQuote" q ON q.id = s."paidQuoteId"
    LEFT JOIN "ShippingRate" sr ON sr.id = COALESCE(q."shippingRateId", s."shippingRateId")
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n,
             COALESCE(sum(u."amountCents"), 0)::bigint AS gross,
             COALESCE(sum(u."refundedCents"), 0)::bigint AS refunded,
             COALESCE(sum(u."whopFeeCents"), 0)::bigint AS fee,
             count(u."whopFeeCents")::int AS with_fee,
             COALESCE(sum(u."costCents" * u.quantity), 0)::bigint AS cost,
             COALESCE(sum(u.quantity), 0)::int AS units,
             COALESCE(sum(u.quantity) FILTER (WHERE u."costCents" IS NOT NULL), 0)::int AS costed_units,
             count(*) FILTER (WHERE u.disputed)::int AS disputes,
             count(*) FILTER (WHERE u."refundedCents" > 0)::int AS refunds,
             COALESCE(sum(${lostSql(Prisma.sql`u."disputeStatus"`, Prisma.sql`u."disputeLostCents"`, Prisma.sql`(u."amountCents" - u."refundedCents")`)}), 0)::bigint AS lost
      FROM "UpsellCharge" u WHERE u."sessionId" = s.id AND u.status = 'PAID'
    ) o
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum((x->>'quantity')::int * (x->>'unitCostCents')::int) FILTER (WHERE x->>'unitCostCents' IS NOT NULL), 0)::bigint AS cost,
             COALESCE(sum((x->>'quantity')::int), 0)::int AS units,
             COALESCE(sum((x->>'quantity')::int) FILTER (WHERE x->>'unitCostCents' IS NOT NULL), 0)::int AS costed_units,
             COALESCE(bool_or(COALESCE((x->>'requiresShipping')::boolean, true)), false) AS ships
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.lines) = 'array' THEN s.lines ELSE '[]'::jsonb END) x
    ) l
    CROSS JOIN LATERAL (
      SELECT COALESCE(sum((a->>'costCents')::int) FILTER (WHERE a->>'costCents' IS NOT NULL), 0)::bigint AS cost,
             count(a)::int AS n,
             -- Shipping protection has no purchase cost (self-insured): always "costed" at 0.
             count(a) FILTER (WHERE a->>'costCents' IS NOT NULL OR a->>'id' = ${PROTECTION_ADDON_ID})::int AS costed
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(q."addOns") = 'array' THEN q."addOns" ELSE '[]'::jsonb END) a
    ) b
    WHERE ${where}
  ), ms0 AS (
    -- Fully refunded and never shipped (no tracking number): no carrier, no preparation, and no goods
    -- unless the supplier is paid at payment (dropshipping: the product cost stays).
    SELECT m0.*, (NOT tracked AND order_gross + offer_gross > 0 AND order_refunded + offer_refunded >= order_gross + offer_gross) AS never_shipped
    FROM m0
  ), ms AS (
    SELECT ms0.*, (never_shipped AND NOT ${!!c.supplierPaid}::boolean) AS no_goods FROM ms0
  ), m1 AS (
    SELECT ms.*,
           (order_gross + offer_gross) AS gross,
           (order_refunded + offer_refunded) AS refunded,
           (order_lost + offer_lost) AS lost,
           (order_gross - order_refunded + offer_gross - offer_refunded) AS paid_net,
           (order_gross - order_refunded + offer_gross - offer_refunded - order_lost - offer_lost) AS net,
           round((order_gross + offer_gross) / (1 + rate))::bigint AS gross_ht,
           round((order_gross - order_refunded + offer_gross - offer_refunded) / (1 + rate))::bigint AS paid_ht,
           round((order_gross - order_refunded + offer_gross - offer_refunded - order_lost - offer_lost) / (1 + rate))::bigint AS ht,
           (order_disputed::int + offer_disputes) AS disputes,
           ((order_disputed::int + offer_disputes) * ${c.disputeFeeCents}::int) AS dispute_fee,
           (COALESCE(order_fee, 0) + offer_fee) AS fee,
           (order_fee IS NOT NULL AND offer_with_fee = offers) AS fee_known,
           (CASE WHEN no_goods THEN 0 ELSE line_cost + offer_cost END) AS product_cost,
           (line_units + offer_units) AS units,
           (CASE WHEN no_goods THEN line_units + offer_units ELSE line_costed + offer_costed END) AS costed_units,
           (CASE WHEN no_goods THEN 0 ELSE bump_cost_raw END) AS bump_cost,
           (CASE WHEN no_goods THEN bumps ELSE bumps_costed_raw END) AS bumps_costed,
           (never_shipped OR ship_cost IS NOT NULL OR NOT ships) AS ship_known,
           (CASE WHEN never_shipped THEN 0 ELSE COALESCE(ship_cost, 0) END) AS ship,
           (CASE WHEN never_shipped THEN 0 ELSE ${c.fulfilmentFeeCents}::int END) AS fulfil
    FROM ms
  ), m AS (
    SELECT m1.*, (ht - fee - product_cost - bump_cost - ship - fulfil - dispute_fee - claim_cost) AS profit FROM m1
  )`;
}

async function moneyTotals(c: Ctx, from: Date, to: Date) {
  const [r] = await db.$queryRaw<Record<string, unknown>[]>`${ordersCte(c, from, to)}
    SELECT count(*) AS orders,
           COALESCE(sum(gross), 0) AS gross, COALESCE(sum(refunded), 0) AS refunded, COALESCE(sum(net), 0) AS net,
           COALESCE(sum(ht), 0) AS ht, COALESCE(sum(offer_gross - offer_refunded - offer_lost), 0) AS offer_net, COALESCE(sum(offers), 0) AS offers,
           COALESCE(sum(gross_ht), 0) AS gross_ht, COALESCE(sum(paid_net), 0) AS paid_net, COALESCE(sum(paid_ht), 0) AS paid_ht,
           COALESCE(sum(lost), 0) AS lost, COALESCE(sum(dispute_fee), 0) AS dispute_fee,
           COALESCE(sum(fee), 0) AS fee, count(*) FILTER (WHERE fee_known) AS fee_known,
           COALESCE(sum(product_cost), 0) AS product_cost, COALESCE(sum(units), 0) AS units, COALESCE(sum(costed_units), 0) AS costed_units,
           COALESCE(sum(bump_cost), 0) AS bump_cost, COALESCE(sum(bumps), 0) AS bumps, COALESCE(sum(bumps_costed), 0) AS bumps_costed,
           COALESCE(sum(ship), 0) AS ship, count(*) FILTER (WHERE ship_known) AS ship_known,
           COALESCE(sum(fulfil), 0) AS fulfil, COALESCE(sum(profit), 0) AS profit,
           COALESCE(sum(claim_cost), 0) AS claims, count(*) FILTER (WHERE claim_cost > 0) AS claimed_orders,
           COALESCE(sum(1 + offers), 0) AS tx,
           count(*) FILTER (WHERE order_refunded > 0) + COALESCE(sum(offer_refunds), 0) AS refunds,
           count(*) FILTER (WHERE order_disputed) + COALESCE(sum(offer_disputes), 0) AS disputes,
           count(*) FILTER (WHERE held) AS holds,
           -- An order "saw an offer" when it recorded a display or answered one (same basis as the per-offer table).
           count(*) FILTER (WHERE offer_shown OR offer_answered) AS offer_shown,
           count(*) FILTER (WHERE offer_answered) AS offer_answered,
           count(*) FILTER (WHERE offer_legacy) AS offer_legacy,
           count(*) FILTER (WHERE ships) AS ship_orders,
           count(*) FILTER (WHERE vat_reduced) AS vat_reduced, count(*) FILTER (WHERE vat_unknown) AS vat_unknown,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM paid_at - created_at)) / 60 AS median,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY extract(epoch FROM paid_at - created_at)) / 60 AS p75
    FROM m`;
  const orders = n(r.orders);
  const coverage: Record<CostPart, number> = {
    fees: orders ? n(r.fee_known) / orders : 1,
    products: n(r.units) ? n(r.costed_units) / n(r.units) : 1,
    bumps: n(r.bumps) ? n(r.bumps_costed) / n(r.bumps) : 1,
    shipping: orders ? n(r.ship_known) / orders : 1,
  };
  const missing = (Object.keys(coverage) as CostPart[]).filter((k) => coverage[k] < 1);
  const totals: MoneyTotals = {
    orders,
    grossCents: n(r.gross),
    refundedCents: n(r.refunded),
    refundedHtCents: n(r.gross_ht) - n(r.paid_ht),
    paidNetCents: n(r.paid_net),
    paidNetHtCents: n(r.paid_ht),
    disputeLostCents: n(r.lost),
    disputeLostHtCents: n(r.paid_ht) - n(r.ht),
    disputes: n(r.disputes),
    disputeFeesCents: n(r.dispute_fee),
    revenueCents: n(r.net),
    revenueHtCents: n(r.ht),
    vatCents: n(r.net) - n(r.ht),
    upsellRevenueCents: n(r.offer_net),
    upsellAccepted: n(r.offers),
    feesCents: n(r.fee),
    productCostCents: n(r.product_cost),
    bumpCostCents: n(r.bump_cost),
    shippingCostCents: n(r.ship),
    fulfilmentCents: n(r.fulfil),
    claimsCents: n(r.claims),
    claims: n(r.claimed_orders),
    profitCents: n(r.profit),
    coverage,
    missing,
    complete: missing.length === 0,
  };
  return {
    totals,
    extra: {
      tx: n(r.tx),
      refunds: n(r.refunds),
      disputes: n(r.disputes),
      holds: n(r.holds),
      offerShown: n(r.offer_shown),
      offerAnswered: n(r.offer_answered),
      /** Paid orders with at least one line to ship (where shipping protection can be offered). */
      shipOrders: n(r.ship_orders),
      offerLegacy: n(r.offer_legacy),
      vatReduced: n(r.vat_reduced),
      vatUnknown: n(r.vat_unknown),
      median: r.median == null ? null : Math.round(n(r.median) * 10) / 10,
      p75: r.p75 == null ? null : Math.round(n(r.p75) * 10) / 10,
    },
  };
}

type Traffic = {
  sessions: number;
  visitors: number;
  paidVisitors: number;
  converted: number;
  abandoned: number;
  failed: number;
  funnel: { key: string; label: string; count: number }[];
};

/**
 * Checkout traffic and the strict funnel, optionally split by a SQL expression (`group`,
 * on the session aliased `s`). Steps never recorded in the period are hidden for every group.
 */
async function trafficBy(c: Ctx, from: Date, to: Date, group: Prisma.Sql = Prisma.sql`'all'`): Promise<(Traffic & { group: string })[]> {
  // Strict funnel: a checkout reaches a step when it recorded that step and every earlier one
  // (steps never recorded in the period are skipped). A paid checkout passed them all.
  const rows = await db.$queryRaw<Record<string, unknown>[]>`
    WITH t AS (
      SELECT s.id, s."visitorId", s.status, s."paymentFailedAt", (${group})::text AS g,
             s."emailEnteredAt" IS NOT NULL AS e, s."addressEnteredAt" IS NOT NULL AS a, s."shippingChosenAt" IS NOT NULL AS sh,
             s."preparedAt" IS NOT NULL AS f, s."payClickedAt" IS NOT NULL AS k
      FROM "CheckoutSession" s WHERE ${scope(c)} AND s."createdAt" >= ${from} AND s."createdAt" < ${to}
    ), h AS (
      SELECT COALESCE(bool_or(e), false) AS he, COALESCE(bool_or(a), false) AS ha, COALESCE(bool_or(sh), false) AS hsh,
             COALESCE(bool_or(f), false) AS hf, COALESCE(bool_or(k), false) AS hk FROM t
    ), z AS (
      SELECT t.*,
             (NOT h.he OR t.e) AS s1,
             (NOT h.he OR t.e) AND (NOT h.ha OR t.a) AS s2,
             (NOT h.he OR t.e) AND (NOT h.ha OR t.a) AND (NOT h.hsh OR t.sh) AS s3,
             (NOT h.he OR t.e) AND (NOT h.ha OR t.a) AND (NOT h.hsh OR t.sh) AND (NOT h.hf OR t.f) AS s4,
             (NOT h.he OR t.e) AND (NOT h.ha OR t.a) AND (NOT h.hsh OR t.sh) AND (NOT h.hf OR t.f) AND (NOT h.hk OR t.k) AS s5
      FROM t CROSS JOIN h
    ), g AS (
      SELECT g, count(*) AS sessions,
             count(DISTINCT COALESCE("visitorId", id)) AS visitors,
             count(DISTINCT COALESCE("visitorId", id)) FILTER (WHERE status = 'PAID') AS paid_visitors,
             count(*) FILTER (WHERE status = 'PAID') AS converted,
             count(*) FILTER (WHERE "paymentFailedAt" IS NOT NULL) AS failed,
             count(*) FILTER (WHERE status = 'PAID' OR s1) AS r_email,
             count(*) FILTER (WHERE status = 'PAID' OR s2) AS r_address,
             count(*) FILTER (WHERE status = 'PAID' OR s3) AS r_ship,
             count(*) FILTER (WHERE status = 'PAID' OR s4) AS r_form,
             count(*) FILTER (WHERE status = 'PAID' OR s5) AS r_click
      FROM z GROUP BY g
    )
    SELECT g.*, h.* FROM h LEFT JOIN g ON true ORDER BY g.sessions DESC NULLS LAST`;
  return rows
    .filter((r) => r.g != null || rows.length === 1)
    .map((r) => {
      const sessions = n(r.sessions);
      const converted = n(r.converted);
      return {
        group: r.g == null ? "all" : String(r.g),
        sessions,
        visitors: n(r.visitors),
        paidVisitors: n(r.paid_visitors),
        converted,
        abandoned: sessions - converted,
        failed: n(r.failed),
        // A step never recorded in the period (older checkouts, feature not live yet) is hidden rather than shown as a fake drop.
        funnel: [
          { key: "opened", label: "Checkout ouvert", count: sessions, show: true },
          { key: "email", label: "E-mail saisi", count: n(r.r_email), show: r.he === true },
          { key: "address", label: "Adresse saisie", count: n(r.r_address), show: r.ha === true },
          { key: "shipping", label: "Livraison choisie", count: n(r.r_ship), show: r.hsh === true },
          { key: "form", label: "Paiement affiché", count: n(r.r_form), show: r.hf === true },
          { key: "pay", label: "Clic sur « Payer »", count: n(r.r_click), show: r.hk === true },
          { key: "paid", label: "Payé", count: converted, show: true },
        ]
          .filter((f) => f.show)
          .map(({ key, label, count }) => ({ key, label, count })),
      };
    });
}

async function trafficTotals(c: Ctx, from: Date, to: Date): Promise<Traffic> {
  const [r] = await trafficBy(c, from, to);
  return r;
}

type SpendRow = {
  platform: string;
  campaignId: string;
  campaignName: string;
  spendCents: number;
  day?: string;
  /** What the platform reports (its own attribution); null when it reported nothing. */
  platformConversions?: number | null;
  platformValueCents?: number | null;
};

/** Campaign-level spend of [from, to] per campaign (per campaign × day with `byDay`). */
async function spendRows(storeId: string, from: string, to: string, byDay = false, f = 1): Promise<SpendRow[]> {
  const rows = await db.adSpend.groupBy({
    by: byDay ? ["platform", "campaignId", "campaignName", "day"] : ["platform", "campaignId", "campaignName"],
    where: { storeId, day: { gte: from, lte: to }, ...CAMPAIGN_ROWS },
    _sum: { spendCents: true, platformConversions: true, platformConversionValueCents: true },
  });
  return rows.map((r) => ({
    platform: r.platform,
    campaignId: r.campaignId,
    campaignName: r.campaignName,
    spendCents: scaled(r._sum.spendCents, f),
    platformConversions: r._sum.platformConversions,
    platformValueCents: r._sum.platformConversionValueCents,
    ...("day" in r ? { day: String(r.day) } : {}),
  }));
}

/** A stored AdSpend.valueMode as shown: revenue, profit, or unknown (not recorded, or changed that day). Pure. */
export function platformValueMode(v: string | null | undefined): PlatformValueMode {
  return v === "profit" ? "profit" : v === "revenue" ? "revenue" : "unknown";
}

/** Our orders counted against a platform row. */
export type RealFigures = { orders: number; revenueCents: number; revenueHtCents?: number; profitCents?: number };

/**
 * Platform-reported conversions vs our real orders, per campaign and per conversion value mode
 * (spend rows grouped on the source row they are attributed to).
 *  - "revenue" / "unknown" rows (the platform received order amounts): every ROAS is HT, like the
 *    sources table: our CA HT ÷ spend, and the platform's value (reported TTC by the pixels) taken HT
 *    at the HT ÷ TTC ratio of the campaign's orders (the period's, `htRatio`, when it has none).
 *  - "profit" rows (Store.conversionValueMode "profit": Meta / TikTok received each order's margin HT):
 *    the platform's figure is a POAS ("POAS plateforme", value ÷ spend, no VAT ratio: a margin is
 *    already HT), compared with our margin before ads ÷ spend.
 * Over-attribution = platform value ÷ ours (CA HT, or margin in profit mode; > 1: the platform
 * claims more than it brought, e.g. view-through or cross-device credit). When a platform's mode
 * changed during the period, `realOf` gives our orders of the days each mode was in effect (the
 * rows are then `split`). Pure.
 */
export function platformVsReal(
  rows: { source: string; campaign: string; orders: number; revenueCents: number; revenueHtCents?: number; profitCents?: number }[],
  spend: (SpendRow & { valueMode?: string | null })[],
  rowOf: (sp: SpendRow) => number,
  htRatio = 1,
  realOf?: (rowIndex: number, platform: string, mode: PlatformValueMode) => RealFigures | null,
): Analytics["platformVsReal"] {
  const by = new Map<string, Analytics["platformVsReal"][number] & { ratio: number }>();
  for (const sp of spend) {
    if (sp.platformConversions == null && sp.platformValueCents == null) continue;
    const mode = platformValueMode(sp.valueMode);
    const i = rowOf(sp);
    const row = i >= 0 ? rows[i] : null;
    const key = `${row ? `${row.source}\u0000${row.campaign}` : `${sp.platform}\u0000${sp.campaignId}`}\u0000${mode}`;
    let x = by.get(key);
    if (!x) {
      const split = row ? realOf?.(i, sp.platform, mode) : null;
      const real: RealFigures | null = split ?? row;
      const revenueHt = real ? (real.revenueHtCents ?? real.revenueCents) : 0;
      by.set(
        key,
        (x = {
          platform: sp.platform,
          campaign: sp.campaignName || sp.campaignId,
          valueMode: mode,
          split: !!split,
          spendCents: 0,
          platformConversions: 0,
          platformValueCents: 0,
          platformValueHtCents: 0,
          realOrders: real?.orders ?? 0,
          realRevenueCents: real?.revenueCents ?? 0,
          realRevenueHtCents: revenueHt,
          realProfitCents: real?.profitCents ?? 0,
          platformRoas: null,
          realRoas: null,
          overAttribution: null,
          matched: !!row,
          ratio: real && real.revenueCents > 0 ? revenueHt / real.revenueCents : htRatio,
        }),
      );
    }
    x.spendCents += sp.spendCents;
    x.platformConversions += sp.platformConversions ?? 0;
    x.platformValueCents += sp.platformValueCents ?? 0;
  }
  const over = (platform: number, ours: number) => (ours > 0 ? platform / ours : platform > 0 ? Infinity : null);
  return [...by.values()]
    .map(({ ratio, ...x }) => {
      const profit = x.valueMode === "profit";
      // A margin is already HT; an order amount is TTC (taken HT at our orders' ratio).
      const platformValueHtCents = profit ? x.platformValueCents : Math.round(x.platformValueCents * ratio);
      const ours = profit ? x.realProfitCents : x.realRevenueHtCents;
      return {
        ...x,
        platformConversions: Math.round(x.platformConversions * 100) / 100,
        platformValueHtCents,
        platformRoas: x.spendCents ? platformValueHtCents / x.spendCents : null,
        realRoas: x.spendCents ? ours / x.spendCents : null,
        overAttribution: over(platformValueHtCents, ours),
      };
    })
    .sort((a, b) => b.spendCents - a.spendCents || a.valueMode.localeCompare(b.valueMode));
}

/**
 * Our orders of a source row on the days a platform was in `mode` (a platform whose value mode
 * changed during the period). Days without any row of that platform follow its most frequent mode. Pure.
 */
export function realOnModeDays(
  byDay: Map<string, RealFigures & { profitCents: number; revenueHtCents: number }>,
  modeDays: Map<string, PlatformValueMode>,
  mode: PlatformValueMode,
): RealFigures {
  const counts = new Map<PlatformValueMode, number>();
  for (const m of modeDays.values()) counts.set(m, (counts.get(m) ?? 0) + 1);
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "revenue";
  const out = { orders: 0, revenueCents: 0, revenueHtCents: 0, profitCents: 0 };
  for (const [d, f] of byDay) {
    if ((modeDays.get(d) ?? dominant) !== mode) continue;
    out.orders += f.orders;
    out.revenueCents += f.revenueCents;
    out.revenueHtCents += f.revenueHtCents;
    out.profitCents += f.profitCents;
  }
  return out;
}

/** HT ÷ TTC of these rows' CA (1 without any). Pure. */
function htRatioOf(rows: { revenueCents: number; revenueHtCents: number }[]): number {
  const ttc = rows.reduce((n, r) => n + r.revenueCents, 0);
  return ttc > 0 ? rows.reduce((n, r) => n + r.revenueHtCents, 0) / ttc : 1;
}

/** Ad set and ad spend of [from, to] (creative table), never part of any total. */
async function detailSpendRows(storeId: string, from: string, to: string, f = 1): Promise<SpendRow[]> {
  const rows = await db.adSpend.groupBy({
    by: ["platform", "campaignId", "campaignName"],
    where: { storeId, day: { gte: from, lte: to }, OR: [{ campaignId: { startsWith: DETAIL_PREFIX.adset } }, { campaignId: { startsWith: DETAIL_PREFIX.ad } }] },
    _sum: { spendCents: true },
  });
  return rows.map((r) => ({ platform: r.platform, campaignId: r.campaignId, campaignName: r.campaignName, spendCents: scaled(r._sum.spendCents, f) }));
}

const PLATFORM_HINTS: Record<string, RegExp> = {
  meta: /facebook|\bfb\b|^fb|meta|instagram|\big\b/i,
  tiktok: /tiktok|\btt\b/i,
  google: /google|adwords|gads/i,
};

/**
 * Assigns each campaign's spend to the source row whose utm_campaign equals its name
 * (case-insensitive) or its id, or whose utm_id is its id. When several rows match, the one
 * whose source looks like the ad platform wins, then the one with the most checkouts.
 * Pure: exported for tests.
 */
type AttributionRow = { source: string; campaign: string; utmIds: string[]; sessions: number };

/** Index of the source row a campaign's spend belongs to (-1: none), per the rule of attributeSpend. */
function bestRowFor(rows: AttributionRow[], sp: Pick<SpendRow, "platform" | "campaignId" | "campaignName">): number {
  const name = sp.campaignName.trim().toLowerCase();
  const id = sp.campaignId.trim();
  let best = -1;
  let bestScore = -1;
  rows.forEach((r, i) => {
    const campaign = r.campaign.trim();
    const hit = (name && campaign.toLowerCase() === name) || (id && (campaign === id || r.utmIds.includes(id)));
    if (!hit) return;
    const score = (PLATFORM_HINTS[sp.platform]?.test(r.source) ? 1e12 : 0) + r.sessions;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}

export function attributeSpend<R extends AttributionRow>(
  rows: R[],
  spend: SpendRow[],
): { perRow: number[]; unattributed: { platform: string; campaign: string; spendCents: number }[] } {
  const perRow = rows.map(() => 0);
  const unattributed: { platform: string; campaign: string; spendCents: number }[] = [];
  for (const sp of spend) {
    if (!sp.spendCents) continue;
    const best = bestRowFor(rows, sp);
    if (best >= 0) perRow[best] += sp.spendCents;
    else unattributed.push({ platform: sp.platform, campaign: sp.campaignName || sp.campaignId, spendCents: sp.spendCents });
  }
  unattributed.sort((a, b) => b.spendCents - a.spendCents);
  return { perRow, unattributed };
}

function offerTitlesFromLayout(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  const blocks = (raw as { blocks?: unknown })?.blocks;
  if (!Array.isArray(blocks)) return map;
  for (const b of blocks as { id?: unknown; type?: unknown; props?: { title?: unknown } }[]) {
    if (b?.type === "upsell" && typeof b.id === "string") map.set(b.id, typeof b.props?.title === "string" ? b.props.title : "Offre");
  }
  return map;
}

/** Id of the shipping protection in the paid snapshot's add-ons (same as PROTECTION_ADDON_ID in checkout.ts; no AddOn row). */
export const PROTECTION_ADDON_ID = "shipping_protection";

async function storeCtx(storeId: string, includeTest: boolean, filters: Filters = {}, touchDays?: number | null) {
  const [store, reduced] = await Promise.all([
    db.store.findUnique({
    where: { id: storeId },
    select: {
      vatExempt: true,
      vatDomesticOnly: true,
      homeCountry: true,
      fulfillmentFeeCents: true,
      shopCurrency: true,
      thankYouLayout: true,
      disputeFeeCents: true,
      fixedCostsMonthlyCents: true,
      supplierPaidAtPayment: true,
      attributionDays: true,
      adSpendVatNonReclaimable: true,
      timezone: true,
      conversionValueMode: true,
      shopifyConnectedAt: true,
    },
    }),
    db.productVat.count({ where: { storeId, NOT: { category: "standard" } } }),
  ]);
  const ctx: Ctx = {
    storeId,
    includeTest,
    filters,
    vatExempt: !!store?.vatExempt,
    vatDomesticOnly: !!store?.vatDomesticOnly,
    homeCountry: store?.homeCountry || HOME_COUNTRY,
    fulfilmentFeeCents: store?.fulfillmentFeeCents ?? 0,
    disputeFeeCents: store?.disputeFeeCents ?? 1500,
    supplierPaid: !!store?.supplierPaidAtPayment,
    touchDays: touchDays !== undefined ? touchDays : (store?.attributionDays ?? 7),
    adVatFactor: adSpendVatFactor(store),
    // Inlined in SQL: a zone Postgres doesn't know falls back to the default (never a failing query).
    tz: await sqlTimeZone(store),
    reducedVat: reduced > 0,
  };
  return { ctx, store };
}

type DailyRow = Analytics["daily"][number];

function dayRowOf(map: Map<string, DailyRow>, d: string): DailyRow {
  let r = map.get(d);
  if (!r)
    map.set(
      d,
      (r = {
        day: d,
        sessions: 0,
        abandoned: 0,
        orders: 0,
        revenueCents: 0,
        revenueHtCents: 0,
        revenueHtBeforeDisputesCents: 0,
        vatCents: 0,
        feesCents: 0,
        costsCents: 0,
        disputeLostHtCents: 0,
        disputeFeesCents: 0,
        disputesCents: 0,
        claimsCents: 0,
        netCents: 0,
        spendCents: 0,
        refundsHtCents: 0,
        refundsByDateHtCents: 0,
        claimsByDateCents: 0,
        netByRefundDateCents: 0,
        fallback: false,
        disabled: false,
        externalRevenueHtCents: 0,
        externalOrders: 0,
      }),
    );
  return r;
}

/**
 * Per day of the store's time zone: money on the payment date, checkouts on the opening date, and
 * the refunds / claims of the day on their own date (the refund-date view of the daily margin).
 */
async function dailyRows(c: Ctx, from: Date, to: Date): Promise<Map<string, DailyRow>> {
  const rate = rateOf(c);
  const [money, traffic, refunds, claims] = await Promise.all([
    db.$queryRaw<Record<string, unknown>[]>`${ordersCte(c, from, to)}
      SELECT ${day(Prisma.sql`paid_at`, c)} AS day, count(*) AS orders, sum(net) AS net, sum(ht) AS ht, sum(paid_ht) AS paid_ht, sum(profit) AS profit,
             sum(fee) AS fee, sum(product_cost + bump_cost + ship + fulfil) AS costs, sum(paid_ht - ht) AS lost_ht, sum(dispute_fee) AS dispute_fee,
             sum(claim_cost) AS claims, sum(gross_ht - paid_ht) AS refunded_ht
      FROM m GROUP BY 1`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${day(Prisma.sql`s."createdAt"`, c)} AS day, count(*) AS sessions, count(*) FILTER (WHERE s.status <> 'PAID') AS abandoned
      FROM "CheckoutSession" s WHERE ${scope(c)} AND s."createdAt" >= ${from} AND s."createdAt" < ${to} GROUP BY 1`,
    // Same rows and rounding as refundsOfPeriod, per day of the refund (or of the order, without a record).
    db.$queryRaw<Record<string, unknown>[]>`
      WITH x AS (
        SELECT rr."amountCents" AS amount, ${rate} AS rate, rr."createdAt" AS at
        FROM "RefundRecord" rr JOIN "CheckoutSession" s ON s.id = rr."sessionId"
        WHERE ${scope(c)} AND rr."createdAt" >= ${from} AND rr."createdAt" < ${to}
        UNION ALL
        SELECT s."refundedCents" + COALESCE((SELECT sum(u."refundedCents") FROM "UpsellCharge" u WHERE u."sessionId" = s.id AND u.status = 'PAID'), 0), ${rate}, s."paidAt"
        FROM "CheckoutSession" s
        WHERE ${scope(c)} AND s.status = 'PAID' AND s."paidAt" >= ${from} AND s."paidAt" < ${to}
          AND NOT EXISTS (SELECT 1 FROM "RefundRecord" rr WHERE rr."sessionId" = s.id)
      )
      SELECT ${day(Prisma.sql`at`, c)} AS day, COALESCE(sum(round(amount / (1 + rate))), 0) AS ht FROM x WHERE amount > 0 GROUP BY 1`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${day(Prisma.sql`COALESCE(pc."decidedAt", pc."createdAt")`, c)} AS day, COALESCE(sum(pc."costCents"), 0) AS cents
      FROM "ProtectionClaim" pc JOIN "CheckoutSession" s ON s.id = pc."sessionId"
      WHERE ${scope(c)} AND pc.status = 'approved' AND COALESCE(pc."decidedAt", pc."createdAt") >= ${from} AND COALESCE(pc."decidedAt", pc."createdAt") < ${to}
      GROUP BY 1`,
  ]);
  const map = new Map<string, DailyRow>();
  for (const d of money)
    Object.assign(dayRowOf(map, String(d.day)), {
      orders: n(d.orders),
      revenueCents: n(d.net),
      revenueHtCents: n(d.ht),
      revenueHtBeforeDisputesCents: n(d.paid_ht),
      vatCents: n(d.net) - n(d.ht),
      feesCents: n(d.fee),
      costsCents: n(d.costs),
      disputeLostHtCents: n(d.lost_ht),
      disputeFeesCents: n(d.dispute_fee),
      disputesCents: n(d.lost_ht) + n(d.dispute_fee),
      claimsCents: n(d.claims),
      netCents: n(d.profit),
      refundsHtCents: n(d.refunded_ht),
    });
  for (const d of traffic) Object.assign(dayRowOf(map, String(d.day)), { sessions: n(d.sessions), abandoned: n(d.abandoned) });
  for (const d of refunds) dayRowOf(map, String(d.day)).refundsByDateHtCents = n(d.ht);
  for (const d of claims) dayRowOf(map, String(d.day)).claimsByDateCents = n(d.cents);
  for (const r of map.values()) r.netByRefundDateCents = r.netCents + r.refundsHtCents - r.refundsByDateHtCents + r.claimsCents - r.claimsByDateCents;
  return map;
}

/**
 * Days of [from, to] (store time zone) touched by a fallback period (on Shopify's own checkout for
 * part of the day at least; an open period runs until `nowMs`). Pure.
 */
export function fallbackDaysOf(periods: { startedAt: Date; endedAt: Date | null }[], from: string, to: string, tz: string, nowMs = Date.now()): string[] {
  const out: string[] = [];
  for (const d of daysBetween(from, to)) {
    const start = parisDayStart(d, tz).getTime();
    const end = parisDayStart(addDays(d, 1), tz).getTime();
    if (periods.some((p) => p.startedAt.getTime() < end && (p.endedAt?.getTime() ?? nowMs) > start)) out.push(d);
  }
  return out;
}

/** Channels of the Shopify orders placed outside this checkout (ExternalOrder.sourceName). */
export type ExternalChannel = "web" | "pos" | "draft" | "other";
export const EXTERNAL_CHANNELS: ExternalChannel[] = ["web", "pos", "draft", "other"];
/** SQL channel of the ExternalOrder aliased `e`: web (online store), pos, draft (shopify_draft_order), other. */
const EXTERNAL_CHANNEL = Prisma.sql`(CASE lower(COALESCE(e."sourceName", '')) WHEN 'web' THEN 'web' WHEN 'pos' THEN 'pos' WHEN 'shopify_draft_order' THEN 'draft' ELSE 'other' END)`;

/** Channel of a Shopify order's sourceName (same rule as the SQL). Pure. */
export function externalChannelOf(sourceName: string | null | undefined): ExternalChannel {
  const v = (sourceName ?? "").toLowerCase();
  return v === "web" ? "web" : v === "pos" ? "pos" : v === "shopify_draft_order" ? "draft" : "other";
}

/** Per-channel totals from `channel, orders, ttc, ht` rows (every channel present, zero-filled). Pure. */
export function externalChannels(rows: Record<string, unknown>[]): Record<ExternalChannel, { orders: number; revenueCents: number; revenueHtCents: number }> {
  const out = Object.fromEntries(EXTERNAL_CHANNELS.map((k) => [k, { orders: 0, revenueCents: 0, revenueHtCents: 0 }])) as Record<ExternalChannel, { orders: number; revenueCents: number; revenueHtCents: number }>;
  for (const r of rows) {
    const k = externalChannelOf(r.channel === "draft" ? "shopify_draft_order" : String(r.channel ?? ""));
    out[k].orders += Number(r.orders ?? 0);
    out[k].revenueCents += Number(r.ttc ?? 0);
    out[k].revenueHtCents += Number(r.ht ?? 0);
  }
  return out;
}

/**
 * First whole day (store time zone) covered by the outside-orders import, not before the period's
 * first day: the day of `coveredFrom` when it starts at midnight, else the next one. Pure.
 */
export function leakageWindowFrom(coveredFrom: Date, fromDay: string, tz: string): string {
  const d = zonedDay(coveredFrom, tz);
  const first = parisDayStart(d, tz).getTime() < coveredFrom.getTime() ? addDays(d, 1) : d;
  return first > fromDay ? first : fromDay;
}

/** Buyers' Shopify history state as the dashboard shows it. Pure. */
export function customerHistoryOf(st: CustomersBackfill | null): CustomerHistory {
  if (!st) return { state: "none", customers: 0 };
  return { state: st.state, customers: st.customers, ...(st.error ? { error: st.error } : {}) };
}

/** Zero-filled daily series over [from, to] Paris days (same definitions as storeAnalytics). */
export async function dailySeries(storeId: string, from: string, to: string, includeTest: boolean): Promise<DailyRow[]> {
  const { ctx } = await storeCtx(storeId, includeTest);
  const since = parisDayStart(from, ctx.tz);
  const until = parisDayStart(addDays(to, 1), ctx.tz);
  const map = await dailyRows(ctx, since, until);
  const [spend, fallbacks] = await Promise.all([
    db.adSpend.groupBy({ by: ["day"], where: { storeId, day: { gte: from, lte: to }, ...CAMPAIGN_ROWS }, _sum: { spendCents: true } }),
    db.fallbackPeriod.findMany({ where: { storeId, startedAt: { lt: until }, OR: [{ endedAt: null }, { endedAt: { gt: since } }] } }),
  ]);
  for (const d of spend) dayRowOf(map, d.day).spendCents = scaled(d._sum.spendCents, ctx.adVatFactor);
  for (const d of fallbackDaysOf(fallbacks.filter((f) => f.kind !== "disabled"), from, to, ctx.tz ?? DEFAULT_TZ)) dayRowOf(map, d).fallback = true;
  for (const d of fallbackDaysOf(fallbacks.filter((f) => f.kind === "disabled"), from, to, ctx.tz ?? DEFAULT_TZ)) dayRowOf(map, d).disabled = true;
  return daysBetween(from, to).map((d) => map.get(d) ?? dayRowOf(new Map(), d));
}

/* ------------------------------------------------------------------ */
/* Pure helpers (exported for tests)                                   */
/* ------------------------------------------------------------------ */

/**
 * Monthly fixed costs prorated per Paris day over [from, to]: each day costs
 * monthly ÷ number of days of its month (a full calendar month costs exactly `monthly`).
 */
export function fixedCostsFor(monthlyCents: number, from: string, to: string): number {
  if (!monthlyCents) return 0;
  let total = 0;
  for (const d of daysBetween(from, to)) {
    const y = Number(d.slice(0, 4));
    const m = Number(d.slice(5, 7));
    total += monthlyCents / new Date(Date.UTC(y, m, 0)).getUTCDate();
  }
  return Math.round(total);
}

/**
 * Order-bump attach rate = orders that took it ÷ orders that were shown it. Checkouts that
 * didn't record which options were displayed (legacy, empty addOnsShown) count as having seen
 * every option: the rate is then an estimate (lower bound).
 */
export function attachRate(taken: number, shownRecorded: number, legacyOrders: number): { shown: number; rate: number; estimated: boolean } {
  const shown = Math.max(taken, shownRecorded + legacyOrders);
  return { shown, rate: ratio(taken, shown), estimated: legacyOrders > 0 };
}

/**
 * Take rate of an offer with legacy impressions: the recorded impressions give the highest
 * rate, recorded + every legacy order the lowest. Null range when there is no legacy order.
 */
export function offerRates(paid: number, answered: number, recorded: number, legacy: number): { impressions: number; rate: number; range: [number, number] | null } {
  const low = Math.max(recorded, answered);
  const high = Math.max(recorded + legacy, answered);
  return { impressions: high, rate: ratio(paid, high), range: legacy > 0 ? [ratio(paid, high), ratio(paid, low)] : null };
}

/** First `limit` rows, the rest summed into one "Autres (n)" row. */
function topWithOther<T extends Record<string, unknown>>(rows: T[], limit: number, other: (rest: T[]) => T): T[] {
  if (rows.length <= limit) return rows;
  return [...rows.slice(0, limit), other(rows.slice(limit))];
}

/**
 * Break-even ROAS HT = 1 ÷ margin rate before ads (CA HT ÷ margin): the ROAS at which the margin
 * exactly pays the ads. Null when the margin before ads is ≤ 0 (no ROAS can make it profitable). Pure.
 */
export function breakEvenRoas(profitCents: number, revenueHtCents: number): number | null {
  return profitCents > 0 && revenueHtCents > 0 ? revenueHtCents / profitCents : null;
}

export type AdVerdict = "early" | "cut" | "keep" | "scale";

/** Spend below which a campaign is judged "Trop tôt" when no margin per order is known yet. */
export const EARLY_FALLBACK_SPEND_CENTS = 5000;
/** Orders from which a verdict is always given. */
export const EARLY_MIN_ORDERS = 5;

/**
 * Enough data to judge an ad line: at least EARLY_MIN_ORDERS orders, or a spend of at least
 * 2 × the break-even CPA (margin per order before ads: that much spend without an order is already
 * a loss). A margin per order ≤ 0 makes any spend a loss (always enough); unknown (no order to
 * measure it) falls back to EARLY_FALLBACK_SPEND_CENTS. Pure.
 */
export function enoughAdData(spendCents: number, orders: number, breakEvenCpaCents: number | null | undefined): boolean {
  if (orders >= EARLY_MIN_ORDERS) return true;
  if (breakEvenCpaCents == null) return spendCents >= EARLY_FALLBACK_SPEND_CENTS;
  if (breakEvenCpaCents <= 0) return spendCents > 0;
  return spendCents >= 2 * breakEvenCpaCents;
}

/** Margin per order before ads (profit ÷ orders), null without orders. Pure. */
export function breakEvenCpa(profitCents: number, orders: number): number | null {
  return orders > 0 ? Math.round(profitCents / orders) : null;
}

/**
 * What to do with a campaign: ROAS ÷ break-even ROAS (= POAS, margin before ads ÷ spend).
 * Below 0.95 the ads lose money ("Couper"), up to 1.3 they roughly pay for themselves
 * ("Garder"), above 1.3 × break-even they earn well ("Scaler"). With `sample`, "early"
 * ("Trop tôt") until enoughAdData. Null without spend. Pure.
 */
export function adVerdict(poas: number | null | undefined, sample?: { spendCents: number; orders: number; breakEvenCpaCents: number | null }): AdVerdict | null {
  if (poas == null || !Number.isFinite(poas)) return null;
  if (sample && !enoughAdData(sample.spendCents, sample.orders, sample.breakEvenCpaCents)) return "early";
  return poas < 0.95 ? "cut" : poas > 1.3 ? "scale" : "keep";
}

/**
 * Break-even ROAS HT when a customer is worth their 90-day margin (LTV) instead of the first
 * order's: ROAS at which spend per order = margin per customer over 90 days. Null when unknown. Pure.
 */
export function breakEvenRoasLtv(revenueHtCents: number, orders: number, margin90Cents: number | null | undefined): number | null {
  if (!orders || !revenueHtCents || margin90Cents == null || margin90Cents <= 0) return null;
  return revenueHtCents / orders / margin90Cents;
}

export type CreativeRow = {
  level: "adset" | "ad";
  platform: string;
  name: string;
  /** Platform ids of the ad sets / ads grouped under this name. */
  ids: string[];
  spendCents: number;
  orders: number;
  revenueHtCents: number;
  /** Margin before ads of the matched orders. */
  profitCents: number;
  profitAfterAdsCents: number;
  cpaCents: number | null;
  roas: number | null;
  poas: number | null;
  /** Same rule as campaigns ("Trop tôt" until enough spend or orders). */
  verdict: AdVerdict | null;
};

/**
 * Ad set / ad spend (AdSpend rows "adset:<id>" / "ad:<id>") matched to paid orders by
 * utm_content or utm_term (the platform id or the name, case-insensitive). Ads or ad sets that
 * share a name are grouped (same creative in several ad sets). An order group counts once per
 * level, for the biggest-spending match. Pure: exported for tests.
 */
export function creativeRows(
  spend: Pick<SpendRow, "platform" | "campaignId" | "campaignName" | "spendCents">[],
  orders: { content: string | null; term: string | null; orders: number; htCents: number; profitCents: number }[],
  /** Store's margin per order before ads (sample-size rule of the verdict). */
  breakEvenCpaCents: number | null = null,
): CreativeRow[] {
  const byKey = new Map<string, CreativeRow & { keys: Set<string> }>();
  for (const sp of spend) {
    const level = spendLevel(sp.campaignId);
    if (level === "campaign") continue;
    const id = sp.campaignId.slice(DETAIL_PREFIX[level].length);
    const name = (sp.campaignName || id).trim();
    const key = `${level}|${sp.platform}|${name.toLowerCase()}`;
    let r = byKey.get(key);
    if (!r)
      byKey.set(
        key,
        (r = { level, platform: sp.platform, name, ids: [], keys: new Set([name.toLowerCase()]), spendCents: 0, orders: 0, revenueHtCents: 0, profitCents: 0, profitAfterAdsCents: 0, cpaCents: null, roas: null, poas: null, verdict: null }),
      );
    if (!r.ids.includes(id)) r.ids.push(id);
    r.keys.add(id.toLowerCase());
    r.spendCents += sp.spendCents;
  }
  const rows = [...byKey.values()].sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name));
  for (const g of orders) {
    for (const level of ["adset", "ad"] as const) {
      const hit = rows.find((r) => r.level === level && ((g.content != null && r.keys.has(g.content)) || (g.term != null && r.keys.has(g.term))));
      if (!hit) continue;
      hit.orders += g.orders;
      hit.revenueHtCents += g.htCents;
      hit.profitCents += g.profitCents;
    }
  }
  return rows.map(({ keys, ...r }) => {
    void keys;
    const poas = r.spendCents ? r.profitCents / r.spendCents : null;
    return {
      ...r,
      profitAfterAdsCents: r.profitCents - r.spendCents,
      cpaCents: r.spendCents && r.orders ? Math.round(r.spendCents / r.orders) : null,
      roas: r.spendCents ? r.revenueHtCents / r.spendCents : null,
      poas,
      verdict: adVerdict(poas, { spendCents: r.spendCents, orders: r.orders, breakEvenCpaCents }),
    };
  });
}

export type Anomaly = { key: "conversion" | "roas" | "refunds"; severity: "warn" | "bad"; title: string; detail: string };

/** What detectAnomalies needs (a full Analytics, or a cross-store summary). */
export type AnomalyInput = {
  cvr: number;
  visitors: number;
  previous: { visitors: number; cvr: number; roas: number | null; spendCents: number; refundRate: number };
  ads: { available: boolean; roas: number | null; spendCents: number };
  risk: { tx: number; refundRate: number };
};

/**
 * Simple computed alerts vs the previous period, only with enough volume to mean something:
 * conversion down ≥ 30 % (≥ 200 visitors in both periods), ROAS HT down ≥ 30 % (≥ 50 € of
 * spend in both), refund rate at least doubled and ≥ 5 % (≥ 20 payments).
 */
export function detectAnomalies(a: AnomalyInput): Anomaly[] {
  const out: Anomaly[] = [];
  const pctFmt = (v: number) => new Intl.NumberFormat("fr-FR", { style: "percent", maximumFractionDigits: 1 }).format(v);
  const num = (v: number) => new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
  if (a.visitors >= 200 && a.previous.visitors >= 200 && a.previous.cvr > 0) {
    const change = a.cvr / a.previous.cvr - 1;
    if (change <= -0.3)
      out.push({
        key: "conversion",
        severity: change <= -0.5 ? "bad" : "warn",
        title: `Conversion checkout en baisse de ${pctFmt(-change)}`,
        detail: `${pctFmt(a.cvr)} contre ${pctFmt(a.previous.cvr)} sur la période précédente (${new Intl.NumberFormat("fr-FR").format(a.visitors)} visiteurs). Vérifiez le checkout (paiement, livraison, page).`,
      });
  }
  if (a.ads.available && a.ads.roas != null && a.previous.roas != null && a.ads.spendCents >= 5000 && a.previous.spendCents >= 5000 && a.previous.roas > 0) {
    const change = a.ads.roas / a.previous.roas - 1;
    if (change <= -0.3)
      out.push({
        key: "roas",
        severity: a.ads.roas < 1 ? "bad" : "warn",
        title: `ROAS HT en baisse de ${pctFmt(-change)}`,
        detail: `${num(a.ads.roas)} contre ${num(a.previous.roas)} sur la période précédente. Regardez les campagnes dans le tableau Acquisition.`,
      });
  }
  const tx = a.risk.tx;
  if (tx >= 20 && a.risk.refundRate >= 0.05 && a.risk.refundRate >= 2 * a.previous.refundRate) {
    out.push({
      key: "refunds",
      severity: a.risk.refundRate >= 0.1 ? "bad" : "warn",
      title: `Remboursements en hausse : ${pctFmt(a.risk.refundRate)} des paiements`,
      detail: `Contre ${pctFmt(a.previous.refundRate)} sur la période précédente. Vérifiez les produits les plus remboursés (tableau Produits).`,
    });
  }
  return out;
}

/** Offer blocks that are only shown after another offer was declined (downsells). */
function downsellIds(raw: unknown): Set<string> {
  const ids = new Set<string>();
  try {
    for (const b of loadThankYouLayout(raw).blocks) {
      const next = (b.props as { declineNextId?: unknown } | undefined)?.declineNextId;
      if (b.type === "upsell" && typeof next === "string" && next) ids.add(next);
    }
  } catch {
    /* unreadable layout: no downsell flag */
  }
  return ids;
}

/**
 * Refunds dated in [from, to) (RefundRecord, by refund date) for the scoped checkouts, plus
 * refunds of orders paid in the period that have no record at all (older data, counted at the
 * order date).
 */
async function refundsOfPeriod(c: Ctx, from: Date, to: Date): Promise<Analytics["refundsByDate"]> {
  const rate = rateOf(c);
  const [r] = await db.$queryRaw<Record<string, unknown>[]>`
    WITH x AS (
      SELECT rr."amountCents" AS amount, ${rate} AS rate, false AS fallback, rr."sessionId" AS sid
      FROM "RefundRecord" rr JOIN "CheckoutSession" s ON s.id = rr."sessionId"
      WHERE ${scope(c)} AND rr."createdAt" >= ${from} AND rr."createdAt" < ${to}
      UNION ALL
      SELECT s."refundedCents" + COALESCE((SELECT sum(u."refundedCents") FROM "UpsellCharge" u WHERE u."sessionId" = s.id AND u.status = 'PAID'), 0), ${rate}, true, s.id
      FROM "CheckoutSession" s
      WHERE ${scope(c)} AND s.status = 'PAID' AND s."paidAt" >= ${from} AND s."paidAt" < ${to}
        AND NOT EXISTS (SELECT 1 FROM "RefundRecord" rr WHERE rr."sessionId" = s.id)
    )
    SELECT COALESCE(sum(amount), 0) AS cents, COALESCE(sum(round(amount / (1 + rate))), 0) AS ht,
           count(*) FILTER (WHERE amount > 0 AND NOT fallback) AS n,
           COALESCE(sum(amount) FILTER (WHERE fallback), 0) AS fb, count(*) FILTER (WHERE fallback AND amount > 0) AS fbn
    FROM x WHERE amount > 0`;
  return { cents: n(r?.cents), htCents: n(r?.ht), count: n(r?.n) + n(r?.fbn), fallbackCents: n(r?.fb), fallbackOrders: n(r?.fbn) };
}

/**
 * Approved protection claims that cost in [from, to) on the scoped checkouts: dated at the
 * merchant's decision (buyer reports), else at their creation (claims typed by the merchant).
 */
async function claimsOfPeriod(c: Ctx, from: Date, to: Date): Promise<Analytics["claimsByDate"]> {
  const [r] = await db.$queryRaw<Record<string, unknown>[]>`
    SELECT COALESCE(sum(pc."costCents"), 0) AS cents, count(*) AS n
    FROM "ProtectionClaim" pc JOIN "CheckoutSession" s ON s.id = pc."sessionId"
    WHERE ${scope(c)} AND pc.status = 'approved' AND COALESCE(pc."decidedAt", pc."createdAt") >= ${from} AND COALESCE(pc."decidedAt", pc."createdAt") < ${to}`;
  return { cents: n(r?.cents), count: n(r?.n) };
}

/** Below this share of located checkouts, the visitor-country conversion rates are hidden. */
export const GEO_COVERAGE_MIN = 0.8;

/** Located share of the visitor-country groups ("inconnu" = no IP country). Pure. */
export function geoCoverageOf(groups: { group: string; sessions: number }[]): Analytics["geoCoverage"] {
  const sessions = groups.reduce((a, g) => a + g.sessions, 0);
  const located = groups.filter((g) => g.group !== "inconnu").reduce((a, g) => a + g.sessions, 0);
  return { sessions, located, share: sessions ? located / sessions : 0 };
}

/* ------------------------------------------------------------------ */
/* Store analytics                                                     */
/* ------------------------------------------------------------------ */

const SOURCE_ROWS = 25;

/** First `limit` funnel groups, the rest summed into "Autres (n)" (same steps for every group). */
function groupWithOther(groups: FunnelGroup[], limit: number): FunnelGroup[] {
  const sum = (rest: FunnelGroup[], f: (g: FunnelGroup) => number) => rest.reduce((a, g) => a + f(g), 0);
  return topWithOther(groups, limit, (rest) => ({
    group: `Autres (${rest.length})`,
    sessions: sum(rest, (g) => g.sessions),
    visitors: sum(rest, (g) => g.visitors),
    paidVisitors: sum(rest, (g) => g.paidVisitors),
    funnel: rest[0].funnel.map((st, i) => ({ ...st, count: sum(rest, (g) => g.funnel[i]?.count ?? 0) })),
  }));
}

/**
 * Survey answers × UTM source rows → per answer (most orders first): orders, CA HT and its UTM
 * sources (most orders first). Orders without an answer only count in `orders`. Pure: exported for tests.
 */
export function surveySummary(rows: { answer: string | null; source: string; orders: number; htCents: number }[]): Analytics["survey"] {
  const by = new Map<string, Analytics["survey"]["answers"][number]>();
  let orders = 0;
  let answered = 0;
  for (const r of rows) {
    orders += r.orders;
    if (r.answer == null) continue;
    answered += r.orders;
    let a = by.get(r.answer);
    if (!a) by.set(r.answer, (a = { answer: r.answer, orders: 0, revenueHtCents: 0, utm: [] }));
    a.orders += r.orders;
    a.revenueHtCents += r.htCents;
    a.utm.push({ source: r.source, orders: r.orders });
  }
  const answers = [...by.values()].sort((a, b) => b.orders - a.orders || b.revenueHtCents - a.revenueHtCents || a.answer.localeCompare(b.answer));
  for (const a of answers) a.utm.sort((x, y) => y.orders - x.orders || x.source.localeCompare(y.source));
  return { orders, answered, answers };
}
const DEVICE = Prisma.sql`(CASE WHEN s."userAgent" IS NULL THEN 'inconnu' WHEN ${MOBILE} THEN 'mobile' ELSE 'desktop' END)`;

export async function storeAnalytics(
  storeId: string,
  p: Period,
  opts: {
    rowLimit?: number;
    /** Sources table: last paid touch (default) or first. */
    touch?: "last" | "first";
    /** Attribution window in days (1, 7 or 28), applied at query time; defaults to the store's setting. */
    attributionDays?: number;
  } = {},
): Promise<Analytics> {
  const rowLimit = opts.rowLimit ?? 20;
  const touch = opts.touch === "first" ? "first" : "last";
  const filters = p.filters ?? {};
  const windowDays = opts.attributionDays != null && (ATTRIBUTION_WINDOWS as readonly number[]).includes(opts.attributionDays) ? opts.attributionDays : undefined;
  const { ctx: c, store } = await storeCtx(storeId, p.includeTest, filters, windowDays);
  const A = attr(c);
  const T = touch === "first" ? { source: A.firstSource, campaign: A.firstCampaign, utmId: A.firstUtmId } : { source: A.source, campaign: A.campaign, utmId: A.utmId };
  const mcol = touch === "first" ? { source: Prisma.raw("f_source"), campaign: Prisma.raw("f_campaign"), utmId: Prisma.raw("f_utm_id") } : { source: Prisma.raw("source"), campaign: Prisma.raw("campaign"), utmId: Prisma.raw("utm_id") };
  const prevSince = p.prevSince ?? new Date(p.since.getTime() - (p.until.getTime() - p.since.getTime()));
  const fromDay = zonedDay(p.since, c.tz);
  const toDay = zonedDay(new Date(p.until.getTime() - 1), c.tz);
  const prevFromDay = zonedDay(prevSince, c.tz);
  const prevToDay = zonedDay(new Date(p.since.getTime() - 1), c.tz);
  // Spend can't be split by country, device or checkout language.
  const spendAvailable = !filters.country && !filters.device && !filters.lang && !filters.geo;
  const opened = Prisma.sql`${scope(c)} AND s."createdAt" >= ${p.since} AND s."createdAt" < ${p.until}`;
  const withOrders = ordersCte(c, p.since, p.until);

  const [
    money,
    prevMoney,
    traffic,
    prevTraffic,
    dailyBase,
    srcTraffic,
    srcMoney,
    methods,
    countries,
    products,
    addOnsTaken,
    addOnsShown,
    addOnNames,
    codes,
    devices,
    customers,
    impressions,
    charges,
    spend,
    prevSpend,
    dailySpend,
    lastSpend,
    unconverted,
    refundsByDate,
    heatTraffic,
    heatMoney,
    byDevice,
    bySource,
    detailSpend,
    creativeOrders,
    prevSourceRows,
    byLang,
    byCountry,
    surveyRows,
  ] = await Promise.all([
    moneyTotals(c, p.since, p.until),
    moneyTotals(c, prevSince, p.since),
    trafficTotals(c, p.since, p.until),
    trafficTotals(c, prevSince, p.since),
    dailyRows(c, p.since, p.until),
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${T.source} AS source, ${T.campaign} AS campaign, count(*) AS sessions,
             count(DISTINCT COALESCE(s."visitorId", s.id)) AS visitors,
             count(DISTINCT COALESCE(s."visitorId", s.id)) FILTER (WHERE s.status = 'PAID') AS paid_visitors,
             COALESCE(array_agg(DISTINCT ${T.utmId}) FILTER (WHERE ${T.utmId} IS NOT NULL), '{}') AS utm_ids
      FROM "CheckoutSession" s WHERE ${opened} GROUP BY 1, 2`,
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}
      SELECT ${mcol.source} AS source, ${mcol.campaign} AS campaign, count(*) AS orders, sum(net) AS net, sum(ht) AS ht, sum(profit) AS profit,
             COALESCE(array_agg(DISTINCT ${mcol.utmId}) FILTER (WHERE ${mcol.utmId} IS NOT NULL), '{}') AS utm_ids
      FROM m GROUP BY 1, 2`,
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}
      SELECT method, count(*) AS orders, sum(net) AS net, sum(ht) AS ht, sum(gross) AS gross, sum(fee) AS fee,
             count(*) FILTER (WHERE fee_known) AS fee_known, sum(profit) AS profit
      FROM m GROUP BY 1 ORDER BY sum(net) DESC`,
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}
      SELECT country, count(*) AS orders, sum(net) AS net, sum(ht) AS ht, sum(profit) AS profit FROM m GROUP BY 1 ORDER BY sum(net) DESC, 1`,
    // Products: order lines (discount, refunds and lost disputes allocated pro rata) and one-click offers.
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}, lines AS (
        SELECT m.id AS order_id, COALESCE(x->>'productId', x->>'title') AS product_id, x->>'title' AS title,
               (x->>'quantity')::int AS units,
               ((x->>'quantity')::int * (x->>'unitPriceCents')::int)
                 * (1 - s."discountCents"::numeric / GREATEST(s."subtotalCents", 1))
                 * (1 - (s."refundedCents" + m.order_lost)::numeric / GREATEST(m.order_gross, 1)) AS net,
               m.rate, (CASE WHEN m.no_goods THEN 0 ELSE (x->>'quantity')::int * (x->>'unitCostCents')::int END) AS cost, m.order_refunded > 0 AS refunded
        FROM m JOIN "CheckoutSession" s ON s.id = m.id,
             jsonb_array_elements(CASE WHEN jsonb_typeof(s.lines) = 'array' THEN s.lines ELSE '[]'::jsonb END) x
        UNION ALL
        SELECT m.id, COALESCE(u."productId", u.title), u.title, u.quantity,
               (u."amountCents" - u."refundedCents" - ${lostSql(Prisma.sql`u."disputeStatus"`, Prisma.sql`u."disputeLostCents"`, Prisma.sql`(u."amountCents" - u."refundedCents")`)})::numeric,
               m.rate, (CASE WHEN m.no_goods THEN 0 ELSE u."costCents" * u.quantity END), u."refundedCents" > 0
        FROM m JOIN "UpsellCharge" u ON u."sessionId" = m.id AND u.status = 'PAID'
      )
      SELECT product_id, max(title) AS title, sum(units) AS units, count(DISTINCT order_id) AS orders,
             round(sum(net)) AS net, round(sum(net / (1 + rate))) AS ht,
             sum(cost) AS cost, bool_and(cost IS NOT NULL) AS costed,
             count(DISTINCT order_id) FILTER (WHERE refunded) AS refunded_orders
      FROM lines GROUP BY 1 ORDER BY sum(net) DESC, 1`,
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}
      SELECT COALESCE(a->>'id', a->>'title') AS id, max(a->>'title') AS title, count(*) AS orders, sum((a->>'priceCents')::int) AS revenue,
             round(sum((a->>'priceCents')::int / (1 + m.rate))) AS ht,
             COALESCE(sum(CASE WHEN m.no_goods THEN 0 ELSE (a->>'costCents')::int END), 0) AS cost,
             bool_and(m.no_goods OR a->>'costCents' IS NOT NULL OR a->>'id' = ${PROTECTION_ADDON_ID}) AS costed
      FROM m JOIN "CheckoutSession" s ON s.id = m.id JOIN "CheckoutQuote" q ON q.id = s."paidQuoteId",
           jsonb_array_elements(CASE WHEN jsonb_typeof(q."addOns") = 'array' THEN q."addOns" ELSE '[]'::jsonb END) a
      GROUP BY 1 ORDER BY sum((a->>'priceCents')::int) DESC`,
    // Options displayed, per paid order (legacy orders recorded nothing: "addOnsShown" empty).
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}
      SELECT x AS id, count(*) AS n FROM m JOIN "CheckoutSession" s ON s.id = m.id, unnest(s."addOnsShown") x GROUP BY 1
      UNION ALL
      SELECT NULL, count(*) FROM m JOIN "CheckoutSession" s ON s.id = m.id WHERE cardinality(s."addOnsShown") = 0`,
    db.addOn.findMany({ where: { storeId }, select: { id: true, title: true } }),
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}
      SELECT code, count(*) AS orders, sum(discount) AS discount, sum(net) AS net, sum(ht) AS ht, sum(profit) AS profit
      FROM m WHERE code IS NOT NULL GROUP BY 1 ORDER BY sum(net) DESC`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${MOBILE} AS mobile, count(DISTINCT COALESCE(s."visitorId", s.id)) AS visitors,
             count(DISTINCT COALESCE(s."visitorId", s.id)) FILTER (WHERE s.status = 'PAID') AS paid_visitors
      FROM "CheckoutSession" s WHERE ${opened} AND s."userAgent" IS NOT NULL GROUP BY 1`,
    // Returning = the same e-mail already paid on this store before (this checkout), or the buyer had
    // already ordered on the Shopify store (their order count at order creation, or the customers backfill).
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}, c AS (
        SELECT m.*, EXISTS (
                 SELECT 1 FROM "CheckoutSession" o
                 WHERE o."storeId" = ${storeId} AND o.status = 'PAID' AND lower(o.email) = m.email AND o."paidAt" < m.paid_at
                 ${c.includeTest ? Prisma.empty : Prisma.sql`AND o."test" = false`}
               ) AS app_ret, ${shopifyReturningSql(storeId)} AS shop_ret
        FROM m WHERE m.email IS NOT NULL
      )
      SELECT (app_ret OR shop_ret) AS returning, count(*) AS orders, count(DISTINCT email) AS customers, sum(net) AS net,
             count(*) FILTER (WHERE shop_ret AND NOT app_ret) AS shop_only
      FROM c GROUP BY 1`,
    // Offer impressions per block, on the same basis as the charges (the order's payment date).
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}
      SELECT b AS block, count(*) AS n FROM m JOIN "CheckoutSession" s ON s.id = m.id, unnest(s."upsellShownBlocks") b GROUP BY 1`,
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}, u AS (
        SELECT u.*, m.rate, m.no_goods AS ns,
               (u."amountCents" - u."refundedCents" - ${lostSql(Prisma.sql`u."disputeStatus"`, Prisma.sql`u."disputeLostCents"`, Prisma.sql`(u."amountCents" - u."refundedCents")`)}) AS net
        FROM "UpsellCharge" u JOIN m ON m.id = u."sessionId"
      )
      SELECT u."blockId" AS block, (array_agg(u.title ORDER BY u."createdAt" DESC))[1] AS title,
             count(*) FILTER (WHERE u.status = 'PAID') AS paid,
             count(*) FILTER (WHERE u.status = 'DECLINED') AS declined,
             count(*) FILTER (WHERE u.status = 'FAILED') AS failed,
             COALESCE(sum(u.net) FILTER (WHERE u.status = 'PAID'), 0) AS revenue,
             COALESCE(round(sum(u.net / (1 + u.rate)) FILTER (WHERE u.status = 'PAID')), 0) AS ht,
             COALESCE(sum(CASE WHEN u.ns THEN 0 ELSE u."costCents" * u.quantity END) FILTER (WHERE u.status = 'PAID'), 0) AS cost,
             COALESCE(sum(u."whopFeeCents") FILTER (WHERE u.status = 'PAID'), 0) AS fee,
             COALESCE(bool_and(u.ns OR u."costCents" IS NOT NULL) FILTER (WHERE u.status = 'PAID'), true) AS costed
      FROM u GROUP BY 1`,
    spendRows(storeId, fromDay, toDay, false, c.adVatFactor),
    // Previous period: with a source filter, its spend is attributed to sources exactly like the current one.
    filters.source
      ? spendRows(storeId, prevFromDay, prevToDay, false, c.adVatFactor)
      : db.adSpend
          .aggregate({ where: { storeId, day: { gte: prevFromDay, lte: prevToDay }, ...CAMPAIGN_ROWS }, _sum: { spendCents: true } })
          .then((r) => ({ _sum: { spendCents: scaled(r._sum.spendCents, c.adVatFactor) } })),
    filters.source
      ? spendRows(storeId, fromDay, toDay, true, c.adVatFactor)
      : db.adSpend
          .groupBy({ by: ["day"], where: { storeId, day: { gte: fromDay, lte: toDay }, ...CAMPAIGN_ROWS }, _sum: { spendCents: true } })
          .then((rows) => rows.map((r) => ({ day: r.day, _sum: { spendCents: scaled(r._sum.spendCents, c.adVatFactor) } }))),
    db.adSpend.findFirst({ where: { storeId, ...CAMPAIGN_ROWS }, orderBy: { day: "desc" }, select: { day: true } }),
    db.adSpend.groupBy({
      by: ["currency"],
      where: { storeId, day: { gte: fromDay, lte: toDay }, AND: [CAMPAIGN_ROWS, { NOT: { currency: store?.shopCurrency ?? "EUR" } }] },
      _count: { _all: true },
    }),
    refundsOfPeriod(c, p.since, p.until),
    // Day of week × hour (Paris): checkouts opened and paid on the opening time, CA HT on the payment time.
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT extract(isodow FROM ${local(Prisma.sql`s."createdAt"`, c)})::int AS dow, extract(hour FROM ${local(Prisma.sql`s."createdAt"`, c)})::int AS hour,
             count(*) AS sessions, count(*) FILTER (WHERE s.status = 'PAID') AS converted
      FROM "CheckoutSession" s WHERE ${opened} GROUP BY 1, 2`,
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}
      SELECT extract(isodow FROM ${local(Prisma.sql`paid_at`, c)})::int AS dow, extract(hour FROM ${local(Prisma.sql`paid_at`, c)})::int AS hour, sum(ht) AS ht
      FROM m GROUP BY 1, 2`,
    filters.device ? Promise.resolve([]) : trafficBy(c, p.since, p.until, DEVICE),
    filters.source ? Promise.resolve([]) : trafficBy(c, p.since, p.until, A.source),
    spendAvailable ? detailSpendRows(storeId, fromDay, toDay, c.adVatFactor) : Promise.resolve([] as SpendRow[]),
    spendAvailable
      ? db.$queryRaw<Record<string, unknown>[]>`${withOrders}
          SELECT utm_content, utm_term, count(*) AS orders, sum(ht) AS ht, sum(profit) AS profit
          FROM m WHERE utm_content IS NOT NULL OR utm_term IS NOT NULL GROUP BY 1, 2`
      : Promise.resolve([] as Record<string, unknown>[]),
    // Source rows of the previous period (spend attribution with a source filter).
    filters.source && spendAvailable
      ? db.$queryRaw<Record<string, unknown>[]>`
          SELECT ${T.source} AS source, ${T.campaign} AS campaign,
                 count(*) FILTER (WHERE s."createdAt" >= ${prevSince} AND s."createdAt" < ${p.since}) AS sessions,
                 COALESCE(array_agg(DISTINCT ${T.utmId}) FILTER (WHERE ${T.utmId} IS NOT NULL), '{}') AS utm_ids
          FROM "CheckoutSession" s
          WHERE ${scope(c)} AND ((s."createdAt" >= ${prevSince} AND s."createdAt" < ${p.since}) OR (s.status = 'PAID' AND s."paidAt" >= ${prevSince} AND s."paidAt" < ${p.since}))
          GROUP BY 1, 2`
      : Promise.resolve([] as Record<string, unknown>[]),
    filters.lang ? Promise.resolve([]) : trafficBy(c, p.since, p.until, LANG),
    filters.geo ? Promise.resolve([]) : trafficBy(c, p.since, p.until, FUNNEL_COUNTRY),
    // Survey answers (paid orders of the period) × the UTM source (last touch) they carried.
    db.$queryRaw<Record<string, unknown>[]>`${withOrders}
      SELECT survey, source, count(*) AS orders, sum(ht) AS ht FROM m GROUP BY 1, 2`,
  ]);

  const t = traffic;
  const m = money.totals;
  const pm = prevMoney.totals;

  /* Leakage, fallback periods, platform value modes and the buyers' Shopify history. */
  const leakageAvailable = !!store?.shopifyConnectedAt && !filters.source && !filters.country && !filters.device && !filters.lang && !filters.geo;
  const withValues = { OR: [{ platformConversions: { not: null } }, { platformConversionValueCents: { not: null } }] };
  const [valueRows, modeDayRows, externalTotal, externalDaily, externalStatus, fallbackRows, history, coverage, externalFallbackDaily] = await Promise.all([
    spendAvailable
      ? db.adSpend.groupBy({
          by: ["platform", "campaignId", "campaignName", "valueMode"],
          where: { storeId, day: { gte: fromDay, lte: toDay }, AND: [CAMPAIGN_ROWS, withValues] },
          _sum: { spendCents: true, platformConversions: true, platformConversionValueCents: true },
        })
      : Promise.resolve([]),
    spendAvailable
      ? db.adSpend.groupBy({ by: ["platform", "day", "valueMode"], where: { storeId, day: { gte: fromDay, lte: toDay }, AND: [CAMPAIGN_ROWS, withValues] }, _sum: { spendCents: true } })
      : Promise.resolve([]),
    leakageAvailable
      ? db.$queryRaw<Record<string, unknown>[]>`
          SELECT ${EXTERNAL_CHANNEL} AS channel, count(*) AS orders, COALESCE(sum(e."totalCents"), 0) AS ttc, COALESCE(sum(e."htCents"), 0) AS ht
          FROM "ExternalOrder" e WHERE ${externalScope(storeId, p.includeTest)} AND e."orderedAt" >= ${p.since} AND e."orderedAt" < ${p.until} GROUP BY 1`
      : Promise.resolve([] as Record<string, unknown>[]),
    // Daily series: online-store orders only (the ones this checkout could have taken).
    leakageAvailable
      ? db.$queryRaw<Record<string, unknown>[]>`
          SELECT ${day(Prisma.sql`e."orderedAt"`, c)} AS day, count(*) AS orders, COALESCE(sum(e."htCents"), 0) AS ht, COALESCE(sum(e."totalCents"), 0) AS ttc
          FROM "ExternalOrder" e WHERE ${externalScope(storeId, p.includeTest)} AND ${EXTERNAL_CHANNEL} = 'web' AND e."orderedAt" >= ${p.since} AND e."orderedAt" < ${p.until} GROUP BY 1`
      : Promise.resolve([] as Record<string, unknown>[]),
    leakageAvailable ? externalImportStatus(storeId) : Promise.resolve(null),
    db.fallbackPeriod.findMany({
      where: { storeId, startedAt: { lt: p.until }, OR: [{ endedAt: null }, { endedAt: { gt: p.since } }] },
      orderBy: { startedAt: "asc" },
    }),
    customersBackfillStatus(storeId),
    spendCoverage(storeId, zonedDay(new Date(), c.tz)),
    // Online outside orders placed during a fallback / checkout-off period (buyers sent to Shopify's checkout on purpose).
    leakageAvailable
      ? db.$queryRaw<Record<string, unknown>[]>`
          SELECT ${day(Prisma.sql`e."orderedAt"`, c)} AS day, count(*) AS orders, COALESCE(sum(e."htCents"), 0) AS ht
          FROM "ExternalOrder" e WHERE ${externalScope(storeId, p.includeTest)} AND ${EXTERNAL_CHANNEL} = 'web' AND e."orderedAt" >= ${p.since} AND e."orderedAt" < ${p.until}
            AND EXISTS (SELECT 1 FROM "FallbackPeriod" f WHERE f."storeId" = ${storeId} AND f."startedAt" <= e."orderedAt" AND (f."endedAt" IS NULL OR f."endedAt" > e."orderedAt"))
          GROUP BY 1`
      : Promise.resolve([] as Record<string, unknown>[]),
  ]);

  /* Sources: traffic (opened in period) + money (paid in period), then ad spend by campaign. */
  type SourceRow = Analytics["sources"][number] & { utmIds: string[] };
  const byKey = new Map<string, SourceRow>();
  const rowFor = (source: string, campaign: string) => {
    const key = `${source}\u0000${campaign}`;
    let r = byKey.get(key);
    if (!r)
      byKey.set(
        key,
        (r = {
          source,
          campaign,
          sessions: 0,
          visitors: 0,
          paidVisitors: 0,
          orders: 0,
          revenueCents: 0,
          revenueHtCents: 0,
          profitCents: 0,
          spendCents: 0,
          roas: null,
          cpaCents: null,
          poas: null,
          breakEvenRoas: null,
          verdict: null,
          profitAfterAdsCents: 0,
          utmIds: [],
        }),
      );
    return r;
  };
  for (const r of srcTraffic) {
    const row = rowFor(String(r.source), String(r.campaign));
    row.sessions = n(r.sessions);
    row.visitors = n(r.visitors);
    row.paidVisitors = n(r.paid_visitors);
    row.utmIds.push(...((r.utm_ids as string[]) ?? []));
  }
  for (const r of srcMoney) {
    const row = rowFor(String(r.source), String(r.campaign));
    row.orders = n(r.orders);
    row.revenueCents = n(r.net);
    row.revenueHtCents = n(r.ht);
    row.profitCents = n(r.profit);
    row.utmIds.push(...((r.utm_ids as string[]) ?? []));
  }
  const allSources = [...byKey.values()];
  const { perRow, unattributed } = attributeSpend(allSources, spendAvailable ? spend : []);
  allSources.forEach((r, i) => (r.spendCents = perRow[i]));
  // With a source filter only that source's campaigns count; otherwise all spend of the period.
  const spendTotal = spendAvailable ? (filters.source ? perRow.reduce((a, b) => a + b, 0) : spend.reduce((a, b) => a + b.spendCents, 0)) : 0;
  // Spend rows that count for this view (all of them, or those attributed to the filtered source).
  const spendInView = filters.source ? spend.filter((sp) => sp.spendCents && bestRowFor(allSources, sp) >= 0) : spend;
  allSources.sort((a, b) => b.revenueCents - a.revenueCents || b.spendCents - a.spendCents || b.sessions - a.sessions);
  const storeBreakEven = breakEvenRoas(m.profitCents, m.revenueHtCents);
  const storeBreakEvenCpa = breakEvenCpa(m.profitCents, m.orders);
  const finish = (r: Omit<SourceRow, "utmIds">): Analytics["sources"][number] => {
    const poas = r.spendCents ? r.profitCents / r.spendCents : null;
    return {
      source: r.source,
      campaign: r.campaign,
      sessions: r.sessions,
      visitors: r.visitors,
      paidVisitors: r.paidVisitors,
      orders: r.orders,
      revenueCents: r.revenueCents,
      revenueHtCents: r.revenueHtCents,
      profitCents: r.profitCents,
      spendCents: r.spendCents,
      roas: r.spendCents ? r.revenueHtCents / r.spendCents : null,
      cpaCents: r.spendCents && r.orders ? Math.round(r.spendCents / r.orders) : null,
      poas,
      breakEvenRoas: r.orders ? breakEvenRoas(r.profitCents, r.revenueHtCents) : storeBreakEven,
      verdict: r.other ? null : adVerdict(poas, { spendCents: r.spendCents, orders: r.orders, breakEvenCpaCents: storeBreakEvenCpa }),
      profitAfterAdsCents: r.profitCents - r.spendCents,
      ...(r.other ? { other: true } : {}),
    };
  };
  const sourceLimit = rowLimit === Infinity ? Infinity : SOURCE_ROWS;
  const sources = allSources.slice(0, sourceLimit).map(finish);
  if (allSources.length > sourceLimit) {
    const rest = allSources.slice(sourceLimit);
    const sum = (k: "sessions" | "visitors" | "paidVisitors" | "orders" | "revenueCents" | "revenueHtCents" | "profitCents" | "spendCents") => rest.reduce((a, r) => a + r[k], 0);
    const spent = sum("spendCents");
    sources.push(
      finish({
        source: `Autres (${rest.length})`,
        campaign: "—",
        sessions: sum("sessions"),
        visitors: sum("visitors"),
        paidVisitors: sum("paidVisitors"),
        orders: sum("orders"),
        revenueCents: sum("revenueCents"),
        revenueHtCents: sum("revenueHtCents"),
        profitCents: sum("profitCents"),
        spendCents: spent,
        roas: null,
        cpaCents: null,
        poas: null,
        breakEvenRoas: null,
        verdict: null,
        profitAfterAdsCents: sum("profitCents") - spent,
        other: true,
      }),
    );
  }

  /* Daily series (with a source filter: the day's spend of the campaigns attributed to that source). */
  const daily = dailyBase;
  if (spendAvailable) {
    if (filters.source) {
      for (const d of dailySpend as SpendRow[]) if (d.day && d.spendCents && bestRowFor(allSources, d) >= 0) dayRowOf(daily, d.day).spendCents += d.spendCents;
    } else for (const d of dailySpend as { day: string; _sum: { spendCents: number | null } }[]) dayRowOf(daily, d.day).spendCents = d._sum.spendCents ?? 0;
  }

  /* Days on Shopify's own checkout (fallback) and orders placed outside this checkout. */
  const nowMs = Date.now();
  const periodOf = (f: (typeof fallbackRows)[number]) => ({
    startedAt: f.startedAt.toISOString(),
    endedAt: f.endedAt?.toISOString() ?? null,
    minutes: Math.max(0, Math.round(((f.endedAt?.getTime() ?? nowMs) - f.startedAt.getTime()) / 60_000)),
    reason: f.reason,
  });
  // Automatic fallback (Whop failing) and checkout switched off by hand: both send buyers to Shopify's checkout.
  const autoRows = fallbackRows.filter((f) => f.kind !== "disabled");
  const offRows = fallbackRows.filter((f) => f.kind === "disabled");
  const fallbackPeriods = autoRows.map(periodOf);
  const fallbackDays = fallbackDaysOf(autoRows, fromDay, toDay, c.tz ?? DEFAULT_TZ, nowMs);
  for (const d of fallbackDays) dayRowOf(daily, d).fallback = true;
  const disabledDays = fallbackDaysOf(offRows, fromDay, toDay, c.tz ?? DEFAULT_TZ, nowMs);
  for (const d of disabledDays) dayRowOf(daily, d).disabled = true;
  for (const r of externalDaily) Object.assign(dayRowOf(daily, String(r.day)), { externalRevenueHtCents: n(r.ht), externalOrders: n(r.orders) });
  // Outside CA TTC per day (window headline only: the daily series stays HT).
  const externalTtcByDay = new Map(externalDaily.map((r) => [String(r.day), n(r.ttc)]));
  const channels = externalChannels(externalTotal);
  // The import covers orders from `coveredFrom` on (60 days before the first import): the share and the
  // ROAS incl. outside orders only count the whole days it covers, ours and the ad spend alike.
  const coveredFromAt = externalStatus?.lastRunAt && externalStatus.coveredFrom ? new Date(externalStatus.coveredFrom) : null;
  const coveredUntilMs = externalCoveredUntil(externalStatus);
  const windowFrom = coveredFromAt ? leakageWindowFrom(coveredFromAt, fromDay, c.tz ?? DEFAULT_TZ) : fromDay;
  const partial = windowFrom > fromDay;
  const inWindow = daysBetween(fromDay, toDay).filter((d) => d >= windowFrom).map((d) => dayRowOf(daily, d));
  const windowOurs = partial ? inWindow.reduce((t, d) => t + d.revenueHtCents, 0) : m.revenueHtCents;
  const windowExternal = partial ? inWindow.reduce((t, d) => t + (d.externalRevenueHtCents ?? 0), 0) : channels.web.revenueHtCents;
  const windowSpend = partial ? inWindow.reduce((t, d) => t + d.spendCents, 0) : null;
  const fallbackWindowHt = externalFallbackDaily.filter((r) => String(r.day) >= windowFrom).reduce((t, r) => t + n(r.ht), 0);
  const leakage: Analytics["leakage"] = leakageAvailable
    ? {
        orders: channels.web.orders,
        revenueCents: channels.web.revenueCents,
        revenueHtCents: channels.web.revenueHtCents,
        share: windowFrom > toDay ? null : ratio(windowExternal, windowOurs + windowExternal),
        partial,
        windowFrom: windowFrom > toDay ? null : partial ? windowFrom : fromDay,
        windowOrders: partial ? inWindow.reduce((t, d) => t + (d.externalOrders ?? 0), 0) : channels.web.orders,
        windowRevenueHtCents: windowExternal,
        windowRevenueCents: partial ? daysBetween(fromDay, toDay).filter((d) => d >= windowFrom).reduce((t, d) => t + (externalTtcByDay.get(d) ?? 0), 0) : channels.web.revenueCents,
        channels,
        lastImportAt: externalStatus?.lastRunAt ?? null,
        lastCompletedAt: externalLastCompletedAt(externalStatus),
        coveredUntil: coveredUntilMs != null ? new Date(coveredUntilMs).toISOString() : null,
        fallbackOrders: externalFallbackDaily.reduce((t, r) => t + n(r.orders), 0),
        fallbackRevenueHtCents: fallbackWindowHt,
        fallbackShare: windowFrom > toDay ? null : ratio(fallbackWindowHt, windowOurs + windowExternal),
        // Orders are imported from 60 days before the first import (Shopify's default visibility for apps).
        coveredFrom: coveredFromAt ? zonedDay(coveredFromAt, c.tz) : null,
        error: externalStatus?.error ?? null,
      }
    : null;
  const leakageRoas = { ours: windowOurs, external: windowExternal, spend: windowSpend, empty: windowFrom > toDay };

  /* Platform-reported conversions per value mode; our orders split by day when a platform's mode changed. */
  const valueSpend = (valueRows as { platform: string; campaignId: string; campaignName: string; valueMode: string | null; _sum: { spendCents: number | null; platformConversions: number | null; platformConversionValueCents: number | null } }[])
    .map((r) => ({
      platform: r.platform,
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      valueMode: r.valueMode,
      spendCents: scaled(r._sum.spendCents, c.adVatFactor),
      platformConversions: r._sum.platformConversions,
      platformValueCents: r._sum.platformConversionValueCents,
    }))
    .filter((sp) => !filters.source || (sp.spendCents && bestRowFor(allSources, sp) >= 0));
  const modeDays = new Map<string, Map<string, PlatformValueMode>>();
  for (const r of modeDayRows as { platform: string; day: string; valueMode: string | null }[]) {
    const days = modeDays.get(r.platform) ?? new Map<string, PlatformValueMode>();
    modeDays.set(r.platform, days);
    const mode = platformValueMode(r.valueMode);
    // Two modes on one day (rows imported at different times): unknown.
    days.set(r.day, days.has(r.day) && days.get(r.day) !== mode ? "unknown" : mode);
  }
  const mixedPlatforms = new Set([...modeDays.entries()].filter(([, days]) => new Set(days.values()).size > 1).map(([platform]) => platform));
  let realOf: ((i: number, platform: string, mode: PlatformValueMode) => RealFigures | null) | undefined;
  if (mixedPlatforms.size) {
    const perDay = await db.$queryRaw<Record<string, unknown>[]>`${withOrders}
      SELECT ${mcol.source} AS source, ${mcol.campaign} AS campaign, ${day(Prisma.sql`paid_at`, c)} AS day, count(*) AS orders, sum(net) AS net, sum(ht) AS ht, sum(profit) AS profit
      FROM m GROUP BY 1, 2, 3`;
    const byRow = new Map<string, Map<string, RealFigures & { profitCents: number; revenueHtCents: number }>>();
    for (const r of perDay) {
      const k = `${String(r.source)}\u0000${String(r.campaign)}`;
      const days = byRow.get(k) ?? new Map();
      byRow.set(k, days);
      days.set(String(r.day), { orders: n(r.orders), revenueCents: n(r.net), revenueHtCents: n(r.ht), profitCents: n(r.profit) });
    }
    realOf = (i, platform, mode) => {
      if (!mixedPlatforms.has(platform)) return null;
      const row = allSources[i];
      return realOnModeDays(byRow.get(`${row.source}\u0000${row.campaign}`) ?? new Map(), modeDays.get(platform) ?? new Map(), mode);
    };
  }

  /* Previous period's spend, attributed like the current one when a source filter is active. */
  let prevSpendTotal = 0;
  if (spendAvailable) {
    if (filters.source) {
      const rows = prevSourceRows.map((r) => ({ source: String(r.source), campaign: String(r.campaign), sessions: n(r.sessions), utmIds: (r.utm_ids as string[]) ?? [] }));
      prevSpendTotal = attributeSpend(rows, prevSpend as SpendRow[]).perRow.reduce((a, b) => a + b, 0);
    } else prevSpendTotal = (prevSpend as { _sum: { spendCents: number | null } })._sum.spendCents ?? 0;
  }

  /* Ad sets and ads (only the platforms that can be behind the filtered source). */
  const creatives = creativeRows(
    filters.source ? detailSpend.filter((sp) => PLATFORM_HINTS[sp.platform]?.test(filters.source!)) : detailSpend,
    creativeOrders.map((r) => ({
      content: r.utm_content == null ? null : String(r.utm_content),
      term: r.utm_term == null ? null : String(r.utm_term),
      orders: n(r.orders),
      htCents: n(r.ht),
      profitCents: n(r.profit),
    })),
    storeBreakEvenCpa,
  );

  /* Offers per block and per A/B arm ("<id>:B"). Legacy checkouts predate arms: they only count for arm A. */
  const titles = offerTitlesFromLayout(store?.thankYouLayout);
  const downsells = downsellIds(store?.thankYouLayout);
  const shownByBlock = new Map(impressions.map((r) => [String(r.block), n(r.n)]));
  const legacy = money.extra.offerLegacy;
  const blocks = new Set([...shownByBlock.keys(), ...charges.map((r) => String(r.block))]);
  const chargeBy = new Map(charges.map((r) => [String(r.block), r]));
  const tested = new Set([...blocks].map(parseArmKey).filter((k) => k.arm === "B").map((k) => k.blockId));
  const offerTitle = (id: string) => titles.get(id) ?? (chargeBy.get(id)?.title as string | undefined) ?? (chargeBy.get(`${id}:B`)?.title as string | undefined) ?? "Offre supprimée";
  const offerRows: Analytics["offers"] = [...blocks].map((block) => {
    const { blockId: offerId, arm } = parseArmKey(block);
    const armLegacy = arm === "B" ? 0 : legacy;
    const ch = chargeBy.get(block);
    const paid = n(ch?.paid);
    const r = offerRates(paid, paid + n(ch?.declined) + n(ch?.failed), shownByBlock.get(block) ?? 0, armLegacy);
    const ht = n(ch?.ht);
    const isTested = tested.has(offerId);
    return {
      blockId: block,
      offerId,
      arm: isTested ? arm : null,
      title: isTested ? `${offerTitle(offerId)} · variante ${arm}` : offerTitle(offerId),
      offerTitle: offerTitle(offerId),
      impressions: r.impressions,
      paid,
      declined: n(ch?.declined),
      failed: n(ch?.failed),
      takeRate: r.rate,
      takeRateRange: r.range,
      revenueCents: n(ch?.revenue),
      revenueHtCents: ht,
      // Marge produit (CA HT − product cost), like the products and options tables; fees are in the net margin.
      marginCents: paid === 0 ? 0 : ch?.costed === false ? null : ht - n(ch?.cost),
      revenuePerImpressionHtCents: r.impressions ? Math.round(ht / r.impressions) : 0,
      downsell: downsells.has(offerId),
      estimated: armLegacy > 0,
    };
  });
  // Offers by revenue (arms summed), each offer's arms together (A then B).
  const offerRevenue = new Map<string, number>();
  const offerViews = new Map<string, number>();
  for (const o of offerRows) {
    offerRevenue.set(o.offerId, (offerRevenue.get(o.offerId) ?? 0) + o.revenueCents);
    offerViews.set(o.offerId, (offerViews.get(o.offerId) ?? 0) + o.impressions);
  }
  const offers = offerRows
    .sort(
      (a, b) =>
        offerRevenue.get(b.offerId)! - offerRevenue.get(a.offerId)! ||
        offerViews.get(b.offerId)! - offerViews.get(a.offerId)! ||
        a.offerId.localeCompare(b.offerId) ||
        (a.arm ?? "A").localeCompare(b.arm ?? "A"),
    )
    .slice(0, 12);
  // Orders that saw an offer: never fewer than the orders that answered one, nor than any row's views.
  const offerShown = Math.max(money.extra.offerShown, money.extra.offerAnswered, ...offerRows.map((o) => o.impressions));

  /* Order bumps: taken ÷ shown. */
  const shownById = new Map(addOnsShown.filter((r) => r.id != null).map((r) => [String(r.id), n(r.n)]));
  const legacyBumpOrders = n(addOnsShown.find((r) => r.id == null)?.n);
  const bumpTitle = new Map(addOnNames.map((a) => [a.id, a.title]));
  const bumpIds = new Set([...addOnsTaken.map((r) => String(r.id)), ...shownById.keys()]);
  const takenBy = new Map(addOnsTaken.map((r) => [String(r.id), r]));
  const addOns: Analytics["addOns"] = [...bumpIds]
    .map((id) => {
      const r = takenBy.get(id);
      const taken = n(r?.orders);
      const protection = id === PROTECTION_ADDON_ID;
      // Shipping protection: its display isn't recorded; every order with a line to ship could see it (estimate).
      const ar = protection
        ? { shown: Math.max(taken, money.extra.shipOrders), rate: ratio(taken, Math.max(taken, money.extra.shipOrders)), estimated: true }
        : attachRate(taken, shownById.get(id) ?? 0, legacyBumpOrders);
      const costed = r ? r.costed !== false : true;
      return {
        id,
        title: protection ? "Protection colis" : String(r?.title ?? bumpTitle.get(id) ?? "Option supprimée"),
        ...(protection ? { protection: true } : {}),
        orders: taken,
        shown: ar.shown,
        attachRate: ar.rate,
        estimated: ar.estimated,
        revenueCents: n(r?.revenue),
        revenueHtCents: n(r?.ht),
        costCents: costed ? n(r?.cost) : null,
        marginCents: costed ? n(r?.ht) - n(r?.cost) : null,
      };
    })
    .filter((x) => x.shown > 0)
    .sort((a, b) => b.revenueCents - a.revenueCents || b.shown - a.shown);
  const protectionRow = addOns.find((x) => x.protection);
  const protection =
    protectionRow || money.totals.claims
      ? {
          orders: protectionRow?.orders ?? 0,
          revenueHtCents: protectionRow?.revenueHtCents ?? 0,
          claims: money.totals.claims,
          claimsCents: money.totals.claimsCents,
          resultCents: (protectionRow?.revenueHtCents ?? 0) - money.totals.claimsCents,
        }
      : null;

  /* Offer A/B tests: same statistics as the design tests, per offer (impressions = visitors). */
  let offerTestRows: Analytics["offerTests"] = [];
  if (tested.size) {
    const liveBlocks = loadThankYouLayout(store?.thankYouLayout).blocks.filter((b): b is BlockOf<"upsell"> => b.type === "upsell");
    const aggs = await offerArmAggregates({ id: storeId, vatExempt: c.vatExempt, vatDomesticOnly: !!c.vatDomesticOnly, homeCountry: c.homeCountry }, p.since, p.until, p.includeTest);
    const splits = new Map(liveBlocks.map((b) => [b.id, b.props.variantB?.split ?? 50]));
    const asOf = new Date(Math.min(Date.now(), p.until.getTime()));
    offerTestRows = offerTests(aggs, splits, asOf).map((t) => {
      const block = liveBlocks.find((b) => b.id === t.offerId);
      return { ...t, offerTitle: offerTitle(t.offerId), live: !!block && !block.hidden && offerHasB(block), autoPromote: !!block?.props.variantB?.autoPromote };
    });
  }

  const mob = devices.find((d) => d.mobile === true);
  const desk = devices.find((d) => d.mobile === false);
  const newRow = customers.find((r) => r.returning === false);
  const retRow = customers.find((r) => r.returning === true);
  const prevProfit = pm.orders ? pm.profitCents : null;
  const fixedAvailable = !filters.source && !filters.country && !filters.device && !filters.lang && !filters.geo;
  const fixedPeriod = fixedAvailable ? fixedCostsFor(store?.fixedCostsMonthlyCents ?? 0, fromDay, toDay) : 0;

  /* Heatmap (ISO day of week 1 = Monday). */
  const heat = new Map<string, Analytics["heatmap"][number]>();
  const cellOf = (dow: number, hour: number) => {
    const k = `${dow}-${hour}`;
    let v = heat.get(k);
    if (!v) heat.set(k, (v = { dow, hour, sessions: 0, orders: 0, revenueHtCents: 0 }));
    return v;
  };
  for (const r of heatTraffic) Object.assign(cellOf(n(r.dow), n(r.hour)), { sessions: n(r.sessions), orders: n(r.converted) });
  for (const r of heatMoney) cellOf(n(r.dow), n(r.hour)).revenueHtCents = n(r.ht);

  const funnelGroup = (g: Traffic & { group: string }): FunnelGroup => ({ group: g.group, sessions: g.sessions, visitors: g.visitors, paidVisitors: g.paidVisitors, funnel: g.funnel });

  const productRows = products.map((r) => ({
    productId: String(r.product_id),
    title: String(r.title ?? "Produit"),
    units: n(r.units),
    orders: n(r.orders),
    revenueCents: n(r.net),
    revenueHtCents: n(r.ht),
    marginCents: r.costed ? n(r.ht) - n(r.cost) : null,
    refundRate: ratio(n(r.refunded_orders), n(r.orders)),
    refundedOrders: n(r.refunded_orders),
  }));
  const countryRows = countries.map((r) => ({
    country: String(r.country),
    orders: n(r.orders),
    revenueCents: n(r.net),
    revenueHtCents: n(r.ht),
    vatCents: n(r.net) - n(r.ht),
    profitCents: n(r.profit),
  }));
  const sumOf = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);

  return {
    currency: store?.shopCurrency ?? "EUR",
    vatExempt: c.vatExempt,
    sessions: t.sessions,
    visitors: t.visitors,
    paidVisitors: t.paidVisitors,
    orders: m.orders,
    revenueCents: m.revenueCents,
    revenueHtCents: m.revenueHtCents,
    vatCents: m.vatCents,
    grossCents: m.grossCents,
    upsellRevenueCents: m.upsellRevenueCents,
    feesCents: m.feesCents,
    feesKnown: m.coverage.fees === 1,
    aovCents: m.orders ? Math.round(m.revenueCents / m.orders) : 0,
    aovHtCents: m.orders ? Math.round(m.revenueHtCents / m.orders) : 0,
    cvr: ratio(t.paidVisitors, t.visitors),
    checkoutCvr: ratio(t.converted, t.sessions),
    abandoned: t.abandoned,
    money: m,
    profit: {
      cogsCents: m.productCostCents,
      bumpCostCents: m.bumpCostCents,
      shippingCostCents: m.shippingCostCents,
      fulfilmentCents: m.fulfilmentCents,
      claimsCents: m.claimsCents,
      costCoverage: m.coverage.products,
      grossProfitCents: m.profitCents,
      marginRate: ratio(m.profitCents, m.revenueHtCents),
      complete: m.complete,
      missing: m.missing,
    },
    ads: {
      available: spendAvailable,
      spendCents: spendTotal,
      platforms: Object.entries(
        (spendAvailable ? spendInView : []).reduce<Record<string, number>>((acc, s) => ((acc[s.platform] = (acc[s.platform] ?? 0) + s.spendCents), acc), {}),
      )
        .map(([platform, spendCents]) => ({ platform, spendCents }))
        .sort((a, b) => b.spendCents - a.spendCents),
      roas: spendTotal ? m.revenueHtCents / spendTotal : null,
      cpaCents: spendTotal && m.orders ? Math.round(spendTotal / m.orders) : null,
      poas: spendTotal ? m.profitCents / spendTotal : null,
      breakEvenRoas: storeBreakEven,
      breakEvenCpaCents: storeBreakEvenCpa,
      verdict: adVerdict(spendTotal ? m.profitCents / spendTotal : null, { spendCents: spendTotal, orders: m.orders, breakEvenCpaCents: storeBreakEvenCpa }),
      blendedCacCents: spendTotal && n(newRow?.customers) ? Math.round(spendTotal / n(newRow?.customers)) : null,
      newCustomers: n(newRow?.customers),
      netAfterAdsCents: m.profitCents - spendTotal,
      unattributed: filters.source ? [] : unattributed,
      lastDay: lastSpend?.day ?? null,
      unconverted: { rows: unconverted.reduce((a, r) => a + r._count._all, 0), currencies: unconverted.map((r) => r.currency) },
      // Web outside orders too, over the days the import covers (ours and the spend of the same days).
      roasInclExternal: (() => {
        if (!leakage?.lastImportAt || leakageRoas.empty) return null;
        const spent = leakageRoas.spend ?? spendTotal;
        return spent ? (leakageRoas.ours + leakageRoas.external) / spent : null;
      })(),
      coverageFrom: coverage.from,
      backfilling: coverage.backfilling,
    },
    previous: {
      sessions: prevTraffic.sessions,
      visitors: prevTraffic.visitors,
      orders: pm.orders,
      revenueCents: pm.revenueCents,
      revenueHtCents: pm.revenueHtCents,
      cvr: ratio(prevTraffic.paidVisitors, prevTraffic.visitors),
      checkoutCvr: ratio(prevTraffic.converted, prevTraffic.sessions),
      aovCents: pm.orders ? Math.round(pm.revenueCents / pm.orders) : 0,
      abandoned: prevTraffic.abandoned,
      profitCents: prevProfit,
      profitIncomplete: pm.orders > 0 && !pm.complete,
      profitEstimated: pm.orders > 0 && !pm.complete,
      spendCents: prevSpendTotal,
      netAfterAdsCents: prevProfit == null ? null : prevProfit - prevSpendTotal,
      roas: prevSpendTotal ? pm.revenueHtCents / prevSpendTotal : null,
      refundRate: ratio(prevMoney.extra.refunds, prevMoney.extra.tx),
      tx: prevMoney.extra.tx,
    },
    fixedCosts: {
      monthlyCents: store?.fixedCostsMonthlyCents ?? 0,
      periodCents: fixedPeriod,
      available: fixedAvailable,
      netAfterFixedCents: m.profitCents - spendTotal - fixedPeriod,
    },
    refundsByDate,
    claimsByDate: await claimsOfPeriod(c, p.since, p.until),
    // Every day of the period, zero-filled: days without sales are part of the picture.
    // Days the outside orders import doesn't cover: unknown (null), never a 0 in the series or the CSV.
    daily: daysBetween(fromDay, toDay).map((d) => {
      const row = dayRowOf(daily, d);
      return !coveredFromAt || d < windowFrom ? { ...row, externalRevenueHtCents: null, externalOrders: null } : row;
    }),
    timeToPurchase: { medianMin: money.extra.median, p75Min: money.extra.p75 },
    customers: {
      newCustomers: n(newRow?.customers),
      returningCustomers: n(retRow?.customers),
      newOrders: n(newRow?.orders),
      returningOrders: n(retRow?.orders),
      newRevenueCents: n(newRow?.net),
      returningRevenueCents: n(retRow?.net),
    },
    customerHistory: { ...customerHistoryOf(history), shopifyReturningOrders: n(retRow?.shop_only) },
    leakage,
    fallback: { periods: fallbackPeriods, days: fallbackDays },
    disabled: { periods: offRows.map(periodOf), days: disabledDays },
    vat: { reduced: !!c.reducedVat, reducedOrders: money.extra.vatReduced, unknownRateOrders: money.extra.vatUnknown },
    offers,
    funnel: t.funnel,
    funnelBy: {
      device: byDevice.filter((g) => g.group !== "inconnu" || g.sessions > 0).map(funnelGroup),
      // Top 4 sources, the rest summed into "Autres (n)" (same steps for every group).
      source: topWithOther(bySource.map(funnelGroup), 4, (rest) => ({
        group: `Autres (${rest.length})`,
        sessions: sumOf(rest, (g) => g.sessions),
        visitors: sumOf(rest, (g) => g.visitors),
        paidVisitors: sumOf(rest, (g) => g.paidVisitors),
        funnel: rest[0].funnel.map((st, i) => ({ ...st, count: sumOf(rest, (g) => g.funnel[i]?.count ?? 0) })),
      })),
      lang: groupWithOther(byLang.map(funnelGroup), 6),
      country: groupWithOther(byCountry.map(funnelGroup), 8),
    },
    geoCoverage: geoCoverageOf(byCountry),
    attribution: { touch, days: c.touchDays ?? store?.attributionDays ?? 7, storeDays: store?.attributionDays ?? 7 },
    survey: surveySummary(
      surveyRows.map((r) => ({ answer: r.survey == null ? null : String(r.survey), source: String(r.source), orders: n(r.orders), htCents: n(r.ht) })),
    ),
    heatmap: [...heat.values()].sort((a, b) => a.dow - b.dow || a.hour - b.hour),
    failedPayments: t.failed,
    sources,
    creatives: rowLimit === Infinity ? creatives : creatives.slice(0, 30),
    platformVsReal: spendAvailable ? platformVsReal(allSources, valueSpend, (sp) => bestRowFor(allSources, sp), htRatioOf(allSources), realOf) : [],
    methods: methods.map((r) => ({
      method: String(r.method),
      orders: n(r.orders),
      revenueCents: n(r.net),
      revenueHtCents: n(r.ht),
      grossCents: n(r.gross),
      feesCents: n(r.fee),
      feeKnownOrders: n(r.fee_known),
      profitCents: n(r.profit),
    })),
    countries: topWithOther(countryRows, rowLimit, (rest) => ({
      country: `Autres (${rest.length})`,
      orders: sumOf(rest, (r) => r.orders),
      revenueCents: sumOf(rest, (r) => r.revenueCents),
      revenueHtCents: sumOf(rest, (r) => r.revenueHtCents),
      vatCents: sumOf(rest, (r) => r.vatCents),
      profitCents: sumOf(rest, (r) => r.profitCents),
      other: true,
    })),
    products: topWithOther(productRows, rowLimit, (rest) => ({
      productId: "__other__",
      title: `Autres produits (${rest.length})`,
      units: sumOf(rest, (r) => r.units),
      orders: sumOf(rest, (r) => r.orders),
      revenueCents: sumOf(rest, (r) => r.revenueCents),
      revenueHtCents: sumOf(rest, (r) => r.revenueHtCents),
      marginCents: rest.every((r) => r.marginCents != null) ? sumOf(rest, (r) => r.marginCents ?? 0) : null,
      refundRate: ratio(sumOf(rest, (r) => r.refundedOrders), sumOf(rest, (r) => r.orders)),
      refundedOrders: sumOf(rest, (r) => r.refundedOrders),
      other: true,
    })).map((x) => {
      const { refundedOrders, ...rest } = x;
      void refundedOrders;
      return rest;
    }),
    addOns,
    protection,
    offerTests: offerTestRows,
    codes: codes.map((r) => ({
      code: String(r.code),
      orders: n(r.orders),
      discountCents: n(r.discount),
      revenueCents: n(r.net),
      revenueHtCents: n(r.ht),
      profitCents: n(r.profit),
      aovCents: n(r.orders) ? Math.round(n(r.net) / n(r.orders)) : 0,
    })),
    upsell: { shown: offerShown, accepted: m.upsellAccepted, revenueCents: m.upsellRevenueCents, legacyShown: legacy },
    risk: {
      refundedCents: m.refundedCents,
      refundRate: ratio(money.extra.refunds, money.extra.tx),
      disputes: money.extra.disputes,
      disputeRate: ratio(money.extra.disputes, money.extra.tx),
      reviewHolds: money.extra.holds,
      tx: money.extra.tx,
    },
    devices: {
      mobile: n(mob?.visitors),
      desktop: n(desk?.visitors),
      mobileCvr: n(mob?.visitors) ? ratio(n(mob?.paid_visitors), n(mob?.visitors)) : null,
      desktopCvr: n(desk?.visitors) ? ratio(n(desk?.paid_visitors), n(desk?.visitors)) : null,
      unknownSessions: byDevice.find((g) => g.group === "inconnu")?.sessions ?? 0,
    },
  };
}

/** Values the filter menus offer (sources, countries and checkout languages seen in the last 180 days). */
export async function filterOptions(storeId: string, includeTest: boolean): Promise<{ sources: string[]; countries: string[]; langs: string[] }> {
  const c = bareCtx(storeId, includeTest);
  const since = new Date(Date.now() - 180 * 86_400_000);
  const [sources, countries, langs] = await Promise.all([
    db.$queryRaw<{ v: string }[]>`SELECT ${attr(c).source} AS v FROM "CheckoutSession" s WHERE ${scope(c)} AND s."createdAt" >= ${since} GROUP BY 1 ORDER BY count(*) DESC LIMIT 40`,
    db.$queryRaw<{ v: string }[]>`SELECT ${COUNTRY} AS v FROM "CheckoutSession" s WHERE ${scope(c)} AND s."createdAt" >= ${since} AND s."shippingAddress" IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 60`,
    db.$queryRaw<{ v: string }[]>`SELECT ${LANG} AS v FROM "CheckoutSession" s WHERE ${scope(c)} AND s."createdAt" >= ${since} AND s.lang IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 30`,
  ]);
  return { sources: sources.map((r) => r.v), countries: countries.map((r) => r.v).filter((v) => v !== "—"), langs: langs.map((r) => r.v).filter((v) => v !== "inconnu") };
}

/* ------------------------------------------------------------------ */
/* Light summary (cross-store view): same engine, fewer queries        */
/* ------------------------------------------------------------------ */

export type SummaryFigures = {
  orders: number;
  revenueCents: number;
  revenueHtCents: number;
  profitCents: number;
  /** False when some costs are unknown (profit is then an estimate). */
  complete: boolean;
  visitors: number;
  cvr: number;
  spendCents: number;
  netAfterAdsCents: number;
  /** CA HT ÷ spend. */
  roas: number | null;
  /** Profit ÷ spend. */
  poas: number | null;
  /** Monthly fixed costs prorated over the period, and the result after them. */
  fixedCostsCents: number;
  netAfterFixedCents: number;
  /** Payments (orders + offers) and the share refunded (anomaly detection). */
  tx: number;
  refundRate: number;
};

export type StoreSummary = SummaryFigures & { previous: SummaryFigures };

async function summaryFigures(c: Ctx, since: Date, until: Date, from: string, to: string, fixedMonthlyCents: number): Promise<SummaryFigures> {
  const [money, traffic, spend] = await Promise.all([
    moneyTotals(c, since, until),
    trafficTotals(c, since, until),
    db.adSpend.aggregate({ where: { storeId: c.storeId, day: { gte: from, lte: to }, ...CAMPAIGN_ROWS }, _sum: { spendCents: true } }),
  ]);
  const spendCents = scaled(spend._sum.spendCents, c.adVatFactor);
  const fixedCostsCents = fixedCostsFor(fixedMonthlyCents, from, to);
  return {
    fixedCostsCents,
    netAfterFixedCents: money.totals.profitCents - spendCents - fixedCostsCents,
    tx: money.extra.tx,
    refundRate: ratio(money.extra.refunds, money.extra.tx),
    orders: money.totals.orders,
    revenueCents: money.totals.revenueCents,
    revenueHtCents: money.totals.revenueHtCents,
    profitCents: money.totals.profitCents,
    complete: money.totals.complete,
    visitors: traffic.visitors,
    cvr: ratio(traffic.paidVisitors, traffic.visitors),
    spendCents,
    netAfterAdsCents: money.totals.profitCents - spendCents,
    roas: spendCents ? money.totals.revenueHtCents / spendCents : null,
    poas: spendCents ? money.totals.profitCents / spendCents : null,
  };
}

/** Headline figures of a store for a period and the previous one (cross-store view), same engine as storeAnalytics. */
export async function storeSummary(
  storeId: string,
  range: { since: Date; until: Date; from: string; to: string; prevSince?: Date; prevFrom?: string; prevTo?: string },
  includeTest: boolean,
): Promise<StoreSummary> {
  const { ctx, store } = await storeCtx(storeId, includeTest);
  const days = dayCount(range.from, range.to);
  const prevTo = range.prevTo ?? addDays(range.from, -1);
  const prevFrom = range.prevFrom ?? addDays(prevTo, -(days - 1));
  const fixed = store?.fixedCostsMonthlyCents ?? 0;
  const [now, previous] = await Promise.all([
    summaryFigures(ctx, range.since, range.until, range.from, range.to, fixed),
    summaryFigures(ctx, range.prevSince ?? parisDayStart(prevFrom, ctx.tz), range.since, prevFrom, prevTo, fixed),
  ]);
  return { ...now, previous };
}

/** Anomalies of a cross-store summary (same rules and thresholds as the Analytics page). */
export function summaryAnomalies(s: StoreSummary): Anomaly[] {
  return detectAnomalies({
    cvr: s.cvr,
    visitors: s.visitors,
    previous: { visitors: s.previous.visitors, cvr: s.previous.cvr, roas: s.previous.roas, spendCents: s.previous.spendCents, refundRate: s.previous.refundRate },
    ads: { available: true, roas: s.roas, spendCents: s.spendCents },
    risk: { tx: s.tx, refundRate: s.refundRate },
  });
}

/* ------------------------------------------------------------------ */
/* Cohorts & lifetime value                                            */
/* ------------------------------------------------------------------ */

export type LtvBySource = {
  source: string;
  customers: number;
  n30: number;
  n60: number;
  n90: number;
  /** CA HT per customer within 30/60/90 days of the first order. */
  ltv30: number | null;
  ltv60: number | null;
  ltv90: number | null;
  /** Margin (per-order profit, same definition as everywhere) per customer within 30/60/90 days. */
  margin30: number | null;
  margin60: number | null;
  margin90: number | null;
  /** Ad spend attributed to the source's campaigns over the cohort window. */
  spendCents: number;
  /** Spend ÷ new customers of the source (null without spend). */
  cacCents: number | null;
  /** Margin LTV at the longest available horizon ÷ CAC. */
  ltvCac: number | null;
  ltvCacHorizon: 30 | 60 | 90 | null;
};

export type Cohorts = {
  months: {
    cohort: string;
    customers: number;
    /** Index = months since the first order (0 = same month). */
    repeatRate: (number | null)[];
    revenuePerCustomerHtCents: (number | null)[];
  }[];
  maxOffset: number;
  bySource: LtvBySource[];
  /** Days covered by the source table (customers acquired over that window). */
  windowDays: number;
  /** Some costs of those orders are unknown: margins are estimates. */
  estimated: boolean;
  /**
   * CAC window: spend and new customers from `cacFrom` (the later of 365 days ago and the first day
   * the spend of every connected ad platform is known), `cacDays` days. `backfilling`: ad spend
   * history still being imported.
   */
  cacFrom: string | null;
  cacDays: number;
  backfilling: boolean;
  /** Buyers left out of the cohorts and CAC: their first order here wasn't their first on the Shopify store. */
  shopifyReturning: number;
  /** Buyers' Shopify history import (see Analytics.customerHistory). */
  history: CustomerHistory;
  /** Spend of the window not matched to any source (not in any CAC). */
  unattributedSpendCents: number;
  /** Blended CAC over the window: all spend (attributed or not) ÷ all new customers. */
  blended: { customers: number; spendCents: number; cacCents: number | null };
};

/** LTV / CAC health: < 1 loses money, 1–3 fragile, ≥ 3 healthy. Pure. */
export function ltvCacLevel(r: number | null): "bad" | "warn" | "good" | null {
  if (r == null || !Number.isFinite(r)) return null;
  return r < 1 ? "bad" : r < 3 ? "warn" : "good";
}

/**
 * Per-source LTV (CA HT and margin) at 30/60/90 days, CAC and LTV/CAC. Only customers whose
 * first order is at least k days old count for the k-day figures. Pure: exported for tests.
 */
export function ltvRow(
  r: { source: string; customers: number; n30: number; n60: number; n90: number; r30: number; r60: number; r90: number; p30: number; p60: number; p90: number },
  spendCents: number,
  /** New customers of the CAC window (the spend's window, when shorter than the LTV one); defaults to `customers`. */
  cacCustomers = r.customers,
): LtvBySource {
  const per = (sum: number, k: number) => (k ? Math.round(sum / k) : null);
  const margin30 = per(r.p30, r.n30);
  const margin60 = per(r.p60, r.n60);
  const margin90 = per(r.p90, r.n90);
  const cacCents = spendCents && cacCustomers ? Math.round(spendCents / cacCustomers) : null;
  const [ltv, horizon] = margin90 != null ? [margin90, 90 as const] : margin60 != null ? [margin60, 60 as const] : margin30 != null ? [margin30, 30 as const] : [null, null];
  return {
    source: r.source,
    customers: r.customers,
    n30: r.n30,
    n60: r.n60,
    n90: r.n90,
    ltv30: per(r.r30, r.n30),
    ltv60: per(r.r60, r.n60),
    ltv90: per(r.r90, r.n90),
    margin30,
    margin60,
    margin90,
    spendCents,
    cacCents,
    ltvCac: cacCents && ltv != null ? ltv / cacCents : null,
    ltvCacHorizon: cacCents && ltv != null ? horizon : null,
  };
}

const LTV_WINDOW_DAYS = 365;

/**
 * Monthly acquisition cohorts (first paid order per e-mail, Paris months) over the last
 * `months` months: share of customers who ordered again by month k, and cumulative CA HT per
 * customer. Plus, by first-order source over the last 365 days: CA HT and margin per customer
 * at 30/60/90 days (only customers whose first order is at least that old), acquisition cost
 * (spend attributed to the source's campaigns over the window ÷ its new customers) and LTV/CAC.
 */
export async function storeCohorts(storeId: string, includeTest: boolean, months = 13): Promise<Cohorts> {
  const { ctx } = await storeCtx(storeId, includeTest);
  const now = new Date();
  const today = zonedDay(now, ctx.tz);
  const startMonth = `${today.slice(0, 7)}-01`;
  const [y, mo] = startMonth.split("-").map(Number);
  const first = new Date(Date.UTC(y, mo - 1 - (months - 1), 1)).toISOString().slice(0, 10);
  const since = parisDayStart(first, ctx.tz);
  const windowFrom = addDays(today, -(LTV_WINDOW_DAYS - 1));
  const windowSince = parisDayStart(windowFrom, ctx.tz);
  // CAC: spend and new customers only over the days the spend of every connected ad platform is known.
  const [coverage, history] = await Promise.all([spendCoverage(storeId, today), customersBackfillStatus(storeId)]);
  const cacFrom = coverage.from && coverage.from > windowFrom ? (coverage.from > today ? today : coverage.from) : windowFrom;
  const cacSince = parisDayStart(cacFrom, ctx.tz);
  const orders = ordersCteWhere(ctx, Prisma.sql`${scope(ctx)} AND s.status = 'PAID' AND s.email IS NOT NULL AND s."paidAt" IS NOT NULL`);
  // Buyers whose first order here wasn't their first on the Shopify store are no acquisition: left out.
  const base = Prisma.sql`${orders}, o AS (
      SELECT m.email AS e, m.paid_at, m.source, m.ht, m.profit,
             (m.fee_known AND m.costed_units = m.units AND m.bumps_costed = m.bumps AND m.ship_known) AS costs_known,
             ${shopifyReturningSql(storeId)} AS shop_ret
      FROM m
    ), r0 AS (
      SELECT o.*, row_number() OVER w AS rn, first_value(paid_at) OVER w AS first_at, first_value(source) OVER w AS first_source, first_value(shop_ret) OVER w AS first_shop_ret
      FROM o WINDOW w AS (PARTITION BY e ORDER BY paid_at ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
    ), r AS (
      SELECT r0.* FROM r0 WHERE NOT first_shop_ret
    ), x AS (
      SELECT r.*,
             to_char(${local(Prisma.sql`first_at`, ctx)}, 'YYYY-MM') AS cohort,
             ((extract(year FROM ${local(Prisma.sql`paid_at`, ctx)}) - extract(year FROM ${local(Prisma.sql`first_at`, ctx)})) * 12
               + extract(month FROM ${local(Prisma.sql`paid_at`, ctx)}) - extract(month FROM ${local(Prisma.sql`first_at`, ctx)}))::int AS k
      FROM r
    )`;
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000);
  const [grid, bySource, traffic, spend, excluded] = await Promise.all([
    db.$queryRaw<Record<string, unknown>[]>`${base}
      SELECT cohort, k, count(*) FILTER (WHERE rn = 1) AS new_customers, count(*) FILTER (WHERE rn = 2) AS second_orders, sum(ht) AS ht
      FROM x WHERE first_at >= ${since} GROUP BY 1, 2 ORDER BY 1, 2`,
    db.$queryRaw<Record<string, unknown>[]>`${base}
      SELECT first_source AS source, count(DISTINCT e) AS customers,
             count(DISTINCT e) FILTER (WHERE first_at <= ${ago(30)}) AS n30,
             count(DISTINCT e) FILTER (WHERE first_at <= ${ago(60)}) AS n60,
             count(DISTINCT e) FILTER (WHERE first_at <= ${ago(90)}) AS n90,
             sum(ht) FILTER (WHERE first_at <= ${ago(30)} AND paid_at < first_at + interval '30 days') AS r30,
             sum(ht) FILTER (WHERE first_at <= ${ago(60)} AND paid_at < first_at + interval '60 days') AS r60,
             sum(ht) FILTER (WHERE first_at <= ${ago(90)} AND paid_at < first_at + interval '90 days') AS r90,
             sum(profit) FILTER (WHERE first_at <= ${ago(30)} AND paid_at < first_at + interval '30 days') AS p30,
             sum(profit) FILTER (WHERE first_at <= ${ago(60)} AND paid_at < first_at + interval '60 days') AS p60,
             sum(profit) FILTER (WHERE first_at <= ${ago(90)} AND paid_at < first_at + interval '90 days') AS p90,
             bool_and(costs_known) AS costs_known,
             count(DISTINCT e) FILTER (WHERE first_at >= ${cacSince}) AS cac_customers
      FROM x WHERE first_at >= ${windowSince}
      GROUP BY 1 ORDER BY count(DISTINCT e) DESC, 1`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT ${attr(ctx).source} AS source, ${attr(ctx).campaign} AS campaign, count(*) AS sessions,
             COALESCE(array_agg(DISTINCT ${attr(ctx).utmId}) FILTER (WHERE ${attr(ctx).utmId} IS NOT NULL), '{}') AS utm_ids
      FROM "CheckoutSession" s WHERE ${scope(ctx)} AND s."createdAt" >= ${windowSince} GROUP BY 1, 2`,
    spendRows(storeId, cacFrom, today, false, ctx.adVatFactor),
    db.$queryRaw<Record<string, unknown>[]>`${orders}, o AS (
        SELECT m.email AS e, m.paid_at, ${shopifyReturningSql(storeId)} AS shop_ret FROM m
      ), r AS (
        SELECT e, first_value(paid_at) OVER w AS first_at, first_value(shop_ret) OVER w AS first_shop_ret
        FROM o WINDOW w AS (PARTITION BY e ORDER BY paid_at ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)
      )
      SELECT count(DISTINCT e) AS n FROM r WHERE first_shop_ret AND first_at >= ${windowSince}`,
  ]);
  // Spend of the window attributed to campaigns (same rule as the Acquisition table), summed per source.
  const trafficRows = traffic.map((r) => ({ source: String(r.source), campaign: String(r.campaign), sessions: n(r.sessions), utmIds: (r.utm_ids as string[]) ?? [] }));
  const { perRow, unattributed } = attributeSpend(trafficRows, spend);
  const spendBySource = new Map<string, number>();
  trafficRows.forEach((r, i) => spendBySource.set(r.source, (spendBySource.get(r.source) ?? 0) + perRow[i]));
  const rows = bySource.map((r) =>
    ltvRow(
      {
        source: String(r.source),
        customers: n(r.customers),
        n30: n(r.n30),
        n60: n(r.n60),
        n90: n(r.n90),
        r30: n(r.r30),
        r60: n(r.r60),
        r90: n(r.r90),
        p30: n(r.p30),
        p60: n(r.p60),
        p90: n(r.p90),
      },
      spendBySource.get(String(r.source)) ?? 0,
      n(r.cac_customers),
    ),
  );
  // Most customers first; keep every source that has spend even beyond the first 12.
  const shown = rows.filter((r, i) => i < 12 || r.spendCents > 0);
  return {
    ...cohortGrid(
      grid.map((r) => ({ cohort: String(r.cohort), k: n(r.k), newCustomers: n(r.new_customers), secondOrders: n(r.second_orders), htCents: n(r.ht) })),
      startMonth.slice(0, 7),
    ),
    bySource: shown,
    windowDays: LTV_WINDOW_DAYS,
    estimated: bySource.some((r) => r.costs_known === false),
    cacFrom,
    cacDays: dayCount(cacFrom, today),
    backfilling: coverage.backfilling,
    shopifyReturning: n(excluded[0]?.n),
    history: customerHistoryOf(history),
    unattributedSpendCents: unattributed.reduce((a, u) => a + u.spendCents, 0),
    blended: (() => {
      const customers = bySource.reduce((a, r) => a + n(r.cac_customers), 0);
      const spendCents = spend.reduce((a, r) => a + r.spendCents, 0);
      return { customers, spendCents, cacCents: customers && spendCents ? Math.round(spendCents / customers) : null };
    })(),
  };
}

/**
 * Builds the cohort triangle from (cohort month, months since first order) aggregates.
 * Offsets beyond the current month are null (not happened yet). Pure: exported for tests.
 */
export function cohortGrid(
  cells: { cohort: string; k: number; newCustomers: number; secondOrders: number; htCents: number }[],
  currentMonth: string,
): Pick<Cohorts, "months" | "maxOffset"> {
  const monthIndex = (ym: string) => Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
  const cohorts = [...new Set(cells.map((c) => c.cohort))].sort().reverse();
  let maxOffset = 0;
  const months = cohorts.map((cohort) => {
    const own = cells.filter((c) => c.cohort === cohort);
    const customers = own.reduce((a, c) => a + c.newCustomers, 0);
    const age = monthIndex(currentMonth) - monthIndex(cohort);
    maxOffset = Math.max(maxOffset, age);
    const repeatRate: (number | null)[] = [];
    const revenue: (number | null)[] = [];
    let repeat = 0;
    let cum = 0;
    for (let k = 0; k <= age; k++) {
      const cell = own.find((c) => c.k === k);
      repeat += cell?.secondOrders ?? 0;
      cum += cell?.htCents ?? 0;
      repeatRate.push(customers ? repeat / customers : null);
      revenue.push(customers ? Math.round(cum / customers) : null);
    }
    return { cohort, customers, repeatRate, revenuePerCustomerHtCents: revenue };
  });
  return { months, maxOffset };
}

/* ------------------------------------------------------------------ */
/* A/B tests                                                           */
/* ------------------------------------------------------------------ */

export type ExperimentResults = {
  stats: VariantStats[];
  verdict: Verdict;
  decision: Decision;
  ageDays: number;
  remainingDays: number | null;
  /** Revenue per visitor cap (99th percentile of buyers), cents. */
  capCents: number | null;
  /** Profit per visitor bounds (1st / 99th percentile of buyers), cents. */
  profitCapCents: [number, number] | null;
  /** Metric the decision uses; `metricChosen` = set by the merchant (else the default). */
  metric: PrimaryMetric;
  metricChosen: boolean;
  /** Every cost of the test's orders is known (profit is exact). */
  costsComplete: boolean;
};

const metricKey = (experimentId: string) => `experiment:metric:${experimentId}`;

/** Primary metric chosen for a test (AppSetting), or null for the default. */
export async function experimentMetric(experimentId: string): Promise<PrimaryMetric | null> {
  const row = await db.appSetting.findUnique({ where: { key: metricKey(experimentId) } });
  return row?.value === "profit" || row?.value === "revenue" ? row.value : null;
}

export async function setExperimentMetric(experimentId: string, metric: PrimaryMetric): Promise<void> {
  await db.appSetting.upsert({ where: { key: metricKey(experimentId) }, create: { key: metricKey(experimentId), value: metric }, update: { value: metric } });
}

/**
 * Per-variant results of an A/B test, aggregated in SQL per unique visitor. Revenue per
 * visitor is net of refunds and lost disputes, includes one-click offers, and is winsorized at
 * the 99th percentile of buyers' revenue (both variants pooled) before the t-test and the CIs.
 * Profit per visitor uses the per-order margin of the Analytics engine (HT, after fees, costs
 * and dispute fees), winsorized at the buyers' 1st and 99th percentiles. The primary metric is
 * the merchant's choice, else profit when every cost is known, else revenue.
 */
export async function experimentResults(experiment: { id: string; storeId: string; splitB: number; startedAt?: Date; endedAt?: Date | null }): Promise<ExperimentResults> {
  const inTest = Prisma.sql`s."storeId" = ${experiment.storeId} AND s."experimentId" = ${experiment.id} AND s."test" = false AND s.variant IN ('A', 'B')`;
  return abResults(experiment, inTest, Prisma.sql`s.variant`, await experimentMetric(experiment.id));
}

/**
 * Results of a checkout-element test (quantity breaks, order bump, protection price): the design
 * tests' engine on the checkouts that recorded an arm of this test (checkoutTestArms), opened while
 * it ran. The primary metric is the margin per visitor when every cost is known, else revenue.
 */
export async function checkoutTestResults(test: { id: string; storeId: string; splitB: number; startedAt: Date; endedAt?: Date | null }): Promise<ExperimentResults> {
  const arm = Prisma.sql`(s."checkoutTestArms"->>${test.id})`;
  const inTest = Prisma.sql`s."storeId" = ${test.storeId} AND s."test" = false AND ${arm} IN ('A', 'B') AND s."createdAt" >= ${test.startedAt}`;
  return abResults(test, inTest, arm, null);
}

async function abResults(
  experiment: { storeId: string; splitB: number; startedAt?: Date; endedAt?: Date | null },
  inTest: Prisma.Sql,
  variantOf: Prisma.Sql,
  chosen: PrimaryMetric | null,
): Promise<ExperimentResults> {
  const { ctx } = await storeCtx(experiment.storeId, false);
  const [rows] = await Promise.all([
    db.$queryRaw<Record<string, unknown>[]>`${ordersCteWhere(ctx, Prisma.sql`${inTest} AND s.status = 'PAID'`)}, v AS (
      SELECT ${variantOf} AS variant, COALESCE(s."visitorId", s.id) AS vid,
             bool_or(s.status = 'PAID') AS conv,
             count(m.id) AS orders,
             COALESCE(sum(m.net), 0)::float8 AS rev,
             COALESCE(sum(m.profit), 0)::float8 AS prof,
             COALESCE(bool_and(m.fee_known AND m.costed_units = m.units AND m.bumps_costed = m.bumps AND m.ship_known) FILTER (WHERE m.id IS NOT NULL), true) AS costs_known,
             bool_or(s."userAgent" IS NOT NULL AND ${MOBILE}) AS mobile,
             bool_or(s."userAgent" IS NOT NULL AND NOT ${MOBILE}) AS desktop,
             count(*) FILTER (WHERE s.status = 'PAID' AND (s."upsellShownAt" IS NOT NULL OR cardinality(s."upsellShownBlocks") > 0)) AS shown,
             COALESCE(sum(m.offers), 0) AS accepted
      FROM "CheckoutSession" s LEFT JOIN m ON m.id = s.id
      WHERE ${inTest}
      GROUP BY 1, 2
    ), cap AS (
      SELECT percentile_cont(0.99) WITHIN GROUP (ORDER BY rev) FILTER (WHERE rev > 0) AS c,
             percentile_cont(0.99) WITHIN GROUP (ORDER BY prof) FILTER (WHERE conv) AS phi,
             percentile_cont(0.01) WITHIN GROUP (ORDER BY prof) FILTER (WHERE conv) AS plo
      FROM v
    ), w AS (
      SELECT v.*, LEAST(rev, COALESCE(cap.c, rev)) AS rev_w,
             CASE WHEN conv THEN LEAST(GREATEST(prof, COALESCE(cap.plo, prof)), COALESCE(cap.phi, prof)) ELSE prof END AS prof_w,
             cap.c, cap.phi, cap.plo
      FROM v CROSS JOIN cap
    )
    SELECT variant, count(*) AS visitors, count(*) FILTER (WHERE conv) AS converted, sum(orders) AS orders, sum(rev) AS revenue, sum(prof) AS profit,
           avg(rev_w) AS rpv, COALESCE(var_samp(rev_w), 0) AS rpv_var,
           avg(prof_w) AS ppv, COALESCE(var_samp(prof_w), 0) AS ppv_var,
           bool_and(costs_known) AS costs_known,
           count(*) FILTER (WHERE mobile) AS mob, count(*) FILTER (WHERE mobile AND conv) AS mob_conv,
           count(*) FILTER (WHERE desktop AND NOT mobile) AS desk, count(*) FILTER (WHERE desktop AND NOT mobile AND conv) AS desk_conv,
           sum(shown) AS shown, sum(accepted) AS accepted, max(c) AS cap, max(phi) AS phi, max(plo) AS plo
    FROM w GROUP BY variant`,
  ]);
  const stats: VariantStats[] = ["A", "B"].map((variant) => {
    const r = rows.find((x) => x.variant === variant) ?? {};
    const visitors = n(r.visitors);
    const orders = n(r.orders);
    return {
      variant,
      visitors,
      converted: n(r.converted),
      orders,
      revenueCents: Math.round(n(r.revenue)),
      cvr: ratio(n(r.converted), visitors),
      rpv: n(r.rpv),
      rpvVar: n(r.rpv_var),
      ppv: n(r.ppv),
      ppvVar: n(r.ppv_var),
      profitCents: Math.round(n(r.profit)),
      aovCents: orders ? Math.round(n(r.revenue) / orders) : 0,
      offerTakeRate: n(r.shown) ? n(r.accepted) / n(r.shown) : null,
      mobile: { visitors: n(r.mob), cvr: ratio(n(r.mob_conv), n(r.mob)) },
      desktop: { visitors: n(r.desk), cvr: ratio(n(r.desk_conv), n(r.desk)) },
    };
  });
  const costsComplete = rows.every((r) => r.costs_known !== false);
  const metric: PrimaryMetric = chosen ?? (costsComplete ? "profit" : "revenue");
  const verdict = analyze(stats[0], stats[1], experiment.splitB);
  const start = experiment.startedAt?.getTime() ?? Date.now();
  const end = experiment.endedAt?.getTime() ?? Date.now();
  const ageDays = Math.max(0, (end - start) / 86_400_000);
  const cap = rows.find((r) => r.cap != null)?.cap;
  const pcap = rows.find((r) => r.phi != null);
  return {
    stats,
    verdict,
    decision: decide(verdict, ageDays, metric),
    ageDays,
    remainingDays: experiment.endedAt ? null : remainingDays(stats[0], stats[1], experiment.splitB, ageDays, undefined, metric),
    capCents: cap == null ? null : Math.round(n(cap)),
    profitCapCents: pcap ? [Math.round(n(pcap.plo)), Math.round(n(pcap.phi))] : null,
    metric,
    metricChosen: chosen != null,
    costsComplete,
  };
}

export type ExperimentHistoryItem = {
  id: string;
  name: string;
  startedAt: Date;
  endedAt: Date | null;
  splitB: number;
  visitors: number;
  rpvLift: number;
  cvrLift: number;
  rpvPValue: number;
  metric: PrimaryMetric;
  /** Lift and p-value of the primary metric. */
  lift: number;
  pValue: number;
  outcome: "b_published" | "a_kept" | "b_not_applied" | "stopped";
};

/** Finished tests, newest first, with their final numbers and what happened. */
export async function experimentHistory(storeId: string, limit = 10): Promise<ExperimentHistoryItem[]> {
  const past = await db.experiment.findMany({ where: { storeId, status: "STOPPED" }, orderBy: { startedAt: "desc" }, take: limit });
  return Promise.all(
    past.map(async (exp) => {
      const end = exp.endedAt ?? exp.startedAt;
      const [res, events] = await Promise.all([
        experimentResults(exp),
        db.eventLog.findMany({
          where: { storeId, kind: { in: ["experiment.stopped", "experiment.decided"] }, createdAt: { gte: new Date(end.getTime() - 120_000), lte: new Date(end.getTime() + 120_000) } },
          select: { message: true },
        }),
      ]);
      const text = events.map((e) => e.message).join(" ");
      const outcome: ExperimentHistoryItem["outcome"] = /B publiée|Publiée automatiquement/.test(text)
        ? "b_published"
        : /rien n'a été remplacé/.test(text)
          ? "b_not_applied"
          : /A conservée|A reste/.test(text)
            ? "a_kept"
            : "stopped";
      return {
        id: exp.id,
        name: exp.name,
        startedAt: exp.startedAt,
        endedAt: exp.endedAt,
        splitB: exp.splitB,
        visitors: res.stats[0].visitors + res.stats[1].visitors,
        rpvLift: res.verdict.rpvLift,
        cvrLift: res.verdict.cvrLift,
        rpvPValue: res.verdict.rpvPValue,
        metric: res.metric,
        lift: res.metric === "profit" ? res.verdict.ppvLift : res.verdict.rpvLift,
        pValue: res.metric === "profit" ? res.verdict.ppvPValue : res.verdict.rpvPValue,
        outcome,
      };
    }),
  );
}

/**
 * Tests with auto-promotion: once `decide` names a winner (≥ MIN_TEST_DAYS, enough visitors,
 * a healthy split, revenue per visitor significant at autoPromoteThreshold(age)), stop and
 * publish B as a new "Gagnant" version if it won. A design published by hand during the test
 * is never overwritten: the merchant is told instead.
 */
export async function autoPromoteExperiments(deadline = Infinity): Promise<number> {
  const running = await db.experiment.findMany({ where: { status: "RUNNING", autoPromote: true } });
  let decided = 0;
  for (const exp of running) {
    // Each test's results are a heavy query: none starts too close to the tick's deadline.
    if (stopForTime(deadline, ALERT_RESERVE_MS)) break;
    const ageDays = (Date.now() - exp.startedAt.getTime()) / (24 * 3600_000);
    if (ageDays < MIN_TEST_DAYS) continue;
    const { verdict, decision, metric } = await experimentResults(exp);
    if (decision.kind !== "winner") continue;
    const bWins = decision.winner === "B";
    const store = await db.store.findUnique({ where: { id: exp.storeId }, select: { publishedAt: true, timezone: true } });
    const publishedDuring = !!store?.publishedAt && store.publishedAt > exp.startedAt;
    let applied = false;
    if (bWins && !publishedDuring) {
      const v = await db.layoutVersion.findUnique({ where: { id: exp.versionId } });
      if (v) {
        await db.$transaction([
          db.layoutVersion.create({
            data: {
              storeId: exp.storeId,
              label: `Gagnant « ${exp.name} » (${new Date().toLocaleDateString("fr-FR", { timeZone: tzOf(store) })})`.slice(0, 120),
              theme: v.theme as Prisma.InputJsonValue,
              checkoutLayout: v.checkoutLayout as Prisma.InputJsonValue,
              thankYouLayout: v.thankYouLayout as Prisma.InputJsonValue,
            },
          }),
          db.store.update({
            where: { id: exp.storeId },
            data: { theme: v.theme as Prisma.InputJsonValue, checkoutLayout: v.checkoutLayout as Prisma.InputJsonValue, thankYouLayout: v.thankYouLayout as Prisma.InputJsonValue, publishedAt: new Date() },
          }),
        ]);
        applied = true;
      }
    }
    await db.experiment.update({ where: { id: exp.id }, data: { status: "STOPPED", endedAt: new Date() } });
    const lift = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, signDisplay: "always" }).format((metric === "profit" ? verdict.ppvLift : verdict.rpvLift) * 100);
    const what = PRIMARY_METRIC_LABEL[metric];
    await recordEvent({
      storeId: exp.storeId,
      level: "warn",
      kind: "experiment.decided",
      message: !bWins
        ? `Test A/B « ${exp.name} » : la variante A reste meilleure (${lift} % de ${what} pour B). Test arrêté, A conservée.`
        : applied
          ? `Test A/B « ${exp.name} » : la variante B gagne (${lift} % de ${what}). Publiée automatiquement (version « Gagnant » dans l'historique).`
          : `Test A/B « ${exp.name} » : la variante B gagne (${lift} % de ${what}), mais un autre design a été publié pendant le test : rien n'a été remplacé. Publiez B depuis l'historique si vous le souhaitez.`,
      data: { experimentId: exp.id },
      alert: true,
    });
    decided++;
  }
  return decided;
}

/* ------------------------------------------------------------------ */
/* Background alerts: anomalies and the daily report                   */
/* ------------------------------------------------------------------ */

/** Hour (0–23) at an instant in a time zone (Paris by default). */
export function parisHour(at: Date, tz = DEFAULT_TZ): number {
  return zonedHour(at, tz);
}

/** Atomically sets AppSetting `key` to `day` unless it already holds that day (or a later one). */
async function claimDay(key: string, day: string): Promise<boolean> {
  const claimed = await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${key}, ${day}, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
    WHERE "AppSetting"."value" < ${day}`;
  return claimed > 0;
}

/** Time kept before the tick deadline for one store's analytics. */
const ALERT_RESERVE_MS = 5_000;

/**
 * One store's analytics job failed: journaled (at most once an hour per store and job) and
 * the other stores go on; the store is retried at the next run (its day/hour isn't marked).
 */
async function analyticsJobFailed(job: string, store: { id: string; name: string }, err: unknown, now: Date) {
  const first = await claimDay(`analytics-failed:${job}:${store.id}`, parisHourKey(now)).catch(() => true);
  if (!first) return;
  await recordEvent({
    storeId: store.id,
    level: "warn",
    kind: "analytics.job_failed",
    message: `${store.name} : ${job} impossible pour l'instant (${err instanceof Error ? err.message : String(err)}). Nouvel essai au prochain passage de la maintenance.`,
    data: { job },
  });
}

const alertStores = (storeId?: string) =>
  db.store.findMany({ where: { enabled: true, ...(storeId ? { id: storeId } : {}) }, select: { id: true, name: true, testMode: true, timezone: true }, orderBy: { createdAt: "asc" } });

/** The last 7 complete days of the store's time zone (ending yesterday), compared with the 7 before. */
function lastWeek(now: Date, tz = DEFAULT_TZ): DayRange {
  const today = zonedDay(now, tz);
  return resolveRange({ range: "custom", from: addDays(today, -7), to: addDays(today, -1) }, today, "30d", tz);
}

/**
 * Once a day per store (AppSetting `anomaly-scan:<store>`): anomalies of the last 7 complete
 * days vs the 7 before (same rules as the Analytics page), each new one recorded as an alert
 * (deduplicated per store + type + day). Returns the number of alerts raised.
 */
export async function notifyAnomalies(deadline: number, now = new Date(), opts: { storeId?: string } = {}): Promise<number> {
  let raised = 0;
  for (const store of await alertStores(opts.storeId)) {
    if (stopForTime(deadline, ALERT_RESERVE_MS)) break;
    const tz = tzOf(store);
    const today = zonedDay(now, tz);
    try {
      const mark = await db.appSetting.findUnique({ where: { key: `anomaly-scan:${store.id}` } });
      if (mark && mark.value >= today) continue;
      const range = lastWeek(now, tz);
      const a = await storeAnalytics(store.id, { since: range.since, until: range.until, prevSince: range.prevSince, includeTest: includeTestFor(store) });
      for (const x of detectAnomalies(a)) {
        if (!(await claimDay(`anomaly:${store.id}:${x.key}`, today))) continue;
        await recordEvent({
          storeId: store.id,
          level: "warn",
          kind: "analytics.anomaly",
          message: `${store.name} : ${x.title} (7 derniers jours). ${x.detail}`,
          data: { anomaly: x.key, severity: x.severity, from: range.from, to: range.to },
          alert: true,
        });
        raised++;
      }
      await claimDay(`anomaly-scan:${store.id}`, today);
    } catch (err) {
      await analyticsJobFailed("détection d'anomalies", store, err, now);
    }
  }
  return raised;
}

/** Report text of one store's day. Pure: exported for tests. */
export function dailyReportMessage(
  storeName: string,
  day: string,
  currency: string,
  a: { revenueHtCents: number; orders: number; netAfterAdsCents: number; spendCents: number; roas: number | null; estimated: boolean },
  anomalies: Pick<Anomaly, "title">[],
  /** Campaigns with spend over the last 7 days (verdict and result after ads). */
  campaigns: { name: string; verdict: AdVerdict | null; spendCents: number; profitAfterAdsCents: number }[] = [],
  /** The day before (day-over-day comparison) and the day's share of the monthly fixed costs. */
  extra: {
    previous?: { revenueHtCents: number; orders: number; netAfterAdsCents: number | null };
    fixedCents?: number;
    /** Online-store sales outside this checkout that day (share of the online CA HT and amount): a line above LEAKAGE_ALERT_SHARE. */
    leakage?: { share: number | null; revenueHtCents: number; orders: number; fallbackShare?: number | null; fallbackOrders?: number | null } | null;
  } = {},
): string {
  const money = (c: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(c / 100);
  const label = new Date(`${day}T12:00:00Z`).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  const roas = a.roas == null ? "—" : new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(a.roas);
  const orders = `${a.orders} commande${a.orders > 1 ? "s" : ""}`;
  return (
    `${storeName}, ${label} : CA HT ${money(a.revenueHtCents)}, ${orders}, bénéfice après pub ${a.estimated ? "≈ " : ""}${money(a.netAfterAdsCents)}` +
    (a.spendCents ? ` (pub ${money(a.spendCents)}, ROAS HT ${roas})` : " (aucune dépense pub)") +
    (extra.fixedCents ? `, après frais fixes ${a.estimated ? "≈ " : ""}${money(a.netAfterAdsCents - extra.fixedCents)} (${money(extra.fixedCents)} de frais fixes du jour)` : "") +
    dayOverDay(a, extra.previous, money) +
    `. Anomalies : ${anomalies.length ? anomalies.map((x) => x.title).join(" ; ") : "aucune"}.` +
    leakageLine(extra.leakage, money) +
    campaignDigest(campaigns, money)
  );
}

/** Share of the online sales passing outside this checkout above which the report / an alert flags it. */
export const LEAKAGE_ALERT_SHARE = 0.1;

/** Fewest outside online orders in a day for a leakage line / alert (one or two orders are noise). */
export const LEAKAGE_MIN_ORDERS = 3;

/**
 * Share and orders of a day's online leakage the alert judges: the outside orders placed while the
 * storefront was on Shopify's own checkout on purpose (fallback, checkout switched off) are explained, and
 * left out. Pure.
 */
export function unexplainedLeakage(l: { share: number | null; orders: number; fallbackShare?: number | null; fallbackOrders?: number | null }): { share: number | null; orders: number } {
  if (l.share == null) return { share: null, orders: l.orders };
  return { share: Math.max(0, l.share - (l.fallbackShare ?? 0)), orders: Math.max(0, l.orders - (l.fallbackOrders ?? 0)) };
}

/**
 * Whether a day's online leakage deserves a line / alert: share > LEAKAGE_ALERT_SHARE on at least
 * LEAKAGE_MIN_ORDERS outside orders, both without the orders of fallback / checkout-off hours
 * (unexplainedLeakage) — and, with `dayEnd`, only once the outside orders are known past the end of that
 * day (`coveredUntil`: start of the last import run that completed; a run that failed or ran mid-day
 * never counts: held until one completes after it). Pure.
 */
export function leakageAlarming(
  l: { share: number | null; orders: number; coveredUntil?: string | null; fallbackShare?: number | null; fallbackOrders?: number | null } | null | undefined,
  opts: { dayEnd?: Date } = {},
): boolean {
  if (!l) return false;
  const u = unexplainedLeakage(l);
  if (u.share == null || u.orders < LEAKAGE_MIN_ORDERS || u.share <= LEAKAGE_ALERT_SHARE) return false;
  if (opts.dayEnd && !(l.coveredUntil && Date.parse(l.coveredUntil) >= opts.dayEnd.getTime())) return false;
  return true;
}

/** " (dont 4 % pendant le secours / la désactivation du checkout)" ("" without such orders). Pure. */
export function fallbackPart(l: { fallbackShare?: number | null; fallbackOrders?: number | null }): string {
  if (!l.fallbackOrders || !l.fallbackShare) return "";
  const pct = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(l.fallbackShare * 100);
  return ` (dont ${pct} % pendant le secours ou la désactivation du checkout Whop)`;
}

/** " Ventes en ligne hors checkout Whop : 14 % (3 commandes, 420 € HT)…" ("" under the threshold). Pure. */
function leakageLine(
  l: { share: number | null; revenueHtCents: number; orders: number; fallbackShare?: number | null; fallbackOrders?: number | null } | null | undefined,
  money: (c: number) => string,
): string {
  if (!leakageAlarming(l)) return "";
  const pct = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }).format(l!.share! * 100);
  return ` Ventes en ligne hors checkout Whop : ${pct} % du CA HT en ligne${fallbackPart(l!)} (${l!.orders} commande${l!.orders > 1 ? "s" : ""}, ${money(l!.revenueHtCents)} HT) : vérifiez le script de la boutique et le checkout de secours.`;
}

/** ". Veille : CA HT +12 %, 3 commandes (−1), bénéfice après pub +40 €" ("" without the day before). Pure. */
function dayOverDay(
  a: { revenueHtCents: number; orders: number; netAfterAdsCents: number },
  prev: { revenueHtCents: number; orders: number; netAfterAdsCents: number | null } | undefined,
  money: (c: number) => string,
): string {
  if (!prev) return "";
  const signed = (v: number) => new Intl.NumberFormat("fr-FR", { signDisplay: "always", maximumFractionDigits: 0 }).format(v);
  const rev = prev.revenueHtCents > 0 ? `CA HT ${signed(((a.revenueHtCents - prev.revenueHtCents) / prev.revenueHtCents) * 100)} %` : `CA HT ${money(prev.revenueHtCents)} la veille`;
  const orders = `${signed(a.orders - prev.orders)} commande${Math.abs(a.orders - prev.orders) > 1 ? "s" : ""}`;
  const net = prev.netAfterAdsCents == null ? "" : `, bénéfice après pub ${a.netAfterAdsCents - prev.netAfterAdsCents >= 0 ? "+" : ""}${money(a.netAfterAdsCents - prev.netAfterAdsCents)}`;
  return `. Par rapport à la veille : ${rev}, ${orders}${net}`;
}

const VERDICT_WORDS: Record<AdVerdict, string> = { scale: "à scaler", keep: "à garder", cut: "à couper", early: "trop tôt pour juger" };

/** " Campagnes (7 j) : 1 à scaler, 2 à couper… Plus grosse perte : X (−45 €)." ("" without campaigns). */
function campaignDigest(campaigns: { name: string; verdict: AdVerdict | null; spendCents: number; profitAfterAdsCents: number }[], money: (c: number) => string): string {
  const spent = campaigns.filter((c) => c.spendCents > 0);
  if (!spent.length) return "";
  // "Garder" with a negative profit after ads reads "≈ à l'équilibre" (as on the Analytics page).
  const word = (c: (typeof spent)[number]) => (c.verdict === "keep" && c.profitAfterAdsCents < 0 ? "≈ à l'équilibre" : c.verdict ? VERDICT_WORDS[c.verdict] : null);
  const counts = [...(["scale", "keep", "cut", "early"] as AdVerdict[]).map((v) => VERDICT_WORDS[v]), "≈ à l'équilibre"]
    .map((w) => [w, spent.filter((c) => word(c) === w).length] as const)
    .filter(([, k]) => k > 0)
    .map(([w, k]) => `${k} ${w}`);
  const loser = spent.reduce((w, c) => (c.profitAfterAdsCents < w.profitAfterAdsCents ? c : w), spent[0]);
  const cut = spent.filter((c) => c.verdict === "cut").map((c) => c.name);
  return (
    ` Campagnes (7 j) : ${counts.length ? counts.join(", ") : `${spent.length} sans verdict`}${cut.length ? ` (à couper : ${cut.slice(0, 3).join(", ")}${cut.length > 3 ? "…" : ""})` : ""}.` +
    (loser.profitAfterAdsCents < 0 ? ` Plus grosse perte : ${loser.name} (${money(loser.profitAfterAdsCents)} après pub).` : "")
  );
}

/** Campaign lines of an analytics view for the report: attributed rows with spend, plus unattributed spend. */
function campaignsOf(a: Analytics): { name: string; verdict: AdVerdict | null; spendCents: number; profitAfterAdsCents: number }[] {
  return [
    ...a.sources
      .filter((r) => r.spendCents > 0 && !r.other)
      .map((r) => ({ name: r.campaign !== "—" ? r.campaign : r.source, verdict: r.verdict, spendCents: r.spendCents, profitAfterAdsCents: r.profitAfterAdsCents })),
    ...a.ads.unattributed.map((u) => ({ name: u.campaign, verdict: null, spendCents: u.spendCents, profitAfterAdsCents: -u.spendCents })),
  ];
}

/**
 * One digest per store per day, at the first run after 07:00 in the store's time zone (AppSetting
 * `daily-report:<store>`): yesterday's CA HT, orders, profit after ads (and after the day's share
 * of the fixed costs) and ROAS, compared with the day before, plus the anomalies of the last 7 days. Stores with no activity at all yesterday get none.
 */
export async function sendDailyReport(deadline: number, now = new Date(), opts: { storeId?: string } = {}): Promise<number> {
  let sent = 0;
  for (const store of await alertStores(opts.storeId)) {
    if (stopForTime(deadline, ALERT_RESERVE_MS)) break;
    // 07:00 and "yesterday" in the store's own time zone.
    const tz = tzOf(store);
    if (zonedHour(now, tz) < 7) continue;
    const today = zonedDay(now, tz);
    const yesterday = addDays(today, -1);
    try {
      const key = `daily-report:${store.id}`;
      const mark = await db.appSetting.findUnique({ where: { key } });
      if (mark && mark.value >= today) continue;
      const includeTest = includeTestFor(store);
      const day = resolveRange({ range: "custom", from: yesterday, to: yesterday }, today, "30d", tz);
      const week = lastWeek(now, tz);
      const [a, w] = await Promise.all([
        storeAnalytics(store.id, { since: day.since, until: day.until, prevSince: day.prevSince, includeTest }),
        storeAnalytics(store.id, { since: week.since, until: week.until, prevSince: week.prevSince, includeTest }),
      ]);
      const anomalies = detectAnomalies(w);
      // Leakage is reported only from an import that completed after the end of the day (else held).
      const leakage = leakageAlarming(a.leakage, { dayEnd: day.until }) ? a.leakage : null;
      if (!(await claimDay(key, today))) continue;
      if (!a.orders && !a.sessions && !a.ads.spendCents && !anomalies.length && !leakage) continue;
      await recordEvent({
        storeId: store.id,
        level: "info",
        kind: "report.daily",
        message: dailyReportMessage(
          store.name,
          yesterday,
          a.currency,
          { revenueHtCents: a.revenueHtCents, orders: a.orders, netAfterAdsCents: a.ads.netAfterAdsCents, spendCents: a.ads.spendCents, roas: a.ads.roas, estimated: !a.profit.complete },
          anomalies,
          campaignsOf(w),
          {
            previous: { revenueHtCents: a.previous.revenueHtCents, orders: a.previous.orders, netAfterAdsCents: a.previous.netAfterAdsCents },
            fixedCents: a.fixedCosts.monthlyCents ? a.fixedCosts.periodCents : 0,
            leakage,
          },
        ),
        data: {
          day: yesterday,
          revenueHtCents: a.revenueHtCents,
          orders: a.orders,
          netAfterAdsCents: a.ads.netAfterAdsCents,
          fixedCostsCents: a.fixedCosts.periodCents,
          previous: { revenueHtCents: a.previous.revenueHtCents, orders: a.previous.orders, netAfterAdsCents: a.previous.netAfterAdsCents },
          roas: a.ads.roas,
          anomalies: anomalies.map((x) => x.key),
          leakageShare: leakage?.share ?? null,
        },
        alert: true,
      });
      sent++;
      // Its own journal row too (searchable, once per day checked): the day's online sales leaked past 10 %.
      // The report already alerts; a day held here (import not yet past its end) is taken over by
      // sendLateLeakageAlerts once an import completes after it.
      if (leakage && (await claimLeakageDay(store.id, yesterday))) await recordLeakage(store, yesterday, leakage, false);
    } catch (err) {
      await analyticsJobFailed("rapport quotidien", store, err, now);
    }
  }
  return sent;
}

/** Per store and day: the leakage of that day was checked (with a complete import) — alerted or not. */
const leakageDayKey = (storeId: string, day: string) => `leakage-alert:${storeId}:${day}`;

async function claimLeakageDay(storeId: string, day: string): Promise<boolean> {
  const r = await db.appSetting.createMany({ data: [{ key: leakageDayKey(storeId, day), value: new Date().toISOString() }], skipDuplicates: true });
  return r.count > 0;
}

async function recordLeakage(
  store: { id: string; name: string },
  day: string,
  leakage: { share: number | null; orders: number; revenueHtCents: number; fallbackShare?: number | null; fallbackOrders?: number | null },
  alert: boolean,
) {
  await recordEvent({
    storeId: store.id,
    level: "warn",
    kind: "analytics.leakage",
    message: `${store.name} : ${Math.round(leakage.share! * 100)} % des ventes en ligne du ${day} sont passées hors du checkout Whop${fallbackPart(leakage)} (${leakage.orders} commande(s)) : script de la boutique absent, visiteurs non redirigés ou checkout de secours actif ?`,
    data: {
      day,
      share: leakage.share,
      orders: leakage.orders,
      revenueHtCents: leakage.revenueHtCents,
      fallbackShare: leakage.fallbackShare ?? null,
      fallbackOrders: leakage.fallbackOrders ?? 0,
      alertShare: unexplainedLeakage(leakage).share,
      late: alert,
    },
    alert,
  });
}

/** Days looked back for a leakage the daily report had to hold (the outside-orders import lagging). */
export const LEAKAGE_LATE_DAYS = 3;

/**
 * Leakage of a day the daily report couldn't judge (the outside-orders import hadn't completed after the
 * end of that day when the report went): once an import has completed after it, the day is checked once
 * (`leakage-alert:<store>:<day>`) and, above the threshold, alerted on its own — never silently dropped.
 * Only days whose report is already out (else the report carries it). Returns the alerts sent.
 */
export async function sendLateLeakageAlerts(deadline: number, now = new Date(), opts: { storeId?: string } = {}): Promise<number> {
  let sent = 0;
  for (const store of await alertStores(opts.storeId)) {
    if (stopForTime(deadline, ALERT_RESERVE_MS)) break;
    try {
      const tz = tzOf(store);
      const today = zonedDay(now, tz);
      const [report, status, checked] = await Promise.all([
        db.appSetting.findUnique({ where: { key: `daily-report:${store.id}` } }),
        externalImportStatus(store.id),
        db.appSetting.findMany({ where: { key: { in: Array.from({ length: LEAKAGE_LATE_DAYS }, (_, i) => leakageDayKey(store.id, addDays(today, -1 - i))) } }, select: { key: true } }),
      ]);
      const coveredUntil = externalCoveredUntil(status);
      if (!report || coveredUntil == null) continue;
      for (let i = 1; i <= LEAKAGE_LATE_DAYS; i++) {
        const day = addDays(today, -i);
        // The report of `day` goes out on day + 1 (its mark then reads day + 1 or later).
        if (report.value < addDays(day, 1)) continue;
        if (checked.some((c) => c.key === leakageDayKey(store.id, day))) continue;
        const range = resolveRange({ range: "custom", from: day, to: day }, today, "30d", tz);
        // Orders not known past the day's end yet (no run completed after it; a failed one never counts).
        if (coveredUntil < range.until.getTime()) continue;
        const a = await storeAnalytics(store.id, { since: range.since, until: range.until, prevSince: range.prevSince, includeTest: includeTestFor(store) });
        if (!a.leakage?.lastImportAt) continue;
        if (!(await claimLeakageDay(store.id, day))) continue;
        if (!leakageAlarming(a.leakage, { dayEnd: range.until })) continue;
        await recordLeakage(store, day, a.leakage, true);
        sent++;
      }
    } catch (err) {
      await analyticsJobFailed("alerte ventes hors checkout", store, err, now);
    }
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Proactive alerts (hourly): stop-loss, no sales, failed payments,    */
/* dispute rate                                                        */
/* ------------------------------------------------------------------ */

/** Today's spend above which a campaign with no order is flagged: 1.5 × break-even CPA (fallback when unknown). Pure. */
export function stopLossThreshold(breakEvenCpaCents: number | null): number {
  return breakEvenCpaCents != null && breakEvenCpaCents > 0 ? Math.round(1.5 * breakEvenCpaCents) : EARLY_FALLBACK_SPEND_CENTS;
}

/** Multiple of the break-even CPA beyond which a converting campaign is still losing money (and the spend it needs first). */
export const STOP_LOSS_CPA_MULTIPLE = 2;

/**
 * Campaigns of the day to stop: spent more than the stop-loss threshold without any order
 * ("no_order"), or — with a known break-even CPA — spent at least 2 × the break-even CPA with a
 * CPA above 2 × the break-even CPA ("cpa": each order loses money). Pure.
 */
export function stopLossHits<R extends { campaign: string; spendCents: number; orders: number }>(rows: R[], breakEvenCpaCents: number | null): (R & { reason: "no_order" | "cpa"; cpaCents: number | null })[] {
  const limit = stopLossThreshold(breakEvenCpaCents);
  const be = breakEvenCpaCents != null && breakEvenCpaCents > 0 ? breakEvenCpaCents : null;
  const out: (R & { reason: "no_order" | "cpa"; cpaCents: number | null })[] = [];
  for (const r of rows) {
    if (r.orders === 0 && r.spendCents > limit) out.push({ ...r, reason: "no_order", cpaCents: null });
    else if (be != null && r.orders > 0 && r.spendCents >= STOP_LOSS_CPA_MULTIPLE * be && r.spendCents / r.orders > STOP_LOSS_CPA_MULTIPLE * be) {
      out.push({ ...r, reason: "cpa", cpaCents: Math.round(r.spendCents / r.orders) });
    }
  }
  return out.sort((a, b) => b.spendCents - a.spendCents);
}

/**
 * "No sales" check: checkouts opened since the last payment vs the store's usual conversion per
 * checkout (30 days). Alerts only with ≥ 10 checkouts and ≥ 3 payments expected (P(0) ≈ 5 %). Pure.
 */
export function noSalesExpected(i: { checkouts: number; basePaid: number; baseCheckouts: number }): number | null {
  if (i.checkouts < 10 || !i.baseCheckouts || !i.basePaid) return null;
  const expected = (i.checkouts * i.basePaid) / i.baseCheckouts;
  return expected >= 3 ? expected : null;
}

/**
 * Failed-payment spike: share of failed attempts (failed ÷ (failed + paid)) over the last window,
 * at least 5 failures, ≥ 30 % and ≥ twice the 30-day share. Pure.
 */
export function failedSpike(i: { failed: number; paid: number; baseFailed: number; basePaid: number }): { share: number; baseShare: number } | null {
  const share = ratio(i.failed, i.failed + i.paid);
  const baseShare = ratio(i.baseFailed, i.baseFailed + i.basePaid);
  if (i.failed < 5 || share < 0.3 || share < 2 * baseShare) return null;
  return { share, baseShare };
}

/** Rolling 30-day dispute rate: ≥ 1 % critical (Whop account at risk), ≥ 0.75 % warn; needs ≥ 20 payments. Pure. */
export function disputeRateLevel(disputes: number, payments: number): "critical" | "warn" | null {
  if (payments < 20 || disputes < 1) return null;
  const rate = disputes / payments;
  return rate >= 0.01 ? "critical" : rate >= 0.0075 ? "warn" : null;
}

/** "YYYY-MM-DDTHH" of an instant in a time zone (hourly dedupe key). */
function parisHourKey(at: Date, tz = DEFAULT_TZ): string {
  return `${zonedDay(at, tz)}T${String(zonedHour(at, tz)).padStart(2, "0")}`;
}

/** Claims `key` unless it was claimed less than `days` days before `day` (AppSetting holds the day). */
async function claimEvery(key: string, day: string, days: number): Promise<boolean> {
  const before = addDays(day, -(days - 1));
  const claimed = await db.$executeRaw`
    INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${key}, ${day}, now())
    ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
    WHERE "AppSetting"."value" < ${before}`;
  return claimed > 0;
}

const HOUR_MS = 3_600_000;

/**
 * Hourly per store (AppSetting `stoploss-scan:<store>` = hour in the store's time zone):
 *  - stop-loss: a campaign spent more than 1.5 × the break-even CPA (30-day margin per order) today
 *    without any order, or spent ≥ 2 × the break-even CPA at a CPA above 2 × the break-even CPA
 *    (once per store + campaign + day + reason);
 *  - no sales: 0 payment since the last one despite ≥ 10 checkouts opened, when ≥ 3 were expected
 *    from the 30-day conversion per checkout (once per store + day);
 *  - failed-payment spike over the last 2 hours (once per store + day);
 *  - rolling 30-day dispute rate ≥ 0.75 % (warn) / ≥ 1 % (critical), at most once a week per level.
 * Returns the number of alerts raised.
 */
export async function notifyStopLoss(deadline: number, now = new Date(), opts: { storeId?: string } = {}): Promise<number> {
  let raised = 0;
  const fmtInt = new Intl.NumberFormat("fr-FR");
  const pctFmt = (v: number, d = 1) => new Intl.NumberFormat("fr-FR", { style: "percent", minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
  for (const store of await alertStores(opts.storeId)) {
    if (stopForTime(deadline, ALERT_RESERVE_MS)) break;
    const tz = tzOf(store);
    const today = zonedDay(now, tz);
    const hourKey = parisHourKey(now, tz);
    // The hour is marked done only once this store's checks all ran (a failure retries next run).
    const scanKey = `stoploss-scan:${store.id}`;
    const scan = await db.appSetting.findUnique({ where: { key: scanKey } });
    if (scan && scan.value >= hourKey) continue;
    try {
      const includeTest = includeTestFor(store);
      const { ctx, store: settings } = await storeCtx(store.id, includeTest);
      const currency = settings?.shopCurrency ?? "EUR";
      const money = (c: number) => new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 0 }).format(c / 100);
      const todayStart = parisDayStart(today, tz);
      const since30 = parisDayStart(addDays(today, -30), tz);
      const raise = async (kind: string, level: "warn" | "error", message: string, data: Record<string, unknown>) => {
        await recordEvent({ storeId: store.id, level, kind, message: `${store.name} : ${message}`, data: data as never, alert: true });
        raised++;
      };

      /* Stop-loss (campaign spend of today without order). */
      const [base, day] = await Promise.all([
        moneyTotals(ctx, since30, todayStart),
        storeAnalytics(store.id, { since: todayStart, until: new Date(Math.max(now.getTime(), todayStart.getTime() + 1)), includeTest }, { rowLimit: Infinity }),
      ]);
      const beCpa = breakEvenCpa(base.totals.profitCents, base.totals.orders);
      const rows = [
        ...day.sources.filter((r) => r.spendCents > 0).map((r) => ({ campaign: r.campaign !== "—" ? r.campaign : r.source, spendCents: r.spendCents, orders: r.orders })),
        ...day.ads.unattributed.map((u) => ({ campaign: u.campaign, spendCents: u.spendCents, orders: 0 })),
      ];
      for (const hit of stopLossHits(rows, beCpa)) {
        if (stopForTime(deadline, ALERT_RESERVE_MS)) break;
        // One alert per campaign, day and reason (a campaign can first spend without order, then convert too expensively).
        const reasonKey = hit.reason === "cpa" ? ":cpa" : "";
        if (!(await claimDay(`stoploss:${store.id}:${hit.campaign.toLowerCase().slice(0, 150)}${reasonKey}`, today))) continue;
        await raise(
          "analytics.stoploss",
          "warn",
          hit.reason === "cpa"
            ? `Campagne ${hit.campaign} : CPA de ${money(hit.cpaCents ?? 0)} aujourd'hui (${money(hit.spendCents)} pour ${fmtInt.format(hit.orders)} commande(s)), plus de 2 × votre CPA de rentabilité (${money(beCpa ?? 0)} de marge par commande) : chaque vente coûte plus qu'elle ne rapporte. Coupez ou baissez le budget.`
            : `Campagne ${hit.campaign} : ${money(hit.spendCents)} dépensés aujourd'hui, 0 commande (seuil ${money(stopLossThreshold(beCpa))}${beCpa != null && beCpa > 0 ? ` = 1,5 × marge par commande de ${money(beCpa)}` : ""}). Coupez ou vérifiez la campagne.`,
          { campaign: hit.campaign, spendCents: hit.spendCents, orders: hit.orders, reason: hit.reason, cpaCents: hit.cpaCents, breakEvenCpaCents: beCpa, day: today },
        );
      }

      /* No sales since the last payment despite checkouts. */
      const testSql = includeTest ? Prisma.empty : Prisma.sql`AND s."test" = false`;
      const [last] = await db.$queryRaw<{ at: Date | null }[]>`SELECT max(s."paidAt") AS at FROM "CheckoutSession" s WHERE s."storeId" = ${store.id} AND s.status = 'PAID' ${testSql}`;
      const lastPaid = last?.at ?? null;
      const windowStart = new Date(Math.max(lastPaid?.getTime() ?? 0, now.getTime() - 24 * HOUR_MS));
      // A checkout opened in the last 10 minutes can't be expected to have paid yet.
      const windowEnd = new Date(now.getTime() - 10 * 60_000);
      if (windowEnd > windowStart) {
        const [w] = await db.$queryRaw<Record<string, unknown>[]>`
          SELECT count(*) FILTER (WHERE s."createdAt" >= ${windowStart} AND s."createdAt" < ${windowEnd}) AS checkouts,
                 count(*) FILTER (WHERE s."createdAt" >= ${since30} AND s."createdAt" < ${windowStart}) AS base_checkouts,
                 count(*) FILTER (WHERE s."createdAt" >= ${since30} AND s."createdAt" < ${windowStart} AND s.status = 'PAID') AS base_paid
          FROM "CheckoutSession" s WHERE s."storeId" = ${store.id} ${testSql} AND s."createdAt" >= ${since30}`;
        const checkouts = n(w?.checkouts);
        const expected = noSalesExpected({ checkouts, basePaid: n(w?.base_paid), baseCheckouts: n(w?.base_checkouts) });
        if (expected != null && (await claimDay(`nosales:${store.id}`, today))) {
          const hours = Math.max(1, Math.round((now.getTime() - (lastPaid?.getTime() ?? windowStart.getTime())) / HOUR_MS));
          const basePaid = n(w?.base_paid);
          const perDay = basePaid / Math.max(1, (windowStart.getTime() - since30.getTime()) / (24 * HOUR_MS));
          await raise(
            "analytics.no_sales",
            "error",
            `0 paiement depuis ${hours} h malgré ${fmtInt.format(checkouts)} checkouts ouverts (≈ ${fmtInt.format(Math.round(expected))} attendus à votre conversion habituelle, ${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(perDay)} paiement(s) par jour en moyenne sur 30 j). Vérifiez le paiement Whop et le checkout.`,
            { hours, checkouts, expected, lastPaidAt: lastPaid?.toISOString() ?? null },
          );
        }
      }

      /* Failed-payment spike (last 2 hours vs 30 days). */
      const spikeFrom = new Date(now.getTime() - 2 * HOUR_MS);
      const [f] = await db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*) FILTER (WHERE s."paymentFailedAt" >= ${spikeFrom} AND s."paymentFailedAt" < ${now}) AS failed,
               count(*) FILTER (WHERE s.status = 'PAID' AND s."paidAt" >= ${spikeFrom} AND s."paidAt" < ${now}) AS paid,
               count(*) FILTER (WHERE s."paymentFailedAt" >= ${since30} AND s."paymentFailedAt" < ${spikeFrom}) AS base_failed,
               count(*) FILTER (WHERE s.status = 'PAID' AND s."paidAt" >= ${since30} AND s."paidAt" < ${spikeFrom}) AS base_paid
        FROM "CheckoutSession" s
        WHERE s."storeId" = ${store.id} ${testSql} AND (s."paymentFailedAt" >= ${since30} OR s."paidAt" >= ${since30})`;
      const spike = failedSpike({ failed: n(f?.failed), paid: n(f?.paid), baseFailed: n(f?.base_failed), basePaid: n(f?.base_paid) });
      if (spike && (await claimDay(`failspike:${store.id}`, today))) {
        await raise(
          "analytics.failed_spike",
          "warn",
          `${fmtInt.format(n(f?.failed))} paiements refusés en 2 h (${pctFmt(spike.share, 0)} des tentatives, contre ${pctFmt(spike.baseShare)} habituellement). Vérifiez Whop (moyens de paiement, 3-D Secure) et les commandes à vérifier.`,
          { failed: n(f?.failed), paid: n(f?.paid), share: spike.share, baseShare: spike.baseShare },
        );
      }

      /* Rolling 30-day dispute rate (orders + one-click offers). */
      const [d] = await db.$queryRaw<Record<string, unknown>[]>`
        SELECT (SELECT count(*) FROM "CheckoutSession" s WHERE s."storeId" = ${store.id} ${testSql} AND s.status = 'PAID' AND s."paidAt" >= ${since30})
             + (SELECT count(*) FROM "UpsellCharge" u JOIN "CheckoutSession" s ON s.id = u."sessionId"
                WHERE s."storeId" = ${store.id} ${testSql} AND u.status = 'PAID' AND u."createdAt" >= ${since30}) AS payments,
               (SELECT count(*) FROM "CheckoutSession" s WHERE s."storeId" = ${store.id} ${testSql} AND s.disputed AND COALESCE(s."disputeOpenedAt", s."paidAt") >= ${since30})
             + (SELECT count(*) FROM "UpsellCharge" u JOIN "CheckoutSession" s ON s.id = u."sessionId"
                WHERE s."storeId" = ${store.id} ${testSql} AND u.disputed AND COALESCE(u."disputeOpenedAt", u."createdAt") >= ${since30}) AS disputes`;
      const disputes = n(d?.disputes);
      const payments = n(d?.payments);
      const level = disputeRateLevel(disputes, payments);
      if (level && (await claimEvery(`disputerate:${store.id}:${level}`, today, 7))) {
        const rate = pctFmt(disputes / payments, 2);
        await raise(
          "analytics.dispute_rate",
          level === "critical" ? "error" : "warn",
          level === "critical"
            ? `taux de litige critique sur 30 jours : ${rate} (${fmtInt.format(disputes)} litige(s) pour ${fmtInt.format(payments)} paiements). Au-delà de 1 %, votre compte Whop risque d'être restreint : remboursez les clients mécontents avant qu'ils ne contestent et vérifiez le suivi des colis.`
            : `taux de litige en hausse sur 30 jours : ${rate} (${fmtInt.format(disputes)} litige(s) pour ${fmtInt.format(payments)} paiements). Seuil d'alerte des réseaux de paiement : 0,75 %, critique à 1 %.`,
          { disputes, payments, rate: disputes / payments, severity: level },
        );
      }
      await claimDay(scanKey, hourKey);
    } catch (err) {
      await analyticsJobFailed("alertes horaires (stop-loss, ventes, paiements refusés, litiges)", store, err, now);
    }
  }
  return raised;
}

/* ------------------------------------------------------------------ */
/* Drill-down (Orders list, CSV export)                                */
/* ------------------------------------------------------------------ */

export type Drill = Filters & { method?: string; product?: string };

export function hasDrill(d: Drill): boolean {
  return !!(d.source || d.country || d.device || d.lang || d.geo || d.method || d.product);
}

/**
 * Ids of the store's checkouts matching drill-down dimensions (same expressions as the
 * analytics tables), within an optional window (paidAt for paid checkouts, else createdAt).
 */
export async function drillSessionIds(
  storeId: string,
  d: Drill,
  opts: { since?: Date | null; until?: Date | null; includeTest?: boolean; limit?: number; /** Attribution window of a source drill (default: the store's). */ attributionDays?: number } = {},
): Promise<string[]> {
  let days: number | null = null;
  if (d.source) {
    days = opts.attributionDays != null && (ATTRIBUTION_WINDOWS as readonly number[]).includes(opts.attributionDays)
      ? opts.attributionDays
      : ((await db.store.findUnique({ where: { id: storeId }, select: { attributionDays: true } }))?.attributionDays ?? 7);
  }
  const c = bareCtx(storeId, opts.includeTest ?? true, { source: d.source, country: d.country, device: d.device, lang: d.lang, geo: d.geo }, days);
  const parts: Prisma.Sql[] = [scope(c)];
  if (d.method) parts.push(d.method === "inconnu" ? Prisma.sql`COALESCE(s."paymentMethodType", '') = ''` : Prisma.sql`s."paymentMethodType" = ${d.method}`);
  if (d.product)
    parts.push(Prisma.sql`(
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s.lines) = 'array' THEN s.lines ELSE '[]'::jsonb END) x WHERE COALESCE(x->>'productId', x->>'title') = ${d.product})
      OR EXISTS (SELECT 1 FROM "UpsellCharge" u WHERE u."sessionId" = s.id AND u.status = 'PAID' AND COALESCE(u."productId", u.title) = ${d.product}))`);
  const at = Prisma.sql`COALESCE(s."paidAt", s."createdAt")`;
  if (opts.since) parts.push(Prisma.sql`${at} >= ${opts.since}`);
  if (opts.until) parts.push(Prisma.sql`${at} < ${opts.until}`);
  const rows = await db.$queryRaw<{ id: string }[]>`SELECT s.id FROM "CheckoutSession" s WHERE ${Prisma.join(parts, " AND ")} LIMIT ${opts.limit ?? 20_000}`;
  return rows.map((r) => r.id);
}
