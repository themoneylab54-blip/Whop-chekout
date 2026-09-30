import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import type { UserRole } from "@prisma/client";
import { db } from "./db";
import { env } from "./env";
import { rateLimit } from "./ratelimit";

const COOKIE = "wc_session";
const MAX_AGE = 60 * 60 * 24 * 14;

function secret() {
  return new TextEncoder().encode(env.sessionSecret);
}

/** The signed-in dashboard user, as loaded (and checked) on every request. */
export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  role: UserRole;
  allStores: boolean;
  sessionVersion: number;
  hasPassword: boolean;
  googleLinked: boolean;
  /** The linked Google account's address (may differ from `email`), when known. */
  googleEmail: string | null;
};

const USER_SELECT = {
  id: true,
  email: true,
  name: true,
  avatarUrl: true,
  role: true,
  allStores: true,
  disabledAt: true,
  sessionVersion: true,
  passwordHash: true,
  googleSub: true,
  googleEmail: true,
} as const;

/** The cookie's session: the user id and the session version it was issued for. */
export async function signSession(userId: string, sessionVersion: number): Promise<string> {
  return new SignJWT({ sub: userId, sv: sessionVersion })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
}

/**
 * `{ userId, sv }` of a valid token, else null. A token without a session version (issued before
 * 0038) is refused: 0040 already made every such cookie stale.
 */
export async function readSession(token: string | undefined): Promise<{ userId: string; sv: number } | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    if (typeof payload.sub !== "string") return null;
    const sv = payload.sv;
    return typeof sv === "number" && Number.isInteger(sv) && sv >= 0 ? { userId: payload.sub, sv } : null;
  } catch {
    return null;
  }
}

/**
 * The user a session designates, or null when it no longer holds: unknown or disabled user, or a
 * session version that was bumped since (signed out everywhere, removed, role changed).
 */
export async function sessionUser(session: { userId: string; sv: number } | null): Promise<SessionUser | null> {
  if (!session) return null;
  const user = await db.adminUser.findUnique({ where: { id: session.userId }, select: USER_SELECT });
  if (!user || user.disabledAt || user.sessionVersion !== session.sv) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    allStores: user.allStores,
    sessionVersion: user.sessionVersion,
    hasPassword: !!user.passwordHash,
    googleLinked: !!user.googleSub,
    googleEmail: user.googleSub ? user.googleEmail : null,
  };
}

/**
 * Signs `userId` in (password, Google or invitation): sets the cookie for its current session
 * version and records the login. Refuses (false) a missing or disabled user.
 */
export async function signIn(userId: string): Promise<boolean> {
  const user = await db.adminUser.findUnique({ where: { id: userId }, select: { disabledAt: true, sessionVersion: true } });
  if (!user || user.disabledAt) return false;
  const token = await signSession(userId, user.sessionVersion);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  await db.adminUser.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
  return true;
}

/**
 * A bcrypt hash (cost 12, same as real ones) of a throwaway string: an unknown e-mail, a Google-only
 * or a removed account is compared against it, so the answer takes as long as for a real account
 * (the response time doesn't tell which e-mails exist).
 */
const DUMMY_HASH = "$2b$12$5hXpfjinqV88fLefRG7IGOO/LZ9tDpDfAxPRIZ6C0tA9D9PghRAeO";

const FIFTEEN_MINUTES = 15 * 60_000;
/** Password attempts per (e-mail, IP): 10 per 15 minutes — the limit a guesser hits. */
export const LOGIN_EMAIL_IP_LIMIT = { limit: 10, windowMs: FIFTEEN_MINUTES };
/**
 * Password attempts per e-mail, whatever the IP: 100 per 15 minutes — a ceiling against a guesser
 * spread over many IPs, high enough that someone else's failed attempts can't lock the member out.
 */
export const LOGIN_EMAIL_LIMIT = { limit: 100, windowMs: FIFTEEN_MINUTES };
/** Current-password checks of a signed-in member (Profil, linking Google): 10 per 15 minutes. */
export const ACCOUNT_PASSWORD_LIMIT = { limit: 10, windowMs: FIFTEEN_MINUTES };

/** A member's current-password check may run (per member, ACCOUNT_PASSWORD_LIMIT). */
export async function accountPasswordAllowed(userId: string): Promise<boolean> {
  return rateLimit(`account-password:${userId}`, ACCOUNT_PASSWORD_LIMIT.limit, ACCOUNT_PASSWORD_LIMIT.windowMs);
}

const hashed = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);

/** The limiter keys of a password attempt (hashed: the table never holds the e-mail nor the IP). */
export function loginLimitKeys(email: string, ip: string): { emailIp: string; email: string } {
  const emailKey = hashed(email.toLowerCase().trim());
  return { emailIp: `login-email-ip:${hashed(`${emailKey}|${ip}`)}`, email: `login-email:${emailKey}` };
}

/**
 * Password sign-in: `rate` when that e-mail had too many attempts from this IP (LOGIN_EMAIL_IP_LIMIT)
 * or from everywhere (LOGIN_EMAIL_LIMIT) — checked before the password, so a right guess doesn't get
 * through either; `invalid` for a wrong password, an unknown, Google-only or removed account — always
 * after one bcrypt comparison.
 */
export async function loginWithPassword(email: string, password: string, ip = "unknown"): Promise<{ ok: true; userId: string } | { ok: false; reason: "invalid" | "rate" }> {
  const normalized = email.toLowerCase().trim();
  const keys = loginLimitKeys(normalized, ip);
  if (!(await rateLimit(keys.emailIp, LOGIN_EMAIL_IP_LIMIT.limit, LOGIN_EMAIL_IP_LIMIT.windowMs))) return { ok: false, reason: "rate" };
  if (!(await rateLimit(keys.email, LOGIN_EMAIL_LIMIT.limit, LOGIN_EMAIL_LIMIT.windowMs))) return { ok: false, reason: "rate" };
  const user = normalized ? await db.adminUser.findUnique({ where: { email: normalized }, select: { id: true, passwordHash: true, disabledAt: true } }) : null;
  const usable = !!user?.passwordHash && !user.disabledAt;
  const matches = await bcrypt.compare(password, usable ? user.passwordHash! : DUMMY_HASH);
  if (!usable || !matches || !(await signIn(user.id))) return { ok: false, reason: "invalid" };
  return { ok: true, userId: user.id };
}

export async function login(email: string, password: string): Promise<boolean> {
  return (await loginWithPassword(email, password)).ok;
}

export async function logout() {
  (await cookies()).delete(COOKIE);
}

/** Signs the user out on every device: every cookie issued before carries a stale `sv`. */
export async function bumpSessionVersion(userId: string): Promise<number> {
  const { sessionVersion } = await db.adminUser.update({
    where: { id: userId },
    data: { sessionVersion: { increment: 1 } },
    select: { sessionVersion: true },
  });
  return sessionVersion;
}

/** The signed-in user (checked against the database: disabled / revoked sessions are refused). Once per request. */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  return sessionUser(await readSession((await cookies()).get(COOKIE)?.value));
});

export async function currentAdminId(): Promise<string | null> {
  return (await currentUser())?.id ?? null;
}

/** For server components and actions under the dashboard: the user, or off to /login. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** Back-compat: the signed-in user's id (same checks as requireUser). */
export async function requireAdmin(): Promise<string> {
  return (await requireUser()).id;
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}
