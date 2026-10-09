import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The memory-only limiter (memoryRateLimit: this instance, never a query): allows up to the limit,
 * refuses after, counts each key apart and starts a new window once the previous one is over.
 */

vi.mock("@/lib/db", () => ({ db: { $queryRaw: vi.fn(async () => []) } }));
vi.mock("@/lib/log", async (orig) => ({ ...(await orig<typeof import("@/lib/log")>()), recordEvent: vi.fn() }));

const { memoryRateLimit } = await import("@/lib/ratelimit");
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
