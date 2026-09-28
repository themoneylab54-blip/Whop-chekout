/** Start of the window "last n days" (server components read the clock through this). */
export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 3600_000);
}

const parisFormat = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" });

/** "YYYY-MM-DD" of a moment in Paris. */
export function parisDay(d: Date): string {
  return parisFormat.format(d);
}

export function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every Paris day of the last n days, oldest first. */
export function lastDays(n: number): string[] {
  const today = parisDay(new Date());
  return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
}
