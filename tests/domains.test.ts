import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  checkoutBaseUrl,
  checkoutHostOf,
  checkoutHostRedirect,
  thankYouReturnUrl,
  cnameName,
  domainStatus,
  domainToken,
  formatDomainError,
  humanizePingError,
  isApexDomain,
  normalizeCheckoutDomain,
  parseDomainError,
  queryOf,
} from "@/lib/checkout-domain";
import { appExtraHosts, hostDecision, hostnameOf, isAppHost, isBuyerPath, operatorHosts } from "@/lib/host-guard";
import { vercelConfig, vercelDomainProblem } from "@/lib/vercel-domains";
import { proxy } from "@/proxy";

/*
 * Checkout domains (checkout.seyuna.com): domain validation, the buyer base URL, the proxy's host
 * guard (dashboard paths on a checkout host go to APP_URL), the /c pages' host redirect and the
 * statuses shown on the dashboard card. Pure.
 */

const APP = "https://checkout.example.com";
const verified = { checkoutDomain: "checkout.seyuna.com", checkoutDomainVerifiedAt: new Date() };
const pending = { checkoutDomain: "checkout.seyuna.com", checkoutDomainVerifiedAt: null };
const none = { checkoutDomain: null, checkoutDomainVerifiedAt: null };

describe("domain validation", () => {
  const ok = (input: string, opts = {}) => normalizeCheckoutDomain(input, { appUrl: APP, ...opts });

  it("accepts a subdomain and normalizes case, scheme, trailing slash and dot", () => {
    expect(ok("checkout.seyuna.com")).toEqual({ ok: true, domain: "checkout.seyuna.com" });
    expect(ok("  https://Checkout.Seyuna.COM/ ")).toEqual({ ok: true, domain: "checkout.seyuna.com" });
    expect(ok("seyuna.mycheckout.com.")).toEqual({ ok: true, domain: "seyuna.mycheckout.com" });
    expect(ok("paiement.café.fr")).toEqual({ ok: true, domain: "paiement.xn--caf-dma.fr" });
  });

  it("empty means no checkout domain", () => {
    expect(ok("   ")).toEqual({ ok: true, domain: null });
  });

  it("refuses paths, ports, e-mails and malformed names", () => {
    for (const bad of ["checkout.seyuna.com/c", "checkout.seyuna.com:8443", "moi@seyuna.com", "ftp://seyuna.com", "seyuna", "-bad.seyuna.com", "check out.seyuna.com", "a..seyuna.com", "seyuna.c0m"]) {
      expect(ok(bad).ok, bad).toBe(false);
    }
  });

  it("refuses the app's own host, *.vercel.app, *.myshopify.com, IPs and local hosts", () => {
    expect(ok("checkout.example.com")).toMatchObject({ ok: false, error: expect.stringContaining("checkout universel") });
    expect(ok("whop-chekout.vercel.app")).toMatchObject({ ok: false, error: expect.stringContaining("vercel.app") });
    expect(ok("other-project.vercel.app").ok).toBe(false);
    expect(ok("seyuna.myshopify.com").ok).toBe(false);
    expect(ok("192.168.1.10").ok).toBe(false);
    expect(ok("app.localhost").ok).toBe(false);
  });

  it("refuses the storefront itself (the shop would stop working), with or without www", () => {
    const opts = { storefrontHosts: ["seyuna.com", "seyuna.myshopify.com", null] };
    expect(ok("seyuna.com", opts)).toMatchObject({ ok: false, error: expect.stringContaining("checkout.seyuna.com") });
    expect(ok("www.seyuna.com", opts).ok).toBe(false);
    expect(ok("checkout.seyuna.com", opts)).toEqual({ ok: true, domain: "checkout.seyuna.com" });
  });

  it("a root domain (apex) needs the explicit confirmation: its record would replace the main site", () => {
    for (const apex of ["seyuna.com", "seyuna.co.uk", "https://Seyuna.fr/"]) {
      expect(ok(apex), apex).toMatchObject({ ok: false, apex: true, error: expect.stringContaining("remplacera votre site principal") });
    }
    expect(ok("seyuna.com", { confirmApex: true })).toEqual({ ok: true, domain: "seyuna.com" });
    // Subdomains (and names whose apex can't be told) never need it.
    expect(ok("checkout.seyuna.com")).toEqual({ ok: true, domain: "checkout.seyuna.com" });
    expect(ok("pay.abc.fr")).toEqual({ ok: true, domain: "pay.abc.fr" });
  });

  it("names the DNS record to create", () => {
    expect(cnameName("checkout.seyuna.com")).toBe("checkout");
    expect(cnameName("pay.shop.seyuna.com")).toBe("pay.shop");
    expect(cnameName("seyuna.com")).toBe("@");
    expect(cnameName("checkout.seyuna.co.uk")).toBe("checkout");
    expect(cnameName("seyuna.co.uk")).toBe("@");
    expect(cnameName("paiement.seyuna.com.br")).toBe("paiement");
    expect(cnameName("checkout.seyuna.fr")).toBe("checkout");
    expect(cnameName("checkout.seyuna.shop")).toBe("checkout");
    // Unsure whether "abc.fr" is the registrable domain: the full hostname (never a wrong short name).
    expect(cnameName("pay.abc.fr")).toBe("pay.abc.fr");
  });

  it("never answers \"@\" (the root of the merchant's domain) for a subdomain under an unknown second level", () => {
    // store.fr, info.be, web.de are ordinary registrable domains, not registry suffixes.
    expect(cnameName("checkout.store.fr")).toBe("checkout");
    expect(cnameName("checkout.info.be")).toBe("checkout");
    expect(cnameName("checkout.boutique.de")).toBe("checkout");
    expect(cnameName("checkout.web.de")).toBe("checkout.web.de");
    expect(cnameName("checkout.biz.pl")).toBe("checkout.biz.pl");
    for (const d of ["checkout.store.fr", "checkout.info.be", "checkout.web.de", "checkout.me.fr", "pay.shop.it", "checkout.seyuna.io"]) expect(cnameName(d), d).not.toBe("@");
    // Known registry suffixes keep their apex / subdomain split.
    expect(cnameName("seyuna.com.au")).toBe("@");
    expect(cnameName("pay.seyuna.co.jp")).toBe("pay");
  });
});

describe("thankYouReturnUrl", () => {
  it("returns to the store's host; to APP_URL with ?via=app when paying there on the loader's fallback", () => {
    expect(thankYouReturnUrl(verified, "s1", "checkout.seyuna.com", APP)).toBe("https://checkout.seyuna.com/c/s1/merci");
    expect(thankYouReturnUrl(verified, "s1", "checkout.example.com", APP)).toBe(`${APP}/c/s1/merci?via=app`);
    expect(thankYouReturnUrl(verified, "s1", "Checkout.Example.com:443", `${APP}/`)).toBe(`${APP}/c/s1/merci?via=app`);
    expect(thankYouReturnUrl(verified, "s1", null, APP)).toBe("https://checkout.seyuna.com/c/s1/merci");
    // No verified domain: APP_URL, no via needed.
    expect(thankYouReturnUrl(pending, "s1", "checkout.example.com", APP)).toBe(`${APP}/c/s1/merci`);
    expect(thankYouReturnUrl(none, "s1", "checkout.example.com", APP)).toBe(`${APP}/c/s1/merci`);
  });
});

describe("checkoutBaseUrl", () => {
  it("uses the store's domain only once verified, else APP_URL", () => {
    expect(checkoutBaseUrl(verified, APP)).toBe("https://checkout.seyuna.com");
    expect(checkoutBaseUrl(pending, APP)).toBe(APP);
    expect(checkoutBaseUrl(none, `${APP}/`)).toBe(APP);
    expect(checkoutHostOf(verified, APP)).toBe("checkout.seyuna.com");
    expect(checkoutHostOf(none, APP)).toBe("checkout.example.com");
  });

  it("defaults to the APP_URL environment variable", () => {
    expect(checkoutBaseUrl(none)).toBe(process.env.APP_URL);
  });
});

describe("host guard (proxy)", () => {
  const decide = (host: string, pathname: string, search = "") => hostDecision({ host, pathname, search, appUrl: APP });

  it("lets the app's own hosts through untouched", () => {
    expect(decide("checkout.example.com", "/dashboard")).toEqual({ action: "next" });
    expect(decide("localhost:3000", "/dashboard")).toEqual({ action: "next" });
    expect(decide("whop-chekout-git-main-me.vercel.app", "/login")).toEqual({ action: "next" });
    expect(isAppHost("", "checkout.example.com")).toBe(true);
    expect(isAppHost("pay.example.org", "checkout.example.com", ["pay.example.org"])).toBe(true);
  });

  it("serves buyer paths on a checkout domain", () => {
    for (const p of ["/c/abc", "/c/abc/merci", "/api/public/sessions", "/api/public/sessions/x/prepare", "/.well-known/whop-checkout-ping", "/.well-known/apple-developer-merchantid-domain-association", "/_next/static/chunks/a.js", "/fonts/inter.woff2", "/icon.svg", "/apple-icon.png", "/favicon.ico", "/loader.js", "/checkout-icon.svg"]) {
      expect(decide("checkout.seyuna.com", p), p).toEqual({ action: "next" });
    }
  });

  it("sends the dashboard, login, admin APIs and cron of a checkout domain to APP_URL (same path)", () => {
    expect(decide("Checkout.Seyuna.com:443", "/dashboard/stores/x/settings", "?a=1")).toEqual({ action: "redirect", location: `${APP}/dashboard/stores/x/settings?a=1` });
    expect(decide("checkout.seyuna.com", "/login")).toEqual({ action: "redirect", location: `${APP}/login` });
    expect(decide("checkout.seyuna.com", "/api/cron/tick")).toEqual({ action: "redirect", location: `${APP}/api/cron/tick` });
    expect(decide("checkout.seyuna.com", "/api/webhooks/whop/s1")).toEqual({ action: "redirect", location: `${APP}/api/webhooks/whop/s1` });
    expect(decide("checkout.seyuna.com", "/dashboard/export.csv")).toMatchObject({ action: "redirect" });
    expect(decide("checkout.seyuna.com", "/api/health.js")).toMatchObject({ action: "redirect" });
    expect(decide("checkout.seyuna.com", "/setup")).toMatchObject({ action: "redirect" });
    // The root never shows the operator's login page under the merchant's domain: the store's site instead.
    expect(decide("checkout.seyuna.com", "/")).toEqual({ action: "rewrite", path: "/api/public/domain-home" });
  });

  it("parses Host headers", () => {
    expect(hostnameOf("Checkout.Seyuna.com.:443")).toBe("checkout.seyuna.com");
    expect(hostnameOf("[::1]:3000")).toBe("[::1]");
    expect(hostnameOf(null)).toBe("");
    expect(isBuyerPath("/dashboard/logo.png")).toBe(false);
  });

  it("proxy(): 307 to APP_URL for a dashboard path on a checkout host, pass-through otherwise", () => {
    const res = proxy(new NextRequest("https://checkout.seyuna.com/dashboard?x=1", { headers: { host: "checkout.seyuna.com" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${APP}/dashboard?x=1`);
    const buyer = proxy(new NextRequest("https://checkout.seyuna.com/c/abc", { headers: { host: "checkout.seyuna.com" } }));
    expect(buyer.headers.get("x-middleware-next")).toBe("1");
    const app = proxy(new NextRequest(`${APP}/dashboard`, { headers: { host: "checkout.example.com" } }));
    expect(app.headers.get("x-middleware-next")).toBe("1");
    const root = proxy(new NextRequest("https://checkout.seyuna.com/", { headers: { host: "checkout.seyuna.com" } }));
    expect(root.headers.get("x-middleware-rewrite")).toBe("https://checkout.seyuna.com/api/public/domain-home");
  });
});

describe("app hosts (proxy and /c pages share one list)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("never trusts VERCEL_PROJECT_PRODUCTION_URL once it is a merchant's custom domain", () => {
    expect(appExtraHosts({ VERCEL_URL: "app-abc123.vercel.app", VERCEL_BRANCH_URL: "app-git-main.vercel.app", VERCEL_PROJECT_PRODUCTION_URL: "checkout.seyuna.com" })).toEqual(["app-abc123.vercel.app", "app-git-main.vercel.app"]);
    expect(appExtraHosts({ VERCEL_PROJECT_PRODUCTION_URL: "Whop-Chekout.vercel.app" })).toEqual(["whop-chekout.vercel.app"]);
    expect(appExtraHosts({})).toEqual([]);
  });

  it("OPERATOR_HOSTS: the operator's own hosts are app hosts, never a checkout domain", () => {
    const e = { OPERATOR_HOSTS: " Admin.MonDomaine.com , https://www.mondomaine.com/, ," };
    expect(operatorHosts(e)).toEqual(["admin.mondomaine.com", "www.mondomaine.com"]);
    expect(appExtraHosts(e)).toEqual(["admin.mondomaine.com", "www.mondomaine.com"]);
    expect(hostDecision({ host: "admin.mondomaine.com", pathname: "/dashboard", search: "", appUrl: APP, extraHosts: appExtraHosts(e) })).toEqual({ action: "next" });
    const refused = normalizeCheckoutDomain("admin.mondomaine.com", { appUrl: APP, operatorHosts: operatorHosts(e) });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("réservée") });
    vi.stubEnv("OPERATOR_HOSTS", "admin.mondomaine.com");
    expect(normalizeCheckoutDomain("admin.mondomaine.com", { appUrl: APP }).ok).toBe(false);
    expect(normalizeCheckoutDomain("checkout.mondomaine.com", { appUrl: APP }).ok).toBe(true);
  });

  it("proxy(): the dashboard stays off a merchant domain even when Vercel reports it as the production URL", () => {
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "checkout.seyuna.com");
    const res = proxy(new NextRequest("https://checkout.seyuna.com/dashboard", { headers: { host: "checkout.seyuna.com" } }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`${APP}/dashboard`);
    expect(proxy(new NextRequest("https://checkout.seyuna.com/login", { headers: { host: "checkout.seyuna.com" } })).status).toBe(307);
    // The /c pages treat it as a checkout host too (another store's domain → the right host).
    expect(checkoutHostRedirect(none, "checkout.seyuna.com", "/c/s1", APP, appExtraHosts())).toBe(`${APP}/c/s1`);
  });

  it("proxy(): a deployment URL set by Vercel still serves the dashboard", () => {
    vi.stubEnv("VERCEL_URL", "pay.operator.dev");
    const res = proxy(new NextRequest("https://pay.operator.dev/dashboard", { headers: { host: "pay.operator.dev" } }));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("/c pages: host redirect", () => {
  const r = (store: typeof verified | typeof pending | typeof none, host: string, path = "/c/s1?lang=en") => checkoutHostRedirect(store, host, path, APP);

  it("sends APP_URL visitors to the store's verified domain (query kept)", () => {
    expect(r(verified, "checkout.example.com")).toBe("https://checkout.seyuna.com/c/s1?lang=en");
    expect(r(verified, "checkout.seyuna.com")).toBeNull();
  });

  it("sends another store's (or an unverified) domain back to the right host", () => {
    expect(r(verified, "checkout.autre.com")).toBe("https://checkout.seyuna.com/c/s1?lang=en");
    expect(r(pending, "checkout.seyuna.com")).toBe(`${APP}/c/s1?lang=en`);
    expect(r(none, "checkout.autre.com")).toBe(`${APP}/c/s1?lang=en`);
    expect(r(none, "checkout.example.com")).toBeNull();
  });

  it("leaves local and preview hosts alone", () => {
    expect(r(verified, "localhost:4997")).toBeNull();
    expect(r(verified, "127.0.0.1:3000")).toBeNull();
    expect(r(verified, "whop-chekout-git-x.vercel.app")).toBeNull();
    expect(r(verified, "")).toBeNull();
  });

  it("stays on APP_URL after the loader's fallback (?via=app), only there", () => {
    expect(checkoutHostRedirect(verified, "checkout.example.com", "/c/s1?via=app", APP, [], { viaApp: true })).toBeNull();
    expect(checkoutHostRedirect(verified, "checkout.autre.com", "/c/s1?via=app", APP, [], { viaApp: true })).toBe("https://checkout.seyuna.com/c/s1?via=app");
  });

  it("rebuilds the query of a page's searchParams", () => {
    expect(queryOf({ lang: "en", payment_id: "pay_1", multi: ["a", "b"], none: undefined })).toBe("?lang=en&payment_id=pay_1&multi=a&multi=b");
    expect(queryOf({})).toBe("");
  });
});

describe("verification token and statuses", () => {
  it("token is per store and per domain, stable, not guessable without the secret", () => {
    const t = domainToken("store1", "checkout.seyuna.com", "s");
    expect(t).toMatch(/^whopco-[\w-]{32}$/);
    expect(domainToken("store1", "CHECKOUT.seyuna.com", "s")).toBe(t);
    expect(domainToken("store2", "checkout.seyuna.com", "s")).not.toBe(t);
    expect(domainToken("store1", "pay.seyuna.com", "s")).not.toBe(t);
    expect(domainToken("store1", "checkout.seyuna.com", "other")).not.toBe(t);
  });

  it("badge: À configurer / En attente DNS / Vérifié / Erreur", () => {
    const base = { checkoutDomainError: null };
    expect(domainStatus({ ...none, ...base })).toMatchObject({ status: "none", label: "À configurer" });
    expect(domainStatus({ ...pending, ...base })).toMatchObject({ status: "pending", label: "En attente DNS", message: null });
    expect(domainStatus({ ...pending, checkoutDomainError: formatDomainError("dns", "introuvable") })).toMatchObject({ status: "pending", message: "introuvable" });
    expect(domainStatus({ ...pending, checkoutDomainError: formatDomainError("tls", "certificat") })).toMatchObject({ status: "pending" });
    expect(domainStatus({ ...pending, checkoutDomainError: formatDomainError("mismatch", "autre site") })).toMatchObject({ status: "error", label: "Erreur", message: "autre site" });
    expect(domainStatus({ ...verified, ...base })).toMatchObject({ status: "verified", label: "Vérifié", message: null });
    // First failed check of a verified domain: still verified (in use), the failure shown.
    expect(domainStatus({ ...verified, checkoutDomainError: formatDomainError("timeout", "pas de réponse") })).toMatchObject({ status: "verified", message: "pas de réponse" });
    expect(parseDomainError("texte libre")).toEqual({ kind: "http", message: "texte libre" });
  });

  it("humanizes network failures in plain French", () => {
    const withCode = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
    expect(humanizePingError(withCode("ENOTFOUND"))).toMatchObject({ kind: "dns", message: expect.stringContaining("cname.vercel-dns.com") });
    expect(humanizePingError(withCode("ERR_TLS_CERT_ALTNAME_INVALID"))).toMatchObject({ kind: "tls", message: expect.stringContaining("certificat HTTPS") });
    expect(humanizePingError(Object.assign(new Error("t"), { name: "TimeoutError" }))).toMatchObject({ kind: "timeout", message: expect.stringContaining("à temps") });
    expect(humanizePingError(withCode("ECONNREFUSED")).kind).toBe("dns");
    expect(humanizePingError(new Error("weird")).kind).toBe("http");
  });

  it("an apex domain is told to add an A record to 76.76.21.21, never a CNAME", async () => {
    const withCode = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
    expect(isApexDomain("seyuna.com")).toBe(true);
    expect(isApexDomain("seyuna.co.uk")).toBe(true);
    expect(isApexDomain("checkout.seyuna.com")).toBe(false);
    for (const code of ["ENOTFOUND", "ECONNREFUSED"]) {
      const apex = humanizePingError(withCode(code), { apex: true });
      expect(apex.message, code).toContain("enregistrement A");
      expect(apex.message, code).toContain("76.76.21.21");
      expect(apex.message, code).not.toContain("CNAME");
      expect(humanizePingError(withCode(code)).message, code).toContain("CNAME");
    }
    // Vercel's "misconfigured" DNS, worded for the record the domain needs.
    const cfg = { token: "t", projectId: "p", teamId: null };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => (String(input).includes("/config") ? Response.json({ misconfigured: true }) : Response.json({ name: "x", verified: true }))),
    );
    try {
      const apex = await vercelDomainProblem(cfg, "seyuna.com", { apex: true });
      expect(apex).toContain("enregistrement A vers 76.76.21.21");
      expect(apex).not.toContain("CNAME");
      expect(await vercelDomainProblem(cfg, "checkout.seyuna.com")).toContain("CNAME vers cname.vercel-dns.com");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("Vercel automation only with a token and a project id", () => {
    expect(vercelConfig({})).toBeNull();
    expect(vercelConfig({ VERCEL_API_TOKEN: "t" })).toBeNull();
    expect(vercelConfig({ VERCEL_API_TOKEN: "t", VERCEL_PROJECT_ID: "prj_1" })).toEqual({ token: "t", projectId: "prj_1", teamId: null });
    expect(vercelConfig({ VERCEL_API_TOKEN: "t", VERCEL_PROJECT_ID: "prj_1", VERCEL_TEAM_ID: "team_1" })?.teamId).toBe("team_1");
  });
});
