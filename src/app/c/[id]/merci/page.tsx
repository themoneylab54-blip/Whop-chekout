import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { themeFontHrefs, loadTheme, loadThankYouLayout } from "@/lib/layout";
import type { CartLine } from "@/lib/pricing";
import type { Address } from "@/lib/shopify";
import { ThankYouView } from "@/components/checkout/ThankYouView";
import { designFor } from "@/lib/experiments";
import { upsellEligible } from "@/lib/upsell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Merci pour votre commande", robots: { index: false } };

export default async function ThankYouPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  // Express wallets (Apple/Google Pay) land here before the webhook marks the session:
  // show "processing" for any session that reached a Whop checkout.
  if (!session || (session.status === "OPEN" && !session.whopCheckoutId)) notFound();

  const design = await designFor(session.store, session);
  const theme = loadTheme(design.theme, session.store.name);
  const charges = await db.upsellCharge.findMany({ where: { sessionId: session.id }, select: { blockId: true, status: true } });
  const fonts = themeFontHrefs(theme);
  const a = session.shippingAddress as Address | null;
  const continueUrl = session.returnUrl
    ? `${session.returnUrl}${session.returnUrl.includes("?") ? "&" : "?"}whopco_paid=1`
    : session.store.storefrontHost
      ? `https://${session.store.storefrontHost}/?whopco_paid=1`
      : null;

  return (
    <>
      {fonts.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      <ThankYouView
        theme={theme}
        layout={loadThankYouLayout(design.thankYouLayout)}
        upsell={{
          eligible: upsellEligible(session),
          states: Object.fromEntries(charges.map((c) => [c.blockId, c.status])),
        }}
        sessionId={session.id}
        data={{
          status: session.status === "OPEN" ? "PAYING" : session.status,
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
