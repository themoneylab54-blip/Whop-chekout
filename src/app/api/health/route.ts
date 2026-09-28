import { db } from "@/lib/db";
import { json } from "@/lib/http";
import { tickStatus } from "@/lib/tick";

export const dynamic = "force-dynamic";

/**
 * Uptime probe for an external monitor (UptimeRobot, Better Stack…): 200 when the
 * database answers and background maintenance ran recently, 503 otherwise.
 * Exposes no business data.
 */
export async function GET() {
  const started = Date.now();
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    return json({ ok: false, db: false }, { status: 503 });
  }
  const tick = await tickStatus();
  const tickAgeMin = tick.at ? Math.round((Date.now() - new Date(tick.at).getTime()) / 60_000) : null;
  const unsyncedOld = await db.checkoutSession.count({
    where: { status: "PAID", shopifyOrderId: null, reviewNote: null, paidAt: { lt: new Date(Date.now() - 30 * 60_000) } },
  });
  // Only judge the tick when a scheduler is expected (CRON_SECRET set).
  const tickOk = !process.env.CRON_SECRET || (tickAgeMin != null && tickAgeMin <= 20);
  const tickErrors = tick.report
    ? Object.entries(tick.report)
        .filter(([, v]) => typeof v === "string" && v.startsWith("error"))
        .map(([k]) => k)
    : [];
  const ok = tickOk && tickErrors.length === 0 && unsyncedOld === 0;
  return json(
    { ok, db: true, tickAgeMin, tickErrors, unsyncedOver30min: unsyncedOld, ms: Date.now() - started },
    { status: ok ? 200 : 503 },
  );
}
