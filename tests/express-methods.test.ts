import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBlock as createBlockOf, DEFAULT_EXPRESS_METHODS, defaultCheckoutLayout, expressMethodsAllOff, expressMethodsShown, loadCheckoutLayout, loadTheme, paypalExpressAllowed, themeSchema } from "@/lib/layout";
import { ExpressPreview, PaymentPreview } from "@/components/checkout/Payment";
import type { ExpressWallet } from "@/lib/layout";
import { labelsFor } from "@/components/checkout/i18n";

/*
 * "Paiements express (en haut du checkout)": the merchant picks Apple Pay, Google Pay (off / auto /
 * always), Whop Pay and PayPal. Stored as theme.expressMethods; designs saved before it get the
 * previous behaviour (all on, Google Pay only when nothing ships).
 */

describe("theme.expressMethods: schema", () => {
  it("defaults to the previous behaviour on designs saved before the setting", () => {
    expect(themeSchema.parse({}).expressMethods).toEqual({ applePay: true, googlePay: "auto", whopPay: true, paypal: true });
    expect(loadTheme({ accentColor: "#ff0000", expressCheckout: true }).expressMethods).toEqual(DEFAULT_EXPRESS_METHODS);
    expect(loadTheme(null).expressMethods).toEqual(DEFAULT_EXPRESS_METHODS);
  });

  it("fills missing fields and repairs bad ones without failing (nor dropping the rest of the design)", () => {
    expect(themeSchema.parse({ expressMethods: { paypal: false } }).expressMethods).toEqual({ ...DEFAULT_EXPRESS_METHODS, paypal: false });
    const t = themeSchema.parse({ accentColor: "#ff0000", expressMethods: { applePay: "yes", googlePay: "sometimes", whopPay: false } });
    expect(t.expressMethods).toEqual({ ...DEFAULT_EXPRESS_METHODS, whopPay: false });
    expect(t.accentColor).toBe("#ff0000");
    for (const bad of [null, "on", 3, []]) expect(themeSchema.safeParse({ expressMethods: bad }).success).toBe(true);
    expect(loadTheme({ accentColor: "#ff0000", expressMethods: "garbage" })).toMatchObject({ accentColor: "#ff0000", expressMethods: DEFAULT_EXPRESS_METHODS });
  });

  it("round-trips the merchant's choice", () => {
    const m = { applePay: false, googlePay: "always", whopPay: true, paypal: false } as const;
    expect(themeSchema.parse(JSON.parse(JSON.stringify(themeSchema.parse({ expressMethods: m })))).expressMethods).toEqual(m);
  });
});

describe("expressMethodsShown", () => {
  it("defaults: every wallet and PayPal, Google Pay only when nothing ships", () => {
    expect(expressMethodsShown(undefined, { shippable: false })).toEqual({ wallets: ["apple-pay", "google-pay", "whop-pay"], paypal: true });
    expect(expressMethodsShown(undefined, { shippable: true })).toEqual({ wallets: ["apple-pay", "whop-pay"], paypal: true });
    expect(expressMethodsShown(DEFAULT_EXPRESS_METHODS, { shippable: true })).toEqual({ wallets: ["apple-pay", "whop-pay"], paypal: true });
  });

  it("Google Pay: off never, always even for goods to ship", () => {
    const off = { ...DEFAULT_EXPRESS_METHODS, googlePay: "off" as const };
    const always = { ...DEFAULT_EXPRESS_METHODS, googlePay: "always" as const };
    for (const shippable of [false, true]) {
      expect(expressMethodsShown(off, { shippable }).wallets).not.toContain("google-pay");
      expect(expressMethodsShown(always, { shippable }).wallets).toContain("google-pay");
    }
  });

  it("each switch removes its button; all off = nothing to show", () => {
    expect(expressMethodsShown({ ...DEFAULT_EXPRESS_METHODS, applePay: false, paypal: false }, { shippable: false })).toEqual({ wallets: ["google-pay", "whop-pay"], paypal: false });
    expect(expressMethodsShown({ applePay: false, googlePay: "off", whopPay: false, paypal: false }, { shippable: false })).toEqual({ wallets: [], paypal: false });
    // Only Google Pay on "auto" with goods to ship: nothing either.
    expect(expressMethodsShown({ applePay: false, googlePay: "auto", whopPay: false, paypal: false }, { shippable: true })).toEqual({ wallets: [], paypal: false });
  });

  it("paypalExpressAllowed follows the PayPal switch (missing = allowed)", () => {
    const layout = defaultCheckoutLayout();
    expect(paypalExpressAllowed({}, layout)).toBe(true);
    expect(paypalExpressAllowed({ expressMethods: DEFAULT_EXPRESS_METHODS }, layout)).toBe(true);
    expect(paypalExpressAllowed({ expressMethods: { ...DEFAULT_EXPRESS_METHODS, paypal: false } }, layout)).toBe(false);
  });

  it("paypalExpressAllowed also needs the express section on the page (theme switch, block enabled and not hidden)", () => {
    const layout = loadCheckoutLayout(null);
    const theme = { expressMethods: DEFAULT_EXPRESS_METHODS, expressCheckout: true };
    const withExpress = (patch: Record<string, unknown>) => ({
      blocks: layout.blocks.map((b) => (b.type === "express" ? ({ ...b, ...patch, props: { ...b.props, ...((patch.props as object) ?? {}) } } as typeof b) : b)),
    });
    expect(paypalExpressAllowed(theme, layout)).toBe(true);
    // The legacy theme switch off: no express section, so no PayPal-only checkout.
    expect(paypalExpressAllowed({ ...theme, expressCheckout: false }, layout)).toBe(false);
    expect(paypalExpressAllowed(loadTheme({ expressCheckout: false }), layout)).toBe(false);
    // The express block switched off, or hidden in the builder.
    expect(paypalExpressAllowed(theme, withExpress({ props: { enabled: false } }))).toBe(false);
    expect(paypalExpressAllowed(theme, withExpress({ hidden: true }))).toBe(false);
    // No express block at all (never after loadCheckoutLayout, which re-adds it).
    expect(paypalExpressAllowed(theme, { blocks: layout.blocks.filter((b) => b.type !== "express") })).toBe(false);
    expect(paypalExpressAllowed(theme, loadCheckoutLayout({ blocks: layout.blocks.filter((b) => b.type !== "express") }))).toBe(true);
  });

  it("expressMethodsAllOff: every button off whatever the cart; only Google Pay on \"auto\" is cart-dependent, not off", async () => {
    const { expressMethodsCartDependent } = await import("@/lib/layout");
    const none = { applePay: false, whopPay: false, paypal: false };
    expect(expressMethodsAllOff({ ...none, googlePay: "off" })).toBe(true);
    // Cart-dependent (shows for carts with nothing to ship): never "all off" — no caller must
    // check expressMethodsCartDependent first to tell them apart.
    expect(expressMethodsAllOff({ ...none, googlePay: "auto" })).toBe(false);
    expect(expressMethodsCartDependent({ ...none, googlePay: "auto" })).toBe(true);
    for (const g of ["off", "auto", "always"] as const) {
      expect(expressMethodsAllOff({ ...none, googlePay: g }) && expressMethodsCartDependent({ ...none, googlePay: g })).toBe(false);
    }
    expect(expressMethodsAllOff({ ...none, googlePay: "always" })).toBe(false);
    expect(expressMethodsAllOff({ ...none, googlePay: "auto", paypal: true })).toBe(false);
    expect(expressMethodsAllOff(DEFAULT_EXPRESS_METHODS)).toBe(false);
    expect(expressMethodsAllOff(undefined)).toBe(false);
  });

  it("stored settings are parsed through expressMethodsSchema, never spread (undefined or stray values get their default)", async () => {
    const { expressMethodsCartDependent } = await import("@/lib/layout");
    const none = { applePay: false, whopPay: false, paypal: false };
    // A key present but undefined keeps its default (a spread would have put undefined there).
    expect(expressMethodsShown({ paypal: undefined, applePay: undefined }, { shippable: true })).toEqual({ wallets: ["apple-pay", "whop-pay"], paypal: true });
    expect(expressMethodsAllOff({ ...none, googlePay: undefined })).toBe(false);
    expect(expressMethodsCartDependent({ ...none, googlePay: undefined })).toBe(true);
    // A stray stored value falls back to the schema's default.
    expect(expressMethodsShown({ ...none, googlePay: "sometimes" as never }, { shippable: false }).wallets).toEqual(["google-pay"]);
    expect(expressMethodsAllOff({ ...none, googlePay: "nope" as never })).toBe(false);
    expect(expressMethodsAllOff({ applePay: "no" as never, whopPay: false, paypal: false, googlePay: "off" })).toBe(false);
    expect(expressMethodsAllOff(null)).toBe(false);
  });

  it("builder row: only Google Pay on \"auto\" is not greyed but badged « selon le panier »; really off stays « Désactivé »", async () => {
    const { expressRowState } = await import("@/components/builder/placement");
    const { expressMethodsCartDependent } = await import("@/lib/layout");
    const express = defaultCheckoutLayout().blocks.find((b) => b.type === "express")!;
    const none = { applePay: false, whopPay: false, paypal: false };
    const theme = (m: Record<string, unknown> | undefined, expressCheckout = true) => ({ expressCheckout, expressMethods: m as never });
    expect(expressMethodsCartDependent({ ...none, googlePay: "auto" })).toBe(true);
    expect(expressMethodsCartDependent({ ...none, googlePay: "auto", paypal: true })).toBe(false);
    expect(expressMethodsCartDependent(undefined)).toBe(false);
    expect(expressRowState(express, theme({ ...none, googlePay: "auto" }))).toEqual({ off: false, badge: "selon le panier" });
    expect(expressRowState(express, theme({ ...none, googlePay: "off" }))).toEqual({ off: true });
    expect(expressRowState(express, theme({ ...none, googlePay: "always" }))).toEqual({ off: false });
    expect(expressRowState(express, theme(undefined))).toEqual({ off: false });
    // Section or block off: « Désactivé » whatever the buttons.
    expect(expressRowState(express, theme({ ...none, googlePay: "auto" }, false))).toEqual({ off: true });
    expect(expressRowState({ ...express, props: { ...express.props, enabled: false } } as typeof express, theme(undefined))).toEqual({ off: true });
    // A hidden row (« Masqué »): no « selon le panier » badge, buyers never see it whatever the cart.
    expect(expressRowState({ ...express, hidden: true }, theme({ ...none, googlePay: "auto" }))).toEqual({ off: false });
    expect(expressRowState({ ...express, hidden: true }, theme({ ...none, googlePay: "off" }))).toEqual({ off: true });
    // Other blocks: never.
    expect(expressRowState(createBlockOf("payment_icons"), theme({ ...none, googlePay: "off" }))).toEqual({ off: false });
  });

  it("builder row: `enabled` missing counts as on, like paypalExpressAllowed", async () => {
    const { expressRowState } = await import("@/components/builder/placement");
    const express = defaultCheckoutLayout().blocks.find((b) => b.type === "express")!;
    const rest: Record<string, unknown> = { ...express.props };
    delete rest.enabled;
    const noEnabled = { ...express, props: rest } as typeof express;
    const theme = { expressCheckout: true, expressMethods: DEFAULT_EXPRESS_METHODS };
    expect(expressRowState(noEnabled, theme)).toEqual({ off: false });
    expect(paypalExpressAllowed(theme, { blocks: [noEnabled] })).toBe(true);
  });

  it("paypalExpressAllowed reads the switch through the schema (a stray value is the default: on)", () => {
    const layout = defaultCheckoutLayout();
    expect(paypalExpressAllowed({ expressMethods: { paypal: "no" as never } }, layout)).toBe(true);
    expect(paypalExpressAllowed({ expressMethods: null }, layout)).toBe(true);
    expect(paypalExpressAllowed({ expressMethods: { paypal: false } }, layout)).toBe(false);
    expect(paypalExpressAllowed({ expressMethods: { paypal: "no" as never } }, layout)).toBe(expressMethodsShown({ paypal: "no" as never }, { shippable: false }).paypal);
  });

  it("cartShippable: free gifts ship too; a line at quantity 0 ships nothing", async () => {
    const { cartShippable } = await import("@/lib/layout");
    const digital = { requiresShipping: false, quantity: 1 };
    expect(cartShippable([digital], [])).toBe(false);
    expect(cartShippable([digital], [{ requiresShipping: true, quantity: 1 }])).toBe(true);
    expect(cartShippable([digital, { requiresShipping: true, quantity: 0 }], [])).toBe(false);
    expect(cartShippable([{ requiresShipping: true, quantity: 2 }], [])).toBe(true);
    // Google Pay on "auto" follows it.
    const auto = { ...DEFAULT_EXPRESS_METHODS, googlePay: "auto" as const };
    expect(expressMethodsShown(auto, { shippable: cartShippable([digital], [{ requiresShipping: true, quantity: 1 }]) }).wallets).not.toContain("google-pay");
    expect(expressMethodsShown(auto, { shippable: cartShippable([digital, { requiresShipping: true, quantity: 0 }], []) }).wallets).toContain("google-pay");
  });
});

describe("ExpressPreview (builder)", () => {
  const labels = labelsFor("fr");
  const html = (props: Partial<Parameters<typeof ExpressPreview>[0]>) => renderToStaticMarkup(createElement(ExpressPreview, { labels, ...props }));

  it("shows the chosen buttons only", () => {
    const out = html({ walletMethods: ["apple-pay", "whop-pay"], paypal: false });
    expect(out).toContain('data-express-method="apple-pay"');
    expect(out).toContain('data-express-method="whop-pay"');
    expect(out).not.toContain('data-express-method="google-pay"');
    expect(out).not.toContain('data-express-method="paypal"');
    expect(html({ walletMethods: [], paypal: true })).toContain('data-express-method="paypal"');
  });

  it("renders nothing when every button is off (no empty grid, no divider)", () => {
    expect(html({ walletMethods: [], paypal: false })).toBe("");
  });
});

describe("PaymentPreview (builder): wallet tabs", () => {
  const labels = labelsFor("fr");
  const tabs = (hideWallets?: ExpressWallet[]) => renderToStaticMarkup(createElement(PaymentPreview, { labels, payLabel: "Payer", hideWallets }));

  it("hides only the wallets whose express button is on (the others stay tabs of the form)", () => {
    expect(tabs()).toContain("Apple Pay");
    expect(tabs()).toContain("Google Pay");
    // Default for goods to ship: Apple Pay (and Whop Pay) express, Google Pay "auto" hidden → a tab.
    const shipped = tabs(expressMethodsShown(DEFAULT_EXPRESS_METHODS, { shippable: true }).wallets);
    expect(shipped).not.toContain("Apple Pay");
    expect(shipped).toContain("Google Pay");
    const both = tabs(["apple-pay", "google-pay", "whop-pay"]);
    expect(both).not.toContain("Apple Pay");
    expect(both).not.toContain("Google Pay");
    // Apple Pay switched off up there: still offered in the form.
    const gOnly = tabs(expressMethodsShown({ ...DEFAULT_EXPRESS_METHODS, applePay: false, googlePay: "always" }, { shippable: true }).wallets);
    expect(gOnly).toContain("Apple Pay");
    expect(gOnly).not.toContain("Google Pay");
    for (const out of [shipped, both, gOnly]) expect(out).toContain("PayPal");
  });
});
