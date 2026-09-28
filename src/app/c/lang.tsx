import { cookies, headers } from "next/headers";
import { HtmlLang } from "@/components/checkout/HtmlLang";
import { LANG_COOKIE, resolveCheckoutLang, type Lang } from "@/components/checkout/i18n";

/** Checkout language for this request: ?lang= → remembered choice → Accept-Language → store default. */
export async function checkoutLang(query: string | string[] | undefined, fallback: Lang): Promise<Lang> {
  const [h, c] = await Promise.all([headers(), cookies()]);
  return resolveCheckoutLang({
    query,
    cookie: c.get(LANG_COOKIE)?.value ?? null,
    acceptLanguage: h.get("accept-language"),
    fallback,
  });
}

/**
 * `<html lang>` for checkout pages. The root layout (shared with the French dashboard, static)
 * renders `lang="fr"`; this inline script — sent in the server HTML, run while the page is
 * parsed, before first paint and hydration — sets the buyer's language, and HtmlLang keeps it
 * right after client navigations. The checkout container also carries `lang` itself, so the
 * content is correctly tagged even without JavaScript.
 */
export function CheckoutHtmlLang({ lang }: { lang: Lang }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: `document.documentElement.lang=${JSON.stringify(lang)};` }} />
      <HtmlLang lang={lang} />
    </>
  );
}

/**
 * Tab icon of buyer pages: the store's own logo when the theme has one, else a neutral lock
 * (never the merchant app's brand icon).
 */
export function buyerIcons(logoUrl: string | undefined | null): { icon: string; apple: string } {
  const icon = logoUrl || "/checkout-icon.svg";
  return { icon, apple: icon };
}
