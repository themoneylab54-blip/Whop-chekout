import { describe, expect, it } from "vitest";
import {
  applyTemplateTheme,
  blocksKeptAside,
  CHECKOUT_TEMPLATES,
  fromSpec,
  matchingThankYou,
  previewAfterPopover,
  renderedColumns,
  TEMPLATE_STYLE_KEYS,
  THANK_YOU_TEMPLATES,
  type Template,
} from "@/components/builder/templates";
import {
  checkoutLayoutSchema,
  createBlock,
  defaultCheckoutLayout,
  defaultThankYouLayout,
  loadCheckoutLayout,
  loadThankYouLayout,
  themeSchema,
  thankYouLayoutSchema,
  type Theme,
} from "@/lib/layout";
import { contrastFailures, contrastRatio, fieldBorderColor, mix, readableOn, themeContrastChecks } from "@/lib/contrast";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TEXTS, isShippedDefault, translateDefault } from "@/components/checkout/localize";
import { layoutWarnings, promiseWarnings, SAMPLE_DELIVERY_WARNING, SAMPLE_PROMISE_WARNING, sampleWarnings, setupWarnings } from "@/components/builder/placement";
import { isSampleOnly } from "@/lib/sample-content";
import { isEmptyInLive, type ContentContext } from "@/components/checkout/blocks";
import { blocksHiddenBy } from "@/components/builder/templates";
import { arrangeCheckout } from "@/components/checkout/CheckoutView";

const merchantTheme = (): Theme =>
  themeSchema.parse({
    storeName: "Maison Lumière",
    showStoreName: false,
    logoUrl: "https://cdn.example.com/logo.png",
    logoHeight: 48,
    headerMode: "logo",
    bannerUrl: "https://cdn.example.com/banner.jpg",
    language: "de",
    trustLine: "Expédié depuis Lyon",
    payButtonText: "Commander",
    policyLinks: [{ label: "CGV", url: "https://example.com/cgv" }],
    termsUrl: "https://example.com/cgv",
    vatNote: "TVA 20 % incluse",
    requireTerms: false,
    expressCheckout: false,
    accentColor: "#ff0000",
    fontScale: "lg",
  });

const all = [
  ...CHECKOUT_TEMPLATES.map((t) => ({ t, page: "checkout" as const })),
  ...THANK_YOU_TEMPLATES.map((t) => ({ t, page: "thank-you" as const })),
];

describe("templates: schema", () => {
  it("has unique ids per page and at least 8 styled checkout templates", () => {
    for (const list of [CHECKOUT_TEMPLATES, THANK_YOU_TEMPLATES]) {
      expect(new Set(list.map((t) => t.id)).size).toBe(list.length);
    }
    expect(CHECKOUT_TEMPLATES.filter((t) => t.style).length).toBeGreaterThanOrEqual(8);
    // Every styled checkout template has its matching thank-you page.
    for (const t of CHECKOUT_TEMPLATES.filter((x) => x.style)) {
      const ty = THANK_YOU_TEMPLATES.find((x) => x.id === t.id);
      expect(ty?.style, t.id).toEqual(t.style);
    }
  });

  it.each(all.map(({ t, page }) => [`${page}/${t.id}`, t, page] as const))("%s builds a valid layout", (_, t, page) => {
    for (const base of [page === "checkout" ? defaultCheckoutLayout() : defaultThankYouLayout(), { blocks: [] }]) {
      const layout = t.build(base);
      const schema = page === "checkout" ? checkoutLayoutSchema : thankYouLayoutSchema;
      if (page === "checkout" || base.blocks.length > 0) expect(schema.safeParse(layout).success, JSON.stringify(schema.safeParse(layout).error?.issues)).toBe(true);
      // The loaders keep it as is (nothing dropped or normalised away).
      const loaded = page === "checkout" ? loadCheckoutLayout(layout) : loadThankYouLayout(layout);
      expect(loaded.blocks.map((b) => b.type)).toEqual(layout.blocks.map((b) => b.type));
      // The template's blocks in its order, plus the page's other blocks (kept).
      const others = new Set(blocksKeptAside(t.spec, base).map((b) => b.id));
      expect(layout.blocks.filter((b) => !others.has(b.id)).map((b) => b.type)).toEqual(t.spec.map(([type]) => type));
      expect(layout.blocks.filter((b) => others.has(b.id)).length).toBe(others.size);
    }
  });

  it.each(all.filter(({ t }) => t.style).map(({ t, page }) => [`${page}/${t.id}`, t] as const))("%s has a complete, valid look", (_, t) => {
    expect(Object.keys(t.style!).sort()).toEqual([...TEMPLATE_STYLE_KEYS].sort());
    expect(themeSchema.safeParse(applyTemplateTheme(merchantTheme(), t)).success).toBe(true);
  });

  it("new blocks use the shipped (auto-translated) default texts", () => {
    const texts = (v: unknown): string[] =>
      typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(texts) : v && typeof v === "object" ? Object.values(v).flatMap(texts) : [];
    for (const t of CHECKOUT_TEMPLATES.filter((x) => x.style)) {
      for (const b of t.build({ blocks: [] }).blocks) {
        if (b.type === "reviews") continue; // names of the sample reviews
        const TEXT_KEYS = ["title", "text", "label", "message", "success", "subtext", "quote", "author", "q", "a"];
        const own = Object.entries(b.props).filter(([k]) => TEXT_KEYS.includes(k)).flatMap(([, v]) => texts(v));
        for (const s of own.filter((x) => x.trim())) expect(isShippedDefault(s), `${t.id}/${b.type}: ${s}`).toBe(true);
      }
    }
  });
});

describe("templates: contrast (WCAG AA)", () => {
  it("computes WCAG ratios", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(contrastRatio("#767676", "#ffffff")).toBeGreaterThan(4.5);
    expect(readableOn("#ffd400")).toBe("#111111");
    expect(readableOn("#1d4ed8")).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.7)).toBe("#4d4d4d");
  });

  it.each(CHECKOUT_TEMPLATES.filter((t) => t.style).map((t) => [t.id, t] as const))("%s: text, muted text, brand color, buttons and header pass AA", (_, t: Template) => {
    const theme = applyTemplateTheme(merchantTheme(), t);
    expect(themeContrastChecks(theme).length).toBeGreaterThan(10);
    const fails = contrastFailures(theme).map((c) => `${c.what}: ${c.fg} on ${c.bg} = ${c.ratio.toFixed(2)} < ${c.min}`);
    expect(fails).toEqual([]);
    // Field boundary (WCAG 1.4.11): 3:1 against the form background, in every input style.
    const field = themeContrastChecks(theme).find((c) => c.what === "field border on form")!;
    expect(field.min).toBe(3);
    expect(field.ratio).toBeGreaterThanOrEqual(3);
  });

  it("field borders: a light theme border is darkened toward the text color just enough for 3:1; a dark one is kept", () => {
    const base = { textColor: "#111111", formBackground: "", pageBackground: "" };
    expect(fieldBorderColor({ ...base, borderColor: "#6b7280" })).toBe("#6b7280");
    const light = fieldBorderColor({ ...base, borderColor: "#d4d4d8" });
    expect(light).not.toBe("#d4d4d8");
    expect(contrastRatio(light, "#ffffff")).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(light, "#ffffff")).toBeLessThan(4.5); // not the text color: still a light boundary
    // Measured against the form background when it has one.
    const tinted = fieldBorderColor({ ...base, borderColor: "#e7c3d0", formBackground: "#fffafb" });
    expect(contrastRatio(tinted, "#fffafb")).toBeGreaterThanOrEqual(3);
    // Filled fields keep a real border (the 5 % fill alone is no visible boundary).
    const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");
    const filled = css.slice(css.indexOf('[data-inputs="filled"] .wc-input {'), css.indexOf("}", css.indexOf('[data-inputs="filled"] .wc-input {')));
    expect(filled).not.toMatch(/border-color:\s*transparent/);
    expect(css).toMatch(/\.wc-input \{[^}]*border: 1px solid var\(--field-border/);
  });
});

describe("templates: applying keeps the merchant's content", () => {
  it("keeps logo, store name, banner, language, links and legal settings; replaces the look", () => {
    const before = merchantTheme();
    for (const t of CHECKOUT_TEMPLATES.filter((x) => x.style)) {
      const after = applyTemplateTheme(before, t);
      for (const k of Object.keys(before) as (keyof Theme)[]) {
        if ((TEMPLATE_STYLE_KEYS as readonly string[]).includes(k)) expect(after[k], `${t.id}.${k}`).toEqual(t.style![k as keyof typeof t.style]);
        else expect(after[k], `${t.id}.${k}`).toEqual(before[k]);
      }
      expect(after.logoUrl).toBe("https://cdn.example.com/logo.png");
      expect(after.storeName).toBe("Maison Lumière");
      expect(after.headerMode).toBe("logo");
      // The text size is a readability choice: kept.
      expect(after.fontScale).toBe("lg");
    }
  });

  it("thank-you templates put the confirmation first; descriptions name no brand", () => {
    for (const t of THANK_YOU_TEMPLATES) expect(t.spec[0][0], t.id).toBe("ty_confirmation");
    for (const t of [...CHECKOUT_TEMPLATES, ...THANK_YOU_TEMPLATES])
      expect(`${t.name} ${t.description}`, t.id).not.toMatch(/apple|shopify|clickfunnels|stripe|amazon|nike|glossier/i);
  });

  it("layout-only templates leave the theme alone", () => {
    const before = merchantTheme();
    for (const t of CHECKOUT_TEMPLATES.filter((x) => !x.style)) expect(applyTemplateTheme(before, t)).toBe(before);
  });

  it("reuses the page's blocks with their texts, products and translations", () => {
    const reviews = createBlock("reviews", { placement: "form" });
    reviews.props.title = "Nos clientes en parlent";
    reviews.i18n = { en: { title: "Our customers" } };
    const upsell = createBlock("upsell");
    upsell.props.variantId = "gid://shopify/ProductVariant/42";
    upsell.props.declineNextId = "gone";
    const current = { blocks: [...defaultCheckoutLayout().blocks, reviews] };
    const t = CHECKOUT_TEMPLATES.find((x) => x.id === "dark-premium")!;
    const out = t.build(current);
    const r = out.blocks.find((b) => b.type === "reviews")!;
    expect(r.id).toBe(reviews.id);
    expect(r.props).toEqual(reviews.props);
    expect(r.i18n).toEqual(reviews.i18n);
    expect(r.placement).toBe("summary"); // placed by the template
    // Fixed sections are the same objects (custom titles kept)
    const payment = current.blocks.find((b) => b.type === "payment")!;
    expect(out.blocks.find((b) => b.type === "payment")).toEqual({ ...payment, hidden: false });

    const ty = fromSpec(THANK_YOU_TEMPLATES.find((x) => x.id === "dark-premium")!.spec, { blocks: [...defaultThankYouLayout().blocks, upsell] });
    const u = ty.blocks.find((b) => b.type === "upsell")!;
    expect(u.type === "upsell" && u.props.variantId).toBe("gid://shopify/ProductVariant/42");
    // A follow-up offer the template dropped is unlinked.
    expect(u.type === "upsell" && u.props.declineNextId).toBeUndefined();
  });
});

describe("templates: no fabricated social proof", () => {
  it("sample reviews are never marked verified", () => {
    const r = createBlock("reviews");
    expect(r.props.items.length).toBeGreaterThan(0);
    expect(r.props.items.every((it) => !it.verified)).toBe(true);
  });

  it("no template ships the example free-shipping announcement", () => {
    for (const t of [...CHECKOUT_TEMPLATES, ...THANK_YOU_TEMPLATES]) expect(t.spec.map(([type]) => type), t.id).not.toContain("announcement");
  });

  it.each(all.map(({ t, page }) => [`${page}/${t.id}`, t] as const))("%s: every sample proof it adds is flagged as to complete (hidden from buyers)", (_, t) => {
    const blocks = t.build({ blocks: [] }).blocks;
    const flagged = sampleWarnings(blocks);
    const promises = promiseWarnings(blocks);
    for (const b of blocks) {
      // Fabricated proof: a setup warning, and never shown to buyers.
      if (["reviews", "testimonial", "stats", "coupon", "text"].includes(b.type)) {
        expect(flagged[b.id], `${t.id}/${b.type}`).toMatch(/pour (les |l')afficher$/);
        expect(isSampleOnly(b), `${t.id}/${b.type}`).toBe(true);
      } else expect(flagged[b.id], `${t.id}/${b.type}`).toBeUndefined();
      // Example promises: an amber warning only.
      if (["guarantee", "benefits", "value_props", "faq", "support", "delivery_estimate", "why_us", "comparison", "payment_icons"].includes(b.type))
        expect(promises[b.id], `${t.id}/${b.type}`).toBeTruthy();
      else expect(promises[b.id], `${t.id}/${b.type}`).toBeUndefined();
    }
    // Shown with the other warnings (canvas badge, block list).
    // Shown with the setup warnings (canvas badge, block list, "blocs à compléter").
    const setup = setupWarnings(blocks);
    for (const id of Object.keys(flagged)) expect(setup[id]).toBe(flagged[id]);
    for (const id of Object.keys(flagged)) expect(layoutWarnings(blocks)[id]).toBe(flagged[id]);
    // A block both incomplete and promising (support without a channel): the setup warning wins.
    for (const id of Object.keys(promises)) expect(layoutWarnings(blocks)[id]).toBe(setup[id] ?? promises[id]);
  });

  it("clears once the merchant writes real content, and ignores hidden blocks", () => {
    const reviews = createBlock("reviews");
    const testimonial = createBlock("testimonial");
    const stats = createBlock("stats");
    const coupon = createBlock("coupon");
    const announcement = createBlock("announcement");
    const text = createBlock("text");
    const sample = [reviews, testimonial, stats, coupon, announcement, text];
    expect(Object.keys(sampleWarnings(sample)).sort()).toEqual(sample.map((b) => b.id).sort());
    expect(sampleWarnings(sample.map((b) => ({ ...b, hidden: true })))).toEqual({});
    reviews.props.items = [{ name: "Léa M.", text: "Très bon produit.", stars: 5, verified: true }];
    testimonial.props.quote = "Je rachète chaque mois.";
    stats.props.items = [{ value: "2 300", label: "commandes" }];
    coupon.props.code = "BIENVENUE";
    announcement.props.text = "Livraison offerte dès 80 €";
    text.props = { heading: "Fabriqué à Lyon", body: "Chaque pièce est cousue dans notre atelier." };
    expect(sampleWarnings(sample)).toEqual({});
    for (const b of sample) expect(isSampleOnly(b), b.type).toBe(false);
  });

  it("the example \"48 h\" figure and the placeholder text alone are enough to hide the block", () => {
    const stats = createBlock("stats");
    stats.props.items = [{ value: "48 h", label: "expédition" }];
    expect(sampleWarnings([stats])[stats.id]).toMatch(/Chiffres d'exemple/);
    const text = createBlock("text");
    text.props.heading = "Notre histoire";
    expect(sampleWarnings([text])[text.id]).toMatch(/Texte d'exemple/);
    text.props.body = "Une marque familiale.";
    expect(sampleWarnings([text])).toEqual({});
    expect(isSampleOnly(stats)).toBe(true);
    expect(isSampleOnly(text)).toBe(false);
    // Reviews: the shipped ones never show, the merchant's own do.
    const reviews = createBlock("reviews");
    expect(isSampleOnly(reviews)).toBe(true);
    reviews.props.items.push({ name: "Léa M.", text: "Très bon produit.", stars: 5, verified: false });
    expect(isSampleOnly(reviews)).toBe(false);
    expect(sampleWarnings([reviews])[reviews.id]).toBe("Avis d'exemple : remplacez-les par vos vrais avis pour les afficher");
    // The testimonial ships without a "Client vérifié" author vouching for it.
    expect(createBlock("testimonial").props.author).toBe("");
  });
});

describe("templates: applying keeps the merchant's other blocks", () => {
  it("keeps blocks the template doesn't list, in place, with their hidden state", () => {
    const text = createBlock("text", { placement: "form" });
    text.props.heading = "Fabriqué en France";
    const faq = createBlock("faq", { placement: "form", hidden: true });
    const image = createBlock("image", { placement: "summary" });
    const reviews = createBlock("reviews", { placement: "form", hidden: true });
    const base = defaultCheckoutLayout().blocks;
    const at = base.findIndex((b) => b.type === "contact") + 1;
    const pay = base.findIndex((b) => b.type === "payment") + 1;
    const current = { blocks: [...base.slice(0, at), text, ...base.slice(at, pay), faq, ...base.slice(pay), image, reviews] };
    const t = CHECKOUT_TEMPLATES.find((x) => x.id === "clean-minimal")!;
    const out = t.build(current).blocks;
    const types = out.map((b) => b.type);
    // Nothing the merchant made is lost: text, FAQ, image, add-ons, trust badges.
    for (const b of [text, faq, image]) expect(out.find((x) => x.id === b.id)).toEqual(b);
    expect(types).toContain("order_addons");
    expect(types).toContain("trust_badges");
    // Next to the block they followed.
    expect(types.indexOf("text")).toBe(types.indexOf("contact") + 1);
    expect(types.indexOf("faq")).toBeGreaterThan(types.indexOf("payment"));
    // A reused block keeps its visibility (the template only places and styles it).
    const dark = CHECKOUT_TEMPLATES.find((x) => x.id === "dark-premium")!.build(current).blocks;
    expect(dark.find((b) => b.id === reviews.id)?.hidden).toBe(true);
    expect(dark.find((b) => b.id === faq.id)?.hidden).toBe(true);
    expect(checkoutLayoutSchema.safeParse({ blocks: out }).success).toBe(true);
  });

  it("keeps thank-you blocks too", () => {
    const text = createBlock("text");
    const blocks = defaultThankYouLayout().blocks;
    const current = { blocks: [blocks[0], text, ...blocks.slice(1)] };
    const out = THANK_YOU_TEMPLATES.find((x) => x.id === "upsell")!.build(current).blocks;
    expect(out.map((b) => b.id)).toContain(text.id);
    expect(out[out.findIndex((b) => b.type === "ty_confirmation") + 1].type).toBe("upsell");
    expect(blocksKeptAside(THANK_YOU_TEMPLATES.find((x) => x.id === "upsell")!.spec, current).map((b) => b.id)).toEqual([text.id]);
  });
});

describe("templates: what is described is what renders", () => {
  it.each(CHECKOUT_TEMPLATES.map((t) => [t.id, t] as const))("%s: top banners stay above the payment, trust sits in the summary column", (_, t) => {
    const a = arrangeCheckout(t.build({ blocks: [] }).blocks);
    // Banners listed above the payment all show there (none pushed to the bottom of the page).
    const payAt = t.spec.findIndex(([type]) => type === "payment");
    const banners = t.spec.slice(0, payAt).filter(([type, o]) => ["countdown", "free_shipping_bar", "low_stock", "announcement"].includes(type) && o?.placement !== "summary");
    for (const [type] of banners) expect(a.main.map((b) => b.type), `${t.id}/${type}`).toContain(type);
    expect(a.after.filter((b) => ["countdown", "free_shipping_bar", "low_stock", "announcement"].includes(b.type))).toEqual([]);
    // Reassurance listed right after the payment renders first under the pay button on mobile (arranged.side).
    const cols = renderedColumns(t.spec);
    for (const type of ["payment_icons", "secure_badge", "guarantee"] as const) {
      if (t.spec.some(([x]) => x === type)) expect(cols.summary, `${t.id}/${type}`).toContain(type);
    }
    // Every block of the template is drawn in the thumbnail.
    expect([...cols.form, ...cols.summary].sort()).toEqual(t.spec.map(([type]) => type).sort());
  });

  it("trust-max: payment logos, secure badge and guarantee come before the reviews on mobile", () => {
    const a = arrangeCheckout(CHECKOUT_TEMPLATES.find((x) => x.id === "trust-max")!.build({ blocks: [] }).blocks);
    // CheckoutView's mobile order under the pay button: side (placed next to the payment) then summary.
    expect([...a.side, ...a.summary].map((b) => b.type)).toEqual(["payment_icons", "secure_badge", "guarantee", "reviews", "value_props"]);
  });

  it("urgency-promo: low stock shows above the payment, on mobile too (form column, not under the pay button)", () => {
    const a = arrangeCheckout(CHECKOUT_TEMPLATES.find((x) => x.id === "urgency-promo")!.build({ blocks: [] }).blocks);
    const main = a.main.map((b) => b.type);
    expect(main).toContain("low_stock");
    expect(main.indexOf("low_stock")).toBeLessThan(main.indexOf("payment"));
    expect([...a.side, ...a.summary, ...a.after].map((b) => b.type)).not.toContain("low_stock");
  });

  it("renderedColumns is memoized per spec (thumbnails re-render on every hover)", () => {
    const spec = CHECKOUT_TEMPLATES[0].spec;
    expect(renderedColumns(spec)).toBe(renderedColumns(spec));
    expect(renderedColumns([...spec])).toEqual(renderedColumns(spec));
  });

  it("the urgency template's accent is not an error red", () => {
    const t = CHECKOUT_TEMPLATES.find((x) => x.id === "urgency-promo")!;
    const [r, g] = [parseInt(t.style!.accentColor.slice(1, 3), 16), parseInt(t.style!.accentColor.slice(3, 5), 16)];
    expect(g / r).toBeGreaterThan(0.25); // orange, not red (#b91c1c: 0.15)
  });
});

describe("templates: Modèles cards and the matching thank-you page", () => {
  it("every template has a short « idéal pour » tag", () => {
    for (const t of [...CHECKOUT_TEMPLATES, ...THANK_YOU_TEMPLATES]) {
      expect(t.idealFor, t.id).toBeTruthy();
      expect(t.idealFor!.length, t.id).toBeLessThanOrEqual(24);
    }
    expect(CHECKOUT_TEMPLATES.find((t) => t.id === "compact-mobile")!.idealFor).toBe("Trafic mobile");
    expect(CHECKOUT_TEMPLATES.find((t) => t.id === "luxury-black-gold")!.idealFor).toBe("Panier élevé");
  });

  it("a styled checkout template has a matching thank-you page (same id and look); layout-only ones don't", () => {
    for (const t of CHECKOUT_TEMPLATES.filter((x) => x.style)) {
      const ty = matchingThankYou(t)!;
      expect(ty, t.id).toBeTruthy();
      expect(THANK_YOU_TEMPLATES).toContain(ty);
      expect(ty.style).toEqual(t.style);
      // Builds a valid thank-you page.
      expect(thankYouLayoutSchema.safeParse(ty.build(defaultThankYouLayout())).success, t.id).toBe(true);
    }
    for (const t of CHECKOUT_TEMPLATES.filter((x) => !x.style)) expect(matchingThankYou(t), t.id).toBeNull();
  });

  it("counts the blocks each template leaves to complete (setup warnings, sample proof included)", () => {
    const t = CHECKOUT_TEMPLATES.find((x) => x.id === "urgency-promo")!;
    const blocks = t.build(defaultCheckoutLayout()).blocks;
    const types = Object.keys(setupWarnings(blocks, { now: Date.parse("2026-06-01T00:00:00Z") })).map((id) => blocks.find((b) => b.id === id)!.type);
    // Countdown without an end date, cross-sells without products, sample reviews (low stock
    // shows by itself once stock is low).
    expect(types.sort()).toEqual(["countdown", "recommendations", "reviews"]);
  });
});

describe("templates: menu preview", () => {
  it("drops the hovered template whenever the Modèles menu is not the open popover", () => {
    const t = CHECKOUT_TEMPLATES[0];
    expect(previewAfterPopover("templates", t)).toBe(t);
    expect(previewAfterPopover(null, t)).toBeNull();
    expect(previewAfterPopover("publish", t)).toBeNull();
  });
});

describe("templates: example promises are flagged before publishing", () => {
  it("flags guarantee, benefits, value props, why-us, comparison, FAQ and support as promises (warning, not a publishing gate)", () => {
    const types = ["guarantee", "benefits", "value_props", "why_us", "comparison", "faq", "support"] as const;
    const blocks = types.map((t) => createBlock(t));
    const flagged = promiseWarnings(blocks);
    for (const b of blocks) expect(flagged[b.id], b.type).toBe(SAMPLE_PROMISE_WARNING);
    expect(SAMPLE_PROMISE_WARNING).toBe("Promesse d'exemple : vérifiez qu'elle correspond à votre politique");
    // Promises never block publishing.
    expect(sampleWarnings(blocks)).toEqual({});
    expect(promiseWarnings(blocks.map((b) => ({ ...b, hidden: true })))).toEqual({});
  });

  it("the default checkout is promise-free: non-binding trust badges, translated in every language", () => {
    const blocks = defaultCheckoutLayout().blocks;
    const badges = blocks.find((b) => b.type === "trust_badges")!;
    expect(badges.type === "trust_badges" && badges.props.badges.map((x) => x.label)).toEqual(["Paiement sécurisé", "Données chiffrées", "Suivi de commande"]);
    expect(promiseWarnings(blocks)).toEqual({});
    expect(sampleWarnings(blocks)).toEqual({});
    expect(sampleWarnings(defaultThankYouLayout().blocks)).toEqual({});
    for (const lang of Object.keys(DEFAULT_TEXTS) as (keyof typeof DEFAULT_TEXTS)[]) {
      expect(translateDefault("Données chiffrées", lang), lang).toBe(DEFAULT_TEXTS[lang].encryptedData);
      expect(translateDefault("Suivi de commande", lang), lang).toBe(DEFAULT_TEXTS[lang].orderTracking);
    }
    // A trust-badges block a merchant saved with the old example promise is still flagged.
    const old = createBlock("trust_badges");
    old.props.badges = [{ label: "Satisfait ou remboursé 30 jours", iconUrl: "" }];
    expect(promiseWarnings([old])[old.id]).toBe(SAMPLE_PROMISE_WARNING);
  });

  it("delivery estimate: the shipped 3–5 day delay is a promise until changed", () => {
    const d = createBlock("delivery_estimate");
    expect(promiseWarnings([d])[d.id]).toBe(SAMPLE_DELIVERY_WARNING);
    expect(sampleWarnings([d])).toEqual({});
    d.props.maxDays = 4;
    expect(promiseWarnings([d])).toEqual({});
  });

  it("support: the shipped 24 h reply is a promise until changed", () => {
    const s = createBlock("support");
    expect(s.props.text).toBe(DEFAULT_TEXTS.fr.supportText);
    expect(promiseWarnings([s])[s.id]).toBe(SAMPLE_PROMISE_WARNING);
    s.props.text = "Écrivez-nous, nous répondons en semaine.";
    expect(promiseWarnings([s])).toEqual({});
  });

  it("clears once the merchant writes their own policy", () => {
    const guarantee = createBlock("guarantee");
    guarantee.props = { title: "Retours sous 14 jours", text: "Retournez le produit sous 14 jours, frais de retour à votre charge." };
    const values = createBlock("value_props");
    values.props.items = [{ icon: "truck", label: "Livraison 4,90 €" }, { icon: "lock", label: "Paiement sécurisé" }];
    const badges = createBlock("trust_badges");
    badges.props.badges = [{ label: "Paiement sécurisé", iconUrl: "" }, { label: "Retours sous 14 jours", iconUrl: "" }];
    const benefits = createBlock("benefits");
    benefits.props.items = [{ icon: "truck", title: "Colissimo suivi", text: "Expédiée sous 72 h" }];
    expect(promiseWarnings([guarantee, values, badges, benefits])).toEqual({});
    // One shipped promise left is enough to flag the block.
    values.props.items.push({ icon: "truck", label: "Livraison offerte" });
    expect(promiseWarnings([values])[values.id]).toBe(SAMPLE_PROMISE_WARNING);
  });
});

describe("templates: countdown and free-shipping bar need their settings", () => {
  const now = Date.parse("2026-06-01T12:00:00Z");

  it("countdown: an empty, invalid or past end date is a setup warning", () => {
    const c = createBlock("countdown");
    expect(setupWarnings([c], { now })[c.id]).toBe("Minuteur : choisir une date de fin");
    c.props.endsAt = "pas une date";
    expect(setupWarnings([c], { now })[c.id]).toBe("Minuteur : choisir une date de fin");
    c.props.endsAt = "2026-05-31T12:00:00Z";
    expect(setupWarnings([c], { now })[c.id]).toBe("Minuteur : choisir une date de fin");
    c.props.endsAt = "2026-06-02T12:00:00Z";
    expect(setupWarnings([c], { now })).toEqual({});
    expect(setupWarnings([{ ...c, props: { ...c.props, endsAt: "" }, hidden: true }], { now })).toEqual({});
  });

  it("the Urgence and Conversion templates warn about their countdown until it has an end date", () => {
    for (const id of ["urgency-promo", "conversion"]) {
      const blocks = CHECKOUT_TEMPLATES.find((x) => x.id === id)!.build(defaultCheckoutLayout()).blocks;
      const countdown = blocks.find((b) => b.type === "countdown")!;
      expect(layoutWarnings(blocks, { now })[countdown.id], id).toBe("Minuteur : choisir une date de fin");
    }
  });

  it("free-shipping bar: threshold 0 warns only when the store has no free-over rate", () => {
    const bar = createBlock("free_shipping_bar");
    expect(bar.props.threshold).toBe(0);
    expect(setupWarnings([bar], { hasFreeShippingRate: false })[bar.id]).toMatch(/seuil de livraison offerte/);
    expect(setupWarnings([bar], { hasFreeShippingRate: true })).toEqual({});
    expect(setupWarnings([bar])).toEqual({}); // rates unknown: no guess
    bar.props.threshold = 50;
    expect(setupWarnings([bar], { hasFreeShippingRate: false })).toEqual({});
  });
});

describe("templates: social, button and support blocks need their settings (hidden from buyers otherwise)", () => {
  it("social without links, button without URL, support without any channel", () => {
    const social = createBlock("social");
    const button = createBlock("button_link");
    const support = createBlock("support");
    support.props.text = "";
    const warnings = setupWarnings([social, button, support]);
    expect(warnings[social.id]).toMatch(/au moins un lien/);
    expect(warnings[button.id]).toMatch(/adresse du lien/);
    expect(warnings[support.id]).toMatch(/Support/);
    social.props.instagram = "https://instagram.com/maison";
    button.props.url = "https://maison.example";
    support.props.whatsapp = "+33 6 12 34 56 78";
    expect(setupWarnings([social, button, support])).toEqual({});
    // A support block needs a channel (e-mail, phone or WhatsApp): its text alone hides it live.
    const textOnly = createBlock("support");
    expect(setupWarnings([textOnly])[textOnly.id]).toBe("Support : indiquer un e-mail, un téléphone ou WhatsApp pour l'afficher");
    expect(isEmptyInLive(textOnly, { preview: false } as unknown as ContentContext, 0)).toBe(true);
    textOnly.props.email = "aide@maison.example";
    expect(setupWarnings([textOnly])).toEqual({});
    expect(isEmptyInLive(textOnly, { preview: false } as unknown as ContentContext, 0)).toBe(false);
    expect(setupWarnings([{ ...createBlock("social"), hidden: true }])).toEqual({});
  });
});

describe("templates: layout-only templates keep the blocks' own style", () => {
  it("a reused block keeps its custom style under a layout-only template, gets the look's under a styled one", () => {
    const badge = createBlock("secure_badge", { placement: "form" });
    badge.style = { ...badge.style, background: "brand", card: true, align: "right" };
    const current = { blocks: [...defaultCheckoutLayout().blocks, badge] };
    for (const t of CHECKOUT_TEMPLATES.filter((x) => !x.style)) {
      const out = t.build(current).blocks.find((b) => b.id === badge.id)!;
      expect(out.style, t.id).toEqual(badge.style);
    }
    // A styled template restyles it: defaults plus its own overrides.
    const styled = CHECKOUT_TEMPLATES.find((x) => x.id === "clean-minimal")!.build(current).blocks.find((b) => b.id === badge.id)!;
    expect(styled.style.background).not.toBe("brand");
    expect(styled.style.align).toBe("center");
  });
});

describe("templates: minimal templates hide (never delete) the extras", () => {
  it("Minimal and Minimal épuré hide the add-ons and trust badges, keeping their content", () => {
    const current = defaultCheckoutLayout();
    for (const id of ["minimal", "clean-minimal"]) {
      const t = CHECKOUT_TEMPLATES.find((x) => x.id === id)!;
      const out = t.build(current).blocks;
      for (const type of ["order_addons", "trust_badges"] as const) {
        const before = current.blocks.find((b) => b.type === type)!;
        expect(out.find((b) => b.id === before.id), `${id}/${type}`).toEqual({ ...before, hidden: true });
      }
      expect(blocksHiddenBy(t, current).map((b) => b.type).sort(), id).toEqual(["order_addons", "trust_badges"]);
      expect(blocksHiddenBy(t, { blocks: out }), id).toEqual([]);
      expect(checkoutLayoutSchema.safeParse({ blocks: out }).success).toBe(true);
    }
    // Other templates hide nothing.
    const out = CHECKOUT_TEMPLATES.find((x) => x.id === "trust")!.build(current).blocks;
    expect(out.filter((b) => b.hidden)).toEqual([]);
  });
});
