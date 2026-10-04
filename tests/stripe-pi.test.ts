import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The checkout's Stripe calls with the Stripe SDK mocked: one Customer per session (idempotent on the
 * session id, never found by e-mail), the PaymentIntent's metadata (app_host), its idempotency key
 * covering the wording, a replaced PaymentIntent canceled while nothing was submitted on it, and the
 * best-effort cancel of a session's open PaymentIntents.
 */

const api = vi.hoisted(() => ({
  paymentIntents: { retrieve: vi.fn(), create: vi.fn(), update: vi.fn(), cancel: vi.fn() },
  customers: { create: vi.fn(), update: vi.fn(), list: vi.fn() },
}));

vi.mock("stripe", () => {
  class FakeStripe {
    static createFetchHttpClient = () => ({});
    static API_VERSION = "2099-01-01";
    paymentIntents = api.paymentIntents;
    customers = api.customers;
  }
  return { default: FakeStripe };
});

const ENV = { STRIPE_TEST_SECRET_KEY: "sk_test_pi", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_pi", STRIPE_TEST_CLIENT_ID: "ca_test_pi" };
const { createOrUpdatePaymentIntent, ensureStripeCustomer, cancelOpenPaymentIntents, stripeAppHost } = await import("@/lib/stripe");

const store = { id: "st_1", testMode: true, stripeAccountId: "acct_pi", name: "Ma Boutique" };
const session = { id: "cs_1", storeId: "st_1" };
const target = { fingerprint: "fp1|p:stripe", amountCents: 3000, currency: "EUR" };
const pi = (over: Record<string, unknown> = {}) => ({ id: "pi_new", client_secret: "pi_new_secret", status: "requires_payment_method", customer: null, amount: 3000, currency: "eur", metadata: {}, setup_future_usage: null, ...over });

beforeAll(() => Object.assign(process.env, ENV));
afterAll(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
});
beforeEach(() => {
  vi.clearAllMocks();
  api.paymentIntents.create.mockImplementation(async (params: { amount: number; currency: string; metadata: Record<string, string>; setup_future_usage?: string }) =>
    pi({ amount: params.amount, currency: params.currency, metadata: params.metadata, setup_future_usage: params.setup_future_usage ?? null }),
  );
  api.paymentIntents.cancel.mockResolvedValue({});
  api.customers.create.mockResolvedValue({ id: "cus_1" });
  api.customers.update.mockResolvedValue({ id: "cus_1" });
});

describe("ensureStripeCustomer", () => {
  it("creates one Customer per session (idempotency key = session id, metadata), never looked up by e-mail", async () => {
    expect(await ensureStripeCustomer(store, { email: "A@B.co", name: "A B", sessionId: "cs_1" })).toBe("cus_1");
    expect(api.customers.list).not.toHaveBeenCalled();
    const [params, opts] = api.customers.create.mock.calls[0];
    expect(params).toMatchObject({ email: "a@b.co", name: "A B", metadata: { checkout_session_id: "cs_1" } });
    expect(opts).toMatchObject({ stripeAccount: "acct_pi", idempotencyKey: "wc_cus_cs_1" });
  });

  it("the session's Customer is kept; its e-mail updated only when the buyer changed it", async () => {
    expect(await ensureStripeCustomer(store, { email: "a@b.co", sessionId: "cs_1", customerId: "cus_9", previousEmail: "a@b.co" })).toBe("cus_9");
    expect(api.customers.update).not.toHaveBeenCalled();
    await ensureStripeCustomer(store, { email: "c@d.co", sessionId: "cs_1", customerId: "cus_9", previousEmail: "a@b.co" });
    expect(api.customers.update).toHaveBeenCalledWith("cus_9", { email: "c@d.co" }, { stripeAccount: "acct_pi" });
    expect(api.customers.create).not.toHaveBeenCalled();
  });
});

describe("createOrUpdatePaymentIntent", () => {
  it("metadata carries this deployment's host; the result says whether the card is saved off session", async () => {
    const r = await createOrUpdatePaymentIntent(store, session, target, { saveCard: true });
    const [params] = api.paymentIntents.create.mock.calls[0];
    expect(params.metadata).toMatchObject({ checkout_session_id: "cs_1", store_id: "st_1", app_host: stripeAppHost() });
    expect(stripeAppHost()).not.toBe("");
    expect(r).toMatchObject({ id: "pi_new", amount: 3000, currency: "eur", offSessionSaved: true, replacedId: null });
  });

  it("never asks Stripe to e-mail its own receipt (Shopify confirms the order): no receipt_email, created or updated", async () => {
    const buyer = { email: "buyer@b.co", customerId: "cus_1" };
    await createOrUpdatePaymentIntent(store, session, target, { buyer });
    const [params] = api.paymentIntents.create.mock.calls[0];
    expect(params).not.toHaveProperty("receipt_email");
    expect(params.customer).toBe("cus_1");
    // An existing PaymentIntent getting the buyer's details, or reused for another amount.
    api.paymentIntents.retrieve.mockResolvedValueOnce(pi({ id: "pi_old", metadata: { fingerprint: "other" } }));
    api.paymentIntents.update.mockResolvedValueOnce(pi({ id: "pi_old" }));
    await createOrUpdatePaymentIntent(store, session, target, { existingId: "pi_old", reusable: true, buyer });
    expect(api.paymentIntents.update).toHaveBeenCalledTimes(1);
    expect(api.paymentIntents.update.mock.calls[0][1]).not.toHaveProperty("receipt_email");
  });

  it("the idempotency key covers the description and statement suffix (a renamed store never replays the old key)", async () => {
    await createOrUpdatePaymentIntent(store, session, target);
    await createOrUpdatePaymentIntent({ ...store, name: "Autre Nom" }, session, target);
    await createOrUpdatePaymentIntent(store, session, target, { description: "Commande spéciale" });
    const keys = api.paymentIntents.create.mock.calls.map((c) => c[1].idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    await createOrUpdatePaymentIntent(store, session, target);
    expect(api.paymentIntents.create.mock.calls.at(-1)![1].idempotencyKey).toBe(keys[0]);
  });

  it("a replaced PaymentIntent (not reusable) is canceled while nothing was submitted on it; never one being paid", async () => {
    api.paymentIntents.retrieve.mockResolvedValueOnce(pi({ id: "pi_old", amount: 2000, metadata: { fingerprint: "other" } }));
    const r = await createOrUpdatePaymentIntent(store, session, target, { existingId: "pi_old", reusable: false, cancelReplaced: true });
    expect(r).toMatchObject({ id: "pi_new", replacedId: "pi_old" });
    expect(api.paymentIntents.cancel).toHaveBeenCalledWith("pi_old", { cancellation_reason: "abandoned" }, { stripeAccount: "acct_pi" });

    api.paymentIntents.cancel.mockClear();
    api.paymentIntents.retrieve.mockResolvedValueOnce(pi({ id: "pi_old", status: "requires_action", amount: 2000, metadata: { fingerprint: "other" } }));
    await createOrUpdatePaymentIntent(store, session, target, { existingId: "pi_old", reusable: false, cancelReplaced: true });
    expect(api.paymentIntents.cancel).not.toHaveBeenCalled();

    // Not asked (a payment in flight in another tab): kept.
    api.paymentIntents.retrieve.mockResolvedValueOnce(pi({ id: "pi_old", amount: 2000, metadata: { fingerprint: "other" } }));
    await createOrUpdatePaymentIntent(store, session, target, { existingId: "pi_old", reusable: false });
    expect(api.paymentIntents.cancel).not.toHaveBeenCalled();
  });

  it("a PaymentIntent paid or going through (succeeded, processing, requires_capture) is never replaced nor changed, whatever it charges", async () => {
    for (const status of ["succeeded", "processing", "requires_capture"]) {
      vi.clearAllMocks();
      api.paymentIntents.retrieve.mockResolvedValueOnce(pi({ id: "pi_busy", status, amount: 2000, metadata: { fingerprint: "other" } }));
      const r = await createOrUpdatePaymentIntent(store, session, target, { existingId: "pi_busy", reusable: true, cancelReplaced: true, buyer: { email: "a@b.co" } });
      expect(r).toMatchObject({ id: "pi_busy", status });
      expect(api.paymentIntents.create).not.toHaveBeenCalled();
      expect(api.paymentIntents.update).not.toHaveBeenCalled();
      expect(api.paymentIntents.cancel).not.toHaveBeenCalled();
    }
  });

  it("a cancel failing never fails the new PaymentIntent", async () => {
    api.paymentIntents.retrieve.mockResolvedValueOnce(pi({ id: "pi_old", amount: 2000, metadata: { fingerprint: "other" } }));
    api.paymentIntents.cancel.mockRejectedValueOnce(new Error("Stripe 500"));
    await expect(createOrUpdatePaymentIntent(store, session, target, { existingId: "pi_old", cancelReplaced: true })).resolves.toMatchObject({ id: "pi_new" });
  });

  it("an existing PaymentIntent gone from the account (404) is treated as missing: a fresh one, nothing canceled", async () => {
    api.paymentIntents.retrieve.mockRejectedValueOnce(Object.assign(new Error("No such payment_intent"), { statusCode: 404, code: "resource_missing", type: "StripeInvalidRequestError" }));
    const r = await createOrUpdatePaymentIntent(store, session, target, { existingId: "pi_gone", reusable: true, cancelReplaced: true });
    expect(r).toMatchObject({ id: "pi_new", replacedId: null });
    expect(api.paymentIntents.create).toHaveBeenCalledTimes(1);
    expect(api.paymentIntents.update).not.toHaveBeenCalled();
    expect(api.paymentIntents.cancel).not.toHaveBeenCalled();
    // Any other retrieve error is Stripe's failure, thrown as is.
    api.paymentIntents.retrieve.mockRejectedValueOnce(Object.assign(new Error("Stripe 500"), { statusCode: 500 }));
    await expect(createOrUpdatePaymentIntent(store, session, target, { existingId: "pi_x" })).rejects.toThrow("Stripe 500");
  });

  it("an idempotent replay returning a canceled PaymentIntent creates again under a salted key", async () => {
    api.paymentIntents.create
      .mockResolvedValueOnce(pi({ id: "pi_canceled", status: "canceled", metadata: {} }))
      .mockImplementationOnce(async (params: { amount: number; currency: string; metadata: Record<string, string> }) => pi({ id: "pi_again", amount: params.amount, currency: params.currency, metadata: params.metadata }));
    const r = await createOrUpdatePaymentIntent(store, session, target);
    expect(r).toMatchObject({ id: "pi_again", status: "requires_payment_method" });
    const [first, second] = api.paymentIntents.create.mock.calls.map((c) => c[1].idempotencyKey as string);
    expect(second).not.toBe(first);
    expect(second.startsWith(`${first}_r`)).toBe(true);
    // The same canceled replay again: the same salted key (a retry replays the new PaymentIntent).
    api.paymentIntents.create.mockClear();
    api.paymentIntents.create.mockResolvedValueOnce(pi({ id: "pi_canceled", status: "canceled" })).mockResolvedValueOnce(pi({ id: "pi_again", metadata: { fingerprint: "x" } }));
    api.paymentIntents.update.mockResolvedValueOnce(pi({ id: "pi_again" }));
    await createOrUpdatePaymentIntent(store, session, target);
    expect(api.paymentIntents.create.mock.calls[1][1].idempotencyKey).toBe(second);
    // Bounded: an account answering only canceled ones is an error, never a canceled form.
    api.paymentIntents.create.mockReset();
    api.paymentIntents.create.mockImplementation(async () => pi({ id: `pi_c${Math.random()}`, status: "canceled" }));
    await expect(createOrUpdatePaymentIntent(store, session, target)).rejects.toThrow(/annulés/);
    expect(api.paymentIntents.create).toHaveBeenCalledTimes(4);
  });
});

describe("ensureStripeCustomer when the Customer is gone", () => {
  it("a recorded Customer deleted on the account (404 on its update): a fresh one under a salted key", async () => {
    api.customers.update.mockRejectedValueOnce(Object.assign(new Error("No such customer"), { statusCode: 404, code: "resource_missing" }));
    api.customers.create.mockResolvedValueOnce({ id: "cus_fresh" });
    expect(await ensureStripeCustomer(store, { email: "new@b.co", sessionId: "cs_1", customerId: "cus_gone", previousEmail: "old@b.co" })).toBe("cus_fresh");
    const key = api.customers.create.mock.calls[0][1].idempotencyKey as string;
    expect(key).not.toBe("wc_cus_cs_1");
    expect(key.startsWith("wc_cus_cs_1_")).toBe(true);
    // `replaces` (a PaymentIntent call said it is missing): the same salted key, no update call.
    api.customers.update.mockClear();
    await ensureStripeCustomer(store, { email: "new@b.co", sessionId: "cs_1", customerId: "cus_gone", previousEmail: "new@b.co", replaces: "cus_gone" });
    expect(api.customers.update).not.toHaveBeenCalled();
    expect(api.customers.create.mock.calls[1][1].idempotencyKey).toBe(key);
    // Another update failure is thrown as is.
    api.customers.update.mockRejectedValueOnce(Object.assign(new Error("Stripe 500"), { statusCode: 500 }));
    await expect(ensureStripeCustomer(store, { email: "x@b.co", sessionId: "cs_1", customerId: "cus_9", previousEmail: "a@b.co" })).rejects.toThrow("Stripe 500");
  });
});

describe("cancelOpenPaymentIntents", () => {
  it("cancels only those nothing was submitted on, best effort", async () => {
    api.paymentIntents.retrieve.mockImplementation(async (id: string) => pi({ id, status: id === "pi_paid" ? "succeeded" : id === "pi_3ds" ? "requires_action" : "requires_payment_method" }));
    api.paymentIntents.cancel.mockImplementation(async (id: string) => {
      if (id === "pi_err") throw new Error("Stripe 500");
      return {};
    });
    const done = await cancelOpenPaymentIntents(store, ["pi_a", "pi_paid", "pi_3ds", "pi_err", null, "pi_a"]);
    expect(done).toEqual(["pi_a"]);
    expect(await cancelOpenPaymentIntents({ ...store, stripeAccountId: null }, ["pi_a"])).toEqual([]);
  });

  it("cleanup calls are short and never retried (3 s, no network retry)", async () => {
    api.paymentIntents.retrieve.mockImplementation(async (id: string) => pi({ id }));
    await cancelOpenPaymentIntents(store, ["pi_a"]);
    expect(api.paymentIntents.retrieve).toHaveBeenCalledWith("pi_a", {}, { stripeAccount: "acct_pi", timeout: 3_000, maxNetworkRetries: 0 });
    expect(api.paymentIntents.cancel).toHaveBeenCalledWith("pi_a", { cancellation_reason: "abandoned" }, { stripeAccount: "acct_pi", timeout: 3_000, maxNetworkRetries: 0 });
  });
});
