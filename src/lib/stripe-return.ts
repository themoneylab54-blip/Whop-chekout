/** Stripe's redirect parameters (the client secret among them): never kept in the thank-you page's URL. */
export const STRIPE_RETURN_PARAMS = ["payment_intent", "payment_intent_client_secret", "redirect_status", "setup_intent", "setup_intent_client_secret", "source_redirect_slug"];

/**
 * Back from a Stripe redirect (3-D Secure, bank page) that didn't pay: the checkout's URL with
 * `payment=failed` (it says so; the buyer pays again or another way), or null. Any `redirect_status`
 * but succeeded / processing (failed, requires_payment_method, canceled…) on a session not paid; a
 * paid session always stays on its thank-you page. `via=app` kept. Pure.
 */
export function failedReturnUrl(id: string, params: Record<string, string | string[] | undefined>, sessionStatus: string): string | null {
  const status = [params.redirect_status].flat()[0];
  if (sessionStatus === "PAID" || !status || status === "succeeded" || status === "processing") return null;
  return `/c/${encodeURIComponent(id)}?payment=failed${[params.via].flat()[0] === "app" ? "&via=app" : ""}`;
}

/**
 * The thank-you page's URL without Stripe's return parameters (every other one kept: lang, via), or
 * null when there are none (no redirect needed). Pure.
 */
export function cleanThankYouUrl(id: string, params: Record<string, string | string[] | undefined>): string | null {
  if (!STRIPE_RETURN_PARAMS.some((k) => params[k] != null)) return null;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null || STRIPE_RETURN_PARAMS.includes(k)) continue;
    for (const one of Array.isArray(v) ? v : [v]) q.append(k, one);
  }
  const s = q.toString();
  return `/c/${encodeURIComponent(id)}/merci${s ? `?${s}` : ""}`;
}
