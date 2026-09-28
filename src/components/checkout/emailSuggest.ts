/** Common consumer mailbox domains in the checkout's markets (typos are checked against them). */
const DOMAINS = [
  "gmail.com",
  "hotmail.fr",
  "hotmail.com",
  "hotmail.it",
  "outlook.fr",
  "outlook.com",
  "live.fr",
  "orange.fr",
  "free.fr",
  "sfr.fr",
  "laposte.net",
  "wanadoo.fr",
  "yahoo.fr",
  "yahoo.com",
  "icloud.com",
  "gmx.fr",
  "gmx.de",
  "web.de",
  "t-online.de",
  "libero.it",
  "telenet.be",
  "skynet.be",
  "ziggo.nl",
];

/** Levenshtein distance, stopping early once it exceeds `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * "jean@gmial.com" → "jean@gmail.com"; null when the domain is fine or not close to a
 * common one (1 edit for short domains, 2 otherwise).
 */
export function suggestEmail(email: string): string | null {
  const v = email.trim();
  const at = v.lastIndexOf("@");
  if (at < 1 || at === v.length - 1) return null;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1).toLowerCase();
  if (DOMAINS.includes(domain)) return null;
  let best: { d: string; n: number } | null = null;
  for (const d of DOMAINS) {
    const max = d.length <= 7 ? 1 : 2;
    const n = distance(domain, d, max);
    if (n <= max && (!best || n < best.n)) best = { d, n };
  }
  return best ? `${local}@${best.d}` : null;
}
