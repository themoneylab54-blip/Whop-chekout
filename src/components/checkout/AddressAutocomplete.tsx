"use client";

import { useEffect, useId, useRef, useState } from "react";

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
  className,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (a: AddressPick) => void;
  enabled: boolean;
  className: string;
  disabled?: boolean;
}) {
  const [items, setItems] = useState<Feature[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const typed = useRef(false);
  const listId = useId();

  useEffect(() => {
    if (!enabled || !typed.current || value.trim().length < 4) return;
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
  }, [value, enabled]);

  function pick(f: Feature) {
    typed.current = false;
    setOpen(false);
    onPick({ address1: f.properties.name, zip: f.properties.postcode, city: f.properties.city });
  }

  return (
    <div className="relative">
      <input
        autoComplete="address-line1"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        value={value}
        disabled={disabled}
        onChange={(e) => {
          typed.current = true;
          onChange(e.target.value);
          if (e.target.value.trim().length < 4) setOpen(false);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => Math.min(items.length - 1, i + 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) => Math.max(0, i - 1));
          } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            pick(items[active]);
          } else if (e.key === "Escape") setOpen(false);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        className={className}
      />
      {open && (
        <ul id={listId} role="listbox" className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-[var(--radius)] border border-neutral-200 bg-white text-sm shadow-lg">
          {items.map((f, i) => (
            <li
              key={f.properties.label}
              role="option"
              aria-selected={i === active}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(f);
              }}
              className={`cursor-pointer px-3 py-2.5 ${i === active ? "bg-neutral-100" : "hover:bg-neutral-50"}`}
            >
              <span className="font-medium">{f.properties.name}</span>
              <span className="text-neutral-500">
                {" "}
                · {f.properties.postcode} {f.properties.city}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
