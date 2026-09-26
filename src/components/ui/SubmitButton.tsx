"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";

const VARIANTS = {
  primary: "bg-zinc-900 text-white hover:bg-zinc-800",
  secondary: "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50",
  danger: "border border-red-200 bg-white text-red-600 hover:bg-red-50",
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
      disabled={pending || props.disabled}
      {...props}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
        props.onClick?.(e);
      }}
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-60 ${size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-4 py-2 text-sm"} ${VARIANTS[variant]} ${className}`}
    >
      {pending && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" />}
      {children}
    </button>
  );
}
