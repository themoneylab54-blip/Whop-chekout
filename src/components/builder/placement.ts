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
import { promiseWarnings, sampleWarnings } from "@/lib/sample-content";
import { arrangeCheckout, checkoutZones, expressWalletsOn, type CheckoutZone } from "@/components/checkout/CheckoutView";
import { headerLogosBlockId, isEmptyInLive, type ContentContext } from "@/components/checkout/blocks";
import { labelsFor } from "@/components/checkout/i18n";
import type { DropHint } from "./CanvasOverlays";

/**
 * Merchant-only warnings per block id: a badge on the canvas, an amber mark in the block list,
 * and a list in the publish popover. Setup warnings (setupWarnings: the block stays hidden from
 * buyers until completed, sample proof included) and example promises (promiseWarnings: to
 * check, never blocking). A setup warning wins over a promise one on the same block.
 */
export function layoutWarnings(blocks: Block[], ctx?: SetupContext): Record<string, string> {
  return { ...promiseWarnings(blocks), ...storeNotes(blocks, ctx), ...setupWarnings(blocks, ctx) };
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

/** Example promises and store notes: listed in amber in the publish popover, never blocking. */
export function reviewNotes(blocks: Block[], ctx?: SetupContext): Record<string, string> {
  return { ...promiseWarnings(blocks), ...storeNotes(blocks, ctx) };
}

export type SetupContext = {
  /** The store has a shipping rate free over an amount (the free-shipping bar's automatic threshold). */
  hasFreeShippingRate?: boolean;
  /** The store has at least one active add-on (order bump): without one the list shows nothing. */
  hasAddOns?: boolean;
  /** Current time (ms), to spot a countdown already over. */
  now?: number;
  /** Theme's express checkout (Apple Pay / Google Pay buttons); unknown = on. */
  expressCheckout?: boolean;
  /** Theme's express buttons (see expressMethodsShown); unknown = the defaults. */
  expressMethods?: Partial<ExpressMethods> | null;
  /** The previewed cart has goods to ship (Google Pay on "auto" hidden then); unknown = yes. */
  shippable?: boolean;
};

/**
 * Blocks buyers won't see until completed: a product / a price ("Choisir un produit"), a
 * countdown end date, a free-shipping threshold, social links, a button URL, a support channel
 * (e-mail, phone or WhatsApp), sample proof to replace (sampleWarnings) — mirrors isEmptyInLive. The free-shipping bar is only checked when the caller knows the
 * store's rates (`hasFreeShippingRate` given).
 */
export function setupWarnings(blocks: Block[], ctx: SetupContext = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const now = ctx.now ?? Date.now();
  for (const b of blocks) {
    if (b.hidden) continue;
    if (b.type === "countdown") {
      const end = Date.parse(b.props.endsAt);
      if (!b.props.endsAt || Number.isNaN(end) || end <= now) out[b.id] = "Minuteur : choisir une date de fin";
      continue;
    }
    if (b.type === "free_shipping_bar") {
      if (!(b.props.threshold > 0) && ctx.hasFreeShippingRate === false)
        out[b.id] = "Indiquer un seuil de livraison offerte (aucun tarif de livraison gratuite dès un montant)";
      continue;
    }
    if (b.type === "order_addons") {
      // The untouched built-in list is only an amber note (storeNotes).
      if (ctx.hasAddOns === false && !untouchedAddons(b)) out[b.id] = "Options : créez-en une dans « Promos & options » ou masquez ce bloc";
      continue;
    }
    if (b.type === "social") {
      const p = b.props;
      if (!p.instagram && !p.tiktok && !p.facebook && !p.youtube) out[b.id] = "Réseaux sociaux : ajouter au moins un lien";
      continue;
    }
    if (b.type === "button_link") {
      if (!b.props.url) out[b.id] = "Bouton : indiquer l'adresse du lien";
      continue;
    }
    if (b.type === "support") {
      const p = b.props;
      if (!p.email.trim() && !p.phone.trim() && !p.whatsapp.replace(/[^\d]/g, "")) out[b.id] = "Support : indiquer un e-mail, un téléphone ou WhatsApp pour l'afficher";
      continue;
    }
    if (b.type === "recommendations") {
      if (!b.props.items.some((it) => it.variantId.trim())) out[b.id] = "Choisir les produits à proposer";
      continue;
    }
    if (b.type !== "upsell") continue;
    if (b.props.productSource === "auto") {
      if (!upsellSellable(b.props)) out[b.id] = "Offre automatique : indiquer un % de remise";
    } else if (!b.props.variantId.trim()) out[b.id] = "Choisir un produit";
    else if (!upsellSellable(b.props)) out[b.id] = "Renseigner le prix de l'offre";
    else if (b.props.variantB?.enabled && !upsellSellable(b.props.variantB)) out[b.id] = "Variante B : choisir un produit et un prix";
  }
  return { ...sampleWarnings(blocks), ...out };
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

/**
 * Visible blocks buyers won't see as the page stands (greyed on the canvas with « Invisible pour
 * vos clients »): whatever the live page skips (isEmptyInLive with preview off — sample-only
 * content, empty text, no end date, no link…) plus the order-bump list without an add-on.
 * Blocks that depend on the buyer's order (low stock, one-click offers, survey) are left out.
 */
export function hiddenFromBuyers(blocks: Block[], ctx: SetupContext = {}): Set<string> {
  const live: ContentContext = {
    labels: labelsFor("fr"),
    lang: "fr",
    lowestInventory: null,
    preview: false,
    subtotalCents: 0,
    // Only its presence counts: a free-shipping rate gives the bar its automatic threshold.
    freeShippingThresholdCents: ctx.hasFreeShippingRate === false ? null : 1,
    money: (c) => String(c),
    note: "",
    setNote: () => {},
    // Offers and survey are shown as buyers see them (they depend on the order).
    demoOffers: true,
    // Checkout: wallets depend on the buyer's device, assumed shown (only certain absences are
    // greyed). Thank-you page (no payment block): no wallet is offered there, as live.
    offeredWallets: blocks.some((b) => b.type === "payment") ? { applePay: true, googlePay: true } : { applePay: false, googlePay: false },
    // Checkout: the payment logos show next to the Payment title, not as a block of their own.
    paymentLogosInHeader: blocks.some((b) => b.type === "payment" && !b.hidden),
  };
  const now = ctx.now ?? Date.now();
  const out = new Set<string>();
  // Its logos show next to the Payment title: seen by buyers (pill « Affichés à côté de « Paiement » »).
  const inHeader = logosInPaymentHeader(blocks, ctx.expressCheckout ?? true, ctx.expressMethods, { shippable: ctx.shippable ?? true });
  for (const b of blocks) {
    if (b.hidden || b.type === "low_stock" || b.id === inHeader) continue;
    if ((b.type === "order_addons" && ctx.hasAddOns === false) || isEmptyInLive(b, live, now)) out.add(b.id);
  }
  return out;
}

export { promiseWarnings, SAMPLE_COUPON_CODE, SAMPLE_DELIVERY_WARNING, SAMPLE_PAYMENT_ICONS_WARNING, SAMPLE_PROMISE_WARNING, sampleWarnings } from "@/lib/sample-content";

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
