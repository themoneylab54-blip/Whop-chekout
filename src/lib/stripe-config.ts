/*
 * Stripe platform configuration (the operator's Stripe account, Connect enabled), read from the
 * environment. Two sets: live (STRIPE_*) and test (STRIPE_TEST_*); a store in test mode uses the test
 * set. Pure given `source` (no SDK, no I/O): the provider choice and the dashboard read it too.
 *
 *   STRIPE_SECRET_KEY / STRIPE_TEST_SECRET_KEY            platform secret key (sk_live_… / sk_test_…)
 *   STRIPE_PUBLISHABLE_KEY / STRIPE_TEST_PUBLISHABLE_KEY  platform publishable key (pk_…)
 *   STRIPE_CLIENT_ID / STRIPE_TEST_CLIENT_ID              Connect OAuth client id (ca_…)
 *   STRIPE_WEBHOOK_SECRET / STRIPE_TEST_WEBHOOK_SECRET    optional: Connect webhook secret (whsec_…),
 *                                                         only when the app did not create the endpoint
 */

export type StripeMode = "live" | "test";

export type StripeEnv = {
  mode: StripeMode;
  secretKey: string;
  publishableKey: string;
  clientId: string;
  /** Fallback webhook secret from the environment (the app stores the one it creates itself). */
  webhookSecret: string | null;
};

/** The mode a store charges in: its test mode switch picks the test keys. Pure. */
export function stripeModeOf(store: { testMode: boolean }): StripeMode {
  return store.testMode ? "test" : "live";
}

/** Env var names of a mode (also shown to the merchant when something is missing). */
export function stripeEnvNames(mode: StripeMode) {
  const p = mode === "test" ? "STRIPE_TEST_" : "STRIPE_";
  return {
    secretKey: `${p}SECRET_KEY`,
    publishableKey: `${p}PUBLISHABLE_KEY`,
    clientId: `${p}CLIENT_ID`,
    webhookSecret: `${p}WEBHOOK_SECRET`,
  } as const;
}

/** A mode's configuration, or null when its secret key, publishable key or client id is missing. Pure given `source`. */
export function stripeEnv(mode: StripeMode, source: Record<string, string | undefined> = process.env): StripeEnv | null {
  const n = stripeEnvNames(mode);
  const secretKey = source[n.secretKey]?.trim();
  const publishableKey = source[n.publishableKey]?.trim();
  const clientId = source[n.clientId]?.trim();
  if (!secretKey || !publishableKey || !clientId) return null;
  return { mode, secretKey, publishableKey, clientId, webhookSecret: source[n.webhookSecret]?.trim() || null };
}

/** Whether the platform keys of a mode are all set. Pure given `source`. */
export function stripeConfigured(mode: StripeMode, source: Record<string, string | undefined> = process.env): boolean {
  return stripeEnv(mode, source) != null;
}

/** Names of the env vars of a mode that are missing (dashboard help). Pure given `source`. */
export function missingStripeEnv(mode: StripeMode, source: Record<string, string | undefined> = process.env): string[] {
  const n = stripeEnvNames(mode);
  return [n.secretKey, n.publishableKey, n.clientId].filter((k) => !source[k]?.trim());
}
