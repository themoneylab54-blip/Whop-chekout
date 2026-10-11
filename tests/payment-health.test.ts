// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { BOOT_FLAG, healthPath } from "@/components/checkout/inlineWatchdog";
import { STUCK_AFTER_MS, reportHealth, usePaymentWatchdog, type HealthReport } from "@/components/checkout/paymentHealth";

/*
 * The page's own health reports: a beacon (a fetch with keepalive where there is none), never an
 * error; the watchdog hook marks the page started at once (the inline watchdog stands down) and,
 * STUCK_AFTER_MS later, reports and asks again a payment form still missing then — once, and never
 * for a form shown, on its way or explained meanwhile, nor without a live session.
 */

let beacons: { url: string; body: Record<string, unknown> }[] = [];
beforeEach(() => {
  beacons = [];
  delete (window as unknown as Record<string, unknown>)[BOOT_FLAG];
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
  it("a beacon to the session's health route, with the page's time", () => {
    reportHealth("cmsess1", { kind: "form_not_ready", waitedMs: 30_000 });
    expect(beacons).toEqual([{ url: healthPath("cmsess1"), body: { kind: "form_not_ready", waitedMs: 30_000, t: expect.any(Number) } }]);
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

describe("usePaymentWatchdog", () => {
  const stuck: Extract<HealthReport, { kind: "prepare_stuck" }> = { kind: "prepare_stuck", provider: "whop", quote: true, paypal: false };
  function Probe(p: { id: string | null; missing: boolean; retry: () => void }) {
    usePaymentWatchdog(p.id, p.missing, () => stuck, p.retry);
    return null;
  }

  it("marks the page started at once", () => {
    render(h(Probe, { id: "cmsess1", missing: false, retry: () => undefined }));
    expect((window as unknown as Record<string, unknown>)[BOOT_FLAG]).toBe(true);
  });

  it("a form still missing 12 s after the page started: reported and asked again, once", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    render(h(Probe, { id: "cmsess1", missing: true, retry }));
    act(() => void vi.advanceTimersByTime(STUCK_AFTER_MS - 1));
    expect(beacons).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(beacons.map((b) => b.body)).toEqual([expect.objectContaining(stuck)]);
    expect(retry).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(10 * STUCK_AFTER_MS));
    expect(beacons).toHaveLength(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("shown, on its way or explained meanwhile: nothing", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const { rerender } = render(h(Probe, { id: "cmsess1", missing: true, retry }));
    act(() => void vi.advanceTimersByTime(STUCK_AFTER_MS / 2));
    rerender(h(Probe, { id: "cmsess1", missing: false, retry }));
    act(() => void vi.advanceTimersByTime(STUCK_AFTER_MS));
    expect(beacons).toHaveLength(0);
    expect(retry).not.toHaveBeenCalled();
  });

  it("missing only before (a prepare between): judged on the state at 12 s", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const { rerender } = render(h(Probe, { id: "cmsess1", missing: false, retry }));
    act(() => void vi.advanceTimersByTime(STUCK_AFTER_MS - 100));
    rerender(h(Probe, { id: "cmsess1", missing: true, retry }));
    act(() => void vi.advanceTimersByTime(100));
    expect(beacons).toHaveLength(1);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("no live session (a preview): never reported", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    render(h(Probe, { id: null, missing: true, retry }));
    act(() => void vi.advanceTimersByTime(10 * STUCK_AFTER_MS));
    expect(beacons).toHaveLength(0);
    expect(retry).not.toHaveBeenCalled();
  });
});
