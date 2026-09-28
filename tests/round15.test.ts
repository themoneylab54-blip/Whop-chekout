import { describe, expect, it } from "vitest";
import { callOutcome, latencyBucket, percentileMs, providerDegraded, scrub, statsOf } from "@/lib/metrics";
import { sustainedFailure } from "@/lib/providers";
import { buildEnvelope, parseDsn, stackFrames } from "@/lib/sentry";
import { JOB_STARVED_MS, rotateJobs, starvedFrom, TICK_JOBS } from "@/lib/tick";
import { calibrationDecision, calibrationObservation, CALIBRATION_GIVE_UP_MS, shopifyCodeUses, type CalibrationVote } from "@/lib/shopify-discounts";
import { checkoutFailureSource, tagFailureSource } from "@/lib/checkout";
import { ShopifyError } from "@/lib/shopify";
import { leakageAlarming } from "@/lib/analytics";
import { humanizeError } from "@/lib/humanize-error";
import { externalCoveredUntil } from "@/lib/shopify-history";

/*
 * Round 15 (reliability / observability), pure parts: provider call classification, latency histogram
 * and percentiles, the degraded / sustained-failure rules, PII scrubbing and the Sentry envelope, the
 * tick's job order and rotation, starved jobs, the Shopify code count (lag window, calibration votes),
 * checkout failure sources and the leakage alert's guards.
 */

describe("provider metrics", () => {
  it("counts no answer, 5xx, 429 and auth refusals as errors; other 4xx are answers", () => {
    expect(callOutcome({ status: 200 })).toEqual({ error: false, timeout: false, message: null });
    expect(callOutcome({ status: 404 }).error).toBe(false);
    expect(callOutcome({ status: 422 }).error).toBe(false);
    expect(callOutcome({ status: 503 })).toEqual({ error: true, timeout: false, message: "HTTP 503" });
    expect(callOutcome({ status: 429 }).error).toBe(true);
    expect(callOutcome({ status: 401 }).error).toBe(true);
    expect(callOutcome({ status: 504 }).timeout).toBe(true);
    const t = callOutcome({ err: Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }) });
    expect(t).toMatchObject({ error: true, timeout: true });
    expect(callOutcome({ err: new TypeError("fetch failed") })).toMatchObject({ error: true, timeout: false, message: "fetch failed" });
  });

  it("buckets latencies and reads percentiles from the histogram, never above the slowest call", () => {
    expect([10, 250, 251, 999, 4_000, 8_001, 15_000, 20_000].map(latencyBucket)).toEqual([0, 0, 1, 2, 4, 6, 6, 7]);
    // 90 fast calls, 10 at ~9 s: p50 in the first bucket (capped at the max), p95 in the 15 s one.
    const h = [90, 0, 0, 0, 0, 0, 10, 0];
    expect(percentileMs(h, 0.5, 9_200)).toBe(250);
    expect(percentileMs(h, 0.95, 9_200)).toBe(9_200);
    expect(percentileMs([3, 0, 0, 0, 0, 0, 0, 0], 0.95, 40)).toBe(40);
    expect(percentileMs([0, 0, 0, 0, 0, 0, 0, 2], 0.5, 31_000)).toBe(31_000);
    expect(percentileMs([0, 0, 0, 0, 0, 0, 0, 0], 0.5, 0)).toBeNull();
  });

  it("rolls rows up and flags a degraded provider (> 20 % errors over ≥ 10 calls, or p95 > 8 s)", () => {
    const at = (m: number) => new Date(Date.UTC(2026, 8, 28, 12, m));
    const s = statsOf("shopify", [
      { provider: "shopify", calls: 6, errors: 1, timeouts: 1, maxMs: 900, h: [5, 0, 1, 0, 0, 0, 0, 0], lastOkAt: at(1), lastErrorAt: at(2), lastError: "HTTP 503" },
      { provider: "shopify", calls: 6, errors: 2, timeouts: 0, maxMs: 300, h: [4, 2, 0, 0, 0, 0, 0, 0], lastOkAt: at(7), lastErrorAt: at(6), lastError: "fetch failed" },
    ]);
    expect(s).toMatchObject({ label: "Shopify", calls: 12, errors: 3, timeouts: 1, maxMs: 900, lastError: "fetch failed" });
    expect(s.lastOkAt).toEqual(at(7));
    expect(s.errorRate).toBeCloseTo(0.25);
    expect(providerDegraded(s)).toBe("25 % d'erreurs sur 12 appels");
    expect(providerDegraded({ calls: 9, errors: 9, p95Ms: 100 })).toBeNull();
    expect(providerDegraded({ calls: 50, errors: 10, p95Ms: 8_000 })).toBeNull();
    expect(providerDegraded({ calls: 3, errors: 0, p95Ms: 15_000 })).toBe("p95 15.0 s");
  });

  it("alerts only on a failure sustained over 15 minutes, not on a burst that just started", () => {
    const now = Date.UTC(2026, 8, 28, 12, 14);
    const b = (m: number, calls: number, errors: number) => ({ bucket: new Date(Date.UTC(2026, 8, 28, 12, m)), calls, errors });
    expect(sustainedFailure([b(0, 4, 3), b(5, 4, 2), b(10, 4, 4)], now)).toEqual({ calls: 12, errors: 9 });
    // Since 12:05 only: not yet 15 minutes.
    expect(sustainedFailure([b(5, 10, 10), b(10, 10, 10)], now)).toBeNull();
    // One healthy bucket in the window: it recovered meanwhile.
    expect(sustainedFailure([b(0, 4, 3), b(5, 10, 0), b(10, 4, 4)], now)).toBeNull();
    // Too few calls to judge.
    expect(sustainedFailure([b(0, 2, 2), b(5, 2, 2), b(10, 2, 2)], now)).toBeNull();
  });

  it("scrubs e-mails, tokens, secrets in URLs and long numbers, keeps dates and statuses", () => {
    const out = scrub(
      "Shopify API 503 for jane.doe+x@example.com Bearer abc.def token shpat_1234567890abcdef https://api.telegram.org/bot123:SECRET/sendMessage?chat=1 access_token=EAAB123 06 12 34 56 78 on 2026-09-28",
    );
    expect(out).toContain("Shopify API 503");
    expect(out).toContain("2026-09-28");
    for (const leak of ["jane.doe", "abc.def", "shpat_", "SECRET", "EAAB123", "06 12 34 56 78", "chat=1"]) expect(out).not.toContain(leak);
    expect(scrub("x".repeat(400)).length).toBeLessThanOrEqual(300);
  });

  it("explains the metrics' status errors in plain French", () => {
    expect(humanizeError("HTTP 503").text).toContain("momentanément indisponible (503)");
    expect(humanizeError("HTTP 401").text).toContain("refusé l'accès (401)");
    expect(humanizeError("HTTP 429").text).toContain("limite temporairement");
  });
});

describe("Sentry envelope", () => {
  it("parses a DSN into its envelope endpoint", () => {
    expect(parseDsn("https://abc@o1.ingest.sentry.io/42")).toEqual({ url: "https://o1.ingest.sentry.io/api/42/envelope/", publicKey: "abc", dsn: "https://abc@o1.ingest.sentry.io/42" });
    expect(parseDsn("https://abc@sentry.example.com/prefix/7")?.url).toBe("https://sentry.example.com/prefix/api/7/envelope/");
    expect(parseDsn("not a dsn")).toBeNull();
    expect(parseDsn("https://o1.ingest.sentry.io/42")).toBeNull();
    expect(parseDsn(undefined)).toBeNull();
  });

  it("builds a scrubbed event: type, message, frames, route — never personal data", () => {
    const err = new Error("Could not charge paul@example.com (whsec_abcdefghijklmnop)");
    err.stack = "Error: x\n    at handle (/app/src/app/api/x/route.ts:10:5)\n    at async route (/app/node_modules/next/dist/x.js:1:2)";
    const env = buildEnvelope(err, { where: "route:sessions.pay", route: "sessions.pay", requestId: "req_1" }, { dsn: "https://k@h/1", eventId: "e1", now: new Date(0), environment: "test" });
    const [header, item, event] = env.trim().split("\n").map((l) => JSON.parse(l));
    expect(header).toMatchObject({ event_id: "e1", dsn: "https://k@h/1" });
    expect(item).toEqual({ type: "event" });
    expect(event).toMatchObject({ level: "error", environment: "test", transaction: "route:sessions.pay", tags: { route: "sessions.pay" }, extra: { requestId: "req_1" } });
    expect(event.exception.values[0].value).toBe("Could not charge [email] ([secret])");
    expect(event.exception.values[0].stacktrace.frames).toEqual(stackFrames(err.stack));
    expect(stackFrames(err.stack)[0]).toMatchObject({ function: "async route", in_app: false });
    expect(stackFrames(err.stack)[1]).toMatchObject({ function: "handle", filename: "/app/src/app/api/x/route.ts", lineno: 10, in_app: true });
    expect(env).not.toContain("paul@example.com");
  });
});

describe("background tick", () => {
  it("runs the Whop-side money jobs before the Shopify-side ones, money before the rest", () => {
    const names = TICK_JOBS.map((j) => j.name);
    for (const whop of ["upsellsSwept", "reconciled", "refundsReconciled", "disputesReconciled", "alertRefunds"])
      for (const shopify of ["syncRetried", "upsellRetried", "offerBalancesPaid", "refundsMirrored", "disputesTagged", "trackingPushed", "disputeEvidence"])
        expect(names.indexOf(whop)).toBeLessThan(names.indexOf(shopify));
    expect(names.indexOf("followUps")).toBeLessThan(names.indexOf("syncRetried"));
    const lastMoney = Math.max(...TICK_JOBS.map((j, i) => (j.money ? i : -1)));
    expect(TICK_JOBS.slice(0, lastMoney + 1).every((j) => j.money)).toBe(true);
    expect(TICK_JOBS.filter((j) => j.whopSide).every((j) => j.money)).toBe(true);
  });

  it("rotates the non-money jobs and flags the ones not run for over 6 h", () => {
    expect(rotateJobs(["a", "b", "c", "d"], 1)).toEqual(["b", "c", "d", "a"]);
    expect(rotateJobs(["a", "b", "c"], 7)).toEqual(["b", "c", "a"]);
    expect(rotateJobs(["a", "b"], -1)).toEqual(["b", "a"]);
    expect(rotateJobs([], 3)).toEqual([]);
    const now = Date.UTC(2026, 8, 28, 12);
    const last = { a: new Date(now - JOB_STARVED_MS - 60_000).toISOString(), b: new Date(now - 60_000).toISOString() };
    expect(starvedFrom(last, ["a", "b", "c"], now)).toEqual([{ name: "a", ageMs: JOB_STARVED_MS + 60_000 }]);
  });
});

describe("Shopify code uses: the lag window when Shopify counts our orders", () => {
  it("adds the ledger's uses newer than Shopify's read, never counting one twice", () => {
    // Not calibrated / not counted: sum (the recent uses are already in the ledger).
    expect(shopifyCodeUses(6, 3, null, 1)).toBe(9);
    expect(shopifyCodeUses(6, 3, false, 3)).toBe(9);
    // Counted: Shopify's 6 already hold our 2 older uses; the one newer than its read is added.
    expect(shopifyCodeUses(6, 3, true, 1)).toBe(7);
    // Our ledger alone is higher: never below it.
    expect(shopifyCodeUses(2, 5, true, 1)).toBe(5);
    // Recent can't exceed the ledger.
    expect(shopifyCodeUses(4, 1, true, 9)).toBe(5);
    expect(shopifyCodeUses(6, 3, true)).toBe(6);
  });

  it("observes « counts » on an exact match only, « doesn't » an hour later, and decides on two references", () => {
    expect(calibrationObservation({ rise: 2, ours: 2, ageMs: 0 })).toBe(true);
    // More than ours: outside uses (or both): nothing to learn.
    expect(calibrationObservation({ rise: 3, ours: 2, ageMs: 2 * CALIBRATION_GIVE_UP_MS })).toBeNull();
    expect(calibrationObservation({ rise: 1, ours: 2, ageMs: CALIBRATION_GIVE_UP_MS - 1 })).toBeNull();
    expect(calibrationObservation({ rise: 1, ours: 2, ageMs: CALIBRATION_GIVE_UP_MS })).toBe(false);
    expect(calibrationObservation({ rise: 0, ours: 0, ageMs: CALIBRATION_GIVE_UP_MS })).toBeNull();
    const v = (ref: string, decision: boolean, verified = true): CalibrationVote => ({ ref, code: "X", decision, windowFrom: 0, windowTo: 0, verified });
    expect(calibrationDecision([v("a", true)])).toBeNull();
    expect(calibrationDecision([v("a", true), v("a", true)])).toBeNull();
    expect(calibrationDecision([v("a", true), v("b", true, false)])).toBeNull();
    expect(calibrationDecision([v("a", true), v("b", true)])).toBe(true);
    expect(calibrationDecision([v("a", true), v("b", false)])).toBeNull();
    expect(calibrationDecision([v("a", true), v("b", false), v("c", false)])).toBe(false);
  });

  it("knows the outside orders only up to the start of the last import that completed without error", () => {
    const base = { since: "", after: null, runStartedAt: "2026-09-28T10:00:00.000Z", lastRunAt: "2026-09-28T10:05:00.000Z", imported: 1 };
    expect(externalCoveredUntil(base)).toBe(Date.parse("2026-09-28T10:00:00.000Z"));
    expect(externalCoveredUntil({ ...base, after: "cursor" })).toBeNull();
    expect(externalCoveredUntil({ ...base, error: "boom" })).toBeNull();
    expect(externalCoveredUntil({ ...base, lastRunAt: null })).toBeNull();
    expect(externalCoveredUntil(null)).toBeNull();
  });
});

describe("checkout failures by source", () => {
  it("Shopify's errors are Shopify-side; Whop-tagged and unclassified ones count towards the fallback", async () => {
    expect(checkoutFailureSource(new ShopifyError("Shopify API 503", true))).toBe("shopify");
    expect(checkoutFailureSource(new Error("?"))).toBe("whop");
    const tagged = await tagFailureSource(Promise.reject(new ShopifyError("wrapped")), "whop").catch((e: unknown) => e);
    expect(checkoutFailureSource(tagged)).toBe("whop");
    expect(await tagFailureSource(Promise.resolve(3), "shopify")).toBe(3);
  });
});

describe("leakage alert guards", () => {
  it("needs 3 outside orders and orders known (a completed import) past the end of the day", () => {
    const dayEnd = new Date("2026-09-27T22:00:00.000Z");
    const l = { share: 0.3, orders: 3, coveredUntil: "2026-09-28T02:00:00.000Z" };
    expect(leakageAlarming(l, { dayEnd })).toBe(true);
    expect(leakageAlarming({ ...l, orders: 2 }, { dayEnd })).toBe(false);
    expect(leakageAlarming({ ...l, coveredUntil: "2026-09-27T15:00:00.000Z" }, { dayEnd })).toBe(false);
    expect(leakageAlarming({ ...l, coveredUntil: null }, { dayEnd })).toBe(false);
    expect(leakageAlarming({ ...l, coveredUntil: null })).toBe(true);
  });
});
