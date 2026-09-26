import { requireAdmin } from "@/lib/auth";
import { Card, Input, Label, SubmitButton } from "@/components/ui";
import { createStoreAction } from "../../actions";

export default async function NewStorePage() {
  await requireAdmin();
  return (
    <main className="flex min-h-full items-center justify-center bg-zinc-50 px-4">
      <div className="w-full max-w-md">
        <Card title="Ajouter une boutique" description="Chaque boutique a sa propre connexion Shopify, son compte Whop et son design.">
          <form action={createStoreAction} className="space-y-4">
            <div>
              <Label htmlFor="name">Nom de la boutique</Label>
              <Input id="name" name="name" placeholder="Ma boutique" required autoFocus />
            </div>
            <SubmitButton className="w-full">Créer la boutique</SubmitButton>
          </form>
        </Card>
      </div>
    </main>
  );
}
