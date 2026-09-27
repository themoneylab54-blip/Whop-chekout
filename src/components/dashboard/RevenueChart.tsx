"use client";

import { useMemo, useRef, useState } from "react";

export type DailyPoint = { date: string; label: string; cents: number; orders: number };

/**
 * Single-series area chart (revenue per day): 2px line, soft area, recessive axis,
 * crosshair + tooltip on hover, and a table fallback for screen readers.
 */
export function RevenueChart({ points, currency, height = 180 }: { points: DailyPoint[]; currency: string; height?: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const pad = { top: 12, right: 8, bottom: 24, left: 8 };
  const fmt = useMemo(() => new Intl.NumberFormat("fr-FR", { style: "currency", currency, maximumFractionDigits: 0 }), [currency]);

  const max = Math.max(1, ...points.map((p) => p.cents));
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (c: number) => pad.top + innerH - (c / max) * innerH;

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.cents).toFixed(1)}`).join(" ");
  const area = points.length ? `${line} L${x(points.length - 1).toFixed(1)},${pad.top + innerH} L${x(0).toFixed(1)},${pad.top + innerH} Z` : "";
  const ticks = points.length > 1 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : [0];

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const box = ref.current?.getBoundingClientRect();
    if (!box || points.length === 0) return;
    const rel = ((e.clientX - box.left) / box.width) * width;
    const i = Math.round(((rel - pad.left) / innerW) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  }

  const h = hover != null ? points[hover] : null;

  return (
    <div className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-label="Chiffre d'affaires par jour"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="rev-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#6366f1" stopOpacity="0.22" />
            <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.5, 1].map((f) => (
          <line key={f} x1={pad.left} x2={width - pad.right} y1={pad.top + innerH * (1 - f)} y2={pad.top + innerH * (1 - f)} stroke="#e4e4e7" strokeDasharray="3 4" />
        ))}
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + innerH} y2={pad.top + innerH} stroke="#e4e4e7" />
        {area && <path d={area} fill="url(#rev-area)" />}
        {line && <path d={line} fill="none" stroke="#4f46e5" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />}
        {ticks.map((i) => (
          <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"} className="fill-zinc-400 text-[11px]">
            {points[i]?.label}
          </text>
        ))}
        {h && hover != null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke="#a1a1aa" strokeDasharray="2 3" />
            <circle cx={x(hover)} cy={y(h.cents)} r={5} fill="#4f46e5" stroke="#fff" strokeWidth={2} />
          </g>
        )}
      </svg>
      {h && hover != null && (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg"
          style={{ left: `${(x(hover) / width) * 100}%` }}
        >
          <p className="text-zinc-400">{h.label}</p>
          <p className="font-semibold tabular-nums">{fmt.format(h.cents / 100)}</p>
          <p className="text-zinc-400">
            {h.orders} commande{h.orders > 1 ? "s" : ""}
          </p>
        </div>
      )}
      <table className="sr-only">
        <caption>Chiffre d&apos;affaires par jour</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <td>{p.label}</td>
              <td>{fmt.format(p.cents / 100)}</td>
              <td>{p.orders}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
