import { afterAll, describe, expect, it, vi } from "vitest";

/*
 * UX round 15 against a real Postgres: dashboard actions refuse invalid input with a redirect
 * naming the field at fault (`field=`, shown inline while the page restores what was typed),
 * never round or clamp a value behind the merchant's back, and save nothing. Test data is
 * prefixed ux15fix_ and deleted at the end.
 */

const hasDb = !!process.env.DATABASE_URL;

/** Shaped like Next's redirect error (the settings batch save reads its digest). */
class Redirect extends Error {
  digest: string;
  constructor(public url: string) {
    super("NEXT_REDIRECT");
    this.digest = `NEXT_REDIRECT;replace;${url};307;`;
  }
}

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));
vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), requireAdmin: async () => "admin", currentUser: async () => (await import("../session-stub")).ownerUser() }));

/** The flash of the redirect an action ends with. */
async function flashOf(run: () => Promise<unknown>): Promise<{ path: string; ok?: string; error?: string; field?: string; form?: string; hash: string }> {
  try {
    await run();
  } catch (err) {
    if (!(err instanceof Redirect)) throw err;
    const u = new URL(err.url, "http://x");
    const q = u.searchParams;
    return { path: u.pathname, ok: q.get("ok") ?? undefined, error: q.get("error") ?? undefined, field: q.get("field") ?? undefined, form: q.get("form") ?? undefined, hash: u.hash };
  }
  throw new Error("no redirect");
}

const form = (fields: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) fd.append(k, x);
  return fd;
};

describe.skipIf(!hasDb)("dashboard actions: field-level validation errors (integration)", async () => {
  const { db } = await import("@/lib/db");
  const actions = await import("@/app/dashboard/actions");
  const costs = await import("@/app/dashboard/stores/[storeId]/(main)/costs/actions");
  const analytics = await import("@/app/dashboard/stores/[storeId]/(main)/analytics/actions");
  const created: string[] = [];

  async function store() {
    const s = await db.store.create({ data: { name: `ux15fix_${Math.random().toString(36).slice(2, 8)}` } });
    created.push(s.id);
    return s;
  }

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  const promo = (over: Record<string, string> = {}) => form({ code: "ux15fix_code", type: "PERCENT", value: "10", minSubtotal: "", startsAt: "", endsAt: "", usageLimit: "", ...over });

  it("promo codes: a decimal percentage is refused (not rounded), each error names its field", async () => {
    const s = await store();
    const create = (over: Record<string, string>) => flashOf(() => actions.createDiscountAction(s.id, promo(over)));
    expect(await create({ value: "12,5" })).toMatchObject({ path: `/dashboard/stores/${s.id}/offers`, error: "Pourcentage entier entre 1 et 100", field: "value" });
    expect(await create({ value: "12.5" })).toMatchObject({ field: "value" });
    expect(await create({ value: "150" })).toMatchObject({ field: "value" });
    expect(await create({ code: "x" })).toMatchObject({ error: "Le code doit faire au moins 2 caractères", field: "code" });
    expect(await create({ minSubtotal: "abc" })).toMatchObject({ field: "minSubtotal" });
    expect(await create({ minSubtotal: "12,505" })).toMatchObject({ field: "minSubtotal" });
    expect(await create({ usageLimit: "10,5" })).toMatchObject({ field: "usageLimit" });
    expect(await create({ endsAt: "31/02/2026" })).toMatchObject({ field: "endsAt" });
    expect(await create({ startsAt: "2026-12-31", endsAt: "2026-12-01" })).toMatchObject({ field: "startsAt" });
    expect(await create({ type: "FIXED", value: "0" })).toMatchObject({ field: "value" });
    expect(await db.discountCode.count({ where: { storeId: s.id } })).toBe(0);
    // Whole percentages still work, with "%" or spaces.
    expect(await create({ value: "15 %" })).toMatchObject({ ok: "Code UX15FIX_CODE créé" });
    expect((await db.discountCode.findFirstOrThrow({ where: { storeId: s.id } })).value).toBe(15);
    expect(await create({})).toMatchObject({ error: "Le code UX15FIX_CODE existe déjà" });
  });

  it("add-ons: title, price, variant, cost and display rules name their field", async () => {
    const s = await store();
    const addOn = (over: Record<string, string>) =>
      flashOf(() => actions.createAddOnAction(s.id, form({ title: "ux15fix_bump", description: "", price: "2,99", variantId: "", imageUrl: "", cost: "", ruleMinSubtotal: "", ruleMaxSubtotal: "", ...over })));
    expect(await addOn({ title: "" })).toMatchObject({ error: "Titre obligatoire", field: "title" });
    expect(await addOn({ price: "abc" })).toMatchObject({ field: "price" });
    expect(await addOn({ price: "2,999" })).toMatchObject({ field: "price" });
    expect(await addOn({ imageUrl: "ftp://x" })).toMatchObject({ field: "imageUrl" });
    expect(await addOn({ variantId: "abc" })).toMatchObject({ field: "variantId" });
    expect(await addOn({ cost: "x" })).toMatchObject({ field: "cost" });
    expect(await addOn({ ruleMinSubtotal: "50", ruleMaxSubtotal: "20" })).toMatchObject({ field: "ruleMinSubtotal" });
    expect(await db.addOn.count({ where: { storeId: s.id } })).toBe(0);
  });

  it("shipping rates: name, price, countries, threshold and cost name their field", async () => {
    const s = await store();
    const rate = (over: Record<string, string>) => flashOf(() => actions.saveRateAction(s.id, form({ name: "ux15fix_rate", price: "4,90", countries: "FR", freeOver: "", cost: "", active: "on", ...over })));
    expect(await rate({ name: "" })).toMatchObject({ field: "name" });
    expect(await rate({ price: "4,905" })).toMatchObject({ field: "price" });
    expect(await rate({ countries: "France" })).toMatchObject({ field: "countries" });
    expect(await rate({ freeOver: "cinquante" })).toMatchObject({ field: "freeOver" });
    expect(await rate({ cost: "-1" })).toMatchObject({ field: "cost" });
    expect(await rate({ kind: "pickup" })).toMatchObject({ field: "kind" });
    expect(await db.shippingRate.count({ where: { storeId: s.id } })).toBe(0);
  });

  it("settings: margins, alerts and the batch save name the section and the field", async () => {
    const s = await store();
    expect(await flashOf(() => actions.saveMarginsAction(s.id, form({ fulfillmentFee: "1,505", homeCountry: "FR" })))).toMatchObject({ field: "fulfillmentFee" });
    expect(await flashOf(() => actions.saveMarginsAction(s.id, form({ fulfillmentFee: "1", homeCountry: "US" })))).toMatchObject({ field: "homeCountry" });
    expect(await flashOf(() => actions.saveAlertsAction(s.id, form({ alertEmail: "pas-un-email" })))).toMatchObject({ field: "alertEmail" });
    const batch = form({ __section: ["Marges & coûts", "Alertes"], "Marges & coûts::fulfillmentFee": "2", "Marges & coûts::homeCountry": "FR", "Alertes::alertEmail": "nope" });
    expect(await flashOf(() => actions.saveSettingsBatchAction(s.id, batch))).toMatchObject({
      error: "Alertes : E-mail d'alerte invalide (déjà enregistré : Marges & coûts)",
      field: "alertEmail",
      form: "Alertes",
    });
    expect(await flashOf(() => analytics.saveCostsAction(s.id, form({ fixedCostsMonthly: "12,345", disputeFee: "" })))).toMatchObject({ field: "fixedCostsMonthly", hash: "#couts" });
  });

  it("costs rows, A/B tests and ad spend: refused values name their field, nothing is clamped", async () => {
    const s = await store();
    const cost = await flashOf(() => costs.saveCostAction(s.id, form({ variantId: "44012345678901", cost: "12,505", effectiveFrom: "" })));
    expect(cost).toMatchObject({ field: "cost", hash: "#v-gid%3A%2F%2Fshopify%2FProductVariant%2F44012345678901" });
    expect(await flashOf(() => costs.saveCostAction(s.id, form({ variantId: "44012345678901", cost: "1.250", effectiveFrom: "" })))).toMatchObject({ field: "cost" });
    expect(await flashOf(() => costs.saveCostAction(s.id, form({ variantId: "44012345678901", cost: "12", effectiveFrom: "2999-01-01" })))).toMatchObject({ field: "effectiveFrom" });
    expect(await db.productCost.count({ where: { storeId: s.id } })).toBe(0);

    const v = await db.layoutVersion.create({ data: { storeId: s.id, label: "ux15fix_B", theme: {}, checkoutLayout: { blocks: [] }, thankYouLayout: { blocks: [] } } });
    expect(await flashOf(() => actions.startExperimentAction(s.id, form({ versionId: "", split: "50" })))).toMatchObject({ field: "versionId" });
    expect(await flashOf(() => actions.startExperimentAction(s.id, form({ versionId: v.id, split: "95" })))).toMatchObject({ error: "Part de trafic B : nombre entier entre 10 et 90 %", field: "split" });
    expect(await db.experiment.count({ where: { storeId: s.id } })).toBe(0);

    const test = await flashOf(() => analytics.startCheckoutTestAction(s.id, form({ kind: "breaks", tiers: "deux pour dix", split: "50" })));
    expect(test).toMatchObject({ field: "tiers", hash: "#tests-checkout" });
    expect(await flashOf(() => analytics.startCheckoutTestAction(s.id, form({ kind: "breaks", tiers: "2:10", split: "99" })))).toMatchObject({ field: "split" });
    expect(await flashOf(() => analytics.addAdSpendAction(s.id, form({ day: "2026-01-01", platform: "meta", campaign: "ux15fix", amount: "10,505" })))).toMatchObject({ field: "amount" });
  });
});
