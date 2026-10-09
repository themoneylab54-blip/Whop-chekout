// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, a store's own checkout domain failing fast (a passing network error, not 25 s
 * of silence): the click goes on through the app's API at once and the checkout opens, but the tab
 * keeps the ping's answer (the next page asks the domain again) — only a silent domain is remembered.
 */

const API = "https://app.example.com";
const DOMAIN = "https://checkout.shop.test";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");

vi.useFakeTimers();
afterAll(() => {
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

const domainPosts: string[] = [];
const appPosts: string[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn((url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/config")) {
      return Promise.resolve(new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${DOMAIN}/api/public/sessions` })));
    }
    if (u.startsWith(`${DOMAIN}/checkout-icon.svg`)) return Promise.resolve(new Response("", { status: 200 }));
    if (u === "/cart.js") return Promise.resolve(new Response(JSON.stringify({ token: "cart-token-1", items: [{ variant_id: 1, quantity: 1, handle: "jacket" }] })));
    if (init?.body === '{"warm":true}') return Promise.resolve(new Response("{}"));
    if (u === `${DOMAIN}/api/public/sessions`) {
      domainPosts.push(String(init?.body));
      return Promise.reject(new TypeError("Failed to fetch"));
    }
    if (u === `${API}/api/public/sessions`) {
      appPosts.push(String(init?.body));
      return Promise.resolve(new Response(JSON.stringify({ url: `${DOMAIN}/c/s_1`, visitorId: "v_12345678" }), { status: 200 }));
    }
    return Promise.resolve(new Response("{}"));
  }),
);

document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <form action="/cart" method="post"><button type="button" name="checkout" id="checkout-btn">Checkout</button></form>`;
new Function(source)();

describe("loader: the store's checkout domain fails fast", () => {
  it("the app's API at once, the checkout opens; the tab still trusts the domain (only 25 s of silence is remembered)", async () => {
    await settle(); // config + ping
    expect(JSON.parse(sessionStorage.getItem("whopco_ping") ?? "null")).toMatchObject({ origin: DOMAIN, ok: true });
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("checkout-btn")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await settle();
    expect(domainPosts).toHaveLength(1);
    expect(appPosts).toHaveLength(1);
    expect(sessionStorage.getItem("whopco_pending")).toBe("1");
    expect(document.getElementById("whopco-error")).toBeNull();
    expect(JSON.parse(sessionStorage.getItem("whopco_ping") ?? "null")).toMatchObject({ origin: DOMAIN, ok: true });
  });
});
