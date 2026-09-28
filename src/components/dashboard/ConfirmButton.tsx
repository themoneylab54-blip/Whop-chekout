"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle } from "lucide-react";

const TRIGGER = {
  danger: "bg-white text-red-600 shadow-[0_0_0_1px_rgba(220,38,38,.25)] hover:bg-red-50",
  secondary: "bg-white text-zinc-800 shadow-[var(--shadow-card)] hover:bg-zinc-50",
  /** Outline on dark surfaces (status hero). */
  "danger-dark": "bg-transparent text-rose-100 ring-1 ring-inset ring-rose-300/40 hover:bg-rose-500/15 hover:ring-rose-300/70",
  ghost: "text-zinc-500 hover:bg-red-50 hover:text-red-600",
} as const;

/** Unavailable trigger: outline + muted label rather than a faded filled button. */
const OFF = "cursor-not-allowed bg-transparent text-zinc-400 shadow-[inset_0_0_0_1px_rgb(228_228_231)]";

/**
 * Destructive submit button with a confirmation step. Place it inside the <form> it submits:
 * the trigger opens a modal alert dialog (native <dialog>: focus stays inside, Escape closes,
 * focus returns to the trigger) whose confirm button is the form's real submit button.
 */
export function ConfirmButton({
  children,
  title,
  description,
  confirmLabel = "Supprimer",
  cancelLabel = "Annuler",
  variant = "danger",
  size = "md",
  className = "",
  disabled,
  "aria-label": ariaLabel,
  tone = "danger",
}: {
  children: ReactNode;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: keyof typeof TRIGGER;
  size?: "sm" | "md" | "icon";
  className?: string;
  disabled?: boolean;
  "aria-label"?: string;
  /** "default" for a non-destructive but consequential action (neutral colors). */
  tone?: "danger" | "default";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { pending } = useFormStatus();
  const submitted = useRef(false);
  const id = useId();

  // Close once the submission finishes (the page re-renders with a flash message).
  useEffect(() => {
    if (submitted.current && !pending) {
      submitted.current = false;
      ref.current?.close();
    }
  }, [pending]);

  const sizes = { sm: "min-h-8 px-2.5 py-1.5 text-xs", md: "min-h-9 px-4 py-2 text-sm", icon: "h-8 w-8 min-h-8" }[size];

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        disabled={disabled || pending}
        onClick={() => ref.current?.showModal()}
        className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition active:scale-[.98] ${sizes} ${disabled && !pending ? OFF : `${TRIGGER[variant]} disabled:cursor-wait disabled:opacity-80`} ${className}`}
      >
        {children}
      </button>
      <dialog
        ref={ref}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={description ? `${id}-desc` : undefined}
        onClose={() => triggerRef.current?.focus()}
        onClick={(e) => {
          // Click on the backdrop closes (the dialog box itself fills the <dialog> element).
          if (e.target === e.currentTarget && !pending) ref.current?.close();
        }}
        onCancel={(e) => {
          if (pending) e.preventDefault();
        }}
        className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-2xl bg-white p-0 text-zinc-900 shadow-[0_24px_64px_-16px_rgba(16,24,40,.35),0_0_0_1px_rgba(16,24,40,.06)] backdrop:bg-zinc-950/40 backdrop:backdrop-blur-[2px] open:animate-fade-up"
      >
        <div className="p-5">
          <div className="flex items-start gap-3.5">
            <span
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ring-1 ${
                tone === "danger" ? "bg-red-50 text-red-600 ring-red-600/10" : "bg-indigo-50 text-indigo-600 ring-indigo-600/10"
              }`}
            >
              <AlertTriangle className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 pt-0.5">
              <h2 id={`${id}-title`} className="text-[15px] font-semibold tracking-tight">
                {title}
              </h2>
              {description && (
                <p id={`${id}-desc`} className="mt-1 text-sm leading-relaxed text-zinc-600">
                  {description}
                </p>
              )}
            </div>
          </div>
          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              autoFocus
              disabled={pending}
              onClick={() => ref.current?.close()}
              className="inline-flex min-h-10 items-center justify-center rounded-lg bg-white px-4 text-sm font-medium text-zinc-800 shadow-[var(--shadow-card)] transition hover:bg-zinc-50 disabled:opacity-50 sm:min-h-9"
            >
              {cancelLabel}
            </button>
            <button
              type="submit"
              disabled={pending}
              onClick={() => (submitted.current = true)}
              className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,.15),0_1px_2px_rgba(16,24,40,.2)] transition disabled:opacity-70 sm:min-h-9 ${
                tone === "danger" ? "bg-red-600 hover:bg-red-700" : "bg-zinc-900 hover:bg-zinc-800"
              }`}
            >
              {pending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
              {confirmLabel}
            </button>
          </div>
        </div>
      </dialog>
    </>
  );
}
