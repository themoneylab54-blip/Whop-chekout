import { requireUser } from "@/lib/auth";
import { accessibleStoreWhere } from "@/lib/access";
import { resolveRange } from "@/lib/analytics";
import { STORE_SORTS, crossStoreStats, sortStores, type StoreSort } from "@/lib/dashboard-stats";
import { csvMoney, csvNumber, csvPercent, csvResponse } from "@/lib/csv";

export const dynamic = "force-dynamic";

/*
 * All stores for a period (same params as /dashboard: range, from, to, sort, dir), one row per
 * store in its own currency, then the totals (converted to EUR at the ECB rate when the stores
 * use several currencies).
 */
export async function GET(req: Request) {
  // Only the stores the user may open.
  const user = await requireUser();
  const sp = new URL(req.url).searchParams;
  const range = resolveRange({ range: sp.get("range") ?? undefined, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined });
  const sort: StoreSort = STORE_SORTS.includes(sp.get("sort") as StoreSort) ? (sp.get("sort") as StoreSort) : "ca";
  const dir = sp.get("dir") === "asc" ? "asc" : "desc";
  const { rows, totals } = await crossStoreStats(range, accessibleStoreWhere(user));
  const header = [
    "Boutique", "Devise", "Du", "Au", "Commandes", "Commandes (période préc.)", "Visiteurs du checkout", "Conversion checkout (%)", "CA TTC", "CA HT", "CA HT (période préc.)",
    "Marge nette", "Marge nette (période préc.)", "Coûts complets", "Pub", "ROAS HT", "POAS", "Marge après pub", "Marge après pub (période préc.)", "Frais fixes (prorata)",
    "Net après frais fixes", "Net après frais fixes (période préc.)", "Anomalies", "Commandes test incluses",
  ];
  const body: unknown[][] = sortStores(rows, sort, dir).map((r) => {
    const s = r.summary;
    return [
      r.name, r.currency, range.from, range.to, s.orders, s.previous.orders, s.visitors, csvPercent(s.visitors ? s.cvr : null), csvMoney(s.revenueCents), csvMoney(s.revenueHtCents),
      csvMoney(s.previous.revenueHtCents), csvMoney(s.profitCents), csvMoney(s.previous.profitCents), s.complete ? "oui" : "non (estimé)", csvMoney(s.spendCents),
      csvNumber(s.roas), csvNumber(s.poas), csvMoney(s.netAfterAdsCents), csvMoney(s.previous.netAfterAdsCents), csvMoney(s.fixedCostsCents),
      csvMoney(s.netAfterFixedCents), csvMoney(s.previous.netAfterFixedCents), r.anomalies.map((a) => a.title).join(" ; "), r.includeTest ? "oui" : "non",
    ];
  });
  body.push([
    totals.converted ? `Total (converti en EUR, taux BCE${totals.rateDate ? ` du ${totals.rateDate}` : ""})` : "Total", totals.currency, range.from, range.to,
    totals.now.orders, totals.previous.orders, "", "", "", csvMoney(totals.now.revenueHtCents), csvMoney(totals.previous.revenueHtCents), csvMoney(totals.now.profitCents),
    csvMoney(totals.previous.profitCents), totals.estimated ? "non (estimé)" : "oui", csvMoney(totals.now.spendCents),
    csvNumber(totals.now.spendCents ? totals.now.revenueHtCents / totals.now.spendCents : null), csvNumber(totals.now.spendCents ? totals.now.profitCents / totals.now.spendCents : null),
    csvMoney(totals.now.netAfterAdsCents), csvMoney(totals.previous.netAfterAdsCents), csvMoney(totals.now.fixedCostsCents), csvMoney(totals.now.netAfterFixedCents),
    csvMoney(totals.previous.netAfterFixedCents), "", totals.skipped.length ? `sans taux : ${totals.skipped.join(", ")}` : "",
  ]);
  return csvResponse(`boutiques-${range.from}_${range.to}.csv`, header, body);
}
