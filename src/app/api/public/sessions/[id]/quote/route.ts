import { clientIp, rateLimit } from "@/lib/ratelimit";
import { db } from "@/lib/db";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { json, readJson } from "@/lib/http";
import { quoteSchema, quoteSession } from "@/lib/checkout";
import { route } from "@/lib/route";
import { designFor } from "@/lib/experiments";
import { loadCheckoutLayout } from "@/lib/layout";
import { localizeRate } from "@/components/checkout/localize";
import { LANGS, type Lang } from "@/components/checkout/i18n";

/** Recorded checkout language ("en-GB" → "en"), French when unknown. */
const checkoutLangOf = (raw: string | null): Lang => {
  const code = (raw ?? "").toLowerCase().split("-")[0];
  return LANGS.some((l) => l.code === code) ? (code as Lang) : "fr";
};

async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`quote:ip:${clientIp(req)}`, 60)) || !(await rateLimit(`quote:s:${id}`, 40))) return json({ error: "Trop de requêtes, réessayez dans une minute." }, { status: 429 });
  const parsed = quoteSchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Requête invalide" }, { status: 400 });
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  // Another store's checkout domain never serves this session (see isForeignCheckoutHost).
  if (!session || (await isForeignCheckoutHost(req, session.store))) return json({ error: "Session introuvable" }, { status: 404 });
  // Funnel: a delivery method is set for a real address (a preselected rate on load doesn't count).
  if (parsed.data.shippingRateId && session.addressEnteredAt && !session.shippingChosenAt) {
    await db.checkoutSession.updateMany({ where: { id, shippingChosenAt: null }, data: { shippingChosenAt: new Date() } });
  }
  const quote = await quoteSession(session, parsed.data);
  // Order bumps actually offered to this buyer (attach rate = taken / shown).
  if (quote.eligibleAddOnIds.length && session.status !== "PAID") {
    const design = await designFor(session.store, session);
    const shows = loadCheckoutLayout(design.checkoutLayout).blocks.some((b) => b.type === "order_addons" && !b.hidden);
    const fresh = quote.eligibleAddOnIds.filter((a) => !session.addOnsShown.includes(a));
    if (shows && fresh.length) {
      await db.$executeRaw`
        UPDATE "CheckoutSession" SET "addOnsShown" = ARRAY(SELECT DISTINCT unnest("addOnsShown" || ${fresh}::text[]))
        WHERE id = ${id} AND status <> 'PAID'`;
    }
  }
  // The buyer's language (recorded by the checkout page): rate names and delays translated,
  // and nothing the browser doesn't need (carrier cost, translations of other languages).
  const lang = checkoutLangOf(session.lang);
  return json({
    ...quote,
    rates: quote.rates.map((r) => {
      const { costCents: _cost, i18n: _i18n, ...rest } = localizeRate(r as typeof r & { costCents?: number | null; i18n?: unknown }, lang);
      void _cost;
      void _i18n;
      return rest;
    }),
  });
}

export const POST = route("sessions.quote", handle);
