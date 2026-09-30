"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { loginWithPassword } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { AUTH_ERRORS, landingPath, safeNext } from "@/lib/team";

export type LoginState = { error?: string; email?: string };

/**
 * Password sign-in from /login (used with useActionState): limited per IP here, per (e-mail, IP) and with a
 * higher per-e-mail ceiling inside loginWithPassword; then `next` when it is a path of this site, else the member's landing page.
 */
export async function passwordLoginAction(_prev: LoginState, fd: FormData): Promise<LoginState> {
  const email = String(fd.get("email") ?? "").trim().slice(0, 200);
  const next = safeNext(String(fd.get("next") ?? ""));
  const ip = clientIp(await headers());
  if (!(await rateLimit(`login:${ip}`, 10))) return { error: AUTH_ERRORS.rate, email };
  const res = await loginWithPassword(email, String(fd.get("password") ?? ""), ip);
  if (!res.ok) return { error: res.reason === "rate" ? AUTH_ERRORS.rate : "E-mail ou mot de passe incorrect", email };
  redirect(await landingPath(res.userId, next));
}
