import { json } from "@/lib/http";
import { safeEqual } from "@/lib/crypto";
import { maybeTick, runTick } from "@/lib/tick";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Background maintenance endpoint. Called by Vercel Cron (which sends
 * `Authorization: Bearer $CRON_SECRET`) or any external scheduler with that header.
 * Without a valid secret it only runs when the last tick is old enough.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  if (secret && safeEqual(auth, `Bearer ${secret}`)) {
    return json({ ok: true, report: await runTick() });
  }
  return json({ ok: true, ran: await maybeTick() });
}
