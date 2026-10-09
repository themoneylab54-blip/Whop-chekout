import "server-only";
import type { Store } from "@prisma/client";
import { checkDiscount, subtotal, type CartLine, type LineComponent } from "./pricing";
import { bundleComponents, priceCart } from "./shopify";
import { db } from "./db";
import { log, recordEvent } from "./log";
import { rateLimit } from "./ratelimit";
import {
  boundedCartSnapshot,
  cartCodeAllocations,
  cartDiscountCodes,
  cartHeldByApp,
  cartPricedLines,
  detectCartApps,
  hasBundleHint,
  oversizedHiddenProperties,
  sanitizeCartContext,
  sanitizeProperties,
  UNSUPPORTED_REASON_TEXT,
  withClientProperties,
  type CartContext,
  type CartJs,
  type UnsupportedCartReason,
} from "./cart-fidelity";
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
 * attributes. What it can't represent line by line is charged as Shopify's cart charges it
 * (cartPricedLines, journaled "cart.priced_as_shopify_cart": never below the variant's price without a
 * sign the buyer can't forge, said when replaced; the cart's codes validated and applied for what they
 * took off): the buyer stays on this checkout. Only subscriptions and gift cards go to Shopify's
 * checkout; an unreadable app cart is refused ("cart.unsupported_app_pricing").
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
/** Second re-read of an app's (or discounted) cart Shopify didn't answer for in time, before a retry is asked. */
export const SECOND_CART_READ_MS = 4000;

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
    // An app's (or discounted) cart Shopify didn't answer for in time is asked once more, longer: its
    // prices can't be guessed, and a plain cart goes on at the variants' prices anyway.
    const cart = (await cartRead) ?? (clientHint || input.automaticDiscounts ? await readCartJs(store, input.cartToken, { timeoutMs: SECOND_CART_READ_MS }) : null);
    if (cart) {
      // Shopify's automatic discounts are always taken from the re-read cart (the server's figures).
      const verified = await verifiedCart(store, input.cartToken, lines, { discounts: true, cart: Promise.resolve(cart) });
      if (verified.status === "unsupported") return asShopifyCharges(store, verified.reason, verified.detail, cart, lines);
      if (verified.status === "ok") {
        noteOversized(store.id, verified.cart.items ?? []);
        // App prices / automatic discounts hold for this exact cart: every line is fixed (lib/checkout linesFor).
        // Items the re-read cart doesn't hold (direct API call): the storefront's properties, as without a cart.
        const inCart = new Set((verified.cart.items ?? []).map((i) => variantKey(i.variant_id ?? i.id)));
        const missing = input.items.filter((i) => !inCart.has(variantKey(i.variant_id)));
        let base = verified.lines;
        if (missing.length) {
          const withProps = withClientProperties(verified.lines, missing);
          if (withProps.ok) base = withProps.lines;
          else if (withProps.reason === "bundle_without_cart" || withProps.reason === "bundle_components_unresolved") {
            // An app's line the cart doesn't hold (its price can't be read there): the variant's own price,
            // a Shopify Bundles parent through its components.
            const priced = await withBundleComponents(store, atCatalogPrices(verified.lines, missing));
            if (!priced.ok) return refuse(store.id, priced.reason, priced.detail);
            await journalCatalogPriced(store.id, withProps.reason, withProps.detail);
            base = priced.lines;
          } else return refuse(store.id, withProps.reason, withProps.detail);
        }
        // An app's lines hold for this exact cart: every line is fixed. A plain cart with a sitewide
        // automatic discount isn't (a change drops that discount, see automaticDiscountFor).
        const frozen = cartHeldByApp(base);
        const fixed = frozen ? base.map((l) => (l.locked ? l : { ...l, locked: true })) : base;
        // A code that lowered the cart must be reproducible here, else the buyer would pay more than the
        // cart showed: checked once now (the cart is charged as Shopify charges it otherwise).
        const code = await verifyCartCode(store, verified.cart, fixed);
        if (!code.ok) return asShopifyCharges(store, "code_unsupported", code.detail, cart, lines);
        const diagnostic = await diagnose(store.id, verified.cart, verified.lines, verified.discounts);
        // The cart's discount codes (a /discount/CODE link, Fast Bundle's code): the quote offers them to
        // Shopify's code lookup, so the buyer keeps a valid one (the verified one first).
        const all = cartDiscountCodes(verified.cart);
        const codes = code.check ? [code.check.code, ...all.filter((c) => c.toUpperCase() !== code.check!.code.toUpperCase())].slice(0, 3) : all;
        const cartContext = codes.length ? { ...(verified.context ?? {}), discountCodes: codes, ...(code.check ? { codeCheck: code.check } : {}) } : verified.context;
        return { ok: true, lines: fixed, cartDiscounts: verified.discounts, cartContext, diagnostic };
      }
    }
    // Unreadable twice: plain lines keep going as before, an app's can't, nor one the storefront saw
    // discounted automatically (without Shopify's figures the price would be a guess): a retry is asked.
    if (clientHint || input.automaticDiscounts) return refuse(store.id, "cart_unreadable");
  }
  noteOversized(store.id, input.items);
  const withProps = withClientProperties(lines, input.items);
  if (withProps.ok) return { ok: true, lines: withProps.lines, cartDiscounts: null, cartContext: clientContext, diagnostic: null };
  // No Shopify cart to read (buy now, direct call): an app's line or a bundle parent is sold at the
  // variant's own price with its properties (never below it), the cart fixed — journaled, not refused.
  if (withProps.reason === "bundle_without_cart" || withProps.reason === "bundle_components_unresolved") {
    const priced = await withBundleComponents(store, atCatalogPrices(lines, input.items));
    if (!priced.ok) return refuse(store.id, priced.reason, priced.detail);
    await journalCatalogPriced(store.id, withProps.reason, withProps.detail);
    return { ok: true, lines: priced.lines, cartDiscounts: null, cartContext: clientContext, diagnostic: null };
  }
  return refuse(store.id, withProps.reason, withProps.detail);
}

/**
 * Bundle parents Shopify sells only through their components (Shopify Bundles), without components
 * from a cart: their components from the Admin API, scaled to the line's quantity — never the parent
 * ordered alone (wrong stock). None found: refused.
 */
async function withBundleComponents(
  store: SessionCartStore,
  lines: CartLine[],
): Promise<{ ok: true; lines: CartLine[] } | { ok: false; reason: UnsupportedCartReason; detail?: string }> {
  const parents = lines.filter((l) => l.requiresComponents && !l.gift && !l.components?.length);
  if (!parents.length) return { ok: true, lines };
  let found: Map<string, LineComponent[]>;
  try {
    found = await bundleComponents(store, parents.map((l) => l.variantId));
  } catch (err) {
    log.warn("cart.bundle_components_failed", "Shopify couldn't give a bundle's components", { storeId: store.id, err });
    return { ok: false, reason: "pricing_unavailable" };
  }
  const out: CartLine[] = [];
  for (const l of lines) {
    if (!l.requiresComponents || l.gift || l.components?.length) {
      out.push(l);
      continue;
    }
    const parts = [...found].find(([id]) => variantKey(id) === variantKey(l.variantId))?.[1];
    if (!parts?.length) return { ok: false, reason: "bundle_components_unresolved", detail: l.variantId };
    out.push({ ...l, locked: true, components: parts.map((c) => ({ ...c, quantity: c.quantity * l.quantity, weightCents: c.weightCents * l.quantity })) });
  }
  return { ok: true, lines: out };
}

function journalCatalogPriced(storeId: string, reason: UnsupportedCartReason, detail: string | undefined) {
  return journal(storeId, "cart.catalog_priced", `Lot d'app hors panier Shopify (achat direct) facturé au prix catalogue des variantes : ${UNSUPPORTED_REASON_TEXT[reason]}.`, {
    reason,
    ...(detail ? { detail: detail.slice(0, 200) } : {}),
  });
}

/**
 * A cart the checkout can't represent line by line (an app's price, bundle, code, another currency),
 * charged as Shopify's cart charges it (cartPricedLines: never below the variant's price without a
 * verified sign; the cart's codes go through the checkout's own code pipeline): the buyer stays on
 * this checkout. Every line is the Admin API's (the cart's own variants priced here too); a bundle
 * parent sold only through its components gets them from the Admin API. Subscriptions and gift cards
 * go to Shopify's checkout; a cart that can't be priced that way is refused.
 */
async function asShopifyCharges(store: SessionCartStore, reason: UnsupportedCartReason, detail: string | undefined, cart: CartJs, lines: CartLine[]): Promise<SessionCart> {
  const found = detectCartApps(cart);
  if (reason === "subscription") return refuse(store.id, reason, detail, found, cart);
  let admin = lines;
  let components = new Map<string, LineComponent[]>();
  try {
    // The cart's own variants the storefront didn't send (it chose which ones to send): sellable ones only.
    const known = new Set(lines.map((l) => variantKey(l.variantId)));
    const others = (cart.items ?? []).filter((i) => Number(i.quantity ?? 0) > 0 && !known.has(variantKey(i.variant_id ?? i.id)));
    if (others.length) admin = [...lines, ...(await priceCart(store, others.map((i) => ({ variantId: String(i.variant_id ?? i.id ?? ""), quantity: Number(i.quantity) }))))];
    const parents = admin.filter((l) => l.requiresComponents && !l.gift).map((l) => l.variantId);
    if (parents.length) components = await bundleComponents(store, parents);
  } catch (err) {
    log.warn("cart.priced_lookup_failed", "Shopify couldn't price the cart's own lines", { storeId: store.id, err });
    return refuse(store.id, "pricing_unavailable", detail, found, cart);
  }
  const priced = cartPricedLines(cart, admin, store.shopCurrency, components);
  if (!priced.ok) return refuse(store.id, priced.reason, priced.detail ?? detail, found, cart);
  noteOversized(store.id, cart.items ?? []);
  await journal(store.id, "cart.priced_as_shopify_cart", `Panier facturé comme le panier Shopify (jamais sous le prix catalogue sans preuve) : ${UNSUPPORTED_REASON_TEXT[reason]}.`, {
    reason,
    ...(detail ? { detail: detail.slice(0, 200) } : {}),
    apps: found.apps,
    unknownKeys: found.unknownKeys,
    cart: boundedCartSnapshot(cart, MAX_EVENT_SNAPSHOT_BYTES),
  });
  const context = sanitizeCartContext(cart.note, cart.attributes);
  // The cart's codes: applied by the quote like a typed code (validated, limits and uses counted), for
  // exactly what each took off in Shopify's cart — the one that took the most first.
  const allocated = cartCodeAllocations(cart).map((c) => c.code);
  const codes = [...allocated, ...cartDiscountCodes(cart).filter((c) => !allocated.some((a) => a.toUpperCase() === c.toUpperCase()))].slice(0, 3);
  const cartPriced = {
    reason,
    discounted: priced.discounted,
    ...(priced.raised ? { raised: true } : {}),
    ...(Object.keys(priced.codeCents).length ? { codeCents: priced.codeCents } : {}),
    codesTakenOff: priced.codesTakenOff,
  };
  return {
    ok: true,
    lines: priced.lines,
    // Shopify's automatic discounts are in the cart's prices already: none on top.
    cartDiscounts: null,
    cartContext: { ...(context ?? {}), ...(codes.length ? { discountCodes: codes } : {}), cartPriced },
    diagnostic: await diagnose(store.id, cart, priced.lines, null, { cartPriced: true }),
  };
}

/** Lines without a Shopify cart to read, at the variants' own prices, with the storefront's properties, fixed. Pure. */
function atCatalogPrices(lines: CartLine[], items: SessionCartInput["items"]): CartLine[] {
  const props = new Map<string, ReturnType<typeof sanitizeProperties>>();
  for (const it of items) if (!props.has(variantKey(it.variant_id))) props.set(variantKey(it.variant_id), sanitizeProperties(it.properties));
  return lines.map((l) => {
    const p = props.get(variantKey(l.variantId));
    return { ...l, ...(p?.length ? { properties: p } : {}), locked: true };
  });
}

/** One journal entry per store and kind / reason every 10 min (a busy store doesn't flood the journal). */
async function journal(storeId: string, kind: string, message: string, data: Record<string, unknown> & { reason: string }) {
  if (await rateLimit(`journal:${kind}:${storeId}:${data.reason}`, 1, 10 * 60_000)) {
    await recordEvent({ storeId, level: "warn", kind, message, data });
  }
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
async function diagnose(storeId: string, cart: CartJs, lines: CartLine[], discounts: CartDiscounts | null, opts: { cartPriced?: boolean } = {}): Promise<CartDiagnostic | null> {
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
  // A cart charged as Shopify's cart charges it has its discounts in its prices: nothing to flag.
  const bundleLike = !opts.cartPriced && lines.some((l) => hasBundleHint(l.properties));
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
      message:
        reason === "subscription"
          ? `Panier envoyé au checkout Shopify : ${UNSUPPORTED_REASON_TEXT[reason]}.`
          : `Panier impossible à ouvrir au checkout : ${UNSUPPORTED_REASON_TEXT[reason]}.`,
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
