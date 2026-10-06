// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { blockSchema, COUNTDOWN_DURATION, createBlock, loadCheckoutLayout, loadThankYouLayout, type Block, type BlockOf } from "@/lib/layout";
import { ContentBlock, isEmptyInLive, type ContentContext } from "@/components/checkout/blocks";
import { labelsFor, type Lang } from "@/components/checkout/i18n";
import { COUNTDOWN_EXAMPLE_KEYS, DEFAULT_TEXTS, localizeBlock } from "@/components/checkout/localize";
import {
  evergreenRemaining,
  evergreenStart,
  evergreenStorageKey,
  formatTimer,
  spokenTimer,
  splitTimerText,
} from "@/components/checkout/countdown";
import { BlockContentEditor } from "@/components/builder/BlockEditor";
import { setupWarnings } from "@/components/builder/placement";

/*
 * Countdown « Minuteur par visiteur »: schema defaults and older layouts, timer text and formats,
 * {timer} placement, restart at zero, "keep" vs "each_visit" (localStorage, and without it), the
 * server render matching the first client render, the 6-language examples and the editor form.
 */

const LANGS: Lang[] = ["fr", "en", "de", "es", "it", "nl"];
const T0 = Date.UTC(2026, 9, 6, 12, 0, 0);

const ctx = (over: Partial<ContentContext> = {}): ContentContext => ({
  labels: labelsFor("fr"),
  lang: "fr",
  lowestInventory: null,
  preview: false,
  subtotalCents: 0,
  freeShippingThresholdCents: null,
  money: (c: number) => String(c),
  note: "",
  setNote: () => {},
  storeKey: "store1",
  ...over,
});

const evergreen = (over: Partial<BlockOf<"countdown">["props"]> = {}, id?: string): BlockOf<"countdown"> => {
  const b = createBlock("countdown");
  return { ...b, ...(id ? { id } : {}), props: { ...b.props, mode: "evergreen", label: "Offre spéciale : se termine dans {timer}", durationSeconds: 900, ...over } };
};

const timerText = (root: ParentNode = document) => root.querySelector('[role="timer"]')?.textContent;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
describe("schema: defaults and older layouts", () => {
  it("a new countdown is a date one, 15 min / keep / hh:mm:ss ready for the evergreen mode", () => {
    const b = createBlock("countdown");
    expect(b.props).toEqual({ label: "L'offre se termine dans :", endsAt: "", mode: "date", durationSeconds: 900, restart: "keep", format: "hms" });
  });

  it("an older layout (label + endsAt only) loads unchanged as a date countdown", () => {
    const raw = { blocks: [{ id: "old1", type: "countdown", props: { label: "Fin :", endsAt: "2026-12-01T10:00:00.000Z" } }] };
    for (const layout of [loadCheckoutLayout(raw), loadThankYouLayout(raw)]) {
      const c = layout.blocks.find((b) => b.id === "old1") as BlockOf<"countdown">;
      expect(c.props).toMatchObject({ label: "Fin :", endsAt: "2026-12-01T10:00:00.000Z", mode: "date" });
    }
  });

  it("duration: 1 min to 72 h, whole seconds; mode / restart / format enums", () => {
    const base = createBlock("countdown");
    const ok = (props: object) => blockSchema.safeParse({ ...base, props: { ...base.props, ...props } }).success;
    expect(ok({ mode: "evergreen", durationSeconds: 60 })).toBe(true);
    expect(ok({ mode: "evergreen", durationSeconds: 72 * 3600 })).toBe(true);
    expect(ok({ durationSeconds: 59 })).toBe(false);
    expect(ok({ durationSeconds: 72 * 3600 + 1 })).toBe(false);
    expect(ok({ durationSeconds: 90.5 })).toBe(false);
    expect(ok({ mode: "loop" })).toBe(false);
    expect(ok({ restart: "never" })).toBe(false);
    expect(ok({ format: "dd" })).toBe(false);
    expect(COUNTDOWN_DURATION).toEqual({ min: 60, max: 259200, default: 900 });
  });
});

/* ------------------------------------------------------------------ */
describe("timer text", () => {
  it("formats: hh:mm:ss, mm:ss, words", () => {
    const ms = (2 * 3600 + 14 * 60 + 5) * 1000;
    expect(formatTimer(ms, "hms", "j")).toBe("02:14:05");
    expect(formatTimer(ms, "ms", "j")).toBe("134:05");
    expect(formatTimer(ms, "words", "j")).toBe("2 h 14 min");
    expect(formatTimer(14 * 60_000 + 5000, "words", "j")).toBe("14 min 05 s");
    expect(formatTimer(42_000, "words", "j")).toBe("42 s");
    expect(formatTimer(72 * 3600_000, "hms", "j")).toBe("72:00:00");
    expect(formatTimer(0, "hms", "j")).toBe("00:00:00");
    // Date countdowns keep their days.
    expect(formatTimer((2 * 86400 + 3600) * 1000, "hms", "j", true)).toBe("2j 01:00:00");
    expect(formatTimer((2 * 86400 + 3600) * 1000, "words", "d", true)).toBe("2 d 1 h");
    // A partial second shows the second it is in (never 00:00:00 before the end).
    expect(formatTimer(400, "hms", "j")).toBe("00:00:01");
  });

  it("spoken text: whole minutes only (changes at most once a minute)", () => {
    expect(spokenTimer(14 * 60_000 + 59_000, "j")).toBe("15 min 00 s");
    expect(spokenTimer(14 * 60_000 + 1_000, "j")).toBe("15 min 00 s");
    expect(spokenTimer(5_000, "j")).toBe("1 min 00 s");
    expect(spokenTimer(2 * 3600_000 + 13 * 60_000 + 30_000, "j")).toBe("2 h 14 min");
  });

  it("{timer} placement: inline where written, else after the text", () => {
    expect(splitTimerText("Commandez dans {timer} pour une expédition aujourd'hui")).toEqual({
      before: "Commandez dans ",
      after: " pour une expédition aujourd'hui",
      inline: true,
    });
    expect(splitTimerText("L'offre se termine dans :")).toEqual({ before: "L'offre se termine dans :", after: "", inline: false });
    expect(splitTimerText("{timer} {timer} restantes").after).toBe("  restantes");
  });
});

/* ------------------------------------------------------------------ */
describe("evergreen timer: loop and memory", () => {
  const D = 900_000;

  it("starts full, counts down, and starts over from the full duration at zero", () => {
    expect(evergreenRemaining(T0, D, T0)).toBe(D);
    expect(evergreenRemaining(T0, D, T0 + 1000)).toBe(D - 1000);
    expect(evergreenRemaining(T0, D, T0 + D - 1)).toBe(1);
    expect(evergreenRemaining(T0, D, T0 + D)).toBe(D);
    // A tab in the background for 2 h 40 min comes back on the right second.
    expect(evergreenRemaining(T0, D, T0 + 9_600_000 + 5000)).toBe(D - (9_605_000 % D));
    // Clock moved back: full duration, never more.
    expect(evergreenRemaining(T0, D, T0 - 5000)).toBe(D);
  });

  it("keep: the start is remembered per store and block; each_visit: always now", () => {
    const key = evergreenStorageKey("store1", "blk1");
    expect(key).toBe("wc-countdown:store1:blk1");
    expect(evergreenStorageKey("store2", "blk1")).not.toBe(key);
    expect(evergreenStorageKey(null, "blk1")).toBe("wc-countdown:-:blk1");
    expect(evergreenStart({ restart: "keep", durationMs: D, now: T0, key, storage: localStorage })).toBe(T0);
    expect(evergreenStart({ restart: "keep", durationMs: D, now: T0 + 60_000, key, storage: localStorage })).toBe(T0);
    expect(evergreenStart({ restart: "each_visit", durationMs: D, now: T0 + 60_000, key, storage: localStorage })).toBe(T0 + 60_000);
    // Another duration (merchant changed it), a start in the future or junk: started over.
    expect(evergreenStart({ restart: "keep", durationMs: 2 * D, now: T0 + 120_000, key, storage: localStorage })).toBe(T0 + 120_000);
    localStorage.setItem(key, JSON.stringify({ start: T0 + 10 ** 9, duration: D }));
    expect(evergreenStart({ restart: "keep", durationMs: D, now: T0, key, storage: localStorage })).toBe(T0);
    localStorage.setItem(key, "{oops");
    expect(evergreenStart({ restart: "keep", durationMs: D, now: T0 + 5, key, storage: localStorage })).toBe(T0 + 5);
  });

  it("localStorage unavailable or throwing: the timer still runs, from now", () => {
    const throwing = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(evergreenStart({ restart: "keep", durationMs: D, now: T0, key: "k", storage: throwing })).toBe(T0);
    expect(evergreenStart({ restart: "keep", durationMs: D, now: T0, key: "k", storage: null })).toBe(T0);
  });
});

/* ------------------------------------------------------------------ */
describe("rendering", () => {
  it("server render: the full duration, inline at {timer}, role=timer without live announcements", () => {
    const html = renderToString(h(ContentBlock, { block: evergreen({ restart: "each_visit" }) as Block, ctx: ctx() }));
    expect(html).toContain("15:00");
    expect(html).toContain('role="timer"');
    expect(html).toContain('aria-live="off"');
    expect(html).toContain("Offre spéciale : se termine dans ");
    // The label is the spoken time only (the merchant's text around it is read as written).
    expect(html).toContain('aria-label="15 min 00 s"');
    expect(html).not.toMatch(/aria-label="Fin dans/);
    // The ticking digits are decorative for screen readers.
    expect(html).toMatch(/<span aria-hidden="true">00:15:00<\/span>/);
    expect(html).not.toContain("visibility:hidden");
    expect(html).toContain("tabular-nums");
  });

  it("keep: a returning visitor never sees the full duration before their time (hidden digits, same place)", async () => {
    vi.useFakeTimers({ now: T0 });
    localStorage.setItem("wc-countdown:store1:back", JSON.stringify({ start: T0 - 5 * 60_000, duration: 900_000 }));
    const block = evergreen({ restart: "keep" }, "back") as Block;
    const el = h(ContentBlock, { block, ctx: ctx() });
    const html = renderToString(el);
    // Server / first render: the digits keep their place but stay invisible, out of the a11y tree.
    expect(html).toContain("visibility:hidden");
    expect(html).toContain("data-countdown-pending");
    expect(html).toContain("00:15:00");
    expect(html).not.toContain("aria-label=");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const errors: unknown[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a));
    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(container, el, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    errSpy.mockRestore();
    const timer = container.querySelector<HTMLElement>('[role="timer"]')!;
    expect(timer.style.visibility).toBe("");
    expect(timer.hasAttribute("data-countdown-pending")).toBe(false);
    expect(timer.textContent).toBe("00:10:00");
    expect(timer.getAttribute("aria-label")).toBe("10 min 00 s");
    act(() => root!.unmount());
    container.remove();
  });

  it("hydrates without mismatch, then ticks and loops at zero", async () => {
    vi.useFakeTimers({ now: T0 });
    const block = evergreen({ durationSeconds: 60, format: "ms", restart: "each_visit" }) as Block;
    const el = h(ContentBlock, { block, ctx: ctx() });
    const container = document.createElement("div");
    container.innerHTML = renderToString(el);
    document.body.appendChild(container);
    const errors: unknown[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((...a) => errors.push(a));
    let root: ReturnType<typeof hydrateRoot> | null = null;
    await act(async () => {
      root = hydrateRoot(container, el, { onRecoverableError: (e) => errors.push(e) });
    });
    expect(errors).toEqual([]);
    errSpy.mockRestore();
    expect(timerText(container)).toBe("01:00");
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(timerText(container)).toBe("00:59");
    await act(async () => {
      vi.advanceTimersByTime(59_000);
    });
    // Zero → full duration again.
    expect(timerText(container)).toBe("01:00");
    await act(async () => {
      vi.advanceTimersByTime(15_000);
    });
    expect(timerText(container)).toBe("00:45");
    act(() => root!.unmount());
    container.remove();
  });

  it("keep: a visitor coming back finds their remaining time; each_visit: full again", async () => {
    vi.useFakeTimers({ now: T0 });
    const keep = evergreen({ restart: "keep" }, "blkA") as Block;
    const first = render(h(ContentBlock, { block: keep, ctx: ctx() }));
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(timerText()).toBe("00:10:00");
    first.unmount();
    expect(JSON.parse(localStorage.getItem("wc-countdown:store1:blkA")!)).toEqual({ start: T0, duration: 900_000 });
    // Page reloaded 2 minutes later.
    vi.setSystemTime(T0 + 7 * 60_000);
    render(h(ContentBlock, { block: keep, ctx: ctx() }));
    await act(async () => {});
    expect(timerText()).toBe("00:08:00");
    cleanup();
    // Same block id in another store: its own timer.
    render(h(ContentBlock, { block: keep, ctx: ctx({ storeKey: "store2" }) }));
    await act(async () => {});
    expect(timerText()).toBe("00:15:00");
    cleanup();
    const each = evergreen({ restart: "each_visit" }, "blkB") as Block;
    render(h(ContentBlock, { block: each, ctx: ctx() }));
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    cleanup();
    render(h(ContentBlock, { block: each, ctx: ctx() }));
    await act(async () => {});
    expect(timerText()).toBe("00:15:00");
    expect(localStorage.getItem("wc-countdown:store1:blkB")).toBeNull();
  });

  it("two countdown blocks keep their own timers", async () => {
    vi.useFakeTimers({ now: T0 });
    localStorage.setItem("wc-countdown:store1:one", JSON.stringify({ start: T0 - 60_000, duration: 900_000 }));
    render(
      h("div", null, [
        h(ContentBlock, { key: 1, block: evergreen({}, "one") as Block, ctx: ctx() }),
        h(ContentBlock, { key: 2, block: evergreen({ durationSeconds: 3600, format: "words" }, "two") as Block, ctx: ctx() }),
      ]),
    );
    await act(async () => {});
    const timers = [...document.querySelectorAll('[role="timer"]')].map((t) => t.textContent);
    expect(timers).toEqual(["00:14:00", "1 h 00 min"]);
  });

  it("works without localStorage (blocked): the timer runs from the full duration", async () => {
    vi.useFakeTimers({ now: T0 });
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    render(h(ContentBlock, { block: evergreen() as Block, ctx: ctx() }));
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(timerText()).toBe("00:14:58");
  });

  it("text without {timer}: the timer follows the text", () => {
    const html = renderToString(h(ContentBlock, { block: evergreen({ label: "Votre remise expire bientôt" }) as Block, ctx: ctx() }));
    expect(html.indexOf("Votre remise expire bientôt")).toBeLessThan(html.indexOf('role="timer"'));
    expect(html).not.toContain("{timer}");
  });

  it("aria-label changes at most once a minute while the digits tick", async () => {
    vi.useFakeTimers({ now: T0 });
    render(h(ContentBlock, { block: evergreen() as Block, ctx: ctx() }));
    await act(async () => {});
    const label = () => document.querySelector('[role="timer"]')!.getAttribute("aria-label");
    const seen = new Set<string | null>();
    for (let i = 0; i < 59; i++) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      seen.add(label());
    }
    expect(seen.size).toBeLessThanOrEqual(2);
    expect(timerText()).toBe("00:14:01");
  });

  it("date mode is unchanged: nothing before mount, hidden once over; evergreen never empty in live", () => {
    const date = createBlock("countdown");
    // Before mount: the band keeps its height (no layout shift) with invisible digits.
    const before = renderToString(h(ContentBlock, { block: { ...date, props: { ...date.props, mode: "date", endsAt: new Date(T0 + 3600_000).toISOString() } } as Block, ctx: ctx() }));
    expect(before).toContain("data-countdown=");
    expect(before).toContain("visibility:hidden");
    expect(before).not.toContain("aria-label=");
    expect(isEmptyInLive({ ...date, props: { ...date.props, endsAt: new Date(T0 - 1).toISOString() } }, ctx(), T0)).toBe(true);
    expect(isEmptyInLive(date, ctx(), T0)).toBe(true);
    expect(isEmptyInLive(evergreen(), ctx(), T0)).toBe(false);
    expect(isEmptyInLive(evergreen({ endsAt: new Date(T0 - 1).toISOString() }), ctx(), T0 + 10 ** 9)).toBe(false);
    expect(setupWarnings([evergreen()], { now: T0 })).toEqual({});
    // No « à compléter » warning any more (merchant's rule): a date-mode timer without a date simply shows nothing live.
    expect(setupWarnings([date], { now: T0 })).toEqual({});
  });

  it("thank-you page: the same block renders (ContentBlock is shared)", () => {
    const html = renderToString(h(ContentBlock, { block: evergreen({ label: "Votre panier est réservé pendant {timer}" }) as Block, ctx: ctx({ preview: true }) }));
    expect(html).toContain("Votre panier est réservé pendant ");
    expect(html).toContain("00:15:00");
  });
});

/* ------------------------------------------------------------------ */
describe("examples in 6 languages", () => {
  it("each example has {timer} once in every language", () => {
    for (const lang of LANGS) {
      for (const key of COUNTDOWN_EXAMPLE_KEYS) {
        const t = DEFAULT_TEXTS[lang][key];
        expect(t.split("{timer}").length - 1, `${lang}.${key}`).toBe(1);
      }
    }
    expect(COUNTDOWN_EXAMPLE_KEYS.map((k) => DEFAULT_TEXTS.fr[k])).toEqual([
      "Offre spéciale : se termine dans {timer}",
      "Votre panier est réservé pendant {timer}",
      "Commandez dans {timer} pour une expédition aujourd'hui",
    ]);
  });

  it("a French example is shown translated to a foreign buyer", () => {
    const b = evergreen({ label: DEFAULT_TEXTS.fr.countdownCart, restart: "each_visit" });
    expect(localizeBlock(b, "en").props.label).toBe("Your cart is reserved for {timer}");
    expect(localizeBlock(b, "de").props.label).toBe("Ihr Warenkorb ist für {timer} reserviert");
    const html = renderToString(h(ContentBlock, { block: localizeBlock(b, "en") as Block, ctx: ctx({ labels: labelsFor("en"), lang: "en" }) }));
    expect(html).toContain("Your cart is reserved for ");
    expect(html).toContain('aria-label="15 min 00 s"');
  });
});

/* ------------------------------------------------------------------ */
describe("editor", () => {
  const edit = (block: BlockOf<"countdown">) => {
    let last: Block = block;
    const utils = render(h(BlockContentEditor, { block, onChange: (b: Block) => (last = b) }));
    return { ...utils, last: () => last as BlockOf<"countdown"> };
  };

  it("date mode: end date, no evergreen settings", () => {
    edit(createBlock("countdown"));
    expect(screen.getByRole("button", { name: "Date de fin" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("group", { name: "Fin de l'offre" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Durée" })).toBeNull();
    expect(screen.queryByText(/fausse urgence/)).toBeNull();
  });

  it("switching to « Minuteur par visiteur » swaps the date default text for an example", () => {
    const { last } = edit(createBlock("countdown"));
    fireEvent.click(screen.getByRole("button", { name: "Minuteur par visiteur" }));
    expect(last().props.mode).toBe("evergreen");
    expect(last().props.label).toBe("Offre spéciale : se termine dans {timer}");
  });

  it("a merchant's own text is kept when switching", () => {
    const b = createBlock("countdown");
    const { last } = edit({ ...b, props: { ...b.props, label: "Promo flash" } });
    fireEvent.click(screen.getByRole("button", { name: "Minuteur par visiteur" }));
    expect(last().props).toMatchObject({ mode: "evergreen", label: "Promo flash" });
  });

  it("evergreen: duration h/m/s, restart option, examples, format and the discreet tip", () => {
    const { last } = edit(evergreen({ label: "x" }));
    expect((screen.getByLabelText("Heures") as HTMLInputElement).value).toBe("0");
    expect((screen.getByLabelText("Minutes") as HTMLInputElement).value).toBe("15");
    expect((screen.getByLabelText("Secondes") as HTMLInputElement).value).toBe("0");
    fireEvent.change(screen.getByLabelText("Heures"), { target: { value: "2" } });
    expect(last().props.durationSeconds).toBe(2 * 3600 + 15 * 60);

    fireEvent.click(screen.getByRole("button", { name: "Repartir à chaque visite" }));
    expect(last().props.restart).toBe("each_visit");

    fireEvent.click(screen.getByRole("button", { name: "Commandez dans {timer} pour une expédition aujourd'hui" }));
    expect(last().props.label).toBe("Commandez dans {timer} pour une expédition aujourd'hui");

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "words" } });
    expect(last().props.format).toBe("words");

    const tips = screen.getAllByText("Astuce : un minuteur qui repart à chaque visite peut être vu comme une fausse urgence dans certains pays.");
    expect(tips).toHaveLength(1);
  });

  it("duration outside 1 min – 72 h: not saved, says why", () => {
    const { last } = edit(evergreen({ durationSeconds: 120 }));
    fireEvent.change(screen.getByLabelText("Minutes"), { target: { value: "0" } });
    expect(screen.getByRole("alert").textContent).toBe("Entre 1 minute et 72 heures.");
    expect(last().props.durationSeconds).toBe(120);
    fireEvent.change(screen.getByLabelText("Heures"), { target: { value: "73" } });
    expect(screen.getByRole("alert").textContent).toBe("Entre 1 minute et 72 heures.");
    fireEvent.change(screen.getByLabelText("Heures"), { target: { value: "72" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(last().props.durationSeconds).toBe(72 * 3600);
    fireEvent.change(screen.getByLabelText("Secondes"), { target: { value: "abc" } });
    expect(screen.getByRole("alert").textContent).toBe("Chiffres uniquement.");
  });

  it("the preview animates (builder): ticks without touching localStorage", async () => {
    vi.useFakeTimers({ now: T0 });
    render(h(ContentBlock, { block: evergreen({ restart: "keep" }, "prev") as Block, ctx: ctx({ preview: true }) }));
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(timerText()).toBe("00:14:57");
    expect(localStorage.getItem("wc-countdown:store1:prev")).toBeNull();
  });
});
