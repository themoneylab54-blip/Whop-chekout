import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The shop's storefront domain kept as Shopify has it (Shopify, the database and the rate limiter
 * mocked). One form everywhere (the URL hostname: punycode, lowercase), a value saved in another form
 * rewritten (not journaled). A domain that changed is saved only over the connection read (same shop,
 * same token, same domain) and journaled with its accents; a new domain still waiting for its
 * certificate isn't adopted (the one saved kept), asked again in 30 min, as after a brief Shopify
 * failure. The tick asks the due stores (never checked first, then the oldest), records each check,
 * and stops — partial, nothing recorded — when its time or Shopify's breaker runs out. A checkout from
 * an unknown host asks at most every 10 min per store and 6 h per host (a host asked about lately spends
 * nothing); the dashboard's live status passes on the domain it read.
 */

const mocks = vi.hoisted(() => ({
  getShopInfo: vi.fn<(store: unknown) => Promise<{ name: string; currencyCode: string; primaryDomain: { host: string; sslEnabled: boolean } | null }>>(),
  updateMany: vi.fn<(args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>>(async () => ({ count: 1 })),
  findMany: vi.fn<(args: unknown) => Promise<unknown[]>>(async () => []),
  rateLimit: vi.fn<(key: string, limit: number, windowMs?: number) => Promise<boolean>>(async () => true),
  rateLimitReached: vi.fn<(key: string, limit: number) => Promise<boolean>>(async () => false),
  recordEvent: vi.fn<(e: Record<string, unknown>) => Promise<void>>(async () => undefined),
  warn: vi.fn(),
}));
vi.mock("@/lib/shopify", async (orig) => ({ ShopifyError: (await orig<typeof import("@/lib/shopify")>()).ShopifyError, getShopInfo: mocks.getShopInfo }));
vi.mock("@/lib/db", () => ({ db: { store: { updateMany: mocks.updateMany, findMany: mocks.findMany } } }));
vi.mock("@/lib/ratelimit", () => ({ rateLimit: mocks.rateLimit, rateLimitReached: mocks.rateLimitReached }));
vi.mock("@/lib/log", async (orig) => ({
  ...(await orig<typeof import("@/lib/log")>()),
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
  recordEvent: mocks.recordEvent,
}));

const sd = await import("@/lib/storefront-domain");
const { shopHostname } = await import("@/lib/shop-host");
const { DeadlineError } = await import("@/lib/deadline");
const { withLogContext } = await import("@/lib/log");

const store = { id: "st_1", shopDomain: "yctp21-8n.myshopify.com", shopifyAccessToken: "enc:token", storefrontHost: "xn--sovline-dya.fr" };
const shopOn = (host: string | null, sslEnabled = true) => ({ name: "Sovéline", currencyCode: "EUR", primaryDomain: host ? { host, sslEnabled } : null });
/** The domain writes (storefrontHost) and the check-time writes, apart. */
const domainWrites = () => mocks.updateMany.mock.calls.map((c) => c[0]).filter((a) => "storefrontHost" in a.data);
const checkWrites = () => mocks.updateMany.mock.calls.map((c) => c[0]).filter((a) => "storefrontHostCheckedAt" in a.data);
/** Runs `fn` as a tick job (hard deadline, partial holder); returns its result and whether it noted partial. */
async function asTickJob<T>(fn: () => Promise<T>, hardMs = 50_000) {
  const holder: { partial?: boolean } = {};
  const result = await withLogContext({ tickPartial: holder, hardDeadline: Date.now() + hardMs }, fn);
  return { result, partial: !!holder.partial };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateMany.mockImplementation(async () => ({ count: 1 }));
  mocks.rateLimit.mockImplementation(async () => true);
  mocks.rateLimitReached.mockImplementation(async () => false);
  mocks.findMany.mockImplementation(async () => []);
});

describe("one form for the shop's domains", () => {
  it("shopHostname: lowercase, an accented domain in punycode, no trailing dot; anything else null", () => {
    expect(shopHostname("Soveline.FR")).toBe("soveline.fr");
    expect(shopHostname("sovéline.fr")).toBe("xn--sovline-dya.fr");
    expect(shopHostname("SOVÉLINE.FR.")).toBe("xn--sovline-dya.fr");
    expect(shopHostname(" xn--sovline-dya.fr ")).toBe("xn--sovline-dya.fr");
    for (const junk of [null, undefined, "", "  ", "a b", "https://soveline.fr", "soveline.fr:8443", "soveline.fr/shop", "localhost", "user@soveline.fr", "1.2.3.4", "a..b", "shop.123", "[::1]"])
      expect(shopHostname(junk)).toBeNull();
  });

  it("shopHostLabel: the accents back for people", () => {
    expect(sd.shopHostLabel("xn--sovline-dya.fr")).toBe("sovéline.fr");
    expect(sd.shopHostLabel("soveline.fr")).toBe("soveline.fr");
  });

  it("storefrontHosts compares a domain saved with its accents as the punycode a browser sends", async () => {
    const { storefrontHosts } = await import("@/lib/shopify-discounts");
    expect(storefrontHosts({ storefrontHost: "Sovéline.fr", shopDomain: "yctp21-8n.myshopify.com" })).toEqual(["xn--sovline-dya.fr", "www.xn--sovline-dya.fr", "yctp21-8n.myshopify.com"]);
    expect(storefrontHosts({ storefrontHost: "www.soveline.fr.", shopDomain: null })).toEqual(["www.soveline.fr", "soveline.fr"]);
    expect(storefrontHosts({ storefrontHost: null, shopDomain: "yctp21-8n.myshopify.com" })).toEqual(["yctp21-8n.myshopify.com"]);
  });

  it("the checkout domain and the connection form compare the shop's domain the same way", async () => {
    const { normalizeCheckoutDomain } = await import("@/lib/checkout-domain");
    const refused = normalizeCheckoutDomain("www.sovéline.fr", { appUrl: "https://whop-chekout.vercel.app", storefrontHosts: ["Sovéline.fr", null], operatorHosts: [] });
    expect(refused).toMatchObject({ ok: false, error: expect.stringMatching(/adresse de votre boutique/) });
    const { resolveShopDomainInput } = await import("@/lib/shopify-connect");
    expect(resolveShopDomainInput("xn--sovline-dya.fr", { shopDomain: "yctp21-8n.myshopify.com", storefrontHost: "sovéline.fr" })).toMatchObject({
      ok: true,
      notice: expect.stringMatching(/domaine de votre vitrine/),
    });
  });
});

describe("Shopify's primary domain", () => {
  it("adopted once its certificate is issued; until then the store is due again in 30 min", () => {
    expect(sd.readPrimaryDomain({ host: "Soveline.fr", sslEnabled: true })).toEqual({ host: "soveline.fr", sslPending: false });
    expect(sd.readPrimaryDomain({ host: "soveline.fr", sslEnabled: false })).toEqual({ host: "soveline.fr", sslPending: true });
    // Shopify's answer from before the field was asked: taken as issued.
    expect(sd.readPrimaryDomain({ host: "soveline.fr" })).toEqual({ host: "soveline.fr", sslPending: false });
    expect(sd.readPrimaryDomain(null)).toEqual({ host: null, sslPending: false });
    const now = Date.UTC(2026, 9, 12, 12);
    expect(sd.checkTime(false, now).getTime()).toBe(now);
    expect(sd.checkTime(true, now).getTime() + sd.DOMAIN_CHECK_EVERY_MS).toBe(now + sd.DOMAIN_RECHECK_SOON_MS);
    expect(sd.DOMAIN_RECHECK_SOON_MS).toBe(30 * 60_000);
  });

  it("at a (re)connection: the hostname and a check done; a new one waiting for its certificate: the domain kept, asked again soon", () => {
    const now = Date.UTC(2026, 9, 12, 12);
    expect(sd.connectionDomainFields({ host: "Sovéline.fr", sslEnabled: true }, "old.example.com", now)).toEqual({ storefrontHost: "xn--sovline-dya.fr", storefrontHostCheckedAt: new Date(now) });
    // Waiting for its certificate: the domain saved for the same shop kept (none for a first connection).
    expect(sd.connectionDomainFields({ host: "soveline.fr", sslEnabled: false }, "Old.Example.com", now)).toEqual({ storefrontHost: "old.example.com", storefrontHostCheckedAt: sd.checkTime(true, now) });
    expect(sd.connectionDomainFields({ host: "soveline.fr", sslEnabled: false }, null, now)).toEqual({ storefrontHost: null, storefrontHostCheckedAt: sd.checkTime(true, now) });
    // The domain already saved, its certificate being renewed: nothing changes, the usual schedule.
    expect(sd.connectionDomainFields({ host: "soveline.fr", sslEnabled: false }, "soveline.fr", now)).toEqual({ storefrontHost: "soveline.fr", storefrontHostCheckedAt: new Date(now) });
    expect(sd.connectionDomainFields(null, null, now)).toEqual({ storefrontHost: null, storefrontHostCheckedAt: new Date(now) });
  });
});

describe("saveStorefrontHost", () => {
  it("a domain that changed: saved over the connection read only (shop, token, domain), journaled with its accents", async () => {
    expect(await sd.saveStorefrontHost(store, "soveline.fr", "tick")).toBe(true);
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { id: "st_1", shopDomain: "yctp21-8n.myshopify.com", shopifyAccessToken: "enc:token", storefrontHost: "xn--sovline-dya.fr" },
      data: { storefrontHost: "soveline.fr" },
    });
    expect(mocks.recordEvent).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: "st_1", level: "info", kind: "shopify.storefront_domain", data: { from: "xn--sovline-dya.fr", to: "soveline.fr", why: "tick" } }),
    );
    const message = String(mocks.recordEvent.mock.calls[0][0].message);
    expect(message).toContain("sovéline.fr → soveline.fr");
    expect(message).not.toMatch(/panier \(lecture|lecture du panier/);
  });

  it("a reconnection meanwhile (another shop, token or domain): nothing over it, nothing journaled", async () => {
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await sd.saveStorefrontHost(store, "a.myshopify.com", "tick")).toBe(false);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it("the same domain: no write; saved in another form (an older connection's): rewritten in this one, not journaled", async () => {
    expect(await sd.saveStorefrontHost(store, "xn--sovline-dya.fr", "tick")).toBe(false);
    expect(mocks.updateMany).not.toHaveBeenCalled();
    expect(await sd.saveStorefrontHost({ ...store, storefrontHost: "Sovéline.fr" }, "xn--sovline-dya.fr", "tick")).toBe(false);
    expect(domainWrites()).toEqual([expect.objectContaining({ where: expect.objectContaining({ storefrontHost: "Sovéline.fr" }), data: { storefrontHost: "xn--sovline-dya.fr" } })]);
    expect(mocks.recordEvent).not.toHaveBeenCalled();
  });

  it("a first domain for a store that had none: saved over IS NULL", async () => {
    expect(await sd.saveStorefrontHost({ ...store, storefrontHost: null }, "soveline.fr", "dashboard")).toBe(true);
    expect(mocks.updateMany.mock.calls[0][0].where).toMatchObject({ storefrontHost: null });
    expect(String(mocks.recordEvent.mock.calls[0][0].message)).toContain("aucun → soveline.fr");
  });
});

describe("checkStorefrontDomains (the tick's job)", () => {
  const second = { ...store, id: "st_2", storefrontHost: "shop.example.com" };
  const third = { ...store, id: "st_3", storefrontHost: "third.example.com" };

  it("asks the due connected stores, never checked first then the oldest, 10 at most", async () => {
    const now = new Date(Date.UTC(2026, 9, 12, 12));
    expect((await asTickJob(() => sd.checkStorefrontDomains(Date.now() + 5_000, now))).result).toBe(0);
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: {
        shopifyConnectedAt: { not: null },
        shopDomain: { not: null },
        shopifyAccessToken: { not: null },
        OR: [{ storefrontHostCheckedAt: null }, { storefrontHostCheckedAt: { lt: new Date(now.getTime() - sd.DOMAIN_CHECK_EVERY_MS) } }],
      },
      orderBy: { storefrontHostCheckedAt: { sort: "asc", nulls: "first" } },
      select: { id: true, shopDomain: true, shopifyAccessToken: true, storefrontHost: true },
      take: sd.DOMAIN_CHECKS_PER_RUN,
    });
    expect(sd.DOMAIN_CHECK_EVERY_MS).toBe(6 * 3600_000);
    expect(sd.DOMAIN_CHECKS_PER_RUN).toBe(10);
  });

  it("each store checked is recorded; a moved shop saved; Shopify failing for one store doesn't stop the others", async () => {
    mocks.findMany.mockResolvedValueOnce([store, second, third]);
    mocks.getShopInfo.mockImplementation(async (s) => {
      const id = (s as { id: string }).id;
      if (id === "st_2") throw new Error("401 Unauthorized");
      return shopOn(id === "st_1" ? "soveline.fr" : "third.example.com");
    });
    const { result, partial } = await asTickJob(() => sd.checkStorefrontDomains(Date.now() + 5_000));
    expect(result).toBe(3);
    expect(partial).toBe(false);
    expect(domainWrites()).toEqual([expect.objectContaining({ where: expect.objectContaining({ id: "st_1" }), data: { storefrontHost: "soveline.fr" } })]);
    expect(checkWrites().map((w) => w.where)).toEqual([{ id: "st_1" }, { id: "st_2" }, { id: "st_3" }]);
    expect(mocks.warn).toHaveBeenCalledWith("shopify.storefront_domain_failed", expect.any(String), expect.objectContaining({ storeId: "st_2", why: "tick" }));
  });

  it("a new domain still waiting for its certificate: kept as is, the store due again in 30 min", async () => {
    mocks.findMany.mockResolvedValueOnce([store]);
    mocks.getShopInfo.mockResolvedValueOnce(shopOn("soveline.fr", false));
    const before = Date.now();
    await asTickJob(() => sd.checkStorefrontDomains(Date.now() + 5_000));
    expect(domainWrites()).toEqual([]);
    const at = (checkWrites()[0].data.storefrontHostCheckedAt as Date).getTime();
    expect(at + sd.DOMAIN_CHECK_EVERY_MS - before).toBeGreaterThanOrEqual(sd.DOMAIN_RECHECK_SOON_MS - 1_000);
    expect(at + sd.DOMAIN_CHECK_EVERY_MS - before).toBeLessThanOrEqual(sd.DOMAIN_RECHECK_SOON_MS + 1_000);
  });

  it("the domain saved, its certificate being renewed: kept, the usual schedule", async () => {
    mocks.findMany.mockResolvedValueOnce([store]);
    mocks.getShopInfo.mockResolvedValueOnce(shopOn("xn--sovline-dya.fr", false));
    const before = Date.now();
    await asTickJob(() => sd.checkStorefrontDomains(Date.now() + 5_000));
    expect(domainWrites()).toEqual([]);
    expect((checkWrites()[0].data.storefrontHostCheckedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
  });

  it("Shopify briefly unavailable (a transient error): asked again in 30 min; a definite error: at the next due time", async () => {
    const { ShopifyError } = await import("@/lib/shopify");
    mocks.findMany.mockResolvedValueOnce([store, second]);
    mocks.getShopInfo.mockRejectedValueOnce(new ShopifyError("Shopify API 503", true)).mockRejectedValueOnce(new ShopifyError("Shopify API 401"));
    const before = Date.now();
    expect((await asTickJob(() => sd.checkStorefrontDomains(Date.now() + 5_000))).result).toBe(2);
    const [soon, later] = checkWrites().map((w) => (w.data.storefrontHostCheckedAt as Date).getTime());
    expect(soon + sd.DOMAIN_CHECK_EVERY_MS - before).toBeLessThanOrEqual(sd.DOMAIN_RECHECK_SOON_MS + 1_000);
    expect(later).toBeGreaterThanOrEqual(before);
  });

  it("out of time or Shopify's breaker open (DeadlineError): stopped, partial, nothing recorded for the rest", async () => {
    mocks.findMany.mockResolvedValueOnce([store, second, third]);
    mocks.getShopInfo.mockResolvedValueOnce(shopOn("xn--sovline-dya.fr")).mockRejectedValueOnce(new DeadlineError("Shopify shop : Shopify ne répond pas"));
    const { result, partial } = await asTickJob(() => sd.checkStorefrontDomains(Date.now() + 5_000));
    expect(result).toBe(1);
    expect(partial).toBe(true);
    expect(mocks.getShopInfo).toHaveBeenCalledTimes(2);
    expect(checkWrites().map((w) => w.where)).toEqual([{ id: "st_1" }]);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it("no time for a Shopify call before the hard deadline, or past the job's deadline: no store asked, partial", async () => {
    mocks.findMany.mockResolvedValue([store]);
    const tight = await asTickJob(() => sd.checkStorefrontDomains(Date.now() + 5_000), 10_000);
    expect(tight).toEqual({ result: 0, partial: true });
    const late = await asTickJob(() => sd.checkStorefrontDomains(Date.now() - 1));
    expect(late).toEqual({ result: 0, partial: true });
    expect(mocks.getShopInfo).not.toHaveBeenCalled();
    expect(checkWrites()).toEqual([]);
  });
});

describe("recheckStorefrontHost (a checkout from a host the store doesn't know)", () => {
  it("a host asked about lately: nothing spent (its limit only looked at), the store's window left for a new host", async () => {
    mocks.rateLimitReached.mockImplementation(async (key) => key === "storefront-domain:st_1:soveline.de");
    await sd.recheckStorefrontHost(store, "soveline.de");
    expect(mocks.rateLimitReached).toHaveBeenCalledWith("storefront-domain:st_1:soveline.de", 1);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.getShopInfo).not.toHaveBeenCalled();
    mocks.getShopInfo.mockResolvedValue(shopOn("soveline.fr"));
    await sd.recheckStorefrontHost(store, "soveline.fr");
    expect(mocks.getShopInfo).toHaveBeenCalledTimes(1);
  });

  it("asks Shopify at most every 10 min per store, then 6 h per host; the store's limit spent first", async () => {
    mocks.getShopInfo.mockResolvedValue(shopOn("soveline.fr"));
    await sd.recheckStorefrontHost(store, "soveline.fr");
    expect(mocks.rateLimit.mock.calls).toEqual([
      ["storefront-domain:st_1", 1, sd.DOMAIN_RECHECK_MS],
      ["storefront-domain:st_1:soveline.fr", 1, sd.UNKNOWN_HOST_RECHECK_MS],
    ]);
    expect(mocks.getShopInfo).toHaveBeenCalledTimes(1);
    expect(domainWrites()).toHaveLength(1);
    expect(mocks.recordEvent.mock.calls[0][0].data).toMatchObject({ why: "unknown_host" });
    // The store's limit spent: the host's isn't even looked at.
    mocks.rateLimit.mockResolvedValueOnce(false);
    await sd.recheckStorefrontHost(store, "soveline.de");
    expect(mocks.rateLimit).toHaveBeenCalledTimes(3);
    // The host asked about lately (a Markets domain that isn't the primary one): not again.
    mocks.rateLimit.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await sd.recheckStorefrontHost(store, "soveline.de");
    expect(mocks.getShopInfo).toHaveBeenCalledTimes(1);
    expect(sd.DOMAIN_RECHECK_MS).toBe(10 * 60_000);
    expect(sd.UNKNOWN_HOST_RECHECK_MS).toBe(6 * 3600_000);
  });

  it("never without a connection; never throws (Shopify, the limiter or the database failing)", async () => {
    await sd.recheckStorefrontHost({ ...store, shopifyAccessToken: null }, "soveline.fr");
    await sd.recheckStorefrontHost({ ...store, shopDomain: null }, "soveline.fr");
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    mocks.getShopInfo.mockRejectedValueOnce(new Error("503"));
    await expect(sd.recheckStorefrontHost(store, "soveline.fr")).resolves.toBeUndefined();
    mocks.rateLimit.mockRejectedValueOnce(new Error("db down"));
    await expect(sd.recheckStorefrontHost(store, "soveline.fr")).resolves.toBeUndefined();
    mocks.getShopInfo.mockResolvedValueOnce(shopOn("soveline.fr"));
    mocks.updateMany.mockRejectedValue(new Error("db down"));
    await expect(sd.recheckStorefrontHost(store, "soveline.fr")).resolves.toBeUndefined();
  });
});

describe("noteStorefrontPrimary (the dashboard's live status)", () => {
  it("the domain it read: saved when it changed, the check recorded; never throws", async () => {
    await sd.noteStorefrontPrimary(store, { host: "soveline.fr", sslEnabled: true });
    expect(domainWrites()).toHaveLength(1);
    expect(mocks.recordEvent.mock.calls[0][0].data).toMatchObject({ why: "dashboard" });
    expect(checkWrites()).toHaveLength(1);
    expect(mocks.getShopInfo).not.toHaveBeenCalled();
    mocks.updateMany.mockRejectedValue(new Error("db down"));
    await expect(sd.noteStorefrontPrimary(store, { host: "soveline.fr", sslEnabled: true })).resolves.toBeUndefined();
  });
});

describe("wiring", () => {
  it("the tick runs it as a non-money job", async () => {
    const { TICK_JOBS } = await import("@/lib/tick");
    const job = TICK_JOBS.find((j) => j.name === "storefrontDomains");
    expect(job?.job).toBe(sd.checkStorefrontDomains);
    expect(job?.money).toBe(false);
  });
});
