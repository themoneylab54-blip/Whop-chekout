"use client";

import type { ComponentProps } from "react";
import { inputClass } from "@/components/ui";
import { centsToField, currencySymbol, parseMoney } from "./money";

/**
 * Amount field: accepts "12,50" or "12.50", shows the currency sign, and tidies the value
 * to "12,50" when the field loses focus. The server parses it again (never trust the browser).
 */
export function MoneyInput({ currency = "EUR", className = "", onBlur, ...props }: Omit<ComponentProps<"input">, "type"> & { currency?: string }) {
  const symbol = currencySymbol(currency);
  return (
    <div className="relative">
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        {...props}
        onBlur={(e) => {
          const el = e.currentTarget;
          const c = parseMoney(el.value);
          if (c != null) {
            const tidy = centsToField(c);
            if (tidy !== el.value) {
              el.value = tidy;
              el.dispatchEvent(new Event("input", { bubbles: true }));
            }
          }
          onBlur?.(e);
        }}
        className={`${inputClass} pr-9 tabular-nums ${className}`}
      />
      <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-zinc-500" aria-hidden>
        {symbol}
      </span>
    </div>
  );
}
