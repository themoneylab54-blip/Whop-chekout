import { z } from "zod";
import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { acceptUpsell, declineUpsell, markUpsellShown, UpsellError } from "@/lib/upsell";
import { log } from "@/lib/log";

const schema = z.union([z.object({ blockId: z.string().min(1).max(40), accept: z.boolean() }), z.object({ view: z.literal(true) })]);

/** Thank-you page: accept (one-click charge on the saved card) or decline an offer. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`upsell:ip:${clientIp(req)}`, 10))) return json({ error: "Trop de requêtes" }, { status: 429 });
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Requête invalide" }, { status: 400 });
  if ("view" in parsed.data) {
    await markUpsellShown(id);
    return json({ ok: true });
  }
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session) return json({ error: "Session introuvable" }, { status: 404 });
  try {
    const result = parsed.data.accept ? await acceptUpsell(session, parsed.data.blockId) : await declineUpsell(session, parsed.data.blockId);
    return json(result);
  } catch (err) {
    if (err instanceof UpsellError) return json({ error: err.message }, { status: 400 });
    log.error("upsell.error", "Upsell request failed", { sessionId: id, err });
    return json({ error: "L'offre n'a pas pu être ajoutée. Aucun montant n'a été débité." }, { status: 502 });
  }
}
