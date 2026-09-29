import "server-only";
import { stopForTime } from "./deadline";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { tzOf } from "./time";
import { analyze, decide, remainingDays, MIN_TEST_DAYS, MIN_VISITORS_PER_VARIANT, type Decision, type PrimaryMetric, type VariantStats } from "./experiments";
import { armKey, loadThankYouLayout, offerArmProps, offerHasB, parseArmKey, type Block, type BlockOf, type Layout } from "./layout";
import { recordEvent } from "./log";
import { vatRateSql } from "./vat";
import { DEFAULT_FEE_RATE } from "./conversions";

/*
 * Statistics of the offer-level A/B tests (arm B of a one-click offer), with the same machinery
 * as the design tests (experiments.ts: analyze → decide):
 *  - "visitors" = impressions of an arm (paid orders that displayed it: upsellShownBlocks);
 *  - conversion = take rate (paid offers ÷ impressions), z-test;
 *  - primary metric = margin per impression (CA HT net of refunds − product cost × quantity − Whop
 *    fee of the take) when every take of both arms has a known cost, else CA HT per impression
 *    (Welch t-test, 95 % CI on the lift). A cheaper-to-source arm B can win on margin while
 *    bringing less revenue: deciding on revenue alone would promote the wrong offer.
 * The winner is kept by hand ("Promouvoir B" / keep A) or automatically when the arm asks for it
 * (`variantB.autoPromote`), with the decision rule of the design tests (≥ 7 days, ≥ 200
 * impressions per arm, p below autoPromoteThreshold(age), no conversion trade-off).
 */

/**
 * Per-arm aggregate: impressions, paid takes, Σ and Σ² of the net HT revenue per impression (cents),
 * and the same for the margin per impression (revenue HT − cost × quantity − Whop fee; a fee not
 * reported yet is estimated at DEFAULT_FEE_RATE). `costedTakes` = takes whose unit cost is known.
 */
export type ArmAggregate = {
  impressions: number;
  takes: number;
  sumCents: number;
  sumSqCents: number;
  firstAt: Date | null;
  profitSumCents?: number;
  profitSumSqCents?: number;
  costedTakes?: number;
};

export type OfferTest = {
  offerId: string;
  split: number;
  ageDays: number;
  a: { impressions: number; takes: number; takeRate: number; revenuePerImpressionHtCents: number; profitPerImpressionCents: number | null };
  b: { impressions: number; takes: number; takeRate: number; revenuePerImpressionHtCents: number; profitPerImpressionCents: number | null };
  /**
   * Metric that decides: "profit" (margin per impression) when every take of both arms has a
   * known product cost, else "revenue" (CA HT per impression). lift / pValue / ci are this metric's.
   */
  metric: PrimaryMetric;
  /** Takes without a product cost (why the test falls back to revenue). */
  uncostedTakes: number;
  /** Primary metric per impression, B vs A (relative), its p-value and 95 % CI. */
  lift: number;
  pValue: number;
  ci: [number, number] | null;
  /** Take rate B vs A (relative) and its p-value. */
  takeLift: number;
  takePValue: number;
  /** Impressions per arm needed before any decision. */
  minSample: number;
  /** Days of traffic still needed to detect a 10 % lift (null: can't estimate yet). */
  remainingDays: number | null;
  decision: Decision;
  sampleRatioMismatch: boolean;
};

/** VariantStats of one arm (take rate as conversion, revenue per impression as the primary metric). Pure. */
export function armStats(variant: "A" | "B", g: ArmAggregate): VariantStats {
  const n = g.impressions;
  const moments = (sum: number, sumSq: number) => {
    const mean = n ? sum / n : 0;
    return [mean, n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0] as const;
  };
  const [mean, variance] = moments(g.sumCents, g.sumSqCents);
  const [pMean, pVar] = moments(g.profitSumCents ?? 0, g.profitSumSqCents ?? 0);
  return {
    variant,
    visitors: n,
    converted: g.takes,
    orders: g.takes,
    revenueCents: g.sumCents,
    cvr: n ? g.takes / n : 0,
    rpv: mean,
    rpvVar: variance,
    ppv: pMean,
    ppvVar: pVar,
    profitCents: g.profitSumCents ?? 0,
  };
}

/** "profit" when both arms have takes and every take has a known cost, else "revenue". Pure. */
export function offerTestMetric(a: ArmAggregate, b: ArmAggregate): PrimaryMetric {
  const takes = a.takes + b.takes;
  const costed = (a.costedTakes ?? 0) + (b.costedTakes ?? 0);
  return takes > 0 && costed === takes && a.profitSumCents != null && b.profitSumCents != null ? "profit" : "revenue";
}

/** Test result of an offer from its two arms' aggregates. Pure. */
export function offerTestResult(offerId: string, a: ArmAggregate, b: ArmAggregate, split: number, ageDays: number): OfferTest {
  const sa = armStats("A", a);
  const sb = armStats("B", b);
  const v = analyze(sa, sb, split);
  const metric = offerTestMetric(a, b);
  const costKnown = (g: ArmAggregate) => g.profitSumCents != null && (g.costedTakes ?? 0) === g.takes;
  const arm = (s: VariantStats, g: ArmAggregate) => ({
    impressions: s.visitors,
    takes: s.orders,
    takeRate: s.cvr,
    revenuePerImpressionHtCents: Math.round(s.rpv),
    profitPerImpressionCents: costKnown(g) ? Math.round(s.ppv ?? 0) : null,
  });
  const profit = metric === "profit";
  return {
    offerId,
    split,
    ageDays,
    a: arm(sa, a),
    b: arm(sb, b),
    metric,
    uncostedTakes: a.takes + b.takes - (a.costedTakes ?? 0) - (b.costedTakes ?? 0),
    lift: profit ? v.ppvLift : v.rpvLift,
    pValue: profit ? v.ppvPValue : v.rpvPValue,
    ci: profit ? v.ppvLiftCi : v.rpvLiftCi,
    takeLift: v.cvrLift,
    takePValue: v.cvrPValue,
    minSample: MIN_VISITORS_PER_VARIANT,
    remainingDays: remainingDays(sa, sb, split, ageDays, undefined, metric),
    decision: decide(v, ageDays, metric),
    sampleRatioMismatch: v.sampleRatioMismatch,
  };
}

/**
 * Arm aggregates of a store's offers over paid orders of [since, until): one entry per arm key
 * ("<block>" for A, "<block>:B" for B). Revenue = offer amount − refunds, HT at the order's rate.
 */
export async function offerArmAggregates(
  store: { id: string; vatExempt: boolean; vatDomesticOnly: boolean; homeCountry?: string | null },
  since: Date,
  until: Date,
  includeTest: boolean,
): Promise<Map<string, ArmAggregate>> {
  const rate = vatRateSql(Prisma.sql`s."shippingAddress"->>'countryCode'`, store.vatExempt, store.homeCountry || undefined, store.vatDomesticOnly);
  const rows = await db.$queryRaw<
    { arm: string; n: bigint; takes: bigint; costed: bigint; sum: number | null; sumsq: number | null; psum: number | null; psumsq: number | null; first: Date | null }[]
  >`
    WITH imp AS (
      SELECT s.id, b AS arm, s."paidAt" AS at, ${rate} AS rate
      FROM "CheckoutSession" s, unnest(s."upsellShownBlocks") b
      WHERE s."storeId" = ${store.id} AND s.status = 'PAID' AND s."paidAt" >= ${since} AND s."paidAt" < ${until}
        ${includeTest ? Prisma.empty : Prisma.sql`AND s."test" = false AND s."forcedProvider" IS NULL`}
    )
    SELECT imp.arm, count(*) AS n, count(u.id) AS takes, count(u.id) FILTER (WHERE u."costCents" IS NOT NULL) AS costed,
           COALESCE(sum(v.v), 0)::float8 AS sum, COALESCE(sum(v.v * v.v), 0)::float8 AS sumsq,
           COALESCE(sum(v.v - pc.c), 0)::float8 AS psum, COALESCE(sum((v.v - pc.c) * (v.v - pc.c)), 0)::float8 AS psumsq, min(imp.at) AS first
    FROM imp
    LEFT JOIN "UpsellCharge" u ON u."sessionId" = imp.id AND u."blockId" = imp.arm AND u.status = 'PAID'
    CROSS JOIN LATERAL (SELECT COALESCE(round(GREATEST(u."amountCents" - u."refundedCents", 0) / (1 + imp.rate)), 0)::float8 AS v) v
    -- Cost of a take: product cost × quantity + Whop's fee (estimated at DEFAULT_FEE_RATE until Whop reports it).
    CROSS JOIN LATERAL (
      SELECT (CASE WHEN u.id IS NULL THEN 0
                   ELSE COALESCE(u."costCents", 0) * u.quantity + COALESCE(u."whopFeeCents", round(u."amountCents" * ${DEFAULT_FEE_RATE}::float8))
              END)::float8 AS c
    ) pc
    GROUP BY imp.arm`;
  return new Map(
    rows.map((r) => [
      r.arm,
      {
        impressions: Number(r.n),
        takes: Number(r.takes),
        sumCents: Number(r.sum ?? 0),
        sumSqCents: Number(r.sumsq ?? 0),
        firstAt: r.first,
        profitSumCents: Number(r.psum ?? 0),
        profitSumSqCents: Number(r.psumsq ?? 0),
        costedTakes: Number(r.costed),
      },
    ]),
  );
}

const EMPTY: ArmAggregate = { impressions: 0, takes: 0, sumCents: 0, sumSqCents: 0, firstAt: null };

/** Tests of every offer with arm B impressions in the aggregates; `splits` = the live split per offer. Pure. */
export function offerTests(aggs: Map<string, ArmAggregate>, splits: Map<string, number>, now = new Date()): OfferTest[] {
  const out: OfferTest[] = [];
  for (const [key, b] of aggs) {
    const { blockId, arm } = parseArmKey(key);
    if (arm !== "B") continue;
    const a = aggs.get(armKey(blockId, "A")) ?? EMPTY;
    const start = b.firstAt ?? now;
    out.push(offerTestResult(blockId, a, b, splits.get(blockId) ?? 50, Math.max(0, (now.getTime() - start.getTime()) / 86_400_000)));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Keeping the winner                                                  */
/* ------------------------------------------------------------------ */

type UpsellBlock = BlockOf<"upsell">;

/**
 * The offer block with arm B made the offer (product, price, texts and their translations) and
 * the test switched off; `keep: "A"` only switches the test off. Pure.
 */
export function promoteArm(block: UpsellBlock, keep: "A" | "B"): UpsellBlock {
  const b = block.props.variantB;
  if (!b) return block;
  const off = { ...b, enabled: false, autoPromote: false };
  if (keep === "A" || !offerHasB(block)) return { ...block, props: { ...block.props, variantB: off } };
  const props = { ...offerArmProps(block, "B"), variantB: off };
  // Translations typed for B's texts become the offer's (only where B had its own text).
  let i18n = block.i18n;
  if (i18n) {
    const own = new Set((["badge", "title", "text", "buttonText"] as const).filter((k) => b[k]));
    i18n = Object.fromEntries(
      Object.entries(i18n).map(([lang, fields]) => {
        const next: Record<string, string> = {};
        for (const [path, value] of Object.entries(fields ?? {})) {
          if (path.startsWith("variantB.")) {
            const k = path.slice("variantB.".length);
            if (own.has(k as never)) next[k] = value;
          } else if (!own.has(path as never)) next[path] = value;
        }
        return [lang, next];
      }),
    ) as typeof i18n;
  }
  return { ...block, props, ...(i18n ? { i18n } : {}) };
}

function replaceBlock(layout: Layout, blockId: string, keep: "A" | "B"): { layout: Layout; block: UpsellBlock | null } {
  let found: UpsellBlock | null = null;
  const blocks = layout.blocks.map((x: Block) => {
    if (x.id !== blockId || x.type !== "upsell") return x;
    found = x;
    return promoteArm(x, keep);
  });
  return { layout: { ...layout, blocks }, block: found };
}

/**
 * Ends an offer test: `keep` becomes the offer on the published thank-you page (and in the
 * builder draft, so the next publication doesn't bring the test back), with a version in the
 * history. Returns false when the offer or its test no longer exists.
 */
export async function endOfferTest(storeId: string, blockId: string, keep: "A" | "B", how: "manual" | "auto"): Promise<boolean> {
  const store = await db.store.findUnique({ where: { id: storeId }, select: { theme: true, checkoutLayout: true, thankYouLayout: true, draftThankYouLayout: true, timezone: true } });
  if (!store) return false;
  const published = replaceBlock(loadThankYouLayout(store.thankYouLayout), blockId, keep);
  if (!published.block?.props.variantB?.enabled) return false;
  const draft = store.draftThankYouLayout != null ? replaceBlock(loadThankYouLayout(store.draftThankYouLayout), blockId, keep).layout : null;
  const title = published.block.props.title || "offre";
  const day = new Date().toLocaleDateString("fr-FR", { timeZone: tzOf(store) });
  await db.$transaction([
    db.store.update({
      where: { id: storeId },
      data: {
        thankYouLayout: published.layout as unknown as Prisma.InputJsonValue,
        ...(draft ? { draftThankYouLayout: draft as unknown as Prisma.InputJsonValue } : {}),
        publishedAt: new Date(),
      },
    }),
    db.layoutVersion.create({
      data: {
        storeId,
        label: `Offre « ${title} » : ${keep === "B" ? "variante B promue" : "variante A conservée"} (${day})`.slice(0, 120),
        theme: (store.theme ?? {}) as Prisma.InputJsonValue,
        checkoutLayout: (store.checkoutLayout ?? {}) as Prisma.InputJsonValue,
        thankYouLayout: published.layout as unknown as Prisma.InputJsonValue,
      },
    }),
  ]);
  await recordEvent({
    storeId,
    level: how === "auto" ? "warn" : "info",
    kind: "offer_test.decided",
    message:
      keep === "B"
        ? `Test de l'offre « ${title} » : variante B promue${how === "auto" ? " automatiquement (écart significatif)" : ""}. Elle devient l'offre, le test est arrêté.`
        : `Test de l'offre « ${title} » : variante A conservée${how === "auto" ? " automatiquement (écart significatif)" : ""}, le test est arrêté.`,
    data: { blockId, keep, how },
    alert: how === "auto",
  });
  return true;
}

/** Look-back of the automatic decision (impressions older than this don't count). */
const AUTO_WINDOW_DAYS = 90;

/**
 * Tick job: offers whose arm B asks for auto-promotion are decided with `decide` (same rule as
 * the design tests); a winner is kept, anything else waits. Returns the number of tests ended.
 */
export async function autoPromoteOffers(deadline = Infinity): Promise<number> {
  const stores = await db.store.findMany({ where: { thankYouLayout: { not: Prisma.AnyNull } }, select: { id: true, testMode: true, vatExempt: true, vatDomesticOnly: true, homeCountry: true, thankYouLayout: true } });
  const now = new Date();
  let ended = 0;
  for (const store of stores) {
    if (stopForTime(deadline, 5_000)) break;
    const auto = loadThankYouLayout(store.thankYouLayout).blocks.filter(
      (b): b is UpsellBlock => b.type === "upsell" && !b.hidden && offerHasB(b) && !!b.props.variantB?.autoPromote,
    );
    if (!auto.length) continue;
    const aggs = await offerArmAggregates(store, new Date(now.getTime() - AUTO_WINDOW_DAYS * 86_400_000), now, store.testMode);
    const tests = offerTests(aggs, new Map(auto.map((b) => [b.id, b.props.variantB!.split])), now);
    for (const t of tests) {
      if (!auto.some((b) => b.id === t.offerId) || t.ageDays < MIN_TEST_DAYS || t.decision.kind !== "winner") continue;
      if (await endOfferTest(store.id, t.offerId, t.decision.winner, "auto")) ended++;
    }
  }
  return ended;
}
