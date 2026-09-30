"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { hashPassword, login } from "@/lib/auth";
import { safeEqual } from "@/lib/crypto";
import { passwordProblemCode, type SetupErrorCode } from "@/lib/team-rules";

/** First-run only: creates the admin account while none exists. */
export async function setupAction(fd: FormData) {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const confirm = String(fd.get("confirm") ?? "");
  // A code only (fixed text on the page, SETUP_ERRORS): nothing typed travels in the URL.
  const fail = (code: SetupErrorCode): never => redirect(`/setup?error=${code}`);

  // Optional guard: with SETUP_TOKEN set, a stranger reaching a fresh deployment can't claim it.
  const token = process.env.SETUP_TOKEN;
  if (token && !safeEqual(String(fd.get("token") ?? ""), token)) fail("token");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("email_invalid");
  const problem = passwordProblemCode(password);
  if (problem) fail(problem);
  if (password !== confirm) fail("password_mismatch");

  const passwordHash = await hashPassword(password);
  // Serializable: two simultaneous submissions can't both create an admin.
  const created = await db.$transaction(
    async (tx) => {
      if ((await tx.adminUser.count()) > 0) return false;
      // The first account owns the team (payment connections, owners).
      await tx.adminUser.create({ data: { email, passwordHash, role: "owner" } });
      return true;
    },
    { isolationLevel: "Serializable" },
  );
  if (!created) redirect("/login");

  await login(email, password);
  redirect("/dashboard");
}
