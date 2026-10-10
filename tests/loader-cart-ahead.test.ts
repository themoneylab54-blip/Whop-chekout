// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, the cart read ahead. Heading for the checkout (the pointer over its button) wakes
 * the whole path on the store's checkout domain (session API, checkout page, /prepare) and reads
 * Shopify's cart; a click within 20 s asks that cart's session at once (CORS-simple: text/plain) while
 * reading the cart again, and that session opens only for the cart this read confirms. A changed cart is
 * asked again under a new key (only that session opens); a cart change seen after the read ahead (the
 * theme's /cart/change.js, a localized add the observer still holds) or a read older than 20 s leaves
 * the click to read first, as before; the click's own read failing is retried as before, never opening
 * the session asked ahead; an emptied cart or a subscription is handled as before.
 */

const API = "https://app.example.com";
const DOMAIN = "https://checkout.shop.test";
const TEXT = "text/plain;charset=UTF-8";
const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");

vi.useFakeTimers();
afterAll(() => {
  vi.useRealTimers();
});
const settle = async () => {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
};

type Line = { variant_id: number; quantity: number; handle: string; selling_plan_allocation?: unknown };
const cartOf = (quantity: number, line: Partial<Line> = {}) => ({ token: "cart-token-1", items: [{ variant_id: 1, quantity, handle: "jacket", ...line }] });
let shopCart: unknown = cartOf(1); // what /cart.js answers
let cartFails = 0; // the next reads answer 503
let hold = false; // reads wait for release(): the click's own read, the session asked ahead meanwhile
const held: (() => void)[] = [];
const release = () => held.splice(0).forEach((answer) => answer());
let cartReads = 0;

type Body = { store: string; items: { variant_id: number; quantity: number }[]; cartToken?: string; requestKey: string };
const posts: { body: Body; headers?: HeadersInit }[] = []; // to the checkout domain
const appPosts: Body[] = []; // to the app's API (the domain unreachable)
const replies: number[] = []; // statuses of the next session answers (then 200)
let holdPosts = false; // the domain's answers wait for answerPost(): a network error or the answer
const heldPosts: ((networkError: boolean) => void)[] = [];
const warmups: { url: string; init?: RequestInit }[] = [];

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/config")) {
      return new Response(JSON.stringify({ enabled: true, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "", excludedHandles: [] }, sessionEndpoint: `${DOMAIN}/api/public/sessions` }));
    }
    if (u.startsWith(`${DOMAIN}/checkout-icon.svg`)) return new Response("", { status: 200 });
    if (u === "/cart.js") {
      cartReads++;
      const answer = () => {
        if (cartFails > 0) {
          cartFails--;
          return new Response(JSON.stringify({ status: 503, message: "Unavailable" }), { status: 503 });
        }
        return new Response(JSON.stringify(shopCart));
      };
      if (!hold) return answer();
      return new Promise<Response>((resolve) => held.push(() => resolve(answer())));
    }
    if (u.endsWith("/c/warm") || u.endsWith("/api/public/sessions/warm/prepare") || (u.endsWith("/api/public/sessions") && init?.body === '{"warm":true}')) {
      warmups.push({ url: u, init });
      return new Response('{"warm":true}');
    }
    if (u === `${DOMAIN}/api/public/sessions`) {
      posts.push({ body: JSON.parse(String(init?.body)), headers: init?.headers });
      const n = posts.length;
      const answer = () => {
        const status = replies.shift() ?? 200;
        if (status !== 200) return new Response(`<html>${status}</html>`, { status });
        return new Response(JSON.stringify({ url: `${DOMAIN}/c/s_${n}`, visitorId: `v_visitor_${n}` }));
      };
      if (!holdPosts) return answer();
      return new Promise<Response>((resolve, reject) => heldPosts.push((networkError) => (networkError ? reject(new TypeError("Failed to fetch")) : resolve(answer()))));
    }
    if (u === `${API}/api/public/sessions`) {
      appPosts.push(JSON.parse(String(init?.body)));
      // The server names the store's checkout domain: the loader keeps the checkout on the app's host.
      return new Response(JSON.stringify({ url: `${DOMAIN}/c/app_${appPosts.length}`, visitorId: "v_visitor_app" }));
    }
    return new Response("{}");
  }),
);

// The browser's PerformanceObserver (jsdom has none of its own): the theme's cart requests, handed over to
// the loader at once or still held by the observer (takeRecords).
type Entry = { name: string; entryType: string; responseEnd: number };
let handOver: (list: { getEntries: () => Entry[] }) => void = () => undefined;
const queued: Entry[] = [];
vi.stubGlobal(
  "PerformanceObserver",
  class {
    constructor(callback: typeof handOver) {
      handOver = callback;
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return queued.splice(0);
    }
  },
);
const cartRequestEnded = (path: string, handedOver = true) => {
  const entry = { name: `${location.origin}${path}`, entryType: "resource", responseEnd: performance.now() };
  if (handedOver) handOver({ getEntries: () => [entry] });
  else queued.push(entry);
};

// Where the buyer is sent: the loader's `location`, its href recorded (jsdom doesn't navigate).
const navigations: string[] = [];
const recorder = {
  get search() {
    return location.search;
  },
  get pathname() {
    return location.pathname;
  },
  get origin() {
    return location.origin;
  },
  get hash() {
    return location.hash;
  },
  get href() {
    return location.href;
  },
  set href(url: string) {
    navigations.push(url);
  },
};

document.body.innerHTML = `
  <script src="${API}/loader.js?store=st_1"></script>
  <form action="/cart" method="post"><button type="button" name="checkout" id="checkout-btn">Checkout</button></form>`;
new Function("location", source)(recorder);

const click = () => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  document.getElementById("checkout-btn")!.dispatchEvent(ev);
  return ev;
};
// The warm-up's throttle: a minute later, the pointer over « Checkout » warms (and reads ahead) again.
const minuteLater = () => vi.advanceTimersByTimeAsync(61_000);
const readAhead = async () => {
  const before = cartReads;
  document.getElementById("checkout-btn")!.dispatchEvent(new Event("pointerover", { bubbles: true }));
  await settle();
  expect(cartReads).toBe(before + 1);
};
// Back from the checkout (back/forward cache): the next click is decided again.
const back = () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
const errorShown = () => !!document.getElementById("whopco-error");
const overlayShown = () => !!document.getElementById("whopco-overlay");

describe("loader: the cart read ahead", () => {
  it("heading for the checkout wakes the whole path on the checkout domain, without preflight, and reads the cart", async () => {
    await settle(); // config + ping
    await readAhead();
    expect(warmups.map((w) => [w.url, w.init?.method ?? "GET", w.init?.mode ?? "cors"])).toEqual([
      [`${DOMAIN}/api/public/sessions`, "POST", "cors"],
      [`${DOMAIN}/c/warm`, "GET", "no-cors"],
      [`${DOMAIN}/api/public/sessions/warm/prepare`, "POST", "no-cors"],
    ]);
    expect(warmups[0].init?.headers).toEqual({ "Content-Type": TEXT });
    expect(warmups[1].init).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(warmups[2].init).toMatchObject({ credentials: "omit", headers: { "Content-Type": TEXT }, body: '{"warm":true}' });
    expect(document.querySelector(`link[rel='preconnect'][href='${DOMAIN}']`)).toBeTruthy();
    expect(document.querySelector(`link[rel='preconnect'][href='${API}']`)).toBeTruthy();
  });

  it("the click asks the cart's session at once (text/plain), before its own /cart.js answers; the same cart: that session opens", async () => {
    hold = true;
    expect(click().defaultPrevented).toBe(true);
    await settle();
    // The click's own read is on its way; the session request already went.
    expect(cartReads).toBe(2);
    expect(held).toHaveLength(1);
    expect(posts).toHaveLength(1);
    expect(posts[0].headers).toEqual({ "Content-Type": TEXT });
    expect(posts[0].body).toMatchObject({ store: "st_1", items: [{ variant_id: 1, quantity: 1 }], cartToken: "cart-token-1" });
    expect(posts[0].body.requestKey).toMatch(/^[0-9a-f]{32}$/);
    // Answered, but not opened before the click's own read confirms the cart.
    expect(navigations).toEqual([]);
    expect(overlayShown()).toBe(true);
    release();
    await settle();
    expect(posts).toHaveLength(1);
    expect(navigations).toEqual([`${DOMAIN}/c/s_1`]);
    expect(sessionStorage.getItem("whopco_pending")).toBe("1");
    hold = false;
    back();
  });

  it("the cart changed since (a quantity, in another tab): asked again with the fresh items under a new key; only that session opens", async () => {
    await minuteLater();
    await readAhead(); // quantity 1
    hold = true;
    click();
    await settle();
    expect(posts).toHaveLength(2);
    expect(posts[1].body.items).toEqual([{ variant_id: 1, quantity: 1 }]);
    shopCart = cartOf(2);
    release();
    await settle();
    expect(posts).toHaveLength(3);
    expect(posts[2].body.items).toEqual([{ variant_id: 1, quantity: 2 }]);
    expect(posts[2].headers).toEqual({ "Content-Type": TEXT });
    expect(posts[2].body.requestKey).toMatch(/^[0-9a-f]{32}$/);
    expect(posts[2].body.requestKey).not.toBe(posts[1].body.requestKey);
    expect(navigations).toEqual([`${DOMAIN}/c/s_1`, `${DOMAIN}/c/s_3`]);
    hold = false;
    back();
  });

  it("a cart change seen after the read ahead (the theme's /cart/change.js): the click reads the cart first, as before", async () => {
    await minuteLater();
    await readAhead(); // quantity 2
    await vi.advanceTimersByTimeAsync(1000);
    shopCart = cartOf(3);
    cartRequestEnded("/cart/change.js");
    hold = true;
    click();
    await settle();
    expect(posts).toHaveLength(3);
    expect(held).toHaveLength(1);
    release();
    await settle();
    expect(posts).toHaveLength(4);
    expect(posts[3].body.items).toEqual([{ variant_id: 1, quantity: 3 }]);
    expect(navigations.at(-1)).toBe(`${DOMAIN}/c/s_4`);
    hold = false;
    back();
  });

  it("a change that ended before the read ahead is in it (sent ahead); a localized add the observer still holds isn't (/fr/cart/add.js?…)", async () => {
    await minuteLater();
    cartRequestEnded("/cart/update.js");
    await vi.advanceTimersByTimeAsync(1);
    await readAhead(); // quantity 3
    hold = true;
    click();
    await settle();
    expect(posts).toHaveLength(5);
    expect(posts[4].body.items).toEqual([{ variant_id: 1, quantity: 3 }]);
    release();
    await settle();
    expect(posts).toHaveLength(5);
    expect(navigations.at(-1)).toBe(`${DOMAIN}/c/s_5`);
    hold = false;
    back();

    await minuteLater();
    await readAhead(); // quantity 3
    await vi.advanceTimersByTimeAsync(1000);
    shopCart = cartOf(4);
    cartRequestEnded("/fr/cart/add.js?sections=cart-drawer", false);
    hold = true;
    click();
    await settle();
    expect(posts).toHaveLength(5);
    expect(held).toHaveLength(1);
    release();
    await settle();
    expect(posts).toHaveLength(6);
    expect(posts[5].body.items).toEqual([{ variant_id: 1, quantity: 4 }]);
    expect(navigations.at(-1)).toBe(`${DOMAIN}/c/s_6`);
    hold = false;
    back();
  });

  it("a read ahead older than 20 s isn't sent: the click reads the cart first", async () => {
    await minuteLater();
    await readAhead();
    await vi.advanceTimersByTimeAsync(20_001);
    hold = true;
    click();
    await settle();
    expect(posts).toHaveLength(6);
    expect(held).toHaveLength(1);
    release();
    await settle();
    expect(posts).toHaveLength(7);
    expect(navigations.at(-1)).toBe(`${DOMAIN}/c/s_7`);
    hold = false;
    back();
  });

  it("the click's own read failing is retried as before (800 ms, then « Réessayer »): the session asked ahead never opens", async () => {
    await minuteLater();
    await readAhead();
    const opened = navigations.length;
    const reads = cartReads;
    cartFails = 2;
    click();
    await settle();
    expect(posts).toHaveLength(8); // asked ahead, answered
    expect(navigations).toHaveLength(opened);
    await vi.advanceTimersByTimeAsync(700);
    expect(cartReads - reads).toBe(1);
    expect(overlayShown()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(cartReads - reads).toBe(2);
    expect(posts).toHaveLength(8);
    expect(navigations).toHaveLength(opened);
    expect(errorShown()).toBe(true);
    expect(overlayShown()).toBe(false);
    document.getElementById("whopco-error")!.remove();
  });

  it("…and when the retry reads the cart, its session opens under a new key, never the one asked ahead", async () => {
    await minuteLater();
    await readAhead();
    cartFails = 1;
    click();
    await settle();
    expect(posts).toHaveLength(9);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(posts).toHaveLength(10);
    expect(posts[9].body.items).toEqual(posts[8].body.items);
    expect(posts[9].body.requestKey).not.toBe(posts[8].body.requestKey);
    expect(navigations.at(-1)).toBe(`${DOMAIN}/c/s_10`);
    back();
  });

  it("the session asked ahead failing (502) for the cart the click's read confirms: retried once with the same key, as before", async () => {
    await minuteLater();
    await readAhead();
    replies.push(502);
    click();
    await settle();
    expect(posts).toHaveLength(11);
    expect(navigations.at(-1)).toBe(`${DOMAIN}/c/s_10`);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(posts).toHaveLength(12);
    expect(posts[11].body.requestKey).toBe(posts[10].body.requestKey);
    expect(navigations.at(-1)).toBe(`${DOMAIN}/c/s_12`);
    back();
  });

  it("the cart emptied meanwhile: read again 600 ms later, then the shop's cart page, as before", async () => {
    await minuteLater();
    await readAhead();
    shopCart = { token: "cart-token-1", items: [] };
    click();
    await settle();
    expect(posts).toHaveLength(13); // asked ahead, for the cart read before
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(posts).toHaveLength(13);
    expect(navigations.at(-1)).toBe("/cart");
    expect(overlayShown()).toBe(false);
  });

  it("a subscription in the cart the click reads: Shopify's checkout, as before", async () => {
    shopCart = cartOf(1);
    await minuteLater();
    await readAhead();
    shopCart = cartOf(1, { selling_plan_allocation: { selling_plan: { id: 99 } } });
    click();
    await settle();
    expect(posts).toHaveLength(14);
    expect(navigations.at(-1)).toBe("/checkout");
    back();
  });

  it("both requests on their way: the dropped one going to the app's API (domain error) doesn't move the opened checkout to the app's host", async () => {
    shopCart = cartOf(1);
    await minuteLater();
    await readAhead(); // quantity 1
    holdPosts = true;
    hold = true;
    click();
    await settle();
    expect(posts).toHaveLength(15); // asked ahead, on its way
    shopCart = cartOf(2);
    release();
    await settle();
    expect(posts).toHaveLength(16); // the changed cart, on its way too
    heldPosts[0](true); // the dropped one: a network error, then the app's API
    await settle();
    expect(appPosts).toHaveLength(1);
    expect(appPosts[0].requestKey).toBe(posts[14].body.requestKey);
    heldPosts[1](false); // the checkout domain answers the other one
    await settle();
    expect(navigations.at(-1)).toBe(`${DOMAIN}/c/s_16`);
    heldPosts.splice(0);
    holdPosts = false;
    hold = false;
    back();
  });

  it("the domain known unreachable now: the next click goes to the app's API and its checkout opens there (?via=app), as before", async () => {
    await minuteLater();
    await readAhead();
    click();
    await settle();
    expect(posts).toHaveLength(16);
    expect(appPosts).toHaveLength(2);
    expect(navigations.at(-1)).toBe(`${API}/c/app_2?via=app`);
    back();
  });
});
