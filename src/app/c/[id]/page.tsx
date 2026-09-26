import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { fontHref, loadCheckoutLayout, loadTheme } from "@/lib/layout";
import type { CartLine } from "@/lib/pricing";
import { CheckoutView } from "@/components/checkout/CheckoutView";

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
  const theme = loadTheme(store.theme, store.name);
  const font = fontHref(theme.font);

  return (
    <>
      {font && <link rel="stylesheet" href={font} />}
      <CheckoutView
        theme={theme}
        layout={loadCheckoutLayout(store.checkoutLayout)}
        currency={session.currency}
        lines={session.lines as unknown as CartLine[]}
        rates={rates}
        addOns={addOns.map((a) => ({ id: a.id, title: a.title, description: a.description, priceCents: a.priceCents, imageUrl: a.imageUrl }))}
        hasDiscounts={discountCount > 0}
        mode={{ kind: "live", sessionId: session.id, testMode: store.testMode }}
        initialEmail={session.email}
      />
    </>
  );
}
