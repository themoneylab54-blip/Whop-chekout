import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { CheckoutError, paySchema, startPayment } from "@/lib/checkout";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = paySchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return json({ error: "Merci de vérifier vos informations", issues: parsed.error.issues.map((i) => i.path.join(".")) }, { status: 400 });
  }
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session) return json({ error: "Session introuvable" }, { status: 404 });
  try {
    const result = await startPayment(session, parsed.data);
    return json({ ...result, environment: session.store.testMode ? "sandbox" : "production" });
  } catch (err) {
    if (err instanceof CheckoutError) return json({ error: err.message }, { status: 400 });
    console.error("startPayment failed", err);
    return json({ error: "Le paiement n'a pas pu être initialisé. Réessayez." }, { status: 502 });
  }
}
