"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { allCountries, countryName, fold } from "./countries";

/**
 * Accessible multi-select for delivery countries: chips for the selection, a searchable
 * combobox (French names, common EU countries first) and keyboard support (↑ ↓ Entrée Échap,
 * Retour arrière retire le dernier pays). Submits `name` as "FR, BE, CH" (empty = all countries),
 * the format the server action already parses.
 */
export function CountryMultiSelect({
  id,
  name,
  defaultValue,
  describedBy,
  emptyPlaceholder = "Tous les pays · rechercher pour limiter",
}: {
  id: string;
  name: string;
  defaultValue: string[];
  describedBy?: string;
  /** Placeholder while no country is picked (a narrow panel wants a shorter one). */
  emptyPlaceholder?: string;
}) {
  const [selected, setSelected] = useState<string[]>(defaultValue);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const hidden = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const statusId = `${uid}-status`;
  const [announce, setAnnounce] = useState("");

  const countries = allCountries();
  const results = useMemo(() => {
    const q = fold(query.trim());
    if (!q) return countries;
    return countries.filter((c) => fold(c.name).includes(q) || c.code.toLowerCase() === q);
  }, [countries, query]);

  const value = selected.join(", ");
  const first = useRef(true);
  // Tell DirtyForm (listens to bubbling input events) that the hidden field changed.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    hidden.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [value]);

  // "Annuler" on the save bar resets the form: back to the saved countries.
  useEffect(() => {
    const form = hidden.current?.form;
    if (!form) return;
    const onReset = () => {
      setSelected(defaultValue);
      setQuery("");
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [defaultValue]);

  // Close when focus or a click leaves the widget.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const toggle = (code: string) => {
    const has = selected.includes(code);
    setSelected((s) => (has ? s.filter((c) => c !== code) : [...s, code]));
    setAnnounce(`${countryName(code)} ${has ? "retiré" : "ajouté"}`);
  };
  const remove = (code: string) => {
    setSelected((s) => s.filter((c) => c !== code));
    setAnnounce(`${countryName(code)} retiré`);
    input.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      // Never submit the form from the search field.
      e.preventDefault();
      if (open && results[active]) toggle(results[active].code);
      else setOpen(true);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      }
    } else if (e.key === "Backspace" && !query && selected.length) {
      remove(selected[selected.length - 1]);
    }
  };

  const optionId = (i: number) => `${uid}-opt-${i}`;
  const commonEnd = results.findIndex((c) => !c.common);

  return (
    <div ref={root} className="relative">
      <input ref={hidden} type="hidden" name={name} value={value} />
      <div
        className="flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2 py-1.5 shadow-[0_1px_1px_rgba(16,24,40,.04)] transition focus-within:border-indigo-400 focus-within:ring-4 focus-within:ring-indigo-500/10 hover:border-zinc-300"
        onClick={() => {
          input.current?.focus();
          setOpen(true);
        }}
      >
        {selected.length > 0 && (
          <ul aria-label="Pays sélectionnés" className="contents">
            {selected.map((code) => (
              <li key={code} className="inline-flex max-w-full items-center gap-1 rounded-md bg-indigo-50 py-0.5 pr-0.5 pl-2 text-xs font-medium text-indigo-800 ring-1 ring-indigo-600/15 ring-inset">
                <span className="truncate">{countryName(code)}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(code);
                  }}
                  aria-label={`Retirer ${countryName(code)}`}
                  className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-indigo-700 hover:bg-indigo-100"
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        <span className="relative flex min-w-[9rem] flex-1 items-center">
          <Search className="pointer-events-none absolute left-1 h-3.5 w-3.5 text-zinc-400" aria-hidden />
          <input
            ref={input}
            id={id}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && results[active] ? optionId(active) : undefined}
            aria-describedby={[describedBy, statusId].filter(Boolean).join(" ")}
            autoComplete="off"
            data-dirty-ignore
            value={query}
            placeholder={selected.length ? "Ajouter un pays…" : emptyPlaceholder}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onKeyDown={onKeyDown}
            onBlur={(e) => {
              if (!root.current?.contains(e.relatedTarget as Node | null)) setOpen(false);
            }}
            // The wrapper shows the focus (border + ring), like the other fields.
            style={{ outline: "none" }}
            className="h-7 w-full min-w-0 bg-transparent pl-6 text-sm text-zinc-900 outline-none placeholder:text-zinc-500"
          />
        </span>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          onClick={(e) => {
            e.stopPropagation();
            setOpen((o) => !o);
            input.current?.focus();
          }}
          className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-100"
        >
          <ChevronDown className={`h-4 w-4 transition ${open ? "rotate-180" : ""}`} />
        </button>
      </div>
      <p id={statusId} className="sr-only" aria-live="polite">
        {announce}
        {selected.length ? ` · ${selected.length} pays sélectionné${selected.length > 1 ? "s" : ""}` : " · Tous les pays"}
      </p>
      {selected.length > 1 && (
        <button
          type="button"
          onClick={() => {
            setSelected([]);
            setAnnounce("Tous les pays retirés");
          }} className="mt-1 inline-flex min-h-8 items-center rounded-md px-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-50">
          Tout retirer (livrer tous les pays)
        </button>
      )}
      <ul
        ref={list}
        id={listId}
        role="listbox"
        aria-multiselectable="true"
        aria-label="Pays"
        hidden={!open}
        className="absolute inset-x-0 top-full z-30 mt-1 max-h-64 overflow-y-auto rounded-xl bg-white p-1 shadow-[var(--shadow-float)] ring-1 ring-zinc-900/5"
      >
        {open && results.length === 0 && <li className="px-3 py-2 text-sm text-zinc-500">Aucun pays ne correspond</li>}
        {/* Options are built on demand (client only): no 250-item list in the HTML. */}
        {(open ? results : []).map((c, i) => {
          const on = selected.includes(c.code);
          return (
            <li
              key={c.code}
              id={optionId(i)}
              data-index={i}
              role="option"
              aria-selected={on}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => toggle(c.code)}
              onMouseMove={() => setActive(i)}
              className={`flex min-h-9 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-sm ${i === active ? "bg-zinc-100" : ""} ${
                i === commonEnd && commonEnd > 0 ? "mt-1 border-t border-zinc-100" : ""
              }`}
            >
              <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${on ? "border-indigo-600 bg-indigo-600 text-white" : "border-zinc-300"}`} aria-hidden>
                {on && <Check className="h-3 w-3" strokeWidth={3} />}
              </span>
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="font-mono text-[11px] text-zinc-600">{c.code}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
