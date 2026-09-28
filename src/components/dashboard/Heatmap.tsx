import { int, pct } from "./AnalyticsKit";
import { BEST_SLOT_MIN_CHECKOUTS, bestSlots, wilsonLowerBound } from "@/lib/heat";

/*
 * Day-of-week × hour heatmap (in the store's time zone, labelled by `zone`), as a real table: row/column headers, each cell's
 * value in text for screen readers and in a tooltip, a legend, and a text summary of the best
 * slots. Shade = conversion (paid ÷ opened checkouts) or CA HT; cells with too few checkouts
 * for a meaningful rate are hatched instead of colored.
 */

const DAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const DAYS_LONG = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const MIN_SESSIONS = 5;
// Sequential indigo steps (light → dark); text never sits on them, so contrast is about the fill vs white (≥ 3:1 from step 3).
const STEPS = ["#eef2ff", "#c7d2fe", "#818cf8", "#4f46e5", "#312e81"];

export type HeatCell = { dow: number; hour: number; sessions: number; orders: number; revenueHtCents: number };

/** `zone`: the store's time zone label (zoneLabel, e.g. "heure de New York"): the days and hours are in it. */
export function Heatmap({ cells, metric, money, zone = "heure de Paris" }: { cells: HeatCell[]; metric: "conversion" | "revenue"; money: (c: number) => string; zone?: string }) {
  const at = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c]));
  const valueOf = (c: HeatCell | undefined) => (!c ? null : metric === "revenue" ? c.revenueHtCents : c.sessions >= MIN_SESSIONS ? c.orders / c.sessions : null);
  const values = cells.map(valueOf).filter((v): v is number => v != null && v > 0);
  const max = values.length ? Math.max(...values) : 0;
  const step = (v: number | null) => (v == null || v <= 0 || !max ? -1 : Math.min(STEPS.length - 1, Math.floor((v / max) * STEPS.length)));
  const fmt = (v: number) => (metric === "revenue" ? money(v) : pct(v, 1));
  const describe = (d: number, h: number) => {
    const c = at.get(`${d}-${h}`);
    const base = `${DAYS_LONG[d - 1]} ${h} h : ${int(c?.sessions ?? 0)} checkout(s), ${int(c?.orders ?? 0)} payé(s)`;
    const v = valueOf(c);
    return metric === "revenue" ? `${base}, ${money(c?.revenueHtCents ?? 0)} HT` : v == null ? `${base} (trop peu de checkouts pour un taux)` : `${base}, conversion ${pct(v, 1)}`;
  };
  // Best slots: ranked by the Wilson lower bound of the conversion (not the raw rate), and only
  // slots with at least BEST_SLOT_MIN_CHECKOUTS checkouts, so 2 sales out of 3 visits never "win".
  const best = bestSlots(cells, metric);
  const summary = best.length
    ? `Meilleurs créneaux (au moins ${BEST_SLOT_MIN_CHECKOUTS} checkouts, classés ${metric === "revenue" ? "par CA HT" : "par borne basse de l'intervalle de confiance à 95 % de la conversion"}) : ${best
        .map((b) =>
          metric === "revenue"
            ? `${DAYS_LONG[b.cell.dow - 1]} ${b.cell.hour} h (${money(b.cell.revenueHtCents)}, ${int(b.cell.sessions)} checkouts)`
            : `${DAYS_LONG[b.cell.dow - 1]} ${b.cell.hour} h (${pct(b.rate, 1)}, au moins ${pct(wilsonLowerBound(b.cell.orders, b.cell.sessions), 1)} sur ${int(b.cell.sessions)} checkouts)`,
        )
        .join(", ")}.`
    : `Aucun créneau n'a encore ${BEST_SLOT_MIN_CHECKOUTS} checkouts sur la période : pas de meilleur créneau fiable.`;
  // Slots without any checkout: summarized once for screen readers (each empty cell then just reads "0"),
  // instead of up to 168 identical sentences.
  const isEmpty = (c: HeatCell | undefined) => !c || (c.sessions <= 0 && c.orders <= 0 && c.revenueHtCents <= 0);
  const emptySlots = 7 * 24 - new Set(cells.filter((c) => !isEmpty(c)).map((c) => `${c.dow}-${c.hour}`)).size;
  const emptySummary = emptySlots
    ? `${int(emptySlots)} créneau${emptySlots > 1 ? "x" : ""} sur 168 sans aucun checkout ni vente (cellules à 0).`
    : "Chaque créneau a au moins un checkout.";

  return (
    <figure>
      <div className="relative -mx-5 overflow-x-auto px-5 [scrollbar-width:thin]" tabIndex={0} role="region" aria-label={`Carte de chaleur ${metric === "revenue" ? "du CA HT" : "de la conversion"} par jour et heure`}>
        <table className="w-full min-w-[620px] border-separate border-spacing-[2px] text-[11px]">
          <caption className="sr-only">
            {metric === "revenue" ? "CA HT" : "Conversion (checkouts payés ÷ ouverts)"} par jour de la semaine et heure ({zone}). {emptySummary} {summary}
          </caption>
          <thead>
            <tr>
              <th scope="col" className="w-9">
                <span className="sr-only">Jour</span>
              </th>
              {Array.from({ length: 24 }, (_, h) => (
                <th key={h} scope="col" className="font-normal text-zinc-500 tabular-nums">
                  {h % 3 === 0 ? h : <span className="sr-only">{h}</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {DAYS.map((label, i) => (
              <tr key={label}>
                <th scope="row" className="pr-1 text-left font-medium text-zinc-600">
                  {label}
                </th>
                {Array.from({ length: 24 }, (_, h) => {
                  const c = at.get(`${i + 1}-${h}`);
                  const v = valueOf(c);
                  const s = step(v);
                  const thin = metric === "conversion" && (c?.sessions ?? 0) > 0 && v == null;
                  const empty = isEmpty(c);
                  return (
                    <td
                      key={h}
                      title={empty ? `${DAYS_LONG[i]} ${h} h : aucun checkout ni vente` : describe(i + 1, h)}
                      className={`h-6 min-w-[20px] rounded-[3px] ${s < 0 ? (thin ? "bg-[repeating-linear-gradient(45deg,#f4f4f5,#f4f4f5_3px,#e4e4e7_3px,#e4e4e7_5px)]" : "bg-zinc-100") : ""}`}
                      style={s >= 0 ? { backgroundColor: STEPS[s] } : undefined}
                    >
                      <span className="sr-only">{empty ? "0" : describe(i + 1, h)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-zinc-500">
        <span className="flex items-center gap-1" aria-hidden>
          Faible
          {STEPS.map((c) => (
            <span key={c} className="inline-block h-3 w-4 rounded-[2px]" style={{ backgroundColor: c }} />
          ))}
          Fort{max ? ` (max. ${fmt(max)})` : ""}
          {metric === "conversion" && (
            <>
              <span className="ml-2 inline-block h-3 w-4 rounded-[2px] bg-[repeating-linear-gradient(45deg,#f4f4f5,#f4f4f5_3px,#e4e4e7_3px,#e4e4e7_5px)]" /> moins de {MIN_SESSIONS} checkouts
            </>
          )}
        </span>
        <span>{summary}</span>
      </figcaption>
    </figure>
  );
}
