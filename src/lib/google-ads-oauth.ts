import "server-only";
import { extFetch } from "./ext";
import { createHmac, randomBytes } from "node:crypto";
import { env } from "./env";
import { safeEqual } from "./crypto";
import { GOOGLE_ADS_API_VERSION, googleCustomerId } from "./adspend-google";

/*
 * "Connecter Google Ads" (Pub & pixels): OAuth consent with the operator's Google Cloud client
 * (GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET) and developer token (GOOGLE_ADS_DEVELOPER_TOKEN),
 * so a merchant connects in two clicks instead of pasting five values. The callback stores the
 * refresh token encrypted on the store (with the operator's client and developer token, so the
 * spend import and conversion uploads read the same fields as a manual setup), then the merchant
 * picks the ads account among the ones the Google login can reach (customers:listAccessibleCustomers).
 * Without the env vars, the manual fields stay the way in.
 */

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS = 15 * 60_000;
const TIMEOUT_MS = 8_000;

export type GoogleAdsOperator = { clientId: string; clientSecret: string; developerToken: string };

/** The operator's Google Ads app, or null when any of the three env vars is missing. */
export function googleAdsOperator(source: Record<string, string | undefined> = process.env): GoogleAdsOperator | null {
  const clientId = source.GOOGLE_ADS_CLIENT_ID?.trim();
  const clientSecret = source.GOOGLE_ADS_CLIENT_SECRET?.trim();
  const developerToken = source.GOOGLE_ADS_DEVELOPER_TOKEN?.trim();
  return clientId && clientSecret && developerToken ? { clientId, clientSecret, developerToken } : null;
}

export function googleAdsRedirectUri(): string {
  return `${env.appUrl}/api/google-ads/callback`;
}

const sign = (payload: string, secret: string) => createHmac("sha256", secret).update(`google-ads-oauth.${payload}`).digest("base64url");

/** `state` bound to the store, the admin and a 15-minute expiry, signed with the app secret. Pure given `secret`. */
export function signGoogleAdsState(storeId: string, adminId: string, now = Date.now(), secret = env.sessionSecret): string {
  const payload = Buffer.from(JSON.stringify({ s: storeId, a: adminId, e: now + STATE_TTL_MS, n: randomBytes(9).toString("base64url") })).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

/** The store id of a valid, unexpired `state` issued to this admin; null otherwise. Pure given `secret`. */
export function verifyGoogleAdsState(state: string, adminId: string, now = Date.now(), secret = env.sessionSecret): string | null {
  const [payload, sig, extra] = state.split(".");
  if (!payload || !sig || extra !== undefined || !safeEqual(sig, sign(payload, secret))) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { s?: unknown; a?: unknown; e?: unknown };
    if (typeof p.s !== "string" || p.a !== adminId || typeof p.e !== "number" || p.e < now) return null;
    return p.s;
  } catch {
    return null;
  }
}

/** Google's consent screen URL (offline access + forced consent, so a refresh token always comes back). Pure. */
export function googleAdsAuthUrl(op: Pick<GoogleAdsOperator, "clientId">, state: string, redirectUri: string): string {
  const q = new URLSearchParams({
    client_id: op.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_ADS_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${AUTH_URL}?${q}`;
}

async function getJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await extFetch("google_ads", url.includes("oauth2") ? "oauth token" : "accounts", url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  const body = (await res.json().catch(() => null)) as { error?: string | { message?: string }; error_description?: string } | null;
  if (!res.ok) {
    const msg = typeof body?.error === "string" ? (body.error_description ?? body.error) : body?.error?.message;
    throw new Error(`Google a refusé la demande (HTTP ${res.status}${msg ? ` : ${String(msg).slice(0, 200)}` : ""})`);
  }
  return body;
}

/** Authorization code → tokens. Throws a readable error; the refresh token is required. */
export async function exchangeGoogleAdsCode(op: GoogleAdsOperator, code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string }> {
  const body = (await getJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: op.clientId, client_secret: op.clientSecret, redirect_uri: redirectUri }).toString(),
  })) as { access_token?: string; refresh_token?: string; scope?: string } | null;
  if (!body?.access_token) throw new Error("Google n'a pas renvoyé de jeton d'accès.");
  if (!body.refresh_token) throw new Error("Google n'a pas renvoyé de jeton d'actualisation : retirez l'accès de l'application dans votre compte Google, puis reconnectez.");
  if (body.scope && !body.scope.split(" ").includes(GOOGLE_ADS_SCOPE)) throw new Error("L'accès à Google Ads n'a pas été accordé : cochez la case Google Ads sur l'écran de consentement.");
  return { accessToken: body.access_token, refreshToken: body.refresh_token };
}

/** Refresh token → access token (account picker). */
export async function googleAdsAccessToken(op: GoogleAdsOperator, refreshToken: string): Promise<string> {
  const body = (await getJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: op.clientId, client_secret: op.clientSecret }).toString(),
  })) as { access_token?: string } | null;
  if (!body?.access_token) throw new Error("Jeton Google refusé : reconnectez Google Ads.");
  return body.access_token;
}

export type GoogleAdsAccount = {
  /** 10-digit customer id. */
  id: string;
  name: string | null;
  currency: string | null;
  /** Manager (MCC) the account is reached through, sent as login-customer-id. */
  loginId: string | null;
  manager: boolean;
};

/** "customers/1234567890" resource names → ids. Pure. */
export function accessibleCustomerIds(body: unknown): string[] {
  const names = (body as { resourceNames?: unknown } | null)?.resourceNames;
  if (!Array.isArray(names)) return [];
  return [...new Set(names.map((n) => googleCustomerId(String(n).replace(/^customers\//, ""))).filter((id): id is string => !!id))];
}

/** Rows of a `customer` / `customer_client` searchStream answer → accounts. Pure. */
export function accountsFromStream(body: unknown, loginId: string | null): GoogleAdsAccount[] {
  const batches = Array.isArray(body) ? body : body ? [body] : [];
  const out: GoogleAdsAccount[] = [];
  for (const b of batches as { results?: Record<string, Record<string, unknown> | undefined>[] }[]) {
    for (const r of b?.results ?? []) {
      const c = r.customerClient ?? r.customer;
      const id = googleCustomerId(String(c?.id ?? ""));
      if (!id) continue;
      out.push({
        id,
        name: typeof c?.descriptiveName === "string" && c.descriptiveName.trim() ? c.descriptiveName.trim() : null,
        currency: typeof c?.currencyCode === "string" ? c.currencyCode : null,
        loginId: loginId && loginId !== id ? loginId : null,
        manager: c?.manager === true,
      });
    }
  }
  return out;
}

/**
 * The ads accounts this Google login can use: each directly accessible account (name, currency),
 * and for a manager (MCC) its client accounts one level down (reached through the manager).
 * Names are best-effort: an account whose details fail is still listed by id.
 */
export async function listGoogleAdsAccounts(op: GoogleAdsOperator, accessToken: string): Promise<GoogleAdsAccount[]> {
  const headers = { Authorization: `Bearer ${accessToken}`, "developer-token": op.developerToken, "Content-Type": "application/json" };
  const base = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;
  const ids = accessibleCustomerIds(await getJson(`${base}/customers:listAccessibleCustomers`, { method: "GET", headers })).slice(0, 20);
  const search = (id: string, query: string, loginId: string) =>
    getJson(`${base}/customers/${id}/googleAds:searchStream`, { method: "POST", headers: { ...headers, "login-customer-id": loginId }, body: JSON.stringify({ query }) });
  const lists = await Promise.all(
    ids.map(async (id): Promise<GoogleAdsAccount[]> => {
      try {
        const self = accountsFromStream(await search(id, "SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.manager FROM customer", id), null)[0];
        if (!self?.manager) return [self ?? { id, name: null, currency: null, loginId: null, manager: false }];
        const children = accountsFromStream(
          await search(
            id,
            "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager FROM customer_client WHERE customer_client.level = 1 AND customer_client.status = 'ENABLED'",
            id,
          ),
          id,
        ).filter((c) => !c.manager);
        return [self, ...children];
      } catch {
        return [{ id, name: null, currency: null, loginId: null, manager: false }];
      }
    }),
  );
  const seen = new Set<string>();
  return lists.flat().filter((a) => {
    const k = `${a.id}:${a.loginId ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** "1234567890" or "1234567890:9876543210" (account reached through a manager) from the picker. Pure. */
export function parseAccountChoice(raw: string): { customerId: string; loginId: string | null } | null {
  const [a, b, extra] = raw.trim().split(":");
  const customerId = googleCustomerId(a);
  if (!customerId || extra !== undefined) return null;
  if (b === undefined || b === "") return { customerId, loginId: null };
  const loginId = googleCustomerId(b);
  return loginId ? { customerId, loginId } : null;
}
