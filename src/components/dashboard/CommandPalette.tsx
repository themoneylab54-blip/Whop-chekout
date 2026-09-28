"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, CornerDownLeft, Hash, Loader2, Plus, Receipt, Search, Store } from "lucide-react";
import { searchOrdersAction, type OrderSearchHit } from "@/app/dashboard/actions";
import { NAV_GROUPS, NAV_SECTIONS, navHref, sectionHref } from "./nav";
import { stableCents } from "./stableFormat";
import { SECTION_FOCUS_EVENT } from "./HashFocus";

const OPEN_EVENT = "command-palette:open";

type Item = { key: string; group: string; label: string; hint?: string; href: string; icon: ReactNode };

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const STATUS: Record<string, string> = { PAID: "Payée", PAYING: "Paiement en cours", OPEN: "Checkout ouvert", FAILED: "Échouée", ABANDONED: "Abandonnée" };
/** Sessions without an order: their own group, titled by what happened (never a bare "Checkout"). */
const CHECKOUT_LABEL: Record<string, string> = { OPEN: "Checkout en cours", PAYING: "Paiement en cours", FAILED: "Paiement échoué", ABANDONED: "Checkout abandonné" };

const noop = () => () => {};
/** Group names become ids (aria-labelledby is a space-separated list: no spaces). */
const groupSlug = (name: string) => name.normalize("NFD").replace(/[^\w]+/g, "-").toLowerCase();
/** "⌘" on Apple devices, "Ctrl" elsewhere (and on the server, then corrected after hydration). */
function useModKey() {
  return useSyncExternalStore(
    noop,
    () => (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? "⌘" : "Ctrl"),
    () => "Ctrl",
  );
}

/** Opens the palette from anywhere (sidebar button, mobile header). */
export function CommandPaletteTrigger({ variant = "sidebar" }: { variant?: "sidebar" | "icon" }) {
  const mod = useModKey();
  const open = () => window.dispatchEvent(new Event(OPEN_EVENT));
  if (variant === "icon")
    return (
      <button
        type="button"
        onClick={open}
        aria-label="Rechercher (pages, commandes, boutiques)"
        aria-haspopup="dialog"
        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white text-zinc-700 shadow-[var(--shadow-card)] transition hover:bg-zinc-50"
      >
        <Search className="h-4 w-4" aria-hidden />
      </button>
    );
  return (
    <button
      type="button"
      onClick={open}
      aria-haspopup="dialog"
      aria-keyshortcuts="Meta+K Control+K"
      className="mb-4 flex min-h-9 w-full items-center gap-2 rounded-lg bg-white px-2.5 text-left text-sm text-zinc-500 shadow-[var(--shadow-card)] transition hover:text-zinc-800"
    >
      <Search className="h-4 w-4" aria-hidden />
      <span className="flex-1">Rechercher…</span>
      <kbd className="rounded border border-zinc-200 bg-zinc-50 px-1.5 font-sans text-[11px] leading-5 text-zinc-500">
        {mod} K
      </kbd>
    </button>
  );
}

/**
 * ⌘K / Ctrl+K command palette: jump to any page of the store, find an order by number or
 * e-mail, switch store. Modal dialog with an ARIA combobox driving a grouped listbox
 * (↑ ↓ to move, Enter to open, Escape to close).
 */
export function CommandPalette({ base, storeId, stores, tz = "Europe/Paris" }: { base: string; storeId: string; stores: { id: string; name: string }[]; tz?: string }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [orders, setOrders] = useState<OrderSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const seq = useRef(0);
  const id = useId();

  const show = useCallback(() => {
    if (dialog.current?.open) return;
    restoreFocus.current = document.activeElement as HTMLElement | null;
    setQ("");
    setOrders([]);
    setSearching(false);
    seq.current++;
    setActive(0);
    dialog.current?.showModal();
    setOpen(true);
    setTimeout(() => input.current?.focus(), 0);
  }, []);
  const close = () => dialog.current?.close();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (dialog.current?.open) dialog.current.close();
        else show();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, show);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, show);
    };
  }, [show]);

  // Orders: server search, debounced (the latest request wins).
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  function searchOrders(value: string) {
    clearTimeout(timer.current);
    const term = value.trim();
    const n = ++seq.current;
    if (term.length < 2) {
      setOrders([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    timer.current = setTimeout(() => {
      searchOrdersAction(storeId, term)
        .then((r) => n === seq.current && setOrders(r))
        .catch(() => n === seq.current && setOrders([]))
        .finally(() => n === seq.current && setSearching(false));
    }, 200);
  }

  const items = useMemo<Item[]>(() => {
    const term = norm(q.trim());
    const match = (...s: (string | undefined)[]) => !term || s.some((x) => x && norm(x).includes(term));
    const pages: Item[] = NAV_GROUPS.flatMap((g) =>
      g.items.map((it) => ({
        key: `page-${it.path}`,
        group: "Pages",
        label: it.label,
        hint: g.label ?? undefined,
        href: navHref(base, it),
        icon: <ArrowRight className="h-4 w-4" aria-hidden />,
      })),
    ).filter((it) => match(it.label, it.hint));
    // Sections inside pages (settings cards, analytics tabs…): only while searching, so the
    // idle list stays short.
    const sections: Item[] = term
      ? NAV_SECTIONS.filter((s) => match(s.label, s.page, s.keywords)).map((s) => ({
          key: `section-${s.path}-${s.hash ?? ""}-${s.label}`,
          group: "Sections",
          label: s.label,
          hint: s.page,
          href: sectionHref(base, s),
          icon: <Hash className="h-4 w-4" aria-hidden />,
        }))
      : [];
    const isOrder = (o: (typeof orders)[number]) => o.status === "PAID" || !!o.shopifyOrderName;
    const found: Item[] = [...orders.filter(isOrder), ...orders.filter((o) => !isOrder(o))].map((o) => ({
      key: `order-${o.id}`,
      group: isOrder(o) ? "Commandes" : "Checkouts sans commande",
      label: o.shopifyOrderName ?? (o.status === "PAID" ? "Commande payée" : (CHECKOUT_LABEL[o.status] ?? "Checkout")),
      hint: [o.name, o.email, stableCents(o.totalCents, o.currency), isOrder(o) ? STATUS[o.status] : undefined, new Date(o.createdAt).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: tz })].filter(Boolean).join(" · "),
      href: `${base}/orders/${o.id}`,
      icon: <Receipt className="h-4 w-4" aria-hidden />,
    }));
    const others: Item[] = stores
      .filter((s) => s.id !== storeId)
      .map((s) => ({ key: `store-${s.id}`, group: "Boutiques", label: s.name, hint: "Changer de boutique", href: `/dashboard/stores/${s.id}`, icon: <Store className="h-4 w-4" aria-hidden /> }))
      .filter((it) => match(it.label));
    const actions: Item[] = [
      { key: "new-store", group: "Boutiques", label: "Ajouter une boutique", href: "/dashboard/stores/new", icon: <Plus className="h-4 w-4" aria-hidden /> },
    ].filter((it) => match(it.label, "nouvelle boutique"));
    return [...found, ...pages, ...sections, ...others, ...actions];
  }, [q, orders, stores, storeId, base, tz]);

  const activeIndex = Math.min(active, Math.max(0, items.length - 1));
  const groups = items.reduce<{ name: string; items: { item: Item; index: number }[] }[]>((acc, item, index) => {
    const g = acc.find((x) => x.name === item.group) ?? (acc.push({ name: item.group, items: [] }), acc[acc.length - 1]);
    g.items.push({ item, index });
    return acc;
  }, []);

  useEffect(() => {
    if (open) document.getElementById(`${id}-opt-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open, id]);

  function go(item: Item | undefined) {
    if (!item) return;
    restoreFocus.current = null;
    close();
    router.push(item.href);
    // Focus follows the jump: the section's heading (or the page title), see HashFocus.
    window.dispatchEvent(new CustomEvent(SECTION_FOCUS_EVENT, { detail: item.href }));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!items.length) return;
      setActive((i) => (Math.min(i, items.length - 1) + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
    } else if (e.key === "Home" || e.key === "End") {
      if (!items.length || !e.ctrlKey) return;
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : items.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(items[activeIndex]);
    }
  }

  const listId = `${id}-list`;
  const term = q.trim();

  return (
    <dialog
      ref={dialog}
      aria-label="Recherche et navigation"
      onClose={() => {
        setOpen(false);
        restoreFocus.current?.focus?.();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="dash mx-auto mt-[12vh] mb-auto w-[min(36rem,calc(100vw-1.5rem))] max-w-none overflow-hidden rounded-2xl bg-white p-0 text-zinc-900 shadow-[0_24px_64px_-16px_rgba(16,24,40,.45),0_0_0_1px_rgba(16,24,40,.06)] backdrop:bg-zinc-950/40 backdrop:backdrop-blur-[2px] open:animate-fade-up"
    >
      <div className="flex items-center gap-2.5 border-b border-zinc-100 px-4">
        {searching ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-zinc-400" aria-hidden /> : <Search className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden />}
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={items.length ? listId : undefined}
          aria-autocomplete="list"
          aria-label="Rechercher une page, une commande (numéro, e-mail ou nom du client) ou une boutique"
          aria-activedescendant={items.length ? `${id}-opt-${activeIndex}` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            searchOrders(e.target.value);
          }}
          onKeyDown={onKeyDown}
          placeholder="Page, n° de commande, e-mail, nom…"
          // The dialog is the focus context: no ring around the search field itself.
          style={{ outline: "none" }}
          className="min-h-13 w-full bg-transparent text-[15px] placeholder:text-zinc-400"
        />
        <kbd className="hidden shrink-0 rounded border border-zinc-200 bg-zinc-50 px-1.5 text-[11px] leading-5 text-zinc-500 sm:block">Échap</kbd>
      </div>

      {items.length > 0 && (
        // The listbox itself scrolls (and is focusable by script) so keyboard users can reach
        // every row; mousedown keeps focus in the search field.
        <div
          id={listId}
          role="listbox"
          aria-label="Résultats"
          tabIndex={-1}
          onMouseDown={(e) => e.preventDefault()}
          className="max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain p-1.5 outline-none"
        >
          {groups.map((g) => (
            <div key={g.name} role="group" aria-labelledby={`${id}-g-${groupSlug(g.name)}`} className="pb-1">
              <p id={`${id}-g-${groupSlug(g.name)}`} className="px-2.5 pt-2 pb-1 text-[11px] font-semibold tracking-[.08em] text-zinc-500 uppercase">
                {g.name}
              </p>
              {g.items.map(({ item, index }) => (
                <div
                  key={item.key}
                  id={`${id}-opt-${index}`}
                  role="option"
                  aria-selected={index === activeIndex}
                  onClick={() => go(item)}
                  onMouseMove={() => index !== activeIndex && setActive(index)}
                  className={`flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm ${
                    index === activeIndex ? "bg-indigo-50 text-zinc-900" : "text-zinc-700"
                  }`}
                >
                  <span className={index === activeIndex ? "text-indigo-600" : "text-zinc-400"}>{item.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{item.label}</span>
                    {item.hint && <span className="block truncate text-xs text-zinc-600">{item.hint}</span>}
                  </span>
                  {index === activeIndex && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      {!items.length && (
        <p className="px-3 py-8 text-center text-sm text-zinc-500">
          {searching ? "Recherche des commandes…" : `Aucun résultat pour « ${term} ».`}
        </p>
      )}
      {term.length > 0 && term.length < 2 && <p className="px-4 pt-1 pb-2 text-xs text-zinc-500">Tapez au moins 2 caractères pour chercher dans les commandes.</p>}
      <p className="sr-only" aria-live="polite">
        {open && term.length >= 2 && !searching ? `${orders.length} commande${orders.length > 1 ? "s" : ""} trouvée${orders.length > 1 ? "s" : ""}` : ""}
      </p>
      <div className="hidden items-center gap-4 border-t border-zinc-100 px-4 py-2 text-[11px] text-zinc-500 sm:flex">
        <span>↑ ↓ pour naviguer</span>
        <span>Entrée pour ouvrir</span>
        <span>Échap pour fermer</span>
      </div>
    </dialog>
  );
}
