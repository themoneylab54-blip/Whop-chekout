import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { json, readJson } from "@/lib/http";
import { failureResponse, journalCheckoutFailure, paymentPayload, prepareAfterClientFailure, prepareWithFailover, quoteSchema } from "@/lib/checkout";
import { route } from "@/lib/route";

/** A processor slow to answer, then the other one tried in the same request: more than the default budget. */
export const maxDuration = 60;

/**
 * One-page checkout: returns the checkout for the current total (created or reused): a Whop checkout
 * configuration, or a Stripe PaymentIntent (provider "stripe": client secret, publishable key,
 * connected account). A processor failing here switches this buyer to the other one in the same
 * request when it is usable and nothing is in flight (prepareWithFailover).
 */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // The request's start: a wait for another request's checkout is bounded from it (prepareSession).
  const startedAt = Date.now();
  const { id } = await ctx.params;
  if (!(await rateLimit(`prepare:ip:${clientIp(req)}`, 40)) || !(await rateLimit(`prepare:s:${id}`, 30))) return json({ error: "Trop de requêtes, réessayez dans une minute.", code: "rate_limited" }, { status: 429 });
  const raw = await readJson(req);
  const parsed = quoteSchema.safeParse(raw);
  if (!parsed.success) return json({ error: "Requête invalide" }, { status: 400 });
  // Stripe's form couldn't load in this browser (Stripe.js blocked, timed out or failed): the buyer
  // is switched to Whop when it is usable (prepareAfterClientFailure).
  const clientFailed = raw && typeof raw === "object" && (raw as { clientFailed?: unknown }).clientFailed === "stripe";
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  // Another store's checkout domain never serves this session (see isForeignCheckoutHost).
  if (!session || (await isForeignCheckoutHost(req, session.store))) return json({ error: "Session introuvable" }, { status: 404 });
  try {
    const opts = { host: req.headers.get("host"), startedAt };
    const prepared = clientFailed ? await prepareAfterClientFailure(session, parsed.data, opts) : await prepareWithFailover(session, parsed.data, opts);
    // `paypal`: whether Whop offers PayPal on this store's checkout (the express PayPal button hides otherwise).
    return json({ ...paymentPayload(prepared, session.store), totals: prepared.totals, paypal: prepared.paypal, method: parsed.data.method ?? null });
  } catch (err) {
    await journalCheckoutFailure(session, "prepare", err);
    // A refusal (400), Whop unavailable with no switch possible (503 whop_unavailable: the page stops
    // retrying), the session changing in another tab (503, retried), else a processor failure (502).
    const failed = failureResponse(err, "Le paiement n'a pas pu être initialisé. Rechargez la page.");
    return json(failed.body, { status: failed.status });
  }
}

export const POST = route("sessions.prepare", handle);
