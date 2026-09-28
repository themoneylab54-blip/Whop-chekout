import "server-only";
import { WhopClient, WhopEnvironment } from "@whop/sdk";
import { unwrapWebhook } from "@whop/sdk/helpers";
import type { Store } from "@prisma/client";
import { decrypt } from "./crypto";
import { env } from "./env";
import { centsToDecimal } from "./pricing";
import { log, recordEvent } from "./log";
import { assertBreakerClosed, DeadlineError, isTimeoutError, timeLeft, tripBreaker } from "./deadline";
import { db } from "./db";

/** Events the app subscribes to when it creates the Whop webhook itself. */
export const WHOP_WEBHOOK_EVENTS = [
  "payment.succeeded",
  "payment.failed",
  "refund.created",
  "refund.updated",
  "dispute.created",
  "dispute.updated",
  "dispute_alert.created",
] as const;

/**
 * Request options of ONE Whop call, computed when the call starts (not when the client was created):
 * bounded so a slow Whop can't outlast a 60 s function (the SDK default is 60 s x 3). Inside background
 * maintenance: no SDK retry (it may wait up to 60 s on Retry-After) and never past the run's hard
 * deadline nor the money job's own deadline; DeadlineError when a call couldn't finish (the tick
 * retries next run). Pass it as the second argument of every call made in a bounded run
 * (`client.payments.list(params, whopCallOptions())`): a client created early in a job, then used
 * for several pages, otherwise keeps the timeout of its creation time.
 */
export function whopCallOptions(what = "Whop"): { timeoutInSeconds: number; maxRetries: number } {
  // Whop hung earlier in this background run: refused at once (the run's other jobs keep their time).
  assertBreakerClosed("whop", what);
  const left = timeLeft();
  // One Whop request (no SDK retry inside a bounded run) answers well under a second: 2 s is a real window.
  if (left != null && left < 2_000) throw new DeadlineError(what);
  return {
    timeoutInSeconds: left == null ? 12 : Math.max(1, Math.min(12, Math.floor((left - 500) / 100) / 10)),
    maxRetries: left == null ? 1 : 0,
  };
}

export function whopClient(apiKey: string, testMode: boolean) {
  // Defaults for calls made right away; calls made later in a bounded run pass whopCallOptions().
  return new WhopClient({
    token: apiKey,
    environment: testMode ? WhopEnvironment.Sandbox : WhopEnvironment.Production,
    ...whopCallOptions(),
    fetch: timedFetch,
  });
}

/** Every Whop API call logged like Shopify's: operation, status, duration, Whop's request id. */
const timedFetch: typeof fetch = async (input, init) => {
  const started = Date.now();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const op = `${init?.method ?? "GET"} ${new URL(url).pathname.replace(/\/(pay|biz|plan|prod|re|dp|chk|mem|ship)_[A-Za-z0-9]+/g, "/:id")}`;
  try {
    const res = await fetch(input, init);
    const ms = Date.now() - started;
    (ms > 5000 || res.status >= 400 ? log.warn : log.info)("ext.call", `Whop ${op} ${res.status} in ${ms} ms`, {
      provider: "whop",
      op,
      status: res.status,
      ms,
      upstreamId: res.headers.get("x-request-id"),
      retryAfter: res.headers.get("retry-after"),
    });
    return res;
  } catch (err) {
    log.warn("ext.call", `Whop ${op} failed`, { provider: "whop", op, ms: Date.now() - started, err });
    // Hung until its timeout inside a background run: the run's Whop breaker opens (its other Whop
    // calls are refused at once), so the Shopify-side money jobs still get their time.
    if (isTimeoutError(err, init?.signal) && tripBreaker("whop", `Whop ${op}`)) {
      log.warn("tick.breaker_open", `Whop hung (${op}): its calls are suspended for the rest of this run`, { provider: "whop", op, ms: Date.now() - started });
    }
    throw err;
  }
};

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
    log.warn("whop.product_lookup_failed", "Whop product lookup failed, creating a new one", { err });
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
    log.warn("whop.webhook_cleanup_failed", "Whop webhook cleanup failed", { err });
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

const EEA = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "IS", "LI", "NO"];
type MethodRule = { countries?: string[]; currencies?: string[]; minCents?: number; maxCents?: number };
/**
 * Where each optional method can actually be used (buyer country, currency, basket
 * range). Offering an ineligible method only makes the buyer fail at the last step,
 * and Whop may reject the whole configuration for it.
 */
export const METHOD_RULES: Record<string, MethodRule> = {
  klarna: { countries: ["AT", "BE", "CH", "CZ", "DE", "DK", "ES", "FI", "FR", "GB", "GR", "IE", "IT", "NL", "NO", "PL", "PT", "SE"], minCents: 100, maxCents: 1_000_000 },
  alma: { countries: ["FR", "BE", "IT", "ES", "DE", "NL", "PT", "LU", "IE", "AT"], currencies: ["EUR"], minCents: 5_000, maxCents: 300_000 },
  oney_3x: { countries: ["FR", "BE", "ES", "IT", "PT"], currencies: ["EUR"], minCents: 10_000, maxCents: 300_000 },
  oney_4x: { countries: ["FR", "BE", "ES", "IT", "PT"], currencies: ["EUR"], minCents: 10_000, maxCents: 300_000 },
  scalapay: { countries: ["FR", "IT", "ES", "BE", "DE", "NL", "PT", "AT", "FI"], currencies: ["EUR"], minCents: 500, maxCents: 150_000 },
  bancontact: { countries: ["BE"], currencies: ["EUR"] },
  ideal: { countries: ["NL"], currencies: ["EUR"] },
  twint: { countries: ["CH"], currencies: ["CHF"] },
  sepa_debit: { countries: EEA.concat(["CH", "GB", "MC", "SM", "AD", "VA"]), currencies: ["EUR"] },
  eps: { countries: ["AT"], currencies: ["EUR"] },
  p24: { countries: ["PL"], currencies: ["PLN", "EUR"] },
  blik: { countries: ["PL"], currencies: ["PLN"] },
  multibanco: { countries: ["PT"], currencies: ["EUR"] },
  mb_way: { countries: ["PT"], currencies: ["EUR"] },
  satispay: { countries: ["IT", "FR", "DE", "LU", "BE"], currencies: ["EUR"] },
  revolut_pay: { countries: EEA.concat(["GB", "CH"]) },
};

/** Optional methods usable for this basket. An unknown country keeps country-bound methods (Whop still filters by buyer). */
export function eligibleMethods(methods: string[], ctx: { country: string | null; currency: string; totalCents: number }): string[] {
  const currency = ctx.currency.toUpperCase();
  const country = ctx.country?.toUpperCase() ?? null;
  return methods.filter((m) => {
    const r = METHOD_RULES[m];
    if (!r) return true;
    if (r.currencies && !r.currencies.includes(currency)) return false;
    if (r.minCents != null && ctx.totalCents < r.minCents) return false;
    if (r.maxCents != null && ctx.totalCents > r.maxCents) return false;
    if (country && r.countries && !r.countries.includes(country)) return false;
    return true;
  });
}

/**
 * Raised when a checkout restricted to some methods (PayPal only) can't offer them. `remember`:
 * Whop said the method itself is unavailable (dropped from the effective config, or a refusal
 * naming it), so the store may remember it; false = a refusal that doesn't say why (this session only).
 */
export class MethodUnavailableError extends Error {
  constructor(
    readonly methods: readonly string[],
    readonly remember = true,
  ) {
    super(`Whop n'a pas activé : ${methods.join(", ")}`);
    this.name = "MethodUnavailableError";
  }
}

/**
 * Creates the one-off checkout for a session; the embed is rendered with its id.
 * `methods` restricts it to those methods only (e.g. ["paypal"] for the express PayPal
 * button): same plan, price and metadata, so webhooks, markPaid and reconciliation treat it
 * exactly like the regular one. It never falls back to other methods: a restricted checkout
 * Whop can't honour throws MethodUnavailableError. `paypal` says whether Whop will offer PayPal.
 */
export async function createCheckoutConfiguration(
  store: Pick<Store, "whopApiKey" | "testMode" | "whopAccountId" | "whopProductId"> & { paymentMethods?: string[] },
  opts: {
    sessionId: string;
    storeId: string;
    totalCents: number;
    currency: string;
    title: string;
    redirectUrl: string;
    country?: string | null;
    methods?: readonly string[];
  },
): Promise<{ id: string; purchaseUrl: string | null; paypal: boolean | null }> {
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
  if (opts.methods?.length) {
    const only = [...opts.methods];
    let restricted;
    try {
      restricted = await client.checkoutConfigurations.create({
        ...base,
        payment_method_configuration: { enabled: only as (typeof CHECKOUT_PAYMENT_METHODS)[number][], disabled: [], include_platform_defaults: false },
      });
    } catch (err) {
      log.warn("whop.restricted_config_failed", `Whop refused a ${only.join("+")} checkout`, { storeId: opts.storeId, err });
      // Only a clear refusal of the request (400/422) means "method not available". A 5xx, a 429,
      // a timeout or a network error says nothing about PayPal: rethrown as is (nothing remembered).
      // Only a refusal naming PayPal / the payment method is remembered for the store; any other
      // 400/422 (bad amount, plan…) makes PayPal unavailable for this session only.
      if (isMethodRefusal(err)) throw new MethodUnavailableError(only, refusalNamesMethod(err, only));
      throw err;
    }
    const enabled = restricted.effective_payment_method_configuration?.enabled;
    const missing = enabled ? only.filter((m) => !enabled.includes(m)) : [];
    if (missing.length) throw new MethodUnavailableError(missing);
    // Whop confirmed PayPal (effective config) → on; silent → unknown (never remembered as "on").
    return { id: restricted.id, purchaseUrl: restricted.purchase_url ?? null, paypal: enabled && only.includes("paypal") ? true : null };
  }
  const optional = eligibleMethods(
    (store.paymentMethods ?? []).filter((m) => OPTIONAL_PAYMENT_METHOD_IDS.includes(m)),
    { country: opts.country ?? null, currency: opts.currency, totalCents: opts.totalCents },
  );
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
  let usedFallback = false;
  if (!config) {
    // Last resort: the account's own defaults. A method problem must never block the sale.
    config = await client.checkoutConfigurations.create(base);
    usedFallback = true;
  }
  // What Whop will actually offer: report any requested method it dropped (once a day).
  const effective = config.effective_payment_method_configuration?.enabled;
  const dropped = effective ? [...CHECKOUT_PAYMENT_METHODS, ...optional].filter((m) => !effective.includes(m)) : lastError ? optional : [];
  if (dropped.length) await reportDroppedMethods(opts.storeId, dropped, lastError);
  // Whop silent about what it enabled: PayPal unknown (null) — neither remembered "on" nor "off".
  // The account-defaults fallback (reached after errors, possibly transient ones) never asked for
  // PayPal: its absence there proves nothing, so only a confirmed "on" is reported.
  const paypal = effective ? effective.includes("paypal") : null;
  return { id: config.id, purchaseUrl: config.purchase_url ?? null, paypal: usedFallback && paypal === false ? null : paypal };
}

/** A Whop answer refusing the request itself (400/422): the method is not available for it. */
export function isMethodRefusal(err: unknown): boolean {
  const status = (err as { statusCode?: unknown; status?: unknown } | null)?.statusCode ?? (err as { status?: unknown } | null)?.status;
  return status === 400 || status === 422;
}

/** Whether a Whop refusal's message / code / body names the payment method (or one of `methods`). */
export function refusalNamesMethod(err: unknown, methods: readonly string[] = []): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: unknown; code?: unknown; error?: unknown; body?: unknown; param?: unknown };
  const parts: string[] = [];
  for (const v of [e.message, e.code, e.param, e.error, e.body]) {
    if (typeof v === "string") parts.push(v);
    else if (v && typeof v === "object") {
      try {
        parts.push(JSON.stringify(v));
      } catch {
        // Circular body: its message/code above still count.
      }
    }
  }
  const text = parts.join(" ").toLowerCase();
  if (/payment[_\s-]?method/.test(text)) return true;
  return ["paypal", ...methods].some((m) => m && text.includes(m.toLowerCase()));
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

/**
 * Removes a checkout hostname the store no longer uses from its Whop Apple Pay domains (absent is
 * fine). Returns true when one was removed.
 */
export async function unregisterApplePayDomain(store: Pick<Store, "whopApiKey" | "testMode" | "whopAccountId">, hostname: string): Promise<boolean> {
  const client = storeClient(store);
  for await (const d of await client.paymentMethodDomains.list({ account_id: store.whopAccountId ?? undefined, hostname }, whopCallOptions("Whop Apple Pay domains"))) {
    if (d.hostname === hostname) {
      await client.paymentMethodDomains.delete({ id: d.id }, whopCallOptions("Whop Apple Pay domains"));
      return true;
    }
  }
  return false;
}

/**
 * Apple Pay status Whop reports for each checkout hostname ("verified", "pending"…; "absent" when not
 * registered), or null when Whop is slow or failing (the page never waits more than `timeoutMs`).
 */
export async function applePayDomainStatuses(
  store: Pick<Store, "whopApiKey" | "testMode" | "whopAccountId">,
  hostnames: string[],
  timeoutMs = 2_500,
): Promise<Record<string, string> | null> {
  const load = (async () => {
    const client = storeClient(store);
    const out: Record<string, string> = Object.fromEntries(hostnames.map((h) => [h, "absent"]));
    for (const hostname of hostnames) {
      for await (const d of await client.paymentMethodDomains.list({ account_id: store.whopAccountId ?? undefined, hostname })) {
        if (d.hostname === hostname) {
          out[hostname] = d.status;
          break;
        }
      }
    }
    return out;
  })().catch(() => null);
  return Promise.race([load, new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs))]);
}

/**
 * Refunds a payment. `idempotencyKey` is required: the SDK retries on 5xx/timeouts,
 * and a refund Whop committed before a lost answer must not be issued twice.
 */
export async function refundPayment(
  store: Pick<Store, "whopApiKey" | "testMode">,
  paymentId: string,
  amountCents: number | undefined,
  idempotencyKey: string,
) {
  return storeClient(store).payments.refund(
    {
      id: paymentId,
      partial_amount: amountCents == null ? undefined : Number(centsToDecimal(amountCents)),
    },
    { idempotencyKey: idempotencyKey.slice(0, 200) },
  );
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
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) : null;
  if (typeof value === "string") {
    const n = Number(value);
    return value.trim() !== "" && Number.isFinite(n) ? Math.round(n * 100) : null;
  }
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
