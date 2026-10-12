import type { WhopCheckoutEmbedProps } from "@whop/checkout/react";

/*
 * Whop's card form, opened two ways: by the page's React embed (WhopCheckoutEmbed, Payment.tsx), and
 * by Whop's own vanilla script (WHOP_SDK_PATH), which mounts any element given data-whop-checkout-*
 * attributes — so the form can start before the page hydrates. The two must open the very same frame
 * (one URL: the same checkout, the same form), so both come from one set of options: the embed's
 * props, and the element's attributes in a fixed order (written by the server, compared by the page
 * as one string). Nothing of React's at runtime (its types only): for the server and the browser
 * alike. The two frames compared, option by option: tests/whop-embed.test.ts.
 */

/**
 * Whop's vanilla script: @whop/checkout's own build (dist/static/checkout/index.js) copied as is into
 * public/vendor, its name carrying the version (served as immutable). Checked against the installed
 * package by tests/whop-vendored.test.ts.
 */
export const WHOP_SDK_PATH = "/vendor/whop-checkout-0.7.0.js";

/** What the checkout opens Whop's card form with. */
export type WhopEmbedOptions = {
  /** The Whop checkout configuration (Prepared.configId). */
  configId: string;
  environment: "sandbox" | "production";
  /** The checkout's language (theme.language). */
  locale: string;
  /** The theme's accent color (theme.accentColor). */
  accentColor: string;
  /** The theme's corner radius, px (theme.radius). */
  borderRadius: number;
  /** Whop's own pay button shown (the embed's hideSubmitButton, reversed). */
  submitButton: boolean;
  /** Whop's billing address form shown (the embed's hideAddressForm, reversed). */
  addressForm: boolean;
  /** Whop's terms line left out (the embed's hideTermsAndConditions): the store's own terms checkbox covers it. */
  hideTerms: boolean;
  /** The card kept for a post-purchase offer (the embed's setupFutureUsage "off_session"). */
  saveCard: boolean;
  /** Where the buyer comes back after a payment authorized on another site (the thank-you page). */
  returnUrl: string;
};

/** The vanilla script's attributes, all named `data-whop-checkout-…`. */
const ATTR = "data-whop-checkout-";

/** The React embed's props for these options, all but its callbacks, ref and fallback. Pure. */
export function whopEmbedProps(o: WhopEmbedOptions) {
  return {
    sessionId: o.configId,
    environment: o.environment,
    theme: "light",
    locale: o.locale,
    themeOptions: { accentColor: o.accentColor, borderRadius: o.borderRadius },
    hideSubmitButton: !o.submitButton,
    hideEmail: true,
    hideAddressForm: !o.addressForm,
    hideTermsAndConditions: o.hideTerms,
    setupFutureUsage: o.saveCard ? "off_session" : undefined,
    skipRedirect: true,
    returnUrl: o.returnUrl,
  } satisfies WhopCheckoutEmbedProps;
}

/**
 * The vanilla script's attributes for these options, but the checkout's own (session, environment,
 * return URL: whopEmbedAttributes), in a fixed order. An empty value is no attribute to Whop's script
 * (it tests each one for truth), so none is written; the border radius is written whenever Whop's URL
 * builder keeps React's number (0 too, not NaN). The page's own utm_* parameters never reach the frame
 * (skip-utm: the React embed is given none). Pure.
 */
export function whopEmbedFixedAttributes(o: Omit<WhopEmbedOptions, "configId" | "environment" | "returnUrl">): [string, string][] {
  const values: [string, string][] = [
    ["theme", "light"],
    ["locale", o.locale],
    ["theme-accent-color", o.accentColor],
    ["theme-border-radius", o.borderRadius || o.borderRadius === 0 ? String(o.borderRadius) : ""],
    ["hide-submit-button", o.submitButton ? "" : "true"],
    ["hide-email", "true"],
    ["hide-address", o.addressForm ? "" : "true"],
    ["hide-tos", o.hideTerms ? "true" : ""],
    ["setup-future-usage", o.saveCard ? "off_session" : ""],
    ["skip-redirect", "true"],
    ["skip-utm", "true"],
  ];
  return values.filter(([, value]) => value !== "").map(([name, value]) => [ATTR + name, value]);
}

/**
 * All the vanilla script's attributes for these options: the fixed ones, then the checkout's session,
 * environment and return URL, in this order and never left out (an inline script appends them the
 * same way, once it knows them). Pure.
 */
export function whopEmbedAttributes(o: WhopEmbedOptions): [string, string][] {
  return [...whopEmbedFixedAttributes(o), [`${ATTR}session`, o.configId], [`${ATTR}environment`, o.environment], [`${ATTR}return-url`, o.returnUrl]];
}

/** whopEmbedAttributes as one string: one per form, compared as is. Pure. */
export function whopEmbedKey(o: WhopEmbedOptions): string {
  return JSON.stringify(whopEmbedAttributes(o));
}
