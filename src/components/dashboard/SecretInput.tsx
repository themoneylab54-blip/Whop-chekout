import { Lock } from "lucide-react";
import { Input } from "@/components/ui";
import { OWNER_ONLY_NOTE } from "./OwnerOnly";

/**
 * Secret field that never renders the stored value: blank keeps it, typing replaces it,
 * and a checkbox erases it. `locked` (API keys and tokens are the account owner's): only whether
 * one is saved, no field — the form then keeps the stored value.
 */
export function SecretInput({ name, stored, placeholder, locked = false }: { name: string; stored: boolean; placeholder?: string; locked?: boolean }) {
  if (locked) {
    return (
      <p id={name} className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-zinc-700" data-owner-only>
        <span className="font-mono text-xs">{stored ? "•••••••• enregistré" : "Non renseigné"}</span>
        <span className="inline-flex items-center gap-1 text-xs text-zinc-500">
          <Lock className="h-3 w-3" aria-hidden /> {OWNER_ONLY_NOTE}
        </span>
      </p>
    );
  }
  return (
    <div>
      <Input
        id={name}
        name={name}
        type="password"
        autoComplete="off"
        placeholder={stored ? "•••••••• enregistré — laissez vide pour conserver" : placeholder}
      />
      {stored && (
        <label className="mt-1.5 flex items-center gap-1.5 text-xs text-zinc-500">
          <input type="checkbox" name={`${name}Clear`} className="h-3.5 w-3.5" /> Supprimer la valeur enregistrée
        </label>
      )}
    </div>
  );
}
