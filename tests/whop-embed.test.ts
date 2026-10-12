// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { cleanup, render } from "@testing-library/react";
import { whopEmbedAttributes, whopEmbedFixedAttributes, whopEmbedKey, whopEmbedProps, type WhopEmbedOptions } from "@/components/checkout/whopEmbed";

/*
 * Whop's card form opened by the page's React embed and by Whop's own vanilla script (which the page
 * can start before it hydrates), from one set of options (whopEmbed): the very same frame — one URL
 * (the same checkout, the same form), the same sandbox, permissions and style — for the card form as
 * the checkout opens it and with each option changed. The page's own utm_* parameters never reach the
 * vanilla frame (the React embed is given none), and Whop's script never loads Whop's tracker (the
 * page says it has one: window.whop). The props are the ones Payment.tsx gives the embed; the
 * attributes come in a fixed order, empty ones left out, the checkout's own (session, environment,
 * return URL) last and always.
 */

// The real embed, the props Payment.tsx gives it recorded.
const embed = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
vi.mock("@whop/checkout/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@whop/checkout/react")>();
  const React = await import("react");
  const WhopCheckoutEmbed = React.forwardRef<unknown, Record<string, unknown>>(function RecordedEmbed(props, ref) {
    embed.props.push(props);
    return React.createElement(actual.WhopCheckoutEmbed as never, { ...props, ref });
  });
  return { ...actual, WhopCheckoutEmbed };
});

const { WhopCheckoutEmbed } = await vi.importActual<typeof import("@whop/checkout/react")>("@whop/checkout/react");
const { PaymentPanel } = await import("@/components/checkout/Payment");
const { LABELS } = await import("@/components/checkout/i18n");

type Win = Window & Record<string, unknown> & { wco?: { listening: boolean; frames: Map<unknown, unknown> } };
const win = () => window as unknown as Win;
const noop = () => undefined;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The card form as the checkout opens it: Whop's own pay button, address form and email hidden, its terms line shown. */
const CARD: WhopEmbedOptions = {
  configId: "ch_2kQ8wTf3nVx7Lp",
  environment: "production",
  locale: "fr",
  accentColor: "#123456",
  borderRadius: 8,
  submitButton: false,
  addressForm: false,
  hideTerms: false,
  saveCard: false,
  returnUrl: "https://checkout.example.com/c/cmsess1/merci",
};

/** Each case: its options, and what it puts (or not: null) in Whop's URL. */
const CASES: [string, WhopEmbedOptions, Record<string, string | null>][] = [
  [
    "the card form as the checkout opens it",
    CARD,
    { theme: "light", locale: "fr", "theme.accentColor": "#123456", "theme.borderRadius": "8", hide_submit_button: "true", "email.hidden": "1", "address.hidden": "1", hide_tos: null, setup_future_usage: null },
  ],
  ["square corners (a radius of 0 is still sent)", { ...CARD, borderRadius: 0 }, { "theme.borderRadius": "0" }],
  ["the card kept for an offer, Whop's terms line left out", { ...CARD, saveCard: true, hideTerms: true }, { setup_future_usage: "off_session", hide_tos: "true" }],
  ["Whop's sandbox, in German", { ...CARD, environment: "sandbox", locale: "de" }, { locale: "de" }],
  ["Whop's own pay button", { ...CARD, submitButton: true }, { hide_submit_button: null }],
  ["Whop's billing address form", { ...CARD, addressForm: true }, { "address.hidden": null }],
  ["no accent color", { ...CARD, accentColor: "" }, { "theme.accentColor": null }],
  [
    "every option the other way",
    { configId: "ch_9Zr4mB", environment: "sandbox", locale: "en", accentColor: "red", borderRadius: 24, submitButton: true, addressForm: true, hideTerms: true, saveCard: true, returnUrl: "https://shop.example.org/merci?order=12&lang=en#top" },
    { locale: "en", "theme.accentColor": "red", "theme.borderRadius": "24", hide_submit_button: null, "address.hidden": null, hide_tos: "true", setup_future_usage: "off_session" },
  ],
];

/** The frame the React embed opens, with callbacks as Payment.tsx gives them. */
function reactFrame(o: WhopEmbedOptions): HTMLIFrameElement {
  const { container } = render(h(WhopCheckoutEmbed, { ...whopEmbedProps(o), onStateChange: noop, onComplete: noop, onPaymentError: noop, onAddressValidationError: noop }));
  const frame = container.querySelector("iframe");
  if (!frame) throw new Error("the React embed opened no frame");
  return frame;
}

/** The callbacks Whop's script calls: globals, named by the element. */
const CALLBACKS: Record<string, string> = {
  "data-whop-checkout-on-state-change": "__wcTestState",
  "data-whop-checkout-on-complete": "__wcTestComplete",
  "data-whop-checkout-on-payment-error": "__wcTestPaymentError",
  "data-whop-checkout-on-address-validation-error": "__wcTestAddressError",
};
let slots = 0;

/** The frame Whop's script opens on an element given these attributes (plus the callbacks and an id), once it sees it added. */
async function vanillaFrame(attributes: [string, string][]): Promise<HTMLIFrameElement> {
  const slot = document.createElement("div");
  slot.id = `wc-whop-early-${++slots}`;
  for (const [name, value] of [...attributes, ...Object.entries(CALLBACKS)]) slot.setAttribute(name, value);
  document.body.append(slot);
  await tick();
  const frame = slot.querySelector("iframe");
  if (!frame) throw new Error("Whop's script opened no frame");
  return frame;
}

/** A style attribute's declarations, in any order. */
const declarations = (el: Element) =>
  (el.getAttribute("style") ?? "")
    .split(";")
    .map((d) => d.trim())
    .filter(Boolean)
    .sort();
/** The frame's attributes but the four compared. */
const otherAttributes = (el: Element) => Object.fromEntries([...el.attributes].filter((a) => !["src", "sandbox", "allow", "style"].includes(a.name)).map((a) => [a.name, a.value]));
const tracker = () => document.querySelector('script[src*="t.whop.tw"]');

const firstUrl = location.href;
const polyfilled: string[] = [];
beforeAll(() => {
  // What jsdom lacks of a browser's frame: its sandbox token list and its `allow` reflected as an attribute.
  const frame = HTMLIFrameElement.prototype;
  if (!("sandbox" in frame)) {
    polyfilled.push("sandbox");
    Object.defineProperty(frame, "sandbox", {
      configurable: true,
      get(this: HTMLIFrameElement) {
        const tokens = () => (this.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean);
        return { add: (...added: string[]) => this.setAttribute("sandbox", [...new Set([...tokens(), ...added])].join(" ")) };
      },
    });
  }
  if (!("allow" in frame)) {
    polyfilled.push("allow");
    Object.defineProperty(frame, "allow", {
      configurable: true,
      get(this: HTMLIFrameElement) {
        return this.getAttribute("allow") ?? "";
      },
      set(this: HTMLIFrameElement, value: string) {
        this.setAttribute("allow", value);
      },
    });
  }
  // Whop's script loads Whop's tracker (t.whop.tw) unless the page has one: never here (nor in the React build).
  win().whop = {};
  for (const name of Object.values(CALLBACKS)) win()[name] = noop;
  // The page's own utm_* parameters (an ad's link).
  history.replaceState(null, "", "/c/cmsess1?utm_source=newsletter&utm_medium=email");
  // The stub Whop's loader leaves, then Whop's script, the installed one (the vendored copy is the same: tests/whop-vendored).
  win().wco = { injected: true, listening: false, frames: new Map(), identifiedFrames: new Map(), availableCurrencies: new Map() } as Win["wco"];
  new Function(readFileSync(join(process.cwd(), "node_modules/@whop/checkout/dist/static/checkout/index.js"), "utf8"))();
  expect(win().wco?.listening).toBe(true);
});
afterEach(async () => {
  cleanup();
  for (const slot of document.querySelectorAll('[id^="wc-whop-early-"]')) slot.remove();
  embed.props.length = 0;
  // Whop's script sees its elements go (and forgets their frames) while the page is still there.
  await tick();
  expect(win().wco?.frames.size).toBe(0);
});
afterAll(() => {
  history.replaceState(null, "", firstUrl);
  for (const name of ["whop", "wco", ...Object.values(CALLBACKS)]) delete win()[name];
  for (const name of polyfilled) delete (HTMLIFrameElement.prototype as unknown as Record<string, unknown>)[name];
});

describe("the React embed and Whop's script: one frame", () => {
  it.each(CASES)("%s", async (_, o, inUrl) => {
    const react = reactFrame(o);
    const vanilla = await vanillaFrame(whopEmbedAttributes(o));
    const src = react.getAttribute("src") ?? "";
    expect(vanilla.getAttribute("src")).toBe(src);
    expect(vanilla.getAttribute("sandbox")).toBe(react.getAttribute("sandbox"));
    expect(vanilla.getAttribute("allow")).toBe(react.getAttribute("allow"));
    // The same declarations, each build setting them in its own order (React's style object, the script's assignments).
    expect(declarations(vanilla)).toEqual(declarations(react));
    // Apart from those, one attribute each: React's title, the script's identifier (the element's id, for window.wco).
    expect(otherAttributes(react)).toEqual({ title: "Whop Embedded Checkout" });
    expect(otherAttributes(vanilla)).toEqual({ "data-whop-checkout-identifier": vanilla.parentElement?.id });
    expect(tracker()).toBeNull();

    // That frame: Whop's form for this checkout, as asked.
    const url = new URL(src);
    expect(url.origin + url.pathname).toBe(`https://${o.environment === "sandbox" ? "sandbox." : ""}whop.com/embedded/checkout/${o.configId}/`);
    expect(url.searchParams.get("session")).toBe(o.configId);
    expect(url.searchParams.get("payment_redirect_url")).toBe(o.returnUrl);
    expect(url.searchParams.get("skip_redirect")).toBe("true");
    expect(url.searchParams.get("email.hidden")).toBe("1");
    for (const [name, value] of Object.entries(inUrl)) expect(url.searchParams.get(name), name).toBe(value);
    expect([...url.searchParams.keys()].filter((k) => k.startsWith("utm_"))).toEqual([]);
    expect(react.getAttribute("sandbox")).toContain("allow-scripts");
    expect(react.getAttribute("allow")).toContain("payment");
    expect(declarations(react)).toContain("height: 480px");
  });

  it("the page's own utm_* parameters: never in either frame (without skip-utm, Whop's script would add them)", async () => {
    expect(location.search).toContain("utm_source=newsletter");
    const react = reactFrame(CARD);
    const vanilla = await vanillaFrame(whopEmbedAttributes(CARD));
    expect(vanilla.getAttribute("src")).toBe(react.getAttribute("src"));
    expect(react.getAttribute("src")).not.toContain("utm_");
    const withUtm = await vanillaFrame(whopEmbedAttributes(CARD).filter(([name]) => name !== "data-whop-checkout-skip-utm"));
    expect(new URL(withUtm.getAttribute("src") ?? "").searchParams.get("utm_source")).toBe("newsletter");
    expect(tracker()).toBeNull();
  });
});

describe("whopEmbedProps: what Payment.tsx gives the embed", () => {
  const theme = (requireTerms: boolean) => ({ language: "fr", accentColor: "#123456", radius: 8, requireTerms }) as unknown as ComponentProps<typeof PaymentPanel>["theme"];
  const panel = (o: { saveCard?: boolean; requireTerms?: boolean } = {}) =>
    h(PaymentPanel, {
      prepared: { configId: CARD.configId, environment: "production" },
      preparing: false,
      prepareError: null,
      theme: theme(o.requireTerms ?? false),
      labels: LABELS.fr,
      payLabel: "Payer",
      returnUrl: CARD.returnUrl,
      testMode: false,
      confirm: async () => ({ ok: true as const, buyer: { email: "a@b.co", address: { name: "A B", line1: "1 rue", city: "Paris", state: "", postalCode: "75001", country: "FR" } } }),
      onPaid: noop,
      saveCard: o.saveCard,
    });
  /** The props of the panel's embed but its callbacks and fallback. */
  const passed = () => {
    const props = embed.props.at(-1) ?? {};
    expect(Object.keys(props).filter((k) => typeof props[k] === "function").sort()).toEqual(["onAddressValidationError", "onComplete", "onPaymentError", "onStateChange"]);
    return Object.fromEntries(Object.entries(props).filter(([k, v]) => typeof v !== "function" && k !== "fallback"));
  };

  it("the card form's, prop by prop", () => {
    expect(whopEmbedProps(CARD)).toStrictEqual({
      sessionId: "ch_2kQ8wTf3nVx7Lp",
      environment: "production",
      theme: "light",
      locale: "fr",
      themeOptions: { accentColor: "#123456", borderRadius: 8 },
      hideSubmitButton: true,
      hideEmail: true,
      hideAddressForm: true,
      hideTermsAndConditions: false,
      setupFutureUsage: undefined,
      skipRedirect: true,
      returnUrl: "https://checkout.example.com/c/cmsess1/merci",
    });
    render(panel());
    expect(passed()).toStrictEqual(whopEmbedProps(CARD));
  });

  it("the card kept for an offer, the store's own terms checkbox: Payment.tsx's props are those options'", () => {
    render(panel({ saveCard: true, requireTerms: true }));
    expect(passed()).toStrictEqual(whopEmbedProps({ ...CARD, saveCard: true, hideTerms: true }));
  });
});

describe("whopEmbedAttributes: the element Whop's script mounts", () => {
  it("in a fixed order, empty ones left out, the checkout's own last and always", () => {
    expect(whopEmbedAttributes(CARD)).toEqual([
      ["data-whop-checkout-theme", "light"],
      ["data-whop-checkout-locale", "fr"],
      ["data-whop-checkout-theme-accent-color", "#123456"],
      ["data-whop-checkout-theme-border-radius", "8"],
      ["data-whop-checkout-hide-submit-button", "true"],
      ["data-whop-checkout-hide-email", "true"],
      ["data-whop-checkout-hide-address", "true"],
      ["data-whop-checkout-skip-redirect", "true"],
      ["data-whop-checkout-skip-utm", "true"],
      ["data-whop-checkout-session", "ch_2kQ8wTf3nVx7Lp"],
      ["data-whop-checkout-environment", "production"],
      ["data-whop-checkout-return-url", "https://checkout.example.com/c/cmsess1/merci"],
    ]);
    expect(whopEmbedFixedAttributes({ ...CARD, accentColor: "", borderRadius: 0, submitButton: true, addressForm: true, hideTerms: true, saveCard: true })).toEqual([
      ["data-whop-checkout-theme", "light"],
      ["data-whop-checkout-locale", "fr"],
      ["data-whop-checkout-theme-border-radius", "0"],
      ["data-whop-checkout-hide-email", "true"],
      ["data-whop-checkout-hide-tos", "true"],
      ["data-whop-checkout-setup-future-usage", "off_session"],
      ["data-whop-checkout-skip-redirect", "true"],
      ["data-whop-checkout-skip-utm", "true"],
    ]);
    // A radius Whop's URL builder drops (not a number): none either.
    expect(whopEmbedFixedAttributes({ ...CARD, borderRadius: NaN }).map(([name]) => name)).not.toContain("data-whop-checkout-theme-border-radius");
    // The checkout's own after the fixed ones, even empty.
    const o = { ...CARD, returnUrl: "" };
    expect(whopEmbedAttributes(o)).toEqual([
      ...whopEmbedFixedAttributes(o),
      ["data-whop-checkout-session", "ch_2kQ8wTf3nVx7Lp"],
      ["data-whop-checkout-environment", "production"],
      ["data-whop-checkout-return-url", ""],
    ]);
  });

  it("whopEmbedKey: one string per form", () => {
    expect(whopEmbedKey(CARD)).toBe(JSON.stringify(whopEmbedAttributes(CARD)));
    expect(whopEmbedKey({ ...CARD })).toBe(whopEmbedKey(CARD));
    const keys = CASES.map(([, o]) => whopEmbedKey(o));
    expect(new Set(keys).size).toBe(keys.length);
  });
});
