import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import { formatDelta } from "./format";

/**
 * Change vs the previous period: arrow icon + signed percent + color, never color alone.
 * `inverse` flips the colors for metrics where going up is bad (abandons).
 */
export function DeltaBadge({ value, inverse = false, label, onDark = false }: { value: number | null; inverse?: boolean; label: string; onDark?: boolean }) {
  if (value == null) {
    return (
      <span className={`inline-flex items-center gap-1 text-xs ${onDark ? "text-white/70" : "text-zinc-500"}`}>
        <span className="font-medium">Nouveau</span>
        <span className="sr-only">: aucune donnée sur la période précédente</span>
        <span aria-hidden>· {label}</span>
      </span>
    );
  }
  const flat = Math.abs(value) < 0.005;
  const up = value > 0;
  const good = flat ? null : up !== inverse;
  const Icon = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;
  const tone = flat
    ? "bg-zinc-100 text-zinc-600 ring-zinc-500/15"
    : good
      ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
      : "bg-rose-50 text-rose-700 ring-rose-600/20";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-xs">
      <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold tabular-nums ring-1 ring-inset ${tone}`}>
        <Icon className="h-3 w-3" strokeWidth={2.5} aria-hidden />
        <span className="sr-only">{flat ? "Stable" : up ? "En hausse de" : "En baisse de"} </span>
        {flat ? "0 %" : formatDelta(value)}
      </span>
      <span className={onDark ? "text-white/70" : "text-zinc-500"}>{label}</span>
    </span>
  );
}

/** Tiny inline trend line (decorative: the number next to it carries the meaning). */
export function Sparkline({ values, color = "#6366f1", width = 96, height = 28 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return <span className="inline-block h-7 w-[72px] sm:w-24" aria-hidden />;
  const max = Math.max(...values);
  // Data range, not zero-based: ratios (basket, conversion) would otherwise hug the top.
  const min = Math.min(...values);
  const span = max - min || 1;
  const pad = 2;
  const pts = values.map((v, i) => [
    pad + (i / (values.length - 1)) * (width - pad * 2),
    pad + (height - pad * 2) * (1 - (v - min) / span),
  ]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height - pad} L${pts[0][0].toFixed(1)},${height - pad} Z`;
  const [lx, ly] = pts[pts.length - 1];
  const gid = `spark-${color.replace(/[^a-z0-9]/gi, "")}`;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} aria-hidden className="h-auto w-[72px] shrink-0 overflow-visible sm:w-24">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.18" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.75} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r={2.5} fill={color} stroke="#fff" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
