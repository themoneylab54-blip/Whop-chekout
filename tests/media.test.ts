import { describe, expect, it } from "vitest";
import { checkMedia, dimensionsOk, imageDimensions, MAX_MEDIA_BYTES, mediaDeletable, mediaHeaders, mediaIdOf, mediaIdsIn, mediaPath, remapMediaIds } from "@/lib/media";
import { blockSchema, clearUrl, headerModeOf, loadCheckoutLayout, loadTheme, themeSchema } from "@/lib/layout";

/* Builder image uploads (lib/media.ts) and the header modes of the theme (logo / banner). */

/** A 1×1 PNG. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const png = (w: number, h: number) => {
  const b = Buffer.from(PNG);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const jpeg = (w: number, h: number) =>
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const gif = Buffer.from("GIF89a\x40\x01\xc8\x00\x00\x00", "latin1");
const webpVp8x = () => {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write("VP8X", 12, "latin1");
  b.writeUIntLE(1599, 24, 3);
  b.writeUIntLE(299, 27, 3);
  return b;
};

describe("checkMedia: magic bytes, types, size cap", () => {
  it("accepts real PNG / JPEG / WebP / GIF, from their bytes", () => {
    expect(checkMedia(PNG, "image/png")).toEqual({ ok: true, mime: "image/png" });
    expect(checkMedia(jpeg(10, 10), "image/jpeg")).toEqual({ ok: true, mime: "image/jpeg" });
    expect(checkMedia(jpeg(10, 10), "image/jpg")).toEqual({ ok: true, mime: "image/jpeg" });
    expect(checkMedia(webpVp8x(), "image/webp")).toEqual({ ok: true, mime: "image/webp" });
    expect(checkMedia(gif, "")).toEqual({ ok: true, mime: "image/gif" });
    expect(checkMedia(PNG, "application/octet-stream")).toEqual({ ok: true, mime: "image/png" });
  });

  it("refuses a declared type that disagrees with the bytes", () => {
    expect(checkMedia(PNG, "image/jpeg")).toEqual({ ok: false, error: "media_type" });
    expect(checkMedia(PNG, "text/html")).toEqual({ ok: false, error: "media_type" });
  });

  it("refuses SVG, HTML, HEIC and empty files", () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(checkMedia(svg, "image/svg+xml")).toEqual({ ok: false, error: "media_type" });
    expect(checkMedia(Buffer.from("<html><body>hi</body></html>"), "image/png")).toEqual({ ok: false, error: "media_type" });
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic", "latin1"), Buffer.alloc(16)]);
    expect(checkMedia(heic, "image/heic")).toEqual({ ok: false, error: "media_type" });
    expect(checkMedia(Buffer.alloc(0), "image/png")).toEqual({ ok: false, error: "media_empty" });
  });

  it("caps each image at 2 MB", () => {
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_MEDIA_BYTES - PNG.length + 1)]);
    expect(checkMedia(big, "image/png")).toEqual({ ok: false, error: "media_size" });
    expect(checkMedia(big.subarray(0, MAX_MEDIA_BYTES), "image/png").ok).toBe(true);
  });
});

describe("imageDimensions", () => {
  it("reads PNG, JPEG, GIF and WebP headers", () => {
    expect(imageDimensions(png(1600, 300), "image/png")).toEqual({ width: 1600, height: 300 });
    expect(imageDimensions(jpeg(800, 600), "image/jpeg")).toEqual({ width: 800, height: 600 });
    expect(imageDimensions(gif, "image/gif")).toEqual({ width: 320, height: 200 });
    expect(imageDimensions(webpVp8x(), "image/webp")).toEqual({ width: 1600, height: 300 });
  });
  it("skips JPEG fill bytes (any run of 0xFF before a marker)", () => {
    const j = jpeg(800, 600);
    const filled = Buffer.concat([j.subarray(0, 8), Buffer.from([0xff, 0xff, 0xff]), j.subarray(8)]);
    expect(imageDimensions(filled, "image/jpeg")).toEqual({ width: 800, height: 600 });
    const afterSoi = Buffer.concat([j.subarray(0, 2), Buffer.from([0xff, 0xff]), j.subarray(2)]);
    expect(imageDimensions(afterSoi, "image/jpeg")).toEqual({ width: 800, height: 600 });
  });
  it("returns null on a truncated header", () => {
    expect(imageDimensions(PNG.subarray(0, 12), "image/png")).toBeNull();
    expect(imageDimensions(Buffer.from([0xff, 0xd8, 0xff]), "image/jpeg")).toBeNull();
  });
});

describe("decoded-size caps", () => {
  it("refuses more than 6000 px wide or 25 megapixels", () => {
    expect(dimensionsOk({ width: 2400, height: 2400 })).toBe(true);
    expect(dimensionsOk({ width: 6000, height: 4166 })).toBe(true);
    expect(dimensionsOk({ width: 6001, height: 10 })).toBe(false);
    expect(dimensionsOk({ width: 5000, height: 5001 })).toBe(false);
    expect(dimensionsOk({ width: 100, height: 60000 })).toBe(true);
    expect(checkMedia(png(8000, 8000), "image/png").ok).toBe(true); // bytes check only; saveMedia checks pixels
  });
});

describe("media references in designs", () => {
  const a = "/api/public/media/cmaaaaaaaaaaaa";
  const b = "/api/public/media/cmbbbbbbbbbbbb";
  it("clearUrl empties every field showing an image, keeps the rest (and unchanged parts' identity)", () => {
    const untouched = { title: "x", items: [{ imageUrl: "https://cdn.example.com/p.png" }] };
    const design = { logoUrl: a, bannerUrl: b, blocks: [{ props: { url: a, alt: "a" } }, untouched] };
    const out = clearUrl(design, a);
    expect(out).toEqual({ logoUrl: "", bannerUrl: b, blocks: [{ props: { url: "", alt: "a" } }, untouched] });
    expect(out.blocks[1]).toBe(untouched);
    expect(clearUrl(design, "/api/public/media/cmzzzzzzzzzzzz")).toBe(design);
  });
  it("clearUrl and remapMediaIds also match the absolute address of an upload (any host)", () => {
    const abs = `https://app.example.com${a}`;
    const design = { logoUrl: abs, bannerUrl: `https://pay.shop.example${a}`, other: `https://cdn.example.com/x${a}`, near: `${abs}x` };
    expect(clearUrl(design, a)).toEqual({ logoUrl: "", bannerUrl: "", other: design.other, near: design.near });
    const map = new Map([["cmaaaaaaaaaaaa", "0123456789abcdef0123456789abcdef"]]);
    expect(remapMediaIds({ logoUrl: abs }, map)).toEqual({ logoUrl: "/api/public/media/0123456789abcdef0123456789abcdef" });
    expect([...mediaIdsIn({ logoUrl: abs, blocks: [{ props: { url: b } }], text: `see ${a}` })].sort()).toEqual(["cmaaaaaaaaaaaa", "cmbbbbbbbbbbbb"]);
  });
  it("a trailing slash, query or fragment still names the same upload (mediaIdOf, clearUrl, usage agree)", () => {
    const forms = [`${a}/`, `${a}?v=2`, `${a}#x`, `${a}/?v=2#x`, `https://app.example.com${a}?v=2`, `https://app.example.com${a}/`];
    for (const f of forms) {
      expect(mediaIdOf(f)).toBe("cmaaaaaaaaaaaa");
      expect(clearUrl({ logoUrl: f }, a)).toEqual({ logoUrl: "" });
      expect([...mediaIdsIn({ logoUrl: f })]).toEqual(["cmaaaaaaaaaaaa"]);
    }
    // Not the same image: a longer id, another path, a prefix before the host-less path.
    expect(mediaIdOf(`${a}b`)).toBe("cmaaaaaaaaaaaab");
    for (const f of [`${a}b`, `${a}/x`, `x${a}`, `https://cdn.example.com/x${a}?v=1`]) {
      if (f !== `${a}b`) expect(mediaIdOf(f)).toBeNull();
      expect(clearUrl({ logoUrl: f }, a)).toEqual({ logoUrl: f });
    }
  });
  it("letter case doesn't matter: mediaIdOf lowercases, clearUrl / mediaIdsIn / remapMediaIds agree", () => {
    const upper = `https://App.Example.com/API/Public/Media/CMAAAAAAAAAAAA?v=2`;
    expect(mediaIdOf(upper)).toBe("cmaaaaaaaaaaaa");
    expect(mediaIdOf("/api/public/media/CMAAAAAAAAAAAA")).toBe("cmaaaaaaaaaaaa");
    expect(clearUrl({ logoUrl: upper, bannerUrl: "/api/public/media/CMAAAAAAAAAAAA/" }, a)).toEqual({ logoUrl: "", bannerUrl: "" });
    expect([...mediaIdsIn({ logoUrl: upper })]).toEqual(["cmaaaaaaaaaaaa"]);
    const map = new Map([["cmaaaaaaaaaaaa", "0123456789abcdef0123456789abcdef"]]);
    expect(remapMediaIds({ logoUrl: upper }, map)).toEqual({ logoUrl: "/api/public/media/0123456789abcdef0123456789abcdef" });
  });
  it("remapMediaIds points a copied design to the copied images only", () => {
    const map = new Map([["cmaaaaaaaaaaaa", "0123456789abcdef0123456789abcdef"]]);
    const out = remapMediaIds({ logoUrl: a, bannerUrl: b, text: `see ${a}`, n: 3, list: [a] }, map);
    expect(out).toEqual({ logoUrl: "/api/public/media/0123456789abcdef0123456789abcdef", bannerUrl: b, text: `see ${a}`, n: 3, list: ["/api/public/media/0123456789abcdef0123456789abcdef"] });
    expect(mediaIdOf(out.logoUrl)).toBe("0123456789abcdef0123456789abcdef");
  });
  it("an image is deletable unless the live checkout shows it (saved versions: once confirmed)", () => {
    expect(mediaDeletable({ published: false, draft: true, versions: 0 })).toBe(true);
    expect(mediaDeletable({ published: true, draft: false, versions: 0 })).toBe(false);
    expect(mediaDeletable({ published: true, draft: false, versions: 0 }, true)).toBe(false);
    expect(mediaDeletable({ published: false, draft: false, versions: 2 })).toBe(false);
    expect(mediaDeletable({ published: false, draft: false, versions: 2 }, true)).toBe(true);
  });
});

describe("image fields: https only", () => {
  it("upgrades an http image saved before the rule instead of failing the design", () => {
    expect(themeSchema.parse({ logoUrl: "http://cdn.example.com/logo.png" }).logoUrl).toBe("https://cdn.example.com/logo.png");
    expect(loadTheme({ bannerUrl: "http://cdn.example.com/b.jpg", storeName: "S" }).bannerUrl).toBe("https://cdn.example.com/b.jpg");
    const layout = loadCheckoutLayout({ blocks: [{ id: "i1", type: "image", placement: "form", props: { url: "http://cdn.example.com/x.png", alt: "", size: "full" } }] });
    const img = layout.blocks.find((x) => x.type === "image");
    expect(img && img.type === "image" ? img.props.url : null).toBe("https://cdn.example.com/x.png");
  });
  it("trust-badge icons are image fields too: http upgraded, uploads and empty kept, other schemes refused", () => {
    const badges = (iconUrl: string) => blockSchema.safeParse({ id: "t", type: "trust_badges", placement: "form", props: { badges: [{ label: "Sécurisé", iconUrl }] } });
    const icon = (iconUrl: string) => {
      const r = badges(iconUrl);
      return r.success && r.data.type === "trust_badges" ? r.data.props.badges[0].iconUrl : null;
    };
    expect(icon("http://cdn.example.com/lock.png")).toBe("https://cdn.example.com/lock.png");
    expect(icon("/api/public/media/abcdef1234567890")).toBe("/api/public/media/abcdef1234567890");
    expect(icon("")).toBe("");
    expect(badges("javascript:alert(1)").success).toBe(false);
    expect(badges("ftp://cdn.example.com/lock.png").success).toBe(false);
  });
  it("still refuses non-web schemes and keeps link fields (policies, terms) on http(s)", () => {
    expect(themeSchema.safeParse({ logoUrl: "ftp://cdn.example.com/logo.png" }).success).toBe(false);
    expect(themeSchema.safeParse({ termsUrl: "http://shop.example.com/cgv" }).data?.termsUrl).toBe("http://shop.example.com/cgv");
    expect(blockSchema.safeParse({ id: "v", type: "video", placement: "form", props: { url: "http://video.example.com/v", caption: "" } }).success).toBe(true);
  });
});

describe("media URLs and headers", () => {
  it("builds and parses the public path", () => {
    expect(mediaPath("cmabc123def456")).toBe("/api/public/media/cmabc123def456");
    expect(mediaIdOf("/api/public/media/cmabc123def456")).toBe("cmabc123def456");
    expect(mediaIdOf("/api/public/media/../secret")).toBeNull();
    // An absolute address names the same upload (pasted from the app or checkout domain).
    expect(mediaIdOf("https://checkout.example.com/api/public/media/cmabc123def456")).toBe("cmabc123def456");
    expect(mediaIdOf("https://evil.example/x/api/public/media/cmabc123def456")).toBeNull();
    expect(mediaIdOf("javascript://x/api/public/media/cmabc123def456")).toBeNull();
  });
  it("serves images cacheable forever and inert", () => {
    const h = mediaHeaders("cmabc123def456", "image/png", 10);
    // s-maxage: Vercel's CDN keeps it too (max-age alone only reaches browsers).
    expect(h["Cache-Control"]).toBe("public, max-age=31536000, s-maxage=31536000, immutable");
    expect(h["CDN-Cache-Control"]).toBe("public, max-age=31536000, immutable");
    expect(h.ETag).toBe('"cmabc123def456"');
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Content-Disposition"]).toBe("inline");
    expect(h["Content-Security-Policy"]).toContain("default-src 'none'");
  });
});

describe("theme: header modes", () => {
  it("defaults keep today's header (store name, no banner)", () => {
    const t = themeSchema.parse({});
    expect(t.headerMode).toBeUndefined();
    expect(t.bannerUrl).toBe("");
    expect(t.bannerHeight).toBe(120);
    expect(t.bannerFit).toBe("cover");
    expect(t.bannerAuto).toBe(false);
    expect(t.bannerLink).toBe(false);
    expect(headerModeOf(t)).toBe("name");
  });

  it("a theme saved with a logo before the choice existed stays in logo mode", () => {
    const old = loadTheme({ storeName: "SEYUNA V2", logoUrl: "https://cdn.example.com/logo.png", logoHeight: 48 });
    expect(old.headerMode).toBeUndefined();
    expect(headerModeOf(old)).toBe("logo");
    expect(old.logoHeight).toBe(48);
  });

  it("explicit modes win; a banner without an image falls back", () => {
    const base = themeSchema.parse({ logoUrl: "https://cdn.example.com/logo.png" });
    expect(headerModeOf({ ...base, headerMode: "name" })).toBe("name");
    expect(headerModeOf({ ...base, headerMode: "banner" })).toBe("logo");
    expect(headerModeOf({ ...base, headerMode: "banner", logoUrl: "" })).toBe("name");
    expect(headerModeOf({ ...base, headerMode: "banner", bannerUrl: "/api/public/media/cmabc123def456" })).toBe("banner");
  });

  it("accepts an uploaded image path in image fields, never another relative URL", () => {
    expect(themeSchema.safeParse({ logoUrl: "/api/public/media/cmabc123def456" }).success).toBe(true);
    expect(themeSchema.safeParse({ bannerUrl: "/api/public/media/cmabc123def456" }).success).toBe(true);
    expect(themeSchema.safeParse({ bannerUrl: "/dashboard/logout" }).success).toBe(false);
    expect(themeSchema.safeParse({ bannerUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(themeSchema.safeParse({ bannerUrl: "//evil.example/x.png" }).success).toBe(false);
  });

  it("bounds the banner settings", () => {
    expect(themeSchema.safeParse({ bannerHeight: 59 }).success).toBe(false);
    expect(themeSchema.safeParse({ bannerHeight: 241 }).success).toBe(false);
    expect(themeSchema.safeParse({ bannerHeight: 240, bannerFit: "contain", bannerBackground: "#000000" }).success).toBe(true);
    expect(themeSchema.safeParse({ headerMode: "video" }).success).toBe(false);
    expect(themeSchema.safeParse({ bannerRatio: 0.5 }).success).toBe(false);
  });
});
