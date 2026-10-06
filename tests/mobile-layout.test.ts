// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, render } from "@testing-library/react";

/*
 * Phones: the checkout and thank-you pages are never wider than the screen, and the header banner
 * shows whole on every width (its phone image when there is one, its box sized before it loads).
 *
 * Root cause of the iPhone overflow: the page grid had no column template under @3xl, so its one
 * `auto` track grew to its widest child's min-content. Full-bleed blocks (`.wc-bleed`: the countdown,
 * full-width images) were 100cqw wide with calc(50% - 50cqw) margins; WebKit leaves those percentage
 * margins out of the min-content size, so the track became screen + side padding, and every input,
 * the timeline, the benefits and the Pay button were laid out wider than the screen and clipped.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", () => ({
  WhopCheckoutEmbed: () => null,
  WhopExpressCheckoutButton: () => null,
  useCheckoutEmbedControls: () => ({ current: null }),
}));

const { createBlock, defaultCheckoutLayout, defaultTheme, loadTheme, themeSchema } = await import("@/lib/layout");
const { CheckoutView, StoreHeader, bannerBox, BANNER_PHONE_MEDIA, BANNER_MAX_HEIGHT } = await import("@/components/checkout/CheckoutView");
const { ContentBlock } = await import("@/components/checkout/blocks");
const { labelsFor } = await import("@/components/checkout/i18n");
const { SAMPLE_LINES } = await import("@/lib/sample");

type Theme = import("@/lib/layout").Theme;
type ContentContext = import("@/components/checkout/blocks").ContentContext;

const root = path.resolve(__dirname, "..");
const read = (f: string) => readFileSync(path.join(root, f), "utf8");
const theme = (o: Partial<Theme> = {}): Theme => loadTheme({ ...defaultTheme("Boutique"), ...o }, "Boutique");
const ctx: ContentContext = {
  labels: labelsFor("fr"),
  lang: "fr",
  lowestInventory: null,
  preview: false,
  subtotalCents: 0,
  freeShippingThresholdCents: null,
  money: (c: number) => String(c),
  note: "",
  setNote: () => {},
};

afterEach(cleanup);

describe("checkout page: one column never wider than the phone", () => {
  it("the page grid has an explicit minmax(0, 1fr) track and its columns can shrink", () => {
    const props: ComponentProps<typeof CheckoutView> = {
      theme: theme(),
      layout: { ...defaultCheckoutLayout(), blocks: [createBlock("countdown"), ...defaultCheckoutLayout().blocks] },
      currency: "EUR",
      lines: SAMPLE_LINES,
      rates: [],
      addOns: [],
      hasDiscounts: false,
      mode: { kind: "preview" },
      initialCountry: "FR",
    };
    const { container } = render(h(CheckoutView, props));
    const main = container.querySelector("main")!;
    const grid = main.parentElement!;
    expect(grid.className).toMatch(/(^|\s)grid(\s|$)/);
    // Not an `auto` track sized by its widest child (a full-bleed block + the side padding).
    expect(grid.className).toContain("grid-cols-[minmax(0,1fr)]");
    expect(main.className).toContain("min-w-0");
    expect(container.querySelector("aside")!.className).toContain("min-w-0");
    expect(main.querySelector(".wc-bleed-col")!.className).toContain("min-w-0");
    // The page root still clips anything left over (no sideways scroll).
    expect(container.querySelector(".overflow-x-clip")).toBeTruthy();
  });

  it("thank-you page: its grids have explicit tracks too", () => {
    const src = read("src/components/checkout/ThankYouView.tsx");
    expect(src).toContain("grid grid-cols-1 gap-5 p-5 text-sm sm:grid-cols-2");
    expect(src).toMatch(/className="wc-checkout @container\/wc-page min-h-full overflow-x-clip"/);
  });

  it("globals.css: wrapping safety net and the iOS < 16 fallback for overflow: clip (phones only)", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.wc-checkout \{\s*overflow-wrap: break-word;/);
    // In the base layer, so the image block's max-w-[…] utilities still cap it (unlayered would win).
    expect(css).toMatch(/@layer base \{\s*:where\(\.wc-checkout\) :where\(img, video, iframe, svg\) \{\s*max-width: 100%;/);
    expect(css).toMatch(/@supports not \(overflow: clip\) \{\s*@media \(max-width: 767\.98px\)/);
  });
});

describe("blocks that overflowed on small phones can shrink and wrap", () => {
  it("countdown band: wraps, its label can shrink, the timer stays whole", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 6, 12) });
    try {
      const block = createBlock("countdown");
      (block.props as { endsAt: string }).endsAt = new Date(Date.UTC(2026, 9, 6, 22, 2, 7)).toISOString();
      const { container } = render(h(ContentBlock, { block, ctx }));
      act(() => vi.advanceTimersByTime(50)); // first frame: the clock starts
      const band = container.querySelector("[data-countdown]")!;
      expect(band.className).toContain("wc-bleed");
      expect(band.className).toContain("flex-wrap");
      expect(band.className).toContain("min-w-0");
      const timer = container.querySelector("[role=timer]")!;
      expect(timer.className).toContain("whitespace-nowrap");
      expect(timer.parentElement!.className).toContain("shrink-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivery estimate: the line wraps, the timeline steps can shrink", () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 6, 12) });
    const { container } = render(h(ContentBlock, { block: createBlock("delivery_estimate"), ctx }));
    act(() => vi.advanceTimersByTime(50)); // dates are drawn after mount (no hydration mismatch)
    vi.useRealTimers();
    expect(container.querySelector("p")!.className).toContain("flex-wrap");
    const steps = container.querySelectorAll("ol > li");
    expect(steps).toHaveLength(3);
    for (const li of steps) expect(li.className).toContain("min-w-0");
    // No orphan colon on its own line.
    expect(container.textContent).toContain("Livraison estimée :");
  });

  it("benefits: minmax(0, 1fr) columns of shrinkable cards; secure badge text can shrink", () => {
    const html = renderToStaticMarkup(h(ContentBlock, { block: createBlock("benefits"), ctx }));
    expect(html).toContain("grid-template-columns:repeat(3, minmax(0, 1fr))");
    expect(html.match(/class="flex min-w-0 flex-col items-center/g)).toHaveLength(3);
    const badge = renderToStaticMarkup(h(ContentBlock, { block: createBlock("secure_badge"), ctx }));
    expect(badge).toContain('<div class="min-w-0">');
  });
});

describe("header banner", () => {
  const banner = (o: Partial<Theme> = {}) => theme({ headerMode: "banner", bannerUrl: "https://cdn.ex.com/wide.png", ...o });

  it("schema: optional phone image and ratio (portrait allowed), older themes unchanged", () => {
    const t = themeSchema.parse({});
    expect(t.bannerUrlMobile).toBe("");
    expect(t.bannerRatioMobile).toBeUndefined();
    expect(themeSchema.safeParse({ bannerUrlMobile: "http://x.com/a.png" }).data?.bannerUrlMobile).toBe("https://x.com/a.png");
    expect(themeSchema.safeParse({ bannerUrlMobile: "/api/public/media/abcdefghij12" }).success).toBe(true);
    expect(themeSchema.safeParse({ bannerUrlMobile: "javascript:alert(1)" }).success).toBe(false);
    expect(themeSchema.safeParse({ bannerRatioMobile: 0.75 }).success).toBe(true);
    expect(themeSchema.safeParse({ bannerRatioMobile: 0.2 }).success).toBe(false);
  });

  it("bannerBox: wide pages keep the fixed height or capped proportions; phones always get the image's proportions", () => {
    // Fixed height on wide pages; phones still in the 6:1 image's own shape (was: the 120 px band, cropped).
    expect(bannerBox(banner({ bannerAuto: false, bannerHeight: 120, bannerRatio: 6 }))).toEqual({ "--wc-banner-h": "120px", "--wc-banner-ar-m": "6" });
    expect(bannerBox(banner({ bannerAuto: true, bannerRatio: 6 }))).toEqual({ "--wc-banner-ar": "6", "--wc-banner-max": BANNER_MAX_HEIGHT, "--wc-banner-ar-m": "6" });
    // Proportions not measured yet: fixed height on wide pages, the image's own height on phones.
    expect(bannerBox(banner({ bannerAuto: true, bannerRatio: undefined, bannerHeight: 100 }))).toEqual({ "--wc-banner-h": "100px" });
    // A phone image: its own ratio on phones (none known: its own height once loaded).
    expect(bannerBox(banner({ bannerRatio: 6, bannerUrlMobile: "https://cdn.ex.com/m.png", bannerRatioMobile: 2 }))["--wc-banner-ar-m" as never]).toBe("2");
    expect(bannerBox(banner({ bannerRatio: 6, bannerUrlMobile: "https://cdn.ex.com/m.png" }))).not.toHaveProperty("--wc-banner-ar-m");
  });

  it("globals.css: phones size the box by the shown image's ratio and drop the fixed height", () => {
    const css = read("src/app/globals.css");
    expect(css).toMatch(/\.wc-banner \{\s*height: var\(--wc-banner-h, auto\);\s*aspect-ratio: var\(--wc-banner-ar, auto\);\s*max-height: var\(--wc-banner-max, none\);/);
    const phone = css.slice(css.indexOf("@container wc-page (max-width: 639.98px)"));
    expect(phone).toMatch(/\.wc-banner \{\s*height: auto;\s*aspect-ratio: var\(--wc-banner-ar-m, auto\);\s*max-height: min\(56cqw, 40svh\);/);
    expect(phone).toMatch(/\.wc-banner \.wc-banner-d \{\s*display: none;/);
    // No saved phone ratio: a banner-shaped space until the image loads (its own ratio after).
    expect(phone).toMatch(/\.wc-banner img \{\s*aspect-ratio: auto 6 \/ 1;/);
    expect(BANNER_PHONE_MEDIA).toBe("(max-width: 639.98px)");
  });

  it("globals.css: full-bleed blocks keep width auto (margins ignored: the column's width, never wider)", () => {
    const css = read("src/app/globals.css");
    const phone = css.slice(css.indexOf("@container wc-page (max-width: 639.98px)"));
    expect(phone).toMatch(/\.wc-bleed,\s*\.wc-boxed:has\(\.wc-bleed\) \{\s*width: auto;\s*max-width: none;\s*margin-inline: calc\(50% - 50cqw\);/);
  });

  it("globals.css: full-bleed images get an explicit width (auto = their natural pixel size), centered on the column", () => {
    const css = read("src/app/globals.css");
    const phone = css.slice(css.indexOf("@container wc-page (max-width: 639.98px)"));
    // Replaced elements only: divs keep width auto (the WebKit min-content fix above).
    expect(phone).toMatch(
      /:is\(img, video, iframe, picture\)\.wc-bleed\.wc-bleed \{\s*width: var\(--wc-bleed-w, 100cqw\);\s*margin-inline: calc\(\(100% - var\(--wc-bleed-w, 100cqw\)\) \/ 2\);/,
    );
    expect(phone).toMatch(/\.wc-bleed-lg \{\s*--wc-bleed-w: min\(100cqw, 420px\);/);
    // Comes after the generic rule and outweighs it: that one is compiled to
    // :is(.wc-bleed, .wc-boxed:has(.wc-bleed)), worth two classes (0,2,0); this one (0,2,1).
    expect(phone.indexOf(":is(img, video, iframe, picture).wc-bleed")).toBeGreaterThan(phone.indexOf(".wc-boxed:has(.wc-bleed)"));
  });

  it("image block: full and large sizes bleed, large is capped (wc-bleed-lg), small sizes stay inset", () => {
    const img = (size: string) => {
      const block = createBlock("image");
      Object.assign(block.props, { url: "https://cdn.ex.com/i.png", size });
      return renderToStaticMarkup(h(ContentBlock, { block, ctx }));
    };
    expect(img("full")).toMatch(/<img[^>]*class="wc-bleed w-full /);
    expect(img("lg")).toMatch(/<img[^>]*class="wc-bleed wc-bleed-lg max-w-\[420px\] /);
    expect(img("md")).not.toContain("wc-bleed");
    expect(img("sm")).not.toContain("wc-bleed");
  });

  it("globals.css: no saved phone ratio, a tall banner image is capped itself and centered (not cut at the bottom)", () => {
    const css = read("src/app/globals.css");
    const phone = css.slice(css.indexOf("@container wc-page (max-width: 639.98px)"));
    expect(phone).toMatch(/\.wc-banner:not\(\[style\*="--wc-banner-ar-m"\]\) img \{\s*max-height: min\(56cqw, 40svh\);\s*object-position: center;/);
    // bannerBox writes the variable only when the ratio is known, so the selector tells them apart.
    expect(renderToStaticMarkup(h(StoreHeader, { theme: banner({ bannerRatio: undefined }) }))).not.toContain("--wc-banner-ar-m");
    expect(renderToStaticMarkup(h(StoreHeader, { theme: banner({ bannerRatio: 6 }) }))).toContain("--wc-banner-ar-m:6");
  });

  it("one image: full width, fit from the theme, high priority, box sized before it loads", () => {
    const html = renderToStaticMarkup(h(StoreHeader, { theme: banner({ bannerRatio: 6, bannerFit: "contain" }) }));
    expect(html).toContain('data-header="banner"');
    expect(html).toMatch(/<div class="wc-banner relative w-full overflow-hidden" style="--wc-banner-h:120px;--wc-banner-ar-m:6">/);
    expect(html).toMatch(/<img[^>]*class="block h-full w-full object-contain"/);
    expect(html).toContain('fetchPriority="high"');
    expect(html).not.toContain("<picture");
    expect(renderToStaticMarkup(h(StoreHeader, { theme: banner({ bannerFit: "cover" }) }))).toContain("object-cover");
  });

  it("buyers with a phone image: a <picture> (the browser downloads only the image for its screen)", () => {
    const html = renderToStaticMarkup(h(StoreHeader, { theme: banner({ bannerUrlMobile: "https://cdn.ex.com/m.png", bannerRatioMobile: 2 }) }));
    expect(html).toContain('<picture class="block h-full w-full"><source media="(max-width: 639.98px)" srcSet="https://cdn.ex.com/m.png"/>');
    expect(html).toContain('src="https://cdn.ex.com/wide.png"');
    expect(html.match(/<img/g)).toHaveLength(1);
    // React preloads no image inside a <picture> (a phone would fetch the desktop one too).
    expect(html).not.toContain("preload");
  });

  it("builder canvas with a phone image: both images, the frame's width shows one", () => {
    const html = renderToStaticMarkup(h(StoreHeader, { theme: banner({ bannerUrlMobile: "https://cdn.ex.com/m.png" }), preview: true }));
    expect(html).not.toContain("<picture");
    expect(html).toContain('<img src="https://cdn.ex.com/wide.png" class="wc-banner-d block h-full w-full object-cover"');
    expect(html).toContain('<img src="https://cdn.ex.com/m.png" class="wc-banner-m hidden h-full w-full object-cover"');
    // Lazy, never preloaded: the hidden one isn't fetched for nothing.
    expect(html).not.toContain("preload");
    expect(html).not.toContain("fetchPriority");
    expect(html.match(/loading="lazy"/g)).toHaveLength(2);
  });

  it("the link back to the shop wraps the image", () => {
    const html = renderToStaticMarkup(h(StoreHeader, { theme: banner({ bannerLink: true }), homeUrl: "https://shop.ex.com/" }));
    expect(html).toMatch(/<a href="https:\/\/shop\.ex\.com\/"[^>]*><img/);
  });
});
