/*
 * Bulk ad spend import (Croissance › Dépenses publicitaires): parses pasted / uploaded CSV
 * "jour;plateforme;campagne;montant[;devise]". Pure (shared by the browser preview and the
 * server action, which re-validates everything).
 *  - separators: ";" (Excel FR), tab, or "," (amounts with a decimal comma must then be quoted,
 *    though "12,50" split in two is recognised);
 *  - days: dd/mm/yyyy, dd-mm-yyyy, dd.mm.yyyy or yyyy-mm-dd;
 *  - amounts: "12,50", "12.50", "1 234,56", "1.234,56", "€ 12,50";
 *  - platforms: meta/facebook/instagram, tiktok, google/adwords, anything else = "Autre".
 */

export type SpendCsvRow = { line: number; day: string; platform: "meta" | "tiktok" | "google" | "other"; campaign: string; amountCents: number; currency: string | null };
export type SpendCsvError = { line: number; raw: string; message: string };

export const SPEND_CSV_MAX_LINES = 2000;

export function splitLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

function validDay(y: number, m: number, d: number): string | null {
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = new Date(`${iso}T12:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === iso ? iso : null;
}

/** "31/12/2026", "2026-12-31"… → "2026-12-31" or null. */
export function parseCsvDay(v: string): string | null {
  const s = v.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return validDay(+m[3], +m[2], +m[1]);
  return null;
}

/** "1 234,56 €" → 123456 cents, or null. */
export function parseCsvAmount(v: string): number | null {
  let s = v.replace(/[\s  €$£]/g, "").replace(/(EUR|USD|GBP|CHF)/gi, "");
  if (!s || !/^-?[\d.,]+$/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    // The last separator is the decimal one, the other groups thousands.
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = (s.match(/,/g) ?? []).length > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
  } else if ((s.match(/\./g) ?? []).length > 1) s = s.replace(/\./g, "");
  const x = Number(s);
  if (!Number.isFinite(x) || x < 0 || x > 1_000_000) return null;
  return Math.round(x * 100);
}

export function parseCsvPlatform(v: string): SpendCsvRow["platform"] | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  if (/facebook|^fb$|meta|instagram|^ig$/.test(s)) return "meta";
  if (/tiktok|^tt$/.test(s)) return "tiktok";
  if (/google|adwords|gads|youtube/.test(s)) return "google";
  return "other";
}

/**
 * Parses the whole text. `today` bounds the days (not in the future, 400 days max.).
 * Duplicate day × platform × campaign lines: the last one wins (reported).
 */
export function parseSpendCsv(text: string, today: string): { rows: SpendCsvRow[]; errors: SpendCsvError[] } {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const sample = lines.find((l) => l.trim()) ?? "";
  const sep = sample.includes(";") ? ";" : sample.includes("\t") ? "\t" : ",";
  const minDay = new Date(Date.parse(`${today}T12:00:00Z`) - 400 * 86_400_000).toISOString().slice(0, 10);
  const rows = new Map<string, SpendCsvRow>();
  const errors: SpendCsvError[] = [];
  let seen = 0;
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    let f = splitLine(raw, sep);
    // Header line.
    if (seen === 0 && !parseCsvDay(f[0] ?? "") && /jour|date|day/i.test(f[0] ?? "")) return;
    seen++;
    if (seen > SPEND_CSV_MAX_LINES) {
      if (seen === SPEND_CSV_MAX_LINES + 1) errors.push({ line, raw, message: `Plus de ${SPEND_CSV_MAX_LINES} lignes : le reste est ignoré.` });
      return;
    }
    // "12,50" split by a comma separator: glue the decimals back.
    if (sep === "," && f.length >= 5 && /^\d+$/.test(f[3]) && /^\d{1,2}$/.test(f[4])) f = [...f.slice(0, 3), `${f[3]},${f[4]}`, ...f.slice(5)];
    if (f.length < 4) return void errors.push({ line, raw, message: "4 colonnes attendues : jour ; plateforme ; campagne ; montant." });
    const day = parseCsvDay(f[0]);
    if (!day) return void errors.push({ line, raw, message: `Date invalide « ${f[0]} » (JJ/MM/AAAA ou AAAA-MM-JJ).` });
    if (day > today) return void errors.push({ line, raw, message: "Date dans le futur." });
    if (day < minDay) return void errors.push({ line, raw, message: "Date de plus de 400 jours." });
    const platform = parseCsvPlatform(f[1]);
    if (!platform) return void errors.push({ line, raw, message: "Plateforme manquante." });
    const campaign = f[2].trim();
    if (!campaign) return void errors.push({ line, raw, message: "Nom de campagne manquant." });
    if (campaign.length > 120) return void errors.push({ line, raw, message: "Nom de campagne trop long (120 caractères max.)." });
    const amountCents = parseCsvAmount(f[3]);
    if (amountCents == null) return void errors.push({ line, raw, message: `Montant invalide « ${f[3]} ».` });
    const cur = (f[4] ?? "").trim().toUpperCase();
    if (cur && !/^[A-Z]{3}$/.test(cur)) return void errors.push({ line, raw, message: `Devise invalide « ${f[4]} » (code ISO, ex. EUR, USD).` });
    const key = `${day}|${platform}|${campaign.toLowerCase()}`;
    if (rows.has(key)) errors.push({ line, raw, message: `Doublon de la ligne ${rows.get(key)!.line} : cette ligne la remplace.` });
    rows.set(key, { line, day, platform, campaign, amountCents, currency: cur || null });
  });
  return { rows: [...rows.values()], errors };
}
