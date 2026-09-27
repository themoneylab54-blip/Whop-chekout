"use client";

import { useState } from "react";
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
}: {
  prepared: Prepared | null;
  theme: Theme;
  labels: Labels;
  returnUrl: string;
  email: string;
  onPaid: () => void;
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
        prefill={email ? { email } : undefined}
        onExpressMethodResolved={({ rendered: r }) => setRendered(r)}
        onComplete={onPaid}
        fallback={<div className="h-12 animate-pulse rounded-[var(--radius)] bg-neutral-100" />}
      />
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

      <button
        type="button"
        disabled={busy || !!prepareError}
        onClick={pay}
        className="flex w-full items-center justify-center gap-2 rounded-[var(--radius)] bg-[var(--accent)] px-5 py-4 text-base font-semibold text-[var(--accent-fg)] shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
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
export function PaymentPreview({ labels, payLabel }: { labels: Labels; payLabel: string }) {
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
      <div className="flex w-full items-center justify-center rounded-[var(--radius)] bg-[var(--accent)] px-5 py-4 text-base font-semibold text-[var(--accent-fg)]">
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
        <div className="flex h-12 items-center justify-center rounded-[var(--radius)] bg-black text-sm font-semibold text-white"> Pay</div>
        <div className="flex h-12 items-center justify-center rounded-[var(--radius)] bg-black text-sm font-semibold text-white">G Pay</div>
      </div>
      <div className="my-6 flex items-center gap-3 text-xs text-neutral-400">
        <span className="h-px flex-1 bg-neutral-200" />
        {labels.or}
        <span className="h-px flex-1 bg-neutral-200" />
      </div>
    </section>
  );
}
