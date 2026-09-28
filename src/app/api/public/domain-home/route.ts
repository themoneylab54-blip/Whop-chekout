import { db } from "@/lib/db";
import { hostnameOf } from "@/lib/host-guard";
import { retiredDomainOwner } from "@/lib/checkout-domain-check";

export const dynamic = "force-dynamic";

/**
 * Root of a checkout domain (the proxy rewrites "/" here on any non-app host): a buyer who types
 * checkout.seyuna.com lands on the store's own site. 404 on a host no store uses.
 */
export async function GET(req: Request) {
  const host = hostnameOf(req.headers.get("host"));
  const select = { storefrontHost: true, shopDomain: true } as const;
  let store = host ? await db.store.findUnique({ where: { checkoutDomain: host }, select }) : null;
  if (!store && host) {
    const owner = await retiredDomainOwner(host);
    store = owner ? await db.store.findUnique({ where: { id: owner }, select }) : null;
  }
  const target = store?.storefrontHost || store?.shopDomain;
  if (!target) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
  return new Response(null, { status: 307, headers: { Location: `https://${target}/`, "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
