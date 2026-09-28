"use client";

import { useState } from "react";
import { ChevronDown, Languages } from "lucide-react";
import type { Block, BlockTranslations } from "@/lib/layout";
import { LANGS, type Lang } from "@/components/checkout/i18n";
import { emptyTextDefault, textFields, translateDefault, type TextField } from "@/components/checkout/localize";
import { RING } from "./ui";

const FIELD_LABELS: Record<string, string> = {
  title: "Titre",
  heading: "Titre",
  text: "Texte",
  body: "Texte",
  quote: "Citation",
  author: "Auteur",
  label: "Libellé",
  alt: "Texte alternatif",
  q: "Question",
  a: "Réponse",
  message: "Message",
  success: "Message une fois atteint",
  badge: "Badge",
  buttonText: "Bouton « Oui »",
  declineText: "Lien « Non merci »",
  caption: "Légende",
  placeholder: "Texte indicatif",
  subtext: "Sous-texte",
  question: "Question",
  claimText: "Instructions en cas de problème",
  usLabel: "Colonne « nous »",
  themLabel: "Colonne « les autres »",
  dividerLabel: "Séparateur",
  value: "Valeur",
};
const LONG_FIELDS = new Set(["body", "text", "quote", "a", "claimText"]);

/** "Élément 2 · Libellé", "Version B · Titre". */
function fieldLabel(f: TextField) {
  const parts = f.path.split(".");
  const index = parts.find((p) => /^\d+$/.test(p));
  const prefix = [parts[0] === "variantB" ? "Version B" : null, index != null ? `Élément ${Number(index) + 1}` : null].filter(Boolean).join(" · ");
  const name = FIELD_LABELS[f.prop] ?? f.prop;
  return prefix ? `${prefix} · ${name}` : name;
}

/** Keeps only non-empty translations of fields that still exist; undefined when none is left. */
function cleaned(i18n: BlockTranslations, paths: Set<string>): BlockTranslations | undefined {
  const out: BlockTranslations = {};
  for (const [lang, fields] of Object.entries(i18n) as [Lang, Record<string, string>][]) {
    const kept = Object.fromEntries(Object.entries(fields ?? {}).filter(([p, v]) => paths.has(p) && v.trim() !== ""));
    if (Object.keys(kept).length) out[lang] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Custom texts of a block that buyers in `lang` would read in the store's language: typed by
 * the merchant (not a shipped default, which is translated automatically), with letters (not
 * "4,9/5" or "10 000+"), not a person's name, and without a translation for `lang`.
 */
export function untranslatedCount(block: Block, lang: Lang): number {
  const own = block.i18n?.[lang] ?? {};
  return textFields(block.props).filter(
    (f) => f.prop !== "author" && /\p{L}{2}/u.test(f.value) && translateDefault(f.value, lang) === f.value && !own[f.path]?.trim(),
  ).length;
}

/**
 * "Traductions" of a block's texts, per buyer language. Empty = automatic: the shipped
 * default translated, or the base text as typed. Folded by default (like "Style du bloc").
 */
export function TranslationsEditor({ block, baseLang, onChange }: { block: Block; baseLang: Lang; onChange: (b: Block) => void }) {
  const langs = LANGS.filter((l) => l.code !== baseLang);
  const [lang, setLang] = useState<Lang>(langs[0].code);
  const fields = textFields(block.props);
  if (fields.length === 0) return null;
  const i18n = block.i18n ?? {};
  const paths = new Set(fields.map((f) => f.path));
  const count = (l: Lang) => Object.entries(i18n[l] ?? {}).filter(([p, v]) => paths.has(p) && v.trim()).length;
  const total = langs.reduce((s, l) => s + count(l.code), 0);
  const baseName = LANGS.find((l) => l.code === baseLang)?.label.toLowerCase() ?? baseLang;

  const set = (path: string, value: string) => {
    const next = { ...i18n, [lang]: { ...(i18n[lang] ?? {}), [path]: value } };
    const clean = cleaned(next, paths);
    const { i18n: _previous, ...rest } = block;
    void _previous;
    onChange((clean ? { ...rest, i18n: clean } : rest) as Block);
  };

  const input =
    "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none placeholder:text-zinc-500 focus:border-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500 focus-visible:outline-solid";

  return (
    <details className="group mt-3 rounded-xl border border-zinc-200">
      <summary className={`flex cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs font-semibold tracking-[.08em] text-zinc-600 uppercase ${RING}`}>
        <Languages className="h-3.5 w-3.5" aria-hidden /> Traductions
        {total > 0 && (
          <span className="rounded-full bg-indigo-50 px-1.5 py-px text-[10px] font-semibold tracking-normal text-indigo-700 normal-case ring-1 ring-indigo-200">
            {total}
          </span>
        )}
        <ChevronDown className="ml-auto h-3.5 w-3.5 transition group-open:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-3 border-t border-zinc-200 p-3">
        <p className="text-[11px] leading-relaxed text-zinc-600">
          Textes vus par les clients qui paient dans une autre langue que le {baseName}. Laissez vide pour garder le texte grisé (les textes par défaut sont traduits automatiquement).
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
                className={`inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-xs font-semibold uppercase transition ${RING} ${
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
            const auto = f.value.trim() ? translateDefault(f.value, lang) : (emptyTextDefault(block.type, f.path, lang) ?? "");
            const value = i18n[lang]?.[f.path] ?? "";
            const long = LONG_FIELDS.has(f.prop) || f.value.length > 70;
            return (
              <label key={f.path} className="block">
                <span className="mb-1 block text-xs font-medium text-zinc-700">{fieldLabel(f)}</span>
                {long ? (
                  <textarea className={input} rows={2} maxLength={2000} value={value} placeholder={auto} onChange={(e) => set(f.path, e.target.value)} />
                ) : (
                  <input className={input} maxLength={2000} value={value} placeholder={auto} onChange={(e) => set(f.path, e.target.value)} />
                )}
              </label>
            );
          })}
        </div>
      </div>
    </details>
  );
}
