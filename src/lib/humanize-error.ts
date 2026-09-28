/**
 * Raw provider errors ("Shopify API 403: {"errors":…}", "invalid_grant", "fetch failed"…) turned
 * into one plain French sentence that says what happened and what to do. The raw text stays
 * available as a technical detail (support, Shopify escalations). Unknown errors pass through.
 */
export type HumanError = { text: string; /** The raw error, when `text` differs from it. */ detail?: string };

type Rule = [RegExp, (m: RegExpExecArray, raw: string) => string];

const RETRY = "nouvel essai automatique";

const RULES: Rule[] = [
  // Shopify
  [/Boutique Shopify non connectée/i, () => "La boutique Shopify n'est pas connectée : connectez-la dans Connexions › Shopify."],
  [/\bShopify API (401|403)\b/i, (m) => `Shopify a refusé l'accès (${m[1]}) : vérifiez la connexion Shopify (Connexions › Shopify) et reconnectez l'app si besoin.`],
  [/\bShopify API 402\b/i, () => "Shopify a bloqué la demande (402) : la boutique Shopify est suspendue ou a une facture impayée."],
  [/\bShopify API 404\b/i, () => "Shopify ne trouve pas la boutique ou l'élément demandé (404) : vérifiez le domaine Shopify connecté."],
  [/\bShopify API 423\b/i, () => "La boutique Shopify est verrouillée (423) : contactez le support Shopify."],
  [/\bShopify API (429)\b|Shopify API throttled|\bTHROTTLED\b/i, () => `Shopify limite temporairement les requêtes : ${RETRY}.`],
  [/\bShopify API (5\d\d)\b/i, (m) => `Shopify est momentanément indisponible (${m[1]}) : ${RETRY}.`],
  [/Shopify injoignable/i, () => `Shopify est injoignable (réseau) : ${RETRY}.`],
  [/access denied|ACCESS_DENIED|merchant approval|required access/i, (_m, raw) =>
    /shopify|order|product|inventory|customer|fulfillment/i.test(raw)
      ? "Shopify a refusé l'accès : l'app n'a pas toutes les autorisations nécessaires. Reconnectez Shopify pour les accorder."
      : "Accès refusé par le service : vérifiez la connexion et les autorisations."],
  [/Shopify\s*:.*(stock|inventor|out of stock|not enough|quantit)/i, () => "Shopify a refusé la commande : stock insuffisant pour un des articles."],
  [/réponse de Shopify incertaine/i, () => "Shopify n'a pas confirmé à temps : la commande a peut-être été créée. Vérifiez dans Shopify avant de réessayer."],
  // Whop
  [/Compte Whop non (connecté|configuré)/i, () => "Le compte Whop n'est pas connecté : connectez-le dans Connexions › Whop."],
  [/\bWhop\b[^\n]*\b(401|403)\b/i, (m) => `Whop a refusé l'accès (${m[1]}) : vérifiez la clé API Whop (Connexions › Whop).`],
  [/\bWhop\b[^\n]*\b(5\d\d)\b/i, (m) => `Whop est momentanément indisponible (${m[1]}) : ${RETRY}.`],
  // Ads platforms
  [/invalid_grant|UNAUTHENTICATED|Google Ads[^\n]*(OAuth|jeton|401|403)/i, () => "Google Ads a refusé la connexion : reconnectez Google Ads dans Pub & pixels."],
  [/OAuthException|Error validating access token|Session has expired|access token (is )?(invalid|expired)/i, () => "Meta a refusé le jeton d'accès : générez-en un nouveau dans Pub & pixels."],
  [/TikTok 40(001|100|104|105)\b/i, () => "TikTok a refusé le jeton d'accès : générez-en un nouveau dans Pub & pixels."],
  // Provider metrics ("HTTP 503" of the Services externes card)
  [/^HTTP (5\d\d)\b/, (m) => `Le service est momentanément indisponible (${m[1]}) : ${RETRY}.`],
  [/^HTTP 429\b/, () => `Le service limite temporairement les requêtes (429) : ${RETRY}.`],
  [/\bcart\.js\b[^\n]*\b(401|403)\b|\b(401|403)\b[^\n]*\bcart\.js\b/i, (m) =>
    `La boutique a refusé la lecture du panier (cart.js, ${m[1] ?? m[2]}) : un thème ou une appli bloque peut-être /cart.js. Aucune clé n'est en cause ; ${RETRY}.`],
  [/^HTTP (401|403)\b/, (m) => `Le service a refusé l'accès (${m[1]}) : vérifiez la connexion (clé API ou jeton).`],
  // Network
  [/timeout|timed out|TimeoutError|aborted due to timeout|ETIMEDOUT|DeadlineError/i, () => `Le service n'a pas répondu à temps : ${RETRY}.`],
  [/fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network/i, () => `Le service est injoignable (réseau) : ${RETRY}.`],
  // Shopify userErrors on a replacement order ("Shopify : <message>")
  [/^Shopify\s*:\s*(.+)$/is, (m) => `Shopify a refusé la commande : ${m[1].trim()}`],
];

/**
 * "HTTP 401/403" of a known provider (Services externes card): what to check for that provider.
 * Keyless services (ECB exchange rates: a public feed) never get the "clé API ou jeton" hint.
 */
const ACCESS_HINTS: Record<string, (code: string) => string> = {
  ecb: (c) => `La BCE a refusé la requête (${c}) : ce service public ne demande aucune clé, c'est un blocage temporaire de leur côté ; ${RETRY}.`,
  shopify: (c) => `Shopify a refusé l'accès (${c}) : vérifiez la connexion Shopify (Connexions › Shopify) et reconnectez l'app si besoin.`,
  whop: (c) => `Whop a refusé l'accès (${c}) : vérifiez la clé API Whop (Connexions › Whop).`,
  mondial_relay: (c) => `Mondial Relay a refusé l'accès (${c}) : vérifiez le code enseigne et la clé privée (Livraison › Point relais).`,
  resend: (c) => `Resend a refusé l'envoi (${c}) : vérifiez la clé Resend et le domaine de l'expéditeur (Réglages › Alertes).`,
  telegram: (c) => `Telegram a refusé l'envoi (${c}) : vérifiez le jeton du bot et l'identifiant du chat (Réglages › Alertes).`,
  meta: (c) => `Meta a refusé l'accès (${c}) : générez un nouveau jeton d'accès dans Pub & pixels.`,
  tiktok: (c) => `TikTok a refusé l'accès (${c}) : générez un nouveau jeton d'accès dans Pub & pixels.`,
  ga4: (c) => `Google Analytics 4 a refusé l'envoi (${c}) : vérifiez l'ID de mesure et le secret d'API dans Pub & pixels.`,
  google_ads: (c) => `Google Ads a refusé l'accès (${c}) : reconnectez Google Ads dans Pub & pixels.`,
};

/** Providers that need no credential: an access error is never about a key. */
export const KEYLESS_PROVIDERS: ReadonlySet<string> = new Set(["ecb"]);

export function humanizeError(raw: string | null | undefined, opts: { provider?: string } = {}): HumanError {
  const text = (raw ?? "").trim();
  if (!text) return { text: "Erreur inconnue." };
  const access = /^HTTP (401|403)\b/.exec(text);
  if (access && opts.provider) {
    const hint = ACCESS_HINTS[opts.provider];
    const human = hint
      ? hint(access[1])
      : KEYLESS_PROVIDERS.has(opts.provider)
        ? `Le service a refusé la requête (${access[1]}) : blocage temporaire de son côté ; ${RETRY}.`
        : `Le service a refusé l'accès (${access[1]}) : vérifiez sa connexion.`;
    return { text: human, detail: text };
  }
  for (const [re, fn] of RULES) {
    const m = re.exec(text);
    if (m) {
      const human = fn(m, text);
      return human === text ? { text } : { text: human, detail: text };
    }
  }
  return { text };
}
