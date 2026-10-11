import "server-only";
import { log } from "./log";

/** External providers whose calls are logged as `ext.call` (and rolled up in ProviderMetric). */
export type Provider = "shopify" | "whop" | "stripe" | "meta" | "tiktok" | "google_ads" | "google_signin" | "ga4" | "ecb" | "resend" | "telegram" | "mondial_relay" | "judgeme";

/**
 * `fetch` to an external provider, logged like the Shopify and Whop clients: one `ext.call` line with
 * the provider, a fixed operation label (never the URL: some carry secrets), the status and the
 * duration — which also feeds the per-provider metrics (metrics.ts). Same contract as fetch.
 */
export async function extFetch(provider: Provider, op: string, input: string | URL, init?: RequestInit): Promise<Response> {
  const started = Date.now();
  try {
    const res = await fetch(input, init);
    const ms = Date.now() - started;
    (ms > 5000 || res.status >= 400 ? log.warn : log.info)("ext.call", `${provider} ${op} ${res.status} in ${ms} ms`, { provider, op, status: res.status, ms });
    return res;
  } catch (err) {
    // Stopped by its caller (another answer came first): no outcome of the provider's, not in its metrics.
    if (init?.signal?.aborted && init.signal.reason instanceof CallStopped) {
      log.info("ext.call_stopped", `${provider} ${op} stopped by its caller`, { provider, op, ms: Date.now() - started });
      throw err;
    }
    log.warn("ext.call", `${provider} ${op} failed`, { provider, op, ms: Date.now() - started, err });
    throw err;
  }
}

/**
 * The reason a caller aborts an external call it no longer needs (a hedged read whose other request
 * answered first): extFetch then counts no failure for the provider.
 */
export class CallStopped extends Error {
  constructor(message = "stopped by its caller") {
    super(message);
    this.name = "CallStopped";
  }
}
