"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { Layout, Theme } from "@/lib/layout";
import { formatMoney, type CartLine } from "@/lib/pricing";
import { ContentBlock, isEmptyInLive, StyledBlock, type ContentContext } from "./blocks";
import { Footer, StoreHeader, themeVars } from "./CheckoutView";
import { countryName, labelsFor } from "./i18n";

export type ThankYouData = {
  status: "OPEN" | "PAYING" | "PAID" | "FAILED" | "ABANDONED";
  orderName: string | null;
  email: string;
  firstName: string;
  address: { name: string; lines: string[]; countryCode: string } | null;
  lines: CartLine[];
  currency: string;
  subtotalCents: number;
  discountCents: number;
  shippingCents: number;
  addOnsCents: number;
  totalCents: number;
  continueUrl: string | null;
};

type Props = {
  theme: Theme;
  layout: Layout;
  data: ThankYouData;
  sessionId?: string; // live mode: poll until the Shopify order exists
  preview?: { selectedBlockId?: string | null; onSelectBlock?: (id: string) => void };
  upsell?: { eligible: boolean; states: Record<string, string> };
};

export function ThankYouView({ theme, layout, data: initial, sessionId, preview, upsell }: Props) {
  const L = labelsFor(theme.language);
  const [data, setData] = useState(initial);
  const [mountedAt] = useState(() => Date.now());
  const money = (c: number) => formatMoney(c, data.currency, theme.language === "fr" ? "fr-FR" : "en-US");

  useEffect(() => {
    if (!sessionId || data.orderName) return;
    let tries = 0;
    const t = setInterval(async () => {
      tries += 1;
      if (tries > 40) clearInterval(t);
      try {
        const res = await fetch(`/api/public/sessions/${sessionId}/status`, { cache: "no-store" });
        if (!res.ok) return;
        const s = await res.json();
        // Until the webhook lands the session can still read OPEN: keep showing "processing".
        setData((d) => ({ ...d, status: s.status === "OPEN" ? d.status : s.status, orderName: s.shopifyOrderName }));
        if (s.shopifyOrderName) clearInterval(t);
      } catch {
        /* offline for a moment: try again on the next tick */
      }
    }, 3000);
    return () => clearInterval(t);
  }, [sessionId, data.orderName]);

  const ctx: ContentContext = {
    labels: L,
    lang: theme.language,
    lowestInventory: null,
    preview: !!preview,
    subtotalCents: data.subtotalCents - data.discountCents,
    freeShippingThresholdCents: null,
    money,
    note: "",
    setNote: () => {},
    upsell: sessionId && upsell ? { sessionId, ...upsell } : undefined,
  };
  const blocks = layout.blocks.filter((b) => !b.hidden);
  const render = (pos: "above" | "below") =>
    blocks
      .filter((b) => b.position === pos && !isEmptyInLive(b, ctx, mountedAt))
      .map((b) => {
        const selected = preview?.selectedBlockId === b.id;
        const node: ReactNode = (
          <StyledBlock style={b.style}>
            <ContentBlock block={b} ctx={ctx} />
          </StyledBlock>
        );
        return preview?.onSelectBlock ? (
          <div
            key={b.id}
            onClick={() => preview.onSelectBlock!(b.id)}
            className={`-mx-2 cursor-pointer rounded-lg px-2 ${selected ? "outline-2 outline-[var(--accent)] outline-solid" : "hover:outline-1 hover:outline-neutral-300 hover:outline-dashed"}`}
          >
            {node}
          </div>
        ) : (
          <div key={b.id}>{node}</div>
        );
      });

  const confirmed = data.status === "PAID" || !!data.orderName;

  return (
    <div className="min-h-full" style={themeVars(theme)}>
      <StoreHeader theme={theme} />
      <main className="mx-auto max-w-[640px] px-5 py-8">
        {render("above")}
        <div className="flex items-center gap-4 py-4">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[image:var(--accent-bg)] text-[var(--accent-fg)] shadow-[var(--btn-shadow)]"><Check className="h-6 w-6" strokeWidth={3} /></span>
          <div>
            {data.orderName && (
              <p className="text-sm text-neutral-500">
                {L.order} {data.orderName}
              </p>
            )}
            <h1 className="text-2xl font-semibold">{L.thankYou(data.firstName)}</h1>
          </div>
        </div>
        <div className="rounded-[var(--radius)] border border-neutral-200 bg-white p-5">
          <p className="font-medium">{confirmed ? L.orderConfirmed : L.orderProcessing}</p>
          {data.email && <p className="mt-1 text-sm text-neutral-600">{L.confirmationSent(data.email)}</p>}
        </div>

        <div className="mt-4 rounded-[var(--radius)] border border-neutral-200 bg-white p-5">
          <p className="mb-3 text-xs font-semibold tracking-wide text-neutral-500 uppercase">{L.summary}</p>
          <ul className="space-y-2 text-sm">
            {data.lines.map((l) => (
              <li key={l.variantId} className="flex justify-between gap-3">
                <span>
                  {l.quantity} × {l.title}
                  {l.variantTitle && <span className="text-neutral-500"> · {l.variantTitle}</span>}
                </span>
                <span className="font-medium">{money(l.unitPriceCents * l.quantity)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 space-y-1.5 border-t border-neutral-200 pt-3 text-sm">
            <Row k={L.subtotal} v={money(data.subtotalCents)} />
            {data.discountCents > 0 && <Row k={L.discount} v={`−${money(data.discountCents)}`} />}
            {data.addOnsCents > 0 && <Row k={L.addonsTotal} v={money(data.addOnsCents)} />}
            <Row k={L.shipping} v={data.shippingCents ? money(data.shippingCents) : L.free} />
            <div className="flex justify-between pt-2 text-base font-semibold">
              <dt>{L.total}</dt>
              <dd>{money(data.totalCents)}</dd>
            </div>
          </dl>
        </div>

        {data.address && (
          <div className="mt-4 grid gap-4 rounded-[var(--radius)] border border-neutral-200 bg-white p-5 text-sm sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">{L.shipTo}</p>
              <p>{data.address.name}</p>
              {data.address.lines.map((line, i) => (
                <p key={i}>{line}</p>
              ))}
              <p>{countryName(data.address.countryCode, theme.language)}</p>
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold tracking-wide text-neutral-500 uppercase">{L.contact}</p>
              <p>{data.email}</p>
            </div>
          </div>
        )}

        {render("below")}

        {theme.withdrawalNotice && <p className="mt-6 text-xs leading-relaxed text-neutral-500">{L.withdrawal}</p>}
        {!preview && <p className="mt-2 text-xs leading-relaxed text-neutral-500">{L.statementNote}</p>}

        {data.continueUrl && (
          <a
            href={data.continueUrl}
            className="mt-6 flex w-full items-center justify-center rounded-[var(--radius)] bg-[var(--accent)] px-5 py-4 font-semibold text-[var(--accent-fg)] hover:opacity-90"
          >
            {L.continueShopping}
          </a>
        )}
        <Footer theme={theme} />
      </main>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-neutral-600">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
