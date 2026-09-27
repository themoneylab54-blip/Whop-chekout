"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";

const VARIANTS = {
  primary: "bg-zinc-900 text-white shadow-[inset_0_1px_0_rgba(255,255,255,.12),0_1px_2px_rgba(16,24,40,.2)] hover:bg-zinc-800",
  secondary: "bg-white text-zinc-800 shadow-[var(--shadow-card)] hover:bg-zinc-50",
  danger: "bg-white text-red-600 shadow-[0_0_0_1px_rgba(220,38,38,.2)] hover:bg-red-50",
};

export function SubmitButton({
  children,
  variant = "primary",
  size = "md",
  className = "",
  confirm,
  ...props
}: ComponentProps<"button"> & { variant?: keyof typeof VARIANTS; size?: "sm" | "md"; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      {...props}
      disabled={pending || props.disabled}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
        props.onClick?.(e);
      }}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-60 ${size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm"} ${VARIANTS[variant]} ${className}`}
    >
      {pending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />}
      {children}
    </button>
  );
}
