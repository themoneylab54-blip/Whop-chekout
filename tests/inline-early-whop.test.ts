// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EARLY_EMBED_ID,
  EARLY_FLAG,
  EARLY_SLOT_ID,
  earlyWhopControls,
  earlyWhopFor,
  earlyWhopPageRuns,
  inlineEarlyWhopScript,
  type EarlyWhop,
} from "@/components/checkout/inlineEarlyWhop";
import { BOOT_FLAG } from "@/components/checkout/inlineWatchdog";
import { thankYouPath } from "@/components/checkout/thankYouPath";
import { WHOP_SDK_PATH, whopEmbedAttributes, whopEmbedFixedAttributes, whopEmbedKey, type WhopEmbedOptions } from "@/components/checkout/whopEmbed";
import { whopFooterFit, whopFooterFitRuns } from "@/components/checkout/whopFooterFit";
import { PANEL_SPINNER_CLASS, PANEL_SPINNER_RING_CLASS, WHOP_CLIP_CLASS, WHOP_CLIP_FRAME_CLASS, WHOP_READY_GRACE_MS } from "@/components/checkout/whopFrame";

/*
 * Whop's card form started by the server HTML before the page runs: once the page's first prepare
 * (the inline one) answers with Whop's checkout, and the page hasn't started (nor said it runs without
 * one), the payment panel's slot gets the element Whop's plain script mounts its frame in — the panel's
 * very form (its attributes are whopEmbedAttributes of the panel's options, the return URL built as
 * CheckoutView builds it) — with the panel's spinner, and Whop's script injected (its tracker never
 * loaded; the script fetched while the prepare ran). The skeleton stays until Whop's frame is added,
 * then the frame takes its place with WhopFooterClip's clip at the slot's width (following it; given
 * up as WhopFooterClip gives it up). Nothing is opened for a page already running, a failed answer,
 * Stripe's checkout, another session, no slot or no MutationObserver; Whop's script failing to load
 * drops it (the skeleton stays). Whop's events are kept until the panel takes the frame, then given in
 * order and forwarded; taking it drops the early clip, its watches and the spinner; dropping it
 * removes everything. The panel finds it only when it is the frame it would open; its controls are
 * Whop's script's, by the element's id. The script is ES5 and never breaks out of the <script>.
 */

type Win = Window & Record<string, unknown> & { wco?: Record<string, unknown> & { listening?: boolean }; whop?: unknown };
const win = () => window as unknown as Win;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
/** Microtasks only (MutationObserver's deliveries): safe under fake timers. */
const microtasks = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

const SESSION = "cmsess1";
/** The card form's options as the panel would have them for that answer (see PaymentPanel). */
const options = (o: Partial<WhopEmbedOptions> = {}): WhopEmbedOptions => ({
  configId: "ch_123",
  environment: "production",
  locale: "fr",
  accentColor: "#123456",
  borderRadius: 8,
  submitButton: false,
  addressForm: false,
  hideTerms: true,
  saveCard: true,
  returnUrl: `${location.origin}${thankYouPath(SESSION, "fr", false)}`,
  ...o,
});
const whopAnswer = (body: Record<string, unknown> = {}, status = 200) => ({
  status,
  text: JSON.stringify({ provider: "whop", checkoutConfigurationId: "ch_123", environment: "production", totals: {}, ...body }),
  ref: null,
});
const script = (fit: ReturnType<typeof whopFooterFitRuns> | null = null, sessionId = SESSION) =>
  inlineEarlyWhopScript({ sessionId, attributes: whopEmbedFixedAttributes(options()), returnPath: thankYouPath(sessionId, "fr", false), fit, sdk: WHOP_SDK_PATH });

let widthReads = 0;
/** The server HTML: the panel's slot with its skeleton, the inline prepare's request, then the early start. */
async function load(o: { answer?: ReturnType<typeof whopAnswer> | Error; slot?: boolean; fit?: ReturnType<typeof whopFooterFitRuns> | null; width?: number; prepareFor?: string } = {}) {
  document.body.innerHTML = o.slot === false ? "" : `<div id="${EARLY_SLOT_ID}"><div class="skeleton">…</div></div>`;
  const slot = document.getElementById(EARLY_SLOT_ID);
  widthReads = 0;
  if (slot)
    Object.defineProperty(slot, "offsetWidth", {
      configurable: true,
      get: () => {
        widthReads++;
        return o.width ?? 375;
      },
    });
  const answer = o.answer ?? whopAnswer();
  win().__wcPrepare = { id: o.prepareFor ?? SESSION, body: "{}", at: Date.now(), p: answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer) };
  new Function(script(o.fit ?? null))();
  await tick();
  return slot;
}
/** Whop's plain script mounting its frame in the element (as the vendored file does), its controls ready; then its observers' turn. */
async function mountFrame() {
  const frame = document.createElement("iframe");
  frame.src = "https://whop.com/embedded/checkout/ch_123/";
  embed()!.appendChild(frame);
  (win().wco as { listening?: boolean }).listening = true;
  await microtasks();
  return frame;
}
const early = () => win()[EARLY_FLAG] as EarlyWhop | null | undefined;
const embed = () => document.getElementById(EARLY_EMBED_ID);
const sdkTags = () => document.head.querySelectorAll(`script[src="${WHOP_SDK_PATH}"]`);
const spinner = (slot: HTMLElement) => slot.querySelector(".animate-spin")?.parentElement ?? null;
const callbacks = ["__wcEarlyState", "__wcEarlyComplete", "__wcEarlyPaymentError", "__wcEarlyAddressError"];
/** The early wrapper's clip boxes (outer: the clipping box, inner: the frame's box). */
const boxes = () => {
  const inner = embed()!.parentElement as HTMLElement;
  return { outer: inner.parentElement as HTMLElement, inner };
};
/** The slot's children, by what they are. */
const shape = (slot: HTMLElement) =>
  [...slot.children].map((c) => (c.classList.contains("skeleton") ? "skeleton" : c.contains(embed()) ? "frame" : c === spinner(slot) ? "spinner" : "?"));

let observers: { cb: ResizeObserverCallback; disconnect: ReturnType<typeof vi.fn<() => void>>; observed: Element[] }[];
const resize = (width: number, i = 0) => observers[i].cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
beforeEach(() => {
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      entry: (typeof observers)[number];
      constructor(cb: ResizeObserverCallback) {
        this.entry = { cb, disconnect: vi.fn<() => void>(), observed: [] };
        observers.push(this.entry);
      }
      observe(el: Element) {
        this.entry.observed.push(el);
      }
      disconnect() {
        this.entry.disconnect();
      }
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  for (const k of ["__wcPrepare", EARLY_FLAG, BOOT_FLAG, "wco", "whop", ...callbacks]) delete win()[k];
  for (const s of document.head.querySelectorAll("script")) s.remove();
  document.body.innerHTML = "";
  history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

describe("the early start", () => {
  it("the prepare's Whop checkout opened in the slot: the panel's very form and spinner beside the skeleton, Whop's script injected", async () => {
    const fetched = vi.fn(async () => new Response(""));
    vi.stubGlobal("fetch", fetched);
    const slot = (await load())!;
    // Whop's script fetched while the prepare ran (into the cache), then run once the frame is opened.
    expect(fetched).toHaveBeenCalledWith(WHOP_SDK_PATH);
    // The skeleton stays until Whop's frame is added.
    expect(shape(slot)).toEqual(["skeleton", "frame", "spinner"]);
    const el = embed()!;
    const attrs = [...el.attributes].map((a) => [a.name, a.value]);
    // The panel's attributes, in its order, then the callbacks Whop's script calls.
    expect(attrs.filter(([n]) => n !== "id" && !n.startsWith("data-whop-checkout-on-"))).toEqual(whopEmbedAttributes(options()));
    expect(Object.fromEntries(attrs.filter(([n]) => n.startsWith("data-whop-checkout-on-")))).toEqual({
      "data-whop-checkout-on-state-change": "__wcEarlyState",
      "data-whop-checkout-on-complete": "__wcEarlyComplete",
      "data-whop-checkout-on-payment-error": "__wcEarlyPaymentError",
      "data-whop-checkout-on-address-validation-error": "__wcEarlyAddressError",
    });
    expect(early()).toMatchObject({ configId: "ch_123", environment: "production", key: whopEmbedKey(options()), id: EARLY_EMBED_ID });
    // The panel's spinner: its very classes.
    expect(spinner(slot)!.className).toBe(PANEL_SPINNER_CLASS);
    expect(spinner(slot)!.firstElementChild!.className).toBe(PANEL_SPINNER_RING_CLASS);
    // Whop's plain script, once; its stub and the tracker's guard set first.
    expect(sdkTags()).toHaveLength(1);
    expect((sdkTags()[0] as HTMLScriptElement).async).toBe(true);
    expect(win().wco).toMatchObject({ injected: true, listening: false });
    expect(win().wco?.frames).toBeInstanceOf(Map);
    expect(win().whop).toBeTruthy();
  });

  it("Whop's frame added: the skeleton goes (before the next paint), the frame titled as the React embed's", async () => {
    const slot = (await load())!;
    const frame = await mountFrame();
    expect(shape(slot)).toEqual(["frame", "spinner"]);
    expect(frame.title).toBe("Whop Embedded Checkout");
    // A frame of Whop's own title kept.
    for (const k of [EARLY_FLAG, "wco", "whop"]) delete win()[k];
    await load();
    const titled = document.createElement("iframe");
    titled.title = "Paiement";
    embed()!.appendChild(titled);
    await microtasks();
    expect(titled.title).toBe("Paiement");
  });

  it("Whop's script failing to load: dropped, the skeleton stays (the page opens its own frame)", async () => {
    const slot = (await load())!;
    sdkTags()[0].dispatchEvent(new Event("error"));
    expect(shape(slot)).toEqual(["skeleton"]);
    expect(early()).toBeNull();
    for (const k of callbacks) expect(win()[k]).toBeUndefined();
    // The page then finds no early frame, and none begins.
    expect(earlyWhopPageRuns()).toBe(false);
  });

  it("the return URL as CheckoutView builds it (via=app kept); the environment as preparedFromBody reads it", async () => {
    history.replaceState(null, "", `/c/${SESSION}?via=app&lang=fr`);
    await load({ answer: whopAnswer({ environment: "sandbox" }) });
    expect(embed()!.getAttribute("data-whop-checkout-return-url")).toBe(`${location.origin}${thankYouPath(SESSION, "fr", true)}`);
    expect(early()!.key).toBe(whopEmbedKey(options({ environment: "sandbox", returnUrl: `${location.origin}${thankYouPath(SESSION, "fr", true)}` })));
    for (const k of [EARLY_FLAG, "wco"]) delete win()[k];
    await load({ answer: whopAnswer({ environment: undefined }) });
    expect(early()!.environment).toBe("sandbox");
  });

  it("nothing opened: the page running, an early start made, a failed answer, Stripe's checkout, another session, no slot, no MutationObserver", async () => {
    const nothing = async (o: Parameters<typeof load>[0], before?: () => void) => {
      for (const k of [EARLY_FLAG, BOOT_FLAG, "wco", "whop"]) delete win()[k];
      before?.();
      const flag = win()[EARLY_FLAG];
      const slot = await load(o);
      if (slot) expect(shape(slot)).toEqual(["skeleton"]);
      expect(embed()).toBeNull();
      expect(sdkTags()).toHaveLength(0);
      expect(win()[EARLY_FLAG]).toBe(flag);
      expect(win().wco).toBeUndefined();
    };
    await nothing({}, () => (win()[BOOT_FLAG] = true));
    // The page runs without one (earlyWhopPageRuns before the answer).
    await nothing({}, () => expect(earlyWhopPageRuns()).toBe(false));
    // A failed answer, even one carrying a checkout (never opened: only a 200 is the page's checkout).
    await nothing({ answer: whopAnswer({}, 502) });
    await nothing({ answer: whopAnswer({}, 409) });
    await nothing({ answer: whopAnswer({ provider: "stripe", checkoutConfigurationId: null }) });
    // Stripe's checkout even with a Whop configuration in the answer: never Whop's form.
    await nothing({ answer: whopAnswer({ provider: "stripe" }) });
    await nothing({ answer: whopAnswer({ checkoutConfigurationId: null }) });
    await nothing({ answer: { status: 200, text: "<html>", ref: null } });
    await nothing({ answer: new Error("network") });
    await nothing({ prepareFor: "another" });
    await nothing({ slot: false });
    // A browser without MutationObserver (the frame's arrival couldn't be seen): not even Whop's script fetched.
    const fetched = vi.fn(async () => new Response(""));
    vi.stubGlobal("fetch", fetched);
    vi.stubGlobal("MutationObserver", undefined);
    await nothing({});
    expect(fetched).not.toHaveBeenCalled();
  });

  it("once only: a second early script (or a second answer) opens nothing more", async () => {
    await load();
    new Function(script())();
    await tick();
    expect(document.querySelectorAll(`#${EARLY_EMBED_ID}`)).toHaveLength(1);
    expect(sdkTags()).toHaveLength(1);
  });

  it("earlyWhopPageRuns: an early start begun stays (its spinner too), and says so", async () => {
    const slot = (await load())!;
    expect(earlyWhopPageRuns()).toBe(true);
    expect(early()).toBeTruthy();
    expect(spinner(slot)).not.toBeNull();
  });
});

describe("the early clip (WhopFooterClip's, from the server's table)", () => {
  const runs = whopFooterFitRuns("fr");
  const expectFit = (width: number) => {
    const fit = whopFooterFit("fr", width);
    const { outer, inner } = boxes();
    if (!fit) {
      expect(outer.className).toBe("");
      expect(outer.hasAttribute("data-clip")).toBe(false);
      expect(inner.getAttribute("style")).toBeNull();
      return;
    }
    // The panel's classes (whopFrame), as WhopFooterClip sets them.
    expect(outer.className).toBe(WHOP_CLIP_CLASS);
    expect(outer.getAttribute("data-clip")).toBe(String(fit.clip));
    expect(inner.className).toBe(WHOP_CLIP_FRAME_CLASS);
    expect(inner.style.getPropertyValue("--wc-whop-clip")).toBe(`${fit.clip}px`);
    expect(inner.style.paddingInline).toBe(`${fit.inset}px`);
  };

  it("from Whop's frame on: at the slot's width as laid out (no layout forced), then following it (whole px); none where WhopFooterClip has none", async () => {
    const slot = (await load({ fit: runs, width: 375 }))!;
    // Not before the frame: the skeleton shows meanwhile.
    expect(observers).toHaveLength(0);
    expect(boxes().outer.className).toBe("");
    await mountFrame();
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toEqual([slot]);
    // Its first observation (the next frame's layout, before its paint) gives the width: never read by force.
    resize(375);
    expect(whopFooterFit("fr", 375)).not.toBeNull();
    expectFit(375);
    // Every width a phone or a column may give, and one too narrow for any sure answer.
    for (const width of [320.7, 344, 360.2, 390, 412, 430, 520, 120]) {
      resize(width);
      expectFit(Math.floor(width));
    }
    expect(widthReads).toBe(0);
  });

  it("without ResizeObserver: the slot's width read once the frame is there, then at each window resize", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const slot = (await load({ fit: runs, width: 375 }))!;
    expect(widthReads).toBe(0);
    await mountFrame();
    expectFit(375);
    Object.defineProperty(slot, "offsetWidth", { configurable: true, get: () => 430 });
    window.dispatchEvent(new Event("resize"));
    expectFit(430);
  });

  it("no table (the footer isn't clipped for this store or language): never clipped", async () => {
    await load({ fit: null, width: 375 });
    await mountFrame();
    const { outer, inner } = boxes();
    expect(outer.className).toBe("");
    expect(inner.getAttribute("style")).toBeNull();
    expect(observers).toHaveLength(0);
  });

  it("never scrolls: a scroll by code (Whop centering its frame, a focus on the hidden footer) undone at once", async () => {
    await load({ fit: runs, width: 375 });
    await mountFrame();
    resize(375);
    const { outer } = boxes();
    let top = 0;
    let left = 0;
    Object.defineProperty(outer, "scrollTop", { configurable: true, get: () => top, set: (v: number) => void (top = v) });
    Object.defineProperty(outer, "scrollLeft", { configurable: true, get: () => left, set: (v: number) => void (left = v) });
    outer.scrollTop = 30;
    outer.scrollLeft = 4;
    outer.dispatchEvent(new Event("scroll"));
    expect([top, left]).toEqual([0, 0]);
  });

  it("given up as WhopFooterClip gives it up: no 'ready' within its grace from the frame's mount, shown whole for good", async () => {
    await load({ fit: runs, width: 375 });
    vi.useFakeTimers();
    await mountFrame();
    resize(375);
    vi.advanceTimersByTime(WHOP_READY_GRACE_MS - 1);
    expectFit(375);
    expect(early()!.clipGaveUp()).toBe(false);
    vi.advanceTimersByTime(1);
    expect(early()!.clipGaveUp()).toBe(true);
    expect(boxes().outer.className).toBe("");
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it("kept once Whop said 'ready' (as WhopFooterClip keeps it)", async () => {
    await load({ fit: runs, width: 375 });
    vi.useFakeTimers();
    await mountFrame();
    resize(375);
    (win().__wcEarlyState as (s: string) => void)("ready");
    vi.advanceTimersByTime(WHOP_READY_GRACE_MS * 2);
    expect(early()!.clipGaveUp()).toBe(false);
    expectFit(375);
  });
});

describe("Whop's events, the panel taking the frame over or dropping it", () => {
  it("kept until taken, then given in order and forwarded; given back (null), kept again", async () => {
    await load();
    const state = win().__wcEarlyState as (s: string) => void;
    (win().__wcEarlyPaymentError as (e: unknown) => void)({ message: "refusée", code: "card_declined" });
    state("loading");
    const seen: [string, unknown[]][] = [];
    early()!.take((event, args) => seen.push([event, args]));
    expect(seen).toEqual([
      ["payment-error", [{ message: "refusée", code: "card_declined" }]],
      ["state", ["loading"]],
    ]);
    state("ready");
    expect(seen.at(-1)).toEqual(["state", ["ready"]]);
    early()!.take(null);
    (win().__wcEarlyComplete as (...a: unknown[]) => void)("plan_1", "rcpt_1", { receipt_id: "rcpt_1" });
    (win().__wcEarlyAddressError as (e: unknown) => void)({ error_message: "Adresse", error_code: "x" });
    expect(seen).toHaveLength(3);
    const again: [string, unknown[]][] = [];
    early()!.take((event, args) => again.push([event, args]));
    expect(again).toEqual([
      ["complete", ["plan_1", "rcpt_1", { receipt_id: "rcpt_1" }]],
      ["address-validation-error", [{ error_message: "Adresse", error_code: "x" }]],
    ]);
  });

  it("the spinner: until Whop says 'ready', or the frame is taken over", async () => {
    let slot = (await load())!;
    await mountFrame();
    (win().__wcEarlyState as (s: string) => void)("loading");
    expect(spinner(slot)).not.toBeNull();
    (win().__wcEarlyState as (s: string) => void)("ready");
    expect(spinner(slot)).toBeNull();

    for (const k of [EARLY_FLAG, "wco", "whop"]) delete win()[k];
    slot = (await load())!;
    await mountFrame();
    early()!.take(() => undefined);
    expect(spinner(slot)).toBeNull();
  });

  it("taking it drops the early clip, its width watch, its timer and spinner (once)", async () => {
    const slot = (await load({ fit: whopFooterFitRuns("fr"), width: 375 }))!;
    vi.useFakeTimers();
    await mountFrame();
    resize(375);
    early()!.take(() => undefined);
    const { outer, inner } = boxes();
    expect(outer.className).toBe("");
    expect(inner.getAttribute("style")).toBeNull();
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    expect(spinner(slot)).toBeNull();
    early()!.take(null);
    early()!.take(() => undefined);
    expect(observers[0].disconnect).toHaveBeenCalledTimes(1);
    // The panel's clip from then on: the early one never comes back, nor gives up.
    vi.advanceTimersByTime(WHOP_READY_GRACE_MS * 2);
    expect(early()!.clipGaveUp()).toBe(false);
    expect(outer.className).toBe("");
  });

  it("taken over with Whop's frame there but not yet seen (its observer's turn to come): the skeleton goes all the same", async () => {
    const slot = (await load({ fit: whopFooterFitRuns("fr") }))!;
    const frame = document.createElement("iframe");
    embed()!.appendChild(frame);
    early()!.take(() => undefined);
    expect(shape(slot)).toEqual(["frame"]);
    expect(frame.title).toBe("Whop Embedded Checkout");
    await microtasks();
    // No early clip afterwards: the panel's.
    expect(observers).toHaveLength(0);
  });

  it("dropping it: its frame, observers, listener, timer and callbacks go, nothing forwarded afterwards, once", async () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const removed = vi.spyOn(window, "removeEventListener");
    const slot = (await load({ fit: whopFooterFitRuns("fr"), width: 375 }))!;
    vi.useFakeTimers();
    await mountFrame();
    const state = win().__wcEarlyState as (s: string) => void;
    const seen: unknown[] = [];
    const frame = early()!;
    frame.take((event) => seen.push(event));
    frame.take(null);
    frame.drop();
    expect(shape(slot)).toEqual([]);
    expect(early()).toBeNull();
    for (const k of callbacks) expect(win()[k]).toBeUndefined();
    expect(removed).toHaveBeenCalledWith("resize", expect.any(Function));
    // Nothing forwarded nor kept: a late event, a take, a second drop do nothing.
    state("ready");
    frame.take((event) => seen.push(event));
    frame.drop();
    expect(seen).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("dropping it leaves another early start's globals alone (only its own go)", async () => {
    await load();
    const first = early()!;
    for (const k of [EARLY_FLAG, "wco", "whop"]) delete win()[k];
    await load();
    const second = early()!;
    expect(second).not.toBe(first);
    first.drop();
    expect(early()).toBe(second);
    for (const k of callbacks) expect(typeof win()[k]).toBe("function");
  });

  it("dropped before Whop's frame came: a frame added later changes nothing (the skeleton stays)", async () => {
    const slot = (await load())!;
    early()!.drop();
    expect(shape(slot)).toEqual(["skeleton"]);
    // (Its element left with the wrapper: Whop's script, running late, finds nothing of it to mount.)
    expect(embed()).toBeNull();
  });

  it("earlyWhopControls: Whop's script's controls, by the element's id", async () => {
    const wco = { submit: vi.fn(async () => undefined), getEmail: vi.fn(), setEmail: vi.fn(async () => undefined), setAddress: vi.fn(async () => undefined), getAddress: vi.fn(), setDisplayCurrency: vi.fn(), getAvailableCurrencies: vi.fn(() => null) };
    win().wco = wco as unknown as Win["wco"];
    const c = earlyWhopControls(EARLY_EMBED_ID);
    await c.submit({ email: "a@b.co" } as never);
    await c.setEmail("a@b.co", 2_000);
    const address = { name: "A B", line1: "1 rue", city: "Paris", state: "", postalCode: "75001", country: "FR" };
    await c.setAddress(address);
    c.getAvailableCurrencies();
    expect(wco.submit).toHaveBeenCalledWith(EARLY_EMBED_ID, { email: "a@b.co" });
    expect(wco.setEmail).toHaveBeenCalledWith(EARLY_EMBED_ID, "a@b.co", 2_000);
    expect(wco.setAddress).toHaveBeenCalledWith(EARLY_EMBED_ID, address, undefined);
    expect(wco.getAvailableCurrencies).toHaveBeenCalledWith(EARLY_EMBED_ID);
  });
});

describe("with Whop's real plain script (the vendored file)", () => {
  it("mounts the frame in the slot in the skeleton's place, titled as the React embed's; earlyWhopFor finds it only for the panel's own form", async () => {
    // What jsdom lacks of a browser's frame (see tests/whop-embed.test.ts).
    const proto = HTMLIFrameElement.prototype as unknown as Record<string, unknown>;
    if (!("sandbox" in proto))
      Object.defineProperty(proto, "sandbox", {
        configurable: true,
        get(this: HTMLIFrameElement) {
          return { add: (...t: string[]) => this.setAttribute("sandbox", [this.getAttribute("sandbox"), ...t].filter(Boolean).join(" ")) };
        },
      });
    if (!("allow" in proto))
      Object.defineProperty(proto, "allow", {
        configurable: true,
        get(this: HTMLIFrameElement) {
          return this.getAttribute("allow") ?? "";
        },
        set(this: HTMLIFrameElement, v: string) {
          this.setAttribute("allow", v);
        },
      });
    const slot = (await load())!;
    expect(earlyWhopFor(whopEmbedKey(options()), "ch_123", slot)).toBeNull();
    // The injected tag isn't fetched by jsdom: its file run as the browser would run it.
    new Function(readFileSync(join(process.cwd(), "public", WHOP_SDK_PATH), "utf8"))();
    await tick();
    const frame = embed()!.querySelector("iframe")!;
    expect(frame).not.toBeNull();
    expect(shape(slot)).toEqual(["frame", "spinner"]);
    expect(new URL(frame.src).pathname).toBe("/embedded/checkout/ch_123/");
    expect(frame.title).toBe("Whop Embedded Checkout");
    expect(win().wco?.listening).toBe(true);
    expect(document.querySelector('script[src*="t.whop.tw"]')).toBeNull();
    expect(earlyWhopFor(whopEmbedKey(options()), "ch_123", slot)).toBe(early());
    expect(earlyWhopFor(whopEmbedKey(options({ saveCard: false })), "ch_123", slot)).toBeNull();
    expect(earlyWhopFor(whopEmbedKey(options()), "ch_other", slot)).toBeNull();
    expect(earlyWhopFor(whopEmbedKey(options()), "ch_123", document.createElement("div"))).toBeNull();
    expect(earlyWhopFor(whopEmbedKey(options()), "ch_123", null)).toBeNull();
    // Whop's frame speaking to the page (as it posts its messages): its height, its states and a
    // refused card reach the early start's callbacks through Whop's own script, kept, then given.
    const say = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent("message", { data: { __scope: "whop-embedded-checkout", ...data }, source: frame.contentWindow }));
    say({ event: "resize", height: 612 });
    say({ event: "state", state: "loading" });
    say({ event: "payment-error", message: "Carte refusée", code: "card_declined" });
    // Another window's message (not Whop's frame): ignored by Whop's script.
    window.dispatchEvent(new MessageEvent("message", { data: { __scope: "whop-embedded-checkout", event: "state", state: "ready" }, source: window }));
    expect(frame.style.height).toBe("612px");
    const seen: [string, unknown[]][] = [];
    early()!.take((event, args) => seen.push([event, args]));
    say({ event: "state", state: "ready" });
    expect(seen).toEqual([
      ["state", ["loading"]],
      ["payment-error", [{ message: "Carte refusée", code: "card_declined" }]],
      ["state", ["ready"]],
    ]);
    // Gone with its slot: Whop's script lets the frame go.
    document.body.innerHTML = "";
    await tick();
    expect((win().wco?.frames as Map<unknown, unknown>).size).toBe(0);
  });
});

describe("the script itself", () => {
  it("is ES5 and never breaks out of the <script>", () => {
    const src = inlineEarlyWhopScript({ sessionId: "</script><script>alert(1)</script>", attributes: [["data-x", "</script>\u2028"]], returnPath: "/c/x/merci?lang=fr", fit: whopFooterFitRuns("fr"), sdk: WHOP_SDK_PATH });
    expect(src).not.toContain("</script>");
    expect(src).not.toContain("\u2028");
    expect(() => parse(src, { ecmaVersion: 5, sourceType: "script" })).not.toThrow();
  });

  it("thankYouPath: CheckoutView's thank-you page path", () => {
    expect(thankYouPath("cs_1", "de", false)).toBe("/c/cs_1/merci?lang=de");
    expect(thankYouPath("cs_1", "de", true)).toBe("/c/cs_1/merci?lang=de&via=app");
  });
});
