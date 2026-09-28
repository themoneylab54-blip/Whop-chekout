import "server-only";
import { extFetch } from "./ext";
import type { SpendLevel, SpendRecord } from "./adspend";
import { boundedTimeout } from "./deadline";

/*
 * Google Ads API spend import (same rows as Meta / TikTok: campaign × day, plus ad groups and ads
 * for the creative table). Auth = OAuth 2.0 "installed/web app" refresh token exchanged for an
 * access token at every import, plus the account's developer token; `login-customer-id` is the
 * manager (MCC) account when the ads account is reached through one. Report = GAQL through
 * `googleAds:searchStream` (one streamed response, no paging), cost in micros of the account
 * currency, converted to the store currency with the ECB rate by saveSpendRows like the others.
 */

/** Google Ads API version (each version lives about a year; override with GOOGLE_ADS_API_VERSION). */
export const GOOGLE_ADS_API_VERSION = process.env.GOOGLE_ADS_API_VERSION?.match(/^v\d{2,3}$/)?.[0] ?? "v22";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TIMEOUT_MS = 10_000;

export type GoogleAdsCredentials = {
  customerId: string;
  loginCustomerId?: string | null;
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

/** "123-456-7890" → "1234567890"; null when it isn't a 10-digit customer id. Pure. */
export function googleCustomerId(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/[\s-]/g, "");
  return /^\d{10}$/.test(digits) ? digits : null;
}

/** GAQL of a level over [since, until] (YYYY-MM-DD, account time zone). Pure. */
export function googleAdsQuery(level: SpendLevel, since: string, until: string): string {
  const fields: Record<SpendLevel, [string, string]> = {
    campaign: ["campaign.id, campaign.name", "campaign"],
    adset: ["ad_group.id, ad_group.name", "ad_group"],
    ad: ["ad_group_ad.ad.id, ad_group_ad.ad.name", "ad_group_ad"],
  };
  const [select, from] = fields[level];
  // metrics.conversions / conversions_value: what Google itself attributes (compared with our real orders).
  return `SELECT ${select}, metrics.cost_micros, metrics.conversions, metrics.conversions_value, segments.date, customer.currency_code FROM ${from} WHERE segments.date BETWEEN '${since}' AND '${until}' AND metrics.cost_micros > 0`;
}

type Row = {
  campaign?: { id?: string; name?: string };
  adGroup?: { id?: string; name?: string };
  adGroupAd?: { ad?: { id?: string; name?: string } };
  metrics?: { costMicros?: string | number; conversions?: string | number; conversionsValue?: string | number };
  segments?: { date?: string };
  customer?: { currencyCode?: string };
};

/** Rows of a searchStream answer (an array of batches `{ results: [...] }`). Pure, exported for tests. */
export function parseGoogleAdsStream(body: unknown, level: SpendLevel, fallbackCurrency: string): SpendRecord[] {
  const batches = Array.isArray(body) ? body : body ? [body] : [];
  const out: SpendRecord[] = [];
  const prefix = level === "campaign" ? "" : level === "adset" ? "adset:" : "ad:";
  for (const batch of batches as { results?: Row[] }[]) {
    for (const r of batch?.results ?? []) {
      const node = level === "campaign" ? r.campaign : level === "adset" ? r.adGroup : r.adGroupAd?.ad;
      const day = r.segments?.date;
      if (!node?.id || !day) continue;
      const micros = Number(r.metrics?.costMicros ?? 0);
      out.push({
        day: String(day).slice(0, 10),
        campaignId: `${prefix}${node.id}`,
        campaignName: String(node.name || (level === "ad" ? `Annonce ${node.id}` : node.id)),
        // 1 unit = 1 000 000 micros → cents = micros / 10 000
        spendCents: Number.isFinite(micros) ? Math.round(micros / 10_000) : 0,
        currency: String(r.customer?.currencyCode ?? fallbackCurrency).toUpperCase(),
        ...platformFigures(r.metrics?.conversions, r.metrics?.conversionsValue),
      });
    }
  }
  return out;
}

/** Google's own conversions (count, value in the account currency, in units) as SpendRecord fields. Pure. */
function platformFigures(conversions: unknown, value: unknown): Pick<SpendRecord, "conversions" | "conversionValueCents"> {
  if (conversions == null && value == null) return {};
  const n = Number(conversions);
  const v = Number(value);
  return {
    conversions: conversions != null && Number.isFinite(n) ? Math.round(n * 100) / 100 : null,
    conversionValueCents: value != null && Number.isFinite(v) ? Math.round(v * 100) : null,
  };
}

/** Readable message of a Google error body (OAuth or Ads API, object or streamed array). Pure. */
export function googleErrorMessage(body: unknown, status: number): string {
  const first = Array.isArray(body) ? body[0] : body;
  const b = first as { error?: string | { message?: string; details?: { errors?: { message?: string }[] }[] }; error_description?: string } | null;
  if (b && typeof b.error === "string") return `HTTP ${status} : ${b.error_description ?? b.error}`;
  const e = b?.error && typeof b.error === "object" ? b.error : null;
  const detail = e?.details?.[0]?.errors?.[0]?.message;
  return `HTTP ${status}${e?.message ? ` : ${e.message}` : ""}${detail && detail !== e?.message ? ` (${detail})` : ""}`;
}

/** A Google API answer other than 2xx: its HTTP status is kept (account-wide error detection). */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Google's error codes in the body ("key:VALUE"), for the account / order scope. */
    readonly codes: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Partial-failure error codes that concern the whole account or the conversion action, never one
 * order: the conversion action (missing, disabled, wrong type, too new), the customer data terms,
 * allowlisting, authentication / authorization. Matched on the codes Google returns (errorCode keys
 * and values) and, when absent, on the message.
 */
const ACCOUNT_LEVEL_CODES =
  /INVALID_CONVERSION_ACTION|CONVERSION_ACTION_NOT_ENABLED|CONVERSION_ACTION_NOT_FOUND|NO_CONVERSION_ACTION|TOO_RECENT_CONVERSION_ACTION|CONVERSION_TRACKING_NOT_ENABLED|CUSTOMER_NOT_ACCEPTED_CUSTOMER_DATA_TERMS|CUSTOMER_DATA_POLICY_PROHIBITS|CUSTOMER_NOT_ENABLED|UNAUTHORIZED_CUSTOMER|NOT_ALLOWLISTED|NOT_WHITELISTED|DEVELOPER_TOKEN|USER_PERMISSION_DENIED|PERMISSION_DENIED|authenticationError|authorizationError|conversionActionError/i;
/** Codes that are always about one order (its click id, its dates, its order id): never account-wide. */
const ORDER_LEVEL_CODES =
  /UNPARSEABLE_(GCLID|GBRAID|WBRAID)|(GCLID|EVENT|CLICK|CONVERSION)_NOT_FOUND|EXPIRED_(GCLID|EVENT)|TOO_RECENT_(GCLID|EVENT|CONVERSION)\b|CONVERSION_PRECEDES_(GCLID|EVENT)|ADJUSTMENT_PRECEDES_CONVERSION|GBRAID_WBRAID_BOTH_SET|ORDER_ID_ALREADY_IN_USE|DUPLICATE_ORDER_ID|INVALID_USER_IDENTIFIER|RESTATEMENT_ALREADY_EXISTS|CONVERSION_ALREADY_(RETRACTED|ENHANCED)|TOO_MANY_ADJUSTMENTS/i;

/** Where a Google failure applies: the whole account, one order, or not known yet. Pure. */
export type GoogleErrorScope = "account" | "order" | "unknown";

/** Error codes of a google.rpc.Status (partialFailureError, or an HTTP error body): "key:VALUE" strings. Pure. */
export function googleErrorCodes(status: unknown): string[] {
  const details = (status as { details?: { errors?: { errorCode?: Record<string, unknown> }[] }[] } | null)?.details;
  if (!Array.isArray(details)) return [];
  return details.flatMap((d) => (Array.isArray(d?.errors) ? d.errors : [])).flatMap((e) => Object.entries(e?.errorCode ?? {}).map(([k, v]) => `${k}:${String(v)}`));
}

/** Scope of a failure from its codes (first) or its message. Pure. */
export function googleErrorScope(codes: string[], message: string): GoogleErrorScope {
  const text = codes.length ? codes.join(" ") : message;
  if (ORDER_LEVEL_CODES.test(text) && !codes.some((c) => ACCOUNT_LEVEL_CODES.test(c))) return "order";
  if (ACCOUNT_LEVEL_CODES.test(text)) return "account";
  return "unknown";
}

/** A partial failure (HTTP 200, the conversion refused): its codes and scope are kept. */
export class GooglePartialFailure extends Error {
  readonly scope: GoogleErrorScope;
  constructor(
    message: string,
    readonly codes: string[],
  ) {
    super(message);
    this.scope = googleErrorScope(codes, message);
  }
}

/** The partial failure of an upload answer as an error, or null. Codes are appended to the message. Pure. */
export function partialFailureOf(body: unknown): GooglePartialFailure | null {
  const failure = (body as { partialFailureError?: { message?: string } } | null)?.partialFailureError;
  if (!failure) return null;
  const codes = googleErrorCodes(failure);
  const values = [...new Set(codes.map((c) => c.split(":")[1]))].filter(Boolean);
  const message = String(failure.message ?? "erreur partielle").slice(0, 250);
  return new GooglePartialFailure(`Google Ads : ${message}${values.length ? ` [${values.join(", ")}]` : ""}`, codes);
}

async function call(url: string, init: RequestInit): Promise<unknown> {
  // Inside the background tick: never started (DeadlineError) or running past its hard deadline.
  const timeout = boundedTimeout(TIMEOUT_MS, `Google Ads ${new URL(url).pathname.split("/").pop()}`);
  const res = await extFetch("google_ads", new URL(url).pathname.split("/").pop() ?? "call", url, { ...init, signal: AbortSignal.timeout(timeout), cache: "no-store" });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const first = Array.isArray(body) ? body[0] : body;
    const err = (first as { error?: unknown } | null)?.error;
    throw new GoogleApiError(googleErrorMessage(body, res.status), res.status, err && typeof err === "object" ? googleErrorCodes(err) : []);
  }
  return body;
}

/** Exchanges the refresh token for a short-lived access token. */
export async function googleAccessToken(c: Pick<GoogleAdsCredentials, "clientId" | "clientSecret" | "refreshToken">): Promise<string> {
  const body = (await call(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken }).toString(),
  })) as { access_token?: string } | null;
  if (!body?.access_token) throw new Error("jeton OAuth Google refusé (pas d'access_token)");
  return body.access_token;
}

/**
 * Spend of a level over [since, until]. `accessToken` is reused across the levels of one import.
 * Throws a readable error (wrong customer id, developer token not approved, expired refresh token…).
 */
export async function fetchGoogleAds(
  c: GoogleAdsCredentials,
  accessToken: string,
  since: string,
  until: string,
  fallbackCurrency: string,
  level: SpendLevel = "campaign",
): Promise<SpendRecord[]> {
  const customer = googleCustomerId(c.customerId);
  if (!customer) throw new Error("identifiant client Google Ads invalide (10 chiffres, ex. 123-456-7890)");
  const login = googleCustomerId(c.loginCustomerId);
  const body = await call(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customer}/googleAds:searchStream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": c.developerToken,
      ...(login ? { "login-customer-id": login } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: googleAdsQuery(level, since, until) }),
  });
  return parseGoogleAdsStream(body, level, fallbackCurrency);
}

/* ------------------------------------------------------------------ */
/* Offline conversions (ClickConversion upload)                         */
/* ------------------------------------------------------------------ */

export type ClickConversion = {
  /** customers/<id>/conversionActions/<id> */
  conversionAction: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  /** "yyyy-mm-dd hh:mm:ss+|-hh:mm" */
  conversionDateTime: string;
  conversionValue: number;
  currencyCode: string;
  /** Our order id: Google deduplicates on it (a retried upload never counts twice). */
  orderId: string;
  /** Enhanced conversions: SHA-256 of the normalized e-mail (only with marketing consent). */
  hashedEmail?: string;
};

/** "customers/123/conversionActions/456" (or the bare numeric id with the customer's). Null when invalid. Pure. */
export function conversionActionName(raw: string | null | undefined, customerId: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  const full = /^customers\/(\d{10})\/conversionActions\/(\d{1,20})$/.exec(v);
  if (full) return v;
  const customer = googleCustomerId(customerId);
  return customer && /^\d{1,20}$/.test(v) ? `customers/${customer}/conversionActions/${v}` : null;
}

/** Google's conversion date-time format ("2026-09-28 14:03:00+00:00"). Pure. */
export function googleDateTime(d: Date): string {
  return `${d.toISOString().slice(0, 19).replace("T", " ")}+00:00`;
}

/** The uploadClickConversions request body (one conversion, partial failure on). Pure. */
export function clickConversionBody(c: ClickConversion): Record<string, unknown> {
  const conversion: Record<string, unknown> = {
    conversionAction: c.conversionAction,
    conversionDateTime: c.conversionDateTime,
    conversionValue: c.conversionValue,
    currencyCode: c.currencyCode,
    orderId: c.orderId,
  };
  // Exactly one click id (gclid preferred; gbraid / wbraid for iOS app and web-to-app clicks).
  if (c.gclid) conversion.gclid = c.gclid;
  else if (c.gbraid) conversion.gbraid = c.gbraid;
  else if (c.wbraid) conversion.wbraid = c.wbraid;
  if (c.hashedEmail) conversion.userIdentifiers = [{ hashedEmail: c.hashedEmail }];
  return { conversions: [conversion], partialFailure: true };
}

/**
 * Uploads one offline click conversion. Throws a readable error on HTTP failure or on a partial
 * failure other than a duplicate (an order id Google already has = success, idempotent).
 */
export async function uploadClickConversion(c: GoogleAdsCredentials, accessToken: string, conv: ClickConversion): Promise<void> {
  const customer = googleCustomerId(c.customerId);
  if (!customer) throw new Error("identifiant client Google Ads invalide");
  const login = googleCustomerId(c.loginCustomerId);
  const body = (await call(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customer}:uploadClickConversions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": c.developerToken,
      ...(login ? { "login-customer-id": login } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(clickConversionBody(conv)),
  })) as { partialFailureError?: { message?: string } } | null;
  const failure = partialFailureOf(body);
  // An order id Google already has = uploaded before (idempotent success).
  if (failure && !/DUPLICATE|already exists|CLICK_CONVERSION_ALREADY_EXISTS/i.test(`${failure.message} ${failure.codes.join(" ")}`)) throw failure;
}

/* ------------------------------------------------------------------ */
/* Conversion adjustments (refunds, lost disputes, offers added)        */
/* ------------------------------------------------------------------ */

export type ConversionAdjustment = {
  conversionAction: string;
  /** The order id the conversion was uploaded with (our checkout id). */
  orderId: string;
  type: "RETRACTION" | "RESTATEMENT";
  /** "yyyy-mm-dd hh:mm:ss+|-hh:mm", after the conversion (each new adjustment later than the last). */
  adjustmentDateTime: string;
  /** RESTATEMENT: the conversion's new total value. */
  restatementValue?: { adjustedValue: number; currencyCode: string };
};

/** The uploadConversionAdjustments request body (one adjustment, partial failure on). Pure. */
export function conversionAdjustmentBody(a: ConversionAdjustment): Record<string, unknown> {
  const adjustment: Record<string, unknown> = {
    conversionAction: a.conversionAction,
    adjustmentType: a.type,
    adjustmentDateTime: a.adjustmentDateTime,
    orderId: a.orderId,
  };
  if (a.type === "RESTATEMENT" && a.restatementValue) adjustment.restatementValue = a.restatementValue;
  return { conversionAdjustments: [adjustment], partialFailure: true };
}

/**
 * Uploads one conversion adjustment by order id. Throws a readable error on HTTP failure or on a
 * partial failure, except a retraction of a conversion Google already retracted (idempotent).
 */
export async function uploadConversionAdjustment(c: GoogleAdsCredentials, accessToken: string, a: ConversionAdjustment): Promise<void> {
  const customer = googleCustomerId(c.customerId);
  if (!customer) throw new Error("identifiant client Google Ads invalide");
  const login = googleCustomerId(c.loginCustomerId);
  const body = (await call(`https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customer}:uploadConversionAdjustments`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "developer-token": c.developerToken,
      ...(login ? { "login-customer-id": login } : {}),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(conversionAdjustmentBody(a)),
  })) as { partialFailureError?: { message?: string } } | null;
  const failure = partialFailureOf(body);
  if (failure && !(a.type === "RETRACTION" && /ALREADY_RETRACTED|already.*retracted/i.test(`${failure.message} ${failure.codes.join(" ")}`))) throw failure;
}
