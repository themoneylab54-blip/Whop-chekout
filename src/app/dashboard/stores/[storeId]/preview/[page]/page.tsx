import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { fontHref, loadCheckoutLayout, loadTheme, loadThankYouLayout } from "@/lib/layout";
import { SAMPLE_LINES, sampleThankYou } from "@/lib/sample";
import { CheckoutView } from "@/components/checkout/CheckoutView";
import { ThankYouView } from "@/components/checkout/ThankYouView";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Aperçu", robots: { index: false } };

/** Full-screen preview of what buyers see, rendered from the saved design. */
export default async function PreviewPage({ params }: { params: Promise<{ storeId: string; page: string }> }) {
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
  const theme = loadTheme(store.theme, store.name);
  const font = fontHref(theme.font);

  return (
    <>
      {font && <link rel="stylesheet" href={font} />}
      <div className="sticky top-0 z-50 bg-zinc-900 px-4 py-2 text-center text-xs text-white">
        Aperçu du design enregistré · données d&apos;exemple · rien n&apos;est facturé
      </div>
      {page === "checkout" ? (
        <CheckoutView
          theme={theme}
          layout={loadCheckoutLayout(store.checkoutLayout)}
          currency={store.shopCurrency}
          lines={SAMPLE_LINES}
          rates={store.shippingRates}
          addOns={store.addOns.map((a) => ({ id: a.id, title: a.title, description: a.description, priceCents: a.priceCents, imageUrl: a.imageUrl }))}
          hasDiscounts={store._count.discounts > 0}
          mode={{ kind: "preview" }}
        />
      ) : (
        <ThankYouView theme={theme} layout={loadThankYouLayout(store.thankYouLayout)} data={sampleThankYou(store.shopCurrency)} />
      )}
    </>
  );
}
