import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The merchant's choice to clip « Propulsé par Whop » off Whop's form (Réglages › Whop), against a
 * real Postgres through the real session code (cookie jar faked): off for every store until asked;
 * the owner's alone (Whop treats that line as its required merchant-of-record notice: the risk is the
 * Whop account's); journaled both ways; shown again, the old checks are forgotten; the checkout clips
 * only on that choice and a good check of the store's own form, with its current Whop account. Test
 * data is prefixed wfc_ and deleted at the end.
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
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));

async function redirectOf(run: () => Promise<unknown>): Promise<{ path: string; ok?: string; error?: string }> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Redirect)) throw err;
    const u = new URL(err.url, "http://x");
    return { path: u.pathname, ok: u.searchParams.get("ok") ?? undefined, error: u.searchParams.get("error") ?? undefined };
  }
  throw new Error("no redirect");
}

describe.skipIf(!hasDb)("« Propulsé par Whop »: the merchant's choice (integration)", async () => {
  const { db } = await import("@/lib/db");
  const auth = await import("@/lib/auth");
  const actions = await import("@/app/dashboard/actions");
  const { whopFooterClipped } = await import("@/lib/whop-footer");
  const tag = `wfc_${Math.random().toString(36).slice(2, 8)}`;
  const stores: string[] = [];
  const users: string[] = [];

  async function user(role: "owner" | "admin") {
    const u = await db.adminUser.create({ data: { email: `${tag}_${role}_${users.length}@test.local`, passwordHash: null, role } });
    users.push(u.id);
    return u;
  }
  async function as(id: string) {
    jar.clear();
    expect(await auth.signIn(id)).toBe(true);
  }

  beforeEach(() => jar.clear());
  afterAll(async () => {
    for (const s of stores) await db.appSetting.deleteMany({ where: { key: { startsWith: `whop:footer:${s}:` } } });
    await db.store.deleteMany({ where: { id: { in: stores } } });
    await db.adminUser.deleteMany({ where: { id: { in: users } } });
  });

  it("off by default; an admin can't change it; the owner can, both ways, journaled; shown again, the old checks go", async () => {
    const store = await db.store.create({ data: { name: `${tag}_store` } });
    stores.push(store.id);
    expect(store.whopFooterHidden).toBe(false);

    const admin = await user("admin");
    await as(admin.id);
    const refused = await redirectOf(() => actions.setWhopFooterHiddenAction(store.id, true));
    expect(refused.error).toBeTruthy();
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).whopFooterHidden).toBe(false);

    const owner = await user("owner");
    await as(owner.id);
    const hidden = await redirectOf(() => actions.setWhopFooterHiddenAction(store.id, true));
    expect(hidden).toMatchObject({ path: `/dashboard/stores/${store.id}/whop` });
    expect(hidden.ok).toMatch(/Masquage demandé/);
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).whopFooterHidden).toBe(true);
    // A check of Whop's form made meanwhile.
    const key = `whop:footer:${store.id}:fr:t-:sandbox.whop.com:-`;
    await db.appSetting.create({ data: { key, value: JSON.stringify({ ok: true, at: new Date().toISOString() }) } });
    const shown = await redirectOf(() => actions.setWhopFooterHiddenAction(store.id, false));
    expect(shown.ok).toMatch(/de nouveau affichée/);
    expect((await db.store.findUniqueOrThrow({ where: { id: store.id } })).whopFooterHidden).toBe(false);
    expect(await db.appSetting.findUnique({ where: { key } })).toBeNull();
    const events = await db.eventLog.findMany({ where: { storeId: store.id, kind: "whop.footer_choice" }, orderBy: { createdAt: "asc" } });
    expect(events.map((e) => (e.data as { hidden: boolean }).hidden)).toEqual([true, false]);
  });

  it("the checkout clips only on the store's choice and a good check of its own form, with its current Whop account", async () => {
    const store = await db.store.create({ data: { name: `${tag}_store_2`, testMode: false, whopAccountId: `${tag}_biz` } });
    stores.push(store.id);
    const variant = { hideTos: true, saveCard: false };
    await db.appSetting.create({ data: { key: `whop:footer:${store.id}:fr:t-:whop.com:${tag}_biz`, value: JSON.stringify({ ok: true, at: new Date().toISOString() }) } });
    expect(await whopFooterClipped(store, "fr", variant)).toBe(false);
    const chosen = await db.store.update({ where: { id: store.id }, data: { whopFooterHidden: true } });
    expect(await whopFooterClipped(chosen, "fr", variant)).toBe(true);
    // Another language, or the store's other form: not checked yet.
    expect(await whopFooterClipped(chosen, "de", variant)).toBe(false);
    expect(await whopFooterClipped(chosen, "fr", { hideTos: false, saveCard: false })).toBe(false);
    // Another Whop account connected, or the store back in test mode: that form isn't checked yet.
    const other = await db.store.update({ where: { id: store.id }, data: { whopAccountId: `${tag}_biz_2` } });
    expect(await whopFooterClipped(other, "fr", variant)).toBe(false);
    expect(await whopFooterClipped({ ...chosen, testMode: true }, "fr", variant)).toBe(false);
  });
});
