// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/*
 * The Stripe payment panel, rendered (jsdom) with Stripe.js and its React components mocked: the
 * Payment Element's readiness, Pay = our confirm() first then stripe.confirmPayment (redirect only
 * if required, billing details from our form, the thank-you return URL), Stripe's error shown, a
 * payment in flight waiting instead of confirming, and the lock reported to the express row.
 */

const stripeMock = vi.hoisted(() => ({
  confirmPayment: vi.fn(),
  submit: vi.fn(),
  fetchUpdates: vi.fn(),
  paymentElementProps: null as Record<string, unknown> | null,
  elementsOptions: null as Record<string, unknown> | null,
  expressProps: null as Record<string, unknown> | null,
  order: [] as string[],
}));

// The pure entry point only (Stripe.js is never injected on import); the plain entry must never load.
const loadStripe = vi.hoisted(() => vi.fn(async (): Promise<object | null> => ({})));
vi.mock("@stripe/stripe-js/pure", () => ({ loadStripe }));
vi.mock("@stripe/stripe-js", () => {
  throw new Error("@stripe/stripe-js must not be imported at runtime (it injects Stripe.js on import)");
});
vi.mock("@stripe/react-stripe-js", async () => {
  const React = await import("react");
  const stripe = {
    confirmPayment: (...args: unknown[]) => {
      stripeMock.order.push("confirmPayment");
      return stripeMock.confirmPayment(...args);
    },
  };
  const elements = { submit: () => stripeMock.submit(), fetchUpdates: () => stripeMock.fetchUpdates() };
  return {
    Elements: ({ children, options }: { children: React.ReactNode; options: Record<string, unknown> }) => {
      stripeMock.elementsOptions = options;
      return React.createElement(React.Fragment, null, children);
    },
    PaymentElement: (props: { onReady?: () => void }) => {
      stripeMock.paymentElementProps = props;
      React.useEffect(() => {
        props.onReady?.();
        // Once per mount, like Stripe's "ready".
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return React.createElement("div", { "data-testid": "payment-element" });
    },
    ExpressCheckoutElement: (props: { onReady?: (e: unknown) => void; options?: unknown }) => {
      stripeMock.expressProps = props as Record<string, unknown>;
      return null;
    },
    useStripe: () => stripe,
    useElements: () => elements,
  };
});
vi.mock("@whop/checkout/react", async () => {
  const React = await import("react");
  return { WhopCheckoutEmbed: () => null, WhopExpressCheckoutButton: () => null, useCheckoutEmbedControls: () => React.useRef(null) };
});

const { StripePanel, StripeExpress, stripeErrorText, stripePaymentWallets, stripeInstance } = await import("@/components/checkout/StripePanel");
const { LABELS } = await import("@/components/checkout/i18n");
const { loadTheme } = await import("@/lib/layout");
const L = LABELS.fr;
const theme = loadTheme({ accentColor: "#0a7d38", radius: 12 }, "Boutique");
const buyer = { email: "a@b.co", address: { name: "A B", line1: "1 rue", city: "Paris", state: "", postalCode: "75001", country: "FR" } };
const prepared = {
  provider: "stripe" as const,
  configId: "pi_1",
  environment: "sandbox" as const,
  stripe: { clientSecret: "pi_1_secret_x", paymentIntentId: "pi_1", publishableKey: "pk_test", stripeAccount: "acct_1" },
  amountKey: "3000",
};

type Props = ComponentProps<typeof StripePanel>;
function panel(o: Partial<Props> = {}) {
  return h(StripePanel, {
    prepared,
    preparing: false,
    prepareError: null,
    theme,
    labels: L,
    payLabel: "Payer · 30,00 €",
    returnUrl: "https://x.test/c/s1/merci",
    testMode: true,
    confirm: async () => {
      stripeMock.order.push("confirm");
      return { ok: true as const, buyer };
    },
    onPaid: () => undefined,
    ...o,
  });
}
/** Renders, then lets Stripe.js "load" (the panel mounts its form once loadStripe resolves). */
async function show(el: ReturnType<typeof panel>) {
  const r = render(el);
  await act(async () => undefined);
  return r;
}
const payButton = () => document.getElementById("wc-pay-button") as HTMLButtonElement;
async function click() {
  await act(async () => {
    fireEvent.click(payButton());
  });
}

beforeEach(() => {
  stripeMock.order = [];
  stripeMock.submit.mockResolvedValue({});
  stripeMock.fetchUpdates.mockResolvedValue({});
  stripeMock.confirmPayment.mockResolvedValue({ paymentIntent: { status: "succeeded" } });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StripePanel", () => {
  it("renders the Payment Element with the client secret and the theme's appearance and language", async () => {
    await show(panel());
    expect(screen.getByTestId("payment-element")).toBeTruthy();
    expect(stripeMock.elementsOptions).toMatchObject({ clientSecret: "pi_1_secret_x", locale: "fr", appearance: { variables: { colorPrimary: "#0a7d38", borderRadius: "12px" } } });
    // Our form has name, e-mail and address: Stripe doesn't ask them again.
    expect(stripeMock.paymentElementProps?.options).toMatchObject({ fields: { billingDetails: { name: "never", email: "never", address: "never" } } });
    expect(payButton().textContent).toContain("Payer · 30,00 €");
    expect(payButton().getAttribute("aria-disabled")).toBe("false");
  });

  it("Pay: our confirm first, then confirmPayment (billing from the form, return URL, redirect if required); paid → onPaid", async () => {
    const onPaid = vi.fn();
    const locks: unknown[] = [];
    await show(panel({ onPaid, onLockChange: (l) => locks.push(l) }));
    await click();
    expect(stripeMock.order).toEqual(["confirm", "confirmPayment"]);
    const [args] = stripeMock.confirmPayment.mock.calls[0];
    expect(args).toMatchObject({
      redirect: "if_required",
      confirmParams: {
        return_url: "https://x.test/c/s1/merci",
        payment_method_data: { billing_details: { name: "A B", email: "a@b.co", address: { line1: "1 rue", city: "Paris", postal_code: "75001", country: "FR", state: "", line2: "" } } },
      },
    });
    expect(onPaid).toHaveBeenCalledTimes(1);
    // Locked while submitting (the express row can't pay twice), released after.
    expect(locks).toContain("busy");
  });

  it("a declined card: Stripe's message shown, not paid, Pay usable again", async () => {
    stripeMock.confirmPayment.mockResolvedValueOnce({ error: { type: "card_error", code: "card_declined", message: "Votre carte a été refusée." } });
    const onPaid = vi.fn();
    await show(panel({ onPaid }));
    await click();
    // Our translated sentence for the decline code (never Stripe's raw text when the code is known).
    expect(screen.getByTestId("wc-stripe-error").textContent).toBe(L.stripeErrors.card_declined);
    expect(onPaid).not.toHaveBeenCalled();
    expect(payButton().getAttribute("aria-disabled")).toBe("false");
  });

  it("an incomplete Payment Element never reaches our server", async () => {
    stripeMock.submit.mockResolvedValueOnce({ error: { type: "validation_error", message: "Numéro de carte incomplet." } });
    const confirm = vi.fn(async () => ({ ok: true as const, buyer }));
    await show(panel({ confirm }));
    await click();
    expect(confirm).not.toHaveBeenCalled();
    expect(stripeMock.confirmPayment).not.toHaveBeenCalled();
    expect(screen.getByTestId("wc-stripe-error").textContent).toContain("Numéro de carte incomplet.");
  });

  it("confirm refused (payment in flight, total updated): no confirmPayment; waits or says so", async () => {
    await show(panel({ confirm: async () => ({ ok: false, inFlight: true }), checkPaid: async () => "inFlight" }));
    await click();
    expect(stripeMock.confirmPayment).not.toHaveBeenCalled();
    expect(screen.getByTestId("wc-inflight-wait").textContent).toContain(L.paymentAlreadyInFlight);
    cleanup();
    await show(panel({ confirm: async () => ({ ok: false, refreshedConfigId: "pi_1" }) }));
    await click();
    expect(stripeMock.confirmPayment).not.toHaveBeenCalled();
    expect(screen.getByTestId("wc-stripe-error").textContent).toContain(L.totalUpdated);
  });

  it("an incomplete form points to the missing fields instead of paying", async () => {
    const onIncomplete = vi.fn();
    const confirm = vi.fn();
    await show(panel({ incomplete: ["E-mail"], onIncomplete, confirm }));
    await click();
    expect(onIncomplete).toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("back from a failed bank redirect: the message shows; a new total on the same PaymentIntent is fetched", async () => {
    const { rerender } = await show(panel({ initialError: L.paymentRedirectFailed }));
    expect(screen.getByTestId("wc-stripe-error").textContent).toContain(L.paymentRedirectFailed);
    rerender(panel({ prepared: { ...prepared, amountKey: "6000" } }));
    await act(async () => undefined);
    expect(stripeMock.fetchUpdates).toHaveBeenCalledTimes(1);
  });

  it("« total updated » stays on screen once the new PaymentIntent's form replaced the old one", async () => {
    const { rerender } = await show(panel({ confirm: async () => ({ ok: false, refreshedConfigId: "pi_2" }) }));
    await click();
    expect(screen.getByTestId("wc-stripe-error").textContent).toContain(L.totalUpdated);
    // The page mounts the new PaymentIntent (new client secret: the form remounts).
    const next = { ...prepared, configId: "pi_2", stripe: { ...prepared.stripe, clientSecret: "pi_2_secret_y", paymentIntentId: "pi_2" }, amountKey: "4000:eur" };
    rerender(panel({ prepared: next }));
    await act(async () => undefined);
    expect(stripeMock.elementsOptions).toMatchObject({ clientSecret: "pi_2_secret_y" });
    expect(screen.getByTestId("wc-stripe-error").textContent).toContain(L.totalUpdated);
    // A new attempt clears it.
    await click();
    expect(stripeMock.order).toContain("confirm");
  });

  it("Apple Pay / Google Pay never twice: off in the Payment Element when the express row shows them", async () => {
    await show(panel({ expressWallets: true }));
    expect(stripeMock.paymentElementProps?.options).toMatchObject({ wallets: { applePay: "never", googlePay: "never" } });
    expect(stripePaymentWallets({ applePay: true, googlePay: "auto" }, false)).toEqual({ applePay: "auto", googlePay: "auto", link: "auto" });
    expect(stripePaymentWallets({ applePay: false, googlePay: "off" }, false)).toEqual({ applePay: "never", googlePay: "never", link: "auto" });
  });

  it("Link never twice: off in the Payment Element when the express row offers it", () => {
    expect(stripePaymentWallets({ whopPay: true }, true)).toEqual({ applePay: "never", googlePay: "never", link: "never" });
    // The row doesn't offer Link (Whop Pay's place switched off): Stripe decides below.
    expect(stripePaymentWallets({ whopPay: false }, true)).toEqual({ applePay: "never", googlePay: "never", link: "auto" });
  });

  it("the Payment Element failing to load: reported once, Retry shown (never an endless spinner), Retry remounts", async () => {
    const onStripeLoadFailed = vi.fn();
    await show(panel({ prepared: { ...prepared, stripe: { ...prepared.stripe, publishableKey: "pk_elerr" } }, onStripeLoadFailed }));
    await act(async () => {
      (stripeMock.paymentElementProps?.onLoadError as (e: unknown) => void)({ error: { type: "api_connection_error" } });
    });
    expect(onStripeLoadFailed).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("wc-stripe-load-failed").textContent).toContain(L.stripeLoadFailed);
    expect(screen.queryByTestId("payment-element")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText(L.retry));
    });
    await act(async () => undefined);
    expect(screen.getByTestId("payment-element")).toBeTruthy();
  });

  it("a payment in flight learnt after mount (status, prepare refused): the panel starts waiting", async () => {
    const { rerender } = await show(panel({ checkPaid: async () => "inFlight" }));
    expect(screen.queryByTestId("wc-inflight-wait")).toBeNull();
    rerender(panel({ checkPaid: async () => "inFlight", inFlightAtLoad: true }));
    await act(async () => undefined);
    expect(screen.getByTestId("wc-inflight-wait").textContent).toContain(L.paymentAlreadyInFlight);
  });

  it("Stripe.js not loading: the page is told once, the buyer reads why, a retry loads again", async () => {
    loadStripe.mockResolvedValueOnce(null);
    const onStripeLoadFailed = vi.fn();
    await show(panel({ prepared: { ...prepared, stripe: { ...prepared.stripe, publishableKey: "pk_fail" } }, onStripeLoadFailed }));
    expect(onStripeLoadFailed).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("wc-stripe-load-failed").textContent).toContain(L.stripeLoadFailed);
    expect(screen.queryByTestId("payment-element")).toBeNull();
    // The failed load was dropped from the cache: "Retry" calls loadStripe again and the form mounts.
    await act(async () => {
      fireEvent.click(screen.getByText(L.retry));
    });
    await act(async () => undefined);
    expect(loadStripe).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("payment-element")).toBeTruthy();
  });

  it("Stripe.js hanging: given up after the timeout (and not cached)", async () => {
    vi.useFakeTimers();
    try {
      loadStripe.mockImplementationOnce(() => new Promise(() => undefined));
      const p = stripeInstance("pk_hang", "acct_1", 8_000);
      const settled = p.then(
        () => "loaded",
        (e: Error) => e.message,
      );
      await vi.advanceTimersByTimeAsync(8_001);
      expect(await settled).toBe("stripe_load_timeout");
      loadStripe.mockResolvedValueOnce({});
      await expect(stripeInstance("pk_hang", "acct_1", 8_000)).resolves.toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });

  it("errors in the buyer's language: codes translated, never a raw message", () => {
    expect(stripeErrorText({ type: "card_error", code: "card_declined", message: "Your card was declined." }, L)).toBe(L.stripeErrors.card_declined);
    expect(stripeErrorText({ type: "card_error", code: "card_declined", decline_code: "insufficient_funds", message: "x" }, L)).toBe(L.stripeErrors.insufficient_funds);
    expect(stripeErrorText({ type: "api_error", code: undefined, message: "Something went wrong on Stripe's end" }, L)).toBe(L.paymentFailed);
    expect(stripeErrorText({ type: "validation_error", code: "incomplete_number", message: "Numéro incomplet." }, L)).toBe("Numéro incomplet.");
    expect(stripeErrorText(null, L)).toBe(L.paymentFailed);
  });

  it("a JavaScript error while paying: our sentence, not its raw message", async () => {
    stripeMock.confirmPayment.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await show(panel());
    await click();
    expect(screen.getByTestId("wc-stripe-error").textContent).toBe(L.paymentFailed);
  });
});

describe("StripeExpress", () => {
  function express(o: Record<string, unknown> = {}) {
    return h(StripeExpress, {
      prepared,
      theme: loadTheme({ expressMethods: { applePay: true, googlePay: "auto" } }, "Boutique"),
      labels: L,
      returnUrl: "https://x.test/c/s1/merci",
      confirmExpress: async () => ({ ok: true as const, buyer }),
      onPaid: () => undefined,
      shippable: true,
      country: "FR",
      title: "Paiement express",
      ...o,
    });
  }

  it("the sheet's shipping line reads « Livraison incluse »; title and divider only once wallets are known", async () => {
    render(express());
    await act(async () => undefined);
    const opts = stripeMock.expressProps?.options as { shippingRates?: { displayName: string; amount: number }[] };
    expect(opts.shippingRates).toEqual([{ id: "checkout", amount: 0, displayName: "Livraison incluse" }]);
    const title = screen.getByText("Paiement express");
    expect(title.className).toContain("invisible");
    await act(async () => {
      (stripeMock.expressProps?.onReady as (e: unknown) => void)({ availablePaymentMethods: { applePay: true } });
    });
    expect(screen.getByText("Paiement express").className).not.toContain("invisible");
  });

  it("locked (a payment below, or the total being re-priced): the wallets are inert and never open their sheet", async () => {
    render(express({ lock: "busy" }));
    await act(async () => undefined);
    expect(document.querySelector("[inert]")).toBeTruthy();
    const resolve = vi.fn();
    (stripeMock.expressProps?.onClick as (e: unknown) => void)({ resolve });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("no wallet on the device: no section at all", async () => {
    render(express());
    await act(async () => undefined);
    await act(async () => {
      (stripeMock.expressProps?.onReady as (e: unknown) => void)({ availablePaymentMethods: undefined });
    });
    expect(screen.queryByTestId("wc-stripe-express")).toBeNull();
  });
});
