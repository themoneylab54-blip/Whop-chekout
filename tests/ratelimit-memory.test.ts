import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The memory-only limiter (memoryRateLimit: this instance, never a query): allows up to the limit,
 * refuses after, counts each key apart and starts a new window once the previous one is over. And
 * rateLimitReached (a limit looked at, nothing spent): this instance's count first, then the shared
 * one, a reached shared count kept in memory until its window ends; false when the database fails.
 */

vi.mock("@/lib/db", () => ({ db: { $queryRaw: vi.fn(async () => []) } }));
vi.mock("@/lib/log", async (orig) => ({ ...(await orig<typeof import("@/lib/log")>()), recordEvent: vi.fn() }));

const { memoryRateLimit, rateLimit, rateLimitReached } = await import("@/lib/ratelimit");
const { db } = await import("@/lib/db");

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);

describe("memoryRateLimit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to the limit, then refuses, without any database query", () => {
    for (let i = 0; i < 5; i++) expect(memoryRateLimit("mem:limit", 5)).toBe(true);
    expect(memoryRateLimit("mem:limit", 5)).toBe(false);
    expect(memoryRateLimit("mem:limit", 5)).toBe(false);
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("counts each key apart", () => {
    expect(memoryRateLimit("mem:a", 1)).toBe(true);
    expect(memoryRateLimit("mem:a", 1)).toBe(false);
    expect(memoryRateLimit("mem:b", 1)).toBe(true);
  });

  it("starts a new window once the previous one is over", () => {
    for (let i = 0; i < 3; i++) expect(memoryRateLimit("mem:window", 3, 10_000)).toBe(true);
    expect(memoryRateLimit("mem:window", 3, 10_000)).toBe(false);
    vi.advanceTimersByTime(9_999);
    expect(memoryRateLimit("mem:window", 3, 10_000)).toBe(false);
    vi.advanceTimersByTime(1);
    for (let i = 0; i < 3; i++) expect(memoryRateLimit("mem:window", 3, 10_000)).toBe(true);
    expect(memoryRateLimit("mem:window", 3, 10_000)).toBe(false);
  });

  it("one minute by default", () => {
    expect(memoryRateLimit("mem:default", 1)).toBe(true);
    vi.advanceTimersByTime(59_999);
    expect(memoryRateLimit("mem:default", 1)).toBe(false);
    vi.advanceTimersByTime(1);
    expect(memoryRateLimit("mem:default", 1)).toBe(true);
  });
});

describe("rateLimitReached", () => {
  const query = () => vi.mocked(db.$queryRaw);
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ now: T0 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("looks only: never counts a call, nor creates a window", async () => {
    query().mockResolvedValueOnce([] as never);
    expect(await rateLimitReached("peek:none", 1)).toBe(false);
    query().mockResolvedValueOnce([{ count: 1 }] as never);
    // The first real call of the key is still allowed (the peek spent nothing).
    expect(await rateLimit("peek:none", 1)).toBe(true);
  });

  it("this instance's own count reached: no query", async () => {
    query().mockResolvedValueOnce([{ count: 1 }] as never);
    expect(await rateLimit("peek:mine", 1, 60_000)).toBe(true);
    query().mockClear();
    expect(await rateLimitReached("peek:mine", 1)).toBe(true);
    expect(query()).not.toHaveBeenCalled();
  });

  it("the shared count reached (another instance spent it): kept in memory until its window ends, then asked again", async () => {
    query().mockResolvedValueOnce([{ count: 1, left: 30_000 }] as never);
    expect(await rateLimitReached("peek:shared", 1)).toBe(true);
    expect(await rateLimitReached("peek:shared", 1)).toBe(true);
    expect(query()).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_000);
    query().mockResolvedValueOnce([] as never);
    expect(await rateLimitReached("peek:shared", 1)).toBe(false);
    expect(query()).toHaveBeenCalledTimes(2);
  });

  it("below the limit, or the database unreachable: not reached", async () => {
    query().mockResolvedValueOnce([{ count: 1, left: 30_000 }] as never);
    expect(await rateLimitReached("peek:below", 2)).toBe(false);
    query().mockRejectedValueOnce(new Error("db down"));
    expect(await rateLimitReached("peek:down", 1)).toBe(false);
  });
});
