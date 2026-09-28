"use client";

import { useEffect } from "react";

/** Event the ⌘K palette sends after navigating to a page / section (detail: the target href). */
export const SECTION_FOCUS_EVENT = "dashboard:section-focus";

/** Heading to focus for a section id (its first heading), else the page title. */
function target(hash: string): HTMLElement | null {
  const section = hash ? document.getElementById(decodeURIComponent(hash)) : null;
  if (hash && !section) return null;
  const root = section ?? document.getElementById("contenu");
  if (!root) return null;
  if (/^H[1-6]$/.test(root.tagName)) return root;
  return root.querySelector<HTMLElement>(section ? "[data-section-heading], h1, h2, h3" : "h1");
}

function focusHeading(el: HTMLElement) {
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.classList.add("outline-none");
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "start" });
}

/**
 * Keyboard focus after a ⌘K jump: the section's heading (or the page title), so the next Tab
 * continues from there instead of from the top of the page. Waits for the new page to render.
 */
export function HashFocus() {
  useEffect(() => {
    let raf = 0;
    const onJump = (e: Event) => {
      const href = (e as CustomEvent<string>).detail ?? "";
      const url = new URL(href, location.href);
      const hash = url.hash.slice(1);
      cancelAnimationFrame(raf);
      const started = performance.now();
      const tick = () => {
        // The new page must be there (same path) and the section rendered.
        const el = location.pathname === url.pathname ? target(hash) : null;
        if (el) return focusHeading(el);
        if (performance.now() - started < 5000) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener(SECTION_FOCUS_EVENT, onJump);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener(SECTION_FOCUS_EVENT, onJump);
    };
  }, []);
  return null;
}
