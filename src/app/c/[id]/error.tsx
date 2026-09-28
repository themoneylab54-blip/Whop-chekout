"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { labelsFor, pickLang } from "@/components/checkout/i18n";
import { StatusPage, statusPrimaryCls, statusSecondaryCls } from "@/components/checkout/StatusPage";
import { HtmlLang } from "@/components/checkout/HtmlLang";

const noopSubscribe = () => () => {};

/** Unexpected error on the checkout or thank-you page: localized, with a retry. */
export default function CheckoutError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const lang = useSyncExternalStore(
    noopSubscribe,
    () => pickLang(navigator.languages),
    () => "fr" as const,
  );
  // The shop the buyer came from (cart → checkout), when the browser tells us.
  const back = useSyncExternalStore(
    noopSubscribe,
    () => {
      try {
        const u = new URL(document.referrer);
        return /^https?:$/.test(u.protocol) && u.origin !== window.location.origin ? u.origin : null;
      } catch {
        return null;
      }
    },
    () => null,
  );
  const L = labelsFor(lang);

  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusPage lang={lang} title={L.errorTitle} body={L.errorBody}>
      <HtmlLang lang={lang} />
      <button
        type="button"
        onClick={() => {
          router.refresh();
          reset();
        }}
        className={statusPrimaryCls}
      >
        {L.retry}
      </button>
      {back && (
        <a href={back} className={statusSecondaryCls}>
          ← {L.backToStore}
        </a>
      )}
    </StatusPage>
  );
}
