// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

/*
 * Stripe review fixes on the pages: the switch notice shown when the switch of processor happens at
 * a prepare (switchedFrom in its answer, not only at the Pay click), and the thank-you page of a
 * FAILED payment (a message and a link back to the checkout, never "processing"). The payment panel
 * is stubbed; Whop's embed is never loaded.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", () => ({
  WhopCheckoutEmbed: () => null,
  WhopExpressCheckoutButton: () => null,
  useCheckoutEmbedControls: () => ({ current: null }),
}));
vi.mock("@/components/checkout/Payment", async (orig) => ({ ...(await orig<typeof import("@/components/checkout/Payment")>()), PaymentPanel: () => null }));

const { CheckoutView } = await import("@/components/checkout/CheckoutView");
const { ThankYouView } = await import("@/components/checkout/ThankYouView");
const { defaultCheckoutLayout, defaultThankYouLayout, defaultTheme } = await import("@/lib/layout");
const { SAMPLE_LINES } = await import("@/lib/sample");
const { LABELS } = await import("@/components/checkout/i18n");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("switch notice at prepare", () => {
  it("a prepare answering with switchedFrom shows the notice above the form", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        String(url).endsWith("/prepare")
          ? Promise.resolve(new Response(JSON.stringify({ provider: "whop", checkoutConfigurationId: "ch_sw", environment: "sandbox", switchedFrom: "stripe", totals: { totalCents: 3000 }, paypal: false }), { status: 200 }))
          : new Promise(() => undefined),
      ),
    );
    const props: ComponentProps<typeof CheckoutView> = {
      theme: { ...defaultTheme("Boutique"), language: "fr" },
      layout: defaultCheckoutLayout(),
      currency: "EUR",
      lines: SAMPLE_LINES,
      rates: [],
      addOns: [],
      hasDiscounts: false,
      mode: { kind: "live", sessionId: "s_sw", testMode: true },
      initialCountry: "FR",
    };
    render(h(CheckoutView, props));
    expect(screen.queryByTestId("wc-provider-switched")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("wc-provider-switched").textContent).toBe(LABELS.fr.providerSwitched), { timeout: 3000 });
  });
});

describe("thank-you page of a failed payment", () => {
  const data: ComponentProps<typeof ThankYouView>["data"] = {
    status: "FAILED",
    orderName: null,
    email: "a@b.co",
    firstName: "Alex",
    address: null,
    lines: SAMPLE_LINES,
    currency: "EUR",
    subtotalCents: 3000,
    discountCents: 0,
    shippingCents: 0,
    addOnsCents: 0,
    totalCents: 3000,
    continueUrl: null,
    checkoutUrl: "/c/s_fail?via=app",
  };

  it("says the payment failed, links back to the checkout, never 'processing' (every language)", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    for (const lang of ["fr", "en", "de", "es", "it", "nl"] as const) {
      const L = LABELS[lang];
      expect(L.orderPaymentFailed, lang).toBeTruthy();
      expect(L.backToCheckout, lang).toBeTruthy();
      render(h(ThankYouView, { theme: { ...defaultTheme("Boutique"), language: lang }, layout: defaultThankYouLayout(), data }));
      const box = screen.getByTestId("wc-payment-failed");
      expect(box.textContent).toContain(L.orderPaymentFailed);
      const link = screen.getByRole("link", { name: L.backToCheckout });
      expect(link.getAttribute("href")).toBe("/c/s_fail?via=app");
      expect(screen.queryByText(L.orderProcessing)).toBeNull();
      cleanup();
    }
  });

  it("a paid order still shows its confirmation", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(h(ThankYouView, { theme: { ...defaultTheme("Boutique"), language: "fr" }, layout: defaultThankYouLayout(), data: { ...data, status: "PAID" } }));
    expect(screen.queryByTestId("wc-payment-failed")).toBeNull();
    expect(screen.getByText(LABELS.fr.orderConfirmed)).toBeTruthy();
  });
});
