import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The session route without a database (every module it calls mocked): the loader's warm-up is
 * capped per IP in memory (30 a minute, then 429 without any query, never spending the session rate
 * limit), and each refusal says whether the loader retries it once on its own (`retryable`) or
 * leaves the cart to Shopify's checkout (`native`), with the store in its log line when known.
 */

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn<(strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>>(async () => []),
  findStore: vi.fn<(args: unknown) => Promise<unknown>>(async () => null),
  priceCart: vi.fn(),
  sessionCart: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    $queryRaw: mocks.queryRaw,
    store: { findUnique: mocks.findStore },
    checkoutSession: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
  },
}));
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: mocks.warn, error: vi.fn() },
  withLogContext: (_fields: unknown, fn: () => unknown) => fn(),
  recordEvent: vi.fn(),
}));
vi.mock("@/lib/metrics", () => ({ flushProviderMetrics: vi.fn() }));
vi.mock("@/lib/sentry", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/checkout-domain-check", () => ({ isForeignCheckoutHost: vi.fn(async () => false) }));
vi.mock("@/lib/checkout-domain", () => ({ checkoutBaseUrl: () => "https://checkout.example.com" }));
vi.mock("@/lib/shopify", () => ({ priceCart: mocks.priceCart }));
vi.mock("@/lib/layout", () => ({ loadInterception: () => ({ excludedHandles: [] }) }));
vi.mock("@/lib/conversions", () => ({ sendCheckoutConversions: vi.fn() }));
vi.mock("@/lib/experiments", () => ({ assignVariant: vi.fn() }));
vi.mock("@/lib/checkout-tests", () => ({ assignCheckoutTests: vi.fn() }));
vi.mock("@/lib/pricing", () => ({ unsupportedCart: () => null }));
vi.mock("@/lib/analytics", () => ({ touchWithin: () => null }));
vi.mock("@/lib/geo", () => ({ geoCountryOf: () => null }));
vi.mock("@/lib/cart-session", () => ({ sessionCart: mocks.sessionCart, startCartRead: () => null }));
vi.mock("@/lib/visitor", () => ({ resolveVisitor: () => ({ id: "v_1", token: "v_1.sig" }), signVisitorId: vi.fn(), verifyVisitorId: vi.fn() }));
vi.mock("@/lib/payment-provider", () => ({ anyProviderConnected: () => true }));
vi.mock("@/lib/early-prepare", () => ({ prepareAhead: vi.fn() }));

const { POST } = await import("@/app/api/public/sessions/route");

let n = 0;
const post = (body: unknown, ip = `10.88.0.${++n}`) =>
  POST(
    new Request("https://x.test/api/public/sessions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) },
  );
/** The template of each raw query ("SELECT 1" for a warm-up, the rate limit's INSERT otherwise). */
const queries = () => mocks.queryRaw.mock.calls.map(([strings]) => strings.join("?").trim());
/** The fields of each session.refused log line. */
const refusals = () => mocks.warn.mock.calls.filter(([kind]) => kind === "session.refused").map(([, , fields]) => fields);

const store = { id: "store_1", enabled: true, shopifyConnectedAt: new Date(), fallbackActiveAt: null, interception: null, shopDomain: "x.myshopify.com", storefrontHost: null, shopCurrency: "EUR" };
const cart = { store: "pub_1", items: [{ variant_id: 11, quantity: 1 }] };
const line = { variantId: "gid://shopify/ProductVariant/11", productHandle: "p11", quantity: 1, unitPriceCents: 1000, giftCard: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sessions route: warm-up", () => {
  it("30 warm-ups a minute per IP, then 429 { warm: false } with CORS and no query; the session rate limit is never spent", async () => {
    const ip = "10.88.1.1";
    for (let i = 0; i < 30; i++) {
      const res = await post({ warm: true }, ip);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ warm: true });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    const capped = await post({ warm: true }, ip);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toMatchObject({ warm: false });
    expect(capped.headers.get("access-control-allow-origin")).toBe("*");
    expect(mocks.queryRaw).toHaveBeenCalledTimes(30);
    expect(queries().every((q) => q === "SELECT 1")).toBe(true);

    // Another IP still warms up.
    expect((await post({ warm: true }, "10.88.1.2")).status).toBe(200);
    expect(mocks.queryRaw).toHaveBeenCalledTimes(31);

    // The capped IP's checkout click still goes through: its own limit, untouched by the warm-ups.
    const click = await post({}, ip);
    expect(click.status).toBe(400);
    expect(await click.json()).toMatchObject({ reason: "invalid_body" });
    expect(queries().at(-1)).toMatch(/^INSERT INTO "RateLimit"/);
  });
});

describe("sessions route: refusals", () => {
  it("retryable only for transient refusals (also a 409), native only for Shopify's carts; the store id in the log line", async () => {
    // rate_limited: the 21st session request of an IP within the minute (no store known yet).
    const ip = "10.88.2.1";
    for (let i = 0; i < 20; i++) {
      const res = await post({}, ip);
      expect(res.status).toBe(400);
      expect(await res.json()).not.toHaveProperty("retryable");
    }
    const limited = await post({}, ip);
    expect(limited.status).toBe(429);
    // Not retried: the same minute would refuse again.
    const limitedBody = await limited.json();
    expect(limitedBody).toMatchObject({ reason: "rate_limited" });
    expect(limitedBody).not.toHaveProperty("retryable");
    expect(refusals().at(-1)).toEqual({ status: 429, reason: "rate_limited" });

    // Unknown store: the checkout is off for it, the cart stays Shopify's; never retried.
    const disabled = await post(cart);
    expect(disabled.status).toBe(409);
    const off = await disabled.json();
    expect(off).toMatchObject({ reason: "disabled", native: true, fallback: true });
    expect(off).not.toHaveProperty("retryable");

    // Shopify can't price the cart: retried once, never native.
    mocks.findStore.mockResolvedValueOnce(store);
    mocks.priceCart.mockRejectedValueOnce(new Error("Shopify down"));
    const priced = await post(cart);
    expect(priced.status).toBe(502);
    const failed = await priced.json();
    expect(failed).toMatchObject({ reason: "price_failed", retryable: true });
    expect(failed).not.toHaveProperty("native");
    expect(refusals().at(-1)).toEqual({ status: 502, reason: "price_failed", storeId: "store_1" });

    // The Shopify cart changed under the click: a 409 the loader still retries.
    mocks.findStore.mockResolvedValueOnce(store);
    mocks.priceCart.mockResolvedValueOnce([line]);
    mocks.sessionCart.mockResolvedValueOnce({ ok: false, reason: "cart_changed" });
    const changed = await post(cart);
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ reason: "cart_changed", retryable: true });
    expect(refusals().at(-1)).toEqual({ status: 409, reason: "cart_changed", storeId: "store_1" });

    // A cart that can't be represented (not transient): the "try again" message, no automatic retry.
    mocks.findStore.mockResolvedValueOnce(store);
    mocks.priceCart.mockResolvedValueOnce([line]);
    mocks.sessionCart.mockResolvedValueOnce({ ok: false, reason: "price_higher" });
    const refused = await post(cart);
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body).toMatchObject({ reason: "price_higher" });
    expect(body).not.toHaveProperty("retryable");
    expect(body).not.toHaveProperty("native");
  });
});

describe("sessions route: oversized properties", () => {
  it("a line's properties (or the cart's attributes) over the limits are left out, never the cart refused", async () => {
    mocks.findStore.mockResolvedValueOnce(store);
    mocks.priceCart.mockResolvedValueOnce([line]);
    mocks.sessionCart.mockResolvedValueOnce({ ok: false, reason: "price_higher" });
    const big = { _app_data: "x".repeat(20_000), Gravure: "Léa" };
    const res = await post({ store: "pub_1", items: [{ variant_id: 11, quantity: 1, properties: big }], attributes: { _huge: "y".repeat(20_000) } });
    // Past the body's validation (the cart itself decided the answer).
    expect((await res.json()).reason).toBe("price_higher");
    const input = mocks.sessionCart.mock.calls[0][1] as { items: { properties?: unknown }[]; attributes?: unknown };
    expect(input.items[0].properties).toBeNull();
    expect(input.attributes).toBeNull();
    // Said in the logs (support can tell why a personalization is missing).
    expect(mocks.warn.mock.calls.find(([kind]) => kind === "session.properties_dropped")?.[2]).toEqual({ store: "pub_1", dropped: 2 });
  });
});
