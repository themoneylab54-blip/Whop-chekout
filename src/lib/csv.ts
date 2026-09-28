/*
 * CSV for Excel (FR) / Google Sheets: UTF-8 BOM, ";" separator, CRLF, every text cell quoted,
 * spreadsheet formulas neutralised (CSV injection guard), amounts as unquoted French numbers
 * ("64,90") so they can be summed.
 */

export type CsvNum = { num: string };

/** Cents → French number cell (64,90). */
export const csvMoney = (cents: number): CsvNum => ({ num: (cents / 100).toFixed(2).replace(".", ",") });
/** Fraction → percent cell with 2 decimals (0.2 → 20,00). */
export const csvPercent = (r: number | null | undefined): CsvNum | string => (r == null || !Number.isFinite(r) ? "" : { num: (r * 100).toFixed(2).replace(".", ",") });
/** Plain number cell (2 decimals max). */
export const csvNumber = (v: number | null | undefined, digits = 2): CsvNum | string =>
  v == null || !Number.isFinite(v) ? "" : { num: String(Number(v.toFixed(digits))).replace(".", ",") };

export function csvCell(v: unknown): string {
  if (v && typeof v === "object" && "num" in v) return String((v as CsvNum).num);
  const s = v == null ? "" : String(v);
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
}

export function csvText(header: string[], rows: unknown[][]): string {
  return "﻿" + [header.map(csvCell).join(";"), ...rows.map((r) => r.map(csvCell).join(";"))].join("\r\n");
}

export function csvResponse(filename: string, header: string[], rows: unknown[][]): Response {
  return new Response(csvText(header, rows), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "no-store",
    },
  });
}
