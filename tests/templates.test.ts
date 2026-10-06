import { describe, expect, it } from "vitest";
import {
  applyTemplateTheme,
  blocksKeptAside,
  blocksShownBy,
  CHECKOUT_TEMPLATES,
  isCurrentTemplate,
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
import { layoutWarnings, setupWarnings } from "@/components/builder/placement";
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
    for (const t of [...CHECKOUT_TEMPLATES, ...THANK_YOU_TEMPLATES]) {
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

  it.each(THANK_YOU_TEMPLATES.filter((t) => t.style).map((t) => [t.id, t] as const))("thank-you %s: every surface of the page passes AA", (_, t: Template) => {
    const theme = applyTemplateTheme(merchantTheme(), t);
    expect(contrastFailures(theme).map((c) => `${c.what}: ${c.fg} on ${c.bg} = ${c.ratio.toFixed(2)}`)).toEqual([]);
    // ThankYouView: secondary text (text-neutral-600) on the page, the summary card and white cards;
    // icons (accent) on them; the CTA label on its button.
    const page = theme.pageBackground || "#ffffff";
    for (const bg of [page, theme.summaryBackground || page, "#ffffff"]) {
      expect(contrastRatio("#525252", bg), `muted on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.textColor, bg), `text on ${bg}`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(theme.accentColor, bg), `icons on ${bg}`).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(readableOn(theme.accentColor), theme.accentColor)).toBeGreaterThanOrEqual(4.5);
    if (theme.accentColor2) expect(contrastRatio(readableOn(theme.accentColor), theme.accentColor2)).toBeGreaterThanOrEqual(4.5);
  });

  it("« Luxe noir & or » has a real gold", () => {
    const t = CHECKOUT_TEMPLATES.find((x) => x.id === "luxury-black-gold")!;
    expect(t.style!.borderColor).toBe("#c9a646");
    expect(t.description).toMatch(/or\b/);
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
    expect(r.placement).toBe("form"); // the merchant's placement is kept (the template only orders it)
    expect(r.style).toEqual(reviews.style);
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
  it("a new reviews block holds no invented review", () => {
    const r = createBlock("reviews");
    expect(r.props.items).toEqual([]);
    for (const t of [...CHECKOUT_TEMPLATES, ...THANK_YOU_TEMPLATES])
      for (const b of t.build({ blocks: [] }).blocks) if (b.type === "reviews") expect(b.props.items, t.id).toEqual([]);
  });

  it("no template ships the example free-shipping announcement", () => {
    for (const t of [...CHECKOUT_TEMPLATES, ...THANK_YOU_TEMPLATES]) expect(t.spec.map(([type]) => type), t.id).not.toContain("announcement");
  });

  it.each(all.map(({ t, page }) => [`${page}/${t.id}`, t] as const))("%s: only a product to choose is flagged; nothing is tagged as an example", (_, t) => {
    const blocks = t.build({ blocks: [] }).blocks;
    const warnings = layoutWarnings(blocks, { hasAddOns: true });
    for (const b of blocks) {
      expect(b.sample, `${t.id}/${b.type}`).toBeUndefined();
      if (!["upsell", "recommendations", "order_addons"].includes(b.type)) expect(warnings[b.id], `${t.id}/${b.type}`).toBeUndefined();
    }
  });

  it("the testimonial ships without a « Client vérifié » author vouching for it", () => {
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
    // Not next to the confirmation (that place is the old « Simple » note, reused as the message).
    const current = { blocks: [...blocks.slice(0, 2), text, ...blocks.slice(2)] };
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
    expect([...a.side, ...a.summary].map((b) => b.type)).toEqual(["payment_icons", "secure_badge", "guarantee", "reviews"]);
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

  it("counts only the products each template leaves to choose", () => {
    const t = CHECKOUT_TEMPLATES.find((x) => x.id === "urgency-promo")!;
    const blocks = t.build(defaultCheckoutLayout()).blocks;
    const types = Object.keys(setupWarnings(blocks)).map((id) => blocks.find((b) => b.id === id)!.type);
    // Cross-sells without products (the countdown and the empty reviews need nothing).
    expect(types.sort()).toEqual(["recommendations"]);
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

describe("templates: example texts are never flagged", () => {
  it("guarantee, benefits, value props, why-us, comparison, FAQ, support, delivery estimate, countdown, free-shipping bar, social, button: no warning", () => {
    const types = ["guarantee", "benefits", "value_props", "why_us", "comparison", "faq", "support", "delivery_estimate", "countdown", "free_shipping_bar", "social", "button_link"] as const;
    const blocks = types.map((t) => createBlock(t));
    expect(layoutWarnings(blocks, { hasFreeShippingRate: false, now: Date.parse("2026-06-01T12:00:00Z") })).toEqual({});
    expect(setupWarnings(blocks)).toEqual({});
  });

  it("the default checkout: non-binding trust badges, translated in every language, nothing flagged", () => {
    const blocks = defaultCheckoutLayout().blocks;
    const badges = blocks.find((b) => b.type === "trust_badges")!;
    expect(badges.type === "trust_badges" && badges.props.badges.map((x) => x.label)).toEqual(["Paiement sécurisé", "Données chiffrées", "Suivi de commande"]);
    expect(layoutWarnings(blocks, { hasAddOns: true })).toEqual({});
    expect(layoutWarnings(defaultThankYouLayout().blocks)).toEqual({});
    for (const lang of Object.keys(DEFAULT_TEXTS) as (keyof typeof DEFAULT_TEXTS)[]) {
      expect(translateDefault("Données chiffrées", lang), lang).toBe(DEFAULT_TEXTS[lang].encryptedData);
      expect(translateDefault("Suivi de commande", lang), lang).toBe(DEFAULT_TEXTS[lang].orderTracking);
    }
  });

  it("a support block without any channel has nothing to show live (no warning either)", () => {
    const textOnly = createBlock("support");
    expect(isEmptyInLive(textOnly, { preview: false } as unknown as ContentContext, 0)).toBe(true);
    textOnly.props.email = "aide@maison.example";
    expect(isEmptyInLive(textOnly, { preview: false } as unknown as ContentContext, 0)).toBe(false);
  });
});

describe("templates: the merchant's blocks keep their own style and placement", () => {
  it("a reused block keeps its style and placement under every template; a created one takes the template's", () => {
    const badge = createBlock("secure_badge", { placement: "form" });
    badge.style = { ...badge.style, background: "brand", card: true, align: "right" };
    const current = { blocks: [...defaultCheckoutLayout().blocks, badge] };
    for (const t of CHECKOUT_TEMPLATES.filter((x) => x.spec.some(([type]) => type === "secure_badge"))) {
      const out = t.build(current).blocks.find((b) => b.id === badge.id)!;
      expect(out.style, t.id).toEqual(badge.style);
      expect(out.placement, t.id).toBe("form");
    }
    // Created by the template: its own overrides.
    const created = CHECKOUT_TEMPLATES.find((x) => x.id === "clean-minimal")!.build(defaultCheckoutLayout()).blocks.find((b) => b.type === "secure_badge")!;
    expect(created.style.align).toBe("center");
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
        expect(out.find((b) => b.id === before.id), `${id}/${type}`).toEqual({ ...before, hidden: true, hiddenByTemplate: id });
      }
      expect(blocksHiddenBy(t, current).map((b) => b.type).sort(), id).toEqual(["order_addons", "trust_badges"]);
      expect(blocksHiddenBy(t, { blocks: out }), id).toEqual([]);
      expect(checkoutLayoutSchema.safeParse({ blocks: out }).success).toBe(true);
    }
    // Templates without their own reassurance hide nothing.
    const out = CHECKOUT_TEMPLATES.find((x) => x.id === "sport-performance")!.build(current).blocks;
    expect(out.filter((b) => b.hidden)).toEqual([]);
  });
});

describe("templates: merchant rules (thank-you note, no fake or live-empty content, no duplicates)", () => {
  const ty = (id: string) => THANK_YOU_TEMPLATES.find((x) => x.id === id)!;
  const co = (id: string) => CHECKOUT_TEMPLATES.find((x) => x.id === id)!;

  it.each(THANK_YOU_TEMPLATES.map((t) => [t.id, t] as const))("thank-you %s: exactly one message card, right after the confirmation (or its offer)", (_, t) => {
    expect(THANK_YOU_TEMPLATES.length).toBe(15);
    for (const base of [defaultThankYouLayout(), { blocks: [] }]) {
      const blocks = t.build(base).blocks;
      const messages = blocks.filter((b) => b.type === "message");
      expect(messages).toHaveLength(1);
      expect(messages[0].style.card).toBe(true);
      const types = blocks.map((b) => b.type);
      const before = types[types.indexOf("message") - 1];
      expect(before === "ty_confirmation" || before === "upsell", before).toBe(true);
    }
    const types = t.spec.map(([type]) => type);
    for (const gone of ["delivery_estimate", "support", "social", "button_link", "testimonial", "stats"]) expect(types, gone).not.toContain(gone);
  });

  it("no coupon title starts with « Merci »", () => {
    for (const t of THANK_YOU_TEMPLATES)
      for (const b of t.build({ blocks: [] }).blocks) if (b.type === "coupon") expect(b.props.title, t.id).not.toMatch(/^merci/i);
  });

  it("no template adds a parcel protection, an invented figure or quote, or a date countdown without its date", () => {
    for (const t of [...CHECKOUT_TEMPLATES, ...THANK_YOU_TEMPLATES]) {
      const blocks = t.build({ blocks: [] }).blocks;
      expect(blocks.filter((b) => b.type === "shipping_protection" && !b.hidden), t.id).toEqual([]);
      for (const b of blocks) {
        expect(["stats", "testimonial", "rating"], `${t.id}/${b.type}`).not.toContain(b.type);
        if (b.type === "countdown") expect(b.props.mode, t.id).toBe("evergreen");
        if (b.type === "reviews") expect(b.props.items, t.id).toEqual([]);
      }
    }
  });

  it("example texts of created blocks make no precise promise (days, hours, free shipping)", () => {
    for (const t of [...CHECKOUT_TEMPLATES, ...THANK_YOU_TEMPLATES]) {
      for (const b of t.build({ blocks: [] }).blocks) {
        if (["free_shipping_bar", "shipping_protection"].includes(b.type)) continue; // driven by the store's own rates / settings
        const json = JSON.stringify(b.props);
        expect(json, `${t.id}/${b.type}`).not.toMatch(/\d+\s*(jours|h\b)|livraison offerte|\+10 000|4,8/i);
      }
    }
  });

  it("per-visitor countdowns claim no offer end: « Votre panier est réservé pendant {timer} », translated in 6 languages", () => {
    const withCountdown = CHECKOUT_TEMPLATES.filter((t) => t.spec.some(([type]) => type === "countdown"));
    expect(withCountdown.length).toBeGreaterThanOrEqual(2);
    for (const t of withCountdown) {
      for (const b of t.build({ blocks: [] }).blocks) {
        if (b.type !== "countdown") continue;
        expect(b.props.label, t.id).toBe("Votre panier est réservé pendant {timer}");
        expect(b.props.label, t.id).not.toMatch(/se termine/i);
      }
    }
    expect(translateDefault("Votre panier est réservé pendant {timer}", "en")).toBe("Your cart is reserved for {timer}");
    expect(translateDefault("Votre panier est réservé pendant {timer}", "nl")).toBe(DEFAULT_TEXTS.nl.countdownCart);
  });

  it("no contact promise the page can't keep (guarantee and FAQ texts are self-contained, translated)", () => {
    const texts: string[] = [];
    for (const t of [...CHECKOUT_TEMPLATES, ...THANK_YOU_TEMPLATES]) {
      for (const b of t.build({ blocks: [] }).blocks) {
        const json = JSON.stringify(b.props);
        expect(json, `${t.id}/${b.type}`).not.toMatch(/écrivez-nous|contacter|une question sur votre commande/i);
        if (b.type === "guarantee") texts.push(b.props.title, b.props.text);
        if (b.type === "faq") texts.push(...b.props.items.flatMap((x) => [x.q, x.a]));
      }
    }
    expect(texts).toContain("Commande suivie");
    expect(texts).toContain("Quand vais-je recevoir ma confirmation ?");
    for (const text of texts) {
      expect(isShippedDefault(text), text).toBe(true);
      for (const lang of ["en", "de", "es", "it", "nl"] as const) expect(translateDefault(text, lang), `${lang}: ${text}`).not.toBe(text);
    }
  });

  it.each(CHECKOUT_TEMPLATES.map((t) => [t.id, t] as const))("%s on the default checkout: secure payment said once", (_, t) => {
    const blocks = t.build(defaultCheckoutLayout()).blocks.filter((b) => !b.hidden);
    const said: string[] = [];
    for (const b of blocks) {
      if (b.type === "trust_badges") said.push(...b.props.badges.map((x) => x.label));
      if (b.type === "value_props") said.push(...b.props.items.map((x) => x.label));
      if (b.type === "secure_badge") said.push(b.props.text);
      if (b.type === "benefits") said.push(...b.props.items.map((x) => x.title));
    }
    expect(said.filter((x) => /paiement.*sécurisé/i.test(x)).length, said.join(" | ")).toBeLessThanOrEqual(1);
    if (t.spec.some(([type]) => ["secure_badge", "value_props", "payment_icons"].includes(type))) {
      expect(blocks.map((b) => b.type), t.id).not.toContain("trust_badges");
    }
  });

  it("a template shows again what an earlier template hid, never what the merchant hid", () => {
    const minimal = co("minimal").build(defaultCheckoutLayout());
    expect(minimal.blocks.filter((b) => b.hidden).map((b) => b.type).sort()).toEqual(["order_addons", "trust_badges"]);
    // Conversion lists the add-ons and has no reassurance of its own beyond the secure badge.
    const conversion = co("conversion").build(minimal).blocks;
    expect(conversion.find((b) => b.type === "order_addons")).toMatchObject({ hidden: false });
    expect(conversion.find((b) => b.type === "order_addons")?.hiddenByTemplate).toBeUndefined();
    // Sport adds no reassurance that repeats the badges: both come back.
    const sport = co("sport-performance").build(minimal).blocks;
    expect(sport.filter((b) => b.hidden)).toEqual([]);
    expect(blocksShownBy(co("sport-performance"), minimal).map((b) => b.type).sort()).toEqual(["order_addons", "trust_badges"]);
    // Hidden by the merchant (no marker): stays hidden.
    const mine = { blocks: defaultCheckoutLayout().blocks.map((b) => (b.type === "trust_badges" ? { ...b, hidden: true } : b)) };
    expect(co("sport-performance").build(mine).blocks.find((b) => b.type === "trust_badges")?.hidden).toBe(true);
    expect(blocksShownBy(co("sport-performance"), mine)).toEqual([]);
  });

  it("re-applying Simple over its untouched old Text note keeps one note (the Text becomes the message, unsigned)", () => {
    const base = defaultThankYouLayout().blocks;
    const blank = createBlock("text", { id: "note2" });
    blank.style = { ...blank.style, align: "center" };
    const page = { blocks: [base[0], blank, ...base.slice(1)] };
    const out = ty("simple").build(page, { storeName: "Maison Lune" }).blocks;
    expect(out.filter((b) => b.type === "message" || b.type === "text")).toHaveLength(1);
    const m = out.find((b) => b.type === "message")!;
    expect(m.id).toBe("note2");
    expect(m.type === "message" && m.props).toEqual(createBlock("message").props);
    expect(m.type === "message" && m.props.signatureName).toBe("");
    expect(m.style.align).toBe("center");
    expect(thankYouLayoutSchema.safeParse({ blocks: out }).success).toBe(true);
    expect(blocksKeptAside(ty("simple").spec, page)).toEqual([]);
  });

  it("a note the merchant wrote stays their Text block, whole and as written (never cut into a message)", () => {
    const text = createBlock("text", { id: "note1" });
    const long = "Votre colis part demain. ".repeat(400).trim();
    text.props = { heading: "Merci !", body: long };
    text.i18n = { en: { heading: "Thanks!", body: "Ships tomorrow." } };
    const base = defaultThankYouLayout().blocks;
    const out = ty("simple").build({ blocks: [base[0], text, ...base.slice(1)] }, { storeName: "Maison Lune" }).blocks;
    const kept = out.find((b) => b.id === "note1")!;
    expect(kept.type).toBe("text");
    expect(kept.type === "text" && kept.props).toEqual({ heading: "Merci !", body: long });
    expect(kept.i18n).toEqual({ en: { heading: "Thanks!", body: "Ships tomorrow." } });
    expect(thankYouLayoutSchema.safeParse({ blocks: out }).success).toBe(true);
  });

  it("trust badges the merchant edited are never hidden by a template (untouched ones are)", () => {
    const edited = {
      blocks: defaultCheckoutLayout().blocks.map((b) =>
        b.type === "trust_badges" ? { ...b, props: { badges: [{ label: "Fabriqué en France", iconUrl: "" }, ...b.props.badges.slice(1)] } } : b,
      ),
    };
    const t = co("trust-max");
    expect(t.hides).toContain("trust_badges");
    expect(t.build(edited).blocks.find((b) => b.type === "trust_badges")?.hidden).toBe(false);
    expect(blocksHiddenBy(t, edited).map((b) => b.type)).not.toContain("trust_badges");
    // Untouched defaults: hidden (the template's own reassurance already says it).
    expect(t.build(defaultCheckoutLayout()).blocks.find((b) => b.type === "trust_badges")?.hidden).toBe(true);
  });

  it("« Actuel » only while the shared style is still the template's look", () => {
    const t = ty("clean-minimal");
    const theme = applyTemplateTheme(themeSchema.parse({}), t);
    expect(isCurrentTemplate(t, "clean-minimal", theme)).toBe(true);
    expect(isCurrentTemplate(t, "apple-minimal", theme)).toBe(true);
    // A styled checkout template applied alone changed the shared look.
    expect(isCurrentTemplate(t, "clean-minimal", applyTemplateTheme(theme, co("dark-premium")))).toBe(false);
    // Layout-only templates: the id alone.
    expect(isCurrentTemplate(ty("simple"), "simple", applyTemplateTheme(theme, co("dark-premium")))).toBe(true);
    expect(isCurrentTemplate(ty("simple"), "loyalty", theme)).toBe(false);
  });

  it("descriptions say what renders", () => {
    expect(co("compact-mobile").description).not.toMatch(/gros boutons/);
    expect(co("trust-max").description).not.toMatch(/protection/i);
    for (const t of THANK_YOU_TEMPLATES) expect(t.description, t.id).not.toMatch(/étroit|support/i);
  });
});
