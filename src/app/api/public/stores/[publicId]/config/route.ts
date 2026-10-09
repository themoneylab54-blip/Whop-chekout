import { db } from "@/lib/db";
import { checkoutBaseUrl } from "@/lib/checkout-domain";
import { json, preflight } from "@/lib/http";
import { loadInterception } from "@/lib/layout";
import { route } from "@/lib/route";
import { anyProviderConnected } from "@/lib/payment-provider";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** Read by the storefront loader on every page view (cached a few seconds at the edge). */
async function handle(_req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await ctx.params;
  const store = await db.store.findUnique({
    where: { publicId },
    select: {
      enabled: true,
      interception: true,
      whopConnectedAt: true,
      shopifyConnectedAt: true,
      fallbackActiveAt: true,
      attributionDays: true,
      checkoutDomain: true,
      checkoutDomainVerifiedAt: true,
      paymentMode: true,
      providerFailoverAt: true,
      testMode: true,
      stripeAccountId: true,
      stripeConnectedAt: true,
      stripeLivemode: true,
      stripeChargesEnabled: true,
    },
  });
  // Live with at least one usable processor (Whop and/or Stripe, under the store's mode). Failing
  // processors never switch the storefront to Shopify's checkout: buyers stay on ours (fallback.ts
  // only moves new sessions to the other processor; fallbackActiveAt is no longer set).
  const live = !!store?.enabled && anyProviderConnected(store) && !!store.shopifyConnectedAt && !store.fallbackActiveAt;
  return json(
    {
      enabled: live,
      interception: store ? loadInterception(store.interception) : null,
      // On the store's verified checkout domain when it has one (the loader itself stays on APP_URL).
      sessionEndpoint: `${checkoutBaseUrl(store ?? { checkoutDomain: null, checkoutDomainVerifiedAt: null })}/api/public/sessions`,
      attributionDays: store?.attributionDays ?? 7,
    },
    { cors: true, headers: { "Cache-Control": "public, max-age=5, s-maxage=5" } },
  );
}

export const GET = route("store.config", handle, { cors: true });
