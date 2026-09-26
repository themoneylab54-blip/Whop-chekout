import "server-only";
import { WhopClient, WhopEnvironment } from "@whop/sdk";
import { unwrapWebhook } from "@whop/sdk/helpers";
import type { Store } from "@prisma/client";
import { decrypt } from "./crypto";
import { env } from "./env";
import { centsToDecimal } from "./pricing";

/** Events the app subscribes to when it creates the Whop webhook itself. */
export const WHOP_WEBHOOK_EVENTS = [
  "payment.succeeded",
  "payment.failed",
  "refund.created",
  "refund.updated",
  "dispute.created",
] as const;

export function whopClient(apiKey: string, testMode: boolean) {
  return new WhopClient({
    token: apiKey,
    environment: testMode ? WhopEnvironment.Sandbox : WhopEnvironment.Production,
  });
}

function storeClient(store: Pick<Store, "whopApiKey" | "testMode">) {
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
export async function setupWhop(opts: { apiKey: string; testMode: boolean; storeId: string; storeName: string }) {
  const client = whopClient(opts.apiKey, opts.testMode);
  const account = await client.accounts.me();

  const product = await client.products.create({
    account_id: account.id,
    title: `${opts.storeName || "Boutique"} — Checkout`,
    description: "Commandes de la boutique Shopify (créé automatiquement par Whop Checkout).",
    visibility: "hidden",
    collect_shipping_address: false,
    send_welcome_message: false,
    metadata: { source: "whop-checkout", store_id: opts.storeId },
  });

  const webhook = await client.webhooks.create({
    url: whopWebhookUrl(opts.storeId),
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

export async function teardownWhop(store: Pick<Store, "whopApiKey" | "testMode" | "whopWebhookId">) {
  if (!store.whopWebhookId) return;
  await storeClient(store).webhooks.delete({ id: store.whopWebhookId });
}

/** Creates the one-off checkout for a session; the embed is rendered with its id. */
export async function createCheckoutConfiguration(
  store: Pick<Store, "whopApiKey" | "testMode" | "whopAccountId" | "whopProductId">,
  opts: { sessionId: string; storeId: string; totalCents: number; currency: string; title: string; redirectUrl: string },
) {
  if (!store.whopAccountId || !store.whopProductId) throw new Error("Compte Whop non configuré");
  const config = await storeClient(store).checkoutConfigurations.create({
    account_id: store.whopAccountId,
    currency: opts.currency.toLowerCase(),
    redirect_url: opts.redirectUrl,
    metadata: { checkout_session_id: opts.sessionId, store_id: opts.storeId },
    plan: {
      product_id: store.whopProductId,
      plan_type: "one_time",
      initial_price: Number(centsToDecimal(opts.totalCents)),
      currency: opts.currency.toLowerCase(),
      title: opts.title.slice(0, 80),
      visibility: "hidden",
      unlimited_stock: true,
      force_create_new_plan: true,
      metadata: { checkout_session_id: opts.sessionId },
    },
  });
  return { id: config.id, purchaseUrl: config.purchase_url ?? null };
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
