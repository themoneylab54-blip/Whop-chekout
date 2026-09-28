import { z } from "zod";
import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { log } from "@/lib/log";
import { PICKUP_COUNTRIES, pickupConfigured, searchPickupPoints } from "@/lib/pickup";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/route";

const query = z.object({
  country: z.enum(PICKUP_COUNTRIES),
  zip: z.string().trim().min(2).max(12),
  city: z.string().trim().max(60).optional(),
});

/** Relay points near the buyer's postcode, for a "pickup" shipping rate. */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`pickup:ip:${clientIp(req)}`, 30))) return json({ error: "Trop de requêtes", code: "rate_limited" }, { status: 429 });
  const url = new URL(req.url);
  const parsed = query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return json({ error: "Code postal ou pays invalide", code: "pickup_invalid" }, { status: 400 });
  const session = await db.checkoutSession.findUnique({ where: { id }, select: { store: { select: { mondialRelayEnseigne: true, mondialRelayKey: true } } } });
  if (!session) return json({ error: "Session introuvable" }, { status: 404 });
  if (!pickupConfigured(session.store)) return json({ error: "Retrait en point relais indisponible", code: "pickup_unavailable" }, { status: 409 });
  try {
    const points = await searchPickupPoints(session.store, parsed.data);
    return json({ points }, { headers: { "Cache-Control": "private, max-age=300" } });
  } catch (err) {
    log.warn("pickup.search_failed", "Relay point search failed", { err });
    return json({ error: "Recherche des points relais impossible pour le moment", code: "pickup_failed" }, { status: 502 });
  }
}

export const GET = route("sessions.pickup_points", handle);
