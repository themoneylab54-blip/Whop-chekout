import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { STANDARD_VAT_RATES, splitVat, vatRate, vatRateSql } from "@/lib/vat";
import {
  adVerdict,
  enoughAdData,
  breakEvenCpa,
  breakEvenRoasLtv,
  stopLossHits,
  stopLossThreshold,
  noSalesExpected,
  failedSpike,
  disputeRateLevel,
  surveySummary,
  touchWithin,
  attachRate,
  attributeSpend,
  breakEvenRoas,
  cohortGrid,
  creativeRows,
  dailyReportMessage,
  parisHour,
  summaryAnomalies,
  dayCount,
  detectAnomalies,
  fixedCostsFor,
  isDay,
  ltvCacLevel,
  ltvRow,
  offerRates,
  parisDayStart,
  resolveRange,
  type Analytics,
} from "@/lib/analytics";
import { analyze, autoPromoteThreshold, decide, normalQuantile, percentile, remainingDays, summarize, type VariantStats } from "@/lib/experiments";
import { CAMPAIGN_ROWS, convertSpend, parseMetaInsights, parseTiktokReport, spendLevel, toCents } from "@/lib/adspend";
import { convertCents, crossRate, parseEcbXml } from "@/lib/fx";
import { parseCsvAmount, parseCsvDay, parseSpendCsv } from "@/lib/adspend-csv";
import { crossStoreTotals, sortStores } from "@/lib/dashboard-stats";
import type { StoreSummary } from "@/lib/analytics";
import { formatChange } from "@/components/dashboard/AnalyticsKit";

describe("VAT", () => {
  it("covers the EU-27 (plus Monaco) with standard rates, nothing outside the EU", () => {
    const eu = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FR", "GR", "HR", "HU", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"];
    for (const c of eu) expect(STANDARD_VAT_RATES[c], c).toBeGreaterThan(0);
    expect(STANDARD_VAT_RATES.FR).toBe(20);
    expect(STANDARD_VAT_RATES.DE).toBe(19);
    expect(STANDARD_VAT_RATES.HU).toBe(27);
    expect(STANDARD_VAT_RATES.MC).toBe(20);
    expect(STANDARD_VAT_RATES.CH).toBeUndefined();
  });
  it("uses the EU delivery country, 0 % for exports, the home rate only when unknown, and 0 when exempt", () => {
    expect(vatRate("be")).toBeCloseTo(0.21);
    // Exports outside the EU VAT area: no VAT.
    for (const cc of ["US", "CH", "GB", "NO", "RE", "GP", "CA"]) expect(vatRate(cc), cc).toBe(0);
    expect(vatRate(null)).toBeCloseTo(0.2);
    expect(vatRate(" ")).toBeCloseTo(0.2);
    expect(vatRate("DE", { vatExempt: true })).toBe(0);
  });
  it("splits a VAT-inclusive amount so that HT + TVA = TTC", () => {
    expect(splitVat(12000, 0.2)).toEqual({ htCents: 10000, vatCents: 2000 });
    const s = splitVat(4990, 0.21);
    expect(s.htCents + s.vatCents).toBe(4990);
    expect(s.htCents).toBe(Math.round(4990 / 1.21));
    expect(splitVat(4990, 0)).toEqual({ htCents: 4990, vatCents: 0 });
  });
  it("builds a SQL CASE with every rate, or 0 for exempt stores", () => {
    const sql = vatRateSql(Prisma.sql`x`);
    expect(sql.sql).toContain("CASE upper");
    expect(sql.values).toContain("FR");
    expect(vatRateSql(Prisma.sql`x`, true).sql).toBe("0::numeric");
  });
});

describe("Paris periods", () => {
  it("converts Paris midnight to the right UTC instant across DST", () => {
    expect(parisDayStart("2026-01-15").toISOString()).toBe("2026-01-14T23:00:00.000Z");
    expect(parisDayStart("2026-07-15").toISOString()).toBe("2026-07-14T22:00:00.000Z");
    // DST starts on 29 March 2026 at 02:00 and ends on 25 October 2026 at 03:00.
    expect(parisDayStart("2026-03-29").toISOString()).toBe("2026-03-28T23:00:00.000Z");
    expect(parisDayStart("2026-03-30").toISOString()).toBe("2026-03-29T22:00:00.000Z");
    expect(parisDayStart("2026-10-25").toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(parisDayStart("2026-10-26").toISOString()).toBe("2026-10-25T23:00:00.000Z");
  });
  it("validates days", () => {
    expect(isDay("2026-02-28")).toBe(true);
    expect(isDay("2026-02-30")).toBe(false);
    expect(isDay("28/02/2026")).toBe(false);
    expect(dayCount("2026-09-01", "2026-09-30")).toBe(30);
  });
  it("resolves presets as N full Paris days ending today, and the previous period", () => {
    const r = resolveRange({ range: "7d" }, "2026-09-28");
    expect([r.from, r.to, r.days]).toEqual(["2026-09-22", "2026-09-28", 7]);
    expect([r.prevFrom, r.prevTo]).toEqual(["2026-09-15", "2026-09-21"]);
    expect(r.since.toISOString()).toBe("2026-09-21T22:00:00.000Z");
    expect(r.until.toISOString()).toBe("2026-09-28T22:00:00.000Z");
    const y = resolveRange({ range: "yesterday" }, "2026-09-28");
    expect([y.from, y.to, y.prevFrom]).toEqual(["2026-09-27", "2026-09-27", "2026-09-26"]);
    expect(resolveRange({}, "2026-09-28").key).toBe("30d");
  });
  it("accepts a valid custom range and rejects invalid ones with a message", () => {
    const c = resolveRange({ range: "custom", from: "2026-09-01", to: "2026-09-10" }, "2026-09-28");
    expect([c.key, c.days, c.prevFrom, c.prevTo, c.error]).toEqual(["custom", 10, "2026-08-22", "2026-08-31", undefined]);
    expect(resolveRange({ range: "custom", from: "2026-09-10", to: "2026-09-01" }, "2026-09-28")).toMatchObject({ key: "30d", error: expect.stringContaining("début") });
    expect(resolveRange({ range: "custom", from: "2026-09-10", to: "2026-10-01" }, "2026-09-28").error).toContain("futur");
    expect(resolveRange({ range: "custom", from: "2024-01-01", to: "2026-09-01" }, "2026-09-28").error).toContain("366");
    expect(resolveRange({ range: "custom", from: "nope" }, "2026-09-28").error).toBeDefined();
  });
});

describe("delta formatting", () => {
  it("never shows −0 %", () => {
    expect(formatChange(-0.0004)).toEqual({ text: "0 %", sign: 0 });
    expect(formatChange(0.0004).text).toBe("0 %");
    expect(formatChange(-0.017).text).toBe("−1,7 %");
    expect(formatChange(0.25).text).toBe("+25 %");
  });
});

describe("ad spend attribution", () => {
  const rows = [
    { source: "facebook", campaign: "Automne", utmIds: ["120001"], sessions: 10 },
    { source: "fb", campaign: "automne", utmIds: [], sessions: 50 },
    { source: "tiktok", campaign: "ugc", utmIds: [], sessions: 5 },
    { source: "google", campaign: "—", utmIds: [], sessions: 5 },
  ];
  it("matches campaign names case-insensitively, ids and utm_id, preferring the platform's source", () => {
    const { perRow, unattributed } = attributeSpend(rows, [
      { platform: "meta", campaignId: "999", campaignName: "AUTOMNE", spendCents: 1000 },
      { platform: "meta", campaignId: "120001", campaignName: "Renamed", spendCents: 500 },
      { platform: "tiktok", campaignId: "t1", campaignName: "ugc", spendCents: 300 },
      { platform: "tiktok", campaignId: "t2", campaignName: "Autre", spendCents: 200 },
      { platform: "meta", campaignId: "x", campaignName: "zero", spendCents: 0 },
    ]);
    // Both "facebook" and "fb" look like Meta: the one with more checkouts wins the name match.
    expect(perRow).toEqual([500, 1000, 300, 0]);
    expect(unattributed).toEqual([{ platform: "tiktok", campaign: "Autre", spendCents: 200 }]);
  });
});

describe("cohorts", () => {
  it("accumulates repeat rate and revenue per customer, null-free up to the current month", () => {
    const { months, maxOffset } = cohortGrid(
      [
        { cohort: "2026-07", k: 0, newCustomers: 4, secondOrders: 0, htCents: 40000 },
        { cohort: "2026-07", k: 1, newCustomers: 0, secondOrders: 1, htCents: 5000 },
        { cohort: "2026-07", k: 2, newCustomers: 0, secondOrders: 1, htCents: 3000 },
        { cohort: "2026-09", k: 0, newCustomers: 2, secondOrders: 1, htCents: 10000 },
      ],
      "2026-09",
    );
    expect(maxOffset).toBe(2);
    expect(months.map((m) => m.cohort)).toEqual(["2026-09", "2026-07"]);
    expect(months[1].repeatRate).toEqual([0, 0.25, 0.5]);
    expect(months[1].revenuePerCustomerHtCents).toEqual([10000, 11250, 12000]);
    expect(months[0].repeatRate).toEqual([0.5]);
  });
});

describe("A/B statistics", () => {
  const stats = (visitors: number, conv: number, value = 5000): VariantStats[] => {
    const rows = Array.from({ length: visitors }, (_, i) => ({ id: `r${i}`, variant: "A", visitorId: `v${i}`, status: i < conv ? "PAID" : "OPEN", totalCents: value }));
    return summarize(rows);
  };
  it("winsorizes revenue per visitor when asked", () => {
    const rows = [
      { id: "1", variant: "A", visitorId: "a", status: "PAID", totalCents: 5000 },
      { id: "2", variant: "A", visitorId: "b", status: "PAID", totalCents: 500000 },
      { id: "3", variant: "A", visitorId: "c", status: "OPEN", totalCents: 0 },
    ];
    const cap = percentile([5000, 500000], 0.99);
    const [a] = summarize(rows, 10000);
    expect(cap).toBeGreaterThan(5000);
    expect(a.rpv).toBeCloseTo((5000 + 10000) / 3);
    expect(a.revenueCents).toBe(505000);
    expect(a.aovCents).toBe(252500);
  });
  it("gives confidence intervals that contain the observed lift", () => {
    const [a] = stats(2000, 60);
    const [b] = stats(2000, 90).map((s) => ({ ...s, variant: "B" }));
    const v = analyze(a, b, 50);
    expect(v.cvrLift).toBeCloseTo(0.5);
    expect(v.cvrLiftCi![0]).toBeLessThan(0.5);
    expect(v.cvrLiftCi![1]).toBeGreaterThan(0.5);
    expect(v.cvrLiftCi![0]).toBeGreaterThan(0);
    expect(v.rpvLiftCi).not.toBeNull();
  });
  it("decides with the same thresholds as auto-promotion", () => {
    expect(autoPromoteThreshold(8)).toBe(0.001);
    expect(autoPromoteThreshold(20)).toBe(0.01);
    const v = {
      cvrLift: 0.1,
      cvrPValue: 0.004,
      cvrLiftCi: null,
      rpvLift: 0.12,
      rpvPValue: 0.004,
      rpvLiftCi: null,
      ppvLift: 0,
      ppvPValue: 1,
      ppvLiftCi: null,
      sampleRatioMismatch: false,
      enoughData: true,
    };
    expect(decide(v, 3)).toEqual({ kind: "waiting", reason: "too_early" });
    expect(decide(v, 10)).toEqual({ kind: "inconclusive", threshold: 0.001, metric: "revenue" });
    expect(decide(v, 15)).toEqual({ kind: "winner", winner: "B", threshold: 0.01, metric: "revenue" });
    expect(decide({ ...v, rpvLift: -0.1, cvrLift: 0 }, 15)).toMatchObject({ kind: "winner", winner: "A" });
    // B raises revenue per visitor but converts 5 % less: a trade-off, never an automatic winner (nor "A").
    expect(decide({ ...v, cvrLift: -0.05 }, 15)).toEqual({ kind: "tradeoff", better: "B", threshold: 0.01, metric: "revenue" });
    // …and the other way round: A earns more per visitor but B converts 10 % better.
    expect(decide({ ...v, rpvLift: -0.1, cvrLift: 0.1 }, 15)).toMatchObject({ kind: "tradeoff", better: "A" });
    // A 1 % conversion dip is tolerated.
    expect(decide({ ...v, cvrLift: -0.01 }, 15)).toMatchObject({ kind: "winner", winner: "B" });
    expect(decide({ ...v, enoughData: false }, 15)).toEqual({ kind: "waiting", reason: "too_few_visitors" });
    expect(decide({ ...v, sampleRatioMismatch: true }, 15)).toEqual({ kind: "broken" });
  });
  it("decides on profit per visitor when it's the primary metric", () => {
    const v = {
      cvrLift: 0,
      cvrPValue: 1,
      cvrLiftCi: null,
      rpvLift: 0.2,
      rpvPValue: 0.0001,
      rpvLiftCi: null,
      ppvLift: -0.15,
      ppvPValue: 0.002,
      ppvLiftCi: null,
      sampleRatioMismatch: false,
      enoughData: true,
    };
    // B sells more but earns less: on profit, A wins; on revenue, B.
    expect(decide(v, 20, "profit")).toEqual({ kind: "winner", winner: "A", threshold: 0.01, metric: "profit" });
    expect(decide(v, 20, "revenue")).toMatchObject({ kind: "winner", winner: "B" });
    expect(decide({ ...v, ppvPValue: 0.2 }, 20, "profit")).toEqual({ kind: "inconclusive", threshold: 0.01, metric: "profit" });
    expect(decide({ ...v, ppvLift: 0.3, cvrLift: -0.04 }, 20, "profit")).toMatchObject({ kind: "tradeoff", better: "B", metric: "profit" });
  });
  it("tests profit per visitor (Welch) and tolerates negative profit means", () => {
    const a: VariantStats = { variant: "A", visitors: 5000, orders: 150, revenueCents: 0, cvr: 0.03, rpv: 150, rpvVar: 150 * 150 * 30, ppv: 40, ppvVar: 40 * 40 * 30 };
    const b: VariantStats = { ...a, variant: "B", ppv: 60 };
    const v = analyze(a, b, 50);
    expect(v.ppvLift).toBeCloseTo(0.5);
    expect(v.ppvPValue).toBeLessThan(0.05);
    expect(v.ppvLiftCi![0]).toBeLessThan(0.5);
    const neg = analyze({ ...a, ppv: -20 }, { ...b, ppv: 10 }, 50);
    expect(neg.ppvLift).toBeCloseTo(1.5);
    expect(neg.ppvLiftCi).toBeNull();
    // Without profit data the p-value stays 1 (no decision on profit).
    expect(analyze({ ...a, ppv: undefined }, { ...b, ppv: undefined }, 50).ppvPValue).toBe(1);
  });
  it("estimates the days still needed to detect the minimum effect", () => {
    const a: VariantStats = { variant: "A", visitors: 700, orders: 21, revenueCents: 0, cvr: 0.03, rpv: 150, rpvVar: 150 * 150 * 30, converted: 21 };
    const b: VariantStats = { ...a, variant: "B" };
    const days = remainingDays(a, b, 50, 7)!;
    expect(days).toBeGreaterThan(7);
    // Twice the traffic: roughly half the time.
    const faster = remainingDays({ ...a, visitors: 1400 }, { ...b, visitors: 1400 }, 50, 7)!;
    expect(faster).toBeLessThan(days);
    expect(remainingDays(a, b, 50, 0)).toBeNull();
    expect(normalQuantile(0.975)).toBeCloseTo(1.96, 3);
    expect(normalQuantile(0.8)).toBeCloseTo(0.8416, 3);
  });
});

describe("VAT under the OSS threshold (vatDomesticOnly)", () => {
  it("uses the French rate for every EU destination and 0 % outside the EU", () => {
    expect(vatRate("DE", { domesticOnly: true })).toBeCloseTo(0.2);
    expect(vatRate("hu", { domesticOnly: true })).toBeCloseTo(0.2);
    expect(vatRate("CH", { domesticOnly: true })).toBe(0);
    expect(vatRate("NO", { domesticOnly: true })).toBe(0);
    expect(vatRate("US", { domesticOnly: true })).toBe(0);
    expect(vatRate(null, { domesticOnly: true })).toBeCloseTo(0.2);
    expect(vatRate("DE", { domesticOnly: true, vatExempt: true })).toBe(0);
    expect(vatRate("DE")).toBeCloseTo(0.19);
    const sql = vatRateSql(Prisma.sql`c`, false, undefined, true);
    const at = (cc: string) => sql.values[sql.values.indexOf(cc) + 1];
    expect([at("DE"), at("HU"), at("FR")]).toEqual([0.2, 0.2, 0.2]);
    expect(sql.values).not.toContain("CH");
    expect(sql.sql).toContain("ELSE 0::numeric");
  });
});

describe("ad verdicts and creatives", () => {
  it("computes the break-even ROAS and the Couper / Garder / Scaler verdict", () => {
    // 25 % margin before ads → break-even ROAS HT 4.
    expect(breakEvenRoas(2500, 10000)).toBe(4);
    expect(breakEvenRoas(0, 10000)).toBeNull();
    expect(breakEvenRoas(-100, 10000)).toBeNull();
    // ROAS ÷ break-even = POAS.
    expect(adVerdict(null)).toBeNull();
    expect(adVerdict(0.5)).toBe("cut");
    expect(adVerdict(0.97)).toBe("keep");
    expect(adVerdict(1.3)).toBe("keep");
    expect(adVerdict(1.31)).toBe("scale");
  });
  it("says « Trop tôt » until 5 orders or 2 × the break-even CPA spent", () => {
    // Margin per order before ads = break-even CPA.
    expect(breakEvenCpa(12_000, 4)).toBe(3000);
    expect(breakEvenCpa(0, 0)).toBeNull();
    expect(enoughAdData(5999, 4, 3000)).toBe(false);
    expect(enoughAdData(6000, 0, 3000)).toBe(true);
    expect(enoughAdData(100, 5, 3000)).toBe(true);
    // No margin known yet: 50 € of spend; a negative margin makes any spend a loss.
    expect(enoughAdData(4999, 0, null)).toBe(false);
    expect(enoughAdData(5000, 0, null)).toBe(true);
    expect(enoughAdData(1, 0, -200)).toBe(true);
    expect(adVerdict(3, { spendCents: 2000, orders: 1, breakEvenCpaCents: 3000 })).toBe("early");
    expect(adVerdict(0.2, { spendCents: 2000, orders: 1, breakEvenCpaCents: 3000 })).toBe("early");
    expect(adVerdict(0.2, { spendCents: 6000, orders: 1, breakEvenCpaCents: 3000 })).toBe("cut");
    expect(adVerdict(2, { spendCents: 1000, orders: 6, breakEvenCpaCents: 3000 })).toBe("scale");
    expect(adVerdict(null, { spendCents: 0, orders: 0, breakEvenCpaCents: 3000 })).toBeNull();
    // Creatives follow the same rule.
    const [c] = creativeRows([{ platform: "meta", campaignId: "ad:1", campaignName: "A", spendCents: 1000 }], [{ content: "a", term: null, orders: 1, htCents: 5000, profitCents: 3000 }], 3000);
    expect([c.poas, c.verdict]).toEqual([3, "early"]);
  });
  it("gives the break-even ROAS with the 90-day margin LTV", () => {
    // 10 orders, 5000 HT each; a customer brings 2500 of margin over 90 days → ROAS 2 breaks even.
    expect(breakEvenRoasLtv(50_000, 10, 2500)).toBe(2);
    expect(breakEvenRoasLtv(50_000, 10, null)).toBeNull();
    expect(breakEvenRoasLtv(50_000, 0, 2500)).toBeNull();
    expect(breakEvenRoasLtv(50_000, 10, -5)).toBeNull();
  });
  it("flags stop-loss campaigns, missing sales, failed-payment spikes and the dispute rate", () => {
    expect(stopLossThreshold(2000)).toBe(3000);
    expect(stopLossThreshold(null)).toBe(5000);
    const rows = [
      { campaign: "A", spendCents: 3001, orders: 0 },
      { campaign: "B", spendCents: 3000, orders: 0 },
      { campaign: "C", spendCents: 9000, orders: 1 },
      { campaign: "D", spendCents: 8000, orders: 0 },
    ];
    // C converts, but at a CPA of 90 € > 2 × the 20 € break-even CPA, after ≥ 2 × 20 € of spend.
    expect(stopLossHits(rows, 2000).map((r) => [r.campaign, r.reason, r.cpaCents])).toEqual([
      ["C", "cpa", 9000],
      ["D", "no_order", null],
      ["A", "no_order", null],
    ]);
    const cpa = (spendCents: number, orders: number) => stopLossHits([{ campaign: "X", spendCents, orders }], 2000).map((r) => r.reason);
    expect(cpa(4000, 1)).toEqual([]); // CPA 40 € = 2 × break-even: not above
    expect(cpa(4001, 1)).toEqual(["cpa"]);
    expect(cpa(3900, 1)).toEqual([]); // CPA 39 € but spend < 2 × break-even: too early
    expect(cpa(9000, 3)).toEqual([]); // CPA 30 € ≤ 40 €
    // Unknown break-even CPA: only the no-order rule (fallback threshold).
    expect(stopLossHits([{ campaign: "Y", spendCents: 90_000, orders: 1 }], null)).toEqual([]);
    // 20 % conversion per checkout: 15 checkouts → 3 payments expected; fewer than 10 checkouts: never.
    expect(noSalesExpected({ checkouts: 15, basePaid: 20, baseCheckouts: 100 })).toBeCloseTo(3);
    expect(noSalesExpected({ checkouts: 14, basePaid: 20, baseCheckouts: 100 })).toBeNull();
    expect(noSalesExpected({ checkouts: 9, basePaid: 90, baseCheckouts: 100 })).toBeNull();
    expect(noSalesExpected({ checkouts: 50, basePaid: 0, baseCheckouts: 100 })).toBeNull();
    expect(failedSpike({ failed: 5, paid: 5, baseFailed: 10, basePaid: 90 })).toEqual({ share: 0.5, baseShare: 0.1 });
    expect(failedSpike({ failed: 4, paid: 0, baseFailed: 0, basePaid: 90 })).toBeNull();
    expect(failedSpike({ failed: 5, paid: 5, baseFailed: 30, basePaid: 70 })).toBeNull();
    expect(disputeRateLevel(1, 100)).toBe("critical");
    expect(disputeRateLevel(3, 400)).toBe("warn");
    expect(disputeRateLevel(1, 200)).toBeNull();
    expect(disputeRateLevel(1, 19)).toBeNull();
  });
  it("summarises survey answers against the UTM source of the same orders", () => {
    const s = surveySummary([
      { answer: "instagram", source: "direct / inconnu", orders: 3, htCents: 9000 },
      { answer: "instagram", source: "instagram", orders: 1, htCents: 3000 },
      { answer: "friend", source: "direct / inconnu", orders: 2, htCents: 5000 },
      { answer: null, source: "facebook", orders: 4, htCents: 12000 },
    ]);
    expect([s.orders, s.answered]).toEqual([10, 6]);
    expect(s.answers.map((a) => [a.answer, a.orders, a.revenueHtCents])).toEqual([
      ["instagram", 4, 12000],
      ["friend", 2, 5000],
    ]);
    expect(s.answers[0].utm[0]).toEqual({ source: "direct / inconnu", orders: 3 });
  });
  it("keeps a paid touch only inside the attribution window", () => {
    const now = Date.parse("2026-09-28T12:00:00Z");
    const touch = (daysAgo: number) => ({ utm_source: "facebook", utm_campaign: "x", junk: "y", ts: String(now - daysAgo * 86_400_000) });
    expect(touchWithin(touch(6.9), 7, now)).toEqual({ utm_source: "facebook", utm_campaign: "x", ts: new Date(now - 6.9 * 86_400_000).toISOString() });
    expect(touchWithin(touch(7.1), 7, now)).toBeNull();
    expect(touchWithin(touch(27), 28, now)).not.toBeNull();
    expect(touchWithin(touch(400), null, now)).not.toBeNull();
    // No date (older loader): kept; unknown keys only: nothing; future date: dropped.
    expect(touchWithin({ fbclid: "abc" }, 1, now)).toEqual({ fbclid: "abc" });
    expect(touchWithin({ junk: "1" }, 7, now)).toBeNull();
    expect(touchWithin({ gclid: "g", ts: String(now + 3 * 86_400_000) }, 7, now)).toBeNull();
    expect(touchWithin(undefined, 7, now)).toBeNull();
  });
  it("matches ad set and ad spend to orders by utm_content / utm_term (id or name, any case), never twice per level", () => {
    const rows = creativeRows(
      [
        { platform: "meta", campaignId: "ad:111", campaignName: "UGC Hook A", spendCents: 3000 },
        // Same creative in another ad set: grouped by name.
        { platform: "meta", campaignId: "ad:112", campaignName: "ugc hook a", spendCents: 1000 },
        { platform: "meta", campaignId: "ad:200", campaignName: "Static B", spendCents: 2000 },
        { platform: "meta", campaignId: "adset:9", campaignName: "Broad FR", spendCents: 6000 },
        { platform: "tiktok", campaignId: "ad:7", campaignName: "TT spark", spendCents: 500 },
        // Campaign rows are ignored here.
        { platform: "meta", campaignId: "123", campaignName: "Automne", spendCents: 9999 },
      ],
      [
        { content: "ugc hook a", term: "broad fr", orders: 2, htCents: 10000, profitCents: 4000 },
        { content: "200", term: "9", orders: 1, htCents: 3000, profitCents: 1000 },
        { content: "inconnu", term: null, orders: 5, htCents: 50000, profitCents: 20000 },
      ],
    );
    expect(rows.map((r) => [r.level, r.name, r.spendCents, r.orders])).toEqual([
      ["adset", "Broad FR", 6000, 3],
      ["ad", "UGC Hook A", 4000, 2],
      ["ad", "Static B", 2000, 1],
      ["ad", "TT spark", 500, 0],
    ]);
    const ugc = rows[1];
    expect(ugc.ids).toEqual(["111", "112"]);
    expect(ugc).toMatchObject({ revenueHtCents: 10000, profitCents: 4000, profitAfterAdsCents: 0, cpaCents: 2000, roas: 2.5, poas: 1 });
    expect(rows[3]).toMatchObject({ cpaCents: null, poas: 0 });
  });
  it("tells campaign rows from ad set / ad rows (totals never include the latter)", () => {
    expect([spendLevel("123"), spendLevel("manual:automne"), spendLevel("adset:9"), spendLevel("ad:7")]).toEqual(["campaign", "campaign", "adset", "ad"]);
    expect(CAMPAIGN_ROWS).toEqual({ NOT: [{ campaignId: { startsWith: "adset:" } }, { campaignId: { startsWith: "ad:" } }] });
  });
});

describe("ad platform reports", () => {
  it("parses Meta ad set and ad insights with prefixed ids", () => {
    expect(parseMetaInsights({ data: [{ adset_id: "5", adset_name: "Broad", campaign_id: "1", spend: "3", date_start: "2026-09-20" }] }, "EUR", "adset")).toEqual([
      { day: "2026-09-20", campaignId: "adset:5", campaignName: "Broad", spendCents: 300, currency: "EUR" },
    ]);
    expect(parseMetaInsights({ data: [{ ad_id: "8", ad_name: "Hook", spend: "1.5", date_start: "2026-09-20" }, { campaign_id: "1", spend: "2", date_start: "2026-09-20" }] }, "EUR", "ad")).toEqual([
      { day: "2026-09-20", campaignId: "ad:8", campaignName: "Hook", spendCents: 150, currency: "EUR" },
    ]);
  });
  it("parses TikTok ad group and ad reports", () => {
    const adgroup = parseTiktokReport({ code: 0, data: { list: [{ dimensions: { adgroup_id: "4", stat_time_day: "2026-09-21 00:00:00" }, metrics: { spend: "2", adgroup_name: "FR 25-44" } }] } }, "EUR", "adset");
    expect(adgroup.rows).toEqual([{ day: "2026-09-21", campaignId: "adset:4", campaignName: "FR 25-44", spendCents: 200, currency: "EUR" }]);
    const ad = parseTiktokReport({ code: 0, data: { list: [{ dimensions: { ad_id: "6", stat_time_day: "2026-09-21 00:00:00" }, metrics: { spend: "1", ad_name: "Spark" } }] } }, "EUR", "ad");
    expect(ad.rows[0]).toMatchObject({ campaignId: "ad:6", campaignName: "Spark" });
  });
  it("parses Meta insights", () => {
    const rows = parseMetaInsights(
      { data: [{ campaign_id: "1", campaign_name: "Automne", spend: "12.34", account_currency: "eur", date_start: "2026-09-20", date_stop: "2026-09-20" }, { spend: "1" }] },
      "EUR",
    );
    expect(rows).toEqual([{ day: "2026-09-20", campaignId: "1", campaignName: "Automne", spendCents: 1234, currency: "EUR" }]);
  });
  it("parses TikTok reports and surfaces API errors", () => {
    const { rows, totalPages } = parseTiktokReport(
      { code: 0, message: "OK", data: { list: [{ dimensions: { campaign_id: "9", stat_time_day: "2026-09-21 00:00:00" }, metrics: { spend: "5.5", campaign_name: "ugc" } }], page_info: { total_page: 2 } } },
      "EUR",
    );
    expect(rows).toEqual([{ day: "2026-09-21", campaignId: "9", campaignName: "ugc", spendCents: 550, currency: "EUR" }]);
    expect(totalPages).toBe(2);
    expect(() => parseTiktokReport({ code: 40001, message: "Access token is invalid" }, "EUR")).toThrow(/Access token/);
    expect(toCents("0.005")).toBe(1);
    expect(toCents("abc")).toBe(0);
  });
});

describe("costs, disputes and refunds helpers", () => {
  it("prorates monthly fixed costs per Paris day (a full month costs exactly the monthly amount)", () => {
    expect(fixedCostsFor(3000_00, "2026-09-01", "2026-09-30")).toBe(3000_00);
    expect(fixedCostsFor(3000_00, "2026-02-01", "2026-02-28")).toBe(3000_00);
    expect(fixedCostsFor(3000_00, "2026-09-01", "2026-09-01")).toBe(100_00);
    // 31 August (1/31) + 1 September (1/30).
    expect(fixedCostsFor(3100_00, "2026-08-31", "2026-09-01")).toBe(Math.round(3100_00 / 31 + 3100_00 / 30));
    expect(fixedCostsFor(0, "2026-01-01", "2026-12-31")).toBe(0);
  });
  it("computes order-bump attach rates on the orders that were shown the option", () => {
    expect(attachRate(10, 40, 0)).toEqual({ shown: 40, rate: 0.25, estimated: false });
    // Legacy orders (nothing recorded) count as shown: estimated, lower bound.
    expect(attachRate(10, 40, 60)).toEqual({ shown: 100, rate: 0.1, estimated: true });
    // Never below the number of takers.
    expect(attachRate(5, 0, 0).shown).toBe(5);
  });
  it("gives offer take rates as a range when older orders didn't record impressions", () => {
    expect(offerRates(10, 30, 50, 0)).toEqual({ impressions: 50, rate: 0.2, range: null });
    const r = offerRates(10, 30, 50, 50);
    expect(r.impressions).toBe(100);
    expect(r.range).toEqual([0.1, 0.2]);
  });
  it("flags anomalies only with enough volume", () => {
    const base = {
      cvr: 0.02,
      visitors: 1000,
      previous: { cvr: 0.04, visitors: 1000, roas: 3, spendCents: 100_00, refundRate: 0.02 },
      ads: { available: true, roas: 1.5, spendCents: 100_00 },
      risk: { refundRate: 0.06, tx: 100 },
    } as unknown as Analytics;
    expect(detectAnomalies(base).map((a) => a.key)).toEqual(["conversion", "roas", "refunds"]);
    expect(detectAnomalies({ ...base, visitors: 50 }).map((a) => a.key)).toEqual(["roas", "refunds"]);
    expect(detectAnomalies({ ...base, cvr: 0.035, ads: { ...base.ads, roas: 2.9 }, risk: { refundRate: 0.03, tx: 100 } } as Analytics)).toEqual([]);
    expect(detectAnomalies(base)[0].title).toMatch(/50\s%/);
    expect(detectAnomalies(base)[0].title).toMatch(/^Conversion checkout/);
  });
  it("flags the same anomalies on a cross-store summary", () => {
    const f = { orders: 10, revenueCents: 0, revenueHtCents: 0, profitCents: 0, complete: true, netAfterAdsCents: 0, fixedCostsCents: 0, netAfterFixedCents: 0 };
    const sum = {
      ...f,
      visitors: 1000,
      cvr: 0.02,
      spendCents: 100_00,
      roas: 1.5,
      poas: null,
      tx: 100,
      refundRate: 0.06,
      previous: { ...f, visitors: 1000, cvr: 0.04, spendCents: 100_00, roas: 3, poas: null, tx: 100, refundRate: 0.02 },
    };
    expect(summaryAnomalies(sum).map((a) => a.key)).toEqual(["conversion", "roas", "refunds"]);
  });
  it("writes the daily report and knows the Paris hour", () => {
    const msg = dailyReportMessage("Maison", "2026-09-27", "EUR", { revenueHtCents: 123450, orders: 3, netAfterAdsCents: -1000, spendCents: 5000, roas: 2.469, estimated: true }, [
      { title: "ROAS HT en baisse de 40 %" },
    ]);
    expect(msg).toMatch(/^Maison, dimanche 27 septembre : CA HT 1\s234,50\s€, 3 commandes, bénéfice après pub ≈ -10,00\s€ \(pub 50,00\s€, ROAS HT 2,47\)\. Anomalies : ROAS HT en baisse de 40 %\.$/);
    expect(dailyReportMessage("M", "2026-09-27", "EUR", { revenueHtCents: 0, orders: 1, netAfterAdsCents: 0, spendCents: 0, roas: null, estimated: false }, [])).toMatch(/1 commande, .*aucune dépense pub.*Anomalies : aucune\.$/);
    // Campaign verdicts (7 days) and the biggest loser.
    const withAds = dailyReportMessage("M", "2026-09-27", "EUR", { revenueHtCents: 0, orders: 1, netAfterAdsCents: 0, spendCents: 100, roas: 1, estimated: false }, [], [
      { name: "Hiver", verdict: "cut", spendCents: 9000, profitAfterAdsCents: -4500 },
      { name: "Automne", verdict: "scale", spendCents: 5000, profitAfterAdsCents: 3000 },
      { name: "Test", verdict: "early", spendCents: 800, profitAfterAdsCents: -800 },
      { name: "Sans pub", verdict: null, spendCents: 0, profitAfterAdsCents: 100 },
    ]);
    expect(withAds).toMatch(/Campagnes \(7 j\) : 1 à scaler, 1 à couper, 1 trop tôt pour juger \(à couper : Hiver\)\. Plus grosse perte : Hiver \(-45,00\s€ après pub\)\.$/);
    // 05:30 UTC = 07:30 in Paris (summer time), 06:30 in winter.
    expect(parisHour(new Date("2026-09-28T05:30:00Z"))).toBe(7);
    expect(parisHour(new Date("2026-12-28T05:30:00Z"))).toBe(6);
  });
});

describe("LTV / CAC", () => {
  it("computes margin LTV at 30/60/90 days, CAC and the ratio at the longest horizon", () => {
    const r = ltvRow({ source: "facebook", customers: 100, n30: 80, n60: 50, n90: 0, r30: 800_000, r60: 600_000, r90: 0, p30: 240_000, p60: 200_000, p90: 0 }, 200_000);
    expect(r.margin30).toBe(3000);
    expect(r.margin60).toBe(4000);
    expect(r.margin90).toBeNull();
    expect(r.ltv30).toBe(10_000);
    expect(r.cacCents).toBe(2000);
    expect(r.ltvCac).toBeCloseTo(2);
    expect(r.ltvCacHorizon).toBe(60);
    const noSpend = ltvRow({ source: "direct", customers: 10, n30: 10, n60: 0, n90: 0, r30: 1, r60: 0, r90: 0, p30: 1, p60: 0, p90: 0 }, 0);
    expect([noSpend.cacCents, noSpend.ltvCac]).toEqual([null, null]);
  });
  it("classifies LTV/CAC health", () => {
    expect(ltvCacLevel(0.8)).toBe("bad");
    expect(ltvCacLevel(1)).toBe("warn");
    expect(ltvCacLevel(2.99)).toBe("warn");
    expect(ltvCacLevel(3)).toBe("good");
    expect(ltvCacLevel(null)).toBeNull();
  });
});

describe("FX", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope><Cube><Cube time='2026-09-25'>
    <Cube currency='USD' rate='1.1000'/><Cube currency='GBP' rate="0.8500"/><Cube currency='CHF' rate='0.9400'/></Cube></Cube></gesmes:Envelope>`;
  it("parses the ECB daily XML", () => {
    expect(parseEcbXml(xml)).toEqual({ date: "2026-09-25", rates: { EUR: 1, USD: 1.1, GBP: 0.85, CHF: 0.94 } });
    expect(parseEcbXml("<html>maintenance</html>")).toBeNull();
  });
  it("converts through EUR cross rates", () => {
    const { rates } = parseEcbXml(xml)!;
    expect(crossRate("USD", "EUR", rates)).toBeCloseTo(1 / 1.1);
    expect(convertCents(110_00, "USD", "EUR", rates)).toBe(100_00);
    expect(convertCents(85_00, "GBP", "USD", rates)).toBe(110_00);
    expect(convertCents(100, "EUR", "eur", rates)).toBe(100);
    expect(convertCents(100, "JPY", "EUR", rates)).toBeNull();
  });
  it("converts foreign ad spend to the store currency, or keeps it flagged without a rate", () => {
    const { rates } = parseEcbXml(xml)!;
    expect(convertSpend({ spendCents: 110_00, currency: "usd" }, "EUR", rates)).toEqual({ spendCents: 100_00, currency: "EUR", originalSpendCents: 110_00, originalCurrency: "USD", fxRate: 1 / 1.1 });
    expect(convertSpend({ spendCents: 500, currency: "EUR" }, "EUR", rates)).toEqual({ spendCents: 500, currency: "EUR", originalSpendCents: null, originalCurrency: null, fxRate: null });
    expect(convertSpend({ spendCents: 500, currency: "USD" }, "EUR", null)).toEqual({ spendCents: 500, currency: "USD", originalSpendCents: 500, originalCurrency: "USD", fxRate: null });
  });
});

describe("ad spend CSV", () => {
  it("parses French amounts and both date formats", () => {
    expect(parseCsvAmount("12,50")).toBe(1250);
    expect(parseCsvAmount("1 234,56 €")).toBe(123456);
    expect(parseCsvAmount("1.234,56")).toBe(123456);
    expect(parseCsvAmount("1,234.56")).toBe(123456);
    expect(parseCsvAmount("abc")).toBeNull();
    expect(parseCsvAmount("-5")).toBeNull();
    expect(parseCsvDay("27/09/2026")).toBe("2026-09-27");
    expect(parseCsvDay("2026-09-27")).toBe("2026-09-27");
    expect(parseCsvDay("31/02/2026")).toBeNull();
  });
  it("parses ; and , files with a header, and reports errors per line", () => {
    const semi = parseSpendCsv("jour;plateforme;campagne;montant\n27/09/2026;Google;marque;42,50\n28/09/2026;facebook;automne;10\n30/09/2026;meta;futur;1\nxx;meta;a;1\n27/09/2026;tiktok;;3", "2026-09-28");
    expect(semi.rows).toEqual([
      { line: 2, day: "2026-09-27", platform: "google", campaign: "marque", amountCents: 4250, currency: null },
      { line: 3, day: "2026-09-28", platform: "meta", campaign: "automne", amountCents: 1000, currency: null },
    ]);
    expect(semi.errors.map((e) => [e.line, e.message.split(" ")[0]])).toEqual([
      [4, "Date"],
      [5, "Date"],
      [6, "Nom"],
    ]);
    const comma = parseSpendCsv('2026-09-27,tiktok,ugc,12,50\n2026-09-27,other,influence,"1 000,00",USD', "2026-09-28");
    expect(comma.rows.map((r) => [r.platform, r.amountCents, r.currency])).toEqual([
      ["tiktok", 1250, null],
      ["other", 100000, "USD"],
    ]);
    expect(comma.errors).toEqual([]);
  });
});

describe("cross-store view", () => {
  const fig = (o: Partial<StoreSummary> = {}) =>
    ({ orders: 1, revenueCents: 0, revenueHtCents: 0, profitCents: 0, complete: true, visitors: 0, cvr: 0, spendCents: 0, netAfterAdsCents: 0, roas: null, poas: null, ...o }) as StoreSummary;
  const s = (o: Partial<StoreSummary>, prev: Partial<StoreSummary> = {}) => ({ ...fig(o), previous: fig(prev) });
  it("sorts stores, missing values last", () => {
    const rows = [
      { name: "B", summary: s({ revenueHtCents: 100, roas: null }) },
      { name: "A", summary: s({ revenueHtCents: 300, roas: 2 }) },
      { name: "C", summary: s({ revenueHtCents: 200, roas: 1 }) },
    ];
    expect(sortStores(rows, "ca", "desc").map((r) => r.name)).toEqual(["A", "C", "B"]);
    expect(sortStores(rows, "roas", "asc").map((r) => r.name)).toEqual(["C", "A", "B"]);
    expect(sortStores(rows, "roas", "desc").map((r) => r.name)).toEqual(["A", "C", "B"]);
    expect(sortStores(rows, "name", "asc").map((r) => r.name)).toEqual(["A", "B", "C"]);
  });
  it("sums totals, converting to EUR when currencies differ, and flags estimates", () => {
    const rates = { date: "2026-09-25", rates: { EUR: 1, USD: 1.25 }, fetchedAt: "" };
    const t = crossStoreTotals(
      [
        { name: "FR", currency: "EUR", summary: s({ revenueHtCents: 1000, profitCents: 100 }, { revenueHtCents: 500 }) },
        { name: "US", currency: "USD", summary: s({ revenueHtCents: 1250, profitCents: 125, complete: false }) },
        { name: "JP", currency: "JPY", summary: s({ revenueHtCents: 9999 }) },
      ],
      rates,
    );
    expect(t).toMatchObject({ currency: "EUR", converted: true, rateDate: "2026-09-25", skipped: ["JP"], estimated: true });
    expect(t.now.revenueHtCents).toBe(2000);
    expect(t.now.profitCents).toBe(200);
    expect(t.previous.revenueHtCents).toBe(500);
    const same = crossStoreTotals([{ name: "FR", currency: "EUR", summary: s({ revenueHtCents: 10 }) }], null);
    expect(same).toMatchObject({ currency: "EUR", converted: false, skipped: [] });
  });
  it("sums fixed costs, net after fixed costs and the daily profit after ads across stores", () => {
    const rates = { date: "2026-09-25", rates: { EUR: 1, USD: 1.25 }, fetchedAt: "" };
    const t = crossStoreTotals(
      [
        { name: "FR", currency: "EUR", summary: s({ fixedCostsCents: 1000, netAfterFixedCents: -500 }), daily: [{ day: "2026-09-02", netAfterAdsCents: 100 }, { day: "2026-09-01", netAfterAdsCents: -50 }] },
        { name: "US", currency: "USD", summary: s({ fixedCostsCents: 1250, netAfterFixedCents: 250 }), daily: [{ day: "2026-09-01", netAfterAdsCents: 125 }] },
      ],
      rates,
    );
    expect([t.now.fixedCostsCents, t.now.netAfterFixedCents]).toEqual([2000, -300]);
    expect(t.daily).toEqual([
      { day: "2026-09-01", netAfterAdsCents: 50 },
      { day: "2026-09-02", netAfterAdsCents: 100 },
    ]);
    expect(sortStores([{ name: "A", summary: s({ netAfterFixedCents: 1 }) }, { name: "B", summary: s({ netAfterFixedCents: 5 }) }], "netfixed", "desc").map((r) => r.name)).toEqual(["B", "A"]);
  });
});
