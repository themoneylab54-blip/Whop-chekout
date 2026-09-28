/** Human dates for detail pages and the journal (the store's time zone, Paris by default; fr-FR), built from parts so every runtime prints the same. */

const TZ = "Europe/Paris";
const formats = new Map<string, { fmt: Intl.DateTimeFormat; dayFmt: Intl.DateTimeFormat }>();

function formatsFor(tz: string) {
  let f = formats.get(tz);
  if (!f) {
    f = {
      fmt: new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: tz }),
      dayFmt: new Intl.DateTimeFormat("fr-FR", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz }),
    };
    formats.set(tz, f);
  }
  return f;
}

function parts(d: Date, tz: string) {
  const p = Object.fromEntries(formatsFor(tz).fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { day: p.day, month: p.month, year: p.year, time: `${p.hour}:${p.minute}` };
}

/** "28 sept. 2026, 14:05". */
export function formatDateTimeLong(d: Date, tz: string = TZ): string {
  const p = parts(d, tz);
  return `${p.day} ${p.month} ${p.year}, ${p.time}`;
}

/** "14:05" today, "27 sept., 14:05" this year, else "28 sept. 2025, 14:05". */
export function formatWhen(d: Date, now = new Date(), tz: string = TZ): string {
  const p = parts(d, tz);
  const { dayFmt } = formatsFor(tz);
  if (dayFmt.format(d) === dayFmt.format(now)) return p.time;
  if (p.year === parts(now, tz).year) return `${p.day} ${p.month}, ${p.time}`;
  return `${p.day} ${p.month} ${p.year}, ${p.time}`;
}

/** formatWhen with seconds ("14:05:09", "27 sept., 14:05:09"), for individual log occurrences. */
export function formatWhenPrecise(d: Date, now = new Date(), tz: string = TZ): string {
  return `${formatWhen(d, now, tz)}:${String(d.getUTCSeconds()).padStart(2, "0")}`;
}
