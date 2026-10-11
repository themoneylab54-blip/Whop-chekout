import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The store's "payment form" tile: the buyers of the last 24 h whose checkout page reported its form
 * missing (one per session, from the journal), red only from two who did not pay afterwards (one
 * report alone is often a slow phone or a tab closed early; a buyer who paid found a way), grey for a
 * single one, green with none; the operator's probe never counts these reports.
 */

const mocks = vi.hoisted(() => ({
  findEvents: vi.fn<(args: unknown) => Promise<{ sessionId: string | null }[]>>(async () => []),
  countSessions: vi.fn<(args: unknown) => Promise<number>>(async () => 0),
}));
vi.mock("@/lib/db", () => ({ db: { eventLog: { findMany: mocks.findEvents }, checkoutSession: { count: mocks.countSessions } } }));

const { formMissingBuyers, paymentFormItem } = await import("@/lib/health");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findEvents.mockImplementation(async () => []);
  mocks.countSessions.mockImplementation(async () => 0);
});

describe("paymentFormItem", () => {
  it("green with no report, grey for one buyer (or several who paid), red from two who didn't", () => {
    expect(paymentFormItem({ unpaid: 0, total: 0 }, "/b")).toEqual({ key: "payment_form", label: "Formulaire de paiement chez vos clients", ok: true, detail: "Aucun signalement sur 24 h", href: "/b/journal" });
    expect(paymentFormItem({ unpaid: 1, total: 1 }, "/b")).toMatchObject({ ok: null, detail: "1 client(s) dont la page n'a pas affiché le formulaire de paiement sur 24 h" });
    expect(paymentFormItem({ unpaid: 1, total: 4 }, "/b")).toMatchObject({ ok: null, detail: expect.stringMatching(/4 client\(s\).*dont 3 ont payé ensuite$/) });
    expect(paymentFormItem({ unpaid: 2, total: 2 }, "/b").ok).toBe(false);
  });
});

describe("formMissingBuyers", () => {
  it("one buyer per session over 24 h, and those who didn't pay afterwards", async () => {
    mocks.findEvents.mockImplementation(async () => [{ sessionId: "s1" }, { sessionId: "s1" }, { sessionId: "s2" }, { sessionId: null }]);
    mocks.countSessions.mockImplementation(async () => 1);
    expect(await formMissingBuyers("st_1")).toEqual({ unpaid: 1, total: 2 });
    const where = (mocks.findEvents.mock.calls[0][0] as { where: { storeId: string; kind: string; createdAt: { gt: Date } } }).where;
    expect(where).toMatchObject({ storeId: "st_1", kind: "checkout.form_missing" });
    expect(Date.now() - where.createdAt.gt.getTime()).toBeGreaterThanOrEqual(24 * 3600_000 - 1_000);
    expect(mocks.countSessions).toHaveBeenCalledWith({ where: { id: { in: ["s1", "s2"] }, status: { not: "PAID" } } });
  });

  it("no report: no session read", async () => {
    expect(await formMissingBuyers("st_1")).toEqual({ unpaid: 0, total: 0 });
    expect(mocks.countSessions).not.toHaveBeenCalled();
  });
});
