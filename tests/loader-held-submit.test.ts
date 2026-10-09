// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, before the config arrives: everything that could open Shopify's checkout waits for
 * it. A theme's « Paiement » in the cart drawer, a button named by the store's own settings (kept from
 * its last page), a cart permalink, and checkout submissions (a button without a type in a checkout
 * form, the theme's requestSubmit on the cart form). The last one held goes to our checkout once the
 * config is there.
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

let sessionCalls = 0;
let releaseConfig: () => void = () => undefined;
const configReady = new Promise<void>((r) => (releaseConfig = r));

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/config")) {
      await configReady;
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "#custom-pay, .express-pay", excludedHandles: [] }, sessionEndpoint: `${API}/api/public/sessions` }));
    }
    if (u === "/cart.js") return new Response(JSON.stringify({ token: "t", items: [{ variant_id: 1, quantity: 1, handle: "jacket" }] }));
    if (u.endsWith("/api/public/sessions") && init?.body !== '{"warm":true}') {
      sessionCalls++;
      return new Response(JSON.stringify({ error: "x", reason: "price_higher" }), { status: 409 });
    }
    return new Response("{}");
  }),
);

// The store's own selectors, as its last page kept them.
localStorage.setItem("whopco_custom", JSON.stringify("#custom-pay"));
document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <cart-drawer><div class="footer"><button type="button" id="drawer-pay">Paiement</button></div></cart-drawer>
  <button type="button" id="custom-pay">Hello</button>
  <a href="/cart/111:1" id="permalink">Buy</a>
  <form action="/checkout" id="checkout-form"><button id="bare-btn">Pay</button></form>
  <form action="/cart" method="post" id="cart-form"><button type="submit" name="checkout" id="cart-checkout">Checkout</button></form>`;
new Function(source)();

// The theme's own handling (after ours): what reached it wasn't held.
const theme: string[] = [];
document.addEventListener("click", (e) => {
  theme.push((e.target as Element).id);
  if ((e.target as Element).closest("a")) e.preventDefault(); // no jsdom navigation
});
const themeSubmits: string[] = [];
document.addEventListener("submit", (e) => {
  themeSubmits.push((e.target as Element).id);
  e.preventDefault();
});

const click = (id: string) => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById(id)!.dispatchEvent(ev);
  return ev;
};
const overlayShown = () => !!document.getElementById("whopco-overlay");

describe("loader: held until the config arrives", () => {
  it("a theme's « Paiement » in the cart drawer, a button of the store's own selectors (last page), a cart permalink", async () => {
    for (const id of ["drawer-pay", "custom-pay", "permalink"]) expect(click(id).defaultPrevented, id).toBe(true);
    expect(overlayShown()).toBe(true);
    expect(theme).toEqual([]);
  });

  it("checkout submissions too: a button without a type in a checkout form, the theme's requestSubmit on the cart form", async () => {
    // Not a button we know: its click goes through, but the checkout form's submission is held.
    expect(click("bare-btn").defaultPrevented).toBe(false);
    (document.getElementById("cart-form") as HTMLFormElement).requestSubmit(document.getElementById("cart-checkout") as HTMLButtonElement);
    expect(themeSubmits).toEqual([]);
    expect(sessionCalls).toBe(0);
    // The config arrives: the last one held (the cart form's checkout) goes to our checkout.
    releaseConfig();
    await settle();
    expect(sessionCalls).toBe(1);
    expect(themeSubmits).toEqual([]);
    expect(document.getElementById("whopco-error")).toBeTruthy();
    // The store's selectors are kept for its next pages.
    expect(JSON.parse(localStorage.getItem("whopco_custom")!)).toBe("#custom-pay, .express-pay");
  });
});
