// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { act, cleanup, render } from "@testing-library/react";

/*
 * The checkout page's own watchdog, wired (Whop's buttons and the payment panel stubbed): the page
 * marks itself started; a first prepare that fails (its error shown) is never taken for a missing
 * form; one still on its way after 20 s is reported slow (never stuck); a page whose form came is
 * silent; the inline first prepare that failed is reported and the page asks the server itself; the
 * page put in the background without the card form ever ready is reported, never with PayPal chosen
 * (its window does that). A request unanswered after PREPARE_REQUEST_MAX_MS (a dead connection) is
 * given up and asked again at once, once; a failure of the network itself shows the page's own
 * words, never the browser's.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", async () => {
  const React = await import("react");
  return { WhopCheckoutEmbed: () => null, WhopExpressCheckoutButton: () => null, useCheckoutEmbedControls: () => React.useRef(null) };
});
const panel = vi.hoisted(() => ({
  last: null as { prepared: unknown; prepareError: string | null } | null,
  express: null as { paypal: { onClick: () => void } | null } | null,
}));
vi.mock("@/components/checkout/Payment", async (orig) => ({
  ...(await orig<typeof import("@/components/checkout/Payment")>()),
  PaymentPanel: (p: { prepared: unknown; prepareError: string | null }) => {
    panel.last = p;
    return null;
  },
  ExpressCheckout: (p: { paypal: { onClick: () => void } | null }) => {
    panel.express = p;
    return null;
  },
}));

const { CheckoutView } = await import("@/components/checkout/CheckoutView");
const { defaultCheckoutLayout, defaultTheme } = await import("@/lib/layout");
const { checkoutCopy } = await import("@/components/checkout/localize");
const { SAMPLE_LINES } = await import("@/lib/sample");
const { BOOT_FLAG } = await import("@/components/checkout/inlineWatchdog");
const { LEFT_MIN_MS, SLOW_AFTER_MS, STUCK_AFTER_MS } = await import("@/components/checkout/paymentHealth");
const { inlinePrepareScript, prepareBody } = await import("@/components/checkout/inlinePrepare");
const { PREPARE_REQUEST_MAX_MS } = await import("@/components/checkout/CheckoutView");
const { LABELS } = await import("@/components/checkout/i18n");

type ViewProps = ComponentProps<typeof CheckoutView>;
const page = () =>
  h(CheckoutView, {
    copy: checkoutCopy({ ...defaultTheme("Boutique"), language: "fr" as const }, defaultCheckoutLayout()),
    currency: "EUR",
    lines: SAMPLE_LINES.map((l) => ({ ...l, requiresShipping: false })),
    rates: [{ id: "r1", name: "Colissimo", deliveryTime: null, countries: ["FR"], priceCents: 490, freeOverCents: null, active: true, kind: "standard" } as ViewProps["rates"][number]],
    addOns: [],
    hasDiscounts: false,
    mode: { kind: "live", sessionId: "s_watch", testMode: false },
    initialCountry: "FR",
    initialProvider: "whop",
  } as ViewProps);

let beacons: { url: string; body: Record<string, unknown> }[] = [];
let visibility: DocumentVisibilityState;
let prepares: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  beacons = [];
  prepares = [];
  panel.last = null;
  panel.express = null;
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  delete (window as unknown as Record<string, unknown>)[BOOT_FLAG];
  (window as { __wcPrepare?: unknown }).__wcPrepare = undefined;
  Element.prototype.scrollIntoView = vi.fn();
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: vi.fn((url: string, body: string) => {
      beacons.push({ url, body: JSON.parse(body) });
      return true;
    }),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => (String(url).endsWith("/prepare") ? new Promise<Response>((resolve, reject) => prepares.push({ resolve, reject })) : new Promise(() => undefined))),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const kinds = () => beacons.map((b) => b.body.kind);

describe("the checkout page's watchdog, wired", () => {
  it("marks the page started; a page whose form came stays silent, even long after", async () => {
    render(page());
    expect((window as unknown as Record<string, unknown>)[BOOT_FLAG]).toBe(true);
    await advance(10);
    expect(prepares).toHaveLength(1);
    await act(async () => prepares[0].resolve(new Response(JSON.stringify({ provider: "whop", checkoutConfigurationId: "cfg_1", environment: "sandbox" }), { status: 200 })));
    await advance(5 * SLOW_AFTER_MS);
    expect(kinds()).toEqual([]);
  });

  it("a first prepare that fails (its error shown): never taken for a missing form", async () => {
    render(page());
    await advance(10);
    await act(async () => prepares[0].resolve(new Response(JSON.stringify({ code: "invalid_body" }), { status: 400 })));
    await advance(5 * STUCK_AFTER_MS);
    expect(kinds()).not.toContain("prepare_stuck");
    expect(kinds()).not.toContain("prepare_slow");
  });

  it("a first prepare still on its way after 20 s: reported slow, never stuck", async () => {
    render(page());
    // The page renders its prepare on its way (as a browser does within milliseconds), then waits.
    await advance(10);
    await advance(SLOW_AFTER_MS);
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "prepare_slow", provider: "whop", prepared: false, preparing: true })]);
    await advance(3 * STUCK_AFTER_MS);
    expect(kinds()).toEqual(["prepare_slow"]);
  });

  it("the inline first prepare failed: reported, and the page asks the server itself", async () => {
    // The inline request (sent with the HTML) dies on the network.
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (!String(url).endsWith("/prepare")) return new Promise(() => undefined);
        if (prepares.length === 0) {
          prepares.push({ resolve: () => undefined, reject: () => undefined });
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return new Promise<Response>((resolve, reject) => prepares.push({ resolve, reject }));
      }),
    );
    new Function(inlinePrepareScript("s_watch", prepareBody({ countryCode: "FR", shippingRateId: null, discountCode: null, addOnIds: [], protection: undefined })))();
    render(page());
    await advance(50);
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "inline_prepare_failed", reason: "network" })]);
    expect(prepares).toHaveLength(2);
  });

  it("the page put in the background with the card form never ready: reported; with PayPal chosen (its window does that): never", async () => {
    const whopForm = () => new Response(JSON.stringify({ provider: "whop", checkoutConfigurationId: "cfg_1", environment: "sandbox" }), { status: 200 });
    const view = render(page());
    await advance(10);
    await act(async () => prepares[0].resolve(whopForm()));
    await advance(LEFT_MIN_MS);
    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "left_without_form", how: "hidden", paypal: false })]);
    view.unmount();
    beacons = [];
    prepares = [];
    visibility = "visible";
    render(page());
    await advance(10);
    await act(async () => prepares[0].resolve(whopForm()));
    await advance(LEFT_MIN_MS);
    expect(panel.express?.paypal).not.toBeNull();
    act(() => panel.express?.paypal?.onClick());
    act(() => {
      visibility = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    window.dispatchEvent(new Event("pagehide"));
    expect(kinds()).not.toContain("left_without_form");
  });

  describe("a dead connection", () => {
    // The browser's own timeout (AbortSignal.timeout), on the test's clock; the request given up with it.
    beforeEach(() => {
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
        const c = new AbortController();
        setTimeout(() => c.abort(new DOMException("signal timed out", "TimeoutError")), ms);
        return c.signal;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string, init?: RequestInit) => {
          if (!String(url).endsWith("/prepare")) return new Promise(() => undefined);
          return new Promise<Response>((resolve, reject) => {
            prepares.push({ resolve, reject });
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          });
        }),
      );
    });
    const whopForm = () => new Response(JSON.stringify({ provider: "whop", checkoutConfigurationId: "cfg_1", environment: "sandbox" }), { status: 200 });

    it("a request unanswered after PREPARE_REQUEST_MAX_MS: given up and asked again at once", async () => {
      render(page());
      await advance(10);
      expect(prepares).toHaveLength(1);
      await advance(PREPARE_REQUEST_MAX_MS - 20);
      expect(prepares).toHaveLength(1);
      await advance(20);
      expect(prepares).toHaveLength(2);
      await act(async () => prepares[1].resolve(whopForm()));
      expect(panel.last).toMatchObject({ prepared: expect.objectContaining({ configId: "cfg_1" }), prepareError: null });
    });

    it("given up twice: the page's plain words (« réessayer »), never the browser's", async () => {
      render(page());
      await advance(10);
      await advance(PREPARE_REQUEST_MAX_MS);
      await advance(PREPARE_REQUEST_MAX_MS);
      expect(prepares).toHaveLength(2);
      expect(panel.last?.prepareError).toBe(LABELS.fr.error);
    });

    it("the network down at every try (the silent retries spent): the page's plain words, never the browser's", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((url: string) => (String(url).endsWith("/prepare") ? Promise.reject(new TypeError("Failed to fetch")) : new Promise(() => undefined))),
      );
      render(page());
      await advance(10_000);
      expect(panel.last?.prepareError).toBe(LABELS.fr.error);
    });
  });
});
