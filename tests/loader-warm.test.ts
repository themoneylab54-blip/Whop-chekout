// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, warm-up (a fresh loader and page for each test): landing on a localized cart page
 * (/fr/cart) warms the server the click's POST will reach (our own API when the checkout domain is
 * unreachable from this browser), without keepalive nor CORS preflight (text/plain), and the rest of the
 * click's path on it (the checkout page, its /prepare); a « buy now » button doesn't warm when buy now isn't
 * intercepted; at most once a minute, failures ignored. Without a PerformanceObserver (cart changes can't be
 * seen) the cart isn't read ahead.
 */

const API = "https://app.example.com";
const CHECKOUT_ORIGIN = "https://checkout.shop.test";
const TEXT = "text/plain;charset=UTF-8";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");

vi.useFakeTimers();
afterAll(() => {
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

// Our server as one test's loader sees it.
const fresh = () => ({
  warms: [] as { url: string; init?: RequestInit }[], // the session API's
  wakes: [] as { url: string; init?: RequestInit }[], // the checkout page's and /prepare's
  warmFails: false,
  cartReads: 0,
});
let s = fresh();

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const server = s; // answered from the state of the test that asked, even late
    if (u.includes("/config")) {
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: false, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${CHECKOUT_ORIGIN}/api/public/sessions` }));
    }
    if (u === "/cart.js") server.cartReads++;
    if (u.endsWith("/c/warm") || u.endsWith("/api/public/sessions/warm/prepare")) {
      server.wakes.push({ url: u, init });
      if (server.warmFails) throw new TypeError("Failed to fetch");
      return new Response(null, { status: 404 });
    }
    if (u.endsWith("/api/public/sessions") && init?.body === '{"warm":true}') {
      server.warms.push({ url: u, init });
      // Cut short (the buyer left the page): no answer.
      if (server.warmFails) throw new TypeError("Failed to fetch");
      return new Response('{"warm":true}');
    }
    return new Response("{}");
  }),
);
// An older browser: no PerformanceObserver.
vi.stubGlobal("PerformanceObserver", undefined);

// One loader at a time, on a fresh page: the listeners it adds are removed after it, with its timers.
const added: [EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];
const teardown = async () => {
  await settle();
  for (const [target, type, listener, options] of added.splice(0)) target.removeEventListener(type, listener, options);
  vi.clearAllTimers();
};
afterEach(teardown);
const boot = async () => {
  await teardown();
  s = fresh();
  history.replaceState(null, "", "/fr/cart");
  sessionStorage.clear();
  // This tab's earlier ping: the checkout domain doesn't answer here.
  sessionStorage.setItem("whopco_ping", JSON.stringify({ origin: CHECKOUT_ORIGIN, ok: false, at: Date.now() }));
  document.head.querySelectorAll("link").forEach((l) => l.remove());
  document.body.innerHTML = `
    <script src="${API}/loader.js?store=st_1"></script>
    <form action="/cart/add"><input type="hidden" name="id" value="111">
      <div class="shopify-payment-button"><button type="button" class="shopify-payment-button__button" id="buy-now">Buy it now</button></div>
    </form>
    <form action="/cart" method="post"><button type="button" name="checkout" id="checkout-btn">Checkout</button></form>`;
  delete (window as { __whopco?: boolean }).__whopco;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (listener) added.push([this, type, listener, options]);
    add.call(this, type, listener, options);
  };
  try {
    new Function(source)();
  } finally {
    EventTarget.prototype.addEventListener = add;
  }
  await settle(); // config, and the landing's warm-up
};

const over = (id: string) => document.getElementById(id)!.dispatchEvent(new Event("pointerover", { bubbles: true }));

describe("loader: warm-up", () => {
  it("landing on /fr/cart warms our own API (checkout domain unreachable here), without keepalive nor preflight, and the rest of the path there", async () => {
    await boot();
    expect(s.warms).toHaveLength(1);
    expect(s.warms[0].url).toBe(`${API}/api/public/sessions`);
    expect(s.warms[0].init?.keepalive).toBeUndefined();
    // CORS-simple: no preflight before it (nor before the click's POST).
    expect(s.warms[0].init?.headers).toEqual({ "Content-Type": TEXT });
    // The checkout page (HEAD: no body) and its /prepare, on that same server (opaque requests).
    expect(s.wakes.map((w) => [w.url, w.init?.method, w.init?.mode])).toEqual([
      [`${API}/c/warm`, "HEAD", "no-cors"],
      [`${API}/api/public/sessions/warm/prepare`, "POST", "no-cors"],
    ]);
    expect(s.wakes[0].init).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(s.wakes[1].init).toMatchObject({ credentials: "omit", headers: { "Content-Type": TEXT }, body: '{"warm":true}' });
    expect(sessionStorage.getItem("whopco_warm")).toBe(String(Date.now()));
    // Anonymous for the requests, plain (cookies) for the checkout page that opens there.
    expect(document.querySelector(`link[rel='preconnect'][href='${API}'][crossorigin]`)).toBeTruthy();
    expect(document.querySelector(`link[rel='preconnect'][href='${API}']:not([crossorigin])`)).toBeTruthy();
    expect(document.querySelector(`link[rel='preconnect'][href='${CHECKOUT_ORIGIN}']`)).toBeNull();
    // No PerformanceObserver: nothing read ahead.
    expect(s.cartReads).toBe(0);
  });

  it("at most once a minute; « buy now » doesn't warm when it isn't intercepted, a checkout button does", async () => {
    await boot();
    // Within the minute, no cart read ahead to make here (no PerformanceObserver): no selector work at all.
    const closest = vi.spyOn(Element.prototype, "closest");
    over("checkout-btn");
    expect(closest).not.toHaveBeenCalled();
    closest.mockRestore();
    await settle();
    expect(s.warms).toHaveLength(1);
    expect(s.wakes).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(61000);
    over("buy-now");
    await settle();
    expect(s.warms).toHaveLength(1);
    over("checkout-btn");
    over("checkout-btn");
    await settle();
    expect(s.warms).toHaveLength(2);
    expect(s.warms[1].url).toBe(`${API}/api/public/sessions`);
    expect(s.wakes.slice(2).map((w) => w.url)).toEqual([`${API}/c/warm`, `${API}/api/public/sessions/warm/prepare`]);
  });

  it("a warm-up without an answer isn't kept for the tab's next pages (only this page skips a second one); failures stay silent", async () => {
    await boot();
    const kept = sessionStorage.getItem("whopco_warm");
    expect(kept).toBe(String(Date.now()));
    await vi.advanceTimersByTimeAsync(61000);
    s.warmFails = true;
    over("checkout-btn");
    await settle();
    expect(s.warms).toHaveLength(2);
    expect(s.wakes).toHaveLength(4);
    expect(sessionStorage.getItem("whopco_warm")).toBe(kept);
    over("checkout-btn");
    await settle();
    expect(s.warms).toHaveLength(2);
    expect(s.wakes).toHaveLength(4);
  });
});
