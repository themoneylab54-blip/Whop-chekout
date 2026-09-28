"use client";

import { useMemo, useRef, useState } from "react";
import { stableCentsCompact, stableCentsRound } from "./stableFormat";
import { FlagLegend, flagStyle, type DayFlagKind } from "./chartFlags";

/**
 * Daily profit bars that can go below zero (emerald above the axis, rose below), with a y-axis,
 * a tooltip on hover / touch / arrow keys and a table for screen readers. Same conventions as
 * RevenueChart: HTML axis labels, deterministic Intl-free formatting (no hydration mismatch);
 * day labels come preformatted from the server.
 */
export type ProfitPoint = {
  date: string;
  label: string;
  cents: number;
  /**
   * How the day's figure is made (e.g. CA HT, − frais Whop, − coûts, − litiges, − sinistres): shown
   * in the tooltip and the screen-reader table. The parts add up to `cents`.
   */
  parts?: { label: string; cents: number }[];
  /** A caveat about the day (e.g. the Shopify checkout fallback was on): shaded bar slot, tooltip line and table column. */
  flag?: string;
  /** Which caveat (pattern of the shaded slot + legend): automatic fallback, checkout switched off, or both. */
  flagKind?: DayFlagKind;
};

function niceStep(max: number, count: number) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

export function ProfitChart({ points, currency, title, height = 180 }: { points: ProfitPoint[]; currency: string; title: string; height?: number }) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { ticks, top, bottom } = useMemo(() => {
    const max = Math.max(0, ...points.map((p) => p.cents));
    const min = Math.min(0, ...points.map((p) => p.cents));
    // One step size for both sides; at least 100 € so a flat period stays readable.
    const step = niceStep(Math.max(max - min, 10_000), 4);
    const top = Math.max(step, Math.ceil(max / step) * step);
    const bottom = min < 0 ? Math.floor(min / step) * step : 0;
    const ticks: number[] = [];
    for (let t = bottom; t <= top + step / 2; t += step) ticks.push(Math.round(t));
    return { ticks, top, bottom };
  }, [points]);

  const n = points.length;
  const span = top - bottom || 1;
  const yPct = (c: number) => ((top - c) / span) * 100;
  const zero = yPct(0);

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box || n === 0) return;
    const i = Math.floor(((e.clientX - box.left) / box.width) * n);
    setHover(Math.max(0, Math.min(n - 1, i)));
  }

  function onKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (n === 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      setHover((h) => Math.max(0, Math.min(n - 1, (h ?? (e.key === "ArrowRight" ? -1 : n)) + (e.key === "ArrowRight" ? 1 : -1))));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setHover(e.key === "Home" ? 0 : n - 1);
    } else if (e.key === "Escape") setHover(null);
  }

  const h = hover != null ? points[hover] : null;
  const hx = hover != null ? ((hover + 0.5) / n) * 100 : 0;
  const xTicks = n > 1 ? [...new Set([0, Math.round((n - 1) / 2), n - 1])] : [0];

  return (
    <div className="relative">
      <div className="flex gap-2">
        <div className="relative w-14 shrink-0" style={{ height }} aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 -translate-y-1/2 text-[11px] leading-none whitespace-nowrap text-zinc-500 tabular-nums" style={{ top: `${yPct(t)}%` }}>
              {stableCentsCompact(t, currency)}
            </span>
          ))}
        </div>
        <div
          ref={plotRef}
          className="relative min-w-0 flex-1 cursor-crosshair touch-pan-y rounded-sm focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:outline-none"
          style={{ height }}
          tabIndex={0}
          role="img"
          aria-label={`${title}, du ${points[0]?.label ?? ""} au ${points[n - 1]?.label ?? ""}. Flèches gauche et droite pour parcourir les jours.`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {ticks.map((t) => (
            <div key={t} className={`absolute inset-x-0 border-t ${t === 0 ? "border-zinc-300" : "border-dashed border-zinc-200"}`} style={{ top: `${yPct(t)}%` }} aria-hidden />
          ))}
          <div className="absolute inset-0 flex gap-[2px]" aria-hidden>
            {points.map((p, i) => {
              const hPct = (Math.abs(p.cents) / span) * 100;
              return (
                <div key={p.date} className="relative h-full min-w-0 flex-1" style={p.flag ? flagStyle(p.flagKind ?? "fallback") : undefined}>
                  {p.cents !== 0 && (
                    <div
                      className={`absolute inset-x-0 ${p.cents > 0 ? "rounded-t-[2px] bg-emerald-500" : "rounded-b-[2px] bg-rose-400"} ${hover === i ? "opacity-80" : ""}`}
                      style={p.cents > 0 ? { bottom: `${100 - zero}%`, height: `${Math.max(hPct, 0.8)}%` } : { top: `${zero}%`, height: `${Math.max(hPct, 0.8)}%` }}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {h && (
            <div
              role="status"
              className={`pointer-events-none absolute top-0 z-10 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg ${hx > 55 ? "-translate-x-full" : ""}`}
              style={{ left: hx > 55 ? `calc(${hx}% - 10px)` : `calc(${hx}% + 10px)` }}
            >
              <p className="text-zinc-300">{h.label}</p>
              <p className="font-semibold tabular-nums">{stableCentsRound(h.cents, currency)}</p>
              {h.parts?.map((p) => (
                <p key={p.label} className="flex justify-between gap-3 text-[11px] text-zinc-300 tabular-nums">
                  <span>{p.label}</span>
                  <span>{stableCentsRound(p.cents, currency)}</span>
                </p>
              ))}
              {h.flag && <p className="text-[11px] text-amber-300">{h.flag}</p>}
            </div>
          )}
        </div>
      </div>
      <div className="relative mt-2 ml-16 h-4" aria-hidden>
        {xTicks.map((i) => (
          <span
            key={i}
            className={`absolute top-0 text-[11px] leading-none whitespace-nowrap text-zinc-500 ${i === 0 ? "translate-x-0" : i === n - 1 ? "-translate-x-full" : "-translate-x-1/2"}`}
            style={{ left: `${i === 0 ? 0 : i === n - 1 ? 100 : ((i + 0.5) / n) * 100}%` }}
          >
            {points[i]?.label}
          </span>
        ))}
      </div>
      <FlagLegend kinds={points.map((p) => (p.flag ? (p.flagKind ?? "fallback") : undefined))} className="mt-2 ml-16" />
      <div className="sr-only">
        <table>
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">Jour</th>
              <th scope="col">Montant</th>
              {points[0]?.parts?.map((p) => (
                <th key={p.label} scope="col">
                  {p.label}
                </th>
              ))}
              {points.some((p) => p.flag) && <th scope="col">Remarque</th>}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.date}>
                <td>{p.label}</td>
                <td>{stableCentsRound(p.cents, currency)}</td>
                {p.parts?.map((x) => <td key={x.label}>{stableCentsRound(x.cents, currency)}</td>)}
                {points.some((x) => x.flag) && <td>{p.flag ?? ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
