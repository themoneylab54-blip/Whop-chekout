// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, warm-up throttle kept for the tab (sessionStorage `whopco_warm`): a warm-up made
 * on the previous page holds for the minute (neither the cart landing nor hovering warms again, and a
 * throttled pointerover runs no selector at all); once the minute is over, hovering warms once.
 */

const API = "https://app.example.com";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
};

let warmCalls = 0;

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/config")) {
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${API}/api/public/sessions` }));
    }
    if (init?.body === '{"warm":true}') warmCalls++;
    return new Response("{}");
  }),
);

history.replaceState(null, "", "/cart");
sessionStorage.setItem("whopco_warm", String(Date.now() - 5000)); // the tab's previous page
document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <form action="/cart" method="post"><button type="button" name="checkout" id="checkout-btn">Checkout</button></form>`;
new Function(source)();

const over = () => document.getElementById("checkout-btn")!.dispatchEvent(new Event("pointerover", { bubbles: true }));

describe("loader: warm-up throttle across the tab's pages", () => {
  it("a warm-up from the previous page holds: no warm-up on landing or hover, no selector work", async () => {
    await settle();
    expect(warmCalls).toBe(0);
    const closest = vi.spyOn(Element.prototype, "closest");
    over();
    expect(closest).not.toHaveBeenCalled();
    closest.mockRestore();
    await settle();
    expect(warmCalls).toBe(0);
  });

  it("once the minute is over, hovering warms once and keeps the new time for the tab", async () => {
    sessionStorage.setItem("whopco_warm", String(Date.now() - 60001));
    over();
    over();
    await settle();
    expect(warmCalls).toBe(1);
    expect(Date.now() - Number(sessionStorage.getItem("whopco_warm"))).toBeLessThan(1000);
  });
});
