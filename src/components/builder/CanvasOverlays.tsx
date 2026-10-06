"use client";

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { AlertTriangle, ArrowUpRight } from "lucide-react";
import type { Block } from "@/lib/layout";

type Rect = { id: string; top: number; left: number; width: number; height: number };

/** Where a dragged block would land, drawn as a line on the canvas. */
export type DropHint = { id: string; edge: "top" | "bottom" } | null;

/** Inline text editing on the canvas (double-click a block's main text). */
export type InlineEditing = {
  /** Text fields of a block that can be edited in place (matching data-inline-field in the preview). */
  fields: (id: string) => string[];
  /** Current value of a field ("" when the translated default is shown). */
  value: (id: string, field: string) => string;
  /** Multi-line field (Shift+Enter inserts a new line). */
  multiline: (field: string) => boolean;
  commit: (id: string, field: string, value: string) => void;
};

type Editing = { id: string; field: string; initial: string; value: string; box: CSSProperties; multiline: boolean };

/**
 * Transparent click-capture layer drawn over every block of the live preview.
 *
 * The preview renders the real checkout components (inputs, checkboxes, buttons);
 * without this layer a click meant to select a block would tick the order bump or
 * focus a field. Each overlay sits on top of its block, so clicks and keyboard
 * activation only ever select the block.
 */
export function CanvasOverlays({
  rootRef,
  page,
  blocks,
  selected,
  names,
  warnings = {},
  logosInHeader = null,
  onSelect,
  dropHint = null,
  inline,
}: {
  /** Element that contains the rendered preview; overlays are positioned relative to it. */
  rootRef: RefObject<HTMLDivElement | null>;
  page: "checkout" | "thank-you";
  blocks: Block[];
  selected: string | null;
  names: Record<string, string>;
  /** Merchant-only setup warnings per block id, drawn as a badge on the block outline. */
  warnings?: Record<string, string>;
  /** Payment-logos block whose logos show next to the Payment title: « Affichés à côté de « Paiement » » pill. */
  logosInHeader?: string | null;
  onSelect: (id: string) => void;
  dropHint?: DropHint;
  inline?: InlineEditing;
}) {
  const [rects, setRects] = useState<Rect[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);

  /** Opens an editor over the text element of `field` (or the one under the pointer). */
  function startEdit(id: string, point?: { x: number; y: number }) {
    const root = rootRef.current;
    if (!root || !inline) return;
    const allowed = inline.fields(id);
    if (allowed.length === 0) return;
    const blockEl = root.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(id)}"]`);
    if (!blockEl) return;
    const candidates = Array.from(blockEl.querySelectorAll<HTMLElement>("[data-inline-field]")).filter((el) => allowed.includes(el.dataset.inlineField!));
    if (candidates.length === 0) return;
    const hit =
      (point &&
        candidates.find((el) => {
          const r = el.getBoundingClientRect();
          return point.x >= r.left && point.x <= r.right && point.y >= r.top - 4 && point.y <= r.bottom + 4;
        })) ||
      candidates[0];
    const field = hit.dataset.inlineField!;
    const base = root.getBoundingClientRect();
    const r = hit.getBoundingClientRect();
    const cs = getComputedStyle(hit);
    const current = inline.value(id, field);
    // An empty field's placeholder (data-inline-empty, e.g. « Votre texte ici ») is not its text: start blank.
    const shown = hit.hasAttribute("data-inline-empty") ? current.trim() : current || (hit.textContent ?? "").trim();
    closed.current = false;
    setEditing({
      id,
      field,
      initial: shown,
      value: shown,
      multiline: inline.multiline(field),
      box: {
        top: r.top - base.top - 3,
        left: Math.max(0, r.left - base.left - 4),
        width: Math.max(r.width + 8, 160),
        minHeight: r.height + 6,
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight as CSSProperties["fontWeight"],
        fontFamily: cs.fontFamily,
        lineHeight: cs.lineHeight,
        letterSpacing: cs.letterSpacing,
        textAlign: cs.textAlign as CSSProperties["textAlign"],
        textTransform: cs.textTransform as CSSProperties["textTransform"],
      },
    });
  }
  // Enter/Escape close the editor, and the blur that may follow must not save twice.
  const closed = useRef(false);
  function finish(save: boolean) {
    if (!editing || closed.current) return;
    closed.current = true;
    setEditing(null);
    if (save && inline && editing.value.trim() !== editing.initial.trim()) inline.commit(editing.id, editing.field, editing.value.trim());
  }

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    const observed = new Set<Element>();
    const ro = new ResizeObserver(() => schedule());

    function blockElements(): { id: string; el: HTMLElement }[] {
      if (!root) return [];
      return Array.from(root.querySelectorAll<HTMLElement>("[data-block-id]")).map((el) => ({ id: el.dataset.blockId!, el }));
    }

    function measure() {
      frame = 0;
      if (!root) return;
      const base = root.getBoundingClientRect();
      const next: Rect[] = [];
      for (const { id, el } of blockElements()) {
        if (!observed.has(el)) {
          observed.add(el);
          ro.observe(el);
        }
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        next.push({ id, top: r.top - base.top, left: r.left - base.left, width: r.width, height: r.height });
      }
      setRects((prev) =>
        prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.top === next[i].top && p.left === next[i].left && p.width === next[i].width && p.height === next[i].height)
          ? prev
          : next,
      );
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure);
    }

    ro.observe(root);
    const mo = new MutationObserver(schedule);
    mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "open"] });
    window.addEventListener("resize", schedule);
    // Images and web fonts change block heights after the first paint.
    root.addEventListener("load", schedule, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      mo.disconnect();
      window.removeEventListener("resize", schedule);
      root.removeEventListener("load", schedule, true);
    };
  }, [rootRef, page, blocks]);

  // Bring the selected block into view (e.g. picked in the panel, or just added).
  const layer = useRef<HTMLDivElement>(null);
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) {
      scrolledTo.current = null;
      return;
    }
    if (scrolledTo.current === selected) return;
    const el = layer.current?.querySelector<HTMLElement>(`[data-overlay-id="${CSS.escape(selected)}"]`);
    if (!el) return;
    scrolledTo.current = selected;
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [selected, rects]);

  // Keep the drop / insertion line in sight (the block may be far down the canvas).
  const hintKey = dropHint ? `${dropHint.id}:${dropHint.edge}` : null;
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    if (!hintKey) {
      revealed.current = null;
      return;
    }
    if (revealed.current === hintKey) return;
    const el = layer.current?.querySelector<HTMLElement>("[data-drop-hint]");
    if (!el) return; // not measured yet: retried when the rects arrive
    revealed.current = hintKey;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [hintKey, rects]);

  return (
    <div ref={layer} className="pointer-events-none absolute inset-0 z-10">
      {rects.map((r) => {
        const isSel = r.id === selected;
        const name = names[r.id] ?? "Bloc";
        const warning = warnings[r.id];
        const inHeader = r.id === logosInHeader;
        return (
          <div
            key={r.id}
            data-overlay-id={r.id}
            role="button"
            tabIndex={0}
            aria-label={`Modifier le bloc « ${name} »${inHeader ? " — logos affichés à côté de « Paiement »" : ""}${warning ? ` — à configurer : ${warning}` : ""}`}
            aria-pressed={isSel}
            aria-keyshortcuts={inline?.fields(r.id).length ? "F2" : undefined}
            title={inline?.fields(r.id).length ? `${name} — double-cliquez pour modifier le texte (F2)` : name}
            onDoubleClick={(e) => {
              e.preventDefault();
              startEdit(r.id, { x: e.clientX, y: e.clientY });
            }}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onSelect(r.id);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(r.id);
              } else if (e.key === "F2") {
                e.preventDefault();
                startEdit(r.id);
              }
            }}
            style={{ top: r.top, left: r.left, width: r.width, height: r.height }}
            className={`group pointer-events-auto absolute cursor-pointer rounded-md outline-offset-2 transition-[outline-color,background-color] duration-100 focus-visible:outline-2 focus-visible:outline-indigo-500 focus-visible:outline-solid ${
              isSel ? "bg-indigo-500/[.04] outline-2 outline-indigo-500 outline-solid" : "outline-1 outline-transparent outline-solid hover:bg-indigo-500/[.03] hover:outline-2 hover:outline-indigo-400"
            }`}
          >
            {inHeader && (
              <span
                aria-hidden
                data-pill="in-header"
                className="absolute bottom-1 left-1 flex max-w-[calc(100%-.5rem)] items-center gap-1 truncate rounded-full bg-indigo-600/90 px-2 py-0.5 text-[11px] leading-4 font-medium text-white shadow-sm"
              >
                <ArrowUpRight className="h-3 w-3 shrink-0" />
                Affichés à côté de « Paiement »
              </span>
            )}
            <span
              // Above the block (so it never covers its title), inside it for the very first one.
              className={`absolute ${r.top < 24 ? "top-1 left-1" : "-top-1 left-0 -translate-y-full"} max-w-[calc(100%-.5rem)] items-center gap-1 truncate rounded-md px-1.5 py-0.5 text-[11px] leading-4 font-medium text-white shadow-sm ${
                isSel ? "flex bg-indigo-600" : "hidden bg-zinc-900 group-hover:flex group-focus-visible:flex"
              }`}
            >
              {name}
            </span>
            {warning && (
              <span
                className={`absolute right-1 ${r.top < 24 ? "top-1" : "-top-1 -translate-y-full"} flex max-w-[calc(100%-.5rem)] items-center gap-1 truncate rounded-md bg-amber-400 px-1.5 py-0.5 text-[11px] leading-4 font-semibold text-amber-950 shadow-sm`}
              >
                <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
                <span className="truncate">{warning}</span>
              </span>
            )}
          </div>
        );
      })}
      {dropHint &&
        (() => {
          const r = rects.find((x) => x.id === dropHint.id);
          if (!r) return null;
          return (
            <div
              aria-hidden
              data-drop-hint
              className="absolute z-20 flex items-center"
              style={{ top: (dropHint.edge === "top" ? r.top - 6 : r.top + r.height + 4) - 1, left: r.left - 4, width: r.width + 8 }}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-indigo-600 bg-white" />
              <span className="h-[3px] flex-1 rounded-full bg-indigo-600" />
              <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-indigo-600 bg-white" />
            </div>
          );
        })()}
      {editing && (
        <textarea
          autoFocus
          aria-label={`Modifier le texte de « ${names[editing.id] ?? "Bloc"} »`}
          value={editing.value}
          rows={editing.multiline ? Math.max(2, editing.value.split("\n").length) : 1}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            const value = editing.multiline ? e.target.value : e.target.value.replace(/\n/g, " ");
            setEditing((cur) => (cur ? { ...cur, value } : cur));
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              // Cancel only; the builder must not also close the selection.
              e.preventDefault();
              e.stopPropagation();
              finish(false);
            } else if (e.key === "Enter" && !(editing.multiline && e.shiftKey)) {
              e.preventDefault();
              finish(true);
            }
          }}
          onBlur={() => finish(true)}
          style={editing.box}
          className="pointer-events-auto absolute z-30 resize-none overflow-hidden rounded-md bg-white px-1 py-0.5 text-zinc-900 shadow-[0_0_0_2px_#6366f1,0_8px_24px_-8px_rgba(15,23,42,.35)] outline-none"
        />
      )}
    </div>
  );
}
