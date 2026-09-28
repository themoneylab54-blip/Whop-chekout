import { z } from "zod";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { route } from "@/lib/route";
import { verifyLoginCode } from "@/lib/returning";

const bodySchema = z.object({ email: z.string().trim().email().max(200), code: z.string().trim().regex(/^\d{6}$/) });

/** Checks a "Déjà client ?" code: the right one returns the buyer's saved contact and address. */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`otpv:ip:${clientIp(req)}`, 20, 10 * 60_000))) return json({ error: "Trop d'essais, réessayez plus tard.", code: "rate_limited" }, { status: 429 });
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Code invalide", code: "invalid_code" }, { status: 400 });
  const session = await db.checkoutSession.findUnique({ where: { id }, select: { id: true, storeId: true, status: true, store: { select: { id: true, checkoutDomain: true } } } });
  if (!session || session.status === "PAID" || (await isForeignCheckoutHost(req, session.store))) return json({ error: "Session introuvable" }, { status: 404 });
  const buyer = await verifyLoginCode(session, parsed.data.email, parsed.data.code);
  if (!buyer) return json({ error: "Code incorrect ou expiré", code: "invalid_code" }, { status: 400 });
  return json({ buyer });
}

export const POST = route("sessions.login_code_verify", handle);
