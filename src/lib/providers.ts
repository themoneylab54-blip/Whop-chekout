import "server-only";
import { db } from "./db";
import { log, recordEvent } from "./log";
import {
  BUCKET_MS,
  DEGRADED_ERROR_RATE,
  DEGRADED_MIN_CALLS,
  flushProviderMetrics,
  PROVIDER_LABELS,
  providerDegraded,
  providerStats,
  type ProviderStats,
} from "./metrics";

/*
 * External providers' health, from the ProviderMetric rollup (metrics.ts): the /api/health
 * `providers` section, the "Services externes" card of the Journal page, and the alert when a
 * provider keeps failing for 15 minutes.
 */

const HOUR = 3600_000;

export type ProviderHealth = ProviderStats & { degraded: string | null };

/** Last hour per provider, with why it is degraded (error rate > 20 % over ≥ 10 calls, or p95 > 8 s). */
export async function providersHealth(now = Date.now()): Promise<ProviderHealth[]> {
  return (await providerStats(HOUR, now)).map((s) => ({ ...s, degraded: providerDegraded(s) }));
}

export type ProviderOverview = { provider: string; label: string; hour: ProviderHealth | null; day: ProviderStats };

/** Journal card: each provider seen in 24 h, with its last hour and its last 24 h. */
export async function providersOverview(now = Date.now()): Promise<ProviderOverview[]> {
  const [hour, day] = await Promise.all([providersHealth(now), providerStats(24 * HOUR, now)]);
  return day.map((d) => ({ provider: d.provider, label: d.label, hour: hour.find((h) => h.provider === d.provider) ?? null, day: d }));
}

/** A provider stays failing: sustained over the 15-minute window. */
export const SUSTAINED_MS = 15 * 60_000;
/** One alert per provider at most this often. */
export const PROVIDER_ALERT_EVERY_MS = HOUR;

type Bucket = { bucket: Date; calls: number; errors: number };

/**
 * Whether a provider's error rate stayed high for the last 15 minutes: over the buckets of the window,
 * at least DEGRADED_MIN_CALLS calls with more than 20 % errors overall, every bucket with calls above
 * 20 % too, and failing since the window's first 5 minutes (not a burst that just started). Pure.
 */
export function sustainedFailure(buckets: Bucket[], now = Date.now()): { calls: number; errors: number } | null {
  const from = now - SUSTAINED_MS;
  const inWindow = buckets.filter((b) => b.calls > 0 && b.bucket.getTime() + BUCKET_MS > from && b.bucket.getTime() <= now);
  const calls = inWindow.reduce((a, b) => a + b.calls, 0);
  const errors = inWindow.reduce((a, b) => a + b.errors, 0);
  if (calls < DEGRADED_MIN_CALLS || errors / calls <= DEGRADED_ERROR_RATE) return null;
  if (inWindow.some((b) => b.errors / b.calls <= DEGRADED_ERROR_RATE)) return null;
  const first = Math.min(...inWindow.map((b) => b.bucket.getTime()));
  if (first > from + BUCKET_MS) return null;
  return { calls, errors };
}

/**
 * Providers failing for the last 15 minutes (sustainedFailure over the ProviderMetric buckets), with
 * their last error (already scrubbed when written). Read-only and DB-only: used by the watchProviders
 * job (alert) and by /api/health (shown even when the tick is late).
 */
export async function sustainedFailures(now = Date.now()): Promise<{ provider: string; calls: number; errors: number; lastError: string | null }[]> {
  const rows = await db.providerMetric.findMany({
    where: { bucket: { gte: new Date(Math.floor((now - SUSTAINED_MS) / BUCKET_MS) * BUCKET_MS) } },
    select: { provider: true, bucket: true, calls: true, errors: true, lastError: true, lastErrorAt: true },
  });
  const out: { provider: string; calls: number; errors: number; lastError: string | null }[] = [];
  for (const provider of [...new Set(rows.map((r) => r.provider))]) {
    const mine = rows.filter((r) => r.provider === provider);
    const failing = sustainedFailure(mine, now);
    if (!failing) continue;
    const lastError = mine.filter((r) => r.lastErrorAt).sort((a, b) => b.lastErrorAt!.getTime() - a.lastErrorAt!.getTime())[0]?.lastError ?? null;
    out.push({ provider, ...failing, lastError });
  }
  return out;
}

/**
 * Background job: alerts (journal + Telegram / e-mail, at most hourly per provider) when an external
 * provider's error rate stays above 20 % for 15 minutes. Platform-level (not one store's): sent through
 * the first store with alert channels, like the tick's own failures. Returns the alerts sent.
 */
export async function watchProviders(_deadline: number, now = Date.now()): Promise<number> {
  await flushProviderMetrics();
  let sent = 0;
  for (const { provider, calls, errors, lastError: last } of await sustainedFailures(now)) {
    const failing = { calls, errors };
    const key = `provider-alert:${provider}`;
    const cutoff = new Date(now - PROVIDER_ALERT_EVERY_MS).toISOString();
    const claimed = await db.$executeRaw`
      INSERT INTO "AppSetting" ("key", "value", "updatedAt") VALUES (${key}, ${new Date(now).toISOString()}, now())
      ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updatedAt" = now()
      WHERE "AppSetting"."value" < ${cutoff}`;
    if (!claimed) continue;
    const label = PROVIDER_LABELS[provider] ?? provider;
    const message = `${label} répond mal depuis 15 min : ${Math.round((100 * failing.errors) / failing.calls)} % d'erreurs sur ${failing.calls} appels${last ? ` (dernière : ${last})` : ""}. Les relances automatiques continuent ; détail dans Journal › Services externes.`;
    const store = await db.store.findFirst({
      where: { OR: [{ alertEmail: { not: null } }, { telegramChatId: { not: null } }] },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (store) await recordEvent({ storeId: store.id, level: "warn", kind: "provider.degraded", message, data: { provider, calls: failing.calls, errors: failing.errors }, alert: true });
    else log.warn("provider.degraded", message, { provider });
    sent++;
  }
  return sent;
}
