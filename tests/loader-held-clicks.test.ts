// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, clicks held before the config arrives: once it does, each is decided like a
 * normal click. A « buy now » click with buy-now interception off goes back to the theme (that click
 * only, its form submission included: the page isn't switched to Shopify's checkout), and the next
 * checkout clicks are still ours.
 */

const API = "https://app.example.com";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
};

let sessionCalls = 0;
let cartAdds = 0;
let releaseConfig: () => void = () => undefined;
const configReady = new Promise<void>((r) => (releaseConfig = r));

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/config")) {
      await configReady;
      return new Response(
        JSON.stringify({
          enabled: true,
          interception: { cartCheckout: true, cartDrawer: true, buyNow: false, addToCartDirect: true, customSelectors: "", excludedHandles: [] },
          sessionEndpoint: `${API}/api/public/sessions`,
        }),
      );
    }
    if (u === "/cart/add.js") cartAdds++;
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
  <form action="/cart/add" id="product-form"><input type="hidden" name="id" value="111">
    <div class="shopify-payment-button"><button type="submit" class="shopify-payment-button__button" id="buy-now">Buy it now</button></div>
  </form>
  <form action="/cart" method="post"><button type="button" name="checkout" id="checkout-btn">Checkout</button></form>`;
new Function(source)();

// The theme's own handling (after ours): what reached it wasn't intercepted.
const theme: { id: string; prevented: boolean }[] = [];
document.addEventListener("click", (e) => theme.push({ id: (e.target as Element).id, prevented: e.defaultPrevented }));
const themeSubmits: string[] = [];
document.addEventListener("submit", (e) => {
  themeSubmits.push((e.target as Element).id);
  e.preventDefault(); // the theme's own (AJAX) handling, no jsdom navigation
});

const click = (id: string) => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById(id)!.dispatchEvent(ev);
  return ev;
};

describe("loader: clicks held until the config arrives", () => {
  it("a held « buy now » click with buy now off goes back to the theme, once (its form submission too)", async () => {
    expect(click("buy-now").defaultPrevented).toBe(true);
    expect(document.getElementById("whopco-overlay")).toBeTruthy();
    expect(theme).toHaveLength(0);
    releaseConfig();
    await settle();
    expect(document.getElementById("whopco-overlay")).toBeNull();
    expect(theme).toEqual([{ id: "buy-now", prevented: false }]);
    // Not taken by "add to cart → checkout" either: that submission is the theme's.
    expect(themeSubmits).toEqual(["product-form"]);
    expect(cartAdds).toBe(0);
    expect(sessionCalls).toBe(0);
  });

  it("the next checkout clicks are still ours (the page wasn't switched to Shopify's checkout)", async () => {
    expect(click("checkout-btn").defaultPrevented).toBe(true);
    await settle();
    expect(sessionCalls).toBe(1);
    expect(theme).toHaveLength(1);
    expect(document.getElementById("whopco-error")).toBeTruthy();
  });
});
