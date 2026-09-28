/**
 * Display name of a traffic source as stored (lower-cased utm_source, or "facebook (clic pub)"
 * from a click id): "tiktok" → "TikTok", "ig" → "Instagram", "facebook (clic pub)" →
 * "Facebook / Meta (clic pub)". Filters and links keep the raw value. Pure.
 */
const NAMES: Record<string, string> = {
  facebook: "Facebook / Meta",
  fb: "Facebook / Meta",
  meta: "Facebook / Meta",
  "m.facebook.com": "Facebook / Meta",
  "l.facebook.com": "Facebook / Meta",
  ig: "Instagram",
  instagram: "Instagram",
  "l.instagram.com": "Instagram",
  an: "Meta Audience Network",
  msg: "Messenger",
  messenger: "Messenger",
  tiktok: "TikTok",
  tt: "TikTok",
  google: "Google",
  adwords: "Google",
  "google-ads": "Google",
  googleads: "Google",
  youtube: "YouTube",
  yt: "YouTube",
  bing: "Bing",
  microsoft: "Microsoft Ads",
  snapchat: "Snapchat",
  snap: "Snapchat",
  pinterest: "Pinterest",
  twitter: "X (Twitter)",
  x: "X (Twitter)",
  linkedin: "LinkedIn",
  reddit: "Reddit",
  klaviyo: "Klaviyo",
  omnisend: "Omnisend",
  email: "E-mail",
  newsletter: "Newsletter",
  sms: "SMS",
  whatsapp: "WhatsApp",
  shopify: "Shopify",
  "direct / inconnu": "Direct / inconnu",
};

export function sourceLabel(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "Direct / inconnu";
  const m = /^(.*?)\s*(\(clic pub\))$/i.exec(s);
  const key = (m ? m[1] : s).toLowerCase();
  const name = NAMES[key] ?? (/^[a-z]/.test(key) && key === s.toLowerCase() && !/[\s.]/.test(key) ? key.charAt(0).toUpperCase() + key.slice(1) : m ? m[1] : s);
  return m ? `${name} ${m[2]}` : name;
}
