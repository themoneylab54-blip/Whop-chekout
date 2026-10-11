"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { whopFooterFit } from "./whopFooterFit";

/**
 * How long Whop's frame may take to say "ready" (from its mount) with its footer clipped: past it,
 * the screen in the frame may be another of Whop's (an expired checkout's error) and is shown whole,
 * for good (no second move when a late "ready" comes). Whop's form says "ready" 4 to 5 s after its
 * mount on a fast connection (1 to 3 s after drawing itself).
 */
export const WHOP_READY_GRACE_MS = 30_000;

/**
 * Whop's form without its « Propulsé par Whop » footer (see whopFooterFit): the frame narrowed only
 * when its width sits too close to a wrap point of the footer, and the frame's bottom clipped by the
 * footer's height, following the box's width (rotation, window resize). `on` false, a language or a
 * width without a sure answer: the form as Whop draws it.
 *
 * The box clips (`overflow: clip`, globals.css), it never scrolls: Whop asks its host page to center
 * the frame (scrollIntoView) and the keyboard focus can land on the footer's hidden links — a
 * scrollable box (`overflow: hidden`) would then slide the form up, hiding its top and showing the
 * footer. iOS Safari < 16 has no `clip`: `hidden` there, and any scroll is undone at once.
 *
 * The language is the frame's own: Whop's frame keeps the one it was opened in (a language switch on
 * the page doesn't reload it), and this box remounts with it. `checkedLang` is the language the server
 * checked Whop's form in: the clip applies only while the frame shows that one.
 *
 * From the frame's mount (waiting for Whop's "ready", 1 to 3 s after it draws its form, would show
 * the footer at each load, then move the page), kept once `ready` was seen; given up for good if it
 * isn't within WHOP_READY_GRACE_MS. Per frame load: this box remounts with each checkout.
 */
export function WhopFooterClip({ on, lang: langProp, checkedLang, ready, children }: { on: boolean; lang: string; checkedLang: string | null; ready: boolean; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [lang] = useState(langProp);
  const [wasReady, setWasReady] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  if (ready && !wasReady && !gaveUp) setWasReady(true);
  useEffect(() => {
    if (wasReady || gaveUp) return;
    const t = setTimeout(() => setGaveUp(true), WHOP_READY_GRACE_MS);
    return () => clearTimeout(t);
  }, [wasReady, gaveUp]);
  const active = on && checkedLang === lang && !gaveUp;
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!active || !el) return;
    // Whole pixels (the fit keeps clear of wrap points by several px anyway); measured before the first paint.
    setWidth(el.offsetWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w != null) setWidth(Math.floor(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  const fit = active && width > 0 ? whopFooterFit(lang, width) : null;
  return (
    <div
      ref={box}
      data-testid="wc-whop-clip"
      data-clip={fit ? fit.clip : undefined}
      className={fit ? "wc-whop-clip" : undefined}
      onScroll={
        fit
          ? (e) => {
              // `hidden` (iOS Safari < 16) can be scrolled by code: back to the top at once.
              e.currentTarget.scrollTop = 0;
              e.currentTarget.scrollLeft = 0;
            }
          : undefined
      }
    >
      {/* Its own block formatting context: the frame's negative bottom margin shortens this box (never collapses out of it). */}
      <div
        className={fit ? "flow-root [&_iframe]:block [&_iframe]:mb-[calc(-1*var(--wc-whop-clip))]" : undefined}
        style={fit ? ({ paddingInline: fit.inset, "--wc-whop-clip": `${fit.clip}px` } as CSSProperties) : undefined}
      >
        {children}
      </div>
    </div>
  );
}
