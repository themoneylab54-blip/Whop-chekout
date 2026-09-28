import { NextResponse, type NextRequest } from "next/server";
import { appExtraHosts, hostDecision } from "@/lib/host-guard";

/*
 * Checkout domains (checkout.seyuna.com…): on a host that is not the app's own, only the buyer's
 * pages and APIs are served; the dashboard, login, admin APIs and cron go to APP_URL. DB-free (see
 * lib/host-guard): the /c pages check that the session's store owns the host.
 */
export function proxy(request: NextRequest) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) return NextResponse.next();
  const extraHosts = appExtraHosts();
  const decision = hostDecision({
    host: request.headers.get("host"),
    pathname: request.nextUrl.pathname,
    search: request.nextUrl.search,
    appUrl,
    extraHosts,
  });
  if (decision.action === "redirect") return NextResponse.redirect(decision.location, 307);
  if (decision.action === "rewrite") return NextResponse.rewrite(new URL(decision.path, request.url));
  if (decision.action === "not_found") return new NextResponse("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" } });
  return NextResponse.next();
}

export const config = {
  // Static build files never need the check (they are served on every host), nor the checkout icon:
  // the storefront loader pings it on the checkout domain to test reachability, served straight from
  // the CDN (no function invocation per storefront visit).
  matcher: ["/((?!_next/static|_next/image|checkout-icon\\.svg).*)"],
};
