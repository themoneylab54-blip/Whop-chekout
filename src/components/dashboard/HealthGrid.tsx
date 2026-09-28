import Link from "next/link";
import { AlertTriangle, CheckCircle2, CircleDashed } from "lucide-react";
import type { HealthItem } from "@/lib/health";

/** Status tiles: green = OK, amber = needs attention, grey = not configured. */
export function HealthGrid({ items }: { items: HealthItem[] }) {
  return (
    <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((i) => {
        const Icon = i.ok === true ? CheckCircle2 : i.ok === false ? AlertTriangle : CircleDashed;
        const tone = i.ok === true ? "text-emerald-600" : i.ok === false ? "text-amber-600" : "text-zinc-400";
        const body = (
          <div className="flex items-start gap-3 rounded-xl bg-white p-3.5 ring-1 ring-zinc-900/[.06] transition hover:ring-zinc-900/15">
            <Icon className={`mt-0.5 h-4.5 w-4.5 shrink-0 ${tone}`} />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zinc-900">{i.label}</span>
              <span className="block text-xs text-zinc-500">{i.detail}</span>
            </span>
          </div>
        );
        return <li key={i.key}>{i.href ? <Link href={i.href}>{body}</Link> : body}</li>;
      })}
    </ul>
  );
}
