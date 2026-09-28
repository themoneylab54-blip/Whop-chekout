import { describe, expect, it } from "vitest";
import { journalExcerpt } from "@/lib/claims";
import { validateQuantityTiers } from "@/lib/pricing";
import {
  GOOGLE_ADS_SCOPE,
  accessibleCustomerIds,
  accountsFromStream,
  googleAdsAuthUrl,
  googleAdsOperator,
  parseAccountChoice,
  signGoogleAdsState,
  verifyGoogleAdsState,
} from "@/lib/google-ads-oauth";
import { maskEmail } from "@/components/checkout/ProtectionClaimForm";
import { LABELS } from "@/components/checkout/i18n";

describe("claim journal excerpt", () => {
  it("drops trailing punctuation so the line never reads '..'", () => {
    expect(journalExcerpt("Le colis n'est jamais arrivé.")).toBe("Le colis n'est jamais arrivé");
    expect(journalExcerpt("Cassé !!  ")).toBe("Cassé");
    expect(journalExcerpt("ligne 1\nligne 2")).toBe("ligne 1 ligne 2");
  });
  it("cuts long text with a single ellipsis", () => {
    const out = journalExcerpt(`${"a".repeat(198)}. ${"b".repeat(50)}`);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/\.…$/);
    expect(out.length).toBeLessThanOrEqual(200);
  });
});

describe("claim form helpers", () => {
  it("masks the order e-mail", () => {
    expect(maskEmail("camille@example.fr")).toBe("c••••@example.fr");
    expect(maskEmail("nope")).toBe("");
  });
  it("has the new copy in every language", () => {
    for (const L of Object.values(LABELS)) {
      expect(L.claimEmailHint("c••••@x.fr")).toContain("c••••@x.fr");
      for (const k of ["claimEmailRequired", "claimEmailInvalid", "claimEmailMismatch", "claimPhotoInvalid", "claimAlreadyPending", "protectionDefault"] as const) expect(L[k].length).toBeGreaterThan(5);
    }
  });
});

describe("bundle price tier", () => {
  it("is refused without its price, with a precise message", () => {
    const r = validateQuantityTiers([{ kind: "price", minQty: 2, priceCents: 0 }]);
    expect(r).toEqual({ ok: false, error: "Indiquez le prix du lot (ex. 2 pour 49 €)" });
    expect(validateQuantityTiers([{ kind: "price", minQty: 2 }]).ok).toBe(false);
    expect(validateQuantityTiers([{ kind: "price", minQty: 2, priceCents: 4900 }]).ok).toBe(true);
  });
});

describe("Google Ads OAuth", () => {
  it("needs the three operator env vars", () => {
    expect(googleAdsOperator({})).toBeNull();
    expect(googleAdsOperator({ GOOGLE_ADS_CLIENT_ID: "a", GOOGLE_ADS_CLIENT_SECRET: "b" })).toBeNull();
    expect(googleAdsOperator({ GOOGLE_ADS_CLIENT_ID: "a", GOOGLE_ADS_CLIENT_SECRET: "b", GOOGLE_ADS_DEVELOPER_TOKEN: "c" })).toEqual({ clientId: "a", clientSecret: "b", developerToken: "c" });
  });
  it("signs the state with the app secret, bound to the admin, expiring", () => {
    const now = 1_700_000_000_000;
    const state = signGoogleAdsState("store_1", "admin_1", now, "secret");
    expect(verifyGoogleAdsState(state, "admin_1", now + 60_000, "secret")).toBe("store_1");
    expect(verifyGoogleAdsState(state, "admin_2", now, "secret")).toBeNull();
    expect(verifyGoogleAdsState(state, "admin_1", now, "other")).toBeNull();
    expect(verifyGoogleAdsState(state, "admin_1", now + 16 * 60_000, "secret")).toBeNull();
    const [payload] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ s: "store_2", a: "admin_1", e: now + 60_000, n: "x" })).toString("base64url");
    expect(verifyGoogleAdsState(`${forged}.${state.split(".")[1]}`, "admin_1", now, "secret")).toBeNull();
    expect(verifyGoogleAdsState(payload, "admin_1", now, "secret")).toBeNull();
  });
  it("builds the consent URL with the adwords scope and offline access", () => {
    const u = new URL(googleAdsAuthUrl({ clientId: "cid.apps.googleusercontent.com" }, "st", "https://checkout.example.com/api/google-ads/callback"));
    expect(u.searchParams.get("scope")).toBe(GOOGLE_ADS_SCOPE);
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("state")).toBe("st");
  });
  it("reads accessible customers and account rows", () => {
    expect(accessibleCustomerIds({ resourceNames: ["customers/1234567890", "customers/1234567890", "customers/bad"] })).toEqual(["1234567890"]);
    expect(
      accountsFromStream([{ results: [{ customerClient: { id: "1112223334", descriptiveName: "Boutique", currencyCode: "EUR", manager: false } }] }], "9998887776"),
    ).toEqual([{ id: "1112223334", name: "Boutique", currency: "EUR", loginId: "9998887776", manager: false }]);
  });
  it("parses the picked account", () => {
    expect(parseAccountChoice("123-456-7890")).toEqual({ customerId: "1234567890", loginId: null });
    expect(parseAccountChoice("1234567890:9876543210")).toEqual({ customerId: "1234567890", loginId: "9876543210" });
    expect(parseAccountChoice("12345")).toBeNull();
    expect(parseAccountChoice("1234567890:x")).toBeNull();
  });
});
