// @vitest-environment jsdom
import { parse } from "acorn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_FLAG,
  ERROR_SCREEN_FLAG,
  RELOAD_MARK,
  WATCH_FLAG,
  WATCHDOG_AFTER_LOAD_MS,
  WATCHDOG_STILL_LOADING_MS,
  WATCH_MAX_ERRORS,
  healthPath,
  inlineWatchdogScript,
} from "@/components/checkout/inlineWatchdog";
import { firstPrepareBody, inlinePrepareScript } from "@/components/checkout/inlinePrepare";

/*
 * The checkout page's inline watchdog: a page whose scripts never started 10 s (visible) after it
 * loaded is reloaded once per session in the tab and reported at that moment, never twice (the next
 * load only reports, and says once when it started after all); never over a page that started
 * meanwhile (said to the logs), nor while the buyer is in a field or in Whop's form (it waits for
 * them to leave it; a buyer leaving first is reported, no reload done); the error screen stands it
 * down; a page that started says nothing; time in the background never counts; a page still loading
 * after 25 s is reported, never reloaded. Reports carry the page's first errors (the root cause
 * first), its scripts answered with an HTTP error, the version that served it, the page's own clock.
 * Both inline scripts are ES5 and never break out of the <script>.
 */

type Win = Window & Record<string, unknown>;
const win = () => window as unknown as Win;

let beacons: { url: string; body: Record<string, unknown> }[] = [];
let reload: ReturnType<typeof vi.fn>;
let readyState: DocumentReadyState;
let visibility: DocumentVisibilityState;
let resources: Partial<PerformanceResourceTiming>[];
const realLocation = window.location;
// Each test's script starts from a clean page: the listeners it added (on the window, through the
// global addEventListener, and on the document) go with it.
type Added = { target: EventTarget; args: Parameters<EventTarget["addEventListener"]> };
let added: Added[] = [];
const realWindowAdd = globalThis.addEventListener;
const track = (target: EventTarget, add: EventTarget["addEventListener"]) =>
  function (...args: Parameters<EventTarget["addEventListener"]>) {
    added.push({ target, args });
    return add.apply(target, args);
  };

beforeEach(() => {
  added = [];
  globalThis.addEventListener = track(window, realWindowAdd) as typeof globalThis.addEventListener;
  document.addEventListener = track(document, EventTarget.prototype.addEventListener) as typeof document.addEventListener;
  vi.useFakeTimers();
  beacons = [];
  readyState = "loading";
  visibility = "visible";
  resources = [];
  delete win()[BOOT_FLAG];
  delete win()[ERROR_SCREEN_FLAG];
  delete win()[WATCH_FLAG];
  sessionStorage.clear();
  document.body.innerHTML = "";
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: vi.fn((url: string, body: string) => {
      beacons.push({ url, body: JSON.parse(body) });
      return true;
    }),
  });
  reload = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, value: { ...realLocation, reload } });
  vi.spyOn(document, "readyState", "get").mockImplementation(() => readyState);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  vi.spyOn(performance, "getEntriesByType").mockImplementation(() => resources as PerformanceEntryList);
});
afterEach(() => {
  for (const { target, args } of added) target.removeEventListener(args[0], args[1], args[2]);
  globalThis.addEventListener = realWindowAdd;
  delete (document as unknown as Record<string, unknown>).addEventListener;
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(window, "location", { configurable: true, value: realLocation });
});

const run = (id = "cmsess1", dpl: string | null = "dpl_abc") => new Function(inlineWatchdogScript(id, dpl))();
const loaded = () => {
  readyState = "complete";
  window.dispatchEvent(new Event("load"));
};

describe("the checkout page's inline watchdog", () => {
  it("a page that never started 10 s after loading: reloaded once, reported at the reload", () => {
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS);
    // Decided, the reload 300 ms later: the report goes with it.
    expect(beacons).toHaveLength(0);
    expect(sessionStorage.getItem(`${RELOAD_MARK}cmsess1`)).toBe("1");
    vi.advanceTimersByTime(299);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(beacons).toHaveLength(1);
    expect(beacons[0].url).toBe(healthPath("cmsess1"));
    expect(beacons[0].body).toEqual({
      kind: "not_booted",
      t: expect.any(Number),
      state: "complete",
      visible: "visible",
      afterReload: false,
      reloading: true,
      typed: false,
      dpl: "dpl_abc",
      errors: [],
      dropped: 0,
      failed: [],
    });
    vi.advanceTimersByTime(60_000);
    expect(beacons).toHaveLength(1);
  });

  it("the page started between the decision and the reload: no reload, said to the logs, the mark taken back", () => {
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS);
    win()[BOOT_FLAG] = true;
    vi.advanceTimersByTime(300);
    expect(reload).not.toHaveBeenCalled();
    expect(beacons.map((b) => b.body.kind)).toEqual(["started_late"]);
    expect(sessionStorage.getItem(`${RELOAD_MARK}cmsess1`)).toBeNull();
  });

  it("the buyer in a field: no reload until they leave it (and the page still hasn't started), reported then", () => {
    document.body.innerHTML = '<input id="email" value="">';
    const field = document.getElementById("email") as HTMLInputElement;
    run();
    loaded();
    field.focus();
    field.value = "ana@exemple.fr";
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 60_000);
    expect(reload).not.toHaveBeenCalled();
    expect(beacons).toHaveLength(0);
    field.blur();
    document.dispatchEvent(new FocusEvent("focusout"));
    vi.advanceTimersByTime(999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "not_booted", reloading: true, typed: true })]);
  });

  it("the buyer in Whop's form (a frame, opened before the page's scripts): no reload until they leave it", () => {
    document.body.innerHTML = '<iframe id="whop" title="Whop Embedded Checkout"></iframe>';
    const frame = document.getElementById("whop") as HTMLIFrameElement;
    run();
    loaded();
    vi.spyOn(document, "activeElement", "get").mockImplementation(() => frame);
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 60_000);
    expect(reload).not.toHaveBeenCalled();
    // Back on the page: a browser fires no focusout for a frame left (cross-origin), only the window's focus.
    vi.spyOn(document, "activeElement", "get").mockImplementation(() => document.body);
    window.dispatchEvent(new FocusEvent("focus"));
    vi.advanceTimersByTime(999);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "not_booted", reloading: true })]);
  });

  it("the buyer leaves the page while the reload waits on their field: reported, no reload done", () => {
    document.body.innerHTML = '<input id="email" value="">';
    (document.getElementById("email") as HTMLInputElement).focus();
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
    window.dispatchEvent(new Event("pagehide"));
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "not_booted", reloading: false, left: true })]);
    expect(sessionStorage.getItem(`${RELOAD_MARK}cmsess1`)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("the page started while the reload waited on the buyer's field, then they left from it: said started late, never \"not started\"", () => {
    document.body.innerHTML = '<input id="email" value="">';
    (document.getElementById("email") as HTMLInputElement).focus();
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
    win()[BOOT_FLAG] = true;
    window.dispatchEvent(new Event("pagehide"));
    expect(beacons.map((b) => b.body.kind)).toEqual(["started_late"]);
    expect(sessionStorage.getItem(`${RELOAD_MARK}cmsess1`)).toBeNull();
    // Back from the cache: a started page, nothing more.
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS * 3);
    expect(beacons.map((b) => b.body.kind)).toEqual(["started_late"]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("that page brought back as it was (the back-forward cache), still not started: decided again, reloaded", () => {
    document.body.innerHTML = '<input id="email" value="">';
    const field = document.getElementById("email") as HTMLInputElement;
    field.focus();
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
    window.dispatchEvent(new Event("pagehide"));
    // Back: the page as it was, its field no longer in use.
    field.blur();
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 1_300);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(beacons.map((b) => [b.body.kind, b.body.reloading, b.body.left])).toEqual([
      ["not_booted", false, true],
      ["not_booted", true, undefined],
    ]);
    expect(sessionStorage.getItem(`${RELOAD_MARK}cmsess1`)).toBe("1");
  });

  it("a page brought back from that cache otherwise (started, or no reload given up): nothing more", () => {
    run();
    loaded();
    win()[BOOT_FLAG] = true;
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS);
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS * 3);
    expect(beacons).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it("left the field, but the page started meanwhile: no reload", () => {
    document.body.innerHTML = '<input id="email" value="">';
    const field = document.getElementById("email") as HTMLInputElement;
    run();
    loaded();
    field.focus();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
    win()[BOOT_FLAG] = true;
    field.blur();
    document.dispatchEvent(new FocusEvent("focusout"));
    vi.advanceTimersByTime(5_000);
    expect(reload).not.toHaveBeenCalled();
    expect(beacons.map((b) => b.body.kind)).toEqual(["started_late"]);
  });

  it("the load after that reload: reported again, never reloaded a second time; another session's page still gets its own", () => {
    sessionStorage.setItem(`${RELOAD_MARK}cmsess1`, "1");
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 1_000);
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "not_booted", afterReload: true, reloading: false })]);
    expect(reload).not.toHaveBeenCalled();
    beacons = [];
    run("cmsess2");
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
    expect(beacons.map((b) => [b.body.afterReload, b.body.reloading])).toEqual([[false, true]]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the load after that reload started: says so (recovered), once; the later loads of that tab say nothing", () => {
    sessionStorage.setItem(`${RELOAD_MARK}cmsess1`, "1");
    run();
    win()[BOOT_FLAG] = true;
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS * 3);
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "recovered", afterReload: true })]);
    expect(sessionStorage.getItem(`${RELOAD_MARK}cmsess1`)).toBe("2");
    beacons = [];
    run();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS * 3);
    expect(beacons).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it("a page that started (CheckoutView mounted), or the error screen shown: nothing sent, nothing reloaded", () => {
    run();
    win()[BOOT_FLAG] = true;
    loaded();
    vi.advanceTimersByTime(WATCHDOG_STILL_LOADING_MS + WATCHDOG_AFTER_LOAD_MS);
    expect(beacons).toHaveLength(0);
    delete win()[BOOT_FLAG];
    run("cmsess2");
    win()[ERROR_SCREEN_FLAG] = true;
    vi.advanceTimersByTime(WATCHDOG_STILL_LOADING_MS + WATCHDOG_AFTER_LOAD_MS);
    expect(beacons).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it("started late but within the 10 s: nothing", () => {
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS - 100);
    win()[BOOT_FLAG] = true;
    vi.advanceTimersByTime(60_000);
    expect(beacons).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });

  it("only the time the page is visible counts (a phone suspends a page in the background)", () => {
    run();
    loaded();
    vi.advanceTimersByTime(4_000);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(10 * 60_000);
    expect(beacons).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS - 4_000 - 1);
    expect(sessionStorage.getItem(`${RELOAD_MARK}cmsess1`)).toBeNull();
    vi.advanceTimersByTime(1 + 300);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(beacons.map((b) => b.body.kind)).toEqual(["not_booted"]);
  });

  it("back in view and started meanwhile: nothing", () => {
    run();
    loaded();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS * 5);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    win()[BOOT_FLAG] = true;
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS * 2);
    expect(beacons).toHaveLength(0);
  });

  it("still loading after 25 s: reported, never reloaded; once loaded, the usual 10 s apply", () => {
    run();
    vi.advanceTimersByTime(WATCHDOG_STILL_LOADING_MS);
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "still_loading", state: "loading" })]);
    vi.advanceTimersByTime(60_000);
    expect(beacons).toHaveLength(1);
    expect(reload).not.toHaveBeenCalled();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
    expect(beacons.map((b) => b.body.kind)).toEqual(["still_loading", "not_booted"]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("the browser's storage blocked: reported at once (no reload: no way to do it only once)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS);
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "not_booted", afterReload: null, reloading: false })]);
    vi.advanceTimersByTime(1_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("keeps the page's first errors (the root cause), counts the rest, and its scripts answered with an HTTP error", () => {
    run();
    const script = document.createElement("script");
    script.src = "https://app.test/_next/static/chunks/abc.js";
    document.head.appendChild(script);
    script.dispatchEvent(new Event("error"));
    for (let i = 0; i < 6; i++) window.dispatchEvent(new ErrorEvent("error", { message: `boom ${i} ${"x".repeat(300)}`, filename: "https://app.test/_next/static/chunks/def.js", lineno: 7 }));
    window.dispatchEvent(new ErrorEvent("error", { message: "no file" }));
    resources = [
      { name: "https://app.test/_next/static/chunks/abc.js", initiatorType: "script", responseStatus: 404 },
      { name: "https://app.test/_next/static/chunks/ok.js", initiatorType: "script", responseStatus: 200 },
      { name: "https://app.test/logo.png", initiatorType: "img", responseStatus: 404 },
    ];
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
    const body = beacons[0].body as { errors: Record<string, string>[]; dropped: number; failed: unknown[] };
    expect(body.errors).toHaveLength(WATCH_MAX_ERRORS);
    expect(body.errors[0]).toEqual({ res: "https://app.test/_next/static/chunks/abc.js" });
    expect(body.errors[1]).toEqual({ msg: expect.stringMatching(/^boom 0 x+$/), at: "https://app.test/_next/static/chunks/def.js:7" });
    expect(body.errors[1].msg.length).toBe(160);
    expect(body.dropped).toBe(3);
    expect(body.failed).toEqual([{ res: "https://app.test/_next/static/chunks/abc.js", status: 404 }]);
    // The same, for the page's own reports.
    expect(win()[WATCH_FLAG]).toEqual({ errors: body.errors, dropped: 3, dpl: "dpl_abc" });
  });

  it("an error without a file: no made-up place", () => {
    run();
    window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }));
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
    expect((beacons[0].body as { errors: unknown[] }).errors).toEqual([{ msg: "Script error." }]);
  });

  it("no beacon in this browser: the same report through fetch (keepalive)", () => {
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: undefined });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      run();
      loaded();
      vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
      expect(fetchMock).toHaveBeenCalledWith(healthPath("cmsess1"), expect.objectContaining({ method: "POST", keepalive: true }));
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ kind: "not_booted" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never breaks out of the <script> tag, whatever the session id or the version", () => {
    const evil = "</script><script>alert(1)</script>\u2028";
    const src = inlineWatchdogScript(evil, evil);
    expect(src).not.toContain("</script>");
    expect(src).not.toMatch(/[\u2028\u2029]/);
    new Function(src)();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
    expect(beacons[0].url).toBe(healthPath(evil));
    expect(beacons[0].body.dpl).toBe(evil);
  });

  it("both inline scripts are ES5 (the oldest browsers a buyer may use still run them)", () => {
    const es5 = (code: string) => parse(code, { ecmaVersion: 5, sourceType: "script" });
    expect(() => es5(inlineWatchdogScript("cmsess1", "dpl_abc"))).not.toThrow();
    expect(() => es5(inlineWatchdogScript("cmsess1", null))).not.toThrow();
    expect(() => es5(inlinePrepareScript("cmsess1", firstPrepareBody("FR", false)))).not.toThrow();
    // The check itself refuses later syntax.
    expect(() => es5("var f = () => 1;")).toThrow();
  });
});

describe("loaded: the window's load event, or the page's HTML read and its own scripts all in", () => {
  // Whop's form opened before the page's scripts (see inlineEarlyWhop) holds the window's load event
  // back until its frame has loaded: the page's start never waits on it.
  const script = (name: string, o: { noModule?: boolean } = {}) => {
    const s = document.createElement("script");
    s.src = `https://app.test/_next/static/chunks/${name}`;
    // A browser that runs modules (jsdom has no noModule): it never fetches a nomodule script.
    if (o.noModule) Object.defineProperty(s, "noModule", { configurable: true, value: true });
    document.head.appendChild(s);
    return s;
  };
  const fetched = (s: HTMLScriptElement) => ({ name: s.src, initiatorType: "script", responseStatus: 200 });
  const reloadMark = () => sessionStorage.getItem(`${RELOAD_MARK}cmsess1`);
  // Only this test's scripts in the page (an earlier test's one would never be in).
  const clear = () => {
    for (const s of document.head.querySelectorAll("script")) s.remove();
  };
  beforeEach(clear);
  afterEach(clear);

  it("each script fetched or failed (a nomodule one never fetched), the load event held back: decided 10 s later", () => {
    run();
    const a = script("a.js");
    const b = script("b.js");
    const c = script("c.js");
    script("polyfills.js", { noModule: true });
    readyState = "interactive";
    resources = [fetched(a)];
    c.dispatchEvent(new Event("error"));
    // b.js still on its way: not loaded, however long it takes.
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS * 2);
    expect(reloadMark()).toBeNull();
    resources = [fetched(a), fetched(b)];
    vi.advanceTimersByTime(500 + WATCHDOG_AFTER_LOAD_MS - 1);
    expect(reloadMark()).toBeNull();
    vi.advanceTimersByTime(1 + 300);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(beacons.map((x) => x.body)).toEqual([expect.objectContaining({ kind: "not_booted", state: "interactive", reloading: true })]);
  });

  it("the page's HTML still being read: not loaded, whatever its scripts (reported at 25 s, never reloaded)", () => {
    run();
    resources = [fetched(script("a.js"))];
    vi.advanceTimersByTime(WATCHDOG_STILL_LOADING_MS);
    expect(beacons.map((x) => x.body)).toEqual([expect.objectContaining({ kind: "still_loading", state: "loading" })]);
    vi.advanceTimersByTime(60_000);
    expect(reload).not.toHaveBeenCalled();
  });

  it("its scripts all in at 20 s, the load event still held back: no 'still loading' at 25 s, decided at 30 s", () => {
    run();
    const a = script("a.js");
    readyState = "interactive";
    vi.advanceTimersByTime(20_000);
    resources = [fetched(a)];
    vi.advanceTimersByTime(500 + WATCHDOG_AFTER_LOAD_MS + 300);
    expect(beacons.map((x) => x.body.kind)).toEqual(["not_booted"]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("its scripts all in, then the load event: one decision", () => {
    run();
    readyState = "interactive";
    vi.advanceTimersByTime(500);
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS * 3);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(beacons).toHaveLength(1);
  });

  it("loaded once: its scripts in, then the load event later — a page brought back from the cache still waits its full 10 s", () => {
    document.body.innerHTML = '<input id="email" value="">';
    const field = document.getElementById("email") as HTMLInputElement;
    field.focus();
    run();
    readyState = "interactive";
    // Loaded at 0.5 s (its scripts in), the load event at 6 s (Whop's frame loaded at last): armed once.
    vi.advanceTimersByTime(6_000);
    loaded();
    // Decided at 10.5 s, the reload waiting on the buyer's field; they leave the page, then come back.
    vi.advanceTimersByTime(4_800);
    window.dispatchEvent(new Event("pagehide"));
    field.blur();
    vi.advanceTimersByTime(1_200);
    window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS - 1);
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1 + 300);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("its scripts no longer looked at once the page started", () => {
    run();
    script("a.js");
    readyState = "interactive";
    vi.advanceTimersByTime(1_000);
    const looks = vi.mocked(performance.getEntriesByType).mock.calls.length;
    expect(looks).toBeGreaterThan(0);
    win()[BOOT_FLAG] = true;
    vi.advanceTimersByTime(5_000);
    expect(vi.mocked(performance.getEntriesByType).mock.calls.length).toBe(looks);
  });

  it("the page started in the meantime: nothing", () => {
    run();
    resources = [fetched(script("a.js"))];
    readyState = "interactive";
    vi.advanceTimersByTime(500);
    win()[BOOT_FLAG] = true;
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS * 3);
    expect(beacons).toHaveLength(0);
    expect(reload).not.toHaveBeenCalled();
  });
});
