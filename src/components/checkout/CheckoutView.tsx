"use client";

import {
  Suspense,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Check, ChevronDown, ChevronRight, Gift, Info, Lock, Minus, Package, Plus, ShieldCheck, Tag, TrendingDown, UserRound, X } from "lucide-react";
import type { Block, BlockOf, BlockType, Layout, Theme } from "@/lib/layout";
import { cartShippable, expressMethodsShown, headerModeOf, offeredWalletsFor, type ExpressWallet } from "@/lib/layout";
import { fieldBorderColor, HEADER_PLACEHOLDER_ON_DARK } from "@/lib/contrast";
import {
  breakDeal,
  computeTotals,
  formatMoney,
  ratesForCountry,
  tierThreshold,
  type CartLine,
  type QuantityBreak,
  type RateInput,
  type Totals,
  visibleProperties,
} from "@/lib/pricing";
import {
  ContentBlock,
  isEmptyInLive,
  offeredPaymentLogos,
  PaymentHeaderLogos,
  headerLogosBlockId,
  Placeholder,
  Recommendations,
  StyledBlock,
  type ContentContext,
} from "./blocks";
import { countryName, errorText, labelsFor, localeOf, type Labels } from "./i18n";
import { checkoutCountries, pickFirstCountry } from "@/lib/first-country";
import { localizeDeliveryTime, localizeLayout, localizeTheme } from "./localize";
import { suggestEmail } from "./emailSuggest";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { clearSavedBuyer, maskEmail, parseSavedBuyer, readSavedBuyerRaw, subscribeSavedBuyer, writeSavedBuyer } from "./savedBuyer";
import { localEstimate, type LocalRates } from "./localCurrency";
import { ReturningBuyerCode, type CodeBuyer } from "./ReturningBuyerCode";
import { sampleRecommendations, visibleRecommendations, type RecommendationView } from "./recommendations";
import { AddressAutocomplete } from "./AddressAutocomplete";
import { SafeImg } from "./SafeImg";
import { PickupPicker, pickupPayload, type PickupPointView } from "./PickupPicker";
import { cartProductsOf } from "@/lib/reviews-import";
import {
  ExpressCheckout,
  ExpressPreview,
  StripeExpressPlaceholder,
  ExpressUnavailable,
  PaymentPanel,
  PaymentPreview,
  PaymentSkeleton,
  paypalStaysChosen,
  preparedFromBody,
  samePrepared,
  type ConfirmResult,
  type PaidCheck,
  type PanelLock,
  type Prepared,
} from "./Payment";
import dynamic from "next/dynamic";
import type { WalletBuyer } from "./StripePanel";
import { stripeExpressAny } from "./stripe-options";

// Stripe's side (its React components, then Stripe.js itself) is only loaded in the browser when the
// session really pays with Stripe: a Whop checkout never downloads any of it.
const StripePanel = dynamic(() => import("./StripePanel").then((m) => m.StripePanel), {
  ssr: false,
  loading: () => (
    <div className="min-h-[264px] rounded-[var(--radius)] border border-neutral-200 bg-white p-3" aria-busy>
      <PaymentSkeleton />
    </div>
  ),
});
const StripeExpress = dynamic(() => import("./StripePanel").then((m) => m.StripeExpress), { ssr: false, loading: () => <StripeExpressPlaceholder /> });

export type AddOnView = {
  id: string;
  title: string;
  description: string | null;
  priceCents: number;
  imageUrl: string | null;
};

export type CheckoutMode =
  | {
      kind: "preview";
      selectedBlockId?: string | null;
      onSelectBlock?: (id: string) => void;
    }
  /** paymentFailed: back from a Stripe redirect (3-D Secure, bank page) that failed: said in the payment section. */
  | { kind: "live"; sessionId: string; testMode: boolean; saveCard?: boolean; paymentFailed?: boolean };

type Props = {
  theme: Theme;
  layout: Layout;
  currency: string;
  lines: CartLine[];
  rates: RateInput[];
  addOns: AddOnView[];
  hasDiscounts: boolean;
  mode: CheckoutMode;
  initialEmail?: string | null;
  /** ISO country guessed from the visitor's IP (Vercel geolocation header). */
  initialCountry?: string | null;
  /** The Shopify cart ("https://shop.example/cart"): breadcrumb and "Back to cart" link. */
  cartUrl?: string | null;
  /** Order bumps whose display rules match the cart, before the first quote (server-side). */
  initialEligibleAddOnIds?: string[] | null;
  /**
   * "Complétez votre commande": the block's products priced live by Shopify (server-side).
   * Null/empty in live mode hides the block (Shopify unreachable or nothing available). Live, a
   * promise (streamed by the server page: Shopify's answer never holds the page), shown once it lands.
   */
  recommendations?: RecommendationView[] | null | Promise<RecommendationView[] | null>;
  /** Checkout currency → local currency multipliers (ECB), for the "≈ 52,30 CHF" line. */
  localRates?: LocalRates | null;
  /**
   * The store's main market (most frequent shipping country of its orders, else of its
   * rates): pre-selected when the visitor's IP country isn't known or isn't served.
   */
  primaryCountry?: string | null;
  /** The browser's locale country (Accept-Language "de-DE" → "DE") when shipped to: pre-selected before the main market. */
  localeCountry?: string | null;
  /** "Déjà client ? Recevez un code par e-mail" is on for the store (live checkout only). */
  returningCode?: boolean;
  /**
   * Live: the express PayPal button shows from the first paint (Whop pays, the merchant allows it,
   * Whop's last word isn't "off"); the first /prepare's answer confirms or hides it.
   */
  initialPaypal?: boolean;
  /** Live: the processor the first /prepare is expected to use (its express row is drawn meanwhile). */
  initialProvider?: "whop" | "stripe" | null;
  /** Live, paying with Stripe: Stripe.js is loaded while the first /prepare runs. */
  stripeWarm?: { publishableKey: string; stripeAccount: string } | null;
};

type Address = {
  firstName: string;
  lastName: string;
  address1: string;
  address2: string;
  city: string;
  province: string;
  zip: string;
  countryCode: string;
  phone: string;
};

type QuoteState = {
  totals: Totals;
  rates: (RateInput & { effectiveCents: number })[];
  shippingRateId: string | null;
  discountError: string | null;
  appliedCode: string | null;
  /** Server quote only: priced lines, bumps whose rules match, quantity-break progress. */
  lines?: CartLine[];
  eligibleAddOnIds?: string[];
  volumeBreak?: { current: QuantityBreak | null; next: QuantityBreak | null; missing?: number | null };
  /** Shopify automatic discounts honored on this cart (their names). */
  automaticDiscount?: { cents: number; titles: string[] } | null;
  /** Charged in the buyer's currency (store option): exact amount Whop will charge. */
  charge?: { currency: string; totalCents: number; rate: number } | null;
  /** Free gifts earned / next to earn (quantity breaks v2). */
  gifts?: { earned: { title: string; variantId: string }[]; next: { title: string; missingQty: number | null; missingCents: number | null } | null };
  /** Shipping protection offered for this cart (server price). */
  protection?: { selected: boolean; priceCents: number } | null;
  /** The cart is fixed as a whole (an app's prices, gifts or bundles): nothing can be added. */
  cartLocked?: boolean;
  /** The Shopify cart's automatic discount stopped applying (the buyer changed the lines). */
  automaticDiscountLost?: string[];
};

/** Per line, as the server allows (checkout.ts MAX_LINE_QTY). */
const MAX_LINE_QTY = 20;
const QTY_DEBOUNCE_MS = 400;

/** Highest quantity the buyer may pick for a line: stock when tracked, 20 at most. */
function maxQty(l: CartLine) {
  return l.inventory != null && l.inventory > 0 ? Math.min(MAX_LINE_QTY, l.inventory) : MAX_LINE_QTY;
}

const qtyMap = (lines: CartLine[]) => Object.fromEntries(lines.map((l) => [l.variantId, l.quantity]));
const qtyKey = (m: Record<string, number>) =>
  Object.keys(m)
    .sort()
    .map((k) => `${k}x${m[k]}`)
    .join(",");

function fontStack(font: string) {
  return font === "System"
    ? "system-ui, -apple-system, Segoe UI, sans-serif"
    : `"${font}", system-ui, sans-serif`;
}

export function themeVars(theme: Theme): CSSProperties {
  const body = fontStack(theme.font);
  return {
    "--accent": theme.accentColor,
    "--accent-bg": theme.accentColor2
      ? `linear-gradient(135deg, ${theme.accentColor}, ${theme.accentColor2})`
      : `linear-gradient(${theme.accentColor}, ${theme.accentColor})`,
    "--accent-fg": readableOn(theme.accentColor),
    "--radius": `${theme.radius}px`,
    "--btn-radius":
      theme.buttonShape === "pill"
        ? "999px"
        : theme.buttonShape === "square"
          ? "0px"
          : `${theme.radius}px`,
    "--btn-shadow": theme.buttonShadow
      ? `0 10px 24px -10px ${theme.accentColor}b3, inset 0 1px 0 rgba(255,255,255,.18)`
      : "none",
    "--text": theme.textColor,
    // 70%: keeps secondary text above 4.5:1 on white for the default text colors
    "--muted": `color-mix(in srgb, ${theme.textColor} 70%, white)`,
    // Focus ring: the brand color when it stands out on white (3:1), else the text color.
    "--focus": contrastOnWhite(theme.accentColor) >= 3 ? theme.accentColor : theme.textColor,
    "--border": theme.borderColor,
    // Form fields: the border darkened to 3:1 against the form background when needed (WCAG 1.4.11).
    "--field-border": fieldBorderColor(theme),
    "--heading-font":
      theme.headingFont === "same" ? body : fontStack(theme.headingFont),
    fontFamily: body,
    fontSize: { sm: "14px", md: "15px", lg: "16px" }[theme.fontScale],
    color: theme.textColor,
    background: theme.pageBackground || "#ffffff",
  } as CSSProperties;
}

function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

function contrastOnWhite(hex: string) {
  return /^#[0-9a-f]{6}$/i.test(hex) ? 1.05 / (luminance(hex) + 0.05) : 21;
}

function readableOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6
    ? "#111111"
    : "#ffffff";
}

/** Height cap of a banner shown in its own proportions (same 240 px as the fixed-height maximum). */
export const BANNER_MAX_HEIGHT = "min(240px, 35vh)";

export function StoreHeader({ theme, homeUrl = null }: { theme: Theme; homeUrl?: string | null }) {
  const justify = {
    left: "justify-start",
    center: "justify-center",
    right: "justify-end",
  }[theme.headerAlign];
  const mode = headerModeOf(theme);
  const border = theme.headerBorder ? "border-b border-[var(--border)]" : "";
  const nameColor = readableOn(theme.headerBackground) === "#ffffff" ? "#fff" : undefined;
  const nameHeader = (showLogo: boolean) => {
    // Without a logo the store name is the wordmark, even when "show name" is off:
    // an empty header makes buyers wonder where they are paying.
    const showName = !!theme.storeName && (mode === "name" || theme.showStoreName || !showLogo);
    return (
      <header
        className={border}
        style={{ background: theme.headerBackground }}
      >
        <div
          className={`mx-auto flex min-h-16 max-w-[1100px] items-center gap-3 px-5 py-3 ${justify}`}
        >
          {showLogo && (
            <SafeImg
              src={theme.logoUrl}
              alt={theme.storeName}
              style={{ height: theme.logoHeight }}
              className="w-auto max-w-[60vw] object-contain"
              // Logo gone (deleted, hotlink-protected): the store name instead of a broken image.
              fallback={showName ? null : <span className="font-[family-name:var(--heading-font)] text-xl font-semibold tracking-tight" style={{ color: nameColor }}>{theme.storeName || "Ma boutique"}</span>}
            />
          )}
          {showName && (
            <span
              className="font-[family-name:var(--heading-font)] text-xl font-semibold tracking-tight"
              style={{ color: nameColor }}
            >
              {theme.storeName}
            </span>
          )}
          {!showLogo && !theme.storeName && (
            // Placeholder wordmark: readable on dark headers too (lib/contrast.ts checks both).
            <span className="text-xl font-semibold text-[var(--muted)]" style={nameColor ? { color: HEADER_PLACEHOLDER_ON_DARK } : undefined}>
              Ma boutique
            </span>
          )}
        </div>
      </header>
    );
  };
  if (mode !== "banner") return nameHeader(mode === "logo" && !!theme.logoUrl);
  // Full-width banner: its box is sized before the image loads (fixed height, or the image's
  // own proportions measured in the builder), so nothing below it moves. In proportions mode the
  // height is capped (a square image would otherwise make a header as tall as the page is wide):
  // beyond the cap, the image is cropped ("cover") or letterboxed ("contain").
  const ratio = theme.bannerAuto && theme.bannerRatio ? theme.bannerRatio : null;
  const alt = theme.storeName || "Ma boutique";
  const image = (
    <SafeImg
      src={theme.bannerUrl}
      alt={alt}
      className={`block h-full w-full ${theme.bannerFit === "contain" ? "object-contain" : "object-cover"}`}
      // Image gone (deleted, hotlink-protected): the store name instead of an empty band.
      fallback={
        <span
          className="flex h-full items-center justify-center font-[family-name:var(--heading-font)] text-xl font-semibold tracking-tight"
          style={{ color: readableOn(theme.bannerBackground || theme.headerBackground) === "#ffffff" ? "#fff" : undefined }}
        >
          {alt}
        </span>
      }
    />
  );
  return (
    <header
      className={border}
      style={{ background: theme.bannerBackground || theme.headerBackground }}
      data-header="banner"
    >
      <div
        // Phones: no height cap, the image spans the full width in its own proportions (globals.css).
        className={`relative w-full overflow-hidden ${ratio ? "wc-banner-capped" : ""}`}
        style={ratio ? ({ aspectRatio: String(ratio), "--wc-banner-max": BANNER_MAX_HEIGHT } as CSSProperties) : { height: theme.bannerHeight }}
      >
        {theme.bannerLink && homeUrl ? (
          <a href={homeUrl} className="block h-full w-full focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-[var(--accent)]">
            {image}
          </a>
        ) : (
          image
        )}
      </div>
    </header>
  );
}

/** The shop's home page from its cart URL (https://shop.com/cart → https://shop.com/), or null. */
function storeHomeUrl(cartUrl: string | null | undefined): string | null {
  if (!cartUrl || !URL.canParse(cartUrl)) return null;
  const u = new URL(cartUrl);
  return /^https?:$/.test(u.protocol) ? `${u.origin}/` : null;
}

/** Checkout / thank-you footer: trust line, legal links and (live pages) the language picker. */
export function Footer({ theme, languageSwitcher = false }: { theme: Theme; languageSwitcher?: boolean }) {
  if (!theme.trustLine && theme.policyLinks.length === 0 && !languageSwitcher) return null;
  return (
    <footer className="mt-8 border-t border-neutral-200 pt-4 text-xs text-neutral-600">
      {theme.trustLine && (
        // Rendered exactly as the merchant wrote it (no forced case).
        <p className="flex items-start gap-1.5 leading-relaxed normal-case">
          <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span>{theme.trustLine}</span>
        </p>
      )}
      {(theme.policyLinks.length > 0 || languageSwitcher) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-4">
          {theme.policyLinks.length > 0 && (
            <nav className="flex flex-wrap gap-x-4">
              {theme.policyLinks.map((l, i) => (
                <a
                  key={i}
                  href={l.url || undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-11 items-center underline underline-offset-2"
                >
                  {l.label}
                </a>
              ))}
            </nav>
          )}
          {languageSwitcher && (
            <div className="ml-auto">
              <LanguageSwitcher lang={theme.language} label={labelsFor(theme.language).language} />
            </div>
          )}
        </div>
      )}
    </footer>
  );
}

const EMPTY_ADDRESS: Address = {
  firstName: "",
  lastName: "",
  address1: "",
  address2: "",
  city: "",
  province: "",
  zip: "",
  countryCode: "",
  phone: "",
};


/* ---------- page structure rules ---------- */

/**
 * Reassurance widgets. On desktop they live in the sticky summary column (below the
 * order summary); on mobile they come right after the payment step. Either way they
 * never push the payment form down the page.
 */
const TRUST_WIDGETS: ReadonlySet<BlockType> = new Set<BlockType>([
  "reviews",
  "testimonial",
  "rating",
  "trust_badges",
  "guarantee",
  "secure_badge",
  "payment_icons",
  "benefits",
  "why_us",
  "stats",
  "comparison",
  "logos",
  "value_props",
  "support",
  "delivery_estimate",
]);
/** Short banners that may stay above the payment (at most MAX_COMPACT_BEFORE_PAY). */
const COMPACT_WIDGETS: ReadonlySet<BlockType> = new Set<BlockType>([
  "announcement",
  "countdown",
  "free_shipping_bar",
  "low_stock",
]);
const MAX_COMPACT_BEFORE_PAY = 2;
/** Countries whose postal addresses use a state / province line. */
const NEEDS_PROVINCE = new Set(["US", "CA", "AU", "IT", "ES", "MX", "BR", "JP", "IE", "AE", "HK"]);
/**
 * The lock notes shown while a PayPal payment is pending (see priceLocked): every delivery and
 * contact field is read-only then (the order is made from what PayPal was opened with), and each
 * read-only input points at its section's note (aria-describedby).
 */
const LOCK_NOTE_CONTACT_ID = "wc-lock-contact";
const LOCK_NOTE_DELIVERY_ID = "wc-lock-delivery";
/** An aria-describedby list: the ids given, without the empty ones (undefined when none). */
function describedBy(...ids: (string | null | undefined | false)[]): string | undefined {
  return ids.filter(Boolean).join(" ") || undefined;
}
/** Inputs that must be filled before paying: they keep their place in the form. */
const FORM_INPUT_BLOCKS: ReadonlySet<BlockType> = new Set<BlockType>(["order_note"]);

/**
 * Wallet buttons (Apple Pay / Google Pay) can show: express checkout on in the theme, and the
 * express block neither hidden nor turned off (then no wallet logo is claimed either). Pure.
 */
export function expressWalletsOn(expressCheckout: boolean, blocks: readonly Block[]): boolean {
  const express = blocks.find((b) => b.type === "express");
  return expressCheckout && !express?.hidden && !(express?.type === "express" && !express.props.enabled);
}

/** Splits the checkout layout into the main column, the reassurance column and the tail. */
export function arrangeCheckout(blocks: Block[]) {
  // Cross-sell cards have a fixed spot (under the summary / above the payment), whatever their placement.
  const recommendations = blocks.find((b): b is BlockOf<"recommendations"> => b.type === "recommendations" && !b.hidden) ?? null;
  const visible = blocks.filter((b) => !b.hidden && b.type !== "recommendations");
  const form = visible.filter((b) => b.placement === "form" || isSection(b));
  const payAt = form.findIndex((b) => b.type === "payment");
  const main: Block[] = [];
  const side: Block[] = [];
  const after: Block[] = [];
  let compact = 0;
  form.forEach((b, i) => {
    if (isSection(b)) main.push(b);
    else if (TRUST_WIDGETS.has(b.type)) side.push(b);
    else if (payAt >= 0 && i > payAt) after.push(b);
    else if (COMPACT_WIDGETS.has(b.type) && compact < MAX_COMPACT_BEFORE_PAY) {
      compact += 1;
      main.push(b);
    } else if (FORM_INPUT_BLOCKS.has(b.type)) main.push(b);
    else after.push(b);
  });
  const summary = visible.filter((b) => b.placement === "summary" && !isSection(b));
  return { main, side, after, summary, recommendations };
}

/**
 * Where a checkout block really shows, as arranged by `arrangeCheckout` (builder hints):
 * form column above the payment, under the payment, summary column (placement or
 * reassurance widget), or the fixed cross-sell spot.
 */
export type CheckoutZone = "form" | "after" | "summary" | "reassurance" | "recommendations";

function zoneIn(a: ReturnType<typeof arrangeCheckout>, id: string): CheckoutZone | null {
  if (a.recommendations?.id === id) return "recommendations";
  if (a.main.some((b) => b.id === id)) return "form";
  if (a.after.some((b) => b.id === id)) return "after";
  if (a.side.some((b) => b.id === id)) return "reassurance";
  if (a.summary.some((b) => b.id === id)) return "summary";
  return null;
}

/** Rendered zone of every block id; a hidden block gets the zone it would take once shown. */
export function checkoutZones(blocks: Block[]): Record<string, CheckoutZone> {
  const shown = arrangeCheckout(blocks);
  const out: Record<string, CheckoutZone> = {};
  for (const b of blocks) {
    if (b.type === "recommendations") {
      out[b.id] = "recommendations";
      continue;
    }
    const a = b.hidden ? arrangeCheckout(blocks.map((x) => (x.id === b.id ? ({ ...x, hidden: false } as Block) : x))) : shown;
    out[b.id] = zoneIn(a, b.id) ?? (b.placement === "summary" ? "summary" : "form");
  }
  return out;
}

/** Zone the block would take with this placement (builder: label of each "Emplacement" choice). */
export function zoneWithPlacement(blocks: Block[], id: string, placement: Block["placement"]): CheckoutZone | null {
  const next = blocks.map((x) => (x.id === id ? ({ ...x, placement, hidden: false } as Block) : x));
  return checkoutZones(next)[id] ?? null;
}

/** Reassurance widgets always show in the summary column (after the payment on mobile). */
export function isReassuranceWidget(type: BlockType): boolean {
  return TRUST_WIDGETS.has(type);
}

/**
 * Why a form-column block shows under the payment although it sits above it in the list:
 * "compact_limit" (more than MAX_COMPACT_BEFORE_PAY short banners) or "below_payment"
 * (content blocks never push the payment down). null when it shows where it is placed.
 */
export function belowPaymentReason(blocks: Block[], id: string): "compact_limit" | "below_payment" | null {
  const block = blocks.find((b) => b.id === id);
  if (!block || block.placement !== "form" || isSection(block) || TRUST_WIDGETS.has(block.type)) return null;
  const list = blocks.filter((b) => b.type !== "recommendations" && (b.id === id || !b.hidden) && (b.placement === "form" || isSection(b)));
  const payAt = list.findIndex((b) => b.type === "payment");
  if (payAt < 0 || list.findIndex((b) => b.id === id) > payAt) return null;
  if (checkoutZones(blocks)[id] !== "after") return null;
  return COMPACT_WIDGETS.has(block.type) ? "compact_limit" : "below_payment";
}

/** Short banners allowed above the payment (builder wording). */
export const COMPACT_BEFORE_PAY_MAX = MAX_COMPACT_BEFORE_PAY;

/** The PayPal state an ended PayPal choice goes back to (see paypalChoiceReset). */
export type PaypalChoiceReset = { mode: false; prepared: null; doneSig: null; autoSubmit: false; notice: null; error?: null };

/**
 * Ending the PayPal choice, whichever way ("Pay another way", or PayPal withdrawn and dropped once
 * the panel unlocks): the same reset, so a later PayPal click waits for a fresh PayPal-only
 * checkout (its prepare's signature forgotten too) and never auto-submits a stale embed. Only
 * "Pay another way" clears the PayPal message; a withdrawal keeps its "PayPal isn't available". Pure.
 */
/** The page's silent /prepare retries stop this long after its first attempt (then « réessayer »). */
export const PREPARE_RETRY_MAX_MS = 30_000;

/**
 * Whether a failed /prepare is retried silently: a server error (5xx), except Whop unavailable with
 * no switch possible (503 whop_unavailable: the server already waited its longest for it). Pure.
 */
export function prepareRetryable(status: number, code: unknown): boolean {
  return status >= 500 && code !== "whop_unavailable";
}

export function paypalChoiceReset({ keepError }: { keepError: boolean }): PaypalChoiceReset {
  const reset = { mode: false, prepared: null, doneSig: null, autoSubmit: false, notice: null } as const;
  return keepError ? reset : { ...reset, error: null };
}

/* ---------- validation ---------- */

type FieldKey = "email" | "countryCode" | "firstName" | "lastName" | "address1" | "zip" | "city" | "pickup" | "terms";
const FIELD_ORDER: FieldKey[] = ["email", "countryCode", "firstName", "lastName", "address1", "zip", "city", "pickup", "terms"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DOM_TOM = /^97\d{3}$/;
const ZIP_RE: Record<string, RegExp> = {
  FR: /^\d{5}$/,
  MC: /^980\d{2}$/,
  DE: /^\d{5}$/,
  ES: /^\d{5}$/,
  IT: /^\d{5}$/,
  BE: /^\d{4}$/,
  CH: /^\d{4}$/,
  AT: /^\d{4}$/,
  LU: /^(L-?)?\d{4}$/i,
  NL: /^\d{4}\s?[a-z]{2}$/i,
  PT: /^\d{4}-?\d{3}$/,
  DK: /^\d{4}$/,
  NO: /^\d{4}$/,
  SE: /^\d{3}\s?\d{2}$/,
  FI: /^\d{5}$/,
  PL: /^\d{2}-?\d{3}$/,
  US: /^\d{5}(-\d{4})?$/,
  CA: /^[a-z]\d[a-z]\s?\d[a-z]\d$/i,
  GB: /^[a-z]{1,2}\d[a-z\d]?\s?\d[a-z]{2}$/i,
  RE: DOM_TOM,
  GP: DOM_TOM,
  MQ: DOM_TOM,
  GF: DOM_TOM,
  YT: DOM_TOM,
};

/** Example postal code per country, shown in the "invalid postal code" message. */
const ZIP_EXAMPLE: Record<string, string> = {
  FR: "75001",
  BE: "1000",
  CH: "8001",
  DE: "10115",
  ES: "28001",
  IT: "00184",
  NL: "1011 AB",
  LU: "L-1111",
  AT: "1010",
  PT: "1000-001",
  GB: "SW1A 1AA",
  MC: "98000",
};

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

function fieldId(k: string) {
  return `wc-${k}`;
}

export function CheckoutView({
  theme: themeProp,
  layout: layoutProp,
  currency,
  lines,
  rates,
  addOns,
  hasDiscounts,
  mode,
  initialEmail,
  initialCountry,
  cartUrl,
  initialEligibleAddOnIds,
  recommendations: recommendationsProp,
  localRates,
  primaryCountry,
  localeCountry,
  returningCode,
  initialPaypal = false,
  initialProvider = null,
  stripeWarm = null,
}: Props) {
  // "Complétez votre commande" streamed by the server (a promise): none until it lands.
  const recommendationsStream = isPromise(recommendationsProp) ? recommendationsProp : null;
  const [streamedRecommendations, setStreamedRecommendations] = useState<RecommendationView[] | null>(null);
  const recommendations = recommendationsStream ? streamedRecommendations : (recommendationsProp as RecommendationView[] | null | undefined);
  // Paying with Stripe: its code (and Stripe.js itself) loads while the first /prepare runs.
  useEffect(() => {
    if (initialProvider !== "stripe") return;
    void import("./StripePanel")
      .then((m) => (stripeWarm ? m.stripeInstance(stripeWarm.publishableKey, stripeWarm.stripeAccount) : null))
      .catch(() => undefined);
    // Once per page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Buyer-language copy: merchant translations, then shipped French defaults translated.
  const theme = useMemo(() => localizeTheme(themeProp), [themeProp]);
  const layout = useMemo(() => localizeLayout(layoutProp, themeProp.language), [layoutProp, themeProp.language]);
  const L = labelsFor(theme.language);
  const router = useRouter();
  const live = mode.kind === "live";
  const money = useCallback(
    (c: number) =>
      formatMoney(c, currency, localeOf(theme.language)),
    [currency, theme.language],
  );

  // Shared with the early prepare (lib/early-prepare): its first quote must be this page's.
  const countries = useMemo(() => checkoutCountries(rates.map((r) => ({ countries: r.countries, active: !!r.active })), theme.language), [rates, theme.language]);

  const [email, setEmail] = useState(initialEmail ?? "");
  // "Did you mean …@gmail.com?" after the e-mail field is left with a likely typo.
  const [emailSuggestion, setEmailSuggestion] = useState<string | null>(null);
  const [marketing, setMarketing] = useState(false); // never pre-checked (GDPR)
  // "Remember my details on this device": opt-in, never pre-checked, local to this browser.
  const [remember, setRemember] = useState(false);
  const savedRaw = useSyncExternalStore(
    live ? subscribeSavedBuyer : noopSubscribe,
    () => (live ? readSavedBuyerRaw() : null),
    () => null,
  );
  const saved = useMemo(() => parseSavedBuyer(savedRaw), [savedRaw]);
  // The "Continue as …" prompt was answered (details used, or "Not me").
  const [savedAnswered, setSavedAnswered] = useState(false);
  const [savedNotice, setSavedNotice] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false); // never pre-checked (consumer law)
  const [address, setAddress] = useState<Address>(() => ({
    ...EMPTY_ADDRESS,
    // Visitor's country (from their IP) when we ship there, else their browser locale's
    // country (de-DE → Germany), else the store's main market, else the language's country —
    // never just the alphabetically first country. The early prepare picks it the same way.
    countryCode: pickFirstCountry(
      countries.map((c) => c.code),
      { initialCountry, localeCountry, primaryCountry, language: theme.language },
    ),
  }));
  const [rateId, setRateId] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  // A rejected code is dropped right away (so it never blocks payment); its message stays
  // only while the field still holds that code (typing or applying another one clears it).
  const [codeError, setCodeError] = useState<{ code: string; message: string; /** Informative, not a mistake (e.g. not combinable). */ notice?: boolean } | null>(null);
  const [mountedAt] = useState(() => Date.now());
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  // Shipping protection block (singleton): the buyer's choice, starting from the merchant's default.
  const protectionBlock = useMemo(
    () => layout.blocks.find((b): b is BlockOf<"shipping_protection"> => b.type === "shipping_protection" && !b.hidden) ?? null,
    [layout.blocks],
  );
  const [protectionOn, setProtectionOn] = useState(() => protectionBlock?.props.defaultOn ?? false);
  // The merchant flips "default on" in the builder: the preview follows.
  const protectionDefault = protectionBlock?.props.defaultOn ?? false;
  const [seenDefault, setSeenDefault] = useState(protectionDefault);
  if (seenDefault !== protectionDefault) {
    setSeenDefault(protectionDefault);
    setProtectionOn(protectionDefault);
  }
  // Sent with every quote / prepare / pay only when the block is on the page.
  const protection = protectionBlock ? protectionOn : undefined;
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [touched, setTouched] = useState<Partial<Record<FieldKey, boolean>>>({});
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [note, setNote] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  // The latest prepared checkout, for handlers of a render that may be stale (a Whop form clicked
  // right after the session switched to Stripe, or the reverse): never a confirm for the wrong one.
  const preparedRef = useRef<Prepared | null>(null);
  useEffect(() => {
    preparedRef.current = prepared;
  }, [prepared]);
  // Stripe.js couldn't load in this browser: the next prepare says so (the server switches to Whop).
  const stripeClientFailed = useRef(false);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  // Support reference of the last failed prepare (x-request-id), shown discreetly.
  const [prepareRef, setPrepareRef] = useState<string | null>(null);
  // Bumped by "Try again" to prepare the Whop checkout again without reloading.
  const [retryKey, setRetryKey] = useState(0);
  // The thank-you page (set below once known): a prepare answering "already paid" goes there.
  const thankYouUrlRef = useRef("#");
  // Express PayPal: whether Whop offers PayPal here (from prepare), the buyer chose it (the
  // payment panel then shows a PayPal-only checkout), and that checkout's own state.
  const [paypalOffered, setPaypalOffered] = useState(initialPaypal);
  const [paypalMode, setPaypalMode] = useState(false);
  const [paypalPrepared, setPaypalPrepared] = useState<Prepared | null>(null);
  // Whop refused PayPal for this session, by charged currency (a refusal may name only one; the
  // server remembers clear refusals per currency too): another currency can still offer it.
  const paypalRefused = useRef<Set<string>>(new Set());
  // The currency Whop charges for the current quote (the buyer's when the store charges in it).
  const chargeCurrency = (quote?.charge?.currency ?? currency).toUpperCase();
  const chargeCurrencyRef = useRef(chargeCurrency);
  useEffect(() => {
    chargeCurrencyRef.current = chargeCurrency;
  }, [chargeCurrency]);
  const [paypalPreparing, setPaypalPreparing] = useState(false);
  const [paypalError, setPaypalError] = useState<string | null>(null);
  // Set by the express click on a complete form: the panel submits PayPal once its checkout is ready.
  const [paypalAutoSubmit, setPaypalAutoSubmit] = useState(false);
  const [paypalNotice, setPaypalNotice] = useState<string | null>(null);
  // Bumped by the panel's "Try again" after the PayPal-only checkout failed to load.
  const [paypalRetryKey, setPaypalRetryKey] = useState(0);
  // The inputs of the last PayPal prepare that finished (see paypalPrepSig below).
  const [paypalDoneSig, setPaypalDoneSig] = useState<string | null>(null);
  /**
   * Applies a PayPal choice reset (see paypalChoiceReset): "Pay another way", and PayPal dropped
   * (withdrawn, refused) whether seen while rendering or by a prepare's answer (async).
   */
  function endPaypal(r: PaypalChoiceReset) {
    setPaypalMode(r.mode);
    setPaypalPrepared(r.prepared);
    setPaypalDoneSig(r.doneSig);
    setPaypalAutoSubmit(r.autoSubmit);
    setPaypalNotice(r.notice);
    if (r.error === null) setPaypalError(null);
  }
  // The payment panel submitting (or a PayPal payment possibly still going through): the express
  // buttons are locked meanwhile, so no second payment can start from them.
  const [panelLock, setPanelLock] = useState<PanelLock>(null);
  // A Stripe express payment being confirmed (its sheet open after our check): the Pay button waits.
  const [expressBusy, setExpressBusy] = useState(false);
  // For the prepares below (async): PayPal can't be dropped while the panel is locked.
  const panelLockRef = useRef<PanelLock>(null);
  useEffect(() => {
    panelLockRef.current = panelLock;
  }, [panelLock]);
  // A payment of this session still going through as the page loads (a second tab, a reload
  // during a PayPal window): the payment panel starts in its server wait (see inFlightAtLoad).
  const [inFlightAtLoad, setInFlightAtLoad] = useState(false);
  // Switch of processor at the Pay click or at a prepare (the answer carried another processor's
  // form, `switchedFrom`): said above the new form, cleared by the next Pay click.
  const [providerSwitched, setProviderSwitched] = useState(false);
  useEffect(() => {
    // Back from a failed Stripe redirect: that attempt is over (its failure is shown), never waited on.
    if (mode.kind !== "live" || mode.paymentFailed) return;
    let gone = false;
    const url = `/api/public/sessions/${mode.sessionId}/status`;
    void Promise.resolve()
      .then(() => fetch(url, { cache: "no-store" }))
      .then((res) => (res?.ok ? res.json() : null))
      .then((body) => {
        if (!gone && body?.paymentInFlight === true && body.status !== "PAID") setInFlightAtLoad(true);
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
    // Once per page (session).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode.kind === "live" ? mode.sessionId : null]);
  // A PayPal payment possibly going through (its window open or just closed): nothing that changes
  // the price can be edited meanwhile (country and address, shipping rate, protection, add-ons,
  // quantities, suggested products, discount code), or the total the buyer sees would no longer be
  // the one PayPal charges. The details confirm() saved are locked too (e-mail, name, phone, the
  // marketing and remember-me boxes): the pending payment goes with them.
  const priceLocked = panelLock === "pending";
  // Whop's PayPal checkout never got ready after an express click: no endless spinner on the button.
  // Not while a payment is in progress (a PayPal window may be open for longer than that).
  useEffect(() => {
    if (!paypalAutoSubmit || panelLock) return;
    const t = setTimeout(() => {
      setPaypalAutoSubmit(false);
      setPaypalError(L.paymentNotReady);
    }, 20_000);
    return () => clearTimeout(t);
  }, [paypalAutoSubmit, panelLock, L]);
  const [summaryOpen, setSummaryOpen] = useState(false);
  // Which copy of the promo form (mobile drawer "m-" / desktop column "d-") was submitted:
  // only that one shows and announces the error.
  const [promoSource, setPromoSource] = useState<string | null>(null);
  // Set on the buyer's first key press or click: failures may then interrupt (role=alert).
  const [interacted, setInteracted] = useState(false);

  /* ---------- quantities (editable in the summary) ---------- */

  // Lines as last confirmed by the server (price, stock); the page starts with the cart's.
  const [serverLines, setServerLines] = useState<CartLine[]>(() => lines.filter((l) => !l.gift));
  // Free gifts of the last server quote (quantity breaks v2).
  const [giftLines, setGiftLines] = useState<CartLine[]>([]);
  // What the buyer sees (optimistic): variant id → quantity (0 = removed).
  const [qty, setQty] = useState<Record<string, number>>(() => qtyMap(lines));
  // Quantities sent to the server (debounced); null until the buyer changes one.
  const [sentQty, setSentQty] = useState<Record<string, number> | null>(null);
  const [qtyError, setQtyError] = useState<string | null>(null);
  // Signature of the one quote allowed to keep the error (the re-quote of the rolled-back
  // quantities); any other successful quote clears it.
  const qtyErrorGuard = useRef<string | null>(null);
  // What to announce once the server confirms the change (never before: a rollback would
  // leave screen-reader users with a quantity that never happened).
  const [pendingAnnounce, setPendingAnnounce] = useState<{ variantId: string; title: string; added: boolean } | null>(null);
  const pendingQtyAnnounce = useRef(pendingAnnounce);
  useEffect(() => {
    pendingQtyAnnounce.current = pendingAnnounce;
  }, [pendingAnnounce]);
  const [qtyAnnouncement, setQtyAnnouncement] = useState("");
  const announceQty = useCallback((text: string) => {
    // Same words twice in a row would not be re-read: alternate an invisible suffix.
    setQtyAnnouncement((prev) => (prev === text ? `${text}\u200b` : text));
  }, []);
  const latestQty = useRef(qty);
  useEffect(() => {
    latestQty.current = qty;
  }, [qty]);
  const confirmedQty = useMemo(() => qtyMap(serverLines), [serverLines]);
  const confirmedKey = qtyKey(confirmedQty);
  const qtyTouched = sentQty != null;
  const displayLines = useMemo(() => {
    // A locked line keeps its own quantity (one variant can be on several locked lines: Kaching's paid + free).
    const shown = serverLines.map((l) => ({ ...l, quantity: l.locked ? l.quantity : (qty[l.variantId] ?? l.quantity) }));
    // Suggested products just added: shown at once, confirmed (priced) by the next quote.
    const known = new Set(serverLines.map((l) => l.variantId));
    for (const r of recommendations ?? []) {
      if (!known.has(r.variantId) && (qty[r.variantId] ?? 0) > 0) shown.push({ ...r, quantity: qty[r.variantId] });
    }
    return shown.filter((l) => l.quantity > 0);
  }, [serverLines, qty, recommendations]);
  const qtyPending =
    qtyKey(Object.fromEntries(Object.entries(qty).filter(([k, n]) => k in confirmedQty || n > 0))) !== confirmedKey;

  useEffect(() => {
    if (qtyKey(qty) === qtyKey(sentQty ?? confirmedQty)) return;
    // Buyer still clicking "+": one re-quote once they stop.
    const t = setTimeout(() => setSentQty(qty), QTY_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [qty, sentQty, confirmedQty]);

  function changeQty(l: CartLine, next: number) {
    if (priceLocked) return;
    const n = Math.max(0, Math.min(maxQty(l), next));
    if (n === (qty[l.variantId] ?? l.quantity)) return;
    setQtyError(null);
    setQty((m) => ({ ...m, [l.variantId]: n }));
    setPendingAnnounce({ variantId: l.variantId, title: l.title, added: false });
    setQtyAnnouncement("");
  }

  /** "Ajouter" on a suggested product: one more line, re-quoted like a quantity change. */
  function addRecommended(r: RecommendationView) {
    if (priceLocked) return;
    const current = qty[r.variantId] ?? 0;
    const n = Math.min(maxQty(r), current + 1);
    if (n === current) return;
    setQtyError(null);
    setQty((m) => ({ ...m, [r.variantId]: n }));
    setPendingAnnounce({ variantId: r.variantId, title: r.title, added: true });
    setQtyAnnouncement("");
  }

  /* ---------- totals ---------- */

  const localQuote = useMemo<QuoteState>(() => {
    const available = ratesForCountry(rates, address.countryCode);
    const rate = available.find((r) => r.id === rateId) ?? available[0] ?? null;
    const selected = addOns
      .filter((a) => addOnIds.includes(a.id))
      .map((a) => ({ ...a, active: true }));
    const totals = computeTotals({
      lines: displayLines,
      rate,
      discount: null,
      addOns: selected,
      protection: protectionBlock && protectionOn ? protectionBlock.props : null,
    });
    const discounted = totals.subtotalCents - totals.discountCents;
    return {
      totals,
      rates: available.map((r) => ({
        ...r,
        effectiveCents:
          r.freeOverCents != null && discounted >= r.freeOverCents
            ? 0
            : r.priceCents,
      })),
      shippingRateId: rate?.id ?? null,
      discountError: null,
      appliedCode: null,
    };
  }, [rates, address.countryCode, rateId, addOns, addOnIds, displayLines, protectionBlock, protectionOn]);

  const liveSessionId = mode.kind === "live" ? mode.sessionId : null;
  // The last quote request that finished (its signature): a newer one pending means the quote on
  // screen may be stale (the PayPal panel counts it as preparing: never auto-submits meanwhile).
  const [quotedSig, setQuotedSig] = useState<string | null>(null);
  const quoteSig = JSON.stringify([{ countryCode: address.countryCode, shippingRateId: rateId, discountCode: appliedCode, addOnIds, protection }, sentQty ? qtyKey(sentQty) : null]);
  const quoteLoading = !!liveSessionId && quotedSig !== quoteSig;
  useEffect(() => {
    if (!liveSessionId) return;
    const ctrl = new AbortController();
    const sent = sentQty;
    const base = { countryCode: address.countryCode, shippingRateId: rateId, discountCode: appliedCode, addOnIds, protection };
    const signature = JSON.stringify([base, sent ? qtyKey(sent) : null]);
    const t = setTimeout(async () => {
      // A failed quantity change goes back to the last quantities the server accepted,
      // and only the error is announced (the optimistic quantity never happened).
      const rollback = () => {
        if (!sent || qtyKey(sent) === confirmedKey) return;
        pendingQtyAnnounce.current = null;
        setPendingAnnounce(null);
        setQty(confirmedQty);
        setSentQty(null);
        // The re-quote of the old quantities (same settings, no quantities) keeps the message.
        qtyErrorGuard.current = JSON.stringify([base, null]);
        setQtyError(L.qtyError);
        announceQty(L.qtyError);
      };
      try {
        const res = await fetch(`/api/public/sessions/${liveSessionId}/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...base, ...(sent ? { quantities: sent } : {}) }),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          rollback();
          return;
        }
        const q = await res.json();
        // A quote went through: a stale "quantity could not be changed" message goes away,
        // except on the re-quote that confirms the rolled-back quantities.
        if (qtyErrorGuard.current !== signature) {
          qtyErrorGuard.current = null;
          setQtyError(null);
        } else qtyErrorGuard.current = null;
        // Free gifts come with the quote's lines: shown apart, never editable nor sent back as quantities.
        const buyerLines = Array.isArray(q.lines) ? (q.lines as CartLine[]).filter((l) => !l.gift) : [];
        setGiftLines(Array.isArray(q.lines) ? (q.lines as CartLine[]).filter((l) => l.gift) : []);
        if (buyerLines.length) {
          const confirmed = qtyMap(buyerLines);
          setServerLines(buyerLines);
          const capped = sent && qtyKey(latestQty.current) === qtyKey(sent) && qtyKey(confirmed) !== qtyKey(sent);
          // A plain cart's Shopify automatic discount holds for its exact lines: once they change, say so.
          if (sent && Array.isArray(q.automaticDiscountLost)) setQtyError(L.automaticDiscountLost);
          // A suggested product Shopify no longer sells is dropped: say so (the follow-up quote keeps the message).
          if (sent && Object.entries(sent).some(([id, n]) => n > 0 && !(id in confirmed) && !(id in confirmedQty))) {
            pendingQtyAnnounce.current = null;
            setPendingAnnounce(null);
            qtyErrorGuard.current = capped ? JSON.stringify([base, qtyKey(confirmed)]) : null;
            setQtyError(L.recoUnavailable);
            announceQty(L.recoUnavailable);
          }
          // The change is confirmed: announce the quantity the server actually kept.
          const pending = pendingQtyAnnounce.current;
          if (sent && pending && qtyKey(latestQty.current) === qtyKey(sent)) {
            pendingQtyAnnounce.current = null;
            setPendingAnnounce(null);
            const n = confirmed[pending.variantId] ?? 0;
            announceQty(n === 0 ? L.qtyRemoved(pending.title) : pending.added ? L.recoAdded(pending.title) : L.qtyChanged(pending.title, n));
          }
          // Stock caps and removals as the server applied them, unless the buyer changed again meanwhile.
          if (capped) {
            setQty(confirmed);
            setSentQty(confirmed);
          }
        }
        if (Array.isArray(q.eligibleAddOnIds)) {
          // An option whose display rules no longer match is dropped from the order.
          setAddOnIds((ids) => {
            const kept = ids.filter((id) => q.eligibleAddOnIds.includes(id));
            return kept.length === ids.length ? ids : kept;
          });
        }
        if (q.discountError) {
          setCodeError({ code: base.discountCode ?? "", message: (q.discountErrorCode && L.errors[q.discountErrorCode]) || q.discountError, notice: q.discountErrorCode === "discount_not_combinable" });
          setAppliedCode(null);
          return;
        }
        setQuote({ ...q, appliedCode: q.discount?.code ?? null });
      } catch {
        if (!ctrl.signal.aborted) rollback();
      } finally {
        if (!ctrl.signal.aborted) setQuotedSig(signature);
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // confirmedQty/confirmedKey only feed the rollback: a new confirmation must not re-quote.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSessionId, address.countryCode, rateId, appliedCode, addOnIds, protection, sentQty, L, announceQty]);

  // One-page checkout: keep a Whop checkout ready for the current total, so the
  // payment form and wallet buttons are on the page from the start.
  const quoteBlocking =
    !!quote &&
    (!!quote.discountError ||
      (quote.rates.length === 0 && displayLines.some((l) => l.requiresShipping)));
  // The page's first prepare goes out at once (the express buttons wait on it; the server most often
  // prepared it already, at the session's creation); the buyer's later changes are debounced.
  const firstPrepare = useRef(true);
  // The inputs a prepare sends, and those of the last one that succeeded: different = the checkout on
  // screen charges a previous total (from the buyer's change, through the debounce, until the answer).
  const prepareKey = JSON.stringify([address.countryCode, rateId, appliedCode, addOnIds, protection ?? null, confirmedKey]);
  const [preparedKey, setPreparedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!liveSessionId || quoteBlocking) return;
    const ctrl = new AbortController();
    const sentKey = prepareKey;
    const wait = (ms: number) =>
      new Promise<void>((resolve, reject) => {
        const id = setTimeout(resolve, ms);
        ctrl.signal.addEventListener("abort", () => {
          clearTimeout(id);
          reject(new Error("aborted"));
        });
      });
    const t = setTimeout(async () => {
      firstPrepare.current = false;
      setPreparing(true);
      // Network hiccups and 5xx are retried silently (0.8 s, 2 s, 4 s) before the buyer
      // sees anything: a red error on a page they haven't touched yet feels broken. Never past
      // PREPARE_RETRY_MAX_MS since the first attempt (a hanging processor makes each one slow), and
      // never Whop's "unavailable" (the server already waited its longest): « réessayer » instead.
      const delays = [800, 2000, 4000];
      const firstAt = Date.now();
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(`/api/public/sessions/${liveSessionId}/prepare`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              countryCode: address.countryCode,
              shippingRateId: rateId,
              discountCode: appliedCode,
              addOnIds,
              protection,
              // The quantities the server last confirmed (already saved on the session).
              ...(qtyTouched ? { quantities: confirmedQty } : {}),
              // Stripe's form couldn't load here: the server switches this buyer to Whop when it can.
              ...(stripeClientFailed.current ? { clientFailed: "stripe" } : {}),
            }),
            signal: ctrl.signal,
          });
          const body = await res.json().catch(() => ({}));
          // Its PaymentIntent already paid (marked so by the server): the thank-you page.
          if (body?.code === "already_paid") {
            router.push(thankYouUrlRef.current);
            return;
          }
          // A payment of this session still going through (its PaymentIntent processing): the panel
          // waits for it (polling the status), never a new form under it.
          if (body?.code === "payment_in_flight") setInFlightAtLoad(true);
          if (!res.ok) {
            // Whop unavailable: the payment section's « paiement indisponible / réessayer » state.
            const err = new Error(body?.code === "whop_unavailable" ? L.errors.init_failed : errorText(L, body)) as Error & { retry?: boolean; ref?: string | null };
            err.retry = prepareRetryable(res.status, body?.code);
            err.ref = (typeof body?.requestId === "string" && body.requestId) || res.headers.get("x-request-id");
            throw err;
          }
          setPrepareError(null);
          setPrepareRef(null);
          // PayPal refused for this session in this currency (see the PayPal prepare below): stays hidden here.
          const offered = body.paypal !== false && !paypalRefused.current.has(chargeCurrencyRef.current);
          setPaypalOffered(offered);
          // No longer offered (merchant switch, Whop's word): PayPal can't stay the chosen method
          // (any "PayPal isn't available" message stays; see stopPaypal). Not while a PayPal payment
          // may still go through: only its express button goes, the choice once the panel unlocks.
          if (!offered && panelLockRef.current === null) endPaypal(paypalChoiceReset({ keepError: true }));
          // Whop's configuration, or Stripe's PaymentIntent (also after a switch of processor for this
          // buyer): the form stays mounted while it is the same checkout at the same amount.
          const next = preparedFromBody(body);
          if (!next) throw new Error(L.error);
          stripeClientFailed.current = false;
          preparedRef.current = next;
          setPrepared((p) => (samePrepared(p, next) ? p : next));
          setPreparedKey(sentKey);
          // Switched to the other processor at this prepare (the first one failed, or its form
          // couldn't load here): said above the form, as after a switch at the click.
          if (body.switchedFrom) setProviderSwitched(true);
          break;
        } catch (err) {
          if (ctrl.signal.aborted) return;
          const retry = !(err instanceof Error) || (err as Error & { retry?: boolean }).retry !== false;
          if (retry && attempt < delays.length && Date.now() - firstAt + delays[attempt] < PREPARE_RETRY_MAX_MS) {
            try {
              await wait(delays[attempt]);
            } catch {
              return;
            }
            continue;
          }
          setPrepareError(err instanceof Error && err.message ? err.message : L.error);
          setPrepareRef((err as { ref?: string | null }).ref ?? null);
          break;
        }
      }
      if (!ctrl.signal.aborted) setPreparing(false);
    }, firstPrepare.current ? 0 : 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
      // The aborted request's finally skips this; without it the spinner could stay forever.
      setPreparing(false);
    };
    // confirmedKey stands for confirmedQty (same content, stable identity).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    liveSessionId,
    quoteBlocking,
    address.countryCode,
    rateId,
    appliedCode,
    addOnIds,
    protection,
    confirmedKey,
    qtyTouched,
    retryKey,
    L,
    prepareKey,
  ]);
  // Re-pricing: a prepare running or due (inputs changed since the last good one), or quantities
  // pending. The wallet buttons on screen then charge the previous total: locked until the new one.
  const repricing = preparing || qtyPending || (!!prepared && preparedKey !== null && preparedKey !== prepareKey);

  const q = live ? (quote ?? localQuote) : localQuote;
  const totals = q.totals;
  const lowestInventory = useMemo(() => {
    const tracked = displayLines
      .map((l) => l.inventory)
      .filter((n): n is number => n != null);
    return tracked.length ? Math.min(...tracked) : null;
  }, [displayLines]);

  /* ---------- order bumps, quantity breaks, relay point ---------- */

  const eligibleAddOnIds = live ? (quote?.eligibleAddOnIds ?? initialEligibleAddOnIds ?? null) : null;
  const visibleAddOns = eligibleAddOnIds ? addOns.filter((a) => eligibleAddOnIds.includes(a.id)) : addOns;
  const volumeBreak = live ? (quote?.volumeBreak ?? null) : null;
  const pct = (n: number) => new Intl.NumberFormat(localeOf(theme.language), { maximumFractionDigits: 1 }).format(n);
  const displayedItems = displayLines.reduce((n, l) => n + l.quantity, 0);
  const volumeNudge = (() => {
    const next = volumeBreak?.next;
    if (!next) return null;
    // Scoped tiers count their own products only: the server says how many are missing.
    const scope = next.productIds?.length ? new Set(next.productIds.map((id) => id.match(/(\d+)\D*$/)?.[1] ?? id)) : null;
    const inScope = (l: CartLine) => !scope || scope.has(l.productId.match(/(\d+)\D*$/)?.[1] ?? l.productId);
    const missing = scope ? (volumeBreak?.missing ?? 0) : tierThreshold(next) - displayedItems;
    if (missing <= 0) return null;
    // "+1" on the cheapest line (of the tier's products) that can still grow.
    const target = [...displayLines].filter((l) => !l.locked && l.quantity < maxQty(l) && inScope(l)).sort((a, b) => a.unitPriceCents - b.unitPriceCents)[0] ?? null;
    return { missing, tier: next, target };
  })();
  // "2 pour 49 €", "−5 € par article", "2 achetés, 1 offert" in the buyer's language (percent tiers keep their own wording).
  const dealText = (b: QuantityBreak): string | null => {
    const d = breakDeal(b);
    if (d.kind === "amount") return d.per === "bundle" ? L.dealAmountBundle(money(d.amountCents), d.minQty) : L.dealAmountUnit(money(d.amountCents));
    if (d.kind === "price") return L.dealPrice(d.minQty, money(d.priceCents));
    if (d.kind === "bxgy") return L.dealBxgy(d.buy, d.free);
    return null;
  };
  // "12 € more to get the free candle": the closest gift not earned yet (server quote).
  const giftNext = live ? (quote?.gifts?.next ?? null) : null;
  const giftNudge = giftNext
    ? giftNext.missingCents != null
      ? L.giftNudgeAmount(money(giftNext.missingCents), giftNext.title)
      : giftNext.missingQty != null
        ? L.giftNudgeItems(giftNext.missingQty, giftNext.title)
        : null
    : null;
  const protectionPrice = protectionBlock
    ? live && quote?.protection
      ? quote.protection.priceCents
      : computeTotals({ lines: displayLines, rate: null, discount: null, addOns: [], protection: protectionBlock.props }).protectionCents ?? 0
    : 0;

  // The buyer's click shows at once (the server quote confirms it a moment later).
  const shownRateId = rateId && q.rates.some((r) => r.id === rateId) ? rateId : q.shippingRateId;
  const selectedRate = q.rates.find((r) => r.id === shownRateId) ?? null;
  const pickupSelected = selectedRate?.kind === "pickup";
  const [pickupPoint, setPickupPoint] = useState<PickupPointView | null>(null);
  // A point chosen in another country no longer applies.
  const validPickup = pickupPoint && pickupPoint.countryCode === address.countryCode ? pickupPoint : null;

  // Screen readers hear the new total when shipping, a code or an option changes it.
  const [announcedTotal, setAnnouncedTotal] = useState(totals.totalCents);
  const [totalAnnouncement, setTotalAnnouncement] = useState("");
  if (announcedTotal !== totals.totalCents) {
    setAnnouncedTotal(totals.totalCents);
    setTotalAnnouncement(L.totalUpdatedLive(money(totals.totalCents)));
  }

  /* ---------- validation ---------- */

  const fieldErrors = useMemo(() => {
    const e: Partial<Record<FieldKey, string>> = {};
    if (!email.trim()) e.email = L.errEmail;
    else if (!EMAIL_RE.test(email.trim())) e.email = L.errEmailInvalid;
    const missing = { firstName: L.errFirstName, lastName: L.errLastName, address1: L.errAddress, city: L.errCity, countryCode: L.errCountry };
    for (const k of ["firstName", "lastName", "address1", "city", "countryCode"] as const) {
      if (!address[k].trim()) e[k] = missing[k];
    }
    const zip = address.zip.trim();
    if (!zip) e.zip = L.errZip;
    else if (ZIP_RE[address.countryCode] && !ZIP_RE[address.countryCode].test(zip))
      e.zip = ZIP_EXAMPLE[address.countryCode]
        ? L.errZipFor(countryName(address.countryCode, theme.language), ZIP_EXAMPLE[address.countryCode])
        : L.invalidZip;
    if (live && pickupSelected && !validPickup) e.pickup = L.pickupChoose;
    if (theme.requireTerms && !termsAccepted) e.terms = L.termsRequired;
    return e;
  }, [email, address, theme.requireTerms, termsAccepted, L, live, pickupSelected, validPickup, theme.language]);

  const fieldLabel: Record<FieldKey, string> = {
    email: L.email,
    countryCode: L.country,
    firstName: L.firstName,
    lastName: L.lastName,
    address1: L.address1,
    zip: L.zip,
    city: L.city,
    pickup: L.pickupField,
    terms: L.termsShort,
  };
  const invalidFields = FIELD_ORDER.filter((k) => fieldErrors[k]);
  // Everything the order needs but the terms box (ticked last, right before paying).
  const paypalDetailsReady = invalidFields.every((k) => k === "terms");
  const paypalPrepWanted = !!liveSessionId && !quoteBlocking && paypalMode && paypalOffered && paypalDetailsReady;
  // Inputs of the PayPal prepare below, and those of the last one that finished: preparing from the
  // moment they differ (not only after the debounce), so a stale PayPal checkout never auto-submits.
  const paypalPrepSig = JSON.stringify([address.countryCode, rateId, appliedCode, addOnIds, protection, confirmedKey, qtyTouched, paypalRetryKey]);
  // (paypalDoneSig: declared with the other PayPal state, see endPaypal.)
  const paypalPrepPending = paypalPrepWanted && paypalDoneSig !== paypalPrepSig;

  // PayPal chosen: a PayPal-only Whop checkout for the same quote (same snapshot rules server-side),
  // once the buyer's details are complete (no Whop checkout created for a form that can't pay yet).
  useEffect(() => {
    if (!paypalPrepWanted) return;
    const sig = paypalPrepSig;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setPaypalPreparing(true);
      // PayPal dropped below (the full reset): its signature stays forgotten, so a later PayPal
      // click prepares afresh.
      let dropped = false;
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await fetch(`/api/public/sessions/${liveSessionId}/prepare`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              countryCode: address.countryCode,
              shippingRateId: rateId,
              discountCode: appliedCode,
              addOnIds,
              protection,
              ...(qtyTouched ? { quantities: confirmedQty } : {}),
              method: "paypal",
            }),
            signal: ctrl.signal,
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            // One silent retry on a 5xx; PayPal refused by Whop drops the choice (the card form stays).
            if (prepareRetryable(res.status, body?.code) && attempt === 0) continue;
            if (body?.code === "paypal_unavailable") {
              paypalRefused.current.add(chargeCurrencyRef.current);
              setPaypalOffered(false);
              // A PayPal payment possibly still going through keeps its checkout (dropped on unlock).
              if (panelLockRef.current === null) {
                endPaypal(paypalChoiceReset({ keepError: true }));
                dropped = true;
              }
            }
            setPaypalAutoSubmit(false);
            setPaypalError(errorText(L, body));
            break;
          }
          setPaypalError(null);
          setPaypalPrepared((p) => (p?.configId === body.checkoutConfigurationId ? p : { configId: body.checkoutConfigurationId, environment: body.environment }));
          break;
        } catch (err) {
          if (ctrl.signal.aborted) return;
          if (attempt === 0) continue;
          setPaypalAutoSubmit(false);
          setPaypalError(err instanceof Error && err.message ? err.message : L.error);
          break;
        }
      }
      if (!ctrl.signal.aborted) {
        setPaypalPreparing(false);
        if (!dropped) setPaypalDoneSig(sig);
      }
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
      setPaypalPreparing(false);
    };
    // Same inputs as the regular prepare (confirmedKey stands for confirmedQty).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paypalPrepWanted, liveSessionId, quoteBlocking, paypalMode, paypalOffered, paypalDetailsReady, address.countryCode, rateId, appliedCode, addOnIds, protection, confirmedKey, qtyTouched, paypalRetryKey, L]);


  // Funnel beacons (analytics): e-mail left valid, then a complete address. Once per step.
  const beaconsSent = useRef<Set<string>>(new Set());
  const emailDone = !!touched.email && !fieldErrors.email;
  const addressDone = (["countryCode", "firstName", "lastName", "address1", "zip", "city"] as const).every((k) => !fieldErrors[k]);
  useEffect(() => {
    if (!liveSessionId) return;
    const send = (step: "email" | "address") => {
      if (beaconsSent.current.has(step)) return;
      beaconsSent.current.add(step);
      fetch(`/api/public/sessions/${liveSessionId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step }),
        keepalive: true,
      }).catch(() => {});
    };
    if (emailDone) send("email");
    if (addressDone) send("address");
  }, [liveSessionId, emailDone, addressDone]);
  const incomplete = invalidFields.map((k) => fieldLabel[k]);
  // Error states only (no success checks, like Shopify's checkout).
  const shownError = (k: FieldKey) => (showAllErrors || touched[k] ? fieldErrors[k] : undefined);
  const touch = (k: FieldKey) => setTouched((t) => (t[k] ? t : { ...t, [k]: true }));

  /** Shows every error, then scrolls to and focuses the first invalid field. */
  function revealErrors(): boolean {
    setShowAllErrors(true);
    const first = invalidFields[0];
    if (!first) return true;
    const el = document.getElementById(fieldId(first));
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "center" });
    el?.focus({ preventScroll: true });
    return false;
  }

  /* ---------- returning buyer (details saved on this device) ---------- */

  const showSavedPrompt =
    live && !!saved && !savedAnswered && (!email.trim() || email.trim().toLowerCase() === saved.email.toLowerCase());
  const focusEmail = () => document.getElementById(fieldId("email"))?.focus({ preventScroll: true });
  function applySaved() {
    // Never over the details a pending PayPal payment was opened with (see priceLocked).
    if (!saved || priceLocked) return;
    const shipsThere = countries.some((c) => c.code === saved.address.countryCode);
    setEmail(saved.email);
    setEmailSuggestion(null);
    setAddress({ ...EMPTY_ADDRESS, ...saved.address, countryCode: shipsThere ? saved.address.countryCode : address.countryCode });
    // Shows at once anything the saved details lack (e.g. a country we don't ship to).
    setTouched((t) => ({ ...t, email: true, firstName: true, lastName: true, address1: true, zip: true, city: true }));
    setRemember(true);
    setSavedAnswered(true);
    setSavedNotice(L.savedFilled);
    requestAnimationFrame(focusEmail);
  }
  // Details of the last paid order, released by the right e-mail code (other device).
  function applyCodeBuyer(buyer: CodeBuyer) {
    if (priceLocked) return;
    const shipsThere = countries.some((c) => c.code === buyer.address.countryCode);
    setEmail(buyer.email);
    setEmailSuggestion(null);
    setAddress({ ...EMPTY_ADDRESS, ...buyer.address, address2: buyer.address.address2 ?? "", province: buyer.address.province ?? "", phone: buyer.address.phone ?? "", countryCode: shipsThere ? buyer.address.countryCode : address.countryCode } as typeof address);
    setTouched((t) => ({ ...t, email: true, firstName: true, lastName: true, address1: true, zip: true, city: true }));
    setSavedAnswered(true);
    setSavedNotice(L.otpFilled);
  }
  function forgetSaved() {
    clearSavedBuyer();
    setRemember(false);
    setSavedAnswered(true);
    setSavedNotice(L.savedForgotten);
    requestAnimationFrame(focusEmail);
  }

  /* ---------- payment ---------- */

  const locked = false;
  // Same language on the thank-you page (also after the Whop / 3-D Secure redirect).
  // via=app (the loader's APP_URL fallback: the checkout domain is unreachable for this buyer) is
  // kept, or the thank-you page would send the buyer back to that domain.
  const viaApp = useSyncExternalStore(
    noopSubscribe,
    () => new URLSearchParams(window.location.search).get("via") === "app",
    () => false,
  );
  const thankYouUrl = liveSessionId ? `/c/${liveSessionId}/merci?lang=${theme.language}${viaApp ? "&via=app" : ""}` : "#";
  useEffect(() => {
    thankYouUrlRef.current = thankYouUrl;
  }, [thankYouUrl]);
  // Whop needs an absolute return URL; the origin is only known in the browser.
  const origin = useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "",
  );
  const onPaid = () => router.push(thankYouUrl);

  // The express buttons the merchant chose (builder > Paiement express), for this cart.
  // Free gifts ship too; a line at quantity 0 (being removed) ships nothing.
  const expressShown = expressMethodsShown(theme.expressMethods, { shippable: cartShippable(displayLines, giftLines) });
  // The wallets whose Whop button really showed on this device (for the Payment title's logos).
  const [walletsRendered, setWalletsRendered] = useState<ExpressWallet[]>([]);
  // PayPal is paid only while it is chosen, offered by Whop and allowed by the merchant (the panel
  // shows the regular form otherwise). While the panel is locked (a PayPal payment submitting or
  // possibly still going through) it stays chosen whatever changed: dropping it then would forget
  // the pending payment and offer the card under an open PayPal window (see paypalStaysChosen).
  const paypalActive = paypalStaysChosen({ mode: paypalMode, offered: paypalOffered && expressShown.paypal, lock: panelLock });
  // No longer offered while it was locked: dropped once the panel unlocks (React's pattern for state
  // following other state, adjusted while rendering).
  // The same reset as stopPaypal (a later PayPal click prepares afresh), its message kept.
  if (paypalMode && !paypalOffered && panelLock === null) endPaypal(paypalChoiceReset({ keepError: true }));

  // A PayPal window signal to the paypal-window route ({ blocked | beat | closed }): same-origin,
  // best effort, survives the page going away (keepalive).
  function paypalWindowSignal(body: { blocked: true } | { beat: true } | { closed: true }) {
    if (!liveSessionId) return;
    void fetch(`/api/public/sessions/${liveSessionId}/paypal-window`, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined);
  }

  // Before leaving a PayPal payment that may have gone through (its window was open), and during
  // the panel's server wait. A payment submitted moments ago (PAYING, recent "Pay" click or PayPal
  // window) may still go through: inFlight. A failed check is no answer ("unknown"): never read as
  // unpaid (fails closed).
  async function checkPaid(): Promise<PaidCheck> {
    if (!liveSessionId) return "unpaid";
    try {
      const res = await fetch(`/api/public/sessions/${liveSessionId}/status`, { cache: "no-store" });
      if (!res.ok) return "unknown";
      const body = await res.json().catch(() => null);
      if (!body || typeof body.status !== "string") return "unknown";
      return body.status === "PAID" ? "paid" : body.paymentInFlight === true ? "inFlight" : "unpaid";
    } catch {
      return "unknown";
    }
  }

  /**
   * Saves the buyer on the server right before the payment is submitted (the server checks totals,
   * terms and any payment in flight). `wallet`: a Stripe express payment, whose sheet gave the
   * e-mail and address (the form may be empty; its terms notice stands for acceptance).
   */
  async function confirm(wallet?: WalletBuyer, from?: "whop" | "stripe"): Promise<ConfirmResult> {
    if (!liveSessionId) return { ok: false };
    // A form of the other processor (a stale render after this buyer's switch): never submitted; the
    // current processor's form is on screen (the buyer clicks Pay again there).
    const latest = preparedRef.current;
    if (from && latest && (latest.provider ?? "whop") !== from) return { ok: false, refreshedConfigId: latest.configId };
    if (!wallet && !revealErrors()) return { ok: false };
    // Only on this device, only when asked: contact + address, never payment data.
    if (!wallet) {
      if (remember) writeSavedBuyer(email, address);
      else if (saved && saved.email.toLowerCase() === email.trim().toLowerCase()) clearSavedBuyer();
    }
    setProviderSwitched(false);
    const buyerEmail = wallet?.email ?? email;
    const buyerAddress = wallet?.address ?? address;
    const onStripe = (latest ?? prepared)?.provider === "stripe";
    const current = latest ?? prepared;
    const res = await fetch(`/api/public/sessions/${liveSessionId}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: buyerEmail,
        acceptsMarketing: marketing,
        acceptsTerms: wallet ? termsAccepted || theme.requireTerms : termsAccepted,
        address: buyerAddress,
        note: note.trim() || null,
        // PayPal chosen: the PayPal-only checkout (the server swaps in a fresh one if it's stale).
        checkoutConfigurationId: onStripe ? null : ((paypalActive ? paypalPrepared?.configId : current?.configId) ?? null),
        // Stripe: the PaymentIntent the page is about to confirm.
        paymentIntentId: onStripe ? (current?.stripe?.paymentIntentId ?? null) : null,
        method: paypalActive && !onStripe ? "paypal" : null,
        countryCode: buyerAddress.countryCode,
        shippingRateId: q.shippingRateId,
        discountCode: appliedCode,
        addOnIds,
        protection,
        // What the buyer sees; if the server prices it differently, it answers with a new checkout.
        ...(qtyTouched ? { quantities: qty } : {}),
        pickupPoint: !wallet && pickupSelected && validPickup ? pickupPayload(validPickup) : null,
      }),
    });
    const body = await res.json();
    if (!res.ok) {
      // Whop refused PayPal at pay time: like the PayPal prepare, the choice is dropped (card form back).
      if (paypalActive && body?.code === "paypal_unavailable") {
        paypalRefused.current.add(chargeCurrencyRef.current);
        setPaypalOffered(false);
        // Never under a locked panel (a PayPal payment possibly still going through keeps its
        // checkout): the render-time drop above ends PayPal once the panel unlocks.
        if (panelLockRef.current === null) stopPaypal();
      }
      // Another payment of this session still going through (e.g. PayPal in another tab): the
      // panel waits for it, polling the status (see PaymentPanel's server wait).
      if (body?.code === "payment_in_flight") return { ok: false, error: L.paymentAlreadyInFlight, inFlight: true };
      return { ok: false, error: errorText(L, body) };
    }
    if (!body.ready) {
      // A fresh checkout to show first: Whop's (the PayPal-only one while PayPal is chosen), or
      // Stripe's PaymentIntent (maybe after a switch of processor for this buyer).
      const next = preparedFromBody(body);
      // This buyer was switched to the other processor at the click: said above its form.
      if (body.switchedFrom) setProviderSwitched(true);
      if (next && paypalActive && next.provider !== "stripe") setPaypalPrepared(next);
      else if (next) {
        preparedRef.current = next;
        setPrepared((p) => (samePrepared(p, next) ? p : next));
      }
      return { ok: false, refreshedConfigId: next?.configId ?? "refreshed" };
    }
    return {
      ok: true,
      buyer: {
        email: buyerEmail,
        address: {
          name: `${buyerAddress.firstName} ${buyerAddress.lastName}`.trim(),
          line1: buyerAddress.address1,
          line2: buyerAddress.address2 || undefined,
          city: buyerAddress.city,
          state: buyerAddress.province,
          postalCode: buyerAddress.zip,
          country: buyerAddress.countryCode,
          phone: buyerAddress.phone || undefined,
        },
      },
    };
  }

  const payLabel = `${theme.payButtonText || L.payNow} · ${money(totals.totalCents)}`;

  /* ---------- sticky mobile pay bar ---------- */

  const paymentRef = useRef<HTMLElement | null>(null);
  const [paymentOffscreen, setPaymentOffscreen] = useState(false);
  useEffect(() => {
    const el = paymentRef.current;
    if (!live || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setPaymentOffscreen(!entry.isIntersecting), {
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [live]);

  function goToPayment() {
    if (invalidFields.length > 0) {
      revealErrors();
      return;
    }
    const el = paymentRef.current;
    el?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    document.getElementById("wc-pay-button")?.focus({ preventScroll: true });
  }

  /**
   * Express PayPal button: PayPal becomes the chosen method (the payment panel shows it). An
   * incomplete form points the buyer to what's missing, exactly like the Pay button; a complete
   * one pays at once through the PayPal-only checkout.
   */
  function startPaypal() {
    setInteracted(true);
    setPaypalError(null);
    setPaypalMode(true);
    if (invalidFields.length > 0) {
      setPaypalAutoSubmit(false);
      // Only the terms box left: say that, not "enter your delivery details".
      setPaypalNotice(paypalDetailsReady ? L.termsRequired : L.paypalNeedsDetails);
      revealErrors();
      return;
    }
    setPaypalNotice(null);
    setPaypalAutoSubmit(true);
    document.getElementById("wc-payment")?.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    // Keyboard and screen-reader users land where PayPal continues ("Continue with PayPal").
    document.getElementById("wc-pay-button")?.focus({ preventScroll: true });
  }
  function stopPaypal() {
    endPaypal(paypalChoiceReset({ keepError: false }));
  }
  // The express PayPal button is on the page before the first /prepare answers: a click on a complete
  // form waits for it there (spinner on the button, see ExpressPaypal.ready), then goes on as usual
  // (startPaypal); an incomplete form is pointed out at once (nothing to wait for).
  const expressPaypal =
    paypalOffered && expressShown.paypal
      ? {
          onClick: startPaypal,
          // Waits for the checkout of the current total (first one, or a re-prepare after a change of
          // rate, add-on, country…), like the wallets; a failed prepare doesn't hold the click (PayPal
          // prepares its own checkout and says what goes wrong).
          ready: (!!prepared && !repricing) || invalidFields.length > 0 || (!!prepareError && !preparing),
          busy: paypalAutoSubmit || panelLock === "busy",
          // Until the form is complete (then the Pay area offers "Continue with PayPal").
          // Only the terms box left: that is what the notice says (it follows the form as the buyer fills it).
          notice: paypalMode && invalidFields.length > 0 && paypalNotice ? (paypalDetailsReady ? L.termsRequired : L.paypalNeedsDetails) : null,
        }
      : null;

  /* ---------- rendering helpers ---------- */

  const freeShippingThresholdCents = useMemo(() => {
    const thresholds = rates
      .filter((r) => r.active && r.freeOverCents != null)
      .map((r) => r.freeOverCents as number);
    return thresholds.length ? Math.min(...thresholds) : null;
  }, [rates]);
  // Payment logos: only the ones this checkout really offers (card brands with the card form,
  // Apple Pay / Google Pay when their express button shows; never SEPA / crypto).
  const walletsOn = expressWalletsOn(theme.expressCheckout, layout.blocks);
  // Live: only the wallets whose Whop button really showed on this device (reported by ExpressCheckout).
  const offeredWallets = offeredWalletsFor({
    walletsOn,
    pickupSelected,
    configured: expressShown.wallets,
    rendered: live ? walletsRendered : null,
  });
  const ctx: ContentContext = {
    labels: L,
    lang: theme.language,
    lowestInventory,
    preview: !live,
    offeredWallets,
    // Shown once: next to the Payment title, so the payment-logos block itself is skipped live.
    paymentLogosInHeader: layout.blocks.some((b) => b.type === "payment" && !b.hidden),
    headerLogosBlockId: headerLogosBlockId(layout.blocks, offeredWallets),
    subtotalCents: totals.subtotalCents - totals.discountCents,
    freeShippingThresholdCents,
    money,
    note,
    setNote,
    noteLockedBy: priceLocked ? LOCK_NOTE_DELIVERY_ID : null,
    cartProducts: live ? cartProductsOf(serverLines) : null,
  };
  const arranged = arrangeCheckout(layout.blocks);
  // Payment title: the payment-logos block's methods, small, only those this checkout offers.
  const iconsBlock = layout.blocks.find((b) => b.type === "payment_icons" && !b.hidden);
  const paymentLogos = iconsBlock?.type === "payment_icons" ? offeredPaymentLogos(iconsBlock.props.methods, offeredWallets) : [];
  // Stripe's express row is on the page (same conditions as its section below): Apple Pay / Google
  // Pay live there, never twice in the Payment Element.
  const stripeExpressRow =
    theme.expressCheckout && !pickupSelected && stripeExpressAny(theme.expressMethods) && layout.blocks.some((b) => b.type === "express" && !b.hidden && b.props.enabled);

  // "Complétez votre commande": under the summary on desktop, above the payment on mobile.
  const recoBlock = arranged.recommendations;
  // A cart fixed as a whole (app prices, Shopify automatic discounts) takes no suggested product.
  const cartLocked = !!quote?.cartLocked || serverLines.some((l) => !!l.appPrice);
  const recoItemsOf = (list: RecommendationView[] | null | undefined) =>
    recoBlock && !(live && cartLocked)
      ? visibleRecommendations(
          live ? (list ?? []) : sampleRecommendations(recoBlock.props.items, ["Produit recommandé", "Accessoire assorti"]),
          live ? displayLines : [],
          recoBlock.props.hideIfInCart,
        )
      : [];
  const recoBlockNode = (idPrefix: string, list: RecommendationView[] | null | undefined) => {
    const items = recoItemsOf(list);
    return recoBlock && items.length > 0
      ? wrap(
          recoBlock,
          <Recommendations
            title={recoBlock.props.title || L.recoTitle}
            items={items}
            labels={L}
            money={money}
            showImages={theme.summaryImages}
            idPrefix={idPrefix}
            onAdd={live ? addRecommended : undefined}
          />,
          idPrefix,
        )
      : null;
  };
  // Streamed by the server page (a promise): rendered inside <Suspense> with use(), so a quick Shopify
  // answer is already in the server HTML; a slow one fills in when it lands (nothing shown meanwhile).
  const recoNode = (idPrefix: string) =>
    recoBlock && recommendationsStream && !(live && cartLocked) ? (
      <Suspense key={`reco-${idPrefix}`} fallback={null}>
        <StreamedRecommendations promise={recommendationsStream} onLoad={setStreamedRecommendations} render={(list) => recoBlockNode(idPrefix, list)} />
      </Suspense>
    ) : (
      recoBlockNode(idPrefix, recommendations)
    );
  const recoMobile = recoNode("p-");
  const estimate = localEstimate(totals.totalCents, address.countryCode, currency, localRates, theme.language);

  function wrap(block: Block, node: ReactNode, keyPrefix = "") {
    if (node === null || isEmptyInLive(block, ctx, mountedAt)) return null;
    const selectable = mode.kind === "preview" && mode.onSelectBlock;
    const selected =
      mode.kind === "preview" && mode.selectedBlockId === block.id;
    return (
      <div
        key={keyPrefix + block.id}
        data-block-id={block.id}
        onClickCapture={
          selectable
            ? (e) => {
                if (
                  (e.target as HTMLElement).closest(
                    "input,select,textarea,button",
                  )
                )
                  return;
                mode.onSelectBlock!(block.id);
              }
            : undefined
        }
        className={
          selectable
            ? `-mx-2 cursor-pointer rounded-lg px-2 outline-offset-2 transition-[outline] ${selected ? "outline-2 outline-[var(--accent)] outline-solid" : "hover:outline-1 hover:outline-neutral-300 hover:outline-dashed"}`
            : undefined
        }
      >
        <StyledBlock style={block.style}>{node}</StyledBlock>
      </div>
    );
  }

  const inputProps = (k: FieldKey) => {
    const err = shownError(k);
    return {
      id: fieldId(k),
      "aria-invalid": err ? true : undefined,
      "aria-describedby": err ? `${fieldId(k)}-error` : undefined,
      onBlur: () => touch(k),
    };
  };

  // Until the buyer gives an address, rates come from the pre-filled country only: estimates.
  const shippingEstimated = !(address.address1.trim() && address.zip.trim());

  const termsBox = theme.requireTerms ? (
    <div data-field="terms">
      <label className="flex min-h-11 cursor-pointer items-start gap-3 py-1 text-sm leading-snug">
        <input
          type="checkbox"
          checked={termsAccepted}
          disabled={locked}
          required
          onChange={(e) => {
            setTermsAccepted(e.target.checked);
            touch("terms");
          }}
          {...inputProps("terms")}
          onBlur={undefined}
          className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--accent)]"
        />
        <span>
          <TermsText L={L} theme={theme} />
        </span>
      </label>
      {shownError("terms") && (
        <p id={`${fieldId("terms")}-error`} className="mt-1 text-sm text-red-700">
          {shownError("terms")}
        </p>
      )}
    </div>
  ) : null;

  // The first /prepare failed (its error and « réessayer » are in the payment section): no express
  // button to offer, the row keeps its place with a short message (ExpressUnavailable), and a PayPal
  // click waiting for that checkout is dropped with it said aloud (ExpressCheckout's `unavailable`).
  const firstFailed = mode.kind === "live" && !prepared && !!prepareError && !preparing;

  function renderSection(block: Block): ReactNode {
    switch (block.type) {
      case "express":
        // Hidden by its own switch, or by the legacy theme switch (older designs).
        if (!block.props.enabled || !theme.expressCheckout) return null;
        // Paying with Stripe (its primary, the store's secours, or this buyer's switch): Stripe's own
        // express buttons (its sheet collects the shipping address), never Whop's nor our PayPal flow.
        // Before the first /prepare answers, the processor the server expects draws the row's place.
        if (mode.kind === "live" && (prepared ? prepared.provider === "stripe" : initialProvider === "stripe")) {
          if (!stripeExpressAny(theme.expressMethods) || pickupSelected) return null;
          if (firstFailed) return <ExpressUnavailable labels={L} title={block.props.title} dividerLabel={block.props.dividerLabel} />;
          if (!prepared) return <StripeExpressPlaceholder labels={L} title={block.props.title} dividerLabel={block.props.dividerLabel} />;
          return (
            <StripeExpress
              key={prepared.configId}
              prepared={prepared}
              theme={theme}
              labels={L}
              returnUrl={`${origin}${thankYouUrl}`}
              confirmExpress={(buyer) => confirm(buyer, "stripe")}
              onPaid={onPaid}
              shippable={cartShippable(displayLines, giftLines)}
              country={address.countryCode}
              // Locked while a payment is under way below, and while the total is being re-priced
              // (a prepare or a quantity change pending): never a wallet paying the old total.
              lock={panelLock ?? (repricing ? "busy" : null)}
              onBusy={setExpressBusy}
              title={block.props.title}
              dividerLabel={block.props.dividerLabel}
              termsNotice={theme.requireTerms ? <TermsText L={L} theme={theme} express /> : null}
            />
          );
        }
        // Every express button switched off by the merchant (or none for this cart): no section, no "OR".
        if (!expressShown.wallets.length && !expressShown.paypal) return null;
        // Before the Whop checkout exists: our PayPal button already works (a click waits for it), and
        // the wallets keep their place (placeholders the live buttons replace in place).
        // Wallets ship to the wallet's address: they would skip the relay point choice (PayPal goes
        // through the form, relay point included: it stays).
        if (mode.kind === "live" && pickupSelected && !expressPaypal) return null;
        return mode.kind === "live" ? (
          <ExpressCheckout
            prepared={prepared}
            paypal={expressPaypal}
            // Every express button locked while the panel is (even with the PayPal button gone).
            lock={panelLock}
            // A change of total not prepared yet: the wallet buttons on screen (old total) stay locked.
            stale={repricing}
            unavailable={firstFailed}
            wallets={!pickupSelected}
            // The merchant's wallets; Google Pay only when nothing ships unless set to "always"
            // (Whop's Google Pay express button collects no shipping address).
            walletMethods={expressShown.wallets}
            onWalletsShown={setWalletsRendered}
            theme={theme}
            labels={L}
            returnUrl={`${origin}${thankYouUrl}`}
            email={email}
            onPaid={onPaid}
            saveCard={!!mode.saveCard}
            title={block.props.title}
            dividerLabel={block.props.dividerLabel}
            termsNotice={theme.requireTerms ? <TermsText L={L} theme={theme} express /> : null}
          />
        ) : (
          <ExpressPreview labels={L} title={block.props.title} dividerLabel={block.props.dividerLabel} walletMethods={expressShown.wallets} paypal={expressShown.paypal} />
        );
      case "contact":
        return (
          <>
            <Section title={block.props.title || L.contact}>
              {showSavedPrompt && saved && (
                <div
                  role="group"
                  aria-label={L.savedRegion}
                  className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius)] border border-[var(--border)] bg-[color-mix(in_srgb,var(--accent)_5%,white)] py-1.5 pr-2 pl-3 text-sm"
                >
                  <span className="flex min-w-0 flex-1 basis-48 items-center gap-2 font-medium">
                    <UserRound className="h-4 w-4 shrink-0 text-neutral-600" aria-hidden />
                    <span className="min-w-0 break-all">{L.continueAs(maskEmail(saved.email))}</span>
                  </span>
                  <span className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={applySaved}
                      className="inline-flex min-h-11 items-center rounded-[var(--btn-radius)] bg-[image:var(--accent-bg)] px-3.5 text-sm font-semibold text-[var(--accent-fg)] shadow-[var(--btn-shadow)]"
                    >
                      {L.useSaved}
                    </button>
                    <button
                      type="button"
                      onClick={forgetSaved}
                      className="inline-flex min-h-11 items-center rounded-sm px-2 text-sm text-neutral-700 underline underline-offset-2 hover:no-underline"
                    >
                      {L.notMe}
                    </button>
                  </span>
                </div>
              )}
              {priceLocked && <PriceLockNote id={LOCK_NOTE_CONTACT_ID} text={L.paypalEditsLocked} />}
              <Field label={L.email} error={shownError("email")} field="email">
                <input
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  required
                  value={email}
                  disabled={locked}
                  readOnly={priceLocked}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setEmailSuggestion(null);
                  }}
                  {...inputProps("email")}
                  onBlur={() => {
                    touch("email");
                    setEmailSuggestion(suggestEmail(email));
                  }}
                  aria-describedby={describedBy(
                    shownError("email") && `${fieldId("email")}-error`,
                    emailSuggestion && !priceLocked && `${fieldId("email")}-suggest`,
                    priceLocked && LOCK_NOTE_CONTACT_ID,
                  )}
                  className={inputCls}
                />
              </Field>
              {live && returningCode && liveSessionId && !showSavedPrompt && !priceLocked && (
                <ReturningBuyerCode sessionId={liveSessionId} email={email} L={L} inputCls={inputCls} onFilled={applyCodeBuyer} />
              )}
              {emailSuggestion && !priceLocked && (
                <p id={`${fieldId("email")}-suggest`} className="mt-1.5 text-sm text-neutral-700">
                  <button
                    type="button"
                    onClick={() => {
                      setEmail(emailSuggestion);
                      setEmailSuggestion(null);
                      document.getElementById(fieldId("email"))?.focus();
                    }}
                    className="inline-flex min-h-11 items-center rounded-sm text-left underline underline-offset-2 hover:no-underline"
                  >
                    {L.emailSuggest(emailSuggestion)}
                  </button>
                </p>
              )}
              <label className="mt-2 flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                {/* Locked while a PayPal payment is pending (see priceLocked): still focusable, the lock note announced. */}
                <input
                  type="checkbox"
                  checked={marketing}
                  disabled={locked}
                  aria-disabled={priceLocked || undefined}
                  aria-describedby={priceLocked ? LOCK_NOTE_CONTACT_ID : undefined}
                  // Controlled: a change not taken snaps back.
                  onChange={(e) => {
                    if (!priceLocked) setMarketing(e.target.checked);
                  }}
                  data-testid="wc-marketing"
                  className="h-5 w-5 shrink-0 accent-[var(--accent)] aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                />
                {L.marketing}
              </label>
              <div className="flex flex-wrap items-center gap-x-3">
                <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={remember}
                    disabled={locked}
                    aria-disabled={priceLocked || undefined}
                    onChange={(e) => {
                      if (!priceLocked) setRemember(e.target.checked);
                    }}
                    aria-describedby={describedBy(remember && "wc-remember-hint", priceLocked && LOCK_NOTE_CONTACT_ID)}
                    data-testid="wc-remember"
                    className="h-5 w-5 shrink-0 accent-[var(--accent)] aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                  />
                  {L.rememberMe}
                </label>
                {live && saved && !showSavedPrompt && (
                  <button
                    type="button"
                    onClick={forgetSaved}
                    className="inline-flex min-h-11 items-center rounded-sm text-sm text-neutral-700 underline underline-offset-2 hover:no-underline"
                  >
                    {L.forgetMe}
                  </button>
                )}
              </div>
              {remember && (
                <p id="wc-remember-hint" className="-mt-1 pl-8 text-xs text-neutral-600">
                  {L.rememberHint}
                </p>
              )}
            </Section>
          </>
        );
      case "delivery":
        return (
          <Section title={block.props.title || L.shippingAddress}>
            {priceLocked && <PriceLockNote id={LOCK_NOTE_DELIVERY_ID} text={L.paypalEditsLocked} />}
            <div className="grid grid-cols-2 gap-3">
              <Field
                label={L.country}
                className="col-span-2"
                error={shownError("countryCode")}
                field="countryCode"
              >
                <select
                  autoComplete="country"
                  required
                  value={address.countryCode}
                  disabled={locked}
                  // Locked while a PayPal payment is pending, like a read-only field: still focusable
                  // (the lock note is announced with it), but no change is taken (the controlled
                  // value snaps back).
                  aria-disabled={priceLocked || undefined}
                  data-readonly={priceLocked || undefined}
                  onChange={(e) => {
                    if (!priceLocked) setAddress({ ...address, countryCode: e.target.value });
                  }}
                  {...inputProps("countryCode")}
                  aria-describedby={describedBy(inputProps("countryCode")["aria-describedby"], priceLocked && LOCK_NOTE_DELIVERY_ID)}
                  className={inputCls}
                >
                  {countries.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
              {(
                [
                  ["firstName", L.firstName, "given-name", 1],
                  ["lastName", L.lastName, "family-name", 1],
                  ["address1", L.address1, "address-line1", 2],
                  ["address2", L.address2, "address-line2", 2],
                  ["zip", L.zip, "postal-code", 1],
                  ["city", L.city, "address-level2", 1],
                  ["province", L.province, "address-level1", 2],
                  ["phone", L.phone, "tel", 2],
                ] as const
              )
                // Region only where addresses need one (Shopify does the same): a shorter form.
                .filter(([k]) => k !== "province" || NEEDS_PROVINCE.has(address.countryCode) || !!address.province)
                .map(([k, label, auto, span]) => {
                const validated = (FIELD_ORDER as readonly string[]).includes(k);
                // Every delivery field: read-only while a PayPal payment is pending (see priceLocked).
                const readOnly = priceLocked;
                const base = validated ? inputProps(k as FieldKey) : { id: fieldId(k), "aria-describedby": undefined };
                const props = { ...base, readOnly, "aria-describedby": describedBy(base["aria-describedby"], readOnly && LOCK_NOTE_DELIVERY_ID) };
                return (
                  <Field
                    key={k}
                    label={label}
                    className={span === 2 ? "col-span-2" : ""}
                    error={validated ? shownError(k as FieldKey) : undefined}
                    field={k}
                  >
                    {k === "address1" ? (
                      <AddressAutocomplete
                        value={address.address1}
                        enabled={address.countryCode === "FR"}
                        lookup={live}
                        disabled={locked}
                        onChange={(v) => setAddress({ ...address, address1: v })}
                        onPick={(p) => {
                          // A list still open (arrow keys) never changes a locked address.
                          if (priceLocked) return;
                          setAddress({ ...address, ...p });
                          setTouched((t) => ({ ...t, address1: true, zip: true, city: true }));
                        }}
                        className={inputCls}
                        placeholder={L.addressHint}
                        suggestionsLabel={L.addressSuggestions}
                        inputProps={{ ...props, required: true }}
                      />
                    ) : (
                      <input
                        autoComplete={auto}
                        type={k === "phone" ? "tel" : "text"}
                        required={validated}
                        value={address[k]}
                        disabled={locked}
                        inputMode={k === "zip" && address.countryCode === "FR" ? "numeric" : undefined}
                        onChange={(e) =>
                          setAddress({ ...address, [k]: e.target.value })
                        }
                        {...props}
                        className={inputCls}
                      />
                    )}
                  </Field>
                );
              })}
            </div>
          </Section>
        );
      case "shipping_method":
        return (
          <Section title={block.props.title || L.shippingMethod}>
            {shippingEstimated && q.rates.length > 0 && (
              <p className="mb-2.5 flex items-start gap-1.5 text-sm text-neutral-600">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                {L.shippingEstimateHint}
              </p>
            )}
            {q.rates.length === 0 ? (
              <p className="rounded-[var(--radius)] bg-neutral-100 px-4 py-3 text-sm text-neutral-700">
                {rates.length === 0 && mode.kind === "preview"
                  ? "Ajoutez des tarifs dans « Livraison »."
                  : L.noShipping}
              </p>
            ) : (
              <div
                role="radiogroup"
                aria-label={block.props.title || L.shippingMethod}
                className="divide-y divide-[var(--border)] overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-white"
              >
                {q.rates.map((r) => (
                  <label
                    key={r.id}
                    className={`flex min-h-14 cursor-pointer items-center gap-3 px-4 py-3 transition-colors ${shownRateId === r.id ? "bg-[color-mix(in_srgb,var(--accent)_6%,white)]" : ""}`}
                  >
                    <input
                      type="radio"
                      name="rate"
                      checked={shownRateId === r.id}
                      disabled={locked || priceLocked}
                      onChange={() => setRateId(r.id)}
                      className="h-5 w-5 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="flex-1">
                      <span className="block text-sm font-medium">
                        {r.name}
                      </span>
                      {r.deliveryTime && (
                        <span className="block text-xs text-neutral-600">
                          {localizeDeliveryTime(r.deliveryTime, theme.language)}
                        </span>
                      )}
                    </span>
                    <span className="text-right text-sm font-medium">
                      {r.effectiveCents === 0
                        ? L.free
                        : money(r.effectiveCents)}
                    </span>
                  </label>
                ))}
              </div>
            )}
            {pickupSelected &&
              (mode.kind === "live" ? (
                <PickupPicker
                  sessionId={mode.sessionId}
                  country={address.countryCode}
                  addressZip={address.zip}
                  addressCity={address.city}
                  value={validPickup}
                  onChange={(p) => {
                    if (priceLocked) return;
                    setPickupPoint(p);
                    touch("pickup");
                  }}
                  L={L}
                  lang={theme.language}
                  error={shownError("pickup")}
                  inputId={fieldId("pickup")}
                  lockedBy={priceLocked ? LOCK_NOTE_DELIVERY_ID : null}
                />
              ) : (
                <div className="mt-3">
                  <Placeholder>Point relais : le client cherche par code postal et choisit son point ici.</Placeholder>
                </div>
              ))}
          </Section>
        );
      case "shipping_protection": {
        const p = block.props;
        if (!displayLines.some((l) => l.requiresShipping) || protectionPrice <= 0) return mode.kind === "preview" ? <Placeholder>Protection colis : ajoutez un article livré</Placeholder> : null;
        return (
          <label
            className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-[var(--radius)] border px-4 py-3 transition-colors ${protectionOn ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_6%,white)]" : "border-dashed border-neutral-300 bg-white"}`}
          >
            <input
              type="checkbox"
              checked={protectionOn}
              disabled={locked || priceLocked}
              onChange={(e) => setProtectionOn(e.target.checked)}
              className="h-5 w-5 shrink-0 accent-[var(--accent)]"
            />
            <ShieldCheck className="h-6 w-6 shrink-0 text-[var(--accent)]" aria-hidden />
            <span className="flex-1">
              <span data-inline-field="title" className="block text-sm font-medium">
                {p.title || L.protectionTitle}
              </span>
              <span className="block text-xs text-neutral-600">{p.text || L.protectionText}</span>
            </span>
            <span className="text-sm font-semibold">+{money(protectionPrice)}</span>
          </label>
        );
      }
      case "order_addons":
        if (visibleAddOns.length === 0)
          return mode.kind === "preview" ? (
            <Placeholder>
              Options : ajoutez-les dans « Promos &amp; options »
            </Placeholder>
          ) : null;
        return (
          <Section title={block.props.title || L.addons}>
            <div className="space-y-2">
              {visibleAddOns.map((a) => {
                const on = addOnIds.includes(a.id);
                return (
                  <label
                    key={a.id}
                    className={`flex min-h-14 cursor-pointer items-center gap-3 rounded-[var(--radius)] border px-4 py-3 transition-colors ${on ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_6%,white)]" : "border-dashed border-[var(--border)] bg-white"}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={locked || priceLocked}
                      onChange={() =>
                        setAddOnIds(
                          on
                            ? addOnIds.filter((x) => x !== a.id)
                            : [...addOnIds, a.id],
                        )
                      }
                      className="h-5 w-5 shrink-0 accent-[var(--accent)]"
                    />
                    {a.imageUrl && (
                      <SafeImg
                        src={a.imageUrl}
                        alt=""
                        width={40}
                        height={40}
                        className="h-10 w-10 rounded object-cover"
                        fallback={
                          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-neutral-100 text-neutral-400">
                            <Package className="h-5 w-5" aria-hidden />
                          </span>
                        }
                      />
                    )}
                    <span className="flex-1">
                      <span className="block text-sm font-medium">
                        {a.title}
                      </span>
                      {a.description && (
                        <span className="block text-xs text-neutral-600">
                          {a.description}
                        </span>
                      )}
                    </span>
                    <span className="text-sm font-semibold">
                      +{money(a.priceCents)}
                    </span>
                  </label>
                );
              })}
            </div>
          </Section>
        );
      case "payment":
        return (
          <Section
            title={block.props.title || L.payment}
            id="wc-payment"
            sectionRef={paymentRef}
            aside={iconsBlock?.type === "payment_icons" ? <PaymentHeaderLogos methods={paymentLogos} label={iconsBlock.props.label || L.acceptedPaymentMethods} /> : null}
          >
            {mode.kind === "live" && providerSwitched && (
              <p role="status" data-testid="wc-provider-switched" className="mb-3 rounded-[var(--radius)] bg-amber-50 px-4 py-3 text-sm text-amber-900">
                {L.providerSwitched}
              </p>
            )}
            {mode.kind === "live" && prepared?.provider === "stripe" ? (
              // Stripe's Payment Element (same page, same Pay button, same lock and in-flight rules).
              <StripePanel
                prepared={prepared}
                preparing={preparing || qtyPending}
                prepareError={prepareError}
                theme={theme}
                labels={L}
                payLabel={payLabel}
                returnUrl={`${origin}${thankYouUrl}`}
                testMode={mode.testMode}
                confirm={() => confirm(undefined, "stripe")}
                onPaid={onPaid}
                expressWallets={stripeExpressRow}
                onStripeLoadFailed={() => {
                  // Stripe.js blocked or down in this browser: the server switches this buyer to Whop.
                  stripeClientFailed.current = true;
                  setPrepareError(null);
                  setRetryKey((k) => k + 1);
                }}
                beforeButton={termsBox}
                incomplete={incomplete}
                showIncomplete={showAllErrors || Object.keys(touched).length > 0}
                incompleteHint={invalidFields.length === 1 ? (invalidFields[0] === "pickup" ? L.pickupChoose : invalidFields[0] === "terms" ? L.acceptTermsToContinue : undefined) : undefined}
                onIncomplete={revealErrors}
                onRetry={() => {
                  setPrepareError(null);
                  setRetryKey((k) => k + 1);
                }}
                interacted={interacted}
                errorRef={prepareRef}
                onLockChange={setPanelLock}
                inFlightAtLoad={inFlightAtLoad}
                checkPaid={checkPaid}
                externalBusy={expressBusy}
                initialError={mode.paymentFailed ? L.paymentRedirectFailed : null}
              />
            ) : mode.kind === "live" ? (
              <PaymentPanel
                prepared={prepared}
                // A quantity change is re-priced first: no paying the old total meanwhile.
                preparing={preparing || qtyPending}
                prepareError={prepareError}
                theme={theme}
                labels={L}
                payLabel={payLabel}
                returnUrl={`${origin}${thankYouUrl}`}
                testMode={mode.testMode}
                confirm={() => confirm(undefined, "whop")}
                onPaid={onPaid}
                saveCard={!!mode.saveCard}
                beforeButton={termsBox}
                incomplete={incomplete}
                showIncomplete={showAllErrors || Object.keys(touched).length > 0}
                incompleteHint={invalidFields.length === 1 ? (invalidFields[0] === "pickup" ? L.pickupChoose : invalidFields[0] === "terms" ? L.acceptTermsToContinue : undefined) : undefined}
                onIncomplete={revealErrors}
                onRetry={() => {
                  setPrepareError(null);
                  setRetryKey((k) => k + 1);
                }}
                interacted={interacted}
                errorRef={prepareRef}
                onLockChange={setPanelLock}
                paypal={{
                  active: paypalActive,
                  prepared: paypalPrepared,
                  preparing: paypalPreparing || paypalPrepPending || qtyPending || quoteLoading,
                  error: paypalError,
                  autoSubmit: paypalAutoSubmit,
                  onAutoSubmitted: () => setPaypalAutoSubmit(false),
                  onCancel: stopPaypal,
                  onRetry: () => {
                    setPaypalError(null);
                    setPaypalRetryKey((k) => k + 1);
                  },
                  // Ready after all (e.g. after the 20s "not ready" warning): that warning no longer applies.
                  onReady: () => setPaypalError(null),
                  // Whop's own PayPal button (after a blocked window) only for the details confirm() saved.
                  formKey: JSON.stringify([email, address, note, termsAccepted, marketing, pickupSelected ? validPickup : null, paypalPrepSig]),
                  // A PayPal window opened from Whop's own button: the session is PAYING again server
                  // side, so the status checks report it in flight (best effort, nothing to wait for).
                  onWhopWindow: () => {
                    if (!liveSessionId) return;
                    void fetch(`/api/public/sessions/${liveSessionId}/paypal-window`, { method: "POST", keepalive: true }).catch(() => undefined);
                  },
                  // The window of our own PayPal confirm was blocked: that attempt is dropped server
                  // side, so switching to the card isn't refused as in flight (best effort).
                  onWindowBlocked: () => paypalWindowSignal({ blocked: true }),
                  // A PayPal window still open (heartbeat, late popup): liveness only server side.
                  onWindowBeat: () => paypalWindowSignal({ beat: true }),
                  // That window closed: its heartbeat stops counting ~10 s from now.
                  onWindowClosed: () => paypalWindowSignal({ closed: true }),
                  checkPaid,
                }}
                inFlightAtLoad={inFlightAtLoad}
              />
            ) : (
              <PaymentPreview
                labels={L}
                payLabel={payLabel}
                beforeButton={termsBox}
                // Only the wallets whose express button is on (a wallet switched off there stays a tab).
                hideWallets={
                  theme.expressCheckout && layout.blocks.some((b) => b.type === "express" && !b.hidden && b.props.enabled)
                    ? expressShown.wallets
                    : []
                }
              />
            )}
          </Section>
        );
      default:
        return <ContentBlock block={block} ctx={ctx} />;
    }
  }

  const summaryLeft = theme.summarySide === "left";
  const widths = {
    narrow: { form: 480, summary: 400 },
    normal: { form: 560, summary: 440 },
    wide: { form: 640, summary: 500 },
  }[theme.contentWidth];

  const summaryProps = {
    showImages: theme.summaryImages,
    L,
    lines: displayLines,
    totals,
    money,
    hasDiscounts,
    onQty: changeQty,
    cartUrl: cartUrl ?? null,
    qtyPending: live && qtyPending,
    qtyError,
    volumeNudge: volumeNudge
      ? {
          text: (() => {
            const deal = dealText(volumeNudge.tier);
            return deal ? L.volumeNudgeDeal(volumeNudge.missing, deal) : L.volumeNudge(volumeNudge.missing, pct(volumeNudge.tier.percent));
          })(),
          target: volumeNudge.target,
        }
      : null,
    volumeApplied:
      volumeBreak?.current && !volumeNudge
        ? (() => {
            const deal = dealText(volumeBreak.current);
            return deal ? L.volumeAppliedDeal(deal) : L.volumeApplied(pct(volumeBreak.current.percent));
          })()
        : null,
    volumeLabel: volumeBreak?.current
      ? (() => {
          const deal = dealText(volumeBreak.current);
          return deal ? L.volumeRowDeal(deal) : L.volumeRow(pct(volumeBreak.current.percent));
        })()
      : L.discount,
    automaticLabel: live ? (quote?.automaticDiscount?.titles?.join(" · ") ?? null) : null,
    giftLines: live && !qtyPending ? giftLines : [],
    giftNudge,
    codeInput,
    setCodeInput: (v: string) => {
      setCodeInput(v);
      if (codeError) setCodeError(null);
    },
    appliedCode: live ? q.appliedCode : null,
    // What the code takes off (quantity-break savings excluded), shown on the applied-code chip.
    appliedAmount: (() => {
      const promo = totals.codeDiscountCents ?? totals.discountCents - Math.min(totals.discountCents, (totals.volumeDiscountCents ?? 0) + (totals.automaticDiscountCents ?? 0));
      return live && q.appliedCode && promo > 0 ? `−${money(promo)}` : null;
    })(),
    discountError:
      live && codeError && codeError.code.trim().toLowerCase() === codeInput.trim().toLowerCase() ? codeError.message : null,
    discountNotice: !!codeError?.notice,
    promoSource,
    onApply: (source: string) => {
      if (priceLocked) return;
      setCodeError(null);
      setPromoSource(source);
      setAppliedCode(codeInput.trim() || null);
    },
    onRemove: () => {
      if (priceLocked) return;
      // "" (not null): the buyer removed the code — the Shopify cart's own code isn't re-applied.
      setAppliedCode("");
      setCodeError(null);
      setCodeInput("");
    },
    // Quantities, line removal, the volume nudge and the discount code: see priceLocked.
    locked: locked || priceLocked,
    lockNote: priceLocked ? L.paypalEditsLocked : null,
    shippingValue: !displayLines.some((l) => l.requiresShipping)
      ? null
      : q.shippingRateId
        ? totals.shippingCents === 0
          ? L.free
          : money(totals.shippingCents)
        : address.address1.trim() && address.zip.trim()
          ? "—"
          : L.shippingCalculated,
    shippingEstimated: shippingEstimated && !!q.shippingRateId,
    currency,
    vatNote: theme.vatNote,
    // Charged in the buyer's currency (store option): the exact amount; else an explicitly informative estimate.
    localEstimate:
      live && quote?.charge && quote.charge.totalCents > 0
        ? L.chargedIn(
            new Intl.NumberFormat(localeOf(theme.language), { style: "currency", currency: quote.charge.currency, currencyDisplay: "code" }).format(quote.charge.totalCents / 100),
            currency,
          )
        : estimate
          ? L.localEstimate(estimate.amount, currency)
          : null,
  };

  // Reassurance shown after the payment step on small screens (in the summary column on desktop).
  // Widgets placed in the form column (payment logos, secure badge, guarantee next to the payment)
  // come first, right under the pay button; blocks placed in the summary follow.
  const mobileAfterPay = [...arranged.side, ...arranged.summary];

  return (
    <div
      lang={theme.language}
      style={themeVars(theme)}
      className="wc-checkout min-h-full"
      onPointerDownCapture={interacted ? undefined : () => setInteracted(true)}
      onKeyDownCapture={interacted ? undefined : () => setInteracted(true)}
    >
      <div className="@container/wc-page min-h-full overflow-x-clip" data-inputs={theme.inputStyle}>
        <StoreHeader theme={theme} homeUrl={storeHomeUrl(cartUrl)} />

        {/* Mobile summary toggle */}
        <div
          className="border-b border-[var(--border)] @3xl:hidden"
          style={{ background: theme.summaryBackground || undefined }}
        >
          <button
            type="button"
            onClick={() => setSummaryOpen(!summaryOpen)}
            className="flex min-h-14 w-full items-center justify-between px-5 py-4 text-sm"
            aria-expanded={summaryOpen}
            aria-controls="wc-mobile-summary"
          >
            <span className="flex items-center gap-1.5 font-medium text-[var(--text)]">
              {summaryOpen ? L.hideSummary : L.showSummary}
              <ChevronDown
                className={`h-4 w-4 transition-transform ${summaryOpen ? "rotate-180" : ""}`}
                aria-hidden
              />
            </span>
            <span className="text-base font-semibold">
              {money(totals.totalCents)}
            </span>
          </button>
          {summaryOpen && (
            <section id="wc-mobile-summary" aria-label={L.summary} className="px-5 pb-5">
              {/* One code field on small screens: the page's (above Payment) when there is one. */}
              <OrderSummary {...summaryProps} idPrefix="m-" hidePromo={summaryProps.hasDiscounts && arranged.main.some((b) => b.type === "payment")} />
            </section>
          )}
        </div>

        <div
          className={`grid @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] ${summaryLeft ? "@3xl:[direction:rtl]" : ""}`}
        >
          <main
            className={`px-5 py-6 [direction:ltr] @3xl:flex @3xl:px-10 @3xl:py-10 ${live ? "pb-28 @3xl:pb-10" : ""} ${summaryLeft ? "@3xl:justify-start @3xl:border-l" : "@3xl:justify-end @3xl:border-r"} @3xl:border-[var(--border)]`}
            style={{ background: theme.formBackground || undefined }}
          >
            <div className="wc-bleed-col mx-auto w-full space-y-4 @3xl:mx-0" style={{ maxWidth: widths.form }}>
              <h1 className="sr-only">
                {theme.storeName ? `${theme.storeName} · ${L.checkoutTitle}` : L.checkoutTitle}
              </h1>
              <CheckoutSteps L={L} cartUrl={cartUrl ?? null} />
              {arranged.main.map((b) =>
                b.type === "payment" && (summaryProps.hasDiscounts || recoMobile) ? (
                  <div key={`promo-${b.id}`} className="space-y-4">
                    {/* Small screens: suggestions and the code field are on the page, not only in the folded summary. */}
                    {recoMobile && <div className="@3xl:hidden">{recoMobile}</div>}
                    {summaryProps.hasDiscounts && (
                      <div className="@3xl:hidden">
                        <PromoForm {...summaryProps} idPrefix="p-" />
                      </div>
                    )}
                    {wrap(b, renderSection(b))}
                  </div>
                ) : (
                  wrap(b, renderSection(b))
                ),
              )}
              {mobileAfterPay.length > 0 && (
                <div className="space-y-1 pt-2 @3xl:hidden">
                  {mobileAfterPay.map((b) => wrap(b, <ContentBlock block={b} ctx={ctx} />, "m-"))}
                </div>
              )}
              {arranged.after.map((b) => wrap(b, <ContentBlock block={b} ctx={ctx} />))}
              <Footer theme={theme} languageSwitcher={live} />
            </div>
          </main>
          <aside
            aria-label={L.summary}
            className={`hidden px-5 py-6 [direction:ltr] @3xl:flex @3xl:px-10 @3xl:py-10 ${summaryLeft ? "@3xl:justify-end" : "@3xl:justify-start"}`}
            style={{ background: theme.summaryBackground || undefined }}
          >
            <div
              className="sticky top-[calc(var(--wc-sticky-top,0px)+1.5rem)] h-fit w-full space-y-4"
              style={{ maxWidth: widths.summary }}
            >
              <OrderSummary {...summaryProps} idPrefix="d-" />
              {recoNode("d-")}
              {(arranged.summary.length > 0 || arranged.side.length > 0) && (
                <div className="space-y-1 border-t border-[var(--border)] pt-3">
                  {arranged.summary.map((b) => wrap(b, <ContentBlock block={b} ctx={ctx} />))}
                  {arranged.side.map((b) => wrap(b, <ContentBlock block={b} ctx={ctx} />))}
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {totalAnnouncement}
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {qtyAnnouncement}
      </p>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {savedNotice}
      </p>

      {/* Sticky pay bar (small screens, live only) while the payment step is off-screen. */}
      {live && (
        <div
          role="region"
          aria-label={L.goToPayment}
          aria-hidden={!paymentOffscreen}
          className={`wc-paybar fixed inset-x-0 bottom-0 z-40 border-t border-[var(--border)] bg-white/95 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] shadow-[0_-8px_24px_-12px_rgba(0,0,0,.18)] backdrop-blur md:hidden ${paymentOffscreen ? "translate-y-0" : "pointer-events-none translate-y-full"}`}
        >
          <div className="mx-auto flex max-w-[560px] items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-neutral-600">{L.total}</p>
              <p className="truncate text-lg font-semibold">{money(totals.totalCents)}</p>
            </div>
            <button
              type="button"
              tabIndex={paymentOffscreen ? 0 : -1}
              onClick={goToPayment}
              className="flex min-h-12 items-center justify-center rounded-[var(--btn-radius)] bg-[image:var(--accent-bg)] px-5 text-sm font-semibold text-[var(--accent-fg)] shadow-[var(--btn-shadow)]"
            >
              {L.goToPayment}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const noopSubscribe = () => () => {};

function isPromise<T>(v: unknown): v is Promise<T> {
  return !!v && typeof (v as { then?: unknown }).then === "function";
}

/**
 * "Complétez votre commande" from the server's streamed promise: rendered with use() (inside the
 * caller's <Suspense>, so in the server HTML when Shopify answered in time), and handed to the page
 * (onLoad) for the lines the buyer adds from it.
 */
function StreamedRecommendations({
  promise,
  onLoad,
  render,
}: {
  promise: Promise<RecommendationView[] | null>;
  onLoad: (r: RecommendationView[] | null) => void;
  render: (r: RecommendationView[] | null) => ReactNode;
}) {
  const value = use(promise);
  useEffect(() => {
    onLoad(value);
  }, [value, onLoad]);
  return <>{render(value)}</>;
}

/**
 * Product photo of a summary line, or a neutral placeholder of the same size (no photo,
 * or it failed to load). Shared by the checkout summaries and the thank-you recap.
 */
export function LineThumb({ src, size, gift = false }: { src: string | null | undefined; size: 48 | 64; gift?: boolean }) {
  const box = `${size === 64 ? "h-16 w-16" : "h-12 w-12"} shrink-0 rounded-[calc(var(--radius)*0.8)] border border-neutral-200`;
  const Icon = gift ? Gift : Package;
  const placeholder = (
    <span className={`flex items-center justify-center bg-neutral-100 text-neutral-400 ${box}`} aria-hidden>
      <Icon className={size === 64 ? "h-6 w-6" : "h-5 w-5"} />
    </span>
  );
  if (!src) return placeholder;
  return <SafeImg src={src} alt="" width={size} height={size} className={`bg-white object-cover ${box}`} fallback={placeholder} />;
}

function isSection(b: Block) {
  return (
    b.type === "express" ||
    b.type === "contact" ||
    b.type === "delivery" ||
    b.type === "shipping_method" ||
    b.type === "payment" ||
    b.type === "order_addons" ||
    b.type === "shipping_protection"
  );
}

// Look depends on theme.inputStyle via [data-inputs] rules in globals.css
const inputCls = "wc-input";

function Section({
  title,
  id,
  sectionRef,
  aside,
  children,
}: {
  title: string;
  id?: string;
  sectionRef?: Ref<HTMLElement>;
  /** Shown at the end of the title row (the Payment section's accepted-method logos). */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const headingId = id ? `${id}-title` : undefined;
  const heading = (
    <h2 id={headingId} data-inline-field="title" className={`${aside ? "" : "mb-3 "}font-[family-name:var(--heading-font)] text-lg font-semibold tracking-tight`}>
      {title}
    </h2>
  );
  return (
    <section id={id} ref={sectionRef} aria-labelledby={headingId} className="scroll-mt-4">
      {aside ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          {heading}
          {aside}
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}

function Field({
  label,
  error,
  field,
  className = "",
  children,
}: {
  label: string;
  error?: string;
  field: string;
  className?: string;
  children: ReactNode;
}) {
  const id = fieldId(field);
  return (
    <div className={className} data-field={field}>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-neutral-700">
        {label}
      </label>
      <div className="relative">{children}</div>
      {error && (
        <p id={`${id}-error`} className="mt-1 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function OrderSummary(props: {
  showImages: boolean;
  L: Labels;
  lines: CartLine[];
  totals: Totals;
  money: (c: number) => string;
  hasDiscounts: boolean;
  codeInput: string;
  setCodeInput: (v: string) => void;
  appliedCode: string | null;
  appliedAmount?: string | null;
  discountError: string | null;
  /** The "error" is a neutral notice (code valid but not combinable): no red, no aria-invalid. */
  discountNotice?: boolean;
  /** idPrefix of the promo form that was submitted: only that copy shows the error. */
  promoSource: string | null;
  onApply: (source: string) => void;
  onRemove: () => void;
  locked: boolean;
  /** Why the summary is locked, when a PayPal payment is pending (see priceLocked). */
  lockNote?: string | null;
  /** The code field is already on the page (small screens): not repeated in the folded summary. */
  hidePromo?: boolean;
  /** null when nothing ships (no shipping row). */
  shippingValue: string | null;
  /** The shipping price comes from the pre-filled country, before any address. */
  shippingEstimated?: boolean;
  currency: string;
  vatNote?: string;
  idPrefix: string;
  /** Quantity stepper: new quantity for a line (0 removes it). */
  onQty: (line: CartLine, quantity: number) => void;
  /** The shop's cart: lines fixed by the cart (bundles, app prices, personalization) are changed there. */
  cartUrl?: string | null;
  /** A quantity change is being re-priced: totals are about to change. */
  qtyPending: boolean;
  qtyError: string | null;
  /** "1 more item for −15 %" with a one-tap "+1" on the cheapest line. */
  volumeNudge: { text: string; target: CartLine | null } | null;
  /** "−10 % volume discount applied" (no further tier). */
  volumeApplied: string | null;
  /** Label of the quantity-break row in the totals. */
  volumeLabel: string;
  /** Names of Shopify's automatic discounts applied to the cart. */
  automaticLabel?: string | null;
  /** Free gifts of the quantity-break tiers (price 0, real price struck through). */
  giftLines: CartLine[];
  /** "12 € more to get <gift>". */
  giftNudge: string | null;
  /** "≈ 52,30 CHF · débité en EUR…" for buyers paying in another currency. */
  localEstimate?: string | null;
}) {
  const { L, lines, totals, money } = props;
  const compareSavings = lines.reduce(
    (s, l) =>
      s +
      (l.compareAtCents != null && l.compareAtCents > l.unitPriceCents
        ? (l.compareAtCents - l.unitPriceCents) * l.quantity
        : 0),
    0,
  );
  const savings = compareSavings + totals.discountCents;
  const volumeCents = Math.min(totals.discountCents, totals.volumeDiscountCents ?? 0);
  // Shopify's automatic discounts of the cart (e.g. "Soldes d'été"), shown under their own name.
  const automaticCents = Math.min(totals.discountCents - volumeCents, totals.automaticDiscountCents ?? 0);
  const promoCents = totals.discountCents - volumeCents - automaticCents;
  const canRemove = lines.length > 1 && !props.locked;
  return (
    <div className="space-y-5">
      {props.lockNote && <PriceLockNote text={props.lockNote} />}
      <ul className="space-y-4">
        {lines.map((l, idx) => {
          const max = maxQty(l);
          return (
            <li key={`${l.variantId}-${idx}`} className="flex items-start gap-3">
              {/* Images on: every line keeps its 64 px slot (placeholder when a product has no photo), so rows stay aligned. */}
              {props.showImages && (
                <div className="relative shrink-0">
                  <LineThumb src={l.imageUrl} size={64} />
                  {/* No quantity badge: the stepper next to the title already shows it. */}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-words">{l.title}</p>
                {l.variantTitle && (
                  <p className="text-xs text-neutral-600">{l.variantTitle}</p>
                )}
                {/* Line item properties the buyer entered ("Gravure : Léa"); "_…" ones stay hidden, like on Shopify. */}
                {visibleProperties(l).map((p) => (
                  <p key={p.name} className="text-xs break-words text-neutral-600" data-testid="line-property">
                    {p.name} : {/^https?:\/\//.test(p.value) ? <a href={p.value} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{p.value.split("/").pop()}</a> : p.value}
                  </p>
                ))}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <div
                    role="group"
                    aria-label={`${l.title} · ${L.quantity(l.quantity)}`}
                    className="inline-flex items-center rounded-full border border-neutral-300 bg-white"
                  >
                    <StepButton
                      label={L.qtyDecrease(l.title)}
                      disabled={props.locked || l.locked || l.quantity <= 1}
                      onClick={() => props.onQty(l, l.quantity - 1)}
                    >
                      <Minus className="h-3.5 w-3.5" aria-hidden />
                    </StepButton>
                    <span className="min-w-7 text-center text-sm font-medium tabular-nums" aria-hidden>
                      {l.quantity}
                    </span>
                    <StepButton
                      label={l.quantity >= max ? `${L.qtyIncrease(l.title)} (${L.qtyMax})` : L.qtyIncrease(l.title)}
                      disabled={props.locked || l.locked || l.quantity >= max}
                      onClick={() => props.onQty(l, l.quantity + 1)}
                    >
                      <Plus className="h-3.5 w-3.5" aria-hidden />
                    </StepButton>
                  </div>
                  {l.locked && (
                    // Bundle / app price / personalization: the Shopify cart holds this line's quantity.
                    <span className="text-xs text-neutral-600" data-testid="locked-line">
                      {props.cartUrl ? (
                        <a href={props.cartUrl} className="underline underline-offset-2 hover:text-neutral-900" title={L.lockedLineQty}>
                          {L.lockedLineEdit}
                        </a>
                      ) : (
                        L.lockedLineQty
                      )}
                    </span>
                  )}
                  {canRemove && !l.locked && (
                    <button
                      type="button"
                      onClick={() => props.onQty(l, 0)}
                      aria-label={L.qtyRemove(l.title)}
                      className="inline-flex min-h-11 items-center gap-1 text-xs text-neutral-700 underline underline-offset-2 hover:text-neutral-900"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                      {L.remove}
                    </button>
                  )}
                </div>
              </div>
              <div className="text-right text-sm">
                {l.compareAtCents != null &&
                  l.compareAtCents > l.unitPriceCents && (
                    <p className="text-xs text-neutral-600 line-through">
                      {money(l.compareAtCents * l.quantity)}
                    </p>
                  )}
                <p className="font-medium">
                  {money(l.unitPriceCents * l.quantity)}
                </p>
              </div>
            </li>
          );
        })}
      </ul>

      {props.giftLines.length > 0 && (
        <ul className="-mt-1 space-y-3" aria-label={L.giftFree}>
          {props.giftLines.map((l) => (
            <li key={`gift-${l.variantId}`} className="flex items-center gap-3">
              {props.showImages && <LineThumb src={l.imageUrl} size={64} gift />}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium break-words">{l.title}</p>
                {l.variantTitle && <p className="text-xs text-neutral-600">{l.variantTitle}</p>}
                <p className="mt-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-800">
                  <Gift className="h-3.5 w-3.5" aria-hidden />
                  {L.giftFree}
                </p>
              </div>
              <div className="text-right text-sm">
                {l.compareAtCents ? <p className="text-xs text-neutral-600 line-through">{money(l.compareAtCents)}</p> : null}
                <p className="font-medium">{L.free}</p>
              </div>
            </li>
          ))}
        </ul>
      )}

      {props.giftNudge && (
        <p className="-mt-1 flex min-h-11 items-center gap-2 rounded-[var(--radius)] bg-[color-mix(in_srgb,var(--accent)_8%,white)] px-3 py-1.5 text-sm font-medium">
          <Gift className="h-4 w-4 shrink-0 text-[var(--focus)]" aria-hidden />
          {props.giftNudge}
        </p>
      )}

      {/* Announced once through the page's quantity live region (both summary copies render this). */}
      {props.qtyError && (
        <p className="-mt-2 text-sm text-red-700">
          {props.qtyError}
        </p>
      )}

      {(props.volumeNudge || props.volumeApplied) && (
        <div className="-mt-1 flex min-h-11 items-center gap-2 rounded-[var(--radius)] bg-[color-mix(in_srgb,var(--accent)_8%,white)] px-3 py-1.5 text-sm">
          {props.volumeNudge ? (
            <>
              <TrendingDown className="h-4 w-4 shrink-0 text-[var(--focus)]" aria-hidden />
              <span className="min-w-0 flex-1 font-medium">{props.volumeNudge.text}</span>
              {props.volumeNudge.target && !props.locked && (
                <button
                  type="button"
                  onClick={() => props.onQty(props.volumeNudge!.target!, props.volumeNudge!.target!.quantity + 1)}
                  aria-label={L.volumeAddOne(props.volumeNudge.target.title)}
                  className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-[var(--btn-radius)] bg-[image:var(--accent-bg)] px-3 text-sm font-semibold text-[var(--accent-fg)]"
                >
                  +1
                </button>
              )}
            </>
          ) : (
            <>
              <Check className="h-4 w-4 shrink-0 text-emerald-700" strokeWidth={2.5} aria-hidden />
              <span className="font-medium text-emerald-800">{props.volumeApplied}</span>
            </>
          )}
        </div>
      )}

      {props.hasDiscounts && !props.hidePromo && <PromoForm {...props} />}

      <dl
        className={`space-y-2 text-sm transition-opacity motion-reduce:transition-none ${props.qtyPending ? "opacity-60" : ""}`}
        aria-busy={props.qtyPending || undefined}
      >
        <Row
          label={`${L.subtotal} · ${L.items(totals.itemCount)}`}
          value={money(totals.subtotalCents)}
        />
        {automaticCents > 0 && <Row label={props.automaticLabel || L.automaticDiscount} value={`−${money(automaticCents)}`} />}
        {volumeCents > 0 && <Row label={props.volumeLabel} value={`−${money(volumeCents)}`} />}
        {promoCents > 0 && (
          <Row label={props.appliedCode ? `${L.discount} · ${props.appliedCode}` : L.discount} value={`−${money(promoCents)}`} />
        )}
        {totals.addOnsCents - (totals.protectionCents ?? 0) > 0 && (
          <Row label={L.addonsTotal} value={money(totals.addOnsCents - (totals.protectionCents ?? 0))} />
        )}
        {(totals.protectionCents ?? 0) > 0 && <Row label={L.protectionRow} value={money(totals.protectionCents!)} />}
        {props.shippingValue != null && (
          <Row
            label={props.shippingEstimated ? `${L.shipping} · ${L.estimated.toLowerCase()}` : L.shipping}
            value={props.shippingValue}
          />
        )}
        <div className="flex items-baseline justify-between border-t border-neutral-200 pt-3">
          <dt className="text-base font-semibold">{L.total}</dt>
          <dd className="text-right text-xl font-semibold">
            <span className="mr-1.5 text-xs font-normal text-neutral-600">
              {props.currency}
            </span>
            {money(totals.totalCents)}
            {props.vatNote && (
              <span className="block text-xs font-normal text-neutral-600">
                {props.vatNote}
              </span>
            )}
          </dd>
        </div>
      </dl>
      {props.localEstimate && <p className="-mt-3 text-right text-xs text-neutral-600">{props.localEstimate}</p>}
      {savings > 0 && (
        <p className="-mt-3 flex items-center justify-end gap-1.5 text-sm font-semibold text-emerald-700">
          <Tag className="h-3.5 w-3.5" aria-hidden />
          {L.youSave(money(savings))}
        </p>
      )}
    </div>
  );
}

type PromoProps = {
  L: Labels;
  codeInput: string;
  setCodeInput: (v: string) => void;
  appliedCode: string | null;
  /** "−9,70 €": the code's saving, next to the applied code. */
  appliedAmount?: string | null;
  discountError: string | null;
  discountNotice?: boolean;
  promoSource: string | null;
  onApply: (source: string) => void;
  onRemove: () => void;
  locked: boolean;
  idPrefix: string;
};

/** Discount code field (summary column, mobile drawer, and above "Payment" on small screens). */
function PromoForm(props: PromoProps) {
  const { L } = props;
  const errorId = `${props.idPrefix}discount-error`;
  // Only the copy that was submitted shows (and announces) the error.
  const discountError = props.promoSource === props.idPrefix ? props.discountError : null;
  const invalid = !!discountError && !props.discountNotice;
  // Keyboard focus follows the action in the copy that was used: once the code is applied, to
  // its "Remove" button (or the chip itself when the checkout is locked); once removed, back to
  // the field. Both are async (the quote answers), so the intent waits for the change.
  const pendingFocus = useRef<"applied" | "removed" | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  const applied = !!props.appliedCode;
  useEffect(() => {
    if (pendingFocus.current === "applied" && applied) {
      pendingFocus.current = null;
      (removeRef.current ?? chipRef.current)?.focus();
    } else if (pendingFocus.current === "removed" && !applied) {
      pendingFocus.current = null;
      inputRef.current?.focus();
    }
  }, [applied]);
  // A rejected code: focus stays in the field, no later jump.
  useEffect(() => {
    if (discountError && pendingFocus.current === "applied") pendingFocus.current = null;
  }, [discountError]);
  return (
    <div>
      {props.appliedCode ? (
        <div
          ref={chipRef}
          tabIndex={-1}
          className="flex min-h-11 items-center justify-between gap-2 rounded-[var(--radius)] bg-white pr-0.5 pl-3 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus,#111827)]"
        >
          <span className="min-w-0">
            <Tag className="mr-1 inline h-3.5 w-3.5 text-[var(--accent)]" aria-hidden />
            <strong className="break-all">{props.appliedCode}</strong>
            {props.appliedAmount && <span className="ml-1.5 font-medium whitespace-nowrap text-emerald-700 tabular-nums">{props.appliedAmount}</span>}
          </span>
          {!props.locked && (
            <button
              ref={removeRef}
              type="button"
              onClick={() => {
                pendingFocus.current = "removed";
                props.onRemove();
              }}
              aria-label={L.removeCode(props.appliedCode)}
              // Inset focus ring: stays inside the chip instead of spilling over its edge.
              className="min-h-11 shrink-0 rounded-[calc(var(--radius)*0.8)] px-2.5 text-neutral-700 underline focus-visible:-outline-offset-2!"
            >
              {L.remove}
            </button>
          )}
        </div>
      ) : (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            pendingFocus.current = "applied";
            props.onApply(props.idPrefix);
          }}
        >
          <input
            ref={inputRef}
            value={props.codeInput}
            disabled={props.locked}
            onChange={(e) => props.setCodeInput(e.target.value)}
            placeholder={L.discountCode}
            aria-label={L.discountCode}
            autoComplete="off"
            aria-invalid={invalid ? true : undefined}
            aria-describedby={discountError ? errorId : undefined}
            className={inputCls}
          />
          <button
            type="submit"
            disabled={props.locked || !props.codeInput.trim()}
            className="min-h-11 shrink-0 rounded-[var(--radius)] border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-900 disabled:text-neutral-500"
          >
            {L.apply}
          </button>
        </form>
      )}
      {props.promoSource === props.idPrefix && (
        <p
          id={errorId}
          role={props.discountNotice ? "status" : "alert"}
          className={`text-sm empty:hidden [&:not(:empty)]:mt-1.5 ${props.discountNotice ? "flex items-start gap-1.5 text-neutral-700" : "text-red-700"}`}
        >
          {discountError && props.discountNotice && <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-500" aria-hidden />}
          {discountError ?? ""}
        </p>
      )}
    </div>
  );
}

/** − / + of the quantity stepper: 36 px circle, 44 px touch target. */
function StepButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="relative flex h-9 w-9 items-center justify-center rounded-full text-neutral-800 transition-colors after:absolute after:-inset-1 after:content-[''] hover:bg-neutral-100 disabled:cursor-not-allowed disabled:text-neutral-400 disabled:hover:bg-transparent motion-reduce:transition-none"
    >
      {children}
    </button>
  );
}

/** "J'accepte les CGV" text, linking to the terms page when the merchant set one. */
function TermsText({
  L,
  theme,
  express,
}: {
  L: Labels;
  theme: Theme;
  express?: boolean;
}) {
  const href =
    theme.termsUrl ||
    theme.policyLinks.find((p) => /cgv|condition|terms/i.test(p.label))?.url ||
    "";
  if (express) {
    return (
      <p className="mt-2 text-center text-xs text-neutral-600">
        {/* Same terms page as the checkbox's link, when the merchant set one. */}
        {href ? (
          <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">
            {L.expressTerms}
          </a>
        ) : (
          L.expressTerms
        )}
      </p>
    );
  }
  return (
    <>
      {L.acceptTerms}{" "}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          {L.termsLink}
        </a>
      ) : (
        L.termsLink
      )}
    </>
  );
}

/**
 * "Panier › Paiement" on wide screens (one-page checkout: the cart step links back to the
 * Shopify cart); a single "Back to cart" link on small screens.
 */
function CheckoutSteps({ L, cartUrl }: { L: Labels; cartUrl: string | null }) {
  const current = "payment";
  const steps = [
    { key: "cart", label: L.stepCart },
    { key: "payment", label: L.stepPayment },
  ] as const;
  return (
    <>
      <nav aria-label={L.checkoutSteps} className="hidden @3xl:block">
        <ol className="flex flex-wrap items-center gap-1.5 text-[13px] text-neutral-600">
          {steps.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1.5">
              {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-neutral-400" aria-hidden />}
              {s.key === "cart" && cartUrl ? (
                <a href={cartUrl} className="rounded-sm text-[var(--text)] underline underline-offset-2 hover:no-underline">
                  {s.label}
                </a>
              ) : (
                <span
                  aria-current={s.key === current ? "step" : undefined}
                  className={s.key === current ? "font-semibold text-[var(--text)]" : undefined}
                >
                  {s.label}
                </span>
              )}
            </li>
          ))}
        </ol>
      </nav>
      {cartUrl && (
        <a
          href={cartUrl}
          className="-mt-1 inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-neutral-700 underline-offset-2 hover:underline @3xl:hidden"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden />
          {L.backToCart}
        </a>
      )}
    </>
  );
}

/** "PayPal payment in progress: changes are locked", over the fields and summary it locks. */
function PriceLockNote({ text, id }: { text: string; id?: string }) {
  return (
    <p id={id} className="mb-3 flex items-start gap-1.5 rounded-[var(--radius)] bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="wc-price-locked">
      <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      {text}
    </p>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-neutral-700">{label}</dt>
      <dd className="text-right font-medium">{value}</dd>
    </div>
  );
}
