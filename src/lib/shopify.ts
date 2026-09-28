import "server-only";
import { extFetch } from "./ext";
import { createHmac } from "node:crypto";
import type { Store } from "@prisma/client";
import { decrypt, safeEqual } from "./crypto";
import { env } from "./env";
import { log } from "./log";
import { assertBreakerClosed, boundedTimeout, breakerOpen, isTimeoutError, timeLeft, tripBreaker } from "./deadline";
import { allocateDiscount, centsToDecimal, productKey, type CartLine } from "./pricing";
import { splitOverComponents, type CartContext } from "./cart-fidelity";

export const SHOPIFY_API_VERSION = "2026-07";

export const SHOPIFY_SCOPES = [
  "read_products",
  "read_inventory",
  "write_orders",
  // One-click offers are added to the checkout's own order (order edits).
  "write_order_edits",
  "write_customers",
  "write_script_tags",
  // Shopify discount codes accepted on the checkout (codeDiscountNodeByCode).
  "read_discounts",
] as const;

export const GATEWAY_NAME = "Whop";

/* ------------------------------------------------------------------ */
/* OAuth                                                               */
/* ------------------------------------------------------------------ */

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function normalizeShopDomain(input: string): string | null {
  const d = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const full = d.includes(".") ? d : `${d}.myshopify.com`;
  return SHOP_DOMAIN.test(full) ? full : null;
}

export function oauthCallbackUrl() {
  return `${env.appUrl}/api/shopify/callback`;
}

export function installUrl(shop: string, clientId: string, state: string) {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: SHOPIFY_SCOPES.join(","),
    redirect_uri: oauthCallbackUrl(),
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params}`;
}

/** Verifies the `hmac` query parameter Shopify appends to OAuth redirects. */
export function verifyOauthHmac(query: URLSearchParams, clientSecret: string): boolean {
  const hmac = query.get("hmac");
  if (!hmac) return false;
  const message = [...query.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const digest = createHmac("sha256", clientSecret).update(message).digest("hex");
  return safeEqual(digest, hmac);
}

export async function exchangeCodeForToken(shop: string, clientId: string, clientSecret: string, code: string) {
  const res = await extFetch("shopify", "oauth token", `https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  if (!res.ok) throw new Error(`Shopify a refusé l'échange du code OAuth (${res.status})`);
  return (await res.json()) as { access_token: string; scope: string };
}

/* ------------------------------------------------------------------ */
/* GraphQL client                                                      */
/* ------------------------------------------------------------------ */

/**
 * `transient`: Shopify didn't answer (network, timeout), was unavailable (5xx) or throttled us:
 * the same call may succeed later. Other errors are Shopify's own definite answer.
 */
export class ShopifyError extends Error {
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

type ConnectedStore = Pick<Store, "shopDomain" | "shopifyAccessToken">;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Admin GraphQL call with a 12 s timeout, and up to 2 attempts with backoff when
 * Shopify is throttling (429 / THROTTLED) or briefly unavailable (5xx, network), so
 * one call always fits the background budget. Each call is logged with its duration
 * and Shopify's request id (to escalate a problem to Shopify).
 */
export async function shopifyGraphql<T>(
  store: ConnectedStore,
  query: string,
  variables: Record<string, unknown> = {},
  // Non-idempotent mutations (orderCreate, refundCreate) must not be re-sent blindly:
  // a timeout may hide a success. Their callers dedupe at a higher level instead.
  opts: { retry?: boolean } = {},
): Promise<T> {
  if (!store.shopDomain || !store.shopifyAccessToken) throw new ShopifyError("Boutique Shopify non connectée");
  const token = decrypt(store.shopifyAccessToken);
  const attempts = opts.retry === false ? 1 : 2;
  const op = /^\s*(query|mutation)\b[^{]*\{\s*(\w+)/.exec(query)?.[2] ?? "graphql";
  let lastError: unknown;
  // Inside a bounded run: never past the run's (or the money job's) deadline. A non-idempotent
  // mutation needs a real window (a cut-short orderCreate leaves an ambiguous outcome), a read 3 s.
  const minMs = opts.retry === false ? 8_000 : 3_000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const backoff = 400 * 2 ** attempt + Math.random() * 300;
      // No time left for the retry: the first attempt's real (transient) failure is the outcome —
      // never a DeadlineError, which would hide it (no attempt counted, no backoff, never given up).
      const left = timeLeft();
      if (left != null && left - backoff < minMs) throw lastError;
      await new Promise((r) => setTimeout(r, backoff));
    }
    // Shopify hung earlier in this background run: a retry throws this call's real failure (counted),
    // a first attempt is refused at once (DeadlineError: nothing sent, the Whop-side jobs keep their time).
    if (breakerOpen("shopify")) {
      if (attempt > 0 && lastError) throw lastError;
      assertBreakerClosed("shopify", `Shopify ${op}`);
    }
    let timeout: number;
    try {
      timeout = boundedTimeout(12_000, `Shopify ${op}`, minMs);
    } catch (err) {
      if (attempt > 0 && lastError) throw lastError;
      throw err;
    }
    let res: Response;
    const started = Date.now();
    try {
      res = await fetch(`https://${store.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      log.warn("ext.call", `Shopify ${op} failed`, { provider: "shopify", op, ms: Date.now() - started, attempt, err });
      if (isTimeoutError(err) && tripBreaker("shopify", `Shopify ${op}`)) {
        log.warn("tick.breaker_open", `Shopify hung (${op}): its calls are suspended for the rest of this run`, { provider: "shopify", op, ms: Date.now() - started });
      }
      lastError = new ShopifyError(`Shopify injoignable : ${err instanceof Error ? err.message : String(err)}`, true);
      continue;
    }
    const ms = Date.now() - started;
    const upstreamId = res.headers.get("x-request-id");
    (ms > 5000 || !res.ok ? log.warn : log.info)("ext.call", `Shopify ${op} ${res.status} in ${ms} ms`, { provider: "shopify", op, status: res.status, ms, attempt, upstreamId });
    if (RETRYABLE.has(res.status)) {
      lastError = new ShopifyError(`Shopify API ${res.status}: ${(await res.text()).slice(0, 300)}`, true);
      continue;
    }
    if (!res.ok) throw new ShopifyError(`Shopify API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (json.errors?.some((e) => e.extensions?.code === "THROTTLED")) {
      lastError = new ShopifyError("Shopify API throttled", true);
      continue;
    }
    if (json.errors?.length) throw new ShopifyError(json.errors.map((e) => e.message).join("; "));
    return json.data as T;
  }
  throw lastError;
}

function assertNoUserErrors(errors: { field?: string[] | null; message: string }[] | undefined, what: string) {
  if (errors?.length) {
    throw new ShopifyError(`${what}: ${errors.map((e) => `${e.field?.join(".") ?? ""} ${e.message}`.trim()).join("; ")}`);
  }
}

/* ------------------------------------------------------------------ */
/* Shop & script tag                                                   */
/* ------------------------------------------------------------------ */

export async function getShopInfo(store: ConnectedStore) {
  const data = await shopifyGraphql<{
    shop: { name: string; currencyCode: string; primaryDomain: { host: string } | null };
  }>(store, `query { shop { name currencyCode primaryDomain { host } } }`);
  return data.shop;
}

export function loaderUrl(publicId: string) {
  return `${env.appUrl}/loader.js?store=${encodeURIComponent(publicId)}`;
}

/** Installs (or reuses) the storefront loader. Returns the ScriptTag gid. */
export async function ensureScriptTag(store: ConnectedStore & { publicId: string }): Promise<string> {
  const src = loaderUrl(store.publicId);
  const existing = await shopifyGraphql<{ scriptTags: { nodes: { id: string; src: string }[] } }>(
    store,
    `query($src: URL) { scriptTags(first: 10, src: $src) { nodes { id src } } }`,
    { src },
  );
  if (existing.scriptTags.nodes[0]) return existing.scriptTags.nodes[0].id;
  const data = await shopifyGraphql<{
    scriptTagCreate: { scriptTag: { id: string } | null; userErrors: { field: string[]; message: string }[] };
  }>(
    store,
    `mutation($input: ScriptTagInput!) { scriptTagCreate(input: $input) { scriptTag { id } userErrors { field message } } }`,
    { input: { src, displayScope: "ONLINE_STORE", cache: false } },
  );
  assertNoUserErrors(data.scriptTagCreate.userErrors, "Installation du script");
  return data.scriptTagCreate.scriptTag!.id;
}

export async function removeScriptTag(store: ConnectedStore, id: string) {
  const data = await shopifyGraphql<{ scriptTagDelete: { userErrors: { field: string[]; message: string }[] } }>(
    store,
    `mutation($id: ID!) { scriptTagDelete(id: $id) { deletedScriptTagId userErrors { field message } } }`,
    { id },
  );
  assertNoUserErrors(data.scriptTagDelete.userErrors, "Suppression du script");
}

/* ------------------------------------------------------------------ */
/* Catalog: server-side pricing of the cart                            */
/* ------------------------------------------------------------------ */

type VariantNode = {
  __typename: "ProductVariant";
  id: string;
  title: string;
  sku: string | null;
  price: string;
  compareAtPrice: string | null;
  availableForSale: boolean;
  inventoryQuantity: number | null;
  /** Bundle parent sold through its components only (absent from old API versions: guarded). */
  requiresComponents?: boolean | null;
  inventoryItem: { tracked: boolean; requiresShipping: boolean; unitCost: { amount: string } | null } | null;
  image: { url: string } | null;
  product: { id: string; title: string; handle: string; status: string; hasOnlyDefaultVariant: boolean; featuredImage: { url: string } | null; isGiftCard?: boolean };
};

export function variantGid(id: string | number): string {
  const s = String(id);
  return s.startsWith("gid://") ? s : `gid://shopify/ProductVariant/${s}`;
}

/** Prices cart items from the Admin API. Unknown or unavailable variants are dropped. */
export async function priceCart(
  store: ConnectedStore,
  items: { variantId: string | number; quantity: number }[],
): Promise<CartLine[]> {
  const merged = new Map<string, number>();
  for (const item of items) {
    const gid = variantGid(item.variantId);
    merged.set(gid, (merged.get(gid) ?? 0) + Math.max(0, Math.floor(item.quantity)));
  }
  const ids = [...merged.keys()].slice(0, 100);
  if (ids.length === 0) return [];
  const data = await shopifyGraphql<{ nodes: (VariantNode | null)[] }>(
    store,
    `query($ids: [ID!]!) {
      nodes(ids: $ids) {
        __typename
        ... on ProductVariant {
          id title sku price compareAtPrice availableForSale inventoryQuantity requiresComponents
          inventoryItem { tracked requiresShipping unitCost { amount } }
          image { url }
          product { id title handle status hasOnlyDefaultVariant isGiftCard featuredImage { url } }
        }
      }
    }`,
    { ids },
  );
  return data.nodes
    // Draft/archived products are never sellable through the checkout, even by variant id.
    .filter((n): n is VariantNode => n?.__typename === "ProductVariant" && n.availableForSale && n.product.status === "ACTIVE")
    .map((n) => ({
      variantId: n.id,
      productId: n.product.id,
      productHandle: n.product.handle,
      title: n.product.title,
      variantTitle: n.product.hasOnlyDefaultVariant ? null : n.title,
      sku: n.sku,
      imageUrl: n.image?.url ?? n.product.featuredImage?.url ?? null,
      quantity: merged.get(n.id) ?? 0,
      unitPriceCents: Math.round(Number(n.price) * 100),
      compareAtCents: n.compareAtPrice ? Math.round(Number(n.compareAtPrice) * 100) : null,
      inventory: n.inventoryItem?.tracked ? n.inventoryQuantity : null,
      requiresShipping: n.inventoryItem?.requiresShipping ?? true,
      unitCostCents: n.inventoryItem?.unitCost ? Math.round(Number(n.inventoryItem.unitCost.amount) * 100) : null,
      ...(n.product.isGiftCard ? { giftCard: true } : {}),
      ...(n.requiresComponents === true ? { requiresComponents: true } : {}),
    }))
    .filter((l) => l.quantity > 0);
}

/* ------------------------------------------------------------------ */
/* Orders                                                              */
/* ------------------------------------------------------------------ */

export type Address = {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string | null;
  city: string;
  province?: string | null;
  zip: string;
  countryCode: string;
  phone?: string | null;
};

export type PaidOrderInput = {
  sessionId: string;
  currency: string;
  email: string;
  acceptsMarketing: boolean;
  buyerNote?: string | null;
  /** The Shopify cart's note and attributes (the order's note and "additional details"). */
  cart?: CartContext | null;
  /** Titles of Shopify's automatic discounts in the paid amount (e.g. a Kaching deal), for the note. */
  automaticTitles?: string[];
  shippingAddress: Address | null;
  /** Relay point: becomes the shipping address, the buyer's own address stays the billing one. */
  pickupPoint?: { provider: string; id: string; name: string; address1: string; zip: string; city: string; countryCode: string } | null;
  lines: CartLine[];
  addOns: { title: string; priceCents: number; variantId: string | null }[];
  /**
   * `nativeCodeCents`: part of amountCents from a Shopify discount code, recorded as the order's
   * discount code (Shopify deducts it) instead of being folded into the line prices.
   */
  discount: { code: string; amountCents: number; freeShipping: boolean; nativeCodeCents?: number } | null;
  /**
   * Shopify's automatic discount in amountCents (`cents`) and its part per line when the cart said
   * (variant id → cents): those parts go to their own lines first, only the rest is spread by value.
   */
  automaticDiscount?: { cents: number; lineCents?: Record<string, number> } | null;
  shipping: { title: string; priceCents: number } | null;
  totalCents: number;
  whopPaymentId: string;
  test: boolean;
};

function money(cents: number, currency: string) {
  return { shopMoney: { amount: centsToDecimal(cents), currencyCode: currency } };
}

/**
 * The folded merchandise discount per line: Shopify's automatic discount first on the lines it
 * applied to (its per-line amounts, capped at each line and at the folded total), then the rest
 * spread by what each line has left (largest remainders). Adds up exactly to `foldedCents`
 * (never more than a line's value). Pure.
 */
export function allocateOrderDiscount(lines: CartLine[], foldedCents: number, automatic: { cents: number; lineCents?: Record<string, number> } | null): number[] {
  const value = lines.map((l) => l.unitPriceCents * l.quantity);
  const parts = lines.map(() => 0);
  let budget = Math.max(0, Math.min(foldedCents, Math.round(automatic?.cents ?? 0)));
  for (const [variantId, cents] of Object.entries(automatic?.lineCents ?? {})) {
    let want = Math.min(budget, Math.max(0, Math.round(Number(cents) || 0)));
    budget -= want;
    // A variant on several lines (Kaching's paid + free lines of one variant) takes it line by line,
    // an app's gift first (the discount that makes it free is on it in Shopify's cart).
    const order = lines.map((_, i) => i).sort((a, b) => Number(!!lines[b].appGift) - Number(!!lines[a].appGift));
    order.forEach((i) => {
      const l = lines[i];
      if (want <= 0 || l.gift || productKey(l.variantId) !== productKey(variantId)) return;
      const take = Math.min(want, value[i] - parts[i]);
      parts[i] += take;
      want -= take;
    });
    budget += want; // what a line couldn't take goes back to the proportional rest
  }
  const allocated = parts.reduce((a, b) => a + b, 0);
  const rest = allocateDiscount(
    lines.map((l, i) => ({ ...l, unitPriceCents: value[i] - parts[i], quantity: 1 })),
    foldedCents - allocated,
  );
  return parts.map((p, i) => p + rest[i]);
}

/**
 * Builds the `orderCreate` input. The merchandise discount is folded into line prices
 * (allocated proportionally) so the Shopify order total always equals what Whop charged,
 * and the code is still recorded on the order.
 */
export function buildOrderCreateInput(o: PaidOrderInput) {
  const nativeCents = o.discount && !o.discount.freeShipping ? Math.min(o.discount.amountCents, Math.max(0, o.discount.nativeCodeCents ?? 0)) : 0;
  const allocation = allocateOrderDiscount(o.lines, (o.discount?.amountCents ?? 0) - nativeCents, o.automaticDiscount ?? null);
  // Keep exact totals: split into two lines when the amount doesn't divide evenly per unit.
  const priced = (base: Record<string, unknown>, quantity: number, total: number): Record<string, unknown>[] => {
    const unit = Math.floor(total / quantity);
    const extra = total - unit * quantity;
    if (extra === 0) return [{ ...base, quantity, priceSet: money(unit, o.currency) }];
    return [
      { ...base, quantity: extra, priceSet: money(unit + 1, o.currency) },
      ...(quantity - extra > 0 ? [{ ...base, quantity: quantity - extra, priceSet: money(unit, o.currency) }] : []),
    ];
  };
  const lineItems: Record<string, unknown>[] = o.lines.flatMap((l, i) => {
    const lineTotal = l.unitPriceCents * l.quantity - allocation[i];
    // Line item properties (hidden "_…" keys included: bundle / personalization apps read them).
    const properties = l.properties?.length ? l.properties.map((p) => ({ name: p.name, value: p.value })) : undefined;
    if (l.components?.length) {
      // Bundle expanded by Shopify: its components are ordered (their stock), sharing the line's amount.
      const parts = splitOverComponents(lineTotal, l.components);
      const bundle = [{ name: "Lot", value: `${l.title}${l.variantTitle ? ` — ${l.variantTitle}` : ""}`.slice(0, 255) }, ...(properties ?? [])].slice(0, 25);
      return l.components.flatMap((c, k) => priced({ variantId: c.variantId, requiresShipping: l.requiresShipping, properties: bundle }, c.quantity, parts[k]));
    }
    return priced({ variantId: l.variantId, sku: l.sku ?? undefined, requiresShipping: l.requiresShipping, ...(properties ? { properties } : {}) }, l.quantity, lineTotal);
  });
  for (const a of o.addOns) {
    lineItems.push(
      a.variantId
        ? { variantId: a.variantId, quantity: 1, priceSet: money(a.priceCents, o.currency) }
        : { title: a.title, quantity: 1, requiresShipping: false, taxable: false, priceSet: money(a.priceCents, o.currency) },
    );
  }

  const address = o.shippingAddress
    ? {
        firstName: o.shippingAddress.firstName,
        lastName: o.shippingAddress.lastName,
        address1: o.shippingAddress.address1,
        address2: o.shippingAddress.address2 || undefined,
        city: o.shippingAddress.city,
        provinceCode: o.shippingAddress.province || undefined,
        zip: o.shippingAddress.zip,
        countryCode: o.shippingAddress.countryCode,
        phone: o.shippingAddress.phone || undefined,
      }
    : undefined;

  const order: Record<string, unknown> = {
    currency: o.currency,
    email: o.email,
    buyerAcceptsMarketing: o.acceptsMarketing,
    financialStatus: "PAID",
    lineItems,
    shippingAddress: o.pickupPoint && address
      ? {
          firstName: address.firstName,
          lastName: address.lastName,
          company: `${o.pickupPoint.name} (Point Relais ${o.pickupPoint.id})`.slice(0, 255),
          address1: o.pickupPoint.address1,
          city: o.pickupPoint.city,
          zip: o.pickupPoint.zip,
          countryCode: o.pickupPoint.countryCode,
          phone: address.phone,
        }
      : address,
    billingAddress: address,
    shippingLines: o.shipping
      ? [{ title: o.shipping.title, code: o.shipping.title, source: "whop-checkout", priceSet: money(o.shipping.priceCents, o.currency) }]
      : [],
    transactions: [
      {
        kind: "SALE",
        status: "SUCCESS",
        gateway: GATEWAY_NAME,
        authorizationCode: o.whopPaymentId,
        amountSet: money(o.totalCents, o.currency),
        test: o.test,
      },
    ],
    sourceName: "whop-checkout",
    sourceIdentifier: o.sessionId,
    // The session tag lets a retry find an order that was created but not recorded.
    tags: ["whop-checkout", sessionTag(o.sessionId), ...(o.whopPaymentId ? [paymentTag(o.whopPaymentId)] : []), ...(o.test ? ["test"] : []), ...(o.pickupPoint ? ["point-relais"] : [])],
    note: `${o.buyerNote ? `Note du client : ${o.buyerNote}\n\n` : ""}${o.cart?.note && o.cart.note !== o.buyerNote ? `Note du panier : ${o.cart.note}\n\n` : ""}Payé via Whop — paiement ${o.whopPaymentId}${
      o.pickupPoint ? `\nLivraison en point relais Mondial Relay n°${o.pickupPoint.id} : ${o.pickupPoint.name}, ${o.pickupPoint.address1}, ${o.pickupPoint.zip} ${o.pickupPoint.city}` : ""
    }`,
    customer: {
      toUpsert: {
        email: o.email,
        firstName: o.shippingAddress?.firstName,
        lastName: o.shippingAddress?.lastName,
      },
    },
    test: o.test,
  };
  // The cart's attributes, as Shopify's own checkout keeps them ("additional details"). Tags and
  // sourceIdentifier (duplicate lookups) are untouched.
  if (o.cart?.attributes?.length) order.customAttributes = o.cart.attributes.slice(0, 25).map((a) => ({ key: a.key, value: a.value }));
  // Prices an app set on the cart (bundles): already in the line prices, stated for the merchant.
  const appCents = o.lines.reduce((s, l) => s + (l.appPrice ? Math.max(0, l.appPrice.originalUnitCents - l.unitPriceCents) * l.quantity : 0), 0);
  if (o.automaticTitles?.length) order.note = `${order.note} — remises automatiques Shopify : ${o.automaticTitles.join(" + ").slice(0, 300)}`;
  if (appCents > 0) order.note = `${order.note} — prix de lot fixés par une app du panier Shopify (−${centsToDecimal(appCents)} ${o.currency} sur les prix catalogue, déjà dans les prix des lignes)`;
  if (o.discount?.freeShipping) {
    // Shopify zeroes every shipping line of a free-shipping code: only when shipping was free as paid,
    // or the order total would drop below what Whop charged.
    if (!o.shipping || o.shipping.priceCents === 0) order.discountCode = { freeShippingDiscountCode: { code: o.discount.code } };
    else order.note = `${order.note} — code promo ${o.discount.code} (livraison gratuite non appliquée au tarif payé)`;
  } else if (o.discount && o.discount.amountCents <= 0) {
    // A code that took nothing (e.g. free shipping above its maximum shipping price): noted only.
    order.note = `${order.note} — code promo ${o.discount.code} saisi (sans remise sur cette commande)`;
  }
  if (o.discount && nativeCents > 0) {
    // Shopify discount code: on the order as such (reports, usage count), for exactly what it took.
    order.discountCode = { itemFixedDiscountCode: { code: o.discount.code, amountSet: money(nativeCents, o.currency) } };
  }
  if (o.discount && !o.discount.freeShipping && o.discount.amountCents - nativeCents > 0) {
    order.note =
      nativeCents > 0
        ? `${order.note} — remises automatiques / par quantité (−${centsToDecimal(o.discount.amountCents - nativeCents)} ${o.currency}, déjà déduites des lignes)`
        : `${order.note} — code promo ${o.discount.code} (−${centsToDecimal(o.discount.amountCents)} ${o.currency}, déjà déduit des lignes)`;
  }
  return order;
}

export function sessionTag(sessionId: string) {
  return `wc-${sessionId}`;
}

/** Tag carrying the Whop payment id: a second, independent key to find an order after a timeout. */
export function paymentTag(paymentId: string) {
  return `wp-${paymentId}`;
}

/**
 * Second duplicate guard, used after an ambiguous creation (timeout) once the tag lookup
 * found nothing: the order's source identifier (our session / offer ref) or its Whop
 * payment tag. Only an order that really carries one of them is returned.
 */
export async function findOrderByPayment(store: ConnectedStore, ref: { sessionId: string; paymentId: string }) {
  const q = `source_identifier:'${ref.sessionId}' OR tag:'${paymentTag(ref.paymentId)}'`;
  const data = await shopifyGraphql<{ orders: { nodes: { id: string; name: string; tags: string[]; sourceIdentifier: string | null }[] } }>(
    store,
    `query($q: String!) { orders(first: 5, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { id name tags sourceIdentifier } } }`,
    { q },
  );
  return data.orders.nodes.find((o) => o.sourceIdentifier === ref.sessionId || o.tags.includes(paymentTag(ref.paymentId))) ?? null;
}

/** The Shopify order already created for this checkout session, if any (idempotency). */
export async function findOrderForSession(store: ConnectedStore, sessionId: string) {
  const data = await shopifyGraphql<{ orders: { nodes: { id: string; name: string; tags: string[] }[] } }>(
    store,
    `query($q: String!) { orders(first: 3, query: $q) { nodes { id name tags } } }`,
    { q: `tag:'${sessionTag(sessionId)}'` },
  );
  return data.orders.nodes.find((o) => o.tags.includes(sessionTag(sessionId))) ?? null;
}

/** What Shopify already recorded as refunded on an order, in cents (shop currency). */
export async function orderRefundedCents(store: ConnectedStore, orderId: string): Promise<number> {
  const data = await shopifyGraphql<{ order: { totalRefundedSet: { shopMoney: { amount: string } } } | null }>(
    store,
    `query($id: ID!) { order(id: $id) { totalRefundedSet { shopMoney { amount } } } }`,
    { id: orderId },
  );
  return Math.round(Number(data.order?.totalRefundedSet.shopMoney.amount ?? 0) * 100);
}

/** Tracking numbers of an order's fulfillments (for the dispute shield). */
export async function orderTracking(store: ConnectedStore, orderId: string) {
  const data = await shopifyGraphql<{
    order: { fulfillments: { status: string; trackingInfo: { number: string | null; company: string | null; url: string | null }[] }[] } | null;
  }>(store, `query($id: ID!) { order(id: $id) { fulfillments(first: 10) { status trackingInfo(first: 5) { number company url } } } }`, {
    id: orderId,
  });
  return (data.order?.fulfillments ?? [])
    .filter((f) => f.status !== "CANCELLED")
    .flatMap((f) => f.trackingInfo)
    .filter((t): t is { number: string; company: string | null; url: string | null } => !!t.number);
}

const STOCK_ERROR = /stock|inventor|quantit|disponib|available/i;

/**
 * Creates the paid order. The money is already taken, so an order refused for lack of
 * stock (two buyers paid for the last unit) is created anyway, without decrementing
 * below the policy, and tagged "stock-insuffisant" for the merchant to handle. A userError
 * means nothing was created, so the second attempt can't duplicate the order.
 */
/**
 * The buyer's Shopify customer as orderCreate returns it: lifetime order count and oldest order
 * (the orders this app can read), for new vs returning with the store's whole history.
 */
export type OrderCustomer = { id: string; numberOfOrders: string | number | null; orders?: { nodes: { id: string; createdAt: string }[] } | null };

export async function createPaidOrder(store: ConnectedStore, input: PaidOrderInput): Promise<{ id: string; name: string; oversold?: boolean; customer?: OrderCustomer | null }> {
  const run = async (inventoryBehaviour: "DECREMENT_OBEYING_POLICY" | "BYPASS", extraTags: string[]) => {
    const order = buildOrderCreateInput(input);
    if (extraTags.length) order.tags = [...((order.tags as string[] | undefined) ?? []), ...extraTags];
    return shopifyGraphql<{
      orderCreate: {
        order: { id: string; name: string; customer?: OrderCustomer | null } | null;
        userErrors: { field: string[] | null; message: string }[];
      };
    }>(
      store,
      `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
        orderCreate(order: $order, options: $options) {
          order { id name customer { id numberOfOrders orders(first: 10, sortKey: CREATED_AT) { nodes { id createdAt } } } }
          userErrors { field message }
        }
      }`,
      { order, options: { inventoryBehaviour, sendReceipt: true, sendFulfillmentReceipt: true } },
      { retry: false },
    );
  };
  const data = await run("DECREMENT_OBEYING_POLICY", []);
  const errors = data.orderCreate.userErrors;
  if (errors?.length && errors.every((e) => STOCK_ERROR.test(e.message))) {
    log.warn("shopify.oversold", "Paid order refused for stock, created without inventory check", { sessionId: input.sessionId, errors });
    const retry = await run("BYPASS", ["stock-insuffisant"]);
    assertNoUserErrors(retry.orderCreate.userErrors, "Création de la commande");
    return { ...retry.orderCreate.order!, oversold: true };
  }
  assertNoUserErrors(errors, "Création de la commande");
  return data.orderCreate.order!;
}

/** A payment or refund on a Shopify order (cents, shop currency). */
export type OrderTx = { id: string; kind: string; status: string; gateway: string; cents: number; parentId: string | null };

/** An order's balance and transactions (refund parents, offer payments). Null: order not found. */
export async function orderPayments(store: ConnectedStore, orderId: string): Promise<{ outstandingCents: number; transactions: OrderTx[] } | null> {
  const data = await shopifyGraphql<{
    order: {
      totalOutstandingSet: { shopMoney: { amount: string } } | null;
      transactions: { id: string; kind: string; status: string; gateway: string | null; amountSet: { shopMoney: { amount: string } }; parentTransaction: { id: string } | null }[];
    } | null;
  }>(
    store,
    `query($id: ID!) { order(id: $id) { totalOutstandingSet { shopMoney { amount } }
      transactions(first: 50) { id kind status gateway amountSet { shopMoney { amount } } parentTransaction { id } } } }`,
    { id: orderId },
  );
  const o = data.order;
  if (!o) return null;
  return {
    outstandingCents: Math.round(Number(o.totalOutstandingSet?.shopMoney.amount ?? 0) * 100),
    transactions: o.transactions.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      gateway: t.gateway ?? "",
      cents: Math.round(Number(t.amountSet.shopMoney.amount) * 100),
      parentId: t.parentTransaction?.id ?? null,
    })),
  };
}

const OFFER_GATEWAY_MARK = "wc-offer-in-";

/**
 * Which payments a refund goes against. A merged offer's refund takes its own manual payment
 * (gateway carrying its marker) first; the checkout's its own payment. Otherwise one payment
 * with enough left to refund (never another offer's), else the amount is split across payments,
 * other offers' payments last.
 * Throws when the payments can't cover the refund (Shopify would refuse it anyway). Pure.
 */
export function planRefundTransactions(txs: OrderTx[], amountCents: number, marker?: string): { parentId: string | undefined; gateway: string; cents: number }[] {
  const sales = txs.filter((t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS");
  if (sales.length === 0) return [{ parentId: undefined, gateway: GATEWAY_NAME, cents: amountCents }];
  const refunded = new Map<string, number>();
  for (const t of txs) {
    if (t.kind === "REFUND" && t.status === "SUCCESS" && t.parentId) refunded.set(t.parentId, (refunded.get(t.parentId) ?? 0) + t.cents);
  }
  const left = (t: OrderTx) => t.cents - (refunded.get(t.id) ?? 0);
  const own = marker ? sales.filter((t) => t.gateway.includes(marker)) : [];
  const plain = sales.filter((t) => !t.gateway.includes(OFFER_GATEWAY_MARK));
  const others = sales.filter((t) => !own.includes(t) && !plain.includes(t));
  const pool = [...own, ...plain, ...others];
  // Another offer's payment is only used for what the target's own payments can't cover.
  const one = [...own, ...plain].find((t) => left(t) >= amountCents);
  if (one) return [{ parentId: one.id, gateway: one.gateway || GATEWAY_NAME, cents: amountCents }];
  const plan: { parentId: string | undefined; gateway: string; cents: number }[] = [];
  let rest = amountCents;
  for (const t of pool) {
    const take = Math.min(rest, left(t));
    if (take <= 0) continue;
    plan.push({ parentId: t.id, gateway: t.gateway || GATEWAY_NAME, cents: take });
    rest -= take;
    if (rest === 0) break;
  }
  if (rest > 0) throw new ShopifyError(`Remboursement Shopify : ${centsToDecimal(amountCents)} à rembourser, ${centsToDecimal(amountCents - rest)} seulement remboursable sur la commande`);
  return plan;
}

/** Records a refund made in Whop on the Shopify order (money already moved in Whop). */
export async function createRefund(
  store: ConnectedStore,
  orderId: string,
  amountCents: number,
  note: string,
  /** Line items refunded (a merged offer's line, refunded in full), never restocked. */
  lineItems: { lineItemId: string; quantity: number }[] = [],
  /** Merged offer: its merge marker, to refund against its own payment on the shared order. */
  opts: { marker?: string } = {},
) {
  const payments = await orderPayments(store, orderId);
  const plan = planRefundTransactions(payments?.transactions ?? [], amountCents, opts.marker);
  const data = await shopifyGraphql<{ refundCreate: { userErrors: { field: string[] | null; message: string }[] } }>(
    store,
    `mutation($input: RefundInput!) { refundCreate(input: $input) { refund { id } userErrors { field message } } }`,
    {
      input: {
        orderId,
        note,
        notify: true,
        allowOverRefunding: false,
        ...(lineItems.length ? { refundLineItems: lineItems.map((l) => ({ ...l, restockType: "NO_RESTOCK" })) } : {}),
        transactions: plan.map((p) => ({ orderId, parentId: p.parentId, amount: centsToDecimal(p.cents), gateway: p.gateway, kind: "REFUND" })),
      },
    },
    { retry: false },
  );
  assertNoUserErrors(data.refundCreate.userErrors, "Remboursement Shopify");
}

export async function tagOrder(store: ConnectedStore, orderId: string, tags: string[]) {
  await shopifyGraphql(store, `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`, {
    id: orderId,
    tags,
  });
}

/* ------------------------------------------------------------------ */
/* One-click offers merged into the checkout's order (order edits)    */
/* ------------------------------------------------------------------ */

/**
 * Tag, discount description and manual-payment gateway marking an offer added to the checkout's
 * order (idempotency across retries). Distinct from the offer's own order tag (sessionTag of
 * "upsell-<id>" = "wc-upsell-<id>"), so looking up the offer's separate order never finds the
 * checkout's order it was merged into.
 */
export function offerMarker(chargeId: string) {
  return `${OFFER_GATEWAY_MARK}${chargeId}`;
}

/** Marker of offers merged before the distinct marker (round 8): still recognised on their line. */
export function legacyOfferMarker(chargeId: string) {
  return `wc-upsell-${chargeId}`;
}

/** Gateway name of an offer's manual payment on the shared order (carries its marker). */
export function offerGateway(marker: string) {
  return `${GATEWAY_NAME} ${marker}`;
}

export type EditableOrder = {
  id: string;
  name: string;
  /** Shopify's creation time of the order (merge window). */
  createdAt: string | null;
  /** UNFULFILLED, PARTIALLY_FULFILLED, FULFILLED, ON_HOLD, IN_PROGRESS… (only an unfulfilled order is edited). */
  fulfillmentStatus: string;
  cancelled: boolean;
  closed: boolean;
  tags: string[];
  outstandingCents: number;
  lines: { id: string; variantId: string | null; quantity: number; discounts: string[] }[];
};

/** An order with what the offer merge needs (status, balance, lines and their discount descriptions). */
export async function orderForEdit(store: ConnectedStore, orderId: string): Promise<EditableOrder | null> {
  const data = await shopifyGraphql<{
    order: {
      id: string;
      name: string;
      createdAt: string | null;
      displayFulfillmentStatus: string;
      cancelledAt: string | null;
      closed: boolean;
      tags: string[];
      totalOutstandingSet: { shopMoney: { amount: string } } | null;
      lineItems: {
        nodes: {
          id: string;
          quantity: number;
          variant: { id: string } | null;
          discountAllocations: { discountApplication: { description?: string | null; title?: string | null } | null }[];
        }[];
      };
    } | null;
  }>(
    store,
    `query($id: ID!) { order(id: $id) { id name createdAt displayFulfillmentStatus cancelledAt closed tags totalOutstandingSet { shopMoney { amount } }
      lineItems(first: 100) { nodes { id quantity variant { id }
        discountAllocations { discountApplication { ... on ManualDiscountApplication { description title } } } } } } }`,
    { id: orderId },
  );
  const o = data.order;
  if (!o) return null;
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt ?? null,
    fulfillmentStatus: o.displayFulfillmentStatus,
    cancelled: !!o.cancelledAt,
    closed: o.closed,
    tags: o.tags,
    outstandingCents: Math.round(Number(o.totalOutstandingSet?.shopMoney.amount ?? 0) * 100),
    lines: o.lineItems.nodes.map((l) => ({
      id: l.id,
      variantId: l.variant?.id ?? null,
      quantity: l.quantity,
      discounts: l.discountAllocations.flatMap((d) => [d.discountApplication?.description, d.discountApplication?.title].filter((x): x is string => !!x)),
    })),
  };
}

/**
 * The offer's line in an order: the line whose discount carries the marker, else (after a
 * write-ahead snapshot of the order's line ids) a line of the variant that wasn't there before. Pure.
 */
export function findOfferLine(order: Pick<EditableOrder, "lines">, marker: string | string[], variantId: string, before: Set<string> | null): EditableOrder["lines"][number] | null {
  const markers = Array.isArray(marker) ? marker : [marker];
  return (
    order.lines.find((l) => l.discounts.some((d) => markers.some((m) => d.includes(m)))) ??
    (before ? (order.lines.find((l) => l.variantId === variantId && !before.has(l.id)) ?? null) : null)
  );
}

/** Why an order can't take the offer (null = it can): merged only into an open, unfulfilled order. Pure. */
export function orderEditRefusal(order: Pick<EditableOrder, "fulfillmentStatus" | "cancelled" | "closed"> | null): string | null {
  if (!order) return "commande introuvable";
  if (order.cancelled) return "commande annulée";
  if (order.closed) return "commande archivée";
  if (order.fulfillmentStatus === "ON_HOLD") return "commande en attente de traitement (fulfillment hold)";
  if (order.fulfillmentStatus === "IN_PROGRESS" || order.fulfillmentStatus === "PENDING_FULFILLMENT") return "commande déjà prise en charge pour l'expédition";
  if (order.fulfillmentStatus !== "UNFULFILLED") return "commande déjà (partiellement) expédiée";
  return null;
}

/**
 * Tags that dropshipping / fulfillment apps (DSers, AutoDS, Zendrop, CJ, Spocket, Syncee…) or
 * merchants put on an order already sent to the supplier: such an order is never edited (the
 * supplier would never ship the offer).
 */
export const SUPPLIER_TAG = /(dsers|autods|zendrop|cj[\s_-]?dropshipping|spocket|syncee|dropified|oberlo|ali[\s_-]?orders?|sent[\s_-]to[\s_-]supplier|supplier[\s_-]?(ordered|order|placed)|order[\s_-]placed|fournisseur|command[ée]e?[\s_-]fournisseur)/i;

/**
 * Why the offer must not be merged into this order (null = it may): the order-edit refusals, the
 * merge window after the order's creation (the supplier order is often placed within minutes) and
 * the supplier tags above. Pure.
 */
export function offerMergeRefusal(
  order: Pick<EditableOrder, "fulfillmentStatus" | "cancelled" | "closed" | "tags" | "createdAt"> | null,
  opts: { windowMin: number; fallbackCreatedAt: Date | null; now?: number },
): string | null {
  const refusal = orderEditRefusal(order);
  if (refusal || !order) return refusal;
  const tag = order.tags.find((t) => SUPPLIER_TAG.test(t));
  if (tag) return `commande marquée « ${tag} » (déjà transmise au fournisseur ?)`;
  const created = order.createdAt ? new Date(order.createdAt).getTime() : (opts.fallbackCreatedAt?.getTime() ?? NaN);
  if (!Number.isFinite(created)) return "date de création de la commande inconnue";
  const ageMin = ((opts.now ?? Date.now()) - created) / 60_000;
  if (ageMin > opts.windowMin) return `commande créée il y a ${Math.floor(ageMin)} min (fenêtre d'ajout : ${opts.windowMin} min)`;
  return null;
}

type UserErrors = { field?: string[] | null; message: string }[];

/**
 * An order edit failed before its commit without Shopify's definite answer (network, 5xx,
 * throttling, time budget): nothing is committed, but the edit must be retried later, never turned
 * into a separate order. `cause` is the original error.
 */
export class OrderEditNotCommittedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "OrderEditNotCommittedError";
  }
}

/** Shopify's definite answer (a GraphQL / 4xx error), as opposed to a transient failure. */
function definiteAnswer(err: unknown) {
  return err instanceof ShopifyError && !err.transient;
}

/**
 * Adds a variant to an existing order at the offer's price (order edit: begin → add variant →
 * line discount down to the offer price when needed → check the calculated order's totals →
 * commit, customer not notified). Returns "refused" when nothing was committed and Shopify said
 * no (a userError, a price or total that doesn't match exactly — e.g. taxes added on top —, an
 * order it won't edit): the caller may then create a separate order. Throws
 * OrderEditNotCommittedError on a transient failure before the commit (retry, no fallback), and
 * the raw error when the commit's outcome is unknown (the offer may already be in the order).
 */
export async function addVariantToOrder(
  store: ConnectedStore,
  input: { orderId: string; variantId: string; quantity: number; amountCents: number; currency: string; marker: string },
): Promise<{ status: "committed" } | { status: "refused"; reason: string }> {
  const refused = (reason: string) => ({ status: "refused" as const, reason });
  const errs = (e: UserErrors | undefined) => (e?.length ? e.map((x) => x.message).join("; ") : null);
  let calcId: string;
  try {
    const begin = await shopifyGraphql<{ orderEditBegin: { calculatedOrder: { id: string } | null; userErrors: UserErrors } }>(
      store,
      `mutation($id: ID!) { orderEditBegin(id: $id) { calculatedOrder { id } userErrors { field message } } }`,
      { id: input.orderId },
      { retry: false },
    );
    if (errs(begin.orderEditBegin.userErrors) || !begin.orderEditBegin.calculatedOrder) return refused(errs(begin.orderEditBegin.userErrors) ?? "édition refusée");
    calcId = begin.orderEditBegin.calculatedOrder.id;
    const add = await shopifyGraphql<{
      orderEditAddVariant: { calculatedLineItem: { id: string; originalUnitPriceSet: { shopMoney: { amount: string } } } | null; userErrors: UserErrors };
    }>(
      store,
      `mutation($id: ID!, $variantId: ID!, $quantity: Int!) { orderEditAddVariant(id: $id, variantId: $variantId, quantity: $quantity, allowDuplicates: true) {
        calculatedLineItem { id originalUnitPriceSet { shopMoney { amount } } } userErrors { field message } } }`,
      { id: calcId, variantId: input.variantId, quantity: input.quantity },
      { retry: false },
    );
    const line = add.orderEditAddVariant.calculatedLineItem;
    if (errs(add.orderEditAddVariant.userErrors) || !line) return refused(errs(add.orderEditAddVariant.userErrors) ?? "produit refusé");
    const unitCents = Math.round(Number(line.originalUnitPriceSet.shopMoney.amount) * 100);
    const targetUnit = input.amountCents / input.quantity;
    if (!Number.isInteger(targetUnit) || targetUnit > unitCents) return refused("prix de l'offre non applicable à la ligne");
    const perUnitOff = unitCents - targetUnit;
    // A full-price offer needs no discount (Shopify refuses a zero one): its line is then found
    // through the write-ahead snapshot instead of the discount's marker.
    if (perUnitOff > 0) {
      const disc = await shopifyGraphql<{
        orderEditAddLineItemDiscount: { calculatedLineItem: { discountedUnitPriceSet: { shopMoney: { amount: string } } } | null; userErrors: UserErrors };
      }>(
        store,
        `mutation($id: ID!, $lineItemId: ID!, $discount: OrderEditAppliedDiscountInput!) { orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
          calculatedLineItem { discountedUnitPriceSet { shopMoney { amount } } } userErrors { field message } } }`,
        { id: calcId, lineItemId: line.id, discount: { description: `Offre post-achat ${input.marker}`, fixedValue: { amount: centsToDecimal(perUnitOff), currencyCode: input.currency } } },
        { retry: false },
      );
      const got = disc.orderEditAddLineItemDiscount.calculatedLineItem;
      if (errs(disc.orderEditAddLineItemDiscount.userErrors) || !got) return refused(errs(disc.orderEditAddLineItemDiscount.userErrors) ?? "remise refusée");
      // Only commit an exact match of the price the buyer paid.
      const unitAfter = Math.round(Number(got.discountedUnitPriceSet.shopMoney.amount) * 100);
      if (unitAfter * input.quantity !== input.amountCents) return refused(`prix après remise ${unitAfter} ≠ ${targetUnit}`);
    }
    // The order's total and balance must grow by exactly what Whop charged: taxes added on top
    // (prices excluding tax), shipping recalculated… would leave a balance nobody paid.
    const totals = await shopifyGraphql<{
      node: {
        totalPriceSet: { shopMoney: { amount: string } };
        totalOutstandingSet: { shopMoney: { amount: string } };
        originalOrder: { currentTotalPriceSet: { shopMoney: { amount: string } }; totalOutstandingSet: { shopMoney: { amount: string } } };
      } | null;
    }>(
      store,
      `query($id: ID!) { node(id: $id) { ... on CalculatedOrder { totalPriceSet { shopMoney { amount } } totalOutstandingSet { shopMoney { amount } }
        originalOrder { currentTotalPriceSet { shopMoney { amount } } totalOutstandingSet { shopMoney { amount } } } } } }`,
      { id: calcId },
    );
    const t = totals.node;
    if (!t?.totalPriceSet || !t.originalOrder) return refused("totaux de la commande modifiée introuvables");
    const c = (m: { shopMoney: { amount: string } }) => Math.round(Number(m.shopMoney.amount) * 100);
    const totalDelta = c(t.totalPriceSet) - c(t.originalOrder.currentTotalPriceSet);
    const outstandingDelta = c(t.totalOutstandingSet) - c(t.originalOrder.totalOutstandingSet);
    if (totalDelta !== input.amountCents || outstandingDelta !== input.amountCents) {
      return refused(`la commande augmenterait de ${centsToDecimal(totalDelta)} (solde +${centsToDecimal(outstandingDelta)}) au lieu de ${centsToDecimal(input.amountCents)} payés (taxes ou frais ajoutés)`);
    }
  } catch (err) {
    // Nothing is committed before orderEditCommit (an uncommitted edit simply expires). Shopify's
    // definite refusal → separate order; no answer / unavailable / out of time → retry later.
    if (definiteAnswer(err)) return refused(err instanceof Error ? err.message : String(err));
    throw new OrderEditNotCommittedError(err);
  }
  // From here the outcome may be unknown: a thrown error propagates (no fallback).
  const commit = await shopifyGraphql<{ orderEditCommit: { order: { id: string } | null; userErrors: UserErrors } }>(
    store,
    `mutation($id: ID!, $staffNote: String) { orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) { order { id } userErrors { field message } } }`,
    { id: calcId, staffNote: `Offre post-achat payée via Whop (${input.marker})` },
    { retry: false },
  );
  if (errs(commit.orderEditCommit.userErrors) || !commit.orderEditCommit.order) return refused(errs(commit.orderEditCommit.userErrors) ?? "validation refusée");
  return { status: "committed" };
}

/**
 * Where an offer's payment stands on the shared order. Pure.
 * - "paid": a successful payment carrying the offer's marker, of its exact amount, is there;
 * - "due": not there, and the balance covers the offer's amount (pay exactly that);
 * - "settled": nothing is owed (balance paid by hand, or the offer's line refunded / removed);
 * - "mismatch": a balance smaller than the offer's: never paid automatically (not ours to guess).
 */
export function offerBalanceState(p: { outstandingCents: number; transactions: OrderTx[] }, marker: string, amountCents: number): "paid" | "due" | "settled" | "mismatch" {
  const mine = p.transactions.some((t) => t.gateway.includes(marker) && (t.kind === "SALE" || t.kind === "CAPTURE") && t.status === "SUCCESS" && t.cents === amountCents);
  if (mine) return "paid";
  if (p.outstandingCents >= amountCents) return "due";
  if (p.outstandingCents <= 0) return "settled";
  return "mismatch";
}

/**
 * Records one offer's Whop payment on the order's balance (manual payment whose gateway carries
 * the offer's marker, so a retry sees it and a refund of that offer targets it). Not idempotent by
 * itself: callers check offerBalanceState first.
 */
export async function payOrderBalance(store: ConnectedStore, orderId: string, amountCents: number, currency: string, marker: string) {
  const data = await shopifyGraphql<{ orderCreateManualPayment: { userErrors: UserErrors } }>(
    store,
    `mutation($id: ID!, $amount: MoneyInput!, $name: String) { orderCreateManualPayment(id: $id, amount: $amount, paymentMethodName: $name) { order { id } userErrors { field message } } }`,
    { id: orderId, amount: { amount: centsToDecimal(amountCents), currencyCode: currency }, name: offerGateway(marker) },
    { retry: false },
  );
  assertNoUserErrors(data.orderCreateManualPayment.userErrors, "Paiement de l'offre sur la commande");
}

/** Refunds of an order with their note (the refund mirror tells a merged offer's refunds apart by note). */
export async function orderRefunds(store: ConnectedStore, orderId: string): Promise<{ note: string; cents: number }[]> {
  const data = await shopifyGraphql<{ order: { refunds: { note: string | null; totalRefundedSet: { shopMoney: { amount: string } } }[] } | null }>(
    store,
    `query($id: ID!) { order(id: $id) { refunds(first: 100) { note totalRefundedSet { shopMoney { amount } } } } }`,
    { id: orderId },
  );
  return (data.order?.refunds ?? []).map((r) => ({ note: r.note ?? "", cents: Math.round(Number(r.totalRefundedSet.shopMoney.amount) * 100) }));
}

export function orderAdminUrl(shopDomain: string, orderGid: string) {
  return `https://${shopDomain}/admin/orders/${orderGid.split("/").pop()}`;
}
