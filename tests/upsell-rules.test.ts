import { describe, expect, it } from "vitest";
import { createBlock, currentOffer, downsellCycle, downsellTargets, loadThankYouLayout, offerReachable, upsellRoots, type BlockOf } from "@/lib/layout";
import {
  matchingUpsellIds,
  upsellAmountCents,
  upsellConditionsMet,
  upsellContextOf,
  upsellOfferable,
  upsellQuantity,
  type UpsellContext,
} from "@/lib/upsell";

type Upsell = BlockOf<"upsell">;

function offer(id: string, props: Partial<Upsell["props"]> = {}): Upsell {
  const b = createBlock("upsell", { id });
  return { ...b, props: { ...b.props, variantId: "123", ...props } };
}

const ctx: UpsellContext = { subtotalCents: 5000, productIds: ["gid://shopify/Product/42"], country: "FR" };

describe("upsell targeting", () => {
  it("matches every order without conditions", () => {
    expect(upsellConditionsMet(offer("a"), ctx)).toBe(true);
  });

  it("checks the subtotal range in major units", () => {
    expect(upsellConditionsMet(offer("a", { conditions: { minSubtotal: 50, productIds: [], countries: [] } }), ctx)).toBe(true);
    expect(upsellConditionsMet(offer("a", { conditions: { minSubtotal: 50.01, productIds: [], countries: [] } }), ctx)).toBe(false);
    expect(upsellConditionsMet(offer("a", { conditions: { maxSubtotal: 49.99, productIds: [], countries: [] } }), ctx)).toBe(false);
    expect(upsellConditionsMet(offer("a", { conditions: { maxSubtotal: 50, productIds: [], countries: [] } }), ctx)).toBe(true);
  });

  it("requires one of the products, whatever the id format", () => {
    const withProducts = (ids: string[]) => offer("a", { conditions: { productIds: ids, countries: [] } });
    expect(upsellConditionsMet(withProducts(["gid://shopify/Product/42"]), ctx)).toBe(true);
    expect(upsellConditionsMet(withProducts(["42", "7"]), ctx)).toBe(true);
    expect(upsellConditionsMet(withProducts(["gid://shopify/Product/7"]), ctx)).toBe(false);
  });

  it("checks the shipping country", () => {
    const inCountries = (c: string[]) => offer("a", { conditions: { productIds: [], countries: c } });
    expect(upsellConditionsMet(inCountries(["BE", "FR"]), ctx)).toBe(true);
    expect(upsellConditionsMet(inCountries(["BE"]), ctx)).toBe(false);
    expect(upsellConditionsMet(inCountries(["FR"]), { ...ctx, country: null })).toBe(false);
  });

  it("reads the context from the paid session (relay point country as fallback)", () => {
    const c = upsellContextOf({
      lines: [{ productId: "gid://shopify/Product/1", unitPriceCents: 1000, quantity: 2 }] as never,
      subtotalCents: 0,
      shippingAddress: null,
      pickupPoint: { countryCode: "be" } as never,
    });
    expect(c).toEqual({ subtotalCents: 2000, productIds: ["gid://shopify/Product/1"], country: "BE", units: 2 });
  });

  it("lists the matching offers", () => {
    const blocks = [offer("a"), offer("b", { conditions: { productIds: [], countries: ["DE"] } })];
    expect(matchingUpsellIds(blocks, ctx)).toEqual(["a"]);
  });
});

describe("downsell chains", () => {
  const a = offer("a", { declineNextId: "b" });
  const b = offer("b");
  const c = offer("c");
  const blocks = [a, b, c];
  const all = () => true;

  it("only roots open a slot; a downsell target waits for the decline", () => {
    expect([...downsellTargets(blocks)]).toEqual(["b"]);
    expect(upsellRoots(blocks).map((x) => x.id)).toEqual(["a", "c"]);
    expect(currentOffer(blocks, "a", {}, all)).toBe("a");
    expect(currentOffer(blocks, "a", { a: "DECLINED" }, all)).toBe("b");
    expect(currentOffer(blocks, "a", { a: "DECLINED", b: "DECLINED" }, all)).toBeNull();
    expect(currentOffer(blocks, "a", { a: "PAID" }, all)).toBe("a");
  });

  it("refuses a downsell before its offer was declined", () => {
    expect(offerReachable(blocks, "b", {}, all)).toBe(false);
    expect(offerReachable(blocks, "b", { a: "DECLINED" }, all)).toBe(true);
    expect(upsellOfferable(blocks, "b", ctx, {})).toBe(false);
    expect(upsellOfferable(blocks, "b", ctx, { a: "DECLINED" })).toBe(true);
    expect(upsellOfferable(blocks, "a", ctx, { a: "DECLINED" })).toBe(false);
    expect(upsellOfferable(blocks, "c", ctx, {})).toBe(true);
  });

  it("skips the chain when the first offer does not match the order", () => {
    const targeted = [offer("a", { declineNextId: "b", conditions: { productIds: ["999"], countries: [] } }), b];
    expect(upsellOfferable(targeted, "a", ctx, {})).toBe(false);
    expect(upsellOfferable(targeted, "b", ctx, { a: "DECLINED" })).toBe(false);
  });

  it("stops on cycles and self references", () => {
    const loop = [offer("x", { declineNextId: "y" }), offer("y", { declineNextId: "x" })];
    expect(upsellRoots(loop)).toEqual([]);
    expect(currentOffer(loop, "x", { x: "DECLINED", y: "DECLINED" }, all)).toBeNull();
    const self = [offer("s", { declineNextId: "s" })];
    expect(upsellRoots(self).map((x) => x.id)).toEqual(["s"]);
    expect(currentOffer(self, "s", { s: "DECLINED" }, all)).toBeNull();
    expect(downsellCycle(blocks, "b", "a")).toBe(true);
    expect(downsellCycle(blocks, "c", "a")).toBe(false);
    expect(downsellCycle(blocks, "a", "a")).toBe(true);
  });
});

describe("offer quantity", () => {
  it("accepts 1..maxQuantity only", () => {
    expect(upsellQuantity(offer("a"), undefined)).toBe(1);
    expect(upsellQuantity(offer("a"), 2)).toBeNull();
    expect(upsellQuantity(offer("a", { maxQuantity: 3 }), 3)).toBe(3);
    expect(upsellQuantity(offer("a", { maxQuantity: 3 }), 4)).toBeNull();
    expect(upsellQuantity(offer("a", { maxQuantity: 3 }), 0)).toBeNull();
    expect(upsellQuantity(offer("a", { maxQuantity: 3 }), 1.5)).toBeNull();
  });

  it("charges the unit price times the quantity", () => {
    expect(upsellAmountCents(offer("a", { price: 19.9 }), 3)).toBe(5970);
  });
});

describe("stored layouts", () => {
  it("keeps older offers valid with the new defaults", () => {
    const legacy = {
      blocks: [
        {
          id: "old",
          type: "upsell",
          props: { badge: "", title: "T", text: "", variantId: "1", imageUrl: "", price: 10, compareAt: 0, buttonText: "Oui", declineText: "Non" },
        },
      ],
    };
    const block = loadThankYouLayout(legacy).blocks.find((b) => b.id === "old") as Upsell;
    expect(block.props.maxQuantity).toBe(1);
    expect(block.props.conditions).toEqual({ productIds: [], countries: [] });
    expect(block.props.declineNextId).toBeUndefined();
  });
});
