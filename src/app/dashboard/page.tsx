import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { Card, Input, Label, SubmitButton } from "@/components/ui";
import { createStoreAction, logoutAction } from "./actions";

export default async function DashboardHome() {
  await requireAdmin();
  const first = await db.store.findFirst({ orderBy: { createdAt: "asc" } });
  if (first) redirect(`/dashboard/stores/${first.id}`);
  return (
    <main className="flex min-h-full items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-md">
        <Card title="Ajoutez votre première boutique" description="Donnez-lui un nom, on s'occupe du reste en 5 minutes.">
          <form action={createStoreAction} className="space-y-4">
            <div>
              <Label htmlFor="name">Nom de la boutique</Label>
              <Input id="name" name="name" placeholder="Ma boutique" required autoFocus />
            </div>
            <SubmitButton className="w-full">Créer la boutique</SubmitButton>
          </form>
        </Card>
        <form action={logoutAction} className="mt-4 text-center">
          <button className="text-sm text-zinc-500 underline">Se déconnecter</button>
        </form>
      </div>
    </main>
  );
}
