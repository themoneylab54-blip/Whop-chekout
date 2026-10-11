import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { LABEL_TEXTS, LABELS, LANG_CODES, NOT_ON_CHECKOUT, checkoutTextFor, labelsFor, type Lang } from "@/components/checkout/i18n";
import { LABEL_FNS, labelsOf } from "@/components/checkout/i18n-fns";
import { DEFAULT_TEXTS, checkoutCopy, localizeDeliveryTime as fromLocalize } from "@/components/checkout/localize";
import { localizeDeliveryTime } from "@/components/checkout/deliveryTime";
import { SAMPLE_DEFAULTS } from "@/components/checkout/sampleDefaults";
import { ERROR_SCREEN_TEXTS } from "@/components/checkout/errorScreenTexts";
import { createBlock, defaultCheckoutLayout, defaultTheme, type Layout } from "@/lib/layout";
import { SRC, clientGraph, instrumentationClient, segmentFiles } from "./helpers/client-graph";

/*
 * The buyer's checkout page stays light. Its browser bundle (every module its segment files reach,
 * walked from the source) carries none of the checkout's plain texts in the other languages (they come
 * with the page, in the buyer's language only), no group of their short ones, no block default but
 * the example content, and not the dashboard's reviews import, whatever the files are named. French
 * is left out of these checks: the code's own defaults are French (a placeholder, a button's default
 * label), and a table coming back would bring every language. The server sends one language: the
 * page's copy (checkoutCopy) holds that language's texts only, the checkout's own (none of the other
 * pages'), and no block translation. Its pieces put back together are the checkout's texts exactly.
 */

const otherPages = new Set<string>(NOT_ON_CHECKOUT);
const errorScreen = new Set(Object.keys(ERROR_SCREEN_TEXTS.fr));
const exampleContent = new Set(Object.keys(SAMPLE_DEFAULTS.fr));

/** Every string of a table (nested records included), long enough to be told apart from code. */
function strings(v: unknown, min = 12): string[] {
  if (typeof v === "string") return v.length >= min ? [v] : [];
  if (v && typeof v === "object") return Object.values(v).flatMap((x) => strings(x, min));
  return [];
}
/** The plain texts of a language (the error screen's aside: its own module carries them, by design). */
const plainTexts = (lang: Lang, min = 12) => strings(Object.fromEntries(Object.entries(LABEL_TEXTS[lang]).filter(([k]) => !errorScreen.has(k))), min);
/** A language's short plain texts that no other language shares ("Kostenlos", "Pay now"…). */
const shortTexts = (lang: Lang) => {
  const elsewhere = new Set(LANG_CODES.filter((l) => l !== lang).flatMap((l) => strings(LABEL_TEXTS[l], 1)));
  return [...new Set(plainTexts(lang, 1))].filter((t) => t.length < 12 && !elsewhere.has(t));
};
/** A module holding this many short texts of one language holds a table of them (today: 2 at most). */
const SHORT_GROUP = 5;
/** The block defaults of a language (the example content aside: sampleDefaults carries it, by design). */
const blockDefaults = (lang: Lang) => strings(Object.fromEntries(Object.entries(DEFAULT_TEXTS[lang]).filter(([k]) => !exampleContent.has(k))));
/** The languages a buyer's page must never carry (see above for French). */
const OTHER_LANGS = LANG_CODES.filter((l) => l !== "fr");

/** The texts a module's code holds: its string literals, template parts and JSX texts (comments aside). */
function literals(file: string): Set<string> {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.add(node.text);
    else if (ts.isTemplateExpression(node)) [node.head, ...node.templateSpans.map((t) => t.literal)].forEach((part) => out.add(part.text));
    else if (ts.isJsxText(node) && node.text.trim()) out.add(node.text.trim());
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe("the checkout page's browser bundle, light", () => {
  const { files } = clientGraph([...segmentFiles("c/[id]"), ...instrumentationClient()]);
  const sources = [...files].map((f) => ({ file: path.relative(SRC, f), texts: literals(f) }));
  // A text the bundle carries as it is (a table that came back holds each of its texts so).
  const carrying = (texts: string[]) => texts.flatMap((t) => sources.filter((s) => s.texts.has(t)).map((s) => `${s.file}: ${t}`));

  it("walks the page's real modules (not an empty graph that would prove nothing)", () => {
    const rel = sources.map((s) => s.file);
    for (const light of ["components/checkout/CheckoutView.tsx", "components/checkout/i18n-fns.ts", "components/checkout/i18n-core.ts", "components/checkout/deliveryTime.ts", "lib/reviews-order.ts", "lib/legacy-sample.ts"]) expect(rel).toContain(light);
    expect(rel).not.toContain("lib/reviews-import.ts");
  });

  it("carries none of the checkout's plain texts in the other languages, whatever the file", () => {
    expect(OTHER_LANGS.flatMap((lang) => carrying(plainTexts(lang)))).toEqual([]);
  });

  it("carries no group of the other languages' short texts (a table of field labels would bring dozens)", () => {
    const groups = OTHER_LANGS.flatMap((lang) => {
      const short = shortTexts(lang);
      return sources.map((s) => ({ module: `${s.file} (${lang})`, short: short.filter((t) => s.texts.has(t)).length })).filter((g) => g.short >= SHORT_GROUP);
    });
    expect(groups).toEqual([]);
  });

  it("carries no block default but the example content in the other languages, whatever the file", () => {
    expect(OTHER_LANGS.flatMap((lang) => carrying(blockDefaults(lang)))).toEqual([]);
  });

  it("the checks see a table that would come back: the full tables' own modules are caught", () => {
    const tables = literals(path.join(SRC, "components/checkout/i18n.ts"));
    for (const lang of OTHER_LANGS) expect(plainTexts(lang).filter((t) => !tables.has(t))).toEqual([]);
    for (const lang of OTHER_LANGS) {
      expect(shortTexts(lang).filter((t) => !tables.has(t))).toEqual([]);
      expect(shortTexts(lang).length).toBeGreaterThan(5 * SHORT_GROUP);
    }
    const defaults = new Set([...literals(path.join(SRC, "components/checkout/localize.ts")), ...literals(path.join(SRC, "components/checkout/sampleDefaults.ts"))]);
    for (const lang of OTHER_LANGS) expect(blockDefaults(lang).filter((t) => !defaults.has(t))).toEqual([]);
  });
});

describe("the page's copy (checkoutCopy): one language, the checkout's texts only", () => {
  /** The default layout, its text block translated in every language (as a merchant may do). */
  function translatedLayout(): Layout {
    const layout = defaultCheckoutLayout();
    const block = createBlock("text");
    const i18n = Object.fromEntries(LANG_CODES.map((l) => [l, { body: `Texte du marchand traduit (${l}).` }]));
    layout.blocks.push({ ...block, i18n } as typeof block);
    return layout;
  }

  it("holds the language's texts only: no other language's text, no block translation", () => {
    for (const lang of LANG_CODES) {
      const copy = checkoutCopy({ ...defaultTheme("Boutique"), language: lang }, translatedLayout());
      const sent = JSON.stringify(copy);
      const own = new Set([...strings(LABEL_TEXTS[lang], 1), ...strings(DEFAULT_TEXTS[lang], 1)]);
      for (const other of LANG_CODES.filter((l) => l !== lang)) {
        const foreign = [...plainTexts(other), ...blockDefaults(other)].filter((t) => !own.has(t));
        expect(foreign.filter((t) => sent.includes(JSON.stringify(t)))).toEqual([]);
      }
      expect(copy.layout.blocks.filter((b) => b.i18n !== undefined)).toEqual([]);
      // The merchant's translated block, in the buyer's language.
      expect(sent).toContain(`Texte du marchand traduit (${lang}).`);
      expect(copy.theme.language).toBe(lang);
      expect(copy.labelText).toBe(checkoutTextFor(lang));
    }
  });

  it("holds the checkout's own texts: none of the other pages'", () => {
    for (const lang of LANG_CODES) {
      const keys = Object.keys(checkoutCopy({ ...defaultTheme("Boutique"), language: lang }, defaultCheckoutLayout()).labelText);
      expect(keys.filter((k) => otherPages.has(k))).toEqual([]);
      expect(keys.length + otherPages.size).toBe(Object.keys(LABEL_TEXTS[lang]).length);
    }
  });

  it("a checkout component can't read another page's text (it would not compile)", () => {
    const L = labelsOf(checkoutTextFor("fr"), "fr");
    // @ts-expect-error: the thank-you page's title is not a checkout text.
    expect(L.thankYouTitle).toBeUndefined();
  });
});

describe("the checkout's texts, split", () => {
  it("plain texts and formulas put back together are the checkout's texts, in every language", () => {
    for (const lang of LANG_CODES) {
      const L = labelsOf(checkoutTextFor(lang), lang) as Record<string, unknown>;
      const full = Object.fromEntries(Object.entries(labelsFor(lang)).filter(([k]) => !otherPages.has(k)));
      expect(Object.keys(L).sort()).toEqual(Object.keys(full).sort());
      for (const [k, v] of Object.entries(full)) expect(L[k]).toBe(v);
    }
  });

  it("the plain texts are data (they travel with the page): no formula anywhere in them", () => {
    const walk = (v: unknown): void => {
      expect(typeof v).not.toBe("function");
      if (v && typeof v === "object") for (const x of Object.values(v)) walk(x);
    };
    walk(LABEL_TEXTS);
    expect(JSON.parse(JSON.stringify(LABEL_TEXTS))).toEqual(LABEL_TEXTS);
  });

  it("every language has the same plain texts and the same formulas", () => {
    const keys = (o: object) => Object.keys(o).sort();
    for (const lang of LANG_CODES) {
      expect(keys(LABEL_TEXTS[lang])).toEqual(keys(LABEL_TEXTS.fr));
      expect(keys(LABEL_FNS[lang])).toEqual(keys(LABEL_FNS.fr));
      for (const f of Object.values(LABEL_FNS[lang])) expect(typeof f).toBe("function");
    }
    expect(Object.keys(LABELS).sort()).toEqual([...LANG_CODES].sort());
  });

  it("an unknown language: French", () => {
    expect(checkoutTextFor("xx" as never)).toBe(checkoutTextFor("fr"));
    expect(labelsOf(checkoutTextFor("fr"), "xx" as never).items(2)).toBe(LABELS.fr.items(2));
  });
});

describe("the small tables are the full ones", () => {
  it("the block defaults' example content, the error screen's texts, the delivery delays", () => {
    for (const lang of LANG_CODES) {
      for (const [k, v] of Object.entries(SAMPLE_DEFAULTS[lang])) expect((DEFAULT_TEXTS[lang] as Record<string, string>)[k]).toBe(v);
      for (const [k, v] of Object.entries(ERROR_SCREEN_TEXTS[lang])) expect((LABELS[lang] as Record<string, unknown>)[k]).toBe(v);
    }
    expect(fromLocalize).toBe(localizeDeliveryTime);
    expect(localizeDeliveryTime("2 à 3 jours ouvrés", "en")).toBe("2–3 business days");
  });
});
