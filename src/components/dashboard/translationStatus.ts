import { LANGS, type Lang } from "@/components/checkout/i18n";
import type { RecordTranslations } from "@/components/checkout/localize";

export type StatusField = {
  key: string;
  /** Base text (store language); empty = nothing to translate. */
  base: string | null | undefined;
  /** Automatic translation of the base text (e.g. "3 à 5 jours ouvrés"): counts as translated when it differs. */
  auto?: (text: string, lang: Lang) => string;
};

export type TranslationStatus = {
  base: Lang;
  /** Buyer languages (other than the base) where every base text has a translation. */
  done: Lang[];
  /** Number of buyer languages other than the base (5). */
  total: number;
  /** Nothing to translate (all base texts empty). */
  empty: boolean;
};

/** How far a dashboard record (order bump, shipping rate…) is translated. Pure. */
export function recordTranslationStatus(fields: StatusField[], i18n: unknown, baseLang: Lang): TranslationStatus {
  const t = (i18n && typeof i18n === "object" ? i18n : {}) as RecordTranslations;
  const langs = LANGS.map((l) => l.code).filter((c) => c !== baseLang);
  const todo = fields.filter((f) => f.base && f.base.trim());
  const done = langs.filter((lang) =>
    todo.every((f) => {
      const own = t[lang]?.[f.key];
      if (typeof own === "string" && own.trim()) return true;
      return !!f.auto && f.auto(f.base!, lang) !== f.base;
    }),
  );
  return { base: baseLang, done, total: langs.length, empty: todo.length === 0 };
}

/** "FR uniquement · 0/5 langues" / "Traduit 2/5 langues"; null when fully translated or nothing to translate. */
export function translationHintText(s: TranslationStatus): string | null {
  if (s.empty || s.done.length >= s.total) return null;
  return s.done.length === 0 ? `${s.base.toUpperCase()} uniquement · 0/${s.total} langues` : `Traduit ${s.done.length}/${s.total} langues`;
}
