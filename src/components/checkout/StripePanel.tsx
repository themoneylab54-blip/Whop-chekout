"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Clock3, RefreshCw } from "lucide-react";
// The "pure" entry point: Stripe.js is only fetched when loadStripe is called (a Stripe checkout on
// screen), never injected on import (every Whop checkout would otherwise download it).
import { loadStripe } from "@stripe/stripe-js/pure";
import type { Appearance, Stripe, StripeElementsOptions, StripeError } from "@stripe/stripe-js";
import { Elements, ExpressCheckoutElement, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import type { StripeExpressCheckoutElementConfirmEvent, StripeExpressCheckoutElementOptions } from "@stripe/stripe-js";
import { fontHref, type Theme } from "@/lib/layout";
import { stripeExpressAny, stripeExpressPaymentMethods, stripePaymentWallets } from "./stripe-options";
import { contrastRatio, fieldBorderColor, mix } from "@/lib/contrast";
import type { Labels } from "./i18n";
import { Divider, LockIcon, PaymentSkeleton, SERVER_WAIT_POLL_MS, serverWaitNext, type BuyerForPayment, type ConfirmResult, type PaidCheck, type PanelLock, type Prepared } from "./Payment";

/*
 * Stripe's side of the one-page checkout (the store's connected Stripe account, direct charges): the
 * Payment Element in the payment section and the Express Checkout Element in the express row, both
 * styled from the checkout theme. Same contract as Whop's panel: our Pay button saves the buyer
 * (confirm(): the server checks totals, terms and any payment in flight) and only then confirms the
 * PaymentIntent (redirect only when the method needs it: 3-D Secure pages, bank redirects).
 */

/** Stripe.js not loaded within this time (blocked, very slow network): the page gives up on it. */
export const STRIPE_LOAD_TIMEOUT_MS = 8_000;

/**
 * One Stripe.js instance per publishable key and connected account (loadStripe must not run per
 * render). Rejects when Stripe.js doesn't load (script blocked or failing, no Stripe object, or not
 * within `timeoutMs`); a failed load is dropped from the cache so a later attempt loads again.
 */
const stripes = new Map<string, Promise<Stripe>>();
export function stripeInstance(publishableKey: string, stripeAccount: string, timeoutMs = STRIPE_LOAD_TIMEOUT_MS): Promise<Stripe> {
  const key = `${publishableKey}|${stripeAccount}`;
  let p = stripes.get(key);
  if (!p) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("stripe_load_timeout")), timeoutMs);
    });
    p = Promise.race([
      Promise.resolve()
        .then(() => loadStripe(publishableKey, { stripeAccount }))
        .then((s) => {
          if (!s) throw new Error("stripe_unavailable");
          return s;
        }),
      timeout,
    ]).finally(() => clearTimeout(timer));
    const loading = p;
    loading.catch(() => {
      if (stripes.get(key) === loading) stripes.delete(key);
    });
    stripes.set(key, loading);
  }
  return p;
}

/**
 * Stripe.js for a prepared PaymentIntent: the instance once loaded, `failed` when it couldn't load
 * (onFailed is called once per failed load: the page reports it and switches the buyer to Whop).
 */
function useStripeJs(publishableKey: string | undefined, stripeAccount: string | undefined, onFailed?: () => void, attempt = 0): { stripe: Stripe | null; failed: boolean } {
  const [state, setState] = useState<{ key: string; stripe: Stripe | null; failed: boolean }>({ key: "", stripe: null, failed: false });
  const onFailedRef = useRef(onFailed);
  useEffect(() => {
    onFailedRef.current = onFailed;
  });
  const key = publishableKey && stripeAccount ? `${publishableKey}|${stripeAccount}|${attempt}` : "";
  useEffect(() => {
    if (!publishableKey || !stripeAccount) return;
    let alive = true;
    const k = `${publishableKey}|${stripeAccount}|${attempt}`;
    stripeInstance(publishableKey, stripeAccount).then(
      (stripe) => {
        if (alive) setState({ key: k, stripe, failed: false });
      },
      () => {
        if (!alive) return;
        setState({ key: k, stripe: null, failed: true });
        onFailedRef.current?.();
      },
    );
    return () => {
      alive = false;
    };
  }, [publishableKey, stripeAccount, attempt]);
  return state.key === key ? { stripe: state.stripe, failed: state.failed } : { stripe: null, failed: false };
}

/** The page's origin (Stripe loads the theme font's stylesheet from it). Stripe's forms only mount in the browser, after a prepare. */
function pageOrigin(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.origin;
}

function fontStack(font: string) {
  return font === "System" ? "system-ui, -apple-system, Segoe UI, sans-serif" : `"${font}", system-ui, sans-serif`;
}

const HEX = /^#[0-9a-f]{6}$/i;
/** Error red at 6.5:1 on white (WCAG AA for text). */
const DANGER = "#b91c1c";

/**
 * Stripe's Appearance from the checkout theme (Stripe's iframes can't read our CSS variables): the
 * brand color (the text color when the brand color is too pale to read on white, 3:1), text and
 * secondary text (text color 70% + white, like --muted), field borders darkened to 3:1 (like
 * --field-border), the theme's radius, font and size. Pure.
 */
export function stripeAppearance(theme: Pick<Theme, "accentColor" | "textColor" | "borderColor" | "formBackground" | "pageBackground" | "radius" | "font" | "fontScale">): Appearance {
  const text = HEX.test(theme.textColor) ? theme.textColor : "#111827";
  const accent = HEX.test(theme.accentColor) ? theme.accentColor : text;
  const primary = contrastRatio(accent, "#ffffff") >= 3 ? accent : text;
  // Like --muted (text 70% + white), darkened back toward the text color until it reads at 4.5:1.
  let muted = text;
  for (let p = 0.7; p < 1; p += 0.05) {
    const c = mix(text, "#ffffff", p);
    if (contrastRatio(c, "#ffffff") >= 4.5) {
      muted = c;
      break;
    }
  }
  const border = fieldBorderColor({ ...theme, textColor: text });
  return {
    theme: "stripe",
    labels: "above",
    variables: {
      colorPrimary: primary,
      colorBackground: "#ffffff",
      colorText: text,
      colorTextSecondary: muted,
      colorTextPlaceholder: muted,
      colorDanger: DANGER,
      colorIcon: muted,
      fontFamily: fontStack(theme.font),
      fontSizeBase: { sm: "14px", md: "15px", lg: "16px" }[theme.fontScale] ?? "15px",
      borderRadius: `${theme.radius}px`,
      spacingUnit: "4px",
      focusBoxShadow: `0 0 0 2px ${primary}`,
      focusOutline: "none",
    },
    rules: {
      ".Input": { border: `1px solid ${border}`, boxShadow: "none" },
      ".Input:focus": { borderColor: primary },
      ".Input--invalid": { borderColor: DANGER, color: DANGER },
      ".AccordionItem": { border: `1px solid ${border}`, boxShadow: "none" },
      ".Tab": { border: `1px solid ${border}`, boxShadow: "none" },
      ".Tab--selected": { borderColor: primary, boxShadow: `0 0 0 1px ${primary}` },
      ".Label": { color: text, fontWeight: "500" },
      ".Error": { color: DANGER },
    },
  };
}

/** Elements options for a PaymentIntent: client secret, theme appearance, the buyer's language, the theme font. */
export function stripeElementsOptions(clientSecret: string, theme: Theme, origin?: string): StripeElementsOptions {
  const href = fontHref(theme.font);
  return {
    clientSecret,
    appearance: stripeAppearance(theme),
    locale: theme.language,
    ...(href && origin ? { fonts: [{ cssSrc: `${origin}${href}` }] } : {}),
  };
}

export { stripeExpressAny, stripeExpressPaymentMethods, stripePaymentWallets };

/** Stripe error / decline codes grouped under the sentences we translate (Labels.stripeErrors). */
const STRIPE_CODE_GROUPS: Record<string, string> = {
  card_declined: "card_declined",
  generic_decline: "card_declined",
  do_not_honor: "card_declined",
  lost_card: "card_declined",
  stolen_card: "card_declined",
  pickup_card: "card_declined",
  fraudulent: "card_declined",
  insufficient_funds: "insufficient_funds",
  expired_card: "expired_card",
  incorrect_cvc: "incorrect_cvc",
  invalid_cvc: "incorrect_cvc",
  incorrect_number: "incorrect_number",
  invalid_number: "incorrect_number",
  invalid_expiry_month: "invalid_expiry",
  invalid_expiry_year: "invalid_expiry",
  processing_error: "processing_error",
  authentication_required: "authentication_required",
};

/**
 * What the buyer reads for a failed Stripe step, always in the checkout's language: our sentence for
 * the known error / decline codes (Labels.stripeErrors), the redirect sentence for an abandoned 3-D
 * Secure, Stripe's own message for another form problem (validation_error / card_error: Elements
 * already writes it in the buyer's language), our generic sentence otherwise (network, API, an
 * unknown JavaScript error: never a raw English message). Pure.
 */
export function stripeErrorText(
  error: Pick<StripeError, "type" | "message" | "code"> & { decline_code?: string } | null | undefined,
  labels: Pick<Labels, "paymentFailed" | "paymentRedirectFailed"> & Partial<Pick<Labels, "stripeErrors">>,
): string {
  if (!error) return labels.paymentFailed;
  if (error.code === "payment_intent_authentication_failure") return labels.paymentRedirectFailed;
  const group = STRIPE_CODE_GROUPS[error.decline_code ?? ""] ?? STRIPE_CODE_GROUPS[error.code ?? ""];
  const known = group ? labels.stripeErrors?.[group] : undefined;
  if (known) return known;
  if ((error.type === "card_error" || error.type === "validation_error") && error.message) return error.message;
  return labels.paymentFailed;
}

/** Billing details passed at confirmation (the Payment Element doesn't ask them again: our form has them). */
function billingDetails(buyer: BuyerForPayment) {
  const a = buyer.address;
  return {
    name: a.name,
    email: buyer.email,
    ...(a.phone ? { phone: a.phone } : {}),
    address: { line1: a.line1, line2: a.line2 ?? "", city: a.city, state: a.state ?? "", postal_code: a.postalCode, country: a.country },
  };
}

/** A PaymentIntent state the buyer is done with (paid, or being settled by the bank): the thank-you page follows. */
const DONE = new Set(["succeeded", "processing", "requires_capture"]);

type PanelProps = {
  prepared: Prepared;
  preparing: boolean;
  prepareError: string | null;
  theme: Theme;
  labels: Labels;
  payLabel: string;
  /** The thank-you page (absolute): Stripe comes back there after a redirect (3-D Secure, bank page). */
  returnUrl: string;
  testMode: boolean;
  confirm: () => Promise<ConfirmResult>;
  onPaid: () => void;
  beforeButton?: ReactNode;
  incomplete?: string[];
  showIncomplete?: boolean;
  incompleteHint?: string;
  onIncomplete?: () => void;
  onRetry?: () => void;
  interacted?: boolean;
  errorRef?: string | null;
  onLockChange?: (lock: PanelLock) => void;
  inFlightAtLoad?: boolean;
  checkPaid?: () => Promise<PaidCheck>;
  /** An express payment is being confirmed above: no second payment from here meanwhile. */
  externalBusy?: boolean;
  /** Shown from the start (back from a failed Stripe redirect). */
  initialError?: string | null;
  /** The express row above shows Apple Pay / Google Pay: the Payment Element doesn't repeat them. */
  expressWallets?: boolean;
  /** Stripe.js couldn't load in this browser (blocked, failed, timed out): the page reports it (the buyer is switched to Whop). */
  onStripeLoadFailed?: () => void;
};

type FormProps = PanelProps & {
  /** A message kept across the form's remount on a new PaymentIntent (e.g. "total updated"). */
  notice: string | null;
  setNotice: (notice: string | null) => void;
  /** The Payment Element itself couldn't load (its loaderror): the panel shows the failure and Retry. */
  onElementLoadError: () => void;
};

/**
 * The payment section on Stripe: the Payment Element (card, wallets, local methods the merchant's
 * Stripe account offers) and our Pay button. Remounted per PaymentIntent (client secret); a total
 * updated on the same PaymentIntent is fetched in place. Stripe.js is loaded here (only when a
 * Stripe checkout is on screen); should it not load, the page is told (onStripeLoadFailed) and the
 * buyer reads why.
 */
export function StripePanel(props: PanelProps) {
  const { prepared, theme, labels } = props;
  const config = prepared.stripe;
  const [attempt, setAttempt] = useState(0);
  const { stripe, failed: jsFailed } = useStripeJs(config?.publishableKey, config?.stripeAccount, props.onStripeLoadFailed, attempt);
  // Stripe.js loaded but the Payment Element couldn't (its loaderror): the same failure for the
  // buyer (reported, Retry shown), never a spinner that never ends. Per attempt.
  const [elementFailedAt, setElementFailedAt] = useState<number | null>(null);
  const failed = jsFailed || elementFailedAt === attempt;
  // Kept here, outside the remounted form: "total updated" survives the new PaymentIntent's form.
  const [notice, setNotice] = useState<string | null>(null);
  if (!config) return null;
  if (failed) {
    return (
      <div className="space-y-3" data-testid="wc-stripe-panel">
        <div role="alert" data-testid="wc-stripe-load-failed" className="flex min-h-[264px] flex-col items-center justify-center gap-3 rounded-[var(--radius)] border border-neutral-200 bg-white px-6 py-8 text-center">
          <p className="max-w-[340px] text-sm leading-relaxed text-neutral-700">{labels.stripeLoadFailed}</p>
          <button
            type="button"
            onClick={() => setAttempt((a) => a + 1)}
            className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-[var(--btn-radius)] border border-neutral-300 bg-white px-5 text-sm font-semibold text-neutral-900 transition hover:bg-neutral-50"
          >
            <RefreshCw className="h-4 w-4" aria-hidden />
            {labels.retry}
          </button>
        </div>
      </div>
    );
  }
  if (!stripe) {
    return (
      <div className="space-y-3" data-testid="wc-stripe-panel">
        <div className="relative min-h-[264px] rounded-[var(--radius)] border border-neutral-200 bg-white p-3" aria-busy>
          <PaymentSkeleton />
        </div>
      </div>
    );
  }
  return (
    <Elements key={config.clientSecret} stripe={stripe} options={stripeElementsOptions(config.clientSecret, theme, pageOrigin())}>
      <StripeForm
        {...props}
        notice={notice}
        setNotice={setNotice}
        onElementLoadError={() => {
          setElementFailedAt(attempt);
          props.onStripeLoadFailed?.();
        }}
      />
    </Elements>
  );
}

function StripeForm({
  prepared,
  preparing,
  prepareError,
  labels,
  payLabel,
  returnUrl,
  testMode,
  confirm,
  onPaid,
  beforeButton,
  incomplete = [],
  showIncomplete = true,
  incompleteHint,
  onIncomplete,
  onRetry,
  interacted = false,
  errorRef,
  onLockChange,
  inFlightAtLoad = false,
  checkPaid,
  externalBusy = false,
  initialError = null,
  theme,
  expressWallets = false,
  notice,
  setNotice,
  onElementLoadError,
}: FormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [ready, setReady] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [ownError, setOwnError] = useState<string | null>(initialError);
  // The form's own error, else the notice carried over from the previous PaymentIntent's form.
  const error = ownError ?? notice;
  const setError = (e: string | null) => {
    setOwnError(e);
    if (e === null) setNotice(null);
  };
  // Another payment of the session still going through (pay refused it, or the status said so at load):
  // polled until paid or no longer in flight (same bounds as Whop's panel, see serverWaitNext).
  const [serverWait, setServerWait] = useState(inFlightAtLoad ? 1 : 0);
  const [waitOver, setWaitOver] = useState(false);
  // Learnt after mount (the status check, or a prepare refused as in flight): the wait starts then.
  const [sawInFlightAtLoad, setSawInFlightAtLoad] = useState(inFlightAtLoad);
  if (sawInFlightAtLoad !== inFlightAtLoad) {
    setSawInFlightAtLoad(inFlightAtLoad);
    if (inFlightAtLoad) setServerWait((w) => w + 1);
  }
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const onPaidRef = useRef(onPaid);
  const checkPaidRef = useRef(checkPaid);
  useEffect(() => {
    onPaidRef.current = onPaid;
    checkPaidRef.current = checkPaid;
  });
  const paidDone = useRef(false);
  const paid = () => {
    if (paidDone.current) return;
    paidDone.current = true;
    onPaidRef.current();
  };

  // The same PaymentIntent updated to a new total: its form fetches the new amount (wallets show it).
  const amountKey = prepared.amountKey ?? "";
  const firstAmount = useRef(amountKey);
  useEffect(() => {
    if (!elements || amountKey === firstAmount.current) return;
    firstAmount.current = amountKey;
    void elements.fetchUpdates().catch(() => undefined);
  }, [elements, amountKey]);

  const lock: PanelLock = submitting || serverWait > 0 ? "busy" : null;
  useEffect(() => {
    onLockChange?.(lock);
  }, [lock, onLockChange]);
  useEffect(() => () => onLockChange?.(null), [onLockChange]);

  useEffect(() => {
    if (!serverWait) return;
    const startedAt = Date.now();
    let stopped = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const check = checkPaidRef.current;
      const state = check ? await check().catch((): PaidCheck => "unknown") : "unpaid";
      if (stopped) return;
      if (state === "paid") {
        paid();
        return;
      }
      const next = serverWaitNext(state, Date.now() - startedAt);
      if (next == null) {
        setServerWait(0);
        setWaitOver(true);
        return;
      }
      t = setTimeout(() => void tick(), next);
    };
    t = setTimeout(() => void tick(), SERVER_WAIT_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(t);
    };
  }, [serverWait]);

  async function pay() {
    if (!stripe || !elements) return;
    setError(null);
    setWaitOver(false);
    setSubmitting(true);
    try {
      // The Payment Element's own fields first (an incomplete card never starts an attempt server side).
      const checked = await elements.submit();
      if (checked.error) {
        if (alive.current) setError(stripeErrorText(checked.error, labels));
        return;
      }
      const result = await confirm();
      if (!alive.current) return;
      if (!result.ok) {
        if (result.inFlight) {
          setServerWait((w) => w + 1);
          return;
        }
        // Kept by the panel: still shown once the new PaymentIntent's form has replaced this one.
        if (result.refreshedConfigId) {
          setOwnError(null);
          setNotice(labels.totalUpdated);
        } else if (result.error) setError(result.error);
        return;
      }
      const { error: failed, paymentIntent } = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl, payment_method_data: { billing_details: billingDetails(result.buyer) } },
        redirect: "if_required",
      });
      if (!alive.current) return;
      if (failed) {
        // Paid meanwhile (another tab, a double submit): the thank-you page.
        if (failed.code === "payment_intent_unexpected_state" && checkPaidRef.current && (await checkPaidRef.current().catch(() => "unknown")) === "paid") {
          paid();
          return;
        }
        setError(stripeErrorText(failed, labels));
        return;
      }
      if (paymentIntent && DONE.has(paymentIntent.status)) {
        paid();
        return;
      }
      setError(labels.paymentFailed);
    } catch (err) {
      // Never a raw (English, technical) message: a Stripe error by its code, else our sentence.
      if (alive.current) setError(stripeErrorText(err && typeof err === "object" && "code" in err ? (err as StripeError) : null, labels));
    } finally {
      if (alive.current) setSubmitting(false);
    }
  }

  const busy = submitting || serverWait > 0 || preparing || !ready || !stripe || externalBusy;
  const blocked = busy || !!prepareError;
  const loading = !prepareError && !submitting && (preparing || !ready);
  const hint = incomplete.length > 0 && showIncomplete ? (incompleteHint ?? labels.completeFields(incomplete.join(", "))) : null;

  function onPayClick() {
    if (incomplete.length > 0) {
      onIncomplete?.();
      return;
    }
    if (blocked) return;
    void pay();
  }

  const serverWaitText = labels.paymentAlreadyInFlight;
  return (
    <div className="space-y-3" data-testid="wc-stripe-panel">
      <div className="relative min-h-[264px] rounded-[var(--radius)] border border-neutral-200 bg-white p-3" aria-busy={!prepareError && !ready}>
        {prepareError && !ready ? (
          <div role={interacted ? "alert" : "status"} className="flex min-h-[240px] flex-col items-center justify-center gap-3 px-6 py-8 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-neutral-100 text-neutral-600">
              <Clock3 className="h-5 w-5" aria-hidden />
            </span>
            <p className="text-base font-semibold text-neutral-900">{labels.paymentUnavailable}</p>
            <p className="max-w-[340px] text-sm leading-relaxed text-neutral-600">
              {prepareError !== labels.errors.init_failed && prepareError !== labels.error ? prepareError : labels.paymentUnavailableHint}
            </p>
            {errorRef && (
              <p className="font-mono text-[11px] text-neutral-500">
                {labels.reference} {errorRef.slice(0, 8)}
              </p>
            )}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="mt-1 inline-flex min-h-11 items-center gap-2 rounded-[var(--btn-radius)] border border-neutral-300 bg-white px-5 text-sm font-semibold text-neutral-900 transition hover:bg-neutral-50"
              >
                <RefreshCw className="h-4 w-4" aria-hidden />
                {labels.retry}
              </button>
            )}
          </div>
        ) : (
          <>
            {!ready && <PaymentSkeleton />}
            <div className={ready ? undefined : "sr-only"}>
              <PaymentElement
                options={{
                  layout: { type: "accordion", defaultCollapsed: false, radios: "always", spacedAccordionItems: false },
                  // Our form has the buyer's name, e-mail and address: passed at confirmation, never asked twice.
                  fields: { billingDetails: { name: "never", email: "never", address: "never" } },
                  // Apple Pay / Google Pay once only: in the express row when it shows them, else as the merchant chose.
                  wallets: stripePaymentWallets(theme.expressMethods, expressWallets),
                }}
                onReady={() => setReady(true)}
                // The element can't load (Stripe unreachable from here, a PaymentIntent it refuses): the
                // panel reports it (the buyer is switched to Whop when possible) and shows Retry.
                onLoadError={() => onElementLoadError()}
              />
            </div>
          </>
        )}
        {!prepareError && (preparing || !ready) && (
          <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-3">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-r-transparent" />
          </div>
        )}
      </div>

      {(error || (prepareError && ready)) && (
        <div role="alert" data-testid="wc-stripe-error" className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] bg-red-50 px-4 py-3 text-sm text-red-800">
          <span>{error ?? prepareError}</span>
          {prepareError && !error && onRetry && (
            <button type="button" onClick={onRetry} className="min-h-11 rounded-[var(--btn-radius)] border border-red-300 bg-white px-4 font-semibold text-red-800 hover:bg-red-100">
              {labels.retry}
            </button>
          )}
        </div>
      )}

      {beforeButton}

      {serverWait > 0 && (
        <p id="wc-inflight-wait" data-testid="wc-inflight-wait" className="flex items-start gap-2 rounded-[var(--radius)] bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber-300 border-r-transparent motion-reduce:animate-none" aria-hidden />
          {serverWaitText}
        </p>
      )}
      <p aria-live="polite" className="sr-only">
        {serverWait > 0 ? serverWaitText : waitOver ? labels.payNowAvailable : ""}
      </p>

      <button
        id="wc-pay-button"
        type="button"
        aria-disabled={blocked || incomplete.length > 0}
        aria-busy={submitting || loading || undefined}
        aria-describedby={[serverWait > 0 ? "wc-inflight-wait" : null, hint ? "wc-pay-hint" : null].filter(Boolean).join(" ") || undefined}
        onClick={onPayClick}
        className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--btn-radius)] bg-[image:var(--pay-bg,var(--accent-bg))] px-5 py-4 text-base font-semibold text-[var(--pay-fg,var(--accent-fg))] shadow-[var(--pay-shadow,var(--btn-shadow))] transition hover:brightness-110 active:scale-[.99] ${
          blocked && incomplete.length === 0 ? "cursor-progress opacity-70" : ""
        }`}
      >
        {(submitting || loading) && <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
        {submitting ? labels.paymentProcessing : loading ? labels.paymentLoading : payLabel}
      </button>
      {hint && (
        <p id="wc-pay-hint" aria-live="polite" className="text-center text-sm text-neutral-700">
          {hint}
        </p>
      )}
      <p className="flex items-center justify-center gap-1.5 text-xs text-neutral-600">
        <LockIcon /> {labels.paymentSecure}
      </p>
      {testMode && <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">{labels.testMode}</p>}
    </div>
  );
}

/** The buyer an express wallet hands back, in our form's shape (name split in first / last name). Pure. */
export function walletBuyer(event: Pick<StripeExpressCheckoutElementConfirmEvent, "billingDetails" | "shippingAddress">): {
  email: string;
  address: { firstName: string; lastName: string; address1: string; address2: string; city: string; province: string; zip: string; countryCode: string; phone: string };
} | null {
  const from = event.shippingAddress ?? event.billingDetails;
  const email = event.billingDetails?.email ?? "";
  if (!from?.address || !email) return null;
  const parts = (from.name ?? event.billingDetails?.name ?? "").trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? "";
  const lastName = parts.slice(1).join(" ") || firstName;
  const a = from.address;
  return {
    email,
    address: {
      firstName,
      lastName,
      address1: a.line1 ?? "",
      address2: a.line2 ?? "",
      city: a.city ?? "",
      province: a.state ?? "",
      zip: a.postal_code ?? "",
      countryCode: (a.country ?? "").toUpperCase(),
      phone: event.billingDetails?.phone ?? "",
    },
  };
}

export type WalletBuyer = NonNullable<ReturnType<typeof walletBuyer>>;

/**
 * The express row on Stripe (Apple Pay, Google Pay, Link, PayPal as the merchant chose them): the
 * wallet's sheet collects the e-mail and, for goods to ship, the shipping address (restricted to the
 * country the total was computed for: another one would change shipping and taxes). On confirm, our
 * server checks the order first (confirmExpress: totals, terms, payment in flight), then the payment
 * is confirmed with Stripe. Hidden when no wallet is available on the device.
 */
export function StripeExpress({
  prepared,
  theme,
  labels,
  returnUrl,
  confirmExpress,
  onPaid,
  shippable,
  country,
  lock = null,
  onBusy,
  title,
  dividerLabel,
  termsNotice,
  onAvailability,
}: {
  prepared: Prepared;
  theme: Theme;
  labels: Labels;
  returnUrl: string;
  confirmExpress: (buyer: WalletBuyer) => Promise<ConfirmResult>;
  onPaid: () => void;
  /** Something to ship: the sheet asks for the shipping address. */
  shippable: boolean;
  /** The country the current total was computed for. */
  country: string;
  lock?: PanelLock;
  onBusy?: (busy: boolean) => void;
  title?: string;
  dividerLabel?: string;
  termsNotice?: ReactNode;
  /** Whether any wallet showed on this device (null while unknown). */
  onAvailability?: (available: boolean | null) => void;
}) {
  const config = prepared.stripe;
  const { stripe } = useStripeJs(config?.publishableKey, config?.stripeAccount);
  const [available, setAvailable] = useState<boolean | null>(null);
  const onAvailabilityRef = useRef(onAvailability);
  useEffect(() => {
    onAvailabilityRef.current = onAvailability;
  });
  useEffect(() => {
    onAvailabilityRef.current?.(available);
  }, [available]);
  // No wallet on this device (or Stripe.js not loading: the payment section says so): no row at all.
  if (!config || available === false) return null;
  // Until the wallets are known: their place is kept (no jump), the title and "OR" stay invisible.
  const known = available === true;
  return (
    <section aria-label={title || labels.expressCheckout} aria-busy={!known || undefined} data-testid="wc-stripe-express">
      <p data-inline-field="title" aria-hidden={!known || undefined} className={`mb-3 text-center text-xs font-medium tracking-wide text-neutral-600 uppercase ${known ? "" : "invisible"}`}>
        {title || labels.expressCheckout}
      </p>
      {stripe ? (
        <Elements key={config.clientSecret} stripe={stripe} options={stripeElementsOptions(config.clientSecret, theme, pageOrigin())}>
          <ExpressButtons
            prepared={prepared}
            theme={theme}
            labels={labels}
            returnUrl={returnUrl}
            confirmExpress={confirmExpress}
            onPaid={onPaid}
            shippable={shippable}
            country={country}
            lock={lock}
            onBusy={onBusy}
            onAvailable={setAvailable}
          />
        </Elements>
      ) : (
        <div className="min-h-12" aria-hidden />
      )}
      {known && termsNotice}
      <div className={known ? undefined : "invisible"} aria-hidden={!known || undefined}>
        <Divider label={dividerLabel || labels.or} />
      </div>
    </section>
  );
}

function ExpressButtons({
  prepared,
  theme,
  labels,
  returnUrl,
  confirmExpress,
  onPaid,
  shippable,
  country,
  lock,
  onBusy,
  onAvailable,
}: {
  prepared: Prepared;
  theme: Theme;
  labels: Labels;
  returnUrl: string;
  confirmExpress: (buyer: WalletBuyer) => Promise<ConfirmResult>;
  onPaid: () => void;
  shippable: boolean;
  country: string;
  lock: PanelLock;
  onBusy?: (busy: boolean) => void;
  onAvailable: (available: boolean) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [error, setError] = useState<string | null>(null);
  const amountKey = prepared.amountKey ?? "";
  const firstAmount = useRef(amountKey);
  useEffect(() => {
    if (!elements || amountKey === firstAmount.current) return;
    firstAmount.current = amountKey;
    void elements.fetchUpdates().catch(() => undefined);
  }, [elements, amountKey]);

  const sheet = {
    emailRequired: true,
    phoneNumberRequired: false,
    shippingAddressRequired: shippable,
    billingAddressRequired: !shippable,
    // One line « Livraison incluse » at 0: the shipping chosen on the page is already in the total.
    ...(shippable ? { allowedShippingCountries: [country], shippingRates: [{ id: "checkout", amount: 0, displayName: labels.shippingIncluded }] } : {}),
  };
  const options: StripeExpressCheckoutElementOptions = {
    paymentMethods: stripeExpressPaymentMethods(theme.expressMethods),
    buttonHeight: 48,
    layout: { maxColumns: 3, maxRows: 2, overflow: "auto" },
    ...sheet,
  };

  async function onConfirm(event: StripeExpressCheckoutElementConfirmEvent) {
    if (!stripe || !elements) {
      event.paymentFailed({ reason: "fail" });
      return;
    }
    setError(null);
    const buyer = walletBuyer(event);
    if (!buyer) {
      event.paymentFailed({ reason: shippable ? "invalid_shipping_address" : "invalid_billing_address" });
      return;
    }
    onBusy?.(true);
    try {
      const result = await confirmExpress(buyer);
      if (!result.ok) {
        event.paymentFailed({ reason: "fail" });
        setError(result.inFlight ? labels.paymentAlreadyInFlight : result.refreshedConfigId ? labels.totalUpdated : (result.error ?? labels.expressPaymentFailed));
        return;
      }
      const { error: failed, paymentIntent } = await stripe.confirmPayment({ elements, confirmParams: { return_url: returnUrl }, redirect: "if_required" });
      if (failed) {
        setError(stripeErrorText(failed, { paymentFailed: labels.expressPaymentFailed, paymentRedirectFailed: labels.paymentRedirectFailed, stripeErrors: labels.stripeErrors }));
        return;
      }
      if (paymentIntent && DONE.has(paymentIntent.status)) onPaid();
      else setError(labels.expressPaymentFailed);
    } catch {
      event.paymentFailed({ reason: "fail" });
      setError(labels.expressPaymentFailed);
    } finally {
      onBusy?.(false);
    }
  }

  const locked = lock !== null;
  return (
    <>
      <div inert={locked || undefined} className={`min-h-12 transition-opacity ${locked ? "opacity-60" : ""}`}>
        <ExpressCheckoutElement
          options={options}
          onReady={(e) => onAvailable(!!e.availablePaymentMethods && Object.values(e.availablePaymentMethods).some(Boolean))}
          onClick={(e) => {
            // A payment under way below: no second one from a wallet.
            if (locked) return;
            setError(null);
            e.resolve(sheet);
          }}
          onShippingAddressChange={(e) => {
            // The total was computed for this country (shipping, taxes): another one is refused in the sheet.
            if ((e.address.country ?? "").toUpperCase() === country.toUpperCase()) e.resolve();
            else e.reject();
          }}
          onConfirm={(e) => void onConfirm(e)}
        />
      </div>
      {error && (
        <p role="alert" data-testid="wc-express-error" className="mt-2 rounded-[var(--radius)] bg-red-50 px-3 py-2 text-center text-sm text-red-800">
          {error}
        </p>
      )}
    </>
  );
}
