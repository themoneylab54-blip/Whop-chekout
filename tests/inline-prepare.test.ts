// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INLINE_WAIT_MS, firstPrepareBody, inlinePrepareScript, isInlineTimeout, prepareBody, takeInlinePrepare } from "@/components/checkout/inlinePrepare";
import { firstLoadInput } from "@/lib/early-prepare";
import { quoteSchema } from "@/lib/checkout";

/*
 * The page's first /prepare sent by an inline script while the HTML is parsed: the body the server
 * writes and the one the page builds are the same string (fixed key order, undefined keys left out),
 * and the same input as the server's own early prepare; the script asks the session's own prepare
 * route at once; the page takes that answer only for the same session and the same body, within 30 s,
 * as a Response (status, text, request id), and it is gone once looked at; a network failure is a
 * rejection (the page then asks itself); values never break out of the <script>.
 */

vi.mock("@/lib/db", () => ({ db: {} }));

type Win = Window & { __wcPrepare?: unknown };
const win = () => window as unknown as Win;

let calls: { url: string; init: RequestInit }[] = [];
beforeEach(() => {
  calls = [];
  win().__wcPrepare = undefined;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const answer = (status: number, text: string, ref = "iad1::abc") =>
  vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(text, { status, headers: { "x-request-id": ref } });
  });

describe("prepareBody / firstPrepareBody", () => {
  it("one string for one input: keys in a fixed order, undefined ones left out (as the page always sent them)", () => {
    expect(firstPrepareBody("FR", undefined)).toBe('{"countryCode":"FR","shippingRateId":null,"discountCode":null,"addOnIds":[]}');
    expect(firstPrepareBody("BE", false)).toBe('{"countryCode":"BE","shippingRateId":null,"discountCode":null,"addOnIds":[],"protection":false}');
    expect(prepareBody({ addOnIds: ["a"], protection: true, discountCode: "X", shippingRateId: "r", countryCode: "BE" })).toBe(
      '{"countryCode":"BE","shippingRateId":"r","discountCode":"X","addOnIds":["a"],"protection":true}',
    );
    expect(prepareBody({ countryCode: "FR", shippingRateId: null, discountCode: null, addOnIds: [], protection: false, quantities: { v1: 2 }, clientFailed: "stripe" })).toBe(
      '{"countryCode":"FR","shippingRateId":null,"discountCode":null,"addOnIds":[],"protection":false,"quantities":{"v1":2},"clientFailed":"stripe"}',
    );
  });

  it("the inline body is the server's early prepare input (one Whop checkout for all three)", () => {
    for (const [country, protection] of [["FR", undefined], ["DE", true], ["BE", false]] as const) {
      expect(quoteSchema.parse(JSON.parse(firstPrepareBody(country, protection)))).toEqual(firstLoadInput(country, protection));
    }
  });
});

describe("the inline script and the page's first prepare", () => {
  const body = firstPrepareBody("FR", false);

  it("asks the session's prepare route at once; the page takes its answer (same session, same body), once", async () => {
    vi.stubGlobal("fetch", answer(200, '{"provider":"whop","checkoutConfigurationId":"ch_1"}'));
    new Function(inlinePrepareScript("cmsess1", body))();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/public/sessions/cmsess1/prepare");
    expect(calls[0].init).toMatchObject({ method: "POST", body, headers: { "Content-Type": "application/json" } });
    const res = await takeInlinePrepare("cmsess1", body)!;
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("iad1::abc");
    expect(await res.json()).toEqual({ provider: "whop", checkoutConfigurationId: "ch_1" });
    // Once: a retry asks the server afresh.
    expect(takeInlinePrepare("cmsess1", body)).toBeNull();
  });

  it("another session, another body, or an answer over 30 s old: not taken, and gone all the same", () => {
    vi.stubGlobal("fetch", answer(200, "{}"));
    new Function(inlinePrepareScript("cmsess1", body))();
    expect(takeInlinePrepare("cmsess2", body)).toBeNull();
    expect(takeInlinePrepare("cmsess1", body)).toBeNull();
    new Function(inlinePrepareScript("cmsess1", body))();
    expect(takeInlinePrepare("cmsess1", firstPrepareBody("BE", false))).toBeNull();
    expect(takeInlinePrepare("cmsess1", body)).toBeNull();
    new Function(inlinePrepareScript("cmsess1", body))();
    expect(takeInlinePrepare("cmsess1", body, Date.now() + 30_001)).toBeNull();
  });

  it("an error answer is handed over as is (the page's retry rules apply); a network failure rejects (the page asks itself)", async () => {
    vi.stubGlobal("fetch", answer(503, '{"code":"session_changed"}', "iad1::err"));
    new Function(inlinePrepareScript("cmsess1", body))();
    const res = await takeInlinePrepare("cmsess1", body)!;
    expect(res.status).toBe(503);
    expect(res.headers.get("x-request-id")).toBe("iad1::err");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    new Function(inlinePrepareScript("cmsess1", body))();
    await expect(takeInlinePrepare("cmsess1", body)!).rejects.toThrow();
  });

  it("never breaks out of the <script> tag, whatever the values", () => {
    const evil = prepareBody({ countryCode: "</script><script>alert(1)</script>", shippingRateId: "\u2028", discountCode: null, addOnIds: [] });
    const src = inlinePrepareScript("</script>", evil);
    expect(src).not.toContain("</script>");
    expect(src).not.toMatch(/[\u2028\u2029]/);
    vi.stubGlobal("fetch", answer(200, "{}"));
    new Function(src)();
    expect(calls[0].url).toBe("/api/public/sessions/%3C%2Fscript%3E/prepare");
    expect(calls[0].init.body).toBe(evil);
  });

  it("a page without the script asks the server itself", () => {
    expect(takeInlinePrepare("cmsess1", body)).toBeNull();
  });

  it("an answer still not in INLINE_WAIT_MS after the request was sent: given up (the page asks itself)", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    new Function(inlinePrepareScript("cmsess1", body))();
    // The page looks at it 20 s after the request left (a slow phone): the limit still counts from the request.
    await vi.advanceTimersByTimeAsync(20_000);
    const taken = takeInlinePrepare("cmsess1", body)!;
    const settled = vi.fn();
    taken.then(settled, settled);
    await vi.advanceTimersByTimeAsync(INLINE_WAIT_MS - 20_000 - 1);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const err = await taken.catch((e: unknown) => e);
    expect(isInlineTimeout(err)).toBe(true);
    // Past the prepare function's 60 s: the server's own request is over when the page asks again.
    expect(INLINE_WAIT_MS).toBeGreaterThan(60_000);
  });

  it("a network failure is not taken for that give-up", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    new Function(inlinePrepareScript("cmsess1", body))();
    const err = await takeInlinePrepare("cmsess1", body)!.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect(isInlineTimeout(err)).toBe(false);
  });

  it("an answer in time: taken, the limit gone with it", async () => {
    vi.useFakeTimers();
    let answerNow: (r: Response) => void = () => undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => (answerNow = resolve))));
    new Function(inlinePrepareScript("cmsess1", body))();
    const taken = takeInlinePrepare("cmsess1", body)!;
    await vi.advanceTimersByTimeAsync(INLINE_WAIT_MS - 1_000);
    answerNow(new Response('{"ok":true}', { status: 200 }));
    const res = await taken;
    expect(await res.json()).toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
