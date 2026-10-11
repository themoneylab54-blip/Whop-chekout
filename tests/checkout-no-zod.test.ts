import path from "node:path";
import { describe, expect, it } from "vitest";
import { SRC, clientGraph, clientPackage, instrumentationClient, packageUsesZod, resolve, runtimeImports, segmentFiles } from "./helpers/client-graph";

/*
 * The buyer's checkout page ships no zod: every module the browser loads for /c/[id] (the "use
 * client" modules its segment files reach — the root layout, the page, its error and not-found
 * screens — and the browser instrumentation, and everything they import) is walked from the source,
 * parsed as TypeScript, type-only imports aside; none may import zod (~105 KB gzip, on the critical
 * path to the payment form), nor a package that depends on it (a package whose entry is "use client"
 * ships even when a server module imports it). A "use server" module ships only as a reference: not
 * walked from the client. Schemas stay on the server (lib/layout); the client takes its constants and
 * helpers from lib/layout-shared.
 */

describe("the checkout page's browser bundle", () => {
  const route = "c/[id]";

  it("imports no zod (types aside), whatever segment file or client module it goes through", () => {
    const entries = segmentFiles(route);
    // The root layout, the page and its error / not-found screens are all walked.
    for (const f of ["app/layout.tsx", "app/c/[id]/page.tsx", "app/c/[id]/error.tsx", "app/c/[id]/not-found.tsx"]) expect(entries.map((x) => path.relative(SRC, x))).toContain(f);
    const { files, packages, zod } = clientGraph([...entries, ...instrumentationClient()]);
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
    // A package whose entry is "use client" ships whoever imports it (Next's own Link module); a plain one doesn't.
    expect(clientPackage("next/dist/client/link", path.join(SRC, "app/c/[id]/page.tsx"))).toBe(true);
    expect(clientPackage("zod", path.join(SRC, "lib/layout.ts"))).toBe(false);
  });
});
