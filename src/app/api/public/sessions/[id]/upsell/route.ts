import { z } from "zod";
import { db } from "@/lib/db";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { json, readJson } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { acceptUpsell, declineUpsell, markUpsellShown, UpsellError } from "@/lib/upsell";
import { collectDeferred, runDeferred } from "@/lib/deferred";
import { log, logContext, withLogContext } from "@/lib/log";
import { flushProviderMetrics } from "@/lib/metrics";
import { afterResponse, route } from "@/lib/route";
import { MAX_OFFER_QUANTITY } from "@/lib/layout";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// blockId: the offer block (the server picks the visitor's A/B arm). View ids: "<id>" or "<id>:B" (arm shown).
const schema = z.union([
  // variantId: the product the page displayed (an automatic offer's pick must still be that one).
  z.object({ blockId: z.string().min(1).max(40), accept: z.boolean(), quantity: z.number().int().min(1).max(MAX_OFFER_QUANTITY).default(1), variantId: z.string().max(80).optional() }),
  z.object({ view: z.literal(true), blockIds: z.array(z.string().min(1).max(42).regex(/^[\w-]+(:B)?$/)).max(10).optional() }),
]);

/**
 * Thank-you page: accept (one-click charge on the saved card) or decline an offer. The buyer gets
 * the answer as soon as Whop confirms the charge: the offer's Shopify work (order creation or merge
 * into the checkout's order, balance, conversions) runs after the response, bounded by the function's
 * limit, and the background tick backstops it (retryUpsellSyncs).
 */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const { id } = await ctx.params;
  if (!(await rateLimit(`upsell:ip:${clientIp(req)}`, 10))) return json({ error: "Trop de requêtes" }, { status: 429 });
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Requête invalide" }, { status: 400 });
  if ("view" in parsed.data) {
    await markUpsellShown(id, parsed.data.blockIds ?? []);
    return json({ ok: true });
  }
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  // Another store's checkout domain never serves this session (see isForeignCheckoutHost).
  if (!session || (await isForeignCheckoutHost(req, session.store))) return json({ error: "Session introuvable" }, { status: 404 });
  const accept = parsed.data.accept;
  const { blockId, quantity, variantId } = parsed.data;
  try {
    const { result, later } = await collectDeferred(() => (accept ? acceptUpsell(session, blockId, quantity, variantId) : declineUpsell(session, blockId)));
    if (later.length) {
      // Follow-ups share the function's 60 s: external calls refuse to start past this point.
      const hardDeadline = startedAt + 55_000;
      const requestId = (logContext().requestId as string | undefined) ?? null;
      afterResponse(() =>
        withLogContext({ requestId, route: "sessions.upsell", sessionId: id, hardDeadline }, async () => {
          await runDeferred(later, (name, err) => log.error("upsell.deferred_failed", `Deferred ${name} failed (the tick retries it)`, { name, err }));
          await flushProviderMetrics();
        }),
      );
    }
    return json(result);
  } catch (err) {
    if (err instanceof UpsellError) return json({ error: err.message, code: err.code }, { status: 400 });
    log.error("upsell.error", "Upsell request failed", { sessionId: id, err });
    // Unknown outcome (the error may come after Whop charged): never tell the buyer nothing was
    // charged; the background check settles it and the order is created if it was paid.
    return json({ error: "L'offre n'a pas pu être confirmée pour l'instant. Si elle a été débitée, elle sera ajoutée à votre commande automatiquement.", code: "upsell_uncertain" }, { status: 502 });
  }
}

export const POST = route("sessions.upsell", handle);
