import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { quoteSchema, quoteSession } from "@/lib/checkout";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`quote:ip:${clientIp(req)}`, 60)) || !(await rateLimit(`quote:s:${id}`, 40))) return json({ error: "Trop de requêtes, réessayez dans une minute." }, { status: 429 });
  const parsed = quoteSchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Requête invalide" }, { status: 400 });
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session) return json({ error: "Session introuvable" }, { status: 404 });
  return json(await quoteSession(session, parsed.data));
}
