"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Hash, Loader2, Search, X } from "lucide-react";
import { Thumb } from "./Thumb";
import { getCatalogVariant, searchCatalog, type CatalogProduct, type CatalogVariant } from "@/lib/catalog";
import { inputClass } from "@/components/ui";
import { stableCents } from "./stableFormat";

export type PickedVariant = { id: string; product: CatalogProduct | null; variant: CatalogVariant | null };

type Option = { key: string; kind: "variant"; product: CatalogProduct; variant: CatalogVariant } | { key: string; kind: "manual"; id: string };

const variantNumber = (v: string) => v.match(/(\d+)\D*$/)?.[1] ?? null;
export const variantLabel = (p: CatalogProduct, v: CatalogVariant) => (v.title && v.title !== "Default Title" ? `${p.title} — ${v.title}` : p.title);
/** A pasted id, gid or admin URL (…/variants/123) typed instead of a search. */
const manualId = (q: string) => {
  const t = q.trim();
  if (/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(t)) return variantNumber(t);
  if (/^\d{6,}$/.test(t)) return t;
  if (/\/variants\/\d+/.test(t)) return variantNumber(t);
  return null;
};

/**
 * Shopify product / variant combobox (ARIA 1.2 combobox + listbox): searches the store's
 * catalog as you type (250 ms debounce), arrow keys + Enter to pick, Escape to close.
 * The chosen variant goes into a hidden `name` field (numeric id); pasting a raw id still works.
 */
export function ProductPicker({
  storeId,
  name,
  defaultValue,
  currency,
  inputId,
  describedBy,
  onPick,
}: {
  storeId: string;
  name: string;
  defaultValue?: string | null;
  currency: string;
  inputId: string;
  describedBy?: string;
  onPick?: (picked: PickedVariant | null) => void;
}) {
  const initialId = defaultValue ? variantNumber(defaultValue) : null;
  const [value, setValue] = useState<PickedVariant | null>(initialId ? { id: initialId, product: null, variant: null } : null);
  const [lookup, setLookup] = useState<"idle" | "loading" | "done">(initialId ? "loading" : "idle");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<CatalogProduct[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const hidden = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const seq = useRef(0);
  const first = useRef(true);
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  });

  // Show what an existing add-on points to (image, product, variant, price).
  useEffect(() => {
    if (!initialId) return;
    let alive = true;
    getCatalogVariant(storeId, initialId)
      .then((r) => {
        if (!alive) return;
        if (r.ok && r.data) {
          const picked = { id: initialId, product: r.data.product, variant: r.data.variant };
          setValue((v) => (v?.id === initialId ? picked : v));
          onPickRef.current?.(picked);
        }
      })
      .catch(() => undefined)
      .finally(() => alive && setLookup("done"));
    return () => {
      alive = false;
    };
  }, [storeId, initialId]);

  // The hidden field changes from code: tell the form (dirty tracking) with a bubbling input event.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    hidden.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [value?.id]);

  // "Annuler" on the form: back to the saved variant.
  useEffect(() => {
    const form = hidden.current?.form;
    if (!form) return;
    const onReset = () => {
      setValue(initialId ? { id: initialId, product: null, variant: null } : null);
      setQuery("");
      setOpen(false);
      if (initialId) {
        getCatalogVariant(storeId, initialId)
          .then((r) => r.ok && r.data && setValue((v) => (v?.id === initialId ? { id: initialId, product: r.data!.product, variant: r.data!.variant } : v)))
          .catch(() => undefined);
      }
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [initialId, storeId]);

  const search = useCallback(
    (q: string) => {
      const id = ++seq.current;
      setLoading(true);
      searchCatalog(storeId, q)
        .then((r) => {
          if (id !== seq.current) return;
          if (r.ok) {
            setResults(r.data);
            setError(null);
          } else {
            setResults([]);
            setError(r.error);
          }
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

  const manual = manualId(query);
  const options: Option[] = [
    ...(manual ? [{ key: `manual-${manual}`, kind: "manual" as const, id: manual }] : []),
    ...(results ?? []).flatMap((p) => p.variants.map((v) => ({ key: v.id, kind: "variant" as const, product: p, variant: v }))),
  ];
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));

  function choose(o: Option) {
    const picked: PickedVariant = o.kind === "manual" ? { id: o.id, product: null, variant: null } : { id: variantNumber(o.variant.id)!, product: o.product, variant: o.variant };
    setValue(picked);
    setQuery("");
    setOpen(false);
    onPickRef.current?.(picked);
  }

  function clear() {
    setValue(null);
    onPickRef.current?.(null);
    setTimeout(() => input.current?.focus(), 0);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return setOpen(true);
      if (!options.length) return;
      setActive((i) => (Math.min(i, options.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (e.key === "Enter") {
      // Never submit the surrounding form from the search box.
      e.preventDefault();
      if (open && options[activeIndex]) choose(options[activeIndex]);
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
      } else if (query) setQuery("");
    } else if (e.key === "Home" || e.key === "End") {
      if (!open || !options.length) return;
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : options.length - 1);
    }
  }

  // Keep the highlighted option visible while moving with the keyboard.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, listId]);

  const hiddenField = <input ref={hidden} type="hidden" name={name} value={value?.id ?? ""} />;

  if (value) {
    const { product, variant } = value;
    return (
      <div className="flex min-h-[46px] items-center gap-3 rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 shadow-[0_1px_1px_rgba(16,24,40,.04)]">
        {hiddenField}
        {product && variant ? <Thumb src={variant.imageUrl ?? product.imageUrl} size={32} /> : <Thumb src={null} size={32} />}
        <span className="min-w-0 flex-1 text-sm">
          {product && variant ? (
            <>
              <span className="block truncate font-medium text-zinc-900">{product.title}</span>
              <span className="block truncate text-xs text-zinc-500">
                {variant.title !== "Default Title" ? `${variant.title} · ` : ""}
                {stableCents(Math.round(Number(variant.price) * 100), currency)}
              </span>
            </>
          ) : (
            <>
              <span className="block truncate font-medium text-zinc-900">Variante Shopify</span>
              <span className="block truncate font-mono text-xs text-zinc-500">
                #{value.id}
                {lookup === "loading" && <span className="font-sans"> · chargement…</span>}
              </span>
            </>
          )}
        </span>
        <button
          type="button"
          id={inputId}
          onClick={clear}
          aria-describedby={describedBy}
          aria-label={`Retirer le produit${product ? ` ${product.title}` : ""} (choisir un autre produit)`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-900"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      {hiddenField}
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
        value={query}
        placeholder="Rechercher un produit ou coller un ID"
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
          {options.map((o, i) => (
            <li
              key={o.key}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(o)}
              onMouseMove={() => i !== activeIndex && setActive(i)}
              className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 text-sm ${i === activeIndex ? "bg-indigo-50 text-zinc-900" : "text-zinc-700"}`}
            >
              {o.kind === "manual" ? (
                <>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zinc-100 text-zinc-500" aria-hidden>
                    <Hash className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    Utiliser l&apos;ID de variante <span className="font-mono">{o.id}</span>
                  </span>
                </>
              ) : (
                <>
                  <Thumb src={o.variant.imageUrl ?? o.product.imageUrl} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{o.product.title}</span>
                    {o.variant.title !== "Default Title" && <span className="block truncate text-xs text-zinc-600">{o.variant.title}</span>}
                  </span>
                  <span className="shrink-0 text-xs font-medium text-zinc-600 tabular-nums">{stableCents(Math.round(Number(o.variant.price) * 100), currency)}</span>
                </>
              )}
            </li>
          ))}
        </ul>
        {!options.length && (
          <p className="px-3 py-3 text-sm text-zinc-500" role="status">
            {loading || results == null ? "Recherche…" : error ? `${error}. Vous pouvez coller l'ID de la variante.` : "Aucun produit trouvé."}
          </p>
        )}
        {options.length > 0 && error && <p className="px-3 pt-1 pb-2 text-xs text-zinc-500">{error}</p>}
      </div>
      <span className="sr-only" aria-live="polite">
        {open && !loading && results ? `${options.length} résultat${options.length > 1 ? "s" : ""}` : ""}
      </span>
    </div>
  );
}

