import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The checkout page's health reports (api/public/sessions/[id]/health), without a database: a report
 * from the page itself (same origin, with its Origin) of a hard failure becomes the store's
 * "checkout.form_missing" incident (each one journaled, no alert), with the page's known fields only,
 * cut short, and the browser; the softer signals go to the logs only. Another site's request, a
 * request without Origin, a malformed id, a flood or an oversized body is refused before any read; an
 * unknown session, a foreign host or a session over its quota is answered the same empty 204 without
 * anything recorded. The session is read once.
 */

const mocks = vi.hoisted(() => ({
  findSession: vi.fn<(args: unknown) => Promise<unknown>>(async () => ({ storeId: "st_1", store: { id: "st_1", checkoutDomain: null } })),
  foreign: vi.fn<(req: Request, store: unknown) => Promise<boolean>>(async () => false),
  rateLimit: vi.fn<(key: string, limit: number, windowMs?: number) => Promise<boolean>>(async () => true),
  recordIncident: vi.fn<(e: unknown) => Promise<void>>(async () => undefined),
  warn: vi.fn(),
}));

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
vi.mock("@/lib/db", () => ({ db: { checkoutSession: { findUnique: mocks.findSession } } }));
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
  withLogContext: (_fields: unknown, fn: () => unknown) => fn(),
  recordEvent: vi.fn(),
}));
vi.mock("@/lib/metrics", () => ({ flushProviderMetrics: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/checkout-domain-check", () => ({ isForeignCheckoutHost: mocks.foreign }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: mocks.rateLimit, clientIp: () => "10.1.2.3" }));
vi.mock("@/lib/incidents", () => ({ recordIncident: mocks.recordIncident }));

const { POST, healthReport } = await import("@/app/api/public/sessions/[id]/health/route");

const ID = "cmv3o4asm000pia06oes69f3i";
const PAGE = { host: "checkout.example.com", origin: "https://checkout.example.com", "sec-fetch-site": "same-origin", "content-type": "text/plain;charset=UTF-8", "user-agent": "Mozilla/5.0 (iPhone)" };
const send = (body: unknown, headers: Record<string, string | null> = {}, id = ID) => {
  const h = new Headers();
  for (const [k, v] of Object.entries({ ...PAGE, ...headers })) if (v !== null) h.set(k, v);
  return POST(new Request(`https://checkout.example.com/api/public/sessions/${id}/health`, { method: "POST", headers: h, body: typeof body === "string" ? body : JSON.stringify(body) }), {
    params: Promise.resolve({ id }),
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSession.mockImplementation(async () => ({ storeId: "st_1", store: { id: "st_1", checkoutDomain: null } }));
  mocks.foreign.mockImplementation(async () => false);
  mocks.rateLimit.mockImplementation(async () => true);
});

describe("healthReport (what the page said, its known fields only)", () => {
  it("a known kind: its fields kept, cut short and bounded; unknown fields dropped", () => {
    const r = healthReport({
      kind: "not_booted",
      t: 12_345.6,
      state: "complete",
      visible: "visible",
      online: true,
      afterReload: false,
      reloading: true,
      typed: false,
      dpl: "dpl_" + "x".repeat(100),
      errors: [{ res: "https://x/_next/a.js", extra: "no" }, { msg: "m".repeat(500), at: "f.js:1" }, "junk", null],
      dropped: 3,
      failed: [{ res: "https://x/_next/a.js", status: 404 }],
      email: "buyer@example.com",
    });
    expect(r).toEqual({
      kind: "not_booted",
      data: {
        what: "not_booted",
        t: 12_346,
        state: "complete",
        visible: "visible",
        online: true,
        afterReload: false,
        reloading: true,
        typed: false,
        dpl: ("dpl_" + "x".repeat(100)).slice(0, 64),
        errors: [{ res: "https://x/_next/a.js" }, { msg: "m".repeat(160), at: "f.js:1" }],
        dropped: 3,
        failed: [{ res: "https://x/_next/a.js", status: 404 }],
      },
    });
    expect(healthReport({ kind: "prepare_stuck", provider: "whop", prepared: false, preparing: false, quote: true, paypal: false, t: -5 })?.data).toEqual({
      what: "prepare_stuck",
      t: 0,
      provider: "whop",
      prepared: false,
      preparing: false,
      quote: true,
      paypal: false,
    });
    expect(healthReport({ kind: "form_not_ready", waitedMs: 30_000, frame: true, lastState: "loading" })?.data).toEqual({ what: "form_not_ready", waitedMs: 30_000, frame: true, lastState: "loading" });
    expect(healthReport({ kind: "page_error", msg: "x".repeat(400), digest: "123" })?.data).toEqual({ what: "page_error", msg: "x".repeat(200), digest: "123" });
    expect(healthReport({ kind: "inline_prepare_failed", reason: "timeout" })?.data).toEqual({ what: "inline_prepare_failed", reason: "timeout" });
    expect(healthReport({ kind: "not_booted", afterReload: null })?.data.afterReload).toBeNull();
  });

  it("not a report: null", () => {
    for (const raw of [null, "x", 5, [], {}, { kind: "nope" }, { kind: "toString" }, { kind: "__proto__" }, { kind: 3 }]) expect(healthReport(raw)).toBeNull();
  });
});

describe("POST /api/public/sessions/[id]/health", () => {
  it("a hard failure from the checkout page: the store's incident, journaled each time, no alert, with the browser; an empty 204", async () => {
    const res = await send({ kind: "not_booted", t: 10_500, state: "complete", afterReload: false, reloading: true, errors: [], failed: [] });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(mocks.findSession).toHaveBeenCalledTimes(1);
    expect(mocks.foreign).toHaveBeenCalledWith(expect.any(Request), { id: "st_1", checkoutDomain: null });
    expect(mocks.recordIncident.mock.calls[0][0]).toEqual({
      storeId: "st_1",
      sessionId: ID,
      kind: "checkout.form_missing",
      message: expect.stringMatching(/ne s'est pas lancée.*page rechargée automatiquement\.$/),
      data: { what: "not_booted", t: 10_500, state: "complete", afterReload: false, reloading: true, errors: [], failed: [], ua: "Mozilla/5.0 (iPhone)" },
      alert: false,
      everyMs: 1_000,
    });
  });

  it("says whether the page was reloaded, had been already, or could not be", async () => {
    await send({ kind: "not_booted", afterReload: false, reloading: true });
    await send({ kind: "not_booted", afterReload: true, reloading: false });
    await send({ kind: "not_booted", afterReload: null, reloading: false });
    await send({ kind: "not_booted", afterReload: false, reloading: false });
    const messages = mocks.recordIncident.mock.calls.map((c) => (c[0] as { message: string }).message);
    expect(messages[0]).toMatch(/page rechargée automatiquement\.$/);
    expect(messages[1]).toMatch(/encore après le rechargement automatique\.$/);
    expect(messages[2]).toMatch(/\(fichiers non chargés ou en erreur\)\.$/);
    expect(messages[3]).toMatch(/\(fichiers non chargés ou en erreur\)\.$/);
  });

  it("each hard failure has its own words", async () => {
    await send({ kind: "page_error", msg: "boom" });
    await send({ kind: "prepare_stuck", provider: "whop" });
    await send({ kind: "form_not_ready", waitedMs: 30_000, frame: false, lastState: null });
    const messages = mocks.recordIncident.mock.calls.map((c) => (c[0] as { message: string }).message);
    expect(messages).toEqual([expect.stringMatching(/écran d'erreur/), expect.stringMatching(/pendant 12 s/), expect.stringMatching(/toujours pas prêt après 30 s/)]);
  });

  it("the softer signals: in the logs only, never journaled", async () => {
    for (const kind of ["still_loading", "prepare_slow", "left_without_form", "inline_prepare_failed", "recovered"]) {
      expect((await send({ kind, t: 25_000 })).status).toBe(204);
      expect(mocks.warn).toHaveBeenLastCalledWith(`checkout.health.${kind}`, expect.any(String), expect.objectContaining({ storeId: "st_1", sessionId: ID, what: kind }));
    }
    expect(mocks.recordIncident).not.toHaveBeenCalled();
  });

  it("another site's request, or one without Origin: 403, nothing read", async () => {
    expect((await send({ kind: "not_booted" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await send({ kind: "not_booted" }, { origin: null, "sec-fetch-site": null })).status).toBe(403);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.findSession).not.toHaveBeenCalled();
  });

  it("a malformed session id: 404 before any limit or read", async () => {
    expect((await send({ kind: "not_booted" }, {}, "../../etc")).status).toBe(404);
    expect((await send({ kind: "not_booted" }, {}, "x")).status).toBe(404);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.findSession).not.toHaveBeenCalled();
  });

  it("over the per-IP limit: 429; over the session's quota: 204 without anything recorded", async () => {
    mocks.rateLimit.mockImplementation(async (key) => !key.startsWith("health:ip:"));
    expect((await send({ kind: "not_booted" })).status).toBe(429);
    mocks.rateLimit.mockImplementation(async (key) => !key.startsWith("health:s:"));
    expect((await send({ kind: "not_booted" })).status).toBe(204);
    expect(mocks.recordIncident).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledWith(`health:s:${ID}`, 5, 600_000);
  });

  it("an oversized body (declared or not): 413; not a report: 400; nothing recorded", async () => {
    expect((await send({ kind: "not_booted" }, { "content-length": "9000" })).status).toBe(413);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect((await send("x".repeat(9_000))).status).toBe(413);
    expect((await send("not json")).status).toBe(400);
    expect((await send({ kind: "unknown" })).status).toBe(400);
    expect(mocks.recordIncident).not.toHaveBeenCalled();
  });

  it("an unknown session or a foreign checkout host: the same empty 204, nothing recorded", async () => {
    mocks.findSession.mockImplementation(async () => null);
    expect((await send({ kind: "not_booted" })).status).toBe(204);
    mocks.findSession.mockImplementation(async () => ({ storeId: "st_1", store: { id: "st_1", checkoutDomain: "checkout.shop.test" } }));
    mocks.foreign.mockImplementation(async () => true);
    expect((await send({ kind: "not_booted" })).status).toBe(204);
    expect(mocks.recordIncident).not.toHaveBeenCalled();
  });
});
