import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/*
 * Stripe final strict review, against a real Postgres. Money: a refund reported failed before its
 * « succeeded » copy is never counted (marker), a replayed / reconciled copy is checked against
 * Stripe's current status, a failure reported while counting still alerts, early refund / dispute
 * journal lines once an hour, the reversed-refund alert of a duplicate payment links its order, the
 * Stripe health line (no webhook since the last Stripe payment). Connection: disconnect order (no
 * false « Stripe a retiré l'accès »), the reconciliation skips a store it can't read in its mode
 * (alerted once), Apple Pay only in a usable mode, an account unreadable at the callback, the
 * webhook health reset on a new account, forget matched on the connection time, concurrent writes of
 * the past-accounts list, the mode switch's Stripe problem as an error. Stripe calls mocked. Test data: sfr_.
 */

const stripeApi = vi.hoisted(() => ({
  retrievePaymentIntent: vi.fn(),
  retrieveStripeRefund: vi.fn(),
  listChargeRefunds: vi.fn(),
  listStripeEvents: vi.fn(),
  retrieveStripeEvent: vi.fn(),
  refundStripe: vi.fn(),
  deauthorize: vi.fn(),
  registerStripeDomain: vi.fn(),
  ensureConnectWebhook: vi.fn(),
  exchangeCode: vi.fn(),
  retrieveAccount: vi.fn(),
  probePlatformKeys: vi.fn(),
  stripeWebhookStatus: vi.fn(),
}));
const shopify = vi.hoisted(() => ({ createRefund: vi.fn(), orderRefundedCents: vi.fn(), tagOrder: vi.fn() }));
const whop = vi.hoisted(() => ({ teardownWhop: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendTelegram: vi.fn() }));
const afters = vi.hoisted(() => [] as (() => unknown)[]);

class Redirect extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => unknown) => {
    afters.push(fn);
  },
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), requireAdmin: async () => "admin", currentAdminId: async () => "admin", currentUser: async () => (await import("../session-stub")).ownerUser() }));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), ...stripeApi }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({ ...(await orig<typeof import("@/lib/whop")>()), ...whop }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const APP = "https://checkout.example.com";
const STRIPE_ENV = {
  STRIPE_TEST_SECRET_KEY: "sk_test_sfr",
  STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_sfr",
  STRIPE_TEST_CLIENT_ID: "ca_test_sfr",
  STRIPE_SECRET_KEY: "sk_live_sfr",
  STRIPE_PUBLISHABLE_KEY: "pk_live_sfr",
  STRIPE_CLIENT_ID: "ca_live_sfr",
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

describe("Stripe final review (pure)", async () => {
  const { stripeWebhookLate, STRIPE_WEBHOOK_GRACE_MS } = await import("@/lib/health");
  const { stripeReconcileBlocker } = await import("@/lib/stripe-webhooks");

  it("stripeWebhookLate: a Stripe payment older than the grace period with no webhook since it", () => {
    const now = Date.now();
    const paid = new Date(now - STRIPE_WEBHOOK_GRACE_MS - 60_000);
    expect(stripeWebhookLate(null, null, now)).toBe(false);
    expect(stripeWebhookLate(paid, null, now)).toBe(true);
    expect(stripeWebhookLate(paid, new Date(paid.getTime() - 1000), now)).toBe(true);
    expect(stripeWebhookLate(paid, new Date(paid.getTime() + 1000), now)).toBe(false);
    // Just paid: its webhook may still be on its way.
    expect(stripeWebhookLate(new Date(now - 60_000), null, now)).toBe(false);
  });

  it("stripeReconcileBlocker: keys of the store's mode missing, or a live store on a test-mode connection", () => {
    const env = { ...STRIPE_ENV };
    expect(stripeReconcileBlocker({ testMode: true, stripeLivemode: false }, env)).toBeNull();
    expect(stripeReconcileBlocker({ testMode: false, stripeLivemode: true }, env)).toBeNull();
    expect(stripeReconcileBlocker({ testMode: false, stripeLivemode: false }, env)).toMatch(/connecté en mode test/);
    expect(stripeReconcileBlocker({ testMode: false, stripeLivemode: true }, { ...env, STRIPE_SECRET_KEY: undefined })).toMatch(/clés Stripe de production manquent/);
    expect(stripeReconcileBlocker({ testMode: true, stripeLivemode: true }, { ...env, STRIPE_TEST_SECRET_KEY: undefined })).toMatch(/clés Stripe de test manquent/);
  });
});

describe.skipIf(!hasDb)("Stripe final review (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const actions = await import("@/app/dashboard/actions");
  const startRoute = await import("@/app/api/stripe/connect/start/route");
  const callbackRoute = await import("@/app/api/stripe/connect/callback/route");
  const { handleStripeEvent, reconcileStripe } = await import("@/lib/stripe-webhooks");
  const { forgetStripeAccount, pastStripeAccounts, rememberPastStripeAccount, saveStripeConnection } = await import("@/lib/stripe-connection");
  const { storeHealth } = await import("@/lib/health");
  const { peekStripeStateStore, stripeNonceCookie } = await import("@/lib/stripe-state");

  const created: string[] = [];
  const settingKeys: string[] = [];
  const saved: Record<string, string | undefined> = {};
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const ctx = { params: Promise.resolve({}) };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `sfr_${rnd()}`,
        enabled: true,
        testMode: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_sfr",
        whopProductId: `prod_sfr_${rnd()}`,
        whopApiKey: encrypt("k"),
        shopDomain: `sfr-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        stripeAccountId: `acct_sfr_${rnd()}`,
        stripeConnectedAt: new Date(Date.now() - 3 * 3600_000),
        stripeLivemode: false,
        stripeChargesEnabled: true,
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  /** A Stripe-paid checkout (its PaymentIntent recorded as the payment). */
  async function paidSession(storeId: string, data: Record<string, unknown> = {}) {
    const piId = `pi_sfr_${rnd()}`;
    const session = await db.checkoutSession.create({
      data: {
        storeId,
        currency: "EUR",
        lines: [],
        subtotalCents: 5000,
        totalCents: 5490,
        status: "PAID",
        paidAt: new Date(),
        paymentProvider: "stripe",
        whopPaymentId: piId,
        stripePaymentIntentId: piId,
        shopifyOrderId: `gid://shopify/Order/${rnd()}`,
        ...data,
      },
    });
    return { session, piId };
  }

  function event(type: string, account: string, object: unknown, extra: Record<string, unknown> = {}): Stripe.Event {
    return { id: `evt_sfr_${rnd()}`, object: "event", type, account, livemode: false, created: Math.floor(Date.now() / 1000), api_version: Stripe.API_VERSION, data: { object }, ...extra } as unknown as Stripe.Event;
  }

  const refundOf = (piId: string, status: string, amount = 1000) => ({ id: `re_sfr_${rnd()}`, object: "refund", status, amount, currency: "eur", payment_intent: piId });
  const refunded = async (sessionId: string) => (await db.checkoutSession.findUniqueOrThrow({ where: { id: sessionId } })).refundedCents;

  beforeAll(() => {
    for (const [k, v] of Object.entries(STRIPE_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    afters.length = 0;
    stripeApi.retrievePaymentIntent.mockResolvedValue({ id: "pi", metadata: {} });
    stripeApi.listStripeEvents.mockResolvedValue({ data: [], hasMore: false });
    stripeApi.ensureConnectWebhook.mockResolvedValue({ id: "we_1", created: false });
    stripeApi.registerStripeDomain.mockResolvedValue("active");
    stripeApi.probePlatformKeys.mockResolvedValue(undefined);
    stripeApi.deauthorize.mockResolvedValue(undefined);
    stripeApi.stripeWebhookStatus.mockResolvedValue({ manual: false, stored: true, storedUrl: null, manualFound: null });
    shopify.createRefund.mockResolvedValue({ id: "r" });
    shopify.orderRefundedCents.mockResolvedValue(0);
    whop.teardownWhop.mockResolvedValue(undefined);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await db.refundRecord.deleteMany({ where: { storeId: { in: created } } });
    await db.webhookEvent.deleteMany({ where: { storeId: { in: created } } });
    await db.checkoutSession.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    await db.appSetting.deleteMany({
      where: {
        key: {
          in: [
            ...settingKeys,
            ...created.flatMap((id) => [`stripe:past-accounts:${id}`, `stripe-reconcile-skip:${id}`, `stripe-reconcile:${id}`, `stripe-reconcile-run:${id}`, `stripe-webhook-setup:${id}`]),
          ],
        },
      },
    });
    await db.$disconnect();
  });

  describe("M1: refunds reported failed out of order", () => {
    it("failed before its « succeeded » copy: marked, then never counted", async () => {
      const store = await makeStore();
      const { session, piId } = await paidSession(store.id);
      const refund = refundOf(piId, "succeeded");
      settingKeys.push(`stripe:refund-failed:${refund.id}`);
      await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, { ...refund, status: "failed" }), store);
      expect(await db.appSetting.findUnique({ where: { key: `stripe:refund-failed:${refund.id}` } })).not.toBeNull();
      await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, refund), store);
      expect(await refunded(session.id)).toBe(0);
      expect(await db.refundRecord.findUnique({ where: { id: `stripe:${refund.id}` } })).toBeNull();
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "refund.reversed" } })).toBe(0);
    });

    it("a replayed / reconciled « succeeded » copy is checked against Stripe: failed since → not counted; a webhook copy is not re-read", async () => {
      const store = await makeStore();
      const { session, piId } = await paidSession(store.id);
      const refund = refundOf(piId, "succeeded");
      settingKeys.push(`stripe:refund-failed:${refund.id}`);
      stripeApi.retrieveStripeRefund.mockResolvedValue({ ...refund, status: "canceled" });
      await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, refund), store, { source: "replay" });
      expect(stripeApi.retrieveStripeRefund).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), refund.id);
      expect(await refunded(session.id)).toBe(0);
      expect(await db.appSetting.findUnique({ where: { key: `stripe:refund-failed:${refund.id}` } })).not.toBeNull();

      // Still succeeded in Stripe: counted.
      const ok = refundOf(piId, "succeeded", 700);
      stripeApi.retrieveStripeRefund.mockResolvedValue(ok);
      await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, ok), store, { source: "reconcile" });
      expect(await refunded(session.id)).toBe(700);
      // Unreadable: counted from the copy.
      const unread = refundOf(piId, "succeeded", 300);
      stripeApi.retrieveStripeRefund.mockRejectedValue(Object.assign(new Error("timeout"), { type: "StripeConnectionError" }));
      await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, unread), store, { source: "replay" });
      expect(await refunded(session.id)).toBe(1000);

      // Stripe's own delivery: never re-read.
      stripeApi.retrieveStripeRefund.mockClear();
      const live = refundOf(piId, "succeeded", 100);
      await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, live), store);
      expect(stripeApi.retrieveStripeRefund).not.toHaveBeenCalled();
      expect(await refunded(session.id)).toBe(1100);
    });

    it("the reconciliation passes its copies through the re-check", async () => {
      const store = await makeStore();
      const { session, piId } = await paidSession(store.id);
      const refund = refundOf(piId, "succeeded");
      settingKeys.push(`stripe:refund-failed:${refund.id}`);
      const evt = event("charge.refund.updated", store.stripeAccountId!, refund);
      stripeApi.listStripeEvents.mockImplementation(async (s: { id: string }) => (s.id === store.id ? { data: [evt], hasMore: false } : { data: [], hasMore: false }));
      stripeApi.retrieveStripeRefund.mockResolvedValue({ ...refund, status: "failed" });
      await reconcileStripe(Date.now() + 20_000);
      expect(stripeApi.retrieveStripeRefund).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), refund.id);
      expect(await refunded(session.id)).toBe(0);
    });

    it("its failure reported while it was being counted: alerted (once) after counting", async () => {
      const store = await makeStore();
      const { session, piId } = await paidSession(store.id);
      const refund = refundOf(piId, "succeeded");
      const key = `stripe:refund-failed:${refund.id}`;
      settingKeys.push(key, `stripe:refund-reversed:${refund.id}`);
      // The failure lands right after the pre-count check (concurrent delivery).
      const spy = vi.spyOn(db.appSetting, "findUnique").mockImplementationOnce((async () => {
        await db.appSetting.create({ data: { key, value: JSON.stringify({ status: "failed" }) } });
        return null;
      }) as unknown as typeof db.appSetting.findUnique);
      await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, refund), store);
      spy.mockRestore();
      expect(await refunded(session.id)).toBe(1000);
      const alerts = await db.eventLog.findMany({ where: { storeId: store.id, kind: "refund.reversed" } });
      expect(alerts).toHaveLength(1);
      expect(alerts[0].sessionId).toBe(session.id);
    });
  });

  describe("M5: journal noise and order links", () => {
    it("refund.early / dispute.early: journaled once per id and hour, retried each time", async () => {
      const store = await makeStore();
      const piId = `pi_sfr_early_${rnd()}`;
      await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [], subtotalCents: 5000, totalCents: 5490, paymentProvider: "stripe", stripePaymentIntentId: piId } });
      const refund = refundOf(piId, "succeeded");
      const dispute = { id: `du_sfr_${rnd()}`, object: "dispute", amount: 5490, currency: "eur", status: "needs_response", payment_intent: piId };
      for (let i = 0; i < 3; i++) {
        await expect(handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, refund), store)).rejects.toThrow(/pas encore enregistré/);
        await expect(handleStripeEvent(event("charge.dispute.created", store.stripeAccountId!, dispute), store)).rejects.toThrow(/pas encore enregistré/);
      }
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "refund.early" } })).toBe(1);
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "dispute.early" } })).toBe(1);
    });

    it("a duplicate payment's refund reversed after it was counted: the alert links the order", async () => {
      const store = await makeStore();
      const dup = `pi_sfr_dup_${rnd()}`;
      const { session } = await paidSession(store.id, { extraPaymentIds: [`stripe:${dup}`] });
      const refund = refundOf(dup, "succeeded", 5490);
      settingKeys.push(`stripe:refund-reversed:${refund.id}`);
      await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, refund), store);
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "refund.extra_payment" } })).toBe(1);
      await handleStripeEvent(event("charge.refund.updated", store.stripeAccountId!, { ...refund, status: "failed" }), store);
      const alert = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "refund.reversed" } });
      expect(alert.sessionId).toBe(session.id);
      expect(await refunded(session.id)).toBe(0);
    });
  });

  it("M4: the Stripe health line is red when no webhook came since the last Stripe payment", async () => {
    const store = await makeStore({ whopConnectedAt: null, whopApiKey: null, paymentMode: "stripe_only", lastStripeWebhookAt: new Date(Date.now() - 2 * 3600_000) });
    await paidSession(store.id, { paidAt: new Date(Date.now() - 30 * 60_000) });
    const line = (await storeHealth(store.id)).find((i) => i.key === "stripe");
    expect(line).toMatchObject({ ok: false, detail: expect.stringMatching(/Aucun webhook Stripe reçu depuis le dernier paiement Stripe/) });
    await db.store.update({ where: { id: store.id }, data: { lastStripeWebhookAt: new Date() } });
    expect((await storeHealth(store.id)).find((i) => i.key === "stripe")?.ok).toBe(true);
  });

  describe("connection", () => {
    it("C1: « Déconnecter » forgets first, then revokes: the deauthorization webhook it triggers is quiet; the past account is marked revoked", async () => {
      const store = await makeStore({ stripeAccountName: "Compte D" });
      const acct = store.stripeAccountId!;
      stripeApi.deauthorize.mockImplementation(async () => {
        // Stripe's webhook for this revocation arriving while the call is in flight.
        const now = await db.store.findUniqueOrThrow({ where: { id: store.id } });
        expect(now.stripeAccountId).toBeNull();
        await handleStripeEvent(event("account.application.deauthorized", acct, { id: "ca_test_sfr", object: "application" }), now);
      });
      expect((await flashOf(() => actions.disconnectStripeAction(store.id))).ok).toBe("Stripe déconnecté.");
      expect(stripeApi.deauthorize).toHaveBeenCalledWith(acct, "test");
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "stripe.deauthorized" } })).toBe(0);
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "stripe.disconnected" } })).toBe(1);
      expect(await pastStripeAccounts(store.id)).toEqual([expect.objectContaining({ id: acct, revoked: true })]);

      // Revocation refused by Stripe: forgotten all the same, the past account not marked revoked.
      const other = await makeStore();
      stripeApi.deauthorize.mockRejectedValue(new Error("Stripe indisponible"));
      expect((await flashOf(() => actions.disconnectStripeAction(other.id))).ok).toMatch(/Stripe n'a pas confirmé le retrait/);
      expect((await db.store.findUniqueOrThrow({ where: { id: other.id } })).stripeAccountId).toBeNull();
      expect(await pastStripeAccounts(other.id)).toEqual([expect.objectContaining({ id: other.stripeAccountId, revoked: false })]);
    });

    it("C2: the reconciliation skips a live store on a test-mode connection, alerted once (not every run), and resumes once readable", async () => {
      const store = await makeStore({ testMode: false, stripeLivemode: false });
      await reconcileStripe(Date.now() + 20_000);
      await reconcileStripe(Date.now() + 20_000);
      expect(stripeApi.listStripeEvents.mock.calls.filter((c) => c[0].id === store.id)).toHaveLength(0);
      const skipped = await db.eventLog.findMany({ where: { storeId: store.id, kind: "reconcile.stripe_skipped" } });
      expect(skipped).toHaveLength(1);
      expect(skipped[0].message).toMatch(/connecté en mode test/);
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "stripe.deauthorized" } })).toBe(0);
      // Reconnected live: read again, the marker gone.
      await db.store.update({ where: { id: store.id }, data: { stripeLivemode: true } });
      await reconcileStripe(Date.now() + 20_000);
      expect(stripeApi.listStripeEvents.mock.calls.filter((c) => c[0].id === store.id).length).toBeGreaterThan(0);
      expect(await db.appSetting.findUnique({ where: { key: `stripe-reconcile-skip:${store.id}` } })).toBeNull();
    });

    it("C3: « Enregistrer les domaines » is refused (with the reason) when Stripe can't be used in the store's mode", async () => {
      const store = await makeStore({ testMode: false, stripeLivemode: false });
      const res = await flashOf(() => actions.registerStripeDomainsAction(store.id));
      expect(res.error).toMatch(/connecté en mode test/);
      expect(stripeApi.registerStripeDomain).not.toHaveBeenCalled();
    });

    it("C4: callback with the account unreadable after the exchange: saved nameless and not charging, said so", async () => {
      const store = await makeStore({ stripeAccountId: null, stripeConnectedAt: null, stripeLivemode: null, stripeChargesEnabled: null });
      const body = new FormData();
      body.set("store", store.id);
      const started = await startRoute.POST(new Request(`${APP}/api/stripe/connect/start`, { method: "POST", body, headers: { origin: APP } }), ctx);
      const state = new URL(started.headers.get("location") ?? "", APP).searchParams.get("state") ?? "";
      const cookie = (started.headers.get("set-cookie") ?? "").match(new RegExp(`${stripeNonceCookie(store.id)}=([^;]+)`))?.[1] ?? "";
      const acct = `acct_sfr_cb_${rnd()}`;
      stripeApi.exchangeCode.mockResolvedValue({ accountId: acct, livemode: false, scope: "read_write" });
      stripeApi.retrieveAccount.mockRejectedValue(Object.assign(new Error("timeout"), { type: "StripeConnectionError" }));
      const name = stripeNonceCookie(peekStripeStateStore(state) ?? "x");
      const res = await callbackRoute.GET(new Request(`${APP}/api/stripe/connect/callback?${new URLSearchParams({ state, code: "ac_sfr" })}`, { headers: { cookie: `${name}=${cookie}` } }), ctx);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.searchParams.get("ok")).toMatch(/connecté.*n'a pas renvoyé les détails du compte/);
      expect(await db.store.findUniqueOrThrow({ where: { id: store.id } })).toMatchObject({ stripeAccountId: acct, stripeAccountName: null, stripeChargesEnabled: false, stripeLivemode: false });
    });

    it("C5: a new account resets the webhook health, the same one keeps it; forget is matched on the connection time", async () => {
      const store = await makeStore({ lastStripeWebhookAt: new Date() });
      const same = await saveStripeConnection(store, { id: store.stripeAccountId!, name: "A", livemode: false, chargesEnabled: true }, async () => false);
      expect(same.lastStripeWebhookAt).toBeInstanceOf(Date);
      const next = await saveStripeConnection(same, { id: `acct_sfr_new_${rnd()}`, name: "B", livemode: false, chargesEnabled: true }, async () => false);
      expect(next.lastStripeWebhookAt).toBeNull();

      // A forget built from before a reconnection of the same account leaves the new connection alone.
      const stale = { ...next, stripeConnectedAt: new Date(next.stripeConnectedAt!.getTime() - 60_000) };
      expect(await forgetStripeAccount(stale, { by: "stripe", message: "x" })).toBe(false);
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeAccountId).toBe(next.stripeAccountId);
      expect(await forgetStripeAccount(next, { by: "merchant", message: "Déconnecté." })).toBe(true);
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeAccountId).toBeNull();
    });

    it("C6: concurrent writes of the past-accounts list keep every entry", async () => {
      const store = await makeStore();
      const ids = Array.from({ length: 6 }, () => `acct_sfr_past_${rnd()}`);
      await Promise.all(ids.map((id, i) => rememberPastStripeAccount(store.id, id, i % 2 === 0)));
      const list = await pastStripeAccounts(store.id);
      expect(list.map((a) => a.id).sort()).toEqual([...ids].sort());
      expect(list.find((a) => a.id === ids[0])?.revoked).toBe(true);
      expect(list.find((a) => a.id === ids[1])?.revoked).toBe(false);
    });

    it("C7: switching to production with a test-mode Stripe connection: the switch as a success, the Stripe problem as an error", async () => {
      const store = await makeStore({ whopConnectedAt: null, whopApiKey: null });
      const fd = new FormData();
      fd.set("name", store.name);
      const res = await flashOf(() => actions.saveSettingsAction(store.id, fd));
      expect(res.path).toBe(`/dashboard/stores/${store.id}/stripe`);
      expect(res.ok).toBe("Mode production activé.");
      expect(res.error).toMatch(/^Reconnectez Stripe en production/);
    });
  });
});
