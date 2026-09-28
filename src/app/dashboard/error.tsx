"use client";

import { RefreshCcw } from "lucide-react";

/** Shown instead of a blank "page couldn't load" when a dashboard action fails. */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="flex min-h-full items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 text-center shadow-[var(--shadow-float)]">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-50 text-amber-600 ring-1 ring-amber-600/15">
          <RefreshCcw className="h-5 w-5" />
        </span>
        <h1 className="text-lg font-semibold">Oups, quelque chose a coincé</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Souvent, c&apos;est qu&apos;une nouvelle version de l&apos;app vient d&apos;être déployée. Recharger la page règle le problème ; vos réglages
          déjà enregistrés sont conservés.
        </p>
        {error.digest && <p className="mt-3 font-mono text-xs text-zinc-500">Code : {error.digest}</p>}
        <div className="mt-6 flex justify-center gap-2">
          <button onClick={() => window.location.reload()} className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white">
            Recharger la page
          </button>
          <button onClick={reset} className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium">
            Réessayer
          </button>
        </div>
      </div>
    </main>
  );
}
