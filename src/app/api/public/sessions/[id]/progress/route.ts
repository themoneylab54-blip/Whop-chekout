import { z } from "zod";
import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/route";

const schema = z.object({ step: z.enum(["email", "address"]) });

/**
 * Funnel beacon from the one-page form: the buyer entered a valid e-mail / a complete
 * address. Only the first time counts; no personal data is sent here.
 */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`progress:ip:${clientIp(req)}`, 60))) return json({ error: "Trop de requêtes" }, { status: 429 });
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Requête invalide" }, { status: 400 });
  if (parsed.data.step === "email") {
    await db.checkoutSession.updateMany({ where: { id, emailEnteredAt: null, status: { not: "PAID" } }, data: { emailEnteredAt: new Date() } });
  } else {
    await db.checkoutSession.updateMany({ where: { id, addressEnteredAt: null, status: { not: "PAID" } }, data: { addressEnteredAt: new Date() } });
  }
  return json({ ok: true });
}

export const POST = route("sessions.progress", handle);
