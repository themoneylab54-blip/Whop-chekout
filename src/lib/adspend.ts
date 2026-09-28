import "server-only";
import { extFetch } from "./ext";
import { db } from "./db";
import { decrypt } from "./crypto";
import { log, recordEvent } from "./log";
import { assertTime, boundedTimeout, DeadlineError, notePartial, stopForTime, timeLeft } from "./deadline";
import { addDays, tzOf, zonedDay } from "./time";
import { asValueMode, dayValueMode, valueModeHistory } from "./value-mode";
import { crossRate, refreshEcbRates } from "./fx";
import { fetchGoogleAds, googleAccessToken } from "./adspend-google";
import { reportStuckImport } from "./shopify-history";

/*
 * Daily ad spend per campaign (plus ad sets and ads for the creative table), pulled from the Meta Marketing API, the TikTok Business
 * API and the Google Ads API (adspend-google.ts; last 7 days, re-imported so late corrections land), for ROAS / CPA / profit after ads.
 * Runs from the background tick, at most hourly per store; one store's failure never stops
 * the others. The last run's outcome is kept in AppSetting `adspend:<storeId>` for the
 * dashboard. Spend can also be typed in by hand or pasted as CSV. Spend billed in another currency than the store's is converted with the
 * ECB reference rate (original amount, currency and rate kept on the row); without a rate the
 * row keeps its original currency and the dashboard shows a blocking warning.
 */

const FETCH_TIMEOUT_MS = 10_000;
const LOOKBACK_DAYS = 7;
const MIN_INTERVAL_MS = 60 * 60_000;
/**
 * Time kept before the run's hard deadline to start a platform (one slow call per platform). Measured
 * against the tick's hard deadline (the job's own deadline only stops new stores / platforms).
 */
const RESERVE_MS = 2 * FETCH_TIMEOUT_MS + 1_000;

/**
 * Before one more page of a platform's report: inside the tick, the page's call must fit before the
 * run's hard deadline; outside (dashboard button), before the caller's deadline. DeadlineError
 * otherwise: the platform is postponed to the next run — never an import failure (no alert).
 */
function assertPageTime(deadline: number, what: string) {
  if (timeLeft() != null) assertTime(FETCH_TIMEOUT_MS + 1_000, what);
  else if (Date.now() > deadline - FETCH_TIMEOUT_MS) throw new DeadlineError(what);
}
const MAX_PAGES = 20;

export const AD_PLATFORMS = { meta: "Meta", tiktok: "TikTok", google: "Google Ads", other: "Autre" } as const;
export type AdPlatform = keyof typeof AD_PLATFORMS;

export type SpendRecord = {
  day: string;
  campaignId: string;
  campaignName: string;
  spendCents: number;
  currency: string;
  /** What the platform itself reports (its own attribution): purchases, their value (same currency as the spend) and ROAS. */
  conversions?: number | null;
  conversionValueCents?: number | null;
  platformRoas?: number | null;
};

type MetaAction = { action_type?: string; value?: string | number };
/** Purchase action types, most complete first (omni = web + app + offline). */
const META_PURCHASE = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"];

/** Meta's purchases in an `actions` / `action_values` / `purchase_roas` list: the first purchase type present. Pure. */
export function metaPurchase(list: unknown): number | null {
  if (!Array.isArray(list)) return null;
  for (const type of META_PURCHASE) {
    const hit = (list as MetaAction[]).find((a) => a?.action_type === type);
    if (hit && hit.value != null && Number.isFinite(Number(hit.value))) return Number(hit.value);
  }
  return null;
}

export type ImportStatus = {
  at: string;
  /** `rows` = campaign × day rows; `details` = ad set / ad × day rows (creative table). */
  platforms: Partial<Record<"meta" | "tiktok" | "google", { /** When this platform was last imported (success or failure). */ at?: string; ok: boolean; rows: number; details?: number; detailError?: string; error?: string; currency?: string; unconverted?: string[] }>>;
};

const statusKey = (storeId: string) => `adspend:${storeId}`;

/** A platform imported less than an hour ago (its own time; older statuses: the run's). Pure. */
export function platformFresh(prev: ImportStatus | null, platform: "meta" | "tiktok" | "google", now = Date.now()): boolean {
  const at = prev?.platforms[platform]?.at ?? (prev?.platforms[platform] ? prev.at : undefined);
  return !!at && now - Date.parse(at) < MIN_INTERVAL_MS;
}

export async function adSpendStatus(storeId: string): Promise<ImportStatus | null> {
  const row = await db.appSetting.findUnique({ where: { key: statusKey(storeId) } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as ImportStatus;
  } catch {
    return null;
  }
}

/** "12.34" → 1234 (spend comes as decimal strings in the account currency). */
export function toCents(v: unknown): number {
  const x = typeof v === "number" ? v : Number.parseFloat(String(v ?? "0"));
  return Number.isFinite(x) ? Math.round(x * 100) : 0;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await extFetch(url.includes("tiktok") ? "tiktok" : "meta", "ad spend report", url, { headers, signal: AbortSignal.timeout(boundedTimeout(FETCH_TIMEOUT_MS, "dépenses publicitaires")), cache: "no-store" });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string }; message?: string } | null)?.error?.message ?? (body as { message?: string } | null)?.message;
    throw new Error(`HTTP ${res.status}${msg ? ` : ${msg}` : ""}`);
  }
  return body;
}

/**
 * Spend level of a row. Campaign rows are the only ones summed into totals (ROAS, spend, P&L);
 * ad set and ad rows are stored next to them with `campaignId` = "adset:<id>" / "ad:<id>" for the
 * creative-level table (never added to the totals: that would count the same money twice).
 */
export type SpendLevel = "campaign" | "adset" | "ad";
export const DETAIL_PREFIX = { adset: "adset:", ad: "ad:" } as const;

/** Level of a stored AdSpend row from its campaignId. Pure. */
export function spendLevel(campaignId: string): SpendLevel {
  return campaignId.startsWith(DETAIL_PREFIX.adset) ? "adset" : campaignId.startsWith(DETAIL_PREFIX.ad) ? "ad" : "campaign";
}

/** Prisma filter: campaign-level rows only (the ones every total uses). */
export const CAMPAIGN_ROWS = { NOT: [{ campaignId: { startsWith: DETAIL_PREFIX.adset } }, { campaignId: { startsWith: DETAIL_PREFIX.ad } }] };

const META_FIELDS: Record<SpendLevel, [id: string, name: string]> = {
  campaign: ["campaign_id", "campaign_name"],
  adset: ["adset_id", "adset_name"],
  ad: ["ad_id", "ad_name"],
};

/** Meta Marketing API: campaign / ad set / ad × day insights. Pure parsing exported for tests. */
export function parseMetaInsights(body: unknown, fallbackCurrency: string, level: SpendLevel = "campaign"): SpendRecord[] {
  const data = (body as { data?: unknown[] } | null)?.data ?? [];
  const [idKey, nameKey] = META_FIELDS[level];
  const prefix = level === "campaign" ? "" : DETAIL_PREFIX[level];
  return (data as Record<string, unknown>[])
    .filter((r) => r && typeof r.date_start === "string" && r[idKey] != null)
    .map((r) => ({
      day: String(r.date_start),
      campaignId: `${prefix}${String(r[idKey])}`,
      campaignName: String(r[nameKey] ?? r[idKey]),
      spendCents: toCents(r.spend),
      currency: String(r.account_currency ?? fallbackCurrency).toUpperCase(),
      ...metaFigures(r),
    }));
}

/** Meta's reported purchases, their value and purchase ROAS for one insights row. Pure. */
function metaFigures(r: Record<string, unknown>): Pick<SpendRecord, "conversions" | "conversionValueCents" | "platformRoas"> {
  // Nothing reported (fields not asked, older API answers): no figures at all, never zeros.
  if (r.actions === undefined && r.action_values === undefined && r.purchase_roas === undefined) return {};
  const conversions = metaPurchase(r.actions);
  const value = metaPurchase(r.action_values);
  const roas = metaPurchase(r.purchase_roas);
  return {
    conversions: conversions ?? (r.actions ? 0 : null),
    conversionValueCents: value != null ? Math.round(value * 100) : r.action_values ? 0 : null,
    platformRoas: roas != null ? Math.round(roas * 1000) / 1000 : null,
  };
}

async function fetchMeta(accountId: string, token: string, since: string, until: string, currency: string, deadline: number, level: SpendLevel = "campaign"): Promise<SpendRecord[]> {
  const url = new URL(`https://graph.facebook.com/v21.0/act_${accountId.replace(/^act_/, "")}/insights`);
  url.searchParams.set("level", level);
  url.searchParams.set("time_increment", "1");
  url.searchParams.set("fields", [...META_FIELDS[level], "spend", "account_currency", "actions", "action_values", "purchase_roas"].join(","));
  url.searchParams.set("time_range", JSON.stringify({ since, until }));
  url.searchParams.set("limit", "500");
  url.searchParams.set("access_token", token);
  const out: SpendRecord[] = [];
  let next: string | null = url.toString();
  for (let page = 0; next && page < MAX_PAGES; page++) {
    assertPageTime(deadline, "import Meta");
    const body = (await getJson(next)) as { paging?: { next?: string } };
    out.push(...parseMetaInsights(body, currency, level));
    next = body?.paging?.next ?? null;
  }
  return out;
}

const TIKTOK_LEVEL: Record<SpendLevel, { dataLevel: string; id: string; name: string }> = {
  campaign: { dataLevel: "AUCTION_CAMPAIGN", id: "campaign_id", name: "campaign_name" },
  adset: { dataLevel: "AUCTION_ADGROUP", id: "adgroup_id", name: "adgroup_name" },
  ad: { dataLevel: "AUCTION_AD", id: "ad_id", name: "ad_name" },
};

/** TikTok's complete-payment conversions, their value and ROAS. Pure. */
function tiktokFigures(m: Record<string, unknown> | undefined): Pick<SpendRecord, "conversions" | "conversionValueCents" | "platformRoas"> {
  const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const conversions = num(m?.complete_payment);
  const value = num(m?.total_complete_payment_rate);
  const roas = num(m?.complete_payment_roas);
  if (conversions == null && value == null && roas == null) return {};
  return { conversions, conversionValueCents: value != null ? Math.round(value * 100) : null, platformRoas: roas != null ? Math.round(roas * 1000) / 1000 : null };
}

/** TikTok Business API integrated report (BASIC, campaign / ad group / ad × day). Pure parsing exported for tests. */
export function parseTiktokReport(body: unknown, currency: string, level: SpendLevel = "campaign"): { rows: SpendRecord[]; totalPages: number } {
  const b = body as { code?: number; message?: string; data?: { list?: unknown[]; page_info?: { total_page?: number } } } | null;
  if (b?.code !== 0) throw new Error(`TikTok ${b?.code ?? "?"} : ${b?.message ?? "réponse invalide"}`);
  const { id, name } = TIKTOK_LEVEL[level];
  const prefix = level === "campaign" ? "" : DETAIL_PREFIX[level];
  const rows = ((b.data?.list ?? []) as { dimensions?: Record<string, unknown>; metrics?: Record<string, unknown> }[])
    .filter((r) => r.dimensions?.[id] != null && r.dimensions?.stat_time_day != null)
    .map((r) => ({
      day: String(r.dimensions!.stat_time_day).slice(0, 10),
      campaignId: `${prefix}${String(r.dimensions![id])}`,
      campaignName: String(r.metrics?.[name] ?? r.dimensions![id]),
      spendCents: toCents(r.metrics?.spend),
      currency,
      ...tiktokFigures(r.metrics),
    }));
  return { rows, totalPages: b.data?.page_info?.total_page ?? 1 };
}

async function fetchTiktok(advertiserId: string, token: string, since: string, until: string, currency: string, deadline: number, level: SpendLevel = "campaign"): Promise<SpendRecord[]> {
  const out: SpendRecord[] = [];
  const l = TIKTOK_LEVEL[level];
  for (let page = 1; page <= MAX_PAGES; page++) {
    assertPageTime(deadline, "import TikTok");
    const url = new URL("https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/");
    url.searchParams.set("advertiser_id", advertiserId);
    url.searchParams.set("report_type", "BASIC");
    url.searchParams.set("data_level", l.dataLevel);
    url.searchParams.set("dimensions", JSON.stringify([l.id, "stat_time_day"]));
    url.searchParams.set("metrics", JSON.stringify(["spend", l.name, "complete_payment", "total_complete_payment_rate", "complete_payment_roas"]));
    url.searchParams.set("start_date", since);
    url.searchParams.set("end_date", until);
    url.searchParams.set("page", String(page));
    url.searchParams.set("page_size", "1000");
    const { rows, totalPages } = parseTiktokReport(await getJson(url.toString(), { "Access-Token": token }), currency, level);
    out.push(...rows);
    if (page >= totalPages) break;
  }
  return out;
}

/**
 * Spend row in the store currency: converted with `rates` when the record is in another
 * currency (original kept), or left in its own currency (flagged) when no rate is known. Pure.
 */
export function convertSpend(
  r: { spendCents: number; currency: string },
  storeCurrency: string,
  rates: Record<string, number> | null,
): { spendCents: number; currency: string; originalSpendCents: number | null; originalCurrency: string | null; fxRate: number | null } {
  const from = r.currency.toUpperCase();
  const to = storeCurrency.toUpperCase();
  if (from === to) return { spendCents: r.spendCents, currency: to, originalSpendCents: null, originalCurrency: null, fxRate: null };
  const rate = rates ? crossRate(from, to, rates) : null;
  if (rate == null) return { spendCents: r.spendCents, currency: from, originalSpendCents: r.spendCents, originalCurrency: from, fxRate: null };
  return { spendCents: Math.round(r.spendCents * rate), currency: to, originalSpendCents: r.spendCents, originalCurrency: from, fxRate: rate };
}

/**
 * Upserts spend records (campaign × day) for a platform, converted to the store currency. Rows with
 * platform-reported conversions record which value the platform received that day (`valueModeOf`:
 * "revenue", "profit" or "mixed"; see value-mode.ts).
 */
export async function saveSpendRows(
  storeId: string,
  storeCurrency: string,
  platform: string,
  rows: SpendRecord[],
  valueModeOf?: (day: string) => string | null,
): Promise<{ written: number; unconverted: string[] }> {
  // Several rows for one campaign × day (shouldn't happen, but pagination overlaps would double count): keep the last.
  const unique = new Map(rows.map((r) => [`${r.day}|${r.campaignId}`, r]));
  const needsFx = [...unique.values()].some((r) => r.currency.toUpperCase() !== storeCurrency.toUpperCase());
  // Background job: may fetch the ECB itself (buyers only ever read the cache).
  const rates = needsFx ? ((await refreshEcbRates({ backoff: false }))?.rates ?? null) : null;
  const unconverted = new Set<string>();
  const ops = [...unique.values()].map((r) => {
    const c = convertSpend(r, storeCurrency, rates);
    if (c.originalCurrency && c.fxRate == null) unconverted.add(c.originalCurrency);
    // The platform's reported conversion value is in the spend's currency: converted at the same rate.
    const reported =
      r.conversions !== undefined || r.conversionValueCents !== undefined || r.platformRoas !== undefined
        ? {
            platformConversions: r.conversions ?? null,
            platformConversionValueCents: r.conversionValueCents == null ? null : c.fxRate != null ? Math.round(r.conversionValueCents * c.fxRate) : r.conversionValueCents,
            platformRoas: r.platformRoas ?? null,
            ...(valueModeOf ? { valueMode: valueModeOf(r.day) } : {}),
          }
        : {};
    const data = { campaignName: r.campaignName.slice(0, 200), ...c, ...reported };
    return db.adSpend.upsert({
      where: { storeId_day_platform_campaignId: { storeId, day: r.day, platform, campaignId: r.campaignId } },
      create: { storeId, day: r.day, platform, campaignId: r.campaignId, ...data },
      update: data,
    });
  });
  for (let i = 0; i < ops.length; i += 100) await db.$transaction(ops.slice(i, i + 100));
  return { written: unique.size, unconverted: [...unconverted] };
}

const errorText = (err: unknown) => (err instanceof Error ? (err.name === "TimeoutError" ? "délai de 10 s dépassé" : err.message) : String(err)).slice(0, 300);

/**
 * Imports the last 7 days of spend for every store with an ad account configured.
 * Returns the number of campaign-day rows written (ad set / ad rows are stored too, not counted). `opts.storeId` + `force` run one store now
 * (dashboard button), ignoring the hourly throttle.
 */
export async function importAdSpend(deadline: number, opts: { storeId?: string; force?: boolean } = {}): Promise<number> {
  const stores = await db.store.findMany({
    where: {
      ...(opts.storeId ? { id: opts.storeId } : {}),
      OR: [
        { metaAdAccountId: { not: null }, metaAccessToken: { not: null } },
        { tiktokAdvertiserId: { not: null }, tiktokAccessToken: { not: null } },
        { googleAdsCustomerId: { not: null }, googleAdsRefreshToken: { not: null }, googleAdsDeveloperToken: { not: null } },
      ],
    },
    select: {
      id: true,
      shopCurrency: true,
      metaAdAccountId: true,
      metaAccessToken: true,
      tiktokAdvertiserId: true,
      tiktokAccessToken: true,
      googleAdsCustomerId: true,
      googleAdsLoginCustomerId: true,
      googleAdsDeveloperToken: true,
      googleAdsClientId: true,
      googleAdsClientSecret: true,
      googleAdsRefreshToken: true,
      timezone: true,
      conversionValueMode: true,
    },
  });
  let written = 0;
  for (const store of stores) {
    if (stopForTime(deadline)) break;
    // Days of the store's time zone (the ad accounts report in theirs: usually the same).
    const tz = tzOf(store);
    const until = zonedDay(new Date(), tz);
    const since = addDays(until, -(LOOKBACK_DAYS - 1));
    const prev = await adSpendStatus(store.id);
    // Hourly per platform: a run cut short by its time budget leaves only the platforms it didn't reach
    // due (the ones imported keep their hour), so a slow platform can't make the others wait forever.
    const due = (platform: "meta" | "tiktok" | "google") => opts.force || !platformFresh(prev, platform);
    if (!opts.force && prev && Date.now() - Date.parse(prev.at) < MIN_INTERVAL_MS) continue;
    const status: ImportStatus = { at: new Date().toISOString(), platforms: {} };
    const history = await valueModeHistory(store.id);
    const modeOf = (platform: string) => (day: string) => dayValueMode(platform, day, history, asValueMode(store.conversionValueMode), tz);
    const jobs: ["meta" | "tiktok" | "google", (level: SpendLevel) => Promise<SpendRecord[]>][] = [];
    if (store.metaAdAccountId && store.metaAccessToken)
      jobs.push(["meta", (level) => fetchMeta(store.metaAdAccountId!, decrypt(store.metaAccessToken!), since, until, store.shopCurrency, deadline, level)]);
    if (store.tiktokAdvertiserId && store.tiktokAccessToken)
      jobs.push(["tiktok", (level) => fetchTiktok(store.tiktokAdvertiserId!, decrypt(store.tiktokAccessToken!), since, until, store.shopCurrency, deadline, level)]);
    if (store.googleAdsCustomerId && store.googleAdsRefreshToken && store.googleAdsDeveloperToken && store.googleAdsClientId && store.googleAdsClientSecret) {
      const creds = {
        customerId: store.googleAdsCustomerId,
        loginCustomerId: store.googleAdsLoginCustomerId,
        developerToken: decrypt(store.googleAdsDeveloperToken),
        clientId: store.googleAdsClientId,
        clientSecret: decrypt(store.googleAdsClientSecret),
        refreshToken: decrypt(store.googleAdsRefreshToken),
      };
      // One OAuth exchange per import, shared by the campaign / ad group / ad reports.
      let token: Promise<string> | null = null;
      jobs.push(["google", async (level) => fetchGoogleAds(creds, await (token ??= googleAccessToken(creds)), since, until, store.shopCurrency, level)]);
    }
    // A platform that can't start before the deadline is left for the next run (not a failure).
    let postponed = false;
    for (const [platform, run] of jobs) {
      if (!due(platform)) continue;
      if (stopForTime(deadline, RESERVE_MS)) {
        postponed = true;
        break;
      }
      try {
        const rows = await run("campaign");
        const saved = await saveSpendRows(store.id, store.shopCurrency, platform, rows, modeOf(platform));
        written += saved.written;
        const foreign = rows.find((r) => r.currency.toUpperCase() !== store.shopCurrency.toUpperCase())?.currency;
        // Ad set and ad levels (creative table): best effort, a failure never loses the campaign import.
        let details = 0;
        let detailError: string | undefined;
        for (const level of ["adset", "ad"] as const) {
          if (stopForTime(deadline, RESERVE_MS)) {
            detailError = "temps imparti dépassé (ad sets / publicités non importés)";
            break;
          }
          try {
            details += (await saveSpendRows(store.id, store.shopCurrency, platform, await run(level), modeOf(platform))).written;
          } catch (err) {
            if (err instanceof DeadlineError) {
              notePartial();
              detailError = "temps imparti dépassé (ad sets / publicités non importés)";
              break;
            }
            detailError = errorText(err);
            log.warn("adspend.detail_failed", `Ad spend detail import failed (${platform}, ${level})`, { storeId: store.id, err });
            break;
          }
        }
        status.platforms[platform] = {
          at: new Date().toISOString(),
          ok: true,
          rows: saved.written,
          details,
          ...(detailError ? { detailError } : {}),
          ...(foreign ? { currency: foreign } : {}),
          ...(saved.unconverted.length ? { unconverted: saved.unconverted } : {}),
        };
      } catch (err) {
        if (err instanceof DeadlineError) {
          notePartial();
          postponed = true;
          break;
        }
        const error = errorText(err);
        status.platforms[platform] = { at: new Date().toISOString(), ok: false, rows: 0, error };
        log.warn("adspend.import_failed", `Ad spend import failed (${platform})`, { storeId: store.id, err });
        await recordEvent({
          storeId: store.id,
          level: "warn",
          kind: "adspend.import_failed",
          message:
            platform === "google"
              ? `Import des dépenses Google Ads impossible : ${error}. Vérifiez l'identifiant client (et le compte administrateur MCC), le jeton développeur (accès « Basic » approuvé) et le jeton d'actualisation OAuth.`
              : `Import des dépenses ${AD_PLATFORMS[platform]} impossible : ${error}. Vérifiez l'identifiant du compte publicitaire et les droits du jeton (lecture des publicités).`,
          data: { platform },
          alert: true,
        });
      }
    }
    // Platforms not imported by this run (fresh, or not reached) keep their last known state.
    status.platforms = { ...prev?.platforms, ...status.platforms };
    if (postponed) {
      // Keep the last complete import time (the hourly throttle doesn't hold the rest back: the next
      // run imports the platforms not reached, and only them).
      status.at = prev?.at && Date.now() - Date.parse(prev.at) >= MIN_INTERVAL_MS ? prev.at : new Date(0).toISOString();
    }
    await db.appSetting.upsert({
      where: { key: statusKey(store.id) },
      create: { key: statusKey(store.id), value: JSON.stringify(status) },
      update: { value: JSON.stringify(status) },
    });
  }
  return written;
}

/* ------------------------------------------------------------------ */
/* History backfill (13 months)                                        */
/* ------------------------------------------------------------------ */

/*
 * When an ad account is connected (or on the first import after this was added), its past spend is
 * imported backwards from the regular 7-day window, one chunk per platform per run, down to 13 months
 * (Meta keeps 37 months of insights, TikTok and Google Ads at least 13: 13 are what the CAC 12 mois
 * and the year-over-year views need). Campaign level only (ad sets / ads stay on the recent window).
 * The cursor (earliest day covered) is kept per platform in AppSetting `adspend-backfill:<storeId>`;
 * a new account id starts over. Coverage (spendCoverage) tells the dashboard from which day every
 * connected platform's spend is known.
 */

export const BACKFILL_DAYS = 396;
const BACKFILL_CHUNK_DAYS = 31;
const BACKFILL_RETRY_MS = 6 * 3600_000;

export type BackfillPlatform = {
  account: string;
  target: string;
  cursor: string;
  done: boolean;
  at: string;
  error?: string;
  /** First failure of the current error streak (cleared by a success): an incident past 48 h. */
  errorSince?: string;
};
export type BackfillState = { platforms: Partial<Record<"meta" | "tiktok" | "google", BackfillPlatform>> };

const backfillKey = (storeId: string) => `adspend-backfill:${storeId}`;

export async function adSpendBackfillStatus(storeId: string): Promise<BackfillState | null> {
  const row = await db.appSetting.findUnique({ where: { key: backfillKey(storeId) } });
  if (!row) return null;
  try {
    return JSON.parse(row.value) as BackfillState;
  } catch {
    return null;
  }
}

/** Next chunk [since, until] to import below `cursor`, or null when the target is reached. Pure. */
export function nextBackfillChunk(p: Pick<BackfillPlatform, "target" | "cursor" | "done">, chunkDays = BACKFILL_CHUNK_DAYS): { since: string; until: string } | null {
  if (p.done || p.cursor <= p.target) return null;
  const until = addDays(p.cursor, -1);
  const floor = addDays(until, -(chunkDays - 1));
  return { since: floor < p.target ? p.target : floor, until };
}

/** Imports one backward chunk per connected platform and store. Returns the campaign-day rows written. */
export async function backfillAdSpend(deadline: number, opts: { storeId?: string; now?: Date } = {}): Promise<number> {
  const stores = await db.store.findMany({
    where: {
      ...(opts.storeId ? { id: opts.storeId } : {}),
      OR: [
        { metaAdAccountId: { not: null }, metaAccessToken: { not: null } },
        { tiktokAdvertiserId: { not: null }, tiktokAccessToken: { not: null } },
        { googleAdsCustomerId: { not: null }, googleAdsRefreshToken: { not: null }, googleAdsDeveloperToken: { not: null } },
      ],
    },
  });
  let written = 0;
  for (const store of stores) {
    if (stopForTime(deadline)) break;
    const tz = tzOf(store);
    const today = zonedDay(opts.now ?? new Date(), tz);
    const history = await valueModeHistory(store.id);
    const modeOf = (platform: string) => (day: string) => dayValueMode(platform, day, history, asValueMode(store.conversionValueMode), tz);
    const state: BackfillState = (await adSpendBackfillStatus(store.id)) ?? { platforms: {} };
    const jobs: ["meta" | "tiktok" | "google", string, (since: string, until: string) => Promise<SpendRecord[]>][] = [];
    if (store.metaAdAccountId && store.metaAccessToken)
      jobs.push(["meta", store.metaAdAccountId, (since, until) => fetchMeta(store.metaAdAccountId!, decrypt(store.metaAccessToken!), since, until, store.shopCurrency, deadline)]);
    if (store.tiktokAdvertiserId && store.tiktokAccessToken)
      jobs.push(["tiktok", store.tiktokAdvertiserId, (since, until) => fetchTiktok(store.tiktokAdvertiserId!, decrypt(store.tiktokAccessToken!), since, until, store.shopCurrency, deadline)]);
    if (store.googleAdsCustomerId && store.googleAdsRefreshToken && store.googleAdsDeveloperToken && store.googleAdsClientId && store.googleAdsClientSecret) {
      const creds = {
        customerId: store.googleAdsCustomerId,
        loginCustomerId: store.googleAdsLoginCustomerId,
        developerToken: decrypt(store.googleAdsDeveloperToken),
        clientId: store.googleAdsClientId,
        clientSecret: decrypt(store.googleAdsClientSecret),
        refreshToken: decrypt(store.googleAdsRefreshToken),
      };
      jobs.push(["google", store.googleAdsCustomerId, async (since, until) => fetchGoogleAds(creds, await googleAccessToken(creds), since, until, store.shopCurrency, "campaign")]);
    }
    let changed = false;
    for (const [platform, account, run] of jobs) {
      if (stopForTime(deadline, RESERVE_MS)) break;
      let p = state.platforms[platform];
      if (!p || p.account !== account) {
        // Starts right below the regular import's window (last 7 days).
        p = { account, target: addDays(today, -(BACKFILL_DAYS - 1)), cursor: addDays(today, -(LOOKBACK_DAYS - 1)), done: false, at: new Date().toISOString() };
        state.platforms[platform] = p;
        changed = true;
      }
      if (p.error && Date.now() - Date.parse(p.at) < BACKFILL_RETRY_MS) continue;
      const chunk = nextBackfillChunk(p);
      if (!chunk) {
        if (!p.done) {
          p.done = true;
          changed = true;
        }
        continue;
      }
      try {
        const saved = await saveSpendRows(store.id, store.shopCurrency, platform, await run(chunk.since, chunk.until), modeOf(platform));
        written += saved.written;
        p.cursor = chunk.since;
        p.done = chunk.since <= p.target;
        delete p.error;
        delete p.errorSince;
      } catch (err) {
        // Cut by the time budget: the same chunk is retried on the next run (no 6 h wait, not an error).
        if (err instanceof DeadlineError) {
          notePartial();
          break;
        }
        p.error = errorText(err);
        p.errorSince ??= new Date().toISOString();
        log.warn("adspend.backfill_failed", `Ad spend history import failed (${platform})`, { storeId: store.id, err });
      }
      p.at = new Date().toISOString();
      changed = true;
    }
    if (changed) {
      const value = JSON.stringify(state);
      await db.appSetting.upsert({ where: { key: backfillKey(store.id) }, create: { key: backfillKey(store.id), value }, update: { value } });
    }
    // A platform's history failing for more than 48 h: an incident (daily), shown on the health tile.
    for (const p of Object.values(state.platforms)) if (p && (await reportStuckImport(store.id, "adspend", p))) break;
  }
  return written;
}

export type SpendCoverage = {
  /** First day from which the spend of every connected platform is known (null: no spend data at all). */
  from: string | null;
  /** Some connected platform's history is still being imported (or failed). */
  backfilling: boolean;
};

/**
 * From which day the store's ad spend is complete: per connected platform, the earliest day its
 * history import reached (13 months once done); without a history import yet, its earliest imported
 * day. Stores without a connected platform (manual / CSV spend only): no limit (null). Pure.
 */
export function coverageFrom(
  connected: ("meta" | "tiktok" | "google")[],
  state: BackfillState | null,
  earliest: Partial<Record<string, string>>,
  today: string,
): SpendCoverage {
  // Typed or CSV spend only: nothing says a missing day wasn't simply without ads.
  if (!connected.length) return { from: null, backfilling: false };
  let from: string | null = null;
  let backfilling = false;
  for (const platform of connected) {
    const p = state?.platforms[platform];
    const own = p ? (p.done ? p.target : p.cursor) : (earliest[platform] ?? addDays(today, -(LOOKBACK_DAYS - 1)));
    if (!p?.done) backfilling = true;
    if (from == null || own > from) from = own;
  }
  return { from, backfilling };
}

/** The store's spend coverage (see coverageFrom). */
export async function spendCoverage(storeId: string, today: string): Promise<SpendCoverage> {
  const [store, state, earliest] = await Promise.all([
    db.store.findUnique({
      where: { id: storeId },
      select: { metaAdAccountId: true, metaAccessToken: true, tiktokAdvertiserId: true, tiktokAccessToken: true, googleAdsCustomerId: true, googleAdsRefreshToken: true, googleAdsDeveloperToken: true },
    }),
    adSpendBackfillStatus(storeId),
    db.adSpend.groupBy({ by: ["platform"], where: { storeId, ...CAMPAIGN_ROWS }, _min: { day: true } }),
  ]);
  const connected: ("meta" | "tiktok" | "google")[] = [];
  if (store?.metaAdAccountId && store.metaAccessToken) connected.push("meta");
  if (store?.tiktokAdvertiserId && store.tiktokAccessToken) connected.push("tiktok");
  if (store?.googleAdsCustomerId && store.googleAdsRefreshToken && store.googleAdsDeveloperToken) connected.push("google");
  return coverageFrom(connected, state, Object.fromEntries(earliest.map((r) => [r.platform, r._min.day ?? undefined])), today);
}
