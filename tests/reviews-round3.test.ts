import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBlock, formatRatingScore, type Block, type BlockOf, type ReviewItem } from "@/lib/layout";
import {
  cardStars,
  importPatch,
  mergeImported,
  parseReviewsBytes,
  parseReviewsCsv,
  plainText,
  rankReviews,
  readJudgeMePage,
  shopifyRatedProducts,
  shopifyRatingSummary,
} from "@/lib/reviews-import";
import { localizeBlock, remapListTranslations, textFields } from "@/components/checkout/localize";
import { untranslatedCount } from "@/components/builder/Translations";
import { isSampleReview } from "@/lib/sample-content";
import { ContentBlock, Stars, type ContentContext } from "@/components/checkout/blocks";
import { labelsFor, type Lang } from "@/components/checkout/i18n";

const NOW = Date.UTC(2026, 8, 28);

/* ---------- server action mocks (Judge.me / Shopify imports) ---------- */
const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  graphql: vi.fn(),
  store: {
    id: "s1",
    shopDomain: "shop.myshopify.com",
    shopifyAccessToken: "x",
    shopifyConnectedAt: new Date(),
    judgemeApiToken: "enc",
  } as Record<string, unknown>,
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(async () => "admin"), currentUser: vi.fn(async () => (await import("./session-stub")).ownerUser()) }));
vi.mock("@/lib/db", () => ({ db: { store: { findUnique: vi.fn(async () => mocks.store), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({})) } } }));
vi.mock("@/lib/crypto", () => ({ decrypt: () => "saved-token-123", encrypt: (s: string) => `enc:${s}` }));
vi.mock("@/lib/ext", () => ({ extFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock("@/lib/shopify", () => ({ shopifyGraphql: (...args: unknown[]) => mocks.graphql(...args) }));

const rv = (over: Partial<ReviewItem>): ReviewItem => ({ name: "A", text: "Un avis assez long pour compter vraiment.", stars: 5, verified: false, ...over });
const reviewsBlock = (items: ReviewItem[], i18n?: Block["i18n"]): BlockOf<"reviews"> => {
  const b = createBlock("reviews") as BlockOf<"reviews">;
  return { ...b, props: { ...b.props, layout: "stack", items }, ...(i18n ? { i18n } : {}) };
};

describe("1 · translations never land on another customer's card", () => {
  const imported = rv({ name: "Anna K.", text: "Old imported review text here long enough", source: "csv", verified: true });
  it("imported reviews are not translatable: no field, no override applied, not counted as untranslated", () => {
    const b = reviewsBlock([imported, rv({ name: "Moi", text: "Avis saisi à la main par le marchand", source: "manual" })], { en: { "items.0.text": "Totally rewritten text" } });
    expect(textFields(b.props).map((f) => f.path)).not.toContain("items.0.text");
    expect(textFields(b.props).map((f) => f.path)).toContain("items.1.text");
    expect((localizeBlock(b, "en").props as BlockOf<"reviews">["props"]).items[0].text).toBe(imported.text);
    // Only the block title (a shipped default is not counted) and the manual review's text.
    const paths = textFields(b.props).filter((f) => f.path.startsWith("items."));
    expect(paths.map((f) => f.path)).toEqual(["items.1.text"]);
    expect(untranslatedCount(b, "en")).toBe(1);
    const judge = reviewsBlock([{ ...imported, source: "judgeme" }]);
    expect(untranslatedCount(judge, "en")).toBe(0);
  });
  it("reviewer's probe: a re-import never shows an old translation on the new first review", () => {
    const b = reviewsBlock([imported], { en: { "items.0.text": "Totally rewritten text" } });
    const items = mergeImported(b.props.items, [rv({ name: "Bob L.", text: "New real review text from a different customer", stars: 4, verified: true, source: "judgeme" })], isSampleReview);
    const next = remapListTranslations(b as Block, { ...b, props: { ...b.props, items } } as Block);
    expect((localizeBlock(next, "en").props as BlockOf<"reviews">["props"]).items[0].text).toBe("New real review text from a different customer");
    expect(next.i18n).toBeUndefined();
  });
  const m1 = rv({ name: "Un", text: "Premier avis saisi à la main", source: "manual" });
  const m2 = rv({ name: "Deux", text: "Deuxième avis saisi à la main", source: "manual" });
  const m3 = rv({ name: "Trois", text: "Troisième avis saisi à la main", source: "manual" });
  const tr = { en: { title: "Reviews", "items.0.text": "First", "items.1.text": "Second", "items.2.text": "Third" } };
  const change = (items: ReviewItem[]) => {
    const b = reviewsBlock([m1, m2, m3], tr);
    return remapListTranslations(b as Block, { ...b, props: { ...b.props, items } } as Block).i18n;
  };
  it("manual reviews: removal moves the next ones' translations up", () => {
    expect(change([m1, m3])).toEqual({ en: { title: "Reviews", "items.0.text": "First", "items.1.text": "Third" } });
  });
  it("manual reviews: reorder follows each item", () => {
    expect(change([m3, m1, m2])).toEqual({ en: { title: "Reviews", "items.0.text": "Third", "items.1.text": "First", "items.2.text": "Second" } });
  });
  it("manual reviews: added item gets no translation, the others keep theirs", () => {
    const added = rv({ name: "", text: "", source: "manual" });
    expect(change([m1, m2, m3, added])).toEqual(tr);
  });
  it("in-place edit keeps the slot's translation; an import merged in drops the replaced ones", () => {
    expect(change([m1, { ...m2, text: "Deuxième avis corrigé" }, m3])).toEqual(tr);
    const merged = mergeImported([m1, m2, m3], [rv({ name: "Imp", text: "Avis importé depuis Judge.me assez long", source: "judgeme", verified: true })], isSampleReview);
    // [imported, m1, m2, m3]: the manual ones keep their text's translation, at their new slots.
    expect(change(merged)).toEqual({ en: { title: "Reviews", "items.1.text": "First", "items.2.text": "Second", "items.3.text": "Third" } });
  });
  it("same block reference or no translations: unchanged object", () => {
    const b = reviewsBlock([m1]);
    const next = { ...b, props: { ...b.props, items: [] } } as Block;
    expect(remapListTranslations(b as Block, next)).toBe(next);
  });
});

describe("2 · the average is floored to one decimal", () => {
  it("4.96 → 4,9, never 5,0", () => {
    expect(formatRatingScore(4.96, "fr-FR")).toBe("4,9");
    expect(formatRatingScore(4.99, "en-US")).toBe("4.9");
    expect(formatRatingScore(5, "fr-FR")).toBe("5,0");
  });
});

describe("3 · card stars floored: « 5★ uniquement » excludes a 4.5", () => {
  it("CSV and Judge.me", () => {
    expect(cardStars(4.5)).toBe(4);
    expect(cardStars(4.99)).toBe(4);
    expect(cardStars(5)).toBe(5);
    expect(cardStars(1)).toBe(1);
    const csv = parseReviewsCsv("rating,body\n4.5,Très bon produit reçu rapidement merci\n5,Parfait je recommande vivement ce produit\n", NOW);
    expect(rankReviews(csv.reviews, { minStars: 5 }).map((r) => r.stars)).toEqual([5]);
    const jm = readJudgeMePage({ reviews: [{ id: 1, rating: 4.5, body: "Très bon produit reçu rapidement merci", published: true }] }, NOW);
    expect(jm.reviews[0].stars).toBe(4);
    expect(jm.rated[0].stars).toBe(4.5); // the average keeps the raw rating
  });
});

describe("4 · changing the Shopify domain forgets the Judge.me token", () => {
  it("the domainChanged reset clears judgemeApiToken", () => {
    const src = readFileSync(new URL("../src/app/dashboard/actions.ts", import.meta.url), "utf8");
    const start = src.indexOf("export async function startShopifyInstallAction");
    const body = src.slice(start, src.indexOf("export async function", start + 10));
    const from = body.indexOf("...(domainChanged");
    const reset = body.slice(from, body.indexOf(": {}", from));
    expect(reset).toContain("shopifyAccessToken: null");
    expect(reset).toContain("judgemeApiToken: null");
  });
});

describe("5 · named HTML entities", () => {
  it("French / German accents, typographic quotes, dashes, currency", () => {
    expect(plainText("C&eacute;tait g&eacute;nial &rsquo;", 100)).toBe("Cétait génial ’");
    expect(plainText("&Eacute;t&eacute; &agrave; la mer, gar&ccedil;on, for&ecirc;t, h&ocirc;tel", 200)).toBe("Été à la mer, garçon, forêt, hôtel");
    expect(plainText("&laquo;&nbsp;Top&nbsp;&raquo; &ndash; 20&euro; &mdash; &hellip;", 100)).toBe("« Top » – 20€ — …");
    expect(plainText("&ldquo;S&uuml;&szlig;&rdquo; &lsquo;sch&ouml;n&rsquo; &auml; &egrave;", 100)).toBe("“Süß” ‘schön’ ä è");
    expect(plainText("&unknownentity; &amp;", 100)).toBe("&unknownentity; &");
  });
});

describe("6 · only real tags are stripped", () => {
  it("« <3 cm » and « > prix » stay, real tags go", () => {
    expect(plainText("Taille <3 cm mais qualité > prix", 100)).toBe("Taille <3 cm mais qualité > prix");
    expect(plainText("J'adore <3 et 2 < 5", 100)).toBe("J'adore <3 et 2 < 5");
    expect(plainText("<p>Super <b>produit</b></p>Merci<br/>!", 100)).toBe("Super produit\nMerci\n!");
    expect(plainText('<a href="x">lien</a><!-- note -->', 100)).toBe("lien");
  });
});

describe("7 · a re-import without « Afficher la note moyenne » clears the previous average", () => {
  const old = { score: 4.2, count: 10, source: "shopify" as const };
  const fresh = { score: 4.8, count: 50, source: "csv" as const };
  const picked = [rv({ name: "N", source: "csv", verified: true })];
  it("unticked → summary null; ticked → the new one", () => {
    expect(importPatch([], picked, fresh, false, isSampleReview).summary).toBeNull();
    expect(importPatch([], picked, fresh, true, isSampleReview).summary).toEqual(fresh);
    expect(importPatch([], picked, null, true, isSampleReview).summary).toBeNull();
    expect(importPatch([rv({ name: "M", source: "manual" })], [], fresh, true, isSampleReview)).toEqual({ summary: fresh });
    void old;
  });
});

describe("8 · Judge.me: a later page failing keeps the pages read (capped)", () => {
  const page = (n: number, from: number) => ({ reviews: Array.from({ length: n }, (_, i) => ({ id: from + i, rating: 5, body: `Avis numéro ${from + i} assez long pour compter`, published: true })) });
  const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
  beforeEach(() => mocks.fetch.mockReset());
  it("HTTP 500 on page 2", async () => {
    const { importJudgeMeAction } = await import("@/lib/reviews-actions");
    mocks.fetch.mockResolvedValueOnce(ok(page(100, 0))).mockResolvedValueOnce(new Response("err", { status: 500 }));
    const res = await importJudgeMeAction("s1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.capped).toBe(true);
      expect(res.data.rated).toBe(100);
    }
  });
  it("unreadable JSON on page 2", async () => {
    const { importJudgeMeAction } = await import("@/lib/reviews-actions");
    mocks.fetch.mockResolvedValueOnce(ok(page(100, 0))).mockResolvedValueOnce(new Response("<html>", { status: 200 }));
    const res = await importJudgeMeAction("s1");
    expect(res.ok && res.data.capped && res.data.rated === 100).toBe(true);
  });
  it("page 1 failing is still an error", async () => {
    const { importJudgeMeAction } = await import("@/lib/reviews-actions");
    mocks.fetch.mockResolvedValueOnce(new Response("err", { status: 500 }));
    const res = await importJudgeMeAction("s1");
    expect(res.ok).toBe(false);
  });
});

describe("9 · accessibility and wording", () => {
  const ctx = (lang: Lang): ContentContext => ({
    labels: labelsFor(lang),
    lang,
    lowestInventory: null,
    preview: false,
    subtotalCents: 0,
    freeShippingThresholdCents: null,
    money: (c) => String(c),
    note: "",
    setNote: () => {},
    cartProducts: null,
  });
  it("review card stars: a localized name", () => {
    const out = (lang: Lang) => renderToStaticMarkup(createElement(ContentBlock, { block: reviewsBlock([rv({ name: "Léa", stars: 4 })]), ctx: ctx(lang) }));
    expect(out("fr")).toContain('role="img" aria-label="4 étoiles sur 5"');
    expect(out("en")).toContain('aria-label="4 stars out of 5"');
    expect(out("de")).toContain('aria-label="4 von 5 Sternen"');
    expect(out("en")).not.toContain('aria-label="4/5"');
    expect(labelsFor("fr").starsOutOf5("1", 1)).toBe("1 étoile sur 5");
    expect(labelsFor("en").starsOutOf5("1", 1)).toBe("1 star out of 5");
  });
  it("rating block: the stars are hidden next to the visible « 4,8/5 » (read once)", () => {
    const b = createBlock("rating") as BlockOf<"rating">;
    const out = renderToStaticMarkup(createElement(ContentBlock, { block: { ...b, props: { ...b.props, score: 4.8 } } as Block, ctx: ctx("fr") }));
    expect(out).not.toMatch(/role="img"/);
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain("4,8");
  });
  it("Stars without a label are decoration", () => {
    expect(renderToStaticMarkup(createElement(Stars, { n: 3 }))).toMatch(/^<span[^>]*aria-hidden="true"/);
  });
  it("builder preview stars are an image with a name", () => {
    const src = readFileSync(new URL("../src/components/builder/ReviewsImport.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/<span role="img" aria-label=\{`\$\{r\.stars\} étoile/);
  });
  it("Shopify « N produits » counts only the products whose metafields were used", async () => {
    const rows = [
      { rating: JSON.stringify({ value: "4.6", scale_min: "1.0", scale_max: "5.0" }), count: "10" },
      { rating: JSON.stringify({ value: "12", scale_min: "0", scale_max: "10" }), count: "5" }, // out of scale
      { rating: "abc", count: "3" },
      { rating: JSON.stringify({ value: "4" }), count: "0" },
      { rating: null, count: null },
    ];
    expect(shopifyRatedProducts(rows)).toBe(1);
    expect(shopifyRatingSummary(rows, NOW)?.count).toBe(10);
    const { shopifyReviewRatingAction } = await import("@/lib/reviews-actions");
    mocks.graphql.mockResolvedValueOnce({
      products: {
        nodes: rows.map((r) => ({ rating: r.rating ? { value: r.rating } : null, ratingCount: r.count ? { value: r.count } : null })),
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const res = await shopifyReviewRatingAction("s1");
    expect(res.ok && res.data.products).toBe(1);
  });
});

describe("10 · date aliases and Judge.me « not-yet »", () => {
  it("Yotpo « Review Creation Date » and other headers", () => {
    for (const header of ["Review Creation Date", "Creation Date", "Submission Date", "Date Posted", "Date de l'avis", "published_date"]) {
      const r = parseReviewsCsv(`rating,body,${header}\n5,Très bon produit reçu vite merci,2025-03-04\n`, NOW);
      expect(r.reviews[0]?.date, header).toBe("2025-03-04");
    }
  });
  it("curated « not-yet »: skipped unless a published column says it is public", () => {
    expect(parseReviewsCsv("rating,body,curated\n5,Très bon produit reçu vite,not-yet\n", NOW).reviews).toHaveLength(0);
    expect(parseReviewsCsv("rating,body,curated\n5,Très bon produit reçu vite,not-yet\n", NOW).skipped).toBe(1);
    expect(parseReviewsCsv("rating,body,curated,published\n5,Très bon produit reçu vite,not-yet,true\n", NOW).reviews).toHaveLength(1);
    expect(parseReviewsCsv("rating,body,curated,published\n5,Très bon produit reçu vite,not_yet,false\n", NOW).reviews).toHaveLength(0);
    expect(parseReviewsCsv("rating,body,curated\n5,Très bon produit reçu vite,ok\n", NOW).reviews).toHaveLength(1);
    // A status column and a curated column: spam in curated is still hidden.
    expect(parseReviewsCsv("rating,body,status,curated\n5,Très bon produit reçu vite,published,spam\n", NOW).reviews).toHaveLength(0);
    // "not yet" in another app's status column is not guessed.
    expect(parseReviewsCsv("rating,body,status\n5,Très bon produit reçu vite,not-yet\n", NOW).reviews).toHaveLength(1);
  });
  it("Judge.me API: not-yet only when published", () => {
    const body = "Très bon produit reçu vite merci";
    expect(readJudgeMePage({ reviews: [{ id: 1, rating: 5, body, curated: "not-yet" }] }, NOW).reviews).toHaveLength(0);
    expect(readJudgeMePage({ reviews: [{ id: 1, rating: 5, body, curated: "not-yet", published: true }] }, NOW).reviews).toHaveLength(1);
  });
});

describe("11 · CSV parsed off the main thread", () => {
  const bytes = new TextEncoder().encode("rating,body\n5,Très bien merci beaucoup vraiment\n");
  it("parseReviewsBytes decodes and parses", () => {
    expect(parseReviewsBytes(bytes, NOW).reviews[0].text).toBe("Très bien merci beaucoup vraiment");
  });
  it("the worker answers { ok, result }", async () => {
    const posted: unknown[] = [];
    const scope = { onmessage: null as null | ((e: { data: ArrayBuffer }) => void), postMessage: (m: unknown) => posted.push(m) };
    vi.stubGlobal("self", scope);
    await import("@/lib/reviews-csv.worker");
    scope.onmessage!({ data: bytes.buffer });
    vi.unstubAllGlobals();
    expect(posted[0]).toMatchObject({ ok: true, result: { reviews: [{ text: "Très bien merci beaucoup vraiment" }] } });
  });
  it("without Worker support, the file is parsed on the main thread", async () => {
    const { parseReviewsFile } = await import("@/lib/reviews-csv-client");
    const res = await parseReviewsFile(new Blob([bytes]));
    expect(res.reviews).toHaveLength(1);
  });
});
