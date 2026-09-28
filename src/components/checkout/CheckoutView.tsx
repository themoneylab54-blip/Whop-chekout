"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Tag } from "lucide-react";
import type { Block, Layout, Theme } from "@/lib/layout";
import {
  computeTotals,
  formatMoney,
  ratesForCountry,
  type CartLine,
  type RateInput,
  type Totals,
} from "@/lib/pricing";
import {
  ContentBlock,
  isEmptyInLive,
  Placeholder,
  StyledBlock,
  type ContentContext,
} from "./blocks";
import { countryName, DEFAULT_COUNTRIES, labelsFor, type Labels } from "./i18n";
import { AddressAutocomplete } from "./AddressAutocomplete";
import {
  ExpressCheckout,
  ExpressPreview,
  PaymentPanel,
  PaymentPreview,
  type ConfirmResult,
  type Prepared,
} from "./Payment";

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
  | { kind: "live"; sessionId: string; testMode: boolean; saveCard?: boolean };

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
};

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
    "--muted": `color-mix(in srgb, ${theme.textColor} 60%, white)`,
    "--border": theme.borderColor,
    "--heading-font":
      theme.headingFont === "same" ? body : fontStack(theme.headingFont),
    fontFamily: body,
    fontSize: { sm: "14px", md: "15px", lg: "16px" }[theme.fontScale],
    color: theme.textColor,
    background: theme.pageBackground || "#ffffff",
  } as CSSProperties;
}

function readableOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6
    ? "#111111"
    : "#ffffff";
}

export function StoreHeader({ theme }: { theme: Theme }) {
  const justify = {
    left: "justify-start",
    center: "justify-center",
    right: "justify-end",
  }[theme.headerAlign];
  return (
    <header
      className={theme.headerBorder ? "border-b border-[var(--border)]" : ""}
      style={{ background: theme.headerBackground }}
    >
      <div
        className={`mx-auto flex max-w-[1100px] items-center gap-3 px-5 py-4 ${justify}`}
      >
        {theme.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={theme.logoUrl}
            alt={theme.storeName}
            style={{ height: theme.logoHeight }}
            className="w-auto object-contain"
          />
        )}
        {theme.showStoreName && theme.storeName && (
          <span
            className="font-[family-name:var(--heading-font)] text-xl font-semibold tracking-tight"
            style={{
              color:
                readableOn(theme.headerBackground) === "#ffffff"
                  ? "#fff"
                  : undefined,
            }}
          >
            {theme.storeName}
          </span>
        )}
        {!theme.logoUrl && !theme.storeName && (
          <span className="text-xl font-semibold text-neutral-300">
            Ma boutique
          </span>
        )}
      </div>
    </header>
  );
}

export function Footer({ theme }: { theme: Theme }) {
  if (!theme.trustLine && theme.policyLinks.length === 0) return null;
  return (
    <footer className="mt-8 border-t border-neutral-200 pt-4 text-xs text-neutral-500">
      {theme.trustLine && <p>{theme.trustLine}</p>}
      {theme.policyLinks.length > 0 && (
        <nav className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {theme.policyLinks.map((l, i) => (
            <a
              key={i}
              href={l.url || undefined}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              {l.label}
            </a>
          ))}
        </nav>
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

export function CheckoutView({
  theme,
  layout,
  currency,
  lines,
  rates,
  addOns,
  hasDiscounts,
  mode,
  initialEmail,
}: Props) {
  const L = labelsFor(theme.language);
  const router = useRouter();
  const live = mode.kind === "live";
  const money = useCallback(
    (c: number) =>
      formatMoney(c, currency, theme.language === "fr" ? "fr-FR" : "en-US"),
    [currency, theme.language],
  );

  const countries = useMemo(() => {
    const active = rates.filter((r) => r.active);
    const all = active.some((r) => r.countries.length === 0);
    const list = all
      ? DEFAULT_COUNTRIES
      : [...new Set(active.flatMap((r) => r.countries))];
    return (list.length ? list : DEFAULT_COUNTRIES)
      .map((c) => ({ code: c, name: countryName(c, theme.language) }))
      .sort((a, b) => a.name.localeCompare(b.name, theme.language));
  }, [rates, theme.language]);

  const [email, setEmail] = useState(initialEmail ?? "");
  const [marketing, setMarketing] = useState(false); // never pre-checked (GDPR)
  const [termsAccepted, setTermsAccepted] = useState(false); // never pre-checked (consumer law)
  const [address, setAddress] = useState<Address>(() => ({
    ...EMPTY_ADDRESS,
    countryCode:
      countries.find((c) => c.code === (theme.language === "fr" ? "FR" : "US"))
        ?.code ??
      countries[0]?.code ??
      "FR",
  }));
  const [rateId, setRateId] = useState<string | null>(null);
  const [codeInput, setCodeInput] = useState("");
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  // A rejected code is dropped right away (so it never blocks payment) but its message stays.
  const [codeError, setCodeError] = useState<string | null>(null);
  const [mountedAt] = useState(() => Date.now());
  const [addOnIds, setAddOnIds] = useState<string[]>([]);
  const [quote, setQuote] = useState<QuoteState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [note, setNote] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);

  /* ---------- totals ---------- */

  const localQuote = useMemo<QuoteState>(() => {
    const available = ratesForCountry(rates, address.countryCode);
    const rate = available.find((r) => r.id === rateId) ?? available[0] ?? null;
    const selected = addOns
      .filter((a) => addOnIds.includes(a.id))
      .map((a) => ({ ...a, active: true }));
    const totals = computeTotals({
      lines,
      rate,
      discount: null,
      addOns: selected,
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
  }, [rates, address.countryCode, rateId, addOns, addOnIds, lines]);

  const liveSessionId = mode.kind === "live" ? mode.sessionId : null;
  useEffect(() => {
    if (!liveSessionId) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/public/sessions/${liveSessionId}/quote`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            countryCode: address.countryCode,
            shippingRateId: rateId,
            discountCode: appliedCode,
            addOnIds,
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) return;
        const q = await res.json();
        if (q.discountError) {
          setCodeError(q.discountError);
          setAppliedCode(null);
          return;
        }
        setQuote({ ...q, appliedCode: q.discount?.code ?? null });
      } catch {
        /* aborted */
      }
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [liveSessionId, address.countryCode, rateId, appliedCode, addOnIds]);

  // One-page checkout: keep a Whop checkout ready for the current total, so the
  // payment form and wallet buttons are on the page from the start.
  const quoteBlocking =
    !!quote &&
    (!!quote.discountError ||
      (quote.rates.length === 0 && lines.some((l) => l.requiresShipping)));
  useEffect(() => {
    if (!liveSessionId || quoteBlocking) return;
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      setPreparing(true);
      try {
        const res = await fetch(
          `/api/public/sessions/${liveSessionId}/prepare`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              countryCode: address.countryCode,
              shippingRateId: rateId,
              discountCode: appliedCode,
              addOnIds,
            }),
            signal: ctrl.signal,
          },
        );
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Erreur");
        setPrepareError(null);
        setPrepared((p) =>
          p?.configId === body.checkoutConfigurationId
            ? p
            : {
                configId: body.checkoutConfigurationId,
                environment: body.environment,
              },
        );
      } catch (err) {
        if (!ctrl.signal.aborted)
          setPrepareError(err instanceof Error ? err.message : "Erreur");
      } finally {
        if (!ctrl.signal.aborted) setPreparing(false);
      }
    }, 500);
    return () => {
      clearTimeout(t);
      ctrl.abort();
      // The aborted request's finally skips this; without it the spinner could stay forever.
      setPreparing(false);
    };
  }, [
    liveSessionId,
    quoteBlocking,
    address.countryCode,
    rateId,
    appliedCode,
    addOnIds,
  ]);

  const q = live ? (quote ?? localQuote) : localQuote;
  const totals = q.totals;
  const lowestInventory = useMemo(() => {
    const tracked = lines
      .map((l) => l.inventory)
      .filter((n): n is number => n != null);
    return tracked.length ? Math.min(...tracked) : null;
  }, [lines]);

  /* ---------- payment ---------- */

  const locked = false;
  const thankYouUrl = liveSessionId ? `/c/${liveSessionId}/merci` : "#";
  // Whop needs an absolute return URL; the origin is only known in the browser.
  const origin = useSyncExternalStore(
    noopSubscribe,
    () => window.location.origin,
    () => "",
  );
  const onPaid = () => router.push(thankYouUrl);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      e.email = L.invalidEmail;
    for (const k of [
      "firstName",
      "lastName",
      "address1",
      "city",
      "zip",
      "countryCode",
    ] as const) {
      if (!address[k].trim()) e[k] = L.required;
    }
    if (theme.requireTerms && !termsAccepted) e.terms = L.termsRequired;
    setErrors(e);
    if (Object.keys(e).length) {
      document
        .querySelector(`[data-field="${Object.keys(e)[0]}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return Object.keys(e).length === 0;
  }

  async function confirm(): Promise<ConfirmResult> {
    if (!liveSessionId) return { ok: false };
    if (!validate()) return { ok: false };
    const res = await fetch(`/api/public/sessions/${liveSessionId}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        acceptsMarketing: marketing,
        acceptsTerms: termsAccepted,
        address,
        note: note.trim() || null,
        checkoutConfigurationId: prepared?.configId ?? null,
        countryCode: address.countryCode,
        shippingRateId: q.shippingRateId,
        discountCode: appliedCode,
        addOnIds,
      }),
    });
    const body = await res.json();
    if (!res.ok) return { ok: false, error: body.error ?? "Erreur" };
    if (!body.ready) {
      setPrepared({
        configId: body.checkoutConfigurationId,
        environment: body.environment,
      });
      return { ok: false, refreshedConfigId: body.checkoutConfigurationId };
    }
    return {
      ok: true,
      buyer: {
        email,
        address: {
          name: `${address.firstName} ${address.lastName}`.trim(),
          line1: address.address1,
          line2: address.address2 || undefined,
          city: address.city,
          state: address.province,
          postalCode: address.zip,
          country: address.countryCode,
          phone: address.phone || undefined,
        },
      },
    };
  }

  const payLabel = `${theme.payButtonText || L.payNow} · ${money(totals.totalCents)}`;

  /* ---------- rendering helpers ---------- */

  const freeShippingThresholdCents = useMemo(() => {
    const thresholds = rates
      .filter((r) => r.active && r.freeOverCents != null)
      .map((r) => r.freeOverCents as number);
    return thresholds.length ? Math.min(...thresholds) : null;
  }, [rates]);
  const ctx: ContentContext = {
    labels: L,
    lang: theme.language,
    lowestInventory,
    preview: !live,
    subtotalCents: totals.subtotalCents - totals.discountCents,
    freeShippingThresholdCents,
    money,
    note,
    setNote,
  };
  const visible = layout.blocks.filter((b) => !b.hidden);
  const formBlocks = visible.filter(
    (b) => b.placement === "form" || isSection(b),
  );
  const summaryBlocks = visible.filter(
    (b) => b.placement === "summary" && !isSection(b),
  );

  function wrap(block: Block, node: ReactNode) {
    if (node === null || isEmptyInLive(block, ctx, mountedAt)) return null;
    const selectable = mode.kind === "preview" && mode.onSelectBlock;
    const selected =
      mode.kind === "preview" && mode.selectedBlockId === block.id;
    return (
      <div
        key={block.id}
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

  const termsBox = theme.requireTerms ? (
    <div data-field="terms">
      <label className="flex items-start gap-2.5 text-sm leading-snug">
        <input
          type="checkbox"
          checked={termsAccepted}
          disabled={locked}
          onChange={(e) => {
            setTermsAccepted(e.target.checked);
            if (e.target.checked) setErrors((x) => ({ ...x, terms: "" }));
          }}
          aria-invalid={!!errors.terms}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--accent)]"
        />
        <span>
          <TermsText L={L} theme={theme} />
        </span>
      </label>
      {errors.terms && (
        <p role="alert" className="mt-1.5 text-xs text-red-600">
          {errors.terms}
        </p>
      )}
    </div>
  ) : null;

  function renderSection(block: Block): ReactNode {
    switch (block.type) {
      case "contact":
        return (
          <>
            {theme.expressCheckout &&
              (mode.kind === "live" ? (
                <ExpressCheckout
                  prepared={prepared}
                  theme={theme}
                  labels={L}
                  returnUrl={`${origin}${thankYouUrl}`}
                  email={email}
                  onPaid={onPaid}
                  saveCard={!!mode.saveCard}
                  termsNotice={
                    theme.requireTerms ? (
                      <TermsText L={L} theme={theme} express />
                    ) : null
                  }
                />
              ) : (
                <ExpressPreview labels={L} />
              ))}
            <Section title={block.props.title || L.contact}>
              <Field label={L.email} error={errors.email} field="email">
                <input
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  disabled={locked}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputCls}
                />
              </Field>
              <label className="mt-3 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={marketing}
                  disabled={locked}
                  onChange={(e) => setMarketing(e.target.checked)}
                  className="h-4 w-4 accent-[var(--accent)]"
                />
                {L.marketing}
              </label>
            </Section>
          </>
        );
      case "delivery":
        return (
          <Section title={block.props.title || L.delivery}>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label={L.country}
                className="col-span-2"
                error={errors.countryCode}
                field="countryCode"
              >
                <select
                  autoComplete="country"
                  value={address.countryCode}
                  disabled={locked}
                  onChange={(e) =>
                    setAddress({ ...address, countryCode: e.target.value })
                  }
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
              ).map(([k, label, auto, span]) => (
                <Field
                  key={k}
                  label={label}
                  className={span === 2 ? "col-span-2" : ""}
                  error={errors[k]}
                  field={k}
                >
                  {k === "address1" ? (
                    <AddressAutocomplete
                      value={address.address1}
                      enabled={live && address.countryCode === "FR"}
                      disabled={locked}
                      onChange={(v) => setAddress({ ...address, address1: v })}
                      onPick={(p) => setAddress({ ...address, ...p })}
                      className={inputCls}
                    />
                  ) : (
                    <input
                      autoComplete={auto}
                      type={k === "phone" ? "tel" : "text"}
                      value={address[k]}
                      disabled={locked}
                      inputMode={k === "zip" && address.countryCode === "FR" ? "numeric" : undefined}
                      onChange={(e) =>
                        setAddress({ ...address, [k]: e.target.value })
                      }
                      className={inputCls}
                    />
                  )}
                </Field>
              ))}
            </div>
          </Section>
        );
      case "shipping_method":
        return (
          <Section title={block.props.title || L.shippingMethod}>
            {q.rates.length === 0 ? (
              <p className="rounded-[var(--radius)] bg-neutral-100 px-4 py-3 text-sm text-neutral-600">
                {rates.length === 0 && mode.kind === "preview"
                  ? "Ajoutez des tarifs dans « Livraison »."
                  : L.noShipping}
              </p>
            ) : (
              <div className="divide-y divide-neutral-200 overflow-hidden rounded-[var(--radius)] border border-neutral-200 bg-white">
                {q.rates.map((r) => (
                  <label
                    key={r.id}
                    className={`flex cursor-pointer items-center gap-3 px-4 py-3 ${q.shippingRateId === r.id ? "bg-[color-mix(in_srgb,var(--accent)_6%,white)]" : ""}`}
                  >
                    <input
                      type="radio"
                      name="rate"
                      checked={q.shippingRateId === r.id}
                      disabled={locked}
                      onChange={() => setRateId(r.id)}
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    <span className="flex-1">
                      <span className="block text-sm font-medium">
                        {r.name}
                      </span>
                      {r.deliveryTime && (
                        <span className="block text-xs text-neutral-500">
                          {r.deliveryTime}
                        </span>
                      )}
                    </span>
                    <span className="text-sm font-medium">
                      {r.effectiveCents === 0
                        ? L.free
                        : money(r.effectiveCents)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </Section>
        );
      case "order_addons":
        if (addOns.length === 0)
          return mode.kind === "preview" ? (
            <Placeholder>
              Options : ajoutez-les dans « Promos &amp; options »
            </Placeholder>
          ) : null;
        return (
          <Section title={block.props.title || L.addons}>
            <div className="space-y-2">
              {addOns.map((a) => {
                const on = addOnIds.includes(a.id);
                return (
                  <label
                    key={a.id}
                    className={`flex cursor-pointer items-center gap-3 rounded-[var(--radius)] border px-4 py-3 ${on ? "border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_6%,white)]" : "border-dashed border-neutral-300 bg-white"}`}
                  >
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={locked}
                      onChange={() =>
                        setAddOnIds(
                          on
                            ? addOnIds.filter((x) => x !== a.id)
                            : [...addOnIds, a.id],
                        )
                      }
                      className="h-4 w-4 accent-[var(--accent)]"
                    />
                    {a.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={a.imageUrl}
                        alt=""
                        className="h-10 w-10 rounded object-cover"
                      />
                    )}
                    <span className="flex-1">
                      <span className="block text-sm font-medium">
                        {a.title}
                      </span>
                      {a.description && (
                        <span className="block text-xs text-neutral-500">
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
          <Section title={block.props.title || L.payment}>
            {mode.kind === "live" ? (
              <PaymentPanel
                prepared={prepared}
                preparing={preparing}
                prepareError={prepareError}
                theme={theme}
                labels={L}
                payLabel={payLabel}
                returnUrl={`${origin}${thankYouUrl}`}
                testMode={mode.testMode}
                confirm={confirm}
                onPaid={onPaid}
                saveCard={!!mode.saveCard}
                beforeButton={termsBox}
              />
            ) : (
              <PaymentPreview
                labels={L}
                payLabel={payLabel}
                beforeButton={termsBox}
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

  const summary = (
    <OrderSummary
      showImages={theme.summaryImages}
      L={L}
      lines={lines}
      totals={totals}
      money={money}
      hasDiscounts={hasDiscounts}
      codeInput={codeInput}
      setCodeInput={setCodeInput}
      appliedCode={live ? q.appliedCode : null}
      discountError={live ? (codeError ?? q.discountError) : null}
      onApply={() => {
        setCodeError(null);
        setAppliedCode(codeInput.trim() || null);
      }}
      onRemove={() => {
        setAppliedCode(null);
        setCodeError(null);
        setCodeInput("");
      }}
      locked={locked}
      needsShippingAddress={!address.address1}
      currency={currency}
      vatNote={theme.vatNote}
    >
      {summaryBlocks.map((b) => wrap(b, <ContentBlock block={b} ctx={ctx} />))}
    </OrderSummary>
  );

  return (
    <div
      className="@container min-h-full"
      style={themeVars(theme)}
      data-inputs={theme.inputStyle}
    >
      <StoreHeader theme={theme} />

      {/* Mobile summary toggle */}
      <div
        className="border-b border-[var(--border)] @3xl:hidden"
        style={{ background: theme.summaryBackground || undefined }}
      >
        <button
          type="button"
          onClick={() => setSummaryOpen(!summaryOpen)}
          className="flex w-full items-center justify-between px-5 py-4 text-sm"
          aria-expanded={summaryOpen}
        >
          <span className="flex items-center gap-1.5 font-medium text-[var(--accent)]">
            {summaryOpen ? L.hideSummary : L.showSummary}
            <ChevronDown
              className={`h-4 w-4 transition-transform ${summaryOpen ? "rotate-180" : ""}`}
            />
          </span>
          <span className="text-base font-semibold">
            {money(totals.totalCents)}
          </span>
        </button>
        {summaryOpen && <div className="px-5 pb-5">{summary}</div>}
      </div>

      <div
        className={`grid @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] ${summaryLeft ? "@3xl:[direction:rtl]" : ""}`}
      >
        <main
          className={`px-5 py-6 [direction:ltr] @3xl:flex @3xl:px-10 @3xl:py-10 ${summaryLeft ? "@3xl:justify-start @3xl:border-l" : "@3xl:justify-end @3xl:border-r"} @3xl:border-[var(--border)]`}
          style={{ background: theme.formBackground || undefined }}
        >
          <div className="w-full space-y-1" style={{ maxWidth: widths.form }}>
            {formBlocks.map((b) => wrap(b, renderSection(b)))}
            <Footer theme={theme} />
          </div>
        </main>
        <aside
          className={`hidden px-5 py-6 [direction:ltr] @3xl:flex @3xl:px-10 @3xl:py-10 ${summaryLeft ? "@3xl:justify-end" : "@3xl:justify-start"}`}
          style={{ background: theme.summaryBackground || undefined }}
        >
          <div
            className="sticky top-6 h-fit w-full"
            style={{ maxWidth: widths.summary }}
          >
            {summary}
          </div>
        </aside>
      </div>
    </div>
  );
}

const noopSubscribe = () => () => {};

function isSection(b: Block) {
  return (
    b.type === "contact" ||
    b.type === "delivery" ||
    b.type === "shipping_method" ||
    b.type === "payment" ||
    b.type === "order_addons"
  );
}

// Look depends on theme.inputStyle via [data-inputs] rules in globals.css
const inputCls = "wc-input";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 font-[family-name:var(--heading-font)] text-lg font-semibold tracking-tight">
        {title}
      </h2>
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
  field?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={`block ${className}`} data-field={field}>
      <span className="mb-1 block text-xs font-medium text-neutral-600">
        {label}
      </span>
      {children}
      {error && (
        <span className="mt-1 block text-xs text-red-600">{error}</span>
      )}
    </label>
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
  discountError: string | null;
  onApply: () => void;
  onRemove: () => void;
  locked: boolean;
  needsShippingAddress: boolean;
  currency: string;
  vatNote?: string;
  children: ReactNode;
}) {
  const { L, lines, totals, money } = props;
  return (
    <div className="space-y-5">
      <ul className="space-y-4">
        {lines.map((l) => (
          <li key={l.variantId} className="flex items-center gap-3">
            <div
              className={`relative shrink-0 ${props.showImages ? "" : "hidden"}`}
            >
              {l.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={l.imageUrl}
                  alt=""
                  className="h-16 w-16 rounded-[calc(var(--radius)*0.8)] border border-neutral-200 bg-white object-cover"
                />
              ) : (
                <div className="h-16 w-16 rounded-[calc(var(--radius)*0.8)] border border-neutral-200 bg-neutral-100" />
              )}
              <span className="absolute -top-2 -right-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-neutral-700 px-1.5 text-xs font-medium text-white">
                {l.quantity}
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{l.title}</p>
              {l.variantTitle && (
                <p className="text-xs text-neutral-500">{l.variantTitle}</p>
              )}
            </div>
            <div className="text-right text-sm">
              {l.compareAtCents != null &&
                l.compareAtCents > l.unitPriceCents && (
                  <p className="text-xs text-neutral-400 line-through">
                    {money(l.compareAtCents * l.quantity)}
                  </p>
                )}
              <p className="font-medium">
                {money(l.unitPriceCents * l.quantity)}
              </p>
            </div>
          </li>
        ))}
      </ul>

      {props.hasDiscounts && (
        <div>
          {props.appliedCode ? (
            <div className="flex items-center justify-between rounded-[var(--radius)] bg-white px-3 py-2 text-sm">
              <span>
                <Tag className="mr-1 inline h-3.5 w-3.5 text-[var(--accent)]" />
                <strong>{props.appliedCode}</strong>
              </span>
              {!props.locked && (
                <button
                  type="button"
                  onClick={props.onRemove}
                  className="text-neutral-500 underline"
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
                props.onApply();
              }}
            >
              <input
                value={props.codeInput}
                disabled={props.locked}
                onChange={(e) => props.setCodeInput(e.target.value)}
                placeholder={L.discountCode}
                className={inputCls}
              />
              <button
                type="submit"
                disabled={props.locked || !props.codeInput.trim()}
                className="rounded-[var(--radius)] border border-neutral-300 bg-white px-4 text-sm font-medium disabled:opacity-50"
              >
                {L.apply}
              </button>
            </form>
          )}
          {props.discountError && (
            <p className="mt-1 text-xs text-red-600">{props.discountError}</p>
          )}
        </div>
      )}

      <dl className="space-y-2 text-sm">
        <Row
          label={`${L.subtotal} · ${L.items(totals.itemCount)}`}
          value={money(totals.subtotalCents)}
        />
        {totals.discountCents > 0 && (
          <Row label={L.discount} value={`−${money(totals.discountCents)}`} />
        )}
        {totals.addOnsCents > 0 && (
          <Row label={L.addonsTotal} value={money(totals.addOnsCents)} />
        )}
        <Row
          label={L.shipping}
          value={
            props.needsShippingAddress && totals.shippingCents === 0
              ? "—"
              : totals.shippingCents === 0
                ? L.free
                : money(totals.shippingCents)
          }
        />
        <div className="flex items-baseline justify-between border-t border-neutral-200 pt-3">
          <dt className="text-base font-semibold">{L.total}</dt>
          <dd className="text-right text-xl font-semibold">
            <span className="mr-1.5 text-xs font-normal text-neutral-500">
              {props.currency}
            </span>
            {money(totals.totalCents)}
            {props.vatNote && (
              <span className="block text-xs font-normal text-neutral-500">
                {props.vatNote}
              </span>
            )}
          </dd>
        </div>
      </dl>

      {props.children}
    </div>
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
      <p className="mt-2 text-center text-[11px] text-neutral-500">
        {L.expressTerms}
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

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-neutral-600">{label}</dt>
      <dd className="font-medium">{value}</dd>
    </div>
  );
}
