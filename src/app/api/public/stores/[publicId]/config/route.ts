import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { json, preflight } from "@/lib/http";
import { loadInterception } from "@/lib/layout";
import { route } from "@/lib/route";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** Read by the storefront loader on every page view (cached a few seconds at the edge). */
async function handle(_req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await ctx.params;
  const store = await db.store.findUnique({
    where: { publicId },
    select: { enabled: true, interception: true, whopConnectedAt: true, shopifyConnectedAt: true, fallbackActiveAt: true, attributionDays: true },
  });
  // While Whop is failing, the storefront keeps Shopify's checkout (see fallback.ts).
  const live = !!store?.enabled && !!store.whopConnectedAt && !!store.shopifyConnectedAt && !store.fallbackActiveAt;
  return json(
    {
      enabled: live,
      interception: store ? loadInterception(store.interception) : null,
      sessionEndpoint: `${env.appUrl}/api/public/sessions`,
      attributionDays: store?.attributionDays ?? 7,
    },
    { cors: true, headers: { "Cache-Control": "public, max-age=5, s-maxage=5" } },
  );
}

export const GET = route("store.config", handle, { cors: true });
