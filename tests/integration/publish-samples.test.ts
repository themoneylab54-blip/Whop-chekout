import { afterAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/*
 * publishDesignAction against a real Postgres: shipped sample proof (example reviews, key
 * figures, coupon…) no longer blocks publishing, because the live page never shows it
 * (isEmptyInLive → isSampleOnly, liveReviewItems / liveStatItems). Test data is prefixed
 * pubsample_ and deleted at the end.
 */

const hasDb = !!process.env.DATABASE_URL;

vi.mock("next/cache", async (orig) => ({ ...(await orig<typeof import("next/cache")>()), revalidatePath: () => undefined }));
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), requireAdmin: async () => "admin", currentUser: async () => (await import("../session-stub")).ownerUser() }));

describe.skipIf(!hasDb)("publishDesignAction: sample content publishes but stays hidden from buyers (integration)", async () => {
  const { db } = await import("@/lib/db");
  const { publishDesignAction } = await import("@/app/dashboard/actions");
  const { createBlock, defaultCheckoutLayout, defaultThankYouLayout, loadCheckoutLayout } = await import("@/lib/layout");
  const { ContentBlock, isEmptyInLive } = await import("@/components/checkout/blocks");
  const { labelsFor } = await import("@/components/checkout/i18n");
  const { localizeLayout } = await import("@/components/checkout/localize");
  type Ctx = import("@/components/checkout/blocks").ContentContext;
  const live = { preview: false, labels: labelsFor("fr"), lang: "fr" } as unknown as Ctx;
  const preview = { ...live, preview: true } as Ctx;
  const withSamples = () => {
    const layout = defaultCheckoutLayout();
    layout.blocks.push(
      createBlock("reviews", { placement: "summary" }),
      createBlock("stats", { placement: "summary" }),
      createBlock("testimonial", { placement: "summary" }),
      createBlock("announcement"),
      createBlock("text"),
    );
    return layout;
  };
  const created: string[] = [];

  async function store(checkoutLayout: unknown) {
    const s = await db.store.create({
      data: { name: `pubsample_${Math.random().toString(36).slice(2, 8)}`, draftCheckoutLayout: checkoutLayout as object, draftThankYouLayout: defaultThankYouLayout() as object },
    });
    created.push(s.id);
    return s;
  }

  afterAll(async () => {
    await db.store.deleteMany({ where: { id: { in: created } } });
  });

  it("publishes a draft with sample proof, and the published layout hides every sample block from buyers", async () => {
    const s = await store(withSamples());
    expect(await publishDesignAction(s.id, "v1")).toEqual({ ok: true, stripped: 0 });
    const row = await db.store.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.publishedAt).not.toBeNull();
    const published = loadCheckoutLayout(row.checkoutLayout);
    const samples = published.blocks.filter((b) => ["reviews", "stats", "testimonial", "announcement", "text"].includes(b.type));
    expect(samples).toHaveLength(5);
    for (const b of samples) {
      expect(isEmptyInLive(b, live, 0), b.type).toBe(true);
      // The builder still shows them (flagged as to complete).
      expect(isEmptyInLive(b, preview, 0), b.type).toBe(false);
    }
    // Translated for an English buyer, the shipped samples are still recognised.
    for (const b of localizeLayout(published, "en").blocks.filter((x) => samples.some((y) => y.id === x.id))) expect(isEmptyInLive(b, live, 0), b.type).toBe(true);
  });

  it("partially edited reviews / figures: only the merchant's own entries reach buyers", () => {
    const reviews = createBlock("reviews");
    reviews.props.items = [...reviews.props.items, { name: "Léa M.", text: "Très bon produit.", stars: 5, verified: false }];
    expect(isEmptyInLive(reviews, live, 0)).toBe(false);
    const html = renderToStaticMarkup(createElement(ContentBlock, { block: { ...reviews, props: { ...reviews.props, layout: "stack" } }, ctx: live }));
    expect(html).toContain("Léa M.");
    expect(html).not.toContain("Camille R.");
    expect(html).not.toContain("Yanis B.");
    const stats = createBlock("stats");
    stats.props.items = [{ value: "2 300", label: "commandes" }, ...stats.props.items];
    const statsHtml = renderToStaticMarkup(createElement(ContentBlock, { block: stats, ctx: live }));
    expect(statsHtml).toContain("2 300");
    expect(statsHtml).not.toContain("+10 000");
    expect(renderToStaticMarkup(createElement(ContentBlock, { block: stats, ctx: preview }))).toContain("+10 000");
  });

  it("autosave can write the other page too (a template applied with its matching thank-you page)", async () => {
    const { saveBuilderAction } = await import("@/app/dashboard/actions");
    const { themeSchema, loadThankYouLayout } = await import("@/lib/layout");
    const { CHECKOUT_TEMPLATES, matchingThankYou } = await import("@/components/builder/templates");
    const s = await store(defaultCheckoutLayout());
    const t = CHECKOUT_TEMPLATES.find((x) => x.id === "urgency-promo")!;
    const thankYou = matchingThankYou(t)!.build(defaultThankYouLayout());
    const res = await saveBuilderAction(s.id, "checkout", themeSchema.parse({}), t.build(defaultCheckoutLayout()), thankYou);
    expect(res.ok).toBe(true);
    const row = await db.store.findUniqueOrThrow({ where: { id: s.id } });
    expect(loadCheckoutLayout(row.draftCheckoutLayout).blocks.map((b) => b.type)).toContain("low_stock");
    expect(loadThankYouLayout(row.draftThankYouLayout).blocks.map((b) => b.id)).toEqual(thankYou.blocks.map((b) => b.id));
    // Without it, the other page's draft is left alone.
    const before = row.draftThankYouLayout;
    expect((await saveBuilderAction(s.id, "checkout", themeSchema.parse({}), defaultCheckoutLayout())).ok).toBe(true);
    expect((await db.store.findUniqueOrThrow({ where: { id: s.id } })).draftThankYouLayout).toEqual(before);
  });

  it("the default checkout and example promises publish too (warning only)", async () => {
    const layout = defaultCheckoutLayout();
    layout.blocks.push(createBlock("guarantee", { placement: "summary" }), createBlock("delivery_estimate"));
    const s = await store(layout);
    expect(await publishDesignAction(s.id, "v1")).toEqual({ ok: true, stripped: 0 });
  });
});
