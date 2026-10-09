// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, a config request that fails once (here an HTTP error, JSON body and all): asked
 * again 1.5 s later. The held click keeps waiting meanwhile (never Shopify's checkout after a single
 * failure) and goes to our checkout once the config is there.
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

let configCalls = 0;
let sessionCalls = 0;

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/config")) {
      configCalls++;
      if (configCalls === 1) return new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503 });
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${API}/api/public/sessions` }));
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
  <a href="/fr/checkout" id="checkout-link">Go</a>`;
new Function(source)();

const theme: string[] = [];
document.addEventListener("click", (e) => {
  theme.push((e.target as Element).id);
  e.preventDefault(); // no jsdom navigation
});

describe("loader: config retried once", () => {
  it("a failed config request is made again 1.5 s later; the held click waits and goes to our checkout", async () => {
    // A link to the localized checkout, clicked before the config: held.
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("checkout-link")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await settle();
    expect(configCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1400);
    expect(configCalls).toBe(1);
    // Still held after the first failure: not handed to the theme (Shopify's checkout).
    expect(document.getElementById("whopco-overlay")).toBeTruthy();
    expect(theme).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(configCalls).toBe(2);
    expect(sessionCalls).toBe(1);
    expect(theme).toHaveLength(0);
    expect(document.getElementById("whopco-error")).toBeTruthy();
  });
});
