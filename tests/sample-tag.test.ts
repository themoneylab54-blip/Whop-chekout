import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBlock, loadCheckoutLayout, loadThankYouLayout, themeSchema, type Block, type BlockOf } from "@/lib/layout";
import { isSampleReview, liveReviewItems } from "@/lib/sample-content";
import { ContentBlock, isEmptyInLive, offeredPaymentLogos, type ContentContext } from "@/components/checkout/blocks";
import { labelsFor } from "@/components/checkout/i18n";
import { layoutWarnings, reviewNotes, setupWarnings } from "@/components/builder/placement";
import { canonicalTemplateId, CHECKOUT_TEMPLATES, matchingCheckout, matchingThankYou, THANK_YOU_TEMPLATES } from "@/components/builder/templates";
import { diffTheme } from "@/components/builder/changes";

const ctx = (preview: boolean): ContentContext =>
  ({
    labels: labelsFor("fr"),
    lang: "fr",
    lowestInventory: null,
    preview,
    subtotalCents: 0,
    freeShippingThresholdCents: null,
    money: (c: number) => String(c),
    note: "",
    setNote: () => {},
    cartProducts: null,
  }) as ContentContext;
const live = ctx(false);
const html = (b: Block, c = live) => renderToStaticMarkup(createElement(ContentBlock, { block: b, ctx: c }));

/** Blocks as published before sample content was hidden (HEAD defaults, no `sample` tag). */
const OLD_CHECKOUT = {
  blocks: [
    { id: "ann1", type: "announcement", props: { text: "Livraison offerte dès 50 € d'achat" } },
    {
      id: "rev1",
      type: "reviews",
      props: {
        title: "Ce que disent nos clients",
        layout: "stack",
        items: [
          { name: "Camille R.", text: "Commande reçue en 3 jours, qualité au top. Je recommande !", stars: 5, verified: true },
          { name: "Yanis B.", text: "Service client réactif et produit conforme aux photos.", stars: 5, verified: true },
        ],
      },
    },
    { id: "st1", type: "stats", props: { items: [{ value: "+10 000", label: "clients satisfaits" }, { value: "48 h", label: "expédition" }] } },
    { id: "tx1", type: "text", props: { heading: "Titre", body: "Votre texte ici." } },
  ],
};
const OLD_THANK_YOU = {
  blocks: [{ id: "cp1", type: "coupon", props: { title: "Merci ! Voici un cadeau", text: "Profitez de -10 % sur votre prochaine commande.", code: "MERCI10" } }],
};
const SAMPLE_REVIEW_1 = { name: "Camille R.", text: "Commande reçue en 3 jours, qualité au top. Je recommande !", stars: 5, verified: false };

describe("what the builder shows is what buyers see", () => {
  it("an old untagged layout (MERCI10, announcement, figures) renders unchanged, without any warning; the old placeholder text loads empty", () => {
    const blocks = [...loadCheckoutLayout(OLD_CHECKOUT).blocks, ...loadThankYouLayout(OLD_THANK_YOU).blocks];
    const byId = (id: string) => blocks.find((b) => b.id === id)!;
    for (const id of ["ann1", "rev1", "st1", "tx1", "cp1"]) expect(byId(id).sample, id).toBeUndefined();
    for (const id of ["ann1", "st1", "cp1"]) expect(isEmptyInLive(byId(id), live, 0), id).toBe(false);
    // « Titre » / « Votre texte ici. » (exact old placeholders): emptied, so nothing shows live.
    expect(byId("tx1").props).toMatchObject({ heading: "", body: "" });
    expect(isEmptyInLive(byId("tx1"), live, 0)).toBe(true);
    // The untouched example reviews (invented customers) never reach buyers.
    expect(isEmptyInLive(byId("rev1"), live, 0)).toBe(true);
    expect(html(byId("ann1"))).toContain("Livraison offerte dès 50 €");
    expect(html(byId("cp1"))).toContain("MERCI10");
    expect(html(byId("st1"))).toContain("+10 000");
    expect(html(byId("tx1"))).not.toContain("Votre texte ici.");
    expect(layoutWarnings(blocks)).toEqual({});
    expect(reviewNotes(blocks)).toEqual({});
  });

  it("new blocks are never tagged and show live as created, with no warning; new reviews start empty", () => {
    for (const type of ["stats", "testimonial", "coupon", "announcement", "text", "guarantee", "faq", "benefits", "countdown", "social", "support", "button_link"] as const) {
      const b = createBlock(type);
      expect(b.sample, type).toBeUndefined();
      expect(setupWarnings([b]), type).toEqual({});
      expect(layoutWarnings([b]), type).toEqual({});
    }
    for (const type of ["announcement", "guarantee", "faq", "benefits"] as const)
      expect(isEmptyInLive(createBlock(type), live, 0), type).toBe(false);
    // Nothing invented: new figures, quote, gift code and text start empty and simply render nothing live.
    for (const type of ["stats", "testimonial", "coupon", "text"] as const) {
      expect(isEmptyInLive(createBlock(type), live, 0), type).toBe(true);
      expect(html(createBlock(type)), type).toBe("");
    }
    expect(html(createBlock("coupon"))).not.toContain("MERCI10");
    const reviews = createBlock("reviews") as BlockOf<"reviews">;
    expect(reviews.props.items).toEqual([]);
    // An empty reviews block simply renders nothing live.
    expect(isEmptyInLive(reviews, live, 0)).toBe(true);
  });

  it("only a product to choose is flagged", () => {
    const upsell = createBlock("upsell");
    const reco = createBlock("recommendations");
    expect(setupWarnings([upsell])[upsell.id]).toBe("Choisir un produit");
    expect(setupWarnings([reco])[reco.id]).toBe("Choisir les produits à proposer");
  });

  it("a review is a shipped example only with the name and the text together", () => {
    expect(isSampleReview(SAMPLE_REVIEW_1)).toBe(true);
    expect(isSampleReview({ name: "Camille R.", text: "Super produit, je rachète." })).toBe(false);
    expect(isSampleReview({ name: "Léa M.", text: SAMPLE_REVIEW_1.text })).toBe(false);
    // Swapped texts are not the shipped pairs.
    expect(isSampleReview({ name: "Yanis B.", text: SAMPLE_REVIEW_1.text })).toBe(false);
  });
});

describe("layouts tagged `sample` by an earlier version", () => {
  const extra = (blocks: unknown[]) => loadCheckoutLayout({ blocks }).blocks.filter((b) => !["express", "contact", "delivery", "shipping_method", "payment"].includes(b.type));

  it("load untagged; untouched example content stays out of buyers' sight (hidden), example reviews are dropped", () => {
    const [stats, text, coupon, reviews, onlySample] = extra([
      { id: "s", type: "stats", sample: true, props: { items: [{ value: "+10 000", label: "clients satisfaits" }] } },
      { id: "t", type: "text", sample: true, props: { heading: "Titre", body: "Votre texte ici." } },
      { id: "c", type: "coupon", sample: true, props: { title: "Cadeau", text: "", code: "MERCI10" } },
      {
        id: "r",
        type: "reviews",
        sample: true,
        props: { title: "Avis", layout: "stack", items: [SAMPLE_REVIEW_1, { name: "Léa", text: "Top, je recommande.", stars: 5, verified: false }, { name: "Vide", text: " ", stars: 5, verified: false }] },
      },
      { id: "r2", type: "reviews", sample: true, props: { title: "Avis", layout: "stack", items: [SAMPLE_REVIEW_1] } },
    ]);
    // Still the exact shipped example (never seen by buyers): hidden, content kept for the merchant.
    for (const b of [stats, text, coupon]) {
      expect(b.sample, b.id).toBeUndefined();
      expect(b.hidden, b.id).toBe(true);
    }
    expect(html(stats)).toContain("+10 000");
    expect(html(coupon)).toContain("MERCI10");
    expect(reviews.sample).toBeUndefined();
    expect((reviews as BlockOf<"reviews">).props.items.map((r) => r.name)).toEqual(["Léa"]);
    expect(liveReviewItems(reviews as BlockOf<"reviews">).map((r) => r.name)).toEqual(["Léa"]);
    // Only example reviews: nothing left, nothing shown live.
    expect((onlySample as BlockOf<"reviews">).props.items).toEqual([]);
    expect(isEmptyInLive(onlySample, live, 0)).toBe(true);
    // Loading twice gives the same layout (the builder tells a real edit from a normalisation).
    const once = extra([{ id: "r", type: "reviews", sample: true, props: { title: "Avis", layout: "stack", items: [SAMPLE_REVIEW_1] } }]);
    expect(extra(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it("a repaired block keeps the merchant's content and never gets example reviews back", () => {
    const [text, coupon, reviews] = extra([
      { id: "t", type: "text", props: { heading: "Livraison" } },
      { id: "c", type: "coupon", props: { title: "Cadeau", code: "VIP20" } },
      { id: "r", type: "reviews", props: { title: "Avis" } },
    ]);
    expect(text.sample).toBeUndefined();
    expect((text as BlockOf<"text">).props.heading).toBe("Livraison");
    expect((coupon as BlockOf<"coupon">).props).toMatchObject({ code: "VIP20", text: "" });
    expect((reviews as BlockOf<"reviews">).props.items).toEqual([]);
  });
});

describe("builder setup and templates", () => {
  it("an order bump titled by the merchant without an active add-on is a block to complete", () => {
    const layout = loadCheckoutLayout(null);
    layout.blocks.push(createBlock("order_addons"));
    const bump = layout.blocks.find((b) => b.type === "order_addons") as BlockOf<"order_addons">;
    bump.props.title = "Ajoutez à votre commande";
    expect(setupWarnings(layout.blocks, { hasAddOns: false })[bump.id]).toBe("Options : créez-en une dans « Promos & options » ou masquez ce bloc");
    expect(setupWarnings(layout.blocks, { hasAddOns: true })[bump.id]).toBeUndefined();
    expect(setupWarnings(layout.blocks)[bump.id]).toBeUndefined();
  });

  it("brand-free template id, old id mapped; matching pages both ways", () => {
    expect(CHECKOUT_TEMPLATES.some((t) => t.id === "apple-minimal")).toBe(false);
    expect(canonicalTemplateId("apple-minimal")).toBe("clean-minimal");
    expect(canonicalTemplateId("trust")).toBe("trust");
    expect(canonicalTemplateId(undefined)).toBeNull();
    const clean = CHECKOUT_TEMPLATES.find((t) => t.id === "clean-minimal")!;
    expect(matchingThankYou(clean)?.id).toBe("clean-minimal");
    expect(matchingCheckout(matchingThankYou(clean)!)).toBe(clean);
    expect(matchingCheckout(THANK_YOU_TEMPLATES.find((t) => t.id === "loyalty")!)).toBeNull();
  });

  it("the applied template is kept in the theme but is no publishable change", () => {
    const base = themeSchema.parse({});
    const applied = themeSchema.parse({ appliedTemplates: { checkout: "clean-minimal", thankYou: "simple" } });
    expect(applied.appliedTemplates).toEqual({ checkout: "clean-minimal", thankYou: "simple" });
    expect(diffTheme(applied, base)).toEqual([]);
  });

  it("payment header logos: only the methods this checkout offers", () => {
    const shipped = ["visa", "mastercard", "amex", "applepay", "gpay"];
    expect(offeredPaymentLogos(shipped, { applePay: false, googlePay: false })).toEqual(["visa", "mastercard", "amex"]);
    expect(offeredPaymentLogos([...shipped, "sepa", "crypto"], { applePay: true, googlePay: true })).toEqual(shipped);
  });
});
