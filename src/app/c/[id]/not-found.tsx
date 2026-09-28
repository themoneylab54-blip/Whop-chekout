import { headers } from "next/headers";
import { labelsFor, pickLang } from "@/components/checkout/i18n";
import { checkoutLang } from "@/app/c/lang";
import { HtmlLang } from "@/components/checkout/HtmlLang";
import { StatusPage, statusSecondaryCls } from "@/components/checkout/StatusPage";
import { HistoryBack } from "@/components/checkout/HistoryBack";

/**
 * Unknown or expired checkout link (also covers /merci). No session means no store
 * context: a neutral page in the buyer's language (Accept-Language, French by default).
 */
export default async function CheckoutNotFound() {
  const h = await headers();
  const lang = await checkoutLang(undefined, pickLang(h.get("accept-language")));
  const L = labelsFor(lang);
  // Came from the shop (cart link)? Offer the way back.
  let back: string | null = null;
  try {
    const ref = h.get("referer");
    const host = h.get("host");
    if (ref) {
      const u = new URL(ref);
      if (/^https?:$/.test(u.protocol) && u.host !== host) back = u.origin;
    }
  } catch {
    back = null;
  }
  // No store is known here: no "secure payment" eyebrow over an error (it reads as a promise).
  return (
    <StatusPage lang={lang} title={L.notFoundTitle} body={L.notFoundText}>
      {/* Not-found boundaries also render on the client: an effect, not an inline script. */}
      <HtmlLang lang={lang} />
      {back ? (
        <a href={back} className={statusSecondaryCls}>
          ← {L.backToStore}
        </a>
      ) : (
        // No referrer: the shop is unknown, so no home link — "Back" or a support hint.
        <HistoryBack label={L.goBack} help={L.notFoundHelp} />
      )}
    </StatusPage>
  );
}
