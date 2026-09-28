import "server-only";
import { createHmac } from "node:crypto";
import type { Store } from "@prisma/client";
import { decrypt, safeEqual } from "./crypto";
import { env } from "./env";
import { allocateDiscount, centsToDecimal, type CartLine } from "./pricing";

export const SHOPIFY_API_VERSION = "2026-07";

export const SHOPIFY_SCOPES = [
  "read_products",
  "read_inventory",
  "write_orders",
  "write_customers",
  "write_script_tags",
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
  const res = await fetch(`https://${shop}/admin/oauth/access_token`, {
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

export class ShopifyError extends Error {}

type ConnectedStore = Pick<Store, "shopDomain" | "shopifyAccessToken">;

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

/**
 * Admin GraphQL call with a 20s timeout, and up to 3 attempts with backoff when
 * Shopify is throttling (429 / THROTTLED) or briefly unavailable (5xx, network).
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
  const attempts = opts.retry === false ? 1 : 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt + Math.random() * 300));
    let res: Response;
    try {
      res = await fetch(`https://${store.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
        body: JSON.stringify({ query, variables }),
        cache: "no-store",
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      lastError = new ShopifyError(`Shopify injoignable : ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (RETRYABLE.has(res.status)) {
      lastError = new ShopifyError(`Shopify API ${res.status}: ${(await res.text()).slice(0, 300)}`);
      continue;
    }
    if (!res.ok) throw new ShopifyError(`Shopify API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const json = (await res.json()) as { data?: T; errors?: { message: string; extensions?: { code?: string } }[] };
    if (json.errors?.some((e) => e.extensions?.code === "THROTTLED")) {
      lastError = new ShopifyError("Shopify API throttled");
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
  inventoryItem: { tracked: boolean; requiresShipping: boolean } | null;
  image: { url: string } | null;
  product: { id: string; title: string; handle: string; status: string; hasOnlyDefaultVariant: boolean; featuredImage: { url: string } | null };
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
          id title sku price compareAtPrice availableForSale inventoryQuantity
          inventoryItem { tracked requiresShipping }
          image { url }
          product { id title handle status hasOnlyDefaultVariant featuredImage { url } }
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
  shippingAddress: Address | null;
  lines: CartLine[];
  addOns: { title: string; priceCents: number; variantId: string | null }[];
  discount: { code: string; amountCents: number; freeShipping: boolean } | null;
  shipping: { title: string; priceCents: number } | null;
  totalCents: number;
  whopPaymentId: string;
  test: boolean;
};

function money(cents: number, currency: string) {
  return { shopMoney: { amount: centsToDecimal(cents), currencyCode: currency } };
}

/**
 * Builds the `orderCreate` input. The merchandise discount is folded into line prices
 * (allocated proportionally) so the Shopify order total always equals what Whop charged,
 * and the code is still recorded on the order.
 */
export function buildOrderCreateInput(o: PaidOrderInput) {
  const allocation = allocateDiscount(o.lines, o.discount?.amountCents ?? 0);
  const lineItems: Record<string, unknown>[] = o.lines.flatMap((l, i) => {
    const lineTotal = l.unitPriceCents * l.quantity - allocation[i];
    // Keep exact totals: split into two lines when the discount doesn't divide evenly per unit.
    const unit = Math.floor(lineTotal / l.quantity);
    const extra = lineTotal - unit * l.quantity;
    const base = { variantId: l.variantId, sku: l.sku ?? undefined, requiresShipping: l.requiresShipping };
    if (extra === 0) return [{ ...base, quantity: l.quantity, priceSet: money(unit, o.currency) }];
    return [
      { ...base, quantity: extra, priceSet: money(unit + 1, o.currency) },
      ...(l.quantity - extra > 0 ? [{ ...base, quantity: l.quantity - extra, priceSet: money(unit, o.currency) }] : []),
    ];
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
    shippingAddress: address,
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
    tags: ["whop-checkout", sessionTag(o.sessionId), ...(o.test ? ["test"] : [])],
    note: `${o.buyerNote ? `Note du client : ${o.buyerNote}\n\n` : ""}Payé via Whop — paiement ${o.whopPaymentId}`,
    customer: {
      toUpsert: {
        email: o.email,
        firstName: o.shippingAddress?.firstName,
        lastName: o.shippingAddress?.lastName,
      },
    },
    test: o.test,
  };
  if (o.discount?.freeShipping) {
    order.discountCode = { freeShippingDiscountCode: { code: o.discount.code } };
  }
  if (o.discount && !o.discount.freeShipping) {
    order.note = `${order.note} — code promo ${o.discount.code} (−${centsToDecimal(o.discount.amountCents)} ${o.currency}, déjà déduit des lignes)`;
  }
  return order;
}

export function sessionTag(sessionId: string) {
  return `wc-${sessionId}`;
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

export async function createPaidOrder(store: ConnectedStore, input: PaidOrderInput) {
  const data = await shopifyGraphql<{
    orderCreate: {
      order: { id: string; name: string } | null;
      userErrors: { field: string[] | null; message: string }[];
    };
  }>(
    store,
    `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order { id name }
        userErrors { field message }
      }
    }`,
    {
      order: buildOrderCreateInput(input),
      options: { inventoryBehaviour: "DECREMENT_OBEYING_POLICY", sendReceipt: true, sendFulfillmentReceipt: true },
    },
    { retry: false },
  );
  assertNoUserErrors(data.orderCreate.userErrors, "Création de la commande");
  return data.orderCreate.order!;
}

/** Records a refund made in Whop on the Shopify order (money already moved in Whop). */
export async function createRefund(store: ConnectedStore, orderId: string, amountCents: number, note: string) {
  const tx = await shopifyGraphql<{
    order: { transactions: { id: string; kind: string; status: string; gateway: string }[] } | null;
  }>(store, `query($id: ID!) { order(id: $id) { transactions(first: 20) { id kind status gateway } } }`, { id: orderId });
  const parent = tx.order?.transactions.find((t) => t.kind === "SALE" && t.status === "SUCCESS");
  const data = await shopifyGraphql<{ refundCreate: { userErrors: { field: string[] | null; message: string }[] } }>(
    store,
    `mutation($input: RefundInput!) { refundCreate(input: $input) { refund { id } userErrors { field message } } }`,
    {
      input: {
        orderId,
        note,
        notify: true,
        allowOverRefunding: false,
        transactions: [
          { orderId, parentId: parent?.id, amount: centsToDecimal(amountCents), gateway: GATEWAY_NAME, kind: "REFUND" },
        ],
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

export function orderAdminUrl(shopDomain: string, orderGid: string) {
  return `https://${shopDomain}/admin/orders/${orderGid.split("/").pop()}`;
}
