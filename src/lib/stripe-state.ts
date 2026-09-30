import { createHmac, randomBytes } from "node:crypto";
import { deriveKey, safeEqual } from "./crypto";
import type { StripeMode } from "./stripe-config";

/*
 * `state` of the "Se connecter avec Stripe" OAuth round trip: the store, the mode (live / test keys),
 * a nonce and a 15-minute expiry, signed with a key derived from ENCRYPTION_KEY. The nonce is also
 * kept in a short-lived httpOnly cookie of the admin's browser: the callback only accepts a state
 * issued to that same browser (login CSRF, a link forwarded to someone else). Pure given the key.
 */

export const STRIPE_STATE_TTL_MS = 15 * 60_000;
/** Prefix of the nonce cookie; one cookie per store (stripeNonceCookie), so two tabs connecting two stores don't clobber each other. */
export const STRIPE_NONCE_COOKIE = "wc_stripe_oauth";

/** The nonce cookie of one store's round trip. Pure. */
export function stripeNonceCookie(storeId: string): string {
  return `${STRIPE_NONCE_COOKIE}_${storeId.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

/**
 * The store a state claims, WITHOUT verifying it: only to pick the cookie to verify against, and to
 * send an admin back to that store's page when the state is refused. Never trusted for anything else. Pure.
 */
export function peekStripeStateStore(state: string): string | null {
  try {
    const p = JSON.parse(Buffer.from(state.split(".")[0] ?? "", "base64url").toString("utf8")) as { s?: unknown };
    return typeof p.s === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p.s) ? p.s : null;
  } catch {
    return null;
  }
}

/**
 * A dashboard POST's Origin header: absent (older clients) or this app's own host is accepted; another
 * host, or one that can't be parsed, is refused. Pure.
 */
export function sameOrigin(origin: string | null, appUrl: string): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(appUrl).host;
  } catch {
    return false;
  }
}

/**
 * Stricter than sameOrigin (sign-in round trips): the request must prove it comes from our pages —
 * an Origin of this app's host, or, without Origin, the browser's `Sec-Fetch-Site: same-origin`.
 * Neither header: refused. Pure.
 */
export function strictSameOrigin(origin: string | null, secFetchSite: string | null, appUrl: string): boolean {
  if (origin) return sameOrigin(origin, appUrl);
  return secFetchSite === "same-origin";
}

function stateKey(rawKey?: string): Buffer {
  // Domain-separated from the encryption itself: the AES key never signs anything directly.
  return createHmac("sha256", deriveKey(rawKey ?? process.env.ENCRYPTION_KEY ?? "")).update("stripe-connect-state.v1").digest();
}

const sign = (payload: string, rawKey?: string) => createHmac("sha256", stateKey(rawKey)).update(payload).digest("base64url");

export function newStripeNonce(): string {
  return randomBytes(18).toString("base64url");
}

export function signStripeState(input: { storeId: string; mode: StripeMode; nonce: string }, now = Date.now(), rawKey?: string): string {
  const payload = Buffer.from(JSON.stringify({ s: input.storeId, m: input.mode, n: input.nonce, e: now + STRIPE_STATE_TTL_MS })).toString("base64url");
  return `${payload}.${sign(payload, rawKey)}`;
}

/** The store and mode of a valid, unexpired state whose nonce matches the browser's cookie; null otherwise. */
export function verifyStripeState(state: string, cookieNonce: string | null | undefined, now = Date.now(), rawKey?: string): { storeId: string; mode: StripeMode } | null {
  if (!cookieNonce) return null;
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
    const p = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { s?: unknown; m?: unknown; n?: unknown; e?: unknown };
    if (typeof p.s !== "string" || !p.s || (p.m !== "live" && p.m !== "test") || typeof p.n !== "string" || typeof p.e !== "number") return null;
    if (p.e < now || !safeEqual(p.n, cookieNonce)) return null;
    return { storeId: p.s, mode: p.m };
  } catch {
    return null;
  }
}
