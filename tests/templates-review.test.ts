import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBlock, defaultTheme, loadCheckoutLayout, offeredWalletsFor, type Block, type BlockOf, type ExpressWallet } from "@/lib/layout";
import { liveReviewItems, NEVER_OFFERED_LOGOS_WARNING } from "@/lib/sample-content";
import { ContentBlock, headerLogosBlockId, isEmptyInLive, livePaymentLogos, offeredPaymentLogos, PaymentHeaderLogos, type ContentContext } from "@/components/checkout/blocks";
import { expressWalletsOn } from "@/components/checkout/CheckoutView";
import { labelsFor } from "@/components/checkout/i18n";
import { ADDONS_NOTE, layoutWarnings, logosInPaymentHeader, reviewNotes, setupSummary, setupText, setupWarnings, storeNotes } from "@/components/builder/placement";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyTemplateTheme, CHECKOUT_TEMPLATES, THANK_YOU_TEMPLATES } from "@/components/builder/templates";

const ctx = (preview: boolean, extra: Partial<ContentContext> = {}): ContentContext =>
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
    ...extra,
  }) as ContentContext;
const live = ctx(false);
const html = (b: Block, c = live) => renderToStaticMarkup(createElement(ContentBlock, { block: b, ctx: c }));
const untagged = <T extends Block>(b: T): T => ({ ...b, sample: undefined });

describe("A. default order-bump list without add-ons", () => {
  const layout = loadCheckoutLayout(null);
  const bump = layout.blocks.find((b) => b.type === "order_addons")!;

  it("is an amber note, never a block to complete", () => {
    expect(bump).toBeDefined();
    expect(setupWarnings(layout.blocks, { hasAddOns: false })[bump.id]).toBeUndefined();
    expect(storeNotes(layout.blocks, { hasAddOns: false })[bump.id]).toBe(ADDONS_NOTE);
    expect(ADDONS_NOTE).toBe("Options : créez-en une dans « Promos & options » ou masquez ce bloc");
    expect(reviewNotes(layout.blocks, { hasAddOns: false })[bump.id]).toBe(ADDONS_NOTE);
    expect(layoutWarnings(layout.blocks, { hasAddOns: false })[bump.id]).toBe(ADDONS_NOTE);
    expect(storeNotes(layout.blocks, { hasAddOns: true })).toEqual({});
    expect(storeNotes(layout.blocks)).toEqual({});
    expect(storeNotes([{ ...bump, hidden: true }], { hasAddOns: false })).toEqual({});
  });

  it("the default checkout and template cards have nothing to complete for it", () => {
    expect(setupWarnings(layout.blocks, { hasAddOns: false, hasFreeShippingRate: true })).toEqual({});
    for (const t of CHECKOUT_TEMPLATES) {
      const blocks = t.build(layout).blocks;
      const types = Object.keys(setupWarnings(blocks, { hasAddOns: false })).map((id) => blocks.find((b) => b.id === id)!.type);
      expect(types, t.id).not.toContain("order_addons");
    }
  });
});

describe("B. payment logos shown once, only those offered", () => {
  const icons = createBlock("payment_icons");
  icons.props.methods = ["visa", "applepay", "sepa", "crypto"];

  it("live keeps offered logos only; the preview keeps the merchant's list", () => {
    expect(livePaymentLogos(icons.props.methods, live)).toEqual(["visa"]);
    expect(livePaymentLogos(icons.props.methods, ctx(false, { offeredWallets: { applePay: true, googlePay: false } }))).toEqual(["visa", "applepay"]);
    expect(livePaymentLogos(icons.props.methods, ctx(true))).toEqual(["visa", "applepay", "sepa", "crypto"]);
    const out = html(icons);
    expect(out).toContain("VISA");
    expect(out).not.toMatch(/SEPA|Crypto|Apple Pay/);
  });

  it("skipped live when the Payment header shows them, or when none is offered", () => {
    expect(isEmptyInLive(icons, ctx(false, { paymentLogosInHeader: true, headerLogosBlockId: icons.id }), 0)).toBe(true);
    // Only the block shown in the header is skipped: a second payment-logos block still shows.
    expect(isEmptyInLive({ ...icons, id: "other-logos" }, ctx(false, { paymentLogosInHeader: true, headerLogosBlockId: icons.id }), 0)).toBe(false);
    expect(isEmptyInLive(icons, live, 0)).toBe(false);
    expect(isEmptyInLive({ ...icons, props: { ...icons.props, methods: ["sepa", "crypto"] } }, live, 0)).toBe(true);
    expect(isEmptyInLive(icons, ctx(true, { paymentLogosInHeader: true }), 0)).toBe(false);
    const checkout = loadCheckoutLayout(null).blocks;
    expect(logosInPaymentHeader([...checkout, icons])).toBe(icons.id);
    expect(logosInPaymentHeader([icons])).toBeNull();
  });

  it("canvas: the header's logo block gets its own pill; logos drawn once", () => {
    const checkout = loadCheckoutLayout(null).blocks;
    const second = createBlock("payment_icons");
    // Only the first visible logos block feeds the header.
    expect(logosInPaymentHeader([...checkout, icons, second])).toBe(icons.id);
    // None of its logos can show in the header (SEPA / crypto only).
    const never = { ...icons, props: { ...icons.props, methods: ["sepa", "crypto"] } } as typeof icons;
    expect(logosInPaymentHeader([...checkout, never])).toBeNull();
    // Wallet-only logos with the express checkout off (theme or hidden block): none in the header.
    const wallets = { ...icons, props: { ...icons.props, methods: ["applepay", "gpay"] } } as typeof icons;
    expect(logosInPaymentHeader([...checkout, wallets])).toBe(wallets.id);
    expect(logosInPaymentHeader([...checkout, wallets], false)).toBeNull();
    const hiddenExpress = checkout.map((b) => (b.type === "express" ? { ...b, hidden: true } : b));
    expect(logosInPaymentHeader([...hiddenExpress, wallets])).toBeNull();
    // The merchant's express buttons, like the page (expressMethodsShown → offeredWalletsFor):
    // Apple Pay and Google Pay both off → no wallet logo in the header.
    const noWallets = { applePay: false, googlePay: "off" as const, whopPay: true, paypal: true };
    expect(logosInPaymentHeader([...checkout, wallets], true, noWallets)).toBeNull();
    // Google Pay only, on "auto": hidden for a cart to ship, shown for one with nothing to ship.
    const gpayAuto = { applePay: false, googlePay: "auto" as const, whopPay: false, paypal: false };
    const gpayOnly = { ...icons, props: { ...icons.props, methods: ["gpay"] } } as typeof icons;
    expect(logosInPaymentHeader([...checkout, gpayOnly], true, gpayAuto)).toBeNull();
    expect(logosInPaymentHeader([...checkout, gpayOnly], true, gpayAuto, { shippable: false })).toBe(gpayOnly.id);
    expect(logosInPaymentHeader([...checkout, gpayOnly], true, { ...gpayAuto, googlePay: "always" })).toBe(gpayOnly.id);
    // Settings unknown: the defaults (Apple Pay on).
    expect(logosInPaymentHeader([...checkout, wallets], true, undefined)).toBe(wallets.id);
    // Preview: the header block draws a slim placeholder instead of its logos (not drawn twice).
    const inHeader = html(icons, ctx(true, { paymentLogosInHeader: true, headerLogosBlockId: icons.id }));
    expect(inHeader).toContain("data-logos-in-header");
    expect(inHeader).not.toContain("VISA");
    expect(html(second, ctx(true, { paymentLogosInHeader: true, headerLogosBlockId: icons.id }))).toContain("VISA");
    expect(headerLogosBlockId([...checkout, icons], { applePay: false, googlePay: false })).toBe(icons.id);
  });

  it("header logo row: 11px chips, translated fallback name", () => {
    const out = renderToStaticMarkup(createElement(PaymentHeaderLogos, { methods: ["visa"], label: labelsFor("de").acceptedPaymentMethods }));
    expect(out).toContain("text-[11px]");
    expect(out).not.toContain("text-[10px]");
    expect(out).toContain('aria-label="Akzeptierte Zahlungsarten"');
    for (const lang of ["fr", "en", "de", "es", "it", "nl"] as const) {
      expect(labelsFor(lang).acceptedPaymentMethods.length, lang).toBeGreaterThan(0);
      expect(labelsFor(lang).acceptedPaymentMethods, lang).not.toBe(labelsFor(lang).payment);
    }
    expect(labelsFor("fr").acceptedPaymentMethods).toBe("Moyens de paiement acceptés");
  });

  it("thank-you preview: logos buyers won't see there are greyed", () => {
    const all = createBlock("payment_icons");
    all.props.methods = ["visa", "applepay", "gpay"];
    // Thank-you preview: no offeredWallets in its context.
    const out = html(all, ctx(true));
    expect(out.match(/data-not-shown/g)?.length).toBe(2);
    expect(out).toMatch(/data-not-shown=""[^>]*>Apple Pay/);
    expect(out).not.toMatch(/data-not-shown=""[^>]*>VISA/);
    // Checkout preview (wallets known): nothing greyed.
    expect(html(all, ctx(true, { offeredWallets: { applePay: true, googlePay: true } }))).not.toContain("data-not-shown");
  });

  it("wallet logos need the express block shown and on", () => {
    const checkout = loadCheckoutLayout(null).blocks;
    expect(expressWalletsOn(true, checkout)).toBe(true);
    expect(expressWalletsOn(false, checkout)).toBe(false);
    expect(expressWalletsOn(true, checkout.map((b) => (b.type === "express" ? { ...b, hidden: true } : b)))).toBe(false);
    expect(expressWalletsOn(true, checkout.map((b) => (b.type === "express" ? ({ ...b, props: { ...b.props, enabled: false } } as Block) : b)))).toBe(false);
  });

  it("header wallets: only those whose express button really rendered (live), settings in preview", () => {
    const base = { walletsOn: true, pickupSelected: false, configured: ["apple-pay", "google-pay", "whop-pay"] as ExpressWallet[] };
    // Live, nothing resolved yet or no wallet on the device: card brands only.
    expect(offeredWalletsFor({ ...base, rendered: [] })).toEqual({ applePay: false, googlePay: false });
    expect(offeredWalletsFor({ ...base, rendered: ["apple-pay", "whop-pay"] })).toEqual({ applePay: true, googlePay: false });
    // A wallet the merchant turned off is never shown, even if reported.
    expect(offeredWalletsFor({ ...base, configured: ["apple-pay"], rendered: ["apple-pay", "google-pay"] })).toEqual({ applePay: true, googlePay: false });
    // Relay point chosen (wallets hidden) or express section off: none.
    expect(offeredWalletsFor({ ...base, pickupSelected: true, rendered: ["apple-pay", "google-pay"] })).toEqual({ applePay: false, googlePay: false });
    expect(offeredWalletsFor({ ...base, walletsOn: false, rendered: null })).toEqual({ applePay: false, googlePay: false });
    // Builder preview: the merchant's settings.
    expect(offeredWalletsFor({ ...base, rendered: null })).toEqual({ applePay: true, googlePay: true });
    expect(offeredPaymentLogos(["visa", "applepay", "gpay"], offeredWalletsFor({ ...base, rendered: ["google-pay"] }))).toEqual(["visa", "gpay"]);
  });

  it("SEPA / crypto selected: an inline note in the editor, never a warning", () => {
    expect(NEVER_OFFERED_LOGOS_WARNING).toMatch(/SEPA/);
    expect(layoutWarnings([icons])).toEqual({});
  });
});

describe("D. blank reviews", () => {
  it("are never shown; a tagged block shows no review at all", () => {
    const items = [
      { name: "Léa", text: "Parfait", stars: 5, verified: false },
      { name: "Tom", text: "  ", stars: 5, verified: false },
    ];
    const tagged = { ...createBlock("reviews"), sample: true as const };
    tagged.props.items = items;
    expect(liveReviewItems(tagged)).toEqual([]);
    expect(liveReviewItems(untagged(tagged)).map((i) => i.name)).toEqual(["Léa"]);
  });
});

describe("E. no canvas warnings but a product to choose", () => {
  it("countdown, text, guarantee, low stock: no warning; order bump without add-on: one", () => {
    const countdown = createBlock("countdown");
    const text = createBlock("text");
    text.props = { heading: "", body: "" };
    const bump = createBlock("order_addons");
    bump.props.title = "Ajoutez";
    const blocks = [countdown, text, createBlock("low_stock"), bump, createBlock("guarantee")];
    expect(Object.keys(layoutWarnings(blocks, { hasAddOns: false }))).toEqual([bump.id]);
    expect(layoutWarnings(blocks, { hasAddOns: true })).toEqual({});
  });
});

describe("F. empty text block", () => {
  it("renders nothing live", () => {
    const t = untagged(createBlock("text"));
    t.props = { heading: " ", body: "" };
    expect(isEmptyInLive(t, live, 0)).toBe(true);
    expect(isEmptyInLive(t, ctx(true), 0)).toBe(false);
    // A new text block starts empty: nothing live until the merchant writes.
    expect(createBlock("text").props).toEqual({ heading: "", body: "" });
    expect(isEmptyInLive(createBlock("text"), live, 0)).toBe(true);
    // The old shipped placeholders (« Titre », « Votre texte ici. ») never show live.
    const old = untagged(createBlock("text"));
    old.props = { heading: "Titre", body: "Votre texte ici." };
    expect(isEmptyInLive(old, live, 0)).toBe(true);
    expect(isEmptyInLive(old, ctx(true), 0)).toBe(false);
    old.props = { heading: "Titre", body: "Mon vrai texte." };
    expect(isEmptyInLive(old, live, 0)).toBe(false);
    expect(html(old)).toContain("Mon vrai texte.");
    expect(html(old)).not.toContain("Titre");
  });

  it("shows a placeholder in the builder preview only", () => {
    const t = createBlock("text");
    t.props = { heading: " ", body: "" };
    expect(html(t, ctx(true))).toContain("Bloc texte vide");
    expect(html(t)).not.toContain("Bloc texte vide");
    expect(html(createBlock("text"), ctx(true))).toContain("Bloc texte vide");
  });
});

describe("I. loader repair fallback", () => {
  it("resets broken props to the defaults, never tagged, and reviews never get invented ones back", () => {
    const load = (b: Record<string, unknown>) => loadCheckoutLayout({ blocks: [b] }).blocks.find((x) => x.id === b.id);
    const t = load({ id: "t1", type: "testimonial", props: { quote: 123 } });
    expect(t?.sample).toBeUndefined();
    const g = load({ id: "g1", type: "guarantee", props: { title: 123 } });
    expect(g).toBeDefined();
    expect(g?.sample).toBeUndefined();
    const r = load({ id: "r1", type: "reviews", props: { title: "Avis" } }) as BlockOf<"reviews"> | undefined;
    expect(r?.props.items).toEqual([]);
    expect(r && isEmptyInLive(r, live, 0)).toBe(true);
  });

  it("leaves the merchant's own content visible when only a setting was missing", () => {
    const load = (b: Record<string, unknown>) => loadCheckoutLayout({ blocks: [b] }).blocks.find((x) => x.id === b.id);
    // Real reviews stored before a layout setting existed: repaired, still untagged and shown.
    const own = [{ name: "Léa M.", text: "Parfait, merci !", stars: 5, verified: false }];
    const r = load({ id: "r2", type: "reviews", props: { title: "Avis", items: own } }) as BlockOf<"reviews"> | undefined;
    expect(r?.sample).toBeUndefined();
    expect(r?.props.items.map((i) => i.name)).toEqual(["Léa M."]);
    expect(r && isEmptyInLive(r, live, 0)).toBe(false);
  });
});

describe("G. coupon codes", () => {
  it("a new coupon has no invented code or discount: empty, it shows nothing live and no warning", () => {
    const coupon = createBlock("coupon") as BlockOf<"coupon">;
    expect(coupon.props.code).toBe("");
    expect(coupon.props.text).not.toMatch(/%|\d/);
    expect(isEmptyInLive(coupon, live, 0)).toBe(true);
    expect(html(coupon)).toBe("");
    expect(layoutWarnings([coupon])).toEqual({});
  });

  it("the merchant's code shows as written, with no confirmation gate and no warning", () => {
    const coupon = createBlock("coupon") as BlockOf<"coupon">;
    const own = { ...coupon, props: { ...coupon.props, code: "SUMMER" } };
    expect(isEmptyInLive(own, live, 0)).toBe(false);
    expect(html(own)).toContain("SUMMER");
    expect(layoutWarnings([own])).toEqual({});
  });

  it("templates never put a code or a discount live", () => {
    for (const t of [...CHECKOUT_TEMPLATES, ...THANK_YOU_TEMPLATES]) {
      for (const b of t.build({ blocks: [] }).blocks) {
        if (b.type !== "coupon") continue;
        expect(b.props.code, t.id).toBe("");
        expect(`${b.props.title} ${b.props.text}`, t.id).not.toMatch(/%|\d/);
        expect(isEmptyInLive(b, live, 0), t.id).toBe(true);
      }
    }
  });
});

describe("J. coupon repair", () => {
  it("never pairs a real stored coupon code with the shipped discount text", () => {
    const c = loadCheckoutLayout({ blocks: [{ id: "c9", type: "coupon", props: { title: "Merci", code: "SUMMER" } }] }).blocks.find((b) => b.id === "c9") as BlockOf<"coupon"> | undefined;
    expect(c?.props.code).toBe("SUMMER");
    expect(c?.props.text).toBe("");
  });
});

describe("template cards: « produits à choisir » counts only products", () => {
  const upsell = (o: Partial<BlockOf<"upsell">["props"]>) => {
    const b = createBlock("upsell") as BlockOf<"upsell">;
    Object.assign(b.props, o);
    return b;
  };

  it("a product to choose is counted; a %, a price or an add-on to create is its own note", () => {
    const reco = createBlock("recommendations");
    const noProduct = upsell({ productSource: "manual", variantId: "" });
    const auto = upsell({ productSource: "auto" });
    const bump = createBlock("order_addons");
    bump.props.title = "Ajoutez";
    const blocks = [reco, noProduct, auto, bump];
    const all = setupWarnings(blocks, { hasAddOns: false });
    const summary = setupSummary(blocks, { hasAddOns: false });
    // Same items as the canvas warnings, split by kind.
    expect(summary.products + summary.settings.length).toBe(Object.keys(all).length);
    expect(summary.products).toBe(2);
    expect(summary.settings).toContain(ADDONS_NOTE);
    expect(setupText(summary)).toMatch(/^2 produits à choisir · /);
    expect(setupText(summary)).toContain(ADDONS_NOTE);
    // Settings only: no « produit » counted.
    expect(setupText(setupSummary([bump], { hasAddOns: false }))).toBe(ADDONS_NOTE);
    expect(setupText(setupSummary([noProduct]))).toBe("1 produit à choisir");
    expect(setupText({ products: 0, settings: [] })).toBe("");
  });

  it("the builder's cards and the matching page use setupText (no raw warning count)", () => {
    const src = readFileSync(join(__dirname, "..", "src/components/builder/BuilderApp.tsx"), "utf8");
    expect(src).not.toMatch(/Object\.keys\(setupWarnings\([^)]*\)\)\.length/);
    expect(src).toContain("setupText(setupSummary(");
  });

  it("the template dialog says button colors the merchant set are kept", () => {
    const src = readFileSync(join(__dirname, "..", "src/components/builder/BuilderApp.tsx"), "utf8");
    expect(src).toContain("Les couleurs de boutons que vous avez choisies vous-même");
    // …which is true: applying a styled template leaves them as they are.
    const t = CHECKOUT_TEMPLATES.find((x) => x.style)!;
    const own = { payButtonColor: "#123456", payButtonColor2: "#654321", payButtonTextColor: "#ffffff", buttonColor: "#abcdef", buttonTextColor: "#000000" };
    const theme = { ...defaultTheme("Boutique"), ...own };
    expect(applyTemplateTheme(theme, t)).toMatchObject(own);
  });
});
