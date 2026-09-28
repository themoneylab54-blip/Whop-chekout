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
 * - Conversion is compared with a two-proportion z-test, revenue per visitor with a
 *   Welch t-test; a sample-ratio check flags broken splits; no verdict before a
 *   minimum sample.
 */

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

export type VariantStats = {
  variant: string;
  visitors: number;
  orders: number;
  revenueCents: number;
  cvr: number;
  rpv: number;
  /** Variance of revenue per visitor (cents²), for the t-test. */
  rpvVar: number;
};

type Row = { variant: string | null; visitorId: string | null; id: string; status: string; totalCents: number };

/** Groups checkout sessions into unique visitors (a visitor converts if any of their checkouts is paid). */
export function summarize(rows: Row[]): VariantStats[] {
  return ["A", "B"].map((v) => {
    const visitors = new Map<string, number>();
    for (const r of rows) {
      if (r.variant !== v) continue;
      const key = r.visitorId ?? r.id;
      visitors.set(key, (visitors.get(key) ?? 0) + (r.status === "PAID" ? r.totalCents : 0));
    }
    const values = [...visitors.values()];
    const n = values.length;
    const revenue = values.reduce((s, x) => s + x, 0);
    const orders = rows.filter((r) => r.variant === v && r.status === "PAID").length;
    const converted = values.filter((x) => x > 0).length;
    const mean = n ? revenue / n : 0;
    const variance = n > 1 ? values.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1) : 0;
    return { variant: v, visitors: n, orders, revenueCents: revenue, cvr: n ? converted / n : 0, rpv: mean, rpvVar: variance };
  });
}

export const MIN_VISITORS_PER_VARIANT = 200;

export type Verdict = {
  cvrLift: number;
  cvrPValue: number;
  rpvLift: number;
  rpvPValue: number;
  /** Observed split looks wrong (p < 0.001): results are not trustworthy. */
  sampleRatioMismatch: boolean;
  enoughData: boolean;
};

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

  // Welch t-test on revenue per visitor (normal approximation, fine at these sizes).
  let rpvPValue = 1;
  if (a.visitors > 1 && b.visitors > 1) {
    const se = Math.sqrt(a.rpvVar / a.visitors + b.rpvVar / b.visitors);
    if (se > 0) rpvPValue = 2 * (1 - normalCdf(Math.abs(b.rpv - a.rpv) / se));
  }

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
    rpvLift,
    rpvPValue,
    sampleRatioMismatch,
    enoughData: a.visitors >= MIN_VISITORS_PER_VARIANT && b.visitors >= MIN_VISITORS_PER_VARIANT,
  };
}

export function normalCdf(z: number) {
  // Abramowitz–Stegun approximation of the standard normal CDF (z ≥ 0).
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - tail;
}
