import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { CheckoutError, confirmSession, paySchema } from "@/lib/checkout";

/** Saves the buyer's details just before the embedded Whop form is submitted. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!rateLimit(`pay:ip:${clientIp(req)}`, 20) || !rateLimit(`pay:s:${id}`, 15)) return json({ error: "Trop de requêtes, réessayez dans une minute." }, { status: 429 });
  const parsed = paySchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return json({ error: "Merci de vérifier vos informations", issues: parsed.error.issues.map((i) => i.path.join(".")) }, { status: 400 });
  }
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session) return json({ error: "Session introuvable" }, { status: 404 });
  try {
    const result = await confirmSession(session, parsed.data);
    return json({ ...result, environment: session.store.testMode ? "sandbox" : "production" });
  } catch (err) {
    if (err instanceof CheckoutError) return json({ error: err.message }, { status: 400 });
    console.error("confirmSession failed", err);
    return json({ error: "Le paiement n'a pas pu être initialisé. Réessayez." }, { status: 502 });
  }
}
