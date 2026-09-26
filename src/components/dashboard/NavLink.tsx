"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({ href, exact, icon, children }: { href: string; exact?: boolean; icon: ReactNode; children: ReactNode }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm transition ${active ? "bg-zinc-900 font-medium text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"}`}
    >
      <span className="w-4 text-center text-[13px]" aria-hidden>
        {icon}
      </span>
      {children}
    </Link>
  );
}
