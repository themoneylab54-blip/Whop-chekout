/*
 * What the payment panel (React) and the early start (an inline script, see inlineEarlyWhop) share
 * about Whop's card form: the classes of the boxes around its frame, and how long it may take to say
 * "ready". The frame started before the page runs is shown exactly as the panel then shows it. A
 * plain module (no React, no "use client"): the server page reads it to write the inline script.
 */

/**
 * How long Whop's frame may take to say "ready" (from its mount) with its footer clipped: past it,
 * the screen in the frame may be another of Whop's (an expired checkout's error) and is shown whole,
 * for good (no second move when a late "ready" comes). Whop's form says "ready" 4 to 5 s after its
 * mount on a fast connection (1 to 3 s after drawing itself).
 */
export const WHOP_READY_GRACE_MS = 30_000;

/** WhopFooterClip's clipping box (globals.css: it clips, never scrolls). */
export const WHOP_CLIP_CLASS = "wc-whop-clip";
/** WhopFooterClip's inner box: its own block formatting context, Whop's frame pulled up by the clip under it. */
export const WHOP_CLIP_FRAME_CLASS = "flow-root [&_iframe]:block [&_iframe]:mb-[calc(-1*var(--wc-whop-clip))]";
/** The payment panel's spinner over Whop's form while it loads: its box, and the spinning ring. */
export const PANEL_SPINNER_CLASS = "pointer-events-none absolute inset-0 flex items-start justify-end p-3";
export const PANEL_SPINNER_RING_CLASS = "h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-r-transparent";
