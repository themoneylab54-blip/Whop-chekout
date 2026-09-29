import { clientIp, rateLimit } from "@/lib/ratelimit";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { isForeignCheckoutHost } from "@/lib/checkout-domain-check";
import { checkoutBaseUrl } from "@/lib/checkout-domain";
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
import { sessionCart, startCartRead } from "@/lib/cart-session";
import { resolveVisitor, signVisitorId, verifyVisitorId } from "@/lib/visitor";
import { anyProviderConnected } from "@/lib/payment-provider";

export const OPTIONS = preflight;

/** Size caps (JSON characters) of one line's properties / the cart attributes, and of all lines' properties. */
const MAX_PROPERTIES_BYTES = 16_000;
const MAX_CART_BYTES = 64_000;
const jsonSize = (v: unknown) => {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Infinity;
  }
};

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
        // Line item properties of the cart line (personalization, bundle apps' "_…" keys).
        properties: z
          .record(z.string().max(255), z.unknown())
          .refine((p) => Object.keys(p).length <= 50 && jsonSize(p) <= MAX_PROPERTIES_BYTES)
          .nullable()
          .optional(),
      }),
    )
    .min(1)
    .max(100)
    // Every line's properties together: the cart copy this route keeps stays small.
    .refine((items) => items.reduce((n, i) => n + (i.properties ? jsonSize(i.properties) : 0), 0) <= MAX_CART_BYTES),
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
  // The storefront saw lines an app may have priced (bundle components, price ≠ variant's): the
  // server re-reads the cart and keeps only what Shopify computed, or sends the buyer to Shopify.
  appPricing: z.boolean().optional(),
  // Cart note and attributes (copied to the order; the server's re-read wins when there is one).
  note: z.string().max(5000).nullable().optional(),
  attributes: z
    .record(z.string().max(255), z.unknown())
    .refine((a) => Object.keys(a).length <= 50 && jsonSize(a) <= MAX_PROPERTIES_BYTES)
    .nullable()
    .optional(),
  // Random key of this click (loader): a retry (checkout domain timed out, then the app's API)
  // gets the session the first request created, never a second session nor a second conversion.
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
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
  // At least one processor able to take the payment (Whop and/or Stripe, under the store's mode).
  if (!store?.enabled || !store.shopifyConnectedAt || !anyProviderConnected(store) || store.fallbackActiveAt) {
    return json({ error: "Checkout désactivé", fallback: true }, { status: 409, cors: true });
  }
  // Called on another store's checkout domain: unknown here (the loader then uses Shopify's checkout).
  if (await isForeignCheckoutHost(req, store)) return json({ error: "Boutique introuvable", fallback: true }, { status: 404, cors: true });

  // Same click already handled: that session again (the first request may also still be running,
  // see the create below).
  const requestKey = parsed.data.requestKey ?? null;
  const replay = async () => {
    if (!requestKey) return null;
    const done = await db.checkoutSession.findUnique({ where: { storeId_requestKey: { storeId: store.id, requestKey } }, select: { id: true, visitorId: true } });
    return done ? sessionResponse(checkoutBaseUrl(store), done, visitorId) : null;
  };
  const replayed = await replay();
  if (replayed) return replayed;

  // Only accept return URLs on the shop itself, never an arbitrary redirect target.
  const allowedHosts = [store.shopDomain, store.storefrontHost].filter((h): h is string => !!h);
  const safeReturnUrl = returnUrl && isAllowedReturnUrl(returnUrl, allowedHosts) ? returnUrl : null;

  const cartInput = {
    items,
    cartToken: parsed.data.cartToken ?? null,
    automaticDiscounts: parsed.data.automaticDiscounts,
    appPricing: parsed.data.appPricing,
    note: parsed.data.note,
    attributes: parsed.data.attributes,
  };
  // The cart re-read (bundle / discount apps) runs alongside the Admin API pricing.
  const cartRead = startCartRead(store, cartInput);
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
  // Line properties, app prices (Cart Transform), bundle components and Shopify's automatic
  // discounts as the server re-read them; a cart that can't be represented goes to Shopify.
  const cart = await sessionCart(store, cartInput, lines, cartRead);
  if (!cart.ok) return json({ error: "Lot ou prix d'app : checkout Shopify", fallback: true, reason: cart.reason }, { status: 409, cors: true });
  lines = cart.lines;
  const { cartDiscounts, cartContext } = cart;

  const session = await db.checkoutSession
    .create({
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
        ...(cartContext ? { cartContext: cartContext as unknown as Prisma.InputJsonValue } : {}),
        ...(await assignVariant(store.id, visitor.id)),
        ...(await assignCheckoutTests(store.id, visitor.id).then((arms) => (arms ? { checkoutTestArms: arms } : {}))),
        requestKey,
      },
    })
    // The other request of this click created it meanwhile (unique storeId + requestKey).
    .catch((err: unknown) => {
      if (requestKey && (err as { code?: string } | null)?.code === "P2002") return null;
      throw err;
    });
  // That request's session, and its conversion only.
  if (!session) return (await replay()) ?? json({ error: "Session en cours de création", fallback: true }, { status: 409, cors: true });
  // Redacted copy of a cart holding app lines (support diagnostics, purged after 7 days).
  if (cart.diagnostic) {
    const d = cart.diagnostic;
    await db.cartSnapshot
      .create({ data: { sessionId: session.id, apps: d.apps, unknownKeys: d.unknownKeys, data: d.data as Prisma.InputJsonValue } })
      .catch((err) => log.warn("cart.snapshot_failed", "Could not keep the cart snapshot", { sessionId: session.id, err }));
  }
  // After the response: ad "InitiateCheckout" event (never slows the buyer down).
  after(() => sendCheckoutConversions(session.id).catch(() => undefined));
  // The loader keeps the signed id in its cookie (the next checkout of this visitor gets the same arms).
  return json({ id: session.id, url: `${checkoutBaseUrl(store)}/c/${session.id}`, visitorId: visitor.token }, { cors: true });
}

/** The loader's answer for a session an earlier request of the same click created. */
function sessionResponse(base: string, session: { id: string; visitorId: string | null }, token: string | undefined) {
  let visitorToken: string | undefined;
  if (session.visitorId && verifyVisitorId(token) === session.visitorId) visitorToken = token;
  else if (session.visitorId) {
    try {
      visitorToken = signVisitorId(session.visitorId);
    } catch {
      visitorToken = undefined;
    }
  }
  return json({ id: session.id, url: `${base}/c/${session.id}`, visitorId: visitorToken, replayed: true }, { cors: true });
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
