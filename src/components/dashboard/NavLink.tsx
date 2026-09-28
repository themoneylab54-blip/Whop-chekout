"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Activity, BarChart3, Coins, Crosshair, LayoutDashboard, Megaphone, Menu, Paintbrush, PartyPopper, Percent, Receipt, Settings, Truck, X } from "lucide-react";
import { ShopifyLogo, WhopLogo } from "@/components/brands";
import { NAV_GROUPS, isActive, navHref, type NavIconName } from "./nav";

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
  costs: Coins,
  settings: Settings,
  analytics: BarChart3,
  growth: Megaphone,
  journal: Activity,
} as const satisfies Record<NavIconName, unknown>;
export type NavIcon = NavIconName;

function NavIconGlyph({ icon, active, hoverable }: { icon: NavIcon; active: boolean; hoverable: boolean }) {
  const Icon = NAV_ICONS[icon];
  return icon === "shopify" || icon === "whop" ? (
    // Real brand marks, in color: they read instantly in the sidebar.
    <Icon className={`h-4 w-4 shrink-0 transition ${active ? "" : `opacity-80 grayscale-[35%] ${hoverable ? "group-hover:opacity-100 group-hover:grayscale-0" : ""}`}`} />
  ) : (
    <Icon className={`h-4 w-4 shrink-0 ${active ? "text-indigo-600" : `text-zinc-500 ${hoverable ? "group-hover:text-zinc-700" : ""}`}`} strokeWidth={2} aria-hidden />
  );
}

export function NavLink({
  href,
  exact,
  icon,
  children,
  badge,
  onNavigate,
  large,
  hoverable = true,
}: {
  href: string;
  exact?: boolean;
  icon: NavIcon;
  children: ReactNode;
  badge?: ReactNode;
  onNavigate?: () => void;
  large?: boolean;
  /** False right after a navigation, until the pointer moves again (see NavGroups). */
  hoverable?: boolean;
}) {
  const path = usePathname();
  const active = isActive(path, href, exact);
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 transition ${large ? "min-h-11 text-[15px]" : "py-[7px] text-[13.5px]"} ${
        active
          ? "bg-white font-medium text-zinc-900 shadow-[0_1px_2px_rgba(16,24,40,.06),0_0_0_1px_rgba(16,24,40,.06)]"
          : `text-zinc-600 ${hoverable ? "hover:bg-zinc-900/[.04] hover:text-zinc-900" : ""}`
      }`}
    >
      {active && <span className="absolute top-1/2 -left-3 h-4 w-1 -translate-y-1/2 rounded-r-full bg-indigo-500" />}
      <NavIconGlyph icon={icon} active={active} hoverable={hoverable} />
      <span className="flex-1 truncate">{children}</span>
      {badge}
    </Link>
  );
}

/** Grouped nav list (sidebar and mobile sheet). `badges` is keyed by the item's path. */
export function NavGroups({ base, badges = {}, onNavigate, large }: { base: string; badges?: Record<string, ReactNode>; onNavigate?: () => void; large?: boolean }) {
  // The pointer usually rests where the merchant just clicked: after the route changes, the
  // item under it would keep a "hover" look that reads like a second active item. Hover styles
  // come back as soon as the pointer actually moves over the list.
  const path = usePathname();
  const [armed, setArmed] = useState({ path, on: false });
  const hoverable = armed.path === path && armed.on;
  return (
    <div
      className="contents"
      onPointerMove={(e) => {
        if (e.pointerType === "mouse" && !hoverable) setArmed({ path, on: true });
      }}
    >
      {NAV_GROUPS.map((g, gi) => (
        <div key={g.label ?? gi} role="group" aria-labelledby={g.label ? `nav-group-${large ? "m" : "d"}-${gi}` : undefined} className={gi ? "mt-5" : ""}>
          {g.label && (
            <p id={`nav-group-${large ? "m" : "d"}-${gi}`} className="mb-1.5 px-2.5 text-[11px] font-semibold tracking-[.08em] text-zinc-500 uppercase">
              {g.label}
            </p>
          )}
          <div className="flex flex-col gap-0.5">
            {g.items.map((it) => (
              <NavLink
                key={it.path}
                href={navHref(base, it)}
                exact={it.exact}
                icon={it.icon}
                badge={badges[it.path]}
                onNavigate={onNavigate}
                large={large}
                hoverable={hoverable}
              >
                {it.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Small screens: a "Menu" button opening the same grouped navigation in a side sheet
 * (modal <dialog>: focus stays inside, Escape closes, focus returns to the button).
 */
export function MobileMenu({ base, badges, header, footer }: { base: string; badges?: Record<string, ReactNode>; header?: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const path = usePathname();
  const current = NAV_GROUPS.flatMap((g) => g.items).find((it) => isActive(path, navHref(base, it), it.exact));

  // Close when the route changes (e.g. browser back while open).
  useEffect(() => {
    ref.current?.close();
  }, [path]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="mobile-nav"
        onClick={() => {
          ref.current?.showModal();
          setOpen(true);
        }}
        className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg bg-white px-3 text-sm font-medium text-zinc-800 shadow-[var(--shadow-card)] transition hover:bg-zinc-50"
      >
        <Menu className="h-4 w-4" aria-hidden />
        <span>Menu</span>
        {current && <span className="sr-only">, page actuelle : {current.label}</span>}
      </button>
      <dialog
        ref={ref}
        id="mobile-nav"
        aria-label="Navigation"
        onClose={() => {
          setOpen(false);
          btn.current?.focus();
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget) ref.current?.close();
        }}
        className="fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(20rem,86vw)] max-w-none bg-[#f7f8fa] p-0 text-zinc-900 shadow-[0_24px_64px_-16px_rgba(16,24,40,.45)] backdrop:bg-zinc-950/40 backdrop:backdrop-blur-[2px]"
      >
        <div className="flex h-full flex-col">
          <div className="flex items-center gap-2 border-b border-zinc-200/70 px-4 py-3">
            <div className="min-w-0 flex-1">{header}</div>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              aria-label="Fermer le menu"
              className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-zinc-600 hover:bg-zinc-900/[.05] hover:text-zinc-900"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </div>
          <nav aria-label="Navigation principale" className="flex-1 overflow-y-auto px-4 py-4">
            <NavGroups base={base} badges={badges} onNavigate={() => ref.current?.close()} large />
          </nav>
          {footer && <div className="border-t border-zinc-200/70 px-4 py-3">{footer}</div>}
        </div>
      </dialog>
    </>
  );
}

/**
 * Desktop sidebar navigation: scrolls when the window is short. The active link is brought into
 * view on load and on navigation, and a fade at the bottom (top) edge says there is more below (above).
 */
export function SidebarNav({ base, badges }: { base: string; badges?: Record<string, ReactNode> }) {
  const ref = useRef<HTMLElement>(null);
  const pathname = usePathname();
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const top = el.scrollTop > 2;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 2;
      setEdges((e) => (e.top === top && e.bottom === bottom ? e : { top, bottom }));
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);
  useEffect(() => {
    const el = ref.current;
    const active = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!el || !active) return;
    const box = el.getBoundingClientRect();
    const a = active.getBoundingClientRect();
    // Only the nav scrolls (never the page), with room for the fade.
    if (a.bottom > box.bottom - 24) el.scrollTop += a.bottom - box.bottom + 32;
    else if (a.top < box.top + 8) el.scrollTop -= box.top - a.top + 16;
  }, [pathname]);
  const mask =
    edges.top || edges.bottom
      ? `linear-gradient(to bottom, ${edges.top ? "transparent 0, #000 24px" : "#000 0"}, ${edges.bottom ? "#000 calc(100% - 32px), transparent 100%" : "#000 100%"})`
      : undefined;
  return (
    <nav ref={ref} aria-label="Navigation principale" className="-mx-1 flex-1 overflow-y-auto px-1 [scrollbar-width:thin]" style={mask ? { maskImage: mask, WebkitMaskImage: mask } : undefined}>
      <NavGroups base={base} badges={badges} />
    </nav>
  );
}
