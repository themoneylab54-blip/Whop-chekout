import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOrderCreateInput, normalizeShopDomain, verifyOauthHmac, type PaidOrderInput } from "@/lib/shopify";
import type { CartLine } from "@/lib/pricing";

const line = (over: Partial<CartLine>): CartLine => ({
  variantId: "gid://shopify/ProductVariant/1",
  productId: "gid://shopify/Product/1",
  productHandle: "p",
  title: "Produit",
  variantTitle: null,
  sku: "SKU",
  imageUrl: null,
  quantity: 1,
  unitPriceCents: 1000,
  compareAtCents: null,
  inventory: null,
  requiresShipping: true,
  ...over,
});

const base: PaidOrderInput = {
  sessionId: "sess_1",
  currency: "EUR",
  email: "a@b.fr",
  acceptsMarketing: false,
  shippingAddress: { firstName: "Alex", lastName: "Martin", address1: "1 rue X", city: "Paris", zip: "75001", countryCode: "FR" },
  lines: [line({ quantity: 3, unitPriceCents: 1000 }), line({ variantId: "gid://shopify/ProductVariant/2", unitPriceCents: 2500 })],
  addOns: [{ title: "Emballage cadeau", priceCents: 299, variantId: null }],
  discount: { code: "PROMO", amountCents: 551, freeShipping: false },
  shipping: { title: "Standard", priceCents: 490 },
  totalCents: 5500 - 551 + 490 + 299,
  whopPaymentId: "pay_123",
  test: true,
};

function sum(order: ReturnType<typeof buildOrderCreateInput>) {
  const items = order.lineItems as { quantity: number; priceSet: { shopMoney: { amount: string } } }[];
  const shipping = order.shippingLines as { priceSet: { shopMoney: { amount: string } } }[];
  const cents = (a: string) => Math.round(Number(a) * 100);
  return (
    items.reduce((s, i) => s + i.quantity * cents(i.priceSet.shopMoney.amount), 0) +
    shipping.reduce((s, l) => s + cents(l.priceSet.shopMoney.amount), 0)
  );
}

describe("buildOrderCreateInput", () => {
  it("produces a PAID order whose total equals what Whop charged", () => {
    const order = buildOrderCreateInput(base);
    expect(order.financialStatus).toBe("PAID");
    expect(sum(order)).toBe(base.totalCents);
    const tx = (order.transactions as { amountSet: { shopMoney: { amount: string } }; gateway: string; kind: string }[])[0];
    expect(tx).toMatchObject({ gateway: "Whop", kind: "SALE" });
    expect(tx.amountSet.shopMoney.amount).toBe("57.38");
  });

  it("adds fee-style add-ons as custom lines and records the payment", () => {
    const order = buildOrderCreateInput(base);
    const items = order.lineItems as Record<string, unknown>[];
    expect(items.at(-1)).toMatchObject({ title: "Emballage cadeau", quantity: 1, requiresShipping: false });
    expect(order.sourceIdentifier).toBe("sess_1");
    expect(order.tags).toContain("test");
  });

  it("records free-shipping codes as Shopify discount codes only when shipping was free as paid", () => {
    const free = buildOrderCreateInput({ ...base, shipping: { title: "Colissimo", priceCents: 0 }, discount: { code: "FREESHIP", amountCents: 0, freeShipping: true }, totalCents: 5500 + 299 });
    expect(free.discountCode).toEqual({ freeShippingDiscountCode: { code: "FREESHIP" } });
    expect(sum(free)).toBe(5500 + 299);
    // Shipping still paid (e.g. rate above the code's maximum): Shopify would zero it, so note only.
    const paid = buildOrderCreateInput({ ...base, discount: { code: "FREESHIP", amountCents: 0, freeShipping: true }, totalCents: 5500 + 490 + 299 });
    expect(paid.discountCode).toBeUndefined();
    expect(paid.note).toContain("FREESHIP");
    expect(sum(paid)).toBe(5500 + 490 + 299);
  });
});

describe("normalizeShopDomain", () => {
  it("accepts handles and URLs, rejects foreign domains", () => {
    expect(normalizeShopDomain("ma-boutique")).toBe("ma-boutique.myshopify.com");
    expect(normalizeShopDomain("https://Ma-Boutique.myshopify.com/admin")).toBe("ma-boutique.myshopify.com");
    expect(normalizeShopDomain("evil.com")).toBeNull();
    expect(normalizeShopDomain("x.myshopify.com.evil.com")).toBeNull();
  });
});

describe("verifyOauthHmac", () => {
  it("verifies Shopify's query signature", () => {
    const secret = "shpss_test";
    const params = new URLSearchParams({ code: "abc", shop: "s.myshopify.com", state: "st", timestamp: "1700000000" });
    const msg = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("&");
    params.set("hmac", createHmac("sha256", secret).update(msg).digest("hex"));
    expect(verifyOauthHmac(params, secret)).toBe(true);
    params.set("code", "tampered");
    expect(verifyOauthHmac(params, secret)).toBe(false);
  });
});
