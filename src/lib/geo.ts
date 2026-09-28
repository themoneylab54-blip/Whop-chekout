/**
 * Geolocation headers set by the hosting edge, in order of preference: Vercel, Cloudflare,
 * CloudFront, then a generic header some proxies/CDNs add. Only the platform in front of the app
 * can set them (a client-sent value is overwritten by the edge that owns the header).
 */
export const GEO_HEADERS = ["x-vercel-ip-country", "cf-ipcountry", "cloudfront-viewer-country", "x-country-code"] as const;

/**
 * ISO country of the request's IP from the first geolocation header holding a real country,
 * null when none does ("XX" unknown, "T1" Tor, "EU"/"AP" regions and other non-country codes). Pure.
 */
export function geoCountryOf(headers: Pick<Headers, "get">): string | null {
  for (const name of GEO_HEADERS) {
    const v = headers.get(name)?.trim().toUpperCase() ?? "";
    if (/^[A-Z]{2}$/.test(v) && !NOT_COUNTRIES.has(v)) return v;
  }
  return null;
}

/** Two-letter codes the edges use for "not a country". */
const NOT_COUNTRIES = new Set(["XX", "T1", "EU", "AP", "A1", "A2", "O1", "ZZ"]);
