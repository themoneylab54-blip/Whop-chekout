import Link from "next/link";
import type { ReactNode } from "react";
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, CheckCircle2, Download, Hourglass, Info, Scissors, TrendingUp, XCircle, type LucideIcon } from "lucide-react";
import { IconTile } from "@/components/icons";
import { Sparkline } from "./Trend";
import { PopoverDetails } from "./Popover";

/*
 * Building blocks of the analytics screens (server components, no client JS):
 * KPI tiles with honest deltas, info popovers, tables that scroll inside their card,
 * and small bar charts with a text summary for screen readers.
 */

const LOCALE = "fr-FR";

/** Whop payment method ids → labels ("inconnu" = not reported by Whop). */
export const METHOD_LABELS: Record<string, string> = {
  card: "Carte",
  apple_pay: "Apple Pay",
  google_pay: "Google Pay",
  paypal: "PayPal",
  klarna: "Klarna",
  alma: "Alma",
  oney_3x: "Oney 3x",
  oney_4x: "Oney 4x",
  bancontact: "Bancontact",
  ideal: "iDEAL",
  sepa_debit: "SEPA",
  scalapay: "Scalapay",
  twint: "TWINT",
  eps: "EPS",
  p24: "Przelewy24",
  blik: "BLIK",
  multibanco: "Multibanco",
  mb_way: "MB WAY",
  satispay: "Satispay",
  revolut_pay: "Revolut Pay",
  klarna_pay_now: "Klarna",
  card_installments_three: "Carte 3x",
  inconnu: "Non précisé",
};


/** 0.1234 → "12,3 %"; digits adapt to the size so small rates stay readable. */
export function pct(v: number | null | undefined, digits?: number): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const d = digits ?? (Math.abs(v) < 0.1 ? 1 : 0);
  return new Intl.NumberFormat(LOCALE, { style: "percent", minimumFractionDigits: d, maximumFractionDigits: d }).format(v);
}

/** 2.345 → "2,35" (ROAS, POAS). */
export function multiple(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
}

export function int(v: number): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(v);
}

/**
 * Relative change as a signed percent: never "−0 %" (a change that rounds to zero reads "0 %"),
 * one decimal under 10 %.
 */
export function formatChange(ratio: number): { text: string; sign: -1 | 0 | 1 } {
  const abs = Math.abs(ratio);
  const digits = abs < 0.1 ? 1 : 0;
  const rounded = Number((abs * 100).toFixed(digits));
  if (rounded === 0) return { text: "0 %", sign: 0 };
  const text = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(rounded);
  return { text: `${ratio > 0 ? "+" : "−"}${text} %`, sign: ratio > 0 ? 1 : -1 };
}

export type DeltaInput =
  /** `estimated`: one of the two values is an estimate (e.g. incomplete costs), badge "≈ estimé". */
  /** `neutral`: neither direction is good or bad (e.g. ad spend): arrow and sign only, grey. */
  | { now: number; before: number; inverse?: boolean; estimated?: boolean; neutral?: boolean }
  /** No comparison possible: the reason is shown instead of a chip. */
  | { unavailable: string };

/** Change vs the previous period, with arrow + sign + color (never color alone). */
export function Delta({
  d,
  label = "vs période précédente",
  compact,
  hideEstimatedBadge,
}: {
  d: DeltaInput;
  label?: string;
  /** Chip only (tables): no label, no separate "estimé" badge. */
  compact?: boolean;
  /** The figure next to it already carries an EstimatedBadge: only the chip's "≈" stays (one badge per figure). */
  hideEstimatedBadge?: boolean;
}) {
  if ("unavailable" in d) return <span className="text-[11px] leading-snug text-zinc-500">{d.unavailable}</span>;
  if (d.before === 0 && d.now === 0) return <span className="text-[11px] text-zinc-500">stable · {label}</span>;
  if (d.before === 0) return <span className="text-[11px] text-zinc-500">rien sur la période précédente</span>;
  const ratio = (d.now - d.before) / Math.abs(d.before);
  const { text, sign } = formatChange(ratio);
  const good = sign === 0 || d.neutral ? null : (sign > 0) !== !!d.inverse;
  const Icon = sign === 0 ? ArrowRight : sign > 0 ? ArrowUpRight : ArrowDownRight;
  const tone =
    good == null ? "bg-zinc-100 text-zinc-600 ring-zinc-500/15" : good ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20" : "bg-rose-50 text-rose-700 ring-rose-600/20";
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px]">
      <span
        className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 font-semibold whitespace-nowrap tabular-nums ring-1 ring-inset ${tone}`}
        title={d.estimated ? "Comparaison approximative : coûts incomplets sur l'une des deux périodes" : undefined}
      >
        <Icon className="h-3 w-3" strokeWidth={2.5} aria-hidden />
        <span className="sr-only">{sign === 0 ? "Stable" : sign > 0 ? "En hausse de" : "En baisse de"} </span>
        {d.estimated && <span aria-hidden>≈ </span>}
        {text}
        {d.estimated && <span className="sr-only"> (approximatif)</span>}
      </span>
      {d.estimated && !compact && !hideEstimatedBadge && (
        <span className="rounded-full bg-amber-50 px-1.5 py-0.5 font-medium text-amber-800 ring-1 ring-amber-600/20 ring-inset" title="Coûts incomplets sur l'une des deux périodes : comparaison approximative">
          ≈ estimé
        </span>
      )}
      {label && !compact && <span className="text-zinc-500">{label}</span>}
    </span>
  );
}

/** Small "ⓘ" popover (keyboard and touch friendly; Escape / outside click close it). */
export function InfoTip({ label, children, align = "left" }: { label: string; children: ReactNode; align?: "left" | "right" }) {
  return (
    <PopoverDetails className="group relative inline-block align-middle">
      <summary
        className="inline-flex h-5 w-5 cursor-pointer list-none items-center justify-center rounded-full text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 focus-visible:ring-2 focus-visible:ring-indigo-500 [&::-webkit-details-marker]:hidden"
        aria-label={label}
      >
        <Info className="h-3.5 w-3.5" aria-hidden />
      </summary>
      <div
        className={`absolute top-6 z-30 hidden w-72 rounded-xl bg-zinc-900 p-3 text-left text-xs leading-relaxed font-normal whitespace-normal text-zinc-100 shadow-[var(--shadow-float)] group-open:block max-sm:fixed max-sm:inset-x-4 max-sm:top-auto max-sm:mt-6 max-sm:w-auto ${align === "right" ? "right-0" : "left-0"}`}
      >
        {children}
      </div>
    </PopoverDetails>
  );
}

export function KpiTile({
  label,
  value,
  secondary,
  hint,
  delta,
  spark,
  info,
  tone,
  estimated,
}: {
  label: string;
  value: string;
  /** Figure built on incomplete costs: one "≈ estimé" badge next to it (not repeated on the change). */
  estimated?: boolean;
  secondary?: ReactNode;
  hint?: ReactNode;
  delta?: DeltaInput;
  spark?: number[];
  info?: ReactNode;
  tone?: "good" | "bad";
}) {
  return (
    <section aria-label={label} className="@container flex min-w-0 flex-col rounded-2xl bg-white p-3.5 shadow-[var(--shadow-card)] sm:p-4">
      {/* Sparkline top-right on every tile (same spot as the overview's KPI cards). It never
          shrinks and steps aside on narrow tiles (< 180px, e.g. two columns at 390px) so the
          label always has room to wrap instead of running under it. */}
      <div className="flex min-h-[30px] items-start justify-between gap-2">
        <h2 className="flex min-w-0 flex-wrap items-center gap-1 text-xs font-medium break-words text-zinc-600">
          {label}
          {info && <InfoTip label={`À propos : ${label}`}>{info}</InfoTip>}
        </h2>
        {spark && spark.some((v) => v !== 0) && (
          <span className="hidden shrink-0 @[180px]:block" aria-hidden>
            <Sparkline values={spark} width={72} height={22} />
          </span>
        )}
      </div>
      <p className={`mt-1 text-xl font-semibold tracking-tight tabular-nums ${tone === "bad" ? "text-rose-700" : "text-zinc-900"}`}>
        {value}
        {estimated && <EstimatedBadge />}
      </p>
      {secondary && <p className="text-xs text-zinc-500 tabular-nums">{secondary}</p>}
      <div className="mt-1.5 flex min-h-5 flex-wrap items-center justify-between gap-2">
        {delta ? <Delta d={delta} hideEstimatedBadge={estimated} /> : <span />}
      </div>
      {hint && <p className="mt-1 text-[11px] leading-snug text-zinc-500">{hint}</p>}
    </section>
  );
}

export type Column = { label: string; align?: "left" | "right"; hideBelow?: "sm" | "md"; info?: ReactNode };

/** Table that scrolls horizontally inside its card on phones (never the page). */
export function DataTable({
  caption,
  columns,
  rows,
  empty,
  footer,
  minWidth = 0,
}: {
  caption: string;
  columns: Column[];
  rows: { key: string; cells: ReactNode[]; muted?: boolean }[];
  empty: string;
  footer?: ReactNode[];
  minWidth?: number;
}) {
  if (!rows.length) return <p className="text-sm text-zinc-500">{empty}</p>;
  // Wide tables: an edge shadow shows there is more to scroll (hidden once scrolled to that end).
  const scrollShadow = minWidth
    ? {
        background:
          "linear-gradient(to right, #fff 30%, rgba(255,255,255,0)) left center / 32px 100% no-repeat local, linear-gradient(to left, #fff 30%, rgba(255,255,255,0)) right center / 32px 100% no-repeat local, radial-gradient(farthest-side at 0 50%, rgba(24,24,27,.14), rgba(24,24,27,0)) left center / 12px 100% no-repeat scroll, radial-gradient(farthest-side at 100% 50%, rgba(24,24,27,.14), rgba(24,24,27,0)) right center / 12px 100% no-repeat scroll",
        backgroundColor: "#fff",
      }
    : undefined;
  const hide = (c: Column) => (c.hideBelow === "sm" ? "hidden sm:table-cell" : c.hideBelow === "md" ? "hidden md:table-cell" : "");
  const align = (c: Column, i: number) => ((c.align ?? (i === 0 ? "left" : "right")) === "right" ? "text-right tabular-nums" : "text-left");
  return (
    <div className="relative -mx-5 overflow-x-auto px-5 [scrollbar-width:thin]" style={scrollShadow} tabIndex={0} role="region" aria-label={caption}>
      <table className="w-full text-sm" style={minWidth ? { minWidth } : undefined}>
        <caption className="sr-only">{caption}</caption>
        <thead className="text-xs text-zinc-500">
          <tr>
            {columns.map((c, i) => (
              <th key={c.label} scope="col" className={`pb-2 font-medium whitespace-nowrap ${i > 0 ? "pl-3" : ""} ${align(c, i)} ${hide(c)}`}>
                {c.label}
                {c.info && (
                  <span className="ml-0.5">
                    <InfoTip label={`À propos : ${c.label}`} align={i > columns.length / 2 ? "right" : "left"}>
                      {c.info}
                    </InfoTip>
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((r) => (
            <tr key={r.key} className={r.muted ? "text-zinc-500" : ""}>
              {r.cells.map((cell, j) => (
                <td key={j} className={`py-2 align-top ${j > 0 ? "pl-3 whitespace-nowrap" : "max-w-[12rem] pr-2 sm:max-w-[18rem]"} ${align(columns[j] ?? {}, j)} ${hide(columns[j] ?? { label: "" })}`}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && (
          <tfoot className="border-t border-zinc-200 font-semibold">
            <tr>
              {footer.map((cell, j) => (
                <td key={j} className={`pt-2 ${j > 0 ? "pl-3 whitespace-nowrap" : ""} ${align(columns[j] ?? { label: "" }, j)} ${hide(columns[j] ?? { label: "" })}`}>
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

/** Row label that drills down to the Orders list (pre-filtered). */
export function DrillLink({ href, children, sub }: { href: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <Link href={href} className="group block min-w-0 rounded focus-visible:ring-2 focus-visible:ring-indigo-500" title="Voir les commandes">
      <span className="block truncate font-medium text-zinc-900 group-hover:text-indigo-700 group-hover:underline">{children}</span>
      {sub && <span className="block truncate text-xs text-zinc-500">{sub}</span>}
    </Link>
  );
}

/** Horizontal share bar next to a label (e.g. funnel). */
export function ShareBar({ value, max, color = "from-indigo-500 to-violet-500" }: { value: number; max: number; color?: string }) {
  return (
    <div className="h-2.5 overflow-hidden rounded-full bg-zinc-100" aria-hidden>
      <div className={`h-full rounded-full bg-gradient-to-r ${color}`} style={{ width: `${Math.max(value > 0 ? 2 : 0, max > 0 ? (value / max) * 100 : 0)}%` }} />
    </div>
  );
}

/**
 * Daily bars (positive up, negative down in red) with a text summary for screen readers and
 * a per-bar title for pointer users.
 */
export function DailyBars({
  title,
  points,
  format,
  summary,
  color = "bg-emerald-500",
}: {
  title: string;
  points: { day: string; value: number }[];
  format: (v: number) => string;
  summary: string;
  color?: string;
}) {
  if (!points.some((p) => p.value !== 0)) return null;
  const max = Math.max(1, ...points.map((p) => Math.abs(p.value)));
  const hasNeg = points.some((p) => p.value < 0);
  const label = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" });
  return (
    <figure className="mt-4">
      <figcaption className="mb-1.5 text-xs font-medium text-zinc-600">{title}</figcaption>
      <div className="flex h-16 gap-[2px]" role="img" aria-label={`${title}. ${summary}`}>
        {points.map((p) => {
          const h = `${Math.max(p.value === 0 ? 0 : 6, (Math.abs(p.value) / max) * 100)}%`;
          return (
            <div key={p.day} className="flex h-full min-w-0 flex-1 flex-col" title={`${label(p.day)} : ${format(p.value)}`}>
              <div className={`flex flex-col justify-end ${hasNeg ? "h-1/2" : "h-full"}`}>{p.value > 0 && <div className={`w-full rounded-t-[2px] ${color}`} style={{ height: h }} />}</div>
              {hasNeg && (
                <div className="flex h-1/2 flex-col justify-start border-t border-zinc-200">
                  {p.value < 0 && <div className="w-full rounded-b-[2px] bg-rose-400" style={{ height: h }} />}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {points.length > 1 && (
        <div className="mt-1 flex justify-between text-[11px] text-zinc-500" aria-hidden>
          <span>{label(points[0].day)}</span>
          <span>{label(points[points.length - 1].day)}</span>
        </div>
      )}
    </figure>
  );
}

export function Mini({ icon: Icon, label, value, hint }: { icon: LucideIcon; label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-zinc-50 p-3 ring-1 ring-zinc-900/5">
      <p className="flex items-start gap-1.5 text-[11px] leading-snug font-medium text-zinc-600">
        <Icon className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden /> <span>{label}</span>
      </p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}

export function SectionTitle({ icon, color, children, id }: { icon: LucideIcon; color: string; children: ReactNode; id?: string }) {
  return (
    <h2 id={id} className="mt-8 mb-3 flex items-center gap-2 text-[15px] font-semibold tracking-tight text-zinc-900">
      <IconTile icon={icon} size={28} color={color} />
      {children}
    </h2>
  );
}

/** Profit & loss line (label on the left, signed amount on the right). */
export function PnlRow({ label, value, note, strong, muted, info }: { label: ReactNode; value: string; note?: ReactNode; strong?: boolean; muted?: boolean; info?: ReactNode }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? "border-t border-zinc-100 pt-2" : ""}`}>
      <dt className={`min-w-0 ${strong ? "font-semibold" : "text-zinc-600"}`}>
        {label}
        {info && <span className="ml-1">{info}</span>}
        {note && <span className="ml-1.5 text-xs font-normal text-zinc-500">({note})</span>}
      </dt>
      <dd className={`shrink-0 tabular-nums ${strong ? "font-semibold" : ""} ${muted ? "text-zinc-500 italic" : ""}`}>{value}</dd>
    </div>
  );
}

/** Small "CSV" download link for a card (same period and filters as the page). */
export function CsvLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      download
      className="inline-flex min-h-9 items-center gap-1 rounded-lg px-2 text-sm font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-indigo-500"
      title={`Exporter ${label} (CSV Excel)`}
    >
      <Download className="h-4 w-4" aria-hidden />
      CSV<span className="sr-only"> : {label}</span>
    </a>
  );
}

const LEVEL: Record<"good" | "warn" | "bad", { icon: LucideIcon; label: string; cls: string }> = {
  good: { icon: CheckCircle2, label: "sain", cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/20" },
  warn: { icon: AlertTriangle, label: "fragile", cls: "bg-amber-50 text-amber-900 ring-amber-600/25" },
  bad: { icon: XCircle, label: "non rentable", cls: "bg-rose-50 text-rose-800 ring-rose-600/20" },
};

/** Health pill with icon + words (never color alone), e.g. LTV/CAC. */
export function LevelPill({ level, value }: { level: "good" | "warn" | "bad" | null; value: string }) {
  if (!level) return <span className="text-zinc-500">{value}</span>;
  const l = LEVEL[level];
  const Icon = l.icon;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ring-inset ${l.cls}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {value}
      <span className="font-medium">· {l.label}</span>
    </span>
  );
}

/** Computed alert banner (top of Analytics). */
export function Callout({ tone, title, children }: { tone: "warn" | "bad"; title: string; children?: ReactNode }) {
  const Icon = tone === "bad" ? XCircle : AlertTriangle;
  return (
    <div role="note" className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-sm ring-1 ring-inset ${tone === "bad" ? "bg-rose-50 text-rose-900 ring-rose-600/20" : "bg-amber-50 text-amber-900 ring-amber-600/25"}`}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>
        <strong className="font-semibold">{title}.</strong> {children}
      </span>
    </div>
  );
}

/** Small "≈ estimé" badge next to a figure built on incomplete costs. */
export function EstimatedBadge({ title = "Certains coûts sont inconnus et comptent pour 0" }: { title?: string }) {
  return (
    <span className="ml-1 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 align-middle text-[10px] font-medium text-amber-800 ring-1 ring-amber-600/20 ring-inset" title={title}>
      ≈ estimé
    </span>
  );
}

/** A duration in minutes for a KPI: "< 1 min" under a minute (never "0 min"), "4,5 min", "2,5 h", "—" when unknown. Pure. */
export function formatMinutes(m: number | null | undefined): string {
  if (m == null || !Number.isFinite(m)) return "—";
  const f = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 });
  if (m < 1) return "< 1 min";
  return m < 60 ? `${f.format(m)} min` : `${f.format(m / 60)} h`;
}

export type VerdictKey = "early" | "cut" | "keep" | "scale";

const VERDICT: Record<VerdictKey, { icon: LucideIcon; label: string; title: string; cls: string }> = {
  early: {
    icon: Hourglass,
    label: "Trop tôt",
    title: "Données insuffisantes : moins de 5 commandes et moins de 2 × la marge par commande dépensés. Attendez avant de couper ou d'augmenter le budget",
    cls: "bg-zinc-100 text-zinc-700 ring-zinc-500/20",
  },
  cut: { icon: Scissors, label: "Couper", title: "ROAS sous le seuil de rentabilité : la pub coûte plus que la marge qu'elle rapporte", cls: "bg-rose-50 text-rose-800 ring-rose-600/20" },
  keep: { icon: CheckCircle2, label: "Garder", title: "ROAS autour du seuil de rentabilité (jusqu'à 1,3 ×) : la pub se paie", cls: "bg-amber-50 text-amber-900 ring-amber-600/25" },
  scale: { icon: TrendingUp, label: "Scaler", title: "ROAS au-delà de 1,3 × le seuil de rentabilité : augmentez le budget", cls: "bg-emerald-50 text-emerald-800 ring-emerald-600/20" },
};

/**
 * Label and tooltip of a verdict. "Garder" on a campaign whose profit after ads is negative (ROAS just
 * under break-even, within the keep band) would read as "it pays": it reads "≈ à l'équilibre". Pure.
 */
export function verdictDisplay(verdict: VerdictKey, profitAfterAdsCents?: number | null): { icon: LucideIcon; label: string; title: string; cls: string } {
  const v = VERDICT[verdict];
  if (verdict === "keep" && profitAfterAdsCents != null && profitAfterAdsCents < 0)
    return { ...v, label: "≈ à l'équilibre", title: "ROAS autour du seuil de rentabilité, bénéfice après pub légèrement négatif : la pub se paie à peu près, sans rapporter. Surveillez avant d'augmenter le budget" };
  return v;
}

/**
 * Ad verdict chip (ROAS vs break-even ROAS): icon + word, never color alone. "Trop tôt" is neutral
 * (not enough data). `detail` is appended to the tooltip (e.g. the break-even thresholds).
 */
export function VerdictChip({ verdict, detail, profitAfterAdsCents }: { verdict: VerdictKey; detail?: string; profitAfterAdsCents?: number | null }) {
  const v = verdictDisplay(verdict, profitAfterAdsCents);
  const Icon = v.icon;
  const title = detail ? `${v.title}. ${detail}` : v.title;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap ring-1 ring-inset ${v.cls}`} title={title}>
      <Icon className="h-3 w-3" aria-hidden />
      {v.label}
      {verdict === "early" && <span className="sr-only"> (données insuffisantes)</span>}
    </span>
  );
}
