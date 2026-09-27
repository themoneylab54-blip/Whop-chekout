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
import { formatMoney } from "@/lib/pricing";
import { IconTile } from "@/components/icons";
import { BrandTile, type Brand } from "@/components/brands";
import { Badge, Flash, SubmitButton } from "@/components/ui";
import { RevenueChart, type DailyPoint } from "@/components/dashboard/RevenueChart";
import { setEnabledAction } from "../../../actions";

const RANGES = { today: 1, "7d": 7, "30d": 30, "90d": 90 } as const;
type Range = keyof typeof RANGES;
const RANGE_LABEL: Record<Range, string> = { today: "Aujourd'hui", "7d": "7 j", "30d": "30 j", "90d": "90 j" };

export default async function OverviewPage({
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
  const store = await db.store.findUnique({ where: { id: storeId }, include: { _count: { select: { shippingRates: true } } } });
  if (!store) notFound();

  // Days are the merchant's days (Paris), not the server's UTC days.
  const today = parisDay(new Date());
  const sinceKey = addDays(today, -(RANGES[range] - 1));
  const days = Math.max(RANGES[range], 7);
  const chartStartKey = addDays(today, -(days - 1));
  // Fetch a little before the earliest day so time-zone edges are included, then bucket precisely.
  const fetchFrom = new Date(`${chartStartKey < sinceKey ? chartStartKey : sinceKey}T00:00:00Z`);
  fetchFrom.setUTCHours(fetchFrom.getUTCHours() - 14);
  const since = new Date(`${sinceKey}T00:00:00Z`);
  since.setUTCHours(since.getUTCHours() - 14);

  const [paidRows, startedRows, abandonedRows] = await Promise.all([
    db.checkoutSession.findMany({
      where: { storeId, status: "PAID", paidAt: { gte: fetchFrom } },
      select: { paidAt: true, totalCents: true, refundedCents: true },
    }),
    db.checkoutSession.findMany({ where: { storeId, createdAt: { gte: since } }, select: { createdAt: true } }),
    db.checkoutSession.findMany({
      where: { storeId, createdAt: { gte: since }, status: { in: ["OPEN", "PAYING", "FAILED"] } },
      select: { createdAt: true },
    }),
  ]);
  const inRange = (d: Date | null) => !!d && parisDay(d) >= sinceKey;
  const paid = paidRows.filter((p) => inRange(p.paidAt));
  const started = startedRows.filter((r) => inRange(r.createdAt)).length;
  const abandoned = abandonedRows.filter((r) => inRange(r.createdAt)).length;
  const gross = paid.reduce((s, p) => s + p.totalCents, 0);
  const revenue = gross - paid.reduce((s, p) => s + p.refundedCents, 0);
  const orders = paid.length;
  const money = (c: number) => formatMoney(c, store.shopCurrency);

  const points: DailyPoint[] = Array.from({ length: days }, (_, i) => {
    const key = addDays(chartStartKey, i);
    return {
      date: key,
      label: new Date(`${key}T12:00:00Z`).toLocaleDateString("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" }),
      cents: 0,
      orders: 0,
    };
  });
  const byDay = new Map(points.map((p) => [p.date, p]));
  for (const p of paidRows) {
    const point = p.paidAt ? byDay.get(parisDay(p.paidAt)) : undefined;
    if (point) {
      point.cents += p.totalCents - p.refundedCents;
      point.orders += 1;
    }
  }

  const base = `/dashboard/stores/${store.id}`;
  const steps: { done: boolean; title: string; text: string; href: string | null; icon: LucideIcon; brand?: Brand }[] = [
    { done: !!store.shopifyConnectedAt, title: "Connecter Shopify", text: "Installe le script sur ta boutique", href: `${base}/shopify`, icon: ShoppingBag, brand: "shopify" },
    { done: !!store.whopConnectedAt, title: "Connecter Whop", text: "Encaisse les paiements sur ton compte", href: `${base}/whop`, icon: CreditCard, brand: "whop" },
    { done: store._count.shippingRates > 0, title: "Ajouter la livraison", text: "Au moins un tarif par pays livré", href: `${base}/shipping`, icon: Truck },
    { done: !!store.checkoutLayout, title: "Designer le checkout", text: "Couleurs, logo, blocs de conversion", href: `${base}/builder/checkout`, icon: Paintbrush },
    { done: store.enabled, title: "Mettre en ligne", text: "Remplace le checkout Shopify", href: null, icon: Rocket },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const ready = !!store.shopifyConnectedAt && !!store.whopConnectedAt;
  const live = store.enabled && ready;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-500">Vue d&apos;ensemble</p>
          <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.02em]">{store.name}</h1>
        </div>
        <div className="flex rounded-xl bg-white p-1 text-sm shadow-[var(--shadow-card)]">
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <Link
              key={r}
              href={`${base}?range=${r}`}
              className={`rounded-lg px-3 py-1 transition ${r === range ? "bg-zinc-900 font-medium text-white shadow-sm" : "text-zinc-500 hover:text-zinc-900"}`}
            >
              {RANGE_LABEL[r]}
            </Link>
          ))}
        </div>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      {/* Hero: revenue + chart */}
      <section className="mb-6 overflow-hidden rounded-2xl bg-white shadow-[var(--shadow-card)]">
        <div className="grid gap-6 p-6 lg:grid-cols-[280px_1fr]">
          <div className="flex flex-col justify-between gap-6">
            <div>
              <p className="flex items-center gap-1.5 text-sm font-medium text-zinc-500">
                <TrendingUp className="h-4 w-4 text-indigo-500" /> Chiffre d&apos;affaires
              </p>
              <p className="mt-2 text-[40px] leading-none font-semibold tracking-[-0.03em] tabular-nums">{money(revenue)}</p>
              <p className="mt-2 text-xs text-zinc-500">Net des remboursements · {RANGE_LABEL[range].toLowerCase()}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <MiniStat label="Commandes" value={String(orders)} />
              <MiniStat label="Panier moyen" value={orders ? money(Math.round(gross / orders)) : "—"} />
            </div>
          </div>
          <div className="min-w-0">
            <RevenueChart points={points} currency={store.shopCurrency} />
          </div>
        </div>
      </section>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi icon={Receipt} color="#6366f1" label="Commandes" value={String(orders)} hint="payées sur la période" />
        <Kpi icon={Wallet} color="#0ea5e9" label="Panier moyen" value={orders ? money(Math.round(gross / orders)) : "—"} hint="par commande" />
        <Kpi icon={Percent} color="#10b981" label="Conversion" value={started ? `${((orders / started) * 100).toFixed(1)} %` : "—"} hint="checkouts → payés" />
        <Kpi icon={ShoppingCart} color="#f59e0b" label="Abandons" value={String(abandoned)} hint="checkouts non payés" />
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <section className="rounded-2xl bg-white p-5 shadow-[var(--shadow-card)]">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight">Mise en route</h2>
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
                      <Check className="h-4 w-4" strokeWidth={3} />
                    </span>
                  ) : s.brand ? (
                    <BrandTile brand={s.brand} size={36} />
                  ) : (
                    <IconTile icon={s.icon} size={36} color="#6366f1" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-medium ${s.done ? "text-zinc-400 line-through" : ""}`}>{s.title}</span>
                    <span className="block text-xs text-zinc-500">{s.text}</span>
                  </span>
                  {!s.done && s.href && <ArrowRight className="h-4 w-4 text-zinc-400" />}
                </div>
              );
              return <li key={s.title}>{s.href && !s.done ? <Link href={s.href}>{Row}</Link> : Row}</li>;
            })}
          </ol>
        </section>

        <section className="relative overflow-hidden rounded-2xl p-5 text-white shadow-[var(--shadow-float)]">
          <div className={`absolute inset-0 ${live ? "bg-mesh" : "bg-gradient-to-br from-zinc-800 to-zinc-950"}`} />
          <div className="bg-grid absolute inset-0 opacity-40" />
          <div className="relative">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-[15px] font-semibold">Statut du checkout</h2>
              <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${live ? "bg-emerald-400/20 text-emerald-200" : "bg-white/10 text-zinc-300"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${live ? "animate-pulse bg-emerald-400" : "bg-zinc-400"}`} />
                {live ? "En ligne" : "Hors ligne"}
              </span>
            </div>
            <p className="text-2xl font-semibold tracking-tight">{live ? "Checkout Whop actif" : "Checkout Shopify natif"}</p>
            <p className="mt-1.5 text-sm text-white/70">
              {live ? "Les clics sur « Paiement » arrivent sur ton checkout Whop." : "Tes clients passent par le checkout Shopify habituel."}
            </p>
            <form action={setEnabledAction.bind(null, store.id, !store.enabled)} className="mt-6">
              <SubmitButton
                variant={store.enabled ? "secondary" : "primary"}
                className={`w-full ${store.enabled ? "" : "!bg-white !text-zinc-900 hover:!bg-zinc-100"}`}
                disabled={!store.enabled && !ready}
                confirm={store.enabled ? "Désactiver le checkout Whop ? Tes clients repasseront par le checkout Shopify." : undefined}
              >
                <Power className="h-4 w-4" />
                {store.enabled ? "Désactiver" : "Mettre en ligne"}
              </SubmitButton>
            </form>
            {!ready && <p className="mt-2 text-xs text-white/60">Connecte Shopify et Whop pour pouvoir mettre en ligne.</p>}
            <div className="mt-6 space-y-2 border-t border-white/10 pt-4">
              <Connection label="Shopify" detail={store.shopDomain ?? "Non connecté"} ok={!!store.shopifyConnectedAt} href={`${base}/shopify`} />
              <Connection label="Whop" detail={store.whopConnectedAt ? (store.testMode ? "Sandbox" : "Production") : "Non connecté"} ok={!!store.whopConnectedAt} href={`${base}/whop`} />
            </div>
          </div>
        </section>
      </div>
    </>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-900/5">
      <p className="text-[11px] font-medium text-zinc-500">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tracking-tight tabular-nums">{value}</p>
    </div>
  );
}

function Kpi({ icon, color, label, value, hint }: { icon: LucideIcon; color: string; label: string; value: string; hint: string }) {
  return (
    <div className="group rounded-2xl bg-white p-4 shadow-[var(--shadow-card)] transition hover:-translate-y-0.5 hover:shadow-[var(--shadow-float)]">
      <IconTile icon={icon} size={34} color={color} />
      <p className="mt-3 text-xs font-medium text-zinc-500">{label}</p>
      <p className="mt-0.5 text-xl font-semibold tracking-tight tabular-nums">{value}</p>
      <p className="mt-0.5 text-[11px] text-zinc-400">{hint}</p>
    </div>
  );
}

function ProgressRing({ value }: { value: number }) {
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" role="img" aria-label={`${Math.round(value * 100)} % terminé`}>
      <circle cx="24" cy="24" r={r} fill="none" stroke="#e4e4e7" strokeWidth="5" />
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
      <text x="24" y="28" textAnchor="middle" className="fill-zinc-900 text-[11px] font-semibold">
        {Math.round(value * 100)}%
      </text>
    </svg>
  );
}

function Connection({ label, detail, ok, href }: { label: string; detail: string; ok: boolean; href: string }) {
  return (
    <Link href={href} className="flex items-center justify-between rounded-lg px-2 py-1.5 transition hover:bg-white/5">
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block max-w-[200px] truncate text-xs text-white/60">{detail}</span>
      </span>
      <Badge color={ok ? "green" : "amber"}>{ok ? "Connecté" : "À connecter"}</Badge>
    </Link>
  );
}

const parisFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });

/** "YYYY-MM-DD" of a moment in Paris. */
function parisDay(d: Date): string {
  return parisFormat.format(d);
}

function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
