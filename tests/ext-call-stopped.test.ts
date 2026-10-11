import { afterEach, describe, expect, it, vi } from "vitest";

/*
 * An external call its caller stops on purpose (a hedged cart read whose other request answered
 * first) is no failure of the provider's: logged apart, never in the provider's metrics (its error
 * rate drives the "service degraded" alerts). A timeout or a network error still is one.
 */

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("@/lib/log", () => ({ log: { info: logs.info, warn: logs.warn, error: vi.fn() } }));
const { CallStopped, extFetch } = await import("@/lib/ext");

afterEach(() => {
  vi.unstubAllGlobals();
  logs.info.mockClear();
  logs.warn.mockClear();
});

const hanging = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn((_: string, init?: RequestInit) => new Promise<Response>((_r, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)))),
  );

describe("extFetch: a call stopped by its caller", () => {
  it("stopped with CallStopped: logged as ext.call_stopped, no ext.call line (no failure counted)", async () => {
    hanging();
    const ctl = new AbortController();
    const call = extFetch("shopify", "cart.js", "https://shop.example/cart.js", { signal: AbortSignal.any([AbortSignal.timeout(5_000), ctl.signal]) });
    ctl.abort(new CallStopped("another read answered first"));
    await expect(call).rejects.toBeInstanceOf(CallStopped);
    expect(logs.info).toHaveBeenCalledWith("ext.call_stopped", expect.any(String), expect.objectContaining({ provider: "shopify", op: "cart.js" }));
    expect(logs.warn).not.toHaveBeenCalled();
  });

  it("a timeout, a plain abort or a network error: an ext.call failure as before", async () => {
    hanging();
    await expect(extFetch("shopify", "cart.js", "https://shop.example/cart.js", { signal: AbortSignal.timeout(20) })).rejects.toThrow();
    const ctl = new AbortController();
    const call = extFetch("shopify", "cart.js", "https://shop.example/cart.js", { signal: ctl.signal });
    ctl.abort();
    await expect(call).rejects.toThrow();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(extFetch("shopify", "cart.js", "https://shop.example/cart.js")).rejects.toThrow("fetch failed");
    expect(logs.warn.mock.calls.map(([kind]) => kind)).toEqual(["ext.call", "ext.call", "ext.call"]);
    expect(logs.info).not.toHaveBeenCalled();
  });
});
