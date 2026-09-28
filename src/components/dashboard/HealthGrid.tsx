import Link from "next/link";
import { AlertTriangle, CheckCircle2, ChevronRight, CircleDashed } from "lucide-react";
import type { HealthItem } from "@/lib/health";

/** Rewrites the raw "… jamais" phrasing of the health checks into plain French. */
function humanize(detail: string): string {
  if (/^Dernier événement reçu jamais$/i.test(detail)) return "Aucun événement reçu pour l'instant";
  if (/^Dernier passage jamais/i.test(detail)) return "Pas encore exécutée";
  return detail.replace(/ depuis jamais/, "");
}

const STATE = {
  ok: { icon: CheckCircle2, tone: "text-emerald-600", label: "OK" },
  warn: { icon: AlertTriangle, tone: "text-amber-600", label: "À vérifier" },
  off: { icon: CircleDashed, tone: "text-zinc-500", label: "Non configuré" },
};

/** Status tiles: green = OK, amber = needs attention, grey = not configured. Equal height. */
export function HealthGrid({ items }: { items: HealthItem[] }) {
  return (
    <ul className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:auto-rows-fr sm:grid-cols-2 sm:gap-2.5 lg:grid-cols-3">
      {items.map((i) => {
        const s = i.ok === true ? STATE.ok : i.ok === false ? STATE.warn : STATE.off;
        const body = (
          <>
            <s.icon className={`mt-0.5 h-4.5 w-4.5 shrink-0 ${s.tone}`} aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-zinc-900">
                {i.label}
                <span className="sr-only"> : {s.label}</span>
              </span>
              <span className="mt-0.5 block text-xs leading-relaxed text-zinc-600">{humanize(i.detail)}</span>
            </span>
          </>
        );
        const box = "flex h-full items-start gap-3 rounded-xl bg-white p-3 ring-1 sm:p-3.5 ring-zinc-900/[.06] transition";
        return (
          <li key={i.key} className="h-full">
            {i.href ? (
              <Link href={i.href} className={`group ${box} hover:ring-zinc-900/15`}>
                {body}
                <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-zinc-300 transition group-hover:translate-x-0.5 group-hover:text-zinc-500" aria-hidden />
              </Link>
            ) : (
              <div className={box}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
