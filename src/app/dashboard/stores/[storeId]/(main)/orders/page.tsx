import { ExternalLink, Receipt } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { SessionStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { centsToDecimal, formatMoney } from "@/lib/pricing";
import { orderAdminUrl } from "@/lib/shopify";
import { Badge, Card, EmptyState, Flash, Input, PageHeader, SubmitButton } from "@/components/ui";
import { refundOrderAction, resyncOrderAction } from "../../../../actions";

const FILTERS: { key: string; label: string; status?: SessionStatus[] }[] = [
  { key: "paid", label: "Payées", status: ["PAID"] },
  { key: "all", label: "Tous les checkouts" },
  { key: "abandoned", label: "Abandonnés", status: ["OPEN", "PAYING", "FAILED", "ABANDONED"] },
];

export default async function OrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ ok?: string; error?: string; filter?: string }>;
}) {
  const { storeId } = await params;
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.filter) ?? FILTERS[0];
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) notFound();
  const sessions = await db.checkoutSession.findMany({
    where: { storeId, ...(filter.status ? { status: { in: filter.status } } : {}) },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const money = (c: number, cur: string) => formatMoney(c, cur);

  return (
    <>
      <PageHeader icon={Receipt} title="Commandes" description="Chaque checkout passé par votre page Whop, et son statut de synchronisation dans Shopify." />
      <Flash ok={sp.ok} error={sp.error} />
      <div className="mb-4 flex gap-1">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`?filter=${f.key}`}
            className={`rounded-lg px-3 py-1.5 text-sm transition ${f.key === filter.key ? "bg-zinc-900 font-medium text-white shadow-sm" : "text-zinc-600 hover:bg-white hover:shadow-[var(--shadow-card)]"}`}
          >
            {f.label}
          </Link>
        ))}
      </div>

      <Card className="overflow-x-auto p-0">
        {sessions.length === 0 ? (
          <EmptyState icon={Receipt} title="Aucune commande pour l'instant">
            Elles apparaissent ici dès qu&apos;un client passe par votre checkout.
          </EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-100 bg-zinc-50/70 text-[11px] tracking-wide text-zinc-500 uppercase">
              <tr>
                <th className="px-4 py-2.5 font-medium">Date</th>
                <th className="px-4 py-2.5 font-medium">Client</th>
                <th className="px-4 py-2.5 font-medium">Total</th>
                <th className="px-4 py-2.5 font-medium">Paiement</th>
                <th className="px-4 py-2.5 font-medium">Shopify</th>
                <th className="px-4 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {sessions.map((s) => (
                <tr key={s.id} className="align-top transition hover:bg-zinc-50/60">
                  <td className="px-4 py-3 whitespace-nowrap text-zinc-600">
                    {(s.paidAt ?? s.createdAt).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })}
                  </td>
                  <td className="px-4 py-3">{s.email ?? <span className="text-zinc-400">—</span>}</td>
                  <td className="px-4 py-3 font-medium whitespace-nowrap">
                    {money(s.totalCents || s.subtotalCents, s.currency)}
                    {s.refundedCents > 0 && <span className="block text-xs text-red-600">−{money(s.refundedCents, s.currency)} remboursé</span>}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge status={s.status} disputed={s.disputed} />
                  </td>
                  <td className="px-4 py-3">
                    {s.shopifyOrderId && store.shopDomain ? (
                      <a href={orderAdminUrl(store.shopDomain, s.shopifyOrderId)} target="_blank" rel="noreferrer" className="font-medium underline">
                        {s.shopifyOrderName} <ExternalLink className="inline h-3 w-3" />
                      </a>
                    ) : s.status === "PAID" ? (
                      <div className="max-w-xs space-y-1.5">
                        <Badge color="red">Non synchronisée</Badge>
                        {s.syncError && <p className="text-xs break-words text-red-600">{s.syncError}</p>}
                        <form action={resyncOrderAction.bind(null, store.id, s.id)}>
                          <SubmitButton size="sm" variant="secondary">
                            Re-synchroniser
                          </SubmitButton>
                        </form>
                      </div>
                    ) : (
                      <span className="text-zinc-400">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {s.status === "PAID" && s.whopPaymentId && s.refundedCents < s.totalCents && (
                      <details className="text-right">
                        <summary className="cursor-pointer list-none text-xs text-zinc-500 hover:text-zinc-900">Rembourser</summary>
                        <form action={refundOrderAction.bind(null, store.id, s.id)} className="mt-2 flex gap-1.5">
                          <Input name="amount" inputMode="decimal" defaultValue={centsToDecimal(s.totalCents - s.refundedCents)} className="w-24 py-1 text-xs" />
                          <SubmitButton size="sm" variant="danger">
                            OK
                          </SubmitButton>
                        </form>
                      </details>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

function StatusBadge({ status, disputed }: { status: SessionStatus; disputed: boolean }) {
  if (disputed) return <Badge color="red">Litige</Badge>;
  const map: Record<SessionStatus, [string, "green" | "amber" | "red" | "zinc" | "blue"]> = {
    PAID: ["Payé", "green"],
    PAYING: ["Paiement en cours", "blue"],
    OPEN: ["Checkout ouvert", "zinc"],
    FAILED: ["Échoué", "red"],
    ABANDONED: ["Abandonné", "zinc"],
  };
  const [label, color] = map[status];
  return <Badge color={color}>{label}</Badge>;
}
