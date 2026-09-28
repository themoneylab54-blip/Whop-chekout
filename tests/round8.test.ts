import { afterEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { armStats, offerTestResult, offerTests, promoteArm, type ArmAggregate } from "@/lib/offer-tests";
import { adSpendVatFactor, dailyReportMessage, windowedTouch } from "@/lib/analytics";
import { cleanRecordI18n, localizeRate, recordText } from "@/components/checkout/localize";
import { giftI18nOf, giftTitle, parseGiftTiers, validateQuantityTiers } from "@/lib/pricing";
import { addVariantToOrder, findOfferLine, orderEditRefusal, offerMarker } from "@/lib/shopify";
import { alreadyRefunded, offerRefundMarker } from "@/lib/refunds";
import { checkClaim } from "@/lib/claims";
import { geoCountryOf } from "@/lib/geo";
import { encrypt } from "@/lib/crypto";
import { COUNTRY_CURRENCY } from "@/components/checkout/localCurrency";
import type { BlockOf } from "@/lib/layout";

/* Round 8 (product): offer A/B statistics and promotion, attribution window at query time,
 * translations of bumps / gifts / rates, merged offer orders, refunds on a shared order,
 * protection claims, geo-IP country, ad-spend VAT, daily report. */

/** Aggregate of `n` impressions with `takes` offers taken at `priceHt` each (0 otherwise). */
const agg = (n: number, takes: number, priceHt: number, firstAt: Date | null = null): ArmAggregate => ({
  impressions: n,
  takes,
  sumCents: takes * priceHt,
  sumSqCents: takes * priceHt * priceHt,
  firstAt,
});
const DAY = 86_400_000;

describe("offer A/B tests (design-test statistics per offer)", () => {
  it("uses impressions as visitors, take rate as conversion and CA HT per impression as the metric", () => {
    const s = armStats("A", agg(400, 40, 2000));
    expect([s.visitors, s.converted, s.cvr, s.rpv]).toEqual([400, 40, 0.1, 200]);
    // Bernoulli × price: variance = p(1−p)·price² (sample variance, n − 1).
    expect(s.rpvVar).toBeCloseTo((40 * 2000 ** 2 - 400 * 200 ** 2) / 399, 6);
  });

  it("waits for 7 days and the minimum sample, then names a significant winner", () => {
    const early = offerTestResult("o1", agg(1000, 50, 2000), agg(1000, 110, 2000), 50, 3);
    expect(early.decision).toEqual({ kind: "waiting", reason: "too_early" });
    const small = offerTestResult("o1", agg(100, 5, 2000), agg(100, 11, 2000), 50, 10);
    expect(small.decision).toEqual({ kind: "waiting", reason: "too_few_visitors" });
    expect(small.minSample).toBe(200);
    const win = offerTestResult("o1", agg(1000, 50, 2000), agg(1000, 110, 2000), 50, 15);
    expect(win.decision).toMatchObject({ kind: "winner", winner: "B" });
    expect(win.pValue).toBeLessThan(0.01);
    expect(win.lift).toBeCloseTo(1.2, 5);
    expect(win.ci![0]).toBeGreaterThan(0);
    expect(win.b.takeRate).toBeCloseTo(0.11);
    // Same take rate, same price: nothing to decide.
    const flat = offerTestResult("o1", agg(1000, 80, 2000), agg(1000, 82, 2000), 50, 20);
    expect(flat.decision.kind).toBe("inconclusive");
    expect(flat.remainingDays).not.toBeNull();
    // B sells more often but so much cheaper that it earns less per impression: A wins.
    const cheap = offerTestResult("o1", agg(2000, 100, 3000), agg(2000, 150, 1000), 50, 20);
    expect(cheap.decision).toMatchObject({ kind: "tradeoff", better: "A" });
    // A 90/10 split observed as 50/50: broken.
    expect(offerTestResult("o1", agg(500, 10, 2000), agg(500, 10, 2000), 10, 20).decision.kind).toBe("broken");
  });

  it("pairs each arm B with its arm A and dates the test from B's first impression", () => {
    const now = new Date("2026-09-28T12:00:00Z");
    const aggs = new Map([
      ["blk", agg(300, 30, 1500)],
      ["blk:B", agg(310, 40, 1500, new Date(now.getTime() - 9 * DAY))],
      ["solo", agg(100, 10, 1000)],
    ]);
    const tests = offerTests(aggs, new Map([["blk", 50]]), now);
    expect(tests).toHaveLength(1);
    expect(tests[0]).toMatchObject({ offerId: "blk", split: 50, a: { impressions: 300 }, b: { impressions: 310 } });
    expect(tests[0].ageDays).toBeCloseTo(9, 5);
  });

  it("promotes arm B into the offer (product, price, texts, translations) and switches the test off", () => {
    const block = {
      id: "u1",
      type: "upsell",
      hidden: false,
      props: {
        badge: "Offre",
        title: "Titre A",
        text: "Texte A",
        variantId: "gid://shopify/ProductVariant/1",
        productId: "gid://shopify/Product/1",
        imageUrl: "https://a/1.png",
        priceMode: "fixed",
        price: 19,
        discountPercent: 20,
        compareAt: 29,
        buttonText: "Oui",
        declineText: "Non",
        conditions: { productIds: [], countries: [] },
        excludePurchased: false,
        maxQuantity: 1,
        variantB: {
          enabled: true,
          split: 50,
          variantId: "gid://shopify/ProductVariant/2",
          productId: "gid://shopify/Product/2",
          imageUrl: "https://a/2.png",
          badge: "",
          title: "Titre B",
          text: "",
          buttonText: "",
          priceMode: "fixed",
          price: 24,
          discountPercent: 20,
          compareAt: 39,
          autoPromote: true,
        },
      },
      i18n: { en: { title: "Title A", text: "Text A", "variantB.title": "Title B" } },
    } as unknown as BlockOf<"upsell">;
    const b = promoteArm(block, "B");
    expect(b.props).toMatchObject({ variantId: "gid://shopify/ProductVariant/2", price: 24, compareAt: 39, title: "Titre B", text: "Texte A", badge: "Offre", imageUrl: "https://a/2.png" });
    expect(b.props.variantB).toMatchObject({ enabled: false, autoPromote: false });
    // B's own title translation becomes the offer's; A's text translation stays (B had no text).
    expect(b.i18n).toEqual({ en: { title: "Title B", text: "Text A" } });
    const a = promoteArm(block, "A");
    expect(a.props.variantId).toBe("gid://shopify/ProductVariant/1");
    expect(a.props.variantB?.enabled).toBe(false);
  });
});

describe("attribution window at query time", () => {
  it("drops a dated touch older than the window before the checkout, keeps undated ones", () => {
    const sql = windowedTouch(Prisma.sql`s.utm`, 7);
    expect(sql.sql).toContain("make_interval(days =>");
    expect(sql.sql).toContain(`(s.utm->>'ts')::timestamptz < s."createdAt"`);
    expect(sql.values).toContain(7);
    // No window: the column as is.
    expect(windowedTouch(Prisma.sql`s.utm`, null).sql).toBe("s.utm");
  });
});

describe("translations of bumps, gifts and shipping rates", () => {
  it("keeps valid languages and fields only", () => {
    expect(cleanRecordI18n(JSON.stringify({ en: { title: " Gift wrap ", description: "", other: "x" }, xx: { title: "?" }, de: { title: "Geschenk" } }), ["title", "description"])).toEqual({
      en: { title: "Gift wrap" },
      de: { title: "Geschenk" },
    });
    expect(cleanRecordI18n("{}", ["title"])).toBeNull();
    expect(cleanRecordI18n("not json", ["title"])).toBeNull();
    expect(cleanRecordI18n({ en: { title: "a".repeat(900) } }, ["title"])!.en!.title).toHaveLength(400);
  });

  it("shows the buyer's language, else the base text", () => {
    const i18n = { en: { title: "Gift wrap" } };
    expect(recordText("Emballage cadeau", "title", "en", i18n)).toBe("Gift wrap");
    expect(recordText("Emballage cadeau", "title", "de", i18n)).toBe("Emballage cadeau");
    expect(recordText(null, "description", "en", i18n)).toBeNull();
    // Rates: the merchant's delay wins, else the French delay is converted automatically.
    const rate = { name: "Standard", deliveryTime: "3 à 5 jours ouvrés", i18n: { de: { name: "Standardversand", deliveryTime: "3–5 Werktage (DHL)" } } };
    expect(localizeRate(rate, "de")).toMatchObject({ name: "Standardversand", deliveryTime: "3–5 Werktage (DHL)" });
    expect(localizeRate(rate, "en")).toMatchObject({ name: "Standard", deliveryTime: "3–5 business days" });
    expect(localizeRate(rate, "fr")).toMatchObject({ name: "Standard", deliveryTime: "3 à 5 jours ouvrés" });
  });

  it("stores gift names per language with the tier and reads them back", () => {
    const raw = [{ type: "gift", variantId: "123", title: "une bougie offerte", minSubtotalCents: 5000, i18n: { en: { title: "a free candle" }, zz: { title: "?" } } }];
    const [tier] = parseGiftTiers(raw);
    expect(tier.i18n).toEqual({ en: { title: "a free candle" } });
    expect(giftTitle(tier, "en")).toBe("a free candle");
    expect(giftTitle(tier, "it")).toBe("une bougie offerte");
    expect(giftTitle(tier, null)).toBe("une bougie offerte");
    expect(validateQuantityTiers(raw)).toMatchObject({ ok: true, tiers: [expect.objectContaining({ i18n: { en: { title: "a free candle" } } })] });
    expect(giftI18nOf({ en: { title: "  " } })).toBeUndefined();
  });
});

describe("one-click offer merged into the checkout's Shopify order", () => {
  const store = { id: "st", shopDomain: "shop.myshopify.com", shopifyAccessToken: encrypt("tok") } as never;
  afterEach(() => vi.unstubAllGlobals());

  /** fetch mock answering each GraphQL operation by its root field. */
  function shopifyMock(answers: Record<string, unknown | ((vars: Record<string, unknown>) => unknown)>) {
    const calls: { op: string; vars: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const { query, variables } = JSON.parse(init.body) as { query: string; variables: Record<string, unknown> };
        const op = /\{\s*(\w+)/.exec(query.slice(query.indexOf("{")))![1];
        calls.push({ op, vars: variables });
        const a = answers[op];
        if (a instanceof Error) throw a;
        const data = typeof a === "function" ? (a as (v: Record<string, unknown>) => unknown)(variables) : a;
        return new Response(JSON.stringify({ data: { [op]: data } }), { status: 200 });
      }),
    );
    return calls;
  }
  const input = { orderId: "gid://shopify/Order/1", variantId: "gid://shopify/ProductVariant/9", quantity: 2, amountCents: 3000, currency: "EUR", marker: offerMarker("ch1") };
  /** Calculated order grown by exactly the 30 € paid (no tax added on top). */
  const m = (a: string) => ({ shopMoney: { amount: a } });
  const totals = { totalPriceSet: m("80.00"), totalOutstandingSet: m("30.00"), originalOrder: { currentTotalPriceSet: m("50.00"), totalOutstandingSet: m("0.00") } };

  it("begins, adds the variant, discounts it to the offer price and commits without notifying", async () => {
    const calls = shopifyMock({
      orderEditBegin: { calculatedOrder: { id: "gid://shopify/CalculatedOrder/7" }, userErrors: [] },
      orderEditAddVariant: { calculatedLineItem: { id: "gid://shopify/CalculatedLineItem/8", originalUnitPriceSet: { shopMoney: { amount: "25.00" } } }, userErrors: [] },
      orderEditAddLineItemDiscount: { calculatedLineItem: { discountedUnitPriceSet: { shopMoney: { amount: "15.00" } } }, userErrors: [] },
      node: totals,
      orderEditCommit: { order: { id: "gid://shopify/Order/1" }, userErrors: [] },
    });
    expect(await addVariantToOrder(store, input)).toEqual({ status: "committed" });
    expect(calls.map((c) => c.op)).toEqual(["orderEditBegin", "orderEditAddVariant", "orderEditAddLineItemDiscount", "node", "orderEditCommit"]);
    expect(calls[1].vars).toMatchObject({ variantId: input.variantId, quantity: 2 });
    // 25 € − 10 € per unit = 15 € × 2 = the 30 € paid; the discount carries the idempotency marker.
    expect(calls[2].vars.discount).toEqual({ description: "Offre post-achat wc-offer-in-ch1", fixedValue: { amount: "10.00", currencyCode: "EUR" } });
    expect(calls[4].vars.staffNote).toContain("wc-offer-in-ch1");
  });

  it("never commits a price it can't match, and refuses (fallback) before the commit", async () => {
    const calls = shopifyMock({
      orderEditBegin: { calculatedOrder: { id: "c" }, userErrors: [] },
      orderEditAddVariant: { calculatedLineItem: { id: "l", originalUnitPriceSet: { shopMoney: { amount: "25.00" } } }, userErrors: [] },
      // Shopify applied the fixed value to the whole line instead: 20 € a unit, not 15 €.
      orderEditAddLineItemDiscount: { calculatedLineItem: { discountedUnitPriceSet: { shopMoney: { amount: "20.00" } } }, userErrors: [] },
    });
    expect(await addVariantToOrder(store, input)).toMatchObject({ status: "refused" });
    expect(calls.some((c) => c.op === "orderEditCommit")).toBe(false);
    shopifyMock({ orderEditBegin: { calculatedOrder: null, userErrors: [{ field: null, message: "The order cannot be edited" }] } });
    expect(await addVariantToOrder(store, input)).toEqual({ status: "refused", reason: "The order cannot be edited" });
  });

  it("throws when the commit's outcome is unknown (the caller retries instead of creating a second order)", async () => {
    shopifyMock({
      orderEditBegin: { calculatedOrder: { id: "c" }, userErrors: [] },
      orderEditAddVariant: { calculatedLineItem: { id: "l", originalUnitPriceSet: { shopMoney: { amount: "15.00" } } }, userErrors: [] },
      orderEditAddLineItemDiscount: { calculatedLineItem: { discountedUnitPriceSet: { shopMoney: { amount: "15.00" } } }, userErrors: [] },
      node: totals,
      orderEditCommit: new Error("socket hang up"),
    });
    await expect(addVariantToOrder(store, input)).rejects.toThrow(/injoignable/);
  });

  it("recognises the offer's line by its marker or as a line added after the snapshot, and refuses shipped orders", () => {
    const order = {
      lines: [
        { id: "L1", variantId: "V9", quantity: 1, discounts: [] },
        { id: "L2", variantId: "V9", quantity: 2, discounts: ["Offre post-achat wc-upsell-ch1"] },
      ],
    };
    expect(findOfferLine(order, "wc-upsell-ch1", "V9", null)?.id).toBe("L2");
    expect(findOfferLine({ lines: [order.lines[0], { ...order.lines[1], discounts: [] }] }, "wc-upsell-ch1", "V9", new Set(["L1"]))?.id).toBe("L2");
    expect(findOfferLine({ lines: [order.lines[0]] }, "wc-upsell-ch1", "V9", new Set(["L1"]))).toBeNull();
    expect(orderEditRefusal({ fulfillmentStatus: "UNFULFILLED", cancelled: false, closed: false })).toBeNull();
    expect(orderEditRefusal({ fulfillmentStatus: "FULFILLED", cancelled: false, closed: false })).toMatch(/expédiée/);
    expect(orderEditRefusal({ fulfillmentStatus: "UNFULFILLED", cancelled: true, closed: false })).toMatch(/annulée/);
    expect(orderEditRefusal(null)).toMatch(/introuvable/);
  });

  it("splits a shared order's refunds between the checkout and each merged offer by their note", () => {
    const refunds = [
      { note: "Remboursé via Whop", cents: 1000 },
      { note: `Remboursé via Whop ${offerRefundMarker("ch1")}`, cents: 1500 },
      { note: `Remboursé via Whop ${offerRefundMarker("ch2")}`, cents: 700 },
    ];
    expect(alreadyRefunded(refunds, { marker: offerRefundMarker("ch1") })).toBe(1500);
    expect(alreadyRefunded(refunds, { sharesOrder: true })).toBe(1000);
    expect(alreadyRefunded(refunds, {})).toBe(3200);
  });
});

describe("protection claims, geo country, ad VAT, daily report, currencies", () => {
  it("validates a claim", () => {
    expect(checkClaim({ kind: "reship", costCents: 1850, note: " perdu\n" })).toEqual({ ok: true, kind: "reship", costCents: 1850, note: "perdu" });
    expect(checkClaim({ kind: "refund", costCents: 0 })).toMatchObject({ ok: false });
    expect(checkClaim({ kind: "gift", costCents: 100 })).toMatchObject({ ok: false });
    expect(checkClaim({ kind: "refund", costCents: null })).toMatchObject({ ok: false });
  });

  it("reads the IP country header", () => {
    expect(geoCountryOf(new Headers({ "x-vercel-ip-country": "be" }))).toBe("BE");
    expect(geoCountryOf(new Headers({ "x-vercel-ip-country": "XX" }))).toBeNull();
    expect(geoCountryOf(new Headers({ "x-vercel-ip-country": "T1" }))).toBeNull();
    expect(geoCountryOf(new Headers())).toBeNull();
  });

  it("adds the non-reclaimable VAT to ad spend only for VAT-exempt stores that ask for it", () => {
    expect(adSpendVatFactor({ vatExempt: true, adSpendVatNonReclaimable: true })).toBeCloseTo(1.2);
    expect(adSpendVatFactor({ vatExempt: false, adSpendVatNonReclaimable: true })).toBe(1);
    expect(adSpendVatFactor({ vatExempt: true, adSpendVatNonReclaimable: false })).toBe(1);
    expect(adSpendVatFactor(null)).toBe(1);
  });

  it("compares the day with the day before and deducts the day's fixed costs", () => {
    const msg = dailyReportMessage("M", "2026-09-27", "EUR", { revenueHtCents: 12000, orders: 3, netAfterAdsCents: 4000, spendCents: 0, roas: null, estimated: false }, [], [], {
      previous: { revenueHtCents: 10000, orders: 4, netAfterAdsCents: 3000 },
      fixedCents: 1000,
    });
    expect(msg).toMatch(/après frais fixes 30,00\s€ \(10,00\s€ de frais fixes du jour\)/);
    expect(msg).toMatch(/Par rapport à la veille : CA HT \+20 %, -1 commande, bénéfice après pub \+10,00\s€\. Anomalies : aucune\.$/);
    const zero = dailyReportMessage("M", "2026-09-27", "EUR", { revenueHtCents: 5000, orders: 1, netAfterAdsCents: 0, spendCents: 0, roas: null, estimated: false }, [], [], {
      previous: { revenueHtCents: 0, orders: 0, netAfterAdsCents: null },
    });
    expect(zero).toMatch(/Par rapport à la veille : CA HT 0,00\s€ la veille, \+1 commande\./);
  });

  it("no longer estimates Bulgarian prices in leva (euro since 2026)", () => {
    expect(COUNTRY_CURRENCY.BG).toBeUndefined();
  });
});
