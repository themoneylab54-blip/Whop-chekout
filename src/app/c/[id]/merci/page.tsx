import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { fontHref, loadTheme, loadThankYouLayout } from "@/lib/layout";
import type { CartLine } from "@/lib/pricing";
import type { Address } from "@/lib/shopify";
import { ThankYouView } from "@/components/checkout/ThankYouView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Merci pour votre commande", robots: { index: false } };

export default async function ThankYouPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session || session.status === "OPEN") notFound();

  const theme = loadTheme(session.store.theme, session.store.name);
  const font = fontHref(theme.font);
  const a = session.shippingAddress as Address | null;
  const continueUrl = session.returnUrl
    ? `${session.returnUrl}${session.returnUrl.includes("?") ? "&" : "?"}whopco_paid=1`
    : session.store.storefrontHost
      ? `https://${session.store.storefrontHost}/?whopco_paid=1`
      : null;

  return (
    <>
      {font && <link rel="stylesheet" href={font} />}
      <ThankYouView
        theme={theme}
        layout={loadThankYouLayout(session.store.thankYouLayout)}
        sessionId={session.id}
        data={{
          status: session.status,
          orderName: session.shopifyOrderName,
          email: session.email ?? "",
          firstName: a?.firstName ?? "",
          address: a
            ? {
                name: `${a.firstName} ${a.lastName}`,
                lines: [a.address1, a.address2, `${a.zip} ${a.city}`, a.province].filter((x): x is string => !!x),
                countryCode: a.countryCode,
              }
            : null,
          lines: session.lines as unknown as CartLine[],
          currency: session.currency,
          subtotalCents: session.subtotalCents,
          discountCents: session.discountCents,
          shippingCents: session.shippingCents,
          addOnsCents: session.addOnsCents,
          totalCents: session.totalCents,
          continueUrl,
        }}
      />
    </>
  );
}
