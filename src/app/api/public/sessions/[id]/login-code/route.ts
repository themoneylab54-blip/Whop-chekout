import { z } from "zod";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { route } from "@/lib/route";
import { after } from "next/server";
import { deliverLoginCode, loginCodeEnabled, normalEmail } from "@/lib/returning";
import { log } from "@/lib/log";

const bodySchema = z.object({ email: z.string().trim().email().max(200) });

/**
 * "Déjà client ?": sends a one-time code to the e-mail when it has a paid order on the store.
 * The answer is the same either way, and comes before any lookup (never reveals whether the e-mail is a customer).
 */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "E-mail invalide", code: "invalid_email" }, { status: 400 });
  const email = normalEmail(parsed.data.email);
  const allowed =
    (await rateLimit(`otp:ip:${clientIp(req)}`, 5, 10 * 60_000)) &&
    (await rateLimit(`otp:s:${id}`, 3, 10 * 60_000)) &&
    (await rateLimit(`otp:e:${email}`, 3, 10 * 60_000));
  if (!allowed) return json({ error: "Trop de demandes, réessayez dans quelques minutes.", code: "rate_limited" }, { status: 429 });
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session || session.status === "PAID") return json({ error: "Session introuvable" }, { status: 404 });
  if (!(await loginCodeEnabled(session.store))) return json({ error: "Indisponible", code: "disabled" }, { status: 404 });
  // Same answer, same timing for every e-mail: the customer lookup, the code and the e-mail run
  // after the response (a slow answer would tell that this e-mail has an order here).
  after(() => deliverLoginCode(session, email).catch((err) => log.error("returning.deliver_failed", "Login code delivery failed", { sessionId: id, err })));
  return json({ sent: true });
}

export const POST = route("sessions.login_code", handle);
