import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { route } from "@/lib/route";
import { parseArmKey } from "@/lib/layout";
import { inFlightMethod } from "@/lib/checkout";

async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = await db.checkoutSession.findUnique({
    where: { id },
    select: { status: true, shopifyOrderName: true, payClickedAt: true, paypalWindowAt: true, paypalBeatAt: true, store: { select: { id: true, checkoutDomain: true } }, upsells: { select: { blockId: true, status: true, shopifyOrderName: true } } },
  });
  if (!s) return json({ error: "Session introuvable" }, { status: 404 });
  const { upsells, store, payClickedAt, paypalWindowAt, paypalBeatAt, ...rest } = s;
  // Another store's checkout domain never serves this session (see isForeignCheckoutHost).
  if (await isForeignCheckoutHost(req, store)) return json({ error: "Session introuvable" }, { status: 404 });
  // One-click offers by block (arm suffix removed): the thank-you page polls this when an
  // accepted offer's outcome is unknown (server error, lost connection).
  const offers = Object.fromEntries(upsells.map((u) => [parseArmKey(u.blockId).blockId, { status: u.status, orderName: u.shopifyOrderName }]));
  // A payment submitted moments ago may still be completing (e.g. a PayPal window): the checkout
  // waits before offering another method. The same formula pay refuses another method with
  // (inFlightMethod: the latest of the "Pay" click, a PayPal window and its heartbeat; an OPEN or
  // FAILED session only through a later window or beat). Only this derived flag is exposed, never
  // the timestamps.
  const paymentInFlight = inFlightMethod({ status: s.status, payClickedAt, paypalWindowAt, paypalBeatAt }) !== null;
  return json({ ...rest, paymentInFlight, upsells: offers }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = route("sessions.status", handle);
