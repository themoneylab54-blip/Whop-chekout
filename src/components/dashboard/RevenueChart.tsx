"use client";

import { useMemo, useRef, useState } from "react";
import { stableCentsCompact, stableCentsRound, stablePlural } from "./stableFormat";
import { FlagLegend, flagStyle, type DayFlagKind } from "./chartFlags";

/**
 * One day of the chart. `valueLabel` / `ordersLabel` are optional preformatted strings (computed
 * on the server); without them the chart formats with a deterministic, Intl-free formatter so
 * the server and browser renders always match (no hydration mismatch).
 */
export type DailyPoint = {
  date: string;
  label: string;
  cents: number;
  orders: number;
  valueLabel?: string;
  ordersLabel?: string;
  /** A caveat about the day (e.g. the Shopify checkout fallback was on): shaded band, tooltip line and table column. */
  flag?: string;
  /** Which caveat (pattern of the shaded band + legend): automatic fallback, checkout switched off, or both. */
  flagKind?: DayFlagKind;
  /** Optional second series (e.g. sales outside this checkout): dashed line, tooltip line and table column. */
  secondary?: number;
};

/** 0 → nice step so that `count` steps cover `max` (1, 2, 2.5, 5 × 10ⁿ). */
function niceStep(max: number, count: number) {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

/**
 * Single-series area chart (revenue per day): 2px line, soft area, y-axis with 4 gridlines,
 * crosshair + tooltip on hover / touch / arrow keys, and a table fallback for screen readers.
 * Axis labels are HTML (not SVG text) so they stay ≥ 11px however narrow the chart gets.
 */
export function RevenueChart({ points, currency, height = 200, secondaryLabel }: { points: DailyPoint[]; currency: string; height?: number; secondaryLabel?: string }) {
  const plotRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const { ticks, top } = useMemo(() => {
    const max = Math.max(0, ...points.map((p) => Math.max(p.cents, secondaryLabel ? (p.secondary ?? 0) : 0)));
    // Minimum scale of 100 € so an empty period still shows a readable axis.
    const step = niceStep(Math.max(max, 10_000), 3);
    return { ticks: [0, step, step * 2, step * 3], top: step * 3 };
  }, [points, secondaryLabel]);

  const n = points.length;
  const xPct = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);
  const yPct = (c: number) => 100 - (Math.max(0, c) / top) * 100;

  // SVG in a 1000×100 box stretched to the plot (strokes stay 2px thanks to non-scaling-stroke).
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${(xPct(i) * 10).toFixed(1)},${yPct(p.cents).toFixed(2)}`).join(" ");
  const area = n ? `${line} L${(xPct(n - 1) * 10).toFixed(1)},100 L${(xPct(0) * 10).toFixed(1)},100 Z` : "";
  const hasSecondary = !!secondaryLabel && points.some((p) => p.secondary != null);
  // Days without data (before the import covers them) break the line instead of drawing a false 0.
  const line2 = hasSecondary
    ? points
        .map((p, i) => (p.secondary == null ? "" : `${i === 0 || points[i - 1].secondary == null ? "M" : "L"}${(xPct(i) * 10).toFixed(1)},${yPct(p.secondary).toFixed(2)}`))
        .filter(Boolean)
        .join(" ")
    : "";
  const xTicks = n > 1 ? [...new Set([0, Math.round((n - 1) / 3), Math.round(((n - 1) * 2) / 3), n - 1])] : [0];

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box || n === 0) return;
    const i = Math.round(((e.clientX - box.left) / box.width) * (n - 1));
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
    } else if (e.key === "Escape") {
      setHover(null);
    }
  }

  const h = hover != null ? points[hover] : null;
  const hx = hover != null ? xPct(hover) : 0;

  return (
    <div className="relative">
      <div className="flex gap-2">
        {/* Y axis */}
        <div className="relative w-12 shrink-0" style={{ height }} aria-hidden>
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute right-0 -translate-y-1/2 text-[11px] leading-none whitespace-nowrap text-zinc-500 tabular-nums"
              style={{ top: `${yPct(t)}%` }}
            >
              {stableCentsCompact(t, currency)}
            </span>
          ))}
        </div>

        {/* Plot */}
        <div
          ref={plotRef}
          className="relative min-w-0 flex-1 cursor-crosshair touch-pan-y rounded-sm"
          style={{ height }}
          tabIndex={0}
          role="img"
          // Day labels may end with an abbreviation point ("28 sept."): no double period.
          aria-label={`Chiffre d'affaires par jour, du ${points[0]?.label ?? ""} au ${(points[n - 1]?.label ?? "").replace(/\.$/, "")}. Flèches gauche et droite pour parcourir les jours.`}
          onPointerMove={onMove}
          onPointerDown={onMove}
          onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
          onKeyDown={onKey}
          onBlur={() => setHover(null)}
        >
          {points.map((p, i) =>
            p.flag ? (
              <div
                key={`flag-${p.date}`}
                className="pointer-events-none absolute inset-y-0"
                style={{
                  ...flagStyle(p.flagKind ?? "fallback"),
                  left: `${Math.max(0, n <= 1 ? 0 : xPct(i) - 50 / (n - 1))}%`,
                  width: `${n <= 1 ? 100 : Math.min(100 / (n - 1), 100)}%`,
                }}
                aria-hidden
              />
            ) : null,
          )}
          <svg viewBox="0 0 1000 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden>
            <defs>
              <linearGradient id="rev-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#6366f1" stopOpacity="0.2" />
                <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
              </linearGradient>
            </defs>
            {ticks.map((t, i) => (
              <line
                key={t}
                x1={0}
                x2={1000}
                y1={yPct(t)}
                y2={yPct(t)}
                stroke={i === 0 ? "#d4d4d8" : "#e4e4e7"}
                strokeDasharray={i === 0 ? undefined : "3 4"}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {area && <path d={area} fill="url(#rev-area)" />}
            {line2 && (
              <path d={line2} fill="none" stroke="#d97706" strokeWidth={1.5} strokeDasharray="4 3" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
            )}
            {line && (
              <path d={line} fill="none" stroke="#4f46e5" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
            )}
            {h && <line x1={hx * 10} x2={hx * 10} y1={0} y2={100} stroke="#a1a1aa" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />}
          </svg>

          {h && (
            <>
              <span
                className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600 ring-2 ring-white shadow"
                style={{ left: `${hx}%`, top: `${yPct(h.cents)}%` }}
                aria-hidden
              />
              <div
                role="status"
                className={`pointer-events-none absolute top-0 z-10 rounded-lg bg-zinc-900 px-2.5 py-1.5 text-xs whitespace-nowrap text-white shadow-lg ${
                  hx > 55 ? "-translate-x-full" : ""
                }`}
                style={{ left: hx > 55 ? `calc(${hx}% - 10px)` : `calc(${hx}% + 10px)` }}
              >
                <p className="text-zinc-300">{h.label}</p>
                <p className="font-semibold tabular-nums">{h.valueLabel ?? stableCentsRound(h.cents, currency)}</p>
                <p className="text-zinc-300">{h.ordersLabel ?? stablePlural(h.orders, "commande")}</p>
                {hasSecondary && (
                  <p className="text-amber-200 tabular-nums">
                    {secondaryLabel} : {h.secondary == null ? "non importé" : stableCentsRound(h.secondary, currency)}
                  </p>
                )}
                {h.flag && <p className="text-amber-300">{h.flag}</p>}
              </div>
            </>
          )}
        </div>
      </div>

      {/* X axis */}
      <div className="relative mt-2 ml-14 h-4" aria-hidden>
        {xTicks.map((i) => (
          <span
            key={i}
            className={`absolute top-0 text-[11px] leading-none whitespace-nowrap text-zinc-500 ${
              i === 0 ? "translate-x-0" : i === n - 1 ? "-translate-x-full" : "-translate-x-1/2"
            }`}
            style={{ left: `${xPct(i)}%` }}
          >
            {points[i]?.label}
          </span>
        ))}
      </div>

      <FlagLegend kinds={points.map((p) => (p.flag ? (p.flagKind ?? "fallback") : undefined))} className="mt-2 ml-14" />
      {hasSecondary && (
        <div className="mt-2 ml-14 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-600" aria-hidden>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded bg-indigo-600" /> Ce checkout
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="w-4 border-t-2 border-dashed border-amber-600" /> {secondaryLabel}
          </span>
        </div>
      )}

      <div className="sr-only">
        <table>
          <caption>Chiffre d&apos;affaires par jour</caption>
          <thead>
            <tr>
              <th scope="col">Jour</th>
              <th scope="col">Chiffre d&apos;affaires</th>
              <th scope="col">Commandes</th>
              {hasSecondary && <th scope="col">{secondaryLabel}</th>}
              {points.some((p) => p.flag) && <th scope="col">Remarque</th>}
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.date}>
                <td>{p.label}</td>
                <td>{p.valueLabel ?? stableCentsRound(p.cents, currency)}</td>
                <td>{p.orders}</td>
                {hasSecondary && <td>{p.secondary == null ? "—" : stableCentsRound(p.secondary, currency)}</td>}
                {points.some((x) => x.flag) && <td>{p.flag ?? ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
