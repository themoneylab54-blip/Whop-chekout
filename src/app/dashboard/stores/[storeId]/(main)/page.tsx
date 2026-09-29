import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowRight,
  Check,
  CreditCard,
  Paintbrush,
  Percent,
  Power,
  Receipt,
  Rocket,
  ShoppingBag,
  ShoppingCart,
  TrendingUp,
  Truck,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { overviewStats } from "@/lib/dashboard-stats";
import { zoneLabel } from "@/lib/time";
import { IconTile } from "@/components/icons";
import { BrandTile, type Brand } from "@/components/brands";
import { Badge, Flash, SubmitButton } from "@/components/ui";
import { RevenueChart, type DailyPoint } from "@/components/dashboard/RevenueChart";
import { dayFlag, dayFlagKind } from "@/components/dashboard/dayFlags";
import { HealthGrid } from "@/components/dashboard/HealthGrid";
import { ConfirmButton } from "@/components/dashboard/ConfirmButton";
import { Sparkline } from "@/components/dashboard/Trend";
import { formatCents, formatNumber, formatPercent } from "@/components/dashboard/format";
import { Delta, EstimatedBadge, InfoTip, type DeltaInput } from "@/components/dashboard/AnalyticsKit";
import { storeHealth } from "@/lib/health";
import { anyProviderConnected, providerConnected, storeLive, storeReady, stripeUnusableReason } from "@/lib/payment-provider";
import { setEnabledAction } from "../../../actions";
import { AnalyticsControls, parseControls, type ControlParams } from "@/components/dashboard/AnalyticsControls";

/** Same segment as the layout, so its "%s · store" template does not apply: built here. */
export async function generateMetadata({ params }: { params: Promise<{ storeId: string }> }): Promise<Metadata> {
  const { storeId } = await params;
  const store = await db.store.findUnique({ where: { id: storeId }, select: { name: true } });
  return { title: { absolute: store ? `Vue d'ensemble · ${store.name}` : "Boutique introuvable" } };
}

const noPrev: DeltaInput = { unavailable: "rien sur la période précédente" };

export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<ControlParams & { ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const { storeId } = await params;
  const sp = await searchParams;
  const store = await db.store.findUnique({
    where: { id: storeId },
    include: { _count: { select: { shippingRates: true } } },
  });
  if (!store) notFound();

  // Same period, test filter and metric engine as the Analytics page (days of the store's time zone).
  const state = parseControls({ range: sp.range, from: sp.from, to: sp.to, test: sp.test }, store);
  const { range } = state;
  const { analytics: a, daily } = await overviewStats(storeId, range, state.includeTest);
  const money = (c: number) => formatCents(c, a.currency);
  const vsLabel = range.key === "today" ? "vs hier" : range.key === "yesterday" ? "vs avant-hier" : `vs ${range.days} j précédents`;
  const hasSpend = a.ads.spendCents > 0;
  const profit = hasSpend ? a.ads.netAfterAdsCents : a.profit.grossProfitCents;
  const prevProfit = hasSpend ? a.previous.netAfterAdsCents : a.previous.profitCents;
  // Sparklines follow the chart window (≥ 7 days) so even "today" shows a trend.
  const spark = {
    orders: daily.map((d) => d.orders),
    avg: daily.map((d) => (d.orders ? d.revenueCents / d.orders : 0)),
    conv: daily.map((d) => (d.started ? d.orders / d.started : 0)),
    profit: daily.map((d) => d.profitCents),
  };

  const points: DailyPoint[] = daily.map((d) => ({
    date: d.date,
    label: new Date(`${d.date}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }),
    cents: d.revenueHtCents,
    orders: d.orders,
    // Same remark and pattern as the Analytics chart (fallback, checkout switched off, or both).
    flag: dayFlag(d),
    flagKind: dayFlagKind(d),
  }));

  const base = `/dashboard/stores/${store.id}`;
  const steps: {
    done: boolean;
    title: string;
    text: string;
    href: string | null;
    icon: LucideIcon;
    brand?: Brand;
  }[] = [
    {
      done: !!store.shopifyConnectedAt,
      title: "Connecter Shopify",
      text: "Installez le script sur votre boutique",
      href: `${base}/shopify`,
      icon: ShoppingBag,
      brand: "shopify",
    },
    {
      // Any processor able to charge counts (a Stripe-only store never connects Whop).
      done: anyProviderConnected(store),
      title: store.stripeConnectedAt && !store.whopConnectedAt ? "Connecter Stripe" : "Connecter Whop",
      text: store.stripeConnectedAt && !store.whopConnectedAt ? "Terminez la connexion Stripe pour encaisser" : "Encaissez les paiements sur votre compte (ou avec Stripe)",
      href: store.stripeConnectedAt && !store.whopConnectedAt ? `${base}/stripe` : `${base}/whop`,
      icon: CreditCard,
      ...(store.stripeConnectedAt && !store.whopConnectedAt ? {} : { brand: "whop" as const }),
    },
    {
      done: store._count.shippingRates > 0,
      title: "Ajouter la livraison",
      text: "Au moins un tarif par pays livré",
      href: `${base}/shipping`,
      icon: Truck,
    },
    {
      done: !!store.checkoutLayout,
      title: "Designer le checkout",
      text: "Couleurs, logo, blocs de conversion",
      href: `${base}/builder/checkout`,
      icon: Paintbrush,
    },
    {
      done: store.enabled,
      title: "Mettre en ligne",
      text: "Remplacez le checkout Shopify",
      href: null,
      icon: Rocket,
    },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const health = doneCount === steps.length ? await storeHealth(store.id) : [];
  // Ready / live with any processor able to charge (Whop, or Stripe alone).
  const paymentReady = anyProviderConnected(store);
  const paymentHref = store.stripeConnectedAt && !store.whopConnectedAt ? "stripe" : "whop";
  const ready = storeReady(store);
  const live = storeLive(store);

  return (
    <>
      <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm text-zinc-500">Vue d&apos;ensemble</p>
          <h1 className="truncate text-[26px] leading-tight font-semibold tracking-[-0.02em] text-zinc-900">{store.name}</h1>
        </div>
      </div>
      {/* In test mode the layout's banner already says test orders are included. */}
      <AnalyticsControls base={base} state={state} options={{ sources: [], countries: [] }} testMode={store.testMode} showFilters={false} showTest={!store.testMode} zone={zoneLabel(store.timezone)} />
      <Flash ok={sp.ok} error={sp.error ?? range.error} />

      {/* Hero: revenue + chart */}
      <section aria-labelledby="revenue-title" className="mb-6 overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 p-5 sm:p-6 lg:grid-cols-[260px_1fr] [&>*]:min-w-0">
          <div className="flex flex-col gap-4">
            <div>
              <h2 id="revenue-title" className="flex items-center gap-1.5 text-sm font-medium text-zinc-500">
                <TrendingUp className="h-4 w-4 text-indigo-500" aria-hidden /> Chiffre d&apos;affaires HT
                <InfoTip label="À propos du chiffre d'affaires">
                  Net des remboursements et litiges perdus, offres post-achat comprises, {range.label} ({zoneLabel(store.timezone)}). TVA retirée au taux du pays de livraison (taux réduits des variantes classées dans Coûts produits). Période
                  précédente : {money(a.previous.revenueHtCents)} HT.
                </InfoTip>
              </h2>
              <p className="mt-2 text-[34px] leading-none font-semibold tracking-[-0.03em] text-zinc-900 tabular-nums sm:text-[40px]">{money(a.revenueHtCents)}</p>
              <p className="mt-1.5 text-sm text-zinc-500 tabular-nums">{money(a.revenueCents)} TTC</p>
              <div className="mt-3 min-h-5">
                <Delta d={a.previous.revenueHtCents || a.revenueHtCents ? { now: a.revenueHtCents, before: a.previous.revenueHtCents } : noPrev} label={vsLabel} />
              </div>
            </div>
            <p className="text-xs leading-relaxed text-zinc-500">
              <Link href={`${base}/analytics${range.key === "30d" ? "" : `?${new URLSearchParams(range.key === "custom" ? { range: "custom", from: range.from, to: range.to } : { range: range.key })}`}`} className="font-medium text-indigo-700 hover:underline">
                Détail dans Analytics →
              </Link>
            </p>
          </div>
          <div className="min-w-0">
            <RevenueChart points={points} currency={store.shopCurrency} />
          </div>
        </div>
      </section>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <Kpi
          icon={Receipt}
          label="Commandes"
          value={formatNumber(a.orders)}
          hint="payées sur la période"
          change={<Delta d={a.orders || a.previous.orders ? { now: a.orders, before: a.previous.orders } : noPrev} label={vsLabel} />}
          spark={spark.orders}
        />
        <Kpi
          icon={Wallet}
          label="Panier moyen"
          value={a.orders ? money(a.aovCents) : "—"}
          hint={a.orders ? `TTC net · ${money(a.aovHtCents)} HT` : "aucune commande sur la période"}
          change={<Delta d={a.orders && a.previous.orders ? { now: a.aovCents, before: a.previous.aovCents } : a.orders ? noPrev : { unavailable: "aucune commande sur la période" }} label={vsLabel} />}
          spark={spark.avg}
        />
        <Kpi
          icon={Percent}
          label="Conversion"
          value={a.visitors ? formatPercent(a.cvr) : "—"}
          hint={a.visitors ? `${formatNumber(a.paidVisitors)} acheteurs / ${formatNumber(a.visitors)} visiteurs · ${formatNumber(a.abandoned)} abandons` : "aucun checkout sur la période"}
          change={<Delta d={a.visitors && a.previous.visitors ? { now: a.cvr, before: a.previous.cvr } : { unavailable: a.visitors ? "pas de visiteur sur la période précédente" : "aucun checkout sur la période" }} label={vsLabel} />}
          spark={spark.conv}
        />
        <Kpi
          icon={ShoppingCart}
          label={hasSpend ? "Bénéfice net après pub" : "Marge nette"}
          value={a.orders ? money(profit) : "—"}
          estimated={a.orders > 0 && !a.profit.complete}
          hint={hasSpend ? `pub : ${money(a.ads.spendCents)}` : a.orders ? `${formatPercent(a.profit.marginRate)} du CA HT` : "aucune commande sur la période"}
          change={
            <Delta
              d={a.orders && prevProfit != null ? { now: profit, before: prevProfit, estimated: !a.profit.complete || a.previous.profitEstimated } : a.orders ? noPrev : { unavailable: "aucune commande sur la période" }}
              label={vsLabel}
              hideEstimatedBadge={a.orders > 0 && !a.profit.complete}
            />
          }
          spark={spark.profit}
        />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[1.35fr_1fr] [&>*]:min-w-0">
        {doneCount === steps.length ? (
          <section aria-labelledby="health-title" className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <h2 id="health-title" className="text-[15px] font-semibold tracking-tight">
                  Santé du checkout
                </h2>
                <p className="text-sm text-zinc-500">Vérifiée à chaque visite</p>
              </div>
              <Link href={`${base}/journal`} className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50">
                Journal <ArrowRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            <HealthGrid items={health} />
          </section>
        ) : (
          <section aria-labelledby="setup-title" className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 id="setup-title" className="text-[15px] font-semibold tracking-tight">
                  Mise en route
                </h2>
                <p className="text-sm text-zinc-500">
                  {doneCount} sur {steps.length} étapes terminées
                </p>
              </div>
              <ProgressRing value={doneCount / steps.length} />
            </div>
            <ol className="space-y-1.5">
              {steps.map((s) => {
                const Row = (
                  <div className={`flex items-center gap-3 rounded-xl p-2.5 transition ${s.done ? "" : "hover:bg-zinc-50"}`}>
                    {s.done ? (
                      <span className="flex h-9 w-9 items-center justify-center rounded-[28%] bg-emerald-500 text-white shadow-[inset_0_1px_0_rgba(255,255,255,.3),0_4px_10px_-4px_rgba(16,185,129,.8)]">
                        <Check className="h-4 w-4" strokeWidth={3} aria-hidden />
                      </span>
                    ) : s.brand ? (
                      <BrandTile brand={s.brand} size={36} />
                    ) : (
                      <IconTile icon={s.icon} size={36} color="#6366f1" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className={`block text-sm font-medium ${s.done ? "text-zinc-500 line-through" : ""}`}>
                        {s.title}
                        {s.done && <span className="sr-only"> (terminé)</span>}
                      </span>
                      <span className="block text-xs text-zinc-500">{s.text}</span>
                    </span>
                    {!s.done && s.href && <ArrowRight className="h-4 w-4 text-zinc-500" aria-hidden />}
                  </div>
                );
                return <li key={s.title}>{s.href && !s.done ? <Link href={s.href} className="block rounded-xl">{Row}</Link> : Row}</li>;
              })}
            </ol>
          </section>
        )}

        <section aria-labelledby="status-title" className="relative overflow-hidden rounded-2xl p-5 text-white shadow-[var(--shadow-float)]">
          <div className={`absolute inset-0 ${live ? "bg-mesh" : "bg-gradient-to-br from-zinc-800 to-zinc-950"}`} />
          <div className="bg-grid absolute inset-0 opacity-40" />
          <div className="relative">
            <div className="mb-5 flex items-center justify-between gap-3">
              <h2 id="status-title" className="text-[15px] font-semibold">
                Statut du checkout
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${live ? "bg-emerald-400/20 text-emerald-100" : "bg-white/10 text-zinc-200"}`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-emerald-400" : "bg-zinc-400"}`} aria-hidden />
                {live ? "En ligne" : "Hors ligne"}
              </span>
            </div>
            <p className="text-2xl font-semibold tracking-tight">{live ? "Checkout Whop actif" : "Checkout Shopify natif"}</p>
            <p className="mt-1.5 text-sm text-white/75">
              {live ? "Les clics sur « Paiement » arrivent sur votre checkout Whop." : "Vos clients passent par le checkout Shopify habituel."}
            </p>
            {store.enabled || ready ? (
              <form action={setEnabledAction.bind(null, store.id, !store.enabled)} className="mt-6">
                {store.enabled ? (
                  <ConfirmButton
                    variant="danger-dark"
                    className="w-full"
                    title="Désactiver le checkout Whop ?"
                    description="Vos clients repasseront immédiatement par le checkout Shopify. Vous pourrez le remettre en ligne à tout moment."
                    confirmLabel="Désactiver"
                  >
                    <Power className="h-4 w-4" aria-hidden />
                    Désactiver le checkout
                  </ConfirmButton>
                ) : (
                  <SubmitButton className="w-full !bg-white !text-zinc-900 hover:!bg-zinc-100">
                    <Power className="h-4 w-4" aria-hidden />
                    Mettre en ligne
                  </SubmitButton>
                )}
              </form>
            ) : (
              <div className="mt-6">
                {/* Not connectable yet: the next actionable step replaces the unavailable "Mettre en ligne". */}
                <Link
                  href={`${base}/${!store.shopifyConnectedAt ? "shopify" : paymentHref}`}
                  className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
                >
                  {!store.shopifyConnectedAt ? "Connecter Shopify" : paymentHref === "stripe" ? "Terminer la connexion Stripe" : "Connecter Whop"}
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </Link>
                <p className="mt-2 text-xs text-white/85">
                  La mise en ligne sera possible une fois{" "}
                  {!store.shopifyConnectedAt && !paymentReady ? "Shopify et un moyen de paiement (Whop ou Stripe) connectés" : !store.shopifyConnectedAt ? "Shopify connecté" : "un moyen de paiement (Whop ou Stripe) prêt à encaisser"}.
                </p>
              </div>
            )}
            <div className="mt-6 space-y-2 border-t border-white/10 pt-4">
              <Connection label="Shopify" detail={store.shopDomain ?? "Non connecté"} ok={!!store.shopifyConnectedAt} href={`${base}/shopify`} />
              <Connection
                label="Whop"
                detail={store.whopConnectedAt ? (store.testMode ? "Sandbox" : "Production") : "Non connecté"}
                ok={!!store.whopConnectedAt}
                href={`${base}/whop`}
              />
              {store.stripeConnectedAt && (
                <Connection
                  label="Stripe"
                  detail={providerConnected(store, "stripe") ? (store.testMode ? "Test" : "Production") : (stripeUnusableReason(store) ?? "Inutilisable")}
                  ok={providerConnected(store, "stripe")}
                  href={`${base}/stripe`}
                />
              )}
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

/** One neutral color for every KPI card (icon + sparkline): the numbers carry the meaning. */
const KPI_COLOR = "#6366f1";

function Kpi({
  icon,
  label,
  value,
  hint,
  change,
  spark,
  estimated,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
  change: React.ReactNode;
  spark: number[];
  estimated?: boolean;
}) {
  return (
    <section aria-label={label} className="flex min-w-0 flex-col rounded-2xl bg-white p-3.5 shadow-[var(--shadow-card)] sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <IconTile icon={icon} size={34} color={KPI_COLOR} />
        <Sparkline values={spark} color={KPI_COLOR} />
      </div>
      <h2 className="mt-3 text-xs font-medium text-zinc-500">{label}</h2>
      <p className="mt-0.5 text-xl font-semibold tracking-tight text-zinc-900 tabular-nums">
        {value}
        {estimated && <EstimatedBadge />}
      </p>
      <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>
      {change && <div className="mt-auto pt-2.5">{change}</div>}
    </section>
  );
}

function ProgressRing({ value }: { value: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <svg
      width="48"
      height="48"
      viewBox="0 0 48 48"
      role="img"
      aria-label={`${formatPercent(value)} terminé`}
    >
      <circle
        cx="24"
        cy="24"
        r={r}
        fill="none"
        stroke="#e4e4e7"
        strokeWidth="5"
      />
      <circle
        cx="24"
        cy="24"
        r={r}
        fill="none"
        stroke="url(#ring)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - value)}
        transform="rotate(-90 24 24)"
      />
      <defs>
        <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#10b981" />
        </linearGradient>
      </defs>
      <text
        x="24"
        y="28"
        textAnchor="middle"
        className="fill-zinc-900 text-[11px] font-semibold"
      >
        {formatPercent(value).replace(/\s/g, "")}
      </text>
    </svg>
  );
}

function Connection({
  label,
  detail,
  ok,
  href,
}: {
  label: string;
  detail: string;
  ok: boolean;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="flex min-h-11 items-center justify-between gap-3 rounded-lg px-2 py-1.5 transition hover:bg-white/5"
    >
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block max-w-[200px] truncate text-xs text-white/70">
          {detail}
        </span>
      </span>
      <Badge color={ok ? "green" : "amber"}>
        {ok ? "Connecté" : "À connecter"}
      </Badge>
    </Link>
  );
}
