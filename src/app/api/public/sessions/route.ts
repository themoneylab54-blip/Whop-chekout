import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { json, preflight, readJson } from "@/lib/http";
import { priceCart } from "@/lib/shopify";

export const OPTIONS = preflight;

const bodySchema = z.object({
  store: z.string().min(1).max(40),
  items: z
    .array(z.object({ variant_id: z.union([z.string(), z.number()]), quantity: z.number().int().min(1).max(999) }))
    .min(1)
    .max(100),
  returnUrl: z.string().url().max(2000).optional(),
  utm: z.record(z.string(), z.string().max(300)).optional(),
});

/** Called by the storefront loader with the contents of /cart.js. */
export async function POST(req: Request) {
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Panier invalide" }, { status: 400, cors: true });
  const { store: publicId, items, returnUrl, utm } = parsed.data;

  const store = await db.store.findUnique({ where: { publicId } });
  if (!store?.enabled || !store.shopifyConnectedAt || !store.whopConnectedAt) {
    return json({ error: "Checkout désactivé", fallback: true }, { status: 409, cors: true });
  }

  // Only accept return URLs on the shop itself, never an arbitrary redirect target.
  const allowedHosts = [store.shopDomain, store.storefrontHost].filter((h): h is string => !!h);
  const safeReturnUrl = returnUrl && isAllowedReturnUrl(returnUrl, allowedHosts) ? returnUrl : null;

  let lines;
  try {
    lines = await priceCart(store, items.map((i) => ({ variantId: i.variant_id, quantity: i.quantity })));
  } catch (err) {
    console.error("priceCart failed", err);
    return json({ error: "Impossible de charger le panier", fallback: true }, { status: 502, cors: true });
  }
  if (lines.length === 0) return json({ error: "Panier vide", fallback: true }, { status: 400, cors: true });

  const session = await db.checkoutSession.create({
    data: {
      storeId: store.id,
      currency: store.shopCurrency,
      lines: lines as unknown as Prisma.InputJsonValue,
      subtotalCents: lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0),
      returnUrl: safeReturnUrl,
      utm: utm ? (utm as Prisma.InputJsonValue) : undefined,
    },
  });
  return json({ id: session.id, url: `${env.appUrl}/c/${session.id}` }, { cors: true });
}

function isAllowedReturnUrl(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.includes(u.hostname);
  } catch {
    return false;
  }
}
