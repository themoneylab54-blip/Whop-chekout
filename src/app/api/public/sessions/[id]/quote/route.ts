import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { quoteSchema, quoteSession } from "@/lib/checkout";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = quoteSchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Requête invalide" }, { status: 400 });
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session) return json({ error: "Session introuvable" }, { status: 404 });
  return json(await quoteSession(session, parsed.data));
}
