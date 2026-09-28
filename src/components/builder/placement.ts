import { createBlock, upsellSellable, type Block, type BlockType } from "@/lib/layout";
import { arrangeCheckout, checkoutZones, type CheckoutZone } from "@/components/checkout/CheckoutView";
import type { DropHint } from "./CanvasOverlays";

/**
 * Merchant-only setup warnings per block id ("Choisir un produit"): a badge on the canvas,
 * an amber mark in the block list, and a list in the publish popover.
 */
export function layoutWarnings(blocks: Block[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const b of blocks) {
    if (b.hidden) continue;
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
  return out;
}

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
