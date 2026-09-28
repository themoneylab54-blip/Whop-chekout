import { humanizeError } from "@/lib/humanize-error";

/**
 * A provider error in plain French, the raw message one click away ("Détail technique") for
 * support. `prefix` is prepended to the sentence (e.g. "Échec : ").
 */
export function ErrorText({ raw, prefix, provider, className = "" }: { raw: string | null | undefined; prefix?: string; /** Provider id (metrics), for its own access hint. */ provider?: string; className?: string }) {
  const { text, detail } = humanizeError(raw, { provider });
  return (
    <span className={`block break-words ${className}`}>
      {prefix}
      {text}
      {detail && (
        <details className="mt-0.5 text-[11px] font-normal text-zinc-500">
          <summary className="w-fit cursor-pointer list-none underline decoration-dotted underline-offset-2 [&::-webkit-details-marker]:hidden">Détail technique</summary>
          <code className="mt-1 block font-mono break-all whitespace-pre-wrap">{detail}</code>
        </details>
      )}
    </span>
  );
}
