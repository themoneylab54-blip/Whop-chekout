import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { footerLines, WHOP_FOOTER, whopFooterFit, withTextScaled } from "@/components/checkout/whopFooterFit";

/*
 * « Propulsé par Whop » clipped off Whop's card form. The geometry (components/checkout/whopFooterFit)
 * against Whop's footer as measured in Chromium (Whop's Inter, 12 px): per language, the frame width
 * from which the footer holds on one line, and below which it needs three; one line clips 55 px, two
 * lines 86 px; a width too close to a wrap point narrows the frame (a few px) to a sure answer, sure
 * also with the fonts Whop's page falls back on while Inter loads (measured too). The server's check
 * (lib/whop-footer) lets a store's checkout clip only when the store chose it and Whop's own page for
 * that store's card form (captured from Whop in every language, with and without its terms line and
 * pay button, with the card kept for an offer) draws that footer exactly, last in the form.
 */

const mocks = vi.hoisted(() => ({
  findSetting: vi.fn<(args: { where: { key: string } }) => Promise<{ key: string; value: string } | null>>(async () => null),
  findSettings: vi.fn<(args: unknown) => Promise<{ key: string; value: string }[]>>(async () => []),
  updateMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })),
  createMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 1 })),
  upsert: vi.fn<(args: unknown) => Promise<object>>(async () => ({})),
  deleteMany: vi.fn<(args: unknown) => Promise<{ count: number }>>(async () => ({ count: 0 })),
  findQuote: vi.fn<(args: unknown) => Promise<{ whopCheckoutId: string | null; fingerprint: string } | null>>(async () => ({ whopCheckoutId: "ch_1", fingerprint: "q|h:x" })),
  warn: vi.fn(),
  info: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    appSetting: { findUnique: mocks.findSetting, findMany: mocks.findSettings, updateMany: mocks.updateMany, createMany: mocks.createMany, upsert: mocks.upsert, deleteMany: mocks.deleteMany },
    checkoutQuote: { findFirst: mocks.findQuote },
  },
}));
vi.mock("@/lib/log", () => ({ log: { info: mocks.info, warn: mocks.warn, error: vi.fn() }, recordEvent: vi.fn() }));

const { footerVerdict, forgetWhopFooterVerdicts, refreshWhopFooterCheck, verdictClips, whopFooterClipped, whopFooterVerdicts } = await import("@/lib/whop-footer");

/** Whop's footer as measured (Chromium): the wrap points (frame px) per language. */
const WRAPS: Record<string, { oneLineFrom: number; twoLinesFrom: number }> = {
  fr: { oneLineFrom: 364, twoLinesFrom: 191 },
  en: { oneLineFrom: 294, twoLinesFrom: 167 },
  de: { oneLineFrom: 390, twoLinesFrom: 211 },
  es: { oneLineFrom: 343, twoLinesFrom: 181 },
  it: { oneLineFrom: 300, twoLinesFrom: 167 },
  nl: { oneLineFrom: 372, twoLinesFrom: 205 },
};
const LANGS = Object.keys(WRAPS) as (keyof typeof WHOP_FOOTER)[];
/**
 * Whop's footer items measured in Whop's own CSS with the fonts its page falls back on while Inter
 * loads: « Inter Fallback » (Arial, size-adjust 107.12 %: measured with Liberation Sans, Arial's
 * metric twin) and Roboto (Android, where there is no Arial).
 */
const FALLBACKS: Record<string, Record<string, number[]>> = {
  arial: { fr: [140.84, 1, 60.77, 81.52], en: [135.83, 1, 35, 42.17], de: [161.58, 1, 75.8, 71.48], es: [149.42, 1, 53.59, 60.05], it: [135.83, 1, 41.45, 42.17], nl: [173.73, 1, 75.78, 42.17] },
  roboto: { fr: [134.92, 1, 57.56, 77.75], en: [129.55, 1, 33.77, 38.83], de: [154.17, 1, 69.95, 66.98], es: [144.45, 1, 50.19, 56.16], it: [129.55, 1, 40.06, 38.83], nl: [164.78, 1, 71.09, 38.83] },
};
/** Whop's frame on common screens (our checkout's column: the screen's width less 42 px), then a desktop column. */
const FRAMES = [278, 318, 333, 348, 351, 370, 372, 386, 388, 470, 518];

describe("whopFooterFit: the footer's height from the frame's width", () => {
  it("lines as Whop's page wraps them, at every measured wrap point", () => {
    for (const lang of LANGS) {
      const { widths } = WHOP_FOOTER[lang];
      const m = WRAPS[lang];
      expect(footerLines(widths, m.oneLineFrom - 32).lines, `${lang} one line`).toBe(1);
      expect(footerLines(widths, m.oneLineFrom - 1 - 32).lines, `${lang} two lines`).toBe(2);
      if (lang === "fr" || lang === "de") {
        expect(footerLines(widths, m.twoLinesFrom - 32).lines, `${lang} still two`).toBe(2);
        expect(footerLines(widths, m.twoLinesFrom - 1 - 32).lines, `${lang} three`).toBe(3);
      }
    }
  });

  it("phones and desktops: two lines clip 86 px, one line 55 px; a width near a wrap point is narrowed to a sure answer", () => {
    expect(whopFooterFit("fr", 333)).toEqual({ inset: 0, clip: 86 }); // a 375 px screen
    expect(whopFooterFit("fr", 348)).toEqual({ inset: 2, clip: 86 }); // 390 px: 16 px under the wrap point, narrowed a little
    expect(whopFooterFit("fr", 370)).toEqual({ inset: 0, clip: 55 }); // 412 px
    expect(whopFooterFit("fr", 470)).toEqual({ inset: 0, clip: 55 }); // desktop column
    expect(whopFooterFit("en", 348)).toEqual({ inset: 0, clip: 55 });
    expect(whopFooterFit("es", 340)).toEqual({ inset: 8, clip: 86 });
    expect(whopFooterFit("de", 372)).toEqual({ inset: 3, clip: 86 });
  });

  it("every answer is sure: the same lines with the text 2 % wider or up to 9 % narrower, and with Whop's fallback fonts; one or two lines; the frame narrowed by 8 px at most", () => {
    for (const lang of LANGS) {
      const { widths } = WHOP_FOOTER[lang];
      for (let w = 160; w <= 800; w++) {
        const fit = whopFooterFit(lang, w);
        if (!fit) continue;
        expect(fit.inset).toBeLessThanOrEqual(8);
        const available = w - 2 * fit.inset - 32;
        const lines = footerLines(widths, available).lines;
        expect(lines).toBeLessThanOrEqual(2);
        for (const k of [0.91, 0.94, 0.97, 1, 1.01, 1.02]) expect(footerLines(withTextScaled(widths, k), available).lines, `${lang} ${w} ×${k}`).toBe(lines);
        for (const font of Object.keys(FALLBACKS)) expect(footerLines(FALLBACKS[font][lang], available).lines, `${lang} ${w} ${font}`).toBe(lines);
        expect(fit.clip, `${lang} ${w}`).toBe(lines === 1 ? 55 : 86);
      }
    }
    // Whop's logo is no text: never scaled.
    expect(withTextScaled([139.78, 1, 60.84, 82.14], 0.5)).toEqual([139.78 - (139.78 - 64.34) / 2, 1, 30.42, 41.07]);
  });

  it("French gets an answer on every common screen; the few frames too close to a wrap point in German or Dutch show the footer", () => {
    for (const w of FRAMES) expect(whopFooterFit("fr", w), `fr ${w}`).not.toBeNull();
    for (const lang of ["en", "es", "it"]) for (const w of FRAMES) expect(whopFooterFit(lang, w), `${lang} ${w}`).not.toBeNull();
    expect(whopFooterFit("de", 388)).toBeNull(); // a 430 px screen
    expect(whopFooterFit("nl", 370)).toBeNull(); // 412 px
  });

  it("a language never measured, no width yet, or a frame too narrow for two lines: the footer shows", () => {
    expect(whopFooterFit("pt", 340)).toBeNull();
    expect(whopFooterFit("fr", 0)).toBeNull();
    expect(whopFooterFit("fr", 190)).toBeNull();
  });
});

const FIXTURES = path.join(__dirname, "fixtures/whop-footer");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, `${name}.html`), "utf8");
const SPACER = '<div class="embedded-checkout-spacer w-full shrink-0"></div>';

describe("footerVerdict on Whop's own pages", () => {
  it("the measured footer, in each checkout language, last in the form — whatever Whop shows above it: clipped", () => {
    for (const lang of LANGS) expect(footerVerdict(fixture(`${lang}-hidden`), lang), lang).toEqual({ ok: true });
    // Whop's own pay button and terms line above the footer, its terms line alone, the card kept for an offer.
    expect(footerVerdict(fixture("fr-full"), "fr")).toEqual({ ok: true });
    expect(footerVerdict(fixture("fr-tos"), "fr")).toEqual({ ok: true });
    expect(footerVerdict(fixture("fr-sfu"), "fr")).toEqual({ ok: true });
  });

  it("anything else: shown (with why)", () => {
    const fr = fixture("fr-hidden");
    expect(footerVerdict(fr.replace('\\"whop_checkout_branding\\":true', '\\"whop_checkout_branding\\":false'), "fr")).toEqual({ ok: false, reason: "branding_flag" });
    expect(footerVerdict(fr.replace("padding-bottom:0px", "padding-bottom:16px"), "fr")).toEqual({ ok: false, reason: "container" });
    // Something after the footer (Whop added a line under it), other words, another language's words.
    expect(footerVerdict(fr.replace('</a></div></div></div><div class="embedded-checkout-spacer', '</a></div><p class="fui-Text">Paiement sécurisé</p></div></div><div class="embedded-checkout-spacer'), "fr")).toEqual({ ok: false, reason: "footer_markup" });
    expect(footerVerdict(fr.replace(">Conditions<", ">Conditions d'utilisation<"), "fr")).toEqual({ ok: false, reason: "footer_words" });
    expect(footerVerdict(fr, "de")).toEqual({ ok: false, reason: "footer_words" });
    // Its spacing or text size changed in the markup.
    expect(footerVerdict(fr.replace("gap-4 justify-center", "gap-3 justify-center"), "fr")).toEqual({ ok: false, reason: "footer_markup" });
    expect(footerVerdict(fr.replace('leading-[1.2] fui-r-size-1">Propulsé', 'leading-[1.4] fui-r-size-2">Propulsé'), "fr")).toEqual({ ok: false, reason: "footer_markup" });
    expect(footerVerdict(fr, "pt")).toEqual({ ok: false, reason: "language" });
  });

  it("the spacer last: anything drawn after it in the form, or below the form, or still streaming in: shown", () => {
    const fr = fixture("fr-hidden");
    expect(fr).toContain(`${SPACER}</div></div></div><!--$--><!--/$--><!--$--><!--/$--></div><script`);
    // In the form's column, after the spacer.
    expect(footerVerdict(fr.replace(`${SPACER}</div>`, `${SPACER}<div class="text-xs">Paiement sécurisé</div></div>`), "fr")).toEqual({ ok: false, reason: "footer_markup" });
    // Below the form's column (still in the form's part of the page).
    expect(footerVerdict(fr.replace(`${SPACER}</div></div>`, `${SPACER}</div><div class="p-4">Aide</div></div>`), "fr")).toEqual({ ok: false, reason: "footer_markup" });
    expect(footerVerdict(fr.replace("<!--$--><!--/$--><!--$--><!--/$--></div><script", "<!--$--><p>Aide</p><!--/$--></div><script"), "fr")).toEqual({ ok: false, reason: "footer_markup" });
    // A part of the page still streaming in after it (React's pending boundary).
    expect(footerVerdict(fr.replace("<!--$--><!--/$--><!--$--><!--/$--></div><script", '<!--$?--><template id="B:3"></template><!--/$--></div><script'), "fr")).toEqual({ ok: false, reason: "footer_markup" });
  });

  it("Whop's logo as measured, nothing hidden in it: else shown", () => {
    const fr = fixture("fr-hidden");
    // Another size: another width.
    expect(footerVerdict(fr.replace("h-[1.1em] w-auto", "h-[1.3em] w-auto"), "fr")).toEqual({ ok: false, reason: "footer_content" });
    expect(footerVerdict(fr.replace('viewBox="0 0 119 26"', 'viewBox="0 0 140 26"'), "fr")).toEqual({ ok: false, reason: "footer_content" });
    // « Whop » written out (no longer for screen readers only), a link or text hidden in the logo.
    expect(footerVerdict(fr.replace('<span class="sr-only">Whop</span>', "<span>Whop</span>"), "fr")).toEqual({ ok: false, reason: "footer_content" });
    expect(footerVerdict(fr.replace("<defs>", "<foreignObject><div>Sécurisé</div></foreignObject><defs>"), "fr")).toEqual({ ok: false, reason: "footer_content" });
    expect(footerVerdict(fr.replace("<defs>", '<text x="0" y="10">Whop</text><defs>'), "fr")).toEqual({ ok: false, reason: "footer_content" });
  });

  it("a page that isn't the checkout form at all (renamed, an error page): shown", () => {
    expect(footerVerdict("<html><body>Checkout not found</body></html>", "fr")).toEqual({ ok: false, reason: "page" });
    expect(footerVerdict(fixture("fr-hidden").replace(/embedded-checkout-container/g, "checkout-root"), "fr")).toEqual({ ok: false, reason: "page" });
    expect(footerVerdict(fixture("fr-hidden").replace(/whop_checkout_branding/g, "branding"), "fr")).toEqual({ ok: false, reason: "branding_flag" });
  });
});

describe("the verdict kept per store, Whop account, language and form", () => {
  const store = { id: "st_1", testMode: false, whopAccountId: "biz_1", whopFooterHidden: true };
  const variant = { hideTos: true, saveCard: false };
  const check = (o: Partial<Parameters<typeof refreshWhopFooterCheck>[0]> = {}) =>
    refreshWhopFooterCheck({ store, lang: "fr", variant, sessionId: "s1", origin: "https://checkout.shop.fr", ...o });
  const KEY = "whop:footer:st_1:fr:t-:whop.com:biz_1";
  let fetched: string[] = [];
  let html = fixture("fr-hidden");
  beforeEach(() => {
    for (const m of Object.values(mocks)) m.mockReset();
    mocks.findSetting.mockResolvedValue(null);
    mocks.findSettings.mockResolvedValue([]);
    mocks.updateMany.mockResolvedValue({ count: 1 });
    mocks.createMany.mockResolvedValue({ count: 1 });
    mocks.upsert.mockResolvedValue({});
    mocks.deleteMany.mockResolvedValue({ count: 0 });
    mocks.findQuote.mockResolvedValue({ whopCheckoutId: "ch_1", fingerprint: "q|h:x" });
    fetched = [];
    html = fixture("fr-hidden");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string) => {
        fetched.push(String(url));
        return new Response(html, { status: 200 });
      }),
    );
  });
  const stored = (value: object, key = KEY) => ({ key, value: JSON.stringify(value) });
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  const saved = () => JSON.parse((mocks.upsert.mock.calls[0][0] as { create: { value: string } }).create.value);

  it("clipped only when the store chose it, on a good verdict of the last 24 h, for its own form, account and a measured language", async () => {
    mocks.findSetting.mockResolvedValueOnce(stored({ ok: true, at: hoursAgo(20) }));
    expect(await whopFooterClipped(store, "fr", variant)).toBe(true);
    expect(mocks.findSetting).toHaveBeenLastCalledWith({ where: { key: KEY } });
    mocks.findSetting.mockResolvedValueOnce(stored({ ok: true, at: hoursAgo(25) }));
    expect(await whopFooterClipped(store, "fr", variant)).toBe(false);
    mocks.findSetting.mockResolvedValueOnce(stored({ ok: false, at: hoursAgo(1), reason: "footer_words" }));
    expect(await whopFooterClipped(store, "fr", variant)).toBe(false);
    mocks.findSetting.mockRejectedValueOnce(new Error("db down"));
    expect(await whopFooterClipped(store, "fr", variant)).toBe(false);
    // Another form of the same store (its terms line shown, the card kept): its own verdict.
    await whopFooterClipped(store, "fr", { hideTos: false, saveCard: true });
    expect(mocks.findSetting).toHaveBeenLastCalledWith({ where: { key: "whop:footer:st_1:fr:-s:whop.com:biz_1" } });
    // Another Whop account, or the store back in test mode (Whop's sandbox): never the old account's verdict.
    await whopFooterClipped({ ...store, whopAccountId: "biz_2" }, "fr", variant);
    expect(mocks.findSetting).toHaveBeenLastCalledWith({ where: { key: "whop:footer:st_1:fr:t-:whop.com:biz_2" } });
    await whopFooterClipped({ ...store, testMode: true }, "fr", variant);
    expect(mocks.findSetting).toHaveBeenLastCalledWith({ where: { key: "whop:footer:st_1:fr:t-:sandbox.whop.com:biz_1" } });
    mocks.findSetting.mockClear();
    // The store didn't choose it, or a language never measured: nothing read.
    expect(await whopFooterClipped({ ...store, whopFooterHidden: false }, "fr", variant)).toBe(false);
    expect(await whopFooterClipped(store, "pt", variant)).toBe(false);
    expect(mocks.findSetting).not.toHaveBeenCalled();
    expect(verdictClips(JSON.stringify({ ok: true, at: "nope" }))).toBe(false);
  });

  it("no verdict yet: the session's latest card checkout read on Whop's page as the store's frame loads it, the verdict kept", async () => {
    await check();
    // The card form only: never the PayPal-only checkout, nor one deleted at a switch to Stripe, nor an old one.
    const query = mocks.findQuote.mock.calls[0][0] as { where: Record<string, unknown>; orderBy: unknown };
    expect(query.where).toMatchObject({ sessionId: "s1", provider: "whop", whopCheckoutId: { not: null }, NOT: [{ fingerprint: { contains: "|m:paypal" } }, { fingerprint: { endsWith: "|x:deleted" } }] });
    const since = (query.where.createdAt as { gte: Date }).gte.getTime();
    expect(Date.now() - since).toBeGreaterThan(59 * 60_000);
    expect(Date.now() - since).toBeLessThan(61 * 60_000);
    expect(query.orderBy).toEqual({ createdAt: "desc" });
    expect(mocks.createMany).toHaveBeenCalledTimes(1);
    expect(fetched).toHaveLength(1);
    const url = new URL(fetched[0]);
    expect(url.origin + url.pathname).toBe("https://whop.com/embedded/checkout/ch_1/");
    const params = Object.fromEntries(url.searchParams);
    expect(params).toMatchObject({ h: "https://checkout.shop.fr", t: "checkout.shop.fr", locale: "fr", session: "ch_1", hide_submit_button: "true", hide_tos: "true", "email.hidden": "1", "address.hidden": "1", v: "3" });
    expect(params.setup_future_usage).toBeUndefined();
    expect(saved()).toMatchObject({ ok: true });
    expect((mocks.upsert.mock.calls[0][0] as { where: { key: string } }).where.key).toBe(KEY);
    // The store's other form: its terms line shown, the card kept for an offer; a test-mode store reads Whop's sandbox.
    mocks.upsert.mockClear();
    html = fixture("fr-sfu");
    await check({ variant: { hideTos: false, saveCard: true }, store: { ...store, testMode: true } });
    const other = new URL(fetched[1]);
    expect(other.host).toBe("sandbox.whop.com");
    expect(other.searchParams.get("hide_tos")).toBeNull();
    expect(other.searchParams.get("setup_future_usage")).toBe("off_session");
    expect((mocks.upsert.mock.calls[0][0] as { where: { key: string } }).where.key).toBe("whop:footer:st_1:fr:-s:sandbox.whop.com:biz_1");
  });

  it("a recent verdict, a check already running, or a session without a card checkout: Whop isn't asked, nothing marked", async () => {
    mocks.findSetting.mockResolvedValue(stored({ ok: true, at: hoursAgo(2) }));
    await check();
    mocks.findSetting.mockResolvedValue(stored({ ok: true, at: hoursAgo(5), attemptAt: new Date(Date.now() - 60_000).toISOString() }));
    await check();
    // Another request marked the attempt between the read and the mark.
    mocks.findSetting.mockResolvedValue(stored({ ok: true, at: hoursAgo(5) }));
    mocks.updateMany.mockResolvedValueOnce({ count: 0 });
    await check();
    expect(fetched).toEqual([]);
    expect(mocks.upsert).not.toHaveBeenCalled();
    // No card checkout to read (a page that never prepared one; only its PayPal-only one, should the
    // database hand it over): nothing marked, the next page may ask.
    vi.useFakeTimers();
    try {
      for (const quote of [null, { whopCheckoutId: "ch_pp", fingerprint: "q|m:paypal|h:x" }, { whopCheckoutId: "ch_old", fingerprint: "q|x:deleted" }]) {
        mocks.updateMany.mockClear();
        mocks.findQuote.mockResolvedValue(quote);
        const run = check();
        await vi.advanceTimersByTimeAsync(10_000);
        await run;
        expect(mocks.updateMany).not.toHaveBeenCalled();
        expect(mocks.createMany).not.toHaveBeenCalled();
        expect(fetched).toEqual([]);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("Whop changed its form: the clip is off at once (said in the logs); Whop's page out of reach: the last verdict stays (logged, with why)", async () => {
    mocks.findSetting.mockResolvedValue(stored({ ok: true, at: hoursAgo(5) }));
    html = fixture("fr-hidden").replace(/embedded-checkout-container/g, "checkout-root");
    await check();
    expect(JSON.parse((mocks.upsert.mock.calls[0][0] as { update: { value: string } }).update.value)).toMatchObject({ ok: false, reason: "page" });
    expect(mocks.warn).toHaveBeenCalledWith("whop.footer_not_clipped", expect.any(String), expect.objectContaining({ reason: "page", wasOk: true }));

    mocks.upsert.mockClear();
    const cancelled: boolean[] = [];
    const busy = () => {
      const body = new ReadableStream({ cancel: () => void cancelled.push(true) });
      return new Response(body, { status: 503 });
    };
    for (const res of [busy, () => new Response(null, { status: 302, headers: { location: "https://whop.com/login" } })]) {
      vi.stubGlobal("fetch", vi.fn(async () => res()));
      await check();
    }
    expect(mocks.upsert).not.toHaveBeenCalled();
    // The 503's body is never read: the connection is let go at once.
    expect(cancelled).toEqual([true]);
    expect(mocks.info).toHaveBeenCalledWith("whop.footer_check_unreachable", expect.any(String), expect.objectContaining({ keptOk: true, why: "status_503" }));
    expect(mocks.info).toHaveBeenCalledWith("whop.footer_check_unreachable", expect.any(String), expect.objectContaining({ why: "status_302" }));
  });

  it("the settings page: the latest check per language, for the store's current Whop account; shown again, the checks are forgotten", async () => {
    mocks.findSettings.mockResolvedValue([
      stored({ ok: true, at: hoursAgo(1) }, "whop:footer:st_1:fr:t-:whop.com:biz_1"),
      stored({ ok: false, at: hoursAgo(5), reason: "footer_words" }, "whop:footer:st_1:fr:--:whop.com:biz_1"),
      stored({ ok: false, at: hoursAgo(2), reason: "branding_flag" }, "whop:footer:st_1:de:t-:whop.com:biz_1"),
      stored({ ok: false, at: new Date(0).toISOString(), attemptAt: hoursAgo(0) }, "whop:footer:st_1:es:t-:whop.com:biz_1"),
    ]);
    const v = await whopFooterVerdicts(store);
    expect(mocks.findSettings).toHaveBeenCalledWith({ where: { key: { startsWith: "whop:footer:st_1:", endsWith: ":whop.com:biz_1" } } });
    expect(v.fr).toMatchObject({ ok: true, clips: true });
    expect(v.de).toMatchObject({ ok: false, reason: "branding_flag", clips: false });
    // An attempt mark alone (never answered): no line.
    expect(v.es).toBeUndefined();

    await forgetWhopFooterVerdicts("st_1");
    expect(mocks.deleteMany).toHaveBeenCalledWith({ where: { key: { startsWith: "whop:footer:st_1:" } } });
  });
});
