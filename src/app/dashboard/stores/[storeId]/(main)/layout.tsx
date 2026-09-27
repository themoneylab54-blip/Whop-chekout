import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronsUpDown, FlaskConical, LogOut, Plus, ShoppingBag } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { MobileNav, NavLink } from "@/components/dashboard/NavLink";
import { logoutAction } from "../../../actions";

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

export default async function StoreLayout({ children, params }: { children: React.ReactNode; params: Promise<{ storeId: string }> }) {
  const adminId = await requireAdmin();
  const { storeId } = await params;
  const [store, stores, admin, unsynced] = await Promise.all([
    db.store.findUnique({ where: { id: storeId } }),
    db.store.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true, enabled: true, shopifyConnectedAt: true, whopConnectedAt: true } }),
    db.adminUser.findUnique({ where: { id: adminId }, select: { email: true } }),
    db.checkoutSession.count({ where: { storeId, status: "PAID", shopifyOrderId: null } }),
  ]);
  if (!store) notFound();
  const base = `/dashboard/stores/${store.id}`;
  const live = store.enabled && !!store.shopifyConnectedAt && !!store.whopConnectedAt;

  return (
    <div className="flex min-h-full bg-[#f7f8fa]">
      <aside className="sticky top-0 hidden h-screen w-[248px] shrink-0 flex-col border-r border-zinc-200/70 bg-[#f7f8fa] px-3 py-4 md:flex">
        <Link href="/dashboard" className="mb-5 flex items-center gap-2.5 px-2">
          <span className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-[10px] bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-[inset_0_1px_0_rgba(255,255,255,.35),0_4px_12px_-4px_rgba(99,102,241,.7)]">
            <span className="absolute inset-x-1 top-0.5 h-3 rounded-full bg-white/30 blur-[2px]" />
            <ShoppingBag className="relative h-4 w-4 text-white" strokeWidth={2.4} />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Whop Checkout</span>
        </Link>

        <details className="group relative mb-5">
          <summary className="flex cursor-pointer list-none items-center gap-2.5 rounded-xl bg-white p-2 shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-float)]">
            <StoreAvatar id={store.id} name={store.name} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{store.name}</span>
              <span className="flex items-center gap-1.5 text-xs text-zinc-500">
                <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,.15)]" : "bg-zinc-300"}`} />
                {live ? (store.testMode ? "En ligne · test" : "En ligne") : "Hors ligne"}
              </span>
            </span>
            <ChevronsUpDown className="h-4 w-4 text-zinc-400" />
          </summary>
          <div className="animate-fade-up absolute inset-x-0 top-full z-30 mt-1.5 rounded-xl bg-white p-1.5 shadow-[var(--shadow-float)]">
            <p className="px-2 pt-1 pb-1.5 text-[10px] font-semibold tracking-[.1em] text-zinc-400 uppercase">Vos boutiques</p>
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
        </details>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          <NavLink href={base} exact icon="overview">
            Vue d&apos;ensemble
          </NavLink>
          <NavLink
            href={`${base}/orders`}
            icon="orders"
            badge={unsynced > 0 ? <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">{unsynced}</span> : undefined}
          >
            Commandes
          </NavLink>
          <p className="mt-5 mb-1.5 px-2.5 text-[10px] font-semibold tracking-[.1em] text-zinc-400 uppercase">Connexions</p>
          <NavLink href={`${base}/shopify`} icon="shopify" badge={<Dot ok={!!store.shopifyConnectedAt} />}>
            Shopify
          </NavLink>
          <NavLink href={`${base}/whop`} icon="whop" badge={<Dot ok={!!store.whopConnectedAt} />}>
            Whop
          </NavLink>
          <NavLink href={`${base}/interception`} icon="interception">
            Interception
          </NavLink>
          <p className="mt-5 mb-1.5 px-2.5 text-[10px] font-semibold tracking-[.1em] text-zinc-400 uppercase">Checkout</p>
          <NavLink href={`${base}/builder/checkout`} icon="design">
            Design du checkout
          </NavLink>
          <NavLink href={`${base}/builder/thank-you`} icon="thankyou">
            Page de remerciement
          </NavLink>
          <NavLink href={`${base}/shipping`} icon="shipping">
            Livraison
          </NavLink>
          <NavLink href={`${base}/offers`} icon="offers">
            Promos &amp; options
          </NavLink>
          <p className="mt-5 mb-1.5 px-2.5 text-[10px] font-semibold tracking-[.1em] text-zinc-400 uppercase">Compte</p>
          <NavLink href={`${base}/settings`} icon="settings">
            Réglages
          </NavLink>
        </nav>

        <div className="mt-3 flex items-center gap-2.5 rounded-xl p-2 hover:bg-zinc-900/[.04]">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-zinc-700 to-zinc-900 text-xs font-semibold text-white">
            {(admin?.email ?? "?")[0].toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">{admin?.email}</span>
          <form action={logoutAction}>
            <button title="Se déconnecter" aria-label="Se déconnecter" className="rounded-md p-1.5 text-zinc-400 hover:bg-white hover:text-zinc-900">
              <LogOut className="h-4 w-4" />
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="sticky top-0 z-20 border-b border-zinc-200/70 bg-white/80 backdrop-blur-xl md:hidden">
          <div className="flex items-center gap-2.5 px-4 pt-3 pb-2">
            <StoreAvatar id={store.id} name={store.name} size={26} />
            <span className="flex-1 truncate font-semibold">{store.name}</span>
            <span className={`h-2 w-2 rounded-full ${live ? "bg-emerald-500" : "bg-zinc-300"}`} />
          </div>
          <MobileNav
            items={[
              { href: base, label: "Vue d'ensemble", exact: true },
              { href: `${base}/orders`, label: "Commandes" },
              { href: `${base}/shopify`, label: "Shopify" },
              { href: `${base}/whop`, label: "Whop" },
              { href: `${base}/interception`, label: "Interception" },
              { href: `${base}/builder/checkout`, label: "Design" },
              { href: `${base}/shipping`, label: "Livraison" },
              { href: `${base}/offers`, label: "Promos" },
              { href: `${base}/settings`, label: "Réglages" },
            ]}
          />
        </div>
        <div className="mx-auto max-w-[1080px] px-4 py-8 md:px-10 md:py-10">
          {store.testMode && (
            <div className="mb-6 flex items-center gap-2.5 rounded-xl bg-amber-50 px-4 py-2.5 text-sm text-amber-900 ring-1 ring-amber-600/15">
              <FlaskConical className="h-4 w-4 shrink-0" />
              <span>
                <strong className="font-semibold">Mode test</strong> — paiements Whop sandbox, commandes Shopify marquées « test ».
              </span>
            </div>
          )}
          <div className="animate-fade-up">{children}</div>
        </div>
      </div>
    </div>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-emerald-500" : "bg-amber-400"}`} title={ok ? "Connecté" : "À connecter"} />;
}
