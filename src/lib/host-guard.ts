/*
 * Which requests a store's checkout domain (checkout.seyuna.com…) may serve. Pure and DB-free: it
 * runs in the proxy on every request. Any host that is not one of the app's own hosts is treated as
 * a checkout host; the /c pages then check that the session's store really owns that host (and
 * redirect to the right one otherwise, see checkoutHostRedirect in checkout-domain.ts).
 */

/** Hostname of a Host header, lowercase, without port or trailing dot ("" when missing). */
export function hostnameOf(host: string | null | undefined): string {
  const h = (host ?? "").trim().toLowerCase();
  if (!h) return "";
  // [::1]:3000 → [::1]
  const bare = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return bare.replace(/\.$/, "");
}

/**
 * A request the page itself sent, not one another site made the buyer's browser send: when the
 * browser sends Sec-Fetch-Site it must be same-origin / same-site / none, and an Origin header,
 * when present, must name the request's own host. Headers a browser leaves out pass (older
 * browsers, server-side callers). Pure.
 */
export function isSameSiteRequest(req: Request): boolean {
  const site = req.headers.get("sec-fetch-site");
  if (site != null && !["same-origin", "same-site", "none"].includes(site.trim().toLowerCase())) return false;
  const origin = req.headers.get("origin");
  if (origin == null) return true;
  let originHost: string;
  try {
    originHost = hostnameOf(new URL(origin).host);
  } catch {
    return false; // "null" (sandboxed frame, file://) or garbage
  }
  return !!originHost && originHost === hostnameOf(req.headers.get("host"));
}

/** Local development hosts (never redirected, never treated as a checkout domain). */
export function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "0.0.0.0";
}

/**
 * The app's own hosts: APP_URL's, local ones and every *.vercel.app deployment (previews and the
 * production alias, which the operator uses for the dashboard). A checkout domain can never be one.
 */
export function isAppHost(hostname: string, appHost: string, extraHosts: readonly string[] = []): boolean {
  if (!hostname) return true; // no Host header: nothing to guard
  return hostname === appHost || isLocalHost(hostname) || hostname === "vercel.app" || hostname.endsWith(".vercel.app") || extraHosts.includes(hostname);
}

/**
 * Extra hosts of this deployment that serve the dashboard (beyond APP_URL's and *.vercel.app): the
 * deployment and branch URLs Vercel sets. The one list used by the proxy and the /c pages.
 * VERCEL_PROJECT_PRODUCTION_URL is only trusted when it is a *.vercel.app name: Vercel sets it to the
 * project's shortest production domain, which becomes a merchant's checkout domain
 * (checkout.seyuna.com) as soon as one is added to the project. Pure.
 */
export function appExtraHosts(e: Record<string, string | undefined> = process.env): string[] {
  const prod = e.VERCEL_PROJECT_PRODUCTION_URL?.trim().toLowerCase();
  return [e.VERCEL_URL, e.VERCEL_BRANCH_URL, prod && prod.endsWith(".vercel.app") ? prod : undefined]
    .map((h) => h?.trim().toLowerCase())
    .filter((h): h is string => !!h)
    .concat(operatorHosts(e));
}

/**
 * OPERATOR_HOSTS (optional, comma-separated): the operator's other hosts of this deployment (its own
 * dashboard alias, marketing domain…). Served as the app (never as a checkout domain) and refused as
 * a store's checkout domain. Pure.
 */
export function operatorHosts(e: Record<string, string | undefined> = process.env): string[] {
  return (e.OPERATOR_HOSTS ?? "")
    .split(",")
    .map((h) => hostnameOf(h.trim().replace(/^https?:\/\//i, "").split("/")[0]))
    .filter((h) => !!h);
}

/** Paths a checkout domain serves: buyer pages and APIs, verification files, static assets. */
export function isBuyerPath(pathname: string): boolean {
  if (pathname === "/c" || pathname.startsWith("/c/")) return true;
  if (pathname.startsWith("/api/public/")) return true;
  if (pathname.startsWith("/.well-known/")) return true;
  if (pathname.startsWith("/_next/")) return true;
  if (pathname.startsWith("/fonts/")) return true;
  if (["/favicon.ico", "/icon.svg", "/apple-icon.png", "/robots.txt", "/loader.js", "/checkout-icon.svg"].includes(pathname)) return true;
  // Static files of public/ and generated icons (a dotted last segment, never a page or API route).
  return /^\/[\w\-./]*\.(?:svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|css|js|map|txt|webmanifest)$/i.test(pathname) && !pathname.startsWith("/api/") && !pathname.startsWith("/dashboard");
}

export type HostDecision = { action: "next" } | { action: "redirect"; location: string } | { action: "rewrite"; path: string } | { action: "not_found" };

/** Route answering the root of a checkout domain (sends the buyer to the store's storefront). */
export const DOMAIN_HOME_PATH = "/api/public/domain-home";

/**
 * What the proxy does with a request: the app's own hosts and buyer paths pass; anything else on a
 * checkout domain (dashboard, login, admin APIs, cron…) goes to the same path on APP_URL. The root of
 * a checkout domain goes to DOMAIN_HOME_PATH, which sends the buyer to the store's own site (never the
 * operator's login page under the merchant's brand).
 */
export function hostDecision(input: { host: string | null | undefined; pathname: string; search: string; appUrl: string; extraHosts?: readonly string[] }): HostDecision {
  const appHost = new URL(input.appUrl).hostname.toLowerCase();
  const hostname = hostnameOf(input.host);
  if (isAppHost(hostname, appHost, input.extraHosts)) return { action: "next" };
  if (isBuyerPath(input.pathname)) return { action: "next" };
  if (input.pathname === "/" || input.pathname === "") return { action: "rewrite", path: DOMAIN_HOME_PATH };
  return { action: "redirect", location: `${input.appUrl.replace(/\/$/, "")}${input.pathname}${input.search}` };
}
