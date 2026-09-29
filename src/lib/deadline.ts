import "server-only";
import { logContext } from "./log";

/**
 * Thrown instead of starting an external call that couldn't finish before the
 * function limit (background maintenance). Not a failure of the thing being done:
 * callers release their lease and retry next run, without counting an attempt,
 * journaling or alerting.
 */
export class DeadlineError extends Error {
  constructor(what: string) {
    super(`Temps de maintenance épuisé (${what}) : reporté au prochain passage`);
    this.name = "DeadlineError";
  }
}

/**
 * Milliseconds left for one external call in a bounded run, or null outside one: before the run's hard
 * deadline (`hardDeadline`, the function limit) and — inside a money job of the background tick — before
 * that job's own call deadline (`jobDeadline`: its time slice plus a short overrun), so one slow provider
 * can only spend its own job's slice, never the budget of the jobs after it. Every client (Shopify,
 * Whop, ad platforms, ECB) bounds its timeout with this and refuses to start a call that couldn't finish.
 */
export function timeLeft(): number | null {
  const ctx = logContext();
  const bounds = [ctx.hardDeadline, ctx.jobDeadline].filter((v): v is number => typeof v === "number");
  return bounds.length ? Math.min(...bounds) - Date.now() : null;
}

/** Milliseconds left before the run's hard deadline only (the function limit), or null outside a bounded run. */
export function hardTimeLeft(): number | null {
  const hard = logContext().hardDeadline;
  return typeof hard === "number" ? hard - Date.now() : null;
}

/** Throws DeadlineError when fewer than `needMs` remain in a bounded run. */
export function assertTime(needMs: number, what: string) {
  const left = timeLeft();
  if (left != null && left < needMs) throw new DeadlineError(what);
}

/**
 * Timeout for one external call inside a bounded run: never past the run's hard deadline nor the
 * current money job's deadline (1 s margin); DeadlineError when less than `minMs` remains. Outside a
 * bounded run: `ms`.
 */
export function boundedTimeout(ms: number, what: string, minMs = 3_000): number {
  const left = timeLeft();
  if (left == null) return ms;
  if (left < minMs) throw new DeadlineError(what);
  return Math.max(1_000, Math.min(ms, left - 1_000));
}

/**
 * Records, for the background run's report, that the current job stopped before its work was done
 * (time budget): the tick reports it as "skipped: partial" (counted with the skipped jobs), never as
 * a completed job. No-op outside a tick job.
 */
export function notePartial(): void {
  const holder = logContext().tickPartial as { partial?: boolean } | undefined;
  if (holder && typeof holder === "object") holder.partial = true;
}

/** Whether the current tick job was noted partial (a callee ran out of time). False outside a tick job. */
export function partialNoted(): boolean {
  const holder = logContext().tickPartial as { partial?: boolean } | undefined;
  return !!(holder && typeof holder === "object" && holder.partial);
}

/**
 * Loop guard of a bounded background job: true (and the job noted partial) when no new item may
 * start — the job's own deadline has passed, or fewer than `reserveMs` remain before the run's hard
 * deadline (inside a tick). The reserve is measured against the hard deadline, never against the
 * job's (short) deadline, so a job given a few seconds still starts its first item.
 */
export function stopForTime(deadline: number, reserveMs = 0): boolean {
  const left = hardTimeLeft();
  const stop = Date.now() > deadline || (left != null && left < reserveMs);
  if (stop) notePartial();
  return stop;
}

/* Per-run circuit breakers ------------------------------------------------------------------------ */

export type BreakerProvider = "whop" | "shopify" | "stripe";
/** Breakers of one background run (`breakers` in the log context): the provider that hung, and on which call. */
export type Breakers = Partial<Record<BreakerProvider, { at: number; what: string }>>;

function breakers(): Breakers | null {
  const b = logContext().breakers;
  return b && typeof b === "object" ? (b as Breakers) : null;
}

/**
 * Opens the run's breaker of a provider after a call that hung until its timeout: for the rest of the run
 * its calls are refused at once (DeadlineError, see assertBreakerClosed), so one hanging provider costs the
 * run a single timeout instead of one per job, and the jobs on the other provider still get their time.
 * No-op outside a background run (a buyer's request never trips anything). True when it opened now.
 */
export function tripBreaker(provider: BreakerProvider, what: string): boolean {
  const b = breakers();
  if (!b || b[provider]) return false;
  b[provider] = { at: Date.now(), what };
  return true;
}

/** Whether the run's breaker of `provider` is open (false outside a background run). */
export function breakerOpen(provider: BreakerProvider): boolean {
  return !!breakers()?.[provider];
}

/** Throws DeadlineError (not a failure: lease released, no try spent, job partial) when the provider's breaker is open. */
export function assertBreakerClosed(provider: BreakerProvider, what: string): void {
  if (breakerOpen(provider)) throw new DeadlineError(`${what} : ${provider === "whop" ? "Whop" : provider === "stripe" ? "Stripe" : "Shopify"} ne répond pas, appels suspendus pour ce passage`);
}

/** A fetch rejected because its time ran out (AbortSignal.timeout / the SDK's own timeout signal). Pure. */
export function isTimeoutError(err: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) return true;
  if (err === "timeout") return true;
  const name = err instanceof Error ? err.name : "";
  return name === "TimeoutError" || name === "AbortError";
}
