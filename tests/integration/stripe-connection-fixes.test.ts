import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Stripe connection, strict re-review fixes, against a real Postgres: a store charging through Stripe
 * alone is live (switch, Whop disconnect, test / live switch), forgetStripeAccount is conditional on
 * the account, a refund on a revoked past account is refused with the way out, a revoked current
 * account is detected after an auth failure, the domains / webhook messages, the health line of a
 * missing webhook, « Tester le secours » checkouts out of the offer tests. Stripe and Whop calls
 * mocked. Test data: scf_.
 */

const stripeApi = vi.hoisted(() => ({
  ensureConnectWebhook: vi.fn(),
  registerStripeDomain: vi.fn(),
  refundStripe: vi.fn(),
  retrieveAccount: vi.fn(),
  probePlatformKeys: vi.fn(),
  stripeWebhookStatus: vi.fn(),
}));
const whop = vi.hoisted(() => ({ teardownWhop: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendTelegram: vi.fn() }));

class Redirect extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), requireAdmin: async () => "admin", currentAdminId: async () => "admin", currentUser: async () => (await import("../session-stub")).ownerUser() }));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), ...stripeApi }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const STRIPE_ENV = {
  STRIPE_TEST_SECRET_KEY: "sk_test_scf",
  STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_scf",
  STRIPE_TEST_CLIENT_ID: "ca_test_scf",
  STRIPE_SECRET_KEY: "sk_live_scf",
  STRIPE_PUBLISHABLE_KEY: "pk_live_scf",
  STRIPE_CLIENT_ID: "ca_live_scf",
};

async function flashOf(run: () => Promise<unknown>): Promise<{ path: string; ok?: string; error?: string }> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Redirect)) throw err;
    const u = new URL(err.url, "http://x");
    return { path: u.pathname, ok: u.searchParams.get("ok") ?? undefined, error: u.searchParams.get("error") ?? undefined };
  }
  throw new Error("no redirect");
}

describe.skipIf(!hasDb)("Stripe connection fixes (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const actions = await import("@/app/dashboard/actions");
  const { forgetStripeAccount, rememberPastStripeAccount, detectRevokedStripeAccount } = await import("@/lib/stripe-connection");
  const { storeHealth } = await import("@/lib/health");
  const { offerArmAggregates } = await import("@/lib/offer-tests");

  const created: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const stripeOnly = () => ({ whopConnectedAt: null, whopApiKey: null, stripeAccountId: `acct_scf_${rnd()}`, stripeConnectedAt: new Date(), stripeLivemode: false, stripeChargesEnabled: true });

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `scf_${rnd()}`,
        enabled: true,
        testMode: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_scf",
        whopProductId: `prod_scf_${rnd()}`,
        whopApiKey: encrypt("k"),
        shopDomain: `scf-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  const settingsForm = (store: { name: string }, testMode: boolean) => {
    const fd = new FormData();
    fd.set("name", store.name);
    if (testMode) fd.set("testMode", "on");
    return fd;
  };

  beforeAll(() => {
    for (const [k, v] of Object.entries(STRIPE_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    stripeApi.ensureConnectWebhook.mockResolvedValue({ id: "we_1", created: false });
    stripeApi.registerStripeDomain.mockResolvedValue("active");
    stripeApi.probePlatformKeys.mockResolvedValue(undefined);
    stripeApi.stripeWebhookStatus.mockResolvedValue({ manual: false, stored: true, storedUrl: null, manualFound: null });
    whop.teardownWhop.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await db.upsellCharge.deleteMany({ where: { session: { storeId: { in: created } } } });
    await db.checkoutSession.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    await db.appSetting.deleteMany({ where: { key: { in: created.flatMap((id) => [`stripe:past-accounts:${id}`, `stripe-webhook-setup:${id}`]) } } });
    await db.$disconnect();
  });

  describe("a store charging through Stripe alone is live", () => {
    it("setEnabledAction: Stripe alone is enough; no processor at all is refused", async () => {
      const s = await makeStore({ enabled: false, ...stripeOnly() });
      expect((await flashOf(() => actions.setEnabledAction(s.id, true))).ok).toMatch(/Checkout activé/);
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).enabled).toBe(true);

      const none = await makeStore({ enabled: false, whopConnectedAt: null, whopApiKey: null });
      expect((await flashOf(() => actions.setEnabledAction(none.id, true))).error).toMatch(/moyen de paiement \(Whop ou Stripe\)/);
      expect((await db.store.findUniqueOrThrow({ where: { id: none.id } })).enabled).toBe(false);
      // A Stripe account that can't charge (payments not activated) doesn't count.
      const blocked = await makeStore({ enabled: false, ...stripeOnly(), stripeChargesEnabled: false });
      expect((await flashOf(() => actions.setEnabledAction(blocked.id, true))).error).toMatch(/moyen de paiement/);
    });

    it("disconnectWhopAction: the checkout stays live when Stripe can charge; goes off otherwise", async () => {
      const withStripe = await makeStore({ stripeAccountId: `acct_scf_${rnd()}`, stripeConnectedAt: new Date(), stripeLivemode: false });
      expect((await flashOf(() => actions.disconnectWhopAction(withStripe.id))).ok).toMatch(/reste en ligne : Stripe encaisse seul/);
      expect(await db.store.findUniqueOrThrow({ where: { id: withStripe.id } })).toMatchObject({ enabled: true, whopConnectedAt: null });

      const whopOnly = await makeStore();
      expect((await flashOf(() => actions.disconnectWhopAction(whopOnly.id))).ok).toBe("Whop déconnecté.");
      expect(await db.store.findUniqueOrThrow({ where: { id: whopOnly.id } })).toMatchObject({ enabled: false, whopConnectedAt: null });
    });

    it("test → live with a live Stripe connection: stays live on Stripe, the live webhook and wallet domains are set up", async () => {
      const s = await makeStore({ stripeAccountId: `acct_scf_${rnd()}`, stripeConnectedAt: new Date(), stripeLivemode: true, stripeChargesEnabled: true });
      const res = await flashOf(() => actions.saveSettingsAction(s.id, settingsForm(s, false)));
      expect(res.path).toBe(`/dashboard/stores/${s.id}/whop`);
      expect(res.ok).toMatch(/Reconnectez Whop.*Le checkout reste en ligne : Stripe encaisse en attendant/);
      expect(await db.store.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ testMode: false, enabled: true, whopConnectedAt: null });
      expect(stripeApi.ensureConnectWebhook).toHaveBeenCalledWith("live");
      expect(stripeApi.registerStripeDomain).toHaveBeenCalledWith(expect.objectContaining({ id: s.id, testMode: false }), "checkout.example.com");
    });

    it("test → live without a processor left: the checkout goes off, no Stripe setup", async () => {
      const whopOnly = await makeStore();
      await flashOf(() => actions.saveSettingsAction(whopOnly.id, settingsForm(whopOnly, false)));
      expect(await db.store.findUniqueOrThrow({ where: { id: whopOnly.id } })).toMatchObject({ enabled: false, whopConnectedAt: null });
      expect(stripeApi.ensureConnectWebhook).not.toHaveBeenCalled();
      // A test-mode Stripe connection can't charge in production either.
      const testStripe = await makeStore({ ...stripeOnly() });
      await flashOf(() => actions.saveSettingsAction(testStripe.id, settingsForm(testStripe, false)));
      expect((await db.store.findUniqueOrThrow({ where: { id: testStripe.id } })).enabled).toBe(false);
      expect(stripeApi.registerStripeDomain).not.toHaveBeenCalled();
    });

    it("mode switch with Stripe usable but its webhook failing: said on the Stripe page", async () => {
      const s = await makeStore({ testMode: false, ...stripeOnly(), stripeLivemode: true });
      stripeApi.ensureConnectWebhook.mockRejectedValue(new Error("Stripe indisponible"));
      const res = await flashOf(() => actions.saveSettingsAction(s.id, settingsForm(s, true)));
      expect(res.path).toBe(`/dashboard/stores/${s.id}/stripe`);
      expect(res.error).toMatch(/Webhook Stripe du nouveau mode à réparer : Stripe indisponible/);
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).enabled).toBe(true);
    });
  });

  describe("forgetStripeAccount", () => {
    it("conditional on the account: a store reconnected meanwhile is left alone, nothing journaled", async () => {
      const s = await makeStore({ stripeAccountId: `acct_scf_new_${rnd()}`, stripeConnectedAt: new Date(), stripeLivemode: false, lastStripeWebhookAt: new Date() });
      await forgetStripeAccount({ ...s, stripeAccountId: "acct_scf_old" }, { by: "stripe", message: "x" });
      const kept = await db.store.findUniqueOrThrow({ where: { id: s.id } });
      expect(kept.stripeAccountId).toBe(s.stripeAccountId);
      expect(await db.eventLog.count({ where: { storeId: s.id, kind: { in: ["stripe.deauthorized", "stripe.disconnected"] } } })).toBe(0);
      // The current one: forgotten, its webhook health cleared, journaled once even when called twice.
      await forgetStripeAccount(s, { by: "merchant", message: "Déconnecté." });
      await forgetStripeAccount(s, { by: "merchant", message: "Déconnecté." });
      const after = await db.store.findUniqueOrThrow({ where: { id: s.id } });
      expect(after).toMatchObject({ stripeAccountId: null, lastStripeWebhookAt: null });
      expect(await db.eventLog.count({ where: { storeId: s.id, kind: "stripe.disconnected" } })).toBe(1);
    });
  });

  describe("revoked accounts", () => {
    it("a refund on a revoked past account is refused before calling Stripe, with the way out", async () => {
      const s = await makeStore({ stripeAccountId: `acct_scf_cur_${rnd()}`, stripeConnectedAt: new Date(), stripeLivemode: false });
      const old = `acct_scf_old_${rnd()}`;
      await rememberPastStripeAccount(s.id, old, true);
      const session = await db.checkoutSession.create({
        data: { storeId: s.id, currency: "EUR", lines: [], subtotalCents: 1000, totalCents: 1000, status: "PAID", paidAt: new Date(), paymentProvider: "stripe", whopPaymentId: `pi_scf_${rnd()}`, stripeAccountId: old },
      });
      const res = await flashOf(() => actions.refundOrderAction(s.id, session.id, new FormData()));
      expect(res.error).toBe("Ce paiement a été fait sur un ancien compte Stripe déconnecté : remboursez-le depuis votre dashboard Stripe, puis indiquez-le dans Shopify.");
      expect(stripeApi.refundStripe).not.toHaveBeenCalled();
      // Not revoked (still mapped, e.g. shared with another store): refunded on it as before.
      await rememberPastStripeAccount(s.id, old, false);
      stripeApi.refundStripe.mockResolvedValue({ id: "re_scf" });
      expect((await flashOf(() => actions.refundOrderAction(s.id, session.id, new FormData()))).ok).toMatch(/demandé à Stripe/);
    });

    it("detectRevokedStripeAccount: 401 / 403 on the account with working platform keys → forgotten and alerted; otherwise kept", async () => {
      const s = await makeStore({ stripeAccountId: `acct_scf_${rnd()}`, stripeAccountName: "Compte R", stripeConnectedAt: new Date(), stripeLivemode: false, paymentMode: "stripe_primary" });
      // Stripe unreachable / 5xx: nothing decided.
      stripeApi.retrieveAccount.mockRejectedValueOnce(Object.assign(new Error("boom"), { statusCode: 500 }));
      expect(await detectRevokedStripeAccount(s)).toBe(false);
      // The platform's own keys refused: a server problem, not a revocation.
      stripeApi.probePlatformKeys.mockRejectedValueOnce(Object.assign(new Error("Invalid API Key"), { statusCode: 401 }));
      expect(await detectRevokedStripeAccount(s)).toBe(false);
      expect(stripeApi.retrieveAccount).toHaveBeenCalledTimes(1);
      expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).stripeAccountId).toBe(s.stripeAccountId);

      stripeApi.retrieveAccount.mockRejectedValueOnce(Object.assign(new Error("does not have access to account"), { statusCode: 403 }));
      expect(await detectRevokedStripeAccount(s)).toBe(true);
      expect(await db.store.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ stripeAccountId: null, paymentMode: "whop_primary", enabled: true });
      const ev = await db.eventLog.findFirstOrThrow({ where: { storeId: s.id, kind: "stripe.deauthorized" } });
      expect(ev.message).toMatch(/Stripe refuse l'accès au compte « Compte R » \(403\)/);
      expect(ev.level).toBe("error");
    });
  });

  describe("domains, webhook and health", () => {
    it("« Enregistrer les domaines »: domains fine but webhook failing → the success and the webhook problem apart", async () => {
      const s = await makeStore({ ...stripeOnly() });
      stripeApi.ensureConnectWebhook.mockRejectedValue(new Error("Stripe indisponible"));
      const res = await flashOf(() => actions.registerStripeDomainsAction(s.id));
      expect(res.ok).toBe("Apple Pay actif chez Stripe sur checkout.example.com.");
      expect(res.error).toMatch(/^Webhook Stripe à réparer .*Stripe indisponible/);
      stripeApi.ensureConnectWebhook.mockResolvedValue({ id: "we_1", created: false });
      const fine = await flashOf(() => actions.registerStripeDomainsAction(s.id));
      expect(fine.error).toBeUndefined();
    });

    it("storeHealth: a usable Stripe without its webhook is red; a Stripe-only store has no Whop webhook line", async () => {
      const s = await makeStore({ ...stripeOnly(), paymentMode: "stripe_only" });
      stripeApi.stripeWebhookStatus.mockResolvedValue({ manual: false, stored: false, storedUrl: null, manualFound: null });
      const items = await storeHealth(s.id);
      expect(items.find((i) => i.key === "stripe")).toMatchObject({ ok: false, detail: expect.stringMatching(/Webhook Stripe absent/) });
      expect(items.find((i) => i.key === "webhook")).toBeUndefined();
      stripeApi.stripeWebhookStatus.mockResolvedValue({ manual: false, stored: true, storedUrl: null, manualFound: null });
      expect((await storeHealth(s.id)).find((i) => i.key === "stripe")?.ok).toBe(true);
    });
  });

  it("offer tests: « Tester le secours » checkouts are left out of the arms' figures", async () => {
    const s = await makeStore();
    const since = new Date(Date.now() - 3600_000);
    const base = { storeId: s.id, currency: "EUR", lines: [], subtotalCents: 1000, totalCents: 1000, status: "PAID" as const, paidAt: new Date(), upsellShownBlocks: ["blk_scf"], test: false };
    await db.checkoutSession.create({ data: { ...base, forcedProvider: "stripe" } });
    const store = { id: s.id, vatExempt: true, vatDomesticOnly: false };
    expect((await offerArmAggregates(store, since, new Date(Date.now() + 60_000), false)).get("blk_scf")).toBeUndefined();
    await db.checkoutSession.create({ data: base });
    expect((await offerArmAggregates(store, since, new Date(Date.now() + 60_000), false)).get("blk_scf")?.impressions).toBe(1);
  });
});
