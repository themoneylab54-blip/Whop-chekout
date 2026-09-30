import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { LogOut, ShoppingBag, Store as StoreIcon, UserRound, Users } from "lucide-react";
import type { SessionUser } from "@/lib/auth";
import { roleAtLeast } from "@/lib/access";
import { logoutAction } from "@/app/dashboard/actions";
import { UserAvatar } from "./TeamBits";
import { FormDraftKeeper } from "./FormDraftKeeper";

/** Header links of the account-wide pages: the member (→ Profil), Équipe (admins and owners), sign out. */
export function UserMenu({ user }: { user: SessionUser }) {
  return (
    <div className="flex items-center gap-1">
      {roleAtLeast(user.role, "admin") && (
        <Link href="/dashboard/team" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-zinc-600 hover:bg-zinc-100" aria-label="Équipe">
          <Users className="h-4 w-4" aria-hidden /> <span className="hidden sm:inline">Équipe</span>
        </Link>
      )}
      <Link href="/dashboard/account" className="inline-flex min-h-9 max-w-[14rem] items-center gap-2 rounded-lg px-2 text-sm text-zinc-700 hover:bg-zinc-100" aria-label="Mon profil">
        <UserAvatar name={user.name} email={user.email} avatarUrl={user.avatarUrl} size={26} />
        <span className="hidden truncate sm:inline">{user.name || user.email}</span>
      </Link>
      <form action={logoutAction}>
        <button aria-label="Se déconnecter" title="Se déconnecter" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm text-zinc-600 hover:bg-zinc-100">
          <LogOut className="h-4 w-4" aria-hidden />
        </button>
      </form>
    </div>
  );
}

const TABS = [
  { href: "/dashboard", label: "Boutiques", icon: StoreIcon, min: "viewer" },
  { href: "/dashboard/account", label: "Profil", icon: UserRound, min: "viewer" },
  { href: "/dashboard/team", label: "Équipe", icon: Users, min: "admin" },
] as const;

/** Frame of the account-wide pages (Profil, Équipe): header with the member's menu and the page tabs. */
export function AccountShell({ user, active, children }: { user: SessionUser; active: "/dashboard/account" | "/dashboard/team"; children: ReactNode }) {
  return (
    <div className="dash min-h-full bg-[#f7f8fa]">
      <header className="border-b border-zinc-200/70 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/dashboard" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-white">
              <ShoppingBag className="h-4 w-4" aria-hidden />
            </span>
            <span className="hidden sm:inline">Whop Checkout</span>
          </Link>
          <UserMenu user={user} />
        </div>
        <nav aria-label="Compte" className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-4 sm:px-6">
          {TABS.filter((t) => roleAtLeast(user.role, t.min)).map((t) => {
            const current = t.href === active;
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={current ? "page" : undefined}
                className={`inline-flex min-h-10 items-center gap-1.5 border-b-2 px-3 text-sm font-medium whitespace-nowrap ${
                  current ? "border-indigo-600 text-zinc-900" : "border-transparent text-zinc-500 hover:text-zinc-800"
                }`}
              >
                <t.icon className="h-4 w-4" aria-hidden /> {t.label}
              </Link>
            );
          })}
        </nav>
      </header>
      <main id="contenu" className="mx-auto max-w-5xl px-4 py-6 sm:px-6 sm:py-8">
        {children}
      </main>
      {/* What was typed in a form comes back after an error (passwords excepted), the field at fault flagged. */}
      <Suspense fallback={null}>
        <FormDraftKeeper />
      </Suspense>
    </div>
  );
}
