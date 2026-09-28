import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/*
 * Work that must happen, but not before answering a webhook: Whop times out and
 * redelivers when the answer is slow. Inside `collectDeferred`, `defer(task)` queues
 * the task for the caller to run after the response (Next's `after()`); anywhere
 * else it returns false and the caller runs the task inline. Every deferred task is
 * also backstopped by the background tick, so a cut-short `after()` loses nothing.
 */

type Task = { name: string; run: () => Promise<unknown> };
const queue = new AsyncLocalStorage<Task[]>();

export async function collectDeferred<T>(fn: () => Promise<T>): Promise<{ result: T; later: Task[] }> {
  const later: Task[] = [];
  const result = await queue.run(later, fn);
  return { result, later };
}

/** Queues the task when a collector is active; false = run it yourself now. */
export function defer(name: string, run: () => Promise<unknown>): boolean {
  const q = queue.getStore();
  if (!q) return false;
  q.push({ name, run });
  return true;
}

/** Runs queued tasks one by one; a failure never stops the others. */
export async function runDeferred(tasks: Task[], onError: (name: string, err: unknown) => void) {
  // Alerts first: they're fast and must not wait behind a slow Shopify call.
  const ordered = [...tasks.filter((t) => t.name.startsWith("alert.")), ...tasks.filter((t) => !t.name.startsWith("alert."))];
  for (const t of ordered) {
    try {
      await t.run();
    } catch (err) {
      onError(t.name, err);
    }
  }
}
