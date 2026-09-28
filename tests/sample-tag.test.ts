import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBlock, loadCheckoutLayout, loadThankYouLayout, themeSchema, type Block, type BlockOf } from "@/lib/layout";
import { isSampleOnly, isSampleReview, isSampleStat, promiseWarnings, sampleWarnings, SAMPLE_PROMISE_WARNING } from "@/lib/sample-content";
import { ContentBlock, isEmptyInLive, offeredPaymentLogos, type ContentContext } from "@/components/checkout/blocks";
import { labelsFor } from "@/components/checkout/i18n";
import { localizeBlock } from "@/components/checkout/localize";
import { setupWarnings } from "@/components/builder/placement";
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
const preview = ctx(true);
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

describe("sample content: live pages never change on deploy", () => {
  it("an old published layout with MERCI10, the announcement, sample reviews / figures renders unchanged", () => {
    const blocks = [...loadCheckoutLayout(OLD_CHECKOUT).blocks, ...loadThankYouLayout(OLD_THANK_YOU).blocks];
    const byId = (id: string) => blocks.find((b) => b.id === id)!;
    for (const id of ["ann1", "rev1", "st1", "tx1", "cp1"]) {
      expect(byId(id).sample, id).toBeUndefined();
      expect(isSampleOnly(byId(id)), id).toBe(false);
      expect(isEmptyInLive(byId(id), live, 0), id).toBe(false);
    }
    expect(html(byId("ann1"))).toContain("Livraison offerte dès 50 €");
    expect(html(byId("cp1"))).toContain("MERCI10");
    const reviews = html(byId("rev1"));
    expect(reviews).toContain("Camille R.");
    expect(reviews).toContain("Yanis B.");
    const stats = html(byId("st1"));
    expect(stats).toContain("+10 000");
    expect(stats).toContain("48 h");
    expect(html(byId("tx1"))).toContain("Votre texte ici.");
    // Not a hidden-block setup warning: an amber "visible par vos clients" one.
    expect(sampleWarnings(blocks)).toEqual({});
    const amber = promiseWarnings(blocks);
    expect(amber.ann1).toMatch(/Annonce d'exemple .* visible par vos clients/);
    expect(amber.cp1).toMatch(/MERCI10 visible par vos clients/);
    expect(amber.rev1).toMatch(/Avis d'exemple visibles/);
    expect(amber.st1).toMatch(/Chiffres d'exemple visibles/);
    expect(amber.tx1).toMatch(/Texte d'exemple .* visible/);
    expect(setupWarnings(blocks)).toEqual({});
  });

  it("the tag survives a save / load round trip, and a newly added template block with sample content is hidden live", () => {
    const t = THANK_YOU_TEMPLATES.find((x) => x.id === "loyalty")!;
    const built = t.build(loadThankYouLayout(OLD_THANK_YOU));
    // The page's own (untagged) coupon is reused as is: still shown.
    expect(built.blocks.find((b) => b.id === "cp1")!.sample).toBeUndefined();
    const fresh = t.build(loadThankYouLayout(null)).blocks.find((b) => b.type === "coupon")!;
    expect(fresh.sample).toBe(true);
    const reloaded = loadThankYouLayout(JSON.parse(JSON.stringify({ blocks: [fresh] }))).blocks.find((b) => b.type === "coupon")!;
    expect(reloaded.sample).toBe(true);
    expect(isEmptyInLive(reloaded, live, 0)).toBe(true);
    expect(isEmptyInLive(reloaded, preview, 0)).toBe(false);
    expect(sampleWarnings([reloaded])[reloaded.id]).toMatch(/pour l'afficher$/);
    expect(promiseWarnings([reloaded])[reloaded.id]).toBeUndefined();
    for (const type of ["reviews", "stats", "testimonial", "coupon", "announcement", "text"] as const) expect(createBlock(type).sample, type).toBe(true);
    expect(createBlock("faq").sample).toBeUndefined();
  });
});

describe("sample content: finer detection", () => {
  it("a text block hides only its placeholder part; the whole block only when both are placeholders", () => {
    const text = createBlock("text");
    expect(isEmptyInLive(text, live, 0)).toBe(true);
    text.props.heading = "Notre histoire";
    expect(isEmptyInLive(text, live, 0)).toBe(false);
    const out = html(text);
    expect(out).toContain("Notre histoire");
    expect(out).not.toContain("Votre texte ici.");
    expect(html(text, preview)).toContain("Votre texte ici.");
    expect(sampleWarnings([text])[text.id]).toBe("Texte d'exemple (« Votre texte ici. ») masqué pour vos clients : écrivez le vôtre pour l'afficher");
    const bodyOnly = { ...createBlock("text"), props: { heading: "", body: "Votre texte ici." } } as Block;
    expect(isEmptyInLive(bodyOnly, live, 0)).toBe(true);
  });

  it("\"48 h\" is sample only with its shipped label; a review only with the name and the text together", () => {
    expect(isSampleStat({ value: "48 h", label: "expédition" })).toBe(true);
    expect(isSampleStat({ value: "48 h", label: "dispatch" })).toBe(true);
    expect(isSampleStat({ value: "48 h", label: "délai de préparation" })).toBe(false);
    expect(isSampleStat({ value: "+10 000", label: "n'importe" })).toBe(true);
    const stats = createBlock("stats");
    stats.props.items = [{ value: "48 h", label: "délai de préparation" }];
    expect(isEmptyInLive(stats, live, 0)).toBe(false);
    expect(isSampleReview({ name: "Camille R.", text: "Commande reçue en 3 jours, qualité au top. Je recommande !" })).toBe(true);
    expect(isSampleReview({ name: "Camille R.", text: "Super produit, je rachète." })).toBe(false);
    expect(isSampleReview({ name: "Léa M.", text: "Commande reçue en 3 jours, qualité au top. Je recommande !" })).toBe(false);
    // Swapped texts are not the shipped pairs.
    expect(isSampleReview({ name: "Yanis B.", text: "Commande reçue en 3 jours, qualité au top. Je recommande !" })).toBe(false);
  });

  it("warnings also read the block's translations", () => {
    const g = createBlock("guarantee");
    g.props = { ...g.props, title: "Garantie maison", text: "Échange sous 14 jours." } as typeof g.props;
    expect(promiseWarnings([g])).toEqual({});
    const shippedEn = localizeBlock(createBlock("guarantee"), "en").props as { text: string };
    g.i18n = { en: { text: shippedEn.text } };
    expect(promiseWarnings([g])[g.id]).toBe(SAMPLE_PROMISE_WARNING);
    const testimonial = createBlock("testimonial") as BlockOf<"testimonial">;
    testimonial.props.quote = "Je rachète chaque mois.";
    expect(sampleWarnings([testimonial])).toEqual({});
    testimonial.i18n = { en: { quote: "Fast delivery and the product is exactly as described. I recommend it." } };
    expect(sampleWarnings([testimonial])[testimonial.id]).toMatch(/Témoignage d'exemple/);
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
