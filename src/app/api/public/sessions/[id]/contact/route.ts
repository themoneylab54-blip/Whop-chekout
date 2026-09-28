import { z } from "zod";
import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";

const schema = z.object({
  email: z.string().trim().email().max(200),
  acceptsMarketing: z.boolean().default(false),
});

/**
 * Saves the buyer's e-mail as soon as it is typed (on blur), so an abandoned
 * checkout can be recovered. Only for sessions that aren't paid yet.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`contact:ip:${clientIp(req)}`, 30))) return json({ error: "Trop de requêtes" }, { status: 429 });
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return json({ ok: false }, { status: 400 });
  const session = await db.checkoutSession.findUnique({ where: { id }, select: { status: true, contactAt: true } });
  if (!session || session.status === "PAID") return json({ ok: false }, { status: 404 });
  await db.checkoutSession.update({
    where: { id },
    data: { email: parsed.data.email, acceptsMarketing: parsed.data.acceptsMarketing, contactAt: session.contactAt ?? new Date() },
  });
  return json({ ok: true });
}
