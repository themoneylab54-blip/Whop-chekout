import "server-only";
import { db } from "./db";
import { log } from "./log";
import { checkoutBaseUrl } from "./checkout-domain";
import { chooseProvider } from "./payment-provider";
import { prepareSession, quoteSchema, type QuoteInput } from "./checkout";
import { designFor } from "./experiments";
import { layoutWithOverrides, overridesFor } from "./checkout-tests";
import { loadCheckoutLayout, loadTheme } from "./layout";
import { checkoutCountries, countryHints, pickFirstCountry, shipsToCountry, storeMarketOf } from "./first-country";
import { resolveCheckoutLang, type Lang } from "@/components/checkout/i18n";

/**
 * The store's main market, pre-selected when the visitor's IP country is unknown or not
 * served: the most frequent shipping country of its recent paid orders that it still ships to.
 * Null without such orders: the shipping setup's dedicated country (storeMarketOf) is then weighed
 * by pickFirstCountry, after the language's country (before it for English). Shared by the checkout page and the early
 * prepare (same first country).
 */
export async function primaryCountryOf(storeId: string, rates: { countries: string[] }[]): Promise<string | null> {
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
      LIMIT 20`;
    // A market the store no longer ships to would be skipped by the checkout's list anyway.
    const served = rows.find((r) => shipsToCountry(rates, r.c));
    if (served) return served.c;
  } catch (err) {
    log.warn("checkout.primary_country_failed", "Main market lookup failed", { storeId, err });
  }
  return null;
}

/** How long the page (c/[id]/page.tsx) waits for the main market lookup before going on without it. */
export const PRIMARY_COUNTRY_MS = 800;

/** `p`, or `fallback` past `ms` (or when it fails). Same as the page's bound. */
export function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([p.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/**
 * The country the checkout page pre-selects for this visitor, exactly as CheckoutView picks it
 * (pickFirstCountry over the same list and hints as c/[id]/page.tsx gives it): the IP country when
 * shipped to, else the browser locale's, else the store's main market (`primary`, only asked when
 * needed), else the language's country, else its shipping setup's dedicated country, else the most common
 * market it ships to, else the first listed. Never null.
 */
export async function firstLoadCountry(
  rates: { countries: string[]; kind?: string | null; position?: number | null }[],
  ipCountry: string | null,
  acceptLanguage: string | null,
  opts: { language: Lang; primary?: () => Promise<string | null> },
): Promise<string> {
  const hints = countryHints(rates, ipCountry, acceptLanguage);
  const primaryCountry = hints.needsPrimary && opts.primary ? await opts.primary().catch(() => null) : null;
  const codes = checkoutCountries(rates, opts.language).map((c) => c.code);
  return pickFirstCountry(codes, { initialCountry: ipCountry, localeCountry: hints.localeCountry, primaryCountry, rateCountry: storeMarketOf(rates), language: opts.language });
}

/**
 * The input of the page's first /prepare (CheckoutView): the pre-selected country, no rate chosen
 * (the first one), no code typed, no order bump, the protection block's default as the page sends it
 * (`protection` only when the block is on the page), the cart's quantities.
 */
export function firstLoadInput(countryCode: string, protection?: boolean): QuoteInput {
  return quoteSchema.parse({ countryCode, shippingRateId: null, discountCode: null, addOnIds: [], ...(protection === undefined ? {} : { protection }) });
}

/** The shipping protection value the page sends on load: the visible block's default, else nothing. Pure. */
export function pageProtectionDefault(rawLayout: unknown): boolean | undefined {
  const block = loadCheckoutLayout(rawLayout).blocks.find((b) => b.type === "shipping_protection" && !b.hidden);
  return block?.type === "shipping_protection" ? block.props.defaultOn : undefined;
}

/**
 * Prepares a new session's Whop checkout right after its creation (after the loader's answer), with
 * the input the page's first /prepare will send: that prepare then finds the saved snapshot and its
 * configuration (same fingerprint) instead of waiting on Whop, and the express buttons show sooner.
 * A request racing it waits for it (prepareSession's claim). Whop only (a Stripe PaymentIntent is
 * created by the page itself), nothing journaled on failure (the page's own prepare retries and
 * handles the processor's failure), and the session isn't marked prepared (preparedAt: the page).
 */
export async function prepareAhead(sessionId: string, ctx: { ipCountry: string | null; acceptLanguage: string | null }): Promise<boolean> {
  try {
    const session = await db.checkoutSession.findUnique({ where: { id: sessionId }, include: { store: true } });
    if (!session || session.status !== "OPEN" || session.forcedProvider) return false;
    if (chooseProvider(session.store)?.provider !== "whop") return false;
    const [rates, design, overrides] = await Promise.all([
      db.shippingRate.findMany({ where: { storeId: session.storeId, active: true }, orderBy: { position: "asc" }, select: { countries: true, kind: true, position: true } }),
      designFor(session.store, session),
      overridesFor(session),
    ]);
    // The page's language (no ?lang= nor cookie yet on a fresh session: the browser's, else the store's).
    const language = resolveCheckoutLang({ acceptLanguage: ctx.acceptLanguage, fallback: loadTheme(design.theme, session.store.name).language });
    // The main market bounded as the page bounds it (800 ms, then none): the same first country, the same fingerprint.
    const country = await firstLoadCountry(rates, ctx.ipCountry, ctx.acceptLanguage, { language, primary: () => within(primaryCountryOf(session.storeId, rates), PRIMARY_COUNTRY_MS, null) });
    const protection = pageProtectionDefault(layoutWithOverrides(design.checkoutLayout, overrides));
    // The page is opened on the store's checkout URL (the loader's answer): its host makes the same return URL.
    const host = new URL(checkoutBaseUrl(session.store)).host;
    const prepared = await prepareSession(session, firstLoadInput(country, protection), { host, early: true });
    return prepared.provider === "whop";
  } catch (err) {
    log.info("checkout.prepare_ahead_failed", "Checkout not prepared ahead (the page prepares it)", { sessionId, err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
