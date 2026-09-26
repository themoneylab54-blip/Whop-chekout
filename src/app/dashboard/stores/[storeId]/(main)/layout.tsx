import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Badge } from "@/components/ui";
import { NavLink } from "@/components/dashboard/NavLink";
import { logoutAction } from "../../../actions";

export default async function StoreLayout({ children, params }: { children: React.ReactNode; params: Promise<{ storeId: string }> }) {
  await requireAdmin();
  const { storeId } = await params;
  const [store, stores] = await Promise.all([
    db.store.findUnique({ where: { id: storeId } }),
    db.store.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true, enabled: true } }),
  ]);
  if (!store) notFound();
  const base = `/dashboard/stores/${store.id}`;
  const live = store.enabled && !!store.shopifyConnectedAt && !!store.whopConnectedAt;

  return (
    <div className="flex min-h-full bg-zinc-50">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-zinc-200 bg-white p-3 md:flex">
        <div className="mb-3 flex items-center gap-2 px-2 py-1.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 text-xs font-bold text-white">W</span>
          <span className="text-sm font-semibold">Whop Checkout</span>
        </div>

        <details className="group relative mb-4">
          <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg border border-zinc-200 px-2.5 py-2 hover:bg-zinc-50">
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{store.name}</span>
              <span className="flex items-center gap-1 text-xs text-zinc-500">
                <span className={`h-1.5 w-1.5 rounded-full ${live ? "bg-emerald-500" : "bg-zinc-300"}`} />
                {live ? (store.testMode ? "En ligne · test" : "En ligne") : "Hors ligne"}
              </span>
            </span>
            <span className="text-zinc-400">⌄</span>
          </summary>
          <div className="absolute inset-x-0 top-full z-20 mt-1 rounded-lg border border-zinc-200 bg-white p-1 shadow-lg">
            <p className="px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Vos boutiques</p>
            {stores.map((s) => (
              <Link key={s.id} href={`/dashboard/stores/${s.id}`} className="flex items-center justify-between rounded-md px-2 py-1.5 text-sm hover:bg-zinc-100">
                <span className="truncate">{s.name}</span>
                {s.id === store.id && <span className="text-xs">✓</span>}
              </Link>
            ))}
            <Link href="/dashboard/stores/new" className="mt-1 block rounded-md px-2 py-1.5 text-sm font-medium text-zinc-900 hover:bg-zinc-100">
              + Ajouter une boutique
            </Link>
          </div>
        </details>

        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          <NavLink href={base} exact icon="◎">
            Vue d&apos;ensemble
          </NavLink>
          <NavLink href={`${base}/orders`} icon="≡">
            Commandes
          </NavLink>
          <p className="mt-4 mb-1 px-2.5 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Connexions</p>
          <NavLink href={`${base}/shopify`} icon="🛍">
            Shopify
          </NavLink>
          <NavLink href={`${base}/whop`} icon="💳">
            Whop
          </NavLink>
          <NavLink href={`${base}/interception`} icon="⤳">
            Interception
          </NavLink>
          <p className="mt-4 mb-1 px-2.5 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Checkout</p>
          <Link href={`${base}/builder/checkout`} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
            <span className="w-4 text-center text-[13px]">🎨</span>Design du checkout
          </Link>
          <Link href={`${base}/builder/thank-you`} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900">
            <span className="w-4 text-center text-[13px]">✓</span>Page de remerciement
          </Link>
          <NavLink href={`${base}/shipping`} icon="🚚">
            Livraison
          </NavLink>
          <NavLink href={`${base}/offers`} icon="%">
            Promos &amp; options
          </NavLink>
          <p className="mt-4 mb-1 px-2.5 text-[11px] font-semibold tracking-wide text-zinc-400 uppercase">Compte</p>
          <NavLink href={`${base}/settings`} icon="⚙">
            Réglages
          </NavLink>
        </nav>

        <form action={logoutAction} className="border-t border-zinc-100 pt-2">
          <button className="w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-zinc-500 hover:bg-zinc-100">Se déconnecter</button>
        </form>
      </aside>

      <div className="min-w-0 flex-1">
        <div className="border-b border-zinc-200 bg-white md:hidden">
          <div className="flex items-center justify-between px-4 pt-3">
            <span className="font-semibold">{store.name}</span>
            <span className="text-xs text-zinc-500">{live ? "En ligne" : "Hors ligne"}</span>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-3 py-2 text-sm whitespace-nowrap">
            {[
              ["", "Vue d'ensemble"],
              ["/orders", "Commandes"],
              ["/shopify", "Shopify"],
              ["/whop", "Whop"],
              ["/interception", "Interception"],
              ["/builder/checkout", "Design"],
              ["/shipping", "Livraison"],
              ["/offers", "Promos"],
              ["/settings", "Réglages"],
            ].map(([path, label]) => (
              <Link key={path} href={`${base}${path}`} className="rounded-md px-2.5 py-1 text-zinc-600 hover:bg-zinc-100">
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="mx-auto max-w-5xl px-4 py-8 md:px-8">
          {store.testMode && (
            <div className="mb-5 flex items-center gap-2">
              <Badge color="amber">Mode test</Badge>
              <span className="text-xs text-zinc-500">Paiements Whop sandbox, commandes Shopify marquées « test ».</span>
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}
