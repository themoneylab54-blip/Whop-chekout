// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, session answers: a proxy's HTML error page is a server error (retried once on its
 * own, after a pause, with the same click key), a refusal the server marks retryable is retried too,
 * « Réessayer » is a new click (new key); an empty cart is read again before going to the shop's cart
 * page (never Shopify's checkout); a request without an answer is given up after 25 s; only an http(s)
 * checkout address is opened; back from our checkout (back/forward cache) the page works again.
 */

const API = "https://app.example.com";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");

vi.useFakeTimers();
afterAll(() => {
  vi.useRealTimers();
});
// Promise chains run between fake timer ticks.
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

type Reply = { status: number; body?: unknown; raw?: string; hang?: boolean };
const replies: Reply[] = [];
const posts: { requestKey?: string }[] = [];
const signals: (AbortSignal | null | undefined)[] = [];
const FULL_CART = { token: "cart-token-1", items: [{ variant_id: 1, quantity: 1, handle: "jacket" }] };
const EMPTY_CART = { token: "cart-token-1", items: [] };
let carts: unknown[] = []; // next /cart.js answers (then FULL_CART)
let cartReads = 0;
let cartStatus = 200;

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/config")) {
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${API}/api/public/sessions` }));
    }
    if (u === "/cart.js") {
      cartReads++;
      if (cartStatus !== 200) return new Response(JSON.stringify({ status: cartStatus, message: "Unavailable" }), { status: cartStatus });
      return new Response(JSON.stringify(carts.length ? carts.shift() : FULL_CART));
    }
    if (u.endsWith("/api/public/sessions") && init?.body === '{"warm":true}') return new Response('{"warm":true}');
    if (u.endsWith("/api/public/sessions")) {
      posts.push(JSON.parse(String(init?.body)));
      signals.push(init?.signal);
      const next = replies.shift() ?? { status: 500, body: { error: "x" } };
      if (next.hang) {
        // No answer: only an abort ends it.
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      return new Response(next.raw ?? JSON.stringify(next.body), { status: next.status });
    }
    return new Response("{}");
  }),
);

document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <form action="/cart" method="post"><button type="button" name="checkout" id="checkout-btn">Checkout</button></form>`;
new Function(source)();

const click = (id: string) => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById(id)!.dispatchEvent(ev);
  return ev;
};
const errorShown = () => !!document.getElementById("whopco-error");
const overlayShown = () => !!document.getElementById("whopco-overlay");
const closeError = () => document.getElementById("whopco-error")?.remove();
const tryAgain = () => (document.querySelector("#whopco-error button") as HTMLButtonElement).click();
const htmlError = (status: number): Reply => ({ status, raw: `<!doctype html><html><body><h1>${status} Bad Gateway</h1></body></html>` });

describe("loader: session answers", () => {
  it("a proxy's HTML 502 is retried once on its own, after a pause and with the same key, then « Réessayer »", async () => {
    await settle(); // config loaded
    replies.push(htmlError(502), htmlError(502));
    expect(click("checkout-btn").defaultPrevented).toBe(true);
    await settle();
    expect(posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(700);
    expect(posts).toHaveLength(1); // still pausing, overlay up, no message yet
    expect(overlayShown()).toBe(true);
    expect(errorShown()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(posts).toHaveLength(2);
    expect(posts[1].requestKey).toBe(posts[0].requestKey);
    expect(errorShown()).toBe(true);
    expect(overlayShown()).toBe(false);
  });

  it("« Réessayer » is a new click: a new key (a plain refusal isn't retried on its own)", async () => {
    replies.push({ status: 409, body: { error: "Panier refusé", reason: "price_higher" } });
    tryAgain();
    await settle();
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(posts).toHaveLength(3);
    expect(posts[2].requestKey).toMatch(/^[0-9a-f]{32}$/);
    expect(posts[2].requestKey).not.toBe(posts[0].requestKey);
    expect(errorShown()).toBe(true);
    closeError();
  });

  it("a refusal the server marks retryable (409 cart_changed) is retried once, same key", async () => {
    replies.push({ status: 409, body: { error: "Panier modifié", reason: "cart_changed", retryable: true } }, { status: 409, body: { error: "Panier modifié", reason: "cart_changed", retryable: true } });
    click("checkout-btn");
    await settle();
    expect(posts).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(posts).toHaveLength(5);
    expect(posts[4].requestKey).toBe(posts[3].requestKey);
    // Retried once only, then the message.
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(posts).toHaveLength(5);
    expect(errorShown()).toBe(true);
    closeError();
  });

  it("a rate limit (429) isn't retried on its own (the same minute would refuse again): the message at once", async () => {
    replies.push({ status: 429, body: { error: "Trop de requêtes", reason: "rate_limited" } });
    click("checkout-btn");
    await settle();
    expect(posts).toHaveLength(6);
    expect(errorShown()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    await settle();
    expect(posts).toHaveLength(6);
    closeError();
  });

  it("Shopify's cart unreadable (/cart.js 503) is retried, never taken for an empty cart (Shopify's checkout)", async () => {
    cartStatus = 503;
    const before = cartReads;
    click("checkout-btn");
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(cartReads - before).toBe(2);
    expect(posts).toHaveLength(6);
    expect(errorShown()).toBe(true);
    closeError();
    cartStatus = 200;
  });

  it("an empty cart is read again 600 ms later (an « add to cart » on its way), then our checkout", async () => {
    carts = [EMPTY_CART];
    const before = cartReads;
    replies.push({ status: 409, body: { error: "x", reason: "price_higher" } });
    click("checkout-btn");
    await settle();
    expect(cartReads - before).toBe(1);
    expect(posts).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(cartReads - before).toBe(2);
    expect(posts).toHaveLength(7);
    closeError();
  });

  it("still empty: the shop's cart page, no message, never Shopify's checkout (the next click is still ours)", async () => {
    carts = [EMPTY_CART, EMPTY_CART];
    const before = cartReads;
    click("checkout-btn");
    await settle();
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(cartReads - before).toBe(2);
    expect(posts).toHaveLength(7);
    expect(errorShown()).toBe(false);
    expect(overlayShown()).toBe(false);
    // Not switched to Shopify's checkout for the page: the next click opens ours.
    replies.push({ status: 409, body: { error: "x", reason: "price_higher" } });
    expect(click("checkout-btn").defaultPrevented).toBe(true);
    await settle();
    expect(posts).toHaveLength(8);
    closeError();
  });

  it("a session request without an answer is given up after 25 s (aborted), retried once with the same key, then « Réessayer »", async () => {
    replies.push({ status: 0, hang: true }, { status: 0, hang: true });
    click("checkout-btn");
    await settle();
    expect(posts).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(24900);
    expect(overlayShown()).toBe(true);
    expect(errorShown()).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(signals[8]?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(posts).toHaveLength(10);
    expect(posts[9].requestKey).toBe(posts[8].requestKey);
    expect(errorShown()).toBe(false);
    await vi.advanceTimersByTimeAsync(25000);
    await settle();
    expect(errorShown()).toBe(true);
    expect(overlayShown()).toBe(false);
    closeError();
  });

  it("only an http(s) checkout address is opened: a « javascript: » one is a failed session", async () => {
    replies.push({ status: 200, body: { url: "javascript:alert(1)" } });
    click("checkout-btn");
    await settle();
    expect(posts).toHaveLength(11);
    expect(errorShown()).toBe(true);
    closeError();
  });

  it("on success the checkout opens; back from it (back/forward cache) the spinner goes and the next click is ours again", async () => {
    replies.push({ status: 200, body: { url: "https://checkout.example.com/c/s_1", visitorId: "v_12345678" } });
    click("checkout-btn");
    await settle();
    expect(posts).toHaveLength(12);
    expect(sessionStorage.getItem("whopco_pending")).toBe("1");
    expect(errorShown()).toBe(false);
    // Leaving for the checkout: the spinner stays, a second click does nothing.
    expect(overlayShown()).toBe(true);
    click("checkout-btn");
    await settle();
    expect(posts).toHaveLength(12);
    // An ordinary pageshow changes nothing; one from the back/forward cache resets the page.
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: false }));
    expect(overlayShown()).toBe(true);
    const stale = document.createElement("div");
    stale.id = "whopco-error";
    document.body.appendChild(stale);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    expect(overlayShown()).toBe(false);
    expect(errorShown()).toBe(false);
    replies.push({ status: 409, body: { error: "x", reason: "price_higher" } });
    expect(click("checkout-btn").defaultPrevented).toBe(true);
    await settle();
    expect(posts).toHaveLength(13);
    closeError();
  });

  it("back from Shopify's checkout (a cart it keeps), the next click is decided again: ours", async () => {
    replies.push({ status: 409, body: { error: "Abonnement : checkout Shopify", reason: "selling_plan", native: true } });
    click("checkout-btn");
    await settle();
    expect(posts).toHaveLength(14);
    expect(errorShown()).toBe(false);
    // Left for Shopify's checkout: the page is theirs until it comes back from the back/forward cache.
    expect(click("checkout-btn").defaultPrevented).toBe(false);
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    replies.push({ status: 409, body: { error: "x", reason: "price_higher" } });
    expect(click("checkout-btn").defaultPrevented).toBe(true);
    await settle();
    expect(posts).toHaveLength(15);
  });
});
