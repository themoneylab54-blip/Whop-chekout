import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { CheckoutError, prepareSession, quoteSchema } from "@/lib/checkout";

/** One-page checkout: returns the Whop checkout for the current total (created or reused). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!rateLimit(`prepare:ip:${clientIp(req)}`, 40) || !rateLimit(`prepare:s:${id}`, 30)) return json({ error: "Trop de requêtes, réessayez dans une minute." }, { status: 429 });
  const parsed = quoteSchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Requête invalide" }, { status: 400 });
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session) return json({ error: "Session introuvable" }, { status: 404 });
  try {
    const { checkoutConfigurationId, totals } = await prepareSession(session, parsed.data);
    return json({ checkoutConfigurationId, totals, environment: session.store.testMode ? "sandbox" : "production" });
  } catch (err) {
    if (err instanceof CheckoutError) return json({ error: err.message }, { status: 400 });
    console.error("prepareSession failed", err);
    return json({ error: "Le paiement n'a pas pu être initialisé. Rechargez la page." }, { status: 502 });
  }
}
