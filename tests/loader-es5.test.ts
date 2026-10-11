import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "acorn";
import { describe, expect, it } from "vitest";

/*
 * Storefront loader, its syntax: ES5 only (var, function expressions; no arrow functions, let / const,
 * template literals, classes, spread, for…of…), so the oldest browsers a theme serves still run it. The
 * parser's own setting is checked too: each ES2015+ form below must be refused.
 */

const source = readFileSync(join(process.cwd(), "public/loader.js"), "utf8");
const es5 = (code: string) => parse(code, { ecmaVersion: 5, sourceType: "script" });

describe("loader: ES5 syntax", () => {
  it("public/loader.js parses as ES5", () => {
    expect(() => es5(source)).not.toThrow();
  });

  it("the check refuses ES2015+ syntax", () => {
    const later = [
      "let a = 1;",
      "const a = 1;",
      "var f = () => 1;",
      "var s = `x`;",
      "class A {}",
      "var o = { ...p };",
      "f(...args);",
      "for (var x of y) {}",
      "var { a } = o;",
      "function f(a = 1) {}",
      "var o = { m() {} };",
      "async function f() {}",
      "var n = a ?? b;",
      "var n = a?.b;",
      "f(a, b,);",
    ];
    for (const code of later) expect(() => es5(code), code).toThrow();
    expect(() => es5("var o = { a: 1, }; var f = function () { return [1, 2,]; };")).not.toThrow();
  });
});
