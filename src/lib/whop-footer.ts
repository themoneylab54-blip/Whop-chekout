import "server-only";
import { db } from "./db";
import { env } from "./env";
import { log } from "./log";
import { DELETED_SUFFIX, isDeletedFingerprint, isPaypalFingerprint } from "./checkout";
import { WHOP_FOOTER } from "@/components/checkout/whopFooterFit";

/*
 * Whether the checkout clips Whop's « Propulsé par Whop » footer off its card form (see
 * components/checkout/whopFooterFit: the height cut comes from Whop's layout, measured). Two conditions:
 * - the merchant asked for it (Store.whopFooterHidden, Réglages › Whop). Whop treats that line — its
 *   logo, its Buyer Terms and Privacy links — as its merchant-of-record notice, so it shows by default;
 * - Whop's own page still ends that store's form with that exact footer: read on Whop's
 *   server-rendered page for one of the store's own card checkouts (each store has its own Whop
 *   account), as the checkout shows it (its terms line hidden or not, the card kept for an offer or
 *   not), per checkout language and Whop account, at most every 3 hours, on a checkout page view.
 * A page that reads but differs (Whop changed its form, or this account's form isn't the measured
 * one) turns the clip off at once; Whop's page out of reach keeps the last good answer one day at
 * most. The footer showing is always the safe side: never a clip that could hide anything else.
 */

/** Whop's footer words per checkout language (its own translations; the measured widths are these words'). */
export const WHOP_FOOTER_WORDS: Record<string, { powered: string; terms: string; privacy: string }> = WHOP_FOOTER;

/** A verdict this old is asked again (on the next checkout page of that store and language). */
const RECHECK_MS = 3 * 60 * 60 * 1000;
/** A good verdict this old no longer lets the checkout clip (Whop's page out of reach since). */
const VALID_MS = 24 * 60 * 60 * 1000;
/** One check at a time per store and language: another one only past this. */
const ATTEMPT_MS = 10 * 60 * 1000;
/** Whop's page is ~3 MB of HTML: read within this, up to this size. */
const FETCH_MS = 10_000;
const MAX_HTML = 8_000_000;
/** Only a card checkout this recent is read (an older one may have expired at Whop: never a false "changed"). */
const CONFIG_FRESH_MS = 60 * 60 * 1000;

type Stored = { ok: boolean; at: string; reason?: string; attemptAt?: string };

/** Whop's form as the checkout asks for it: its terms line hidden (the store's own terms box), the card kept for an offer. */
export type FooterVariant = { hideTos: boolean; saveCard: boolean };

/** The store's Whop account (sandbox or live): another account, or test mode switched, is another form, checked afresh. */
export type WhopAccountOf = { id: string; testMode: boolean; whopAccountId: string | null };

const PREFIX = (storeId: string) => `whop:footer:${storeId}:`;
const accountSuffix = (store: WhopAccountOf) => `:${whopHostOf(store.testMode)}:${store.whopAccountId ?? "-"}`;
const keyOf = (store: WhopAccountOf, lang: string, v: FooterVariant) => `${PREFIX(store.id)}${lang}:${v.hideTos ? "t" : "-"}${v.saveCard ? "s" : "-"}${accountSuffix(store)}`;

/** The Whop host of a store's checkouts. */
export function whopHostOf(testMode: boolean): string {
  return testMode ? "sandbox.whop.com" : "whop.com";
}

function parse(value: string | null | undefined): Stored | null {
  try {
    const v = JSON.parse(value ?? "null") as Stored | null;
    return v && typeof v.ok === "boolean" && typeof v.at === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Whether a stored verdict lets the checkout clip now. Pure. */
export function verdictClips(value: string | null | undefined, now = Date.now()): boolean {
  const v = parse(value);
  return !!v?.ok && now - Date.parse(v.at) < VALID_MS;
}

/** Whether the checkout page clips Whop's footer for this store (its choice), language and form (never throws). */
export async function whopFooterClipped(store: WhopAccountOf & { whopFooterHidden: boolean }, lang: string, variant: FooterVariant): Promise<boolean> {
  if (!store.whopFooterHidden || !WHOP_FOOTER_WORDS[lang]) return false;
  const row = await db.appSetting.findUnique({ where: { key: keyOf(store, lang, variant) } }).catch(() => null);
  return verdictClips(row?.value);
}

/**
 * The store's verdicts per language for the form its checkout now shows (that variant, its current
 * Whop account), for the settings page ("Whop changed its form"…): a language without one isn't
 * checked yet for this form.
 */
export async function whopFooterVerdicts(store: WhopAccountOf, variant: FooterVariant): Promise<Record<string, { ok: boolean; at: string; reason?: string; clips: boolean }>> {
  const rows = await db.appSetting.findMany({ where: { key: { startsWith: PREFIX(store.id) } } }).catch(() => []);
  const out: Record<string, { ok: boolean; at: string; reason?: string; clips: boolean }> = {};
  for (const r of rows) {
    const lang = r.key.slice(PREFIX(store.id).length).split(":")[0];
    // Its exact key (compared here: a LIKE pattern would read `_` in an account id as any character).
    if (r.key !== keyOf(store, lang, variant)) continue;
    const v = parse(r.value);
    if (v && WHOP_FOOTER_WORDS[lang] && Date.parse(v.at) > 0) out[lang] = { ok: v.ok, at: v.at, ...(v.reason ? { reason: v.reason } : {}), clips: verdictClips(r.value) };
  }
  return out;
}

/** Forgets a store's verdicts (the merchant shows the footer again: a later choice to hide it starts with a fresh check). */
export async function forgetWhopFooterVerdicts(storeId: string): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: { startsWith: PREFIX(storeId) } } });
}

const decode = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const textOf = (html: string) => decode(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();

/** A literal piece of a regular expression. */
const lit = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
/** After a piece of the page: only closing tags and React's empty boundaries up to a script (nothing drawn after it). */
const NOTHING_AFTER = "(?:</div>|<!--/?\\$-->)*<script\\b";
const LINK = (href: string) =>
  lit(`<a rel="noopener noreferrer" target="_blank" data-accent-color="gray" class="fui-Text fui-reset fui-Link !text-gray-10 leading-[1.2] whitespace-nowrap decoration-dotted underline-offset-2 hover:underline fui-underline-auto fui-r-size-1" href="${href}">`);

/*
 * The footer as measured, every opening tag exactly as Whop draws it (a class, a style or a `hidden`
 * more could change its size or hide part of it): its section (gap-2), after Whop's own pay button and
 * terms line when they show; Whop's centered wrapping row (mt-3, gap-4, 12 px text at line-height 1.2,
 * the h-4 divider) holding exactly « <powered> Whop », the divider, the terms and the privacy links;
 * that section the form's last, then Whop's empty spacer, last in the form's column: after it, only
 * closing tags and React's empty boundaries up to the next script (nothing drawn below).
 */
const FOOTER = new RegExp(
  lit('<div class="flex flex-col gap-2">') +
    '(?:<button type="submit"[^>]*>[^<]{0,80}</button>)?' +
    `(?:${lit('<span class="fui-Text text-gray-11 mt-2 text-center !text-[13px] !leading-[1.2] !tracking-[-0.09px] fui-r-size-1">')}[^<]{1,400}</span>)?` +
    lit('<div class="mt-3 flex w-full flex-wrap items-center gap-4 justify-center">') +
    lit('<a rel="noopener noreferrer" target="_blank" class="inline-flex items-center" href="https://whop.com">') +
    lit('<span class="fui-Text text-gray-10 leading-[1.2] fui-r-size-1">') +
    "([\\s\\S]{1,12000}?)</a>" +
    lit('<div class="border-stroke h-4 w-[1px] border-r"></div>') +
    LINK("https://whop.com/tos") +
    "([^<]{1,80})</a>" +
    LINK("https://whop.com/privacy/") +
    "([^<]{1,80})</a>" +
    lit('</div></div></div><div class="embedded-checkout-spacer w-full shrink-0"></div></div>') +
    NOTHING_AFTER,
);
/** The first item as measured: its words, then Whop's logo (1.1em high, 119 × 26) with its name for screen readers only. */
const POWERED = new RegExp(
  "^[^<]{1,60}" +
    lit('<span class="ml-1 inline-flex items-center align-middle"><svg class="text-gray-10 h-[1.1em] w-auto opacity-70 grayscale" fill="none" height="26" viewBox="0 0 119 26" width="119" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">') +
    "[\\s\\S]*" +
    lit('</svg><span class="sr-only">Whop</span></span></span>') +
    "$",
);
/** What the logo is drawn with: nothing else (no text, link or box) may hide in it, nothing styled or hidden. */
const LOGO_TAGS = new Set(["span", "svg", "g", "path", "defs", "clippath", "rect"]);
/** Whop's padding around its form, as measured (16 px each side, none under the spacer). */
const CONTAINER = '<div style="padding-top:32px;padding-bottom:0px;padding-left:16px;padding-right:16px" class="flex w-full flex-col gap-6">';
const SEGMENT = '<div hidden id="S:';

/** Where the React boundary opening at `start` (`<!--$?-->`) ends, after its closing marker; -1 if never. */
function boundaryEnd(html: string, start: number): number {
  const re = /<!--(\$[?!]?|\/\$)-->/g;
  re.lastIndex = start;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[1] === "/$" ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

/**
 * React streams Whop's page: the form arrives in a hidden segment that React moves into a placeholder
 * of another segment ($RS), which completes a boundary of the page shell ($RC). Nothing may be drawn
 * after the form's place at any of these levels: that, not the footer, is what the clip would hide.
 * From the form (at `at`) up to the page shell, 4 levels at most; an unknown structure says no. Pure.
 */
function nothingDrawnAfter(html: string, at: number): boolean {
  const after = new RegExp(`^${NOTHING_AFTER}`);
  let pos = at;
  for (let level = 0; level < 4; level++) {
    const open = html.lastIndexOf(SEGMENT, pos);
    // In the page shell (no segment holds it: none before it, or a script since, which ends a segment).
    if (open < 0 || html.slice(open, pos).includes("<script")) return true;
    const id = /^<div hidden id="S:(\d+)">/.exec(html.slice(open, open + 40))?.[1];
    if (!id) return false;
    const moved = [...html.matchAll(new RegExp(`\\$RS\\("S:${id}","(P:\\d+)"\\)`, "g"))];
    const completes = [...html.matchAll(new RegExp(`\\$RC\\("(B:\\d+)","S:${id}"\\)`, "g"))];
    if (moved.length + completes.length !== 1) return false;
    let place: number;
    let end: number;
    if (moved.length) {
      const tag = `<template id="${moved[0][1]}"></template>`;
      place = html.indexOf(tag);
      if (place < 0 || html.indexOf(tag, place + 1) >= 0) return false;
      end = place + tag.length;
    } else {
      place = html.indexOf(`<!--$?--><template id="${completes[0][1]}"></template>`);
      end = place < 0 ? -1 : boundaryEnd(html, place);
      if (end < 0) return false;
    }
    if (!after.test(html.slice(end, end + 4000))) return false;
    pos = place;
  }
  return false;
}

/**
 * Whop's page for one of the store's own checkouts (a live one, made minutes ago): may the footer be
 * clipped (ok), or not, with why — any page that isn't the measured form says no. Pure.
 */
export function footerVerdict(html: string, lang: string): { ok: true } | { ok: false; reason: string } {
  const words = WHOP_FOOTER_WORDS[lang];
  if (!words) return { ok: false, reason: "language" };
  if (!html.includes("embedded-checkout-container")) return { ok: false, reason: "page" };
  if (!/whop_checkout_branding\\?"\s*:\s*true/.test(html)) return { ok: false, reason: "branding_flag" };
  if (!html.includes(CONTAINER)) return { ok: false, reason: "container" };
  const m = FOOTER.exec(html);
  if (!m) return { ok: false, reason: "footer_markup" };
  const tags = [...m[1].matchAll(/<\/?([a-zA-Z][\w-]*)/g)].map((t) => t[1].toLowerCase());
  if (!POWERED.test(m[1]) || tags.some((t) => !LOGO_TAGS.has(t)) || /\s(?:style|hidden)[\s=>]/i.test(m[1])) return { ok: false, reason: "footer_content" };
  if (textOf(m[1]) !== words.powered || textOf(m[2]) !== words.terms || textOf(m[3]) !== words.privacy) return { ok: false, reason: "footer_words" };
  if (!nothingDrawnAfter(html, m.index)) return { ok: false, reason: "after_form" };
  return { ok: true };
}

/**
 * The HTML of Whop's page for a checkout configuration, as the checkout's frame loads it (the store's
 * checkout origin, its language, its form variant: see @whop/checkout's getEmbeddedCheckoutIframeUrl);
 * else why it couldn't be read.
 */
async function whopPage(host: string, configId: string, lang: string, variant: FooterVariant, checkoutOrigin: string): Promise<{ html: string } | { failed: string }> {
  let origin: string;
  try {
    origin = new URL(checkoutOrigin).origin;
  } catch {
    origin = new URL(env.appUrl).origin;
  }
  const url = new URL(`https://${host}/embedded/checkout/${encodeURIComponent(configId)}/`);
  const params: [string, string][] = [
    ["h", origin],
    ["v", "3"],
    ["t", new URL(origin).hostname],
    ["theme", "light"],
    ["locale", lang],
    ["session", configId],
    ["hide_submit_button", "true"],
    ...(variant.hideTos ? ([["hide_tos", "true"]] as [string, string][]) : []),
    ["email.hidden", "1"],
    ["address.hidden", "1"],
    ...(variant.saveCard ? ([["setup_future_usage", "off_session"]] as [string, string][]) : []),
  ];
  for (const [k, v] of params) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS), redirect: "error", headers: { Accept: "text/html", "Accept-Language": lang } });
    if (!res.ok || !res.body) {
      // The connection is freed at once (the body is never read).
      await res.body?.cancel().catch(() => undefined);
      return { failed: `status_${res.status}` };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let html = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (html.length > MAX_HTML) {
        await reader.cancel().catch(() => undefined);
        return { failed: "too_large" };
      }
    }
    return { html: html + decoder.decode() };
  } catch (err) {
    // TimeoutError (FETCH_MS), TypeError (a redirect: to Whop's login, say, or the network).
    return { failed: err instanceof Error ? err.name : "error" };
  }
}

/**
 * Asks Whop's page again when this store's verdict for that language and form is missing or 3 hours
 * old, with the session's own card checkout (waited for a few seconds while its first prepare runs:
 * a page that never prepares one asks nothing, and blocks nothing). Runs after the page's answer;
 * never throws.
 */
export async function refreshWhopFooterCheck(opts: { store: WhopAccountOf; lang: string; variant: FooterVariant; sessionId: string; origin: string }): Promise<void> {
  const { store, lang, variant } = opts;
  if (!WHOP_FOOTER_WORDS[lang]) return;
  const key = keyOf(store, lang, variant);
  const ctx = { storeId: store.id, lang };
  try {
    const due = async () => {
      const row = await db.appSetting.findUnique({ where: { key } });
      const stored = parse(row?.value);
      const now = Date.now();
      if (stored && now - Date.parse(stored.at) < RECHECK_MS) return null;
      if (stored?.attemptAt && now - Date.parse(stored.attemptAt) < ATTEMPT_MS) return null;
      return { row, stored };
    };
    if (!(await due())) return;
    const configId = await sessionCardConfig(opts.sessionId);
    if (!configId) return;
    // One check at a time: the attempt is marked first (a missing row is created, an existing one
    // taken only if nobody marked it meanwhile).
    const state = await due();
    if (!state) return;
    const { row, stored } = state;
    const mark: Stored = { ...(stored ?? { ok: false, at: new Date(0).toISOString() }), attemptAt: new Date().toISOString() };
    if (row) {
      const taken = await db.appSetting.updateMany({ where: { key, value: row.value }, data: { value: JSON.stringify(mark) } });
      if (!taken.count) return;
    } else {
      const created = await db.appSetting.createMany({ data: [{ key, value: JSON.stringify(mark) }], skipDuplicates: true });
      if (!created.count) return;
    }
    const page = await whopPage(whopHostOf(store.testMode), configId, lang, variant, opts.origin);
    // Whop's page out of reach: the last answer stays (one day at most for a good one), the next page asks again.
    if ("failed" in page) {
      log.info("whop.footer_check_unreachable", "Whop's checkout page could not be read for the footer check", { ...ctx, why: page.failed, keptOk: !!stored?.ok });
      return;
    }
    const verdict = footerVerdict(page.html, lang);
    const value: Stored = { ok: verdict.ok, at: new Date().toISOString(), ...(verdict.ok ? {} : { reason: verdict.reason }) };
    // Written over this check's own mark only: the merchant showing the footer again meanwhile
    // (the verdicts forgotten) is never undone by a check that started before.
    const written = await db.appSetting.updateMany({ where: { key, value: JSON.stringify(mark) }, data: { value: JSON.stringify(value) } });
    if (!written.count) return;
    if (!verdict.ok) log.warn("whop.footer_not_clipped", "Whop's checkout form isn't the measured one: its footer shows on the checkout", { ...ctx, reason: verdict.reason, wasOk: !!stored?.ok });
  } catch (err) {
    log.warn("whop.footer_check_failed", "Whop footer check failed", { ...ctx, err });
  }
}

/**
 * The session's latest card checkout at Whop, made within the hour: never its PayPal-only one (another
 * form), nor one deleted at a switch to Stripe (see snapshotFingerprint). Waited for up to 8 s (the
 * session's first prepare may still be running).
 */
async function sessionCardConfig(sessionId: string): Promise<string | null> {
  const until = Date.now() + 8_000;
  for (;;) {
    const quote = await db.checkoutQuote.findFirst({
      where: {
        sessionId,
        provider: "whop",
        whopCheckoutId: { not: null },
        createdAt: { gte: new Date(Date.now() - CONFIG_FRESH_MS) },
        NOT: [{ fingerprint: { contains: "|m:paypal" } }, { fingerprint: { endsWith: DELETED_SUFFIX } }],
      },
      orderBy: { createdAt: "desc" },
      select: { whopCheckoutId: true, fingerprint: true },
    });
    if (quote?.whopCheckoutId && !isPaypalFingerprint(quote.fingerprint) && !isDeletedFingerprint(quote.fingerprint)) return quote.whopCheckoutId;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 500));
  }
}
