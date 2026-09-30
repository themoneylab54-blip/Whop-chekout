import { zoneLabel } from "@/lib/time";
import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowDown, ArrowRight, ArrowUp, ArrowUpDown, Download, Plus, ShoppingBag, Store as StoreIcon, XCircle } from "lucide-react";
import type { Anomaly } from "@/lib/analytics";
import { requireUser } from "@/lib/auth";
import { accessibleStoreWhere, roleAtLeast } from "@/lib/access";
import { db } from "@/lib/db";
import { storeHealth } from "@/lib/health";
import { STORE_SORTS, crossStoreStats, sortStores, type CrossStoreRow, type StoreSort } from "@/lib/dashboard-stats";
import { DASHBOARD_FLASH, flashMessages } from "@/lib/team-rules";
import { Badge, Flash, Input, Label, SubmitButton, buttonClass } from "@/components/ui";
import { AuthShell } from "@/components/dashboard/AuthShell";
import { formatCentsRound } from "@/components/dashboard/format";
import { Delta, EstimatedBadge, InfoTip, int, multiple, pct, type DeltaInput } from "@/components/dashboard/AnalyticsKit";
import { AnalyticsControls, hrefWith, parseControls, stateParams, type ControlParams } from "@/components/dashboard/AnalyticsControls";
import { ProfitChart } from "@/components/dashboard/ProfitChart";
import { createStoreAction, logoutAction } from "./actions";
import { UserMenu } from "@/components/dashboard/AccountShell";
import "./dashboard.css";
import { PopoverDetails } from "@/components/dashboard/Popover";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Boutiques" };

type Row = CrossStoreRow & { problems: number; checks: number };

const CONVERSION_INFO =
  "Conversion checkout : commence à « Checkout ouvert ». Visiteurs uniques ayant payé ÷ visiteurs uniques ayant ouvert le checkout (les visites de la boutique sans ouverture du checkout ne comptent pas).";

const COLUMNS: { key: StoreSort; label: string; info?: string }[] = [
  { key: "ca", label: "CA HT" },
  { key: "orders", label: "Cmd" },
  { key: "cvr", label: "Conv. checkout", info: CONVERSION_INFO },
  {
    key: "margin",
    label: "Marge nette",
    info: "CA HT − frais Whop − coûts (produits, options, livraison, préparation) − litiges.",
  },
  { key: "spend", label: "Pub" },
  { key: "roas", label: "ROAS HT", info: "CA HT ÷ dépenses publicitaires." },
  {
    key: "poas",
    label: "POAS",
    info: "Marge nette ÷ dépenses publicitaires : au-dessus de 1, la pub est rentable.",
  },
  {
    key: "net",
    label: "Après pub",
    info: "Marge nette − dépenses publicitaires.",
  },
  {
    key: "netfixed",
    label: "Net après frais fixes",
    info: "Marge après pub − frais fixes mensuels au prorata des jours de la période (Paramètres › Coûts de chaque boutique).",
  },
];

const ANOMALY_LABEL: Record<Anomaly["key"], string> = {
  conversion: "Conversion ↓",
  roas: "ROAS ↓",
  refunds: "Remboursements ↑",
};

/** Every store at a glance for a period (CA HT, orders, conversion, margin, ads, health), same engine as each store's Analytics. */
export default async function DashboardHome({ searchParams }: { searchParams: Promise<ControlParams & { sort?: string; dir?: string; ok?: string; error?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  // Fixed codes only (a refusal, a self-demotion): nothing from the URL is shown as is.
  const flash = flashMessages(DASHBOARD_FLASH, sp);
  // Only the stores the user may open; viewers can't add one.
  const where = accessibleStoreWhere(user);
  const canCreate = roleAtLeast(user.role, "admin");
  const storeCount = await db.store.count({ where });
  if (storeCount === 0 && !canCreate) {
    return (
      <AuthShell title="Aucune boutique pour l'instant" subtitle="Aucune boutique ne vous est encore attribuée : demandez l'accès au propriétaire du compte.">
        <Flash ok={flash.ok} error={flash.error} />
        <div className="flex items-center justify-center gap-4">
          <Link href="/dashboard/account" className="inline-flex min-h-8 items-center text-sm text-zinc-500 underline-offset-4 hover:underline">
            Mon profil
          </Link>
          <form action={logoutAction}>
            <button className="min-h-8 text-sm text-zinc-500 underline-offset-4 hover:underline">Se déconnecter</button>
          </form>
        </div>
      </AuthShell>
    );
  }
  if (storeCount === 0) {
    return (
      <AuthShell title="Ajoutez votre première boutique" subtitle="Donnez-lui un nom, on s'occupe du reste en 5 minutes.">
        <Flash ok={flash.ok} error={flash.error} />
        <form action={createStoreAction} className="space-y-4">
          <div>
            <Label htmlFor="name">Nom de la boutique</Label>
            <Input id="name" name="name" placeholder="Ma boutique" required autoFocus maxLength={80} />
          </div>
          <SubmitButton className="w-full py-2.5">Créer la boutique</SubmitButton>
        </form>
        {/* Before any store: the profile and the team (invite someone to set it up) stay reachable. */}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
          <Link href="/dashboard/account" className="inline-flex min-h-8 items-center text-sm text-zinc-500 underline-offset-4 hover:underline">
            Mon profil
          </Link>
          <Link href="/dashboard/team" className="inline-flex min-h-8 items-center text-sm text-zinc-500 underline-offset-4 hover:underline">
            Équipe
          </Link>
          <form action={logoutAction}>
            <button className="min-h-8 text-sm text-zinc-500 underline-offset-4 hover:underline">Se déconnecter</button>
          </form>
        </div>
      </AuthShell>
    );
  }

  const state = parseControls({ range: sp.range, from: sp.from, to: sp.to }, { testMode: false });
  const { range } = state;
  const sort: StoreSort = STORE_SORTS.includes(sp.sort as StoreSort) ? (sp.sort as StoreSort) : "ca";
  const dir: "asc" | "desc" = sp.dir === "asc" ? "asc" : "desc";
  const keep = {
    sort: sort === "ca" ? undefined : sort,
    dir: dir === "desc" ? undefined : dir,
  };
  const { rows: base, totals, zones } = await crossStoreStats(range, where);
  // Days are each store's own (its time zone): said plainly when the stores don't share one.
  const daysNote = zones.length > 1 ? `Jours du fuseau de chaque boutique (${zones.map((z) => zoneLabel(z)).join(", ")}) : totaux par jour approximatifs.` : `Jours en ${zoneLabel(zones[0] ?? "Europe/Paris")}.`;
  const rows: Row[] = sortStores(
    await Promise.all(
      base.map(async (r) => {
        const health = r.ready ? await storeHealth(r.id) : [];
        return {
          ...r,
          problems: health.filter((h) => h.ok === false).length,
          checks: health.length,
        };
      }),
    ),
    sort,
    dir,
  );
  const vs = range.key === "today" ? "vs hier" : range.key === "yesterday" ? "vs avant-hier" : `vs ${int(range.days)} j précédents`;
  const totalMoney = (c: number) => formatCentsRound(c, totals.currency);
  const csvHref = `/dashboard/export?${stateParams(state, { range: range.key, from: range.from, to: range.to, test: undefined, ...keep })}`;
  // First click sorts descending (biggest first; A→Z for the name), a second click reverses.
  const sortHref = (key: StoreSort) => {
    const next = sort === key ? (dir === "desc" ? "asc" : "desc") : key === "name" ? "asc" : "desc";
    return hrefWith("/dashboard", state, {
      sort: key === "ca" ? undefined : key,
      dir: next === "desc" ? undefined : next,
    });
  };

  return (
    <div className="dash min-h-full bg-[#f7f8fa]">
      <header className="border-b border-zinc-200/70 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <span className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-white">
              <ShoppingBag className="h-4 w-4" aria-hidden />
            </span>
            Whop Checkout
          </span>
          <UserMenu user={user} />
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.02em] text-zinc-900 sm:text-[26px]">Vos boutiques</h1>
            <p className="mt-1 text-sm text-zinc-500">CA HT net des remboursements, marge nette après frais et coûts, publicité. {daysNote}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a href={csvHref} download className={`${buttonClass("secondary")} min-h-9 !px-3`}>
              <Download className="h-4 w-4" aria-hidden /> CSV
              <span className="sr-only"> de toutes les boutiques</span>
            </a>
            {canCreate && (
              <PopoverDetails className="group relative">
                <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 rounded-lg bg-white px-3 text-sm font-medium text-zinc-800 shadow-[var(--shadow-card)] hover:bg-zinc-50 [&::-webkit-details-marker]:hidden">
                  <Plus className="h-4 w-4" aria-hidden /> Ajouter une boutique
                </summary>
                <form
                  action={createStoreAction}
                  className="absolute right-0 z-20 mt-1.5 hidden w-72 max-w-[calc(100vw-2rem)] space-y-3 group-open:block rounded-xl bg-white p-3 shadow-[var(--shadow-float)]"
                >
                  <div>
                    <Label htmlFor="name">Nom de la boutique</Label>
                    <Input id="name" name="name" placeholder="Ma boutique" required />
                  </div>
                  <SubmitButton className="w-full">Créer</SubmitButton>
                </form>
              </PopoverDetails>
            )}
          </div>
        </div>
        <Flash ok={flash.ok} error={flash.error} />

        <AnalyticsControls base="/dashboard" state={state} options={{ sources: [], countries: [] }} testMode={false} showFilters={false} showTest={false} keep={keep} />
        {range.error && (
          <p role="alert" className="-mt-2 mb-4 text-sm text-red-700">
            {range.error}
          </p>
        )}

        {rows.length > 0 && (
          <section aria-label={`Totaux, ${range.label}`} className="mb-6">
            {rows.length > 1 && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <Total
                  label="CA HT"
                  value={totalMoney(totals.now.revenueHtCents)}
                  delta={{
                    now: totals.now.revenueHtCents,
                    before: totals.previous.revenueHtCents,
                  }}
                  vs={vs}
                />
                <Total
                  label="Commandes"
                  value={int(totals.now.orders)}
                  delta={{
                    now: totals.now.orders,
                    before: totals.previous.orders,
                  }}
                  vs={vs}
                />
                <Total
                  label="Marge nette"
                  value={totalMoney(totals.now.profitCents)}
                  delta={
                    totals.previous.orders
                      ? {
                          now: totals.now.profitCents,
                          before: totals.previous.profitCents,
                          estimated: totals.estimated,
                        }
                      : { unavailable: "pas de commande avant" }
                  }
                  vs={vs}
                  estimated={totals.estimated}
                />
                <Total
                  label="Marge après pub"
                  value={totalMoney(totals.now.netAfterAdsCents)}
                  delta={
                    totals.previous.orders
                      ? {
                          now: totals.now.netAfterAdsCents,
                          before: totals.previous.netAfterAdsCents,
                          estimated: totals.estimated,
                        }
                      : { unavailable: "pas de commande avant" }
                  }
                  vs={vs}
                  estimated={totals.estimated}
                  secondary={totals.now.spendCents ? `pub : ${totalMoney(totals.now.spendCents)}` : "aucune dépense pub"}
                />
                <Total
                  label="Net après frais fixes"
                  value={totalMoney(totals.now.netAfterFixedCents)}
                  delta={
                    totals.previous.orders
                      ? {
                          now: totals.now.netAfterFixedCents,
                          before: totals.previous.netAfterFixedCents,
                          estimated: totals.estimated,
                        }
                      : { unavailable: "pas de commande avant" }
                  }
                  vs={vs}
                  estimated={totals.estimated}
                  secondary={totals.now.fixedCostsCents ? `frais fixes : ${totalMoney(totals.now.fixedCostsCents)}` : "frais fixes non renseignés"}
                />
              </div>
            )}
            {totals.daily.length > 1 && (
              <figure className={`${rows.length > 1 ? "mt-3" : ""} rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]`}>
                <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-zinc-900">
                    Marge après pub par jour
                    {rows.length > 1 ? ", toutes boutiques" : ""}
                  </span>
                  <span className="text-xs text-zinc-500">
                    Total {totalMoney(totals.now.netAfterAdsCents)}
                    {totals.converted ? " · converti en EUR" : ""}
                  </span>
                </figcaption>
                <ProfitChart
                  title={`Marge après pub par jour${rows.length > 1 ? ", toutes boutiques" : ""}`}
                  currency={totals.currency}
                  points={totals.daily.map((d) => ({
                    date: d.day,
                    label: new Date(`${d.day}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }),
                    cents: d.netAfterAdsCents,
                  }))}
                />
              </figure>
            )}
            {(totals.converted || totals.skipped.length > 0) && (
              <p className="mt-2 text-xs text-zinc-500">
                {totals.converted &&
                  `Totaux convertis en EUR au taux de référence BCE${totals.rateDate ? ` du ${new Date(`${totals.rateDate}T12:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC" })}` : ""} (boutiques en plusieurs devises). `}
                {totals.skipped.length > 0 && `Sans taux de change disponible, non comptées : ${totals.skipped.join(", ")}.`}
              </p>
            )}
          </section>
        )}

        {/* Desktop */}
        <section aria-label="Chiffres clés de chaque boutique" className="relative hidden overflow-x-auto rounded-2xl bg-white shadow-[var(--shadow-card)] md:block">
          <table className="w-full min-w-[1080px] text-sm">
            <caption className="sr-only">
              Chiffres clés de chaque boutique, {range.label}, triés par {sort === "name" ? "nom" : (COLUMNS.find((c) => c.key === sort)?.label ?? sort)} (
              {dir === "asc" ? "croissant" : "décroissant"})
            </caption>
            <thead className="border-b border-zinc-100 text-xs text-zinc-500">
              <tr>
                <SortTh label="Boutique" k="name" sort={sort} dir={dir} href={sortHref("name")} align="left" />
                {COLUMNS.filter((c) => c.key !== "poas").map((c) =>
                  c.key === "roas" ? (
                    // ROAS and POAS share a column (two sort links) so the table fits a laptop screen.
                    <SortTh
                      key="roas"
                      label="ROAS"
                      k="roas"
                      sort={sort}
                      dir={dir}
                      href={sortHref("roas")}
                      second={{ label: "POAS", k: "poas", href: sortHref("poas") }}
                      info="ROAS HT = CA HT ÷ dépenses publicitaires. POAS = marge nette ÷ dépenses : au-dessus de 1, la pub est rentable."
                    />
                  ) : (
                    <SortTh key={c.key} label={c.label} k={c.key} sort={sort} dir={dir} href={sortHref(c.key)} info={c.info} wrap={c.label.length > 14} />
                  ),
                )}
                <th scope="col" className="px-3 py-3 text-left font-medium">
                  Santé
                </th>
                <th scope="col" className="py-3 pr-4 pl-1">
                  <span className="sr-only">Ouvrir</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((r) => {
                const s = r.summary;
                const money = (c: number) => formatCentsRound(c, r.currency);
                const est = !s.complete || !s.previous.complete;
                return (
                  <tr key={r.id} className="align-top hover:bg-zinc-50/70">
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-zinc-900">{r.name}</span>
                        <StatusBadge live={r.live} testMode={r.testMode} />
                      </span>
                      {r.currency !== "EUR" && <span className="text-xs text-zinc-500">en {r.currency}</span>}
                    </th>
                    <Cell
                      main={money(s.revenueHtCents)}
                      delta={{
                        now: s.revenueHtCents,
                        before: s.previous.revenueHtCents,
                      }}
                    />
                    <Cell main={int(s.orders)} delta={{ now: s.orders, before: s.previous.orders }} />
                    <Cell main={s.visitors ? pct(s.cvr, 1) : "—"} delta={s.visitors && s.previous.visitors ? { now: s.cvr, before: s.previous.cvr } : undefined} />
                    <Cell
                      main={
                        <>
                          <span className={s.profitCents < 0 ? "text-rose-700" : ""}>{s.orders ? money(s.profitCents) : "—"}</span>
                          {s.orders > 0 && !s.complete && <EstimatedBadge />}
                        </>
                      }
                      delta={
                        s.orders && s.previous.orders
                          ? {
                              now: s.profitCents,
                              before: s.previous.profitCents,
                              estimated: est,
                            }
                          : undefined
                      }
                    />
                    <Cell
                      main={s.spendCents ? money(s.spendCents) : "—"}
                      delta={
                        s.spendCents || s.previous.spendCents
                          ? {
                              now: s.spendCents,
                              before: s.previous.spendCents,
                              neutral: true,
                            }
                          : undefined
                      }
                    />
                    <td className="px-3 py-3 text-right tabular-nums">
                      <span className={`block whitespace-nowrap ${s.roas != null && s.roas < 1 ? "text-rose-700" : ""}`}>{multiple(s.roas)}</span>
                      <span className={`mt-0.5 block text-xs whitespace-nowrap ${s.poas != null && s.poas < 1 ? "text-rose-700" : "text-zinc-500"}`}>
                        POAS {multiple(s.poas)}
                      </span>
                    </td>
                    <Cell
                      main={<span className={s.netAfterAdsCents < 0 ? "text-rose-700" : ""}>{s.orders || s.spendCents ? money(s.netAfterAdsCents) : "—"}</span>}
                      delta={
                        s.previous.orders
                          ? {
                              now: s.netAfterAdsCents,
                              before: s.previous.netAfterAdsCents,
                              estimated: est,
                            }
                          : undefined
                      }
                    />
                    <Cell
                      main={
                        <span className={s.netAfterFixedCents < 0 ? "text-rose-700" : ""}>{s.orders || s.spendCents || s.fixedCostsCents ? money(s.netAfterFixedCents) : "—"}</span>
                      }
                      delta={
                        s.previous.orders
                          ? {
                              now: s.netAfterFixedCents,
                              before: s.previous.netAfterFixedCents,
                              estimated: est,
                            }
                          : undefined
                      }
                    />
                    <td className="px-3 py-3">
                      <Health problems={r.problems} checks={r.checks} anomalies={r.anomalies} />
                    </td>
                    <td className="py-3 pr-4 pl-1 text-right">
                      <Link
                        href={`/dashboard/stores/${r.id}`}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-zinc-900 text-white hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
                        title={`Ouvrir ${r.name}`}
                      >
                        <ArrowRight className="h-4 w-4" aria-hidden />
                        <span className="sr-only">Ouvrir {r.name}</span>
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>

        {/* Mobile */}
        <div className="md:hidden">
          <label className="mb-3 flex items-center gap-2 text-sm text-zinc-600">
            <ArrowUpDown className="h-4 w-4" aria-hidden />
            <span>Trier par</span>
            <span className="flex flex-wrap gap-1">
              {(["ca", "margin", "net", "netfixed", "orders"] as const).map((k) => (
                <Link
                  key={k}
                  href={hrefWith("/dashboard", state, {
                    sort: k === "ca" ? undefined : k,
                  })}
                  aria-current={sort === k ? "true" : undefined}
                  className={`inline-flex min-h-8 items-center rounded-lg px-2 text-xs ${sort === k ? "bg-zinc-900 font-medium text-white" : "bg-white text-zinc-700 shadow-[var(--shadow-card)]"}`}
                >
                  {COLUMNS.find((c) => c.key === k)?.label}
                </Link>
              ))}
            </span>
          </label>
          <ul className="space-y-3">
            {rows.map((r) => {
              const s = r.summary;
              const money = (c: number) => formatCentsRound(c, r.currency);
              const est = !s.complete || !s.previous.complete;
              return (
                <li key={r.id} className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <StoreIcon className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
                      <span className="truncate font-medium">{r.name}</span>
                    </span>
                    <StatusBadge live={r.live} testMode={r.testMode} />
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2">
                    <MobileStat
                      label="CA HT"
                      value={money(s.revenueHtCents)}
                      delta={{
                        now: s.revenueHtCents,
                        before: s.previous.revenueHtCents,
                      }}
                    />
                    <MobileStat label="Commandes" value={int(s.orders)} delta={{ now: s.orders, before: s.previous.orders }} />
                    <MobileStat
                      label="Marge nette"
                      value={s.orders ? money(s.profitCents) : "—"}
                      estimated={s.orders > 0 && !s.complete}
                      delta={
                        s.orders && s.previous.orders
                          ? {
                              now: s.profitCents,
                              before: s.previous.profitCents,
                              estimated: est,
                            }
                          : undefined
                      }
                    />
                    <MobileStat
                      label="Après pub"
                      value={s.orders || s.spendCents ? money(s.netAfterAdsCents) : "—"}
                      hint={s.spendCents ? `pub ${money(s.spendCents)} · ROAS ${multiple(s.roas)} · POAS ${multiple(s.poas)}` : "aucune dépense pub"}
                    />
                    <MobileStat
                      label="Net après frais fixes"
                      value={s.orders || s.spendCents || s.fixedCostsCents ? money(s.netAfterFixedCents) : "—"}
                      hint={s.fixedCostsCents ? `frais fixes ${money(s.fixedCostsCents)}` : "frais fixes non renseignés"}
                    />
                    <MobileStat
                      label="Conversion checkout"
                      value={s.visitors ? pct(s.cvr, 1) : "—"}
                      delta={s.visitors && s.previous.visitors ? { now: s.cvr, before: s.previous.cvr } : undefined}
                    />
                  </dl>
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-600">
                    <span>Santé :</span>
                    <Health problems={r.problems} checks={r.checks} anomalies={r.anomalies} />
                  </div>
                  <Link href={`/dashboard/stores/${r.id}`} className="mt-3 flex min-h-10 items-center justify-center gap-1 rounded-lg bg-zinc-900 text-sm font-medium text-white">
                    Ouvrir <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    <span className="sr-only">{r.name}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
        <p className="mt-4 text-xs text-zinc-500">
          Évolutions {vs}. CA HT : TVA retirée au taux normal du pays de livraison. Les commandes de test ne sont comptées que pour les boutiques en mode test. Marge nette = CA HT
          − frais Whop − coûts (produits, options, livraison, préparation) − litiges ; « ≈ estimé » quand certains coûts sont inconnus (comptés 0).
        </p>
      </main>
    </div>
  );
}

function SortTh({
  label,
  k,
  sort,
  dir,
  href,
  align = "right",
  info,
  wrap,
  second,
}: {
  label: string;
  k: StoreSort;
  sort: StoreSort;
  dir: "asc" | "desc";
  href: string;
  align?: "left" | "right";
  info?: string;
  /** Long label: may wrap on two lines. */
  wrap?: boolean;
  /** A second sortable metric sharing the column. */
  second?: { label: string; k: StoreSort; href: string };
}) {
  const links = [{ label, k, href }, ...(second ? [second] : [])];
  const active = links.some((l) => l.k === sort);
  return (
    <th
      scope="col"
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      className={`px-3 py-3 font-medium ${wrap ? "min-w-[7rem] max-w-[8.5rem] leading-tight" : "whitespace-nowrap"} ${align === "left" ? "pl-4 text-left" : "text-right"}`}
    >
      <span className={`inline-flex items-center gap-0.5 ${align === "right" ? "justify-end" : ""}`}>
        {links.map((l, i) => {
          const on = sort === l.k;
          const Icon = !on ? ArrowUpDown : dir === "asc" ? ArrowUp : ArrowDown;
          return (
            <span key={l.k} className="inline-flex items-center">
              {i > 0 && (
                <span aria-hidden className="px-0.5 text-zinc-300">
                  /
                </span>
              )}
              <Link href={l.href} className={`inline-flex min-h-8 items-center gap-1 rounded px-1 hover:text-zinc-900 ${wrap ? "text-right" : ""} ${on ? "text-zinc-900" : ""}`}>
                {l.label}
                <Icon className={`h-3 w-3 shrink-0 ${on ? "" : "opacity-50"}`} aria-hidden />
                <span className="sr-only">{on ? (dir === "asc" ? " (tri croissant, cliquer pour inverser)" : " (tri décroissant, cliquer pour inverser)") : " (trier)"}</span>
              </Link>
            </span>
          );
        })}
        {info && (
          <InfoTip label={`À propos : ${label}`} align="right">
            {info}
          </InfoTip>
        )}
      </span>
    </th>
  );
}

function Cell({ main, delta }: { main: React.ReactNode; delta?: DeltaInput }) {
  return (
    <td className="px-3 py-3 text-right tabular-nums">
      <span className="whitespace-nowrap">{main}</span>
      {delta && (
        <span className="mt-0.5 flex justify-end">
          <Delta d={delta} label="" compact />
        </span>
      )}
    </td>
  );
}

function MobileStat({ label, value, delta, hint, estimated }: { label: string; value: string; delta?: DeltaInput; hint?: string; estimated?: boolean }) {
  return (
    <div className="min-w-0 rounded-lg bg-zinc-50 px-2.5 py-2">
      <dt className="text-[11px] text-zinc-500">{label}</dt>
      <dd className="text-sm font-semibold tabular-nums">
        {value}
        {estimated && <EstimatedBadge />}
      </dd>
      {delta && (
        <dd>
          <Delta d={delta} label="" compact />
        </dd>
      )}
      {hint && <dd className="text-[11px] text-zinc-500">{hint}</dd>}
    </div>
  );
}

function StatusBadge({ live, testMode }: { live: boolean; testMode: boolean }) {
  if (!live) return <Badge color="zinc">Hors ligne</Badge>;
  return testMode ? <Badge color="amber">En ligne · test</Badge> : <Badge color="green">En ligne</Badge>;
}

function Health({ problems, checks, anomalies = [] }: { problems: number; checks: number; anomalies?: Anomaly[] }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {!checks ? (
        <span className="text-xs text-zinc-500">non configurée</span>
      ) : problems ? (
        <Badge color="red">
          {problems} problème{problems > 1 ? "s" : ""}
        </Badge>
      ) : (
        <Badge color="green">OK</Badge>
      )}
      {anomalies.map((x) => {
        const Icon = x.severity === "bad" ? XCircle : AlertTriangle;
        return (
          <span
            key={x.key}
            title={`${x.title}. ${x.detail}`}
            className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap ring-1 ring-inset ${x.severity === "bad" ? "bg-rose-50 text-rose-800 ring-rose-600/20" : "bg-amber-50 text-amber-900 ring-amber-600/25"}`}
          >
            <Icon className="h-3 w-3" aria-hidden />
            {ANOMALY_LABEL[x.key]}
            <span className="sr-only"> : {x.title}</span>
          </span>
        );
      })}
    </span>
  );
}

function Total({ label, value, delta, vs, estimated, secondary }: { label: string; value: string; delta: DeltaInput; vs: string; estimated?: boolean; secondary?: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-medium text-zinc-500">
        {label}
        {estimated && <EstimatedBadge />}
      </p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {secondary && <p className="text-xs text-zinc-500">{secondary}</p>}
      <div className="mt-1">
        <Delta d={delta} label={vs} hideEstimatedBadge={estimated} />
      </div>
    </div>
  );
}
