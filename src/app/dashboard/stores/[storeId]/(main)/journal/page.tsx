import Link from "next/link";
import { notFound } from "next/navigation";
import { Activity, HeartPulse, ScrollText } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { storeHealth } from "@/lib/health";
import { tickStatus } from "@/lib/tick";
import { Badge, Card, EmptyState, Flash, PageHeader, SubmitButton } from "@/components/ui";
import { HealthGrid } from "@/components/dashboard/HealthGrid";
import { runTickAction } from "../../../../actions";

const LEVELS = { error: ["red", "Erreur"], warn: ["amber", "Attention"], info: ["zinc", "Info"] } as const;

export default async function JournalPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ level?: string; ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const { storeId } = await params;
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId }, select: { id: true } });
  if (!store) notFound();
  const level = sp.level === "error" || sp.level === "warn" ? sp.level : null;
  const [health, events, tick] = await Promise.all([
    storeHealth(storeId),
    db.eventLog.findMany({
      where: { storeId, ...(level === "error" ? { level: "error" } : level === "warn" ? { level: { in: ["warn", "error"] } } : {}) },
      orderBy: { createdAt: "desc" },
      take: 150,
    }),
    tickStatus(),
  ]);
  const base = `/dashboard/stores/${storeId}/journal`;

  return (
    <>
      <PageHeader icon={Activity} iconColor="#0ea5e9" title="Journal & santé" description="Tout ce qui se passe sur vos paiements, en temps réel." />
      <Flash ok={sp.ok} error={sp.error} />

      <Card
        icon={HeartPulse}
        iconColor="#10b981"
        title="État du système"
        description="Vérifié à chaque visite. La maintenance automatique récupère les paiements manqués, relance les synchronisations et envoie les relances."
        actions={
          <form action={runTickAction.bind(null, storeId)}>
            <SubmitButton size="sm" variant="secondary">
              Lancer la maintenance
            </SubmitButton>
          </form>
        }
        className="mb-6"
      >
        <HealthGrid items={health} />
        {tick.report && (
          <p className="mt-3 text-xs text-zinc-500">
            Dernier passage : {Number(tick.report.reconciled) || 0} paiement(s) récupéré(s), {Number(tick.report.syncRetried) || 0} synchro(s) relancée(s),{" "}
            {Number(tick.report.recoveryEmails) || 0} relance(s) envoyée(s), {Number(tick.report.trackingPushed) || 0} suivi(s) transmis à Whop.
          </p>
        )}
      </Card>

      <Card
        icon={ScrollText}
        title="Journal des événements"
        actions={
          <div className="flex gap-1 rounded-lg bg-zinc-100 p-0.5 text-xs">
            {[
              [null, "Tout"],
              ["warn", "Attention"],
              ["error", "Erreurs"],
            ].map(([l, label]) => (
              <Link
                key={label}
                href={l ? `${base}?level=${l}` : base}
                className={`rounded-md px-2.5 py-1 ${level === l ? "bg-white font-medium shadow-sm" : "text-zinc-500 hover:text-zinc-900"}`}
              >
                {label}
              </Link>
            ))}
          </div>
        }
      >
        {events.length === 0 ? (
          <EmptyState icon={ScrollText} title="Rien pour l'instant">
            Paiements, synchronisations, litiges et alertes apparaîtront ici.
          </EmptyState>
        ) : (
          <ol className="divide-y divide-zinc-100">
            {events.map((e) => {
              const [color, label] = LEVELS[e.level as keyof typeof LEVELS] ?? LEVELS.info;
              return (
                <li key={e.id} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
                  <time className="w-32 shrink-0 text-xs text-zinc-500 tabular-nums" dateTime={e.createdAt.toISOString()}>
                    {e.createdAt.toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "medium", timeZone: "Europe/Paris" })}
                  </time>
                  <span className="shrink-0">
                    <Badge color={color}>{label}</Badge>
                  </span>
                  <span className="min-w-0 flex-1 text-sm break-words text-zinc-800">
                    {e.message}
                    {e.sessionId && (
                      <Link href={`/dashboard/stores/${storeId}/orders/${e.sessionId}`} className="ml-2 text-xs text-indigo-600 hover:underline">
                        voir
                      </Link>
                    )}
                  </span>
                  <code className="hidden shrink-0 text-[11px] text-zinc-400 lg:block">{e.kind}</code>
                </li>
              );
            })}
          </ol>
        )}
      </Card>
    </>
  );
}
