/*
 * Shopify connection form rules, shared by the dashboard form (live hints) and the server action
 * (the actual decision). Pure: no server-only import, so the client component can use it.
 */

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** "ma-boutique", "https://ma-boutique.myshopify.com/admin" → "ma-boutique.myshopify.com"; anything else → null. */
export function normalizeShopDomain(input: string): string | null {
  const d = hostOf(input);
  const full = d.includes(".") ? d : `${d}.myshopify.com`;
  return SHOP_DOMAIN.test(full) ? full : null;
}

/** Lower-cased host of what was typed (scheme, path and a leading "www." dropped for comparisons). */
function hostOf(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "");
}

const bare = (host: string) => host.replace(/^www\./, "");

/** A plausible public domain (colandcie.com, www.ma-boutique.fr), not a .myshopify.com address. */
function looksLikeDomain(host: string): boolean {
  return /^([a-z0-9-]+\.)+[a-z]{2,}$/.test(host) && !host.endsWith(".myshopify.com");
}

export type ShopDomainResolution =
  | { ok: true; shop: string; notice?: string }
  | { ok: false; error: string };

/**
 * What the « Domaine de la boutique » field means. A .myshopify.com address (or its handle) is used
 * as is. The storefront's own domain (colandcie.com) cannot be used for OAuth: when the store is
 * already linked to a shop, its known .myshopify.com address is used instead (with a notice);
 * otherwise the error says where to find the right address.
 */
export function resolveShopDomainInput(input: string, known: { shopDomain?: string | null; storefrontHost?: string | null }): ShopDomainResolution {
  const shop = normalizeShopDomain(input);
  if (shop) return { ok: true, shop };
  const host = hostOf(input);
  if (!host) return { ok: false, error: "Domaine manquant : indiquez l'adresse en .myshopify.com de la boutique." };
  if (looksLikeDomain(host)) {
    if (known.shopDomain) {
      const isStorefront = !!known.storefrontHost && bare(known.storefrontHost.toLowerCase()) === bare(host);
      return {
        ok: true,
        shop: known.shopDomain,
        notice: isStorefront
          ? `${host} est le domaine de votre vitrine : l'adresse Shopify de la boutique, ${known.shopDomain}, est utilisée.`
          : `${host} n'est pas une adresse .myshopify.com : l'adresse Shopify connue de la boutique, ${known.shopDomain}, est utilisée.`,
      };
    }
    return {
      ok: false,
      error: `${host} est le domaine de votre vitrine : indiquez l'adresse en .myshopify.com (Shopify → Paramètres → Domaines, par exemple ma-boutique.myshopify.com). Votre domaine est ensuite détecté automatiquement.`,
    };
  }
  return { ok: false, error: "Domaine invalide : utilisez l'adresse en .myshopify.com (Shopify → Paramètres → Domaines)." };
}

/** Below this length, a pasted value is surely not a Shopify client secret (they are 32+ characters). */
export const MIN_CLIENT_SECRET_LENGTH = 16;
/** Below this length, a value is suspicious (warned, not refused). */
export const USUAL_CLIENT_SECRET_LENGTH = 20;

export const SECRET_TOO_SHORT =
  "Ce n'est pas un Client secret Shopify : il fait plus de 30 caractères (souvent « shpss_… »). Copiez-le depuis le Dev Dashboard → votre app → Settings, sans passer par le remplissage automatique du navigateur.";

/** Live hint for the secret field: null when it looks fine (or is empty). */
export function clientSecretHint(value: string): { level: "error" | "warn"; message: string } | null {
  const v = value.trim();
  if (!v) return null;
  if (v.length < MIN_CLIENT_SECRET_LENGTH) return { level: "error", message: SECRET_TOO_SHORT };
  if (v.length < USUAL_CLIENT_SECRET_LENGTH || /\s/.test(v)) {
    return { level: "warn", message: "Ce n'est probablement pas un Client secret Shopify : vérifiez que vous avez copié la valeur « Client secret » de l'app." };
  }
  return null;
}

export const CONNECTION_KEPT = "Votre connexion actuelle n'a pas été modifiée.";

const HMAC_MISMATCH =
  "Le Client secret ne correspond pas au Client ID : copiez les deux depuis la même app Shopify (Dev Dashboard → votre app → Settings).";

/** Shopify's redirect is not signed by the secret typed (nor the active one of the same app). */
export function hmacMismatchError(connected: boolean): string {
  return connected ? `${HMAC_MISMATCH} ${CONNECTION_KEPT}` : HMAC_MISMATCH;
}

/** A reconnection not completed within this delay is expired (pending credentials and state). */
export const PENDING_TTL_MS = 60 * 60_000;

/** Secret field hint after Shopify's signature matched neither the typed nor the stored secret. */
export const SECRET_MISMATCH_HINT = "Recopiez le Client secret : celui enregistré ne correspond pas.";
