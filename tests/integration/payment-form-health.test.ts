import { afterAll, describe, expect, it } from "vitest";

/*
 * The checkout page's reports of a missing payment form against a real Postgres: each report from the
 * page (the health route) is journaled for the store, two in the same second included; the store's
 * "payment form" tile counts the buyers (one per session), grey for one, red from two who did not pay
 * afterwards, grey again once one of them paid; the operator's probe (/api/health) never lists these
 * reports.
 */

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("payment form reports (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { encrypt } = await import("@/lib/crypto");
  const { storeHealth } = await import("@/lib/health");
  const healthRoute = await import("@/app/api/health/route");
  const reportRoute = await import("@/app/api/public/sessions/[id]/health/route");
  const created: string[] = [];

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  async function makeStore() {
    const store = await db.store.create({
      data: {
        name: `pfh_${Math.random().toString(36).slice(2, 8)}`,
        testMode: false,
        vatExempt: true,
        whopConnectedAt: new Date(),
        whopAccountId: "biz_pfh",
        whopProductId: "prod_pfh",
        whopApiKey: encrypt("k"),
        shopDomain: `pfh-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com`,
        shopifyAccessToken: encrypt("t"),
        shopifyConnectedAt: new Date(),
        shopifyScopes: "read_products,write_orders,read_discounts",
      },
    });
    created.push(store.id);
    return store;
  }

  const report = (id: string, body: Record<string, unknown>) =>
    reportRoute.POST(
      new Request(`https://checkout.example.com/api/public/sessions/${id}/health`, {
        method: "POST",
        headers: { host: "checkout.example.com", origin: "https://checkout.example.com", "sec-fetch-site": "same-origin", "content-type": "text/plain;charset=UTF-8", "x-vercel-forwarded-for": `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  const tile = async (storeId: string) => (await storeHealth(storeId)).find((i) => i.key === "payment_form")!;

  it("journals the page's reports, counts buyers on the tile, keeps them off the probe", async () => {
    const store = await makeStore();
    const s1 = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [], subtotalCents: 5000 } });
    const s2 = await db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", lines: [], subtotalCents: 5000 } });
    expect(await tile(store.id)).toMatchObject({ ok: true });

    expect((await report(s1.id, { kind: "not_booted", afterReload: false, reloading: true, errors: [], failed: [] })).status).toBe(204);
    // The same buyer again, the same second (the page after its reload): journaled too, one buyer still.
    expect((await report(s1.id, { kind: "not_booted", afterReload: true, reloading: false })).status).toBe(204);
    // A softer signal: in the logs only.
    expect((await report(s1.id, { kind: "still_loading" })).status).toBe(204);
    const rows = await db.eventLog.findMany({ where: { storeId: store.id, kind: "checkout.form_missing" } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.sessionId, r.level, r.message])).toEqual(
      expect.arrayContaining([
        [s1.id, "warn", expect.stringMatching(/page rechargée automatiquement\.$/)],
        [s1.id, "warn", expect.stringMatching(/encore après le rechargement automatique\.$/)],
      ]),
    );
    expect(await tile(store.id)).toMatchObject({ ok: null, detail: expect.stringMatching(/^1 client\(s\)/) });

    expect((await report(s2.id, { kind: "prepare_stuck", provider: "whop" })).status).toBe(204);
    expect(await db.eventLog.count({ where: { storeId: store.id, kind: "checkout.form_missing" } })).toBe(3);
    expect(await tile(store.id)).toMatchObject({ ok: false, detail: expect.stringMatching(/^2 client\(s\)/) });

    await db.checkoutSession.update({ where: { id: s2.id }, data: { status: "PAID" } });
    expect(await tile(store.id)).toMatchObject({ ok: null, detail: expect.stringMatching(/dont 1 ont payé ensuite$/) });

    const res = await healthRoute.GET(new Request("https://x/api/health"), { params: Promise.resolve({}) });
    const body = (await res.json()) as { degraded: string[] };
    expect(body.degraded.some((d) => d.includes("checkout.form_missing"))).toBe(false);
  });
});
