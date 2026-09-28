"use client";

import { Download, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal, useFormStatus } from "react-dom";

function getForm(formId: string) {
  return document.getElementById(formId) as HTMLFormElement | null;
}

function selected(form: HTMLFormElement | null): string[] {
  if (!form) return [];
  return [...new Set([...form.querySelectorAll<HTMLInputElement>('input[name="ids"]:checked')].map((i) => i.value))];
}

/** Row checkboxes shown at this breakpoint (desktop table or mobile list). */
function visibleBoxes(form: HTMLFormElement | null) {
  return form ? [...form.querySelectorAll<HTMLInputElement>('input[name="ids"]')].filter((i) => i.offsetParent !== null) : [];
}

function setAll(formId: string, checked: boolean) {
  const form = getForm(formId);
  if (!form) return;
  // Hidden duplicates (the other breakpoint's list) are cleared too, so nothing stale is submitted.
  for (const b of form.querySelectorAll<HTMLInputElement>('input[name="ids"]')) b.checked = checked && b.offsetParent !== null;
  form.dispatchEvent(new Event("change", { bubbles: true }));
}

/** Selection state of the orders form: count of selected orders, visible rows, all selected. */
function useSelection(formId: string) {
  const [state, setState] = useState({ count: 0, visible: 0, all: false });
  useEffect(() => {
    const form = getForm(formId);
    const update = () => {
      const boxes = visibleBoxes(form);
      const checked = boxes.filter((b) => b.checked).length;
      setState({ count: selected(form).length, visible: boxes.length, all: boxes.length > 0 && checked === boxes.length });
    };
    form?.addEventListener("change", update);
    window.addEventListener("resize", update);
    update();
    return () => {
      form?.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, [formId]);
  return state;
}

/** "Select all visible rows" checkbox, for the table header (tri-state). */
export function OrdersSelectAll({ formId }: { formId: string }) {
  const { count, all } = useSelection(formId);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && !all;
  }, [count, all]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={all}
      onChange={(e) => setAll(formId, e.target.checked)}
      aria-label={all ? "Désélectionner toutes les commandes de la page" : "Sélectionner toutes les commandes de la page"}
      data-dirty-ignore
      className="h-4 w-4 accent-indigo-600"
    />
  );
}

/** Reports the form's pending state to the floating bar (useFormStatus must live inside the <form>). */
function PendingProbe({ onChange }: { onChange: (pending: boolean) => void }) {
  const { pending } = useFormStatus();
  useEffect(() => onChange(pending), [pending, onChange]);
  return null;
}

/**
 * Stripe-style bulk action bar of the orders list: hidden until at least one row is selected,
 * then floats at the bottom of the screen with the count, the bulk Shopify re-sync (server
 * action), "export the selection" (the form's own GET action to the CSV route) and
 * "Désélectionner" (Escape works too). The bar is portaled to <body> (the page wrapper is
 * transformed, which would break `position: fixed`); its buttons submit the form through
 * hidden submitters that stay inside it.
 */
export function OrdersBulkBar({ formId, resync }: { formId: string; resync: (fd: FormData) => Promise<void> }) {
  const { count, visible, all } = useSelection(formId);
  const [pending, setPending] = useState(false);
  const resyncRef = useRef<HTMLButtonElement>(null);
  const exportRef = useRef<HTMLButtonElement>(null);
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // Keeps the end of the page (pagination) reachable above the floating bar.
  const active = count > 0;
  useEffect(() => {
    if (!active) return;
    const prev = document.body.style.paddingBottom;
    document.body.style.paddingBottom = "6rem";
    return () => {
      document.body.style.paddingBottom = prev;
    };
  }, [active]);

  useEffect(() => {
    if (!count) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) setAll(formId, false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [count, formId]);

  const submit = (btn: HTMLButtonElement | null) => {
    const form = getForm(formId);
    if (form && btn) form.requestSubmit(btn);
  };
  const plural = count > 1 ? "s" : "";

  return (
    <>
      <PendingProbe onChange={setPending} />
      <button ref={resyncRef} type="submit" formAction={resync} hidden tabIndex={-1} aria-hidden />
      <button ref={exportRef} type="submit" hidden tabIndex={-1} aria-hidden />
      {mounted &&
        count > 0 &&
        createPortal(
          <div
            role="region"
            aria-label="Actions groupées"
            className="dash animate-fade-up fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(.75rem,env(safe-area-inset-bottom))] md:left-[248px] md:px-10 md:pb-5"
          >
            <div className="mx-auto flex max-w-[880px] flex-wrap items-center gap-x-2 gap-y-2 rounded-2xl bg-zinc-900 py-2 pr-2 pl-4 text-white shadow-[0_16px_40px_-12px_rgba(16,24,40,.55),0_0_0_1px_rgba(255,255,255,.06)_inset]">
              <p className="flex min-w-0 flex-1 items-center gap-2 text-sm" aria-live="polite">
                <span className="font-semibold whitespace-nowrap tabular-nums">
                  {count} sélectionnée{plural}
                </span>
                {!all && visible > count && (
                  <button
                    type="button"
                    onClick={() => setAll(formId, true)}
                    className="inline-flex min-h-9 items-center rounded-lg px-2 text-sm font-medium whitespace-nowrap text-indigo-200 hover:bg-white/10 hover:text-white"
                  >
                    Tout sélectionner<span className="hidden sm:inline">&nbsp;({visible})</span>
                  </button>
                )}
              </p>
              <span className="order-last flex w-full gap-2 sm:order-none sm:w-auto">
                <button
                  type="button"
                  onClick={() => submit(resyncRef.current)}
                  disabled={pending}
                  aria-busy={pending || undefined}
                  className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-white px-3 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-100 disabled:cursor-wait disabled:opacity-80 sm:flex-none"
                >
                  <RefreshCw className={`h-4 w-4 ${pending ? "animate-spin" : ""}`} aria-hidden />
                  <span className="whitespace-nowrap sm:hidden">Resynchroniser</span>
                  <span className="hidden whitespace-nowrap sm:inline">Relancer la synchro Shopify</span>
                </button>
                <button
                  type="button"
                  onClick={() => submit(exportRef.current)}
                  className="inline-flex min-h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-medium text-white ring-1 ring-white/20 ring-inset transition hover:bg-white/10 sm:flex-none"
                >
                  <Download className="h-4 w-4" aria-hidden />
                  <span className="whitespace-nowrap">
                    Exporter<span className="hidden sm:inline"> (CSV)</span>
                  </span>
                </button>
              </span>
              <button
                type="button"
                onClick={() => setAll(formId, false)}
                className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-zinc-300 transition hover:bg-white/10 hover:text-white"
              >
                <X className="h-4 w-4" aria-hidden />
                <span className="sr-only sm:not-sr-only">Désélectionner</span>
              </button>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
