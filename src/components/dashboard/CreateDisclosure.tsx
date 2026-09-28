"use client";

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { reopenAfterError } from "./FormDraftKeeper";

const CloseContext = createContext<(() => void) | null>(null);

const FIELDS = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])';

/**
 * A creation form kept out of the way: a "+ Ajouter…" button that expands the form inline and
 * focuses its first field. <CreateCancel /> (placed next to the submit button) collapses it
 * again and gives the focus back to the button. It also collapses once the creation succeeded
 * (the page comes back with a new "ok" flash); on an error it reopens with what was typed (see
 * FormDraftKeeper) to be fixed.
 */
export function CreateDisclosure({
  label,
  title,
  children,
  variant = "dashed",
}: {
  /** Button label, e.g. "Ajouter un code promo". */
  label: string;
  /** Heading of the expanded form, e.g. "Nouveau code promo". */
  title: string;
  children: ReactNode;
  variant?: "dashed" | "link";
}) {
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  const ok = useSearchParams().get("ok");
  const okAtOpen = useRef<string | null>(null);

  useEffect(() => {
    if (open) {
      panel.current?.querySelector<HTMLElement>(FIELDS)?.focus();
    } else if (refocus.current) {
      refocus.current = false;
      trigger.current?.focus();
    }
  }, [open]);

  // Created: the action redirected with a new success flash.
  useEffect(() => {
    if (open && ok && ok !== okAtOpen.current) setOpen(false);
  }, [ok, open]);

  // Refused: the page re-rendered with an error for this form; reopen it (values are restored).
  const error = useSearchParams().get("error");
  // (Read after mount: the draft lives in sessionStorage, unknown to the server render.)
  useEffect(() => {
    if (!error) return;
    const id = requestAnimationFrame(() => {
      if (!reopenAfterError(title)) return;
      okAtOpen.current = ok;
      setOpen(true);
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when a new error lands
  }, [error, title]);

  const close = () => {
    refocus.current = true;
    setOpen(false);
  };

  if (!open)
    return (
      <button
        ref={trigger}
        type="button"
        aria-expanded="false"
        onClick={() => {
          okAtOpen.current = ok;
          setOpen(true);
        }}
        className={
          variant === "dashed"
            ? "flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 px-4 text-sm font-medium text-zinc-700 transition hover:border-indigo-400 hover:bg-indigo-50/50 hover:text-indigo-700"
            : "inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2 text-sm font-medium text-indigo-600 transition hover:bg-indigo-50"
        }
      >
        <Plus className="h-4 w-4" aria-hidden />
        {label}
      </button>
    );

  return (
    <CloseContext.Provider value={close}>
      <div
        ref={panel}
        role="group"
        aria-label={title}
        data-create-disclosure={title}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented && !(e.target as HTMLElement).closest("dialog")) close();
        }}
        className="animate-fade-up rounded-xl bg-zinc-50 p-4 ring-1 ring-zinc-900/5"
      >
        <p className="mb-3 text-sm font-semibold text-zinc-900">{title}</p>
        {children}
      </div>
    </CloseContext.Provider>
  );
}

/** "Annuler" of a CreateDisclosure form: collapses it (unsaved input is dropped). */
export function CreateCancel() {
  const close = useContext(CloseContext);
  if (!close) return null;
  return (
    <button
      type="button"
      onClick={close}
      className="inline-flex min-h-9 items-center justify-center rounded-lg px-4 text-sm font-medium text-zinc-600 transition hover:bg-zinc-200/60 hover:text-zinc-900"
    >
      Annuler
    </button>
  );
}
