import type { Store } from "@prisma/client";
import { isFixedSection, loadCheckoutLayout, loadTheme, loadThankYouLayout, type Layout, type Theme } from "./layout";

type DesignFields = Pick<
  Store,
  "name" | "theme" | "checkoutLayout" | "thankYouLayout" | "draftTheme" | "draftCheckoutLayout" | "draftThankYouLayout"
>;

export type Design = { theme: Theme; checkoutLayout: Layout; thankYouLayout: Layout };

/** What the builder edits: the draft when there is one, else the published design. */
export function draftDesign(store: DesignFields): Design {
  return {
    theme: loadTheme(store.draftTheme ?? store.theme, store.name),
    checkoutLayout: loadCheckoutLayout(store.draftCheckoutLayout ?? store.checkoutLayout),
    thankYouLayout: loadThankYouLayout(store.draftThankYouLayout ?? store.thankYouLayout),
  };
}

/** What buyers see, normalised exactly like the draft (same loaders, same migrations). */
export function publishedDesign(store: Pick<Store, "name" | "theme" | "checkoutLayout" | "thankYouLayout">): Design {
  return {
    theme: loadTheme(store.theme, store.name),
    checkoutLayout: loadCheckoutLayout(store.checkoutLayout),
    thankYouLayout: loadThankYouLayout(store.thankYouLayout),
  };
}

export function hasDraft(store: Pick<Store, "draftTheme" | "draftCheckoutLayout" | "draftThankYouLayout">) {
  return store.draftTheme != null || store.draftCheckoutLayout != null || store.draftThankYouLayout != null;
}

/** A design was published at least once (otherwise buyers see the defaults). */
export function hasPublished(store: Pick<Store, "theme" | "checkoutLayout" | "thankYouLayout">) {
  return store.theme != null || store.checkoutLayout != null || store.thankYouLayout != null;
}

/** Key-order independent JSON (undefined fields skipped, as in stored JSON). */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/**
 * Comparable form of a design. Fixed sections exist once per page, so their ids carry no
 * meaning (layouts saved before a section existed get it with a generated id): they are
 * compared by type.
 */
function designKey(d: Design): string {
  const layout = (l: Layout) => ({ blocks: l.blocks.map((b) => (isFixedSection(b.type) ? { ...b, id: b.type } : b)) });
  return canonical([d.theme, layout(d.checkoutLayout), layout(d.thankYouLayout)]);
}

export function sameDesign(a: Design, b: Design): boolean {
  return designKey(a) === designKey(b);
}
