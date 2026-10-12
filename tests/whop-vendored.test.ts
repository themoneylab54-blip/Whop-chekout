import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tryToParsePath } from "next/dist/lib/try-to-parse-path";
import nextConfig from "../next.config";
import { WHOP_SDK_PATH } from "@/components/checkout/whopEmbed";
import { config as proxyConfig } from "@/proxy";

/*
 * Whop's vanilla script, served by the app itself (public/vendor): byte for byte the installed
 * @whop/checkout's own build, the one its React embed comes with (so the two open the same frame:
 * tests/whop-embed), under a name carrying that version — served as immutable, a new version is a new
 * name, never an old file kept in a browser's cache — and with the package's license next to it (not
 * immutable: its name never changes). Served without the proxy (src/proxy.ts), as static files are.
 */

const pkg = join(process.cwd(), "node_modules/@whop/checkout");
const { version } = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as { version: string };
const vendored = `public${WHOP_SDK_PATH}`;
const current = `/vendor/whop-checkout-${version}.js`;
/** What to do when the copy isn't the installed package's own. */
const copyIt =
  WHOP_SDK_PATH === current
    ? `copy node_modules/@whop/checkout/dist/static/checkout/index.js over ${vendored} (never edit the copy)`
    : `@whop/checkout is now ${version}: copy its dist/static/checkout/index.js to public${current} (the name changes with the version: browsers keep the old file for a year), set WHOP_SDK_PATH (components/checkout/whopEmbed.ts) to "${current}" and delete ${vendored}`;

describe("Whop's vanilla script, vendored", () => {
  it("is the installed package's own build, byte for byte", () => {
    expect(existsSync(join(process.cwd(), vendored)), `${vendored} is missing: ${copyIt}`).toBe(true);
    const same = readFileSync(join(process.cwd(), vendored)).equals(readFileSync(join(pkg, "dist/static/checkout/index.js")));
    expect(same, `${vendored} is not @whop/checkout ${version}'s dist/static/checkout/index.js: ${copyIt}`).toBe(true);
  });

  it("is named after the installed version, and served as immutable (it only: not its license)", async () => {
    expect(WHOP_SDK_PATH, `WHOP_SDK_PATH is not the installed version's: ${copyIt}`).toBe(current);
    const rules = (await nextConfig.headers?.()) ?? [];
    // Each rule's source as Next matches it (path-to-regexp).
    const immutableFor = (path: string) =>
      rules.some(
        (r) => new RegExp(tryToParsePath(r.source).regexStr ?? "^$").test(path) && r.headers.some((x) => x.key === "Cache-Control" && x.value === "public, max-age=31536000, immutable"),
      );
    expect(immutableFor(WHOP_SDK_PATH)).toBe(true);
    expect(immutableFor("/vendor/whop-checkout-LICENSE.md")).toBe(false);
    expect(immutableFor("/vendor/other.js")).toBe(false);
  });

  it("is served without the proxy (straight from the CDN, on every host), which still sees the pages", () => {
    const [matcher] = proxyConfig.matcher;
    const runs = (path: string) => new RegExp(tryToParsePath(matcher).regexStr ?? "^$").test(path);
    expect(runs(WHOP_SDK_PATH)).toBe(false);
    for (const path of ["/c/abc", "/c/abc/merci", "/dashboard", "/api/public/sessions", "/"]) expect(runs(path), path).toBe(true);
  });

  it("comes with the package's license", () => {
    const license = join(process.cwd(), "public/vendor/whop-checkout-LICENSE.md");
    const same = existsSync(license) && readFileSync(license).equals(readFileSync(join(pkg, "license.md")));
    expect(same, "public/vendor/whop-checkout-LICENSE.md is not @whop/checkout's license.md: copy node_modules/@whop/checkout/license.md over it").toBe(true);
  });
});
