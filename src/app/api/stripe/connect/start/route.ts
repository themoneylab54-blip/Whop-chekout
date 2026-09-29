import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { currentAdminId } from "@/lib/auth";
import { route } from "@/lib/route";
import { flashUrl } from "@/lib/flash";
import { oauthAuthorizeUrl, stripeConfigured, stripeModeOf } from "@/lib/stripe";
import { newStripeNonce, sameOrigin, signStripeState, stripeNonceCookie, STRIPE_STATE_TTL_MS } from "@/lib/stripe-state";

export const dynamic = "force-dynamic";

/**
 * « Se connecter avec Stripe » (admin only, app host only: checkout domains redirect to APP_URL, see
 * host-guard; a POST from the dashboard's own form, Origin checked, so no cross-site link can start a
 * connection): signs a state bound to the store, the mode and a nonce kept in a short-lived cookie of
 * this browser (one per store: two tabs don't clobber each other), then sends the merchant to
 * Stripe's consent page.
 */
async function handle(req: Request) {
  if (!(await currentAdminId())) return NextResponse.redirect(`${env.appUrl}/login`, 303);
  if (!sameOrigin(req.headers.get("origin"), env.appUrl)) return new NextResponse("Origine refusée", { status: 403 });
  const form = await req.formData().catch(() => null);
  const storeId = String(form?.get("store") ?? "");
  const store = storeId ? await db.store.findUnique({ where: { id: storeId }, select: { id: true, name: true, testMode: true } }) : null;
  if (!store) return NextResponse.redirect(`${env.appUrl}/dashboard`, 303);
  const mode = stripeModeOf(store);
  if (!stripeConfigured(mode)) {
    return NextResponse.redirect(
      `${env.appUrl}${flashUrl(`/dashboard/stores/${store.id}/stripe`, { error: `Stripe n'est pas encore configuré sur le serveur (clés ${mode === "test" ? "de test" : "live"} manquantes) : voir les étapes ci-dessous.` })}`,
      303,
    );
  }
  const nonce = newStripeNonce();
  const res = NextResponse.redirect(oauthAuthorizeUrl(store, signStripeState({ storeId: store.id, mode, nonce })), 303);
  res.cookies.set(stripeNonceCookie(store.id), nonce, {
    httpOnly: true,
    secure: env.appUrl.startsWith("https://"),
    // Stripe sends the merchant back with a top-level GET: a lax cookie comes along.
    sameSite: "lax",
    path: "/api/stripe/connect",
    maxAge: Math.floor(STRIPE_STATE_TTL_MS / 1000),
  });
  return res;
}

export const POST = route("stripe.connect.start", handle);

/** An old link or bookmark: back to the dashboard, where the button (a form POST) starts the connection. */
export const GET = route("stripe.connect.start_get", async (req: Request) => {
  const storeId = new URL(req.url).searchParams.get("store") ?? "";
  return NextResponse.redirect(`${env.appUrl}${/^[A-Za-z0-9_-]{1,64}$/.test(storeId) ? `/dashboard/stores/${storeId}/stripe` : "/dashboard"}`);
});
