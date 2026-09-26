"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Block, BlockOf, BlockStyle } from "@/lib/layout";
import type { Labels } from "./i18n";

/* ------------------------------------------------------------------ */
/* Style wrapper                                                       */
/* ------------------------------------------------------------------ */

const SPACING: Record<BlockStyle["spacing"], string> = { default: "py-3", none: "py-0", sm: "py-2", md: "py-4", lg: "py-7" };
const ALIGN: Record<BlockStyle["align"], string> = { default: "", left: "text-left", center: "text-center", right: "text-right" };
const SIZE: Record<BlockStyle["textSize"], string> = { default: "", sm: "text-sm", md: "text-base", lg: "text-lg" };
const TEXT: Record<BlockStyle["textColor"], string> = {
  default: "",
  muted: "text-neutral-500",
  brand: "text-[var(--accent)]",
  white: "text-white",
};
const BG: Record<BlockStyle["background"], string> = {
  none: "",
  light: "bg-neutral-100 px-4",
  brand: "bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] px-4",
  dark: "bg-neutral-900 text-white px-4",
};
const DIVIDER: Record<BlockStyle["divider"], string> = {
  none: "",
  top: "border-t border-neutral-200",
  bottom: "border-b border-neutral-200",
  both: "border-y border-neutral-200",
};

export function StyledBlock({ style, children }: { style: BlockStyle; children: ReactNode }) {
  const css: CSSProperties = {};
  if (style.customBackground) css.background = style.customBackground;
  if (style.customText) css.color = style.customText;
  const card = style.card ? "border border-neutral-200 px-4 rounded-[var(--radius)] bg-white" : "";
  const rounded = style.background !== "none" || style.customBackground ? "rounded-[var(--radius)]" : "";
  return (
    <div
      className={[SPACING[style.spacing], ALIGN[style.align], SIZE[style.textSize], TEXT[style.textColor], BG[style.background], DIVIDER[style.divider], card, rounded]
        .filter(Boolean)
        .join(" ")}
      style={css}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Content blocks                                                      */
/* ------------------------------------------------------------------ */

export function Stars({ n, className = "" }: { n: number; className?: string }) {
  return (
    <span className={`text-amber-400 ${className}`} aria-label={`${n}/5`}>
      {"★★★★★".slice(0, Math.round(n))}
      <span className="text-neutral-300">{"★★★★★".slice(Math.round(n))}</span>
    </span>
  );
}

const WHY_ICONS: Record<BlockOf<"why_us">["props"]["rows"][number]["icon"], string> = {
  shield: "🛡️",
  star: "⭐",
  truck: "🚚",
  lock: "🔒",
  heart: "❤️",
  check: "✅",
  refresh: "🔄",
};

const PAYMENT_ICON_LABEL: Record<string, string> = {
  visa: "VISA",
  mastercard: "Mastercard",
  amex: "AMEX",
  applepay: " Pay",
  gpay: "G Pay",
  sepa: "SEPA",
  crypto: "Crypto",
};

function Faq({ items }: BlockOf<"faq">["props"]) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="divide-y divide-neutral-200 rounded-[var(--radius)] border border-neutral-200 bg-white text-left">
      {items.map((it, i) => (
        <div key={i}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left font-medium"
            onClick={() => setOpen(open === i ? null : i)}
            aria-expanded={open === i}
          >
            {it.q}
            <span className="text-xl leading-none text-neutral-400">{open === i ? "−" : "+"}</span>
          </button>
          {open === i && <p className="px-4 pb-3 text-sm whitespace-pre-line text-neutral-600">{it.a}</p>}
        </div>
      ))}
    </div>
  );
}

function Countdown({ label, endsAt, labels }: BlockOf<"countdown">["props"] & { labels: Labels }) {
  const end = Date.parse(endsAt);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    // First tick on the next frame keeps SSR and hydration output identical.
    const raf = requestAnimationFrame(() => setNow(Date.now()));
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
    };
  }, []);
  if (!endsAt || Number.isNaN(end)) {
    return <p className="text-sm text-neutral-400 italic">Minuteur : choisissez une date de fin</p>;
  }
  if (now === null) return null;
  const left = Math.max(0, end - now);
  if (left === 0) return null; // offer over: hide, never restart
  const s = Math.floor(left / 1000);
  const parts = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60];
  const text = (parts[0] ? `${parts[0]}j ` : "") + parts.slice(1).map((p) => String(p).padStart(2, "0")).join(":");
  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius)] bg-red-50 px-4 py-3 text-red-700">
      <span className="text-sm font-medium">{label}</span>
      <span className="font-mono text-base font-semibold tabular-nums" aria-label={labels.endsIn}>
        {text}
      </span>
    </div>
  );
}

function LowStock({ message, threshold, lowest }: BlockOf<"low_stock">["props"] & { lowest: number | null }) {
  if (lowest == null) return <p className="text-sm text-neutral-400 italic">Stock bas : s&apos;affiche quand le stock réel est ≤ {threshold}</p>;
  if (lowest > threshold || lowest <= 0) return null;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-orange-700">🔥 {message.replace("{n}", String(lowest))}</p>
      <div className="h-1.5 overflow-hidden rounded-full bg-orange-100">
        <div className="h-full bg-orange-500" style={{ width: `${Math.max(8, (lowest / threshold) * 100)}%` }} />
      </div>
    </div>
  );
}

export type ContentContext = {
  labels: Labels;
  /** lowest tracked inventory among cart items (null in the builder without data) */
  lowestInventory: number | null;
  preview: boolean;
};

/** Renders every non-interactive block. Returns null for fixed sections / add-ons. */
export function ContentBlock({ block, ctx }: { block: Block; ctx: ContentContext }) {
  switch (block.type) {
    case "text":
      return (
        <div className="space-y-1">
          {block.props.heading && <h3 className="text-base font-semibold">{block.props.heading}</h3>}
          {block.props.body && <p className="whitespace-pre-line opacity-80">{block.props.body}</p>}
        </div>
      );
    case "image": {
      if (!block.props.url) return ctx.preview ? <Placeholder>Bloc image — ajoutez une URL</Placeholder> : null;
      const width = { sm: "max-w-[160px]", md: "max-w-[280px]", lg: "max-w-[420px]", full: "w-full" }[block.props.size];
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={block.props.url} alt={block.props.alt} className={`${width} mx-auto rounded-[var(--radius)]`} />
      );
    }
    case "testimonial":
      return (
        <figure className="flex gap-3 text-left">
          {block.props.photoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={block.props.photoUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
          )}
          <div className="space-y-1">
            <Stars n={block.props.stars} />
            <blockquote className="text-sm">“{block.props.quote}”</blockquote>
            <figcaption className="text-xs font-medium opacity-60">{block.props.author}</figcaption>
          </div>
        </figure>
      );
    case "rating":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Stars n={block.props.score} className="text-lg" />
          <span className="font-semibold">{block.props.score.toFixed(1)}/5</span>
          <span className="text-sm opacity-70">
            {block.props.count > 0 && `${block.props.count.toLocaleString("fr-FR")} · `}
            {block.props.label}
          </span>
        </div>
      );
    case "trust_badges":
      return (
        <ul className="flex flex-wrap justify-center gap-x-5 gap-y-2 text-sm">
          {block.props.badges.map((b, i) => (
            <li key={i} className="flex items-center gap-1.5">
              {b.iconUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={b.iconUrl} alt="" className="h-5 w-5 object-contain" />
              ) : (
                <span className="text-[var(--accent)]">✓</span>
              )}
              {b.label}
            </li>
          ))}
        </ul>
      );
    case "guarantee":
      return (
        <div className="flex gap-3 text-left">
          <span className="text-2xl">🛡️</span>
          <div>
            <p className="font-semibold">{block.props.title}</p>
            <p className="text-sm opacity-80">{block.props.text}</p>
          </div>
        </div>
      );
    case "faq":
      return <Faq {...block.props} />;
    case "value_props":
      return (
        <ul className="grid grid-cols-3 gap-2 text-center text-xs">
          {block.props.items.map((it, i) => (
            <li key={i} className="flex flex-col items-center gap-1">
              <span className="text-xl">{it.icon}</span>
              {it.label}
            </li>
          ))}
        </ul>
      );
    case "payment_icons":
      return (
        <div className="space-y-2">
          {block.props.label && <p className="text-xs opacity-70">{block.props.label}</p>}
          <div className="flex flex-wrap justify-center gap-1.5">
            {block.props.methods.map((m) => (
              <span key={m} className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-[11px] font-bold text-neutral-700">
                {PAYMENT_ICON_LABEL[m]}
              </span>
            ))}
          </div>
        </div>
      );
    case "announcement":
      return (
        <div className="rounded-[var(--radius)] bg-[var(--accent)] px-4 py-2.5 text-center text-sm font-medium text-[var(--accent-fg)]">
          {block.props.text}
        </div>
      );
    case "countdown":
      return <Countdown {...block.props} labels={ctx.labels} />;
    case "low_stock":
      return <LowStock {...block.props} lowest={ctx.lowestInventory} />;
    case "why_us":
      return (
        <div className="space-y-3 text-left">
          {block.props.title && <p className="font-semibold">{block.props.title}</p>}
          {block.props.rows.map((r, i) => (
            <div key={i} className="flex gap-3">
              <span className="text-lg">{WHY_ICONS[r.icon]}</span>
              <div>
                <p className="text-sm font-medium">{r.title}</p>
                <p className="text-sm opacity-70">{r.text}</p>
              </div>
            </div>
          ))}
        </div>
      );
    default:
      return null;
  }
}

export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius)] border-2 border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-400">
      {children}
    </div>
  );
}
