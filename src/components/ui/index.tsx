import type { ComponentProps, ReactNode } from "react";
import { CopyButton } from "./CopyButton";
import { SubmitButton } from "./SubmitButton";

export { CopyButton, SubmitButton };

export function Card({ title, description, children, actions, className = "" }: {
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-zinc-200 bg-white p-5 shadow-[0_1px_2px_rgba(0,0,0,.04)] ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-[15px] font-semibold text-zinc-900">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-zinc-500">{description}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-zinc-500">{description}</p>}
      </div>
      {actions}
    </div>
  );
}

export function Label({ children, hint, htmlFor }: { children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-sm font-medium text-zinc-800">
      {children}
      {hint && <span className="mt-0.5 block text-xs font-normal text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 outline-none transition placeholder:text-zinc-400 focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900/10 disabled:bg-zinc-50";

export function Input(props: ComponentProps<"input">) {
  return <input {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Textarea(props: ComponentProps<"textarea">) {
  return <textarea {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

export function Select(props: ComponentProps<"select">) {
  return <select {...props} className={`${inputClass} ${props.className ?? ""}`} />;
}

const BUTTON = {
  primary: "bg-zinc-900 text-white hover:bg-zinc-800",
  secondary: "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50",
  danger: "border border-red-200 bg-white text-red-600 hover:bg-red-50",
  ghost: "text-zinc-600 hover:bg-zinc-100",
};

export function buttonClass(variant: keyof typeof BUTTON = "primary", size: "sm" | "md" = "md") {
  return `inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm"} ${BUTTON[variant]}`;
}

export function Button({ variant = "primary", size = "md", className = "", ...props }: ComponentProps<"button"> & { variant?: keyof typeof BUTTON; size?: "sm" | "md" }) {
  return <button type="button" {...props} className={`${buttonClass(variant, size)} ${className}`} />;
}

const BADGE = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  red: "bg-red-50 text-red-700 ring-red-600/20",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  zinc: "bg-zinc-100 text-zinc-600 ring-zinc-500/20",
  blue: "bg-blue-50 text-blue-700 ring-blue-600/20",
};

export function Badge({ color = "zinc", children }: { color?: keyof typeof BADGE; children: ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${BADGE[color]}`}>{children}</span>;
}

export function Flash({ ok, error }: { ok?: string | null; error?: string | null }) {
  if (!ok && !error) return null;
  return (
    <div
      role="status"
      className={`mb-5 rounded-lg px-4 py-3 text-sm ${error ? "border border-red-200 bg-red-50 text-red-700" : "border border-emerald-200 bg-emerald-50 text-emerald-800"}`}
    >
      {error ?? ok}
    </div>
  );
}

export function Toggle({ name, defaultChecked, label, hint }: { name: string; defaultChecked?: boolean; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-3">
      <span>
        <span className="block text-sm font-medium text-zinc-900">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-zinc-500">{hint}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" name={name} defaultChecked={defaultChecked} className="peer sr-only" />
        <span className="h-6 w-11 rounded-full bg-zinc-300 transition peer-checked:bg-emerald-500 peer-focus-visible:ring-2 peer-focus-visible:ring-zinc-900/20" />
        <span className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow transition peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  return (
    <div>
      {label && <p className="mb-1 text-xs font-medium text-zinc-500">{label}</p>}
      <div className="flex gap-2">
        <input readOnly value={value} className={`${inputClass} font-mono text-xs`} />
        <CopyButton value={value} />
      </div>
    </div>
  );
}
