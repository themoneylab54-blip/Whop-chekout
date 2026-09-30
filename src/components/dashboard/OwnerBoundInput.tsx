import type { ComponentProps } from "react";
import { Lock } from "lucide-react";
import { Input } from "@/components/ui";
import { OWNER_ONLY_NOTE } from "./OwnerOnly";

/**
 * Id used with an owner-only token or key (pixel, ad account, Telegram chat, sender…). `locked`
 * (the token is stored and the user isn't the owner): read-only, with the owner-only note — the
 * form still submits the current value, which the action keeps (see src/lib/owner-bound.ts).
 */
export function OwnerBoundInput({ locked, ...props }: ComponentProps<"input"> & { locked: boolean }) {
  if (!locked) return <Input {...props} />;
  const noteId = props.id ? `${props.id}-owner-only` : undefined;
  return (
    <>
      <Input {...props} readOnly aria-readonly aria-describedby={noteId} className={`cursor-not-allowed bg-zinc-50 text-zinc-600 ${props.className ?? ""}`} />
      <p id={noteId} className="mt-1 inline-flex items-center gap-1 text-xs text-zinc-500" data-owner-only>
        <Lock className="h-3 w-3" aria-hidden /> {OWNER_ONLY_NOTE}
      </p>
    </>
  );
}
