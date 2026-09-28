"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Loader2, Search, X } from "lucide-react";
import { downsellCycle, funnelDepth, upsellRoots, MAX_OFFER_DEPTH, MAX_OFFER_QUANTITY, type Block, type BlockOf, type UpsellConditions } from "@/lib/layout";
import { searchCatalog, searchCollections } from "@/lib/catalog";
import { CountryMultiSelect } from "@/components/dashboard/CountryMultiSelect";
import { PriceInput } from "./BlockEditor";

const input =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500 focus-visible:outline-solid";
const ring = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 focus-visible:outline-solid";

type Upsell = BlockOf<"upsell">;

/** Collapsible group of the block inspector (closed by default), with a one-line summary. */
export function EditorAccordion({ title, summary, defaultOpen = false, children }: { title: string; summary?: string; defaultOpen?: boolean; children: ReactNode }) {
  return (
    <details open={defaultOpen} className="group rounded-lg border border-zinc-200 bg-white">
      <summary className={`flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-zinc-900 ${ring}`}>
        <span className="shrink-0">{title}</span>
        {summary && <span className="min-w-0 flex-1 truncate text-right text-[11px] font-normal text-zinc-600">{summary}</span>}
        <ChevronDown className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition group-open:rotate-180 ${summary ? "" : "ml-auto"}`} aria-hidden />
      </summary>
      <div className="space-y-3 border-t border-zinc-100 p-3">{children}</div>
    </details>
  );
}

/** Units the buyer may take in one click (quantity selector above 1). */
export function UpsellQuantity({ block, onChange }: { block: Upsell; onChange: (b: Upsell) => void }) {
  const uid = useId();
  return (
    <div role="group" aria-labelledby={`${uid}-qty`}>
      <span id={`${uid}-qty`} className="mb-1 block text-xs font-medium text-zinc-700">
        Quantité maximale
      </span>
      <div className="grid grid-cols-5 gap-0.5 rounded-md border border-zinc-300 bg-white p-0.5">
        {Array.from({ length: MAX_OFFER_QUANTITY }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            aria-pressed={block.props.maxQuantity === n}
            onClick={() => onChange({ ...block, props: { ...block.props, maxQuantity: n } })}
            className={`min-h-8 rounded px-2 py-1 text-xs ${ring} ${block.props.maxQuantity === n ? "bg-zinc-900 font-medium text-white" : "text-zinc-700 hover:bg-zinc-100"}`}
          >
            {n}
          </button>
        ))}
      </div>
      <span className="mt-1 block text-[11px] text-zinc-600">Au-delà de 1, le client choisit la quantité ; le total est débité en un clic.</span>
    </div>
  );
}

/** Inspector part of an upsell block: targeting (collapsed), downsell after a decline. */
export function UpsellRules({
  block,
  blocks,
  storeId,
  productTitles = {},
  onChange,
}: {
  block: Upsell;
  /** Every block of the page (other offers for the downsell). */
  blocks: Block[];
  storeId: string | null;
  /** Known product names (sample cart…), by GID. */
  productTitles?: Record<string, string>;
  onChange: (b: Upsell) => void;
}) {
  const uid = useId();
  const c = block.props.conditions;
  const setConditions = (patch: Partial<UpsellConditions>) => onChange({ ...block, props: { ...block.props, conditions: { ...c, ...patch } } });
  const others = blocks.filter((b): b is Upsell => b.type === "upsell" && b.id !== block.id);
  const declinedParents = others.filter((b) => b.props.declineNextId === block.id);
  const acceptedParents = others.filter((b) => b.props.acceptNextId === block.id);
  const next = block.props.declineNextId ?? "";
  const nextMissing = !!next && !others.some((b) => b.id === next);
  const acceptNext = block.props.acceptNextId ?? "";
  const acceptMissing = !!acceptNext && !others.some((b) => b.id === acceptNext);
  // Funnels longer than MAX_OFFER_DEPTH offers: the tail is never shown.
  const tooDeep = upsellRoots(blocks).some((r) => funnelDepth(blocks, r.id) > MAX_OFFER_DEPTH);
  const offerName = (b: Upsell, i: number) => `${b.props.title || `Offre ${i + 1}`}${b.hidden ? " (masquée)" : ""}`;
  const minInvalid = c.minSubtotal != null && c.maxSubtotal != null && c.maxSubtotal > 0 && c.minSubtotal > c.maxSubtotal;
  const ruleCount =
    (c.minSubtotal != null ? 1 : 0) +
    (c.maxSubtotal != null && c.maxSubtotal > 0 ? 1 : 0) +
    (c.productIds.length ? 1 : 0) +
    (c.countries.length ? 1 : 0) +
    (c.collectionIds?.length ? 1 : 0) +
    (c.variantIds?.length ? 1 : 0) +
    (c.customer && c.customer !== "any" ? 1 : 0) +
    (c.minUnits != null ? 1 : 0) +
    (c.maxUnits != null ? 1 : 0);
  const unitsInvalid = c.minUnits != null && c.maxUnits != null && c.minUnits > c.maxUnits;
  const setTitle = (id: string, title: string) => setConditions({ titles: { ...(c.titles ?? {}), [id]: title.slice(0, 160) } });
  const units = (v: string) => {
    const n = Math.floor(Number(v));
    return v.trim() && Number.isFinite(n) && n >= 1 ? Math.min(999, n) : undefined;
  };

  return (
    <div className="space-y-4">
      {declinedParents.length > 0 && (
        <p className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          Offre de repli : proposée seulement après un refus de {declinedParents.map((p) => `« ${p.props.title || "offre"} »`).join(" ou ")}.
        </p>
      )}
      {acceptedParents.length > 0 && (
        <p className="rounded-lg bg-emerald-50 px-3 py-2 text-[11px] leading-relaxed text-emerald-900">
          Étape suivante : proposée seulement après un « Oui » à {acceptedParents.map((p) => `« ${p.props.title || "offre"} »`).join(" ou ")}.
        </p>
      )}

      <EditorAccordion
        title="Afficher seulement si…"
        summary={ruleCount === 0 ? "Toutes les commandes" : `${ruleCount} condition${ruleCount > 1 ? "s" : ""}`}
        defaultOpen={minInvalid}
      >
        <p className="text-[11px] leading-relaxed text-zinc-600">Vide = pour toutes les commandes. Toutes les conditions remplies doivent être vraies ; vérifié au moment de l&apos;achat.</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-700">Sous-total min.</span>
            <PriceInput optional value={c.minSubtotal} onChange={(minSubtotal) => setConditions({ minSubtotal })} invalid={minInvalid} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-700">Sous-total max.</span>
            <PriceInput optional value={c.maxSubtotal} onChange={(maxSubtotal) => setConditions({ maxSubtotal })} invalid={minInvalid} />
          </label>
        </div>
        {minInvalid && <p className="text-[11px] text-amber-700">Le minimum dépasse le maximum : l&apos;offre ne sera jamais affichée.</p>}
        <div role="group" aria-labelledby={`${uid}-products`}>
          <span id={`${uid}-products`} className="mb-1 block text-xs font-medium text-zinc-700">
            La commande contient l&apos;un de ces produits
          </span>
          <ProductIdsField
            storeId={storeId}
            value={c.productIds}
            knownTitles={{ ...productTitles, ...(c.titles ?? {}) }}
            onTitle={setTitle}
            onChange={(productIds) => setConditions({ productIds })}
          />
        </div>
        <div role="group" aria-labelledby={`${uid}-variants`}>
          <span id={`${uid}-variants`} className="mb-1 block text-xs font-medium text-zinc-700">
            La commande contient l&apos;une de ces variantes
          </span>
          <ProductIdsField
            kind="variant"
            storeId={storeId}
            value={c.variantIds ?? []}
            knownTitles={c.titles ?? {}}
            onTitle={setTitle}
            onChange={(variantIds) => setConditions({ variantIds: variantIds.length ? variantIds : undefined })}
          />
        </div>
        <div role="group" aria-labelledby={`${uid}-collections`}>
          <span id={`${uid}-collections`} className="mb-1 block text-xs font-medium text-zinc-700">
            Un produit de la commande est dans l&apos;une de ces collections
          </span>
          <ProductIdsField
            kind="collection"
            storeId={storeId}
            value={c.collectionIds ?? []}
            knownTitles={c.titles ?? {}}
            onTitle={setTitle}
            onChange={(collectionIds) => setConditions({ collectionIds: collectionIds.length ? collectionIds : undefined })}
          />
          <span className="mt-1 block text-[11px] text-zinc-600">Collections lues dans Shopify au moment de l&apos;achat (mises en cache 10 minutes).</span>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-zinc-700">Client</span>
          <select className={input} value={c.customer ?? "any"} onChange={(e) => setConditions({ customer: e.target.value === "any" ? undefined : (e.target.value as "new" | "returning") })}>
            <option value="any">Tous les clients</option>
            <option value="new">Nouveaux clients (1re commande)</option>
            <option value="returning">Clients déjà venus (commande précédente avec le même e-mail)</option>
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-700">Articles min.</span>
            <input
              type="number"
              min={1}
              max={999}
              inputMode="numeric"
              className={input}
              value={c.minUnits ?? ""}
              aria-invalid={unitsInvalid}
              onChange={(e) => setConditions({ minUnits: units(e.target.value) })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-zinc-700">Articles max.</span>
            <input
              type="number"
              min={1}
              max={999}
              inputMode="numeric"
              className={input}
              value={c.maxUnits ?? ""}
              aria-invalid={unitsInvalid}
              onChange={(e) => setConditions({ maxUnits: units(e.target.value) })}
            />
          </label>
        </div>
        {unitsInvalid && <p className="text-[11px] text-amber-700">Le minimum d&apos;articles dépasse le maximum : l&apos;offre ne sera jamais affichée.</p>}
        <div>
          <label htmlFor={`${uid}-countries`} className="mb-1 block text-xs font-medium text-zinc-700">
            Pays de livraison
          </label>
          <CountriesField id={`${uid}-countries`} value={c.countries} onChange={(countries) => setConditions({ countries })} />
        </div>
        <label className="flex items-start gap-2 text-xs font-medium text-zinc-700">
          <input
            type="checkbox"
            checked={block.props.excludePurchased}
            onChange={(e) => onChange({ ...block, props: { ...block.props, excludePurchased: e.target.checked } })}
            className="mt-0.5 h-3.5 w-3.5 accent-zinc-900"
          />
          <span>
            Exclure si déjà acheté
            <span className="block font-normal text-zinc-600">Masquée quand le produit offert est déjà dans la commande.</span>
          </span>
        </label>
      </EditorAccordion>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-700">Si acceptée, proposer ensuite</span>
        <select
          className={input}
          value={acceptMissing ? "" : acceptNext}
          onChange={(e) => onChange({ ...block, props: { ...block.props, acceptNextId: e.target.value || undefined } })}
        >
          <option value="">Rien (fin des offres)</option>
          {others.map((b, i) => {
            const cycle = downsellCycle(blocks, block.id, b.id);
            return (
              <option key={b.id} value={b.id} disabled={cycle || b.id === next}>
                {offerName(b, i)}
                {cycle ? " — boucle impossible" : b.id === next ? " — déjà l'offre de repli" : ""}
              </option>
            );
          })}
        </select>
        <span className="mt-1 block text-[11px] text-zinc-600">
          Après « Oui », la confirmation reste affichée et l&apos;offre choisie apparaît juste en dessous (upsell en cascade).
        </span>
      </label>

      <label className="block">
        <span className="mb-1 block text-xs font-medium text-zinc-700">Si refusée, proposer</span>
        <select
          className={input}
          value={nextMissing ? "" : next}
          onChange={(e) => onChange({ ...block, props: { ...block.props, declineNextId: e.target.value || undefined } })}
        >
          <option value="">Rien (fin des offres)</option>
          {others.map((b, i) => {
            const cycle = downsellCycle(blocks, block.id, b.id);
            return (
              <option key={b.id} value={b.id} disabled={cycle || b.id === acceptNext}>
                {offerName(b, i)}
                {cycle ? " — boucle impossible" : b.id === acceptNext ? " — déjà l'étape suivante" : ""}
              </option>
            );
          })}
        </select>
        <span className="mt-1 block text-[11px] text-zinc-600">
          {others.length === 0
            ? "Ajoutez un deuxième bloc « Offre post-achat » (ex. le même produit moins cher) pour proposer une offre de repli."
            : "L'offre choisie remplace celle-ci après « Non merci » (downsell) ; elle n'est jamais affichée seule."}
        </span>
      </label>
      {tooDeep && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900">
          Un parcours dépasse {MAX_OFFER_DEPTH} offres d&apos;affilée : au-delà de la 3ᵉ, les offres ne sont pas proposées.
        </p>
      )}
    </div>
  );
}

/** Euro amount that may be left empty (no limit). */
const numericId = (id: string) => id.match(/(\d+)\D*$/)?.[1] ?? id;
type IdKind = "product" | "variant" | "collection";
type Option = { id: string; title: string };
const KIND_TEXT: Record<IdKind, { noun: string; placeholder: string; paste: string; gid: string; path: RegExp }> = {
  product: { noun: "produit", placeholder: "Rechercher ou coller un ID produit", paste: "…/products/123", gid: "Product", path: /\/products\/(\d+)/ },
  variant: { noun: "variante", placeholder: "Rechercher un produit ou coller un ID variante", paste: "…/variants/123", gid: "ProductVariant", path: /\/variants\/(\d+)/ },
  collection: { noun: "collection", placeholder: "Rechercher ou coller un ID collection", paste: "…/collections/123", gid: "Collection", path: /\/collections\/(\d+)/ },
};

/** A pasted id, gid or admin URL (…/products/123, …/variants/123, …/collections/123). */
function manualId(q: string, kind: IdKind): string | null {
  const t = q.trim();
  const k = KIND_TEXT[kind];
  if (new RegExp(`^gid://shopify/${k.gid}/\\d+$`).test(t)) return t;
  if (/^\d{5,}$/.test(t)) return `gid://shopify/${k.gid}/${t}`;
  const m = t.match(k.path);
  return m ? `gid://shopify/${k.gid}/${m[1]}` : null;
}

/** Search results of a kind: products, their variants ("Produit – Variante"), or collections. */
async function searchIds(kind: IdKind, storeId: string, q: string): Promise<{ ok: boolean; data: Option[]; error?: string }> {
  if (kind === "collection") {
    const r = await searchCollections(storeId, q);
    return r.ok ? { ok: true, data: r.data } : { ok: false, data: [], error: r.error };
  }
  const r = await searchCatalog(storeId, q);
  if (!r.ok) return { ok: false, data: [], error: r.error };
  return {
    ok: true,
    data: kind === "product" ? r.data.map((p) => ({ id: p.id, title: p.title })) : r.data.flatMap((p) => p.variants.map((v) => ({ id: v.id, title: v.title === "Default Title" ? p.title : `${p.title} – ${v.title}` }))),
  };
}

/** Shopify products / variants / collections (GIDs): search when Shopify is connected, or a pasted id. */
function ProductIdsField({
  storeId,
  value,
  knownTitles,
  onChange,
  kind = "product",
  onTitle,
  label: fieldLabel,
}: {
  storeId: string | null;
  value: string[];
  knownTitles: Record<string, string>;
  onChange: (ids: string[]) => void;
  kind?: IdKind;
  /** Titles picked, to keep them with the rule (chips after a reload). */
  onTitle?: (id: string, title: string) => void;
  label?: string;
}) {
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Option[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const seq = useRef(0);
  const k = KIND_TEXT[kind];

  useEffect(() => {
    if (!open || !storeId) return;
    const t = setTimeout(() => {
      const id = ++seq.current;
      setLoading(true);
      searchIds(kind, storeId, query)
        .then((r) => {
          if (id !== seq.current) return;
          setResults(r.data);
          setError(r.ok ? null : (r.error ?? null));
          setActive(0);
        })
        .catch(() => id === seq.current && (setResults([]), setError("Recherche Shopify indisponible")))
        .finally(() => id === seq.current && setLoading(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query, open, storeId, kind]);

  const manual = manualId(query, kind);
  const options = (results ?? []).filter((p) => !value.includes(p.id)).slice(0, 30);
  const activeIndex = Math.min(active, Math.max(0, options.length - 1));
  const full = value.length >= 50;
  const label = (id: string) => titles[id] ?? knownTitles[id] ?? `${k.noun.charAt(0).toUpperCase()}${k.noun.slice(1)} #${numericId(id)}`;

  function add(id: string, title?: string) {
    if (title) {
      setTitles((t) => ({ ...t, [id]: title }));
      onTitle?.(id, title);
    }
    if (!value.includes(id)) onChange([...value, id]);
    setQuery("");
    setOpen(false);
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${k.noun}s choisi(e)s`}>
          {value.map((id) => (
            <li key={id} className="flex max-w-full items-center gap-1 rounded-full bg-white py-0.5 pr-0.5 pl-2.5 text-xs ring-1 ring-zinc-200">
              <span className="min-w-0 truncate" title={id}>
                {label(id)}
              </span>
              <button
                type="button"
                onClick={() => onChange(value.filter((x) => x !== id))}
                aria-label={`Retirer ${label(id)}`}
                className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 ${ring}`}
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" aria-hidden />
        <input
          type="text"
          role="combobox"
          aria-label={fieldLabel ?? `Rechercher un(e) ${k.noun} ou coller son ID`}
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options.length ? `${listId}-opt-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={full}
          value={query}
          placeholder={storeId ? k.placeholder : `ID ${k.noun} (gid://shopify/${k.gid}/…)`}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!open) return setOpen(true);
              if (!options.length) return;
              setActive((i) => (Math.min(i, options.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (manual) add(manual);
              else if (open && options[activeIndex]) add(options[activeIndex].id, options[activeIndex].title);
            } else if (e.key === "Escape" && open) {
              e.preventDefault();
              setOpen(false);
            }
          }}
          className={`${input} pr-8 pl-8`}
        />
        {loading && open && <Loader2 className="absolute top-1/2 right-2.5 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-zinc-400" aria-hidden />}
        <div className={`absolute inset-x-0 top-full z-30 mt-1 max-h-60 overflow-y-auto rounded-lg bg-white p-1 shadow-lg ring-1 ring-zinc-900/10 ${open && (query || storeId) ? "" : "hidden"}`}>
          <ul id={listId} role="listbox" aria-label={`Résultats Shopify (${k.noun}s)`}>
            {options.map((p, i) => (
              <li
                key={p.id}
                id={`${listId}-opt-${i}`}
                role="option"
                aria-selected={i === activeIndex}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(p.id, p.title)}
                className={`flex min-h-9 cursor-pointer items-center rounded-md px-2 py-1 text-sm ${i === activeIndex ? "bg-indigo-50 text-zinc-900" : "text-zinc-700"}`}
              >
                <span className="truncate">{p.title}</span>
              </li>
            ))}
          </ul>
          {!options.length && (
            <p className="px-2 py-2 text-xs text-zinc-600" role="status">
              {manual
                ? `Entrée pour ajouter cet ID ${k.noun}.`
                : !storeId
                  ? `Collez un ID ${k.noun} Shopify.`
                  : loading || results == null
                    ? "Recherche…"
                    : error
                      ? `${error} — collez l'ID (${k.paste}).`
                      : "Aucun résultat."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Shipping countries: the dashboard's searchable chip picker (CountryMultiSelect). It is
 * uncontrolled (form field), so its hidden input's `input` events report the selection, and
 * it is remounted only when the value changes from outside (undo, another block).
 */
function CountriesField({ id, value, onChange }: { id: string; value: string[]; onChange: (codes: string[]) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const name = `${id}-value`;
  const joined = value.join(", ");
  // Last selection the picker reported (a change we caused needs no remount).
  const [reported, setReported] = useState(joined);
  const [generation, setGeneration] = useState(0);
  const [mountedFor, setMountedFor] = useState(joined);
  if (joined !== mountedFor) {
    setMountedFor(joined);
    if (joined !== reported) {
      // Changed outside the picker (undo, redo…): start it again from the new value.
      setReported(joined);
      setGeneration((g) => g + 1);
    }
  }
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onInput = (e: Event) => {
      const target = e.target as HTMLInputElement | null;
      if (target?.name !== name) return;
      const codes = target.value
        .split(",")
        .map((x) => x.trim().toUpperCase())
        .filter((x) => /^[A-Z]{2}$/.test(x));
      setReported(codes.join(", "));
      latest.current(codes);
    };
    el.addEventListener("input", onInput);
    return () => el.removeEventListener("input", onInput);
  }, [name]);
  return (
    <div ref={root}>
      <CountryMultiSelect key={generation} id={id} name={name} defaultValue={value} emptyPlaceholder="Tous les pays" />
    </div>
  );
}
