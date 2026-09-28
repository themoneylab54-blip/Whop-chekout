import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Round 13 (correctness) against a real Postgres: the Shopify code usage limit (Shopify's count plus
 * the whole ledger, refused at quote / confirm time), Google Ads adjustment candidates flagged by the
 * writers (and the migration's backfill), account-wide Google errors whatever the HTTP status, the
 * "Relancer" reset, the anti-duplicate wait of replacement orders, one pending buyer claim per order,
 * no "healed" alert for a duplicate payment, and the health probe / tile. Shopify, Whop, Google and
 * notifications are mocked. Test data is prefixed c13fix_ and deleted at the end.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
  shopifyGraphql: vi.fn(),
}));
const whop = vi.hoisted(() => ({ createCheckoutConfiguration: vi.fn(), list: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn(), sendBuyerEmail: vi.fn() }));

vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({
  ...(await orig<typeof import("@/lib/whop")>()),
  createCheckoutConfiguration: whop.createCheckoutConfiguration,
  storeClient: () => ({
    payments: {
      list: async (params: Record<string, unknown>) => ({ data: (await whop.list(params)) as unknown[], response: { page_info: { has_next_page: false, end_cursor: null } } }),
    },
    refunds: { list: async () => ({ data: [], response: { page_info: { has_next_page: false, end_cursor: null } } }) },
    disputes: { list: async () => ({ data: [], response: { page_info: { has_next_page: false, end_cursor: null } } }) },
    shipments: { create: vi.fn() },
  }),
}));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const MIN = 60_000;
const DAY = 86_400_000;

describe.skipIf(!hasDb)("round 13 correctness (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { prepareSession, quoteSession, confirmSession, markPaid, recordRefund } = await import("@/lib/checkout");
  const { clearShopifyDiscountCache } = await import("@/lib/shopify-discounts");
  const { ShopifyError } = await import("@/lib/shopify");
  const { decideClaim, createReplacementOrder, submitBuyerClaim } = await import("@/lib/claims");
  const google = await import("@/lib/google-conversions");
  const { markUpsellPaid, recordUpsellRefund } = await import("@/lib/upsell");
  const { handleEvent } = await import("@/lib/webhooks");
  const { runTick } = await import("@/lib/tick");
  const { backlog, storeHealth } = await import("@/lib/health");
  const healthRoute = await import("@/app/api/health/route");

  const created: string[] = [];

  const line = (o: Record<string, unknown> = {}) => ({
    variantId: "gid://shopify/ProductVariant/11",
    productId: "gid://shopify/Product/1",
    productHandle: "sweat",
    title: "Sweat",
    variantTitle: null,
    sku: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 5000,
    compareAtCents: null,
    inventory: null,
    requiresShipping: true,
    ...o,
  });
  const address = { firstName: "Alex", lastName: "Martin", address1: "1 rue X", city: "Paris", zip: "75001", countryCode: "FR" };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `c13fix_${Math.random().toString(36).slice(2, 8)}`,
        testMode: false,
        vatExempt: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_c13",
        whopProductId: "prod_c13",
        whopApiKey: encrypt("k"),
        shopDomain: `c13fix-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        shopifyScopes: "read_products,write_orders,read_discounts",
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  const shopifyCode = (o: Record<string, unknown> = {}) => ({
    codeDiscountNodeByCode: {
      codeDiscount: {
        __typename: "DiscountCodeBasic",
        title: "Code",
        status: "ACTIVE",
        startsAt: "2026-01-01T00:00:00Z",
        endsAt: null,
        usageLimit: null,
        asyncUsageCount: 0,
        appliesOncePerCustomer: false,
        context: { __typename: "DiscountBuyerSelectionAll" },
        minimumRequirement: null,
        customerGets: { value: { __typename: "DiscountPercentage", percentage: 0.1 }, items: { __typename: "AllDiscountItems", allItems: true } },
        ...o,
      },
    },
  });

  /** A paid use of `code` recorded in the ledger (another checkout). */
  async function pastUse(storeId: string, code: string) {
    const s = await db.checkoutSession.create({ data: { storeId, currency: "EUR", lines: [line()], status: "PAID", paidAt: new Date(), discountCode: code } });
    await db.shopifyCodeUse.create({ data: { storeId, code, sessionId: s.id, email: `past-${s.id}@c13fix.test` } });
  }

  /** A paid order with its paid snapshot (lines, add-ons). */
  async function paidOrder(storeId: string, data: Record<string, unknown> = {}, addOns: unknown[] = []) {
    const session = await db.checkoutSession.create({
      data: { storeId, currency: "EUR", status: "PAID", lines: [line()], subtotalCents: 5000, totalCents: 5000, paidAt: new Date(), shippingAddress: address, ...data } as never,
    });
    const q = await db.checkoutQuote.create({
      data: {
        sessionId: session.id,
        whopCheckoutId: `ch_${session.id}`,
        fingerprint: "f",
        currency: "EUR",
        subtotalCents: session.subtotalCents,
        discountCents: 0,
        shippingCents: 0,
        addOnsCents: 0,
        totalCents: session.totalCents,
        addOns: addOns as never,
        addOnIds: [],
        lines: [line()] as never,
      },
    });
    return db.checkoutSession.update({ where: { id: session.id }, data: { paidQuoteId: q.id } });
  }

  const googleStore = (data: Record<string, unknown> = {}) =>
    makeStore({
      googleAdsCustomerId: "1234567890",
      googleAdsDeveloperToken: encrypt("dev"),
      googleAdsClientId: "abc.apps.googleusercontent.com",
      googleAdsClientSecret: encrypt("sec"),
      googleAdsRefreshToken: encrypt("ref"),
      googleAdsConversionAction: "customers/1234567890/conversionActions/555",
      ...data,
    });

  /** Google's endpoints answered by the given handlers (default: success). */
  function stubGoogle(h: { upload?: (body: Record<string, unknown>) => Response; adjust?: (body: Record<string, unknown>) => Response }) {
    const calls = { upload: [] as Record<string, unknown>[], adjust: [] as Record<string, unknown>[] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "ya29" }), { status: 200 });
        const body = JSON.parse(String(init?.body));
        if (url.endsWith(":uploadClickConversions")) {
          calls.upload.push(body);
          return h.upload ? h.upload(body) : new Response(JSON.stringify({ results: [{}] }), { status: 200 });
        }
        if (url.endsWith(":uploadConversionAdjustments")) {
          calls.adjust.push(body);
          return h.adjust ? h.adjust(body) : new Response(JSON.stringify({ results: [{}] }), { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    return calls;
  }
  /** A partial failure (HTTP 200) with Google's error code. */
  const partial = (errorCode: Record<string, string>, message = "Upload refused.") =>
    new Response(JSON.stringify({ partialFailureError: { code: 3, message, details: [{ errors: [{ errorCode, message }] }] } }), { status: 200 });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    clearShopifyDiscountCache();
    // Reruns start clean: the rate-limit windows these tests hit (incident throttles, claims).
    await db.rateLimit.deleteMany({ where: { OR: [{ key: { startsWith: "claim:" } }, { key: { startsWith: "incident:" } }, { key: { startsWith: "session:ip:" } }] } });
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.tagOrder.mockResolvedValue(undefined);
    shopify.createPaidOrder.mockResolvedValue({ id: "gid://shopify/Order/1301", name: "#1301" });
    shopify.priceCart.mockImplementation(async (_s: unknown, items: { variantId: string; quantity: number }[]) =>
      items.map((i) => line({ variantId: String(i.variantId), quantity: i.quantity })),
    );
    whop.createCheckoutConfiguration.mockImplementation(async () => ({ id: `ch_c13_${Math.random().toString(36).slice(2)}`, purchaseUrl: null }));
    whop.list.mockResolvedValue([]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("reconciliation: a second payment for a paid cart is a duplicate (alerted once), never 'healed'", async () => {
    // No Google call may leave the machine while the whole tick runs.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));
    const store = await makeStore();
    const s = await paidOrder(store.id, { whopPaymentId: "pay_c13_first", email: "buyer@c13fix.test", shopifyOrderId: "gid://shopify/Order/1", shopifyOrderName: "#1" });
    const now = new Date().toISOString();
    whop.list.mockImplementation(async (p: { product_id?: string }) =>
      p.product_id === "prod_c13"
        ? [{ id: `pay_c13_second_${s.id}`, product_id: "prod_c13", metadata: { checkout_session_id: s.id }, checkout_configuration_id: `ch_${s.id}`, total: { amount: "50.00", currency: "eur" }, created_at: now, paid_at: now }]
        : [],
    );
    await runTick();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.whopPaymentId).toBe("pay_c13_first");
    expect(row.extraPaymentIds).toEqual([`pay_c13_second_${s.id}`]);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "payment.duplicate" } })).toBe(1);
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "reconcile.healed" } })).toBe(0);
  });

  it("Shopify code usage limit: Shopify's count + the whole ledger, refused at quote and at confirm (read-only)", async () => {
    const store = await makeStore({ shopifyDiscountCodes: true });
    await db.shippingRate.create({ data: { storeId: store.id, name: "Poste", countries: [], priceCents: 0 } });
    shopify.shopifyGraphql.mockResolvedValue(shopifyCode({ usageLimit: 3, asyncUsageCount: 1 }));
    await pastUse(store.id, "LIM3");
    // 1 (Shopify) + 1 (ledger) < 3: the code applies and the Whop checkout is prepared.
    const s = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [line()], subtotalCents: 5000 }, include: { store: true } });
    const prepared = await prepareSession(s, { discountCode: "lim3", addOnIds: [], countryCode: "FR" });
    expect(prepared.quote.discount?.code).toBe("LIM3");

    // Another checkout pays it meanwhile: 1 + 2 = 3 = the limit. The quote says "used up"…
    await pastUse(store.id, "LIM3");
    const fresh = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id }, include: { store: true } });
    const q = await quoteSession(fresh, { discountCode: "lim3", addOnIds: [], countryCode: "FR" });
    expect([q.discount, q.discountErrorCode]).toEqual([null, "discount_exhausted"]);
    // …and confirm refuses before the Whop form is submitted, writing nothing.
    const uses = await db.shopifyCodeUse.count({ where: { storeId: store.id } });
    await expect(
      confirmSession(fresh, { discountCode: "lim3", addOnIds: [], email: "c@c13fix.test", acceptsMarketing: false, acceptsTerms: true, address, checkoutConfigurationId: prepared.checkoutConfigurationId } as never),
    ).rejects.toMatchObject({ code: "discount_exhausted" });
    const after = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect([after.status, after.email, after.payClickedAt]).toEqual(["OPEN", null, null]);
    expect(await db.shopifyCodeUse.count({ where: { storeId: store.id } })).toBe(uses);

    // Paid anyway (the form was already open): held for review, the use recorded, no order.
    await markPaid(s.id, { id: `pay_${s.id}`, totalCents: prepared.totals.totalCents, currency: "eur", checkoutConfigurationId: prepared.checkoutConfigurationId });
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).reviewNote).toContain("limite de 3 utilisation(s) atteinte");
    expect(shopify.createPaidOrder).not.toHaveBeenCalled();
  });

  it("Google adjustments: the writers flag the order (tries given back), only flagged orders are candidates", async () => {
    const store = await googleStore();
    const uploaded = (data: Record<string, unknown> = {}) =>
      paidOrder(store.id, {
        utm: { gclid: "Cj0KCQjwc13fixADJ" },
        totalCents: 10_000,
        subtotalCents: 10_000,
        googleAdsUploadedAt: new Date(Date.now() - 7 * 3600_000),
        googleAdsValueCents: 10_000,
        // Linked by hand: no Shopify call from the refund / dispute handlers.
        syncHandledAt: new Date(),
        ...data,
      });
    // A refund on an order whose previous adjustment was given up: flagged, tries given back.
    const refunded = await uploaded({ googleAdsAdjustAttempts: 5, googleAdsAdjustError: "old", googleAdsAdjustNextAt: new Date(Date.now() + DAY), whopPaymentId: `pay_c13_r_${Date.now()}` });
    await recordRefund(refunded.id, 2500, `re_c13_${refunded.id}`);
    let r = await db.checkoutSession.findUniqueOrThrow({ where: { id: refunded.id } });
    expect([r.googleAdsAdjustDue, r.googleAdsAdjustAttempts, r.googleAdsAdjustNextAt]).toEqual([true, 0, null]);

    // A lost dispute (webhook).
    const disputed = await uploaded({ whopPaymentId: `pay_c13_d_${Date.now()}` });
    await handleEvent("dispute.updated", { id: `dp_c13_${disputed.id}`, payment: { id: disputed.whopPaymentId }, status: "lost", amount: 100, currency: "eur" }, store.id);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: disputed.id } })).googleAdsAdjustDue).toBe(true);

    // An offer paid, then refunded.
    const withOffer = await uploaded();
    const offer = await db.upsellCharge.create({
      data: { sessionId: withOffer.id, blockId: "b1", title: "Casquette", variantId: "gid://shopify/ProductVariant/7", amountCents: 3000, status: "PENDING", syncHandledAt: new Date() },
    });
    await markUpsellPaid(offer.id, `pay_c13_o_${offer.id}`, store.id);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: withOffer.id } })).googleAdsAdjustDue).toBe(true);
    const offerRefunded = await uploaded();
    const offer2 = await db.upsellCharge.create({
      data: { sessionId: offerRefunded.id, blockId: "b1", title: "Casquette", variantId: "gid://shopify/ProductVariant/7", amountCents: 3000, status: "PAID", syncHandledAt: new Date() },
    });
    await recordUpsellRefund(offer2.id, `re_c13_o_${offer2.id}`, 3000);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: offerRefunded.id } })).googleAdsAdjustDue).toBe(true);

    // Not flagged (no writer went through): never a candidate, even with a refund on the row.
    const unflagged = await uploaded({ refundedCents: 2500 });

    const calls = stubGoogle({});
    expect(await google.adjustGoogleConversions(Date.now() + 30_000, { storeId: store.id })).toBe(3);
    const sent = new Map(calls.adjust.map((b) => [(b.conversionAdjustments as { orderId: string }[])[0].orderId, (b.conversionAdjustments as Record<string, unknown>[])[0]]));
    expect(sent.get(refunded.id)).toMatchObject({ adjustmentType: "RESTATEMENT", restatementValue: { adjustedValue: 75 } });
    expect(sent.get(disputed.id)).toMatchObject({ adjustmentType: "RETRACTION" });
    expect(sent.get(withOffer.id)).toMatchObject({ adjustmentType: "RESTATEMENT", restatementValue: { adjustedValue: 130 } });
    expect(sent.has(offerRefunded.id)).toBe(false);
    expect(sent.has(unflagged.id)).toBe(false);
    // Cleared once adjusted, or found unchanged (the offer refunded in full: 100 € as uploaded).
    for (const id of [refunded.id, disputed.id, withOffer.id, offerRefunded.id]) expect((await db.checkoutSession.findUniqueOrThrow({ where: { id } })).googleAdsAdjustDue).toBe(false);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: unflagged.id } })).googleAdsAdjustDue).toBe(false);

    // A new conversion action gives back the tries of failed adjustments.
    await db.checkoutSession.update({ where: { id: refunded.id }, data: { googleAdsAdjustAttempts: 5, googleAdsAdjustDue: true } });
    await google.changeConversionAction(store.id, "customers/1234567890/conversionActions/556");
    r = await db.checkoutSession.findUniqueOrThrow({ where: { id: refunded.id } });
    expect([r.googleAdsAdjustDue, r.googleAdsAdjustAttempts]).toEqual([true, 0]);
  });

  it("migration backfill: uploaded conversions whose value changed are flagged, the others not", async () => {
    const store = await googleStore();
    const base = { utm: { gclid: "Cj0KCQjwc13fixBF" }, totalCents: 10_000, subtotalCents: 10_000, googleAdsUploadedAt: new Date(Date.now() - DAY), googleAdsValueCents: 10_000 };
    const refunded = await paidOrder(store.id, { ...base, refundedCents: 2500, googleAdsAdjustAttempts: 5 });
    const lost = await paidOrder(store.id, { ...base, disputeStatus: "lost" });
    const offer = await paidOrder(store.id, base);
    await db.upsellCharge.create({ data: { sessionId: offer.id, blockId: "b1", title: "Casquette", variantId: "gid://shopify/ProductVariant/7", amountCents: 3000, status: "PAID" } });
    const unchanged = await paidOrder(store.id, base);
    const adjusted = await paidOrder(store.id, { ...base, refundedCents: 2500, googleAdsValueCents: 7500 });
    const retracted = await paidOrder(store.id, { ...base, refundedCents: 10_000, googleAdsRetractedAt: new Date(), googleAdsValueCents: 0 });
    const notUploaded = await paidOrder(store.id, { ...base, googleAdsUploadedAt: null, refundedCents: 2500 });
    const sql = readFileSync(path.resolve(__dirname, "../../prisma/migrations/0021_correctness_round13/migration.sql"), "utf8");
    const backfill = sql.slice(sql.indexOf('UPDATE "CheckoutSession" s SET "googleAdsAdjustDue"'), sql.indexOf(";", sql.indexOf('UPDATE "CheckoutSession" s SET "googleAdsAdjustDue"')) + 1);
    expect(backfill).toContain("UPDATE");
    await db.$executeRawUnsafe(backfill);
    const due = async (id: string) => (await db.checkoutSession.findUniqueOrThrow({ where: { id } })).googleAdsAdjustDue;
    expect(await Promise.all([refunded, lost, offer].map((s) => due(s.id)))).toEqual([true, true, true]);
    expect(await Promise.all([unchanged, adjusted, retracted, notUploaded].map((s) => due(s.id)))).toEqual([false, false, false, false]);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: refunded.id } })).googleAdsAdjustAttempts).toBe(0);
  });

  it("Google errors: account-level codes and repeated messages stop the run (no try spent, alert); the first per-order failure shows at once", async () => {
    const day = (n: number) => new Date(Date.now() - n * DAY);
    // A known account-level code on the very first order: stop there.
    const a = await googleStore();
    const aOrders = [];
    for (let i = 0; i < 3; i++) aOrders.push(await paidOrder(a.id, { utm: { gclid: `Cj0KCQjwc13fixA${i}x` }, paidAt: day(3 - i) }));
    let calls = stubGoogle({ upload: () => partial({ conversionActionError: "CONVERSION_ACTION_NOT_ENABLED" }, "The conversion action is not enabled.") });
    expect(await google.uploadGoogleConversions(Date.now() + 30_000, { storeId: a.id })).toBe(0);
    expect(calls.upload).toHaveLength(1);
    let rows = await db.checkoutSession.findMany({ where: { id: { in: aOrders.map((o) => o.id) } }, orderBy: { paidAt: "asc" } });
    expect(rows.map((r) => r.googleAdsUploadAttempts)).toEqual([0, 0, 0]);
    expect(rows[0].googleAdsUploadError).toContain("CONVERSION_ACTION_NOT_ENABLED");
    expect((await db.eventLog.findFirstOrThrow({ where: { storeId: a.id, kind: "google.conversions_account_error" } })).message).toContain("envoi suspendu");
    expect(notify.sendAlert).toHaveBeenCalled();

    // The same unknown partial failure (HTTP 200) on 3 orders in a row: the account's too.
    const b = await googleStore();
    const bOrders = [];
    for (let i = 0; i < 4; i++) bOrders.push(await paidOrder(b.id, { utm: { gclid: `Cj0KCQjwc13fixB${i}x` }, paidAt: day(4 - i) }));
    calls = stubGoogle({ upload: () => partial({ conversionUploadError: "SOMETHING_NEW" }, "Something new.") });
    expect(await google.uploadGoogleConversions(Date.now() + 30_000, { storeId: b.id })).toBe(0);
    expect(calls.upload).toHaveLength(3);
    rows = await db.checkoutSession.findMany({ where: { id: { in: bOrders.map((o) => o.id) } }, orderBy: { paidAt: "asc" } });
    expect(rows.map((r) => r.googleAdsUploadAttempts)).toEqual([0, 0, 0, 0]);
    expect(await db.eventLog.count({ where: { storeId: b.id, kind: "google.conversions_account_error" } })).toBe(1);

    // A per-order failure: its try is spent and the tile counts it at once (not only after 5 tries).
    calls = stubGoogle({
      upload: (body) =>
        (body.conversions as { gclid: string }[])[0].gclid.endsWith("B0x") ? partial({ conversionUploadError: "UNPARSEABLE_GCLID" }) : new Response(JSON.stringify({ results: [{}] }), { status: 200 }),
    });
    expect(await google.uploadGoogleConversions(Date.now() + 30_000, { storeId: b.id })).toBe(3);
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: bOrders[0].id } })).googleAdsUploadAttempts).toBe(1);
    expect(await db.eventLog.count({ where: { storeId: b.id, kind: "google.conversion_retrying" } })).toBe(1);
    expect(await db.eventLog.count({ where: { storeId: b.id, kind: "google.conversion_failed" } })).toBe(0);
    expect((await google.googleConversionsHealth(b)).failed24h).toBe(1);

    // Adjustments: an authorization error stops the run too, no try spent.
    const c = await googleStore();
    const toAdjust = await paidOrder(c.id, { utm: { gclid: "Cj0KCQjwc13fixC" }, totalCents: 10_000, subtotalCents: 10_000, refundedCents: 2500, googleAdsUploadedAt: day(1), googleAdsValueCents: 10_000, googleAdsAdjustDue: true });
    calls = stubGoogle({ adjust: () => partial({ authorizationError: "USER_PERMISSION_DENIED" }, "User doesn't have permission.") });
    expect(await google.adjustGoogleConversions(Date.now() + 30_000, { storeId: c.id })).toBe(0);
    const adj = await db.checkoutSession.findUniqueOrThrow({ where: { id: toAdjust.id } });
    expect([adj.googleAdsAdjustAttempts, adj.googleAdsAdjustDue, adj.googleAdsAdjustError?.includes("USER_PERMISSION_DENIED")]).toEqual([0, true, true]);
    expect((await db.eventLog.findFirstOrThrow({ where: { storeId: c.id, kind: "google.conversions_account_error" } })).message).toContain("ajustements suspendus");
  });

  it("'Relancer les conversions abandonnées' and the health probe / tile", async () => {
    const store = await googleStore();
    const abandoned = await paidOrder(store.id, { utm: { gclid: "Cj0KCQjwc13fixAB" }, paidAt: new Date(Date.now() - 2 * DAY), googleAdsUploadAttempts: 5, googleAdsUploadError: "Google Ads : x" });
    const noClickClosed = await paidOrder(store.id, { utm: { gclid: "Cj0KCQjwc13fixNC" }, paidAt: new Date(Date.now() - 2 * DAY), googleAdsUploadAttempts: 5, googleAdsUploadError: "consentement marketing absent" });
    const overdue = await paidOrder(store.id, { utm: { gclid: "Cj0KCQjwc13fixOD" }, paidAt: new Date(Date.now() - 7 * 3600_000), googleAdsUploadAttempts: 1 });
    const adjGaveUp = await paidOrder(store.id, { utm: { gclid: "Cj0KCQjwc13fixAG" }, refundedCents: 1000, googleAdsUploadedAt: new Date(Date.now() - DAY), googleAdsValueCents: 5000, googleAdsAdjustDue: true, googleAdsAdjustAttempts: 5 });
    // A failed replacement order waits for the merchant too.
    const s = await paidOrder(store.id);
    await db.protectionClaim.create({ data: { storeId: store.id, sessionId: s.id, kind: "reship", costCents: 0, status: "approved", replacementError: "x (réponse de Shopify incertaine)", replacementAmbiguousAt: new Date() } });

    expect(await google.googleBacklog(store.id)).toEqual({ uploadsOverdue: 1, uploadsAbandoned: 1, adjustmentsAbandoned: 1 });
    expect((await backlog(store.id)).replacementsFailed).toBe(1);
    const tile = (await storeHealth(store.id)).find((i) => i.key === "pixels")!;
    expect(tile.ok).toBe(false);
    expect(tile.detail).toMatch(/1 en attente depuis plus de 6 h · 1 abandonnée\(s\) \(« Relancer les conversions abandonnées »\) · 1 ajustement\(s\) abandonné\(s\)/);

    const res = await healthRoute.GET(new Request("https://x.test/api/health"), { params: Promise.resolve({}) });
    const body = (await res.json()) as { needsAction: string[]; degraded: string[]; googleUploadsAbandoned: number; googleAdjustmentsAbandoned: number; googleUploadsOverdue: number; replacementsFailed: number };
    expect(body.googleUploadsAbandoned).toBeGreaterThanOrEqual(1);
    expect(body.googleAdjustmentsAbandoned).toBeGreaterThanOrEqual(1);
    expect(body.googleUploadsOverdue).toBeGreaterThanOrEqual(1);
    expect(body.replacementsFailed).toBeGreaterThanOrEqual(1);
    expect(body.needsAction.join("\n")).toMatch(/Google Ads offline conversion\(s\) given up/);
    expect(body.needsAction.join("\n")).toMatch(/Google Ads conversion adjustment\(s\) given up/);
    expect(body.needsAction.join("\n")).toMatch(/replacement order\(s\)/);
    expect(body.degraded.join("\n")).toMatch(/Google Ads offline conversion\(s\) paid > 6 h ago still not uploaded/);

    // The action: given-up uploads and adjustments tried again; orders closed without a try stay closed.
    expect(await google.retryAbandonedGoogleConversions(store.id)).toEqual({ uploads: 2, adjustments: 1 });
    const get = (id: string) => db.checkoutSession.findUniqueOrThrow({ where: { id } });
    expect([(await get(abandoned.id)).googleAdsUploadAttempts, (await get(abandoned.id)).googleAdsUploadError]).toEqual([0, null]);
    expect((await get(noClickClosed.id)).googleAdsUploadAttempts).toBe(5);
    expect((await get(overdue.id)).googleAdsUploadAttempts).toBe(0);
    expect([(await get(adjGaveUp.id)).googleAdsAdjustAttempts, (await get(adjGaveUp.id)).googleAdsAdjustDue]).toEqual([0, true]);
    expect(await google.googleBacklog(store.id)).toMatchObject({ uploadsAbandoned: 0, adjustmentsAbandoned: 0 });
  });

  it("replacement order: no new try for 5 min after an uncertain attempt, then looked up first", async () => {
    const store = await makeStore();
    const s = await paidOrder(store.id, { shopifyOrderName: "#1300" });
    const claim = await db.protectionClaim.create({ data: { storeId: store.id, sessionId: s.id, kind: "reship", costCents: 0, status: "pending", source: "buyer", reason: "lost" } });
    let creates = 0;
    let lookups = 0;
    shopify.shopifyGraphql.mockImplementation(async (_s: unknown, query: string) => {
      if (query.includes("orderCreate")) {
        creates++;
        if (creates === 1) throw new ShopifyError("Shopify injoignable : The operation was aborted due to timeout", true);
        return { orderCreate: { order: { id: "gid://shopify/Order/1302", name: "#1302" }, userErrors: [] } };
      }
      lookups++;
      return { orders: { nodes: [] } };
    });
    const r = await decideClaim(store.id, s.id, claim.id, { approve: true, kind: "reship", costCents: 1800, replacement: true });
    expect(r.replacement).toMatchObject({ error: expect.stringContaining("anti-doublon") });
    let row = await db.protectionClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.replacementAmbiguousAt).toBeInstanceOf(Date);

    // Right away, and even once the 2-min lease is over: refused with the minutes left, nothing sent.
    await expect(createReplacementOrder(store.id, claim.id)).rejects.toThrow("Réessayez dans 5 min");
    await db.protectionClaim.update({ where: { id: claim.id }, data: { replacementStartedAt: new Date(Date.now() - 3 * MIN), replacementAmbiguousAt: new Date(Date.now() - 4.5 * MIN) } });
    await expect(createReplacementOrder(store.id, claim.id)).rejects.toThrow("Réessayez dans 1 min");
    expect([creates, lookups]).toEqual([1, 1]);

    // After 5 min: Shopify is searched first, then the order is created once.
    await db.protectionClaim.update({ where: { id: claim.id }, data: { replacementAmbiguousAt: new Date(Date.now() - 6 * MIN) } });
    expect(await createReplacementOrder(store.id, claim.id)).toEqual({ id: "gid://shopify/Order/1302", name: "#1302" });
    expect([creates, lookups]).toEqual([2, 2]);
    row = await db.protectionClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect([row.replacementOrderName, row.replacementAmbiguousAt, row.replacementError]).toEqual(["#1302", null, null]);
  });

  it("buyer claims: one pending claim per order, even for simultaneous submissions", async () => {
    const store = await makeStore();
    const protection = { id: "shipping_protection", title: "Protection colis", priceCents: 300, variantId: null, costCents: null };
    const s = await paidOrder(store.id, { email: "buyer@c13fix.test" }, [protection]);
    const input = { email: "buyer@c13fix.test", reason: "lost", details: "Colis jamais arrivé" };
    const results = await Promise.all([submitBuyerClaim(s.id, input), submitBuyerClaim(s.id, input), submitBuyerClaim(s.id, input)]);
    const pending = await db.protectionClaim.findMany({ where: { sessionId: s.id, status: "pending" } });
    expect(pending).toHaveLength(1);
    for (const res of results) expect(res.ok ? res.id : res.error).toBe(res.ok ? pending[0].id : "pending");
    expect(await db.eventLog.count({ where: { sessionId: s.id, kind: "protection.claim_reported" } })).toBe(1);
    // The partial unique index itself (a second pending row can't exist).
    await expect(db.protectionClaim.create({ data: { storeId: store.id, sessionId: s.id, kind: "reship", costCents: 0, status: "pending", source: "buyer" } })).rejects.toMatchObject({ code: "P2002" });
    // Decided claims don't count: a new report is possible afterwards.
    await db.protectionClaim.update({ where: { id: pending[0].id }, data: { status: "rejected" } });
    expect((await submitBuyerClaim(s.id, input)).ok).toBe(true);
  });
});
