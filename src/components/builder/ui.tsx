"use client";

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { AlertTriangle, X, type LucideIcon } from "lucide-react";

/** Shared focus ring for every builder control (2px solid, visible on keyboard focus only). */
export const RING = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 focus-visible:outline-solid";

/**
 * Closes a popover on a click outside of `refs`. (Escape is handled once, centrally,
 * by the builder so that it closes the top-most layer only.)
 */
export function useOutsideClick(open: boolean, onClose: () => void, refs: RefObject<HTMLElement | null>[]) {
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  });
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (refs.some((r) => r.current?.contains(t))) return;
      close.current();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

/** Section heading used by every panel of the builder (same size, color and spacing everywhere). */
export function PanelHeading({ children, action, id }: { children: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="mb-2 flex min-h-8 items-center justify-between gap-2 px-1">
      <h2 id={id} className="text-[11px] font-semibold tracking-[.08em] text-zinc-600 uppercase">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-zinc-300 bg-zinc-50/60 px-5 py-7 text-center">
      <span className="mb-2.5 flex h-9 w-9 items-center justify-center rounded-xl bg-white text-zinc-600 shadow-sm ring-1 ring-zinc-200">
        <Icon className="h-4 w-4" />
      </span>
      <p className="text-sm font-medium text-zinc-800">{title}</p>
      {children && <p className="mt-1 max-w-[260px] text-xs leading-relaxed text-zinc-600">{children}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Popover panel anchored under the top bar, right-aligned (or left: `side`); fits a 390px screen. */
export function Panel({
  title,
  onClose,
  children,
  footer,
  panelRef,
  width = "w-[22rem]",
  side = "right",
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  panelRef?: RefObject<HTMLDivElement | null>;
  width?: string;
  side?: "left" | "right";
}) {
  const localRef = useRef<HTMLDivElement>(null);
  const ownRef = panelRef ?? localRef;
  const bodyRef = useRef<HTMLDivElement>(null);
  // The control that had focus when the panel opened (its trigger), read at the first render:
  // before the panel moves focus, and stable across Strict Mode's effect re-runs.
  const [trigger] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null,
  );
  // Keyboard: opening moves focus to the first control of the panel (its content, else the
  // close button); closing (Escape, "Fermer", or an action that closes it) gives it back to the
  // button that opened it, unless the click that closed it focused something else.
  useEffect(() => {
    const panel = ownRef.current;
    if (panel && !panel.contains(document.activeElement)) {
      const inBody = bodyRef.current ? focusables(bodyRef.current) : [];
      const first = inBody[0] ?? focusables(panel)[0];
      first?.focus();
    }
    return () => {
      const active = document.activeElement;
      if (trigger?.isConnected && (!active || active === document.body || !active.isConnected)) trigger.focus();
    };
  }, [ownRef, trigger]);
  // Tab stays in the panel (last → first); Shift+Tab on the first control goes back to the trigger.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || !ownRef.current) return;
    const all = focusables(ownRef.current);
    if (!all.length) return;
    const first = all[0];
    const last = all[all.length - 1];
    if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      (trigger?.isConnected ? trigger : last).focus();
    }
  };
  return (
    <div
      ref={ownRef}
      role="dialog"
      aria-label={title}
      onKeyDown={onKeyDown}
      className={`absolute top-full z-40 mt-2 ${side === "left" ? "left-2 sm:left-3" : "right-2 sm:right-3"} ${width} max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-900 shadow-[0_20px_50px_-12px_rgba(15,23,42,.35),0_0_0_1px_rgba(15,23,42,.04)]`}
    >
      <div className="flex items-center justify-between border-b border-zinc-100 py-2 pr-2 pl-4">
        <p className="text-[11px] font-semibold tracking-[.08em] text-zinc-600 uppercase">{title}</p>
        <button type="button" onClick={onClose} aria-label="Fermer" className={`rounded-md p-1 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 ${RING}`}>
          <X className="h-4 w-4" />
        </button>
      </div>
      <div ref={bodyRef} className="contents">
        <div className="max-h-[min(70vh,32rem)] overflow-y-auto">{children}</div>
        {footer && <div className="border-t border-zinc-100 bg-zinc-50/70 px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Visible, enabled, tabbable controls inside `root`, in DOM (= tab) order. */
function focusables(root: HTMLElement): HTMLElement[] {
  const sel = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(sel)).filter((el) => el.tabIndex >= 0 && el.getClientRects().length > 0);
}

type ConfirmOpts = { title: string; body?: ReactNode; confirm: string; danger?: boolean };

/** Accessible confirmation dialog (replaces window.confirm). Returns [dialog, ask]. */
export function useConfirm(): [ReactNode, (o: ConfirmOpts) => Promise<boolean>] {
  const [req, setReq] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const ask = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setReq({ ...o, resolve })), []);
  const done = (v: boolean) => {
    req?.resolve(v);
    setReq(null);
  };
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!req) return;
    const prev = document.activeElement as HTMLElement | null;
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        req.resolve(false);
        setReq(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [req]);

  const node = req ? (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-zinc-950/40 p-3 backdrop-blur-[2px] sm:items-center" onMouseDown={() => done(false)}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="builder-confirm-title"
        onMouseDown={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl bg-white p-5 text-zinc-900 shadow-2xl"
      >
        <div className="flex gap-3">
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${req.danger ? "bg-red-50 text-red-600" : "bg-indigo-50 text-indigo-600"}`}>
            <AlertTriangle className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p id="builder-confirm-title" className="text-sm font-semibold">
              {req.title}
            </p>
            {req.body && <div className="mt-1 text-[13px] leading-relaxed text-zinc-600">{req.body}</div>}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={() => done(false)} className={`rounded-lg border border-zinc-200 bg-white px-3.5 py-1.5 text-sm font-medium hover:bg-zinc-50 ${RING}`}>
            Annuler
          </button>
          <button
            ref={okRef}
            type="button"
            onClick={() => done(true)}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-medium text-white ${req.danger ? "bg-red-600 hover:bg-red-700" : "bg-zinc-900 hover:bg-zinc-800"} ${RING}`}
          >
            {req.confirm}
          </button>
        </div>
      </div>
    </div>
  ) : null;
  return [node, ask];
}

/** "il y a 3 min" — re-renders every 30 s. */
export function useRelativeTime(iso: string | null): string | null {
  // Starts unset so the server render and the first client render match (no hydration mismatch).
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const first = setTimeout(() => setNow(Date.now()), 0);
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, []);
  if (!iso) return null;
  if (now == null) return new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  if (d < 30) return `il y a ${d} j`;
  return `le ${new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" })}`;
}

/**
 * Wraps a control with a tooltip that also works while it is unavailable: pass
 * `aria-disabled` (not `disabled`) to the child so it stays hoverable and focusable,
 * and the reason shows on hover and on keyboard focus.
 */
export function Tip({
  text,
  children,
  side = "top",
  align = "center",
  className = "",
}: {
  text: string | null;
  children: ReactNode;
  side?: "top" | "bottom";
  /** "end": right-aligned with the control (near the right edge of a panel). */
  align?: "center" | "end";
  className?: string;
}) {
  if (!text) return <>{children}</>;
  return (
    <span className={`group/tip relative inline-flex ${className}`}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-50 w-max max-w-[220px] rounded-md ${align === "end" ? "right-0" : "left-1/2 -translate-x-1/2"} bg-zinc-900 px-2 py-1 text-center text-[11px] leading-snug font-medium text-white opacity-0 shadow-lg transition-opacity delay-150 group-focus-within/tip:opacity-100 group-hover/tip:opacity-100 ${
          side === "top" ? "bottom-full mb-1.5" : "top-full mt-1.5"
        }`}
      >
        {text}
      </span>
    </span>
  );
}
