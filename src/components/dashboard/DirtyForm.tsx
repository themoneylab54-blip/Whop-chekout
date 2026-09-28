"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore, startTransition, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFormStatus } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { rememberForms } from "./FormDraftKeeper";

/* ------------------------------------------------------------------ */
/* Registry of dirty forms (one save bar and one guard for the page)   */
/* ------------------------------------------------------------------ */

type Entry = {
  id: string;
  label: string;
  formId: string;
  pending: boolean;
  reset: () => void;
  at: number;
};
let entries: Entry[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const getEntries = () => entries;
const NONE: Entry[] = [];
const getServerEntries = () => NONE;
/** Set while a form is being submitted: its action may redirect (even to Shopify) without a prompt. */
let submitting = false;

function setEntry(e: Entry | null, id: string) {
  const current = entries.find((x) => x.id === id);
  if (!e) {
    if (!current) return;
    entries = entries.filter((x) => x.id !== id);
  } else if (current) {
    if (current.pending === e.pending && current.label === e.label) return;
    entries = entries.map((x) => (x.id === id ? { ...e, at: current.at } : x));
  } else {
    entries = [...entries, e];
  }
  emit();
}

/** Page-level action able to save several dirty forms in one request (see SaveAllWith). */
type BatchAction = (fd: FormData) => void | Promise<void>;
let batchAction: BatchAction | null = null;

/**
 * Lets the save bar save every dirty form of the page in one request: each form's fields are
 * sent as "<label>::<name>" with one "__section" per label, in page order. (Saving forms one by
 * one does not work: the first save's redirect re-renders the page and drops the others.)
 */
export function SaveAllWith({ action }: { action: BatchAction }) {
  useEffect(() => {
    batchAction = action;
    return () => {
      if (batchAction === action) batchAction = null;
    };
  }, [action]);
  return null;
}

function batchFormData(list: Entry[]): FormData {
  const fd = new FormData();
  list
    .map((e) => ({ e, form: document.getElementById(e.formId) }))
    .filter((x): x is { e: Entry; form: HTMLFormElement } => x.form instanceof HTMLFormElement)
    .sort((a, b) => (a.form.compareDocumentPosition(b.form) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .forEach(({ e, form }) => {
      fd.append("__section", e.label);
      for (const [k, v] of new FormData(form).entries()) if (!k.startsWith("$ACTION")) fd.append(`${e.label}::${k}`, v);
    });
  return fd;
}

/** True while at least one form of the page has unsaved changes. */
export function hasUnsavedChanges() {
  return entries.length > 0;
}

/* ------------------------------------------------------------------ */
/* DirtyForm                                                           */
/* ------------------------------------------------------------------ */

function snapshot(form: HTMLFormElement): string {
  const parts: string[] = [];
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement)) continue;
    if (!el.name || el.disabled || el.dataset.dirtyIgnore != null) continue;
    if (el instanceof HTMLInputElement) {
      if (el.type === "file" || el.type === "submit" || el.type === "button") continue;
      if (el.type === "checkbox" || el.type === "radio") {
        parts.push(`${el.name}=${el.value}:${el.checked ? 1 : 0}`);
        continue;
      }
    }
    parts.push(`${el.name}=${el.value}`);
  }
  return parts.join("\u0000");
}

/** Reports the form's pending state (useFormStatus must live inside the <form>). */
function PendingProbe({ onChange }: { onChange: (pending: boolean) => void }) {
  const { pending } = useFormStatus();
  useEffect(() => onChange(pending), [pending, onChange]);
  return null;
}

/**
 * A `<form action={serverAction}>` that knows when it holds unsaved changes. While dirty, a
 * Shopify-style contextual bar sticks to the bottom of the screen (« Modifications non
 * enregistrées · Annuler · Enregistrer »), closing the tab asks for confirmation, and in-app
 * links ask before leaving. Annuler resets every field to its saved value.
 *
 * Fields changed from code (pickers) must dispatch a bubbling `input` event; add
 * `data-dirty-ignore` to a field that should not count.
 */
export function DirtyForm({
  label,
  children,
  id: idProp,
  action,
  ...props
}: Omit<ComponentProps<"form">, "action"> & { action: (fd: FormData) => void | Promise<void>; label: string; children: ReactNode }) {
  const autoId = useId();
  const formId = idProp ?? `dirty-${autoId.replace(/:/g, "")}`;
  const ref = useRef<HTMLFormElement>(null);
  const baseline = useRef<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    const form = ref.current;
    if (!form) return;
    baseline.current = snapshot(form);
    const check = () => setDirty(baseline.current != null && snapshot(form) !== baseline.current);
    // After a reset (Annuler, or React resetting the form once the action succeeded), the
    // fields show their saved values again: that is the new baseline.
    const onReset = () =>
      setTimeout(() => {
        baseline.current = snapshot(form);
        setDirty(false);
      }, 0);
    const onSubmit = () => {
      submitting = true;
    };
    form.addEventListener("input", check);
    form.addEventListener("change", check);
    form.addEventListener("reset", onReset);
    form.addEventListener("submit", onSubmit);
    return () => {
      form.removeEventListener("submit", onSubmit);
      form.removeEventListener("input", check);
      form.removeEventListener("change", check);
      form.removeEventListener("reset", onReset);
    };
  }, []);

  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) submitting = false;
    wasPending.current = pending;
  }, [pending]);

  useEffect(() => {
    if (dirty) setEntry({ id: formId, formId, label, pending, reset: () => ref.current?.reset(), at: Date.now() }, formId);
    else setEntry(null, formId);
  }, [dirty, pending, label, formId]);
  useEffect(() => () => setEntry(null, formId), [formId]);

  return (
    <form ref={ref} id={formId} action={action} data-form-label={label} {...props}>
      <PendingProbe onChange={setPending} />
      {children}
    </form>
  );
}

/**
 * Inline "Enregistrer" for small row forms (one per table row) where the page-level save bar
 * would be heavy: disabled until a field of its own <form> differs from its saved value, like the
 * save bar that only appears once something changed.
 */
export function DirtySubmit({ children = "Enregistrer", className = "" }: { children?: ReactNode; className?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return;
    let baseline = snapshot(form);
    const check = () => setDirty(snapshot(form) !== baseline);
    const onReset = () =>
      setTimeout(() => {
        baseline = snapshot(form);
        setDirty(false);
      }, 0);
    form.addEventListener("input", check);
    form.addEventListener("change", check);
    form.addEventListener("reset", onReset);
    return () => {
      form.removeEventListener("input", check);
      form.removeEventListener("change", check);
      form.removeEventListener("reset", onReset);
    };
  }, []);
  return (
    <DirtySubmitButton ref={ref} dirty={dirty} className={className}>
      {children}
    </DirtySubmitButton>
  );
}

function DirtySubmitButton({ ref, dirty, className, children }: { ref: React.Ref<HTMLButtonElement>; dirty: boolean; className: string; children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button
      ref={ref}
      type="submit"
      disabled={!dirty || pending}
      aria-busy={pending || undefined}
      title={dirty ? undefined : "Modifiez la valeur pour pouvoir l'enregistrer"}
      className={`inline-flex min-h-9 items-center justify-center gap-2 rounded-lg bg-white px-2.5 text-xs font-medium text-zinc-800 shadow-[var(--shadow-card)] transition hover:bg-zinc-50 active:scale-[.98] disabled:cursor-not-allowed disabled:text-zinc-500 disabled:shadow-none disabled:ring-1 disabled:ring-zinc-200 disabled:hover:bg-white ${className}`}
    >
      {pending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Save bar + leave guards (mounted once, in the store layout)         */
/* ------------------------------------------------------------------ */

export function UnsavedChangesBar() {
  const list = useSyncExternalStore(subscribe, getEntries, getServerEntries);
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const dirty = list.length > 0;

  // Closing / reloading the tab.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (submitting) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // In-app links (Next <Link> skips navigation when the click was default-prevented).
  useEffect(() => {
    if (!dirty) return;
    const onClick = (e: MouseEvent) => {
      if (submitting || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin) return;
      if (url.pathname === location.pathname && url.search === location.search) return;
      e.preventDefault();
      e.stopPropagation();
      setLeaveTo(url.pathname + url.search + url.hash);
      dialog.current?.showModal();
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [dirty]);

  const current = [...list].sort((a, b) => b.at - a.at)[0];
  const others = list.length - 1;
  // The batch save redirects (its promise may never settle): "busy" lasts until the dirty list changes.
  const search = useSearchParams().toString();
  const [saving, setSaving] = useState<{ list: Entry[]; search: string } | null>(null);
  const busy = (saving?.list === list && saving.search === search) || list.some((e) => e.pending);
  // Batch saved (the redirect changed the URL): the forms show the saved values again. On an
  // error flash, the edits stay in place to be fixed.
  useEffect(() => {
    if (!saving || saving.search === search) return;
    if (!new URLSearchParams(search).get("error")) saving.list.forEach((e) => e.reset());
  }, [saving, search]);
  useEffect(() => {
    if (!dirty) submitting = false;
  }, [dirty]);

  return (
    <>
      {mounted &&
        current &&
        createPortal(
          <div
            role="region"
            aria-label="Modifications non enregistrées"
            className="dash animate-fade-up fixed inset-x-0 bottom-0 z-40 px-3 pb-[max(.75rem,env(safe-area-inset-bottom))] md:left-[248px] md:px-10 md:pb-5"
          >
            <div className="mx-auto flex max-w-[1000px] items-center gap-3 rounded-2xl bg-zinc-900 py-2.5 pr-2.5 pl-4 text-white shadow-[0_16px_40px_-12px_rgba(16,24,40,.55),0_0_0_1px_rgba(255,255,255,.06)_inset]">
              <AlertTriangle className="hidden h-4 w-4 shrink-0 text-amber-300 sm:block" aria-hidden />
              <p className="min-w-0 flex-1 text-sm leading-tight">
                <span className="font-medium">
                  <span className="sm:hidden">Non enregistré</span>
                  <span className="hidden sm:inline">Modifications non enregistrées</span>
                </span>
                <span className="block truncate text-xs text-zinc-400 sm:inline sm:text-sm">
                  <span className="hidden sm:inline"> · </span>
                  {current.label}
                  {others > 0 && ` (+${others} autre${others > 1 ? "s" : ""} section${others > 1 ? "s" : ""})`}
                </span>
              </p>
              <button
                type="button"
                onClick={() => list.forEach((e) => e.reset())}
                disabled={busy}
                className="inline-flex min-h-9 shrink-0 items-center rounded-lg px-3 text-sm font-medium text-zinc-200 transition hover:bg-white/10 hover:text-white disabled:opacity-50"
              >
                Annuler
              </button>
              <button
                type="button"
                onClick={() => {
                  // Several dirty forms and a page batch action: one request saves them all.
                  // Otherwise a normal submit of the form being edited (React resets it once saved).
                  const batch = batchAction;
                  if (list.length > 1 && batch) {
                    const fd = batchFormData(list);
                    // Kept in case a section is refused: the page re-renders with every edit back in place.
                    rememberForms(list.map((e) => document.getElementById(e.formId)).filter((f): f is HTMLFormElement => f instanceof HTMLFormElement));
                    submitting = true;
                    setSaving({ list, search });
                    startTransition(() => {
                      void batch(fd);
                    });
                  } else (document.getElementById(current.formId) as HTMLFormElement | null)?.requestSubmit();
                }}
                disabled={busy}
                aria-busy={busy || undefined}
                className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-lg bg-white px-4 text-sm font-semibold text-zinc-900 shadow-sm transition hover:bg-zinc-100 disabled:cursor-wait disabled:opacity-80"
              >
                {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
                {busy ? "Enregistrement…" : "Enregistrer"}
              </button>
            </div>
          </div>,
          document.body,
        )}
      {/* Spacer so the bar never hides the end of the page. */}
      {current && <div aria-hidden className="h-20" />}

      <dialog
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="leave-title"
        aria-describedby="leave-desc"
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
        className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl bg-white p-0 text-zinc-900 shadow-[0_24px_64px_-16px_rgba(16,24,40,.35),0_0_0_1px_rgba(16,24,40,.06)] backdrop:bg-zinc-950/40 backdrop:backdrop-blur-[2px] open:animate-fade-up"
      >
        <div className="p-5">
          <div className="flex items-start gap-3.5">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-50 text-amber-600 ring-1 ring-amber-600/15">
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 pt-0.5">
              <h2 id="leave-title" className="text-[15px] font-semibold tracking-tight">
                Quitter sans enregistrer ?
              </h2>
              <p id="leave-desc" className="mt-1 text-sm leading-relaxed text-zinc-600">
                Vos modifications ({list.map((x) => x.label).join(", ")}) seront perdues.
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              autoFocus
              onClick={() => dialog.current?.close()}
              className="inline-flex min-h-10 items-center justify-center rounded-lg bg-white px-4 text-sm font-medium text-zinc-800 shadow-[var(--shadow-card)] transition hover:bg-zinc-50 sm:min-h-9"
            >
              Rester sur la page
            </button>
            <button
              type="button"
              onClick={() => {
                dialog.current?.close();
                const to = leaveTo;
                // Forget the dirty forms: the page is being left on purpose.
                entries = [];
                emit();
                if (to) router.push(to);
              }}
              className="inline-flex min-h-10 items-center justify-center rounded-lg bg-red-600 px-4 text-sm font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,.15),0_1px_2px_rgba(16,24,40,.2)] transition hover:bg-red-700 sm:min-h-9"
            >
              Quitter sans enregistrer
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
