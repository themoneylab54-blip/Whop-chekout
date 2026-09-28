import { useId } from "react";
import { CopyButton, inputClass } from "@/components/ui";

/** Read-only value + copy button, with a real label tied to the field (screen readers, axe). */
export function CopyField({ value, label }: { value: string; label?: string }) {
  const id = useId();
  return (
    <div className="min-w-0">
      {label && (
        <label htmlFor={id} className="mb-1.5 block text-xs font-medium text-zinc-600">
          {label}
        </label>
      )}
      <div className="flex gap-2">
        <input
          id={id}
          readOnly
          value={value}
          aria-label={label ? undefined : "Valeur à copier"}
          className={`${inputClass} min-w-0 bg-zinc-50 font-mono text-xs`}
        />
        <CopyButton value={value} />
      </div>
    </div>
  );
}
