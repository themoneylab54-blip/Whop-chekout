import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The buyer's cart re-read server-side (bundles, automatic discounts, app prices): asked on the
 * shop's *.myshopify.com address — Shopify's own answer, whose redirect names the shop's current
 * domain (a domain recorded at connection could have lapsed and changed hands) — following up to two
 * redirects by hand: a redirect the fetch followed itself would drop the cart's cookie (every bundle
 * cart was refused as unreadable). Never to an IP, a port, a local name or plain http.
 */

const incidents = vi.hoisted(() => ({ recordIncident: vi.fn(async (_e: unknown) => undefined) }));
vi.mock("@/lib/incidents", () => incidents);

const { readCartJs, storefrontHosts, cartRedirectAllowed } = await import("@/lib/shopify-discounts");

const CART = { token: "hWN1", currency: "EUR", total_price: 6490, items: [{ variant_id: 1, quantity: 5 }] };
type Call = { url: string; cookie: string | null; redirect: RequestRedirect | undefined };
let calls: Call[] = [];
const serve = (routes: Record<string, () => Response>) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, cookie: new Headers(init?.headers).get("cookie"), redirect: init?.redirect });
      const route = routes[url];
      if (!route) throw new TypeError(`fetch failed: ${url}`);
      return route();
    }),
  );
const cartJs = () => new Response(JSON.stringify(CART), { status: 200, headers: { "content-type": "application/json" } });
const moved = (to: string) => () => new Response(null, { status: 301, headers: { location: to } });

beforeEach(() => {
  calls = [];
  incidents.recordIncident.mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the shop's storefront hosts and the redirects a cart's cookie may follow", () => {
  it("the shop's domain (as a URL writes it, its www and bare twins), then *.myshopify.com", () => {
    expect(storefrontHosts({ storefrontHost: "Sovéline.fr", shopDomain: "yctp21-8n.myshopify.com" })).toEqual(["xn--sovline-dya.fr", "www.xn--sovline-dya.fr", "yctp21-8n.myshopify.com"]);
    expect(storefrontHosts({ storefrontHost: "www.colandcie.com", shopDomain: "27vmem-y1.myshopify.com" })).toEqual(["www.colandcie.com", "colandcie.com", "27vmem-y1.myshopify.com"]);
    expect(storefrontHosts({ storefrontHost: null, shopDomain: "shop-1.myshopify.com" })).toEqual(["shop-1.myshopify.com"]);
  });

  it("anywhere public from *.myshopify.com (Shopify's redirect to the shop's domain); else the shop's own hosts or a www / bare twin; never an IP, a local name, a port or http", () => {
    const hosts = storefrontHosts({ storefrontHost: "colandcie.com", shopDomain: "27vmem-y1.myshopify.com" });
    const u = (s: string) => new URL(s);
    expect(cartRedirectAllowed(u("https://27vmem-y1.myshopify.com/cart.js"), u("https://new-domain.fr/cart.js"), hosts)).toBe(true);
    expect(cartRedirectAllowed(u("https://colandcie.com/cart.js"), u("https://www.colandcie.com/cart.js"), hosts)).toBe(true);
    expect(cartRedirectAllowed(u("https://new-domain.fr/cart.js"), u("https://www.new-domain.fr/cart.js"), hosts)).toBe(true);
    expect(cartRedirectAllowed(u("https://colandcie.com/cart.js"), u("https://other-shop.example/cart.js"), hosts)).toBe(false);
    for (const bad of ["http://colandcie.com/cart.js", "https://127.0.0.1/cart.js", "https://127.1/cart.js", "https://[::1]/cart.js", "https://localhost/cart.js", "https://colandcie.com:8443/cart.js"]) {
      expect(cartRedirectAllowed(u("https://27vmem-y1.myshopify.com/cart.js"), u(bad), hosts), bad).toBe(false);
    }
  });
});

describe("readCartJs: the buyer's cart, asked of Shopify, read on the shop's current domain", () => {
  const store = { id: "st_1", shopDomain: "yctp21-8n.myshopify.com", storefrontHost: "xn--sovline-dya.fr" };

  it("Shopify's redirect to the shop's domain followed by hand, the cart's cookie on each request", async () => {
    serve({ "https://yctp21-8n.myshopify.com/cart.js": moved("https://xn--sovline-dya.fr/cart.js"), "https://xn--sovline-dya.fr/cart.js": cartJs });
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1", total_price: 6490 });
    expect(calls).toEqual([
      { url: "https://yctp21-8n.myshopify.com/cart.js", cookie: "cart=hWN1?key=abc", redirect: "manual" },
      { url: "https://xn--sovline-dya.fr/cart.js", cookie: "cart=hWN1?key=abc", redirect: "manual" },
    ]);
    expect(incidents.recordIncident).not.toHaveBeenCalled();
  });

  it("a shop without its own domain: Shopify answers at once; the shop's domain then its www twin: two redirects", async () => {
    serve({ "https://yctp21-8n.myshopify.com/cart.js": cartJs });
    expect(await readCartJs({ ...store, storefrontHost: null }, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    serve({
      "https://yctp21-8n.myshopify.com/cart.js": moved("https://xn--sovline-dya.fr/cart.js"),
      "https://xn--sovline-dya.fr/cart.js": moved("https://www.xn--sovline-dya.fr/cart.js"),
      "https://www.xn--sovline-dya.fr/cart.js": cartJs,
    });
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
  });

  it("a recorded domain that changed hands is never asked: Shopify's redirect names the current one", async () => {
    serve({
      "https://old-domain.fr/cart.js": () => new Response(JSON.stringify({ ...CART, total_price: 0 }), { status: 200 }),
      "https://yctp21-8n.myshopify.com/cart.js": moved("https://xn--sovline-dya.fr/cart.js"),
      "https://xn--sovline-dya.fr/cart.js": cartJs,
    });
    expect(await readCartJs({ ...store, storefrontHost: "old-domain.fr" }, "hWN1?key=abc")).toMatchObject({ total_price: 6490 });
    expect(calls.map((c) => c.url)).not.toContain("https://old-domain.fr/cart.js");
  });

  it("a redirect to another site, a third redirect, an error page, a body that isn't a cart: null, journaled — the cookie never leaves the shop", async () => {
    serve({ "https://yctp21-8n.myshopify.com/cart.js": moved("https://xn--sovline-dya.fr/cart.js"), "https://xn--sovline-dya.fr/cart.js": moved("https://other-shop.example/cart.js") });
    expect(await readCartJs(store, "hWN1?key=abc")).toBeNull();
    expect(calls.map((c) => c.url)).not.toContain("https://other-shop.example/cart.js");
    expect(incidents.recordIncident).toHaveBeenCalledWith(expect.objectContaining({ kind: "discount.cart_read_failed", storeId: "st_1" }));
    calls = [];
    serve({
      "https://yctp21-8n.myshopify.com/cart.js": moved("https://xn--sovline-dya.fr/cart.js"),
      "https://xn--sovline-dya.fr/cart.js": moved("https://www.xn--sovline-dya.fr/cart.js"),
      "https://www.xn--sovline-dya.fr/cart.js": moved("https://xn--sovline-dya.fr/cart.js"),
    });
    expect(await readCartJs(store, "hWN1?key=abc")).toBeNull();
    expect(calls).toHaveLength(3);
    for (const page of [() => new Response("busy", { status: 429 }), () => new Response("<html>challenge</html>", { status: 200 }), () => new Response(JSON.stringify({ items: [], pad: "x".repeat(1_100_000) }), { status: 200 })]) {
      serve({ "https://yctp21-8n.myshopify.com/cart.js": page });
      expect(await readCartJs(store, "hWN1?key=abc")).toBeNull();
    }
  });

  it("no token worth asking with, no Shopify address: nothing asked", async () => {
    serve({});
    expect(await readCartJs(store, "short")).toBeNull();
    expect(await readCartJs({ ...store, shopDomain: null }, "hWN1?key=abc")).toBeNull();
    expect(calls).toEqual([]);
  });
});
