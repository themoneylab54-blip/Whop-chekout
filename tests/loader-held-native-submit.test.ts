// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, a submission held before the config arrives that the store's settings don't take
 * (cart interception switched off): sent again to the theme, once (its own handlers see it), and the
 * page isn't switched to Shopify's checkout: a « buy now » is still ours.
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
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: false, cartDrawer: false, buyNow: true, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${API}/api/public/sessions` }));
    }
    if (u.endsWith("/api/public/sessions") && init?.body !== '{"warm":true}') {
      sessionCalls++;
      return new Response(JSON.stringify({ error: "x", reason: "price_higher" }), { status: 409 });
    }
    return new Response("{}");
  }),
);

document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <form action="/checkout" id="checkout-form"><button id="bare-btn">Pay</button></form>
  <form action="/cart/add" id="product-form"><input type="hidden" name="id" value="111">
    <div class="shopify-payment-button"><button type="button" class="shopify-payment-button__button" id="buy-now">Buy it now</button></div>
  </form>`;
new Function(source)();

const themeSubmits: { id: string; submitter?: string; prevented: boolean }[] = [];
document.addEventListener("submit", (e) => {
  themeSubmits.push({ id: (e.target as Element).id, submitter: (e as SubmitEvent).submitter?.id, prevented: e.defaultPrevented });
  e.preventDefault(); // no jsdom navigation
});

describe("loader: a held submission the settings don't take", () => {
  it("goes back to the theme once, with its button; the next « buy now » is still ours", async () => {
    (document.getElementById("bare-btn") as HTMLButtonElement).click();
    expect(themeSubmits).toEqual([]);
    expect(document.getElementById("whopco-overlay")).toBeTruthy();
    releaseConfig();
    await settle();
    expect(document.getElementById("whopco-overlay")).toBeNull();
    expect(themeSubmits).toEqual([{ id: "checkout-form", submitter: "bare-btn", prevented: false }]);
    expect(sessionCalls).toBe(0);

    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    document.getElementById("buy-now")!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    await settle();
    expect(sessionCalls).toBe(1);
  });
});
