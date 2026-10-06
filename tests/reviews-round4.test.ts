// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h, useEffect, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Block, BlockOf, ReviewItem, ReviewSummary } from "@/lib/layout";

/*
 * Reviews import, round 4: averages cut (never rounded up), duplicate keys on the raw reviewer
 * and rating, the Shopify note landing on the block as it is then (editor locked meanwhile),
 * recommendations' translations following their product, "(les N avis lus)" on a partial import,
 * "von 5 Sternen" / "de 5 estrellas" / "van 5 sterren", the CSV worker's failures, and the
 * buyer-facing line saying where imported reviews come from.
 */

const actions = vi.hoisted(() => ({
  shopify: vi.fn(),
  judgeme: vi.fn(),
  status: vi.fn(async () => ({ connected: true, shopConnected: true })),
}));
vi.mock("@/lib/reviews-actions", () => ({
  judgeMeStatusAction: actions.status,
  forgetJudgeMeAction: vi.fn(async () => ({ ok: true })),
  importJudgeMeAction: actions.judgeme,
  shopifyReviewRatingAction: actions.shopify,
}));
vi.mock("@/lib/catalog", () => ({ searchCatalog: vi.fn(async () => []), getCatalogVariant: vi.fn(async () => null) }));

const { createBlock } = await import("@/lib/layout");
const { floorScore, importedReviewsOrigin, parseReviewsCsv, ratingSummary, readJudgeMePage, shopifyRatingSummary, summaryScope } = await import("@/lib/reviews-import");
const { BlockContentEditor } = await import("@/components/builder/BlockEditor");
const { ContentBlock } = await import("@/components/checkout/blocks");
const { labelsFor } = await import("@/components/checkout/i18n");
const { CsvWorkerError, parseReviewsFile } = await import("@/lib/reviews-csv-client");

const NOW = Date.UTC(2026, 8, 28);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/* ------------------------------------------------------------------ */
describe("1 · stored averages are cut, never rounded up", () => {
  it("floorScore", () => {
    expect(floorScore(4.679)).toBe(4.67);
    expect(floorScore(4.995)).toBe(4.99);
    expect(floorScore(4.1)).toBe(4.1); // 4.1 * 100 = 409.99999999999994: float noise absorbed
    expect(floorScore(5)).toBe(5);
  });
  it("ratingSummary (CSV / Judge.me): 5,5,4 → 4.66, not 4.67", () => {
    expect(ratingSummary([{ stars: 5 }, { stars: 5 }, { stars: 4 }], "csv", NOW)?.score).toBe(4.66);
    // 4.995 average: never shown as 5.
    const many = [...Array(199).fill({ stars: 5 }), { stars: 4 }];
    expect(ratingSummary(many, "csv", NOW)?.score).toBe(4.99);
  });
  it("shopifyRatingSummary: 4.679 → 4.67", () => {
    const s = shopifyRatingSummary([{ rating: JSON.stringify({ value: "4.679", scale_min: "1.0", scale_max: "5.0" }), count: "3" }], NOW);
    expect(s?.score).toBe(4.67);
  });
});

/* ------------------------------------------------------------------ */
describe("2 · duplicate key: raw reviewer, raw rating; none without id and text", () => {
  const text = "Très bon produit livraison rapide je recommande.";
  it("two people masked alike (Marie Dupont / Marie Durand → « Marie D. ») both count", () => {
    const r = parseReviewsCsv(`rating,body,author,date\n5,${text},Marie Dupont,2025-03-04\n5,${text},Marie Durand,2025-03-04\n`, NOW);
    expect(r.reviews).toHaveLength(2);
    expect(r.reviews[0].name).toBe(r.reviews[1].name);
    expect(r.skipped).toBe(0);
  });
  it("same text, same person, different rating: two reviews", () => {
    const r = parseReviewsCsv(`rating,body,author\n5,${text},Marie Dupont\n4,${text},Marie Dupont\n`, NOW);
    expect(r.reviews).toHaveLength(2);
    expect(r.summary?.count).toBe(2);
  });
  it("e-mail column tells two reviewers apart (never shown)", () => {
    const r = parseReviewsCsv(`rating,body,author,email\n5,${text},Client,a@x.fr\n5,${text},Client,b@x.fr\n5,${text},Client,a@x.fr\n`, NOW);
    expect(r.reviews).toHaveLength(2);
    expect(r.skipped).toBe(1);
    expect(JSON.stringify(r.reviews)).not.toContain("@x.fr");
  });
  it("a real duplicate row is still dropped", () => {
    const r = parseReviewsCsv(`rating,body,author,date\n5,${text},Marie Dupont,2025-03-04\n5,${text},Marie Dupont,2025-03-04\n`, NOW);
    expect(r.reviews).toHaveLength(1);
    expect(r.skipped).toBe(1);
  });
  it("rating-only rows without id: never deduplicated (each counts in the average)", () => {
    const r = parseReviewsCsv(`rating,body,author\n5,,Client\n5,,Client\n4,,Client\n`, NOW);
    expect(r.withoutText).toBe(3);
    expect(r.summary?.count).toBe(3);
    expect(r.skipped).toBe(0);
  });
  it("Judge.me without ids: raw name / e-mail and rating in the key; rating-only never merged", () => {
    const page = {
      reviews: [
        { rating: 5, body: text, reviewer: { name: "Marie Dupont", email: "a@x.fr" }, published: true },
        { rating: 5, body: text, reviewer: { name: "Marie Durand", email: "b@x.fr" }, published: true },
        { rating: 4, body: text, reviewer: { name: "Marie Dupont", email: "a@x.fr" }, published: true },
        { rating: 5, body: text, reviewer: { name: "Marie Dupont", email: "a@x.fr" }, published: true }, // duplicate
        { rating: 5, body: "", reviewer: { name: "X" }, published: true },
        { rating: 5, body: "", reviewer: { name: "X" }, published: true },
      ],
    };
    const { reviews, rated } = readJudgeMePage(page, NOW);
    expect(reviews).toHaveLength(3);
    expect(rated).toHaveLength(5);
  });
});

/* ------------------------------------------------------------------ */
function reviewsBlock(over: Partial<BlockOf<"reviews">["props"]> = {}): BlockOf<"reviews"> {
  const b = createBlock("reviews") as BlockOf<"reviews">;
  return { ...b, sample: undefined, props: { ...b.props, items: [], summary: null, ...over } };
}

type SetOutside = (f: (b: Block) => Block) => void;
function Harness({ initial, onBlock, expose }: { initial: Block; onBlock: (b: Block) => void; expose: (set: SetOutside) => void }) {
  const [block, setBlock] = useState(initial);
  // Exposed so the test can change the block from outside (another panel / undo) mid-request.
  useEffect(() => expose((f) => setBlock((b) => f(b))), [expose]);
  return h(BlockContentEditor, {
    block,
    context: { blocks: [block], storeId: "s1" },
    onChange: (b: Block) => {
      onBlock(b);
      setBlock(b);
    },
  });
}

describe("3 · Shopify note: lands on the block as it is then; editor locked meanwhile", () => {
  beforeEach(() => actions.shopify.mockReset());
  it("locks the editor with « Récupération… », then patches the latest block", async () => {
    let resolve!: (v: unknown) => void;
    actions.shopify.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    let last: Block | null = null;
    let setOutside: SetOutside = () => {};
    render(h(Harness, { initial: reviewsBlock({ title: "Avis" }), onBlock: (b) => (last = b), expose: (s) => (setOutside = s) }));
    await act(async () => {});
    const title = screen.getAllByRole("textbox")[0] as HTMLInputElement;
    expect(title.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Récupérer ma note depuis Shopify/ }));
    });
    expect(screen.getByRole("button", { name: /Récupération…/ })).toBeTruthy();
    expect(screen.getByText(/Le bloc est verrouillé/)).toBeTruthy();
    // Disabled by the enclosing <fieldset disabled> (":disabled", not the input's own attribute).
    expect(screen.getAllByRole("textbox")[0].matches(":disabled")).toBe(true);
    expect(screen.getByText(/Ajouter un avis à la main/).closest("button")!.matches(":disabled")).toBe(true);
    // Something else changes the block meanwhile (block panel « Masquer », undo…).
    await act(async () => {
      setOutside((b) => ({ ...b, hidden: true, props: { ...b.props, title: "Nos clients" } }) as Block);
    });
    const summary: ReviewSummary = { score: 4.6, count: 12, source: "shopify", asOf: "2026-09-28" };
    await act(async () => {
      resolve({ ok: true, data: { summary, products: 3, capped: false } });
    });
    const b = last as unknown as BlockOf<"reviews">;
    expect(b.props.summary).toEqual(summary);
    expect(b.props.title).toBe("Nos clients");
    expect(b.hidden).toBe(true);
    expect(screen.getAllByRole("textbox")[0].matches(":disabled")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
describe("4 · recommendations: translations follow their product", () => {
  it("removing product 1 moves product 2's translated title to slot 1", async () => {
    const b = createBlock("recommendations") as BlockOf<"recommendations">;
    const block = {
      ...b,
      props: {
        ...b.props,
        items: [
          { variantId: "gid://shopify/ProductVariant/1", title: "Un", imageUrl: "" },
          { variantId: "gid://shopify/ProductVariant/2", title: "Deux", imageUrl: "" },
        ],
      },
      i18n: { en: { "items.0.title": "One", "items.1.title": "Two" } },
    } as Block;
    let last: Block | null = null;
    render(h(BlockContentEditor, { block, context: { blocks: [block], storeId: null }, onChange: (x: Block) => (last = x) }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retirer le produit 1" }));
    });
    const out = last as unknown as Block;
    expect((out.props as { items: unknown[] }).items).toHaveLength(1);
    expect(out.i18n).toEqual({ en: { "items.0.title": "Two" } });
  });
});

/* ------------------------------------------------------------------ */
describe("5 · partial import: « (les N avis lus) »", () => {
  it("summaryScope", () => {
    expect(summaryScope(1000, true)).toBe(`les ${(1000).toLocaleString("fr-FR")} avis lus`);
    expect(summaryScope(40, false)).toBe("tous vos avis publiés");
  });
  it("capped Judge.me import shows it next to the average", async () => {
    actions.judgeme.mockResolvedValueOnce({
      ok: true,
      data: {
        reviews: [{ name: "Léa M.", text: "Parfait, rien à redire sur ce produit.", stars: 5, verified: true, source: "judgeme" }],
        summary: { score: 4.7, count: 1000, source: "judgeme", asOf: "2026-09-28" },
        rated: 1000,
        capped: true,
      },
    });
    const block = reviewsBlock();
    render(h(BlockContentEditor, { block, context: { blocks: [block], storeId: "s1" }, onChange: () => {} }));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Importer depuis Judge.me/ }));
    });
    expect(screen.getByText(/Afficher la note moyenne/).textContent).toContain(`(les ${(1000).toLocaleString("fr-FR")} avis lus)`);
    expect(screen.getByText(/Afficher la note moyenne/).textContent).not.toContain("tous vos avis publiés");
  });
});

/* ------------------------------------------------------------------ */
describe("6 · « of 5 » stars: always plural after the 5", () => {
  it("de / es / nl", () => {
    expect(labelsFor("de").starsOutOf5("1", 1)).toBe("1 von 5 Sternen");
    expect(labelsFor("es").starsOutOf5("1", 1)).toBe("1 de 5 estrellas");
    expect(labelsFor("nl").starsOutOf5("1", 1)).toBe("1 van 5 sterren");
    expect(labelsFor("de").starsOutOf5("4", 4)).toBe("4 von 5 Sternen");
  });
});

/* ------------------------------------------------------------------ */
type FakeWorkerMode = "fail" | "garbled" | "silent" | "unavailable" | "ok";
function installWorker(mode: FakeWorkerMode) {
  const made: { terminated: boolean }[] = [];
  class FakeWorker {
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onmessageerror: ((e: unknown) => void) | null = null;
    onerror: ((e: { preventDefault: () => void }) => void) | null = null;
    terminated = false;
    constructor() {
      made.push(this);
    }
    postMessage() {
      queueMicrotask(() => {
        if (mode === "fail") this.onmessage?.({ data: { ok: false } });
        else if (mode === "garbled") this.onmessageerror?.({});
        else if (mode === "unavailable") this.onerror?.({ preventDefault() {} });
        else if (mode === "ok") this.onmessage?.({ data: { ok: true, result: { reviews: [], skipped: 0, withoutText: 0, summary: null, columns: {} } } });
      });
    }
    terminate() {
      this.terminated = true;
    }
  }
  vi.stubGlobal("Worker", FakeWorker);
  return made;
}

describe("7 · CSV worker: failures reject, no main-thread re-parse; timeout", () => {
  // jsdom's Blob has no arrayBuffer(): a minimal file.
  const csv = { arrayBuffer: async () => new TextEncoder().encode("rating,body\n5,Excellent produit vraiment top\n").buffer } as unknown as Blob;
  afterEach(() => vi.unstubAllGlobals());
  it("ok:false → CsvWorkerError, the file is not parsed again on the main thread", async () => {
    const made = installWorker("fail");
    await expect(parseReviewsFile(csv)).rejects.toBeInstanceOf(CsvWorkerError);
    expect(made[0].terminated).toBe(true);
  });
  it("unreadable answer (messageerror) → CsvWorkerError", async () => {
    installWorker("garbled");
    await expect(parseReviewsFile(csv)).rejects.toBeInstanceOf(CsvWorkerError);
  });
  it("no answer within the timeout → clear message, worker stopped", async () => {
    vi.useFakeTimers();
    const made = installWorker("silent");
    const p = parseReviewsFile(csv, 30_000);
    const settled = expect(p).rejects.toThrow(/plus de 30 secondes/);
    await vi.advanceTimersByTimeAsync(30_001);
    await settled;
    expect(made[0].terminated).toBe(true);
  });
  it("a worker that cannot start: parsed on the main thread", async () => {
    installWorker("unavailable");
    const r = await parseReviewsFile(csv);
    expect(r.reviews).toHaveLength(1);
  });
  it("worker answer is used as is", async () => {
    installWorker("ok");
    const r = await parseReviewsFile(csv);
    expect(r.reviews).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
describe("8 · buyer-facing line on imported reviews (EU Omnibus)", () => {
  const ctx = (lang: "fr" | "en" | "de" | "es" | "it" | "nl") => ({
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
  });
  const rv = (over: Partial<ReviewItem>): ReviewItem => ({ name: "A", text: "Un avis assez long pour compter vraiment.", stars: 5, verified: false, ...over });
  const out = (items: ReviewItem[], lang: Parameters<typeof ctx>[0] = "fr") =>
    renderToStaticMarkup(h(ContentBlock, { block: reviewsBlock({ layout: "stack", items }) as Block, ctx: ctx(lang) as never }));

  it("Judge.me reviews: named", () => {
    const html = out([rv({ source: "judgeme", verified: true })]);
    expect(html).toContain("data-imported-reviews-note");
    expect(html).toContain("Sélection d&#x27;avis importés de Judge.me ; « Achat vérifié » indique un achat confirmé par l&#x27;application.");
    expect(html).toMatch(/data-imported-reviews-note="true" class="[^"]*text-xs[^"]*text-\[var\(--muted\)\]/);
  });
  it("CSV (or mixed) reviews: the review app, unnamed", () => {
    expect(out([rv({ source: "csv" })])).toContain("Sélection d&#x27;avis importés de l&#x27;application d&#x27;avis de la boutique");
    expect(out([rv({ source: "csv" }), rv({ source: "judgeme", text: "Autre avis assez long pour compter." })])).not.toContain("Judge.me");
  });
  it("hand-typed only: nothing", () => {
    expect(out([rv({ source: "manual" })])).not.toContain("data-imported-reviews-note");
    expect(out([rv({})])).not.toContain("data-imported-reviews-note");
  });
  it("shipped example reviews saved with an import source (old untagged block): nothing", () => {
    const samples = (createBlock("reviews") as BlockOf<"reviews">).props.items.map((it) => ({ ...it, source: "csv" as const }));
    expect(out(samples)).not.toContain("data-imported-reviews-note");
  });
  it("in the 6 languages", () => {
    const items = [rv({ source: "judgeme" })];
    expect(out(items, "en")).toContain("A selection of reviews imported from Judge.me");
    expect(out(items, "de")).toContain("Auswahl von Bewertungen, importiert aus Judge.me");
    expect(out(items, "es")).toContain("Selección de opiniones importadas de Judge.me");
    expect(out(items, "it")).toContain("Selezione di recensioni importate da Judge.me");
    expect(out(items, "nl")).toContain("Selectie van reviews geïmporteerd uit Judge.me");
    for (const lang of ["fr", "en", "de", "es", "it", "nl"] as const) {
      expect(labelsFor(lang).importedReviewsNote(null)).not.toContain("null");
      expect(labelsFor(lang).importedReviewsNote(null)).toContain(labelsFor(lang).verifiedPurchase);
    }
  });
  it("importedReviewsOrigin", () => {
    expect(importedReviewsOrigin([])).toBeNull();
    expect(importedReviewsOrigin([{ source: "manual" }, {}])).toBeNull();
    expect(importedReviewsOrigin([{ source: "judgeme" }, { source: "manual" }])).toBe("judgeme");
    expect(importedReviewsOrigin([{ source: "judgeme" }, { source: "csv" }])).toBe("app");
  });
});
