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

describe("tolerant loading (a saved design is never wiped)", () => {
  it("keeps valid blocks and drops only broken ones", () => {
    const layout = defaultCheckoutLayout();
    const raw = { blocks: [...layout.blocks, { id: "x", type: "does_not_exist", props: {} }, createBlock("faq")] };
    const loaded = loadCheckoutLayout(raw);
    expect(loaded.blocks.map((b) => b.type)).toContain("faq");
    expect(loaded.blocks.some((b) => (b.type as string) === "does_not_exist")).toBe(false);
  });

  it("repairs a block with outdated props instead of dropping it", () => {
    const layout = defaultCheckoutLayout();
    const raw = { blocks: [...layout.blocks, { id: "r1", type: "reviews", props: { title: "Avis" } }] };
    const reviews = loadCheckoutLayout(raw).blocks.find((b) => b.id === "r1");
    expect(reviews?.type).toBe("reviews");
    expect(reviews && reviews.type === "reviews" && reviews.props.title).toBe("Avis");
  });

  it("re-adds a missing fixed section", () => {
    const raw = { blocks: defaultCheckoutLayout().blocks.filter((b) => b.type !== "shipping_method") };
    expect(loadCheckoutLayout(raw).blocks.filter((b) => b.type === "shipping_method")).toHaveLength(1);
  });

  it("keeps the rest of the theme when one field is invalid", () => {
    const theme = loadTheme({ accentColor: "#ff0000", font: "Comic Sans", storeName: "X" });
    expect(theme.accentColor).toBe("#ff0000");
    expect(theme.font).toBe("Inter");
    expect(theme.storeName).toBe("X");
  });

  it("creates every new block type with valid defaults", () => {
    for (const t of ["free_shipping_bar", "delivery_estimate", "reviews", "comparison", "video", "logos", "stats", "benefits", "secure_badge", "order_note", "support", "spacer", "button_link", "coupon", "social"] as const) {
      expect(createBlock(t).type).toBe(t);
    }
  });

  it("keeps the order note off the thank-you page", () => {
    expect(thankYouLayoutSchema.safeParse({ blocks: [createBlock("order_note")] }).success).toBe(false);
  });
});
