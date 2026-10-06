"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import {
  COUNTDOWN_DURATION,
  ICON_KEYS,
  LIST_LIMITS,
  MAX_RECOMMENDATIONS,
  OFFER_LIMITS,
  TEXT_LIMITS,
  MEDIA_PATH_RE,
  SURVEY_KEYS,
  MESSAGE_LIMITS,
  offerArmSchema,
  upsellSellable,
  variantGidOf,
  type Block,
  type BlockOf,
  type BlockStyle,
  type IconKey,
  type OfferArmProps,
  type SurveyKey,
} from "@/lib/layout";
import { AlertTriangle, Check, FolderOpen, ImageOff, Images, Star, Trash2, Upload, X } from "lucide-react";
import { formatBytes, UPLOAD_ACCEPT, useMediaLibrary, type UploadedMedia } from "./media";
import { BlockIcon, ICON_LABELS, isIconKey } from "@/components/icons";
import type { Lang } from "@/components/checkout/i18n";
import { COUNTDOWN_EXAMPLE_KEYS, DEFAULT_TEXTS, emptyTextDefault, remapListTranslations } from "@/components/checkout/localize";
import { NEVER_OFFERED_LOGOS_WARNING, neverOfferedLogos } from "@/lib/sample-content";
import { EditorAccordion, UpsellQuantity, UpsellRules } from "./UpsellRules";
import { ReviewsImport } from "./ReviewsImport";
import { MANUAL_REVIEW_NOTE, ReviewsList } from "./ReviewsList";
import { ReviewsPaste } from "./ReviewsPaste";
import { ProductPicker, type PickedVariant } from "@/components/dashboard/ProductPicker";
import { centsToField, currencySymbol, parseMoney } from "@/components/dashboard/money";
import { decimalRangeLabel, formatCount, formatDecimalField, MAX_REVIEW_COUNT, parseCount, parseDecimal, RATING_MIN_SCORE, ratingScoreWarning } from "./decimal";

/* ------------------------------------------------------------------ */
/* Small controlled inputs                                             */
/* ------------------------------------------------------------------ */

const input =
  "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-indigo-500 focus-visible:outline-solid";
const ring = "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-500 focus-visible:outline-solid";

/** The payment-logos picker's chips: display names, not the stored keys. */
const PAYMENT_LOGO_NAMES: Record<"visa" | "mastercard" | "amex" | "applepay" | "gpay" | "sepa" | "crypto", string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  applepay: "Apple Pay",
  gpay: "Google Pay",
  sepa: "SEPA",
  crypto: "Crypto",
};

/** An image the merchant can pick instead of pasting a URL (product photos, logo…). */
export type ImageSource = { url: string; label: string };

export function F({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-zinc-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-600">{hint}</span>}
    </label>
  );
}

/** Like F, for composite controls (a <label> must wrap a single control). */
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div role="group" aria-label={label}>
      <span className="mb-1 block text-xs font-medium text-zinc-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-zinc-600">{hint}</span>}
    </div>
  );
}

/** `label`: accessible name when the field has no visible <label> (list items). */
export function Text({
  value,
  onChange,
  placeholder,
  label,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  /** The schema's cap: the field stops there (a counter shows near the end) instead of a failed save. */
  maxLength?: number;
}) {
  return (
    <>
      <input className={input} value={value} placeholder={placeholder} aria-label={label} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
      <LengthHint length={value.length} max={maxLength} />
    </>
  );
}

/**
 * Characters left, shown only near the cap (last 10 %): the merchant sees the limit coming instead
 * of a field that stops without a word. Exported for tests.
 */
export function lengthHintText(length: number, max: number | undefined): string | null {
  if (!max || length < Math.floor(max * 0.9)) return null;
  const left = Math.max(0, max - length);
  return left === 0 ? `Maximum atteint (${max} caractères)` : `${length} / ${max} caractères — encore ${left}`;
}

function LengthHint({ length, max }: { length: number; max?: number }) {
  const text = lengthHintText(length, max);
  if (!text) return null;
  return (
    <span className={`mt-0.5 block text-[11px] ${length >= (max ?? 0) ? "text-amber-700" : "text-zinc-600"}`}>
      {text}
    </span>
  );
}

// An uploaded image (/api/public/media/<id>, see ./media) is the one relative address accepted.
const isHttpUrl = (v: string) => (/^https?:\/\/[^\s]+\.[^\s]+/i.test(v) && URL.canParse(v)) || MEDIA_PATH_RE.test(v);
// Images: https only (an http image is blocked as mixed content on the https checkout).
const isHttpsUrl = (v: string) => (/^https:\/\/[^\s]+\.[^\s]+/i.test(v) && URL.canParse(v)) || MEDIA_PATH_RE.test(v);

/**
 * URL field that only commits a value the checkout accepts (http(s) or empty), so one
 * half-typed address can never make the whole design fail to save.
 */
export function UrlText({
  value,
  onChange,
  placeholder,
  label,
  httpsOnly = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  label?: string;
  /** Image fields: http:// refused (mixed content). */
  httpsOnly?: boolean;
}) {
  const valid = httpsOnly ? isHttpsUrl : isHttpUrl;
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  const invalid = draft.trim() !== "" && !valid(draft.trim());
  const insecure = invalid && httpsOnly && /^http:\/\//i.test(draft.trim());
  return (
    <div>
      <input
        className={`${input} ${invalid ? "border-amber-400 focus:border-amber-500" : ""}`}
        value={draft}
        placeholder={placeholder ?? "https://…"}
        aria-label={label}
        inputMode="url"
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          if (v.trim() === "" || valid(v.trim())) onChange(v.trim());
        }}
        onBlur={() => {
          if (invalid) setDraft(value);
        }}
      />
      {invalid && (
        <p className="mt-1 text-[11px] text-amber-700">
          {insecure ? "Lien http:// non sécurisé : utilisez l'adresse en https:// (sinon l'image est bloquée sur le checkout)." : "Adresse complète attendue, commençant par https://"}
        </p>
      )}
    </div>
  );
}

export function Area({ value, onChange, rows = 3, maxLength, placeholder }: { value: string; onChange: (v: string) => void; rows?: number; maxLength?: number; placeholder?: string }) {
  return (
    <>
      <textarea className={input} rows={rows} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      <LengthHint length={value.length} max={maxLength} />
    </>
  );
}

export function Num({ value, onChange, min, max, step = 1 }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <input
      type="number"
      className={input}
      value={Number.isFinite(value) ? value : 0}
      min={min}
      max={max}
      step={step}
      onChange={(e) => {
        const n = Number(e.target.value);
        onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, Number.isFinite(n) ? n : 0)));
      }}
    />
  );
}

/**
 * Decimal field typed as text ("4,7" or "4.7"): a French comma is never lost to
 * <input type="number">, valid values reach the preview while typing, and a value outside
 * [min, max] shows an inline error instead of being silently capped. On blur the field is
 * normalised to the committed value ("4.70" → "4,7").
 */
export function DecimalInput({
  value,
  onChange,
  min,
  max,
  placeholder,
  suffix,
  optional = false,
  describedBy,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  placeholder?: string;
  suffix?: string;
  /** Empty commits null; otherwise an emptied field falls back to the last value on blur. */
  optional?: boolean;
  describedBy?: string;
}) {
  const errId = useId();
  const [draft, setDraft] = useState(() => formatDecimalField(value));
  const [seen, setSeen] = useState(value);
  const [touched, setTouched] = useState(false);
  if (value !== seen) {
    setSeen(value);
    setDraft(formatDecimalField(value));
  }
  const parsed = parseDecimal(draft, { min, max });
  const error =
    parsed.kind === "range"
      ? `Valeur ${decimalRangeLabel(min, max)} attendue.`
      : parsed.kind === "invalid" && touched
        ? "Nombre attendu, par ex. 4,7."
        : parsed.kind === "empty" && !optional && touched
          ? "Valeur requise."
          : null;
  const commit = (next: number | null) => {
    setSeen(next);
    onChange(next);
  };
  return (
    <span className="block">
      <span className="relative block">
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          className={`${input} tabular-nums ${suffix ? "pr-7" : ""} ${error ? "border-amber-400 focus:border-amber-500" : ""}`}
          value={draft}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={[error ? errId : null, describedBy].filter(Boolean).join(" ") || undefined}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            const p = parseDecimal(raw, { min, max });
            if (p.kind === "ok") commit(p.value);
            else if (p.kind === "empty" && optional) commit(null);
          }}
          onBlur={() => {
            setTouched(true);
            const p = parseDecimal(draft, { min, max });
            if (p.kind === "ok") setDraft(formatDecimalField(p.value));
            else if (p.kind === "empty" && !optional) setDraft(formatDecimalField(value));
          }}
        />
        {suffix && (
          <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm text-zinc-500" aria-hidden>
            {suffix}
          </span>
        )}
      </span>
      {error && (
        <span id={errId} role="alert" className="mt-1 block text-[11px] text-amber-700">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * Whole number typed as text so "1 250" (grouped by spaces, as French merchants write it) is
 * accepted; letters, decimals and signs show an inline error instead of being dropped.
 * Normalised on blur ("1250" → "1 250").
 */
export function CountInput({ value, onChange, max, placeholder, label }: { value: number; onChange: (v: number) => void; max?: number; placeholder?: string; label?: string }) {
  const errId = useId();
  const [draft, setDraft] = useState(() => formatCount(value));
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(formatCount(value));
  }
  const parsed = parseCount(draft, { max });
  const error = parsed.kind === "invalid" ? "Chiffres uniquement, par ex. 1 250." : parsed.kind === "range" ? `${formatCount(max)} au maximum.` : null;
  return (
    <span className="block">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        className={`${input} tabular-nums ${error ? "border-amber-400 focus:border-amber-500" : ""}`}
        value={draft}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const p = parseCount(raw, { max });
          const next = p.kind === "ok" ? p.value : p.kind === "empty" ? 0 : null;
          if (next != null) {
            setSeen(next);
            onChange(next);
          }
        }}
        onBlur={() => {
          const p = parseCount(draft, { max });
          if (p.kind === "ok" || p.kind === "empty") setDraft(formatCount(p.kind === "ok" ? p.value : 0));
        }}
      />
      {error && (
        <span id={errId} role="alert" className="mt-1 block text-[11px] text-amber-700">
          {error}
        </span>
      )}
    </span>
  );
}

export function Pick<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <select className={input} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-md border border-zinc-300 bg-white p-0.5" role="group">
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          className={`flex-1 rounded px-2 py-1 text-xs ${ring} ${value === v ? "bg-zinc-900 font-medium text-white" : "text-zinc-700 hover:bg-zinc-100"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** "#abc" → "#aabbcc"; null when not a hex color. */
function normalizeHex(v: string): string | null {
  const t = v.trim();
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(t);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
  return `#${h.toLowerCase()}`;
}

/** Color picker + hex field. The text field is a free draft; only valid colors are committed. */
export function ColorInput({ value, onChange, allowEmpty = true }: { value: string; onChange: (v: string) => void; allowEmpty?: boolean }) {
  const [draft, setDraft] = useState(value);
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(value);
  }
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value || "#ffffff"}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-10 cursor-pointer rounded border border-zinc-300 bg-white p-0.5"
      />
      <input
        className={`${input} font-mono text-xs`}
        value={draft}
        placeholder="par défaut"
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          setDraft(v);
          const hex = normalizeHex(v);
          if (hex && hex.length === 7 && v.replace("#", "").length === 6) onChange(hex);
          else if (allowEmpty && v.trim() === "") onChange("");
        }}
        onBlur={() => {
          const hex = normalizeHex(draft);
          if (hex) onChange(hex);
          else if (!(allowEmpty && draft.trim() === "")) setDraft(value);
        }}
      />
      {allowEmpty && value && (
        <button type="button" onClick={() => onChange("")} className={`rounded text-xs text-zinc-600 underline ${ring}`}>
          effacer
        </button>
      )}
    </div>
  );
}

/** 1–5 star picker: a radiogroup (arrow keys move, Home/End jump). */
export function StarPicker({ value, onChange, label = "Note" }: { value: number; onChange: (v: number) => void; label?: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const [hover, setHover] = useState<number | null>(null);
  const current = Math.min(5, Math.max(1, Math.round(value) || 5));
  const shown = hover ?? current;
  function pick(n: number, focus = false) {
    const v = Math.min(5, Math.max(1, n));
    onChange(v);
    if (focus) refs.current[v - 1]?.focus();
  }
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex items-center gap-0.5" onMouseLeave={() => setHover(null)}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          ref={(el) => {
            refs.current[n - 1] = el;
          }}
          type="button"
          role="radio"
          aria-checked={current === n}
          aria-label={`${n} étoile${n > 1 ? "s" : ""}`}
          tabIndex={current === n ? 0 : -1}
          onMouseEnter={() => setHover(n)}
          onClick={() => pick(n)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowUp") {
              e.preventDefault();
              pick(current + 1, true);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
              e.preventDefault();
              pick(current - 1, true);
            } else if (e.key === "Home") {
              e.preventDefault();
              pick(1, true);
            } else if (e.key === "End") {
              e.preventDefault();
              pick(5, true);
            }
          }}
          className={`rounded p-0.5 transition ${ring}`}
        >
          <Star className={`h-5 w-5 ${n <= shown ? "fill-amber-400 text-amber-400" : "fill-transparent text-zinc-300"}`} />
        </button>
      ))}
      <span className="ml-1.5 text-xs text-zinc-600 tabular-nums">{current}/5</span>
    </div>
  );
}

/**
 * Image field: a live thumbnail with a load-error state, any https image link, an upload of the
 * merchant's own file (builder only, see ./media) with their gallery ("Mes images"), and, when the
 * store has images (product photos, logo, options), a one-click picker.
 */
export function ImageField({
  value,
  onChange,
  images = [],
  placeholder,
  compact = false,
}: {
  value: string;
  onChange: (v: string) => void;
  images?: ImageSource[];
  placeholder?: string;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const [open, setOpen] = useState<"store" | "mine" | null>(null);
  const [status, setStatus] = useState<{ kind: "busy" | "error" | "ok"; text: string } | null>(null);
  const pickerId = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const library = useMediaLibrary();
  const broken = !!value && failed === value;
  const size = compact ? "h-9 w-9" : "h-14 w-14";
  const choices = images.filter((im, i, all) => im.url && all.findIndex((x) => x.url === im.url) === i);
  const linkBtn = `inline-flex items-center gap-1 rounded text-xs font-medium text-indigo-700 hover:underline disabled:opacity-50 ${ring}`;

  async function onFile(file: File | undefined) {
    if (!file || !library) return;
    setStatus({ kind: "busy", text: "Envoi de l'image…" });
    const res = await library.upload(file);
    if (fileRef.current) fileRef.current.value = "";
    if (!res.ok) return setStatus({ kind: "error", text: res.message });
    onChange(res.media.url);
    setStatus({ kind: "ok", text: `Image importée (${formatBytes(res.media.size)}).` });
  }

  async function onDelete(m: UploadedMedia) {
    if (!library) return;
    const usage = await library.usage(m.id);
    if (usage?.published) {
      return setStatus({ kind: "error", text: "Image affichée sur le checkout publié : remplacez-la dans le design et publiez avant de la supprimer." });
    }
    const where = usage ? [usage.draft && "le brouillon (le champ sera vidé)", usage.versions > 0 && `${usage.versions} version(s) de l'historique (les restaurer n'afficherait plus cette image)`].filter(Boolean) : [];
    const msg = where.length ? `Cette image est encore utilisée dans ${where.join(" et ")}. La supprimer quand même ?` : "Supprimer cette image de « Mes images » ?";
    if (!window.confirm(msg)) return;
    const res = await library.remove(m.id, { versions: (usage?.versions ?? 0) > 0 });
    if (!res.ok) return setStatus({ kind: "error", text: res.message });
    // In the builder every draft field using it is emptied by the provider (BuilderApp).
    if (!library.clearsFields && value === m.url) onChange("");
    setStatus({ kind: "ok", text: "Image supprimée." });
  }

  const mine = library?.items ?? null;
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <span className={`flex ${size} shrink-0 items-center justify-center overflow-hidden rounded-md border border-zinc-200 bg-[repeating-conic-gradient(#f4f4f5_0_25%,#fff_0_50%)] bg-[length:12px_12px]`}>
          {value && !broken ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="h-full w-full object-contain" onError={() => setFailed(value)} onLoad={() => {
                if (failed === value) setFailed(null);
              }} />
          ) : value ? (
            <ImageOff className="h-4 w-4 text-amber-600" aria-hidden />
          ) : (
            <Images className="h-4 w-4 text-zinc-400" aria-hidden />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <UrlText httpsOnly value={value} placeholder={placeholder ?? "Coller un lien d'image (https://…)"} label={placeholder ?? "Lien de l'image"} onChange={onChange} />
          {broken && <p className="mt-1 text-[11px] text-amber-700">Image introuvable à cette adresse : vérifiez le lien.</p>}
          {!compact && !value && <p className="mt-1 text-[11px] text-zinc-600">Tout lien d&apos;image en https:// fonctionne (pas http://), ou importez votre fichier.</p>}
        </div>
      </div>
      {(library || choices.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {library && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept={UPLOAD_ACCEPT}
                className="sr-only"
                tabIndex={-1}
                aria-hidden
                onChange={(e) => void onFile(e.target.files?.[0])}
              />
              <button type="button" className={linkBtn} disabled={status?.kind === "busy"} onClick={() => fileRef.current?.click()}>
                <Upload className="h-3.5 w-3.5" aria-hidden /> Importer une image
              </button>
              <button
                type="button"
                aria-expanded={open === "mine"}
                aria-controls={pickerId}
                className={linkBtn}
                onClick={() => {
                  if (open !== "mine") library.load();
                  setOpen((o) => (o === "mine" ? null : "mine"));
                }}
              >
                <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Mes images{mine && mine.length > 0 ? ` (${mine.length})` : ""}
              </button>
            </>
          )}
          {choices.length > 0 && (
            <button type="button" aria-expanded={open === "store"} aria-controls={pickerId} onClick={() => setOpen((o) => (o === "store" ? null : "store"))} className={linkBtn}>
              <Images className="h-3.5 w-3.5" aria-hidden /> {compact || library ? "Images de la boutique" : "Choisir parmi les images de la boutique"}
            </button>
          )}
        </div>
      )}
      <p role="status" aria-live="polite" className={`text-[11px] empty:hidden ${status?.kind === "error" ? "text-amber-700" : "text-zinc-600"}`}>
        {status?.text ?? ""}
      </p>
      {open === "store" && (
        <div id={pickerId} className="grid grid-cols-5 gap-1.5">
          {choices.slice(0, 15).map((im) => (
            <button
              key={im.url}
              type="button"
              title={im.label}
              aria-label={im.label}
              aria-pressed={value === im.url}
              onClick={() => {
                onChange(im.url);
                setOpen(null);
              }}
              className={`relative aspect-square overflow-hidden rounded-md border bg-white ${ring} ${value === im.url ? "border-indigo-500 ring-2 ring-indigo-500/30" : "border-zinc-200 hover:border-zinc-400"}`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={im.url} alt="" className="h-full w-full object-cover" />
              {value === im.url && (
                <span className="absolute top-0.5 right-0.5 rounded-full bg-indigo-600 p-0.5 text-white">
                  <Check className="h-2.5 w-2.5" />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      {open === "mine" && library && (
        <div id={pickerId}>
          {mine === null ? (
            <p className="text-[11px] text-zinc-600">Chargement…</p>
          ) : library.loadError ? (
            <p role="alert" className="text-[11px] text-red-700">
              {library.loadError}
            </p>
          ) : mine.length === 0 ? (
            <p className="text-[11px] text-zinc-600">Aucune image importée pour l&apos;instant.</p>
          ) : (
            <ul className="grid grid-cols-4 gap-1.5" aria-label="Mes images">
              {mine.map((m, i) => (
                <li key={m.id} className="relative">
                  <button
                    type="button"
                    aria-label={`Utiliser l'image ${i + 1}${m.width && m.height ? ` (${m.width}×${m.height})` : ""}`}
                    aria-pressed={value === m.url}
                    onClick={() => {
                      onChange(m.url);
                      setOpen(null);
                    }}
                    className={`relative block aspect-square w-full overflow-hidden rounded-md border bg-[repeating-conic-gradient(#f4f4f5_0_25%,#fff_0_50%)] bg-[length:12px_12px] ${ring} ${value === m.url ? "border-indigo-500 ring-2 ring-indigo-500/30" : "border-zinc-200 hover:border-zinc-400"}`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={m.url} alt="" className="h-full w-full object-contain" loading="lazy" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Supprimer l'image ${i + 1}`}
                    title="Supprimer"
                    onClick={() => void onDelete(m)}
                    className={`absolute top-0.5 right-0.5 rounded-full bg-white/95 p-0.5 text-zinc-700 shadow hover:text-red-700 ${ring}`}
                  >
                    <Trash2 className="h-3 w-3" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Grid of Lucide icons (replaces the old emoji inputs). */
export function IconPicker({ value, onChange }: { value: string; onChange: (v: IconKey) => void }) {
  return (
    <div className="grid grid-cols-10 gap-1">
      {ICON_KEYS.map((k) => (
        <button
          key={k}
          type="button"
          title={ICON_LABELS[k]}
          aria-label={ICON_LABELS[k]}
          aria-pressed={value === k}
          onClick={() => onChange(k)}
          className={`flex aspect-square items-center justify-center rounded-md border transition ${ring} ${
            value === k ? "border-indigo-400 bg-indigo-50 text-indigo-600" : "border-zinc-200 bg-white text-zinc-500 hover:border-zinc-300 hover:text-zinc-800"
          }`}
        >
          <BlockIcon value={k} size={14} />
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs font-medium text-zinc-700">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-3.5 w-3.5 accent-zinc-900" />
      {label}
    </label>
  );
}

function ListEditor<T>({
  items,
  onChange,
  render,
  create,
  addLabel,
  max,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  render: (item: T, set: (v: T) => void, i: number) => ReactNode;
  create: () => T;
  addLabel: string;
  max: number;
}) {
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="relative space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-2.5 pr-8">
          {render(it, (v) => onChange(items.map((x, j) => (j === i ? v : x))), i)}
          <button
            type="button"
            aria-label="Retirer"
            onClick={() => onChange(items.filter((_, j) => j !== i))}
            className={`absolute top-2 right-2 rounded text-zinc-500 hover:text-red-600 ${ring}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {items.length < max && (
        <button type="button" onClick={() => onChange([...items, create()])} className={`rounded text-xs font-medium text-zinc-900 underline ${ring}`}>
          + {addLabel}
        </button>
      )}
      {listLimitText(items.length, max) && <p className={`text-[11px] ${items.length >= max ? "text-amber-700" : "text-zinc-600"}`}>{listLimitText(items.length, max)}</p>}
    </div>
  );
}

/**
 * Items left in a list block, shown near its cap (from 80 %) instead of a save failing later.
 * Exported for tests.
 */
export function listLimitText(count: number, max: number): string | null {
  if (count < Math.floor(max * 0.8)) return null;
  const left = Math.max(0, max - count);
  return left === 0 ? `Maximum atteint : ${max} éléments` : `${count} / ${max} — encore ${left} possible${left > 1 ? "s" : ""}`;
}

/* ------------------------------------------------------------------ */
/* Content fields per block type                                       */
/* ------------------------------------------------------------------ */

/** Page context some editors need (other blocks, store, known product names). */
/**
 * Amount field (same behaviour as the dashboard's MoneyInput, for controlled builder state):
 * "12,5" or "12.50" accepted, tidied to "12,50" on blur, currency sign inside the field.
 * The value is in currency units (19.9 = 19,90 €); `optional` allows an empty field.
 */
export function PriceInput({
  value,
  onChange,
  optional = false,
  placeholder,
  invalid = false,
  currency = "EUR",
  max = 1_000_000,
  id,
}: {
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  optional?: boolean;
  placeholder?: string;
  invalid?: boolean;
  currency?: string;
  max?: number;
  id?: string;
}) {
  const show = (v: number | undefined) => (v == null || !Number.isFinite(v) ? "" : centsToField(Math.round(v * 100)));
  const [draft, setDraft] = useState(() => show(value));
  // Last value this field sent: its own echo must not reformat what is being typed.
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    setDraft(show(value));
  }
  const cents = parseMoney(draft);
  const bad = invalid || (draft.trim() !== "" && (cents == null || cents / 100 > max));
  return (
    <div className="relative">
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className={`${input} pr-8 tabular-nums ${bad ? "border-amber-400 focus:border-amber-500" : ""}`}
        value={draft}
        placeholder={placeholder ?? (optional ? "Aucun" : "0,00")}
        aria-invalid={bad || undefined}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const c = parseMoney(raw);
          const next = raw.trim() === "" ? (optional ? undefined : 0) : c != null && c / 100 <= max ? c / 100 : null;
          if (next === null) return;
          setSeen(next);
          onChange(next);
        }}
        onBlur={() => setDraft(show(value))}
      />
      <span className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-sm text-zinc-500" aria-hidden>
        {currencySymbol(currency)}
      </span>
    </div>
  );
}

/** A checkout A/B test runs on this element: a price edited now reaches no visitor before it ends. */
export function RunningTestNotice({ name }: { name: string }) {
  return (
    <p role="note" className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
      Test A/B « {name} » en cours sur ce prix : les visiteurs du test gardent le prix A de son lancement ou le prix B. Une modification ici ne
      s&apos;applique qu&apos;après la fin du test (Analytics › Tests A/B).
    </p>
  );
}

export type EditorContext = {
  blocks: Block[];
  storeId: string | null;
  productTitles?: Record<string, string>;
  currency?: string;
  /** Store language: empty-field placeholders show the built-in wording in it. */
  lang?: Lang;
  /** A checkout A/B test runs on the shipping protection price (its name). */
  protectionTest?: string | null;
  /** Changes a block as it is in the layout when applied (by id): for results landing after an await. */
  updateBlock?: (id: string, fn: (b: Block) => Block) => void;
};

export function BlockContentEditor({
  block,
  onChange,
  images = [],
  context,
}: {
  block: Block;
  onChange: (b: Block) => void;
  images?: ImageSource[];
  context?: EditorContext;
}) {
  function props<T extends Block["type"]>(b: BlockOf<T>, patch: Partial<BlockOf<T>["props"]>) {
    // Translations stored by position ("items.2.text") follow their item when a list changes.
    onChange(remapListTranslations(b as Block, { ...b, props: { ...b.props, ...patch } } as Block));
  }

  switch (block.type) {
    case "express":
      // Edited in the builder's block panel (its switch also drives theme.expressCheckout).
      return null;
    case "contact":
    case "delivery":
    case "shipping_method":
    case "payment":
    case "order_addons":
    case "ty_confirmation":
    case "ty_details":
    case "ty_summary":
      return (
        <div className="space-y-3">
          <F
            label="Titre"
            hint={
              block.type === "ty_confirmation"
                ? "Vide = « Merci, {prénom} ! » traduit. {name} insère le prénom du client."
                : "Vide = titre traduit par défaut. Astuce : double-cliquez le titre dans l'aperçu."
            }
          >
            <Text
              value={block.props.title}
              placeholder={emptyTextDefault(block.type, "title", context?.lang ?? "fr") ?? undefined}
              maxLength={TEXT_LIMITS.title}
              onChange={(title) => props(block, { title })}
            />
          </F>
          {block.type === "shipping_method" && <p className="text-[11px] text-zinc-600">Les tarifs viennent de la page Livraison.</p>}
          {block.type === "payment" && <p className="text-[11px] text-zinc-600">Le formulaire de paiement Whop (carte, PayPal, etc.) s&apos;affiche ici.</p>}
          {block.type === "ty_details" && <p className="text-[11px] text-zinc-600">Remplace l&apos;intitulé « Livraison à ». La livraison estimée et le moyen de paiement suivent.</p>}
        </div>
      );
    case "text":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.heading} placeholder="Votre titre" maxLength={TEXT_LIMITS.title} onChange={(heading) => props(block, { heading })} />
          </F>
          <F label="Texte">
            <Area value={block.props.body} rows={5} placeholder="Votre texte (vide = bloc non affiché)" maxLength={TEXT_LIMITS.body} onChange={(body) => props(block, { body })} />
          </F>
        </div>
      );
    case "image":
      return (
        <div className="space-y-3">
          <Field label="Image">
            <ImageField value={block.props.url} images={images} onChange={(url) => props(block, { url })} />
          </Field>
          <F label="Texte alternatif">
            <Text value={block.props.alt} maxLength={500} onChange={(alt) => props(block, { alt })} />
          </F>
          <F label="Taille">
            <Segmented
              value={block.props.size}
              options={[
                ["sm", "S"],
                ["md", "M"],
                ["lg", "L"],
                ["full", "100 %"],
              ]}
              onChange={(size) => props(block, { size })}
            />
          </F>
        </div>
      );
    case "testimonial":
      return (
        <div className="space-y-3">
          <F label="Citation">
            <Area value={block.props.quote} rows={4} maxLength={TEXT_LIMITS.long} onChange={(quote) => props(block, { quote })} />
          </F>
          <F label="Auteur" hint="Utilisez de vrais avis clients : les faux avis sont interdits (directive Omnibus).">
            <Text value={block.props.author} maxLength={TEXT_LIMITS.label} onChange={(author) => props(block, { author })} />
          </F>
          <Field label="Photo (facultatif)">
            <ImageField value={block.props.photoUrl} compact onChange={(photoUrl) => props(block, { photoUrl })} />
          </Field>
          <Field label="Étoiles">
            <StarPicker value={block.props.stars} label="Étoiles du témoignage" onChange={(stars) => props(block, { stars })} />
          </Field>
        </div>
      );
    case "rating": {
      const hintId = `rating-hint-${block.id}`;
      const warnId = `rating-warn-${block.id}`;
      return (
        <div className="grid grid-cols-2 gap-3">
          <F label="Note /5">
            {/* Empty until the merchant types their real score (no invented default). */}
            <DecimalInput
              value={block.props.score ?? null}
              min={RATING_MIN_SCORE}
              max={5}
              optional
              placeholder="ex. 4,7"
              suffix="/5"
              describedBy={block.props.score == null ? hintId : ratingScoreWarning(block.props.score) ? warnId : undefined}
              onChange={(score) => props(block, score == null ? { score: null, scoreSet: false } : { score, scoreSet: true })}
            />
          </F>
          <F label="Nombre d'avis">
            <CountInput value={block.props.count} max={MAX_REVIEW_COUNT} placeholder="ex. 1 250" onChange={(count) => props(block, { count })} />
          </F>
          {block.props.score == null && (
            <p id={hintId} className="col-span-2 -mt-1 text-[11px] text-zinc-600">
              À compléter : le bloc reste masqué en ligne tant qu&apos;aucune note n&apos;est saisie.
            </p>
          )}
          {ratingScoreWarning(block.props.score) && (
            <p id={warnId} className="col-span-2 -mt-1 flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900 ring-1 ring-amber-600/15">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {ratingScoreWarning(block.props.score)}
            </p>
          )}
          <div className="col-span-2">
            <F label="Libellé" hint="Reprenez la note réelle de votre outil d'avis (Judge.me, Loox, Trustpilot…).">
              <Text value={block.props.label} maxLength={TEXT_LIMITS.title} onChange={(label) => props(block, { label })} />
            </F>
          </div>
        </div>
      );
    }
    case "trust_badges":
      return (
        <ListEditor
          items={block.props.badges}
          max={LIST_LIMITS.trust_badges}
          addLabel="Ajouter un badge"
          create={() => ({ label: "Nouveau badge", iconUrl: "" })}
          onChange={(badges) => props(block, { badges })}
          render={(b, set) => (
            <>
              <Text value={b.label} label="Libellé du badge" maxLength={TEXT_LIMITS.label} onChange={(label) => set({ ...b, label })} />
              <ImageField value={b.iconUrl} compact placeholder="Icône (URL, facultatif)" onChange={(iconUrl) => set({ ...b, iconUrl })} />
            </>
          )}
        />
      );
    case "guarantee":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} maxLength={TEXT_LIMITS.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Texte">
            <Area value={block.props.text} rows={4} maxLength={TEXT_LIMITS.long} onChange={(text) => props(block, { text })} />
          </F>
        </div>
      );
    case "faq":
      return (
        <ListEditor
          items={block.props.items}
          max={LIST_LIMITS.faq}
          addLabel="Ajouter une question"
          create={() => ({ q: "Nouvelle question ?", a: "Réponse." })}
          onChange={(items) => props(block, { items })}
          render={(it, set) => (
            <>
              <Text label="Question" value={it.q} maxLength={TEXT_LIMITS.title} onChange={(q) => set({ ...it, q })} />
              <Area value={it.a} rows={2} maxLength={TEXT_LIMITS.long} onChange={(a) => set({ ...it, a })} />
            </>
          )}
        />
      );
    case "value_props":
      return (
        <ListEditor
          items={block.props.items}
          max={LIST_LIMITS.value_props}
          addLabel="Ajouter un argument"
          create={() => ({ icon: "star", label: "Argument" })}
          onChange={(items) => props(block, { items })}
          render={(it, set) => (
            <>
              <Text label="Libellé" value={it.label} maxLength={TEXT_LIMITS.label} onChange={(label) => set({ ...it, label })} />
              <IconPicker value={isIconKey(it.icon) ? it.icon : ""} onChange={(icon) => set({ ...it, icon })} />
            </>
          )}
        />
      );
    case "payment_icons": {
      // SEPA / crypto are never offered on this checkout: only listed (to remove them) when selected.
      const never = neverOfferedLogos(block.props.methods);
      // Thank-you page (no Payment section): no wallet is offered there, card brands only.
      const thankYouLogos = !!context && !context.blocks.some((b) => b.type === "payment");
      const all = (["visa", "mastercard", "amex", "applepay", "gpay", "sepa", "crypto"] as const).filter((m) => (m !== "sepa" && m !== "crypto") || never.includes(m));
      return (
        <div className="space-y-3">
          <F
            label="Libellé (facultatif)"
            hint="Visible seulement sur la page de remerciement ; sur le checkout, il nomme les logos pour les lecteurs d'écran."
          >
            <Text value={block.props.label} maxLength={TEXT_LIMITS.label} onChange={(label) => props(block, { label })} />
          </F>
          {thankYouLogos ? (
            <p data-hint="thank-you-logos" className="text-[11px] leading-relaxed text-zinc-600">
              Apple Pay / Google Pay ne s&apos;affichent pas sur la page de remerciement (aucun paiement n&apos;y est proposé) : seuls les logos de cartes y
              apparaissent. Les autres sont grisés dans l&apos;aperçu.
            </p>
          ) : (
            <p className="text-[11px] leading-relaxed text-zinc-600">
              Sur le checkout, ces logos s&apos;affichent une seule fois, à côté du titre « Paiement », et seulement ceux que l&apos;acheteur peut vraiment utiliser :
              Apple Pay / Google Pay uniquement quand leur bouton s&apos;est réellement affiché sur l&apos;appareil de l&apos;acheteur (jamais avec un point relais).
            </p>
          )}
          {never.length > 0 && (
            <p role="note" className="flex items-start gap-1.5 rounded-md bg-amber-50 px-2 py-1.5 text-[11px] leading-snug text-amber-900 ring-1 ring-amber-600/15">
              <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
              {NEVER_OFFERED_LOGOS_WARNING}.
            </p>
          )}
          <div className="flex flex-wrap gap-1.5">
            {all.map((m) => {
              const on = block.props.methods.includes(m);
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => props(block, { methods: on ? block.props.methods.filter((x) => x !== m) : [...block.props.methods, m] })}
                  aria-pressed={on}
                  className={`rounded-full border px-2.5 py-1 text-xs ${ring} ${on ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-zinc-600"}`}
                >
                  {PAYMENT_LOGO_NAMES[m]}
                </button>
              );
            })}
          </div>
        </div>
      );
    }
    case "announcement":
      return (
        <F label="Texte de l'annonce">
          <Area value={block.props.text} rows={2} maxLength={TEXT_LIMITS.text} onChange={(text) => props(block, { text })} />
        </F>
      );
    case "countdown":
      return <CountdownEditor block={block} onChange={(patch) => props(block, patch)} />;
    case "low_stock":
      return (
        <div className="space-y-3">
          <F label="Message" hint="{n} = quantité restante réelle (inventaire Shopify)">
            <Text value={block.props.message} maxLength={500} onChange={(message) => props(block, { message })} />
          </F>
          <F label="Afficher quand le stock est ≤">
            <Num value={block.props.threshold} min={1} max={100} onChange={(threshold) => props(block, { threshold })} />
          </F>
        </div>
      );
    case "why_us":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} maxLength={TEXT_LIMITS.title} onChange={(title) => props(block, { title })} />
          </F>
          <ListEditor
            items={block.props.rows}
            max={LIST_LIMITS.why_us}
            addLabel="Ajouter une ligne"
            // A new row starts empty (never « Titre » / « Texte » on a live page): blank rows are not shown.
            create={() => ({ icon: "check" as const, title: "", text: "" })}
            onChange={(rows) => props(block, { rows })}
            render={(r, set) => (
              <>
                <IconPicker value={r.icon} onChange={(icon) => set({ ...r, icon })} />
                <Text label="Titre" value={r.title} placeholder="Titre de la ligne" maxLength={TEXT_LIMITS.label} onChange={(title) => set({ ...r, title })} />
                <Text value={r.text} placeholder="Texte (facultatif)" maxLength={TEXT_LIMITS.text} onChange={(text) => set({ ...r, text })} />
              </>
            )}
          />
        </div>
      );
    case "free_shipping_bar":
      return (
        <div className="space-y-3">
          <F label="Message" hint="{amount} = montant restant">
            <Text value={block.props.message} maxLength={500} onChange={(message) => props(block, { message })} />
          </F>
          <F label="Message une fois atteint">
            <Text value={block.props.success} maxLength={500} onChange={(success) => props(block, { success })} />
          </F>
          <F label="Seuil" hint="0 = le seuil « Offert dès » de vos tarifs de livraison">
            <PriceInput value={block.props.threshold} max={100000} currency={context?.currency} onChange={(threshold) => props(block, { threshold: threshold ?? 0 })} />
          </F>
        </div>
      );
    case "delivery_estimate":
      return (
        <div className="space-y-3">
          <F label="Libellé">
            <Text value={block.props.label} maxLength={TEXT_LIMITS.title} onChange={(label) => props(block, { label })} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Délai min (jours)">
              <Num value={block.props.minDays} min={0} max={60} onChange={(minDays) => props(block, { minDays })} />
            </F>
            <F label="Délai max (jours)">
              <Num value={block.props.maxDays} min={0} max={90} onChange={(maxDays) => props(block, { maxDays })} />
            </F>
          </div>
          <Toggle label="Jours ouvrés uniquement (hors week-end)" checked={block.props.businessDays} onChange={(businessDays) => props(block, { businessDays })} />
          <Toggle label="Afficher la frise Commande → Livraison" checked={block.props.showTimeline} onChange={(showTimeline) => props(block, { showTimeline })} />
        </div>
      );
    case "reviews":
      return (
        <FetchLock>
          {(setFetching) => (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Affichage" hint="Auto : un avis à la fois sur mobile, les 3 premiers en liste sur grand écran.">
            <Segmented
              value={block.props.layout}
              options={[
                ["auto", "Auto"],
                ["carousel", "Carrousel"],
                ["stack", "Liste"],
              ]}
              onChange={(layout) => props(block, { layout })}
            />
          </F>
          <ReviewsImport
            block={block}
            storeId={context?.storeId ?? null}
            onChange={(patch) => props(block, patch)}
            onFetching={setFetching}
            updateBlockProps={
              context?.updateBlock
                ? (id, patch) => context.updateBlock?.(id, (b) => (b.type === "reviews" ? remapListTranslations(b, { ...b, props: { ...b.props, ...patch } } as Block) : b))
                : undefined
            }
          />
          <ReviewsPaste items={block.props.items} onApply={(items) => props(block, { items })} />
          <p className="text-[11px] text-zinc-600">
            Utilisez uniquement de vrais avis clients : les faux avis sont interdits (directive Omnibus). Vous pouvez aussi en saisir ou en coller à la main.{" "}
            {MANUAL_REVIEW_NOTE}
          </p>
          <ReviewsList items={block.props.items} images={images} onChange={(items) => props(block, { items })} />
        </div>
          )}
        </FetchLock>
      );
    case "comparison":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} maxLength={TEXT_LIMITS.title} onChange={(title) => props(block, { title })} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Colonne « nous »">
              <Text value={block.props.usLabel} maxLength={80} onChange={(usLabel) => props(block, { usLabel })} />
            </F>
            <F label="Colonne « eux »">
              <Text value={block.props.themLabel} maxLength={80} onChange={(themLabel) => props(block, { themLabel })} />
            </F>
          </div>
          <ListEditor
            items={block.props.rows}
            max={LIST_LIMITS.comparison}
            addLabel="Ajouter une ligne"
            create={() => ({ label: "Critère", us: true, them: false })}
            onChange={(rows) => props(block, { rows })}
            render={(r, set) => (
              <>
                <Text label="Critère comparé" value={r.label} maxLength={TEXT_LIMITS.label} onChange={(label) => set({ ...r, label })} />
                <div className="flex gap-4">
                  <Toggle label={block.props.usLabel || "Nous"} checked={r.us} onChange={(us) => set({ ...r, us })} />
                  <Toggle label={block.props.themLabel || "Eux"} checked={r.them} onChange={(them) => set({ ...r, them })} />
                </div>
              </>
            )}
          />
        </div>
      );
    case "video":
      return (
        <div className="space-y-3">
          <F label="Lien de la vidéo" hint="YouTube, Vimeo ou fichier .mp4">
            <UrlText value={block.props.url} placeholder="https://youtube.com/watch?v=…" onChange={(url) => props(block, { url })} />
          </F>
          <F label="Légende (facultatif)">
            <Text value={block.props.caption} maxLength={500} onChange={(caption) => props(block, { caption })} />
          </F>
        </div>
      );
    case "logos":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} maxLength={TEXT_LIMITS.title} onChange={(title) => props(block, { title })} />
          </F>
          <ListEditor
            items={block.props.logos}
            max={LIST_LIMITS.logos}
            addLabel="Ajouter un logo"
            create={() => ({ imageUrl: "", alt: "" })}
            onChange={(logos) => props(block, { logos })}
            render={(l, set) => (
              <>
                <ImageField value={l.imageUrl} compact placeholder="URL du logo (PNG/SVG)" onChange={(imageUrl) => set({ ...l, imageUrl })} />
                <Text value={l.alt} placeholder="Nom du média" maxLength={TEXT_LIMITS.label} onChange={(alt) => set({ ...l, alt })} />
              </>
            )}
          />
        </div>
      );
    case "stats":
      return (
        <ListEditor
          items={block.props.items}
          max={LIST_LIMITS.stats}
          addLabel="Ajouter un chiffre"
          create={() => ({ value: "", label: "" })}
          onChange={(items) => props(block, { items })}
          render={(it, set) => (
            <div className="grid grid-cols-[90px_1fr] gap-2">
              <div>
                <Text label="Valeur" value={it.value} maxLength={40} onChange={(value) => set({ ...it, value })} />
              </div>
              <div>
                <Text label="Libellé" value={it.label} maxLength={120} onChange={(label) => set({ ...it, label })} />
              </div>
            </div>
          )}
        />
      );
    case "benefits":
      return (
        <div className="space-y-3">
          <F label="Titre (facultatif)">
            <Text value={block.props.title} maxLength={TEXT_LIMITS.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Colonnes">
            <Segmented value={String(block.props.columns) as "2" | "3"} options={[["2", "2"], ["3", "3"]]} onChange={(c) => props(block, { columns: c === "2" ? 2 : 3 })} />
          </F>
          <ListEditor
            items={block.props.items}
            max={LIST_LIMITS.benefits}
            addLabel="Ajouter un avantage"
            create={() => ({ icon: "sparkles" as const, title: "Avantage", text: "" })}
            onChange={(items) => props(block, { items })}
            render={(it, set) => (
              <>
                <Text label="Titre" value={it.title} maxLength={TEXT_LIMITS.label} onChange={(title) => set({ ...it, title })} />
                <Text value={it.text} placeholder="Sous-texte (facultatif)" maxLength={TEXT_LIMITS.text} onChange={(text) => set({ ...it, text })} />
                <IconPicker value={it.icon} onChange={(icon) => set({ ...it, icon })} />
              </>
            )}
          />
        </div>
      );
    case "secure_badge":
      return (
        <div className="space-y-3">
          <F label="Texte">
            <Text value={block.props.text} maxLength={TEXT_LIMITS.title} onChange={(text) => props(block, { text })} />
          </F>
          <F label="Sous-texte">
            <Text value={block.props.subtext} maxLength={500} onChange={(subtext) => props(block, { subtext })} />
          </F>
        </div>
      );
    case "order_note":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} maxLength={TEXT_LIMITS.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Texte d'exemple">
            <Text value={block.props.placeholder} maxLength={300} onChange={(placeholder) => props(block, { placeholder })} />
          </F>
          <p className="text-[11px] text-zinc-600">La note du client est ajoutée à la commande Shopify.</p>
        </div>
      );
    case "support":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} maxLength={TEXT_LIMITS.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Texte">
            <Area value={block.props.text} rows={2} maxLength={TEXT_LIMITS.text} onChange={(text) => props(block, { text })} />
          </F>
          <F label="E-mail">
            <Text value={block.props.email} placeholder="support@maboutique.fr" maxLength={120} onChange={(email) => props(block, { email })} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Téléphone">
              <Text value={block.props.phone} placeholder="01 23 45 67 89" maxLength={40} onChange={(phone) => props(block, { phone })} />
            </F>
            <F label="WhatsApp">
              <Text value={block.props.whatsapp} placeholder="+33 6 12 34 56 78" maxLength={40} onChange={(whatsapp) => props(block, { whatsapp })} />
            </F>
          </div>
        </div>
      );
    case "spacer":
      return (
        <div className="space-y-3">
          <F label={`Hauteur : ${block.props.size}px`}>
            <input type="range" min={4} max={120} value={block.props.size} onChange={(e) => props(block, { size: Number(e.target.value) })} className="w-full accent-zinc-900" />
          </F>
          <Toggle label="Afficher une ligne" checked={block.props.line} onChange={(line) => props(block, { line })} />
        </div>
      );
    case "button_link":
      return (
        <div className="space-y-3">
          <F label="Texte du bouton">
            <Text value={block.props.label} maxLength={120} onChange={(label) => props(block, { label })} />
          </F>
          <F label="Lien">
            <UrlText value={block.props.url} placeholder="https://…" onChange={(url) => props(block, { url })} />
          </F>
          <F label="Style">
            <Segmented value={block.props.variant} options={[["solid", "Plein"], ["outline", "Contour"]]} onChange={(variant) => props(block, { variant })} />
          </F>
        </div>
      );
    case "upsell":
      return (
        <div className="space-y-4">
          {/* What the merchant must set first: the product and its price. */}
          <section aria-labelledby={`upsell-product-${block.id}`} className="space-y-3">
            <h3 id={`upsell-product-${block.id}`} className="text-xs font-semibold text-zinc-900">
              Produit &amp; prix
            </h3>
            <F label="Produit proposé">
              <Segmented
                value={block.props.productSource ?? "manual"}
                options={[
                  ["manual", "Choisi"],
                  ["auto", "Automatique"],
                ]}
                onChange={(productSource) =>
                  // An automatic product has no fixed price: a percent off its live Shopify price.
                  props(block, productSource === "auto" ? { productSource, priceMode: "percent" } : { productSource })
                }
              />
            </F>
            {block.props.productSource === "auto" ? (
              <p className="rounded-lg bg-zinc-50 px-3 py-2 text-[11px] leading-relaxed text-zinc-700 ring-1 ring-zinc-900/5">
                Pour chaque commande, le produit le plus souvent acheté avec ceux du panier (vos commandes payées des 180 derniers jours, au moins 2 commandes en commun),
                hors produits déjà dans la commande et seulement s&apos;il est en stock. Sans produit trouvé, l&apos;offre n&apos;est pas affichée. Prix : le % de remise
                ci-dessous sur son prix Shopify.
              </p>
            ) : (
              <OfferProduct block={block} context={context} onChange={onChange} />
            )}
            <OfferPriceFields value={block.props} currency={context?.currency} onChange={(patch) => props(block, block.props.productSource === "auto" ? { ...patch, priceMode: "percent" } : patch)} />
            <UpsellQuantity block={block} onChange={onChange} />
          </section>
          <EditorAccordion title="Textes" summary={block.props.title || "Titre, texte, image, boutons"}>
            <F label="Bandeau">
              <Text value={block.props.badge} maxLength={OFFER_LIMITS.badge} onChange={(badge) => props(block, { badge })} />
            </F>
            <F label="Titre">
              <Text value={block.props.title} maxLength={OFFER_LIMITS.title} onChange={(title) => props(block, { title })} />
            </F>
            <F label="Texte">
              <Area value={block.props.text} rows={3} maxLength={OFFER_LIMITS.text} onChange={(text) => props(block, { text })} />
            </F>
            <Field label="Image" hint="Vide = la photo du produit dans la commande, sinon une vignette neutre.">
              <ImageField value={block.props.imageUrl} images={images} onChange={(imageUrl) => props(block, { imageUrl })} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <F label="Bouton">
                <Text value={block.props.buttonText} maxLength={OFFER_LIMITS.button} onChange={(buttonText) => props(block, { buttonText })} />
              </F>
              <F label="Refus">
                <Text value={block.props.declineText} maxLength={OFFER_LIMITS.button} onChange={(declineText) => props(block, { declineText })} />
              </F>
            </div>
          </EditorAccordion>
          {context && (
            <UpsellRules block={block} blocks={context.blocks} storeId={context.storeId} productTitles={context.productTitles} onChange={onChange} />
          )}
          <OfferVariantB block={block} context={context} images={images} onChange={onChange} />
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-[11px] leading-relaxed text-indigo-900">
            Affichée juste après l&apos;achat. Le client accepte en un clic : Whop débite la carte enregistrée pendant le checkout et une commande Shopify
            liée est créée. Valable 1 h après le paiement. Quand une offre est active, le checkout enregistre la carte (certains moyens comme PayPal peuvent
            alors être masqués).
          </p>
        </div>
      );
    case "shipping_protection": {
      const p = block.props;
      return (
        <div className="space-y-3">
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-[11px] leading-relaxed text-indigo-900">
            Case à cocher au checkout. Le prix est calculé par le serveur et ajouté au total ; la commande Shopify reçoit une ligne « Protection colis ». La page
            de remerciement affiche « Colis protégé » et vos instructions de réclamation.
          </p>
          {context?.protectionTest && <RunningTestNotice name={context.protectionTest} />}
          <F label="Titre" hint="Vide = « Protection colis (perte, vol, casse) », traduit.">
            <Text
              value={p.title}
              placeholder={emptyTextDefault("shipping_protection", "title", context?.lang ?? "fr") ?? undefined}
              maxLength={TEXT_LIMITS.title}
              onChange={(title) => props(block, { title })}
            />
          </F>
          <F label="Description" hint="Vide = texte traduit par défaut.">
            <Text
              value={p.text}
              placeholder={emptyTextDefault("shipping_protection", "text", context?.lang ?? "fr") ?? undefined}
              maxLength={TEXT_LIMITS.text}
              onChange={(text) => props(block, { text })}
            />
          </F>
          <F label="Prix">
            <Segmented value={p.priceMode} options={[["fixed", "Montant fixe"], ["percent", "% du panier"]]} onChange={(priceMode) => props(block, { priceMode })} />
          </F>
          {p.priceMode === "fixed" ? (
            <F label="Montant">
              <PriceInput value={p.price} currency={context?.currency} max={1000} onChange={(price) => props(block, { price: price ?? 0 })} />
            </F>
          ) : (
            <div className="grid grid-cols-3 gap-2">
              <F label="% du panier">
                <DecimalInput value={p.percent} min={0} max={50} suffix="%" placeholder="ex. 2,5" onChange={(percent) => props(block, { percent: percent ?? 0 })} />
              </F>
              <F label="Minimum">
                <PriceInput value={p.minPrice} currency={context?.currency} max={1000} onChange={(minPrice) => props(block, { minPrice: minPrice ?? 0 })} />
              </F>
              <F label="Maximum" hint="0 = aucun">
                <PriceInput value={p.maxPrice} currency={context?.currency} max={1000} onChange={(maxPrice) => props(block, { maxPrice: maxPrice ?? 0 })} />
              </F>
            </div>
          )}
          <Toggle label="Cochée par défaut" checked={p.defaultOn} onChange={(defaultOn) => props(block, { defaultOn })} />
          {p.defaultOn && (
            <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-[11px] leading-relaxed text-amber-900 ring-1 ring-amber-200">
              Déconseillé en Europe : le droit de la consommation (directive 2011/83/UE, art. 22) interdit de faire payer une option cochée d&apos;avance.
              Le client doit la cocher lui-même, sinon il peut en demander le remboursement.
            </p>
          )}
          <F label="Instructions de réclamation" hint="Affichées sur la page de remerciement quand le colis est protégé.">
            <Area value={p.claimText} rows={4} maxLength={2000} onChange={(claimText) => props(block, { claimText })} />
          </F>
        </div>
      );
    }
    case "survey": {
      const p = block.props;
      const toggle = (key: SurveyKey, on: boolean) =>
        props(block, { options: SURVEY_KEYS.filter((k) => (k === key ? on : p.options.includes(k))) });
      return (
        <div className="space-y-3">
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-[11px] leading-relaxed text-indigo-900">
            Une question en un clic après l&apos;achat. La réponse est enregistrée sur la commande (une seule fois) : utile pour attribuer vos ventes au bon canal.
          </p>
          <F label="Question" hint="Vide = « Comment nous avez-vous connu ? », traduit dans la langue du client.">
            <Text
              value={p.question}
              placeholder={emptyTextDefault("survey", "question", context?.lang ?? "fr") ?? undefined}
              maxLength={TEXT_LIMITS.title}
              onChange={(question) => props(block, { question })}
            />
          </F>
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs font-medium text-zinc-700">Réponses proposées</legend>
            {SURVEY_KEYS.map((k) => (
              <Toggle key={k} label={SURVEY_LABELS[k]} checked={p.options.includes(k)} onChange={(on) => toggle(k, on)} />
            ))}
          </fieldset>
          {p.options.length === 0 && <p className="text-[11px] text-amber-700">Cochez au moins une réponse : sans réponse, le bloc ne s&apos;affiche pas.</p>}
          <p className="text-[11px] text-zinc-600">Les libellés sont traduits automatiquement. « Autre » permet au client de préciser (80 caractères).</p>
        </div>
      );
    }
    case "recommendations":
      return (
        <div className="space-y-3">
          <p className="rounded-lg bg-indigo-50 px-3 py-2 text-[11px] leading-relaxed text-indigo-900">
            Le client ajoute le produit au panier en un clic, sans quitter le checkout. Prix, photo et disponibilité viennent de Shopify au moment de
            l&apos;affichage ; un produit épuisé ou brouillon n&apos;est pas proposé.
          </p>
          <F label="Titre" hint="Vide = « Complétez votre commande », traduit dans la langue du checkout.">
            <Text
              value={block.props.title}
              placeholder={emptyTextDefault("recommendations", "title", context?.lang ?? "fr") ?? undefined}
              maxLength={TEXT_LIMITS.title}
              onChange={(title) => props(block, { title })}
            />
          </F>
          <RecommendationItems block={block} context={context} onChange={onChange} />
          <Toggle label="Masquer les produits déjà dans le panier" checked={block.props.hideIfInCart} onChange={(hideIfInCart) => props(block, { hideIfInCart })} />
        </div>
      );
    case "coupon":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} maxLength={TEXT_LIMITS.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Texte">
            <Area value={block.props.text} rows={2} maxLength={TEXT_LIMITS.text} onChange={(text) => props(block, { text })} />
          </F>
          <F label="Code" hint="Créez-le aussi dans Promos & options pour qu'il fonctionne : vos clients voient le code tel quel.">
            <Text value={block.props.code} maxLength={60} onChange={(code) => props(block, { code: code.toUpperCase() })} />
          </F>
        </div>
      );
    case "message":
      return (
        <div className="space-y-3">
          <Field label="Photo (facultatif)" hint="Votre portrait, celui de l'équipe ou votre logo.">
            <ImageField value={block.props.photoUrl} images={images} compact onChange={(photoUrl) => props(block, { photoUrl })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <F label="Forme de la photo">
              <Segmented value={block.props.photoShape} options={[["round", "Ronde"], ["square", "Carrée"]]} onChange={(photoShape) => props(block, { photoShape })} />
            </F>
            <F label="Disposition">
              <Segmented value={block.props.layout} options={[["left", "À gauche"], ["top", "En haut"]]} onChange={(layout) => props(block, { layout })} />
            </F>
          </div>
          <F label="Titre" hint="Facultatif : {prénom} insère le prénom du client. Le titre de la page dit déjà merci.">
            <Text value={block.props.title} placeholder="ex. Bienvenue parmi nous, {prénom} !" maxLength={MESSAGE_LIMITS.title} onChange={(title) => props(block, { title })} />
          </F>
          <F label="Message" hint="Ligne vide = nouveau paragraphe. **texte** = gras. [texte](https://…) = lien.">
            <Area value={block.props.body} rows={6} maxLength={MESSAGE_LIMITS.body} onChange={(body) => props(block, { body })} />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F label="Signature : nom">
              <Text value={block.props.signatureName} placeholder="ex. Camille Martin" maxLength={MESSAGE_LIMITS.signatureName} onChange={(signatureName) => props(block, { signatureName })} />
            </F>
            <F label="Rôle">
              <Text value={block.props.signatureRole} placeholder="ex. Fondatrice" maxLength={MESSAGE_LIMITS.signatureRole} onChange={(signatureRole) => props(block, { signatureRole })} />
            </F>
          </div>
          <Field label="Signature manuscrite (facultatif)" hint="Image PNG à fond transparent de préférence.">
            <ImageField value={block.props.signatureImageUrl} compact onChange={(signatureImageUrl) => props(block, { signatureImageUrl })} />
          </Field>
        </div>
      );
    case "social":
      return (
        <div className="space-y-3">
          <F label="Titre">
            <Text value={block.props.title} maxLength={TEXT_LIMITS.title} onChange={(title) => props(block, { title })} />
          </F>
          {(["instagram", "tiktok", "facebook", "youtube"] as const).map((k) => (
            <F key={k} label={k[0].toUpperCase() + k.slice(1)}>
              <UrlText value={block.props[k]} placeholder="https://…" onChange={(v) => props(block, { [k]: v })} />
            </F>
          ))}
        </div>
      );
  }
}

/**
 * Offer end: separate date + time fields (the browser's native pickers), with the result
 * spelled out in French ("mardi 14 octobre 2026 à 23:59") so the day/month order is never
 * ambiguous, whatever the browser's locale displays.
 */
/** Default text of a date countdown: switching to a timer per visitor offers an example instead. */
const COUNTDOWN_DATE_LABEL = DEFAULT_TEXTS.fr.countdown;

/** Countdown settings: a real end date, or a timer per visitor that starts over at zero. */
export function CountdownEditor({ block, onChange }: { block: BlockOf<"countdown">; onChange: (patch: Partial<BlockOf<"countdown">["props"]>) => void }) {
  const p = block.props;
  const evergreen = p.mode === "evergreen";
  return (
    <div className="space-y-3">
      <Field label="Type de minuteur">
        <Segmented
          value={p.mode}
          options={[
            ["date", "Date de fin"],
            ["evergreen", "Minuteur par visiteur"],
          ]}
          onChange={(mode) =>
            onChange(mode === "evergreen" && p.label.trim() === COUNTDOWN_DATE_LABEL ? { mode, label: DEFAULT_TEXTS.fr[COUNTDOWN_EXAMPLE_KEYS[0]] } : { mode })
          }
        />
      </Field>
      <F label="Texte" hint="{timer} = le minuteur, placé où vous voulez (sans {timer}, il s'affiche après le texte).">
        <Text value={p.label} maxLength={200} onChange={(label) => onChange({ label })} />
      </F>
      {evergreen && (
        <Field label="Exemples" hint="Un clic remplace le texte. Traduits automatiquement pour vos clients étrangers.">
          <div className="flex flex-wrap gap-1.5">
            {COUNTDOWN_EXAMPLE_KEYS.map((key) => {
              const text = DEFAULT_TEXTS.fr[key];
              return (
                <button
                  key={key}
                  type="button"
                  aria-pressed={p.label === text}
                  onClick={() => onChange({ label: text })}
                  className={`rounded-full border px-2.5 py-1 text-left text-xs ${ring} ${
                    p.label === text ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-zinc-700 hover:bg-zinc-50"
                  }`}
                >
                  {text}
                </button>
              );
            })}
          </div>
        </Field>
      )}
      {evergreen ? (
        <>
          <Field label="Durée" hint="Le minuteur démarre quand le client arrive. À zéro, il repart automatiquement de cette durée.">
            <DurationInput value={p.durationSeconds} onChange={(durationSeconds) => onChange({ durationSeconds })} />
          </Field>
          <Field label="Quand le client revient">
            <Segmented
              value={p.restart}
              options={[
                ["keep", "Garder le temps restant"],
                ["each_visit", "Repartir à chaque visite"],
              ]}
              onChange={(restart) => onChange({ restart })}
            />
            <span className="mt-1 block text-[11px] text-zinc-600">
              {p.restart === "keep" ? "Le temps restant est mémorisé dans le navigateur du client." : "Le minuteur repart de la durée complète à chaque chargement de la page."}
            </span>
            <span data-countdown-tip="" className="mt-1 block text-[11px] text-zinc-500">
              Astuce : un minuteur qui repart à chaque visite peut être vu comme une fausse urgence dans certains pays.
            </span>
          </Field>
        </>
      ) : (
        <Field label="Fin de l'offre" hint="Une vraie date de fin : le minuteur disparaît ensuite.">
          <EndDateInput value={p.endsAt} onChange={(endsAt) => onChange({ endsAt })} />
        </Field>
      )}
      <F label="Affichage du temps">
        <Pick
          value={p.format}
          options={[
            ["hms", "01:59:59 (heures, minutes, secondes)"],
            ["ms", "119:59 (minutes, secondes)"],
            ["words", "1 h 59 min (en toutes lettres)"],
          ]}
          onChange={(format) => onChange({ format })}
        />
      </F>
    </div>
  );
}

/** Seconds → hours / minutes / seconds fields. */
function splitDuration(total: number) {
  return { h: Math.floor(total / 3600), m: Math.floor((total % 3600) / 60), s: total % 60 };
}

/**
 * Duration typed as hours / minutes / seconds. Only a total between 1 min and 72 h is committed;
 * outside, the fields keep what was typed and say why (never silently capped).
 */
export function DurationInput({ value, onChange }: { value: number; onChange: (seconds: number) => void }) {
  const errId = useId();
  const [draft, setDraft] = useState(() => {
    const d = splitDuration(value);
    return { h: String(d.h), m: String(d.m), s: String(d.s) };
  });
  const [seen, setSeen] = useState(value);
  if (value !== seen) {
    setSeen(value);
    const d = splitDuration(value);
    setDraft({ h: String(d.h), m: String(d.m), s: String(d.s) });
  }
  const num = (v: string) => (/^\d{0,5}$/.test(v.trim()) ? Number(v.trim() || 0) : NaN);
  const totalOf = (d: typeof draft) => num(d.h) * 3600 + num(d.m) * 60 + num(d.s);
  const total = totalOf(draft);
  const error = Number.isNaN(total)
    ? "Chiffres uniquement."
    : total < COUNTDOWN_DURATION.min || total > COUNTDOWN_DURATION.max
      ? "Entre 1 minute et 72 heures."
      : null;
  const set = (key: "h" | "m" | "s", v: string) => {
    const next = { ...draft, [key]: v };
    setDraft(next);
    const t = totalOf(next);
    if (!Number.isNaN(t) && t >= COUNTDOWN_DURATION.min && t <= COUNTDOWN_DURATION.max) {
      setSeen(t);
      onChange(t);
    }
  };
  const unit = (key: "h" | "m" | "s", label: string, short: string) => (
    <label className="flex flex-1 items-center gap-1">
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errId : undefined}
        className={`${input} text-right tabular-nums ${error ? "border-amber-400 focus:border-amber-500" : ""}`}
        value={draft[key]}
        onChange={(e) => set(key, e.target.value)}
        onBlur={() => {
          if (!error) {
            const d = splitDuration(total);
            setDraft({ h: String(d.h), m: String(d.m), s: String(d.s) });
          }
        }}
      />
      <span className="text-xs text-zinc-600" aria-hidden>
        {short}
      </span>
    </label>
  );
  return (
    <div>
      <div className="flex gap-2">
        {unit("h", "Heures", "h")}
        {unit("m", "Minutes", "min")}
        {unit("s", "Secondes", "s")}
      </div>
      {error && (
        <span id={errId} role="alert" className="mt-1 block text-[11px] text-amber-700">
          {error}
        </span>
      )}
    </div>
  );
}

function EndDateInput({ value, onChange }: { value: string; onChange: (iso: string) => void }) {
  const local = toLocalInput(value);
  const [date, time] = local ? local.split("T") : ["", ""];
  const commit = (d: string, t: string) => {
    if (!d) return onChange("");
    const at = new Date(`${d}T${t || "23:59"}`);
    onChange(Number.isNaN(at.getTime()) ? "" : at.toISOString());
  };
  const at = value ? new Date(value) : null;
  const valid = at && !Number.isNaN(at.getTime());
  // Checked against the time the panel opened (render stays pure).
  const [openedAt] = useState(() => Date.now());
  const past = valid && at.getTime() <= openedAt;
  const preset = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(23, 59, 0, 0);
    onChange(d.toISOString());
  };
  const chip = `rounded-md bg-zinc-100 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-200 ${ring}`;
  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] gap-2">
        <label className="block">
          <span className="mb-0.5 block text-[11px] text-zinc-600">Date</span>
          <input type="date" lang="fr" className={input} value={date} onChange={(e) => commit(e.target.value, time)} />
        </label>
        <label className="block">
          <span className="mb-0.5 block text-[11px] text-zinc-600">Heure</span>
          <input type="time" lang="fr" step={60} className={input} value={time} disabled={!date} onChange={(e) => commit(date, e.target.value)} />
        </label>
      </div>
      <p aria-live="polite" className={`text-[11px] ${past ? "font-medium text-amber-800" : "text-zinc-700"}`}>
        {valid
          ? `${past ? "Terminée depuis le" : "Se termine le"} ${at.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} à ${at.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}${past ? " : le minuteur est masqué" : ""}`
          : "Aucune date de fin : le minuteur n'est pas affiché."}
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={chip} onClick={() => preset(0)}>
          Ce soir 23:59
        </button>
        <button type="button" className={chip} onClick={() => preset(3)}>
          Dans 3 jours
        </button>
        <button type="button" className={chip} onClick={() => preset(7)}>
          Dans 7 jours
        </button>
      </div>
    </div>
  );
}

function toLocalInput(iso: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ */
/* Style panel                                                         */
/* ------------------------------------------------------------------ */

/** Suggested one-click price: 20 % off the product's price, ending in ,90 when it can. */
function suggestedPrice(regular: number) {
  const p = regular * 0.8;
  const nice = Math.floor(p) + 0.9;
  return Math.round((nice <= p + 0.001 && nice < regular ? nice : Math.round(p * 100) / 100) * 100) / 100;
}

/** Survey options as the merchant reads them (buyers see them translated). */
const SURVEY_LABELS: Record<SurveyKey, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  google: "Google",
  youtube: "YouTube",
  friend: "Un proche",
  other: "Autre (+ précision libre)",
};

type OfferProductFields = { variantId: string; productId?: string; imageUrl: string; title: string; price: number; compareAt: number };

/**
 * Product of a one-click offer: catalog search (the dashboard's product picker), which fills
 * the variant, product, photo, title and prices; pasting a variant id stays possible.
 */
function OfferProductPicker({
  pickerId,
  value,
  context,
  label = "Produit offert",
  onChange,
}: {
  pickerId: string;
  value: OfferProductFields;
  context?: EditorContext;
  label?: string;
  onChange: (patch: Partial<OfferProductFields>) => void;
}) {
  const uid = useId();
  const [manual, setManual] = useState(false);
  // Remounts the picker when the id is typed by hand (it reads its value once).
  const [pickerKey, setPickerKey] = useState(0);
  const variantId = value.variantId;
  const numeric = (v: string) => (v.startsWith("gid://") ? (v.match(/(\d+)\D*$/)?.[1] ?? v) : v);
  const typed = (v: string) => (v.startsWith("gid://") ? v : (v.match(/(\d+)\D*$/)?.[1] ?? v.trim()));
  function onPick(picked: PickedVariant | null) {
    if (!picked) {
      onChange({ variantId: "", productId: undefined });
      return;
    }
    // The picker also reports the saved variant when it loads: only the product id may be missing then.
    if (picked.id === numeric(variantId)) {
      if (picked.product && !value.productId) onChange({ productId: picked.product.id });
      return;
    }
    const regular = picked.variant ? Number(picked.variant.price) : NaN;
    const next: Partial<OfferProductFields> = { variantId: picked.id, productId: picked.product?.id };
    if (picked.product && picked.variant) {
      next.imageUrl = picked.variant.imageUrl ?? picked.product.imageUrl ?? value.imageUrl;
      next.title = pickedTitle(picked);
      if (Number.isFinite(regular) && regular > 0) {
        next.compareAt = regular;
        next.price = suggestedPrice(regular);
      }
    }
    onChange(next);
  }
  if (!context?.storeId) {
    return (
      <F label="ID de variante Shopify" hint="Le numéro de la variante (ou l'URL admin …/variants/123).">
        <Text value={variantId} placeholder="44871234567890" onChange={(v) => onChange({ variantId: typed(v), productId: undefined })} />
      </F>
    );
  }
  return (
    <div>
      <label htmlFor={`${uid}-product`} className="mb-1 block text-xs font-medium text-zinc-700">
        {label}
      </label>
      <ProductPicker
        key={`${pickerId}:${pickerKey}`}
        storeId={context.storeId}
        name={`upsell-${pickerId}`}
        defaultValue={variantId || null}
        currency={context.currency ?? "EUR"}
        inputId={`${uid}-product`}
        describedBy={`${uid}-product-hint`}
        onPick={onPick}
      />
      <p id={`${uid}-product-hint`} className="mt-1 text-[11px] text-zinc-600">
        Remplit la photo, le titre et les prix (−20 % suggéré, modifiable ci-dessous).{" "}
        <button type="button" onClick={() => setManual((v) => !v)} aria-expanded={manual} className={`rounded font-medium text-indigo-700 hover:underline ${ring}`}>
          {manual ? "Masquer" : "Coller un ID"}
        </button>
      </p>
      {manual && (
        <div className="mt-2">
          <F label="ID de variante Shopify" hint="Le numéro de la variante (ou l'URL admin …/variants/123).">
            <Text
              value={variantId}
              placeholder="44871234567890"
              onChange={(v) => {
                onChange({ variantId: typed(v), productId: undefined });
                setPickerKey((k) => k + 1);
              }}
            />
          </F>
        </div>
      )}
    </div>
  );
}

function OfferProduct({ block, context, onChange }: { block: BlockOf<"upsell">; context?: EditorContext; onChange: (b: Block) => void }) {
  return <OfferProductPicker pickerId={block.id} value={block.props} context={context} onChange={(patch) => onChange({ ...block, props: { ...block.props, ...patch } })} />;
}

type OfferPriceValue = { priceMode: "fixed" | "percent"; price: number; discountPercent: number; compareAt: number };

/** Fixed price, or "% off the Shopify price" (charged on Shopify's price at the time of the "Yes"). */
function OfferPriceFields({ value, currency, onChange }: { value: OfferPriceValue; currency?: string; onChange: (patch: Partial<OfferPriceValue>) => void }) {
  return (
    <div className="space-y-2">
      <F label="Prix de l'offre">
        <Segmented
          value={value.priceMode}
          options={[
            ["fixed", "Prix fixe"],
            ["percent", "% de remise sur le prix Shopify"],
          ]}
          onChange={(priceMode) => onChange({ priceMode })}
        />
      </F>
      {value.priceMode === "fixed" ? (
        <div className="grid grid-cols-2 gap-2">
          <F label="Prix">
            <PriceInput value={value.price} currency={currency} onChange={(price) => onChange({ price: price ?? 0 })} />
          </F>
          <F label="Prix barré" hint="Prix habituel du produit">
            <PriceInput value={value.compareAt} currency={currency} onChange={(compareAt) => onChange({ compareAt: compareAt ?? 0 })} />
          </F>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <F label="Remise (%)" hint="1 à 90 %">
            <Num value={value.discountPercent} min={1} max={90} onChange={(discountPercent) => onChange({ discountPercent: Math.min(90, Math.max(1, Math.round(discountPercent || 1))) })} />
          </F>
          <F label="Prix habituel (aperçu)" hint="Sert seulement à l'aperçu">
            <PriceInput value={value.compareAt} currency={currency} onChange={(compareAt) => onChange({ compareAt: compareAt ?? 0 })} />
          </F>
          <p className="col-span-2 text-[11px] leading-relaxed text-zinc-600">
            Le prix affiché et débité est calculé sur le prix Shopify au moment de l&apos;achat (le prix barré est ce prix Shopify). Si Shopify ne répond pas,
            l&apos;offre n&apos;est pas affichée.
          </p>
        </div>
      )}
    </div>
  );
}

/** Offer-level A/B test: arm B (product, price, texts) seen by `split` % of visitors. */
function OfferVariantB({ block, context, images, onChange }: { block: BlockOf<"upsell">; context?: EditorContext; images: ImageSource[]; onChange: (b: Block) => void }) {
  const b = offerArmSchema.parse(block.props.variantB ?? {});
  const set = (patch: Partial<OfferArmProps>) => onChange({ ...block, props: { ...block.props, variantB: { ...b, ...patch } } });
  const incomplete = b.enabled && !upsellSellable(b);
  return (
    <EditorAccordion
      title="Tester une variante B"
      summary={b.enabled ? (incomplete ? "Incomplète" : `A ${100 - b.split} % · B ${b.split} %`) : "Désactivé"}
      defaultOpen={incomplete}
    >
      <p className="text-[11px] leading-relaxed text-zinc-600">
        Chaque client voit toujours la même version (tirage par visiteur). Les affichages et les achats sont comptés par version : comparez le taux
        d&apos;acceptation dans Analyses.
      </p>
      <Toggle label="Activer la variante B" checked={b.enabled} onChange={(enabled) => set({ enabled })} />
      {b.enabled && (
        <>
          <F label={`Part des clients qui voient B : ${b.split} %`}>
            <input
              type="range"
              min={1}
              max={99}
              value={b.split}
              aria-valuetext={`${b.split} %`}
              onChange={(e) => set({ split: Number(e.target.value) })}
              className="w-full accent-zinc-900"
            />
          </F>
          <Toggle label="Garder automatiquement la gagnante" checked={!!b.autoPromote} onChange={(autoPromote) => set({ autoPromote })} />
          <p className="-mt-1 text-[11px] leading-relaxed text-zinc-600">
            Dès que l&apos;écart de CA HT par affichage est significatif (7 jours et 200 affichages par version au moins, même règle que les tests de design), la
            version gagnante devient l&apos;offre et le test s&apos;arrête. Sinon, décidez depuis Analyses › Offres (« Promouvoir B »).
          </p>
          <OfferProductPicker pickerId={`${block.id}-b`} label="Produit de la variante B" value={b} context={context} onChange={(patch) => set(patch)} />
          <OfferPriceFields value={b} currency={context?.currency} onChange={(patch) => set(patch)} />
          <F label="Bandeau" hint="Vide = celui de la version A">
            <Text value={b.badge} placeholder={block.props.badge} maxLength={OFFER_LIMITS.badge} onChange={(badge) => set({ badge })} />
          </F>
          <F label="Titre" hint="Vide = celui de la version A">
            <Text value={b.title} placeholder={block.props.title} maxLength={OFFER_LIMITS.title} onChange={(title) => set({ title })} />
          </F>
          <F label="Texte" hint="Vide = celui de la version A">
            <Area value={b.text} rows={2} maxLength={OFFER_LIMITS.text} onChange={(text) => set({ text })} />
          </F>
          <F label="Bouton" hint="Vide = celui de la version A">
            <Text value={b.buttonText} placeholder={block.props.buttonText} maxLength={OFFER_LIMITS.button} onChange={(buttonText) => set({ buttonText })} />
          </F>
          <Field label="Image" hint="Vide = la photo du produit dans la commande, sinon une vignette neutre.">
            <ImageField value={b.imageUrl} images={images} onChange={(imageUrl) => set({ imageUrl })} />
          </Field>
          {incomplete && <p className="text-[11px] text-amber-700">Choisissez un produit et un prix : sans eux, tous les clients voient la version A.</p>}
        </>
      )}
    </EditorAccordion>
  );
}

/** Title shown for a picked variant ("Produit — Variante"). */
function pickedTitle(picked: PickedVariant) {
  if (!picked.product) return "";
  const variant = picked.variant?.title && picked.variant.title !== "Default Title" ? ` — ${picked.variant.title}` : "";
  return `${picked.product.title}${variant}`.slice(0, 120);
}

/**
 * A block editor locked (every field disabled) while a fetched result that patches the block
 * is awaited, so nothing typed meanwhile is overwritten when it lands.
 */
function FetchLock({ children }: { children: (setFetching: (fetching: boolean) => void) => ReactNode }) {
  const [fetching, setFetching] = useState(false);
  return (
    <fieldset disabled={fetching} aria-busy={fetching || undefined} className="m-0 min-w-0 border-0 p-0">
      {children(setFetching)}
    </fieldset>
  );
}

/**
 * Products of "Complétez votre commande" (1 to 4): the dashboard's catalog search, as for the
 * one-click offer, with pasting a variant id as a fallback. Stored as variant GIDs.
 */
function RecommendationItems({ block, context, onChange }: { block: BlockOf<"recommendations">; context?: EditorContext; onChange: (b: Block) => void }) {
  const uid = useId();
  const [manual, setManual] = useState(false);
  // Remounts the pickers when the list shifts or an id is typed (a picker reads its value once).
  const [nonce, setNonce] = useState(0);
  const items = block.props.items;
  // Translations stored by position ("items.2.title") follow their product when one is removed.
  const setItems = (next: typeof items) => onChange(remapListTranslations(block, { ...block, props: { ...block.props, items: next } }));
  const setItem = (i: number, patch: Partial<(typeof items)[number]>) => setItems(items.map((it, j) => (j === i ? { ...it, ...patch } : it)));
  const numeric =(v: string) => v.match(/(\d+)\D*$/)?.[1] ?? v;
  const toGid = (v: string) => variantGidOf(v) ?? v.trim();
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-zinc-700">
        Produits proposés <span className="font-normal text-zinc-600">({items.length}/{MAX_RECOMMENDATIONS})</span>
      </p>
      {items.length === 0 && <p className="text-[11px] text-amber-700">Ajoutez au moins un produit : sans produit, le bloc ne s&apos;affiche pas.</p>}
      {items.map((it, i) => (
        <div key={i} className="relative space-y-2 rounded-md border border-zinc-200 bg-zinc-50 p-2.5 pr-8">
          {context?.storeId ? (
            <div>
              <label htmlFor={`${uid}-${i}`} className="mb-1 block text-xs font-medium text-zinc-700">
                Produit {i + 1}
              </label>
              <ProductPicker
                key={nonce}
                storeId={context.storeId}
                name={`reco-${block.id}-${i}`}
                defaultValue={it.variantId || null}
                currency={context.currency ?? "EUR"}
                inputId={`${uid}-${i}`}
                onPick={(picked) => {
                  if (!picked) return setItem(i, { variantId: "", title: "", imageUrl: "" });
                  // The picker also reports the saved variant when it loads: nothing to fill then.
                  if (picked.id === numeric(it.variantId)) return;
                  setItem(i, {
                    variantId: toGid(picked.id),
                    title: pickedTitle(picked),
                    imageUrl: picked.variant?.imageUrl ?? picked.product?.imageUrl ?? "",
                  });
                }}
              />
            </div>
          ) : null}
          {(manual || !context?.storeId) && (
            <F label="ID de variante Shopify" hint="Le numéro de la variante (ou l'URL admin …/variants/123).">
              <Text
                value={it.variantId}
                placeholder="44871234567890"
                onChange={(v) => {
                  setItem(i, { variantId: toGid(v) });
                  setNonce((n) => n + 1);
                }}
              />
            </F>
          )}
          <F label="Titre affiché" hint="Vide = titre Shopify.">
            <Text value={it.title} maxLength={TEXT_LIMITS.label} onChange={(title) => setItem(i, { title })} />
          </F>
          <button
            type="button"
            aria-label={`Retirer le produit ${i + 1}`}
            onClick={() => {
              setItems(items.filter((_, j) => j !== i));
              setNonce((n) => n + 1);
            }}
            className={`absolute top-2 right-2 rounded text-zinc-500 hover:text-red-600 ${ring}`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {items.length < MAX_RECOMMENDATIONS && (
          <button type="button" onClick={() => setItems([...items, { variantId: "", title: "", imageUrl: "" }])} className={`rounded text-xs font-medium text-zinc-900 underline ${ring}`}>
            + Ajouter un produit
          </button>
        )}
        {context?.storeId && items.length > 0 && (
          <button type="button" onClick={() => setManual((v) => !v)} aria-expanded={manual} className={`rounded text-xs font-medium text-indigo-700 hover:underline ${ring}`}>
            {manual ? "Masquer les ID" : "Coller un ID"}
          </button>
        )}
      </div>
    </div>
  );
}

export function StyleEditor({ style, onChange }: { style: BlockStyle; onChange: (s: BlockStyle) => void }) {
  const set = <K extends keyof BlockStyle>(k: K, v: BlockStyle[K]) => onChange({ ...style, [k]: v });
  return (
    <div className="grid grid-cols-2 gap-3">
      <F label="Espacement">
        <Pick value={style.spacing} options={[["default", "Défaut"], ["none", "Aucun"], ["sm", "Petit"], ["md", "Moyen"], ["lg", "Grand"]]} onChange={(v) => set("spacing", v)} />
      </F>
      <F label="Alignement">
        <Pick value={style.align} options={[["default", "Défaut"], ["left", "Gauche"], ["center", "Centre"], ["right", "Droite"]]} onChange={(v) => set("align", v)} />
      </F>
      <F label="Taille du texte">
        <Pick value={style.textSize} options={[["default", "Défaut"], ["sm", "Petit"], ["md", "Moyen"], ["lg", "Grand"]]} onChange={(v) => set("textSize", v)} />
      </F>
      <F label="Couleur du texte">
        <Pick value={style.textColor} options={[["default", "Défaut"], ["muted", "Atténué"], ["brand", "Marque"], ["white", "Blanc"]]} onChange={(v) => set("textColor", v)} />
      </F>
      <F label="Fond">
        <Pick value={style.background} options={[["none", "Aucun"], ["light", "Clair"], ["brand", "Teinte marque"], ["dark", "Sombre"]]} onChange={(v) => set("background", v)} />
      </F>
      <F label="Séparateur">
        <Pick value={style.divider} options={[["none", "Aucun"], ["top", "Haut"], ["bottom", "Bas"], ["both", "Haut et bas"]]} onChange={(v) => set("divider", v)} />
      </F>
      <label className="col-span-2 flex items-center gap-2 text-xs font-medium text-zinc-700">
        <input type="checkbox" checked={style.card} onChange={(e) => set("card", e.target.checked)} className="h-3.5 w-3.5 accent-zinc-900" /> Encadré (carte)
      </label>
      <div className="col-span-2">
        <F label="Fond personnalisé">
          <ColorInput value={style.customBackground} onChange={(v) => set("customBackground", v)} />
        </F>
      </div>
      <div className="col-span-2">
        <F label="Texte personnalisé">
          <ColorInput value={style.customText} onChange={(v) => set("customText", v)} />
        </F>
      </div>
    </div>
  );
}
