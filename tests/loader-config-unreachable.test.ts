// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, our server unreachable: the config fails twice (a network error, then a broken
 * answer 1.5 s later: an HTML page). Our checkout is still tried with the default settings — never the
 * shop's own checkout on our own: with the session server down too, the buyer gets « Réessayer ».
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
      if (configCalls === 1) throw new TypeError("Failed to fetch");
      return new Response("<!doctype html><html><body>Deploying…</body></html>", { status: 200 });
    }
    if (u === "/cart.js") return new Response(JSON.stringify({ token: "t", items: [{ variant_id: 1, quantity: 1, handle: "jacket" }] }));
    if (u.endsWith("/api/public/sessions") && init?.body !== '{"warm":true}') {
      sessionCalls++;
      throw new TypeError("Failed to fetch");
    }
    return new Response("{}");
  }),
);

document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <form action="/cart" method="post"><button type="button" name="checkout" id="checkout-btn">Checkout</button></form>`;
new Function(source)();

const theme: string[] = [];
document.addEventListener("click", (e) => theme.push((e.target as Element).id));
const click = () => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById("checkout-btn")!.dispatchEvent(ev);
  return ev;
};

describe("loader: our server unreachable", () => {
  it("after a second failure the held click still tries our checkout; the server down too: « Réessayer », never the theme's checkout", async () => {
    expect(click().defaultPrevented).toBe(true);
    await settle();
    expect(configCalls).toBe(1);
    expect(theme).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500);
    await settle();
    expect(configCalls).toBe(2);
    // The first attempt, the automatic retry 800 ms later (same click), then the message.
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(sessionCalls).toBe(2);
    expect(document.getElementById("whopco-error")).toBeTruthy();
    expect(theme).toEqual([]);
    // The next click is ours too.
    document.getElementById("whopco-error")!.remove();
    expect(click().defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(sessionCalls).toBe(4);
    expect(theme).toEqual([]);
    // No later config request.
    await vi.advanceTimersByTimeAsync(10000);
    await settle();
    expect(configCalls).toBe(2);
  });
});
