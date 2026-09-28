/** Start of the window "last n days" (server components read the clock through this). */
export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 3600_000);
}

/*
 * Merchant days and hours. Every store has a time zone (Store.timezone, IANA name, default
 * Europe/Paris): analytics periods, daily series, the heatmap, reports and alerts count its days.
 */

export const DEFAULT_TZ = "Europe/Paris";

const dayFormats = new Map<string, Intl.DateTimeFormat>();
const partFormats = new Map<string, Intl.DateTimeFormat>();

/** Whether a string is an IANA time zone this runtime knows (and safe to inline in SQL). Pure. */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !/^[A-Za-z][A-Za-z0-9_+\-/]{1,63}$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A store's time zone, or the default when missing or unknown. Pure. */
export function tzOf(store: { timezone?: string | null } | null | undefined): string {
  return validTimeZone(store?.timezone) ? store!.timezone! : DEFAULT_TZ;
}

function dayFormat(tz: string): Intl.DateTimeFormat {
  let f = dayFormats.get(tz);
  if (!f) dayFormats.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })));
  return f;
}

function partFormat(tz: string): Intl.DateTimeFormat {
  let f = partFormats.get(tz);
  if (!f)
    partFormats.set(
      tz,
      (f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })),
    );
  return f;
}

/** "YYYY-MM-DD" of a moment in a time zone. */
export function zonedDay(d: Date, tz = DEFAULT_TZ): string {
  return dayFormat(tz).format(d);
}

/** Hour (0–23) of a moment in a time zone. */
export function zonedHour(d: Date, tz = DEFAULT_TZ): number {
  return Number(Object.fromEntries(partFormat(tz).formatToParts(d).map((x) => [x.type, x.value])).hour);
}

/** Offset of a time zone vs UTC at an instant, in ms. */
function offsetMs(at: Date, tz: string): number {
  const p = Object.fromEntries(partFormat(tz).formatToParts(at).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** UTC instant of 00:00 in a time zone on a "YYYY-MM-DD" day (DST-safe). */
export function zonedDayStart(day: string, tz = DEFAULT_TZ): Date {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const first = guess - offsetMs(new Date(guess), tz);
  // Re-evaluate at the candidate instant (the offset may differ on DST days).
  return new Date(guess - offsetMs(new Date(first), tz));
}

/** "YYYY-MM-DD" of a moment in Paris (the default time zone). */
export function parisDay(d: Date): string {
  return zonedDay(d, DEFAULT_TZ);
}

export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every day of the last n days in a time zone (Paris by default), oldest first. */
export function lastDays(n: number, tz = DEFAULT_TZ): string[] {
  const today = zonedDay(new Date(), tz);
  return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
}

/** Common IANA zones offered in the settings (any valid IANA name is accepted). */
export const TIME_ZONES = [
  "Europe/Paris",
  "Europe/Brussels",
  "Europe/Zurich",
  "Europe/Luxembourg",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Athens",
  "Africa/Casablanca",
  "Africa/Algiers",
  "Africa/Tunis",
  "Africa/Abidjan",
  "Africa/Dakar",
  "Indian/Reunion",
  "America/Martinique",
  "America/Guadeloupe",
  "America/Cayenne",
  "Pacific/Tahiti",
  "Pacific/Noumea",
  "America/Montreal",
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
] as const;

/** French names of the offered zones' cities (the others use the IANA city, underscores as spaces). */
const ZONE_CITY_FR: Record<string, string> = {
  "Europe/Brussels": "Bruxelles",
  "Europe/London": "Londres",
  "Europe/Lisbon": "Lisbonne",
  "Europe/Rome": "Rome",
  "Europe/Athens": "Athènes",
  "Africa/Algiers": "Alger",
  "Indian/Reunion": "La Réunion",
  "America/Cayenne": "Cayenne",
  "Pacific/Noumea": "Nouméa",
  "America/Montreal": "Montréal",
  "America/Sao_Paulo": "São Paulo",
  "Asia/Dubai": "Dubaï",
  "Asia/Singapore": "Singapour",
};

/**
 * Label of a store's time zone for the dashboard's day and hour mentions: "heure de Paris",
 * "heure de New York", "heure d'Amsterdam", "heure UTC". Pure.
 */
export function zoneLabel(tz: string | null | undefined): string {
  const zone = validTimeZone(tz) ? tz : DEFAULT_TZ;
  if (zone === "UTC" || zone === "Etc/UTC") return "heure UTC";
  const city = ZONE_CITY_FR[zone] ?? zone.split("/").pop()!.replace(/_/g, " ");
  return /^[AEIOUYÉÈÊaeiouyéèê]/.test(city) ? `heure d'${city}` : `heure de ${city}`;
}
