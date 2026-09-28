import type { ComponentProps, ReactNode } from "react";
import { AlertCircle, CheckCircle2, type LucideIcon } from "lucide-react";
import { IconTile } from "@/components/icons";
import { BrandTile, type Brand } from "@/components/brands";
import { CopyButton } from "./CopyButton";
import { SubmitButton } from "./SubmitButton";
import { FlashBox } from "./FlashBox";
import { humanizeError } from "@/lib/humanize-error";

export { CopyButton, SubmitButton };

export function Card({
  title,
  description,
  icon,
  iconColor,
  brand,
  children,
  actions,
  className = "",
  id,
}: {
  id?: string;
  title?: ReactNode;
  description?: ReactNode;
  icon?: LucideIcon;
  iconColor?: string;
  brand?: Brand;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={`scroll-mt-20 rounded-2xl bg-white p-5 shadow-[var(--shadow-card)] ${className}`}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
            {brand ? <BrandTile brand={brand} size={36} /> : icon && <IconTile icon={icon} size={36} color={iconColor ?? "#6366f1"} />}
            <div className="min-w-0">
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
  brand,
}: {
  title: string;
  description?: ReactNode;
  /** Keep them compact on phones: icon buttons with an aria-label, or `hidden sm:inline` text. */
  actions?: ReactNode;
  icon?: LucideIcon;
  iconColor?: string;
  brand?: Brand;
}) {
  // Phones: smaller tile and title, description hidden (content starts right away), actions
  // stay on the title row instead of wrapping below it.
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 sm:mb-7 sm:items-end sm:gap-4">
      <div className="flex min-w-0 items-center gap-3 sm:gap-3.5">
        <span className="sm:hidden">{brand ? <BrandTile brand={brand} size={36} /> : icon && <IconTile icon={icon} size={36} color={iconColor ?? "#6366f1"} />}</span>
        <span className="hidden sm:block">{brand ? <BrandTile brand={brand} size={44} /> : icon && <IconTile icon={icon} size={44} color={iconColor ?? "#6366f1"} />}</span>
        <div className="min-w-0">
          <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.02em] text-zinc-900 sm:text-[26px]">{title}</h1>
          {description && <p className="mt-1 hidden max-w-2xl text-sm text-zinc-500 sm:block">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex max-w-full items-center gap-2">{actions}</div>}
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

/**
 * Disabled buttons read as unavailable, not as a greyed primary: transparent, thin outline,
 * muted label (the `disabled:` variants outrank the variant colors).
 */
export const DISABLED_BUTTON =
  "disabled:cursor-not-allowed disabled:bg-transparent disabled:text-zinc-400 disabled:shadow-[inset_0_0_0_1px_rgb(228_228_231)] disabled:ring-0 disabled:hover:bg-transparent disabled:active:scale-100";

export function buttonClass(variant: keyof typeof BUTTON = "primary", size: "sm" | "md" = "md") {
  return `inline-flex items-center justify-center gap-2 rounded-lg font-medium transition active:scale-[.98] ${DISABLED_BUTTON} ${
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

const RAW_ERROR = /^(Shopify API|Shopify injoignable|Whop\b.*\b\d{3}\b|TikTok \d|invalid_grant|fetch failed|TypeError|Error:|The operation|OAuthException|Request failed)/i;

export function Flash({ ok, error }: { ok?: string | null; error?: string | null }) {
  if (!ok && !error) return null;
  // A raw provider error passed through as is ("Shopify API 403: …") is reworded; composed
  // French messages are left alone.
  const message = error ? (RAW_ERROR.test(error) ? humanizeError(error).text : error) : (ok ?? "");
  return (
    <FlashBox
      tone={error ? "error" : "ok"}
      message={message}
      className={`animate-fade-up mb-6 flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm ${
        error ? "bg-red-50 text-red-800 ring-1 ring-red-600/15" : "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-600/15"
      }`}
    >
      {error ? <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <span>{message}</span>
    </FlashBox>
  );
}

export function Toggle({
  name,
  defaultChecked,
  label,
  hint,
  more,
}: {
  name: string;
  defaultChecked?: boolean;
  label: ReactNode;
  hint?: ReactNode;
  /** Longer explanation behind an "En savoir plus" disclosure (kept outside the label). */
  more?: ReactNode;
}) {
  const row = (
    <label className={`flex cursor-pointer items-start justify-between gap-4 ${more ? "pt-3.5 pb-1" : "py-3.5"}`}>
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
  if (!more) return row;
  return (
    <div className="pb-2.5">
      {row}
      <details className="group text-xs leading-relaxed text-zinc-600">
        <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
          <span className="group-open:hidden">En savoir plus</span>
          <span className="hidden group-open:inline">Masquer les détails</span>
        </summary>
        <div className="mt-1 max-w-prose pr-14">{more}</div>
      </details>
    </div>
  );
}

/** Long explanation folded behind "En savoir plus" (same disclosure as Toggle's `more`). */
export function LearnMore({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <details className={`group text-xs leading-relaxed text-zinc-600 ${className}`}>
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1 rounded font-medium text-indigo-700 hover:underline focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">En savoir plus</span>
        <span className="hidden group-open:inline">Masquer les détails</span>
      </summary>
      <div className="mt-1 max-w-prose">{children}</div>
    </details>
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
