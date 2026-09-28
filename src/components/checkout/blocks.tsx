"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  BadgeCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Flame,
  Home,
  Mail,
  MessageCircle,
  Minus,
  Package,
  Phone,
  Plus,
  ShieldCheck,
  Star,
  Timer,
  Truck,
  X,
} from "lucide-react";
import type { Block, BlockOf, BlockStyle } from "@/lib/layout";
import { BlockIcon, ICONS, IconTile } from "@/components/icons";
import type { Labels } from "./i18n";

/* ------------------------------------------------------------------ */
/* Style wrapper                                                       */
/* ------------------------------------------------------------------ */

const SPACING: Record<BlockStyle["spacing"], string> = { default: "py-3", none: "py-0", sm: "py-2", md: "py-4", lg: "py-7" };
const ALIGN: Record<BlockStyle["align"], string> = { default: "", left: "text-left", center: "text-center", right: "text-right" };
const SIZE: Record<BlockStyle["textSize"], string> = { default: "", sm: "text-sm", md: "text-base", lg: "text-lg" };
const TEXT: Record<BlockStyle["textColor"], string> = {
  default: "",
  muted: "text-[var(--muted)]",
  brand: "text-[var(--accent)]",
  white: "text-white",
};
const BG: Record<BlockStyle["background"], string> = {
  none: "",
  light: "bg-black/[.035] px-4",
  brand: "bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] px-4",
  dark: "bg-neutral-900 text-white px-4",
};
const DIVIDER: Record<BlockStyle["divider"], string> = {
  none: "",
  top: "border-t border-[var(--border)]",
  bottom: "border-b border-[var(--border)]",
  both: "border-y border-[var(--border)]",
};

export function StyledBlock({ style, children }: { style: BlockStyle; children: ReactNode }) {
  const css: CSSProperties = {};
  if (style.customBackground) css.background = style.customBackground;
  if (style.customText) css.color = style.customText;
  const card = style.card ? "border border-[var(--border)] px-4 rounded-[var(--radius)] bg-white shadow-[0_1px_2px_rgba(15,23,42,.04)]" : "";
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
/* Small shared pieces                                                 */
/* ------------------------------------------------------------------ */

export function Stars({ n, size = 14, className = "" }: { n: number; size?: number; className?: string }) {
  const full = Math.round(n);
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`} role="img" aria-label={`${n}/5`}>
      {[0, 1, 2, 3, 4].map((i) => (
        <Star key={i} style={{ width: size, height: size }} className={i < full ? "fill-amber-400 text-amber-400" : "fill-neutral-200 text-neutral-200"} />
      ))}
    </span>
  );
}

function Heading({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="mb-3 font-[family-name:var(--heading-font)] text-base font-semibold tracking-tight">{children}</p>;
}

const PAYMENT_ICON_LABEL: Record<string, string> = {
  visa: "VISA",
  mastercard: "Mastercard",
  amex: "AMEX",
  applepay: "Apple Pay",
  gpay: "Google Pay",
  sepa: "SEPA",
  crypto: "Crypto",
};

function addDays(from: Date, days: number, businessOnly: boolean) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (!businessOnly || (wd !== 0 && wd !== 6)) left -= 1;
  }
  return d;
}

/** Client-only "now" (null during SSR) to keep hydration stable. */
function useNow(intervalMs: number | null = null) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setNow(Date.now()));
    const t = intervalMs ? setInterval(() => setNow(Date.now()), intervalMs) : null;
    return () => {
      cancelAnimationFrame(raf);
      if (t) clearInterval(t);
    };
  }, [intervalMs]);
  return now;
}

/* ------------------------------------------------------------------ */
/* Interactive blocks                                                  */
/* ------------------------------------------------------------------ */

function Faq({ items }: BlockOf<"faq">["props"]) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-white text-left">
      {items.map((it, i) => (
        <div key={i}>
          <button
            type="button"
            className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left font-medium transition hover:bg-black/[.02]"
            onClick={() => setOpen(open === i ? null : i)}
            aria-expanded={open === i}
          >
            {it.q}
            {open === i ? <Minus className="h-4 w-4 shrink-0 text-[var(--muted)]" /> : <Plus className="h-4 w-4 shrink-0 text-[var(--muted)]" />}
          </button>
          {open === i && <p className="px-4 pb-4 text-sm whitespace-pre-line text-[var(--muted)]">{it.a}</p>}
        </div>
      ))}
    </div>
  );
}

function Countdown({ label, endsAt, labels, preview }: BlockOf<"countdown">["props"] & { labels: Labels; preview: boolean }) {
  const end = Date.parse(endsAt);
  const now = useNow(1000);
  if (!endsAt || Number.isNaN(end)) {
    return preview ? <Placeholder>Minuteur : choisissez une date de fin</Placeholder> : null;
  }
  if (now === null) return null;
  const left = Math.max(0, end - now);
  if (left === 0) return null; // offer over: hide, never restart
  const s = Math.floor(left / 1000);
  const parts = [Math.floor(s / 86400), Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60];
  const text = (parts[0] ? `${parts[0]}j ` : "") + parts.slice(1).map((p) => String(p).padStart(2, "0")).join(":");
  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius)] border border-red-200/70 bg-gradient-to-r from-red-50 to-orange-50 px-4 py-3 text-red-700">
      <span className="flex items-center gap-2 text-sm font-medium">
        <Timer className="h-4 w-4" /> {label}
      </span>
      <span className="font-mono text-base font-semibold tabular-nums" aria-label={labels.endsIn}>
        {text}
      </span>
    </div>
  );
}

function LowStock({ message, threshold, lowest, preview }: BlockOf<"low_stock">["props"] & { lowest: number | null; preview: boolean }) {
  if (lowest == null) return preview ? <Placeholder>Stock bas : s&apos;affiche quand le stock réel est ≤ {threshold}</Placeholder> : null;
  if (lowest > threshold || lowest <= 0) return null;
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 text-sm font-medium text-orange-700">
        <Flame className="h-4 w-4" /> {message.replace("{n}", String(lowest))}
      </p>
      <div className="h-1.5 overflow-hidden rounded-full bg-orange-100">
        <div className="h-full rounded-full bg-gradient-to-r from-orange-400 to-red-500" style={{ width: `${Math.max(8, (lowest / threshold) * 100)}%` }} />
      </div>
    </div>
  );
}

function FreeShippingBar({ message, success, threshold, ctx }: BlockOf<"free_shipping_bar">["props"] & { ctx: ContentContext }) {
  const target = threshold > 0 ? Math.round(threshold * 100) : ctx.freeShippingThresholdCents;
  if (!target) {
    return ctx.preview ? <Placeholder>Barre de livraison offerte : définissez un seuil « Offert dès » dans Livraison</Placeholder> : null;
  }
  const left = Math.max(0, target - ctx.subtotalCents);
  const pct = Math.min(100, Math.round((ctx.subtotalCents / target) * 100));
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white p-4">
      <p className="mb-2.5 flex items-center gap-2 text-sm font-medium">
        <Truck className="h-4 w-4 text-[var(--accent)]" />
        {left === 0 ? success : message.replace("{amount}", ctx.money(left))}
      </p>
      <div className="h-2 overflow-hidden rounded-full bg-black/[.06]">
        <div className="h-full rounded-full bg-[image:var(--accent-bg)] transition-[width] duration-500" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function DeliveryEstimate({ label, minDays, maxDays, businessDays, showTimeline, ctx }: BlockOf<"delivery_estimate">["props"] & { ctx: ContentContext }) {
  const now = useNow();
  if (now === null) return <div className="h-16" />;
  const today = new Date(now);
  const fmt = (d: Date) => d.toLocaleDateString(ctx.lang === "fr" ? "fr-FR" : "en-US", { weekday: "short", day: "numeric", month: "short" });
  const shipped = addDays(today, Math.min(1, minDays), businessDays);
  const from = addDays(today, minDays, businessDays);
  const to = addDays(today, Math.max(minDays, maxDays), businessDays);
  const steps = [
    { icon: Check, title: ctx.lang === "fr" ? "Commande" : "Ordered", date: fmt(today) },
    { icon: Package, title: ctx.lang === "fr" ? "Expédition" : "Shipped", date: fmt(shipped) },
    { icon: Home, title: ctx.lang === "fr" ? "Livraison" : "Delivered", date: `${fmt(from)} – ${fmt(to)}` },
  ];
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white p-4">
      <p className="flex items-center gap-2 text-sm">
        <Truck className="h-4 w-4 text-[var(--accent)]" />
        <span className="text-[var(--muted)]">{label} :</span>
        <strong className="font-semibold">
          {fmt(from)} – {fmt(to)}
        </strong>
      </p>
      {showTimeline && (
        <ol className="mt-4 grid grid-cols-3">
          {steps.map((s, i) => (
            <li key={i} className="relative flex flex-col items-center text-center">
              {i > 0 && <span className="absolute top-4 right-1/2 -z-0 h-0.5 w-full bg-[color-mix(in_srgb,var(--accent)_25%,transparent)]" />}
              <span className="relative z-10 flex h-8 w-8 items-center justify-center rounded-full bg-[image:var(--accent-bg)] text-[var(--accent-fg)] shadow-md">
                <s.icon className="h-4 w-4" />
              </span>
              <span className="mt-2 text-xs font-semibold">{s.title}</span>
              <span className="text-[11px] text-[var(--muted)]">{s.date}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Reviews({ title, layout, items }: BlockOf<"reviews">["props"]) {
  const [i, setI] = useState(0);
  if (items.length === 0) return null;
  const review = (r: (typeof items)[number], key?: number) => (
    <figure key={key} className="rounded-[var(--radius)] border border-[var(--border)] bg-white p-4 text-left shadow-[0_1px_2px_rgba(15,23,42,.04)]">
      <div className="flex items-center justify-between">
        <Stars n={r.stars} />
        {r.verified && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700">
            <BadgeCheck className="h-3.5 w-3.5" /> Achat vérifié
          </span>
        )}
      </div>
      <blockquote className="mt-2 text-sm leading-relaxed">« {r.text} »</blockquote>
      <figcaption className="mt-2 text-xs font-semibold text-[var(--muted)]">{r.name}</figcaption>
    </figure>
  );
  return (
    <div>
      <Heading>{title}</Heading>
      {layout === "stack" ? (
        <div className="space-y-2.5">{items.map((r, k) => review(r, k))}</div>
      ) : (
        <div className="relative">
          {review(items[i % items.length])}
          {items.length > 1 && (
            <div className="mt-2.5 flex items-center justify-between">
              <div className="flex gap-1.5">
                {items.map((_, k) => (
                  <button
                    key={k}
                    type="button"
                    aria-label={`Avis ${k + 1}`}
                    onClick={() => setI(k)}
                    className={`h-1.5 rounded-full transition-all ${k === i % items.length ? "w-5 bg-[var(--accent)]" : "w-1.5 bg-black/15"}`}
                  />
                ))}
              </div>
              <div className="flex gap-1">
                <button type="button" aria-label="Avis précédent" onClick={() => setI((i - 1 + items.length) % items.length)} className="rounded-full border border-[var(--border)] bg-white p-1.5 hover:bg-black/[.03]">
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>
                <button type="button" aria-label="Avis suivant" onClick={() => setI((i + 1) % items.length)} className="rounded-full border border-[var(--border)] bg-white p-1.5 hover:bg-black/[.03]">
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Coupon({ title, text, code }: BlockOf<"coupon">["props"]) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative overflow-hidden rounded-[var(--radius)] bg-[image:var(--accent-bg)] p-5 text-[var(--accent-fg)] shadow-lg">
      <div className="pointer-events-none absolute -top-10 -right-10 h-32 w-32 rounded-full bg-white/10" />
      <p className="text-base font-semibold">{title}</p>
      {text && <p className="mt-1 text-sm opacity-90">{text}</p>}
      {code && (
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="mt-4 inline-flex items-center gap-2 rounded-lg border-2 border-dashed border-current/40 bg-white/15 px-4 py-2 font-mono text-sm font-bold tracking-wider backdrop-blur"
        >
          {code}
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </button>
      )}
    </div>
  );
}

function OrderNote({ title, placeholder, ctx }: BlockOf<"order_note">["props"] & { ctx: ContentContext }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{title}</span>
      <textarea
        rows={3}
        maxLength={1000}
        value={ctx.note}
        onChange={(e) => ctx.setNote(e.target.value)}
        placeholder={placeholder}
        className="w-full resize-y rounded-[var(--radius)] border border-[var(--border)] bg-white px-3.5 py-3 text-[15px] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)]"
      />
    </label>
  );
}

function videoEmbed(url: string): { kind: "iframe" | "video"; src: string } | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    if (host === "youtube.com" || host === "m.youtube.com") {
      const id = u.searchParams.get("v") ?? u.pathname.split("/shorts/")[1];
      return id ? { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` } : null;
    }
    if (host === "youtu.be") return { kind: "iframe", src: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(u.pathname.slice(1))}` };
    if (host === "vimeo.com") return { kind: "iframe", src: `https://player.vimeo.com/video/${encodeURIComponent(u.pathname.split("/").filter(Boolean)[0] ?? "")}` };
    if (/\.(mp4|webm|mov)$/i.test(u.pathname)) return { kind: "video", src: url };
  } catch {
    /* invalid */
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

export type ContentContext = {
  labels: Labels;
  lang: "fr" | "en";
  /** lowest tracked inventory among cart items (null in the builder without data) */
  lowestInventory: number | null;
  preview: boolean;
  subtotalCents: number;
  freeShippingThresholdCents: number | null;
  money: (cents: number) => string;
  note: string;
  setNote: (v: string) => void;
  /** Thank-you page, live: one-click post-purchase offers. */
  upsell?: { sessionId: string; eligible: boolean; states: Record<string, string> };
};

/** Renders every non-section block. Returns null for fixed sections / add-ons. */
/**
 * True when a block has nothing to show buyers, so the page can skip its wrapper
 * (card background, padding) instead of drawing an empty box. The builder preview
 * always renders blocks so the merchant sees placeholders.
 */
export function isEmptyInLive(block: Block, ctx: ContentContext, now: number): boolean {
  if (ctx.preview) return false;
  switch (block.type) {
    case "image":
      return !block.props.url;
    case "video":
      return !block.props.url || !videoEmbed(block.props.url);
    case "logos":
      return block.props.logos.length === 0;
    case "countdown": {
      const end = Date.parse(block.props.endsAt);
      return !block.props.endsAt || Number.isNaN(end) || end <= now;
    }
    case "low_stock":
      return ctx.lowestInventory == null || ctx.lowestInventory <= 0 || ctx.lowestInventory > block.props.threshold;
    case "free_shipping_bar":
      return !(block.props.threshold > 0 || ctx.freeShippingThresholdCents);
    case "upsell": {
      const state = ctx.upsell?.states[block.id];
      return !block.props.variantId || !(ctx.upsell?.eligible || state === "PAID") || state === "DECLINED";
    }
    default:
      return false;
  }
}

export function ContentBlock({ block, ctx }: { block: Block; ctx: ContentContext }) {
  switch (block.type) {
    case "text":
      return (
        <div className="space-y-1">
          {block.props.heading && <h3 className="font-[family-name:var(--heading-font)] text-base font-semibold tracking-tight">{block.props.heading}</h3>}
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
            <img src={block.props.photoUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover ring-2 ring-white" />
          )}
          <div className="space-y-1">
            <Stars n={block.props.stars} />
            <blockquote className="text-sm">« {block.props.quote} »</blockquote>
            <figcaption className="text-xs font-semibold opacity-60">{block.props.author}</figcaption>
          </div>
        </figure>
      );
    case "rating":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Stars n={block.props.score} size={18} />
          <span className="font-semibold">{block.props.score.toFixed(1)}/5</span>
          <span className="text-sm opacity-70">
            {block.props.count > 0 && `${block.props.count.toLocaleString("fr-FR")} avis · `}
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
                <Check className="h-4 w-4 text-[var(--accent)]" strokeWidth={2.5} />
              )}
              {b.label}
            </li>
          ))}
        </ul>
      );
    case "guarantee":
      return (
        <div className="flex items-start gap-3.5 text-left">
          <IconTile icon={ShieldCheck} size={44} />
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
            <li key={i} className="flex flex-col items-center gap-1.5">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_10%,white)] text-[var(--accent)]">
                <BlockIcon value={it.icon} size={17} />
              </span>
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
              <span key={m} className="rounded-md border border-[var(--border)] bg-white px-2 py-1 text-[11px] font-bold text-neutral-700 shadow-[0_1px_1px_rgba(0,0,0,.04)]">
                {PAYMENT_ICON_LABEL[m]}
              </span>
            ))}
          </div>
        </div>
      );
    case "announcement":
      return (
        <div className="rounded-[var(--radius)] bg-[image:var(--accent-bg)] px-4 py-2.5 text-center text-sm font-medium text-[var(--accent-fg)] shadow-sm">
          {block.props.text}
        </div>
      );
    case "countdown":
      return <Countdown {...block.props} labels={ctx.labels} preview={ctx.preview} />;
    case "low_stock":
      return <LowStock {...block.props} lowest={ctx.lowestInventory} preview={ctx.preview} />;
    case "why_us":
      return (
        <div className="space-y-3 text-left">
          <Heading>{block.props.title}</Heading>
          {block.props.rows.map((r, i) => (
            <div key={i} className="flex items-start gap-3">
              <IconTile icon={ICONS[r.icon]} size={36} />
              <div>
                <p className="text-sm font-semibold">{r.title}</p>
                <p className="text-sm opacity-70">{r.text}</p>
              </div>
            </div>
          ))}
        </div>
      );
    case "free_shipping_bar":
      return <FreeShippingBar {...block.props} ctx={ctx} />;
    case "delivery_estimate":
      return <DeliveryEstimate {...block.props} ctx={ctx} />;
    case "reviews":
      return <Reviews {...block.props} />;
    case "comparison":
      return (
        <div>
          <Heading>{block.props.title}</Heading>
          <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-white text-sm">
            <div className="grid grid-cols-[1fr_72px_72px] border-b border-[var(--border)] bg-black/[.02] text-xs font-semibold">
              <span className="px-3 py-2.5" />
              <span className="bg-[color-mix(in_srgb,var(--accent)_10%,white)] px-2 py-2.5 text-center text-[var(--accent)]">{block.props.usLabel}</span>
              <span className="px-2 py-2.5 text-center text-[var(--muted)]">{block.props.themLabel}</span>
            </div>
            {block.props.rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_72px_72px] border-b border-[var(--border)] last:border-0">
                <span className="px-3 py-2.5">{r.label}</span>
                <span className="flex items-center justify-center bg-[color-mix(in_srgb,var(--accent)_5%,white)]">
                  {r.us ? <Check className="h-4 w-4 text-emerald-600" strokeWidth={3} /> : <X className="h-4 w-4 text-neutral-300" />}
                </span>
                <span className="flex items-center justify-center">
                  {r.them ? <Check className="h-4 w-4 text-neutral-400" strokeWidth={3} /> : <X className="h-4 w-4 text-red-400" />}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    case "video": {
      const embed = block.props.url ? videoEmbed(block.props.url) : null;
      if (!embed) return ctx.preview ? <Placeholder>Vidéo : collez un lien YouTube, Vimeo ou .mp4</Placeholder> : null;
      return (
        <figure>
          <div className="aspect-video overflow-hidden rounded-[var(--radius)] bg-black shadow-sm">
            {embed.kind === "iframe" ? (
              <iframe
                src={embed.src}
                title={block.props.caption || "Vidéo"}
                className="h-full w-full"
                allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                loading="lazy"
              />
            ) : (
              <video src={embed.src} className="h-full w-full object-cover" controls playsInline preload="metadata" />
            )}
          </div>
          {block.props.caption && <figcaption className="mt-2 text-center text-xs text-[var(--muted)]">{block.props.caption}</figcaption>}
        </figure>
      );
    }
    case "logos":
      if (block.props.logos.length === 0) return ctx.preview ? <Placeholder>Logos presse : ajoutez des images</Placeholder> : null;
      return (
        <div className="text-center">
          {block.props.title && <p className="mb-3 text-[11px] font-semibold tracking-[.14em] text-[var(--muted)] uppercase">{block.props.title}</p>}
          <div className="flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
            {block.props.logos.map((l, i) =>
              l.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={l.imageUrl} alt={l.alt} className="h-6 w-auto object-contain opacity-60 grayscale" />
              ) : null,
            )}
          </div>
        </div>
      );
    case "stats":
      return (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, block.props.items.length)}, minmax(0, 1fr))` }}>
          {block.props.items.map((s, i) => (
            <div key={i} className="rounded-[var(--radius)] border border-[var(--border)] bg-white px-2 py-3 text-center">
              <p className="bg-[image:var(--accent-bg)] bg-clip-text font-[family-name:var(--heading-font)] text-xl font-bold tracking-tight text-transparent">{s.value}</p>
              <p className="text-[11px] text-[var(--muted)]">{s.label}</p>
            </div>
          ))}
        </div>
      );
    case "benefits":
      return (
        <div>
          <Heading>{block.props.title}</Heading>
          <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${block.props.columns}, minmax(0, 1fr))` }}>
            {block.props.items.map((it, i) => (
              <div key={i} className="flex flex-col items-center gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-white p-3 text-center shadow-[0_1px_2px_rgba(15,23,42,.04)]">
                <IconTile icon={ICONS[it.icon]} size={40} />
                <p className="text-xs font-semibold">{it.title}</p>
                {it.text && <p className="text-[11px] leading-snug text-[var(--muted)]">{it.text}</p>}
              </div>
            ))}
          </div>
        </div>
      );
    case "secure_badge":
      return (
        <div className="flex items-center gap-3 rounded-[var(--radius)] border border-emerald-200/80 bg-gradient-to-br from-emerald-50 to-white p-3.5">
          <IconTile icon={ShieldCheck} size={38} color="#059669" />
          <div>
            <p className="text-sm font-semibold text-emerald-900">{block.props.text}</p>
            {block.props.subtext && <p className="text-xs text-emerald-800/80">{block.props.subtext}</p>}
          </div>
        </div>
      );
    case "order_note":
      return <OrderNote {...block.props} ctx={ctx} />;
    case "support": {
      const p = block.props;
      const wa = p.whatsapp.replace(/[^\d]/g, "");
      return (
        <div className="rounded-[var(--radius)] border border-[var(--border)] bg-white p-4">
          <Heading>{p.title}</Heading>
          {p.text && <p className="-mt-2 mb-3 text-sm text-[var(--muted)]">{p.text}</p>}
          <div className="flex flex-wrap gap-2 text-sm">
            {p.email && (
              <a href={`mailto:${p.email}`} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 hover:bg-black/[.03]">
                <Mail className="h-3.5 w-3.5" /> {p.email}
              </a>
            )}
            {p.phone && (
              <a href={`tel:${p.phone.replace(/\s/g, "")}`} className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] px-3 py-1.5 hover:bg-black/[.03]">
                <Phone className="h-3.5 w-3.5" /> {p.phone}
              </a>
            )}
            {wa && (
              <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 rounded-full bg-[#25D366] px-3 py-1.5 font-medium text-white">
                <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
              </a>
            )}
            {!p.email && !p.phone && !wa && ctx.preview && <span className="text-xs text-neutral-400 italic">Ajoutez un e-mail, un téléphone ou WhatsApp</span>}
          </div>
        </div>
      );
    }
    case "spacer":
      return (
        <div style={{ height: block.props.size }} className="flex items-center" aria-hidden>
          {block.props.line && <span className="h-px w-full bg-[var(--border)]" />}
        </div>
      );
    case "button_link":
      if (!block.props.url) return ctx.preview ? <Placeholder>Bouton : ajoutez un lien</Placeholder> : null;
      return (
        <a
          href={block.props.url}
          className={`flex w-full items-center justify-center rounded-[var(--btn-radius)] px-5 py-3.5 text-sm font-semibold transition hover:opacity-90 ${
            block.props.variant === "solid" ? "bg-[image:var(--accent-bg)] text-[var(--accent-fg)] shadow-sm" : "border-2 border-[var(--accent)] text-[var(--accent)]"
          }`}
        >
          {block.props.label}
        </a>
      );
    case "coupon":
      return <Coupon {...block.props} />;
    case "upsell":
      return <UpsellOffer block={block} ctx={ctx} />;
    case "social": {
      const links = [
        { url: block.props.instagram, icon: InstagramIcon, label: "Instagram" },
        { url: block.props.tiktok, icon: TikTokIcon, label: "TikTok" },
        { url: block.props.facebook, icon: FacebookIcon, label: "Facebook" },
        { url: block.props.youtube, icon: YoutubeIcon, label: "YouTube" },
      ].filter((l) => l.url);
      if (links.length === 0) return ctx.preview ? <Placeholder>Réseaux sociaux : ajoutez vos liens</Placeholder> : null;
      return (
        <div className="text-center">
          <Heading>{block.props.title}</Heading>
          <div className="flex justify-center gap-2.5">
            {links.map((l) => (
              <a
                key={l.label}
                href={l.url}
                target="_blank"
                rel="noreferrer"
                aria-label={l.label}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border)] bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <l.icon className="h-5 w-5" />
              </a>
            ))}
          </div>
        </div>
      );
    }
    default:
      return null;
  }
}

function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function FacebookIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M13.5 21v-7.5H16l.5-3h-3V8.6c0-.9.3-1.6 1.6-1.6h1.6V4.3c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.4-4 4.1v2.2H7.7v3h2.6V21h3.2z" />
    </svg>
  );
}

function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M21.6 7.2a2.5 2.5 0 0 0-1.8-1.8C18.2 5 12 5 12 5s-6.2 0-7.8.4A2.5 2.5 0 0 0 2.4 7.2 26 26 0 0 0 2 12a26 26 0 0 0 .4 4.8 2.5 2.5 0 0 0 1.8 1.8c1.6.4 7.8.4 7.8.4s6.2 0 7.8-.4a2.5 2.5 0 0 0 1.8-1.8A26 26 0 0 0 22 12a26 26 0 0 0-.4-4.8zM10 15V9l5.2 3L10 15z" />
    </svg>
  );
}

function TikTokIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden>
      <path d="M16.6 5.82A4.28 4.28 0 0 1 15.54 3h-3.09v12.4a2.59 2.59 0 0 1-2.59 2.5c-1.42 0-2.6-1.16-2.6-2.6 0-1.72 1.66-3.01 3.37-2.48V9.66c-3.45-.46-6.47 2.22-6.47 5.64 0 3.33 2.76 5.7 5.69 5.7 3.14 0 5.69-2.55 5.69-5.7V9.01a7.35 7.35 0 0 0 4.3 1.38V7.3s-1.88.09-3.24-1.48z" />
    </svg>
  );
}

export function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[var(--radius)] border-2 border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-400">{children}</div>
  );
}

/** One-click post-purchase offer (thank-you page). */
function UpsellOffer({ block, ctx }: { block: BlockOf<"upsell">; ctx: ContentContext }) {
  const p = block.props;
  const [state, setState] = useState<string | null>(ctx.upsell?.states[block.id] ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const L = ctx.labels;
  const price = ctx.money(Math.round(p.price * 100));
  const compare = p.compareAt > p.price ? ctx.money(Math.round(p.compareAt * 100)) : null;
  const live = !!ctx.upsell && !ctx.preview;
  const viewSession = live && state == null ? ctx.upsell?.sessionId : undefined;
  useEffect(() => {
    // Impression, for the acceptance rate in Analytics (once per session, server-side).
    if (viewSession) void fetch(`/api/public/sessions/${viewSession}/upsell`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: true }) }).catch(() => undefined);
  }, [viewSession]);

  async function answer(accept: boolean) {
    if (!live || !ctx.upsell) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/public/sessions/${ctx.upsell.sessionId}/upsell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blockId: block.id, accept }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Erreur");
      if (body.status === "action" && body.url) {
        window.location.href = body.url; // 3-D Secure confirmation, back to this page after
        return;
      }
      setState(body.status === "paid" ? "PAID" : body.status === "declined" ? "DECLINED" : "PENDING");
      if (body.status === "paid") setMessage(L.upsellAdded(body.orderName ?? ""));
      if (body.status === "pending") setMessage(L.upsellAddedPending);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setBusy(false);
    }
  }

  if (state === "DECLINED") return null;
  if (state === "PAID" || state === "PENDING") {
    return (
      <div className="flex items-center gap-3 rounded-[var(--radius)] border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800">
        <Check className="h-5 w-5 shrink-0" strokeWidth={2.5} />
        {message ?? (state === "PAID" ? L.upsellAdded("") : L.upsellAddedPending)}
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-[var(--radius)] border-2 border-[var(--accent)] bg-white shadow-[0_12px_32px_-16px_rgba(0,0,0,.25)]">
      {p.badge && <p className="bg-[image:var(--accent-bg)] px-4 py-2 text-center text-xs font-semibold tracking-wide text-[var(--accent-fg)] uppercase">{p.badge}</p>}
      <div className="flex gap-4 p-4">
        {p.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.imageUrl} alt="" className="h-24 w-24 shrink-0 rounded-[calc(var(--radius)*0.8)] object-cover" />
        ) : ctx.preview ? (
          <div className="h-24 w-24 shrink-0 rounded-[calc(var(--radius)*0.8)] bg-neutral-100" />
        ) : null}
        <div className="min-w-0 flex-1">
          <h3 className="font-[family-name:var(--heading-font)] text-base font-semibold">{p.title}</h3>
          <p className="mt-1 text-sm text-[var(--muted)]">{p.text}</p>
          <p className="mt-2 flex items-baseline gap-2">
            <span className="text-lg font-semibold">{price}</span>
            {compare && <span className="text-sm text-neutral-400 line-through">{compare}</span>}
          </p>
        </div>
      </div>
      <div className="space-y-2 px-4 pb-4">
        <button
          type="button"
          disabled={busy}
          onClick={() => answer(true)}
          className="flex w-full items-center justify-center gap-2 rounded-[var(--btn-radius)] bg-[image:var(--accent-bg)] px-5 py-3.5 font-semibold text-[var(--accent-fg)] shadow-[var(--btn-shadow)] transition hover:brightness-110 disabled:opacity-60"
        >
          {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />}
          {p.buttonText} · {price}
        </button>
        <button type="button" disabled={busy} onClick={() => answer(false)} className="w-full py-1.5 text-sm text-[var(--muted)] underline underline-offset-2">
          {p.declineText}
        </button>
        <p className="text-center text-[11px] text-neutral-400">{L.upsellNoCard}</p>
        {error && (
          <p role="alert" className="text-center text-xs text-red-600">
            {error}
          </p>
        )}
        {ctx.preview && !p.variantId && <Placeholder>Offre post-achat : renseignez l&apos;ID de variante Shopify</Placeholder>}
      </div>
    </div>
  );
}
