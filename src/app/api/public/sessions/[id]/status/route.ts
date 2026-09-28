import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { route } from "@/lib/route";
import { parseArmKey } from "@/lib/layout";

async function handle(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const s = await db.checkoutSession.findUnique({
    where: { id },
    select: { status: true, shopifyOrderName: true, upsells: { select: { blockId: true, status: true, shopifyOrderName: true } } },
  });
  if (!s) return json({ error: "Session introuvable" }, { status: 404 });
  const { upsells, ...rest } = s;
  // One-click offers by block (arm suffix removed): the thank-you page polls this when an
  // accepted offer's outcome is unknown (server error, lost connection).
  const offers = Object.fromEntries(upsells.map((u) => [parseArmKey(u.blockId).blockId, { status: u.status, orderName: u.shopifyOrderName }]));
  return json({ ...rest, upsells: offers }, { headers: { "Cache-Control": "no-store" } });
}

export const GET = route("sessions.status", handle);
