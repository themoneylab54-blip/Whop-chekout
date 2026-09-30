import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, Receipt, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Prisma, SessionStatus } from "@prisma/client";
import { requireStoreAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { addDays, daysAgo, tzOf } from "@/lib/time";
import { drillSessionIds, hasDrill, isDay, parisDayStart, type Drill } from "@/lib/analytics";
import { Badge, Card, EmptyState, Flash, PageHeader, buttonClass } from "@/components/ui";
import { StatusBadge } from "@/components/dashboard/OrderBits";
import { OrderSearch } from "@/components/dashboard/OrderSearch";
import { OrdersBulkBar, OrdersSelectAll } from "@/components/dashboard/OrdersBulkBar";
import { METHOD_LABELS } from "@/components/dashboard/AnalyticsKit";
import { countryName } from "@/components/dashboard/AnalyticsControls";
import { formatCents, formatDateTime, formatNumber } from "@/components/dashboard/format";
import { resyncOrdersAction } from "./actions";
import { PopoverDetails } from "@/components/dashboard/Popover";
import { humanizeError } from "@/lib/humanize-error";
import { sourceLabel } from "@/components/dashboard/sources";

export const metadata: Metadata = { title: "Commandes" };

const FILTERS: { key: string; label: string; where: Prisma.CheckoutSessionWhereInput }[] = [
  { key: "paid", label: "Payées", where: { status: "PAID" } },
  { key: "todo", label: "À traiter", where: { status: "PAID", shopifyOrderId: null, syncHandledAt: null } },
  { key: "abandoned", label: "Abandonnés", where: { status: { in: ["OPEN", "PAYING", "FAILED", "ABANDONED"] as SessionStatus[] } } },
  { key: "all", label: "Tous", where: {} },
];

const PERIODS = [
  { key: "7d", label: "7 j", days: 7 },
  { key: "30d", label: "30 j", days: 30 },
  { key: "90d", label: "90 j", days: 90 },
  { key: "all", label: "Tout", days: null },
] as const;

const SORTS = {
  date_desc: { label: "Plus récentes", orderBy: [{ createdAt: "desc" }] },
  date_asc: { label: "Plus anciennes", orderBy: [{ createdAt: "asc" }] },
  total_desc: { label: "Montant décroissant", orderBy: [{ totalCents: "desc" }, { createdAt: "desc" }] },
  total_asc: { label: "Montant croissant", orderBy: [{ totalCents: "asc" }, { createdAt: "desc" }] },
} satisfies Record<string, { label: string; orderBy: Prisma.CheckoutSessionOrderByWithRelationInput[] }>;
type SortKey = keyof typeof SORTS;

const PAGE_SIZE = 50;
const DRILL_KEYS = ["source", "country", "method", "product", "device"] as const;

type Params = {
  /** Attribution window of a source drill from Analytics (1, 7 or 28 days). */
  win?: string;
  /** Visitor's country (IP) and checkout language drill-downs from Analytics. */
  geo?: string;
  lang?: string;
  ok?: string;
  error?: string;
  filter?: string;
  q?: string;
  page?: string;
  period?: string;
  sort?: string;
  from?: string;
  to?: string;
  test?: string;
} & Partial<Record<(typeof DRILL_KEYS)[number], string>>;

export default async function OrdersPage({ params, searchParams }: { params: Promise<{ storeId: string }>; searchParams: Promise<Params> }) {
  const { storeId } = await params;
  await requireStoreAccess(storeId, "view");
  const sp = await searchParams;
  const filter = FILTERS.find((f) => f.key === sp.filter) ?? FILTERS[0];
  const sort: SortKey = sp.sort && sp.sort in SORTS ? (sp.sort as SortKey) : "date_desc";
  const q = (sp.q ?? "").trim().slice(0, 100);
  const page = Math.max(1, parseInt(sp.page ?? "1", 10) || 1);
  const store = await db.store.findUnique({ where: { id: storeId }, select: { id: true, timezone: true } });
  if (!store) notFound();

  // Explicit Paris days (drill-down from Analytics) take precedence over the quick periods.
  const from = isDay(sp.from) ? sp.from : undefined;
  const to = isDay(sp.to) ? sp.to : undefined;
  const dated = !!(from || to);
  const period = dated ? null : (PERIODS.find((p) => p.key === sp.period) ?? PERIODS[3]);
  const since = from ? parisDayStart(from, tzOf(store)) : period?.days ? daysAgo(period.days) : null;
  const until = to ? parisDayStart(addDays(to, 1), tzOf(store)) : null;
  const drill: Drill = {
    source: sp.source?.slice(0, 100) || undefined,
    country: sp.country && /^([A-Z]{2}|—)$/.test(sp.country) ? sp.country : undefined,
    method: sp.method?.slice(0, 60) || undefined,
    product: sp.product?.slice(0, 200) || undefined,
    device: sp.device === "mobile" || sp.device === "desktop" ? sp.device : undefined,
    geo: sp.geo && /^([A-Z]{2}|inconnu)$/.test(sp.geo) ? sp.geo : undefined,
    lang: sp.lang && /^([a-z]{2,3}|inconnu)$/.test(sp.lang) ? sp.lang : undefined,
  };
  const realOnly = sp.test === "0";
  const drillIds = hasDrill(drill) ? await drillSessionIds(storeId, drill, { since, until, includeTest: !realOnly, attributionDays: Number(sp.win) || undefined }) : null;

  // Period: on the payment date for paid orders, on the opening date for the others.
  const range = (gte: Date | null, lt: Date | null) => ({ ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) });
  const periodWhere: Prisma.CheckoutSessionWhereInput =
    since || until ? { OR: [{ paidAt: range(since, until) }, { paidAt: null, createdAt: range(since, until) }] } : {};
  const searchWhere: Prisma.CheckoutSessionWhereInput = q
    ? {
        OR: [
          { email: { contains: q, mode: "insensitive" } },
          { shopifyOrderName: { contains: q.replace(/^#?/, "#"), mode: "insensitive" } },
          { id: q },
          { whopPaymentId: q },
        ],
      }
    : {};
  const extraWhere: Prisma.CheckoutSessionWhereInput = { ...(drillIds ? { id: { in: drillIds } } : {}), ...(realOnly ? { test: false } : {}) };
  const scoped = (w: Prisma.CheckoutSessionWhereInput): Prisma.CheckoutSessionWhereInput => ({ storeId, AND: [periodWhere, searchWhere, extraWhere, w] });
  const where = scoped(filter.where);

  const [sessions, counts] = await Promise.all([
    db.checkoutSession.findMany({
      where,
      orderBy: SORTS[sort].orderBy,
      take: PAGE_SIZE,
      skip: (page - 1) * PAGE_SIZE,
      select: {
        id: true,
        createdAt: true,
        paidAt: true,
        email: true,
        shippingAddress: true,
        totalCents: true,
        subtotalCents: true,
        refundedCents: true,
        currency: true,
        status: true,
        disputed: true,
        shopifyOrderName: true,
        reviewNote: true,
        syncError: true,
        test: true,
      },
    }),
    Promise.all(FILTERS.map((f) => db.checkoutSession.count({ where: scoped(f.where) }))),
  ]);
  const countOf = Object.fromEntries(FILTERS.map((f, i) => [f.key, counts[i]])) as Record<string, number>;
  const total = countOf[filter.key];
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const base = `/dashboard/stores/${storeId}/orders`;
  const detail = (id: string) => `${base}/${id}`;
  const current: Record<string, string | number | undefined> = {
    filter: filter.key,
    period: period?.key,
    sort,
    q: q || undefined,
    from,
    to,
    test: realOnly ? "0" : undefined,
    ...Object.fromEntries(DRILL_KEYS.map((k) => [k, drill[k]])),
  };
  const link = (p: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...current, ...p })) {
      // Keep URLs short: defaults are implicit.
      if (v == null || v === "" || (k === "filter" && v === "paid") || (k === "period" && v === "all") || (k === "sort" && v === "date_desc") || (k === "page" && String(v) === "1")) continue;
      u.set(k, String(v));
    }
    const s = u.toString();
    return `${base}${s ? `?${s}` : ""}`;
  };
  const exportParams = new URLSearchParams();
  if (from || to) {
    if (from) exportParams.set("from", from);
    if (to) exportParams.set("to", to);
  } else exportParams.set("days", String(period?.days ?? 365));
  if (!realOnly) exportParams.set("test", "1");
  for (const k of DRILL_KEYS) if (drill[k]) exportParams.set(k, drill[k]!);
  const exportHref = `${base}/export?${exportParams}`;
  const first = total ? (page - 1) * PAGE_SIZE + 1 : 0;
  const last = Math.min(total, page * PAGE_SIZE);
  const emptyEmail = (status: SessionStatus) => (status === "PAID" ? "E-mail non transmis" : "Pas encore d'e-mail");
  const paidTab = filter.key === "paid" || filter.key === "todo";
  const chips = [
    ...(dated ? [{ key: "dates", label: `${from ? dayLabel(from) : "…"} → ${to ? dayLabel(to) : "aujourd'hui"}`, clear: { from: undefined, to: undefined } }] : []),
    ...(drill.source ? [{ key: "source", label: `Source : ${sourceLabel(drill.source)}`, clear: { source: undefined } }] : []),
    ...(drill.country ? [{ key: "country", label: `Pays : ${countryName(drill.country)}`, clear: { country: undefined } }] : []),
    ...(drill.method ? [{ key: "method", label: `Paiement : ${METHOD_LABELS[drill.method] ?? drill.method}`, clear: { method: undefined } }] : []),
    ...(drill.product ? [{ key: "product", label: `Produit : ${drill.product.replace(/^gid:\/\/shopify\/Product\//, "#")}`, clear: { product: undefined } }] : []),
    ...(drill.device ? [{ key: "device", label: drill.device === "mobile" ? "Mobile" : "Ordinateur", clear: { device: undefined } }] : []),
    ...(drill.geo ? [{ key: "geo", label: `Pays du visiteur : ${drill.geo === "inconnu" ? "inconnu" : countryName(drill.geo)}`, clear: { geo: undefined } }] : []),
    ...(drill.lang ? [{ key: "lang", label: `Langue : ${drill.lang}`, clear: { lang: undefined } }] : []),
    ...(realOnly ? [{ key: "test", label: "Hors commandes test", clear: { test: undefined } }] : []),
  ];
  const back = link({ page: page > 1 ? page : undefined });

  return (
    <>
      <PageHeader
        icon={Receipt}
        title="Commandes"
        description="Chaque checkout passé par votre page Whop, et son statut dans Shopify."
        actions={
          <a href={exportHref} className={`${buttonClass("secondary")} min-h-9 !px-2.5 sm:!px-4`} download aria-label="Exporter les commandes payées (CSV)">
            <Download className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Exporter (CSV)</span>
          </a>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        {/* Phones: one scrollable row of tabs, faded at the edges instead of wrapping. */}
        <nav
          aria-label="Statut"
          className="-mx-4 flex min-w-0 gap-1 overflow-x-auto px-4 [mask-image:linear-gradient(to_right,transparent,#000_16px,#000_calc(100%-24px),transparent)] [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:[mask-image:none] [&::-webkit-scrollbar]:hidden"
        >
          {FILTERS.map((f) => {
            const active = f.key === filter.key;
            return (
              <Link
                key={f.key}
                href={link({ filter: f.key, page: undefined })}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-sm whitespace-nowrap transition sm:px-3 ${
                  active ? "bg-zinc-900 font-medium text-white shadow-sm" : "text-zinc-600 hover:bg-white hover:shadow-[var(--shadow-card)]"
                }`}
              >
                {f.label}
                <span
                  className={`rounded-full px-1.5 text-xs leading-5 font-semibold tabular-nums ${
                    f.key === "todo" && countOf.todo > 0 ? "bg-red-600 text-white" : active ? "bg-white/20 text-white" : "bg-zinc-200/70 text-zinc-700"
                  }`}
                >
                  {formatNumber(countOf[f.key])}
                </span>
              </Link>
            );
          })}
        </nav>
        <OrderSearch initial={q} />
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="Période" className="flex rounded-lg bg-white p-0.5 text-sm shadow-[var(--shadow-card)]">
          {PERIODS.map((p) => (
            <Link
              key={p.key}
              href={link({ period: p.key, from: undefined, to: undefined, page: undefined })}
              aria-current={p.key === period?.key ? "true" : undefined}
              className={`inline-flex min-h-8 items-center rounded-md px-3 transition ${p.key === period?.key ? "bg-zinc-900 font-medium text-white" : "text-zinc-600 hover:text-zinc-900"}`}
            >
              {p.label}
            </Link>
          ))}
        </nav>
        {/* Phones only: on larger screens the Date / Total column headers sort. */}
        <PopoverDetails className="group relative md:hidden">
          <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-2 rounded-lg bg-white px-3 text-sm text-zinc-700 shadow-[var(--shadow-card)] hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
            <ArrowUpDown className="h-4 w-4 text-zinc-500" aria-hidden />
            <span className="hidden text-zinc-500 sm:inline">Trier :</span> <span className="font-medium">{SORTS[sort].label}</span>
          </summary>
          <ul className="absolute right-0 z-20 mt-1.5 w-56 rounded-xl bg-white p-1.5 shadow-[var(--shadow-float)]">
            {(Object.keys(SORTS) as SortKey[]).map((k) => (
              <li key={k}>
                <Link
                  href={link({ sort: k, page: undefined })}
                  aria-current={k === sort ? "true" : undefined}
                  className={`flex min-h-9 items-center rounded-lg px-2.5 text-sm hover:bg-zinc-100 ${k === sort ? "font-medium text-indigo-700" : "text-zinc-700"}`}
                >
                  {SORTS[k].label}
                </Link>
              </li>
            ))}
          </ul>
        </PopoverDetails>
      </div>

      {(chips.length > 0 || q) && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-zinc-600">
          {q && (
            <span>
              Résultats pour « <strong className="font-medium text-zinc-900">{q}</strong> »
            </span>
          )}
          {chips.map((c) => (
            <Link
              key={c.key}
              href={link({ ...c.clear, page: undefined })}
              className="inline-flex min-h-8 items-center gap-1 rounded-full bg-indigo-50 px-2.5 text-xs font-medium text-indigo-800 ring-1 ring-indigo-600/15 hover:bg-indigo-100"
            >
              {c.label} <X className="h-3 w-3" aria-hidden />
              <span className="sr-only">(retirer ce filtre)</span>
            </Link>
          ))}
          <Link
            href={link({ q: undefined, from: undefined, to: undefined, test: undefined, page: undefined, ...Object.fromEntries(DRILL_KEYS.map((k) => [k, undefined])) })}
            className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 font-medium text-indigo-600 hover:bg-indigo-50"
          >
            Tout effacer
          </Link>
        </div>
      )}

      <Card className="overflow-hidden !p-0">
        {sessions.length === 0 ? (
          <EmptyState icon={Receipt} title={q ? "Aucun résultat" : total === 0 && period?.key === "all" && filter.key === "paid" && !chips.length ? "Aucune commande pour l'instant" : "Rien sur cette sélection"}>
            {q
              ? "Essayez un autre e-mail ou numéro de commande."
              : total === 0 && period?.key === "all" && filter.key === "paid" && !chips.length
                ? "Elles apparaissent ici dès qu'un client paie sur votre checkout."
                : "Élargissez la période, retirez un filtre ou changez d'onglet."}
          </EmptyState>
        ) : (
          <form id="orders-bulk" action={`${base}/export`} method="get">
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="test" value="1" />
            <OrdersBulkBar formId="orders-bulk" resync={resyncOrdersAction.bind(null, storeId)} />
            {/* Desktop */}
            <table className="hidden w-full text-left text-sm md:table">
              <caption className="sr-only">
                Commandes « {filter.label} », {SORTS[sort].label.toLowerCase()}
              </caption>
              <thead className="border-b border-zinc-100 text-xs text-zinc-500">
                <tr>
                  <th scope="col" className="w-10 pl-4">
                    <OrdersSelectAll formId="orders-bulk" />
                  </th>
                  <SortHeader label="Date" asc="date_asc" desc="date_desc" sort={sort} link={link} />
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Client
                  </th>
                  <SortHeader label="Total" asc="total_asc" desc="total_desc" sort={sort} link={link} />
                  {!paidTab && (
                    <th scope="col" className="px-4 py-2.5 font-medium">
                      Statut
                    </th>
                  )}
                  <th scope="col" className="px-4 py-2.5 font-medium">
                    Shopify
                  </th>
                  <th scope="col" className="w-8">
                    <span className="sr-only">Détail</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {sessions.map((s) => (
                  <tr key={s.id} className="group relative transition hover:bg-zinc-50/80">
                    <td className="relative z-10 pl-4">
                      <input type="checkbox" name="ids" value={s.id} aria-label={`Sélectionner ${s.shopifyOrderName ?? s.email ?? s.id}`} className="h-4 w-4 accent-indigo-600" />
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-zinc-600 tabular-nums">
                      <Link href={detail(s.id)} className="rounded after:absolute after:inset-0">
                        {formatDateTime(s.paidAt ?? s.createdAt, false, tzOf(store))}
                      </Link>
                      {s.test && <span className="ml-1.5 text-[11px] font-medium text-amber-700">test</span>}
                    </td>
                    <td className="max-w-[280px] px-4 py-2.5">
                      {nameOf(s.shippingAddress) && <span className="block truncate font-medium text-zinc-900">{nameOf(s.shippingAddress)}</span>}
                      {s.email ? (
                        <span className={`block truncate ${nameOf(s.shippingAddress) ? "text-xs text-zinc-500" : "text-zinc-900"}`}>{s.email}</span>
                      ) : (
                        <span className="block text-xs text-zinc-500 italic">{emptyEmail(s.status)}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-medium whitespace-nowrap tabular-nums">
                      {formatCents(s.totalCents || s.subtotalCents, s.currency)}
                      {s.refundedCents > 0 && <span className="block text-xs font-normal text-red-700">−{formatCents(s.refundedCents, s.currency)} remboursé</span>}
                    </td>
                    {!paidTab && (
                      <td className="px-4 py-3">
                        <StatusBadge status={s.status} disputed={s.disputed} />
                      </td>
                    )}
                    <td className="px-4 py-3">
                      <ShopifySync s={s} />
                      {paidTab && s.disputed && (
                        <span className="ml-1.5">
                          <Badge color="red">Litige</Badge>
                        </span>
                      )}
                    </td>
                    <td className="px-2 text-zinc-400 group-hover:text-zinc-600">
                      <ChevronRight className="h-4 w-4" aria-hidden />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile */}
            <ul className="divide-y divide-zinc-100 md:hidden">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center">
                  <label className="flex min-h-11 items-center self-stretch pr-1 pl-4">
                    <input type="checkbox" name="ids" value={s.id} aria-label={`Sélectionner ${s.shopifyOrderName ?? s.email ?? s.id}`} className="h-4 w-4 accent-indigo-600" />
                  </label>
                  <Link href={detail(s.id)} className="flex min-w-0 flex-1 items-center gap-3 py-3.5 pr-4 pl-2 active:bg-zinc-50">
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="min-w-0">
                          {nameOf(s.shippingAddress) && <span className="block truncate text-sm font-medium">{nameOf(s.shippingAddress)}</span>}
                          {s.email ? (
                            <span className={`block truncate ${nameOf(s.shippingAddress) ? "text-xs text-zinc-500" : "text-sm font-medium"}`}>{s.email}</span>
                          ) : (
                            <span className="block truncate text-sm text-zinc-500 italic">{emptyEmail(s.status)}</span>
                          )}
                        </span>
                        <span className="shrink-0 text-sm font-semibold tabular-nums">{formatCents(s.totalCents || s.subtotalCents, s.currency)}</span>
                      </span>
                      <span className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-500">
                        <span className="tabular-nums">{formatDateTime(s.paidAt ?? s.createdAt, false, tzOf(store))}</span>
                        {s.status === "PAID" ? <ShopifySync s={s} /> : <StatusBadge status={s.status} disputed={s.disputed} />}
                      </span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />
                  </Link>
                </li>
              ))}
            </ul>
          </form>
        )}
      </Card>

      {total > 0 && (
        <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-zinc-600">
          <span className="tabular-nums">
            {formatNumber(first)}–{formatNumber(last)} sur {formatNumber(total)} résultat{total > 1 ? "s" : ""}
            {pages > 1 && (
              <span className="text-zinc-500">
                {" "}
                · page {formatNumber(page)} / {formatNumber(pages)}
              </span>
            )}
          </span>
          {pages > 1 && (
            <span className="flex gap-2">
              <PageLink href={page > 1 ? link({ page: page - 1 }) : null} rel="prev">
                <ChevronLeft className="h-4 w-4" aria-hidden /> Précédent
              </PageLink>
              <PageLink href={page < pages ? link({ page: page + 1 }) : null} rel="next">
                Suivant <ChevronRight className="h-4 w-4" aria-hidden />
              </PageLink>
            </span>
          )}
        </nav>
      )}
    </>
  );
}

function dayLabel(d: string) {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
}

function nameOf(address: unknown): string | null {
  const a = address as { firstName?: string; lastName?: string } | null;
  const name = [a?.firstName, a?.lastName].filter(Boolean).join(" ").trim();
  return name || null;
}

/** Shopify side of a paid order: created (#1234), waiting, held for review, or failing. */
function ShopifySync({ s }: { s: { status: SessionStatus; shopifyOrderName: string | null; reviewNote: string | null; syncError: string | null } }) {
  if (s.status !== "PAID")
    return (
      <span className="text-zinc-500" title="Pas de commande Shopify tant que le paiement n'est pas reçu">
        <span aria-hidden>—</span>
        <span className="sr-only">Pas de commande Shopify (non payé)</span>
      </span>
    );
  if (s.shopifyOrderName) return <Badge color="green">Créée {s.shopifyOrderName}</Badge>;
  if (s.reviewNote) return <Badge color="amber">À vérifier</Badge>;
  if (s.syncError)
    return (
      <span title={humanizeError(s.syncError).text}>
        <Badge color="red">Erreur</Badge>
        <span className="sr-only"> : {humanizeError(s.syncError).text}</span>
      </span>
    );
  return <Badge color="blue">En attente</Badge>;
}

function SortHeader({
  label,
  asc,
  desc,
  sort,
  link,
}: {
  label: string;
  asc: SortKey;
  desc: SortKey;
  sort: SortKey;
  link: (p: Record<string, string | number | undefined>) => string;
}) {
  const state = sort === asc ? "ascending" : sort === desc ? "descending" : "none";
  const next = state === "descending" ? asc : desc;
  const Icon = state === "ascending" ? ArrowUp : state === "descending" ? ArrowDown : ArrowUpDown;
  return (
    <th scope="col" aria-sort={state} className="px-4 py-2.5 font-medium">
      <Link
        href={link({ sort: next, page: undefined })}
        className={`-mx-1.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-zinc-100 hover:text-zinc-900 ${state !== "none" ? "text-zinc-900" : ""}`}
      >
        {label}
        <Icon className={`h-3 w-3 ${state === "none" ? "text-zinc-400" : ""}`} aria-hidden />
        <span className="sr-only">, trier {next.endsWith("asc") ? "par ordre croissant" : "par ordre décroissant"}</span>
      </Link>
    </th>
  );
}

function PageLink({ href, rel, children }: { href: string | null; rel: "prev" | "next"; children: React.ReactNode }) {
  const cls = "inline-flex min-h-9 items-center gap-1 rounded-lg bg-white px-3 shadow-[var(--shadow-card)]";
  return href ? (
    <Link href={href} rel={rel} className={`${cls} text-zinc-800 hover:bg-zinc-50`}>
      {children}
    </Link>
  ) : (
    <span aria-disabled="true" className={`${cls} cursor-not-allowed text-zinc-400`}>
      {children}
    </span>
  );
}
