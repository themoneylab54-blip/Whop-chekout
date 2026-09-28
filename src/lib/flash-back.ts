/*
 * Return URL of a dashboard form: the page the form was submitted from (period, filters and
 * tab kept) with the outcome message. Flash markers never reuse the reserved control params
 * (`range`, `from`, `to`, …): `?from=ct` used to be read as an invalid custom start date.
 */

const FLASH_KEYS = ["ok", "error", "flash", "field", "form"];

/**
 * `back` (a link of the same page, from a hidden form field) when it stays under `base`,
 * else `fallback`; previous flash params are dropped, `params` set, `hash` appended.
 */
export function flashBack(back: unknown, base: string, fallback: string, params: Record<string, string | undefined>, hash = ""): string {
  const raw = typeof back === "string" ? back : "";
  const safe = raw === base || raw.startsWith(`${base}?`) ? raw : fallback;
  const url = new URL(safe, "http://local");
  for (const k of FLASH_KEYS) url.searchParams.delete(k);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") url.searchParams.delete(k);
    else url.searchParams.set(k, v);
  }
  const q = url.searchParams.toString();
  return `${url.pathname}${q ? `?${q}` : ""}${hash}`;
}
