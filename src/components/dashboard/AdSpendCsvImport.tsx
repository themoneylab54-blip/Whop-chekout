"use client";

import { useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, CheckCircle2, FileUp, Loader2 } from "lucide-react";
import { parseSpendCsv } from "@/lib/adspend-csv";

const PLATFORM: Record<string, string> = { meta: "Meta", tiktok: "TikTok", google: "Google Ads", other: "Autre" };
const EXAMPLE = "jour;plateforme;campagne;montant\n27/09/2026;google;marque-fr;42,50\n27/09/2026;meta;automne;120,00";

function Submit({ disabled, count }: { disabled: boolean; count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      className="inline-flex min-h-10 items-center gap-1.5 rounded-lg bg-zinc-900 px-3.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:border disabled:border-zinc-200 disabled:bg-white disabled:text-zinc-400"
    >
      {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
      Importer {count > 0 ? `${new Intl.NumberFormat("fr-FR").format(count)} ligne(s)` : ""}
    </button>
  );
}

/**
 * Bulk ad spend import (paste or .csv file) with a live preview: valid lines, and each rejected
 * line with its reason. The server action re-parses and re-validates everything.
 */
export function AdSpendCsvImport({ action, currency, today }: { action: (fd: FormData) => void | Promise<void>; currency: string; today: string }) {
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => (text.trim() ? parseSpendCsv(text, today) : null), [text, today]);
  const money = (c: number, cur: string | null) => new Intl.NumberFormat("fr-FR", { style: "currency", currency: cur ?? currency }).format(c / 100);
  const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC" });
  const rejected = parsed?.errors.filter((e) => !e.message.startsWith("Doublon")) ?? [];

  return (
    <form action={action} className="space-y-3">
      <div>
        <label htmlFor="as-csv" className="mb-1 block text-sm font-medium text-zinc-800">
          Coller des lignes <span className="font-normal text-zinc-500">(jour ; plateforme ; campagne ; montant [; devise])</span>
        </label>
        <textarea
          id="as-csv"
          name="csv"
          rows={5}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={EXAMPLE}
          aria-describedby="as-csv-help"
          className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed shadow-[0_1px_1px_rgba(16,24,40,.04)] focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 focus:outline-none"
        />
        <p id="as-csv-help" className="mt-1 text-xs text-zinc-500">
          Séparateur « ; » ou « , », dates JJ/MM/AAAA ou AAAA-MM-JJ, montants « 12,50 » en {currency} (ou dans la devise de la 5ᵉ colonne, convertie au taux BCE). Une ligne déjà saisie
          (même jour, plateforme et campagne) est corrigée. Meta, TikTok et Google Ads connectés ci-dessus sont importés automatiquement : ce collage sert aux autres dépenses (influence…) ou à
          un compte non connecté (exportez son rapport « Campagnes » par jour).
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50 focus-within:ring-2 focus-within:ring-indigo-500">
          <FileUp className="h-4 w-4" aria-hidden /> Choisir un fichier .csv
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setText(await f.text());
              // The text goes through the textarea: no file upload needed.
              if (fileRef.current) fileRef.current.value = "";
            }}
          />
        </label>
        <Submit disabled={!parsed || parsed.rows.length === 0} count={parsed?.rows.length ?? 0} />
      </div>

      {parsed && (
        <div className="rounded-xl bg-zinc-50 p-3 text-sm ring-1 ring-zinc-900/5" aria-live="polite">
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1 font-medium text-emerald-800">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {parsed.rows.length} ligne(s) valide(s)
            </span>
            {rejected.length > 0 && (
              <span className="inline-flex items-center gap-1 font-medium text-red-800">
                <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {rejected.length} ligne(s) rejetée(s)
              </span>
            )}
          </p>
          {parsed.errors.length > 0 && (
            <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto text-xs">
              {parsed.errors.map((e, i) => (
                <li key={i} className={e.message.startsWith("Doublon") ? "text-amber-900" : "text-red-800"}>
                  <strong>Ligne {e.line}</strong> : {e.message} <code className="break-all text-zinc-500">{e.raw.slice(0, 80)}</code>
                </li>
              ))}
            </ul>
          )}
          {parsed.rows.length > 0 && (
            <div className="mt-2 max-h-56 overflow-auto" tabIndex={0} role="region" aria-label="Aperçu des lignes valides">
              <table className="w-full min-w-[420px] text-xs">
                <caption className="sr-only">Aperçu des dépenses à importer</caption>
                <thead className="text-zinc-500">
                  <tr>
                    <th scope="col" className="py-1 text-left font-medium">Ligne</th>
                    <th scope="col" className="py-1 text-left font-medium">Jour</th>
                    <th scope="col" className="py-1 text-left font-medium">Plateforme</th>
                    <th scope="col" className="py-1 text-left font-medium">Campagne</th>
                    <th scope="col" className="py-1 text-right font-medium">Montant</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-200/70">
                  {parsed.rows.slice(0, 100).map((r) => (
                    <tr key={`${r.line}`}>
                      <td className="py-1 text-zinc-500 tabular-nums">{r.line}</td>
                      <td className="py-1 tabular-nums">{day(r.day)}</td>
                      <td className="py-1">{PLATFORM[r.platform]}</td>
                      <td className="max-w-[10rem] truncate py-1">{r.campaign}</td>
                      <td className="py-1 text-right tabular-nums">{money(r.amountCents, r.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.rows.length > 100 && <p className="mt-1 text-xs text-zinc-500">… et {parsed.rows.length - 100} autre(s).</p>}
            </div>
          )}
        </div>
      )}
    </form>
  );
}
