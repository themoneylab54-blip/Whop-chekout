"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Clock, MapPin, Search } from "lucide-react";
import { errorText, localeOf, type Labels, type Lang } from "./i18n";

/** A relay point as returned by the pickup-points API. */
export type PickupPointView = {
  provider: "mondial_relay";
  id: string;
  name: string;
  address1: string;
  zip: string;
  city: string;
  countryCode: string;
  hours?: { day: string; slots: string[] }[];
  distanceM?: number | null;
};

/** Countries where relay points can be searched (Mondial Relay network). */
export const PICKUP_SEARCH_COUNTRIES = new Set(["FR", "BE", "LU", "NL", "ES", "PT", "DE", "AT", "IT", "PL"]);

/** What the pay request carries (no hours / distance). */
export function pickupPayload(p: PickupPointView) {
  return { provider: p.provider, id: p.id, name: p.name, address1: p.address1, zip: p.zip, city: p.city, countryCode: p.countryCode };
}

type Status = { kind: "idle" } | { kind: "loading" } | { kind: "done"; points: PickupPointView[] } | { kind: "error"; message: string };

/** Weekday names, Monday first (the API's order). 2024-01-01 was a Monday. */
function weekdays(lang: Lang) {
  const fmt = new Intl.DateTimeFormat(localeOf(lang), { weekday: "long", timeZone: "UTC" });
  return Array.from({ length: 7 }, (_, i) => {
    const name = fmt.format(new Date(Date.UTC(2024, 0, 1 + i)));
    return name.charAt(0).toUpperCase() + name.slice(1);
  });
}

function distance(m: number | null | undefined, lang: Lang) {
  if (m == null || !Number.isFinite(m)) return null;
  const locale = localeOf(lang);
  return m < 1000
    ? new Intl.NumberFormat(locale, { style: "unit", unit: "meter", maximumFractionDigits: 0 }).format(Math.round(m / 10) * 10)
    : new Intl.NumberFormat(locale, { style: "unit", unit: "kilometer", maximumFractionDigits: 1 }).format(m / 1000);
}

/** Title case for the network's upper-case names ("TABAC DU MARCHE" → "Tabac Du Marche"). */
function tidy(v: string) {
  return v === v.toUpperCase() ? v.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase()) : v;
}

/**
 * Relay-point selector shown under a "pickup" shipping rate: postcode search (prefilled
 * from the delivery address), the nearest points as a radio group, then a one-line summary.
 */
export function PickupPicker({
  sessionId,
  country,
  addressZip,
  addressCity,
  value,
  onChange,
  L,
  lang,
  error,
  inputId,
}: {
  sessionId: string;
  country: string;
  addressZip: string;
  addressCity: string;
  value: PickupPointView | null;
  onChange: (p: PickupPointView | null) => void;
  L: Labels;
  lang: Lang;
  /** Shown when the buyer tried to pay without a point. */
  error?: string;
  /** Focus target of the "missing fields" mechanism. */
  inputId: string;
}) {
  const uid = useId();
  // The postcode follows the address form until the buyer types their own here.
  const [ownZip, setOwnZip] = useState<string | null>(null);
  const zip = (ownZip ?? addressZip).trim();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [editing, setEditing] = useState(false);
  const [openHours, setOpenHours] = useState<string | null>(null);
  const [searchKey, setSearchKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const supported = PICKUP_SEARCH_COUNTRIES.has(country);
  const days = weekdays(lang);
  const today = (new Date().getDay() + 6) % 7;

  useEffect(() => {
    if (!supported || zip.replace(/\s/g, "").length < 4) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setStatus({ kind: "loading" });
      try {
        const qs = new URLSearchParams({ country, zip });
        // The city narrows the search only while the postcode is the address's own.
        if (ownZip == null && addressCity.trim()) qs.set("city", addressCity.trim().slice(0, 60));
        const res = await fetch(`/api/public/sessions/${sessionId}/pickup-points?${qs}`, { signal: ctrl.signal });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          setStatus({ kind: "error", message: body?.code ? errorText(L, body) : L.pickupError });
          return;
        }
        setStatus({ kind: "done", points: Array.isArray(body.points) ? body.points : [] });
      } catch {
        if (!ctrl.signal.aborted) setStatus({ kind: "error", message: L.pickupError });
      }
    }, 450);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [sessionId, country, zip, ownZip, addressCity, supported, searchKey, L]);

  const showList = !value || editing;
  const points = status.kind === "done" ? status.points : [];
  const statusText =
    !supported
      ? L.pickupUnsupported
      : status.kind === "loading"
        ? L.pickupLoading
        : status.kind === "error"
          ? status.message
          : status.kind === "done"
            ? points.length
              ? L.pickupFound(points.length)
              : L.pickupEmpty
            : "";

  function choose(p: PickupPointView) {
    onChange(p);
    setEditing(false);
  }

  return (
    <div className="mt-3 rounded-[var(--radius)] border border-neutral-200 bg-white p-4" data-field="pickup">
      <p id={`${uid}-title`} className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
        <MapPin className="h-4 w-4 text-[var(--accent)]" aria-hidden />
        {L.pickupTitle}
      </p>

      {value && !editing ? (
        <div className="flex flex-wrap items-start justify-between gap-2 text-sm">
          <p className="min-w-0 flex-1">
            <span className="font-medium">{L.pickupDeliveredAt(tidy(value.name))}</span>
            <span className="block text-neutral-600">
              {tidy(value.address1)}, {value.zip} {tidy(value.city)}
            </span>
          </p>
          <button
            type="button"
            id={inputId}
            onClick={() => {
              setEditing(true);
              requestAnimationFrame(() => listRef.current?.querySelector<HTMLInputElement>("input:checked, input[type=radio]")?.focus());
            }}
            className="min-h-11 shrink-0 px-1 font-medium text-[var(--text)] underline underline-offset-2"
            aria-label={`${L.pickupChange} — ${L.pickupTitle}`}
          >
            {L.pickupChange}
          </button>
        </div>
      ) : (
        <>
          <form
            className="flex gap-2"
            role="search"
            aria-label={L.pickupTitle}
            onSubmit={(e) => {
              e.preventDefault();
              setSearchKey((k) => k + 1);
            }}
          >
            <label htmlFor={inputId} className="sr-only">
              {L.pickupZip}
            </label>
            <input
              id={inputId}
              className="wc-input"
              value={ownZip ?? addressZip}
              placeholder={L.zip}
              autoComplete="postal-code"
              inputMode={country === "FR" || country === "DE" || country === "ES" || country === "IT" ? "numeric" : undefined}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${uid}-status${error ? ` ${inputId}-error` : ""}`}
              onChange={(e) => setOwnZip(e.target.value.slice(0, 12))}
            />
            <button
              type="submit"
              disabled={!supported || zip.length < 2}
              className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-[var(--radius)] border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 disabled:text-neutral-500"
            >
              <Search className="h-4 w-4" aria-hidden />
              {L.pickupSearch}
            </button>
          </form>

          <p id={`${uid}-status`} role="status" aria-live="polite" className="mt-2 flex items-center gap-2 text-sm text-neutral-600 empty:hidden">
            {status.kind === "loading" && <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-r-transparent motion-reduce:animate-none" aria-hidden />}
            {statusText}
          </p>

          {showList && points.length > 0 && (
            <div
              ref={listRef}
              role="radiogroup"
              aria-labelledby={`${uid}-list`}
              className="mt-2 max-h-[26rem] divide-y divide-neutral-200 overflow-y-auto overscroll-contain rounded-[var(--radius)] border border-neutral-200"
            >
              <span id={`${uid}-list`} className="sr-only">
                {L.pickupList}
              </span>
              {points.map((p) => {
                const checked = value?.id === p.id;
                const todays = p.hours?.[today]?.slots ?? [];
                const d = distance(p.distanceM, lang);
                const hoursOpen = openHours === p.id;
                return (
                  <div key={p.id} className={checked ? "bg-[color-mix(in_srgb,var(--accent)_6%,white)]" : undefined}>
                    <label className="flex min-h-14 cursor-pointer items-start gap-3 px-3 pt-3 pb-1">
                      <input
                        type="radio"
                        name={`${uid}-point`}
                        checked={checked}
                        onChange={() => choose(p)}
                        className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
                      />
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="flex items-baseline justify-between gap-2">
                          <span className="min-w-0 font-medium break-words">{tidy(p.name)}</span>
                          {d && <span className="shrink-0 text-xs text-neutral-600">{d}</span>}
                        </span>
                        <span className="block text-neutral-600">
                          {tidy(p.address1)}, {p.zip} {tidy(p.city)}
                        </span>
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-neutral-600">
                          <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
                          {todays.length ? `${L.pickupToday} : ${todays.join(" · ")}` : L.pickupClosedToday}
                        </span>
                      </span>
                    </label>
                    {p.hours && p.hours.length > 0 && (
                      <div className="pr-3 pb-2 pl-11">
                        <button
                          type="button"
                          aria-expanded={hoursOpen}
                          aria-controls={`${uid}-h-${p.id}`}
                          onClick={() => setOpenHours(hoursOpen ? null : p.id)}
                          className="inline-flex min-h-11 items-center gap-1 text-xs font-medium text-neutral-700 underline underline-offset-2"
                        >
                          {L.pickupHours}
                          <ChevronDown className={`h-3.5 w-3.5 transition-transform motion-reduce:transition-none ${hoursOpen ? "rotate-180" : ""}`} aria-hidden />
                        </button>
                        {hoursOpen && (
                          <dl id={`${uid}-h-${p.id}`} className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pb-1 text-xs">
                            {p.hours.slice(0, 7).map((h, i) => (
                              <div key={i} className={`contents ${i === today ? "font-semibold" : ""}`}>
                                <dt className="text-neutral-700">{days[i]}</dt>
                                <dd className="text-neutral-600">{h.slots.length ? h.slots.join(" · ") : L.pickupClosed}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {error && (
        <p id={`${inputId}-error`} className="mt-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
