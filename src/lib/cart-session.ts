import "server-only";
import type { Store } from "@prisma/client";
import { checkDiscount, subtotal, type CartLine } from "./pricing";
import { db } from "./db";
import { log, recordEvent } from "./log";
import { rateLimit } from "./ratelimit";
import { boundedCartSnapshot, cartCodeAllocations, cartDiscountCodes, cartHeldByApp, detectCartApps, hasBundleHint, oversizedHiddenProperties, sanitizeCartContext, sanitizeProperties, UNSUPPORTED_REASON_TEXT, withClientProperties, type CartContext, type CartJs, type UnsupportedCartReason } from "./cart-fidelity";
import {
  canReadShopifyDiscounts,
  lookupShopifyCodeWithRetry,
  needsCollections,
  productCollections,
  readCartJs,
  shopifyCodeAsDiscount,
  verifiedCart,
  type CartDiscounts,
} from "./shopify-discounts";

/*
 * A new checkout's lines made faithful to the buyer's Shopify cart (bundle / upsell /
 * personalization apps, see lib/cart-fidelity): the server re-reads /cart.js whenever the storefront
 * sent a cart token (never trusting its own flags: a Cart Transform price may not look like one in
 * the browser), carries properties / note /
 * attributes, and refuses (→ Shopify's checkout, journaled "cart.unsupported_app_pricing") what
 * it can't represent rather than charging a wrong price.
 */

export type SessionCartInput = {
  items: { variant_id: string | number; properties?: Record<string, unknown> | null }[];
  cartToken: string | null;
  /** The storefront saw automatic discounts on the cart. */
  automaticDiscounts?: boolean;
  /** The storefront saw lines an app may have priced (bundle components, prices ≠ variant's…). */
  appPricing?: boolean;
  note?: string | null;
  attributes?: Record<string, unknown> | null;
};

/** Size caps of the redacted cart copies (CartSnapshot row, refused cart's journal event). */
const MAX_SNAPSHOT_BYTES = 64_000;
const MAX_EVENT_SNAPSHOT_BYTES = 8_000;

/** Redacted cart kept 7 days (CartSnapshot) when it held app lines or unknown hidden keys. */
export type CartDiagnostic = { apps: string[]; unknownKeys: string[]; data: Record<string, unknown> };

export type SessionCart =
  | { ok: true; lines: CartLine[]; cartDiscounts: CartDiscounts | null; cartContext: CartContext | null; diagnostic: CartDiagnostic | null }
  | { ok: false; reason: UnsupportedCartReason };

/**
 * Whether the storefront's cart gets the server's re-read (discounts, app prices, properties): any
 * cart with a token — the browser's appPricing / automaticDiscounts flags only say what it saw. Pure.
 */
export function needsCartRead(input: SessionCartInput): boolean {
  return !!input.cartToken;
}

/** Whether the storefront flagged the cart as an app's (bundle keys, app prices) or discounted automatically. Pure. */
export function cartLooksApp(input: SessionCartInput): boolean {
  return !!input.appPricing || !!input.automaticDiscounts || input.items.some((i) => hasBundleHint(sanitizeProperties(i.properties)));
}

/** Re-read timeout of a cart the storefront saw as plain: it never delays the checkout by more. */
export const PLAIN_CART_READ_MS = 1500;

/**
 * Starts the cart re-read early (in parallel with the Admin API pricing), or null. A cart the
 * storefront saw as plain gets 1.5 s and no alert on failure (it goes on at the variants' prices);
 * an app's or discounted one 3 s.
 */
export function startCartRead(store: Pick<Store, "id" | "shopDomain">, input: SessionCartInput): Promise<CartJs | null> | null {
  if (!needsCartRead(input)) return null;
  return cartLooksApp(input) ? readCartJs(store, input.cartToken!) : readCartJs(store, input.cartToken!, { timeoutMs: PLAIN_CART_READ_MS, alert: false });
}

/** What sessionCart reads of the store (the cart's code is checked against Shopify's codes). */
export type SessionCartStore = Pick<Store, "id" | "shopDomain" | "shopCurrency" | "shopifyAccessToken" | "shopifyDiscountCodes" | "shopifyScopes" | "shopifyCountsApiOrders">;

export async function sessionCart(
  store: SessionCartStore,
  input: SessionCartInput,
  lines: CartLine[],
  cartRead: Promise<CartJs | null> | null,
): Promise<SessionCart> {
  const clientContext = sanitizeCartContext(input.note, input.attributes);
  const clientHint = !!input.appPricing || input.items.some((i) => hasBundleHint(sanitizeProperties(i.properties)));
  if (cartRead && input.cartToken) {
    // Shopify's automatic discounts are always taken from the re-read cart (the server's figures).
    const verified = await verifiedCart(store, input.cartToken, lines, { discounts: true, cart: cartRead });
    if (verified.status === "unsupported") return refuse(store.id, verified.reason, verified.detail, detectCartApps(verified.cart), verified.cart);
    if (verified.status === "ok") {
      noteOversized(store.id, verified.cart.items ?? []);
      const diagnostic = await diagnose(store.id, verified.cart, verified.lines, verified.discounts);
      // App prices / automatic discounts hold for this exact cart: every line is fixed (lib/checkout linesFor).
      // Items the re-read cart doesn't hold (direct API call): the storefront's properties, as without a cart.
      const inCart = new Set((verified.cart.items ?? []).map((i) => variantKey(i.variant_id ?? i.id)));
      const missing = input.items.filter((i) => !inCart.has(variantKey(i.variant_id)));
      const withProps = missing.length ? withClientProperties(verified.lines, missing) : { ok: true as const, lines: verified.lines };
      if (!withProps.ok) return refuse(store.id, withProps.reason, withProps.detail);
      // An app's lines hold for this exact cart: every line is fixed. A plain cart with a sitewide
      // automatic discount isn't (a change drops that discount, see automaticDiscountFor).
      const frozen = cartHeldByApp(withProps.lines);
      const lines = frozen ? withProps.lines.map((l) => (l.locked ? l : { ...l, locked: true })) : withProps.lines;
      // A code that lowered the cart must be reproducible here, else the buyer would pay more than the
      // cart showed: checked once now (Shopify's checkout takes the cart otherwise).
      const code = await verifyCartCode(store, verified.cart, lines);
      if (!code.ok) return refuse(store.id, "code_unsupported", code.detail, detectCartApps(verified.cart), verified.cart);
      // The cart's discount codes (a /discount/CODE link, Fast Bundle's code): the quote offers them to
      // Shopify's code lookup, so the buyer keeps a valid one (the verified one first).
      const all = cartDiscountCodes(verified.cart);
      const codes = code.check ? [code.check.code, ...all.filter((c) => c.toUpperCase() !== code.check!.code.toUpperCase())].slice(0, 3) : all;
      const cartContext = codes.length ? { ...(verified.context ?? {}), discountCodes: codes, ...(code.check ? { codeCheck: code.check } : {}) } : verified.context;
      return { ok: true, lines, cartDiscounts: verified.discounts, cartContext, diagnostic };
    }
    // Unreadable cart: plain lines keep going as before, an app's can't, nor one the storefront saw
    // discounted automatically (without Shopify's discount the buyer would pay more than the cart).
    if (clientHint || input.automaticDiscounts) return refuse(store.id, "cart_unreadable");
  } else if (clientHint && !input.cartToken) {
    return refuse(store.id, "bundle_without_cart");
  }
  noteOversized(store.id, input.items);
  const withProps = withClientProperties(lines, input.items);
  if (!withProps.ok) return refuse(store.id, withProps.reason, withProps.detail);
  return { ok: true, lines: withProps.lines, cartDiscounts: null, cartContext: clientContext, diagnostic: null };
}

type CodeCheck = NonNullable<CartContext["codeCheck"]>;

/**
 * The code that lowered the cart (a /discount/CODE link, Fast Bundle's code), checked reproducible
 * here: exactly one code, in the shop's currency, one of the app's codes that applies or a Shopify
 * code the store lets the checkout read (asked twice when Shopify doesn't answer) that applies to
 * these lines. `check: null`: no code lowered the cart.
 */
export async function verifyCartCode(
  store: SessionCartStore,
  cart: CartJs,
  lines: CartLine[],
): Promise<{ ok: true; check: CodeCheck | null } | { ok: false; detail: string }> {
  const allocated = cartCodeAllocations(cart);
  if (!allocated.length) return { ok: true, check: null };
  if (allocated.length > 1) return { ok: false, detail: `several codes: ${allocated.map((a) => a.code).join(", ")}` };
  const code = allocated[0].code;
  if (!code) return { ok: false, detail: "untitled code" };
  if (String(cart.currency ?? "").toUpperCase() !== store.shopCurrency.toUpperCase()) return { ok: false, detail: `${code}: currency ${String(cart.currency ?? "")}` };
  const totalCents = typeof cart.total_price === "number" && Number.isFinite(cart.total_price) ? Math.round(cart.total_price) : null;
  if (totalCents == null) return { ok: false, detail: `${code}: no cart total` };
  const buyer = lines.filter((l) => !l.gift);
  const row = await db.discountCode.findFirst({ where: { storeId: store.id, code: { equals: code, mode: "insensitive" } } });
  if (row) {
    const check = checkDiscount(row, subtotal(buyer));
    if (!check.ok) return { ok: false, detail: `${code}: ${check.reason}` };
  } else {
    if (!store.shopifyDiscountCodes || !store.shopifyAccessToken || !canReadShopifyDiscounts(store)) return { ok: false, detail: `${code}: Shopify codes not read` };
    const found = await lookupShopifyCodeWithRetry(store, code);
    if (typeof found === "string") return { ok: false, detail: `${code}: ${found}` };
    const collections = needsCollections(found) ? await productCollections(store, buyer.map((l) => l.productId)).catch(() => null) : new Map<string, string[]>();
    if (!collections) return { ok: false, detail: `${code}: collections unavailable` };
    const applied = shopifyCodeAsDiscount(found, buyer, collections, { country: null, countsApiOrders: store.shopifyCountsApiOrders ?? null });
    if (!applied.ok) return { ok: false, detail: `${code}: ${applied.reason}` };
  }
  return { ok: true, check: { code, totalCents, items: buyer.map((l) => ({ variantId: l.variantId, quantity: l.quantity })) } };
}

const variantKey = (id: unknown) => String(id ?? "").match(/(\d+)\D*$/)?.[1] ?? String(id ?? "");

/** Hidden properties left out for their size (a cut JSON would be invalid app data): logged. */
function noteOversized(storeId: string, items: { properties?: unknown }[]) {
  const names = [...new Set(items.flatMap((i) => oversizedHiddenProperties(i.properties)))];
  if (names.length) log.warn("cart.property_dropped", "Hidden line properties over 2000 characters left out of the checkout", { storeId, names: names.slice(0, 10) });
}

/**
 * Apps recognized in the cart and hidden keys nobody knows yet: journaled (once a day per store and
 * set of apps / keys) so real carts teach us their keys, and a redacted snapshot for support. A cart
 * that looks like a bundle but carries neither a discount nor an app price is flagged (never charged
 * silently at full price without the merchant knowing).
 */
async function diagnose(storeId: string, cart: CartJs, lines: CartLine[], discounts: CartDiscounts | null): Promise<CartDiagnostic | null> {
  const found = detectCartApps(cart);
  const apps = found.apps.filter((a) => a !== "automatic_discount" && a !== "discount_code");
  if (!apps.length && !found.unknownKeys.length) return null;
  const tag = [...apps, ...found.unknownKeys].join(",").slice(0, 200);
  if (await rateLimit(`journal:cart_apps:${storeId}:${tag}`, 1, 24 * 3600_000)) {
    await recordEvent({
      storeId,
      kind: "cart.apps_detected",
      message: `Panier avec des lignes d'app${apps.length ? ` (${apps.join(", ")})` : ""}${found.unknownKeys.length ? ` — clés cachées non reconnues : ${found.unknownKeys.join(", ")}` : ""}.`,
      data: { apps: found.apps, unknownKeys: found.unknownKeys },
    });
  }
  const bundleLike = lines.some((l) => hasBundleHint(l.properties));
  if (bundleLike && !discounts && !lines.some((l) => l.appPrice) && (await rateLimit(`journal:cart_bundle_nodiscount:${storeId}`, 1, 24 * 3600_000))) {
    await recordEvent({
      storeId,
      level: "warn",
      kind: "cart.bundle_without_discount",
      message:
        "Panier marqué par une app de lots sans remise ni prix de lot dans le panier Shopify : l'acheteur paie le prix catalogue. Vérifiez que l'app applique ses remises dans le panier (mode « fonction de remise »), pas seulement au checkout Shopify ou via une commande brouillon.",
      data: { apps: found.apps },
    });
  }
  return { apps: found.apps, unknownKeys: found.unknownKeys, data: boundedCartSnapshot(cart, MAX_SNAPSHOT_BYTES) };
}

async function refuse(storeId: string, reason: UnsupportedCartReason, detail?: string, found?: { apps: string[]; unknownKeys: string[] }, cart?: CartJs): Promise<SessionCart> {
  // One journal entry per store and reason every 10 min (a busy store doesn't flood the journal).
  if (await rateLimit(`journal:cart_unsupported:${storeId}:${reason}`, 1, 10 * 60_000)) {
    await recordEvent({
      storeId,
      level: "warn",
      kind: "cart.unsupported_app_pricing",
      message: `Panier envoyé au checkout Shopify : ${UNSUPPORTED_REASON_TEXT[reason]}.`,
      // A refused cart has no session (CartSnapshot needs one): a redacted, truncated copy rides on the event.
      data: {
        reason,
        ...(detail ? { detail: detail.slice(0, 200) } : {}),
        ...(found ? { apps: found.apps, unknownKeys: found.unknownKeys } : {}),
        ...(cart ? { cart: boundedCartSnapshot(cart, MAX_EVENT_SNAPSHOT_BYTES) } : {}),
      },
    });
  }
  return { ok: false, reason };
}
