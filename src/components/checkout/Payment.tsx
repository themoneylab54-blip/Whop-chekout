"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Clock3, RefreshCw } from "lucide-react";
import { WhopCheckoutEmbed, WhopExpressCheckoutButton, useCheckoutEmbedControls } from "@whop/checkout/react";
import { EXPRESS_WALLETS, type ExpressWallet, type Theme } from "@/lib/layout";
import { PAYPAL_AFTER_WINDOW_MS, PAYPAL_SERVER_IN_FLIGHT_MS } from "@/lib/paypal-timing";
import type { Labels } from "./i18n";

type ExpressMethod = ExpressWallet;

/** What the page needs to mount Stripe's Payment Element (prepare / pay answer with provider "stripe"). */
export type StripePrepared = { clientSecret: string; paymentIntentId: string; publishableKey: string; stripeAccount: string };

/**
 * The checkout the page pays with: a Whop checkout configuration (`configId`), or a Stripe
 * PaymentIntent (`provider: "stripe"`: `configId` is the PaymentIntent's id; `amountKey` — the
 * PaymentIntent's own amount and currency as the server returned them — changes when the same
 * PaymentIntent was updated to a new total, so its form and wallets fetch the new amount).
 */
export type Prepared = { configId: string; environment: "sandbox" | "production"; provider?: "whop" | "stripe"; stripe?: StripePrepared; amountKey?: string };

/** The Prepared of a prepare / pay answer (Whop's configuration or Stripe's PaymentIntent), or null. Pure. */
export function preparedFromBody(body: unknown): Prepared | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const environment = b.environment === "production" ? "production" : "sandbox";
  const totals = b.totals as { totalCents?: unknown } | undefined;
  if (b.provider === "stripe") {
    const { clientSecret, paymentIntentId, publishableKey, stripeAccount, amount, currency } = b;
    if (typeof clientSecret !== "string" || typeof paymentIntentId !== "string" || typeof publishableKey !== "string" || typeof stripeAccount !== "string") return null;
    // The PaymentIntent's own amount and currency (what the wallets charge), else the page's total.
    const amountKey = typeof amount === "number" && typeof currency === "string" ? `${amount}:${currency.toLowerCase()}` : String(totals?.totalCents ?? "");
    return { provider: "stripe", configId: paymentIntentId, environment, stripe: { clientSecret, paymentIntentId, publishableKey, stripeAccount }, amountKey };
  }
  return typeof b.checkoutConfigurationId === "string" ? { provider: "whop", configId: b.checkoutConfigurationId, environment } : null;
}

/** Whether two Prepared are the same checkout at the same amount (the page keeps its form mounted). Pure. */
export function samePrepared(a: Prepared | null, b: Prepared | null): boolean {
  if (!a || !b) return a === b;
  return a.configId === b.configId && (a.provider ?? "whop") === (b.provider ?? "whop") && (a.amountKey ?? "") === (b.amountKey ?? "");
}

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

/**
 * The express PayPal button (Whop's express buttons have no PayPal): a click validates our
 * form, then pays through a PayPal-only Whop checkout submitted by the payment panel.
 */
export type ExpressPaypal = {
  onClick: () => void;
  /**
   * Whether a click can go through now (default true). Not yet (the page's Whop checkout is still
   * being prepared): the click waits on the button (spinner), then onClick runs once it can.
   */
  ready?: boolean;
  /** Preparing / opening PayPal: the button shows a spinner and ignores clicks. */
  busy: boolean;
  /** "Enter your delivery details…" after a click on an incomplete form. */
  notice?: string | null;
};

/** PayPal-only checkout state handed to the payment panel while PayPal is the chosen method. */
export type PanelPaypal = {
  /** PayPal chosen: the panel shows the PayPal-only checkout and a "Continue with PayPal" button. */
  active: boolean;
  prepared: Prepared | null;
  preparing: boolean;
  /** Shown even once PayPal is dropped (e.g. "PayPal isn't available for this order"). */
  error: string | null;
  /** Submit as soon as the PayPal checkout is ready (the buyer clicked the express button). */
  autoSubmit: boolean;
  onAutoSubmitted: () => void;
  /** Back to the regular payment form. */
  onCancel: () => void;
  /**
   * Whether the session is already paid (a PayPal window may have finished meanwhile), or a payment
   * submitted moments ago may still be completing ("inFlight": not safe to pay another way yet).
   */
  checkPaid?: () => Promise<PaidCheck>;
  /** Prepares the PayPal-only checkout again after a failure (shown when there is none to use). */
  onRetry?: () => void;
  /** The PayPal-only checkout is on screen and ready (a stale "not ready" warning can go). */
  onReady?: () => void;
  /**
   * What the buyer entered (contact, address, terms…): Whop's own PayPal button, shown after a
   * blocked window, only stays for the details confirm() saved (any change hides it again).
   */
  formKey?: string;
  /**
   * A PayPal window opened from Whop's own button (inside the embed, no confirm() of ours): the
   * server is told, so the status route reports that payment in flight like one of ours (a new
   * attempt: paypalWindowAt).
   */
  onWhopWindow?: () => void;
  /**
   * A PayPal window is (still) open: the heartbeat every ~20 s, and a late popup of ours (after a
   * "blocked" verdict). Liveness only (paypalBeatAt): keeps the payment in flight server side
   * without passing for a new attempt (a failure of the current one is never taken as stale).
   */
  onWindowBeat?: () => void;
  /**
   * That window closed (or the buyer said so): the server stops counting its heartbeat past ~10 s
   * from now. Only sent after a beat.
   */
  onWindowClosed?: () => void;
  /**
   * The window of our own PayPal confirm was blocked (it never took the focus): the server is told,
   * so that attempt no longer counts in flight and another method can be paid at once.
   */
  onWindowBlocked?: () => void;
};

/**
 * The session as the status route sees it before leaving a PayPal payment that may have gone
 * through. "unknown": the check itself failed (network, server error): never read as unpaid.
 */
export type PaidCheck = "paid" | "inFlight" | "unpaid" | "unknown";

/**
 * What the payment panel is doing, for the express buttons above: "pending" while a PayPal payment
 * may still go through (its window open or just closed), else "busy" while a payment is being
 * submitted (or its status checked).
 */
export type PanelLock = "busy" | "pending" | null;

/**
 * Whether PayPal stays the method the payment panel pays with: chosen by the buyer and still
 * offered (Whop and the merchant), or chosen and the panel locked (a PayPal payment submitting or
 * possibly still going through). PayPal withdrawn meanwhile only hides its express button: the
 * choice is dropped once the panel unlocks, never under a pending payment. Pure.
 */
export function paypalStaysChosen(t: { mode: boolean; offered: boolean; lock: PanelLock }): boolean {
  return t.mode && (t.offered || t.lock !== null);
}

/** Result of saving the buyer before submitting: either go, or a refreshed checkout to pay instead. */
export type ConfirmResult =
  | { ok: true; buyer: BuyerForPayment }
  /** `inFlight`: the server refused because another payment of this session is still going through (payment_in_flight). */
  | { ok: false; error?: string; refreshedConfigId?: string; inFlight?: boolean };

/** Whether this browser can show Apple Pay at all (Safari's ApplePaySession); false on the server. */
export function canShowApplePay(): boolean {
  if (typeof window === "undefined") return false;
  const session = (window as { ApplePaySession?: { canMakePayments?: () => boolean } }).ApplePaySession;
  if (!session) return false;
  try {
    return session.canMakePayments?.() !== false;
  } catch {
    return false;
  }
}
/**
 * Whether Google Pay's button plausibly shows on this device (Android, or a Chromium browser on a
 * computer): its placeholder is only drawn there. Never on iOS / iPadOS nor in Safari or Firefox,
 * where a Google Pay placeholder would announce a button that almost never comes (the live button
 * still answers by itself and shows if it can). False on the server.
 */
export function googlePayLikely(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1)) return false;
  if (/Android/i.test(ua)) return true;
  return /Chrome\/|Chromium\/|Edg\//.test(ua);
}
const noopSubscribe = () => () => {};

/**
 * How long a new checkout's wallet buttons may take to answer before they replace the current ones
 * anyway (the current ones stay on screen, locked, meanwhile).
 */
export const EXPRESS_SWAP_MAX_MS = 6_000;

/**
 * Apple Pay / Google Pay / Whop Pay in one tap, shown at the top of the checkout.
 * Hides itself entirely when no wallet is available on the device.
 *
 * Drawn before the Whop checkout exists (`prepared` null): our PayPal button works at once (the
 * page waits for the checkout on a click), each wallet has a placeholder of the live button's size,
 * which the live button replaces in place. A new checkout (another total) mounts its buttons hidden
 * while the current ones stay on screen, locked (they charge the old total), until the new ones
 * answered: no reload flash, no jump.
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
  title,
  dividerLabel,
  paypal,
  wallets = true,
  walletMethods = EXPRESS_WALLETS,
  lock = null,
  stale = false,
  unavailable = false,
  onWalletsShown,
}: {
  prepared: Prepared | null;
  /**
   * The first checkout couldn't be prepared (its error and « réessayer » are in the payment section):
   * the row keeps its place with a short inline message, and a PayPal click waiting for that
   * checkout is dropped with that message said aloud (never silently).
   */
  unavailable?: boolean;
  /**
   * The total is being re-priced (a change of rate, add-on, country or quantity not yet prepared):
   * the wallet buttons on screen charge the previous total, so they stay visible but locked until
   * the new checkout arrives. Our PayPal button waits for it too (see ExpressPaypal.ready).
   */
  stale?: boolean;
  theme: Theme;
  labels: Labels;
  returnUrl: string;
  email: string;
  onPaid: () => void;
  /** The PayPal button (null when Whop doesn't offer PayPal on this store). */
  paypal?: ExpressPaypal | null;
  /** Apple Pay / Google Pay / Whop Pay (off when they would skip a required step, e.g. a relay point). */
  wallets?: boolean;
  /**
   * The wallets the merchant chose (see expressMethodsShown). Google Pay is left out for goods to
   * ship by default: Whop's express button collects no shipping address with Google Pay (Apple Pay
   * only). Google Pay stays offered in the payment form below, which ships to the form's address.
   */
  walletMethods?: readonly ExpressMethod[];
  /** Save the payment method for the one-click post-purchase offer. */
  saveCard?: boolean;
  termsNotice?: ReactNode;
  /** Merchant's wording for the heading and the "OR" divider (empty = translated default). */
  title?: string;
  dividerLabel?: string;
  /**
   * The payment panel's lock (see PanelLock): while a payment is being submitted below, or a PayPal
   * payment may still go through, every express button (PayPal and wallets) is out of reach, so
   * none can pay twice. Passed apart from `paypal`: the wallets stay locked even when the PayPal
   * button itself is gone (PayPal no longer offered while its payment is pending).
   */
  lock?: PanelLock;
  /**
   * The wallets whose Whop button actually rendered on this device (none while resolving, and none
   * once unmounted): the Payment title shows only their logos. Must be stable (e.g. a state setter).
   */
  onWalletsShown?: (methods: ExpressMethod[]) => void;
}) {
  // One Whop button per wallet: a single button only ever shows the one wallet Whop ranks first for
  // the device, so Apple Pay, Google Pay and Whop Pay each get their own (each hides itself when the
  // device can't use it). PayPal is not an express method at Whop: our own PayPal button sits in the
  // same grid and pays through a PayPal-only checkout once the form is complete.
  const [rendered, setRendered] = useState<Partial<Record<ExpressMethod, boolean>>>({});
  // A wallet payment Whop reported as failed: said under the row (the sheet itself may just close).
  const [walletError, setWalletError] = useState(false);
  // A PayPal click made before the page could take it (see ExpressPaypal.ready): run once it can, and
  // dropped with the button. Adjusted while rendering; the click itself runs in an effect.
  const [paypalWaiting, setPaypalWaiting] = useState(false);
  const [paypalFire, setPaypalFire] = useState(0);
  // A waiting PayPal click dropped because the checkout couldn't be prepared: said in the row.
  const [paypalDropped, setPaypalDropped] = useState(false);
  if (paypalDropped && !unavailable) setPaypalDropped(false);
  if (paypalWaiting && unavailable) {
    setPaypalWaiting(false);
    setPaypalDropped(true);
  } else if (paypalWaiting && (!paypal || paypal.ready !== false)) {
    setPaypalWaiting(false);
    if (paypal) setPaypalFire((n) => n + 1);
  }
  useEffect(() => {
    if (paypalFire > 0) paypal?.onClick();
    // Once per waiting click (onClick: the page's latest).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paypalFire]);
  // No Apple Pay iframe where Safari's Apple Pay can't exist (one Whop iframe less to boot).
  const applePay = useSyncExternalStore(noopSubscribe, canShowApplePay, () => false);
  const methods = wallets ? EXPRESS_WALLETS.filter((m) => walletMethods.includes(m) && (m !== "apple-pay" || applePay)) : [];
  // The checkout whose buttons are on screen, and a newer one whose buttons are still answering.
  const [current, setCurrent] = useState<Prepared | null>(prepared);
  // The wallets each checkout's buttons answered, per configuration: a late answer of the current
  // (old) checkout's buttons never wipes what the newer one already answered.
  const [answered, setAnswered] = useState<Readonly<Record<string, readonly ExpressMethod[]>>>({});
  const incoming = prepared && current && prepared.configId !== current.configId ? prepared : null;
  // Wallets this device can't use (answered "none") have nothing to wait for.
  const pending = incoming ? methods.filter((m) => rendered[m] !== false && !answered[incoming.configId]?.includes(m)) : [];
  // State following props (React's pattern, adjusted while rendering): the first checkout shows at
  // once; a new one replaces the current one as soon as all its buttons answered.
  if (prepared && (!current || (incoming && pending.length === 0))) setCurrent(prepared);
  const incomingId = incoming?.configId ?? null;
  useEffect(() => {
    if (!incomingId) return;
    // A wallet that never answers doesn't keep the old checkout's buttons forever.
    const t = setTimeout(() => setAnswered((a) => ({ ...a, [incomingId]: EXPRESS_WALLETS.slice() })), EXPRESS_SWAP_MAX_MS);
    return () => clearTimeout(t);
  }, [incomingId]);
  const resolved = methods.every((m) => m in rendered);
  const shown = methods.filter((m) => rendered[m] !== false);
  // Google Pay's placeholder only where its button plausibly shows (Android, Chromium).
  const googlePay = useSyncExternalStore(noopSubscribe, googlePayLikely, () => false);
  const placeholderFor = (m: ExpressMethod) => m !== "google-pay" || googlePay;
  // Until every wallet has answered, one cell stands for them: the first wallet not known to be
  // unavailable whose place is worth drawing (its placeholder, then its button), so the row keeps its
  // height while the others resolve.
  const visible = resolved ? shown : shown.filter((m) => rendered[m] === true || placeholderFor(m)).slice(0, 1);
  // Nothing to draw yet (only wallets unlikely here, still answering, no PayPal): the row stays off
  // screen (mounted, so they can answer) rather than an empty heading.
  const nothingYet = !resolved && visible.length === 0 && !paypal;
  // The buttons on screen charge a previous total: a newer checkout is answering, or being prepared.
  const oldTotal = !!incoming || stale;
  // Reported: only the wallets whose button is on screen (rendered and in a visible cell) — never
  // one still resolving off screen (sr-only), whose logo would announce a button buyers can't see.
  const shownKey = current ? visible.filter((m) => rendered[m] === true).join(",") : "";
  useEffect(() => {
    onWalletsShown?.(shownKey ? (shownKey.split(",") as ExpressMethod[]) : []);
    return () => onWalletsShown?.([]);
  }, [shownKey, onWalletsShown]);
  // Wallets still resolving next to PayPal, with room for 3+ buttons: two rows kept on a phone from
  // the start, so the page doesn't jump down when the other wallets appear.
  const reserveTwoRows = !resolved && !!paypal && shown.length + 1 >= 3;
  if (unavailable) {
    // Nothing was drawn up there (no PayPal, no wallet placeholder): nothing to keep either.
    if (visible.length === 0 && !paypal) return null;
    return <ExpressUnavailable labels={labels} title={title} dividerLabel={dividerLabel} alert={paypalDropped} tall={reserveTwoRows} />;
  }
  if (resolved && shown.length === 0 && !paypal) return null;
  const cols = visible.length + (paypal ? 1 : 0);
  // Two per row even on a phone (like Shopify); an odd last button takes the whole row there.
  const lastCell = paypal ? "paypal" : visible[visible.length - 1];
  const spanLast = cols === 3 ? "col-span-2 sm:col-span-1" : "";
  const locked = lock !== null;
  // The checkouts with buttons mounted: the one on screen, and the newer one answering off screen.
  const layers = [current, incoming].filter((p): p is Prepared => !!p);
  const button = (p: Prepared, method: ExpressMethod) => (
    <WhopExpressCheckoutButton
      key={`${p.configId}-${method}`}
      checkoutConfigurationId={p.configId}
      environment={p.environment}
      methods={[method]}
      returnUrl={returnUrl}
      theme="light"
      locale={theme.language}
      collectShipping
      setupFutureUsage={saveCard ? "off_session" : undefined}
      prefill={email ? { email } : undefined}
      onExpressMethodResolved={({ rendered: r }) => {
        setRendered((prev) => (prev[method] === (r !== "none") ? prev : { ...prev, [method]: r !== "none" }));
        setAnswered((a) => (a[p.configId]?.includes(method) ? a : { ...a, [p.configId]: [...(a[p.configId] ?? []), method] }));
      }}
      onComplete={() => {
        setWalletError(false);
        onPaid();
      }}
      onPaymentError={() => setWalletError(true)}
      fallback={placeholderFor(method) ? <WalletPlaceholder method={method} /> : null}
    />
  );
  return (
    <section
      aria-label={title || labels.expressCheckout}
      data-testid="wc-express"
      aria-busy={!current || oldTotal || undefined}
      inert={nothingYet || undefined}
      aria-hidden={nothingYet || undefined}
      className={nothingYet ? "sr-only" : undefined}
    >
      <p data-inline-field="title" className="mb-3 text-center text-xs font-medium tracking-wide text-neutral-600 uppercase">
        {title || labels.expressCheckout}
      </p>
      <div
        // A payment in progress below: no second one from here (no Apple Pay under an open PayPal window).
        // Inert takes the buttons out of reach of the pointer, the keyboard and screen readers alike;
        // the line under the grid says why (a pending PayPal payment) and how to change.
        inert={locked || undefined}
        className={`grid gap-2 transition-opacity ${reserveTwoRows ? "min-h-[104px] content-start sm:min-h-12" : "min-h-12"} ${cols >= 2 ? "grid-cols-2" : ""} ${
          cols === 3 ? "sm:grid-cols-3" : cols === 4 ? "sm:grid-cols-4" : ""
        } ${locked ? "opacity-60" : ""}`}
      >
        {methods.map((method) => (
          <div
            key={method}
            data-express-method={method}
            // Still resolving off screen: mounted (so it can answer) but out of reach of focus and screen readers.
            inert={rendered[method] !== false && !visible.includes(method) ? true : undefined}
            aria-hidden={rendered[method] !== false && !visible.includes(method) ? true : undefined}
            className={rendered[method] === false ? "hidden" : !visible.includes(method) ? "sr-only" : lastCell === method ? spanLast || undefined : undefined}
          >
            {layers.length === 0 ? (
              placeholderFor(method) && <WalletPlaceholder method={method} />
            ) : (
              layers.map((p) =>
                p === current ? (
                  // The current checkout's button; locked while a newer total is prepared or its buttons
                  // load (it charges the old one).
                  <div key={p.configId} inert={oldTotal ? true : undefined} className={oldTotal ? "opacity-60 transition-opacity" : undefined}>
                    {button(p, method)}
                  </div>
                ) : (
                  // The newer checkout's button, answering off screen (a wallet this device can't use isn't asked again).
                  rendered[method] !== false && (
                    <div key={p.configId} className="sr-only" inert aria-hidden>
                      {button(p, method)}
                    </div>
                  )
                ),
              )
            )}
          </div>
        ))}
        {paypal && (
          <div className={spanLast || undefined}>
            <PaypalButton
              label={labels.payWithPaypal}
              busy={paypal.busy || paypalWaiting}
              onClick={() => {
                setWalletError(false);
                if (paypal.ready === false) setPaypalWaiting(true);
                else paypal.onClick();
              }}
            />
          </div>
        )}
      </div>
      {/* Always mounted (polite live region): the sentence is announced once when the lock appears. */}
      <p aria-live="polite" data-testid="wc-express-locked" className={lock === "pending" ? "mt-2 text-center text-sm text-neutral-700" : "sr-only"}>
        {lock === "pending" ? labels.paypalExpressLocked : ""}
      </p>
      {walletError && (
        <p role="alert" data-testid="wc-express-error" className="mt-2 rounded-[var(--radius)] bg-red-50 px-3 py-2 text-center text-sm text-red-800">
          {labels.expressPaymentFailed}
        </p>
      )}
      {paypal?.notice && (
        <p role="alert" className="mt-2 rounded-[var(--radius)] bg-amber-50 px-3 py-2 text-center text-sm text-amber-900">
          {paypal.notice}
        </p>
      )}
      {termsNotice}
      <Divider label={dividerLabel || labels.or} />
    </section>
  );
}

/**
 * A wallet's place while its live button loads: the button's own size and look (Apple Pay / Google
 * Pay black buttons as in the builder preview, dimmed), never clickable nor announced.
 */
export function WalletPlaceholder({ method }: { method: ExpressMethod }) {
  // Tapped before the live button arrived: a spinner says it is on its way (nothing else happens).
  const [tapped, setTapped] = useState(false);
  const tap = () => setTapped(true);
  const spinner = <span data-testid="wc-wallet-placeholder-loading" className="h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none" />;
  if (method === "whop-pay") {
    return (
      <div
        data-testid="wc-wallet-placeholder"
        aria-hidden
        onPointerDown={tap}
        className="flex h-12 items-center justify-center rounded-[var(--radius)] bg-neutral-100 text-neutral-500 motion-safe:animate-pulse"
      >
        {tapped && spinner}
      </div>
    );
  }
  return (
    <div
      data-testid="wc-wallet-placeholder"
      aria-hidden
      onPointerDown={tap}
      className={`flex h-12 items-center justify-center gap-1 rounded-[var(--radius)] bg-black text-[15px] font-semibold text-white opacity-70 ${tapped ? "cursor-progress" : "motion-safe:animate-pulse"}`}
    >
      {tapped ? (
        spinner
      ) : (
        <>
          {method === "apple-pay" ? <AppleLogo /> : <GoogleG />} Pay
        </>
      )}
    </div>
  );
}

/**
 * Stripe's express row before its PaymentIntent exists (and while its code loads): the place of
 * StripeExpress before its wallets are known (title and "OR" invisible, one button's height).
 */
export function StripeExpressPlaceholder({ labels, title, dividerLabel }: { labels?: Labels; title?: string; dividerLabel?: string }) {
  return (
    <section aria-hidden aria-busy data-testid="wc-stripe-express-placeholder">
      <p className="invisible mb-3 text-center text-xs font-medium tracking-wide uppercase">{title || labels?.expressCheckout || " "}</p>
      <div className="min-h-12" />
      <div className="invisible">
        <Divider label={dividerLabel || labels?.or || " "} />
      </div>
    </section>
  );
}

/**
 * The express row when the first checkout couldn't be prepared (its error and « réessayer » are in
 * the payment section): its place kept (one button's height, two rows on a phone when that was
 * reserved) with a short message instead of the buttons, so nothing jumps. `alert`: a click was
 * waiting for that checkout (PayPal): the message is announced.
 */
export function ExpressUnavailable({ labels, title, dividerLabel, alert = false, tall = false }: { labels: Labels; title?: string; dividerLabel?: string; alert?: boolean; tall?: boolean }) {
  return (
    <section aria-label={title || labels.expressCheckout} data-testid="wc-express-unavailable">
      <p data-inline-field="title" className="mb-3 text-center text-xs font-medium tracking-wide text-neutral-600 uppercase">
        {title || labels.expressCheckout}
      </p>
      <div
        className={`flex items-center justify-center rounded-[var(--radius)] border border-dashed px-3 text-center text-sm ${tall ? "min-h-[104px] sm:min-h-12" : "min-h-12"} ${
          alert ? "border-red-200 bg-red-50 text-red-800" : "border-neutral-300 text-neutral-700"
        }`}
      >
        <p role={alert ? "alert" : undefined}>{labels.paymentUnavailable}</p>
      </div>
      <Divider label={dividerLabel || labels.or} />
    </section>
  );
}

/** PayPal's own button look: yellow, wordmark, same size as the wallet buttons. */
export function PaypalButton({ label, busy = false, onClick, preview = false }: { label: string; busy?: boolean; onClick?: () => void; preview?: boolean }) {
  const look =
    "flex h-12 w-full items-center justify-center rounded-[var(--radius)] bg-[#FFC439] text-[#111] transition hover:brightness-95";
  if (preview) {
    return (
      <div className={look} aria-label={label} role="img">
        <PaypalWordmark />
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={label}
      aria-disabled={busy || undefined}
      aria-busy={busy || undefined}
      data-testid="wc-paypal-express"
      onClick={() => {
        if (!busy) onClick?.();
      }}
      className={`${look} focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#003087] active:scale-[.99] ${busy ? "cursor-progress opacity-80" : ""}`}
    >
      {busy ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-[#003087] border-r-transparent" aria-hidden /> : <PaypalWordmark />}
    </button>
  );
}

/** The PayPal wordmark ("Pay" navy, "Pal" blue), inline: no external image. */
export function PaypalWordmark({ className = "h-[22px] w-auto" }: { className?: string }) {
  return (
    <svg viewBox="0 0 101 32" className={className} aria-hidden focusable="false">
      <path fill="#003087" d="M6.4 3.4c-.6 0-1 .4-1.1 1L1.6 27.5c-.1.5.3.9.8.9h4.4c.6 0 1-.4 1.1-1l1-6.3c.1-.6.6-1 1.1-1h2.9c6 0 9.5-2.9 10.4-8.7.4-2.5 0-4.5-1.2-5.9-1.3-1.5-3.6-2.3-6.7-2.3H6.4Z" />
      <path fill="#009cde" d="M22.4 10.2c-.9 5.8-4.4 8.7-10.4 8.7h-1.3c-.6 0-1 .4-1.1 1l-1.5 9.5c-.1.4.2.7.6.7h3.9c.5 0 .9-.4 1-.9l.8-5.3c.1-.5.5-.9 1-.9h1.4c5.3 0 8.3-2.6 9.1-7.7.3-2.1-.1-3.8-1.1-5-.4-.4-.9-.8-1.4-1.1l-.1-.1c.1.4.1.7 0 1.1Z" opacity=".9" />
      <text x="30" y="23" fontFamily="Verdana, 'DejaVu Sans', Arial, sans-serif" fontSize="19" fontStyle="italic" fontWeight="700" letterSpacing="-0.6">
        <tspan fill="#003087">Pay</tspan>
        <tspan fill="#009cde">Pal</tspan>
      </text>
    </svg>
  );
}

export function Divider({ label }: { label: string }) {
  return (
    <div className="mt-6 flex items-center gap-3 text-xs text-neutral-600">
      <span className="h-px flex-1 bg-neutral-200" />
      <span data-inline-field="dividerLabel">{label}</span>
      <span className="h-px flex-1 bg-neutral-200" />
    </div>
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
  incomplete = [],
  showIncomplete = true,
  incompleteHint,
  onIncomplete,
  onRetry,
  interacted = false,
  errorRef,
  paypal,
  onLockChange,
  inFlightAtLoad = false,
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
  /** Labels of the fields still missing or invalid: listed under the button. */
  incomplete?: string[];
  /** List them only once the buyer has left a field or tried to pay (never on a fresh page). */
  showIncomplete?: boolean;
  /** Replaces "Complete: …" when one clearer sentence says it ("Choose your pickup point"). */
  incompleteHint?: string;
  /** Shows every field error and focuses the first invalid field. */
  onIncomplete?: () => void;
  /** Prepares the Whop checkout again after a failure, without reloading the page. */
  onRetry?: () => void;
  /** The buyer has typed or clicked on the page: failures may interrupt them (role=alert). */
  interacted?: boolean;
  /** Support reference (request id) of the failed load, shown discreetly. */
  errorRef?: string | null;
  /** PayPal chosen from the express button: the PayPal-only checkout replaces the regular one. */
  paypal?: PanelPaypal;
  /** Reports the panel's lock (see PanelLock) so the express buttons can't start a second payment. */
  onLockChange?: (lock: PanelLock) => void;
  /**
   * The status route said, as the page loaded, that a payment of this session is still going
   * through (another tab, a reload during a PayPal window): the panel starts in its server wait.
   */
  inFlightAtLoad?: boolean;
}) {
  const controls = useCheckoutEmbedControls();
  const paypalOn = !!paypal?.active;
  // The checkout on screen: the PayPal-only one while PayPal is chosen, else the regular one.
  const current = paypalOn ? paypal.prepared : prepared;
  const currentPreparing = paypalOn ? paypal.preparing : preparing;
  // Ready = the embed on screen said so (switching checkouts remounts it: not ready until it says so).
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const ready = !!current && readyFor === current.configId;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBillingForm, setShowBillingForm] = useState(false);
  // The PayPal window was opened by code (no click of the buyer's): a browser may block it.
  const [paypalTried, setPaypalTried] = useState(false);
  // A PayPal payment was submitted and may still go through (its window may be open or just closed):
  // leaving PayPal or submitting it again first checks the session isn't paid already.
  const [paypalPending, setPaypalPending] = useState(false);
  // Bumped at every PayPal submit (ours or Whop's own button), pending before or not: the
  // background checks start over (fresh bounds) even when the flag above doesn't change.
  const [pendingEpoch, setPendingEpoch] = useState(0);
  // The same count, readable from async code (a submit during "Pay another way"'s checks).
  const epochRef = useRef(0);
  const bumpEpoch = () => {
    epochRef.current += 1;
    setPendingEpoch(epochRef.current);
  };
  const [checkingPaid, setCheckingPaid] = useState(false);
  // Leaving a pending PayPal payment first asks whether its window is closed (the focus heuristic
  // can't tell a closed window from one behind this tab): the action waiting for that answer.
  const [confirmLeave, setConfirmLeave] = useState<(() => void) | null>(null);
  // The status route still sees a payment going through after a few checks: wait, don't switch.
  const [paypalWait, setPaypalWait] = useState(false);
  // Stops waiting for the PayPal window when the panel goes away.
  const settleAbort = useRef<AbortController | null>(null);
  // When the PayPal window last closed (it really opened): status checks go on for a while after
  // it before another method is allowed (the payment may complete just after the window).
  const windowClosedAt = useRef<number | null>(null);
  // A blocked PayPal window after a successful confirm(): Whop's own button (a click inside the
  // embed opens PayPal itself), for this checkout and these details only (see PanelPaypal.formKey).
  const [whopButtonKey, setWhopButtonKey] = useState<string | null>(null);
  const lastBuyer = useRef<BuyerForPayment | null>(null);
  // Latest callbacks for the background checks (their identity changes every render).
  const checkPaidRef = useRef(paypal?.checkPaid);
  const onPaidRef = useRef(onPaid);
  const onWhopWindowRef = useRef(paypal?.onWhopWindow);
  const onWindowBlockedRef = useRef(paypal?.onWindowBlocked);
  const onWindowBeatRef = useRef(paypal?.onWindowBeat);
  const onWindowClosedRef = useRef(paypal?.onWindowClosed);
  useEffect(() => {
    checkPaidRef.current = paypal?.checkPaid;
    onPaidRef.current = onPaid;
    onWhopWindowRef.current = paypal?.onWhopWindow;
    onWindowBlockedRef.current = paypal?.onWindowBlocked;
    onWindowBeatRef.current = paypal?.onWindowBeat;
    onWindowClosedRef.current = paypal?.onWindowClosed;
  });
  // A beat went to the server since the last "closed": the next close (or the buyer's "it's closed")
  // tells it, so the lock ends ~10 s after the window instead of ~30 s after the last beat.
  const beatSent = useRef(false);
  const beat = () => {
    beatSent.current = true;
    onWindowBeatRef.current?.();
  };
  const windowClosed = () => {
    if (!beatSent.current) return;
    beatSent.current = false;
    onWindowClosedRef.current?.();
  };
  // The thank-you page once, whichever path sees the payment first (embed, background poll, a check).
  const paidDone = useRef(false);
  const paid = () => {
    if (paidDone.current) return;
    paidDone.current = true;
    onPaidRef.current();
  };
  // The last status check before leaving or retrying PayPal failed: the wait says so.
  const [checkFailed, setCheckFailed] = useState(false);
  // When the last PayPal payment was submitted (see paypalRetryStep).
  const lastSubmitAt = useRef<number | null>(null);
  // The server sees another payment of this session still going through (pay refused it with
  // payment_in_flight, or the status route said so as the page loaded): nothing is submitted, the
  // status is polled until paid (thank-you page) or no longer in flight (bounded, see
  // serverWaitNext). Bumped per wait so each one polls with its own bounds; 0 = none.
  const [serverWait, setServerWait] = useState(inFlightAtLoad ? 1 : 0);
  // That wait ended without a payment: Pay is usable again, and screen readers are told so (the
  // wait's own line only disappears). Cleared by the next submit or wait.
  const [waitOver, setWaitOver] = useState(false);
  // When this panel's card payment was last declined (the embed's onPaymentError): a server wait
  // right after it (its own attempt still counted in flight until the failure webhook lands) says so.
  const cardDeclinedAt = useRef<number | null>(null);
  const [waitAfterDecline, setWaitAfterDecline] = useState(false);
  const [sawInFlightAtLoad, setSawInFlightAtLoad] = useState(inFlightAtLoad);
  if (sawInFlightAtLoad !== inFlightAtLoad) {
    setSawInFlightAtLoad(inFlightAtLoad);
    if (inFlightAtLoad) {
      setWaitAfterDecline(false);
      setServerWait((w) => w + 1);
    }
  }
  // The embed's box: only a focus inside it arms the watch for Whop's own PayPal button.
  const embedBox = useRef<HTMLDivElement | null>(null);
  // The leave confirmation takes the focus on its first button when it opens.
  const confirmYes = useRef<HTMLButtonElement | null>(null);
  // ...and gives it back to "Pay another way" once answered.
  const payOther = useRef<HTMLButtonElement | null>(null);
  // "Pay another way" went through: once that button is gone, the focus lands on the Pay button.
  const payButtonRef = useRef<HTMLButtonElement | null>(null);
  const focusPayAfterSwitch = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      settleAbort.current?.abort();
    };
  }, []);

  const lock: PanelLock = paypalPending ? "pending" : submitting || checkingPaid || serverWait > 0 ? "busy" : null;
  useEffect(() => {
    onLockChange?.(lock);
  }, [lock, onLockChange]);
  useEffect(() => () => onLockChange?.(null), [onLockChange]);

  const paypalReady = paypalOn && ready;
  useEffect(() => {
    if (paypalReady) paypal?.onReady?.();
    // Once per transition to ready (the callback's identity changes every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paypalReady]);

  // PayPal no longer chosen (dropped, refused, back to the card): nothing of it stays pending
  // (adjusted while rendering, React's pattern for state following a prop).
  const [wasPaypalOn, setWasPaypalOn] = useState(paypalOn);
  if (wasPaypalOn !== paypalOn) {
    setWasPaypalOn(paypalOn);
    if (!paypalOn) {
      setPaypalPending(false);
      setPaypalWait(false);
      setConfirmLeave(null);
      setCheckFailed(false);
      setWhopButtonKey(null);
      setPaypalTried(false);
    }
  }
  // ...nor its timings (refs: reset once that render commits, never during it): a PayPal chosen
  // again later starts from a clean slate, no retry or leave waiting on the dropped payment.
  useEffect(() => {
    if (paypalOn) return;
    lastSubmitAt.current = null;
    windowClosedAt.current = null;
    // Nor a late-popup watch of a blocked window (see pay()): the card never turns pending.
    settleAbort.current?.abort();
  }, [paypalOn]);

  // A PayPal payment possibly going through: its outcome is checked in the background, so a
  // payment completed in the PayPal window reaches the thank-you page without any click here.
  // Bounded (see pendingPollNext): slower while the tab is hidden, over once the window closed
  // long ago and the session is still unpaid (the buyer's next click checks again anyway).
  // Restarted per submit (pendingEpoch): its start time and stop are that submit's own.
  useEffect(() => {
    if (!paypalOn || !paypalPending) return;
    const startedAt = Date.now();
    let stopped = false;
    let t: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      clearTimeout(t);
      t = setTimeout(() => {
        t = undefined;
        void tick();
      }, ms);
    };
    const tick = async () => {
      const state = (await checkPaidRef.current?.().catch((): PaidCheck => "unknown")) ?? "unknown";
      if (stopped) return;
      if (state === "paid") {
        paid();
        return;
      }
      const next = pendingPollNext(state, { now: Date.now(), startedAt, windowClosedAt: windowClosedAt.current, hidden: document.visibilityState === "hidden" });
      if (next == null) stopped = true;
      else schedule(next);
    };
    // Back on the tab (e.g. from the PayPal window): check now rather than after the hidden pace.
    const onVisible = () => {
      if (!stopped && t !== undefined && document.visibilityState === "visible") schedule(0);
    };
    document.addEventListener("visibilitychange", onVisible);
    schedule(PENDING_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [paypalOn, paypalPending, pendingEpoch]);

  // Heartbeat: once the PayPal window really opened (this page lost the focus at least once), the
  // server's beat time is refreshed every ~20 s (onWindowBeat: paypalBeatAt, liveness only, never
  // taken for a new attempt), so a long PayPal login keeps other tabs from paying another way past
  // the 30 s in-flight window. Only until that window closed (windowClosedAt set: its close already
  // told the server, the lock ends ~10 s later). Bounded (PAYPAL_WINDOW_MAX_MS), per submit, over
  // with the pending state.
  useEffect(() => {
    if (!paypalOn || !paypalPending) return;
    const startedAt = Date.now();
    const away = () => document.visibilityState !== "visible" || !document.hasFocus();
    let lost = away();
    const onAway = () => {
      if (away()) lost = true;
    };
    window.addEventListener("blur", onAway);
    document.addEventListener("visibilitychange", onAway);
    const timer = setInterval(() => {
      if (Date.now() - startedAt >= PAYPAL_WINDOW_MAX_MS) {
        clearInterval(timer);
        return;
      }
      onAway();
      if (lost && windowClosedAt.current == null) beat();
    }, PAYPAL_HEARTBEAT_MS);
    return () => {
      clearInterval(timer);
      window.removeEventListener("blur", onAway);
      document.removeEventListener("visibilitychange", onAway);
    };
  }, [paypalOn, paypalPending, pendingEpoch]);

  // The server wait (see serverWait): polled until paid, no longer in flight, or out of bounds.
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

  // Whop's own PayPal button (after a blocked window): only for the checkout and details confirmed.
  const whopButtonFor = paypalOn && current ? `${current.configId}|${paypal.formKey ?? ""}` : null;
  const whopButton = !!whopButtonFor && whopButtonKey === whopButtonFor;
  // Showing it reloads the embed: the saved contact and address go back in once it's ready.
  useEffect(() => {
    const buyer = lastBuyer.current;
    const c = controls.current;
    if (!whopButton || !ready || !buyer || !c) return;
    void c.setEmail(buyer.email).catch(() => undefined);
    if (!showBillingForm) void c.setAddress(buyer.address).catch(() => undefined);
    // Once per (re)load of the embed with the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whopButton, ready]);
  // A click on Whop's button opens PayPal from inside the embed: once its window takes the focus
  // (after an interaction inside the embed, never a mere tab switch), the payment is pending
  // exactly like one opened by "Continue with PayPal". Watched again while pending: a second click
  // there (once back from the first window) is a new submit, with its own timings and checks.
  useEffect(() => {
    if (!whopButton) return;
    const ctrl = new AbortController();
    void (async () => {
      while (!ctrl.signal.aborted) {
        const opened = await paypalWindowOpened(ctrl.signal, () => embedBox.current);
        if (!opened || !alive.current || ctrl.signal.aborted) return;
        windowClosedAt.current = null;
        lastSubmitAt.current = Date.now();
        setPaypalPending(true);
        bumpEpoch();
        setConfirmLeave(null);
        setPaypalWait(false);
        setCheckFailed(false);
        // No confirm() of ours went with it: the server marks the session PAYING again (fresh
        // window time, paypalWindowAt), so the status route reports this payment in flight like one of ours.
        onWhopWindowRef.current?.();
        settleAbort.current?.abort();
        const settle = new AbortController();
        settleAbort.current = settle;
        // Back on this page (window closed or put behind) before the next click can be watched.
        await paypalWindowSettled(settle.signal);
        if (!alive.current || settle.signal.aborted) continue;
        windowClosedAt.current = Date.now();
        windowClosed();
        // The focus came back to the embed's iframe (the button clicked there): a second click on it
        // would blur nothing, so it could never be seen. Moved to the embed's box (no scroll), the
        // next click moves it into the iframe again, and that blur arms the watch.
        const box = embedBox.current;
        const active = document.activeElement;
        if (box && active && active !== box && box.contains(active)) box.focus({ preventScroll: true });
      }
    })();
    return () => ctrl.abort();
  }, [whopButton]);

  /**
   * "Pay another way": runs `then` unless the pending PayPal payment turns out to be paid (then:
   * thank-you page) or may still be going through. Pending only when the PayPal window really took
   * the focus (a blocked one leaves nothing pending: `then` runs at once). It first needs the buyer's word that the PayPal
   * window is closed (`confirmed`), then the status route's: checks go on (see paypalLeaveStep)
   * for at least 2.5 s, ~10 s after the PayPal window closed, and while a payment submitted
   * moments ago is still in flight; still in flight after that means wait.
   */
  async function afterPaypalCheck(then: () => void, confirmed = false) {
    if (!paypalPending || !paypal?.checkPaid) {
      setPaypalPending(false);
      setPaypalWait(false);
      setCheckFailed(false);
      focusPayAfterSwitch.current = true;
      then();
      return;
    }
    if (!confirmed) {
      setConfirmLeave(() => then);
      return;
    }
    setConfirmLeave(null);
    setPaypalWait(false);
    setCheckingPaid(true);
    const askedAt = Date.now();
    // The submit these checks are about: another one meanwhile (Whop's own button clicked again
    // during the checks) is a new payment their answers say nothing about.
    const epochAtStart = epochRef.current;
    let step: PaypalLeaveStep;
    let state: PaidCheck;
    for (;;) {
      if (!alive.current) return;
      // A failed check is no answer ("unknown"): never read as unpaid (see paypalLeaveStep).
      state = await paypal.checkPaid().catch((): PaidCheck => "unknown");
      if (!alive.current) return;
      step = paypalLeaveStep(state, { now: Date.now(), askedAt, windowClosedAt: windowClosedAt.current, lastSubmitAt: lastSubmitAt.current });
      if (step.next !== "poll") break;
      await new Promise((r) => setTimeout(r, step.next === "poll" ? step.inMs : 0));
    }
    setCheckingPaid(false);
    if (step.next === "paid") {
      paid();
      return;
    }
    // A new PayPal submit since the checks began: never a switch under it, wait instead.
    const superseded = step.next === "switch" && epochRef.current !== epochAtStart;
    if (step.next === "wait" || superseded) {
      // Still pending: nothing else starts (the buttons stay locked); the buyer can ask again later
      // (and is told when the checks themselves failed).
      setCheckFailed(!superseded && state === "unknown");
      setPaypalWait(true);
      return;
    }
    setCheckFailed(false);
    setPaypalPending(false);
    focusPayAfterSwitch.current = true;
    then();
  }

  async function pay() {
    // The checkout and details this payment goes with (Whop's own button is offered for them only).
    const keyAtPay = whopButtonFor;
    // A failure below clears the pending state only when this very call set it on a panel that had
    // nothing pending: an earlier payment possibly still going through stays pending (and locked).
    const wasPending = paypalPending;
    let setPending = false;
    // That earlier payment's timings, put back if this submit fails: reset, they would leave its
    // window "never closed" and its submit "just now", and every later retry or switch would wait.
    const prevClosed = windowClosedAt.current;
    const prevSubmitAt = lastSubmitAt.current;
    // "Continue with PayPal" again while the last PayPal payment may still go through: its status
    // is checked alongside confirm() (no extra round-trip before the submit: popup activation).
    const retryCheck = paypalOn && paypalPending && paypal?.checkPaid ? paypal.checkPaid().catch((): PaidCheck => "unknown") : null;
    setError(null);
    setWaitOver(false);
    setSubmitting(true);
    try {
      // The server is the gate for a PayPal retry: confirm refuses a session already paid (the
      // earlier PayPal window went through), then one quick status check sends the buyer to the
      // thank-you page.
      const [result, retryState] = await Promise.all([confirm(), retryCheck]);
      if (!alive.current) return;
      if (retryState) {
        const next = paypalRetryStep(retryState, { now: Date.now(), lastSubmitAt: lastSubmitAt.current, windowClosedAt: windowClosedAt.current });
        if (next === "paid") {
          paid();
          return;
        }
        if (next === "wait") {
          // Maybe still going through: no second PayPal window; the buyer can try again shortly.
          setSubmitting(false);
          setConfirmLeave(null);
          setCheckFailed(retryState === "unknown");
          setPaypalWait(true);
          return;
        }
      }
      if (!result.ok) {
        if (paypalOn && paypal?.checkPaid && (await paypal.checkPaid().catch((): PaidCheck => "unpaid")) === "paid") {
          if (alive.current) paid();
          return;
        }
        setSubmitting(false);
        // Another payment still going through (e.g. PayPal in another tab): wait for it, no error.
        if (result.inFlight) {
          setWaitAfterDecline(cardDeclinedAt.current != null && Date.now() - cardDeclinedAt.current < CARD_DECLINED_RECENT_MS);
          setServerWait((w) => w + 1);
          return;
        }
        if (result.refreshedConfigId) setError(labels.totalUpdated);
        else if (result.error) setError(result.error);
        return;
      }
      // A new attempt: the declined card is no longer the last one.
      cardDeclinedAt.current = null;
      const c = controls.current;
      if (!c) throw new Error(labels.paymentNotReady);
      await c.setEmail(result.buyer.email).catch(() => undefined);
      if (!showBillingForm) await c.setAddress(result.buyer.address).catch(() => undefined);
      lastBuyer.current = result.buyer;
      let settled: Promise<boolean> | null = null;
      let submitted = () => {};
      // This submit's epoch: another one meanwhile (Whop's own button opening PayPal while this
      // window is watched) owns the pending state from then on (see below).
      let myEpoch = -1;
      if (paypalOn) {
        setPaypalPending(true);
        setPending = true;
        bumpEpoch();
        myEpoch = epochRef.current;
        setConfirmLeave(null);
        setPaypalWait(false);
        setCheckFailed(false);
        windowClosedAt.current = null;
        lastSubmitAt.current = Date.now();
        // Watched from before the submit (the window may take the focus while submit() runs), but
        // the "blocked" grace only counts once submit() is done (a slow submit is no blocked window).
        settleAbort.current?.abort();
        const settle = new AbortController();
        settleAbort.current = settle;
        settled = paypalWindowSettled(settle.signal, undefined, undefined, new Promise<void>((r) => (submitted = r)));
      }
      try {
        await c.submit();
      } finally {
        submitted();
      }
      if (settled) {
        // PayPal continues in its own window: the buttons stay locked while it is open (no second
        // window, no switch to the card under a payment in progress). A window the browser blocked
        // never takes the focus: nothing is pending then; the hint says to click "Continue with
        // PayPal", and Whop's own button shows in the embed (a click there opens PayPal itself).
        const opened = await settled;
        if (!alive.current) return;
        // A newer submit took over meanwhile (its watch aborted this one, which then reads as
        // "blocked"): its pending state, timings and hint are its own, left untouched.
        if (epochRef.current !== myEpoch) {
          /* only the button below is released */
        } else if (opened) {
          windowClosedAt.current = Date.now();
          windowClosed();
        } else {
          setPaypalPending(false);
          setPaypalTried(true);
          if (keyAtPay) setWhopButtonKey(keyAtPay);
          // No PayPal payment can be going through: the server drops that attempt (a switch to the
          // card isn't refused as in flight for the next 30 s).
          // Known, accepted race: a popup that was only slow (not blocked) opens after this signal;
          // until the late watch below re-stamps the server (onWhopWindow), another tab could get
          // a card confirm through. Whop still charges one checkout per payment, and the reverse
          // order (the blocked POST landing after the re-stamp) is a no-op server side (its
          // compare-and-set needs the window time equal to the click time).
          onWindowBlockedRef.current?.();
          // A late popup (it takes the focus after the "blocked" verdict, this page still visible:
          // a tab switch is no popup): pending again (lock restored) and the server told with a
          // beat (liveness only: the confirm's click stays the attempt its failure is matched to),
          // as long as the server's in-flight window lasts. Whop's own button is hidden meanwhile
          // (no second PayPal window next to ours). Aborted by a newer submit, Whop's own button,
          // PayPal dropped or the panel unmounted.
          const late = new AbortController();
          settleAbort.current = late;
          void paypalFocusLost(late.signal, PAYPAL_SERVER_IN_FLIGHT_MS).then(async (lost) => {
            if (!lost || !alive.current || late.signal.aborted || epochRef.current !== myEpoch) return;
            // The focus left from inside the embed: Whop's own button opened PayPal, its watch
            // (above, paypalWindowOpened) handles that submit.
            const active = document.activeElement;
            if (active?.tagName === "IFRAME" && embedBox.current?.contains(active)) return;
            windowClosedAt.current = null;
            setPaypalPending(true);
            setPaypalTried(false);
            setWhopButtonKey(null);
            setConfirmLeave(null);
            setPaypalWait(false);
            setCheckFailed(false);
            beat();
            await paypalWindowSettled(late.signal);
            if (alive.current && !late.signal.aborted) {
              windowClosedAt.current = Date.now();
              windowClosed();
            }
          });
        }
        setSubmitting(false);
      }
      // Completion arrives through onComplete; errors through onPaymentError.
    } catch (err) {
      if (setPending) settleAbort.current?.abort();
      if (setPending && !wasPending) setPaypalPending(false);
      if (setPending && wasPending) {
        windowClosedAt.current = prevClosed;
        lastSubmitAt.current = prevSubmitAt;
      }
      setSubmitting(false);
      setError(err instanceof Error ? err.message : labels.paymentFailed);
    }
  }

  // Express PayPal click on a complete form: submit the PayPal checkout as soon as it's ready.
  const autoSubmit = paypalOn && paypal.autoSubmit && ready && !submitting && !currentPreparing;
  useEffect(() => {
    if (!autoSubmit) return;
    // Next tick, once this render is committed (the flag is consumed with the submit).
    const t = setTimeout(() => {
      paypal?.onAutoSubmitted();
      void pay();
    }, 0);
    return () => clearTimeout(t);
    // pay() reads the latest render's state; this runs once per express click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSubmit]);

  const showConfirm = paypalOn && !!confirmLeave && paypalPending;
  const showWait = paypalOn && paypalWait && paypalPending && !confirmLeave;
  const waitText = checkFailed ? labels.paypalCheckFailed : labels.paypalPaymentInFlight;
  const serverWaitText = waitAfterDecline ? labels.cardDeclinedRetrySoon : labels.paymentAlreadyInFlight;
  // The question takes the focus on its first answer when it opens (keyboard and screen readers);
  // once answered (the group gone), it goes back to "Pay another way", as soon as that button is
  // usable again (after the checks), unless the buyer already put it somewhere else.
  const confirmWasOpen = useRef(false);
  const refocusPayOther = useRef(false);
  useEffect(() => {
    if (showConfirm) {
      if (!confirmWasOpen.current) confirmYes.current?.focus();
      confirmWasOpen.current = true;
      refocusPayOther.current = false;
      return;
    }
    if (confirmWasOpen.current) {
      confirmWasOpen.current = false;
      refocusPayOther.current = true;
    }
    if (!refocusPayOther.current) return;
    const el = payOther.current;
    if (el?.disabled) return;
    refocusPayOther.current = false;
    const active = document.activeElement;
    if (el && (!active || active === document.body)) el.focus();
  }, [showConfirm, submitting, checkingPaid]);
  // Switched to another method: "Pay another way" (or the question's answer) is gone with PayPal,
  // leaving the focus nowhere. It lands on the Pay button of the form now shown (no scroll), unless
  // the buyer already put it somewhere else.
  useEffect(() => {
    if (paypalOn || !focusPayAfterSwitch.current) return;
    focusPayAfterSwitch.current = false;
    const active = document.activeElement;
    if (!payOther.current && (!active || active === document.body)) payButtonRef.current?.focus({ preventScroll: true });
  }, [paypalOn]);

  const busy = submitting || checkingPaid || serverWait > 0 || currentPreparing || !current || !ready;
  const blocked = busy || !!prepareError;
  // The Whop form is being prepared or is booting: the button says so (one label, one spinner).
  const loading = !prepareError && !submitting && (currentPreparing || (!!current && !ready));
  const hint = incomplete.length > 0 && showIncomplete ? (incompleteHint ?? labels.completeFields(incomplete.join(", "))) : null;

  function onPayClick() {
    // Never a silent dead button: an incomplete form points the buyer to what is missing.
    if (incomplete.length > 0) {
      onIncomplete?.();
      return;
    }
    if (blocked) return;
    // "Continue with PayPal" again (blocked or closed window): straight to pay(), no dialog; a
    // payment that may still be going through is checked alongside (see pay()).
    void pay();
  }

  return (
    <div className="space-y-3">
      {/* Height reserved for the Whop form so the page doesn't jump when it loads. */}
      <div
        ref={embedBox}
        // Focusable by code only: takes the focus back from Whop's iframe after a PayPal window.
        tabIndex={-1}
        className="relative min-h-[264px] overflow-hidden rounded-[var(--radius)] border border-neutral-200 bg-white p-1 outline-none"
        aria-busy={!prepareError && (!current || !ready)}
      >
        {prepareError && !prepared ? (
          // Loading failed (after silent retries): a calm, static panel — never a pulsing
          // skeleton next to an error.
          <div
            role={interacted ? "alert" : "status"}
            className="flex min-h-[256px] flex-col items-center justify-center gap-3 px-6 py-8 text-center"
          >
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
        ) : current ? (
          <WhopCheckoutEmbed
            key={current.configId}
            ref={controls}
            sessionId={current.configId}
            environment={current.environment}
            theme="light"
            locale={theme.language}
            themeOptions={{ accentColor: theme.accentColor, borderRadius: theme.radius }}
            hideSubmitButton={!whopButton}
            hideEmail
            hideAddressForm={!showBillingForm}
            // The store's own terms checkbox already covers acceptance: no second "you accept X's terms" line.
            hideTermsAndConditions={theme.requireTerms}
            setupFutureUsage={saveCard ? "off_session" : undefined}
            skipRedirect
            returnUrl={returnUrl}
            onStateChange={(s) => setReadyFor(s === "ready" ? current.configId : null)}
            onComplete={paid}
            onPaymentError={(e) => {
              if (!paypalOn) cardDeclinedAt.current = Date.now();
              setPaypalPending(false);
              setPaypalWait(false);
              setCheckFailed(false);
              setConfirmLeave(null);
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
        {!prepareError && (currentPreparing || (current && !ready)) && (
          <div className="pointer-events-none absolute inset-0 flex items-start justify-end p-3">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-r-transparent" />
          </div>
        )}
      </div>

      {(error || (prepareError && prepared)) && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] bg-red-50 px-4 py-3 text-sm text-red-800">
          <span>{error ?? prepareError}</span>
          {prepareError && !error && onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="min-h-11 rounded-[var(--btn-radius)] border border-red-300 bg-white px-4 font-semibold text-red-800 hover:bg-red-100"
            >
              {labels.retry}
            </button>
          )}
        </div>
      )}

      {paypal?.error && (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span>{paypal.error}</span>
          {/* PayPal still chosen but its checkout failed to load: a way forward besides "Pay another way". */}
          {paypalOn && !paypal.prepared && !paypal.preparing && paypal.onRetry && (
            <button
              type="button"
              onClick={paypal.onRetry}
              data-testid="wc-paypal-retry"
              className="min-h-11 rounded-[var(--btn-radius)] border border-amber-300 bg-white px-4 font-semibold text-amber-900 hover:bg-amber-100"
            >
              {labels.retry}
            </button>
          )}
        </div>
      )}

      {beforeButton}

      {paypalOn && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-neutral-700" data-testid="wc-paypal-selected">
          <span className="inline-flex items-center gap-2 font-medium">
            <PaypalWordmark className="h-[18px] w-auto" />
            <span>{labels.paypalSelected}</span>
          </span>
          <button
            type="button"
            ref={payOther}
            // Locked while a PayPal window may be open; then only once the session is known unpaid.
            disabled={submitting || checkingPaid}
            onClick={() =>
              void afterPaypalCheck(() => {
                setPaypalTried(false);
                setError(null);
                paypal.onCancel();
              })
            }
            className="min-h-11 rounded-[var(--btn-radius)] px-2 font-medium text-neutral-800 underline underline-offset-2 hover:text-neutral-950 disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
          >
            {labels.paypalPayOther}
          </button>
        </div>
      )}

      {showConfirm && (
        <div
          role="group"
          aria-labelledby="wc-paypal-confirm-title"
          data-testid="wc-paypal-confirm"
          className="space-y-2 rounded-[var(--radius)] bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p id="wc-paypal-confirm-title" className="font-medium">
            {labels.paypalConfirmClosed}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              ref={confirmYes}
              disabled={checkingPaid}
              onClick={() => {
                // The buyer's word: the window is closed, its heartbeat stops counting server side.
                windowClosed();
                void afterPaypalCheck(confirmLeave, true);
              }}
              className="min-h-11 rounded-[var(--btn-radius)] border border-amber-300 bg-white px-4 font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
            >
              {labels.paypalConfirmYes}
            </button>
            <button
              type="button"
              onClick={() => setConfirmLeave(null)}
              className="min-h-11 rounded-[var(--btn-radius)] px-3 font-medium text-amber-900 underline underline-offset-2"
            >
              {labels.paypalConfirmWait}
            </button>
          </div>
        </div>
      )}
      {showWait && (
        <p data-testid="wc-paypal-wait" className="rounded-[var(--radius)] bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {waitText}
        </p>
      )}
      {serverWait > 0 && !showWait && (
        <p id="wc-inflight-wait" data-testid="wc-inflight-wait" className="flex items-start gap-2 rounded-[var(--radius)] bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-amber-300 border-r-transparent motion-reduce:animate-none" aria-hidden />
          {serverWaitText}
        </p>
      )}
      {/* One polite announcement per wait (the box above is no live region itself). The question is
          not repeated here: the focus moving into its labelled group already announces it. */}
      <p aria-live="polite" className="sr-only" data-testid="wc-paypal-live">
        {showWait ? waitText : serverWait > 0 ? serverWaitText : waitOver ? labels.payNowAvailable : ""}
      </p>

      <button
        id="wc-pay-button"
        ref={payButtonRef}
        type="button"
        aria-disabled={blocked || incomplete.length > 0}
        aria-busy={submitting || loading || undefined}
        // During the server wait, the reason Pay is unavailable (the wait's own line).
        aria-describedby={[serverWait > 0 && !showWait ? "wc-inflight-wait" : null, hint ? "wc-pay-hint" : null].filter(Boolean).join(" ") || undefined}
        onClick={onPayClick}
        className={`flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--btn-radius)] px-5 py-4 text-base font-semibold transition active:scale-[.99] ${
          paypalOn ? "bg-[#FFC439] text-[#111] hover:brightness-95" : "bg-[image:var(--accent-bg)] text-[var(--accent-fg)] shadow-[var(--btn-shadow)] hover:brightness-110"
        } ${blocked && incomplete.length === 0 ? "cursor-progress opacity-70" : ""}`}
      >
        {(submitting || loading) && <span className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent" aria-hidden />}
        {submitting ? labels.paymentProcessing : loading ? labels.paymentLoading : paypalOn ? labels.paypalContinue : payLabel}
      </button>
      {paypalOn && paypalTried && !error && (
        <p aria-live="polite" className="text-center text-sm text-neutral-700" data-testid="wc-paypal-popup-hint">
          {whopButton ? labels.paypalUseWhopButton : labels.paypalPopupHint}
        </p>
      )}
      {hint && (
        <p id="wc-pay-hint" aria-live="polite" className="text-center text-sm text-neutral-700">
          {hint}
        </p>
      )}
      <p className="flex items-center justify-center gap-1.5 text-xs text-neutral-600">
        <LockIcon /> {labels.paymentSecure}
      </p>
      {testMode && (
        <p className="rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">{labels.testMode}</p>
      )}
    </div>
  );
}

/** A card declined this recently makes a server wait say so (its attempt is what is in flight). */
export const CARD_DECLINED_RECENT_MS = 30_000;

/** Status checks during the server wait (another payment of the session still going through). */
export const SERVER_WAIT_POLL_MS = 2500;

/**
 * The server wait's next status check, in ms, or null to end the wait (buttons usable again).
 * "unpaid" ends it at once; "inFlight" and a failed check go on, but never past the status
 * route's in-flight window (PAYPAL_SERVER_IN_FLIGHT_MS) plus one check: the server itself stops
 * refusing by then, so the wait never traps the buyer. Pure.
 */
export function serverWaitNext(state: Exclude<PaidCheck, "paid">, elapsedMs: number): number | null {
  if (state === "unpaid") return null;
  return elapsedMs <= PAYPAL_SERVER_IN_FLIGHT_MS ? SERVER_WAIT_POLL_MS : null;
}

/** Background status checks while a PayPal payment may be going through. */
export const PENDING_POLL_MS = 4000;
/** Their pace while the tab is hidden (the buyer is in the PayPal window or elsewhere). */
export const PENDING_POLL_HIDDEN_MS = 15_000;
/** They stop this long after the PayPal window closed with the session still unpaid. */
export const PENDING_POLL_AFTER_CLOSE_MS = 2 * 60_000;
/** Longest watch of a PayPal window (see paypalWindowSettled); also the heartbeat's bound. */
export const PAYPAL_WINDOW_MAX_MS = 10 * 60_000;
/** Pace of the open PayPal window's heartbeat to the server (paypal-window: 10/min per session). */
export const PAYPAL_HEARTBEAT_MS = 20_000;
/** How long the status route reports a payment submitted moments ago as in flight (shared with it). */
export { PAYPAL_SERVER_IN_FLIGHT_MS };
/** How long a click inside the embed (window blurred into its iframe) may open PayPal's window. */
export const PAYPAL_WINDOW_ARM_MS = 3000;

/**
 * Delay before the next background status check of a pending PayPal payment, or null to stop:
 * unpaid ~2 min after its window closed, or past the longest window watch plus that (whatever the
 * answers, never polls forever). Slower while the tab is hidden. Pure.
 */
export function pendingPollNext(
  state: PaidCheck,
  t: { now: number; startedAt: number; windowClosedAt: number | null; hidden: boolean },
): number | null {
  if (state === "unpaid" && t.windowClosedAt != null && t.now - t.windowClosedAt >= PENDING_POLL_AFTER_CLOSE_MS) return null;
  if (t.now - t.startedAt >= PAYPAL_WINDOW_MAX_MS + PENDING_POLL_AFTER_CLOSE_MS) return null;
  return t.hidden ? PENDING_POLL_HIDDEN_MS : PENDING_POLL_MS;
}

/**
 * "Continue with PayPal" again while the last PayPal payment may still go through, from the status
 * checked alongside confirm(): paid (thank-you page), submit, or wait. In flight or unknown means
 * wait, unless that payment was submitted longer ago than the status route's in-flight window and
 * its window closed over ~10 s ago: the "in flight" can then only be this very click's confirm()
 * (it marks the session PAYING), and the server refuses a session already paid. Pure.
 */
export function paypalRetryStep(state: PaidCheck, t: { now: number; lastSubmitAt: number | null; windowClosedAt: number | null }): "paid" | "submit" | "wait" {
  if (state === "paid") return "paid";
  if (state === "unpaid") return "submit";
  // The wait is bounded: at most ~30 s after the last submit (PAYPAL_SERVER_IN_FLIGHT_MS, the
  // status route's own in-flight window) and ~10 s after its window closed, whichever is later.
  // Past both, "inFlight" can't be the earlier payment any more: this very click's confirm() just
  // marked the session PAYING, so waiting longer would lock the buyer out of PayPal for good while
  // gaining nothing (the server still refuses to take a session already paid).
  const old = t.lastSubmitAt == null || t.now - t.lastSubmitAt >= PAYPAL_SERVER_IN_FLIGHT_MS;
  const closed = t.windowClosedAt != null && t.now - t.windowClosedAt >= PAYPAL_AFTER_WINDOW_MS;
  return old && closed ? "submit" : "wait";
}
/** Pause between the status checks before leaving a pending PayPal payment. */
export const PAYPAL_CHECK_POLL_MS = 2000;
/** Never a switch to another method sooner than this after the buyer said the window is closed. */
export const PAYPAL_MIN_SWITCH_WAIT_MS = 2500;
/** Checks go on this long after the PayPal window closed (the payment may complete just after it; shared with the server). */
export { PAYPAL_AFTER_WINDOW_MS };
/** Longest wait for a payment the status route still sees in flight, from the buyer's answer. */
export const PAYPAL_IN_FLIGHT_WATCH_MS = 10_000;

/** What to do after a status check, before leaving a pending PayPal payment. */
export type PaypalLeaveStep = { next: "paid" } | { next: "switch" } | { next: "wait" } | { next: "poll"; inMs: number };

/**
 * The decision after each status check when the buyer leaves a pending PayPal payment ("Pay
 * another way", window said closed at `askedAt`). Paid: thank-you page. Otherwise another method
 * only once at least 2.5 s passed and, when the PayPal window really opened, ~10 s after it closed
 * (`windowClosedAt`), whatever the status route says meanwhile ("poll" again). Still in flight
 * past both, and ~10 s after the answer: "wait" (nothing else starts). A failed check ("unknown")
 * counts as in flight, so it ends in "wait" too, except ~2 min after the window closed (the
 * background checks' own limit): then unpaid, so a status route that keeps failing never locks the
 * buyer in for good (another method still goes through the server, which refuses a paid session).
 * Same rule as paypalRetryStep when `lastSubmitAt` is given: that submit longer ago than the status
 * route's in-flight window and its window closed ~10 s ago, "in flight" (or unknown) counts as
 * unpaid, so a "Continue with PayPal" retry that ended in "wait" (its confirm() marked the session
 * PAYING again) never stretches this wait. Pure.
 */
export function paypalLeaveStep(
  answer: PaidCheck,
  t: { now: number; askedAt: number; windowClosedAt: number | null; lastSubmitAt?: number | null },
): PaypalLeaveStep {
  if (answer === "paid") return { next: "paid" };
  const stale = t.lastSubmitAt !== undefined && answer !== "unpaid" && paypalRetryStep(answer, { now: t.now, lastSubmitAt: t.lastSubmitAt, windowClosedAt: t.windowClosedAt }) === "submit";
  const state = answer === "unpaid" || stale ? "unpaid" : answer !== "unknown" ? answer : t.windowClosedAt != null && t.now - t.windowClosedAt >= PENDING_POLL_AFTER_CLOSE_MS ? "unpaid" : "inFlight";
  const switchFrom = Math.max(t.askedAt + PAYPAL_MIN_SWITCH_WAIT_MS, t.windowClosedAt != null ? t.windowClosedAt + PAYPAL_AFTER_WINDOW_MS : 0);
  const until = state === "unpaid" ? switchFrom : Math.max(switchFrom, t.askedAt + PAYPAL_IN_FLIGHT_WATCH_MS);
  if (t.now >= until) return { next: state === "unpaid" ? "switch" : "wait" };
  return { next: "poll", inMs: Math.min(PAYPAL_CHECK_POLL_MS, until - t.now) };
}

/**
 * Resolves `true` once a window takes the focus from this page after an interaction inside the
 * embed (Whop's own PayPal button clicked there opens it), `false` when `signal` aborts first.
 * Armed only when this window blurs while one of the embed's iframes (inside `embed()`, any iframe
 * without it) holds the focus: a mere tab switch or a click elsewhere is no PayPal window. The
 * arming expires `armMs` after that blur (PayPal's window opens right after the click): a tab
 * switch long after a click in the embed (the focus left in its iframe) opens nothing.
 */
export function paypalWindowOpened(signal: AbortSignal, embed?: () => Element | null, armMs = PAYPAL_WINDOW_ARM_MS): Promise<boolean> {
  return new Promise((resolve) => {
    let armed = false;
    let armedAt = 0;
    const inEmbed = () => {
      const el = document.activeElement;
      if (!el || el.tagName !== "IFRAME") return false;
      const box = embed?.();
      return embed ? !!box && box.contains(el) : true;
    };
    // The focus moves into the iframe as the window blurs: read it once the blur is done.
    let blurCheck: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => {
      clearTimeout(blurCheck);
      blurCheck = setTimeout(() => {
        if (inEmbed()) {
          armed = true;
          armedAt = Date.now();
        }
      }, 0);
    };
    // Back on the page itself (a field, a button): whatever happened in the embed is over.
    const onFocusIn = () => {
      if (!inEmbed()) armed = false;
    };
    window.addEventListener("blur", onBlur);
    document.addEventListener("focusin", onFocusIn);
    const finish = (opened: boolean) => {
      clearInterval(poll);
      clearTimeout(blurCheck);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("focusin", onFocusIn);
      signal.removeEventListener("abort", onAbort);
      resolve(opened);
    };
    const onAbort = () => finish(false);
    const poll = setInterval(() => {
      if (armed && Date.now() - armedAt > armMs) armed = false;
      if (armed && (document.visibilityState !== "visible" || !document.hasFocus())) finish(true);
    }, 200);
    if (signal.aborted) finish(false);
    else signal.addEventListener("abort", onAbort);
  });
}

/**
 * Resolves once the PayPal window no longer holds the focus, with whether it ever took it: `true`
 * when the focus left this page and came back (window closed, or put behind), `false` when it never
 * left within `graceMs` (a blocked popup never takes it: nothing can be pending). The page's own
 * iframes keep document focus. Also resolves when `signal` aborts (the panel unmounted) or after
 * `maxMs` (never polls forever), with what was seen so far.
 */
export function paypalWindowSettled(signal?: AbortSignal, maxMs = PAYPAL_WINDOW_MAX_MS, graceMs = 2500, graceFrom?: Promise<unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    let left = false;
    // The grace for a blocked window counts from `graceFrom` (the submit done), else from now.
    let started: number | null = graceFrom ? null : Date.now();
    graceFrom?.then(
      () => (started ??= Date.now()),
      () => (started ??= Date.now()),
    );
    const away = () => document.visibilityState !== "visible" || !document.hasFocus();
    const done = () => {
      clearInterval(poll);
      clearTimeout(cap);
      signal?.removeEventListener("abort", done);
      resolve(left);
    };
    const poll = setInterval(() => {
      if (away()) left = true;
      else if (left || (started != null && Date.now() - started >= graceMs)) done();
    }, 200);
    const cap = setTimeout(done, maxMs);
    if (signal?.aborted) done();
    else signal?.addEventListener("abort", done);
  });
}

/**
 * Resolves `true` as soon as this page loses the focus while it stays visible (another window in
 * front of it: a popup) within `ms`, `false` after `ms` or once `signal` aborts: a PayPal popup that
 * opens late, after the "blocked" verdict of paypalWindowSettled. A hidden page (a tab switch, the
 * browser minimized) is no popup and counts for nothing.
 */
export function paypalFocusLost(signal: AbortSignal, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (lost: boolean) => {
      clearInterval(poll);
      clearTimeout(cap);
      signal.removeEventListener("abort", onAbort);
      resolve(lost);
    };
    const onAbort = () => finish(false);
    // Seen on two polls in a row: a tab switch blurs the page a moment before it turns hidden.
    let seen = 0;
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && !document.hasFocus()) {
        if (++seen >= 2) finish(true);
      } else seen = 0;
    }, 200);
    const cap = setTimeout(() => finish(false), ms);
    if (signal.aborted) finish(false);
    else signal.addEventListener("abort", onAbort);
  });
}

export function PaymentSkeleton() {
  return (
    <div className="space-y-3 p-4" aria-hidden>
      <div className="flex gap-2">
        <div className="h-10 flex-1 animate-pulse rounded-md bg-neutral-100" />
        <div className="h-10 flex-1 animate-pulse rounded-md bg-neutral-100" />
        <div className="h-10 flex-1 animate-pulse rounded-md bg-neutral-100" />
      </div>
      <div className="h-11 animate-pulse rounded-md bg-neutral-100" />
      <div className="grid grid-cols-2 gap-3">
        <div className="h-11 animate-pulse rounded-md bg-neutral-100" />
        <div className="h-11 animate-pulse rounded-md bg-neutral-100" />
      </div>
      <div className="h-11 animate-pulse rounded-md bg-neutral-100" />
    </div>
  );
}

export function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

/** Static stand-in for the builder preview (no live Whop form there). */
export function PaymentPreview({
  labels,
  payLabel,
  beforeButton,
  hideWallets,
}: {
  labels: Labels;
  payLabel: string;
  beforeButton?: ReactNode;
  /**
   * The wallets whose express button already shows above: not repeated as tabs. Only those (a
   * wallet switched off up there stays a tab of the form, as Whop offers it when enabled).
   */
  hideWallets?: readonly ExpressWallet[];
}) {
  const wallets = ([["apple-pay", "Apple Pay"], ["google-pay", "Google Pay"]] as const).filter(([w]) => !hideWallets?.includes(w)).map(([, name]) => name);
  const methods = [labels.methodCard, "PayPal", ...wallets];
  return (
    <div className="space-y-3">
      <div className="space-y-3 rounded-[var(--radius)] border border-neutral-200 bg-white p-4">
        <div className="flex flex-wrap gap-2 text-xs font-semibold">
          {methods.map((m, i) => (
            <span key={m} className={`rounded-md border px-3 py-2 ${i === 0 ? "border-[var(--accent)] text-[var(--accent)]" : "border-neutral-200 text-neutral-600"}`}>
              {m}
            </span>
          ))}
        </div>
        <div className="h-11 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">1234 1234 1234 1234</div>
        <div className="grid grid-cols-2 gap-3">
          <div className="h-11 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">{labels.cardExpiryPlaceholder}</div>
          <div className="h-11 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-3 text-sm text-neutral-500">CVC</div>
        </div>
      </div>
      {beforeButton}
      <div className="flex w-full items-center justify-center rounded-[var(--btn-radius)] bg-[image:var(--accent-bg)] px-5 py-4 text-base font-semibold text-[var(--accent-fg)] shadow-[var(--btn-shadow)]">
        {payLabel}
      </div>
      <p className="flex items-center justify-center gap-1.5 text-xs text-neutral-600">
        <LockIcon /> {labels.paymentSecure}
      </p>
    </div>
  );
}

/**
 * Static express buttons for the builder preview. Live, Whop only shows them on a
 * device/browser with a wallet set up (Safari + Apple Pay, Chrome + Google Pay) and
 * hides the whole block otherwise: the builder chrome explains it (not the canvas).
 */
export function ExpressPreview({
  labels,
  title,
  dividerLabel,
  walletMethods = EXPRESS_WALLETS,
  paypal = true,
}: {
  labels: Labels;
  title?: string;
  dividerLabel?: string;
  /** The wallets the merchant chose (see expressMethodsShown), in display order. */
  walletMethods?: readonly ExpressMethod[];
  /** The merchant's PayPal switch. */
  paypal?: boolean;
}) {
  const wallets = EXPRESS_WALLETS.filter((m) => walletMethods.includes(m));
  const cols = wallets.length + (paypal ? 1 : 0);
  // Nothing chosen: no section at all (as live).
  if (cols === 0) return null;
  const walletLook = "flex h-12 items-center justify-center gap-1 rounded-[var(--radius)] bg-black text-[15px] font-semibold text-white";
  const spanLast = cols === 3 ? "col-span-2 sm:col-span-1" : "";
  const last = paypal ? "paypal" : wallets[wallets.length - 1];
  return (
    <section data-testid="wc-express-preview">
      <p data-inline-field="title" className="mb-3 text-center text-xs font-medium tracking-wide text-neutral-600 uppercase">
        {title || labels.expressCheckout}
      </p>
      <div className={`grid gap-2 ${cols >= 2 ? "grid-cols-2" : ""} ${cols === 3 ? "sm:grid-cols-3" : cols === 4 ? "sm:grid-cols-4" : ""}`}>
        {wallets.map((m) => (
          <div key={m} data-express-method={m} className={`${walletLook} ${last === m ? spanLast : ""}`}>
            {m === "apple-pay" ? (
              <>
                <AppleLogo /> Pay
              </>
            ) : m === "google-pay" ? (
              <>
                <GoogleG /> Pay
              </>
            ) : (
              "Whop Pay"
            )}
          </div>
        ))}
        {paypal && (
          <div data-express-method="paypal" className={spanLast || undefined}>
            <PaypalButton label={labels.payWithPaypal} preview />
          </div>
        )}
      </div>
      {/* Builder only (merchant-facing, French like the dashboard): PayPal is not always there. */}
      {paypal && <p className="mt-1.5 text-center text-[11px] text-neutral-500">PayPal : affiché seulement si Whop l&apos;active pour la boutique.</p>}
      <Divider label={dividerLabel || labels.or} />
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
