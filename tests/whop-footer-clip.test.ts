// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WhopFooterClip } from "@/components/checkout/WhopFooterClip";

/*
 * The box around Whop's form: on, it follows its own width (ResizeObserver) and clips the footer's
 * height off the frame's bottom (narrowing the frame near a wrap point), in a box that clips and never
 * stays scrolled; the language is the frame's own (the one it opened in), and the clip applies only
 * while it is the one the server checked Whop's form in; off, or a language never measured or
 * checked, the frame is left as Whop draws it.
 */

let observed: ((entries: { contentRect: { width: number } }[]) => void) | null = null;
let width = 340;
beforeEach(() => {
  observed = null;
  width = 340;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: (entries: { contentRect: { width: number } }[]) => void) {
        observed = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => width);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const frame = () => h("iframe", { title: "Whop Embedded Checkout" });
const box = () => screen.getByTestId("wc-whop-clip");
const inner = () => box().firstElementChild as HTMLElement;
const resize = (w: number) => act(() => observed?.([{ contentRect: { width: w } }]));

describe("WhopFooterClip", () => {
  it("on: the footer's height clipped, following the box's width", () => {
    render(h(WhopFooterClip, { on: true, lang: "fr", checkedLang: "fr", children: frame() }));
    expect(box().getAttribute("data-clip")).toBe("86");
    expect(box().className).toBe("wc-whop-clip");
    expect(inner().style.getPropertyValue("--wc-whop-clip")).toBe("86px");
    expect(["0", "0px"]).toContain(inner().style.paddingInline);
    // Wider (rotation): the footer holds on one line.
    resize(470);
    expect(inner().style.getPropertyValue("--wc-whop-clip")).toBe("55px");
  });

  it("near a wrap point the frame is narrowed a little (Spanish on a 340 px frame)", () => {
    render(h(WhopFooterClip, { on: true, lang: "es", checkedLang: "es", children: frame() }));
    expect(inner().style.paddingInline).toBe("8px");
    expect(inner().style.getPropertyValue("--wc-whop-clip")).toBe("86px");
  });

  it("never stays scrolled (Whop centering its frame, the focus on a hidden link): back to the top at once", () => {
    render(h(WhopFooterClip, { on: true, lang: "fr", checkedLang: "fr", children: frame() }));
    box().scrollTop = 43;
    fireEvent.scroll(box());
    expect(box().scrollTop).toBe(0);
  });

  it("the frame's own language: after a language switch on the page, clipped only while the server's check is the frame's language", () => {
    const { rerender } = render(h(WhopFooterClip, { on: true, lang: "en", checkedLang: "en", children: frame() }));
    expect(box().getAttribute("data-clip")).toBe("55");
    // The page now in French, Whop's form checked in French: the frame still shows English (Whop
    // doesn't reload it), never clipped by a French check.
    rerender(h(WhopFooterClip, { on: true, lang: "fr", checkedLang: "fr", children: frame() }));
    expect(box().getAttribute("data-clip")).toBeNull();
    // Back in English: the English check again.
    rerender(h(WhopFooterClip, { on: true, lang: "en", checkedLang: "en", children: frame() }));
    expect(box().getAttribute("data-clip")).toBe("55");
    // French not checked (yet): never clipped either.
    rerender(h(WhopFooterClip, { on: true, lang: "fr", checkedLang: null, children: frame() }));
    expect(box().getAttribute("data-clip")).toBeNull();
  });

  it("off (the PayPal-only checkout, Whop's address form), or a language never measured: Whop's form as is", () => {
    const { rerender } = render(h(WhopFooterClip, { on: true, lang: "fr", checkedLang: "fr", children: frame() }));
    expect(box().getAttribute("data-clip")).toBe("86");
    rerender(h(WhopFooterClip, { on: false, lang: "fr", checkedLang: "fr", children: frame() }));
    expect(box().getAttribute("data-clip")).toBeNull();
    expect(box().className).toBe("");
    expect(inner().style.getPropertyValue("--wc-whop-clip")).toBe("");
    expect(inner().style.paddingInline).toBe("");
    cleanup();
    render(h(WhopFooterClip, { on: true, lang: "pt", checkedLang: "pt", children: frame() }));
    expect(box().getAttribute("data-clip")).toBeNull();
  });
});
