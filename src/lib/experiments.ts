import "server-only";
import type { CheckoutSession, Store } from "@prisma/client";
import { db } from "./db";

/*
 * A/B tests of checkout designs. Variant A is the published design; variant B is a
 * saved version from the history. New checkout sessions are split at creation and
 * keep their variant; the dashboard compares conversion and revenue per visitor.
 */

export async function runningExperiment(storeId: string) {
  return db.experiment.findFirst({ where: { storeId, status: "RUNNING" }, orderBy: { startedAt: "desc" } });
}

export async function assignVariant(storeId: string): Promise<{ experimentId?: string; variant?: string }> {
  const exp = await runningExperiment(storeId);
  if (!exp) return {};
  return { experimentId: exp.id, variant: Math.random() * 100 < exp.splitB ? "B" : "A" };
}

/** Design (theme + checkout/thank-you layouts) a session must see. */
export async function designFor(store: Store, session: Pick<CheckoutSession, "experimentId" | "variant">) {
  if (session.variant === "B" && session.experimentId) {
    const exp = await db.experiment.findUnique({ where: { id: session.experimentId } });
    const version = exp ? await db.layoutVersion.findUnique({ where: { id: exp.versionId } }) : null;
    if (version) return { theme: version.theme, checkoutLayout: version.checkoutLayout, thankYouLayout: version.thankYouLayout };
  }
  return { theme: store.theme, checkoutLayout: store.checkoutLayout, thankYouLayout: store.thankYouLayout };
}

export type VariantStats = { variant: string; sessions: number; orders: number; revenueCents: number; cvr: number; rpv: number };

export function summarize(rows: { variant: string | null; status: string; totalCents: number }[]): VariantStats[] {
  return ["A", "B"].map((v) => {
    const mine = rows.filter((r) => r.variant === v);
    const paid = mine.filter((r) => r.status === "PAID");
    const revenue = paid.reduce((s, r) => s + r.totalCents, 0);
    return {
      variant: v,
      sessions: mine.length,
      orders: paid.length,
      revenueCents: revenue,
      cvr: mine.length ? paid.length / mine.length : 0,
      rpv: mine.length ? revenue / mine.length : 0,
    };
  });
}

/**
 * Two-proportion z-test on conversion rate. Returns the confidence (0–1) that B
 * differs from A, and B's relative lift.
 */
export function significance(a: VariantStats, b: VariantStats): { confidence: number; lift: number } {
  const lift = a.cvr > 0 ? (b.cvr - a.cvr) / a.cvr : 0;
  if (a.sessions < 1 || b.sessions < 1) return { confidence: 0, lift };
  const p = (a.orders + b.orders) / (a.sessions + b.sessions);
  const se = Math.sqrt(p * (1 - p) * (1 / a.sessions + 1 / b.sessions));
  if (!se) return { confidence: 0, lift };
  const z = Math.abs(b.cvr - a.cvr) / se;
  return { confidence: 1 - 2 * (1 - normalCdf(z)), lift };
}

function normalCdf(z: number) {
  // Abramowitz–Stegun approximation of the standard normal CDF.
  const t = 1 / (1 + 0.2316419 * z);
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return 1 - tail;
}
