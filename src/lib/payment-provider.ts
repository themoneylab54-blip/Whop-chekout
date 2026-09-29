import type { PaymentMode, Store } from "@prisma/client";
import { stripeConfigured, stripeModeOf } from "./stripe-config";

/*
 * Which payment processor a checkout charges through: Whop (historical, default) or Stripe (Connect,
 * the merchant's own Standard account). Pure: no I/O, the env is passed in (defaults to process.env).
 *
 * Store.paymentMode:
 *   whop_primary   Whop first, Stripe as secours (recommended, the default)
 *   stripe_primary Stripe first, Whop as secours
 *   stripe_only    Stripe only (Whop never used, even when connected)
 *
 * Store.providerFailoverAt means "the primary processor is failing": new sessions use the secondary
 * one until it is cleared (by the recovery probe or by hand). A processor that is not connected is
 * never chosen; with neither usable the answer is null (the caller falls back to Shopify's checkout).
 */

export type PaymentProvider = "whop" | "stripe";

export const PROVIDER_NAMES: Record<PaymentProvider, string> = { whop: "Whop", stripe: "Stripe" };

/** The modes as the merchant reads them (dashboard, journal, health). */
export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  whop_primary: "Whop principal, Stripe en secours",
  stripe_primary: "Stripe principal, Whop en secours",
  stripe_only: "Stripe uniquement",
};

export type ProviderStore = Pick<Store, "paymentMode" | "providerFailoverAt" | "testMode" | "whopConnectedAt" | "stripeAccountId" | "stripeConnectedAt" | "stripeLivemode"> &
  // Optional so a narrow select without it still type-checks; left out, it counts as unknown (usable).
  Partial<Pick<Store, "stripeChargesEnabled">>;

type Env = Record<string, string | undefined>;

/**
 * Whether a processor can take this store's payments now. Whop: connected. Stripe: an account is
 * connected, the platform keys of the store's mode are set, the connection covers that mode (a live
 * OAuth connection also grants test mode; a test-mode connection only test mode), and Stripe hasn't
 * said the account can't charge (stripeChargesEnabled false; null / unknown counts as usable).
 */
export function providerConnected(store: Omit<ProviderStore, "paymentMode" | "providerFailoverAt">, p: PaymentProvider, source: Env = process.env): boolean {
  if (p === "whop") return !!store.whopConnectedAt;
  if (!store.stripeAccountId || !store.stripeConnectedAt) return false;
  if (!store.testMode && store.stripeLivemode !== true) return false;
  if (store.stripeChargesEnabled === false) return false;
  return stripeConfigured(stripeModeOf(store), source);
}

/** Why a connected Stripe account can't be used, in French (null: usable, or not connected at all). Pure. */
export function stripeUnusableReason(store: Omit<ProviderStore, "paymentMode" | "providerFailoverAt">, source: Env = process.env): string | null {
  if (!store.stripeAccountId || !store.stripeConnectedAt) return null;
  if (!stripeConfigured(stripeModeOf(store), source)) return "Les clés Stripe de ce mode manquent sur le serveur : Stripe ne peut pas encaisser tant qu'elles ne sont pas ajoutées.";
  if (!store.testMode && store.stripeLivemode !== true) return "Ce compte a été connecté en mode test : reconnectez Stripe en production pour encaisser.";
  if (store.stripeChargesEnabled === false) return "Paiements pas encore activés : terminez l'activation de votre compte dans Stripe (Stripe ne peut pas encaisser en attendant).";
  return null;
}

/** Primary and secondary processor of a mode (stripe_only has no secondary). Pure. */
export function providerOrder(mode: PaymentMode): PaymentProvider[] {
  if (mode === "stripe_only") return ["stripe"];
  if (mode === "stripe_primary") return ["stripe", "whop"];
  return ["whop", "stripe"];
}

export type ProviderChoiceReason =
  /** The mode's primary processor. */
  | "primary"
  /** Store-level failover (providerFailoverAt): the primary is failing. */
  | "failover"
  /** The primary is not connected: the secondary is the only one usable. */
  | "primary_unavailable"
  /** The caller asked for this processor (preview « Tester le secours », per-session switch). */
  | "forced";

export type ProviderChoice = { provider: PaymentProvider; reason: ProviderChoiceReason };

/**
 * The processor a new payment attempt uses, or null when none is usable. `forced` (preview test of
 * the secours, per-session switch after a failure) is honoured when that processor is connected and
 * allowed by the mode (stripe_only never uses Whop); otherwise null, never the other one silently.
 *
 * Extension point: a future permanent percentage to Stripe (merchant setting, not built yet) goes
 * here, between `forced` and the failover rule: a sticky per-session draw (hash of the session id
 * below the percentage) swaps the order, and failover still wins over it. Pure.
 */
export function chooseProvider(store: ProviderStore, opts: { forced?: PaymentProvider | null; env?: Env } = {}): ProviderChoice | null {
  const env = opts.env ?? process.env;
  const order = providerOrder(store.paymentMode);
  if (opts.forced) {
    return order.includes(opts.forced) && providerConnected(store, opts.forced, env) ? { provider: opts.forced, reason: "forced" } : null;
  }
  const [primary, secondary] = order;
  const primaryOk = providerConnected(store, primary, env);
  const secondaryOk = secondary != null && providerConnected(store, secondary, env);
  if (store.providerFailoverAt && secondaryOk) return { provider: secondary, reason: "failover" };
  if (primaryOk) return { provider: primary, reason: "primary" };
  if (secondaryOk) return { provider: secondary, reason: "primary_unavailable" };
  return null;
}

/** Whether the store can take payments at all (at least one processor usable under its mode). Pure. */
export function anyProviderConnected(store: ProviderStore, env: Env = process.env): boolean {
  return chooseProvider(store, { env }) != null;
}

/** The columns anyProviderConnected / storeLive read, for a narrow Prisma `select`. */
export const PROVIDER_STORE_SELECT = {
  paymentMode: true,
  providerFailoverAt: true,
  testMode: true,
  whopConnectedAt: true,
  stripeAccountId: true,
  stripeConnectedAt: true,
  stripeLivemode: true,
  stripeChargesEnabled: true,
} as const;

/** Shopify connected and a processor able to charge (Whop, or Stripe alone): the checkout can be switched on. Pure. */
export function storeReady(store: ProviderStore & Pick<Store, "shopifyConnectedAt">, env: Env = process.env): boolean {
  return !!store.shopifyConnectedAt && anyProviderConnected(store, env);
}

/** Switched on and ready: buyers go through this checkout (« En ligne »). Pure. */
export function storeLive(store: ProviderStore & Pick<Store, "enabled" | "shopifyConnectedAt">, env: Env = process.env): boolean {
  return store.enabled && storeReady(store, env);
}

/**
 * Checks a new payment mode against the connections: Stripe-first and Stripe-only need Stripe
 * connected. Returns the problem in French, or null when the mode can be saved. Pure.
 */
export function paymentModeProblem(store: Omit<ProviderStore, "paymentMode" | "providerFailoverAt">, mode: PaymentMode, env: Env = process.env): string | null {
  if (mode === "whop_primary") return null;
  if (store.stripeAccountId && store.stripeConnectedAt && store.stripeChargesEnabled === false) {
    return "Votre compte Stripe ne peut pas encore encaisser (paiements pas activés) : terminez son activation dans Stripe avant de le faire passer en premier.";
  }
  if (!providerConnected(store, "stripe", env)) {
    return mode === "stripe_only"
      ? "Connectez d'abord Stripe : sans compte Stripe connecté, « Stripe uniquement » bloquerait tous les paiements."
      : "Connectez d'abord Stripe : il doit être connecté pour passer en premier.";
  }
  return null;
}
