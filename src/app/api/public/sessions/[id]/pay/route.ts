import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { json, readJson } from "@/lib/http";
import { failureResponse, journalCheckoutFailure, confirmSession, paySchema, paymentPayload } from "@/lib/checkout";
import { after } from "next/server";
import { route } from "@/lib/route";
import { sendPaymentInfoConversions } from "@/lib/conversions";

/** A processor slow to answer at the Pay click, then the other one prepared in the same request. */
export const maxDuration = 60;

/** Saves the buyer's details just before the embedded Whop form is submitted. */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // The request's start: a wait for another request's checkout is bounded from it (prepareSession).
  const startedAt = Date.now();
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
    const result = await confirmSession(session, parsed.data, { host: req.headers.get("host"), startedAt });
    after(() => sendPaymentInfoConversions(session.id).catch(() => undefined));
    // Whop: the configuration to submit; Stripe: the PaymentIntent the page confirms (or a fresh one to mount first).
    return json({ ready: result.ready, totals: result.totals, ...paymentPayload(result, session.store) });
  } catch (err) {
    await journalCheckoutFailure(session, "pay", err);
    // A refusal (400), Whop unavailable with no switch possible (503 whop_unavailable: the page stops
    // retrying), the session changing in another tab (503, retried), else a processor failure (502).
    const failed = failureResponse(err, "Le paiement n'a pas pu être initialisé. Réessayez.");
    return json(failed.body, { status: failed.status });
  }
}

export const POST = route("sessions.pay", handle);
