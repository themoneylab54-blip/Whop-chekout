import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdminId } from "@/lib/auth";
import { db } from "@/lib/db";
import { Flash, Input, Label, SubmitButton } from "@/components/ui";
import { AuthShell } from "@/components/dashboard/AuthShell";
import { loginAction } from "../dashboard/actions";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentAdminId()) redirect("/dashboard");
  if ((await db.adminUser.count()) === 0) redirect("/setup");
  const { error } = await searchParams;
  return (
    <AuthShell title="Bon retour" subtitle="Connecte-toi pour gérer tes boutiques.">
      <Flash error={error} />
      <form action={loginAction} className="space-y-4">
        <div>
          <Label htmlFor="email">E-mail</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
        </div>
        <div>
          <Label htmlFor="password">Mot de passe</Label>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <SubmitButton className="w-full py-2.5">Se connecter</SubmitButton>
      </form>
    </AuthShell>
  );
}
