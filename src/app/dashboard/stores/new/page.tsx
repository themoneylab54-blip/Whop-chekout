import { requireAdmin } from "@/lib/auth";
import { Input, Label, SubmitButton } from "@/components/ui";
import { AuthShell } from "@/components/dashboard/AuthShell";
import { createStoreAction } from "../../actions";

export default async function NewStorePage() {
  await requireAdmin();
  return (
    <AuthShell title="Ajouter une boutique" subtitle="Chaque boutique a sa propre connexion Shopify, son compte Whop et son design.">
      <form action={createStoreAction} className="space-y-4">
        <div>
          <Label htmlFor="name">Nom de la boutique</Label>
          <Input id="name" name="name" placeholder="Ma boutique" required autoFocus />
        </div>
        <SubmitButton className="w-full py-2.5">Créer la boutique</SubmitButton>
      </form>
    </AuthShell>
  );
}
