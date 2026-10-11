// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { ERROR_SCREEN_FLAG, healthPath } from "@/components/checkout/inlineWatchdog";
import { labelsFor, pickLang } from "@/components/checkout/i18n";

/*
 * The checkout's error screen (app/c/[id]/error): in the browser's language with its own texts, it
 * stands the page's watchdog down (no reload over it) and reports itself on the checkout page only
 * (the thank-you page's errors lose no payment), with the error's message cut short and its digest.
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const { default: CheckoutError } = await import("@/app/c/[id]/error");

let beacons: { url: string; body: Record<string, unknown> }[] = [];
beforeEach(() => {
  beacons = [];
  delete (window as unknown as Record<string, unknown>)[ERROR_SCREEN_FLAG];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
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
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
});

const boom = Object.assign(new Error("x".repeat(500)), { digest: "1234" });

describe("the checkout's error screen", () => {
  it("on the checkout page: shown, the watchdog stood down, reported (message cut short, digest)", () => {
    window.history.pushState({}, "", "/c/cmv3o4asm000pia06oes69f3i");
    render(h(CheckoutError, { error: boom, reset: () => undefined }));
    expect(screen.getByText(labelsFor(pickLang(navigator.languages)).errorTitle)).toBeTruthy();
    expect((window as unknown as Record<string, unknown>)[ERROR_SCREEN_FLAG]).toBe(true);
    expect(beacons).toEqual([{ url: healthPath("cmv3o4asm000pia06oes69f3i"), body: expect.objectContaining({ kind: "page_error", msg: "x".repeat(300), digest: "1234" }) }]);
  });

  it("on the thank-you page: shown, never reported", () => {
    window.history.pushState({}, "", "/c/cmv3o4asm000pia06oes69f3i/merci");
    render(h(CheckoutError, { error: boom, reset: () => undefined }));
    expect(screen.getByText(labelsFor(pickLang(navigator.languages)).retry)).toBeTruthy();
    expect(beacons).toHaveLength(0);
  });

  it("a malformed address: shown, nothing thrown, nothing reported", () => {
    window.history.pushState({}, "", "/c/%E0%A4%A");
    expect(() => render(h(CheckoutError, { error: boom, reset: () => undefined }))).not.toThrow();
    expect(beacons).toHaveLength(0);
  });
});
