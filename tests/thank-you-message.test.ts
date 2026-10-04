// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement as h, type ComponentProps } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";

/*
 * Thank-you page « Message personnalisé » block (schema, rendering, translations, templates,
 * compatibility) and the page polish (animated check, « Expédiée » done once tracked).
 */

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }) }));
vi.mock("@whop/checkout/react", () => ({
  WhopCheckoutEmbed: () => null,
  WhopExpressCheckoutButton: () => null,
  useCheckoutEmbedControls: () => ({ current: null }),
}));
vi.mock("@/components/checkout/Payment", async (orig) => ({ ...(await orig<typeof import("@/components/checkout/Payment")>()), PaymentPanel: () => null }));

const { ThankYouView } = await import("@/components/checkout/ThankYouView");
const { ContentBlock, isEmptyInLive } = await import("@/components/checkout/blocks");
const {
  CHECKOUT_PALETTE,
  THANK_YOU_PALETTE,
  blockSchema,
  checkoutLayoutSchema,
  createBlock,
  defaultCheckoutLayout,
  defaultThankYouLayout,
  defaultTheme,
  loadCheckoutLayout,
  loadThankYouLayout,
  thankYouLayoutSchema,
} = await import("@/lib/layout");
const { THANK_YOU_TEMPLATES } = await import("@/components/builder/templates");
const { TranslationsEditor } = await import("@/components/builder/Translations");
const { MESSAGE_LIMITS, signedWithStore } = await import("@/lib/layout");
const { DEFAULT_TEXTS, localizeBlock, textFields } = await import("@/components/checkout/localize");
const { LABELS } = await import("@/components/checkout/i18n");
const { parseSimpleText, safeHref, withFirstName } = await import("@/lib/simple-text");
const { SAMPLE_LINES } = await import("@/lib/sample");

type Data = ComponentProps<typeof ThankYouView>["data"];
const LANGS = ["fr", "en", "de", "es", "it", "nl"] as const;

const data: Data = {
  status: "PAID",
  orderName: "#1024",
  email: "alex@exemple.fr",
  firstName: "Alex",
  address: { name: "Alex Martin", lines: ["12 rue des Lilas", "75011 Paris"], countryCode: "FR" },
  lines: SAMPLE_LINES,
  currency: "EUR",
  subtotalCents: 8988,
  discountCents: 0,
  shippingCents: 490,
  addOnsCents: 0,
  totalCents: 9478,
  continueUrl: null,
};

const liveCtx = (over: Partial<ComponentProps<typeof ContentBlock>["ctx"]> = {}): ComponentProps<typeof ContentBlock>["ctx"] => ({
  labels: LABELS.fr,
  lang: "fr",
  lowestInventory: null,
  preview: false,
  subtotalCents: 0,
  freeShippingThresholdCents: null,
  money: (c) => `${c}`,
  note: "",
  setNote: () => undefined,
  firstName: "Alex",
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("message block: schema", () => {
  it("is a thank-you palette block only, with valid defaults", () => {
    expect(THANK_YOU_PALETTE).toContain("message");
    expect(CHECKOUT_PALETTE).not.toContain("message");
    const b = createBlock("message");
    expect(b.props).toMatchObject({ photoShape: "round", layout: "left", photoUrl: "", signatureImageUrl: "" });
    expect(b.props.title).toBe("Un mot de notre équipe");
    expect(b.sample).toBeUndefined();
    // A new message reads as a card (palette, template); the other style options stay default.
    expect(b.style).toMatchObject({ card: true, background: "none", spacing: "default" });
    expect(createBlock("text").style.card).toBe(false);
    expect(thankYouLayoutSchema.safeParse({ blocks: [...defaultThankYouLayout().blocks, b] }).success).toBe(true);
  });

  it("is refused on the checkout (schema) and dropped by the checkout loader", () => {
    const b = createBlock("message");
    expect(checkoutLayoutSchema.safeParse({ blocks: [...defaultCheckoutLayout().blocks, b] }).success).toBe(false);
    expect(loadCheckoutLayout({ blocks: [...defaultCheckoutLayout().blocks, b] }).blocks.some((x) => x.type === "message")).toBe(false);
  });

  it("rejects unsafe or invalid values, fills missing fields with defaults", () => {
    const base = { id: "m1", type: "message" };
    // An unsafe image is dropped on its own (never kept, never failing the block).
    const unsafe = blockSchema.parse({ ...base, props: { photoUrl: "javascript:alert(1)", signatureImageUrl: "data:image/png;base64,xx" } });
    expect(unsafe.type === "message" && [unsafe.props.photoUrl, unsafe.props.signatureImageUrl]).toEqual(["", ""]);
    // A stray shape / layout falls back to the default on its own.
    const stray = blockSchema.parse({ ...base, props: { photoShape: "hexagon", layout: "right" } });
    expect(stray.type === "message" && [stray.props.photoShape, stray.props.layout]).toEqual(["round", "left"]);
    expect(blockSchema.safeParse({ ...base, props: { body: "x".repeat(2001) } }).success).toBe(false);
    // An uploaded image (relative media path) and an http address upgraded to https are accepted.
    const ok = blockSchema.parse({ ...base, props: { photoUrl: "/api/public/media/abcdef123456", signatureImageUrl: "http://cdn.example.com/sig.png" } });
    expect(ok.type === "message" && ok.props.signatureImageUrl).toBe("https://cdn.example.com/sig.png");
    expect(ok.type === "message" && ok.props.layout).toBe("left");
    // The shared style options apply.
    const styled = blockSchema.parse({ ...base, props: {}, style: { card: true, background: "brand" } });
    expect(styled.style.card).toBe(true);
  });

  it("a saved message with an invalid image keeps the merchant's text and style", () => {
    const props = {
      photoUrl: "javascript:alert(1)",
      signatureImageUrl: "ftp://old.example.com/sig.png",
      title: "Bienvenue {prénom}",
      body: "Mon **mot** à moi",
      signatureName: "Camille",
      signatureRole: "Fondatrice",
    };
    const loaded = loadThankYouLayout({ blocks: [{ id: "m1", type: "message", props }] });
    const m = loaded.blocks.find((b) => b.id === "m1");
    expect(m?.type === "message" && m.props).toMatchObject({ ...props, photoUrl: "", signatureImageUrl: "" });
    // Saved before cards were the default: the block keeps its own (flat) style.
    expect(m?.style.card).toBe(false);
  });

  it("signs a new message with the store name, never overwriting a signature", () => {
    const b = createBlock("message");
    expect(b.props.signatureName).toBe("");
    const signed = signedWithStore(b, "  Maison Lune ");
    expect(signed.type === "message" && signed.props.signatureName).toBe("Maison Lune");
    expect(signedWithStore(b, "x".repeat(200)).props).toMatchObject({ signatureName: "x".repeat(MESSAGE_LIMITS.signatureName) });
    expect(signedWithStore(signed, "Autre")).toBe(signed);
    expect(signedWithStore(b, "")).toBe(b);
    const text = createBlock("text");
    expect(signedWithStore(text, "Maison Lune")).toBe(text);
    expect(MESSAGE_LIMITS).toEqual({ title: 160, body: 2000, signatureName: 80, signatureRole: 80 });
    expect(blockSchema.safeParse({ id: "m", type: "message", props: { title: "x".repeat(161) } }).success).toBe(false);
  });

  it("a partly broken saved block is repaired on load, not dropped", () => {
    const raw = { blocks: [{ id: "m1", type: "message", props: { title: "Salut {name}", photoShape: "oval" } }] };
    const loaded = loadThankYouLayout(raw);
    const m = loaded.blocks.find((b) => b.id === "m1");
    expect(m?.type).toBe("message");
    if (m?.type === "message") {
      expect(m.props.title).toBe("Salut {name}");
      expect(m.props.photoShape).toBe("round");
    }
  });
});

describe("message block: compatibility", () => {
  it("existing saved thank-you layouts load unchanged", () => {
    const saved = JSON.parse(
      JSON.stringify({
        blocks: [
          createBlock("text", { id: "t1", position: "above" }),
          ...defaultThankYouLayout().blocks,
          createBlock("coupon", { id: "c1" }),
          createBlock("social", { id: "s1" }),
        ],
      }),
    );
    const loaded = loadThankYouLayout(saved);
    expect(loaded).toEqual(saved);
    expect(loadThankYouLayout(null)).toEqual(defaultThankYouLayout());
    // Layouts saved before the sections were blocks: unchanged rule.
    const old = loadThankYouLayout({ blocks: [{ id: "x", type: "text", position: "above", props: { heading: "Hi", body: "" } }] });
    expect(old.blocks.map((b) => b.type)).toEqual(["text", "ty_confirmation", "ty_details", "ty_summary"]);
  });
});

describe("simple formatting", () => {
  it("parses paragraphs, line breaks, bold and safe links only", () => {
    const p = parseSimpleText("Bonjour **Alex**\nligne 2\n\n[Notre site](https://example.com/a?b=1) et https://shop.example.com/x.\n\n[piège](javascript:alert(1)) <b>x</b>");
    expect(p).toHaveLength(3);
    expect(p[0]).toEqual([{ kind: "text", text: "Bonjour " }, { kind: "bold", text: "Alex" }, { kind: "br" }, { kind: "text", text: "ligne 2" }]);
    expect(p[1]).toEqual([
      { kind: "link", text: "Notre site", href: "https://example.com/a?b=1" },
      { kind: "text", text: " et " },
      { kind: "link", text: "https://shop.example.com/x", href: "https://shop.example.com/x" },
      { kind: "text", text: "." },
    ]);
    // javascript: keeps only its words; HTML stays text.
    expect(p[2].every((x) => x.kind === "text")).toBe(true);
    expect(safeHref("mailto:hello@shop.fr")).toBe("mailto:hello@shop.fr");
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref("JavaScript:alert(1)")).toBeNull();
    expect(p[2].map((x) => (x.kind === "text" ? x.text : "")).join("")).toBe("piège <b>x</b>");
  });

  const flat = (pieces: ReturnType<typeof parseSimpleText>[number]) => pieces.map((x) => (x.kind === "br" ? "\n" : x.text)).join("");
  const links = (text: string) => parseSimpleText(text).flat().filter((x) => x.kind === "link");

  it("links work inside bold, and **…** inside a link label makes it bold", () => {
    expect(parseSimpleText("**Voir [le site](https://shop.example.com) vite**")[0]).toEqual([
      { kind: "bold", text: "Voir " },
      { kind: "link", text: "le site", href: "https://shop.example.com", bold: true },
      { kind: "bold", text: " vite" },
    ]);
    expect(parseSimpleText("**https://shop.example.com/a**")[0]).toEqual([{ kind: "link", text: "https://shop.example.com/a", href: "https://shop.example.com/a", bold: true }]);
    expect(parseSimpleText("[**gras**](https://a.example.com) fin")[0]).toEqual([
      { kind: "link", text: "gras", href: "https://a.example.com", bold: true },
      { kind: "text", text: " fin" },
    ]);
    // An unclosed ** stays as typed.
    expect(parseSimpleText("2 ** 3 = 8")[0]).toEqual([{ kind: "text", text: "2 ** 3 = 8" }]);
  });

  it("keeps balanced parentheses in addresses, not a closing one around them", () => {
    expect(links("[Wiki](https://fr.wikipedia.org/wiki/Lune_(satellite))")).toEqual([
      { kind: "link", text: "Wiki", href: "https://fr.wikipedia.org/wiki/Lune_(satellite)" },
    ]);
    const bare = parseSimpleText("Lire https://fr.wikipedia.org/wiki/Lune_(satellite). Ou (voir https://shop.example.com/a).")[0];
    expect(bare.filter((x) => x.kind === "link").map((x) => x.kind === "link" && x.href)).toEqual([
      "https://fr.wikipedia.org/wiki/Lune_(satellite)",
      "https://shop.example.com/a",
    ]);
    expect(flat(bare)).toBe("Lire https://fr.wikipedia.org/wiki/Lune_(satellite). Ou (voir https://shop.example.com/a).");
  });

  it("an unsafe link shows only its label, never a link nor the raw markdown", () => {
    for (const target of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(document.cookie)",
      "javascript:alert('a b')",
      "data:text/html;base64,PHNjcmlwdD4=",
      "//evil.example.com",
      "https:evil.example.com",
      "/relative",
      "vbscript:x",
      "javascript:alert(<b>1</b>)",
    ]) {
      const p = parseSimpleText(`Avant [cliquez](${target}) après`);
      expect(p[0], target).toEqual([{ kind: "text", text: "Avant cliquez après" }]);
    }
    expect(links("https:evil.example.com //evil.example.com javascript:alert(1) http://")).toEqual([]);
    expect(safeHref("https:evil.example.com")).toBeNull();
    expect(safeHref("//evil.example.com")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
  });

  it("parses pathological input quickly", () => {
    const inputs = [
      "[".repeat(2000),
      "[a](".repeat(500),
      "*".repeat(2000),
      "** ".repeat(666),
      "https://a.example.com/" + "(".repeat(1970),
      "[x](https://a.example.com/" + "(".repeat(1970),
      ("[" + "a".repeat(199) + "](").repeat(9),
      "https://".repeat(250),
    ];
    const t0 = performance.now();
    for (const input of inputs) {
      for (let k = 0; k < 5; k++) parseSimpleText(input);
    }
    expect(performance.now() - t0).toBeLessThan(500);
    // Nothing is lost: every character is still there as text.
    expect(flat(parseSimpleText("[".repeat(50))[0])).toBe("[".repeat(50));
  });

  it("puts the first name in the title, or drops the placeholder cleanly", () => {
    expect(withFirstName("Merci du fond du cœur, {prénom} !", "Alex")).toBe("Merci du fond du cœur, Alex !");
    expect(withFirstName("Hi {name}, thanks", "Sam")).toBe("Hi Sam, thanks");
    expect(withFirstName("Merci du fond du cœur, {prénom} !", "")).toBe("Merci du fond du cœur !");
    expect(withFirstName("Thank you, {prénom}!", "  ")).toBe("Thank you!");
    expect(withFirstName("{prenom}, merci !", null)).toBe("Merci !");
  });

  it("inserts the first name as typed: $-patterns in a name are never interpreted", () => {
    expect(withFirstName("Bonjour {prénom} !", "$&")).toBe("Bonjour $& !");
    expect(withFirstName("Bonjour {prénom} !", "$'x$`")).toBe("Bonjour $'x$` !");
    expect(withFirstName("{name} & {prénom}", "$1$$")).toBe("$1$$ & $1$$");
  });

  it("the default title is no second « merci » under the page's H1 (all 6 languages), and has no placeholder", () => {
    expect(createBlock("message").props.title).toBe(DEFAULT_TEXTS.fr.messageTitle);
    for (const lang of LANGS) {
      const t = DEFAULT_TEXTS[lang].messageTitle;
      expect(t, lang).not.toMatch(/merci|thank|dank|gracias|grazie|bedankt/i);
      expect(t, lang).not.toContain("{");
      expect(withFirstName(t, "Alex"), lang).toBe(t);
    }
  });
});

describe("message block: rendering", () => {
  it("shows photo, title with first name, bold, safe links and signature (never raw HTML)", () => {
    const b = createBlock("message", {
      props: {
        photoUrl: "https://cdn.example.com/me.jpg",
        photoShape: "square",
        layout: "top",
        title: "Merci {prénom} !",
        body: 'Un **grand** merci.\n\nVoir [la boutique](https://shop.example.com) ou [écrire](mailto:hi@shop.fr).\n\n<img src=x onerror="alert(1)"> [x](javascript:alert(1))',
        signatureName: "Camille Martin",
        signatureRole: "Fondatrice",
        signatureImageUrl: "https://cdn.example.com/sig.png",
      },
    } as never);
    const { container } = render(h(ContentBlock, { block: b, ctx: liveCtx() }));
    expect(screen.getByRole("heading", { name: "Merci Alex !" })).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("grand");
    const shop = screen.getByRole("link", { name: "la boutique" });
    expect(shop.getAttribute("href")).toBe("https://shop.example.com");
    expect(shop.getAttribute("target")).toBe("_blank");
    expect(shop.getAttribute("rel")).toContain("noopener");
    expect(screen.getByRole("link", { name: "écrire" }).getAttribute("target")).toBeNull();
    expect(container.querySelectorAll("a")).toHaveLength(2);
    expect(container.querySelector("img[onerror]")).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror="alert(1)">');
    expect(container.querySelectorAll("p")).toHaveLength(3);
    const imgs = Array.from(container.querySelectorAll("img"));
    expect(imgs.map((i) => i.getAttribute("src"))).toEqual(["https://cdn.example.com/me.jpg", "https://cdn.example.com/sig.png"]);
    expect(imgs[0].getAttribute("alt")).toBe("Camille Martin");
    expect(imgs[0].className).not.toContain("rounded-full");
    expect(container.querySelector("[data-message-layout]")?.getAttribute("data-message-layout")).toBe("top");
    // Images: intrinsic size (no layout shift), loaded lazily.
    expect(imgs.map((i) => [i.getAttribute("width"), i.getAttribute("height"), i.getAttribute("loading"), i.getAttribute("decoding")])).toEqual([
      ["80", "80", "lazy", "async"],
      ["180", "40", "lazy", "async"],
    ]);
    // Valid HTML: no <figcaption> outside a <figure>'s direct children.
    container.querySelectorAll("figcaption").forEach((c) => expect(c.parentElement?.tagName).toBe("FIGURE"));
    const caption = container.querySelector("[data-message-signature]") as HTMLElement;
    expect(within(caption).getByText("Camille Martin")).toBeTruthy();
    expect(within(caption).getByText("Fondatrice")).toBeTruthy();
  });

  it("left layout: a 56px photo; an empty signature name leaves a decorative photo and no empty name", () => {
    const b = createBlock("message", { props: { ...createBlock("message").props, photoUrl: "https://cdn.example.com/me.jpg", signatureName: "  " } } as never);
    const { container } = render(h(ContentBlock, { block: b, ctx: liveCtx({ firstName: "" }) }));
    const img = container.querySelector("img")!;
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["56", "56"]);
    expect(img.getAttribute("alt")).toBe("");
    const sig = container.querySelector("[data-message-signature]")!;
    expect(sig.children).toHaveLength(1);
    expect(sig.textContent).toBe("L'équipe");
    expect(screen.getByRole("heading").textContent).toBe("Un mot de notre équipe");
  });

  it("a long bare address wraps inside the card instead of widening it (360px)", () => {
    const b = createBlock("message", { props: { ...createBlock("message").props, body: "https://shop.example.com/" + "a".repeat(120) } } as never);
    const { container } = render(h(ContentBlock, { block: b, ctx: liveCtx() }));
    const col = container.querySelector("[data-message-text]") as HTMLElement;
    expect(col.className).toContain("min-w-0");
    expect(col.className).toContain("wrap-anywhere");
    expect(col.querySelector("a")?.textContent).toHaveLength(145);
  });

  it("renders a bold link as a link inside <strong>", () => {
    const b = createBlock("message", { props: { ...createBlock("message").props, body: "**Voir [la boutique](https://shop.example.com)**" } } as never);
    const { container } = render(h(ContentBlock, { block: b, ctx: liveCtx() }));
    const a = screen.getByRole("link", { name: "la boutique" });
    expect(a.closest("strong")).toBeTruthy();
    expect(container.querySelectorAll("strong")).toHaveLength(2);
  });

  it("live: no photo means no photo slot; an empty block is skipped, the builder shows it", () => {
    const b = createBlock("message");
    const { container } = render(h(ContentBlock, { block: b, ctx: liveCtx() }));
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("Photo");
    cleanup();
    const preview = render(h(ContentBlock, { block: b, ctx: liveCtx({ preview: true }) }));
    expect(preview.container.textContent).toContain("Photo");
    const empty = createBlock("message", { props: { ...b.props, title: "", body: "", signatureRole: "" } } as never);
    expect(isEmptyInLive(empty, liveCtx(), 0)).toBe(true);
    expect(isEmptyInLive(empty, liveCtx({ preview: true }), 0)).toBe(false);
    expect(isEmptyInLive(b, liveCtx(), 0)).toBe(false);
  });

  it("default text is translated in all 6 languages, with the buyer's first name, on the thank-you page", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const layout = { blocks: [...defaultThankYouLayout().blocks.slice(0, 1), createBlock("message", { id: "msg" }), ...defaultThankYouLayout().blocks.slice(1)] };
    for (const lang of LANGS) {
      const T = DEFAULT_TEXTS[lang];
      expect(T.messageBody, lang).toMatch(/\*\*.+\*\*/);
      const { container } = render(h(ThankYouView, { theme: { ...defaultTheme("Boutique"), language: lang }, layout, data }));
      const block = container.querySelector('[data-block-id="msg"]') as HTMLElement;
      expect(block, lang).toBeTruthy();
      expect(within(block).getByRole("heading").textContent, lang).toBe(T.messageTitle);
      const bold = T.messageBody.match(/\*\*(.+?)\*\*/)![1];
      expect(block.querySelector("strong")?.textContent, lang).toBe(bold);
      expect(block.textContent, lang).toContain(T.messageRole);
      if (lang !== "fr") expect(block.textContent, lang).not.toContain("Merci");
      cleanup();
    }
  });

  it("a merchant translation wins; the signature name is never translated", () => {
    const b = createBlock("message", { i18n: { en: { title: "Cheers {name}!", signatureRole: "Founder" } } } as never);
    const paths = textFields(b.props).map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["title", "body", "signatureRole"]));
    expect(paths).not.toContain("signatureName");
    const en = localizeBlock(b, "en");
    expect(en.type === "message" && en.props.title).toBe("Cheers {name}!");
    expect(en.type === "message" && en.props.signatureRole).toBe("Founder");
    expect(en.type === "message" && en.props.body).toBe(DEFAULT_TEXTS.en.messageBody);
  });
});

describe("thank-you title", () => {
  it("drops {prénom} cleanly when the buyer has no first name", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const layout = { blocks: defaultThankYouLayout().blocks.map((b) => (b.type === "ty_confirmation" ? { ...b, props: { ...b.props, title: "Merci {prénom} !" } } : b)) };
    render(h(ThankYouView, { theme: defaultTheme("Boutique"), layout, data: { ...data, firstName: "" } }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Merci !");
    cleanup();
    render(h(ThankYouView, { theme: defaultTheme("Boutique"), layout, data }));
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Merci Alex !");
  });

  it("German default title", () => {
    expect(DEFAULT_TEXTS.de.messageTitle).toBe("Ein paar Worte von unserem Team");
  });
});

describe("message block: builder", () => {
  it("caps the message inputs at the schema's limits", async () => {
    const { BlockContentEditor } = await import("@/components/builder/BlockEditor");
    const b = createBlock("message");
    const { container } = render(h(BlockContentEditor, { block: b, onChange: () => undefined }));
    const caps = (sel: string) => Array.from(container.querySelectorAll(sel)).map((el) => el.getAttribute("maxlength"));
    expect(caps("textarea")).toEqual(["2000"]);
    expect(caps('input:not([type]), input[type="text"]').filter(Boolean)).toEqual(expect.arrayContaining(["160", "80", "80"]));
    expect((container.querySelector('input[placeholder="ex. Bienvenue parmi nous, {prénom} !"]') as HTMLInputElement).maxLength).toBe(160);
  });

  it("the Translations tab tells to keep {prénom} in the message title only, when the title uses it", () => {
    const base = createBlock("message", { id: "m1" });
    const b = { ...base, props: { ...base.props, title: "Bienvenue, {prénom} !" } };
    render(h(TranslationsEditor, { block: b, baseLang: "fr", onChange: () => undefined }));
    const hint = screen.getByText(/Gardez \{prénom\}/);
    const described = document.querySelectorAll(`[aria-describedby="${hint.id}"]`);
    expect(described).toHaveLength(1);
    expect(document.querySelectorAll("[aria-describedby]")).toHaveLength(1);
    cleanup();
    // The shipped title has no placeholder: no hint to keep one.
    render(h(TranslationsEditor, { block: base, baseLang: "fr", onChange: () => undefined }));
    expect(screen.queryByText(/Gardez \{prénom\}/)).toBeNull();
  });
});

describe("message block: templates", () => {
  it("Simple and Fidélisation include it, right after the confirmation, and build valid layouts", () => {
    for (const id of ["simple", "loyalty"]) {
      const t = THANK_YOU_TEMPLATES.find((x) => x.id === id)!;
      expect(t.spec.map(([type]) => type).slice(0, 2), id).toEqual(["ty_confirmation", "message"]);
      expect(t.summary, id).toContain("Message personnalisé");
      const built = t.build(defaultThankYouLayout());
      expect(thankYouLayoutSchema.safeParse(built).success, id).toBe(true);
      expect(built.blocks.filter((b) => b.type === "message"), id).toHaveLength(1);
      // Reapplying keeps the merchant's message (reused, not duplicated).
      const mine = built.blocks.map((b) => (b.type === "message" ? { ...b, props: { ...b.props, body: "Mon mot" } } : b));
      const again = t.build({ blocks: mine });
      const m = again.blocks.filter((b) => b.type === "message");
      expect(m).toHaveLength(1);
      expect(m[0].type === "message" && m[0].props.body).toBe("Mon mot");
    }
  });

  it("a message created by a template is a card signed with the store name; a reused one keeps its signature", () => {
    const t = THANK_YOU_TEMPLATES.find((x) => x.id === "simple")!;
    const m = t.build(defaultThankYouLayout(), { storeName: "Maison Lune" }).blocks.find((b) => b.type === "message")!;
    expect(m.type === "message" && m.props.signatureName).toBe("Maison Lune");
    expect(m.style.card).toBe(true);
    expect(t.build(defaultThankYouLayout()).blocks.find((b) => b.type === "message")?.props).toMatchObject({ signatureName: "" });
    const mine = { blocks: [...defaultThankYouLayout().blocks, createBlock("message", { props: { ...createBlock("message").props, signatureName: "Camille" } } as never)] };
    const again = t.build(mine, { storeName: "Maison Lune" }).blocks.find((b) => b.type === "message");
    expect(again?.props).toMatchObject({ signatureName: "Camille" });
  });
});

describe("thank-you page polish", () => {
  const timelineSteps = (container: HTMLElement) => Array.from(container.querySelectorAll("ol > li"));

  it("draws the animated check and marks only « Commandée » done without tracking", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const { container } = render(h(ThankYouView, { theme: defaultTheme("Boutique"), layout: defaultThankYouLayout(), data }));
    expect(screen.getByTestId("wc-ty-check").querySelector("svg path.wc-check-mark")).toBeTruthy();
    const steps = timelineSteps(container);
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.hasAttribute("data-step-done"))).toEqual([true, false, false]);
    expect(steps[0].getAttribute("aria-current")).toBe("step");
  });

  it("a tracking number marks « Expédiée » done and current", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    const { container } = render(
      h(ThankYouView, { theme: defaultTheme("Boutique"), layout: defaultThankYouLayout(), data: { ...data, tracking: { number: "6A123456789", url: "https://track.example.com/6A" } } }),
    );
    const steps = timelineSteps(container);
    expect(steps.map((s) => s.hasAttribute("data-step-done"))).toEqual([true, true, false]);
    expect(steps[1].getAttribute("aria-current")).toBe("step");
    expect(steps[0].getAttribute("aria-current")).toBeNull();
    expect(steps[1].textContent).toContain(LABELS.fr.stepShipped);
    expect(steps[1].textContent).toContain(LABELS.fr.stepDone);
  });
});
