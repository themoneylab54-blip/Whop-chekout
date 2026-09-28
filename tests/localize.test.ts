import { describe, expect, it } from "vitest";
import { blockSchema, createBlock, defaultCheckoutLayout, defaultTheme, loadCheckoutLayout, type Block } from "@/lib/layout";
import { LABELS, LANGS } from "@/components/checkout/i18n";
import {
  DEFAULT_TEXTS,
  emptyTextDefault,
  localizeBlock,
  localizeDeliveryTime,
  localizeLayout,
  localizeTheme,
  resolveText,
  textFields,
  translateDefault,
} from "@/components/checkout/localize";
import { publishedDesign, sameDesign } from "@/lib/design";

describe("shipped default texts", () => {
  it("has every key in all six languages, none left empty or in French", () => {
    const keys = Object.keys(DEFAULT_TEXTS.fr).sort();
    for (const { code } of LANGS) {
      const t = DEFAULT_TEXTS[code] as Record<string, string>;
      expect(Object.keys(t).sort()).toEqual(keys);
      for (const k of keys) expect(t[k].trim()).not.toBe("");
    }
    // A few spot checks against leaking French copy.
    expect(DEFAULT_TEXTS.en.upsellNo).toBe("No thanks");
    expect(DEFAULT_TEXTS.de.vatIncluded).not.toMatch(/TVA/);
  });

  it("keeps the {n} / {amount} placeholders in every translation", () => {
    for (const { code } of LANGS) {
      expect(DEFAULT_TEXTS[code].lowStock).toContain("{n}");
      expect(DEFAULT_TEXTS[code].freeShippingBar).toContain("{amount}");
    }
  });

  it("translates a text equal to a shipped French default, and nothing else", () => {
    expect(translateDefault("Paiement sécurisé", "en")).toBe(DEFAULT_TEXTS.en.securePayment);
    expect(translateDefault("Satisfait ou remboursé 30 jours", "de")).toBe(DEFAULT_TEXTS.de.moneyBack30);
    expect(translateDefault("  Non merci ", "es")).toBe(DEFAULT_TEXTS.es.upsellNo);
    expect(translateDefault("TVA incluse", "nl")).toBe("incl. btw");
    expect(translateDefault("Paiement sécurisé", "fr")).toBe("Paiement sécurisé");
    expect(translateDefault("Livraison gratuite chez Maison Lumière", "en")).toBe("Livraison gratuite chez Maison Lumière");
    expect(translateDefault("", "en")).toBe("");
  });

  it("covers every French string of the default blocks (no French leak on a new block)", () => {
    const types = [...new Set([...defaultCheckoutLayout().blocks.map((b) => b.type)])];
    const extra: Block["type"][] = ["upsell", "trust_badges", "faq", "why_us", "reviews", "benefits", "comparison", "coupon", "support", "shipping_protection", "free_shipping_bar"];
    for (const type of [...types, ...extra]) {
      const block = createBlock(type);
      for (const f of textFields(block.props)) {
        if (!f.value || f.prop === "author" || /^[\d+\s,./h]+$/.test(f.value)) continue;
        expect(translateDefault(f.value, "en"), `${type}.${f.path}`).not.toBe(f.value);
      }
    }
  });
});

describe("block text resolver", () => {
  const badges = () =>
    createBlock("trust_badges", {
      props: {
        badges: [
          { label: "Paiement sécurisé", iconUrl: "" },
          { label: "Emballage cadeau offert", iconUrl: "" },
        ],
      },
    } as Partial<Block>);

  it("lists translatable text paths, skipping URLs, ids and targeting", () => {
    const upsell = createBlock("upsell");
    const paths = textFields(upsell.props).map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["badge", "title", "text", "buttonText", "declineText"]));
    expect(paths).not.toContain("variantId");
    expect(paths).not.toContain("imageUrl");
    expect(paths.some((p) => p.startsWith("conditions"))).toBe(false);
    expect(textFields(badges().props).map((f) => f.path)).toEqual(["badges.0.label", "badges.1.label"]);
  });

  it("merchant translation > translated default > base text", () => {
    const i18n = { en: { title: "Your details" } };
    expect(resolveText("Contact", "title", "en", i18n)).toBe("Your details");
    expect(resolveText("Contact", "title", "de", i18n)).toBe(LABELS.de.contact);
    expect(resolveText("Mon titre", "title", "de", i18n)).toBe("Mon titre");
    // Empty / blank overrides mean "automatic".
    expect(resolveText("Non merci", "declineText", "en", { en: { declineText: "  " } })).toBe("No thanks");
  });

  it("localizes nested array texts without mutating the stored block", () => {
    const block = { ...badges(), i18n: { de: { "badges.1.label": "Gratis Geschenkverpackung" } } } as Block;
    const before = JSON.stringify(block);
    const de = localizeBlock(block, "de");
    expect(de.type === "trust_badges" && de.props.badges.map((b) => b.label)).toEqual([DEFAULT_TEXTS.de.securePayment, "Gratis Geschenkverpackung"]);
    const en = localizeBlock(block, "en");
    expect(en.type === "trust_badges" && en.props.badges.map((b) => b.label)).toEqual([DEFAULT_TEXTS.en.securePayment, "Emballage cadeau offert"]);
    expect(JSON.stringify(block)).toBe(before);
    // French buyers of a French store: same object, nothing to do.
    expect(localizeBlock(badges(), "fr").props).toEqual(badges().props);
  });

  it("applies to the offer's B arm too", () => {
    const upsell = createBlock("upsell");
    const withB = { ...upsell, props: { ...upsell.props, variantB: { enabled: true, split: 50, variantId: "1", imageUrl: "", badge: "", title: "Titre B", text: "", buttonText: "", priceMode: "fixed", price: 5, discountPercent: 20, compareAt: 0 } }, i18n: { en: { "variantB.title": "Title B" } } } as Block;
    const en = localizeBlock(withB, "en");
    expect(en.type === "upsell" && en.props.variantB?.title).toBe("Title B");
    expect(en.type === "upsell" && en.props.buttonText).toBe("Yes, add to my order");
  });

  it("localizes a layout and the theme's VAT note", () => {
    const layout = localizeLayout(defaultCheckoutLayout(), "en");
    const trust = layout.blocks.find((b) => b.type === "trust_badges");
    expect(trust?.type === "trust_badges" && trust.props.badges[0].label).toBe("Secure payment");
    expect(localizeTheme({ ...defaultTheme(), language: "en" }).vatNote).toBe("VAT included");
    expect(localizeTheme({ ...defaultTheme(), language: "en", vatNote: "Prix TTC" }).vatNote).toBe("Prix TTC");
  });

  it("validates translations in the block schema", () => {
    const ok = blockSchema.safeParse({ ...createBlock("contact"), i18n: { en: { title: "Your details" } } });
    expect(ok.success).toBe(true);
    expect(blockSchema.safeParse({ ...createBlock("contact"), i18n: { pt: { title: "x" } } }).success).toBe(false);
  });

  it("gives the built-in wording of empty fields per language", () => {
    expect(emptyTextDefault("contact", "title", "fr")).toBe("Contact");
    expect(emptyTextDefault("shipping_method", "title", "en")).toBe(LABELS.en.shippingMethod);
    expect(emptyTextDefault("text", "heading", "en")).toBeNull();
  });
});

describe("shipping delays typed in French", () => {
  it("localizes the usual patterns", () => {
    expect(localizeDeliveryTime("2 à 3 jours ouvrés", "en")).toBe("2–3 business days");
    expect(localizeDeliveryTime("2 à 3 jours ouvrés", "de")).toBe("2–3 Werktage");
    expect(localizeDeliveryTime("1 jour ouvré", "es")).toBe("1 día hábil");
    expect(localizeDeliveryTime("3-5 jours", "it")).toBe("3–5 giorni");
    expect(localizeDeliveryTime("2 semaines", "nl")).toBe("2 weken");
    expect(localizeDeliveryTime("24 à 48 h", "en")).toBe("24–48 h");
  });

  it("leaves French and anything else as typed", () => {
    expect(localizeDeliveryTime("2 à 3 jours ouvrés", "fr")).toBe("2 à 3 jours ouvrés");
    expect(localizeDeliveryTime("Livré avant Noël", "en")).toBe("Livré avant Noël");
    expect(localizeDeliveryTime("", "en")).toBe("");
  });
});

describe("draft vs published", () => {
  it("normalises a legacy layout (no express section) the same way twice", () => {
    const legacy = { blocks: defaultCheckoutLayout().blocks.filter((b) => b.type !== "express").map((b) => ({ ...b, id: `x-${b.type}` })) };
    expect(loadCheckoutLayout(legacy)).toEqual(loadCheckoutLayout(legacy));
    const store = { name: "S", theme: null, checkoutLayout: legacy, thankYouLayout: null };
    const published = publishedDesign(store);
    // The builder's copy may carry another id for the migrated section: still the same design.
    const edited = {
      ...published,
      checkoutLayout: { blocks: published.checkoutLayout.blocks.map((b) => (b.type === "express" ? { ...b, id: "abc12345" } : b)) },
    };
    expect(sameDesign(edited, published)).toBe(true);
    const changed = { ...published, theme: { ...published.theme, radius: published.theme.radius + 1 } };
    expect(sameDesign(changed, published)).toBe(false);
  });
});
