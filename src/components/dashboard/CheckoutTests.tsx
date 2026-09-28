import type { CheckoutTest } from "@prisma/client";
import { SlidersHorizontal } from "lucide-react";
import type { ExperimentResults } from "@/lib/analytics";
import { CHECKOUT_TEST_KINDS, MAX_RUNNING_CHECKOUT_TESTS, type CheckoutTestKind } from "@/lib/checkout-tests";
import { MIN_TEST_DAYS, MIN_VISITORS_PER_VARIANT, PRIMARY_METRIC_LABEL } from "@/lib/experiments";
import { Badge, Card, Flash, Input, Label, Select, SubmitButton } from "@/components/ui";
import { ProtectionTestFields } from "./ProtectionTestFields";
import { ConfirmButton } from "./ConfirmButton";
import { DataTable, InfoTip, formatChange, int, pct } from "./AnalyticsKit";
import { formatCents, formatDate } from "./format";
import { endCheckoutTestAction, startCheckoutTestAction } from "@/app/dashboard/stores/[storeId]/(main)/analytics/actions";

const p3 = (p: number) => (p < 0.001 ? "< 0,001" : new Intl.NumberFormat("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(p));

/** Arm settings in words ("2 art. −10 %, 3 art. −15 %", "prix 4,90 €", "masquée"…). */
function describe(kind: string, config: unknown, currency: string): string {
  if (config == null) return "—";
  if (kind === "breaks") {
    const tiers = Array.isArray(config) ? (config as { minQty?: number; percent?: number; kind?: string; type?: string }[]) : [];
    const shown = tiers.filter((t) => t.type !== "gift").map((t) => (t.kind && t.kind !== "percent" ? `dès ${t.minQty} art. (${t.kind})` : `${t.minQty} art. −${t.percent} %`));
    return shown.length ? shown.join(", ") : "aucun palier";
  }
  if (kind === "addon") {
    const c = config as { priceCents?: number; hidden?: boolean };
    return c.hidden ? "option masquée" : c.priceCents != null ? `prix ${formatCents(c.priceCents, currency)}` : "—";
  }
  const c = config as { priceMode?: string; price?: number; percent?: number; minPrice?: number; maxPrice?: number };
  return c.priceMode === "percent"
    ? `${c.percent} % du panier (min ${formatCents(Math.round((c.minPrice ?? 0) * 100), currency)}${c.maxPrice ? `, max ${formatCents(Math.round(c.maxPrice * 100), currency)}` : ""})`
    : `prix fixe ${formatCents(Math.round((c.price ?? 0) * 100), currency)}`;
}

export function CheckoutTestsPanel({
  storeId,
  currency,
  tests,
  addOns,
  tz,
  back,
  flash,
}: {
  /** The store's time zone (dates). */
  tz?: string;
  storeId: string;
  currency: string;
  tests: { test: CheckoutTest; results: ExperimentResults }[];
  addOns: { id: string; title: string; priceCents: number }[];
  /** This page's link (period, filters, tab): the forms come back to it. */
  back?: string;
  /** Outcome of this panel's last form (launch / promote), shown and focused here. */
  flash?: { ok?: string; error?: string };
}) {
  const money = (c: number) => formatCents(Math.round(c), currency);
  const running = tests.filter((t) => t.test.status === "RUNNING");
  const done = tests.filter((t) => t.test.status !== "RUNNING");
  const full = running.length >= MAX_RUNNING_CHECKOUT_TESTS;
  const busy = (kind: CheckoutTestKind) => kind !== "addon" && running.some((t) => t.test.kind === kind);
  return (
    <Card
      id="tests-checkout"
      icon={SlidersHorizontal}
      iconColor="#8b5cf6"
      className="mt-6"
      title={
        <>
          Tests A/B du checkout : remises, options, protection{" "}
          <InfoTip label="À propos des tests du checkout">
            La variante B (autres paliers de remise, autre prix ou option masquée, autre prix de protection colis) est montrée à une part des visiteurs, toujours la même pour un
            visiteur donné. Le gagnant se décide sur la marge par visiteur (après coûts produits, frais Whop et livraison) : une remise plus forte qui vend plus mais rapporte
            moins ne gagne pas. Au moins {MIN_TEST_DAYS} jours et {MIN_VISITORS_PER_VARIANT} visiteurs par variante avant de conclure.
          </InfoTip>
        </>
      }
      description="Chaque test compare deux réglages sur des visiteurs répartis au hasard. « Promouvoir B » applique B à la boutique."
    >
      {flash && <Flash ok={flash.ok} error={flash.error} />}
      {tests.length === 0 && <p className="mb-4 text-sm text-zinc-500">Aucun test du checkout pour l&apos;instant.</p>}
      {tests.length > 0 && (
        <div className="mb-5">
          <DataTable
            caption="Tests A/B du checkout : variantes, visiteurs, conversion et marge par visiteur"
            minWidth={760}
            empty=""
            columns={[
              { label: "Test (A / B)" },
              { label: "Visiteurs A · B" },
              { label: "Conversion A → B" },
              { label: "Marge / visiteur A → B", info: "Marge nette (HT, après coûts produits, options, livraison, frais Whop) des commandes ÷ visiteurs de la variante." },
              { label: "B vs A" },
              { label: "Décision", align: "left" },
            ]}
            rows={[...running, ...done].map(({ test, results: r }) => {
              const [a, b] = r.stats;
              const lift = r.metric === "profit" ? r.verdict.ppvLift : r.verdict.rpvLift;
              const p = r.metric === "profit" ? r.verdict.ppvPValue : r.verdict.rpvPValue;
              // No visitor yet in an arm: no rates to show, only the collection progress.
              const collecting = test.status === "RUNNING" && Math.min(a.visitors, b.visitors) === 0;
              const progress = `Collecte en cours : ${int(Math.min(a.visitors, b.visitors))}/${int(MIN_VISITORS_PER_VARIANT)} visiteurs`;
              const none = (key: string) => (
                <span key={key} className="text-zinc-400">
                  <span aria-hidden>—</span>
                  <span className="sr-only">pas encore de données</span>
                </span>
              );
              return {
                key: test.id,
                muted: test.status !== "RUNNING",
                cells: [
                  <span key="n">
                    <span className="font-medium">{test.name}</span>
                    <span className="block text-xs text-zinc-500">
                      {CHECKOUT_TEST_KINDS[test.kind as CheckoutTestKind] ?? test.kind} · {formatDate(test.startedAt, tz)} · {test.splitB} % en B
                    </span>
                    <span className="block text-xs text-zinc-600">A : {describe(test.kind, test.configA, currency)}</span>
                    <span className="block text-xs text-zinc-600">B : {describe(test.kind, test.configB, currency)}</span>
                  </span>,
                  `${int(a.visitors)} · ${int(b.visitors)}`,
                  collecting ? <span key="c" className="text-xs text-zinc-600">{progress}</span> : `${pct(a.cvr, 1)} → ${pct(b.cvr, 1)}`,
                  collecting ? none("m") : `${money(a.ppv ?? 0)} → ${money(b.ppv ?? 0)}`,
                  collecting ? (
                    none("l")
                  ) : (
                    <span key="l">
                      {formatChange(lift).text}
                      <span className="block text-xs text-zinc-500">
                        {PRIMARY_METRIC_LABEL[r.metric]}, p = {p3(p)}
                      </span>
                    </span>
                  ),
                  <span key="d" className="flex flex-col items-start gap-1.5">
                    {test.status !== "RUNNING" ? (
                      <Badge color={test.winner === "B" ? "green" : "zinc"}>{test.winner === "B" ? "B promue" : "A conservée"}</Badge>
                    ) : r.decision.kind === "winner" ? (
                      <Badge color="green">{r.decision.winner} gagne</Badge>
                    ) : (
                      <Badge color="zinc">{collecting ? "collecte en cours" : "en cours"}</Badge>
                    )}
                    {!r.costsComplete && <span className="text-xs text-zinc-500">coûts incomplets : décision sur le CA</span>}
                    {test.status === "RUNNING" && (
                      <span className="flex flex-wrap gap-2">
                        <form action={endCheckoutTestAction.bind(null, storeId, test.id, "B")}>
                          {back && <input type="hidden" name="back" value={back} />}
                          <ConfirmButton size="sm" variant="secondary" tone="default" title="Promouvoir la variante B ?" description="Le test s'arrête et le réglage B devient celui de la boutique." confirmLabel="Promouvoir B">
                            Promouvoir B
                          </ConfirmButton>
                        </form>
                        <form action={endCheckoutTestAction.bind(null, storeId, test.id, "A")}>
                          {back && <input type="hidden" name="back" value={back} />}
                          <SubmitButton size="sm" variant="secondary">
                            Garder A
                          </SubmitButton>
                        </form>
                      </span>
                    )}
                  </span>,
                ],
              };
            })}
          />
        </div>
      )}
      {full ? (
        <p className="text-sm text-zinc-500">{MAX_RUNNING_CHECKOUT_TESTS} tests du checkout au plus en même temps : terminez-en un pour en lancer un autre.</p>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-3">
          <form action={startCheckoutTestAction.bind(null, storeId)} className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-4" aria-labelledby="t-breaks">
            {back && <input type="hidden" name="back" value={back} />}
            <h3 id="t-breaks" className="text-sm font-semibold">Paliers de remise quantité</h3>
            <input type="hidden" name="kind" value="breaks" />
            <input type="hidden" name="name" value="Paliers de remise" />
            <div>
              <Label htmlFor="t-breaks-tiers" hint="articles:remise %, ex. 2:10, 3:15">Paliers B</Label>
              <Input id="t-breaks-tiers" name="tiers" placeholder="2:10, 3:15" required disabled={busy("breaks")} />
            </div>
            <SplitSelect id="t-breaks-split" />
            <SubmitButton className="mt-auto self-start" disabled={busy("breaks")}>{busy("breaks") ? "Test déjà en cours" : "Lancer le test"}</SubmitButton>
          </form>
          <form action={startCheckoutTestAction.bind(null, storeId)} className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-4" aria-labelledby="t-addon">
            {back && <input type="hidden" name="back" value={back} />}
            <h3 id="t-addon" className="text-sm font-semibold">Option (order bump)</h3>
            <input type="hidden" name="kind" value="addon" />
            <input type="hidden" name="name" value="Option du checkout" />
            <div>
              <Label htmlFor="t-addon-target">Option testée</Label>
              <Select id="t-addon-target" name="targetId" required defaultValue="" disabled={!addOns.length}>
                <option value="" disabled>
                  {addOns.length ? "Choisir…" : "Aucune option active"}
                </option>
                {addOns.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title} ({money(a.priceCents)})
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="t-addon-price" hint="vide = même prix">Prix B (€)</Label>
              <Input id="t-addon-price" name="price" inputMode="decimal" placeholder="4,90" />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="hidden" className="h-4 w-4 accent-indigo-600" /> Masquer l&apos;option en B
            </label>
            <SplitSelect id="t-addon-split" />
            <SubmitButton className="mt-auto self-start" disabled={!addOns.length}>Lancer le test</SubmitButton>
          </form>
          <form action={startCheckoutTestAction.bind(null, storeId)} className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-4" aria-labelledby="t-prot">
            {back && <input type="hidden" name="back" value={back} />}
            <h3 id="t-prot" className="text-sm font-semibold">Prix de la protection colis</h3>
            <input type="hidden" name="kind" value="protection" />
            <input type="hidden" name="name" value="Prix de la protection colis" />
            <ProtectionTestFields disabled={busy("protection")} />
            <SplitSelect id="t-prot-split" />
            <SubmitButton className="mt-auto self-start" disabled={busy("protection")}>{busy("protection") ? "Test déjà en cours" : "Lancer le test"}</SubmitButton>
          </form>
        </div>
      )}
    </Card>
  );
}

function SplitSelect({ id }: { id: string }) {
  return (
    <div>
      <Label htmlFor={id}>Part de trafic B</Label>
      <Select id={id} name="split" defaultValue="50">
        <option value="20">20 %</option>
        <option value="50">50 %</option>
        <option value="80">80 %</option>
      </Select>
    </div>
  );
}
