import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireAdmin } from "@/lib/auth";
import { Input, Label, SubmitButton } from "@/components/ui";
import { AuthShell } from "@/components/dashboard/AuthShell";
import { createStoreAction } from "../../actions";

export const metadata: Metadata = { title: "Ajouter une boutique" };

export default async function NewStorePage() {
  await requireAdmin();
  return (
    <AuthShell
      title="Ajouter une boutique"
      subtitle="Chaque boutique a sa propre connexion Shopify, son compte Whop et son design."
      back={
        <Link href="/dashboard" className="-ml-1 inline-flex min-h-9 items-center gap-1.5 rounded-md px-1 text-sm font-medium text-zinc-600 hover:text-zinc-900">
          <ArrowLeft className="h-4 w-4" aria-hidden /> Vos boutiques
        </Link>
      }
    >
      <form action={createStoreAction} className="space-y-4">
        <div>
          <Label htmlFor="name">Nom de la boutique</Label>
          <Input id="name" name="name" placeholder="Ma boutique" required autoFocus maxLength={80} />
        </div>
        <SubmitButton className="w-full py-2.5">Créer la boutique</SubmitButton>
      </form>
    </AuthShell>
  );
}
