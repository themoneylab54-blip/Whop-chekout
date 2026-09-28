"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The ?ok / ?error banner shown after a server action redirects back. It takes focus when it
 * appears (tabIndex -1, scrolled into view) so keyboard and screen-reader users land on the
 * outcome instead of the top of the page; an error is announced as an alert.
 */
export function FlashBox({ tone, message, className, children }: { tone: "ok" | "error"; message: string; className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [message, tone]);
  return (
    <div ref={ref} tabIndex={-1} role={tone === "error" ? "alert" : "status"} className={`${className} scroll-mt-20 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500`}>
      {children}
    </div>
  );
}
