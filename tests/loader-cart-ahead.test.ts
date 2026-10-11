// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

/*
 * Storefront loader, the cart read ahead (a fresh loader and page for each test). Heading for the checkout
 * wakes the whole path on the store's checkout domain (session API, checkout page, /prepare) and reads
 * Shopify's cart, at most every 5 s apart from the warm-up's minute. A click within 20 s of that read asks
 * its session as soon as the read is in (at once, or when a read still on its way lands: a touch starts one
 * just before its click), CORS-simple (text/plain), while the click reads the cart again; that session opens
 * only for the cart this read confirms, the ad identifiers read once per click. A changed cart is asked
 * again under a new key; a cart change seen after the read ahead (/cart/change.js, a discount code, a
 * localized add the observer still holds) or a read older than 20 s leaves the click to read first, and the
 * cart is read again 300 ms after the changes stop. The click's own read failing is retried as before, the
 * retry opening the session asked ahead for the same cart (no second session). A malformed or unreadable
 * cookie never blocks the checkout.
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
type Body = { store: string; items: { variant_id: number; quantity: number }[]; cartToken?: string; requestKey: string; tracking?: Record<string, string> };

// The shop and our servers as one test's loader sees them.
const fresh = () => ({
  enabled: true,
  interception: {} as Record<string, unknown>, // the store's settings beyond the defaults
  domainDown: false, // this tab already found the checkout domain unreachable
  cart: cartOf(1) as unknown, // what /cart.js answers
  cartFails: 0, // the next reads answer 503
  hold: false, // reads wait for release()
  held: [] as (() => void)[],
  cartReads: 0,
  readTimes: [] as number[],
  writesOnRead: false, // an app's script that writes the cart after each /cart.js read
  appDown: false, // the app's API unreachable too
  posts: [] as { body: Body; headers?: HeadersInit }[], // session requests to the checkout domain
  appPosts: [] as Body[], // to the app's API
  replies: [] as number[], // statuses of the next session answers (then 200)
  holdPosts: false, // the domain's session answers wait for heldPosts[n](networkError)
  heldPosts: [] as ((networkError: boolean) => void)[],
  warmups: [] as { url: string; init?: RequestInit }[],
  navigations: [] as string[],
});
let s = fresh();
const release = () => s.held.splice(0).forEach((answer) => answer());

vi.stubGlobal(
  "fetch",
  vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const shop = s; // answered from the state of the test that asked, even late
    if (u.includes("/config")) {
      return new Response(
        JSON.stringify({ enabled: shop.enabled, interception: { cartCheckout: true, cartDrawer: true, buyNow: true, customSelectors: "", excludedHandles: [], ...shop.interception }, sessionEndpoint: `${DOMAIN}/api/public/sessions` }),
      );
    }
    if (u.startsWith(`${DOMAIN}/checkout-icon.svg`)) return new Response("", { status: 200 });
    if (u === "/cart.js") {
      shop.cartReads++;
      shop.readTimes.push(Date.now());
      if (shop.writesOnRead) setTimeout(() => cartRequestEnded("/cart/update.js"), 50);
      const answer = () => {
        if (shop.cartFails > 0) {
          shop.cartFails--;
          return new Response(JSON.stringify({ status: 503, message: "Unavailable" }), { status: 503 });
        }
        return new Response(JSON.stringify(shop.cart));
      };
      if (!shop.hold) return answer();
      return new Promise<Response>((resolve) => shop.held.push(() => resolve(answer())));
    }
    if (u.endsWith("/c/warm") || u.endsWith("/api/public/sessions/warm/prepare") || (u.endsWith("/api/public/sessions") && init?.body === '{"warm":true}')) {
      shop.warmups.push({ url: u, init });
      return new Response('{"warm":true}');
    }
    if (u === `${DOMAIN}/api/public/sessions`) {
      shop.posts.push({ body: JSON.parse(String(init?.body)), headers: init?.headers });
      const n = shop.posts.length;
      const answer = () => {
        const status = shop.replies.shift() ?? 200;
        if (status !== 200) return new Response(`<html>${status}</html>`, { status });
        return new Response(JSON.stringify({ url: `${DOMAIN}/c/s_${n}`, visitorId: `v_visitor_${n}` }));
      };
      if (!shop.holdPosts) return answer();
      return new Promise<Response>((resolve, reject) => shop.heldPosts.push((networkError) => (networkError ? reject(new TypeError("Failed to fetch")) : resolve(answer()))));
    }
    if (u === `${API}/api/public/sessions`) {
      if (shop.appDown) throw new TypeError("Failed to fetch");
      shop.appPosts.push(JSON.parse(String(init?.body)));
      // The server names the store's checkout domain: the loader keeps the checkout on the app's host.
      return new Response(JSON.stringify({ url: `${DOMAIN}/c/app_${shop.appPosts.length}`, visitorId: "v_visitor_app" }));
    }
    return new Response("{}");
  }),
);

// The browser's PerformanceObserver (jsdom has none of its own): the theme's cart requests, handed over to
// the loader at once or still held by the observer (takeRecords).
type Entry = { name: string; entryType: string; responseEnd: number };
let observers = 0;
let handOver: (list: { getEntries: () => Entry[] }) => void = () => undefined;
const queued: Entry[] = [];
vi.stubGlobal(
  "PerformanceObserver",
  class {
    constructor(callback: typeof handOver) {
      observers++;
      handOver = callback;
    }
    observe() {}
    disconnect() {}
    takeRecords() {
      return queued.splice(0);
    }
  },
);
// A request that ended now (or at `endedAt`): the storefront's, unless `path` is another origin's URL.
const cartRequestEnded = (path: string, handedOver = true, endedAt = performance.now()) => {
  const entry = { name: /^https?:/.test(path) ? path : `${location.origin}${path}`, entryType: "resource", responseEnd: endedAt };
  if (handedOver) handOver({ getEntries: () => [entry] });
  else queued.push(entry);
};

// One loader at a time, on a fresh page: the listeners it adds are removed after it, with its timers.
const added: [EventTarget, string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];
const teardown = async () => {
  await settle();
  for (const [target, type, listener, options] of added.splice(0)) target.removeEventListener(type, listener, options);
  vi.clearAllTimers();
  handOver = () => undefined;
  queued.splice(0);
};
afterEach(teardown);
const boot = async (setup: Partial<ReturnType<typeof fresh>> = {}, path = "/") => {
  await teardown();
  s = { ...fresh(), ...setup };
  history.replaceState(null, "", path);
  sessionStorage.clear();
  localStorage.clear();
  for (const c of document.cookie.split("; ")) if (c) document.cookie = `${c.split("=")[0]}=; path=/; max-age=0`;
  if (s.domainDown) sessionStorage.setItem("whopco_ping", JSON.stringify({ origin: DOMAIN, ok: false, at: Date.now() }));
  document.head.querySelectorAll("link").forEach((l) => l.remove());
  document.body.innerHTML = `
    <script src="${API}/loader.js?store=st_1"></script>
    <form action="/cart/add" id="product-form"><input type="hidden" name="id" value="111"><button type="submit" id="add-btn">Add to cart</button></form>
    <form action="/cart" method="post"><button type="button" name="checkout" id="checkout-btn">Checkout</button></form>`;
  delete (window as { __whopco?: boolean }).__whopco;
  // Where the buyer is sent: the loader's `location`, its href recorded (jsdom doesn't navigate).
  const navigations = s.navigations;
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
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
    if (listener) added.push([this, type, listener, options]);
    add.call(this, type, listener, options);
  };
  try {
    new Function("location", source)(recorder);
  } finally {
    EventTarget.prototype.addEventListener = add;
  }
  await settle(); // config (and ping)
};

const button = () => document.getElementById("checkout-btn")!;
const click = () => {
  const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
  button().dispatchEvent(ev);
  return ev;
};
// The buyer heads for « Checkout »: the pointer over it, or a touch (just before its click).
const hover = async () => {
  button().dispatchEvent(new Event("pointerover", { bubbles: true }));
  await settle();
};
const touch = () => button().dispatchEvent(new Event("touchstart", { bubbles: true }));
// Back from the checkout (back/forward cache): the next click is decided again.
const back = () => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
const tryAgain = () => (document.querySelector("#whopco-error button") as HTMLButtonElement).click();
const quantities = () => s.posts.map((p) => p.body.items[0].quantity);
const errorShown = () => !!document.getElementById("whopco-error");
const overlayShown = () => !!document.getElementById("whopco-overlay");

describe("loader: heading for the checkout", () => {
  it("wakes the whole path on the checkout domain, without preflight, and reads the cart (its PerformanceObserver made then)", async () => {
    const before = observers;
    await boot();
    expect(observers).toBe(before);
    await hover();
    expect(s.warmups.map((w) => [w.url, w.init?.method, w.init?.mode ?? "cors"])).toEqual([
      [`${DOMAIN}/api/public/sessions`, "POST", "cors"],
      [`${DOMAIN}/c/warm`, "HEAD", "no-cors"],
      [`${DOMAIN}/api/public/sessions/warm/prepare`, "POST", "no-cors"],
    ]);
    expect(s.warmups[0].init?.headers).toEqual({ "Content-Type": TEXT });
    expect(s.warmups[1].init).toMatchObject({ credentials: "omit", cache: "no-store" });
    expect(s.warmups[2].init).toMatchObject({ credentials: "omit", headers: { "Content-Type": TEXT }, body: '{"warm":true}' });
    // Anonymous connections for the requests, a plain one (cookies) for the checkout page.
    expect(document.querySelector(`link[rel='preconnect'][href='${DOMAIN}'][crossorigin]`)).toBeTruthy();
    expect(document.querySelector(`link[rel='preconnect'][href='${API}'][crossorigin]`)).toBeTruthy();
    expect(document.querySelector(`link[rel='preconnect'][href='${DOMAIN}']:not([crossorigin])`)).toBeTruthy();
    expect(s.cartReads).toBe(1);
    expect(observers).toBe(before + 1);
  });

  it("checkout switched off: nothing read ahead, no PerformanceObserver made", async () => {
    const before = observers;
    await boot({ enabled: false });
    await hover();
    expect(s.cartReads).toBe(0);
    expect(observers).toBe(before);
  });

  it("the cart is read ahead at most every 5 s, apart from the warm-up's minute; both throttles come before any selector", async () => {
    await boot();
    await hover();
    expect(s.cartReads).toBe(1);
    expect(s.warmups).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(4_000);
    const closest = vi.spyOn(Element.prototype, "closest");
    await hover();
    expect(closest).not.toHaveBeenCalled();
    closest.mockRestore();
    expect(s.cartReads).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await hover();
    expect(s.cartReads).toBe(2);
    expect(s.warmups).toHaveLength(3); // the warm-up keeps its minute
    // A click within 20 s of that second read: sent ahead.
    s.hold = true;
    click();
    await settle();
    expect(s.posts).toHaveLength(1);
    release();
    await settle();
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });
});

describe("loader: a click after the cart was read ahead", () => {
  it("asks the cart's session at once (text/plain), before its own /cart.js answers; the same cart: that session opens", async () => {
    await boot();
    await hover();
    s.hold = true;
    expect(click().defaultPrevented).toBe(true);
    await settle();
    // The click's own read is on its way; the session request already went.
    expect(s.cartReads).toBe(2);
    expect(s.held).toHaveLength(1);
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].headers).toEqual({ "Content-Type": TEXT });
    expect(s.posts[0].body).toMatchObject({ store: "st_1", items: [{ variant_id: 1, quantity: 1 }], cartToken: "cart-token-1" });
    expect(s.posts[0].body.requestKey).toMatch(/^[0-9a-f]{32}$/);
    // Answered, but not opened before the click's own read confirms the cart.
    expect(s.navigations).toEqual([]);
    expect(overlayShown()).toBe(true);
    release();
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
    expect(sessionStorage.getItem("whopco_pending")).toBe("1");
  });

  it("reads the ad identifiers once: with ?fbclid= and no _fbc cookie (an fbc carrying the time) the same cart still makes the same body", async () => {
    await boot({}, "/?fbclid=fb_click_1");
    await hover();
    s.hold = true;
    click();
    await settle();
    await vi.advanceTimersByTimeAsync(150); // the click's own read takes its time
    release();
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].body.tracking?.fbc).toMatch(/^fb\.1\.\d+\.fb_click_1$/);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("the cart changed since (a quantity, in another tab): asked again with the fresh items under a new key; only that session opens", async () => {
    await boot();
    await hover();
    s.hold = true;
    click();
    await settle();
    expect(s.posts).toHaveLength(1);
    s.cart = cartOf(2);
    release();
    await settle();
    expect(quantities()).toEqual([1, 2]);
    expect(s.posts[1].headers).toEqual({ "Content-Type": TEXT });
    expect(s.posts[1].body.requestKey).toMatch(/^[0-9a-f]{32}$/);
    expect(s.posts[1].body.requestKey).not.toBe(s.posts[0].body.requestKey);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_2`]);
  });

  it("a read ahead the click's own read contradicted is dropped: the next click (back from the checkout) reads first", async () => {
    await boot();
    await hover();
    s.hold = true;
    click();
    await settle();
    s.cart = cartOf(2);
    release();
    await settle();
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_2`]);
    back();
    click();
    await settle();
    expect(s.posts).toHaveLength(2); // nothing sent ahead from the dropped read
    release();
    await settle();
    expect(quantities()).toEqual([1, 2, 2]);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_2`, `${DOMAIN}/c/s_3`]);
  });

  it("a cart change seen after the read ahead (the theme's /cart/change.js): the click reads the cart first, as before", async () => {
    await boot();
    await hover();
    await vi.advanceTimersByTimeAsync(100);
    s.cart = cartOf(2);
    cartRequestEnded("/cart/change.js");
    s.hold = true;
    click();
    await settle();
    expect(s.posts).toHaveLength(0);
    expect(s.held).toHaveLength(1);
    release();
    await settle();
    expect(quantities()).toEqual([2]);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("the same for a localized add the observer still holds (not handed over yet) and for a discount code a drawer app applies", async () => {
    await boot();
    await hover();
    await vi.advanceTimersByTimeAsync(100);
    s.cart = cartOf(2);
    cartRequestEnded("/fr/cart/add.js?sections=cart-drawer", false);
    s.hold = true;
    click();
    await settle();
    expect(s.posts).toHaveLength(0);
    release();
    await settle();
    expect(quantities()).toEqual([2]);

    await boot();
    await hover();
    await vi.advanceTimersByTimeAsync(100);
    cartRequestEnded("/discount/SUMMER10?redirect=%2Fcart");
    s.hold = true;
    click();
    await settle();
    expect(s.posts).toHaveLength(0);
    release();
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("after cart changes (a drawer's quantities) the cart is read again once they stop (300 ms): the next click is sent ahead again", async () => {
    await boot();
    await hover();
    await vi.advanceTimersByTimeAsync(4_000);
    s.cart = cartOf(2);
    cartRequestEnded("/cart/change.js");
    await vi.advanceTimersByTimeAsync(200);
    s.cart = cartOf(3);
    cartRequestEnded("/cart/change.js");
    await vi.advanceTimersByTimeAsync(299);
    expect(s.cartReads).toBe(1); // waits for the changes to stop
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(s.cartReads).toBe(2);
    s.hold = true;
    click();
    await settle();
    expect(quantities()).toEqual([3]); // sent ahead
    release();
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("read again 3 s at least after the last read, and only within 20 s of heading for the checkout", async () => {
    await boot();
    await hover();
    await vi.advanceTimersByTimeAsync(100);
    cartRequestEnded("/cart/change.js");
    await vi.advanceTimersByTimeAsync(2_899);
    expect(s.cartReads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(s.readTimes[1] - s.readTimes[0]).toBe(3_000);
    // 20 s after the buyer headed for the checkout, a change is only marked: not read again.
    await vi.advanceTimersByTimeAsync(17_500);
    cartRequestEnded("/cart/change.js");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(s.cartReads).toBe(2);
  });

  it("a read made since the changes (heading for the checkout again) leaves nothing to read again", async () => {
    await boot();
    await hover();
    await vi.advanceTimersByTimeAsync(4_900);
    cartRequestEnded("/cart/change.js"); // to be read again 300 ms later…
    await vi.advanceTimersByTimeAsync(100);
    await hover(); // …but the pointer over « Checkout » reads it first (5 s on)
    expect(s.cartReads).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(s.cartReads).toBe(2);
  });

  it("an app's script writing the cart after each read can't make it loop: 3 s apart, within 20 s of the intent, then nothing", async () => {
    await boot();
    await hover();
    s.writesOnRead = true;
    cartRequestEnded("/cart/update.js");
    await vi.advanceTimersByTimeAsync(60_000);
    await settle();
    const gaps = s.readTimes.slice(1).map((t, i) => t - s.readTimes[i]);
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((gap) => gap >= 3_000)).toBe(true);
    expect(s.readTimes.at(-1)! - s.readTimes[0]).toBeLessThan(20_000);
    expect(s.cartReads).toBeLessThanOrEqual(7);
  });

  it("only the storefront's own requests are cart changes: another site's /api/discount/… neither outdates the read ahead nor reads again", async () => {
    await boot();
    await hover();
    await vi.advanceTimersByTimeAsync(100);
    cartRequestEnded("https://reviews-app.example/api/discount/badge.json");
    cartRequestEnded("https://reviews-app.example/cart/add.js", false);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(s.cartReads).toBe(1);
    s.hold = true;
    click();
    await settle();
    expect(s.posts).toHaveLength(1); // sent ahead
    release();
    await settle();
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("a change handed over late but ended before the read ahead was asked is in that read: sent ahead", async () => {
    await boot();
    await hover();
    await vi.advanceTimersByTimeAsync(6_000);
    cartRequestEnded("/cart/change.js", false); // ended now, the observer still holds it
    await vi.advanceTimersByTimeAsync(1);
    await hover(); // read again (5 s on), after that change
    expect(s.cartReads).toBe(2);
    s.hold = true;
    click();
    await settle();
    expect(s.posts).toHaveLength(1);
    release();
    await settle();
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("a read ahead older than 20 s isn't sent: the click reads the cart first", async () => {
    await boot();
    await hover();
    await vi.advanceTimersByTimeAsync(20_001);
    s.hold = true;
    click();
    await settle();
    expect(s.posts).toHaveLength(0);
    expect(s.held).toHaveLength(1);
    release();
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("the session asked ahead failing (502) for the cart the click's read confirms: retried once with the same key, as before", async () => {
    await boot();
    await hover();
    s.replies.push(502);
    click();
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([]);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1].body.requestKey).toBe(s.posts[0].body.requestKey);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_2`]);
  });

  it("the cart emptied meanwhile: read again 600 ms later, then the shop's cart page, as before", async () => {
    await boot();
    await hover();
    s.cart = { token: "cart-token-1", items: [] };
    click();
    await settle();
    expect(s.posts).toHaveLength(1); // asked ahead, for the cart read before
    await vi.advanceTimersByTimeAsync(600);
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual(["/cart"]);
    expect(overlayShown()).toBe(false);
  });

  it("a subscription in the cart the click reads: Shopify's checkout, as before", async () => {
    await boot();
    await hover();
    s.cart = cartOf(1, { selling_plan_allocation: { selling_plan: { id: 99 } } });
    click();
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual(["/checkout"]);
  });

  it("add to cart → straight to checkout: the cart just changed, nothing read ahead is sent", async () => {
    await boot({ interception: { addToCartDirect: true } });
    await hover(); // quantity 1
    s.cart = cartOf(2); // the add (its request not seen yet)
    s.hold = true;
    (document.getElementById("add-btn") as HTMLButtonElement).click();
    await settle();
    expect(s.posts).toHaveLength(0);
    expect(s.held).toHaveLength(1); // the click's own read
    release();
    await settle();
    expect(quantities()).toEqual([2]);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });
});

describe("loader: a cart read still on its way at the click (a touch)", () => {
  it("is sent ahead when it lands, while the click reads the cart too; the same cart: that session opens", async () => {
    await boot();
    s.hold = true;
    touch();
    await settle();
    expect(s.cartReads).toBe(1); // read ahead, on its way
    click();
    await settle();
    expect(s.cartReads).toBe(2); // and the click's own
    expect(s.posts).toHaveLength(0);
    s.held.shift()!(); // the read ahead lands first
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([]);
    release(); // then the click's own: the same cart
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("isn't sent once the click's own read is in first: that session asked as before, once", async () => {
    await boot();
    s.hold = true;
    touch();
    click();
    await settle();
    s.held.pop()!(); // the click's own read lands first
    await settle();
    expect(s.posts).toHaveLength(1);
    release(); // then the read ahead
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("nor once the click's own read failed: landing during the retry's pause, it isn't sent (the retry asks once, for its own read)", async () => {
    await boot();
    s.hold = true;
    touch();
    click();
    await settle();
    expect(s.cartReads).toBe(2);
    s.cartFails = 1;
    s.held.pop()!(); // the click's own read: 503
    await settle();
    s.held.shift()!(); // the read ahead lands while the retry waits
    await settle();
    expect(s.posts).toHaveLength(0);
    s.hold = false;
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(s.cartReads).toBe(3);
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("a read ahead that fails (503) is never sent: the click goes on with its own read", async () => {
    await boot();
    s.hold = true;
    touch();
    click();
    await settle();
    s.cartFails = 1;
    s.held.shift()!(); // the read ahead: 503
    await settle();
    expect(s.posts).toHaveLength(0);
    release(); // the click's own: fine
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("nor once a cart change ended after it was asked", async () => {
    await boot();
    s.hold = true;
    touch();
    click();
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    s.cart = cartOf(2);
    cartRequestEnded("/cart/change.js");
    s.held.shift()!(); // the read ahead lands, outdated
    await settle();
    expect(s.posts).toHaveLength(0);
    release();
    await settle();
    expect(quantities()).toEqual([2]);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });
});

describe("loader: the click's own read failing after a session was asked ahead", () => {
  it("is retried as before (800 ms, then « Réessayer »): that session never opens", async () => {
    await boot();
    await hover();
    s.cartFails = 2;
    click();
    await settle();
    expect(s.posts).toHaveLength(1); // asked ahead, answered
    expect(s.navigations).toEqual([]);
    await vi.advanceTimersByTimeAsync(700);
    expect(s.cartReads).toBe(2);
    expect(overlayShown()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(s.cartReads).toBe(3);
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([]);
    expect(errorShown()).toBe(true);
    expect(overlayShown()).toBe(false);
  });

  it("the retry reading the same cart opens that session (no second one), the ad identifiers still those of the click", async () => {
    await boot({}, "/?fbclid=fb_click_1");
    await hover();
    s.cartFails = 1;
    click();
    await settle();
    expect(s.posts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(s.cartReads).toBe(3);
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("that session having failed (502): asked again under its key for the same cart (the server answers it if it made it)", async () => {
    await boot();
    await hover();
    s.cartFails = 1;
    s.replies.push(502);
    click();
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1].body.requestKey).toBe(s.posts[0].body.requestKey);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_2`]);
  });

  it("that session lost on the network (the checkout domain, then the app's API): asked again under its key for the same cart", async () => {
    await boot();
    await hover();
    s.holdPosts = true;
    s.appDown = true;
    s.cartFails = 1;
    click();
    await settle();
    expect(s.posts).toHaveLength(1);
    s.heldPosts[0](true); // the checkout domain: a network error, then the app's API: one too
    await settle();
    s.appDown = false;
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    // The domain known unreachable now: straight to the app's API, under the key of the session asked ahead.
    expect(s.appPosts).toHaveLength(1);
    expect(s.appPosts[0].requestKey).toBe(s.posts[0].body.requestKey);
    expect(s.navigations).toEqual([`${API}/c/app_1?via=app`]);
  });

  it("the retry waits for that session when it's still on its way: one session", async () => {
    await boot();
    await hover();
    s.holdPosts = true;
    s.cartFails = 1;
    click();
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(s.cartReads).toBe(3);
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([]);
    s.heldPosts[0](false);
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("every read failing, then « Réessayer » on the same cart: the session asked ahead opens, no second one", async () => {
    await boot();
    await hover();
    s.cartFails = 2;
    click();
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(errorShown()).toBe(true);
    expect(s.posts).toHaveLength(1);
    tryAgain();
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("…that session having failed (502): « Réessayer » asks again under its key; another cart gets a new key", async () => {
    await boot();
    await hover();
    s.replies.push(502);
    s.cartFails = 2;
    click();
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(errorShown()).toBe(true);
    tryAgain();
    await settle();
    expect(s.posts).toHaveLength(2);
    expect(s.posts[1].body.requestKey).toBe(s.posts[0].body.requestKey);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_2`]);

    await boot();
    await hover();
    s.cartFails = 2;
    click();
    await settle();
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    s.cart = cartOf(2);
    tryAgain();
    await settle();
    expect(quantities()).toEqual([1, 2]);
    expect(s.posts[1].body.requestKey).not.toBe(s.posts[0].body.requestKey);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_2`]);
  });

  it("the retry reading another cart: its own session under a new key", async () => {
    await boot();
    await hover();
    s.cartFails = 1;
    click();
    await settle();
    s.cart = cartOf(2);
    await vi.advanceTimersByTimeAsync(800);
    await settle();
    expect(quantities()).toEqual([1, 2]);
    expect(s.posts[1].body.requestKey).not.toBe(s.posts[0].body.requestKey);
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_2`]);
  });
});

describe("loader: session requests and cookies", () => {
  it("both session requests on their way: the dropped one going to the app's API (a domain error) doesn't move the opened checkout to the app's host", async () => {
    await boot();
    await hover();
    s.holdPosts = true;
    s.hold = true;
    click();
    await settle();
    expect(s.posts).toHaveLength(1); // asked ahead, on its way
    s.cart = cartOf(2);
    release();
    await settle();
    expect(s.posts).toHaveLength(2); // the changed cart's, on its way too
    s.heldPosts[0](true); // the dropped one: a network error, then the app's API
    await settle();
    expect(s.appPosts).toHaveLength(1);
    expect(s.appPosts[0].requestKey).toBe(s.posts[0].body.requestKey);
    s.heldPosts[1](false); // the checkout domain answers the other one
    await settle();
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_2`]);
  });

  it("the checkout domain unreachable from here: warmed and asked on the app's API, the checkout opens there (?via=app), as before", async () => {
    await boot({ domainDown: true });
    await hover();
    expect(s.warmups.map((w) => w.url)).toEqual([`${API}/api/public/sessions`, `${API}/c/warm`, `${API}/api/public/sessions/warm/prepare`]);
    expect(document.querySelector(`link[rel='preconnect'][href='${API}']:not([crossorigin])`)).toBeTruthy();
    click();
    await settle();
    expect(s.posts).toHaveLength(0);
    expect(s.appPosts).toHaveLength(1);
    expect(s.navigations).toEqual([`${API}/c/app_1?via=app`]);
  });

  it("a malformed cookie (another script's _fbp) never blocks the checkout: its raw value goes, the checkout opens", async () => {
    await boot();
    document.cookie = "_fbp=fb.1.%E0%A4%A; path=/";
    expect(click().defaultPrevented).toBe(true);
    await settle();
    expect(s.posts).toHaveLength(1);
    expect(s.posts[0].body.tracking?.fbp).toBe("fb.1.%E0%A4%A");
    expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
  });

  it("cookies unreadable (a sandboxed frame): the checkout opens, without ad identifiers", async () => {
    await boot();
    const blocked = () => {
      throw new DOMException("The document is sandboxed", "SecurityError");
    };
    Object.defineProperty(document, "cookie", { configurable: true, get: blocked, set: blocked });
    try {
      expect(click().defaultPrevented).toBe(true);
      await settle();
      expect(s.posts).toHaveLength(1);
      expect(s.posts[0].body.tracking).toEqual({});
      expect(s.navigations).toEqual([`${DOMAIN}/c/s_1`]);
    } finally {
      delete (document as unknown as { cookie?: string }).cookie;
    }
  });
});
