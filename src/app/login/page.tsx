import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentAdminId } from "@/lib/auth";
import { Flash, Input, Label, SubmitButton } from "@/components/ui";
import { loginAction } from "../dashboard/actions";

export const metadata: Metadata = { title: "Connexion" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  if (await currentAdminId()) redirect("/dashboard");
  const { error } = await searchParams;
  return (
    <main className="flex min-h-full items-center justify-center bg-zinc-50 px-4">
      <form action={loginAction} className="w-full max-w-sm rounded-2xl border border-zinc-200 bg-white p-7 shadow-sm">
        <div className="mb-6 flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-zinc-900 text-sm font-bold text-white">W</span>
          <span className="font-semibold">Whop Checkout</span>
        </div>
        <h1 className="mb-5 text-xl font-semibold">Connexion</h1>
        <Flash error={error} />
        <div className="space-y-4">
          <div>
            <Label htmlFor="email">E-mail</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div>
            <Label htmlFor="password">Mot de passe</Label>
            <Input id="password" name="password" type="password" autoComplete="current-password" required />
          </div>
          <SubmitButton className="w-full">Se connecter</SubmitButton>
        </div>
      </form>
    </main>
  );
}
