import type { ReactNode } from "react";
import type { Lang } from "./i18n";

/**
 * Neutral full-page message for checkout links that can't be shown (unknown or
 * expired link, unexpected error). No store branding is known at this point, so it
 * stays sober: a lock, a title, a sentence and the next step.
 */
export function StatusPage({
  lang,
  eyebrow,
  title,
  body,
  children,
}: {
  lang: Lang;
  /** Small line above the title (e.g. the store name when known); omitted when empty. */
  eyebrow?: string | null;
  title: string;
  body: string;
  children?: ReactNode;
}) {
  return (
    <div lang={lang} className="wc-checkout flex min-h-full flex-col bg-white text-neutral-900" style={{ ["--focus" as string]: "#111827" }}>
      <title>{title}</title>
      <main className="mx-auto flex w-full max-w-[480px] flex-1 flex-col justify-center px-5 py-16">
        {eyebrow && <p className="mb-3 text-xs font-medium tracking-wide text-neutral-600 uppercase">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 text-base leading-relaxed text-neutral-700">{body}</p>
        {children && <div className="mt-8 flex flex-col gap-3 sm:flex-row">{children}</div>}
      </main>
    </div>
  );
}

export const statusPrimaryCls =
  "inline-flex min-h-12 items-center justify-center rounded-[10px] bg-neutral-900 px-5 text-sm font-semibold text-white transition hover:bg-neutral-800";
export const statusSecondaryCls =
  "inline-flex min-h-12 items-center justify-center rounded-[10px] border border-neutral-300 bg-white px-5 text-sm font-semibold text-neutral-900 transition hover:bg-neutral-50";
