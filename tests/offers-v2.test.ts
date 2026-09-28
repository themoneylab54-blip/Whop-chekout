import { describe, expect, it } from "vitest";
import {
  armKey,
  checkoutLayoutSchema,
  createBlock,
  currentOffer,
  downsellCycle,
  downsellTargets,
  funnelDepth,
  loadCheckoutLayout,
  loadThankYouLayout,
  normalizeSurveyAnswer,
  offerArmProps,
  offerReachable,
  offerTrail,
  offerUnitCents,
  parseArmKey,
  thankYouLayoutSchema,
  upsellRoots,
  upsellSellable,
  MAX_OFFER_DEPTH,
  type BlockOf,
} from "@/lib/layout";
import {
  chargeStates,
  matchingUpsellIds,
  offerAlreadyBought,
  offerArmFor,
  offerArmsFor,
  upsellAmountCents,
  upsellConditionsMet,
  upsellContextOf,
  upsellOfferable,
  upsellQuantity,
  visitorKeyOf,
  type UpsellContext,
} from "@/lib/upsell";
import { bucketOf } from "@/lib/experiments";
import {
  computeTotals,
  giftLine,
  giftProgress,
  parseGiftTiers,
  parseQuantityBreaks,
  parseQuantityTiers,
  protectionPriceCents,
  quantityBreakFor,
  quantityBreakForLines,
  validateQuantityTiers,
  type CartLine,
  type ProtectionPricing,
} from "@/lib/pricing";

type Upsell = BlockOf<"upsell">;

function offer(id: string, props: Partial<Upsell["props"]> = {}): Upsell {
  const b = createBlock("upsell", { id });
  return { ...b, props: { ...b.props, variantId: "123", ...props } };
}

function line(productId: string, qty: number, unitCents: number, extra: Partial<CartLine> = {}): CartLine {
  return {
    variantId: `gid://shopify/ProductVariant/${productId}0`,
    productId: `gid://shopify/Product/${productId}`,
    productHandle: productId,
    title: `P${productId}`,
    variantTitle: null,
    sku: null,
    imageUrl: null,
    quantity: qty,
    unitPriceCents: unitCents,
    compareAtCents: null,
    inventory: null,
    requiresShipping: true,
    ...extra,
  };
}

const ctx: UpsellContext = { subtotalCents: 5000, productIds: ["gid://shopify/Product/42"], variantIds: ["gid://shopify/ProductVariant/420"], country: "FR" };
const all = () => true;

/* ------------------------------------------------------------------ */

describe("offer price modes", () => {
  it("charges the fixed price, whatever Shopify says", () => {
    const o = offer("a", { price: 19.9 });
    expect(offerUnitCents(o.props, null)).toBe(1990);
    expect(upsellAmountCents(o, 3, 5000)).toBe(5970);
    expect(upsellAmountCents(o, 2)).toBe(3980);
  });

  it("charges a percent off the live Shopify price, never without it", () => {
    const o = offer("a", { priceMode: "percent", discountPercent: 25, price: 0 });
    expect(upsellSellable(o.props)).toBe(true);
    expect(offerUnitCents(o.props, 3990)).toBe(2993); // 39,90 € − 25 % = 29,925 → 29,93 €
    expect(upsellAmountCents(o, 2, 3990)).toBe(5986);
    expect(offerUnitCents(o.props, null)).toBeNull();
    expect(upsellAmountCents(o, 1, 0)).toBeNull();
    expect(upsellAmountCents(o, 1)).toBeNull();
  });

  it("needs a variant and a price to be sellable", () => {
    expect(upsellSellable(offer("a", { price: 0 }).props)).toBe(false);
    expect(upsellSellable(offer("a", { variantId: " " }).props)).toBe(false);
    expect(upsellSellable(offer("a", { price: 10 }).props)).toBe(true);
  });

  it("accepts up to 10 units", () => {
    expect(upsellQuantity(offer("a", { maxQuantity: 10 }), 10)).toBe(10);
    expect(upsellQuantity(offer("a", { maxQuantity: 10 }), 11)).toBeNull();
    expect(loadThankYouLayout({ blocks: [{ ...offer("q"), props: { ...offer("q").props, maxQuantity: 10 } }] }).blocks.find((b) => b.id === "q")).toMatchObject({ props: { maxQuantity: 10 } });
  });
});

/* ------------------------------------------------------------------ */

describe("offer A/B arms", () => {
  const withB = (split = 50) =>
    offer("ab", {
      price: 10,
      title: "Titre A",
      text: "Texte A",
      variantB: {
        enabled: true,
        split,
        variantId: "999",
        productId: "gid://shopify/Product/9",
        imageUrl: "",
        badge: "",
        title: "Titre B",
        text: "",
        buttonText: "",
        priceMode: "percent",
        price: 0,
        discountPercent: 30,
        compareAt: 0,
      },
    });

  it("buckets each visitor with the experiments hash, consistently", () => {
    const block = withB(50);
    for (const v of ["v1", "v2", "visitor-abc", "x"]) {
      const expected = bucketOf(v, "upsell:ab") < 50 ? "B" : "A";
      expect(offerArmFor(block, v)).toBe(expected);
      expect(offerArmFor(block, v)).toBe(offerArmFor(block, v));
    }
  });

  it("splits roughly as asked", () => {
    const block = withB(20);
    const n = 2000;
    let b = 0;
    for (let i = 0; i < n; i++) if (offerArmFor(block, `visitor-${i}`) === "B") b++;
    expect(b / n).toBeGreaterThan(0.16);
    expect(b / n).toBeLessThan(0.24);
  });

  it("stays on A when B is off or incomplete", () => {
    expect(offerArmFor(offer("a", { price: 10 }), "v")).toBe("A");
    const off = withB(99);
    off.props.variantB!.enabled = false;
    expect(offerArmFor(off, "v")).toBe("A");
    const incomplete = withB(99);
    incomplete.props.variantB!.variantId = "";
    expect(offerArmFor(incomplete, "v")).toBe("A");
    expect(offerArmsFor([off, incomplete], "v")).toEqual({ ab: "A" });
  });

  it("B overrides product, price and texts; empty texts fall back to A", () => {
    const p = offerArmProps(withB(), "B");
    expect(p.variantId).toBe("999");
    expect(p.title).toBe("Titre B");
    expect(p.text).toBe("Texte A");
    expect(p.priceMode).toBe("percent");
    expect(upsellAmountCents(withB(), 1, 2000, "B")).toBe(1400);
    expect(upsellAmountCents(withB(), 1, 2000, "A")).toBe(1000);
    expect(offerArmProps(withB(), "A").variantId).toBe("123");
  });

  it("encodes the arm in shown blocks and charges", () => {
    expect(armKey("ab", "A")).toBe("ab");
    expect(armKey("ab", "B")).toBe("ab:B");
    expect(parseArmKey("ab:B")).toEqual({ blockId: "ab", arm: "B" });
    expect(parseArmKey("ab")).toEqual({ blockId: "ab", arm: "A" });
    expect(chargeStates([{ blockId: "ab:B", status: "PAID" }, { blockId: "c", status: "DECLINED" }])).toEqual({ ab: "PAID", c: "DECLINED" });
  });

  it("uses the storefront visitor, else the session, as the key", () => {
    expect(visitorKeyOf({ id: "s1", visitorId: "v1" })).toBe("v1");
    expect(visitorKeyOf({ id: "s1", visitorId: null })).toBe("s1");
  });
});

/* ------------------------------------------------------------------ */

describe("offer funnels (accept and decline chains)", () => {
  // a: yes → b, no → c ; b: yes → d
  const a = offer("a", { acceptNextId: "b", declineNextId: "c" });
  const b = offer("b", { acceptNextId: "d" });
  const c = offer("c");
  const d = offer("d");
  const e = offer("e");
  const blocks = [a, b, c, d, e];

  it("only roots open a slot", () => {
    expect([...downsellTargets(blocks)].sort()).toEqual(["b", "c", "d"]);
    expect(upsellRoots(blocks).map((x) => x.id)).toEqual(["a", "e"]);
  });

  it("goes to the next step after a yes, keeping the accepted confirmation", () => {
    expect(offerTrail(blocks, "a", {}, all)).toEqual({ accepted: [], current: "a" });
    expect(offerTrail(blocks, "a", { a: "PAID" }, all)).toEqual({ accepted: ["a"], current: "b" });
    expect(offerTrail(blocks, "a", { a: "PENDING", b: "PAID" }, all)).toEqual({ accepted: ["a", "b"], current: "d" });
    expect(offerTrail(blocks, "a", { a: "DECLINED" }, all)).toEqual({ accepted: [], current: "c" });
    expect(offerTrail(blocks, "a", { a: "PAID", b: "DECLINED" }, all)).toEqual({ accepted: ["a"], current: null });
    expect(currentOffer(blocks, "a", { a: "PAID", b: "DECLINED" }, all)).toBe("a");
  });

  it("allows a next step only after the answer that leads to it", () => {
    const ok = (id: string, states: Record<string, string>) => offerReachable(blocks, id, states, all);
    expect(ok("b", {})).toBe(false);
    expect(ok("b", { a: "PAID" })).toBe(true);
    expect(ok("c", { a: "PAID" })).toBe(false);
    expect(ok("c", { a: "DECLINED" })).toBe(true);
    expect(ok("d", { a: "PAID" })).toBe(false);
    expect(ok("d", { a: "PAID", b: "PAID" })).toBe(true);
    expect(upsellOfferable(blocks, "b", ctx, { a: "PAID" })).toBe(true);
    expect(upsellOfferable(blocks, "b", ctx, { a: "DECLINED" })).toBe(false);
  });

  it("stops after MAX_OFFER_DEPTH offers", () => {
    const long = [offer("1", { acceptNextId: "2" }), offer("2", { acceptNextId: "3" }), offer("3", { acceptNextId: "4" }), offer("4")];
    expect(MAX_OFFER_DEPTH).toBe(3);
    expect(offerTrail(long, "1", { 1: "PAID", 2: "PAID" }, all).current).toBe("3");
    expect(offerTrail(long, "1", { 1: "PAID", 2: "PAID", 3: "PAID" }, all)).toEqual({ accepted: ["1", "2", "3"], current: null });
    expect(funnelDepth(long, "1")).toBe(4);
    expect(funnelDepth(blocks, "a")).toBe(3);
  });

  it("is cycle-safe through both answers", () => {
    const loop = [offer("x", { acceptNextId: "y" }), offer("y", { declineNextId: "x" })];
    expect(upsellRoots(loop)).toEqual([]);
    expect(offerTrail(loop, "x", { x: "PAID", y: "DECLINED" }, all)).toEqual({ accepted: ["x"], current: null });
    expect(downsellCycle(blocks, "d", "a")).toBe(true); // a → b → d
    expect(downsellCycle(blocks, "c", "a")).toBe(true); // a → c
    expect(downsellCycle(blocks, "e", "a")).toBe(false);
    expect(funnelDepth(loop, "x")).toBe(2);
  });

  it("stops the funnel when a next step does not match the order", () => {
    const targeted = [a, offer("b", { acceptNextId: "d", conditions: { productIds: ["999"], countries: [] } }), c, d];
    expect(upsellOfferable(targeted, "b", ctx, { a: "PAID" })).toBe(false);
    expect(matchingUpsellIds(targeted, ctx)).toEqual(["a", "c", "d"]);
  });
});

/* ------------------------------------------------------------------ */

describe("exclude if already bought", () => {
  it("hides the offer when its product or variant is in the paid order", () => {
    const byProduct = offer("a", { productId: "42", excludePurchased: true });
    const byVariant = offer("b", { variantId: "gid://shopify/ProductVariant/420", excludePurchased: true });
    const other = offer("c", { productId: "7", variantId: "70", excludePurchased: true });
    const notExcluded = offer("d", { productId: "42" });
    expect(offerAlreadyBought(byProduct, ctx)).toBe(true);
    expect(upsellConditionsMet(byProduct, ctx)).toBe(false);
    expect(upsellConditionsMet(byVariant, ctx)).toBe(false);
    expect(upsellConditionsMet(other, ctx)).toBe(true);
    expect(upsellConditionsMet(notExcluded, ctx)).toBe(true);
  });

  it("checks the arm the visitor sees", () => {
    const o = offer("a", {
      productId: "42",
      excludePurchased: true,
      variantB: { enabled: true, split: 50, variantId: "70", productId: "7", imageUrl: "", badge: "", title: "", text: "", buttonText: "", priceMode: "fixed", price: 5, discountPercent: 20, compareAt: 0 },
    });
    expect(upsellConditionsMet(o, ctx, "A")).toBe(false);
    expect(upsellConditionsMet(o, ctx, "B")).toBe(true);
    expect(matchingUpsellIds([o], ctx, { a: "B" })).toEqual(["a"]);
  });

  it("reads the variants of the paid order", () => {
    const c = upsellContextOf({ lines: [line("42", 1, 1000)] as never, subtotalCents: 1000, shippingAddress: null, pickupPoint: null });
    expect(c.variantIds).toEqual(["gid://shopify/ProductVariant/420"]);
  });
});

/* ------------------------------------------------------------------ */

describe("quantity breaks v2", () => {
  it("reads older stores unchanged", () => {
    const legacy = [{ minQty: 2, percent: 10 }, { minQty: 3, percent: 15 }];
    expect(parseQuantityBreaks(legacy)).toEqual(legacy);
    expect(parseGiftTiers(legacy)).toEqual([]);
    const lines = [line("1", 2, 1000)];
    expect(quantityBreakForLines(parseQuantityBreaks(legacy), lines)).toEqual({ current: legacy[0], next: legacy[1], missing: 1 });
    expect(quantityBreakFor(parseQuantityBreaks(legacy), 2)).toEqual({ current: legacy[0], next: legacy[1] });
    expect(computeTotals({ lines, rate: null, discount: null, addOns: [], quantityBreaks: legacy }).discountCents).toBe(200);
  });

  it("counts and discounts only the scoped products", () => {
    const breaks = parseQuantityBreaks([{ minQty: 2, percent: 20, productIds: ["gid://shopify/Product/1"] }]);
    const oneScoped = [line("1", 1, 1000), line("2", 3, 500)];
    expect(quantityBreakForLines(breaks, oneScoped)).toMatchObject({ current: null, missing: 1 });
    expect(computeTotals({ lines: oneScoped, rate: null, discount: null, addOns: [], quantityBreaks: breaks }).discountCents).toBe(0);
    const twoScoped = [line("1", 2, 1000), line("2", 3, 500)];
    // 20 % of the 2 scoped items only (20 €), not of the 35 € cart.
    expect(computeTotals({ lines: twoScoped, rate: null, discount: null, addOns: [], quantityBreaks: breaks }).discountCents).toBe(400);
  });

  it("applies the reached tier worth the most", () => {
    const breaks = parseQuantityBreaks([
      { minQty: 2, percent: 10 },
      { minQty: 2, percent: 30, productIds: ["1"] },
    ]);
    const lines = [line("1", 2, 100), line("2", 2, 5000)];
    // 10 % of 102 € beats 30 % of 2 €.
    expect(quantityBreakForLines(breaks, lines).current?.percent).toBe(10);
  });

  it("parses gift tiers (items or amount), dropping broken ones", () => {
    const gifts = parseGiftTiers([
      { minQty: 2, percent: 10 },
      { type: "gift", minSubtotalCents: 5000, variantId: "555", title: "une bougie" },
      { type: "gift", minQty: 3, variantId: "gid://shopify/ProductVariant/777", title: "un savon", productIds: ["gid://shopify/Product/1"] },
      { type: "gift", minQty: 3, variantId: "", title: "rien" },
      { type: "gift", variantId: "1", title: "sans seuil" },
    ]);
    expect(gifts).toEqual([
      { type: "gift", minSubtotalCents: 5000, variantId: "gid://shopify/ProductVariant/555", title: "une bougie" },
      { type: "gift", minQty: 3, variantId: "gid://shopify/ProductVariant/777", title: "un savon", productIds: ["gid://shopify/Product/1"] },
    ]);
    expect(parseQuantityTiers([{ minQty: 2, percent: 10 }, { type: "gift", minQty: 1, variantId: "1", title: "x" }]).breaks).toHaveLength(1);
  });

  it("earns gifts and says how far the next one is", () => {
    const gifts = parseGiftTiers([
      { type: "gift", minSubtotalCents: 5000, variantId: "555", title: "une bougie" },
      { type: "gift", minQty: 3, variantId: "777", title: "un savon" },
    ]);
    const p1 = giftProgress(gifts, [line("1", 1, 3800)]);
    expect(p1.earned).toEqual([]);
    expect(p1.next).toMatchObject({ tier: { title: "une bougie" }, missingCents: 1200, missingQty: null });
    const p2 = giftProgress(gifts, [line("1", 2, 3000)]);
    expect(p2.earned.map((g) => g.title)).toEqual(["une bougie"]);
    expect(p2.next).toMatchObject({ tier: { title: "un savon" }, missingQty: 1 });
    // Gift lines never count towards a tier.
    const p3 = giftProgress(gifts, [line("1", 2, 3000), giftLine(line("9", 1, 900))]);
    expect(p3.earned).toHaveLength(1);
  });

  it("adds the gift at 0 with its real price struck through, outside item counts", () => {
    const g = giftLine(line("9", 1, 900));
    expect(g).toMatchObject({ gift: true, unitPriceCents: 0, compareAtCents: 900, quantity: 1 });
    const breaks = parseQuantityBreaks([{ minQty: 3, percent: 10 }]);
    const totals = computeTotals({ lines: [line("1", 2, 1000), g], rate: null, discount: null, addOns: [], quantityBreaks: breaks });
    expect(totals).toMatchObject({ subtotalCents: 2000, discountCents: 0, itemCount: 2, totalCents: 2000 });
  });

  it("validates what the dashboard saves", () => {
    expect(validateQuantityTiers([{ minQty: 2, percent: 10 }, { minQty: 3, percent: 15 }]).ok).toBe(true);
    expect(validateQuantityTiers([{ minQty: 2, percent: 10 }, { minQty: 3, percent: 5 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ minQty: 2, percent: 10 }, { minQty: 2, percent: 15 }])).toMatchObject({ ok: false });
    // Same quantity in another scope is fine.
    expect(validateQuantityTiers([{ minQty: 2, percent: 10 }, { minQty: 2, percent: 15, productIds: ["gid://shopify/Product/1"] }]).ok).toBe(true);
    expect(validateQuantityTiers([{ minQty: 2, percent: 12.55 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ minQty: 1, percent: 10 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ type: "gift", minQty: 2, variantId: "", title: "x" }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([1, 2, 3, 4].map((i) => ({ type: "gift", minQty: i, variantId: String(i), title: "x" })))).toMatchObject({ ok: false });
    const ok = validateQuantityTiers([{ type: "gift", minSubtotalCents: 5000, variantId: "555", title: "une bougie" }]);
    expect(ok).toEqual({ ok: true, tiers: [{ type: "gift", minSubtotalCents: 5000, variantId: "gid://shopify/ProductVariant/555", title: "une bougie" }] });
    expect(validateQuantityTiers("nope")).toMatchObject({ ok: false });
  });
});

/* ------------------------------------------------------------------ */

describe("shipping protection pricing", () => {
  const fixed: ProtectionPricing = { priceMode: "fixed", price: 2.9, percent: 0, minPrice: 0, maxPrice: 0 };
  const percent: ProtectionPricing = { priceMode: "percent", price: 0, percent: 3, minPrice: 1.9, maxPrice: 9.9 };

  it("prices a fixed amount or a percent within min/max", () => {
    expect(protectionPriceCents(fixed, 10000)).toBe(290);
    expect(protectionPriceCents(percent, 10000)).toBe(300); // 3 % of 100 €
    expect(protectionPriceCents(percent, 2000)).toBe(190); // 0,60 € → minimum 1,90 €
    expect(protectionPriceCents(percent, 100000)).toBe(990); // 30 € → maximum 9,90 €
    expect(protectionPriceCents({ ...percent, maxPrice: 0 }, 100000)).toBe(3000); // no maximum
    expect(protectionPriceCents(fixed, 0)).toBe(0);
  });

  it("goes into the add-ons and the total, on the discounted merchandise", () => {
    const lines = [line("1", 2, 5000)];
    const t = computeTotals({ lines, rate: null, discount: null, addOns: [{ id: "x", title: "Emballage", priceCents: 300, active: true }], quantityBreaks: [{ minQty: 2, percent: 10 }], protection: percent });
    expect(t.protectionCents).toBe(270); // 3 % of 90 €
    expect(t.addOnsCents).toBe(570);
    expect(t.totalCents).toBe(10000 - 1000 + 570);
    expect(computeTotals({ lines, rate: null, discount: null, addOns: [], protection: null }).protectionCents).toBeUndefined();
  });

  it("is never charged on an order with nothing to ship", () => {
    const t = computeTotals({ lines: [line("1", 1, 5000, { requiresShipping: false })], rate: null, discount: null, addOns: [], protection: fixed });
    expect(t.addOnsCents).toBe(0);
  });

  it("is a singleton checkout block, off by default, refused on the thank-you page", () => {
    const block = createBlock("shipping_protection");
    expect(block.props.defaultOn).toBe(false);
    const layout = loadCheckoutLayout({ blocks: [block, createBlock("shipping_protection")] });
    expect(layout.blocks.filter((b) => b.type === "shipping_protection")).toHaveLength(1);
    expect(checkoutLayoutSchema.safeParse(layout).success).toBe(true);
    expect(loadThankYouLayout({ blocks: [block] }).blocks.some((b) => b.type === "shipping_protection")).toBe(false);
    expect(thankYouLayoutSchema.safeParse({ blocks: [block] }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */

describe("post-purchase survey", () => {
  it("accepts the option keys and 'other' with an optional text", () => {
    expect(normalizeSurveyAnswer("instagram")).toBe("instagram");
    expect(normalizeSurveyAnswer(" friend ")).toBe("friend");
    expect(normalizeSurveyAnswer("other")).toBe("other");
    expect(normalizeSurveyAnswer("other:  Un podcast  ")).toBe("other:Un podcast");
    expect(normalizeSurveyAnswer("other:a:b")).toBe("other:a:b");
    expect(normalizeSurveyAnswer("other:\u0000x\ny")).toBe("other:x y");
    expect(normalizeSurveyAnswer("other:   ")).toBe("other");
  });

  it("refuses anything else", () => {
    expect(normalizeSurveyAnswer("twitter")).toBeNull();
    expect(normalizeSurveyAnswer("google:ads")).toBeNull();
    expect(normalizeSurveyAnswer(`other:${"x".repeat(81)}`)).toBeNull();
    expect(normalizeSurveyAnswer(`other:${"x".repeat(80)}`)).toBe(`other:${"x".repeat(80)}`);
    expect(normalizeSurveyAnswer(42)).toBeNull();
    expect(normalizeSurveyAnswer("")).toBeNull();
  });

  it("only allows the options the merchant shows", () => {
    expect(normalizeSurveyAnswer("tiktok", ["facebook", "other"])).toBeNull();
    expect(normalizeSurveyAnswer("other:x", ["facebook", "other"])).toBe("other:x");
  });

  it("is a singleton thank-you block with every option by default", () => {
    const block = createBlock("survey");
    expect(block.props.options).toEqual(["facebook", "instagram", "tiktok", "google", "youtube", "friend", "other"]);
    expect(loadCheckoutLayout({ blocks: [block] }).blocks.some((b) => b.type === "survey")).toBe(false);
    const ty = loadThankYouLayout({ blocks: [block, createBlock("survey")] });
    expect(ty.blocks.filter((b) => b.type === "survey")).toHaveLength(1);
    expect(thankYouLayoutSchema.safeParse(ty).success).toBe(true);
  });
});
