import Link from "next/link";
import { ArrowLeft, SearchX, ShoppingBag } from "lucide-react";
import "../../dashboard.css";

/** Unknown store, order or page under a store: branded, in French, with a way back. */
export default function StoreNotFound() {
  return (
    <main className="dash flex min-h-full items-center justify-center bg-[#f7f8fa] px-4 py-16">
      <div className="animate-fade-up w-full max-w-md text-center">
        <Link href="/dashboard" className="mb-10 inline-flex items-center gap-2.5">
          <span className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-[10px] bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_4px_12px_-4px_rgba(99,102,241,.7)]">
            <ShoppingBag className="relative h-4.5 w-4.5 text-white" strokeWidth={2.4} aria-hidden />
          </span>
          <span className="text-[15px] font-semibold tracking-tight text-zinc-900">Whop Checkout</span>
        </Link>
        <div className="rounded-2xl bg-white p-8 shadow-[var(--shadow-float)]">
          <span className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600 ring-1 ring-indigo-600/15">
            <SearchX className="h-5 w-5" aria-hidden />
          </span>
          <p className="text-xs font-semibold tracking-[.08em] text-zinc-500 uppercase">Erreur 404</p>
          <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-zinc-900">Cette page est introuvable</h1>
          <p className="mt-2 text-sm leading-relaxed text-zinc-600">
            La boutique ou la commande demandée n&apos;existe pas, ou a été supprimée. Vérifiez le lien, ou revenez au tableau de bord.
          </p>
          <Link
            href="/dashboard"
            className="mt-6 inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-zinc-900 px-4 text-sm font-medium text-white shadow-[inset_0_1px_0_rgba(255,255,255,.12),0_1px_2px_rgba(16,24,40,.2)] transition hover:bg-zinc-800"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden /> Retour au tableau de bord
          </Link>
        </div>
      </div>
    </main>
  );
}
