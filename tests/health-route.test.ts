import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The checkout page's health reports (api/public/sessions/[id]/health), without a database: a
 * same-origin report of a known kind becomes the store's "checkout.form_missing" incident (no alert),
 * with the page's known fields only, cut short, and the browser; another site's request, a flood or an
 * oversized body is refused; an unknown session, a foreign host or a session over its quota is
 * answered the same empty 204 without anything recorded.
 */

const mocks = vi.hoisted(() => ({
  findSession: vi.fn<(args: unknown) => Promise<unknown>>(async () => ({ storeId: "st_1" })),
  foreign: vi.fn<(req: Request, id: string) => Promise<boolean>>(async () => false),
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
vi.mock("@/lib/checkout-domain-check", () => ({ isForeignSessionHost: mocks.foreign }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: mocks.rateLimit, clientIp: () => "10.1.2.3" }));
vi.mock("@/lib/incidents", () => ({ recordIncident: mocks.recordIncident }));

const { POST, healthReport } = await import("@/app/api/public/sessions/[id]/health/route");

const send = (body: unknown, headers: Record<string, string> = {}, id = "cmsess1") =>
  POST(
    new Request(`https://checkout.example.com/api/public/sessions/${id}/health`, {
      method: "POST",
      headers: { host: "checkout.example.com", origin: "https://checkout.example.com", "sec-fetch-site": "same-origin", "content-type": "text/plain;charset=UTF-8", "user-agent": "Mozilla/5.0 (iPhone)", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findSession.mockImplementation(async () => ({ storeId: "st_1" }));
  mocks.foreign.mockImplementation(async () => false);
  mocks.rateLimit.mockImplementation(async () => true);
});

describe("healthReport (what the page said, its known fields only)", () => {
  it("a known kind: its fields kept, cut short and bounded; unknown fields and kinds dropped", () => {
    const r = healthReport({
      kind: "not_booted",
      t: 12_345.6,
      state: "complete",
      visible: "visible",
      afterReload: false,
      errors: [{ res: "https://x/_next/a.js", extra: "no" }, { msg: "m".repeat(500), at: "f.js:1" }, "junk", null],
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
        afterReload: false,
        errors: [{ res: "https://x/_next/a.js" }, { msg: "m".repeat(160), at: "f.js:1" }],
        failed: [{ res: "https://x/_next/a.js", status: 404 }],
      },
    });
    expect(healthReport({ kind: "prepare_stuck", provider: "whop", quote: true, paypal: false, t: -5 })?.data).toEqual({ what: "prepare_stuck", t: 0, provider: "whop", quote: true, paypal: false });
    expect(healthReport({ kind: "page_error", msg: "x".repeat(400), digest: "123" })?.data).toEqual({ what: "page_error", msg: "x".repeat(200), digest: "123" });
    expect(healthReport({ kind: "not_booted", afterReload: null })?.data.afterReload).toBeNull();
  });

  it("not a report: null", () => {
    for (const raw of [null, "x", 5, [], {}, { kind: "nope" }, { kind: "toString" }, { kind: 3 }]) expect(healthReport(raw)).toBeNull();
  });
});

describe("POST /api/public/sessions/[id]/health", () => {
  it("a report from the checkout page: the store's incident, no alert, with the browser; an empty 204", async () => {
    const res = await send({ kind: "not_booted", t: 10_500, state: "complete", afterReload: false, errors: [], failed: [] });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(mocks.recordIncident).toHaveBeenCalledTimes(1);
    expect(mocks.recordIncident.mock.calls[0][0]).toEqual({
      storeId: "st_1",
      sessionId: "cmsess1",
      kind: "checkout.form_missing",
      message: expect.stringMatching(/ne s'est pas lancée.*page rechargée automatiquement\.$/),
      data: { what: "not_booted", t: 10_500, state: "complete", afterReload: false, errors: [], failed: [], ua: "Mozilla/5.0 (iPhone)" },
      alert: false,
    });
  });

  it("says whether the page was reloaded, already reloaded or could not be", async () => {
    await send({ kind: "not_booted", afterReload: true });
    await send({ kind: "not_booted", afterReload: null });
    await send({ kind: "form_not_ready", waitedMs: 30_000 });
    const messages = mocks.recordIncident.mock.calls.map((c) => (c[0] as { message: string }).message);
    expect(messages[0]).toMatch(/encore après le rechargement automatique\.$/);
    expect(messages[1]).toMatch(/\(fichiers non chargés ou en erreur\)\.$/);
    expect(messages[2]).toMatch(/jamais déclaré prêt/);
  });

  it("a page merely still loading after 25 s: in the logs only, never journaled", async () => {
    expect((await send({ kind: "still_loading", t: 25_000, state: "interactive" })).status).toBe(204);
    expect(mocks.recordIncident).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith("checkout.page_slow", expect.stringMatching(/chargeait encore 25 s/), expect.objectContaining({ storeId: "st_1", sessionId: "cmsess1", what: "still_loading", state: "interactive" }));
  });

  it("another site's request: 403, nothing read", async () => {
    const res = await send({ kind: "not_booted" }, { origin: "https://evil.example", "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(mocks.findSession).not.toHaveBeenCalled();
    expect(mocks.recordIncident).not.toHaveBeenCalled();
  });

  it("over the per-IP limit: 429; over the session's quota: 204 without anything recorded", async () => {
    mocks.rateLimit.mockImplementation(async (key) => !key.startsWith("health:ip:"));
    expect((await send({ kind: "not_booted" })).status).toBe(429);
    mocks.rateLimit.mockImplementation(async (key) => !key.startsWith("health:s:"));
    expect((await send({ kind: "not_booted" })).status).toBe(204);
    expect(mocks.recordIncident).not.toHaveBeenCalled();
    expect(mocks.rateLimit).toHaveBeenCalledWith("health:s:cmsess1", 5, 600_000);
  });

  it("an oversized body: 413; not a report: 400; nothing recorded", async () => {
    expect((await send("x".repeat(9_000))).status).toBe(413);
    expect((await send("not json")).status).toBe(400);
    expect((await send({ kind: "unknown" })).status).toBe(400);
    expect(mocks.recordIncident).not.toHaveBeenCalled();
  });

  it("an unknown session or a foreign checkout host: the same empty 204, nothing recorded", async () => {
    mocks.findSession.mockImplementation(async () => null);
    expect((await send({ kind: "not_booted" })).status).toBe(204);
    mocks.findSession.mockImplementation(async () => ({ storeId: "st_1" }));
    mocks.foreign.mockImplementation(async () => true);
    expect((await send({ kind: "not_booted" })).status).toBe(204);
    expect(mocks.recordIncident).not.toHaveBeenCalled();
  });
});
