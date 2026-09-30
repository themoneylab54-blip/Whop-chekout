import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Ids used with an owner-only token (pixels, ad accounts, GA4, Google Ads conversion action,
 * Telegram chat, Resend sender, Mondial Relay enseigne), against a real Postgres through the real
 * session code (cookie jar faked): while the token is stored, only the owner may change the id — a
 * non-owner's other fields are still saved and the refusal names the field. And the Stripe Connect
 * callback with a bad state only goes back to a store the user may open. Test data: obi_.
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
const reqHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", async (orig) => ({
  ...(await orig<typeof import("next/headers")>()),
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
  }),
  headers: async () => reqHeaders.current,
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

async function redirectOf(run: () => Promise<unknown>): Promise<{ path: string; search: URLSearchParams; ok?: string; error?: string }> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Redirect)) throw err;
    const u = new URL(err.url, "http://x");
    return { path: u.pathname, search: u.searchParams, ok: u.searchParams.get("ok") ?? undefined, error: u.searchParams.get("error") ?? undefined };
  }
  throw new Error("no redirect");
}

const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
};

describe("resolveOwnerBound (pure)", async () => {
  const { resolveOwnerBound, ownerBoundError, ownerBoundLocked, googleAdsTokenStored } = await import("@/lib/owner-bound");

  it("a changed id is kept for a non-owner only while its token is stored", () => {
    const fields = {
      metaPixelId: { next: "222", current: "111", tokenStored: true },
      tiktokPixelId: { next: "NEW", current: "OLD", tokenStored: false },
      ga4MeasurementId: { next: "G-SAME", current: "G-SAME", tokenStored: true },
    };
    expect(resolveOwnerBound("admin", fields)).toEqual({ values: { metaPixelId: "111", tiktokPixelId: "NEW", ga4MeasurementId: "G-SAME" }, refused: ["metaPixelId"] });
    expect(resolveOwnerBound("viewer", fields).refused).toEqual(["metaPixelId"]);
    expect(resolveOwnerBound("owner", fields)).toEqual({ values: { metaPixelId: "222", tiktokPixelId: "NEW", ga4MeasurementId: "G-SAME" }, refused: [] });
  });

  it("blank and null are the same value; clearing counts as a change", () => {
    expect(resolveOwnerBound("admin", { emailFrom: { next: "", current: null, tokenStored: true } })).toEqual({ values: { emailFrom: null }, refused: [] });
    expect(resolveOwnerBound("admin", { emailFrom: { next: null, current: "a@b.fr", tokenStored: true } })).toEqual({ values: { emailFrom: "a@b.fr" }, refused: ["emailFrom"] });
  });

  it("French refusal naming the fields; lock and Google Ads helpers", () => {
    expect(ownerBoundError(["metaPixelId"])).toMatch(/^Seul le propriétaire du compte peut changer l'ID du pixel Meta : .* Les autres réglages ont été enregistrés\.$/);
    expect(ownerBoundError(["emailFrom", "telegramChatId"], false)).toMatch(/l'expéditeur des e-mails et l'ID de conversation Telegram : [^.]*\.$/);
    expect(ownerBoundLocked("admin", true)).toBe(true);
    expect(ownerBoundLocked("admin", false)).toBe(false);
    expect(ownerBoundLocked("owner", true)).toBe(false);
    expect(googleAdsTokenStored({ googleAdsRefreshToken: null, googleAdsDeveloperToken: null, googleAdsClientSecret: null })).toBe(false);
    expect(googleAdsTokenStored({ googleAdsRefreshToken: "enc", googleAdsDeveloperToken: null, googleAdsClientSecret: null })).toBe(true);
  });
});

describe.skipIf(!hasDb)("owner-bound ids (integration)", async () => {
  const { db } = await import("@/lib/db");
  const auth = await import("@/lib/auth");
  const actions = await import("@/app/dashboard/actions");
  const adActions = await import("@/app/dashboard/stores/[storeId]/(main)/analytics/actions");
  const callbackRoute = await import("@/app/api/stripe/connect/callback/route");
  const { signStripeState } = await import("@/lib/stripe-state");
  const tag = `obi_${Math.random().toString(36).slice(2, 8)}`;
  const stores: string[] = [];
  const users: string[] = [];
  const ctx = { params: Promise.resolve({}) };

  async function store(data: Record<string, unknown> = {}) {
    const s = await db.store.create({ data: { name: `${tag}_store_${stores.length}`, ...data } });
    stores.push(s.id);
    return s;
  }
  async function user(role: "owner" | "admin" | "viewer", data: Record<string, unknown> = {}) {
    const u = await db.adminUser.create({ data: { email: `${tag}_${role}_${users.length}@test.local`, passwordHash: null, role, ...data } });
    users.push(u.id);
    return u;
  }
  async function as(id: string) {
    jar.clear();
    expect(await auth.signIn(id)).toBe(true);
  }
  const reload = (id: string) => db.store.findUniqueOrThrow({ where: { id } });

  beforeEach(() => {
    jar.clear();
    reqHeaders.current = new Headers();
  });

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: stores } } });
    await db.adminUser.deleteMany({ where: { id: { in: users } } });
  });

  describe("saveTrackingAction (pixels, GA4)", () => {
    const tracking = { metaPixelId: "999999999", tiktokPixelId: "NEWTIKTOK", ga4MeasurementId: "G-NEW1234", metaTestEventCode: "TEST9", conversionValueMode: "revenue" };

    it("admin with the tokens stored: ids kept, other fields saved, refusal names the field", async () => {
      const s = await store({ metaPixelId: "111111111", metaAccessToken: "enc", tiktokPixelId: "OLDTIKTOK", tiktokAccessToken: "enc", ga4MeasurementId: "G-OLD1234", ga4ApiSecret: "enc" });
      await as((await user("admin")).id);
      const r = await redirectOf(() => actions.saveTrackingAction(s.id, form(tracking)));
      expect(r.path).toBe(`/dashboard/stores/${s.id}/growth`);
      expect(r.error).toMatch(/^Seul le propriétaire du compte peut changer l'ID du pixel Meta, le code du pixel TikTok et l'ID de mesure GA4 .*autres réglages ont été enregistrés/);
      expect(r.search.get("field")).toBe("metaPixelId");
      expect(await reload(s.id)).toMatchObject({
        metaPixelId: "111111111",
        tiktokPixelId: "OLDTIKTOK",
        ga4MeasurementId: "G-OLD1234",
        metaAccessToken: "enc",
        tiktokAccessToken: "enc",
        ga4ApiSecret: "enc",
        metaTestEventCode: "TEST9",
      });
    });

    it("admin, unchanged ids (the read-only fields as submitted): saved without refusal", async () => {
      const s = await store({ metaPixelId: "111111111", metaAccessToken: "enc" });
      await as((await user("admin")).id);
      const r = await redirectOf(() => actions.saveTrackingAction(s.id, form({ ...tracking, metaPixelId: "111111111", tiktokPixelId: "", ga4MeasurementId: "" })));
      expect(r).toMatchObject({ ok: "Pixels enregistrés" });
      expect(await reload(s.id)).toMatchObject({ metaPixelId: "111111111", metaTestEventCode: "TEST9" });
    });

    it("admin without a stored token: ids are plain settings", async () => {
      const s = await store({ metaPixelId: "111111111" });
      await as((await user("admin")).id);
      expect(await redirectOf(() => actions.saveTrackingAction(s.id, form(tracking)))).toMatchObject({ ok: "Pixels enregistrés" });
      expect(await reload(s.id)).toMatchObject({ metaPixelId: "999999999", tiktokPixelId: "NEWTIKTOK", ga4MeasurementId: "G-NEW1234" });
    });

    it("owner may change them with the tokens stored", async () => {
      const s = await store({ metaPixelId: "111111111", metaAccessToken: "enc", ga4MeasurementId: "G-OLD1234", ga4ApiSecret: "enc" });
      await as((await user("owner")).id);
      expect(await redirectOf(() => actions.saveTrackingAction(s.id, form(tracking)))).toMatchObject({ ok: "Pixels enregistrés" });
      expect(await reload(s.id)).toMatchObject({ metaPixelId: "999999999", ga4MeasurementId: "G-NEW1234", metaAccessToken: "enc" });
    });
  });

  describe("saveAdAccountsAction (Meta / TikTok ad accounts)", () => {
    it("admin: the Meta account (token stored) is kept, the TikTok one (no token) saved", async () => {
      const s = await store({ metaAdAccountId: "123456789", metaAccessToken: "enc" });
      await as((await user("admin")).id);
      const r = await redirectOf(() => adActions.saveAdAccountsAction(s.id, form({ metaAdAccountId: "act_987654321", tiktokAdvertiserId: "7012345678" })));
      expect(r.path).toBe(`/dashboard/stores/${s.id}/growth`);
      expect(r.error).toMatch(/l'ID du compte publicitaire Meta/);
      expect(r.search.get("field")).toBe("metaAdAccountId");
      expect(await reload(s.id)).toMatchObject({ metaAdAccountId: "123456789", tiktokAdvertiserId: "7012345678" });
    });

    it("admin can't clear a TikTok account with its token stored; same value (act_ prefix) passes", async () => {
      const s = await store({ metaAdAccountId: "123456789", metaAccessToken: "enc", tiktokAdvertiserId: "7012345678", tiktokAccessToken: "enc" });
      await as((await user("admin")).id);
      expect((await redirectOf(() => adActions.saveAdAccountsAction(s.id, form({ metaAdAccountId: "act_123456789", tiktokAdvertiserId: "" })))).search.get("field")).toBe("tiktokAdvertiserId");
      expect(await reload(s.id)).toMatchObject({ metaAdAccountId: "123456789", tiktokAdvertiserId: "7012345678" });
      expect((await redirectOf(() => adActions.saveAdAccountsAction(s.id, form({ metaAdAccountId: "act_123456789", tiktokAdvertiserId: "7012345678" })))).ok).toMatch(/Comptes publicitaires enregistrés/);
    });

    it("owner may repoint them", async () => {
      const s = await store({ metaAdAccountId: "123456789", metaAccessToken: "enc" });
      await as((await user("owner")).id);
      expect((await redirectOf(() => adActions.saveAdAccountsAction(s.id, form({ metaAdAccountId: "987654321", tiktokAdvertiserId: "" })))).ok).toBeTruthy();
      expect((await reload(s.id)).metaAdAccountId).toBe("987654321");
    });
  });

  describe("saveGoogleConversionAction", () => {
    it("admin refused with Google Ads credentials stored; allowed without; owner allowed", async () => {
      const s = await store({ googleAdsCustomerId: "1234567890", googleAdsRefreshToken: "enc", googleAdsConversionAction: "customers/1234567890/conversionActions/1" });
      await as((await user("admin")).id);
      const r = await redirectOf(() => adActions.saveGoogleConversionAction(s.id, form({ googleAdsConversionAction: "customers/9999999999/conversionActions/5" })));
      expect(r.error).toMatch(/^Seul le propriétaire du compte peut changer l'action de conversion Google Ads/);
      expect(r.search.get("field")).toBe("googleAdsConversionAction");
      expect((await reload(s.id)).googleAdsConversionAction).toBe("customers/1234567890/conversionActions/1");

      const bare = await store({ googleAdsCustomerId: "1234567890" });
      expect((await redirectOf(() => adActions.saveGoogleConversionAction(bare.id, form({ googleAdsConversionAction: "42" })))).error).toBeUndefined();
      expect((await reload(bare.id)).googleAdsConversionAction).toBe("customers/1234567890/conversionActions/42");

      await as((await user("owner")).id);
      expect((await redirectOf(() => adActions.saveGoogleConversionAction(s.id, form({ googleAdsConversionAction: "7" })))).error).toBeUndefined();
      expect((await reload(s.id)).googleAdsConversionAction).toBe("customers/1234567890/conversionActions/7");
    });
  });

  describe("saveAlertsAction (Resend sender, Telegram chat)", () => {
    it("admin: sender and chat kept with the owner's keys stored, the alert e-mail saved; directly and through the save bar", async () => {
      const s = await store({ emailFrom: "Alertes <a@shop.fr>", resendApiKey: "enc", telegramChatId: "111", telegramBotToken: "enc", alertEmail: "old@shop.fr" });
      await as((await user("admin")).id);
      const r = await redirectOf(() => actions.saveAlertsAction(s.id, form({ alertEmail: "new@shop.fr", emailFrom: "Pirate <x@evil.fr>", telegramChatId: "-999" })));
      expect(r.path).toBe(`/dashboard/stores/${s.id}/settings`);
      expect(r.error).toMatch(/l'expéditeur des e-mails et l'ID de conversation Telegram/);
      expect(r.search.get("field")).toBe("emailFrom");
      expect(await reload(s.id)).toMatchObject({ alertEmail: "new@shop.fr", emailFrom: "Alertes <a@shop.fr>", telegramChatId: "111", resendApiKey: "enc", telegramBotToken: "enc" });

      const batch = form({ __section: "Alertes", "Alertes::alertEmail": "b@shop.fr", "Alertes::emailFrom": "Alertes <a@shop.fr>", "Alertes::telegramChatId": "-5" });
      const rb = await redirectOf(() => actions.saveSettingsBatchAction(s.id, batch));
      expect(rb.error).toMatch(/^Alertes : Seul le propriétaire du compte peut changer l'ID de conversation Telegram/);
      expect(await reload(s.id)).toMatchObject({ alertEmail: "b@shop.fr", telegramChatId: "111" });
    });

    it("admin without keys stored sets them; owner changes them with keys stored", async () => {
      const s = await store();
      await as((await user("admin")).id);
      expect(await redirectOf(() => actions.saveAlertsAction(s.id, form({ alertEmail: "", emailFrom: "a@shop.fr", telegramChatId: "123" })))).toMatchObject({ ok: "Alertes enregistrées" });
      expect(await reload(s.id)).toMatchObject({ emailFrom: "a@shop.fr", telegramChatId: "123" });

      const k = await store({ emailFrom: "a@shop.fr", resendApiKey: "enc", telegramChatId: "1", telegramBotToken: "enc" });
      await as((await user("owner")).id);
      expect(await redirectOf(() => actions.saveAlertsAction(k.id, form({ alertEmail: "", emailFrom: "b@shop.fr", telegramChatId: "2" })))).toMatchObject({ ok: "Alertes enregistrées" });
      expect(await reload(k.id)).toMatchObject({ emailFrom: "b@shop.fr", telegramChatId: "2", resendApiKey: "enc" });
    });
  });

  describe("savePickupAction (Mondial Relay enseigne)", () => {
    it("admin can't change the enseigne with the owner's key stored; can without", async () => {
      const s = await store({ mondialRelayEnseigne: "BDTEST13", mondialRelayKey: "enc" });
      await as((await user("admin")).id);
      const r = await redirectOf(() => actions.savePickupAction(s.id, form({ mondialRelayEnseigne: "OTHER1" })));
      expect(r.error).toMatch(/le code enseigne Mondial Relay/);
      expect(r.error).not.toMatch(/autres réglages/);
      expect(r.search.get("field")).toBe("mondialRelayEnseigne");
      expect(await reload(s.id)).toMatchObject({ mondialRelayEnseigne: "BDTEST13", mondialRelayKey: "enc" });

      const bare = await store();
      expect((await redirectOf(() => actions.savePickupAction(bare.id, form({ mondialRelayEnseigne: "BDTEST13" })))).error).toBeUndefined();
      expect((await reload(bare.id)).mondialRelayEnseigne).toBe("BDTEST13");
    });
  });

  describe("Stripe Connect callback with a bad state", () => {
    const callback = (storeId: string) =>
      callbackRoute.GET(new Request(`https://app.test/api/stripe/connect/callback?${new URLSearchParams({ state: signStripeState({ storeId, mode: "test", nonce: "n" }), code: "c" })}`), ctx);

    it("back on the store's Stripe page only when the user may open it, else /dashboard", async () => {
      const [mine, other] = [await store(), await store()];
      const u = await user("admin", { allStores: false, storeAccess: { create: [{ storeId: mine.id }] } });
      await as(u.id);
      const own = new URL((await callback(mine.id)).headers.get("location") ?? "");
      expect(own.pathname).toBe(`/dashboard/stores/${mine.id}/stripe`);
      expect(own.searchParams.get("error")).toMatch(/Lien de connexion Stripe expiré/);

      const foreign = new URL((await callback(other.id)).headers.get("location") ?? "");
      expect(foreign.pathname).toBe("/dashboard");
      expect(foreign.search).toBe("");
    });

    it("signed out: to /login", async () => {
      const s = await store();
      expect(new URL((await callback(s.id)).headers.get("location") ?? "").pathname).toBe("/login");
    });
  });
});
