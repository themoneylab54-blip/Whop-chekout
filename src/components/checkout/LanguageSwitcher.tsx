"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Globe } from "lucide-react";
import { LANG_COOKIE, LANGS, isLang, type Lang } from "./i18n";

/**
 * Compact language picker in the checkout footer. The choice is remembered for this
 * checkout origin (cookie, read by the server on /c pages) and put in the URL (?lang=),
 * so a reload, the thank-you page and a shared link keep the same language.
 */
export function LanguageSwitcher({ lang, label }: { lang: Lang; label: string }) {
  const router = useRouter();
  const id = useId();
  const [value, setValue] = useState<Lang>(lang);
  const [pending, startTransition] = useTransition();
  const shown = pending ? value : lang;
  return (
    <div className="flex items-center gap-1.5 text-neutral-600">
      <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <select
        id={id}
        value={shown}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          if (!isLang(next)) return;
          setValue(next);
          try {
            document.cookie = `${LANG_COOKIE}=${next}; path=/c; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
          } catch {
            /* cookies blocked: the URL still carries the choice */
          }
          document.documentElement.lang = next;
          const url = new URL(window.location.href);
          url.searchParams.set("lang", next);
          startTransition(() => router.replace(`${url.pathname}${url.search}${url.hash}`, { scroll: false }));
        }}
        className="min-h-11 cursor-pointer rounded-sm bg-transparent pr-1 text-xs text-neutral-700 underline underline-offset-2 hover:no-underline disabled:opacity-60"
      >
        {LANGS.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </div>
  );
}
