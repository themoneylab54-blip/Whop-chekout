import "server-only";
import { db } from "./db";

/* Fair ordering for the background jobs: rotating lists and per-store round robin. */

/**
 * Non-money jobs in this run's order: the list rotated by the persisted offset, so a job late in the
 * list isn't always the one left without time. Pure.
 */
export function rotateJobs<T>(jobs: T[], offset: number): T[] {
  if (!jobs.length) return jobs;
  const k = ((offset % jobs.length) + jobs.length) % jobs.length;
  return [...jobs.slice(k), ...jobs.slice(0, k)];
}

/**
 * Stores in this run's order for a per-store job: sorted by id, rotated by the job's persisted offset
 * (`tick-rotate:<job>`), so a store that is slow (or has a long backlog) doesn't always go first and
 * the stores after it get their turn. `advance(processed)`: the next run starts at the first store this
 * one didn't finish (or the next one when all were done). Never throws.
 */
export async function rotateStores<T extends { id: string }>(job: string, stores: T[]): Promise<{ list: T[]; advance: (processed: number) => Promise<void> }> {
  const key = `tick-rotate:${job}`;
  const sorted = [...stores].sort((a, b) => a.id.localeCompare(b.id));
  const offset = Number((await db.appSetting.findUnique({ where: { key } }).catch(() => null))?.value) || 0;
  return {
    list: rotateJobs(sorted, offset),
    advance: async (processed: number) => {
      if (sorted.length < 2) return;
      const value = String((offset + (processed >= sorted.length ? 1 : Math.max(1, processed))) % sorted.length);
      await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } }).catch(() => undefined);
    },
  };
}

/**
 * Due items interleaved one store at a time, in the given store order (each store's own items keep
 * their order): one store's poisoned or long backlog can only take its own turns, never the whole
 * batch. Items of a store missing from `storeOrder` come last. Pure.
 */
export function roundRobinByStore<T extends { storeId: string }>(items: T[], storeOrder: string[]): T[] {
  const byStore = new Map<string, T[]>();
  for (const it of items) {
    const list = byStore.get(it.storeId) ?? [];
    list.push(it);
    byStore.set(it.storeId, list);
  }
  const order = [...storeOrder.filter((id) => byStore.has(id)), ...[...byStore.keys()].filter((id) => !storeOrder.includes(id))];
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) {
    for (const id of order) {
      const it = byStore.get(id)![round];
      if (it) out.push(it);
    }
  }
  return out;
}

/**
 * A retry job's due items in a fair order: stores rotated from run to run (`tick-rotate:<job>`), their
 * items interleaved one store at a time. `advance()` moves the rotation once the run is over.
 */
export async function fairByStore<T extends { storeId: string }>(job: string, items: T[]): Promise<{ list: T[]; advance: () => Promise<void> }> {
  const stores = [...new Set(items.map((i) => i.storeId))].map((id) => ({ id }));
  const { list, advance } = await rotateStores(job, stores);
  return { list: roundRobinByStore(items, list.map((s) => s.id)), advance: () => advance(1) };
}
