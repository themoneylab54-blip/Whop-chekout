import { afterAll, describe, expect, it } from "vitest";

/*
 * UX round 12 against a real Postgres: the ⌘K order search finds a buyer by name (shipping
 * address JSON, "Prénom Nom" or "Nom Prénom", case-insensitive),
 * scoped to the store. Test data is prefixed ux12fix_ and deleted at the end.
 */

const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("⌘K name search (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { sessionIdsByBuyerName } = await import("@/lib/order-search");
  const created: string[] = [];

  async function store() {
    const s = await db.store.create({ data: { name: `ux12fix_${Math.random().toString(36).slice(2, 8)}`, shopDomain: `ux12fix-${Date.now()}-${Math.random().toString(36).slice(2)}.myshopify.com` } });
    created.push(s.id);
    return s;
  }
  const address = (firstName: string, lastName: string) => ({ firstName, lastName, address1: "1 rue", address2: "", city: "Paris", province: "", zip: "75001", countryCode: "FR", phone: "" });

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("matches first + last name in both orders, only in the store", async () => {
    const a = await store();
    const b = await store();
    const marie = await db.checkoutSession.create({ data: { storeId: a.id, currency: "EUR", lines: [], status: "PAID", paidAt: new Date(), shippingAddress: address("Marie", "Dupont-Ux12") } });
    await db.checkoutSession.create({ data: { storeId: a.id, currency: "EUR", lines: [], shippingAddress: address("Jean", "Martin-Ux12") } });
    await db.checkoutSession.create({ data: { storeId: b.id, currency: "EUR", lines: [], shippingAddress: address("Marie", "Dupont-Ux12") } });
    expect(await sessionIdsByBuyerName(a.id, "marie dupont-ux12")).toEqual([marie.id]);
    expect(await sessionIdsByBuyerName(a.id, "DUPONT-UX12 Marie")).toEqual([marie.id]);
    expect(await sessionIdsByBuyerName(a.id, "dupont-ux")).toEqual([marie.id]);
    expect(await sessionIdsByBuyerName(a.id, "%")).toEqual([]);
    expect(await sessionIdsByBuyerName(a.id, "x")).toEqual([]);
  });
});
