import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdminId } from "@/lib/auth";
import { db } from "@/lib/db";
import { AuthShell } from "@/components/dashboard/AuthShell";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentAdminId()) redirect("/dashboard");
  if ((await db.adminUser.count()) === 0) redirect("/setup");
  const { error } = await searchParams;
  return (
    <AuthShell title="Bon retour" subtitle="Connectez-vous pour gérer vos boutiques.">
      <LoginForm initialError={error} />
    </AuthShell>
  );
}
