"use client";

import { useEffect, useId, useRef, useState, type InputHTMLAttributes } from "react";
import { MapPin } from "lucide-react";

/*
 * French address autocomplete on the official Base Adresse Nationale (free, no key,
 * CORS-enabled). Fewer typos → fewer failed deliveries and returns. Any network
 * problem simply means no suggestions: the field stays a normal input.
 */

export type AddressPick = { address1: string; zip: string; city: string };
type Feature = { properties: { label: string; name: string; postcode: string; city: string } };

const ENDPOINTS = ["https://data.geopf.fr/geocodage/search", "https://api-adresse.data.gouv.fr/search/"];

async function search(q: string, signal: AbortSignal, type?: string): Promise<Feature[]> {
  for (const base of ENDPOINTS) {
    try {
      const url = `${base}?${new URLSearchParams({ q, limit: "5", autocomplete: "1", ...(type ? { type } : {}) })}`;
      const res = await fetch(url, { signal });
      if (!res.ok) continue;
      const body = (await res.json()) as { features?: Feature[] };
      return body.features ?? [];
    } catch (err) {
      if (signal.aborted) throw err;
    }
  }
  return [];
}

export function AddressAutocomplete({
  value,
  onChange,
  onPick,
  enabled,
  lookup = true,
  className,
  disabled,
  placeholder,
  suggestionsLabel,
  inputProps,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (a: AddressPick) => void;
  /** Autocomplete available for this country (shows the pin and the hint). */
  enabled: boolean;
  /** Query the address API (off in the builder preview). */
  lookup?: boolean;
  className: string;
  disabled?: boolean;
  placeholder?: string;
  /** "3 suggested addresses: use the arrow keys…" for screen readers. */
  suggestionsLabel?: (n: number) => string;
  /** id / required / aria-invalid / aria-describedby / onBlur from the form. */
  inputProps?: InputHTMLAttributes<HTMLInputElement> & { "aria-invalid"?: boolean };
}) {
  const [items, setItems] = useState<Feature[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = useRef(false);
  const listId = useId();

  useEffect(() => {
    if (!enabled || !lookup || !typed.current || value.trim().length < 4) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      search(value, ctrl.signal, "housenumber")
        .then((f) => (f.length ? f : search(value, ctrl.signal)))
        .then((f) => {
          setItems(f);
          setOpen(f.length > 0);
          setActive(-1);
        })
        .catch(() => undefined);
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [value, enabled, lookup]);

  function pick(f: Feature) {
    typed.current = false;
    setOpen(false);
    onPick({ address1: f.properties.name, zip: f.properties.postcode, city: f.properties.city });
  }

  const optionId = (i: number) => `${listId}-opt-${i}`;
  return (
    <div className="relative">
      <input
        {...inputProps}
        autoComplete="address-line1"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? optionId(active) : undefined}
        placeholder={enabled ? placeholder : undefined}
        data-with-icon={enabled || undefined}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          typed.current = true;
          onChange(e.target.value);
          if (e.target.value.trim().length < 4) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (!open) {
            if (e.key === "ArrowDown" && items.length > 0) {
              e.preventDefault();
              setOpen(true);
              setActive(0);
            }
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(items.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            pick(items[active]);
          } else if (e.key === "Escape") {
            // Close the list only; the page keeps its own Escape handling otherwise.
            e.preventDefault();
            setOpen(false);
          }
        }}
        onBlur={(e) => {
          inputProps?.onBlur?.(e);
          setTimeout(() => setOpen(false), 150);
        }}
        className={className}
      />
      {enabled && (
        <MapPin className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-neutral-400" aria-hidden />
      )}
      <p className="sr-only" aria-live="polite">
        {open && suggestionsLabel ? suggestionsLabel(items.length) : ""}
      </p>
      {open && (
        <ul id={listId} role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-[var(--radius)] border border-neutral-200 bg-white text-sm shadow-lg">
          {items.map((f, i) => (
            <li
              key={f.properties.label}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(f);
              }}
              onMouseEnter={() => setActive(i)}
              className={`flex min-h-11 cursor-pointer items-start gap-2 px-3 py-3 ${i === active ? "bg-neutral-100" : "hover:bg-neutral-50"}`}
            >
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
              <span>
              <span className="font-medium">{f.properties.name}</span>
              <span className="text-neutral-600">
                {" "}
                · {f.properties.postcode} {f.properties.city}
              </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
