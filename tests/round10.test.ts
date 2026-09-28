import { describe, expect, it } from "vitest";
import {
  COMBINES_ALL,
  canCombine,
  codeClass,
  combinableSets,
  computeTotals,
  unsupportedCart,
  type CartLine,
  type DiscountInput,
  type StackPart,
} from "@/lib/pricing";
import {
  AUTOMATIC_QUERY,
  CODE_QUERY,
  bxgyDiscountCents,
  parseAutomaticStack,
  parseCodeDiscount,
  shopifyCodeAsDiscount,
  type ShopifyCodeDiscount,
} from "@/lib/shopify-discounts";
import { DEFAULT_TZ, TIME_ZONES, tzOf, validTimeZone, zonedDay, zonedDayStart, zonedHour } from "@/lib/time";
import { geoCoverageOf, parisDayStart, platformVsReal, resolveRange, TOUCH_KEYS } from "@/lib/analytics";
import { metaPurchase, parseMetaInsights, parseTiktokReport } from "@/lib/adspend";
import { clickConversionBody, conversionActionName, googleAdsQuery, googleDateTime, parseGoogleAdsStream } from "@/lib/adspend-google";
import { googleClickOf, googleConsent, hashEmailForGoogle } from "@/lib/google-conversions";
import { checkClaimPhotos, checkPhotoToken, decisionEmail, photoToken, replacementOrderInput, sniffImage } from "@/lib/claims";
import { armOf, checkTestConfig, overridesOf, withAddOnOverrides, withProtectionOverride } from "@/lib/checkout-tests";
import { senderAs } from "@/lib/notify";

/* Round 10 (product): pure parts. Integration counterparts: tests/integration/round10.test.ts. */

const line = (o: Partial<CartLine> = {}): CartLine => ({
  variantId: "gid://shopify/ProductVariant/11",
  productId: "gid://shopify/Product/1",
  productHandle: "sweat",
  title: "Sweat",
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
const code = (o: Partial<DiscountInput> = {}): DiscountInput => ({
  code: "C",
  type: "PERCENT",
  value: 10,
  minSubtotalCents: null,
  startsAt: null,
  endsAt: null,
  usageLimit: null,
  usageCount: 0,
  active: true,
  ...o,
});
const rate = { id: "r", name: "Colissimo", deliveryTime: null, countries: [], priceCents: 600, freeOverCents: null, active: true };
const breaks = [{ minQty: 2, percent: 20 }];

describe("discount stacking (Shopify combinesWith)", () => {
  it("combines two discounts only when each allows the other's class", () => {
    const product: StackPart = { key: "breaks", cls: "product", combinesWith: COMBINES_ALL };
    const order: StackPart = { key: "code", cls: "order", combinesWith: { product: false, order: true, shipping: true } };
    expect(canCombine(product, order)).toBe(false);
    expect(canCombine(product, { ...order, combinesWith: COMBINES_ALL })).toBe(true);
    // Store setting / app code setting override against the breaks or codes only.
    expect(canCombine({ ...product, withCodes: false }, { ...order, combinesWith: COMBINES_ALL })).toBe(false);
    expect(canCombine({ key: "automatic", cls: "product", combinesWith: COMBINES_ALL }, { ...order, combinesWith: COMBINES_ALL, withBreaks: false })).toBe(true);
    expect(combinableSets([product, order]).map((s) => s.map((p) => p.key).join("+"))).toEqual(["", "breaks", "code"]);
    expect(codeClass({ type: "FREE_SHIPPING" })).toBe("shipping");
    expect(codeClass({ type: "PERCENT", discountClass: "product" })).toBe("product");
  });

  it("stacks by default, and keeps the best combination for the buyer when they don't combine", () => {
    const lines = [line({ quantity: 2 })]; // 100 €, break −20 % = 20 €
    const stacked = computeTotals({ lines, rate, discount: code(), addOns: [], quantityBreaks: breaks });
    expect([stacked.volumeDiscountCents, stacked.codeDiscountCents, stacked.dropped]).toEqual([2000, 800, undefined]);
    // App code "non cumulable": −10 % (10 €) loses to the break (20 €): the code is dropped.
    const appCode = computeTotals({ lines, rate, discount: code({ combinesWithBreaks: false }), addOns: [], quantityBreaks: breaks });
    expect([appCode.discountCents, appCode.dropped]).toEqual([2000, ["code"]]);
    // A bigger code wins over the break.
    const big = computeTotals({ lines, rate, discount: code({ value: 30, combinesWithBreaks: false }), addOns: [], quantityBreaks: breaks });
    expect([big.discountCents, big.volumeDiscountCents, big.dropped]).toEqual([3000, 0, ["breaks"]]);
    // Store setting: breaks never stack with codes.
    const store = computeTotals({ lines, rate, discount: code(), addOns: [], quantityBreaks: breaks, breaksCombineWithCodes: false });
    expect(store.dropped).toEqual(["code"]);
    // Shopify code whose combinesWith refuses product discounts.
    const shopify = computeTotals({ lines, rate, discount: code({ combinesWith: { product: false, order: true, shipping: true } }), addOns: [], quantityBreaks: breaks });
    expect(shopify.dropped).toEqual(["code"]);
  });

  it("counts free shipping as the saving of a shipping code, and honors automatic discounts' rules", () => {
    const lines = [line({ quantity: 2 })];
    const free = code({ type: "FREE_SHIPPING", value: 0, combinesWith: { product: false, order: true, shipping: true } });
    // Free shipping (6 €) vs the break (20 €): the break wins, shipping is paid.
    const t = computeTotals({ lines, rate, discount: free, addOns: [], quantityBreaks: breaks });
    expect([t.shippingCents, t.volumeDiscountCents, t.dropped]).toEqual([600, 2000, ["code"]]);
    // Automatic discount that doesn't combine with order discounts: code (10 € on 100 €) vs automatic (15 €).
    const auto = computeTotals({ lines, rate, discount: code(), addOns: [], automaticDiscountCents: 1500, automaticStack: { cls: "product", combinesWith: { product: true, order: false, shipping: true } } });
    expect([auto.automaticDiscountCents, auto.codeDiscountCents, auto.dropped]).toEqual([1500, undefined, ["code"]]);
    // Unknown rules (lookup failed): combine, as before.
    const unknown = computeTotals({ lines, rate, discount: code(), addOns: [], automaticDiscountCents: 1500 });
    expect(unknown.discountCents).toBe(1500 + Math.round(8500 * 0.1));
  });
});

describe("Shopify codes: combinesWith, class, buy X get Y", () => {
  const ctx = { __typename: "DiscountBuyerSelectionAll" };
  const base = { title: "T", status: "ACTIVE", asyncUsageCount: 0, appliesOncePerCustomer: false, context: ctx, codes: { nodes: [{ code: "B2G1" }] } };
  it("queries combinesWith on every code type and supports DiscountCodeBxgy", () => {
    expect(CODE_QUERY.match(/combinesWith \{ productDiscounts orderDiscounts shippingDiscounts \}/g)).toHaveLength(3);
    expect(CODE_QUERY).toContain("... on DiscountCodeBxgy");
    expect(CODE_QUERY).toContain("usesPerOrderLimit");
    expect(AUTOMATIC_QUERY).toContain("discountNodes(first: 10");
  });

  it("parses combinesWith and the class (order for all items, product for a selection)", () => {
    const order = parseCodeDiscount(
      "X",
      { codeDiscountNodeByCode: { codeDiscount: { __typename: "DiscountCodeBasic", ...base, combinesWith: { productDiscounts: false, orderDiscounts: true, shippingDiscounts: true }, customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 }, items: { __typename: "AllDiscountItems" } } } } },
      "EUR",
    ) as ShopifyCodeDiscount;
    expect([order.discountClass, order.combinesWith]).toEqual(["order", { product: false, order: true, shipping: true }]);
    const product = parseCodeDiscount(
      "X",
      { codeDiscountNodeByCode: { codeDiscount: { __typename: "DiscountCodeBasic", ...base, customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 }, items: { __typename: "DiscountProducts", products: { nodes: [{ id: "gid://shopify/Product/1" }] }, productVariants: { nodes: [] } } } } } },
      "EUR",
    ) as ShopifyCodeDiscount;
    expect([product.discountClass, product.combinesWith]).toEqual(["product", null]);
  });

  const bxgyData = (o: Record<string, unknown> = {}) => ({
    codeDiscountNodeByCode: {
      codeDiscount: {
        __typename: "DiscountCodeBxgy",
        ...base,
        usesPerOrderLimit: null,
        combinesWith: { productDiscounts: false, orderDiscounts: true, shippingDiscounts: true },
        customerBuys: { value: { __typename: "DiscountQuantity", quantity: "2" }, items: { __typename: "AllDiscountItems" } },
        customerGets: { value: { __typename: "DiscountOnQuantity", quantity: { quantity: "1" }, effect: { __typename: "DiscountPercentage", percentage: 1 } }, items: { __typename: "AllDiscountItems" } },
        ...o,
      },
    },
  });

  it("buy 2 get 1 free: the cheapest item is free, per group of 3, capped by uses per order", () => {
    const d = parseCodeDiscount("b2g1", bxgyData(), "EUR") as ShopifyCodeDiscount;
    expect([d.discountClass, d.bxgy?.buyQuantity, d.bxgy?.getQuantity, d.bxgy?.percent]).toEqual(["product", 2, 1, 100]);
    const lines = [line({ quantity: 2, unitPriceCents: 3000 }), line({ variantId: "gid://shopify/ProductVariant/12", quantity: 1, unitPriceCents: 1000 })];
    expect(bxgyDiscountCents(d.bxgy!, lines, new Map())).toBe(1000);
    // 6 items → 2 applications (the 2 cheapest free), unless the code allows one use per order.
    const six = [line({ quantity: 6, unitPriceCents: 2000 })];
    expect(bxgyDiscountCents(d.bxgy!, six, new Map())).toBe(4000);
    expect(bxgyDiscountCents({ ...d.bxgy!, usesPerOrderLimit: 1 }, six, new Map())).toBe(2000);
    // Two items: nothing to give yet → "minimum" (the buyer can add one).
    expect(shopifyCodeAsDiscount(d, [line({ quantity: 2 })], new Map(), { country: "FR" })).toEqual({ ok: false, reason: "minimum" });
    const applied = shopifyCodeAsDiscount(d, lines, new Map(), { country: "FR" });
    expect(applied.ok && [applied.discount.type, applied.discount.value, applied.discount.discountClass, applied.discount.combinesWith?.product]).toEqual(["FIXED", 1000, "product", false]);
  });

  it("buy X get Y on scoped items, amount effects and minimum purchase amounts", () => {
    const d = parseCodeDiscount(
      "x",
      bxgyData({
        customerBuys: { value: { __typename: "DiscountPurchaseAmount", amount: "50.0" }, items: { __typename: "DiscountProducts", products: { nodes: [{ id: "gid://shopify/Product/1" }] }, productVariants: { nodes: [] } } },
        customerGets: {
          value: { __typename: "DiscountOnQuantity", quantity: { quantity: "1" }, effect: { __typename: "DiscountAmount", amount: { amount: "5.00", currencyCode: "EUR" }, appliesOnEachItem: true } },
          items: { __typename: "DiscountProducts", products: { nodes: [{ id: "gid://shopify/Product/2" }] }, productVariants: { nodes: [] } },
        },
      }),
      "EUR",
    ) as ShopifyCodeDiscount;
    const gift = line({ variantId: "gid://shopify/ProductVariant/21", productId: "gid://shopify/Product/2", unitPriceCents: 1200 });
    expect(bxgyDiscountCents(d.bxgy!, [line({ unitPriceCents: 5000 }), gift], new Map())).toBe(500);
    expect(bxgyDiscountCents(d.bxgy!, [line({ unitPriceCents: 4000 }), gift], new Map())).toBe(0);
    expect(parseCodeDiscount("x", bxgyData({ customerGets: { value: { __typename: "DiscountOnQuantity", quantity: { quantity: "1" }, effect: { __typename: "DiscountAmount", amount: { amount: "5", currencyCode: "USD" } } } } }), "EUR")).toBe("currency");
  });

  it("merges the automatic discounts' combination rules found by title", () => {
    const data = {
      discountNodes: {
        nodes: [
          { discount: { __typename: "DiscountAutomaticBasic", title: "Soldes", combinesWith: { productDiscounts: true, orderDiscounts: false, shippingDiscounts: true }, customerGets: { items: { __typename: "DiscountProducts" } } } },
          { discount: { __typename: "DiscountAutomaticFreeShipping", title: "Autre", combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false } } },
        ],
      },
    };
    expect(parseAutomaticStack(data, ["soldes"])).toEqual({ cls: "product", combinesWith: { product: true, order: false, shipping: true } });
    expect(parseAutomaticStack(data, ["Inconnue"])).toBeNull();
    expect(parseAutomaticStack({ orders: {} }, ["Soldes"])).toBeNull();
  });
});

describe("subscriptions and gift cards stay on Shopify's checkout", () => {
  it("flags selling plans and gift cards", () => {
    expect(unsupportedCart([{ selling_plan: 123 }])).toBe("selling_plan");
    expect(unsupportedCart([{ gift_card: true }])).toBe("gift_card");
    expect(unsupportedCart([{ selling_plan: null, gift_card: false }, {}])).toBeNull();
  });
});

describe("store time zone", () => {
  it("computes days, hours and midnights in any IANA zone", () => {
    const at = new Date("2026-09-10T02:30:00Z");
    expect([zonedDay(at, "America/New_York"), zonedHour(at, "America/New_York")]).toEqual(["2026-09-09", 22]);
    expect([zonedDay(at), zonedHour(at)]).toEqual(["2026-09-10", 4]);
    expect(zonedDayStart("2026-09-09", "America/New_York").toISOString()).toBe("2026-09-09T04:00:00.000Z");
    // DST change day in New York (2026-11-01): midnight is still EDT.
    expect(zonedDayStart("2026-11-01", "America/New_York").toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(parisDayStart("2026-09-09").toISOString()).toBe("2026-09-08T22:00:00.000Z");
    const r = resolveRange({ range: "custom", from: "2026-09-01", to: "2026-09-02" }, "2026-09-10", "30d", "Asia/Tokyo");
    expect(r.since.toISOString()).toBe("2026-08-31T15:00:00.000Z");
    expect(r.until.toISOString()).toBe("2026-09-02T15:00:00.000Z");
  });
  it("validates zones and falls back to Paris", () => {
    expect(validTimeZone("America/New_York")).toBe(true);
    expect(validTimeZone("Mars/Olympus")).toBe(false);
    expect(validTimeZone("Europe/Paris'; DROP TABLE x;--")).toBe(false);
    expect(tzOf({ timezone: "Nope/Nope" })).toBe(DEFAULT_TZ);
    expect(tzOf(null)).toBe(DEFAULT_TZ);
    expect(TIME_ZONES.every(validTimeZone)).toBe(true);
  });
});

describe("analytics helpers", () => {
  it("geo coverage counts checkouts with an IP country", () => {
    expect(geoCoverageOf([{ group: "FR", sessions: 7 }, { group: "inconnu", sessions: 3 }])).toEqual({ sessions: 10, located: 7, share: 0.7 });
    expect(geoCoverageOf([])).toEqual({ sessions: 0, located: 0, share: 0 });
  });
  it("platform vs real ROAS and the over-attribution ratio", () => {
    const rows = [{ source: "facebook", campaign: "Promo", orders: 2, revenueCents: 10_000 }];
    const out = platformVsReal(
      rows,
      [
        { platform: "meta", campaignId: "1", campaignName: "Promo", spendCents: 5000, platformConversions: 5, platformValueCents: 25_000 },
        { platform: "meta", campaignId: "2", campaignName: "Ghost", spendCents: 1000, platformConversions: 1, platformValueCents: 4000 },
        { platform: "tiktok", campaignId: "3", campaignName: "None", spendCents: 1000 },
      ],
      (sp) => (sp.campaignName === "Promo" ? 0 : -1),
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ campaign: "Promo", platformRoas: 5, realRoas: 2, overAttribution: 2.5, realOrders: 2, matched: true });
    expect(out[1]).toMatchObject({ campaign: "Ghost", overAttribution: Infinity, matched: false });
  });
  it("keeps Google gbraid / wbraid and Microsoft msclkid click ids", () => {
    for (const k of ["gbraid", "wbraid", "msclkid"]) expect(TOUCH_KEYS.has(k)).toBe(true);
  });
});

describe("platform-reported conversions (import)", () => {
  it("Meta: omni purchases, their value and purchase ROAS", () => {
    const [r] = parseMetaInsights(
      {
        data: [
          {
            date_start: "2026-09-01",
            campaign_id: "1",
            campaign_name: "Promo",
            spend: "50.00",
            account_currency: "EUR",
            actions: [{ action_type: "link_click", value: "80" }, { action_type: "purchase", value: "4" }, { action_type: "omni_purchase", value: "5" }],
            action_values: [{ action_type: "omni_purchase", value: "250.5" }],
            purchase_roas: [{ action_type: "omni_purchase", value: "5.01" }],
          },
        ],
      },
      "EUR",
    );
    expect([r.conversions, r.conversionValueCents, r.platformRoas]).toEqual([5, 25050, 5.01]);
    expect(metaPurchase([{ action_type: "offsite_conversion.fb_pixel_purchase", value: "2" }])).toBe(2);
    expect(metaPurchase(undefined)).toBeNull();
  });
  it("TikTok complete payments and Google Ads conversions", () => {
    const { rows } = parseTiktokReport(
      { code: 0, data: { list: [{ dimensions: { campaign_id: "9", stat_time_day: "2026-09-01 00:00:00" }, metrics: { spend: "10", campaign_name: "TT", complete_payment: "3", total_complete_payment_rate: "90.00", complete_payment_roas: "9" } }] } },
      "EUR",
    );
    expect([rows[0].conversions, rows[0].conversionValueCents, rows[0].platformRoas]).toEqual([3, 9000, 9]);
    expect(googleAdsQuery("campaign", "2026-09-01", "2026-09-02")).toContain("metrics.conversions, metrics.conversions_value");
    const [g] = parseGoogleAdsStream([{ results: [{ campaign: { id: "5", name: "G" }, metrics: { costMicros: "12000000", conversions: 2.5, conversionsValue: 120.4 }, segments: { date: "2026-09-01" } }] }], "campaign", "EUR");
    expect([g.spendCents, g.conversions, g.conversionValueCents]).toEqual([1200, 2.5, 12040]);
  });
});

describe("Google Ads offline conversions", () => {
  it("builds the ClickConversion upload with one click id, the order id and the hashed e-mail", () => {
    expect(conversionActionName("987", "123-456-7890")).toBe("customers/1234567890/conversionActions/987");
    expect(conversionActionName("customers/1234567890/conversionActions/5", null)).toBe("customers/1234567890/conversionActions/5");
    expect(conversionActionName("abc", "1234567890")).toBeNull();
    expect(googleDateTime(new Date("2026-09-10T08:05:03.123Z"))).toBe("2026-09-10 08:05:03+00:00");
    const body = clickConversionBody({ conversionAction: "customers/1/conversionActions/2", gclid: "g", wbraid: "w", conversionDateTime: "x", conversionValue: 49.9, currencyCode: "EUR", orderId: "s1", hashedEmail: "h" });
    const conv = (body.conversions as Record<string, unknown>[])[0];
    expect(conv).toMatchObject({ gclid: "g", orderId: "s1", conversionValue: 49.9, userIdentifiers: [{ hashedEmail: "h" }] });
    expect(conv.wbraid).toBeUndefined();
    expect(body.partialFailure).toBe(true);
  });
  it("finds the click id, respects consent, hashes like Google", () => {
    expect(googleClickOf({ utm_source: "x" }, { gbraid: "abcdefghijk" })).toEqual({ gclid: undefined, gbraid: "abcdefghijk", wbraid: undefined });
    expect(googleClickOf({ gclid: "short" })).toBeNull();
    expect(googleConsent(true, null)).toEqual({ upload: false, email: false });
    // Round 12: the Meta / TikTok rule — a refusal stops the conversion too, not only the e-mail.
    expect(googleConsent(false, false)).toEqual({ upload: false, email: false });
    expect(googleConsent(true, true)).toEqual({ upload: true, email: true });
    expect(googleConsent(false, null)).toEqual({ upload: true, email: true });
    expect(hashEmailForGoogle(" Jo.Hn@GMail.com ")).toBe(hashEmailForGoogle("john@gmail.com"));
    expect(hashEmailForGoogle("a@b.fr")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("protection claims: photos, replacement order, decision e-mail", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
  it("checks photos on their content, size and count", () => {
    expect(sniffImage(png)).toBe("image/png");
    expect(sniffImage(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    expect(checkClaimPhotos([{ type: "image/png", data: png }, { type: "image/jpeg", data: jpg }])).toMatchObject({ ok: true });
    expect(checkClaimPhotos([{ type: "image/jpeg", data: png }])).toEqual({ ok: false, error: "photo_type" });
    expect(checkClaimPhotos([{ type: "image/svg+xml", data: Buffer.from("<svg/>") }])).toEqual({ ok: false, error: "photo_type" });
    expect(checkClaimPhotos([{ type: "image/png", data: Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]) }])).toEqual({ ok: false, error: "photo_size" });
    expect(checkClaimPhotos(Array.from({ length: 4 }, () => ({ type: "image/png", data: png })))).toEqual({ ok: false, error: "photo_count" });
  });
  it("signs buyer photo links (expiring, bound to the photo)", () => {
    const now = Date.now();
    const e = now + 3600_000;
    const t = photoToken("photo1", e);
    expect(checkPhotoToken("photo1", String(e), t, now)).toBe(true);
    expect(checkPhotoToken("photo2", String(e), t, now)).toBe(false);
    expect(checkPhotoToken("photo1", String(e), t, e + 1)).toBe(false);
    expect(checkPhotoToken("photo1", String(e), null, now)).toBe(false);
  });
  it("builds a 0 € replacement order, tagged and linked to the claim", () => {
    const o = replacementOrderInput({ claimId: "c1", currency: "EUR", email: "a@b.fr", address: null, lines: [line({ quantity: 2 })], originalName: "#1001", test: false });
    expect(o.discountCode).toEqual({ itemPercentageDiscountCode: { code: "REMPLACEMENT", percentage: 100 } });
    expect(o.tags).toEqual(expect.arrayContaining(["remplacement", "sinistre-c1"]));
    expect(o.sourceIdentifier).toBe("claim:c1");
    expect((o.lineItems as { quantity: number }[])[0].quantity).toBe(2);
  });
  it("writes the decision e-mail in the buyer's language", () => {
    const en = decisionEmail("en", { status: "approved", kind: "reship", order: "#1001", shop: "Shop", replacement: "#1002" });
    expect(en.subject).toBe("Your report for order #1001");
    expect(en.text).toContain("replacement order #1002");
    const de = decisionEmail("de-DE", { status: "rejected", kind: "reship", order: "#1", shop: "S", note: "Zugestellt" });
    expect(de.text).toContain("Nachricht des Shops : Zugestellt");
    expect(decisionEmail(null, { status: "approved", kind: "refund", order: "#1", shop: "S", amount: "12,00 €" }).text).toContain("remboursé de 12,00 €");
  });
});

describe("checkout A/B tests (breaks, bump, protection)", () => {
  it("validates arm B settings", () => {
    expect(checkTestConfig("breaks", [{ minQty: 2, percent: 10 }])).toMatchObject({ ok: true });
    expect(checkTestConfig("breaks", [{ minQty: 2, percent: 90 }])).toMatchObject({ ok: false });
    expect(checkTestConfig("addon", { priceCents: 490 })).toMatchObject({ ok: true });
    expect(checkTestConfig("addon", {})).toMatchObject({ ok: false });
    expect(checkTestConfig("protection", { priceMode: "percent", price: 0, percent: 4, minPrice: 1, maxPrice: 0 })).toMatchObject({ ok: true });
    expect(checkTestConfig("other", {})).toMatchObject({ ok: false });
  });
  it("assigns arms stickily and applies arm B's overrides", () => {
    expect(armOf("visitor123456", "t1", 50)).toBe(armOf("visitor123456", "t1", 50));
    expect(armOf("visitor123456", "t1", 100)).toBe("B");
    expect(armOf("visitor123456", "t1", 0)).toBe("A");
    const o = overridesOf([
      { kind: "addon", targetId: "a1", configB: { priceCents: 490 } },
      { kind: "addon", targetId: "a2", configB: { hidden: true } },
      { kind: "breaks", targetId: null, configB: [{ minQty: 3, percent: 15 }] },
      { kind: "protection", targetId: null, configB: { priceMode: "fixed", price: 3.9, percent: 3, minPrice: 1, maxPrice: 0 } },
    ]);
    expect(withAddOnOverrides([{ id: "a1", priceCents: 990 }, { id: "a2", priceCents: 100 }, { id: "a3", priceCents: 5 }], o)).toEqual([{ id: "a1", priceCents: 490 }, { id: "a3", priceCents: 5 }]);
    expect(o.breaks).toEqual([{ minQty: 3, percent: 15 }]);
    expect(withProtectionOverride({ priceMode: "fixed" as const, price: 2.9, percent: 3, minPrice: 1.9, maxPrice: 0, title: "x" }, o)).toMatchObject({ price: 3.9, title: "x" });
  });
});

describe("operator-level Resend fallback", () => {
  it("sends in the store's name from the operator's address", () => {
    expect(senderAs("Boutiques <noreply@op.fr>", "Ma boutique")).toBe("Ma boutique <noreply@op.fr>");
    expect(senderAs("noreply@op.fr", 'Evil"<x>')).toBe("Evilx <noreply@op.fr>");
  });
});
