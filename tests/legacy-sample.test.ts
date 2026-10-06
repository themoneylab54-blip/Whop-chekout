import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCheckoutLayout, loadThankYouLayout, MAX_OFFER_QUANTITY, type Block, type BlockOf } from "@/lib/layout";
import { isSampleStat, migrateLegacySample } from "@/lib/legacy-sample";
import { liveLayoutPayload, liveReviewItems } from "@/lib/sample-content";
import { ContentBlock, isEmptyInLive, type ContentContext } from "@/components/checkout/blocks";
import { labelsFor } from "@/components/checkout/i18n";
import { parseOfferQuantity } from "@/components/builder/UpsellRules";
import { highPercentNote, HIGH_PERCENT_NOTE_FROM } from "@/components/dashboard/QuantityBreaksEditor";
import nextConfig from "../next.config";

/*
 * Blocks tagged `sample` by an earlier version (example content buyers never saw): after a
 * deploy, only what still holds the exact shipped example values stays out of buyers' sight;
 * anything the merchant changed shows. Plus the live reviews payload, the header payment logos,
 * the server-action body limit and two editor fields (high % note, « Autre » quantity).
 */

const ctx = (preview = false, over: Partial<ContentContext> = {}): ContentContext =>
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
    ...over,
  }) as ContentContext;
const html = (b: Block, c = ctx()) => renderToStaticMarkup(createElement(ContentBlock, { block: b, ctx: c }));
const SAMPLE_REVIEW_1 = { name: "Camille R.", text: "Commande reçue en 3 jours, qualité au top. Je recommande !", stars: 5, verified: false };
const SAMPLE_REVIEW_2 = { name: "Yanis B.", text: "Service client réactif et produit conforme aux photos.", stars: 5, verified: false };

const checkoutExtra = (blocks: unknown[]) =>
  loadCheckoutLayout({ blocks }).blocks.filter((b) => !["express", "contact", "delivery", "shipping_method", "payment"].includes(b.type));
const thankYouExtra = (blocks: unknown[]) => loadThankYouLayout({ blocks }).blocks.filter((b) => ["coupon", "text", "stats", "testimonial"].includes(b.type));

describe("1.B old tagged blocks: untouched example content stays hidden, the merchant's changes show", () => {
  it("untouched examples (placeholder text, figures, testimonial, MERCI10, announcement) load hidden, content kept", () => {
    const [ann, stats, text, testimonial] = checkoutExtra([
      { id: "a", type: "announcement", sample: true, props: { text: "Livraison offerte dès 50 € d'achat" } },
      {
        id: "s",
        type: "stats",
        sample: true,
        props: {
          items: [
            { value: "+10 000", label: "clients satisfaits" },
            { value: "4,8/5", label: "note moyenne" },
            { value: "48 h", label: "expédition" },
          ],
        },
      },
      { id: "t", type: "text", sample: true, props: { heading: "Titre", body: "Votre texte ici." } },
      { id: "q", type: "testimonial", sample: true, props: { quote: "Livraison rapide et produit conforme, je recommande.", author: "", photoUrl: "", stars: 5 } },
    ]);
    const [coupon] = thankYouExtra([
      { id: "c", type: "coupon", sample: true, props: { title: "Merci ! Voici un cadeau", text: "Profitez de -10 % sur votre prochaine commande.", code: "MERCI10" } },
    ]);
    for (const b of [ann, stats, text, testimonial, coupon]) {
      expect(b.sample, b.id).toBeUndefined();
      expect(b.hidden, b.id).toBe(true);
    }
    // Kept for the merchant (shown again from the builder if they want it).
    expect((stats as BlockOf<"stats">).props.items).toHaveLength(3);
    expect((coupon as BlockOf<"coupon">).props.code).toBe("MERCI10");
    // Stable: loading the result again changes nothing.
    expect(checkoutExtra(JSON.parse(JSON.stringify([ann, stats, text, testimonial])))).toEqual([ann, stats, text, testimonial]);
  });

  it("anything the merchant changed shows as written", () => {
    const [ann, stats, text, testimonial] = checkoutExtra([
      { id: "a", type: "announcement", sample: true, props: { text: "Livraison offerte dès 39 €" } },
      {
        id: "s",
        type: "stats",
        sample: true,
        props: {
          items: [
            { value: "+10 000", label: "clients satisfaits" },
            { value: "2 500", label: "commandes livrées" },
            { value: "48 h", label: "préparation en atelier" },
          ],
        },
      },
      { id: "t", type: "text", sample: true, props: { heading: "Notre atelier", body: "Votre texte ici." } },
      { id: "q", type: "testimonial", sample: true, props: { quote: "Un vrai témoignage de Lucie.", author: "Lucie", photoUrl: "", stars: 5 } },
    ]);
    const [coupon] = thankYouExtra([{ id: "c", type: "coupon", sample: true, props: { title: "Cadeau", text: "", code: "BIENVENUE15" } }]);
    for (const b of [ann, stats, text, testimonial, coupon]) {
      expect(b.sample, b.id).toBeUndefined();
      expect(b.hidden, b.id).toBe(false);
      expect(isEmptyInLive(b, ctx(), 0), b.id).toBe(false);
    }
    expect(html(ann)).toContain("Livraison offerte dès 39 €");
    expect(html(coupon)).toContain("BIENVENUE15");
    expect(html(testimonial)).toContain("Un vrai témoignage de Lucie.");
    // Figures: only the invented ones go; a real "48 h" with the merchant's own label stays.
    expect((stats as BlockOf<"stats">).props.items.map((i) => i.value)).toEqual(["2 500", "48 h"]);
    expect(html(stats)).not.toContain("+10 000");
    // Text: the placeholder part goes, the merchant's heading shows alone.
    expect((text as BlockOf<"text">).props).toMatchObject({ heading: "Notre atelier", body: "" });
    expect(html(text)).not.toContain("Votre texte ici.");
  });

  it("a coupon confirmed by the merchant (old « ce code existe ») and untagged blocks are never changed", () => {
    const confirmed = migrateLegacySample({
      id: "c",
      type: "coupon",
      sample: true,
      hidden: false,
      placement: "form",
      position: "below",
      props: { title: "Cadeau", text: "", code: "MERCI10", codeConfirmed: true },
    } as unknown as Block);
    expect(confirmed.hidden).toBe(false);
    const [untagged] = checkoutExtra([{ id: "t", type: "text", props: { heading: "Notre atelier", body: "Fait main à Lyon." } }]);
    expect(untagged.hidden).toBe(false);
    expect(html(untagged)).toContain("Fait main à Lyon.");
    // Only the exact old placeholder words of an untagged block load empty (nothing live, the
    // builder shows its placeholders); the merchant's own part stays.
    const [placeholder] = checkoutExtra([{ id: "t", type: "text", props: { heading: "Titre", body: "Votre texte ici." } }]);
    expect(placeholder.hidden).toBe(false);
    expect(placeholder.props).toMatchObject({ heading: "", body: "" });
    expect(html(placeholder)).toBe("");
    const [mixed] = checkoutExtra([{ id: "t", type: "text", props: { heading: "Titre", body: "Mon texte." } }]);
    expect(mixed.props).toMatchObject({ heading: "", body: "Mon texte." });
    const [why] = checkoutExtra([
      {
        id: "w",
        type: "why_us",
        props: { title: "Pourquoi nous ?", rows: [{ icon: "check", title: "Titre", text: "Texte" }, { icon: "truck", title: "Envoi 24 h", text: "" }] },
      },
    ]);
    expect((why.props as { rows: unknown[] }).rows).toEqual([
      { icon: "check", title: "", text: "" },
      { icon: "truck", title: "Envoi 24 h", text: "" },
    ]);
    expect(html(why)).not.toContain("Titre");
    expect(html(why)).toContain("Envoi 24 h");
  });

  it("example figures are recognised by exact value (and « 48 h » only with its shipped label)", () => {
    expect(isSampleStat({ value: "+10 000", label: "n'importe quoi" })).toBe(true);
    expect(isSampleStat({ value: "48 h", label: "expédition" })).toBe(true);
    expect(isSampleStat({ value: "48 h", label: "fabrication" })).toBe(false);
    expect(isSampleStat({ value: "+12 000", label: "clients satisfaits" })).toBe(false);
  });
});

describe("1.C the shipped example reviews never show live, tagged or not", () => {
  it("untagged block: Camille R. / Yanis B. filtered live, the merchant's reviews shown; the builder still lists them", () => {
    const [reviews] = checkoutExtra([
      {
        id: "r",
        type: "reviews",
        props: { title: "Avis", layout: "stack", items: [SAMPLE_REVIEW_1, { name: "Léa", text: "Top, je recommande.", stars: 5, verified: false }, SAMPLE_REVIEW_2] },
      },
    ]);
    expect(liveReviewItems(reviews as BlockOf<"reviews">).map((r) => r.name)).toEqual(["Léa"]);
    expect(html(reviews)).not.toContain("Camille R.");
    expect(html(reviews)).toContain("Léa");
    expect(html(reviews, ctx(true))).toContain("Camille R.");
    // Same name with the merchant's own text: a real review.
    expect(liveReviewItems({ props: { items: [{ name: "Camille R.", text: "Super produit, je rachète." }] } })).toHaveLength(1);
  });

  it("only example reviews: nothing shown live", () => {
    const [reviews] = checkoutExtra([{ id: "r", type: "reviews", props: { title: "Avis", layout: "stack", items: [SAMPLE_REVIEW_1, SAMPLE_REVIEW_2] } }]);
    expect(isEmptyInLive(reviews, ctx(), 0)).toBe(true);
  });
});

describe("1.D saving big layouts", () => {
  it("server actions accept bodies well above the 1 MB default", () => {
    expect(nextConfig.experimental?.serverActions?.bodySizeLimit).toBe("8mb");
  });

  it("the buyer's page gets only the live reviews (every one of them: pagination and per-cart order run in the browser)", () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `Client ${i}`, text: `Avis ${i}`, stars: 5, verified: false }));
    const layout = {
      blocks: [
        { id: "r", type: "reviews", hidden: false, props: { title: "Avis", layout: "stack", items: [SAMPLE_REVIEW_1, { ...many[0], text: " " }, ...many] } },
        { id: "h", type: "reviews", hidden: true, props: { title: "Avis", layout: "stack", items: many } },
        { id: "t", type: "text", hidden: false, props: { heading: "Titre", body: "Votre texte ici." } },
      ] as unknown as Block[],
    };
    const out = liveLayoutPayload(layout);
    const items = (id: string) => (out.blocks.find((b) => b.id === id) as BlockOf<"reviews">).props.items;
    expect(items("r")).toHaveLength(300);
    expect(items("r")[0].name).toBe("Client 0");
    expect(items("h")).toEqual([]);
    expect(out.blocks[2]).toBe(layout.blocks[2]);
    // Nothing to trim: the same object.
    const noReviews = { blocks: [layout.blocks[2]] };
    expect(liveLayoutPayload(noReviews)).toBe(noReviews);
  });
});

describe("1.E header payment logos", () => {
  it("only the block shown next to the Payment title is skipped live; another payment-logos block shows", () => {
    const icons = (id: string) => ({ id, type: "payment_icons", hidden: false, props: { label: "", methods: ["visa", "mastercard"] } }) as unknown as Block;
    const c = ctx(false, { paymentLogosInHeader: true, headerLogosBlockId: "first" });
    expect(isEmptyInLive(icons("first"), c, 0)).toBe(true);
    expect(isEmptyInLive(icons("second"), c, 0)).toBe(false);
    // No header logos (thank-you page, no Payment section): every block shows.
    expect(isEmptyInLive(icons("first"), ctx(false, { headerLogosBlockId: null }), 0)).toBe(false);
  });
});

describe("1.F high percent note (quantity breaks)", () => {
  const money = (v: string) => `${v.replace(".", ",")}0 €`;
  it("a small, non-blocking note from 80 %", () => {
    expect(HIGH_PERCENT_NOTE_FROM).toBe(80);
    expect(highPercentNote("79", money)).toBeNull();
    expect(highPercentNote("80", money)).toContain("minimum de paiement");
    expect(highPercentNote("85,5", money)).toContain("−85,5 %");
    // Invalid values get the field's own error instead.
    expect(highPercentNote("95", money)).toBeNull();
    expect(highPercentNote("abc", money)).toBeNull();
  });
});

describe("1.G upsell « Autre » quantity", () => {
  it("a cleared or partial field is not a quantity yet (validated on blur); valid ones are capped", () => {
    expect(parseOfferQuantity("")).toBeNull();
    expect(parseOfferQuantity("0")).toBeNull();
    expect(parseOfferQuantity("2.5")).toBeNull();
    expect(parseOfferQuantity("abc")).toBeNull();
    expect(parseOfferQuantity(" 4 ")).toBe(4);
    expect(parseOfferQuantity("100000")).toBe(MAX_OFFER_QUANTITY);
  });
});
