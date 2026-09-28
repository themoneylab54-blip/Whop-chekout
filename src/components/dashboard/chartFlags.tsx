import type { CSSProperties } from "react";

/**
 * Why a chart day is shaded: the automatic Shopify fallback (solid amber) or the Whop checkout
 * switched off by hand (grey hatching) — told apart by pattern, not colour alone.
 */
export type DayFlagKind = "fallback" | "disabled" | "both";

const HATCH = "repeating-linear-gradient(135deg, rgba(82,82,91,.28) 0 3px, transparent 3px 7px)";

/** Background of a flagged day slot (bars / bands). */
export function flagStyle(kind: DayFlagKind | undefined): CSSProperties | undefined {
  if (!kind) return undefined;
  if (kind === "fallback") return { backgroundColor: "rgba(254,243,199,.85)" };
  if (kind === "disabled") return { backgroundColor: "rgba(244,244,245,.9)", backgroundImage: HATCH };
  return { backgroundColor: "rgba(254,243,199,.85)", backgroundImage: HATCH };
}

const LABELS: Record<Exclude<DayFlagKind, "both">, string> = {
  fallback: "Checkout Shopify de secours",
  disabled: "Checkout Whop désactivé",
};

/** Small legend under a chart: only the kinds present in the period. */
export function FlagLegend({ kinds, className = "" }: { kinds: (DayFlagKind | undefined)[]; className?: string }) {
  const present = (["fallback", "disabled"] as const).filter((k) => kinds.some((x) => x === k || x === "both"));
  if (!present.length) return null;
  return (
    <div className={`flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-600 ${className}`} aria-hidden>
      {present.map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-[2px] ring-1 ring-zinc-300" style={flagStyle(k)} /> {LABELS[k]}
        </span>
      ))}
    </div>
  );
}
