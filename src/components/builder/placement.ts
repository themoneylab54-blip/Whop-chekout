import {
  createBlock,
  expressMethodsAllOff,
  expressMethodsCartDependent,
  expressMethodsShown,
  offeredWalletsFor,
  upsellSellable,
  type Block,
  type BlockType,
  type ExpressMethods,
} from "@/lib/layout";
import { arrangeCheckout, checkoutZones, expressWalletsOn, type CheckoutZone } from "@/components/checkout/CheckoutView";
import { headerLogosBlockId } from "@/components/checkout/blocks";
import type { DropHint } from "./CanvasOverlays";

/**
 * Merchant-only warnings per block id (canvas badge, block list, publish popover): only a product
 * to choose (setupWarnings) and the order-bump list without an add-on (storeNotes).
 */
export function layoutWarnings(blocks: Block[], ctx?: SetupContext): Record<string, string> {
  return { ...storeNotes(blocks, ctx), ...setupWarnings(blocks, ctx) };
}

export const ADDONS_NOTE = "Options : créez-en une dans « Promos & options » ou masquez ce bloc";

/** The order-bump list as shipped (no title of the merchant's own): the built-in block of every checkout. */
function untouchedAddons(b: Block): boolean {
  return b.type === "order_addons" && !b.props.title.trim();
}

/**
 * Amber notes (to check, never blocking, not "à compléter"): the built-in, untouched order-bump
 * list on a store without an active add-on. It simply shows nothing to buyers, so the default
 * layout never counts as incomplete for it; a list the merchant titled is a setup warning instead.
 */
export function storeNotes(blocks: Block[], ctx: SetupContext = {}): Record<string, string> {
  const out: Record<string, string> = {};
  if (ctx.hasAddOns !== false) return out;
  for (const b of blocks) if (!b.hidden && untouchedAddons(b)) out[b.id] = ADDONS_NOTE;
  return out;
}

/** Store notes: listed in amber in the publish popover, never blocking. */
export function reviewNotes(blocks: Block[], ctx?: SetupContext): Record<string, string> {
  return storeNotes(blocks, ctx);
}

export type SetupContext = {
  /** The store has a shipping rate free over an amount (the free-shipping bar's automatic threshold). */
  hasFreeShippingRate?: boolean;
  /** The store has at least one active add-on (order bump): without one the list shows nothing. */
  hasAddOns?: boolean;
  /** Current time (ms). No warning depends on it any more (kept so callers need no change). */
  now?: number;
  /** Theme's express checkout (Apple Pay / Google Pay buttons); unknown = on. */
  expressCheckout?: boolean;
  /** Theme's express buttons (see expressMethodsShown); unknown = the defaults. */
  expressMethods?: Partial<ExpressMethods> | null;
  /** The previewed cart has goods to ship (Google Pay on "auto" hidden then); unknown = yes. */
  shippable?: boolean;
};

/**
 * Blocks that need a PRODUCT chosen before they can sell: a one-click offer without its product
 * (or price), « Complétez votre commande » without products, the order-bump list without an
 * add-on. Nothing else is ever flagged: texts, timers, figures, promises, codes… render live as
 * the builder shows them.
 */
export function setupWarnings(blocks: Block[], ctx: SetupContext = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(setupItems(blocks, ctx)).map(([id, item]) => [id, item.text]));
}

/** One setup item: its text, and whether it is a product to choose (else a setting: a %, a price, an option). */
export type SetupItem = { text: string; product: boolean };

/** setupWarnings with each item's kind (template cards count « produits à choisir » apart). Pure. */
export function setupItems(blocks: Block[], ctx: SetupContext = {}): Record<string, SetupItem> {
  const out: Record<string, SetupItem> = {};
  const product = (id: string, text: string) => (out[id] = { text, product: true });
  const setting = (id: string, text: string) => (out[id] = { text, product: false });
  for (const b of blocks) {
    if (b.hidden) continue;
    if (b.type === "order_addons") {
      // The untouched built-in list is only an amber note (storeNotes).
      if (ctx.hasAddOns === false && !untouchedAddons(b)) setting(b.id, "Options : créez-en une dans « Promos & options » ou masquez ce bloc");
      continue;
    }
    if (b.type === "recommendations") {
      if (!b.props.items.some((it) => it.variantId.trim())) product(b.id, "Choisir les produits à proposer");
      continue;
    }
    if (b.type !== "upsell") continue;
    if (b.props.productSource === "auto") {
      if (!upsellSellable(b.props)) setting(b.id, "Offre automatique : indiquer un % de remise");
    } else if (!b.props.variantId.trim()) product(b.id, "Choisir un produit");
    else if (!upsellSellable(b.props)) setting(b.id, "Renseigner le prix de l'offre");
    else if (b.props.variantB?.enabled && !upsellSellable(b.props.variantB)) product(b.id, "Variante B : choisir un produit et un prix");
  }
  return out;
}

/**
 * A page's setup, as a template card says it: how many products to choose, and the other settings
 * (a % of discount, a price, an add-on to create) as their own short notes. Pure.
 */
export function setupSummary(blocks: Block[], ctx: SetupContext = {}): { products: number; settings: string[] } {
  const items = Object.values(setupItems(blocks, ctx));
  return { products: items.filter((i) => i.product).length, settings: items.filter((i) => !i.product).map((i) => i.text) };
}

/**
 * Checkout: the payment-logos block whose logos buyers see next to the Payment title (drawn there,
 * not as a block): the canvas marks it « Affichés à côté de « Paiement » » instead of greying it.
 * The same wallets as the page itself (CheckoutView's offeredWalletsFor): the express block and
 * section on, and only the wallets the merchant's express settings show for this cart (Google Pay
 * on "auto" not for goods to ship). Device-dependent rendering is assumed (the builder preview).
 */
export function logosInPaymentHeader(
  blocks: Block[],
  expressCheckout = true,
  expressMethods?: Partial<ExpressMethods> | null,
  cart: { shippable: boolean } = { shippable: true },
): string | null {
  const offered = offeredWalletsFor({
    walletsOn: expressWalletsOn(expressCheckout, blocks),
    pickupSelected: false,
    configured: expressMethodsShown(expressMethods, cart).wallets,
    rendered: null,
  });
  return headerLogosBlockId(blocks, offered);
}

/**
 * The express row of the builder's block list: greyed « Désactivé » when buyers never see it
 * (block or section off, every button off). Only Google Pay on "auto" left is no "off" — it shows
 * for carts with nothing to ship — so the row stays normal with a « selon le panier » badge. A
 * hidden row (« Masqué ») gets no badge: buyers never see it, whatever the cart. Pure.
 */
export function expressRowState(
  b: Pick<Block, "type" | "props"> & { hidden?: boolean },
  theme: { expressCheckout: boolean; expressMethods?: Partial<ExpressMethods> | null },
): { off: boolean; badge?: string } {
  if (b.type !== "express") return { off: false };
  // `enabled` missing counts as on (as paypalExpressAllowed reads it).
  if ((b.props as { enabled?: boolean }).enabled === false || !theme.expressCheckout) return { off: true };
  if (!b.hidden && expressMethodsCartDependent(theme.expressMethods)) return { off: false, badge: "selon le panier" };
  return { off: expressMethodsAllOff(theme.expressMethods) };
}

export { SAMPLE_COUPON_CODE } from "@/lib/sample-content";

/**
 * Where "Ajouter un bloc" inserts a block of `type`: after the chosen block, else before
 * Payment (checkout) / at the end — except one-click offers, right after the confirmation.
 */
export function insertionIndex(blocks: Block[], page: "checkout" | "thank-you", insertAfter: string | null, type?: BlockType | null): number {
  const after = insertAfter ? blocks.findIndex((b) => b.id === insertAfter) : -1;
  if (after >= 0) return after + 1;
  const confirmation = blocks.findIndex((b) => b.type === "ty_confirmation");
  if (page === "thank-you" && type === "upsell" && confirmation >= 0) return confirmation + 1;
  const payIndex = blocks.findIndex((b) => b.type === "payment");
  return page === "checkout" && payIndex >= 0 ? payIndex : blocks.length;
}

/** Canvas marker for an insertion index: the top edge of Payment / the first block, else under the block before. */
export function insertionHint(blocks: Block[], at: number): DropHint {
  if (blocks.length === 0) return null;
  if (at < blocks.length && (at === 0 || blocks[at].type === "payment")) return { id: blocks[at].id, edge: "top" };
  return { id: blocks[Math.min(at, blocks.length) - 1].id, edge: "bottom" };
}

/** Rendered zone → short wording of the block list ("Sous le paiement", "Récapitulatif"). */
export function zoneLabel(zone: CheckoutZone | undefined): string | null {
  if (zone === "after") return "Sous le paiement";
  if (zone === "summary" || zone === "reassurance" || zone === "recommendations") return "Récapitulatif";
  return null;
}

const NEW_ID = "__new_block__";

/** Rendered zone of a block of `type` inserted at `at` on the checkout. */
export function insertedZone(blocks: Block[], at: number, type: BlockType): CheckoutZone {
  const draft = { ...createBlock(type), id: NEW_ID } as Block;
  return checkoutZones([...blocks.slice(0, at), draft, ...blocks.slice(at)])[NEW_ID] ?? "form";
}

/**
 * Canvas marker for a checkout insertion, where the new block really shows: next to its
 * neighbour in the same rendered zone (a reassurance widget lands in the summary column,
 * a content block under the payment). null when the zone is empty and has no anchor.
 */
export function renderedInsertionHint(blocks: Block[], at: number, type: BlockType | null | undefined): DropHint {
  if (!type) return insertionHint(blocks, at);
  const draft = { ...createBlock(type), id: NEW_ID } as Block;
  const a = arrangeCheckout([...blocks.slice(0, at), draft, ...blocks.slice(at)]);
  if (a.recommendations?.id === NEW_ID) return null;
  const zones = [a.main, a.after, [...a.summary, ...a.side]];
  const list = zones.find((z) => z.some((b) => b.id === NEW_ID));
  if (!list) return null;
  const i = list.findIndex((b) => b.id === NEW_ID);
  if (i > 0) return { id: list[i - 1].id, edge: "bottom" };
  if (i + 1 < list.length) return { id: list[i + 1].id, edge: "top" };
  // Alone under the payment: right below the last block of the form column.
  if (list === a.after && a.main.length) return { id: a.main[a.main.length - 1].id, edge: "bottom" };
  return null;
}

/** Wording of a rendered zone for "sera inséré …" (the list position when it shows there). */
export function zoneWording(zone: CheckoutZone): string | null {
  if (zone === "reassurance") return "dans le récapitulatif (réassurance ; après le paiement sur mobile)";
  if (zone === "summary") return "dans le récapitulatif";
  if (zone === "recommendations") return "sous le récapitulatif (emplacement fixe)";
  if (zone === "after") return "sous « Paiement »";
  return null;
}

/**
 * A template card's setup line: « 2 produits à choisir », then each other setting as its own short
 * note (never counted as a product); "" when nothing is left to do. Pure.
 */
export function setupText(summary: { products: number; settings: string[] }): string {
  const products = summary.products > 0 ? `${summary.products} produit${summary.products > 1 ? "s" : ""} à choisir` : "";
  return [products, ...summary.settings].filter(Boolean).join(" · ");
}
