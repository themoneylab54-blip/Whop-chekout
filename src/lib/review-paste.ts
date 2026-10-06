import { REVIEW_LIMITS } from "./layout";

/*
 * « Coller des avis »: reviews copied from anywhere (a spreadsheet, an e-mail, a Judge.me,
 * Trustpilot, Amazon or Shopify page) turned into review drafts the merchant checks before adding
 * them. Pure (browser and tests), linear in the pasted text.
 *
 * Reviews are separated by a blank line. In each one: the stars (★★★★★, ⭐⭐⭐⭐, 5/5, 4,5/5,
 * « 5 étoiles », « Rated 4 out of 5 stars », « Note : 4 »…), the reviewer (« — Marie », « Par
 * Marie », or a short first line that reads like a name), a date (FR / EN formats) and a title
 * when there is one. Lines a review page adds around the review (« Acheteur vérifié », « Verified
 * Purchase », « Helpful », « Signaler »…) are dropped: a pasted review is never « Achat vérifié ».
 * Lines « Nom;Note;Avis » (or tab-separated, or comma-separated with a header) are read as a table.
 */

export type PastedReview = {
  name: string;
  text: string;
  stars: number;
  /** No rating found in the paste: 5 stars by default, shown to the merchant to check. */
  starsGuessed: boolean;
  /** The pasted rating had a fraction (4,5 → 4 stars, never rounded up): shown in the preview. */
  roundedFrom?: number;
  title?: string;
  /** YYYY-MM-DD. */
  date?: string;
  /** Text or name cut to the schema's limits. */
  cut?: boolean;
};

export type PasteResult = {
  reviews: PastedReview[];
  /** Reviews found past PASTE_PARSE_LIMIT (not returned). */
  dropped: number;
  format: "blocks" | "table";
};

/** Reviews read from one paste at most (the block holds MAX_REVIEW_ITEMS). */
export const PASTE_PARSE_LIMIT = 1000;
/** A review longer than this is flagged in the preview (still accepted up to REVIEW_LIMITS.text). */
export const PASTE_LONG_TEXT = 1500;

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/** Windows / old Mac line endings, non-breaking and odd spaces, zero-width characters, BOM. */
export function normalizePaste(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u00a0\u2007\u202f\u2000-\u200a\u3000]/g, " ")
    .replace(/[\u200b\u200c\u200d\u2060\ufeff]/g, "")
    .replace(/\u2028|\u2029/g, "\n")
    .normalize("NFC");
}

const clean = (s: string) => s.replace(/[ \t\f\v]+/g, " ").trim();

/* ------------------------------------------------------------------ */
/* Ratings                                                             */
/* ------------------------------------------------------------------ */

const toStars = (n: number, outOf = 5): number | null => {
  if (!Number.isFinite(n) || outOf <= 0) return null;
  const v = (n / outOf) * 5;
  if (v < 0.5 || v > 5.0001) return null;
  // Never shown higher than given (4,5/5 → 4): the merchant can click 5 in the preview.
  return Math.min(5, Math.max(1, Math.floor(v + 1e-9)));
};
const num = (s: string) => Number(s.replace(",", "."));
/** The exact rating over 5 when it isn't a whole number of stars (4,5/5 → 4.5), else undefined. */
const fraction = (n: number, outOf = 5): number | undefined => {
  const v = Math.round((n / outOf) * 5 * 10) / 10;
  return Number.isFinite(v) && Math.abs(v - Math.round(v)) > 1e-9 ? v : undefined;
};
/** « arrondi (4,5 → 4) »: the preview's note on a rating rounded down. */
export function roundedLabel(from: number, stars: number): string {
  return `arrondi (${String(from).replace(".", ",")} → ${stars})`;
}

const NUM = String.raw`(\d{1,2}(?:[.,]\d{1,2})?)`;
const STAR_WORD = String.raw`(?:stars?|étoiles?|etoiles?|estrellas?|sterne|stelle|sterren|★|⭐)`;
const RATING_PATTERNS: { re: RegExp; read: (m: RegExpMatchArray) => number | null }[] = [
  // "Rated 4 out of 5 stars", "5.0 out of 5 stars", "4 sur 5", "4,5/5", "Note : 4/5", "9/10"
  {
    re: new RegExp(String.raw`^(?:(?:rated|rating|note|notée?|noté|évaluation|evaluation|score|avis|bewertung|valoración|valutazione)\s*[:：]?\s*)?${NUM}\s*(?:/|sur|out of|of|von|de|su|van)\s*(5|10)(?:[.,]0)?\s*(?:${STAR_WORD})?(?=\s|$|[.,:;!)\]-])`, "iu"),
    read: (m) => toStars(num(m[1]), Number(m[2])),
  },
  // "5 étoiles", "4 stars", "4.5 stars"
  { re: new RegExp(String.raw`^(?:(?:rated|note|noté|notée)\s*[:：]?\s*)?${NUM}\s*${STAR_WORD}(?=\s|$|[.,:;!)\]-])`, "iu"), read: (m) => toStars(num(m[1])) },
  // "Note : 4", "Rating: 5", "Rated 5"
  { re: new RegExp(String.raw`^(?:rated|rating|note|notée?|noté|évaluation|evaluation|score|stars?|étoiles?)\s*[:：]?\s*${NUM}(?=\s|$|[.,:;!)\]-])`, "iu"), read: (m) => toStars(num(m[1])) },
];
/** ★★★★☆ (filled + empty), ⭐⭐⭐⭐⭐ (filled only), ★★★★½ (a half star), ***** (5 asterisks or fewer). */
const STAR_GLYPHS = /^((?:[★☆✩✭✮✯✰⭐🌟]\ufe0f?|★|☆){1,10})(\s?½)?/u;
const ASTERISKS = /^(\*{1,5})(?=\s|$)/;

export type RatingLine = {
  stars: number;
  rest: string;
  /** The exact rating when it had a fraction (rounded down to `stars`). */
  roundedFrom?: number;
  /** A line holding only a figure ("5"): a rating only where the paste's layout says so. */
  bare?: true;
};
export type RatingOptions = {
  /**
   * Asterisk ratings ("*****", "** Bof"). False when the paste uses "* " bullets with text: an
   * asterisk then starts a list item, never a rating.
   */
  asterisks?: boolean;
};

/**
 * A rating at the start of a line: the stars (1 to 5) and what follows on the line (Amazon puts
 * the title after « 5.0 out of 5 stars »). Null when the line does not start with a rating.
 */
export function parseRatingLine(line: string, opts: RatingOptions = {}): RatingLine | null {
  const s = clean(line);
  if (!s) return null;
  const glyphs = s.match(STAR_GLYPHS);
  if (glyphs) {
    const chars = Array.from(glyphs[1].replace(/\ufe0f/g, ""));
    const filled = chars.filter((c) => c !== "☆" && c !== "✩").length + (glyphs[2] ? 0.5 : 0);
    const total = chars.length + (glyphs[2] ? 1 : 0);
    // Ten glyphs: a /10 scale written in stars is unheard of; read the filled ones over 5.
    const outOf = total > 5 ? total : 5;
    const stars = toStars(filled, outOf);
    let rest = s.slice(glyphs[0].length).trim();
    // "★★★★★ 5/5" or "★★★★☆ (4)": the figure repeats the stars.
    // Not "★★★★☆ 2 weeks ago": a relative date (dropped later).
    if (!new RegExp(String.raw`^${RELATIVE_DATE}`, "iu").test(rest)) rest = rest.replace(new RegExp(String.raw`^\(?${NUM}\s*(?:/\s*5)?\)?(?=\s|$)`, "u"), "").trim();
    return stars ? withFraction({ stars, rest: stripSep(rest) }, fraction(filled, outOf)) : null;
  }
  const ast = s.match(ASTERISKS);
  if (ast && opts.asterisks !== false) {
    const rest = stripSep(s.slice(ast[0].length));
    // "* Livraison rapide" is a list item: one asterisk is a rating only alone on its line.
    if (ast[1].length >= 2 || rest === "") return { stars: ast[1].length, rest };
  }
  for (const p of RATING_PATTERNS) {
    const m = s.match(p.re);
    if (!m) continue;
    const stars = p.read(m);
    if (stars) return withFraction({ stars, rest: stripSep(s.slice(m[0].length)) }, fraction(num(m[1]), m[2] && /^(5|10)$/.test(m[2]) ? Number(m[2]) : 5));
  }
  // A line holding only a score: "5", "4,5" (a review never is just a figure).
  const bare = s.match(new RegExp(String.raw`^${NUM}$`));
  if (bare) {
    const stars = toStars(num(bare[1]));
    if (stars && num(bare[1]) <= 5) return withFraction({ stars, rest: "", bare: true }, fraction(num(bare[1])));
  }
  return null;
}
const withFraction = (r: RatingLine, from: number | undefined): RatingLine => (from != null ? { ...r, roundedFrom: from } : r);
const stripSep = (s: string) => s.replace(/^[\s\-–—:|·•,.)]+/u, "").trim();

/* ------------------------------------------------------------------ */
/* Dates                                                               */
/* ------------------------------------------------------------------ */

const MONTHS: Record<string, number> = {};
(
  [
    ["janvier", "janv", "jan", "january", "januar", "enero", "gennaio", "januari"],
    ["février", "fevrier", "févr", "fevr", "fév", "fev", "february", "feb", "februar", "febrero", "febbraio", "februari"],
    ["mars", "march", "mar", "märz", "marzo", "maart"],
    ["avril", "avr", "april", "apr", "abril", "aprile"],
    ["mai", "may", "mayo", "maggio", "mei"],
    ["juin", "june", "jun", "juni", "junio", "giugno"],
    ["juillet", "juil", "july", "jul", "juli", "julio", "luglio"],
    ["août", "aout", "august", "aug", "agosto", "augustus"],
    ["septembre", "sept", "sep", "september", "septiembre", "settembre"],
    ["octobre", "oct", "october", "oktober", "octubre", "ottobre"],
    ["novembre", "nov", "november", "noviembre"],
    ["décembre", "decembre", "déc", "dec", "december", "dezember", "diciembre", "dicembre"],
  ] as const
).forEach((names, i) => names.forEach((n) => (MONTHS[n] = i + 1)));
const MONTH_RE = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join("|");

function ymd(y: number, m: number, d: number, now: Date): string | null {
  if (y < 100) y += 2000;
  if (y < 1990 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  // A review is never written in the future (a day of slack for time zones).
  if (t > now.getTime() + 86_400_000) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const DATE_FINDERS: { re: RegExp; read: (m: RegExpMatchArray, now: Date) => string | null }[] = [
  // 2024-03-12
  { re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/, read: (m, now) => ymd(+m[1], +m[2], +m[3], now) },
  // 12/03/2024, 12.03.2024, 12-03-24: day first (French), month first when the day cannot be (03/25/2024).
  {
    re: /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/,
    read: (m, now) => {
      const a = +m[1];
      const b = +m[2];
      return b > 12 && a <= 12 ? ymd(+m[3], a, b, now) : ymd(+m[3], b, a, now);
    },
  },
  // 12 mars 2024, 1er mars 2024, 12 March 2024, 12. März 2024
  {
    re: new RegExp(String.raw`(?<![\p{L}\d])(\d{1,2})(?:er|st|nd|rd|th)?\.?\s+(?:de\s+)?(${MONTH_RE})\.?,?\s+(?:de\s+)?(\d{4})\b`, "iu"),
    read: (m, now) => ymd(+m[3], MONTHS[m[2].toLowerCase()], +m[1], now),
  },
  // March 12, 2024 · Mar 3, 2024
  {
    re: new RegExp(String.raw`(?<![\p{L}])(${MONTH_RE})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b`, "iu"),
    read: (m, now) => ymd(+m[3], MONTHS[m[1].toLowerCase()], +m[2], now),
  },
];

/** The first date in a line, and the line without it. */
export function findDate(line: string, now = new Date()): { date: string; rest: string } | null {
  for (const f of DATE_FINDERS) {
    const m = line.match(f.re);
    if (!m || m.index == null) continue;
    const date = f.read(m, now);
    if (date) return { date, rest: clean(line.slice(0, m.index) + " " + line.slice(m.index + m[0].length)) };
  }
  return null;
}

// What review pages write around a date ("Reviewed in France on", "Publié le", "Date of experience:").
const DATE_FILLER =
  /^(?:\s*(?:(?:(?:avis\s+)?(?:publié|posté|laissé|écrit|rédigé|commenté|reviewed|posted|written|submitted|updated|mis à jour|modifié|published)(?:\s+(?:in|en|au|aux|dans)\s+.{1,40}?)?(?:\s+(?:on|le|the))?)|(?:date(?:\s+(?:of|de|d'|du))?\s*(?:experience|expérience|l'expérience|achat|purchase|publication|l'avis|review)?)|le|on|il y a|the|du|·|•|-|—|–|,|:))*[\s:,.·•\-–—]*$/iu;
const WEAK_DATE = /date\s+(?:of|de|d')\s*(?:l')?(?:experience|expérience)|experience|expérience/i;

/* ------------------------------------------------------------------ */
/* Lines                                                               */
/* ------------------------------------------------------------------ */

const RELATIVE_DATE = String.raw`(?:il y a\s+(?:\d+|une?|quelques)\s+\p{L}+|(?:\d+|an?|one)\s+(?:minutes?|hours?|days?|weeks?|months?|years?)\s+ago|hier|yesterday|aujourd'hui|today|avant-hier)`;

// Lines a review page adds around the review: dropped (never a reason to mark it verified).
const NOISE: RegExp[] = [
  /^[✓✔☑✅]?\s*(?:verified\s+(?:buyer|purchase|reviewer|owner|customer)|acheteu(?:r|se)\s+vérifiée?|achat\s+vérifié|avis\s+vérifié|client(?:e)?\s+vérifiée?|commande\s+vérifiée|verifizierter\s+kauf|compra\s+verificada|acquisto\s+verificato|geverifieerde\s+aankoop|verified)\s*[✓✔☑✅]?$/iu,
  /^(?:helpful|not helpful|utile|pas utile|report|report abuse|signaler(?:\s+un\s+abus)?|share|partager|reply|répondre|read more|lire la suite|voir plus|see more|show more|afficher plus|translate|traduire|see translation|voir la traduction|translated|traduit|useful|like|j'aime|thumbs up|was this (?:review )?helpful\??|cet avis vous a-t-il été utile\s*\??|(?:yes|no|oui|non)(?:\s*\(\d+\))?)$/iu,
  /^\d+\s+(?:people|person|personnes?|clients?)\s+.*(?:helpful|utile)/iu,
  /^(?:one|une?)\s+(?:person|personne)\s+.*(?:helpful|utile)/iu,
  /^[•·]?\s*\d+\s+(?:reviews?|avis|bewertungen|reseñas|recensioni)$/iu,
  // A country code ("FR", "US"); « OK » is a review.
  /^(?!OK$)[A-Z]{2}$/,
  /^(?:\d+\s*)?(?:👍|👎|❤\ufe0f?)(?:\s*\d+)?$/u,
  /^(?:size|taille|colou?r|couleur|style|modèle|pattern)\s*:\s*\S.{0,40}$/iu,
  /^(?:top|meilleur)\s+(?:review|contributor|avis)/iu,
  /^(?:\d+\s*)?(?:photos?|images?)$/iu,
  // Google Reviews: « Local Guide · 12 avis · 3 photos ».
  /^(?:local guide|guide local|\d+\s+(?:avis|reviews?|photos?|bewertungen|fotos))(?:\s*[·•]\s*(?:local guide|guide local|\d+\s+(?:avis|reviews?|photos?|bewertungen|fotos)))*$/iu,
  // Relative dates ("il y a 3 jours", "2 weeks ago"): no day to keep.
  new RegExp(String.raw`^${RELATIVE_DATE}$`, "iu"),
];
const isNoise = (s: string) => NOISE.some((re) => re.test(s));
/** A relative date at the end of a line ("★★★★★ Marie · il y a 2 semaines"): dropped. */
const RELATIVE_END = new RegExp(String.raw`(?:^|[\s·•|,\-–—]+)${RELATIVE_DATE}\s*$`, "iu");
/** « Local Guide · 12 avis » after a name (Google Reviews). */
const GOOGLE_META_END = /(?:^|\s*[·•|,\-–—]?\s+)(?:local guide|guide local)(?:\s*[·•]\s*\d+\s+(?:avis|reviews?|photos?|bewertungen|fotos))*\s*$/iu;

// The page's « verified » label after a name ("Marie D. Verified Buyer", "Paul — Acheteur vérifié").
const TRAILING_VERIFIED =
  /\s*[-–—·•|,(]?\s*[✓✔☑✅]?\s*(?<![\p{L}])(?:verified\s+(?:buyer|purchase|reviewer|owner|customer)|verified|acheteu(?:r|se)\s+vérifiée?|achat\s+vérifié|avis\s+vérifié|client(?:e)?\s+vérifiée?)\s*[✓✔☑✅]?\s*\)?$/iu;
/** "Marie D. Verified Buyer" → "Marie D.": the label goes (a pasted review is never verified). */
function stripVerified(s: string): string {
  const t = s.replace(TRAILING_VERIFIED, "").trim();
  // "Marie D. Verified Buyer", or "Marie D. ★★★★★ Verified Buyer".
  return t !== s && t && (looksLikeName(t) || /[★☆⭐]\ufe0f?$/u.test(t)) ? t : s;
}

type Line =
  | { kind: "blank" }
  | { kind: "noise" }
  | { kind: "rating"; stars: number; rest: string; who?: string; roundedFrom?: number; bare?: true; date?: string }
  | { kind: "date"; date: string; weak: boolean; who?: string }
  /** `stars`: a rating phrase kept in the text ("5 étoiles sans hésiter."). */
  | { kind: "text"; text: string; stars?: number };

const NAME_WORD = /^(?:[\p{Lu}][\p{L}'’.-]*|[\p{Lu}]\.?|de|du|des|la|le|van|von|der|di|da|dos|el|al|y|e)$/u;
/** Reads like a reviewer's name: 1 to 4 capitalized words ("Marie D.", "Jean-Luc", "Sophie de M."). */
export function looksLikeName(s: string): boolean {
  const t = clean(s);
  if (!t || t.length > 40 || /[!?:;…"«»“”()@#\d]/u.test(t)) return false;
  const words = t.split(" ");
  if (words.length > 4) return false;
  if (!/^[\p{Lu}]/u.test(words[0])) return false;
  return words.every((w) => NAME_WORD.test(w));
}

/** "— Marie D.", "- Marie", "Par Marie", "By John S.", "De : Paul": the name, else null. */
function signedName(s: string): string | null {
  const m = clean(s).match(/^(?:[—–―~-]+\s*|(?:par|by|de|from|von)\s*:?\s+)(.{1,60})$/iu);
  if (!m) return null;
  const name = clean(m[1]).replace(/[,;]$/, "");
  return looksLikeName(name) ? name : null;
}

// Short titles that read like a name ("Parfait", "Super Produit"): never taken as the reviewer.
const TITLE_WORDS =
  /^(?:parfait|parfaite|super|top|génial|geniale?|excellent|excellente|bien|très|tres|bon|bonne|nul|bof|déçu|déçue|decu|moyen|correct|conforme|rapide|merci|bravo|impeccable|magnifique|incroyable|great|perfect|amazing|awesome|good|nice|love|loved|best|wow|fantastic|wonderful|happy|beautiful|recommended|recommande|qualité|qualite|quality|produit|product|livraison|delivery|satisfait|satisfaite|satisfied|nickel|cool|sympa|pratique|efficace|joli|jolie|beau|belle|idéal|idéale|ideal|ravi|ravie|content|contente|absolument|vraiment|really|very|highly|recommend|works|worth|ok|okay)(?![\p{L}])/iu;
const likelyName = (s: string) => looksLikeName(s) && !TITLE_WORDS.test(clean(s));

/** The text after the stars as the reviewer's name ("★★★★★ Marie D."): no word reads like a title. */
const nameOnStars = (s: string) => likelyName(s) && clean(s).split(" ").every((w) => !TITLE_WORDS.test(w));

/** "Marie D. le 12 mars 2024" without the date → "Marie D.". */
const whoBeforeDate = (rest: string) =>
  stripVerified(
    rest
      .replace(/^(?:par|by)\s+/i, "")
      .replace(/\s*(?:[-–—·•|,]|\bon\b|\ble\b|\bthe\b)+\s*$/iu, "")
      .trim(),
  );

/** A rating line's own text without the page's additions (a relative date, « Verified », a date). */
function ratingLine(r: RatingLine, now: Date, date?: string): Line {
  let rest = r.rest.replace(RELATIVE_END, "").replace(GOOGLE_META_END, "").trim();
  if (rest && isNoise(rest)) rest = "";
  if (rest && rest.length <= 90) {
    const d = findDate(rest, now);
    if (d && (!d.rest || DATE_FILLER.test(d.rest))) {
      rest = "";
      date ??= d.date;
    } else if (d && looksLikeName(whoBeforeDate(d.rest))) {
      rest = whoBeforeDate(d.rest);
      date ??= d.date;
    }
  }
  rest = stripVerified(stripSep(rest));
  return { kind: "rating", ...r, rest, ...(date ? { date } : {}) };
}

function classify(raw: string, now: Date, opts: RatingOptions = {}): Line {
  let s = clean(raw);
  if (!s) return { kind: "blank" };
  if (isNoise(s)) return { kind: "noise" };
  s = s.replace(GOOGLE_META_END, "").trim();
  if (!s || isNoise(s)) return { kind: "noise" };
  s = stripVerified(s);
  const rating = parseRatingLine(s, opts);
  if (rating) return ratingLine(rating, now);
  // "Marie D. ★★★★★": the name, then the stars on the same line.
  const tail = s.match(/^(.{1,40}?)\s*[-–—:·•|]?\s*((?:[★☆⭐]️?){1,5}(?:\s?½)?)$/u);
  const tailWho = tail ? stripVerified(clean(tail[1])) : "";
  if (tail && looksLikeName(tailWho)) {
    const r = parseRatingLine(tail[2]);
    if (r) return { kind: "rating", stars: r.stars, rest: "", who: tailWho, ...(r.roundedFrom != null ? { roundedFrom: r.roundedFrom } : {}) };
  }
  if (s.length <= 90) {
    const d = findDate(s, now);
    if (d) {
      if (!d.rest || DATE_FILLER.test(d.rest)) return { kind: "date", date: d.date, weak: WEAK_DATE.test(s) };
      // "03/25/2025 ★★★★★ Great": the date, then the stars and the text.
      const r = parseRatingLine(d.rest, opts);
      if (r && !r.bare) return ratingLine(r, now, d.date);
      // "Marie D. le 12 mars 2024", "By John on March 3, 2024", "Marie D. · 12/03/2024"
      const who = whoBeforeDate(d.rest);
      if (looksLikeName(who)) return { kind: "date", date: d.date, weak: false, who };
    }
  }
  return { kind: "text", text: s };
}

/** A rating written in words at the start of a line ("5 étoiles", "4 stars"). */
const WORD_RATING = /^\d{1,2}(?:[.,]\d{1,2})?\s*(?:étoiles?|etoiles?|stars?)(?![\p{L}])/iu;

/** "* " bullets with text in the paste: asterisks there start list items, never ratings. */
const usesBulletAsterisks = (text: string) => /^[ \t]*\*[ \t]+\S/m.test(text);

/**
 * Every line of a paste, classified. A line holding only a figure ("3") is a rating only where the
 * paste's layout says so: review text right below it, and nothing but a name, a date or the page's
 * labels above it in its review ("Marie\n5\nSuper produit"). Inside a review's text
 * ("J'ai commandé 2\n3\nboîtes…") it stays text.
 */
function classifyLines(text: string, now: Date, opts: RatingOptions = { asterisks: !usesBulletAsterisks(text) }): Line[] {
  const raw = text.split("\n");
  const lines = raw.map((l) => classify(l, now, opts));
  // "Super produit.\n5 étoiles sans hésiter.": a rating phrase inside the text stays text when the
  // review already has its rating, or when the sentence carries on after it.
  let ratingAbove = false;
  let textAbove = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.kind === "blank") {
      ratingAbove = textAbove = false;
      continue;
    }
    if (l.kind === "noise") continue;
    if (l.kind === "rating" && textAbove && WORD_RATING.test(clean(raw[i])) && (ratingAbove || /^[\p{Ll}]/u.test(l.rest)))
      lines[i] = { kind: "text", text: clean(raw[i]), ...(ratingAbove ? {} : { stars: l.stars }) };
    if (lines[i].kind === "rating") ratingAbove = true;
    textAbove = lines[i].kind === "text";
  }
  return lines.map((l, i) => {
    if (l.kind !== "rating" || !l.bare) return l;
    let next = i + 1;
    while (next < lines.length && lines[next].kind === "noise") next++;
    let prev = i - 1;
    while (prev >= 0 && lines[prev].kind === "noise") prev--;
    const above = prev < 0 ? null : lines[prev];
    const textBelow = next < lines.length && lines[next].kind === "text";
    const headerAbove = above == null || above.kind === "blank" || above.kind === "date" || (above.kind === "text" && likelyName(above.text));
    return textBelow && headerAbove ? l : { kind: "text", text: clean(text.split("\n")[i]) };
  });
}

/* ------------------------------------------------------------------ */
/* Blocks of lines → reviews                                           */
/* ------------------------------------------------------------------ */

type Segment = Line[];
const has = (seg: Segment, kind: Line["kind"]) => seg.some((l) => l.kind === kind);
const textLines = (seg: Segment) => seg.filter((l): l is Extract<Line, { kind: "text" }> => l.kind === "text");
/** Short line without a sentence end: a name, a country, a title (never part of a sentence). */
const headerLike = (l: Line) => l.kind === "noise" || l.kind === "date" || (l.kind === "text" && likelyName(l.text));

/** A chunk holding several ratings (reviews pasted without blank lines): cut before each one. */
function splitOnRatings(chunk: Segment): Segment[] {
  const anchors = chunk.flatMap((l, i) => (l.kind === "rating" ? [i] : []));
  if (anchors.length < 2) return [chunk];
  const starts = [0];
  for (let k = 1; k < anchors.length; k++) {
    let start = anchors[k];
    let names = 0;
    const prevRating = chunk[anchors[k - 1]] as Extract<Line, { kind: "rating" }>;
    // The reviewer's name, the date and the page's labels just above the stars belong to it,
    // unless the previous review would be left without text ("★★★★★\nNickel\n★★★★☆\nBien").
    while (start - 1 > anchors[k - 1] && headerLike(chunk[start - 1])) {
      if (chunk[start - 1].kind === "text") {
        if (++names > 1) break;
        if (!prevRating.rest && textLines(chunk.slice(anchors[k - 1] + 1, start - 1)).length === 0) break;
      }
      start--;
    }
    // Two ratings in a row with nothing between: the second one repeats the first
    // ("★★★★★\n5.0 out of 5 stars Parfait"). Not when the first has its own text on its line
    // ("5/5 Super produit\n4/5 Bien": one review per line).
    if (!prevRating.rest && start === anchors[k - 1] + 1 && start === anchors[k] && textLines(chunk.slice(anchors[k - 1], anchors[k])).length === 0) continue;
    starts.push(start);
  }
  return starts.map((s, i) => chunk.slice(s, starts[i + 1] ?? chunk.length));
}

/** Only a name / date / labels (no review text): the header of the review below it. */
const headerOnly = (seg: Segment) => !has(seg, "rating") && seg.every(headerLike) && textLines(seg).length <= 1;

function segment(lines: Line[]): Segment[] {
  const chunks: Segment[] = [];
  let cur: Segment = [];
  for (const l of lines) {
    if (l.kind === "blank") {
      if (cur.length) chunks.push(cur);
      cur = [];
    } else cur.push(l);
  }
  if (cur.length) chunks.push(cur);
  const parts = chunks.flatMap(splitOnRatings).filter((s) => s.some((l) => l.kind !== "noise"));
  const out: Segment[] = [];
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const next = parts[i + 1];
    const prev = out[out.length - 1];
    // "Marie D.\n\n★★★★★ Super" : the name above, separated by a blank line.
    if (headerOnly(seg) && next && has(next, "rating") && !next.slice(0, next.findIndex((l) => l.kind === "rating")).some((l) => l.kind === "text")) {
      parts[i + 1] = [...seg, ...next];
      continue;
    }
    // "★★★★★ Marie\n\nTexte de l'avis" : stars and name, then the text after a blank line.
    if (prev && !has(seg, "rating") && has(prev, "rating") && reviewText(prev) === "") {
      out[out.length - 1] = [...prev, ...seg];
      continue;
    }
    out.push(seg);
  }
  return out;
}

/** What a segment would give as review text (for the merge rule above). */
function reviewText(seg: Segment): string {
  return build(seg, true)?.text ?? "";
}

const unquote = (s: string) => {
  const t = s.trim();
  const m = t.match(/^(["“”«»„‟'])\s*([\s\S]*?)\s*(["“”«»„‟'])$/u);
  return m && m[2] && !m[2].includes('"') ? m[2] : t;
};

/** `textless`: a name on the stars line stays the name even without text (the text may follow). */
function build(seg: Segment, textless = false): Omit<PastedReview, "cut"> | null {
  let stars: number | null = null;
  let impliedStars: number | null = null;
  let roundedFrom: number | undefined;
  let date: string | undefined;
  let weakDate: string | undefined;
  let name = "";
  let title: string | undefined;
  const before: string[] = [];
  const after: string[] = [];
  let ratingRest = "";
  for (const l of seg) {
    if (l.kind === "rating") {
      if (stars == null) {
        stars = l.stars;
        roundedFrom = l.roundedFrom;
        ratingRest = l.rest;
        if (l.who && !name) name = l.who;
      } else if (l.rest) after.push(l.rest);
      if (l.date) date ??= l.date;
    } else if (l.kind === "date") {
      if (l.weak) weakDate ??= l.date;
      else date ??= l.date;
      if (l.who && !name) name = l.who;
    } else if (l.kind === "text") {
      (stars == null ? before : after).push(l.text);
      if (l.stars != null) impliedStars ??= l.stars;
    }
  }
  // "★★★★★ Marie\nSuper produit.", "5/5 Marie D.": a name on the stars line is the reviewer
  // (unless a name sits above the stars).
  let nameFromStars = false;
  if (ratingRest && !name && nameOnStars(ratingRest) && !before.some(likelyName)) {
    name = clean(ratingRest);
    nameFromStars = true;
    ratingRest = "";
  }
  // A rating's own line text ("5.0 out of 5 stars Parfait") is the title when text follows,
  // else the review itself ("★★★★★ Super produit, je recommande").
  if (ratingRest) {
    if (after.length > 0 && ratingRest.length <= 120 && !signedName(ratingRest)) title = ratingRest;
    else after.unshift(ratingRest);
  }
  // A signature at the end of the last line: "Génial — Marie", "Top - Lucas D.".
  if (!name) {
    const list = after.length ? after : before;
    const last = list[list.length - 1];
    const m = last?.match(/^(.*\S)\s+(?:[—–―]|-)\s+([^—–―]{1,40})$/u);
    if (m && likelyName(m[2])) {
      name = clean(m[2]);
      list[list.length - 1] = m[1].trim();
    }
  }
  // A signature: "— Marie D." as the last line, "Par Marie" / "By John" on a line of its own.
  if (!name) {
    for (const list of [after, before]) {
      const last = list.length - 1;
      const i = list.findIndex((t, k) => (k === last || k === 0 || /^(?:par|by|from|von)\s/i.test(t)) && signedName(t) != null);
      if (i >= 0 && before.length + after.length > 1) {
        name = signedName(list[i]) ?? "";
        list.splice(i, 1);
        break;
      }
    }
  }
  // Above the stars: the reviewer's name (the last name-like line, Judge.me / Trustpilot / Amazon).
  if (!name) {
    for (let i = before.length - 1; i >= 0; i--) {
      if (likelyName(before[i])) {
        name = clean(before[i]);
        before.splice(i, 1);
        break;
      }
    }
  }
  const body = [...before, ...after];
  // "Marie D.\nTexte" — a short first line that reads like a name.
  if (!name && body.length >= 2 && likelyName(body[0])) name = clean(body.shift() ?? "");
  // A short first line without a sentence end, with text below: the title (only in a review laid
  // out by a review page or app: stars, a date or a name found).
  const structured = stars != null || !!date || !!name;
  // Not when the next line carries on the sentence ("J'ai commandé 2\n3\nboîtes…").
  if (!title && structured && body.length >= 2 && body[0].length <= 100 && !/[.,;:]$/.test(body[0]) && !/^[\p{Ll}]/u.test(body[0]) && !/^[\p{Ll}\d]/u.test(body[1]))
    title = body.shift();
  let text = unquote(body.join("\n"));
  if (!text && title) {
    text = title;
    title = undefined;
  }
  // "★★★★★ Marie" alone (no text below): the line is the review itself, as written.
  if (!text && nameFromStars && !textless) {
    text = name;
    name = "";
  }
  if (!text && stars == null && !name) return null;
  return {
    name,
    text,
    stars: stars ?? impliedStars ?? 5,
    starsGuessed: stars == null && impliedStars == null,
    ...(roundedFrom != null ? { roundedFrom } : {}),
    ...(title ? { title: unquote(title) } : {}),
    ...((date ?? weakDate) ? { date: date ?? weakDate } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Tables: "Nom;Note;Avis"                                             */
/* ------------------------------------------------------------------ */

/** RFC 4180-ish rows (quoted fields with "" and line breaks inside). */
function splitRows(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field.trim() === "") {
      field = "";
      quoted = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  row.push(field);
  rows.push(row);
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

type Col = "name" | "stars" | "text" | "title" | "date" | "skip";
const HEADER: [Col, RegExp][] = [
  ["stars", /^(?:note|notes|rating|ratings|stars?|étoiles?|etoiles?|score|évaluation|evaluation|review_score|rating_value)$/i],
  ["text", /^(?:avis|texte|text|review|review_body|body|commentaire|comment|comments|contenu|content|message|description|review text|texte de l'avis)$/i],
  ["name", /^(?:nom|name|client|cliente|customer|auteur|author|reviewer|reviewer_name|prénom|prenom|pseudo|first name|display_name)$/i],
  ["title", /^(?:titre|title|review_title|sujet|subject|headline)$/i],
  ["date", /^(?:date|created_at|review_date|publié le|published|posted|jour)$/i],
];
const headerCol = (s: string): Col | null => {
  const t = clean(s).replace(/^"|"$/g, "");
  for (const [col, re] of HEADER) if (re.test(t)) return col;
  return null;
};

function parseTable(text: string, now: Date): PastedReview[] | null {
  const nonEmpty = text.split("\n").filter((l) => l.trim());
  if (nonEmpty.length === 0) return null;
  for (const delim of ["\t", ";", ","]) {
    // Quick reject: the delimiter must be on most lines.
    if (nonEmpty.filter((l) => l.includes(delim)).length < Math.max(1, Math.ceil(nonEmpty.length * 0.6))) continue;
    const rows = splitRows(text, delim);
    if (rows.length === 0) continue;
    const headerCols = rows[0].map(headerCol);
    const hasHeader = headerCols.filter(Boolean).length >= 2 && headerCols.includes("text");
    const data = hasHeader ? rows.slice(1) : rows;
    if (data.length === 0) continue;
    const width = rows[0].length;
    if (width < 2) continue;
    // A row with more fields: the delimiter inside the review text ("Bon produit; un peu cher").
    const sameWidth = data.filter((r) => r.length >= width).length;
    if (sameWidth < data.length * 0.8) continue;
    // A comma is in every sentence: only a table with a header row.
    if (delim === "," && !hasHeader) continue;
    let cols: Col[];
    if (hasHeader) cols = headerCols.map((c) => c ?? "skip");
    else {
      // No header: the column of ratings, of dates, the longest texts, then the names.
      const score = (i: number, test: (s: string) => boolean) => data.filter((r) => r[i] != null && test(clean(r[i]))).length / data.length;
      cols = Array.from({ length: width }, () => "skip" as Col);
      const ratingCol = [...cols.keys()].find((i) => score(i, (s) => parseRatingLine(s) != null && parseRatingLine(s)?.rest === "") >= 0.8);
      if (ratingCol == null) continue;
      cols[ratingCol] = "stars";
      const dateCol = [...cols.keys()].find((i) => cols[i] === "skip" && score(i, (s) => !!findDate(s, now) && (findDate(s, now)?.rest ?? "x") === "") >= 0.8);
      if (dateCol != null) cols[dateCol] = "date";
      const avgLen = (i: number) => data.reduce((n, r) => n + clean(r[i] ?? "").length, 0) / data.length;
      let free = [...cols.keys()].filter((i) => cols[i] === "skip");
      if (free.length === 0) continue;
      // The column of names ("Marie Dupont", not "Top" or "Parfait"): the one reading most like
      // names (the leftmost on a tie), when there is another column for the text.
      if (free.length >= 2) {
        const names = (i: number) => score(i, likelyName);
        const nameCol = [...free].sort((a, b) => names(b) - names(a) || a - b)[0];
        if (names(nameCol) >= 0.6 && names(nameCol) > Math.min(...free.filter((i) => i !== nameCol).map(names))) {
          cols[nameCol] = "name";
          free = free.filter((i) => i !== nameCol);
        }
      }
      free.sort((a, b) => avgLen(b) - avgLen(a));
      cols[free[0]] = "text";
      // The shortest remaining column is the name (when not found above); one more becomes the title.
      const rest = free.slice(1).sort((a, b) => avgLen(a) - avgLen(b));
      if (!cols.includes("name") && rest[0] != null) cols[rest.shift() as number] = "name";
      if (rest[0] != null) cols[rest[0]] = "title";
    }
    if (!cols.includes("text")) continue;
    const ti = cols.indexOf("text");
    const out: PastedReview[] = [];
    for (const row of data) {
      const extra = row.length - width;
      const r = extra > 0 ? [...row.slice(0, ti), row.slice(ti, ti + extra + 1).join(delim), ...row.slice(ti + extra + 1)] : row;
      const get = (c: Col) => {
        const i = cols.indexOf(c);
        return i >= 0 ? clean((r[i] ?? "").replace(/\n+/g, "\n").replace(/[ \t]+/g, " ")) : "";
      };
      const rating = parseRatingLine(get("stars"));
      const textVal = unquote((r[cols.indexOf("text")] ?? "").replace(/[ \t]+/g, " ").trim());
      const titleVal = get("title");
      if (!textVal && !titleVal) continue;
      const d = get("date") ? findDate(get("date"), now) : null;
      out.push({
        name: get("name"),
        text: textVal || titleVal,
        stars: rating?.stars ?? 5,
        starsGuessed: !rating,
        ...(rating?.roundedFrom != null ? { roundedFrom: rating.roundedFrom } : {}),
        ...(textVal && titleVal ? { title: titleVal } : {}),
        ...(d ? { date: d.date } : {}),
      });
    }
    return out;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

function fit(r: Omit<PastedReview, "cut">): PastedReview {
  const cutTo = (s: string, max: number) => {
    if (s.length <= max) return s;
    const c = s.slice(0, max);
    return /[\ud800-\udbff]$/.test(c) ? c.slice(0, -1) : c;
  };
  const name = cutTo(r.name, REVIEW_LIMITS.name);
  const text = cutTo(r.text, REVIEW_LIMITS.text);
  const title = r.title != null ? cutTo(r.title, REVIEW_LIMITS.title) : undefined;
  const cut = name !== r.name || text !== r.text || title !== r.title;
  return { ...r, name, text, ...(title != null ? { title } : {}), ...(cut ? { cut } : {}) };
}

/** "- Top", "* Top", "• Top", "1. Top", "2) Top": a list item and its text. */
const BULLET = /^[ \t]*(?:[-*•–]|\d{1,3}[.)])[ \t]+(\S.*)$/;
const bulletText = (line: string): string | null => {
  const m = line.match(BULLET);
  // "- Marie" under a review is a signature, not a list item.
  return m && !likelyName(clean(m[1])) ? m[1] : null;
};

/**
 * The paste's lines, classified. A list without any rating ("- Top\n- Parfait", "1. …\n2. …"):
 * one review per item, the markers dropped (a line ending in « : » just above the list is its
 * heading, not a review).
 */
function blockLines(text: string, now: Date): Line[] {
  const opts: RatingOptions = { asterisks: !usesBulletAsterisks(text) };
  const lines = classifyLines(text, now, opts);
  const raw = text.split("\n");
  const items = raw.filter((l) => bulletText(l) != null).length;
  if (items < 2 || lines.some((l) => l.kind === "rating")) return lines;
  const first = raw.findIndex((l) => bulletText(l) != null);
  const out: string[] = [];
  raw.forEach((l, i) => {
    const item = bulletText(l);
    if (item != null) out.push("", item);
    else if (!(i < first && /:\s*$/.test(l) && raw.slice(i + 1, first).every((x) => !x.trim()))) out.push(l);
  });
  return classifyLines(out.join("\n"), now, opts);
}

/** Every review found in a paste, in order (at most PASTE_PARSE_LIMIT). */
export function parsePastedReviews(raw: string, now = new Date()): PasteResult {
  const text = normalizePaste(raw);
  if (!text.trim()) return { reviews: [], dropped: 0, format: "blocks" };
  const table = parseTable(text, now);
  const all = table ?? segment(blockLines(text, now)).flatMap((seg) => build(seg) ?? []);
  const kept = all.filter((r) => r.text.trim() !== "" || r.name !== "");
  return {
    reviews: kept.slice(0, PASTE_PARSE_LIMIT).map(fit),
    dropped: Math.max(0, kept.length - PASTE_PARSE_LIMIT),
    format: table ? "table" : "blocks",
  };
}

/** What to check on a pasted review before adding it (shown in the preview). */
export function pasteWarnings(r: Pick<PastedReview, "text" | "starsGuessed" | "cut" | "name">): string[] {
  const out: string[] = [];
  if (!r.text.trim()) out.push("Texte vide : l'avis ne sera pas affiché.");
  if (r.starsGuessed) out.push("Note non trouvée : 5 étoiles par défaut, à vérifier.");
  if (r.text.length > PASTE_LONG_TEXT) out.push(`Avis très long (${r.text.length.toLocaleString("fr-FR")} caractères) : vérifiez qu'il ne regroupe pas plusieurs avis.`);
  if (r.cut) out.push(`Coupé à la longueur maximale (${REVIEW_LIMITS.text.toLocaleString("fr-FR")} caractères pour le texte).`);
  if (!r.name.trim()) out.push("Sans nom : affiché sans signature.");
  return out;
}
