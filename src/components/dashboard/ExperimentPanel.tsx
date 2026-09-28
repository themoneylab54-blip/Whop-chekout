import type { Experiment } from "@prisma/client";
import { AlertTriangle, CheckCircle2, Clock, FlaskConical, History, Paintbrush, Percent, Scale } from "lucide-react";
import type { ExperimentHistoryItem, ExperimentResults } from "@/lib/analytics";
import { CVR_TRADEOFF, EARLY_DAYS, MDE, MIN_TEST_DAYS, MIN_VISITORS_PER_VARIANT, PRIMARY_METRIC_LABEL } from "@/lib/experiments";
import Link from "next/link";
import { Badge, Card, EmptyState, Label, Select, SubmitButton, buttonClass } from "@/components/ui";
import { ConfirmButton } from "./ConfirmButton";
import { DataTable, InfoTip, formatChange, int, pct } from "./AnalyticsKit";
import { formatCents, formatDate } from "./format";
import { startExperimentAction, stopExperimentAction } from "@/app/dashboard/actions";
import { setExperimentMetricAction } from "@/app/dashboard/stores/[storeId]/(main)/analytics/actions";

const p3 = (p: number) => (p < 0.001 ? "< 0,001" : new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(p));

function Lift({ v }: { v: number }) {
  const { text, sign } = formatChange(v);
  return <strong className={sign > 0 ? "text-emerald-700" : sign < 0 ? "text-rose-700" : "text-zinc-700"}>{text}</strong>;
}

function Ci({ ci }: { ci: [number, number] | null }) {
  if (!ci) return <span className="text-zinc-500">intervalle indisponible</span>;
  return (
    <span className="text-zinc-600 tabular-nums">
      IC 95 % [{formatChange(ci[0]).text} ; {formatChange(ci[1]).text}]
    </span>
  );
}

const OUTCOME: Record<ExperimentHistoryItem["outcome"], [string, "green" | "zinc" | "amber" | "blue"]> = {
  b_published: ["B publiée", "green"],
  a_kept: ["A conservée", "zinc"],
  b_not_applied: ["B gagnante, non appliquée", "amber"],
  stopped: ["Arrêté", "zinc"],
};

export function ExperimentPanel({
  storeId,
  currency,
  experiment,
  results,
  versionLabel,
  versions,
  history,
  tz,
  back,
}: {
  /** The store's time zone (dates). */
  tz?: string;
  /** This page's link (period, filters, tab): the metric form comes back to it. */
  back?: string;
  storeId: string;
  currency: string;
  experiment: Experiment | null;
  results: ExperimentResults | null;
  versionLabel?: string | null;
  versions: { id: string; label: string }[];
  history: ExperimentHistoryItem[];
}) {
  const money = (c: number) => formatCents(Math.round(c), currency);
  const running = experiment?.status === "RUNNING" ? experiment : null;
  return (
    <Card
      icon={FlaskConical}
      iconColor="#0ea5e9"
      title={
        <>
          Test A/B du design{" "}
          <InfoTip label="À propos des tests A/B">
            Le design publié au lancement (A) contre une version de l&apos;historique (B) : checkout, page de remerciement et offres post-achat. Chaque visiteur garde sa variante ; les
            résultats sont comptés par visiteur unique (commandes test exclues). Deux variantes seulement : les tests à plusieurs variantes (A/B/C…) ne sont pas pris en charge.
          </InfoTip>
        </>
      }
      description="Deux variantes (A contre B), résultats par visiteur unique."
    >
      {running && results && (
        <div className="mb-6">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="font-medium">{running.name}</span>
            <Badge color="green">En cours · B = {running.splitB} %</Badge>
            {versionLabel && <span className="text-xs text-zinc-500">B : {versionLabel}</span>}
            <span className="text-xs text-zinc-500">
              depuis le {formatDate(running.startedAt, tz)} ({int(Math.floor(results.ageDays))} j)
            </span>
          </div>
          <form action={setExperimentMetricAction.bind(null, storeId, running.id)} className="mb-3 flex flex-wrap items-center gap-2 text-sm">
            {back && <input type="hidden" name="back" value={back} />}
            <label htmlFor="ab-metric" className="text-zinc-600">
              Métrique principale
            </label>
            <select id="ab-metric" name="metric" defaultValue={results.metric} className="min-h-9 rounded-lg border border-zinc-200 bg-white px-2 text-sm">
              <option value="profit">Marge par visiteur (HT, après coûts)</option>
              <option value="revenue">CA par visiteur (TTC)</option>
            </select>
            <SubmitButton size="sm" variant="secondary">
              Appliquer
            </SubmitButton>
            {!results.metricChosen && <span className="text-xs text-zinc-500">par défaut : {results.costsComplete ? "coûts complets, la marge décide" : "coûts incomplets, le CA décide"}</span>}
          </form>
          <ResultsView results={results} money={money} />
          <div className="mt-4 flex flex-wrap gap-2">
            <form action={stopExperimentAction.bind(null, storeId, running.id, true)}>
              <ConfirmButton size="sm" variant="secondary" tone="default" title="Publier la variante B pour tous les clients ?" description="Le test s'arrête et le design B devient le design publié." confirmLabel="Publier B">
                Publier B pour tous
              </ConfirmButton>
            </form>
            <form action={stopExperimentAction.bind(null, storeId, running.id, false)}>
              <SubmitButton size="sm" variant="secondary">
                Arrêter (garder A)
              </SubmitButton>
            </form>
          </div>
        </div>
      )}

      {!running &&
        (versions.length === 0 ? (
          <div className="flex flex-col items-center pb-2">
            <EmptyState icon={FlaskConical} title="Aucune version à tester pour l'instant">
              Chaque publication depuis l&apos;éditeur crée une version du design. Publiez une variante (nouveau titre, autre offre, autre ordre des blocs…) pour la tester contre le design
              actuel.
            </EmptyState>
            <Link href={`/dashboard/stores/${storeId}/builder/checkout`} className={`${buttonClass("primary")} -mt-6`}>
              <Paintbrush className="h-4 w-4" aria-hidden /> Ouvrir l&apos;éditeur du checkout
            </Link>
          </div>
        ) : (
          <form action={startExperimentAction.bind(null, storeId)} className="grid grid-cols-[minmax(0,1fr)] gap-3 sm:grid-cols-[1fr_160px_auto] sm:items-end">
            <div>
              <Label htmlFor="versionId">Variante B</Label>
              <Select id="versionId" name="versionId" required defaultValue="">
                <option value="" disabled>
                  Choisir une version…
                </option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="split">Part de trafic B</Label>
              <Select id="split" name="split" defaultValue="50">
                {[10, 20, 30, 50].map((x) => (
                  <option key={x} value={x}>
                    {x} %
                  </option>
                ))}
              </Select>
            </div>
            <SubmitButton>
              <Percent className="h-4 w-4" /> Lancer le test
            </SubmitButton>
            <label className="flex items-start gap-2 text-sm text-zinc-600 sm:col-span-3">
              <input type="checkbox" name="autoPromote" className="mt-0.5 h-4 w-4 shrink-0 accent-indigo-600" />
              <span>
                Décider automatiquement : après {MIN_TEST_DAYS} jours minimum, {MIN_VISITORS_PER_VARIANT} visiteurs par variante et un résultat très fiable sur la métrique principale (marge
                par visiteur si tous les coûts sont connus, sinon CA par visiteur ; p &lt; 0,001 avant {EARLY_DAYS} jours, p &lt; 0,01 ensuite), publier le gagnant comme nouvelle version
                « Gagnant » et arrêter le test. Si la variante la plus rentable convertit plus de {pct(CVR_TRADEOFF, 0)} moins bien, rien n&apos;est décidé automatiquement. Si vous
                publiez un autre design pendant le test, rien n&apos;est remplacé : vous êtes prévenu.
              </span>
            </label>
          </form>
        ))}

      {history.length > 0 && (
        <div className="mt-6 border-t border-zinc-100 pt-4">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-zinc-500 uppercase">
            <History className="h-3.5 w-3.5" aria-hidden /> Tests précédents
          </p>
          <DataTable
            caption="Historique des tests A/B"
            columns={[{ label: "Test" }, { label: "Période", hideBelow: "sm" }, { label: "Visiteurs" }, { label: "Métrique" }, { label: "B vs A" }, { label: "p" }, { label: "Issue" }]}
            minWidth={520}
            empty=""
            rows={history.map((h) => ({
              key: h.id,
              cells: [
                <span key="n" className="font-medium">
                  {h.name}
                </span>,
                `${formatDate(h.startedAt, tz)} → ${h.endedAt ? formatDate(h.endedAt, tz) : "…"}`,
                int(h.visitors),
                h.metric === "profit" ? "Marge / visiteur" : "CA / visiteur",
                <Lift key="l" v={h.lift} />,
                p3(h.pValue),
                <Badge key="o" color={OUTCOME[h.outcome][1]}>
                  {OUTCOME[h.outcome][0]}
                </Badge>,
              ],
            }))}
          />
        </div>
      )}
    </Card>
  );
}

function ResultsView({ results, money }: { results: ExperimentResults; money: (c: number) => string }) {
  const [a, b] = results.stats;
  const v = results.verdict;
  const d = results.decision;
  const row = (label: string, f: (s: typeof a) => string) => ({ key: label, cells: [label, f(a), f(b)] });
  return (
    <div className="max-w-3xl">
      <DataTable
        caption="Résultats par variante"
        columns={[{ label: "Par variante" }, { label: "A (contrôle)" }, { label: "B" }]}
        empty=""
        rows={[
          row("Visiteurs uniques", (s) => int(s.visitors)),
          row("Conversion (visiteurs)", (s) => pct(s.cvr, 2)),
          row("Commandes", (s) => int(s.orders)),
          row("Panier moyen (net TTC)", (s) => (s.orders ? money(s.aovCents ?? 0) : "—")),
          row(`CA par visiteur*${results.metric === "revenue" ? " (principale)" : ""}`, (s) => money(s.rpv)),
          row(`Marge par visiteur (HT)**${results.metric === "profit" ? " (principale)" : ""}`, (s) => money(s.ppv ?? 0)),
          row("Taux d'acceptation offres", (s) => (s.offerTakeRate == null ? "—" : pct(s.offerTakeRate))),
          row("Conversion mobile", (s) => (s.mobile?.visitors ? `${pct(s.mobile.cvr, 1)} · ${int(s.mobile.visitors)}` : "—")),
          row("Conversion ordinateur", (s) => (s.desktop?.visitors ? `${pct(s.desktop.cvr, 1)} · ${int(s.desktop.visitors)}` : "—")),
        ]}
      />
      <p className="mt-1.5 text-[11px] text-zinc-500">
        * CA net TTC par visiteur, écrêté au 99ᵉ centile des acheteurs{results.capCents != null ? ` (${money(results.capCents)})` : ""} pour qu&apos;une commande exceptionnelle ne décide pas du test.
        <br />
        ** Marge nette HT par visiteur (après frais Whop, coûts et litiges, comme dans Analytics), écrêtée aux 1ᵉʳ et 99ᵉ centiles des acheteurs
        {results.profitCapCents ? ` (${money(results.profitCapCents[0])} à ${money(results.profitCapCents[1])})` : ""}
        {results.costsComplete ? "." : " — estimée : certains coûts sont inconnus."}
      </p>

      <div className="mt-4 space-y-1.5 text-sm">
        <p>
          Conversion B vs A : <Lift v={v.cvrLift} /> · <Ci ci={v.cvrLiftCi} /> · p = {p3(v.cvrPValue)}
        </p>
        <p>
          CA par visiteur B vs A : <Lift v={v.rpvLift} /> · <Ci ci={v.rpvLiftCi} /> · p = {p3(v.rpvPValue)}
        </p>
        <p>
          Marge par visiteur B vs A : <Lift v={v.ppvLift} /> · <Ci ci={v.ppvLiftCi} /> · p = {p3(v.ppvPValue)}
        </p>
      </div>

      <div
        className={`mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm ${
          d.kind === "broken" ? "bg-red-50 text-red-800" : d.kind === "winner" ? "bg-emerald-50 text-emerald-900" : d.kind === "tradeoff" ? "bg-amber-50 text-amber-900" : "bg-zinc-50 text-zinc-700"
        }`}
        role="status"
      >
        {d.kind === "broken" ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        ) : d.kind === "winner" ? (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        ) : d.kind === "tradeoff" ? (
          <Scale className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <Clock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        )}
        <span>
          {d.kind === "broken" && "La répartition observée ne correspond pas à la part choisie : un problème d'affectation fausse les résultats. Relancez le test."}
          {d.kind === "waiting" &&
            (d.reason === "too_early"
              ? `Trop tôt pour conclure : attendez au moins ${MIN_TEST_DAYS} jours (cycle semaine / week-end complet).`
              : `Pas encore assez de visiteurs : ${MIN_VISITORS_PER_VARIANT} minimum par variante avant toute décision.`)}
          {d.kind === "inconclusive" &&
            `Pas encore de gagnant : l'écart de ${PRIMARY_METRIC_LABEL[d.metric]} n'est pas assez fiable (seuil p < ${p3(d.threshold).replace("< ", "")}${results.ageDays < EARLY_DAYS ? ` tant que le test a moins de ${EARLY_DAYS} jours` : ""}).`}
          {d.kind === "winner" &&
            (d.winner === "B"
              ? `Verdict : la variante B gagne sur la ${PRIMARY_METRIC_LABEL[d.metric]} (même règle que la décision automatique, seuil p < ${p3(d.threshold).replace("< ", "")}).`
              : `Verdict : la variante A reste meilleure sur la ${PRIMARY_METRIC_LABEL[d.metric]} (seuil p < ${p3(d.threshold).replace("< ", "")}). Gardez A.`)}
          {d.kind === "tradeoff" &&
            `Compromis — pas de gagnant automatique : ${d.better} est nettement meilleure sur la ${PRIMARY_METRIC_LABEL[d.metric]}, mais convertit plus de ${pct(CVR_TRADEOFF, 0)} moins bien que ${d.better === "B" ? "A" : "B"}. Rien n'est publié automatiquement : choisissez selon votre priorité (marge ou volume de clients).`}
          {d.kind !== "winner" && d.kind !== "broken" && d.kind !== "tradeoff" && results.remainingDays != null && (
            <span className="mt-1 block text-xs text-zinc-600">
              {results.remainingDays > 365
                ? `Au rythme actuel, il faudrait plus d'un an pour détecter un écart de ${pct(MDE, 0)} de la métrique principale : testez un changement plus fort, ou envoyez plus de trafic.`
                : results.remainingDays === 0
                ? `Échantillon suffisant pour détecter un écart de ${pct(MDE, 0)} de la métrique principale : s'il n'y a pas de gagnant, les deux designs se valent probablement.`
                : `Encore environ ${int(results.remainingDays)} jour(s) au rythme actuel pour pouvoir détecter un écart de ${pct(MDE, 0)} de la métrique principale (puissance 80 %).`}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
