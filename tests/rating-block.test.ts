import { describe, expect, it } from "vitest";
import {
  checkoutLayoutSchema,
  createBlock,
  formatRatingScore,
  LEGACY_RATING_DEFAULT_SCORE,
  loadCheckoutLayout,
  loadThankYouLayout,
  migrateRatingProps,
  ratingIsSet,
  type BlockOf,
} from "@/lib/layout";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ContentBlock, isEmptyInLive, type ContentContext } from "@/components/checkout/blocks";
import { labelsFor, type Lang } from "@/components/checkout/i18n";

const rating = (props: Partial<BlockOf<"rating">["props"]>): BlockOf<"rating"> => {
  const b = createBlock("rating") as BlockOf<"rating">;
  return { ...b, props: { ...b.props, ...props } };
};

describe("rating block: formatting", () => {
  it("formats the score with one decimal in the buyer's locale", () => {
    expect(formatRatingScore(4.8, "fr-FR")).toBe("4,8");
    expect(formatRatingScore(4.8, "en-US")).toBe("4.8");
    expect(formatRatingScore(4.8, "de-DE")).toBe("4,8");
    expect(formatRatingScore(5, "fr-FR")).toBe("5,0");
    // Floored, never rounded up.
    expect(formatRatingScore(4.75, "en-US")).toBe("4.7");
    expect(formatRatingScore(4.96, "fr-FR")).toBe("4,9");
    expect(formatRatingScore(4.3, "fr-FR")).toBe("4,3");
    expect(formatRatingScore(4.1, "en-US")).toBe("4.1");
    expect(formatRatingScore(0, "it-IT")).toBe("0,0");
  });
});

describe("rating block: defaults", () => {
  it("creates new blocks with no score (nothing invented)", () => {
    const b = createBlock("rating") as BlockOf<"rating">;
    expect(b.props.score).toBeNull();
    expect(b.props.count).toBe(0);
    expect(ratingIsSet(b.props)).toBe(false);
  });

  it("is hidden on the live checkout until a score is entered, shown in the builder", () => {
    const live = { preview: false } as unknown as ContentContext;
    const preview = { preview: true } as unknown as ContentContext;
    expect(isEmptyInLive(rating({ score: null }), live, 0)).toBe(true);
    expect(isEmptyInLive(rating({ score: null }), preview, 0)).toBe(false);
    expect(isEmptyInLive(rating({ score: 4.6, scoreSet: true }), live, 0)).toBe(false);
  });

  it("saves layouts with an unset score", () => {
    const layout = loadCheckoutLayout(null);
    layout.blocks.push(createBlock("rating"));
    expect(checkoutLayoutSchema.safeParse(layout).success).toBe(true);
  });
});

describe("rating block: migration of saved layouts", () => {
  it("treats the untouched old default (4.8, 0 reviews) as unset", () => {
    expect(migrateRatingProps(rating({ score: LEGACY_RATING_DEFAULT_SCORE, count: 0 }).props).score).toBeNull();
  });

  it("keeps real scores: another value, a review count, or a typed 4.8", () => {
    expect(migrateRatingProps(rating({ score: 4.7, count: 0 }).props).score).toBe(4.7);
    expect(migrateRatingProps(rating({ score: 4.8, count: 132 }).props).score).toBe(4.8);
    expect(migrateRatingProps(rating({ score: 4.8, count: 0, scoreSet: true }).props).score).toBe(4.8);
  });

  it("applies when loading stored layouts", () => {
    const stored = (props: object) => ({ blocks: [{ id: "r1", type: "rating", props: { label: "note", ...props } }] });
    const find = (blocks: { type: string }[]) => blocks.find((b) => b.type === "rating") as BlockOf<"rating">;
    expect(find(loadCheckoutLayout(stored({ score: 4.8, count: 0 })).blocks).props.score).toBeNull();
    expect(find(loadThankYouLayout(stored({ score: 4.8, count: 0 })).blocks).props.score).toBeNull();
    expect(find(loadCheckoutLayout(stored({ score: 4.9, count: 0 })).blocks).props.score).toBe(4.9);
    expect(find(loadCheckoutLayout(stored({ score: 4.8, count: 57 })).blocks).props.score).toBe(4.8);
  });
});

describe("rating block: rendering", () => {
  const ctx = (lang: Lang, preview = false): ContentContext => ({
    labels: labelsFor(lang),
    lang,
    lowestInventory: null,
    preview,
    subtotalCents: 0,
    freeShippingThresholdCents: null,
    money: (c) => String(c),
    note: "",
    setNote: () => {},
  });
  const html = (block: BlockOf<"rating">, c: ContentContext) => renderToStaticMarkup(createElement(ContentBlock, { block, ctx: c }));

  it("shows the score with the buyer's decimal separator", () => {
    const b = rating({ score: 4.7, count: 1200, scoreSet: true });
    expect(html(b, ctx("fr"))).toContain("4,7/5");
    expect(html(b, ctx("en"))).toContain("4.7/5");
    expect(html(b, ctx("de"))).toContain("4,7/5");
  });

  it("renders nothing live and a « À compléter » placeholder in the builder when unset", () => {
    const b = rating({ score: null });
    expect(html(b, ctx("fr"))).toBe("");
    expect(html(b, ctx("fr", true))).toContain("À compléter");
  });
});
