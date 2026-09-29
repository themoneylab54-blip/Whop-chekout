import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { snapshotFingerprint, switchTarget, CheckoutError, withFailureSource, inFlightAttempt, checkoutFailureSource, DELETED_SUFFIX, isDbError, isDeletedFingerprint, isPaypalFingerprint, tagFailureSource } from "@/lib/checkout";
import { chooseProvider } from "@/lib/payment-provider";
import { activeProvider, effectiveProvider, failureSourceOf, uncountedFailure } from "@/lib/fallback";
import { fingerprintTag, isStripeMissing, isStripeRejection, paymentIntentMatches, stripeDescriptorSuffix, stripeShipping } from "@/lib/stripe";
import { cleanThankYouUrl, failedReturnUrl } from "@/lib/stripe-return";
import { stripeAppearance, stripeErrorText, stripeExpressAny, stripeExpressPaymentMethods, walletBuyer } from "@/components/checkout/StripePanel";
import { preparedFromBody, samePrepared } from "@/components/checkout/Payment";
import { loadTheme } from "@/lib/layout";
import { contrastRatio } from "@/lib/contrast";

/* Checkout on Stripe, pure parts: fingerprints, provider choice for a switch, failover helpers,
 * PaymentIntent helpers, the theme → Stripe Appearance mapping, express wallets and the client's
 * reading of prepare answers. */

const env = { STRIPE_TEST_SECRET_KEY: "sk_test_u", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_u", STRIPE_TEST_CLIENT_ID: "ca_test_u" };
const quote = { totals: { totalCents: 3000, subtotalCents: 3000, discountCents: 0, shippingCents: 0, addOnsCents: 0 }, shippingRateId: null, discount: null, addOnIds: [] } as unknown as Parameters<typeof snapshotFingerprint>[0];

describe("snapshot fingerprint", () => {
  it("includes the processor for Stripe; Whop's are unchanged (PayPal and host suffixes)", () => {
    const whop = snapshotFingerprint(quote, null, null);
    expect(snapshotFingerprint(quote, null, null, "stripe")).toBe(`${whop}|p:stripe`);
    expect(snapshotFingerprint(quote, "paypal", null, "whop")).toBe(`${whop}|m:paypal`);
    // A PaymentIntent carries no return URL: no host suffix on Stripe.
    expect(snapshotFingerprint(quote, null, "https://pay.shop.fr/c/x/merci", "stripe")).toBe(`${whop}|p:stripe`);
  });
});

describe("provider choice for a per-session switch", () => {
  const base = {
    paymentMode: "whop_primary" as const,
    providerFailoverAt: null,
    testMode: true,
    whopConnectedAt: new Date(),
    stripeAccountId: "acct_1",
    stripeConnectedAt: new Date(),
    stripeLivemode: false,
  };
  const session = (store: Record<string, unknown> = {}, s: Record<string, unknown> = {}) =>
    ({ status: "OPEN", payClickedAt: null, paypalWindowAt: null, paypalBeatAt: null, paymentProvider: "whop", forcedProvider: null, store: { ...base, ...store }, ...s }) as unknown as Parameters<typeof switchTarget>[0];

  it("switches a Whop failure to Stripe (and back), only when the other one is usable", () => {
    Object.assign(process.env, env);
    try {
      expect(switchTarget(session(), {}, new Error("Whop 503"))).toBe("stripe");
      expect(switchTarget(session({ paymentMode: "stripe_primary" }), {}, withFailureSource(new Error("x"), "stripe"))).toBe("whop");
      // stripe_only never uses Whop; Stripe not connected: nothing to switch to.
      expect(switchTarget(session({ paymentMode: "stripe_only" }), {}, withFailureSource(new Error("x"), "stripe"))).toBeNull();
      expect(switchTarget(session({ stripeAccountId: null }), {}, new Error("Whop 503"))).toBeNull();
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  it("never for a refusal, a Shopify failure, PayPal-only, a forced session or a payment in flight", () => {
    Object.assign(process.env, env);
    try {
      expect(switchTarget(session(), {}, new CheckoutError("expired", "x"))).toBeNull();
      expect(switchTarget(session(), {}, withFailureSource(new Error("x"), "shopify"))).toBeNull();
      expect(switchTarget(session(), { method: "paypal" }, new Error("x"))).toBeNull();
      expect(switchTarget(session({}, { forcedProvider: "stripe" }), {}, new Error("x"))).toBeNull();
      expect(switchTarget(session({}, { status: "PAYING", payClickedAt: new Date() }), {}, new Error("x"))).toBeNull();
    } finally {
      for (const k of Object.keys(env)) delete process.env[k];
    }
  });

  it("inFlightAttempt carries the processor of the attempt", () => {
    const now = Date.now();
    expect(inFlightAttempt({ status: "PAYING", payClickedAt: new Date(now - 1000), paypalWindowAt: null, paypalBeatAt: null, paymentProvider: "stripe" }, now)).toEqual({ method: "other", provider: "stripe" });
    expect(inFlightAttempt({ status: "OPEN", payClickedAt: null, paypalWindowAt: null, paypalBeatAt: null, paymentProvider: "stripe" }, now)).toBeNull();
  });

  it("chooseProvider integration: failover and primary unavailable", () => {
    expect(chooseProvider({ ...base, providerFailoverAt: new Date() }, { env })?.provider).toBe("stripe");
    expect(chooseProvider({ ...base, whopConnectedAt: null }, { env })).toEqual({ provider: "stripe", reason: "primary_unavailable" });
    expect(chooseProvider(base, { env, forced: "stripe" })).toEqual({ provider: "stripe", reason: "forced" });
  });
});

describe("failover helpers", () => {
  it("reads the processor of a journaled failure (older rows: Whop) and the active processor", () => {
    expect(failureSourceOf(null)).toBe("whop");
    expect(failureSourceOf({ source: "whop" })).toBe("whop");
    expect(failureSourceOf({ source: "stripe" })).toBe("stripe");
    expect(activeProvider({ paymentMode: "whop_primary", providerFailoverAt: null })).toBe("whop");
    expect(activeProvider({ paymentMode: "whop_primary", providerFailoverAt: new Date() })).toBe("stripe");
    expect(activeProvider({ paymentMode: "stripe_primary", providerFailoverAt: new Date() })).toBe("whop");
    expect(activeProvider({ paymentMode: "stripe_only", providerFailoverAt: new Date() })).toBe("stripe");
  });
});

describe("PaymentIntent helpers", () => {
  it("statement suffix from the store name", () => {
    expect(stripeDescriptorSuffix("Ma Boutique Élégante & Co")).toBe("MA BOUTIQUE");
    expect(stripeDescriptorSuffix("1234")).toBeNull();
    expect(stripeDescriptorSuffix(null)).toBeNull();
  });
  it("matches amount (Stripe's unit), currency and snapshot", () => {
    const target = { fingerprint: "f1", amountCents: 1234, currency: "EUR" };
    const pi = { amount: 1234, currency: "eur", metadata: { fingerprint: fingerprintTag("f1") } };
    expect(paymentIntentMatches(pi, target)).toBe(true);
    expect(paymentIntentMatches({ ...pi, amount: 1235 }, target)).toBe(false);
    expect(paymentIntentMatches(pi, { ...target, fingerprint: "f2" })).toBe(false);
    // Zero-decimal currency: 1 000 JPY = 100 000 app cents.
    expect(paymentIntentMatches({ amount: 1000, currency: "jpy", metadata: { fingerprint: fingerprintTag("f") } }, { fingerprint: "f", amountCents: 100_000, currency: "JPY" })).toBe(true);
  });
  it("shipping only with a name and a first line", () => {
    expect(stripeShipping({ firstName: "A", lastName: "B", address1: "1 rue", city: "Paris", zip: "75001", countryCode: "FR" })).toMatchObject({ name: "A B", address: { line1: "1 rue", postal_code: "75001", country: "FR" } });
    expect(stripeShipping({ firstName: "", lastName: "", address1: "1 rue" })).toBeNull();
    expect(stripeShipping(null)).toBeNull();
  });
});

describe("theme → Stripe Appearance", () => {
  it("maps colors, radius, font and size; a pale brand color falls back to the text color", () => {
    const theme = loadTheme({ accentColor: "#0a7d38", textColor: "#1f2937", radius: 14, font: "Inter", fontScale: "lg" }, "S");
    const a = stripeAppearance(theme);
    expect(a.variables).toMatchObject({ colorPrimary: "#0a7d38", colorText: "#1f2937", borderRadius: "14px", fontSizeBase: "16px", colorBackground: "#ffffff" });
    expect(a.variables?.fontFamily).toContain("Inter");
    const pale = stripeAppearance(loadTheme({ accentColor: "#fde68a", textColor: "#111827" }, "S"));
    expect(pale.variables?.colorPrimary).toBe("#111827");
  });
  it("keeps text, secondary text and errors readable (AA) and field borders at 3:1", () => {
    const a = stripeAppearance(loadTheme({ textColor: "#374151", borderColor: "#f4f4f5" }, "S"));
    const v = a.variables!;
    expect(contrastRatio(v.colorText!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v.colorTextSecondary!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(v.colorDanger!, "#ffffff")).toBeGreaterThanOrEqual(4.5);
    const border = /1px solid (#[0-9a-f]{6})/i.exec(String(a.rules?.[".Input"]?.border))![1];
    expect(contrastRatio(border, "#ffffff")).toBeGreaterThanOrEqual(3);
  });
});

describe("express wallets on Stripe", () => {
  it("honours the merchant's toggles; Google Pay 'auto' is allowed (Stripe collects the address)", () => {
    expect(stripeExpressPaymentMethods({})).toEqual({ applePay: "always", googlePay: "always", link: "auto", paypal: "auto", amazonPay: "never", klarna: "never" });
    expect(stripeExpressPaymentMethods({ applePay: false, googlePay: "off", whopPay: false, paypal: false })).toMatchObject({ applePay: "never", googlePay: "never", link: "never", paypal: "never" });
    expect(stripeExpressAny({ applePay: false, googlePay: "off", whopPay: false, paypal: false })).toBe(false);
    expect(stripeExpressAny({ applePay: false, googlePay: "auto", whopPay: false, paypal: false })).toBe(true);
  });
  it("reads the wallet's buyer in the form's shape", () => {
    const addr = { line1: "2 av", line2: null, city: "Lyon", state: "", postal_code: "69001", country: "fr" };
    expect(walletBuyer({ billingDetails: { name: "Jo", email: "jo@x.fr", address: addr }, shippingAddress: { name: "Jean Paul Dupont", address: addr } })).toEqual({
      email: "jo@x.fr",
      address: { firstName: "Jean", lastName: "Paul Dupont", address1: "2 av", address2: "", city: "Lyon", province: "", zip: "69001", countryCode: "FR", phone: "" },
    });
    expect(walletBuyer({ billingDetails: { name: "Solo", email: "s@x.fr", address: addr } })?.address).toMatchObject({ firstName: "Solo", lastName: "Solo" });
    expect(walletBuyer({ billingDetails: { name: "No mail", address: addr } })).toBeNull();
  });
  it("errors: Stripe's own message for card / form problems, ours otherwise", () => {
    const labels = { paymentFailed: "failed", paymentRedirectFailed: "bank" };
    expect(stripeErrorText({ type: "card_error", message: "Votre carte a été refusée.", code: "card_declined" }, labels)).toBe("Votre carte a été refusée.");
    expect(stripeErrorText({ type: "api_connection_error", message: "Network", code: undefined }, labels)).toBe("failed");
    expect(stripeErrorText({ type: "invalid_request_error", message: "x", code: "payment_intent_authentication_failure" }, labels)).toBe("bank");
    expect(stripeErrorText(null, labels)).toBe("failed");
  });
});

describe("prepare answers on the page", () => {
  it("reads Whop's configuration and Stripe's PaymentIntent", () => {
    expect(preparedFromBody({ checkoutConfigurationId: "ch_1", environment: "production" })).toEqual({ provider: "whop", configId: "ch_1", environment: "production" });
    const s = preparedFromBody({ provider: "stripe", checkoutConfigurationId: null, clientSecret: "pi_1_secret", paymentIntentId: "pi_1", publishableKey: "pk", stripeAccount: "acct", environment: "sandbox", totals: { totalCents: 3000 } });
    expect(s).toEqual({ provider: "stripe", configId: "pi_1", environment: "sandbox", stripe: { clientSecret: "pi_1_secret", paymentIntentId: "pi_1", publishableKey: "pk", stripeAccount: "acct" }, amountKey: "3000" });
    expect(preparedFromBody({ provider: "stripe" })).toBeNull();
    // Same PaymentIntent at a new total: another Prepared (the form fetches the amount).
    expect(samePrepared(s, { ...s!, amountKey: "6000" })).toBe(false);
    expect(samePrepared(s, { ...s! })).toBe(true);
    expect(samePrepared(s, { configId: "pi_1", environment: "sandbox" })).toBe(false);
  });

  it("keys the wallets' amount on the PaymentIntent's own amount and currency when the server gives them", () => {
    const body = { provider: "stripe", clientSecret: "pi_1_secret", paymentIntentId: "pi_1", publishableKey: "pk", stripeAccount: "acct", environment: "sandbox", totals: { totalCents: 3000 } };
    expect(preparedFromBody({ ...body, amount: 3500, currency: "USD" })?.amountKey).toBe("3500:usd");
    // Same page total, other charged amount (buyer's currency): a new key, the wallets refetch.
    expect(preparedFromBody({ ...body, amount: 3600, currency: "usd" })?.amountKey).not.toBe(preparedFromBody({ ...body, amount: 3500, currency: "usd" })?.amountKey);
  });
});

describe("failover counting", () => {
  it("effective provider: Stripe when Whop is disconnected under « Whop principal »", () => {
    const base = { paymentMode: "whop_primary" as const, providerFailoverAt: null, testMode: true, whopConnectedAt: null, stripeAccountId: "acct_1", stripeConnectedAt: new Date(), stripeLivemode: false, stripeChargesEnabled: true };
    const prev = { ...process.env };
    Object.assign(process.env, env);
    try {
      expect(effectiveProvider(base)).toBe("stripe");
      expect(effectiveProvider({ ...base, whopConnectedAt: new Date() })).toBe("whop");
      expect(effectiveProvider({ ...base, whopConnectedAt: new Date(), providerFailoverAt: new Date() })).toBe("stripe");
    } finally {
      for (const k of Object.keys(env)) if (!(k in prev)) delete process.env[k];
    }
  });

  it("rows that never count: forced sessions and processor refusals", () => {
    expect(uncountedFailure({ source: "stripe", forced: true })).toBe(true);
    expect(uncountedFailure({ source: "stripe", rejected: true })).toBe(true);
    expect(uncountedFailure({ source: "stripe" })).toBe(false);
    expect(uncountedFailure(null)).toBe(false);
  });

  it("Stripe refusals: 4xx other than 401 / 403 / 429", () => {
    expect(isStripeRejection({ statusCode: 400, type: "StripeInvalidRequestError", code: "amount_too_small" })).toBe(true);
    expect(isStripeRejection({ statusCode: 400, type: "StripeIdempotencyError" })).toBe(true);
    expect(isStripeRejection({ statusCode: 402, type: "StripeCardError" })).toBe(true);
    expect(isStripeRejection({ statusCode: 429 })).toBe(false);
    expect(isStripeRejection({ statusCode: 401 })).toBe(false);
    expect(isStripeRejection({ statusCode: 403 })).toBe(false);
    expect(isStripeRejection({ statusCode: 500 })).toBe(false);
    expect(isStripeRejection(new Error("fetch failed"))).toBe(false);
  });
});

describe("thank-you page URL", () => {
  it("drops Stripe's return parameters (client secret included), keeps the others", () => {
    expect(cleanThankYouUrl("s1", { payment_intent: "pi_1", payment_intent_client_secret: "pi_1_secret_x", redirect_status: "succeeded", lang: "en", via: "app" })).toBe("/c/s1/merci?lang=en&via=app");
    expect(cleanThankYouUrl("s1", { redirect_status: "succeeded" })).toBe("/c/s1/merci");
    expect(cleanThankYouUrl("s1", { lang: "en" })).toBeNull();
  });

  it("back from a Stripe redirect that didn't pay: to the checkout with payment=failed (any status but succeeded / processing)", () => {
    for (const status of ["failed", "requires_payment_method", "canceled", ["failed", "x"]]) {
      expect(failedReturnUrl("s1", { redirect_status: status }, "PAYING")).toBe("/c/s1?payment=failed");
    }
    expect(failedReturnUrl("s1", { redirect_status: "failed", via: "app" }, "FAILED")).toBe("/c/s1?payment=failed&via=app");
    expect(failedReturnUrl("s1", { redirect_status: "succeeded" }, "PAYING")).toBeNull();
    expect(failedReturnUrl("s1", { redirect_status: "processing" }, "PAYING")).toBeNull();
    expect(failedReturnUrl("s1", {}, "FAILED")).toBeNull();
    // Paid meanwhile: always the thank-you page.
    expect(failedReturnUrl("s1", { redirect_status: "failed" }, "PAID")).toBeNull();
  });
});

describe("review fixes: helpers", () => {
  it("isStripeMissing: 404 / resource_missing, optionally on one parameter", () => {
    expect(isStripeMissing({ statusCode: 404 })).toBe(true);
    expect(isStripeMissing({ statusCode: 400, code: "resource_missing", param: "customer" })).toBe(true);
    expect(isStripeMissing({ statusCode: 400, code: "resource_missing", param: "customer" }, "customer")).toBe(true);
    expect(isStripeMissing({ statusCode: 400, code: "resource_missing", raw: { param: "customer" } }, "customer")).toBe(true);
    expect(isStripeMissing({ statusCode: 400, code: "resource_missing", param: "payment_method" }, "customer")).toBe(false);
    expect(isStripeMissing({ statusCode: 500 })).toBe(false);
    expect(isStripeMissing(new Error("fetch failed"))).toBe(false);
  });

  it("a deleted Whop configuration's fingerprint never matches a quote's, keeps its PayPal segment", () => {
    const fp = `abc|m:paypal${DELETED_SUFFIX}`;
    expect(isDeletedFingerprint(fp)).toBe(true);
    expect(isPaypalFingerprint(fp)).toBe(true);
    expect(isDeletedFingerprint("abc|m:paypal")).toBe(false);
    expect(isDeletedFingerprint(null)).toBe(false);
  });

  it("tagFailureSource with an exception: database errors are never tagged as the processor's", async () => {
    const dbErr = new Prisma.PrismaClientKnownRequestError("timeout", { code: "P1008", clientVersion: "test" });
    const err = await tagFailureSource(Promise.reject(dbErr), "stripe", isDbError).catch((e: unknown) => e);
    expect(checkoutFailureSource(err)).not.toBe("stripe");
    expect(isDbError(new Prisma.PrismaClientUnknownRequestError("x", { clientVersion: "test" }))).toBe(true);
    expect(isDbError(Object.assign(new Error("Stripe 500"), { type: "StripeAPIError" }))).toBe(false);
    const stripeErr = await tagFailureSource(Promise.reject(new Error("Stripe 500")), "stripe", isDbError).catch((e: unknown) => e);
    expect(checkoutFailureSource(stripeErr)).toBe("stripe");
  });
});
