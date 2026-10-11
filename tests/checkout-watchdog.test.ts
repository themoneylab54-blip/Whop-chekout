// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { act, cleanup, render } from "@testing-library/react";

/*
 * The checkout page's own watchdog, wired (Whop's buttons and the payment panel stubbed): the page
 * marks itself started; a first prepare that fails (its error shown) is never taken for a missing
 * form; one still on its way after 20 s is reported slow (never stuck); a page whose form came is
 * silent; the inline first prepare that failed is reported and the page asks the server itself.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", async () => {
  const React = await import("react");
  return { WhopCheckoutEmbed: () => null, WhopExpressCheckoutButton: () => null, useCheckoutEmbedControls: () => React.useRef(null) };
});
vi.mock("@/components/checkout/Payment", async (orig) => ({ ...(await orig<typeof import("@/components/checkout/Payment")>()), PaymentPanel: () => null }));

const { CheckoutView } = await import("@/components/checkout/CheckoutView");
const { defaultCheckoutLayout, defaultTheme } = await import("@/lib/layout");
const { SAMPLE_LINES } = await import("@/lib/sample");
const { BOOT_FLAG } = await import("@/components/checkout/inlineWatchdog");
const { SLOW_AFTER_MS, STUCK_AFTER_MS } = await import("@/components/checkout/paymentHealth");
const { inlinePrepareScript, prepareBody } = await import("@/components/checkout/inlinePrepare");

type ViewProps = ComponentProps<typeof CheckoutView>;
const page = () =>
  h(CheckoutView, {
    theme: { ...defaultTheme("Boutique"), language: "fr" as const },
    layout: defaultCheckoutLayout(),
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
let prepares: { resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  beacons = [];
  prepares = [];
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
});
