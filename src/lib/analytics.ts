import "server-only";
import { db } from "./db";
import { significance, summarize, type VariantStats } from "./experiments";

/*
 * Checkout analytics computed from CheckoutSession rows (bounded window, in memory).
 * A paid session counts as having passed every step, so express wallets (which skip
 * the form) don't create fake drop-offs.
 */

export type Funnel = { key: string; label: string; count: number }[];

export type Analytics = {
  sessions: number;
  orders: number;
  revenueCents: number;
  aovCents: number;
  cvr: number;
  funnel: Funnel;
  sources: { source: string; campaign: string; sessions: number; orders: number; revenueCents: number }[];
  addOns: { id: string; title: string; orders: number; attachRate: number; revenueCents: number }[];
  codes: { code: string; orders: number; discountCents: number; revenueCents: number }[];
  upsell: { offered: number; accepted: number; revenueCents: number };
  recovery: { emailed: number; recovered: number; revenueCents: number };
  devices: { mobile: number; desktop: number; mobileCvr: number; desktopCvr: number };
};

const MAX_ROWS = 20_000;

export async function storeAnalytics(storeId: string, since: Date): Promise<Analytics> {
  const [rows, addOnDefs, upsells] = await Promise.all([
    db.checkoutSession.findMany({
      where: { storeId, createdAt: { gte: since } },
      select: {
        status: true,
        totalCents: true,
        subtotalCents: true,
        refundedCents: true,
        discountCode: true,
        discountCents: true,
        addOnIds: true,
        addOnsCents: true,
        email: true,
        contactAt: true,
        preparedAt: true,
        payClickedAt: true,
        utm: true,
        userAgent: true,
        recoveryStage: true,
      },
      take: MAX_ROWS,
      orderBy: { createdAt: "desc" },
    }),
    db.addOn.findMany({ where: { storeId }, select: { id: true, title: true, priceCents: true } }),
    db.upsellCharge.findMany({
      where: { session: { storeId }, createdAt: { gte: since } },
      select: { status: true, amountCents: true },
    }),
  ]);

  // Same amount as the Orders page (legacy rows may only carry the subtotal).
  for (const r of rows) r.totalCents = r.totalCents || r.subtotalCents;
  const paid = rows.filter((r) => r.status === "PAID");
  const revenue = paid.reduce((s, r) => s + r.totalCents - r.refundedCents, 0);
  const passed = (r: (typeof rows)[number], field: "contactAt" | "preparedAt" | "payClickedAt") =>
    r.status === "PAID" || r[field] != null || (field === "contactAt" && !!r.email);

  const funnel: Funnel = [
    { key: "opened", label: "Checkout ouvert", count: rows.length },
    { key: "form", label: "Paiement prêt à l'écran", count: rows.filter((r) => passed(r, "preparedAt")).length },
    { key: "contact", label: "E-mail saisi", count: rows.filter((r) => passed(r, "contactAt")).length },
    { key: "pay", label: "Clic sur « Payer »", count: rows.filter((r) => passed(r, "payClickedAt")).length },
    { key: "paid", label: "Payé", count: paid.length },
  ];

  // Attribution by UTM source / campaign (fbclid / ttclid / gclid imply the network).
  const bySource = new Map<string, { source: string; campaign: string; sessions: number; orders: number; revenueCents: number }>();
  for (const r of rows) {
    const utm = (r.utm ?? {}) as Record<string, string>;
    const source =
      utm.utm_source || (utm.fbclid ? "facebook (clic pub)" : utm.ttclid ? "tiktok (clic pub)" : utm.gclid ? "google (clic pub)" : "direct / inconnu");
    const campaign = utm.utm_campaign || "—";
    const key = `${source}|${campaign}`;
    const row = bySource.get(key) ?? { source, campaign, sessions: 0, orders: 0, revenueCents: 0 };
    row.sessions++;
    if (r.status === "PAID") {
      row.orders++;
      row.revenueCents += r.totalCents - r.refundedCents;
    }
    bySource.set(key, row);
  }

  const addOns = addOnDefs
    .map((a) => {
      const orders = paid.filter((r) => r.addOnIds.includes(a.id)).length;
      return { id: a.id, title: a.title, orders, attachRate: paid.length ? orders / paid.length : 0, revenueCents: orders * a.priceCents };
    })
    .filter((a) => a.orders > 0)
    .sort((a, b) => b.revenueCents - a.revenueCents);

  const byCode = new Map<string, { code: string; orders: number; discountCents: number; revenueCents: number }>();
  for (const r of paid) {
    if (!r.discountCode) continue;
    const row = byCode.get(r.discountCode) ?? { code: r.discountCode, orders: 0, discountCents: 0, revenueCents: 0 };
    row.orders++;
    row.discountCents += r.discountCents;
    row.revenueCents += r.totalCents - r.refundedCents;
    byCode.set(r.discountCode, row);
  }

  const acceptedUpsells = upsells.filter((u) => u.status === "PAID");
  const emailed = rows.filter((r) => r.recoveryStage > 0);
  const recovered = emailed.filter((r) => r.status === "PAID");
  const mobile = rows.filter((r) => /Mobi|Android|iPhone/i.test(r.userAgent ?? ""));
  const desktop = rows.filter((r) => r.userAgent && !/Mobi|Android|iPhone/i.test(r.userAgent));
  const cvrOf = (list: typeof rows) => (list.length ? list.filter((r) => r.status === "PAID").length / list.length : 0);

  return {
    sessions: rows.length,
    orders: paid.length,
    revenueCents: revenue,
    aovCents: paid.length ? Math.round(revenue / paid.length) : 0,
    cvr: rows.length ? paid.length / rows.length : 0,
    funnel,
    sources: [...bySource.values()].sort((a, b) => b.revenueCents - a.revenueCents || b.sessions - a.sessions).slice(0, 15),
    addOns,
    codes: [...byCode.values()].sort((a, b) => b.revenueCents - a.revenueCents),
    upsell: {
      offered: upsells.length,
      accepted: acceptedUpsells.length,
      revenueCents: acceptedUpsells.reduce((s, u) => s + u.amountCents, 0),
    },
    recovery: {
      emailed: emailed.length,
      recovered: recovered.length,
      revenueCents: recovered.reduce((s, r) => s + r.totalCents - r.refundedCents, 0),
    },
    devices: { mobile: mobile.length, desktop: desktop.length, mobileCvr: cvrOf(mobile), desktopCvr: cvrOf(desktop) },
  };
}

export async function experimentResults(experimentId: string): Promise<{ stats: VariantStats[]; confidence: number; lift: number }> {
  const rows = await db.checkoutSession.findMany({
    where: { experimentId },
    select: { variant: true, status: true, totalCents: true },
    take: MAX_ROWS,
  });
  const stats = summarize(rows);
  const { confidence, lift } = significance(stats[0], stats[1]);
  return { stats, confidence, lift };
}
