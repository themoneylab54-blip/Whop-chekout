import "server-only";
import { db } from "./db";
import { cachedEcbRates, crossRate, ecbRates, lastFxAttempt, refreshEcbRates, type FxAttempt } from "./fx";
import { recordIncident } from "./incidents";
import { COUNTRY_CURRENCY } from "@/components/checkout/localCurrency";

/*
 * Optional "charge in the buyer's currency" (Store.chargeLocalCurrency). Whop checkout
 * configurations take any of their supported currencies, so a Swiss buyer can be charged in CHF
 * instead of having their bank convert euros. The shop keeps pricing in its own currency: the
 * total is converted at the ECB reference rate (at most 3 days old) and rounded UP to the
 * currency's smallest unit (whole units for currencies written without cents), never down.
 * Everything else (Shopify order, analytics, refunds entered in the dashboard) stays in the
 * shop currency; Whop amounts in the charge currency are converted back with the rate frozen
 * on the paid quote.
 */

/** Currencies Whop checkout configurations accept that buyers' countries use (see localCurrency.ts). */
export const WHOP_CHARGE_CURRENCIES = new Set(["CHF", "GBP", "SEK", "DKK", "NOK", "PLN", "CZK", "HUF", "RON", "USD", "CAD"]);
const NO_DECIMALS = new Set(["HUF", "CZK"]);
const MAX_RATE_AGE_DAYS = 3;

export type ChargePlan = { currency: string; totalCents: number; rate: number };

/** Smallest amount Whop charges or refunds in a currency, in its cents (a whole unit for HUF/CZK). Pure. */
export function chargeStep(currency: string | null | undefined): number {
  return currency && NO_DECIMALS.has(currency.toUpperCase()) ? 100 : 1;
}

/** Rounded charge amount (cents of `currency`): up to the next cent, or unit for HUF/CZK. Pure. */
export function roundCharge(cents: number, currency: string): number {
  const step = chargeStep(currency);
  return Math.ceil(Math.round(cents * 1000) / 1000 / step) * step;
}

/** The plan for these inputs and rates, or null (charged in the shop currency). Pure. */
export function chargePlanWith(
  opts: { enabled: boolean; country: string | null | undefined; shopCurrency: string; totalCents: number },
  rates: { date: string; rates: Record<string, number> } | null,
  now = new Date(),
): ChargePlan | null {
  if (!opts.enabled || !opts.country || !rates || opts.totalCents <= 0) return null;
  const currency = COUNTRY_CURRENCY[opts.country.toUpperCase()];
  if (!currency || currency === opts.shopCurrency.toUpperCase() || !WHOP_CHARGE_CURRENCIES.has(currency)) return null;
  // A stale rate would charge a wrong amount: fall back to the shop currency.
  if (!ratesFresh(rates, now)) return null;
  const rate = crossRate(opts.shopCurrency, currency, rates.rates);
  if (rate == null || !Number.isFinite(rate) || rate <= 0) return null;
  return { currency, totalCents: roundCharge(opts.totalCents * rate, currency), rate };
}

/** Plan for a store's checkout (reads the cached ECB rates only when the option is on). */
export async function chargePlan(store: { chargeLocalCurrency: boolean; shopCurrency: string }, country: string | null | undefined, totalCents: number): Promise<ChargePlan | null> {
  if (!store.chargeLocalCurrency || !country) return null;
  return chargePlanWith({ enabled: true, country, shopCurrency: store.shopCurrency, totalCents }, await ecbRates());
}

export type ChargeFallback = { currency: string; reason: "no_rates" | "stale_rates" | "no_rate" };

/** Why a buyer who should be charged in their currency (option on, Whop currency) isn't: pure part. */
export function chargeFallbackWith(
  opts: { shopCurrency: string; country: string },
  rates: { date: string; rates: Record<string, number> } | null,
  now = new Date(),
): ChargeFallback | null {
  const currency = COUNTRY_CURRENCY[opts.country.toUpperCase()];
  if (!currency || currency === opts.shopCurrency.toUpperCase() || !WHOP_CHARGE_CURRENCIES.has(currency)) return null;
  if (!rates) return { currency, reason: "no_rates" };
  if (!ratesFresh(rates, now)) return { currency, reason: "stale_rates" };
  const rate = crossRate(opts.shopCurrency, currency, rates.rates);
  return rate == null || !Number.isFinite(rate) || rate <= 0 ? { currency, reason: "no_rate" } : null;
}

/** Store with the option on, buyer's country given: the fallback reason (cached rates only). */
export async function chargeFallback(store: { shopCurrency: string }, country: string): Promise<ChargeFallback | null> {
  return chargeFallbackWith({ shopCurrency: store.shopCurrency, country }, await ecbRates());
}

/** ECB rates at most MAX_RATE_AGE_DAYS old (published ~16:00 CET on their date). Pure. */
export function ratesFresh(rates: { date: string }, now = new Date()): boolean {
  return (now.getTime() - Date.parse(`${rates.date}T16:00:00Z`)) / 86_400_000 <= MAX_RATE_AGE_DAYS;
}

/** An amount Whop reports in the charge currency, back in the shop currency. Pure. */
export function toShopCents(cents: number, rate: number | null | undefined): number {
  return rate && rate > 0 ? Math.round(cents / rate) : cents;
}

/** A shop-currency amount (e.g. a partial refund typed in the dashboard) in the charge currency. Pure. */
export function toChargeCents(cents: number, rate: number | null | undefined): number {
  return rate && rate > 0 ? Math.round(cents * rate) : cents;
}

/* Background upkeep ---------------------------------------------------------------- */

export type FxHealth = { optionStores: number; date: string | null; fresh: boolean; lastAttempt: FxAttempt | null };

/** Whether the rates buyers are charged with are usable (health tiles and probe). */
export async function fxHealth(): Promise<FxHealth> {
  const [optionStores, rates, lastAttempt] = await Promise.all([db.store.count({ where: { chargeLocalCurrency: true, enabled: true } }), cachedEcbRates(), lastFxAttempt()]);
  return { optionStores, date: rates?.date ?? null, fresh: !!rates && ratesFresh(rates), lastAttempt };
}

/**
 * Tick job: refreshes the ECB rates off the buyer's path (every 12 h, backoff after a failure),
 * then, while a store charges in local currency, journals and alerts (every 6 h per store) when
 * the rates are over 3 days old: its foreign buyers are charged in the shop currency meanwhile.
 */
export async function fxUpkeep(): Promise<number> {
  // Only rates someone uses: a store charging in local currency, or a cache the dashboard / ad spend read.
  const optionStores = await db.store.count({ where: { chargeLocalCurrency: true, enabled: true } });
  if (!optionStores && !(await cachedEcbRates())) return 0;
  const rates = await refreshEcbRates();
  if (!optionStores) return rates && !rates.stale ? 1 : 0;
  if (rates && ratesFresh(rates)) return rates.stale ? 0 : 1;
  const stores = await db.store.findMany({ where: { chargeLocalCurrency: true, enabled: true }, select: { id: true } });
  const last = await lastFxAttempt();
  for (const s of stores) {
    await recordIncident({
      storeId: s.id,
      kind: "fx.stale",
      message: `Taux de change BCE ${rates ? `du ${rates.date} (plus de 3 jours)` : "indisponibles"} : les acheteurs étrangers paient dans la devise de la boutique en attendant.${last?.error ? ` Dernière erreur : ${last.error}` : ""}`,
      data: { date: rates?.date ?? null, lastAttempt: last },
      everyMs: 6 * 3600_000,
    });
  }
  return 0;
}

/**
 * The processor's fee on a paid checkout: Whop's (whopFeeCents) or another processor's
 * (providerFeeCents, e.g. Stripe's balance transaction fee). Null when unknown. Pure.
 */
export function feeCents(s: { whopFeeCents?: number | null; providerFeeCents?: number | null }): number | null {
  return s.whopFeeCents ?? s.providerFeeCents ?? null;
}

/**
 * Amount to ask the processor (Whop or Stripe) to refund for `amountCents` typed in the shop
 * currency; same rule for both (Stripe refunds in the charged currency too). See whopRefundAmount.
 */
export function providerRefundAmount(o: Parameters<typeof whopRefundAmount>[0]): number | undefined {
  return whopRefundAmount(o);
}

/**
 * Amount to ask Whop to refund for `amountCents` typed in the shop currency (undefined = the whole
 * payment). Charged in the buyer's currency: in that currency, the remaining refund being exactly
 * chargeTotal − refundedCharge (never a rounded conversion of the shop-currency remainder). Pure.
 */
export function whopRefundAmount(o: {
  amountCents: number;
  totalCents: number;
  refundedCents: number;
  chargeTotalCents: number | null;
  refundedChargeCents: number;
  rate: number | null;
  /** The charge currency (HUF / CZK are refunded in whole units). */
  currency?: string | null;
}): number | undefined {
  const remaining = o.totalCents - o.refundedCents;
  if (o.chargeTotalCents == null || !o.rate) return o.amountCents === o.totalCents ? undefined : o.amountCents;
  const leftCharge = Math.max(0, o.chargeTotalCents - o.refundedChargeCents);
  if (o.amountCents >= remaining) return o.refundedChargeCents === 0 && o.refundedCents === 0 ? undefined : leftCharge;
  // A partial refund is a whole number of the currency's steps (HUF / CZK: whole units, what Whop
  // accepts) and never takes the whole remaining charge (that one is the "rest" button).
  const step = chargeStep(o.currency);
  const below = Math.floor((leftCharge - 1) / step) * step;
  if (below < step) return Math.max(1, Math.min(toChargeCents(o.amountCents, o.rate), leftCharge - 1));
  const rounded = Math.round(toChargeCents(o.amountCents, o.rate) / step) * step;
  return Math.min(below, Math.max(step, rounded));
}
