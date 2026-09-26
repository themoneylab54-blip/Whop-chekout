import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decrypt, encrypt, safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";
import { currentAdminId } from "@/lib/auth";
import { ensureScriptTag, exchangeCodeForToken, getShopInfo, normalizeShopDomain, verifyOauthHmac } from "@/lib/shopify";

/** Shopify OAuth redirect: verify, exchange the code, store the token, install the loader. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams;
  const state = q.get("state") ?? "";
  const shop = normalizeShopDomain(q.get("shop") ?? "");
  const code = q.get("code");

  const fail = (storeId: string | null, message: string) =>
    NextResponse.redirect(
      `${env.appUrl}/dashboard/${storeId ? `stores/${storeId}/shopify` : ""}?error=${encodeURIComponent(message)}`,
    );

  if (!(await currentAdminId())) return NextResponse.redirect(`${env.appUrl}/login`);
  const [storeId] = state.split(".");
  const store = storeId ? await db.store.findUnique({ where: { id: storeId } }) : null;
  if (!store || !store.shopifyOauthState || !safeEqual(store.shopifyOauthState, state)) {
    return fail(store?.id ?? null, "Lien d'installation expiré, recommencez.");
  }
  if (!shop || shop !== store.shopDomain || !code || !store.shopifyClientId || !store.shopifyClientSecret) {
    return fail(store.id, "Réponse Shopify invalide.");
  }
  const clientSecret = decrypt(store.shopifyClientSecret);
  if (!verifyOauthHmac(q, clientSecret)) return fail(store.id, "Signature Shopify invalide.");

  try {
    const token = await exchangeCodeForToken(shop, store.shopifyClientId, clientSecret, code);
    const connected = { shopDomain: shop, shopifyAccessToken: encrypt(token.access_token) };
    const info = await getShopInfo(connected);
    const scriptTagId = await ensureScriptTag({ ...connected, publicId: store.publicId });
    await db.store.update({
      where: { id: store.id },
      data: {
        ...connected,
        shopifyScopes: token.scope,
        shopifyOauthState: null,
        shopCurrency: info.currencyCode,
        storefrontHost: info.primaryDomain?.host ?? null,
        name: store.name || info.name,
        scriptTagId,
        shopifyConnectedAt: new Date(),
      },
    });
  } catch (err) {
    console.error("Shopify OAuth failed", err);
    return fail(store.id, err instanceof Error ? err.message : "Connexion Shopify impossible.");
  }
  return NextResponse.redirect(`${env.appUrl}/dashboard/stores/${store.id}/shopify?connected=1`);
}
