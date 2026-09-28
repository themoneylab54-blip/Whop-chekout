"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Activity, BarChart3, Crosshair, LayoutDashboard, Megaphone, Paintbrush, PartyPopper, Percent, Receipt, Settings, Truck } from "lucide-react";
import { ShopifyLogo, WhopLogo } from "@/components/brands";

// Server components can't pass component functions to this client component: they pass a name.
const NAV_ICONS = {
  overview: LayoutDashboard,
  orders: Receipt,
  shopify: ShopifyLogo,
  whop: WhopLogo,
  interception: Crosshair,
  design: Paintbrush,
  thankyou: PartyPopper,
  shipping: Truck,
  offers: Percent,
  settings: Settings,
  analytics: BarChart3,
  growth: Megaphone,
  journal: Activity,
} as const;
export type NavIcon = keyof typeof NAV_ICONS;

export function NavLink({ href, exact, icon, children, badge }: { href: string; exact?: boolean; icon: NavIcon; children: ReactNode; badge?: ReactNode }) {
  const Icon = NAV_ICONS[icon];
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13.5px] transition ${
        active ? "bg-white font-medium text-zinc-900 shadow-[0_1px_2px_rgba(16,24,40,.06),0_0_0_1px_rgba(16,24,40,.06)]" : "text-zinc-600 hover:bg-zinc-900/[.04] hover:text-zinc-900"
      }`}
    >
      {active && <span className="absolute top-1/2 -left-3 h-4 w-1 -translate-y-1/2 rounded-r-full bg-indigo-500" />}
      {icon === "shopify" || icon === "whop" ? (
        // Real brand marks, in color: they read instantly in the sidebar.
        <Icon className={`h-4 w-4 shrink-0 transition ${active ? "" : "opacity-80 grayscale-[35%] group-hover:opacity-100 group-hover:grayscale-0"}`} />
      ) : (
        <Icon className={`h-4 w-4 shrink-0 ${active ? "text-indigo-600" : "text-zinc-400 group-hover:text-zinc-600"}`} strokeWidth={2} />
      )}
      <span className="flex-1 truncate">{children}</span>
      {badge}
    </Link>
  );
}

/** Horizontal nav for small screens. */
export function MobileNav({ items }: { items: { href: string; label: string; exact?: boolean }[] }) {
  const path = usePathname();
  return (
    <nav className="flex gap-1 overflow-x-auto px-3 pb-2 text-sm whitespace-nowrap">
      {items.map((it) => {
        const active = it.exact ? path === it.href : path === it.href || path.startsWith(`${it.href}/`);
        return (
          <Link
            key={it.href}
            href={it.href}
            className={`rounded-full px-3 py-1 transition ${active ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"}`}
          >
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}
