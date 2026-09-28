import { createBlock, dedupeSingletons, isFixedSection, type Block, type BlockType, type Layout } from "@/lib/layout";

export type Spec = [BlockType, Partial<Pick<Block, "placement" | "position">>?];

export type Template = {
  id: string;
  name: string;
  description: string;
  /** Block types in order, shown as a preview list in the menu. */
  summary: string;
  /** The block stack, drawn as a mini thumbnail. */
  spec: Spec[];
  build: (current: Layout) => Layout;
};

/**
 * Builds a layout from a spec, reusing the page's existing fixed sections (and
 * their custom titles) instead of recreating them.
 */
function fromSpec(spec: Spec[], current: Layout): Layout {
  const blocks = spec.map(([type, overrides]) => {
    if (isFixedSection(type)) {
      const existing = current.blocks.find((b) => b.type === type);
      if (existing) return { ...existing, hidden: false } as Block;
    }
    return createBlock(type, overrides ?? {}) as Block;
  });
  return { blocks: dedupeSingletons(blocks) };
}

function template(t: Omit<Template, "build">): Template {
  return { ...t, build: (c) => fromSpec(t.spec, c) };
}

const TOP: Spec[] = [["express"], ["contact"], ["delivery"], ["shipping_method"]];

export const CHECKOUT_TEMPLATES: Template[] = [
  template({
    id: "minimal",
    name: "Minimal",
    description: "L'essentiel, sans distraction : idéal pour un panier simple.",
    summary: "Paiement express · Contact · Adresse · Mode de livraison · Paiement · Badge sécurisé",
    spec: [...TOP, ["payment"], ["secure_badge"]],
  }),
  template({
    id: "trust",
    name: "Confiance",
    description: "Rassure les nouveaux clients avec des preuves et une garantie.",
    summary: "Minimal + avis, garantie, logos de paiement, avantages",
    spec: [
      ...TOP,
      ["payment"],
      ["payment_icons"],
      ["secure_badge"],
      ["benefits", { placement: "summary" }],
      ["reviews", { placement: "summary" }],
      ["guarantee", { placement: "summary" }],
    ],
  }),
  template({
    id: "conversion",
    name: "Conversion",
    description: "Pousse le panier moyen et l'urgence (avec de vraies données).",
    summary: "Annonce, minuteur, barre livraison offerte, order bump, « Complétez votre commande » + badge sécurisé",
    spec: [
      ["announcement"],
      ["countdown"],
      ["free_shipping_bar"],
      ...TOP,
      ["order_addons"],
      ["payment"],
      ["secure_badge"],
      ["recommendations", { placement: "summary" }],
      ["reviews", { placement: "summary" }],
    ],
  }),
];

const SECTIONS: Spec[] = [["ty_confirmation"], ["ty_details"], ["ty_summary"]];

export const THANK_YOU_TEMPLATES: Template[] = [
  template({
    id: "simple",
    name: "Simple",
    description: "Un remerciement clair et un contact support.",
    summary: "Texte · Confirmation · Adresse · Récapitulatif · Support client",
    spec: [["text"], ...SECTIONS, ["support"]],
  }),
  template({
    id: "loyalty",
    name: "Fidélisation",
    description: "Donne une raison de revenir : code promo et réseaux.",
    summary: "Code promo cadeau · Confirmation · Adresse · Récapitulatif · Réseaux sociaux · Bouton lien",
    spec: [["coupon"], ...SECTIONS, ["social"], ["button_link"]],
  }),
  template({
    id: "upsell",
    name: "Upsell",
    description: "Offre post-achat en un clic, puis réassurance.",
    // The offer right after the confirmation: visible without scrolling on mobile.
    summary: "Confirmation · Offre post-achat · Adresse · Récapitulatif · Date de livraison · Avis clients",
    spec: [["ty_confirmation"], ["upsell"], ["ty_details"], ["ty_summary"], ["delivery_estimate"], ["reviews"]],
  }),
];
