import { useEffect, useRef } from "react";
import { BOOT_FLAG, WATCH_FLAG, healthPath, type WatchState } from "./inlineWatchdog";

/*
 * The checkout page telling the server its payment form is missing (api/public/sessions/[id]/health):
 * a buyer left before a page without a way to pay is a sale that may be lost, and no one would
 * otherwise see it. Best effort, never in the buyer's way: a beacon, nothing awaited, nothing shown.
 * Each report carries the page's state around it (no personal data), its first errors and the
 * version that served it (from the inline watchdog).
 */

/** The page's state in a report (whatever applies). */
type PageState = {
  provider?: string;
  prepared?: boolean;
  preparing?: boolean;
  quote?: boolean;
  paypal?: boolean;
};

export type HealthReport =
  // The payment form neither shown, nor on its way, nor explained (no error, no blocking quote) for
  // STUCK_AFTER_MS without a break: the page asks for it again (once).
  | ({ kind: "prepare_stuck" } & PageState)
  // A request for the payment form on its way for SLOW_AFTER_MS without a break (logs only).
  | ({ kind: "prepare_slow" } & PageState)
  // The buyer left the page (after LEFT_MIN_MS) without the payment form ever ready (logs only).
  | ({ kind: "left_without_form" } & PageState)
  // Whop's card form on the page this long without saying it is ready (a frame that never loads, a
  // screen of Whop's own): whether its frame is there, the last state it said.
  | { kind: "form_not_ready"; waitedMs: number; frame: boolean; lastState: string | null }
  // The page's first prepare, sent while its HTML was read, failed or never answered: the page asked
  // again (logs only).
  | { kind: "inline_prepare_failed"; reason: "timeout" | "network" }
  // The page's error screen (an error while it ran).
  | { kind: "page_error"; msg: string; digest?: string };

/** Sends one report (a beacon: it outlives the page). Never throws. */
export function reportHealth(sessionId: string, report: HealthReport): void {
  try {
    const watch = (window as unknown as Record<string, WatchState | undefined>)[WATCH_FLAG];
    const body = JSON.stringify({
      ...report,
      t: Math.round(performance.now()),
      visible: document.visibilityState,
      online: navigator.onLine,
      ...(watch ? { dpl: watch.dpl, errors: watch.errors, dropped: watch.dropped } : {}),
    });
    if (navigator.sendBeacon?.(healthPath(sessionId), body)) return;
    void fetch(healthPath(sessionId), { method: "POST", body, keepalive: true }).catch(() => undefined);
  } catch {
    /* no beacon, no fetch: nothing to do */
  }
}

/** How long a payment form may stay missing (without a break) before it is taken for stuck. */
export const STUCK_AFTER_MS = 12_000;
/** How long a request for the payment form may stay on its way (without a break) before it is reported. */
export const SLOW_AFTER_MS = 20_000;
/** A buyer leaving sooner than this after the page opened is a bounce, not a missing form. */
export const LEFT_MIN_MS = 5_000;

/**
 * The card form missing: neither shown (no checkout prepared), nor on its way (no request, no
 * quantity being confirmed), nor explained (no error shown, no quote blocking it: no shipping, a
 * refused code; no payment going through; PayPal not chosen). Pure.
 */
export function paymentFormMissing(s: {
  prepared: boolean;
  preparing: boolean;
  qtyPending: boolean;
  prepareError: boolean;
  quoteBlocking: boolean;
  inFlightAtLoad: boolean;
  paypalActive: boolean;
}): boolean {
  return !s.prepared && !s.preparing && !s.qtyPending && !s.prepareError && !s.quoteBlocking && !s.inFlightAtLoad && !s.paypalActive;
}

type WatchedKind = "prepare_stuck" | "prepare_slow" | "left_without_form";

/**
 * The page started (the inline watchdog stands down, see inlineWatchdog). Then, once each per page:
 * a payment form `missing` for STUCK_AFTER_MS without a break is reported and asked again (`retry`); a
 * request `preparing` for SLOW_AFTER_MS without a break is reported; leaving the page (after
 * LEFT_MIN_MS) without the form ever `formReady` is reported. `describe` says the page's state.
 */
export function usePaymentWatchdog(
  sessionId: string | null,
  s: { missing: boolean; preparing: boolean; formReady: boolean; describe: (kind: WatchedKind) => Extract<HealthReport, { kind: WatchedKind }> },
  retry: () => void,
): void {
  // The latest state and callbacks, for the timers and the pagehide listener (set after each render).
  const latest = useRef({ s, retry });
  useEffect(() => {
    latest.current = { s, retry };
  });
  const fired = useRef({ stuck: false, slow: false, left: false });
  useEffect(() => {
    (window as unknown as Record<string, unknown>)[BOOT_FLAG] = true;
  }, []);
  useEffect(() => {
    if (!sessionId || !s.missing || fired.current.stuck) return;
    const t = setTimeout(() => {
      fired.current.stuck = true;
      reportHealth(sessionId, latest.current.s.describe("prepare_stuck"));
      latest.current.retry();
    }, STUCK_AFTER_MS);
    return () => clearTimeout(t);
  }, [sessionId, s.missing]);
  useEffect(() => {
    if (!sessionId || !s.preparing || fired.current.slow) return;
    const t = setTimeout(() => {
      fired.current.slow = true;
      reportHealth(sessionId, latest.current.s.describe("prepare_slow"));
    }, SLOW_AFTER_MS);
    return () => clearTimeout(t);
  }, [sessionId, s.preparing]);
  useEffect(() => {
    if (!sessionId) return;
    const onHide = () => {
      const l = latest.current.s;
      if (fired.current.left || l.formReady || performance.now() < LEFT_MIN_MS) return;
      fired.current.left = true;
      reportHealth(sessionId, l.describe("left_without_form"));
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [sessionId]);
}
