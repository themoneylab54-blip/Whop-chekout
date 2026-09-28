import { describe, expect, it, vi } from "vitest";
import { LABELS } from "@/components/checkout/i18n";
import { shopifyCodeAsDiscount, shopifyCodeUses, type ShopifyCodeDiscount } from "@/lib/shopify-discounts";
import { googleErrorCodes, googleErrorScope, GoogleApiError, GooglePartialFailure, partialFailureOf } from "@/lib/adspend-google";
import { ACCOUNT_ERROR_SAMPLE, failureScope, RunSampler } from "@/lib/google-conversions";
import { replacementWaitMessage, replacementWaitMinutes, REPLACEMENT_AMBIGUOUS_WAIT_MS } from "@/lib/claims";
import type { CartLine } from "@/lib/pricing";

/* Round 13 (correctness): pure parts. The database parts are in tests/integration/round13.test.ts. */

const line = (o: Partial<CartLine> = {}): CartLine => ({
  variantId: "gid://shopify/ProductVariant/1",
  productId: "gid://shopify/Product/1",
  productHandle: "a",
  title: "A",
  variantTitle: null,
  sku: null,
  imageUrl: null,
  quantity: 1,
  unitPriceCents: 5000,
  compareAtCents: null,
  inventory: null,
  requiresShipping: true,
  ...o,
});

const code = (o: Partial<ShopifyCodeDiscount> = {}): ShopifyCodeDiscount =>
  ({
    code: "C13",
    title: "C13",
    active: true,
    startsAt: null,
    endsAt: null,
    usageLimit: 5,
    usageCount: 0,
    oncePerCustomer: false,
    type: "PERCENT",
    value: 10,
    scope: null,
    countries: null,
    maxShippingCents: null,
    minSubtotalCents: null,
    minQuantity: null,
    appliesOnEachItem: false,
    discountClass: "order",
    combinesWith: null,
    ...o,
  }) satisfies ShopifyCodeDiscount;

/** A partial failure as Google returns it (google.rpc.Status with GoogleAdsFailure details). */
const partial = (errorCode: Record<string, string>, message = "Something about the upload.") => ({
  partialFailureError: { code: 3, message, details: [{ "@type": "type.googleapis.com/google.ads.googleads.v22.errors.GoogleAdsFailure", errors: [{ errorCode, message }] }] },
});

describe("Shopify code usage limit: Shopify's count + the ledger, always", () => {
  it("adds our ledger to asyncUsageCount (conservative in both worlds)", () => {
    // Shopify doesn't count API orders: exact. It does: counted twice, refused early, never over.
    expect(shopifyCodeUses(4, 1)).toBe(5);
    expect(shopifyCodeUses(0, 0)).toBe(0);
    expect(shopifyCodeUses(-1, -2)).toBe(0);
  });

  it("a limited code is exhausted once Shopify's count plus the ledger reach the limit", () => {
    const cart = [line()];
    expect(shopifyCodeAsDiscount(code({ usageLimit: 5, usageCount: 3 }), cart, new Map(), { country: "FR", ledgerUses: 1 }).ok).toBe(true);
    expect(shopifyCodeAsDiscount(code({ usageLimit: 5, usageCount: 3 }), cart, new Map(), { country: "FR", ledgerUses: 2 })).toEqual({ ok: false, reason: "exhausted" });
    // Shopify says 0 (API orders not counted), our ledger says 5: exhausted.
    expect(shopifyCodeAsDiscount(code({ usageLimit: 5, usageCount: 0 }), cart, new Map(), { country: "FR", ledgerUses: 5 })).toEqual({ ok: false, reason: "exhausted" });
    // No limit: the ledger never matters.
    expect(shopifyCodeAsDiscount(code({ usageLimit: null, usageCount: 999 }), cart, new Map(), { country: "FR", ledgerUses: 999 }).ok).toBe(true);
  });

  it("every checkout language says the code is used up", () => {
    for (const lang of ["fr", "en", "de", "es", "it", "nl"] as const) {
      const msg = LABELS[lang].errors.discount_exhausted;
      expect(msg, lang).toBeTruthy();
      expect(msg).not.toBe(LABELS[lang].errors.discount_invalid);
    }
    expect(LABELS.fr.errors.discount_exhausted).toMatch(/épuisé/);
  });
});

describe("Google partial failures: account-wide or per order", () => {
  it("reads Google's error codes and classifies them", () => {
    expect(googleErrorCodes(partial({ conversionUploadError: "UNPARSEABLE_GCLID" }).partialFailureError)).toEqual(["conversionUploadError:UNPARSEABLE_GCLID"]);
    const account: Record<string, string>[] = [
      { conversionUploadError: "INVALID_CONVERSION_ACTION_TYPE" },
      { conversionUploadError: "CUSTOMER_NOT_ACCEPTED_CUSTOMER_DATA_TERMS" },
      { conversionUploadError: "TOO_RECENT_CONVERSION_ACTION" },
      { conversionAdjustmentUploadError: "CUSTOMER_NOT_ALLOWLISTED" },
      { conversionActionError: "CONVERSION_ACTION_NOT_ENABLED" },
      { authorizationError: "USER_PERMISSION_DENIED" },
      { authenticationError: "OAUTH_TOKEN_EXPIRED" },
    ];
    for (const c of account) expect(partialFailureOf(partial(c))!.scope, JSON.stringify(c)).toBe("account");
    const order: Record<string, string>[] = [
      { conversionUploadError: "UNPARSEABLE_GCLID" },
      { conversionUploadError: "EXPIRED_EVENT" },
      { conversionUploadError: "CONVERSION_PRECEDES_EVENT" },
      { conversionAdjustmentUploadError: "CONVERSION_NOT_FOUND" },
      { conversionAdjustmentUploadError: "TOO_RECENT_CONVERSION" },
    ];
    for (const c of order) expect(partialFailureOf(partial(c))!.scope, JSON.stringify(c)).toBe("order");
    expect(partialFailureOf(partial({ conversionUploadError: "SOMETHING_NEW" }))!.scope).toBe("unknown");
    // No codes: the message decides (the older answers carry only a message).
    expect(googleErrorScope([], "INVALID_CONVERSION_ACTION at conversions[0]")).toBe("account");
    expect(googleErrorScope([], "UNPARSEABLE_GCLID")).toBe("order");
    expect(partialFailureOf({ results: [{}] })).toBeNull();
    // The codes are shown with the message.
    expect(partialFailureOf(partial({ conversionUploadError: "EXPIRED_EVENT" }, "The click is too old."))!.message).toBe("Google Ads : The click is too old. [EXPIRED_EVENT]");
  });

  it("HTTP errors keep their codes; a bare HTTP error is not known yet", () => {
    expect(failureScope(new GoogleApiError("HTTP 403", 403, ["authorizationError:DEVELOPER_TOKEN_NOT_APPROVED"]))).toBe("account");
    expect(failureScope(new GoogleApiError("HTTP 403 : The developer token is not approved.", 403))).toBe("unknown");
    expect(failureScope(new Error("fetch failed"))).toBe("unknown");
    expect(failureScope(new GooglePartialFailure("x", ["conversionUploadError:UNPARSEABLE_GCLID"]))).toBe("order");
  });
});

describe("RunSampler: when a store's run stops without spending tries", () => {
  const partialErr = (c: Record<string, string>) => partialFailureOf(partial(c))!;

  it("a known account-level code stops at once, even mid-run", async () => {
    const spend = vi.fn(async () => {});
    const r = new RunSampler(spend);
    await r.succeeded();
    const stop = await r.failed("o1", partialErr({ conversionActionError: "CONVERSION_ACTION_NOT_ENABLED" }), "m");
    expect(stop).toMatchObject({ ids: ["o1"], scope: "account" });
    expect(spend).not.toHaveBeenCalled();
  });

  it(`the same message on ${ACCOUNT_ERROR_SAMPLE} orders in a row is the account's, whatever the HTTP status (5xx, network, 200 partial)`, async () => {
    for (const err of [new GoogleApiError("HTTP 500", 500), new Error("fetch failed"), partialErr({ conversionUploadError: "SOMETHING_NEW" })]) {
      const spend = vi.fn(async () => {});
      const r = new RunSampler(spend);
      expect(await r.failed("a", err, "same")).toBeNull();
      expect(await r.failed("b", err, "same")).toBeNull();
      expect(await r.failed("c", err, "same")).toMatchObject({ ids: ["a", "b", "c"] });
      expect(spend).not.toHaveBeenCalled();
    }
  });

  it("an order-level code, another message or a success makes the held failures per order", async () => {
    const spend = vi.fn(async () => {});
    const r = new RunSampler(spend);
    await r.failed("a", new Error("x"), "x");
    expect(await r.failed("b", partialErr({ conversionUploadError: "UNPARSEABLE_GCLID" }), "gclid")).toBeNull();
    expect(spend.mock.calls.map((c) => (c as unknown as [{ id: string }])[0].id)).toEqual(["a", "b"]);
    // After the release every failure is per order (spent at once).
    await r.failed("c", new Error("x"), "x");
    expect(spend).toHaveBeenCalledTimes(3);

    const spend2 = vi.fn(async () => {});
    const r2 = new RunSampler(spend2);
    await r2.failed("a", new Error("x"), "x");
    await r2.failed("b", new Error("y"), "y");
    expect(spend2).toHaveBeenCalledTimes(2);

    const spend3 = vi.fn(async () => {});
    const r3 = new RunSampler(spend3);
    await r3.failed("a", new Error("x"), "x");
    await r3.succeeded();
    expect(spend3).toHaveBeenCalledTimes(1);
    // Fewer failures than the sample at the end of the run: per order after all.
    const spend4 = vi.fn(async () => {});
    const r4 = new RunSampler(spend4);
    await r4.failed("a", new Error("x"), "x");
    await r4.finish();
    expect(spend4).toHaveBeenCalledTimes(1);
  });
});

describe("replacement order: anti-duplicate wait after an uncertain attempt", () => {
  it("counts the minutes left from the ambiguous attempt", () => {
    const now = Date.parse("2026-09-28T12:00:00Z");
    expect(REPLACEMENT_AMBIGUOUS_WAIT_MS).toBe(5 * 60_000);
    expect(replacementWaitMinutes(null, now)).toBe(0);
    expect(replacementWaitMinutes(new Date(now), now)).toBe(5);
    expect(replacementWaitMinutes(new Date(now - 4 * 60_000 - 1000), now)).toBe(1);
    expect(replacementWaitMinutes(new Date(now - 5 * 60_000), now)).toBe(0);
    expect(replacementWaitMessage(3)).toMatch(/anti-doublon.*Réessayez dans 3 min/);
  });
});
