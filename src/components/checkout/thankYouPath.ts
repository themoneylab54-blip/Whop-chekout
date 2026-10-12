/**
 * The thank-you page's path, Whop's return URL once given the page's origin: CheckoutView's (via=app
 * kept: the loader's fallback, see CheckoutView) and the early start's (via=app added in the browser,
 * the same way: see inlineEarlyWhop). Pure.
 */
export function thankYouPath(sessionId: string, lang: string, viaApp: boolean): string {
  return `/c/${sessionId}/merci?lang=${lang}${viaApp ? "&via=app" : ""}`;
}
