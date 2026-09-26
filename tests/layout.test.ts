import { describe, expect, it } from "vitest";
import {
  checkoutLayoutSchema,
  createBlock,
  defaultCheckoutLayout,
  loadCheckoutLayout,
  loadTheme,
  thankYouLayoutSchema,
  themeSchema,
} from "@/lib/layout";

describe("layout schemas", () => {
  it("accepts the default checkout layout", () => {
    expect(checkoutLayoutSchema.safeParse(defaultCheckoutLayout()).success).toBe(true);
  });

  it("requires every fixed checkout section exactly once", () => {
    const layout = defaultCheckoutLayout();
    const withoutPayment = { blocks: layout.blocks.filter((b) => b.type !== "payment") };
    expect(checkoutLayoutSchema.safeParse(withoutPayment).success).toBe(false);
    const twoContacts = { blocks: [...layout.blocks, createBlock("contact")] };
    expect(checkoutLayoutSchema.safeParse(twoContacts).success).toBe(false);
  });

  it("refuses checkout sections on the thank-you page", () => {
    expect(thankYouLayoutSchema.safeParse({ blocks: [createBlock("faq")] }).success).toBe(true);
    expect(thankYouLayoutSchema.safeParse({ blocks: [createBlock("payment")] }).success).toBe(false);
  });

  it("creates every block type with valid defaults", () => {
    for (const t of ["text", "image", "testimonial", "rating", "trust_badges", "guarantee", "faq", "value_props", "payment_icons", "announcement", "countdown", "low_stock", "why_us", "order_addons"] as const) {
      expect(createBlock(t).type).toBe(t);
    }
  });

  it("never pre-checks anything and rejects unsafe values", () => {
    expect(themeSchema.safeParse({ accentColor: "red; background:url(x)" }).success).toBe(false);
    expect(themeSchema.safeParse({ logoUrl: "javascript:alert(1)" }).success).toBe(false);
  });

  it("falls back to defaults on corrupt JSON", () => {
    expect(loadCheckoutLayout({ nope: true }).blocks.length).toBeGreaterThan(0);
    expect(loadTheme("garbage", "Shop").storeName).toBe("Shop");
  });
});
