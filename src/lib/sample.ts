import type { CartLine } from "./pricing";

/** Example cart shown in the builder and the full-screen preview. */
export const SAMPLE_LINES: CartLine[] = [
  {
    variantId: "sample-1",
    productId: "p1",
    productHandle: "sweat",
    title: "Sweat à capuche",
    variantTitle: "M / Noir",
    sku: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 4990,
    compareAtCents: 6990,
    inventory: 6,
    requiresShipping: true,
  },
  {
    variantId: "sample-2",
    productId: "p2",
    productHandle: "casquette",
    title: "Casquette",
    variantTitle: null,
    sku: null,
    imageUrl: null,
    quantity: 2,
    unitPriceCents: 1999,
    compareAtCents: null,
    inventory: null,
    requiresShipping: true,
  },
];

export function sampleThankYou(currency: string) {
  return {
    status: "PAID" as const,
    orderName: "#1024",
    email: "alex@exemple.fr",
    firstName: "Alex",
    address: { name: "Alex Martin", lines: ["12 rue des Lilas", "75011 Paris"], countryCode: "FR" },
    lines: SAMPLE_LINES,
    currency,
    subtotalCents: 8988,
    discountCents: 0,
    shippingCents: 490,
    addOnsCents: 0,
    totalCents: 9478,
    continueUrl: "#",
  };
}
