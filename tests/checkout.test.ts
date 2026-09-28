import { describe, expect, it } from "vitest";
import { addressFromPayment, quoteFingerprint, reviewReasons } from "@/lib/checkout";

describe("addressFromPayment (express wallets)", () => {
  it("maps a wallet shipping address to a Shopify address", () => {
    expect(
      addressFromPayment({
        email: "a@b.fr",
        phone: "+33600000000",
        address: { name: "Alex Martin Dupont", line1: "1 rue X", line2: null, city: "Paris", state: null, postal_code: "75001", country: "fr" },
      }),
    ).toEqual({
      firstName: "Alex",
      lastName: "Martin Dupont",
      address1: "1 rue X",
      address2: null,
      city: "Paris",
      province: null,
      zip: "75001",
      countryCode: "FR",
      phone: "+33600000000",
    });
  });

  it("returns null when the address is incomplete", () => {
    expect(addressFromPayment({ email: null, phone: null, address: null })).toBeNull();
    expect(
      addressFromPayment({ email: null, phone: null, address: { name: null, line1: null, line2: null, city: "Paris", state: null, postal_code: null, country: "FR" } }),
    ).toBeNull();
  });
});

describe("quoteFingerprint", () => {
  const base = {
    totals: { subtotalCents: 5000, discountCents: 0, shippingCents: 490, addOnsCents: 0, totalCents: 5490, itemCount: 1 },
    shippingRateId: "r1",
    discount: null,
    addOnIds: ["b", "a"],
  };
  it("ignores add-on order", () => {
    expect(quoteFingerprint(base)).toBe(quoteFingerprint({ ...base, addOnIds: ["a", "b"] }));
  });
  it("changes when the rate changes even at the same total", () => {
    expect(quoteFingerprint(base)).not.toBe(quoteFingerprint({ ...base, shippingRateId: "r2" }));
  });
  it("changes with the discount code", () => {
    expect(quoteFingerprint(base)).not.toBe(quoteFingerprint({ ...base, discount: { code: "X", type: "PERCENT" } }));
  });
});

describe("reviewReasons", () => {
  const snap = { totalCents: 5490, currency: "EUR", shippingCountries: ["FR", "BE"], shippingRateId: "r1" };
  const fr = { firstName: "A", lastName: "B", address1: "1 rue", city: "Paris", zip: "75001", countryCode: "FR" };
  it("accepts an exact payment to a covered country", () => {
    expect(reviewReasons(snap, { totalCents: 5490, currency: "eur" }, fr)).toEqual([]);
  });
  it("flags underpayment in the same currency", () => {
    expect(reviewReasons(snap, { totalCents: 5000, currency: "EUR" }, fr)).toHaveLength(1);
  });
  it("skips the amount check across currencies (adaptive pricing)", () => {
    expect(reviewReasons(snap, { totalCents: 100, currency: "USD" }, fr)).toEqual([]);
  });
  it("fails closed when the amount is unreadable", () => {
    expect(reviewReasons(snap, { totalCents: null, currency: "EUR" }, fr)).toHaveLength(1);
  });
  it("flags a destination the paid rate doesn't cover", () => {
    expect(reviewReasons(snap, { totalCents: 5490, currency: "EUR" }, { ...fr, countryCode: "US" })).toHaveLength(1);
  });
  it("accepts any country for a worldwide rate", () => {
    expect(reviewReasons({ ...snap, shippingCountries: [] }, { totalCents: 5490, currency: "EUR" }, { ...fr, countryCode: "US" })).toEqual([]);
  });
});

describe("quantity breaks and bump rules", async () => {
  const { computeTotals, parseQuantityBreaks, quantityBreakFor } = await import("@/lib/pricing");
  const { addOnEligible } = await import("@/lib/checkout");
  const line = { variantId: "v", productId: "p1", productHandle: "h", title: "T", variantTitle: null, sku: null, imageUrl: null, quantity: 2, unitPriceCents: 2500, compareAtCents: null, inventory: null, requiresShipping: true };
  const breaks = parseQuantityBreaks([{ minQty: 2, percent: 10 }, { minQty: 3, percent: 15 }, { minQty: 1, percent: 90 }]);
  it("keeps only sane tiers and finds the current and next one", () => {
    expect(breaks).toEqual([{ minQty: 2, percent: 10 }, { minQty: 3, percent: 15 }]);
    expect(quantityBreakFor(breaks, 2)).toEqual({ current: { minQty: 2, percent: 10 }, next: { minQty: 3, percent: 15 } });
    expect(quantityBreakFor(breaks, 1)).toEqual({ current: null, next: { minQty: 2, percent: 10 } });
  });
  it("applies the tier before the code, and counts it in the discount", () => {
    const t = computeTotals({
      lines: [line],
      rate: null,
      addOns: [],
      quantityBreaks: breaks,
      discount: { code: "X", type: "PERCENT", value: 10, minSubtotalCents: null, startsAt: null, endsAt: null, usageLimit: null, usageCount: 0, active: true },
    });
    expect(t.volumeDiscountCents).toBe(500);
    expect(t.discountCents).toBe(500 + 450);
    expect(t.totalCents).toBe(5000 - 950);
  });
  it("shows an order bump only when its rules match", () => {
    const ctx = { subtotalCents: 5000, productIds: ["p1"], country: "FR" };
    expect(addOnEligible(null, ctx)).toBe(true);
    expect(addOnEligible({ minSubtotalCents: 6000 }, ctx)).toBe(false);
    expect(addOnEligible({ productIds: ["p2"] }, ctx)).toBe(false);
    expect(addOnEligible({ productIds: ["p1"], countries: ["fr"] }, ctx)).toBe(true);
    expect(addOnEligible({ countries: ["BE"] }, ctx)).toBe(false);
  });
});

describe("deadline guard", async () => {
  const { assertTime, DeadlineError } = await import("@/lib/deadline");
  const { withLogContext } = await import("@/lib/log");
  it("refuses to start a call that can't finish before the run's hard deadline", () => {
    expect(() => withLogContext({ hardDeadline: Date.now() + 5_000 }, () => assertTime(12_000, "Shopify"))).toThrow(DeadlineError);
    expect(() => withLogContext({ hardDeadline: Date.now() + 60_000 }, () => assertTime(12_000, "Shopify"))).not.toThrow();
    expect(() => assertTime(12_000, "Shopify")).not.toThrow(); // outside a bounded run
  });
});
