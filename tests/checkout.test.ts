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
