// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Block, BlockOf, ReviewItem } from "@/lib/layout";

/*
 * Reviews without limits: 300 per block, long texts, every review editable (imported ones keep
 * « Achat vérifié » only while their text and stars are the imported ones), bulk actions,
 * « Coller des avis », no example hidden by its text, and 300 reviews rendered by pages.
 */

const actions = vi.hoisted(() => ({ status: vi.fn(async () => ({ connected: false, shopConnected: true, owner: true })) }));
vi.mock("@/lib/reviews-actions", () => ({
  judgeMeStatusAction: actions.status,
  forgetJudgeMeAction: vi.fn(async () => ({ ok: true })),
  importJudgeMeAction: vi.fn(),
  shopifyReviewRatingAction: vi.fn(),
}));
vi.mock("@/lib/catalog", () => ({ searchCatalog: vi.fn(async () => []), getCatalogVariant: vi.fn(async () => null) }));

const { blockSchema, createBlock, editReviewItem, honestReviewItem, loadCheckoutLayout, MAX_REVIEW_ITEMS, REVIEW_LIMITS, reviewItemSchema, reviewLostVerified, reviewSignature } =
  await import("@/lib/layout");
const { honestReviewItems, liveReviewItems } = await import("@/lib/sample-content");
const { ReviewsList, MANUAL_REVIEW_NOTE } = await import("@/components/builder/ReviewsList");
const { ReviewsPaste, draftToReview } = await import("@/components/builder/ReviewsPaste");
const { BlockContentEditor } = await import("@/components/builder/BlockEditor");
const { ContentBlock } = await import("@/components/checkout/blocks");
const { labelsFor } = await import("@/components/checkout/i18n");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const rv = (over: Partial<ReviewItem> = {}): ReviewItem => ({ name: "Léa M.", text: "Très bon produit, livraison rapide.", stars: 5, verified: false, source: "manual", ...over });
const imported = (over: Partial<ReviewItem> = {}) => rv({ name: "Anna K.", text: "Imported review, as the customer wrote it.", source: "judgeme", verified: true, ...over });
const many = (n: number, over: (i: number) => Partial<ReviewItem> = () => ({})) => Array.from({ length: n }, (_, i) => rv({ name: `Client ${i}`, text: `Avis numéro ${i}, très satisfait.`, ...over(i) }));
function reviewsBlock(items: ReviewItem[], over: Partial<BlockOf<"reviews">["props"]> = {}): BlockOf<"reviews"> {
  const b = createBlock("reviews") as BlockOf<"reviews">;
  return { ...b, sample: undefined, props: { ...b.props, items, summary: null, ...over } };
}

/* ------------------------------------------------------------------ */
describe("1 · caps: 300 reviews, 5 000 characters", () => {
  it("schema", () => {
    expect(MAX_REVIEW_ITEMS).toBe(300);
    expect(REVIEW_LIMITS).toEqual({ name: 120, text: 5000, title: 300 });
    expect(blockSchema.safeParse(reviewsBlock(many(300))).success).toBe(true);
    expect(blockSchema.safeParse(reviewsBlock(many(301))).success).toBe(false);
    expect(reviewItemSchema.safeParse(rv({ text: "a".repeat(5000), name: "n".repeat(120), title: "t".repeat(300) })).data?.title).toHaveLength(300);
    expect(reviewItemSchema.safeParse(rv({ text: "a".repeat(5001) })).success).toBe(false);
    expect(reviewItemSchema.safeParse(rv({ name: "n".repeat(121) })).success).toBe(false);
    // An over-long title is dropped on its own (the review stays).
    expect(reviewItemSchema.safeParse(rv({ title: "t".repeat(301) })).data?.title).toBeUndefined();
  });

  it("a saved layout with 300 long reviews loads unchanged", () => {
    const items = many(300, (i) => ({ text: `${i} ${"é".repeat(4990)}` }));
    const layout = loadCheckoutLayout({ version: 1, blocks: [reviewsBlock(items)] });
    const b = layout.blocks.find((x) => x.type === "reviews") as BlockOf<"reviews">;
    expect(b.props.items).toHaveLength(300);
    expect(b.props.items[299].text).toBe(items[299].text);
    expect(b.sample).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
describe("2 · imported reviews are editable; « Achat vérifié » only while unchanged", () => {
  it("name, date, photo, title, product: still verified", () => {
    let r = imported();
    r = editReviewItem(r, { name: "Anna" });
    r = editReviewItem(r, { date: "2025-01-02", photoUrl: "https://cdn.example.com/p.jpg", title: "Super", productTitle: "Crème" });
    expect(r.verified).toBe(true);
    expect(r.importSig).toBe(reviewSignature(imported()));
    expect(honestReviewItem(r).verified).toBe(true);
    expect(reviewLostVerified(r)).toBe(false);
  });

  it("text or stars rewritten: no longer verified; back to the imported ones: verified again", () => {
    const r = editReviewItem(imported(), { text: "Rewritten by the merchant." });
    expect(r.verified).toBe(false);
    expect(reviewLostVerified(r)).toBe(true);
    const s = editReviewItem(imported(), { stars: 4 });
    expect(s.verified).toBe(false);
    expect(editReviewItem(r, { text: imported().text }).verified).toBe(true);
    // Spacing is not a rewrite.
    expect(editReviewItem(imported(), { text: `  ${imported().text.replace(" ", "\n")} ` }).verified).toBe(true);
  });

  it("a forged verified flag on a rewritten review is never shown (render and load)", () => {
    const forged = { ...editReviewItem(imported(), { text: "Faux texte" }), verified: true };
    expect(honestReviewItem(forged).verified).toBe(false);
    expect(honestReviewItems([forged])[0].verified).toBe(false);
    const layout = loadCheckoutLayout({ version: 1, blocks: [reviewsBlock([forged])] });
    expect((layout.blocks.find((b) => b.type === "reviews") as BlockOf<"reviews">).props.items[0].verified).toBe(false);
  });

  it("an imported review that was not verified never becomes verified", () => {
    const r = editReviewItem(imported({ verified: false }), { name: "X" });
    expect(r.verified).toBe(false);
    expect(r.importSig).toBeUndefined();
  });

  it("typed or pasted reviews are never verified", () => {
    expect(editReviewItem(rv({ verified: true }), { name: "Bob" }).verified).toBe(false);
    expect(honestReviewItem(rv({ verified: true })).verified).toBe(false);
    expect(honestReviewItem({ ...rv(), source: undefined, verified: true }).verified).toBe(false);
    expect(draftToReview({ name: "Marie", text: "Top", stars: 5 })).toEqual({ name: "Marie", text: "Top", stars: 5, verified: false, source: "manual" });
  });
});

/* ------------------------------------------------------------------ */
describe("3 · no review hidden because it looks like an example", () => {
  it("a new block starts empty (nothing invented); the old untouched example reviews stay hidden; every other review with text shows", () => {
    const fresh = createBlock("reviews") as BlockOf<"reviews">;
    expect(fresh.sample).toBeUndefined();
    expect(fresh.props.items).toEqual([]);
    expect(liveReviewItems(fresh)).toEqual([]);
    // The examples earlier versions shipped (invented customers, shipped texts): never shown.
    const camille = rv({ name: "Camille R.", text: "Commande reçue en 3 jours, qualité au top. Je recommande !" });
    expect(liveReviewItems(reviewsBlock([camille]))).toEqual([]);
    // Once its text is edited, it is the merchant's review: shown as written.
    expect(liveReviewItems(reviewsBlock([{ ...camille, text: "Reçu en 2 jours, parfait." }])).map((r) => r.name)).toEqual(["Camille R."]);
    expect(liveReviewItems(reviewsBlock([rv(), rv({ text: "   " })]))).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
const ctx = (preview = false) => ({
  labels: labelsFor("fr"),
  lang: "fr" as const,
  lowestInventory: null,
  preview,
  subtotalCents: 0,
  freeShippingThresholdCents: null,
  money: (c: number) => String(c),
  note: "",
  setNote: () => {},
  cartProducts: null,
});
const cards = (html: string) => (html.match(/<figure/g) ?? []).length;

describe("4 · 300 reviews render by pages", () => {
  it("list: 3 cards, then 10 more per click", () => {
    const view = render(h(ContentBlock, { block: reviewsBlock(many(300), { layout: "stack" }), ctx: ctx() }));
    expect(view.container.querySelectorAll("figure")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Voir 10 avis de plus" }));
    expect(view.container.querySelectorAll("figure")).toHaveLength(13);
  });

  it("carousel: only the page of 10 around the current card is in the page", () => {
    const view = render(h(ContentBlock, { block: reviewsBlock(many(300), { layout: "carousel" }), ctx: ctx() }));
    expect(view.container.querySelectorAll("figure")).toHaveLength(10);
    expect(view.container.textContent).toContain("1 / 300");
    const prev = screen.getByRole("button", { name: /précédent/i });
    fireEvent.click(prev); // wraps to the last review
    expect(view.container.textContent).toContain("300 / 300");
    expect(view.container.querySelectorAll("figure")).toHaveLength(10);
    expect(view.container.textContent).toContain("Client 299");
  });

  it("auto (server render): bounded markup for 300 reviews", () => {
    const html = renderToStaticMarkup(h(ContentBlock, { block: reviewsBlock(many(300), { layout: "auto" }), ctx: ctx() }));
    expect(cards(html)).toBe(13); // 10 carousel + 3 list
  });
});

/* ------------------------------------------------------------------ */
function ListHarness({ initial, onItems }: { initial: ReviewItem[]; onItems?: (items: ReviewItem[]) => void }) {
  const [items, setItems] = useState(initial);
  return h(ReviewsList, {
    items,
    onChange: (next: ReviewItem[]) => {
      onItems?.(next);
      setItems(next);
    },
  });
}

describe("5 · reviews list in the builder", () => {
  it("edits an imported review: verified kept for the name, lost (with the reason) for the text", () => {
    let last: ReviewItem[] = [];
    render(h(ListHarness, { initial: [imported()], onItems: (i) => (last = i) }));
    fireEvent.click(screen.getByRole("button", { name: "Modifier l'avis 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nom du client (avis 1)" }), { target: { value: "Anna Karenine" } });
    expect(last[0]).toMatchObject({ name: "Anna Karenine", verified: true, source: "judgeme" });
    expect(screen.getByText(/Achat vérifié : gardé tant que/)).toBeTruthy();
    const area = screen.getAllByRole("textbox").find((el) => el.tagName === "TEXTAREA")!;
    fireEvent.change(area, { target: { value: "Texte réécrit." } });
    expect(last[0]).toMatchObject({ text: "Texte réécrit.", verified: false });
    expect(document.querySelector("[data-lost-verified]")?.textContent).toMatch(/badge « Achat vérifié » est retiré/);
    fireEvent.click(screen.getByRole("radio", { name: "3 étoiles" }));
    expect(last[0].stars).toBe(3);
    fireEvent.change(screen.getByLabelText("Date de l'avis 1"), { target: { value: "2025-02-03" } });
    expect(last[0].date).toBe("2025-02-03");
    fireEvent.change(screen.getByRole("textbox", { name: "Produit de l'avis 1" }), { target: { value: "Sérum" } });
    expect(last[0].productTitle).toBe("Sérum");
  });

  it("manual review: every field, the anti fake-review line, never verified", () => {
    let last: ReviewItem[] = [];
    render(h(ListHarness, { initial: [], onItems: (i) => (last = i) }));
    fireEvent.click(screen.getByRole("button", { name: "+ Ajouter un avis à la main" }));
    expect(last).toEqual([{ name: "", text: "", stars: 5, verified: false, source: "manual" }]);
    expect(screen.getByText(MANUAL_REVIEW_NOTE)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Titre de l'avis 1" }), { target: { value: "Top" } });
    fireEvent.change(screen.getByRole("textbox", { name: /Lien de l'image|Coller un lien/ }), { target: { value: "https://cdn.example.com/a.jpg" } });
    expect(last[0]).toMatchObject({ title: "Top", photoUrl: "https://cdn.example.com/a.jpg", verified: false });
  });

  it("reorder, bulk select + delete, delete all", () => {
    let last: ReviewItem[] = [];
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(h(ListHarness, { initial: many(5), onItems: (i) => (last = i) }));
    fireEvent.click(screen.getByRole("button", { name: "Descendre l'avis 1" }));
    expect(last.map((r) => r.name).slice(0, 2)).toEqual(["Client 1", "Client 0"]);
    fireEvent.click(screen.getByRole("button", { name: "Monter l'avis 2" }));
    expect(last.map((r) => r.name).slice(0, 2)).toEqual(["Client 0", "Client 1"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Sélectionner l'avis 2 de Client 1" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Sélectionner l'avis 4 de Client 3" }));
    fireEvent.click(screen.getByRole("button", { name: /Supprimer la sélection \(2\)/ }));
    expect(last.map((r) => r.name)).toEqual(["Client 0", "Client 2", "Client 4"]);
    fireEvent.click(screen.getByRole("checkbox", { name: "Tout sélectionner" }));
    expect(screen.getByRole("button", { name: /Supprimer la sélection \(3\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Supprimer tous les avis" }));
    expect(last).toEqual([]);
  });

  it("300 reviews: listed 20 at a time, counter warns, adding is disabled at the maximum", () => {
    const view = render(h(ListHarness, { initial: many(300) }));
    expect(view.container.querySelectorAll("[data-review-row]")).toHaveLength(20);
    expect(view.container.querySelector("[data-reviews-count]")?.textContent).toBe("300/300 avis (maximum atteint)");
    fireEvent.click(screen.getByRole("button", { name: /Afficher 20 avis de plus/ }));
    expect(view.container.querySelectorAll("[data-review-row]")).toHaveLength(40);
    expect((screen.getByRole("button", { name: "+ Ajouter un avis à la main" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const near = render(h(ListHarness, { initial: many(295) }));
    expect(near.container.querySelector("[data-reviews-count]")?.textContent).toBe("295/300 avis (plus que 5 places)");
  });
});

/* ------------------------------------------------------------------ */
const PASTE = `Marie D.
★★★★★
12/03/2025
Très contente, livraison rapide !

Paul R.
3/5
Bonne qualité, un peu long à arriver.

Sans étoiles ni nom, mais un vrai avis.`;

function paste(text: string) {
  fireEvent.click(screen.getByRole("button", { name: /Coller des avis/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Coller des avis" }), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Analyser les avis" }));
}

describe("6 · « Coller des avis »", () => {
  it("preview: rows, default stars flagged, clickable stars, editable name, unticked row, then Ajouter", () => {
    const onApply = vi.fn();
    render(h(ReviewsPaste, { items: [rv({ name: "Déjà là" })], onApply }));
    paste(PASTE);
    expect(screen.getByText(/3 avis trouvés/)).toBeTruthy();
    expect(document.querySelectorAll("[data-paste-row]")).toHaveLength(3);
    expect(screen.getByText("Note par défaut")).toBeTruthy();
    expect(screen.getByText(/Note non trouvée : 5 étoiles par défaut/)).toBeTruthy();
    const row3 = document.querySelectorAll("[data-paste-row]")[2] as HTMLElement;
    fireEvent.click(within(row3).getByRole("button", { name: "4 étoiles" }));
    expect(within(row3).queryByText("Note par défaut")).toBeNull();
    fireEvent.change(within(row3).getByRole("textbox", { name: /^Nom/ }), { target: { value: "Inès" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Sélectionner : Avis 2 de Paul R." }));
    fireEvent.click(screen.getByRole("button", { name: "Ajouter 2 avis" }));
    const items = onApply.mock.calls[0][0] as ReviewItem[];
    expect(items).toEqual([
      rv({ name: "Déjà là" }),
      { name: "Marie D.", text: "Très contente, livraison rapide !", stars: 5, verified: false, source: "manual", date: "2025-03-12" },
      { name: "Inès", text: "Sans étoiles ni nom, mais un vrai avis.", stars: 4, verified: false, source: "manual" },
    ]);
    expect(screen.getByRole("status").textContent).toBe("2 avis ajoutés.");
  });

  it("« Remplacer tous les avis » asks first, then replaces imported ones too", () => {
    const onApply = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(h(ReviewsPaste, { items: [imported(), rv()], onApply }));
    paste(PASTE);
    fireEvent.click(screen.getByRole("checkbox", { name: "Tout sélectionner" })); // all off
    fireEvent.click(screen.getByRole("checkbox", { name: "Tout sélectionner" })); // all on
    fireEvent.click(screen.getByRole("button", { name: "Remplacer tous les avis" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Remplacer les 2 avis du bloc"));
    expect((onApply.mock.calls[0][0] as ReviewItem[]).map((r) => r.name)).toEqual(["Marie D.", "Paul R.", ""]);
    expect((onApply.mock.calls[0][0] as ReviewItem[]).every((r) => !r.verified && r.source === "manual")).toBe(true);
  });

  it("a new (empty) block: Ajouter adds the pasted reviews, no examples to remove", () => {
    const onApply = vi.fn();
    const fresh = createBlock("reviews") as BlockOf<"reviews">;
    render(h(ReviewsPaste, { items: fresh.props.items, onApply }));
    paste(PASTE);
    fireEvent.click(screen.getByRole("button", { name: "Ajouter 3 avis" }));
    expect((onApply.mock.calls[0][0] as ReviewItem[]).map((r) => r.name)).toEqual(["Marie D.", "Paul R.", ""]);
    expect(screen.getByRole("status").textContent).toBe("3 avis ajoutés.");
  });

  it("room left: only the first ones are added, with a message; 300+ pasted are paged", () => {
    const onApply = vi.fn();
    render(h(ReviewsPaste, { items: many(298), onApply }));
    paste(Array.from({ length: 320 }, (_, i) => `Client ${String.fromCharCode(65 + (i % 26))}.\n★★★★★\nAvis collé numéro ${i}.`).join("\r\n\r\n"));
    expect(screen.getByText(/320 avis trouvés/)).toBeTruthy();
    expect(document.querySelectorAll("[data-paste-row]")).toHaveLength(50);
    expect(screen.getByText(/Il reste 2 places sur 300 : seuls les 2 premiers/)).toBeTruthy();
    expect(screen.getByText(/« Remplacer » garde les 300 premiers/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ajouter 2 avis" }));
    const items = onApply.mock.calls[0][0] as ReviewItem[];
    expect(items).toHaveLength(300);
    expect(items.slice(-2).map((r) => [r.name, r.text])).toEqual([
      ["Client A.", "Avis collé numéro 0."],
      ["Client B.", "Avis collé numéro 1."],
    ]);
    expect(screen.getByRole("status").textContent).toBe("2 avis ajoutés. 318 non ajoutés : 300 avis maximum par bloc.");
  });

  it("nothing found", () => {
    render(h(ReviewsPaste, { items: [], onApply: vi.fn() }));
    paste("   \n\n  ");
    expect((screen.getByRole("button", { name: "Analyser les avis" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
describe("7 · in the block editor", () => {
  function EditorHarness({ initial, onBlock }: { initial: Block; onBlock: (b: Block) => void }) {
    const [block, setBlock] = useState(initial);
    return h(BlockContentEditor, {
      block,
      context: { blocks: [block], storeId: null },
      onChange: (b: Block) => {
        onBlock(b);
        setBlock(b);
      },
    });
  }

  it("paste, add, then edit the pasted review in the list", async () => {
    let last: Block | null = null;
    render(h(EditorHarness, { initial: reviewsBlock([]), onBlock: (b) => (last = b) }));
    await act(async () => {});
    expect(screen.getByText(new RegExp(MANUAL_REVIEW_NOTE.replace(/[()]/g, ".")))).toBeTruthy();
    paste(PASTE);
    fireEvent.click(screen.getByRole("button", { name: "Ajouter 3 avis" }));
    const items = (last as unknown as BlockOf<"reviews">).props.items;
    expect(items.map((r) => [r.name, r.stars])).toEqual([
      ["Marie D.", 5],
      ["Paul R.", 3],
      ["", 5],
    ]);
    expect(document.querySelectorAll("[data-review-row]")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Modifier l'avis 2" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Nom du client (avis 2)" }), { target: { value: "Paul" } });
    expect((last as unknown as BlockOf<"reviews">).props.items[1]).toMatchObject({ name: "Paul", verified: false });
  });
});
