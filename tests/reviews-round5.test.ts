// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Block, BlockOf, ReviewItem, ReviewSummary } from "@/lib/layout";

/*
 * Reviews import, round 5: the buyer-facing line says it is a selection (and what the average
 * covers), every pre-selected review is listed, a late Shopify note is dropped after unmount and
 * lands on its own block, plain-decimal / proportional Shopify ratings, short anonymous reviews
 * never merged, the import notice counting what was really added, and why a Judge.me import
 * is partial (limit / error; exactly 1 000 is complete).
 */

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
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(async () => ({ id: "admin" })) }));
vi.mock("@/lib/db", () => ({ db: { store: { findUnique: vi.fn(async () => mocks.store), update: vi.fn(async () => ({})), updateMany: vi.fn(async () => ({})) } } }));
vi.mock("@/lib/crypto", () => ({ decrypt: () => "saved-token-123", encrypt: (s: string) => `enc:${s}` }));
vi.mock("@/lib/ext", () => ({ extFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock("@/lib/shopify", () => ({ shopifyGraphql: (...args: unknown[]) => mocks.graphql(...args) }));
vi.mock("@/lib/catalog", () => ({ searchCatalog: vi.fn(async () => []), getCatalogVariant: vi.fn(async () => null) }));

const { createBlock } = await import("@/lib/layout");
const { dedupKey, parseReviewsCsv, shopifyRatingSummary } = await import("@/lib/reviews-import");
const { importJudgeMeAction } = await import("@/lib/reviews-actions");
const { ReviewsImport, importNotice } = await import("@/components/builder/ReviewsImport");
const { ContentBlock } = await import("@/components/checkout/blocks");
const { labelsFor } = await import("@/components/checkout/i18n");

const NOW = Date.UTC(2026, 8, 28);
const LANGS = ["fr", "en", "de", "es", "it", "nl"] as const;

afterEach(() => cleanup());

const rv = (over: Partial<ReviewItem>): ReviewItem => ({ name: "A", text: "Un avis assez long pour compter vraiment.", stars: 5, verified: false, ...over });
function reviewsBlock(over: Partial<BlockOf<"reviews">["props"]> = {}, id?: string): BlockOf<"reviews"> {
  const b = createBlock("reviews") as BlockOf<"reviews">;
  return { ...b, ...(id ? { id } : {}), props: { ...b.props, items: [], summary: null, ...over } };
}
const ok = (json: unknown) => new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
const jmReview = (i: number, over: Record<string, unknown> = {}) => ({
  id: i,
  rating: 5,
  body: `Avis numéro ${i} assez long pour compter vraiment`,
  reviewer: { name: `Client ${i}` },
  created_at: `2026-0${1 + (i % 8)}-1${i % 10}T10:00:00Z`,
  product_handle: "produit-a",
  published: true,
  ...over,
});
const pageOf = (url: unknown) => Number(new URL(String(url)).searchParams.get("page"));

/* ------------------------------------------------------------------ */
describe("1 · buyer-facing line: a selection; hand-typed ones never called imported; what the average covers", () => {
  const ctx = (lang: (typeof LANGS)[number]) =>
    ({
      labels: labelsFor(lang),
      lang,
      lowestInventory: null,
      preview: false,
      subtotalCents: 0,
      freeShippingThresholdCents: null,
      money: (c: number) => String(c),
      note: "",
      setNote: () => {},
      cartProducts: null,
    }) as never;
  const out = (items: ReviewItem[], summary: ReviewSummary | null = null, lang: (typeof LANGS)[number] = "fr") =>
    renderToStaticMarkup(h(ContentBlock, { block: reviewsBlock({ layout: "stack", items, summary }) as Block, ctx: ctx(lang) }));
  const summary: ReviewSummary = { score: 4.6, count: 120, source: "judgeme" };

  it("imported only: « Sélection d'avis importés de … »", () => {
    const html = out([rv({ source: "judgeme" })]);
    expect(html).toContain("Sélection d&#x27;avis importés de Judge.me ; « Achat vérifié » indique un achat confirmé par l&#x27;application.");
    expect(html).not.toContain("La note moyenne porte");
  });
  it("hand-typed reviews mixed in: « dont certains importés »", () => {
    const html = out([rv({ source: "csv" }), rv({ source: "manual", name: "Moi", text: "Avis saisi à la main par le marchand." })]);
    expect(html).toContain("Sélection d&#x27;avis, dont certains importés de l&#x27;application d&#x27;avis de la boutique");
    // Untagged (older) hand-typed reviews count as hand-typed too.
    expect(out([rv({ source: "judgeme" }), rv({ name: "B", text: "Autre avis saisi à la main, sans source." })])).toContain("dont certains importés de Judge.me");
  });
  it("with an average shown: says it covers all published reviews", () => {
    expect(out([rv({ source: "judgeme" })], summary)).toContain(" La note moyenne porte sur tous les avis publiés.");
  });
  it("6 languages: mixed and average wordings differ from the plain one", () => {
    for (const lang of LANGS) {
      const L = labelsFor(lang);
      const plain = L.importedReviewsNote("Judge.me");
      expect(plain).toContain("Judge.me");
      expect(L.importedReviewsNote("Judge.me", { mixed: true })).not.toBe(plain);
      expect(L.importedReviewsNote("Judge.me", { mixed: true })).toContain("Judge.me");
      expect(L.importedReviewsNote("Judge.me", { summary: true }).startsWith(plain)).toBe(true);
      expect(L.importedReviewsNote("Judge.me", { summary: true }).length).toBeGreaterThan(plain.length + 10);
      expect(L.importedReviewsNote(null, { mixed: true, summary: true })).not.toContain("null");
      expect(out([rv({ source: "judgeme" })], summary, lang)).toContain("data-imported-reviews-note");
    }
    expect(labelsFor("en").importedReviewsNote("Judge.me", { mixed: true })).toContain("A selection of reviews, some imported from Judge.me");
  });
});

/* ------------------------------------------------------------------ */
async function openJudgeMe(block: BlockOf<"reviews">, reviews: unknown[], extra: Record<string, unknown> = {}) {
  mocks.fetch.mockReset();
  mocks.fetch.mockImplementation(async (_s: unknown, _k: unknown, url: unknown) => {
    const p = pageOf(url);
    return ok({ reviews: p === 1 ? reviews : [] });
  });
  const onChange = vi.fn();
  const view = render(h(ReviewsImport, { block, storeId: "s1", onChange, ...extra }));
  await act(async () => {});
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Importer depuis Judge.me/ }));
  });
  return { onChange, view };
}
const listBoxes = (c: HTMLElement) => [...c.querySelectorAll("ul input[type=checkbox]")] as HTMLInputElement[];

describe("2 · every pre-selected review is listed (even past the first 150), so it can be unticked", () => {
  it("a review ranked 161st but pre-selected (other product) is listed, ticked, and can be unticked", async () => {
    // 160 five-star reviews of product A, one four-star review of product B: B is ranked last but
    // pre-selected (the products are taken in turn).
    const reviews = [...Array.from({ length: 160 }, (_, i) => jmReview(i)), jmReview(999, { rating: 4, product_handle: "produit-b", body: "Le seul avis du produit B, assez long." })];
    const { view } = await openJudgeMe(reviewsBlock(), reviews);
    const boxes = listBoxes(view.container);
    expect(boxes).toHaveLength(151);
    const b = boxes.find((x) => x.closest("label")!.textContent!.includes("Le seul avis du produit B"))!;
    expect(b).toBeTruthy();
    expect(b.checked).toBe(true);
    expect(screen.getByText(/sélectionnés/).textContent).toContain("20/20");
    await act(async () => {
      fireEvent.click(b);
    });
    expect(b.checked).toBe(false);
    // Still listed (can be ticked back), counter follows.
    expect(listBoxes(view.container)).toHaveLength(151);
    expect(screen.getByText(/sélectionnés/).textContent).toContain("19/20");
  });
});

/* ------------------------------------------------------------------ */
describe("3 · a late Shopify note: dropped after unmount, applied to its own block by id", () => {
  const summary: ReviewSummary = { score: 4.6, count: 12, source: "shopify" };
  const page = (rating: string) => ({ products: { nodes: [{ rating: { value: rating }, ratingCount: { value: "12" } }], pageInfo: { hasNextPage: false, endCursor: null } } });
  beforeEach(() => {
    mocks.graphql.mockReset();
    mocks.fetch.mockReset();
  });
  it("unmounted before the answer: never through onChange, applied by id (round 6)", async () => {
    let resolve!: (v: unknown) => void;
    mocks.graphql.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const onChange = vi.fn();
    const updateBlockProps = vi.fn();
    const view = render(h(ReviewsImport, { block: reviewsBlock(), storeId: "s1", onChange, updateBlockProps }));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Récupérer ma note depuis Shopify/ }));
    });
    view.unmount();
    await act(async () => {
      resolve(page(JSON.stringify({ value: "4.6", scale_min: "1.0", scale_max: "5.0" })));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(updateBlockProps).toHaveBeenCalledTimes(1);
  });
  it("the editor switched to another block meanwhile: the note lands on the block it was asked for", async () => {
    let resolve!: (v: unknown) => void;
    mocks.graphql.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const onChange = vi.fn();
    const updateBlockProps = vi.fn();
    const view = render(h(ReviewsImport, { block: reviewsBlock({}, "blk-1"), storeId: "s1", onChange, updateBlockProps }));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Récupérer ma note depuis Shopify/ }));
    });
    view.rerender(h(ReviewsImport, { block: reviewsBlock({}, "blk-2"), storeId: "s1", onChange, updateBlockProps }));
    await act(async () => {
      resolve(page(JSON.stringify({ value: "4.6", scale_min: "1.0", scale_max: "5.0" })));
    });
    expect(onChange).not.toHaveBeenCalled();
    expect(updateBlockProps).toHaveBeenCalledTimes(1);
    expect(updateBlockProps.mock.calls[0][0]).toBe("blk-1");
    expect((updateBlockProps.mock.calls[0][1] as { summary: ReviewSummary }).summary).toMatchObject({ score: summary.score, count: summary.count, source: "shopify" });
  });
  it("BlockContentEditor → context.updateBlock: a functional update by id", async () => {
    const { BlockContentEditor } = await import("@/components/builder/BlockEditor");
    let resolve!: (v: unknown) => void;
    mocks.graphql.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const block = reviewsBlock({ title: "Avis" }, "blk-9") as Block;
    const updateBlock = vi.fn();
    render(h(BlockContentEditor, { block, context: { blocks: [block], storeId: "s1", updateBlock }, onChange: () => {} }));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Récupérer ma note depuis Shopify/ }));
    });
    await act(async () => {
      resolve(page(JSON.stringify({ value: "4.6", scale_min: "1.0", scale_max: "5.0" })));
    });
    expect(updateBlock).toHaveBeenCalledTimes(1);
    const [id, fn] = updateBlock.mock.calls[0] as [string, (b: Block) => Block];
    expect(id).toBe("blk-9");
    // Applied to the block as it is in the layout then (a title changed meanwhile is kept).
    const current = { ...block, props: { ...(block as BlockOf<"reviews">).props, title: "Nos clients" } } as Block;
    const next = fn(current) as BlockOf<"reviews">;
    expect(next.props.title).toBe("Nos clients");
    expect(next.props.summary?.score).toBe(4.6);
  });
});

/* ------------------------------------------------------------------ */
describe("4 / 5 · Shopify ratings: plain decimal metafield, proportional rescale", () => {
  it("a plain decimal metafield (JSON.parse gives a number) is read on the 1–5 scale", () => {
    expect(shopifyRatingSummary([{ rating: "4.6", count: "10" }], NOW)?.score).toBe(4.6);
    expect(shopifyRatingSummary([{ rating: '"4.2"', count: "10" }], NOW)?.score).toBe(4.2);
    expect(shopifyRatingSummary([{ rating: "7", count: "10" }], NOW)).toBeNull(); // out of 1–5
  });
  it("other scales: proportional (8/10 → 4), never lifted to 1 star", () => {
    expect(shopifyRatingSummary([{ rating: JSON.stringify({ value: "8", scale_min: "0", scale_max: "10" }), count: "2" }], NOW)?.score).toBe(4);
    expect(shopifyRatingSummary([{ rating: JSON.stringify({ value: "90", scale_max: "100" }), count: "2" }], NOW)?.score).toBe(4.5);
    // 10/100 → 0.5 star: left out, not shown as 1 star.
    expect(shopifyRatingSummary([{ rating: JSON.stringify({ value: "10", scale_min: "0", scale_max: "100" }), count: "2" }], NOW)).toBeNull();
    // 1–5 unchanged.
    expect(shopifyRatingSummary([{ rating: JSON.stringify({ value: "4.4", scale_min: "1.0", scale_max: "5.0" }), count: "2" }], NOW)?.score).toBe(4.4);
  });
});

/* ------------------------------------------------------------------ */
describe("6 · the notice counts what was really added; the selection follows the room left", () => {
  const picked = Array.from({ length: 5 }, (_, i) => rv({ name: `I${i}`, text: `Avis importé numéro ${i} assez long`, source: "csv" }));
  it("importNotice: counted from the merge result", () => {
    const merged = { items: [...picked.slice(0, 2), rv({ name: "Own", source: "manual" })], summary: null };
    expect(importNotice(picked, merged, false)).toBe("2 avis ajoutés au bloc. 3 non ajoutés faute de place.");
    expect(importNotice(picked, { items: picked, summary: null }, true)).toBe("5 avis ajoutés au bloc. L'ancienne note moyenne a été retirée.");
    expect(importNotice(picked, { items: [rv({ name: "Own", source: "manual" })], summary: null }, false)).toMatch(/^Aucun avis ajouté/);
    expect(importNotice([], { summary: { score: 4.5, count: 3, source: "csv" } }, false)).toBe("Note moyenne ajoutée au bloc.");
  });
  it("hand-typed reviews added while the preview is open: picked cut to the room left", async () => {
    const reviews = Array.from({ length: 30 }, (_, i) => jmReview(i, { product_handle: `p-${i}` }));
    const { view, onChange } = await openJudgeMe(reviewsBlock(), reviews);
    expect(screen.getByText(/sélectionnés/).textContent).toContain("20/20");
    const own = Array.from({ length: 17 }, (_, i) => rv({ name: `Own ${i}`, text: `Avis saisi à la main numéro ${i}.`, source: "manual" }));
    view.rerender(h(ReviewsImport, { block: reviewsBlock({ items: own }), storeId: "s1", onChange }));
    expect(screen.getByText(/sélectionnés/).textContent).toContain("3/3");
    expect(listBoxes(view.container).filter((b) => b.checked)).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ajouter 3 avis au bloc" }));
    });
    const patch = onChange.mock.calls.at(-1)![0] as { items: ReviewItem[] };
    expect(patch.items).toHaveLength(20);
    expect(patch.items.filter((r) => r.source === "judgeme")).toHaveLength(3);
    expect(screen.getByText(/avis ajoutés au bloc/).textContent).toBe("3 avis ajoutés au bloc.");
  });
});

/* ------------------------------------------------------------------ */
describe("7 · short, anonymous, undated reviews are never merged", () => {
  it("dedupKey", () => {
    expect(dedupKey(null, "", 5, "Super !", undefined)).toBeNull();
    expect(dedupKey(null, "|", 5, "Parfait", undefined)).toBeNull(); // Judge.me's "name|email" with both empty is "|"
    expect(dedupKey(null, "Marie", 5, "Super !", undefined)).not.toBeNull();
    expect(dedupKey(null, "", 5, "Super !", "2026-01-02")).not.toBeNull();
    expect(dedupKey(null, "", 5, "Un avis bien plus long que vingt caractères", undefined)).not.toBeNull();
    expect(dedupKey(7, "", 5, "Super !", undefined)).toBe("id:7");
  });
  it("CSV: two « Parfait » rows without reviewer or date both count", () => {
    const r = parseReviewsCsv("rating,body\n5,Parfait\n5,Parfait\n", NOW);
    expect(r.skipped).toBe(0);
    expect(r.summary?.count).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
describe("8 · why a Judge.me import is partial; exactly 1 000 is complete", () => {
  const full = (p: number) => ({ reviews: Array.from({ length: 100 }, (_, i) => jmReview(p * 1000 + i)) });
  // Braces: a function returned by beforeEach is run as its teardown.
  beforeEach(() => {
    mocks.fetch.mockReset();
  });
  it("exactly 1 000 reviews (nothing past the 10th page): not partial", async () => {
    mocks.fetch.mockImplementation(async (_s: unknown, _k: unknown, url: unknown) => {
      const p = pageOf(url);
      return ok(p <= 10 ? full(p) : { reviews: [] });
    });
    const res = await importJudgeMeAction("s1");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.rated).toBe(1000);
      expect(res.data.capped).toBe(false);
      expect(res.data.reason).toBeUndefined();
    }
    expect(mocks.fetch).toHaveBeenCalledTimes(11);
  });
  it("more than 1 000: partial, reason « limit » (the probe page is never kept)", async () => {
    mocks.fetch.mockImplementation(async (_s: unknown, _k: unknown, url: unknown) => ok(full(pageOf(url))));
    const res = await importJudgeMeAction("s1");
    expect(res.ok && res.data.capped && res.data.reason === "limit" && res.data.rated === 1000).toBe(true);
  });
  it("a later page failing: partial, reason « error »", async () => {
    mocks.fetch.mockResolvedValueOnce(ok(full(1))).mockResolvedValueOnce(new Response("err", { status: 500 }));
    const res = await importJudgeMeAction("s1");
    expect(res.ok && res.data.capped && res.data.reason === "error" && res.data.rated === 100).toBe(true);
  });
  it("the builder words the partial note by reason", async () => {
    mocks.fetch.mockResolvedValueOnce(ok(full(1))).mockResolvedValueOnce(new Response("err", { status: 500 }));
    render(h(ReviewsImport, { block: reviewsBlock(), storeId: "s1", onChange: () => {} }));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Importer depuis Judge.me/ }));
    });
    expect(screen.getByText(/Import partiel/).textContent).toContain("Judge.me a cessé de répondre");
    expect(screen.getByText(/Import partiel/).textContent).not.toContain("limite de 1 000");
  });
  it("the stored summary is marked partial for limit / error, never for a complete import", async () => {
    mocks.fetch.mockImplementation(async (_s: unknown, _k: unknown, url: unknown) => ok(full(pageOf(url))));
    const limit = await importJudgeMeAction("s1");
    expect(limit.ok && limit.data.summary?.partial).toBe(true);
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValueOnce(ok(full(1))).mockResolvedValueOnce(new Response("err", { status: 500 }));
    const error = await importJudgeMeAction("s1");
    expect(error.ok && error.data.summary?.partial).toBe(true);
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValueOnce(ok({ reviews: [jmReview(1), jmReview(2)] }));
    const complete = await importJudgeMeAction("s1");
    expect(complete.ok && complete.data.summary).toBeTruthy();
    expect(complete.ok && complete.data.summary?.partial).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
describe("9 · what the average covers: all published / the N most recent (partial) / the imported file (CSV)", () => {
  const ctx = (lang: (typeof LANGS)[number]) =>
    ({ labels: labelsFor(lang), lang, lowestInventory: null, preview: false, subtotalCents: 0, freeShippingThresholdCents: null, money: String, note: "", setNote: () => {}, cartProducts: null }) as never;
  const note = (summary: ReviewSummary, lang: (typeof LANGS)[number] = "fr", source: ReviewItem["source"] = "judgeme") =>
    renderToStaticMarkup(h(ContentBlock, { block: reviewsBlock({ layout: "stack", items: [rv({ source })], summary }) as Block, ctx: ctx(lang) }));
  const WORDING = {
    fr: ["La note moyenne porte sur tous les avis publiés.", "La note moyenne porte sur les 1 000 avis les plus récents.", "La note moyenne porte sur tous les avis du fichier importé."],
    en: ["The average rating covers all published reviews.", "The average rating covers the 1,000 most recent reviews.", "The average rating covers all reviews in the imported file."],
    de: ["Die Durchschnittsbewertung bezieht sich auf alle veröffentlichten Bewertungen.", "Die Durchschnittsbewertung bezieht sich auf die 1.000 neuesten Bewertungen.", "Die Durchschnittsbewertung bezieht sich auf alle Bewertungen der importierten Datei."],
    es: ["La valoración media se basa en todas las opiniones publicadas.", "La valoración media se basa en las 1000 opiniones más recientes.", "La valoración media se basa en todas las opiniones del archivo importado."],
    it: ["La valutazione media si basa su tutte le recensioni pubblicate.", "La valutazione media si basa sulle 1000 recensioni più recenti.", "La valutazione media si basa su tutte le recensioni del file importato."],
    nl: ["De gemiddelde score is gebaseerd op alle gepubliceerde reviews.", "De gemiddelde score is gebaseerd op de 1.000 meest recente reviews.", "De gemiddelde score is gebaseerd op alle reviews uit het geïmporteerde bestand."],
  } as const;
  // Locale grouping separators vary (narrow no-break space in fr, none in es/it for 4 digits): compare on normalised text.
  const norm = (s: string) => s.replace(/&#x27;/g, "'").replace(/[  ]/g, " ");
  it("labels: the three wordings in all 6 languages; `true` keeps the old sentence", () => {
    for (const lang of LANGS) {
      const L = labelsFor(lang);
      const [all, recent, file] = WORDING[lang];
      const n = (1000).toLocaleString(lang === "fr" ? "fr-FR" : lang);
      expect(L.importedReviewsNote("Judge.me", { summary: true })).toContain(all);
      expect(norm(L.importedReviewsNote("Judge.me", { summary: { recent: n } }))).toContain(norm(recent));
      expect(L.importedReviewsNote(null, { summary: "file" })).toContain(file);
      expect(L.importedReviewsNote("Judge.me", { summary: false })).not.toContain(all);
    }
  });
  it("rendered: full Judge.me → all published (Shopify: the store's, round 6); partial → N most recent; CSV → imported file", () => {
    for (const lang of LANGS) {
      const [all, recent, file] = WORDING[lang];
      expect(norm(note({ score: 4.6, count: 1000, source: "judgeme" }, lang))).toContain(norm(all));
      expect(norm(note({ score: 4.6, count: 1000, source: "shopify" }, lang, "csv"))).toContain(norm(labelsFor(lang).averageScope("store")));
      const partial = norm(note({ score: 4.6, count: 1000, source: "judgeme", partial: true }, lang));
      expect(partial).toContain(norm(recent));
      expect(partial).not.toContain(norm(all));
      expect(norm(note({ score: 4.6, count: 1000, source: "csv" }, lang, "csv"))).toContain(norm(file));
    }
  });
  it("schema: `partial` is optional (older summaries parse unchanged), junk dropped", async () => {
    const { reviewSummarySchema } = await import("@/lib/layout");
    const old = { score: 4.5, count: 10, source: "judgeme", asOf: "2026-09-01" };
    expect(reviewSummarySchema.parse(old)).toEqual(old);
    expect(reviewSummarySchema.parse({ ...old, partial: true }).partial).toBe(true);
    expect(reviewSummarySchema.parse({ ...old, partial: "yes" }).partial).toBeUndefined();
    const b = createBlock("reviews") as BlockOf<"reviews">;
    expect(b.props.summary ?? null).toBeNull();
  });
  it("builder: « (partielle) » next to a stored partial average only", () => {
    const s: ReviewSummary = { score: 4.6, count: 1000, source: "judgeme", partial: true };
    const { container, rerender } = render(h(ReviewsImport, { block: reviewsBlock({ summary: s }), storeId: "s1", onChange: () => {} }));
    expect(container.querySelector("[data-summary-partial]")?.textContent).toContain("(partielle)");
    rerender(h(ReviewsImport, { block: reviewsBlock({ summary: { ...s, partial: undefined } }), storeId: "s1", onChange: () => {} }));
    expect(container.querySelector("[data-summary-partial]")).toBeNull();
  });
});
