import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { json, readJson } from "@/lib/http";
import { CheckoutError, journalCheckoutFailure, confirmSession, paySchema, paymentPayload } from "@/lib/checkout";
import { after } from "next/server";
import { route } from "@/lib/route";
import { sendPaymentInfoConversions } from "@/lib/conversions";

/** A processor slow to answer at the Pay click, then the other one prepared in the same request. */
export const maxDuration = 60;

/** Saves the buyer's details just before the embedded Whop form is submitted. */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`pay:ip:${clientIp(req)}`, 20)) || !(await rateLimit(`pay:s:${id}`, 15))) return json({ error: "Trop de requêtes, réessayez dans une minute.", code: "rate_limited" }, { status: 429 });
  const parsed = paySchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return json({ error: "Merci de vérifier vos informations", issues: parsed.error.issues.map((i) => i.path.join(".")) }, { status: 400 });
  }
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  // Another store's checkout domain never serves this session (see isForeignCheckoutHost).
  if (!session || (await isForeignCheckoutHost(req, session.store))) return json({ error: "Session introuvable" }, { status: 404 });
  try {
    const result = await confirmSession(session, parsed.data, { host: req.headers.get("host") });
    after(() => sendPaymentInfoConversions(session.id).catch(() => undefined));
    // Whop: the configuration to submit; Stripe: the PaymentIntent the page confirms (or a fresh one to mount first).
    return json({ ready: result.ready, totals: result.totals, ...paymentPayload(result, session.store) });
  } catch (err) {
    await journalCheckoutFailure(session, "pay", err);
    if (err instanceof CheckoutError) return json({ error: err.message, code: err.code }, { status: 400 });
    return json({ error: "Le paiement n'a pas pu être initialisé. Réessayez.", code: "init_failed" }, { status: 502 });
  }
}

export const POST = route("sessions.pay", handle);
