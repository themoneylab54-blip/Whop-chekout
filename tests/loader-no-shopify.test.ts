// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/*
 * Storefront loader: never Shopify's checkout on a failure. A click before the config arrives is
 * held (not let through), a refused or failing checkout keeps the buyer on the shop with « Try
 * again » (one silent retry on a server error), a theme's own checkout button in the cart is
 * caught too, and only the carts Shopify keeps (native: true) go to Shopify's checkout.
 */

const API = "https://app.example.com";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");
const flush = () => new Promise((r) => setTimeout(r, 0));
const settle = async () => {
  for (let i = 0; i < 10; i++) await flush();
};

type Reply = { status: number; body: unknown };
const sessions: Reply[] = [];
let sessionCalls = 0;
let warmCalls = 0;
let releaseConfig: () => void = () => undefined;
const configReady = new Promise<void>((r) => (releaseConfig = r));

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/config")) {
      await configReady;
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${API}/api/public/sessions` }));
    }
    if (u === "/cart.js") return new Response(JSON.stringify({ token: "t", items: [{ variant_id: 1, quantity: 1, handle: "jacket" }] }));
    if (u.endsWith("/api/public/sessions") && init?.body === '{"warm":true}') {
      warmCalls++;
      return new Response(JSON.stringify({ warm: true }));
    }
    if (u.endsWith("/api/public/sessions")) {
      sessionCalls++;
      const next = sessions.shift() ?? { status: 500, body: { error: "x" } };
      return new Response(JSON.stringify(next.body), { status: next.status });
    }
    return new Response("{}");
  }),
);

document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <form action="/cart" method="post"><button type="submit" name="checkout" id="checkout-btn">Checkout</button></form>
  <div class="cart-drawer__footer"><button type="button" id="theme-btn">Paiement</button></div>
  <form action="/cart/add"><button type="button" id="add-btn">Acheter</button></form>`;
new Function(source)();

const click = (id: string) => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById(id)!.dispatchEvent(ev);
  return ev;
};
const errorShown = () => !!document.getElementById("whopco-error");
const closeError = () => document.getElementById("whopco-error")?.remove();

describe("loader: never Shopify's checkout on a failure", () => {
  it("a click before the config arrives is held, then goes to our checkout; a refusal shows « try again »", async () => {
    sessions.push({ status: 409, body: { error: "Panier refusé : price_higher", reason: "price_higher" } });
    const ev = click("checkout-btn");
    expect(ev.defaultPrevented).toBe(true);
    expect(document.getElementById("whopco-overlay")).toBeTruthy();
    releaseConfig();
    await settle();
    expect(sessionCalls).toBe(1);
    expect(errorShown()).toBe(true);
  });

  it("« Try again » asks again; a server error is retried once on its own before the message", async () => {
    sessions.push({ status: 502, body: { error: "Impossible de charger le panier", reason: "price_failed" } }, { status: 502, body: { error: "x" } });
    (document.querySelector("#whopco-error button") as HTMLButtonElement).click();
    await settle();
    expect(sessionCalls).toBe(3);
    expect(errorShown()).toBe(true);
    closeError();
  });

  it("the theme's own checkout button in the cart drawer is ours too; a product's « Acheter » isn't", async () => {
    sessions.push({ status: 409, body: { error: "x", reason: "price_higher" } });
    expect(click("theme-btn").defaultPrevented).toBe(true);
    await settle();
    expect(sessionCalls).toBe(4);
    closeError();
    expect(click("add-btn").defaultPrevented).toBe(false);
    await settle();
    expect(sessionCalls).toBe(4);
  });

  it("only a cart Shopify keeps (native) leaves for Shopify's checkout: no message", async () => {
    sessions.push({ status: 409, body: { error: "Abonnement : checkout Shopify", reason: "selling_plan", native: true, fallback: true } });
    click("checkout-btn");
    await settle();
    expect(sessionCalls).toBe(5);
    expect(errorShown()).toBe(false);
  });

  it("heading for the checkout (pointer over its button) wakes the server once, before the click", async () => {
    const over = () => document.getElementById("checkout-btn")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    over();
    over();
    await settle();
    expect(warmCalls).toBe(1);
    expect(sessionCalls).toBe(5);
    expect(document.querySelector("link[rel='preconnect'][href='https://app.example.com']")).toBeTruthy();
  });
});
