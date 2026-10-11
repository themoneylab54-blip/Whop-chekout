// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { BOOT_FLAG, WATCH_FLAG, healthPath } from "@/components/checkout/inlineWatchdog";
import { LEFT_MIN_MS, SLOW_AFTER_MS, STUCK_AFTER_MS, paymentFormMissing, reportHealth, usePaymentWatchdog } from "@/components/checkout/paymentHealth";

/*
 * The page's own health reports: a beacon (a fetch with keepalive where there is none), never an
 * error, with the page's clock, visibility, connection and what the inline watchdog kept (its first
 * errors, the version). The watchdog hook marks the page started at once, then, once each per page:
 * a form missing for STUCK_AFTER_MS without a break is reported and asked again (never on a moment of
 * missing between two requests); a request on its way SLOW_AFTER_MS without a break is reported;
 * leaving the page without the form ever ready is reported (not a bounce under LEFT_MIN_MS). The
 * "missing" rule's every input is checked.
 */

type Win = Window & Record<string, unknown>;
let beacons: { url: string; body: Record<string, unknown> }[] = [];
beforeEach(() => {
  beacons = [];
  delete (window as unknown as Win)[BOOT_FLAG];
  delete (window as unknown as Win)[WATCH_FLAG];
  Object.defineProperty(navigator, "sendBeacon", {
    configurable: true,
    value: vi.fn((url: string, body: string) => {
      beacons.push({ url, body: JSON.parse(body) });
      return true;
    }),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("reportHealth", () => {
  it("a beacon to the session's health route: the report, the page's clock, visibility, connection", () => {
    reportHealth("cmsess1", { kind: "form_not_ready", waitedMs: 30_000, frame: true, lastState: "loading" });
    expect(beacons).toEqual([
      { url: healthPath("cmsess1"), body: { kind: "form_not_ready", waitedMs: 30_000, frame: true, lastState: "loading", t: expect.any(Number), visible: "visible", online: true } },
    ]);
  });

  it("carries what the inline watchdog kept (its first errors, the version)", () => {
    (window as unknown as Win)[WATCH_FLAG] = { errors: [{ res: "https://x/_next/a.js" }], dropped: 2, dpl: "dpl_abc" };
    reportHealth("cmsess1", { kind: "page_error", msg: "boom" });
    expect(beacons[0].body).toMatchObject({ kind: "page_error", msg: "boom", dpl: "dpl_abc", errors: [{ res: "https://x/_next/a.js" }], dropped: 2 });
  });

  it("a beacon refused or missing: the same report by fetch (keepalive); nothing ever thrown", () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: () => false });
    reportHealth("cmsess1", { kind: "page_error", msg: "boom" });
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: undefined });
    reportHealth("cmsess1", { kind: "page_error", msg: "boom" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(healthPath("cmsess1"), expect.objectContaining({ method: "POST", keepalive: true }));
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new TypeError("no fetch");
      }),
    );
    expect(() => reportHealth("cmsess1", { kind: "page_error", msg: "boom" })).not.toThrow();
  });
});

describe("paymentFormMissing", () => {
  const none = { prepared: false, preparing: false, qtyPending: false, prepareError: false, quoteBlocking: false, inFlightAtLoad: false, paypalActive: false };
  it("missing only when nothing shows it, brings it or explains its absence", () => {
    expect(paymentFormMissing(none)).toBe(true);
    for (const k of Object.keys(none) as (keyof typeof none)[]) expect(paymentFormMissing({ ...none, [k]: true })).toBe(false);
  });
});

describe("usePaymentWatchdog", () => {
  type S = { missing: boolean; preparing: boolean; formReady: boolean };
  const describeAs = (kind: "prepare_stuck" | "prepare_slow" | "left_without_form") => ({ kind, provider: "whop", prepared: false, preparing: false, quote: true, paypal: false });
  function Probe(p: S & { id: string | null; retry: () => void }) {
    usePaymentWatchdog(p.id, { missing: p.missing, preparing: p.preparing, formReady: p.formReady, describe: describeAs }, p.retry);
    return null;
  }
  const probe = (o: Partial<S & { id: string | null; retry: () => void }> = {}) =>
    h(Probe, { id: "cmsess1", missing: false, preparing: false, formReady: false, retry: () => undefined, ...o });

  it("marks the page started at once", () => {
    render(probe());
    expect((window as unknown as Win)[BOOT_FLAG]).toBe(true);
  });

  it("a form missing 12 s without a break: reported and asked again, once", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const { rerender } = render(probe({ missing: true, retry }));
    act(() => void vi.advanceTimersByTime(STUCK_AFTER_MS - 1));
    expect(beacons).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining({ kind: "prepare_stuck", provider: "whop" })]);
    expect(retry).toHaveBeenCalledTimes(1);
    // Missing again later: once per page.
    rerender(probe({ missing: false, retry }));
    rerender(probe({ missing: true, retry }));
    act(() => void vi.advanceTimersByTime(10 * STUCK_AFTER_MS));
    expect(beacons).toHaveLength(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("missing for moments between requests (a debounce, a retry): never reported", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const { rerender } = render(probe({ missing: true, retry }));
    for (let i = 0; i < 10; i++) {
      act(() => void vi.advanceTimersByTime(STUCK_AFTER_MS - 1_000));
      rerender(probe({ missing: false, preparing: true, retry }));
      act(() => void vi.advanceTimersByTime(300));
      rerender(probe({ missing: true, retry }));
    }
    expect(beacons.filter((b) => b.body.kind === "prepare_stuck")).toHaveLength(0);
    expect(retry).not.toHaveBeenCalled();
  });

  it("missing only after a while (a stall later on): still seen", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const { rerender } = render(probe({ missing: false, retry }));
    act(() => void vi.advanceTimersByTime(60_000));
    rerender(probe({ missing: true, retry }));
    act(() => void vi.advanceTimersByTime(STUCK_AFTER_MS));
    expect(beacons.map((b) => b.body.kind)).toEqual(["prepare_stuck"]);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("a request on its way 20 s without a break: reported, once; one that answers in time: nothing", () => {
    vi.useFakeTimers();
    const { rerender } = render(probe({ preparing: true }));
    act(() => void vi.advanceTimersByTime(SLOW_AFTER_MS - 1_000));
    rerender(probe({ preparing: false }));
    rerender(probe({ preparing: true }));
    act(() => void vi.advanceTimersByTime(SLOW_AFTER_MS - 1));
    expect(beacons).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(beacons.map((b) => b.body.kind)).toEqual(["prepare_slow"]);
    rerender(probe({ preparing: false }));
    rerender(probe({ preparing: true }));
    act(() => void vi.advanceTimersByTime(SLOW_AFTER_MS * 3));
    expect(beacons).toHaveLength(1);
  });

  it("leaving the page without the form ever ready: reported once; with the form ready, or a bounce: nothing", () => {
    const clock = vi.spyOn(performance, "now");
    clock.mockReturnValue(LEFT_MIN_MS - 1);
    const view = render(probe());
    window.dispatchEvent(new Event("pagehide"));
    expect(beacons).toHaveLength(0);
    clock.mockReturnValue(LEFT_MIN_MS + 1_000);
    window.dispatchEvent(new Event("pagehide"));
    window.dispatchEvent(new Event("pagehide"));
    expect(beacons.map((b) => b.body.kind)).toEqual(["left_without_form"]);
    view.unmount();
    beacons = [];
    render(probe({ formReady: true }));
    window.dispatchEvent(new Event("pagehide"));
    expect(beacons).toHaveLength(0);
  });

  it("no live session (a preview): never reported", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    render(probe({ id: null, missing: true, preparing: true, retry }));
    act(() => void vi.advanceTimersByTime(10 * SLOW_AFTER_MS));
    window.dispatchEvent(new Event("pagehide"));
    expect(beacons).toHaveLength(0);
    expect(retry).not.toHaveBeenCalled();
  });
});
