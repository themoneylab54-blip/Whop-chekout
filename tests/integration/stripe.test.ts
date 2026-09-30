import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

/*
 * Stripe Connect, phase 1, against a real Postgres: the OAuth start / callback (state bound to the
 * browser's nonce cookie, account saved, webhook ensured, wallet domains registered, journal), the
 * payment mode validation, « Déconnecter », and the Connect webhook (signature, store resolution,
 * per-store claim, account.application.deauthorized, unknown accounts, unhandled events). Stripe's API
 * calls are mocked; signatures are real (Stripe's own test header). Test data: strp_.
 */

const auth = vi.hoisted(() => ({ admin: "admin" as string | null }));
const stripeApi = vi.hoisted(() => ({
  exchangeCode: vi.fn(),
  retrieveAccount: vi.fn(),
  ensureConnectWebhook: vi.fn(),
  registerStripeDomain: vi.fn(),
  deauthorize: vi.fn(),
  stripeDomainStatuses: vi.fn(),
  refundStripe: vi.fn(),
}));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendTelegram: vi.fn() }));
const shopify = vi.hoisted(() => ({ priceCart: vi.fn() }));

class Redirect extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

// after(): run right away, not awaited (the webhook's follow-ups — alerts included — run after its answer).
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void Promise.resolve().then(fn) }));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  requireAdmin: async () => auth.admin ?? "admin",
  currentAdminId: async () => auth.admin,
  currentUser: async () => (auth.admin ? (await import("../session-stub")).ownerUser(auth.admin) : null),
}));
vi.mock("@/lib/stripe", async (orig) => ({ ...(await orig<typeof import("@/lib/stripe")>()), ...stripeApi }));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));
vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));

const hasDb = !!process.env.DATABASE_URL;
const APP = "https://checkout.example.com";
const WEBHOOK_SECRET = "whsec_strp_integration_secret";
const STRIPE_ENV = {
  STRIPE_TEST_SECRET_KEY: "sk_test_strp",
  STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_strp",
  STRIPE_TEST_CLIENT_ID: "ca_test_strp",
  STRIPE_SECRET_KEY: "sk_live_strp",
  STRIPE_PUBLISHABLE_KEY: "pk_live_strp",
  STRIPE_CLIENT_ID: "ca_live_strp",
  STRIPE_TEST_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

async function flashOf(run: () => Promise<unknown>): Promise<{ path: string; ok?: string; error?: string; field?: string }> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Redirect)) throw err;
    const u = new URL(err.url, "http://x");
    const q = u.searchParams;
    return { path: u.pathname, ok: q.get("ok") ?? undefined, error: q.get("error") ?? undefined, field: q.get("field") ?? undefined };
  }
  throw new Error("no redirect");
}

describe.skipIf(!hasDb)("Stripe Connect, phase 1 (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const actions = await import("@/app/dashboard/actions");
  const startRoute = await import("@/app/api/stripe/connect/start/route");
  const callbackRoute = await import("@/app/api/stripe/connect/callback/route");
  const webhookRoute = await import("@/app/api/webhooks/stripe/route");
  const { peekStripeStateStore, stripeNonceCookie } = await import("@/lib/stripe-state");

  const created: string[] = [];
  const settings: string[] = [];
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const ctx = { params: Promise.resolve({}) };
  const saved: Record<string, string | undefined> = {};

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `strp_${rnd()}`,
        enabled: true,
        testMode: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_strp",
        whopProductId: `prod_strp_${rnd()}`,
        whopApiKey: encrypt("k"),
        shopDomain: `strp-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  /** The dashboard's « Se connecter avec Stripe » form POST. */
  function startRequest(storeId: string, origin: string | null = APP) {
    const body = new FormData();
    body.set("store", storeId);
    return new Request(`${APP}/api/stripe/connect/start`, { method: "POST", body, headers: origin ? { origin } : {} });
  }

  /** Runs « Se connecter avec Stripe »: the redirect to Stripe, the state and the store's nonce cookie. */
  async function start(storeId: string) {
    const res = await startRoute.POST(startRequest(storeId), ctx);
    const location = res.headers.get("location") ?? "";
    const cookie = (res.headers.get("set-cookie") ?? "").match(new RegExp(`${stripeNonceCookie(storeId)}=([^;]+)`))?.[1] ?? "";
    return { res, location, state: new URL(location, APP).searchParams.get("state") ?? "", cookie };
  }

  function callback(query: Record<string, string>, cookie: string | null, storeId?: string) {
    const name = stripeNonceCookie(storeId ?? peekStripeStateStore(query.state ?? "") ?? "x");
    const headers = new Headers(cookie ? { cookie: `other=1; ${name}=${cookie}` } : {});
    return callbackRoute.GET(new Request(`${APP}/api/stripe/connect/callback?${new URLSearchParams(query)}`, { headers }), ctx);
  }

  function signedEvent(evt: Record<string, unknown>) {
    const payload = JSON.stringify({ object: "event", api_version: Stripe.API_VERSION, created: Math.floor(Date.now() / 1000), data: { object: {} }, livemode: false, ...evt });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
    return new Request(`${APP}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: payload });
  }

  beforeAll(() => {
    for (const [k, v] of Object.entries(STRIPE_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });

  beforeEach(() => {
    auth.admin = "admin";
    vi.clearAllMocks();
    stripeApi.ensureConnectWebhook.mockResolvedValue({ id: "we_1", created: true });
    stripeApi.registerStripeDomain.mockResolvedValue("active");
    stripeApi.deauthorize.mockResolvedValue(undefined);
    stripeApi.stripeDomainStatuses.mockResolvedValue({});
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await db.webhookEvent.deleteMany({ where: { storeId: { in: created } } });
    await db.checkoutSession.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
    await db.appSetting.deleteMany({ where: { key: { in: [...settings, ...created.map((id) => `stripe:past-accounts:${id}`)] } } });
    await db.$disconnect();
  });

  describe("OAuth", () => {
    it("start: admin only, signed state + nonce cookie, Stripe's consent page with the test client id", async () => {
      const store = await makeStore();
      auth.admin = null;
      const anon = await startRoute.POST(startRequest(store.id), ctx);
      expect(anon.headers.get("location")).toBe(`${APP}/login`);
      auth.admin = "admin";
      // POST from the dashboard only: a foreign or unparsable Origin is refused; a GET starts nothing.
      expect((await startRoute.POST(startRequest(store.id, "https://evil.example"), ctx)).status).toBe(403);
      expect((await startRoute.POST(startRequest(store.id, "not a url"), ctx)).status).toBe(403);
      const get = await startRoute.GET(new Request(`${APP}/api/stripe/connect/start?store=${store.id}`), ctx);
      expect(get.headers.get("location")).toBe(`${APP}/dashboard/stores/${store.id}/stripe`);
      expect(get.headers.get("set-cookie")).toBeNull();
      const { location, state, cookie, res } = await start(store.id);
      const url = new URL(location);
      expect(url.host).toBe("connect.stripe.com");
      expect(url.searchParams.get("client_id")).toBe("ca_test_strp");
      expect(url.searchParams.get("scope")).toBe("read_write");
      expect(state).toContain(".");
      expect(cookie.length).toBeGreaterThan(10);
      expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
      expect(res.headers.get("set-cookie")).toMatch(/Path=\/api\/stripe\/connect/i);
    });

    it("start: unconfigured mode sends back to the Stripe page with the steps", async () => {
      const store = await makeStore({ testMode: false });
      const prev = process.env.STRIPE_CLIENT_ID;
      delete process.env.STRIPE_CLIENT_ID;
      try {
        const res = await startRoute.POST(startRequest(store.id), ctx);
        const loc = new URL(res.headers.get("location") ?? "");
        expect(loc.pathname).toBe(`/dashboard/stores/${store.id}/stripe`);
        expect(loc.searchParams.get("error")).toMatch(/pas encore configuré/);
      } finally {
        process.env.STRIPE_CLIENT_ID = prev;
      }
    });

    it("callback: saves the account, ensures the webhook, registers the wallet domains, journals", async () => {
      const store = await makeStore();
      stripeApi.exchangeCode.mockResolvedValue({ accountId: "acct_strp_ok", livemode: false, scope: "read_write" });
      stripeApi.retrieveAccount.mockResolvedValue({ id: "acct_strp_ok", name: "Maison Strp", email: "m@example.com", country: "FR", chargesEnabled: true, defaultCurrency: "eur" });
      const { state, cookie } = await start(store.id);
      const res = await callback({ state, code: "ac_123" }, cookie);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.pathname).toBe(`/dashboard/stores/${store.id}/stripe`);
      expect(loc.searchParams.get("ok")).toMatch(/Maison Strp.*connecté/);
      expect(res.headers.get("set-cookie")).toMatch(new RegExp(`${stripeNonceCookie(store.id)}=;`));
      expect(stripeApi.exchangeCode).toHaveBeenCalledWith("ac_123", "test");
      expect(stripeApi.ensureConnectWebhook).toHaveBeenCalledWith("test");
      expect(stripeApi.registerStripeDomain).toHaveBeenCalledWith(expect.objectContaining({ id: store.id, stripeAccountId: "acct_strp_ok" }), "checkout.example.com");
      const after = await db.store.findUniqueOrThrow({ where: { id: store.id } });
      expect(after).toMatchObject({ stripeAccountId: "acct_strp_ok", stripeAccountName: "Maison Strp", stripeLivemode: false, stripeChargesEnabled: true, paymentMode: "whop_primary" });
      expect(after.stripeConnectedAt).toBeInstanceOf(Date);
      const ev = await db.eventLog.findFirst({ where: { storeId: store.id, kind: "stripe.connected" } });
      expect(ev?.message).toMatch(/Maison Strp/);
    });

    it("callback: a webhook setup failure doesn't lose the connection; an account that can't charge is flagged", async () => {
      const store = await makeStore();
      stripeApi.exchangeCode.mockResolvedValue({ accountId: "acct_strp_nowh", livemode: false, scope: "read_write" });
      stripeApi.retrieveAccount.mockResolvedValue({ id: "acct_strp_nowh", name: null, email: null, country: "FR", chargesEnabled: false, defaultCurrency: null });
      stripeApi.ensureConnectWebhook.mockRejectedValue(new Error("boom"));
      const { state, cookie } = await start(store.id);
      const loc = new URL((await callback({ state, code: "ac_1" }, cookie)).headers.get("location") ?? "");
      expect(loc.searchParams.get("ok")).toMatch(/webhook Stripe n'a pas pu être créé.*ne peut pas encore encaisser/);
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeAccountId).toBe("acct_strp_nowh");
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "stripe.webhook_setup_failed", level: "error" } })).toBe(1);
    });

    it("callback: refuses a state without this browser's nonce, a forged one, and reports a refusal", async () => {
      const store = await makeStore();
      const { state, cookie } = await start(store.id);
      for (const [q, c] of [
        [{ state, code: "c" }, null],
        [{ state, code: "c" }, "not-the-nonce"],
        [{ state: `${state}x`, code: "c" }, cookie],
      ] as const) {
        // Back on that store's Stripe page with what to do (an admin: checked first).
        const loc = new URL((await callback(q, c)).headers.get("location") ?? "");
        expect(loc.pathname).toBe(`/dashboard/stores/${store.id}/stripe`);
        expect(loc.searchParams.get("error")).toMatch(/Lien de connexion Stripe expiré ou ouvert dans un autre onglet/);
      }
      expect((await callback({ state: "garbage", code: "c" }, cookie)).headers.get("location")).toBe(`${APP}/dashboard`);
      expect(stripeApi.exchangeCode).not.toHaveBeenCalled();
      const denied = new URL((await callback({ state, error: "access_denied" }, cookie)).headers.get("location") ?? "");
      expect(denied.searchParams.get("error")).toBe("Connexion Stripe annulée.");
      auth.admin = null;
      expect((await callback({ state, code: "c" }, cookie)).headers.get("location")).toBe(`${APP}/login`);
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeAccountId).toBeNull();
    });

    it("callback: a mode switched during the round trip is refused; an exchange error is shown", async () => {
      const store = await makeStore();
      const { state, cookie } = await start(store.id);
      await db.store.update({ where: { id: store.id }, data: { testMode: false } });
      const switched = new URL((await callback({ state, code: "c" }, cookie)).headers.get("location") ?? "");
      expect(switched.searchParams.get("error")).toMatch(/mode test \/ production/);
      await db.store.update({ where: { id: store.id }, data: { testMode: true } });
      stripeApi.exchangeCode.mockRejectedValue(new Error("Authorization code expired"));
      const failed = new URL((await callback({ state, code: "c" }, cookie)).headers.get("location") ?? "");
      expect(failed.searchParams.get("error")).toMatch(/Connexion Stripe impossible : Authorization code expired/);
    });
  });

  describe("dashboard actions", () => {
    it("savePaymentModeAction: Stripe modes need Stripe connected; an unknown mode is refused", async () => {
      const store = await makeStore();
      const fd = (mode: string) => {
        const f = new FormData();
        f.set("paymentMode", mode);
        return f;
      };
      const refused = await flashOf(() => actions.savePaymentModeAction(store.id, fd("stripe_only")));
      expect(refused.error).toMatch(/Connectez d'abord Stripe/);
      expect(refused.field).toBe("paymentMode");
      expect((await flashOf(() => actions.savePaymentModeAction(store.id, fd("stripe_primary")))).error).toMatch(/Connectez d'abord Stripe/);
      expect((await flashOf(() => actions.savePaymentModeAction(store.id, fd("everything")))).error).toMatch(/inconnu/);
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).paymentMode).toBe("whop_primary");

      await db.store.update({ where: { id: store.id }, data: { stripeAccountId: `acct_strp_${rnd()}`, stripeConnectedAt: new Date(), stripeLivemode: false, providerFailoverAt: new Date() } });
      const ok = await flashOf(() => actions.savePaymentModeAction(store.id, fd("stripe_only")));
      expect(ok.ok).toMatch(/Stripe uniquement/);
      const after = await db.store.findUniqueOrThrow({ where: { id: store.id } });
      expect(after.paymentMode).toBe("stripe_only");
      expect(after.providerFailoverAt).toBeNull();
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "payment_mode.changed" } })).toBe(1);
    });

    it("disconnectStripeAction: revokes, forgets the account, resets the mode, journals", async () => {
      const acct = `acct_strp_${rnd()}`;
      const store = await makeStore({ stripeAccountId: acct, stripeAccountName: "Boutique S", stripeConnectedAt: new Date(), stripeLivemode: false, paymentMode: "stripe_primary" });
      const res = await flashOf(() => actions.disconnectStripeAction(store.id));
      expect(res.ok).toBe("Stripe déconnecté.");
      expect(stripeApi.deauthorize).toHaveBeenCalledWith(acct, "test");
      const after = await db.store.findUniqueOrThrow({ where: { id: store.id } });
      expect(after).toMatchObject({ stripeAccountId: null, stripeAccountName: null, stripeConnectedAt: null, stripeLivemode: null, paymentMode: "whop_primary", enabled: true });
      const ev = await db.eventLog.findFirst({ where: { storeId: store.id, kind: "stripe.disconnected" } });
      expect(ev?.message).toMatch(/Whop principal/);
    });

    it("disconnectStripeAction: an account shared with another store is not revoked; a Stripe-only store without Whop stops intercepting", async () => {
      const acct = `acct_strp_${rnd()}`;
      const a = await makeStore({ stripeAccountId: acct, stripeConnectedAt: new Date(), stripeLivemode: false, paymentMode: "stripe_only", whopConnectedAt: null, whopApiKey: null });
      await makeStore({ stripeAccountId: acct, stripeConnectedAt: new Date(), stripeLivemode: false });
      await flashOf(() => actions.disconnectStripeAction(a.id));
      expect(stripeApi.deauthorize).not.toHaveBeenCalled();
      const after = await db.store.findUniqueOrThrow({ where: { id: a.id } });
      expect(after.enabled).toBe(false);
      expect(after.paymentMode).toBe("whop_primary");
    });
  });

  describe("Connect webhook", () => {
    it("account.application.deauthorized: the store forgets the account, alerts; a redelivery is a duplicate", async () => {
      const acct = `acct_strp_${rnd()}`;
      const store = await makeStore({ stripeAccountId: acct, stripeAccountName: "Boutique D", stripeConnectedAt: new Date(), stripeLivemode: false, paymentMode: "stripe_primary" });
      const id = `evt_strp_${rnd()}`;
      const res = await webhookRoute.POST(signedEvent({ id, type: "account.application.deauthorized", account: acct, data: { object: { id: "ca_test_strp", object: "application" } } }), ctx);
      expect(res.status).toBe(200);
      const after = await db.store.findUniqueOrThrow({ where: { id: store.id } });
      expect(after).toMatchObject({ stripeAccountId: null, paymentMode: "whop_primary" });
      const ev = await db.eventLog.findFirst({ where: { storeId: store.id, kind: "stripe.deauthorized" } });
      expect(ev?.level).toBe("error");
      // The alert goes out after the answer (deferred like the Whop webhook's).
      await vi.waitFor(() => expect(notify.sendAlert).toHaveBeenCalled());
      const row = await db.webhookEvent.findUnique({ where: { storeId_id: { storeId: store.id, id: `stripe:${id}` } } });
      expect(row?.processedAt).toBeInstanceOf(Date);
      // Redelivered after the store forgot the account: no store has it any more, acknowledged.
      const again = await webhookRoute.POST(signedEvent({ id, type: "account.application.deauthorized", account: acct }), ctx);
      expect(again.status).toBe(200);
    });

    it("a test-mode revocation leaves a live connection in place", async () => {
      const acct = `acct_strp_${rnd()}`;
      const store = await makeStore({ stripeAccountId: acct, stripeConnectedAt: new Date(), stripeLivemode: true });
      const res = await webhookRoute.POST(signedEvent({ id: `evt_strp_${rnd()}`, type: "account.application.deauthorized", account: acct, livemode: false }), ctx);
      expect(res.status).toBe(200);
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeAccountId).toBe(acct);
    });

    it("other events are acknowledged and claimed once per store (duplicate on redelivery)", async () => {
      const acct = `acct_strp_${rnd()}`;
      const a = await makeStore({ stripeAccountId: acct, stripeConnectedAt: new Date(), stripeLivemode: false });
      const b = await makeStore({ stripeAccountId: acct, stripeConnectedAt: new Date(), stripeLivemode: false });
      const id = `evt_strp_${rnd()}`;
      const evt = { id, type: "payment_intent.succeeded", account: acct, data: { object: { id: "pi_1", object: "payment_intent" } } };
      expect((await webhookRoute.POST(signedEvent(evt), ctx)).status).toBe(200);
      const rows = await db.webhookEvent.findMany({ where: { id: `stripe:${id}` } });
      expect(rows.map((r) => r.storeId).sort()).toEqual([a.id, b.id].sort());
      expect(rows.every((r) => r.processedAt)).toBe(true);
      const dup = await webhookRoute.POST(signedEvent(evt), ctx);
      expect(dup.status).toBe(200);
      expect(await db.webhookEvent.count({ where: { id: `stripe:${id}` } })).toBe(2);
      // Never replayed by the Whop handler.
      const { replayStaleEvents } = await import("@/lib/webhooks");
      await db.webhookEvent.updateMany({ where: { id: `stripe:${id}` }, data: { processedAt: null, receivedAt: new Date(Date.now() - 3600_000) } });
      await replayStaleEvents(Date.now() + 20_000);
      expect(await db.webhookEvent.count({ where: { id: `stripe:${id}`, processedAt: null } })).toBe(2);
    });

    it("an unknown account is acknowledged and journaled once; a bad signature is refused", async () => {
      const acct = `acct_strp_unknown_${rnd()}`;
      settings.push(`stripe:unknown-account:${acct}`);
      for (let i = 0; i < 2; i++) {
        const res = await webhookRoute.POST(signedEvent({ id: `evt_strp_${rnd()}`, type: "charge.refunded", account: acct }), ctx);
        expect(res.status).toBe(200);
      }
      const lines = await db.eventLog.findMany({ where: { storeId: null, kind: "stripe.unknown_account", message: { contains: acct } } });
      expect(lines).toHaveLength(1);
      await db.eventLog.deleteMany({ where: { id: { in: lines.map((l) => l.id) } } });

      const payload = JSON.stringify({ id: "evt_x", object: "event", type: "charge.refunded", account: acct });
      const forged = Stripe.webhooks.generateTestHeaderString({ payload, secret: "whsec_other" });
      const bad = await webhookRoute.POST(new Request(`${APP}/api/webhooks/stripe`, { method: "POST", headers: { "stripe-signature": forged }, body: payload }), ctx);
      expect(bad.status).toBe(400);
      const none = await webhookRoute.POST(new Request(`${APP}/api/webhooks/stripe`, { method: "POST", body: payload }), ctx);
      expect(none.status).toBe(400);
    });
  });

  describe("connection lifecycle", async () => {
    const { rememberPastStripeAccount, pastStripeAccounts } = await import("@/lib/stripe-connection");
    const testCheckoutRoute = await import("@/app/api/stripe/test-checkout/route");

    it("a revocation older than the current connection is ignored (stale redelivery / replay)", async () => {
      const acct = `acct_strp_${rnd()}`;
      const store = await makeStore({ stripeAccountId: acct, stripeConnectedAt: new Date(), stripeLivemode: false });
      const res = await webhookRoute.POST(
        signedEvent({ id: `evt_strp_${rnd()}`, type: "account.application.deauthorized", account: acct, created: Math.floor(Date.now() / 1000) - 3600 }),
        ctx,
      );
      expect(res.status).toBe(200);
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeAccountId).toBe(acct);
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "stripe.deauthorized" } })).toBe(0);
    });

    it("events of a past account still reach the store; its revocation leaves the current connection", async () => {
      const old = `acct_strp_old_${rnd()}`;
      const cur = `acct_strp_new_${rnd()}`;
      const store = await makeStore({ stripeAccountId: cur, stripeConnectedAt: new Date(Date.now() - 60_000), stripeLivemode: false });
      await rememberPastStripeAccount(store.id, old, false);
      const id = `evt_strp_${rnd()}`;
      expect((await webhookRoute.POST(signedEvent({ id, type: "account.application.deauthorized", account: old }), ctx)).status).toBe(200);
      // Mapped to the store (claimed there), not an unknown account.
      expect(await db.webhookEvent.count({ where: { storeId: store.id, id: `stripe:${id}` } })).toBe(1);
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeAccountId).toBe(cur);
      expect(await pastStripeAccounts(store.id)).toEqual([expect.objectContaining({ id: old, revoked: true })]);
    });

    it("the revocation of an account no store has is not journaled", async () => {
      const acct = `acct_strp_gone_${rnd()}`;
      settings.push(`stripe:unknown-account:${acct}`);
      expect((await webhookRoute.POST(signedEvent({ id: `evt_strp_${rnd()}`, type: "account.application.deauthorized", account: acct }), ctx)).status).toBe(200);
      expect(await db.eventLog.count({ where: { storeId: null, kind: "stripe.unknown_account", message: { contains: acct } } })).toBe(0);
    });

    it("account.updated: charges turned off makes Stripe unusable, journaled and alerted once; back on is journaled", async () => {
      const acct = `acct_strp_${rnd()}`;
      const store = await makeStore({ stripeAccountId: acct, stripeAccountName: "Compte C", stripeConnectedAt: new Date(), stripeLivemode: false, stripeChargesEnabled: true });
      const updated = (charges: boolean) => signedEvent({ id: `evt_strp_${rnd()}`, type: "account.updated", account: acct, data: { object: { id: acct, object: "account", charges_enabled: charges } } });
      expect((await webhookRoute.POST(updated(false), ctx)).status).toBe(200);
      expect((await webhookRoute.POST(updated(false), ctx)).status).toBe(200);
      const off = await db.store.findUniqueOrThrow({ where: { id: store.id } });
      expect(off.stripeChargesEnabled).toBe(false);
      const { providerConnected } = await import("@/lib/payment-provider");
      expect(providerConnected(off, "stripe")).toBe(false);
      const lines = await db.eventLog.findMany({ where: { storeId: store.id, kind: "stripe.charges_disabled" } });
      expect(lines).toHaveLength(1);
      expect(lines[0].level).toBe("error");
      await vi.waitFor(() => expect(notify.sendAlert).toHaveBeenCalled());
      expect((await webhookRoute.POST(updated(true), ctx)).status).toBe(200);
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeChargesEnabled).toBe(true);
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "stripe.charges_enabled" } })).toBe(1);
    });

    it("disconnect: refused while a Stripe payment is in flight, unless « Déconnecter quand même »; the account stays mapped", async () => {
      const acct = `acct_strp_${rnd()}`;
      const store = await makeStore({ stripeAccountId: acct, stripeConnectedAt: new Date(), stripeLivemode: false });
      await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [], subtotalCents: 100, status: "PAYING", paymentProvider: "stripe" } });
      const refused = await flashOf(() => actions.disconnectStripeAction(store.id, new FormData()));
      expect(refused.error).toMatch(/Déconnexion refusée : 1 paiement Stripe en cours/);
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeAccountId).toBe(acct);
      const force = new FormData();
      force.set("force", "on");
      expect((await flashOf(() => actions.disconnectStripeAction(store.id, force))).ok).toBe("Stripe déconnecté.");
      expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).stripeAccountId).toBeNull();
      expect(stripeApi.deauthorize).toHaveBeenCalledWith(acct, "test");
      expect(await pastStripeAccounts(store.id)).toEqual([expect.objectContaining({ id: acct, revoked: true })]);
      expect((await db.eventLog.findFirst({ where: { storeId: store.id, kind: "stripe.disconnected" } }))?.message).toMatch(/malgré l'avertissement/);
    });

    it("a refund goes to the account the payment was made on", async () => {
      const store = await makeStore({ stripeAccountId: `acct_strp_new_${rnd()}`, stripeConnectedAt: new Date(), stripeLivemode: false });
      const session = await db.checkoutSession.create({
        data: { storeId: store.id, currency: "EUR", lines: [], subtotalCents: 1000, totalCents: 1000, status: "PAID", paidAt: new Date(), paymentProvider: "stripe", whopPaymentId: `pi_strp_${rnd()}`, stripeAccountId: "acct_strp_old" },
      });
      stripeApi.refundStripe.mockResolvedValue({ id: "re_1" });
      const res = await flashOf(() => actions.refundOrderAction(store.id, session.id, new FormData()));
      expect(res.ok).toMatch(/demandé à Stripe/);
      expect(stripeApi.refundStripe).toHaveBeenCalledWith(expect.objectContaining({ id: store.id, stripeAccountId: "acct_strp_old" }), session.whopPaymentId, undefined, expect.any(String), "EUR");
    });

    it("switching to production with a test-mode Stripe connection: told to reconnect, failover cleared, journaled", async () => {
      const store = await makeStore({ whopConnectedAt: null, whopApiKey: null, stripeAccountId: `acct_strp_${rnd()}`, stripeConnectedAt: new Date(), stripeLivemode: false, providerFailoverAt: new Date() });
      const fd = new FormData();
      fd.set("name", store.name);
      const res = await flashOf(() => actions.saveSettingsAction(store.id, fd));
      expect(res.path).toBe(`/dashboard/stores/${store.id}/stripe`);
      // The switch as a success, what's left to do on Stripe as an error.
      expect(res.ok).toBe("Mode production activé.");
      expect(res.error).toMatch(/Reconnectez Stripe en production/);
      const after = await db.store.findUniqueOrThrow({ where: { id: store.id } });
      expect(after).toMatchObject({ testMode: false, providerFailoverAt: null });
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "store.mode_changed", level: "warn" } })).toBe(1);
    });

    it("« Réparer la liaison Stripe »: the webhook is ensured; a failure is shown and journaled", async () => {
      const store = await makeStore({ stripeAccountId: `acct_strp_${rnd()}`, stripeConnectedAt: new Date(), stripeLivemode: false });
      stripeApi.ensureConnectWebhook.mockRejectedValueOnce(new Error("Stripe indisponible"));
      expect((await flashOf(() => actions.repairStripeWebhookAction(store.id))).error).toMatch(/Liaison Stripe non réparée : Stripe indisponible/);
      expect(await db.eventLog.count({ where: { storeId: store.id, kind: "stripe.webhook_setup_failed" } })).toBe(1);
      expect((await flashOf(() => actions.repairStripeWebhookAction(store.id))).ok).toMatch(/webhook est en place/);
      expect(stripeApi.ensureConnectWebhook).toHaveBeenLastCalledWith("test");
    });

    it("« Tester le secours »: Origin checked; the product is re-priced by Shopify; the webhook is ensured", async () => {
      const store = await makeStore({ stripeAccountId: `acct_strp_${rnd()}`, stripeConnectedAt: new Date(), stripeLivemode: false });
      const variant = "gid://shopify/ProductVariant/424242";
      await db.checkoutSession.create({
        data: { storeId: store.id, currency: "EUR", subtotalCents: 1000, lines: [{ variantId: variant, productId: "p", title: "Lampe", unitPriceCents: 500, quantity: 2 }] },
      });
      shopify.priceCart.mockResolvedValue([{ variantId: variant, productId: "p", title: "Lampe", unitPriceCents: 900, quantity: 1 }]);
      const post = (origin: string | null) => {
        const body = new FormData();
        body.set("store", store.id);
        return testCheckoutRoute.POST(new Request(`${APP}/api/stripe/test-checkout`, { method: "POST", body, headers: origin ? { origin } : {} }), ctx);
      };
      expect((await post("::bad origin::")).status).toBe(403);
      expect((await post("https://evil.example")).status).toBe(403);
      const res = await post(APP);
      const loc = new URL(res.headers.get("location") ?? "");
      expect(loc.pathname).toMatch(/^\/c\//);
      const test = await db.checkoutSession.findUniqueOrThrow({ where: { id: loc.pathname.slice(3) } });
      expect(test).toMatchObject({ forcedProvider: "stripe", subtotalCents: 900 });
      expect(shopify.priceCart).toHaveBeenCalledWith(expect.objectContaining({ id: store.id }), [{ variantId: variant, quantity: 1 }]);
      expect(stripeApi.ensureConnectWebhook).toHaveBeenCalledWith("test");
      // Nothing for sale any more: back to the Stripe page with the reason.
      shopify.priceCart.mockResolvedValue([]);
      const none = new URL((await post(APP)).headers.get("location") ?? "");
      expect(none.pathname).toBe(`/dashboard/stores/${store.id}/stripe`);
      expect(none.searchParams.get("error")).toMatch(/Aucun produit récent encore en vente/);
    });

    it("two tabs connecting two stores keep their own nonce cookie", async () => {
      const a = await makeStore();
      const b = await makeStore();
      stripeApi.exchangeCode.mockResolvedValue({ accountId: "acct_strp_tabs", livemode: false, scope: "read_write" });
      stripeApi.retrieveAccount.mockResolvedValue({ id: "acct_strp_tabs", name: "Tabs", email: null, country: "FR", chargesEnabled: true, defaultCurrency: "eur" });
      const sa = await start(a.id);
      const sb = await start(b.id);
      const both = `${stripeNonceCookie(a.id)}=${sa.cookie}; ${stripeNonceCookie(b.id)}=${sb.cookie}`;
      const res = await callbackRoute.GET(new Request(`${APP}/api/stripe/connect/callback?${new URLSearchParams({ state: sa.state, code: "c" })}`, { headers: { cookie: both } }), ctx);
      expect(new URL(res.headers.get("location") ?? "").searchParams.get("ok")).toMatch(/connecté/);
      expect((await db.store.findUniqueOrThrow({ where: { id: a.id } })).stripeAccountId).toBe("acct_strp_tabs");
    });
  });
});
