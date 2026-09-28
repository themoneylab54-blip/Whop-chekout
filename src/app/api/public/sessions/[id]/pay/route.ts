import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { CheckoutError, journalCheckoutFailure, confirmSession, paySchema } from "@/lib/checkout";
import { after } from "next/server";
import { route } from "@/lib/route";
import { sendPaymentInfoConversions } from "@/lib/conversions";

/** Saves the buyer's details just before the embedded Whop form is submitted. */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`pay:ip:${clientIp(req)}`, 20)) || !(await rateLimit(`pay:s:${id}`, 15))) return json({ error: "Trop de requêtes, réessayez dans une minute.", code: "rate_limited" }, { status: 429 });
  const parsed = paySchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return json({ error: "Merci de vérifier vos informations", issues: parsed.error.issues.map((i) => i.path.join(".")) }, { status: 400 });
  }
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session) return json({ error: "Session introuvable" }, { status: 404 });
  try {
    const result = await confirmSession(session, parsed.data);
    after(() => sendPaymentInfoConversions(session.id).catch(() => undefined));
    return json({ ...result, environment: session.store.testMode ? "sandbox" : "production" });
  } catch (err) {
    await journalCheckoutFailure(session, "pay", err);
    if (err instanceof CheckoutError) return json({ error: err.message, code: err.code }, { status: 400 });
    return json({ error: "Le paiement n'a pas pu être initialisé. Réessayez.", code: "init_failed" }, { status: 502 });
  }
}

export const POST = route("sessions.pay", handle);
