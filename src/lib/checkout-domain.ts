import { createHmac } from "node:crypto";
import type { Store } from "@prisma/client";
import { env } from "./env";
import { hostnameOf, isAppHost, isLocalHost, operatorHosts } from "./host-guard";

/*
 * Checkout domains: a store's checkout served on its own hostname (checkout.seyuna.com, or
 * seyuna.<operator domain>) instead of APP_URL. The merchant points a CNAME to Vercel; the domain
 * is used for buyer URLs only once https://<domain>/.well-known/whop-checkout-ping answers this
 * store's token (checkoutDomainVerifiedAt). Pure helpers here; checks and the tick job in
 * checkout-domain-check.ts.
 */

export const DOMAIN_PING_PATH = "/.well-known/whop-checkout-ping";
/** The record the merchant adds at their DNS host (Vercel's generic CNAME target). */
export const CNAME_TARGET = "cname.vercel-dns.com";
/** Vercel's address for an apex domain (a CNAME is not allowed at the root of a zone): an A record. */
export const VERCEL_APEX_IP = "76.76.21.21";

/** The DNS record to add, as told in messages: an A record for an apex, a CNAME otherwise. Pure. */
export function dnsRecordAdvice(apex: boolean): string {
  return apex ? `l'enregistrement A vers ${VERCEL_APEX_IP}` : `l'enregistrement CNAME vers ${CNAME_TARGET}`;
}

/** True when `domain` is the root of the merchant's domain (its record is an A record, not a CNAME). Pure. */
export function isApexDomain(domain: string): boolean {
  return cnameName(domain) === "@";
}

type DomainFields = Pick<Store, "checkoutDomain" | "checkoutDomainVerifiedAt">;

/** Base URL of the buyer's pages for this store: its verified checkout domain, else APP_URL. */
export function checkoutBaseUrl(store: DomainFields, appUrl = env.appUrl): string {
  return store.checkoutDomain && store.checkoutDomainVerifiedAt ? `https://${store.checkoutDomain}` : appUrl.replace(/\/$/, "");
}

/** Hostname buyers see: the verified checkout domain, else APP_URL's. */
export function checkoutHostOf(store: DomainFields, appUrl = env.appUrl): string {
  return new URL(checkoutBaseUrl(store, appUrl)).hostname;
}

export type DomainCheck = { ok: true; domain: string | null } | { ok: false; error: string; apex?: true };

/** Shown next to the confirmation an apex domain needs (its root would move to the checkout). */
export const APEX_WARNING = "Ce domaine est la racine de votre site : le pointer vers le checkout remplacera votre site principal.";

/**
 * The merchant's input as a hostname to store (lowercase, ASCII, no scheme / port / path), or why
 * it can't be one. Empty = no checkout domain. "https://Checkout.Seyuna.com/" is accepted as
 * checkout.seyuna.com; a real path, a port or an e-mail is not. The operator's own hosts
 * (OPERATOR_HOSTS) are refused; the root of a domain (seyuna.com) only with `confirmApex` (its DNS
 * record would move the merchant's main site to the checkout). Pure.
 */
export function normalizeCheckoutDomain(
  input: string,
  opts: { appUrl?: string; storefrontHosts?: (string | null | undefined)[]; operatorHosts?: readonly string[]; confirmApex?: boolean } = {},
): DomainCheck {
  let raw = input.trim().toLowerCase();
  if (!raw) return { ok: true, domain: null };
  raw = raw.replace(/^https?:\/\//, "").replace(/\/$/, "").replace(/\.$/, "");
  if (/[/?#@\s:\\]/.test(raw) || raw.includes("://")) {
    return { ok: false, error: "Saisissez seulement le nom de domaine, sans « https:// » ni chemin : par exemple checkout.maboutique.com" };
  }
  let ascii: string;
  try {
    ascii = new URL(`https://${raw}`).hostname; // punycode for accented names (café.fr → xn--caf-dma.fr)
  } catch {
    return { ok: false, error: "Nom de domaine invalide : par exemple checkout.maboutique.com" };
  }
  const labels = ascii.split(".");
  const validLabel = (l: string) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l);
  if (ascii.length > 253 || labels.length < 2 || !labels.every(validLabel) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels[labels.length - 1])) {
    return { ok: false, error: "Nom de domaine invalide : par exemple checkout.maboutique.com" };
  }
  if (/^\d+(\.\d+){3}$/.test(ascii) || isLocalHost(ascii)) return { ok: false, error: "Une adresse IP ou locale ne peut pas servir de domaine de checkout." };
  const appHost = new URL(opts.appUrl ?? env.appUrl).hostname.toLowerCase();
  if (ascii === appHost) return { ok: false, error: "C'est déjà l'adresse du checkout universel : laissez le champ vide pour l'utiliser." };
  if (ascii === "vercel.app" || ascii.endsWith(".vercel.app")) {
    return { ok: false, error: "Une adresse *.vercel.app ne peut pas servir de domaine de checkout : utilisez un sous-domaine de votre site (checkout.maboutique.com)." };
  }
  if ((opts.operatorHosts ?? operatorHosts()).includes(ascii)) return { ok: false, error: "Cette adresse est réservée au service : utilisez un sous-domaine de votre site (checkout.maboutique.com)." };
  if (ascii.endsWith(".myshopify.com")) return { ok: false, error: "Une adresse *.myshopify.com appartient à Shopify : utilisez un sous-domaine de votre site (checkout.maboutique.com)." };
  const storefront = (opts.storefrontHosts ?? []).filter((h): h is string => !!h).map((h) => h.toLowerCase());
  if (storefront.includes(ascii) || storefront.includes(ascii.replace(/^www\./, "")) || storefront.includes(`www.${ascii}`)) {
    return { ok: false, error: `${ascii} est l'adresse de votre boutique : choisissez un sous-domaine dédié, par exemple checkout.${ascii.replace(/^www\./, "")}` };
  }
  if (cnameName(ascii) === "@" && !opts.confirmApex) {
    return { ok: false, apex: true, error: `${APEX_WARNING} Cochez la case de confirmation pour l'utiliser quand même, ou choisissez un sous-domaine (checkout.${ascii}).` };
  }
  return { ok: true, domain: ascii };
}

/**
 * Registries' own two-label suffixes (seyuna.co.uk, seyuna.com.br…): the registrable domain is then
 * the last three labels. Only real, common ones: "@" (the root of the merchant's domain) is only
 * ever told for a name known to be an apex.
 */
const REGISTRY_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "ac.uk", "gov.uk",
  "com.br", "net.br", "org.br",
  "com.au", "net.au", "org.au", "id.au",
  "co.nz", "net.nz", "org.nz",
  "co.za", "org.za",
  "co.jp", "ne.jp", "or.jp",
  "co.kr", "or.kr",
  "co.in", "net.in", "org.in", "firm.in",
  "co.il", "org.il",
  "com.mx", "com.ar", "com.co", "com.pe", "com.uy", "com.ve", "com.ec", "com.bo", "com.py",
  "com.tr", "com.cn", "com.hk", "com.sg", "com.tw", "com.my", "com.ph", "com.vn", "com.pk", "com.eg", "com.sa", "com.ng",
  "co.id", "co.th", "in.th", "co.ke", "co.ma", "co.tz", "co.ug",
  "gouv.fr", "asso.fr", "nom.fr", "com.fr", "tm.fr",
  "com.pl", "net.pl", "org.pl",
  "com.es", "org.es", "nom.es",
  "com.pt", "co.at", "or.at", "com.gr", "com.cy", "com.mt", "co.hu", "com.ro", "com.ua",
]);

/**
 * The DNS record name to create for `domain` ("checkout" for checkout.seyuna.com; "@" for an apex).
 * The registrable domain is the last two labels, or three under a known registry suffix (co.uk,
 * com.br…). When that can't be told for sure (a short second level under a country TLD: pay.abc.fr
 * or checkout.web.de could be under a registry suffix) the full hostname is returned: DNS hosts
 * accept it (most strip their zone), whereas a wrong short name — "@" above all, which would move
 * the merchant's main site — would create the wrong record. Pure.
 */
export function cnameName(domain: string): string {
  const labels = domain.toLowerCase().split(".");
  if (labels.length <= 2) return "@";
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  if (REGISTRY_SUFFIXES.has(`${second}.${tld}`)) return labels.length === 3 ? "@" : labels.slice(0, -3).join(".");
  if (tld.length === 2 && second.length <= 3) return domain.toLowerCase();
  return labels.slice(0, -2).join(".");
}

/** Token https://<domain>/.well-known/whop-checkout-ping answers for this store (proves the routing). */
export function domainToken(storeId: string, domain: string, secret = env.sessionSecret): string {
  return `whopco-${createHmac("sha256", secret).update(`checkout-domain\n${storeId}\n${domain.toLowerCase()}`).digest("base64url").slice(0, 32)}`;
}

/**
 * Where a /c page must send the buyer so the checkout stays on the store's own host: the store's
 * verified domain (from APP_URL or another store's domain), or APP_URL (from a domain that is not
 * this store's verified one). Null when the page is already on the right host, on a local host, or
 * on a preview deployment (*.vercel.app other than APP_URL's). Pure.
 */
export function checkoutHostRedirect(
  store: DomainFields,
  rawHost: string | null | undefined,
  pathAndQuery: string,
  appUrl = env.appUrl,
  extraAppHosts: readonly string[] = [],
  opts: { viaApp?: boolean } = {},
): string | null {
  const host = hostnameOf(rawHost);
  if (!host || isLocalHost(host)) return null;
  const appHost = new URL(appUrl).hostname.toLowerCase();
  const want = checkoutHostOf(store, appUrl);
  if (host === want) return null;
  // The loader's fallback (checkout domain unreachable for this buyer): APP_URL serves every store.
  if (host === appHost && opts.viaApp) return null;
  // Preview deployments and other aliases of the app keep serving the page as is.
  if (host !== appHost && isAppHost(host, appHost, extraAppHosts)) return null;
  return `${checkoutBaseUrl(store, appUrl)}${pathAndQuery}`;
}

/**
 * Whop's return URL after paying (also its 3-D Secure redirect): the thank-you page on the store's
 * host. A payment made on APP_URL's host while the store has a verified domain comes from the
 * loader's fallback (the domain was unreachable for this buyer): the buyer comes back to APP_URL
 * with ?via=app, which keeps the thank-you page there (see checkoutHostRedirect). Pure.
 */
export function thankYouReturnUrl(store: DomainFields, sessionId: string, rawHost: string | null | undefined, appUrl = env.appUrl): string {
  const path = `/c/${sessionId}/merci`;
  const app = appUrl.replace(/\/$/, "");
  const base = checkoutBaseUrl(store, appUrl);
  if (base !== app && hostnameOf(rawHost) === new URL(appUrl).hostname.toLowerCase()) return `${app}${path}?via=app`;
  return `${base}${path}`;
}

/** "?a=1&b=2" from a page's searchParams ("" when empty). Pure. */
export function queryOf(sp: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) for (const x of Array.isArray(v) ? v : v == null ? [] : [v]) q.append(k, x);
  const s = q.toString();
  return s ? `?${s}` : "";
}

export type DomainErrorKind = "dns" | "tls" | "timeout" | "mismatch" | "http" | "vercel";

/** Stored form of a failed check: "<kind>:<message>". */
export function formatDomainError(kind: DomainErrorKind, message: string): string {
  return `${kind}:${message}`.slice(0, 1000);
}

export function parseDomainError(stored: string | null | undefined): { kind: DomainErrorKind; message: string } | null {
  if (!stored) return null;
  const m = /^(dns|tls|timeout|mismatch|http|vercel):([\s\S]*)$/.exec(stored);
  return m ? { kind: m[1] as DomainErrorKind, message: m[2] } : { kind: "http", message: stored };
}

export type DomainStatus = "none" | "pending" | "verified" | "error";

/**
 * Badge of the dashboard card: À configurer (no domain), En attente DNS (saved, the DNS / certificate
 * isn't there yet), Vérifié, Erreur (answers, but not as this checkout; or Vercel refused it). Pure.
 */
export function domainStatus(store: Pick<Store, "checkoutDomain" | "checkoutDomainVerifiedAt" | "checkoutDomainError">): { status: DomainStatus; label: string; message: string | null } {
  if (!store.checkoutDomain) return { status: "none", label: "À configurer", message: null };
  // A verified domain whose last check failed stays in use until the next check (see checkStoreDomain).
  if (store.checkoutDomainVerifiedAt) return { status: "verified", label: "Vérifié", message: parseDomainError(store.checkoutDomainError)?.message ?? null };
  const err = parseDomainError(store.checkoutDomainError);
  if (!err || err.kind === "dns" || err.kind === "tls" || err.kind === "timeout") return { status: "pending", label: "En attente DNS", message: err?.message ?? null };
  return { status: "error", label: "Erreur", message: err.message };
}

/**
 * Certificate error without the Vercel API configured: the usual cause is the domain missing from the
 * Vercel project (Vercel only issues the certificate of a domain added there).
 */
export const TLS_ADD_TO_VERCEL_MESSAGE =
  "Le domaine pointe vers Vercel mais son certificat HTTPS n'existe pas encore : ajoutez le domaine dans Vercel → Settings → Domains (projet du checkout) s'il n'y est pas ; Vercel crée le certificat quelques minutes après. Réessayez ensuite.";

/** A failed ping as the kind and the plain-French sentence shown to the merchant. Pure. */
export function humanizePingError(err: unknown, opts: { apex?: boolean } = {}): { kind: DomainErrorKind; message: string } {
  const apex = !!opts.apex;
  const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string; name?: string } } | null;
  const code = e?.cause?.code ?? e?.code ?? "";
  const name = e?.name ?? e?.cause?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return { kind: "timeout", message: "Le domaine n'a pas répondu à temps (quelques secondes) : l'enregistrement DNS n'est peut-être pas encore actif. Réessayez dans quelques minutes." };
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") {
    return { kind: "dns", message: `Le domaine est introuvable pour l'instant : ajoutez ${dnsRecordAdvice(apex)} chez votre hébergeur de nom de domaine. Une fois ajouté, comptez quelques minutes (parfois jusqu'à 48 h).` };
  }
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code)) {
    return { kind: "tls", message: "Le domaine pointe bien vers le checkout mais son certificat HTTPS n'est pas encore prêt (Vercel le crée quelques minutes après le DNS). Réessayez un peu plus tard." };
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EHOSTUNREACH") {
    return {
      kind: "dns",
      message: apex
        ? `Le domaine ne pointe pas encore vers le checkout : vérifiez que l'enregistrement A a pour valeur ${VERCEL_APEX_IP}.`
        : `Le domaine ne pointe pas encore vers le checkout : vérifiez que l'enregistrement CNAME a pour valeur ${CNAME_TARGET}.`,
    };
  }
  const msg = e?.cause?.message ?? (err instanceof Error ? err.message : String(err));
  return { kind: "http", message: `Le domaine n'a pas pu être joint (${msg.slice(0, 160)}).` };
}
