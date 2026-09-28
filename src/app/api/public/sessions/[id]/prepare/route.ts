import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { json, readJson } from "@/lib/http";
import { CheckoutError, journalCheckoutFailure, prepareSession, quoteSchema } from "@/lib/checkout";
import { route } from "@/lib/route";

/** One-page checkout: returns the Whop checkout for the current total (created or reused). */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`prepare:ip:${clientIp(req)}`, 40)) || !(await rateLimit(`prepare:s:${id}`, 30))) return json({ error: "Trop de requêtes, réessayez dans une minute.", code: "rate_limited" }, { status: 429 });
  const parsed = quoteSchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Requête invalide" }, { status: 400 });
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  // Another store's checkout domain never serves this session (see isForeignCheckoutHost).
  if (!session || (await isForeignCheckoutHost(req, session.store))) return json({ error: "Session introuvable" }, { status: 404 });
  try {
    const { checkoutConfigurationId, totals, paypal } = await prepareSession(session, parsed.data, { host: req.headers.get("host") });
    // `paypal`: whether Whop offers PayPal on this store's checkout (the express PayPal button hides otherwise).
    return json({ checkoutConfigurationId, totals, paypal, method: parsed.data.method ?? null, environment: session.store.testMode ? "sandbox" : "production" });
  } catch (err) {
    await journalCheckoutFailure(session, "prepare", err);
    if (err instanceof CheckoutError) return json({ error: err.message, code: err.code }, { status: 400 });
    return json({ error: "Le paiement n'a pas pu être initialisé. Rechargez la page.", code: "init_failed" }, { status: 502 });
  }
}

export const POST = route("sessions.prepare", handle);
