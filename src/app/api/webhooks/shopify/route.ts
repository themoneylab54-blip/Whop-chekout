import { db } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { json } from "@/lib/http";
import { log, recordEvent } from "@/lib/log";
import { rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/route";
import { recordCheckoutEnabled } from "@/lib/fallback";
import { normalizeShopDomain, verifyWebhookHmac } from "@/lib/shopify";
import { clearShopifyStatus } from "@/lib/shopify-status";
import { claimWebhookId, markDisabledByUninstall, releaseWebhookId } from "@/lib/shopify-uninstall";

export const dynamic = "force-dynamic";

/**
 * Shopify → app webhooks (subscribed on each successful connection). Only `app/uninstalled`:
 * Shopify has revoked the token and removed the app's script tags, so the store is marked
 * disconnected and the checkout switched off (buyers fall back to Shopify's own checkout; the next
 * successful reconnection switches it back on), and the merchant is alerted. Signed with the app's
 * client secret (X-Shopify-Hmac-Sha256); the signed body must name the same shop as the header.
 * Idempotent (X-Shopify-Webhook-Id, and a compare-and-set on the token).
 */
async function handle(req: Request) {
  const raw = await req.text();
  const topic = req.headers.get("x-shopify-topic") ?? "";
  const shop = normalizeShopDomain(req.headers.get("x-shopify-shop-domain") ?? "");
  const store = shop ? await db.store.findUnique({ where: { shopDomain: shop } }) : null;
  // A shop this app no longer knows: nothing to do (answered 200 so Shopify stops retrying).
  if (!store?.shopifyClientSecret) {
    log.info("shopify.webhook_unknown_shop", "Shopify webhook for an unknown shop", { shop, topic });
    return json({ ok: true, ignored: "unknown_shop" });
  }
  if (!verifyWebhookHmac(raw, req.headers.get("x-shopify-hmac-sha256"), decrypt(store.shopifyClientSecret))) {
    // Usually an app the store no longer uses (replaced by a new one): journaled, a few times a minute per store.
    if (await rateLimit(`shopify-badsig:${store.id}`, 3)) {
      await recordEvent({ storeId: store.id, level: "warn", kind: "shopify.webhook_bad_signature", message: `Webhook Shopify « ${topic || "?"} » refusé (signature invalide).` });
    }
    return json({ error: "invalid signature" }, { status: 401 });
  }
  if (topic !== "app/uninstalled") return json({ ok: true, ignored: "topic" });

  // The headers are not signed: the signed body must be about the same shop.
  let body: { myshopify_domain?: unknown };
  try {
    body = JSON.parse(raw) as { myshopify_domain?: unknown };
  } catch {
    return json({ error: "invalid body" }, { status: 400 });
  }
  if (typeof body?.myshopify_domain !== "string" || normalizeShopDomain(body.myshopify_domain) !== shop) {
    return json({ error: "shop mismatch" }, { status: 400 });
  }
  const triggeredAt = Date.parse(req.headers.get("x-shopify-triggered-at") ?? "");
  if (!Number.isFinite(triggeredAt)) return json({ error: "missing triggered-at" }, { status: 400 });
  // An uninstall that happened before the current connection (reinstalled since): not this one.
  if (store.shopifyConnectedAt && triggeredAt < store.shopifyConnectedAt.getTime()) return json({ ok: true, ignored: "stale" });

  // Already disconnected (an earlier delivery, or the merchant): nothing left to do.
  if (!store.shopifyAccessToken) return json({ ok: true, duplicate: true });
  const webhookId = req.headers.get("x-shopify-webhook-id");
  if (webhookId && !(await claimWebhookId(webhookId))) return json({ ok: true, duplicate: true });

  try {
    // Compare-and-set on the token read above: a reconnection in between (new token) is left alone,
    // and a redelivery (token already gone) changes nothing.
    const { count } = await db.store.updateMany({
      where: { id: store.id, shopifyAccessToken: store.shopifyAccessToken },
      data: { shopifyAccessToken: null, scriptTagId: null, shopifyConnectedAt: null, shopifyScopes: null, enabled: false },
    });
    clearShopifyStatus(store.id);
    if (count === 0) return json({ ok: true, duplicate: true });

    // Switched back on by the next successful reconnection (unless the merchant toggles it before).
    if (store.enabled) await markDisabledByUninstall(store.id);
    await recordCheckoutEnabled(store.id, store.enabled, false, "App Shopify désinstallée");
    await recordEvent({
      storeId: store.id,
      level: "error",
      kind: "shopify.app_uninstalled",
      message: store.enabled
        ? `L'app Shopify a été désinstallée de ${shop} : le checkout est désactivé et vos clients passent par le checkout Shopify. Reconnectez la boutique depuis la page Shopify du dashboard : le checkout sera réactivé automatiquement.`
        : `L'app Shopify a été désinstallée de ${shop} : la boutique est déconnectée. Reconnectez-la depuis la page Shopify du dashboard.`,
      data: { shop, wasEnabled: store.enabled },
      alert: true,
    });
  } catch (err) {
    if (webhookId) await releaseWebhookId(webhookId);
    throw err;
  }
  return json({ ok: true });
}

export const POST = route("webhooks.shopify", handle);
