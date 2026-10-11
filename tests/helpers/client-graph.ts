import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import ts from "typescript";

/*
 * The browser bundle of a route, walked from the source (shared by the checkout bundle tests): the
 * "use client" modules its segment files reach, and everything they import (type-only imports aside,
 * dynamic import() included: the walk is conservative).
 */

export const ROOT = path.resolve(__dirname, "..", "..");
export const SRC = path.join(ROOT, "src");
const APP = path.join(SRC, "app");

/** A module of ours for an import (`@/…` or relative, a `.js` written for its `.ts`); null for a package. */
export function resolve(from: string, spec: string): string | null {
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

/** A module's directive ("use client", "use server"), if any. */
const directiveOf = (file: string): string | null => {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, false);
  const first = sf.statements[0];
  return first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) ? first.expression.text : null;
};
const isClient = (file: string) => directiveOf(file) === "use client";

/** Whether a package's entry (as Node resolves it from `from`) is a "use client" module: it ships whoever imports it. */
export function clientPackage(spec: string, from: string): boolean {
  try {
    const entry = createRequire(from).resolve(spec);
    // Comments and other directives ("use strict") may come first.
    return /^\s*(?:(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|["']use strict["'];?)\s*)*["']use client["']/.test(readFileSync(entry, "utf8").slice(0, 2_000));
  } catch {
    return false;
  }
}

/** The package a bare specifier names (`@scope/name/sub` → `@scope/name`). */
const packageOf = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]);

/** Whether a package of node_modules depends on zod (itself, or a dependency of its own: two levels). */
export function packageUsesZod(name: string, depth = 0, seen = new Set<string>()): boolean {
  if (name === "zod") return true;
  if (seen.has(name) || depth > 2 || name.startsWith("node:")) return false;
  seen.add(name);
  const manifest = path.join(ROOT, "node_modules", name, "package.json");
  if (!existsSync(manifest)) return false;
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
  return Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies }).some((d) => packageUsesZod(d, depth + 1, seen));
}

/** Modules of the browser's bundle for a route: every "use client" module its segment files reach, and their imports. */
export function clientGraph(entries: (string | { file: string; client: true })[]): { files: Set<string>; packages: Set<string>; zod: string[] } {
  const seen = new Set<string>();
  const client = new Set<string>();
  const packages = new Set<string>();
  const zod: string[] = [];
  const walk = (file: string, inClient: boolean, trail: string[]) => {
    const key = `${file}|${inClient}`;
    if (seen.has(key)) return;
    seen.add(key);
    // A server action reached from the client ships as a reference only: its imports stay on the server.
    if (inClient && directiveOf(file) === "use server") return;
    const nowClient = inClient || isClient(file);
    if (nowClient) client.add(file);
    for (const spec of runtimeImports(file)) {
      const next = resolve(file, spec);
      if (next) {
        walk(next, nowClient, [...trail, file]);
        continue;
      }
      if (spec.startsWith("@/") || spec.startsWith(".") || spec.startsWith("node:")) continue;
      if (!nowClient && !clientPackage(spec, file)) continue;
      packages.add(packageOf(spec));
      if (packageUsesZod(packageOf(spec))) zod.push([...trail, file].map((f) => path.relative(ROOT, f)).join(" → ") + ` → ${spec}`);
    }
  };
  for (const entry of entries) {
    if (typeof entry === "string") walk(entry, false, []);
    else walk(entry.file, true, []);
  }
  return { files: client, packages, zod };
}

/** A route's segment files, root to leaf: layout, template, page, error, loading, not-found (those that exist). */
export function segmentFiles(route: string): string[] {
  const dirs = [APP];
  for (const part of route.split("/").filter(Boolean)) dirs.push(path.join(dirs[dirs.length - 1], part));
  const out: string[] = [path.join(APP, "global-error.tsx")];
  for (const dir of dirs) for (const name of ["layout", "template", "error", "loading", "not-found"]) out.push(path.join(dir, `${name}.tsx`));
  out.push(path.join(dirs[dirs.length - 1], "page.tsx"));
  return out.filter((f) => existsSync(f));
}

/** The browser instrumentation Next bundles into every page (instrumentation-client, in src/ or at the root), when there is one: client code. */
export const instrumentationClient = (): { file: string; client: true }[] =>
  [SRC, ROOT]
    .flatMap((dir) => ["instrumentation-client.ts", "instrumentation-client.tsx", "instrumentation-client.js"].map((f) => path.join(dir, f)))
    .filter((f) => existsSync(f))
    .map((file) => ({ file, client: true as const }));

