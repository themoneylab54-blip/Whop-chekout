// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, warm-up throttle kept for the tab (sessionStorage `whopco_warm`; a fresh loader and page
 * for each test): a warm-up made on the previous page holds for the minute (neither the cart landing nor
 * hovering warms again), though the cart landing still reads the cart ahead (Shopify's, nothing asked of our
 * servers), and a pointerover within both throttles (that read's 5 s, the warm-up's minute) runs no selector
 * at all; once the minute is over, hovering warms once (the cart read ahead keeps its own 5 s).
 */

const API = "https://app.example.com";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
};

// Our server and the shop as one test's loader sees them.
const fresh = () => ({ warmCalls: 0, cartReads: 0 });
let s = fresh();

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const counts = s; // counted for the test that asked, even late
    if (u.includes("/config")) {
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${API}/api/public/sessions` }));
    }
    if (u === "/cart.js") counts.cartReads++;
    if (u.endsWith("/api/public/sessions") && init?.body === '{"warm":true}') counts.warmCalls++;
    return new Response("{}");
  }),
);
// The browser's PerformanceObserver (jsdom has none): the cart can be read ahead.
vi.stubGlobal(
  "PerformanceObserver",
  class {
    observe() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  },
);

// One loader at a time, on a fresh page: the listeners it adds are removed after it.
const added: [EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];
const teardown = async () => {
  await settle();
  for (const [target, type, listener, options] of added.splice(0)) target.removeEventListener(type, listener, options);
};
afterEach(teardown);
// Landing on the cart page 5 s after the tab's previous page warmed.
const boot = async () => {
  await teardown();
  s = fresh();
  history.replaceState(null, "", "/cart");
  sessionStorage.clear();
  sessionStorage.setItem("whopco_warm", String(Date.now() - 5000));
  document.body.innerHTML = `
    <script src="${API}/loader.js?store=st_1"></script>
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
  await settle(); // config, and the landing
};

const over = () => document.getElementById("checkout-btn")!.dispatchEvent(new Event("pointerover", { bubbles: true }));

describe("loader: warm-up throttle across the tab's pages", () => {
  it("a warm-up from the previous page holds: no warm-up on landing or hover, no selector work; the landing reads the cart ahead", async () => {
    await boot();
    expect(s.warmCalls).toBe(0);
    expect(s.cartReads).toBe(1);
    const closest = vi.spyOn(Element.prototype, "closest");
    over();
    expect(closest).not.toHaveBeenCalled();
    closest.mockRestore();
    await settle();
    expect(s.warmCalls).toBe(0);
    expect(s.cartReads).toBe(1);
  });

  it("once the minute is over, hovering warms once and keeps the new time for the tab", async () => {
    await boot();
    sessionStorage.setItem("whopco_warm", String(Date.now() - 60001));
    over();
    over();
    await settle();
    expect(s.warmCalls).toBe(1);
    // The landing's read is less than 5 s old: not read again.
    expect(s.cartReads).toBe(1);
    expect(Date.now() - Number(sessionStorage.getItem("whopco_warm"))).toBeLessThan(1000);
  });
});
