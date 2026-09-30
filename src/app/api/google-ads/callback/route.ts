import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { env } from "@/lib/env";
import { currentAdminId } from "@/lib/auth";
import { checkStoreAccess, OWNER_ONLY_ERROR } from "@/lib/access";
import { route } from "@/lib/route";
import { log, recordEvent } from "@/lib/log";
import { exchangeGoogleAdsCode, googleAdsOperator, googleAdsRedirectUri, listGoogleAdsAccounts, verifyGoogleAdsState } from "@/lib/google-ads-oauth";

/**
 * Google OAuth redirect ("Connecter Google Ads"): checks the signed state, exchanges the code,
 * stores the refresh token encrypted (with the operator's client and developer token), then sends
 * the merchant back to Pub & pixels to pick the ads account (picked at once when there is only one).
 */
async function handle(req: Request) {
  const q = new URL(req.url).searchParams;
  const back = (storeId: string | null, params: Record<string, string>) =>
    NextResponse.redirect(storeId ? `${env.appUrl}/dashboard/stores/${storeId}/growth?${new URLSearchParams(params)}#adspend` : `${env.appUrl}/dashboard`);

  const adminId = await currentAdminId();
  if (!adminId) return NextResponse.redirect(`${env.appUrl}/login`);
  const storeId = verifyGoogleAdsState(q.get("state") ?? "", adminId);
  // The Google Ads connection (its tokens) is the owner's, like the other API keys.
  const access = storeId ? await checkStoreAccess(storeId, "owner") : null;
  if (access && !access.ok && access.reason === "forbidden") return back(storeId, { error: OWNER_ONLY_ERROR });
  const store = access?.ok ? { id: access.store.id } : null;
  if (!store) return back(null, {});
  const op = googleAdsOperator();
  if (!op) return back(store.id, { error: "Connexion Google Ads indisponible : l'application Google Ads n'est pas configurée sur ce serveur. Utilisez « Avancé »." });
  // The merchant closed or refused the consent screen.
  if (q.get("error")) return back(store.id, { error: q.get("error") === "access_denied" ? "Connexion Google Ads annulée." : `Google a refusé la connexion (${q.get("error")!.slice(0, 60)}).` });
  const code = q.get("code");
  if (!code) return back(store.id, { error: "Réponse Google invalide : recommencez." });

  try {
    const tokens = await exchangeGoogleAdsCode(op, code, googleAdsRedirectUri());
    // Only one usable account: chosen now; several: the merchant picks it on the page.
    const accounts = await listGoogleAdsAccounts(op, tokens.accessToken).catch(() => []);
    const usable = accounts.filter((a) => !a.manager);
    const only = usable.length === 1 ? usable[0] : null;
    await db.store.update({
      where: { id: store.id },
      data: {
        googleAdsClientId: op.clientId,
        googleAdsClientSecret: encrypt(op.clientSecret),
        googleAdsDeveloperToken: encrypt(op.developerToken),
        googleAdsRefreshToken: encrypt(tokens.refreshToken),
        googleAdsCustomerId: only?.id ?? null,
        googleAdsLoginCustomerId: only?.loginId ?? null,
      },
    });
    await recordEvent({
      storeId: store.id,
      kind: "adspend.google_saved",
      message: only ? `Google Ads connecté (compte ${only.name ?? only.id}) : import des dépenses activé.` : "Google Ads connecté : choisissez le compte publicitaire.",
    });
    return back(store.id, { ok: only ? "Google Ads connecté : les dépenses sont importées toutes les heures." : "Google Ads connecté : choisissez maintenant le compte publicitaire." });
  } catch (err) {
    log.warn("google_ads.oauth_failed", "Google Ads OAuth failed", { err });
    return back(store.id, { error: err instanceof Error ? err.message : "Connexion Google Ads impossible, réessayez." });
  }
}

export const GET = route("google-ads.callback", handle);
