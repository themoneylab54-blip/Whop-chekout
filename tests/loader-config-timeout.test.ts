// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, a config that doesn't answer: a held click waits 8 s at most (a plain timer, even
 * where AbortSignal.timeout doesn't exist), then our checkout is tried with the default settings —
 * never the theme's (Shopify's) checkout on our own; the request keeps going and a late config
 * replaces those settings.
 */

const API = "https://app.example.com";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");

vi.useFakeTimers();
afterAll(() => {
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

// Older Safari: no AbortSignal.timeout.
Object.defineProperty(AbortSignal, "timeout", { value: undefined, configurable: true, writable: true });

const configInits: (RequestInit | undefined)[] = [];
let sessionCalls = 0;
let releaseConfig: () => void = () => undefined;
const configReady = new Promise<void>((r) => (releaseConfig = r));

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/config")) {
      configInits.push(init);
      await configReady;
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "#custom-btn", excludedHandles: [] }, sessionEndpoint: `${API}/api/public/sessions` }));
    }
    if (u === "/cart.js") return new Response(JSON.stringify({ token: "t", items: [{ variant_id: 1, quantity: 1, handle: "jacket" }] }));
    if (u.endsWith("/api/public/sessions") && init?.body !== '{"warm":true}') {
      sessionCalls++;
      return new Response(JSON.stringify({ error: "x", reason: "price_higher" }), { status: 409 });
    }
    return new Response("{}");
  }),
);

document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <div class="cart-drawer">
    <a href="/checkout" id="checkout-link"><svg id="icon"><path id="icon-path" d="M0 0h1"></path></svg> Checkout</a>
    <button type="button" name="checkout" id="checkout-btn">Checkout</button>
  </div>
  <button type="button" id="custom-btn">Hello</button>`;
new Function(source)();

// The theme's own handling (after ours): what reached it wasn't intercepted.
const theme: string[] = [];
document.addEventListener("click", (e) => {
  theme.push((e.target as Element).id);
  if ((e.target as Element).closest("a")) e.preventDefault(); // no jsdom navigation
});

const click = (id: string) => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById(id)!.dispatchEvent(ev);
  return ev;
};
const overlayShown = () => !!document.getElementById("whopco-overlay");

describe("loader: config that doesn't answer", () => {
  it("after 8 s the held click tries our checkout with the default settings: no endless overlay, never the theme's checkout", async () => {
    await settle();
    expect(configInits).toHaveLength(1);
    expect(configInits[0]?.signal).toBeUndefined();
    // A click on the link's icon: held.
    expect(click("icon-path").defaultPrevented).toBe(true);
    expect(overlayShown()).toBe(true);
    await vi.advanceTimersByTimeAsync(7900);
    expect(overlayShown()).toBe(true);
    expect(sessionCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    // Our session server was asked (it refuses this cart here: « Réessayer »); the theme never got the click.
    expect(sessionCalls).toBe(1);
    expect(theme).toEqual([]);
    expect(overlayShown()).toBe(false);
    expect(document.getElementById("whopco-error")).toBeTruthy();
    document.getElementById("whopco-error")!.remove();
    // Still no config: the next checkout click is ours too; a button only the store's settings name isn't.
    expect(click("checkout-btn").defaultPrevented).toBe(true);
    await settle();
    expect(sessionCalls).toBe(2);
    document.getElementById("whopco-error")!.remove();
    expect(click("custom-btn").defaultPrevented).toBe(false);
    expect(theme).toEqual(["custom-btn"]);
  });

  it("the request keeps going: a late config replaces the default settings", async () => {
    expect(configInits).toHaveLength(1);
    releaseConfig();
    await settle();
    // The store's own selector now counts.
    expect(click("custom-btn").defaultPrevented).toBe(true);
    await settle();
    expect(sessionCalls).toBe(3);
    expect(document.getElementById("whopco-error")).toBeTruthy();
  });
});
