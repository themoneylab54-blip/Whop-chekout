"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Gift, Layers, Plus, Trash2 } from "lucide-react";
import { inputClass } from "@/components/ui";
import {
  MAX_GIFT_TIERS,
  MAX_PERCENT_TIERS,
  TIER_LIMITS,
  breakKind,
  parseGiftTiers,
  parseQuantityBreaks,
  tierOrderWarnings,
  validateQuantityTiers,
  type BreakKind,
  type GiftTier,
  type QuantityBreak,
} from "@/lib/pricing";
import type { Lang } from "@/components/checkout/i18n";
import { RecordTranslationsEditor } from "./RecordTranslations";
import { ProductPicker, variantLabel } from "./ProductPicker";
import { ProductMultiPicker, type PickedProduct } from "./ProductMultiPicker";

/** A discount tier row: `format` is the tier's kind (percent, amount off, bundle price, buy X get Y). */
type Row =
  | {
      key: number;
      kind: "percent";
      format: BreakKind;
      minQty: string;
      percent: string;
      /** "amount": major units; "price": bundle price in major units. */
      amount: string;
      per: "unit" | "bundle";
      price: string;
      freeQty: string;
      scoped: boolean;
      products: PickedProduct[];
    }
  | {
      key: number;
      kind: "gift";
      variantId: string;
      title: string;
      mode: "qty" | "amount";
      threshold: string;
      scoped: boolean;
      products: PickedProduct[];
      i18n?: GiftTier["i18n"];
    };

const num = (v: string) => Number(v.trim().replace(",", "."));

/** Stored shape of a discount row (the server validates the same object). */
function tierOf(r: Extract<Row, { kind: "percent" }>): Record<string, unknown> {
  const minQty = num(r.minQty);
  if (r.format === "amount") return { kind: "amount", minQty, amountCents: Math.round(num(r.amount) * 100), per: r.per };
  if (r.format === "price") return { kind: "price", minQty, priceCents: Math.round(num(r.price) * 100) };
  if (r.format === "bxgy") return { kind: "bxgy", minQty, freeQty: num(r.freeQty) };
  return { minQty, percent: num(r.percent) };
}
const pct = (p: number) => `${String(p).replace(".", ",")} %`;
const variantNumber = (v: string) => v.match(/(\d+)\D*$/)?.[1] ?? v;

/** Chips of a scope: titles saved with the tiers (productTitles), else "Produit #123". */
function productsOf(raw: unknown, ids: string[] | undefined): PickedProduct[] {
  const titles = raw && typeof raw === "object" ? ((raw as { productTitles?: Record<string, string> }).productTitles ?? {}) : {};
  return (ids ?? []).map((id) => ({ id, title: typeof titles[id] === "string" ? titles[id] : `Produit #${variantNumber(id)}` }));
}

/** From this percentage a small note says the total may fall below the payment minimum. */
export const HIGH_PERCENT_NOTE_FROM = 80;
/**
 * Info (never blocking) for a large percent: on a cheap item the discounted total may end below
 * the 0,50 minimum a card payment accepts. Null under HIGH_PERCENT_NOTE_FROM. Pure.
 */
export function highPercentNote(percent: string, money: (v: string) => string): string | null {
  const p = num(percent);
  if (!Number.isFinite(p) || p < HIGH_PERCENT_NOTE_FROM || p > TIER_LIMITS.maxPercent) return null;
  return `À −${String(p).replace(".", ",")} %, le total d'un article bon marché peut passer sous le minimum de paiement (${money("0,5")}).`;
}

/** Editor rows from the stored JSON (older stores: `[{minQty, percent}]`). */
function toRows(raw: unknown, from = 0): Row[] {
  const list = Array.isArray(raw) ? raw : [];
  const rawOf = (pred: (x: Record<string, unknown>) => boolean) => list.find((x) => x && typeof x === "object" && pred(x as Record<string, unknown>));
  const rows: Row[] = [];
  let k = from;
  const major = (c: number | undefined) => (c == null ? "" : String(c / 100).replace(".", ","));
  for (const b of parseQuantityBreaks(raw)) {
    const src = rawOf((x) => x.type !== "gift" && Number(x.minQty) === b.minQty && (x.kind ?? "percent") === breakKind(b) && (breakKind(b) !== "percent" || Number(x.percent) === b.percent));
    rows.push({
      key: k++,
      kind: "percent",
      format: breakKind(b),
      minQty: String(b.minQty),
      percent: b.percent ? String(b.percent).replace(".", ",") : "10",
      amount: major(b.amountCents) || "5",
      per: b.per ?? "unit",
      price: major(b.priceCents),
      freeQty: String(b.freeQty ?? 1),
      scoped: !!b.productIds?.length,
      products: productsOf(src, b.productIds),
    });
  }
  for (const g of parseGiftTiers(raw)) {
    const src = rawOf((x) => x.type === "gift" && variantNumber(String(x.variantId ?? "")) === variantNumber(g.variantId));
    rows.push({
      key: k++,
      kind: "gift",
      variantId: variantNumber(g.variantId),
      title: g.title,
      mode: g.minQty != null ? "qty" : "amount",
      threshold: g.minQty != null ? String(g.minQty) : String((g.minSubtotalCents ?? 0) / 100).replace(".", ","),
      scoped: !!g.productIds?.length,
      products: productsOf(src, g.productIds),
      i18n: g.i18n,
    });
  }
  return rows;
}

/** One message per row (null = valid); cross-tier rules come from the server's own validation. */
function rowError(r: Row): string | null {
  if (r.kind === "percent") {
    const q = num(r.minQty);
    if (r.format === "bxgy") {
      if (!r.minQty.trim() || !Number.isInteger(q) || q < 1 || q > TIER_LIMITS.maxBuy) return `Articles achetés : entier de 1 à ${TIER_LIMITS.maxBuy}`;
      const f = num(r.freeQty);
      if (!Number.isInteger(f) || f < 1 || f > TIER_LIMITS.maxFree) return `Articles offerts : entier de 1 à ${TIER_LIMITS.maxFree}`;
    } else if (!r.minQty.trim() || !Number.isInteger(q) || q < 2 || q > TIER_LIMITS.maxQty) return `Nombre d'articles : entier de 2 à ${TIER_LIMITS.maxQty}`;
    if (r.format === "percent") {
      const p = num(r.percent);
      if (!r.percent.trim() || !Number.isFinite(p) || p <= 0 || p > TIER_LIMITS.maxPercent) return `Remise : plus de 0 et au plus ${TIER_LIMITS.maxPercent} %`;
      if (!/^\d+([.,]\d)?$/.test(r.percent.trim())) return "Remise : une décimale au plus (ex. 12,5)";
    }
    if (r.format === "amount" && !(num(r.amount) > 0 && num(r.amount) <= 100_000)) return "Montant de la remise : plus de 0";
    if (r.format === "price" && !r.price.trim()) return "Indiquez le prix du lot";
    if (r.format === "price" && !(num(r.price) > 0 && num(r.price) <= 100_000)) return "Prix du lot : plus de 0 (ex. 49)";
  } else {
    if (!r.variantId) return "Choisissez le produit offert";
    if (!r.title.trim()) return "Donnez un nom au cadeau (affiché au client)";
    const t = num(r.threshold);
    if (r.mode === "qty" && (!Number.isInteger(t) || t < 1 || t > TIER_LIMITS.maxQty)) return `Nombre d'articles : entier de 1 à ${TIER_LIMITS.maxQty}`;
    if (r.mode === "amount" && (!Number.isFinite(t) || t <= 0 || t > 1_000_000)) return "Montant : plus de 0";
  }
  if (r.scoped && r.products.length === 0) return "Choisissez au moins un produit, ou appliquez à tout le panier";
  return null;
}

/**
 * Quantity breaks v2: percent tiers ("Dès 2 articles → −10 %") and free gifts ("Dès 50 € →
 * bougie offerte"), each for the whole cart or only some products. Posted as one `tier`
 * field per row (`percent:<key>` / `gift:<key>`) with its own fields; validated again on save.
 */
export function QuantityBreaksEditor({ initial, storeId, currency, baseLang = "fr" }: { initial: unknown; storeId: string; currency: string; baseLang?: Lang }) {
  const [rows, setRows] = useState<Row[]>(() => toRows(initial));
  // Row keys (and so field ids) are deterministic for hydration; new rows count up from here.
  const seq = useRef(rows.length);
  const uid = useId().replace(/:/g, "");
  const [touched, setTouched] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  // Rows added / removed from code: tell the form (dirty tracking listens to `input`).
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    box.current?.dispatchEvent(new Event("input", { bubbles: true }));
  }, [rows.length]);

  // Never submit a row the checkout would read differently (e.g. "some products" with none).
  const invalidRef = useRef(false);
  useEffect(() => {
    invalidRef.current = rows.some((r) => rowError(r) != null);
  }, [rows]);
  useEffect(() => {
    const form = box.current?.closest("form");
    if (!form) return;
    const onSubmit = (e: Event) => {
      if (!invalidRef.current) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setTouched(true);
      // Once the errors are drawn: the empty field first (e.g. the bundle price), else the first invalid one.
      requestAnimationFrame(() => {
        const root = box.current;
        (root?.querySelector<HTMLElement>("input[aria-invalid=true]:placeholder-shown") ?? root?.querySelector<HTMLElement>("[aria-invalid=true]"))?.focus();
      });
    };
    form.addEventListener("submit", onSubmit, true);
    return () => form.removeEventListener("submit", onSubmit, true);
  }, []);

  // "Annuler": back to the saved tiers.
  useEffect(() => {
    const form = box.current?.closest("form");
    if (!form) return;
    const onReset = () => {
      const fresh = toRows(initial, seq.current);
      seq.current += fresh.length;
      setRows(fresh);
      setTouched(false);
    };
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [initial]);

  const percents = rows.filter((r) => r.kind === "percent");
  const gifts = rows.filter((r) => r.kind === "gift");
  const errors = rows.map(rowError);
  // Whole-cart tiers: one per quantity (same rule as the server).
  const unscoped = percents.filter((r) => !r.scoped && !errors[rows.indexOf(r)]);
  const crossError = (() => {
    const v = validateQuantityTiers(unscoped.map((r) => (r.kind === "percent" ? tierOf(r) : {})));
    return v.ok ? null : v.error;
  })();
  // A bigger quantity giving no bigger discount: a note only, saving is never refused for it.
  const orderNotes = tierOrderWarnings(parseQuantityBreaks(unscoped.map((r) => (r.kind === "percent" ? tierOf(r) : {}))) as QuantityBreak[]);
  const update = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? ({ ...r, ...patch } as Row) : r)));

  function addPercent() {
    const last = percents
      .filter((r) => !r.scoped)
      .map((r) => ({ q: num(r.minQty), p: num(r.percent) }))
      .filter((r) => Number.isFinite(r.q))
      .sort((a, b) => a.q - b.q)
      .pop();
    const q = last ? Math.min(TIER_LIMITS.maxQty, last.q + 1) : 2;
    const p = last && Number.isFinite(last.p) ? Math.min(TIER_LIMITS.maxPercent, last.p + 5) : 10;
    const key = seq.current++;
    setRows((rs) => [...rs, { key, kind: "percent", format: "percent", minQty: String(q), percent: String(p), amount: "5", per: "unit", price: "", freeQty: "1", scoped: false, products: [] }]);
    setTimeout(() => document.getElementById(`${uid}-${key}-qty`)?.focus(), 0);
  }
  function addGift() {
    const key = seq.current++;
    setRows((rs) => [...rs, { key, kind: "gift", variantId: "", title: "", mode: "amount", threshold: "50", scoped: false, products: [] }]);
    setTimeout(() => document.getElementById(`${uid}-${key}-gift`)?.focus(), 0);
  }

  const money = (v: string) => new Intl.NumberFormat("fr-FR", { style: "currency", currency }).format(num(v));
  const summary = rows
    .filter((r, i) => !errors[i])
    .map((r) => {
      const scope = r.scoped ? ` (${r.products.length} produit${r.products.length > 1 ? "s" : ""})` : "";
      if (r.kind === "percent") {
        if (r.format === "amount") return `dès ${r.minQty} articles${scope} : −${money(r.amount)} ${r.per === "bundle" ? `par lot de ${r.minQty}` : "par article"}`;
        if (r.format === "price") return `${r.minQty} pour ${money(r.price)}${scope}`;
        if (r.format === "bxgy") return `${r.minQty} acheté${num(r.minQty) > 1 ? "s" : ""}, ${r.freeQty} offert${num(r.freeQty) > 1 ? "s" : ""} (le moins cher)${scope}`;
        return `dès ${r.minQty} articles${scope} : −${pct(num(r.percent))}`;
      }
      return `« ${r.title.trim()} » offert dès ${r.mode === "qty" ? `${r.threshold} articles` : money(r.threshold)}${scope}`;
    });

  const scopeField = (r: Row) => (
    <div className="mt-2 space-y-2 pl-0.5">
      <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-700">
        <legend className="sr-only">Articles comptés</legend>
        <label className="inline-flex min-h-8 items-center gap-1.5">
          <input type="radio" name={`scopeMode-${r.key}`} value="all" checked={!r.scoped} onChange={() => update(r.key, { scoped: false })} className="accent-indigo-600" />
          Tout le panier
        </label>
        <label className="inline-flex min-h-8 items-center gap-1.5">
          <input type="radio" name={`scopeMode-${r.key}`} value="some" checked={r.scoped} onChange={() => update(r.key, { scoped: true })} className="accent-indigo-600" />
          Seulement certains produits
        </label>
      </fieldset>
      {r.scoped && (
        <div
          onInput={(e) => {
            // The picker posts hidden JSON fields: mirror them for validation and the summary.
            const root = e.currentTarget;
            const picked = [...root.querySelectorAll<HTMLInputElement>(`input[type=hidden][name="scope-${r.key}"]`)].flatMap((el) => {
              try {
                const p = JSON.parse(el.value) as PickedProduct;
                return p?.id ? [p] : [];
              } catch {
                return [];
              }
            });
            if (picked.map((p) => p.id).join() !== r.products.map((p) => p.id).join()) update(r.key, { products: picked });
          }}
        >
          <label htmlFor={`${uid}-${r.key}-scope`} className="mb-1 block text-xs font-medium text-zinc-700">
            Produits comptés {r.kind === "percent" ? "et remisés" : ""}
          </label>
          <ProductMultiPicker storeId={storeId} name={`scope-${r.key}`} inputId={`${uid}-${r.key}-scope`} initial={r.products} max={50} />
        </div>
      )}
    </div>
  );

  // An empty required field is flagged at once (e.g. "Prix du lot" picked, no price yet); other errors once touched.
  const emptyField = (r: Row) => r.kind === "percent" && (r.minQty === "" || (r.format === "percent" && r.percent === "") || (r.format === "price" && !r.price.trim()));
  const errorShown = (r: Row, i: number) => !!errors[i] && (touched || emptyField(r));
  const errorLine = (r: Row, i: number) => {
    const err = errors[i];
    const show = errorShown(r, i);
    return show ? (
      <p id={`${uid}-${r.key}-err`} className="mt-1 text-xs text-red-600">
        {err}
      </p>
    ) : null;
  };
  const removeButton = (r: Row, label: string) => (
    <button
      type="button"
      onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
      aria-label={label}
      className="ml-auto inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-zinc-500 transition hover:bg-red-50 hover:text-red-600"
    >
      <Trash2 className="h-4 w-4" aria-hidden />
    </button>
  );

  return (
    <div ref={box} className="space-y-5" onBlur={() => setTouched(true)}>
      <section aria-labelledby={`${uid}-pct-title`} className="space-y-3">
        <h3 id={`${uid}-pct-title`} className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
          <Layers className="h-4 w-4 text-pink-500" aria-hidden /> Remises par palier
        </h3>
        <p className="-mt-1 text-xs text-zinc-500">
          Remise en %, montant fixe (par article ou par lot), prix du lot (« 2 pour 49 € ») ou « X achetés, Y offerts » (les moins chers offerts). Affiché au client dans sa
          langue au checkout ; un seul palier s&apos;applique, celui qui fait le plus économiser.
        </p>
        {percents.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-sm text-zinc-500">Aucun palier : le prix ne dépend pas de la quantité.</p>
        ) : (
          <ul className="space-y-3" aria-label="Paliers de remise">
            {rows.map((r, i) => {
              if (r.kind !== "percent") return null;
              const qId = `${uid}-${r.key}-qty`;
              const pId = `${uid}-${r.key}-pct`;
              const invalid = errorShown(r, i);
              const errId = invalid ? `${uid}-${r.key}-err` : undefined;
              return (
                <li key={r.key} className="rounded-lg border border-zinc-200 p-3">
                  <input type="hidden" name="tier" value={`percent:${r.key}`} />
                  <div className="mb-2 flex flex-wrap items-center gap-1.5 text-xs">
                    <label htmlFor={`${uid}-${r.key}-format`} className="font-medium text-zinc-700">
                      Type d&apos;offre
                    </label>
                    <select
                      id={`${uid}-${r.key}-format`}
                      name={`format-${r.key}`}
                      value={r.format}
                      onChange={(e) => update(r.key, { format: e.target.value as BreakKind })}
                      className={`${inputClass} !w-auto !py-1 text-xs`}
                    >
                      <option value="percent">Remise en %</option>
                      <option value="amount">Montant fixe déduit</option>
                      <option value="price">Prix du lot (ex. 2 pour 49 €)</option>
                      <option value="bxgy">X achetés, Y offerts</option>
                    </select>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5 text-sm text-zinc-700">
                    {r.format === "bxgy" ? (
                      <>
                        <label htmlFor={qId} className="sr-only">
                          Articles achetés
                        </label>
                        <input
                          id={qId}
                          name={`minQty-${r.key}`}
                          type="number"
                          min={1}
                          max={TIER_LIMITS.maxBuy}
                          step={1}
                          inputMode="numeric"
                          required
                          value={r.minQty}
                          onChange={(e) => update(r.key, { minQty: e.target.value })}
                          aria-invalid={invalid}
                          aria-describedby={invalid ? `${uid}-${r.key}-err` : undefined}
                          className={`${inputClass} !w-16 tabular-nums`}
                        />
                        <span aria-hidden>achetés →</span>
                        <label htmlFor={`${uid}-${r.key}-free`} className="sr-only">
                          Articles offerts
                        </label>
                        <input
                          id={`${uid}-${r.key}-free`}
                          name={`freeQty-${r.key}`}
                          type="number"
                          min={1}
                          max={TIER_LIMITS.maxFree}
                          step={1}
                          inputMode="numeric"
                          required
                          value={r.freeQty}
                          onChange={(e) => update(r.key, { freeQty: e.target.value })}
                          aria-invalid={invalid}
                          aria-describedby={errId}
                          className={`${inputClass} !w-16 tabular-nums`}
                        />
                        <span>offert(s), le moins cher</span>
                      </>
                    ) : (
                      <>
                        <label htmlFor={qId}>{r.format === "price" ? "Lot de" : "Dès"}</label>
                        <input
                          id={qId}
                          name={`minQty-${r.key}`}
                          type="number"
                          min={2}
                          max={TIER_LIMITS.maxQty}
                          step={1}
                          inputMode="numeric"
                          required
                          value={r.minQty}
                          onChange={(e) => update(r.key, { minQty: e.target.value })}
                          aria-invalid={invalid}
                          aria-describedby={invalid ? `${uid}-${r.key}-err` : undefined}
                          className={`${inputClass} !w-16 tabular-nums`}
                        />
                        <span aria-hidden>articles →</span>
                      </>
                    )}
                    {r.format === "percent" && (
                      <>
                        <label htmlFor={pId} className="sr-only">
                          Remise en % dès {r.minQty || "N"} articles
                        </label>
                        <span className="relative">
                          <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-zinc-500" aria-hidden>
                            −
                          </span>
                          <input
                            id={pId}
                            name={`percent-${r.key}`}
                            type="text"
                            inputMode="decimal"
                            required
                            value={r.percent}
                            onChange={(e) => update(r.key, { percent: e.target.value })}
                            aria-invalid={invalid}
                            aria-describedby={invalid ? `${uid}-${r.key}-err` : undefined}
                            className={`${inputClass} !w-20 pr-6 pl-5 tabular-nums`}
                          />
                          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-zinc-500" aria-hidden>
                            %
                          </span>
                        </span>
                      </>
                    )}
                    {r.format === "amount" && (
                      <>
                        <label htmlFor={pId} className="sr-only">
                          Montant déduit ({currency})
                        </label>
                        <span aria-hidden>−</span>
                        <input
                          id={pId}
                          name={`amount-${r.key}`}
                          type="text"
                          inputMode="decimal"
                          required
                          value={r.amount}
                          onChange={(e) => update(r.key, { amount: e.target.value })}
                          aria-invalid={invalid}
                          aria-describedby={errId}
                          className={`${inputClass} !w-20 tabular-nums`}
                        />
                        <span>{currency}</span>
                        <select
                          name={`per-${r.key}`}
                          aria-label="Remise appliquée"
                          value={r.per}
                          onChange={(e) => update(r.key, { per: e.target.value === "bundle" ? "bundle" : "unit" })}
                          className={`${inputClass} !w-auto`}
                        >
                          <option value="unit">par article</option>
                          <option value="bundle">par lot de {r.minQty || "N"}</option>
                        </select>
                      </>
                    )}
                    {r.format === "price" && (
                      <>
                        <label htmlFor={pId}>pour</label>
                        <input
                          id={pId}
                          name={`price-${r.key}`}
                          type="text"
                          inputMode="decimal"
                          required
                          value={r.price}
                          placeholder="49"
                          onChange={(e) => update(r.key, { price: e.target.value })}
                          aria-invalid={invalid}
                          aria-describedby={errId}
                          className={`${inputClass} !w-20 tabular-nums`}
                        />
                        <span>{currency}</span>
                      </>
                    )}
                    {removeButton(r, `Retirer le palier dès ${r.minQty || "?"} articles`)}
                  </div>
                  {scopeField(r)}
                  {errorLine(r, i)}
                  {r.format === "percent" && !errors[i] && highPercentNote(r.percent, money) && (
                    <p className="mt-1 text-[11px] text-zinc-500">{highPercentNote(r.percent, money)}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {crossError && touched && <p className="text-xs text-red-600">{crossError}</p>}
        {/* Information only (the merchant's choice, saved as is): a plain grey line, no warning box. */}
        {orderNotes.map((n) => (
          <p key={n} className="text-[11px] text-zinc-500">
            {n} : ajouter des articles ne fait pas économiser plus.
          </p>
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={addPercent}
            disabled={percents.length >= MAX_PERCENT_TIERS}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:text-zinc-400 disabled:hover:bg-transparent"
          >
            <Plus className="h-4 w-4" aria-hidden /> Ajouter un palier
          </button>
          <span className="text-xs text-zinc-500">
            {percents.length}/{MAX_PERCENT_TIERS} paliers
          </span>
        </div>
      </section>

      <section aria-labelledby={`${uid}-gift-title`} className="space-y-3 border-t border-zinc-100 pt-4">
        <h3 id={`${uid}-gift-title`} className="flex items-center gap-1.5 text-sm font-semibold text-zinc-900">
          <Gift className="h-4 w-4 text-pink-500" aria-hidden /> Cadeaux offerts
        </h3>
        {gifts.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-200 px-3 py-4 text-center text-sm text-zinc-500">
            Aucun cadeau. Ex. : une mini-bougie offerte dès 50 € d&apos;achat (« Plus que 12 € pour la recevoir » au checkout).
          </p>
        ) : (
          <ul className="space-y-3" aria-label="Cadeaux">
            {rows.map((r, i) => {
              if (r.kind !== "gift") return null;
              const gId = `${uid}-${r.key}-gift`;
              const tId = `${uid}-${r.key}-title`;
              const hId = `${uid}-${r.key}-threshold`;
              const invalid = !!errors[i] && touched;
              return (
                <li key={r.key} className="space-y-2 rounded-lg border border-zinc-200 p-3">
                  <input type="hidden" name="tier" value={`gift:${r.key}`} />
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <label htmlFor={gId} className="mb-1 block text-xs font-medium text-zinc-700">
                        Produit offert
                      </label>
                      <ProductPicker
                        storeId={storeId}
                        name={`giftVariant-${r.key}`}
                        defaultValue={r.variantId || null}
                        currency={currency}
                        inputId={gId}
                        onPick={(picked) => {
                          if (!picked) return update(r.key, { variantId: "" });
                          const title = picked.product && picked.variant ? variantLabel(picked.product, picked.variant) : "";
                          update(r.key, { variantId: picked.id, ...(title && (!r.title.trim() || picked.id !== r.variantId) ? { title: title.slice(0, 120) } : {}) });
                        }}
                      />
                    </div>
                    {removeButton(r, `Retirer le cadeau ${r.title || ""}`.trim())}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <div className="min-w-48 flex-1">
                      <label htmlFor={tId} className="mb-1 block text-xs font-medium text-zinc-700">
                        Nom affiché au client
                      </label>
                      <input
                        id={tId}
                        name={`giftTitle-${r.key}`}
                        value={r.title}
                        maxLength={120}
                        placeholder="une bougie offerte"
                        onChange={(e) => update(r.key, { title: e.target.value })}
                        aria-invalid={invalid}
                        className={inputClass}
                      />
                    </div>
                    <div className="shrink-0">
                      <label htmlFor={hId} className="mb-1 block text-xs font-medium text-zinc-700">
                        Offert dès
                      </label>
                      <div className="flex gap-1.5">
                        <input
                          id={hId}
                          name={`giftThreshold-${r.key}`}
                          type="text"
                          inputMode="decimal"
                          value={r.threshold}
                          onChange={(e) => update(r.key, { threshold: e.target.value })}
                          aria-invalid={invalid}
                          className={`${inputClass} !w-24 tabular-nums`}
                        />
                        <select
                          name={`giftMode-${r.key}`}
                          aria-label="Unité du seuil"
                          value={r.mode}
                          onChange={(e) => update(r.key, { mode: e.target.value === "qty" ? "qty" : "amount" })}
                          className={`${inputClass} !w-auto`}
                        >
                          <option value="amount">{currency}</option>
                          <option value="qty">articles</option>
                        </select>
                      </div>
                    </div>
                  </div>
                  {scopeField(r)}
                  <RecordTranslationsEditor
                    name={`giftI18n-${r.key}`}
                    fields={[{ key: "title", label: "Nom affiché au client", base: r.title }]}
                    initial={r.i18n}
                    baseLang={baseLang}
                    onChange={(v) => update(r.key, { i18n: v as GiftTier["i18n"] })}
                  />
                  {errorLine(r, i)}
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={addGift}
            disabled={gifts.length >= MAX_GIFT_TIERS}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-indigo-600 transition hover:bg-indigo-50 disabled:cursor-not-allowed disabled:text-zinc-400 disabled:hover:bg-transparent"
          >
            <Plus className="h-4 w-4" aria-hidden /> Ajouter un cadeau
          </button>
          <span className="text-xs text-zinc-500">
            {gifts.length}/{MAX_GIFT_TIERS} cadeaux
          </span>
        </div>
      </section>

      <p aria-live="polite" className="rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-700 ring-1 ring-zinc-900/5">
        <span className="font-medium text-zinc-900">Aperçu : </span>
        {summary.length ? summary.join(" · ") : "aucune remise ni cadeau"}
      </p>
    </div>
  );
}
