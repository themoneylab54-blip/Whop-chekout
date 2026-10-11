import { useEffect, useRef } from "react";
import { BOOT_FLAG, healthPath } from "./inlineWatchdog";

/*
 * The checkout page telling the server its payment form is missing (api/public/sessions/[id]/health):
 * a buyer left before a page without a way to pay is a sale lost that no one would otherwise see.
 * Best effort, never in the buyer's way: a beacon, nothing awaited, nothing shown.
 */

export type HealthReport =
  // The payment form neither shown, nor on its way, nor explained (no error, no blocking quote) well
  // after the page started: the page asks for it again (once).
  | { kind: "prepare_stuck"; provider: string; quote: boolean; paypal: boolean }
  // Whop's card form on the page this long without saying it is ready (a frame that never loads, a
  // screen of Whop's own).
  | { kind: "form_not_ready"; waitedMs: number }
  // The page's error screen (an error while it ran).
  | { kind: "page_error"; msg: string; digest?: string };

/** Sends one report (a beacon: it outlives the page). Never throws. */
export function reportHealth(sessionId: string, report: HealthReport): void {
  try {
    const body = JSON.stringify({ ...report, t: Math.round(performance.now()) });
    if (navigator.sendBeacon?.(healthPath(sessionId), body)) return;
    void fetch(healthPath(sessionId), { method: "POST", body, keepalive: true }).catch(() => undefined);
  } catch {
    /* no beacon, no fetch: nothing to do */
  }
}

/** How long after the page started a payment form still missing is taken for stuck. */
export const STUCK_AFTER_MS = 12_000;

/**
 * The page started (the inline watchdog's flag, see inlineWatchdog) and, STUCK_AFTER_MS later, a
 * payment form still `missing` (neither shown, nor on its way, nor explained) is reported and asked
 * again, once per page. `describe` says the state around it (no personal data).
 */
export function usePaymentWatchdog(sessionId: string | null, missing: boolean, describe: () => Extract<HealthReport, { kind: "prepare_stuck" }>, retry: () => void): void {
  // The latest state and callbacks, for the timer below (set after each render).
  const latest = useRef({ missing, describe, retry });
  useEffect(() => {
    latest.current = { missing, describe, retry };
  });
  useEffect(() => {
    (window as unknown as Record<string, unknown>)[BOOT_FLAG] = true;
  }, []);
  useEffect(() => {
    if (!sessionId) return;
    const t = setTimeout(() => {
      const l = latest.current;
      if (!l.missing) return;
      reportHealth(sessionId, l.describe());
      l.retry();
    }, STUCK_AFTER_MS);
    return () => clearTimeout(t);
  }, [sessionId]);
}
