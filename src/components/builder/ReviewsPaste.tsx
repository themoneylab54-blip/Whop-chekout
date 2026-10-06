"use client";

import { useId, useState } from "react";
import { AlertTriangle, ClipboardPaste, Star } from "lucide-react";
import { MAX_REVIEW_ITEMS, REVIEW_LIMITS, type ReviewItem } from "@/lib/layout";
import { parsePastedReviews, pasteWarnings, roundedLabel, type PastedReview } from "@/lib/review-paste";
import { RING } from "./ui";

/*
 * « Coller des avis » (Avis clients block): a big text area, the reviews found in it shown in an
 * editable preview (stars, name, date, title, text, one checkbox each), then « Ajouter » or
 * « Remplacer tous les avis ». Pasted reviews are the merchant's own: never « Achat vérifié ».
 */

const btn = `inline-flex min-h-8 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50 ${RING}`;
const primary = `inline-flex min-h-8 items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 ${RING}`;
const field = "w-full rounded-md border border-zinc-300 bg-white px-2 py-1 text-xs outline-none focus:border-zinc-900";
/** Preview rows rendered at once (300+ reviews pasted stay light). */
const ROWS_PAGE = 50;

const PLACEHOLDER = `Collez vos avis ici, séparés par une ligne vide. Par exemple :

Marie D.
★★★★★
12/03/2025
Très contente, livraison rapide !

Paul R.
4/5
Bonne qualité, un peu long à arriver.

Ou un tableau copié d'un tableur : Nom;Note;Avis`;

type Draft = PastedReview & { id: number; on: boolean };

/** A pasted draft as a block review: typed by the merchant, so never verified. */
export function draftToReview(d: Pick<PastedReview, "name" | "text" | "stars" | "title" | "date">): ReviewItem {
  return {
    name: d.name.trim().slice(0, REVIEW_LIMITS.name),
    text: d.text.trim().slice(0, REVIEW_LIMITS.text),
    stars: Math.min(5, Math.max(1, Math.round(d.stars))),
    verified: false,
    source: "manual",
    ...(d.title?.trim() ? { title: d.title.trim().slice(0, REVIEW_LIMITS.title) } : {}),
    ...(d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? { date: d.date } : {}),
  };
}

export function ReviewsPaste({
  items,
  onApply,
}: {
  /** The block's reviews now. */
  items: ReviewItem[];
  onApply: (items: ReviewItem[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [dropped, setDropped] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(ROWS_PAGE);
  const [notice, setNotice] = useState<string | null>(null);
  const areaId = useId();

  const base = items;
  const room = Math.max(0, MAX_REVIEW_ITEMS - base.length);
  const picked = drafts?.filter((d) => d.on && d.text.trim()) ?? [];
  const selected = drafts?.filter((d) => d.on).length ?? 0;
  const allOn = !!drafts && drafts.length > 0 && drafts.every((d) => d.on);

  function analyse() {
    setError(null);
    const res = parsePastedReviews(text);
    if (res.reviews.length === 0) {
      setDrafts(null);
      return setError("Aucun avis trouvé : collez le texte de vos avis, en les séparant par une ligne vide.");
    }
    setDrafts(res.reviews.map((r, i) => ({ ...r, id: i, on: r.text.trim() !== "" })));
    setDropped(res.dropped);
    setShown(ROWS_PAGE);
  }
  function edit(id: number, patch: Partial<Draft>) {
    setDrafts((ds) => ds?.map((d) => (d.id === id ? { ...d, ...patch } : d)) ?? null);
  }
  function close() {
    setOpen(false);
    setDrafts(null);
    setText("");
    setError(null);
  }
  function add() {
    const fresh = picked.slice(0, room).map(draftToReview);
    const left = picked.length - fresh.length;
    onApply([...base, ...fresh]);
    setNotice(
      `${fresh.length} avis ajouté${fresh.length > 1 ? "s" : ""}.` +
        (left > 0 ? ` ${left} non ajouté${left > 1 ? "s" : ""} : ${MAX_REVIEW_ITEMS} avis maximum par bloc.` : ""),
    );
    close();
  }
  function replace() {
    const fresh = picked.slice(0, MAX_REVIEW_ITEMS).map(draftToReview);
    const kept = items.length;
    if (kept > 0 && !window.confirm(`Remplacer les ${kept} avis du bloc (avis importés compris) par ces ${fresh.length} avis ?`)) return;
    const left = picked.length - fresh.length;
    onApply(fresh);
    setNotice(`Avis remplacés : ${fresh.length} avis dans le bloc.` + (left > 0 ? ` ${left} non ajouté${left > 1 ? "s" : ""} : ${MAX_REVIEW_ITEMS} avis maximum par bloc.` : ""));
    close();
  }

  if (!open) {
    return (
      <div className="space-y-1">
        <button
          type="button"
          className={btn}
          onClick={() => {
            setOpen(true);
            setNotice(null);
          }}
          aria-expanded={false}
        >
          <ClipboardPaste className="h-3.5 w-3.5" aria-hidden /> Coller des avis
        </button>
        {notice && (
          <p role="status" className="text-[11px] text-emerald-800">
            {notice}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-zinc-300 bg-white p-3" data-reviews-paste>
      <label htmlFor={areaId} className="block text-xs font-semibold text-zinc-900">
        Coller des avis
      </label>
      <p className="text-[11px] leading-relaxed text-zinc-600">
        Un avis par paragraphe (ligne vide entre deux avis). Les étoiles (★★★★★, 5/5, 4,5/5, « 5 étoiles »), le nom (« — Marie » ou une première ligne
        courte), la date et le titre sont repérés tout seuls ; copier-coller depuis Judge.me, Trustpilot, Amazon, Shopify ou un tableur (Nom;Note;Avis)
        fonctionne aussi. Vous vérifiez tout avant d&apos;ajouter.
      </p>
      <textarea
        id={areaId}
        className={`${field} min-h-48 font-normal`}
        rows={10}
        value={text}
        placeholder={PLACEHOLDER}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={!text.trim()} onClick={analyse}>
          Analyser les avis
        </button>
        <button type="button" className={btn} onClick={close}>
          Annuler
        </button>
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 ring-1 ring-amber-200">
          {error}
        </p>
      )}
      {drafts && (
        <div className="space-y-2" data-paste-preview>
          <p role="status" className="text-xs text-zinc-800">
            <strong className="font-semibold">
              {drafts.length} avis trouvé{drafts.length > 1 ? "s" : ""}
            </strong>{" "}
            · {selected} sélectionné{selected > 1 ? "s" : ""}
            {dropped > 0 && <> · {dropped} de plus ignorés (trop d&apos;avis dans un seul collage)</>}
          </p>
          <label className="inline-flex items-center gap-1.5 text-[11px] font-medium text-zinc-800">
            <input type="checkbox" className="h-3.5 w-3.5 accent-zinc-900" checked={allOn} onChange={(e) => setDrafts((ds) => ds?.map((d) => ({ ...d, on: e.target.checked })) ?? null)} />
            Tout sélectionner
          </label>
          <ul className="max-h-[28rem] space-y-1.5 overflow-y-auto pr-1">
            {drafts.slice(0, shown).map((d, i) => (
              <DraftRow key={d.id} d={d} n={i + 1} onEdit={(patch) => edit(d.id, patch)} />
            ))}
          </ul>
          {drafts.length > shown && (
            <button type="button" className={btn} onClick={() => setShown((s) => s + ROWS_PAGE)}>
              Afficher {Math.min(ROWS_PAGE, drafts.length - shown)} avis de plus ({drafts.length - shown} restants)
            </button>
          )}
          {picked.length > room && (
            <p className="text-[11px] text-amber-800">
              {room === 0
                ? `Le bloc contient déjà ${MAX_REVIEW_ITEMS} avis (le maximum) : « Ajouter » est impossible, utilisez « Remplacer tous les avis » ou retirez-en.`
                : `Il reste ${room} place${room > 1 ? "s" : ""} sur ${MAX_REVIEW_ITEMS} : seuls les ${room} premiers avis sélectionnés seront ajoutés.`}
            </p>
          )}
          {picked.length > MAX_REVIEW_ITEMS && room > 0 && (
            <p className="text-[11px] text-amber-800">« Remplacer » garde les {MAX_REVIEW_ITEMS} premiers avis sélectionnés.</p>
          )}
          {selected > picked.length && <p className="text-[11px] text-zinc-600">Les avis sans texte ne sont pas ajoutés.</p>}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={primary} disabled={picked.length === 0 || room === 0} onClick={add}>
              Ajouter {Math.min(picked.length, room)} avis
            </button>
            <button type="button" className={btn} disabled={picked.length === 0} onClick={replace}>
              Remplacer tous les avis
            </button>
          </div>
          <p className="text-[11px] text-zinc-600">Le badge Achat vérifié est réservé aux avis importés de vos commandes (règle anti faux avis).</p>
        </div>
      )}
    </div>
  );
}

function DraftRow({ d, n, onEdit }: { d: Draft; n: number; onEdit: (patch: Partial<Draft>) => void }) {
  const warnings = pasteWarnings(d);
  const label = `Avis ${n}${d.name ? ` de ${d.name}` : ""}`;
  return (
    <li className={`space-y-1.5 rounded border p-2 text-[11px] ${d.on ? "border-zinc-900 bg-zinc-50" : "border-zinc-200 opacity-70"}`} data-paste-row>
      <div className="flex flex-wrap items-center gap-2">
        <input type="checkbox" className="h-3.5 w-3.5 accent-zinc-900" aria-label={`Sélectionner : ${label}`} checked={d.on} onChange={(e) => onEdit({ on: e.target.checked })} />
        <span role="group" aria-label={`Étoiles : ${label}`} className="inline-flex">
          {[1, 2, 3, 4, 5].map((k) => (
            <button
              key={k}
              type="button"
              aria-label={`${k} étoile${k > 1 ? "s" : ""}`}
              aria-pressed={d.stars === k}
              onClick={() => onEdit({ stars: k, starsGuessed: false, roundedFrom: undefined })}
              className={`rounded p-0.5 ${RING}`}
            >
              <Star className={`h-4 w-4 ${k <= d.stars ? "fill-amber-400 text-amber-400" : "fill-transparent text-zinc-300"}`} aria-hidden />
            </button>
          ))}
        </span>
        {d.starsGuessed && <span className="rounded bg-amber-100 px-1 py-0.5 font-medium text-amber-900">Note par défaut</span>}
        {d.roundedFrom != null && <span className="text-zinc-600">{roundedLabel(d.roundedFrom, d.stars)}</span>}
        <input
          className={`${field} w-32 flex-1`}
          aria-label={`Nom : ${label}`}
          placeholder="Nom du client"
          maxLength={REVIEW_LIMITS.name}
          value={d.name}
          onChange={(e) => onEdit({ name: e.target.value })}
        />
        <input
          type="date"
          className={`${field} w-36`}
          aria-label={`Date : ${label}`}
          value={d.date ?? ""}
          onChange={(e) => onEdit({ date: e.target.value || undefined })}
        />
      </div>
      <input
        className={field}
        aria-label={`Titre : ${label}`}
        placeholder="Titre (facultatif)"
        maxLength={REVIEW_LIMITS.title}
        value={d.title ?? ""}
        onChange={(e) => onEdit({ title: e.target.value })}
      />
      <textarea className={field} aria-label={`Texte : ${label}`} rows={2} maxLength={REVIEW_LIMITS.text} value={d.text} onChange={(e) => onEdit({ text: e.target.value })} />
      {warnings.length > 0 && (
        <ul className="space-y-0.5 text-amber-800">
          {warnings.map((w) => (
            <li key={w} className="flex items-start gap-1">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> {w}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
