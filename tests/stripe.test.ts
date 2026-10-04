import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { anyProviderConnected, chooseProvider, paymentModeProblem, providerConnected, providerOrder, stripeUnusableReason, type ProviderStore } from "@/lib/payment-provider";
import { missingStripeEnv, stripeConfigured, stripeEnv } from "@/lib/stripe-config";
import { peekStripeStateStore, sameOrigin, signStripeState, stripeNonceCookie, STRIPE_STATE_TTL_MS, verifyStripeState } from "@/lib/stripe-state";
import { consentAllows } from "@/lib/conversions";
import { disconnectBlockMessage, parsePastAccounts, sessionStripeAccount, stripeConnectionMode } from "@/lib/stripe-connection";
import { centsToStripeAmount, oauthAuthorizeUrl, paymentInfoFromStripe, STRIPE_EMAIL_SETTINGS_URL, stripeAmountToCents, stripeFeeCents, stripeMethodType } from "@/lib/stripe";
import { readFileSync } from "node:fs";
import { hostDecision } from "@/lib/host-guard";

const LIVE = { STRIPE_SECRET_KEY: "sk_live_x", STRIPE_PUBLISHABLE_KEY: "pk_live_x", STRIPE_CLIENT_ID: "ca_live" };
const TEST = { STRIPE_TEST_SECRET_KEY: "sk_test_x", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_x", STRIPE_TEST_CLIENT_ID: "ca_test" };
const BOTH = { ...LIVE, ...TEST };

function store(over: Partial<ProviderStore> = {}): ProviderStore {
  return {
    paymentMode: "whop_primary",
    providerFailoverAt: null,
    testMode: false,
    whopConnectedAt: new Date(),
    stripeAccountId: "acct_1",
    stripeConnectedAt: new Date(),
    stripeLivemode: true,
    ...over,
  };
}

describe("stripe config", () => {
  it("needs the three keys of the mode", () => {
    expect(stripeConfigured("live", LIVE)).toBe(true);
    expect(stripeConfigured("test", LIVE)).toBe(false);
    expect(stripeConfigured("live", { ...LIVE, STRIPE_CLIENT_ID: " " })).toBe(false);
    expect(missingStripeEnv("test", { STRIPE_TEST_SECRET_KEY: "sk" })).toEqual(["STRIPE_TEST_PUBLISHABLE_KEY", "STRIPE_TEST_CLIENT_ID"]);
    expect(stripeEnv("live", { ...LIVE, STRIPE_WEBHOOK_SECRET: "whsec_1" })?.webhookSecret).toBe("whsec_1");
  });
});

describe("providerConnected", () => {
  it("Whop: connected; Stripe: account + keys of the store's mode + a connection covering that mode", () => {
    expect(providerConnected(store(), "whop", BOTH)).toBe(true);
    expect(providerConnected(store({ whopConnectedAt: null }), "whop", BOTH)).toBe(false);
    expect(providerConnected(store(), "stripe", BOTH)).toBe(true);
    expect(providerConnected(store(), "stripe", TEST)).toBe(false); // live store, live keys missing
    expect(providerConnected(store({ stripeAccountId: null }), "stripe", BOTH)).toBe(false);
    expect(providerConnected(store({ stripeConnectedAt: null }), "stripe", BOTH)).toBe(false);
    // A test-mode connection can't charge live; a live connection covers test mode.
    expect(providerConnected(store({ stripeLivemode: false }), "stripe", BOTH)).toBe(false);
    expect(providerConnected(store({ stripeLivemode: false, testMode: true }), "stripe", BOTH)).toBe(true);
    expect(providerConnected(store({ testMode: true }), "stripe", BOTH)).toBe(true);
    expect(providerConnected(store({ testMode: true }), "stripe", LIVE)).toBe(false);
  });
});

describe("chooseProvider", () => {
  it("whop_primary: Whop, Stripe on store failover or when Whop isn't connected", () => {
    expect(chooseProvider(store(), { env: BOTH })).toEqual({ provider: "whop", reason: "primary" });
    expect(chooseProvider(store({ providerFailoverAt: new Date() }), { env: BOTH })).toEqual({ provider: "stripe", reason: "failover" });
    expect(chooseProvider(store({ whopConnectedAt: null }), { env: BOTH })).toEqual({ provider: "stripe", reason: "primary_unavailable" });
    // Failover without Stripe usable: Whop stays (the Shopify fallback is fallback.ts's business).
    expect(chooseProvider(store({ providerFailoverAt: new Date(), stripeAccountId: null }), { env: BOTH })).toEqual({ provider: "whop", reason: "primary" });
    expect(chooseProvider(store({ whopConnectedAt: null, stripeAccountId: null }), { env: BOTH })).toBeNull();
  });

  it("stripe_primary is symmetric, Whop as secours", () => {
    const s = { paymentMode: "stripe_primary" as const };
    expect(chooseProvider(store(s), { env: BOTH })).toEqual({ provider: "stripe", reason: "primary" });
    expect(chooseProvider(store({ ...s, providerFailoverAt: new Date() }), { env: BOTH })).toEqual({ provider: "whop", reason: "failover" });
    expect(chooseProvider(store(s), { env: {} })).toEqual({ provider: "whop", reason: "primary_unavailable" });
    expect(chooseProvider(store({ ...s, providerFailoverAt: new Date(), whopConnectedAt: null }), { env: BOTH })).toEqual({ provider: "stripe", reason: "primary" });
  });

  it("stripe_only never uses Whop", () => {
    const s = { paymentMode: "stripe_only" as const };
    expect(providerOrder("stripe_only")).toEqual(["stripe"]);
    expect(chooseProvider(store(s), { env: BOTH })).toEqual({ provider: "stripe", reason: "primary" });
    expect(chooseProvider(store({ ...s, providerFailoverAt: new Date() }), { env: BOTH })).toEqual({ provider: "stripe", reason: "primary" });
    expect(chooseProvider(store({ ...s, stripeAccountId: null }), { env: BOTH })).toBeNull();
    expect(chooseProvider(store(s), { forced: "whop", env: BOTH })).toBeNull();
    expect(anyProviderConnected(store({ ...s, stripeAccountId: null }), BOTH)).toBe(false);
  });

  it("forced: honoured when connected, never silently replaced", () => {
    expect(chooseProvider(store(), { forced: "stripe", env: BOTH })).toEqual({ provider: "stripe", reason: "forced" });
    expect(chooseProvider(store({ stripeAccountId: null }), { forced: "stripe", env: BOTH })).toBeNull();
    expect(chooseProvider(store({ paymentMode: "stripe_primary" }), { forced: "whop", env: BOTH })).toEqual({ provider: "whop", reason: "forced" });
  });
});

describe("paymentModeProblem", () => {
  it("Stripe-first and Stripe-only need Stripe usable", () => {
    expect(paymentModeProblem(store({ stripeAccountId: null }), "whop_primary", BOTH)).toBeNull();
    expect(paymentModeProblem(store({ stripeAccountId: null }), "stripe_only", BOTH)).toMatch(/Connectez d'abord Stripe/);
    expect(paymentModeProblem(store({ stripeAccountId: null }), "stripe_primary", BOTH)).toMatch(/Connectez d'abord Stripe/);
    expect(paymentModeProblem(store(), "stripe_only", BOTH)).toBeNull();
    expect(paymentModeProblem(store(), "stripe_only", TEST)).not.toBeNull();
  });
});

describe("charges enabled (Store.stripeChargesEnabled)", () => {
  it("false makes Stripe unusable (unknown / left out counts as usable) and blocks the Stripe modes", () => {
    expect(providerConnected(store({ stripeChargesEnabled: false }), "stripe", BOTH)).toBe(false);
    expect(providerConnected(store({ stripeChargesEnabled: null }), "stripe", BOTH)).toBe(true);
    expect(providerConnected(store({ stripeChargesEnabled: true }), "stripe", BOTH)).toBe(true);
    expect(chooseProvider(store({ stripeChargesEnabled: false, whopConnectedAt: null }), { env: BOTH })).toBeNull();
    expect(chooseProvider(store({ stripeChargesEnabled: false, providerFailoverAt: new Date() }), { env: BOTH })).toEqual({ provider: "whop", reason: "primary" });
    expect(paymentModeProblem(store({ stripeChargesEnabled: false }), "stripe_primary", BOTH)).toMatch(/ne peut pas encore encaisser/);
    expect(paymentModeProblem(store({ stripeChargesEnabled: false }), "stripe_only", BOTH)).toMatch(/ne peut pas encore encaisser/);
    expect(paymentModeProblem(store({ stripeChargesEnabled: false }), "whop_primary", BOTH)).toBeNull();
  });

  it("stripeUnusableReason names what to do", () => {
    expect(stripeUnusableReason(store(), BOTH)).toBeNull();
    expect(stripeUnusableReason(store({ stripeAccountId: null }), BOTH)).toBeNull();
    expect(stripeUnusableReason(store(), TEST)).toMatch(/clés Stripe/);
    expect(stripeUnusableReason(store({ stripeLivemode: false }), BOTH)).toMatch(/mode test/);
    expect(stripeUnusableReason(store({ stripeChargesEnabled: false }), BOTH)).toMatch(/Paiements pas encore activés/);
  });
});

describe("forced sessions (« Tester le secours »)", () => {
  it("never reach the ad platforms, even in live mode", () => {
    const base = { tracking: {}, test: false, forcedProvider: null, store: { pixelRequireConsent: false, metaTestEventCode: "TEST1" } };
    expect(consentAllows(base as never)).toBe(true);
    expect(consentAllows({ ...base, forcedProvider: "stripe" } as never)).toBe(false);
  });
});

describe("connection helpers", () => {
  it("session account, connection mode, past accounts, disconnect refusal", () => {
    expect(sessionStripeAccount({ stripeAccountId: "acct_old" }, { stripeAccountId: "acct_new" })).toBe("acct_old");
    expect(sessionStripeAccount({ stripeAccountId: null }, { stripeAccountId: "acct_new" })).toBe("acct_new");
    expect(sessionStripeAccount({}, { stripeAccountId: null })).toBeNull();
    // Deauthorize with the keys of the mode the account was connected in (when set).
    expect(stripeConnectionMode({ testMode: true, stripeLivemode: true }, BOTH)).toBe("live");
    expect(stripeConnectionMode({ testMode: false, stripeLivemode: false }, BOTH)).toBe("test");
    expect(stripeConnectionMode({ testMode: true, stripeLivemode: true }, TEST)).toBe("test");
    expect(stripeConnectionMode({ testMode: false, stripeLivemode: null }, BOTH)).toBe("live");
    const now = Date.now();
    const value = JSON.stringify([
      { id: "acct_a", until: new Date(now + 1000).toISOString(), revoked: false },
      { id: "acct_b", until: new Date(now - 1000).toISOString(), revoked: true },
      { nope: 1 },
    ]);
    expect(parsePastAccounts(value, now).map((a) => a.id)).toEqual(["acct_a"]);
    expect(parsePastAccounts("not json")).toEqual([]);
    expect(disconnectBlockMessage({ paying: 0, unsynced: 0 })).toBeNull();
    expect(disconnectBlockMessage({ paying: 2, unsynced: 1 })).toMatch(/2 paiements Stripe en cours et 1 paiement Stripe des 30 dernières minutes sans commande Shopify.*Déconnecter quand même/);
  });
});

describe("OAuth round trip helpers", () => {
  it("one nonce cookie per store; the state's store is peeked without trust; Origin parsing never throws", () => {
    expect(stripeNonceCookie("st_1")).toBe("wc_stripe_oauth_st_1");
    expect(stripeNonceCookie("st_1")).not.toBe(stripeNonceCookie("st_2"));
    const state = signStripeState({ storeId: "cmabc123", mode: "test", nonce: "n" });
    expect(peekStripeStateStore(state)).toBe("cmabc123");
    expect(peekStripeStateStore("garbage")).toBeNull();
    expect(peekStripeStateStore(`${Buffer.from(JSON.stringify({ s: "a;b=c" })).toString("base64url")}.x`)).toBeNull();
    const app = "https://checkout.example.com";
    expect(sameOrigin(null, app)).toBe(true);
    expect(sameOrigin("https://checkout.example.com", app)).toBe(true);
    expect(sameOrigin("https://evil.example", app)).toBe(false);
    expect(sameOrigin("null", app)).toBe(false);
    expect(sameOrigin("::::", app)).toBe(false);
  });
});

describe("OAuth state", () => {
  const KEY = "k".repeat(32);
  it("round-trips with the browser's nonce, before expiry", () => {
    const now = 1_700_000_000_000;
    const state = signStripeState({ storeId: "st_1", mode: "test", nonce: "n1" }, now, KEY);
    expect(verifyStripeState(state, "n1", now + 1000, KEY)).toEqual({ storeId: "st_1", mode: "test" });
    expect(verifyStripeState(state, "n2", now + 1000, KEY)).toBeNull(); // another browser
    expect(verifyStripeState(state, null, now + 1000, KEY)).toBeNull();
    expect(verifyStripeState(state, "n1", now + STRIPE_STATE_TTL_MS + 1, KEY)).toBeNull(); // expired
    expect(verifyStripeState(state, "n1", now, "z".repeat(32))).toBeNull(); // other key
  });

  it("rejects a tampered payload or signature", () => {
    const now = Date.now();
    const state = signStripeState({ storeId: "st_1", mode: "live", nonce: "n1" }, now, KEY);
    const [payload, sig] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), s: "st_2" })).toString("base64url");
    expect(verifyStripeState(`${forged}.${sig}`, "n1", now, KEY)).toBeNull();
    expect(verifyStripeState(`${payload}.${sig.slice(0, -2)}xx`, "n1", now, KEY)).toBeNull();
    expect(verifyStripeState(`${state}.extra`, "n1", now, KEY)).toBeNull();
    expect(verifyStripeState("garbage", "n1", now, KEY)).toBeNull();
  });

  it("defaults to ENCRYPTION_KEY", () => {
    const state = signStripeState({ storeId: "st_9", mode: "live", nonce: "abc" });
    expect(verifyStripeState(state, "abc")).toEqual({ storeId: "st_9", mode: "live" });
  });
});

describe("oauthAuthorizeUrl", () => {
  it("Standard accounts, read_write, callback on APP_URL, client id of the store's mode", () => {
    const prev = { ...process.env };
    Object.assign(process.env, BOTH);
    try {
      const url = new URL(oauthAuthorizeUrl({ name: "Maison", testMode: true }, "st.sig"));
      expect(url.origin + url.pathname).toBe("https://connect.stripe.com/oauth/authorize");
      expect(url.searchParams.get("client_id")).toBe("ca_test");
      expect(url.searchParams.get("scope")).toBe("read_write");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("redirect_uri")).toBe("https://checkout.example.com/api/stripe/connect/callback");
      expect(url.searchParams.get("state")).toBe("st.sig");
      expect(url.searchParams.get("suggested_capabilities[]")).toBeNull();
      expect(new URL(oauthAuthorizeUrl({ name: "Maison", testMode: false }, "s")).searchParams.get("client_id")).toBe("ca_live");
    } finally {
      for (const k of Object.keys(BOTH)) if (!(k in prev)) delete process.env[k];
    }
  });
});

describe("amounts", () => {
  it("converts Stripe's smallest units to the app's cents and back", () => {
    expect(stripeAmountToCents(1234, "eur")).toBe(1234);
    expect(stripeAmountToCents(500, "JPY")).toBe(50000);
    expect(stripeAmountToCents(12345, "kwd")).toBe(1235);
    expect(stripeAmountToCents(null, "eur")).toBeNull();
    expect(centsToStripeAmount(50000, "jpy")).toBe(500);
    expect(centsToStripeAmount(1234, "EUR")).toBe(1234);
  });
});

describe("paymentInfoFromStripe", () => {
  const bt = { id: "txn_1", object: "balance_transaction", fee: 57, currency: "eur", exchange_rate: null } as unknown as Stripe.BalanceTransaction;
  const charge = {
    id: "ch_1",
    object: "charge",
    amount: 4990,
    currency: "eur",
    balance_transaction: bt,
    payment_method: "pm_1",
    payment_method_details: { type: "card", card: { wallet: { type: "apple_pay" } } },
    billing_details: { email: "bill@example.com", name: "Jeanne Martin", phone: "+33600000000", address: { line1: "2 rue B", line2: null, city: "Lyon", state: null, postal_code: "69001", country: "FR" } },
    receipt_email: null,
    shipping: null,
  } as unknown as Stripe.Charge;
  const pi = {
    id: "pi_1",
    object: "payment_intent",
    amount: 4990,
    amount_received: 4990,
    currency: "eur",
    customer: "cus_1",
    payment_method: "pm_1",
    receipt_email: null,
    shipping: { name: "Jean Dupont", phone: "+33611111111", address: { line1: "1 rue A", line2: "Bât C", city: "Paris", state: null, postal_code: "75001", country: "FR" } },
    latest_charge: charge,
  } as unknown as Stripe.PaymentIntent;

  it("normalizes amount, currency, method, fee, buyer and Stripe ids", () => {
    const info = paymentInfoFromStripe(pi);
    expect(info).toMatchObject({
      id: "pi_1",
      provider: "stripe",
      totalCents: 4990,
      currency: "EUR",
      paymentMethodType: "apple_pay",
      feeCents: 57,
      memberId: null,
      paymentMethodId: null,
      stripeCustomerId: "cus_1",
      stripePaymentMethodId: "pm_1",
    });
    expect(info.buyer?.email).toBe("bill@example.com");
    expect(info.buyer?.shippingAddress).toEqual({ name: "Jean Dupont", line1: "1 rue A", line2: "Bât C", city: "Paris", state: null, postal_code: "75001", country: "FR" });
    expect(info.buyer?.address?.line1).toBe("1 rue A");
    expect(info.buyer?.phone).toBe("+33611111111");
  });

  it("falls back to the billing address, and to the PI amount without a charge", () => {
    const noShip = { ...pi, shipping: null, receipt_email: "pi@example.com", latest_charge: "ch_1" } as unknown as Stripe.PaymentIntent;
    const bare = paymentInfoFromStripe(noShip);
    expect(bare.totalCents).toBe(4990);
    expect(bare.feeCents).toBeNull();
    expect(bare.paymentMethodType).toBeNull();
    expect(bare.buyer?.email).toBe("pi@example.com");
    expect(bare.buyer?.address).toBeNull();
    const withCharge = paymentInfoFromStripe(noShip, charge);
    expect(withCharge.buyer?.shippingAddress).toBeNull();
    expect(withCharge.buyer?.address).toMatchObject({ name: "Jeanne Martin", line1: "2 rue B", city: "Lyon", country: "FR" });
    expect(withCharge.buyer?.phone).toBe("+33600000000");
  });

  it("recovers the buyer's e-mail without receipt_email (no longer sent): from the charge's billing details", () => {
    const noReceipt = { ...pi, receipt_email: null } as unknown as Stripe.PaymentIntent;
    expect(paymentInfoFromStripe(noReceipt, charge).buyer?.email).toBe(charge.billing_details?.email);
    expect(charge.billing_details?.email).toBeTruthy();
  });

  it("fee in another settlement currency is converted back with Stripe's rate", () => {
    const usd = { ...charge, currency: "usd", amount: 10000, balance_transaction: { ...bt, currency: "eur", fee: 180, exchange_rate: 0.9 } } as unknown as Stripe.Charge;
    expect(stripeFeeCents(usd)).toBe(200);
    expect(stripeFeeCents({ ...usd, balance_transaction: "txn_1" } as Stripe.Charge)).toBeNull();
  });

  it("method types", () => {
    expect(stripeMethodType({ payment_method_details: { type: "card", card: {} } } as unknown as Stripe.Charge)).toBe("card");
    expect(stripeMethodType({ payment_method_details: { type: "paypal" } } as unknown as Stripe.Charge)).toBe("paypal");
    expect(stripeMethodType({ payment_method_details: { type: "card", card: { wallet: { type: "google_pay" } } } } as unknown as Stripe.Charge)).toBe("google_pay");
    expect(stripeMethodType(null)).toBeNull();
  });
});

describe("host guard", () => {
  it("serves the Stripe connect and webhook routes on the app host only", () => {
    const appUrl = "https://checkout.example.com";
    for (const pathname of ["/api/stripe/connect/start", "/api/stripe/connect/callback", "/api/webhooks/stripe"]) {
      expect(hostDecision({ host: "checkout.example.com", pathname, search: "", appUrl })).toEqual({ action: "next" });
      expect(hostDecision({ host: "pay.seyuna.com", pathname, search: "?code=x", appUrl })).toEqual({ action: "redirect", location: `${appUrl}${pathname}?code=x` });
    }
  });
});

describe("Stripe's own receipts (double e-mail)", () => {
  it("the Stripe page has a « Reçus Stripe » card: Paramètres → E-mails clients → Paiements réussis, with the link", () => {
    expect(STRIPE_EMAIL_SETTINGS_URL).toBe("https://dashboard.stripe.com/settings/emails");
    const page = readFileSync("src/app/dashboard/stores/[storeId]/(main)/stripe/page.tsx", "utf8");
    expect(page).toContain('title="Reçus Stripe"');
    expect(page).toMatch(/Paramètres → E-mails clients → <strong>Paiements réussis<\/strong>/);
    expect(page).toContain("href={STRIPE_EMAIL_SETTINGS_URL}");
    // The code never claims Stripe sends nothing: the account's setting is the merchant's.
    const stripeSrc = readFileSync("src/lib/stripe.ts", "utf8");
    expect(stripeSrc).not.toMatch(/Stripe's own receipt would be a second/);
    expect(stripeSrc).toContain("Paiements réussis");
  });
});
