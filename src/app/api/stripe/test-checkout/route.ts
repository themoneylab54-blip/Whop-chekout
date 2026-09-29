import { NextResponse } from "next/server";
import type { Prisma, Store } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { currentAdminId } from "@/lib/auth";
import { route } from "@/lib/route";
import { flashUrl } from "@/lib/flash";
import { checkoutBaseUrl } from "@/lib/checkout-domain";
import { providerConnected, stripeUnusableReason } from "@/lib/payment-provider";
import { log, recordEvent } from "@/lib/log";
import type { CartLine } from "@/lib/pricing";
import { priceCart } from "@/lib/shopify";
import { stripeModeOf } from "@/lib/stripe-config";
import { ensureStripeWebhook } from "@/lib/stripe-connection";
import { sameOrigin } from "@/lib/stripe-state";

export const dynamic = "force-dynamic";

/** Variants of the store's most recent checkouts' product lines (newest first, no gifts), to re-price. */
async function recentVariants(storeId: string): Promise<string[]> {
  const recent = await db.checkoutSession.findMany({ where: { storeId, forcedProvider: null }, orderBy: { createdAt: "desc" }, take: 20, select: { lines: true } });
  const out: string[] = [];
  for (const s of recent) {
    const raw = Array.isArray(s.lines) ? (s.lines as unknown as CartLine[]) : [];
    for (const l of raw) {
      if (l && typeof l.variantId === "string" && !(l as { gift?: boolean }).gift && !out.includes(l.variantId)) out.push(l.variantId);
    }
  }
  return out.slice(0, 10);
}

/**
 * One product of a recent cart, priced by Shopify NOW (never the old cart's price: it may have changed
 * since): the newest variant still for sale with a price, quantity 1. null when none is.
 */
async function testLine(store: Store): Promise<CartLine | null> {
  const variants = await recentVariants(store.id);
  if (!variants.length) return null;
  const priced = await priceCart(store, variants.map((variantId) => ({ variantId, quantity: 1 })));
  for (const v of variants) {
    const line = priced.find((l) => (l.variantId === v || l.variantId.endsWith(`/${v}`)) && l.unitPriceCents > 0 && !l.giftCard);
    if (line) return { ...line, quantity: 1 };
  }
  return null;
}

/**
 * « Tester le secours » (dashboard > Stripe, admin only, POST from the dashboard's own form): a
 * checkout session of the store forced to Stripe (CheckoutSession.forcedProvider, which only this
 * route sets; a buyer's request can never force a processor), with one product of a recent cart,
 * then the checkout itself, exactly as buyers see it. In test mode Stripe takes test cards and the
 * Shopify order is a test order; in live mode the payment is real (to be refunded afterwards).
 */
async function handle(req: Request) {
  if (!(await currentAdminId())) return NextResponse.redirect(`${env.appUrl}/login`, 303);
  // The dashboard's own form only (no cross-site POST creating sessions); an unparsable Origin is refused too.
  if (!sameOrigin(req.headers.get("origin"), env.appUrl)) return new NextResponse("Origine refusée", { status: 403 });
  const form = await req.formData().catch(() => null);
  const storeId = String(form?.get("store") ?? "");
  const store = storeId ? await db.store.findUnique({ where: { id: storeId } }) : null;
  if (!store) return NextResponse.redirect(`${env.appUrl}/dashboard`, 303);
  // The form opens a new tab: errors are shown on the Stripe page there (#test card).
  const back = (error: string) => NextResponse.redirect(`${env.appUrl}${flashUrl(`/dashboard/stores/${store.id}/stripe`, { error })}#test`, 303);
  if (!providerConnected(store, "stripe")) return back(stripeUnusableReason(store) ?? "Connectez d'abord Stripe (et ses clés du mode de la boutique) pour tester le secours.");
  if (!store.shopifyConnectedAt) return back("Connectez d'abord Shopify : la commande de test y est créée.");
  let line: CartLine | null;
  try {
    line = await testLine(store);
  } catch (err) {
    log.warn("stripe.test_price_failed", "Could not price the test product with Shopify", { storeId: store.id, err });
    return back("Shopify ne répond pas pour reprendre le prix du produit : réessayez dans un instant.");
  }
  if (!line) return back("Aucun produit récent encore en vente à reprendre : ouvrez d'abord votre checkout depuis la boutique, puis relancez le test.");
  // The payment's confirmation arrives by the Connect webhook: make sure it exists (journaled when not).
  await ensureStripeWebhook(store.id, stripeModeOf(store), { lazy: true });
  const session = await db.checkoutSession.create({
    data: {
      storeId: store.id,
      currency: store.shopCurrency,
      lines: [line] as unknown as Prisma.InputJsonValue,
      subtotalCents: line.unitPriceCents,
      test: store.testMode,
      forcedProvider: "stripe",
    },
  });
  await recordEvent({
    storeId: store.id,
    sessionId: session.id,
    kind: "checkout.provider_test",
    message: `Test du secours Stripe lancé depuis le tableau de bord (${store.testMode ? "mode test" : "mode live : paiement réel"}).`,
  });
  return NextResponse.redirect(`${checkoutBaseUrl(store)}/c/${session.id}`, 303);
}

export const POST = route("stripe.test_checkout", handle);
