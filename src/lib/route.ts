import "server-only";
import { after } from "next/server";
import { json } from "./http";
import { log, withLogContext } from "./log";
import { flushProviderMetrics } from "./metrics";
import { captureException } from "./sentry";

/**
 * Runs `fn` after the response (Next's after()), or right away in the background when there is no
 * request scope (scripts, tests). Never throws.
 */
export function afterResponse(fn: () => Promise<unknown>): void {
  const run = () => fn().catch(() => undefined);
  try {
    after(run);
  } catch {
    void run();
  }
}

/**
 * Wraps a route handler: every log line and journal entry written while handling
 * the request carries the route, Vercel's request id and the session id, so one
 * buyer's problem can be followed across logs. An unexpected error is logged with
 * that context and answered with a clean JSON 500 (with the id to search for).
 */
// Next type-checks a route's second argument against { params: Promise<…> }: keep it required.
export function route<C extends { params: Promise<Record<string, string>> } = { params: Promise<Record<string, string>> }>(
  name: string,
  handler: (req: Request, ctx: C) => Promise<Response>,
  opts: { cors?: boolean } = {},
) {
  return async (req: Request, ctx: C): Promise<Response> => {
    const requestId = req.headers.get("x-vercel-id") ?? crypto.randomUUID();
    const params: Record<string, string> = ctx?.params ? await ctx.params.catch(() => ({})) : {};
    const started = Date.now();
    // External calls made while handling: their metrics are written after the answer (one batch).
    const extCalls = { n: 0 };
    return withLogContext({ requestId, route: name, sessionId: params.id ?? null, extCalls }, async () => {
      let res: Response;
      try {
        res = await handler(req, ctx);
        if (res.status >= 500) log.warn("api.response_5xx", `${name} answered ${res.status}`, { status: res.status, ms: Date.now() - started });
        else if (res.status >= 400) log.info("api.response_4xx", `${name} answered ${res.status}`, { status: res.status, ms: Date.now() - started });
      } catch (err) {
        log.error("api.unhandled", `Unhandled error in ${name}`, { err, ms: Date.now() - started });
        // Optional external error tracking (SENTRY_DSN), after the answer, scrubbed of personal data.
        afterResponse(() => captureException(err, { where: `route:${name}`, route: name, requestId }));
        res = json({ error: "Erreur interne, réessayez dans un instant.", code: "server_error" }, { status: 500, cors: opts.cors });
      }
      if (extCalls.n > 0) afterResponse(flushProviderMetrics);
      return withRequestId(res, requestId);
    });
  };
}

/**
 * Every answer carries the request id (header), and every error body too, so a buyer's
 * screenshot or a support message leads straight to the matching log lines.
 */
async function withRequestId(res: Response, requestId: string): Promise<Response> {
  const headers = new Headers(res.headers);
  headers.set("x-request-id", requestId);
  if (res.status >= 400 && headers.get("content-type")?.includes("application/json")) {
    try {
      const body = (await res.clone().json()) as Record<string, unknown>;
      if (body && typeof body === "object" && !Array.isArray(body) && body.requestId == null) {
        headers.delete("content-length");
        return new Response(JSON.stringify({ ...body, requestId }), { status: res.status, statusText: res.statusText, headers });
      }
    } catch {
      /* not JSON after all: headers only */
    }
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
