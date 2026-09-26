import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { db } from "./db";
import { env } from "./env";

const COOKIE = "wc_session";
const MAX_AGE = 60 * 60 * 24 * 14;

function secret() {
  return new TextEncoder().encode(env.sessionSecret);
}

export async function login(email: string, password: string): Promise<boolean> {
  const user = await db.adminUser.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return false;
  const token = await new SignJWT({ sub: user.id })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE}s`)
    .sign(secret());
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  return true;
}

export async function logout() {
  (await cookies()).delete(COOKIE);
}

export async function currentAdminId(): Promise<string | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/** For server components and actions under the dashboard. */
export async function requireAdmin(): Promise<string> {
  const id = await currentAdminId();
  if (!id) redirect("/login");
  return id;
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}
