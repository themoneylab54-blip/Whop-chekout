/*
 * A shop's own domains (its storefront, its *.myshopify.com address) as one form everywhere they are
 * stored or compared: the URL hostname — lowercase, an accented domain in its punycode form
 * (sovéline.fr → xn--sovline-dya.fr), as browsers send it in an Origin or a URL. Shopify may give a
 * domain either way and a merchant may type it either way: compared raw, the same domain would look
 * like another one. Pure and dependency-free (dashboard forms run it in the browser).
 */

/**
 * A domain as its URL hostname (see above), without a trailing dot; null for anything else: a URL, a
 * port, a path, an IP address, a name without a dot (localhost) or with an empty label. Pure.
 */
export function shopHostname(host: string | null | undefined): string | null {
  const h = host?.trim().replace(/\.$/, "");
  if (!h || !/^[^\s/:?#@\\]+$/.test(h)) return null;
  try {
    const name = new URL(`https://${h}`).hostname.toLowerCase();
    const labels = name.split(".");
    return labels.length > 1 && labels.every(Boolean) && !/^\d+$/.test(labels[labels.length - 1]) ? name : null;
  } catch {
    return null;
  }
}
