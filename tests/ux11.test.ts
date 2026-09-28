import { describe, expect, it } from "vitest";
import { humanizeError } from "@/lib/humanize-error";
import { sourceLabel } from "@/components/dashboard/sources";
import { NAV_SECTIONS, sectionHref } from "@/components/dashboard/nav";
import { isImageFile } from "@/components/checkout/ProtectionClaimForm";
import { LABELS } from "@/components/checkout/i18n";

describe("humanizeError", () => {
  it("rewords Shopify HTTP errors and keeps the raw text as detail", () => {
    const raw = 'Shopify API 403: {"errors":"[API] This action requires merchant approval"}';
    const h = humanizeError(raw);
    expect(h.text).toBe("Shopify a refusé l'accès (403) : vérifiez la connexion Shopify (Connexions › Shopify) et reconnectez l'app si besoin.");
    expect(h.detail).toBe(raw);
  });
  it("covers throttling, outages, network and tokens", () => {
    expect(humanizeError("Shopify API throttled").text).toMatch(/limite temporairement/);
    expect(humanizeError("Shopify API 503: upstream").text).toMatch(/indisponible \(503\)/);
    expect(humanizeError("fetch failed").text).toMatch(/injoignable/);
    expect(humanizeError("The operation was aborted due to timeout").text).toMatch(/pas répondu à temps/);
    expect(humanizeError("invalid_grant").text).toMatch(/Google Ads/);
    expect(humanizeError("OAuthException: Error validating access token").text).toMatch(/Meta/);
    expect(humanizeError("Shopify : Variant is out of stock").text).toMatch(/stock insuffisant/);
    expect(humanizeError("Shopify : Email is invalid").text).toBe("Shopify a refusé la commande : Email is invalid");
  });
  it("passes unknown (already French) messages through", () => {
    expect(humanizeError("Code promo déjà utilisé")).toEqual({ text: "Code promo déjà utilisé" });
    expect(humanizeError(null).text).toBe("Erreur inconnue.");
  });
});

describe("sourceLabel", () => {
  it("names platforms properly", () => {
    expect(sourceLabel("tiktok")).toBe("TikTok");
    expect(sourceLabel("facebook")).toBe("Facebook / Meta");
    expect(sourceLabel("ig")).toBe("Instagram");
    expect(sourceLabel("google (clic pub)")).toBe("Google (clic pub)");
    expect(sourceLabel("direct / inconnu")).toBe("Direct / inconnu");
    expect(sourceLabel("mybrand")).toBe("Mybrand");
    expect(sourceLabel("partner.example.com")).toBe("partner.example.com");
  });
});

describe("palette sections", () => {
  it("indexes the settings cards with anchors", () => {
    const tz = NAV_SECTIONS.find((s) => s.label === "Fuseau horaire")!;
    expect(sectionHref("/b", tz)).toBe("/b/settings#boutique");
    for (const l of ["Boutique", "Marges & coûts", "Alertes", "Litiges", "Réseau", "Attribution", "Options du checkout"]) expect(NAV_SECTIONS.some((s) => s.label === l)).toBe(true);
  });
});

describe("claim photo picker", () => {
  it("accepts images and HEIC by name only", () => {
    expect(isImageFile({ name: "a.jpg", type: "image/jpeg" })).toBe(true);
    expect(isImageFile({ name: "IMG_1.HEIC", type: "" })).toBe(true);
    expect(isImageFile({ name: "doc.pdf", type: "application/pdf" })).toBe(false);
  });
  it("has picker labels in every language", () => {
    for (const L of Object.values(LABELS)) {
      expect(L.claimPhotosCount(2, 3)).toMatch(/2\/3/);
      expect(L.claimPhotoRemove(1)).toMatch(/1/);
    }
  });
});

describe("German uses Sie", () => {
  it("has no informal forms", () => {
    const text = JSON.stringify(LABELS.de, (_k, v) => (typeof v === "function" ? String(v("X", 2)) : v));
    expect(text).not.toMatch(/\b(du|dir|dich|dein\w*|Deine?\w*)\b/);
  });
});
