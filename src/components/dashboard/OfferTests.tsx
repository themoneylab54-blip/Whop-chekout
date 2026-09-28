import { Badge, SubmitButton } from "@/components/ui";
import { DataTable, int, pct } from "@/components/dashboard/AnalyticsKit";
import type { Analytics } from "@/lib/analytics";

type Test = Analytics["offerTests"][number];

const signedPct = (v: number) => new Intl.NumberFormat("fr-FR", { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(v);
/** "≈ 12 j restants"; beyond a year at the current traffic, say so instead of a meaningless figure. */
const remaining = (d: number | null, what: string) => (d == null || d <= 0 ? "" : d > 365 ? ` · plus d'un an ${what} au rythme actuel` : ` · ≈ ${int(d)} j ${what}`);
const pValue = (p: number) => (p < 0.001 ? "< 0,001" : new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3 }).format(p));

/** Verdict of an offer test, in the words of the design tests. */
function verdict(t: Test): { label: string; color: "green" | "red" | "amber" | "zinc" | "blue"; detail: string } {
  const d = t.decision;
  switch (d.kind) {
    case "broken":
      return { label: "Répartition anormale", color: "red", detail: "Les affichages A/B ne respectent pas la répartition réglée : résultat non fiable (vérifiez la page de remerciement)." };
    case "waiting":
      return d.reason === "too_early"
        ? { label: "Trop tôt", color: "zinc", detail: `7 jours minimum avant de conclure (${int(Math.floor(t.ageDays))} j).` }
        : {
            label: "Échantillon insuffisant",
            color: "zinc",
            detail: `${int(Math.min(t.a.impressions, t.b.impressions))} / ${int(t.minSample)} affichages minimum par version${remaining(t.remainingDays, "restants")}.`,
          };
    case "inconclusive":
      return {
        label: "Pas d'écart significatif",
        color: "amber",
        detail: `p = ${pValue(t.pValue)} (seuil ${pValue(d.threshold)})${remaining(t.remainingDays, "pour détecter +10 %")}.`,
      };
    case "tradeoff":
      return { label: `Compromis (${d.better} rapporte plus)`, color: "amber", detail: `${d.better} rapporte plus par affichage mais est acceptée nettement moins souvent : à trancher vous-même.` };
    case "winner":
      return { label: `${d.winner} gagne`, color: "green", detail: `Écart significatif (p = ${pValue(t.pValue)} < ${pValue(d.threshold)}).` };
  }
}

/**
 * Statistics of the offer A/B tests (same engine as the design tests): take rate and CA HT per
 * impression per arm, relative lift with its 95 % CI, p-value, sample needed and verdict, with
 * "Promouvoir B" / "Garder A" while the test is live.
 */
export function OfferTestsTable({
  tests,
  money,
  endAction,
  back,
}: {
  tests: Test[];
  money: (cents: number) => string;
  endAction: (offerId: string, keep: "A" | "B") => (fd: FormData) => Promise<void>;
  back: string;
}) {
  if (!tests.length) return null;
  return (
    <div className="mt-5">
      <p className="mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Tests A/B des offres</p>
      <DataTable
        caption="Tests A/B des offres post-achat"
        columns={[
          { label: "Offre" },
          { label: "Taux A → B", info: "Offres acceptées ÷ affichages de chaque version (commandes payées de la période)." },
          { label: "Par vue A → B", info: "Marge par affichage (CA HT net des remboursements − coût produit × quantité − frais Whop) quand le coût de chaque offre acceptée est connu, sinon CA HT net par affichage. La ligne « décide sur » indique laquelle tranche le test." },
          { label: "Écart B", info: "Écart relatif de la métrique qui décide (marge ou CA HT par affichage) de B par rapport à A, avec son intervalle de confiance à 95 %." },
          { label: "p", info: "Probabilité d'observer un tel écart si les deux versions se valaient (test de Welch). Seuil : 0,001 avant 14 jours, 0,01 ensuite." },
          { label: "Verdict", align: "left" },
        ]}
        minWidth={760}
        empty="Aucun test d'offre sur la période."
        rows={tests.map((t) => {
          const v = verdict(t);
          return {
            key: t.offerId,
            cells: [
              <span key="t" className="block min-w-0">
                <span className="block truncate font-medium" title={t.offerTitle}>
                  {t.offerTitle}
                </span>
                <span className="text-xs text-zinc-500">
                  {int(t.a.impressions)} / {int(t.b.impressions)} vues · B à {t.split} %{t.autoPromote ? " · auto" : ""}
                </span>
              </span>,
              `${pct(t.a.takeRate)} → ${pct(t.b.takeRate)}`,
              <span key="m" className="block">
                {t.metric === "profit" && t.a.profitPerImpressionCents != null && t.b.profitPerImpressionCents != null ? (
                  <>
                    <span className="block">
                      {money(t.a.profitPerImpressionCents)} → {money(t.b.profitPerImpressionCents)} <span className="text-xs text-zinc-500">marge</span>
                    </span>
                    <span className="block text-xs text-zinc-500">
                      CA HT {money(t.a.revenuePerImpressionHtCents)} → {money(t.b.revenuePerImpressionHtCents)}
                    </span>
                  </>
                ) : (
                  <span className="block">
                    {money(t.a.revenuePerImpressionHtCents)} → {money(t.b.revenuePerImpressionHtCents)} <span className="text-xs text-zinc-500">CA HT</span>
                  </span>
                )}
                <Badge color={t.metric === "profit" ? "green" : "zinc"} dot={false}>
                  {t.metric === "profit" ? "Décide sur la marge" : "Décide sur le CA HT"}
                </Badge>
                {t.metric === "revenue" && t.uncostedTakes > 0 && (
                  <span className="mt-0.5 block text-xs text-amber-700">{int(t.uncostedTakes)} offre(s) acceptée(s) sans coût produit</span>
                )}
              </span>,
              <span key="l" className="block">
                <span className={t.decision.kind === "winner" ? (t.lift > 0 ? "font-medium text-emerald-700" : "font-medium text-rose-700") : ""}>{signedPct(t.lift)}</span>
                <span className="block text-xs text-zinc-500">{t.ci ? `IC 95 % : ${signedPct(t.ci[0])} à ${signedPct(t.ci[1])}` : "IC : données insuffisantes"}</span>
              </span>,
              pValue(t.pValue),
              <span key="v" className="block min-w-[14rem] whitespace-normal">
                <Badge color={v.color} dot={false}>
                  {v.label}
                </Badge>
                <span className="mt-1 block text-xs text-zinc-600">{v.detail}</span>
                {t.live ? (
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    <form action={endAction(t.offerId, "B")}>
                      <input type="hidden" name="back" value={back} />
                      <SubmitButton size="sm" variant={t.decision.kind === "winner" && t.decision.winner === "B" ? undefined : "secondary"} className="min-h-8">
                        Promouvoir B
                      </SubmitButton>
                    </form>
                    <form action={endAction(t.offerId, "A")}>
                      <input type="hidden" name="back" value={back} />
                      <SubmitButton size="sm" variant="secondary" className="min-h-8">
                        Garder A
                      </SubmitButton>
                    </form>
                  </span>
                ) : (
                  <span className="mt-1 block text-xs text-zinc-500">Test arrêté.</span>
                )}
              </span>,
            ],
          };
        })}
      />
      <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
        Même règle que les tests de design : au moins 7 jours et {int(tests[0].minSample)} affichages par version, puis un écart significatif de la métrique qui
        décide : la marge par affichage (CA HT − coût produit × quantité − frais Whop, estimés à 3 % tant que Whop ne les a pas transmis) dès que chaque offre acceptée a un coût
        produit, sinon le CA HT par affichage (renseignez les coûts dans « Coûts produits » pour décider sur la marge). « Promouvoir B »
        fait de la variante B l&apos;offre (produit, prix, textes et leurs traductions) et arrête le test ; « Garder A » l&apos;arrête sans rien changer d&apos;autre.
      </p>
    </div>
  );
}
