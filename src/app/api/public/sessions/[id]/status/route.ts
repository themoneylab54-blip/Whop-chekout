import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { route } from "@/lib/route";
import { parseArmKey } from "@/lib/layout";
import { inFlightMethod, markPaid, stripeIdsStale, syncOrderSafely } from "@/lib/checkout";
import { paymentInfoFromStripe, retrievePaymentIntent, STRIPE_PAGE_CALL } from "@/lib/stripe";
import { rateLimit } from "@/lib/ratelimit";
import { log } from "@/lib/log";
import { after } from "next/server";

/** Polled by the page: its Stripe checks are short (STRIPE_PAGE_CALL) and parallel; a paid one's markPaid fits well within. */
export const maxDuration = 30;

async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = await db.checkoutSession.findUnique({
    where: { id },
    select: {
      status: true,
      shopifyOrderName: true,
      payClickedAt: true,
      paypalWindowAt: true,
      paypalBeatAt: true,
      paymentProvider: true,
      stripePaymentIntentId: true,
      stripeAccountId: true,
      test: true,
      store: { select: { id: true, checkoutDomain: true, testMode: true, stripeAccountId: true } },
      upsells: { select: { blockId: true, status: true, shopifyOrderName: true } },
    },
  });
  if (!s) return json({ error: "Session introuvable" }, { status: 404 });
  const { upsells, store, payClickedAt, paypalWindowAt, paypalBeatAt, paymentProvider, stripePaymentIntentId, stripeAccountId, test, ...rest } = s;
  // Another store's checkout domain never serves this session (see isForeignCheckoutHost).
  if (await isForeignCheckoutHost(req, store)) return json({ error: "Session introuvable" }, { status: 404 });
  // Stripe: the webhook marks the session paid; should it be late (or lost), a PAYING session whose
  // PaymentIntent already succeeded is marked paid from here (the thank-you page polls this after a
  // 3-D Secure or bank redirect). Same markPaid as the webhook (idempotent), a few checks a minute.
  // The session's previous PaymentIntents recorded on its snapshots (replaced after a total change,
  // a stale tab) are checked too: one paid there is never missed. The checks run in parallel, each
  // short and never retried (STRIPE_PAGE_CALL): a slow Stripe never holds the page's poll. Ids of
  // another connected account or mode (see stripeIdsStale) are not Stripe's to answer here.
  if (
    rest.status === "PAYING" &&
    paymentProvider === "stripe" &&
    stripePaymentIntentId &&
    store.stripeAccountId &&
    !stripeIdsStale({ stripeAccountId, test, store }) &&
    (await rateLimit(`status:pi:${id}`, 6))
  ) {
    try {
      const previous = await db.checkoutQuote.findMany({
        where: { sessionId: id, stripePaymentIntentId: { not: null, notIn: [stripePaymentIntentId] } },
        orderBy: { createdAt: "desc" },
        take: 3,
        select: { stripePaymentIntentId: true },
      });
      const ids = [stripePaymentIntentId, ...previous.map((q) => q.stripePaymentIntentId!)];
      const pis = await Promise.all(
        ids.map((piId) =>
          retrievePaymentIntent(store, piId, STRIPE_PAGE_CALL).catch((err: unknown) => {
            log.warn("stripe.status_check_failed", "Could not check one of the session's PaymentIntents", { sessionId: id, paymentIntentId: piId, err });
            return null;
          }),
        ),
      );
      const pi = pis.find((p) => p?.status === "succeeded" && p.metadata?.checkout_session_id === id);
      if (pi) {
        const syncLater = await markPaid(id, paymentInfoFromStripe(pi), { deferSync: true });
        if (syncLater) after(() => syncOrderSafely(id).then(() => undefined));
        const now = await db.checkoutSession.findUnique({ where: { id }, select: { status: true, shopifyOrderName: true } });
        if (now) Object.assign(rest, now);
      }
    } catch (err) {
      log.warn("stripe.status_check_failed", "Could not check the session's PaymentIntent", { sessionId: id, err });
    }
  }
  // One-click offers by block (arm suffix removed): the thank-you page polls this when an
  // accepted offer's outcome is unknown (server error, lost connection).
  const offers = Object.fromEntries(upsells.map((u) => [parseArmKey(u.blockId).blockId, { status: u.status, orderName: u.shopifyOrderName }]));
  // A payment submitted moments ago may still be completing (e.g. a PayPal window): the checkout
  // waits before offering another method. The same formula pay refuses another method with
  // (inFlightMethod: the latest of the "Pay" click, a PayPal window and its heartbeat; an OPEN or
  // FAILED session only through a later window or beat). Only this derived flag is exposed, never
  // the timestamps.
  const paymentInFlight = inFlightMethod({ status: rest.status, payClickedAt, paypalWindowAt, paypalBeatAt }) !== null;
  return json({ ...rest, paymentInFlight, upsells: offers }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = route("sessions.status", handle);
