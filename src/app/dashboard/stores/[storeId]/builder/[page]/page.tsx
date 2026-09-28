import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { draftDesign, hasDraft } from "@/lib/design";
import { BuilderApp } from "@/components/builder/BuilderApp";
import { discardDraftAction, publishDesignAction, restoreVersionAction, saveBuilderAction } from "../../../../actions";

export const metadata: Metadata = { title: "Builder" };

export default async function BuilderPage({ params }: { params: Promise<{ storeId: string; page: string }> }) {
  await requireAdmin();
  const { storeId, page } = await params;
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
  const design = draftDesign(store);
  const versions = await db.layoutVersion.findMany({
    where: { storeId: store.id },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: { id: true, label: true, createdAt: true },
  });

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
      addOns={store.addOns.map((a) => ({ id: a.id, title: a.title, description: a.description, priceCents: a.priceCents, imageUrl: a.imageUrl }))}
      hasDiscounts={store._count.discounts > 0}
      save={saveBuilderAction.bind(null, store.id, page)}
      hasDraft={hasDraft(store)}
      versions={versions.map((v) => ({ id: v.id, label: v.label, createdAt: v.createdAt.toISOString() }))}
      publish={publishDesignAction.bind(null, store.id)}
      restore={restoreVersionAction.bind(null, store.id)}
      discard={discardDraftAction.bind(null, store.id)}
    />
  );
}
