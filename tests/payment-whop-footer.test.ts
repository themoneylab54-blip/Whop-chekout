// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";

/*
 * The payment panel's part in clipping « Propulsé par Whop » (Whop's embed mocked): only Whop's card
 * form, in the language the server checked it in; never the PayPal-only checkout nor Whop's billing
 * address form; and Whop's "disabled" state (its pay button's: an incomplete form, a payment going
 * through) never turns the clip off, so the frame never jumps while the buyer types or pays.
 */

type EmbedProps = {
  sessionId: string;
  onStateChange?: (s: string) => void;
  onAddressValidationError?: (e: { error_message: string }) => void;
};

const whop = vi.hoisted(() => ({ last: null as EmbedProps | null }));

vi.mock("@whop/checkout/react", async () => {
  const React = await import("react");
  function WhopCheckoutEmbed(props: EmbedProps & { ref?: React.Ref<unknown> }) {
    React.useImperativeHandle(props.ref, () => ({ submit: async () => undefined, setEmail: async () => undefined, setAddress: async () => undefined }));
    whop.last = props;
    return React.createElement("iframe", { "data-testid": "embed", "data-config": props.sessionId, title: "Whop Embedded Checkout" });
  }
  return { WhopCheckoutEmbed, WhopExpressCheckoutButton: () => null, useCheckoutEmbedControls: () => React.useRef(null) };
});

const { PaymentPanel } = await import("@/components/checkout/Payment");
const { LABELS } = await import("@/components/checkout/i18n");
const theme = { language: "fr", accentColor: "#000", radius: 8, requireTerms: false } as unknown as ComponentProps<typeof PaymentPanel>["theme"];

function panel(o: { whopFooterLang?: string | null; paypalActive?: boolean } = {}) {
  return h(PaymentPanel, {
    prepared: { configId: "cfg_card", environment: "sandbox" },
    preparing: false,
    prepareError: null,
    theme,
    labels: LABELS.fr,
    payLabel: "Payer",
    returnUrl: "https://x.test/merci",
    testMode: false,
    confirm: async () => ({ ok: true as const, buyer: { email: "a@b.co", address: { name: "A B", line1: "1 rue", city: "Paris", state: "", postalCode: "75001", country: "FR" } } }),
    onPaid: () => undefined,
    whopFooterLang: o.whopFooterLang,
    paypal: {
      active: o.paypalActive ?? false,
      prepared: { configId: "cfg_paypal", environment: "sandbox" },
      preparing: false,
      error: null,
      autoSubmit: false,
      onAutoSubmitted: () => undefined,
      onCancel: () => undefined,
      formKey: "k1",
    },
  });
}

const clip = () => screen.getByTestId("wc-whop-clip").getAttribute("data-clip");

beforeEach(() => {
  whop.last = null;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => 340);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PaymentPanel: « Propulsé par Whop » clipped off Whop's card form only", () => {
  it("the card form, in the language the server checked: clipped; no check, or another language: shown", () => {
    const { rerender } = render(panel({ whopFooterLang: "fr" }));
    expect(screen.getByTestId("embed").getAttribute("data-config")).toBe("cfg_card");
    expect(clip()).toBe("86");
    rerender(panel({ whopFooterLang: null }));
    expect(clip()).toBeNull();
    rerender(panel({ whopFooterLang: "en" }));
    expect(clip()).toBeNull();
  });

  it("Whop's \"disabled\" state (an incomplete form, a payment going through): the clip stays", () => {
    render(panel({ whopFooterLang: "fr" }));
    act(() => whop.last?.onStateChange?.("disabled"));
    expect(clip()).toBe("86");
    act(() => whop.last?.onStateChange?.("ready"));
    expect(clip()).toBe("86");
  });

  it("the PayPal-only checkout (another form, never checked): shown", () => {
    render(panel({ whopFooterLang: "fr", paypalActive: true }));
    expect(screen.getByTestId("embed").getAttribute("data-config")).toBe("cfg_paypal");
    expect(clip()).toBeNull();
  });

  it("Whop's billing address form (after an address error): shown", () => {
    render(panel({ whopFooterLang: "fr" }));
    expect(clip()).toBe("86");
    act(() => whop.last?.onAddressValidationError?.({ error_message: "Adresse invalide" }));
    expect(clip()).toBeNull();
  });
});
