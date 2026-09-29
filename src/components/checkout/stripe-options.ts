import type { ExpressCheckoutPaymentMethodsOption, StripePaymentElementOptions } from "@stripe/stripe-js";
import { expressMethodsSchema, type ExpressMethods } from "@/lib/layout";

/*
 * Stripe options derived from the checkout theme, kept apart from StripePanel (which the page loads
 * only when a Stripe checkout is on screen): the page decides with these whether to show Stripe's
 * express row without loading any Stripe code. Pure; type-only imports of Stripe.js.
 */

/**
 * The express wallets the merchant chose (builder > Paiement express), as Stripe's Express Checkout
 * Element options. Google Pay "auto" is allowed even for goods to ship (Stripe's express sheet
 * collects the shipping address); Whop Pay's place is taken by Link, Stripe's own one-click wallet.
 * PayPal shows only when enabled on the merchant's Stripe account. Pure.
 */
export function stripeExpressPaymentMethods(settings: Partial<ExpressMethods> | null | undefined): ExpressCheckoutPaymentMethodsOption {
  const s = expressMethodsSchema.parse(settings ?? {});
  return {
    applePay: s.applePay ? "always" : "never",
    googlePay: s.googlePay === "off" ? "never" : "always",
    link: s.whopPay ? "auto" : "never",
    paypal: s.paypal ? "auto" : "never",
    amazonPay: "never",
    klarna: "never",
  };
}

/** Whether any express wallet is switched on for Stripe. Pure. */
export function stripeExpressAny(settings: Partial<ExpressMethods> | null | undefined): boolean {
  return Object.values(stripeExpressPaymentMethods(settings)).some((v) => v !== "never");
}

/**
 * The Payment Element's wallets: never Apple Pay / Google Pay there when the express row above shows
 * them (one place per wallet), nor Link when the row offers it (Whop Pay's place, see
 * stripeExpressPaymentMethods); otherwise as the merchant chose them (builder > Paiement express),
 * Link left to Stripe (auto). Pure.
 */
export function stripePaymentWallets(settings: Partial<ExpressMethods> | null | undefined, expressRowShown: boolean): NonNullable<StripePaymentElementOptions["wallets"]> {
  const s = expressMethodsSchema.parse(settings ?? {});
  if (expressRowShown) return { applePay: "never", googlePay: "never", link: s.whopPay ? "never" : "auto" };
  return { applePay: s.applePay ? "auto" : "never", googlePay: s.googlePay === "off" ? "never" : "auto", link: "auto" };
}
