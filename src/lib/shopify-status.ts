import "server-only";
import type { Store } from "@prisma/client";
import { decrypt } from "./crypto";
import { log } from "./log";
import { loaderUrl, SHOPIFY_API_VERSION } from "./shopify";
import { afterResponse } from "./route";
import { ensureUninstallWebhookThrottled } from "./shopify-uninstall";

/**
 * The connection's real state, asked to Shopify (not read from our database): is the token still
 * accepted, and is our loader still among the shop's script tags? An uninstalled app revokes the
 * token and removes its script tags while our database still says « connectée ».
 *
 * - `active`: token valid, loader present;
 * - `script_missing`: token valid, loader absent (buyers are not redirected);
 * - `revoked`: Shopify refuses the token (app uninstalled or access removed);
 * - `unknown`: Shopify slow or unreachable: never blocks the page.
 */
export type ShopifyLiveState = "active" | "script_missing" | "revoked" | "unknown";

export const STATUS_TIMEOUT_MS = 3_000;
const CACHE_MS = 60_000;

type StatusStore = Pick<Store, "id" | "publicId" | "shopDomain" | "shopifyAccessToken">;

const cache = new Map<string, { state: ShopifyLiveState; at: number }>();

// Keyed by the token too: a reconnection (new token) is checked afresh.
const keyOf = (s: StatusStore) => `${s.id}|${s.shopDomain}|${s.shopifyAccessToken?.slice(-16)}`;

/** Forgets the cached state of a store (after reinstalling the script, a reconnection, an uninstall). */
export function clearShopifyStatus(storeId: string): void {
  for (const k of cache.keys()) if (k.startsWith(`${storeId}|`)) cache.delete(k);
}

/** One request, 3 s at most, cached 60 s per store (an unknown answer is not cached). */
export async function shopifyLiveState(store: StatusStore, opts: { now?: number } = {}): Promise<ShopifyLiveState> {
  if (!store.shopDomain || !store.shopifyAccessToken) return "revoked";
  const now = opts.now ?? Date.now();
  const key = keyOf(store);
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.state;
  const state = await askShopify(store);
  if (state !== "unknown") cache.set(key, { state, at: now });
  // A working connection made before the uninstall webhook existed gets subscribed, after the
  // answer (at most every 12 h per store): no reconnection needed.
  if (state === "active") afterResponse(() => ensureUninstallWebhookThrottled(store));
  return state;
}

async function askShopify(store: StatusStore): Promise<ShopifyLiveState> {
  const src = loaderUrl(store.publicId);
  try {
    const token = decrypt(store.shopifyAccessToken!);
    const res = await fetch(`https://${store.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query: `query($src: URL) { shop { name } scriptTags(first: 5, src: $src) { nodes { id src } } }`, variables: { src } }),
      cache: "no-store",
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    // 401: the token is no longer valid (app uninstalled, access revoked).
    if (res.status === 401) return "revoked";
    if (!res.ok) return "unknown";
    const json = (await res.json()) as { data?: { shop?: { name: string } | null; scriptTags?: { nodes: { src: string }[] } | null }; errors?: unknown[] };
    if (!json.data?.shop || !json.data.scriptTags) return "unknown";
    return json.data.scriptTags.nodes.some((n) => n.src === src) ? "active" : "script_missing";
  } catch (err) {
    log.info("shopify.status_unknown", "Shopify live status unavailable", { storeId: store.id, err });
    return "unknown";
  }
}
