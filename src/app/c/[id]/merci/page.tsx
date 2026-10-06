import type { Metadata } from "next";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { themeFontHrefs, loadCheckoutLayout, loadTheme, loadThankYouLayout, offerArmProps, variantGidOf, type Block, type OfferArm } from "@/lib/layout";
import { liveLayoutPayload } from "@/lib/sample-content";
import type { CartLine } from "@/lib/pricing";
import type { Address } from "@/lib/shopify";
import { ThankYouView } from "@/components/checkout/ThankYouView";
import { designFor } from "@/lib/experiments";
import { activeUpsells, chargeStates, matchingUpsellIds, offerArmsFor, upsellEligible, visitorKeyOf, type UpsellBlock } from "@/lib/upsell";
import { resolveAutoOffers, upsellContextFor } from "@/lib/offer-auto";
import { PROTECTION_ADDON_ID } from "@/lib/checkout";
import { buyerPhotoUrl, claimWindowOpen } from "@/lib/claims";
import { priceCart } from "@/lib/shopify";
import { log } from "@/lib/log";
import type { PickupPoint } from "@/lib/pickup";
import { browserPixel, marginContext } from "@/lib/conversions";
import { AdPixels } from "@/components/checkout/AdPixels";
import { labelsFor } from "@/components/checkout/i18n";
import { localizeBlock, localizeRate, recordText } from "@/components/checkout/localize";
import { buyerIcons, checkoutLang, CheckoutHtmlLang } from "@/app/c/lang";
import { keepOnCheckoutHost } from "@/app/c/host";
import { crossRate, ecbRates } from "@/lib/fx";
import { localRatesFor, type LocalRates } from "@/components/checkout/localCurrency";
import { cleanThankYouUrl, failedReturnUrl } from "@/lib/stripe-return";

/** Multipliers to the buyers' local currencies (ECB, cached 12 h); null when unavailable or slow. */
async function loadLocalRates(currency: string): Promise<LocalRates | null> {
  const load = ecbRates()
    .then((fx) => (fx ? localRatesFor(currency, (from, to) => crossRate(from, to, fx.rates)) : null))
    .catch(() => null);
  const rates = await Promise.race([load, new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500))]);
  return rates && Object.keys(rates).length ? rates : null;
}

/**
 * Live Shopify unit prices of the "% off" offers this visitor sees (their arm), by variant
 * GID. Slow or failing Shopify → those offers are hidden: never a made-up price.
 */
async function loadOfferPrices(store: Parameters<typeof priceCart>[0], offers: UpsellBlock[], arms: Record<string, OfferArm>): Promise<Record<string, number>> {
  const ids = [
    ...new Set(
      offers
        .map((b) => offerArmProps(b, arms[b.id] ?? "A"))
        .filter((p) => p.priceMode === "percent")
        .map((p) => variantGidOf(p.variantId))
        .filter((id): id is string => !!id),
    ),
  ];
  if (!ids.length) return {};
  const load = priceCart(store, ids.map((variantId) => ({ variantId, quantity: 1 })))
    .then((lines) => Object.fromEntries(lines.map((l) => [l.variantId, l.unitPriceCents])))
    .catch((err) => {
      log.warn("upsell.live_price_failed", "Live price of a percent offer failed: offer hidden", { err });
      return {};
    });
  return Promise.race([load, new Promise<Record<string, number>>((resolve) => setTimeout(() => resolve({}), 2500))]);
}

export const dynamic = "force-dynamic";

const loadSession = cache((id: string) => db.checkoutSession.findUnique({ where: { id }, include: { store: true } }));

/** Tab title "<Store> · Commande confirmée" in the checkout's language. */
type PageProps = { params: Promise<{ id: string }>; searchParams: Promise<{ lang?: string | string[]; redirect_status?: string | string[]; via?: string | string[] }> };

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const session = await loadSession(id);
  const theme = session ? loadTheme(session.store.theme, session.store.name) : null;
  const L = labelsFor(await checkoutLang((await searchParams).lang, theme?.language ?? "fr"));
  const name = theme?.storeName || session?.store.name;
  return { title: { absolute: name ? `${name} · ${L.thankYouTitle}` : L.thankYouTitle }, robots: { index: false }, icons: buyerIcons(theme?.logoUrl) };
}

export default async function ThankYouPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const session = await loadSession(id);
  // Express wallets (Apple/Google Pay) land here before the webhook marks the session:
  // show "processing" for any session that reached a Whop checkout.
  if (!session || (session.status === "OPEN" && !session.whopCheckoutId && !session.stripePaymentIntentId)) notFound();
  // Whop's and Stripe's return parameters are kept (payment status on the store's own domain).
  await keepOnCheckoutHost(session.store, `/c/${id}/merci`, (await searchParams) as Record<string, string | string[] | undefined>);
  // Back from a Stripe redirect (3-D Secure, bank page) that failed or was abandoned: to the checkout,
  // which says so (the buyer pays again or another way). A paid session always stays here. Any
  // status Stripe gives but succeeded / processing (failed, requires_payment_method, canceled…).
  const failedTo = failedReturnUrl(id, (await searchParams) as Record<string, string | string[] | undefined>, session.status);
  if (failedTo) redirect(failedTo);
  // Stripe's return parameters read: the page is served again from its clean URL before anything
  // loads (the PaymentIntent's client secret never reaches the pixels, analytics or the Referer).
  const cleanTo = cleanThankYouUrl(id, (await searchParams) as Record<string, string | string[] | undefined>);
  if (cleanTo) redirect(cleanTo);

  const design = await designFor(session.store, session);
  const storeTheme = loadTheme(design.theme, session.store.name);
  const theme = { ...storeTheme, language: await checkoutLang((await searchParams).lang, storeTheme.language) };
  // Browser pixel for the purchase, only once the payment is confirmed.
  // Same value as the server-side event (profit mode: the paid quote's costs and Whop's fee).
  const pixel =
    session.status === "PAID" ? browserPixel(session, "purchase", session.store.conversionValueMode === "profit" ? await marginContext(session) : undefined) : null;
  // "Automatique" offers get this order's frequently-bought-together product (hidden without one).
  const offers = session.status === "PAID" ? await resolveAutoOffers(session.store, session, activeUpsells({ thankYouLayout: design.thankYouLayout })) : activeUpsells({ thankYouLayout: design.thankYouLayout }).filter((b) => b.props.productSource !== "auto");
  const resolvedById = new Map(offers.map((b) => [b.id, b]));
  const thankYouLayout = loadThankYouLayout(design.thankYouLayout);
  const shownLayout = {
    ...thankYouLayout,
    blocks: thankYouLayout.blocks.flatMap((b): Block[] => {
      if (b.type !== "upsell" || b.props.productSource !== "auto") return [b];
      const resolved = resolvedById.get(b.id);
      return resolved ? [resolved] : [];
    }),
  };
  const eligible = upsellEligible(session);
  // Offer A/B: each visitor sees one arm, the same on every visit (server-decided).
  const arms = offerArmsFor(offers, visitorKeyOf(session));
  const [charges, localRates, livePrices, paidQuote] = await Promise.all([
    db.upsellCharge.findMany({ where: { sessionId: session.id }, select: { blockId: true, status: true } }),
    loadLocalRates(session.currency),
    eligible ? loadOfferPrices(session.store, offers, arms) : Promise.resolve({} as Record<string, number>),
    session.paidQuoteId ? db.checkoutQuote.findUnique({ where: { id: session.paidQuoteId }, select: { addOns: true } }) : null,
  ]);
  const fonts = themeFontHrefs(theme);
  const a = session.shippingAddress as Address | null;
  const pickup = session.pickupPoint as PickupPoint | null;
  const states = chargeStates(charges);
  // Offers whose targeting matches this order (chains are resolved on the page); a "% off"
  // offer without its live price is left out unless already answered.
  const offerIds = matchingUpsellIds(offers, await upsellContextFor(session.store, session, offers), arms).filter((id) => {
    const b = offers.find((x) => x.id === id)!;
    const p = offerArmProps(b, arms[id] ?? "A");
    return p.priceMode !== "percent" || states[id] != null || livePrices[variantGidOf(p.variantId) ?? ""] != null;
  });
  // Shipping protection bought at checkout: a line of the paid snapshot's add-ons.
  const paidAddOns = Array.isArray(paidQuote?.addOns) ? (paidQuote.addOns as { id?: string; title?: string; priceCents?: number }[]) : [];
  const protectionLine = paidAddOns.find((a) => a?.id === PROTECTION_ADDON_ID);
  const paidBumps = paidAddOns
    .filter((a) => a && a.id && a.id !== PROTECTION_ADDON_ID)
    .map((a) => ({ id: String(a.id), title: String(a.title ?? ""), priceCents: Number(a.priceCents) || 0 }));
  const protectionSource = protectionLine ? loadCheckoutLayout(design.checkoutLayout).blocks.find((b) => b.type === "shipping_protection") : undefined;
  // Claim instructions in the buyer's language (merchant translation, else the default translated).
  const protectionBlock = protectionSource ? localizeBlock(protectionSource, theme.language) : undefined;
  const buyerClaim = protectionLine
    ? await db.protectionClaim.findFirst({ where: { sessionId: session.id, source: "buyer" }, orderBy: { createdAt: "desc" }, select: { status: true, photos: { select: { id: true } } } })
    : null;
  const [rawRate, bumpRows] = await Promise.all([
    session.shippingRateId ? db.shippingRate.findUnique({ where: { id: session.shippingRateId }, select: { name: true, deliveryTime: true, i18n: true } }) : null,
    db.addOn.findMany({ where: { storeId: session.storeId, id: { in: paidBumps.map((b) => b.id) } }, select: { id: true, i18n: true } }),
  ]);
  // Rate name and delay, and the bumps taken, in the buyer's language (Shopify keeps the store's).
  const rate = rawRate
    ? {
        name: localizeRate(rawRate, theme.language).name,
        // The base delay gives the date range; the merchant's translation is shown otherwise.
        deliveryTime: rawRate.deliveryTime,
        deliveryText: recordText<string | null>(null, "deliveryTime", theme.language, rawRate.i18n),
      }
    : null;
  const bumpI18n = new Map(bumpRows.map((b) => [b.id, b.i18n]));
  const addOnItems = paidBumps.map((b) => ({ title: String(recordText(b.title, "title", theme.language, bumpI18n.get(b.id))), priceCents: b.priceCents }));
  // Back to the shop: where the buyer came from, else the storefront (custom domain, then *.myshopify.com).
  const shopHost = session.store.storefrontHost || session.store.shopDomain;
  const continueUrl = session.returnUrl
    ? `${session.returnUrl}${session.returnUrl.includes("?") ? "&" : "?"}whopco_paid=1`
    : shopHost
      ? `https://${shopHost}/?whopco_paid=1`
      : null;

  return (
    <>
      <CheckoutHtmlLang lang={theme.language} />
      {fonts.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      {pixel && <AdPixels {...pixel} />}
      <ThankYouView
        theme={theme}
        layout={liveLayoutPayload(shownLayout)}
        upsell={{ eligible, states, offerIds, arms, livePrices }}
        sessionId={session.id}
        storeKey={session.storeId}
        localRates={localRates}
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
          pickup: pickup
            ? { name: pickup.name, lines: [pickup.address1, `${pickup.zip} ${pickup.city}`], countryCode: pickup.countryCode }
            : null,
          lines: session.lines as unknown as CartLine[],
          currency: session.currency,
          subtotalCents: session.subtotalCents,
          discountCents: session.discountCents,
          discountCode: session.discountCents > 0 ? session.discountCode : null,
          shippingCents: session.shippingCents,
          addOnsCents: session.addOnsCents,
          totalCents: session.totalCents,
          continueUrl,
          shippingMethod: rate,
          addOnItems,
          paidAt: session.paidAt?.toISOString() ?? null,
          paymentMethod: session.paymentMethodType,
          // Universal carrier tracker: Shopify only gives us the number (dispute shield sync).
          protection: protectionLine
            ? {
                priceCents: Number(protectionLine.priceCents) || 0,
                claimText: protectionBlock?.type === "shipping_protection" ? protectionBlock.props.claimText : "",
                // Self-serve report: paid, within CLAIM_WINDOW_DAYS, no report being reviewed.
                claimable: session.status === "PAID" && claimWindowOpen(session.paidAt, true),
                claimStatus: (buyerClaim?.status as "pending" | "approved" | "rejected" | undefined) ?? null,
                // The buyer's own photos, through signed links (7 days).
                claimPhotos: (buyerClaim?.photos ?? []).map((p) => buyerPhotoUrl(p.id)),
              }
            : null,
          surveyAnswered: session.surveyAnswer != null,
          // Paid in the buyer's currency: the offers (charged in the shop's) say so.
          chargeCurrency: session.chargeCurrency,
          // A failed payment: back to this checkout (pays again, or another way).
          checkoutUrl: `/c/${session.id}${(await searchParams).via === "app" ? "?via=app" : ""}`,
          tracking: session.trackingNumber
            ? { number: session.trackingNumber, url: `https://t.17track.net/${theme.language}#nums=${encodeURIComponent(session.trackingNumber)}` }
            : null,
        }}
      />
    </>
  );
}
