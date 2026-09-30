// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Block, BlockOf, ReviewItem, ReviewSummary } from "@/lib/layout";

/*
 * Reviews import, round 6: a capped / throttled Shopify rating read is kept and marked partial
 * (50 products per call), what the average covers is told by source (builder and buyer, also
 * above hand-typed reviews only), a dead Judge.me token opens the token field (and is deleted
 * on 401), and a late Shopify note is applied by block id after the editor closed.
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  graphql: vi.fn(),
  updateMany: vi.fn(async () => ({})),
  decryptFails: false,
  store: {
    id: "s1",
    shopDomain: "shop.myshopify.com",
    shopifyAccessToken: "x",
    shopifyConnectedAt: new Date(),
    judgemeApiToken: "enc",
  } as Record<string, unknown>,
}));
vi.mock("@/lib/auth", () => ({ requireAdmin: vi.fn(async () => "admin"), currentUser: vi.fn(async () => (await import("./session-stub")).ownerUser()) }));
vi.mock("@/lib/db", () => ({ db: { store: { findUnique: vi.fn(async () => mocks.store), update: vi.fn(async () => ({})), updateMany: mocks.updateMany } } }));
vi.mock("@/lib/crypto", () => ({
  decrypt: () => {
    if (mocks.decryptFails) throw new Error("bad key");
    return "saved-token-123";
  },
  encrypt: (s: string) => `enc:${s}`,
}));
vi.mock("@/lib/ext", () => ({ extFetch: (...args: unknown[]) => mocks.fetch(...args) }));
vi.mock("@/lib/shopify", () => ({ shopifyGraphql: (...args: unknown[]) => mocks.graphql(...args) }));
vi.mock("@/lib/catalog", () => ({ searchCatalog: vi.fn(async () => []), getCatalogVariant: vi.fn(async () => null) }));

const { createBlock } = await import("@/lib/layout");
const { summaryScope } = await import("@/lib/reviews-import");
const { importJudgeMeAction, shopifyReviewRatingAction } = await import("@/lib/reviews-actions");
const { ReviewsImport } = await import("@/components/builder/ReviewsImport");
const { ContentBlock } = await import("@/components/checkout/blocks");
const { labelsFor } = await import("@/components/checkout/i18n");

const LANGS = ["fr", "en", "de", "es", "it", "nl"] as const;

afterEach(() => cleanup());
beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.graphql.mockReset();
  mocks.updateMany.mockClear();
  mocks.decryptFails = false;
});

const rv = (over: Partial<ReviewItem>): ReviewItem => ({ name: "A", text: "Un avis assez long pour compter vraiment.", stars: 5, verified: false, ...over });
function reviewsBlock(over: Partial<BlockOf<"reviews">["props"]> = {}, id?: string): BlockOf<"reviews"> {
  const b = createBlock("reviews") as BlockOf<"reviews">;
  return { ...b, ...(id ? { id } : {}), props: { ...b.props, items: [], summary: null, ...over } };
}
const rating = (v: string) => ({ value: JSON.stringify({ value: v, scale_min: "1.0", scale_max: "5.0" }) });
const shopPage = (next: boolean, n = 1) => ({
  products: {
    nodes: Array.from({ length: n }, () => ({ rating: rating("4.5"), ratingCount: { value: "10" } })),
    pageInfo: { hasNextPage: next, endCursor: next ? "c" : null },
  },
});
const ctx = (lang: (typeof LANGS)[number]) =>
  ({ labels: labelsFor(lang), lang, lowestInventory: null, preview: false, subtotalCents: 0, freeShippingThresholdCents: null, money: String, note: "", setNote: () => {}, cartProducts: null }) as never;
const out = (items: ReviewItem[], summary: ReviewSummary | null, lang: (typeof LANGS)[number] = "fr") =>
  renderToStaticMarkup(h(ContentBlock, { block: reviewsBlock({ layout: "stack", items, summary }) as Block, ctx: ctx(lang) }));
const norm = (s: string) => s.replace(/&#x27;/g, "'");

/* ------------------------------------------------------------------ */
describe("1 · Shopify read capped at 2 000 products: summary partial + reason; buyer told « une partie »", () => {
  it("40 full pages of 50 with more left: partial, reason limit, 50 per call", async () => {
    mocks.graphql.mockImplementation(async () => shopPage(true, 50));
    const res = await shopifyReviewRatingAction("s1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(mocks.graphql).toHaveBeenCalledTimes(40);
    expect(String(mocks.graphql.mock.calls[0][1])).toContain("first: 50");
    expect(res.data.capped).toBe(true);
    expect(res.data.reason).toBe("limit");
    expect(res.data.products).toBe(2000);
    expect(res.data.summary?.partial).toBe(true);
  });
  it("all read: complete (no partial, no reason)", async () => {
    mocks.graphql.mockResolvedValueOnce(shopPage(true, 50)).mockResolvedValueOnce(shopPage(false, 3));
    const res = await shopifyReviewRatingAction("s1");
    expect(res.ok && res.data.capped).toBe(false);
    expect(res.ok && res.data.reason).toBeUndefined();
    expect(res.ok && res.data.summary?.partial).toBeUndefined();
  });
  it("buyer line: store-wide wording for Shopify, « une partie » when partial, 6 languages", () => {
    const full: ReviewSummary = { score: 4.5, count: 500, source: "shopify" };
    const part: ReviewSummary = { ...full, partial: true };
    expect(norm(out([rv({ source: "csv" })], full))).toContain("La note moyenne porte sur tous les avis publiés de la boutique.");
    expect(norm(out([rv({ source: "csv" })], part))).toContain("La note moyenne porte sur une partie des avis publiés de la boutique.");
    for (const lang of LANGS) {
      const L = labelsFor(lang);
      const variants = [L.averageScope(true), L.averageScope("store"), L.averageScope("store-partial"), L.averageScope("file"), L.averageScope({ recent: "1 000" })];
      expect(new Set(variants).size).toBe(5);
      expect(norm(out([rv({ source: "csv" })], part, lang))).toContain(norm(L.averageScope("store-partial")));
      expect(norm(out([rv({ source: "csv" })], full, lang))).toContain(norm(L.averageScope("store")));
      expect(L.importedReviewsNote(null, { summary: "store" }).endsWith(` ${L.averageScope("store")}`)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
describe("2 · Shopify throttled on a later page: rows read kept, capped (error)", () => {
  it("page 2 throws: the first page is used, partial with reason error", async () => {
    mocks.graphql.mockResolvedValueOnce(shopPage(true, 50)).mockRejectedValueOnce(new Error("Throttled"));
    const res = await shopifyReviewRatingAction("s1");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.products).toBe(50);
    expect(res.data.capped).toBe(true);
    expect(res.data.reason).toBe("error");
    expect(res.data.summary).toMatchObject({ score: 4.5, count: 500, source: "shopify", partial: true });
  });
  it("the first page throws: an error, nothing kept", async () => {
    mocks.graphql.mockRejectedValueOnce(new Error("Throttled"));
    const res = await shopifyReviewRatingAction("s1");
    expect(res.ok).toBe(false);
  });
  it("builder notice tells the read was cut short", async () => {
    mocks.graphql.mockResolvedValueOnce(shopPage(true, 50)).mockRejectedValueOnce(new Error("Throttled"));
    const updateBlockProps = vi.fn();
    render(h(ReviewsImport, { block: reviewsBlock({}, "b1"), storeId: "s1", onChange: vi.fn(), updateBlockProps }));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Récupérer ma note depuis Shopify/ }));
    });
    expect(updateBlockProps).toHaveBeenCalledTimes(1);
    expect((updateBlockProps.mock.calls[0][1] as { summary: ReviewSummary }).summary.partial).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Lecture partielle");
  });
});

/* ------------------------------------------------------------------ */
describe("3 · builder: what the average covers, by source", () => {
  it("summaryScope", () => {
    expect(summaryScope(40, false, "csv")).toBe("tous les avis du fichier");
    expect(summaryScope(40, false, "shopify")).toBe("tous les avis publiés de la boutique");
    expect(summaryScope(40, true, "shopify")).toBe("une partie des avis publiés de la boutique");
    expect(summaryScope(40, false, "judgeme")).toBe("tous vos avis publiés");
    expect(summaryScope(40, false)).toBe("tous vos avis publiés");
  });
  it("the stored average's line and the empty hint", async () => {
    const view = render(h(ReviewsImport, { block: reviewsBlock({ summary: { score: 4.5, count: 12, source: "csv" } }), storeId: null, onChange: vi.fn() }));
    expect(view.container.querySelector("[data-summary-scope]")?.textContent).toBe("(tous les avis du fichier)");
    view.rerender(h(ReviewsImport, { block: reviewsBlock({ summary: { score: 4.5, count: 12, source: "shopify", partial: true } }), storeId: null, onChange: vi.fn() }));
    expect(view.container.querySelector("[data-summary-scope]")?.textContent).toBe("(une partie des avis publiés de la boutique)");
    expect(view.container.querySelector("[data-summary-partial]")?.getAttribute("title")).toContain("Shopify");
    view.rerender(h(ReviewsImport, { block: reviewsBlock(), storeId: null, onChange: vi.fn() }));
    expect(view.container.textContent).toContain("tous les avis du fichier pour un CSV");
  });
});

/* ------------------------------------------------------------------ */
describe("4 · an average above hand-typed reviews only: what it covers, no app named", () => {
  it("manual reviews + summary: the scope sentence alone", () => {
    const html = norm(out([rv({ source: "manual" })], { score: 4.5, count: 30, source: "judgeme" }));
    expect(html).toContain("data-reviews-average-note");
    expect(html).toContain("La note moyenne porte sur tous les avis publiés.");
    expect(html).not.toContain("data-imported-reviews-note");
    expect(html).not.toContain("Achat vérifié » indique");
    expect(norm(out([rv({ source: "manual" })], { score: 4.5, count: 30, source: "csv" }))).toContain("La note moyenne porte sur tous les avis du fichier importé.");
  });
  it("no summary: no line; imported reviews: the single imported note (never both)", () => {
    expect(out([rv({ source: "manual" })], null)).not.toContain("data-reviews-average-note");
    const html = out([rv({ source: "judgeme" })], { score: 4.5, count: 30, source: "judgeme" });
    expect(html).toContain("data-imported-reviews-note");
    expect(html).not.toContain("data-reviews-average-note");
  });
  it("6 languages", () => {
    for (const lang of LANGS) {
      expect(norm(out([rv({ source: "manual" })], { score: 4.5, count: 30, source: "judgeme" }, lang))).toContain(norm(labelsFor(lang).averageScope(true)));
    }
  });
});

/* ------------------------------------------------------------------ */
describe("5 · dead Judge.me token: field reopened, deleted on 401", () => {
  const status = (s: number) => new Response("{}", { status: s, headers: { "content-type": "application/json" } });
  it("saved token unreadable: token unreadable, nothing deleted, Judge.me never called", async () => {
    mocks.decryptFails = true;
    const res = await importJudgeMeAction("s1");
    expect(res.ok).toBe(false);
    expect(!res.ok && res.token).toBe("unreadable");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it("saved token refused (401): deleted, merchant told", async () => {
    mocks.fetch.mockResolvedValueOnce(status(401));
    const res = await importJudgeMeAction("s1");
    expect(!res.ok && res.token).toBe("cleared");
    expect(!res.ok && res.error).toContain("supprimé");
    expect(mocks.updateMany).toHaveBeenCalledWith({ where: { id: "s1" }, data: { judgemeApiToken: null } });
  });
  it("saved token 403: kept (refused); a pasted one refused: the saved one kept, no flag", async () => {
    mocks.fetch.mockResolvedValueOnce(status(403));
    const r403 = await importJudgeMeAction("s1");
    expect(!r403.ok && r403.token).toBe("refused");
    mocks.fetch.mockResolvedValueOnce(status(401));
    const pasted = await importJudgeMeAction("s1", "pasted-token-456");
    expect(!pasted.ok && pasted.token).toBeUndefined();
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });
  it("builder: the token field opens and « Jeton enregistré » goes away on 401", async () => {
    mocks.fetch.mockResolvedValueOnce(status(401));
    render(h(ReviewsImport, { block: reviewsBlock(), storeId: "s1", onChange: vi.fn() }));
    await act(async () => {});
    expect(screen.getByText(/Jeton Judge.me enregistré/)).toBeTruthy();
    expect(screen.queryByLabelText("Jeton privé Judge.me")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Importer depuis Judge.me/ }));
    });
    expect(screen.getByLabelText("Jeton privé Judge.me")).toBeTruthy();
    expect(screen.queryByText(/Jeton Judge.me enregistré/)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("supprimé");
  });
  it("builder: unreadable token opens the field too", async () => {
    mocks.decryptFails = true;
    render(h(ReviewsImport, { block: reviewsBlock(), storeId: "s1", onChange: vi.fn() }));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Importer depuis Judge.me/ }));
    });
    expect(screen.getByLabelText("Jeton privé Judge.me")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("illisible");
  });
});

/* ------------------------------------------------------------------ */
describe("6 · a late Shopify note after unmount: applied by id, never through onChange", () => {
  async function lateNote(withUpdate: boolean) {
    let resolve!: (v: unknown) => void;
    mocks.graphql.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const onChange = vi.fn();
    const updateBlockProps = vi.fn();
    const view = render(h(ReviewsImport, { block: reviewsBlock({}, "blk-late"), storeId: "s1", onChange, ...(withUpdate ? { updateBlockProps } : {}) }));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Récupérer ma note depuis Shopify/ }));
    });
    view.unmount();
    await act(async () => {
      resolve(shopPage(false, 1));
    });
    return { onChange, updateBlockProps };
  }
  it("with updateBlockProps: patched by id", async () => {
    const { onChange, updateBlockProps } = await lateNote(true);
    expect(onChange).not.toHaveBeenCalled();
    expect(updateBlockProps).toHaveBeenCalledTimes(1);
    expect(updateBlockProps.mock.calls[0][0]).toBe("blk-late");
    expect((updateBlockProps.mock.calls[0][1] as { summary: ReviewSummary }).summary).toMatchObject({ score: 4.5, count: 10, source: "shopify" });
  });
  it("without it: dropped", async () => {
    const { onChange } = await lateNote(false);
    expect(onChange).not.toHaveBeenCalled();
  });
});
