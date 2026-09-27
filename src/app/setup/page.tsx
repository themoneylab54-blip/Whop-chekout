import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { Flash, Input, Label, SubmitButton } from "@/components/ui";
import { AuthShell } from "@/components/dashboard/AuthShell";
import { setupAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Première configuration" };

/** Only reachable while no admin exists; afterwards it redirects to the login page. */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if ((await db.adminUser.count()) > 0) redirect("/login");
  const { error } = await searchParams;
  return (
    <AuthShell title="Crée ton compte admin" subtitle="Cette page ne sert qu'une fois : elle se désactive dès que le compte est créé.">
      <Flash error={error} />
      <form action={setupAction} className="space-y-4">
        <div>
          <Label htmlFor="email">E-mail</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
        </div>
        <div>
          <Label htmlFor="password" hint="10 caractères minimum">
            Mot de passe
          </Label>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
        </div>
        <div>
          <Label htmlFor="confirm">Confirmer le mot de passe</Label>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
        </div>
        <SubmitButton className="w-full py-2.5">Créer mon compte</SubmitButton>
      </form>
    </AuthShell>
  );
}
