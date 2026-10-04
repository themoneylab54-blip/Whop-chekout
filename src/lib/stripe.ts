import "server-only";
import Stripe from "stripe";
import { createHash } from "node:crypto";
import { Prisma, type Store } from "@prisma/client";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { env } from "./env";
import { log } from "./log";
import { assertBreakerClosed, isTimeoutError, timeLeft, tripBreaker, DeadlineError } from "./deadline";
import type { PaymentInfo } from "./checkout";
import { stripeEnv, stripeModeOf, type StripeEnv, type StripeMode } from "./stripe-config";
import { checkoutHostOf } from "./checkout-domain";
import { isLocalHost } from "./host-guard";

export { stripeConfigured, stripeEnv, stripeModeOf, missingStripeEnv, type StripeMode } from "./stripe-config";

/*
 * Stripe (Connect, Standard accounts): the merchant connects their own Stripe account to the
 * operator's platform with OAuth ("Se connecter avec Stripe"). Every call is made with the platform's
 * secret key of the store's mode and the `Stripe-Account` header of the connected account (direct
 * charges: the funds, fees and disputes are the merchant's). Nothing of the merchant's is stored but
 * the account id. One Connect webhook endpoint (per mode) receives the connected accounts' events.
 */

/** Events the Connect webhook endpoint subscribes to (created by ensureConnectWebhook). */
export const STRIPE_WEBHOOK_EVENTS = [
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "account.application.deauthorized",
  // charges_enabled of the connected account (Store.stripeChargesEnabled)
  "account.updated",
] as const satisfies readonly Stripe.WebhookEndpointCreateParams.EnabledEvent[];

/** Dashboard reads of Stripe (page render): short, no retry — the page never waits on a slow Stripe. */
export const STRIPE_PAGE_CALL = { timeout: 4_000, maxNetworkRetries: 0 } as const;

const OAUTH_AUTHORIZE_URL = "https://connect.stripe.com/oauth/authorize";

/** A mode's configuration, or an error in French naming what the operator must set. */
export function requireStripeEnv(mode: StripeMode): StripeEnv {
  const cfg = stripeEnv(mode);
  if (!cfg) throw new Error(`Stripe n'est pas configuré sur ce serveur (clés ${mode === "test" ? "de test" : "live"} manquantes).`);
  return cfg;
}

/**
 * Request options of ONE Stripe call, computed when it starts: bounded so a slow Stripe can't outlast
 * a 60 s function. Inside a bounded background run: no SDK retry and never past the run's deadline
 * (DeadlineError when too little time is left). Pass it as the last argument of calls made in a
 * bounded run; interactive calls get the client's defaults (12 s, one retry).
 */
export function stripeCallOptions(what = "Stripe"): { timeout: number; maxNetworkRetries: number } {
  // Stripe hung earlier in this background run: its calls are refused at once (DeadlineError).
  assertBreakerClosed("stripe", what);
  const left = timeLeft();
  if (left != null && left < 2_000) throw new DeadlineError(what);
  return {
    timeout: left == null ? 12_000 : Math.max(1_000, Math.min(12_000, left - 500)),
    maxNetworkRetries: left == null ? 1 : 0,
  };
}

/** Every Stripe API call logged like Whop's and Shopify's (`ext.call`: provider metrics, health). */
const timedFetch: typeof fetch = async (input, init) => {
  const started = Date.now();
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let path = "/";
  try {
    path = new URL(url).pathname;
  } catch {
    /* keep "/" */
  }
  // Ids never reach the label (metrics group by operation): /v1/payment_intents/pi_123 → /v1/payment_intents/:id
  const op = `${init?.method ?? "GET"} ${path.replace(/\/(acct|pi|ch|re|dp|we|pm|cus|pmd|txn|evt|seti|py|ca)_[A-Za-z0-9]+/g, "/:id")}`;
  try {
    const res = await fetch(input, init);
    const ms = Date.now() - started;
    (ms > 5000 || res.status >= 400 ? log.warn : log.info)("ext.call", `Stripe ${op} ${res.status} in ${ms} ms`, {
      provider: "stripe",
      op,
      status: res.status,
      ms,
      upstreamId: res.headers.get("request-id"),
    });
    return res;
  } catch (err) {
    log.warn("ext.call", `Stripe ${op} failed`, { provider: "stripe", op, ms: Date.now() - started, err });
    // Hung until its timeout inside a background run: the run's Stripe breaker opens (see stripeCallOptions).
    if (isTimeoutError(err, init?.signal) && tripBreaker("stripe", `Stripe ${op}`)) {
      log.warn("tick.breaker_open", `Stripe hung (${op}): its calls are suspended for the rest of this run`, { provider: "stripe", op, ms: Date.now() - started });
    }
    throw err;
  }
};

const clients = new Map<string, Stripe>();

/** The platform client of a mode (cached per key). */
export function stripeClient(mode: StripeMode): Stripe {
  const cfg = requireStripeEnv(mode);
  let client = clients.get(cfg.secretKey);
  if (!client) {
    client = new Stripe(cfg.secretKey, {
      timeout: 12_000,
      maxNetworkRetries: 1,
      httpClient: Stripe.createFetchHttpClient(timedFetch),
      appInfo: { name: "Whop Checkout" },
    });
    clients.set(cfg.secretKey, client);
  }
  return client;
}

export type StripeStore = Pick<Store, "id" | "testMode" | "stripeAccountId">;

/**
 * The platform client of the store's mode and the connected account every call must carry
 * (`{ stripeAccount }` request option: direct charges on the merchant's account).
 */
export function stripeFor(store: StripeStore): { client: Stripe; stripeAccount: string; mode: StripeMode; publishableKey: string } {
  if (!store.stripeAccountId) throw new Error("Compte Stripe non connecté");
  const mode = stripeModeOf(store);
  const cfg = requireStripeEnv(mode);
  return { client: stripeClient(mode), stripeAccount: store.stripeAccountId, mode, publishableKey: cfg.publishableKey };
}

/* ------------------------------------------------------------------ */
/* Connect OAuth                                                       */
/* ------------------------------------------------------------------ */

export function stripeRedirectUri(): string {
  return `${env.appUrl}/api/stripe/connect/callback`;
}

/**
 * Stripe's consent page for a Standard account ("Se connecter avec Stripe"): read_write scope, the
 * callback on APP_URL, the store's name prefilled for a merchant creating an account there.
 */
export function oauthAuthorizeUrl(store: Pick<Store, "name" | "testMode">, state: string): string {
  const cfg = requireStripeEnv(stripeModeOf(store));
  const q = new URLSearchParams({ response_type: "code", client_id: cfg.clientId, scope: "read_write", redirect_uri: stripeRedirectUri(), state });
  if (store.name) q.set("stripe_user[business_name]", store.name.slice(0, 100));
  return `${OAUTH_AUTHORIZE_URL}?${q}`;
}

/** Exchanges the OAuth code: the connected account's id and whether the connection is live. */
export async function exchangeCode(code: string, mode: StripeMode): Promise<{ accountId: string; livemode: boolean; scope: string | null }> {
  const token = await stripeClient(mode).oauth.token({ grant_type: "authorization_code", code });
  if (!token.stripe_user_id) throw new Error("Stripe n'a pas renvoyé de compte connecté");
  return { accountId: token.stripe_user_id, livemode: token.livemode === true, scope: token.scope ?? null };
}

export type StripeAccountInfo = { id: string; name: string | null; email: string | null; country: string | null; chargesEnabled: boolean; defaultCurrency: string | null };

/** The connected account as the dashboard shows it (name, e-mail, country, can it charge). */
export async function retrieveAccount(accountId: string, mode: StripeMode, opts?: Stripe.RequestOptions): Promise<StripeAccountInfo> {
  const a = await stripeClient(mode).accounts.retrieve(accountId, {}, opts);
  return {
    id: a.id,
    name: a.business_profile?.name || a.settings?.dashboard?.display_name || null,
    email: a.email ?? null,
    country: a.country ?? null,
    chargesEnabled: a.charges_enabled === true,
    defaultCurrency: a.default_currency ?? null,
  };
}

/** Throws when the platform's own keys of the mode don't work (reads the platform's balance, no connected account). */
export async function probePlatformKeys(mode: StripeMode, opts?: Stripe.RequestOptions): Promise<void> {
  await stripeClient(mode).balance.retrieve({}, opts);
}

/** Revokes the platform's access to the account (the merchant's Stripe account itself is untouched). */
export async function deauthorize(accountId: string, mode: StripeMode): Promise<void> {
  const cfg = requireStripeEnv(mode);
  await stripeClient(mode).oauth.deauthorize({ client_id: cfg.clientId, stripe_user_id: accountId });
}

/* ------------------------------------------------------------------ */
/* Connect webhook                                                     */
/* ------------------------------------------------------------------ */

export function stripeWebhookUrl(): string {
  return `${env.appUrl}/api/webhooks/stripe`;
}

const webhookSettingKey = (mode: StripeMode) => `stripe:webhook:${mode}`;

type StoredWebhook = { id: string; url: string; secret: string };

async function readStoredWebhook(mode: StripeMode): Promise<StoredWebhook | null> {
  const row = await db.appSetting.findUnique({ where: { key: webhookSettingKey(mode) } });
  if (!row) return null;
  try {
    const v = JSON.parse(row.value) as Partial<StoredWebhook>;
    return typeof v.id === "string" && typeof v.url === "string" && typeof v.secret === "string" ? (v as StoredWebhook) : null;
  } catch {
    return null;
  }
}

/** The env signing secret of a mode: set = the operator made the endpoint by hand (never created nor deleted here). */
export function manualWebhookSecret(mode: StripeMode, source: Record<string, string | undefined> = process.env): string | null {
  return source[mode === "live" ? "STRIPE_WEBHOOK_SECRET" : "STRIPE_TEST_WEBHOOK_SECRET"]?.trim() || null;
}

/**
 * Whether the mode's endpoint is known (dashboard): stored by the app (at this URL), or made by hand
 * (env secret). With `checkManual` (request options: the page's short timeout), a hand-made one is
 * also looked up in Stripe: `manualFound` true when an enabled endpoint is at this URL, false when
 * none is, null when not checked or Stripe didn't answer.
 */
export async function stripeWebhookStatus(
  mode: StripeMode,
  checkManual?: Stripe.RequestOptions,
): Promise<{ manual: boolean; stored: boolean; storedUrl: string | null; manualFound: boolean | null }> {
  const stored = await readStoredWebhook(mode).catch(() => null);
  const manual = !!manualWebhookSecret(mode);
  let manualFound: boolean | null = null;
  if (manual && checkManual) {
    const url = stripeWebhookUrl();
    manualFound = await stripeClient(mode)
      .webhookEndpoints.list({ limit: 100 }, checkManual)
      .then((list) => list.data.some((e) => e.url === url && e.status === "enabled"))
      .catch(() => null);
  }
  return { manual, stored: !!stored && stored.url === stripeWebhookUrl(), storedUrl: stored?.url ?? null, manualFound };
}

const isNotFound = (err: unknown) => (err as { statusCode?: number } | null)?.statusCode === 404;

/** Adds the events the endpoint lacks (the list grew) and re-enables it. */
async function completeWebhookEvents(client: Stripe, ep: Stripe.WebhookEndpoint): Promise<void> {
  const missing = STRIPE_WEBHOOK_EVENTS.filter((e) => !ep.enabled_events.includes(e) && !ep.enabled_events.includes("*"));
  if (missing.length || ep.status !== "enabled") {
    await client.webhookEndpoints.update(ep.id, {
      ...(missing.length ? { enabled_events: [...new Set([...ep.enabled_events, ...STRIPE_WEBHOOK_EVENTS])] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[] } : {}),
      disabled: false,
    });
  }
}

// Comfortably longer than an ensureConnectWebhook run (several Stripe calls, with retries), so a slow
// but live run's claim is not taken over as a crashed one.
const WEBHOOK_LOCK_MS = 120_000;
const WEBHOOK_LOCK_WAIT_MS = 15_000;

/**
 * One ensureConnectWebhook per mode at a time, across instances: an AppSetting claim row
 * (`stripe:webhook-lock:<mode>`, value "<expiry ms>:<nonce>") inserted only if absent. Another run
 * holding it: waited for (it stores the endpoint this one then reuses). A claim past its expiry (a
 * crashed run) is taken over with a compare-and-delete, so two runs never both take it.
 */
async function withWebhookLock<T>(mode: StripeMode, fn: () => Promise<T>): Promise<T> {
  const key = `stripe:webhook-lock:${mode}`;
  const giveUpAt = Date.now() + WEBHOOK_LOCK_WAIT_MS;
  let mine: string | null = null;
  while (!mine) {
    const value = `${Date.now() + WEBHOOK_LOCK_MS}:${createHash("sha256").update(`${Math.random()}${process.pid}${Date.now()}`).digest("hex").slice(0, 12)}`;
    try {
      await db.appSetting.create({ data: { key, value } });
      mine = value;
      break;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    }
    const held = await db.appSetting.findUnique({ where: { key } });
    if (held && Number(held.value.split(":")[0]) < Date.now()) {
      await db.appSetting.deleteMany({ where: { key, value: held.value } });
      continue;
    }
    if (Date.now() >= giveUpAt) throw new Error("Configuration du webhook Stripe déjà en cours ailleurs : réessayez dans une minute.");
    await new Promise((r) => setTimeout(r, 500));
  }
  try {
    return await fn();
  } finally {
    await db.appSetting.deleteMany({ where: { key, value: mine } }).catch(() => undefined);
  }
}

/**
 * Makes sure the platform has ONE Connect webhook endpoint (connect: true: events of every connected
 * account) at this app's URL for the mode, and that its signing secret is stored (encrypted, in
 * AppSetting `stripe:webhook:<mode>`). Created on the first connection; reused afterwards (its
 * events completed when the list grew); re-created when it was deleted in Stripe or when an endpoint
 * at this URL exists without a known secret; the stored one of a previous APP_URL is deleted.
 * Serialized per mode (withWebhookLock). Hand-made mode (STRIPE_WEBHOOK_SECRET /
 * STRIPE_TEST_WEBHOOK_SECRET set): nothing is ever created or deleted, the endpoint at this URL is
 * only checked (and its missing events added); none there is an error naming what to do.
 */
export async function ensureConnectWebhook(mode: StripeMode): Promise<{ id: string; created: boolean; manual?: boolean }> {
  const client = stripeClient(mode);
  const url = stripeWebhookUrl();
  if (manualWebhookSecret(mode)) {
    const envName = mode === "live" ? "STRIPE_WEBHOOK_SECRET" : "STRIPE_TEST_WEBHOOK_SECRET";
    const ep = (await client.webhookEndpoints.list({ limit: 100 })).data.find((e) => e.url === url);
    if (!ep) throw new Error(`aucun webhook Stripe à l'adresse ${url} alors que ${envName} est renseigné : créez-le dans Stripe (Connect) ou retirez ${envName}`);
    await completeWebhookEvents(client, ep);
    return { id: ep.id, created: false, manual: true };
  }
  return withWebhookLock(mode, async () => {
    const stored = await readStoredWebhook(mode);
    if (stored && stored.url === url) {
      try {
        await completeWebhookEvents(client, await client.webhookEndpoints.retrieve(stored.id));
        return { id: stored.id, created: false };
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
    } else if (stored) {
      // APP_URL changed: the old endpoint would keep sending events to an address nobody serves.
      await client.webhookEndpoints.del(stored.id).catch((err) => {
        if (!isNotFound(err)) log.warn("stripe.webhook_delete_failed", "Could not delete the Stripe webhook endpoint of the previous APP_URL", { mode, url: stored.url, err });
      });
    }
    // An endpoint at this URL whose secret we don't have (its setting was lost): Stripe only shows a
    // secret at creation, so it is replaced.
    const existing = await client.webhookEndpoints.list({ limit: 100 });
    for (const ep of existing.data) {
      if (ep.url === url) await client.webhookEndpoints.del(ep.id).catch(() => undefined);
    }
    const ep = await client.webhookEndpoints.create({
      url,
      connect: true,
      enabled_events: [...STRIPE_WEBHOOK_EVENTS],
      api_version: Stripe.API_VERSION as Stripe.WebhookEndpointCreateParams.ApiVersion,
      description: "Whop Checkout — paiements des comptes Stripe connectés (créé automatiquement)",
    });
    if (!ep.secret) throw new Error("Stripe n'a pas renvoyé de secret de webhook");
    const value = JSON.stringify({ id: ep.id, url, secret: encrypt(ep.secret) } satisfies StoredWebhook);
    await db.appSetting.upsert({ where: { key: webhookSettingKey(mode) }, create: { key: webhookSettingKey(mode), value }, update: { value } });
    return { id: ep.id, created: true };
  });
}

/** Signing secrets to try on an incoming event: the stored ones (live, then test), then the env fallbacks. */
export async function stripeWebhookSecrets(): Promise<{ mode: StripeMode; secret: string }[]> {
  const out: { mode: StripeMode; secret: string }[] = [];
  for (const mode of ["live", "test"] as const) {
    const stored = await readStoredWebhook(mode).catch(() => null);
    if (stored) {
      try {
        out.push({ mode, secret: decrypt(stored.secret) });
      } catch (err) {
        log.error("stripe.webhook_secret_unreadable", "Stored Stripe webhook secret can't be decrypted (ENCRYPTION_KEY changed?)", { mode, err });
      }
    }
  }
  for (const mode of ["live", "test"] as const) {
    const fromEnv = process.env[mode === "live" ? "STRIPE_WEBHOOK_SECRET" : "STRIPE_TEST_WEBHOOK_SECRET"]?.trim();
    if (fromEnv && !out.some((o) => o.secret === fromEnv)) out.push({ mode, secret: fromEnv });
  }
  return out;
}

/** The verified event and the mode whose secret signed it, or null (no secret matches). */
export async function verifyStripeWebhook(raw: string, signature: string | null): Promise<{ event: Stripe.Event; mode: StripeMode } | null> {
  if (!signature) return null;
  for (const { mode, secret } of await stripeWebhookSecrets()) {
    try {
      return { event: Stripe.webhooks.constructEvent(raw, signature, secret), mode };
    } catch {
      /* next secret */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Apple Pay / wallets: payment method domains                         */
/* ------------------------------------------------------------------ */

export type StripeDomainStatus = "active" | "inactive" | "absent";

function domainStatus(d: Stripe.PaymentMethodDomain | undefined): StripeDomainStatus {
  if (!d) return "absent";
  return d.enabled && d.apple_pay?.status === "active" ? "active" : "inactive";
}

/** Hosts where this store's buyers pay: its verified checkout domain, then APP_URL's host (never a local one). */
export function stripeWalletHosts(store: Parameters<typeof checkoutHostOf>[0]): string[] {
  return [...new Set([checkoutHostOf(store), new URL(env.appUrl).hostname])].filter((h) => !isLocalHost(h));
}

/**
 * Registers a host where buyers pay (the store's checkout domain, APP_URL's host) on the connected
 * account, so Apple Pay / Google Pay / Link show in Stripe's Payment Element there. Idempotent: an
 * existing domain is re-validated instead of created twice.
 */
export async function registerStripeDomain(store: StripeStore, domain: string): Promise<StripeDomainStatus> {
  const { client, stripeAccount } = stripeFor(store);
  const found = (await client.paymentMethodDomains.list({ domain_name: domain, limit: 1 }, { stripeAccount })).data[0];
  if (!found) return domainStatus(await client.paymentMethodDomains.create({ domain_name: domain, enabled: true }, { stripeAccount }));
  if (domainStatus(found) === "active") return "active";
  const d = found.enabled ? found : await client.paymentMethodDomains.update(found.id, { enabled: true }, { stripeAccount });
  return domainStatus(await client.paymentMethodDomains.validate(d.id, {}, { stripeAccount }).catch(() => d));
}

export type StripeDomainState = { status: StripeDomainStatus; error: string | null };

/**
 * Apple Pay state of each host on the connected account (dashboard), with Stripe's reason when it is
 * not active (apple_pay.status_details.error_message). `opts`: request options (page: short timeout).
 */
export async function stripeDomainStatuses(store: StripeStore, hosts: string[], opts?: Stripe.RequestOptions): Promise<Record<string, StripeDomainState>> {
  const { client, stripeAccount } = stripeFor(store);
  const list = await client.paymentMethodDomains.list({ limit: 100 }, { ...opts, stripeAccount });
  return Object.fromEntries(
    hosts.map((h) => {
      const d = list.data.find((x) => x.domain_name === h);
      const status = domainStatus(d);
      return [h, { status, error: status === "inactive" ? (d?.apple_pay?.status_details?.error_message ?? (d && !d.enabled ? "Domaine désactivé chez Stripe" : null)) : null }];
    }),
  );
}

/* ------------------------------------------------------------------ */
/* Payments                                                            */
/* ------------------------------------------------------------------ */

/** Currencies Stripe counts in whole units (no minor unit). https://docs.stripe.com/currencies#zero-decimal */
const ZERO_DECIMAL = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
/** Currencies Stripe counts in thousandths. */
const THREE_DECIMAL = new Set(["bhd", "jod", "kwd", "omr", "tnd"]);

/** A Stripe amount (smallest unit of `currency`) in the app's cents (hundredths everywhere). Pure. */
export function stripeAmountToCents(amount: number | null | undefined, currency: string | null | undefined): number | null {
  if (amount == null || !Number.isFinite(amount)) return null;
  const c = (currency ?? "").toLowerCase();
  if (ZERO_DECIMAL.has(c)) return Math.round(amount * 100);
  if (THREE_DECIMAL.has(c)) return Math.round(amount / 10);
  return Math.round(amount);
}

/** The app's cents in Stripe's smallest unit of `currency` (inverse of stripeAmountToCents). Pure. */
export function centsToStripeAmount(cents: number, currency: string): number {
  const c = currency.toLowerCase();
  if (ZERO_DECIMAL.has(c)) return Math.round(cents / 100);
  if (THREE_DECIMAL.has(c)) return Math.round(cents * 10);
  return Math.round(cents);
}

type StripeAddressLike = { line1?: string | null; line2?: string | null; city?: string | null; state?: string | null; postal_code?: string | null; country?: string | null } | null | undefined;

function addressOf(a: StripeAddressLike, name: string | null | undefined) {
  if (!a) return null;
  const str = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const out = { name: str(name), line1: str(a.line1), line2: str(a.line2), city: str(a.city), state: str(a.state), postal_code: str(a.postal_code), country: str(a.country) };
  return out.line1 || out.city || out.country ? out : null;
}

const idOf = (v: string | { id: string } | null | undefined): string | null => (typeof v === "string" ? v : (v?.id ?? null));

/** How the buyer paid, in the app's words (card, apple_pay, google_pay, paypal, klarna, link…). Pure. */
export function stripeMethodType(charge: Pick<Stripe.Charge, "payment_method_details"> | null | undefined): string | null {
  const d = charge?.payment_method_details;
  if (!d?.type) return null;
  if (d.type === "card") {
    const wallet = d.card?.wallet?.type;
    if (wallet === "apple_pay" || wallet === "google_pay" || wallet === "link" || wallet === "samsung_pay") return wallet;
  }
  return d.type;
}

/**
 * Stripe's processing fee on a charge, in the charge's currency and the app's cents: from its balance
 * transaction when expanded (converted back from the settlement currency with Stripe's own rate). Pure.
 */
export function stripeFeeCents(charge: Pick<Stripe.Charge, "balance_transaction" | "currency"> | null | undefined): number | null {
  const bt = charge?.balance_transaction;
  if (!bt || typeof bt === "string") return null;
  // The fee in app cents of the settlement currency (its own decimals: JPY whole units, KWD thousandths…).
  const settled = stripeAmountToCents(bt.fee, bt.currency);
  if (settled == null) return null;
  if (bt.currency.toLowerCase() === charge.currency.toLowerCase()) return settled;
  // exchange_rate: charge currency → settlement currency. App cents are hundredths in every currency,
  // so dividing converts them back as is (never re-scaled by the charge currency's decimals).
  if (!bt.exchange_rate || !Number.isFinite(bt.exchange_rate) || bt.exchange_rate <= 0) return null;
  return Math.round(settled / bt.exchange_rate);
}

/**
 * The store as the Stripe API helpers (stripeFor) must see it for an event: the event's mode (a test
 * event of a live store — a live connection covers both modes — or an event left over from before a
 * mode switch is read back with the keys of the mode it happened in) and the event's connected account
 * (an account the store was connected to before: disconnected or replaced). Unchanged when both match.
 * Only for Stripe calls: the store's own fields (testMode, stripeAccountId) keep their meaning elsewhere. Pure.
 */
export function stripeForMode<T extends StripeStore>(store: T, livemode: boolean | null | undefined, account?: string | null): T {
  const testMode = typeof livemode === "boolean" ? !livemode : store.testMode;
  const stripeAccountId = account || store.stripeAccountId;
  if (testMode === store.testMode && stripeAccountId === store.stripeAccountId) return store;
  return { ...store, testMode, stripeAccountId };
}

/**
 * Normalizes a succeeded PaymentIntent (and its charge: `latest_charge` expanded, or passed apart,
 * with `balance_transaction` expanded for the fee) to the PaymentInfo markPaid reads. Pure.
 */
export function paymentInfoFromStripe(pi: Stripe.PaymentIntent, chargeArg?: Stripe.Charge | null): PaymentInfo {
  const charge = chargeArg ?? (pi.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null);
  const currency = (charge?.currency ?? pi.currency ?? "").toUpperCase() || null;
  const amount = charge ? charge.amount : pi.amount_received || pi.amount;
  const billing = charge?.billing_details;
  const shipping = pi.shipping ?? charge?.shipping ?? null;
  const shippingAddress = addressOf(shipping?.address, shipping?.name);
  return {
    id: pi.id,
    provider: "stripe",
    totalCents: stripeAmountToCents(amount, currency),
    currency,
    presentmentCents: null,
    presentmentCurrency: null,
    checkoutConfigurationId: null,
    // Whop's member / payment method fields stay empty: Stripe's have their own columns.
    memberId: null,
    paymentMethodId: null,
    stripeCustomerId: idOf(pi.customer),
    stripePaymentMethodId: idOf(pi.payment_method) ?? idOf(charge?.payment_method),
    paymentMethodType: stripeMethodType(charge),
    feeCents: stripeFeeCents(charge),
    // The snapshot the PaymentIntent was created (or last updated) for, hashed (see fingerprintTag): markPaid checks it.
    stripeFingerprint: typeof pi.metadata?.fingerprint === "string" && pi.metadata.fingerprint ? pi.metadata.fingerprint : null,
    // Whether the paid PaymentIntent saved the card for off-session use (one-click offers).
    stripeOffSessionSaved: pi.setup_future_usage === "off_session",
    // The payment's mode (markPaid holds one of the other mode than the store's; the Shopify order's test flag follows it).
    livemode: typeof pi.livemode === "boolean" ? pi.livemode : null,
    buyer: {
      email: pi.receipt_email || billing?.email || charge?.receipt_email || null,
      shippingAddress,
      address: shippingAddress ?? addressOf(billing?.address, billing?.name),
      phone: shipping?.phone || billing?.phone || null,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Checkout: PaymentIntents (direct charges on the connected account)  */
/* ------------------------------------------------------------------ */

/** PaymentIntent states where nothing was submitted yet: its amount can still change. */
const PI_UPDATABLE = new Set<Stripe.PaymentIntent.Status>(["requires_payment_method", "requires_confirmation"]);
/** PaymentIntent states of a payment made or going through (paid, processing, authorized): never replaced nor changed. */
export const PI_SETTLING = new Set<Stripe.PaymentIntent.Status>(["succeeded", "processing", "requires_capture"]);

/** Cleanup calls made after the answer (cancel a replaced PaymentIntent…): short, no retry. */
export const STRIPE_CLEANUP_CALL = { timeout: 3_000, maxNetworkRetries: 0 } as const;

/**
 * The store's name as the dynamic suffix of the card statement ("<ACCOUNT PREFIX>* <SUFFIX>"): ASCII
 * letters, digits and spaces only, at most 12 characters, at least one letter; null otherwise. Pure.
 */
export function stripeDescriptorSuffix(name: string | null | undefined): string | null {
  const clean = (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .slice(0, 12)
    .trim();
  return /[A-Z]/.test(clean) ? clean : null;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** The snapshot fingerprint as kept in the PaymentIntent's metadata (hashed: metadata values are ≤ 500 chars). Pure. */
export function fingerprintTag(fingerprint: string): string {
  return sha(fingerprint).slice(0, 32);
}

/** What a checkout PaymentIntent must charge: the snapshot's fingerprint, amount and currency (app cents). */
export type PaymentIntentTarget = { fingerprint: string; amountCents: number; currency: string };

/** The buyer's side of a PaymentIntent, when known (prepare: maybe nothing yet; confirm: everything). */
export type PaymentIntentBuyer = {
  email?: string | null;
  customerId?: string | null;
  shipping?: Stripe.PaymentIntentCreateParams.Shipping | null;
};

/**
 * A checkout PaymentIntent as the checkout keeps it. `offSessionSaved`: created (or kept) with
 * setup_future_usage "off_session" (the card is saved for a one-click offer). `replacedId`: the
 * PaymentIntent it replaces (a new one was created instead of reusing `existingId`).
 */
export type CheckoutPaymentIntent = {
  id: string;
  clientSecret: string;
  status: Stripe.PaymentIntent.Status;
  customerId: string | null;
  amount: number;
  currency: string;
  offSessionSaved: boolean;
  replacedId?: string | null;
};

function checkoutPi(pi: Stripe.PaymentIntent): CheckoutPaymentIntent {
  if (!pi.client_secret) throw new Error("Stripe n'a pas renvoyé de client_secret");
  return {
    id: pi.id,
    clientSecret: pi.client_secret,
    status: pi.status,
    customerId: idOf(pi.customer),
    amount: pi.amount,
    currency: pi.currency,
    offSessionSaved: pi.setup_future_usage === "off_session",
  };
}

/** This deployment's host, in every checkout PaymentIntent's metadata (`app_host`): the webhook ignores other deployments' (staging, previews on the same accounts). */
export function stripeAppHost(): string {
  try {
    return new URL(env.appUrl).host;
  } catch {
    return "";
  }
}

/**
 * Whether a Stripe error is a refusal of this one request (a 4xx other than 429 and other than an
 * authentication / permission problem: currency not supported, amount too small, idempotency
 * conflict, invalid request…) rather than Stripe being unreachable or the connection broken. Such a
 * refusal may switch this buyer to the other processor, but never counts towards the store-level
 * failover. Pure.
 */
export function isStripeRejection(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: unknown; type?: unknown };
  const status = typeof e.statusCode === "number" ? e.statusCode : null;
  if (status === 401 || status === 403 || status === 429) return false;
  if (status != null) return status >= 400 && status < 500;
  return e.type === "StripeInvalidRequestError" || e.type === "StripeIdempotencyError" || e.type === "StripeCardError";
}

/**
 * Whether a Stripe error says the object asked for doesn't exist (404, `resource_missing`: a
 * PaymentIntent or Customer deleted on the connected account, or never there). `param`: only when
 * that parameter is the one missing (e.g. "customer" on a PaymentIntent create). Pure.
 */
export function isStripeMissing(err: unknown, param?: string): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { statusCode?: unknown; code?: unknown; param?: unknown; raw?: { param?: unknown } };
  const missing = e.statusCode === 404 || e.code === "resource_missing";
  if (!missing || param == null) return missing;
  return (e.param ?? e.raw?.param) === param;
}

/**
 * Cancels the checkout PaymentIntents given, when nothing was submitted on them yet
 * (requires_payment_method / requires_confirmation): a buyer switched to the other processor, or a
 * PaymentIntent replaced by a new one, can never be paid on top (a stale tab confirming it). Best
 * effort, never throws; returns the ids canceled.
 */
export async function cancelOpenPaymentIntents(
  store: StripeStore,
  ids: (string | null | undefined)[],
  callOptions: { timeout: number; maxNetworkRetries: number } = STRIPE_CLEANUP_CALL,
): Promise<string[]> {
  const unique = [...new Set(ids.filter((id): id is string => !!id))];
  if (!unique.length || !store.stripeAccountId) return [];
  let client: Stripe;
  let stripeAccount: string;
  try {
    ({ client, stripeAccount } = stripeFor(store));
  } catch {
    return [];
  }
  // In parallel, each call short (cleanup after the answer: never holds anything up).
  const done = await Promise.all(
    unique.map(async (id) => {
      try {
        const pi = await client.paymentIntents.retrieve(id, {}, { stripeAccount, ...callOptions });
        if (!PI_UPDATABLE.has(pi.status)) return null;
        await client.paymentIntents.cancel(id, { cancellation_reason: "abandoned" }, { stripeAccount, ...callOptions });
        return id;
      } catch (err) {
        log.info("stripe.pi_cancel_failed", "Could not cancel a replaced PaymentIntent", { storeId: store.id, paymentIntentId: id, err });
        return null;
      }
    }),
  );
  return done.filter((id): id is string => !!id);
}

/** Whether a PaymentIntent charges exactly this target (amount, currency, snapshot). Pure. */
export function paymentIntentMatches(pi: Pick<Stripe.PaymentIntent, "amount" | "currency" | "metadata">, target: PaymentIntentTarget): boolean {
  return (
    pi.amount === centsToStripeAmount(target.amountCents, target.currency) &&
    pi.currency.toLowerCase() === target.currency.toLowerCase() &&
    pi.metadata?.fingerprint === fingerprintTag(target.fingerprint)
  );
}

/** Stripe's shipping details from a checkout address (none without a name and a first line). Pure. */
export function stripeShipping(
  a: { firstName?: string | null; lastName?: string | null; address1?: string | null; address2?: string | null; city?: string | null; province?: string | null; zip?: string | null; countryCode?: string | null; phone?: string | null } | null | undefined,
): Stripe.PaymentIntentCreateParams.Shipping | null {
  const name = `${a?.firstName ?? ""} ${a?.lastName ?? ""}`.trim();
  if (!a || !name || !a.address1) return null;
  return {
    name,
    phone: a.phone || undefined,
    address: {
      line1: a.address1,
      line2: a.address2 || undefined,
      city: a.city || undefined,
      state: a.province || undefined,
      postal_code: a.zip || undefined,
      country: a.countryCode || undefined,
    },
  };
}

/**
 * Where the merchant turns off Stripe's own receipts (Paramètres → E-mails clients → Paiements
 * réussis). The PaymentIntent hangs on a Customer with the buyer's e-mail: with that setting on, the
 * connected account e-mails a receipt on top of Shopify's confirmation. The app can't switch it (a
 * setting of the merchant's own Stripe account): the Stripe page's « Reçus Stripe » card says how.
 */
export const STRIPE_EMAIL_SETTINGS_URL = "https://dashboard.stripe.com/settings/emails";

/**
 * The session's Customer on the connected account (the saved card of a one-click offer hangs on it):
 * ONE per checkout session, never another buyer's found by e-mail (an e-mail typed on a checkout
 * proves nothing: reusing that Customer would attach a stranger's card to it). The one already
 * recorded on the session is kept (its e-mail / name updated when the buyer changed them); otherwise
 * it is created with the session id as idempotency key (two tabs, a retry: the same Customer) and
 * `checkout_session_id` in its metadata. No list call.
 *
 * A recorded Customer gone from the account (deleted: 404 on its update), or `replaces` (the one a
 * PaymentIntent call just said is missing): a fresh one is created, under an idempotency key salted
 * with the missing id (the session's first key would replay that deleted Customer).
 */
export async function ensureStripeCustomer(
  store: StripeStore,
  c: { email: string; name?: string | null; sessionId: string; customerId?: string | null; previousEmail?: string | null; replaces?: string | null },
): Promise<string> {
  const { client, stripeAccount } = stripeFor(store);
  const email = c.email.trim().toLowerCase();
  const name = c.name ? c.name.slice(0, 200) : null;
  const create = async (replaces: string | null) => {
    const created = await client.customers.create(
      { email, ...(name ? { name } : {}), metadata: { checkout_session_id: c.sessionId, store_id: store.id } },
      { stripeAccount, idempotencyKey: `wc_cus_${c.sessionId}${replaces ? `_${sha(replaces).slice(0, 16)}` : ""}` },
    );
    return created.id;
  };
  if (c.replaces) return create(c.replaces);
  if (c.customerId) {
    if ((c.previousEmail ?? "").trim().toLowerCase() !== email) {
      try {
        await client.customers.update(c.customerId, { email, ...(name ? { name } : {}) }, { stripeAccount });
      } catch (err) {
        if (!isStripeMissing(err)) throw err;
        log.info("stripe.customer_missing", "The session's Stripe Customer is gone: a new one is created", { storeId: store.id, sessionId: c.sessionId, customerId: c.customerId });
        return create(c.customerId);
      }
    }
    return c.customerId;
  }
  return create(null);
}

/**
 * The checkout's PaymentIntent for a snapshot (direct charge on the store's connected account): the
 * existing one when it already charges this snapshot; else that one updated in place when nothing was
 * submitted on it and nothing is in flight (`reusable`: same client secret, the page's Payment Element
 * stays mounted and only fetches the new amount); else a new one. Amount and currency come from the
 * snapshot (the buyer's currency when the store charges in it). Metadata ties it to the session, the
 * store and the snapshot (fingerprint hash), which the webhook and the confirm read back. The card is
 * saved for the one-click offer (`saveCard`: setup_future_usage off_session, on the buyer's Customer).
 * The creation is idempotent per session, snapshot, previous PaymentIntent and every parameter sent.
 * `cancelReplaced`: the previous PaymentIntent, when replaced by a new one while nothing was submitted
 * on it, is canceled (best effort) so a stale page can never pay it on top of the new one.
 * `app_host` (this deployment's host) in the metadata lets the webhook ignore other deployments'.
 */
export async function createOrUpdatePaymentIntent(
  store: StripeStore & Pick<Store, "name">,
  session: { id: string; storeId: string },
  target: PaymentIntentTarget,
  opts: { existingId?: string | null; reusable?: boolean; buyer?: PaymentIntentBuyer; saveCard?: boolean; description?: string | null; cancelReplaced?: boolean } = {},
): Promise<CheckoutPaymentIntent> {
  const { client, stripeAccount } = stripeFor(store);
  const currency = target.currency.toLowerCase();
  const amount = centsToStripeAmount(target.amountCents, currency);
  const metadata = { checkout_session_id: session.id, store_id: session.storeId, fingerprint: fingerprintTag(target.fingerprint), app_host: stripeAppHost() };
  const buyer = opts.buyer ?? {};
  // No receipt_email: the app never asks Stripe for a receipt (Shopify confirms the order). But the
  // PaymentIntent hangs on a Customer carrying the buyer's e-mail: a connected account with
  // « Paiements réussis » customer e-mails on (Stripe dashboard → Paramètres → E-mails clients) still
  // sends Stripe's receipt — only the merchant can turn it off (the Stripe page's « Reçus Stripe » card).
  const buyerParams = {
    ...(buyer.customerId ? { customer: buyer.customerId } : {}),
    ...(buyer.shipping ? { shipping: buyer.shipping } : {}),
  };
  let previous: Stripe.PaymentIntent | null = null;
  // The existing PaymentIntent gone from the account (404: deleted, never there): a fresh one below.
  const existing = opts.existingId
    ? await client.paymentIntents.retrieve(opts.existingId, {}, { stripeAccount }).catch((err: unknown) => {
        if (!isStripeMissing(err)) throw err;
        log.info("stripe.pi_missing", "The checkout's PaymentIntent is gone: a new one is created", { storeId: store.id, paymentIntentId: opts.existingId });
        return null;
      })
    : null;
  if (existing) {
    const pi = existing;
    previous = pi;
    // Paid, or a payment going through on it (processing, authorized): never replaced, whatever it
    // charges. Returned as is: the caller settles it (already paid) or waits (payment in flight).
    if (PI_SETTLING.has(pi.status)) return checkoutPi(pi);
    const open = PI_UPDATABLE.has(pi.status) || pi.status === "requires_action";
    if (paymentIntentMatches(pi, target) && open) {
      // The buyer's details are added (never changed under a payment being submitted); a Customer
      // already on it stays (Stripe keeps the saved card on that one).
      const { customer, ...rest } = buyerParams as typeof buyerParams & { customer?: string };
      const update = { ...rest, ...(customer && !pi.customer ? { customer } : {}) };
      if (PI_UPDATABLE.has(pi.status) && Object.keys(update).length) {
        return checkoutPi(await client.paymentIntents.update(pi.id, update, { stripeAccount }));
      }
      return checkoutPi(pi);
    }
    if (opts.reusable && PI_UPDATABLE.has(pi.status) && (!pi.customer || !buyer.customerId || idOf(pi.customer) === buyer.customerId)) {
      return checkoutPi(await client.paymentIntents.update(pi.id, { amount, currency, metadata, ...buyerParams }, { stripeAccount }));
    }
  }
  const suffix = stripeDescriptorSuffix(store.name);
  const description = (opts.description ?? `Commande ${store.name}`).slice(0, 300);
  const params: Stripe.PaymentIntentCreateParams = {
    amount,
    currency,
    automatic_payment_methods: { enabled: true },
    metadata,
    description,
    ...(suffix ? { statement_descriptor_suffix: suffix } : {}),
    ...(opts.saveCard ? { setup_future_usage: "off_session" as const } : {}),
    ...buyerParams,
  };
  // Same snapshot, same previous PaymentIntent, same buyer and same wording (description, statement
  // suffix: a store renamed meanwhile): a retry gets the same PaymentIntent, and never Stripe's
  // idempotency_error for a key reused with other parameters.
  const idempotencyKey = `wc_pi_${session.id}_${sha(JSON.stringify([target.fingerprint, opts.existingId ?? null, buyerParams, !!opts.saveCard, description, suffix, metadata.app_host])).slice(0, 32)}`;
  let pi = await client.paymentIntents.create(params, { stripeAccount, idempotencyKey });
  // A replay of a creation whose PaymentIntent was canceled since (replaced, the session switched
  // processor): created again under a key salted with the canceled one (a later retry replays the
  // new one). Bounded: never a loop on an account canceling everything.
  for (let round = 0; pi.status === "canceled" && round < 3; round++) {
    pi = await client.paymentIntents.create(params, { stripeAccount, idempotencyKey: `${idempotencyKey}_r${sha(pi.id).slice(0, 12)}` });
  }
  if (pi.status === "canceled") throw new Error("Stripe n'a renvoyé que des PaymentIntents annulés");
  // A replay of a creation whose PaymentIntent was later moved to another snapshot: set back.
  if (!paymentIntentMatches(pi, target) && PI_UPDATABLE.has(pi.status)) {
    pi = await client.paymentIntents.update(pi.id, { amount, currency, metadata }, { stripeAccount });
  }
  // The PaymentIntent it replaces: canceled while nothing was submitted on it (never payable on top).
  if (previous && previous.id !== pi.id && opts.cancelReplaced && PI_UPDATABLE.has(previous.status)) {
    await client.paymentIntents.cancel(previous.id, { cancellation_reason: "abandoned" }, { stripeAccount }).catch((err: unknown) => {
      log.info("stripe.pi_cancel_failed", "Could not cancel a replaced PaymentIntent", { storeId: store.id, paymentIntentId: previous!.id, err });
    });
  }
  return { ...checkoutPi(pi), replacedId: previous && previous.id !== pi.id ? previous.id : null };
}

/** Recovery probe: can the connected account take payments again (reachable, charges enabled)? Throws otherwise. */
export async function probeStripe(store: StripeStore): Promise<void> {
  const { client, stripeAccount } = stripeFor(store);
  const account = await client.accounts.retrieve(stripeAccount, {}, stripeCallOptions("Stripe sonde"));
  if (account.charges_enabled === false) throw new Error("Le compte Stripe ne peut pas encaisser (charges désactivées)");
}

/* ------------------------------------------------------------------ */
/* Money flow: payments, refunds, disputes, off-session offers         */
/* ------------------------------------------------------------------ */
// Every Stripe call of the money flow goes through one of these (one place to bound, log and mock them).

/**
 * A PaymentIntent with its charge and the charge's balance transaction (fee) expanded. `callOptions`:
 * a page's own budget (e.g. STRIPE_PAGE_CALL: short, no retry); the bounded defaults otherwise.
 */
export async function retrievePaymentIntent(store: StripeStore, id: string, callOptions?: { timeout: number; maxNetworkRetries: number }): Promise<Stripe.PaymentIntent> {
  const { client, stripeAccount } = stripeFor(store);
  return client.paymentIntents.retrieve(id, { expand: ["latest_charge.balance_transaction"] }, { stripeAccount, ...(callOptions ?? stripeCallOptions("Stripe paiement")) });
}

/**
 * Refunds a PaymentIntent on the connected account. `amountCents`: in the app's cents of `currency`
 * (the currency the buyer was charged in); undefined = everything left. The idempotency key makes a
 * double submit or an SDK retry refund once.
 */
export async function refundStripe(store: StripeStore, paymentIntentId: string, amountCents: number | undefined, idempotencyKey: string, currency?: string | null): Promise<Stripe.Refund> {
  const { client, stripeAccount } = stripeFor(store);
  const amount = amountCents == null ? undefined : currency ? centsToStripeAmount(amountCents, currency) : Math.round(amountCents);
  return client.refunds.create(
    { payment_intent: paymentIntentId, ...(amount != null ? { amount } : {}), metadata: { source: "whop-checkout" } },
    { stripeAccount, idempotencyKey: idempotencyKey.slice(0, 255), ...stripeCallOptions("Stripe remboursement") },
  );
}

/** Every refund of a charge (newest first; a charge rarely has more than a few). */
export async function listChargeRefunds(store: StripeStore, chargeId: string): Promise<Stripe.Refund[]> {
  const { client, stripeAccount } = stripeFor(store);
  const page = await client.refunds.list({ charge: chargeId, limit: 100 }, { stripeAccount, ...stripeCallOptions("Stripe remboursements") });
  return page.data;
}

/** One refund as Stripe has it now (a replayed / reconciled copy may be stale). Short timeout, no retry. */
export async function retrieveStripeRefund(store: StripeStore, refundId: string): Promise<Stripe.Refund> {
  const { client, stripeAccount } = stripeFor(store);
  return client.refunds.retrieve(refundId, {}, { stripeAccount, ...STRIPE_PAGE_CALL });
}

/**
 * Why a dispute can't take evidence any more (answered already — in Stripe or by an earlier run — or
 * no longer waiting for a response), null when it can. Pure.
 */
export function stripeDisputeClosedReason(d: Pick<Stripe.Dispute, "status"> & { evidence_details?: { submission_count?: number | null } | null }): string | null {
  const submitted = d.evidence_details?.submission_count ?? 0;
  if (submitted > 0) return `preuves déjà envoyées (${submitted} envoi${submitted > 1 ? "s" : ""})`;
  if (d.status !== "needs_response" && d.status !== "warning_needs_response") return `statut ${d.status}`;
  return null;
}

/**
 * Fills a dispute's evidence and submits it (submit: true) on the connected account — unless the
 * dispute, read first, was already answered or no longer needs a response (`{ skipped }`: never a
 * second submission over the merchant's own answer).
 */
export async function submitStripeDispute(store: StripeStore, disputeId: string, evidence: Stripe.DisputeUpdateParams.Evidence): Promise<Stripe.Dispute | { skipped: string }> {
  const { client, stripeAccount } = stripeFor(store);
  const current = await client.disputes.retrieve(disputeId, {}, { stripeAccount, ...stripeCallOptions("Stripe litige") });
  const closed = stripeDisputeClosedReason(current);
  if (closed) return { skipped: closed };
  return client.disputes.update(disputeId, { evidence, submit: true }, { stripeAccount, ...stripeCallOptions("Stripe litige") });
}

export type OffSessionCharge = {
  amountCents: number;
  currency: string;
  customer: string;
  paymentMethod: string;
  description: string;
  metadata: Record<string, string>;
  shipping?: Stripe.PaymentIntentCreateParams.Shipping;
  statementDescriptorSuffix?: string | null;
  idempotencyKey: string;
};

/**
 * One-click offer: a PaymentIntent confirmed at once, off session, on the payment method the buyer
 * saved at checkout. Throws Stripe's error as is (a card error carries `code` — authentication_required,
 * card_declined… — and the failed PaymentIntent in `payment_intent`).
 */
export async function chargeOffSession(store: StripeStore, c: OffSessionCharge): Promise<Stripe.PaymentIntent> {
  const { client, stripeAccount } = stripeFor(store);
  return client.paymentIntents.create(
    {
      amount: centsToStripeAmount(c.amountCents, c.currency),
      currency: c.currency.toLowerCase(),
      customer: c.customer,
      payment_method: c.paymentMethod,
      off_session: true,
      confirm: true,
      // The saved card only: no method needing a redirect (impossible off session, no return URL).
      automatic_payment_methods: { enabled: true, allow_redirects: "never" },
      description: c.description.slice(0, 1000),
      metadata: c.metadata,
      ...(c.shipping ? { shipping: c.shipping } : {}),
      ...(c.statementDescriptorSuffix ? { statement_descriptor_suffix: c.statementDescriptorSuffix.slice(0, 22) } : {}),
      expand: ["latest_charge.balance_transaction"],
    },
    { stripeAccount, idempotencyKey: c.idempotencyKey.slice(0, 255), ...stripeCallOptions("Stripe offre") },
  );
}

/** Event types the reconciliation re-reads (the payment, refund and dispute ones). */
export const STRIPE_RECONCILED_EVENTS = [
  "payment_intent.succeeded",
  "charge.refunded",
  "charge.refund.updated",
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
] as const;

/**
 * One page (newest first) of the connected account's events of those types created since `sinceSec`
 * (Unix seconds; Stripe keeps 30 days). `startingAfter`: the last event id of the previous page.
 */
export async function listStripeEvents(store: StripeStore, sinceSec: number, startingAfter?: string | null): Promise<{ data: Stripe.Event[]; hasMore: boolean }> {
  const { client, stripeAccount } = stripeFor(store);
  const page = await client.events.list(
    { types: [...STRIPE_RECONCILED_EVENTS], created: { gte: Math.floor(sinceSec) }, limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) },
    { stripeAccount, ...stripeCallOptions("Stripe événements") },
  );
  return { data: page.data, hasMore: page.has_more };
}

/** An event of the connected account, re-read from Stripe (replay of an event whose stored copy was truncated). */
export async function retrieveStripeEvent(store: StripeStore, eventId: string): Promise<Stripe.Event> {
  const { client, stripeAccount } = stripeFor(store);
  return client.events.retrieve(eventId, {}, { stripeAccount, ...stripeCallOptions("Stripe événement") });
}

/** The payment in the merchant's Stripe dashboard (direct charge: on the connected account; test mode under /test). Pure. */
export function stripePaymentUrl(accountId: string | null | undefined, paymentIntentId: string, testMode: boolean): string {
  return `https://dashboard.stripe.com/${accountId ? `${accountId}/` : ""}${testMode ? "test/" : ""}payments/${paymentIntentId}`;
}
