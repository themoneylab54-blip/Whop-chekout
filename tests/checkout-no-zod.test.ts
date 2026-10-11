import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/*
 * The buyer's checkout page ships no zod: every module the browser loads for /c/[id] (the "use
 * client" modules its segment files reach — the root layout, the page, its error and not-found
 * screens — and everything they import) is walked from the source, parsed as TypeScript, type-only
 * imports aside; none may import zod (~105 KB gzip, on the critical path to the payment form), nor a
 * package that depends on it. Schemas stay on the server (lib/layout); the client takes its
 * constants and helpers from lib/layout-shared.
 */

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
const APP = path.join(SRC, "app");

/** A module of ours for an import (`@/…` or relative, a `.js` written for its `.ts`); null for a package. */
function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  const stem = base.replace(/\.(m?js|jsx)$/, "");
  for (const p of [base, `${stem}.ts`, `${stem}.tsx`, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) if (existsSync(p) && statSync(p).isFile()) return p;
  return null;
}

/** What a module loads at runtime: its imports, re-exports, dynamic import() and require() (type-only ones left out). */
export function runtimeImports(file: string, src = readFileSync(file, "utf8")): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const specs: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        !!clause &&
        (clause.isTypeOnly ||
          (!clause.name && !!clause.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every((e) => e.isTypeOnly)));
      if (!typeOnly) specs.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const typeOnly = node.isTypeOnly || (!!node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every((e) => e.isTypeOnly));
      if (!typeOnly) specs.push(node.moduleSpecifier.text);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      specs.push(node.moduleReference.expression.text);
    } else if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

const isClient = (file: string) => {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
  const first = sf.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === "use client";
};

/** The package a bare specifier names (`@scope/name/sub` → `@scope/name`). */
const packageOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

/** Whether a package of node_modules depends on zod (itself, or a dependency of its own: two levels). */
function packageUsesZod(name: string, depth = 0, seen = new Set<string>()): boolean {
  if (name === "zod") return true;
  if (seen.has(name) || depth > 2 || name.startsWith("node:")) return false;
  seen.add(name);
  const manifest = path.join(ROOT, "node_modules", name, "package.json");
  if (!existsSync(manifest)) return false;
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
  return Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).some((d) => packageUsesZod(d, depth + 1, seen));
}

/** Modules of the browser's bundle for a route: every "use client" module its segment files reach, and their imports. */
function clientGraph(entries: string[]): { files: Set<string>; packages: Set<string>; zod: string[] } {
  const seen = new Set<string>();
  const client = new Set<string>();
  const packages = new Set<string>();
  const zod: string[] = [];
  const walk = (file: string, inClient: boolean, trail: string[]) => {
    const key = `${file}|${inClient}`;
    if (seen.has(key)) return;
    seen.add(key);
    const nowClient = inClient || isClient(file);
    if (nowClient) client.add(file);
    for (const spec of runtimeImports(file)) {
      const next = resolve(file, spec);
      if (next) {
        walk(next, nowClient, [...trail, file]);
        continue;
      }
      if (!nowClient || spec.startsWith("@/") || spec.startsWith(".")) continue;
      packages.add(packageOf(spec));
      if (packageUsesZod(packageOf(spec))) zod.push([...trail, file].map((f) => path.relative(ROOT, f)).join(" → ") + ` → ${spec}`);
    }
  };
  for (const entry of entries) walk(entry, false, []);
  return { files: client, packages, zod };
}

/** A route's segment files, root to leaf: layout, template, page, error, loading, not-found (those that exist). */
function segmentFiles(route: string): string[] {
  const dirs = [APP];
  for (const part of route.split("/").filter(Boolean)) dirs.push(path.join(dirs[dirs.length - 1], part));
  const out: string[] = [path.join(APP, "global-error.tsx")];
  for (const dir of dirs) for (const name of ["layout", "template", "error", "loading", "not-found"]) out.push(path.join(dir, `${name}.tsx`));
  out.push(path.join(dirs[dirs.length - 1], "page.tsx"));
  return out.filter((f) => existsSync(f));
}

describe("the checkout page's browser bundle", () => {
  const route = "c/[id]";

  it("imports no zod (types aside), whatever segment file or client module it goes through", () => {
    const entries = segmentFiles(route);
    // The root layout, the page and its error / not-found screens are all walked.
    for (const f of ["app/layout.tsx", "app/c/[id]/page.tsx", "app/c/[id]/error.tsx", "app/c/[id]/not-found.tsx"]) expect(entries.map((x) => path.relative(SRC, x))).toContain(f);
    const { files, packages, zod } = clientGraph(entries);
    // The walk reaches the checkout's client modules and packages (not an empty graph that would prove nothing).
    for (const f of ["components/checkout/CheckoutView.tsx", "components/checkout/Payment.tsx", "components/checkout/blocks.tsx", "lib/layout-shared.ts"]) expect([...files].map((x) => path.relative(SRC, x))).toContain(f);
    expect([...packages]).toContain("@whop/checkout");
    expect(zod).toEqual([]);
  });

  it("the walk does see zod where the client really loads it (the builder's editor)", () => {
    const { zod } = clientGraph(segmentFiles("dashboard/stores/[storeId]/builder/[page]"));
    expect(zod.length).toBeGreaterThan(0);
  });

  it("every way of loading a module is seen; types only are not", () => {
    const src = [
      'import a from "./a";',
      'import { b } from "./b";',
      'import { type C, d } from "./c";',
      'import "./side-effect";',
      'export * from "./re";',
      'export { e } from "./e";',
      'const f = await import("./f");',
      'const g = require("./g");',
      'import h = require("./h");',
      'import type { T } from "./types";',
      'import { type U, type V } from "./types2";',
      'export type { W } from "./types3";',
      'export { type X } from "./types4";',
      "const s = 'import x from \"./not-code\"';",
    ].join("\n");
    expect(runtimeImports("x.ts", src)).toEqual(["./a", "./b", "./c", "./side-effect", "./re", "./e", "./f", "./g", "./h"]);
    // A `.js` specifier written for the `.ts` module (ESM style).
    expect(resolve(path.join(SRC, "lib/x.ts"), "./layout-shared.js")).toBe(path.join(SRC, "lib/layout-shared.ts"));
    // A package depending on zod counts as zod.
    expect(packageUsesZod("zod")).toBe(true);
    expect(packageUsesZod("react")).toBe(false);
  });
});
