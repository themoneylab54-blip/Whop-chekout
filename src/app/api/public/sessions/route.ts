import { clientIp, memoryRateLimit, rateLimit } from "@/lib/ratelimit";
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
import { prepareAhead } from "@/lib/early-prepare";

export const OPTIONS = preflight;

/** The early prepare (after() the answer) may wait on Whop: the function's budget covers it, as /prepare's. */
export const maxDuration = 60;

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

/**
 * Line properties / cart attributes within the limits (50 keys of 255 characters, 16 KB), else left
 * out (null) rather than refusing the whole cart: the buyer can always pay, and a cart with a token
 * gets its properties from the server's own re-read anyway.
 */
const boundedRecord = z.preprocess(
  (p) => (p && typeof p === "object" && !Array.isArray(p) && Object.keys(p).length <= 50 && Object.keys(p).every((k) => k.length <= 255) && jsonSize(p) <= MAX_PROPERTIES_BYTES ? p : null),
  z.record(z.string(), z.unknown()).nullable().optional(),
);

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
        properties: boundedRecord,
      }),
    )
    .min(1)
    .max(100)
    // Every line's properties together: the cart copy this route keeps stays small (past the budget,
    // a line's properties are left out, never the cart refused).
    .transform((items) => {
      let total = 0;
      return items.map((i) => {
        const size = i.properties ? jsonSize(i.properties) : 0;
        if (total + size > MAX_CART_BYTES) return { ...i, properties: null };
        total += size;
        return i;
      });
    }),
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
  // server re-reads the cart and keeps only what Shopify computed, or refuses the cart.
  appPricing: z.boolean().optional(),
  // Cart note and attributes (copied to the order; the server's re-read wins when there is one).
  note: z.string().max(5000).nullable().optional(),
  attributes: boundedRecord,
  // Random key of this click (loader): a retry (checkout domain timed out, then the app's API)
  // gets the session the first request created, never a second session nor a second conversion.
  requestKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional(),
  // A cart permalink's ?discount=CODE: offered to the quote like the cart's own code (validated there,
  // never trusted as is). Only a code's characters (no spaces: the checkout's notice repeats it, never a
  // sentence a crafted link wrote); anything else is left out, never the cart refused.
  discountCode: z
    .string()
    .trim()
    .regex(/^[\p{L}\p{N}][\p{L}\p{N}_\-.#%+&!*@$€]{0,59}$/u)
    .optional()
    .catch(undefined),
});

/** Transient refusals (Shopify slow, the cart changing, the click's other request still running, a burst). */
// Not an unreadable cart (already read twice) nor the rate limit (the same minute would refuse again).
const RETRYABLE_REASONS = new Set(["price_failed", "pricing_unavailable", "in_progress", "cart_changed"]);

/**
 * A cart the checkout can't open. `native` marks the only carts Shopify's checkout keeps
 * (checkout switched off, subscriptions, gift cards, excluded products): for every other refusal
 * the loader stays on the shop with a "try again" message, never Shopify's checkout. `retryable`
 * marks a transient one (RETRYABLE_REASONS): the loader retries it once on its own first.
 */
function refuse(status: number, error: string, reason: string, native = false, storeId?: string) {
  log.warn("session.refused", "Checkout session refused", { status, reason, ...(storeId ? { storeId } : {}) });
  return json({ error, reason, ...(native ? { native: true, fallback: true } : {}), ...(RETRYABLE_REASONS.has(reason) ? { retryable: true } : {}) }, { status, cors: true });
}

/** Called by the storefront loader with the contents of /cart.js. */
async function handle(req: Request) {
  const t0 = Date.now();
  // Rate limit, store and a replay of this click in one database round trip (in parallel): every
  // serial query here is time the buyer waits after clicking « Checkout ».
  const raw = await readJson(req);
  // The loader's warm-up when the buyer heads for « Checkout » (hover, touch, cart opened): this
  // function and its database connection are awake (and the CORS preflight cached) before the
  // click. Nothing created, no session rate limit spent; capped per IP in memory (no query), so a
  // flood of warm-ups never reaches the database.
  if (raw && typeof raw === "object" && (raw as { warm?: unknown }).warm === true) {
    if (!memoryRateLimit(`warm:ip:${clientIp(req)}`, 30)) return json({ warm: false }, { status: 429, cors: true });
    await db.$queryRaw`SELECT 1`.catch(() => undefined);
    return json({ warm: true }, { cors: true });
  }
  const allowed = rateLimit(`session:ip:${clientIp(req)}`, 20);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    if (!(await allowed)) return refuse(429, "Trop de requêtes", "rate_limited");
    return refuse(400, "Panier invalide", "invalid_body");
  }
  const { store: publicId, items, returnUrl, tracking, visitorId } = parsed.data;
  // Properties or attributes over the limits were left out (the cart is still sold): said in the logs.
  const sent = raw as { items?: { properties?: unknown }[]; attributes?: unknown };
  const dropped = items.filter((i, k) => sent.items?.[k]?.properties && !i.properties).length + (sent.attributes && !parsed.data.attributes ? 1 : 0);
  if (dropped) log.warn("session.properties_dropped", "Line properties or cart attributes over the limits left out", { store: publicId, dropped });
  // Subscriptions (selling plans) and gift cards can't be sold here (no recurring billing, no gift
  // card issuing): the whole cart goes to Shopify's checkout.
  const unsupported = unsupportedCart(items);
  const requestKey = parsed.data.requestKey ?? null;
  const [ok, store, earlier] = await Promise.all([
    allowed,
    db.store.findUnique({ where: { publicId } }),
    requestKey ? db.checkoutSession.findFirst({ where: { requestKey, store: { publicId } }, select: { id: true, visitorId: true } }) : null,
  ]);
  if (!ok) return refuse(429, "Trop de requêtes", "rate_limited", false, store?.id);
  if (unsupported) return refuse(409, unsupported === "selling_plan" ? "Abonnement : checkout Shopify" : "Carte cadeau : checkout Shopify", unsupported, true, store?.id);

  // At least one processor able to take the payment (Whop and/or Stripe, under the store's mode).
  if (!store?.enabled || !store.shopifyConnectedAt || !anyProviderConnected(store) || store.fallbackActiveAt) {
    return refuse(409, "Checkout désactivé", "disabled", true, store?.id);
  }
  // Called on another store's checkout domain: unknown here (refused: the buyer stays on the shop).
  if (await isForeignCheckoutHost(req, store)) return refuse(404, "Boutique introuvable", "foreign_host", false, store.id);

  // Same click already handled: that session again (the first request may also still be running,
  // see the create below).
  const replay = async () => {
    if (!requestKey) return null;
    const done = await db.checkoutSession.findUnique({ where: { storeId_requestKey: { storeId: store.id, requestKey } }, select: { id: true, visitorId: true } });
    return done ? sessionResponse(checkoutBaseUrl(store), done, visitorId) : null;
  };
  if (earlier) return sessionResponse(checkoutBaseUrl(store), earlier, visitorId);

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
    return refuse(502, "Impossible de charger le panier", "price_failed", false, store.id);
  }
  if (lines.length === 0) return refuse(400, "Panier vide", "empty_cart", false, store.id);
  // Gift cards checked on Shopify's own data too (a storefront script could leave the flag out).
  if (lines.some((l) => l.giftCard)) return refuse(409, "Carte cadeau : checkout Shopify", "gift_card", true, store.id);
  // Excluded products keep Shopify's checkout, whatever the storefront script did.
  const excluded = loadInterception(store.interception).excludedHandles;
  if (lines.some((l) => excluded.includes(l.productHandle))) {
    return refuse(409, "Produit géré par le checkout Shopify", "excluded", true, store.id);
  }

  // Touches are kept with their date ("ts"): the attribution window (1/7/28 days) is applied
  // when analytics are read, so the merchant can compare windows on past data.
  const utm = touchWithin(parsed.data.utm, null);
  const firstUtm = touchWithin(parsed.data.firstUtm, null);

  // A/B arms follow the server's signed visitor id, never an id the browser picked.
  const visitor = resolveVisitor(visitorId);
  const cartToken = parsed.data.cartToken ?? null;
  // Line properties, app prices (Cart Transform), bundle components and Shopify's automatic
  // discounts as the server re-read them; a cart that can't be represented line by line is charged
  // as Shopify's cart charges it (Shopify's checkout only for a subscription).
  const cart = await sessionCart(store, cartInput, lines, cartRead);
  if (!cart.ok) return refuse(409, "Panier refusé : " + cart.reason, cart.reason, cart.reason === "subscription", store.id);
  // Lines taken from the re-read cart itself (charged as Shopify's cart charges them): the same rules.
  if (cart.lines.some((l) => excluded.includes(l.productHandle))) return refuse(409, "Produit géré par le checkout Shopify", "excluded", true, store.id);
  lines = cart.lines;
  const { cartDiscounts } = cart;
  // A permalink's code, when the cart carries none of its own: the quote looks it up like the cart's
  // (a cart charged as Shopify's cart charged it keeps its own codes only).
  const linkCode = parsed.data.discountCode;
  const cartContext =
    linkCode && !cart.cartContext?.discountCodes?.length && !cart.cartContext?.cartPriced ? { ...(cart.cartContext ?? {}), discountCodes: [linkCode] } : cart.cartContext;

  // A/B arms of this visitor, both at once.
  const [variantArm, testArms] = await Promise.all([assignVariant(store.id, visitor.id), assignCheckoutTests(store.id, visitor.id)]);
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
        ...variantArm,
        ...(testArms ? { checkoutTestArms: testArms } : {}),
        requestKey,
      },
    })
    // The other request of this click created it meanwhile (unique storeId + requestKey).
    .catch((err: unknown) => {
      if (requestKey && (err as { code?: string } | null)?.code === "P2002") return null;
      throw err;
    });
  // That request's session, and its conversion only.
  if (!session) return (await replay()) ?? refuse(409, "Session en cours de création", "in_progress", false, store.id);
  // Redacted copy of a cart holding app lines (support diagnostics, purged after 7 days).
  if (cart.diagnostic) {
    const d = cart.diagnostic;
    await db.cartSnapshot
      .create({ data: { sessionId: session.id, apps: d.apps, unknownKeys: d.unknownKeys, data: d.data as Prisma.InputJsonValue } })
      .catch((err) => log.warn("cart.snapshot_failed", "Could not keep the cart snapshot", { sessionId: session.id, err }));
  }
  // After the response: ad "InitiateCheckout" event (never slows the buyer down).
  after(() => sendCheckoutConversions(session.id).catch(() => undefined));
  // After the response too: the Whop checkout prepared while the page loads, with the input of the
  // page's first /prepare (same IP country and locale), which then reuses it (express buttons sooner).
  const ahead = { ipCountry: geoCountryOf(req.headers), acceptLanguage: req.headers.get("accept-language") };
  after(() => prepareAhead(session.id, ahead));
  log.info("perf.session_created", "Checkout session created", { ms: Date.now() - t0, lines: lines.length });
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
