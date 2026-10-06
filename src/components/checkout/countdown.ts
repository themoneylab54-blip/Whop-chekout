import type { CountdownFormat, CountdownRestart } from "@/lib/layout";

/**
 * Countdown block logic, pure (server and browser, no React): timer text, {timer} placement and
 * the evergreen timer per visitor (start time, restart at zero, remembered remaining time).
 */

/** Placeholder of the countdown text where the timer goes. */
export const TIMER_TOKEN = "{timer}";

/** The text around the timer: `{timer}` places it, else it follows the text. */
export function splitTimerText(text: string): { before: string; after: string; inline: boolean } {
  const i = text.indexOf(TIMER_TOKEN);
  if (i < 0) return { before: text, after: "", inline: false };
  // Only the first {timer} is the timer; any other one is dropped (no second timer).
  return { before: text.slice(0, i), after: text.slice(i + TIMER_TOKEN.length).split(TIMER_TOKEN).join(""), inline: true };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Remaining time as shown: "hms" 01:59:59 (days first for long date countdowns: 2j 01:59:59),
 * "ms" 119:59 (total minutes), "words" 1 h 59 min (seconds only under an hour, days first).
 */
export function formatTimer(ms: number, format: CountdownFormat, daysShort: string, withDays = false): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const days = withDays ? Math.floor(total / 86400) : 0;
  const rest = total - days * 86400;
  const h = Math.floor(rest / 3600);
  const m = Math.floor((rest % 3600) / 60);
  const s = rest % 60;
  if (format === "ms") return `${pad(Math.floor(total / 60))}:${pad(s)}`;
  if (format === "words") {
    if (days) return `${days} ${daysShort} ${h} h`;
    if (h) return `${h} h ${pad(m)} min`;
    if (m) return `${m} min ${pad(s)} s`;
    return `${s} s`;
  }
  return (days ? `${days}${daysShort} ` : "") + [h, m, s].map(pad).join(":");
}

/**
 * Remaining time spoken by screen readers: whole minutes (rounded up), so the label changes at
 * most once a minute. "1 h 05 min", "14 min".
 */
export function spokenTimer(ms: number, daysShort: string, withDays = false): string {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return formatTimer(minutes * 60000, "words", daysShort, withDays);
}

/**
 * Evergreen timer: time left at `now` for a timer started at `startedAt`. It starts over from the
 * full duration each time it reaches zero (a loop), so a tab left in the background or a computer
 * asleep comes back on the right second. Never 0: at zero it is already the full duration again.
 */
export function evergreenRemaining(startedAt: number, durationMs: number, now: number): number {
  if (!(durationMs > 0)) return 0;
  const elapsed = now - startedAt;
  if (!Number.isFinite(elapsed) || elapsed < 0) return durationMs;
  return durationMs - (elapsed % durationMs);
}

/** Browser storage of the visitor's timer start ("keep"): one entry per store and block. */
export function evergreenStorageKey(storeKey: string | null | undefined, blockId: string): string {
  return `wc-countdown:${storeKey || "-"}:${blockId}`;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

/**
 * When this visitor's timer started. "each_visit": now (full duration on every page load).
 * "keep": the start remembered in the visitor's browser for this block (same duration), else now,
 * remembered. Storage unavailable (private mode, blocked, full): now, like "each_visit".
 */
export function evergreenStart(opts: {
  restart: CountdownRestart;
  durationMs: number;
  now: number;
  key: string;
  storage: Storage | null;
}): number {
  const { restart, durationMs, now, key, storage } = opts;
  if (restart !== "keep" || !storage) return now;
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const saved = JSON.parse(raw) as { start?: unknown; duration?: unknown };
      // A start in the future (clock changed) or for another duration is started over.
      if (typeof saved.start === "number" && saved.duration === durationMs && saved.start <= now) return saved.start;
    }
  } catch {
    /* unreadable: started over below */
  }
  try {
    storage.setItem(key, JSON.stringify({ start: now, duration: durationMs }));
  } catch {
    /* storage full or blocked: this visit only */
  }
  return now;
}

/** The page's localStorage, or null where it is unavailable (server, blocked, private mode). */
export function browserStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}
