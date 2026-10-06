import { describe, expect, it } from "vitest";
import type { CheckoutSession, Store } from "@prisma/client";
import { armStats, offerTestMetric, offerTestResult, type ArmAggregate } from "@/lib/offer-tests";
import { BEST_SLOT_MIN_CHECKOUTS, bestSlots, wilsonLowerBound } from "@/lib/heat";
import { geoCountryOf } from "@/lib/geo";
import { googleAdsQuery, googleCustomerId, googleErrorMessage, parseGoogleAdsStream } from "@/lib/adspend-google";
import {
  breakDeal,
  breakDiscountCents,
  computeTotals,
  parseQuantityBreaks,
  quantityBreakForLines,
  tierThreshold,
  validateQuantityTiers,
  type CartLine,
  type QuantityBreak,
} from "@/lib/pricing";
import { automaticDiscountFor, automaticDiscountsOf, eligibleLines, parseCodeDiscount, sameItems, shopifyCodeAsDiscount } from "@/lib/shopify-discounts";
import { buildOrderCreateInput, type PaidOrderInput } from "@/lib/shopify";
import { chargePlanWith, roundCharge, toChargeCents, toShopCents } from "@/lib/charge";
import { refundAmountIn } from "@/lib/payments";
import { hashLoginCode } from "@/lib/returning";
import { checkBuyerClaim, claimWindowOpen, CLAIM_WINDOW_DAYS } from "@/lib/claims";
import { upsellConditionsMet, type UpsellBlock, type UpsellContext } from "@/lib/upsell";
import { withAutoProduct } from "@/lib/offer-auto";
import { ga4Payload, sessionEvent } from "@/lib/conversions";
import { LABELS } from "@/components/checkout/i18n";
import { upsellSellable } from "@/lib/layout";

/* Round 9 (product): margin-based offer tests, heatmap best slots, geo headers, Google Ads spend
 * import, quantity-break formats, Shopify discount codes / automatic discounts, local-currency
 * charging, returning-buyer codes, buyer protection claims, offer targeting and auto product,
 * GA4 profit parameter, and the buyer copy in 6 languages. */

const line = (over: Partial<CartLine> = {}): CartLine => ({
  variantId: "gid://shopify/ProductVariant/1",
  productId: "gid://shopify/Product/1",
  productHandle: "p",
  title: "Produit",
  variantTitle: null,
  sku: null,
  imageUrl: null,
  quantity: 1,
  unitPriceCents: 3000,
  compareAtCents: null,
  inventory: null,
  requiresShipping: true,
  ...over,
});

describe("offer A/B tests decide on margin when costs are known", () => {
  // Arm = n impressions, takes at `price` HT each, product cost `cost` and fee `fee` per take.
  const arm = (n: number, takes: number, price: number, cost: number | null, fee = 0): ArmAggregate => {
    const profit = price - (cost ?? 0) - fee;
    return {
      impressions: n,
      takes,
      sumCents: takes * price,
      sumSqCents: takes * price * price,
      firstAt: null,
      profitSumCents: takes * profit,
      profitSumSqCents: takes * profit * profit,
      costedTakes: cost == null ? 0 : takes,
    };
  };

  it("uses the profit metric when every take has a cost, revenue otherwise", () => {
    expect(offerTestMetric(arm(1000, 50, 3000, 1000), arm(1000, 50, 3000, 1000))).toBe("profit");
    expect(offerTestMetric(arm(1000, 50, 3000, 1000), arm(1000, 50, 3000, null))).toBe("revenue");
    expect(offerTestMetric(arm(1000, 0, 0, null), arm(1000, 0, 0, null))).toBe("revenue");
  });

  it("promotes the arm that earns more margin even when it brings less revenue", () => {
    // A: 3000 HT, cost 2500 → 500 margin; B: 2600 HT, cost 1000 → 1600 margin, same take rate.
    const a = arm(2000, 200, 3000, 2500, 90);
    const b = arm(2000, 200, 2600, 1000, 78);
    const t = offerTestResult("o", a, b, 50, 20);
    expect(t.metric).toBe("profit");
    expect(t.b.revenuePerImpressionHtCents).toBeLessThan(t.a.revenuePerImpressionHtCents);
    expect(t.b.profitPerImpressionCents!).toBeGreaterThan(t.a.profitPerImpressionCents!);
    expect(t.lift).toBeGreaterThan(0);
    expect(t.decision).toMatchObject({ kind: "winner", winner: "B", metric: "profit" });
  });

  it("falls back to revenue (and says why) when a take has no cost", () => {
    const t = offerTestResult("o", arm(2000, 200, 3000, null), arm(2000, 200, 2600, 1000), 50, 20);
    expect(t.metric).toBe("revenue");
    expect(t.uncostedTakes).toBe(200);
    expect(t.a.profitPerImpressionCents).toBeNull();
    expect(t.lift).toBeLessThan(0);
    expect(t.decision).toMatchObject({ metric: "revenue" });
  });

  it("carries the margin moments into the variant stats", () => {
    const s = armStats("A", arm(10, 2, 1000, 400));
    expect(s.ppv).toBe(120);
    expect(s.profitCents).toBe(1200);
  });
});

describe("heatmap best slots", () => {
  it("ranks by the Wilson lower bound and ignores slots under 30 checkouts", () => {
    expect(BEST_SLOT_MIN_CHECKOUTS).toBe(30);
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(10, 100)).toBeCloseTo(0.0552, 3);
    const cells = [
      { dow: 1, hour: 10, sessions: 3, orders: 2, revenueHtCents: 9000 }, // 67 % on 3: too few
      { dow: 2, hour: 11, sessions: 40, orders: 8, revenueHtCents: 30000 }, // 20 % on 40
      { dow: 3, hour: 12, sessions: 400, orders: 72, revenueHtCents: 200000 }, // 18 % on 400: surer
    ];
    const best = bestSlots(cells, "conversion");
    expect(best.map((b) => `${b.cell.dow}-${b.cell.hour}`)).toEqual(["3-12", "2-11"]);
    expect(best[0].score).toBeGreaterThan(best[1].score);
    expect(bestSlots(cells, "revenue").map((b) => b.cell.dow)).toEqual([3, 2]);
  });
});

describe("geo headers", () => {
  it("reads Vercel, Cloudflare, CloudFront and x-country-code, skipping non-countries", () => {
    expect(geoCountryOf(new Headers({ "cf-ipcountry": "de" }))).toBe("DE");
    expect(geoCountryOf(new Headers({ "cloudfront-viewer-country": "ES" }))).toBe("ES");
    expect(geoCountryOf(new Headers({ "x-country-code": "it" }))).toBe("IT");
    expect(geoCountryOf(new Headers({ "x-vercel-ip-country": "XX", "cf-ipcountry": "BE" }))).toBe("BE");
    expect(geoCountryOf(new Headers({ "cf-ipcountry": "T1" }))).toBeNull();
    expect(geoCountryOf(new Headers({ "x-vercel-ip-country": "FR", "cf-ipcountry": "BE" }))).toBe("FR");
  });
});

describe("Google Ads spend (API)", () => {
  it("builds GAQL per level and normalizes customer ids", () => {
    expect(googleAdsQuery("campaign", "2026-09-01", "2026-09-07")).toBe(
      "SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.conversions, metrics.conversions_value, segments.date, customer.currency_code FROM campaign WHERE segments.date BETWEEN '2026-09-01' AND '2026-09-07' AND metrics.cost_micros > 0",
    );
    expect(googleAdsQuery("adset", "a", "b")).toContain("FROM ad_group ");
    expect(googleAdsQuery("ad", "a", "b")).toContain("ad_group_ad.ad.id");
    expect(googleCustomerId("123-456-7890")).toBe("1234567890");
    expect(googleCustomerId("12345")).toBeNull();
  });

  it("parses searchStream batches (micros → cents, account currency, prefixes)", () => {
    const body = [
      { results: [{ campaign: { id: "11", name: "Search FR" }, metrics: { costMicros: "12345678" }, segments: { date: "2026-09-01" }, customer: { currencyCode: "USD" } }] },
      { results: [{ campaign: { id: "12", name: "PMax" }, metrics: { costMicros: 5000000 }, segments: { date: "2026-09-02" } }] },
    ];
    expect(parseGoogleAdsStream(body, "campaign", "EUR")).toEqual([
      { day: "2026-09-01", campaignId: "11", campaignName: "Search FR", spendCents: 1235, currency: "USD" },
      { day: "2026-09-02", campaignId: "12", campaignName: "PMax", spendCents: 500, currency: "EUR" },
    ]);
    const ads = parseGoogleAdsStream([{ results: [{ adGroupAd: { ad: { id: "9" } }, metrics: { costMicros: "1000000" }, segments: { date: "2026-09-01" } }] }], "ad", "EUR");
    expect(ads[0]).toMatchObject({ campaignId: "ad:9", campaignName: "Annonce 9", spendCents: 100 });
    expect(googleErrorMessage([{ error: { message: "The caller does not have permission", details: [{ errors: [{ message: "DEVELOPER_TOKEN_NOT_APPROVED" }] }] } }], 403)).toBe(
      "HTTP 403 : The caller does not have permission (DEVELOPER_TOKEN_NOT_APPROVED)",
    );
    expect(googleErrorMessage({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400)).toBe("HTTP 400 : Token has been expired or revoked.");
  });
});

describe("quantity-break formats", () => {
  const two = [line({ quantity: 2, unitPriceCents: 3000 })];
  const mixed = [line({ quantity: 2, unitPriceCents: 3000 }), line({ variantId: "gid://shopify/ProductVariant/2", productId: "gid://shopify/Product/2", quantity: 1, unitPriceCents: 1000 })];

  it("computes fixed amount off per unit and per bundle", () => {
    const perUnit: QuantityBreak = { kind: "amount", minQty: 2, percent: 0, amountCents: 500, per: "unit" };
    const perBundle: QuantityBreak = { kind: "amount", minQty: 2, percent: 0, amountCents: 500, per: "bundle" };
    expect(breakDiscountCents(perUnit, mixed)).toBe(1500);
    expect(breakDiscountCents(perBundle, mixed)).toBe(500);
    expect(breakDiscountCents(perBundle, [line({ quantity: 1 })])).toBe(0);
  });

  it("prices complete bundles (2 pour 49 €) and gives the cheapest units free (buy X get Y)", () => {
    const bundle: QuantityBreak = { kind: "price", minQty: 2, percent: 0, priceCents: 4900 };
    expect(breakDiscountCents(bundle, two)).toBe(1100);
    // 3 items: the two most expensive make the bundle, the 10 € one stays at its price.
    expect(breakDiscountCents(bundle, mixed)).toBe(1100);
    const bxgy: QuantityBreak = { kind: "bxgy", minQty: 2, percent: 0, freeQty: 1 };
    expect(tierThreshold(bxgy)).toBe(3);
    expect(breakDiscountCents(bxgy, mixed)).toBe(1000);
    expect(breakDiscountCents(bxgy, two)).toBe(0);
    const t = computeTotals({ lines: mixed, rate: null, discount: null, addOns: [], quantityBreaks: [bxgy] });
    expect([t.volumeDiscountCents, t.totalCents]).toEqual([1000, 6000]);
  });

  it("picks the best reached tier across formats and nudges toward a bigger one", () => {
    const tiers = parseQuantityBreaks([
      { minQty: 2, percent: 10 },
      { kind: "price", minQty: 3, priceCents: 6000 },
    ]);
    const r = quantityBreakForLines(tiers, two);
    expect(r.current).toMatchObject({ minQty: 2, percent: 10 });
    expect(r.next).toMatchObject({ kind: "price", minQty: 3 });
    expect(r.missing).toBe(1);
    // A bundle price above the items' own price saves nothing: never "reached".
    expect(quantityBreakForLines(parseQuantityBreaks([{ kind: "price", minQty: 2, priceCents: 9000 }]), two).current).toBeNull();
  });

  it("describes a tier for the checkout (2 pour 49 €) in every language", () => {
    expect(breakDeal({ kind: "price", minQty: 2, percent: 0, priceCents: 4900 })).toEqual({ kind: "price", minQty: 2, priceCents: 4900 });
    for (const L of Object.values(LABELS)) {
      expect(L.dealPrice(2, "49 €")).toContain("49 €");
      expect(L.dealBxgy(2, 1)).toMatch(/2/);
      expect(L.volumeNudgeDeal(1, "x")).toContain("x");
    }
    expect(LABELS.fr.dealPrice(2, "49,00 €")).toBe("2 pour 49,00 €");
    expect(LABELS.fr.dealAmountBundle("5,00 €", 2)).toBe("−5,00 € par lot de 2");
  });

  it("validates every format", () => {
    expect(validateQuantityTiers([{ kind: "amount", minQty: 2, amountCents: 500, per: "unit" }, { kind: "price", minQty: 3, priceCents: 6000 }]).ok).toBe(true);
    expect(validateQuantityTiers([{ kind: "amount", minQty: 2, amountCents: 0, per: "unit" }])).toMatchObject({ ok: false, error: expect.stringContaining("montant") });
    expect(validateQuantityTiers([{ kind: "price", minQty: 1, priceCents: 100 }])).toMatchObject({ ok: false });
    // Limits: up to 100 bought and 50 free (TIER_LIMITS); beyond, invalid.
    expect(validateQuantityTiers([{ kind: "bxgy", minQty: 2, freeQty: 20 }]).ok).toBe(true);
    expect(validateQuantityTiers([{ kind: "bxgy", minQty: 2, freeQty: 51 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ kind: "bxgy", minQty: 101, freeQty: 1 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ kind: "bxgy", minQty: 2, freeQty: 0 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ kind: "bxgy", minQty: 2, freeQty: 1 }, { minQty: 3, percent: 10 }])).toMatchObject({ ok: false, error: expect.stringContaining("3 articles") });
    expect(validateQuantityTiers([{ kind: "nope", minQty: 2 }]).ok).toBe(false);
  });
});

describe("Shopify discount codes", () => {
  const basic = (over: Record<string, unknown> = {}) => ({
    codeDiscountNodeByCode: {
      codeDiscount: {
        __typename: "DiscountCodeBasic",
        title: "Rentrée",
        status: "ACTIVE",
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: null,
        usageLimit: 100,
        asyncUsageCount: 3,
        appliesOncePerCustomer: true,
        context: { __typename: "DiscountBuyerSelectionAll" },
        minimumRequirement: { __typename: "DiscountMinimumSubtotal", greaterThanOrEqualToSubtotal: { amount: "40.0", currencyCode: "EUR" } },
        customerGets: {
          value: { __typename: "DiscountPercentage", percentage: 0.15 },
          items: { __typename: "DiscountProducts", products: { nodes: [{ id: "gid://shopify/Product/1" }] }, productVariants: { nodes: [] } },
        },
        ...over,
      },
    },
  });

  it("parses amount-off and free-shipping codes, refuses what it can't verify", () => {
    const d = parseCodeDiscount("RENTREE", basic(), "EUR");
    expect(d).toMatchObject({ type: "PERCENT", value: 15, minSubtotalCents: 4000, oncePerCustomer: true, usageCount: 3, scope: { productIds: ["gid://shopify/Product/1"] } });
    expect(parseCodeDiscount("rentree", basic({ codes: { nodes: [{ code: "Rentree" }] } }), "EUR")).toMatchObject({ code: "Rentree" });
    expect(parseCodeDiscount("X", { codeDiscountNodeByCode: null }, "EUR")).toBe("not_found");
    expect(parseCodeDiscount("X", basic({ context: { __typename: "DiscountCustomerSegments" } }), "EUR")).toBe("customer_restricted");
    // Buy X get Y is supported since round 10 (still refused when limited to some customers); app discounts aren't.
    expect(parseCodeDiscount("X", { codeDiscountNodeByCode: { codeDiscount: { __typename: "DiscountCodeBxgy" } } }, "EUR")).toBe("customer_restricted");
    expect(parseCodeDiscount("X", { codeDiscountNodeByCode: { codeDiscount: { __typename: "DiscountCodeApp", context: { __typename: "DiscountBuyerSelectionAll" } } } }, "EUR")).toBe("unsupported_type");
    const fixed = parseCodeDiscount("X", basic({ customerGets: { value: { __typename: "DiscountAmount", amount: { amount: "5.00", currencyCode: "EUR" }, appliesOnEachItem: true }, items: { __typename: "AllDiscountItems" } } }), "EUR");
    expect(fixed).toMatchObject({ type: "FIXED", value: 500, appliesOnEachItem: true, scope: null });
    const ship = parseCodeDiscount(
      "SHIP",
      { codeDiscountNodeByCode: { codeDiscount: { __typename: "DiscountCodeFreeShipping", title: "Port", status: "ACTIVE", startsAt: null, usageLimit: null, asyncUsageCount: 0, appliesOncePerCustomer: false, context: { __typename: "DiscountBuyerSelectionAll" }, minimumRequirement: null, destinationSelection: { __typename: "DiscountCountries", countries: ["FR", "BE"], includeRestOfWorld: false }, maximumShippingPrice: { amount: "8.00" } } } },
      "EUR",
    );
    expect(ship).toMatchObject({ type: "FREE_SHIPPING", countries: ["FR", "BE"], maxShippingCents: 800 });
  });

  it("applies scope, minimum, usage limit and dates to the cart", () => {
    const d = parseCodeDiscount("RENTREE", basic(), "EUR");
    if (typeof d === "string") throw new Error(d);
    const cart = [line({ quantity: 1, unitPriceCents: 5000 }), line({ productId: "gid://shopify/Product/2", variantId: "gid://shopify/ProductVariant/2", unitPriceCents: 5000 })];
    const ok = shopifyCodeAsDiscount(d, cart, new Map(), { country: "FR" });
    expect(ok.ok).toBe(true);
    // Only product 1 (half the cart) gets −15 %.
    const t = computeTotals({ lines: cart, rate: null, discount: ok.ok ? ok.discount : null, addOns: [] });
    expect([t.discountCents, t.codeDiscountCents]).toEqual([750, 750]);
    expect(shopifyCodeAsDiscount(d, [line({ unitPriceCents: 3000 })], new Map(), { country: "FR" })).toEqual({ ok: false, reason: "minimum" });
    // Used up (round 13: its own reason, "code épuisé" for the buyer).
    expect(shopifyCodeAsDiscount({ ...d, usageCount: 100 }, cart, new Map(), { country: "FR" })).toEqual({ ok: false, reason: "exhausted" });
    expect(shopifyCodeAsDiscount({ ...d, endsAt: new Date("2020-01-01") }, cart, new Map(), { country: "FR" })).toEqual({ ok: false, reason: "invalid" });
    // Collection scope, resolved from the products' collections.
    const byCollection = { ...d, scope: { productIds: [], variantIds: [], collectionIds: ["gid://shopify/Collection/9"] } };
    expect(eligibleLines(byCollection, cart, new Map([["gid://shopify/Product/2", ["gid://shopify/Collection/9"]]])).map((l) => l.productId)).toEqual(["gid://shopify/Product/2"]);
  });

  it("records a Shopify code as the order's discount code, the rest folded into the lines", () => {
    const base: PaidOrderInput = {
      sessionId: "s",
      currency: "EUR",
      email: "a@b.fr",
      acceptsMarketing: false,
      shippingAddress: null,
      lines: [line({ quantity: 2, unitPriceCents: 3000 })],
      addOns: [],
      discount: { code: "RENTREE", amountCents: 1500, freeShipping: false, nativeCodeCents: 900 },
      shipping: null,
      totalCents: 4500,
      whopPaymentId: "pay",
      test: true,
    };
    const order = buildOrderCreateInput(base);
    expect(order.discountCode).toEqual({ itemFixedDiscountCode: { code: "RENTREE", amountSet: { shopMoney: { amount: "9.00", currencyCode: "EUR" } } } });
    const items = order.lineItems as { quantity: number; priceSet: { shopMoney: { amount: string } } }[];
    const lines = items.reduce((s, i) => s + i.quantity * Math.round(Number(i.priceSet.shopMoney.amount) * 100), 0);
    // Lines carry only the 6 € of automatic / quantity discounts; Shopify takes the 9 € code: 60 − 6 − 9 = 45.
    expect(lines - 900).toBe(4500);
  });
});

describe("Shopify automatic cart discounts", () => {
  const cart = {
    token: "c1-abc?key=k",
    items: [
      { variant_id: 1, quantity: 2, line_level_discount_allocations: [{ amount: 600, discount_application: { type: "automatic", title: "Soldes" } }, { amount: 100, discount_application: { type: "discount_code", title: "CODE" } }] },
    ],
    cart_level_discount_applications: [{ type: "automatic", title: "Panier 50 €", total_allocated_amount: 200 }],
  };

  it("keeps only automatic allocations, and only for the exact same cart", () => {
    const found = automaticDiscountsOf(cart)!;
    expect(found).toMatchObject({ totalCents: 800, titles: ["Soldes", "Panier 50 €"], items: [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2 }] });
    expect(sameItems(found.items, [{ variantId: "gid://shopify/ProductVariant/1", quantity: 2 }])).toBe(true);
    // Per line too (round 12: product-scoped codes are computed on each line's remaining value).
    expect(automaticDiscountFor(found, [line({ quantity: 2 })])).toMatchObject({ cents: 800, titles: ["Soldes", "Panier 50 €"] });
    // The buyer changed the quantity: Shopify's computation no longer holds.
    expect(automaticDiscountFor(found, [line({ quantity: 3 })]).cents).toBe(0);
    expect(automaticDiscountsOf({ items: [{ variant_id: 1, quantity: 1 }] })).toBeNull();
    const t = computeTotals({ lines: [line({ quantity: 2 })], rate: null, discount: null, addOns: [], automaticDiscountCents: 800 });
    expect([t.automaticDiscountCents, t.discountCents, t.totalCents]).toEqual([800, 800, 5200]);
  });
});

describe("charging in the buyer's currency", () => {
  const rates = { date: "2026-09-25", rates: { EUR: 1, CHF: 0.9412, HUF: 395.1, USD: 1.1 } };
  const now = new Date("2026-09-27T10:00:00Z");

  it("converts at the ECB rate, rounding up, only for supported currencies with a fresh rate", () => {
    expect(roundCharge(5230.2, "CHF")).toBe(5231);
    expect(roundCharge(395100.4, "HUF")).toBe(395200);
    expect(chargePlanWith({ enabled: true, country: "CH", shopCurrency: "EUR", totalCents: 5564 }, rates, now)).toEqual({ currency: "CHF", totalCents: 5237, rate: 0.9412 });
    expect(chargePlanWith({ enabled: false, country: "CH", shopCurrency: "EUR", totalCents: 5564 }, rates, now)).toBeNull();
    expect(chargePlanWith({ enabled: true, country: "FR", shopCurrency: "EUR", totalCents: 5564 }, rates, now)).toBeNull();
    expect(chargePlanWith({ enabled: true, country: "CH", shopCurrency: "EUR", totalCents: 5564 }, rates, new Date("2026-10-05T10:00:00Z"))).toBeNull();
    expect(chargePlanWith({ enabled: true, country: "GB", shopCurrency: "EUR", totalCents: 5564 }, rates, now)).toBeNull(); // no GBP rate
  });

  it("brings Whop amounts back to the shop currency (refunds, fees)", () => {
    expect(toShopCents(5237, 0.9412)).toBe(5564);
    expect(toChargeCents(1000, 0.9412)).toBe(941);
    expect(refundAmountIn("EUR", { amount: 23.54, currency: "chf" }, { currency: "CHF", rate: 0.9412 })).toBe(2501);
    expect(refundAmountIn("EUR", { amount: 23.54, currency: "chf" })).toBeNull();
    expect(refundAmountIn("EUR", { amount: 10, currency: "eur" }, { currency: "CHF", rate: 0.9412 })).toBe(1000);
  });

  it("states in every language that the amount is informative, or the exact charge", () => {
    expect(LABELS.fr.localEstimate("52,30 CHF", "EUR")).toBe("Vous serez débité en EUR ; montant indicatif ≈ 52,30 CHF (taux BCE, le montant final dépend de votre banque)");
    for (const L of Object.values(LABELS)) {
      expect(L.localEstimate("52,30 CHF", "EUR")).toMatch(/EUR.*52,30 CHF/);
      expect(L.chargedIn("CHF 52.37", "EUR")).toContain("CHF 52.37");
    }
  });
});

describe("returning-buyer codes and buyer claims (pure parts)", () => {
  it("binds the code hash to the checkout and the e-mail", () => {
    const h = hashLoginCode("s1", "A@B.fr ", "123456", "secret");
    expect(h).toBe(hashLoginCode("s1", "a@b.fr", "123456", "secret"));
    expect(h).not.toBe(hashLoginCode("s2", "a@b.fr", "123456", "secret"));
    expect(h).not.toBe(hashLoginCode("s1", "a@b.fr", "123457", "secret"));
    expect(h).not.toContain("123456");
  });

  it("validates a buyer report and its 30-day window", () => {
    expect(checkBuyerClaim({ email: "a@b.fr", reason: "damaged", details: " cassé ", photoUrl: "https://img.example.com/p.jpg" })).toEqual({
      reason: "damaged",
      details: "cassé",
      photoUrl: "https://img.example.com/p.jpg",
    });
    expect(checkBuyerClaim({ email: "a@b.fr", reason: "damaged", photoUrl: "javascript:alert(1)" })).toBeNull();
    expect(checkBuyerClaim({ email: "a@b.fr", reason: "refund-me" })).toBeNull();
    const now = new Date("2026-09-28T00:00:00Z");
    expect(claimWindowOpen(new Date(now.getTime() - (CLAIM_WINDOW_DAYS - 1) * 86_400_000), true, now)).toBe(true);
    expect(claimWindowOpen(new Date(now.getTime() - (CLAIM_WINDOW_DAYS + 1) * 86_400_000), true, now)).toBe(false);
    expect(claimWindowOpen(now, false, now)).toBe(false);
    for (const L of Object.values(LABELS)) expect(L.claimCta.length).toBeGreaterThan(5);
  });
});

describe("offer targeting v2 and automatic product", () => {
  const block = (conditions: Record<string, unknown>) => ({ props: { excludePurchased: false, conditions: { productIds: [], countries: [], ...conditions } } }) as unknown as UpsellBlock;
  const ctx: UpsellContext = { subtotalCents: 5000, productIds: ["gid://shopify/Product/1"], variantIds: ["gid://shopify/ProductVariant/11"], country: "FR", units: 2 };

  it("checks variants, collections, new vs returning and units (unknown = not shown)", () => {
    expect(upsellConditionsMet(block({ variantIds: ["11"] }), ctx)).toBe(true);
    expect(upsellConditionsMet(block({ variantIds: ["12"] }), ctx)).toBe(false);
    expect(upsellConditionsMet(block({ collectionIds: ["gid://shopify/Collection/5"] }), ctx)).toBe(false);
    expect(upsellConditionsMet(block({ collectionIds: ["gid://shopify/Collection/5"] }), { ...ctx, collectionIds: ["gid://shopify/Collection/5"] })).toBe(true);
    expect(upsellConditionsMet(block({ customer: "new" }), ctx)).toBe(false);
    expect(upsellConditionsMet(block({ customer: "new" }), { ...ctx, returning: false })).toBe(true);
    expect(upsellConditionsMet(block({ customer: "returning" }), { ...ctx, returning: true })).toBe(true);
    expect(upsellConditionsMet(block({ minUnits: 3 }), ctx)).toBe(false);
    expect(upsellConditionsMet(block({ maxUnits: 2 }), ctx)).toBe(true);
  });

  it("an automatic offer is sellable at a percent and takes the picked product", () => {
    expect(upsellSellable({ variantId: "", price: 0, priceMode: "percent", discountPercent: 20, productSource: "auto" })).toBe(true);
    expect(upsellSellable({ variantId: "", price: 10, priceMode: "fixed", productSource: "auto" })).toBe(false);
    const b = withAutoProduct({ id: "u", props: { title: "", imageUrl: "", variantId: "", productSource: "auto" } } as unknown as UpsellBlock, {
      productId: "gid://shopify/Product/2",
      variantId: "gid://shopify/ProductVariant/22",
      title: "Chaussettes",
      imageUrl: "https://cdn/x.jpg",
    });
    expect(b.props).toMatchObject({ variantId: "gid://shopify/ProductVariant/22", productId: "gid://shopify/Product/2", title: "Chaussettes", imageUrl: "https://cdn/x.jpg" });
  });
});

describe("GA4 in profit mode", () => {
  it("keeps value = revenue and sends the margin as the custom profit parameter", () => {
    const session = {
      id: "s1",
      currency: "EUR",
      totalCents: 5000,
      subtotalCents: 5000,
      paidAt: new Date("2026-09-01T10:00:00Z"),
      createdAt: new Date("2026-09-01T09:00:00Z"),
      lines: [line({ unitPriceCents: 5000, unitCostCents: 1500 })],
      tracking: { ga: "123.456" },
      visitorId: null,
      whopFeeCents: 150,
      shippingAddress: { countryCode: "FR" },
      store: { conversionValueMode: "profit", vatExempt: false, vatDomesticOnly: false, fulfillmentFeeCents: 0 },
    } as unknown as CheckoutSession & { store: Store };
    const e = sessionEvent(session, "purchase", { shipCostCents: 0, bumpCostCents: 0, feeCents: 150, feeRate: 0.03 });
    expect(e.revenueCents).toBe(5000);
    expect(e.valueCents).toBe(e.profitCents);
    const params = ga4Payload(session, e).events[0].params as Record<string, unknown>;
    expect(params.value).toBe(50);
    expect(params.profit).toBe(e.profitCents! / 100);
  });
});
