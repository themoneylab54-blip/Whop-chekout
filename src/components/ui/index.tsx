import type { ComponentProps, ReactNode } from "react";
import { AlertCircle, CheckCircle2, type LucideIcon } from "lucide-react";
import { IconTile } from "@/components/icons";
import { CopyButton } from "./CopyButton";
import { SubmitButton } from "./SubmitButton";

export { CopyButton, SubmitButton };

export function Card({
  title,
  description,
  icon,
  iconColor,
  children,
  actions,
  className = "",
}: {
  title?: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  iconColor?: string;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl bg-white p-5 shadow-[var(--shadow-card)] ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            {icon && <IconTile icon={icon} size={36} color={iconColor ?? "#6366f1"} />}
            <div>
              {title && <h2 className="text-[15px] font-semibold tracking-tight text-zinc-900">{title}</h2>}
              {description && <p className="mt-0.5 text-sm leading-relaxed text-zinc-500">{description}</p>}
            </div>
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  icon,
  iconColor,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  icon?: LucideIcon;
  iconColor?: string;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="flex items-center gap-3.5">
        {icon && <IconTile icon={icon} size={44} color={iconColor ?? "#6366f1"} />}
        <div>
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em] text-zinc-900">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-zinc-500">{description}</p>}
        </div>
      </div>
      {actions}
    </div>
  );
}

export function Label({ children, hint, htmlFor }: { children: ReactNode; hint?: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium text-zinc-800">
      {children}
      {hint && <span className="mt-0.5 block text-xs font-normal text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 shadow-[0_1px_1px_rgba(16,24,40,.04)] outline-none transition placeholder:text-zinc-400 hover:border-zinc-300 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10 disabled:bg-zinc-50";

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
  primary:
    "bg-zinc-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,.12),0_1px_2px_rgba(16,24,40,.2)] hover:bg-zinc-800",
  secondary: "bg-white text-zinc-800 shadow-[var(--shadow-card)] hover:bg-zinc-50",
  danger: "bg-white text-red-600 shadow-[0_0_0_1px_rgba(220,38,38,.2)] hover:bg-red-50",
  ghost: "text-zinc-600 hover:bg-zinc-100",
};

export function buttonClass(variant: keyof typeof BUTTON = "primary", size: "sm" | "md" = "md") {
  return `inline-flex items-center justify-center gap-2 rounded-lg font-medium transition active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50 ${
    size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm"
  } ${BUTTON[variant]}`;
}

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof BUTTON; size?: "sm" | "md" }) {
  return <button type="button" {...props} className={`${buttonClass(variant, size)} ${className}`} />;
}

const BADGE = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/15",
  red: "bg-red-50 text-red-700 ring-red-600/15",
  amber: "bg-amber-50 text-amber-800 ring-amber-600/20",
  zinc: "bg-zinc-100 text-zinc-600 ring-zinc-500/15",
  blue: "bg-indigo-50 text-indigo-700 ring-indigo-600/15",
};
const DOT = { green: "bg-emerald-500", red: "bg-red-500", amber: "bg-amber-500", zinc: "bg-zinc-400", blue: "bg-indigo-500" };

export function Badge({ color = "zinc", children, dot = true }: { color?: keyof typeof BADGE; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ring-1 ring-inset ${BADGE[color]}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${DOT[color]}`} />}
      {children}
    </span>
  );
}

export function Flash({ ok, error }: { ok?: string | null; error?: string | null }) {
  if (!ok && !error) return null;
  return (
    <div
      role="status"
      className={`animate-fade-up mb-6 flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm ${
        error ? "bg-red-50 text-red-800 ring-1 ring-red-600/15" : "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-600/15"
      }`}
    >
      {error ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
      <span>{error ?? ok}</span>
    </div>
  );
}

export function Toggle({ name, defaultChecked, label, hint }: { name: string; defaultChecked?: boolean; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-3.5">
      <span>
        <span className="block text-sm font-medium text-zinc-900">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-relaxed text-zinc-500">{hint}</span>}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input type="checkbox" name={name} defaultChecked={defaultChecked} className="peer sr-only" />
        <span className="h-6 w-11 rounded-full bg-zinc-200 shadow-inner transition peer-checked:bg-indigo-600 peer-focus-visible:ring-4 peer-focus-visible:ring-indigo-500/20" />
        <span className="absolute top-0.5 left-0.5 h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.2)] transition peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

export function CopyField({ value, label }: { value: string; label?: string }) {
  return (
    <div>
      {label && <p className="mb-1.5 text-xs font-medium text-zinc-500">{label}</p>}
      <div className="flex gap-2">
        <input readOnly value={value} className={`${inputClass} bg-zinc-50 font-mono text-xs`} />
        <CopyButton value={value} />
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children }: { icon: LucideIcon; title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-6 py-12 text-center">
      <IconTile icon={icon} size={52} color="#6366f1" />
      <p className="mt-4 text-sm font-semibold text-zinc-900">{title}</p>
      {children && <p className="mt-1 max-w-sm text-sm text-zinc-500">{children}</p>}
    </div>
  );
}
