import Link from "next/link";
import { notFound } from "next/navigation";
import { BarChart3, CreditCard, Download, FlaskConical, Filter, Globe2, Megaphone, Package, Percent, ShieldAlert, Smartphone, Sparkles, Ticket } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { experimentResults, storeAnalytics } from "@/lib/analytics";
import { MIN_VISITORS_PER_VARIANT } from "@/lib/experiments";
import { formatMoney } from "@/lib/pricing";
import { daysAgo, lastDays } from "@/lib/time";
import { Badge, Card, EmptyState, Flash, Label, PageHeader, Select, SubmitButton } from "@/components/ui";
import { RevenueChart } from "@/components/dashboard/RevenueChart";
import { startExperimentAction, stopExperimentAction } from "../../../../actions";

const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
type Range = keyof typeof RANGES;
const pct = (v: number, digits = 1) => `${(v * 100).toFixed(digits).replace(".", ",")} %`;
const METHOD_LABELS: Record<string, string> = {
  card: "Carte",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  paypal: "PayPal",
  klarna: "Klarna",
  alma: "Alma",
  oney_3x: "Oney 3x",
  oney_4x: "Oney 4x",
  bancontact: "Bancontact",
  ideal: "iDEAL",
  sepa_debit: "SEPA",
  scalapay: "Scalapay",
  twint: "TWINT",
  eps: "EPS",
  p24: "Przelewy24",
  blik: "BLIK",
  multibanco: "Multibanco",
  mb_way: "MB WAY",
  satispay: "Satispay",
  revolut_pay: "Revolut Pay",
  klarna_pay_now: "Klarna",
  card_installments_three: "Carte 3x",
  inconnu: "Non précisé",
};

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ range?: string; test?: string; ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const { storeId } = await params;
  const sp = await searchParams;
  const range: Range = sp.range && sp.range in RANGES ? (sp.range as Range) : "30d";
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) notFound();
  // In test mode everything is a test order: show them, otherwise hide them by default.
  const includeTest = sp.test === "1" || (sp.test !== "0" && store.testMode);
  const [a, experiment, versions] = await Promise.all([
    storeAnalytics(storeId, { since: daysAgo(RANGES[range]), until: daysAgo(0), includeTest }),
    db.experiment.findFirst({ where: { storeId }, orderBy: { startedAt: "desc" } }),
    db.layoutVersion.findMany({ where: { storeId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, label: true } }),
  ]);
  const results = experiment ? await experimentResults(experiment) : null;
  const expVersion = experiment ? versions.find((v) => v.id === experiment.versionId) : null;
  const money = (c: number) => formatMoney(c, store.shopCurrency);
  const top = Math.max(1, a.funnel[0]?.count ?? 1);
  const q = (p: Record<string, string>) => `?${new URLSearchParams({ range, ...(sp.test ? { test: sp.test } : {}), ...p })}`;
  // Every day of the period, zero-filled: days without sales are part of the picture.
  const byDay = new Map(a.daily.map((d) => [d.day, d]));
  const points = lastDays(RANGES[range]).map((day) => ({
    date: day,
    label: new Date(`${day}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }),
    cents: byDay.get(day)?.revenueCents ?? 0,
    orders: byDay.get(day)?.orders ?? 0,
  }));

  return (
    <>
      <PageHeader
        icon={BarChart3}
        iconColor="#8b5cf6"
        title="Analytics"
        description="Où vos clients décrochent, d'où viennent vos ventes, et ce que rapportent vos leviers."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={q({ test: includeTest ? "0" : "1" })}
              className={`rounded-lg px-3 py-1.5 text-sm shadow-[var(--shadow-card)] ${includeTest ? "bg-amber-50 text-amber-900" : "bg-white text-zinc-600"}`}
            >
              {includeTest ? "Commandes test incluses" : "Commandes réelles"}
            </Link>
            <div className="flex rounded-lg bg-white p-0.5 text-sm shadow-[var(--shadow-card)]">
              {(Object.keys(RANGES) as Range[]).map((r) => (
                <Link key={r} href={q({ range: r })} className={`rounded-md px-3 py-1 ${r === range ? "bg-zinc-900 font-medium text-white" : "text-zinc-600 hover:text-zinc-900"}`}>
                  {RANGES[r]} j
                </Link>
              ))}
            </div>
            <a
              href={`/dashboard/stores/${storeId}/orders/export?days=${RANGES[range]}${includeTest ? "&test=1" : ""}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-sm shadow-[var(--shadow-card)] hover:bg-zinc-50"
            >
              <Download className="h-3.5 w-3.5" /> CSV
            </a>
          </div>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat
          label="Chiffre d'affaires net"
          value={money(a.revenueCents)}
          now={a.revenueCents}
          before={a.previous.revenueCents}
          hint={`dont ${money(a.upsellRevenueCents)} d'offres · frais Whop ${a.feesKnown ? "" : "≥ "}${money(a.feesCents)}`}
        />
        <Stat label="Commandes" value={String(a.orders)} now={a.orders} before={a.previous.orders} hint={`${a.visitors} visiteurs uniques`} />
        <Stat label="Conversion" value={pct(a.cvr)} now={a.cvr} before={a.previous.cvr} hint={`${a.sessions} checkouts ouverts`} />
        <Stat
          label="Panier moyen"
          value={a.orders ? money(a.aovCents) : "—"}
          now={a.aovCents}
          before={a.previous.aovCents}
          hint={a.feesCents ? `après frais Whop : ${money(Math.round((a.revenueCents - a.feesCents) / Math.max(1, a.orders)))}` : "net, offres comprises"}
        />
      </div>

      <Card icon={BarChart3} iconColor="#6366f1" title="Chiffre d'affaires par jour" className="mb-6">
        {a.orders ? <RevenueChart points={points} currency={store.shopCurrency} /> : <EmptyState icon={BarChart3} title="Pas encore de ventes sur la période" />}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card icon={Filter} iconColor="#6366f1" title="Entonnoir du checkout" description="Une commande payée compte comme ayant franchi toutes les étapes (paiement express inclus).">
          <ol className="space-y-3">
            {a.funnel.map((step, i) => {
              const prev = i > 0 ? a.funnel[i - 1].count : step.count;
              const drop = prev > 0 ? 1 - step.count / prev : 0;
              return (
                <li key={step.key}>
                  <div className="mb-1 flex items-baseline justify-between text-sm">
                    <span className="font-medium">{step.label}</span>
                    <span className="tabular-nums">
                      {step.count}
                      {i > 0 && drop > 0 && <span className="ml-2 text-xs text-red-500">−{pct(drop)}</span>}
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-zinc-100">
                    <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${Math.max(2, (step.count / top) * 100)}%` }} />
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="mt-5 grid grid-cols-3 gap-3 border-t border-zinc-100 pt-4 text-sm">
            <Mini icon={ShieldAlert} label="Paiements refusés" value={String(a.failedPayments)} />
            <Mini icon={Smartphone} label="Mobile" value={`${a.devices.mobile} · ${pct(a.devices.mobileCvr)}`} />
            <Mini icon={BarChart3} label="Ordinateur" value={`${a.devices.desktop} · ${pct(a.devices.desktopCvr)}`} />
          </div>
        </Card>

        <Card icon={Megaphone} iconColor="#f97316" title="Ventes par source (UTM)" description="Source et campagne capturées sur la boutique au clic sur « Paiement ».">
          <Table
            empty="Pas encore de données"
            head={["Source / campagne", "Conv.", "CA"]}
            rows={a.sources.map((r) => [
              <span key="s">
                <span className="block font-medium">{r.source}</span>
                <span className="text-xs text-zinc-500">{r.campaign}</span>
              </span>,
              `${r.orders}/${r.sessions}`,
              money(r.revenueCents),
            ])}
          />
        </Card>

        <Card icon={Package} iconColor="#0ea5e9" title="Produits">
          <Table empty="Aucune vente sur la période" head={["Produit", "Unités", "CA brut"]} rows={a.products.map((r) => [r.title, String(r.units), money(r.revenueCents)])} />
        </Card>

        <Card icon={CreditCard} iconColor="#10b981" title="Moyens de paiement">
          <Table
            empty="Aucune vente sur la période"
            head={["Moyen", "Cmd", "CA"]}
            rows={a.methods.map((r) => [METHOD_LABELS[r.method] ?? r.method, `${r.orders} · ${pct(a.orders ? r.orders / a.orders : 0, 0)}`, money(r.revenueCents)])}
          />
        </Card>

        <Card icon={Sparkles} iconColor="#a855f7" title="Leviers de panier moyen">
          <div className="grid grid-cols-2 gap-3">
            <Mini icon={Sparkles} label="Offre post-achat" value={`${a.upsell.accepted}/${a.upsell.shown} vues · ${pct(a.upsell.shown ? a.upsell.accepted / a.upsell.shown : 0)}`} />
            <Mini icon={Sparkles} label="CA offres post-achat" value={money(a.upsell.revenueCents)} />
          </div>
          <p className="mt-4 mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Options (order bumps)</p>
          <Table empty="Aucune option vendue sur la période." head={["Option", "Taux", "CA"]} rows={a.addOns.map((x) => [x.title, pct(x.attachRate), money(x.revenueCents)])} />
        </Card>

        <Card icon={Ticket} iconColor="#10b981" title="Codes promo">
          <Table
            empty="Aucun code utilisé sur la période."
            head={["Code", "Cmd", "Remise", "CA"]}
            rows={a.codes.map((c) => [<code key="c" className="text-xs">{c.code}</code>, String(c.orders), `−${money(c.discountCents)}`, money(c.revenueCents)])}
          />
        </Card>

        <Card icon={Globe2} iconColor="#6366f1" title="Pays de livraison">
          <Table empty="Aucune vente sur la période" head={["Pays", "Cmd", "CA"]} rows={a.countries.map((c) => [c.country, String(c.orders), money(c.revenueCents)])} />
        </Card>

        <Card icon={ShieldAlert} iconColor="#dc2626" title="Risque" description="À surveiller : au-delà d'environ 0,75 % de litiges, les prestataires de paiement durcissent leurs conditions.">
          <div className="grid grid-cols-2 gap-3">
            <Mini icon={ShieldAlert} label="Taux de litige" value={`${pct(a.risk.disputeRate, 2)} · ${a.risk.disputes}`} />
            <Mini icon={ShieldAlert} label="Taux de remboursement" value={`${pct(a.risk.refundRate)} · ${money(a.risk.refundedCents)}`} />
            <Mini icon={ShieldAlert} label="Paiements à vérifier" value={String(a.risk.reviewHolds)} />
          </div>
        </Card>
      </div>

      <Card
        icon={FlaskConical}
        iconColor="#0ea5e9"
        title="Test A/B du design"
        description="Le design publié au lancement (A) contre une version de l'historique (B). Chaque visiteur garde la même variante ; les résultats sont comptés par visiteur."
        className="mt-6"
      >
        {experiment && results ? (
          <div className="mb-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="font-medium">{experiment.name}</span>
              <Badge color={experiment.status === "RUNNING" ? "green" : "zinc"}>{experiment.status === "RUNNING" ? `En cours · B = ${experiment.splitB} %` : "Terminé"}</Badge>
              {expVersion && <span className="text-xs text-zinc-500">B : {expVersion.label}</span>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {results.stats.map((v) => (
                <div key={v.variant} className="rounded-xl bg-zinc-50 p-4 ring-1 ring-zinc-900/5">
                  <p className="text-xs font-semibold tracking-wide text-zinc-500 uppercase">Variante {v.variant}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{pct(v.cvr)}</p>
                  <p className="text-xs text-zinc-500">
                    {v.visitors} visiteurs · {v.orders} commandes · {money(Math.round(v.rpv))} par visiteur
                  </p>
                </div>
              ))}
            </div>
            <Verdict v={results.verdict} />
            {experiment.status === "RUNNING" && (
              <div className="mt-4 flex flex-wrap gap-2">
                <form action={stopExperimentAction.bind(null, store.id, experiment.id, true)}>
                  <SubmitButton size="sm" confirm="Publier la variante B pour tous les clients ?">
                    Publier B pour tous
                  </SubmitButton>
                </form>
                <form action={stopExperimentAction.bind(null, store.id, experiment.id, false)}>
                  <SubmitButton size="sm" variant="secondary">
                    Arrêter (garder A)
                  </SubmitButton>
                </form>
              </div>
            )}
          </div>
        ) : null}
        {experiment?.status !== "RUNNING" &&
          (versions.length === 0 ? (
            <p className="text-sm text-zinc-500">Publiez au moins un design depuis le builder : chaque publication crée une version testable.</p>
          ) : (
            <form action={startExperimentAction.bind(null, store.id)} className="grid gap-3 sm:grid-cols-[1fr_160px_auto] sm:items-end">
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
              <label className="flex items-center gap-2 text-sm text-zinc-600 sm:col-span-3">
                <input type="checkbox" name="autoPromote" className="h-4 w-4 accent-indigo-600" />
                Décider automatiquement : après 7 jours minimum et un résultat fiable (p &lt; 0,01), publier le gagnant et arrêter le test.
              </label>
            </form>
          ))}
      </Card>
    </>
  );
}

function Verdict({ v }: { v: import("@/lib/experiments").Verdict }) {
  const sig = (p: number) => (p < 0.05 ? "significatif" : "pas encore significatif");
  return (
    <div className="mt-3 space-y-1.5 text-sm">
      {v.sampleRatioMismatch && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-red-800">
          ⚠ La répartition observée ne correspond pas à la part choisie : un problème de répartition fausse les résultats. Relancez le test.
        </p>
      )}
      <p>
        Conversion B vs A : <Lift v={v.cvrLift} /> · p = {v.cvrPValue.toFixed(3)} ({sig(v.cvrPValue)})
      </p>
      <p>
        CA par visiteur B vs A : <Lift v={v.rpvLift} /> · p = {v.rpvPValue.toFixed(3)} ({sig(v.rpvPValue)})
      </p>
      {!v.enoughData && (
        <p className="text-xs text-zinc-500">
          Attendez au moins {MIN_VISITORS_PER_VARIANT} visiteurs par variante (et idéalement 2 semaines complètes) avant de décider : regarder trop tôt fait
          conclure à tort.
        </p>
      )}
    </div>
  );
}

function Lift({ v }: { v: number }) {
  return <strong className={v >= 0 ? "text-emerald-600" : "text-red-600"}>{`${v >= 0 ? "+" : ""}${(v * 100).toFixed(1).replace(".", ",")} %`}</strong>;
}

function Stat({ label, value, hint, now, before }: { label: string; value: string; hint: string; now: number; before: number }) {
  const delta = before > 0 ? (now - before) / before : null;
  return (
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 flex items-baseline gap-2 text-xl font-semibold tracking-tight tabular-nums">
        {value}
        {delta != null && (
          <span className={`text-xs font-medium ${delta >= 0 ? "text-emerald-600" : "text-red-600"}`} title="vs période précédente">
            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta * 100).toFixed(0)} %
          </span>
        )}
      </p>
      <p className="mt-0.5 text-[11px] text-zinc-400">{hint}</p>
    </div>
  );
}

function Mini({ icon: Icon, label, value }: { icon: typeof BarChart3; label: string; value: string }) {
  return (
    <div className="rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-900/5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
        <Icon className="h-3.5 w-3.5" /> {label}
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (!rows.length) return <p className="text-sm text-zinc-500">{empty}</p>;
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-zinc-500">
        <tr>
          {head.map((h, i) => (
            <th key={h} className={`pb-2 font-medium ${i > 0 ? "text-right" : ""}`}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody className="divide-y divide-zinc-100">
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j} className={`py-2 ${j > 0 ? "text-right tabular-nums" : "pr-2"} ${j === r.length - 1 ? "font-medium" : ""}`}>
                {c}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
