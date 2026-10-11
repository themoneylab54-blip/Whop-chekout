// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { renderToReadableStream } from "react-dom/server";

/*
 * A relay-point rate chosen from the start (the store's only rate): the picker is in the server HTML,
 * in place, the first time (part of the page's own code: never a placeholder swapped in later). Whop's
 * components are stubbed.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", async () => {
  const React = await import("react");
  return { WhopCheckoutEmbed: () => null, WhopExpressCheckoutButton: () => null, useCheckoutEmbedControls: () => React.useRef(null) };
});

const { CheckoutView } = await import("@/components/checkout/CheckoutView");
const { defaultCheckoutLayout, defaultTheme } = await import("@/lib/layout");
const { checkoutCopy } = await import("@/components/checkout/localize");
const { LABELS } = await import("@/components/checkout/i18n");
const { SAMPLE_LINES } = await import("@/lib/sample");

type ViewProps = ComponentProps<typeof CheckoutView>;

async function html(rates: ViewProps["rates"]) {
  const props: ViewProps = {
    copy: checkoutCopy({ ...defaultTheme("Boutique"), language: "fr" }, defaultCheckoutLayout()),
    currency: "EUR",
    lines: SAMPLE_LINES,
    rates,
    addOns: [],
    hasDiscounts: false,
    mode: { kind: "live", sessionId: "s_relay", testMode: false },
    initialCountry: "FR",
  };
  const stream = await renderToReadableStream(h(CheckoutView, props));
  await stream.allReady;
  return new Response(stream).text();
}

const relay = { id: "r_relay", name: "Point relais", deliveryTime: null, countries: ["FR"], priceCents: 390, freeOverCents: null, active: true, kind: "pickup" } as ViewProps["rates"][number];
const home = { id: "r_home", name: "Colissimo", deliveryTime: null, countries: ["FR"], priceCents: 490, freeOverCents: null, active: true, kind: "standard" } as ViewProps["rates"][number];

describe("the relay-point picker in the server HTML", () => {
  it("a relay-point rate chosen from the start: the picker is there, in place, at once", async () => {
    const out = await html([relay]);
    const at = out.indexOf('data-field="pickup"');
    expect(at).toBeGreaterThan(-1);
    expect(out).toContain(LABELS.fr.pickupTitle);
    // In place: never in a part streamed apart (after the page) and swapped in by a script.
    const streamedApart = out.indexOf('<div hidden id="S:');
    expect(streamedApart === -1 || at < streamedApart).toBe(true);
  });

  it("a relay-point rate offered but not chosen: no picker", async () => {
    const out = await html([home, relay]);
    expect(out).not.toContain('data-field="pickup"');
  });
});
