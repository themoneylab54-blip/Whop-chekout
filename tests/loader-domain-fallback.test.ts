// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, a store's own checkout domain that stops answering after the ping said it was
 * fine: the click's request gives up after 25 s and goes to the app's API, and the automatic retry goes
 * straight to the app too (never a second 25 s wait on the silent domain); the checkout then opens on
 * the app's host (?via=app).
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
let appReplies = 0;

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
      // Never answers (aborted by the loader's own timer).
      return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (u === `${API}/api/public/sessions`) {
      appPosts.push(String(init?.body));
      appReplies++;
      return Promise.resolve(
        appReplies === 1
          ? new Response("<html>502</html>", { status: 502 })
          : new Response(JSON.stringify({ url: `${DOMAIN}/c/s_1`, visitorId: "v_12345678" }), { status: 200 }),
      );
    }
    return Promise.resolve(new Response("{}"));
  }),
);

document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <form action="/cart" method="post"><button type="button" name="checkout" id="checkout-btn">Checkout</button></form>`;
new Function(source)();

describe("loader: the store's checkout domain goes silent", () => {
  it("25 s on the domain, then the app; the automatic retry goes straight to the app; the checkout opens", async () => {
    await settle(); // config + ping
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("checkout-btn")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await settle();
    expect(domainPosts).toHaveLength(1);
    expect(appPosts).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(25_000);
    await settle();
    // The app's API answered 502: one automatic retry 800 ms later, on the app only.
    expect(appPosts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(domainPosts).toHaveLength(1);
    expect(appPosts).toHaveLength(2);
    // Same click, same key everywhere.
    const keys = [...domainPosts, ...appPosts].map((b) => JSON.parse(b).requestKey);
    expect(new Set(keys).size).toBe(1);
    // Opened (no message).
    expect(sessionStorage.getItem("whopco_pending")).toBe("1");
    expect(document.getElementById("whopco-error")).toBeNull();
  });
});
