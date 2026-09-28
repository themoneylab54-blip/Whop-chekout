import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronsUpDown, FlaskConical, LogOut, Plus, ShoppingBag } from "lucide-react";
import { after } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { maybeTick, warnIfTickStale } from "@/lib/tick";
import { db } from "@/lib/db";
import { MobileMenu, SidebarNav } from "@/components/dashboard/NavLink";
import { CommandPalette, CommandPaletteTrigger } from "@/components/dashboard/CommandPalette";
import { UnsavedChangesBar } from "@/components/dashboard/DirtyForm";
import { PopoverDetails } from "@/components/dashboard/Popover";
import { HashFocus } from "@/components/dashboard/HashFocus";
import { FormDraftKeeper } from "@/components/dashboard/FormDraftKeeper";
import "../../../dashboard.css";
import { logoutAction } from "../../../actions";
import { tzOf } from "@/lib/time";
import { providersOverview, type ProviderOverview } from "@/lib/providers";
import { providerStatus, type ProviderStatus } from "@/lib/provider-status";

/**
 * Dashboard visits run the background tick after answering (maybeTick in after()): its hard limit
 * (HARD_LIMIT_MS, 50 s) assumes the same 60 s function limit as /api/cron/tick. Route segment config
 * (valid in a layout: it applies to every page of this segment).
 */
export const maxDuration = 60;

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

const AVATAR_GRADIENTS = [
  "from-indigo-500 to-violet-500",
  "from-sky-500 to-indigo-500",
  "from-emerald-500 to-teal-500",
  "from-rose-500 to-orange-400",
  "from-amber-500 to-pink-500",
];

function avatarGradient(id: string) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_GRADIENTS[h % AVATAR_GRADIENTS.length];
}

function StoreAvatar({ id, name, size = 32 }: { id: string; name: string; size?: number }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${avatarGradient(id)} text-[11px] font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,.3),0_2px_6px_-2px_rgba(0,0,0,.3)]`}
      style={{ width: size, height: size }}
    >
      {initials(name) || "?"}
    </span>
  );
}

/** Tab titles read "Réglages · Maison Lumière"; pages without a title show the store name. */
export async function generateMetadata({ params }: { params: Promise<{ storeId: string }> }): Promise<Metadata> {
  const { storeId } = await params;
  const store = await db.store.findUnique({ where: { id: storeId }, select: { name: true } });
  const name = store?.name ?? "Boutique";
  return { title: { template: `%s · ${name}`, default: name } };
}

export default async function StoreLayout({ children, params }: { children: React.ReactNode; params: Promise<{ storeId: string }> }) {
  const adminId = await requireAdmin();
  const { storeId } = await params;
  const [store, stores, admin, unsynced, providers] = await Promise.all([
    db.store.findUnique({ where: { id: storeId } }),
    db.store.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true, enabled: true, shopifyConnectedAt: true, whopConnectedAt: true } }),
    db.adminUser.findUnique({ where: { id: adminId }, select: { email: true } }),
    db.checkoutSession.count({ where: { storeId, status: "PAID", shopifyOrderId: null, syncHandledAt: null } }),
    // Same status as Journal › Services externes: a connected but failing provider shows red.
    providersOverview().catch((): ProviderOverview[] => []),
  ]);
  const statusOf = (id: string) => {
    const p = providers.find((x) => x.provider === id);
    return p ? providerStatus(p) : null;
  };
  // Dashboard visits also keep background maintenance going (reconciliation, retries…),
  // after alerting (throttled) when the scheduler itself has stopped.
  after(async () => {
    await warnIfTickStale(storeId);
    await maybeTick().catch(() => undefined);
  });
  if (!store) notFound();
  const base = `/dashboard/stores/${store.id}`;
  const live = store.enabled && !!store.shopifyConnectedAt && !!store.whopConnectedAt;
  const badges = {
    orders:
      unsynced > 0 ? (
        <span className="rounded-full bg-red-600 px-1.5 text-[11px] leading-[18px] font-semibold text-white" title={`${unsynced} commande(s) payée(s) à créer dans Shopify`}>
          {unsynced}
          <span className="sr-only"> à traiter</span>
        </span>
      ) : undefined,
    shopify: <Dot ok={!!store.shopifyConnectedAt} status={statusOf("shopify")} />,
    whop: <Dot ok={!!store.whopConnectedAt} status={statusOf("whop")} />,
  };

  return (
    <div className="dash flex min-h-full bg-[#f7f8fa]">
      <a
        href="#contenu"
        className="sr-only z-50 rounded-lg bg-white px-3 py-2 text-sm font-medium shadow-[var(--shadow-float)] focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        Aller au contenu
      </a>
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-zinc-200/70 bg-[#f7f8fa] px-3 py-4 md:flex">
        <Link href="/dashboard" className="mb-5 flex items-center gap-2.5 px-2">
          <span className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-[10px] bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_4px_12px_-4px_rgba(99,102,241,.7)]">
            <span className="absolute inset-x-1 top-0.5 h-3 rounded-full bg-white/30 blur-[2px]" />
            <ShoppingBag className="relative h-4 w-4 text-white" strokeWidth={2.4} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Whop Checkout</span>
        </Link>

        <PopoverDetails className="group relative mb-5">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl bg-white p-2 shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-float)]">
            <StoreAvatar id={store.id} name={store.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{store.name}</span>
              <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,.15)]" : "bg-zinc-300"}`} />
                {live ? (store.testMode ? "En ligne · test" : "En ligne") : "Hors ligne"}
              </span>
            </span>
            <ChevronsUpDown className="h-4 w-4 text-zinc-500" aria-hidden />
          </summary>
          <div className="animate-fade-up absolute inset-x-0 top-full z-30 mt-1.5 rounded-xl bg-white p-1.5 shadow-[var(--shadow-float)]">
            <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-[.08em] text-zinc-500 uppercase">Vos boutiques</p>
            {stores.map((s) => (
              <Link key={s.id} href={`/dashboard/stores/${s.id}`} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100">
                <StoreAvatar id={s.id} name={s.name} size={22} />
                <span className="flex-1 truncate">{s.name}</span>
                {s.enabled && s.shopifyConnectedAt && s.whopConnectedAt && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
              </Link>
            ))}
            <Link href="/dashboard/stores/new" className="mt-1 flex items-center gap-2 rounded-lg border-t border-zinc-100 px-2 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50">
              <Plus className="h-4 w-4" /> Ajouter une boutique
            </Link>
          </div>
        </PopoverDetails>

        <CommandPaletteTrigger />

        <SidebarNav base={base} badges={badges} />

        <div className="mt-3 flex items-center gap-2.5 rounded-xl p-2 hover:bg-zinc-900/[.04]">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-zinc-700 to-zinc-900 text-xs font-semibold text-white">
            {(admin?.email ?? "?")[0].toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">{admin?.email}</span>
          <form action={logoutAction}>
            <button title="Se déconnecter" aria-label="Se déconnecter" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-500 hover:bg-white hover:text-zinc-900">
              <LogOut className="h-4 w-4" />
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="sticky top-0 z-20 border-b border-zinc-200/70 bg-white/95 backdrop-blur-xl md:hidden">
          <div className="flex items-center gap-2 px-4 py-2.5">
            <PopoverDetails className="group relative min-w-0 flex-1">
              <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2.5 rounded-lg" aria-label={`Boutique : ${store.name}. Changer de boutique`}>
                <StoreAvatar id={store.id} name={store.name} size={28} />
                <span className="truncate font-semibold">{store.name}</span>
                <span className={`h-2 w-2 shrink-0 rounded-full ${live ? "bg-emerald-500" : "bg-zinc-300"}`} aria-hidden />
                <span className="sr-only">{live ? "En ligne" : "Hors ligne"}</span>
                <ChevronsUpDown className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
              </summary>
              <div className="absolute left-0 top-full z-30 mt-2 w-[min(16rem,calc(100vw-2rem))] rounded-xl bg-white p-1.5 shadow-[var(--shadow-float)]">
                <p className="px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-[.08em] text-zinc-500 uppercase">Vos boutiques</p>
                {stores.map((s) => (
                  <Link key={s.id} href={`/dashboard/stores/${s.id}`} className="flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm hover:bg-zinc-100">
                    <StoreAvatar id={s.id} name={s.name} size={22} />
                    <span className="flex-1 truncate">{s.name}</span>
                  </Link>
                ))}
                <Link href="/dashboard/stores/new" className="flex min-h-10 items-center gap-2 rounded-lg px-2 text-sm font-medium text-indigo-600 hover:bg-indigo-50">
                  <Plus className="h-4 w-4" /> Ajouter une boutique
                </Link>
              </div>
            </PopoverDetails>
            <CommandPaletteTrigger variant="icon" />
            <MobileMenu
              base={base}
              badges={badges}
              header={
                <span className="flex min-w-0 items-center gap-2.5">
                  <StoreAvatar id={store.id} name={store.name} size={28} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{store.name}</span>
                    <span className="block text-xs text-zinc-500">{live ? (store.testMode ? "En ligne · test" : "En ligne") : "Hors ligne"}</span>
                  </span>
                </span>
              }
              footer={
                <div className="flex items-center gap-2.5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-zinc-700 to-zinc-900 text-xs font-semibold text-white">
                    {(admin?.email ?? "?")[0].toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">{admin?.email}</span>
                  <form action={logoutAction}>
                    <button className="inline-flex min-h-10 items-center gap-1.5 rounded-lg px-3 text-sm font-medium text-zinc-700 hover:bg-zinc-900/[.05]">
                      <LogOut className="h-4 w-4" aria-hidden /> Déconnexion
                    </button>
                  </form>
                </div>
              }
            />
          </div>
        </div>
        {/* tabIndex -1: the skip link moves the keyboard focus here (no ring on a whole page region). */}
        <main id="contenu" tabIndex={-1} className="mx-auto max-w-[1080px] px-4 py-6 outline-none focus:outline-none md:px-10 md:py-10">
          {store.testMode && (
            <div className="mb-6 flex items-center gap-2.5 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-amber-600/15">
              <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />
              <span>
                <strong className="font-semibold">Mode test</strong> — paiements Whop sandbox, commandes Shopify marquées « test ».
              </span>
            </div>
          )}
          <div className="animate-fade-up">{children}</div>
          <UnsavedChangesBar />
        </main>
        <CommandPalette base={base} storeId={store.id} tz={tzOf(store)} stores={stores.map((s) => ({ id: s.id, name: s.name }))} />
        <HashFocus />
        <FormDraftKeeper />
      </div>
    </div>
  );
}

/** Connection dot: amber "À connecter"; connected, the provider's status (red "En panne", amber "Dégradé"). */
function Dot({ ok, status }: { ok: boolean; status: ProviderStatus | null }) {
  const [color, label] = !ok
    ? ["bg-amber-400", "À connecter"]
    : status?.level === "down"
      ? ["bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,.18)]", `En panne${status.reason ? ` : ${status.reason}` : ""}`]
      : status?.level === "degraded" || status?.level === "watch"
        ? ["bg-amber-500", `${status.label}${status.reason ? ` : ${status.reason}` : ""}`]
        : ["bg-emerald-500", "Connecté"];
  return (
    <span className={`h-1.5 w-1.5 rounded-full ${color}`} title={label}>
      <span className="sr-only">{label}</span>
    </span>
  );
}
