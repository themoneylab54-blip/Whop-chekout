import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { formatMoney } from "@/lib/pricing";
import { Badge, Card, Flash, PageHeader, SubmitButton } from "@/components/ui";
import { setEnabledAction } from "../../../actions";

const RANGES = { today: 1, "7d": 7, "30d": 30, "90d": 90 } as const;
type Range = keyof typeof RANGES;

export default async function OverviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string }>;
  searchParams: Promise<{ range?: string; ok?: string; error?: string }>;
}) {
  const { storeId } = await params;
  const sp = await searchParams;
  const range: Range = sp.range && sp.range in RANGES ? (sp.range as Range) : "30d";
  const store = await db.store.findUnique({ where: { id: storeId } });
  if (!store) notFound();

  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (RANGES[range] - 1));

  const [paid, started, abandoned] = await Promise.all([
    db.checkoutSession.aggregate({
      where: { storeId, status: "PAID", paidAt: { gte: since } },
      _sum: { totalCents: true, refundedCents: true },
      _count: true,
    }),
    db.checkoutSession.count({ where: { storeId, createdAt: { gte: since } } }),
    db.checkoutSession.count({ where: { storeId, createdAt: { gte: since }, status: { in: ["OPEN", "PAYING", "FAILED"] } } }),
  ]);
  const revenue = (paid._sum.totalCents ?? 0) - (paid._sum.refundedCents ?? 0);
  const orders = paid._count;
  const money = (c: number) => formatMoney(c, store.shopCurrency);

  const base = `/dashboard/stores/${store.id}`;
  const steps = [
    { done: !!store.shopifyConnectedAt, title: "Connecter la boutique Shopify", href: `${base}/shopify` },
    { done: !!store.whopConnectedAt, title: "Connecter le compte Whop", href: `${base}/whop` },
    { done: !!store.checkoutLayout, title: "Designer le checkout", href: `${base}/builder/checkout` },
    { done: store.enabled, title: "Mettre en ligne", href: null },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const ready = !!store.shopifyConnectedAt && !!store.whopConnectedAt;

  return (
    <>
      <PageHeader
        title={store.name}
        description="Votre checkout Whop, branché sur Shopify."
        actions={
          <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 text-sm">
            {(Object.keys(RANGES) as Range[]).map((r) => (
              <Link
                key={r}
                href={`${base}?range=${r}`}
                className={`rounded-md px-3 py-1 ${r === range ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"}`}
              >
                {r === "today" ? "Aujourd'hui" : r}
              </Link>
            ))}
          </div>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Kpi label="Chiffre d'affaires" value={money(revenue)} hint="net des remboursements" />
        <Kpi label="Commandes" value={String(orders)} />
        <Kpi label="Panier moyen" value={orders ? money(Math.round((paid._sum.totalCents ?? 0) / orders)) : "—"} />
        <Kpi label="Conversion" value={started ? `${((orders / started) * 100).toFixed(1)} %` : "—"} hint="checkout → payé" />
        <Kpi label="Checkouts abandonnés" value={String(abandoned)} hint="sans paiement" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card
          title="Mise en route"
          description={`${doneCount} sur ${steps.length} étapes terminées`}
          actions={<span className="text-sm font-medium text-zinc-500">{Math.round((doneCount / steps.length) * 100)} %</span>}
        >
          <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-zinc-100">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
          </div>
          <ol className="divide-y divide-zinc-100">
            {steps.map((s, i) => (
              <li key={s.title} className="flex items-center gap-3 py-3">
                <span
                  className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.done ? "bg-emerald-500 text-white" : "border border-zinc-300 text-zinc-500"}`}
                >
                  {s.done ? "✓" : i + 1}
                </span>
                <span className={`flex-1 text-sm ${s.done ? "text-zinc-400 line-through" : "font-medium"}`}>{s.title}</span>
                {s.href && !s.done && (
                  <Link href={s.href} className="text-sm font-medium text-zinc-900 hover:underline">
                    Commencer →
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </Card>

        <Card title="Statut du checkout">
          <div className="mb-4 flex items-center gap-3">
            <span className={`h-3 w-3 rounded-full ${store.enabled && ready ? "bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,.15)]" : "bg-zinc-300"}`} />
            <div>
              <p className="font-medium">{store.enabled && ready ? "Checkout Whop actif" : "Checkout Shopify natif"}</p>
              <p className="text-xs text-zinc-500">
                {store.enabled && ready
                  ? "Les clics sur « Paiement » arrivent sur votre checkout Whop."
                  : "Vos clients passent par le checkout Shopify habituel."}
              </p>
            </div>
          </div>
          <form action={setEnabledAction.bind(null, store.id, !store.enabled)}>
            <SubmitButton variant={store.enabled ? "danger" : "primary"} className="w-full" disabled={!store.enabled && !ready}>
              {store.enabled ? "Désactiver (retour au checkout Shopify)" : "Mettre en ligne"}
            </SubmitButton>
          </form>
          {!ready && <p className="mt-2 text-xs text-zinc-500">Connectez Shopify et Whop pour pouvoir mettre en ligne.</p>}

          <div className="mt-5 space-y-2 border-t border-zinc-100 pt-4">
            <Connection label="Shopify" detail={store.shopDomain ?? "Boutique et création des commandes"} ok={!!store.shopifyConnectedAt} href={`${base}/shopify`} />
            <Connection label="Whop" detail="Encaisse chaque paiement" ok={!!store.whopConnectedAt} href={`${base}/whop`} />
          </div>
        </Card>
      </div>
    </>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4">
      <p className="text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-zinc-400">{hint}</p>}
    </div>
  );
}

function Connection({ label, detail, ok, href }: { label: string; detail: string; ok: boolean; href: string }) {
  return (
    <Link href={href} className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-zinc-50">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-zinc-500">{detail}</span>
      </span>
      <Badge color={ok ? "green" : "zinc"}>{ok ? "Connecté" : "Non connecté"}</Badge>
    </Link>
  );
}
