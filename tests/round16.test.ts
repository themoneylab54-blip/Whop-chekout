import { describe, expect, it } from "vitest";
import { JOB_STARVED_MS, MONEY_JOB_STARVED_MS, roundRobinByStore, starvedAfter, starvedFrom, TICK_JOBS } from "@/lib/tick";
import { externalImportDue } from "@/lib/shopify-history";
import { dayFlag, dayFlagKind, DISABLED_FLAG, FALLBACK_FLAG } from "@/components/dashboard/dayFlags";
import { formatMinutes, verdictDisplay } from "@/components/dashboard/AnalyticsKit";

/*
 * Round 16 (fixes), pure parts: the tick's job order (providers watched early, dispute evidence ahead of
 * the Shopify retries with a reserved slice), money-job starvation (1 h), per-store round robin of the
 * retry jobs, the outside-orders import due at the first tick after local midnight, the shared chart
 * day flags, the "≈ à l'équilibre" verdict and the "< 1 min" duration.
 */

describe("background tick order and starvation", () => {
  const names = TICK_JOBS.map((j) => j.name);

  it("watches the providers among the first jobs, as a money job (never rotated away)", () => {
    const i = names.indexOf("providersWatched");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(i).toBeLessThanOrEqual(2);
    expect(TICK_JOBS[i].money).toBe(true);
    expect(names.filter((n) => n === "providersWatched")).toHaveLength(1);
  });

  it("runs tracking then dispute evidence before the Shopify retry jobs, the evidence with a reserved slice", () => {
    expect(names.indexOf("trackingPushed")).toBeLessThan(names.indexOf("disputeEvidence"));
    for (const shopify of ["syncRetried", "upsellRetried", "offerBalancesPaid", "refundsMirrored", "disputesTagged"]) {
      expect(names.indexOf("disputeEvidence")).toBeLessThan(names.indexOf(shopify));
    }
    expect(names.indexOf("followUps")).toBeLessThan(names.indexOf("trackingPushed"));
    expect(TICK_JOBS.find((j) => j.name === "disputeEvidence")!.reservedMs).toBeGreaterThan(0);
    expect(names.indexOf("leakageAlerts")).toBeGreaterThan(names.indexOf("dailyReport"));
  });

  it("flags a money job after 1 h, the others after 6 h", () => {
    expect(starvedAfter("reconciled")).toBe(MONEY_JOB_STARVED_MS);
    expect(starvedAfter("disputeEvidence")).toBe(MONEY_JOB_STARVED_MS);
    expect(starvedAfter("cleaned")).toBe(JOB_STARVED_MS);
    const now = Date.UTC(2026, 8, 28, 12);
    const ago = (ms: number) => new Date(now - ms).toISOString();
    const last = { reconciled: ago(MONEY_JOB_STARVED_MS + 60_000), syncRetried: ago(30 * 60_000), cleaned: ago(2 * 3600_000), anomalies: ago(JOB_STARVED_MS + 1) };
    expect(starvedFrom(last, ["reconciled", "syncRetried", "cleaned", "anomalies"], now).map((s) => s.name)).toEqual(["reconciled", "anomalies"]);
  });

  it("interleaves due items one store at a time, in the rotated store order", () => {
    const items = [
      { id: "a1", storeId: "A" },
      { id: "a2", storeId: "A" },
      { id: "a3", storeId: "A" },
      { id: "b1", storeId: "B" },
      { id: "c1", storeId: "C" },
      { id: "c2", storeId: "C" },
    ];
    expect(roundRobinByStore(items, ["B", "C", "A"]).map((i) => i.id)).toEqual(["b1", "c1", "a1", "c2", "a2", "a3"]);
    // A store missing from the order still gets its turn (last).
    expect(roundRobinByStore(items, ["C"]).map((i) => i.id)).toEqual(["c1", "a1", "b1", "c2", "a2", "a3"]);
    expect(roundRobinByStore([], ["A"])).toEqual([]);
  });
});

describe("outside orders import: due at the first tick after the store's midnight", () => {
  const tz = "Europe/Paris";
  it("is due when never run, after 24 h, or once a new local day started", () => {
    const now = new Date("2026-09-28T00:10:00+02:00");
    expect(externalImportDue(null, now, tz)).toBe(true);
    // Ran yesterday at 10:00 (14 h ago): a new local day started, due now (before the 07:00 report).
    expect(externalImportDue(new Date("2026-09-27T10:00:00+02:00").toISOString(), now, tz)).toBe(true);
    // Ran 5 minutes ago (same local day): not due.
    expect(externalImportDue(new Date("2026-09-28T00:05:00+02:00").toISOString(), now, tz)).toBe(false);
    // Same local day, 23 h later: still not due; 24 h later: due.
    expect(externalImportDue(new Date("2026-09-28T00:05:00+02:00").toISOString(), new Date("2026-09-28T23:05:00+02:00"), tz)).toBe(false);
    expect(externalImportDue("not a date", now, tz)).toBe(true);
  });
});

describe("dashboard wording", () => {
  it("shares the chart day flags: fallback, checkout switched off (hors de ce checkout), both", () => {
    expect(dayFlag({ fallback: false, disabled: false })).toBeUndefined();
    expect(dayFlagKind({ fallback: false })).toBeUndefined();
    expect(dayFlag({ fallback: true })).toBe(FALLBACK_FLAG);
    expect(dayFlagKind({ fallback: true })).toBe("fallback");
    expect(dayFlag({ fallback: false, disabled: true })).toBe(DISABLED_FLAG);
    expect(DISABLED_FLAG).toContain("hors de ce checkout");
    expect(dayFlagKind({ fallback: false, disabled: true })).toBe("disabled");
    expect(dayFlag({ fallback: true, disabled: true })).toBe(`${FALLBACK_FLAG} · ${DISABLED_FLAG}`);
    expect(dayFlagKind({ fallback: true, disabled: true })).toBe("both");
  });

  it("reads a « Garder » verdict with a negative profit after ads as « ≈ à l'équilibre »", () => {
    expect(verdictDisplay("keep", 1500).label).toBe("Garder");
    expect(verdictDisplay("keep", null).label).toBe("Garder");
    expect(verdictDisplay("keep", 0).label).toBe("Garder");
    const even = verdictDisplay("keep", -200);
    expect(even.label).toBe("≈ à l'équilibre");
    expect(even.title).toMatch(/légèrement négatif/);
    expect(verdictDisplay("cut", -200).label).toBe("Couper");
    expect(verdictDisplay("scale", -1).label).toBe("Scaler");
  });

  it("shows a purchase under a minute as « < 1 min », never « 0 min »", () => {
    expect(formatMinutes(0)).toBe("< 1 min");
    expect(formatMinutes(0.03)).toBe("< 1 min");
    expect(formatMinutes(0.99)).toBe("< 1 min");
    expect(formatMinutes(1)).toBe("1 min");
    expect(formatMinutes(4.46)).toBe("4,5 min");
    expect(formatMinutes(150)).toBe("2,5 h");
    expect(formatMinutes(null)).toBe("—");
  });
});
