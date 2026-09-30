import { Lock } from "lucide-react";

export const OWNER_ONLY_NOTE = "Réservé au propriétaire du compte";

/**
 * Shown to admins and viewers in place of an owner-only control (payment / platform connections,
 * API keys, store deletion…): the action would be refused, so it isn't offered.
 */
export function OwnerOnlyNote({ children, className = "" }: { children?: React.ReactNode; className?: string }) {
  return (
    <p className={`flex items-start gap-2 rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-700 ring-1 ring-zinc-900/5 ${className}`} data-owner-only>
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" aria-hidden />
      <span>
        <strong className="font-medium">{OWNER_ONLY_NOTE}</strong>
        {children ? <> — {children}</> : "."}
      </span>
    </p>
  );
}
