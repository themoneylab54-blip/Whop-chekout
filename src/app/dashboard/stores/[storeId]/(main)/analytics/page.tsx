import Link from "next/link";
import { notFound } from "next/navigation";
import { BarChart3, FlaskConical, Filter, Mail, Megaphone, Percent, Smartphone, Sparkles, Ticket } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { daysAgo } from "@/lib/time";
import { db } from "@/lib/db";
import { experimentResults, storeAnalytics } from "@/lib/analytics";
import { formatMoney } from "@/lib/pricing";
import { Badge, Card, EmptyState, Flash, Label, PageHeader, Select, SubmitButton } from "@/components/ui";
import { startExperimentAction, stopExperimentAction } from "../../../../actions";

const RANGES = { "7d": 7, "30d": 30, "90d": 90 } as const;
type Range = keyof typeof RANGES;
const pct = (v: number) => `${(v * 100).toFixed(1).replace(".", ",")} %`;

export default async function AnalyticsPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ range?: string; ok?: string; error?: string }>;
}) {
  await requireAdmin();
  const { storeId } = await params;
  const sp = await searchParams;
  const range: Range = sp.range && sp.range in RANGES ? (sp.range as Range) : "30d";
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) notFound();
  const since = daysAgo(RANGES[range]);
  const [a, experiment, versions] = await Promise.all([
    storeAnalytics(storeId, since),
    db.experiment.findFirst({ where: { storeId }, orderBy: { startedAt: "desc" } }),
    db.layoutVersion.findMany({ where: { storeId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, label: true } }),
  ]);
  const results = experiment ? await experimentResults(experiment.id) : null;
  const expVersion = experiment ? versions.find((v) => v.id === experiment.versionId) : null;
  const money = (c: number) => formatMoney(c, store.shopCurrency);
  const top = Math.max(1, a.funnel[0]?.count ?? 1);

  return (
    <>
      <PageHeader
        icon={BarChart3}
        iconColor="#8b5cf6"
        title="Analytics"
        description="Où vos clients décrochent, d'où viennent vos ventes, et ce que rapportent vos leviers."
        actions={
          <div className="flex rounded-lg bg-white p-0.5 text-sm shadow-[var(--shadow-card)]">
            {(Object.keys(RANGES) as Range[]).map((r) => (
              <Link key={r} href={`?range=${r}`} className={`rounded-md px-3 py-1 ${r === range ? "bg-zinc-900 font-medium text-white" : "text-zinc-600 hover:text-zinc-900"}`}>
                {RANGES[r]} j
              </Link>
            ))}
          </div>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat label="Chiffre d'affaires" value={money(a.revenueCents)} hint={`${a.orders} commande${a.orders > 1 ? "s" : ""}`} />
        <Stat label="Conversion" value={pct(a.cvr)} hint={`${a.sessions} checkouts ouverts`} />
        <Stat label="Panier moyen" value={a.orders ? money(a.aovCents) : "—"} hint="après remboursements" />
        <Stat
          label="Revenus additionnels"
          value={money(a.upsell.revenueCents + a.recovery.revenueCents + a.addOns.reduce((s, x) => s + x.revenueCents, 0))}
          hint="options + offres post-achat + relances"
        />
      </div>

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
                      {i > 0 && prev > 0 && drop > 0 && <span className="ml-2 text-xs text-red-500">−{pct(drop)}</span>}
                    </span>
                  </div>
                  <div className="h-2.5 overflow-hidden rounded-full bg-zinc-100">
                    <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500" style={{ width: `${Math.max(2, (step.count / top) * 100)}%` }} />
                  </div>
                </li>
              );
            })}
          </ol>
          <div className="mt-5 grid grid-cols-2 gap-3 border-t border-zinc-100 pt-4 text-sm">
            <Mini icon={Smartphone} label="Mobile" value={`${a.devices.mobile} · ${pct(a.devices.mobileCvr)}`} />
            <Mini icon={BarChart3} label="Ordinateur" value={`${a.devices.desktop} · ${pct(a.devices.desktopCvr)}`} />
          </div>
        </Card>

        <Card icon={Megaphone} iconColor="#f97316" title="Ventes par source (UTM)" description="Source et campagne capturées sur la boutique au moment du clic sur « Paiement ».">
          {a.sources.length === 0 ? (
            <EmptyState icon={Megaphone} title="Pas encore de données" />
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="pb-2 font-medium">Source / campagne</th>
                  <th className="pb-2 text-right font-medium">Conv.</th>
                  <th className="pb-2 text-right font-medium">CA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {a.sources.map((r) => (
                  <tr key={`${r.source}|${r.campaign}`}>
                    <td className="py-2 pr-2">
                      <span className="block font-medium">{r.source}</span>
                      <span className="text-xs text-zinc-500">{r.campaign}</span>
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {r.orders}/{r.sessions}
                    </td>
                    <td className="py-2 text-right font-medium tabular-nums">{money(r.revenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card icon={Sparkles} iconColor="#a855f7" title="Leviers de panier moyen">
          <div className="grid grid-cols-2 gap-3">
            <Mini icon={Sparkles} label="Offre post-achat" value={`${a.upsell.accepted}/${a.upsell.offered} · ${money(a.upsell.revenueCents)}`} />
            <Mini icon={Mail} label="Paniers récupérés" value={`${a.recovery.recovered}/${a.recovery.emailed} · ${money(a.recovery.revenueCents)}`} />
          </div>
          <p className="mt-4 mb-2 text-xs font-semibold tracking-wide text-zinc-500 uppercase">Options (order bumps)</p>
          {a.addOns.length === 0 ? (
            <p className="text-sm text-zinc-500">Aucune option vendue sur la période.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {a.addOns.map((x) => (
                <li key={x.id} className="flex items-center justify-between gap-3">
                  <span className="truncate">{x.title}</span>
                  <span className="shrink-0 tabular-nums text-zinc-600">
                    {pct(x.attachRate)} · <span className="font-medium text-zinc-900">{money(x.revenueCents)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card icon={Ticket} iconColor="#10b981" title="Codes promo">
          {a.codes.length === 0 ? (
            <p className="text-sm text-zinc-500">Aucun code utilisé sur la période.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-zinc-500">
                <tr>
                  <th className="pb-2 font-medium">Code</th>
                  <th className="pb-2 text-right font-medium">Cmd</th>
                  <th className="pb-2 text-right font-medium">Remise</th>
                  <th className="pb-2 text-right font-medium">CA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                {a.codes.map((c) => (
                  <tr key={c.code}>
                    <td className="py-2 font-mono text-xs">{c.code}</td>
                    <td className="py-2 text-right tabular-nums">{c.orders}</td>
                    <td className="py-2 text-right tabular-nums text-red-600">−{money(c.discountCents)}</td>
                    <td className="py-2 text-right font-medium tabular-nums">{money(c.revenueCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card
        icon={FlaskConical}
        iconColor="#0ea5e9"
        title="Test A/B du design"
        description="Comparez le design publié (A) à une version de l'historique (B) sur une partie des nouveaux checkouts."
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
                    {v.orders}/{v.sessions} · {money(Math.round(v.rpv))} par visiteur · {money(v.revenueCents)}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-3 text-sm">
              B vs A : <strong className={results.lift >= 0 ? "text-emerald-600" : "text-red-600"}>{results.lift >= 0 ? "+" : ""}{pct(results.lift)}</strong> de conversion ·
              confiance <strong>{pct(results.confidence)}</strong>{" "}
              <span className="text-zinc-500">{results.confidence >= 0.95 ? "(résultat fiable)" : "(attendez plus de données : visez 95 %)"}</span>
            </p>
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
                  {[10, 20, 30, 50].map((n) => (
                    <option key={n} value={n}>
                      {n} %
                    </option>
                  ))}
                </Select>
              </div>
              <SubmitButton>
                <Percent className="h-4 w-4" /> Lancer le test
              </SubmitButton>
            </form>
          ))}
      </Card>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-[var(--shadow-card)]">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
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
