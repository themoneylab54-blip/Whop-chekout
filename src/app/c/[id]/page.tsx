import type { Metadata } from "next";
import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { headers } from "next/headers";
import { geoCountryOf } from "@/lib/geo";
import { localizeRate, recordText } from "@/components/checkout/localize";
import { after } from "next/server";
import { db } from "@/lib/db";
import { themeFontHrefs, loadCheckoutLayout, loadInterception, loadTheme, variantGidOf, type Layout } from "@/lib/layout";
import { subtotal, type CartLine } from "@/lib/pricing";
import { addOnEligible } from "@/lib/checkout";
import { CheckoutView } from "@/components/checkout/CheckoutView";
import { designFor } from "@/lib/experiments";
import { layoutWithOverrides, overridesFor, withAddOnOverrides } from "@/lib/checkout-tests";
import { loginCodeEnabled } from "@/lib/returning";
import { activeUpsells } from "@/lib/upsell";
import { browserPixel } from "@/lib/conversions";
import { AdPixels } from "@/components/checkout/AdPixels";
import { DEFAULT_COUNTRIES, labelsFor, localeCountries } from "@/components/checkout/i18n";
import { buyerIcons, checkoutLang, CheckoutHtmlLang } from "@/app/c/lang";
import { keepOnCheckoutHost } from "@/app/c/host";
import { priceCart } from "@/lib/shopify";
import { crossRate, ecbRates } from "@/lib/fx";
import { log } from "@/lib/log";
import { localRatesFor, type LocalRates } from "@/components/checkout/localCurrency";
import { mergeRecommendations, type RecommendationView } from "@/components/checkout/recommendations";
import { canReadShopifyDiscounts } from "@/lib/shopify-discounts";

export const dynamic = "force-dynamic";

// Shared by generateMetadata and the page: one query per request.
const loadSession = cache((id: string) => db.checkoutSession.findUnique({ where: { id }, include: { store: true } }));

/** Tab title "<Store> · Paiement" in the checkout's language (no app suffix). */
type PageProps = { params: Promise<{ id: string }>; searchParams: Promise<{ lang?: string | string[]; via?: string | string[]; payment?: string | string[] }> };

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const session = await loadSession(id);
  const theme = session ? loadTheme(session.store.theme, session.store.name) : null;
  const L = labelsFor(await checkoutLang((await searchParams).lang, theme?.language ?? "fr"));
  const name = theme?.storeName || session?.store.name;
  return { title: { absolute: name ? `${name} · ${L.checkoutTitle}` : L.securePayment }, robots: { index: false }, icons: buyerIcons(theme?.logoUrl) };
}

/** Resolves to `fallback` when `p` takes longer than `ms` (the page never waits on a slow API). */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/**
 * Live Shopify data of the "Complétez votre commande" products (price, compare-at, photo,
 * availability). Any failure hides the block: never a stale or made-up price.
 */
async function loadRecommendations(
  layout: Layout,
  store: Parameters<typeof priceCart>[0] & { interception: unknown },
): Promise<RecommendationView[] | null> {
  const block = layout.blocks.find((b) => b.type === "recommendations" && !b.hidden);
  if (!block || block.type !== "recommendations") return null;
  const items = block.props.items
    .map((it) => ({ ...it, variantId: variantGidOf(it.variantId) ?? "" }))
    .filter((it) => it.variantId);
  if (!items.length) return null;
  try {
    const priced = await priceCart(store, items.map((it) => ({ variantId: it.variantId, quantity: 1 })));
    return mergeRecommendations(items, priced, loadInterception(store.interception).excludedHandles);
  } catch (err) {
    log.warn("checkout.recommendations_failed", "Recommendations pricing failed", { err });
    return null;
  }
}

/**
 * The store's main market, pre-selected when the visitor's IP country is unknown or not
 * served: the most frequent shipping country of its recent paid orders, else the first
 * country of its first shipping rate. Null when neither says anything.
 */
async function primaryCountryOf(storeId: string, rates: { countries: string[] }[]): Promise<string | null> {
  try {
    const rows = await db.$queryRaw<{ c: string }[]>`
      SELECT c FROM (
        SELECT upper(s."shippingAddress"->>'countryCode') AS c
        FROM "CheckoutSession" s
        WHERE s."storeId" = ${storeId} AND s.status = 'PAID' AND s."shippingAddress" IS NOT NULL
        ORDER BY s."createdAt" DESC
        LIMIT 500
      ) recent
      WHERE c ~ '^[A-Z]{2}$'
      GROUP BY c
      ORDER BY count(*) DESC, c
      LIMIT 1`;
    if (rows[0]?.c) return rows[0].c;
  } catch (err) {
    log.warn("checkout.primary_country_failed", "Main market lookup failed", { storeId, err });
  }
  return rates.find((r) => r.countries.length > 0)?.countries[0] ?? null;
}

/** Multipliers to the buyers' local currencies (ECB, cached 12 h); null when unavailable. */
async function loadLocalRates(currency: string): Promise<LocalRates | null> {
  try {
    const fx = await ecbRates();
    if (!fx) return null;
    const rates = localRatesFor(currency, (from, to) => crossRate(from, to, fx.rates));
    return Object.keys(rates).length ? rates : null;
  } catch {
    return null;
  }
}

export default async function CheckoutPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const session = await loadSession(id);
  if (!session) notFound();
  // The store's own checkout domain (checkout.seyuna.com) when it has a verified one.
  await keepOnCheckoutHost(session.store, `/c/${id}`, (await searchParams) as Record<string, string | string[] | undefined>);
  // via=app (loader fallback: the checkout domain is unreachable for this buyer) stays on APP_URL.
  if (session.status === "PAID") redirect(`/c/${id}/merci${(await searchParams).via === "app" ? "?via=app" : ""}`);

  const { store } = session;
  const [rates, storeAddOns, discountCount, overrides] = await Promise.all([
    db.shippingRate.findMany({ where: { storeId: store.id, active: true }, orderBy: { position: "asc" } }),
    db.addOn.findMany({ where: { storeId: store.id, active: true }, orderBy: { position: "asc" } }),
    db.discountCode.count({ where: { storeId: store.id, active: true } }),
    // Checkout A/B tests (arm B): bump prices / visibility and the protection's pricing, as the quote prices them.
    overridesFor(session),
  ]);
  const addOns = withAddOnOverrides(storeAddOns, overrides);
  // A/B test: variant B sessions render the tested design.
  const design = await designFor(store, session);
  const storeTheme = loadTheme(design.theme, store.name);
  // The buyer's language (?lang=, their earlier choice, Accept-Language), else the store's.
  const theme = { ...storeTheme, language: await checkoutLang((await searchParams).lang, storeTheme.language) };
  // Language the buyer actually sees (analytics): recorded after the response, never blocking it.
  if (session.lang !== theme.language) {
    const lang = theme.language;
    after(() =>
      db.checkoutSession
        .updateMany({ where: { id: session.id, status: { not: "PAID" } }, data: { lang } })
        .then(
          () => undefined,
          (err) => log.warn("checkout.lang_record_failed", "Could not record the checkout language", { sessionId: session.id, err }),
        ),
    );
  }
  const fonts = themeFontHrefs(theme);
  // Save the card for the one-click post-purchase offer only when one is live.
  const pixel = browserPixel(session, "checkout");
  const saveCard = activeUpsells({ thankYouLayout: design.thankYouLayout }).length > 0;
  // The Shopify cart, for the breadcrumb / "Back to cart" (custom domain first).
  const shopHost = store.storefrontHost || store.shopDomain;
  const lines = session.lines as unknown as CartLine[];
  const reqHeaders = await headers();
  const initialCountry = geoCountryOf(reqHeaders);
  // IP country (funnel by country): sessions created by an older loader call record it here.
  if (initialCountry && !session.geoCountry) {
    after(() =>
      db.checkoutSession.updateMany({ where: { id: session.id, geoCountry: null }, data: { geoCountry: initialCountry } }).then(
        () => undefined,
        (err) => log.warn("checkout.geo_record_failed", "Could not record the IP country", { sessionId: session.id, err }),
      ),
    );
  }
  // Order bumps whose display rules match, so none flashes in before the first quote.
  const ruleCtx = { subtotalCents: subtotal(lines), productIds: lines.map((l) => l.productId), country: initialCountry };
  const layout = loadCheckoutLayout(layoutWithOverrides(design.checkoutLayout, overrides));
  const shipsTo = (code: string) => rates.some((r) => (r.countries.length ? r.countries : DEFAULT_COUNTRIES).includes(code));
  const served = initialCountry != null && shipsTo(initialCountry);
  // No usable IP country: the browser's locale country ("de-DE" → Germany) when shipped to,
  // before the store's main market.
  const localeCountry = served ? null : (localeCountries(reqHeaders.get("accept-language")).find(shipsTo) ?? null);
  // Both are optional extras: a slow Shopify / ECB answer hides them instead of delaying the page.
  const [recommendations, localRates, primaryCountry] = await Promise.all([
    within(loadRecommendations(layout, store), 2500, null),
    within(loadLocalRates(session.currency), 1500, null),
    // Only needed when the IP country can't be pre-selected.
    served || localeCountry ? null : within(primaryCountryOf(store.id, rates), 800, null),
  ]);

  return (
    <>
      <CheckoutHtmlLang lang={theme.language} />
      {fonts.map((href) => (
        <link key={href} rel="stylesheet" href={href} />
      ))}
      {pixel && <AdPixels {...pixel} />}
      <CheckoutView
        theme={theme}
        layout={layout}
        currency={session.currency}
        lines={lines}
        // Only what the page needs (no carrier costs in the browser).
        rates={rates.map((r) => localizeRate(r, theme.language)).map((r) => ({
          id: r.id,
          name: r.name,
          deliveryTime: r.deliveryTime,
          countries: r.countries,
          priceCents: r.priceCents,
          freeOverCents: r.freeOverCents,
          active: r.active,
          kind: r.kind,
        }))}
        // Order bumps in the buyer's language (the Shopify line keeps the base title).
        addOns={addOns.map((a) => ({
          id: a.id,
          title: String(recordText(a.title, "title", theme.language, a.i18n)),
          description: recordText(a.description, "description", theme.language, a.i18n),
          priceCents: a.priceCents,
          imageUrl: a.imageUrl,
        }))}
        // Shopify codes (when enabled and readable) need the promo field too, even without app codes.
        hasDiscounts={discountCount > 0 || (store.shopifyDiscountCodes && canReadShopifyDiscounts(store))}
        // payment=failed: back from a Stripe redirect (3-D Secure, bank page) that failed (see merci/page).
        mode={{ kind: "live", sessionId: session.id, testMode: store.testMode, saveCard, paymentFailed: (await searchParams).payment === "failed" }}
        initialEmail={session.email}
        initialCountry={initialCountry}
        localeCountry={localeCountry}
        primaryCountry={primaryCountry}
        initialEligibleAddOnIds={addOns.filter((a) => addOnEligible(a.showIf, ruleCtx)).map((a) => a.id)}
        cartUrl={shopHost ? `https://${shopHost}/cart` : null}
        recommendations={recommendations}
        localRates={localRates}
        returningCode={await loginCodeEnabled(session.store)}
      />
    </>
  );
}
