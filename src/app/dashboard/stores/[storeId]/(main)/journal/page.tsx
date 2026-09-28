import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Activity, ChevronDown, HeartPulse, ScrollText, Search, SearchX, X } from "lucide-react";
import type { Prisma } from "@prisma/client";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { storeHealth } from "@/lib/health";
import { tickStatus } from "@/lib/tick";
import { Badge, Card, EmptyState, Flash, Input, PageHeader, Select, SubmitButton, buttonClass } from "@/components/ui";
import { HealthGrid } from "@/components/dashboard/HealthGrid";
import { plural } from "@/components/dashboard/format";
import { formatDateTimeLong, formatWhen, formatWhenPrecise } from "@/components/dashboard/dates";
import { tzOf } from "@/lib/time";
import { groupEvents, splitTechnical } from "@/components/dashboard/journal";
import { gaveUpItemAction, markGaveUpHandledAction, retryGaveUpAction, runTickAction } from "../../../../actions";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { backlog, gaveUpItems } from "@/lib/health";
import { ErrorText } from "@/components/dashboard/ErrorText";
import { humanizeError } from "@/lib/humanize-error";
import { providersOverview } from "@/lib/providers";
import { ProvidersCard } from "@/components/dashboard/ProvidersCard";

export const metadata: Metadata = { title: "Journal & santé" };

const LEVELS = { error: ["red", "Erreur"], warn: ["amber", "Attention"], info: ["zinc", "Info"] } as const;

const PAGE = 50;

export default async function JournalPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ level?: string; ok?: string; error?: string; before?: string; kind?: string; q?: string }>;
}) {
  await requireAdmin();
  const { storeId } = await params;
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId }, select: { id: true, timezone: true } });
  if (!store) notFound();
  // Dates in the store's time zone (Paris by default).
  const tz = tzOf(store);
  const level = sp.level === "error" || sp.level === "warn" ? sp.level : null;
  // Cursor pagination on createdAt: "Plus anciens" loads the next 50 entries.
  const before = sp.before && !Number.isNaN(Date.parse(sp.before)) ? new Date(sp.before) : null;
  const kind = sp.kind?.trim().slice(0, 100) || null;
  const q = sp.q?.trim().slice(0, 200) || null;
  // Search: text of the message, or an exact order / request / webhook id (correlation ids).
  const search: Prisma.EventLogWhereInput | null = q
    ? {
        OR: [
          { message: { contains: q, mode: "insensitive" } },
          { sessionId: q },
          { data: { path: ["requestId"], equals: q } },
          { data: { path: ["webhookId"], equals: q } },
        ],
      }
    : null;
  const [health, events, kinds, tick, queue, providers] = await Promise.all([
    storeHealth(storeId),
    db.eventLog.findMany({
      where: {
        storeId,
        ...(level === "error" ? { level: "error" } : level === "warn" ? { level: { in: ["warn", "error"] } } : {}),
        ...(kind ? { kind } : {}),
        ...(before ? { createdAt: { lt: before } } : {}),
        ...(search ?? {}),
      },
      orderBy: { createdAt: "desc" },
      take: PAGE + 1,
    }),
    db.eventLog.groupBy({ by: ["kind"], where: { storeId }, _count: { _all: true }, orderBy: { kind: "asc" } }),
    tickStatus(),
    backlog(storeId),
    // Observability only: a failed read never breaks the page.
    providersOverview().catch(() => []),
  ]);
  const gaveUp = queue.refundsGaveUp + queue.alertsGaveUp + queue.webhooksGaveUp + queue.syncGaveUp + queue.offersGaveUp + queue.disputeTagsGaveUp + queue.trackingGaveUp;
  const stuck = gaveUp > 0 ? await gaveUpItems(storeId) : [];
  const base = `/dashboard/stores/${storeId}/journal`;
  const hasMore = events.length > PAGE;
  const shown = events.slice(0, PAGE);
  const groups = groupEvents(shown);
  const now = new Date();
  const href = (p: { level?: string | null; before?: string | null }) => {
    const qs = new URLSearchParams({
      ...(p.level ? { level: p.level } : {}),
      ...(kind ? { kind } : {}),
      ...(q ? { q } : {}),
      ...(p.before ? { before: p.before } : {}),
    });
    // Land on the events list (below the health tiles, far down on a phone).
    return `${qs.size ? `${base}?${qs}` : base}#evenements`;
  };
  const pageHref = (b: string | null) => href({ level, before: b });
  const filtered = !!(kind || q);

  return (
    <>
      <PageHeader icon={Activity} iconColor="#0ea5e9" title="Journal & santé" description="Tout ce qui se passe sur vos paiements, en temps réel." />
      <Flash ok={sp.ok} error={sp.error} />

      <Card
        icon={HeartPulse}
        iconColor="#10b981"
        title="État du système"
        description="Vérifié à chaque visite. La maintenance automatique récupère les paiements manqués, relance les synchronisations Shopify et transmet les suivis à Whop."
        actions={
          <div className="flex flex-wrap gap-2">
            {gaveUp > 0 && (
              <>
                <form action={retryGaveUpAction.bind(null, storeId)}>
                  <SubmitButton size="sm">Relancer les {gaveUp} élément(s) abandonné(s)</SubmitButton>
                </form>
                <form action={markGaveUpHandledAction.bind(null, storeId)}>
                  <ConfirmButton
                    size="sm"
                    variant="secondary"
                    tone="default"
                    title="Marquer comme traités ?"
                    description="À faire seulement si vous les avez réglés à la main (remboursement reporté dans Shopify, événement vérifié dans Whop). Ils ne seront plus signalés."
                    confirmLabel="Marquer comme traités"
                  >
                    Marquer comme traités
                  </ConfirmButton>
                </form>
              </>
            )}
            <form action={runTickAction.bind(null, storeId)}>
              <SubmitButton size="sm" variant="secondary">
                Lancer la maintenance
              </SubmitButton>
            </form>
          </div>
        }
        className="mb-6"
      >
        <HealthGrid items={health} />
        {stuck.length > 0 && (
          <div id="abandonnes" className="mt-4 scroll-mt-6 rounded-xl ring-1 ring-red-200">
            <h3 className="rounded-t-xl bg-red-50 px-3.5 py-2 text-[13px] font-semibold text-red-800">
              {plural(gaveUp, "élément abandonné", "éléments abandonnés")} par l&apos;automatisation
              {gaveUp > stuck.length && <span className="font-normal"> · {stuck.length} plus récents</span>}
            </h3>
            <ul className="divide-y divide-zinc-100">
              {stuck.map((it) => (
                <li key={`${it.kind}:${it.id}`} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-900">
                      {it.href ? (
                        <Link href={it.href} className="hover:underline">
                          {it.label}
                        </Link>
                      ) : (
                        it.label
                      )}
                    </p>
                    <div className="mt-0.5 text-xs text-zinc-500">
                      <span className="block">{formatWhen(it.at, now, tz)}</span>
                      <ErrorText raw={it.detail} className="text-zinc-700" />
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <form action={gaveUpItemAction.bind(null, storeId, it.kind, it.id)}>
                      <input type="hidden" name="op" value="retry" />
                      <SubmitButton size="sm" variant="secondary">
                        Relancer
                      </SubmitButton>
                    </form>
                    {it.kind === "sync" ? (
                      <Link href={it.href ?? "#"} className={buttonClass("ghost", "sm")}>
                        Créée à la main…
                      </Link>
                    ) : (
                      <form action={gaveUpItemAction.bind(null, storeId, it.kind, it.id)}>
                        <input type="hidden" name="op" value="handled" />
                        <ConfirmButton
                          size="sm"
                          variant="secondary"
                          tone="default"
                          title="Marquer comme traité ?"
                          description="Seulement si vous l'avez réglé à la main (remboursement reporté dans Shopify, alerte lue, événement vérifié dans Whop, tag litige ou suivi ajouté à la main). Il ne sera plus signalé ni relancé."
                          confirmLabel="Marquer comme traité"
                        >
                          Traité
                        </ConfirmButton>
                      </form>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {tick.report && (
          <p className="mt-3 text-xs text-zinc-500">
            Dernier passage : {plural(Number(tick.report.reconciled) || 0, "paiement récupéré", "paiements récupérés")},{" "}
            {plural(Number(tick.report.syncRetried) || 0, "synchro relancée", "synchros relancées")},{" "}
            {plural(Number(tick.report.trackingPushed) || 0, "suivi transmis", "suivis transmis")} à Whop.
          </p>
        )}
      </Card>

      <ProvidersCard providers={providers} tz={tz} now={now} />

      <Card
        id="evenements"
        icon={ScrollText}
        title="Journal des événements"
        actions={
          <nav aria-label="Filtrer par niveau" className="flex shrink-0 gap-1 rounded-lg bg-zinc-100 p-0.5 text-xs">
            {[
              [null, "Tout"],
              ["warn", "Attention"],
              ["error", "Erreurs"],
            ].map(([l, label]) => (
              <Link
                key={label}
                href={href({ level: l })}
                aria-current={level === l ? "true" : undefined}
                className={`inline-flex min-h-8 items-center rounded-md px-2.5 ${level === l ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900"}`}
              >
                {label}
              </Link>
            ))}
          </nav>
        }
      >
        <form method="get" action={`${base}#evenements`} role="search" aria-label="Filtrer le journal" className="-mt-1 mb-3 flex flex-col gap-2 sm:flex-row">
          {level && <input type="hidden" name="level" value={level} />}
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-zinc-400" aria-hidden />
            <label htmlFor="journal-q" className="sr-only">
              Rechercher dans le journal
            </label>
            <Input
              id="journal-q"
              name="q"
              type="search"
              defaultValue={q ?? ""}
              placeholder="Message, ID de commande, de requête ou de webhook"
              autoComplete="off"
              className="pl-9"
            />
          </div>
          <div className="flex gap-2">
            <label htmlFor="journal-kind" className="sr-only">
              Type d&apos;événement
            </label>
            <Select id="journal-kind" name="kind" defaultValue={kind ?? ""} className="min-w-0 flex-1 sm:w-52 sm:flex-none">
              <option value="">Tous les types</option>
              {kind && !kinds.some((k) => k.kind === kind) && <option value={kind}>{kind}</option>}
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.kind} ({k._count._all})
                </option>
              ))}
            </Select>
            <button type="submit" className={`${buttonClass("secondary")} min-h-9 shrink-0`}>
              Filtrer
            </button>
          </div>
        </form>
        {filtered && (
          <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-zinc-500" role="status">
            <span>
              {plural(shown.length, "événement")}
              {hasMore ? " (et plus)" : ""} {shown.length > 1 ? "correspondent" : "correspond"}
            </span>
            {kind && (
              <span>
                · type <code className="text-zinc-700">{kind}</code>
              </span>
            )}
            {q && <span>· « {q} »</span>}
            <Link href={href({ level })} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 font-medium text-indigo-600 hover:bg-indigo-50">
              <X className="h-3 w-3" aria-hidden /> Effacer les filtres
            </Link>
          </p>
        )}
        {events.length === 0 ? (
          filtered || level ? (
            <EmptyState icon={SearchX} title="Aucun événement ne correspond">
              Essayez un autre terme ou un autre type, ou effacez les filtres.
            </EmptyState>
          ) : (
            <EmptyState icon={ScrollText} title="Rien pour l'instant">
              Paiements, synchronisations, litiges et alertes apparaîtront ici.
            </EmptyState>
          )
        ) : (
          <ol className="divide-y divide-zinc-100">
            {groups.map((g) => {
              const e = g.first;
              const [color, label] = LEVELS[e.level as keyof typeof LEVELS] ?? LEVELS.info;
              const { summary, details } = splitTechnical(e.message);
              // The provider error in plain French ("Shopify a refusé l'accès (403)…"), when recognized.
              const hint = details ? humanizeError(details) : null;
              const n = g.items.length;
              const oldest = g.items[n - 1];
              const sessions = new Set(g.items.map((x) => x.sessionId).filter(Boolean));
              return (
                <li key={g.key} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
                  <div className="flex items-center gap-2 sm:contents">
                    <time
                      className="shrink-0 text-xs sm:w-32 text-zinc-500 tabular-nums"
                      dateTime={e.createdAt.toISOString()}
                      title={formatDateTimeLong(e.createdAt, tz)}
                    >
                      {formatWhen(e.createdAt, now, tz)}
                    </time>
                    <span className="flex shrink-0 items-center gap-1.5 sm:w-24">
                      <Badge color={color}>{label}</Badge>
                    </span>
                  </div>
                  <div className="min-w-0 flex-1 text-sm break-words text-zinc-800">
                    <p>
                      {summary}
                      {n === 1 && e.sessionId && (
                        <Link
                          href={`/dashboard/stores/${storeId}/orders/${e.sessionId}`}
                          className="ml-2 text-xs font-medium whitespace-nowrap text-indigo-600 hover:underline"
                        >
                          Voir la commande
                        </Link>
                      )}
                      {hint?.detail && <span className="block text-xs text-zinc-600">{hint.text}</span>}
                    </p>
                    {n > 1 && (
                      <details className="group mt-1">
                        <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1.5 rounded-md text-xs text-zinc-600 hover:text-zinc-900 [&::-webkit-details-marker]:hidden">
                          <span className="rounded-full bg-zinc-100 px-1.5 font-semibold text-zinc-800 tabular-nums">×{n}</span>
                          <span>
                            dernière {formatWhen(e.createdAt, now, tz)} · première {formatWhen(oldest.createdAt, now, tz)}
                            {sessions.size > 0 && ` · ${plural(sessions.size, "commande")}`}
                          </span>
                          <ChevronDown className="h-3 w-3 transition group-open:rotate-180" aria-hidden />
                          <span className="sr-only">Afficher les {n} occurrences</span>
                        </summary>
                        <ul className="mt-1.5 space-y-0.5 border-l border-zinc-200 pl-3 text-xs text-zinc-600">
                          {g.items.map((x) => (
                            <li key={x.id} className="flex flex-wrap items-center gap-x-2">
                              <time dateTime={x.createdAt.toISOString()} className="tabular-nums" title={formatDateTimeLong(x.createdAt, tz)}>
                                {formatWhenPrecise(x.createdAt, now, tz)}
                              </time>
                              {x.sessionId && (
                                <Link
                                  href={`/dashboard/stores/${storeId}/orders/${x.sessionId}`}
                                  className="inline-flex min-h-6 items-center font-medium text-indigo-600 hover:underline"
                                >
                                  Voir la commande
                                </Link>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {details && (
                      <details className="group/tech mt-1">
                        <summary className="inline-flex min-h-7 cursor-pointer list-none items-center gap-1 rounded-md text-xs font-medium text-zinc-600 hover:text-zinc-900 [&::-webkit-details-marker]:hidden">
                          Détails techniques
                          <ChevronDown className="h-3 w-3 transition group-open/tech:rotate-180" aria-hidden />
                        </summary>
                        <pre className="mt-1 max-h-48 overflow-auto rounded-lg bg-zinc-50 p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-zinc-700 ring-1 ring-zinc-900/5">
                          {details}
                        </pre>
                      </details>
                    )}
                  </div>
                  <code className="hidden shrink-0 text-[11px] text-zinc-500 lg:block">{e.kind}</code>
                </li>
              );
            })}
          </ol>
        )}
        {(before || hasMore) && (
          <nav aria-label="Pagination du journal" className="mt-4 flex items-center justify-between border-t border-zinc-100 pt-4 text-sm">
            {before ? (
              <Link href={pageHref(null)} className="rounded-lg px-3 py-2 font-medium text-zinc-700 hover:bg-zinc-50">
                ← Plus récents
              </Link>
            ) : (
              <span />
            )}
            {hasMore && (
              <Link
                href={pageHref(shown[shown.length - 1].createdAt.toISOString())}
                className="rounded-lg px-3 py-2 font-medium text-zinc-700 hover:bg-zinc-50"
              >
                Plus anciens →
              </Link>
            )}
          </nav>
        )}
      </Card>
    </>
  );
}
