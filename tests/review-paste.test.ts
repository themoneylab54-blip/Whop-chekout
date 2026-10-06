import { describe, expect, it } from "vitest";
import { findDate, looksLikeName, parsePastedReviews, parseRatingLine, pasteWarnings, roundedLabel, PASTE_PARSE_LIMIT } from "@/lib/review-paste";
import { REVIEW_LIMITS } from "@/lib/layout";

/*
 * « Coller des avis »: reviews pasted from a spreadsheet, an e-mail or a review page (Judge.me,
 * Trustpilot, Amazon, Shopify) become editable drafts. Never « Achat vérifié ».
 */

const NOW = new Date("2026-10-06T12:00:00Z");
const parse = (s: string) => parsePastedReviews(s, NOW);

describe("ratings", () => {
  it.each([
    ["★★★★★", 5],
    ["★★★★☆", 4],
    ["★★☆☆☆", 2],
    ["⭐⭐⭐⭐⭐", 5],
    ["⭐️⭐️⭐️", 3],
    ["*****", 5],
    ["5/5", 5],
    ["4/5", 4],
    ["4,5/5", 4],
    ["4.5 / 5", 4],
    ["9/10", 4],
    ["10/10", 5],
    ["5 étoiles", 5],
    ["1 étoile", 1],
    ["4 stars", 4],
    ["5 out of 5 stars", 5],
    ["5.0 out of 5 stars", 5],
    ["Rated 4 out of 5 stars", 4],
    ["Rated 5 out of 5", 5],
    ["4 sur 5", 4],
    ["Note : 4", 4],
    ["Note: 3/5", 3],
    ["Rating: 5", 5],
    ["Notée 5 sur 5", 5],
    ["5", 5],
    ["4,5", 4],
  ])("%s → %i", (line, stars) => {
    expect(parseRatingLine(line)?.stars).toBe(stars);
  });

  it.each(["Super produit", "12/03/2024", "2024-03-12", "0/5", "6", "J'ai acheté 2 paires", "Commande n°5", ""])("%s is not a rating", (line) => {
    expect(parseRatingLine(line)).toBeNull();
  });

  it("keeps what follows the rating (Amazon puts the title there)", () => {
    expect(parseRatingLine("5.0 out of 5 stars Exactly as described")).toEqual({ stars: 5, rest: "Exactly as described" });
    expect(parseRatingLine("★★★★★ - Parfait")).toEqual({ stars: 5, rest: "Parfait" });
  });
});

describe("dates", () => {
  it.each([
    ["2024-03-12", "2024-03-12"],
    ["12/03/2024", "2024-03-12"],
    ["03/25/2024", "2024-03-25"],
    ["12.03.2024", "2024-03-12"],
    ["12/03/24", "2024-03-12"],
    ["12 mars 2024", "2024-03-12"],
    ["1er février 2025", "2025-02-01"],
    ["3 août 2023", "2023-08-03"],
    ["March 12, 2024", "2024-03-12"],
    ["Mar 3, 2024", "2024-03-03"],
    ["12 March 2024", "2024-03-12"],
    ["Reviewed in the United States on March 3, 2024", "2024-03-03"],
    ["Publié le 5 janvier 2025", "2025-01-05"],
  ])("%s → %s", (line, iso) => {
    expect(findDate(line, NOW)?.date).toBe(iso);
  });

  it("refuses impossible and future dates", () => {
    expect(findDate("31/02/2024", NOW)).toBeNull();
    expect(findDate("12/03/2030", NOW)).toBeNull();
  });
});

describe("names", () => {
  it.each(["Marie D.", "Jean-Luc", "Sophie de M.", "Élodie", "O'Neil K."])("%s reads like a name", (s) => expect(looksLikeName(s)).toBe(true));
  it.each(["super produit", "J'adore !", "Très bon produit, je recommande vivement à tous", "Commande 123"])("%s does not", (s) => expect(looksLikeName(s)).toBe(false));
});

describe("blocks separated by blank lines", () => {
  it("reads name, stars and text, in French, with accents and emojis", () => {
    const { reviews, format } = parse(`Marie D.
★★★★★
Très contente de mon achat, livraison rapide 😍

Jean-Luc
4/5
Bonne qualité, un peu long à arriver.

— Élodie
Produit conforme, je recommande 👍`);
    expect(format).toBe("blocks");
    expect(reviews).toHaveLength(3);
    expect(reviews[0]).toMatchObject({ name: "Marie D.", stars: 5, starsGuessed: false, text: "Très contente de mon achat, livraison rapide 😍" });
    expect(reviews[1]).toMatchObject({ name: "Jean-Luc", stars: 4, text: "Bonne qualité, un peu long à arriver." });
    expect(reviews[2]).toMatchObject({ name: "Élodie", stars: 5, starsGuessed: true, text: "Produit conforme, je recommande 👍" });
  });

  it("signature at the end and text only", () => {
    const { reviews } = parse(`Super produit, mon fils l'adore.
— Paul R.

Livraison en 48 h, rien à redire.`);
    expect(reviews[0]).toMatchObject({ name: "Paul R.", text: "Super produit, mon fils l'adore.", starsGuessed: true });
    expect(reviews[1]).toMatchObject({ name: "", text: "Livraison en 48 h, rien à redire.", stars: 5, starsGuessed: true });
  });

  it("Windows line endings and blank lines made of spaces", () => {
    const { reviews } = parse("Marie D.\r\n5/5\r\nParfait.\r\n   \r\nPaul\r\n3/5\r\nMoyen.\r\n");
    expect(reviews.map((r) => [r.name, r.stars, r.text])).toEqual([
      ["Marie D.", 5, "Parfait."],
      ["Paul", 3, "Moyen."],
    ]);
  });

  it("title, date and multi-line text", () => {
    const { reviews } = parse(`Camille
★★★★☆
12/03/2025
Très bon rapport qualité-prix
La matière est agréable.
Taille un peu grand.`);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ name: "Camille", stars: 4, date: "2025-03-12", title: "Très bon rapport qualité-prix", text: "La matière est agréable.\nTaille un peu grand." });
  });

  it("drops the page's verified / helpful labels and never marks anything verified", () => {
    const { reviews } = parse(`Marie D.
Acheteur vérifié
★★★★★
Top !
Cet avis vous a-t-il été utile ?
Oui (3)
Signaler`);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ name: "Marie D.", stars: 5, text: "Top !" });
    expect(JSON.stringify(reviews)).not.toMatch(/vérifi|verified/i);
    expect("verified" in reviews[0]).toBe(false);
  });

  it("stars on the name line, and name above the stars across a blank line", () => {
    const { reviews } = parse(`Marie D. ★★★★
Bien mais un peu cher.

Paul

★★★★★
Parfait, merci.`);
    expect(reviews.map((r) => [r.name, r.stars, r.text])).toEqual([
      ["Marie D.", 4, "Bien mais un peu cher."],
      ["Paul", 5, "Parfait, merci."],
    ]);
  });

  it("a « Parfait » title is not taken for the reviewer", () => {
    const { reviews } = parse(`★★★★★
Parfait
Exactement ce que je cherchais, merci.`);
    expect(reviews[0]).toMatchObject({ name: "", title: "Parfait", text: "Exactement ce que je cherchais, merci." });
  });
});

describe("copied from review pages", () => {
  it("Judge.me widget", () => {
    const { reviews } = parse(`Sophie L.
Verified Buyer
★★★★★
03/02/2025
Je recommande
Très bonne qualité, conforme à la description.

Karim B.
Verified Buyer
★★★☆☆
01/02/2025
Correct
Un peu déçu par la couleur.`);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({ name: "Sophie L.", stars: 5, date: "2025-02-03", title: "Je recommande", text: "Très bonne qualité, conforme à la description." });
    expect(reviews[1]).toMatchObject({ name: "Karim B.", stars: 3, title: "Correct", text: "Un peu déçu par la couleur." });
  });

  it("Judge.me without blank lines between reviews", () => {
    const { reviews } = parse(`Sophie L.
Verified Buyer
★★★★★
Très bonne qualité, conforme à la description.
Karim B.
Verified Buyer
★★★☆☆
Un peu déçu par la couleur.`);
    expect(reviews.map((r) => [r.name, r.stars, r.text])).toEqual([
      ["Sophie L.", 5, "Très bonne qualité, conforme à la description."],
      ["Karim B.", 3, "Un peu déçu par la couleur."],
    ]);
  });

  it("Trustpilot", () => {
    const { reviews } = parse(`John Smith
US
• 3 reviews
Rated 5 out of 5 stars
Mar 3, 2025
Fast shipping and great quality
I ordered on Monday and it arrived on Wednesday. Love it!
Date of experience: March 1, 2025
Useful
Share

Anna K.
DE
• 1 review
Rated 2 out of 5 stars
Feb 20, 2025
Not as pictured
The color is much darker than on the website.
Date of experience: February 10, 2025`);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({ name: "John Smith", stars: 5, date: "2025-03-03", title: "Fast shipping and great quality", text: "I ordered on Monday and it arrived on Wednesday. Love it!" });
    expect(reviews[1]).toMatchObject({ name: "Anna K.", stars: 2, date: "2025-02-20", title: "Not as pictured" });
  });

  it("Amazon (title on the rating line)", () => {
    const { reviews } = parse(`Jennifer
5.0 out of 5 stars Exactly as described
Reviewed in the United States on January 5, 2025
Size: Medium Color: Blue
Verified Purchase
Fits perfectly and the fabric is soft. Would buy again.
12 people found this helpful
Helpful
Report

Mike T.
2.0 out of 5 stars Broke after a week
Reviewed in the United States on December 28, 2024
Verified Purchase
The zipper broke after a week of use.
Helpful
Report`);
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({ name: "Jennifer", stars: 5, title: "Exactly as described", date: "2025-01-05", text: "Fits perfectly and the fabric is soft. Would buy again." });
    expect(reviews[1]).toMatchObject({ name: "Mike T.", stars: 2, title: "Broke after a week", date: "2024-12-28", text: "The zipper broke after a week of use." });
  });

  it("Amazon.fr", () => {
    const { reviews } = parse(`Nathalie
5,0 sur 5 étoiles Très satisfaite
Commenté en France le 14 septembre 2025
Achat vérifié
Produit de qualité, arrivé en avance.
Une personne a trouvé cela utile
Signaler`);
    expect(reviews[0]).toMatchObject({ name: "Nathalie", stars: 5, title: "Très satisfaite", date: "2025-09-14", text: "Produit de qualité, arrivé en avance." });
  });

  it("Shopify Product Reviews (name and date on one line)", () => {
    const { reviews } = parse(`★★★★★
Love it
Emma W. on Jan 12, 2025
The best purchase I've made this year.

★★★★☆
Good value
Lucas M. on Dec 2, 2024
Works well, packaging could be better.`);
    expect(reviews.map((r) => [r.name, r.stars, r.title, r.date, r.text])).toEqual([
      ["Emma W.", 5, "Love it", "2025-01-12", "The best purchase I've made this year."],
      ["Lucas M.", 4, "Good value", "2024-12-02", "Works well, packaging could be better."],
    ]);
  });
});

describe("more real-world pastes", () => {
  it("relative dates and quoted texts", () => {
    const { reviews } = parse(`Sarah
★★★★★
il y a 3 jours
« Le meilleur achat de l'année ! »

Tom
⭐⭐⭐⭐
2 weeks ago
"Good, but the strap is short."`);
    expect(reviews.map((r) => [r.name, r.stars, r.text, r.title, r.date])).toEqual([
      ["Sarah", 5, "Le meilleur achat de l'année !", undefined, undefined],
      ["Tom", 4, "Good, but the strap is short.", undefined, undefined],
    ]);
  });

  it("stars and text on one line, one review per paragraph", () => {
    const { reviews } = parse(`★★★★★ Produit génial, je recommande à 100 %.

★★☆☆☆ Déçue, la taille ne correspond pas. — Julie`);
    expect(reviews[0]).toMatchObject({ stars: 5, text: "Produit génial, je recommande à 100 %.", name: "" });
    expect(reviews[1]).toMatchObject({ stars: 2, starsGuessed: false });
  });

  it("a « 5 étoiles » line and a « Note : 4 » line", () => {
    const { reviews } = parse(`Note : 4
Correct pour le prix.
Par Hélène

5 étoiles
Rien à redire.
— Marc`);
    expect(reviews.map((r) => [r.name, r.stars, r.text])).toEqual([
      ["Hélène", 4, "Correct pour le prix."],
      ["Marc", 5, "Rien à redire."],
    ]);
  });
});

describe("tables", () => {
  it("Nom;Note;Avis with a header", () => {
    const { reviews, format } = parse(`Nom;Note;Avis
Marie D.;5;Très bien, je recommande.
Paul;4;Bon produit; un peu cher.`);
    expect(format).toBe("table");
    expect(reviews).toEqual([
      { name: "Marie D.", stars: 5, starsGuessed: false, text: "Très bien, je recommande." },
      { name: "Paul", stars: 4, starsGuessed: false, text: "Bon produit; un peu cher." },
    ]);
  });

  it("without a header, columns in any order (tab-separated from a spreadsheet)", () => {
    const { reviews, format } = parse(`Super qualité, livraison rapide\tMarie D.\t5\t12/03/2025
"Bien, mais ""taille petit""
à prendre au-dessus"\tPaul\t3\t01/03/2025`);
    expect(format).toBe("table");
    expect(reviews[0]).toMatchObject({ name: "Marie D.", stars: 5, date: "2025-03-12", text: "Super qualité, livraison rapide" });
    expect(reviews[1]).toMatchObject({ name: "Paul", stars: 3, text: 'Bien, mais "taille petit"\nà prendre au-dessus' });
  });

  it("comma-separated with a header (name,rating,title,review,date)", () => {
    const { reviews } = parse(`name,rating,title,review,date
"Emma W.",5,"Love it","Great, really great.",2025-01-12`);
    expect(reviews[0]).toEqual({ name: "Emma W.", stars: 5, starsGuessed: false, title: "Love it", text: "Great, really great.", date: "2025-01-12" });
  });

  it("prose with semicolons stays prose", () => {
    const { format, reviews } = parse(`Bon produit ; livraison rapide ; je recommande.
Emballage soigné ; merci.`);
    expect(format).toBe("blocks");
    expect(reviews).toHaveLength(1);
  });
});

describe("limits and warnings", () => {
  it("parses 300+ reviews quickly and caps at PASTE_PARSE_LIMIT", () => {
    const one = (i: number) => `Client ${String.fromCharCode(65 + (i % 26))}.\n★★★★${i % 2 ? "★" : "☆"}\n${i % 3 ? "12/03/2025\n" : ""}Avis numéro ${i} : très bon produit, livraison rapide, je recommande à tous.`;
    const text = Array.from({ length: 1200 }, (_, i) => one(i)).join("\n\n");
    const t0 = performance.now();
    const { reviews, dropped } = parse(text);
    const ms = performance.now() - t0;
    expect(reviews).toHaveLength(PASTE_PARSE_LIMIT);
    expect(dropped).toBe(200);
    expect(reviews[0]).toMatchObject({ stars: 4, text: expect.stringContaining("Avis numéro 0") });
    expect(reviews[1]).toMatchObject({ stars: 5, date: "2025-03-12" });
    expect(ms).toBeLessThan(1500);
  });

  it("300 reviews pasted without anything but text and blank lines", () => {
    const text = Array.from({ length: 300 }, (_, i) => `Avis ${i} — très satisfait.`).join("\n\n");
    const { reviews } = parse(text);
    expect(reviews).toHaveLength(300);
    expect(reviews.every((r) => r.starsGuessed && r.stars === 5)).toBe(true);
  });

  it("cuts a too long text and says so", () => {
    const long = "é".repeat(REVIEW_LIMITS.text + 50);
    const { reviews } = parse(`Marie\n5/5\n${long}`);
    expect(reviews[0].text).toHaveLength(REVIEW_LIMITS.text);
    expect(reviews[0].cut).toBe(true);
    expect(pasteWarnings(reviews[0]).join(" ")).toMatch(/Coupé/);
    expect(pasteWarnings(reviews[0]).join(" ")).toMatch(/très long/);
  });

  it("warns about a missing rating, text or name", () => {
    expect(pasteWarnings({ name: "", text: "", starsGuessed: true })).toEqual([
      "Texte vide : l'avis ne sera pas affiché.",
      "Note non trouvée : 5 étoiles par défaut, à vérifier.",
      "Sans nom : affiché sans signature.",
    ]);
  });

  it("empty paste", () => {
    expect(parse("  \n\n \r\n")).toEqual({ reviews: [], dropped: 0, format: "blocks" });
  });
});

describe("one review per line, bullets, short reviews, figures inside a review, half stars", () => {
  const NOW = new Date("2026-01-01T00:00:00Z");
  const parse = (s: string) => parsePastedReviews(s, NOW).reviews;
  const brief = (s: string) => parse(s).map((r) => ({ name: r.name, text: r.text, stars: r.stars }));

  it("2.A rating and text on the same line, one review per line", () => {
    expect(brief("5/5 Super produit\n4/5 Bien\n3/5 Moyen")).toEqual([
      { name: "", text: "Super produit", stars: 5 },
      { name: "", text: "Bien", stars: 4 },
      { name: "", text: "Moyen", stars: 3 },
    ]);
    expect(brief("★★★★★ Génial — Marie\n★★★★★ Top — Lucas\n★★★★☆ Bien — Emma")).toEqual([
      { name: "Marie", text: "Génial", stars: 5 },
      { name: "Lucas", text: "Top", stars: 5 },
      { name: "Emma", text: "Bien", stars: 4 },
    ]);
    expect(brief("★★★★★ Livraison rapide, merci - Paul D.\n★★☆☆☆ Déçu")).toEqual([
      { name: "Paul D.", text: "Livraison rapide, merci", stars: 5 },
      { name: "", text: "Déçu", stars: 2 },
    ]);
    // A dash inside the text that isn't a signature stays in the text.
    expect(brief("★★★★★ Bien reçu — Rapide")).toEqual([{ name: "", text: "Bien reçu — Rapide", stars: 5 }]);
    // Amazon: the stars, then the rating line with its title: still one review.
    expect(parse("★★★★★\n5.0 out of 5 stars Parfait\nTrès bon produit.")).toHaveLength(1);
  });

  it("2.B « * » bullets are list items, not ratings", () => {
    expect(parseRatingLine("* Livraison rapide")).toBeNull();
    expect(parseRatingLine("*")).toMatchObject({ stars: 1, rest: "" });
    expect(parseRatingLine("** Bof")).toMatchObject({ stars: 2, rest: "Bof" });
    expect(parseRatingLine("***** Top", { asterisks: false })).toBeNull();
    // A list without any rating: one review per item, the markers dropped.
    const r = parse("* Livraison rapide\n* Produit conforme\n* Très bon");
    expect(r.map((x) => x.text)).toEqual(["Livraison rapide", "Produit conforme", "Très bon"]);
    expect(r.every((x) => x.starsGuessed)).toBe(true);
    // A paste using "* " bullets: no asterisk is read as a rating, even "**".
    const mixed = parse("Avis de Marie :\n* Livraison rapide\n** Très bon emballage");
    expect(mixed.every((x) => x.starsGuessed)).toBe(true);
    // Without bullets, asterisk ratings still work.
    expect(brief("*****\nParfait, je recommande.")).toEqual([{ name: "", text: "Parfait, je recommande.", stars: 5 }]);
  });

  it("2.C the next reviewer's « name » never takes the previous review's only text", () => {
    expect(brief("★★★★★\nNickel\n★★★★☆\nBien mais lent")).toEqual([
      { name: "", text: "Nickel", stars: 5 },
      { name: "", text: "Bien mais lent", stars: 4 },
    ]);
    // A real name above the stars, the previous review having its text: still the name.
    expect(brief("Marie\n★★★★★\nSuper produit\nPaul\n★★★★☆\nBien")).toEqual([
      { name: "Marie", text: "Super produit", stars: 5 },
      { name: "Paul", text: "Bien", stars: 4 },
    ]);
  });

  it("2.D « OK » is a review; a figure inside a review's text stays text", () => {
    expect(brief("★★★★★\nOK")).toEqual([{ name: "", text: "OK", stars: 5 }]);
    expect(brief("Marie\n★★★★★\nJ'ai commandé 2\n3\nboîtes et tout est arrivé.")).toEqual([
      { name: "Marie", text: "J'ai commandé 2\n3\nboîtes et tout est arrivé.", stars: 5 },
    ]);
    // A bare figure laid out as a rating (a name above, the text below) still is one.
    expect(brief("Marie\n5\nSuper produit\n\nPaul\n4\nBien")).toEqual([
      { name: "Marie", text: "Super produit", stars: 5 },
      { name: "Paul", text: "Bien", stars: 4 },
    ]);
    expect(brief("Marie\n5\nSuper produit\nPaul\n4\nBien")).toEqual([
      { name: "Marie", text: "Super produit", stars: 5 },
      { name: "Paul", text: "Bien", stars: 4 },
    ]);
    // Country codes are still page noise.
    expect(brief("Marie\nFR\n★★★★★\nTop")).toEqual([{ name: "Marie", text: "Top", stars: 5 }]);
  });

  it("2.E half stars: rounded down, and the preview says so", () => {
    expect(parse("★★★★½ Très bien")[0]).toMatchObject({ stars: 4, text: "Très bien", roundedFrom: 4.5 });
    expect(parse("4,5/5\nTrès bien")[0]).toMatchObject({ stars: 4, roundedFrom: 4.5 });
    expect(parse("9/10\nTrès bien")[0]).toMatchObject({ stars: 4, roundedFrom: 4.5 });
    expect(parse("5/5\nTrès bien")[0].roundedFrom).toBeUndefined();
    expect(parsePastedReviews("Nom;Note;Avis\nMarie;4,5;Très bien", NOW).reviews[0]).toMatchObject({ stars: 4, roundedFrom: 4.5 });
    expect(roundedLabel(4.5, 4)).toBe("arrondi (4,5 → 4)");
  });
});

describe("review round 2: names on the stars line, tables without header, verified labels, page noise", () => {
  const NOW = new Date("2026-01-01T00:00:00Z");
  const parse = (s: string) => parsePastedReviews(s, NOW).reviews;
  const brief = (s: string) => parse(s).map((r) => ({ name: r.name, text: r.text, stars: r.stars, ...(r.title ? { title: r.title } : {}) }));

  it("1. a name on the stars line is the reviewer, the text below is the review", () => {
    expect(brief("★★★★★ Marie\nSuper produit.")).toEqual([{ name: "Marie", text: "Super produit.", stars: 5 }]);
    expect(brief("5/5 Marie D.\nTrès bonne qualité, je recommande.")).toEqual([{ name: "Marie D.", text: "Très bonne qualité, je recommande.", stars: 5 }]);
    expect(brief("★★★★★ - Marie\nSuper produit.")).toEqual([{ name: "Marie", text: "Super produit.", stars: 5 }]);
    expect(brief("★★★★★ Marie\n\nTexte de l'avis")).toEqual([{ name: "Marie", text: "Texte de l'avis", stars: 5 }]);
    expect(brief("★★★★★ Marie\n\nTexte de l'avis\n\n★★★★☆ Paul\n\nBien")).toEqual([
      { name: "Marie", text: "Texte de l'avis", stars: 5 },
      { name: "Paul", text: "Bien", stars: 4 },
    ]);
    // A title on the stars line stays the title; a lone line stays the review.
    expect(brief("★★★★★ Parfait\nTrès bon produit.")).toEqual([{ name: "", text: "Très bon produit.", stars: 5, title: "Parfait" }]);
    expect(brief("★★★★★ Nickel\nArrivé vite.")).toEqual([{ name: "", text: "Arrivé vite.", stars: 5, title: "Nickel" }]);
    expect(brief("★★★★★ Marie")).toEqual([{ name: "", text: "Marie", stars: 5 }]);
    // A name above the stars wins.
    expect(brief("Sophie\n★★★★★ Absolument Ravie\nTexte.")[0].name).toBe("Sophie");
  });

  it("2. tables without header: the column of names, not the longest one", () => {
    expect(parsePastedReviews("Marie Dupont\t5\tTop\nPaul Martin\t4\tParfait", NOW).reviews.map((r) => [r.name, r.stars, r.text])).toEqual([
      ["Marie Dupont", 5, "Top"],
      ["Paul Martin", 4, "Parfait"],
    ]);
    expect(parsePastedReviews("Marie;5;Super", NOW).reviews.map((r) => [r.name, r.text])).toEqual([["Marie", "Super"]]);
    expect(parsePastedReviews("Super produit;5;Marie\nTrès bien;4;Paul", NOW).reviews.map((r) => [r.name, r.text])).toEqual([
      ["Marie", "Super produit"],
      ["Paul", "Très bien"],
    ]);
  });

  it("3. a verified label after a name is dropped, never kept as name or title, never verified", () => {
    for (const label of ["Verified Buyer", "Verified", "Acheteur vérifié", "Achat vérifié", "Avis vérifié"]) {
      const r = parse(`Marie D. ${label}\n★★★★★\nSuper produit.`);
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ name: "Marie D.", text: "Super produit.", stars: 5 });
      expect(r[0].title).toBeUndefined();
      expect(JSON.stringify(r[0])).not.toMatch(/verif|vérifi/i);
      expect(brief(`★★★★★ Marie ${label}\nSuper produit.`)).toEqual([{ name: "Marie", text: "Super produit.", stars: 5 }]);
    }
    expect(brief("Marie D. ★★★★★ Verified Buyer\nTop")).toEqual([{ name: "Marie D.", text: "Top", stars: 5 }]);
    expect(parse("Marie D. - Acheteur vérifié le 12 mars 2025\n★★★★★\nTop")[0]).toMatchObject({ name: "Marie D.", date: "2025-03-12" });
  });

  it("7. Google Reviews labels, relative dates, bullet lists, rating words inside the text, a date before the stars", () => {
    expect(brief("Marie Dupont\nLocal Guide · 12 avis · 3 photos\n★★★★★ il y a 2 semaines\nTrès bon accueil.")).toEqual([{ name: "Marie Dupont", text: "Très bon accueil.", stars: 5 }]);
    expect(brief("Marie Dupont · Local Guide · 12 avis\n★★★★★ il y a 2 semaines\nTrès bon accueil.")).toEqual([{ name: "Marie Dupont", text: "Très bon accueil.", stars: 5 }]);
    expect(brief("★★★★★ Marie · il y a 2 semaines\nTrès bon accueil.")).toEqual([{ name: "Marie", text: "Très bon accueil.", stars: 5 }]);
    expect(brief("★★★★☆ 2 weeks ago\nGreat")).toEqual([{ name: "", text: "Great", stars: 4 }]);
    // Bullets without ratings: one review per item.
    expect(brief("- Livraison rapide\n- Produit conforme")).toEqual([
      { name: "", text: "Livraison rapide", stars: 5 },
      { name: "", text: "Produit conforme", stars: 5 },
    ]);
    expect(parse("Avis clients :\n1. Très bon produit\n2. Je recommande\n3. Parfait").map((r) => r.text)).toEqual(["Très bon produit", "Je recommande", "Parfait"]);
    // With ratings, or a signature line, nothing changes.
    expect(brief("Super produit\n- Marie\n\nTrès bien\n- Paul")).toEqual([
      { name: "Marie", text: "Super produit", stars: 5 },
      { name: "Paul", text: "Très bien", stars: 5 },
    ]);
    // « 5 étoiles » inside the text stays in the text.
    expect(parse("Super produit.\n5 étoiles sans hésiter.")[0]).toMatchObject({ text: "Super produit.\n5 étoiles sans hésiter.", stars: 5, starsGuessed: false });
    expect(parse("★★★★☆\nSuper produit.\n5 étoiles !")).toEqual([expect.objectContaining({ text: "Super produit.\n5 étoiles !", stars: 4 })]);
    // A date, then the stars and the text.
    expect(parse("03/25/2025 ★★★★★ Great")[0]).toMatchObject({ date: "2025-03-25", stars: 5, text: "Great", starsGuessed: false });
    expect(parse("★★★★★ 12/03/2025\nSuper")[0]).toMatchObject({ date: "2025-03-12", text: "Super" });
  });
});
