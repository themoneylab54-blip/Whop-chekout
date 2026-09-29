import "server-only";
import { log } from "./log";

/** External providers whose calls are logged as `ext.call` (and rolled up in ProviderMetric). */
export type Provider = "shopify" | "whop" | "stripe" | "meta" | "tiktok" | "google_ads" | "ga4" | "ecb" | "resend" | "telegram" | "mondial_relay" | "judgeme";

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
    log.warn("ext.call", `${provider} ${op} failed`, { provider, op, ms: Date.now() - started, err });
    throw err;
  }
}
