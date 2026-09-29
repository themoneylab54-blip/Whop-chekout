import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

/*
 * ensureConnectWebhook against a real Postgres (its stored endpoint and its claim row are AppSettings),
 * Stripe's webhook endpoint API stubbed on the platform client: created once even when two
 * connections race, the endpoint of a previous APP_URL deleted, a hand-made endpoint (env secret)
 * never created nor deleted, a crashed run's claim taken over. Test data: stripe:webhook*:test.
 */

const hasDb = !!process.env.DATABASE_URL;
const APP = "https://checkout.example.com";
const URL_NOW = `${APP}/api/webhooks/stripe`;
const KEYS = { STRIPE_TEST_SECRET_KEY: "sk_test_wep", STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_wep", STRIPE_TEST_CLIENT_ID: "ca_test_wep" };

describe.skipIf(!hasDb)("ensureConnectWebhook (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const stripe = await import("@/lib/stripe");
  const saved: Record<string, string | undefined> = {};
  const settingKeys = ["stripe:webhook:test", "stripe:webhook-lock:test"];

  let client: Stripe;
  const api = {
    list: vi.fn(),
    retrieve: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    del: vi.fn(),
  };
  const endpoint = (over: Partial<Stripe.WebhookEndpoint> = {}) =>
    ({ id: "we_now", url: URL_NOW, status: "enabled", enabled_events: [...stripe.STRIPE_WEBHOOK_EVENTS], ...over }) as Stripe.WebhookEndpoint;

  beforeAll(() => {
    for (const [k, v] of Object.entries({ ...KEYS, STRIPE_TEST_WEBHOOK_SECRET: undefined })) {
      saved[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    client = stripe.stripeClient("test");
    for (const [name, fn] of Object.entries(api)) vi.spyOn(client.webhookEndpoints, name as keyof typeof api).mockImplementation(fn as never);
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.STRIPE_TEST_WEBHOOK_SECRET;
    await db.appSetting.deleteMany({ where: { key: { in: settingKeys } } });
    api.list.mockResolvedValue({ data: [] });
    api.update.mockImplementation(async (id: string) => endpoint({ id }));
    api.del.mockResolvedValue({ deleted: true });
  });

  afterEach(async () => {
    await db.appSetting.deleteMany({ where: { key: { in: settingKeys } } });
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await db.$disconnect();
  });

  it("two connections at once create ONE endpoint; the second reuses it", async () => {
    api.create.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return endpoint({ secret: "whsec_new" });
    });
    api.retrieve.mockResolvedValue(endpoint());
    const [a, b] = await Promise.all([stripe.ensureConnectWebhook("test"), stripe.ensureConnectWebhook("test")]);
    expect(api.create).toHaveBeenCalledTimes(1);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await stripe.stripeWebhookStatus("test")).toMatchObject({ stored: true, manual: false });
    // The claim row is released.
    expect(await db.appSetting.findUnique({ where: { key: "stripe:webhook-lock:test" } })).toBeNull();
  });

  it("an endpoint missing an event (account.updated added) is completed, not re-created", async () => {
    await db.appSetting.create({ data: { key: "stripe:webhook:test", value: JSON.stringify({ id: "we_now", url: URL_NOW, secret: encrypt("whsec_x") }) } });
    api.retrieve.mockResolvedValue(endpoint({ enabled_events: stripe.STRIPE_WEBHOOK_EVENTS.filter((e) => e !== "account.updated") }));
    expect(await stripe.ensureConnectWebhook("test")).toEqual({ id: "we_now", created: false });
    expect(api.update).toHaveBeenCalledWith("we_now", expect.objectContaining({ enabled_events: expect.arrayContaining(["account.updated"]), disabled: false }));
    expect(api.create).not.toHaveBeenCalled();
  });

  it("APP_URL changed: the old endpoint is deleted and a new one stored", async () => {
    await db.appSetting.create({ data: { key: "stripe:webhook:test", value: JSON.stringify({ id: "we_old", url: "https://old.example.com/api/webhooks/stripe", secret: encrypt("whsec_old") }) } });
    api.create.mockResolvedValue(endpoint({ id: "we_new", secret: "whsec_new" }));
    expect(await stripe.ensureConnectWebhook("test")).toEqual({ id: "we_new", created: true });
    expect(api.del).toHaveBeenCalledWith("we_old");
    const row = await db.appSetting.findUniqueOrThrow({ where: { key: "stripe:webhook:test" } });
    expect(JSON.parse(row.value)).toMatchObject({ id: "we_new", url: URL_NOW });
  });

  it("hand-made mode (env secret): only checked and completed, never created nor deleted", async () => {
    process.env.STRIPE_TEST_WEBHOOK_SECRET = "whsec_by_hand";
    await expect(stripe.ensureConnectWebhook("test")).rejects.toThrow(/aucun webhook Stripe.*STRIPE_TEST_WEBHOOK_SECRET/);
    api.list.mockResolvedValue({ data: [endpoint({ id: "we_hand", enabled_events: ["payment_intent.succeeded"] })] });
    expect(await stripe.ensureConnectWebhook("test")).toEqual({ id: "we_hand", created: false, manual: true });
    expect(api.update).toHaveBeenCalledWith("we_hand", expect.objectContaining({ enabled_events: expect.arrayContaining([...stripe.STRIPE_WEBHOOK_EVENTS]) }));
    expect(api.create).not.toHaveBeenCalled();
    expect(api.del).not.toHaveBeenCalled();
    expect(await stripe.stripeWebhookStatus("test")).toMatchObject({ manual: true });
  });

  it("a crashed run's expired claim is taken over", async () => {
    await db.appSetting.create({ data: { key: "stripe:webhook-lock:test", value: `${Date.now() - 1000}:dead` } });
    api.create.mockResolvedValue(endpoint({ secret: "whsec_new" }));
    expect((await stripe.ensureConnectWebhook("test")).created).toBe(true);
  });

  it("a run's claim lasts about two minutes (a slow live run is not taken over as crashed)", async () => {
    let expiry = 0;
    api.create.mockImplementation(async () => {
      const row = await db.appSetting.findUniqueOrThrow({ where: { key: "stripe:webhook-lock:test" } });
      expiry = Number(row.value.split(":")[0]);
      return endpoint({ secret: "whsec_new" });
    });
    const before = Date.now();
    await stripe.ensureConnectWebhook("test");
    expect(expiry - before).toBeGreaterThanOrEqual(115_000);
    expect(expiry - before).toBeLessThanOrEqual(125_000);
  });

  it("hand-made mode: the page's check says whether the endpoint really exists in Stripe", async () => {
    process.env.STRIPE_TEST_WEBHOOK_SECRET = "whsec_by_hand";
    // Not checked (health): unknown.
    expect(await stripe.stripeWebhookStatus("test")).toMatchObject({ manual: true, manualFound: null });
    api.list.mockResolvedValue({ data: [] });
    expect(await stripe.stripeWebhookStatus("test", { timeout: 1000 })).toMatchObject({ manual: true, manualFound: false });
    api.list.mockResolvedValue({ data: [endpoint({ id: "we_hand", status: "disabled" })] });
    expect((await stripe.stripeWebhookStatus("test", { timeout: 1000 })).manualFound).toBe(false);
    api.list.mockResolvedValue({ data: [endpoint({ id: "we_hand" })] });
    expect((await stripe.stripeWebhookStatus("test", { timeout: 1000 })).manualFound).toBe(true);
    api.list.mockRejectedValue(new Error("timeout"));
    expect((await stripe.stripeWebhookStatus("test", { timeout: 1000 })).manualFound).toBeNull();
  });
});
