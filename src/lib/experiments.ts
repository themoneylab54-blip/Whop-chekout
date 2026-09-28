import "server-only";
import { createHash } from "node:crypto";
import type { CheckoutSession, Store } from "@prisma/client";
import { db } from "./db";

/*
 * A/B tests of checkout designs.
 * - Control (A) is pinned to the design published when the test started, so
 *   publishing during a test can't change the baseline; B is a saved version.
 * - Assignment is sticky per visitor (hash of the storefront's anonymous visitor id),
 *   and results are computed per unique visitor, not per checkout click.
 * - Conversion is compared with a two-proportion z-test, revenue per visitor (winsorized
 *   at the buyers' 99th percentile, so one huge order can't decide) with a Welch t-test,
 *   both with 95 % confidence intervals on the relative lift; a sample-ratio check flags
 *   broken splits; one decision rule (`decide`) for the dashboard and auto-promotion.
 * - Each test has a primary metric: revenue per visitor (CA net TTC) or profit per visitor
 *   (per-order margin HT, same definition as Analytics, winsorized at the buyers' 1st/99th
 *   percentiles). When the primary metric and conversion disagree by more than 2 %, the
 *   verdict is a trade-off: never promoted automatically.
 * - Two variants only (A/B): multi-variant tests are out of scope.
 */

export type PrimaryMetric = "revenue" | "profit";
export const PRIMARY_METRIC_LABEL: Record<PrimaryMetric, string> = { revenue: "CA par visiteur", profit: "marge par visiteur" };
/** Conversion change beyond which a better primary metric is a trade-off, not a win. */
export const CVR_TRADEOFF = 0.02;

export async function runningExperiment(storeId: string) {
  return db.experiment.findFirst({ where: { storeId, status: "RUNNING" }, orderBy: { startedAt: "desc" } });
}

/** Deterministic bucket in [0, 100) for a visitor in an experiment. */
export function bucketOf(visitorKey: string, experimentId: string): number {
  const h = createHash("sha256").update(`${experimentId}:${visitorKey}`).digest();
  return (h.readUInt32BE(0) / 0x1_0000_0000) * 100;
}

export async function assignVariant(storeId: string, visitorId: string | null): Promise<{ experimentId?: string; variant?: string }> {
  const exp = await runningExperiment(storeId);
  if (!exp) return {};
  // Without a visitor id (old loader, cookies blocked) fall back to a per-session draw.
  const bucket = visitorId ? bucketOf(visitorId, exp.id) : Math.random() * 100;
  return { experimentId: exp.id, variant: bucket < exp.splitB ? "B" : "A" };
}

/** Design (theme + checkout/thank-you layouts) a session must see. */
export async function designFor(store: Store, session: Pick<CheckoutSession, "experimentId" | "variant">) {
  if (session.experimentId && session.variant) {
    const exp = await db.experiment.findUnique({ where: { id: session.experimentId } });
    const versionId = session.variant === "B" ? exp?.versionId : exp?.versionIdA;
    const version = versionId ? await db.layoutVersion.findUnique({ where: { id: versionId } }) : null;
    if (version) return { theme: version.theme, checkoutLayout: version.checkoutLayout, thankYouLayout: version.thankYouLayout };
  }
  return { theme: store.theme, checkoutLayout: store.checkoutLayout, thankYouLayout: store.thankYouLayout };
}


/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

export type VariantStats = {
  variant: string;
  visitors: number;
  /** Visitors with at least one paid checkout. */
  converted?: number;
  orders: number;
  /** Net revenue (refunds deducted, offers included), not winsorized. */
  revenueCents: number;
  cvr: number;
  /** Revenue per visitor (cents), winsorized at the 99th percentile of buyers when computed in SQL. */
  rpv: number;
  /** Variance of revenue per visitor (cents²), for the t-test. */
  rpvVar: number;
  /** Profit (margin HT) per visitor, winsorized, and its variance. */
  ppv?: number;
  ppvVar?: number;
  /** Total margin HT of the variant's orders (not winsorized). */
  profitCents?: number;
  /** Average order value (net revenue ÷ paid orders). */
  aovCents?: number;
  /** Post-purchase offers accepted ÷ orders that were shown one. */
  offerTakeRate?: number | null;
  mobile?: { visitors: number; cvr: number };
  desktop?: { visitors: number; cvr: number };
};

type Row = { variant: string | null; visitorId: string | null; id: string; status: string; totalCents: number };

/**
 * Groups checkout sessions into unique visitors (a visitor converts if any of their checkouts
 * is paid). In-memory reference implementation of the SQL aggregate used by the dashboard;
 * `winsorizeAt` caps each visitor's revenue (e.g. at the buyers' 99th percentile).
 */
export function summarize(rows: Row[], winsorizeAt?: number): VariantStats[] {
  return ["A", "B"].map((v) => {
    const visitors = new Map<string, number>();
    for (const r of rows) {
      if (r.variant !== v) continue;
      const key = r.visitorId ?? r.id;
      visitors.set(key, (visitors.get(key) ?? 0) + (r.status === "PAID" ? r.totalCents : 0));
    }
    const raw = [...visitors.values()];
    const values = winsorizeAt != null ? raw.map((x) => Math.min(x, winsorizeAt)) : raw;
    const n = values.length;
    const revenue = raw.reduce((s, x) => s + x, 0);
    const orders = rows.filter((r) => r.variant === v && r.status === "PAID").length;
    const converted = raw.filter((x) => x > 0).length;
    const mean = n ? values.reduce((s, x) => s + x, 0) / n : 0;
    const variance = n > 1 ? values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
    return {
      variant: v,
      visitors: n,
      converted,
      orders,
      revenueCents: revenue,
      cvr: n ? converted / n : 0,
      rpv: mean,
      rpvVar: variance,
      aovCents: orders ? Math.round(revenue / orders) : 0,
    };
  });
}

/** Linear-interpolated percentile (like SQL percentile_cont) of a list. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export const MIN_VISITORS_PER_VARIANT = 200;
/** Minimum run time before any decision (covers weekday/weekend cycles). */
export const MIN_TEST_DAYS = 7;
/** Before two full weeks only an overwhelming result may decide (peeking inflates false wins). */
export const EARLY_DAYS = 14;
/** Smallest relative lift of revenue per visitor worth detecting (for the duration estimate). */
export const MDE = 0.1;
/** Statistical power used for the duration estimate. */
const POWER = 0.8;

/** Significance threshold (p-value) for a decision after `ageDays` of test: the same for the manual verdict and auto-promotion. */
export function autoPromoteThreshold(ageDays: number) {
  return ageDays < EARLY_DAYS ? 0.001 : 0.01;
}

export type Verdict = {
  cvrLift: number;
  cvrPValue: number;
  /** 95 % confidence interval of the relative conversion lift (B vs A), or null without data. */
  cvrLiftCi: [number, number] | null;
  rpvLift: number;
  rpvPValue: number;
  rpvLiftCi: [number, number] | null;
  /** Profit per visitor B vs A (relative to |A|), p-value and CI (null when a mean is ≤ 0). */
  ppvLift: number;
  ppvPValue: number;
  ppvLiftCi: [number, number] | null;
  /** Observed split looks wrong (p < 0.001): results are not trustworthy. */
  sampleRatioMismatch: boolean;
  enoughData: boolean;
};

const Z95 = 1.959964;

/** Relative lift b/a − 1 with a 95 % CI (delta method on the log ratio). */
function liftCi(meanA: number, varA: number, nA: number, meanB: number, varB: number, nB: number): [number, number] | null {
  if (meanA <= 0 || meanB <= 0 || nA < 2 || nB < 2) return null;
  const se = Math.sqrt(varA / (nA * meanA * meanA) + varB / (nB * meanB * meanB));
  if (!Number.isFinite(se)) return null;
  const log = Math.log(meanB / meanA);
  return [Math.exp(log - Z95 * se) - 1, Math.exp(log + Z95 * se) - 1];
}

export function analyze(a: VariantStats, b: VariantStats, splitB: number): Verdict {
  const cvrLift = a.cvr > 0 ? (b.cvr - a.cvr) / a.cvr : 0;
  const rpvLift = a.rpv > 0 ? (b.rpv - a.rpv) / a.rpv : 0;

  // Two-proportion z-test on visitor conversion.
  let cvrPValue = 1;
  const convA = a.cvr * a.visitors;
  const convB = b.cvr * b.visitors;
  if (a.visitors > 0 && b.visitors > 0) {
    const p = (convA + convB) / (a.visitors + b.visitors);
    const se = Math.sqrt(p * (1 - p) * (1 / a.visitors + 1 / b.visitors));
    if (se > 0) cvrPValue = 2 * (1 - normalCdf(Math.abs(b.cvr - a.cvr) / se));
  }

  // Welch t-test on revenue (and profit) per visitor (normal approximation, fine at these sizes).
  const welch = (ma: number, va: number, mb: number, vb: number) => {
    if (a.visitors <= 1 || b.visitors <= 1) return 1;
    const se = Math.sqrt(va / a.visitors + vb / b.visitors);
    return se > 0 ? 2 * (1 - normalCdf(Math.abs(mb - ma) / se)) : 1;
  };
  const rpvPValue = welch(a.rpv, a.rpvVar, b.rpv, b.rpvVar);
  const ppvA = a.ppv ?? 0;
  const ppvB = b.ppv ?? 0;
  const ppvPValue = a.ppv == null || b.ppv == null ? 1 : welch(ppvA, a.ppvVar ?? 0, ppvB, b.ppvVar ?? 0);

  // Sample-ratio mismatch: chi-square (1 dof) of observed vs expected split.
  const total = a.visitors + b.visitors;
  let sampleRatioMismatch = false;
  if (total >= 100) {
    const expB = (total * splitB) / 100;
    const expA = total - expB;
    const chi = (a.visitors - expA) ** 2 / expA + (b.visitors - expB) ** 2 / expB;
    sampleRatioMismatch = chi > 10.83; // p < 0.001
  }

  return {
    cvrLift,
    cvrPValue,
    cvrLiftCi: liftCi(a.cvr, a.cvr * (1 - a.cvr), a.visitors, b.cvr, b.cvr * (1 - b.cvr), b.visitors),
    rpvLift,
    rpvPValue,
    rpvLiftCi: liftCi(a.rpv, a.rpvVar, a.visitors, b.rpv, b.rpvVar, b.visitors),
    ppvLift: ppvA !== 0 ? (ppvB - ppvA) / Math.abs(ppvA) : 0,
    ppvPValue,
    ppvLiftCi: liftCi(ppvA, a.ppvVar ?? 0, a.visitors, ppvB, b.ppvVar ?? 0, b.visitors),
    sampleRatioMismatch,
    enoughData: a.visitors >= MIN_VISITORS_PER_VARIANT && b.visitors >= MIN_VISITORS_PER_VARIANT,
  };
}

export type Decision =
  | { kind: "waiting"; reason: "too_early" | "too_few_visitors" }
  | { kind: "broken" }
  | { kind: "inconclusive"; threshold: number; metric: PrimaryMetric }
  | { kind: "winner"; winner: "A" | "B"; threshold: number; metric: PrimaryMetric }
  /** The primary metric is significantly better for `better`, but its conversion is > 2 % lower: no automatic winner. */
  | { kind: "tradeoff"; better: "A" | "B"; threshold: number; metric: PrimaryMetric };

/**
 * The one decision rule, shared by the dashboard verdict and auto-promotion: at least
 * MIN_TEST_DAYS and MIN_VISITORS_PER_VARIANT, a healthy split, and the primary metric (revenue
 * or profit per visitor) significant at autoPromoteThreshold(age). If the better variant on
 * that metric converts more than 2 % worse than the other, it's a trade-off (no winner).
 */
export function decide(v: Verdict, ageDays: number, metric: PrimaryMetric = "revenue"): Decision {
  if (v.sampleRatioMismatch) return { kind: "broken" };
  if (ageDays < MIN_TEST_DAYS) return { kind: "waiting", reason: "too_early" };
  if (!v.enoughData) return { kind: "waiting", reason: "too_few_visitors" };
  const threshold = autoPromoteThreshold(ageDays);
  const [lift, p] = metric === "profit" ? [v.ppvLift, v.ppvPValue] : [v.rpvLift, v.rpvPValue];
  if (p >= threshold || lift === 0) return { kind: "inconclusive", threshold, metric };
  const better = lift > 0 ? "B" : "A";
  // Conversion of the better variant vs the other one.
  const cvrOfBetter = better === "B" ? v.cvrLift : v.cvrLift === -1 ? Infinity : 1 / (1 + v.cvrLift) - 1;
  if (cvrOfBetter < -CVR_TRADEOFF) return { kind: "tradeoff", better, threshold, metric };
  return { kind: "winner", winner: better, threshold, metric };
}

/**
 * Days of traffic still needed before a lift of `mde` on revenue per visitor would be
 * detected (power 80 %, at the significance threshold that will apply then), from the
 * observed variance and daily traffic. 0 = enough data already; null = can't estimate yet.
 */
export function remainingDays(a: VariantStats, b: VariantStats, splitB: number, ageDays: number, mde = MDE, metric: PrimaryMetric = "revenue"): number | null {
  const total = a.visitors + b.visitors;
  const [meanA, varA, varB] = metric === "profit" ? [a.ppv ?? 0, a.ppvVar ?? 0, b.ppvVar ?? 0] : [a.rpv, a.rpvVar, b.rpvVar];
  if (ageDays <= 0 || total < 20 || meanA <= 0) return null;
  const perDay = total / Math.max(ageDays, 1 / 24);
  const s = Math.min(0.99, Math.max(0.01, splitB / 100));
  const pooledVar = (varA * Math.max(1, a.visitors - 1) + varB * Math.max(1, b.visitors - 1)) / Math.max(1, total - 2);
  const delta = mde * meanA;
  const needed = (threshold: number) => {
    const z = normalQuantile(1 - threshold / 2) + normalQuantile(POWER);
    const n = (pooledVar * (1 / s + 1 / (1 - s)) * z * z) / (delta * delta);
    // Every variant also needs the minimum sample.
    return Math.max(n, MIN_VISITORS_PER_VARIANT / Math.min(s, 1 - s));
  };
  // Stricter threshold before EARLY_DAYS, relaxed after: whichever is reached first.
  const early = needed(autoPromoteThreshold(0)) / perDay;
  const days = early <= EARLY_DAYS ? Math.max(early, MIN_TEST_DAYS) : Math.max(EARLY_DAYS, needed(autoPromoteThreshold(EARLY_DAYS)) / perDay);
  return Math.max(0, Math.ceil(days - ageDays));
}

export function normalCdf(z: number) {
  // Abramowitz–Stegun approximation of the standard normal CDF (z ≥ 0).
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - tail;
}

/** Inverse of the standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9). */
export function normalQuantile(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}
