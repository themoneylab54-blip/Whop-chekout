"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { BadgeCheck, FileUp, Loader2, Star, Store } from "lucide-react";
import { formatRatingScore, MAX_REVIEW_ITEMS, type BlockOf, type ReviewItem, type ReviewSummary } from "@/lib/layout";
import { importPatch, ownReviews, rankReviews, selectRanked, summaryScope, type ImportedReview, type SelectOptions } from "@/lib/reviews-import";
import { CsvWorkerError, parseReviewsFile } from "@/lib/reviews-csv-client";
import { forgetJudgeMeAction, importJudgeMeAction, judgeMeStatusAction, shopifyReviewRatingAction } from "@/lib/reviews-actions";
import { isSampleReview } from "@/lib/sample-content";
import { RING } from "./ui";

/*
 * "Avis clients" block: import of the merchant's real reviews (review app CSV export or the
 * Judge.me API), preview and choice of the reviews shown, and the overall rating.
 */

const btn = `inline-flex min-h-8 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-xs font-medium text-zinc-900 hover:bg-zinc-50 disabled:opacity-50 ${RING}`;
const primary = `inline-flex min-h-8 items-center gap-1.5 rounded-md bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-800 disabled:opacity-50 ${RING}`;
const linkBtn = `rounded text-xs font-medium text-indigo-700 underline-offset-2 hover:underline disabled:opacity-50 ${RING}`;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Rows listed in the preview (the best / most recent first). */
const PREVIEW_ROWS = 150;
const SOURCE_LABEL: Record<ReviewSummary["source"], string> = { csv: "fichier CSV", judgeme: "Judge.me", shopify: "Shopify (métachamps avis)" };

type Loaded = {
  reviews: ImportedReview[];
  skipped: number;
  /** Published, rated reviews without text: in the average, not in the list. */
  withoutText: number;
  summary: ReviewSummary | null;
  from: "csv" | "judgeme";
  /** Set when the import is partial (capped): the average covers the reviews read only. */
  note?: string;
};

const fr = (n: number) => n.toLocaleString("fr-FR");
/** Floored like the buyer sees it (4,96 → "4,9"). */
const score = (s: number) => formatRatingScore(s, "fr-FR");
const frDate = (d: string) => d.split("-").reverse().join("/");

/**
 * What an import confirmed actually did: the reviews counted are the picked ones really in the
 * merged block (the room left by the merchant's own reviews may have cut some).
 */
export function importNotice(picked: ReviewItem[], patch: { items?: ReviewItem[]; summary: ReviewSummary | null }, hadSummary: boolean): string {
  const inBlock = new Set(patch.items ?? []);
  const added = picked.filter((r) => inBlock.has(r)).length;
  const left = picked.length - added;
  const head =
    picked.length === 0
      ? patch.summary
        ? "Note moyenne ajoutée au bloc."
        : ""
      : added === 0
        ? "Aucun avis ajouté : le bloc est plein (avis saisis à la main)."
        : `${added} avis ajouté${added > 1 ? "s" : ""} au bloc.` + (left > 0 ? ` ${left} non ajouté${left > 1 ? "s" : ""} faute de place.` : "");
  return [head, hadSummary && !patch.summary ? "L'ancienne note moyenne a été retirée." : ""].filter(Boolean).join(" ");
}

export function ReviewsImport({
  block,
  storeId,
  onChange,
  onFetching,
  updateBlockProps,
}: {
  block: BlockOf<"reviews">;
  storeId: string | null;
  onChange: (patch: Partial<BlockOf<"reviews">["props"]>) => void;
  /** True while a result that patches the block itself is awaited: the block's editor is locked. */
  onFetching?: (fetching: boolean) => void;
  /** Patches the block with this id as it is in the layout when applied (functional update). */
  updateBlockProps?: (id: string, patch: Partial<BlockOf<"reviews">["props"]>) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  // The latest callbacks (onChange closes over the block as last rendered): a result arriving
  // after an await patches the block as it is then, never the copy from when the request started.
  const latestOnChange = useRef(onChange);
  const latestUpdate = useRef(updateBlockProps);
  useEffect(() => {
    latestOnChange.current = onChange;
    latestUpdate.current = updateBlockProps;
  });
  // A result landing after the editor closed is never written into whatever is shown then (a late
  // Shopify note is only applied by block id, see fromShopify).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [busy, setBusy] = useState<null | "csv" | "judgeme" | "shopify">(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** "Lecture de « avis.csv » (4,2 Mo)…" while a file is parsed. */
  const [reading, setReading] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [judge, setJudge] = useState<{ connected: boolean; shopConnected: boolean } | null>(null);
  const [tokenOpen, setTokenOpen] = useState(false);
  const [token, setToken] = useState("");
  const tokenId = useId();

  useEffect(() => {
    if (!storeId) return;
    let alive = true;
    judgeMeStatusAction(storeId)
      .then((s) => alive && setJudge(s))
      .catch(() => alive && setJudge(null));
    return () => {
      alive = false;
    };
  }, [storeId]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    setNotice(null);
    if (file.size > MAX_FILE_BYTES) return setError("Fichier trop lourd (15 Mo maximum) : exportez seulement les avis publiés.");
    setBusy("csv");
    setReading(`Lecture de « ${file.name} » (${(file.size / 1024 / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} Mo)…`);
    try {
      // Parsed in a Web Worker: the builder stays responsive on a large export.
      const res = await parseReviewsFile(file);
      if (res.error) return setError(res.error);
      if (res.reviews.length === 0 && !res.summary) return setError("Aucun avis publié avec une note trouvé dans ce fichier.");
      setLoaded({ reviews: res.reviews, skipped: res.skipped, withoutText: res.withoutText, summary: res.summary, from: "csv" });
    } catch (err) {
      setError(err instanceof CsvWorkerError ? err.message : "Lecture du fichier impossible : vérifiez qu'il s'agit bien d'un export CSV.");
    } finally {
      setBusy(null);
      setReading(null);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function fromJudgeMe(pasted?: string) {
    if (!storeId) return;
    setError(null);
    setNotice(null);
    setBusy("judgeme");
    try {
      const res = await importJudgeMeAction(storeId, pasted);
      if (!res.ok) {
        // Saved token unreadable / refused / deleted (revoked): the field opens to paste a new one.
        if (res.token) {
          setTokenOpen(true);
          if (res.token === "cleared") setJudge((j) => (j ? { ...j, connected: false } : j));
        }
        return setError(res.error);
      }
      if (pasted) {
        setJudge((j) => (j ? { ...j, connected: true } : j));
        setToken("");
        setTokenOpen(false);
      }
      if (res.data.reviews.length === 0 && !res.data.summary) return setError("Aucun avis publié trouvé sur Judge.me pour cette boutique.");
      setLoaded({
        reviews: res.data.reviews,
        skipped: 0,
        withoutText: Math.max(0, res.data.rated - res.data.reviews.length),
        summary: res.data.summary,
        from: "judgeme",
        note: res.data.capped
          ? res.data.reason === "error"
            ? `Import partiel : Judge.me a cessé de répondre après les ${fr(res.data.rated)} avis les plus récents. La note moyenne est calculée sur ceux-ci ; réessayez plus tard pour tout importer.`
            : `Import partiel : les ${fr(res.data.rated)} avis les plus récents ont été lus (limite de 1 000 avis ou de 30 secondes). La note moyenne est calculée sur ceux-ci.`
          : undefined,
      });
    } catch {
      setError("Import Judge.me impossible : réessayez dans un instant.");
    } finally {
      setBusy(null);
    }
  }

  async function forget() {
    if (!storeId) return;
    await forgetJudgeMeAction(storeId).catch(() => null);
    setJudge((j) => (j ? { ...j, connected: false } : j));
    setNotice("Jeton Judge.me supprimé.");
  }

  async function fromShopify() {
    if (!storeId) return;
    setError(null);
    setNotice(null);
    setBusy("shopify");
    // The block's other fields are locked until the note is written into it.
    onFetching?.(true);
    // The block the note was asked for (the editor may show another one when it lands).
    const blockId = block.id;
    try {
      const res = await shopifyReviewRatingAction(storeId);
      // Editor closed meanwhile: the note still lands on the block it was asked for when it can be
      // patched by id (a functional update of the layout; a deleted block is left alone). Through
      // onChange (the editor's own copy of the block) it is dropped.
      if (!mounted.current) {
        if (res.ok && res.data.summary) latestUpdate.current?.(blockId, { summary: res.data.summary });
        return;
      }
      if (!res.ok) return setError(res.error);
      if (!res.data.summary) {
        return setError(
          "Aucune note trouvée sur vos produits Shopify (métachamps reviews.rating) : votre application d'avis ne les remplit pas. Importez vos avis en CSV pour calculer la note.",
        );
      }
      if (latestUpdate.current) latestUpdate.current(blockId, { summary: res.data.summary });
      else latestOnChange.current({ summary: res.data.summary });
      setNotice(
        `Note récupérée sur ${fr(res.data.products)} produit${res.data.products > 1 ? "s" : ""} Shopify.` +
          (!res.data.capped
            ? ""
            : res.data.reason === "error"
              ? " Lecture partielle : Shopify a cessé de répondre avant la fin (limite d'appels). La note porte sur les produits lus ; réessayez plus tard pour tout lire."
              : " Votre boutique a plus de 2 000 produits actifs : seuls les 2 000 premiers ont été lus (note partielle)."),
      );
    } catch {
      if (mounted.current) setError("Lecture de la note Shopify impossible : réessayez dans un instant.");
    } finally {
      setBusy(null);
      onFetching?.(false);
    }
  }

  const summary = block.props.summary ?? null;

  return (
    <div className="space-y-2.5 rounded-lg border border-indigo-200 bg-indigo-50/60 p-3">
      <p className="text-xs font-semibold text-zinc-900">Importer vos vrais avis</p>
      <p className="text-[11px] leading-relaxed text-zinc-700">
        Exportez vos avis depuis votre application d&apos;avis (Judge.me, Loox, Okendo, Yotpo, Shopify Product Reviews…) au format CSV, puis importez le
        fichier ici : vous choisissez ensuite ceux à afficher. Seuls les avis publiés sont repris ; « Achat vérifié » n&apos;apparaît que si votre application
        l&apos;indique.
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv,text/plain,application/vnd.ms-excel"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <button type="button" className={btn} disabled={!!busy} onClick={() => fileRef.current?.click()}>
          {busy === "csv" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FileUp className="h-3.5 w-3.5" aria-hidden />}
          Importer un fichier CSV
        </button>
        {storeId && (
          <button
            type="button"
            className={btn}
            disabled={!!busy || judge?.shopConnected === false}
            title={judge?.shopConnected === false ? "Connectez d'abord Shopify" : undefined}
            onClick={() => (judge?.connected ? void fromJudgeMe() : setTokenOpen((o) => !o))}
            aria-expanded={judge?.connected ? undefined : tokenOpen}
          >
            {busy === "judgeme" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Star className="h-3.5 w-3.5" aria-hidden />}
            Importer depuis Judge.me
          </button>
        )}
      </div>
      {judge?.connected && (
        <p className="text-[11px] text-zinc-600">
          Jeton Judge.me enregistré (chiffré).{" "}
          <button type="button" className={linkBtn} onClick={() => setTokenOpen((o) => !o)}>
            Changer
          </button>{" "}
          ·{" "}
          <button type="button" className={linkBtn} onClick={() => void forget()}>
            Supprimer
          </button>
        </p>
      )}
      {tokenOpen && (
        <form
          className="space-y-1.5 rounded-md border border-zinc-200 bg-white p-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void fromJudgeMe(token.trim());
          }}
        >
          <label htmlFor={tokenId} className="block text-xs font-medium text-zinc-700">
            Jeton privé Judge.me
          </label>
          <input
            id={tokenId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-zinc-900"
            placeholder="Private API token"
          />
          <p className="text-[11px] text-zinc-600">Judge.me › Paramètres › Intégrations › « Voir la clé API » : copiez le Private API token. Il est enregistré chiffré et ne quitte jamais nos serveurs.</p>
          <button type="submit" className={primary} disabled={!token.trim() || !!busy}>
            {busy === "judgeme" && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Importer mes avis
          </button>
        </form>
      )}
      {reading && (
        <p role="status" className="inline-flex items-center gap-1.5 text-[11px] text-zinc-700">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          {reading}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-900 ring-1 ring-amber-200">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-[11px] text-emerald-800">
          {notice}
        </p>
      )}
      {loaded && (
        <ImportPreview
          loaded={loaded}
          ownCount={ownReviews(block.props.items, isSampleReview).length}
          onCancel={() => setLoaded(null)}
          onConfirm={(picked, withSummary) => {
            // Only the average asked for: the block's reviews stay as they are. The average
            // follows this import: unticked, a previous one is removed (never left stale).
            const hadSummary = !!block.props.summary;
            const patch = importPatch(block.props.items, picked, loaded.summary, withSummary, isSampleReview);
            onChange(patch);
            setLoaded(null);
            setNotice(importNotice(picked, patch, hadSummary));
          }}
        />
      )}

      <div className="border-t border-indigo-200 pt-2.5">
        <p className="text-xs font-semibold text-zinc-900">Note moyenne</p>
        {summary ? (
          <p className="mt-1 text-[11px] text-zinc-700">
            <strong className="font-semibold text-zinc-900">
              {score(summary.score)}/5 · {fr(summary.count)} avis
            </strong>{" "}
            {summary.partial && (
              <span
                data-summary-partial
                title={
                  summary.source === "shopify"
                    ? "Lecture Shopify partielle : la note porte sur les produits lus seulement."
                    : "Import Judge.me partiel : la note porte sur les avis les plus récents lus."
                }
              >
                (partielle){" "}
              </span>
            )}
            <span data-summary-scope>({summaryScope(summary.count, !!summary.partial, summary.source)})</span> (source : {SOURCE_LABEL[summary.source]}
            {summary.asOf ? `, au ${frDate(summary.asOf)}` : ""}).{" "}
            <button type="button" className={linkBtn} onClick={() => onChange({ summary: null })}>
              Ne plus l&apos;afficher
            </button>
          </p>
        ) : (
          <p className="mt-1 text-[11px] text-zinc-600">
            Affichée au-dessus des avis seulement quand elle vient de vos vraies données, sur tous les avis lus (pas seulement ceux affichés) : tous les avis du
            fichier pour un CSV, tous vos avis publiés pour Judge.me, tous les avis publiés de la boutique (produits actifs) pour Shopify.
          </p>
        )}
        {storeId && (
          <button type="button" className={`${btn} mt-2`} disabled={!!busy} onClick={() => void fromShopify()}>
            {busy === "shopify" ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Store className="h-3.5 w-3.5" aria-hidden />}
            {busy === "shopify" ? "Récupération…" : "Récupérer ma note depuis Shopify"}
          </button>
        )}
        {busy === "shopify" && (
          <p role="status" className="mt-1 text-[11px] text-zinc-700">
            Récupération de la note Shopify… Le bloc est verrouillé le temps de l&apos;écrire.
          </p>
        )}
      </div>
    </div>
  );
}

type Filters = Required<Pick<SelectOptions, "minStars" | "withText" | "sort">>;

function ImportPreview({
  loaded,
  ownCount,
  onConfirm,
  onCancel,
}: {
  loaded: Loaded;
  /** Reviews the merchant typed in the block: always kept, so the import gets the room left. */
  ownCount: number;
  onConfirm: (picked: ReviewItem[], withSummary: boolean) => void;
  onCancel: () => void;
}) {
  const room = Math.max(0, MAX_REVIEW_ITEMS - ownCount);
  // Ranked once per filter change (not on every render / tick of a checkbox).
  // `pre`: the reviews pre-selected for these filters, always listed (even past the first rows)
  // so each one can be unticked.
  const [view, setView] = useState<{ opts: Filters; ranked: ImportedReview[]; pre: Set<ImportedReview> }>(() => {
    const opts: Filters = { minStars: 4, withText: true, sort: "best" };
    const ranked = rankReviews(loaded.reviews, opts);
    return { opts, ranked, pre: new Set(selectRanked(ranked, room)) };
  });
  const { opts, ranked, pre } = view;
  const [picked, setPicked] = useState<Set<ImportedReview>>(() => new Set(view.pre));
  const [withSummary, setWithSummary] = useState(!!loaded.summary);
  // Room shrinking meanwhile (a review typed in the block): the selection is cut to fit, in the
  // listed order, so the counter and the import never go past it.
  const [seenRoom, setSeenRoom] = useState(room);
  if (seenRoom !== room) {
    setSeenRoom(room);
    if (picked.size > room) setPicked(new Set(ranked.filter((r) => picked.has(r)).slice(0, room)));
  }
  const full = picked.size >= room;

  function setFilters(next: Filters) {
    const nextRanked = rankReviews(loaded.reviews, next);
    const nextPre = new Set(selectRanked(nextRanked, room));
    setView({ opts: next, ranked: nextRanked, pre: nextPre });
    setPicked(new Set(nextPre));
  }
  function toggle(r: ImportedReview) {
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(r)) n.delete(r);
      else if (n.size < room) n.add(r);
      return n;
    });
  }
  // In the ranked order, so the block shows them as listed here.
  const chosen = useMemo(() => {
    const inRanked = new Set<ImportedReview>(ranked);
    return ranked.filter((r) => picked.has(r)).concat([...picked].filter((r) => !inRanked.has(r)));
  }, [ranked, picked]);
  // The first rows, then every pre-selected / ticked review ranked past them (ranked order kept).
  const shown = useMemo(
    () => ranked.slice(0, PREVIEW_ROWS).concat(ranked.slice(PREVIEW_ROWS).filter((r) => pre.has(r) || picked.has(r))),
    [ranked, pre, picked],
  );

  return (
    <div className="space-y-2 rounded-md border border-zinc-200 bg-white p-2.5">
      <p className="text-xs text-zinc-800">
        <strong className="font-semibold">{fr(loaded.reviews.length)} avis publiés</strong> lus
        {loaded.withoutText > 0 && <> · {fr(loaded.withoutText)} sans texte (comptés dans la moyenne seulement)</>}
        {loaded.skipped > 0 && <> · {fr(loaded.skipped)} ignorés (non publiés, sans note ou en double)</>}
        {loaded.summary && (
          <>
            {" "}
            · moyenne {score(loaded.summary.score)}/5
          </>
        )}
      </p>
      {loaded.note && <p className="text-[11px] text-zinc-600">{loaded.note}</p>}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-zinc-700">
        <label className="inline-flex items-center gap-1">
          Note
          <select
            className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-[11px]"
            value={opts.minStars}
            onChange={(e) => setFilters({ ...opts, minStars: Number(e.target.value) })}
          >
            <option value={5}>5★ uniquement</option>
            <option value={4}>4★ et plus</option>
            <option value={1}>Toutes</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-1">
          Tri
          <select className="rounded border border-zinc-300 bg-white px-1 py-0.5 text-[11px]" value={opts.sort} onChange={(e) => setFilters({ ...opts, sort: e.target.value as "best" | "recent" })}>
            <option value="best">Meilleurs d&apos;abord</option>
            <option value="recent">Plus récents</option>
          </select>
        </label>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" className="h-3.5 w-3.5 accent-zinc-900" checked={opts.withText} onChange={(e) => setFilters({ ...opts, withText: e.target.checked })} />
          Avec un vrai texte
        </label>
      </div>
      <p className="text-[11px] text-zinc-600">
        {picked.size}/{room} sélectionnés{full && room > 0 ? " (maximum atteint)" : ""}. Les avis sur les produits du panier passent en premier chez le client.
      </p>
      {ownCount > 0 && (
        <p className={`text-[11px] ${room === 0 ? "text-amber-800" : "text-zinc-600"}`}>
          {room === 0
            ? `Le bloc contient déjà ${MAX_REVIEW_ITEMS} avis saisis à la main (le maximum) : ils sont gardés. Retirez-en pour faire de la place aux avis importés.`
            : `${ownCount} avis saisi${ownCount > 1 ? "s" : ""} à la main ${ownCount > 1 ? "sont gardés" : "est gardé"} : il reste ${room} place${room > 1 ? "s" : ""} sur ${MAX_REVIEW_ITEMS} pour les avis importés.`}
        </p>
      )}
      {ranked.length === 0 ? (
        <p className="text-[11px] text-amber-800">Aucun avis ne correspond à ces filtres.</p>
      ) : (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {shown.map((r, i) => (
            <li key={i}>
              <label className={`flex gap-2 rounded border p-2 text-[11px] ${picked.has(r) ? "border-zinc-900 bg-zinc-50" : "border-zinc-200"}`}>
                <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-zinc-900" checked={picked.has(r)} disabled={!picked.has(r) && full} onChange={() => toggle(r)} />
                {r.photoUrl && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={r.photoUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" loading="lazy" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-1.5 font-medium text-zinc-900">
                    <span role="img" aria-label={`${r.stars} étoile${r.stars > 1 ? "s" : ""} sur 5`} className="text-amber-600">
                      {"★".repeat(r.stars)}
                      <span className="text-zinc-300">{"★".repeat(5 - r.stars)}</span>
                    </span>
                    {r.name || "Client"}
                    {r.verified && (
                      <span className="inline-flex items-center gap-0.5 text-emerald-800">
                        <BadgeCheck className="h-3 w-3" aria-hidden /> Achat vérifié
                      </span>
                    )}
                    {r.date && <span className="font-normal text-zinc-500">{r.date.split("-").reverse().join("/")}</span>}
                  </span>
                  {r.title && <span className="block font-medium text-zinc-800">{r.title}</span>}
                  <span className="line-clamp-2 block text-zinc-700">{r.text}</span>
                  {r.productTitle && <span className="block truncate text-zinc-500">{r.productTitle}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {loaded.summary && (
        <label className="flex items-center gap-2 text-[11px] text-zinc-800">
          <input type="checkbox" className="h-3.5 w-3.5 accent-zinc-900" checked={withSummary} onChange={(e) => setWithSummary(e.target.checked)} />
          Afficher la note moyenne : {score(loaded.summary.score)}/5 · {fr(loaded.summary.count)} avis ({summaryScope(loaded.summary.count, !!(loaded.summary.partial || loaded.note), loaded.summary.source)})
        </label>
      )}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={primary} disabled={picked.size === 0 && !(withSummary && loaded.summary)} onClick={() => onConfirm(chosen, withSummary)}>
          {picked.size > 0 ? `Ajouter ${picked.size} avis au bloc` : "Afficher la note moyenne"}
        </button>
        <button type="button" className={btn} onClick={onCancel}>
          Annuler
        </button>
      </div>
      <p className="text-[11px] text-zinc-600">Les avis d&apos;exemple et ceux d&apos;un import précédent sont remplacés ; les avis que vous avez saisis vous-même sont gardés.</p>
    </div>
  );
}
