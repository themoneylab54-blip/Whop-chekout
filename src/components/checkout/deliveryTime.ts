import type { Lang } from "./i18n-core";

/*
 * Shipping delays typed in French ("2 à 3 jours ouvrés") put in the buyer's language, apart from the
 * block texts of localize (re-exported there): the payment page shows the rates' delays without
 * downloading every block default. Pure.
 */

const UNITS: Record<Exclude<Lang, "fr">, Record<"business" | "days" | "weeks", [string, string]>> = {
  en: { business: ["business day", "business days"], days: ["day", "days"], weeks: ["week", "weeks"] },
  de: { business: ["Werktag", "Werktage"], days: ["Tag", "Tage"], weeks: ["Woche", "Wochen"] },
  es: { business: ["día hábil", "días hábiles"], days: ["día", "días"], weeks: ["semana", "semanas"] },
  it: { business: ["giorno lavorativo", "giorni lavorativi"], days: ["giorno", "giorni"], weeks: ["settimana", "settimane"] },
  nl: { business: ["werkdag", "werkdagen"], days: ["dag", "dagen"], weeks: ["week", "weken"] },
};

const FR_DELAY = /^(\d{1,3})(?:\s*(?:à|a|-|–|—)\s*(\d{1,3}))?\s*(jours?\s+ouvr(?:é|e|able)s?|jours?|j|semaines?|h|heures?)$/i;

/**
 * "2 à 3 jours ouvrés" → "2–3 business days" (EN), "2–3 Werktage" (DE)… Texts that are not
 * a plain French delay come back unchanged, and French stays as typed.
 */
export function localizeDeliveryTime(text: string, lang: Lang): string {
  if (lang === "fr" || !text) return text;
  const m = FR_DELAY.exec(text.trim());
  if (!m) return text;
  const [, from, to, unitRaw] = m;
  const range = to && to !== from ? `${from}–${to}` : from;
  const unit = unitRaw.toLowerCase();
  if (unit === "h" || unit.startsWith("heure")) return `${range} h`;
  const kind = unit.startsWith("semaine") ? "weeks" : /ouvr/.test(unit) ? "business" : "days";
  const [one, many] = UNITS[lang][kind];
  return `${range} ${range === "1" ? one : many}`;
}
