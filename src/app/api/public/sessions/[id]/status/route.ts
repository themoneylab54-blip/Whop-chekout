import { db } from "@/lib/db";
import { json } from "@/lib/http";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = await db.checkoutSession.findUnique({
    where: { id },
    select: { status: true, shopifyOrderName: true },
  });
  if (!s) return json({ error: "Session introuvable" }, { status: 404 });
  return json(s, { headers: { "Cache-Control": "no-store" } });
}
