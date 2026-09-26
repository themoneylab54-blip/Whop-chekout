import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db } from "@/lib/db";
import { Flash, Input, Label, SubmitButton } from "@/components/ui";
import { setupAction } from "./actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Première configuration" };

/** Only reachable while no admin exists; afterwards it redirects to the login page. */
export default async function SetupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if ((await db.adminUser.count()) > 0) redirect("/login");
  const { error } = await searchParams;
  return (
    <main className="flex min-h-full items-center justify-center bg-zinc-50 px-4">
      <form action={setupAction} className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-7 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-sm font-bold text-white">W</span>
          <span className="font-semibold">Whop Checkout</span>
        </div>
        <h1 className="text-xl font-semibold">Créez votre compte admin</h1>
        <p className="mt-1 mb-5 text-sm text-zinc-500">Cette page ne sert qu&apos;une fois : elle se désactive dès que le compte est créé.</p>
        <Flash error={error} />
        <div className="space-y-4">
          <div>
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
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
          <SubmitButton className="w-full">Créer mon compte</SubmitButton>
        </div>
      </form>
    </main>
  );
}
