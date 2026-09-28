"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

export type AnalyticsTab = { id: string; label: string; href: string };

const STORAGE_KEY = "analytics-tab";

/**
 * Tabs of the Analytics page (one group rendered at a time, `?tab=` in the URL so filters and
 * tab survive reloads and shares). WAI-ARIA tablist: arrow keys / Home / End move between tabs,
 * Enter or Space opens one. Old `#section` links and form redirects without `tab` land on the
 * expected tab.
 */
export function AnalyticsTabs({ tabs, active, explicit }: { tabs: AnalyticsTab[]; active: string; /** The URL carries `tab`. */ explicit: boolean }) {
  const router = useRouter();
  const refs = useRef<(HTMLAnchorElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  // Hidden tabs past either edge: the edge fades out (scrollbar is hidden).
  const [edges, setEdges] = useState({ left: false, right: false });

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const update = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, []);

  // The active tab is always in view (horizontally only: never scrolls the page).
  useEffect(() => {
    const el = listRef.current;
    const tab = refs.current[tabs.findIndex((t) => t.id === active)];
    if (!el || !tab) return;
    const pad = 32;
    if (tab.offsetLeft - pad < el.scrollLeft) el.scrollTo({ left: Math.max(0, tab.offsetLeft - pad) });
    else if (tab.offsetLeft + tab.offsetWidth + pad > el.scrollLeft + el.clientWidth)
      el.scrollTo({ left: tab.offsetLeft + tab.offsetWidth + pad - el.clientWidth });
  }, [active, tabs]);

  useEffect(() => {
    try {
      if (explicit) {
        sessionStorage.setItem(STORAGE_KEY, active);
        return;
      }
      const hash = window.location.hash.slice(1);
      const fromHash = tabs.find((t) => t.id === hash);
      // A server action redirected here (flash message) without the tab: back to the tab the form was on.
      const params = new URLSearchParams(window.location.search);
      const last = params.has("ok") || params.has("error") ? tabs.find((t) => t.id === sessionStorage.getItem(STORAGE_KEY)) : undefined;
      const target = fromHash ?? last;
      if (target && target.id !== active) {
        const url = new URL(target.href, window.location.origin);
        for (const k of ["ok", "error"]) if (params.has(k)) url.searchParams.set(k, params.get(k)!);
        router.replace(`${url.pathname}${url.search}`, { scroll: false });
      } else sessionStorage.setItem(STORAGE_KEY, active);
    } catch {
      /* storage unavailable: plain links still work */
    }
  }, [active, explicit, router, tabs]);

  function onKeyDown(e: React.KeyboardEvent<HTMLAnchorElement>, i: number) {
    const last = tabs.length - 1;
    const next = e.key === "ArrowRight" ? (i === last ? 0 : i + 1) : e.key === "ArrowLeft" ? (i === 0 ? last : i - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next != null) {
      e.preventDefault();
      refs.current[next]?.focus();
    } else if (e.key === " ") {
      e.preventDefault();
      refs.current[i]?.click();
    }
  }

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label="Sections d'Analytics"
      className="relative flex gap-1 overflow-x-auto py-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      style={
        edges.left || edges.right
          ? {
              maskImage: `linear-gradient(to right, ${edges.left ? "transparent 0, #000 32px" : "#000 0"}, ${edges.right ? "#000 calc(100% - 32px), transparent 100%" : "#000 100%"})`,
              WebkitMaskImage: `linear-gradient(to right, ${edges.left ? "transparent 0, #000 32px" : "#000 0"}, ${edges.right ? "#000 calc(100% - 32px), transparent 100%" : "#000 100%"})`,
            }
          : undefined
      }
    >
      {tabs.map((t, i) => {
        const selected = t.id === active;
        return (
          <Link
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            href={t.href}
            scroll={false}
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`inline-flex min-h-9 shrink-0 items-center rounded-lg px-3 text-sm font-medium focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none ${
              selected ? "bg-white text-zinc-900 shadow-sm ring-1 ring-zinc-900/5" : "text-zinc-600 hover:bg-white/70 hover:text-zinc-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </div>
  );
}
