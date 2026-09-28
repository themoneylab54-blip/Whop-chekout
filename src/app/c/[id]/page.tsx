import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { themeFontHrefs, loadCheckoutLayout, loadTheme } from "@/lib/layout";
import type { CartLine } from "@/lib/pricing";
import { CheckoutView } from "@/components/checkout/CheckoutView";
import { designFor } from "@/lib/experiments";
import { activeUpsells } from "@/lib/upsell";
import { browserPixel } from "@/lib/conversions";
import { AdPixels } from "@/components/checkout/AdPixels";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Paiement sécurisé", robots: { index: false } };

export default async function CheckoutPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session) notFound();
  if (session.status === "PAID") redirect(`/c/${id}/merci`);

  const { store } = session;
  const [rates, addOns, discountCount] = await Promise.all([
    db.shippingRate.findMany({ where: { storeId: store.id, active: true }, orderBy: { position: "asc" } }),
    db.addOn.findMany({ where: { storeId: store.id, active: true }, orderBy: { position: "asc" } }),
    db.discountCode.count({ where: { storeId: store.id, active: true } }),
  ]);
  // A/B test: variant B sessions render the tested design.
  const design = await designFor(store, session);
  const theme = loadTheme(design.theme, store.name);
  const fonts = themeFontHrefs(theme);
  // Save the card for the one-click post-purchase offer only when one is live.
  const pixel = browserPixel(session, "checkout");
  const saveCard = activeUpsells({ thankYouLayout: design.thankYouLayout }).length > 0;

  return (
    <>
      {fonts.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      {pixel && <AdPixels {...pixel} />}
      <CheckoutView
        theme={theme}
        layout={loadCheckoutLayout(design.checkoutLayout)}
        currency={session.currency}
        lines={session.lines as unknown as CartLine[]}
        rates={rates}
        addOns={addOns.map((a) => ({ id: a.id, title: a.title, description: a.description, priceCents: a.priceCents, imageUrl: a.imageUrl }))}
        hasDiscounts={discountCount > 0}
        mode={{ kind: "live", sessionId: session.id, testMode: store.testMode, saveCard }}
        initialEmail={session.email}
      />
    </>
  );
}
