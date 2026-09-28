"use client";

import { useEffect, useState } from "react";

/** `optional`: only listed once an element with this id exists (card mounted by another feature). */
export type Section = { id: string; label: string; optional?: boolean };

/**
 * In-page navigation for long settings pages: a sticky list of anchors with scroll-spy on
 * desktop, a compact select on phones. Sections missing from the page are skipped.
 */
export function SectionNav({ sections, label = "Sections" }: { sections: Section[]; label?: string }) {
  const [items, setItems] = useState(() => sections.filter((s) => !s.optional));
  const [current, setCurrent] = useState(sections[0]?.id);

  useEffect(() => {
    const present = sections.filter((s) => document.getElementById(s.id));
    const els = present.map((s) => document.getElementById(s.id)!);
    if (!els.length) return;
    // The active section is the last one whose top went past ~35% of the viewport.
    const update = () => {
      const line = window.innerHeight * 0.35;
      let active = present[0].id;
      for (const el of els) if (el.getBoundingClientRect().top <= line) active = el.id;
      // At the very bottom, the last section wins even if it is short.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) active = present[present.length - 1].id;
      setCurrent(active);
    };
    // Optional sections (mounted by other features) only show once they exist on the page.
    const raf = requestAnimationFrame(() => {
      setItems(present);
      update();
    });
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [sections]);

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    history.replaceState(null, "", `#${id}`);
    setCurrent(id);
  };

  return (
    <>
      {/* Phones / tablets: one select, sticky under the top bar. */}
      <div className="sticky top-[61px] z-10 -mx-4 mb-4 border-b border-zinc-200/70 bg-[#f7f8fa] px-4 py-2 md:top-0 lg:hidden">
        <label htmlFor="section-nav-select" className="sr-only">
          Aller à la section
        </label>
        <select
          id="section-nav-select"
          value={current}
          onChange={(e) => go(e.target.value)}
          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow-[0_1px_1px_rgba(16,24,40,.04)] outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10"
        >
          {items.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop: sticky anchor list. */}
      <nav aria-label={label} className="sticky top-10 hidden self-start lg:block">
        <ul className="space-y-0.5 border-l border-zinc-200">
          {items.map((s) => {
            const on = s.id === current;
            return (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  aria-current={on ? "location" : undefined}
                  onClick={(e) => {
                    e.preventDefault();
                    go(s.id);
                  }}
                  className={`-ml-px flex min-h-8 items-center border-l-2 py-1 pr-2 pl-3.5 text-[13px] transition ${
                    on ? "border-indigo-600 font-medium text-zinc-900" : "border-transparent text-zinc-600 hover:border-zinc-300 hover:text-zinc-900"
                  }`}
                >
                  {s.label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
