import { describe, expect, it } from "vitest";
import { zoneLabel } from "@/lib/time";
import { blendedVatRate, categoryVatRate, isVatCategory } from "@/lib/vat";
import { dayValueMode, modeAt, type ModeChange } from "@/lib/value-mode";
import { fallbackDaysOf, platformValueMode, platformVsReal, realOnModeDays, customerHistoryOf, ltvRow } from "@/lib/analytics";
import { coverageFrom, nextBackfillChunk } from "@/lib/adspend";
import { customerRows, externalRows, isOwnOrder, priorOrdersOf } from "@/lib/shopify-history";
import { centsToField, claimCostEstimate } from "@/lib/claim-cost";

/*
 * Analytics round 12 (pure parts): platform ROAS vs POAS per conversion value mode, fallback days,
 * outside orders, buyers' Shopify history, ad spend history coverage, reduced VAT rates, zone labels
 * and the claim cost prefill.
 */

describe("zone labels (A5)", () => {
  it("names the store's zone in French", () => {
    expect(zoneLabel("Europe/Paris")).toBe("heure de Paris");
    expect(zoneLabel("America/New_York")).toBe("heure de New York");
    expect(zoneLabel("Europe/Amsterdam")).toBe("heure d'Amsterdam");
    expect(zoneLabel("Europe/London")).toBe("heure de Londres");
    expect(zoneLabel("Indian/Reunion")).toBe("heure de La Réunion");
    expect(zoneLabel("UTC")).toBe("heure UTC");
    expect(zoneLabel("Not/AZone")).toBe("heure de Paris");
    expect(zoneLabel(null)).toBe("heure de Paris");
  });
});

describe("reduced VAT rates (A8)", () => {
  it("uses the category's rate at the place of taxation, the standard rate when unknown", () => {
    expect(categoryVatRate("food", "FR")).toEqual({ rate: 0.055, known: true });
    expect(categoryVatRate("books", "DE")).toEqual({ rate: 0.07, known: true });
    expect(categoryVatRate("press", "FR")).toEqual({ rate: 0.021, known: true });
    expect(categoryVatRate("intermediate", "FR")).toEqual({ rate: 0.1, known: true });
    // Rate not in the table for that country: its standard rate, flagged.
    expect(categoryVatRate("food", "HU")).toEqual({ rate: 0.27, known: false });
    expect(categoryVatRate("press", "BE")).toEqual({ rate: 0.21, known: false });
    // Under the OSS threshold: the home (French) rate of the category everywhere in the EU.
    expect(categoryVatRate("food", "DE", { domesticOnly: true })).toEqual({ rate: 0.055, known: true });
    // Export, unknown destination, exempt store, standard / unknown category.
    expect(categoryVatRate("food", "US")).toEqual({ rate: 0, known: true });
    expect(categoryVatRate("food", null)).toEqual({ rate: 0.055, known: true });
    expect(categoryVatRate("food", "FR", { vatExempt: true })).toEqual({ rate: 0, known: true });
    expect(categoryVatRate("standard", "DE")).toEqual({ rate: 0.19, known: true });
    expect(categoryVatRate("bogus", "DE")).toEqual({ rate: 0.19, known: true });
    expect(isVatCategory("food")).toBe(true);
    expect(isVatCategory("toString")).toBe(false);
  });

  it("weights an order's lines by their amounts", () => {
    const cat = (v: string) => (v === "food" ? "food" : null);
    const r = blendedVatRate(
      [
        { variantId: "food", quantity: 2, unitPriceCents: 1000 },
        { variantId: "tee", quantity: 1, unitPriceCents: 2000 },
      ],
      cat,
      "FR",
    );
    expect(r.rate).toBeCloseTo((2000 * 0.055 + 2000 * 0.2) / 4000, 10);
    expect(r.known).toBe(true);
    expect(blendedVatRate([], cat, "DE").rate).toBe(0.19);
    expect(blendedVatRate([{ variantId: "food", quantity: 1, unitPriceCents: 100 }], cat, "HU")).toEqual({ rate: 0.27, known: false });
  });
});

describe("conversion value mode per day (A1)", () => {
  const tz = "Europe/Paris";
  // Switched to "profit" at 01:30 on 10 September, Paris time.
  const history: ModeChange[] = [{ at: "2026-09-09T23:30:00.000Z", from: "revenue", to: "profit" }];

  it("knows the mode of each day, mixed on the day it changed, always revenue for Google", () => {
    const change = history[0].at;
    expect(modeAt(history, "profit", Date.parse(change) - 1)).toBe("revenue");
    expect(modeAt(history, "profit", Date.parse(change) + 1)).toBe("profit");
    expect(dayValueMode("meta", "2026-09-09", history, "profit", tz)).toBe("revenue");
    expect(dayValueMode("meta", "2026-09-10", history, "profit", tz)).toBe("mixed");
    expect(dayValueMode("tiktok", "2026-09-11", history, "profit", tz)).toBe("profit");
    expect(dayValueMode("google", "2026-09-11", history, "profit", tz)).toBe("revenue");
    expect(dayValueMode("meta", "2026-09-11", [], "revenue", tz)).toBe("revenue");
    expect(platformValueMode("profit")).toBe("profit");
    expect(platformValueMode("mixed")).toBe("unknown");
    expect(platformValueMode(null)).toBe("unknown");
  });

  it("compares a profit-mode platform value to our margin (POAS), without VAT ratio", () => {
    const rows = [{ source: "facebook", campaign: "automne", orders: 4, revenueCents: 12000, revenueHtCents: 10000, profitCents: 3000 }];
    const spend = [
      { platform: "meta", campaignId: "1", campaignName: "automne", spendCents: 2000, platformConversions: 5, platformValueCents: 4500, valueMode: "profit" },
      { platform: "meta", campaignId: "1", campaignName: "automne", spendCents: 1000, platformConversions: 2, platformValueCents: 6000, valueMode: "revenue" },
    ];
    const out = platformVsReal(rows, spend, () => 0, 1);
    const profit = out.find((r) => r.valueMode === "profit")!;
    expect(profit).toMatchObject({ platformValueHtCents: 4500, realProfitCents: 3000, platformRoas: 4500 / 2000, realRoas: 3000 / 2000, overAttribution: 4500 / 3000, split: false });
    const revenue = out.find((r) => r.valueMode === "revenue")!;
    // TTC value taken HT at our orders' ratio (10000 / 12000), compared to our CA HT.
    expect(revenue.platformValueHtCents).toBe(5000);
    expect(revenue.realRoas).toBe(10000 / 1000);
    expect(revenue.overAttribution).toBe(0.5);
    // Our margin at 0 or below: infinite over-attribution for a positive platform margin.
    const loss = platformVsReal([{ ...rows[0], profitCents: -100 }], [spend[0]], () => 0, 1)[0];
    expect(loss.overAttribution).toBe(Infinity);
  });

  it("splits our orders by the days each mode was in effect", () => {
    const byDay = new Map([
      ["2026-09-01", { orders: 1, revenueCents: 1200, revenueHtCents: 1000, profitCents: 300 }],
      ["2026-09-02", { orders: 2, revenueCents: 2400, revenueHtCents: 2000, profitCents: 700 }],
      ["2026-09-03", { orders: 1, revenueCents: 1200, revenueHtCents: 1000, profitCents: 100 }],
    ]);
    const modes = new Map<string, "revenue" | "profit" | "unknown">([
      ["2026-09-01", "revenue"],
      ["2026-09-02", "profit"],
      ["2026-09-04", "profit"],
    ]);
    // 09-03 has no row: it follows the most frequent mode (profit).
    expect(realOnModeDays(byDay, modes, "profit")).toEqual({ orders: 3, revenueCents: 3600, revenueHtCents: 3000, profitCents: 800 });
    expect(realOnModeDays(byDay, modes, "revenue")).toEqual({ orders: 1, revenueCents: 1200, revenueHtCents: 1000, profitCents: 300 });
    const rows = [{ source: "facebook", campaign: "c", orders: 4, revenueCents: 4800, revenueHtCents: 4000, profitCents: 1100 }];
    const out = platformVsReal(
      rows,
      [{ platform: "meta", campaignId: "1", campaignName: "c", spendCents: 1000, platformConversions: 3, platformValueCents: 1600, valueMode: "profit" }],
      () => 0,
      1,
      (_i, _p, mode) => realOnModeDays(byDay, modes, mode),
    );
    expect(out[0]).toMatchObject({ split: true, realOrders: 3, realProfitCents: 800, overAttribution: 2 });
  });
});

describe("fallback days, outside orders, buyer history (A2, A3)", () => {
  it("flags the days a fallback period touched", () => {
    const tz = "Europe/Paris";
    const periods = [
      { startedAt: new Date("2026-09-02T21:30:00Z"), endedAt: new Date("2026-09-02T22:30:00Z") }, // 23:30 → 00:30 Paris
      { startedAt: new Date("2026-09-05T10:00:00Z"), endedAt: null },
    ];
    expect(fallbackDaysOf(periods, "2026-09-01", "2026-09-06", tz, Date.parse("2026-09-05T12:00:00Z"))).toEqual(["2026-09-02", "2026-09-03", "2026-09-05"]);
    expect(fallbackDaysOf(periods, "2026-09-01", "2026-09-06", tz, Date.parse("2026-09-06T12:00:00Z"))).toContain("2026-09-06");
  });

  it("keeps only the orders not created by this app, HT with the store's VAT model", () => {
    const nodes = [
      { id: "gid://shopify/Order/1", name: "#1", createdAt: "2026-09-01T10:00:00Z", processedAt: "2026-09-01T09:00:00Z", sourceName: "web", tags: [], currentTotalPriceSet: { shopMoney: { amount: "120.00", currencyCode: "EUR" } }, shippingAddress: { countryCodeV2: "FR" } },
      { id: "gid://shopify/Order/2", name: "#2", createdAt: "2026-09-01T10:00:00Z", sourceName: "whop-checkout", tags: ["whop-checkout"], currentTotalPriceSet: { shopMoney: { amount: "50.00" } } },
      { id: "gid://shopify/Order/3", name: "#3", createdAt: "2026-09-01T10:00:00Z", sourceName: "pos", tags: ["whop-checkout", "remplacement"], currentTotalPriceSet: { shopMoney: { amount: "0" } } },
      { id: "gid://shopify/Order/4", name: "#4", createdAt: "2026-09-02T10:00:00Z", test: true, cancelledAt: "2026-09-03T10:00:00Z", currentTotalPriceSet: { shopMoney: { amount: "10.5" } }, shippingAddress: { countryCodeV2: "us" } },
    ];
    expect(isOwnOrder(nodes[1])).toBe(true);
    const rows = externalRows(nodes, { shopCurrency: "EUR", vatExempt: false, vatDomesticOnly: false });
    expect(rows.map((r) => r.shopifyOrderId)).toEqual(["gid://shopify/Order/1", "gid://shopify/Order/4"]);
    expect(rows[0]).toMatchObject({ totalCents: 12000, htCents: 10000, countryCode: "FR", orderedAt: new Date("2026-09-01T09:00:00Z"), test: false, cancelledAt: null });
    expect(rows[1]).toMatchObject({ totalCents: 1050, htCents: 1050, countryCode: "US", test: true, currency: "EUR" });
  });

  it("counts the buyer's orders before this one, and reads the customers backfill", () => {
    const old = { id: "gid://shopify/Order/9", createdAt: "2025-01-01T00:00:00Z" };
    expect(priorOrdersOf(null, "x")).toBeNull();
    expect(priorOrdersOf({ id: "c", numberOfOrders: "3", orders: { nodes: [old] } }, "gid://shopify/Order/10")).toBe(2);
    // Count not updated yet with the new order: still at least 1 when an older order exists.
    expect(priorOrdersOf({ id: "c", numberOfOrders: "1", orders: { nodes: [old] } }, "gid://shopify/Order/10")).toBe(1);
    expect(priorOrdersOf({ id: "c", numberOfOrders: "1", orders: { nodes: [{ id: "gid://shopify/Order/10", createdAt: "2026-09-01T00:00:00Z" }] } }, "gid://shopify/Order/10")).toBe(0);
    expect(priorOrdersOf({ id: "c", numberOfOrders: 0, orders: { nodes: [] } }, "o")).toBe(0);
    const seen = new Date("2026-09-28T00:00:00Z");
    expect(
      customerRows(
        [
          { id: "c1", numberOfOrders: "2", defaultEmailAddress: { emailAddress: " A@X.test " }, orders: { nodes: [{ createdAt: "2026-08-01T00:00:00Z" }] } },
          // Oldest order out of the app's sight: they had ordered by the time of the read.
          { id: "c2", numberOfOrders: "5", defaultEmailAddress: { emailAddress: "b@x.test" }, orders: { nodes: [] } },
          { id: "c3", numberOfOrders: "0", defaultEmailAddress: { emailAddress: "c@x.test" } },
          { id: "c4", numberOfOrders: "1", defaultEmailAddress: null },
        ],
        seen,
      ),
    ).toEqual([
      // 2 orders, 1 visible (inside the 60-day window): the other is older, hidden — first order before the window.
      { email: "a@x.test", customerId: "c1", numberOfOrders: 2, firstOrderAt: new Date(seen.getTime() - 61 * 86_400_000) },
      { email: "b@x.test", customerId: "c2", numberOfOrders: 5, firstOrderAt: new Date(seen.getTime() - 61 * 86_400_000) },
    ]);
    expect(customerHistoryOf(null)).toEqual({ state: "none", customers: 0 });
    expect(customerHistoryOf({ state: "error", cursor: null, customers: 3, startedAt: "", connectedAt: null, error: "boom" })).toEqual({ state: "error", customers: 3, error: "boom" });
  });
});

describe("ad spend history (A4)", () => {
  it("walks backwards one chunk at a time down to the target", () => {
    expect(nextBackfillChunk({ target: "2025-09-01", cursor: "2026-09-22", done: false })).toEqual({ since: "2026-08-22", until: "2026-09-21" });
    expect(nextBackfillChunk({ target: "2026-09-10", cursor: "2026-09-22", done: false })).toEqual({ since: "2026-09-10", until: "2026-09-21" });
    expect(nextBackfillChunk({ target: "2026-09-10", cursor: "2026-09-10", done: false })).toBeNull();
    expect(nextBackfillChunk({ target: "2025-09-01", cursor: "2026-09-22", done: true })).toBeNull();
  });

  it("knows from which day every connected platform's spend is complete", () => {
    const today = "2026-09-28";
    const p = (cursor: string, done = false) => ({ account: "a", target: "2025-08-29", cursor, done, at: "" });
    expect(coverageFrom([], null, { other: "2026-01-01" }, today)).toEqual({ from: null, backfilling: false });
    // Not started yet: its earliest row, else the regular 7-day window.
    expect(coverageFrom(["meta"], null, {}, today)).toEqual({ from: "2026-09-22", backfilling: true });
    expect(coverageFrom(["meta"], null, { meta: "2026-05-01" }, today)).toEqual({ from: "2026-05-01", backfilling: true });
    // The latest-covered platform sets the day.
    expect(coverageFrom(["meta", "tiktok"], { platforms: { meta: p("2026-06-01"), tiktok: p("2025-08-29", true) } }, {}, today)).toEqual({ from: "2026-06-01", backfilling: true });
    expect(coverageFrom(["meta"], { platforms: { meta: p("2025-08-29", true) } }, {}, today)).toEqual({ from: "2025-08-29", backfilling: false });
  });

  it("divides spend by the new customers of the CAC window", () => {
    const r = ltvRow({ source: "fb", customers: 10, n30: 0, n60: 0, n90: 0, r30: 0, r60: 0, r90: 0, p30: 0, p60: 0, p90: 0 }, 6000, 3);
    expect(r.cacCents).toBe(2000);
    expect(ltvRow({ source: "fb", customers: 10, n30: 0, n60: 0, n90: 0, r30: 0, r60: 0, r90: 0, p30: 0, p60: 0, p90: 0 }, 6000).cacCents).toBe(600);
  });
});

describe("claim cost prefill (D2)", () => {
  it("adds the selected items' purchase costs and the carrier cost", () => {
    const items = [
      { key: "line:0", costCents: 1200 },
      { key: "line:1", costCents: null },
      { key: "offer:x", costCents: 800 },
    ];
    expect(claimCostEstimate(items, null, 590)).toEqual({ cents: 2590, missing: 1, itemsCents: 2000, carrierCents: 590 });
    expect(claimCostEstimate(items, new Set(["line:0"]), 590)).toEqual({ cents: 1790, missing: 0, itemsCents: 1200, carrierCents: 590 });
    // Nothing selected: nothing to ship, no carrier cost.
    expect(claimCostEstimate(items, new Set(), 590)).toEqual({ cents: 0, missing: 0, itemsCents: 0, carrierCents: 0 });
    expect(claimCostEstimate(items, null, null).carrierCents).toBe(0);
    expect(centsToField(1790)).toBe("17,90");
  });
});
