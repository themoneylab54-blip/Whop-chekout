import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Input, Label, SubmitButton } from "@/components/ui";
import { AuthShell } from "@/components/dashboard/AuthShell";
import { createStoreAction, logoutAction } from "./actions";

export default async function DashboardHome() {
  await requireAdmin();
  const first = await db.store.findFirst({ orderBy: { createdAt: "asc" } });
  if (first) redirect(`/dashboard/stores/${first.id}`);
  return (
    <AuthShell title="Ajoute ta première boutique" subtitle="Donne-lui un nom, on s'occupe du reste en 5 minutes.">
      <form action={createStoreAction} className="space-y-4">
        <div>
          <Label htmlFor="name">Nom de la boutique</Label>
          <Input id="name" name="name" placeholder="Ma boutique" required autoFocus />
        </div>
        <SubmitButton className="w-full py-2.5">Créer la boutique</SubmitButton>
      </form>
      <form action={logoutAction} className="mt-6 text-center">
        <button className="text-sm text-zinc-500 underline-offset-4 hover:underline">Se déconnecter</button>
      </form>
    </AuthShell>
  );
}
