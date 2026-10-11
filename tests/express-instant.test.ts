// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/*
 * Express buttons at first paint: the express row is drawn before the first /prepare answers (our
 * PayPal button live, a placeholder per wallet the live Whop button replaces in place), a PayPal
 * click on a complete form waits for the checkout then goes on, the first /prepare leaves at once,
 * and a new checkout's wallet buttons load behind the current ones. Whop's buttons are stubbed.
 */

type ButtonProps = { checkoutConfigurationId: string; methods: string[]; onExpressMethodResolved?: (r: { rendered: string }) => void };
const whop = vi.hoisted(() => ({ buttons: [] as ButtonProps[], mounts: new Map<string, number>() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", async () => {
  const React = await import("react");
  function WhopExpressCheckoutButton(props: ButtonProps) {
    const key = `${props.checkoutConfigurationId}-${props.methods[0]}`;
    React.useEffect(() => {
      whop.mounts.set(key, (whop.mounts.get(key) ?? 0) + 1);
    }, [key]);
    whop.buttons.push(props);
    return React.createElement("button", { type: "button", "data-testid": `whop-${key}` }, props.methods[0]);
  }
  return { WhopCheckoutEmbed: () => null, WhopExpressCheckoutButton, useCheckoutEmbedControls: () => React.useRef(null) };
});
const panel = vi.hoisted(() => ({ paypal: undefined as { active: boolean; autoSubmit: boolean } | undefined }));
vi.mock("@/components/checkout/Payment", async (orig) => {
  const actual = await orig<typeof import("@/components/checkout/Payment")>();
  return {
    ...actual,
    PaymentPanel: (p: { paypal?: { active: boolean; autoSubmit: boolean } }) => {
      panel.paypal = p.paypal;
      return null;
    },
  };
});

const { CheckoutView } = await import("@/components/checkout/CheckoutView");
const { ExpressCheckout } = await import("@/components/checkout/Payment");
const { createBlock, defaultCheckoutLayout, defaultTheme } = await import("@/lib/layout");
const { SAMPLE_LINES } = await import("@/lib/sample");
const { LABELS } = await import("@/components/checkout/i18n");
const { firstPrepareBody, firstPrepareProtection, inlinePrepareScript } = await import("@/components/checkout/inlinePrepare");
const L = LABELS.fr;

type ViewProps = ComponentProps<typeof CheckoutView>;
function page(o: Partial<ViewProps> & { expressMethods?: Record<string, unknown>; expressOff?: boolean } = {}) {
  const layout = defaultCheckoutLayout();
  if (o.expressOff) layout.blocks = layout.blocks.map((b) => (b.type === "express" ? ({ ...b, props: { ...b.props, enabled: false } } as typeof b) : b));
  const theme = { ...(o.theme ?? defaultTheme("Boutique")), language: "fr" as const, ...(o.expressMethods ? { expressMethods: o.expressMethods as never } : {}) };
  const props: ViewProps = {
    layout,
    currency: "EUR",
    // Nothing to ship: Google Pay "auto" shows too.
    lines: SAMPLE_LINES.map((l) => ({ ...l, requiresShipping: false })),
    rates: [{ id: "r1", name: "Colissimo", deliveryTime: null, countries: ["FR", "BE"], priceCents: 490, freeOverCents: null, active: true, kind: "standard" } as ViewProps["rates"][number]],
    addOns: [],
    hasDiscounts: false,
    mode: { kind: "live", sessionId: "s_fast", testMode: false },
    initialCountry: "FR",
    initialPaypal: true,
    initialProvider: "whop",
    ...o,
    theme,
  };
  return h(CheckoutView, props);
}

/** A /prepare the test answers by hand; everything else never answers. */
let prepares: { body: Record<string, unknown>; at: number; resolve: (body: unknown) => void }[] = [];
function answer(i: number, body: unknown) {
  return act(async () => {
    prepares[i].resolve(body);
    await new Promise((r) => setTimeout(r, 0));
  });
}
const sleep = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));

const UA = {
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
};
const setUa = (ua: string) => vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);

beforeEach(() => {
  // Android Chrome by default: Google Pay's placeholder is drawn there.
  setUa(UA.android);
  prepares = [];
  whop.buttons = [];
  whop.mounts.clear();
  panel.paypal = undefined;
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/prepare")) {
        return new Promise((resolve) => {
          prepares.push({
            body: JSON.parse(String(init?.body ?? "{}")),
            at: Date.now(),
            // `__status`: an error answer (the rest is its body).
            resolve: (b) => {
              const { __status, ...rest } = b as { __status?: number };
              resolve(new Response(JSON.stringify(rest), { status: __status ?? 200 }));
            },
          });
        });
      }
      return new Promise(() => undefined);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as { ApplePaySession?: unknown }).ApplePaySession;
});

const paypalButton = () => screen.queryByTestId("wc-paypal-express");
// On screen (a wallet still resolving off screen keeps its placeholder in an sr-only cell).
const placeholders = () => [...document.querySelectorAll("[data-testid=wc-wallet-placeholder]")].filter((p) => !p.closest(".sr-only"));
const fill = (container: HTMLElement) => {
  const set = (auto: string, value: string) => fireEvent.change(container.querySelector(`input[autocomplete='${auto}']`)!, { target: { value } });
  set("email", "alex@example.com");
  set("given-name", "Alex");
  set("family-name", "Martin");
  set("address-line1", "1 rue de la Paix");
  set("postal-code", "75001");
  set("address-level2", "Paris");
};
// No terms box to tick (it sits in the stubbed payment panel's area).
const noTerms = { ...defaultTheme("Boutique"), language: "fr" as const, requireTerms: false };

describe("express row before the first /prepare answers", () => {
  it("PayPal is live and each wallet has a placeholder at first paint (no Whop button yet)", () => {
    render(page());
    expect(screen.getByTestId("wc-express")).toBeTruthy();
    expect(paypalButton()).toBeTruthy();
    expect(paypalButton()!.getAttribute("aria-busy")).toBeNull();
    // Google Pay's placeholder (no Apple Pay outside Safari): one cell stands for the wallets until they answer.
    expect(placeholders()).toHaveLength(1);
    expect(placeholders()[0].textContent).toContain("Pay");
    expect(whop.buttons).toHaveLength(0);
  });

  it("Apple Pay's place only where Safari's Apple Pay exists", () => {
    (window as { ApplePaySession?: unknown }).ApplePaySession = { canMakePayments: () => true };
    render(page());
    const cells = [...document.querySelectorAll("[data-express-method]")].map((c) => c.getAttribute("data-express-method"));
    expect(cells).toContain("apple-pay");
    cleanup();
    delete (window as { ApplePaySession?: unknown }).ApplePaySession;
    render(page());
    expect([...document.querySelectorAll("[data-express-method]")].map((c) => c.getAttribute("data-express-method"))).not.toContain("apple-pay");
  });

  it("Google Pay's placeholder only where its button plausibly shows (Android / Chrome), never on iOS or Safari", () => {
    const gpayPlaceholder = () => document.querySelector("[data-express-method=google-pay] [data-testid=wc-wallet-placeholder]");
    render(page());
    expect(gpayPlaceholder()).toBeTruthy();
    for (const ua of [UA.iphone, UA.safari]) {
      cleanup();
      setUa(ua);
      render(page());
      expect(gpayPlaceholder()).toBeNull();
      // The live button would still be asked (its cell stays, ready to answer once prepared).
      expect(document.querySelector("[data-express-method=google-pay]")).toBeTruthy();
      // PayPal stays on screen.
      expect(paypalButton()).toBeTruthy();
    }
  });

  it("tapping a placeholder gives a small loading feedback", () => {
    render(page());
    expect(screen.queryByTestId("wc-wallet-placeholder-loading")).toBeNull();
    act(() => {
      fireEvent.pointerDown(placeholders()[0]);
    });
    expect(screen.getByTestId("wc-wallet-placeholder-loading")).toBeTruthy();
  });

  it("the merchant's hide rules still apply: express off, every method off, PayPal not offered by Whop", () => {
    render(page({ expressOff: true }));
    expect(screen.queryByTestId("wc-express")).toBeNull();
    cleanup();
    render(page({ expressMethods: { applePay: false, googlePay: "off", whopPay: false, paypal: false } }));
    expect(screen.queryByTestId("wc-express")).toBeNull();
    cleanup();
    // Whop's last word was "off" (initialPaypal false): wallets only, no PayPal button.
    render(page({ initialPaypal: false }));
    expect(screen.getByTestId("wc-express")).toBeTruthy();
    expect(paypalButton()).toBeNull();
  });

  it("the live Whop buttons replace the placeholders in place once the checkout is prepared", async () => {
    render(page());
    await sleep(20);
    expect(prepares).toHaveLength(1);
    await answer(0, { checkoutConfigurationId: "cfg_1", environment: "sandbox", provider: "whop", paypal: true });
    expect(whop.buttons.some((b) => b.checkoutConfigurationId === "cfg_1")).toBe(true);
    expect(screen.getByTestId("wc-express")).toBeTruthy();
    expect(paypalButton()).toBeTruthy();
  });

  it("the prepare's answer stays the authority: PayPal hidden when it says Whop doesn't offer it", async () => {
    render(page());
    await sleep(20);
    await answer(0, { checkoutConfigurationId: "cfg_1", environment: "sandbox", provider: "whop", paypal: false });
    expect(paypalButton()).toBeNull();
  });

  it("the first /prepare leaves at once (no 500 ms debounce) with the page's first-load input", async () => {
    const started = Date.now();
    render(page());
    await sleep(60);
    expect(prepares).toHaveLength(1);
    expect(prepares[0].at - started).toBeLessThan(300);
    expect(prepares[0].body).toEqual({ countryCode: "FR", shippingRateId: null, discountCode: null, addOnIds: [] });
  });

  it("a failed first prepare keeps the row's place with a short message (no buttons, no jump)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => (String(url).endsWith("/prepare") ? Promise.resolve(new Response(JSON.stringify({ error: "x", code: "no_shipping" }), { status: 400 })) : new Promise(() => undefined))),
    );
    render(page());
    await sleep(50);
    expect(screen.queryByTestId("wc-express")).toBeNull();
    const row = screen.getByTestId("wc-express-unavailable");
    // "No shipping to this country" says so (never a vague "payment unavailable").
    expect(row.textContent).toContain(L.noShipping);
    expect(row.textContent).not.toContain(L.paymentUnavailable);
    // The row's height kept (two rows on a phone, as reserved next to PayPal), the heading and "OR" as before.
    expect(row.querySelector(".min-h-\\[104px\\].sm\\:min-h-12")).toBeTruthy();
    expect(row.textContent).toContain(L.or);
    expect(row.querySelector("[role=alert]")).toBeNull();
  });

  it("paying with Stripe, first prepare failed: Stripe's row place keeps a message too", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => (String(url).endsWith("/prepare") ? Promise.resolve(new Response(JSON.stringify({ error: "x", code: "no_shipping" }), { status: 400 })) : new Promise(() => undefined))),
    );
    render(page({ initialProvider: "stripe", initialPaypal: false }));
    await sleep(50);
    expect(screen.queryByTestId("wc-stripe-express-placeholder")).toBeNull();
    expect(screen.getByTestId("wc-express-unavailable").textContent).toContain(L.noShipping);
  });

  it("a first prepare failing for another reason keeps the generic \"payment unavailable\" message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => (String(url).endsWith("/prepare") ? Promise.resolve(new Response(JSON.stringify({ error: "x", code: "out_of_stock" }), { status: 400 })) : new Promise(() => undefined))),
    );
    render(page());
    await sleep(50);
    const row = screen.getByTestId("wc-express-unavailable");
    expect(row.textContent).toContain(L.paymentUnavailable);
    expect(row.textContent).not.toContain(L.noShipping);
  });

  it("paying with Stripe: Stripe's row keeps its place until its PaymentIntent exists", () => {
    render(page({ initialProvider: "stripe", initialPaypal: false }));
    expect(screen.getByTestId("wc-stripe-express-placeholder")).toBeTruthy();
    expect(screen.queryByTestId("wc-express")).toBeNull();
  });
});

describe("PayPal clicked before the checkout is prepared", () => {
  it("complete form: the button spins, then PayPal goes on (PayPal-only checkout, auto-submit) once prepared", async () => {
    const { container } = render(page({ theme: noTerms }));
    await sleep(20);
    fill(container);
    act(() => {
      fireEvent.click(paypalButton()!);
    });
    expect(paypalButton()!.getAttribute("aria-busy")).toBe("true");
    expect(panel.paypal?.active).toBe(false);
    // A second click while waiting does nothing more.
    act(() => {
      fireEvent.click(paypalButton()!);
    });
    await answer(0, { checkoutConfigurationId: "cfg_1", environment: "sandbox", provider: "whop", paypal: true });
    expect(panel.paypal?.active).toBe(true);
    expect(panel.paypal?.autoSubmit).toBe(true);
    // The PayPal-only checkout is prepared next (method "paypal"), as after any express click.
    await sleep(400);
    expect(prepares.some((p) => p.body.method === "paypal")).toBe(true);
  });

  it("incomplete form: told at once what's missing (no wait)", async () => {
    render(page());
    act(() => {
      fireEvent.click(paypalButton()!);
    });
    expect(paypalButton()!.getAttribute("aria-busy")).toBeNull();
    expect(screen.getByText(L.paypalNeedsDetails)).toBeTruthy();
    expect(panel.paypal?.autoSubmit).toBe(false);
  });

  it("the first prepare fails: the waiting click is dropped with the message said aloud (never silently)", async () => {
    const { container } = render(page({ theme: noTerms }));
    await sleep(20);
    fill(container);
    act(() => {
      fireEvent.click(paypalButton()!);
    });
    expect(paypalButton()!.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      prepares[0].resolve({ __status: 400, error: "x", code: "no_shipping" });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(panel.paypal?.autoSubmit ?? false).toBe(false);
    const alert = screen.getByTestId("wc-express-unavailable").querySelector("[role=alert]");
    expect(alert?.textContent).toBe(L.noShipping);
  });

  it("the checkout comes back on Stripe (switched): the waiting click is dropped, no PayPal", async () => {
    const { container } = render(page({ theme: noTerms }));
    await sleep(20);
    fill(container);
    act(() => {
      fireEvent.click(paypalButton()!);
    });
    await answer(0, { provider: "stripe", clientSecret: "pi_1_secret", paymentIntentId: "pi_1", publishableKey: "pk", stripeAccount: "acct_1", environment: "sandbox", paypal: false });
    expect(panel.paypal?.active ?? false).toBe(false);
    expect(paypalButton()).toBeNull();
  });
});

describe("a new checkout (another total) keeps the current wallet buttons on screen until its own answer", () => {
  const props = (configId: string) =>
    ({
      prepared: { configId, environment: "sandbox" as const },
      theme: { language: "fr" } as ComponentProps<typeof ExpressCheckout>["theme"],
      labels: L,
      returnUrl: "https://x.test/merci",
      email: "",
      onPaid: () => undefined,
      walletMethods: ["google-pay" as const],
      paypal: { onClick: () => undefined, busy: false },
    }) satisfies ComponentProps<typeof ExpressCheckout>;
  const last = (cfg: string) => [...whop.buttons].reverse().find((b) => b.checkoutConfigurationId === cfg)!;

  it("old buttons visible but locked, the new ones answering off screen, then swapped without a remount", async () => {
    const { rerender } = render(h(ExpressCheckout, props("cfg_a")));
    await act(async () => last("cfg_a").onExpressMethodResolved!({ rendered: "google-pay" }));
    rerender(h(ExpressCheckout, props("cfg_b")));
    const oldBtn = screen.getByTestId("whop-cfg_a-google-pay");
    const newBtn = screen.getByTestId("whop-cfg_b-google-pay");
    // The old checkout's button stays where it was, out of reach (it charges the old total).
    expect(oldBtn.closest("[inert]")).toBeTruthy();
    expect(oldBtn.closest(".sr-only")).toBeNull();
    // The new one loads off screen.
    expect(newBtn.closest(".sr-only")).toBeTruthy();
    // PayPal (our own button) stays usable meanwhile.
    expect(screen.getByTestId("wc-paypal-express").closest("[inert]")).toBeNull();
    await act(async () => last("cfg_b").onExpressMethodResolved!({ rendered: "google-pay" }));
    expect(screen.queryByTestId("whop-cfg_a-google-pay")).toBeNull();
    const swapped = screen.getByTestId("whop-cfg_b-google-pay");
    expect(swapped.closest(".sr-only")).toBeNull();
    expect(swapped.closest("[inert]")).toBeNull();
    // Moved into place, never mounted twice (an iframe reload).
    expect(whop.mounts.get("cfg_b-google-pay")).toBe(1);
  });

  it("a late answer of the old checkout's buttons never wipes the new one's answers (swapped at once, not after 6 s)", async () => {
    vi.useFakeTimers();
    try {
      const two = (cfg: string) => ({ ...props(cfg), walletMethods: ["google-pay" as const, "whop-pay" as const] });
      const lastOf = (cfg: string, m: string) => [...whop.buttons].reverse().find((b) => b.checkoutConfigurationId === cfg && b.methods[0] === m)!;
      const { rerender } = render(h(ExpressCheckout, two("cfg_a")));
      await act(async () => lastOf("cfg_a", "google-pay").onExpressMethodResolved!({ rendered: "google-pay" }));
      await act(async () => lastOf("cfg_a", "whop-pay").onExpressMethodResolved!({ rendered: "whop-pay" }));
      rerender(h(ExpressCheckout, two("cfg_b")));
      // The new checkout's Google Pay answers, then the OLD checkout's Whop Pay answers again (late).
      await act(async () => lastOf("cfg_b", "google-pay").onExpressMethodResolved!({ rendered: "google-pay" }));
      await act(async () => lastOf("cfg_a", "whop-pay").onExpressMethodResolved!({ rendered: "whop-pay" }));
      expect(screen.getByTestId("whop-cfg_a-google-pay")).toBeTruthy();
      // The new checkout's last wallet answers: swapped right away (no 6 s wait).
      await act(async () => lastOf("cfg_b", "whop-pay").onExpressMethodResolved!({ rendered: "whop-pay" }));
      expect(screen.queryByTestId("whop-cfg_a-google-pay")).toBeNull();
      expect(screen.queryByTestId("whop-cfg_a-whop-pay")).toBeNull();
      expect(screen.getByTestId("whop-cfg_b-google-pay").closest("[inert]")).toBeNull();
      expect(screen.getByTestId("whop-cfg_b-whop-pay").closest(".sr-only")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a new checkout whose wallets never answer replaces the old one after a while anyway", async () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(h(ExpressCheckout, props("cfg_a")));
      await act(async () => last("cfg_a").onExpressMethodResolved!({ rendered: "google-pay" }));
      rerender(h(ExpressCheckout, props("cfg_b")));
      expect(screen.getByTestId("whop-cfg_a-google-pay")).toBeTruthy();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_100);
      });
      expect(screen.queryByTestId("whop-cfg_a-google-pay")).toBeNull();
      expect(screen.getByTestId("whop-cfg_b-google-pay").closest(".sr-only")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a change of total locks the wallet buttons on screen until the new checkout (re-prepare in flight)", () => {
  it("ExpressCheckout: stale → the current buttons stay visible but locked; unlocked once fresh", async () => {
    const base = {
      theme: { language: "fr" } as ComponentProps<typeof ExpressCheckout>["theme"],
      labels: L,
      returnUrl: "https://x.test/merci",
      email: "",
      onPaid: () => undefined,
      walletMethods: ["google-pay" as const],
      paypal: { onClick: () => undefined, busy: false },
      prepared: { configId: "cfg_a", environment: "sandbox" as const },
    } satisfies ComponentProps<typeof ExpressCheckout>;
    const { rerender } = render(h(ExpressCheckout, base));
    await act(async () => [...whop.buttons].reverse().find((b) => b.checkoutConfigurationId === "cfg_a")!.onExpressMethodResolved!({ rendered: "google-pay" }));
    expect(screen.getByTestId("whop-cfg_a-google-pay").closest("[inert]")).toBeNull();
    rerender(h(ExpressCheckout, { ...base, stale: true }));
    const btn = screen.getByTestId("whop-cfg_a-google-pay");
    expect(btn.closest("[inert]")).toBeTruthy();
    expect(btn.closest(".sr-only")).toBeNull();
    expect(screen.getByTestId("wc-express").getAttribute("aria-busy")).toBe("true");
    rerender(h(ExpressCheckout, { ...base, stale: false }));
    expect(screen.getByTestId("whop-cfg_a-google-pay").closest("[inert]")).toBeNull();
  });

  it("CheckoutView: another rate → old wallet locked from the click (debounce included), PayPal waits for the new prepare", async () => {
    const twoRates = [
      { id: "r1", name: "Colissimo", deliveryTime: null, countries: ["FR"], priceCents: 490, freeOverCents: null, active: true, kind: "standard" },
      { id: "r2", name: "Express", deliveryTime: null, countries: ["FR"], priceCents: 990, freeOverCents: null, active: true, kind: "standard" },
    ] as ViewProps["rates"];
    const { container } = render(
      page({
        theme: noTerms,
        lines: SAMPLE_LINES.map((l) => ({ ...l, requiresShipping: true })),
        rates: twoRates,
        expressMethods: { applePay: true, googlePay: "always", whopPay: false, paypal: true },
      }),
    );
    await sleep(20);
    await answer(0, { checkoutConfigurationId: "cfg_1", environment: "sandbox", provider: "whop", paypal: true });
    expect(screen.getByTestId("whop-cfg_1-google-pay").closest("[inert]")).toBeNull();
    fill(container);
    const express = [...container.querySelectorAll<HTMLInputElement>("input[name=rate]")][1];
    act(() => {
      fireEvent.click(express);
    });
    // Locked at once (the old checkout charges Colissimo's total), still visible.
    expect(screen.getByTestId("whop-cfg_1-google-pay").closest("[inert]")).toBeTruthy();
    // PayPal clicked meanwhile: waits (spinner) for the new checkout.
    act(() => {
      fireEvent.click(paypalButton()!);
    });
    expect(paypalButton()!.getAttribute("aria-busy")).toBe("true");
    expect(panel.paypal?.active ?? false).toBe(false);
    await sleep(600);
    expect(prepares).toHaveLength(2);
    expect(prepares[1].body.shippingRateId).toBe("r2");
    // Still in flight: still locked.
    expect(screen.getByTestId("whop-cfg_1-google-pay").closest("[inert]")).toBeTruthy();
    await answer(1, { checkoutConfigurationId: "cfg_2", environment: "sandbox", provider: "whop", paypal: true });
    expect(panel.paypal?.active).toBe(true);
  });
});

describe("the first /prepare's silent retries are bounded", async () => {
  const { prepareRetryable, PREPARE_RETRY_MAX_MS } = await import("@/components/checkout/CheckoutView");
  const prepareCalls = () => (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).endsWith("/prepare")).length;
  const answering = (status: number, body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => (String(url).endsWith("/prepare") ? Promise.resolve(new Response(JSON.stringify(body), { status })) : new Promise(() => undefined))),
    );

  it("5xx retried, except Whop unavailable (the server already waited its longest); 4xx never", () => {
    expect(prepareRetryable(502, "init_failed")).toBe(true);
    expect(prepareRetryable(503, "session_changed")).toBe(true);
    expect(prepareRetryable(503, "whop_unavailable")).toBe(false);
    expect(prepareRetryable(400, "no_shipping")).toBe(false);
    expect(PREPARE_RETRY_MAX_MS).toBe(30_000);
  });

  it("Whop unavailable: no retry, the « paiement indisponible / réessayer » state at once", async () => {
    answering(503, { error: "x", code: "whop_unavailable" });
    render(page());
    await sleep(1_100);
    expect(prepareCalls()).toBe(1);
    expect(screen.getByTestId("wc-express-unavailable")).toBeTruthy();
  });

  it("a 5xx is retried silently (0.8 s later)", async () => {
    answering(502, { error: "x", code: "init_failed" });
    render(page());
    await sleep(1_100);
    expect(prepareCalls()).toBe(2);
    // Still retrying: no error shown yet.
    expect(screen.queryByTestId("wc-express-unavailable")).toBeNull();
  });

  it("no retry once ~30 s went by since the first attempt (each one hanging on a slow processor)", async () => {
    // The first attempt answers a 5xx after 29.5 s (the clock moved on by then).
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (!String(url).endsWith("/prepare")) return new Promise(() => undefined);
        offset = 29_500;
        return Promise.resolve(new Response(JSON.stringify({ error: "x", code: "init_failed" }), { status: 502 }));
      }),
    );
    render(page());
    await sleep(1_100);
    expect(prepareCalls()).toBe(1);
    expect(screen.getByTestId("wc-express-unavailable")).toBeTruthy();
  });
});

describe("the first /prepare sent by the page's inline script while its HTML is parsed (inlinePrepare)", () => {
  beforeEach(() => {
    (window as { __wcPrepare?: unknown }).__wcPrepare = undefined;
  });

  /** The page's first prepare as it sends it (the request's own text), with no inline script. */
  async function pageFirstBody(o: Partial<ViewProps> = {}): Promise<string> {
    render(page(o));
    await sleep(20);
    const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith("/prepare"));
    const sent = String((call?.[1] as RequestInit | undefined)?.body);
    cleanup();
    prepares = [];
    vi.mocked(fetch).mockClear();
    return sent;
  }
  const inlineSent = (body: string, session = "s_fast") => new Function(inlinePrepareScript(session, body))();

  it("the page's first body is the one the server writes for the inline script (same text)", async () => {
    expect(await pageFirstBody()).toBe(firstPrepareBody("FR", undefined));
    // A protection block on by default, and a country picked from the browser's locale or the main market.
    const layout = defaultCheckoutLayout();
    layout.blocks.push(createBlock("shipping_protection", { props: { ...createBlock("shipping_protection").props, defaultOn: true } } as never));
    expect(await pageFirstBody({ layout, initialCountry: null, localeCountry: "BE" })).toBe(firstPrepareBody("BE", true));
    expect(await pageFirstBody({ initialCountry: null, localeCountry: null, primaryCountry: "BE" })).toBe(firstPrepareBody("BE", undefined));
  });

  it("the server reads the protection's first state as the page starts it (firstPrepareProtection, in page.tsx)", async () => {
    const withBlock = (overrides: Record<string, unknown>) => {
      const layout = defaultCheckoutLayout();
      layout.blocks.push(createBlock("shipping_protection", overrides as never));
      return layout;
    };
    const on = withBlock({ props: { ...createBlock("shipping_protection").props, defaultOn: true } });
    const off = withBlock({});
    const hidden = withBlock({ hidden: true, props: { ...createBlock("shipping_protection").props, defaultOn: true } });
    expect([on, off, hidden, defaultCheckoutLayout()].map((l) => firstPrepareProtection(l.blocks))).toEqual([true, false, undefined, undefined]);
    for (const layout of [on, off, hidden, defaultCheckoutLayout()]) expect(await pageFirstBody({ layout })).toBe(firstPrepareBody("FR", firstPrepareProtection(layout.blocks)));
  });

  it("the country the server sent the inline prepare for is the page's first address (one request for both), when shipped to", async () => {
    // The hints would pick FR; the server's pick (passed down) wins.
    expect(await pageFirstBody({ firstCountry: "BE" })).toBe(firstPrepareBody("BE", undefined));
    // A country the store doesn't ship to: the page picks as usual.
    expect(await pageFirstBody({ firstCountry: "US" })).toBe(firstPrepareBody("FR", undefined));
  });

  it("a field changed while the inline answer is on its way: that late answer is dropped, the new prepare's checkout used", async () => {
    const sent = await pageFirstBody();
    inlineSent(sent);
    render(page());
    await sleep(20);
    expect(prepares).toHaveLength(1);
    // The buyer picks another country before the inline answer lands.
    fireEvent.change(screen.getByLabelText(L.country), { target: { value: "BE" } });
    await sleep(600);
    expect(prepares).toHaveLength(2);
    expect(prepares[1].body).toMatchObject({ countryCode: "BE" });
    // The FR answer lands late: never on the page.
    await answer(0, { checkoutConfigurationId: "cfg_stale", environment: "sandbox", provider: "whop", paypal: true });
    await sleep(20);
    expect(whop.buttons.some((b) => b.checkoutConfigurationId === "cfg_stale")).toBe(false);
    await answer(1, { checkoutConfigurationId: "cfg_be", environment: "sandbox", provider: "whop", paypal: true });
    expect(whop.buttons.some((b) => b.checkoutConfigurationId === "cfg_be")).toBe(true);
    expect(whop.buttons.some((b) => b.checkoutConfigurationId === "cfg_stale")).toBe(false);
  });

  it("the page takes the inline script's answer: no second request, its checkout on the page", async () => {
    const sent = await pageFirstBody();
    inlineSent(sent);
    expect(prepares).toHaveLength(1);
    render(page());
    await sleep(20);
    expect(prepares).toHaveLength(1);
    await answer(0, { checkoutConfigurationId: "cfg_early", environment: "sandbox", provider: "whop", paypal: true });
    expect(whop.buttons.some((b) => b.checkoutConfigurationId === "cfg_early")).toBe(true);
    // A later prepare (another country) asks the server itself.
    fireEvent.change(screen.getByLabelText(L.country), { target: { value: "BE" } });
    await sleep(600);
    expect(prepares).toHaveLength(2);
    expect(prepares[1].body).toMatchObject({ countryCode: "BE" });
  });

  it("only the first prepare looks at it: back to the first country later, the server is asked again", async () => {
    const sent = await pageFirstBody();
    // An inline answer for another body: the first prepare asks itself, and the answer is gone.
    inlineSent(firstPrepareBody("BE", undefined));
    render(page());
    await sleep(20);
    expect(prepares).toHaveLength(2);
    await answer(1, { checkoutConfigurationId: "cfg_1", environment: "sandbox", provider: "whop", paypal: true });
    fireEvent.change(screen.getByLabelText(L.country), { target: { value: "BE" } });
    await sleep(600);
    // The inline answer (for BE) was dropped at the first prepare: this BE prepare is a request of its own.
    expect(prepares).toHaveLength(3);
    expect(prepares[2].body).toMatchObject({ countryCode: "BE" });
    expect(JSON.parse(sent)).toMatchObject({ countryCode: "FR" });
  });

  it("another session: the page asks the server itself", async () => {
    const sent = await pageFirstBody();
    inlineSent(sent, "s_other");
    render(page());
    await sleep(20);
    expect(prepares).toHaveLength(2);
    expect(prepares[1].body).toMatchObject({ countryCode: "FR" });
  });

  it("the inline request failed (network), or answered a 5xx: the page asks again (at once, or as its silent retry)", async () => {
    const sent = await pageFirstBody();
    const stub = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    inlineSent(sent);
    vi.mocked(fetch).mockImplementation(stub);
    render(page());
    await sleep(20);
    expect(prepares).toHaveLength(1);
    expect(prepares[0].body).toMatchObject({ countryCode: "FR" });
    cleanup();
    prepares = [];

    inlineSent(sent);
    render(page());
    await sleep(20);
    await answer(0, { __status: 502, error: "x", code: "init_failed" });
    // Not retried from the inline answer: a fresh request, after the silent retry's pause.
    await sleep(1_000);
    expect(prepares).toHaveLength(2);
    await answer(1, { checkoutConfigurationId: "cfg_retry", environment: "sandbox", provider: "whop", paypal: true });
    expect(whop.buttons.some((b) => b.checkoutConfigurationId === "cfg_retry")).toBe(true);
  });

  it("the page gone before the inline answer: nothing of it reaches the page", async () => {
    const sent = await pageFirstBody();
    inlineSent(sent);
    render(page());
    await sleep(20);
    cleanup();
    await answer(0, { checkoutConfigurationId: "cfg_late", environment: "sandbox", provider: "whop", paypal: true });
    expect(whop.buttons.some((b) => b.checkoutConfigurationId === "cfg_late")).toBe(false);
  });
});
