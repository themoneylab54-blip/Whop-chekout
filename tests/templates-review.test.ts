import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBlock, loadCheckoutLayout, offeredWalletsFor, type Block, type BlockOf, type ExpressWallet } from "@/lib/layout";
import {
  confirmCouponCode,
  hideVisibleSamples,
  isSampleOnly,
  liveReviewItems,
  NEVER_OFFERED_LOGOS_WARNING,
  promiseWarnings,
  sampleWarnings,
  tagDuplicate,
  unconfirmCouponCode,
  visibleSampleIds,
} from "@/lib/sample-content";
import { ContentBlock, headerLogosBlockId, isEmptyInLive, livePaymentLogos, offeredPaymentLogos, PaymentHeaderLogos, type ContentContext } from "@/components/checkout/blocks";
import { expressWalletsOn } from "@/components/checkout/CheckoutView";
import { labelsFor } from "@/components/checkout/i18n";
import { ADDONS_NOTE, hiddenFromBuyers, layoutWarnings, logosInPaymentHeader, reviewNotes, setupWarnings, storeNotes } from "@/components/builder/placement";
import { CHECKOUT_TEMPLATES } from "@/components/builder/templates";

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
    expect(isEmptyInLive(icons, ctx(false, { paymentLogosInHeader: true }), 0)).toBe(true);
    expect(isEmptyInLive(icons, live, 0)).toBe(false);
    expect(isEmptyInLive({ ...icons, props: { ...icons.props, methods: ["sepa", "crypto"] } }, live, 0)).toBe(true);
    expect(isEmptyInLive(icons, ctx(true, { paymentLogosInHeader: true }), 0)).toBe(false);
    const checkout = loadCheckoutLayout(null).blocks;
    // Its logos show next to « Paiement »: seen by buyers, so never greyed « Invisible pour vos clients ».
    expect(hiddenFromBuyers([...checkout, icons]).has(icons.id)).toBe(false);
    expect(logosInPaymentHeader([...checkout, icons])).toBe(icons.id);
    expect(hiddenFromBuyers([icons]).has(icons.id)).toBe(false);
    expect(logosInPaymentHeader([icons])).toBeNull();
  });

  it("canvas: the header's logo block gets its own pill, the others are greyed; logos drawn once", () => {
    const checkout = loadCheckoutLayout(null).blocks;
    const second = createBlock("payment_icons");
    // Only the first visible logos block feeds the header: a second one stays invisible live.
    expect(hiddenFromBuyers([...checkout, icons, second]).has(second.id)).toBe(true);
    expect(logosInPaymentHeader([...checkout, icons, second])).toBe(icons.id);
    // None of its logos can show in the header (SEPA / crypto only): skipped live, greyed.
    const never = { ...icons, props: { ...icons.props, methods: ["sepa", "crypto"] } } as typeof icons;
    expect(logosInPaymentHeader([...checkout, never])).toBeNull();
    expect(hiddenFromBuyers([...checkout, never]).has(never.id)).toBe(true);
    // Wallet-only logos with the express checkout off (theme or hidden block): none in the header.
    const wallets = { ...icons, props: { ...icons.props, methods: ["applepay", "gpay"] } } as typeof icons;
    expect(logosInPaymentHeader([...checkout, wallets])).toBe(wallets.id);
    expect(logosInPaymentHeader([...checkout, wallets], false)).toBeNull();
    expect(hiddenFromBuyers([...checkout, wallets], { expressCheckout: false }).has(wallets.id)).toBe(true);
    const hiddenExpress = checkout.map((b) => (b.type === "express" ? { ...b, hidden: true } : b));
    expect(logosInPaymentHeader([...hiddenExpress, wallets])).toBeNull();
    // The merchant's express buttons, like the page (expressMethodsShown → offeredWalletsFor):
    // Apple Pay and Google Pay both off → no wallet logo in the header.
    const noWallets = { applePay: false, googlePay: "off" as const, whopPay: true, paypal: true };
    expect(logosInPaymentHeader([...checkout, wallets], true, noWallets)).toBeNull();
    expect(hiddenFromBuyers([...checkout, wallets], { expressMethods: noWallets }).has(wallets.id)).toBe(true);
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

  it("thank-you page (no payment block): wallet-only logos are greyed, no wallet offered there", () => {
    const wallets = createBlock("payment_icons");
    wallets.props.methods = ["applepay", "gpay"];
    expect(hiddenFromBuyers([wallets]).has(wallets.id)).toBe(true);
    const payment = loadCheckoutLayout(null).blocks.find((b) => b.type === "payment")!;
    // Checkout without the header row: wallets assumed shown (device-dependent).
    expect(hiddenFromBuyers([{ ...payment, hidden: true }, wallets]).has(wallets.id)).toBe(false);
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

  it("SEPA / crypto selected is flagged", () => {
    expect(promiseWarnings([icons])[icons.id]).toBe(NEVER_OFFERED_LOGOS_WARNING);
    const cards = createBlock("payment_icons");
    cards.props.methods = ["visa", "mastercard"];
    expect(promiseWarnings([cards])).toEqual({});
  });
});

describe("C. duplicating a block with example content", () => {
  it("tags the copy when its content is still sample", () => {
    const old = untagged(createBlock("reviews"));
    expect(tagDuplicate(old).sample).toBe(true);
    const own = untagged(createBlock("reviews"));
    own.props.items = [{ name: "Léa", text: "Parfait", stars: 5, verified: false }];
    expect(tagDuplicate(own).sample).toBeUndefined();
    const g = createBlock("guarantee");
    expect(tagDuplicate(g)).toBe(g);
    const tagged = createBlock("testimonial");
    expect(tagDuplicate(tagged)).toBe(tagged);
  });
});

describe("D. blank reviews", () => {
  it("are dropped only on a tagged block", () => {
    const items = [
      { name: "Léa", text: "Parfait", stars: 5, verified: false },
      { name: "Tom", text: "  ", stars: 5, verified: false },
    ];
    const tagged = createBlock("reviews");
    tagged.props.items = items;
    expect(liveReviewItems(tagged).map((i) => i.name)).toEqual(["Léa"]);
    expect(liveReviewItems(untagged(tagged)).map((i) => i.name)).toEqual(["Léa", "Tom"]);
  });
});

describe("E. canvas greying", () => {
  it("covers every block buyers won't see", () => {
    const countdown = createBlock("countdown");
    const text = createBlock("text");
    text.props = { heading: "", body: "" };
    const low = createBlock("low_stock");
    const bump = createBlock("order_addons");
    const guarantee = createBlock("guarantee");
    const set = hiddenFromBuyers([countdown, text, low, bump, guarantee, { ...createBlock("countdown"), hidden: true }], { hasAddOns: false, now: 0 });
    expect([...set].sort()).toEqual([countdown.id, text.id, bump.id].sort());
    expect(hiddenFromBuyers([bump], { hasAddOns: true }).size).toBe(0);
  });
});

describe("F. empty text block", () => {
  it("renders nothing live", () => {
    const t = untagged(createBlock("text"));
    t.props = { heading: " ", body: "" };
    expect(isEmptyInLive(t, live, 0)).toBe(true);
    expect(isEmptyInLive(t, ctx(true), 0)).toBe(false);
    // Untagged placeholders render as they always did; tagged ones are hidden.
    expect(isEmptyInLive(untagged(createBlock("text")), live, 0)).toBe(false);
    expect(isEmptyInLive(createBlock("text"), live, 0)).toBe(true);
    const own = createBlock("text");
    own.props.heading = "Notre histoire";
    expect(isEmptyInLive(own, live, 0)).toBe(false);
  });

  it("shows a placeholder in the builder preview only", () => {
    const t = createBlock("text");
    t.props = { heading: " ", body: "" };
    expect(html(t, ctx(true))).toContain("Bloc texte vide");
    expect(html(t)).not.toContain("Bloc texte vide");
    expect(html(createBlock("text"), ctx(true))).not.toContain("Bloc texte vide");
  });
});

describe("I. loader repair fallback", () => {
  it("tags a sample-content block reset to its shipped defaults", () => {
    const load = (b: Record<string, unknown>) => loadCheckoutLayout({ blocks: [b] }).blocks.find((x) => x.id === b.id);
    // Broken props (quote not a string): reset to the example testimonial, hidden from buyers.
    const t = load({ id: "t1", type: "testimonial", props: { quote: 123 } });
    expect(t?.sample).toBe(true);
    expect(t && isSampleOnly(t)).toBe(true);
    // Blocks without example content stay untagged.
    const g = load({ id: "g1", type: "guarantee", props: { title: 123 } });
    expect(g).toBeDefined();
    expect(g?.sample).toBeUndefined();
  });

  it("tags a block whose missing content key is filled from the examples", () => {
    const load = (b: Record<string, unknown>) => loadCheckoutLayout({ blocks: [b] }).blocks.find((x) => x.id === b.id);
    // Untagged reviews without items: the example reviews come back, so buyers must not see them.
    const r = load({ id: "r1", type: "reviews", props: { title: "Avis" } });
    expect(r?.sample).toBe(true);
    expect(r && isSampleOnly(r)).toBe(true);
    expect(r && isEmptyInLive(r, live, 0)).toBe(true);
    // Untagged coupon without its code: MERCI10 comes back, hidden from buyers.
    const c = load({ id: "c1", type: "coupon", props: { title: "Merci" } });
    expect(c?.sample).toBe(true);
    expect(c && isEmptyInLive(c, live, 0)).toBe(true);
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

describe("G. « Ce code existe dans ma boutique »", () => {
  it("shows the example code, without warning, and can be undone", () => {
    const coupon = createBlock("coupon") as BlockOf<"coupon">;
    expect(isSampleOnly(coupon)).toBe(true);
    const ok = confirmCouponCode(coupon);
    // The tag stays: the confirmation alone makes the code real content.
    expect(ok.sample).toBe(true);
    expect(ok.props.codeConfirmed).toBe(true);
    expect(isSampleOnly(ok)).toBe(false);
    expect(isEmptyInLive(ok, live, 0)).toBe(false);
    expect(sampleWarnings([ok])).toEqual({});
    expect(promiseWarnings([ok])).toEqual({});
    expect(visibleSampleIds([ok])).toEqual([]);
    const back = unconfirmCouponCode(ok);
    expect(back.sample).toBe(true);
    expect(back.props.codeConfirmed).toBeUndefined();
    expect(isSampleOnly(back)).toBe(true);
  });

  it("re-typing the example code after another one hides it again (confirmation dropped, tag kept)", () => {
    const ok = confirmCouponCode(createBlock("coupon") as BlockOf<"coupon">);
    // The editor drops codeConfirmed on every code change.
    const other = { ...ok, props: { ...ok.props, code: "SOLDES", codeConfirmed: undefined } };
    expect(isSampleOnly(other)).toBe(false);
    const again = { ...other, props: { ...other.props, code: "MERCI10" } };
    expect(isSampleOnly(again)).toBe(true);
    expect(isEmptyInLive(again, live, 0)).toBe(true);
    expect(visibleSampleIds([again])).toEqual([]);
  });

  it("unconfirming an untagged (older) block only drops the confirmation", () => {
    const old = untagged(createBlock("coupon")) as BlockOf<"coupon">;
    const back = unconfirmCouponCode(confirmCouponCode(old));
    expect(back.sample).toBeUndefined();
    expect(back.props.codeConfirmed).toBeUndefined();
    expect(visibleSampleIds([back])).toEqual([back.id]);
  });
});

describe("H. « Masquer les exemples »", () => {
  it("tags untagged blocks still showing examples, nothing else", () => {
    const reviews = untagged(createBlock("reviews"));
    const coupon = untagged(createBlock("coupon"));
    const own = untagged(createBlock("testimonial"));
    own.props.quote = "Je rachète chaque mois.";
    const hidden = { ...untagged(createBlock("announcement")), hidden: true };
    const g = createBlock("guarantee");
    const blocks = [reviews, coupon, own, hidden, g];
    expect(visibleSampleIds(blocks)).toEqual([reviews.id, coupon.id]);
    expect(promiseWarnings(blocks)[reviews.id]).toMatch(/visibles par vos clients/);
    const next = hideVisibleSamples(blocks);
    expect(next.map((b) => b.sample)).toEqual([true, true, undefined, undefined, undefined]);
    expect(next[2]).toBe(own);
    expect(next[4]).toBe(g);
    expect(visibleSampleIds(next)).toEqual([]);
    expect(promiseWarnings(next)[reviews.id]).toBeUndefined();
    expect(isEmptyInLive(next[0], live, 0)).toBe(true);
    expect(hideVisibleSamples([own, g])).toEqual([own, g]);
  });
});

describe("J. publish summary and coupon repair", () => {
  it("counts « Masquer les exemples » as a change buyers will see", async () => {
    const { diffLayout } = await import("@/components/builder/changes");
    const published = loadCheckoutLayout(null);
    const reviews = { ...createBlock("reviews"), sample: undefined } as Block;
    const before = { ...published, blocks: [...published.blocks, reviews] };
    const after = { ...before, blocks: before.blocks.map((b) => (b.id === reviews.id ? { ...b, sample: true as const } : b)) };
    expect(diffLayout(after, before).modified).toBe(1);
  });

  it("never pairs a real stored coupon code with the shipped discount text", () => {
    const c = loadCheckoutLayout({ blocks: [{ id: "c9", type: "coupon", props: { title: "Merci", code: "SUMMER" } }] }).blocks.find((b) => b.id === "c9") as BlockOf<"coupon"> | undefined;
    expect(c?.props.code).toBe("SUMMER");
    expect(c?.props.text).toBe("");
  });
});
