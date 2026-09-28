/** Start of the window "last n days" (server components read the clock through this). */
export function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 3600_000);
}
