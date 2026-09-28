import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { analyze, summarize, type VariantStats, type Verdict } from "./experiments";

/*
 * Checkout analytics, computed with SQL aggregates (no row cap, cheap at any volume).
 * Revenue is net of refunds and includes one-click post-purchase offers. Test-mode
 * checkouts are excluded unless asked for. Days are Paris days.
 */

export type Period = { since: Date; until: Date; includeTest: boolean };

export type Analytics = {
  sessions: number;
  visitors: number;
  orders: number;
  revenueCents: number;
  upsellRevenueCents: number;
  aovCents: number;
  cvr: number;
  previous: { sessions: number; orders: number; revenueCents: number; cvr: number; aovCents: number };
  daily: { day: string; sessions: number; orders: number; revenueCents: number }[];
  funnel: { key: string; label: string; count: number }[];
  failedPayments: number;
  sources: { source: string; campaign: string; sessions: number; orders: number; revenueCents: number }[];
  methods: { method: string; orders: number; revenueCents: number }[];
  countries: { country: string; orders: number; revenueCents: number }[];
  products: { title: string; units: number; revenueCents: number }[];
  addOns: { title: string; orders: number; attachRate: number; revenueCents: number }[];
  codes: { code: string; orders: number; discountCents: number; revenueCents: number }[];
  upsell: { shown: number; accepted: number; revenueCents: number };
  risk: { refundedCents: number; refundRate: number; disputes: number; disputeRate: number; reviewHolds: number };
  devices: { mobile: number; desktop: number; mobileCvr: number; desktopCvr: number };
};

const n = (v: unknown) => Number(v ?? 0);

export async function storeAnalytics(storeId: string, p: Period): Promise<Analytics> {
  const testFilter = p.includeTest ? Prisma.empty : Prisma.sql`AND s."test" = false`;
  const where = Prisma.sql`s."storeId" = ${storeId} AND s."createdAt" >= ${p.since} AND s."createdAt" < ${p.until} ${testFilter}`;
  const span = p.until.getTime() - p.since.getTime();
  const prevWhere = Prisma.sql`s."storeId" = ${storeId} AND s."createdAt" >= ${new Date(p.since.getTime() - span)} AND s."createdAt" < ${p.since} ${testFilter}`;
  const net = Prisma.sql`(COALESCE(NULLIF(s."totalCents", 0), s."subtotalCents") - s."refundedCents")`;

  const [totals, prev, daily, sources, methods, countries, products, addOns, codes, upsell, devices] = await Promise.all([
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*) AS sessions,
             count(DISTINCT COALESCE(s."visitorId", s.id)) AS visitors,
             count(*) FILTER (WHERE s.status = 'PAID') AS orders,
             COALESCE(sum(${net}) FILTER (WHERE s.status = 'PAID'), 0) AS revenue,
             count(*) FILTER (WHERE s.status = 'PAID' OR s."preparedAt" IS NOT NULL) AS prepared,
             count(*) FILTER (WHERE s.status = 'PAID' OR s."payClickedAt" IS NOT NULL) AS clicked,
             count(*) FILTER (WHERE s."paymentFailedAt" IS NOT NULL) AS failed,
             COALESCE(sum(s."refundedCents") FILTER (WHERE s.status = 'PAID'), 0) AS refunded,
             count(*) FILTER (WHERE s.status = 'PAID' AND s."refundedCents" > 0) AS refunds,
             count(*) FILTER (WHERE s.status = 'PAID' AND s.disputed) AS disputes,
             count(*) FILTER (WHERE s.status = 'PAID' AND s."reviewNote" IS NOT NULL) AS holds,
             count(*) FILTER (WHERE s."upsellShownAt" IS NOT NULL) AS "upsellShown"
      FROM "CheckoutSession" s WHERE ${where}`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*) AS sessions, count(*) FILTER (WHERE s.status = 'PAID') AS orders,
             COALESCE(sum(${net}) FILTER (WHERE s.status = 'PAID'), 0) AS revenue
      FROM "CheckoutSession" s WHERE ${prevWhere}`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT to_char(date_trunc('day', (s."createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris'), 'YYYY-MM-DD') AS day,
             count(*) AS sessions,
             count(*) FILTER (WHERE s.status = 'PAID') AS orders,
             COALESCE(sum(${net}) FILTER (WHERE s.status = 'PAID'), 0) AS revenue
      FROM "CheckoutSession" s WHERE ${where} GROUP BY 1 ORDER BY 1`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT COALESCE(NULLIF(s.utm->>'utm_source', ''),
               CASE WHEN s.utm ? 'fbclid' THEN 'facebook (clic pub)'
                    WHEN s.utm ? 'ttclid' THEN 'tiktok (clic pub)'
                    WHEN s.utm ? 'gclid' THEN 'google (clic pub)'
                    ELSE 'direct / inconnu' END) AS source,
             COALESCE(NULLIF(s.utm->>'utm_campaign', ''), '—') AS campaign,
             count(*) AS sessions,
             count(*) FILTER (WHERE s.status = 'PAID') AS orders,
             COALESCE(sum(${net}) FILTER (WHERE s.status = 'PAID'), 0) AS revenue
      FROM "CheckoutSession" s WHERE ${where} GROUP BY 1, 2 ORDER BY revenue DESC, sessions DESC LIMIT 20`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT COALESCE(s."paymentMethodType", 'inconnu') AS method, count(*) AS orders, COALESCE(sum(${net}), 0) AS revenue
      FROM "CheckoutSession" s WHERE ${where} AND s.status = 'PAID' GROUP BY 1 ORDER BY revenue DESC`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT COALESCE(s."shippingAddress"->>'countryCode', '—') AS country, count(*) AS orders, COALESCE(sum(${net}), 0) AS revenue
      FROM "CheckoutSession" s WHERE ${where} AND s.status = 'PAID' GROUP BY 1 ORDER BY revenue DESC LIMIT 15`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT l->>'title' AS title, sum((l->>'quantity')::int) AS units,
             sum((l->>'quantity')::int * (l->>'unitPriceCents')::int) AS revenue
      FROM "CheckoutSession" s, jsonb_array_elements(s.lines) l
      WHERE ${where} AND s.status = 'PAID' GROUP BY 1 ORDER BY revenue DESC LIMIT 15`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT a->>'title' AS title, count(*) AS orders, sum((a->>'priceCents')::int) AS revenue
      FROM "CheckoutSession" s JOIN "CheckoutQuote" q ON q.id = s."paidQuoteId", jsonb_array_elements(q."addOns") a
      WHERE ${where} AND s.status = 'PAID' GROUP BY 1 ORDER BY revenue DESC`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT s."discountCode" AS code, count(*) AS orders, sum(s."discountCents") AS discount, COALESCE(sum(${net}), 0) AS revenue
      FROM "CheckoutSession" s WHERE ${where} AND s.status = 'PAID' AND s."discountCode" IS NOT NULL GROUP BY 1 ORDER BY revenue DESC`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT count(*) AS accepted, COALESCE(sum(u."amountCents" - u."refundedCents"), 0) AS revenue
      FROM "UpsellCharge" u JOIN "CheckoutSession" s ON s.id = u."sessionId"
      WHERE ${where} AND u.status = 'PAID'`,
    db.$queryRaw<Record<string, unknown>[]>`
      SELECT (s."userAgent" ~* '(Mobi|Android|iPhone)') AS mobile, count(*) AS sessions, count(*) FILTER (WHERE s.status = 'PAID') AS orders
      FROM "CheckoutSession" s WHERE ${where} AND s."userAgent" IS NOT NULL GROUP BY 1`,
  ]);

  const t = totals[0] ?? {};
  const sessions = n(t.sessions);
  const orders = n(t.orders);
  const upsellRevenue = n(upsell[0]?.revenue);
  const revenue = n(t.revenue) + upsellRevenue;
  const pv = prev[0] ?? {};
  const prevOrders = n(pv.orders);
  const mob = devices.find((d) => d.mobile === true);
  const desk = devices.find((d) => d.mobile === false);

  return {
    sessions,
    visitors: n(t.visitors),
    orders,
    revenueCents: revenue,
    upsellRevenueCents: upsellRevenue,
    aovCents: orders ? Math.round(revenue / orders) : 0,
    cvr: sessions ? orders / sessions : 0,
    previous: {
      sessions: n(pv.sessions),
      orders: prevOrders,
      revenueCents: n(pv.revenue),
      cvr: n(pv.sessions) ? prevOrders / n(pv.sessions) : 0,
      aovCents: prevOrders ? Math.round(n(pv.revenue) / prevOrders) : 0,
    },
    daily: daily.map((d) => ({ day: String(d.day), sessions: n(d.sessions), orders: n(d.orders), revenueCents: n(d.revenue) })),
    funnel: [
      { key: "opened", label: "Checkout ouvert", count: sessions },
      { key: "form", label: "Formulaire de paiement affiché", count: n(t.prepared) },
      { key: "pay", label: "Clic sur « Payer »", count: n(t.clicked) },
      { key: "paid", label: "Payé", count: orders },
    ],
    failedPayments: n(t.failed),
    sources: sources.map((r) => ({ source: String(r.source), campaign: String(r.campaign), sessions: n(r.sessions), orders: n(r.orders), revenueCents: n(r.revenue) })),
    methods: methods.map((r) => ({ method: String(r.method), orders: n(r.orders), revenueCents: n(r.revenue) })),
    countries: countries.map((r) => ({ country: String(r.country), orders: n(r.orders), revenueCents: n(r.revenue) })),
    products: products.map((r) => ({ title: String(r.title), units: n(r.units), revenueCents: n(r.revenue) })),
    addOns: addOns.map((r) => ({ title: String(r.title), orders: n(r.orders), attachRate: orders ? n(r.orders) / orders : 0, revenueCents: n(r.revenue) })),
    codes: codes.map((r) => ({ code: String(r.code), orders: n(r.orders), discountCents: n(r.discount), revenueCents: n(r.revenue) })),
    upsell: { shown: n(t.upsellShown), accepted: n(upsell[0]?.accepted), revenueCents: upsellRevenue },
    risk: {
      refundedCents: n(t.refunded),
      refundRate: orders ? n(t.refunds) / orders : 0,
      disputes: n(t.disputes),
      disputeRate: orders ? n(t.disputes) / orders : 0,
      reviewHolds: n(t.holds),
    },
    devices: {
      mobile: n(mob?.sessions),
      desktop: n(desk?.sessions),
      mobileCvr: n(mob?.sessions) ? n(mob?.orders) / n(mob?.sessions) : 0,
      desktopCvr: n(desk?.sessions) ? n(desk?.orders) / n(desk?.sessions) : 0,
    },
  };
}

export async function experimentResults(experiment: { id: string; splitB: number }): Promise<{ stats: VariantStats[]; verdict: Verdict }> {
  const rows = await db.checkoutSession.findMany({
    where: { experimentId: experiment.id },
    select: { id: true, visitorId: true, variant: true, status: true, totalCents: true },
  });
  const stats = summarize(rows);
  return { stats, verdict: analyze(stats[0], stats[1], experiment.splitB) };
}
