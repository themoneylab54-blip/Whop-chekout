import { beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Whop's receipt to buyers names the Whop product: it is the store's name (no "— Checkout"),
 * older products are renamed once (remembered in AppSetting, no Whop call on later checkouts,
 * a refused rename never blocks anything, and never delays the checkout: run in the background).
 * Whop's own buyer e-mails (send_customer_emails) are an ACCOUNT-wide setting: never changed by
 * the connection, only by the owner's explicit switch (setWhopCustomerEmails); its state is read
 * from accounts.me and cached.
 */

const sdk = vi.hoisted(() => ({
  me: vi.fn(),
  accountsUpdate: vi.fn(),
  productsList: vi.fn(),
  productsCreate: vi.fn(),
  productsUpdate: vi.fn(),
  webhooksList: vi.fn(),
  webhooksCreate: vi.fn(),
  webhooksDelete: vi.fn(),
  configCreate: vi.fn(),
}));
const store = vi.hoisted(() => ({ settings: new Map<string, string>() }));

vi.mock("@whop/sdk", () => ({
  WhopEnvironment: { Sandbox: "sandbox", Production: "production" },
  WhopClient: class {
    accounts = { me: sdk.me, update: sdk.accountsUpdate };
    products = { list: sdk.productsList, create: sdk.productsCreate, update: sdk.productsUpdate };
    webhooks = { list: sdk.webhooksList, create: sdk.webhooksCreate, delete: sdk.webhooksDelete };
    checkoutConfigurations = { create: sdk.configCreate };
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    appSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) => (store.settings.has(where.key) ? { key: where.key, value: store.settings.get(where.key) } : null)),
      upsert: vi.fn(async ({ where, create }: { where: { key: string }; create: { value: string } }) => store.settings.set(where.key, create.value)),
    },
  },
}));
vi.mock("@/lib/log", async (orig) => ({ ...(await orig<typeof import("@/lib/log")>()), recordEvent: vi.fn() }));

const { setupWhop, createCheckoutConfiguration, whopProductTitle, settleProductTitleSyncs, whopCustomerEmailsStatus, setWhopCustomerEmails, whopSupportEmailsMessage, whopEmailsControls } = await import("@/lib/whop");
const { encrypt } = await import("@/lib/crypto");

const account = (over: Record<string, unknown> = {}) => ({ id: "biz_t", business_name: "Biz", route: "biz", send_customer_emails: true, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  store.settings.clear();
  sdk.me.mockResolvedValue(account());
  sdk.accountsUpdate.mockImplementation(async (p: { send_customer_emails: boolean }) => account({ send_customer_emails: p.send_customer_emails }));
  sdk.productsList.mockResolvedValue([]);
  sdk.productsCreate.mockImplementation(async (p: { title: string }) => ({ id: "prod_new", title: p.title }));
  sdk.productsUpdate.mockImplementation(async (p: { id: string; title: string }) => ({ id: p.id, title: p.title }));
  sdk.webhooksList.mockResolvedValue([]);
  sdk.webhooksCreate.mockResolvedValue({ id: "hook_1", webhook_secret: "ws_1" });
  sdk.configCreate.mockResolvedValue({ id: "ch_1", purchase_url: null, effective_payment_method_configuration: null });
});

describe("whopProductTitle", () => {
  it("is just the store's name (trimmed, 80 chars max), 'Boutique' without one", () => {
    expect(whopProductTitle("  Ma Boutique ")).toBe("Ma Boutique");
    expect(whopProductTitle("")).toBe("Boutique");
    expect(whopProductTitle(null)).toBe("Boutique");
    expect(whopProductTitle("x".repeat(100))).toHaveLength(80);
  });
});

describe("setupWhop", () => {
  const opts = (storeId: string) => ({ apiKey: "k", testMode: true, storeId, storeName: "Ma Boutique" });

  it("a new product is named after the store (no '— Checkout'); the account's e-mail setting is left alone", async () => {
    const res = await setupWhop(opts("st_new"));
    expect(sdk.productsCreate.mock.calls[0][0].title).toBe("Ma Boutique");
    expect(sdk.productsUpdate).not.toHaveBeenCalled();
    // Never a silent account-wide change: send_customer_emails is the owner's explicit switch.
    expect(sdk.accountsUpdate).not.toHaveBeenCalled();
    expect(res).toMatchObject({ productId: "prod_new" });
    expect(res).not.toHaveProperty("customerEmailsOff");
    expect(store.settings.get("whop:product-title:st_new")).toBe("prod_new:Ma Boutique");
  });

  it("an existing '<Store> — Checkout' product is renamed once and remembered", async () => {
    sdk.productsList.mockResolvedValue([{ id: "prod_old", title: "Ma Boutique — Checkout", metadata: { source: "whop-checkout", store_id: "st_old" } }]);
    const res = await setupWhop(opts("st_old"));
    expect(sdk.productsCreate).not.toHaveBeenCalled();
    expect(sdk.productsUpdate).toHaveBeenCalledWith({ id: "prod_old", title: "Ma Boutique" }, undefined);
    expect(res.productId).toBe("prod_old");
    expect(store.settings.get("whop:product-title:st_old")).toBe("prod_old:Ma Boutique");
  });

  it("a refused rename never blocks the connection", async () => {
    sdk.productsList.mockResolvedValue([{ id: "prod_x", title: "Old — Checkout", metadata: { source: "whop-checkout", store_id: "st_refused" } }]);
    sdk.productsUpdate.mockRejectedValue(new Error("403"));
    const res = await setupWhop(opts("st_refused"));
    expect(res).toMatchObject({ productId: "prod_x", webhookId: "hook_1" });
    expect(store.settings.has("whop:product-title:st_refused")).toBe(false);
  });

  it("the state read at connection is cached for the Whop page (no second accounts.me)", async () => {
    sdk.me.mockResolvedValue(account({ send_customer_emails: false }));
    await setupWhop(opts("st_cache"));
    sdk.me.mockClear();
    expect(await whopCustomerEmailsStatus({ id: "st_cache", whopApiKey: encrypt("k"), testMode: true })).toBe(false);
    expect(sdk.me).not.toHaveBeenCalled();
  });
});

describe("Whop's buyer e-mails: the owner's explicit switch", () => {
  const whopStore = (id: string) => ({ id, whopApiKey: encrypt("k"), testMode: true, whopAccountId: "biz_t" });

  it("status read from accounts.me, then cached (one Whop call)", async () => {
    expect(await whopCustomerEmailsStatus(whopStore("st_e1"))).toBe(true);
    expect(await whopCustomerEmailsStatus(whopStore("st_e1"))).toBe(true);
    expect(sdk.me).toHaveBeenCalledTimes(1);
  });

  it("status unknown (null) when Whop fails, is silent or too slow — never blocks the page", async () => {
    sdk.me.mockRejectedValueOnce(new Error("Whop 500"));
    expect(await whopCustomerEmailsStatus(whopStore("st_e2"))).toBeNull();
    sdk.me.mockResolvedValueOnce({ id: "biz_t" });
    expect(await whopCustomerEmailsStatus(whopStore("st_e3"))).toBeNull();
    sdk.me.mockReturnValueOnce(new Promise(() => undefined));
    expect(await whopCustomerEmailsStatus(whopStore("st_e4"), 30)).toBeNull();
  });

  it("off, then back on: Whop's account updated, the cached state follows", async () => {
    expect(await setWhopCustomerEmails(whopStore("st_e5"), false)).toBe(false);
    expect(sdk.accountsUpdate).toHaveBeenLastCalledWith({ id: "biz_t", send_customer_emails: false });
    expect(await whopCustomerEmailsStatus(whopStore("st_e5"))).toBe(false);
    expect(await setWhopCustomerEmails(whopStore("st_e5"), true)).toBe(true);
    expect(sdk.accountsUpdate).toHaveBeenLastCalledWith({ id: "biz_t", send_customer_emails: true });
    expect(await whopCustomerEmailsStatus(whopStore("st_e5"))).toBe(true);
    expect(sdk.me).not.toHaveBeenCalled();
  });

  it("Whop's refusal is thrown (the page shows the step-by-step); a kept 'on' counts as refused", async () => {
    sdk.accountsUpdate.mockRejectedValueOnce(new Error("Account API keys cannot edit their own account"));
    await expect(setWhopCustomerEmails(whopStore("st_e6"), false)).rejects.toThrow(/cannot edit/);
    sdk.accountsUpdate.mockResolvedValueOnce(account({ send_customer_emails: true }));
    await expect(setWhopCustomerEmails(whopStore("st_e7"), false)).rejects.toThrow(/send_customer_emails=true/);
    expect(await whopCustomerEmailsStatus(whopStore("st_e7"))).toBe(true);
  });

  it("an unknown state (Whop failing or too slow) is cached 1 min: a Whop outage doesn't cost every page view the wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      sdk.me.mockRejectedValueOnce(new Error("Whop 500"));
      expect(await whopCustomerEmailsStatus(whopStore("st_u1"))).toBeNull();
      expect(await whopCustomerEmailsStatus(whopStore("st_u1"))).toBeNull();
      expect(sdk.me).toHaveBeenCalledTimes(1);
      // Past a minute: asked again (and the real state then cached for 10 min).
      vi.setSystemTime(Date.now() + 61_000);
      expect(await whopCustomerEmailsStatus(whopStore("st_u1"))).toBe(true);
      expect(sdk.me).toHaveBeenCalledTimes(2);
      vi.setSystemTime(Date.now() + 5 * 60_000);
      expect(await whopCustomerEmailsStatus(whopStore("st_u1"))).toBe(true);
      expect(sdk.me).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    // Too slow: unknown, cached too (no second 2.5 s wait on the next view).
    sdk.me.mockReturnValueOnce(new Promise(() => undefined));
    expect(await whopCustomerEmailsStatus(whopStore("st_u2"), 20)).toBeNull();
    const started = Date.now();
    expect(await whopCustomerEmailsStatus(whopStore("st_u2"), 2_000)).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    expect(sdk.me).toHaveBeenCalledTimes(3);
    // The owner's switch replaces the unknown state at once.
    await setWhopCustomerEmails(whopStore("st_u2"), false);
    expect(await whopCustomerEmailsStatus(whopStore("st_u2"))).toBe(false);
  });

  it("the Whop page's controls: one main action; unknown state → « Couper » plus a small « Réactiver » link", async () => {
    expect(whopEmailsControls(true)).toEqual({ main: "off", link: null });
    expect(whopEmailsControls(false)).toEqual({ main: "on", link: null });
    expect(whopEmailsControls(null)).toEqual({ main: "off", link: "on" });
    const { readFileSync } = await import("node:fs");
    const page = readFileSync("src/app/dashboard/stores/[storeId]/(main)/whop/page.tsx", "utf8");
    // The secondary « Réactiver » is a text link, not a second equal button.
    expect(page).toMatch(/emailsControls\.link === "on"[\s\S]{0,400}className="text-xs[^"]*underline/);
    // The product is renamed to the store's name automatically: said on the connected card.
    expect(page).toContain("renommé automatiquement au nom de votre boutique Shopify");
  });

  it("the support message names the account and send_customer_emails=false", () => {
    const msg = whopSupportEmailsMessage("biz_t");
    expect(msg).toContain("biz_t");
    expect(msg).toContain("send_customer_emails=false");
  });
});

describe("createCheckoutConfiguration renames an older product once (in the background)", () => {
  const whopStore = (name?: string) => ({ whopApiKey: encrypt("k"), testMode: true, whopAccountId: "biz_t", whopProductId: "prod_c", ...(name != null ? { name } : {}) });
  const opts = (storeId: string) => ({ sessionId: "s1", storeId, totalCents: 1000, currency: "EUR", title: "Commande", redirectUrl: "https://x.test/merci" });

  it("first checkout renames; later ones make no Whop call (remembered)", async () => {
    expect((await createCheckoutConfiguration(whopStore("Ma Boutique"), opts("st_c1"))).id).toBe("ch_1");
    await settleProductTitleSyncs();
    expect(sdk.productsUpdate).toHaveBeenCalledTimes(1);
    expect(sdk.productsUpdate.mock.calls[0][0]).toEqual({ id: "prod_c", title: "Ma Boutique" });
    expect(store.settings.get("whop:product-title:st_c1")).toBe("prod_c:Ma Boutique");
    await createCheckoutConfiguration(whopStore("Ma Boutique"), opts("st_c1"));
    await settleProductTitleSyncs();
    expect(sdk.productsUpdate).toHaveBeenCalledTimes(1);
  });

  it("a slow rename never delays the configuration (not awaited)", async () => {
    let finish!: () => void;
    sdk.productsUpdate.mockImplementationOnce(() => new Promise<{ id: string; title: string }>((r) => (finish = () => r({ id: "prod_c", title: "Lente" }))));
    const res = await Promise.race([createCheckoutConfiguration(whopStore("Lente"), opts("st_slow")), new Promise<"late">((r) => setTimeout(() => r("late"), 200))]);
    expect(res).toMatchObject({ id: "ch_1" });
    expect(sdk.productsUpdate).toHaveBeenCalledTimes(1);
    finish();
    await settleProductTitleSyncs();
    expect(store.settings.get("whop:product-title:st_slow")).toBe("prod_c:Lente");
  });

  it("already remembered (another process): no Whop call; a renamed store renames again", async () => {
    store.settings.set("whop:product-title:st_c2", "prod_c:Ma Boutique");
    await createCheckoutConfiguration(whopStore("Ma Boutique"), opts("st_c2"));
    await settleProductTitleSyncs();
    expect(sdk.productsUpdate).not.toHaveBeenCalled();
    await createCheckoutConfiguration(whopStore("Nouveau Nom"), opts("st_c2"));
    await settleProductTitleSyncs();
    expect(sdk.productsUpdate).toHaveBeenCalledWith({ id: "prod_c", title: "Nouveau Nom" }, expect.anything());
  });

  it("a refused rename never fails the checkout, and is not retried on every checkout", async () => {
    sdk.productsUpdate.mockRejectedValue(new Error("Whop 500"));
    expect((await createCheckoutConfiguration(whopStore("Ma Boutique"), opts("st_c3"))).id).toBe("ch_1");
    await settleProductTitleSyncs();
    expect(store.settings.has("whop:product-title:st_c3")).toBe(false);
    await createCheckoutConfiguration(whopStore("Ma Boutique"), opts("st_c3"));
    await settleProductTitleSyncs();
    expect(sdk.productsUpdate).toHaveBeenCalledTimes(1);
  });

  it("without the store's name (callers that don't pass it): nothing renamed", async () => {
    await createCheckoutConfiguration(whopStore(), opts("st_c4"));
    await settleProductTitleSyncs();
    expect(sdk.productsUpdate).not.toHaveBeenCalled();
  });
});
