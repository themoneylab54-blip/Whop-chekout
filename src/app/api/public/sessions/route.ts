import { clientIp, rateLimit } from "@/lib/ratelimit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { json, preflight, readJson } from "@/lib/http";
import { priceCart } from "@/lib/shopify";
import { loadInterception } from "@/lib/layout";
import { after } from "next/server";
import { sendCheckoutConversions } from "@/lib/conversions";
import { assignVariant } from "@/lib/experiments";
import { assignCheckoutTests } from "@/lib/checkout-tests";
import { unsupportedCart } from "@/lib/pricing";
import { route } from "@/lib/route";
import { log } from "@/lib/log";
import { touchWithin } from "@/lib/analytics";
import { geoCountryOf } from "@/lib/geo";
import { verifiedCartDiscounts } from "@/lib/shopify-discounts";
import { resolveVisitor } from "@/lib/visitor";

export const OPTIONS = preflight;

const bodySchema = z.object({
  store: z.string().min(1).max(40),
  items: z
    .array(
      z.object({
        variant_id: z.union([z.string(), z.number()]),
        quantity: z.number().int().min(1).max(999),
        // Subscription (selling plan) and gift card lines: Shopify's own checkout handles them.
        selling_plan: z.union([z.string(), z.number()]).nullable().optional(),
        gift_card: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(100),
  returnUrl: z.string().url().max(2000).optional(),
  // Last paid touch (utm_* / click ids + "ts", ms since epoch) and the first one ever.
  utm: z
    .record(z.string().max(40), z.string().max(300))
    .refine((u) => Object.keys(u).length <= 16)
    .optional(),
  firstUtm: z
    .record(z.string().max(40), z.string().max(300))
    .refine((u) => Object.keys(u).length <= 16)
    .optional(),
  tracking: z
    .object({
      fbp: z.string().max(200).optional(),
      fbc: z.string().max(300).optional(),
      ttp: z.string().max(200).optional(),
      ttclid: z.string().max(300).optional(),
      ga: z.string().regex(/^\d{1,20}\.\d{1,20}$/).optional(),
      marketing: z.boolean().nullable().optional(),
    })
    .optional(),
  // Server-issued signed id ("<id>.<signature>", see lib/visitor); anything else gets a new one.
  visitorId: z.string().max(100).optional(),
  // Shopify cart token (/cart.js) and whether the storefront saw automatic discounts on it: the
  // server re-reads that cart itself and only keeps what Shopify computed (never these figures).
  cartToken: z.string().regex(/^[\w\-?=&%.:]{8,300}$/).optional(),
  automaticDiscounts: z.boolean().optional(),
});

/** Called by the storefront loader with the contents of /cart.js. */
async function handle(req: Request) {
  if (!(await rateLimit(`session:ip:${clientIp(req)}`, 20))) {
    return json({ error: "Trop de requêtes", fallback: true }, { status: 429, cors: true });
  }
  const parsed = bodySchema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Panier invalide" }, { status: 400, cors: true });
  const { store: publicId, items, returnUrl, tracking, visitorId } = parsed.data;
  // Subscriptions (selling plans) and gift cards can't be sold here (no recurring billing, no gift
  // card issuing): the whole cart goes to Shopify's checkout.
  const unsupported = unsupportedCart(items);
  if (unsupported) return json({ error: unsupported === "selling_plan" ? "Abonnement : checkout Shopify" : "Carte cadeau : checkout Shopify", fallback: true, reason: unsupported }, { status: 409, cors: true });

  const store = await db.store.findUnique({ where: { publicId } });
  if (!store?.enabled || !store.shopifyConnectedAt || !store.whopConnectedAt || store.fallbackActiveAt) {
    return json({ error: "Checkout désactivé", fallback: true }, { status: 409, cors: true });
  }

  // Only accept return URLs on the shop itself, never an arbitrary redirect target.
  const allowedHosts = [store.shopDomain, store.storefrontHost].filter((h): h is string => !!h);
  const safeReturnUrl = returnUrl && isAllowedReturnUrl(returnUrl, allowedHosts) ? returnUrl : null;

  let lines;
  try {
    lines = await priceCart(store, items.map((i) => ({ variantId: i.variant_id, quantity: i.quantity })));
  } catch (err) {
    log.error("checkout.price_failed", "Could not price the cart with Shopify", { err });
    return json({ error: "Impossible de charger le panier", fallback: true }, { status: 502, cors: true });
  }
  if (lines.length === 0) return json({ error: "Panier vide", fallback: true }, { status: 400, cors: true });
  // Gift cards checked on Shopify's own data too (a storefront script could leave the flag out).
  if (lines.some((l) => l.giftCard)) return json({ error: "Carte cadeau : checkout Shopify", fallback: true, reason: "gift_card" }, { status: 409, cors: true });
  // Excluded products keep Shopify's checkout, whatever the storefront script did.
  const excluded = loadInterception(store.interception).excludedHandles;
  if (lines.some((l) => excluded.includes(l.productHandle))) {
    return json({ error: "Produit géré par le checkout Shopify", fallback: true }, { status: 409, cors: true });
  }

  // Touches are kept with their date ("ts"): the attribution window (1/7/28 days) is applied
  // when analytics are read, so the merchant can compare windows on past data.
  const utm = touchWithin(parsed.data.utm, null);
  const firstUtm = touchWithin(parsed.data.firstUtm, null);

  // A/B arms follow the server's signed visitor id, never an id the browser picked.
  const visitor = resolveVisitor(visitorId);
  const cartToken = parsed.data.cartToken ?? null;
  const cartDiscounts =
    cartToken && parsed.data.automaticDiscounts ? await verifiedCartDiscounts(store, cartToken, lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, unitPriceCents: l.unitPriceCents }))) : null;

  const session = await db.checkoutSession.create({
    data: {
      storeId: store.id,
      currency: store.shopCurrency,
      lines: lines as unknown as Prisma.InputJsonValue,
      subtotalCents: lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0),
      returnUrl: safeReturnUrl,
      utm: utm ? (utm as Prisma.InputJsonValue) : undefined,
      firstUtm: firstUtm ? (firstUtm as Prisma.InputJsonValue) : undefined,
      tracking: tracking ? (tracking as Prisma.InputJsonValue) : undefined,
      clientIp: clientIp(req),
      userAgent: req.headers.get("user-agent")?.slice(0, 400) ?? null,
      // Visitor's country from the IP (Vercel), for the funnel by country before any address.
      geoCountry: geoCountryOf(req.headers),
      test: store.testMode,
      visitorId: visitor.id,
      cartToken,
      ...(cartDiscounts ? { cartDiscounts: cartDiscounts as unknown as Prisma.InputJsonValue } : {}),
      ...(await assignVariant(store.id, visitor.id)),
      ...(await assignCheckoutTests(store.id, visitor.id).then((arms) => (arms ? { checkoutTestArms: arms } : {}))),
    },
  });
  // After the response: ad "InitiateCheckout" event (never slows the buyer down).
  after(() => sendCheckoutConversions(session.id).catch(() => undefined));
  // The loader keeps the signed id in its cookie (the next checkout of this visitor gets the same arms).
  return json({ id: session.id, url: `${env.appUrl}/c/${session.id}`, visitorId: visitor.token }, { cors: true });
}

function isAllowedReturnUrl(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && hosts.includes(u.hostname);
  } catch {
    return false;
  }
}

export const POST = route("sessions.create", handle, { cors: true });
