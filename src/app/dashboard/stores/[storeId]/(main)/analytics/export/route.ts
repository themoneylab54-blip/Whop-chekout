import { requireAdmin } from "@/lib/auth";
import { tzOf, zoneLabel } from "@/lib/time";
import { db } from "@/lib/db";
import { fixedCostsFor, includeTestFor, resolveRange, storeAnalytics, storeCohorts, type AdVerdict, type Filters } from "@/lib/analytics";
import { AD_PLATFORMS } from "@/lib/adspend";
import { csvMoney, csvNumber, csvPercent, csvResponse } from "@/lib/csv";

export const dynamic = "force-dynamic";

/*
 * CSV exports of the Analytics tables (Excel FR): ?type=sources|creatives|daily|products|countries|offers|codes|bumps|cohorts|ltv|survey|conversion
 * with the same period, filters and test switch as the page (range, from, to, source, country,
 * device, lang, test; touch=first for the first-touch sources table). Same engine, no row limit
 * (no "Autres" grouping, except the language / country funnels).
 */

const TYPES = ["sources", "creatives", "daily", "products", "countries", "offers", "codes", "bumps", "cohorts", "ltv", "survey", "conversion"] as const;
type ExportType = (typeof TYPES)[number];

const VERDICT: Record<AdVerdict, string> = { early: "Trop tôt (données insuffisantes)", cut: "Couper", keep: "Garder", scale: "Scaler" };

export async function GET(req: Request, ctx: { params: Promise<{ storeId: string }> }) {
  await requireAdmin();
  const { storeId } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  const type = sp.get("type") as ExportType;
  if (!TYPES.includes(type)) return new Response("Type d'export inconnu", { status: 400 });
  const store = await db.store.findUnique({ where: { id: storeId }, select: { testMode: true, name: true, fixedCostsMonthlyCents: true, timezone: true } });
  if (!store) return new Response("Boutique introuvable", { status: 404 });

  const range = resolveRange({ range: sp.get("range") ?? undefined, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }, undefined, "30d", tzOf(store));
  const includeTest = includeTestFor(store, sp.get("test") ?? undefined);
  const device = sp.get("device");
  const country = sp.get("country");
  const filters: Filters = {
    source: sp.get("source")?.trim().slice(0, 100) || undefined,
    country: country && /^([A-Z]{2}|—)$/.test(country) ? country : undefined,
    device: device === "mobile" || device === "desktop" ? device : undefined,
    lang: /^([a-z]{2,3}|inconnu)$/.test(sp.get("lang") ?? "") ? (sp.get("lang") as string) : undefined,
    geo: /^([A-Z]{2}|inconnu)$/.test(sp.get("geo") ?? "") ? (sp.get("geo") as string) : undefined,
  };
  const touch = sp.get("touch") === "first" ? "first" : "last";
  const file = (name: string) => `${name}-${range.from}_${range.to}.csv`;
  const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("fr-FR", { timeZone: "UTC" });

  if (type === "cohorts" || type === "ltv") {
    const c = await storeCohorts(storeId, includeTest);
    if (type === "cohorts") {
      const offsets = Array.from({ length: c.maxOffset + 1 }, (_, k) => k);
      return csvResponse(
        `cohortes-${range.to}.csv`,
        ["Cohorte (1re commande)", "Clients", ...offsets.flatMap((k) => [`M${k} réachat cumulé (%)`, `M${k} CA HT cumulé / client`])],
        c.months.map((m) => [m.cohort, m.customers, ...offsets.flatMap((k) => [csvPercent(m.repeatRate[k]), m.revenuePerCustomerHtCents[k] == null ? "" : csvMoney(m.revenuePerCustomerHtCents[k]!)])]),
      );
    }
    return csvResponse(
      `ltv-sources-${range.to}.csv`,
      ["1re source", "Clients (365 j)", "Clients ≥ 30 j", "CA HT / client 30 j", "Marge / client 30 j", "Marge / client 60 j", "Marge / client 90 j", "Pub attribuée (365 j)", "CAC", "LTV marge / CAC", "Horizon LTV (j)", "Marges estimées"],
      c.bySource.map((r) => [
        r.source,
        r.customers,
        r.n30,
        r.ltv30 == null ? "" : csvMoney(r.ltv30),
        r.margin30 == null ? "" : csvMoney(r.margin30),
        r.margin60 == null ? "" : csvMoney(r.margin60),
        r.margin90 == null ? "" : csvMoney(r.margin90),
        csvMoney(r.spendCents),
        r.cacCents == null ? "" : csvMoney(r.cacCents),
        csvNumber(r.ltvCac),
        r.ltvCacHorizon ?? "",
        c.estimated ? "oui (coûts manquants comptés 0)" : "non",
      ]),
    );
  }

  const a = await storeAnalytics(storeId, { since: range.since, until: range.until, prevSince: range.prevSince, includeTest, filters }, { rowLimit: Infinity, touch, attributionDays: Number(sp.get("win")) || undefined });

  switch (type) {
    case "sources":
      return csvResponse(
        file(touch === "first" ? "sources-premier-clic" : "sources"),
        ["Source", "Campagne", "Checkouts", "Visiteurs", "Acheteurs", "Conversion checkout (%)", "Commandes", "CA TTC", "CA HT", "Marge nette", "Pub", "ROAS HT", "ROAS HT de rentabilité (1 ÷ taux de marge)", "POAS (marge ÷ pub)", "Verdict", "CPA", "Bénéfice après pub"],
        [
          ...a.sources.map((r) => [
            r.source,
            r.campaign,
            r.sessions,
            r.visitors,
            r.paidVisitors,
            csvPercent(r.visitors ? r.paidVisitors / r.visitors : null),
            r.orders,
            csvMoney(r.revenueCents),
            csvMoney(r.revenueHtCents),
            csvMoney(r.profitCents),
            csvMoney(r.spendCents),
            csvNumber(r.roas),
            csvNumber(r.breakEvenRoas),
            csvNumber(r.poas),
            r.verdict ? VERDICT[r.verdict] : "",
            r.cpaCents == null ? "" : csvMoney(r.cpaCents),
            csvMoney(r.profitAfterAdsCents),
          ]),
          ...a.ads.unattributed.map((u) => [`Dépense non attribuée (${u.platform})`, u.campaign, "", "", "", "", "", "", "", "", csvMoney(u.spendCents), "", "", "", "", "", csvMoney(-u.spendCents)]),
        ],
      );
    case "creatives":
      return csvResponse(
        file("creas-adsets"),
        ["Niveau", "Plateforme", "Nom", "Identifiants", "Pub", "Commandes", "CA HT", "Marge nette avant pub", "Bénéfice après pub", "CPA", "ROAS HT", "POAS (marge ÷ pub)", "Verdict"],
        a.creatives.map((r) => [
          r.level === "ad" ? "publicité" : "ad set",
          AD_PLATFORMS[r.platform as keyof typeof AD_PLATFORMS] ?? r.platform,
          r.name,
          r.ids.join(" "),
          csvMoney(r.spendCents),
          r.orders,
          csvMoney(r.revenueHtCents),
          csvMoney(r.profitCents),
          csvMoney(r.profitAfterAdsCents),
          r.cpaCents == null ? "" : csvMoney(r.cpaCents),
          csvNumber(r.roas),
          csvNumber(r.poas),
          r.verdict ? VERDICT[r.verdict] : "",
        ]),
      );
    case "codes":
      return csvResponse(
        file("codes-promo"),
        ["Code", "Commandes", "Remise TTC", "CA TTC", "CA HT", "Marge nette", "Panier moyen TTC"],
        a.codes.map((c) => [c.code, c.orders, csvMoney(c.discountCents), csvMoney(c.revenueCents), csvMoney(c.revenueHtCents), csvMoney(c.profitCents), csvMoney(c.aovCents)]),
      );
    case "bumps":
      return csvResponse(
        file("options"),
        ["Option", "Identifiant", "Vues (commandes à qui elle a été proposée)", "Vues estimées (anciens checkouts)", "Prises", "Taux de prise (%)", "CA TTC", "CA HT", "Coût", "Marge produit HT"],
        a.addOns.map((x) => [
          x.title,
          x.id,
          x.shown,
          x.estimated ? "oui" : "non",
          x.orders,
          csvPercent(x.attachRate),
          csvMoney(x.revenueCents),
          csvMoney(x.revenueHtCents),
          x.costCents == null ? "coût manquant" : csvMoney(x.costCents),
          x.marginCents == null ? "coût manquant" : csvMoney(x.marginCents),
        ]),
      );
    case "daily": {
      const monthly = a.fixedCosts.available ? store.fixedCostsMonthlyCents : 0;
      return csvResponse(
        file("pnl-jour"),
        [
          `Jour (${zoneLabel(tzOf(store))})`,
          "Checkouts",
          "Commandes",
          "CA TTC",
          "TVA",
          "CA HT avant litiges",
          "Litiges perdus (HT)",
          "CA HT",
          "Frais Whop",
          "Coûts (produits, options, livraison, préparation)",
          "Frais de litige",
          "Sinistres protection colis",
          "Marge nette (CA HT − frais − coûts − frais de litige − sinistres)",
          "Pub",
          "Bénéfice net après pub",
          "Frais fixes (prorata)",
          "Résultat net après frais fixes",
          "Ventes en ligne hors checkout Whop (CA HT)",
          "Commandes en ligne hors checkout Whop",
          "Checkout Shopify utilisé",
        ],
        a.daily.map((d) => {
          const fixed = fixedCostsFor(monthly, d.day, d.day);
          return [
            day(d.day),
            d.sessions,
            d.orders,
            csvMoney(d.revenueCents),
            csvMoney(d.vatCents),
            csvMoney(d.revenueHtBeforeDisputesCents),
            csvMoney(d.disputeLostHtCents),
            csvMoney(d.revenueHtCents),
            csvMoney(d.feesCents),
            csvMoney(d.costsCents),
            csvMoney(d.disputeFeesCents),
            csvMoney(d.claimsCents),
            csvMoney(d.netCents),
            csvMoney(d.spendCents),
            csvMoney(d.netCents - d.spendCents),
            csvMoney(fixed),
            csvMoney(d.netCents - d.spendCents - fixed),
            // Imported daily (sourceName "web"): empty when the store's outside orders aren't imported.
            // Days the import doesn't cover (before its first day): empty, never a false 0.
            a.leakage?.lastImportAt && d.externalRevenueHtCents != null ? csvMoney(d.externalRevenueHtCents) : "",
            a.leakage?.lastImportAt && d.externalOrders != null ? d.externalOrders : "",
            [d.fallback && "secours automatique", d.disabled && "checkout Whop désactivé"].filter(Boolean).join(" + "),
          ];
        }),
      );
    }
    case "products":
      return csvResponse(
        file("produits"),
        ["Produit", "Identifiant", "Unités", "Commandes", "CA TTC", "CA HT", "Marge produit HT (CA HT − coût d'achat)", "Taux de marge produit (%)", "Commandes remboursées (%)"],
        a.products.map((r) => [
          r.title,
          r.productId,
          r.units,
          r.orders,
          csvMoney(r.revenueCents),
          csvMoney(r.revenueHtCents),
          r.marginCents == null ? "coût manquant" : csvMoney(r.marginCents),
          r.marginCents == null ? "" : csvPercent(r.revenueHtCents ? r.marginCents / r.revenueHtCents : null),
          csvPercent(r.refundRate),
        ]),
      );
    case "countries":
      return csvResponse(
        file("pays"),
        ["Pays (code)", "Commandes", "CA TTC", "TVA", "CA HT", "Marge nette"],
        a.countries.map((r) => [r.country, r.orders, csvMoney(r.revenueCents), csvMoney(r.vatCents), csvMoney(r.revenueHtCents), csvMoney(r.profitCents)]),
      );
    case "offers":
      return csvResponse(
        file("offres"),
        ["Offre", "Bloc", "Type", "Vues", "Vues estimées (anciens checkouts)", "Acceptées", "Refusées", "Échecs", "Taux d'acceptation (%)", "Taux min. (%)", "Taux max. (%)", "CA TTC", "CA HT", "Marge produit HT (CA HT − coût d'achat)", "CA HT par vue"],
        a.offers.map((o) => [
          o.title,
          o.blockId,
          o.downsell ? "downsell" : "offre",
          o.impressions,
          o.estimated ? "oui" : "non",
          o.paid,
          o.declined,
          o.failed,
          csvPercent(o.takeRate),
          csvPercent(o.takeRateRange?.[0]),
          csvPercent(o.takeRateRange?.[1]),
          csvMoney(o.revenueCents),
          csvMoney(o.revenueHtCents),
          o.marginCents == null ? "coût manquant" : csvMoney(o.marginCents),
          csvMoney(o.revenuePerImpressionHtCents),
        ]),
      );
    case "survey":
      return csvResponse(
        file("questionnaire"),
        ["Réponse", "Source UTM (dernier clic)", "Commandes", "CA HT (réponse)"],
        a.survey.answers.flatMap((r) => r.utm.map((u, i) => [r.answer, u.source, u.orders, i === 0 ? csvMoney(r.revenueHtCents) : ""])),
      );
    case "conversion":
      return csvResponse(
        file("conversion-langue-pays"),
        ["Dimension", "Valeur", "Checkouts", "Payés", "Visiteurs", "Acheteurs", "Conversion checkout (%)"],
        [
          ...a.funnelBy.lang.map((g) => ["langue", g.group, g.sessions, g.funnel[g.funnel.length - 1]?.count ?? 0, g.visitors, g.paidVisitors, csvPercent(g.visitors ? g.paidVisitors / g.visitors : null)]),
          ...a.funnelBy.country.map((g) => ["pays", g.group, g.sessions, g.funnel[g.funnel.length - 1]?.count ?? 0, g.visitors, g.paidVisitors, csvPercent(g.visitors ? g.paidVisitors / g.visitors : null)]),
        ],
      );
  }
}
