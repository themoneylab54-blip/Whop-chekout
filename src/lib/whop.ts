import "server-only";
import { WhopClient, WhopEnvironment } from "@whop/sdk";
import { unwrapWebhook } from "@whop/sdk/helpers";
import type { Store } from "@prisma/client";
import { decrypt } from "./crypto";
import { env } from "./env";
import { centsToDecimal } from "./pricing";
import { recordEvent } from "./log";
import { db } from "./db";

/** Events the app subscribes to when it creates the Whop webhook itself. */
export const WHOP_WEBHOOK_EVENTS = [
  "payment.succeeded",
  "payment.failed",
  "refund.created",
  "refund.updated",
  "dispute.created",
  "dispute_alert.created",
] as const;

export function whopClient(apiKey: string, testMode: boolean) {
  return new WhopClient({
    token: apiKey,
    environment: testMode ? WhopEnvironment.Sandbox : WhopEnvironment.Production,
  });
}

export function storeClient(store: Pick<Store, "whopApiKey" | "testMode">) {
  if (!store.whopApiKey) throw new Error("Compte Whop non connecté");
  return whopClient(decrypt(store.whopApiKey), store.testMode);
}

export function whopWebhookUrl(storeId: string) {
  return `${env.appUrl}/api/webhooks/whop/${storeId}`;
}

/**
 * One-click Whop setup: validates the key, then creates the hidden product that
 * carries every checkout and the webhook pointing at this app.
 */
export async function setupWhop(opts: {
  apiKey: string;
  testMode: boolean;
  storeId: string;
  storeName: string;
  statementDescriptor?: string | null;
}) {
  const client = whopClient(opts.apiKey, opts.testMode);
  const account = await client.accounts.me();

  // Idempotent: reuse this store's product and replace its webhook if a previous
  // attempt (or an older connection) already created them.
  const productInput = {
    account_id: account.id,
    title: `${opts.storeName || "Boutique"} — Checkout`,
    description: "Commandes de la boutique Shopify (créé automatiquement par Whop Checkout).",
    visibility: "hidden" as const,
    collect_shipping_address: false,
    send_welcome_message: false,
    metadata: { source: "whop-checkout", store_id: opts.storeId },
  };
  const descriptor = statementDescriptor(opts.statementDescriptor || opts.storeName);
  const product =
    (await findStoreProduct(client, account.id, opts.storeId)) ??
    // What buyers see on their bank statement: a recognisable name prevents "unknown charge"
    // disputes. A rejected descriptor must never block the connection.
    (await (descriptor
      ? client.products.create({ ...productInput, custom_statement_descriptor: descriptor }).catch(() => client.products.create(productInput))
      : client.products.create(productInput)));

  const url = whopWebhookUrl(opts.storeId);
  await deleteWebhooksForUrl(client, account.id, url);
  const webhook = await client.webhooks.create({
    url,
    resource_id: account.id,
    enabled: true,
    events: [...WHOP_WEBHOOK_EVENTS],
  });
  if (!webhook.webhook_secret) throw new Error("Whop n'a pas renvoyé de secret de webhook");

  return {
    accountId: account.id,
    accountName: account.business_name ?? account.route,
    productId: product.id,
    webhookId: webhook.id,
    webhookSecret: webhook.webhook_secret,
  };
}

type Client = ReturnType<typeof whopClient>;
const MAX_SCAN = 200;

async function findStoreProduct(client: Client, accountId: string, storeId: string) {
  try {
    let seen = 0;
    for await (const p of await client.products.list({ account_id: accountId, first: 50 })) {
      if (p.metadata?.store_id === storeId && p.metadata?.source === "whop-checkout") return p;
      if (++seen >= MAX_SCAN) break;
    }
  } catch (err) {
    console.warn("Whop product lookup failed, creating a new one", err);
  }
  return null;
}

async function deleteWebhooksForUrl(client: Client, accountId: string, url: string) {
  try {
    const stale: string[] = [];
    let seen = 0;
    for await (const w of await client.webhooks.list({ account_id: accountId, first: 50 })) {
      if (w.url === url) stale.push(w.id);
      if (++seen >= MAX_SCAN) break;
    }
    await Promise.all(stale.map((id) => client.webhooks.delete({ id })));
  } catch (err) {
    console.warn("Whop webhook cleanup failed", err);
  }
}

export async function teardownWhop(store: Pick<Store, "whopApiKey" | "testMode" | "whopWebhookId">) {
  if (!store.whopWebhookId) return;
  await storeClient(store).webhooks.delete({ id: store.whopWebhookId });
}

/** Wallets and methods offered on every checkout, on top of the account's defaults. */
export const CHECKOUT_PAYMENT_METHODS = ["card", "apple_pay", "google_pay", "paypal"] as const;

/**
 * Local and pay-later methods the merchant can switch on (Whop shows each one only
 * to buyers in the countries it supports). Grouped for the dashboard.
 */
export const OPTIONAL_PAYMENT_METHODS = [
  { id: "klarna", label: "Klarna", hint: "Paiement en 3x / 30 jours — Europe" },
  { id: "alma", label: "Alma", hint: "3x / 4x sans frais — France, Belgique, Italie" },
  { id: "oney_3x", label: "Oney 3x", hint: "Paiement en 3 fois — France" },
  { id: "oney_4x", label: "Oney 4x", hint: "Paiement en 4 fois — France" },
  { id: "scalapay", label: "Scalapay", hint: "3x / 4x — France, Italie, Espagne" },
  { id: "bancontact", label: "Bancontact", hint: "Belgique" },
  { id: "ideal", label: "iDEAL", hint: "Pays-Bas" },
  { id: "twint", label: "TWINT", hint: "Suisse" },
  { id: "sepa_debit", label: "Prélèvement SEPA", hint: "Zone euro" },
  { id: "eps", label: "EPS", hint: "Autriche" },
  { id: "p24", label: "Przelewy24", hint: "Pologne" },
  { id: "blik", label: "BLIK", hint: "Pologne" },
  { id: "multibanco", label: "Multibanco", hint: "Portugal" },
  { id: "mb_way", label: "MB WAY", hint: "Portugal" },
  { id: "satispay", label: "Satispay", hint: "Italie" },
  { id: "revolut_pay", label: "Revolut Pay", hint: "Europe" },
] as const;
export type OptionalPaymentMethod = (typeof OPTIONAL_PAYMENT_METHODS)[number]["id"];
export const OPTIONAL_PAYMENT_METHOD_IDS: readonly string[] = OPTIONAL_PAYMENT_METHODS.map((m) => m.id);

/** Creates the one-off checkout for a session; the embed is rendered with its id. */
export async function createCheckoutConfiguration(
  store: Pick<Store, "whopApiKey" | "testMode" | "whopAccountId" | "whopProductId"> & { paymentMethods?: string[] },
  opts: { sessionId: string; storeId: string; totalCents: number; currency: string; title: string; redirectUrl: string },
) {
  if (!store.whopAccountId || !store.whopProductId) throw new Error("Compte Whop non configuré");
  const client = storeClient(store);
  const base = {
    account_id: store.whopAccountId,
    currency: opts.currency.toLowerCase(),
    redirect_url: opts.redirectUrl,
    metadata: { checkout_session_id: opts.sessionId, store_id: opts.storeId },
    plan: {
      product_id: store.whopProductId,
      plan_type: "one_time" as const,
      initial_price: Number(centsToDecimal(opts.totalCents)),
      currency: opts.currency.toLowerCase(),
      title: opts.title.slice(0, 80),
      visibility: "hidden" as const,
      unlimited_stock: true,
      force_create_new_plan: true,
      metadata: { checkout_session_id: opts.sessionId },
    },
  };
  const optional = (store.paymentMethods ?? []).filter((m) => OPTIONAL_PAYMENT_METHOD_IDS.includes(m));
  const attempts: string[][] = [
    [...CHECKOUT_PAYMENT_METHODS, ...optional],
    // An ineligible optional method must not cost the buyer PayPal & wallets.
    ...(optional.length ? [[...CHECKOUT_PAYMENT_METHODS]] : []),
  ];
  let config;
  let lastError: unknown;
  for (const enabled of attempts) {
    try {
      config = await client.checkoutConfigurations.create({
        ...base,
        payment_method_configuration: { enabled: enabled as (typeof CHECKOUT_PAYMENT_METHODS)[number][], include_platform_defaults: true },
      });
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!config) {
    // Last resort: the account's own defaults. A method problem must never block the sale.
    config = await client.checkoutConfigurations.create(base);
  }
  // What Whop will actually offer: report any requested method it dropped (once a day).
  const effective = config.effective_payment_method_configuration?.enabled;
  const dropped = effective ? [...CHECKOUT_PAYMENT_METHODS, ...optional].filter((m) => !effective.includes(m)) : lastError ? optional : [];
  if (dropped.length) await reportDroppedMethods(opts.storeId, dropped, lastError);
  return { id: config.id, purchaseUrl: config.purchase_url ?? null };
}

/**
 * Registers the checkout hostname for Apple Pay with Whop. Apple fetches
 * /.well-known/apple-developer-merchantid-domain-association from this app to verify it.
 */
export async function registerApplePayDomain(
  store: Pick<Store, "whopApiKey" | "testMode" | "whopAccountId">,
  hostname: string,
) {
  const client = storeClient(store);
  let existing: { id: string; status: string } | null = null;
  for await (const d of await client.paymentMethodDomains.list({ account_id: store.whopAccountId ?? undefined, hostname })) {
    if (d.hostname === hostname) {
      existing = d;
      break;
    }
  }
  if (existing?.status === "verified") return existing;
  if (existing) return client.paymentMethodDomains.verify({ id: existing.id });
  return client.paymentMethodDomains.create({ account_id: store.whopAccountId ?? undefined, hostname });
}

export async function refundPayment(
  store: Pick<Store, "whopApiKey" | "testMode">,
  paymentId: string,
  amountCents?: number,
) {
  return storeClient(store).payments.refund({
    id: paymentId,
    partial_amount: amountCents == null ? undefined : Number(centsToDecimal(amountCents)),
  });
}

export type WhopEvent = {
  type?: string;
  action?: string;
  id?: string;
  data?: Record<string, unknown>;
};

/** Verifies the Standard Webhooks signature on the raw body. Throws when invalid. */
export function verifyWhopWebhook(rawBody: string, headers: Headers, secret: string): WhopEvent {
  const h: Record<string, string> = {};
  headers.forEach((v, k) => (h[k] = v));
  return unwrapWebhook<WhopEvent>(rawBody, { headers: h, key: secret });
}

export function eventType(evt: WhopEvent): string {
  return (evt.type ?? evt.action ?? "").replace(/_(?=[a-z]+$)/, ".");
}

/** Whop money objects are `{ amount: "12.34" }` or plain numbers depending on the event. */
export function moneyToCents(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Math.round(value * 100);
  if (typeof value === "string") return Math.round(Number(value) * 100);
  if (typeof value === "object" && "amount" in value) return moneyToCents((value as { amount: unknown }).amount);
  return null;
}

/** Normalizes a Whop payment (webhook data or API object) for markPaid. */
export function paymentInfoFromWhop(data: Record<string, unknown>) {
  const total = (data.total ?? data.final_amount) as { currency?: string } | number | undefined;
  const presentment = data.presentment_total as { currency?: string } | null | undefined;
  const user = (data.user ?? null) as { email?: string } | null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  type Addr = {
    name: string | null;
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    country: string | null;
  };
  return {
    id: String(data.id),
    totalCents: moneyToCents(total),
    currency: typeof total === "object" && total?.currency ? total.currency : str(data.currency),
    presentmentCents: moneyToCents(presentment),
    presentmentCurrency: presentment?.currency ?? null,
    checkoutConfigurationId: str(data.checkout_configuration_id),
    memberId: str(data.member_id),
    paymentMethodId: str(data.payment_method_id),
    paymentMethodType: str(data.payment_method_type),
    // Whop's cut: total − what the account keeps (same currency only).
    feeCents: (() => {
      const after = data.amount_after_fees as { amount?: unknown; currency?: string } | undefined;
      const totalCents = moneyToCents(total);
      const afterCents = moneyToCents(after);
      const sameCurrency = typeof total === "object" && total?.currency && after?.currency ? total.currency.toLowerCase() === after.currency.toLowerCase() : true;
      return totalCents != null && afterCents != null && sameCurrency && totalCents >= afterCents ? totalCents - afterCents : null;
    })(),
    buyer: {
      email: str(data.customer_email) ?? user?.email ?? null,
      shippingAddress: (data.shipping_address ?? null) as Addr | null,
      address: (data.shipping_address ?? data.billing_address ?? null) as Addr | null,
      phone: str(data.customer_phone),
    },
  };
}

/**
 * Card statement descriptor for Whop: must start with "WHOP*", 5–22 characters, Latin
 * letters/digits/spaces/_/-, at least one letter. "Ma Boutique" → "WHOP*MA BOUTIQUE".
 */
export function statementDescriptor(name: string | null | undefined): string | null {
  const clean = (name ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^\s*WHOP\*/i, "")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .slice(0, 17)
    .trim();
  return /[A-Z]/.test(clean) ? `WHOP*${clean}` : null;
}

/** Records which payment methods Whop didn't enable, at most once a day per store. */
async function reportDroppedMethods(storeId: string, dropped: string[], err: unknown) {
  const key = `methods-dropped:${storeId}`;
  const today = new Date().toISOString().slice(0, 10);
  const value = `${today}:${[...dropped].sort().join(",")}`;
  const prev = await db.appSetting.findUnique({ where: { key } });
  if (prev?.value === value) return;
  await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
  await recordEvent({
    storeId,
    level: "warn",
    kind: "payment_methods.rejected",
    message: `Whop n'a pas activé : ${dropped.join(", ")}${err ? ` (${err instanceof Error ? err.message : String(err)})` : ""}. Activez-les dans Whop → Paramètres → Moyens de paiement, ou retirez-les.`,
    data: { dropped },
  });
}
