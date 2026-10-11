// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BOOT_FLAG, RELOAD_MARK, WATCHDOG_AFTER_LOAD_MS, WATCHDOG_STILL_LOADING_MS, healthPath, inlineWatchdogScript } from "@/components/checkout/inlineWatchdog";

/*
 * The checkout page's inline watchdog: a page whose scripts never started 10 s after it loaded is
 * reported (a beacon) and reloaded once per session in the tab, never twice (the next load only
 * reports); a page that started says nothing; a page in the background waits to be shown; a page
 * still loading after 25 s is reported, never reloaded; the report carries the page's first errors and
 * its scripts that answered an HTTP error; values never break out of the <script>.
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
  sessionStorage.clear();
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

const run = (id = "cmsess1") => new Function(inlineWatchdogScript(id))();
const loaded = () => {
  readyState = "complete";
  window.dispatchEvent(new Event("load"));
};

describe("the checkout page's inline watchdog", () => {
  it("a page that never started 10 s after loading: reported, then reloaded once", () => {
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS - 1);
    expect(beacons).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(beacons).toHaveLength(1);
    expect(beacons[0].url).toBe(healthPath("cmsess1"));
    expect(beacons[0].body).toMatchObject({ kind: "not_booted", state: "complete", visible: "visible", afterReload: false, errors: [], failed: [] });
    expect(sessionStorage.getItem(`${RELOAD_MARK}cmsess1`)).toBe("1");
    expect(reload).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(reload).toHaveBeenCalledTimes(1);
    // Nothing more from this load.
    vi.advanceTimersByTime(60_000);
    expect(beacons).toHaveLength(1);
  });

  it("the load after that reload: reported again, never reloaded a second time", () => {
    sessionStorage.setItem(`${RELOAD_MARK}cmsess1`, "1");
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 1_000);
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "not_booted", afterReload: true })]);
    expect(reload).not.toHaveBeenCalled();
    // Another session's page in the same tab still gets its own reload.
    beacons = [];
    run("cmsess2");
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 300);
    expect(beacons.map((b) => b.body.afterReload)).toEqual([false]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("a page that started (CheckoutView mounted): nothing sent, nothing reloaded", () => {
    run();
    win()[BOOT_FLAG] = true;
    loaded();
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

  it("a page in the background waits to be shown again (then 3 s more to start)", () => {
    run();
    loaded();
    visibility = "hidden";
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 60_000);
    expect(beacons).toHaveLength(0);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(2_999);
    expect(beacons).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(beacons.map((b) => b.body.kind)).toEqual(["not_booted"]);
    vi.advanceTimersByTime(300);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("shown again and started meanwhile: nothing", () => {
    run();
    loaded();
    visibility = "hidden";
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    win()[BOOT_FLAG] = true;
    vi.advanceTimersByTime(10_000);
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

  it("the browser's storage blocked: reported, never reloaded (no way to do it only once)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    run();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS + 1_000);
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "not_booted", afterReload: null })]);
    expect(reload).not.toHaveBeenCalled();
  });

  it("the report carries the page's first errors (5 at most, cut short) and its scripts answered with an HTTP error", () => {
    run();
    const script = document.createElement("script");
    script.src = "https://app.test/_next/static/chunks/abc.js";
    document.head.appendChild(script);
    script.dispatchEvent(new Event("error"));
    for (let i = 0; i < 6; i++) window.dispatchEvent(new ErrorEvent("error", { message: `boom ${i} ${"x".repeat(300)}`, filename: "https://app.test/_next/static/chunks/def.js", lineno: 7 }));
    resources = [
      { name: "https://app.test/_next/static/chunks/abc.js", initiatorType: "script", responseStatus: 404 },
      { name: "https://app.test/_next/static/chunks/ok.js", initiatorType: "script", responseStatus: 200 },
      { name: "https://app.test/logo.png", initiatorType: "img", responseStatus: 404 },
    ];
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS);
    const body = beacons[0].body as { errors: Record<string, string>[]; failed: unknown[] };
    expect(body.errors).toHaveLength(5);
    expect(body.errors[0]).toEqual({ msg: expect.stringMatching(/^boom 1 x+$/), at: "https://app.test/_next/static/chunks/def.js:7" });
    expect(body.errors[0].msg.length).toBe(160);
    expect(body.failed).toEqual([{ res: "https://app.test/_next/static/chunks/abc.js", status: 404 }]);
  });

  it("a failed script load is noted as such (the first errors kept)", () => {
    run();
    const link = document.createElement("link");
    link.href = "https://app.test/_next/static/chunks/x.css";
    document.head.appendChild(link);
    link.dispatchEvent(new Event("error"));
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS);
    expect((beacons[0].body as { errors: unknown[] }).errors).toEqual([{ res: "https://app.test/_next/static/chunks/x.css" }]);
  });

  it("no beacon in this browser: the same report through fetch (keepalive)", () => {
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: undefined });
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      run();
      loaded();
      vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS);
      expect(fetchMock).toHaveBeenCalledWith(healthPath("cmsess1"), expect.objectContaining({ method: "POST", keepalive: true }));
      expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ kind: "not_booted" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never breaks out of the <script> tag, whatever the session id", () => {
    const src = inlineWatchdogScript("</script><script>alert(1)</script>\u2028");
    expect(src).not.toContain("</script>");
    expect(src).not.toMatch(/[\u2028\u2029]/);
    new Function(src)();
    loaded();
    vi.advanceTimersByTime(WATCHDOG_AFTER_LOAD_MS);
    expect(beacons[0].url).toBe(healthPath("</script><script>alert(1)</script>\u2028"));
  });
});
