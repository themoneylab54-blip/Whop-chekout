// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement as h, createRef, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

/*
 * Canvas review fixes, rendered in jsdom: the empty text block's placeholder opens a blank inline
 * editor, the header's payment-logos block gets its own pill (not « Invisible »), and the express
 * row reports only the wallets whose button is really on screen.
 */

type ExpressButtonProps = { methods: string[]; onExpressMethodResolved?: (r: { rendered: string }) => void };
const whop = vi.hoisted(() => ({ buttons: new Map<string, ExpressButtonProps>() }));
vi.mock("@whop/checkout/react", async () => {
  const React = await import("react");
  return {
    WhopCheckoutEmbed: () => null,
    WhopExpressCheckoutButton: (props: ExpressButtonProps) => {
      whop.buttons.set(props.methods[0], props);
      return React.createElement("button", { type: "button" }, props.methods[0]);
    },
    useCheckoutEmbedControls: () => React.useRef(null),
  };
});

const { CanvasOverlays } = await import("@/components/builder/CanvasOverlays");
const { ContentBlock } = await import("@/components/checkout/blocks");
const { ExpressCheckout } = await import("@/components/checkout/Payment");
const { createBlock } = await import("@/lib/layout");
const { LABELS } = await import("@/components/checkout/i18n");

beforeAll(() => {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // Every element measures as a 300×40 box (blocks need a size to get an overlay).
  Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 40, top: 40, left: 0, right: 300, bottom: 80, width: 300, height: 40, toJSON: () => ({}) }) as DOMRect;
  Element.prototype.scrollIntoView = () => {};
  // jsdom has no CSS.escape (block ids are plain here).
  if (!globalThis.CSS?.escape) (globalThis as { CSS?: unknown }).CSS = { ...(globalThis.CSS ?? {}), escape: (s: string) => s };
});
afterEach(cleanup);

const ctx = {
  labels: LABELS.fr,
  lang: "fr",
  lowestInventory: null,
  preview: true,
  subtotalCents: 0,
  freeShippingThresholdCents: null,
  money: (c: number) => String(c),
  note: "",
  setNote: () => {},
} as unknown as ComponentProps<typeof ContentBlock>["ctx"];

/** The preview (blocks) with the overlay layer over it, like the builder canvas. */
function canvas({ blocks, overlay }: { blocks: ReturnType<typeof createBlock>[]; overlay: Partial<ComponentProps<typeof CanvasOverlays>> }) {
  const root = createRef<HTMLDivElement>();
  return h(
    "div",
    { ref: root },
    blocks.map((b) => h("div", { key: b.id, "data-block-id": b.id }, h(ContentBlock, { block: b, ctx }))),
    h(CanvasOverlays, { rootRef: root, page: "checkout", blocks, selected: null, names: {}, onSelect: () => {}, ...overlay }),
  );
}

async function frames() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
}

describe("empty text block: inline editor opens blank", () => {
  it("F2 edits the body, starting from '' (not the placeholder wording)", async () => {
    const text = createBlock("text");
    text.props.heading = "";
    text.props.body = "";
    const values: Record<string, string> = { heading: "", body: "" };
    const commit = vi.fn();
    render(
      canvas({
        blocks: [text],
        overlay: { inline: { fields: () => ["heading", "body"], value: (_id, f) => values[f], multiline: () => true, commit } },
      }),
    );
    const marker = document.querySelector("[data-inline-field='body']")!;
    expect(marker.hasAttribute("data-inline-empty")).toBe(true);
    expect(marker.textContent).toBe("Bloc texte vide");
    await frames();
    fireEvent.keyDown(document.querySelector(`[data-overlay-id="${text.id}"]`)!, { key: "F2" });
    const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(editor.value).toBe("");
    // Closing it untouched writes nothing (no « Bloc texte vide » saved as text).
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("payment logos shown next to « Paiement »", () => {
  it("own pill, not greyed « Invisible pour vos clients »", async () => {
    const icons = createBlock("payment_icons");
    render(canvas({ blocks: [icons], overlay: { logosInHeader: icons.id, invisible: new Set<string>() } }));
    await frames();
    const overlay = document.querySelector(`[data-overlay-id="${icons.id}"]`)!;
    expect(overlay.querySelector("[data-pill='in-header']")?.textContent).toBe("Affichés à côté de « Paiement »");
    expect(overlay.textContent).not.toContain("Invisible pour vos clients");
    expect(overlay.getAttribute("aria-label")).toContain("logos affichés à côté de « Paiement »");
  });

  it("a greyed block keeps « Invisible » only", async () => {
    const icons = createBlock("payment_icons");
    render(canvas({ blocks: [icons], overlay: { logosInHeader: null, invisible: new Set([icons.id]) } }));
    await frames();
    const overlay = document.querySelector(`[data-overlay-id="${icons.id}"]`)!;
    expect(overlay.querySelector("[data-pill='in-header']")).toBeNull();
    expect(overlay.textContent).toContain("Invisible pour vos clients");
  });
});

describe("express row: only wallets on screen are reported", () => {
  it("a wallet resolved while still off screen (sr-only) is not reported", async () => {
    whop.buttons.clear();
    const shown = vi.fn();
    render(
      h(ExpressCheckout, {
        prepared: { configId: "cfg", environment: "sandbox" },
        theme: { language: "fr" } as ComponentProps<typeof ExpressCheckout>["theme"],
        labels: LABELS.fr,
        returnUrl: "https://x.test/merci",
        email: "",
        onPaid: () => {},
        walletMethods: ["apple-pay", "google-pay"],
        onWalletsShown: shown,
      }),
    );
    expect(shown).toHaveBeenLastCalledWith([]);
    // Google Pay answers first, while Apple Pay (the one visible cell) still resolves: its button is sr-only.
    await act(async () => whop.buttons.get("google-pay")!.onExpressMethodResolved!({ rendered: "google-pay" }));
    expect(shown).toHaveBeenLastCalledWith([]);
    // Apple Pay unavailable: Google Pay's button now shows, and only then is it reported.
    await act(async () => whop.buttons.get("apple-pay")!.onExpressMethodResolved!({ rendered: "none" }));
    expect(shown).toHaveBeenLastCalledWith(["google-pay"]);
  });

  it("the visible cell's wallet is reported as soon as it renders", async () => {
    whop.buttons.clear();
    const shown = vi.fn();
    render(
      h(ExpressCheckout, {
        prepared: { configId: "cfg", environment: "sandbox" },
        theme: { language: "fr" } as ComponentProps<typeof ExpressCheckout>["theme"],
        labels: LABELS.fr,
        returnUrl: "https://x.test/merci",
        email: "",
        onPaid: () => {},
        walletMethods: ["apple-pay", "google-pay"],
        onWalletsShown: shown,
      }),
    );
    await act(async () => whop.buttons.get("apple-pay")!.onExpressMethodResolved!({ rendered: "apple-pay" }));
    expect(shown).toHaveBeenLastCalledWith(["apple-pay"]);
    await act(async () => whop.buttons.get("google-pay")!.onExpressMethodResolved!({ rendered: "google-pay" }));
    expect(shown).toHaveBeenLastCalledWith(["apple-pay", "google-pay"]);
  });
});
