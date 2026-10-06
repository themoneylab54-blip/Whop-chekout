"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, BadgeCheck, Pencil, Trash2, X } from "lucide-react";
import { editReviewItem, honestReviewItem, isImportedReview, MAX_REVIEW_ITEMS, REVIEW_LIMITS, reviewLostVerified, type ReviewItem } from "@/lib/layout";
import { Area, ImageField, StarPicker, Text, type ImageSource } from "./BlockEditor";
import { RING } from "./ui";

/*
 * The reviews of an « Avis clients » block (up to MAX_REVIEW_ITEMS): every review, imported or
 * typed, can be edited (name, stars, title, text, date, photo, product), moved, selected and
 * deleted in bulk. A compact line per review, the full form on « Modifier », listed by pages so
 * 300 reviews stay light. « Achat vérifié » stays on an imported review only while its text and
 * stars are the imported ones (editReviewItem); a review typed or pasted here never gets it.
 */

const linkBtn = `inline-flex items-center gap-1 rounded text-xs font-medium text-zinc-900 underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline ${RING}`;
const iconBtn = `rounded p-0.5 text-zinc-500 hover:text-zinc-900 disabled:opacity-30 ${RING}`;
const dateInput = "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-zinc-900";
/** Reviews listed at once in the editor. */
const PAGE = 20;
/** The counter turns amber this close to the maximum. */
const NEAR_MAX = 10;

export const MANUAL_REVIEW_NOTE = "Le badge Achat vérifié est réservé aux avis importés de vos commandes (règle anti faux avis).";
export const LOST_VERIFIED_NOTE = "Texte ou note modifié : le badge « Achat vérifié » est retiré (il ne vaut que pour l'avis tel que le client l'a écrit).";

// Stable ids for list rows (selection, open form) that follow a review when it moves or is edited.
const rowIds = new WeakMap<object, number>();
let nextRowId = 1;
function rowId(item: object): number {
  let id = rowIds.get(item);
  if (id == null) {
    id = nextRowId++;
    rowIds.set(item, id);
  }
  return id;
}

const frDate = (d: string) => d.split("-").reverse().join("/");

export function ReviewsList({
  items,
  onChange,
  images = [],
}: {
  items: ReviewItem[];
  onChange: (items: ReviewItem[]) => void;
  images?: ImageSource[];
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [shown, setShown] = useState(PAGE);
  const ids = items.map(rowId);
  const liveSelected = ids.filter((id) => selected.has(id));
  const allSelected = items.length > 0 && liveSelected.length === items.length;
  const full = items.length >= MAX_REVIEW_ITEMS;

  function edit(i: number, patch: Partial<ReviewItem>) {
    const next = editReviewItem(items[i], patch);
    rowIds.set(next, ids[i]);
    onChange(items.map((x, j) => (j === i ? next : x)));
  }
  function move(i: number, by: -1 | 1) {
    const j = i + by;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  }
  function remove(keep: (id: number) => boolean) {
    onChange(items.filter((_, i) => keep(ids[i])));
    setSelected(new Set());
  }
  function toggle(set: Set<number>, id: number): Set<number> {
    const n = new Set(set);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  }
  function addManual() {
    if (full) return;
    const item: ReviewItem = { name: "", text: "", stars: 5, verified: false, source: "manual" };
    setOpen((o) => new Set(o).add(rowId(item)));
    setShown((s) => Math.max(s, items.length + 1));
    onChange([...items, item]);
  }

  return (
    <div className="space-y-2" data-reviews-list>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={`text-xs font-medium tabular-nums ${items.length >= MAX_REVIEW_ITEMS - NEAR_MAX ? "text-amber-800" : "text-zinc-700"}`} data-reviews-count>
          {items.length}/{MAX_REVIEW_ITEMS} avis
          {full ? " (maximum atteint)" : items.length >= MAX_REVIEW_ITEMS - NEAR_MAX ? ` (plus que ${MAX_REVIEW_ITEMS - items.length} place${MAX_REVIEW_ITEMS - items.length > 1 ? "s" : ""})` : ""}
        </span>
        {items.length > 0 && (
          <>
            <label className="inline-flex items-center gap-1.5 text-xs text-zinc-700">
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-zinc-900"
                checked={allSelected}
                onChange={(e) => setSelected(e.target.checked ? new Set(ids) : new Set())}
              />
              Tout sélectionner
            </label>
            <button
              type="button"
              className={`${linkBtn} text-red-700`}
              disabled={liveSelected.length === 0}
              onClick={() => {
                if (window.confirm(`Supprimer ${liveSelected.length} avis sélectionné${liveSelected.length > 1 ? "s" : ""} ?`)) remove((id) => !selected.has(id));
              }}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden /> Supprimer la sélection{liveSelected.length > 0 ? ` (${liveSelected.length})` : ""}
            </button>
            <button
              type="button"
              className={`${linkBtn} text-red-700`}
              onClick={() => {
                if (window.confirm(`Supprimer les ${items.length} avis du bloc ? Cette action vide la liste.`)) remove(() => false);
              }}
            >
              Supprimer tous les avis
            </button>
          </>
        )}
      </div>
      <ul className="space-y-1.5">
        {items.slice(0, shown).map((r, i) => {
          const id = ids[i];
          const isOpen = open.has(id);
          const shownR = honestReviewItem(r);
          const imported = isImportedReview(r);
          return (
            <li key={id} className="space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-2" data-review-row>
              <div className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-zinc-900"
                  aria-label={`Sélectionner l'avis ${i + 1}${r.name ? ` de ${r.name}` : ""}`}
                  checked={selected.has(id)}
                  onChange={() => setSelected((s) => toggle(s, id))}
                />
                <div className="min-w-0 flex-1 text-xs text-zinc-800">
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-amber-600" role="img" aria-label={`${r.stars} sur 5`}>
                      {"★".repeat(r.stars)}
                      <span className="text-zinc-300">{"★".repeat(5 - r.stars)}</span>
                    </span>
                    <span className="font-medium break-words text-zinc-900">{r.name || "Sans nom"}</span>
                    {shownR.verified && (
                      <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-emerald-800">
                        <BadgeCheck className="h-3 w-3" aria-hidden /> Achat vérifié
                      </span>
                    )}
                    <span className="text-[11px] text-zinc-500">
                      {[r.source === "judgeme" ? "Judge.me" : r.source === "csv" ? "Importé (CSV)" : "", r.date ? frDate(r.date) : "", r.photoUrl ? "photo" : ""].filter(Boolean).join(" · ")}
                    </span>
                  </p>
                  {!isOpen && (
                    <p className={`line-clamp-2 break-words ${r.text.trim() ? "text-zinc-700" : "text-amber-800"}`}>
                      {r.title ? <strong className="font-medium">{r.title} · </strong> : null}
                      {r.text.trim() || "Texte vide : cet avis n'est pas affiché."}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button type="button" className={iconBtn} aria-label={`Monter l'avis ${i + 1}`} disabled={i === 0} onClick={() => move(i, -1)}>
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button type="button" className={iconBtn} aria-label={`Descendre l'avis ${i + 1}`} disabled={i === items.length - 1} onClick={() => move(i, 1)}>
                    <ArrowDown className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    className={iconBtn}
                    aria-label={isOpen ? `Fermer l'avis ${i + 1}` : `Modifier l'avis ${i + 1}`}
                    aria-expanded={isOpen}
                    onClick={() => setOpen((o) => toggle(o, id))}
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden />
                  </button>
                  <button type="button" className={`${iconBtn} hover:text-red-600`} aria-label={`Retirer l'avis ${i + 1}`} onClick={() => remove((x) => x !== id)}>
                    <X className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </div>
              </div>
              {isOpen && (
                <div className="space-y-2 border-t border-zinc-200 pt-2">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-medium text-zinc-700">Nom du client</span>
                      <Text label={`Nom du client (avis ${i + 1})`} placeholder="Prénom N." maxLength={REVIEW_LIMITS.name} value={r.name} onChange={(name) => edit(i, { name })} />
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-[11px] font-medium text-zinc-700">Date</span>
                      <input
                        type="date"
                        className={dateInput}
                        aria-label={`Date de l'avis ${i + 1}`}
                        value={r.date ?? ""}
                        onChange={(e) => edit(i, { date: /^\d{4}-\d{2}-\d{2}$/.test(e.target.value) ? e.target.value : undefined })}
                      />
                    </label>
                  </div>
                  <StarPicker value={r.stars} label={`Étoiles de l'avis de ${r.name || "ce client"}`} onChange={(stars) => edit(i, { stars })} />
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium text-zinc-700">Titre (facultatif)</span>
                    <Text label={`Titre de l'avis ${i + 1}`} maxLength={REVIEW_LIMITS.title} value={r.title ?? ""} onChange={(title) => edit(i, { title: title || undefined })} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium text-zinc-700">Avis</span>
                    <Area value={r.text} rows={4} maxLength={REVIEW_LIMITS.text} onChange={(text) => edit(i, { text })} />
                  </label>
                  <div role="group" aria-label={`Photo de l'avis ${i + 1}`}>
                    <span className="mb-1 block text-[11px] font-medium text-zinc-700">Photo (facultatif)</span>
                    <ImageField compact value={r.photoUrl ?? ""} images={images} onChange={(url) => edit(i, { photoUrl: url || undefined })} />
                  </div>
                  <label className="block">
                    <span className="mb-1 block text-[11px] font-medium text-zinc-700">Produit (facultatif)</span>
                    <Text
                      label={`Produit de l'avis ${i + 1}`}
                      placeholder="Nom du produit"
                      maxLength={255}
                      value={r.productTitle ?? ""}
                      onChange={(productTitle) => edit(i, { productTitle: productTitle || undefined })}
                    />
                  </label>
                  {imported ? (
                    reviewLostVerified(r) ? (
                      <p className="text-[11px] text-amber-800" data-lost-verified>
                        {LOST_VERIFIED_NOTE} Remettez le texte et la note d&apos;origine pour le retrouver.
                      </p>
                    ) : shownR.verified ? (
                      <p className="text-[11px] text-zinc-600">Achat vérifié : gardé tant que le texte et la note restent ceux de l&apos;avis importé.</p>
                    ) : (
                      <p className="text-[11px] text-zinc-600">Avis importé sans achat vérifié par votre application d&apos;avis.</p>
                    )
                  ) : (
                    <p className="text-[11px] text-zinc-600">{MANUAL_REVIEW_NOTE}</p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {items.length > shown && (
        <button type="button" className={linkBtn} onClick={() => setShown((s) => s + PAGE)}>
          Afficher {Math.min(PAGE, items.length - shown)} avis de plus ({items.length - shown} restants)
        </button>
      )}
      <div>
        <button type="button" className={linkBtn} disabled={full} onClick={addManual}>
          + Ajouter un avis à la main
        </button>
        {full && <p className="mt-1 text-[11px] text-amber-800">Maximum de {MAX_REVIEW_ITEMS} avis atteint : retirez-en pour en ajouter.</p>}
      </div>
    </div>
  );
}
