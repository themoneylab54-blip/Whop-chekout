import type { Store } from "@prisma/client";
import { loadCheckoutLayout, loadTheme, loadThankYouLayout } from "./layout";

type DesignFields = Pick<
  Store,
  "name" | "theme" | "checkoutLayout" | "thankYouLayout" | "draftTheme" | "draftCheckoutLayout" | "draftThankYouLayout"
>;

/** What the builder edits: the draft when there is one, else the published design. */
export function draftDesign(store: DesignFields) {
  return {
    theme: loadTheme(store.draftTheme ?? store.theme, store.name),
    checkoutLayout: loadCheckoutLayout(store.draftCheckoutLayout ?? store.checkoutLayout),
    thankYouLayout: loadThankYouLayout(store.draftThankYouLayout ?? store.thankYouLayout),
  };
}

export function hasDraft(store: Pick<Store, "draftTheme" | "draftCheckoutLayout" | "draftThankYouLayout">) {
  return store.draftTheme != null || store.draftCheckoutLayout != null || store.draftThankYouLayout != null;
}
