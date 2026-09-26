import { describe, expect, it } from "vitest";
import {
  allocateDiscount,
  centsToDecimal,
  checkDiscount,
  computeTotals,
  discountAmount,
  ratesForCountry,
  type CartLine,
  type DiscountInput,
  type RateInput,
} from "@/lib/pricing";

const line = (over: Partial<CartLine> = {}): CartLine => ({
  variantId: "gid://shopify/ProductVariant/1",
  productId: "gid://shopify/Product/1",
  productHandle: "p",
  title: "Produit",
  variantTitle: null,
  sku: null,
  imageUrl: null,
  quantity: 1,
  unitPriceCents: 1000,
  compareAtCents: null,
  inventory: null,
  requiresShipping: true,
  ...over,
});

const rate = (over: Partial<RateInput> = {}): RateInput => ({
  id: "r1",
  name: "Standard",
  deliveryTime: null,
  countries: [],
  priceCents: 490,
  freeOverCents: null,
  active: true,
  ...over,
});

const code = (over: Partial<DiscountInput> = {}): DiscountInput => ({
  code: "X",
  type: "PERCENT",
  value: 10,
  minSubtotalCents: null,
  startsAt: null,
  endsAt: null,
  usageLimit: null,
  usageCount: 0,
  active: true,
  ...over,
});

describe("computeTotals", () => {
  it("adds subtotal, shipping and add-ons", () => {
    const t = computeTotals({
      lines: [line({ quantity: 2, unitPriceCents: 1999 }), line({ variantId: "v2", unitPriceCents: 4990 })],
      rate: rate(),
      discount: null,
      addOns: [{ id: "a", title: "Cadeau", priceCents: 299, active: true }],
    });
    expect(t).toEqual({ subtotalCents: 8988, discountCents: 0, shippingCents: 490, addOnsCents: 299, totalCents: 9777, itemCount: 3 });
  });

  it("applies percent discounts to merchandise only", () => {
    const t = computeTotals({ lines: [line({ unitPriceCents: 3333 })], rate: rate(), discount: code({ value: 10 }), addOns: [] });
    expect(t.discountCents).toBe(333);
    expect(t.totalCents).toBe(3333 - 333 + 490);
  });

  it("caps fixed discounts at the subtotal", () => {
    expect(discountAmount(code({ type: "FIXED", value: 5000 }), 1200)).toBe(1200);
  });

  it("gives free shipping over the threshold (after discount) and with free-shipping codes", () => {
    const lines = [line({ unitPriceCents: 5000 })];
    expect(computeTotals({ lines, rate: rate({ freeOverCents: 5000 }), discount: null, addOns: [] }).shippingCents).toBe(0);
    expect(computeTotals({ lines, rate: rate({ freeOverCents: 5000 }), discount: code({ value: 10 }), addOns: [] }).shippingCents).toBe(490);
    expect(computeTotals({ lines, rate: rate(), discount: code({ type: "FREE_SHIPPING" }), addOns: [] }).shippingCents).toBe(0);
  });

  it("charges no shipping for digital-only carts", () => {
    expect(computeTotals({ lines: [line({ requiresShipping: false })], rate: rate(), discount: null, addOns: [] }).shippingCents).toBe(0);
  });

  it("ignores inactive add-ons", () => {
    expect(computeTotals({ lines: [line()], rate: null, discount: null, addOns: [{ id: "a", title: "x", priceCents: 500, active: false }] }).totalCents).toBe(1000);
  });
});

describe("checkDiscount", () => {
  const now = new Date("2026-06-01T12:00:00Z");
  it("accepts a valid code", () => expect(checkDiscount(code(), 1000, now)).toEqual({ ok: true }));
  it("rejects inactive, expired, future, exhausted and under-minimum codes", () => {
    expect(checkDiscount(code({ active: false }), 1000, now).ok).toBe(false);
    expect(checkDiscount(code({ endsAt: new Date("2026-05-01") }), 1000, now).ok).toBe(false);
    expect(checkDiscount(code({ startsAt: new Date("2026-07-01") }), 1000, now).ok).toBe(false);
    expect(checkDiscount(code({ usageLimit: 3, usageCount: 3 }), 1000, now).ok).toBe(false);
    expect(checkDiscount(code({ minSubtotalCents: 2000 }), 1000, now).ok).toBe(false);
  });
});

describe("ratesForCountry", () => {
  it("keeps worldwide rates and matching country rates", () => {
    const rates = [rate({ id: "all" }), rate({ id: "fr", countries: ["FR"] }), rate({ id: "be", countries: ["BE"] }), rate({ id: "off", active: false })];
    expect(ratesForCountry(rates, "FR").map((r) => r.id)).toEqual(["all", "fr"]);
    expect(ratesForCountry(rates, null).map((r) => r.id)).toEqual(["all"]);
  });
});

describe("allocateDiscount", () => {
  it("distributes exactly the discount, proportionally", () => {
    const lines = [line({ unitPriceCents: 1000 }), line({ unitPriceCents: 2000 }), line({ unitPriceCents: 3000 })];
    const alloc = allocateDiscount(lines, 1001);
    expect(alloc.reduce((a, b) => a + b, 0)).toBe(1001);
    expect(alloc).toEqual([167, 334, 500]);
  });
  it("returns zeros without discount", () => expect(allocateDiscount([line()], 0)).toEqual([0]));
});

describe("centsToDecimal", () => {
  it("formats minor units", () => {
    expect(centsToDecimal(0)).toBe("0.00");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(123456)).toBe("1234.56");
    expect(centsToDecimal(-250)).toBe("-2.50");
  });
});
