import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { isSameSiteRequest } from "@/lib/host-guard";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/route";
import { PAYPAL_AFTER_WINDOW_MS, PAYPAL_SERVER_IN_FLIGHT_MS } from "@/lib/paypal-timing";

/**
 * A PayPal window opened from Whop's own button inside the embed (after a blocked window): no
 * "Pay" of ours went with it, so the session is marked PAYING again with a fresh window time
 * (paypalWindowAt; payClickedAt, the buyer's own click, is left alone; a FAILED session keeps
 * its status and only gets the window time), and the status route
 * reports that payment in flight like any other (see PAYPAL_SERVER_IN_FLIGHT_MS). Only for a
 * session already confirmed once (Whop's button only shows after that) that is still OPEN,
 * PAYING or FAILED (never a PAID or ABANDONED one); no body, nothing returned but ok.
 *
 * With `{ "blocked": true }`: the browser blocked the window of our own PayPal confirm, so no PayPal
 * payment can be going through. The session leaves that attempt (back to OPEN, paypalWindowAt
 * cleared) so the buyer can switch to the card at once instead of waiting out the in-flight window
 * (see inFlightMethod). Only while that confirm is still the latest attempt (PAYING, window time
 * equal to the click time): a card click or a window from Whop's own button since is left alone.
 *
 * With `{ "beat": true }`: the heartbeat of an open PayPal window (every ~20 s), or our own popup
 * opening late after a "blocked" verdict. Liveness only: stamps paypalBeatAt, never paypalWindowAt
 * nor the status, so inFlightMethod keeps the payment in flight while the payment.failed webhook's
 * stale check (payClickedAt / paypalWindowAt, the real attempts) still sees the current attempt as
 * the latest. Only for a session confirmed once that is OPEN, PAYING or FAILED.
 *
 * With `{ "closed": true }`: that window closed (or the buyer said so). The heartbeat stops counting
 * past PAYPAL_AFTER_WINDOW_MS from now (the payment may still complete just after the window):
 * paypalBeatAt is lowered to now − (PAYPAL_SERVER_IN_FLIGHT_MS − PAYPAL_AFTER_WINDOW_MS), never
 * raised, so a long window's lock ends ~10 s after it closed. The window and click times are left
 * alone (a window closed within 30 s of its submit stays in flight until then, as before).
 */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // Only the checkout page itself calls this (a same-origin fetch): never another site.
  if (!isSameSiteRequest(req)) return json({ error: "Requête refusée", code: "cross_site" }, { status: 403 });
  if (!(await rateLimit(`paypal-window:ip:${clientIp(req)}`, 30)) || !(await rateLimit(`paypal-window:s:${id}`, 10))) {
    return json({ error: "Trop de requêtes, réessayez dans une minute.", code: "rate_limited" }, { status: 429 });
  }
  const session = await db.checkoutSession.findUnique({ where: { id }, select: { store: { select: { id: true, checkoutDomain: true } } } });
  // Another store's checkout domain never serves this session (see isForeignCheckoutHost).
  if (!session || (await isForeignCheckoutHost(req, session.store))) return json({ error: "Session introuvable" }, { status: 404 });
  const body = (await req.json().catch(() => null)) as { blocked?: unknown; beat?: unknown; closed?: unknown } | null;
  if (body?.beat === true) {
    const beat = await db.checkoutSession.updateMany({
      where: { id, status: { in: ["OPEN", "PAYING", "FAILED"] }, payClickedAt: { not: null }, whopCheckoutId: { not: null } },
      data: { paypalBeatAt: new Date() },
    });
    return json({ ok: true, beat: beat.count > 0 });
  }
  if (body?.closed === true) {
    const until = new Date(Date.now() - (PAYPAL_SERVER_IN_FLIGHT_MS - PAYPAL_AFTER_WINDOW_MS));
    const lowered = await db.checkoutSession.updateMany({ where: { id, status: { not: "PAID" }, paypalBeatAt: { gt: until } }, data: { paypalBeatAt: until } });
    return json({ ok: true, lowered: lowered.count > 0 });
  }
  if (body?.blocked === true) {
    const s = await db.checkoutSession.findUnique({ where: { id }, select: { status: true, payClickedAt: true, paypalWindowAt: true } });
    const ownAttempt = s?.status === "PAYING" && !!s.payClickedAt && s.paypalWindowAt?.getTime() === s.payClickedAt.getTime();
    // Compare-and-set on the times read: an attempt landing meanwhile is never erased.
    const cleared = ownAttempt
      ? await db.checkoutSession.updateMany({ where: { id, status: "PAYING", payClickedAt: s.payClickedAt, paypalWindowAt: s.paypalWindowAt }, data: { status: "OPEN", paypalWindowAt: null } })
      : { count: 0 };
    return json({ ok: true, cleared: cleared.count > 0 });
  }
  const confirmedOnce = { payClickedAt: { not: null }, whopCheckoutId: { not: null } };
  const now = new Date();
  let marked = await db.checkoutSession.updateMany({
    where: { id, status: { in: ["OPEN", "PAYING"] }, ...confirmedOnce },
    data: { status: "PAYING", paypalWindowAt: now },
  });
  // A FAILED session stays FAILED (a failed card's outcome is not rewritten by a window we can't
  // confirm): only the window time is kept, and the status route reports it in flight from it.
  if (!marked.count) marked = await db.checkoutSession.updateMany({ where: { id, status: "FAILED", ...confirmedOnce }, data: { paypalWindowAt: now } });
  return json({ ok: true, marked: marked.count > 0 });
}

export const POST = route("sessions.paypal_window", handle);
