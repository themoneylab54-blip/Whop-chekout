import "server-only";
import { Prisma, type Store } from "@prisma/client";
import { db } from "./db";
import { log } from "./log";
import { rateLimit } from "./ratelimit";
import { ensureUninstallWebhook } from "./shopify";

/*
 * Bookkeeping around Shopify's app/uninstalled webhook (AppSetting rows, no schema change):
 * - which stores had their checkout switched off by an uninstall (switched back on by the next
 *   successful reconnection, unless the merchant toggled the checkout in between);
 * - which webhook deliveries were already handled (X-Shopify-Webhook-Id, kept 7 days);
 * - a rate-limited « make sure the store is subscribed » for stores connected before the webhook existed.
 */

const disabledKey = (storeId: string) => `shopify:disabled-by-uninstall:${storeId}`;

/** The uninstall webhook switched the checkout off (it was on). */
export async function markDisabledByUninstall(storeId: string): Promise<void> {
  const now = new Date();
  await db.appSetting.upsert({ where: { key: disabledKey(storeId) }, create: { key: disabledKey(storeId), value: now.toISOString(), updatedAt: now }, update: { value: now.toISOString(), updatedAt: now } });
}

/** Whether the checkout was switched off by an uninstall; the mark is removed (one use). */
export async function consumeDisabledByUninstall(storeId: string): Promise<boolean> {
  const { count } = await db.appSetting.deleteMany({ where: { key: disabledKey(storeId) } });
  return count > 0;
}

/** The merchant decided about the checkout (toggle, disconnect): never switched back on for them. */
export async function clearDisabledByUninstall(storeId: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: disabledKey(storeId) } });
}

export async function isDisabledByUninstall(storeId: string): Promise<boolean> {
  return !!(await db.appSetting.findUnique({ where: { key: disabledKey(storeId) }, select: { key: true } }));
}

const WEBHOOK_PREFIX = "shopify:webhook-id:";
export const WEBHOOK_DEDUPE_MS = 7 * 24 * 3600_000;

/**
 * Claims a webhook delivery by its X-Shopify-Webhook-Id: false when it was already handled (a
 * redelivery). A claim older than 7 days is expired (taken over). Old claims are swept as we go.
 */
export async function claimWebhookId(id: string, now = new Date()): Promise<boolean> {
  const key = WEBHOOK_PREFIX + id.slice(0, 200);
  const expired = new Date(now.getTime() - WEBHOOK_DEDUPE_MS);
  await db.appSetting.deleteMany({ where: { key: { startsWith: WEBHOOK_PREFIX }, updatedAt: { lt: expired } } }).catch(() => undefined);
  try {
    await db.appSetting.create({ data: { key, value: now.toISOString(), updatedAt: now } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}

/** Frees a claim when handling failed, so Shopify's retry is handled. */
export async function releaseWebhookId(id: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: WEBHOOK_PREFIX + id.slice(0, 200) } }).catch(() => undefined);
}

/**
 * Subscribes an already connected store to APP_UNINSTALLED, at most once per 12 h per store
 * (stores connected before the webhook existed get it without reconnecting). Never throws.
 */
export async function ensureUninstallWebhookThrottled(store: Pick<Store, "id" | "shopDomain" | "shopifyAccessToken">): Promise<void> {
  try {
    if (!store.shopDomain || !store.shopifyAccessToken) return;
    if (!(await rateLimit(`shopify-uninstall-webhook:${store.id}`, 1, 12 * 3600_000))) return;
    await ensureUninstallWebhook(store);
  } catch (err) {
    log.warn("shopify.webhook_register_failed", "Could not subscribe to APP_UNINSTALLED", { storeId: store.id, err });
  }
}
