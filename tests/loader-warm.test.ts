// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, warm-up: landing on a localized cart page (/fr/cart) warms the server the click's
 * POST will reach (our own API when the checkout domain is unreachable from this browser), without
 * keepalive; a « buy now » button doesn't warm when buy now isn't intercepted; at most once a minute.
 */

const API = "https://app.example.com";
const CHECKOUT_ORIGIN = "https://checkout.shop.test";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");

vi.useFakeTimers();
afterAll(() => {
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

const warms: { url: string; init?: RequestInit }[] = [];
let warmFails = false;

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/config")) {
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: false, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${CHECKOUT_ORIGIN}/api/public/sessions` }));
    }
    if (init?.body === '{"warm":true}') {
      warms.push({ url: u, init });
      // Cut short (the buyer left the page): no answer.
      if (warmFails) throw new TypeError("Failed to fetch");
      return new Response('{"warm":true}');
    }
    return new Response("{}");
  }),
);

history.replaceState(null, "", "/fr/cart");
// This tab's earlier ping: the checkout domain doesn't answer here.
sessionStorage.setItem("whopco_ping", JSON.stringify({ origin: CHECKOUT_ORIGIN, ok: false, at: Date.now() }));
document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <form action="/cart/add"><input type="hidden" name="id" value="111">
    <div class="shopify-payment-button"><button type="button" class="shopify-payment-button__button" id="buy-now">Buy it now</button></div>
  </form>
  <form action="/cart" method="post"><button type="button" name="checkout" id="checkout-btn">Checkout</button></form>`;
new Function(source)();

const over = (id: string) => document.getElementById(id)!.dispatchEvent(new Event("pointerover", { bubbles: true }));

describe("loader: warm-up", () => {
  it("landing on /fr/cart warms our own API (checkout domain unreachable here), without keepalive", async () => {
    await settle();
    expect(warms).toHaveLength(1);
    expect(warms[0].url).toBe(`${API}/api/public/sessions`);
    expect(warms[0].init?.keepalive).toBeUndefined();
    expect(sessionStorage.getItem("whopco_warm")).toBe(String(Date.now()));
    expect(document.querySelector(`link[rel='preconnect'][href='${API}']`)).toBeTruthy();
    expect(document.querySelector(`link[rel='preconnect'][href='${CHECKOUT_ORIGIN}']`)).toBeNull();
  });

  it("at most once a minute; « buy now » doesn't warm when it isn't intercepted, a checkout button does", async () => {
    over("checkout-btn");
    await settle();
    expect(warms).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(61000);
    over("buy-now");
    await settle();
    expect(warms).toHaveLength(1);
    over("checkout-btn");
    over("checkout-btn");
    await settle();
    expect(warms).toHaveLength(2);
    expect(warms[1].url).toBe(`${API}/api/public/sessions`);
  });

  it("a warm-up without an answer isn't kept for the tab's next pages (only this page skips a second one)", async () => {
    const kept = sessionStorage.getItem("whopco_warm");
    await vi.advanceTimersByTimeAsync(61000);
    warmFails = true;
    over("checkout-btn");
    await settle();
    expect(warms).toHaveLength(3);
    expect(sessionStorage.getItem("whopco_warm")).toBe(kept);
    over("checkout-btn");
    await settle();
    expect(warms).toHaveLength(3);
  });
});
