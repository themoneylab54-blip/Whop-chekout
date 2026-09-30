import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { setupErrorMessage, PASSWORD_MIN } from "@/lib/team-rules";
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
    <AuthShell title="Créez votre compte admin" subtitle="Cette page ne sert qu'une fois : elle se désactive dès que le compte est créé.">
      {/* A code only: an unknown one (or any text) shows nothing. */}
      <Flash error={setupErrorMessage(error)} />
      <form action={setupAction} className="space-y-4">
        <div>
          <Label htmlFor="email">E-mail</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
        </div>
        <div>
          <Label htmlFor="password" hint={`${PASSWORD_MIN} caractères minimum`}>
            Mot de passe
          </Label>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
        </div>
        <div>
          <Label htmlFor="confirm">Confirmer le mot de passe</Label>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} required />
        </div>
        {process.env.SETUP_TOKEN && (
          <div>
            <Label htmlFor="token" hint="La valeur de la variable SETUP_TOKEN définie sur Vercel">
              Code d&apos;installation
            </Label>
            <Input id="token" name="token" type="password" autoComplete="off" required />
          </div>
        )}
        <SubmitButton className="w-full py-2.5">Créer mon compte</SubmitButton>
      </form>
    </AuthShell>
  );
}
