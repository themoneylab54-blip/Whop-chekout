/*
 * PayPal timings shared by the checkout page (client) and the public session routes (server).
 * Plain constants only: no imports, so both sides can load this module.
 */

/**
 * How long after a "Pay" click (or a PayPal window opened from Whop's own button) a PAYING
 * session counts as a payment possibly still going through: the status route reports it in
 * flight, and the checkout waits that long before paying again. Short: never traps the buyer.
 */
export const PAYPAL_SERVER_IN_FLIGHT_MS = 30_000;

/**
 * How long a PayPal payment may still complete after its window closed: the checkout keeps checking
 * that long before another method, and the paypal-window route's `{ closed: true }` leaves the
 * window's heartbeat (paypalBeatAt) counting in flight that long, no longer.
 */
export const PAYPAL_AFTER_WINDOW_MS = 10_000;
