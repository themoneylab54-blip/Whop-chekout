import { afterAll, describe, expect, it } from "vitest";
import { SINCE_ALWAYS, applyCost, costAt, fillBumps, fillLines, normalizeVariantId, parseCostCsv } from "@/lib/costs";

/*
 * "Coûts produits": effective-dated costs, the CSV import, the back-fill of past orders and the
 * page overview. The integration part runs against the isolated test DB.
 */

const V = (n: number) => `gid://shopify/ProductVariant/${n}`;
const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("product costs (pure)", () => {
  it("picks the cost effective at a date", () => {
    const rows = [
      { costCents: 900, effectiveFrom: d("2026-09-01") },
      { costCents: 700, effectiveFrom: SINCE_ALWAYS },
      { costCents: 1000, effectiveFrom: d("2026-09-20") },
    ];
    expect(costAt(rows, d("2025-01-01"))).toBe(700);
    expect(costAt(rows, d("2026-09-01"))).toBe(900);
    expect(costAt(rows, d("2026-09-25"))).toBe(1000);
    expect(costAt([{ costCents: 5, effectiveFrom: d("2026-09-20") }], d("2026-09-01"))).toBeNull();
    expect(costAt([], d("2026-09-01"))).toBeNull();
  });

  it("parses « variant_id;coût » lines", () => {
    const { rows, errors } = parseCostCsv(`variant_id;coût\n44012345678901;12,50\n${V(7)};"1 234,5"\nabc;3\n44012345678902;-1\n44012345678901;13`);
    expect(rows).toEqual([
      { line: 6, variantId: V(44012345678901), costCents: 1300 },
      { line: 3, variantId: V(7), costCents: 123450 },
    ]);
    expect(errors.map((e) => [e.line, e.message.slice(0, 20)])).toEqual([
      [4, "Identifiant de varia"],
      [5, "Coût invalide « -1 »"],
      [6, "Doublon : cette lign"],
    ]);
    // Comma separator with a decimal comma split in two.
    expect(parseCostCsv("123,12,50").rows).toEqual([{ line: 1, variantId: V(123), costCents: 1250 }]);
    expect(normalizeVariantId(" 42 ")).toBe(V(42));
    expect(normalizeVariantId("gid://shopify/Product/42")).toBeNull();
  });

  it("fills missing line costs, overrides Shopify's with the app cost and restores it when the app cost goes", () => {
    const index = new Map([[V(1), [{ costCents: 800, effectiveFrom: SINCE_ALWAYS }]]]);
    const lines = [
      { variantId: V(1), quantity: 2 },
      { variantId: V(1), quantity: 1, unitCostCents: 500 },
      { variantId: V(2), quantity: 1 },
      { variantId: V(1), quantity: 1, unitCostCents: 600, unitCostSource: "app" },
      { variantId: V(2), quantity: 1, unitCostCents: 300 },
    ];
    const r = fillLines(lines, index, d("2026-09-01"));
    // Filled (no cost) ; Shopify 500 overridden ; missing ; app cost followed ; Shopify kept (no app cost).
    expect([r.filled, r.updated, r.missing]).toEqual([1, 2, 1]);
    expect(r.lines.map((l) => [l.unitCostCents ?? null, l.unitCostSource ?? null, l.shopifyUnitCostCents ?? null])).toEqual([
      [800, "app", null],
      [800, "app", 500],
      [null, null, null],
      [800, "app", null],
      [300, null, null],
    ]);
    // Idempotent.
    const again = fillLines(r.lines, index, d("2026-09-01"));
    expect([again.filled, again.updated]).toEqual([0, 0]);
    // App cost removed: Shopify's comes back; a line only the app had goes back to "missing".
    const gone = fillLines(r.lines, new Map(), d("2026-09-01"));
    expect(gone.lines.map((l) => [l.unitCostCents ?? null, "unitCostSource" in l, "shopifyUnitCostCents" in l])).toEqual([
      [null, false, false],
      [500, false, false],
      [null, false, false],
      [null, false, false],
      [300, false, false],
    ]);
    expect([gone.updated, gone.missing]).toEqual([3, 3]);
    // Before its effective date, the app cost doesn't apply.
    const later = new Map([[V(1), [{ costCents: 900, effectiveFrom: d("2026-10-01") }]]]);
    expect(fillLines([{ variantId: V(1), quantity: 1, unitCostCents: 500 }], later, d("2026-09-01")).lines[0].unitCostCents).toBe(500);
  });

  it("applies the same precedence to one offer and fills bumps without a typed cost", () => {
    expect(applyCost({ cost: 500, source: null, shopify: null }, 800)).toEqual({ cost: 800, source: "app", shopify: 500, change: "updated" });
    expect(applyCost({ cost: null, source: null, shopify: null }, 800)).toEqual({ cost: 800, source: "app", shopify: null, change: "filled" });
    expect(applyCost({ cost: 800, source: "app", shopify: 500 }, null)).toEqual({ cost: 500, source: null, shopify: null, change: "updated" });
    expect(applyCost({ cost: 500, source: null, shopify: null }, null).change).toBeNull();
    const index = new Map([[V(5), [{ costCents: 120, effectiveFrom: SINCE_ALWAYS }]]]);
    const b = fillBumps(
      [
        { id: "a", variantId: V(5), costCents: null },
        { id: "b", variantId: V(5), costCents: 90 },
        { id: "c", variantId: null, costCents: null },
      ],
      index,
      d("2026-09-01"),
    );
    expect(b.changed).toBe(1);
    expect(b.addOns.map((x) => [x.costCents ?? null, x.costSource ?? null])).toEqual([
      [120, "app"],
      [90, null],
      [null, null],
    ]);
    expect(fillBumps(b.addOns, new Map(), d("2026-09-01")).addOns[0]).toEqual({ id: "a", variantId: V(5), costCents: null });
  });
});

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("product costs (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { costFor, setProductCost, deleteProductCost, recomputeMissingCosts, variantCostOverview } = await import("@/lib/costs");
  const { storeAnalytics, resolveRange } = await import("@/lib/analytics");
  const created: string[] = [];
  const line = (o: Record<string, unknown> = {}) => ({
    variantId: V(1),
    productId: "gid://shopify/Product/1",
    productHandle: "sweat",
    title: "Sweat",
    variantTitle: "M",
    sku: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 6000,
    compareAtCents: null,
    inventory: null,
    requiresShipping: false,
    ...o,
  });

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("stores effective-dated costs, back-fills past orders and offers, and feeds Analytics", async () => {
    const store = await db.store.create({ data: { name: "Costs IT", testMode: false } });
    created.push(store.id);
    const today = resolveRange({ range: "today" });
    const now = new Date(Math.max(today.since.getTime() + 60_000, Date.now() - 5 * 60_000));
    const old = new Date(Date.now() - 20 * 86_400_000);

    await setProductCost(store.id, { variantId: V(1), costCents: 1500, title: "Sweat – M" });
    const changed = new Date(Date.now() - 10 * 86_400_000);
    await setProductCost(store.id, { variantId: V(1), costCents: 2000, effectiveFrom: changed });
    // Same variant + date = correction, not a new entry.
    await setProductCost(store.id, { variantId: V(1), costCents: 2100, effectiveFrom: changed });
    expect(await db.productCost.count({ where: { storeId: store.id } })).toBe(2);
    expect(await costFor(store.id, V(1), old)).toBe(1500);
    expect(await costFor(store.id, V(1), now)).toBe(2100);
    expect(await costFor(store.id, V(9), now)).toBeNull();

    const paid = (at: Date, lines: unknown[]) =>
      db.checkoutSession.create({ data: { storeId: store.id, currency: "EUR", status: "PAID", paidAt: at, createdAt: at, lines: lines as never, subtotalCents: 6000, totalCents: 6000, whopFeeCents: 0 } });
    const a = await paid(old, [line({ quantity: 2 })]);
    const b = await paid(now, [line(), line({ variantId: V(2), unitCostCents: 999 }), line({ variantId: V(3) })]);
    await db.upsellCharge.create({ data: { sessionId: b.id, blockId: "o1", title: "Sweat", variantId: V(1), amountCents: 3000, status: "PAID", whopFeeCents: 0 } });
    await db.upsellCharge.create({ data: { sessionId: b.id, blockId: "o2", title: "Bonnet", variantId: V(3), amountCents: 1000, status: "PAID", whopFeeCents: 0 } });

    const before = await variantCostOverview(store.id);
    expect(Object.fromEntries(before.map((r) => [r.variantId, [r.source, r.currentCents, r.missingLines]]))).toEqual({
      [V(1)]: ["app", 2100, 3],
      [V(2)]: ["shopify", 999, 0],
      [V(3)]: ["missing", null, 2],
    });

    const r = await recomputeMissingCosts(store.id);
    expect(r).toEqual({ linesFilled: 2, linesUpdated: 0, linesMissing: 1, sessions: 2, chargesFilled: 1, chargesMissing: 1, bumpsFilled: 0 });
    const la = (await db.checkoutSession.findUniqueOrThrow({ where: { id: a.id } })).lines as { unitCostCents: number; unitCostSource?: string }[];
    expect([la[0].unitCostCents, la[0].unitCostSource]).toEqual([1500, "app"]);
    const lb = (await db.checkoutSession.findUniqueOrThrow({ where: { id: b.id } })).lines as { unitCostCents?: number | null }[];
    expect(lb.map((l) => l.unitCostCents ?? null)).toEqual([2100, 999, null]);
    expect((await db.upsellCharge.findMany({ where: { sessionId: b.id }, orderBy: { blockId: "asc" } })).map((u) => u.costCents)).toEqual([2100, null]);

    // Analytics reads the snapshots: today's product costs = 2100 + 999 + offer 2100.
    const an = await storeAnalytics(store.id, { since: today.since, until: today.until, includeTest: false });
    expect(an.profit.cogsCents).toBe(2100 + 999 + 2100);

    // Correcting a cost updates the lines the app filled; a second run is idempotent.
    const entries = await db.productCost.findMany({ where: { storeId: store.id }, orderBy: { effectiveFrom: "asc" } });
    await setProductCost(store.id, { variantId: V(1), costCents: 1600, effectiveFrom: entries[0].effectiveFrom });
    expect(await recomputeMissingCosts(store.id)).toMatchObject({ linesFilled: 0, linesUpdated: 1, sessions: 1 });
    expect(await recomputeMissingCosts(store.id)).toMatchObject({ linesFilled: 0, linesUpdated: 0, sessions: 0, linesMissing: 1 });
    expect(await deleteProductCost(store.id, entries[1].id)).toBe(true);
    expect(await deleteProductCost("other-store", entries[0].id)).toBe(false);
    const after = await variantCostOverview(store.id);
    expect(after.find((x) => x.variantId === V(1))).toMatchObject({ source: "app", currentCents: 1600, history: [expect.objectContaining({ costCents: 1600 })] });
  });
});
