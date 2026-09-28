import "server-only";
import { db } from "@/lib/db";
import { ratesForCountry, shippingAmount, type CartLine, type RateInput } from "@/lib/pricing";
import { SAMPLE_LINES, sampleThankYou } from "@/lib/sample";

function isCartLine(v: unknown): v is CartLine {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  return (
    typeof l.variantId === "string" &&
    typeof l.title === "string" &&
    typeof l.quantity === "number" &&
    l.quantity > 0 &&
    typeof l.unitPriceCents === "number" &&
    l.unitPriceCents >= 0
  );
}

/**
 * Cart shown in the builder and the full-screen preview: the products of the store's
 * most recent checkout (real titles, photos and prices), else the generic example.
 * Only product lines are read — never customer data.
 */
export async function previewLines(storeId: string): Promise<{ lines: CartLine[]; real: boolean }> {
  const recent = await db.checkoutSession.findMany({
    where: { storeId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { lines: true },
  });
  for (const s of recent) {
    const raw = Array.isArray(s.lines) ? (s.lines as unknown[]) : [];
    // Free gifts of quantity breaks are not cart lines.
    const lines = raw.filter(isCartLine).filter((l) => !(l as { gift?: boolean }).gift).slice(0, 4);
    if (lines.length > 0) {
      return {
        real: true,
        lines: lines.map((l) => ({
          variantId: l.variantId,
          productId: typeof l.productId === "string" ? l.productId : l.variantId,
          productHandle: typeof l.productHandle === "string" ? l.productHandle : "",
          title: l.title,
          variantTitle: typeof l.variantTitle === "string" ? l.variantTitle : null,
          sku: null,
          imageUrl: typeof l.imageUrl === "string" && /^https?:\/\//.test(l.imageUrl) ? l.imageUrl : null,
          quantity: Math.min(l.quantity, 99),
          unitPriceCents: l.unitPriceCents,
          compareAtCents: typeof l.compareAtCents === "number" ? l.compareAtCents : null,
          inventory: typeof l.inventory === "number" ? l.inventory : null,
          requiresShipping: l.requiresShipping !== false,
        })),
      };
    }
  }
  return { lines: SAMPLE_LINES, real: false };
}

/**
 * Example thank-you data built on the same cart as the checkout preview, with the store's own
 * first home-delivery rate for the sample address (France), so both previews show the same order.
 */
export function previewThankYou(currency: string, lines: CartLine[], rates: RateInput[] = []) {
  const base = sampleThankYou(currency);
  const subtotalCents = lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const forFrance = ratesForCountry(rates, base.address.countryCode);
  const rate = forFrance.find((r) => r.kind !== "pickup") ?? null;
  const shippingCents = rate ? shippingAmount(rate, subtotalCents, null, lines.some((l) => l.requiresShipping !== false)) : base.shippingCents;
  return {
    ...base,
    lines,
    subtotalCents,
    shippingCents,
    totalCents: subtotalCents + shippingCents,
    paymentMethod: "card",
    ...(rate ? { shippingMethod: { name: rate.name, deliveryTime: rate.deliveryTime } } : {}),
  };
}
