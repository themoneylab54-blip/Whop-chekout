import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createBlock, loadCheckoutLayout, MAX_REVIEW_ITEMS, type BlockOf, type ReviewItem } from "@/lib/layout";
import {
  CsvParseError,
  decodeCsvBytes,
  firstPhotoUrl,
  mergeImported,
  ownReviews,
  parseCsv,
  parseReviewsCsv,
  plainText,
  rankReviews,
  ratingSummary,
  readJudgeMePage,
  selectRanked,
  selectReviews,
  shopifyRatingSummary,
} from "@/lib/reviews-import";
import { isSampleReview } from "@/lib/sample-content";
import { ContentBlock, starFill, Stars, type ContentContext } from "@/components/checkout/blocks";
import { labelsFor, type Lang } from "@/components/checkout/i18n";

const NOW = Date.UTC(2026, 8, 28);
const rv = (over: Partial<ReviewItem>): ReviewItem => ({ name: "A", text: "Un avis assez long pour compter vraiment.", stars: 5, verified: false, ...over });
const ctx = (lang: Lang = "fr", preview = false): ContentContext => ({
  labels: labelsFor(lang),
  lang,
  lowestInventory: null,
  preview,
  subtotalCents: 0,
  freeShippingThresholdCents: null,
  money: (c) => String(c),
  note: "",
  setNote: () => {},
  cartProducts: null,
});
const block = (over: Partial<BlockOf<"reviews">["props"]>, sample?: true): BlockOf<"reviews"> => {
  const b = createBlock("reviews") as BlockOf<"reviews">;
  return { ...b, sample, props: { ...b.props, layout: "stack", ...over } };
};
const html = (b: BlockOf<"reviews">, c = ctx()) => renderToStaticMarkup(createElement(ContentBlock, { block: b, ctx: c }));

describe("1 · honesty: « Achat vérifié » only from a review app", () => {
  it("a typed (manual / legacy) review saved as verified loads as not verified; imports keep theirs", () => {
    const layout = loadCheckoutLayout({
      blocks: [
        {
          id: "r1",
          type: "reviews",
          props: {
            title: "Avis",
            layout: "stack",
            items: [
              { name: "Manuel", text: "Saisi à la main", stars: 5, verified: true, source: "manual" },
              { name: "Ancien", text: "Saisi avant les sources", stars: 5, verified: true },
              { name: "Csv", text: "Importé", stars: 5, verified: true, source: "csv" },
              { name: "Jm", text: "Importé Judge.me", stars: 5, verified: true, source: "judgeme" },
            ],
          },
        },
      ],
    });
    const r = layout.blocks.find((b) => b.type === "reviews") as BlockOf<"reviews">;
    expect(r.props.items.map((i) => i.verified)).toEqual([false, false, true, true]);
  });
  it("renders no badge on a typed review even if the in-memory item says verified", () => {
    const out = html(block({ items: [rv({ name: "Moi", verified: true, source: "manual" }), rv({ name: "Import", verified: true, source: "judgeme" })] }));
    // Badges only (the transparency line under the block also names « Achat vérifié »).
    expect(out.split("data-imported-reviews-note")[0].match(/Achat vérifié/g)).toHaveLength(1);
  });
});

describe("10 · old untagged sample reviews never show live, nor « Achat vérifié »", () => {
  it("builder and live, untagged block", () => {
    const b = createBlock("reviews") as BlockOf<"reviews">;
    // The example reviews earlier versions shipped (new blocks start empty now).
    const shipped = [
      { name: "Camille R.", text: "Commande reçue en 3 jours, qualité au top. Je recommande !", stars: 5 },
      { name: "Yanis B.", text: "Service client réactif et produit conforme aux photos.", stars: 5 },
    ];
    const items = shipped.map((it) => ({ ...it, verified: true, source: "csv" as const }));
    expect(items.every(isSampleReview)).toBe(true);
    const untagged = { ...b, sample: undefined, props: { ...b.props, layout: "stack" as const, items } };
    // Live: the shipped example reviews never show, tagged or not (the builder still lists them).
    expect(html(untagged)).not.toContain("Camille R.");
    expect(html(untagged, ctx("fr", true))).toContain("Camille R.");
    expect(html(untagged, ctx("fr", true))).not.toContain("Achat vérifié");
  });
});

describe("2 · the average: every published, rated, de-duplicated row", () => {
  it("CSV: rows without text count in the average but are not pickable; raw half stars averaged", () => {
    const csv = ["rating,body,author,review_date", "4.5,Très bien reçu merci beaucoup,Léa,2025-01-02", "5,,Tom,2025-01-03", "3,,Max,2025-01-04", "abc,Pas de note,Zoé,2025-01-05"].join("\n");
    const res = parseReviewsCsv(csv, NOW);
    expect(res.reviews.map((r) => r.name)).toEqual(["Léa"]);
    expect(res.reviews[0].stars).toBe(4); // card stars are whole, floored (4.5 is never 5 stars)
    expect(res.withoutText).toBe(2);
    expect(res.skipped).toBe(1);
    // (4.5 + 5 + 3) / 3 = 4.1666…, not (5 + 5 + 3) / 3.
    // 12.5 / 3 = 4.1666…: cut, never rounded up.
    expect(res.summary).toEqual({ score: 4.16, count: 3, source: "csv", asOf: "2026-09-28" });
  });
  it("de-duplicates by the review id column when present, else by name + text + date", () => {
    const withId = parseReviewsCsv("id,rating,body,author\n1,5,Même texte ici,Léa\n2,5,Même texte ici,Léa\n1,5,Même texte ici,Léa", NOW);
    expect(withId.summary?.count).toBe(2);
    expect(withId.reviews).toHaveLength(2);
    const noId = parseReviewsCsv("rating,body,author,date\n5,Super,Léa,2025-01-02\n4,Super,Léa,2025-03-04\n5,Super,Léa,2025-01-02", NOW);
    expect(noId.summary?.count).toBe(2);
    expect(noId.skipped).toBe(1);
  });
  it("Judge.me: ratings of textless reviews counted, a review met on two pages counted once", () => {
    const seen = new Set<string>();
    const p1 = readJudgeMePage({ reviews: [{ id: 1, rating: 5, body: "Parfait, je recommande.", published: true }, { id: 2, rating: 4, body: "", published: true }] }, NOW, seen);
    const p2 = readJudgeMePage({ reviews: [{ id: 2, rating: 4, body: "", published: true }, { id: 3, rating: 2, title: "Bof", published: true }] }, NOW, seen);
    expect(p1.reviews).toHaveLength(1);
    expect([...p1.rated, ...p2.rated].map((r) => r.stars)).toEqual([5, 4, 2]);
    expect(ratingSummary([...p1.rated, ...p2.rated], "judgeme", NOW)?.score).toBe(3.66);
  });
  it("Shopify metafields: scale bounds honoured (proportional, never lifted to 1 star)", () => {
    // 1/10 → 0.5 star: under the 5-star scale's lowest, left out rather than shown as 1 star.
    expect(shopifyRatingSummary([{ rating: JSON.stringify({ value: "1", scale_min: "1", scale_max: "10" }), count: "1" }], NOW)).toBeNull();
    expect(shopifyRatingSummary([{ rating: JSON.stringify({ value: "10", scale_min: "1", scale_max: "10" }), count: "1" }], NOW)?.score).toBe(5);
    expect(shopifyRatingSummary([{ rating: JSON.stringify({ value: "0.5", scale_min: "1", scale_max: "5" }), count: "3" }])).toBeNull();
  });
});

describe("3 · selection performance", () => {
  it("selectReviews is linear: 60 000 reviews of one product", () => {
    const many = Array.from({ length: 60_000 }, (_, i) => rv({ name: `n${i}`, productHandle: i % 3 ? "p1" : "p2" }));
    const t = performance.now();
    const out = selectReviews(many);
    expect(performance.now() - t).toBeLessThan(1_000);
    expect(out).toHaveLength(MAX_REVIEW_ITEMS);
    expect(selectRanked(rankReviews(many), 5)).toEqual(out.slice(0, 5));
  });
});

describe("4 · robust decoding", () => {
  it("invalid or huge code points keep the entity; control characters are removed", () => {
    expect(plainText("a&#x110000;b", 100)).toBe("a&#x110000;b");
    expect(plainText("a&#99999999999999999999;b", 100)).toBe("a&#99999999999999999999;b");
    expect(plainText("a&#55296;b", 100)).toBe("a&#55296;b");
    expect(plainText("a&#0;b", 100)).toBe("a&#0;b");
    expect(plainText("a\u0000b\u0007c&#1;d", 100)).toBe("abcd");
    expect(plainText("L&#233;a &#x1F600;", 100)).toBe("Léa 😀");
  });
  it("decodes UTF-16 LE / BE (BOM), UTF-8 and Windows-1252 CSV files", () => {
    const text = "rating,body\n5,Très bien";
    const le = new Uint8Array([0xff, 0xfe, ...Array.from(text).flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8])]);
    const be = new Uint8Array([0xfe, 0xff, ...Array.from(text).flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])]);
    expect(decodeCsvBytes(le)).toBe(text);
    expect(decodeCsvBytes(be.buffer)).toBe(text);
    expect(decodeCsvBytes(new TextEncoder().encode(text))).toBe(text);
    expect(decodeCsvBytes(new Uint8Array([0x54, 0x72, 0xe8, 0x73]))).toBe("Très");
    expect(parseReviewsCsv(decodeCsvBytes(le), NOW).reviews[0].text).toBe("Très bien");
  });
});

describe("5 · an import never drops the merchant's own reviews", () => {
  it("the import only gets the room left", () => {
    const own = Array.from({ length: MAX_REVIEW_ITEMS - 2 }, (_, i) => rv({ name: `own${i}`, text: `Mon avis numéro ${i}`, source: "manual" }));
    const picked = Array.from({ length: 5 }, (_, i) => rv({ name: `imp${i}`, text: `Importé ${i}`, source: "csv" }));
    expect(ownReviews(own, isSampleReview)).toHaveLength(MAX_REVIEW_ITEMS - 2);
    const out = mergeImported(own, picked, isSampleReview);
    expect(out).toHaveLength(MAX_REVIEW_ITEMS);
    expect(out.filter((r) => r.source === "manual")).toHaveLength(MAX_REVIEW_ITEMS - 2);
    expect(out.filter((r) => r.source === "csv").map((r) => r.name)).toEqual(["imp0", "imp1"]);
  });
});

describe("6 · CSV: unclosed quote", () => {
  it("is an error naming the line where the quote opened", () => {
    expect(() => parseCsv('a,b\r\n1,2\r\n3,"never closed\n4,5')).toThrow(CsvParseError);
    expect(() => parseCsv('a,b\r\n1,2\r\n3,"never closed\n4,5')).toThrow(/Guillemet non fermé \(ligne 3\)/);
    expect(parseReviewsCsv('rating,body\n5,"Super\n4,Bien', NOW).error).toMatch(/Guillemet non fermé \(ligne 2\)/);
    expect(parseCsv('a,b\n"x\ny",2')).toEqual([["a", "b"], ["x\ny", "2"]]);
  });
});

describe("7 · accessible summary", () => {
  it("screen readers get a localized sentence, the stars and figures are hidden from them", () => {
    const out = html(block({ summary: { score: 4.8, count: 1234, source: "csv" }, items: [rv({ name: "Léa" })] }));
    expect(out).toMatch(/<span class="sr-only">Note moyenne : 4,8 sur 5, 1\s234 avis<\/span><span aria-hidden="true"/);
    const en = html(block({ summary: { score: 5, count: 1, source: "csv" }, items: [rv({ name: "Léa" })] }), ctx("en"));
    expect(en).toContain("Average rating: 5.0 out of 5, 1 review<");
    expect(en).toContain("· 1 review<");
  });
});

describe("8 · carousel", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => rv({ name: `c${i}`, text: `Avis numéro ${i} assez long` }));
  it("region + slide groups labelled « k / n », a polite live region, all cards in one grid cell", () => {
    const out = html(block({ layout: "carousel", items: items(3) }));
    expect(out).toContain('role="region"');
    expect(out).toContain('aria-roledescription="carrousel d&#x27;avis"');
    expect(out).toContain('role="group" aria-roledescription="avis" aria-label="1 / 3"');
    expect(out).toContain('aria-label="3 / 3" aria-hidden="true"');
    expect(out).toContain('aria-live="polite"');
    expect(out).toContain("[grid-area:1/1]");
    expect(out.match(/aria-label="Avis \d"/g)).toHaveLength(3); // dots
  });
  it("more than 6 reviews: a « 1 / 12 » counter instead of dots", () => {
    const out = html(block({ layout: "carousel", items: items(12) }));
    expect(out).not.toMatch(/aria-label="Avis \d+"/);
    expect(out).toMatch(/tabular-nums" aria-hidden="true">1(<!-- -->)? \/ (<!-- -->)?12</);
  });
});

describe("9 · half stars, never rounded up", () => {
  it("floors to the half star", () => {
    expect(starFill(4.8)).toEqual({ full: 4, half: true });
    expect(starFill(4.49)).toEqual({ full: 4, half: false });
    expect(starFill(4.5)).toEqual({ full: 4, half: true });
    expect(starFill(5)).toEqual({ full: 5, half: false });
    expect(starFill(0.3)).toEqual({ full: 0, half: false });
    const out = renderToStaticMarkup(createElement(Stars, { n: 4.8 }));
    expect(out.match(/data-star="full"/g)).toHaveLength(4);
    expect(out.match(/data-star="half"/g)).toHaveLength(1);
    expect(out.match(/data-star="empty"/g)).toBeNull();
  });
});

describe("11 · details", () => {
  it("photo URLs: commas inside a URL kept, videos skipped", () => {
    expect(firstPhotoUrl("https://cdn.x/w_300,h_300/a.jpg")).toBe("https://cdn.x/w_300,h_300/a.jpg");
    expect(firstPhotoUrl("https://cdn.x/1.jpg,https://cdn.x/2.jpg")).toBe("https://cdn.x/1.jpg");
    expect(firstPhotoUrl("https://cdn.x/clip.mp4, https://cdn.x/still.jpg")).toBe("https://cdn.x/still.jpg");
    expect(firstPhotoUrl("https://cdn.x/clip.MOV")).toBeUndefined();
    expect(firstPhotoUrl("https://cdn.x/a.webm?x=1")).toBeUndefined();
  });
  it("EN / NL / DE / ES / IT plurals", () => {
    expect(labelsFor("en").reviewsCount("1", 1)).toBe("1 review");
    expect(labelsFor("en").reviewsCount("2", 2)).toBe("2 reviews");
    expect(labelsFor("en").moreReviews(1)).toBe("Show 1 more review");
    expect(labelsFor("nl").reviewsCount("1", 1)).toBe("1 review");
    expect(labelsFor("nl").moreReviews(1)).toBe("Toon nog 1 review");
    expect(labelsFor("de").reviewsCount("1", 1)).toBe("1 Bewertung");
    expect(labelsFor("es").reviewsCount("1", 1)).toBe("1 opinión");
    expect(labelsFor("it").reviewsCount("1", 1)).toBe("1 recensione");
    expect(labelsFor("fr").reviewsCount("1", 1)).toBe("1 avis");
  });
  it("the summary keeps the day it was computed; a bad date is dropped alone", () => {
    const load = (asOf: unknown) =>
      (
        loadCheckoutLayout({
          blocks: [{ id: "r", type: "reviews", props: { title: "", layout: "auto", items: [rv({})], summary: { score: 4.5, count: 3, source: "csv", asOf } } }],
        }).blocks.find((b) => b.type === "reviews") as BlockOf<"reviews">
      ).props.summary;
    expect(load("2026-09-01")).toEqual({ score: 4.5, count: 3, source: "csv", asOf: "2026-09-01" });
    expect(load("hier")).toMatchObject({ score: 4.5, count: 3, source: "csv" });
    // Never shown to buyers.
    expect(html(block({ summary: { score: 4.5, count: 3, source: "csv", asOf: "2026-09-01" }, items: [rv({})] }))).not.toContain("2026");
  });
  it("long names and titles wrap", () => {
    const out = html(block({ items: [rv({ name: "N".repeat(80), title: "T".repeat(150) })] }));
    expect(out).toContain("leading-snug break-words");
    expect(out).toContain("text-xs break-words");
  });
});
