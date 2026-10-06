import { MAX_REVIEW_ITEMS, REVIEW_LIMITS, type ReviewItem, type ReviewSummary } from "./layout";

/*
 * Real customer reviews for the "Avis clients" block: parsing of review apps' CSV exports
 * (Judge.me, Loox, Okendo, Yotpo, Stamped, Shopify Product Reviews…) and of the Judge.me API,
 * selection of the reviews shown, the overall rating (all published reviews, never only the
 * hand-picked ones) and the per-cart order. Pure: builder, server and tests.
 */

/** A review read from an export or an API, before the merchant picks the ones shown. */
export type ImportedReview = ReviewItem & { source: "csv" | "judgeme" };

export type CsvImportResult = {
  /** Reviews that can be shown (with a text), before the merchant picks. */
  reviews: ImportedReview[];
  /** Rows skipped: unpublished / spam, no rating, duplicate… */
  skipped: number;
  /** Published, rated reviews without any text: not shown, but counted in the average. */
  withoutText: number;
  /** Average of every published, rated review of the file (text or not), duplicates once. */
  summary: ReviewSummary | null;
  /** Columns recognised (field -> header as written in the file), for the preview. */
  columns: Partial<Record<Field, string>>;
  /** Blocking problem (not a review export): shown to the merchant instead of a preview. */
  error?: string;
};

/* ------------------------------------------------------------------ */
/* CSV                                                                 */
/* ------------------------------------------------------------------ */

/** Delimiter of the header line: ",", ";" (French Excel) or tab, outside quotes. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && (c === "\n" || c === "\r")) break;
    else if (!quoted && c in counts) counts[c]++;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return n > 0 ? best : ",";
}

/** A CSV file that cannot be read reliably (the message is shown to the merchant). */
export class CsvParseError extends Error {}

/**
 * Text of an uploaded CSV file: UTF-16 (LE / BE, told by their byte order mark: Excel's
 * "Unicode text"), UTF-8 (with or without BOM), else Windows-1252 (older Excel exports).
 */
export function decodeCsvBytes(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

/**
 * RFC 4180 parser: quoted fields with delimiters, doubled quotes and line breaks inside,
 * CRLF / LF / CR line ends, UTF-8 BOM. Blank lines are dropped. A quote never closed before the
 * end of the file throws a CsvParseError (the rest of the file would be read as one field).
 */
export function parseCsv(input: string, delimiter?: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const sep = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let line = 1;
  let quoteLine = 1;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = "";
    if (row.some((v) => v.trim() !== "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "\r" || (c === "\n" && text[i - 1] !== "\r")) line++;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field.trim() === "") {
      field = "";
      quoted = true;
      quoteLine = line;
    } else if (c === sep) {
      row.push(field);
      field = "";
    } else if (c === "\r" || c === "\n") {
      endRow();
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else field += c;
    i++;
  }
  if (quoted) throw new CsvParseError(`Guillemet non fermé (ligne ${quoteLine}) : le fichier est incomplet ou mal exporté.`);
  if (field !== "" || row.length) endRow();
  return rows;
}

type Field = "id" | "name" | "text" | "stars" | "title" | "date" | "verified" | "productHandle" | "productId" | "productTitle" | "productUrl" | "photo" | "status" | "published";

/** Header names used by the review apps' exports, normalised (lowercase, accents and punctuation → "_"), by priority. */
const ALIASES: Record<Field, string[]> = {
  /** The review's own id (duplicates / re-exports are told apart by it when present). */
  id: ["review_id", "id", "review_uuid", "uuid"],
  name: ["reviewer_name", "author", "author_name", "display_name", "nickname", "full_name", "name", "customer_name", "reviewer", "reviewer_display_name", "user_name", "username", "nom", "client"],
  text: ["body", "review_body", "review_content", "review", "content", "review_text", "text", "comment", "comments", "message", "avis", "commentaire"],
  stars: ["rating", "review_score", "stars", "star_rating", "score", "note", "review_rating"],
  title: ["title", "review_title", "headline", "subject", "titre"],
  date: [
    "review_date",
    "created_at",
    "date_created",
    "date",
    "created",
    "submitted_at",
    "published_at",
    "reviewed_at",
    "review_created_at",
    "created_date",
    // Yotpo: "Review Creation Date"; other apps / hand-made files.
    "review_creation_date",
    "creation_date",
    "review_created_date",
    "review_submitted_at",
    "review_submission_date",
    "submission_date",
    "submitted_date",
    "date_submitted",
    "date_posted",
    "posted_at",
    "review_published_at",
    "published_date",
    "date_avis",
    "date_de_l_avis",
    "date_de_publication",
  ],
  verified: ["verified_purchase", "verified_buyer", "is_verified_buyer", "verified_buyer_badge", "is_verified", "buyer_verified", "verified", "verified_order", "achat_verifie"],
  productHandle: ["product_handle", "handle", "product_slug"],
  productId: ["product_id", "productid", "shopify_product_id", "product_external_id", "external_product_id"],
  productTitle: ["product_title", "product_name", "product"],
  productUrl: ["product_url", "product_link"],
  photo: ["picture_urls", "photo_urls", "image_urls", "media_urls", "photos", "pictures", "images", "img", "photo_url", "picture_url", "image_url", "photo", "image", "media"],
  status: ["status", "state", "curated", "review_status", "moderation_status"],
  published: ["published", "is_published"],
};

export function normalizeHeader(h: string): string {
  return h
    .replace(/^\uFEFF/, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // camelCase headers (Loox: productId) → product_id
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Column index per field (first alias found wins). */
export function mapColumns(headers: string[]): Partial<Record<Field, number>> {
  const norm = headers.map(normalizeHeader);
  const out: Partial<Record<Field, number>> = {};
  const used = new Set<number>();
  for (const field of Object.keys(ALIASES) as Field[]) {
    for (const alias of ALIASES[field]) {
      const at = norm.findIndex((h, i) => h === alias && !used.has(i));
      if (at >= 0) {
        out[field] = at;
        used.add(at);
        break;
      }
    }
  }
  return out;
}

/** Review states that are not public: never imported. */
export const HIDDEN_STATES = /^(spam|hidden|rejected|unpublished|not_published|pending|deleted|archived|inactive|declined|trash|trashed|disapproved|unapproved|removed|false|no|0)$/;
const TRUE_VALUES = /^(true|yes|y|1|oui|vrai|x|verified|verified_buyer|verified_purchase|buyer|verified_reviewer|confirmed)$/;

/** "Achat vérifié" only when the export says so explicitly. */
export function parseVerified(v: string | undefined | null): boolean {
  return TRUE_VALUES.test(normalizeHeader(String(v ?? "")));
}

/**
 * The rating as written, 1 to 5 ("4,5" → 4.5), or null. Scores on 10 or 100 are not guessed.
 * The average is computed on these raw values (never on the rounded stars of the cards).
 */
export function parseRating(v: string | number | undefined | null): number | null {
  const s = typeof v === "number" ? "" : String(v ?? "").trim();
  if (typeof v !== "number" && s === "") return null;
  const n = typeof v === "number" ? v : Number(s.replace(",", "."));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : null;
}

/**
 * Whole stars of an imported review's card: the rating floored to the half star, then to the
 * whole star the card can draw (4.5 → 4, never 5), so "5★ uniquement" never keeps a 4.5.
 */
export function cardStars(rating: number): number {
  const half = Math.floor(rating * 2 + 1e-9) / 2;
  return Math.min(5, Math.max(1, Math.floor(half)));
}

/** 1 to 5 whole stars of a review card ("5", "4.0", "4,5" → 5), or null. */
export function parseStars(v: string | number | undefined | null): number | null {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim().replace(",", "."));
  if (!Number.isFinite(n)) return null;
  const r = Math.round(n);
  return r >= 1 && r <= 5 ? r : null;
}

/**
 * YYYY-MM-DD from ISO dates ("2024-03-05", "2024-03-05T10:00:00Z", "2024-03-05 10:00:00 UTC") and
 * day/month/year dates when unambiguous (a part above 12). Dates in the future or before 2000: null.
 */
export function parseReviewDate(v: string | undefined | null, now = Date.now()): string | undefined {
  const s = String(v ?? "").trim();
  if (!s) return undefined;
  let y: number, m: number, d: number;
  const iso = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[T\s])/.exec(s);
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?:$|[T\s])/.exec(s);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    y = Number(dmy[3]);
    if (a > 12 && b <= 12) [d, m] = [a, b];
    else if (b > 12 && a <= 12) [m, d] = [a, b];
    else return undefined; // 05/03/2024: 5 March or May 3rd? Not guessed.
  } else {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return undefined;
    const dt = new Date(t);
    [y, m, d] = [dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()];
  }
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return undefined;
  if (y < 2000 || t > now + 86_400_000) return undefined;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const VIDEO_PATH = /\.(mp4|m4v|mov|webm|ogv|avi|mkv)$/i;

/**
 * First https image of a list ("url1,url2", "url1 | url2", JSON array…); http is upgraded like
 * block images. A comma separates two URLs only when the next one starts right after it (CDN
 * URLs may hold commas: "…/w_300,h_300/a.jpg"). Videos are skipped (not a photo).
 */
export function firstPhotoUrl(v: string | undefined | null): string | undefined {
  const s = String(v ?? "");
  for (const raw of s.split(/[\s;|"'[\]]+|,(?=\s*(?:https?:|javascript:|data:))/i)) {
    const u = raw.trim().replace(/,+$/, "").replace(/^http:\/\//i, "https://");
    if (!/^https:\/\/[^\s]+\.[^\s]+/i.test(u) || !URL.canParse(u) || u.length > 2000) continue;
    if (VIDEO_PATH.test(new URL(u).pathname)) continue;
    return u;
  }
  return undefined;
}

/**
 * Name shown to buyers: first name and last-name initial ("Camille Rousseau" → "Camille R."),
 * as review apps display them. E-mail addresses are never shown.
 */
export function displayName(v: string | undefined | null): string {
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || s.includes("@")) return "";
  const parts = s.split(" ");
  if (parts.length === 1) return s.slice(0, 80);
  const last = parts[parts.length - 1];
  const initial = /^[\p{L}]\.?$/u.test(last) ? last.replace(/\.?$/, ".") : `${Array.from(last)[0].toUpperCase()}.`;
  return `${parts.slice(0, -1).join(" ")} ${initial}`.slice(0, 80);
}

/** Named HTML entities review apps leave in their exports (French and German accents, typographic quotes…). */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  eacute: "é",
  egrave: "è",
  ecirc: "ê",
  euml: "ë",
  agrave: "à",
  aacute: "á",
  acirc: "â",
  auml: "ä",
  atilde: "ã",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  icirc: "î",
  iuml: "ï",
  iacute: "í",
  igrave: "ì",
  ocirc: "ô",
  ouml: "ö",
  oacute: "ó",
  ograve: "ò",
  otilde: "õ",
  oslash: "ø",
  oelig: "œ",
  ucirc: "û",
  uuml: "ü",
  ugrave: "ù",
  uacute: "ú",
  yuml: "ÿ",
  ntilde: "ñ",
  szlig: "ß",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  sbquo: "‚",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  hellip: "…",
  ndash: "–",
  mdash: "—",
  euro: "€",
  pound: "£",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  middot: "·",
  bull: "•",
  times: "×",
  iexcl: "¡",
  iquest: "¿",
  thinsp: "\u2009",
  ensp: "\u2002",
  emsp: "\u2003",
  shy: "",
};
/** Upper-case accented letters (&Eacute; → É) from their lower-case entity. */
function namedEntity(name: string): string | undefined {
  if (Object.hasOwn(ENTITIES, name)) return ENTITIES[name];
  const lower = name.toLowerCase();
  if (name !== lower && /^[A-Z]/.test(name) && Object.hasOwn(ENTITIES, lower) && /^[a-z]{1,2}(acute|grave|circ|uml|cedil|tilde|ring|lig|slash)$/.test(lower)) {
    return ENTITIES[lower].toUpperCase();
  }
  if (Object.hasOwn(ENTITIES, lower) && /^(amp|lt|gt|quot|nbsp)$/.test(lower)) return ENTITIES[lower];
  return undefined;
}
/**
 * Plain text: HTML tags removed (only real tags: "<3 cm" or "qualité > prix" stay), entities
 * decoded (numeric and the common named ones), whitespace tidied, cut to `max` characters.
 */
export function plainText(v: string | undefined | null, max: number): string {
  const s = String(v ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+[0-9]*);/gi, (m, e: string) => {
      const k = e.toLowerCase();
      if (!k.startsWith("#")) return namedEntity(e) ?? m;
      if (k === "#39") return "'";
      const cp = k.startsWith("#x") ? parseInt(k.slice(2), 16) : Number(k.slice(1));
      // NUL, lone surrogates and code points past U+10FFFF: not a character, left as written.
      if (!Number.isSafeInteger(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
      return String.fromCodePoint(cp);
    })
    .replace(/\r\n?/g, "\n")
    // Control characters (NUL included, whether written or decoded) except line breaks and tabs.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Numeric Shopify product id ("gid://shopify/Product/123", "123"), or undefined. */
export function productIdOf(v: string | number | undefined | null): string | undefined {
  const m = /(\d{1,20})\s*$/.exec(String(v ?? "").trim());
  return m ? m[1] : undefined;
}

function handleOf(handle: string | undefined, url: string | undefined): string | undefined {
  const h = String(handle ?? "").trim().toLowerCase();
  if (/^[a-z0-9][a-z0-9_-]{0,254}$/.test(h)) return h;
  const m = /\/products\/([^/?#\s]+)/i.exec(String(url ?? ""));
  if (m) {
    try {
      return decodeURIComponent(m[1]).toLowerCase().slice(0, 255);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Key telling a merchant's typed review apart from an imported copy of it (block merge). */
const reviewKey = (r: Pick<ReviewItem, "name" | "text">) => `${r.name.trim().toLowerCase()}|${r.text.trim().toLowerCase().replace(/\s+/g, " ")}`;

/**
 * Key telling two copies of one review (duplicated rows, re-exports) apart from two reviews:
 * the review's own id when the source gives one, else the reviewer as written in the source
 * (raw name / email, before masking: "Marie Dupont" and "Marie Durand" both show "Marie D."
 * but are two people), the raw rating, the text and the date. Null (never deduplicated) when
 * there is neither an id nor a text: two rating-only rows can't be told apart from two
 * buyers giving the same rating, so both count.
 */
export function dedupKey(
  id: string | number | null | undefined,
  rawWho: string,
  rating: number,
  text: string,
  date: string | undefined,
): string | null {
  const own = String(id ?? "").trim();
  if (own) return `id:${own}`;
  const body = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!body) return null;
  const who = rawWho.trim().toLowerCase().replace(/\s+/g, " ");
  // Anonymous, undated and short ("Super !", "Parfait"): many buyers write exactly that, so
  // two such rows are two reviews, not one copied.
  // (Judge.me's "name|email" with both empty is "|": no reviewer either.)
  if (!/[\p{L}\p{N}]/u.test(who) && !date && body.length < MIN_TEXT) return null;
  return `${who}|${rating}|${body}|${date ?? ""}`;
}

/** Reviewer e-mail columns (never shown; only tell two reviewers apart when deduplicating). */
const EMAIL_HEADERS = ["reviewer_email", "email", "author_email", "customer_email", "email_address", "user_email", "mail"];

/**
 * Reviews of a review app's CSV export. Unpublished / spam / hidden rows, rows without a 1–5
 * rating and duplicates are skipped (counted). `verified` only when a "verified purchase"
 * column says so.
 */
export function parseReviewsCsv(text: string, now = Date.now()): CsvImportResult {
  const empty = { reviews: [], skipped: 0, withoutText: 0, summary: null };
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (err) {
    if (err instanceof CsvParseError) return { ...empty, columns: {}, error: err.message };
    throw err;
  }
  if (rows.length === 0) return { ...empty, columns: {}, error: "Le fichier est vide." };
  const headers = rows[0];
  const cols = mapColumns(headers);
  const columns: CsvImportResult["columns"] = {};
  for (const [f, i] of Object.entries(cols) as [Field, number][]) columns[f] = headers[i].replace(/^\uFEFF/, "").trim();
  if (cols.stars == null || (cols.text == null && cols.title == null)) {
    return {
      ...empty,
      columns,
      error:
        "Colonnes introuvables : le fichier doit contenir au moins une note (rating) et le texte de l'avis (body / review). Exportez vos avis depuis votre application d'avis au format CSV.",
    };
  }
  const get = (row: string[], f: Field) => (cols[f] == null ? "" : (row[cols[f]!] ?? "").trim());
  // Name: the first filled of the name columns (Loox: nickname often empty, full_name set).
  const norm = headers.map(normalizeHeader);
  const nameCols = ALIASES.name.map((alias) => norm.indexOf(alias)).filter((i) => i >= 0);
  const nameOf = (row: string[]) => nameCols.map((i) => (row[i] ?? "").trim()).find((v) => v && !v.includes("@")) ?? "";
  // Who wrote it, as written (every name and e-mail column): the duplicate key, never shown.
  const whoCols = [...nameCols, ...EMAIL_HEADERS.map((h) => norm.indexOf(h)).filter((i) => i >= 0)];
  const rawWhoOf = (row: string[]) => whoCols.map((i) => (row[i] ?? "").trim()).join("|");
  // Judge.me's "curated" column: "ok", "spam" or "not-yet" (not moderated yet). A "not-yet" row
  // is imported only when the file has a published column saying it is public; without one,
  // nothing says a buyer can see it, so it is skipped. Only for a column named "curated": a
  // "not yet" in another app's status column means nothing known and is not guessed.
  const curatedCol = norm.indexOf("curated");
  const seen = new Set<string>();
  const reviews: ImportedReview[] = [];
  const rated: { stars: number }[] = [];
  let skipped = 0;
  let withoutText = 0;
  for (const row of rows.slice(1)) {
    const status = normalizeHeader(get(row, "status"));
    const published = normalizeHeader(get(row, "published"));
    const rating = parseRating(get(row, "stars"));
    const notYetCurated = curatedCol >= 0 && normalizeHeader(row[curatedCol] ?? "") === "not_yet" && !(published && TRUE_VALUES.test(published));
    const curatedHidden = curatedCol >= 0 && HIDDEN_STATES.test(normalizeHeader(row[curatedCol] ?? ""));
    if ((status && HIDDEN_STATES.test(status)) || curatedHidden || notYetCurated || (published && /^(false|no|0|non|faux)$/.test(published)) || rating == null) {
      skipped++;
      continue;
    }
    const body = plainText(get(row, "text"), REVIEW_LIMITS.text);
    const title = plainText(get(row, "title"), REVIEW_LIMITS.title);
    const name = displayName(nameOf(row));
    const date = parseReviewDate(get(row, "date"), now);
    const key = dedupKey(get(row, "id"), rawWhoOf(row), rating, body || title, date);
    if (key != null) {
      if (seen.has(key)) {
        skipped++;
        continue;
      }
      seen.add(key);
    }
    rated.push({ stars: rating });
    if (!body && !title) {
      withoutText++;
      continue;
    }
    const review: ImportedReview = {
      name,
      text: body || title,
      stars: cardStars(rating),
      verified: parseVerified(get(row, "verified")),
      source: "csv",
    };
    if (body && title) review.title = title;
    if (date) review.date = date;
    const photoUrl = firstPhotoUrl(get(row, "photo"));
    if (photoUrl) review.photoUrl = photoUrl;
    const productHandle = handleOf(get(row, "productHandle"), get(row, "productUrl"));
    if (productHandle) review.productHandle = productHandle;
    const productId = productIdOf(get(row, "productId"));
    if (productId) review.productId = productId;
    const productTitle = plainText(get(row, "productTitle"), 255);
    if (productTitle && !/^https?:\/\//i.test(productTitle)) review.productTitle = productTitle;
    reviews.push(review);
  }
  return { reviews, skipped, withoutText, summary: ratingSummary(rated, "csv", now), columns };
}

/** parseReviewsCsv on an uploaded file's bytes (decoded as decodeCsvBytes does): the CSV worker's job. */
export function parseReviewsBytes(bytes: ArrayBuffer | Uint8Array, now = Date.now()): CsvImportResult {
  return parseReviewsCsv(decodeCsvBytes(bytes), now);
}

/* ------------------------------------------------------------------ */
/* Judge.me API                                                        */
/* ------------------------------------------------------------------ */

type JudgeMeReview = {
  id?: number | string | null;
  title?: string | null;
  body?: string | null;
  rating?: number | string | null;
  product_external_id?: number | string | null;
  product_handle?: string | null;
  product_title?: string | null;
  reviewer?: { name?: string | null; email?: string | null; verified_buyer?: boolean | null } | null;
  verified?: string | null;
  created_at?: string | null;
  published?: boolean | null;
  hidden?: boolean | null;
  curated?: string | null;
  pictures?: { hidden?: boolean | null; urls?: { original?: string; huge?: string; compact?: string; small?: string } | null }[] | null;
};

/** Published reviews of a Judge.me API page (/api/v1/reviews). "Achat vérifié" = Judge.me's verified buyer. */
export function parseJudgeMeReviews(json: unknown, now = Date.now()): ImportedReview[] {
  return readJudgeMePage(json, now).reviews;
}

/**
 * One Judge.me API page: the reviews that can be shown (with a text) and the ratings of every
 * published review (text or not, for the average). `seen` (shared across pages) drops a review
 * met twice, by its Judge.me id.
 */
export function readJudgeMePage(json: unknown, now = Date.now(), seen = new Set<string>()): { reviews: ImportedReview[]; rated: { stars: number }[] } {
  const list = (json && typeof json === "object" && Array.isArray((json as { reviews?: unknown }).reviews) ? (json as { reviews: JudgeMeReview[] }).reviews : []) as JudgeMeReview[];
  const out: ImportedReview[] = [];
  const rated: { stars: number }[] = [];
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    if (r.published === false || r.hidden === true || r.curated === "spam") continue;
    // Not moderated yet: imported only when Judge.me says it is published.
    if ((r.curated === "not-yet" || r.curated === "not_yet") && r.published !== true) continue;
    const rating = parseRating(r.rating ?? null);
    if (rating == null) continue;
    const body = plainText(r.body, REVIEW_LIMITS.text);
    const title = plainText(r.title, REVIEW_LIMITS.title);
    const name = displayName(r.reviewer?.name);
    const date = parseReviewDate(r.created_at, now);
    const key = dedupKey(r.id, `${String(r.reviewer?.name ?? "").trim()}|${String(r.reviewer?.email ?? "").trim()}`, rating, body || title, date);
    if (key != null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    rated.push({ stars: rating });
    if (!body && !title) continue;
    const review: ImportedReview = {
      name,
      text: body || title,
      stars: cardStars(rating),
      verified: r.verified === "buyer" || r.reviewer?.verified_buyer === true,
      source: "judgeme",
    };
    if (body && title) review.title = title;
    if (date) review.date = date;
    const pic = (r.pictures ?? []).find((p) => p && !p.hidden && p.urls);
    const photoUrl = firstPhotoUrl(pic?.urls?.compact ?? pic?.urls?.small ?? pic?.urls?.original ?? "");
    if (photoUrl) review.photoUrl = photoUrl;
    const productHandle = handleOf(r.product_handle ?? undefined, undefined);
    if (productHandle) review.productHandle = productHandle;
    const productId = productIdOf(r.product_external_id);
    if (productId) review.productId = productId;
    const productTitle = plainText(r.product_title, 255);
    if (productTitle) review.productTitle = productTitle;
    out.push(review);
  }
  return { reviews: out, rated };
}

/* ------------------------------------------------------------------ */
/* Selection                                                           */
/* ------------------------------------------------------------------ */

export type SelectOptions = {
  /** Lowest rating kept (default 4). */
  minStars?: number;
  /** Only reviews with a real sentence (default true): "Top" alone convinces nobody. */
  withText?: boolean;
  /** "best": rating, then photo, then most recent. "recent": most recent first. */
  sort?: "best" | "recent";
  max?: number;
};

const MIN_TEXT = 20;
const byDateDesc = (a: ReviewItem, b: ReviewItem) => (b.date ?? "").localeCompare(a.date ?? "");
const productKey = (r: Pick<ReviewItem, "productHandle" | "productId">) => r.productHandle || r.productId || "";

/** Reviews passing the filters, in display order (not yet cut to `max`). */
export function rankReviews<T extends ReviewItem>(all: T[], opts: SelectOptions = {}): T[] {
  const minStars = opts.minStars ?? 4;
  const withText = opts.withText ?? true;
  const list = all.filter((r) => r.stars >= minStars && (!withText || r.text.trim().length >= MIN_TEXT));
  if (opts.sort === "recent") return [...list].sort(byDateDesc);
  return [...list].sort((a, b) => b.stars - a.stars || Number(!!b.photoUrl) - Number(!!a.photoUrl) || Number(b.verified) - Number(a.verified) || byDateDesc(a, b));
}

/**
 * The reviews pre-selected for the block: best (or most recent) first, taking the products in
 * turn so one best-seller does not fill every slot (each product in the cart then has its own).
 */
export function selectReviews<T extends ReviewItem>(all: T[], opts: SelectOptions = {}): T[] {
  return selectRanked(rankReviews(all, opts), opts.max);
}

/** selectReviews on an already ranked list (the builder ranks once per filter change). O(n). */
export function selectRanked<T extends ReviewItem>(ranked: T[], maxItems?: number): T[] {
  const max = Math.max(0, Math.min(maxItems ?? MAX_REVIEW_ITEMS, MAX_REVIEW_ITEMS));
  const byProduct = new Map<string, T[]>();
  for (const r of ranked) {
    const k = productKey(r);
    const q = byProduct.get(k);
    if (q) q.push(r);
    else byProduct.set(k, [r]);
  }
  const queues = [...byProduct.values()];
  const out: T[] = [];
  // Round r takes the r-th review of each product: at most `max` rounds.
  for (let round = 0; out.length < max; round++) {
    let any = false;
    for (const q of queues) {
      if (round >= q.length) continue;
      any = true;
      out.push(q[round]);
      if (out.length >= max) break;
    }
    if (!any) break;
  }
  return out;
}

/** The merchant's own typed reviews of a block (neither samples nor imports): kept by an import. */
export function ownReviews(current: ReviewItem[], isSample: (r: ReviewItem) => boolean): ReviewItem[] {
  return current.filter((r) => !isSample(r) && (r.source == null || r.source === "manual"));
}

/**
 * Block items after an import: the merchant's own typed reviews always stay (the import only
 * gets the room left, MAX_REVIEW_ITEMS − own), earlier imports and samples are replaced.
 */
export function mergeImported(current: ReviewItem[], picked: ReviewItem[], isSample: (r: ReviewItem) => boolean): ReviewItem[] {
  const pickedKeys = new Set(picked.map(reviewKey));
  const own = ownReviews(current, isSample).filter((r) => !pickedKeys.has(reviewKey(r)));
  return [...picked.slice(0, Math.max(0, MAX_REVIEW_ITEMS - own.length)), ...own].slice(0, MAX_REVIEW_ITEMS);
}

/**
 * Block change of a confirmed import. The average shown always follows the import just made:
 * "Afficher la note moyenne" unticked (or no average read) removes the previous one, so an old
 * average never stays next to reviews it was not computed from.
 */
export function importPatch(
  current: ReviewItem[],
  picked: ReviewItem[],
  summary: ReviewSummary | null,
  withSummary: boolean,
  isSample: (r: ReviewItem) => boolean,
): { items?: ReviewItem[]; summary: ReviewSummary | null } {
  return {
    ...(picked.length > 0 ? { items: mergeImported(current, picked, isSample) } : {}),
    summary: withSummary && summary ? summary : null,
  };
}

/* ------------------------------------------------------------------ */
/* Overall rating                                                      */
/* ------------------------------------------------------------------ */

/**
 * A stored average, cut (never rounded up) to 2 decimals: 4.679 → 4.67, never 4.68, so the
 * displayed score is never higher than the reviews' real average. The 1e-9 absorbs float
 * noise (4.1 * 100 = 409.99999999999994 stays 4.1).
 */
export function floorScore(avg: number): number {
  return Math.floor(avg * 100 + 1e-9) / 100;
}

/**
 * Where the imported reviews among `items` come from, for the buyer-facing transparency line:
 * "judgeme" when they all come from the Judge.me API, "app" when any comes from a CSV export
 * (a review app not named), null when none is imported (hand-typed only: no line).
 */
export function importedReviewsOrigin(items: Pick<ReviewItem, "source">[]): "judgeme" | "app" | null {
  const imported = items.filter((r) => r.source === "csv" || r.source === "judgeme");
  if (imported.length === 0) return null;
  return imported.every((r) => r.source === "judgeme") ? "judgeme" : "app";
}

/**
 * What an imported average covers, told next to it in the builder, by source: a CSV every review
 * of the file; Judge.me every published review, or only the N read when the import stopped
 * early; Shopify (active products' metafields) every published review of the store, or part of
 * them when the read stopped early.
 */
export function summaryScope(count: number, partial: boolean, source: ReviewSummary["source"] = "judgeme"): string {
  if (source === "csv") return "tous les avis du fichier";
  if (source === "shopify") return partial ? "une partie des avis publiés de la boutique" : "tous les avis publiés de la boutique";
  return partial ? `les ${count.toLocaleString("fr-FR")} avis lus` : "tous vos avis publiés";
}

/** YYYY-MM-DD (UTC) of the day a summary was computed. */
const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/**
 * Average and count of ALL the published, rated reviews read, text or not, duplicates once
 * (never of the selected ones alone). Raw ratings are averaged (4.5 stays 4.5).
 */
export function ratingSummary(all: { stars: number }[], source: ReviewSummary["source"], now = Date.now()): ReviewSummary | null {
  let count = 0;
  let sum = 0;
  for (const r of all) {
    if (!Number.isFinite(r.stars) || r.stars < 1 || r.stars > 5) continue;
    count++;
    sum += r.stars;
  }
  if (count === 0) return null;
  return { score: floorScore(sum / count), count, source, asOf: dayOf(now) };
}

/**
 * Store-wide rating from Shopify's standard product metafields reviews.rating (type "rating":
 * {"value":"4.6","scale_min":"1.0","scale_max":"5.0"}) and reviews.rating_count, written by
 * most review apps: averages weighted by each product's review count. Products with a rating
 * but no count are left out (their weight is unknown).
 */
export function shopifyRatingSummary(products: { rating?: string | null; count?: string | null }[], now = Date.now()): ReviewSummary | null {
  let total = 0;
  let weighted = 0;
  for (const p of products) {
    const read = shopifyProductRating(p);
    if (!read) continue;
    total += read.count;
    weighted += read.on5 * read.count;
  }
  if (total === 0) return null;
  const score = Math.min(5, Math.max(1, weighted / total));
  return { score: floorScore(score), count: total, source: "shopify", asOf: dayOf(now) };
}

/** Products whose metafields count in shopifyRatingSummary (the "N produits" told to the merchant). */
export function shopifyRatedProducts(products: { rating?: string | null; count?: string | null }[]): number {
  return products.filter((p) => shopifyProductRating(p) != null).length;
}

/** One product's rating on the 1–5 scale and its review count, or null when unusable. */
function shopifyProductRating(p: { rating?: string | null; count?: string | null }): { on5: number; count: number } | null {
  const count = Number(p.count ?? "");
  if (!Number.isInteger(count) || count <= 0 || !p.rating) return null;
  let value: number;
  let scaleMin = 1;
  let scaleMax = 5;
  try {
    const parsed: unknown = JSON.parse(p.rating);
    if (typeof parsed === "number" || typeof parsed === "string") {
      // A plain decimal metafield ("4.6" parses to the number 4.6): a value on the 1–5 scale.
      value = Number(parsed);
    } else {
      const j = (parsed ?? {}) as { value?: string | number; scale_min?: string | number; scale_max?: string | number };
      value = Number(j.value);
      if (j.scale_max != null) scaleMax = Number(j.scale_max);
      if (j.scale_min != null) scaleMin = Number(j.scale_min);
      else if (scaleMax !== 5) scaleMin = 0;
    }
  } catch {
    value = Number(p.rating);
  }
  if (![value, scaleMin, scaleMax].every(Number.isFinite) || scaleMin < 0 || scaleMax <= scaleMin || value < scaleMin || value > scaleMax || value <= 0) return null;
  // On the 5-star scale, proportionally (8/10 → 4 stars): a 0-based scale's low values are never
  // lifted to 1 star; a rating that would fall under 1 star is left out (the block shows 1–5).
  const on5 = scaleMax === 5 ? value : (value / scaleMax) * 5;
  if (on5 < 1) return null;
  return { on5, count };
}

/* ------------------------------------------------------------------ */
/* Per-cart order                                                      */
/* ------------------------------------------------------------------ */

export type CartProducts = { handles: string[]; productIds: string[] };

/** The cart's products, as the reviews name them (handles lowercased, numeric ids). */
export function cartProductsOf(lines: { productHandle?: string | null; productId?: string | null; gift?: boolean }[]): CartProducts {
  const buyer = lines.filter((l) => !l.gift);
  return {
    handles: [...new Set(buyer.map((l) => String(l.productHandle ?? "").toLowerCase()).filter(Boolean))],
    productIds: [...new Set(buyer.map((l) => productIdOf(l.productId)).filter((v): v is string => !!v))],
  };
}

/**
 * Reviews of the products in the cart first, then the general ones (no product), then the other
 * products'. Stable: the merchant's order is kept within each group.
 */
export function orderReviewsForCart<T extends Pick<ReviewItem, "productHandle" | "productId">>(items: T[], cart: CartProducts | null | undefined): T[] {
  if (!cart || (cart.handles.length === 0 && cart.productIds.length === 0)) return items;
  const handles = new Set(cart.handles.map((h) => h.toLowerCase()));
  const ids = new Set(cart.productIds);
  const rank = (r: T) => {
    if ((r.productHandle && handles.has(r.productHandle.toLowerCase())) || (r.productId && ids.has(r.productId))) return 0;
    return r.productHandle || r.productId ? 2 : 1;
  };
  return items
    .map((r, i) => ({ r, i, k: rank(r) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}
