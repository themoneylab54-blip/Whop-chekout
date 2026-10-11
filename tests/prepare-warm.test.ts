import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The prepare route's warm-up (the storefront script, the buyer heading for « Checkout »): wakes the
 * function and its database connection, nothing read or written (no rate-limit row, no session read),
 * capped per IP in memory (30 a minute, then 429 without any query). A real session id goes the
 * usual way.
 */

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(async () => []),
  findSession: vi.fn<(args: unknown) => Promise<null>>(async () => null),
  rateLimit: vi.fn<(key: string, limit: number) => Promise<boolean>>(async () => true),
}));

vi.mock("@/lib/db", () => ({ db: { $queryRaw: mocks.queryRaw, checkoutSession: { findUnique: mocks.findSession } } }));
vi.mock("@/lib/ratelimit", async (orig) => ({ ...(await orig<typeof import("@/lib/ratelimit")>()), rateLimit: mocks.rateLimit }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, withLogContext: (_f: unknown, fn: () => unknown) => fn(), recordEvent: vi.fn() }));
vi.mock("@/lib/metrics", () => ({ flushProviderMetrics: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/checkout-domain-check", () => ({ isForeignCheckoutHost: vi.fn(async () => false) }));
vi.mock("@/lib/checkout", () => ({
  failureResponse: vi.fn(),
  journalCheckoutFailure: vi.fn(),
  paymentPayload: vi.fn(),
  prepareAfterClientFailure: vi.fn(),
  prepareWithFailover: vi.fn(),
  quoteSchema: { safeParse: () => ({ success: true, data: {} }) },
}));

const { POST } = await import("@/app/api/public/sessions/[id]/prepare/route");

let n = 0;
const post = (id: string, ip = `10.77.0.${++n}`) =>
  POST(new Request(`https://x.test/api/public/sessions/${id}/prepare`, { method: "POST", headers: { "content-type": "text/plain;charset=UTF-8", "x-forwarded-for": ip }, body: '{"warm":true}' }), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  mocks.queryRaw.mockClear();
  mocks.findSession.mockClear();
  mocks.rateLimit.mockClear();
});

describe("POST /api/public/sessions/warm/prepare", () => {
  it("wakes the function and its database connection: SELECT 1, nothing else, 204", async () => {
    const res = await post("warm");
    expect(res.status).toBe(204);
    expect(mocks.queryRaw.mock.calls.map(([s]) => s.join("?").trim())).toEqual(["SELECT 1"]);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.findSession).not.toHaveBeenCalled();
  });

  it("capped per IP in memory: past 30 a minute, 429 without any query", async () => {
    const ip = "10.77.9.9";
    for (let i = 0; i < 30; i++) expect((await post("warm", ip)).status).toBe(204);
    mocks.queryRaw.mockClear();
    expect((await post("warm", ip)).status).toBe(429);
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("a session id goes the usual way (limits, session read)", async () => {
    const res = await post("cmabc123");
    expect(res.status).toBe(404);
    expect(mocks.rateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.findSession).toHaveBeenCalledTimes(1);
  });
});
