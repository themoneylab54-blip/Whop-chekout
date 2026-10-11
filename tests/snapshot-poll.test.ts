import { describe, expect, it, vi } from "vitest";

/*
 * A request waiting for the checkout another one is creating (the early prepare's, a second tab's)
 * looks for it every 50 ms for the first 2 s of its wait (that checkout usually lands within a
 * second), then every 150 ms: a full 22 s wait is about 174 polls (147 at a steady 150 ms).
 */

vi.mock("@/lib/db", () => ({ db: {} }));
const { snapshotPollEvery, snapshotClaimTimings } = await import("@/lib/checkout");

describe("snapshotPollEvery", () => {
  it("50 ms for the first 2 s of the wait, then 150 ms", () => {
    expect([0, 1_000, 1_999, 2_000, 10_000, 21_999].map((t) => snapshotPollEvery(t))).toEqual([50, 50, 50, 150, 150, 150]);
    // The slow-Whop tests' shorter timings keep their own pace (never under it).
    expect(snapshotPollEvery(0, 5)).toBe(5);
    expect(snapshotPollEvery(5_000, 5)).toBe(150);
    expect(snapshotPollEvery(5_000, 400)).toBe(400);
  });

  it("a full wait: about 174 polls, within 20 % of a steady 150 ms", () => {
    let waited = 0;
    let polls = 0;
    while (waited < snapshotClaimTimings.waitMs) {
      waited += snapshotPollEvery(waited);
      polls++;
    }
    expect(snapshotClaimTimings.waitMs).toBe(22_000);
    expect(polls).toBe(174);
    expect(polls / Math.ceil(22_000 / 150)).toBeLessThan(1.2);
  });
});
