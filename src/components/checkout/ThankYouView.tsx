"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { Check, ChevronDown, CreditCard, ExternalLink, Gift, Home, LifeBuoy, Mail, MapPin, Package, ShieldCheck, Truck } from "lucide-react";
import { FIXED_THANK_YOU_BLOCKS, createBlock, dedupeSingletons, isFixedThankYou, upsellSellable, type Block, type BlockOf, type Layout, type OfferArm, type Theme } from "@/lib/layout";
import { formatMoney, visibleProperties, type CartLine } from "@/lib/pricing";
import { ContentBlock, focusAfterDecline, isEmptyInLive, offerAwaitingAnswer, StyledBlock, type ContentContext } from "./blocks";
import { cartProductsOf } from "@/lib/reviews-import";
import { Footer, LineThumb, StoreHeader, themeVars } from "./CheckoutView";
import { countryName, labelsFor, localeOf, paymentMethodName, type Labels } from "./i18n";
import { localizeDeliveryTime, localizeLayout, localizeTheme } from "./localize";
import { localEstimate, type LocalRates } from "./localCurrency";
import { ProtectionClaimForm } from "./ProtectionClaimForm";

export type ThankYouData = {
  status: "OPEN" | "PAYING" | "PAID" | "FAILED" | "ABANDONED";
  orderName: string | null;
  email: string;
  firstName: string;
  address: { name: string; lines: string[]; countryCode: string } | null;
  /** Relay point chosen at checkout: it is the delivery address. */
  pickup?: { name: string; lines: string[]; countryCode: string } | null;
  lines: CartLine[];
  currency: string;
  subtotalCents: number;
  discountCents: number;
  /** Code the buyer entered ("BIENVENUE10"), shown next to the discount line. */
  discountCode?: string | null;
  shippingCents: number;
  addOnsCents: number;
  totalCents: number;
  continueUrl: string | null;
  /** Shipping rate chosen at checkout (name + "3 à 5 jours ouvrés"), when known. */
  shippingMethod?: { name: string; deliveryTime: string | null; /** The merchant's translation of the delay, shown when no date range can be derived. */ deliveryText?: string | null } | null;
  /** When the order was paid (ISO), to date the delivery estimate. */
  paidAt?: string | null;
  /** Whop payment method type ("card", "apple_pay"…), when known. */
  paymentMethod?: string | null;
  /** Parcel tracking, once Shopify has a fulfillment with a number. */
  tracking?: { number: string; url: string } | null;
  /** Order bumps taken (titles in the buyer's language), shown one per row instead of the "Options" total. */
  addOnItems?: { title: string; priceCents: number }[];
  /** Shipping protection bought at checkout (part of addOnsCents), with the merchant's claim instructions. */
  protection?: {
    priceCents: number;
    claimText: string;
    /** "Signaler un problème de livraison" form offered (paid, within 30 days). */
    claimable?: boolean;
    /** Latest buyer report's status. */
    claimStatus?: "pending" | "approved" | "rejected" | null;
    /** Photos sent with that report (signed links). */
    claimPhotos?: string[];
  } | null;
  /** The post-purchase survey was already answered. */
  surveyAnswered?: boolean;
  /** Currency the checkout was charged in when it wasn't the shop's (offers are charged in the shop's). */
  chargeCurrency?: string | null;
  /** The checkout page of this session (a FAILED payment links back to it to pay again). */
  checkoutUrl?: string | null;
};

/** One-click offers stay open this long after the payment (server: UPSELL_WINDOW_MS). */
const OFFER_WINDOW_MS = 60 * 60 * 1000;
const SUPPORT_LINK = /contact|support|aide|help|hilfe|kontakt|ayuda|contatt|aiuto|klantenservice|service client/i;

type Props = {
  theme: Theme;
  layout: Layout;
  data: ThankYouData;
  sessionId?: string; // live mode: poll until the Shopify order exists
  preview?: {
    selectedBlockId?: string | null;
    onSelectBlock?: (id: string) => void;
  };
  upsell?: {
    eligible: boolean;
    states: Record<string, string>;
    /** Offers whose targeting matches this order; missing = all. */
    offerIds?: string[];
    /** A/B arm per offer block (server-side, sticky per visitor). */
    arms?: Record<string, OfferArm>;
    /** Live Shopify unit prices by variant GID ("% off" offers). */
    livePrices?: Record<string, number>;
  };
  /** Full-screen preview: show the offers like the builder canvas (answers do nothing). */
  demoOffers?: boolean;
  /** Order currency → local currency multipliers, for the "≈ 52,30 CHF" line under the total. */
  localRates?: LocalRates | null;
};

const noopSubscribe = () => () => {};

/**
 * Blocks in display order. Layouts always carry the three built-in sections once loaded;
 * a layout without them (older data passed straight in) gets them between its
 * "above" and "below" blocks, with stable ids so server and browser render the same.
 */
function orderedBlocks(blocks: Block[]): Block[] {
  if (blocks.some((b) => isFixedThankYou(b.type))) return blocks;
  const fixed = FIXED_THANK_YOU_BLOCKS.map((t) => ({ ...createBlock(t), id: `__${t}` }) as Block);
  return [...blocks.filter((b) => b.position === "above"), ...fixed, ...blocks.filter((b) => b.position !== "above")];
}

/** "3 à 5 jours ouvrés" → { min: 3, max: 5, business: true }; null when there is no number. */
function parseDeliveryTime(text: string | null | undefined) {
  const nums = text?.match(/\d+/g)?.map(Number) ?? [];
  if (!text || nums.length === 0) return null;
  const min = nums[0];
  const max = Math.max(min, nums[1] ?? min);
  if (max > 60) return null;
  const business = /ouvr|business|working|werk|lavorativ|h[áa]bil|laborable/i.test(text);
  const weeks = /semaine|week|woche|seman|settiman/i.test(text);
  return {
    min: weeks ? min * 7 : min,
    max: weeks ? max * 7 : max,
    business: business && !weeks,
  };
}

function addDays(from: Date, days: number, businessOnly: boolean) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (!businessOnly || (wd !== 0 && wd !== 6)) left -= 1;
  }
  return d;
}

export function ThankYouView({ theme: themeProp, layout: layoutProp, data: initial, sessionId, preview, upsell, demoOffers = false, localRates }: Props) {
  // Buyer-language copy: merchant translations, then shipped French defaults translated.
  const theme = localizeTheme(themeProp);
  const layout = localizeLayout(layoutProp, themeProp.language);
  const L = labelsFor(theme.language);
  const [data, setData] = useState(initial);
  const [mountedAt] = useState(() => Date.now());
  // Small screens: order summary collapsed at the top of the page (like Shopify's thank-you page).
  const [summaryOpen, setSummaryOpen] = useState(false);
  // Ticks while an offer is on the page, so it disappears when its window closes.
  const [now, setNow] = useState(mountedAt);
  // Answers to the offers, updated in place (a decline reveals the downsell).
  const [offerStates, setOfferStates] = useState<Record<string, string>>(() => upsell?.states ?? {});
  const [offerMessages, setOfferMessages] = useState<Record<string, string>>({});
  // "No thanks" in this page view: announced in a live region that outlives the offer card, and
  // focus moves on once the page shows what replaces it (next step, next offer or the heading).
  const [declines, setDeclines] = useState<{ count: number; index: number }>({ count: 0, index: 0 });
  useEffect(() => {
    if (declines.count) focusAfterDecline(declines.index);
  }, [declines]);
  // Dates depend on the buyer's time zone: only render them in the browser.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const money = (c: number) => formatMoney(c, data.currency, localeOf(theme.language));

  useEffect(() => {
    if (!sessionId || data.orderName) return;
    let tries = 0;
    const t = setInterval(async () => {
      tries += 1;
      if (tries > 40) clearInterval(t);
      try {
        const res = await fetch(`/api/public/sessions/${sessionId}/status`, {
          cache: "no-store",
        });
        if (!res.ok) return;
        const s = await res.json();
        // Until the webhook lands the session can still read OPEN: keep showing "processing".
        setData((d) => ({
          ...d,
          status: s.status === "OPEN" ? d.status : s.status,
          orderName: s.shopifyOrderName,
        }));
        if (s.shopifyOrderName) clearInterval(t);
      } catch {
        /* offline for a moment: try again on the next tick */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [sessionId, data.orderName]);

  // Totals: sessions paid through an express wallet may not have them stored yet.
  const linesSubtotal = data.lines.reduce((s, l) => s + l.unitPriceCents * l.quantity, 0);
  const protectionCents = Math.min(data.addOnsCents, data.protection?.priceCents ?? 0);
  const subtotal = data.subtotalCents || linesSubtotal;
  const total = data.totalCents || Math.max(0, subtotal - data.discountCents + data.shippingCents + data.addOnsCents);
  const needsShipping = data.lines.some((l) => l.requiresShipping);
  const localTotal = localEstimate(total, data.address?.countryCode ?? data.pickup?.countryCode, data.currency, localRates, theme.language);

  const paidAtMs = data.paidAt ? Date.parse(data.paidAt) : NaN;
  const ctx: ContentContext = {
    labels: L,
    // Live: paid time + 1 h. Preview: a full hour from now, to show the line.
    demoOffers,
    offerEndsAt: preview || demoOffers ? mountedAt + OFFER_WINDOW_MS : Number.isNaN(paidAtMs) ? null : paidAtMs + OFFER_WINDOW_MS,
    lang: theme.language,
    lowestInventory: null,
    preview: !!preview,
    subtotalCents: subtotal - data.discountCents,
    freeShippingThresholdCents: null,
    money,
    note: "",
    setNote: () => {},
    upsell: undefined,
    lineImages: Object.fromEntries(data.lines.filter((l) => l.imageUrl && !l.gift).map((l) => [l.variantId, l.imageUrl!])),
    cartProducts: preview ? null : cartProductsOf(data.lines),
    // The survey is answered once the order is paid (live); the builder shows it inert.
    survey: sessionId && data.status === "PAID" ? { sessionId, answered: !!data.surveyAnswered } : null,
    offerCurrency: data.chargeCurrency && data.chargeCurrency.toUpperCase() !== data.currency.toUpperCase() ? { shop: data.currency, paid: data.chargeCurrency } : null,
  };
  // One gift card / one of each widget, even if an old layout saved duplicates.
  const blocks = orderedBlocks(dedupeSingletons(layout.blocks.filter((b) => !b.hidden || isFixedThankYou(b.type))));
  if (sessionId && upsell) {
    const offers = blocks.filter((b): b is BlockOf<"upsell"> => b.type === "upsell" && upsellSellable(b.props));
    ctx.upsell = {
      sessionId,
      eligible: upsell.eligible,
      states: offerStates,
      messages: offerMessages,
      offerIds: upsell.offerIds ?? offers.map((b) => b.id),
      blocks: offers,
      arms: upsell.arms,
      livePrices: upsell.livePrices,
      setState: (id, status, message) => {
        setOfferStates((s) => ({ ...s, [id]: status }));
        if (message) setOfferMessages((m) => ({ ...m, [id]: message }));
      },
      declined: (index) => setDeclines((d) => ({ count: d.count + 1, index })),
    };
  }
  const upsellBlocks = blocks.filter((b): b is BlockOf<"upsell"> => b.type === "upsell");
  const hasLiveOffers = !!ctx.upsell && upsellBlocks.some((b) => !isEmptyInLive(b, ctx, now));
  useEffect(() => {
    if (!hasLiveOffers) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [hasLiveOffers]);
  // An offer still waits for "Yes, add it": "Continue shopping" steps back to a secondary button.
  const offerPending =
    preview || demoOffers
      ? upsellBlocks.length > 0
      : !!ctx.upsell && upsellBlocks.some((b) => !isEmptyInLive(b, ctx, now) && offerAwaitingAnswer(b, ctx.upsell!));
  // Where buyers get help: a contact / support link of the theme, else the support block's e-mail.
  const supportBlock = blocks.find((b): b is BlockOf<"support"> => b.type === "support" && !!b.props.email);
  const supportHref =
    theme.policyLinks.find((l) => l.url && (SUPPORT_LINK.test(l.label) || /^mailto:/i.test(l.url)))?.url ??
    (supportBlock ? `mailto:${supportBlock.props.email}` : null);
  const wrap = (b: Block, node: ReactNode) => {
    const selected = preview?.selectedBlockId === b.id;
    // Built-in sections already are spaced cards: no extra padding unless the merchant asks.
    const style = isFixedThankYou(b.type) && b.style.spacing === "default" ? { ...b.style, spacing: "none" as const } : b.style;
    const inner = <StyledBlock style={style}>{node}</StyledBlock>;
    return preview?.onSelectBlock ? (
      <div
        key={b.id}
        data-block-id={b.id}
        onClick={() => preview.onSelectBlock!(b.id)}
        className={`-mx-2 cursor-pointer rounded-lg px-2 ${selected ? "outline-2 outline-[var(--accent)] outline-solid" : "hover:outline-1 hover:outline-neutral-300 hover:outline-dashed"}`}
      >
        {inner}
      </div>
    ) : (
      <div key={b.id} data-block-id={b.id}>
        {inner}
      </div>
    );
  };

  const confirmed = data.status === "PAID" || !!data.orderName;
  // The payment failed (declined card, a bank page abandoned): never "processing", back to the checkout.
  const failed = data.status === "FAILED" && !confirmed;
  const estimate = parseDeliveryTime(data.shippingMethod?.deliveryTime);
  const start = hydrated ? new Date(data.paidAt ? Date.parse(data.paidAt) : mountedAt) : null;
  const fmt = (d: Date) =>
    d.toLocaleDateString(localeOf(theme.language), {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
  const range = start && estimate ? `${fmt(addDays(start, estimate.min, estimate.business))} – ${fmt(addDays(start, estimate.max, estimate.business))}` : null;
  const estimateText =
    range ?? data.shippingMethod?.deliveryText ?? (data.shippingMethod?.deliveryTime ? localizeDeliveryTime(data.shippingMethod.deliveryTime, theme.language) : null);

  // Paid orders always show how: a card unless Whop told us otherwise.
  const methodName = paymentMethodName(data.paymentMethod, L) ?? L.methodCard;
  const confirmation = (title: string) =>
    failed ? (
      <section role="alert" data-testid="wc-payment-failed" className="space-y-3 rounded-[var(--radius)] border border-red-200 bg-red-50 p-5 text-red-900">
        <h1 data-order-heading="" tabIndex={-1} className="font-[family-name:var(--heading-font)] text-xl font-semibold tracking-tight focus:outline-none">
          {L.orderPaymentFailed}
        </h1>
        {data.checkoutUrl && (
          <a
            href={data.checkoutUrl}
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--radius)] bg-[image:var(--accent-bg)] px-5 font-medium text-[var(--accent-fg)] shadow-[var(--btn-shadow)]"
          >
            {L.backToCheckout}
          </a>
        )}
      </section>
    ) : (
    <div className="space-y-4">
      <div className="flex items-center gap-4 py-2">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[image:var(--accent-bg)] text-[var(--accent-fg)] shadow-[var(--btn-shadow)]">
          <Check className="h-6 w-6" strokeWidth={3} aria-hidden />
        </span>
        <div>
          <p className="text-sm text-neutral-600">
            {data.orderName ? (
              <>
                {L.order} <strong className="font-semibold text-neutral-900">{data.orderName}</strong>
              </>
            ) : (
              L.orderNumberPending
            )}
          </p>
          <h1
            data-inline-field="title"
            // Focus target once the last offer is declined (the offer card is gone).
            data-order-heading=""
            tabIndex={-1}
            className="rounded-sm font-[family-name:var(--heading-font)] text-2xl font-semibold tracking-tight focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus,#111827)] focus-visible:ring-offset-2"
          >
            {title ? title.replace(/\{(name|prénom|prenom)\}/gi, data.firstName).trim() : L.thankYou(data.firstName)}
          </h1>
        </div>
      </div>

      <section className="rounded-[var(--radius)] border border-neutral-200 bg-white p-5" aria-live="polite">
        <p className="flex items-center gap-2 font-medium">
          {!confirmed && <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-r-transparent" aria-hidden />}
          {confirmed ? L.orderConfirmed : L.orderProcessing}
        </p>
        {data.email && (
          <p className="mt-1.5 flex items-center gap-2 text-sm text-neutral-700">
            <Mail className="h-4 w-4 shrink-0 text-neutral-600" aria-hidden />
            {L.confirmationSent(data.email)}
          </p>
        )}
        {needsShipping && <Timeline L={L} start={start} estimate={estimate} fmt={fmt} />}
      </section>
    </div>
  );
  // Shipping protection: its own card, so a one-click offer placed right after the
  // confirmation comes first on small screens (the offer is time-limited, this is reference).
  const protectionCard = data.protection ? (
    <section className="rounded-[var(--radius)] border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900" aria-labelledby="ty-protection">
      <h2 id="ty-protection" className="flex items-center gap-2 font-semibold">
        <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-700" aria-hidden />
        {L.protectionOn}
      </h2>
      <p className="mt-1 leading-relaxed whitespace-pre-line">{data.protection.claimText.trim() || L.protectionDefault}</p>
      {sessionId && (data.protection.claimable || data.protection.claimStatus) && (
        <ProtectionClaimForm sessionId={sessionId} L={L} status={data.protection.claimStatus ?? null} orderEmail={data.email} photos={data.protection.claimPhotos} />
      )}
    </section>
  ) : null;
  const details = (title: string) =>
    data.address || data.pickup || data.shippingMethod || data.tracking || data.email || methodName || supportHref ? (
      <section className="grid gap-5 rounded-[var(--radius)] border border-neutral-200 bg-white p-5 text-sm sm:grid-cols-2">
        {data.pickup ? (
          <div>
            <h2 className="mb-1 text-xs font-semibold tracking-wide text-neutral-600 uppercase">{L.pickupShipTo}</h2>
            <p className="flex items-start gap-1.5 font-medium">
              <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" aria-hidden />
              {data.pickup.name}
            </p>
            {data.pickup.lines.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
            <p>{countryName(data.pickup.countryCode, theme.language)}</p>
            {data.address && <p className="mt-2 text-neutral-600">{data.address.name}</p>}
          </div>
        ) : data.address && (
          <div>
            <h2 data-inline-field="title" className="mb-1 text-xs font-semibold tracking-wide text-neutral-600 uppercase">
              {title || L.shipTo}
            </h2>
            <p className="font-medium">{data.address.name}</p>
            {data.address.lines.map((line, i) => (
              <p key={i}>{line}</p>
            ))}
            <p>{countryName(data.address.countryCode, theme.language)}</p>
          </div>
        )}
        <div className="space-y-4">
          {data.shippingMethod && (
            <div>
              <h2 className="mb-1 text-xs font-semibold tracking-wide text-neutral-600 uppercase">{L.estimatedDelivery}</h2>
              <p className="flex items-center gap-1.5 font-medium">
                <Truck className="h-4 w-4 text-[var(--accent)]" aria-hidden />
                {estimateText ?? data.shippingMethod.name}
              </p>
              {estimateText && <p className="text-neutral-600">{data.shippingMethod.name}</p>}
            </div>
          )}
          {data.tracking && (
            <div>
              <h2 className="mb-1 text-xs font-semibold tracking-wide text-neutral-600 uppercase">{L.stepShipped}</h2>
              <a
                href={data.tracking.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 font-medium underline underline-offset-2 hover:no-underline"
              >
                <Truck className="h-4 w-4 text-[var(--accent)]" aria-hidden />
                {L.trackOrder}
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
              <p className="text-xs break-all text-neutral-600">{data.tracking.number}</p>
            </div>
          )}
          <div>
            <h2 className="mb-1 text-xs font-semibold tracking-wide text-neutral-600 uppercase">{L.paymentMethod}</h2>
            <p className="flex items-center gap-1.5 font-medium">
              <CreditCard className="h-4 w-4 text-[var(--accent)]" aria-hidden />
              {methodName}
            </p>
          </div>
          {data.email && (
            <div>
              <h2 className="mb-1 text-xs font-semibold tracking-wide text-neutral-600 uppercase">{L.contact}</h2>
              <p className="break-all">{data.email}</p>
            </div>
          )}
          {supportHref && (
            <div>
              <h2 className="mb-1 text-xs font-semibold tracking-wide text-neutral-600 uppercase">{L.needHelp}</h2>
              <a
                href={supportHref}
                target={supportHref.startsWith("mailto:") ? undefined : "_blank"}
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-1.5 font-medium underline underline-offset-2 hover:no-underline"
              >
                <LifeBuoy className="h-4 w-4 text-[var(--accent)]" aria-hidden />
                {L.contactUs}
              </a>
            </div>
          )}
        </div>
      </section>
    ) : null;
  const summary = (title: string) => (
    <section className="rounded-[var(--radius)] border border-neutral-200 bg-white p-5" aria-labelledby="ty-summary">
      <h2 id="ty-summary" data-inline-field="title" className="mb-3 text-xs font-semibold tracking-wide text-neutral-600 uppercase">
        {title || L.summary}
      </h2>
      <ul className="space-y-3 text-sm">
        {data.lines.map((l, i) => (
          <li key={`${l.variantId}-${i}`} className="flex items-center gap-3">
            {/* Same rule as the checkout summary: with images on, every line keeps its slot. */}
            {theme.summaryImages && <LineThumb src={l.imageUrl} size={48} gift={l.gift} />}
            <span className="min-w-0 flex-1">
              <span className="text-neutral-600">{l.quantity} ×</span> {l.title}
              {l.variantTitle && <span className="block text-xs text-neutral-600">{l.variantTitle}</span>}
              {visibleProperties(l).map((p) => (
                <span key={p.name} className="block text-xs break-words text-neutral-600">
                  {p.name} : {/^https?:\/\//.test(p.value) ? p.value.split("/").pop() : p.value}
                </span>
              ))}
              {l.gift && (
                <span className="mt-0.5 flex items-center gap-1 text-xs font-medium text-emerald-800">
                  <Gift className="h-3.5 w-3.5" aria-hidden />
                  {L.giftFree}
                </span>
              )}
            </span>
            {l.gift ? (
              <span className="text-right">
                {l.compareAtCents ? <span className="block text-xs text-neutral-600 line-through">{money(l.compareAtCents)}</span> : null}
                <span className="font-medium">{L.free}</span>
              </span>
            ) : (
              <span className="font-medium">{money(l.unitPriceCents * l.quantity)}</span>
            )}
          </li>
        ))}
      </ul>
      <dl className="mt-4 space-y-1.5 border-t border-neutral-200 pt-3 text-sm">
        <Row k={L.subtotal} v={money(subtotal)} />
        {data.discountCents > 0 && <Row k={data.discountCode ? `${L.discount} · ${data.discountCode}` : L.discount} v={`−${money(data.discountCents)}`} />}
        {data.addOnItems?.length
          ? data.addOnItems.map((x, i) => <Row key={`addon-${i}`} k={x.title} v={money(x.priceCents)} />)
          : data.addOnsCents - protectionCents > 0 && <Row k={L.addonsTotal} v={money(data.addOnsCents - protectionCents)} />}
        {protectionCents > 0 && <Row k={L.protectionRow} v={money(protectionCents)} />}
        {needsShipping && <Row k={L.shipping} v={data.shippingCents ? money(data.shippingCents) : L.free} />}
        <div className="flex justify-between pt-2 text-base font-semibold">
          <dt>{L.total}</dt>
          <dd>{money(total)}</dd>
        </div>
      </dl>
      {localTotal && <p className="mt-1 text-right text-xs text-neutral-600">{L.localEstimate(localTotal.amount, data.currency)}</p>}
    </section>
  );

  // Wide screens: order summary in a sticky right column (like Shopify's thank-you page);
  // small screens: one column in the merchant's block order. `order` keeps that order while
  // the left column is `display: contents` (one flex column); the columns take over at @4xl.
  const summaryIndex = blocks.findIndex((b) => b.type === "ty_summary");
  const twoCols = summaryIndex >= 0;
  // Flex `order`s are doubled so the protection card can sit between two blocks (odd slot).
  const TAIL = (blocks.length + 1) * 2;
  const confirmationIndex = blocks.findIndex((b) => b.type === "ty_confirmation");
  const confirmationBlock = confirmationIndex >= 0 ? blocks[confirmationIndex] : null;
  const shown = (b: Block) => isFixedThankYou(b.type) || !isEmptyInLive(b, ctx, now);
  const afterConfirmation = confirmationIndex >= 0 ? blocks.slice(confirmationIndex + 1).find(shown) : undefined;
  const protectionOrder = (afterConfirmation?.type === "upsell" ? blocks.indexOf(afterConfirmation) : Math.max(0, confirmationIndex)) * 2 + 1;
  return (
    <div lang={theme.language} className="wc-checkout @container/wc-page min-h-full overflow-x-clip" style={themeVars(theme)}>
      <StoreHeader theme={theme} homeUrl={data.continueUrl} />
      {ctx.upsell && (
        // Always mounted (the declined card is gone by then); the zero-width space alternates so
        // a second "Offer declined" in a row is announced again.
        <p role="status" className="sr-only">
          {declines.count ? `${L.upsellDeclined}${declines.count % 2 ? "" : "\u200b"}` : ""}
        </p>
      )}
      <main
        className={`mx-auto flex flex-col gap-4 px-5 py-8 ${
          twoCols ? "max-w-[640px] @4xl:grid @4xl:max-w-[1080px] @4xl:grid-cols-[minmax(0,1fr)_minmax(0,400px)] @4xl:items-start @4xl:gap-10 @4xl:px-8 @4xl:py-10" : "max-w-[640px]"
        }`}
      >
        {twoCols && (
          // Small screens: a collapsed "Show order summary · total" bar first; wide screens: the
          // summary, always open, in the sticky right column (unchanged). It comes first in the
          // DOM (not CSS-reordered) so the toggle is also first in tab / reading order on mobile;
          // on wide screens the grid places it on the right, and it holds no other focusable.
          <div className="min-w-0 @4xl:sticky @4xl:top-6 @4xl:col-start-2 @4xl:row-start-1">
            <button
              type="button"
              onClick={() => setSummaryOpen((o) => !o)}
              aria-expanded={summaryOpen}
              aria-controls="ty-summary-panel"
              className="flex min-h-14 w-full items-center justify-between gap-3 rounded-[var(--radius)] border border-neutral-200 bg-white px-5 py-3 text-sm @4xl:hidden"
              style={{ background: theme.summaryBackground || undefined }}
            >
              <span className="flex items-center gap-1.5 font-medium text-[var(--text)]">
                {summaryOpen ? L.hideSummary : L.showSummary}
                <ChevronDown className={`h-4 w-4 transition-transform ${summaryOpen ? "rotate-180" : ""}`} aria-hidden />
              </span>
              <span className="text-base font-semibold">{money(total)}</span>
            </button>
            {/* Builder: the selected summary block stays visible on the mobile canvas. */}
            <div id="ty-summary-panel" className={summaryOpen || preview?.selectedBlockId === blocks[summaryIndex].id ? "mt-2 @4xl:mt-0" : "hidden @4xl:block"}>
              {wrap(blocks[summaryIndex], summary((blocks[summaryIndex] as BlockOf<"ty_summary">).props.title))}
            </div>
          </div>
        )}
        <div className={twoCols ? "contents @4xl:col-start-1 @4xl:row-start-1 @4xl:flex @4xl:min-w-0 @4xl:flex-col @4xl:gap-4" : "contents"}>
          {blocks.map((b, i) => {
            let node: ReactNode;
            switch (b.type) {
              case "ty_confirmation":
                node = wrap(b, confirmation(b.props.title));
                break;
              case "ty_details":
                node = wrap(b, details(b.props.title));
                break;
              case "ty_summary":
                return null;
              default:
                node = isEmptyInLive(b, ctx, now) ? null : wrap(b, <ContentBlock block={b} ctx={ctx} />);
            }
            return node ? (
              <div key={b.id} style={{ order: i * 2 }} className="min-w-0">
                {node}
              </div>
            ) : null;
          })}
          {protectionCard && (
            <div
              style={{ order: protectionOrder }}
              className={`min-w-0 ${preview?.onSelectBlock && confirmationBlock ? "-mx-2 cursor-pointer rounded-lg px-2 hover:outline-1 hover:outline-neutral-300 hover:outline-dashed" : ""}`}
              onClick={preview?.onSelectBlock && confirmationBlock ? () => preview.onSelectBlock!(confirmationBlock.id) : undefined}
            >
              {confirmationBlock ? <StyledBlock style={confirmationBlock.style.spacing === "default" ? { ...confirmationBlock.style, spacing: "none" as const } : confirmationBlock.style}>{protectionCard}</StyledBlock> : protectionCard}
            </div>
          )}

          {theme.withdrawalNotice && (
            <p style={{ order: TAIL }} className="pt-2 text-xs leading-relaxed text-neutral-600">
              {L.withdrawal}
              {/* "Contact us": a real way to reach the store, else no sentence pointing nowhere. */}
              {supportHref && (
                <>
                  {" "}
                  <a
                    href={supportHref}
                    target={supportHref.startsWith("mailto:") ? undefined : "_blank"}
                    rel="noreferrer"
                    className="underline underline-offset-2 hover:no-underline"
                  >
                    {L.withdrawalContact}
                  </a>
                </>
              )}
            </p>
          )}
          {!preview && (
            <p style={{ order: TAIL }} className="text-xs leading-relaxed text-neutral-600">
              {L.statementNote}
            </p>
          )}

          {data.continueUrl && (
            <a
              href={data.continueUrl}
              style={{ order: TAIL }}
              className={`mt-2 flex min-h-12 w-full items-center justify-center rounded-[var(--btn-radius)] px-5 py-4 font-semibold transition ${
                offerPending
                  ? "border border-[var(--border)] bg-white text-[var(--text)] hover:bg-neutral-50"
                  : "bg-[image:var(--accent-bg)] text-[var(--accent-fg)] shadow-[var(--btn-shadow)] hover:brightness-110"
              }`}
            >
              {L.continueShopping}
            </a>
          )}
          <div style={{ order: TAIL }}>
            <Footer theme={theme} languageSwitcher={!!sessionId} />
          </div>
        </div>
      </main>
    </div>
  );
}

/** Ordered → shipped → delivered, with dates when the shipping rate gives a delay. */
function Timeline({
  L,
  start,
  estimate,
  fmt,
}: {
  L: Labels;
  start: Date | null;
  estimate: { min: number; max: number; business: boolean } | null;
  fmt: (d: Date) => string;
}) {
  const steps = [
    {
      icon: Check,
      title: L.stepOrdered,
      date: start ? fmt(start) : null,
      done: true,
    },
    {
      icon: Package,
      title: L.stepShipped,
      date: start && estimate ? fmt(addDays(start, Math.min(1, estimate.min), estimate.business)) : null,
      done: false,
    },
    {
      icon: Home,
      title: L.stepDelivered,
      date: start && estimate ? `${fmt(addDays(start, estimate.min, estimate.business))} – ${fmt(addDays(start, estimate.max, estimate.business))}` : null,
      done: false,
    },
  ];
  return (
    <ol className="mt-5 grid grid-cols-3">
      {steps.map((s, i) => (
        <li key={i} className="relative flex flex-col items-center text-center" aria-current={i === 0 ? "step" : undefined}>
          {i > 0 && <span className="absolute top-4 right-1/2 h-0.5 w-full bg-neutral-200" aria-hidden />}
          <span
            className={`relative z-10 flex h-8 w-8 items-center justify-center rounded-full ${s.done ? "bg-[image:var(--accent-bg)] text-[var(--accent-fg)]" : "border-2 border-neutral-300 bg-white text-neutral-600"}`}
          >
            <s.icon className="h-4 w-4" aria-hidden />
          </span>
          <span className="mt-2 text-xs font-semibold">{s.title}</span>
          {/* A date only when known; otherwise the step's status (never an empty slot). */}
          <span className="text-[11px] text-neutral-600">{s.date ?? (s.done ? L.stepDone : L.stepUpcoming)}</span>
        </li>
      ))}
    </ol>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-neutral-700">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
