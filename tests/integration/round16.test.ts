import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Round 16 (fixes) against a real Postgres: dispute evidence never swallows a tracking read failure
 * (stored tracking for a checkout order, counted retry or due-anyway send for an offer, deadline released),
 * Shopify's retry out of time throws the real failure, retry jobs stop at a deadline refusal and take the
 * stores in turn, Whop request options per call, money-job starvation (journal, alert, health "down"), the
 * dispute evidence's reserved slice, provider failures evaluated by /api/health, its public output without
 * error text, log.error lines forwarded to Sentry, the late leakage alert and the partial leakage window
 * (TTC). Whop, part of Shopify and notifications are mocked. Test data is prefixed r16fix_ and deleted.
 */

const shopify = vi.hoisted(() => ({
  createPaidOrder: vi.fn(),
  findOrderForSession: vi.fn(),
  findOrderByPayment: vi.fn(),
  tagOrder: vi.fn(),
  priceCart: vi.fn(),
  orderTracking: vi.fn(),
}));
const whop = vi.hoisted(() => ({ disputeUpdate: vi.fn(), disputeSubmit: vi.fn(), list: vi.fn() }));
const notify = vi.hoisted(() => ({ sendAlert: vi.fn(), sendEmail: vi.fn() }));

vi.mock("@/lib/shopify", async (orig) => ({ ...(await orig<typeof import("@/lib/shopify")>()), ...shopify }));
vi.mock("@/lib/whop", async (orig) => ({
  ...(await orig<typeof import("@/lib/whop")>()),
  storeClient: () => ({
    payments: { list: async (p: unknown, o: unknown) => ({ data: (await whop.list(p, o)) as unknown[], response: { page_info: { has_next_page: false, end_cursor: null } } }), retrieve: vi.fn() },
    refunds: { list: async () => ({ data: [], response: { page_info: { has_next_page: false, end_cursor: null } } }) },
    disputes: { update: whop.disputeUpdate, submit: whop.disputeSubmit, list: async () => ({ data: [], response: { page_info: { has_next_page: false, end_cursor: null } } }) },
    shipments: { create: vi.fn() },
  }),
}));
vi.mock("@/lib/notify", async (orig) => ({ ...(await orig<typeof import("@/lib/notify")>()), ...notify }));

const hasDb = !!process.env.DATABASE_URL;
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 86_400_000;

describe.skipIf(!hasDb)("round 16 fixes (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { DeadlineError } = await import("@/lib/deadline");
  const { withLogContext, log, recordEvent } = await import("@/lib/log");
  const { submitDisputeEvidence, MAX_EVIDENCE_TRIES } = await import("@/lib/disputes");
  const { runTick, retrySyncs, starvedJobs, MONEY_JOB_STARVED_MS } = await import("@/lib/tick");
  const { fairByStore } = await import("@/lib/rotation");
  const { retryUpsellSyncs } = await import("@/lib/upsell");
  const { whopCallOptions } = await import("@/lib/whop");
  const realShopify = await vi.importActual<typeof import("@/lib/shopify")>("@/lib/shopify");
  const { ShopifyError } = realShopify;
  const { flushCaptures, resetSentryDedupe } = await import("@/lib/sentry");
  const metrics = await import("@/lib/metrics");
  const { sendLateLeakageAlerts, storeAnalytics, resolveRange, parisDayStart } = await import("@/lib/analytics");
  const { addDays, zonedDay } = await import("@/lib/time");
  const healthRoute = await import("@/app/api/health/route");

  const created: string[] = [];
  const rnd = () => Math.random().toString(36).slice(2, 8);
  const TZ = "Europe/Paris";
  const startedAt = new Date();
  const GLOBAL_KEYS = ["tick:job-ran", "tick:non-money-offset", "tick:starved-alert", "tick:starved-money-alert", "tick:report"];
  const savedGlobals = hasDb ? await db.appSetting.findMany({ where: { key: { in: GLOBAL_KEYS } } }) : [];

  const line = { variantId: "gid://shopify/ProductVariant/16", productId: "gid://shopify/Product/16", productHandle: "gant", title: "Gant", variantTitle: null, sku: null, imageUrl: null, quantity: 1, unitPriceCents: 5000, compareAtCents: null, inventory: null, requiresShipping: true };

  async function makeStore(data: Record<string, unknown> = {}) {
    const store = await db.store.create({
      data: {
        name: `r16fix_${rnd()}`,
        testMode: false,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_r16",
        whopProductId: `prod_r16_${rnd()}`,
        whopApiKey: encrypt("k"),
        shopDomain: `r16fix-${Date.now()}-${rnd()}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        ...data,
      },
    });
    created.push(store.id);
    return store;
  }

  const paidOrder = (storeId: string, data: Record<string, unknown> = {}) =>
    db.checkoutSession.create({
      data: {
        storeId,
        currency: "EUR",
        status: "PAID",
        lines: [line],
        subtotalCents: 5000,
        totalCents: 5000,
        paidAt: new Date(),
        whopPaymentId: `pay_r16_${rnd()}`,
        email: `b-${rnd()}@r16fix.test`,
        shippingAddress: { firstName: "A", lastName: "B", address1: "1 rue X", city: "Paris", zip: "75001", countryCode: "FR" },
        ...data,
      } as never,
      include: { store: true },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    whop.list.mockResolvedValue([]);
    whop.disputeUpdate.mockResolvedValue({});
    whop.disputeSubmit.mockResolvedValue({});
    shopify.findOrderForSession.mockResolvedValue(null);
    shopify.findOrderByPayment.mockResolvedValue(null);
    shopify.createPaidOrder.mockRejectedValue(new Error("unexpected order"));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env.SENTRY_DSN;
    delete process.env.CRON_SECRET;
    await db.eventLog.deleteMany({ where: { kind: { in: ["tick.job_starved", "tick.money_job_starved", "provider.degraded", "tick.job_failed"] }, createdAt: { gte: startedAt } } });
    await db.providerMetric.deleteMany({ where: { provider: { startsWith: "r16fix_" } } });
    await db.appSetting.deleteMany({ where: { OR: [...created.map((id) => ({ key: { contains: id } })), { key: { startsWith: "tick-rotate:r16fix_" } }, { key: { in: GLOBAL_KEYS } }] } });
    for (const row of savedGlobals) await db.appSetting.create({ data: { key: row.key, value: row.value } });
    await db.webhookEvent.deleteMany({ where: { storeId: { in: created } } });
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  /* 1. Dispute evidence and tracking read failures ------------------------------------------------ */

  it("1: a checkout order's evidence falls back to the stored tracking number when Shopify can't be read", async () => {
    const store = await makeStore();
    const s = await paidOrder(store.id, { shopifyOrderId: "gid://shopify/Order/1601", shopifyOrderName: "#1601", disputed: true, disputeId: "dp_r16_a", trackingNumber: "6A16STORED" });
    shopify.orderTracking.mockRejectedValue(new ShopifyError("Shopify API 503: down", true));
    expect(await submitDisputeEvidence(s, "dp_r16_a")).toBe(true);
    const evidence = whop.disputeUpdate.mock.calls[0][0] as { evidence: { notes: string } };
    expect(evidence.evidence.notes).toContain("6A16STORED");
    // Each Whop call bounded when it starts.
    expect(whop.disputeUpdate.mock.calls[0][1]).toMatchObject({ timeoutInSeconds: expect.any(Number) });
    expect((await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } })).disputeEvidenceAt).not.toBeNull();
  });

  it("1: out of time while reading the tracking: the lease is released, no try spent, nothing sent", async () => {
    const store = await makeStore();
    const s = await paidOrder(store.id, { shopifyOrderId: "gid://shopify/Order/1602", disputed: true, disputeId: "dp_r16_b" });
    shopify.orderTracking.mockRejectedValue(new DeadlineError("Shopify"));
    const holder: { partial?: boolean } = {};
    expect(await withLogContext({ tickPartial: holder }, () => submitDisputeEvidence(s, "dp_r16_b"))).toBe(false);
    expect(holder.partial).toBe(true);
    expect(whop.disputeUpdate).not.toHaveBeenCalled();
    const row = await db.checkoutSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(row).toMatchObject({ disputeEvidenceTries: 0, disputeEvidenceStartedAt: null, disputeEvidenceAt: null });
  });

  it("1: an offer's transient tracking failure is a counted retry unless the evidence is due anyway", async () => {
    const store = await makeStore();
    const s = await paidOrder(store.id, { shopifyOrderId: "gid://shopify/Order/1603" });
    const offer = (dueAt: Date | null, tries = 0) =>
      db.upsellCharge.create({
        data: { sessionId: s.id, blockId: `b_${rnd()}`, title: "Écharpe", variantId: "v", amountCents: 900, status: "PAID", whopPaymentId: `pay_o_${rnd()}`, shopifyOrderId: `gid://shopify/Order/o${rnd()}`, disputed: true, disputeId: `dp_o_${rnd()}`, disputeDueAt: dueAt, disputeOpenedAt: new Date(), disputeEvidenceTries: tries },
      });
    const ev = (c: Awaited<ReturnType<typeof offer>>) => ({ id: c.id, title: c.title, amountCents: c.amountCents, paidAt: c.createdAt, shopifyOrderId: c.shopifyOrderId, shopifyOrderName: null });
    shopify.orderTracking.mockRejectedValue(new ShopifyError("Shopify injoignable : fetch failed", true));
    // Due in 10 days: retried with backoff (a counted try), nothing sent.
    const later = await offer(new Date(Date.now() + 10 * DAY));
    expect(await submitDisputeEvidence(s, later.disputeId!, ev(later))).toBe(false);
    expect(whop.disputeUpdate).not.toHaveBeenCalled();
    expect(await db.upsellCharge.findUniqueOrThrow({ where: { id: later.id } })).toMatchObject({ disputeEvidenceTries: 1, disputeEvidenceAt: null });
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "dispute.evidence_failed" } })).toBe(1);
    // Due within 48 h: sent without tracking rather than not at all.
    const soon = await offer(new Date(Date.now() + DAY));
    expect(await submitDisputeEvidence(s, soon.disputeId!, ev(soon))).toBe(true);
    expect((whop.disputeUpdate.mock.calls[0][0] as { evidence: { notes: string } }).evidence.notes).toContain("Numéro de suivi non encore disponible");
    // Last try left (not yet due): sent without tracking too, never given up for a tracking read.
    const last = await offer(new Date(Date.now() + 10 * DAY), MAX_EVIDENCE_TRIES - 1);
    expect(await submitDisputeEvidence(s, last.disputeId!, ev(last))).toBe(true);
  });

  /* 2. Shopify retry out of time; retry jobs ---------------------------------------------------- */

  it("2: no time for Shopify's retry: the first attempt's real (transient) failure is thrown, not a DeadlineError", async () => {
    const store = await makeStore();
    const fetchMock = vi.fn(async () => new Response("unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const call = withLogContext({ hardDeadline: Date.now() + 50_000, jobDeadline: Date.now() + 3_500 }, () => realShopify.shopifyGraphql(store, "query { shop { name } }"));
    await expect(call).rejects.toBeInstanceOf(ShopifyError);
    await expect(call).rejects.toMatchObject({ transient: true, message: expect.stringContaining("503") });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // With time left, the retry happens (2 attempts), and a first call that can't start is still a DeadlineError.
    fetchMock.mockClear();
    await expect(withLogContext({ jobDeadline: Date.now() + 30_000 }, () => realShopify.shopifyGraphql(store, "query { shop { name } }"))).rejects.toBeInstanceOf(ShopifyError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(withLogContext({ jobDeadline: Date.now() + 1_000 }, () => realShopify.shopifyGraphql(store, "query { shop { name } }"))).rejects.toBeInstanceOf(DeadlineError);
  });

  it("2/5: retrySyncs stops at a deadline refusal (partial, lease released, no try spent)", async () => {
    const store = await makeStore();
    const a = await paidOrder(store.id, { paidAt: new Date(Date.now() - 20 * MIN) });
    const b = await paidOrder(store.id, { paidAt: new Date(Date.now() - 19 * MIN) });
    shopify.findOrderForSession.mockRejectedValue(new DeadlineError("Shopify"));
    const holder: { partial?: boolean } = {};
    await withLogContext({ tickPartial: holder }, () => retrySyncs(Date.now() + 30_000));
    expect(holder.partial).toBe(true);
    // Stopped at the first refusal: never tried the next order.
    expect(shopify.findOrderForSession).toHaveBeenCalledTimes(1);
    for (const id of [a.id, b.id]) expect(await db.checkoutSession.findUniqueOrThrow({ where: { id } })).toMatchObject({ syncAttempts: 0, syncStartedAt: null });
  });

  it("2/5: retryUpsellSyncs stops at a deadline refusal too", async () => {
    const store = await makeStore();
    const s = await paidOrder(store.id, { shopifyOrderId: "gid://shopify/Order/1604" });
    for (let i = 0; i < 2; i++)
      await db.upsellCharge.create({ data: { sessionId: s.id, blockId: `b${i}`, title: `Bonnet ${i}`, variantId: "v", amountCents: 700, status: "PAID", whopPaymentId: `pay_u_${rnd()}`, createdAt: new Date(Date.now() - 10 * MIN) } });
    shopify.findOrderForSession.mockRejectedValue(new DeadlineError("Shopify"));
    const holder: { partial?: boolean } = {};
    expect(await withLogContext({ tickPartial: holder }, () => retryUpsellSyncs(Date.now() + 30_000))).toBe(0);
    expect(holder.partial).toBe(true);
    expect(shopify.findOrderForSession).toHaveBeenCalledTimes(1);
  });

  it("2: retry jobs take the stores in turn, rotated from run to run", async () => {
    const items = [
      { id: "1", storeId: "r16fix_A" },
      { id: "2", storeId: "r16fix_A" },
      { id: "3", storeId: "r16fix_A" },
      { id: "4", storeId: "r16fix_B" },
    ];
    const first = await fairByStore("r16fix_job", items);
    expect(first.list.map((i) => i.id)).toEqual(["1", "4", "2", "3"]);
    await first.advance();
    // Next run: store B first (a poisoned item of A can't always be tried first).
    expect((await fairByStore("r16fix_job", items)).list.map((i) => i.id)).toEqual(["4", "1", "2", "3"]);
  });

  /* 4. Whop request options per call ------------------------------------------------------------ */

  it("4: Whop request options are computed per call from the time left", () => {
    expect(whopCallOptions()).toEqual({ timeoutInSeconds: 12, maxRetries: 1 });
    const bounded = withLogContext({ jobDeadline: Date.now() + 8_500 }, () => whopCallOptions());
    expect(bounded.maxRetries).toBe(0);
    expect(bounded.timeoutInSeconds).toBeGreaterThan(7.5);
    expect(bounded.timeoutInSeconds).toBeLessThanOrEqual(8);
    expect(withLogContext({ hardDeadline: Date.now() + 60_000 }, () => whopCallOptions())).toEqual({ timeoutInSeconds: 12, maxRetries: 0 });
    expect(() => withLogContext({ jobDeadline: Date.now() + 1_500 }, () => whopCallOptions())).toThrow(DeadlineError);
  });

  /* 3. Starvation, reserved slice, health --------------------------------------------------------- */

  it("3: dispute evidence keeps a reserved slice once the budget is used; a money job starved > 1 h is journaled, alerted once and makes health down", async () => {
    await makeStore({ alertEmail: "ops@r16fix.test" });
    await db.appSetting.deleteMany({ where: { key: { in: GLOBAL_KEYS } } });
    await db.appSetting.create({ data: { key: "tick:job-ran", value: JSON.stringify({ reconciled: new Date(Date.now() - 2 * HOUR).toISOString() }) } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    // No budget at all: every job is skipped, except those with a reserved slice (evidence, and since
    // round 17 the Shopify order retries and refund mirrors).
    const report = await runTick(-1);
    expect(String(report.syncRetried)).not.toMatch(/time budget used/);
    expect(report.reconciled).toBe("skipped: time budget used");
    expect(String(report.disputeEvidence)).not.toMatch(/time budget used/);
    const ran = JSON.parse((await db.appSetting.findUniqueOrThrow({ where: { key: "tick:job-ran" } })).value) as Record<string, string>;
    // Money jobs are tracked too (clock started for the ones never seen).
    expect(Object.keys(ran)).toEqual(expect.arrayContaining(["reconciled", "disputeEvidence", "providersWatched", "cleaned"]));
    expect((await starvedJobs()).map((j) => j.name)).toEqual(["reconciled"]);
    const logged = await db.eventLog.findMany({ where: { kind: "tick.money_job_starved", createdAt: { gte: startedAt } } });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: "error" });
    expect(logged[0].message).toContain("« reconciled »");
    // Throttled.
    await runTick(-1);
    expect(await db.eventLog.count({ where: { kind: "tick.money_job_starved", createdAt: { gte: startedAt } } })).toBe(1);
    // Starvation is measured at the last tick: a stopped tick is not "every job starving".
    await db.appSetting.update({ where: { key: "tick:job-ran" }, data: { value: JSON.stringify({ reconciled: new Date(Date.now() - 30 * MIN).toISOString() }) } });
    expect(await starvedJobs()).toEqual([]);
    expect(MONEY_JOB_STARVED_MS).toBe(HOUR);
  });

  it("3/7: health evaluates sustained provider failures itself, reports a starved money job as down, and hides error text publicly", async () => {
    const store = await makeStore();
    await db.appSetting.deleteMany({ where: { key: { in: GLOBAL_KEYS } } });
    const tickAt = new Date().toISOString();
    await db.appSetting.create({ data: { key: "tick:report", value: JSON.stringify({ at: tickAt, reconciled: `error: réconciliation impossible pour ${store.name} (jane@r16fix.test)`, ms: 10 }) } });
    await db.appSetting.create({ data: { key: "tick:job-ran", value: JSON.stringify({ refundsReconciled: new Date(Date.now() - 2 * HOUR).toISOString() }) } });
    const bucket = (ago: number) => new Date(Math.floor((Date.now() - ago) / metrics.BUCKET_MS) * metrics.BUCKET_MS);
    for (const ago of [10 * MIN, 5 * MIN, 0]) await db.providerMetric.create({ data: { provider: "r16fix_down", bucket: bucket(ago), calls: 6, errors: 5, lastErrorAt: new Date(), lastError: "HTTP 503" } });
    process.env.CRON_SECRET = "r16fix-secret";
    const res = await healthRoute.GET(new Request("https://x/api/health"), { params: Promise.resolve({}) });
    expect(res.status).toBe(503);
    const text = await res.text();
    const body = JSON.parse(text) as { down: string[]; degraded: string[]; tickErrors: string[]; providers: Record<string, { failingSustained: boolean }>; starvedMoneyJobs: string[]; details?: unknown };
    expect(body.tickErrors).toEqual(["reconciled"]);
    expect(body.down.join(" ")).toContain("tick job errors: reconciled");
    expect(body.down.join(" ")).toContain("money job(s) skipped for lack of time for > 1 h: refundsReconciled");
    expect(body.starvedMoneyJobs).toEqual(["refundsReconciled"]);
    expect(body.degraded.join(" ")).toContain("provider r16fix_down failing for 15 min");
    expect(body.providers.r16fix_down.failingSustained).toBe(true);
    // Public: no raw error text, no store name, no details.
    expect(text).not.toContain(store.name);
    expect(text).not.toContain("réconciliation impossible");
    expect(body.details).toBeUndefined();
    // The operator (CRON_SECRET bearer) gets the details, scrubbed (served from the 10 s cache too).
    const auth = await healthRoute.GET(new Request("https://x/api/health", { headers: { authorization: "Bearer r16fix-secret" } }), { params: Promise.resolve({}) });
    const detailed = (await auth.json()) as { details: { tickErrors: Record<string, string> } };
    expect(detailed.details.tickErrors.reconciled).toContain("réconciliation impossible");
    expect(detailed.details.tickErrors.reconciled).not.toContain("jane@r16fix.test");
    const wrong = await healthRoute.GET(new Request("https://x/api/health", { headers: { authorization: "Bearer nope" } }), { params: Promise.resolve({}) });
    expect(((await wrong.json()) as { details?: unknown }).details).toBeUndefined();
  });

  /* 6. Sentry: log.error lines carrying an err ---------------------------------------------------- */

  it("6: log.error lines with an err go to Sentry (scrubbed, deduped); deadline refusals and already-captured kinds don't", async () => {
    process.env.SENTRY_DSN = "https://pub@o1.ingest.sentry.io/42";
    resetSentryDedupe();
    const sent: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(String(init.body));
        return new Response("{}", { status: 200 });
      }),
    );
    try {
      await withLogContext({ route: "sessions.upsell", requestId: "req_r16" }, async () => {
        log.error("upsell.error", "Upsell request failed", { err: new Error("boom for jane@r16fix.test") });
        log.error("upsell.error", "Upsell request failed", { err: new Error("boom for jane@r16fix.test") });
      });
      log.error("tick.follow_up_failed", "Follow-up failed", { name: "order.sync", err: new DeadlineError("Shopify") });
      log.error("api.unhandled", "Unhandled", { err: new Error("already captured by route()") });
      log.error("webhook.mark_processed_failed", "no err field");
      await recordEvent({ storeId: null, level: "error", kind: "webhook.failed", message: "Événement non traité", err: new Error("handler exploded") });
      await flushCaptures();
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain('"where":"log:upsell.error"');
      expect(sent[0]).toContain('"route":"sessions.upsell"');
      expect(sent[0]).toContain("[email]");
      expect(sent[0]).not.toContain("jane@r16fix.test");
      expect(sent[1]).toContain('"where":"log:webhook.failed"');
      expect(sent[1]).toContain("handler exploded");
      // The error object stays out of the journal row.
      const row = await db.eventLog.findFirst({ where: { kind: "webhook.failed", message: "Événement non traité" }, orderBy: { createdAt: "desc" } });
      expect(JSON.stringify(row?.data ?? {})).not.toContain("handler exploded");
      if (row) await db.eventLog.delete({ where: { id: row.id } });
    } finally {
      delete process.env.SENTRY_DSN;
    }
  });

  /* A / B. Leakage ----------------------------------------------------------------------------- */

  it("A: a day's leakage held by the report (import not past the day) is alerted once an import completes after it", async () => {
    const store = await makeStore({ timezone: TZ, enabled: true });
    const now = new Date();
    const today = zonedDay(now, TZ);
    const yesterday = addDays(today, -1);
    const noon = (d: string) => new Date(parisDayStart(d, TZ).getTime() + 12 * HOUR);
    await paidOrder(store.id, { paidAt: noon(yesterday) });
    for (let i = 0; i < 4; i++)
      await db.externalOrder.create({ data: { storeId: store.id, shopifyOrderId: `gid://shopify/Order/r16${rnd()}`, name: `#w${i}`, orderedAt: noon(yesterday), currency: "EUR", totalCents: 6000, htCents: 5000, countryCode: "FR", sourceName: "web" } });
    // The report for yesterday already went (mark = today), while the import had last run before the day's end.
    await db.appSetting.create({ data: { key: `daily-report:${store.id}`, value: today } });
    const status = (lastRunAt: Date) =>
      JSON.stringify({ since: lastRunAt.toISOString(), after: null, runStartedAt: lastRunAt.toISOString(), lastRunAt: lastRunAt.toISOString(), imported: 4, coveredFrom: new Date(now.getTime() - 20 * DAY).toISOString() });
    await db.appSetting.create({ data: { key: `external-orders:${store.id}`, value: status(new Date(parisDayStart(yesterday, TZ).getTime() + 10 * HOUR)) } });
    const deadline = Date.now() + 60_000;
    // Import still not past yesterday's end: nothing checked, nothing claimed.
    expect(await sendLateLeakageAlerts(deadline, now, { storeId: store.id })).toBe(0);
    expect(await db.appSetting.count({ where: { key: `leakage-alert:${store.id}:${yesterday}` } })).toBe(0);
    // The import completes after midnight: alerted (its own alert), exactly once.
    await db.appSetting.update({ where: { key: `external-orders:${store.id}` }, data: { value: status(new Date(now.getTime() - MIN)) } });
    expect(await sendLateLeakageAlerts(deadline, now, { storeId: store.id })).toBe(1);
    const ev = await db.eventLog.findFirstOrThrow({ where: { storeId: store.id, kind: "analytics.leakage" } });
    expect(ev.message).toContain(yesterday);
    expect(ev.data).toMatchObject({ day: yesterday, late: true, orders: 4 });
    expect(await sendLateLeakageAlerts(deadline, now, { storeId: store.id })).toBe(0);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "analytics.leakage" } })).toBe(1);
  });

  it("A: a day whose report hasn't gone yet is left to the report", async () => {
    const store = await makeStore({ timezone: TZ, enabled: true });
    const now = new Date();
    const yesterday = addDays(zonedDay(now, TZ), -1);
    await db.appSetting.create({ data: { key: `daily-report:${store.id}`, value: yesterday } });
    await db.appSetting.create({ data: { key: `external-orders:${store.id}`, value: JSON.stringify({ since: now.toISOString(), after: null, runStartedAt: null, lastRunAt: now.toISOString(), imported: 0, coveredFrom: new Date(now.getTime() - 20 * DAY).toISOString() }) } });
    expect(await sendLateLeakageAlerts(Date.now() + 60_000, now, { storeId: store.id })).toBe(0);
    expect(await db.appSetting.count({ where: { key: `leakage-alert:${store.id}:${yesterday}` } })).toBe(0);
  });

  it("B: a partial leakage window carries its own orders, HT and TTC", async () => {
    const store = await makeStore();
    const today = zonedDay(new Date(), TZ);
    const noon = (d: string) => new Date(parisDayStart(d, TZ).getTime() + 12 * HOUR);
    await db.appSetting.create({
      data: {
        key: `external-orders:${store.id}`,
        value: JSON.stringify({ since: new Date().toISOString(), after: null, runStartedAt: null, lastRunAt: new Date().toISOString(), imported: 2, coveredFrom: new Date(parisDayStart(addDays(today, -2), TZ).getTime() + 6 * HOUR).toISOString() }),
      },
    });
    const ext = (day: string, cents: number) =>
      db.externalOrder.create({ data: { storeId: store.id, shopifyOrderId: `gid://shopify/Order/r16${rnd()}`, name: "#w", orderedAt: noon(day), currency: "EUR", totalCents: cents, htCents: Math.round(cents / 1.2), countryCode: "FR", sourceName: "web" } });
    await ext(addDays(today, -1), 12000);
    await ext(addDays(today, -4), 6000);
    const range = resolveRange({ range: "custom", from: addDays(today, -6), to: today }, today, "30d", TZ);
    const a = await storeAnalytics(store.id, { since: range.since, until: range.until, includeTest: false });
    expect(a.leakage).toMatchObject({ partial: true, orders: 2, revenueCents: 18000, windowOrders: 1, windowRevenueHtCents: 10000, windowRevenueCents: 12000 });
    // The chart's dotted series sums to the window (days before the coverage are unknown, not 0).
    expect(a.daily.reduce((t, d) => t + (d.externalRevenueHtCents ?? 0), 0)).toBe(10000);
  });
});
