import { Input } from "@/components/ui";

/**
 * Secret field that never renders the stored value: blank keeps it, typing replaces it,
 * and a checkbox erases it.
 */
export function SecretInput({ name, stored, placeholder }: { name: string; stored: boolean; placeholder?: string }) {
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
