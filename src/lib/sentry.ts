import "server-only";
import { after } from "next/server";
import { scrub } from "./metrics";

/*
 * Optional external error tracking. When SENTRY_DSN is set, unexpected server errors (an unhandled
 * error in a route(), a background tick job failing) are sent to Sentry through its HTTP envelope API
 * with a plain fetch (no SDK dependency), and so is every `log.error` line carrying an `err` (upsell.error,
 * webhook.failed, *.deferred_failed, tick.follow_up_failed…: see forwardLoggedError). Sampled (SENTRY_SAMPLE_RATE, default 1) and deduplicated
 * (the same error at most once a minute per instance). No personal data: only the error's type, its
 * message and stack scrubbed of e-mails, tokens and long numbers, the route / job name, the request
 * id and the environment — never a request body, a buyer, an address or a header. Never throws, never
 * waits more than 2 s.
 */

type Dsn = { url: string; publicKey: string; dsn: string };

/** "https://<key>@<host>/<project>" → the envelope endpoint and key, or null when malformed. Pure. */
export function parseDsn(dsn: string | undefined | null): Dsn | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn.trim());
    const project = u.pathname.split("/").filter(Boolean).pop();
    if (!u.username || !project || !/^\d+$/.test(project) || !/^https?:$/.test(u.protocol)) return null;
    const prefix = u.pathname.slice(0, u.pathname.lastIndexOf(`/${project}`));
    return { url: `${u.protocol}//${u.host}${prefix}/api/${project}/envelope/`, publicKey: u.username, dsn: dsn.trim() };
  } catch {
    return null;
  }
}

export type ErrorContext = {
  where: string;
  route?: string | null;
  job?: string | null;
  requestId?: string | null;
  /** Sentry grouping key (e.g. the journal kind), instead of Sentry's default grouping by stack trace. */
  fingerprint?: string[];
  /** Sentry level (default "error"). */
  level?: "error" | "warning";
};

type Frame = { function?: string; filename?: string; lineno?: number; colno?: number; in_app?: boolean };

/** Stack frames in Sentry's order (oldest first), paths kept, arguments never. Pure. */
export function stackFrames(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n").slice(1, 30)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const filename = m[2].replace(/^file:\/\//, "");
    frames.push({ function: m[1] ?? "?", filename, lineno: Number(m[3]), colno: Number(m[4]), in_app: !filename.includes("node_modules") && !filename.startsWith("node:") });
  }
  return frames.reverse();
}

/**
 * The envelope Sentry expects for one error event (scrubbed), or — with `message` — for a message event
 * (a journal entry at level error that carries no error object). Pure.
 */
export function buildEnvelope(
  err: unknown,
  ctx: ErrorContext,
  opts: { dsn: string; eventId: string; now: Date; environment?: string; release?: string; message?: string },
): string {
  const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : "Non-Error thrown");
  const body =
    opts.message != null
      ? { message: { formatted: scrub(opts.message).slice(0, 1000) } }
      : { exception: { values: [{ type: scrub(e.name || "Error").slice(0, 100), value: scrub(e.message || ""), stacktrace: { frames: stackFrames(e.stack) } }] } };
  const event = {
    event_id: opts.eventId,
    timestamp: opts.now.getTime() / 1000,
    platform: "node",
    level: ctx.level ?? "error",
    ...(ctx.fingerprint?.length ? { fingerprint: ctx.fingerprint } : {}),
    logger: "whop-checkout",
    environment: opts.environment ?? "production",
    ...(opts.release ? { release: opts.release } : {}),
    transaction: ctx.where,
    tags: { where: ctx.where, ...(ctx.route ? { route: ctx.route } : {}), ...(ctx.job ? { job: ctx.job } : {}) },
    ...(ctx.requestId ? { extra: { requestId: ctx.requestId } } : {}),
    ...body,
  };
  const header = { event_id: opts.eventId, sent_at: opts.now.toISOString(), dsn: opts.dsn };
  return `${JSON.stringify(header)}\n${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;
}

const recent = new Map<string, number>();
const DEDUPE_MS = 60_000;

/** Tests: forget the per-instance dedupe. */
export function resetSentryDedupe() {
  recent.clear();
}

/** Sends one unexpected error to Sentry when SENTRY_DSN is set. True when sent. Never throws. */
export async function captureException(err: unknown, ctx: ErrorContext): Promise<boolean> {
  const e = err instanceof Error ? err : null;
  return send(err, ctx, `${ctx.where}|${e?.name ?? typeof err}|${scrub(String(e?.message ?? err)).slice(0, 120)}`);
}

/**
 * Sends one message event to Sentry (a journal entry at level error without an error object), grouped by
 * `ctx.fingerprint` (the journal kind). Sampled and deduplicated per `where` + fingerprint (the message
 * varies per order: never one event per order). True when sent. Never throws.
 */
export async function captureMessage(message: string, ctx: ErrorContext): Promise<boolean> {
  return send(null, ctx, `msg|${ctx.where}|${(ctx.fingerprint ?? []).join("/")}`, message);
}

async function send(err: unknown, ctx: ErrorContext, dedupeKey: string, message?: string): Promise<boolean> {
  try {
    const dsn = parseDsn(process.env.SENTRY_DSN);
    if (!dsn) return false;
    const rate = Number(process.env.SENTRY_SAMPLE_RATE ?? "1");
    if (Number.isFinite(rate) && rate < 1 && Math.random() >= Math.max(0, rate)) return false;
    const last = recent.get(dedupeKey);
    if (last && Date.now() - last < DEDUPE_MS) return false;
    if (recent.size > 500) recent.clear();
    recent.set(dedupeKey, Date.now());
    const body = buildEnvelope(err, ctx, {
      message,
      dsn: dsn.dsn,
      eventId: crypto.randomUUID().replace(/-/g, ""),
      now: new Date(),
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      release: process.env.VERCEL_GIT_COMMIT_SHA,
    });
    const res = await fetch(dsn.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-sentry-envelope",
        "X-Sentry-Auth": `Sentry sentry_version=7, sentry_key=${dsn.publicKey}, sentry_client=whop-checkout/1.0`,
      },
      body,
      signal: AbortSignal.timeout(2_000),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Captures started from log lines, not yet settled (the tick awaits them before returning). */
const pending = new Set<Promise<unknown>>();

/** Log kinds already captured explicitly, with a better context (route(), the tick's job failures). */
const CAPTURED_ELSEWHERE = new Set(["api.unhandled", "tick.job_failed"]);

/**
 * A `log.error` line carrying an error (`err` field): forwarded to Sentry when SENTRY_DSN is set —
 * sampled, deduplicated and scrubbed like every capture (captureException). Not a deadline refusal
 * (not a failure) nor a kind already captured elsewhere. Kept alive past the answer (after()), and
 * awaited by the tick (flushCaptures). Never throws, never blocks the caller.
 */
export function forwardLoggedError(kind: string, err: unknown, ctx: Record<string, unknown>, opts: { level?: "error" | "warning"; fingerprint?: string[] } = {}): boolean {
  try {
    if (err == null || CAPTURED_ELSEWHERE.has(kind) || !parseDsn(process.env.SENTRY_DSN)) return false;
    if (err instanceof Error && err.name === "DeadlineError") return false;
    keep(captureException(err, { ...contextOf(kind, ctx), ...opts }));
    return true;
  } catch {
    return false;
  }
}

/**
 * A journal entry at level error that carries no error object (payment.duplicate, dispute.lost, a starved
 * money job…): forwarded to Sentry as a message event fingerprinted by its kind — sampled, deduplicated
 * (once a minute per kind and instance), scrubbed. Not a kind already captured elsewhere. Never throws.
 */
export function forwardLoggedMessage(kind: string, message: string, ctx: Record<string, unknown>): boolean {
  try {
    if (CAPTURED_ELSEWHERE.has(kind) || !parseDsn(process.env.SENTRY_DSN)) return false;
    keep(captureMessage(message, { ...contextOf(kind, ctx), fingerprint: [kind] }));
    return true;
  } catch {
    return false;
  }
}

function contextOf(kind: string, ctx: Record<string, unknown>): ErrorContext {
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return { where: `log:${kind}`, route: str(ctx.route), job: str(ctx.job), requestId: str(ctx.requestId) };
}

/** Kept alive past the answer (after()), and awaited by the tick (flushCaptures). */
function keep(capture: Promise<unknown>) {
  const p: Promise<unknown> = capture.finally(() => pending.delete(p));
  pending.add(p);
  try {
    after(() => p);
  } catch {
    /* no request scope (tick run outside a request, script): flushCaptures awaits it */
  }
}

/** Waits for the captures started from log lines (bounded by captureException's own 2 s timeout). */
export async function flushCaptures(): Promise<void> {
  if (pending.size) await Promise.allSettled([...pending]);
}
