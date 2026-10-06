import { NextResponse } from "next/server";
import type { Store } from "@prisma/client";
import { db } from "@/lib/db";
import { decrypt, encrypt, safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";
import { currentAdminId } from "@/lib/auth";
import { checkStoreAccess, OWNER_ONLY_ERROR } from "@/lib/access";
import { ensureScriptTag, ensureUninstallWebhook, exchangeCodeForToken, getShopInfo, normalizeShopDomain, removeScriptTag, verifyOauthHmac } from "@/lib/shopify";
import { CONNECTION_KEPT, hmacMismatchError, PENDING_TTL_MS } from "@/lib/shopify-connect";
import { clearDisabledByUninstall, isDisabledByUninstall } from "@/lib/shopify-uninstall";
import { storeReady } from "@/lib/payment-provider";
import { clearShopifyStatus } from "@/lib/shopify-status";
import { recordCheckoutEnabled } from "@/lib/fallback";
import { route } from "@/lib/route";
import { log } from "@/lib/log";

/** Fields of a reconnection attempt: cleared whatever its outcome. */
const NO_PENDING = { shopifyPendingShopDomain: null, shopifyPendingClientId: null, shopifyPendingClientSecret: null, shopifyPendingAt: null, shopifyOauthState: null };

/** App credentials Shopify's redirect may be signed with: the ones just typed first, then the active ones. */
function candidatePairs(store: Store): { clientId: string; secret: string; pending: boolean }[] {
  const pairs: { clientId: string; secret: string; pending: boolean }[] = [];
  const pendingId = store.shopifyPendingClientId;
  if (pendingId && store.shopifyPendingClientSecret) pairs.push({ clientId: pendingId, secret: store.shopifyPendingClientSecret, pending: true });
  // The active secret signs a reconnection with the same app (a wrongly pasted new secret is then
  // simply ignored); never for another app's Client ID, whose code it could not exchange anyway.
  if (store.shopifyClientId && store.shopifyClientSecret && (!pendingId || pendingId === store.shopifyClientId)) {
    pairs.push({ clientId: store.shopifyClientId, secret: store.shopifyClientSecret, pending: false });
  }
  return pairs;
}

/**
 * Shopify OAuth redirect: verify, exchange the code, store the token, install the loader.
 * The credentials typed in the form wait in the « pending » columns; they replace the active ones
 * only once Shopify proved them (signature + token exchange). Any failure clears them and leaves
 * the working connection exactly as it was.
 */
async function handle(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams;
  const state = q.get("state") ?? "";
  const shop = normalizeShopDomain(q.get("shop") ?? "");
  const code = q.get("code");

  const fail = (storeId: string | null, message: string, reason?: string) =>
    NextResponse.redirect(
      `${env.appUrl}/dashboard/${storeId ? `stores/${storeId}/shopify` : ""}?error=${encodeURIComponent(message)}${reason ? `&reason=${reason}` : ""}`,
    );

  if (!(await currentAdminId())) return NextResponse.redirect(`${env.appUrl}/login`);
  const [storeId] = state.split(".");
  // Platform connections are the owner's (the install was started by one: checked again here).
  const access = storeId ? await checkStoreAccess(storeId, "owner") : null;
  if (access && !access.ok && access.reason === "login") return NextResponse.redirect(`${env.appUrl}/login`);
  if (access && !access.ok && access.reason === "forbidden") return fail(storeId, OWNER_ONLY_ERROR);
  const store = access?.ok ? access.store : null;
  if (!store || !store.shopifyOauthState || !safeEqual(store.shopifyOauthState, state)) {
    return fail(store?.id ?? null, "Lien d'installation expiré, recommencez.");
  }

  const kept = store.shopifyConnectedAt ? ` ${CONNECTION_KEPT}` : "";
  // Every write is conditional on this attempt's state: a slower, older attempt never clears or
  // overwrites a newer one started meanwhile (which replaced the state).
  const thisAttempt = { id: store.id, shopifyOauthState: state };
  /** Ends the attempt: the pending credentials are dropped, the active connection is untouched. */
  const abort = async (message: string, reason?: string) => {
    await db.store.updateMany({ where: thisAttempt, data: NO_PENDING }).catch((err) => log.warn("shopify.oauth_abort_failed", "Could not clear the pending Shopify credentials", { storeId: store.id, err }));
    return fail(store.id, message, reason);
  };

  if (store.shopifyPendingAt && Date.now() - store.shopifyPendingAt.getTime() > PENDING_TTL_MS) {
    return abort(`Lien d'installation expiré (plus d'une heure) : recommencez depuis le formulaire.${kept}`);
  }
  const expectedShop = store.shopifyPendingShopDomain ?? store.shopDomain;
  if (!shop || !code || shop !== expectedShop) {
    return abort(
      shop && expectedShop && shop !== expectedShop
        ? `Shopify a répondu pour ${shop} alors que la connexion demandée était pour ${expectedShop} : recommencez depuis le bon compte Shopify.${kept}`
        : `Réponse Shopify invalide, recommencez.${kept}`,
    );
  }
  const pair = candidatePairs(store).find((p) => verifyOauthHmac(q, decrypt(p.secret)));
  if (!pair) {
    log.warn("shopify.oauth_bad_hmac", "Shopify OAuth callback signature matches no stored secret", { storeId: store.id, shop, pending: !!store.shopifyPendingClientId });
    return abort(hmacMismatchError(!!store.shopifyConnectedAt), "hmac");
  }
  const clientSecret = decrypt(pair.secret);

  const domainChanged = !!store.shopDomain && store.shopDomain !== shop;
  if (shop !== store.shopDomain) {
    const other = await db.store.findFirst({ where: { shopDomain: shop, NOT: { id: store.id } }, select: { name: true } });
    if (other) return abort(`${shop} est déjà connectée à la boutique « ${other.name} ».${kept}`);
  }

  let token: { access_token: string; scope: string };
  try {
    token = await exchangeCodeForToken(shop, pair.clientId, clientSecret, code);
  } catch (err) {
    log.error("shopify.oauth_failed", "Shopify OAuth token exchange failed", { storeId: store.id, err });
    return abort(
      `Shopify a refusé l'autorisation : vérifiez que le Client ID et le Client secret viennent de la même app (Dev Dashboard → votre app → Settings), puis recommencez.${kept}`,
    );
  }

  const connected = { shopDomain: shop, shopifyAccessToken: encrypt(token.access_token) };
  let info: Awaited<ReturnType<typeof getShopInfo>>;
  let scriptTagId: string;
  try {
    info = await getShopInfo(connected);
    scriptTagId = await ensureScriptTag({ ...connected, publicId: store.publicId });
  } catch (err) {
    log.error("shopify.oauth_failed", "Shopify OAuth: shop info or script install failed", { storeId: store.id, err });
    return abort(`${err instanceof Error ? err.message : "Connexion Shopify impossible."}${kept}`);
  }

  const connectedAt = new Date();
  // The checkout an uninstall switched off comes back on with the connection (same shop, the merchant
  // didn't toggle it since, and a processor can still charge).
  const reenable = !domainChanged && !store.enabled && (await isDisabledByUninstall(store.id)) && storeReady({ ...store, shopifyConnectedAt: connectedAt });
  let promoted: number;
  try {
    ({ count: promoted } = await db.store.updateMany({
      where: thisAttempt,
      data: {
        ...connected,
        ...NO_PENDING,
        shopifyClientId: pair.clientId,
        shopifyClientSecret: pair.secret,
        shopifyScopes: token.scope,
        shopCurrency: info.currencyCode,
        storefrontHost: info.primaryDomain?.host ?? null,
        name: store.name || info.name,
        scriptTagId,
        shopifyConnectedAt: connectedAt,
        // Another shop: the checkout waits for the merchant to switch it back on; the Judge.me token
        // belongs to the previous shop's .myshopify.com domain and is forgotten with it.
        ...(domainChanged ? { enabled: false, judgemeApiToken: null } : reenable ? { enabled: true } : {}),
      },
    }));
  } catch (err) {
    // E.g. the shop was connected to another store meanwhile (unique domain): nothing was written.
    log.error("shopify.oauth_failed", "Shopify OAuth: could not save the connection", { storeId: store.id, err });
    return abort(`Connexion Shopify impossible à enregistrer, recommencez.${kept}`);
  }
  if (promoted === 0) {
    // A newer attempt replaced this one: it decides; this one changes nothing.
    return fail(store.id, `Une autre tentative de connexion a été lancée entre-temps : terminez-la ou recommencez.${kept}`);
  }
  if (domainChanged) {
    await clearDisabledByUninstall(store.id);
    await recordCheckoutEnabled(store.id, store.enabled, false, "Boutique Shopify changée");
  } else if (reenable) {
    await clearDisabledByUninstall(store.id);
    await recordCheckoutEnabled(store.id, false, true);
  }
  clearShopifyStatus(store.id);

  // The previous connection's script tag, only once the new one is saved: on the old shop (domain
  // change), or created by another app on the same shop (new Client ID) where the new app cannot
  // see it. Removed with the old token, best effort.
  const appChanged = !!store.shopifyClientId && store.shopifyClientId !== pair.clientId;
  if ((domainChanged || appChanged) && store.scriptTagId && store.shopifyAccessToken) {
    await removeScriptTag(store, store.scriptTagId).catch(() => undefined);
  }

  // An uninstall then disconnects the store at once (best effort: the connection works without it).
  await ensureUninstallWebhook(connected).catch((err) => log.warn("shopify.webhook_register_failed", "Could not subscribe to APP_UNINSTALLED", { storeId: store.id, err }));

  return NextResponse.redirect(`${env.appUrl}/dashboard/stores/${store.id}/shopify?connected=1${reenable ? "&reenabled=1" : ""}`);
}

export const GET = route("shopify.callback", handle);
