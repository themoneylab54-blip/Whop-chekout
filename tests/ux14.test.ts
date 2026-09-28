import { describe, expect, it } from "vitest";
import { decimalRangeLabel, formatDecimalField, parseDecimal } from "@/components/builder/decimal";
import { LABELS, localeCountries } from "@/components/checkout/i18n";
import { flagStyle } from "@/components/dashboard/chartFlags";

/*
 * UX round 14: decimal fields typed with a French comma (rating score, protection %), the
 * browser-locale shipping country, the "offer declined" announcement and chart day patterns.
 */

describe("parseDecimal", () => {
  it("accepts a comma or a point", () => {
    expect(parseDecimal("4,7")).toEqual({ kind: "ok", value: 4.7 });
    expect(parseDecimal("4.7")).toEqual({ kind: "ok", value: 4.7 });
    expect(parseDecimal(" 4,70 ")).toEqual({ kind: "ok", value: 4.7 });
    expect(parseDecimal("2,5 %")).toEqual({ kind: "ok", value: 2.5 });
    expect(parseDecimal(",5")).toEqual({ kind: "ok", value: 0.5 });
    expect(parseDecimal("4,")).toEqual({ kind: "ok", value: 4 });
    expect(parseDecimal("5")).toEqual({ kind: "ok", value: 5 });
  });

  it("reports empty and malformed input", () => {
    expect(parseDecimal("")).toEqual({ kind: "empty" });
    expect(parseDecimal("   ")).toEqual({ kind: "empty" });
    expect(parseDecimal("abc")).toEqual({ kind: "invalid" });
    expect(parseDecimal("4,7,1")).toEqual({ kind: "invalid" });
    expect(parseDecimal("4.7.1")).toEqual({ kind: "invalid" });
    expect(parseDecimal("1e3")).toEqual({ kind: "invalid" });
    expect(parseDecimal("-")).toEqual({ kind: "invalid" });
  });

  it("reports out-of-range values instead of capping them", () => {
    expect(parseDecimal("5,1", { min: 0, max: 5 })).toEqual({ kind: "range", value: 5.1 });
    expect(parseDecimal("-0,5", { min: 0, max: 5 })).toEqual({ kind: "range", value: -0.5 });
    expect(parseDecimal("47", { min: 0, max: 5 })).toEqual({ kind: "range", value: 47 });
    expect(parseDecimal("0", { min: 0, max: 5 })).toEqual({ kind: "ok", value: 0 });
    expect(parseDecimal("5", { min: 0, max: 5 })).toEqual({ kind: "ok", value: 5 });
  });

  it("formats back with a French comma", () => {
    expect(formatDecimalField(4.7)).toBe("4,7");
    expect(formatDecimalField(5)).toBe("5");
    expect(formatDecimalField(2.5)).toBe("2,5");
    expect(formatDecimalField(0.1 + 0.2)).toBe("0,3");
    expect(formatDecimalField(null)).toBe("");
    expect(formatDecimalField(Number.NaN)).toBe("");
    expect(decimalRangeLabel(0, 5)).toBe("entre 0 et 5");
    expect(decimalRangeLabel(0, 2.5)).toBe("entre 0 et 2,5");
  });
});

describe("localeCountries", () => {
  it("reads the browser's countries in preference order", () => {
    expect(localeCountries("de-DE,de;q=0.9,en-US;q=0.8,en;q=0.7")).toEqual(["DE", "US"]);
    expect(localeCountries("en-US;q=0.5,fr-BE")).toEqual(["BE", "US"]);
    expect(localeCountries("fr-fr")).toEqual(["FR"]);
    expect(localeCountries("zh-Hant-TW")).toEqual(["TW"]);
  });

  it("ignores language-only, numeric-region and refused tags", () => {
    expect(localeCountries("de")).toEqual([]);
    expect(localeCountries("es-419")).toEqual([]);
    expect(localeCountries("it-IT;q=0")).toEqual([]);
    expect(localeCountries("*")).toEqual([]);
    expect(localeCountries(null)).toEqual([]);
    expect(localeCountries("")).toEqual([]);
  });
});

describe("offer declined announcement", () => {
  it("exists in every checkout language", () => {
    for (const labels of Object.values(LABELS)) expect(labels.upsellDeclined.length).toBeGreaterThan(3);
    expect(LABELS.fr.upsellDeclined).toBe("Offre refusée");
  });
});

describe("chart day patterns", () => {
  it("tells the fallback from a disabled checkout by pattern", () => {
    expect(flagStyle(undefined)).toBeUndefined();
    expect(flagStyle("fallback")?.backgroundImage).toBeUndefined();
    expect(flagStyle("disabled")?.backgroundImage).toContain("repeating-linear-gradient");
    expect(flagStyle("disabled")?.backgroundColor).not.toBe(flagStyle("fallback")?.backgroundColor);
    expect(flagStyle("both")?.backgroundImage).toContain("repeating-linear-gradient");
  });
});
