import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireStoreAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { themeFontHrefs } from "@/lib/layout";
import { draftDesign, hasDraft } from "@/lib/design";
import { previewLines, previewThankYou } from "../../builder/sample";
import { CheckoutView } from "@/components/checkout/CheckoutView";
import { ThankYouView } from "@/components/checkout/ThankYouView";
import { canReadShopifyDiscounts } from "@/lib/shopify-discounts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Aperçu", robots: { index: false } };

/** Full-screen preview of what buyers see, rendered from the saved design. */
export default async function PreviewPage({ params }: { params: Promise<{ storeId: string; page: string }> }) {
  const { storeId, page } = await params;
  await requireStoreAccess(storeId, "view");
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
  // The merchant previews what they are editing (the draft), before publishing it.
  const design = draftDesign(store);
  const theme = design.theme;
  const fonts = themeFontHrefs(theme);
  const sample = await previewLines(store.id);

  return (
    // One tall wrapper: body is only 100vh high, so a sticky child of body would scroll away.
    <div className="min-h-full" style={{ ["--wc-sticky-top" as string]: "2rem" }}>
      {fonts.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      <div className="sticky top-0 z-50 flex min-h-8 items-center justify-center bg-zinc-900 px-4 py-2 text-center text-xs text-white">
        {hasDraft(store) ? "Aperçu du brouillon (non publié)" : "Aperçu du design publié"} ·{" "}
        {sample.real ? "produits de votre dernier panier" : "données d\u2019exemple"} · rien n&apos;est facturé
      </div>
      {/* The banner stays on top: the summary column sticks just below it. */}
      <div>
        {page === "checkout" ? (
          <CheckoutView
            theme={theme}
            layout={design.checkoutLayout}
            currency={store.shopCurrency}
            lines={sample.lines}
            rates={store.shippingRates}
            addOns={store.addOns.map((a) => ({ id: a.id, title: a.title, description: a.description, priceCents: a.priceCents, imageUrl: a.imageUrl }))}
            hasDiscounts={store._count.discounts > 0 || (store.shopifyDiscountCodes && canReadShopifyDiscounts(store))}
            mode={{ kind: "preview" }}
          />
        ) : (
          // Same as the builder canvas: offers are shown (answering them does nothing here).
          <ThankYouView theme={theme} layout={design.thankYouLayout} data={previewThankYou(store.shopCurrency, sample.lines, store.shippingRates)} demoOffers />
        )}
      </div>
    </div>
  );
}
