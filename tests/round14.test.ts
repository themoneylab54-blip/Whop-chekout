import { describe, expect, it } from "vitest";
import type { CheckoutSession, Store } from "@prisma/client";
import { DeadlineError, notePartial, stopForTime } from "@/lib/deadline";
import { withLogContext } from "@/lib/log";
import { reconcileMarkAfterWalk, TICK_JOBS, NON_MONEY_JOB_MS, PARTIAL_PREFIX } from "@/lib/tick";
import { offerMergeWait, OFFER_MERGE_WAIT_MS } from "@/lib/upsell";
import { costsKnown, ga4Payload, metaPayload, pixelNextAttempt, sessionEvent, tiktokPayload, MAX_PIXEL_ATTEMPTS } from "@/lib/conversions";
import { CALL_RESERVE_MS, customerAccessDenied, firstOrderAtOf, stuckImportMessage } from "@/lib/shopify-history";
import { adSpendVatFactor, dailyReportMessage, externalChannelOf, externalChannels, leakageAlarming, leakageWindowFrom, LEAKAGE_ALERT_SHARE, parisDayStart } from "@/lib/analytics";
import { shopifyCodeUses } from "@/lib/shopify-discounts";
import { platformFresh } from "@/lib/adspend";
import { isDeadline, RetryLater } from "@/lib/webhooks";
import { vatRate, splitVat } from "@/lib/vat";
import { storeRange } from "@/lib/dashboard-stats";
import { resolveRange } from "@/lib/analytics";

/*
 * Round 14 (correctness), pure parts: the reconciliation mark of a store without payments, the tick's
 * job order and its partial / skipped reporting, the pixel backoff, the merged-offer wait, the profit
 * value without product costs, the buyers' first order behind Shopify's 60-day visibility, the outside
 * orders' channels and covered window, the leakage digest line, the calibrated Shopify code count,
 * stuck imports (Protected Customer Data), the home country's VAT and each store's own days.
 */

const MIN = 60_000;
const DAY = 86_400_000;

describe("reconciliation mark (P1)", () => {
  it("is written from the walk's start less the overlap when no payment is newer", () => {
    const start = Date.parse("2026-09-28T10:00:00Z");
    expect(reconcileMarkAfterWalk(0, start)).toBe(start - 15 * MIN);
    // An old mark (no payment for hours) moves forward too.
    expect(reconcileMarkAfterWalk(start - 5 * 3600_000, start)).toBe(start - 15 * MIN);
    // A payment newer than that keeps the mark on it.
    expect(reconcileMarkAfterWalk(start - MIN, start)).toBe(start - MIN);
  });
});

describe("tick jobs (P1/P2)", () => {
  it("runs conversions after every money job and Google before the history backfills", () => {
    const names = TICK_JOBS.map((j) => j.name);
    const at = (n: string) => names.indexOf(n);
    expect(at("conversionsRetried")).toBeGreaterThan(at("disputeEvidence"));
    for (const j of TICK_JOBS.filter((x) => x.money)) expect(at(j.name)).toBeLessThan(at("conversionsRetried"));
    expect(TICK_JOBS.find((j) => j.name === "conversionsRetried")!.money).toBe(false);
    expect(at("googleConversions")).toBeLessThan(at("adSpendBackfill"));
    expect(at("googleAdjustments")).toBeLessThan(at("shopifyHistory"));
    expect(NON_MONEY_JOB_MS).toBeLessThanOrEqual(5_000);
    expect(PARTIAL_PREFIX.startsWith("skipped")).toBe(true);
  });

  it("stopForTime notes the job partial; its reserve is measured against the hard deadline", () => {
    const holder: { partial?: boolean } = {};
    withLogContext({ tickPartial: holder, hardDeadline: Date.now() + 30_000 }, () => {
      expect(stopForTime(Date.now() + 5_000, 12_000)).toBe(false);
      expect(holder.partial).toBeUndefined();
      expect(stopForTime(Date.now() - 1)).toBe(true);
    });
    expect(holder.partial).toBe(true);
    const tight: { partial?: boolean } = {};
    withLogContext({ tickPartial: tight, hardDeadline: Date.now() + 5_000 }, () => expect(stopForTime(Date.now() + 60_000, 12_000)).toBe(true));
    expect(tight.partial).toBe(true);
    // Outside a tick: no reserve, never throws.
    expect(stopForTime(Date.now() + 1_000, 60_000)).toBe(false);
    notePartial();
  });
});

describe("pixel backoff (P1/P2)", () => {
  it("schedules each failed try on its own clock, none after the last", () => {
    const now = Date.parse("2026-09-28T10:00:00Z");
    expect(pixelNextAttempt(1, now)!.getTime()).toBe(now + 5 * MIN);
    expect(pixelNextAttempt(2, now)!.getTime()).toBe(now + 30 * MIN);
    expect(pixelNextAttempt(4, now)!.getTime()).toBe(now + 360 * MIN);
    expect(pixelNextAttempt(MAX_PIXEL_ATTEMPTS, now)).toBeNull();
  });
});

describe("merged offers while the checkout's order is on its way (P2)", () => {
  const paid = { status: "PAID", paidAt: new Date("2026-09-28T10:00:00Z"), reviewNote: null, syncHandledAt: null };
  const opts = (minutes: number) => ({ windowMin: 10, offerCreatedAt: paid.paidAt, now: paid.paidAt.getTime() + minutes * MIN });
  it("waits within the merge window, else says why the offer gets its own order", () => {
    expect(offerMergeWait(paid, opts(3))).toBe("defer");
    expect(offerMergeWait(paid, opts(10))).toContain("pas encore créée 10 min");
    expect(offerMergeWait({ ...paid, reviewNote: "fraude ?" }, opts(1))).toContain("vérification");
    expect(offerMergeWait({ ...paid, syncHandledAt: new Date() }, opts(1))).toContain("main");
    expect(OFFER_MERGE_WAIT_MS).toBe(2 * MIN);
  });
});

describe("profit value without product costs (conversions)", () => {
  const line = (o: Record<string, unknown> = {}) => ({ variantId: "gid://shopify/ProductVariant/1", productId: "gid://shopify/Product/1", title: "T", quantity: 1, unitPriceCents: 5000, ...o });
  const session = (lines: unknown[]) =>
    ({
      id: "s14",
      currency: "EUR",
      totalCents: 6000,
      subtotalCents: 6000,
      paidAt: new Date("2026-09-28T10:00:00Z"),
      createdAt: new Date("2026-09-28T09:00:00Z"),
      lines,
      tracking: { ga: "1.2" },
      visitorId: null,
      whopFeeCents: 0,
      test: false,
      email: "b@c14fix.test",
      shippingAddress: { countryCode: "FR" },
      store: { conversionValueMode: "profit", vatExempt: false, vatDomesticOnly: false, fulfillmentFeeCents: 0, metaCatalogCountry: "FR", metaContentIdFormat: "variant", tiktokPixelId: "t" },
    }) as unknown as CheckoutSession & { store: Store };

  it("never sends the revenue as the margin: no value for Meta / TikTok, revenue without profit for GA4", () => {
    expect(costsKnown([line({ unitCostCents: 100 })] as never)).toBe(true);
    expect(costsKnown([line({ unitCostCents: null })] as never)).toBe(false);
    expect(costsKnown([line({ quantity: 0 })] as never)).toBe(true);
    const unknown = sessionEvent(session([line({ unitCostCents: 1000 }), line({ unitCostCents: null })]), "purchase");
    expect(unknown).toMatchObject({ profitUnknown: true, revenueCents: 6000 });
    expect(unknown.profitCents).toBeUndefined();
    const s = session([line()]);
    expect(metaPayload(s, unknown).data[0].custom_data).not.toHaveProperty("value");
    expect(tiktokPayload(s, unknown).data[0].properties).not.toHaveProperty("value");
    const ga = ga4Payload(s, unknown).events[0].params as Record<string, unknown>;
    expect(ga.value).toBe(60);
    expect(ga).not.toHaveProperty("profit");
    // Costs known: the margin as before.
    const known = sessionEvent(session([line({ unitCostCents: 1000 })]), "purchase", { shipCostCents: 0, bumpCostCents: 0, feeCents: 0, feeRate: 0.03 });
    expect(known.profitUnknown).toBeUndefined();
    expect(known.valueCents).toBe(4000);
    expect(metaPayload(s, known).data[0].custom_data.value).toBe(40);
  });
});

describe("buyers' first order behind Shopify's 60-day visibility", () => {
  const seen = new Date("2026-09-28T00:00:00Z");
  it("puts the first order before the window when orders are hidden, never on the oldest visible one", () => {
    const visible = [{ createdAt: "2026-09-01T00:00:00Z" }];
    expect(firstOrderAtOf(3, visible, seen)).toEqual(new Date(seen.getTime() - 61 * DAY));
    // Every order visible: the oldest one.
    expect(firstOrderAtOf(1, visible, seen)).toEqual(new Date("2026-09-01T00:00:00Z"));
    // read_all_orders granted (oldest visible before the window): nothing hidden.
    expect(firstOrderAtOf(5, [{ createdAt: "2025-01-01T00:00:00Z" }], seen)).toEqual(new Date("2025-01-01T00:00:00Z"));
    // None visible: before the window.
    expect(firstOrderAtOf(2, [], seen)).toEqual(new Date(seen.getTime() - 61 * DAY));
  });
});

describe("outside orders: channels, covered window, digest line", () => {
  it("splits web, POS, drafts and the rest", () => {
    expect(["web", "pos", "shopify_draft_order", "iphone", null, "1234"].map(externalChannelOf)).toEqual(["web", "pos", "draft", "other", "other", "other"]);
    const c = externalChannels([
      { channel: "web", orders: 2n, ttc: 12000n, ht: 10000n },
      { channel: "draft", orders: 1, ttc: 600, ht: 500 },
    ]);
    expect(c.web).toEqual({ orders: 2, revenueCents: 12000, revenueHtCents: 10000 });
    expect(c.draft.orders).toBe(1);
    expect(c.pos).toEqual({ orders: 0, revenueCents: 0, revenueHtCents: 0 });
  });

  it("starts the share on the first whole day the import covers", () => {
    const tz = "Europe/Paris";
    expect(leakageWindowFrom(new Date(parisDayStart("2026-09-20", tz).getTime() + 6 * 3600_000), "2026-09-15", tz)).toBe("2026-09-21");
    expect(leakageWindowFrom(parisDayStart("2026-09-20", tz), "2026-09-15", tz)).toBe("2026-09-20");
    expect(leakageWindowFrom(parisDayStart("2026-09-01", tz), "2026-09-15", tz)).toBe("2026-09-15");
  });

  it("adds a digest line above 10 % of the online sales", () => {
    // Round 15: at least 3 outside orders (one or two are noise).
    expect(leakageAlarming({ share: LEAKAGE_ALERT_SHARE + 0.01, orders: 3 })).toBe(true);
    expect(leakageAlarming({ share: LEAKAGE_ALERT_SHARE + 0.01, orders: 1 })).toBe(false);
    expect(leakageAlarming({ share: 0.1, orders: 3 })).toBe(false);
    expect(leakageAlarming({ share: null, orders: 3 })).toBe(false);
    const a = { revenueHtCents: 10000, orders: 2, netAfterAdsCents: 3000, spendCents: 0, roas: null, estimated: false };
    expect(dailyReportMessage("B", "2026-09-27", "EUR", a, [], [], { leakage: { share: 0.25, revenueHtCents: 5000, orders: 3 } })).toContain("hors checkout Whop : 25 %");
    expect(dailyReportMessage("B", "2026-09-27", "EUR", a, [], [], { leakage: { share: 0.05, revenueHtCents: 500, orders: 1 } })).not.toContain("hors checkout");
  });
});

describe("Shopify code uses, calibrated (P3)", () => {
  it("adds Shopify's count and the ledger unless Shopify is known to count our orders", () => {
    expect(shopifyCodeUses(6, 3)).toBe(9);
    expect(shopifyCodeUses(6, 3, null)).toBe(9);
    expect(shopifyCodeUses(6, 3, false)).toBe(9);
    expect(shopifyCodeUses(6, 3, true)).toBe(6);
    expect(shopifyCodeUses(2, 3, true)).toBe(3);
  });
});

describe("stuck background imports (P3)", () => {
  it("mentions Protected Customer Data when Shopify denies the customer fields", () => {
    const denied = "Access denied for customers field. Required access: `read_customers` access scope. Also: This app is not approved to access the Customer object.";
    expect(customerAccessDenied(denied)).toBe(true);
    expect(customerAccessDenied("Shopify 503")).toBe(false);
    const since = new Date(Date.now() - 3 * DAY).toISOString();
    expect(stuckImportMessage("customers", denied, since)).toContain("Protected Customer Data");
    expect(stuckImportMessage("external", "Shopify 503", since)).toMatch(/depuis 3 jours/);
    expect(stuckImportMessage("external", "Shopify 503", since)).not.toContain("Protected");
    // One Shopify call is 2 × 12 s: the reserve holds it.
    expect(CALL_RESERVE_MS).toBeGreaterThanOrEqual(25_000);
  });
});

describe("ad spend, per platform hourly (P2)", () => {
  it("keeps a platform imported by a run cut short fresh, the others due", () => {
    const now = Date.parse("2026-09-28T10:00:00Z");
    const prev = { at: new Date(0).toISOString(), platforms: { meta: { at: new Date(now - 10 * MIN).toISOString(), ok: true, rows: 3 }, tiktok: { ok: true, rows: 1 } } };
    expect(platformFresh(prev, "meta", now)).toBe(true);
    expect(platformFresh(prev, "tiktok", now)).toBe(false);
    expect(platformFresh(null, "google", now)).toBe(false);
  });
});

describe("webhook replay out of time (P3)", () => {
  it("recognizes the deadline, even behind a RetryLater", () => {
    expect(isDeadline(new DeadlineError("x"))).toBe(true);
    expect(isDeadline(new RetryLater("Whop injoignable", { cause: new DeadlineError("Whop") }))).toBe(true);
    expect(isDeadline(new RetryLater("Whop injoignable", { cause: new Error("500") }))).toBe(false);
    expect(isDeadline(new Error("x"))).toBe(false);
  });
});

describe("home country (VAT)", () => {
  it("uses the store's country for unknown destinations, OSS sales and ad invoices", () => {
    expect(vatRate(null, { homeCountry: "DE" })).toBeCloseTo(0.19);
    expect(vatRate("IT", { homeCountry: "DE", domesticOnly: true })).toBeCloseTo(0.19);
    expect(vatRate("IT", { homeCountry: "DE" })).toBeCloseTo(0.22);
    expect(vatRate(null)).toBeCloseTo(0.2);
    expect(splitVat(11900, vatRate(null, { homeCountry: "DE" })).htCents).toBe(10000);
    expect(adSpendVatFactor({ vatExempt: true, adSpendVatNonReclaimable: true, homeCountry: "BE" })).toBeCloseTo(1.21);
    expect(adSpendVatFactor({ vatExempt: true, adSpendVatNonReclaimable: true })).toBeCloseTo(1.2);
  });
});

describe("portfolio: each store's own days", () => {
  it("keeps the same days (custom) or the zone's own today (presets)", () => {
    const paris = resolveRange({ range: "custom", from: "2026-09-01", to: "2026-09-07" }, "2026-09-28", "30d", "Europe/Paris");
    const ny = storeRange(paris, "America/New_York");
    expect([ny.from, ny.to]).toEqual(["2026-09-01", "2026-09-07"]);
    // Midnight in New York, not in Paris.
    expect(ny.since.toISOString()).toBe("2026-09-01T04:00:00.000Z");
    expect(paris.since.toISOString()).toBe("2026-08-31T22:00:00.000Z");
    const preset = storeRange(resolveRange({ range: "7d" }, undefined, "30d", "Europe/Paris"), "Pacific/Auckland");
    expect(preset.days).toBe(7);
  });
});
