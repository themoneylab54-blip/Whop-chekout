"use client";

import { useState, type ReactNode } from "react";
import { WhopCheckoutEmbed, WhopExpressCheckoutButton, useCheckoutEmbedControls } from "@whop/checkout/react";
import type { Theme } from "@/lib/layout";
import type { Labels } from "./i18n";

export type Prepared = { configId: string; environment: "sandbox" | "production" };

export type BuyerForPayment = {
  email: string;
  address: {
    name: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    postalCode: string;
    country: string;
    phone?: string;
  };
};

/** Result of saving the buyer before submitting: either go, or a refreshed checkout to pay instead. */
export type ConfirmResult = { ok: true; buyer: BuyerForPayment } | { ok: false; error?: string; refreshedConfigId?: string };

/**
 * Apple Pay / Google Pay / Whop Pay in one tap, shown at the top of the checkout.
 * Hides itself entirely when no wallet is available on the device.
 */
export function ExpressCheckout({
  prepared,
  theme,
  labels,
  returnUrl,
  email,
  onPaid,
  saveCard,
  termsNotice,
}: {
  prepared: Prepared | null;
  theme: Theme;
  labels: Labels;
  returnUrl: string;
  email: string;
  onPaid: () => void;
  /** Save the payment method for the one-click post-purchase offer. */
  saveCard?: boolean;
  termsNotice?: ReactNode;
}) {
  const [rendered, setRendered] = useState<string | null>(null);
  if (!prepared || rendered === "none") return null;
  return (
    <section className="mb-2" aria-label={labels.expressCheckout}>
      <p className="mb-3 text-center text-xs font-medium tracking-wide text-neutral-500 uppercase">{labels.expressCheckout}</p>
      <WhopExpressCheckoutButton
        key={prepared.configId}
        checkoutConfigurationId={prepared.configId}
        environment={prepared.environment}
        returnUrl={returnUrl}
        theme="light"
        locale={theme.language}
        collectShipping
        setupFutureUsage={saveCard ? "off_session" : undefined}
        prefill={email ? { email } : undefined}
        onExpressMethodResolved={({ rendered: r }) => setRendered(r)}
        onComplete={onPaid}
        fallback={<div className="h-12 animate-pulse rounded-[var(--radius)] bg-neutral-100" />}
      />
      {termsNotice}
      <div className="my-6 flex items-center gap-3 text-xs text-neutral-400">
        <span className="h-px flex-1 bg-neutral-200" />
        {labels.or}
        <span className="h-px flex-1 bg-neutral-200" />
      </div>
    </section>
  );
}

/**
 * The payment step of the one-page checkout: the Whop form (card, PayPal, wallets…)
 * is always visible, and our own "Pay" button saves the buyer then submits it.
 */
export function PaymentPanel({
  prepared,
  preparing,
  prepareError,
  theme,
  labels,
  payLabel,
  returnUrl,
  testMode,
  confirm,
  onPaid,
  saveCard,
  beforeButton,
}: {
  prepared: Prepared | null;
  preparing: boolean;
  prepareError: string | null;
  theme: Theme;
  labels: Labels;
  payLabel: string;
  returnUrl: string;
  testMode: boolean;
  confirm: () => Promise<ConfirmResult>;
  onPaid: () => void;
  saveCard?: boolean;
  beforeButton?: ReactNode;
}) {
  const controls = useCheckoutEmbedControls();
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBillingForm, setShowBillingForm] = useState(false);

  async function pay() {
    setError(null);
    setSubmitting(true);
    try {
      const result = await confirm();
      if (!result.ok) {
        setSubmitting(false);
        if (result.refreshedConfigId) setError(labels.totalUpdated);
        else if (result.error) setError(result.error);
        return;
      }
      const c = controls.current;
      if (!c) throw new Error(labels.paymentNotReady);
      await c.setEmail(result.buyer.email).catch(() => undefined);
      if (!showBillingForm) await c.setAddress(result.buyer.address).catch(() => undefined);
      await c.submit();
      // Completion arrives through onComplete; errors through onPaymentError.
    } catch (err) {
      setSubmitting(false);
      setError(err instanceof Error ? err.message : labels.paymentFailed);
    }
  }

  const busy = submitting || preparing || !prepared || !ready;

  return (
    <div className="space-y-3">
      <div className="relative min-h-[120px] overflow-hidden rounded-[var(--radius)] border border-neutral-200 bg-white p-1">
        {prepared ? (
          <WhopCheckoutEmbed
            key={prepared.configId}
            ref={controls}
            sessionId={prepared.configId}
            environment={prepared.environment}
            theme="light"
            locale={theme.language}
            themeOptions={{ accentColor: theme.accentColor, borderRadius: theme.radius }}
            hideSubmitButton
            hideEmail
            hideAddressForm={!showBillingForm}
            hideTermsAndConditions={false}
            setupFutureUsage={saveCard ? "off_session" : undefined}
            skipRedirect
            returnUrl={returnUrl}
            onStateChange={(s) => setReady(s === "ready")}
            onComplete={onPaid}
            onPaymentError={(e) => {
              setSubmitting(false);
              setError(e.message || labels.paymentFailed);
            }}
            onAddressValidationError={(e) => {
              setSubmitting(false);
              setShowBillingForm(true);
              setError(e.error_message || labels.checkBillingAddress);
            }}
            fallback={<PaymentSkeleton />}
          />
        ) : (
          <PaymentSkeleton />
        )}
        {(preparing || (prepared && !ready)) && (
          <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-3">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-r-transparent" />
          </div>
        )}
      </div>

      {(error || prepareError) && (
        <p role="alert" className="rounded-[var(--radius)] bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? prepareError}
        </p>
      )}

      {beforeButton}

      <button
        type="button"
        disabled={busy || !!prepareError}
        onClick={pay}
        className="flex w-full items-center justify-center gap-2 rounded-[var(--btn-radius)] bg-[image:var(--accent-bg)] px-5 py-4 text-base font-semibold text-[var(--accent-fg)] shadow-[var(--btn-shadow)] transition hover:brightness-110 active:scale-[.99] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {(submitting || preparing) && <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />}
        {payLabel}
      </button>
      <p className="flex items-center justify-center gap-1.5 text-xs text-neutral-500">
        <LockIcon /> {labels.paymentSecure}
      </p>
      {testMode && (
        <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">Mode test : paiement sandbox Whop, aucune somme réelle débitée.</p>
      )}
    </div>
  );
}

function PaymentSkeleton() {
  return (
    <div className="space-y-3 p-4" aria-hidden>
      <div className="h-11 animate-pulse rounded-md bg-neutral-100" />
      <div className="grid grid-cols-2 gap-3">
        <div className="h-11 animate-pulse rounded-md bg-neutral-100" />
        <div className="h-11 animate-pulse rounded-md bg-neutral-100" />
      </div>
    </div>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** Static stand-in for the builder preview (no live Whop form there). */
export function PaymentPreview({ labels, payLabel, beforeButton }: { labels: Labels; payLabel: string; beforeButton?: ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="space-y-3 rounded-[var(--radius)] border border-neutral-200 bg-white p-4">
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          {["Carte", "PayPal", "Apple Pay", "Google Pay"].map((m, i) => (
            <span key={m} className={`rounded-md border px-3 py-2 ${i === 0 ? "border-[var(--accent)] text-[var(--accent)]" : "border-neutral-200 text-neutral-600"}`}>
              {m}
            </span>
          ))}
        </div>
        <div className="h-11 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-400">1234 1234 1234 1234</div>
        <div className="grid grid-cols-2 gap-3">
          <div className="h-11 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-400">MM / AA</div>
          <div className="h-11 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-400">CVC</div>
        </div>
      </div>
      {beforeButton}
      <div className="flex w-full items-center justify-center rounded-[var(--btn-radius)] bg-[image:var(--accent-bg)] px-5 py-4 text-base font-semibold text-[var(--accent-fg)] shadow-[var(--btn-shadow)]">
        {payLabel}
      </div>
      <p className="flex items-center justify-center gap-1.5 text-xs text-neutral-500">
        <LockIcon /> {labels.paymentSecure}
      </p>
    </div>
  );
}

/** Static express buttons for the builder preview. */
export function ExpressPreview({ labels }: { labels: Labels }) {
  return (
    <section className="mb-2">
      <p className="mb-3 text-center text-xs font-medium tracking-wide text-neutral-500 uppercase">{labels.expressCheckout}</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex h-12 items-center justify-center gap-1 rounded-[var(--radius)] bg-black text-[15px] font-semibold text-white">
          <AppleLogo /> Pay
        </div>
        <div className="flex h-12 items-center justify-center gap-1 rounded-[var(--radius)] bg-black text-[15px] font-semibold text-white">
          <GoogleG /> Pay
        </div>
      </div>
      <div className="my-6 flex items-center gap-3 text-xs text-neutral-400">
        <span className="h-px flex-1 bg-neutral-200" />
        {labels.or}
        <span className="h-px flex-1 bg-neutral-200" />
      </div>
    </section>
  );
}

function AppleLogo() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden>
      <path d="M16.37 12.62c-.02-2.3 1.88-3.4 1.96-3.46-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.47.83-.72 0-1.82-.81-2.99-.79a4.43 4.43 0 0 0-3.74 2.27c-1.6 2.77-.41 6.87 1.15 9.12.76 1.1 1.67 2.33 2.86 2.29 1.15-.05 1.58-.74 2.97-.74 1.38 0 1.77.74 2.98.72 1.23-.02 2.01-1.12 2.76-2.23a9.8 9.8 0 0 0 1.25-2.57 3.98 3.98 0 0 1-2.41-3.64zM14.1 5.86c.63-.77 1.06-1.83.94-2.89-.91.04-2.01.61-2.66 1.37-.58.67-1.1 1.76-.96 2.8 1.01.08 2.05-.52 2.68-1.28z" />
    </svg>
  );
}

function GoogleG() {
  return (
    <svg viewBox="0 0 24 24" className="h-[17px] w-[17px]" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.56c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.77c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.2 1.64l3.15-3.15A10.95 10.95 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
    </svg>
  );
}
