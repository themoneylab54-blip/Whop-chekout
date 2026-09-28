"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronDown, Languages } from "lucide-react";
import { LANGS, type Lang } from "@/components/checkout/i18n";
import { localizeDeliveryTime, RECORD_TEXT_MAX, type RecordTranslations } from "@/components/checkout/localize";
import { recordTranslationStatus, translationHintText } from "./translationStatus";

export type RecordField = {
  key: string;
  label: string;
  /** Base text (store language), shown greyed as the fallback. */
  base: string;
  long?: boolean;
  /** Automatic translation of the base text when left empty (e.g. "2-3 jours ouvrés"). */
  auto?: "deliveryTime";
};

/**
 * "Traductions" of a dashboard record (order bump, gift, shipping rate): the same UX as the
 * builder's Translations panel — one tab per buyer language, empty = the base text (or its
 * automatic translation). Serialized as JSON in a hidden `name` input of the surrounding form.
 */
export function RecordTranslationsEditor({
  name = "i18n",
  fields,
  initial,
  baseLang = "fr",
  onChange,
}: {
  name?: string | null;
  fields: RecordField[];
  initial?: unknown;
  baseLang?: Lang;
  /** Controlled use (inside a client editor): called with the cleaned translations. */
  onChange?: (v: RecordTranslations | undefined) => void;
}) {
  const langs = LANGS.filter((l) => l.code !== baseLang);
  const [lang, setLang] = useState<Lang>(langs[0].code);
  const [i18n, setI18n] = useState<RecordTranslations>(() => (initial && typeof initial === "object" ? (initial as RecordTranslations) : {}));
  const hidden = useRef<HTMLInputElement>(null);
  const keys = new Set(fields.map((f) => f.key));
  const count = (l: Lang) => Object.entries(i18n[l] ?? {}).filter(([k, v]) => keys.has(k) && v.trim()).length;
  const total = langs.reduce((s, l) => s + count(l.code), 0);
  const baseName = LANGS.find((l) => l.code === baseLang)?.label.toLowerCase() ?? baseLang;
  const hint = translationHintText(
    recordTranslationStatus(
      fields.map((f) => ({ key: f.key, base: f.base, auto: f.auto === "deliveryTime" ? localizeDeliveryTime : undefined })),
      i18n,
      baseLang,
    ),
  );

  // "Annuler" (form reset) restores the saved translations.
  useEffect(() => {
    const form = hidden.current?.form;
    if (!form) return;
    const onReset = () => setI18n(initial && typeof initial === "object" ? (initial as RecordTranslations) : {});
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [initial]);

  const set = (key: string, value: string) => {
    const next: RecordTranslations = { ...i18n, [lang]: { ...(i18n[lang] ?? {}), [key]: value } };
    setI18n(next);
    onChange?.(clean(next, keys));
    // Dirty tracking of the surrounding form listens to `input` events.
    queueMicrotask(() => hidden.current?.dispatchEvent(new Event("input", { bubbles: true })));
  };

  const input =
    "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none placeholder:text-zinc-500 focus:border-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500 focus-visible:outline-solid";
  const ring = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 focus-visible:outline-solid";

  return (
    <details data-record-translations className="group rounded-xl border border-zinc-200 bg-white">
      {name && <input ref={hidden} type="hidden" name={name} value={JSON.stringify(clean(i18n, keys) ?? {})} readOnly />}
      <summary className={`flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-semibold tracking-[.08em] text-zinc-600 uppercase [&::-webkit-details-marker]:hidden ${ring}`}>
        <Languages className="h-3.5 w-3.5" aria-hidden /> Traductions
        {total > 0 && (
          <span className="rounded-full bg-indigo-50 px-1.5 py-px text-[10px] font-semibold tracking-normal text-indigo-700 normal-case ring-1 ring-indigo-200">{total}</span>
        )}
        {hint && (
          <span className="rounded-full bg-amber-50 px-2 py-px text-[11px] font-medium tracking-normal text-amber-900 normal-case ring-1 ring-amber-600/25">{hint}</span>
        )}
        <ChevronDown className="ml-auto h-3.5 w-3.5 transition group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-3 border-t border-zinc-200 p-3">
        <p className="text-[11px] leading-relaxed text-zinc-600">
          Textes vus par les clients qui paient dans une autre langue que le {baseName}. Laissez vide pour garder le texte grisé. La commande Shopify garde le texte en {baseName}.
        </p>
        <div role="tablist" aria-label="Langue de la traduction" className="flex flex-wrap gap-1">
          {langs.map((l) => {
            const n = count(l.code);
            return (
              <button
                key={l.code}
                type="button"
                role="tab"
                aria-selected={lang === l.code}
                title={l.label}
                onClick={() => setLang(l.code)}
                className={`inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold uppercase transition ${ring} ${
                  lang === l.code ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-700 hover:bg-zinc-200"
                }`}
              >
                {l.code}
                {n > 0 && <span className={`text-[10px] font-medium ${lang === l.code ? "text-zinc-300" : "text-indigo-700"}`}>{n}</span>}
              </button>
            );
          })}
        </div>
        <div role="tabpanel" aria-label={LANGS.find((l) => l.code === lang)?.label} className="space-y-2.5">
          {fields.map((f) => {
            const placeholder = f.auto === "deliveryTime" ? localizeDeliveryTime(f.base, lang) : f.base;
            const value = i18n[lang]?.[f.key] ?? "";
            const props = { className: input, maxLength: RECORD_TEXT_MAX, value, placeholder, onChange: (e: { target: { value: string } }) => set(f.key, e.target.value) };
            return (
              <label key={f.key} className="block">
                <span className="mb-1 block text-xs font-medium text-zinc-700">{f.label}</span>
                {f.long ? <textarea rows={2} {...props} /> : <input {...props} />}
              </label>
            );
          })}
        </div>
      </div>
    </details>
  );
}

/** Non-empty translations of the given fields only; undefined when none. */
function clean(i18n: RecordTranslations, keys: Set<string>): RecordTranslations | undefined {
  const out: RecordTranslations = {};
  for (const [l, fields] of Object.entries(i18n) as [Lang, Record<string, string>][]) {
    const kept = Object.fromEntries(Object.entries(fields ?? {}).filter(([k, v]) => keys.has(k) && v.trim() !== ""));
    if (Object.keys(kept).length) out[l] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}
