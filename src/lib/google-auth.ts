import "server-only";
import { createHmac, randomBytes } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { deriveKey, safeEqual } from "./crypto";
import { env } from "./env";
import { extFetch } from "./ext";
import { safeNext } from "./team-rules";

/*
 * « Continuer avec Google » (dashboard sign-in, OpenID Connect). Separate from the Google Ads
 * connection (google-ads-oauth.ts): its own client (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET), scopes
 * `openid email profile` only, nothing stored but the account's `sub`, e-mail, name and photo.
 *
 * Round trip: POST /api/auth/google/start signs a `state` (mode, the user a link is bound to, a nonce,
 * a 10-minute expiry; HMAC with a key derived from ENCRYPTION_KEY) and keeps the nonce in an httpOnly
 * cookie of this browser; /api/auth/google/callback only accepts a state issued to that same browser,
 * exchanges the code and verifies the ID token (Google's keys, audience, issuer, nonce, verified e-mail).
 */

export const GOOGLE_STATE_TTL_MS = 10 * 60_000;
export const GOOGLE_NONCE_COOKIE = "wc_google_oauth";
/** The nonce cookie only travels to the round trip's routes. */
export const GOOGLE_COOKIE_PATH = "/api/auth/google";

const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const TIMEOUT_MS = 10_000;

/**
 * login: sign in / join (`next`: a path of this site to land on afterwards); link: attach Google to the signed-in user (`userId`); reauth: the signed-in
 * user proves again, freshly, that it holds its linked Google account (a Google-only account setting
 * its first password); invite: accept that invitation.
 */
export type GoogleMode =
  | { kind: "login"; next?: string }
  | { kind: "link"; userId: string }
  | { kind: "reauth"; userId: string }
  | { kind: "invite"; inviteId: string };

/** A re-authentication counts when Google signed the member in at most this long ago (`auth_time`). */
export const GOOGLE_REAUTH_MAX_AGE_MS = 5 * 60_000;
/** Cookie holding the invitation link's token during the round trip (to send a failure back to that page). */
export const GOOGLE_INVITE_COOKIE = "wc_google_invite";

export function googleAuthConfigured(): boolean {
  return !!(env.googleClientId && env.googleClientSecret);
}

export function googleRedirectUri(): string {
  return `${env.appUrl}/api/auth/google/callback`;
}

/* ------------------------------------------------------------------ */
/* State (pure given the key)                                          */
/* ------------------------------------------------------------------ */

function stateKey(rawKey?: string): Buffer {
  // Domain-separated from the encryption key and from the Stripe state's key.
  return createHmac("sha256", deriveKey(rawKey ?? process.env.ENCRYPTION_KEY ?? "")).update("google-signin-state.v1").digest();
}

const sign = (payload: string, rawKey?: string) => createHmac("sha256", stateKey(rawKey)).update(payload).digest("base64url");

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function newGoogleNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function signGoogleState(mode: GoogleMode, nonce: string, now = Date.now(), rawKey?: string): string {
  const m = mode.kind === "invite" ? `invite:${mode.inviteId}` : mode.kind;
  const body: Record<string, unknown> = { m, n: nonce, e: now + GOOGLE_STATE_TTL_MS };
  if (mode.kind === "link" || mode.kind === "reauth") body.u = mode.userId;
  // Where to land once signed in: signed with the rest (checked with safeNext at both ends).
  if (mode.kind === "login" && mode.next && safeNext(mode.next)) body.x = mode.next;
  const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
  return `${payload}.${sign(payload, rawKey)}`;
}

/** The mode of a valid, unexpired state whose nonce matches the browser's cookie; null otherwise. */
export function verifyGoogleState(state: string, cookieNonce: string | null | undefined, now = Date.now(), rawKey?: string): { mode: GoogleMode; nonce: string } | null {
  if (!cookieNonce || !state) return null;
  const [payload, sig, extra] = state.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  let expected: string;
  try {
    expected = sign(payload, rawKey);
  } catch {
    return null;
  }
  if (!safeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { m?: unknown; u?: unknown; n?: unknown; e?: unknown; x?: unknown };
    if (typeof p.m !== "string" || typeof p.n !== "string" || typeof p.e !== "number") return null;
    if (p.e < now || !safeEqual(p.n, cookieNonce)) return null;
    if (p.m === "login") {
      const next = typeof p.x === "string" ? safeNext(p.x) : null;
      return { mode: next ? { kind: "login", next } : { kind: "login" }, nonce: p.n };
    }
    if (p.m === "link" || p.m === "reauth") return typeof p.u === "string" && ID.test(p.u) ? { mode: { kind: p.m, userId: p.u }, nonce: p.n } : null;
    const invite = /^invite:(.+)$/.exec(p.m)?.[1];
    return invite && ID.test(invite) ? { mode: { kind: "invite", inviteId: invite }, nonce: p.n } : null;
  } catch {
    return null;
  }
}

/**
 * Google's consent page for this round trip (account chooser every time). `fresh` (link, reauth):
 * Google must ask for the password again — `max_age=0` (Google doesn't accept `prompt=login`); the
 * callback then checks the ID token's `auth_time` itself (GOOGLE_REAUTH_MAX_AGE_MS).
 */
export function googleAuthorizeUrl(state: string, nonce: string, opts: { fresh?: boolean } = {}): string {
  const q = new URLSearchParams({
    client_id: env.googleClientId ?? "",
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    state,
    nonce,
  });
  if (opts.fresh) q.set("max_age", "0");
  return `${AUTHORIZE_URL}?${q}`;
}

/** Google signed this identity in recently enough (`auth_time`) to count as a re-authentication. Pure. */
export function freshGoogleAuth(identity: Pick<GoogleIdentity, "authTime">, now = Date.now()): boolean {
  return identity.authTime != null && identity.authTime * 1000 <= now + 60_000 && now - identity.authTime * 1000 <= GOOGLE_REAUTH_MAX_AGE_MS;
}

/* ------------------------------------------------------------------ */
/* Code exchange + ID token                                            */
/* ------------------------------------------------------------------ */

/**
 * `hd`: the Google Workspace domain of the account (absent for consumer accounts) — with a Gmail
 * address, what proves Google owns the e-mail's domain. `authTime`: when Google last asked for the
 * password (seconds since epoch), when it says.
 */
export type GoogleIdentity = { sub: string; email: string; name: string | null; picture: string | null; hd?: string | null; authTime?: number | null };

let jwks: JWTVerifyGetKey | null = null;
/** Google's signing keys (fetched and cached by jose). */
function googleJwks(): JWTVerifyGetKey {
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL), { timeoutDuration: 5000 });
  return jwks;
}

/**
 * The identity an ID token carries, once verified: Google's signature, `aud` = our client id, Google's
 * issuer, unexpired, the round trip's nonce, and a verified e-mail (lowercased). Throws otherwise.
 */
export async function verifyGoogleIdToken(idToken: string, opts: { clientId: string; nonce?: string; keys?: JWTVerifyGetKey }): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, opts.keys ?? googleJwks(), { issuer: ISSUERS, audience: opts.clientId, algorithms: ["RS256"] });
  if (opts.nonce !== undefined && (typeof payload.nonce !== "string" || !safeEqual(payload.nonce, opts.nonce))) throw new Error("Google ID token: nonce mismatch");
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Google ID token: no subject");
  if (typeof payload.email !== "string" || !payload.email.includes("@")) throw new Error("Google ID token: no e-mail");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new Error("Google ID token: e-mail not verified");
  const name = typeof payload.name === "string" ? payload.name.trim().slice(0, 80) || null : null;
  const picture = typeof payload.picture === "string" && /^https:\/\/[^\s"'<>]{1,1000}$/.test(payload.picture) ? payload.picture : null;
  const hd = typeof payload.hd === "string" && /^[a-z0-9.-]{1,253}$/i.test(payload.hd) ? payload.hd.toLowerCase() : null;
  const authTime = typeof payload.auth_time === "number" && Number.isFinite(payload.auth_time) ? payload.auth_time : null;
  return { sub: payload.sub, email: payload.email.trim().toLowerCase(), name, picture, hd, authTime };
}

/** Exchanges the authorization code for the ID token (the access token is never kept nor logged). */
export async function exchangeGoogleCode(code: string): Promise<string> {
  const clientId = env.googleClientId;
  const clientSecret = env.googleClientSecret;
  if (!clientId || !clientSecret) throw new Error("Google sign-in not configured");
  const res = await extFetch("google_signin", "token", TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: googleRedirectUri(), grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as { id_token?: unknown; error?: unknown } | null;
  // Only Google's error code is surfaced: the body may carry tokens.
  if (!res.ok) throw new Error(`Google token ${res.status}${typeof body?.error === "string" ? ` ${body.error.slice(0, 60)}` : ""}`);
  if (typeof body?.id_token !== "string") throw new Error("Google token: no id_token");
  return body.id_token;
}

/** The verified Google identity behind an authorization code (the callback's only external step). */
export async function googleIdentityFromCode(code: string, nonce: string): Promise<GoogleIdentity> {
  const idToken = await exchangeGoogleCode(code);
  return verifyGoogleIdToken(idToken, { clientId: env.googleClientId ?? "", nonce });
}
