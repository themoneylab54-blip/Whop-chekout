"use client";

import { useEffect } from "react";

type Fbq = (...args: unknown[]) => void;
type Ttq = { load: (id: string) => void; page: () => void; track: (event: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => void };
declare global {
  interface Window {
    fbq?: Fbq;
    ttq?: Ttq;
  }
}

export type PixelEvent = {
  kind: "checkout" | "purchase";
  /** Same id as the server-side event, so Meta/TikTok count the conversion once. */
  eventId: string;
  value: number;
  currency: string;
  /** Meta content ids (same format as the server-side event). */
  contentIds: string[];
  /** Variant ids for TikTok. */
  variantIds: string[];
};

/** Meta's official base code (fbevents.js bootstrap), then init with the pixel id. */
function loadMeta(pixelId: string) {
  if (window.fbq) return;
  const code = `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init',${JSON.stringify(pixelId)});`;
  inject(code);
}

/** TikTok's official pixel base code (sets up ttq._i/_t/_o and loads events.js), then page(). */
function loadTikTok(pixelId: string) {
  if (window.ttq) return;
  const code = `!function(w,d,t){w.TiktokAnalyticsObject=t;var ttq=w[t]=w[t]||[];ttq.methods=["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"],ttq.setAndDefer=function(t,e){t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}};for(var i=0;i<ttq.methods.length;i++)ttq.setAndDefer(ttq,ttq.methods[i]);ttq.instance=function(t){for(var e=ttq._i[t]||[],n=0;n<ttq.methods.length;n++)ttq.setAndDefer(e,ttq.methods[n]);return e},ttq.load=function(e,n){var r="https://analytics.tiktok.com/i18n/pixel/events.js",o=n&&n.partner;ttq._i=ttq._i||{},ttq._i[e]=[],ttq._i[e]._u=r,ttq._t=ttq._t||{},ttq._t[e]=+new Date,ttq._o=ttq._o||{},ttq._o[e]=n||{};n=document.createElement("script");n.type="text/javascript",n.async=!0,n.src=r+"?sdkid="+e+"&lib="+t;e=document.getElementsByTagName("script")[0];e.parentNode.insertBefore(n,e)};ttq.load(${JSON.stringify(pixelId)});ttq.page();}(window,document,'ttq');`;
  inject(code);
}

function inject(code: string) {
  const s = document.createElement("script");
  s.text = code;
  document.head.appendChild(s);
}

/**
 * Browser-side pixels on our checkout domain, mirroring the server-side events with the
 * same event ids. Rendered only when consent (and live mode) allows it.
 */
export function AdPixels({ metaPixelId, tiktokPixelId, event }: { metaPixelId: string | null; tiktokPixelId: string | null; event: PixelEvent }) {
  useEffect(() => {
    try {
      if (metaPixelId) {
        loadMeta(metaPixelId);
        window.fbq?.(
          "track",
          event.kind === "purchase" ? "Purchase" : "InitiateCheckout",
          { value: event.value, currency: event.currency, content_ids: event.contentIds, content_type: "product" },
          { eventID: event.eventId },
        );
      }
      if (tiktokPixelId) {
        loadTikTok(tiktokPixelId);
        window.ttq?.track(
          event.kind === "purchase" ? "CompletePayment" : "InitiateCheckout",
          { value: event.value, currency: event.currency, content_type: "product", contents: event.variantIds.map((id) => ({ content_id: id })) },
          { event_id: event.eventId },
        );
      }
    } catch {
      /* ad blockers etc.: the server-side event still counts */
    }
    // One event per page view: ids and values are fixed for a given checkout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metaPixelId, tiktokPixelId, event.kind, event.eventId]);
  return null;
}
