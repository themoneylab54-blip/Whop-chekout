import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { loadCheckoutLayout, loadTheme, loadThankYouLayout } from "@/lib/layout";
import { BuilderApp } from "@/components/builder/BuilderApp";
import { saveBuilderAction } from "../../../../actions";

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

  return (
    <BuilderApp
      key={page}
      storeId={store.id}
      storeName={store.name}
      page={page}
      currency={store.shopCurrency}
      theme={loadTheme(store.theme, store.name)}
      layout={page === "checkout" ? loadCheckoutLayout(store.checkoutLayout) : loadThankYouLayout(store.thankYouLayout)}
      rates={store.shippingRates}
      addOns={store.addOns.map((a) => ({ id: a.id, title: a.title, description: a.description, priceCents: a.priceCents, imageUrl: a.imageUrl }))}
      hasDiscounts={store._count.discounts > 0}
      save={saveBuilderAction.bind(null, store.id, page)}
    />
  );
}
