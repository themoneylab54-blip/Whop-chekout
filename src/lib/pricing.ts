/**
 * Pure checkout math. Every amount is an integer number of minor units (cents)
 * so totals never drift through floating point. Nothing here trusts the browser:
 * lines come from Shopify's Admin API, rates/codes/add-ons from the database.
 */

export type CartLine = {
  variantId: string; // gid://shopify/ProductVariant/…
  productId: string;
  productHandle: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPriceCents: number;
  compareAtCents: number | null;
  inventory: number | null; // null when not tracked
  requiresShipping: boolean;
};

export type RateInput = {
  id: string;
  name: string;
  deliveryTime: string | null;
  countries: string[];
  priceCents: number;
  freeOverCents: number | null;
  active: boolean;
};

export type DiscountInput = {
  code: string;
  type: "PERCENT" | "FIXED" | "FREE_SHIPPING";
  value: number;
  minSubtotalCents: number | null;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  usageCount: number;
  active: boolean;
};

export type AddOnInput = { id: string; title: string; priceCents: number; active: boolean };

export type Totals = {
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  addOnsCents: number;
  totalCents: number;
  itemCount: number;
};

export function subtotal(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0);
}

export function itemCount(lines: CartLine[]): number {
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}

export type DiscountCheck = { ok: true } | { ok: false; reason: string };

export function checkDiscount(d: DiscountInput, subtotalCents: number, now = new Date()): DiscountCheck {
  if (!d.active) return { ok: false, reason: "Ce code n'est plus actif" };
  if (d.startsAt && now < d.startsAt) return { ok: false, reason: "Ce code n'est pas encore valable" };
  if (d.endsAt && now > d.endsAt) return { ok: false, reason: "Ce code a expiré" };
  if (d.usageLimit != null && d.usageCount >= d.usageLimit) return { ok: false, reason: "Ce code a atteint sa limite" };
  if (d.minSubtotalCents != null && subtotalCents < d.minSubtotalCents)
    return { ok: false, reason: "Le montant minimum pour ce code n'est pas atteint" };
  return { ok: true };
}

/** Discount applied to merchandise only (never shipping or add-ons). */
export function discountAmount(d: DiscountInput | null, subtotalCents: number): number {
  if (!d) return 0;
  if (d.type === "PERCENT") return Math.min(subtotalCents, Math.round((subtotalCents * clamp(d.value, 0, 100)) / 100));
  if (d.type === "FIXED") return Math.min(subtotalCents, Math.max(0, d.value));
  return 0;
}

export function ratesForCountry(rates: RateInput[], country: string | null): RateInput[] {
  return rates.filter((r) => r.active && (r.countries.length === 0 || (country != null && r.countries.includes(country))));
}

export function shippingAmount(
  rate: RateInput | null,
  discountedSubtotalCents: number,
  discount: DiscountInput | null,
  needsShipping: boolean,
): number {
  if (!needsShipping || !rate) return 0;
  if (discount?.type === "FREE_SHIPPING") return 0;
  if (rate.freeOverCents != null && discountedSubtotalCents >= rate.freeOverCents) return 0;
  return rate.priceCents;
}

export function computeTotals(input: {
  lines: CartLine[];
  rate: RateInput | null;
  discount: DiscountInput | null;
  addOns: AddOnInput[];
}): Totals {
  const sub = subtotal(input.lines);
  const discountCents = discountAmount(input.discount, sub);
  const needsShipping = input.lines.some((l) => l.requiresShipping);
  const shippingCents = shippingAmount(input.rate, sub - discountCents, input.discount, needsShipping);
  const addOnsCents = input.addOns.filter((a) => a.active).reduce((s, a) => s + a.priceCents, 0);
  return {
    subtotalCents: sub,
    discountCents,
    shippingCents,
    addOnsCents,
    totalCents: sub - discountCents + shippingCents + addOnsCents,
    itemCount: itemCount(input.lines),
  };
}

/** Distributes a merchandise discount across lines (largest remainder), for Shopify line prices. */
export function allocateDiscount(lines: CartLine[], discountCents: number): number[] {
  const totals = lines.map((l) => l.unitPriceCents * l.quantity);
  const sum = totals.reduce((a, b) => a + b, 0);
  if (sum === 0 || discountCents === 0) return lines.map(() => 0);
  const raw = totals.map((t) => (t * discountCents) / sum);
  const floored = raw.map(Math.floor);
  let remainder = discountCents - floored.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (remainder <= 0) break;
    floored[i] += 1;
    remainder -= 1;
  }
  return floored;
}

export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function decimalToCents(value: string | number): number {
  return Math.round(Number(value) * 100);
}

export function formatMoney(cents: number, currency: string, locale = "fr-FR"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}
