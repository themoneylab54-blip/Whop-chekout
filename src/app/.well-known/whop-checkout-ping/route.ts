import { db } from "@/lib/db";
import { domainToken } from "@/lib/checkout-domain";
import { hostnameOf } from "@/lib/host-guard";

export const dynamic = "force-dynamic";

/**
 * Checkout domain verification: answers the token of the store whose checkout domain is the
 * request's host (see pingDomain). 404 on any other host. Never cached: a re-check must see the
 * current routing.
 */
export async function GET(req: Request) {
  const host = hostnameOf(req.headers.get("host"));
  const store = host ? await db.store.findUnique({ where: { checkoutDomain: host }, select: { id: true } }) : null;
  if (!store) return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  return new Response(domainToken(store.id, host), {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" },
  });
}
