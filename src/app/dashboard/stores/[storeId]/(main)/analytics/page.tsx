import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import {
  BarChart3,
  CreditCard,
  Download,
  Filter,
  Flame,
  Globe2,
  Languages,
  Megaphone,
  MessageCircleQuestion,
  MousePointerClick,
  Package,
  PiggyBank,
  Repeat,
  ShieldAlert,
  Smartphone,
  Sparkles,
  Target,
  Ticket,
} from "lucide-react";
import { requireStoreAccess } from "@/lib/access";
import { tzOf, zoneLabel as zoneLabelOf } from "@/lib/time";
import { db } from "@/lib/db";
import {
  ATTRIBUTION_WINDOWS,
  detectAnomalies,
  type CreativeRow,
  experimentHistory,
  experimentResults,
  checkoutTestResults,
  GEO_COVERAGE_MIN,
  filterOptions,
  ltvCacLevel,
  breakEvenRoasLtv,
  storeAnalytics,
  storeCohorts,
  type AdVerdict,
  type Analytics,
  type CostPart,
  type FunnelGroup,
} from "@/lib/analytics";
import { AD_PLATFORMS } from "@/lib/adspend";
import { STANDARD_VAT_RATES } from "@/lib/vat";
import { Badge, Card, EmptyState, Flash, PageHeader, buttonClass } from "@/components/ui";
import { dayFlag, dayFlagKind } from "@/components/dashboard/dayFlags";
import { RevenueChart } from "@/components/dashboard/RevenueChart";
import { ProfitChart } from "@/components/dashboard/ProfitChart";
import { AnalyticsControls, countryName, hrefWith, langName, parseControls, stateParams, type ControlParams } from "@/components/dashboard/AnalyticsControls";
import {
  Callout,
  CsvLink,
  VerdictChip,
  formatMinutes,
  DataTable,
  DrillLink,
  EstimatedBadge,
  InfoTip,
  KpiTile,
  LevelPill,
  METHOD_LABELS,
  Mini,
  PnlRow,
  ShareBar,
  int,
  multiple,
  pct,
  type DeltaInput,
} from "@/components/dashboard/AnalyticsKit";
import { Heatmap } from "@/components/dashboard/Heatmap";
import { AnalyticsTabs } from "@/components/dashboard/AnalyticsTabs";
import { ExperimentPanel } from "@/components/dashboard/ExperimentPanel";
import { OfferTestsTable } from "@/components/dashboard/OfferTests";
import { CheckoutTestsPanel } from "@/components/dashboard/CheckoutTests";
import { sourceLabel } from "@/components/dashboard/sources";
import { endOfferTestAction } from "./actions";
import { formatCents, formatCentsRound, formatDateTime, formatDeduction } from "@/components/dashboard/format";

const COST_LABEL: Record<CostPart, string> = {
  fees: "frais Whop pas encore communiqués pour certains paiements",
  products: "coût d'achat manquant sur certains produits",
  bumps: "coût manquant sur certaines options (order bumps)",
  shipping: "coût transporteur non renseigné sur certains tarifs de livraison",
};

const TABS = [
  ["ventes", "Ventes"],
  ["acquisition", "Acquisition"],
  ["produits", "Produits"],
  ["clients", "Clients"],
  ["tests", "Tests A/B"],
] as const;
type TabId = (typeof TABS)[number][0];

export const metadata = { title: "Analytics" };

const CONVERSION_INFO =
  "Commence à « Checkout ouvert » : visiteurs uniques ayant payé ÷ visiteurs uniques ayant ouvert le checkout sur la période. Les visites de la boutique qui n'ouvrent pas le checkout ne sont pas comptées : ce n'est pas le taux de conversion de la boutique. Par checkout : checkouts payés ÷ checkouts ouverts (un visiteur peut en ouvrir plusieurs).";

/** "45 min", "3,5 h". */
const hours = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(h)} h`);
const dayLabel = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });


const GROUP_LABEL: Record<string, string> = { mobile: "Mobile", desktop: "Ordinateur", inconnu: "Appareil inconnu" };

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<ControlParams & { ok?: string; error?: string; refunds?: string; heat?: string; tab?: string; touch?: string; win?: string; flash?: string }>;
}) {
  const { storeId } = await params;
  await requireStoreAccess(storeId, "view");
  const sp = await searchParams;
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) notFound();
  const state = parseControls(sp, store);
  const { range, filters, includeTest } = state;
  const base = `/dashboard/stores/${storeId}/analytics`;
  const refundsByDate = sp.refunds === "date";
  // Days and hours of the store's time zone (Paramètres › Général).
  const zone = tzOf(store);
  const zoneLabel = zoneLabelOf(zone);
  const heatMetric = sp.heat === "ca" ? "revenue" : "conversion";
  const tab: TabId = TABS.find(([id]) => id === sp.tab)?.[0] ?? "ventes";
  // Every link and form of the controls keeps the tab; the tabs keep the filters.
  const touch = tab === "acquisition" && sp.touch === "first" ? "first" : "last";
  // Attribution window applied at query time (1/7/28 days); none = the store's setting.
  const win = (ATTRIBUTION_WINDOWS as readonly number[]).includes(Number(sp.win)) && Number(sp.win) !== store.attributionDays ? Number(sp.win) : undefined;
  const keep = { tab: tab === "ventes" ? undefined : tab, touch: touch === "first" ? touch : undefined, win: win ? String(win) : undefined };
  const tabs = TABS.map(([id, label]) => ({ id, label, href: hrefWith(base, state, { tab: id === "ventes" ? undefined : id }) }));
  const needCohorts = tab === "acquisition" || tab === "clients";
  const needTests = tab === "tests";

  const [a, options, cohorts, experiment, versions, history] = await Promise.all([
    storeAnalytics(storeId, { since: range.since, until: range.until, prevSince: range.prevSince, includeTest, filters }, { touch, attributionDays: win }),
    filterOptions(storeId, includeTest),
    needCohorts ? storeCohorts(storeId, includeTest) : null,
    needTests ? db.experiment.findFirst({ where: { storeId, status: "RUNNING" }, orderBy: { startedAt: "desc" } }) : null,
    needTests ? db.layoutVersion.findMany({ where: { storeId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, label: true } }) : [],
    needTests ? experimentHistory(storeId) : [],
  ]);
  const results = experiment ? await experimentResults(experiment) : null;
  const [checkoutTests, testAddOns] = needTests
    ? await Promise.all([
        db.checkoutTest
          .findMany({ where: { storeId }, orderBy: [{ status: "desc" }, { startedAt: "desc" }], take: 10 })
          .then((rows) => Promise.all(rows.map(async (test) => ({ test, results: await checkoutTestResults(test) })))),
        db.addOn.findMany({ where: { storeId, active: true }, orderBy: { position: "asc" }, select: { id: true, title: true, priceCents: true } }),
      ])
    : [[], []];
  const money = (c: number) => formatCentsRound(c, a.currency);
  const exact = (c: number) => formatCents(c, a.currency);
  const less = (c: number) => formatDeduction(c, exact);

  // Drill-down to the Orders list with the same period and filters.
  const orders = (extra: Record<string, string | undefined>) => {
    const q = new URLSearchParams({ filter: "paid", from: range.from, to: range.to, ...(includeTest ? {} : { test: "0" }) });
    for (const [k, v] of Object.entries({ source: filters.source, country: filters.country, device: filters.device, lang: filters.lang, geo: filters.geo, ...extra })) if (v) q.set(k, v);
    if (win && q.get("source")) q.set("win", String(win));
    return `/dashboard/stores/${storeId}/orders?${q}`;
  };
  const exportQs = new URLSearchParams({ from: range.from, to: range.to, ...(includeTest ? { test: "1" } : {}) });
  for (const [k, v] of Object.entries(filters)) if (v) exportQs.set(k, v);
  // Table exports: exactly the page's period, filters and test switch.
  const csv = (type: string) => {
    const q = stateParams(state, { range: range.key, from: range.from, to: range.to, type, touch: touch === "first" ? "first" : undefined, win: win ? String(win) : undefined });
    return `${base}/export?${q}`;
  };

  const points = a.daily.map((d) => ({
    date: d.day,
    label: new Date(`${d.day}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }),
    cents: d.revenueHtCents,
    orders: d.orders,
    flag: dayFlag(d),
    flagKind: dayFlagKind(d),
    // Online-store orders placed outside this checkout (imported daily): second series of the chart.
    ...(a.leakage?.lastImportAt && d.externalRevenueHtCents != null ? { secondary: d.externalRevenueHtCents } : {}),
  }));
  // The chart's dotted series: what it plots (the days the import covers), never the whole period's sum.
  const chartExternalHt = a.daily.reduce((t, d) => t + (d.externalRevenueHtCents ?? 0), 0);
  // Outside online sales of the fallback / checkout-off days only (the ones those hours pushed elsewhere).
  const flaggedDays = a.daily.filter((d) => d.fallback || d.disabled);
  const fallbackExternal =
    a.leakage?.lastImportAt && flaggedDays.length
      ? { htCents: flaggedDays.reduce((t, d) => t + (d.externalRevenueHtCents ?? 0), 0), unknownDays: flaggedDays.filter((d) => d.externalRevenueHtCents == null).length }
      : null;
  const disabledHours = a.disabled.periods.reduce((t, f) => t + f.minutes, 0) / 60;
  const fallbackHours = a.fallback.periods.reduce((t, f) => t + f.minutes, 0) / 60;
  const hasSpend = a.ads.available && a.ads.spendCents > 0;
  const homeCountry = (store.homeCountry || "FR").toUpperCase();
  const homeRate = String(STANDARD_VAT_RATES[homeCountry] ?? 20).replace(".", ",");
  const vatInfo = (
    <>
      Les prix affichés au client sont TTC.{" "}
      {a.vatExempt
        ? "Boutique en franchise de TVA : TVA à 0 %, CA HT = CA TTC."
        : store.vatDomesticOnly
          ? `Ventes UE sous le seuil OSS de 10 000 € : la TVA de votre pays d'établissement (${homeCountry} ${homeRate} %) est retirée de toutes les commandes livrées dans l'Union européenne.`
          : "Le CA HT retire la TVA au taux normal du pays de livraison dans l'UE (FR 20 %, BE 21 %, DE 19 %…), la règle au-delà du seuil OSS de 10 000 € de ventes UE (réglable dans Paramètres)."}{" "}
      Hors UE (Suisse, Royaume-Uni, DOM, États-Unis…), c&apos;est une exportation : TVA 0 %. Pays inconnu : taux de votre pays d&apos;établissement ({homeCountry} {homeRate} %) par prudence.{" "}
      {a.vat.reduced
        ? `Taux réduits : appliqués aux variantes classées dans Coûts produits (alimentation, livres, presse…), au prorata de chaque ligne (${a.vat.reducedOrders} commande(s) de la période). Pays de livraison dont le taux réduit n'est pas connu : taux normal${a.vat.unknownRateOrders ? ` (${a.vat.unknownRateOrders} commande(s))` : ""}.`
        : "Taux réduits (alimentation 5,5 %, livres, presse 2,1 %…) : classez les variantes concernées dans Coûts produits, sinon le taux normal est appliqué."}{" "}
      Whop, marchand officiel (merchant of record), peut collecter et reverser la TVA à votre place selon
      votre compte : dans tous les cas, le CA HT est ce qui vous revient réellement.
    </>
  );
  const noPrev: DeltaInput = { unavailable: "pas de commande sur la période précédente" };
  const estimated = !a.profit.complete || a.previous.profitEstimated;
  const profitDelta: DeltaInput = a.previous.profitCents != null ? { now: a.profit.grossProfitCents, before: a.previous.profitCents, estimated } : noPrev;
  const netAds = a.ads.netAfterAdsCents;
  const netDelta: DeltaInput = a.previous.netAfterAdsCents != null ? { now: netAds, before: a.previous.netAfterAdsCents, estimated } : noPrev;
  const buyers = a.customers.newOrders + a.customers.returningOrders;
  const topFunnel = Math.max(1, a.funnel[0]?.count ?? 1);
  const knownMethods = a.methods.filter((m) => m.method !== "inconnu").reduce((s, m) => s + m.orders, 0);
  const anomalies = detectAnomalies(a);

  /* P&L: refunds on the order date (default) or on the refund date. */
  const mt = a.money;
  const grossHt = mt.paidNetHtCents + mt.refundedHtCents;
  const refundTtc = refundsByDate ? a.refundsByDate.cents : mt.refundedCents;
  const refundHt = refundsByDate ? a.refundsByDate.htCents : mt.refundedHtCents;
  const htBeforeDisputes = grossHt - refundHt;
  const ttcBeforeDisputes = mt.grossCents - refundTtc;
  // "Date du remboursement": refunds and protection claims both move to the date they cost (cash view).
  const claimsShown = refundsByDate ? a.claimsByDate.cents : a.profit.claimsCents;
  const profitShown = a.profit.grossProfitCents + (refundsByDate ? mt.refundedHtCents - a.refundsByDate.htCents + a.profit.claimsCents - a.claimsByDate.cents : 0);
  const netAdsShown = profitShown - a.ads.spendCents;
  const disputeLine = mt.disputeLostHtCents + mt.disputeFeesCents;
  const refundToggle = (byDate: boolean) => `${hrefWith(base, state, { refunds: byDate ? "date" : undefined, heat: sp.heat })}#rentabilite`;

  return (
    <>
      <PageHeader
        icon={BarChart3}
        iconColor="#8b5cf6"
        title="Analytics"
        description="Rentabilité réelle (HT, après coûts et publicité), d'où viennent vos ventes et où vos clients décrochent."
        actions={
          <>
            <a href={`/dashboard/stores/${storeId}/orders/export?${exportQs}`} className={`${buttonClass("secondary")} min-h-9 !px-3`} download>
              <Download className="h-4 w-4" aria-hidden />
              <span>
                <span className="hidden sm:inline">Commandes </span>CSV
              </span>
            </a>
            <a href={`/dashboard/stores/${storeId}/orders/export?${exportQs}&type=lines`} className={`${buttonClass("secondary")} hidden min-h-9 !px-3 sm:inline-flex`} download>
              <Download className="h-4 w-4" aria-hidden />
              Lignes CSV
            </a>
          </>
        }
      />
      {/* Outcome of a checkout-test form: shown (and focused) inside that panel instead. */}
      {sp.flash === "ct" && tab === "tests" ? <Flash error={range.error} /> : <Flash ok={sp.ok} error={sp.error ?? range.error} />}
      <AnalyticsControls base={base} state={state} options={options} testMode={store.testMode} keep={keep} zone={zoneLabel} />
      <p className="-mt-2 mb-4 text-xs text-zinc-500">
        {range.label.charAt(0).toUpperCase() + range.label.slice(1)} ({zoneLabel}) · comparé à la période précédente de même durée
        {filters.country || filters.device || filters.lang || filters.geo ? " · les dépenses publicitaires ne se ventilent pas par pays, appareil ou langue" : ""}
      </p>

      <div className="sticky top-[61px] z-10 -mx-4 mb-5 border-b border-zinc-200/70 bg-[#f7f8fa] px-4 md:top-0 md:-mx-10 md:px-10">
        <AnalyticsTabs tabs={tabs} active={tab} explicit={!!sp.tab} />
      </div>

      {(anomalies.length > 0 || a.ads.unconverted.rows > 0 || a.fallback.periods.length > 0 || a.disabled.periods.length > 0) && (
        <div className="mb-5 space-y-2" aria-label="Alertes">
          {a.disabled.periods.length > 0 && (
            <Callout tone="warn" title={`Checkout Whop désactivé${a.disabled.periods.length > 1 ? ` ${a.disabled.periods.length} fois` : ""} sur la période (${hours(disabledHours)})`}>
              {a.disabled.periods
                .map((f) => `${formatDateTime(new Date(f.startedAt), false, zone)} → ${f.endedAt ? formatDateTime(new Date(f.endedAt), false, zone) : "toujours désactivé"}${f.reason ? ` (${f.reason})` : ""}`)
                .join(" ; ")}
              . Pendant ces heures, la boutique utilisait le checkout Shopify : ventes absentes de ces chiffres (jours surlignés sur les graphiques)
              {a.leakage ? ", mais comptées dans les ventes hors checkout Whop" : ""}.
            </Callout>
          )}
          {a.fallback.periods.length > 0 && (
            <Callout tone="warn" title={`Checkout Shopify de secours actif${a.fallback.periods.length > 1 ? ` ${a.fallback.periods.length} fois` : ""} sur la période (${hours(fallbackHours)})`}>
              {a.fallback.periods
                .map((f) => `${formatDateTime(new Date(f.startedAt), false, zone)} → ${f.endedAt ? formatDateTime(new Date(f.endedAt), false, zone) : "toujours actif"}`)
                .join(" ; ")}
              . Pendant ces heures, les ventes sont passées par le checkout Shopify : absentes de ces chiffres (jours surlignés sur les graphiques)
              {a.leakage ? ", mais comptées dans les ventes hors checkout Whop" : ""}.
            </Callout>
          )}
          {anomalies.map((x) => (
            <Callout key={x.key} tone={x.severity} title={x.title}>
              {x.detail}
            </Callout>
          ))}
          {a.ads.unconverted.rows > 0 && (
            <Callout tone="bad" title={`Dépenses publicitaires non converties (${a.ads.unconverted.currencies.join(", ")})`}>
              {int(a.ads.unconverted.rows)} ligne(s) de la période ne sont pas dans la devise de la boutique ({a.currency}) : ROAS et bénéfice après pub sont faussés tant que le taux
              de change n&apos;est pas disponible.{" "}
              <Link href={`/dashboard/stores/${storeId}/growth#adspend`} className="underline">
                Voir les dépenses
              </Link>
            </Callout>
          )}
        </div>
      )}

      {tab === "ventes" && (
      <section id="panel-ventes" role="tabpanel" aria-labelledby="tab-ventes">
        {/* KPIs */}
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 2xl:grid-cols-6">
          <KpiTile
            label="CA HT"
            value={exact(a.revenueHtCents)}
            secondary={`${exact(a.revenueCents)} TTC`}
            delta={{ now: a.revenueHtCents, before: a.previous.revenueHtCents }}
            spark={a.daily.map((d) => d.revenueHtCents)}
            hint={a.upsellRevenueCents ? `dont ${money(Math.round(a.upsellRevenueCents * (a.revenueHtCents / Math.max(1, a.revenueCents))))} HT d'offres post-achat` : "net des remboursements et litiges perdus"}
            info={vatInfo}
          />
          <KpiTile
            label="Marge nette"
            value={a.orders ? exact(a.profit.grossProfitCents) : "—"}
            secondary={a.orders ? `${pct(a.profit.marginRate)} du CA HT` : undefined}
            delta={a.orders ? profitDelta : undefined}
            estimated={a.orders > 0 && !a.profit.complete}
            spark={a.daily.map((d) => d.netCents)}
            hint={a.profit.complete ? "avant pub : après frais Whop, coûts et litiges" : "estimation : certains coûts manquent"}
            info="Marge nette (avant pub) = CA HT − frais Whop − coûts produit − options − livraison − préparation − litiges − sinistres protection colis. À ne pas confondre avec la « marge produit » des tableaux Produits et Offres (CA HT − coût d'achat seulement)."
            tone={a.profit.grossProfitCents < 0 ? "bad" : undefined}
          />
          <KpiTile
            label="Bénéfice net après pub"
            value={a.ads.available ? exact(netAds) : "—"}
            secondary={a.ads.available ? (hasSpend ? `pub : ${exact(a.ads.spendCents)}` : "aucune dépense saisie") : "non ventilable par pays/appareil/langue"}
            delta={a.ads.available && a.orders ? netDelta : undefined}
            estimated={a.ads.available && a.orders > 0 && !a.profit.complete}
            hint={hasSpend ? `POAS ${multiple(a.ads.poas)} · ROAS HT ${multiple(a.ads.roas)}` : <Link href={`/dashboard/stores/${storeId}/growth#adspend`} className="text-indigo-700 hover:underline">Connecter Meta / TikTok / Google Ads</Link>}
            tone={a.ads.available && netAds < 0 ? "bad" : undefined}
            info="Marge nette moins les dépenses publicitaires de la période (importées de Meta, TikTok et Google Ads ou saisies à la main). POAS = marge nette ÷ dépenses : au-dessus de 1, la pub est rentable."
          />
          <KpiTile
            label="Commandes"
            value={int(a.orders)}
            secondary={hasSpend && a.ads.cpaCents != null ? `CPA ${exact(a.ads.cpaCents)}` : `${int(a.paidVisitors)} acheteurs`}
            delta={{ now: a.orders, before: a.previous.orders }}
            spark={a.daily.map((d) => d.orders)}
          />
          <KpiTile
            label="Conversion checkout"
            value={a.visitors ? pct(a.cvr, 1) : "—"}
            secondary={a.sessions ? `${pct(a.checkoutCvr, 1)} par checkout` : undefined}
            delta={a.visitors ? { now: a.cvr, before: a.previous.visitors ? a.previous.cvr : 0 } : undefined}
            spark={a.daily.map((d) => (d.sessions ? d.orders / d.sessions : 0))}
            hint={`${int(a.paidVisitors)} acheteurs sur ${int(a.visitors)} visiteurs du checkout`}
            info={CONVERSION_INFO}
          />
          <KpiTile
            label="Panier moyen"
            value={a.orders ? exact(a.aovCents) : "—"}
            secondary={a.orders ? `${exact(a.aovHtCents)} HT` : undefined}
            delta={a.orders && a.previous.orders ? { now: a.aovCents, before: a.previous.aovCents } : undefined}
            spark={a.daily.map((d) => (d.orders ? d.revenueCents / d.orders : 0))}
            hint="TTC, net des remboursements, offres comprises"
          />
        </div>

        {a.leakage && <LeakageCard leakage={a.leakage} ads={a.ads} exact={exact} zone={zone} />}

        <Card
          icon={BarChart3}
          iconColor="#6366f1"
          title="CA HT par jour"
          className="mb-6"
          description={`Total : ${money(a.revenueHtCents)} HT · ${money(a.revenueCents)} TTC.${a.leakage?.lastImportAt ? ` Pointillés : ventes en ligne hors checkout Whop (${money(chartExternalHt)} HT${a.leakage.partial && a.leakage.windowFrom ? ` depuis le ${dayLabel(a.leakage.windowFrom)}, premier jour couvert par l'import` : ""}).` : ""}${a.fallback.days.length || a.disabled.days.length ? " Jours surlignés : checkout Shopify utilisé (secours ou checkout Whop désactivé)." : ""}`}
          actions={<CsvLink href={csv("daily")} label="compte de résultat par jour" />}
        >
          {a.orders || (a.leakage?.orders ?? 0) > 0 ? (
            <RevenueChart points={points} currency={a.currency} secondaryLabel={a.leakage?.lastImportAt ? "Hors checkout Whop (en ligne)" : undefined} />
          ) : (
            <EmptyState icon={BarChart3} title="Pas encore de ventes sur la période" />
          )}
        </Card>

        <div className="mb-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Card
            id="rentabilite"
            icon={PiggyBank}
            iconColor="#059669"
            title="Rentabilité"
            description="De l'encaissé au résultat net, sur la période."
            actions={<CsvLink href={csv("daily")} label="compte de résultat par jour" />}
          >
            <div className="mb-3 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-zinc-500">Remboursements :</span>
              <span className="inline-flex rounded-lg bg-zinc-100 p-0.5">
                <Link href={refundToggle(false)} aria-current={!refundsByDate ? "true" : undefined} className={`rounded-md px-2 py-1 ${!refundsByDate ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-600"}`}>
                  date de commande
                </Link>
                <Link href={refundToggle(true)} aria-current={refundsByDate ? "true" : undefined} className={`rounded-md px-2 py-1 ${refundsByDate ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-600"}`}>
                  date du remboursement
                </Link>
              </span>
              <InfoTip label="À propos de la date des remboursements">
                Par défaut, un remboursement réduit le CA de la commande d&apos;origine (comme les KPI et les autres tableaux). « Date du remboursement » affiche les remboursements
                effectués pendant la période, quelle que soit la date de la commande : c&apos;est ce qui sort réellement de votre trésorerie. Les sinistres de protection colis
                suivent le même choix (date de la commande, ou date du sinistre accepté).
                {a.refundsByDate.fallbackOrders > 0 && ` ${int(a.refundsByDate.fallbackOrders)} commande(s) plus ancienne(s) sans date de remboursement enregistrée sont comptées à la date de commande.`}
              </InfoTip>
            </div>
            <dl className="space-y-2 text-sm">
              <PnlRow label="Encaissé TTC (commandes + offres)" value={exact(mt.grossCents)} />
              <PnlRow
                label={refundsByDate ? "Remboursements de la période (date du remboursement)" : "Remboursements"}
                value={less(refundTtc)}
                note={refundsByDate ? `${int(a.refundsByDate.count)} remboursement(s)` : undefined}
              />
              <PnlRow
                label="TVA estimée"
                value={less(ttcBeforeDisputes - htBeforeDisputes)}
                note={a.vat.reduced ? `taux réduits sur ${int(a.vat.reducedOrders)} commande(s)${a.vat.unknownRateOrders ? `, ${int(a.vat.unknownRateOrders)} au taux normal faute de taux connu` : ""}` : undefined}
                info={<InfoTip label="À propos de la TVA">{vatInfo}</InfoTip>}
              />
              <PnlRow label={mt.disputes ? "CA HT (avant litiges)" : "CA HT"} value={exact(htBeforeDisputes)} strong />
              <PnlRow label="Frais Whop" value={less(a.feesCents)} note={mt.coverage.fees < 1 ? `${pct(mt.coverage.fees, 0)} connus` : undefined} muted={mt.coverage.fees < 1} />
              <PnlRow
                label="Coût des produits"
                value={less(a.profit.cogsCents)}
                note={
                  mt.coverage.products < 1 ? (
                    <Link href={`/dashboard/stores/${storeId}/costs`} className="underline">
                      {pct(mt.coverage.products, 0)} des articles ont un coût : compléter
                    </Link>
                  ) : store.supplierPaidAtPayment ? (
                    "fournisseur payé à la commande"
                  ) : undefined
                }
                muted={mt.coverage.products < 1}
              />
              {(a.profit.bumpCostCents > 0 || mt.coverage.bumps < 1) && (
                <PnlRow label="Coût des options" value={less(a.profit.bumpCostCents)} note={mt.coverage.bumps < 1 ? `${pct(mt.coverage.bumps, 0)} connus` : undefined} muted={mt.coverage.bumps < 1} />
              )}
              <PnlRow label="Livraison (transporteur)" value={less(a.profit.shippingCostCents)} note={mt.coverage.shipping < 1 ? `${pct(mt.coverage.shipping, 0)} des commandes ont un coût` : undefined} muted={mt.coverage.shipping < 1} />
              <PnlRow label="Préparation (par commande)" value={less(a.profit.fulfilmentCents)} />
              {(a.profit.claimsCents > 0 || a.claimsByDate.cents > 0 || a.protection) && (
                <PnlRow
                  label={refundsByDate ? "Sinistres protection colis (date du sinistre)" : "Sinistres protection colis"}
                  value={less(claimsShown)}
                  note={
                    refundsByDate
                      ? `${int(a.claimsByDate.count)} sinistre(s) accepté(s) sur la période`
                      : a.protection
                        ? `${int(a.protection.claims)} sinistre(s) · résultat de la protection ${exact(a.protection.resultCents)}`
                        : undefined
                  }
                />
              )}
              <PnlRow
                label="Litiges (perdus + frais)"
                value={less(disputeLine)}
                note={mt.disputes ? `${int(mt.disputes)} litige(s) : ${exact(mt.disputeLostHtCents)} HT perdus + ${int(mt.disputes)} × ${exact(store.disputeFeeCents)} de frais` : "aucun"}
                info={
                  <InfoTip label="À propos des litiges">
                    Un litige perdu retire le montant contesté du CA (TTC et HT). Chaque litige, gagné ou perdu, coûte en plus les frais bancaires réglés dans Paramètres › Coûts (
                    {exact(store.disputeFeeCents)} par litige).
                  </InfoTip>
                }
              />
              <PnlRow label={<>Marge nette (avant pub){!a.profit.complete && <EstimatedBadge />}</>} value={`${exact(profitShown)} · ${pct(htBeforeDisputes - mt.disputeLostHtCents ? profitShown / (htBeforeDisputes - mt.disputeLostHtCents) : 0)}`} strong />
              {a.ads.available && (
                <>
                  <PnlRow label="Dépenses publicitaires" value={less(a.ads.spendCents)} note={a.ads.lastDay ? `importées jusqu'au ${new Date(`${a.ads.lastDay}T12:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC" })}` : "aucune"} />
                  <PnlRow label="Bénéfice net après pub" value={exact(netAdsShown)} strong />
                </>
              )}
              {a.fixedCosts.available && a.ads.available ? (
                <>
                  <PnlRow
                    label="Frais fixes (prorata)"
                    value={less(a.fixedCosts.periodCents)}
                    note={a.fixedCosts.monthlyCents ? `${exact(a.fixedCosts.monthlyCents)} / mois, ${int(range.days)} j` : "non renseignés"}
                    muted={!a.fixedCosts.monthlyCents}
                  />
                  <div className={`flex items-baseline justify-between gap-3 rounded-lg px-3 py-2 ${netAdsShown - a.fixedCosts.periodCents < 0 ? "bg-rose-50 text-rose-900" : "bg-emerald-50 text-emerald-900"}`}>
                    <dt className="font-semibold">Résultat net après frais fixes</dt>
                    <dd className="shrink-0 font-semibold tabular-nums">{exact(netAdsShown - a.fixedCosts.periodCents)}</dd>
                  </div>
                </>
              ) : (
                <div className="text-xs text-zinc-500">
                  <dt className="inline">Frais fixes et résultat net : </dt>
                  <dd className="inline">sans filtre de source, pays, appareil ou langue uniquement.</dd>
                </div>
              )}
            </dl>
            {(a.fallback.periods.length > 0 || a.disabled.periods.length > 0) && (
              <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                Checkout Shopify utilisé {hours(fallbackHours + disabledHours)} sur la période (
                {[a.fallback.periods.length > 0 && `secours automatique ${hours(fallbackHours)}`, a.disabled.periods.length > 0 && `checkout Whop désactivé ${hours(disabledHours)}`]
                  .filter(Boolean)
                  .join(", ")}
                ) : les ventes de ces heures ne sont pas dans ce compte de résultat
                {fallbackExternal ? ` (ventes en ligne hors checkout Whop ces jours-là : ${exact(fallbackExternal.htCents)} HT${fallbackExternal.unknownDays ? `, ${fallbackExternal.unknownDays} jour(s) non couvert(s) par l'import` : ""})` : ""}, alors que la publicité, elle, a continué.
              </p>
            )}
            {!a.profit.complete && (
              <div className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <p className="font-medium">Estimation partielle : les coûts inconnus comptent pour 0.</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-4">
                  {a.profit.missing.map((m) => (
                    <li key={m}>
                      {COST_LABEL[m]}
                      {m === "shipping" && (
                        <>
                          {" "}
                          (<Link className="underline" href={`/dashboard/stores/${storeId}/shipping`}>Livraison</Link>)
                        </>
                      )}
                      {m === "products" && (
                        <>
                          {" "}
                          (<Link className="underline" href={`/dashboard/stores/${storeId}/costs`}>Coûts produits</Link> ou Shopify › variante › Coût par article)
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {(store.fulfillmentFeeCents === 0 || !a.fixedCosts.monthlyCents) && (
              <p className="mt-2 text-xs text-zinc-500">
                {store.fulfillmentFeeCents === 0 ? "Préparation par commande : 0 €. " : ""}
                {!a.fixedCosts.monthlyCents ? "Frais fixes mensuels non renseignés. " : ""}
                <Link href={`/dashboard/stores/${storeId}/settings#couts`} className="text-indigo-700 underline">
                  Paramètres › Coûts
                </Link>
              </p>
            )}
            <div className="mt-5">
              <p className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Marge nette par jour</p>
              <ProfitChart
                title={
                  refundsByDate
                    ? "Marge nette par jour, remboursements et sinistres à leur date (CA HT − frais Whop − coûts − frais de litige − sinistres)"
                    : "Marge nette par jour (CA HT − frais Whop − coûts − frais de litige − sinistres)"
                }
                currency={a.currency}
                height={150}
                points={a.daily.map((d) => ({
                  date: d.day,
                  label: new Date(`${d.day}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }),
                  cents: refundsByDate ? d.netByRefundDateCents : d.netCents,
                  flag: dayFlag(d),
                  flagKind: dayFlagKind(d),
                  parts: [
                    // Refund-date view: the day's CA HT gets its orders' refunds back and loses the refunds made that day.
                    { label: "CA HT", cents: refundsByDate ? d.revenueHtCents + d.refundsHtCents - d.refundsByDateHtCents : d.revenueHtCents },
                    { label: "Frais Whop", cents: -d.feesCents },
                    { label: "Coûts", cents: -d.costsCents },
                    { label: "Frais de litige", cents: -d.disputeFeesCents },
                    { label: "Sinistres", cents: -(refundsByDate ? d.claimsByDateCents : d.claimsCents) },
                  ],
                }))}
              />
              <p className="mt-1 text-[11px] text-zinc-500">
                {summaryOf(
                  a.daily.map((d) => ({ day: d.day, value: refundsByDate ? d.netByRefundDateCents : d.netCents })),
                  money,
                )}{" "}
                {refundsByDate
                  ? "Chaque jour : CA HT des commandes du jour, avant leurs remboursements, moins les remboursements effectués ce jour-là − frais Whop − coûts − frais de litige − sinistres acceptés ce jour-là = marge nette ; la somme des jours est la marge nette de la période (remboursements et sinistres à leur date)."
                  : "Chaque jour : CA HT (net des litiges perdus) − frais Whop − coûts − frais de litige − sinistres protection colis = marge nette ; la somme des jours est la marge nette de la période (remboursements et sinistres à la date de commande)."}
              </p>
            </div>
          </Card>

          <Card
            icon={Filter}
            iconColor="#6366f1"
            title={
              <>
                Entonnoir du checkout{" "}
                <InfoTip label="À propos de l'entonnoir">
                  Checkouts ouverts sur la période. Un checkout payé compte comme ayant franchi toutes les étapes (paiement express inclus) ; une étape jamais mesurée sur la période est
                  masquée. Pourcentages = part des checkouts ouverts.
                </InfoTip>
              </>
            }
          >
            <ol className="space-y-3" aria-label="Étapes de l'entonnoir">
              {a.funnel.map((step, i) => {
                const prev = i > 0 ? a.funnel[i - 1].count : step.count;
                const drop = prev > 0 ? 1 - step.count / prev : 0;
                return (
                  <li key={step.key}>
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium">{step.label}</span>
                      <span className="tabular-nums">
                        {int(step.count)} <span className="text-xs text-zinc-500">· {pct(step.count / topFunnel)}</span>
                        {i > 0 && drop > 0.0005 && <span className="ml-2 text-xs text-rose-700">−{pct(drop)}</span>}
                      </span>
                    </div>
                    <ShareBar value={step.count} max={topFunnel} />
                  </li>
                );
              })}
            </ol>
            <div className="mt-5 grid grid-cols-2 gap-3 border-t border-zinc-100 pt-4 text-sm sm:grid-cols-3">
              <Mini icon={ShieldAlert} label="Paiements refusés" value={int(a.failedPayments)} />
              <Mini icon={Smartphone} label="Mobile" value={a.devices.mobileCvr == null ? "—" : pct(a.devices.mobileCvr, 1)} hint={`${int(a.devices.mobile)} visiteurs`} />
              <Mini icon={BarChart3} label="Ordinateur" value={a.devices.desktopCvr == null ? "—" : pct(a.devices.desktopCvr, 1)} hint={`${int(a.devices.desktop)} visiteurs`} />
            </div>
            {a.devices.unknownSessions > 0 && a.sessions > 0 && (
              <p className="mt-2 text-xs text-zinc-500">
                {pct(a.devices.unknownSessions / a.sessions, 0)} des checkouts sans appareil ({int(a.devices.unknownSessions)} sur {int(a.sessions)} : navigateur non transmis), hors
                conversion mobile / ordinateur.
              </p>
            )}
          </Card>
        </div>

        {(splitGroups(a.funnelBy.device) || splitGroups(a.funnelBy.source)) && (
          <Card
            icon={Filter}
            iconColor="#6366f1"
            className="mb-6"
            title={
              <>
                Entonnoir par appareil et par source{" "}
                <InfoTip label="À propos de l'entonnoir détaillé">
                  Part des checkouts ouverts de chaque groupe qui franchit chaque étape (nombre de checkouts en dessous). Dernière ligne : conversion checkout par visiteur unique. Sources : les 4
                  principales, le reste regroupé.
                </InfoTip>
              </>
            }
          >
            <div className="space-y-6">
              <FunnelSplit title="Par appareil" groups={a.funnelBy.device} label={(g) => GROUP_LABEL[g] ?? g} />
              <FunnelSplit title="Par source" groups={a.funnelBy.source} label={sourceLabel} />
            </div>
          </Card>
        )}

        <div className="mb-6 grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Card
            icon={Languages}
            iconColor="#0ea5e9"
            actions={<CsvLink href={csv("conversion")} label="conversion par langue et par pays" />}
            title={
              <>
                Conversion par langue du checkout{" "}
                <InfoTip label="À propos de la conversion par langue">
                  Langue dans laquelle le checkout a été affiché. « Langue inconnue » : checkouts ouverts avant l&apos;enregistrement de la langue. Filtrez toute la page sur une langue avec le
                  filtre « Langue » en haut.
                </InfoTip>
              </>
            }
          >
            <ConversionSplit
              caption="Checkouts ouverts, payés et conversion par langue du checkout"
              head="Langue"
              groups={a.funnelBy.lang}
              label={(g) => langName(g)}
              href={(g) => (g.startsWith("Autres") ? null : hrefWith(base, state, { ...keep, lang: g }))}
              empty={filters.lang ? `Filtre actif : ${langName(filters.lang)}.` : "Pas encore de checkouts sur la période."}
            />
          </Card>
          <Card
            icon={Globe2}
            iconColor="#6366f1"
            title={
              <>
                Conversion par pays du visiteur{" "}
                <InfoTip label="À propos de la conversion par pays du visiteur">
                  Pays du visiteur, déterminé uniquement par son adresse IP à l&apos;ouverture du checkout (en-têtes de géolocalisation de l&apos;hébergeur : Vercel, Cloudflare
                  ou CloudFront). Le pays de livraison n&apos;est jamais utilisé ici : seuls les acheteurs avancés le saisissent, ce qui gonflerait la conversion de leur pays. Sous{" "}
                  {pct(GEO_COVERAGE_MIN, 0)} de checkouts géolocalisés, les taux par pays sont masqués. Cliquer sur un pays filtre toute la page sur ce pays du visiteur (filtre
                  distinct du filtre « Pays de livraison »).
                </InfoTip>
              </>
            }
          >
            {a.geoCoverage.sessions > 0 && (
              <p className={`mb-3 text-xs ${a.geoCoverage.share < GEO_COVERAGE_MIN ? "rounded-lg bg-amber-50 px-3 py-2 text-amber-900" : "text-zinc-500"}`}>
                {pct(a.geoCoverage.share, 0)} des checkouts géolocalisés ({int(a.geoCoverage.located)} sur {int(a.geoCoverage.sessions)}).
                {a.geoCoverage.share < GEO_COVERAGE_MIN &&
                  " Couverture insuffisante : les taux de conversion par pays sont masqués (les checkouts sans pays pourraient tous les changer). Vérifiez que l'hébergeur transmet le pays de l'IP."}
              </p>
            )}
            <ConversionSplit
              caption="Checkouts ouverts, payés et conversion par pays du visiteur"
              head="Pays du visiteur"
              groups={a.funnelBy.country}
              hideRates={a.geoCoverage.share < GEO_COVERAGE_MIN}
              label={(g) => (g === "inconnu" ? "Inconnu (pas de pays IP)" : countryName(g))}
              href={(g) => (g.startsWith("Autres") ? null : hrefWith(base, state, { ...keep, geo: g }))}
              empty={filters.geo ? `Filtre actif : ${filters.geo === "inconnu" ? "pays inconnu" : countryName(filters.geo)}.` : "Pas encore de checkouts sur la période."}
            />
          </Card>
        </div>

        <Card
          icon={Flame}
          iconColor="#f97316"
          className="mb-6"
          title="Jour et heure"
          description={`${zoneLabel.charAt(0).toUpperCase()}${zoneLabel.slice(1)}. Conversion selon l'heure d'ouverture du checkout, CA HT selon l'heure de paiement.`}
          actions={
            <span className="inline-flex rounded-lg bg-zinc-100 p-0.5 text-xs">
              <Link
                href={hrefWith(base, state, { heat: undefined, refunds: sp.refunds })}
                scroll={false}
                aria-current={heatMetric === "conversion" ? "true" : undefined}
                className={`rounded-md px-2 py-1.5 ${heatMetric === "conversion" ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-600"}`}
              >
                Conversion checkout
              </Link>
              <Link
                href={hrefWith(base, state, { heat: "ca", refunds: sp.refunds })}
                scroll={false}
                aria-current={heatMetric === "revenue" ? "true" : undefined}
                className={`rounded-md px-2 py-1.5 ${heatMetric === "revenue" ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-600"}`}
              >
                CA HT
              </Link>
            </span>
          }
        >
          {a.sessions ? <Heatmap cells={a.heatmap} metric={heatMetric} money={money} zone={zoneLabel} /> : <p className="text-sm text-zinc-500">Pas encore de checkouts sur la période.</p>}
        </Card>
      </section>
      )}

      {tab === "acquisition" && (
      <section id="panel-acquisition" role="tabpanel" aria-labelledby="tab-acquisition">
        <AttributionBar
          days={a.attribution.days}
          storeDays={a.attribution.storeDays}
          touch={touch}
          storeId={storeId}
          hrefFor={(t) => hrefWith(base, state, { ...keep, touch: t === "first" ? "first" : undefined })}
          windowHref={(d) => hrefWith(base, state, { ...keep, win: d === a.attribution.storeDays ? undefined : String(d) })}
        />
        <SourcesCard a={a} storeId={storeId} money={money} orders={orders} csvHref={csv("sources")} cohorts={cohorts} />
        {a.ads.available && <PlatformRoasCard rows={a.platformVsReal} money={money} storeId={storeId} />}
        {a.ads.available && <CreativesCard rows={a.creatives} money={money} csvHref={csv("creatives")} storeId={storeId} />}
        <SurveyCard a={a} money={money} csvHref={csv("survey")} />
        <LtvCard cohorts={cohorts!} money={money} csvHref={csv("ltv")} storeId={storeId} periodLabel={range.label} blended={a.ads.available ? { cacCents: a.ads.blendedCacCents, newCustomers: a.ads.newCustomers, spendCents: a.ads.spendCents, source: filters.source } : null} />
      </section>
      )}

      {tab === "produits" && (
      <section id="panel-produits" role="tabpanel" aria-labelledby="tab-produits">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-2 [&>*]:min-w-0">
          <Card
            icon={Package}
            iconColor="#0ea5e9"
            title={
              <>
                Produits{" "}
                <InfoTip label="À propos des produits">
                  Lignes de commande et offres post-achat. CA HT net des remises, remboursements et litiges perdus (répartis au prorata) ; marge produit = CA HT − coût d&apos;achat (avant
                  frais Whop, livraison et pub : voir la marge nette dans Ventes). Au-delà de 20 produits, le reste est regroupé (export CSV complet).
                </InfoTip>
              </>
            }
            actions={<CsvLink href={csv("products")} label="ventes par produit" />}
          >
            <DataTable
              caption="Ventes par produit"
              columns={[
                { label: "Produit" },
                { label: "Unités" },
                { label: "CA HT" },
                { label: "Marge produit", info: "CA HT − coût d'achat, et part du CA HT. « — » : coût manquant (Coûts produits)." },
                { label: "Remb.", info: "Part des commandes contenant ce produit qui ont été (partiellement) remboursées." },
              ]}
              minWidth={440}
              empty="Aucune vente sur la période"
              rows={a.products.map((r) => ({
                key: r.productId,
                muted: r.other,
                cells: [
                  r.other ? (
                    <span key="p" className="font-medium">
                      {r.title}
                    </span>
                  ) : (
                    <DrillLink key="p" href={orders({ product: r.productId })}>
                      {r.title}
                    </DrillLink>
                  ),
                  int(r.units),
                  money(r.revenueHtCents),
                  r.marginCents == null ? (
                    <Link key="m" href={`/dashboard/stores/${storeId}/costs`} className="text-zinc-500 underline decoration-dotted" title="Coût manquant : le saisir">
                      —
                    </Link>
                  ) : (
                    `${money(r.marginCents)} · ${pct(r.revenueHtCents ? r.marginCents / r.revenueHtCents : 0, 0)}`
                  ),
                  <span key="rr" className={r.refundRate > 0.1 ? "text-rose-700" : ""}>
                    {pct(r.refundRate)}
                  </span>,
                ],
              }))}
            />
          </Card>

          <Card icon={Globe2} iconColor="#6366f1" title="Pays de livraison" description="TVA estimée au taux normal du pays de livraison." actions={<CsvLink href={csv("countries")} label="ventes par pays" />}>
            <DataTable
              caption="Ventes par pays"
              columns={[{ label: "Pays" }, { label: "Cmd" }, { label: "CA HT" }, { label: "TVA", hideBelow: "sm" }, { label: "Marge nette", info: "Avant pub : CA HT − frais, coûts et litiges des commandes du pays." }]}
              empty="Aucune vente sur la période"
              rows={a.countries.map((c) => ({
                key: c.country,
                muted: c.other,
                cells: [
                  c.other ? (
                    <span key="c" className="font-medium">
                      {c.country.replace("Autres", "Autres pays")}
                    </span>
                  ) : (
                    <DrillLink key="c" href={orders({ country: c.country })}>
                      {countryName(c.country)}
                    </DrillLink>
                  ),
                  int(c.orders),
                  money(c.revenueHtCents),
                  money(c.vatCents),
                  money(c.profitCents),
                ],
              }))}
            />
          </Card>

          <Card
            id="offres"
            icon={Sparkles}
            iconColor="#a855f7"
            className="lg:col-span-2"
            title={
              <>
                Offres post-achat et options{" "}
                <InfoTip label="À propos des offres">
                  Taux d&apos;acceptation = offres acceptées ÷ fois où l&apos;offre a été affichée (ou a reçu une réponse), sur les commandes payées de la période. CA HT net des remboursements
                  et litiges perdus ; marge produit = CA HT − coût d&apos;achat × quantité, comme pour les produits et les options. Un downsell n&apos;est proposé qu&apos;après le refus
                  d&apos;une autre offre.
                </InfoTip>
              </>
            }
            actions={<CsvLink href={csv("offers")} label="offres post-achat" />}
          >
            <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <Mini icon={Sparkles} label="Commandes ayant vu une offre" value={int(a.upsell.shown)} hint="affichée ou avec une réponse" />
              <Mini
                icon={Sparkles}
                label="Offres acceptées"
                value={`${int(a.upsell.accepted)} · ${pct(a.upsell.shown ? a.upsell.accepted / a.upsell.shown : 0)}`}
                hint="par commande ayant vu une offre"
              />
              <Mini icon={Sparkles} label="CA offres (TTC)" value={money(a.upsell.revenueCents)} />
            </div>
            <DataTable
              caption="Acceptation et rentabilité par offre"
              columns={[
                { label: "Offre" },
                { label: "Vues" },
                { label: "Acceptées" },
                { label: "Taux" },
                { label: "CA HT" },
                { label: "Marge produit", info: "CA HT − coût d'achat × quantité (hors frais Whop)." },
                { label: "CA HT / vue", info: "CA HT de l'offre ÷ nombre de fois où elle a été affichée : compare des offres de prix différents." },
              ]}
              minWidth={640}
              empty="Aucune offre affichée sur la période."
              rows={a.offers.map((o) => ({
                key: o.blockId,
                cells: [
                  <span key="t" className={`block min-w-0 ${o.arm ? "border-l-2 border-indigo-200 pl-2" : ""}`}>
                    <span className="block truncate font-medium" title={o.title}>
                      {o.offerTitle}
                    </span>
                    {(o.downsell || o.arm) && (
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {o.arm && (
                          <Badge color="zinc" dot={false}>
                            Variante {o.arm}
                          </Badge>
                        )}
                        {o.downsell && (
                          <Badge color="blue" dot={false}>
                            Downsell
                          </Badge>
                        )}
                      </span>
                    )}
                  </span>,
                  `${int(o.impressions)}${o.estimated ? "*" : ""}`,
                  int(o.paid),
                  o.takeRateRange ? `${pct(o.takeRateRange[0])} – ${pct(o.takeRateRange[1])}*` : pct(o.takeRate),
                  money(o.revenueHtCents),
                  o.marginCents == null ? <span key="m" className="text-zinc-500" title="Coût manquant">—</span> : money(o.marginCents),
                  exact(o.revenuePerImpressionHtCents),
                ],
              }))}
            />
            {a.upsell.legacyShown > 0 && (
              <p className="mt-2 text-[11px] text-zinc-500">
                * {int(a.upsell.legacyShown)} commande(s) plus ancienne(s) n&apos;enregistraient pas quelle offre était affichée : le taux est donné en fourchette (de « vue par toutes ces
                commandes » à « vue par aucune ») et les vues au maximum.
              </p>
            )}
            <OfferTestsTable
              tests={a.offerTests}
              money={exact}
              endAction={(offerId, arm) => endOfferTestAction.bind(null, storeId, offerId, arm)}
              back={hrefWith(base, state, keep)}
            />
            <p className="mt-5 mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Options (order bumps)</p>
            <DataTable
              caption="Options affichées et ajoutées au panier"
              columns={[
                { label: "Option" },
                { label: "Vues", info: "Commandes payées de la période auxquelles l'option a été proposée." },
                { label: "Prises" },
                { label: "Taux", info: "Commandes avec l'option ÷ commandes à qui elle a été proposée." },
                { label: "CA HT" },
                { label: "Marge produit", info: "CA HT − coût de l'option." },
              ]}
              minWidth={520}
              empty="Aucune option proposée sur la période."
              rows={a.addOns.map((x) => ({
                key: x.id,
                cells: [
                  x.title,
                  `${int(x.shown)}${x.estimated ? "*" : ""}`,
                  int(x.orders),
                  <span key="r">
                    {pct(x.attachRate)}
                    {x.estimated && (
                      <EstimatedBadge
                        title={
                          x.protection
                            ? "Affichage de la protection non suivi : taux calculé sur toutes les commandes à expédier"
                            : "Anciens checkouts sans trace des options affichées : comptés comme les ayant toutes vues"
                        }
                      />
                    )}
                  </span>,
                  money(x.revenueHtCents),
                  x.marginCents == null ? <span key="m" className="text-zinc-500" title="Coût manquant">—</span> : money(x.marginCents),
                ],
              }))}
            />
            {a.addOns.some((x) => x.estimated && !x.protection) && (
              <p className="mt-2 text-[11px] text-zinc-500">* Estimé : les commandes antérieures au suivi des options affichées comptent comme ayant vu chaque option (taux sous-estimé).</p>
            )}
            {a.addOns.some((x) => x.protection) && (
              <p className="mt-2 text-[11px] text-zinc-500">
                * Protection colis : son affichage n&apos;est pas enregistré, les vues sont toutes les commandes avec un article à expédier. Pas de coût d&apos;achat : marge = CA HT.
              </p>
            )}
            {a.protection && (
              <div className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 rounded-lg bg-zinc-50 px-3 py-2 text-sm ring-1 ring-zinc-900/5">
                <span className="font-medium">Résultat de la protection colis</span>
                <span className="text-xs text-zinc-600">
                  CA HT {exact(a.protection.revenueHtCents)} ({int(a.protection.orders)} commande(s)) − sinistres {exact(a.protection.claimsCents)} ({int(a.protection.claims)})
                </span>
                <span className={`font-semibold tabular-nums ${a.protection.resultCents < 0 ? "text-rose-700" : "text-emerald-700"}`}>{exact(a.protection.resultCents)}</span>
              </div>
            )}
          </Card>

          <Card icon={Ticket} iconColor="#10b981" title="Codes promo">
            <DataTable
              caption="Codes promo utilisés"
              columns={[
                { label: "Code" },
                { label: "Cmd" },
                { label: "Remise" },
                { label: "Panier moyen", info: "CA TTC net ÷ commandes avec ce code." },
                { label: "Marge nette", info: "Avant pub : CA HT − frais, coûts et litiges des commandes avec ce code." },
              ]}
              minWidth={420}
              empty="Aucun code utilisé sur la période."
              rows={a.codes.map((c) => ({
                key: c.code,
                cells: [
                  <code key="c" className="text-xs">
                    {c.code}
                  </code>,
                  int(c.orders),
                  formatDeduction(c.discountCents, money),
                  money(c.aovCents),
                  <span key="p" className={c.profitCents < 0 ? "text-rose-700" : ""}>
                    {money(c.profitCents)}
                  </span>,
                ],
              }))}
            />
          </Card>

          <Card
            icon={CreditCard}
            iconColor="#10b981"
            title="Moyens de paiement"
            description="Frais Whop et marge nette par moyen : un moyen cher (BNPL…) peut rapporter moins qu'il n'y paraît. « Non précisé » = Whop ne l'a pas indiqué."
          >
            <DataTable
              caption="Ventes, frais et marge par moyen de paiement"
              columns={[
                { label: "Moyen" },
                { label: "Cmd" },
                { label: "Part" },
                { label: "CA HT" },
                { label: "Frais Whop", info: "Frais retenus par Whop sur ces paiements (offres comprises) et leur taux sur le montant encaissé TTC." },
                { label: "Marge nette", info: "Même définition que la marge nette : CA HT − frais Whop − coûts − litiges − sinistres, pour les commandes payées avec ce moyen." },
              ]}
              minWidth={560}
              empty="Aucune vente sur la période"
              rows={a.methods.map((r) => ({
                key: r.method,
                muted: r.method === "inconnu",
                cells: [
                  <DrillLink key="m" href={orders({ method: r.method })}>
                    {METHOD_LABELS[r.method] ?? r.method}
                  </DrillLink>,
                  int(r.orders),
                  r.method === "inconnu" ? "—" : pct(knownMethods ? r.orders / knownMethods : 0, 0),
                  money(r.revenueHtCents),
                  <span key="f" className="block">
                    {money(r.feesCents)}
                    <span className="block text-xs text-zinc-500">
                      {r.grossCents ? `${pct(r.feesCents / r.grossCents, 1)} du TTC` : "—"}
                      {r.feeKnownOrders < r.orders ? ` · ${int(r.feeKnownOrders)}/${int(r.orders)} connus` : ""}
                    </span>
                  </span>,
                  <span key="p" className={r.profitCents < 0 ? "text-rose-700" : ""}>
                    {money(r.profitCents)}
                    <span className="block text-xs text-zinc-500">{r.revenueHtCents ? `${pct(r.profitCents / r.revenueHtCents, 0)} du CA HT` : ""}</span>
                  </span>,
                ],
              }))}
            />
          </Card>

          <Card
            icon={ShieldAlert}
            iconColor="#dc2626"
            className="lg:col-span-2"
            title={
              <>
                Risque <InfoTip label="À propos du risque">Au-delà d&apos;environ 0,75 % de litiges, les prestataires de paiement durcissent leurs conditions.</InfoTip>
              </>
            }
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Mini icon={ShieldAlert} label="Taux de litige" value={pct(a.risk.disputeRate, 2)} hint={`${int(a.risk.disputes)} litige(s)`} />
              <Mini icon={ShieldAlert} label="Litiges perdus + frais" value={money(disputeLine)} hint={`${money(mt.disputeLostCents)} TTC perdus`} />
              <Mini icon={ShieldAlert} label="Remboursements" value={pct(a.risk.refundRate)} hint={money(a.risk.refundedCents)} />
              <Mini icon={ShieldAlert} label="Paiements à vérifier" value={int(a.risk.reviewHolds)} />
            </div>
          </Card>
        </div>
      </section>
      )}

      {tab === "clients" && (
      <section id="panel-clients" role="tabpanel" aria-labelledby="tab-clients">
        <div className="mb-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          <KpiTile
            label="Nouveaux clients"
            info="Clients distincts (e-mails) dont la première commande payée sur cette boutique est dans la période, sans commande Shopify antérieure (historique Shopify importé à la connexion, puis mis à jour à chaque commande). Les commandes sont comptées à part : un nouveau client qui recommande dans la période compte 1 client, 1 commande nouvelle et 1 commande récurrente."
            value={int(a.customers.newCustomers)}
            secondary={`${int(a.customers.newOrders)} commande(s) · ${pct(buyers ? a.customers.newOrders / buyers : 0, 0)} des commandes · ${exact(a.customers.newRevenueCents)} TTC`}
          />
          <KpiTile
            label="Clients récurrents"
            info="Clients distincts (e-mails) qui avaient déjà payé sur ce checkout avant la commande, ou déjà commandé sur la boutique Shopify (checkout natif, avant l'application) ; leurs commandes sont comptées à part."
            value={int(a.customers.returningCustomers)}
            secondary={`${int(a.customers.returningOrders)} commande(s) · ${pct(buyers ? a.customers.returningOrders / buyers : 0, 0)} des commandes · ${exact(a.customers.returningRevenueCents)} TTC`}
          />
          <KpiTile
            label="CAC de la période"
            value={a.ads.blendedCacCents != null ? exact(a.ads.blendedCacCents) : "—"}
            secondary={
              !a.ads.available
                ? "non ventilable par pays, appareil ou langue"
                : a.ads.spendCents
                  ? `${exact(a.ads.spendCents)} de pub ÷ ${int(a.ads.newCustomers)} nouveau(x) client(s)`
                  : "aucune dépense pub sur la période"
            }
            hint={a.ads.coverageFrom && a.ads.coverageFrom > range.from ? `dépenses connues depuis le ${dayLabel(a.ads.coverageFrom)} seulement : CAC sous-estimé` : undefined}
            info={`Coût d'acquisition d'un nouveau client sur la période affichée : toutes les dépenses publicitaires de la période ÷ ses nouveaux clients. Le « CAC 12 mois » de l'onglet Acquisition porte sur les ${cohorts?.cacDays ?? 365} derniers jours${cohorts && cohorts.cacDays < cohorts.windowDays ? ` (depuis le ${dayLabel(cohorts.cacFrom!)}, premier jour où les dépenses de toutes les régies sont connues)` : ""}.`}
          />
          <KpiTile
            label="Délai d'achat médian"
            value={formatMinutes(a.timeToPurchase.medianMin)}
            secondary={a.timeToPurchase.p75Min != null ? `75 % en moins de ${a.timeToPurchase.p75Min < 1 ? "1 min" : formatMinutes(a.timeToPurchase.p75Min)}` : undefined}
            info="Temps entre l'ouverture du checkout et le paiement, pour les commandes de la période. En dessous : délai sous lequel 3 acheteurs sur 4 ont payé."
          />
        </div>
        <HistoryNote history={a.customerHistory} orders={a.customerHistory.shopifyReturningOrders} />
        <div className="mt-6">
          <CohortCard cohorts={cohorts!} money={money} csvHref={csv("cohorts")} />
        </div>
      </section>
      )}

      {tab === "tests" && (
      <section id="panel-tests" role="tabpanel" aria-labelledby="tab-tests">
        <ExperimentPanel
          storeId={storeId}
          currency={a.currency}
          experiment={experiment}
          results={results}
          versionLabel={experiment ? versions.find((v) => v.id === experiment.versionId)?.label : null}
          versions={versions}
          history={history}
          tz={zone}
          back={hrefWith(base, state, keep)}
        />
        <CheckoutTestsPanel storeId={storeId} currency={a.currency} tests={checkoutTests} addOns={testAddOns} tz={zone} back={hrefWith(base, state, keep)} flash={sp.flash === "ct" ? { ok: sp.ok, error: sp.error } : undefined} />
      </section>
      )}
    </>
  );
}

function summaryOf(points: { day: string; value: number }[], money: (c: number) => string) {
  if (!points.length) return "";
  const best = points.reduce((b, p) => (p.value > b.value ? p : b), points[0]);
  const worst = points.reduce((b, p) => (p.value < b.value ? p : b), points[0]);
  const total = points.reduce((s, p) => s + p.value, 0);
  const d = (x: string) => new Date(`${x}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" });
  return `Total ${money(total)} sur ${points.length} jours ; meilleur jour le ${d(best.day)} (${money(best.value)}) ; plus faible le ${d(worst.day)} (${money(worst.value)}).`;
}

/** Funnel steps side by side for a few groups (share of each group's opened checkouts). */
/** Groups worth comparing (≥ 2 with traffic), or null. */
function splitGroups(groups: FunnelGroup[]): FunnelGroup[] | null {
  const shown = groups.filter((g) => g.sessions > 0);
  return shown.length < 2 ? null : shown;
}

function FunnelSplit({ title, groups, label }: { title: string; groups: FunnelGroup[]; label: (g: string) => string }) {
  const shown = splitGroups(groups);
  if (!shown) return null;
  const steps = shown[0].funnel;
  return (
    <div>
      <p className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">{title}</p>
      <DataTable
        caption={`Entonnoir ${title.toLowerCase()}`}
        columns={[{ label: "Étape" }, ...shown.map((g) => ({ label: label(g.group) }))]}
        minWidth={160 + shown.length * 100}
        empty=""
        rows={steps.map((s, i) => ({
          key: s.key,
          cells: [
            s.label,
            ...shown.map((g) => {
              const c = g.funnel[i]?.count ?? 0;
              return (
                <span key={g.group} className="tabular-nums">
                  {i === 0 ? int(c) : pct(g.sessions ? c / g.sessions : 0, 1)}
                  {i > 0 && <span className="block text-[11px] text-zinc-500">{int(c)}</span>}
                </span>
              );
            }),
          ],
        }))}
        footer={["Conversion checkout", ...shown.map((g) => pct(g.visitors ? g.paidVisitors / g.visitors : 0, 1))]}
      />
    </div>
  );
}

function SourcesCard({
  a,
  storeId,
  money,
  orders,
  csvHref,
  cohorts,
}: {
  a: Analytics;
  storeId: string;
  money: (c: number) => string;
  orders: (extra: Record<string, string | undefined>) => string;
  csvHref: string;
  /** Per-source 90-day margin per customer (break-even with LTV). */
  cohorts: Awaited<ReturnType<typeof storeCohorts>> | null;
}) {
  const showAds = a.ads.available;
  const margin90 = new Map((cohorts?.bySource ?? []).map((r) => [r.source, r.margin90]));
  const ltvBreakEven = (r: Analytics["sources"][number]) => breakEvenRoasLtv(r.revenueHtCents, r.orders, margin90.get(r.source));
  const detail = (be: number | null, beLtv: number | null) =>
    `Seuil ROAS HT : ${multiple(be)} ; seuil avec LTV 90 j : ${beLtv == null ? "indisponible (moins de 90 j de recul ou marge inconnue)" : multiple(beLtv)}`;
  const total = a.sources.reduce(
    (t, r) => ({ sessions: t.sessions + r.sessions, orders: t.orders + r.orders, ht: t.ht + r.revenueHtCents, spend: t.spend + r.spendCents, profit: t.profit + r.profitCents }),
    { sessions: 0, orders: 0, ht: 0, spend: 0, profit: 0 },
  );
  const unattributed = a.ads.unattributed.reduce((s, u) => s + u.spendCents, 0);
  // Secondary figures (CPA, break-even ROAS, POAS) sit under the main one of their column: the table fits the page width.
  const columns = [
    { label: "Source / campagne" },
    { label: "Checkouts" },
    { label: "Conv. checkout", info: "Acheteurs uniques ÷ visiteurs uniques ayant ouvert le checkout depuis cette source." },
    { label: "Cmd" },
    { label: "CA HT" },
    ...(showAds
      ? [
          { label: "Pub", info: "Dépenses publicitaires rattachées à la campagne. En dessous : CPA = dépenses ÷ commandes." },
          {
            label: "ROAS HT",
            info: (
              <>
                CA HT ÷ dépenses publicitaires de la campagne, comparé au ROAS de rentabilité : « Couper » en dessous (la pub coûte plus que la marge qu&apos;elle rapporte), « Garder »
                autour, « Scaler » au-delà de 1,3 × le seuil. « Trop tôt » tant que la campagne a moins de 5 commandes et a dépensé moins de 2 × la marge par commande.
                <br />
                <br />
                En dessous : seuil de rentabilité = 1 ÷ taux de marge nette avant pub des commandes de la ligne (celui de la boutique sans commande). « LTV 90 j » : seuil si l&apos;on compte
                la marge par client sur 90 jours (réachats compris) de la source.
              </>
            ),
          },
          { label: "Bénéf. après pub", info: "Marge nette des commandes de la source, moins ses dépenses publicitaires. En dessous : POAS = marge nette avant pub ÷ dépenses (rentable au-dessus de 1)." },
        ]
      : [{ label: "Marge nette" }]),
  ];
  const stack = (key: string, main: ReactNode, sub?: ReactNode) => (
    <span key={key} className="inline-flex flex-col items-end">
      <span>{main}</span>
      {sub && <span className="text-[11px] font-normal whitespace-nowrap text-zinc-500">{sub}</span>}
    </span>
  );
  const thresholds = (be: number | null, beLtv: number | null) => (be == null ? undefined : `seuil ${multiple(be)}${beLtv != null ? ` · LTV 90 j ${multiple(beLtv)}` : ""}`);
  return (
    <Card
      icon={Megaphone}
      iconColor="#f97316"
      title={
        <>
          Acquisition : sources et campagnes{" "}
          <InfoTip label="À propos des sources">
            Checkouts ouverts et commandes payées sur la période, par UTM capturé au clic sur « Paiement ». Les dépenses Meta / TikTok sont rattachées par nom ou identifiant de campagne
            (utm_campaign, utm_id).
          </InfoTip>
        </>
      }
      actions={
        <span className="flex items-center gap-1">
          <CsvLink href={csvHref} label="ventes et dépenses par source" />
          <Link href={`/dashboard/stores/${storeId}/growth#adspend`} className="inline-flex min-h-9 items-center rounded-lg px-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50">
            Dépenses pub →
          </Link>
        </span>
      }
    >
      <DataTable
        caption="Ventes et dépenses par source"
        columns={columns}
        minWidth={showAds ? 820 : 560}
        empty="Pas encore de données sur la période"
        rows={[
          ...a.sources.map((r) => ({
            key: `${r.source}|${r.campaign}`,
            muted: r.other,
            cells: [
              r.other ? (
                <span key="s" className="font-medium">
                  {sourceLabel(r.source)}
                </span>
              ) : (
                <DrillLink key="s" href={orders({ source: r.source })} sub={r.campaign}>
                  {sourceLabel(r.source)}
                </DrillLink>
              ),
              int(r.sessions),
              r.visitors ? pct(r.paidVisitors / r.visitors, 1) : "—",
              int(r.orders),
              money(r.revenueHtCents),
              ...(showAds
                ? [
                    r.spendCents ? stack("pub", money(r.spendCents), r.cpaCents != null ? `CPA ${money(r.cpaCents)}` : undefined) : "—",
                    stack(
                      "roas",
                      <Roas v={r.roas} verdict={r.verdict} detail={detail(r.breakEvenRoas, ltvBreakEven(r))} profitAfterAdsCents={r.profitAfterAdsCents} />,
                      r.spendCents ? thresholds(r.breakEvenRoas, ltvBreakEven(r)) : undefined,
                    ),
                    stack(
                      "p",
                      <span className={r.profitAfterAdsCents < 0 ? "text-rose-700" : ""}>{money(r.profitAfterAdsCents)}</span>,
                      r.poas != null ? `POAS ${multiple(r.poas)}` : undefined,
                    ),
                  ]
                : [money(r.profitCents)]),
            ],
          })),
          ...(showAds
            ? a.ads.unattributed.slice(0, 8).map((u) => ({
                key: `ua-${u.platform}-${u.campaign}`,
                muted: true,
                cells: [
                  <span key="u" className="block min-w-0">
                    <span className="block font-medium">Dépense non attribuée · {AD_PLATFORMS[u.platform as keyof typeof AD_PLATFORMS] ?? u.platform}</span>
                    <span className="block text-xs">{u.campaign} · aucun checkout avec cet utm_campaign / utm_id</span>
                  </span>,
                  "—",
                  "—",
                  "—",
                  "—",
                  money(u.spendCents),
                  "—",
                  <span key="p" className="text-rose-700">
                    {money(-u.spendCents)}
                  </span>,
                ],
              }))
            : []),
        ]}
        footer={
          a.sources.length
            ? [
                "Total",
                int(total.sessions),
                pct(a.cvr, 1),
                int(total.orders),
                money(total.ht),
                ...(showAds
                  ? [
                      stack("pub", money(total.spend + unattributed), a.ads.cpaCents != null ? `CPA ${money(a.ads.cpaCents)}` : undefined),
                      stack(
                        "roas",
                        <Roas v={a.ads.roas} verdict={a.ads.verdict} detail={`Seuil ROAS HT de la boutique : ${multiple(a.ads.breakEvenRoas)}`} profitAfterAdsCents={a.ads.netAfterAdsCents} />,
                        a.ads.spendCents ? thresholds(a.ads.breakEvenRoas, null) : undefined,
                      ),
                      stack("p", money(total.profit - total.spend - unattributed), a.ads.spendCents ? `POAS ${multiple(a.ads.poas)}` : undefined),
                    ]
                  : [money(total.profit)]),
              ]
            : undefined
        }
      />
      {showAds && a.ads.unattributed.length > 8 && <p className="mt-2 text-xs text-zinc-500">+ {a.ads.unattributed.length - 8} autre(s) campagne(s) non attribuée(s), comprises dans le total.</p>}
      {showAds && a.ads.spendCents > 0 && a.leakage && a.leakage.orders > 0 && a.ads.roasInclExternal != null && (
        <p className="mt-2 text-xs text-zinc-600">
          ROAS HT incl. ventes en ligne hors checkout Whop{a.leakage.partial && a.leakage.windowFrom ? ` (partiel : depuis le ${dayLabel(a.leakage.windowFrom)})` : ""} :{" "}
          <span className="font-medium tabular-nums">{multiple(a.ads.roasInclExternal)}</span> (+ {money(a.leakage.partial ? a.leakage.windowRevenueHtCents : a.leakage.revenueHtCents)} HT de{" "}
          {int(a.leakage.partial ? a.leakage.windowOrders : a.leakage.orders)} commande(s) de la boutique en ligne passées ailleurs que sur ce checkout
          {a.leakage.partial ? ` sur ces jours-là, ${money(a.leakage.revenueHtCents)} HT sur toute la période` : ""} : la publicité les a aussi financées, mais leur source et leurs coûts ne sont pas connus ; point de vente et commandes manuelles exclus).
        </p>
      )}
      {showAds && a.ads.spendCents === 0 && (
        <p className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          Aucune dépense publicitaire sur la période : connectez vos comptes Meta / TikTok ou saisissez vos dépenses dans{" "}
          <Link href={`/dashboard/stores/${storeId}/growth#adspend`} className="text-indigo-700 underline">
            Pub &amp; pixels › Dépenses publicitaires
          </Link>{" "}
          pour voir ROAS, CPA et bénéfice après pub. Astuce : ajoutez <code className="text-[11px]">utm_campaign={"{{campaign.name}}"}&amp;utm_id={"{{campaign.id}}"}</code> à vos URL Meta.
        </p>
      )}
    </Card>
  );
}

/** ROAS colored against the break-even (via the verdict) and the verdict chip: icon + words, never color alone. */
function Roas({ v, verdict, detail, profitAfterAdsCents }: { v: number | null; verdict?: AdVerdict | null; detail?: string; profitAfterAdsCents?: number | null }) {
  if (v == null) return <>—</>;
  const tone = verdict === "cut" ? "text-rose-700" : verdict === "scale" ? "text-emerald-700" : verdict === "keep" ? "text-amber-800" : "";
  return (
    <span className="inline-flex items-center justify-end gap-1.5">
      <span className={`font-medium ${tone}`}>{multiple(v)}</span>
      {verdict && <VerdictChip verdict={verdict} detail={detail} profitAfterAdsCents={profitAfterAdsCents} />}
    </span>
  );
}

/**
 * "ROAS plateforme vs ROAS réel": what Meta / TikTok / Google claim vs the orders we actually got (HT, like the sources table).
 * Conversions reported while the platform received margins (value mode "profit") are a POAS: shown in
 * their own table, against our margin.
 */
function PlatformRoasCard({ rows, money, storeId }: { rows: Analytics["platformVsReal"]; money: (c: number) => string; storeId: string }) {
  const revenue = rows.filter((r) => r.valueMode !== "profit");
  const profit = rows.filter((r) => r.valueMode === "profit");
  const unknown = rows.filter((r) => r.valueMode === "unknown");
  const split = rows.some((r) => r.split);
  return (
    <Card
      icon={Target}
      iconColor="#f59e0b"
      className="mb-6"
      title={
        <>
          {profit.length && !revenue.length
            ? "POAS plateforme vs POAS réel (nos commandes)"
            : profit.length
              ? "ROAS HT et POAS plateforme vs réels (nos commandes)"
              : "ROAS HT plateforme vs ROAS HT réel (nos commandes)"}{" "}
          <InfoTip label="À propos du ROAS plateforme">
            Les régies (Meta, TikTok, Google) s&apos;attribuent des achats selon leurs propres règles : leur ROAS est souvent gonflé. Fenêtres d&apos;attribution : celles
            de chaque compte publicitaire (par défaut Meta 7 jours après un clic + 1 jour après une vue, TikTok 7 jours clic + 1 jour vue, Google Ads 30 jours après un
            clic), tous appareils. Nos commandes : payées sur ce checkout et rattachées à la campagne par la dernière source payante (utm_campaign / utm_id) dans la
            fenêtre d&apos;attribution choisie en haut de page. Tout est HT comme le tableau des sources : notre CA HT net des remboursements ÷ dépense, et la valeur
            déclarée par la régie (TTC, ce que ses pixels ont vu) ramenée HT au ratio HT ÷ TTC de nos commandes. Sur-attribution = valeur de la régie ÷ notre CA :
            au-dessus de 1, la plateforme revendique des ventes qu&apos;elle n&apos;a pas apportées. Les jours où Meta / TikTok recevaient la marge de chaque commande
            (valeur de conversion « marge HT », Pub &amp; pixels) leur valeur est une marge : comparée à notre marge nette avant pub (POAS), sans ratio de TVA.
          </InfoTip>
        </>
      }
      description="Achats et valeur déclarés par la régie (selon ses fenêtres d'attribution), comparés aux commandes réellement reçues sur la période."
    >
      {(revenue.length > 0 || !profit.length) && (
        <PlatformTable
          rows={revenue}
          mode="revenue"
          money={money}
          storeId={storeId}
          caption="ROAS HT plateforme contre ROAS HT réel par campagne"
          empty="Aucune conversion déclarée par les régies sur la période : l'import Meta, TikTok et Google Ads récupère les achats et leur valeur avec les dépenses."
        />
      )}
      {profit.length > 0 && (
        <div className={revenue.length ? "mt-6" : undefined}>
          {revenue.length > 0 && <p className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Valeur de conversion « marge HT » : POAS</p>}
          <p className="mb-2 text-xs text-zinc-600">
            Meta / TikTok recevaient la marge HT de chaque commande (et non son montant) : leur « ROAS » est un POAS plateforme, comparé à notre marge nette avant pub ÷ dépense (POAS réel).
          </p>
          <PlatformTable rows={profit} mode="profit" money={money} storeId={storeId} caption="POAS plateforme contre POAS réel par campagne (valeur de conversion : marge HT)" empty="" />
        </div>
      )}
      {(unknown.length > 0 || split) && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {split && "La valeur de conversion envoyée aux régies a changé pendant la période : nos commandes sont réparties selon le mode en vigueur chaque jour. "}
          {unknown.length > 0 &&
            `${unknown.length} ligne(s) « mode inconnu » : importées avant l'enregistrement du mode, ou jour où il a changé ; comparées comme un chiffre d'affaires, à interpréter avec prudence.`}
        </p>
      )}
    </Card>
  );
}

function PlatformTable({
  rows,
  mode,
  money,
  storeId,
  caption,
  empty,
}: {
  rows: Analytics["platformVsReal"];
  mode: "revenue" | "profit";
  money: (c: number) => string;
  storeId: string;
  caption: string;
  empty: string;
}) {
  // Declared by the platform but nothing real to compare with: said in words, never "∞".
  const ratio = (r: number | null) =>
    r == null ? "—" : r === Infinity ? (mode === "profit" ? "aucune marge réelle" : "0 commande réelle") : `× ${new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 }).format(r)}`;
  const sum = (f: (r: Analytics["platformVsReal"][number]) => number) => rows.reduce((n, r) => n + f(r), 0);
  const spend = sum((r) => r.spendCents);
  const platformHt = sum((r) => r.platformValueHtCents);
  const ours = sum((r) => (mode === "profit" ? r.realProfitCents : r.realRevenueHtCents));
  const profit = mode === "profit";
  return (
    <DataTable
      caption={caption}
      minWidth={720}
      empty={empty}
      columns={[
        { label: "Campagne" },
        { label: "Dépense" },
        { label: "Achats plateforme" },
        { label: "Commandes réelles" },
        { label: profit ? "POAS plateforme" : "ROAS HT plateforme" },
        { label: profit ? "POAS réel" : "ROAS HT réel" },
        {
          label: "Sur-attribution",
          info: profit
            ? "Marge déclarée par la régie ÷ notre marge nette avant pub des commandes de la campagne (les deux HT)."
            : "Valeur des achats déclarés par la régie ÷ notre CA des commandes de la campagne (les deux HT).",
        },
      ]}
      rows={rows.map((r) => ({
        key: `${r.platform}-${r.campaign}-${r.valueMode}`,
        muted: !r.matched,
        cells: [
          <span key="c">
            {r.campaign}
            <span className="block text-xs text-zinc-500">
              {AD_PLATFORMS[r.platform as keyof typeof AD_PLATFORMS] ?? r.platform}
              {r.valueMode === "unknown" && " · mode de valeur inconnu"}
              {r.split && " · période répartie par mode"}
              {!r.matched && (
                <>
                  {" "}
                  · non rattachée à nos commandes (<Link className="underline" href={`/dashboard/stores/${storeId}/growth#adspend`}>UTM</Link>)
                </>
              )}
            </span>
          </span>,
          money(r.spendCents),
          new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(r.platformConversions),
          int(r.realOrders),
          multiple(r.platformRoas),
          multiple(r.realRoas),
          <span key="o" className={r.overAttribution != null && r.overAttribution > 1.2 ? "font-semibold text-amber-700" : undefined}>
            {ratio(r.overAttribution)}
          </span>,
        ],
      }))}
      footer={
        rows.length
          ? [
              "Total",
              money(spend),
              new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(sum((r) => r.platformConversions)),
              int(sum((r) => r.realOrders)),
              multiple(spend ? platformHt / spend : null),
              multiple(spend ? ours / spend : null),
              ratio(ours > 0 ? platformHt / ours : platformHt > 0 ? Infinity : null),
            ]
          : undefined
      }
    />
  );
}

/** Share of the store's sales placed outside this checkout (Shopify orders imported daily). */
function LeakageCard({
  leakage,
  ads,
  exact,
  zone,
}: {
  leakage: NonNullable<Analytics["leakage"]>;
  ads: Analytics["ads"];
  /** Exact amounts (cents) for both HT and TTC: one precision in the card. */
  exact: (c: number) => string;
  zone: string;
}) {
  const share = leakage.share;
  const tone = share == null ? "text-zinc-500" : share >= 0.2 ? "text-rose-700" : share >= 0.05 ? "text-amber-800" : "text-zinc-900";
  const others = (
    [
      ["pos", "point de vente"],
      ["draft", "commandes manuelles (brouillons)"],
      ["other", "autres canaux (applications, mobile…)"],
    ] as const
  ).filter(([k]) => leakage.channels[k].orders > 0);
  return (
    <Card
      icon={Globe2}
      iconColor="#f59e0b"
      className="mb-6"
      title={
        <>
          Ventes hors checkout Whop{" "}
          <InfoTip label="À propos des ventes hors checkout">
            Commandes Shopify qui ne viennent pas de ce checkout, importées chaque jour. La part et le ROAS ne comptent que la boutique en ligne (checkout Shopify natif pendant
            un secours ou pour les visiteurs que le script n&apos;a pas redirigés) : le point de vente, les commandes manuelles et les autres canaux sont montrés à part. Montant
            actuel TTC (après remboursements), HT au taux normal du pays de livraison, sans coûts : elles ne sont ni dans la marge ni dans le ROAS des autres tableaux.
            Commandes de test et annulées exclues.
          </InfoTip>
        </>
      }
    >
      {!leakage.lastImportAt ? (
        <p className="text-sm text-zinc-600">
          Premier import des commandes Shopify en cours (les 60 derniers jours) : l&apos;indicateur apparaîtra après le prochain passage de la maintenance automatique.
          {leakage.error && <span className="mt-1 block text-rose-700">Dernier essai : {leakage.error}</span>}
        </p>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <div>
            <p className="text-xs font-medium text-zinc-500">Part des ventes en ligne hors checkout Whop</p>
            <p className={`text-2xl font-semibold tabular-nums ${tone}`}>{share == null ? "—" : pct(share, 1)}</p>
            {leakage.partial && leakage.windowFrom ? (
              <>
                {/* Headline on the days the share covers; the whole period as a secondary line. */}
                <p className="text-xs text-zinc-500">
                  Depuis le {dayLabel(leakage.windowFrom)} : {int(leakage.windowOrders)} commande(s) en ligne · {exact(leakage.windowRevenueHtCents)} HT · {exact(leakage.windowRevenueCents)} TTC
                </p>
                <p className="text-xs text-zinc-400">
                  Toute la période : {int(leakage.orders)} commande(s) · {exact(leakage.revenueHtCents)} HT · {exact(leakage.revenueCents)} TTC
                </p>
              </>
            ) : (
              <p className="text-xs text-zinc-500">
                {int(leakage.orders)} commande(s) en ligne · {exact(leakage.revenueHtCents)} HT · {exact(leakage.revenueCents)} TTC
              </p>
            )}
          </div>
          <div className="space-y-1 text-xs text-zinc-600">
            {share != null && <ShareBar value={leakage.windowRevenueHtCents} max={Math.max(1, leakage.windowRevenueHtCents / Math.max(share, 1e-9))} />}
            <p>
              {share == null
                ? "Période antérieure aux commandes importées : part non calculable. "
                : leakage.partial && leakage.windowFrom
                  ? `Partiel : calculée depuis le ${dayLabel(leakage.windowFrom)} (premier jour couvert par l'import), sur le CA HT de la boutique en ligne (ce checkout + hors checkout). `
                  : "Part du CA HT de la boutique en ligne (ce checkout + hors checkout). "}
              {ads.spendCents > 0 && ads.roasInclExternal != null && (
                <>
                  La publicité finance aussi ces ventes : ROAS HT incl. hors checkout <span className="font-medium tabular-nums">{multiple(ads.roasInclExternal)}</span>
                  {leakage.partial ? " (mêmes jours)" : ""} (ROAS HT de ce checkout {multiple(ads.roas)}).{" "}
                </>
              )}
              {leakage.fallbackOrders > 0 && leakage.fallbackShare != null && (
                <>
                  Dont {pct(leakage.fallbackShare, 1)} ({int(leakage.fallbackOrders)} commande(s)) pendant le secours ou la désactivation du checkout Whop : attendues, hors alerte.{" "}
                </>
              )}
              {leakage.lastCompletedAt ? `Dernier import complet : ${formatDateTime(new Date(leakage.lastCompletedAt), false, zone)}` : "Aucun import complet pour l'instant"}
              {leakage.coveredFrom ? ` · commandes connues depuis le ${dayLabel(leakage.coveredFrom)}` : ""}.
              {leakage.error && (
                <span className="block text-rose-700">
                  Dernier essai en échec ({formatDateTime(new Date(leakage.lastImportAt), false, zone)}) : {leakage.error}. Les jours suivant le dernier import complet ne sont pas encore
                  jugés.
                </span>
              )}
            </p>
            {others.length > 0 && (
              <p>
                Hors part et ROAS :{" "}
                {others.map(([k, label], i) => (
                  <span key={k}>
                    {i ? " · " : ""}
                    {label} {int(leakage.channels[k].orders)} commande(s), {exact(leakage.channels[k].revenueHtCents)} HT
                  </span>
                ))}
                .
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

function CreativesCard({ rows, money, csvHref, storeId }: { rows: CreativeRow[]; money: (c: number) => string; csvHref: string; storeId: string }) {
  return (
    <Card
      icon={Sparkles}
      iconColor="#ec4899"
      className="mt-6"
      title={
        <>
          Créas &amp; ad sets{" "}
          <InfoTip label="À propos des créas et ad sets">
            Dépenses Meta / TikTok par ad set et par publicité (importées automatiquement), rattachées aux commandes par utm_content ou utm_term (identifiant ou nom, sans tenir compte des
            majuscules). Les publicités de même nom sont regroupées. Ces lignes détaillent les campagnes : elles ne s&apos;ajoutent jamais au total des dépenses.
          </InfoTip>
        </>
      }
      actions={rows.length ? <CsvLink href={csvHref} label="créas et ad sets" /> : undefined}
    >
      {rows.length === 0 ? (
        <p className="rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          Aucune dépense par ad set ou publicité sur la période. Elles s&apos;importent avec les campagnes une fois Meta / TikTok connectés (
          <Link href={`/dashboard/stores/${storeId}/growth#adspend`} className="text-indigo-700 underline">
            Dépenses pub
          </Link>
          ). Pour les rattacher aux commandes, ajoutez à vos URL Meta{" "}
          <code className="text-[11px]">utm_content={"{{ad.name}}"}&amp;utm_term={"{{adset.name}}"}</code> (TikTok : <code className="text-[11px]">utm_content=__CID_NAME__</code>).
        </p>
      ) : (
        <DataTable
          caption="Dépenses, commandes et rentabilité par ad set et par publicité"
          columns={[
            { label: "Ad set / publicité" },
            { label: "Pub" },
            { label: "Cmd" },
            { label: "CA HT" },
            { label: "Bénéf. après pub" },
            { label: "CPA" },
            { label: "POAS", info: "Marge nette avant pub des commandes rattachées ÷ dépenses. Couper < 0,95 ; Garder jusqu'à 1,3 ; Scaler au-delà ; « Trop tôt » sous 5 commandes et 2 × la marge par commande dépensés." },
          ]}
          minWidth={760}
          empty=""
          rows={rows.map((r) => ({
            key: `${r.level}|${r.platform}|${r.name}`,
            cells: [
              <span key="n" className="block min-w-0">
                <span className="block truncate font-medium" title={r.name}>
                  {r.name}
                </span>
                <span className="block text-xs text-zinc-500">
                  {r.level === "ad" ? "Publicité" : "Ad set"} · {AD_PLATFORMS[r.platform as keyof typeof AD_PLATFORMS] ?? r.platform}
                  {r.ids.length > 1 ? ` · ${r.ids.length} identifiants` : ""}
                </span>
              </span>,
              money(r.spendCents),
              int(r.orders),
              money(r.revenueHtCents),
              <span key="p" className={r.profitAfterAdsCents < 0 ? "text-rose-700" : ""}>
                {money(r.profitAfterAdsCents)}
              </span>,
              r.cpaCents != null ? money(r.cpaCents) : "—",
              <span key="poas" className="inline-flex items-center justify-end gap-1.5">
                {multiple(r.poas)}
                {r.verdict && <VerdictChip verdict={r.verdict} profitAfterAdsCents={r.profitAfterAdsCents} />}
              </span>,
            ],
          }))}
        />
      )}
    </Card>
  );
}

function LtvCard({
  cohorts,
  money,
  csvHref,
  storeId,
  blended,
  periodLabel,
}: {
  cohorts: Awaited<ReturnType<typeof storeCohorts>>;
  /** "30 derniers jours"… (the page's period). */
  periodLabel: string;
  money: (c: number) => string;
  csvHref: string;
  storeId: string;
  /** Blended CAC of the page's period (null when spend can't be split by the active filter). */
  blended: { cacCents: number | null; newCustomers: number; spendCents: number; source?: string } | null;
}) {
  const m = (v: number | null) => (v == null ? "—" : money(v));
  // CAC over the days with complete ad spend data only: "depuis le …" while the history is shorter than 12 months.
  const cacShort = cohorts.cacDays < cohorts.windowDays && cohorts.cacFrom;
  const cacLabel = cacShort ? `CAC depuis le ${new Date(`${cohorts.cacFrom}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" })}` : cohorts.windowDays === 365 ? "CAC 12 mois" : `CAC ${cohorts.windowDays} j`;
  return (
    <Card
      icon={Target}
      iconColor="#16a34a"
      className="mt-6"
      title={
        <>
          Valeur client et coût d&apos;acquisition par source
          {cohorts.estimated && <EstimatedBadge />}{" "}
          <InfoTip label="À propos de la valeur client">
            Clients acquis sur les {cohorts.windowDays} derniers jours, par source de leur première commande. Marge par client = marge nette (HT, après frais, coûts et litiges) de toutes
            ses commandes dans les 30, 60 ou 90 jours suivant la première, sur les clients acquis depuis au moins autant de jours. CAC = dépenses publicitaires rattachées aux campagnes de
            la source sur la même fenêtre ÷ nouveaux clients. LTV/CAC = marge par client (horizon le plus long disponible) ÷ CAC : en dessous de 1, chaque client coûte plus
            qu&apos;il ne rapporte ; au-dessus de 3, l&apos;acquisition est saine.
          </InfoTip>
        </>
      }
      actions={<CsvLink href={csvHref} label="valeur client par source" />}
    >
      <DataTable
        caption="Marge par client à 30, 60 et 90 jours, coût d'acquisition et ratio LTV/CAC par source de première commande"
        columns={[{ label: "1ʳᵉ source" }, { label: "Clients" }, { label: "Marge 30 j" }, { label: "Marge 60 j" }, { label: "Marge 90 j" }, { label: cacLabel }, { label: "LTV / CAC" }]}
        minWidth={680}
        empty={`Pas encore de clients sur ${cohorts.windowDays} jours.`}
        rows={cohorts.bySource.map((r) => ({
          key: r.source,
          cells: [
            <span key="s" className="block min-w-0">
              <span className="block truncate font-medium">{sourceLabel(r.source)}</span>
              <span className="block text-xs text-zinc-500">CA HT 30 j : {m(r.ltv30)}</span>
            </span>,
            int(r.customers),
            m(r.margin30),
            m(r.margin60),
            m(r.margin90),
            r.cacCents == null ? <span key="c" className="text-zinc-500">{r.spendCents ? "—" : "sans pub"}</span> : money(r.cacCents),
            r.ltvCac == null ? (
              "—"
            ) : (
              <span key="l" className="inline-flex flex-col items-end gap-0.5">
                <LevelPill level={ltvCacLevel(r.ltvCac)} value={multiple(r.ltvCac)} />
                <span className="text-[11px] text-zinc-500">à {r.ltvCacHorizon} j</span>
              </span>
            ),
          ],
        }))}
        footer={
          cohorts.bySource.length
            ? [
                <span key="t" className="block">
                  Toutes sources{" "}
                  <span className="block text-xs font-normal text-zinc-500">
                    {cacLabel} = toutes les dépenses ÷ tous les nouveaux clients ({cohorts.cacDays} j)
                  </span>
                </span>,
                int(cohorts.blended.customers),
                "",
                "",
                "",
                cohorts.blended.cacCents == null ? "—" : money(cohorts.blended.cacCents),
                "",
              ]
            : undefined
        }
      />
      {blended && (
        <p className="mt-3 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
          <strong className="font-semibold text-zinc-800">
            CAC de la période ({periodLabel}) : {blended.cacCents == null ? "—" : money(blended.cacCents)}
          </strong>{" "}
          ({money(blended.spendCents)} de dépenses ÷ {int(blended.newCustomers)} nouveau(x) client(s)
          {blended.source ? `, source « ${sourceLabel(blended.source)} » : ses campagnes seulement` : ", toutes sources confondues, dépenses attribuées ou non"}). Différent du {cacLabel} ci-dessus,
          calculé sur les {cohorts.cacDays} derniers jours quelle que soit la période choisie.
        </p>
      )}
      {cacShort && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Dépenses publicitaires connues pour toutes les régies connectées depuis le {dayLabel(cohorts.cacFrom!)} seulement
          {cohorts.backfilling ? " (import de l'historique sur 13 mois en cours, un mois de plus à chaque passage de la maintenance)" : ""} : le CAC porte sur les dépenses et les nouveaux
          clients depuis cette date ({int(cohorts.cacDays)} j), pour ne pas diviser des dépenses manquantes par des clients bien réels.
        </p>
      )}
      <HistoryNote history={cohorts.history} excluded={cohorts.shopifyReturning} />
      {cohorts.unattributedSpendCents > 0 && (
        <p className="mt-2 text-xs text-zinc-500">
          {money(cohorts.unattributedSpendCents)} de dépenses sur la fenêtre ne correspondent à aucune source (campagnes sans utm_campaign / utm_id) : elles ne sont dans aucun CAC.{" "}
          <Link href={`/dashboard/stores/${storeId}/growth#adspend`} className="text-indigo-700 underline">
            Dépenses pub
          </Link>
        </p>
      )}
    </Card>
  );
}

/**
 * Caveat on new vs returning: whether the buyers' Shopify order history (before this checkout) is
 * known, and how many buyers it moved out of the new customers.
 */
function HistoryNote({ history, excluded, orders }: { history: Analytics["customerHistory"] | Awaited<ReturnType<typeof storeCohorts>>["history"]; excluded?: number; orders?: number }) {
  const done = history.state === "done";
  return (
    <p className={`mt-2 rounded-lg px-3 py-2 text-xs ${done ? "bg-zinc-50 text-zinc-600" : "bg-amber-50 text-amber-900"}`}>
      {done
        ? `Historique Shopify pris en compte (${int(history.customers)} client(s) Shopify avec au moins une commande importé(s)) : un acheteur compte comme récurrent seulement si sa première commande sur la boutique précède son achat ici (commandes plus anciennes que les 60 jours visibles comprises).`
        : history.state === "running"
          ? `Import de l'historique des clients Shopify en cours (${int(history.customers)} client(s) importé(s)) : des acheteurs déjà venus par le checkout Shopify peuvent encore être comptés comme nouveaux.`
          : history.state === "error"
            ? `Import de l'historique des clients Shopify en échec (${history.error ?? "erreur inconnue"}), nouvel essai automatique : des acheteurs déjà clients de la boutique peuvent être comptés comme nouveaux.`
            : "Historique des clients Shopify pas encore importé (connexion Shopify requise) : seules les commandes passées sur ce checkout distinguent nouveaux et récurrents."}
      {excluded ? ` ${int(excluded)} client(s) dont la première commande ici n'était pas la première sur la boutique sont exclus des cohortes et du CAC.` : ""}
      {orders ? ` ${int(orders)} commande(s) de la période comptée(s) récurrente(s) grâce à cet historique.` : ""}
    </p>
  );
}

function CohortCard({ cohorts, money, csvHref }: { cohorts: Awaited<ReturnType<typeof storeCohorts>>; money: (c: number) => string; csvHref: string }) {
  const offsets = Array.from({ length: Math.min(cohorts.maxOffset, 12) + 1 }, (_, k) => k);
  const monthLabel = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString("fr-FR", { month: "short", year: "2-digit", timeZone: "UTC" });
  // Darker = more repeat buyers; text colors keep ≥ 4.5:1 contrast on every step.
  const shade = (v: number | null) => (v == null ? "" : v >= 0.3 ? "bg-indigo-800 text-white" : v >= 0.15 ? "bg-indigo-600 text-white" : v >= 0.05 ? "bg-indigo-200 text-indigo-950" : v > 0 ? "bg-indigo-50 text-indigo-950" : "text-zinc-600");
  return (
    <Card
      icon={Repeat}
      iconColor="#8b5cf6"
      title={
        <>
          Cohortes de clients{" "}
          <InfoTip label="À propos des cohortes">
            Clients regroupés par mois de première commande (13 derniers mois, M0 à M12). Taux de réachat cumulé et CA HT cumulé par client, mois après mois (M0 = mois de la 1ʳᵉ
            commande). Toutes sources, filtres de période ignorés.
          </InfoTip>
        </>
      }
      actions={<CsvLink href={csvHref} label="cohortes de clients" />}
    >
      {cohorts.months.length === 0 ? (
        <p className="text-sm text-zinc-500">Pas encore de clients sur 13 mois.</p>
      ) : (
        <div className="relative -mx-5 overflow-x-auto px-5 [scrollbar-width:thin]" tabIndex={0} role="region" aria-label="Cohortes de clients (défilement horizontal)">
          <table className="text-xs tabular-nums" style={{ minWidth: 170 + offsets.length * 60 }}>
            <caption className="sr-only">Taux de réachat cumulé et CA HT cumulé par client, par cohorte mensuelle</caption>
            <thead className="text-zinc-500">
              <tr>
                <th scope="col" className="sticky left-0 z-[1] w-24 bg-white pb-2 text-left font-medium">
                  Cohorte
                </th>
                <th scope="col" className="w-16 pr-2 pb-2 pl-2 text-right font-medium">
                  Clients
                </th>
                {offsets.map((k) => (
                  <th key={k} scope="col" className="w-14 pb-2 pl-1 text-center font-medium">
                    M{k}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.months.map((c) => (
                <tr key={c.cohort}>
                  <th scope="row" className="sticky left-0 z-[1] bg-white py-1 pr-2 text-left font-medium whitespace-nowrap text-zinc-700">
                    {monthLabel(c.cohort)}
                  </th>
                  <td className="py-1 pr-2 pl-2 text-right">{int(c.customers)}</td>
                  {offsets.map((k) => {
                    const rate = c.repeatRate[k];
                    const rev = c.revenuePerCustomerHtCents[k];
                    return (
                      <td key={k} className="py-0.5 pl-1">
                        {rate === undefined ? (
                          <span className="block text-center text-zinc-500" aria-label="à venir">
                            ·
                          </span>
                        ) : (
                          <span className={`block rounded px-1 py-0.5 text-center ${shade(rate)}`} title={`Réachat ${pct(rate ?? 0)} · ${rev == null ? "—" : money(rev)} HT par client`}>
                            {pct(rate ?? 0, 0)}
                            <span className="block text-[11px]">{rev == null ? "—" : money(rev)}</span>
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-[11px] text-zinc-500">
            Chaque case : part des clients de la cohorte ayant racheté (cumulé), puis CA HT cumulé par client. « · » : mois pas encore écoulé.
          </p>
        </div>
      )}
    </Card>
  );
}

/** Checkouts → paid and conversion per group (language, country), with a link to filter the page. */
function ConversionSplit({
  caption,
  head,
  groups,
  label,
  href,
  empty,
  hideRates,
}: {
  caption: string;
  head: string;
  groups: FunnelGroup[];
  label: (g: string) => string;
  href: (g: string) => string | null;
  empty: string;
  /** Rates hidden (unreliable split): counts only. */
  hideRates?: boolean;
}) {
  const shown = groups.filter((g) => g.sessions > 0);
  const paid = (g: FunnelGroup) => g.funnel[g.funnel.length - 1]?.count ?? 0;
  return (
    <DataTable
      caption={caption}
      columns={[
        { label: head },
        { label: "Checkouts" },
        { label: "Payés" },
        { label: "Conv. checkout", info: "Visiteurs uniques ayant payé ÷ visiteurs uniques ayant ouvert le checkout." },
      ]}
      empty={shown.length ? "" : empty}
      rows={shown.map((g) => {
        const link = href(g.group);
        return {
          key: g.group,
          muted: g.group.startsWith("Autres") || g.group === "inconnu",
          cells: [
            link ? (
              <Link key="g" href={link} className="font-medium text-zinc-900 hover:text-indigo-700 hover:underline" title="Filtrer la page">
                {label(g.group)}
              </Link>
            ) : (
              <span key="g" className="font-medium">
                {label(g.group)}
              </span>
            ),
            int(g.sessions),
            int(paid(g)),
            hideRates ? (
              <span key="c" className="text-zinc-500" title="Masqué : couverture géographique insuffisante">
                —
              </span>
            ) : (
              <span key="c" className="inline-flex min-w-[7rem] items-center justify-end gap-2">
                <span className="hidden w-14 sm:block" aria-hidden>
                  <ShareBar value={g.paidVisitors} max={Math.max(1, g.visitors)} />
                </span>
                {pct(g.visitors ? g.paidVisitors / g.visitors : 0, 1)}
              </span>
            ),
          ],
        };
      })}
    />
  );
}

/** "Attribution : dernier clic pub, 7 j" + last / first touch switch and the window (1/7/28 j) applied to past data. */
function AttributionBar({
  days,
  storeDays,
  touch,
  storeId,
  hrefFor,
  windowHref,
}: {
  days: number;
  storeDays: number;
  touch: "last" | "first";
  storeId: string;
  hrefFor: (t: "last" | "first") => string;
  windowHref: (d: number) => string;
}) {
  const win = (d: number) => (
    <Link
      key={d}
      href={windowHref(d)}
      scroll={false}
      aria-current={days === d ? "true" : undefined}
      title={d === storeDays ? "Fenêtre réglée pour la boutique" : undefined}
      className={`inline-flex min-h-8 items-center rounded-md px-2.5 ${days === d ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900"}`}
    >
      {d} j
    </Link>
  );
  const opt = (t: "last" | "first", text: string) => (
    <Link
      href={hrefFor(t)}
      scroll={false}
      aria-current={touch === t ? "true" : undefined}
      className={`inline-flex min-h-8 items-center rounded-md px-2.5 ${touch === t ? "bg-white font-medium text-zinc-900 shadow-sm" : "text-zinc-600 hover:text-zinc-900"}`}
    >
      {text}
    </Link>
  );
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-white px-4 py-2.5 text-sm shadow-[var(--shadow-card)]">
      <MousePointerClick className="h-4 w-4 shrink-0 text-orange-500" aria-hidden />
      <span className="min-w-0">
        <strong className="font-semibold">Attribution : {touch === "first" ? "premier clic pub" : "dernier clic pub"}, {days} j</strong>
        <InfoTip label="À propos de l'attribution">
          Chaque arrivée sur la boutique avec des UTM ou un identifiant de clic (fbclid, gclid, ttclid) remplace entièrement le « dernier clic pub ». Le « premier clic pub » est le tout
          premier enregistré pour ce visiteur. Chaque clic est daté : un checkout ouvert plus de {days} jour(s) après le clic est « direct / inconnu ». La fenêtre s&apos;applique à
          l&apos;affichage, sur toutes les données passées : comparez 1, 7 et 28 jours sans rien perdre (celle de la boutique, {storeDays} j, se règle dans Paramètres). Le filtre « Source »
          et les autres onglets utilisent le dernier clic avec la même fenêtre.
        </InfoTip>
      </span>
      <span className="inline-flex rounded-lg bg-zinc-100 p-0.5 text-xs" role="group" aria-label="Modèle d'attribution du tableau des sources">
        {opt("last", "Dernier clic")}
        {opt("first", "Premier clic")}
      </span>
      <span className="inline-flex rounded-lg bg-zinc-100 p-0.5 text-xs" role="group" aria-label="Fenêtre d'attribution">
        {ATTRIBUTION_WINDOWS.map(win)}
      </span>
      <Link href={`/dashboard/stores/${storeId}/settings#attribution`} className="text-xs text-indigo-700 hover:underline sm:ml-auto">
        Fenêtre par défaut : {storeDays} j
      </Link>
    </div>
  );
}

const SURVEY_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  google: "Google",
  youtube: "YouTube",
  friend: "Un proche / bouche-à-oreille",
  other: "Autre",
};

/** Post-purchase survey answers vs the UTM source the same orders carried. */
function SurveyCard({ a, money, csvHref }: { a: Analytics; money: (c: number) => string; csvHref: string }) {
  const sv = a.survey;
  return (
    <Card
      icon={MessageCircleQuestion}
      iconColor="#0ea5e9"
      className="mt-6"
      title={
        <>
          Comment nous ont-ils connus ?{" "}
          <InfoTip label="À propos du questionnaire">
            Réponses au questionnaire de la page de remerciement, sur les commandes payées de la période, comparées à la source UTM (dernier clic pub) de ces mêmes commandes. Une réponse
            « Instagram » sur une commande « direct / inconnu » est une vente que les UTM n&apos;ont pas vue (bouche-à-oreille, pub vue puis recherche…).
          </InfoTip>
        </>
      }
      description={sv.orders ? `Réponses : ${int(sv.answered)} / ${int(sv.orders)} commandes (${pct(sv.answered / sv.orders, 0)}).` : undefined}
      actions={sv.answered ? <CsvLink href={csvHref} label="réponses au questionnaire" /> : undefined}
    >
      <DataTable
        caption="Réponses au questionnaire post-achat et sources UTM des mêmes commandes"
        columns={[
          { label: "Réponse" },
          { label: "Cmd" },
          { label: "Part", info: "Part des réponses." },
          { label: "CA HT" },
          { label: "Sans UTM", info: "Commandes de cette réponse arrivées sans clic pub (direct / inconnu) : ventes que le suivi UTM ne voit pas." },
          { label: "Source UTM principale", align: "left" },
        ]}
        minWidth={620}
        empty={sv.orders ? "Aucune réponse au questionnaire sur la période." : "Aucune commande sur la période."}
        rows={sv.answers.map((r) => {
          const direct = r.utm.filter((u) => u.source === "direct / inconnu").reduce((t, u) => t + u.orders, 0);
          const top = r.utm.filter((u) => u.source !== "direct / inconnu").slice(0, 2);
          return {
            key: r.answer,
            cells: [
              <span key="a" className="font-medium">
                {SURVEY_LABELS[r.answer] ?? r.answer}
              </span>,
              int(r.orders),
              pct(sv.answered ? r.orders / sv.answered : 0, 0),
              money(r.revenueHtCents),
              `${int(direct)} · ${pct(r.orders ? direct / r.orders : 0, 0)}`,
              <span key="u" className="block text-left text-xs text-zinc-600">
                {top.length ? top.map((u) => `${sourceLabel(u.source)} (${int(u.orders)})`).join(" · ") : "—"}
              </span>,
            ],
          };
        })}
      />
    </Card>
  );
}
