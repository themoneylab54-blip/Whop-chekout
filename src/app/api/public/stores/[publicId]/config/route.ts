import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { json, preflight } from "@/lib/http";
import { loadInterception } from "@/lib/layout";

export const dynamic = "force-dynamic";

export const OPTIONS = preflight;

/** Read by the storefront loader on every page view (cached a few seconds at the edge). */
export async function GET(_req: Request, ctx: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await ctx.params;
  const store = await db.store.findUnique({
    where: { publicId },
    select: { enabled: true, interception: true, whopConnectedAt: true, shopifyConnectedAt: true },
  });
  const live = !!store?.enabled && !!store.whopConnectedAt && !!store.shopifyConnectedAt;
  return json(
    {
      enabled: live,
      interception: store ? loadInterception(store.interception) : null,
      sessionEndpoint: `${env.appUrl}/api/public/sessions`,
    },
    { cors: true, headers: { "Cache-Control": "public, max-age=5, s-maxage=5" } },
  );
}
