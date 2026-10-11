import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The buyer's cart re-read server-side (bundles, automatic discounts, app prices): asked on the
 * shop's *.myshopify.com address — Shopify's own answer, whose redirect names the shop's current
 * domain (a domain recorded at connection could have lapsed and changed hands) — following up to two
 * redirects by hand: a redirect the fetch followed itself would drop the cart's cookie (every bundle
 * cart was refused as unreadable). Never to an IP, a port, a local name or plain http. The host
 * Shopify's redirect led to (its /cart.js itself) is where the store's reads start for 10 minutes (one
 * request instead of two); silent for half the read's time (1 s at most), *.myshopify.com is asked
 * too and the first cart to arrive wins; any failure there forgets it.
 */

const incidents = vi.hoisted(() => ({ recordIncident: vi.fn<(e: unknown) => Promise<undefined>>(async () => undefined) }));
vi.mock("@/lib/incidents", () => incidents);

const { readCartJs, storefrontHosts, cartRedirectAllowed, clearShopifyDiscountCache, hedgedCartRead } = await import("@/lib/shopify-discounts");
const { log } = await import("@/lib/log");

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
  clearShopifyDiscountCache();
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

describe("readCartJs: where Shopify's redirect led, the store's next reads start (10 minutes)", () => {
  const store = { id: "st_1", shopDomain: "yctp21-8n.myshopify.com", storefrontHost: "xn--sovline-dya.fr" };
  const SHOPIFY = "https://yctp21-8n.myshopify.com/cart.js";
  const DOMAIN = "https://xn--sovline-dya.fr/cart.js";
  const NEW = "https://new-domain.fr/cart.js";
  const urls = () => calls.map((c) => c.url);
  /** A read through Shopify's redirect (remembered), then the calls forgotten. */
  const learn = async (s = store, routes: Record<string, () => Response> = { [SHOPIFY]: moved(DOMAIN), [DOMAIN]: cartJs }) => {
    serve(routes);
    expect(await readCartJs(s, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    calls = [];
  };
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the store's next read starts where Shopify's redirect led: one request, the same cookie", async () => {
    await learn();
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1", total_price: 6490 });
    expect(calls).toEqual([{ url: DOMAIN, cookie: "cart=hWN1?key=abc", redirect: "manual" }]);
    // Through the shop's domain then its www twin: the host that answered is the start.
    const WWW = "https://www.xn--sovline-dya.fr/cart.js";
    const other = { ...store, id: "st_2" };
    await learn(other, { [SHOPIFY]: moved(DOMAIN), [DOMAIN]: moved(WWW), [WWW]: cartJs });
    expect(await readCartJs(other, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    expect(urls()).toEqual([WWW]);
    expect(incidents.recordIncident).not.toHaveBeenCalled();
  });

  it("the remembered host failing in any way: forgotten, Shopify asked again within the same read, its new answer the start", async () => {
    const failures = [
      () => new Response("busy", { status: 503 }),
      () => new Response("<html>not a cart</html>", { status: 200 }),
      moved("https://other-shop.example/cart.js"),
      () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const failing of failures) {
      clearShopifyDiscountCache();
      await learn();
      serve({ [DOMAIN]: failing, [SHOPIFY]: moved(NEW), [NEW]: cartJs });
      expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
      expect(urls()).toEqual([DOMAIN, SHOPIFY, NEW]);
      // The domain change picked up at once: the next read starts on the new domain.
      calls = [];
      expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
      expect(urls()).toEqual([NEW]);
      calls = [];
    }
    expect(incidents.recordIncident).not.toHaveBeenCalled();
    // Shopify answering itself now (the shop dropped its domain): nothing remembered.
    serve({ [NEW]: () => new Response("gone", { status: 404 }), [SHOPIFY]: cartJs });
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    expect(urls()).toEqual([NEW, SHOPIFY]);
    calls = [];
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    expect(urls()).toEqual([SHOPIFY]);
  });

  /**
   * Like serve, but `hang` never answers and `slow` answers after its delay (both until the request is
   * aborted, as a dead or slow host's would); when each request started and whether it was stopped.
   */
  let started: Record<string, number> = {};
  let stopped: string[] = [];
  const serveHanging = (routes: Record<string, () => Response>, hang: string[], slow: Record<string, number> = {}) => {
    started = {};
    stopped = [];
    const t0 = Date.now();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, cookie: new Headers(init?.headers).get("cookie"), redirect: init?.redirect });
        started[url] = Date.now() - t0;
        const signal = init?.signal;
        if (signal?.aborted) return Promise.reject(signal.reason);
        const route = routes[url];
        if (hang.includes(url) || slow[url] != null)
          return new Promise<Response>((resolve, reject) => {
            let done = false;
            const t =
              slow[url] != null && route
                ? setTimeout(() => {
                    done = true;
                    resolve(route());
                  }, slow[url])
                : undefined;
            // Stopped while still waiting for its answer (a later abort of a finished request isn't one).
            signal?.addEventListener("abort", () => {
              if (done) return;
              clearTimeout(t);
              stopped.push(url);
              reject(signal.reason);
            });
          });
        return route ? Promise.resolve(route()) : Promise.reject(new TypeError(`fetch failed: ${url}`));
      }),
    );
  };

  it("the remembered host silent for half the read's time (1 s at most): Shopify is asked too, its cart taken, the host it names the start; no incident", async () => {
    await learn();
    serveHanging({ [SHOPIFY]: moved(NEW), [NEW]: cartJs }, [DOMAIN]);
    const t0 = Date.now();
    expect(await readCartJs(store, "hWN1?key=abc", { timeoutMs: 600 })).toMatchObject({ token: "hWN1" });
    // Shopify asked after ~300 ms (half of 600), not at the end of the read.
    expect(started[SHOPIFY]).toBeGreaterThanOrEqual(290);
    expect(started[SHOPIFY]).toBeLessThan(450);
    expect(Date.now() - t0).toBeLessThan(590);
    expect(urls()).toEqual([DOMAIN, SHOPIFY, NEW]);
    // The silent read stopped once Shopify's cart arrived.
    expect(stopped).toEqual([DOMAIN]);
    expect(incidents.recordIncident).not.toHaveBeenCalled();
    calls = [];
    serve({ [NEW]: cartJs });
    await readCartJs(store, "hWN1?key=abc");
    expect(urls()).toEqual([NEW]);
    // The default 3 s read: Shopify asked after 1 s (the cap), not after half of 3 s.
    calls = [];
    serveHanging({ [SHOPIFY]: moved(DOMAIN), [DOMAIN]: cartJs }, [NEW]);
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    expect(started[SHOPIFY]).toBeGreaterThanOrEqual(990);
    expect(started[SHOPIFY]).toBeLessThan(1_300);
    expect(urls()).toEqual([NEW, SHOPIFY, DOMAIN]);
  });

  it("a slow but working remembered host still answers (Shopify asked meanwhile, stopped once it does); it stays the start, nothing logged", async () => {
    await learn();
    const warn = vi.spyOn(log, "warn");
    try {
      // Plain cart (1.5 s): the shop's domain answers in 850 ms, past its 750 ms; Shopify, asked then, is slower still.
      serveHanging({ [DOMAIN]: cartJs }, [], { [DOMAIN]: 850, [SHOPIFY]: 2_000 });
      for (let i = 0; i < 3; i++) {
        calls = [];
        expect(await readCartJs(store, "hWN1?key=abc", { timeoutMs: 1_500 })).toMatchObject({ token: "hWN1" });
        expect(urls()).toEqual([DOMAIN, SHOPIFY]);
        expect(stopped).toEqual([SHOPIFY]);
        serveHanging({ [DOMAIN]: cartJs }, [], { [DOMAIN]: 850, [SHOPIFY]: 2_000 });
      }
      expect(warn.mock.calls.filter(([event]) => event === "cart.read_host_forgotten")).toEqual([]);
      expect(incidents.recordIncident).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("any time limit works (whole milliseconds), the remembered host used", async () => {
    await learn();
    serve({ [DOMAIN]: cartJs });
    expect(await readCartJs(store, "hWN1?key=abc", { timeoutMs: 1_255 })).toMatchObject({ token: "hWN1" });
    expect(await readCartJs(store, "hWN1?key=abc", { timeoutMs: 0.5 })).toMatchObject({ token: "hWN1" });
    expect(urls()).toEqual([DOMAIN, DOMAIN]);
    expect(incidents.recordIncident).not.toHaveBeenCalled();
  });

  it("hedgedCartRead: the first answer wins, the loser stopped and its failure ignored; the first's own failure told and the second asked at once; both failing rejects", async () => {
    const after = (ms: number, v: string, stop: AbortSignal) =>
      new Promise<{ v: string }>((resolve, reject) => {
        const t = setTimeout(() => resolve({ v }), ms);
        stop.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new Error(`stopped ${v}`));
        });
      });
    const told: unknown[] = [];
    // The first answers within its time: the second never asked.
    let asked = false;
    expect(await hedgedCartRead((s) => after(10, "a", s), (s) => ((asked = true), after(10, "b", s)), 100, (e) => told.push(e))).toEqual({ v: "a", via: "first" });
    expect(asked).toBe(false);
    // The first silent: the second asked after 30 ms and wins; the first stopped, its stop never told.
    expect(await hedgedCartRead((s) => after(500, "a", s), (s) => after(10, "b", s), 30, (e) => told.push(e))).toEqual({ v: "b", via: "second" });
    // The first fails at once: told, the second asked without waiting.
    const t0 = Date.now();
    expect(await hedgedCartRead(() => Promise.reject(new Error("dead")), (s) => after(10, "b", s), 1_000, (e) => told.push(e))).toEqual({ v: "b", via: "second" });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(told.map((e) => (e as Error).message)).toEqual(["dead"]);
    // Both fail: the last error.
    await expect(hedgedCartRead(() => Promise.reject(new Error("one")), () => Promise.reject(new Error("two")), 10, () => undefined)).rejects.toThrow("two");
  });

  it("Shopify hanging too: the read ends at its time limit, one incident, the host forgotten", async () => {
    await learn();
    serveHanging({}, [DOMAIN, SHOPIFY]);
    const t0 = Date.now();
    expect(await readCartJs(store, "hWN1?key=abc", { timeoutMs: 200 })).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(urls()).toEqual([DOMAIN, SHOPIFY]);
    expect(incidents.recordIncident).toHaveBeenCalledTimes(1);
    calls = [];
    serve({ [SHOPIFY]: moved(DOMAIN), [DOMAIN]: cartJs });
    await readCartJs(store, "hWN1?key=abc");
    expect(urls()).toEqual([SHOPIFY, DOMAIN]);
  });

  it("only a redirect to the host's own /cart.js is remembered (a localized path, say, is Shopify's to name each time)", async () => {
    const LOCALIZED = "https://xn--sovline-dya.fr/en-us/cart.js";
    await learn(store, { [SHOPIFY]: moved(LOCALIZED), [LOCALIZED]: cartJs });
    serve({ [SHOPIFY]: moved(LOCALIZED), [LOCALIZED]: cartJs });
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    expect(urls()).toEqual([SHOPIFY, LOCALIZED]);
    // The remembered host redirecting to another path now: used this once, then Shopify asked again.
    calls = [];
    await learn();
    serve({ [DOMAIN]: moved(LOCALIZED), [LOCALIZED]: cartJs, [SHOPIFY]: moved(DOMAIN) });
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    expect(urls()).toEqual([DOMAIN, LOCALIZED]);
    calls = [];
    serve({ [SHOPIFY]: moved(DOMAIN), [DOMAIN]: cartJs });
    await readCartJs(store, "hWN1?key=abc");
    expect(urls()).toEqual([SHOPIFY, DOMAIN]);
  });

  it("the remembered host's own redirects follow the rules of a host Shopify redirected to: its www / bare twin, the shop's hosts, never another site", async () => {
    const WWW_NEW = "https://www.new-domain.fr/cart.js";
    await learn(store, { [SHOPIFY]: moved(NEW), [NEW]: cartJs });
    serve({ [NEW]: moved(WWW_NEW), [WWW_NEW]: cartJs });
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    expect(urls()).toEqual([NEW, WWW_NEW]);
    // It redirects now: Shopify is asked again next time, and names the host to start at.
    calls = [];
    serve({ [SHOPIFY]: moved(WWW_NEW), [WWW_NEW]: cartJs });
    await readCartJs(store, "hWN1?key=abc");
    expect(urls()).toEqual([SHOPIFY, WWW_NEW]);
    // To the shop's own domain: followed. To another site: refused (the cookie stays), Shopify asked again.
    calls = [];
    serve({ [WWW_NEW]: moved(DOMAIN), [DOMAIN]: cartJs });
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    expect(urls()).toEqual([WWW_NEW, DOMAIN]);
    await learn(store, { [SHOPIFY]: moved(NEW), [NEW]: cartJs });
    serve({ [NEW]: moved("https://other-shop.example/cart.js"), [SHOPIFY]: moved(DOMAIN), [DOMAIN]: cartJs });
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    expect(urls()).toEqual([NEW, SHOPIFY, DOMAIN]);
  });

  it("Shopify answering a read itself forgets the host another read learned meanwhile: its latest answer wins", async () => {
    let release: () => void = () => undefined;
    let held = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        calls.push({ url: String(input), cookie: new Headers(init?.headers).get("cookie"), redirect: init?.redirect });
        if (input === SHOPIFY && held) {
          held = false;
          await new Promise<void>((r) => (release = () => r()));
          return cartJs();
        }
        return input === SHOPIFY ? moved(DOMAIN)() : cartJs();
      }),
    );
    // A first read waits on Shopify; a second one is redirected meanwhile (the domain learned)…
    const slow = readCartJs(store, "hWN1?key=abc");
    expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
    // …then Shopify answers the first one itself: nothing remembered.
    release();
    expect(await slow).toMatchObject({ token: "hWN1" });
    calls = [];
    serve({ [SHOPIFY]: cartJs });
    await readCartJs(store, "hWN1?key=abc");
    expect(urls()).toEqual([SHOPIFY]);
  });

  it("10 minutes from Shopify's answer (a read on the remembered host doesn't extend them), then Shopify is asked again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await learn();
    serve({ [SHOPIFY]: moved(DOMAIN), [DOMAIN]: cartJs });
    vi.setSystemTime(Date.now() + 9 * 60_000);
    await readCartJs(store, "hWN1?key=abc");
    expect(urls()).toEqual([DOMAIN]);
    calls = [];
    vi.setSystemTime(Date.now() + 61_000);
    await readCartJs(store, "hWN1?key=abc");
    expect(urls()).toEqual([SHOPIFY, DOMAIN]);
    // Learned afresh.
    calls = [];
    await readCartJs(store, "hWN1?key=abc");
    expect(urls()).toEqual([DOMAIN]);
  });

  it("per store: another store starts at its own *.myshopify.com; this store connected to another shop never reads on the first shop's domain", async () => {
    await learn();
    const OTHER = "https://other-1.myshopify.com/cart.js";
    serve({ [OTHER]: cartJs, [DOMAIN]: cartJs });
    await readCartJs({ id: "st_9", shopDomain: "other-1.myshopify.com", storefrontHost: "xn--sovline-dya.fr" }, "hWN1?key=abc");
    expect(urls()).toEqual([OTHER]);
    calls = [];
    await readCartJs(store, "hWN1?key=abc");
    expect(urls()).toEqual([DOMAIN]);
    calls = [];
    await readCartJs({ ...store, shopDomain: "other-1.myshopify.com" }, "hWN1?key=abc");
    expect(urls()).toEqual([OTHER]);
  });

  it("never a refused or failed host remembered", async () => {
    const reads: Record<string, () => Response>[] = [
      { [SHOPIFY]: moved(DOMAIN), [DOMAIN]: () => new Response("error", { status: 500 }) },
      { [SHOPIFY]: moved(DOMAIN), [DOMAIN]: () => new Response("<html>challenge</html>", { status: 200 }) },
      { [SHOPIFY]: moved(DOMAIN), [DOMAIN]: moved("https://other-shop.example/cart.js") },
      { [SHOPIFY]: moved("http://xn--sovline-dya.fr/cart.js") },
    ];
    for (const routes of reads) {
      serve(routes);
      expect(await readCartJs(store, "hWN1?key=abc")).toBeNull();
      calls = [];
      serve({ [SHOPIFY]: cartJs });
      expect(await readCartJs(store, "hWN1?key=abc")).toMatchObject({ token: "hWN1" });
      expect(urls()).toEqual([SHOPIFY]);
      calls = [];
    }
    expect(incidents.recordIncident).toHaveBeenCalledTimes(reads.length);
  });
});
