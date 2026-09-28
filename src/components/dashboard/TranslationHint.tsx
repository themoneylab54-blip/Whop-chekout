"use client";

import type { MouseEvent } from "react";
import { Languages } from "lucide-react";

/**
 * Amber "FR uniquement · 0/5 langues" nudge on a dashboard record. Clicking it opens the
 * record's "Traductions" editor (every enclosing disclosure included) and focuses it.
 * Inside a <summary>, render `as="span"`: the summary stays the keyboard control.
 */
export function TranslationHint({ text, as = "button" }: { text: string; as?: "button" | "span" }) {
  const open = (e: MouseEvent<HTMLElement>) => {
    const scope = e.currentTarget.closest<HTMLElement>("[data-translations-scope]");
    const editor = scope?.querySelector<HTMLDetailsElement>("details[data-record-translations]");
    if (!scope || !editor) return;
    e.preventDefault();
    e.stopPropagation();
    for (let d: HTMLElement | null = editor; d && scope.contains(d); d = d.parentElement?.closest<HTMLElement>("details") ?? null) {
      if (d instanceof HTMLDetailsElement) d.open = true;
      if (d === scope) break;
    }
    requestAnimationFrame(() => {
      editor.scrollIntoView({ block: "center", behavior: "smooth" });
      editor.querySelector<HTMLElement>("summary")?.focus({ preventScroll: true });
    });
  };
  const cls =
    "inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-900 ring-1 ring-amber-600/25 ring-inset";
  const body = (
    <>
      <Languages className="h-3 w-3" aria-hidden /> {text}
    </>
  );
  if (as === "span")
    return (
      <span className={`${cls} cursor-pointer`} onClick={open} title="Ajouter les traductions">
        {body}
      </span>
    );
  return (
    <button
      type="button"
      onClick={open}
      title="Ouvrir les traductions"
      className={`${cls} cursor-pointer hover:bg-amber-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 focus-visible:outline-solid`}
    >
      {body}
    </button>
  );
}
