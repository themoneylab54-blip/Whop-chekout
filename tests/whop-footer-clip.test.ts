// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WhopFooterClip } from "@/components/checkout/WhopFooterClip";
import { WHOP_READY_GRACE_MS } from "@/components/checkout/whopFrame";
import { WHOP_FOOTER, whopFooterFit, whopFooterFitRuns, type WhopFooterRun } from "@/components/checkout/whopFooterFit";

/*
 * The box around Whop's form: on, it follows its own width (ResizeObserver) and clips the footer's
 * height off the frame's bottom (narrowing the frame near a wrap point), in a box that clips and never
 * stays scrolled; the language is the frame's own (the one it opened in), and the clip applies only
 * while it is the one the server checked Whop's form in; off, or a language never measured or
 * checked, the frame is left as Whop draws it; a frame that never says "ready" is given up for good
 * after the grace period (one move at most), per frame load. The fits as runs of widths (for the
 * page's HTML): read back, whopFooterFit's own answer at every whole width up to 4000 px, in every
 * measured language; sorted, apart, each as long as it goes; none for a language never measured.
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
    render(h(WhopFooterClip, { on: true, lang: "fr", checkedLang: "fr", ready: false, children: frame() }));
    expect(box().getAttribute("data-clip")).toBe("86");
    expect(box().className).toBe("wc-whop-clip");
    expect(inner().style.getPropertyValue("--wc-whop-clip")).toBe("86px");
    expect(["0", "0px"]).toContain(inner().style.paddingInline);
    // Wider (rotation): the footer holds on one line.
    resize(470);
    expect(inner().style.getPropertyValue("--wc-whop-clip")).toBe("55px");
  });

  it("near a wrap point the frame is narrowed a little (Spanish on a 340 px frame)", () => {
    render(h(WhopFooterClip, { on: true, lang: "es", checkedLang: "es", ready: false, children: frame() }));
    expect(inner().style.paddingInline).toBe("8px");
    expect(inner().style.getPropertyValue("--wc-whop-clip")).toBe("86px");
  });

  it("never stays scrolled (Whop centering its frame, the focus on a hidden link): back to the top at once", () => {
    render(h(WhopFooterClip, { on: true, lang: "fr", checkedLang: "fr", ready: false, children: frame() }));
    box().scrollTop = 43;
    fireEvent.scroll(box());
    expect(box().scrollTop).toBe(0);
  });

  it("the frame's own language: after a language switch on the page, clipped only while the server's check is the frame's language", () => {
    const { rerender } = render(h(WhopFooterClip, { on: true, lang: "en", checkedLang: "en", ready: false, children: frame() }));
    expect(box().getAttribute("data-clip")).toBe("55");
    // The page now in French, Whop's form checked in French: the frame still shows English (Whop
    // doesn't reload it), never clipped by a French check.
    rerender(h(WhopFooterClip, { on: true, lang: "fr", checkedLang: "fr", ready: false, children: frame() }));
    expect(box().getAttribute("data-clip")).toBeNull();
    // Back in English: the English check again.
    rerender(h(WhopFooterClip, { on: true, lang: "en", checkedLang: "en", ready: false, children: frame() }));
    expect(box().getAttribute("data-clip")).toBe("55");
    // French not checked (yet): never clipped either.
    rerender(h(WhopFooterClip, { on: true, lang: "fr", checkedLang: null, ready: false, children: frame() }));
    expect(box().getAttribute("data-clip")).toBeNull();
  });

  it("off (the PayPal-only checkout, Whop's address form), or a language never measured: Whop's form as is", () => {
    const { rerender } = render(h(WhopFooterClip, { on: true, lang: "fr", checkedLang: "fr", ready: false, children: frame() }));
    expect(box().getAttribute("data-clip")).toBe("86");
    rerender(h(WhopFooterClip, { on: false, lang: "fr", checkedLang: "fr", ready: false, children: frame() }));
    expect(box().getAttribute("data-clip")).toBeNull();
    expect(box().className).toBe("");
    expect(inner().style.getPropertyValue("--wc-whop-clip")).toBe("");
    expect(inner().style.paddingInline).toBe("");
    cleanup();
    render(h(WhopFooterClip, { on: true, lang: "pt", checkedLang: "pt", ready: false, children: frame() }));
    expect(box().getAttribute("data-clip")).toBeNull();
  });

  it("from the frame's mount; kept once it said ready; given up for good after the grace without it (a late ready changes nothing); a new frame starts afresh", async () => {
    vi.useFakeTimers();
    try {
      const view = (ready: boolean) => h(WhopFooterClip, { on: true, lang: "fr", checkedLang: "fr", ready, children: frame() });
      const { rerender, unmount } = render(view(false));
      expect(box().getAttribute("data-clip")).toBe("86");
      rerender(view(true));
      // Whop's "disabled" (an incomplete form) after its ready: kept.
      rerender(view(false));
      await act(async () => void (await vi.advanceTimersByTimeAsync(WHOP_READY_GRACE_MS * 2)));
      expect(box().getAttribute("data-clip")).toBe("86");
      unmount();
      // A frame that never says ready: given up at the end of the grace, then for good.
      const slow = render(view(false));
      await act(async () => void (await vi.advanceTimersByTimeAsync(WHOP_READY_GRACE_MS - 10)));
      expect(box().getAttribute("data-clip")).toBe("86");
      await act(async () => void (await vi.advanceTimersByTimeAsync(20)));
      expect(box().getAttribute("data-clip")).toBeNull();
      slow.rerender(view(true));
      expect(box().getAttribute("data-clip")).toBeNull();
      slow.unmount();
      // The next frame (another checkout, or the same one reloaded): from its own mount again.
      render(view(false));
      expect(box().getAttribute("data-clip")).toBe("86");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("whopFooterFitRuns: the fit at every width, for the page's HTML", () => {
  const langs = Object.keys(WHOP_FOOTER);
  /** A width's fit read from the runs, as the early start's inline script reads them (its fitAt). */
  const fitFromRuns = (runs: readonly WhopFooterRun[], width: number) => {
    const run = runs.find(([from, to]) => width >= from && width <= to);
    return run ? { inset: run[2], clip: run[3] } : null;
  };

  it("read back as the inline script reads them: whopFooterFit's own answer at every whole width up to 4000 px, in every measured language", () => {
    for (const lang of langs) {
      const runs = whopFooterFitRuns(lang);
      for (let w = 1; w <= 4000; w++) expect(fitFromRuns(runs, w), `${lang} ${w}`).toEqual(whopFooterFit(lang, w));
    }
  });

  it("sorted, apart, each as long as it goes (two touching runs never share a fit); worked out once per language and width bound", () => {
    for (const lang of langs) {
      const runs = whopFooterFitRuns(lang);
      expect(runs.length, lang).toBeGreaterThan(0);
      runs.forEach(([from, to, inset, clip], i) => {
        expect(from, `${lang} run ${i}`).toBeLessThanOrEqual(to);
        const next = runs[i + 1];
        if (!next) return;
        expect(next[0], `${lang} run ${i + 1}`).toBeGreaterThan(to);
        if (next[0] === to + 1) expect([next[2], next[3]], `${lang} run ${i + 1}`).not.toEqual([inset, clip]);
      });
      expect(runs.at(-1)?.[1], lang).toBe(4000);
      expect(whopFooterFitRuns(lang)).toBe(runs);
    }
    // Another bound, other runs (cut there).
    expect(whopFooterFitRuns("fr", 400).at(-1)).toEqual([369, 400, 0, 55]);
    expect(whopFooterFitRuns("fr").at(-1)).toEqual([369, 4000, 0, 55]);
  });

  it("a language never measured: no runs, no fit", () => {
    expect(whopFooterFitRuns("pt")).toEqual([]);
    expect(whopFooterFitRuns("constructor")).toEqual([]);
    expect(fitFromRuns(whopFooterFitRuns("pt"), 340)).toBeNull();
  });
});
