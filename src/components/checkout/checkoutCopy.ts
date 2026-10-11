import type { Layout, Theme } from "@/lib/layout";
import type { CheckoutText } from "./i18n";

declare const oneLanguage: unique symbol;

/**
 * What CheckoutView shows, all in one language: the theme and the layout in the buyer's language
 * (merchant translations, then the shipped defaults translated; the blocks' translations left out, the
 * blocks being in that language already) and the checkout page's plain texts in it. Made only by
 * checkoutCopy (localize, on the server or in the builder): the three never disagree, and the buyer's
 * page never downloads the other languages' texts nor every block default.
 */
export type CheckoutCopy = {
  readonly theme: Theme;
  readonly layout: Layout;
  readonly labelText: CheckoutText;
  readonly [oneLanguage]: true;
};
