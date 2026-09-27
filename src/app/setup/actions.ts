"use server";

import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { hashPassword, login } from "@/lib/auth";
import { safeEqual } from "@/lib/crypto";

/** First-run only: creates the admin account while none exists. */
export async function setupAction(fd: FormData) {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const confirm = String(fd.get("confirm") ?? "");
  const fail = (error: string): never => redirect(`/setup?error=${encodeURIComponent(error)}`);

  // Optional guard: with SETUP_TOKEN set, a stranger reaching a fresh deployment can't claim it.
  const token = process.env.SETUP_TOKEN;
  if (token && !safeEqual(String(fd.get("token") ?? ""), token)) fail("Code d'installation incorrect");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("E-mail invalide");
  if (password.length < 10) fail("Le mot de passe doit faire au moins 10 caractères");
  if (password !== confirm) fail("Les deux mots de passe ne correspondent pas");

  const passwordHash = await hashPassword(password);
  // Serializable: two simultaneous submissions can't both create an admin.
  const created = await db.$transaction(
    async (tx) => {
      if ((await tx.adminUser.count()) > 0) return false;
      await tx.adminUser.create({ data: { email, passwordHash } });
      return true;
    },
    { isolationLevel: "Serializable" },
  );
  if (!created) redirect("/login");

  await login(email, password);
  redirect("/dashboard");
}
