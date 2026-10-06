// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

/*
 * Button colors: the Pay button apart from the other buttons (payButtonColor / buttonColor, text
 * colors, secondary style). Empty = the accent, so stores saved before look exactly the same.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", () => ({
  WhopCheckoutEmbed: () => null,
  WhopExpressCheckoutButton: () => null,
  useCheckoutEmbedControls: () => ({ current: null }),
}));

const { themeSchema, loadTheme, defaultTheme, createBlock, defaultCheckoutLayout } = await import("@/lib/layout");
const { buttonVars, payButtonColors, otherButtonColors, suggestTextColor, buttonContrast } = await import("@/lib/button-colors");
const { contrastFailures, themeContrastChecks } = await import("@/lib/contrast");
const { CheckoutView, themeVars } = await import("@/components/checkout/CheckoutView");
const { ContentBlock } = await import("@/components/checkout/blocks");
const { PaymentPreview } = await import("@/components/checkout/Payment");
const { labelsFor } = await import("@/components/checkout/i18n");
const { SAMPLE_LINES } = await import("@/lib/sample");
const { ButtonColorControls } = await import("@/components/builder/ButtonColors");
const { describeThemeDiff, diffTheme } = await import("@/components/builder/changes");

type Theme = import("@/lib/layout").Theme;

afterEach(() => cleanup());

const theme = (o: Partial<Theme> = {}): Theme => ({ ...defaultTheme("Boutique"), ...o });

describe("schema", () => {
  it("defaults: every button color empty (= accent), secondary buttons outlined", () => {
    const t = themeSchema.parse({});
    expect(t.payButtonColor).toBe("");
    expect(t.payButtonColor2).toBe("");
    expect(t.payButtonTextColor).toBe("");
    expect(t.buttonColor).toBe("");
    expect(t.buttonTextColor).toBe("");
    expect(t.secondaryButtonStyle).toBe("outline");
  });

  it("a theme saved before the keys existed loads with the defaults; a bad value is dropped, not fatal", () => {
    const old = { accentColor: "#e11d48", accentColor2: "#f59e0b", buttonShape: "pill" };
    const t = loadTheme(old, "Shop");
    expect(t.accentColor).toBe("#e11d48");
    expect(t.payButtonColor).toBe("");
    expect(t.secondaryButtonStyle).toBe("outline");
    const bad = loadTheme({ ...old, payButtonColor: "red", secondaryButtonStyle: "neon", buttonColor: "#00aa00" }, "Shop");
    expect(bad.payButtonColor).toBe("");
    expect(bad.secondaryButtonStyle).toBe("outline");
    expect(bad.buttonColor).toBe("#00aa00");
    expect(bad.accentColor).toBe("#e11d48");
  });
});

describe("buttonVars", () => {
  it("empty: pay and other buttons are exactly the accent values of before", () => {
    for (const t of [theme({ accentColor: "#e11d48" }), theme({ accentColor: "#fde047", accentColor2: "#f97316" }), theme({ buttonShadow: false })]) {
      const v = themeVars(t) as Record<string, string>;
      expect(v["--pay-bg"]).toBe(v["--accent-bg"]);
      expect(v["--btn-bg"]).toBe(v["--accent-bg"]);
      expect(v["--pay-fg"]).toBe(v["--accent-fg"]);
      expect(v["--btn-fg"]).toBe(v["--accent-fg"]);
      expect(v["--btn-color"]).toBe(t.accentColor);
      expect(v["--pay-shadow"]).toBe(v["--btn-shadow"]);
      expect(v["--btn-shadow"]).toBe(t.buttonShadow ? `0 10px 24px -10px ${t.accentColor}b3, inset 0 1px 0 rgba(255,255,255,.18)` : "none");
    }
  });

  it("own colors: the Pay button and the other buttons differ; text auto black/white unless set", () => {
    const t = theme({ accentColor: "#111827", payButtonColor: "#16a34a", payButtonColor2: "#15803d", buttonColor: "#fde047" });
    const v = buttonVars(t);
    expect(v["--pay-bg"]).toBe("linear-gradient(135deg, #16a34a, #15803d)");
    expect(v["--btn-bg"]).toBe("linear-gradient(#fde047, #fde047)");
    expect(v["--btn-fg"]).toBe("#111111");
    expect(v["--pay-shadow"]).toContain("#16a34ab3");
    expect(buttonVars({ ...t, payButtonTextColor: "#fefce8" })["--pay-fg"]).toBe("#fefce8");
    // The accent's gradient does not leak onto an own color.
    expect(otherButtonColors(theme({ accentColor2: "#f97316", buttonColor: "#2563eb" })).bg2).toBe("");
    // A gradient end alone (no pay color) is ignored: the pay button follows the accent.
    expect(payButtonColors(theme({ payButtonColor2: "#ff0000" })).bg2).toBe("");
  });

  it("secondary buttons: outline as before, or solid in the button color", () => {
    expect(buttonVars(theme())["--btn2-border"]).toBe("#d4d4d4");
    expect(buttonVars(theme())["--btn2-fg"]).toBe("#171717");
    const solid = buttonVars(theme({ secondaryButtonStyle: "solid", buttonColor: "#2563eb" }));
    expect(solid["--btn2-bg"]).toBe("linear-gradient(#2563eb, #2563eb)");
    expect(solid["--btn2-fg"]).toBe("#ffffff");
  });

  it("contrast: suggestion and checks only for set colors", () => {
    expect(suggestTextColor("#fde047")).toBe("#111111");
    expect(suggestTextColor("#1e3a8a", "#2563eb")).toBe("#ffffff");
    expect(buttonContrast("#ffffff", "", "#ffffff")).toBe(1);
    const base = themeContrastChecks(theme()).length;
    expect(themeContrastChecks(theme({ payButtonColor: "#16a34a", buttonColor: "#fde047" })).length).toBe(base + 2);
    expect(contrastFailures(theme({ payButtonColor: "#fde047", payButtonTextColor: "#ffffff" })).some((c) => c.what === "pay button text")).toBe(true);
  });
});

describe("rendered markup: pay vs other buttons", () => {
  const L = labelsFor("fr");
  const ctx = { labels: L, lang: "fr", lowestInventory: null, preview: false, subtotalCents: 0, freeShippingThresholdCents: null, money: (c: number) => String(c), note: "", setNote: () => {}, cartProducts: null } as never;

  it("the Pay button (preview) paints with --pay-*", () => {
    const html = renderToStaticMarkup(h(PaymentPreview, { labels: L, payLabel: "Payer · 30 €" }));
    expect(html).toContain("var(--pay-bg,var(--accent-bg))");
    expect(html).toContain("var(--pay-fg,var(--accent-fg))");
    expect(html).not.toContain("--btn-bg");
  });

  it("a button link paints with --btn-* (solid) or --btn-color (outline), never --pay-*", () => {
    const solid = createBlock("button_link", { props: { label: "Voir", url: "https://ex.com", variant: "solid" } as never });
    const outline = createBlock("button_link", { props: { label: "Voir", url: "https://ex.com", variant: "outline" } as never });
    const a = renderToStaticMarkup(h(ContentBlock, { block: solid, ctx }));
    const b = renderToStaticMarkup(h(ContentBlock, { block: outline, ctx }));
    expect(a).toContain("var(--btn-bg,var(--accent-bg))");
    expect(b).toContain("var(--btn-color,var(--accent))");
    expect(a + b).not.toContain("--pay-");
  });

  it("the checkout page: vars on the root; Pay with --pay-*, « Appliquer » with --btn2-*", () => {
    const props: ComponentProps<typeof CheckoutView> = {
      theme: theme({ payButtonColor: "#16a34a", buttonColor: "#2563eb", secondaryButtonStyle: "solid" }),
      layout: defaultCheckoutLayout(),
      currency: "EUR",
      lines: SAMPLE_LINES,
      rates: [],
      addOns: [],
      hasDiscounts: true,
      mode: { kind: "preview" },
      initialCountry: "FR",
    };
    const { container } = render(h(CheckoutView, props));
    const root = container.querySelector(".wc-checkout") as HTMLElement;
    expect(root.style.getPropertyValue("--pay-bg")).toBe("linear-gradient(#16a34a, #16a34a)");
    expect(root.style.getPropertyValue("--btn-bg")).toBe("linear-gradient(#2563eb, #2563eb)");
    expect(root.style.getPropertyValue("--btn2-bg")).toBe("linear-gradient(#2563eb, #2563eb)");
    const pay = [...container.querySelectorAll("div")].find((d) => d.className.includes("--pay-bg") && d.textContent?.includes(L.payNow));
    expect(pay).toBeTruthy();
    const apply = screen.getAllByRole("button", { name: L.apply });
    expect(apply.length).toBeGreaterThan(0);
    for (const b of apply) expect(b.className).toContain("var(--btn2-bg");
  });
});

describe("builder controls", () => {
  function setup(o: Partial<Theme> = {}) {
    const setT = vi.fn();
    const view = render(h(ButtonColorControls, { theme: theme(o), setT, page: "checkout" }));
    return { setT, view };
  }

  it("pickers for Pay and other buttons; reset only once a color is set", () => {
    const { view, setT } = setup();
    expect(screen.getByRole("group", { name: "Couleur du bouton Payer" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Couleur des autres boutons" })).toBeTruthy();
    expect(screen.queryByText("Identique à la couleur principale")).toBeNull();
    // No gradient field until a pay color is set.
    expect(screen.queryByRole("group", { name: /dégradé/ })).toBeNull();
    view.rerender(h(ButtonColorControls, { theme: theme({ payButtonColor: "#16a34a" }), setT, page: "checkout" }));
    expect(screen.getByRole("group", { name: /dégradé/ })).toBeTruthy();
    fireEvent.click(screen.getByText("Identique à la couleur principale"));
    expect(setT).toHaveBeenCalledWith("payButtonColor", "");
  });

  it("typing a color sets it; the preview follows live", () => {
    const { setT, view } = setup();
    const field = screen.getByRole("group", { name: "Couleur des autres boutons" }).querySelector("input:not([type=color])") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "#2563eb" } });
    expect(setT).toHaveBeenCalledWith("buttonColor", "#2563eb");
    view.rerender(h(ButtonColorControls, { theme: theme({ buttonColor: "#2563eb" }), setT, page: "checkout" }));
    const preview = view.container.querySelector("[data-preview=Ajouter]") as HTMLElement;
    expect(preview.style.backgroundImage).toContain("37, 99, 235");
  });

  it("low contrast: a non-blocking hint that applies black or white text", () => {
    const { setT } = setup({ payButtonColor: "#fde047", payButtonTextColor: "#ffffff" });
    const hint = document.querySelector("[data-contrast-hint=payButtonTextColor]") as HTMLElement;
    expect(hint.textContent).toContain("noir");
    fireEvent.click(screen.getByRole("button", { name: "Utiliser" }));
    expect(setT).toHaveBeenCalledWith("payButtonTextColor", "#111111");
    expect(document.querySelector("[data-contrast-hint=buttonTextColor]")).toBeNull();
  });

  it("no hint for colors the merchant never chose (an accent whose automatic text reads poorly)", () => {
    // #22c55e: the accent rule gives white text (2.3:1); untouched, the merchant gets no advice.
    setup({ accentColor: "#22c55e" });
    expect(document.querySelector("[data-contrast-hint]")).toBeNull();
  });

  it("own color, automatic text: the more readable of black / white; the accent path is unchanged", () => {
    expect(payButtonColors(theme({ payButtonColor: "#22c55e" })).fg).toBe("#111111");
    expect(otherButtonColors(theme({ buttonColor: "#22c55e" })).fg).toBe("#111111");
    // Without own colors, exactly the accent's text as before (themeVars --accent-fg).
    const accent = theme({ accentColor: "#22c55e", accentColor2: "" });
    expect(payButtonColors(accent).fg).toBe((themeVars(accent) as Record<string, string>)["--accent-fg"]);
    expect(otherButtonColors(accent).fg).toBe((themeVars(accent) as Record<string, string>)["--accent-fg"]);
    setup({ buttonColor: "#22c55e" });
    expect(document.querySelector("[data-contrast-hint]")).toBeNull();
  });

  it("secondary style toggle; thank-you page shows no Pay controls", () => {
    const { setT, view } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Plein" }));
    expect(setT).toHaveBeenCalledWith("secondaryButtonStyle", "solid");
    view.rerender(h(ButtonColorControls, { theme: theme(), setT, page: "thank-you" }));
    expect(screen.queryByRole("group", { name: "Couleur du bouton Payer" })).toBeNull();
    expect(screen.getByRole("group", { name: "Couleur des autres boutons" })).toBeTruthy();
  });

  it("publish summary names the new settings", () => {
    const a = theme();
    const b = theme({ payButtonColor: "#16a34a" });
    expect(describeThemeDiff(diffTheme(b, a))).toContain("couleur du bouton Payer");
  });
});
