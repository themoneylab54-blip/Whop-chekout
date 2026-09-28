"use client";

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
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
import {
  armKey,
  downsellTargets,
  offerArmProps,
  offerTrail,
  offerUnitCents,
  variantGidOf,
  MAX_OFFER_QUANTITY,
  SURVEY_OTHER_MAX,
  type Block,
  type BlockOf,
  type BlockStyle,
  type OfferArm,
  formatRatingScore,
  ratingIsSet,
  type ReviewItem,
  type ReviewSummary,
} from "@/lib/layout";
import { importedReviewsOrigin, orderReviewsForCart, type CartProducts } from "@/lib/reviews-import";
import { BlockIcon, ICONS, IconTile } from "@/components/icons";
import { honestReviewItems, isSampleOnly, isSampleReview, liveReviewItems, liveStatItems, liveTextProps } from "@/lib/sample-content";
import { errorText, localeOf, type Labels, type Lang, type ReviewsNoteSummary } from "./i18n";
import { SafeImg } from "./SafeImg";
import type { CartLine } from "@/lib/pricing";

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
  // "wc-boxed": a card / colored box goes edge to edge on phones with the banner it holds (globals.css).
  const boxed = card || rounded ? "wc-boxed" : "";
  return (
    <div
      className={[SPACING[style.spacing], ALIGN[style.align], SIZE[style.textSize], TEXT[style.textColor], BG[style.background], DIVIDER[style.divider], card, rounded, boxed]
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

/** Stars drawn for a score: floored to the half star below (4.8 → 4½, 4.4 → 4), never rounded up. */
export function starFill(n: number): { full: number; half: boolean } {
  const v = Number.isFinite(n) ? Math.max(0, Math.min(5, Math.floor(n * 2 + 1e-9) / 2)) : 0;
  const full = Math.floor(v);
  return { full, half: v - full === 0.5 };
}

/**
 * Star row. `label`: what screen readers hear, in the buyer's language ("4 étoiles sur 5");
 * without it the stars are decoration (hidden), for rows next to a visible "4,8/5".
 */
export function Stars({ n, size = 14, className = "", label }: { n: number; size?: number; className?: string; label?: string }) {
  const { full, half } = starFill(n);
  const on = "fill-amber-400 text-amber-400";
  const off = "fill-neutral-200 text-neutral-200";
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`} {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}>
      {[0, 1, 2, 3, 4].map((i) =>
        i === full && half ? (
          <span key={i} className="relative inline-block" style={{ width: size, height: size }} data-star="half">
            <Star style={{ width: size, height: size }} className={`absolute inset-0 ${off}`} />
            <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: size / 2 }}>
              <Star style={{ width: size, height: size }} className={`max-w-none ${on}`} />
            </span>
          </span>
        ) : (
          <Star key={i} style={{ width: size, height: size }} className={i < full ? on : off} data-star={i < full ? "full" : "empty"} />
        ),
      )}
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

/**
 * Logos shown small next to the Payment title: the payment-logos block's methods, kept only
 * when this checkout really offers them (card brands with the card form, Apple Pay / Google
 * Pay only when their express button shows; SEPA / crypto are never offered here). Pure.
 */
export function offeredPaymentLogos(methods: readonly string[], offered: { applePay: boolean; googlePay: boolean }): string[] {
  return methods.filter((m) => m === "visa" || m === "mastercard" || m === "amex" || (m === "applepay" && offered.applePay) || (m === "gpay" && offered.googlePay));
}

/**
 * The payment-logos block whose logos the Payment title shows (checkout): the first visible one,
 * when the Payment section shows and at least one of its logos is offered. Null otherwise (the
 * block is then either absent, skipped or drawn on its own). Pure.
 */
export function headerLogosBlockId(blocks: readonly Block[], offered: { applePay: boolean; googlePay: boolean }): string | null {
  if (!blocks.some((b) => b.type === "payment" && !b.hidden)) return null;
  const icons = blocks.find((b) => b.type === "payment_icons" && !b.hidden);
  return icons?.type === "payment_icons" && offeredPaymentLogos(icons.props.methods, offered).length > 0 ? icons.id : null;
}

/** The small logo row of the Payment section header (see offeredPaymentLogos). */
export function PaymentHeaderLogos({ methods, label }: { methods: readonly string[]; label: string }) {
  if (methods.length === 0) return null;
  return (
    <ul aria-label={label} className="flex min-w-0 max-w-full flex-wrap justify-end gap-1">
      {methods.map((m) => (
        <li key={m} className="rounded border border-[var(--border)] bg-white px-1.5 py-0.5 text-[11px] leading-4 font-bold text-neutral-700">
          {PAYMENT_ICON_LABEL[m]}
        </li>
      ))}
    </ul>
  );
}

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
  const text = (parts[0] ? `${parts[0]}${labels.daysShort} ` : "") + parts.slice(1).map((p) => String(p).padStart(2, "0")).join(":");
  return (
    <div className="wc-bleed flex items-center justify-between gap-3 rounded-[var(--radius)] border border-red-200/70 bg-gradient-to-r from-red-50 to-orange-50 px-4 py-3 text-red-700">
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
    <div className="wc-bleed rounded-[var(--radius)] border border-[var(--border)] bg-white p-4">
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
  const fmt = (d: Date) => d.toLocaleDateString(localeOf(ctx.lang), { weekday: "short", day: "numeric", month: "short" });
  const shipped = addDays(today, Math.min(1, minDays), businessDays);
  const from = addDays(today, minDays, businessDays);
  const to = addDays(today, Math.max(minDays, maxDays), businessDays);
  const steps = [
    { icon: Check, title: ctx.labels.stepOrdered, date: fmt(today) },
    { icon: Package, title: ctx.labels.stepShipped, date: fmt(shipped) },
    { icon: Home, title: ctx.labels.stepDelivered, date: `${fmt(from)} – ${fmt(to)}` },
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

/** "12 mars 2024" in the buyer's language (UTC: the same text on the server and in the browser). */
function reviewDate(date: string, lang: Lang): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? "" : new Date(t).toLocaleDateString(localeOf(lang), { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

/** Reviews listed before "Show more" (list layout). */
const REVIEWS_SHOWN = 3;

function ReviewCard({ r, labels, lang }: { r: ReviewItem; labels: Labels; lang: Lang }) {
  const date = r.date ? reviewDate(r.date, lang) : "";
  return (
    <figure className="flex h-full flex-col rounded-[var(--radius)] border border-[var(--border)] bg-white p-4 text-left text-neutral-900 shadow-[0_1px_2px_rgba(15,23,42,.04)]">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Stars n={r.stars} label={labels.starsOutOf5(r.stars.toLocaleString(localeOf(lang)), r.stars)} />
        {r.verified && (
          <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-800">
            <BadgeCheck className="h-3.5 w-3.5" aria-hidden /> {labels.verifiedPurchase}
          </span>
        )}
      </div>
      <div className="mt-2 flex gap-3">
        <div className="min-w-0 flex-1">
          {r.title && <p className="text-sm font-semibold leading-snug break-words">{r.title}</p>}
          <blockquote className={`${r.title ? "mt-1" : ""} text-sm leading-relaxed whitespace-pre-line break-words`}>{r.text}</blockquote>
        </div>
        {r.photoUrl && (
          <SafeImg src={r.photoUrl} alt={labels.reviewPhoto} loading="lazy" className="h-16 w-16 shrink-0 rounded-[calc(var(--radius)*.6)] object-cover" fallback={null} />
        )}
      </div>
      {(r.name || date || r.productTitle) && (
        <figcaption className="mt-auto pt-2.5 text-xs break-words text-neutral-600">
          {r.name && <span className="font-semibold text-neutral-800">{r.name}</span>}
          {r.name && date && " · "}
          {date && <time dateTime={r.date}>{date}</time>}
          {r.productTitle && <span className="block truncate">{r.productTitle}</span>}
        </figcaption>
      )}
    </figure>
  );
}

/** "★★★★★ 4,8/5 · 1 234 avis": only from real data (all the store's published reviews). */
function ReviewsSummary({ summary, labels, lang }: { summary: ReviewSummary; labels: Labels; lang: Lang }) {
  const score = formatRatingScore(summary.score, localeOf(lang));
  const count = summary.count.toLocaleString(localeOf(lang));
  // A paragraph with an aria-label is not read out: the sentence is real (screen-reader only)
  // text, the stars and figures are decoration for sighted buyers.
  return (
    <p className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="sr-only">{labels.reviewsSummary(score, count, summary.count)}</span>
      <span aria-hidden="true" className="contents">
        <Stars n={summary.score} size={16} />
        <span className="font-semibold">{score}/5</span>
        <span className="text-[var(--muted)]">· {labels.reviewsCount(count, summary.count)}</span>
      </span>
    </p>
  );
}

/** More reviews than this: a "3 / 20" counter instead of one dot per review. */
const CAROUSEL_MAX_DOTS = 6;

function ReviewsCarousel({ items, labels, lang, title }: { items: ReviewItem[]; labels: Labels; lang: Lang; title?: string }) {
  // Back to the first review whenever the list changes (reordered, removed, cart order).
  const sig = items.map((r) => `${r.name}\u0001${r.text}`).join("\u0002");
  const [state, setState] = useState({ sig, i: 0 });
  const n = items.length;
  const at = state.sig === sig ? state.i % n : 0;
  const setI = (i: number) => setState({ sig, i });
  return (
    <div className="relative" role="region" aria-roledescription={labels.reviewsCarousel} aria-label={title || labels.reviewsCarousel}>
      {/* Every card sits in the same grid cell: the carousel keeps the tallest card's height (no jump). */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {n > 1 ? `${labels.reviewN(at + 1)} / ${n}` : ""}
      </p>
      <div className="grid">
        {items.map((r, k) => (
          <div
            key={k}
            className={`[grid-area:1/1] ${k === at ? "" : "invisible"}`}
            role="group"
            aria-roledescription={labels.reviewSlide}
            aria-label={`${k + 1} / ${n}`}
            aria-hidden={k === at ? undefined : true}
          >
            <ReviewCard r={r} labels={labels} lang={lang} />
          </div>
        ))}
      </div>
      {n > 1 && (
        <div className="mt-2.5 flex items-center justify-between">
          {n > CAROUSEL_MAX_DOTS ? (
            <span className="text-sm text-[var(--muted)] tabular-nums" aria-hidden="true">
              {at + 1} / {n}
            </span>
          ) : (
            <div className="-ml-2 flex flex-wrap">
              {items.map((_, k) => (
                <button
                  key={k}
                  type="button"
                  aria-label={labels.reviewN(k + 1)}
                  aria-current={k === at ? "true" : undefined}
                  onClick={() => setI(k)}
                  className="flex h-11 min-w-6 items-center justify-center px-1"
                >
                  <span className={`block h-1.5 rounded-full transition-all ${k === at ? "w-5 bg-[var(--accent)]" : "w-1.5 bg-black/30"}`} />
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            <button type="button" aria-label={labels.prevReview} onClick={() => setI((at - 1 + items.length) % items.length)} className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border)] bg-white text-neutral-900 hover:bg-black/[.03]">
              <ChevronLeft className="h-4 w-4" aria-hidden />
            </button>
            <button type="button" aria-label={labels.nextReview} onClick={() => setI((at + 1) % items.length)} className="flex h-11 w-11 items-center justify-center rounded-full border border-[var(--border)] bg-white text-neutral-900 hover:bg-black/[.03]">
              <ChevronRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewsList({ items, labels, lang }: { items: ReviewItem[]; labels: Labels; lang: Lang }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, REVIEWS_SHOWN);
  return (
    <div>
      <ul className="space-y-2.5">
        {shown.map((r, k) => (
          <li key={k}>
            <ReviewCard r={r} labels={labels} lang={lang} />
          </li>
        ))}
      </ul>
      {items.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="mt-1 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-2">
          {labels.moreReviews(items.length - shown.length)}
        </button>
      )}
    </div>
  );
}

/**
 * What the shown average covers, for the transparency note: Shopify metafields (active products)
 * every published review of the store, or part of them when the read was capped; a partial
 * Judge.me import only its N most recent reviews; a CSV every review of the merchant's file;
 * a full Judge.me import every published review.
 */
function noteSummary(summary: ReviewSummary | null | undefined, lang: Lang): ReviewsNoteSummary {
  if (!summary) return false;
  if (summary.source === "shopify") return summary.partial ? "store-partial" : "store";
  if (summary.partial) return { recent: summary.count.toLocaleString(localeOf(lang)) };
  return summary.source === "csv" ? "file" : true;
}

function Reviews({ title, layout, items, summary, labels, lang }: BlockOf<"reviews">["props"] & { labels: Labels; lang: Lang }) {
  if (items.length === 0) return null;
  // EU Omnibus: where the shown reviews come from and what "Verified purchase" means, only when
  // imported reviews are among them (hand-typed only: nothing to disclose about an app).
  // The shipped examples never count (old untagged blocks saved them with an import source).
  const real = items.filter((it) => !isSampleReview(it));
  const origin = importedReviewsOrigin(real);
  // A selection (never "all the reviews"); hand-typed ones among them are not called imported.
  const mixed = real.some((it) => it.source == null || it.source === "manual");
  return (
    <div>
      <Heading>{title}</Heading>
      {summary && <ReviewsSummary summary={summary} labels={labels} lang={lang} />}
      {layout === "stack" ? (
        <ReviewsList items={items} labels={labels} lang={lang} />
      ) : layout === "carousel" ? (
        <ReviewsCarousel items={items} labels={labels} lang={lang} title={title} />
      ) : (
        // Auto: one card at a time in a narrow column (mobile), the first reviews listed when wide.
        <div className="@container">
          <div className="@md:hidden">
            <ReviewsCarousel items={items} labels={labels} lang={lang} title={title} />
          </div>
          <div className="hidden @md:block">
            <ReviewsList items={items} labels={labels} lang={lang} />
          </div>
        </div>
      )}
      {origin ? (
        <p data-imported-reviews-note className="mt-2 text-xs leading-snug text-[var(--muted)]">
          {labels.importedReviewsNote(origin === "judgeme" ? "Judge.me" : null, { mixed, summary: noteSummary(summary, lang) })}
        </p>
      ) : (
        // An average shown above hand-typed (or example) reviews only: what it covers, no app named.
        summary && (
          <p data-reviews-average-note className="mt-2 text-xs leading-snug text-[var(--muted)]">
            {labels.averageScope(noteSummary(summary, lang) || true)}
          </p>
        )
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
  // Collapsed behind a link until the buyer wants it: keeps the payment step higher.
  const [open, setOpen] = useState(ctx.preview || !!ctx.note);
  if (!open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium underline underline-offset-2"
      >
        <Plus className="h-4 w-4" aria-hidden /> {title}
      </button>
    );
  }
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{title}</span>
      <textarea
        rows={3}
        maxLength={1000}
        value={ctx.note}
        autoFocus={!ctx.preview && !ctx.note}
        readOnly={!!ctx.noteLockedBy}
        aria-describedby={ctx.noteLockedBy ?? undefined}
        onChange={(e) => ctx.setNote(e.target.value)}
        placeholder={placeholder}
        className="w-full resize-y rounded-[var(--radius)] border border-[var(--field-border,var(--border))] bg-white px-3.5 py-3 text-base outline-none focus:border-[var(--accent)]"
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
  lang: Lang;
  /** lowest tracked inventory among cart items (null in the builder without data) */
  lowestInventory: number | null;
  preview: boolean;
  subtotalCents: number;
  freeShippingThresholdCents: number | null;
  money: (cents: number) => string;
  note: string;
  setNote: (v: string) => void;
  /** A PayPal payment is pending: the id of the checkout's lock note; the order note is read-only. */
  noteLockedBy?: string | null;
  /** Thank-you page, live: one-click post-purchase offers. */
  upsell?: UpsellContext;
  /** Thank-you page: end of the one-click offer window (ms), for the "valid N more min" line. */
  offerEndsAt?: number | null;
  /** Full-screen preview: offers are shown as buyers see them, answering does nothing. */
  demoOffers?: boolean;
  /** Photos of the order's lines by variant GID: an offer without its own image uses its line's. */
  lineImages?: Record<string, string>;
  /** Thank-you page survey: live answer state (null = preview / not paid). */
  survey?: { sessionId: string; answered: boolean } | null;
  /**
   * The checkout was paid in another currency than the shop's (local currency option): one-click
   * offers are charged in the shop's, so the offer says so. { shop, paid } currency codes.
   */
  offerCurrency?: { shop: string; paid: string } | null;
  /** Products of the order (live): the reviews block shows theirs first. */
  cartProducts?: CartProducts | null;
  /**
   * Wallets this checkout really offers (live): the payment-logos block keeps only those
   * (offeredPaymentLogos). Unknown (thank-you page): card brands only.
   */
  offeredWallets?: { applePay: boolean; googlePay: boolean };
  /** Checkout: the logos show next to the Payment title, so the block is skipped live (shown once). */
  paymentLogosInHeader?: boolean;
  /**
   * Preview: the payment-logos block whose logos the Payment title already shows
   * (headerLogosBlockId). It draws a slim placeholder instead of its logos, so they aren't drawn twice.
   */
  headerLogosBlockId?: string | null;
};

/** Payment logos buyers see: in preview the merchant's list, live only what is really offered. */
export function livePaymentLogos(methods: readonly string[], ctx: Pick<ContentContext, "preview" | "offeredWallets">): string[] {
  return ctx.preview ? [...methods] : offeredPaymentLogos(methods, ctx.offeredWallets ?? { applePay: false, googlePay: false });
}

/** Thank-you page state of the one-click offers (live only). */
export type UpsellContext = {
  sessionId: string;
  /** Payment method saved, within the offer window, order not held… */
  eligible: boolean;
  /** Answer per offer block id: PAID | PENDING | FAILED | DECLINED. */
  states: Record<string, string>;
  /** Confirmation text of accepted offers (kept when the funnel moves on). */
  messages?: Record<string, string>;
  /** Offers whose targeting matches this order (server-side). */
  offerIds: string[];
  /** Every offer block of the page, for the funnels (accept / decline chains). */
  blocks: BlockOf<"upsell">[];
  /** A/B arm this visitor sees, per offer block (server-side, sticky). Missing = A. */
  arms?: Record<string, OfferArm>;
  /** Live Shopify unit prices (cents) by variant GID, for "% off" offers. */
  livePrices?: Record<string, number>;
  setState: (blockId: string, status: string, message?: string) => void;
  /**
   * "No thanks" answered in this page view. `index`: position of the declined offer's heading
   * among the page's offer headings, so the page can move focus to the next offer (or the order
   * heading) and announce it, even when the declined slot disappears.
   */
  declined?: (index: number) => void;
};

/**
 * The slot opened by `root`: offers already accepted in its funnel (confirmations) and the
 * one waiting for an answer (null when the buyer can no longer be offered anything).
 */
function slotTrail(root: BlockOf<"upsell">, u: UpsellContext): { accepted: BlockOf<"upsell">[]; current: BlockOf<"upsell"> | null } {
  if (downsellTargets(u.blocks).has(root.id)) return { accepted: [], current: null }; // shown in its parent's slot
  const trail = offerTrail(u.blocks, root.id, u.states, (x) => u.offerIds.includes(x));
  const byId = (id: string) => u.blocks.find((b) => b.id === id) ?? null;
  const accepted = trail.accepted.map(byId).filter((b): b is BlockOf<"upsell"> => !!b);
  const current = trail.current && u.eligible ? byId(trail.current) : null;
  return { accepted, current };
}

/**
 * True while the offer shown in this slot still waits for the buyer's answer
 * (the thank-you page then styles "Continue shopping" as a secondary button).
 */
export function offerAwaitingAnswer(root: BlockOf<"upsell">, u: UpsellContext): boolean {
  const offer = slotTrail(root, u).current;
  const state = offer ? u.states[offer.id] : undefined;
  return !!offer && state !== "PAID" && state !== "PENDING" && state !== "DECLINED";
}

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
    // Shipped sample proof (reviews, figures, testimonial, coupon, announcement, placeholder
    // text) of a block tagged `sample` never reaches buyers: the builder flags it until the
    // merchant writes their own. Untagged blocks (published before) render as they always did.
    case "reviews":
      return isSampleOnly(block) || liveReviewItems(block).length === 0;
    case "stats":
    case "testimonial":
    case "coupon":
    case "announcement":
      return isSampleOnly(block);
    case "text": {
      // Nothing left to read (both parts empty, placeholders of a tagged block included): no empty card.
      const t = liveTextProps(block);
      return isSampleOnly(block) || (!t.heading.trim() && !t.body.trim());
    }
    case "payment_icons":
      // Shown once, next to the Payment title (checkout); elsewhere only the logos really offered.
      return !!ctx.paymentLogosInHeader || livePaymentLogos(block.props.methods, ctx).length === 0;
    case "rating":
      return !ratingIsSet(block.props);
    case "social": {
      const p = block.props;
      return !p.instagram && !p.tiktok && !p.facebook && !p.youtube;
    }
    case "support": {
      // A contact channel is required: "Besoin d'aide ?" without any way to reach you helps no one.
      const p = block.props;
      return !p.email.trim() && !p.phone.trim() && !p.whatsapp.replace(/[^\d]/g, "");
    }
    case "button_link":
      return !block.props.url;
    case "countdown": {
      const end = Date.parse(block.props.endsAt);
      return !block.props.endsAt || Number.isNaN(end) || end <= now;
    }
    case "low_stock":
      return ctx.lowestInventory == null || ctx.lowestInventory <= 0 || ctx.lowestInventory > block.props.threshold;
    case "free_shipping_bar":
      return !(block.props.threshold > 0 || ctx.freeShippingThresholdCents);
    case "upsell": {
      if (ctx.demoOffers) return false;
      if (!block.props.variantId || !ctx.upsell) return true;
      const slot = slotTrail(block, ctx.upsell);
      // Accepted offers keep their confirmation; the open one goes when the window is over.
      if (slot.accepted.length) return false;
      if (!slot.current) return true;
      return !!ctx.offerEndsAt && now >= ctx.offerEndsAt;
    }
    case "survey":
      return (!ctx.survey && !ctx.demoOffers) || block.props.options.length === 0;
    default:
      return false;
  }
}

export function ContentBlock({ block, ctx }: { block: Block; ctx: ContentContext }) {
  switch (block.type) {
    case "text": {
      // Live: a placeholder part ("Titre", "Votre texte ici.") of a sample block is left out.
      const { heading, body } = ctx.preview ? block.props : liveTextProps(block);
      // Builder: an empty text block stays visible and selectable (live skips it: isEmptyInLive).
      if (ctx.preview && !heading.trim() && !body.trim()) return <Placeholder inlineField="body">Bloc texte vide</Placeholder>;
      return (
        <div className="space-y-1">
          {heading && (
            <h3 data-inline-field="heading" className="font-[family-name:var(--heading-font)] text-base font-semibold tracking-tight">
              {heading}
            </h3>
          )}
          {body && (
            <p data-inline-field="body" className="whitespace-pre-line opacity-80">
              {body}
            </p>
          )}
        </div>
      );
    }
    case "image": {
      if (!block.props.url) return ctx.preview ? <Placeholder>Bloc image — ajoutez une URL</Placeholder> : null;
      // Large and full-width images are banners: edge to edge on phones (small ones stay inset).
      const width = { sm: "max-w-[160px]", md: "max-w-[280px]", lg: "wc-bleed max-w-[420px]", full: "wc-bleed w-full" }[block.props.size];
      return (
        <SafeImg
          src={block.props.url}
          alt={block.props.alt}
          className={`${width} mx-auto rounded-[var(--radius)]`}
          fallback={ctx.preview ? <Placeholder>Image introuvable : vérifiez l&apos;adresse de l&apos;image</Placeholder> : null}
        />
      );
    }
    case "testimonial":
      return (
        <figure className="flex gap-3 text-left">
          {block.props.photoUrl && (
            <SafeImg src={block.props.photoUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover ring-2 ring-white" fallback={null} />
          )}
          <div className="space-y-1">
            <Stars n={block.props.stars} label={ctx.labels.starsOutOf5(block.props.stars.toLocaleString(localeOf(ctx.lang)), block.props.stars)} />
            <blockquote className="text-sm">« {block.props.quote} »</blockquote>
            {block.props.author && <figcaption className="text-xs font-semibold text-[var(--muted)]">{block.props.author}</figcaption>}
          </div>
        </figure>
      );
    case "rating": {
      // No invented score: until the merchant enters theirs, only the builder shows the block.
      if (!ratingIsSet(block.props)) return ctx.preview ? <Placeholder>Note globale · À compléter : saisissez votre note réelle</Placeholder> : null;
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Stars n={block.props.score} size={18} />
          <span className="font-semibold">{formatRatingScore(block.props.score, localeOf(ctx.lang))}/5</span>
          <span className="text-sm text-[var(--muted)]">
            {block.props.count > 0 && `${ctx.labels.reviewsCount(block.props.count.toLocaleString(localeOf(ctx.lang)), block.props.count)} · `}
            {block.props.label}
          </span>
        </div>
      );
    }
    case "trust_badges":
      return (
        // A tidy left-aligned stack in narrow columns (summary), a row of equal cells when wide.
        <div className="@container">
          <ul className="grid grid-cols-1 gap-x-4 gap-y-2.5 text-left text-sm @lg:grid-cols-3">
            {block.props.badges.map((b, i) => {
              const check = (
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--accent)_10%,white)] text-[var(--accent)]">
                  <Check className="h-3.5 w-3.5" strokeWidth={2.75} aria-hidden />
                </span>
              );
              return (
                <li key={i} className="flex items-center gap-2.5 leading-snug">
                  {b.iconUrl ? <SafeImg src={b.iconUrl} alt="" className="h-6 w-6 shrink-0 object-contain" fallback={check} /> : check}
                  <span className="min-w-0">{b.label}</span>
                </li>
              );
            })}
          </ul>
        </div>
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
      if (ctx.preview && ctx.headerLogosBlockId === block.id) {
        // Merchant-only (preview): its logos are drawn next to the Payment title, not twice.
        return (
          <div
            data-logos-in-header
            className="flex min-h-14 items-start justify-center rounded-md border border-dashed border-[var(--border)] px-3 pt-2 text-center text-[11px] leading-4 text-[var(--muted)]"
          >
            Logos affichés à côté du titre « Paiement »
          </div>
        );
      }
      // Preview of the thank-you page (no wallet offered there): the merchant's list, with the
      // logos buyers won't see (Apple Pay, Google Pay, SEPA, crypto) greyed.
      const shownLive = ctx.preview && !ctx.offeredWallets ? offeredPaymentLogos(block.props.methods, { applePay: false, googlePay: false }) : null;
      return (
        <div className="space-y-2">
          {block.props.label && <p className="text-xs text-[var(--muted)]">{block.props.label}</p>}
          <div className="flex flex-wrap justify-center gap-1.5">
            {livePaymentLogos(block.props.methods, ctx).map((m) => (
              <span
                key={m}
                data-not-shown={shownLive && !shownLive.includes(m) ? "" : undefined}
                title={shownLive && !shownLive.includes(m) ? "Pas affiché sur la page de remerciement" : undefined}
                className={`rounded-md border border-[var(--border)] bg-white px-2 py-1 text-[11px] font-bold text-neutral-700 shadow-[0_1px_1px_rgba(0,0,0,.04)] ${
                  shownLive && !shownLive.includes(m) ? "line-through opacity-40" : ""
                }`}
              >
                {PAYMENT_ICON_LABEL[m]}
              </span>
            ))}
          </div>
        </div>
      );
    case "announcement":
      return (
        <div
          data-inline-field="text"
          className="wc-bleed rounded-[var(--radius)] bg-[image:var(--accent-bg)] px-4 py-2.5 text-center text-sm font-medium text-[var(--accent-fg)] shadow-sm"
        >
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
                <p className="text-sm text-[var(--muted)]">{r.text}</p>
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
      // Buyers never see the shipped example reviews (the builder still shows them, flagged).
      // Live: reviews of the products in the cart first, then the general ones. "Achat vérifié"
      // never shows on example or hand-typed reviews (old untagged blocks included).
      return (
        <Reviews
          {...block.props}
          items={honestReviewItems(ctx.preview ? block.props.items : orderReviewsForCart(liveReviewItems(block), ctx.cartProducts))}
          labels={ctx.labels}
          lang={ctx.lang}
        />
      );
    case "comparison":
      return (
        <div>
          <Heading>{block.props.title}</Heading>
          <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-white text-sm">
            <div className="grid grid-cols-[1fr_72px_72px] border-b border-[var(--border)] bg-black/[.02] text-xs font-semibold">
              <span className="px-3 py-2.5" />
              <span className="bg-[color-mix(in_srgb,var(--accent)_10%,white)] px-2 py-2.5 text-center text-[var(--accent)]">{block.props.usLabel}</span>
              <span className="px-2 py-2.5 text-center text-neutral-700">{block.props.themLabel}</span>
            </div>
            {block.props.rows.map((r, i) => (
              <div key={i} className="grid grid-cols-[1fr_72px_72px] border-b border-[var(--border)] last:border-0">
                <span className="px-3 py-2.5">{r.label}</span>
                <span className="flex items-center justify-center bg-[color-mix(in_srgb,var(--accent)_5%,white)]">
                  {r.us ? <Check className="h-4 w-4 text-emerald-700" strokeWidth={3} role="img" aria-label="✓" /> : <X className="h-4 w-4 text-neutral-600" role="img" aria-label="✗" />}
                </span>
                <span className="flex items-center justify-center">
                  {r.them ? <Check className="h-4 w-4 text-neutral-600" strokeWidth={3} role="img" aria-label="✓" /> : <X className="h-4 w-4 text-red-600" role="img" aria-label="✗" />}
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
          <div className="wc-bleed aspect-video overflow-hidden rounded-[var(--radius)] bg-black shadow-sm">
            {embed.kind === "iframe" ? (
              <iframe
                src={embed.src}
                title={block.props.caption || ctx.labels.video}
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
                <SafeImg key={i} src={l.imageUrl} alt={l.alt} className="h-6 w-auto object-contain opacity-60 grayscale" fallback={null} />
              ) : null,
            )}
          </div>
        </div>
      );
    case "stats": {
      // Buyers never see the shipped example figures (the builder still shows them, flagged).
      const items = ctx.preview ? block.props.items : liveStatItems(block);
      return (
        <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))` }}>
          {items.map((s, i) => (
            <div key={i} className="rounded-[var(--radius)] border border-[var(--border)] bg-white px-2 py-3 text-center">
              <p className="bg-[image:var(--accent-bg)] bg-clip-text font-[family-name:var(--heading-font)] text-xl font-bold tracking-tight text-transparent">{s.value}</p>
              <p className="text-[11px] text-[var(--muted)]">{s.label}</p>
            </div>
          ))}
        </div>
      );
    }
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
              <a href={`mailto:${p.email}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-[var(--border)] px-3.5 py-2 hover:bg-black/[.03]">
                <Mail className="h-3.5 w-3.5" /> {p.email}
              </a>
            )}
            {p.phone && (
              <a href={`tel:${p.phone.replace(/\s/g, "")}`} className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-[var(--border)] px-3.5 py-2 hover:bg-black/[.03]">
                <Phone className="h-3.5 w-3.5" /> {p.phone}
              </a>
            )}
            {wa && (
              <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center gap-1.5 rounded-full bg-[#1f7a43] px-3.5 py-2 font-medium text-white">
                <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
              </a>
            )}
            {!p.email && !p.phone && !wa && ctx.preview && <span className="text-xs text-neutral-500 italic">Ajoutez un e-mail, un téléphone ou WhatsApp</span>}
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
    case "survey":
      return <Survey block={block} ctx={ctx} />;
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

/**
 * "Complétez votre commande" (checkout): compact product cards with a one-tap "Ajouter".
 * Without `onAdd` (builder preview) the button does nothing.
 */
export function Recommendations({
  title,
  items,
  labels: L,
  money,
  showImages,
  idPrefix,
  onAdd,
}: {
  title: string;
  items: CartLine[];
  labels: Labels;
  money: (cents: number) => string;
  showImages: boolean;
  idPrefix: string;
  onAdd?: (item: CartLine) => void;
}) {
  if (items.length === 0) return null;
  const headingId = `${idPrefix}reco-title`;
  return (
    <section aria-labelledby={headingId} className="text-left">
      <h2 id={headingId} className="mb-2.5 font-[family-name:var(--heading-font)] text-base font-semibold tracking-tight">
        {title}
      </h2>
      <ul className="space-y-2">
        {items.map((r) => {
          const price = money(r.unitPriceCents);
          const compare = r.compareAtCents != null && r.compareAtCents > r.unitPriceCents ? money(r.compareAtCents) : null;
          return (
            <li key={r.variantId} className="flex items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-white p-2.5">
              {showImages && (
                <SafeImg
                  src={r.imageUrl ?? ""}
                  alt=""
                  width={48}
                  height={48}
                  className="h-12 w-12 shrink-0 rounded-[calc(var(--radius)*0.8)] border border-neutral-200 bg-white object-cover"
                  fallback={
                    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[calc(var(--radius)*0.8)] bg-neutral-100 text-neutral-400">
                      <Package className="h-5 w-5" aria-hidden />
                    </span>
                  }
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="line-clamp-2 text-sm leading-snug font-medium break-words">{r.title}</p>
                {r.variantTitle && <p className="truncate text-xs text-neutral-600">{r.variantTitle}</p>}
                <p className="mt-0.5 flex flex-wrap items-baseline gap-x-1.5 text-sm">
                  <span className="font-semibold">{price}</span>
                  {compare && (
                    <s className="text-xs text-neutral-600">
                      <span className="sr-only">{L.recoWas} </span>
                      {compare}
                    </s>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={onAdd ? () => onAdd(r) : undefined}
                aria-label={L.recoAddLabel(r.title, price)}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center gap-1 rounded-[var(--btn-radius)] bg-[image:var(--accent-bg)] px-3.5 text-sm font-semibold text-[var(--accent-fg)] transition hover:brightness-110 motion-reduce:transition-none"
              >
                <Plus className="h-4 w-4" aria-hidden />
                {L.recoAdd}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Merchant-only placeholder (preview). `inlineField`: the empty text field it stands for, so a
 * double-click on the canvas edits that field (data-inline-empty: the editor opens blank, not
 * with the placeholder's wording).
 */
export function Placeholder({ children, inlineField }: { children: ReactNode; inlineField?: string }) {
  return (
    <div
      data-inline-field={inlineField}
      data-inline-empty={inlineField ? "" : undefined}
      className="rounded-[var(--radius)] border-2 border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500"
    >
      {children}
    </div>
  );
}

/**
 * After "No thanks", focus goes to the offer heading now at the declined one's place (the next
 * step of its funnel, else the next offer down the page), else the last offer left above, else
 * the order heading — keyboard and screen-reader users are never dropped on <body>.
 */
export function focusAfterDecline(index: number) {
  const headings = Array.from(document.querySelectorAll<HTMLElement>("[data-offer-heading]"));
  const target = headings[Math.min(Math.max(0, index), headings.length - 1)] ?? document.querySelector<HTMLElement>("[data-order-heading]");
  if (!target || target === document.activeElement) return;
  target.focus({ preventScroll: true });
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView?.({ block: "center", behavior: reduce ? "auto" : "smooth" });
}

/** One-click post-purchase offer slot (thank-you page): the offer, then the next step of its funnel after "Yes" or "No thanks". */
function UpsellOffer({ block, ctx }: { block: BlockOf<"upsell">; ctx: ContentContext }) {
  const u = ctx.upsell && !ctx.preview ? ctx.upsell : null;
  const trail = u ? slotTrail(block, u) : null;
  // Offers already accepted when the page loaded: their confirmation never grabs focus.
  const [initial] = useState(() => new Set(trail?.accepted.map((b) => b.id) ?? []));
  if (!u || !trail) return <OfferCard block={block} ctx={ctx} upsell={null} swapped={false} />;
  const { accepted, current } = trail;
  if (!accepted.length && !current) return null;
  return (
    <div className="space-y-3">
      {/* Accepted steps keep their confirmation while the funnel offers the next one. */}
      {accepted.map((b) => (
        <OfferConfirmation
          key={`ok-${b.id}`}
          // Accepted just now and no next step: the confirmation takes focus (the buttons are gone).
          autoFocus={!current && !initial.has(b.id)}
          text={u.messages?.[b.id] ?? (u.states[b.id] === "PAID" ? ctx.labels.upsellAdded("") : ctx.labels.upsellAddedPending)} />
      ))}
      {/* Keyed by offer: the next step mounts fresh (its own quantity, impression and entrance). */}
      {current && <OfferCard key={current.id} block={current} ctx={ctx} upsell={u} swapped={current.id !== block.id} />}
    </div>
  );
}

function OfferConfirmation({ text, autoFocus }: { text: string; /** Answered just now: focus moves here (the buttons are gone). */ autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: false });
  }, [autoFocus]);
  return (
    <div ref={ref} tabIndex={-1} role="status" className="flex items-center gap-3 rounded-[var(--radius)] border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600">
      <Check className="h-5 w-5 shrink-0" strokeWidth={2.5} aria-hidden />
      {text}
    </div>
  );
}

function OfferCard({ block, ctx, upsell, swapped }: { block: BlockOf<"upsell">; ctx: ContentContext; upsell: UpsellContext | null; swapped: boolean }) {
  // The arm this visitor sees (server-decided); the builder canvas shows arm A.
  const arm: OfferArm = upsell?.arms?.[block.id] ?? "A";
  const p = offerArmProps(block, arm);
  const state = upsell?.states[block.id] ?? null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; uncertain: boolean } | null>(null);
  // Accepted offer whose outcome is unknown (5xx, lost connection): both buttons are hidden
  // and the session's status is polled until the charge settles ("slow": still unsettled).
  const [pending, setPending] = useState<null | "polling" | "slow">(null);
  const [quantity, setQuantity] = useState(1);
  const root = useRef<HTMLDivElement>(null);
  const pendingRef = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // The buyer answered in this page view: the outcome (notice, error, confirmation) takes focus.
  const [answered, setAnswered] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    // The notice replaces the buttons at the top of the card: keep it on screen (small phones).
    // The buttons are gone: focus moves to the notice (keyboard / screen-reader users).
    if (!pending) return;
    pendingRef.current?.focus({ preventScroll: true });
    pendingRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [pending]);
  useEffect(() => {
    if (error && answered) errorRef.current?.focus({ preventScroll: false });
  }, [error, answered]);
  const heading = useRef<HTMLHeadingElement>(null);
  const L = ctx.labels;
  const maxQty = Math.min(MAX_OFFER_QUANTITY, Math.max(1, p.maxQuantity ?? 1));
  // "% off" offers: Shopify's live price (thank-you page); the builder uses the regular price entered.
  const percent = p.priceMode === "percent";
  const liveCents = percent ? (upsell ? upsell.livePrices?.[variantGidOf(p.variantId) ?? ""] : p.compareAt > 0 ? Math.round(p.compareAt * 100) : null) : null;
  const unitCents = offerUnitCents(p, liveCents) ?? 0;
  const price = ctx.money(unitCents);
  const total = ctx.money(unitCents * quantity);
  const compareUnit = percent ? (liveCents ?? 0) : Math.round(p.compareAt * 100);
  const compare = compareUnit > unitCents ? ctx.money(compareUnit * quantity) : null;
  const pctOff = percent ? new Intl.NumberFormat(localeOf(ctx.lang), { maximumFractionDigits: 0 }).format(p.discountPercent) : null;
  const live = !!upsell;
  const viewSession = live && state == null ? upsell.sessionId : undefined;
  const viewKey = armKey(block.id, arm);
  const now = useNow(30_000);
  const minutesLeft = ctx.offerEndsAt && now != null ? Math.max(1, Math.ceil((ctx.offerEndsAt - now) / 60_000)) : null;
  useEffect(() => {
    // Impression of the arm actually displayed (the next steps too), for the acceptance rate per arm.
    if (viewSession) void fetch(`/api/public/sessions/${viewSession}/upsell`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: true, blockIds: [viewKey] }) }).catch(() => undefined);
  }, [viewSession, viewKey]);

  useEffect(() => {
    // The next step replaces the answered offer: a short entrance, and focus moves to it.
    if (!swapped) return;
    heading.current?.focus({ preventScroll: true });
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      root.current?.animate?.(
        [
          { opacity: 0, transform: "translateY(10px) scale(.98)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
  }, [swapped]);

  async function settle() {
    if (!upsell) return;
    setPending("polling");
    setError(null);
    const started = Date.now();
    for (let attempt = 1; alive.current; attempt++) {
      const elapsed = Date.now() - started;
      await new Promise((r) => setTimeout(r, elapsed < 90_000 ? 2500 : 10_000));
      if (!alive.current) return;
      const body = await fetch(`/api/public/sessions/${upsell.sessionId}/status`, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const offer = (body?.upsells as Record<string, { status: string; orderName: string | null }> | undefined)?.[block.id];
      if (offer?.status === "PAID") {
        upsell.setState(block.id, "PAID", L.upsellAdded(offer.orderName ?? ""));
        return;
      }
      if (offer?.status === "DECLINED") {
        upsell.setState(block.id, "DECLINED");
        return;
      }
      // FAILED, or still no charge after a few checks (the request never reached the payment):
      // nothing was charged, and a new attempt is idempotent server-side.
      if (offer?.status === "FAILED" || (body && !offer && attempt >= 4)) {
        setPending(null);
        setError({ text: L.upsellFailedRetry, uncertain: false });
        return;
      }
      if (Date.now() - started >= 90_000) setPending("slow");
      if (Date.now() - started >= 10 * 60_000) return; // the background check settles it; the notice stays
    }
  }

  async function answer(accept: boolean) {
    if (!upsell) return;
    setAnswered(true);
    setBusy(true);
    setError(null);
    // Unknown outcome of an accepted offer (lost connection, server error after the charge
    // was sent): never claim nothing was charged; settle() waits for the real outcome.
    try {
      let res: Response;
      try {
        res = await fetch(`/api/public/sessions/${upsell.sessionId}/upsell`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // variantId: the product shown (an automatic offer is only charged if it is still that one).
          body: JSON.stringify(accept ? { blockId: block.id, accept, quantity, variantId: offerArmProps(block, upsell.arms?.[block.id] ?? "A").variantId } : { blockId: block.id, accept }),
        });
      } catch {
        if (accept) void settle();
        else setError({ text: L.error, uncertain: false });
        return;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok || !body) {
        if (body?.code === "upsell_uncertain" || (accept && (res.status >= 500 || !body))) void settle();
        else setError({ text: errorText(L, body), uncertain: false });
        return;
      }
      if (body.status === "action" && body.url) {
        window.location.href = body.url; // 3-D Secure confirmation, back to this page after
        return;
      }
      const message = body.status === "paid" ? L.upsellAdded(body.orderName ?? "") : body.status === "pending" ? L.upsellAddedPending : undefined;
      if (body.status === "declined" && heading.current) {
        upsell.declined?.(Array.from(document.querySelectorAll("[data-offer-heading]")).indexOf(heading.current));
      }
      upsell.setState(block.id, body.status === "paid" ? "PAID" : body.status === "declined" ? "DECLINED" : "PENDING", message);
    } catch {
      if (accept) void settle();
      else setError({ text: L.error, uncertain: false });
    } finally {
      setBusy(false);
    }
  }

  if (state === "DECLINED") return null;
  if (state === "PAID" || state === "PENDING") {
    return <OfferConfirmation autoFocus={answered} text={upsell?.messages?.[block.id] ?? (state === "PAID" ? L.upsellAdded("") : L.upsellAddedPending)} />;
  }
  // "% off" without a live price (Shopify unreachable): the server hides it; never a made-up price.
  if (live && percent && liveCents == null) return null;
  const image = p.imageUrl || ctx.lineImages?.[variantGidOf(p.variantId) ?? ""] || null;
  const tile = (
    <span className="flex h-24 w-24 shrink-0 items-center justify-center rounded-[calc(var(--radius)*0.8)] bg-neutral-100 text-neutral-400" aria-hidden>
      <Package className="h-8 w-8" />
    </span>
  );
  const stepBtn =
    "relative flex h-9 w-9 items-center justify-center rounded-full text-neutral-800 after:absolute after:-inset-1 after:content-[''] hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400 disabled:hover:bg-transparent";
  return (
    <div ref={root} className="overflow-hidden rounded-[var(--radius)] border-2 border-[var(--accent)] bg-white shadow-[0_12px_32px_-16px_rgba(0,0,0,.25)]">
      {swapped && <p className="sr-only">{L.upsellNextOffer}</p>}
      {p.badge && <p className="bg-[image:var(--accent-bg)] px-4 py-2 text-center text-xs font-semibold tracking-wide text-[var(--accent-fg)] uppercase">{p.badge}</p>}
      {/* Unknown outcome: the notice leads the card, the buttons are hidden until it settles. */}
      {pending && (
        // The focus ring is drawn around the notice itself, inside the card's padding: never clipped by the card's edge.
        <div ref={pendingRef} tabIndex={-1} className="group scroll-mt-4 px-4 pt-4 focus:outline-none">
          <div role="alert" className="flex items-start gap-3 rounded-[calc(var(--radius)*0.8)] border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-800 group-focus-visible:ring-2 group-focus-visible:ring-[var(--focus,#111827)] group-focus-visible:ring-offset-2">
            <span className="mt-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-neutral-500 border-r-transparent motion-reduce:animate-none" aria-hidden />
            <span>
              <strong className="block font-semibold">{L.upsellPendingTitle}</strong>
              {pending === "slow" ? L.upsellStillPending : L.upsellPendingText}
            </span>
          </div>
        </div>
      )}
      {ctx.preview && arm === "A" && block.props.variantB?.enabled && (
        <p className="bg-indigo-50 px-4 py-1 text-center text-[11px] text-indigo-900">Aperçu de la version A · la version B est vue par {block.props.variantB.split} % des clients</p>
      )}
      <div className="flex gap-4 p-4">
        {/* No photo of its own: the matching order line's photo, else a neutral tile (never an empty slot). */}
        {image ? (
          <SafeImg src={image} alt="" width={96} height={96} className="h-24 w-24 shrink-0 rounded-[calc(var(--radius)*0.8)] object-cover" fallback={tile} />
        ) : (
          tile
        )}
        <div className="min-w-0 flex-1">
          <h2 ref={heading} tabIndex={live ? -1 : undefined} data-offer-heading={live ? "" : undefined} className="rounded-sm font-[family-name:var(--heading-font)] text-base font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus,#111827)] focus-visible:ring-offset-2">
            {p.title}
          </h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{p.text}</p>
          <p className="mt-2 flex flex-wrap items-baseline gap-x-2">
            <span className="text-lg font-semibold">{total}</span>
            {compare && <span className="text-sm text-neutral-600 line-through">{compare}</span>}
            {pctOff && compare && <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">{L.upsellOff(pctOff)}</span>}
            {quantity > 1 && <span className="text-xs text-neutral-600">{`${quantity} × ${price}`}</span>}
          </p>
          {ctx.offerCurrency && <p className="mt-1 text-xs text-neutral-700">{L.upsellShopCurrency(ctx.offerCurrency.shop, ctx.offerCurrency.paid)}</p>}
        </div>
      </div>
      {!pending && (
        <div className="space-y-2 px-4 pb-4">
          {error && (
            <p ref={errorRef} tabIndex={-1} role="alert" className={`rounded-[calc(var(--radius)*0.8)] px-3 py-2 text-center text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus,#111827)] ${error.uncertain ? "bg-neutral-50 text-neutral-800" : "bg-red-50 text-red-800"}`}>
              {error.text}
            </p>
          )}
          {maxQty > 1 && (
            <div className="flex items-center justify-between gap-3">
              <span id={`upsell-qty-${block.id}`} className="text-sm font-medium">
                {L.upsellQty}
              </span>
              <div role="group" aria-labelledby={`upsell-qty-${block.id}`} className="inline-flex items-center rounded-full border border-neutral-300 bg-white">
                <button type="button" className={stepBtn} aria-label={L.upsellQtyDecrease} disabled={busy || quantity <= 1} onClick={() => setQuantity((n) => Math.max(1, n - 1))}>
                  <Minus className="h-3.5 w-3.5" aria-hidden />
                </button>
                <output aria-live="polite" className="min-w-7 text-center text-sm font-medium tabular-nums">
                  {quantity}
                </output>
                <button type="button" className={stepBtn} aria-label={L.upsellQtyIncrease} disabled={busy || quantity >= maxQty} onClick={() => setQuantity((n) => Math.min(maxQty, n + 1))}>
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                </button>
              </div>
            </div>
          )}
          <button
            type="button"
            disabled={busy}
            onClick={() => answer(true)}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--btn-radius)] bg-[image:var(--accent-bg)] px-5 py-3.5 font-semibold text-[var(--accent-fg)] shadow-[var(--btn-shadow)] transition hover:brightness-110 disabled:opacity-60"
          >
            {busy && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" aria-hidden />}
            {p.buttonText} · {total}
          </button>
          <button type="button" disabled={busy} onClick={() => answer(false)} className="min-h-11 w-full py-2 text-sm text-[var(--muted)] underline underline-offset-2">
            {p.declineText}
          </button>
          <p className="text-center text-[11px] text-neutral-600">{L.upsellNoCard}</p>
          {minutesLeft != null && (
            <p className="flex items-center justify-center gap-1 text-center text-[11px] text-neutral-600">
              <Timer className="h-3 w-3 shrink-0" aria-hidden />
              {L.offerValidFor(minutesLeft)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Post-purchase survey (thank-you page): "How did you hear about us?", one tap, stored on the order. */
function Survey({ block, ctx }: { block: BlockOf<"survey">; ctx: ContentContext }) {
  const L = ctx.labels;
  const live = ctx.survey && !ctx.preview ? ctx.survey : null;
  const [done, setDone] = useState(!!live?.answered);
  const [other, setOther] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uid = `survey-${block.id}`;
  const options = block.props.options;

  async function send(answer: string) {
    setError(null);
    if (!live) {
      setDone(true); // builder / preview: nothing is stored
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/public/sessions/${live.sessionId}/survey`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      });
      const body = await res.json().catch(() => null);
      // Already answered (another tab): the thanks are just as true.
      if (res.ok || body?.code === "survey_answered") setDone(true);
      else setError(body?.code === "survey_invalid" ? errorText(L, body) : L.surveyError);
    } catch {
      setError(L.surveyError);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <p role="status" className="flex items-center justify-center gap-2 rounded-[var(--radius)] border border-neutral-200 bg-white p-4 text-sm font-medium">
        <Check className="h-4 w-4 text-emerald-700" strokeWidth={2.5} aria-hidden />
        {L.surveyThanks}
      </p>
    );
  }
  return (
    <section aria-labelledby={`${uid}-q`} className="rounded-[var(--radius)] border border-neutral-200 bg-white p-4">
      <h2 id={`${uid}-q`} className="mb-3 font-[family-name:var(--heading-font)] text-base font-semibold">
        {block.props.question || L.surveyQuestion}
      </h2>
      <div className="flex flex-wrap gap-2" role="group" aria-labelledby={`${uid}-q`}>
        {options.map((key) => (
          <button
            key={key}
            type="button"
            disabled={busy}
            aria-expanded={key === "other" ? other : undefined}
            aria-controls={key === "other" ? `${uid}-other` : undefined}
            onClick={() => (key === "other" ? setOther((v) => !v) : send(key))}
            className={`min-h-11 rounded-full border px-4 py-2 text-sm font-medium transition hover:border-[var(--accent)] disabled:opacity-60 ${key === "other" && other ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_8%,white)]" : "border-neutral-300 bg-white"}`}
          >
            {L.surveyOptions[key] ?? key}
          </button>
        ))}
      </div>
      {other && (
        <form
          id={`${uid}-other`}
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            void send(t ? `other:${t}` : "other");
          }}
        >
          <label htmlFor={`${uid}-text`} className="sr-only">
            {L.surveyOtherLabel}
          </label>
          <input
            id={`${uid}-text`}
            value={text}
            maxLength={SURVEY_OTHER_MAX}
            placeholder={L.surveyOtherLabel}
            onChange={(e) => setText(e.target.value)}
            className="min-h-11 min-w-0 flex-1 rounded-[var(--radius)] border border-[var(--field-border,#8f8f99)] bg-white px-3 text-sm"
          />
          <button
            type="submit"
            disabled={busy}
            className="min-h-11 shrink-0 rounded-[var(--btn-radius)] bg-[image:var(--accent-bg)] px-4 text-sm font-semibold text-[var(--accent-fg)] disabled:opacity-60"
          >
            {L.surveySend}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
