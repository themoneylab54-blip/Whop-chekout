"use client";

import { useSyncExternalStore } from "react";
import { ArrowLeft, LifeBuoy } from "lucide-react";
import { statusSecondaryCls } from "./StatusPage";

const noopSubscribe = () => () => {};

/**
 * Fallback next step on the "link not found" page when the shop is unknown (no
 * referrer): "Back" when the tab has a history, else a short support hint.
 */
export function HistoryBack({ label, help }: { label: string; help: string }) {
  const canGoBack = useSyncExternalStore(
    noopSubscribe,
    () => window.history.length > 1,
    () => false,
  );
  return canGoBack ? (
    <button type="button" onClick={() => window.history.back()} className={statusSecondaryCls}>
      <ArrowLeft className="mr-1.5 h-4 w-4" aria-hidden />
      {label}
    </button>
  ) : (
    <p className="flex items-start gap-2 text-sm leading-relaxed text-neutral-700">
      <LifeBuoy className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500" aria-hidden />
      {help}
    </p>
  );
}
