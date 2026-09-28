"use client";

import { useEffect } from "react";

type Fbq = ((...args: unknown[]) => void) & { callMethod?: (...a: unknown[]) => void; queue?: unknown[]; loaded?: boolean; version?: string; push?: unknown };
type Ttq = { load: (id: string) => void; page: () => void; track: (event: string, data: Record<string, unknown>, opts?: Record<string, unknown>) => void };
declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
    ttq?: Ttq & unknown[];
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

function loadMeta(pixelId: string) {
  if (window.fbq) return;
  const f: Fbq = function (...args: unknown[]) {
    if (f.callMethod) f.callMethod(...args);
    else f.queue!.push(args);
  } as Fbq;
  f.push = f;
  f.loaded = true;
  f.version = "2.0";
  f.queue = [];
  window.fbq = window._fbq = f;
  const s = document.createElement("script");
  s.async = true;
  s.src = "https://connect.facebook.net/en_US/fbevents.js";
  document.head.appendChild(s);
  window.fbq("init", pixelId);
}

function loadTikTok(pixelId: string) {
  if (window.ttq) return;
  // Official TikTok pixel bootstrap (queue until the library loads).
  const ttq = [] as unknown as Ttq & unknown[] & Record<string, unknown>;
  const methods = ["page", "track", "identify", "instances", "debug", "on", "off", "once", "ready", "alias", "group", "enableCookie", "disableCookie"];
  for (const m of methods) (ttq as Record<string, unknown>)[m] = (...args: unknown[]) => ttq.push([m, ...args]);
  window.ttq = ttq;
  ttq.push(["load", pixelId]);
  ttq.push(["page"]);
  const s = document.createElement("script");
  s.async = true;
  s.src = `https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=${encodeURIComponent(pixelId)}&lib=ttq`;
  document.head.appendChild(s);
}

/**
 * Browser-side pixels on our checkout domain, mirroring the server-side events with the
 * same event ids. Rendered only when the buyer's consent allows it.
 */
export function AdPixels({ metaPixelId, tiktokPixelId, event }: { metaPixelId: string | null; tiktokPixelId: string | null; event: PixelEvent }) {
  useEffect(() => {
    try {
      if (metaPixelId) {
        loadMeta(metaPixelId);
        window.fbq!(
          "track",
          event.kind === "purchase" ? "Purchase" : "InitiateCheckout",
          { value: event.value, currency: event.currency, content_ids: event.contentIds, content_type: "product" },
          { eventID: event.eventId },
        );
      }
      if (tiktokPixelId) {
        loadTikTok(tiktokPixelId);
        window.ttq!.track(
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
