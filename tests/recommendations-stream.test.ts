// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { renderToReadableStream } from "react-dom/server";

/*
 * "Complétez votre commande" streamed by the server page as a promise: read with use() under
 * <Suspense>, so a Shopify answer that lands while the page renders is in the server HTML (no
 * effect → state round-trip after hydration). Whop's components are stubbed.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", async () => {
  const React = await import("react");
  return { WhopCheckoutEmbed: () => null, WhopExpressCheckoutButton: () => null, useCheckoutEmbedControls: () => React.useRef(null) };
});

const { CheckoutView } = await import("@/components/checkout/CheckoutView");
const { createBlock, defaultCheckoutLayout, defaultTheme } = await import("@/lib/layout");
const { SAMPLE_LINES } = await import("@/lib/sample");

type ViewProps = ComponentProps<typeof CheckoutView>;

async function html(recommendations: ViewProps["recommendations"]) {
  const layout = defaultCheckoutLayout();
  const reco = createBlock("recommendations");
  (reco.props as { items: { variantId: string; title: string; imageUrl: string }[] }).items = [{ variantId: "gid://shopify/ProductVariant/99", title: "", imageUrl: "" }];
  layout.blocks.push(reco);
  const props: ViewProps = {
    layout,
    theme: { ...defaultTheme("Boutique"), language: "fr" as const },
    currency: "EUR",
    lines: SAMPLE_LINES,
    rates: [{ id: "r1", name: "Colissimo", deliveryTime: null, countries: ["FR"], priceCents: 490, freeOverCents: null, active: true, kind: "standard" } as ViewProps["rates"][number]],
    addOns: [],
    hasDiscounts: false,
    mode: { kind: "live", sessionId: "s_reco", testMode: false },
    initialCountry: "FR",
    recommendations,
  };
  const stream = await renderToReadableStream(h(CheckoutView, props));
  await stream.allReady;
  return new Response(stream).text();
}

const suggested = {
  ...SAMPLE_LINES[0],
  variantId: "gid://shopify/ProductVariant/99",
  productId: "gid://shopify/Product/99",
  title: "Bougie suggérée parfumée",
  quantity: 1,
};

describe("recommendations streamed by the server page", () => {
  it("a promise that lands during the render is in the server HTML", async () => {
    const out = await html(Promise.resolve([suggested]));
    expect(out).toContain("Bougie suggérée parfumée");
  });

  it("a slow / failed Shopify (null) hides the block, nothing else breaks", async () => {
    const out = await html(Promise.resolve(null));
    expect(out).not.toContain("Bougie suggérée parfumée");
    expect(out.length).toBeGreaterThan(1000);
  });
});
