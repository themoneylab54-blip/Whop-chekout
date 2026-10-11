import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LANGS, labelsFor } from "@/components/checkout/i18n";
import { DEFAULT_TEXTS, localizeDeliveryTime, translateDefault } from "@/components/checkout/localize";

/*
 * The checkout's texts, frozen, per language and per table: every plain text, each formula's sentences
 * for sample values, every block default, each French default put in the language and delivery times.
 * The snapshot (one fingerprint each: a changed word changes it) was written by the tables as they
 * were before being split for the buyer's page (plain texts sent per language, formulas apart,
 * defaults put in the buyer's language on the server): the split changed no word. A text changed on
 * purpose updates it (vitest -u), the change itself read in the tables' diff.
 */

/** Arguments every formula is called with (a count, one included in any place, a name, an amount, the reviews note's options). */
const SAMPLES: unknown[][] = [
  [0],
  [1],
  [2],
  [12],
  ["Ana"],
  ["12,00 €"],
  ["Ana", "12,00 €"],
  [3, "12,00 €"],
  ["12,00 €", 3],
  [2, 5],
  ["1", 1],
  ["4,8", "1", 1],
  ["4,8", "120", 120],
  ["Judge.me", { mixed: true }],
  ["Judge.me", { summary: "store" }],
  ["Judge.me", { summary: "store-partial" }],
  [null, { summary: "file" }],
  [null, { summary: { recent: "12" } }],
];

function sentences(f: (...args: unknown[]) => unknown): string[] {
  return SAMPLES.map((args) => {
    try {
      return String(f(...args));
    } catch (e) {
      return `throws ${(e as Error).name}`;
    }
  });
}

/** JSON with every object's keys sorted (a table's order is no text). */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
const fingerprint = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");

const DELAYS = ["2 à 3 jours ouvrés", "24 h", "3 à 5 jours", "Livraison en 48 h", "1 semaine", "Sous 10 jours ouvrés"];

describe("the checkout's texts, frozen", () => {
  it("every table, in every language", () => {
    const tables = Object.fromEntries(
      LANGS.map(({ code }) => {
        const L = labelsFor(code) as Record<string, unknown>;
        const keys = Object.keys(L).sort();
        const plain = Object.fromEntries(keys.filter((k) => typeof L[k] !== "function").map((k) => [k, L[k]]));
        const formulas = Object.fromEntries(keys.filter((k) => typeof L[k] === "function").map((k) => [k, sentences(L[k] as (...args: unknown[]) => unknown)]));
        return [
          code,
          {
            texts: `${Object.keys(plain).length} ${fingerprint(plain)}`,
            formulas: `${Object.keys(formulas).length} ${fingerprint(formulas)}`,
            blockDefaults: `${Object.keys(DEFAULT_TEXTS[code]).length} ${fingerprint(DEFAULT_TEXTS[code])}`,
            frenchDefaultsIn: fingerprint(Object.fromEntries(Object.values(DEFAULT_TEXTS.fr).map((t) => [t, translateDefault(t, code)]))),
            delays: DELAYS.map((t) => localizeDeliveryTime(t, code)).join(" | "),
          },
        ];
      }),
    );
    expect(tables).toMatchSnapshot();
  });
});
