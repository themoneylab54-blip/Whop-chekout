import { describe, expect, it } from "vitest";
import { expressMethodsSchema } from "@/lib/layout";
import { expressMethodsOf } from "@/lib/layout-shared";

/*
 * expressMethodsOf is expressMethodsSchema.parse without zod (the checkout page never loads zod):
 * the same output for every input (defaults, stray values, unknown keys, inherited fields) and a
 * throw wherever the schema throws.
 */

const DEFAULTS = { applePay: true, googlePay: "auto", whopPay: true, paypal: true };
const KEYS = ["applePay", "googlePay", "whopPay", "paypal"] as const;
// Every kind of value a stored or hand-built setting may hold in one field.
const VALUES: unknown[] = [
  undefined,
  null,
  true,
  false,
  0,
  1,
  -1,
  NaN,
  Infinity,
  10n,
  "",
  "true",
  "false",
  "off",
  "auto",
  "always",
  "OFF",
  " auto",
  "auto ",
  "never",
  [],
  [true],
  ["auto"],
  {},
  { on: true },
  { googlePay: "off" },
  new Boolean(false),
  new String("auto"),
  new Date(0),
  () => true,
  Symbol("auto"),
];

const label = (raw: unknown): string => {
  try {
    return JSON.stringify(raw) ?? String(raw);
  } catch {
    return String(raw);
  }
};

/** Both read `raw` the same way: equal results (keys in the same order), or both throw. */
function expectSame(raw: unknown) {
  let parsed: unknown;
  try {
    parsed = expressMethodsSchema.parse(raw);
  } catch {
    expect(() => expressMethodsOf(raw), label(raw)).toThrow();
    return;
  }
  const ours = expressMethodsOf(raw);
  expect(ours, label(raw)).toStrictEqual(parsed);
  expect(Object.keys(ours), label(raw)).toEqual(Object.keys(parsed as object));
}

describe("expressMethodsOf = expressMethodsSchema.parse", () => {
  it("throws on anything but an object, like the schema (callers pass `settings ?? {}`)", () => {
    for (const raw of [undefined, null, true, false, 0, NaN, 10n, "", "auto", "{}", [], [{ applePay: false }], () => ({}), Symbol("x")]) {
      expect(() => expressMethodsSchema.parse(raw), label(raw)).toThrow();
      expect(() => expressMethodsOf(raw), label(raw)).toThrow();
    }
  });

  it("empty and partial objects: each missing or undefined field gets its default", () => {
    expect(expressMethodsOf({})).toStrictEqual(DEFAULTS);
    for (const raw of [
      {},
      { applePay: false },
      { googlePay: "off" },
      { googlePay: "always", paypal: false },
      { whopPay: false, paypal: false },
      { applePay: undefined, googlePay: undefined, whopPay: undefined, paypal: undefined },
      { applePay: false, googlePay: undefined },
    ]) {
      expectSame(raw);
    }
  });

  it("every kind of value in every field, the other fields absent or set", () => {
    const set = { applePay: false, googlePay: "always", whopPay: false, paypal: false };
    for (const key of KEYS) {
      for (const v of VALUES) {
        expectSame({ [key]: v });
        expectSame({ ...set, [key]: v });
      }
    }
    // A stray value falls back to the default, whatever the other fields hold.
    expect(expressMethodsOf({ ...set, applePay: "yes", googlePay: "sometimes" })).toStrictEqual({ ...set, applePay: true, googlePay: "auto" });
  });

  it("every valid setting, each field also absent: kept as chosen", () => {
    const absent = Symbol("absent");
    for (const applePay of [absent, true, false]) {
      for (const googlePay of [absent, "off", "auto", "always"]) {
        for (const whopPay of [absent, true, false]) {
          for (const paypal of [absent, true, false]) {
            const raw = Object.fromEntries(Object.entries({ applePay, googlePay, whopPay, paypal }).filter(([, v]) => v !== absent));
            expectSame(raw);
            expect(expressMethodsOf(raw)).toMatchObject(raw);
          }
        }
      }
    }
  });

  it("unknown keys are dropped and nested values never read", () => {
    for (const raw of [
      { applePay: false, extra: 1, googlePay: "always", nested: { paypal: false } },
      { expressMethods: { applePay: false, googlePay: "off" } },
      { applePay: { value: false }, googlePay: { mode: "off" }, whopPay: [false], paypal: [] },
      { constructor: false, toString: "off", hasOwnProperty: 1 },
      { [Symbol("applePay")]: false, paypal: false },
      // An own "__proto__" key (JSON never sets the prototype): not a field.
      JSON.parse('{"__proto__": {"applePay": false}, "paypal": false}'),
    ]) {
      expectSame(raw);
    }
    expect(Object.keys(expressMethodsOf({ applePay: false, extra: 1 }))).toEqual(["applePay", "googlePay", "whopPay", "paypal"]);
  });

  it("objects of any kind, inherited fields read like the schema reads them", () => {
    class Settings {
      applePay = false;
      googlePay = "always";
    }
    for (const raw of [
      Object.create({ applePay: false, googlePay: "off" }),
      Object.assign(Object.create(null), { whopPay: false, googlePay: "always" }),
      { __proto__: { paypal: false }, applePay: false },
      new Settings(),
      new Date(0),
      new Map([["applePay", false]]),
      Object.freeze({ paypal: false, googlePay: "off" }),
      {
        get googlePay() {
          return "always";
        },
      },
    ]) {
      expectSame(raw);
    }
  });

  it("random settings (seeded): fields absent, valid, stray, plus unknown keys", () => {
    let seed = 20261010;
    const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
    const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)];
    const valid: Record<(typeof KEYS)[number], unknown[]> = { applePay: [true, false], googlePay: ["off", "auto", "always"], whopPay: [true, false], paypal: [true, false] };
    for (let i = 0; i < 2000; i++) {
      const raw: Record<string, unknown> = {};
      for (const key of KEYS) {
        const r = next();
        if (r < 0.25) continue;
        raw[key] = r < 0.6 ? pick(valid[key]) : pick(VALUES);
      }
      if (next() < 0.3) raw[pick(["extra", "googlepay", "apple_pay", "link"])] = pick(VALUES);
      expectSame(raw);
    }
  });

  it("returns a new object and leaves its input as it was", () => {
    const valid = { applePay: false, googlePay: "off", whopPay: true, paypal: false };
    expect(expressMethodsOf(valid)).not.toBe(valid);
    expect(expressMethodsOf(valid)).toStrictEqual(valid);
    const stray = { applePay: "x", extra: 1 };
    expressMethodsOf(stray);
    expect(stray).toStrictEqual({ applePay: "x", extra: 1 });
  });
});
