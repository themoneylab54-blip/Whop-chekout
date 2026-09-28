"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { searchCatalog, type CatalogProduct } from "@/lib/catalog";
import { inputClass } from "@/components/ui";
import { Thumb } from "./Thumb";

export type PickedProduct = { id: string; title: string; imageUrl?: string | null };

/**
 * Picks several Shopify products (not variants) — e.g. "only when the cart contains…".
 * Searches the catalog as you type (ARIA combobox + listbox); each chosen product is posted
 * as a hidden `name` field holding `{"id":"gid://shopify/Product/…","title":"…"}`.
 */
export function ProductMultiPicker({
  storeId,
  name,
  initial,
  inputId,
  describedBy,
  max = 20,
}: {
  storeId: string;
  name: string;
  initial: PickedProduct[];
  inputId: string;
  describedBy?: string;
  max?: number;
}) {
  const [picked, setPicked] = useState<PickedProduct[]>(initial);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<CatalogProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const first = useRef(true);

  // Chosen products change from code: tell the form (dirty tracking).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    box.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [picked]);

  useEffect(() => {
    const form = box.current?.closest("form");
    if (!form) return;
    const onReset = () => {
      setPicked(initial);
      setQuery("");
      setOpen(false);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [initial]);

  const search = useCallback(
    (q: string) => {
      const id = ++seq.current;
      setLoading(true);
      searchCatalog(storeId, q)
        .then((r) => {
          if (id !== seq.current) return;
          setResults(r.ok ? r.data : []);
          setError(r.ok ? null : r.error);
          setActive(0);
        })
        .catch(() => id === seq.current && (setResults([]), setError("Recherche Shopify indisponible")))
        .finally(() => id === seq.current && setLoading(false));
    },
    [storeId],
  );

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => search(query), 250);
    return () => clearTimeout(t);
  }, [query, open, search]);

  const options = (results ?? []).filter((p) => !picked.some((x) => x.id === p.id));
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const full = picked.length >= max;

  function choose(p: CatalogProduct) {
    setPicked((list) => (list.some((x) => x.id === p.id) ? list : [...list, { id: p.id, title: p.title, imageUrl: p.imageUrl }]));
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      if (!options.length) return;
      setActive((i) => (Math.min(i, options.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open && options[activeIndex]) choose(options[activeIndex]);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      } else if (query) setQuery("");
    } else if (e.key === "Backspace" && !query && picked.length) {
      setPicked((list) => list.slice(0, -1));
    }
  }

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, listId]);

  return (
    <div ref={box} className="space-y-2">
      {picked.map((p) => (
        <input key={p.id} type="hidden" name={name} value={JSON.stringify({ id: p.id, title: p.title })} />
      ))}
      {picked.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Produits choisis">
          {picked.map((p) => (
            <li key={p.id} className="flex max-w-full items-center gap-1.5 rounded-full bg-white py-0.5 pr-0.5 pl-1 text-sm ring-1 ring-zinc-200">
              <Thumb src={p.imageUrl ?? null} size={22} />
              <span className="min-w-0 truncate">{p.title}</span>
              <button
                type="button"
                onClick={() => setPicked((list) => list.filter((x) => x.id !== p.id))}
                aria-label={`Retirer ${p.title}`}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
              >
                <X className="h-3.5 w-3.5" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
        <input
          ref={input}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-describedby={describedBy}
          aria-activedescendant={open && options.length ? `${listId}-opt-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          data-dirty-ignore
          disabled={full}
          value={query}
          placeholder={full ? `${max} produits maximum` : picked.length ? "Ajouter un autre produit" : "Rechercher un produit"}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          className={`${inputClass} pr-9 pl-9`}
        />
        {loading && open && <Loader2 className="absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 animate-spin text-zinc-400" aria-hidden />}
        <div
          className={`absolute inset-x-0 top-full z-30 mt-1.5 max-h-72 overflow-y-auto overscroll-contain rounded-xl bg-white p-1 shadow-[var(--shadow-float)] ring-1 ring-zinc-900/5 ${open ? "" : "hidden"}`}
        >
          <ul id={listId} role="listbox" aria-label="Produits Shopify">
            {options.map((p, i) => (
              <li
                key={p.id}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(p)}
                onMouseMove={() => i !== activeIndex && setActive(i)}
                className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm ${i === activeIndex ? "bg-indigo-50 text-zinc-900" : "text-zinc-700"}`}
              >
                <Thumb src={p.imageUrl} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.title}</span>
                  {p.variants.length > 1 && <span className="block truncate text-xs text-zinc-600">{p.variants.length} variantes</span>}
                </span>
              </li>
            ))}
          </ul>
          {!options.length && (
            <p className="px-3 py-3 text-sm text-zinc-500" role="status">
              {loading || results == null ? "Recherche…" : error ? error : "Aucun produit trouvé."}
            </p>
          )}
        </div>
        <span className="sr-only" aria-live="polite">
          {open && !loading && results ? `${options.length} résultat${options.length > 1 ? "s" : ""}` : ""}
        </span>
      </div>
    </div>
  );
}
