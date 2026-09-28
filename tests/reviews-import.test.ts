import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { blockSchema, CHECKOUT_PALETTE, createBlock, loadCheckoutLayout, LANGUAGES, type BlockOf, type ReviewItem } from "@/lib/layout";
import {
  cartProductsOf,
  detectDelimiter,
  displayName,
  firstPhotoUrl,
  mergeImported,
  orderReviewsForCart,
  parseCsv,
  parseJudgeMeReviews,
  parseReviewDate,
  parseReviewsCsv,
  parseStars,
  parseVerified,
  plainText,
  rankReviews,
  ratingSummary,
  selectReviews,
  shopifyRatingSummary,
} from "@/lib/reviews-import";
import { isSampleOnly, isSampleReview } from "@/lib/sample-content";
import { ContentBlock, isEmptyInLive, type ContentContext } from "@/components/checkout/blocks";
import { labelsFor, type Lang } from "@/components/checkout/i18n";
import { CHECKOUT_TEMPLATES } from "@/components/builder/templates";

const NOW = Date.UTC(2026, 8, 28);

describe("CSV parser", () => {
  it("handles quotes, doubled quotes, delimiters and line breaks inside fields, CRLF and BOM", () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,2,3\n';
    expect(parseCsv(text)).toEqual([
      ["a", "b", "c"],
      ["x, y", 'say "hi"', "line1\nline2"],
      ["1", "2", "3"],
    ]);
  });
  it("detects semicolon (French Excel) and tab delimiters", () => {
    expect(detectDelimiter("name;rating;body\nA;5;ok")).toBe(";");
    expect(detectDelimiter('"a,b";c;d\n')).toBe(";");
    expect(detectDelimiter("a\tb\tc")).toBe("\t");
    expect(detectDelimiter("single")).toBe(",");
    expect(parseCsv("n;r\nLéa;5")).toEqual([
      ["n", "r"],
      ["Léa", "5"],
    ]);
  });
});

describe("review app CSV exports", () => {
  it("Judge.me export: published reviews, photos, product handle, no verified column → not verified", () => {
    const csv = [
      "title,body,rating,review_date,source,curated,reviewer_name,reviewer_email,product_id,product_handle,reply,reply_date,picture_urls,ip_address,location",
      'Top,"Très bonne qualité, livraison rapide.",5,2025-03-02 10:12:00 UTC,web,ok,Camille Rousseau,c@x.fr,7012345678,creme-visage,,,"https://judgeme.imgix.net/a.jpg,https://judgeme.imgix.net/b.jpg",1.1.1.1,FR',
      "Bof,Pas terrible du tout finalement.,2,2025-01-10,web,ok,Marc,m@x.fr,7012345678,creme-visage,,,,,",
      "Spam,Buy cheap watches here now!!!,5,2025-01-10,web,spam,Bot,b@x.fr,1,x,,,,,",
    ].join("\n");
    const res = parseReviewsCsv(csv, NOW);
    expect(res.error).toBeUndefined();
    expect(res.skipped).toBe(1);
    expect(res.reviews).toHaveLength(2);
    const [a] = res.reviews;
    expect(a).toMatchObject({
      name: "Camille R.",
      title: "Top",
      text: "Très bonne qualité, livraison rapide.",
      stars: 5,
      verified: false,
      date: "2025-03-02",
      photoUrl: "https://judgeme.imgix.net/a.jpg",
      productHandle: "creme-visage",
      productId: "7012345678",
      source: "csv",
    });
    // The reviewer's e-mail never ends up in the block.
    expect(JSON.stringify(res.reviews)).not.toContain("@x.fr");
  });

  it("Loox export (camelCase headers, verified_purchase, status)", () => {
    const csv = [
      "id,status,rating,email,nickname,full_name,review,date,productId,handle,img,variant,verified_purchase",
      "1,Active,5,a@b.c,Julie,Julie Martin,Parfait pour ma fille elle adore,2024-11-05T08:00:00.000Z,8123,robe-ete,http://images.loox.io/x.jpg,M,true",
      "2,Hidden,5,a@b.c,Paul,Paul Durand,Caché par le marchand dans Loox,2024-11-05,8123,robe-ete,,M,true",
      "3,Active,4,a@b.c,,Nora B,Bien mais taille petit un peu,2024-10-01,8124,robe-hiver,,S,false",
    ].join("\n");
    const res = parseReviewsCsv(csv, NOW);
    expect(res.reviews.map((r) => r.name)).toEqual(["Julie", "Nora B."]);
    expect(res.reviews[0]).toMatchObject({ verified: true, productId: "8123", productHandle: "robe-ete", photoUrl: "https://images.loox.io/x.jpg" });
    expect(res.reviews[1].verified).toBe(false);
  });

  it("Shopify Product Reviews export (author, state)", () => {
    const csv = [
      "product_handle,state,rating,title,author,email,location,body,reply,created_at,replied_at",
      "savon-bio,published,4,Agréable,Ines K.,i@x.fr,,Mousse bien et sent bon.,,2023-06-01T10:00:00-04:00,",
      "savon-bio,unpublished,1,Nul,Anon,a@x.fr,,Jamais reçu mon colis,,2023-06-02T10:00:00-04:00,",
    ].join("\n");
    const res = parseReviewsCsv(csv, NOW);
    expect(res.reviews).toHaveLength(1);
    expect(res.reviews[0]).toMatchObject({ name: "Ines K.", stars: 4, productHandle: "savon-bio", date: "2023-06-01", verified: false });
  });

  it("Yotpo / Okendo style exports (semicolon, display name, product url, Is Verified Buyer)", () => {
    const yotpo = [
      "Review Title;Review Content;Review Score;Date;Product ID;Product Title;Product URL;Display Name;Email;Verified Purchase",
      'Super;"Je recommande ; vraiment ""top""";5;15/03/2025;999;Sac cuir;https://shop.fr/products/sac-cuir?variant=1;Ana Lopez;a@x.fr;Yes',
    ].join("\r\n");
    const y = parseReviewsCsv(yotpo, NOW);
    expect(y.reviews[0]).toMatchObject({
      name: "Ana L.",
      text: 'Je recommande ; vraiment "top"',
      date: "2025-03-15",
      productHandle: "sac-cuir",
      productTitle: "Sac cuir",
      verified: true,
    });
    const okendo = [
      "Review ID,Product ID,Product Name,Rating,Title,Body,Reviewer Name,Is Verified Buyer,Date Created,Status",
      "r1,gid://shopify/Product/555,Bougie,4,,Odeur agréable et tient longtemps,Zoé,FALSE,2025-02-01,approved",
    ].join("\n");
    const o = parseReviewsCsv(okendo, NOW);
    expect(o.reviews[0]).toMatchObject({ productId: "555", productTitle: "Bougie", verified: false, stars: 4 });
    expect(o.reviews[0].title).toBeUndefined();
  });

  it("refuses a file that is not a review export, skips rows without rating and duplicates", () => {
    expect(parseReviewsCsv("email,first_name\na@b.c,Léa").error).toMatch(/Colonnes introuvables/);
    expect(parseReviewsCsv("").error).toBeTruthy();
    const res = parseReviewsCsv("rating,body,author\n,Sans note,Léa\n5,Même avis,Léa\n5,Même avis,Léa\n12,Note sur 20,Max", NOW);
    expect(res.reviews).toHaveLength(1);
    expect(res.skipped).toBe(3);
  });
});

describe("field parsing", () => {
  it("maps verified only from explicit values", () => {
    for (const v of ["true", "TRUE", "yes", "1", "Oui", "verified_buyer", "Verified Purchase", "buyer"]) expect(parseVerified(v), v).toBe(true);
    for (const v of ["", "false", "no", "0", "nothing", "email", "unverified", undefined]) expect(parseVerified(v), String(v)).toBe(false);
  });
  it("stars, dates, photos, names, text", () => {
    expect(parseStars("4,6")).toBe(5);
    expect(parseStars("4.0")).toBe(4);
    expect(parseStars("0")).toBeNull();
    expect(parseStars("abc")).toBeNull();
    expect(parseReviewDate("2025-02-30", NOW)).toBeUndefined();
    expect(parseReviewDate("05/03/2024", NOW)).toBeUndefined(); // ambiguous
    expect(parseReviewDate("25/03/2024", NOW)).toBe("2024-03-25");
    expect(parseReviewDate("03/25/2024", NOW)).toBe("2024-03-25");
    expect(parseReviewDate("2030-01-01", NOW)).toBeUndefined(); // future
    expect(firstPhotoUrl("javascript:alert(1), https://cdn.x/y.png")).toBe("https://cdn.x/y.png");
    expect(firstPhotoUrl('["https://cdn.x/a.jpg"]')).toBe("https://cdn.x/a.jpg");
    expect(firstPhotoUrl("")).toBeUndefined();
    expect(displayName("jean.dupont@gmail.com")).toBe("");
    expect(displayName("Marie-Anne de la Tour")).toBe("Marie-Anne de la T.");
    expect(displayName("Léa M")).toBe("Léa M.");
    expect(plainText("<p>Super&nbsp;produit &amp; rapide</p><script>x</script>", 800)).toBe("Super produit & rapide\nx");
    expect(plainText("a".repeat(900), 800)).toHaveLength(800);
  });
});

describe("Judge.me API", () => {
  it("keeps published reviews and maps verified buyers", () => {
    const json = {
      reviews: [
        {
          title: "Génial",
          body: "Je rachèterai sans hésiter.",
          rating: 5,
          product_external_id: 42,
          product_handle: "Tapis-Yoga",
          product_title: "Tapis yoga",
          reviewer: { name: "Sarah Cohen" },
          verified: "buyer",
          created_at: "2025-05-01T12:00:00Z",
          published: true,
          hidden: false,
          curated: "ok",
          pictures: [{ hidden: true, urls: { compact: "https://jm/hidden.jpg" } }, { hidden: false, urls: { compact: "https://jm/ok.jpg" } }],
        },
        { body: "Vérifié par email seulement.", rating: 4, reviewer: { name: "Tom" }, verified: "email", published: true },
        { body: "Masqué", rating: 5, reviewer: { name: "X" }, published: true, hidden: true },
        { body: "Non publié", rating: 5, reviewer: { name: "Y" }, published: false },
      ],
    };
    const out = parseJudgeMeReviews(json, NOW);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: "Sarah C.", verified: true, photoUrl: "https://jm/ok.jpg", productHandle: "tapis-yoga", productId: "42", source: "judgeme", date: "2025-05-01" });
    expect(out[1].verified).toBe(false);
    expect(parseJudgeMeReviews(null)).toEqual([]);
  });
});

const rv = (over: Partial<ReviewItem>): ReviewItem => ({ name: "A", text: "Un avis assez long pour compter vraiment.", stars: 5, verified: false, ...over });

describe("selection", () => {
  it("filters by stars and text, best first (photo, verified, recent)", () => {
    const all = [
      rv({ name: "old5", date: "2023-01-01" }),
      rv({ name: "short", text: "Top" }),
      rv({ name: "four", stars: 4, date: "2025-01-01" }),
      rv({ name: "photo", photoUrl: "https://x/y.jpg", date: "2022-01-01" }),
      rv({ name: "three", stars: 3 }),
      rv({ name: "new5", date: "2025-06-01", verified: true }),
    ];
    expect(rankReviews(all).map((r) => r.name)).toEqual(["photo", "new5", "old5", "four"]);
    expect(rankReviews(all, { sort: "recent" }).map((r) => r.name)).toEqual(["new5", "four", "old5", "photo"]);
    expect(rankReviews(all, { minStars: 1, withText: false })).toHaveLength(6);
  });
  it("takes products in turn and never more than 20", () => {
    const many = Array.from({ length: 30 }, (_, i) => rv({ name: `p1-${i}`, productHandle: "p1" }));
    const other = [rv({ name: "p2", productHandle: "p2" }), rv({ name: "gen" })];
    const out = selectReviews([...many, ...other]);
    expect(out).toHaveLength(20);
    expect(out.slice(0, 3).map((r) => r.name).sort()).toEqual(["gen", "p1-0", "p2"].sort());
  });
  it("replaces samples and earlier imports, keeps the merchant's own typed reviews", () => {
    const block = createBlock("reviews") as BlockOf<"reviews">;
    const own = rv({ name: "Moi", source: "manual" });
    const legacyOwn = rv({ name: "Ancien" }); // typed before sources existed
    const earlier = rv({ name: "Import 1", source: "csv" });
    const picked = [rv({ name: "Nouveau", source: "judgeme" })];
    const out = mergeImported([...block.props.items, own, legacyOwn, earlier], picked, isSampleReview);
    expect(out.map((r) => r.name)).toEqual(["Nouveau", "Moi", "Ancien"]);
  });
});

describe("overall rating", () => {
  it("averages all published reviews (not the selection)", () => {
    expect(ratingSummary([{ stars: 5 }, { stars: 4 }, { stars: 1 }], "csv", NOW)).toEqual({ score: 3.33, count: 3, source: "csv", asOf: "2026-09-28" });
    expect(ratingSummary([], "csv")).toBeNull();
  });
  it("weights Shopify's reviews.rating metafields by reviews.rating_count", () => {
    const s = shopifyRatingSummary([
      { rating: JSON.stringify({ value: "5.0", scale_min: "1.0", scale_max: "5.0" }), count: "30" },
      { rating: JSON.stringify({ value: "4.0", scale_min: "1.0", scale_max: "5.0" }), count: "10" },
      { rating: JSON.stringify({ value: "8", scale_min: "0", scale_max: "10" }), count: "10" },
      { rating: JSON.stringify({ value: "1.0", scale_max: "5.0" }), count: null }, // no weight: left out
      { rating: null, count: "5" },
    ], NOW);
    // 8 on 0–10 → 8 / 10 × 5 = 4 stars (proportional): (5×30 + 4×10 + 4×10) / 50.
    expect(s).toEqual({ score: 4.6, count: 50, source: "shopify", asOf: "2026-09-28" });
    expect(shopifyRatingSummary([{ rating: null, count: null }])).toBeNull();
  });
});

describe("per-cart order", () => {
  it("cart products first, then general reviews, then other products (stable)", () => {
    const items = [rv({ name: "other", productHandle: "b" }), rv({ name: "gen1" }), rv({ name: "mine", productId: "77" }), rv({ name: "gen2" }), rv({ name: "mine2", productHandle: "A" })];
    const cart = cartProductsOf([
      { productHandle: "a", productId: "gid://shopify/Product/77" },
      { productHandle: "gift", productId: "gid://shopify/Product/9", gift: true },
    ]);
    expect(cart).toEqual({ handles: ["a"], productIds: ["77"] });
    expect(orderReviewsForCart(items, cart).map((r) => r.name)).toEqual(["mine", "mine2", "gen1", "gen2", "other"]);
    expect(orderReviewsForCart(items, null)).toBe(items);
  });
});

describe("reviews block schema", () => {
  it("still loads blocks saved before the new fields", () => {
    const old = { id: "r1", type: "reviews", props: { title: "Avis", layout: "carousel", items: [{ name: "Léa", text: "Bien", stars: 5, verified: true }] } };
    expect(blockSchema.safeParse(old).success).toBe(true);
  });
  it("keeps the optional fields and drops a bad one without losing the review", () => {
    const b = {
      id: "r1",
      type: "reviews",
      props: {
        title: "Avis",
        layout: "auto",
        summary: { score: 4.8, count: 1234, source: "judgeme" },
        items: [
          { name: "Léa", text: "Bien", stars: 5, verified: true, title: "Top", date: "2025-01-02", photoUrl: "http://cdn.x/a.jpg", productHandle: "a", productId: "12", source: "csv" },
          { name: "Max", text: "Ok", stars: 4, verified: false, photoUrl: "javascript:alert(1)", date: "hier", source: "bogus" },
        ],
      },
    };
    const layout = loadCheckoutLayout({ blocks: [b] });
    const r = layout.blocks.find((x) => x.type === "reviews") as BlockOf<"reviews">;
    expect(r.props.summary).toEqual({ score: 4.8, count: 1234, source: "judgeme" });
    expect(r.props.items[0].photoUrl).toBe("https://cdn.x/a.jpg"); // https only
    expect(r.props.items[1]).toEqual({ name: "Max", text: "Ok", stars: 4, verified: false });
  });
  it("new blocks: sample reviews, never verified, hidden live, auto layout, first trust block of the palette", () => {
    const b = createBlock("reviews") as BlockOf<"reviews">;
    expect(b.props.layout).toBe("auto");
    expect(b.props.items.every((r) => !r.verified)).toBe(true);
    expect(isSampleOnly(b)).toBe(true);
    expect(CHECKOUT_PALETTE.indexOf("reviews")).toBeLessThan(CHECKOUT_PALETTE.indexOf("secure_badge"));
  });
  it("a blank review is never shown", () => {
    const b = createBlock("reviews") as BlockOf<"reviews">;
    b.props.items = [{ name: "", text: "  ", stars: 5, verified: false, source: "manual" }];
    expect(isSampleOnly(b)).toBe(true);
  });
  it("templates with reviews in the summary include nature-eco", () => {
    const t = CHECKOUT_TEMPLATES.find((x) => x.id === "nature-eco")!;
    expect(t.spec.some(([type]) => type === "reviews")).toBe(true);
  });
});

describe("reviews block rendering", () => {
  const ctx = (lang: Lang, preview = false, cartProducts: ContentContext["cartProducts"] = null): ContentContext => ({
    labels: labelsFor(lang),
    lang,
    lowestInventory: null,
    preview,
    subtotalCents: 0,
    freeShippingThresholdCents: null,
    money: (c) => String(c),
    note: "",
    setNote: () => {},
    cartProducts,
  });
  const block = (over: Partial<BlockOf<"reviews">["props"]>): BlockOf<"reviews"> => {
    const b = createBlock("reviews") as BlockOf<"reviews">;
    return { ...b, props: { ...b.props, layout: "stack", ...over } };
  };
  const html = (b: BlockOf<"reviews">, c: ContentContext) => renderToStaticMarkup(createElement(ContentBlock, { block: b, ctx: c }));

  it("shows summary, verified badge only when true, photo, title and date", () => {
    const b = block({
      summary: { score: 4.8, count: 1234, source: "csv" },
      items: [
        rv({ name: "Léa M.", title: "Top", verified: true, source: "csv", photoUrl: "https://cdn.x/a.jpg", date: "2025-03-12", productTitle: "Crème" }),
        rv({ name: "Max", verified: false }),
      ],
    });
    const fr = html(b, ctx("fr"));
    expect(fr).toContain("4,8/5");
    expect(fr).toMatch(/1\s234 avis/);
    // Badges only (the transparency line under the block also names « Achat vérifié »).
    expect(fr.split("data-imported-reviews-note")[0].match(/Achat vérifié/g)).toHaveLength(1);
    expect(fr).toContain("data-imported-reviews-note");
    expect(fr).toContain('src="https://cdn.x/a.jpg"');
    expect(fr).toContain('alt="Photo du client"');
    expect(fr).toContain("Top");
    expect(fr).toContain('dateTime="2025-03-12"');
    expect(fr).toContain("Crème");
    const en = html(b, ctx("en"));
    expect(en).toContain("4.8/5");
    expect(en).toContain("Verified purchase");
  });
  it("no summary without real data; sample reviews hidden live but visible in the builder", () => {
    const sample = block({});
    expect(isEmptyInLive(sample, ctx("fr"), NOW)).toBe(true);
    expect(html(sample, ctx("fr", true))).toContain("Camille R.");
    expect(html(block({ items: [rv({ name: "Vraie" })] }), ctx("fr"))).not.toContain("/5 ·");
  });
  it("list shows 3 reviews then a 'more' button; cart products first live", () => {
    const items = [rv({ name: "gen" }), rv({ name: "a1" }), rv({ name: "a2" }), rv({ name: "x", productHandle: "robe" })];
    const out = html(block({ items }), ctx("fr", false, { handles: ["robe"], productIds: [] }));
    expect(out.indexOf(">x<")).toBeLessThan(out.indexOf(">gen<"));
    expect(out).toContain("Voir 1 avis de plus");
    expect(out).not.toContain(">a2<");
  });
  it("auto layout renders a carousel for narrow columns and a list for wide ones", () => {
    const out = html(block({ layout: "auto", items: [rv({ name: "a" }), rv({ name: "b" })] }), ctx("fr"));
    expect(out).toContain("@md:hidden");
    expect(out).toContain("Avis suivant");
  });
});

describe("i18n labels", () => {
  it("every checkout language has the reviews labels", () => {
    for (const lang of LANGUAGES) {
      const L = labelsFor(lang);
      expect(L.verifiedPurchase, lang).toBeTruthy();
      expect(L.reviewPhoto, lang).toBeTruthy();
      expect(L.reviewsCount("3"), lang).toContain("3");
      expect(L.moreReviews(2), lang).toContain("2");
      expect(L.reviewsSummary("4,8", "12"), lang).toMatch(/4,8.*5.*12/);
    }
    expect(new Set(LANGUAGES.map((l) => labelsFor(l).moreReviews(2))).size).toBe(LANGUAGES.length);
  });
});
