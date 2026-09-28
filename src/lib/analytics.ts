import "server-only";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { recordEvent } from "./log";
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
  /** Whop fees on these payments; feesKnown = every order carries its fee. */
  feesCents: number;
  feesKnown: boolean;
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
  const span = p.until.getTime() - p.since.getTime();
  const prevSince = new Date(p.since.getTime() - span);
  // Traffic (sessions, funnel, sources) by checkout date; money (revenue, orders…) by
  // payment date — the same basis as the CSV export and the Orders page.
  const opened = Prisma.sql`s."storeId" = ${storeId} AND s."createdAt" >= ${p.since} AND s."createdAt" < ${p.until} ${testFilter}`;
  const paidIn = (from: Date, to: Date) =>
    Prisma.sql`s."storeId" = ${storeId} AND s.status = 'PAID' AND s."paidAt" >= ${from} AND s."paidAt" < ${to} ${testFilter}`;
  const paid = paidIn(p.since, p.until);
  const net = Prisma.sql`(COALESCE(NULLIF(s."totalCents", 0), s."subtotalCents") - s."refundedCents")`;
  const upsellIn = (from: Date, to: Date) =>
    Prisma.sql`u.status = 'PAID' AND u."createdAt" >= ${from} AND u."createdAt" < ${to} AND s."storeId" = ${storeId} ${testFilter}`;
  const day = (col: Prisma.Sql) => Prisma.sql`to_char(date_trunc('day', (${col} AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris'), 'YYYY-MM-DD')`;

  const [traffic, money, prevTraffic, prevMoney, dailyMoney, dailyUpsell, sources, methods, countries, products, addOns, codes, upsell, prevUpsell, devices] =
    await Promise.all([
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*) AS sessions,
               count(DISTINCT COALESCE(s."visitorId", s.id)) AS visitors,
               count(*) FILTER (WHERE s.status = 'PAID') AS converted,
               count(*) FILTER (WHERE s.status = 'PAID' OR s."preparedAt" IS NOT NULL) AS prepared,
               count(*) FILTER (WHERE s.status = 'PAID' OR s."payClickedAt" IS NOT NULL) AS clicked,
               count(*) FILTER (WHERE s."paymentFailedAt" IS NOT NULL) AS failed,
               count(*) FILTER (WHERE s."upsellShownAt" IS NOT NULL) AS "upsellShown"
        FROM "CheckoutSession" s WHERE ${opened}`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*) AS orders,
               COALESCE(sum(${net}), 0) AS revenue,
               COALESCE(sum(s."whopFeeCents"), 0) AS fees,
               count(*) FILTER (WHERE s."whopFeeCents" IS NOT NULL) AS "withFees",
               COALESCE(sum(s."refundedCents"), 0) AS refunded,
               count(*) FILTER (WHERE s."refundedCents" > 0) AS refunds,
               count(*) FILTER (WHERE s.disputed) AS disputes,
               count(*) FILTER (WHERE s."reviewNote" IS NOT NULL) AS holds
        FROM "CheckoutSession" s WHERE ${paid}`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*) AS sessions FROM "CheckoutSession" s
        WHERE s."storeId" = ${storeId} AND s."createdAt" >= ${prevSince} AND s."createdAt" < ${p.since} ${testFilter}`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*) AS orders, COALESCE(sum(${net}), 0) AS revenue FROM "CheckoutSession" s WHERE ${paidIn(prevSince, p.since)}`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT ${day(Prisma.sql`s."paidAt"`)} AS day, count(*) AS orders, COALESCE(sum(${net}), 0) AS revenue
        FROM "CheckoutSession" s WHERE ${paid} GROUP BY 1`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT ${day(Prisma.sql`u."createdAt"`)} AS day, COALESCE(sum(u."amountCents" - u."refundedCents"), 0) AS revenue
        FROM "UpsellCharge" u JOIN "CheckoutSession" s ON s.id = u."sessionId" WHERE ${upsellIn(p.since, p.until)} GROUP BY 1`,
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
        FROM "CheckoutSession" s WHERE ${opened} GROUP BY 1, 2 ORDER BY revenue DESC, sessions DESC LIMIT 20`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT COALESCE(s."paymentMethodType", 'inconnu') AS method, count(*) AS orders, COALESCE(sum(${net}), 0) AS revenue
        FROM "CheckoutSession" s WHERE ${paid} GROUP BY 1 ORDER BY revenue DESC`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT COALESCE(s."shippingAddress"->>'countryCode', '—') AS country, count(*) AS orders, COALESCE(sum(${net}), 0) AS revenue
        FROM "CheckoutSession" s WHERE ${paid} GROUP BY 1 ORDER BY revenue DESC LIMIT 15`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT l->>'title' AS title, sum((l->>'quantity')::int) AS units,
               sum((l->>'quantity')::int * (l->>'unitPriceCents')::int) AS revenue
        FROM "CheckoutSession" s, jsonb_array_elements(s.lines) l
        WHERE ${paid} GROUP BY 1 ORDER BY revenue DESC LIMIT 15`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT a->>'title' AS title, count(*) AS orders, sum((a->>'priceCents')::int) AS revenue
        FROM "CheckoutSession" s JOIN "CheckoutQuote" q ON q.id = s."paidQuoteId", jsonb_array_elements(q."addOns") a
        WHERE ${paid} GROUP BY 1 ORDER BY revenue DESC`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT s."discountCode" AS code, count(*) AS orders, sum(s."discountCents") AS discount, COALESCE(sum(${net}), 0) AS revenue
        FROM "CheckoutSession" s WHERE ${paid} AND s."discountCode" IS NOT NULL GROUP BY 1 ORDER BY revenue DESC`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT count(*) AS accepted, COALESCE(sum(u."amountCents" - u."refundedCents"), 0) AS revenue,
               count(*) FILTER (WHERE u.disputed) AS disputes
        FROM "UpsellCharge" u JOIN "CheckoutSession" s ON s.id = u."sessionId" WHERE ${upsellIn(p.since, p.until)}`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT COALESCE(sum(u."amountCents" - u."refundedCents"), 0) AS revenue
        FROM "UpsellCharge" u JOIN "CheckoutSession" s ON s.id = u."sessionId" WHERE ${upsellIn(prevSince, p.since)}`,
      db.$queryRaw<Record<string, unknown>[]>`
        SELECT (s."userAgent" ~* '(Mobi|Android|iPhone)') AS mobile, count(*) AS sessions, count(*) FILTER (WHERE s.status = 'PAID') AS orders
        FROM "CheckoutSession" s WHERE ${opened} AND s."userAgent" IS NOT NULL GROUP BY 1`,
    ]);

  const t = traffic[0] ?? {};
  const m = money[0] ?? {};
  const sessions = n(t.sessions);
  const orders = n(m.orders);
  const upsellRevenue = n(upsell[0]?.revenue);
  const revenue = n(m.revenue) + upsellRevenue;
  const prevSessions = n(prevTraffic[0]?.sessions);
  const prevOrders = n(prevMoney[0]?.orders);
  const prevRevenue = n(prevMoney[0]?.revenue) + n(prevUpsell[0]?.revenue);
  const mob = devices.find((d) => d.mobile === true);
  const desk = devices.find((d) => d.mobile === false);

  const daily = new Map<string, { day: string; sessions: number; orders: number; revenueCents: number }>();
  for (const d of dailyMoney) daily.set(String(d.day), { day: String(d.day), sessions: 0, orders: n(d.orders), revenueCents: n(d.revenue) });
  for (const d of dailyUpsell) {
    const row = daily.get(String(d.day)) ?? { day: String(d.day), sessions: 0, orders: 0, revenueCents: 0 };
    row.revenueCents += n(d.revenue);
    daily.set(row.day, row);
  }
  const disputes = n(m.disputes) + n(upsell[0]?.disputes);
  const paidTransactions = orders + n(upsell[0]?.accepted);

  return {
    sessions,
    visitors: n(t.visitors),
    orders,
    revenueCents: revenue,
    upsellRevenueCents: upsellRevenue,
    feesCents: n(m.fees),
    feesKnown: n(m.withFees) === orders,
    aovCents: orders ? Math.round(revenue / orders) : 0,
    cvr: sessions ? n(t.converted) / sessions : 0,
    previous: {
      sessions: prevSessions,
      orders: prevOrders,
      revenueCents: prevRevenue,
      cvr: prevSessions ? prevOrders / prevSessions : 0,
      aovCents: prevOrders ? Math.round(prevRevenue / prevOrders) : 0,
    },
    daily: [...daily.values()].sort((x, y) => x.day.localeCompare(y.day)),
    funnel: [
      { key: "opened", label: "Checkout ouvert", count: sessions },
      { key: "form", label: "Formulaire de paiement affiché", count: n(t.prepared) },
      { key: "pay", label: "Clic sur « Payer »", count: n(t.clicked) },
      { key: "paid", label: "Payé", count: n(t.converted) },
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
      refundedCents: n(m.refunded),
      refundRate: orders ? n(m.refunds) / orders : 0,
      disputes,
      disputeRate: paidTransactions ? disputes / paidTransactions : 0,
      reviewHolds: n(m.holds),
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
    where: { experimentId: experiment.id, test: false },
    select: {
      id: true,
      visitorId: true,
      variant: true,
      status: true,
      totalCents: true,
      refundedCents: true,
      upsells: { where: { status: "PAID" }, select: { amountCents: true, refundedCents: true } },
    },
  });
  // Revenue per visitor is net of refunds and includes one-click offers.
  const stats = summarize(
    rows.map((r) => ({
      ...r,
      totalCents: r.totalCents - r.refundedCents + r.upsells.reduce((s, u) => s + u.amountCents - u.refundedCents, 0),
    })),
  );
  return { stats, verdict: analyze(stats[0], stats[1], experiment.splitB) };
}

/** Minimum run time before an automatic decision (covers weekday/weekend cycles). */
const AUTO_MIN_DAYS = 7;

/**
 * Tests with auto-promotion: once significant (p < 0.01 on revenue per visitor, enough
 * visitors, a healthy split, at least a week), stop and publish the winner.
 */
export async function autoPromoteExperiments(): Promise<number> {
  const running = await db.experiment.findMany({ where: { status: "RUNNING", autoPromote: true } });
  let decided = 0;
  for (const exp of running) {
    if (Date.now() - exp.startedAt.getTime() < AUTO_MIN_DAYS * 24 * 3600_000) continue;
    const { verdict } = await experimentResults(exp);
    if (!verdict.enoughData || verdict.sampleRatioMismatch || verdict.rpvPValue >= 0.01) continue;
    const bWins = verdict.rpvLift > 0 && verdict.cvrLift >= -0.02;
    if (bWins) {
      const v = await db.layoutVersion.findUnique({ where: { id: exp.versionId } });
      if (v) {
        await db.store.update({
          where: { id: exp.storeId },
          data: { theme: v.theme as Prisma.InputJsonValue, checkoutLayout: v.checkoutLayout as Prisma.InputJsonValue, thankYouLayout: v.thankYouLayout as Prisma.InputJsonValue, publishedAt: new Date() },
        });
      }
    }
    await db.experiment.update({ where: { id: exp.id }, data: { status: "STOPPED", endedAt: new Date() } });
    await recordEvent({
      storeId: exp.storeId,
      level: "warn",
      kind: "experiment.decided",
      message: bWins
        ? `Test A/B « ${exp.name} » : la variante B gagne (+${(verdict.rpvLift * 100).toFixed(1)} % de CA par visiteur). Publiée automatiquement.`
        : `Test A/B « ${exp.name} » : la variante A reste meilleure (${(verdict.rpvLift * 100).toFixed(1)} % pour B). Test arrêté, A conservée.`,
      alert: true,
    });
    decided++;
  }
  return decided;
}
