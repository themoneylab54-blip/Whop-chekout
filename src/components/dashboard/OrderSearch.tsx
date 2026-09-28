"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

/** Search box that updates the URL (?q=) 300 ms after the last keystroke, keeping the other filters. */
export function OrderSearch({ initial }: { initial: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [value, setValue] = useState(initial);
  const [pending, startTransition] = useTransition();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  function push(q: string) {
    const next = new URLSearchParams(params.toString());
    if (q.trim()) next.set("q", q.trim());
    else next.delete("q");
    next.delete("page");
    next.delete("ok");
    next.delete("error");
    const s = next.toString();
    startTransition(() => router.replace(`${pathname}${s ? `?${s}` : ""}`, { scroll: false }));
  }

  return (
    <form
      role="search"
      className="relative lg:w-80"
      onSubmit={(e) => {
        e.preventDefault();
        if (timer.current) clearTimeout(timer.current);
        push(value);
      }}
    >
      <label htmlFor="orders-q" className="sr-only">
        Rechercher une commande
      </label>
      <Search className={`pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 ${pending ? "animate-pulse text-indigo-500" : "text-zinc-500"}`} aria-hidden />
      <input
        id="orders-q"
        name="q"
        type="search"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => push(v), 300);
        }}
        placeholder="E-mail, n° de commande, paiement…"
        autoComplete="off"
        className="min-h-9 w-full rounded-lg border border-zinc-200 bg-white py-2 pr-3 pl-9 text-sm shadow-[0_1px_1px_rgba(16,24,40,.04)] outline-none placeholder:text-zinc-500 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-500/10"
      />
    </form>
  );
}
