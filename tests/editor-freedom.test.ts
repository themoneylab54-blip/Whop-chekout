// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/*
 * « Plus de blocages dans l'éditeur »: blocks in several copies, required but movable sections,
 * raised caps (schema + editor counters), bundle limits, merchant content never hidden.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", () => ({
  WhopCheckoutEmbed: () => null,
  WhopExpressCheckoutButton: () => null,
  useCheckoutEmbedControls: () => ({ current: null }),
}));
vi.mock("@/components/checkout/Payment", async (orig) => ({ ...(await orig<typeof import("@/components/checkout/Payment")>()), PaymentPanel: () => null }));

const { ThankYouView } = await import("@/components/checkout/ThankYouView");
const { arrangeCheckout } = await import("@/components/checkout/CheckoutView");
const { ContentBlock, isEmptyInLive } = await import("@/components/checkout/blocks");
const L = await import("@/lib/layout");
const { lengthHintText, listLimitText } = await import("@/components/builder/BlockEditor");
const { layoutWarnings } = await import("@/components/builder/placement");
const { MAX_GIFT_TIERS, MAX_PERCENT_TIERS, TIER_LIMITS, parseQuantityBreaks, tierOrderWarnings, validateQuantityTiers } = await import("@/lib/pricing");
const { SAMPLE_LINES } = await import("@/lib/sample");
const { LABELS } = await import("@/components/checkout/i18n");

type Block = import("@/lib/layout").Block;
type BlockOf<T extends Block["type"]> = import("@/lib/layout").BlockOf<T>;
type Data = ComponentProps<typeof ThankYouView>["data"];

const { createBlock, checkoutLayoutSchema, thankYouLayoutSchema, defaultCheckoutLayout, defaultThankYouLayout, loadCheckoutLayout, loadThankYouLayout } = L;

const liveCtx = {
  labels: LABELS.fr,
  lang: "fr",
  lowestInventory: null,
  preview: false,
  subtotalCents: 0,
  freeShippingThresholdCents: null,
  money: (c: number) => `${c}`,
  note: "",
  setNote: () => undefined,
} as unknown as Parameters<typeof isEmptyInLive>[1];

/** A new block with the given props. */
function own<T extends Block["type"]>(type: T, props: Partial<BlockOf<T>["props"]> = {}): BlockOf<T> {
  const b = createBlock(type);
  return { ...b, props: { ...b.props, ...props } } as BlockOf<T>;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("blocks in several copies", () => {
  it("keeps singletons only where a second copy would break the order", () => {
    expect([...L.SINGLETON_BLOCKS].sort()).toEqual(["order_addons", "order_note", "recommendations", "shipping_protection", "survey"]);
    for (const t of ["reviews", "faq", "benefits", "guarantee", "trust_badges", "stats", "countdown", "announcement", "coupon", "text", "comparison", "why_us", "free_shipping_bar"] as const)
      expect(L.SINGLETON_BLOCKS.has(t), t).toBe(false);
  });

  it("two FAQ, reviews, guarantees, announcements… are saved and loaded, each with its own id", () => {
    const extra = [own("faq"), own("faq"), own("reviews"), own("reviews"), own("guarantee"), own("guarantee"), own("announcement"), own("announcement"), own("stats"), own("stats")];
    const layout = { blocks: [...defaultCheckoutLayout().blocks, ...extra] };
    expect(checkoutLayoutSchema.safeParse(layout).success).toBe(true);
    const loaded = loadCheckoutLayout(JSON.parse(JSON.stringify(layout)));
    expect(loaded.blocks.filter((b) => b.type === "faq")).toHaveLength(2);
    expect(loaded.blocks.filter((b) => b.type === "reviews")).toHaveLength(2);
    expect(loaded.blocks.filter((b) => b.type === "announcement")).toHaveLength(2);
    expect(new Set(loaded.blocks.map((b) => b.id)).size).toBe(loaded.blocks.length);
    // The checkout places every copy (reassurance column / form).
    const arranged = arrangeCheckout(loaded.blocks);
    const placed = [...arranged.main, ...arranged.side, ...arranged.after, ...arranged.summary].map((b) => b.id);
    for (const b of extra) expect(placed, b.type).toContain(b.id);
  });

  it("singletons are still deduplicated on load", () => {
    const a = createBlock("shipping_protection");
    const b = createBlock("shipping_protection");
    expect(L.dedupeSingletons([a, b]).map((x) => x.id)).toEqual([a.id]);
    const notes = loadCheckoutLayout({ blocks: [...defaultCheckoutLayout().blocks, createBlock("order_note"), createBlock("order_note")] });
    expect(notes.blocks.filter((x) => x.type === "order_note")).toHaveLength(1);
  });

  it("the thank-you page renders every copy (two FAQ, two coupons, two texts)", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const faq1 = own("faq", { items: [{ q: "Question A ?", a: "Réponse A." }] });
    const faq2 = own("faq", { items: [{ q: "Question B ?", a: "Réponse B." }] });
    const c1 = own("coupon", { code: "BIENVENUE" });
    const c2 = own("coupon", { code: "FIDELE15" });
    const t1 = own("text", { heading: "Premier texte", body: "Un" });
    const t2 = own("text", { heading: "Second texte", body: "Deux" });
    const layout = { blocks: [...defaultThankYouLayout().blocks, faq1, c1, t1, faq2, c2, t2] };
    expect(thankYouLayoutSchema.safeParse(layout).success).toBe(true);
    const data: Data = {
      status: "PAID",
      orderName: "#1024",
      email: "alex@exemple.fr",
      firstName: "Alex",
      address: { name: "Alex Martin", lines: ["12 rue des Lilas", "75011 Paris"], countryCode: "FR" },
      lines: SAMPLE_LINES,
      currency: "EUR",
      subtotalCents: 8988,
      discountCents: 0,
      shippingCents: 490,
      addOnsCents: 0,
      totalCents: 9478,
      continueUrl: null,
    };
    const { container } = render(h(ThankYouView, { theme: L.defaultTheme("Boutique"), layout, data }));
    const text = container.textContent ?? "";
    for (const s of ["Question A ?", "Question B ?", "BIENVENUE", "FIDELE15", "Premier texte", "Second texte"]) expect(text, s).toContain(s);
    for (const b of [faq1, faq2, c1, c2, t1, t2]) expect(container.querySelectorAll(`[data-block-id="${b.id}"]`).length, b.id).toBeLessThanOrEqual(1);
  });
});

describe("required sections stay, and stay movable", () => {
  it("contact, delivery, shipping method and payment are required exactly once, in any order", () => {
    const base = defaultCheckoutLayout();
    const reversed = { blocks: [...base.blocks].reverse() };
    expect(checkoutLayoutSchema.safeParse(reversed).success).toBe(true);
    for (const t of ["contact", "delivery", "shipping_method", "payment"] as const) {
      expect(checkoutLayoutSchema.safeParse({ blocks: base.blocks.filter((b) => b.type !== t) }).success, t).toBe(false);
      // A layout saved without it gets it back on load.
      expect(loadCheckoutLayout({ blocks: base.blocks.filter((b) => b.type !== t) }).blocks.some((b) => b.type === t), t).toBe(true);
    }
    // Thank-you sections: back on load, in place.
    const ty = loadThankYouLayout({ blocks: [own("faq"), ...defaultThankYouLayout().blocks.filter((b) => b.type !== "ty_details")] });
    expect(ty.blocks.map((b) => b.type)).toEqual(["faq", "ty_confirmation", "ty_details", "ty_summary"]);
  });
});

describe("raised caps", () => {
  it("lists: 50 FAQ / badges / benefits / logos / comparison rows / reasons / value props, 8 figures", () => {
    const valid = (b: unknown) => L.blockSchema.safeParse(b).success;
    const faq = createBlock("faq");
    expect(valid({ ...faq, props: { items: Array.from({ length: 50 }, (_, i) => ({ q: `Q${i}`, a: "a".repeat(5000) })) } })).toBe(true);
    expect(valid({ ...faq, props: { items: Array.from({ length: 51 }, () => ({ q: "Q", a: "a" })) } })).toBe(false);
    const stats = createBlock("stats");
    expect(valid({ ...stats, props: { items: Array.from({ length: 8 }, () => ({ value: "1", label: "x" })) } })).toBe(true);
    expect(valid({ ...stats, props: { items: Array.from({ length: 9 }, () => ({ value: "1", label: "x" })) } })).toBe(false);
    const badges = createBlock("trust_badges");
    expect(valid({ ...badges, props: { badges: Array.from({ length: 50 }, () => ({ label: "x", iconUrl: "" })) } })).toBe(true);
    const benefits = createBlock("benefits");
    expect(valid({ ...benefits, props: { ...benefits.props, items: Array.from({ length: 50 }, () => ({ icon: "check", title: "t", text: "x" })) } })).toBe(true);
    const comparison = createBlock("comparison");
    expect(valid({ ...comparison, props: { ...comparison.props, rows: Array.from({ length: 50 }, () => ({ label: "l", us: true, them: false })) } })).toBe(true);
    const logos = createBlock("logos");
    expect(valid({ ...logos, props: { ...logos.props, logos: Array.from({ length: 50 }, () => ({ imageUrl: "", alt: "" })) } })).toBe(true);
    for (const [k, v] of Object.entries(L.LIST_LIMITS)) expect(v, k).toBe(k === "stats" ? 8 : 50);
  });

  it("texts: text body 10 000, FAQ answer / guarantee / testimonial 5 000, titles 300", () => {
    const valid = (b: unknown) => L.blockSchema.safeParse(b).success;
    const text = createBlock("text");
    expect(valid({ ...text, props: { heading: "h".repeat(300), body: "b".repeat(10000) } })).toBe(true);
    expect(valid({ ...text, props: { heading: "h", body: "b".repeat(10001) } })).toBe(false);
    const g = createBlock("guarantee");
    expect(valid({ ...g, props: { title: "t".repeat(300), text: "x".repeat(5000) } })).toBe(true);
    const t = createBlock("testimonial");
    expect(valid({ ...t, props: { ...t.props, quote: "q".repeat(5000) } })).toBe(true);
    expect(valid({ ...t, props: { ...t.props, quote: "q".repeat(5001) } })).toBe(false);
    // A long merchant translation fits too.
    expect(valid({ ...text, props: { heading: "h", body: "b" }, i18n: { en: { body: "e".repeat(10000) } } })).toBe(true);
  });

  it("120 blocks per page (schema and loader)", () => {
    const fill = (n: number) => ({ blocks: [...defaultCheckoutLayout().blocks, ...Array.from({ length: n - defaultCheckoutLayout().blocks.length }, () => own("spacer"))] });
    expect(L.MAX_BLOCKS_PER_PAGE).toBe(120);
    expect(checkoutLayoutSchema.safeParse(fill(120)).success).toBe(true);
    expect(checkoutLayoutSchema.safeParse(fill(121)).success).toBe(false);
    expect(loadCheckoutLayout(fill(100)).blocks).toHaveLength(100);
  });

  it("one-click offers: 5 in a row, up to 50 units", () => {
    expect(L.MAX_OFFER_DEPTH).toBe(5);
    expect(L.MAX_OFFER_QUANTITY).toBe(50);
    const up = createBlock("upsell");
    expect(L.blockSchema.safeParse({ ...up, props: { ...up.props, maxQuantity: 50 } }).success).toBe(true);
    expect(L.blockSchema.safeParse({ ...up, props: { ...up.props, maxQuantity: 51 } }).success).toBe(false);
  });

  it("the editor counts down near a limit instead of failing on save", () => {
    expect(listLimitText(10, 50)).toBeNull();
    expect(listLimitText(40, 50)).toBe("40 / 50 — encore 10 possibles");
    expect(listLimitText(49, 50)).toBe("49 / 50 — encore 1 possible");
    expect(listLimitText(50, 50)).toBe("Maximum atteint : 50 éléments");
    expect(lengthHintText(100, 300)).toBeNull();
    expect(lengthHintText(280, 300)).toBe("280 / 300 caractères — encore 20");
    expect(lengthHintText(300, 300)).toBe("Maximum atteint (300 caractères)");
    expect(lengthHintText(5, undefined)).toBeNull();
  });
});

describe("bundles: 20 tiers, 10 gifts, up to 90 %", () => {
  it("accepts the new bounds and refuses beyond them", () => {
    expect(MAX_PERCENT_TIERS).toBe(20);
    expect(MAX_GIFT_TIERS).toBe(10);
    const tiers = Array.from({ length: 20 }, (_, i) => ({ minQty: i + 2, percent: Math.min(90, 5 + i * 4) }));
    expect(validateQuantityTiers(tiers).ok).toBe(true);
    expect(validateQuantityTiers([...tiers, { minQty: 40, percent: 90 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ minQty: 2, percent: 90 }]).ok).toBe(true);
    expect(validateQuantityTiers([{ minQty: 2, percent: 90.5 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ minQty: TIER_LIMITS.maxQty, percent: 10 }]).ok).toBe(true);
    expect(validateQuantityTiers([{ minQty: TIER_LIMITS.maxQty + 1, percent: 10 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ kind: "bxgy", minQty: 100, freeQty: 50 }]).ok).toBe(true);
    expect(validateQuantityTiers([{ kind: "bxgy", minQty: 101, freeQty: 1 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ kind: "bxgy", minQty: 2, freeQty: 51 }])).toMatchObject({ ok: false });
    expect(validateQuantityTiers([{ type: "gift", minQty: 1000, variantId: "1", title: "x" }]).ok).toBe(true);
  });

  it("a bigger tier with a smaller discount is a note, never a refusal", () => {
    const raw = [
      { minQty: 2, percent: 15 },
      { minQty: 3, percent: 10 },
      { minQty: 3, percent: 5, productIds: ["gid://shopify/Product/1"] },
    ];
    expect(validateQuantityTiers(raw).ok).toBe(true);
    expect(tierOrderWarnings(parseQuantityBreaks(raw))).toEqual(["Palier dès 3 articles : 10 %, pas plus que le palier précédent (15 %)"]);
    expect(tierOrderWarnings(parseQuantityBreaks([{ minQty: 2, percent: 10 }, { minQty: 3, percent: 15 }]))).toEqual([]);
  });
});

describe("merchant content is never hidden", () => {
  it("a new figures block starts empty (nothing invented), with no warning; the merchant's figures show as written", () => {
    const stats = createBlock("stats") as BlockOf<"stats">;
    expect(stats.sample).toBeUndefined();
    expect(stats.props.items).toEqual([]);
    expect(isEmptyInLive(stats, liveCtx, 0)).toBe(true);
    expect(layoutWarnings([stats])).toEqual({});
    const own = { ...stats, props: { items: [{ value: "4,8/5", label: "note moyenne" }] } };
    expect(isEmptyInLive(own, liveCtx, 0)).toBe(false);
    expect(layoutWarnings([own])).toEqual({});
  });

  it("figures added and never filled in (« Ajouter un chiffre ») show nothing live", () => {
    const blank = own("stats", { items: [{ value: "", label: "" }, { value: " ", label: "" }] });
    expect(isEmptyInLive(blank, liveCtx, 0)).toBe(true);
    const mixed = own("stats", { items: [{ value: "", label: "" }, { value: "4,8/5", label: "note moyenne" }] });
    expect(isEmptyInLive(mixed, liveCtx, 0)).toBe(false);
    const { container } = render(h(ContentBlock, { block: mixed, ctx: liveCtx }));
    // One figure card only (the blank one is skipped).
    expect(container.querySelectorAll(".grid > div")).toHaveLength(1);
    expect(container.textContent).toContain("4,8/5");
  });

  it("a new text block and a new « Pourquoi nous » row start empty: nothing placeholder reaches buyers", () => {
    const text = createBlock("text") as BlockOf<"text">;
    expect(text.props).toEqual({ heading: "", body: "" });
    expect(isEmptyInLive(text, liveCtx, 0)).toBe(true);
    expect(render(h(ContentBlock, { block: text, ctx: liveCtx })).container.textContent).toBe("");
    const why = own("why_us", { rows: [{ icon: "check", title: "", text: "" }] });
    expect(isEmptyInLive(why, liveCtx, 0)).toBe(true);
    const withOwn = own("why_us", { rows: [{ icon: "check", title: "", text: "" }, { icon: "truck", title: "Envoi sous 24 h", text: "" }] });
    expect(isEmptyInLive(withOwn, liveCtx, 0)).toBe(false);
    const { container } = render(h(ContentBlock, { block: withOwn, ctx: liveCtx }));
    expect(container.textContent).toContain("Envoi sous 24 h");
    expect(container.querySelectorAll(".flex.items-start")).toHaveLength(1);
    // The editor's new row is blank (placeholders only in the builder).
    const src = readFileSync(resolve(__dirname, "../src/components/builder/BlockEditor.tsx"), "utf8");
    expect(src).toContain('create={() => ({ icon: "check" as const, title: "", text: "" })}');
    expect(src).not.toContain('title: "Titre", text: "Texte"');
  });

  it("a bigger tier with a smaller discount is a plain grey information line, not a warning box", () => {
    const src = readFileSync(resolve(__dirname, "../src/components/dashboard/QuantityBreaksEditor.tsx"), "utf8");
    expect(src).not.toContain("À vérifier");
    expect(src).not.toMatch(/orderNotes[\s\S]{0,200}amber/);
  });
});

describe("upsell « Autre » quantity field", () => {
  it("can be cleared while typing; a valid number applies, anything else goes back on blur", async () => {
    const { fireEvent } = await import("@testing-library/react");
    const { useState } = await import("react");
    const { UpsellQuantity } = await import("@/components/builder/UpsellRules");
    const seen: number[] = [];
    function Harness() {
      const [block, setBlock] = useState(createBlock("upsell") as BlockOf<"upsell">);
      return h(UpsellQuantity, {
        block,
        onChange: (b: BlockOf<"upsell">) => {
          seen.push(b.props.maxQuantity);
          setBlock(b);
        },
      });
    }
    const { container } = render(h(Harness));
    const input = container.querySelector<HTMLInputElement>('input[type="number"]')!;
    const start = input.value;
    fireEvent.change(input, { target: { value: "" } });
    // Cleared: the field stays empty while typing (no value forced back), nothing saved.
    expect(input.value).toBe("");
    expect(seen).toEqual([]);
    fireEvent.change(input, { target: { value: "7" } });
    expect(input.value).toBe("7");
    expect(seen).toEqual([7]);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    // Left empty: back to the saved value.
    expect(input.value).toBe("7");
    expect(start).not.toBe("");
  });
});
