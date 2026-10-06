import { createHmac } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Shopify reconnection against a real Postgres, Shopify mocked (fetch): the form only writes
 * « pending » credentials; the OAuth callback verifies the signature with the pending secret (or the
 * active one of the same app), and only a successful token exchange promotes them. A failed attempt
 * leaves the active connection (credentials, token, script, checkout) untouched. And the
 * APP_UNINSTALLED webhook: signed, idempotent, disconnects and disables the checkout. Test data: shr_.
 */

const hasDb = !!process.env.DATABASE_URL;

class Redirect extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", async (orig) => ({
  ...(await orig<typeof import("next/headers")>()),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));

/** Where an action redirected to (full URL). */
async function redirectUrl(run: () => Promise<unknown>): Promise<URL> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Redirect)) throw err;
    return new URL(err.url, "http://x");
  }
  throw new Error("no redirect");
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

/** Shopify's signature of an OAuth redirect (hex HMAC of the sorted query, hmac excluded). */
function signedQuery(params: Record<string, string>, secret: string): URLSearchParams {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return new URLSearchParams({ ...params, hmac: createHmac("sha256", secret).update(message).digest("hex") });
}

const SECRET_A = `shpss_${"a".repeat(32)}`;
const SECRET_B = `shpss_${"b".repeat(32)}`;
const WRONG = "MonMotDePasseDashboard!";

describe.skipIf(!hasDb)("Shopify reconnection (integration)", async () => {
  const { db } = await import("@/lib/db");
  const auth = await import("@/lib/auth");
  const { encrypt, decrypt } = await import("@/lib/crypto");
  const actions = await import("@/app/dashboard/actions");
  const callback = await import("@/app/api/shopify/callback/route");
  const webhook = await import("@/app/api/webhooks/shopify/route");
  const { shopifyWebhookUrl } = await import("@/lib/shopify");
  const tag = `shr_${Math.random().toString(36).slice(2, 8)}`;
  const stores: string[] = [];
  const users: string[] = [];
  const ctx = { params: Promise.resolve({}) };
  let n = 0;

  /** Shopify, faked: every call recorded; `tokenStatus` answers the code exchange. */
  const shopify = {
    calls: [] as { url: string; body: Record<string, unknown> }[],
    tokenStatus: 200,
    token: "new-token",
    /** Runs while Shopify « exchanges the code » (something happening meanwhile). */
    onExchange: null as null | (() => Promise<void>),
    loaderSrc: "",
  };
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    shopify.calls.push({ url, body });
    const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
    if (url.endsWith("/admin/oauth/access_token")) {
      if (shopify.onExchange) {
        const run = shopify.onExchange;
        shopify.onExchange = null;
        await run();
      }
      if (shopify.tokenStatus !== 200) return new Response("bad", { status: shopify.tokenStatus });
      return new Response(JSON.stringify({ access_token: shopify.token, scope: "read_products,write_orders" }), { status: 200 });
    }
    if (url.includes("/graphql.json")) {
      const q = String(body.query);
      if (q.includes("shop {") && q.includes("currencyCode")) return ok({ shop: { name: "Col&Cie", currencyCode: "EUR", primaryDomain: { host: "colandcie.com" } } });
      if (q.includes("shop { name } scriptTags(")) return ok({ shop: { name: "Col&Cie" }, scriptTags: { nodes: [{ src: shopify.loaderSrc }] } });
      if (q.includes("scriptTagCreate")) return ok({ scriptTagCreate: { scriptTag: { id: "gid://shopify/ScriptTag/NEW" }, userErrors: [] } });
      if (q.includes("scriptTagDelete")) return ok({ scriptTagDelete: { deletedScriptTagId: (body.variables as { id: string }).id, userErrors: [] } });
      if (q.includes("scriptTags(")) return ok({ scriptTags: { nodes: [] } });
      if (q.includes("webhookSubscriptionCreate")) return ok({ webhookSubscriptionCreate: { webhookSubscription: { id: "gid://shopify/WebhookSubscription/1" }, userErrors: [] } });
      if (q.includes("webhookSubscriptions(")) return ok({ webhookSubscriptions: { nodes: [] } });
    }
    return new Response("{}", { status: 200 });
  });

  async function connectedStore(data: Record<string, unknown> = {}) {
    const shop = `${tag.replace("_", "-")}-${n++}.myshopify.com`;
    const s = await db.store.create({
      data: {
        name: `${tag}_store`,
        shopDomain: shop,
        shopifyClientId: "app-a",
        shopifyClientSecret: encrypt(SECRET_A),
        shopifyAccessToken: encrypt("old-token"),
        shopifyScopes: "read_products",
        scriptTagId: "gid://shopify/ScriptTag/OLD",
        storefrontHost: "colandcie.com",
        shopifyConnectedAt: new Date(Date.now() - 86_400_000),
        enabled: true,
        whopConnectedAt: new Date(),
        ...data,
      },
    });
    stores.push(s.id);
    return s;
  }
  const reload = (id: string) => db.store.findUniqueOrThrow({ where: { id } });

  /** The merchant submits the form, then Shopify redirects back signed with `signWith`. */
  async function reconnect(storeId: string, fields: Record<string, string>, signWith: string) {
    const to = await redirectUrl(() => actions.startShopifyInstallAction(storeId, form(fields)));
    expect(to.pathname).toBe("/admin/oauth/authorize");
    const pending = await reload(storeId);
    const query = signedQuery({ code: "the-code", shop: to.hostname, state: to.searchParams.get("state")!, timestamp: "1700000000", host: "aG9zdA" }, signWith);
    const res = await callback.GET(new Request(`https://checkout.example.com/api/shopify/callback?${query}`), ctx);
    const loc = new URL(res.headers.get("location") ?? "");
    return { install: to, pending, loc, error: loc.searchParams.get("error"), connected: loc.searchParams.get("connected"), reason: loc.searchParams.get("reason") };
  }

  let owner = "";
  beforeEach(async () => {
    shopify.calls = [];
    shopify.tokenStatus = 200;
    shopify.onExchange = null;
    vi.stubGlobal("fetch", fetchMock);
    if (!owner) {
      const u = await db.adminUser.create({ data: { email: `${tag}_owner@test.local`, passwordHash: null, role: "owner" } });
      users.push(u.id);
      owner = u.id;
    }
    jar.clear();
    expect(await auth.signIn(owner)).toBe(true);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.eventLog.deleteMany({ where: { storeId: { in: stores } } });
    await db.alertOutbox.deleteMany({ where: { storeId: { in: stores } } });
    await db.fallbackPeriod.deleteMany({ where: { storeId: { in: stores } } });
    await db.appSetting.deleteMany({ where: { OR: [...stores.map((id) => ({ key: { contains: id } })), { key: { startsWith: `shopify:webhook-id:${tag}` } }] } });
    await db.store.deleteMany({ where: { id: { in: stores } } });
    await db.adminUser.deleteMany({ where: { id: { in: users } } });
  });

  it("a failed reconnect (secret of another app) leaves the active credentials and connection intact", async () => {
    const s = await connectedStore();
    // The form typed app-b with a wrong secret (e.g. the browser's saved password); Shopify signs with app-b's real one.
    const r = await reconnect(s.id, { shopDomain: s.shopDomain!, clientId: "app-b", clientSecret: WRONG }, SECRET_B);
    // Before Shopify answered: only the pending columns changed, the install URL uses the pending Client ID.
    expect(r.install.searchParams.get("client_id")).toBe("app-b");
    expect(r.pending).toMatchObject({ shopifyClientId: "app-a", shopifyPendingClientId: "app-b", shopifyPendingShopDomain: s.shopDomain, shopifyAccessToken: s.shopifyAccessToken });
    expect(decrypt(r.pending.shopifyClientSecret!)).toBe(SECRET_A);
    expect(decrypt(r.pending.shopifyPendingClientSecret!)).toBe(WRONG);

    expect(r.reason).toBe("hmac");
    expect(r.error).toBe(
      "Le Client secret ne correspond pas au Client ID : copiez les deux depuis la même app Shopify (Dev Dashboard → votre app → Settings). Votre connexion actuelle n'a pas été modifiée.",
    );
    const after = await reload(s.id);
    expect(after).toMatchObject({
      shopDomain: s.shopDomain,
      shopifyClientId: "app-a",
      shopifyAccessToken: s.shopifyAccessToken,
      scriptTagId: "gid://shopify/ScriptTag/OLD",
      shopifyConnectedAt: s.shopifyConnectedAt,
      enabled: true,
      shopifyPendingClientId: null,
      shopifyPendingClientSecret: null,
      shopifyPendingShopDomain: null,
      shopifyPendingAt: null,
      shopifyOauthState: null,
    });
    expect(decrypt(after.shopifyClientSecret!)).toBe(SECRET_A);
    // Nothing was asked to Shopify (no exchange, no script removal).
    expect(shopify.calls).toEqual([]);
  });

  it("a refused token exchange also leaves the connection intact", async () => {
    const s = await connectedStore();
    shopify.tokenStatus = 400;
    const r = await reconnect(s.id, { shopDomain: s.shopDomain!, clientId: "app-b", clientSecret: SECRET_B }, SECRET_B);
    expect(r.error).toMatch(/^Shopify a refusé l'autorisation.*Votre connexion actuelle n'a pas été modifiée\.$/);
    const after = await reload(s.id);
    expect(after).toMatchObject({ shopifyClientId: "app-a", shopifyAccessToken: s.shopifyAccessToken, scriptTagId: "gid://shopify/ScriptTag/OLD", enabled: true, shopifyPendingClientId: null });
  });

  it("a successful reconnect with a new app verifies the pending secret, then promotes it", async () => {
    const s = await connectedStore();
    const r = await reconnect(s.id, { shopDomain: s.shopDomain!, clientId: "app-b", clientSecret: SECRET_B }, SECRET_B);
    expect(r.error).toBeNull();
    expect(r.connected).toBe("1");
    const exchange = shopify.calls.find((c) => c.url.endsWith("/admin/oauth/access_token"))!;
    expect(exchange.body).toMatchObject({ client_id: "app-b", client_secret: SECRET_B, code: "the-code" });
    const after = await reload(s.id);
    expect(after).toMatchObject({ shopifyClientId: "app-b", scriptTagId: "gid://shopify/ScriptTag/NEW", enabled: true, shopifyPendingClientId: null, shopifyPendingClientSecret: null, shopifyOauthState: null });
    expect(decrypt(after.shopifyClientSecret!)).toBe(SECRET_B);
    expect(decrypt(after.shopifyAccessToken!)).toBe("new-token");
    expect(after.shopifyConnectedAt!.getTime()).toBeGreaterThan(s.shopifyConnectedAt!.getTime());
    // The old app's script tag is removed (the new app cannot see it), and APP_UNINSTALLED is subscribed.
    expect(shopify.calls.some((c) => String(c.body.query).includes("scriptTagDelete") && (c.body.variables as { id: string }).id === "gid://shopify/ScriptTag/OLD")).toBe(true);
    const sub = shopify.calls.find((c) => String(c.body.query).includes("webhookSubscriptionCreate"))!;
    expect(sub.body.variables).toEqual({ sub: { uri: shopifyWebhookUrl(), format: "JSON" } });
  });

  it("same-app reconnect with an empty secret field reuses the stored secret", async () => {
    const s = await connectedStore();
    const r = await reconnect(s.id, { shopDomain: s.shopDomain!, clientId: "app-a", clientSecret: "" }, SECRET_A);
    expect(decrypt(r.pending.shopifyPendingClientSecret!)).toBe(SECRET_A);
    expect(r.error).toBeNull();
    const after = await reload(s.id);
    expect(after).toMatchObject({ shopifyClientId: "app-a", shopifyPendingClientId: null });
    expect(decrypt(after.shopifyClientSecret!)).toBe(SECRET_A);
    expect(decrypt(after.shopifyAccessToken!)).toBe("new-token");
    // Same app: its script tag is reused, not deleted.
    expect(shopify.calls.some((c) => String(c.body.query).includes("scriptTagDelete"))).toBe(false);
  });

  it("same app with a mistyped new secret: Shopify's signature by the active secret is accepted, the active secret kept", async () => {
    const s = await connectedStore();
    const r = await reconnect(s.id, { shopDomain: s.shopDomain!, clientId: "app-a", clientSecret: WRONG }, SECRET_A);
    expect(r.error).toBeNull();
    const after = await reload(s.id);
    expect(decrypt(after.shopifyClientSecret!)).toBe(SECRET_A);
    expect(shopify.calls.find((c) => c.url.endsWith("/admin/oauth/access_token"))!.body).toMatchObject({ client_secret: SECRET_A });
  });

  it("a new Client ID with an empty secret is refused before Shopify; a too short secret too", async () => {
    const s = await connectedStore();
    const a = await redirectUrl(() => actions.startShopifyInstallAction(s.id, form({ shopDomain: s.shopDomain!, clientId: "app-c", clientSecret: "" })));
    expect(a.searchParams.get("error")).toMatch(/^Nouveau Client ID : collez aussi le Client secret/);
    const b = await redirectUrl(() => actions.startShopifyInstallAction(s.id, form({ shopDomain: s.shopDomain!, clientId: "app-c", clientSecret: "motdepasse" })));
    expect(b.searchParams.get("error")).toMatch(/^Ce n'est pas un Client secret Shopify/);
    expect(await reload(s.id)).toMatchObject({ shopifyPendingClientId: null, shopifyClientId: "app-a" });
  });

  it("the storefront domain typed in the form uses the known .myshopify.com address", async () => {
    const s = await connectedStore();
    const to = await redirectUrl(() => actions.startShopifyInstallAction(s.id, form({ shopDomain: "colandcie.com", clientId: "app-a", clientSecret: "" })));
    expect(to.hostname).toBe(s.shopDomain);
    const fresh = await connectedStore({ shopDomain: null, shopifyConnectedAt: null, shopifyAccessToken: null, storefrontHost: null });
    const err = await redirectUrl(() => actions.startShopifyInstallAction(fresh.id, form({ shopDomain: "colandcie.com", clientId: "app-a", clientSecret: SECRET_A })));
    expect(err.searchParams.get("error")).toMatch(/colandcie\.com est le domaine de votre vitrine/);
  });

  it("first connection: the shop is only recorded once Shopify approved", async () => {
    const s = await connectedStore({ shopDomain: null, shopifyClientId: null, shopifyClientSecret: null, shopifyAccessToken: null, scriptTagId: null, shopifyConnectedAt: null, enabled: false });
    const shop = `${tag.replace("_", "-")}-first.myshopify.com`;
    const to = await redirectUrl(() => actions.startShopifyInstallAction(s.id, form({ shopDomain: shop, clientId: "app-a", clientSecret: SECRET_A })));
    expect(await reload(s.id)).toMatchObject({ shopDomain: null, shopifyPendingShopDomain: shop });
    const query = signedQuery({ code: "c", shop, state: to.searchParams.get("state")!, timestamp: "1" }, SECRET_A);
    const res = await callback.GET(new Request(`https://checkout.example.com/api/shopify/callback?${query}`), ctx);
    expect(new URL(res.headers.get("location")!).searchParams.get("connected")).toBe("1");
    expect(await reload(s.id)).toMatchObject({ shopDomain: shop, shopifyClientId: "app-a", storefrontHost: "colandcie.com", shopifyPendingShopDomain: null });
  });

  describe("APP_UNINSTALLED webhook", () => {
    let wid = 0;
    const deliver = (
      shop: string,
      secret: string,
      opts: { body?: string; triggeredAt?: string | null; webhookId?: string; ip?: string } = {},
    ) => {
      const body = opts.body ?? JSON.stringify({ id: 1, myshopify_domain: shop, domain: "colandcie.com" });
      const headers: Record<string, string> = {
        "x-shopify-topic": "app/uninstalled",
        "x-shopify-shop-domain": shop,
        "x-shopify-webhook-id": opts.webhookId ?? `${tag}-wh-${wid++}`,
        "x-shopify-hmac-sha256": createHmac("sha256", secret).update(body).digest("base64"),
        "x-real-ip": opts.ip ?? "1.2.3.4",
      };
      if (opts.triggeredAt !== null) headers["x-shopify-triggered-at"] = opts.triggeredAt ?? new Date().toISOString();
      return webhook.POST(new Request(shopifyWebhookUrl(), { method: "POST", body, headers }), ctx);
    };

    it("valid signature: disconnects, disables the checkout, journals and alerts; a redelivery changes nothing", async () => {
      const s = await connectedStore();
      const res = await deliver(s.shopDomain!, SECRET_A, { webhookId: `${tag}-same` });
      expect(res.status).toBe(200);
      const after = await reload(s.id);
      expect(after).toMatchObject({ shopifyAccessToken: null, scriptTagId: null, shopifyConnectedAt: null, enabled: false, shopDomain: s.shopDomain, shopifyClientId: "app-a" });
      // The credentials stay: reconnecting the same app needs no secret again.
      expect(decrypt(after.shopifyClientSecret!)).toBe(SECRET_A);
      const events = await db.eventLog.findMany({ where: { storeId: s.id, kind: "shopify.app_uninstalled" } });
      expect(events).toHaveLength(1);
      expect(events[0].message).toMatch(/L'app Shopify a été désinstallée.*le checkout est désactivé.*le checkout sera réactivé automatiquement\.$/);
      expect(await db.fallbackPeriod.count({ where: { storeId: s.id, kind: "disabled", endedAt: null } })).toBe(1);

      // Same webhook id, even after the token came back: deduplicated.
      await db.store.update({ where: { id: s.id }, data: { shopifyAccessToken: s.shopifyAccessToken } });
      const again = await deliver(s.shopDomain!, SECRET_A, { webhookId: `${tag}-same` });
      expect(await again.json()).toMatchObject({ duplicate: true });
      expect((await reload(s.id)).shopifyAccessToken).toBe(s.shopifyAccessToken);
      // Another delivery id once the token is gone: nothing to do either.
      await db.store.update({ where: { id: s.id }, data: { shopifyAccessToken: null } });
      expect(await (await deliver(s.shopDomain!, SECRET_A)).json()).toMatchObject({ duplicate: true });
      expect(await db.eventLog.count({ where: { storeId: s.id, kind: "shopify.app_uninstalled" } })).toBe(1);
    });

    it("after an uninstall, a successful reconnect switches the checkout back on", async () => {
      const s = await connectedStore();
      await deliver(s.shopDomain!, SECRET_A);
      expect((await reload(s.id)).enabled).toBe(false);
      const r = await reconnect(s.id, { shopDomain: s.shopDomain!, clientId: "app-a", clientSecret: "" }, SECRET_A);
      expect(r.error).toBeNull();
      expect(r.loc.searchParams.get("reenabled")).toBe("1");
      expect(await reload(s.id)).toMatchObject({ enabled: true, scriptTagId: "gid://shopify/ScriptTag/NEW" });
      expect(await db.fallbackPeriod.count({ where: { storeId: s.id, kind: "disabled", endedAt: null } })).toBe(0);
      expect(await db.appSetting.count({ where: { key: `shopify:disabled-by-uninstall:${s.id}` } })).toBe(0);
    });

    it("…but not when the merchant toggled the checkout in between, nor when it was off already", async () => {
      const s = await connectedStore();
      await deliver(s.shopDomain!, SECRET_A);
      await redirectUrl(() => actions.setEnabledAction(s.id, false));
      const r = await reconnect(s.id, { shopDomain: s.shopDomain!, clientId: "app-a", clientSecret: "" }, SECRET_A);
      expect(r.error).toBeNull();
      expect((await reload(s.id)).enabled).toBe(false);

      const off = await connectedStore({ enabled: false });
      await deliver(off.shopDomain!, SECRET_A);
      const ev = await db.eventLog.findFirst({ where: { storeId: off.id, kind: "shopify.app_uninstalled" } });
      expect(ev!.message).not.toMatch(/réactivé/);
      await reconnect(off.id, { shopDomain: off.shopDomain!, clientId: "app-a", clientSecret: "" }, SECRET_A);
      expect((await reload(off.id)).enabled).toBe(false);
    });

    it("an invalid signature is refused and changes nothing; the journal is rate-limited per store, whatever the IP", async () => {
      const s = await connectedStore();
      for (let i = 0; i < 5; i++) expect((await deliver(s.shopDomain!, SECRET_B, { ip: `9.9.9.${i}` })).status).toBe(401);
      expect(await reload(s.id)).toMatchObject({ shopifyAccessToken: s.shopifyAccessToken, enabled: true, scriptTagId: "gid://shopify/ScriptTag/OLD" });
      expect(await db.eventLog.count({ where: { storeId: s.id, kind: "shopify.webhook_bad_signature" } })).toBe(3);
    });

    it("the signed body must name the header's shop; a missing triggered-at is refused", async () => {
      const s = await connectedStore();
      const other = await deliver(s.shopDomain!, SECRET_A, { body: JSON.stringify({ id: 1, myshopify_domain: "someone-else.myshopify.com" }) });
      expect(other.status).toBe(400);
      expect((await deliver(s.shopDomain!, SECRET_A, { body: JSON.stringify({ id: 1 }) })).status).toBe(400);
      expect((await deliver(s.shopDomain!, SECRET_A, { triggeredAt: null })).status).toBe(400);
      expect(await reload(s.id)).toMatchObject({ shopifyAccessToken: s.shopifyAccessToken, enabled: true });
    });

    it("an uninstall older than the current connection (reinstalled since) is ignored", async () => {
      const s = await connectedStore();
      const res = await deliver(s.shopDomain!, SECRET_A, { triggeredAt: new Date(s.shopifyConnectedAt!.getTime() - 60_000).toISOString() });
      expect(await res.json()).toMatchObject({ ignored: "stale" });
      expect(await reload(s.id)).toMatchObject({ shopifyAccessToken: s.shopifyAccessToken, enabled: true });
    });

    it("compare-and-set on the token read: a reconnection meanwhile (new token) is left alone", async () => {
      const s = await connectedStore();
      // The webhook read the store, then a reconnection replaced the token before its write.
      const spy = vi.spyOn(db.store, "findUnique").mockResolvedValueOnce(s);
      await db.store.update({ where: { id: s.id }, data: { shopifyAccessToken: encrypt("newer-token") } });
      const res = await deliver(s.shopDomain!, SECRET_A);
      spy.mockRestore();
      expect(await res.json()).toMatchObject({ duplicate: true });
      const after = await reload(s.id);
      expect(decrypt(after.shopifyAccessToken!)).toBe("newer-token");
      expect(after.enabled).toBe(true);
    });
  });

  describe("callback robustness", () => {
    it("an attempt older than an hour is expired, the connection kept", async () => {
      const s = await connectedStore();
      const to = await redirectUrl(() => actions.startShopifyInstallAction(s.id, form({ shopDomain: s.shopDomain!, clientId: "app-b", clientSecret: SECRET_B })));
      await db.store.update({ where: { id: s.id }, data: { shopifyPendingAt: new Date(Date.now() - 2 * 3600_000) } });
      const query = signedQuery({ code: "c", shop: s.shopDomain!, state: to.searchParams.get("state")!, timestamp: "1" }, SECRET_B);
      const res = await callback.GET(new Request(`https://checkout.example.com/api/shopify/callback?${query}`), ctx);
      expect(new URL(res.headers.get("location")!).searchParams.get("error")).toMatch(/^Lien d'installation expiré \(plus d'une heure\).*Votre connexion actuelle n'a pas été modifiée\.$/);
      expect(await reload(s.id)).toMatchObject({ shopifyClientId: "app-a", shopifyAccessToken: s.shopifyAccessToken, shopifyPendingClientId: null, shopifyOauthState: null });
      expect(shopify.calls).toEqual([]);
    });

    it("a failed save aborts cleanly: no 500, pending cleared, old connection and old script intact", async () => {
      const s = await connectedStore();
      const newShop = `${tag.replace("_", "-")}-moved.myshopify.com`;
      // Meanwhile, another store takes the new shop (unique domain): the final write fails.
      shopify.onExchange = async () => {
        const o = await db.store.create({ data: { name: `${tag}_thief`, shopDomain: newShop } });
        stores.push(o.id);
      };
      const r = await reconnect(s.id, { shopDomain: newShop, clientId: "app-b", clientSecret: SECRET_B }, SECRET_B);
      expect(r.error).toMatch(/^Connexion Shopify impossible à enregistrer.*Votre connexion actuelle n'a pas été modifiée\.$/);
      expect(await reload(s.id)).toMatchObject({ shopDomain: s.shopDomain, shopifyClientId: "app-a", shopifyAccessToken: s.shopifyAccessToken, scriptTagId: "gid://shopify/ScriptTag/OLD", enabled: true, shopifyPendingClientId: null });
      // The old script is only removed after a successful save: still there.
      expect(shopify.calls.some((c) => String(c.body.query).includes("scriptTagDelete"))).toBe(false);
    });

    it("a slow attempt A never wipes or overwrites a newer attempt B", async () => {
      const s = await connectedStore();
      let stateB = "";
      // While A's code is exchanged, the merchant starts attempt B.
      shopify.onExchange = async () => {
        const toB = await redirectUrl(() => actions.startShopifyInstallAction(s.id, form({ shopDomain: s.shopDomain!, clientId: "app-c", clientSecret: `shpss_${"c".repeat(32)}` })));
        stateB = toB.searchParams.get("state")!;
      };
      const a = await reconnect(s.id, { shopDomain: s.shopDomain!, clientId: "app-b", clientSecret: SECRET_B }, SECRET_B);
      expect(a.error).toMatch(/^Une autre tentative de connexion a été lancée entre-temps/);
      const after = await reload(s.id);
      expect(after).toMatchObject({ shopifyClientId: "app-a", shopifyAccessToken: s.shopifyAccessToken, shopifyPendingClientId: "app-c", shopifyOauthState: stateB });
    });

    it("existing stores get the uninstall webhook: from « Réinstaller le script » and from an « active » status check", async () => {
      const s = await connectedStore();
      const back = await redirectUrl(() => actions.reinstallScriptAction(s.id, form({ from: "shopify" })));
      expect(back.pathname).toBe(`/dashboard/stores/${s.id}/shopify`);
      expect(shopify.calls.some((c) => String(c.body.query).includes("webhookSubscriptionCreate"))).toBe(true);

      const { shopifyLiveState, clearShopifyStatus } = await import("@/lib/shopify-status");
      const { loaderUrl } = await import("@/lib/shopify");
      const t = await connectedStore();
      shopify.loaderSrc = loaderUrl(t.publicId);
      shopify.calls = [];
      clearShopifyStatus(t.id);
      expect(await shopifyLiveState(t)).toBe("active");
      await vi.waitFor(() => expect(shopify.calls.some((c) => String(c.body.query).includes("webhookSubscriptionCreate"))).toBe(true));
      // Rate-limited: a second fresh check does not subscribe again.
      shopify.calls = [];
      clearShopifyStatus(t.id);
      expect(await shopifyLiveState(t)).toBe("active");
      await new Promise((r) => setTimeout(r, 50));
      expect(shopify.calls.some((c) => String(c.body.query).includes("webhookSubscription"))).toBe(false);
    });
  });
});
