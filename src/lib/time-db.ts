import "server-only";
import { db } from "./db";
import { DEFAULT_TZ, tzOf, validTimeZone } from "./time";

/*
 * A time zone the JavaScript runtime knows may still be unknown to Postgres (older tzdata, links),
 * and analytics inline the store's zone in SQL (AT TIME ZONE): an unknown one would make every
 * query fail. The settings only save zones Postgres knows, and queries fall back to the default.
 */

let known: Promise<Set<string>> | null = null;

/** Names in pg_timezone_names (read once per process). */
function pgTimeZones(): Promise<Set<string>> {
  if (!known) {
    known = db
      .$queryRaw<{ name: string }[]>`SELECT name FROM pg_timezone_names`
      .then((rows) => new Set(rows.map((r) => r.name)))
      .catch((err) => {
        known = null;
        throw err;
      });
  }
  return known;
}

/** Whether both the runtime and Postgres know this zone (what the settings accept). */
export async function isStorableTimeZone(tz: unknown): Promise<boolean> {
  return validTimeZone(tz) && (await pgTimeZones()).has(tz);
}

/** The store's zone for SQL: its own when Postgres knows it, else the default (Europe/Paris). */
export async function sqlTimeZone(store: { timezone?: string | null } | null | undefined): Promise<string> {
  const tz = tzOf(store);
  if (tz === DEFAULT_TZ) return tz;
  try {
    return (await pgTimeZones()).has(tz) ? tz : DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}
