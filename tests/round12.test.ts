import { describe, expect, it } from "vitest";
import { encodeUnder, isHeic, MAX_PHOTO_UPLOAD_BYTES, MAX_PHOTOS_TOTAL_BYTES, photosProblem } from "@/components/checkout/ProtectionClaimForm";
import { LABELS } from "@/components/checkout/i18n";
import { MAX_CLAIM_BODY_BYTES, photoDisposition, replacementItems, replacementOutcomeUncertain } from "@/lib/claims";
import { ShopifyError } from "@/lib/shopify";
import { DeadlineError } from "@/lib/deadline";
import { accountWideStatus, googleAdjustmentFor, googleConsent } from "@/lib/google-conversions";
import { conversionAdjustmentBody, GoogleApiError } from "@/lib/adspend-google";
import { chargeStep, whopRefundAmount } from "@/lib/charge";
import { computeTotals, type CartLine } from "@/lib/pricing";
import { shopifyCodeAsDiscount, type ShopifyCodeDiscount } from "@/lib/shopify-discounts";
import { overridesOf } from "@/lib/checkout-tests";
import { resolveVisitor, signVisitorId, verifyVisitorId } from "@/lib/visitor";
import { platformVsReal } from "@/lib/analytics";
import { formatDate, formatDateTime } from "@/components/dashboard/format";
import { formatDateTimeLong, formatWhen } from "@/components/dashboard/dates";

/* Round 12 (correctness): pure parts. The database parts are in tests/integration/round12.test.ts. */

const line = (o: Partial<CartLine> = {}): CartLine => ({
  variantId: "gid://shopify/ProductVariant/1",
  productId: "gid://shopify/Product/1",
  productHandle: "a",
  title: "A",
  variantTitle: null,
  sku: null,
  imageUrl: null,
  quantity: 1,
  unitPriceCents: 5000,
  compareAtCents: null,
  inventory: null,
  requiresShipping: true,
  ...o,
});

describe("claim photos under the 4.5 MB body limit", () => {
  it("re-encodes smaller until a photo fits 1.2 MB, else gives up", async () => {
    const tried: [number, number, number][] = [];
    // A 4000 × 3000 photo whose JPEG size follows its pixel count and quality.
    const encode = async (w: number, h: number, q: number) => {
      tried.push([w, h, q]);
      return { size: Math.round(w * h * q * 0.5) };
    };
    const out = await encodeUnder(MAX_PHOTO_UPLOAD_BYTES, 4000, 3000, encode);
    expect(out!.size).toBeLessThanOrEqual(MAX_PHOTO_UPLOAD_BYTES);
    expect(tried[0]).toEqual([2000, 1500, 0.85]);
    expect(tried.length).toBeGreaterThan(1);
    // Never fits: null (the form says "too large").
    expect(await encodeUnder(1000, 4000, 3000, async () => ({ size: 5000 }))).toBeNull();
    // A small photo keeps its size (never upscaled).
    const small: [number, number][] = [];
    await encodeUnder(MAX_PHOTO_UPLOAD_BYTES, 800, 600, async (w, h) => (small.push([w, h]), { size: 10 }));
    expect(small).toEqual([[800, 600]]);
  });

  it("an undecodable HEIC, a non-image or too much in all are refused with the right reason", () => {
    expect(isHeic({ name: "IMG_1.HEIC", type: "" })).toBe(true);
    expect(isHeic({ name: "x.jpg", type: "image/heif" })).toBe(true);
    expect(isHeic({ name: "x.jpg", type: "image/jpeg" })).toBe(false);
    const f = (size: number) => ({ size }) as File;
    expect(photosProblem([f(1_000_000), "heic"])).toBe("heic");
    expect(photosProblem(["type"])).toBe("type");
    expect(photosProblem([f(1_200_000), f(1_200_000), f(1_200_000)])).toBeNull();
    expect(photosProblem([f(MAX_PHOTOS_TOTAL_BYTES), f(1)])).toBe("size");
    // The client's total stays under the server's cap, itself under Vercel's 4.5 MB.
    expect(MAX_PHOTOS_TOTAL_BYTES).toBeLessThan(MAX_CLAIM_BODY_BYTES);
    expect(MAX_CLAIM_BODY_BYTES).toBeLessThan(4.5 * 1024 * 1024);
  });

  it("every checkout language explains HEIC and the offer currency", () => {
    for (const lang of ["fr", "en", "de", "es", "it", "nl"] as const) {
      const L = LABELS[lang];
      expect(L.claimPhotoHeic).toMatch(/HEIC/);
      expect(L.claimPhotoTooBig).not.toMatch(/5 M/);
      expect(L.upsellShopCurrency("EUR", "CHF")).toMatch(/EUR.*CHF/);
    }
  });

  it("HEIC photos are downloaded, other images shown inline", () => {
    expect(photoDisposition("abc123", "image/heic")).toBe('attachment; filename="photo-abc123.heic"');
    expect(photoDisposition("abc123", "image/heif")).toBe('attachment; filename="photo-abc123.heif"');
    expect(photoDisposition("abc123", "image/jpeg")).toBe("inline");
  });
});

describe("replacement orders", () => {
  it("contain the lines, product bumps and merged paid offers not refunded", () => {
    const items = replacementItems(
      [line({ quantity: 2, variantTitle: "M" }), line({ variantId: "gid://shopify/ProductVariant/9", unitPriceCents: 0, gift: true, title: "Cadeau" })],
      [
        { id: "bump1", title: "Chaussettes", priceCents: 500, variantId: "gid://shopify/ProductVariant/5" },
        { id: "shipping_protection", title: "Protection colis", priceCents: 300, variantId: null },
      ],
      [
        { id: "u1", title: "Casquette", variantId: "gid://shopify/ProductVariant/7", quantity: 2, amountCents: 2000, refundedCents: 0, status: "PAID", orderMode: "merged" },
        { id: "u2", title: "Sac", variantId: "gid://shopify/ProductVariant/8", quantity: 1, amountCents: 1500, refundedCents: 1500, status: "PAID", orderMode: "merged" },
        { id: "u3", title: "Gourde", variantId: "gid://shopify/ProductVariant/6", quantity: 1, amountCents: 900, refundedCents: 0, status: "PAID", orderMode: "separate" },
        { id: "u4", title: "Bob", variantId: "gid://shopify/ProductVariant/4", quantity: 1, amountCents: 900, refundedCents: 0, status: "DECLINED", orderMode: null },
      ],
    );
    expect(items.map((i) => [i.key, i.variantId, i.quantity, i.unitPriceCents])).toEqual([
      ["line:0", "gid://shopify/ProductVariant/1", 2, 5000],
      ["line:1", "gid://shopify/ProductVariant/9", 1, 0],
      ["addon:bump1", "gid://shopify/ProductVariant/5", 1, 500],
      ["offer:u1", "gid://shopify/ProductVariant/7", 2, 1000],
    ]);
    expect(items[0].title).toBe("A · M");
  });

  it("keep the lease only when orderCreate's outcome is unknown", () => {
    expect(replacementOutcomeUncertain(new ShopifyError("Shopify injoignable : timeout", true))).toBe(true);
    expect(replacementOutcomeUncertain(new ShopifyError("Shopify API 503", true))).toBe(true);
    expect(replacementOutcomeUncertain(new DOMException("aborted", "AbortError"))).toBe(true);
    expect(replacementOutcomeUncertain(new ShopifyError("Shopify API 422: bad"))).toBe(false);
    expect(replacementOutcomeUncertain(new DeadlineError("no time"))).toBe(false);
  });
});

describe("Google Ads conversions", () => {
  it("consent: the Meta / TikTok rule for the conversion and the hashed e-mail", () => {
    expect(googleConsent(false, null)).toEqual({ upload: true, email: true });
    expect(googleConsent(false, false)).toEqual({ upload: false, email: false });
    expect(googleConsent(true, null)).toEqual({ upload: false, email: false });
    expect(googleConsent(true, true)).toEqual({ upload: true, email: true });
  });

  it("an account-wide error is a 4xx other than 429", () => {
    expect(accountWideStatus(new GoogleApiError("HTTP 403 : denied", 403))).toBe(403);
    expect(accountWideStatus(new GoogleApiError("HTTP 429", 429))).toBeNull();
    expect(accountWideStatus(new GoogleApiError("HTTP 500", 500))).toBeNull();
    expect(accountWideStatus(new Error("Google Ads : UNPARSEABLE_GCLID"))).toBeNull();
  });

  it("adjustments: retraction on full refund or lost dispute, restatement on partial refund and offers", () => {
    const base = { totalCents: 10_000, subtotalCents: 10_000, refundedCents: 0, disputeStatus: null, googleAdsValueCents: 10_000, offers: [] };
    expect(googleAdjustmentFor(base)).toBeNull();
    expect(googleAdjustmentFor({ ...base, refundedCents: 10_000 })).toEqual({ type: "RETRACTION" });
    expect(googleAdjustmentFor({ ...base, disputeStatus: "lost" })).toEqual({ type: "RETRACTION" });
    expect(googleAdjustmentFor({ ...base, refundedCents: 2500 })).toEqual({ type: "RESTATEMENT", valueCents: 7500 });
    const offers = [
      { status: "PAID", amountCents: 3000, refundedCents: 1000, disputeLostCents: 0 },
      { status: "DECLINED", amountCents: 9000, refundedCents: 0, disputeLostCents: 0 },
    ];
    expect(googleAdjustmentFor({ ...base, offers })).toEqual({ type: "RESTATEMENT", valueCents: 12_000 });
    // Already restated to that value: nothing to send (idempotent).
    expect(googleAdjustmentFor({ ...base, offers, googleAdsValueCents: 12_000 })).toBeNull();
    expect(conversionAdjustmentBody({ conversionAction: "customers/1/conversionActions/2", orderId: "s1", type: "RESTATEMENT", adjustmentDateTime: "2026-09-28 10:00:00+00:00", restatementValue: { adjustedValue: 75, currencyCode: "EUR" } })).toEqual({
      conversionAdjustments: [{ conversionAction: "customers/1/conversionActions/2", adjustmentType: "RESTATEMENT", adjustmentDateTime: "2026-09-28 10:00:00+00:00", orderId: "s1", restatementValue: { adjustedValue: 75, currencyCode: "EUR" } }],
      partialFailure: true,
    });
    const retraction = conversionAdjustmentBody({ conversionAction: "c", orderId: "s1", type: "RETRACTION", adjustmentDateTime: "t" });
    expect((retraction.conversionAdjustments as Record<string, unknown>[])[0].restatementValue).toBeUndefined();
  });
});

describe("partial refunds in whole-unit currencies", () => {
  it("HUF: a whole number of forints, below what is left", () => {
    expect(chargeStep("HUF")).toBe(100);
    expect(chargeStep("chf")).toBe(1);
    // 50,00 € charged 19 734 Ft (1 973 400 fillér) at 394.68; refund 12,34 € → 4 870,35 Ft → 4 870 Ft.
    const r = whopRefundAmount({ amountCents: 1234, totalCents: 5000, refundedCents: 0, chargeTotalCents: 1_973_400, refundedChargeCents: 0, rate: 394.68, currency: "HUF" });
    expect(r).toBe(487_000);
    expect(r! % 100).toBe(0);
    // Almost everything: 1 973 005 fillér → 19 730 Ft.
    expect(whopRefundAmount({ amountCents: 4999, totalCents: 5000, refundedCents: 0, chargeTotalCents: 1_973_400, refundedChargeCents: 0, rate: 394.68, currency: "HUF" })).toBe(1_973_000);
    // Rounded above what is left: clamped a whole forint below it (the rest button takes the rest).
    expect(whopRefundAmount({ amountCents: 4999, totalCents: 5000, refundedCents: 0, chargeTotalCents: 1_972_950, refundedChargeCents: 0, rate: 394.68, currency: "HUF" })).toBe(1_972_900);
    // A tiny amount: 0,01 € = 3,95 Ft → 4 Ft; and never 0 Ft.
    expect(whopRefundAmount({ amountCents: 1, totalCents: 5000, refundedCents: 0, chargeTotalCents: 1_973_400, refundedChargeCents: 0, rate: 394.68, currency: "HUF" })).toBe(400);
    expect(whopRefundAmount({ amountCents: 1, totalCents: 5000, refundedCents: 0, chargeTotalCents: 1_973_400, refundedChargeCents: 0, rate: 39.468, currency: "HUF" })).toBe(100);
    // Two-decimal currencies are unchanged.
    expect(whopRefundAmount({ amountCents: 4999, totalCents: 5000, refundedCents: 0, chargeTotalCents: 4751, refundedChargeCents: 0, rate: 0.9501, currency: "CHF" })).toBe(4750);
  });
});

describe("product-scoped Shopify codes", () => {
  it("20 % on product A after a 10 % break on product B: 10,00 € (not 9,50 €)", () => {
    const a = line({ variantId: "gid://shopify/ProductVariant/10", productId: "gid://shopify/Product/10" });
    const b = line({ variantId: "gid://shopify/ProductVariant/20", productId: "gid://shopify/Product/20" });
    const code: ShopifyCodeDiscount = {
      code: "A20",
      title: "A20",
      type: "PERCENT",
      value: 20,
      appliesOnEachItem: false,
      minSubtotalCents: null,
      minQuantity: null,
      startsAt: null,
      endsAt: null,
      usageLimit: null,
      usageCount: 0,
      active: true,
      oncePerCustomer: false,
      scope: { productIds: ["gid://shopify/Product/10"], variantIds: [], collectionIds: [] },
      countries: null,
      maxShippingCents: null,
      discountClass: "product",
      combinesWith: null,
    };
    const applied = shopifyCodeAsDiscount(code, [a, b], new Map(), { country: "FR" });
    expect(applied.ok).toBe(true);
    const discount = applied.ok ? applied.discount : null;
    const totals = computeTotals({ lines: [a, b], rate: null, discount, addOns: [], quantityBreaks: [{ minQty: 1, percent: 10, productIds: ["gid://shopify/Product/20"] }] });
    expect(totals.volumeDiscountCents).toBe(500);
    expect(totals.codeDiscountCents).toBe(1000);
    // Shopify's automatic discount allocated to B only (per line): A's value is intact too.
    const auto = computeTotals({ lines: [a, b], rate: null, discount, addOns: [], automaticDiscountCents: 500, automaticLineCents: { "gid://shopify/ProductVariant/20": 500 } });
    expect(auto.codeDiscountCents).toBe(1000);
    // Without a per-line split, the automatic discount is spread by value: A keeps 47,50 €.
    const spread = computeTotals({ lines: [a, b], rate: null, discount, addOns: [], automaticDiscountCents: 500 });
    expect(spread.codeDiscountCents).toBe(950);
  });
});

describe("checkout tests: arm A frozen", () => {
  it("arm A gets the settings of the test's start, arm B its own", () => {
    const t = { kind: "addon", targetId: "bump", configB: { priceCents: 900 }, configA: { priceCents: 500, hidden: false } };
    expect(overridesOf([{ ...t, arm: "A" }]).addOns.get("bump")).toEqual({ priceCents: 500, hidden: false });
    expect(overridesOf([{ ...t, arm: "B" }]).addOns.get("bump")).toEqual({ priceCents: 900 });
    expect(overridesOf([{ ...t }]).addOns.get("bump")).toEqual({ priceCents: 900 });
    const breaks = { kind: "breaks", targetId: null, configB: [{ minQty: 3, percent: 15 }], configA: [{ minQty: 2, percent: 10 }] };
    expect(overridesOf([{ ...breaks, arm: "A" }]).breaks).toEqual([{ minQty: 2, percent: 10 }]);
    // An older test without a snapshot: arm A follows the store.
    expect(overridesOf([{ ...breaks, configA: null, arm: "A" }]).breaks).toBeUndefined();
  });
});

describe("signed visitor ids", () => {
  it("only a server-signed id is kept; anything else gets a new one", () => {
    const token = signVisitorId("abcdef0123456789abcdef01", "k");
    expect(verifyVisitorId(token, "k")).toBe("abcdef0123456789abcdef01");
    expect(verifyVisitorId(token, "other")).toBeNull();
    expect(verifyVisitorId("abcdef0123456789abcdef01", "k")).toBeNull();
    expect(verifyVisitorId(`zzzzzz0123456789abcdef01.${token.split(".")[1]}`, "k")).toBeNull();
    expect(resolveVisitor(token, "k")).toEqual({ id: "abcdef0123456789abcdef01", token, issued: false });
    const fresh = resolveVisitor("chosen-by-the-browser", "k");
    expect(fresh.issued).toBe(true);
    expect(fresh.id).not.toBe("chosen-by-the-browser");
    expect(verifyVisitorId(fresh.token, "k")).toBe(fresh.id);
  });
});

describe("platform vs real ROAS, HT", () => {
  it("both ROAS HT, the platform's TTC value at the orders' HT ratio", () => {
    const rows = [{ source: "facebook", campaign: "Promo", orders: 2, revenueCents: 12_000, revenueHtCents: 10_000 }];
    const [p] = platformVsReal(rows, [{ platform: "meta", campaignId: "1", campaignName: "Promo", spendCents: 5000, platformConversions: 5, platformValueCents: 30_000 }], () => 0, 0.5);
    expect(p).toMatchObject({ realRevenueHtCents: 10_000, platformValueHtCents: 25_000, realRoas: 2, platformRoas: 5, overAttribution: 2.5 });
    // Not matched: the period's ratio.
    const [q] = platformVsReal(rows, [{ platform: "meta", campaignId: "9", campaignName: "Ghost", spendCents: 1000, platformConversions: 1, platformValueCents: 4000 }], () => -1, 0.8);
    expect(q).toMatchObject({ platformValueHtCents: 3200, platformRoas: 3.2, realRoas: 0, overAttribution: Infinity });
  });
});

describe("dashboard dates in the store's time zone", () => {
  it("formats in the zone given, Paris by default", () => {
    const d = new Date("2026-09-28T22:30:00Z");
    expect(formatDate(d)).toBe("29/09/2026");
    expect(formatDate(d, "America/New_York")).toBe("28/09/2026");
    expect(formatDateTime(d, false, "America/New_York")).toBe("28/09/2026 18:30");
    expect(formatDateTimeLong(d, "Asia/Tokyo")).toBe("29 sept. 2026, 07:30");
    expect(formatDateTimeLong(d)).toBe("29 sept. 2026, 00:30");
    expect(formatWhen(d, new Date("2026-09-28T23:00:00Z"), "America/New_York")).toBe("18:30");
  });
});
