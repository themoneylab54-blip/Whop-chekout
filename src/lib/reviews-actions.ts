"use server";

import { requireAdmin } from "./auth";
import { db } from "./db";
import { decrypt, encrypt } from "./crypto";
import { extFetch } from "./ext";
import { log } from "./log";
import { shopifyGraphql } from "./shopify";
import type { ReviewSummary } from "./layout";
import { ratingSummary, readJudgeMePage, shopifyRatedProducts, shopifyRatingSummary, type ImportedReview } from "./reviews-import";

/*
 * "Avis clients" block imports (builder, signed-in admin only): the Judge.me API (private token
 * stored encrypted, never sent back to the browser) and the store rating from Shopify's standard
 * reviews.rating / reviews.rating_count product metafields.
 */

/**
 * `token` (Judge.me only): the saved token is unusable — "unreadable" (can't be decrypted),
 * "refused" (403: kept, may be a plan / permission issue) or "cleared" (401: revoked or changed,
 * deleted from the store). The builder then opens the token field so a new one can be pasted.
 */
export type ReviewsResult<T> = { ok: true; data: T } | { ok: false; error: string; token?: "unreadable" | "refused" | "cleared" };
/** Why a Judge.me import stopped early: the 1 000 reviews / 30 s limit, or a later page failing. */
export type JudgeMePartialReason = "limit" | "error";
/** Why the Shopify rating read stopped early: the 2 000 products limit, or a later page failing (throttled…). */
export type ShopifyPartialReason = "limit" | "error";

const JUDGEME_PAGE = 100;
/** 1 000 most recent reviews at most (10 calls): plenty to pick 20 and to compute an average. */
const JUDGEME_MAX_PAGES = 10;
/** Whole Judge.me import time budget: past it, the reviews read so far are used (capped). */
const JUDGEME_BUDGET_MS = 30_000;
/** Products per Shopify call (2 metafields each): 50 keeps each query's cost low (throttling). */
const SHOPIFY_RATING_PAGE = 50;
/** Shopify calls for the store rating: 40 × 50 = the first 2 000 active products. */
const SHOPIFY_RATING_PAGES = 40;
const TOKEN_RE = /^[A-Za-z0-9_-]{10,200}$/;

async function storeOf(storeId: string) {
  await requireAdmin();
  return db.store.findUnique({
    where: { id: storeId },
    select: { id: true, shopDomain: true, shopifyAccessToken: true, shopifyConnectedAt: true, judgemeApiToken: true },
  });
}

/** Whether a Judge.me token is saved (the token itself never leaves the server). */
export async function judgeMeStatusAction(storeId: string): Promise<{ connected: boolean; shopConnected: boolean }> {
  const store = await storeOf(storeId);
  return { connected: !!store?.judgemeApiToken, shopConnected: !!(store?.shopifyConnectedAt && store.shopDomain) };
}

/** Forgets the saved Judge.me token. */
export async function forgetJudgeMeAction(storeId: string): Promise<{ ok: true }> {
  await requireAdmin();
  await db.store.updateMany({ where: { id: storeId }, data: { judgemeApiToken: null } });
  return { ok: true };
}

/**
 * Published Judge.me reviews of the shop (most recent first, up to 1 000) and their average.
 * `token`: a newly pasted private token, saved (encrypted) once Judge.me accepts it; omitted,
 * the saved one is used.
 */
export async function importJudgeMeAction(
  storeId: string,
  token?: string,
): Promise<ReviewsResult<{ reviews: ImportedReview[]; summary: ReviewSummary | null; rated: number; capped: boolean; reason?: JudgeMePartialReason }>> {
  const store = await storeOf(storeId);
  if (!store) return { ok: false, error: "Boutique introuvable." };
  if (!store.shopDomain || !store.shopifyConnectedAt) return { ok: false, error: "Connectez d'abord votre boutique Shopify : Judge.me identifie vos avis par son adresse .myshopify.com." };
  const pasted = token?.trim();
  if (pasted && !TOKEN_RE.test(pasted)) return { ok: false, error: "Jeton Judge.me invalide : copiez le « Private API token » (Judge.me › Paramètres › Intégrations › Voir la clé API)." };
  let secret: string | null = pasted || null;
  if (!secret && store.judgemeApiToken) {
    try {
      secret = decrypt(store.judgemeApiToken);
    } catch {
      // Saved but unreadable (encryption key changed): the merchant pastes it again.
      return { ok: false, token: "unreadable", error: "Le jeton Judge.me enregistré est illisible : collez à nouveau votre « Private API token » (Judge.me › Paramètres › Intégrations › Voir la clé API)." };
    }
  }
  if (!secret) return { ok: false, error: "Collez votre jeton privé Judge.me pour importer vos avis." };

  const reviews: ImportedReview[] = [];
  const rated: { stars: number }[] = [];
  const seen = new Set<string>();
  let partial: JudgeMePartialReason | null = null;
  const deadline = Date.now() + JUDGEME_BUDGET_MS;
  // One page past the limit is only asked when the last one read was full: it tells whether
  // there are more reviews (partial) or the shop has exactly 1 000 (complete). Never kept.
  for (let page = 1; page <= JUDGEME_MAX_PAGES + 1; page++) {
    const probe = page > JUDGEME_MAX_PAGES;
    // Time budget for the whole import: what was read so far is kept (average marked partial).
    const left = deadline - Date.now();
    if (page > 1 && left < 2_000) {
      partial = "limit";
      break;
    }
    const url = new URL("https://judge.me/api/v1/reviews");
    url.searchParams.set("shop_domain", store.shopDomain);
    url.searchParams.set("api_token", secret);
    url.searchParams.set("per_page", String(JUDGEME_PAGE));
    url.searchParams.set("page", String(page));
    let res: Response;
    try {
      // No redirects: the private token is in the query string and must only ever reach judge.me.
      res = await extFetch("judgeme", "reviews", url, {
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(10_000, Math.max(left, 1_000))),
        headers: { Accept: "application/json" },
      });
    } catch {
      if (page > 1) {
        partial = probe ? "limit" : "error";
        break;
      }
      return { ok: false, error: "Judge.me ne répond pas : réessayez dans un instant." };
    }
    // A later page failing (Judge.me down, rate limit, unreadable answer): the pages already read
    // are kept and the import is marked partial, instead of throwing everything away.
    if (page > 1 && !res.ok) {
      partial = probe ? "limit" : "error";
      break;
    }
    if (res.status === 401 || res.status === 403) {
      const help = "copiez le « Private API token » (Judge.me › Paramètres › Intégrations › Voir la clé API) de cette boutique.";
      // The saved token revoked or changed (401): useless from now on, so it is deleted (never
      // retried on every import). A pasted one refused was never saved: the saved one is kept.
      if (!pasted && res.status === 401) {
        await db.store.updateMany({ where: { id: store.id }, data: { judgemeApiToken: null } });
        log.info("reviews.import", "Judge.me: saved token refused (401), deleted", { storeId: store.id });
        return { ok: false, token: "cleared", error: `Judge.me a refusé le jeton enregistré (révoqué ou changé) : il a été supprimé. Collez le nouveau jeton — ${help}` };
      }
      return { ok: false, ...(pasted ? {} : { token: "refused" as const }), error: `Judge.me a refusé le jeton : ${help}` };
    }
    if (res.status === 404 && page === 1) return { ok: false, error: `Judge.me ne connaît pas la boutique ${store.shopDomain} : vérifiez que l'application Judge.me y est installée.` };
    if (!res.ok) return { ok: false, error: `Judge.me indisponible (erreur ${res.status}) : réessayez plus tard ou importez un fichier CSV.` };
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      if (page > 1) {
        partial = probe ? "limit" : "error";
        break;
      }
      return { ok: false, error: "Réponse Judge.me illisible : réessayez plus tard ou importez un fichier CSV." };
    }
    const raw = (json as { reviews?: unknown[] } | null)?.reviews;
    if (probe) {
      // More reviews past the limit (or an answer that can't tell): partial; none: complete.
      if (!Array.isArray(raw) || raw.length > 0) partial = "limit";
      break;
    }
    const batch = readJudgeMePage(json, Date.now(), seen);
    for (const r of batch.reviews) reviews.push(r);
    for (const r of batch.rated) rated.push(r);
    if (!Array.isArray(raw) || raw.length < JUDGEME_PAGE) break;
  }
  const capped = partial != null;
  if (pasted) await db.store.update({ where: { id: store.id }, data: { judgemeApiToken: encrypt(pasted) } });
  log.info("reviews.import", `Judge.me: ${rated.length} published reviews read`, { storeId: store.id, count: rated.length, capped, reason: partial });
  // The average covers every published, rated review read (with or without text); a partial
  // import says so on the stored summary (the buyer is told it covers the most recent ones).
  const read = ratingSummary(rated, "judgeme");
  const summary = read && partial ? { ...read, partial: true } : read;
  return { ok: true, data: { reviews, summary, rated: rated.length, capped, ...(partial ? { reason: partial } : {}) } };
}

type RatingPage = {
  products: {
    nodes: { rating: { value: string } | null; ratingCount: { value: string } | null }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

/**
 * Store-wide rating from the standard product metafields reviews.rating / reviews.rating_count
 * (written by Judge.me, Loox, Okendo, Yotpo, Stamped, Shopify Product Reviews…). Needs read_products.
 */
export async function shopifyReviewRatingAction(
  storeId: string,
): Promise<ReviewsResult<{ summary: ReviewSummary | null; products: number; capped: boolean; reason?: ShopifyPartialReason }>> {
  const store = await storeOf(storeId);
  if (!store?.shopifyConnectedAt || !store.shopDomain || !store.shopifyAccessToken) return { ok: false, error: "Connectez Shopify pour récupérer votre note." };
  const rows: { rating: string | null; count: string | null }[] = [];
  let after: string | null = null;
  let partial: ShopifyPartialReason | null = null;
  for (let page = 0; page < SHOPIFY_RATING_PAGES; page++) {
    let data: RatingPage;
    try {
      data = await shopifyGraphql<RatingPage>(
        store,
        `query ReviewRatings($after: String) { products(first: ${SHOPIFY_RATING_PAGE}, after: $after, query: "status:active") { nodes { rating: metafield(namespace: "reviews", key: "rating") { value } ratingCount: metafield(namespace: "reviews", key: "rating_count") { value } } pageInfo { hasNextPage endCursor } } }`,
        { after },
      );
    } catch (err) {
      // A later page failing (throttled, Shopify slow): the products already read are kept and
      // the rating is marked partial, like a Judge.me import whose later page fails.
      if (page > 0) {
        partial = "error";
        break;
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/access denied|scope/i.test(msg)) return { ok: false, error: "Shopify refuse la lecture des produits : reconnectez l'app Shopify (Connexions › Shopify)." };
      return { ok: false, error: /injoignable|timeout|abort|throttl/i.test(msg) ? "Shopify ne répond pas : réessayez dans un instant." : "Lecture de la note Shopify impossible." };
    }
    for (const p of data.products.nodes) rows.push({ rating: p.rating?.value ?? null, count: p.ratingCount?.value ?? null });
    if (!data.products.pageInfo.hasNextPage || !data.products.pageInfo.endCursor) break;
    // More products than read: the rating covers the first SHOPIFY_RATING_PAGES × SHOPIFY_RATING_PAGE.
    if (page === SHOPIFY_RATING_PAGES - 1) partial = "limit";
    after = data.products.pageInfo.endCursor;
  }
  const capped = partial != null;
  // Capped: the stored summary says so (the buyer is told it covers part of the store's reviews).
  const read = shopifyRatingSummary(rows);
  const summary = read && partial ? { ...read, partial: true } : read;
  // "Note récupérée sur N produits": only the products whose metafields were usable.
  return { ok: true, data: { summary, products: shopifyRatedProducts(rows), capped, ...(partial ? { reason: partial } : {}) } };
}
