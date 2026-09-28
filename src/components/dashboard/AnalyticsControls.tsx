import { tzOf } from "@/lib/time";
import Link from "next/link";
import { CalendarRange, FlaskConical, X } from "lucide-react";
import {
  PRESETS,
  includeTestFor,
  resolveRange,
  type DayRange,
  type Filters,
  type PresetKey,
} from "@/lib/analytics";
import { AutoSubmitForm } from "./AutoSubmitForm";
import { PopoverDetails } from "./Popover";
import { sourceLabel } from "./sources";

/*
 * Period presets (Aujourd'hui / Hier / 7 j / 30 j / 90 j / custom days in the store's time zone), dimension
 * filters (source, country, device) and the test-orders switch. Everything lives in the URL
 * so views can be bookmarked and shared.
 */

export type ControlState = {
  range: DayRange;
  filters: Filters;
  includeTest: boolean;
  testParam?: string;
};

export type ControlParams = {
  range?: string;
  from?: string;
  to?: string;
  source?: string;
  country?: string;
  device?: string;
  lang?: string;
  /** Visitor's country (IP), distinct from the shipping country. */
  geo?: string;
  test?: string;
};

/** Reads (and validates) period, filters and test switch from the search params. */
export function parseControls(
  sp: ControlParams,
  store: { testMode: boolean; timezone?: string | null },
): ControlState {
  const source = sp.source?.trim().slice(0, 100) || undefined;
  const country =
    sp.country && /^([A-Z]{2}|—)$/.test(sp.country) ? sp.country : undefined;
  const device =
    sp.device === "mobile" || sp.device === "desktop" ? sp.device : undefined;
  const lang = sp.lang && /^([a-z]{2,3}|inconnu)$/.test(sp.lang) ? sp.lang : undefined;
  const geo = sp.geo && /^([A-Z]{2}|inconnu)$/.test(sp.geo) ? sp.geo : undefined;
  return {
    range: resolveRange(sp, undefined, "30d", tzOf(store)),
    filters: { source, country, device, lang, geo },
    includeTest: includeTestFor(store, sp.test),
    testParam: sp.test === "0" || sp.test === "1" ? sp.test : undefined,
  };
}

/** Search params of a state, with overrides (undefined = drop). */
export function stateParams(
  s: ControlState,
  over: Record<string, string | undefined> = {},
): URLSearchParams {
  const p: Record<string, string | undefined> = {
    range: s.range.key === "30d" ? undefined : s.range.key,
    from: s.range.key === "custom" ? s.range.from : undefined,
    to: s.range.key === "custom" ? s.range.to : undefined,
    source: s.filters.source,
    country: s.filters.country,
    device: s.filters.device,
    lang: s.filters.lang,
    geo: s.filters.geo,
    test: s.testParam,
    ...over,
  };
  return new URLSearchParams(
    Object.entries(p).filter(([, v]) => v != null && v !== "") as [
      string,
      string,
    ][],
  );
}

export function hrefWith(
  base: string,
  s: ControlState,
  over: Record<string, string | undefined> = {},
) {
  const q = stateParams(s, over).toString();
  return q ? `${base}?${q}` : base;
}

const COUNTRY_NAMES = new Intl.DisplayNames(["fr"], { type: "region" });
const LANG_NAMES = new Intl.DisplayNames(["fr"], { type: "language" });
/** "fr" → "Français"; "inconnu" → "Langue inconnue". */
export function langName(code: string): string {
  if (code === "inconnu") return "Langue inconnue";
  try {
    const n = LANG_NAMES.of(code);
    return n ? n.charAt(0).toUpperCase() + n.slice(1) : code;
  } catch {
    return code;
  }
}
export function countryName(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return code === "—" ? "Non renseigné" : code;
  try {
    return COUNTRY_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

const pill = (active: boolean) =>
  `inline-flex min-h-8 shrink-0 items-center rounded-lg px-2.5 text-sm whitespace-nowrap transition ${active ? "bg-zinc-900 font-medium text-white shadow-sm" : "text-zinc-600 hover:text-zinc-900"}`;

export function AnalyticsControls({
  base,
  state,
  options,
  testMode,
  showFilters = true,
  showTest = true,
  keep = {},
  zone = "heure de Paris",
}: {
  base: string;
  state: ControlState;
  options: { sources: string[]; countries: string[]; langs?: string[] };
  testMode: boolean;
  showFilters?: boolean;
  /** Hide the test-orders switch (e.g. cross-store view, where each store follows its own mode). */
  showTest?: boolean;
  /** Extra params kept by every link and form (e.g. sort order). */
  keep?: Record<string, string | undefined>;
  /** Label of the time zone whose calendar days the period counts ("heure de New York"). */
  zone?: string;
}) {
  const { range, filters, includeTest } = state;
  const chips: { label: string; key: keyof Filters }[] = [
    ...(filters.source
      ? [{ label: `Source : ${sourceLabel(filters.source)}`, key: "source" as const }]
      : []),
    ...(filters.country
      ? [
          {
            label: `Pays : ${countryName(filters.country)}`,
            key: "country" as const,
          },
        ]
      : []),
    ...(filters.device
      ? [
          {
            label: filters.device === "mobile" ? "Mobile" : "Ordinateur",
            key: "device" as const,
          },
        ]
      : []),
    ...(filters.lang ? [{ label: `Langue : ${langName(filters.lang)}`, key: "lang" as const }] : []),
    ...(filters.geo ? [{ label: `Pays du visiteur : ${filters.geo === "inconnu" ? "inconnu" : countryName(filters.geo)}`, key: "geo" as const }] : []),
  ];
  const testHref = hrefWith(base, state, { ...keep, test: includeTest ? "0" : "1" });
  return (
    <div className="mb-5 space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* Phones: one select instead of a row of pills that would wrap. */}
        <AutoSubmitForm action={base} className="sm:hidden" aria-label="Période">
          {range.key === "custom" && (
            <>
              <input type="hidden" name="from" value={range.from} />
              <input type="hidden" name="to" value={range.to} />
            </>
          )}
          {filters.source && <input type="hidden" name="source" value={filters.source} />}
          {filters.country && <input type="hidden" name="country" value={filters.country} />}
          {filters.device && <input type="hidden" name="device" value={filters.device} />}
          {filters.lang && <input type="hidden" name="lang" value={filters.lang} />}
          {filters.geo && <input type="hidden" name="geo" value={filters.geo} />}
          {state.testParam && <input type="hidden" name="test" value={state.testParam} />}
          {Object.entries(keep).map(([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />)}
          <label className="flex items-center">
            <span className="sr-only">Période</span>
            <select
              name="range"
              defaultValue={range.key}
              className="min-h-10 rounded-xl border-0 bg-white py-1.5 pr-8 pl-3 text-sm font-medium text-zinc-900 shadow-[var(--shadow-card)]"
            >
              {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
                <option key={k} value={k}>
                  {PRESETS[k].long.charAt(0).toUpperCase() + PRESETS[k].long.slice(1)}
                </option>
              ))}
              {range.key === "custom" && <option value="custom">{range.label}</option>}
            </select>
          </label>
          <button className="sr-only focus:not-sr-only">OK</button>
        </AutoSubmitForm>
        <nav
          aria-label="Période"
          className="hidden max-w-full overflow-x-auto rounded-xl bg-white p-1 shadow-[var(--shadow-card)] [scrollbar-width:none] sm:flex"
        >
          {(Object.keys(PRESETS) as PresetKey[]).map((k) => (
            <Link
              key={k}
              href={hrefWith(base, state, {
                ...keep,
                range: k === "30d" ? undefined : k,
                from: undefined,
                to: undefined,
              })}
              aria-current={range.key === k ? "true" : undefined}
              className={pill(range.key === k)}
            >
              {PRESETS[k].label}
            </Link>
          ))}
        </nav>
        <PopoverDetails
          className="group relative"
          open={range.key === "custom" && !!range.error}
        >
          <summary
            className={`inline-flex min-h-10 cursor-pointer list-none items-center gap-1.5 rounded-xl px-3 text-sm shadow-[var(--shadow-card)] [&::-webkit-details-marker]:hidden ${range.key === "custom" ? "bg-zinc-900 font-medium text-white" : "bg-white text-zinc-700 hover:bg-zinc-50"}`}
          >
            <CalendarRange className="h-4 w-4" aria-hidden />
            {range.key === "custom" ? range.label : "Dates…"}
          </summary>
          <form
            method="get"
            action={base}
            className="absolute left-0 z-30 mt-1.5 hidden w-[min(20rem,calc(100vw-2rem))] space-y-3 group-open:block rounded-xl bg-white p-3 shadow-[var(--shadow-float)]"
          >
            <input type="hidden" name="range" value="custom" />
            {filters.source && (
              <input type="hidden" name="source" value={filters.source} />
            )}
            {filters.country && (
              <input type="hidden" name="country" value={filters.country} />
            )}
            {filters.device && (
              <input type="hidden" name="device" value={filters.device} />
            )}
            {filters.lang && <input type="hidden" name="lang" value={filters.lang} />}
            {filters.geo && <input type="hidden" name="geo" value={filters.geo} />}
          {filters.geo && <input type="hidden" name="geo" value={filters.geo} />}
            {state.testParam && (
              <input type="hidden" name="test" value={state.testParam} />
            )}
            {Object.entries(keep).map(
              ([k, v]) =>
                v && <input key={k} type="hidden" name={k} value={v} />,
            )}
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs font-medium text-zinc-700">
                Du
                <input
                  type="date"
                  lang="fr"
                  name="from"
                  required
                  defaultValue={range.from}
                  max={range.to}
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
                />
              </label>
              <label className="text-xs font-medium text-zinc-700">
                Au
                <input
                  type="date"
                  lang="fr"
                  name="to"
                  required
                  defaultValue={range.to}
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-2 py-1.5 text-sm"
                />
              </label>
            </div>
            <p className="text-[11px] text-zinc-500">
              Jours calendaires ({zone}), bornes incluses (366 jours max.).
            </p>
            <button className="w-full rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800">
              Appliquer
            </button>
          </form>
        </PopoverDetails>
        {showTest && (
          <Link
            href={testHref}
            className={`inline-flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-sm shadow-[var(--shadow-card)] ${includeTest ? "bg-amber-50 text-amber-900 ring-1 ring-amber-600/20" : "bg-white text-zinc-600 hover:bg-zinc-50"}`}
            title={
              includeTest
                ? "Cliquer pour n'afficher que les commandes réelles"
                : "Cliquer pour inclure les commandes de test"
            }
          >
            <FlaskConical className="h-4 w-4" aria-hidden />
            {includeTest
              ? testMode
                ? "Mode test : commandes test incluses"
                : "Commandes test incluses"
              : "Commandes réelles"}
          </Link>
        )}
      </div>

      {showFilters && (
        <AutoSubmitForm
          action={base}
          // Phones: two selects per row, full width (no ragged wrap); wider screens: one line.
          className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center"
          aria-label="Filtres"
        >
          {range.key !== "30d" && (
            <input type="hidden" name="range" value={range.key} />
          )}
          {range.key === "custom" && (
            <>
              <input type="hidden" name="from" value={range.from} />
              <input type="hidden" name="to" value={range.to} />
            </>
          )}
          {state.testParam && (
            <input type="hidden" name="test" value={state.testParam} />
          )}
          {Object.entries(keep).map(
            ([k, v]) => v && <input key={k} type="hidden" name={k} value={v} />,
          )}
          {filters.geo && <input type="hidden" name="geo" value={filters.geo} />}
          <FilterSelect
            name="source"
            label="Source"
            value={filters.source}
            options={options.sources.map((s) => [s, sourceLabel(s)])}
            all="Toutes les sources"
          />
          <FilterSelect
            name="country"
            label="Pays de livraison"
            value={filters.country}
            options={options.countries.map((c) => [c, countryName(c)])}
            all="Tous les pays"
          />
          <FilterSelect
            name="device"
            label="Appareil"
            value={filters.device}
            options={[
              ["mobile", "Mobile"],
              ["desktop", "Ordinateur"],
            ]}
            all="Tous les appareils"
          />
          {((options.langs?.length ?? 0) > 0 || filters.lang) && (
            <FilterSelect
              name="lang"
              label="Langue du checkout"
              value={filters.lang}
              options={(options.langs ?? []).map((l) => [l, langName(l)])}
              all="Toutes les langues"
            />
          )}
          {/* Filters apply on change; the button stays for keyboard users without JavaScript. */}
          <button className="sr-only rounded-lg bg-white px-3 text-sm font-medium text-indigo-700 focus:not-sr-only focus:min-h-9">
            Filtrer
          </button>
          {chips.length > 0 && (
            <div className="col-span-2 flex flex-wrap gap-2 sm:contents">
              {chips.map((c) => (
                <Link
                  key={c.key}
                  href={hrefWith(base, state, { ...keep, [c.key]: undefined })}
                  className="inline-flex min-h-8 items-center gap-1 rounded-full bg-indigo-50 px-2.5 text-xs font-medium text-indigo-800 ring-1 ring-indigo-600/15 hover:bg-indigo-100"
                >
                  {c.label} <X className="h-3 w-3" aria-hidden />
                  <span className="sr-only">(retirer ce filtre)</span>
                </Link>
              ))}
            </div>
          )}
        </AutoSubmitForm>
      )}
    </div>
  );
}

function FilterSelect({
  name,
  label,
  value,
  options,
  all,
}: {
  name: string;
  label: string;
  value?: string;
  options: [string, string][];
  all: string;
}) {
  const known = !value || options.some(([v]) => v === value);
  return (
    <label className="relative min-w-0">
      <span className="sr-only">{label}</span>
      <select
        name={name}
        defaultValue={value ?? ""}
        className={`min-h-10 w-full min-w-0 truncate rounded-lg sm:min-h-9 sm:w-auto sm:max-w-[13rem] border bg-white py-1.5 pr-7 pl-2.5 text-sm shadow-[0_1px_1px_rgba(16,24,40,.04)] ${value ? "border-indigo-300 text-indigo-900" : "border-zinc-200 text-zinc-700"}`}
      >
        <option value="">{all}</option>
        {!known && <option value={value}>{value}</option>}
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
