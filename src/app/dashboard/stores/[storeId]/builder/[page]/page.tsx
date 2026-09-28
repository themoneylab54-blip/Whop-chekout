import type { Metadata } from "next";
import { Prisma } from "@prisma/client";
import { runningTestsByElement } from "@/lib/checkout-tests";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { canonical, draftDesign, hasDraft, hasPublished, publishedDesign, sameDesign } from "@/lib/design";
import { loadCheckoutLayout, loadTheme, loadThankYouLayout } from "@/lib/layout";
import { BuilderApp } from "@/components/builder/BuilderApp";
import { discardDraftAction, publishDesignAction, restoreVersionAction, saveBuilderAction } from "../../../../actions";
import { previewLines, previewThankYou } from "../sample";
import { canReadShopifyDiscounts } from "@/lib/shopify-discounts";

export async function generateMetadata({ params }: { params: Promise<{ storeId: string; page: string }> }): Promise<Metadata> {
  const { storeId, page } = await params;
  const store = await db.store.findUnique({ where: { id: storeId }, select: { name: true } });
  const what = page === "thank-you" ? "Page de remerciement" : "Design du checkout";
  return { title: { absolute: store ? `${what} · ${store.name}` : what } };
}

/**
 * Stores published before the version history existed have a live design but no version to
 * restore: snapshot it once as "Version initiale" (dated from the publication). Idempotent:
 * a per-store advisory lock serialises concurrent first loads and the insert only happens
 * while the store still has no version at all.
 */
async function ensureInitialVersion(store: {
  id: string;
  name: string;
  publishedAt: Date | null;
  theme: Prisma.JsonValue;
  checkoutLayout: Prisma.JsonValue;
  thankYouLayout: Prisma.JsonValue;
}): Promise<boolean> {
  if (!store.publishedAt) return false;
  if ((await db.layoutVersion.count({ where: { storeId: store.id } })) > 0) return false;
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`layout-version:${store.id}`}))::text`;
    if ((await tx.layoutVersion.count({ where: { storeId: store.id } })) > 0) return false;
    await tx.layoutVersion.create({
      data: {
        storeId: store.id,
        label: "Version initiale",
        // The published fields as stored (so the version reads as "Actuelle"); defaults where never set.
        theme: (store.theme ?? loadTheme(null, store.name)) as Prisma.InputJsonValue,
        checkoutLayout: (store.checkoutLayout ?? loadCheckoutLayout(null)) as Prisma.InputJsonValue,
        thankYouLayout: (store.thankYouLayout ?? loadThankYouLayout(null)) as Prisma.InputJsonValue,
        createdAt: store.publishedAt!,
      },
    });
    return true;
  });
}

export default async function BuilderPage({
  params,
  searchParams,
}: {
  params: Promise<{ storeId: string; page: string }>;
  searchParams: Promise<{ select?: string | string[] }>;
}) {
  await requireAdmin();
  const { storeId, page } = await params;
  const select = (await searchParams).select;
  if (page !== "checkout" && page !== "thank-you") notFound();
  const store = await db.store.findUnique({
    where: { id: storeId },
    include: {
      shippingRates: { where: { active: true }, orderBy: { position: "asc" } },
      addOns: { where: { active: true }, orderBy: { position: "asc" } },
      _count: { select: { discounts: { where: { active: true } } } },
    },
  });
  if (!store) notFound();
  await ensureInitialVersion(store);
  const design = draftDesign(store);
  // A leftover draft identical to the live design (edits undone before this was detected on
  // save) is no draft: drop it so the builder doesn't announce unpublished changes.
  let draft = hasDraft(store);
  if (draft && hasPublished(store) && sameDesign(design, publishedDesign(store))) {
    await db.store.update({
      where: { id: store.id },
      data: { draftTheme: Prisma.DbNull, draftCheckoutLayout: Prisma.DbNull, draftThankYouLayout: Prisma.DbNull, draftUpdatedAt: null },
    });
    draft = false;
  }
  const [versions, sample, running] = await Promise.all([
    db.layoutVersion.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { id: true, label: true, createdAt: true, theme: true, checkoutLayout: true, thankYouLayout: true },
    }),
    previewLines(store.id),
    runningTestsByElement(store.id),
  ]);

  // One source of truth for the status: the published design lives on the store; the
  // version whose content equals it is the "current" one.
  const published = store.theme != null ? canonical([store.theme, store.checkoutLayout, store.thankYouLayout]) : null;
  const currentId = published ? (versions.find((v) => canonical([v.theme, v.checkoutLayout, v.thankYouLayout]) === published)?.id ?? null) : null;
  const publishedAt = store.publishedAt ?? (currentId ? versions.find((v) => v.id === currentId)!.createdAt : null);

  const addOns = store.addOns.map((a) => ({ id: a.id, title: a.title, description: a.description, priceCents: a.priceCents, imageUrl: a.imageUrl }));
  const images = [
    ...sample.lines.filter((l) => l.imageUrl).map((l) => ({ url: l.imageUrl!, label: l.variantTitle ? `${l.title} — ${l.variantTitle}` : l.title })),
    ...addOns.filter((a) => a.imageUrl).map((a) => ({ url: a.imageUrl!, label: `Option : ${a.title}` })),
    ...(design.theme.logoUrl ? [{ url: design.theme.logoUrl, label: "Logo de la boutique" }] : []),
  ];

  return (
    <BuilderApp
      key={page}
      storeId={store.id}
      storeName={store.name}
      page={page}
      currency={store.shopCurrency}
      theme={design.theme}
      layout={page === "checkout" ? design.checkoutLayout : design.thankYouLayout}
      rates={store.shippingRates}
      addOns={addOns}
      hasDiscounts={store._count.discounts > 0 || (store.shopifyDiscountCodes && canReadShopifyDiscounts(store))}
      sampleLines={sample.lines}
      realSample={sample.real}
      thankYouData={previewThankYou(store.shopCurrency, sample.lines, store.shippingRates)}
      images={images}
      save={saveBuilderAction.bind(null, store.id, page)}
      hasDraft={draft}
      draftUpdatedAt={store.draftUpdatedAt?.toISOString() ?? null}
      publishedAt={publishedAt?.toISOString() ?? null}
      versions={versions.map((v) => ({ id: v.id, label: v.label, createdAt: v.createdAt.toISOString(), current: v.id === currentId }))}
      publish={publishDesignAction.bind(null, store.id)}
      restore={restoreVersionAction.bind(null, store.id)}
      discard={discardDraftAction.bind(null, store.id)}
      published={hasPublished(store) ? publishedDesign(store) : null}
      otherLayout={page === "checkout" ? design.thankYouLayout : design.checkoutLayout}
      initialSelected={typeof select === "string" ? select : null}
      storeLive={store.enabled && !!store.shopifyConnectedAt && !!store.whopConnectedAt}
      protectionTest={running.get("protection")?.name ?? null}
    />
  );
}
