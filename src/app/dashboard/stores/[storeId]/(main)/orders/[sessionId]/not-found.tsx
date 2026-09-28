import Link from "next/link";
import { ArrowLeft, SearchX } from "lucide-react";
import { EmptyState } from "@/components/ui";

/** Unknown order id: stays inside the dashboard, with a way back to the list. */
export default function OrderNotFound() {
  return (
    <div className="rounded-2xl bg-white shadow-[var(--shadow-card)]">
      <h1 className="sr-only">Commande introuvable</h1>
      <EmptyState icon={SearchX} title="Commande introuvable">
        Ce checkout n&apos;existe pas ou n&apos;appartient pas à cette boutique.
      </EmptyState>
      <div className="-mt-6 flex justify-center pb-10">
        <Link
          href="../orders"
          className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-white px-4 text-sm font-medium text-zinc-800 shadow-[var(--shadow-card)] hover:bg-zinc-50"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden /> Toutes les commandes
        </Link>
      </div>
    </div>
  );
}
