import { describe, expect, it } from "vitest";
import { addressFromPayment } from "@/lib/checkout";

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
