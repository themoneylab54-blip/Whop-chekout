import { ChevronRight, Receipt, Search } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma, SessionStatus } from "@prisma/client";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/pricing";
import { Card, EmptyState, Flash, PageHeader } from "@/components/ui";
import { StatusBadge, SyncBadge } from "@/components/dashboard/OrderBits";

const FILTERS: { key: string; label: string; where: Prisma.CheckoutSessionWhereInput }[] = [
  { key: "paid", label: "Payées", where: { status: "PAID" } },
  { key: "todo", label: "À traiter", where: { status: "PAID", shopifyOrderId: null } },
  { key: "abandoned", label: "Abandonnés", where: { status: { in: ["OPEN", "PAYING", "FAILED", "ABANDONED"] as SessionStatus[] } } },
  { key: "all", label: "Tous", where: {} },
];
const PAGE_SIZE = 50;

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; filter?: string; q?: string; page?: string }>;
}) {
  await requireAdmin();
  const { storeId } = await params;
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.filter) ?? FILTERS[0];
  const q = (sp.q ?? "").trim().slice(0, 100);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) notFound();

  const where: Prisma.CheckoutSessionWhereInput = {
    storeId,
    ...(q
      ? {
          OR: [
            { email: { contains: q, mode: "insensitive" } },
            { shopifyOrderName: { contains: q.replace(/^#?/, "#"), mode: "insensitive" } },
            { id: q },
            { whopPaymentId: q },
          ],
        }
      : filter.where),
  };
  const [sessions, total, todo] = await Promise.all([
    db.checkoutSession.findMany({ where, orderBy: { createdAt: "desc" }, take: PAGE_SIZE, skip: (page - 1) * PAGE_SIZE }),
    db.checkoutSession.count({ where }),
    db.checkoutSession.count({ where: { storeId, status: "PAID", shopifyOrderId: null } }),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const money = (c: number, cur: string) => formatMoney(c, cur);
  const detail = (id: string) => `/dashboard/stores/${storeId}/orders/${id}`;
  const link = (p: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ filter: filter.key, q: q || undefined, ...p })) if (v != null && v !== "") u.set(k, String(v));
    return `?${u}`;
  };

  return (
    <>
      <PageHeader icon={Receipt} title="Commandes" description="Chaque checkout passé par votre page Whop, et son statut dans Shopify." />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex gap-1 overflow-x-auto">
          {FILTERS.map((f) => (
            <Link
              key={f.key}
              href={`?filter=${f.key}`}
              className={`rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition ${f.key === filter.key && !q ? "bg-zinc-900 font-medium text-white shadow-sm" : "text-zinc-600 hover:bg-white hover:shadow-[var(--shadow-card)]"}`}
            >
              {f.label}
              {f.key === "todo" && todo > 0 && <span className="ml-1.5 rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">{todo}</span>}
            </Link>
          ))}
        </div>
        <form className="relative sm:w-72">
          <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <input
            name="q"
            defaultValue={q}
            placeholder="E-mail, n° de commande, paiement…"
            className="w-full rounded-lg border border-zinc-200 bg-white py-2 pr-3 pl-9 text-sm shadow-[0_1px_1px_rgba(16,24,40,.04)] outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10"
          />
          <input type="hidden" name="filter" value={filter.key} />
        </form>
      </div>

      <Card className="p-0">
        {sessions.length === 0 ? (
          <EmptyState icon={Receipt} title={q ? "Aucun résultat" : "Aucune commande pour l'instant"}>
            {q ? "Essayez un autre e-mail ou numéro." : "Elles apparaissent ici dès qu'un client passe par votre checkout."}
          </EmptyState>
        ) : (
          <>
            {/* Desktop */}
            <table className="hidden w-full text-left text-sm md:table">
              <thead className="border-b border-zinc-100 text-xs text-zinc-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Date</th>
                  <th className="px-4 py-2.5 font-medium">Client</th>
                  <th className="px-4 py-2.5 font-medium">Total</th>
                  <th className="px-4 py-2.5 font-medium">Paiement</th>
                  <th className="px-4 py-2.5 font-medium">Shopify</th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {sessions.map((s) => (
                  <tr key={s.id} className="group relative transition hover:bg-zinc-50/80">
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-600">
                      <Link href={detail(s.id)} className="after:absolute after:inset-0">
                        {(s.paidAt ?? s.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" })}
                      </Link>
                    </td>
                    <td className="max-w-[240px] truncate px-4 py-3">{s.email ?? <span className="text-zinc-400">—</span>}</td>
                    <td className="px-4 py-3 font-medium whitespace-nowrap tabular-nums">
                      {money(s.totalCents || s.subtotalCents, s.currency)}
                      {s.refundedCents > 0 && <span className="block text-xs font-normal text-red-600">−{money(s.refundedCents, s.currency)}</span>}
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={s.status} disputed={s.disputed} />
                    </td>
                    <td className="px-4 py-3">
                      <SyncBadge s={s} />
                    </td>
                    <td className="px-2 text-zinc-300 group-hover:text-zinc-500">
                      <ChevronRight className="h-4 w-4" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile */}
            <ul className="divide-y divide-zinc-100 md:hidden">
              {sessions.map((s) => (
                <li key={s.id}>
                  <Link href={detail(s.id)} className="flex items-center gap-3 px-4 py-3.5 active:bg-zinc-50">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium">{s.email ?? "Client anonyme"}</span>
                        <span className="text-sm font-semibold tabular-nums">{money(s.totalCents || s.subtotalCents, s.currency)}</span>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                        {(s.paidAt ?? s.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Paris" })}
                        <StatusBadge status={s.status} disputed={s.disputed} />
                        <SyncBadge s={s} />
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-300" />
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {pages > 1 && (
        <nav className="mt-4 flex items-center justify-between text-sm text-zinc-600">
          <span>
            Page {page} / {pages} · {total} résultat{total > 1 ? "s" : ""}
          </span>
          <span className="flex gap-2">
            {page > 1 && (
              <Link href={link({ page: page - 1 })} className="rounded-lg bg-white px-3 py-1.5 shadow-[var(--shadow-card)] hover:bg-zinc-50">
                Précédent
              </Link>
            )}
            {page < pages && (
              <Link href={link({ page: page + 1 })} className="rounded-lg bg-white px-3 py-1.5 shadow-[var(--shadow-card)] hover:bg-zinc-50">
                Suivant
              </Link>
            )}
          </span>
        </nav>
      )}
    </>
  );
}
