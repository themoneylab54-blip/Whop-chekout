import { describe, expect, it } from "vitest";
import { createBlock, defaultCheckoutLayout, loadThankYouLayout, type Block } from "@/lib/layout";
import { LABELS, isLang, matchAcceptLanguage, resolveCheckoutLang, type Lang } from "@/components/checkout/i18n";
import {
  SAVED_BUYER_KEY,
  SAVED_BUYER_TTL_MS,
  clearSavedBuyer,
  maskEmail,
  parseSavedBuyer,
  readSavedBuyerRaw,
  serializeSavedBuyer,
  writeSavedBuyer,
  type SavedAddress,
} from "@/components/checkout/savedBuyer";
import { insertionHint, insertionIndex, layoutWarnings } from "@/components/builder/placement";

describe("checkout language", () => {
  it("picks the best Accept-Language match among the six, honouring q-values", () => {
    expect(matchAcceptLanguage("de-CH;q=0.9, en;q=0.95, fr;q=0.1")).toBe("en");
    expect(matchAcceptLanguage("pt-BR, nl-BE;q=0.5")).toBe("nl");
    expect(matchAcceptLanguage("ja, zh;q=0.8")).toBeNull();
    expect(matchAcceptLanguage("es;q=0, it")).toBe("it");
    expect(matchAcceptLanguage(null)).toBeNull();
  });

  it("resolves ?lang= → remembered choice → Accept-Language → store default", () => {
    expect(resolveCheckoutLang({ query: "it", cookie: "de", acceptLanguage: "en", fallback: "fr" })).toBe("it");
    expect(resolveCheckoutLang({ query: ["nl", "en"], fallback: "fr" })).toBe("nl");
    expect(resolveCheckoutLang({ query: "xx", cookie: "de", acceptLanguage: "en", fallback: "fr" })).toBe("de");
    expect(resolveCheckoutLang({ query: "", cookie: "zz", acceptLanguage: "es-ES,es;q=0.9", fallback: "fr" })).toBe("es");
    expect(resolveCheckoutLang({ acceptLanguage: "ja", fallback: "de" })).toBe("de");
    expect(isLang("constructor")).toBe(false);
  });

  it("has every new checkout string in the six languages", () => {
    const keys = ["language", "rememberMe", "rememberHint", "useSaved", "notMe", "forgetMe", "savedFilled", "savedForgotten", "savedRegion", "paymentUnavailable", "paymentUnavailableHint"] as const;
    for (const lang of Object.keys(LABELS) as Lang[]) {
      const L = LABELS[lang] as Record<string, unknown> & { errors: Record<string, string>; continueAs: (e: string) => string };
      for (const k of keys) expect(typeof L[k], `${lang}.${k}`).toBe("string");
      expect(L.continueAs("claire@…")).toContain("claire@…");
      expect(L.errors.upsell_uncertain, `${lang}.errors.upsell_uncertain`).toBeTruthy();
      // Neutral wording: no "check your connection" when the payment form can't load.
      expect(String(L.paymentUnavailableHint)).not.toMatch(/connexion|connection|Verbindung|conexión|connessione|verbinding/i);
    }
    expect(LABELS.fr.paymentUnavailable).toBe("Le paiement est momentanément indisponible");
    expect(LABELS.fr.errors.upsell_uncertain).toContain("ajoutée automatiquement à votre commande");
  });
});

describe("returning-buyer details (wc:buyer:v1)", () => {
  const address: SavedAddress = {
    firstName: "Claire",
    lastName: "Martin",
    address1: "12 rue des Lilas",
    address2: "",
    city: "Lyon",
    province: "",
    zip: "69001",
    countryCode: "fr",
    phone: "0612345678",
  };
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
  };

  it("stores contact and address only, with a 180-day expiry", () => {
    const now = 1_700_000_000_000;
    const raw = serializeSavedBuyer(" claire@example.fr ", { ...address, card: "4242" } as SavedAddress, now);
    const json = JSON.parse(raw);
    expect(Object.keys(json).sort()).toEqual(["address", "email", "expiresAt", "savedAt"]);
    expect(json.address.card).toBeUndefined();
    expect(json.expiresAt - now).toBe(SAVED_BUYER_TTL_MS);
    const parsed = parseSavedBuyer(raw, now + 1000)!;
    expect(parsed.email).toBe("claire@example.fr");
    expect(parsed.address.countryCode).toBe("FR");
    expect(parseSavedBuyer(raw, now + SAVED_BUYER_TTL_MS + 1)).toBeNull();
  });

  it("ignores malformed entries and survives a storage that throws", () => {
    expect(parseSavedBuyer("{not json")).toBeNull();
    expect(parseSavedBuyer(JSON.stringify({ email: "nope", expiresAt: Date.now() + 1e6 }))).toBeNull();
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceeded");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readSavedBuyerRaw(broken)).toBeNull();
    expect(writeSavedBuyer("a@b.fr", address, broken)).toBe(false);
    expect(() => clearSavedBuyer(broken)).not.toThrow();
  });

  it("writes, reads back and forgets under the versioned key", () => {
    const store = memory();
    expect(writeSavedBuyer("claire@example.fr", address, store)).toBe(true);
    expect(store.m.has(SAVED_BUYER_KEY)).toBe(true);
    expect(parseSavedBuyer(readSavedBuyerRaw(store))?.address.city).toBe("Lyon");
    clearSavedBuyer(store);
    expect(readSavedBuyerRaw(store)).toBeNull();
  });

  it("masks the e-mail in the prompt", () => {
    expect(maskEmail("claire.martin@gmail.com")).toBe("claire.martin@…");
  });
});

describe("builder placement and warnings", () => {
  it("puts a one-click offer after the confirmation and marks that spot", () => {
    const blocks = loadThankYouLayout(null).blocks;
    const conf = blocks.findIndex((b) => b.type === "ty_confirmation");
    const at = insertionIndex(blocks, "thank-you", null, "upsell");
    expect(at).toBe(conf + 1);
    expect(insertionHint(blocks, at)).toEqual({ id: blocks[conf].id, edge: "bottom" });
    // Other blocks go to the end.
    const end = insertionIndex(blocks, "thank-you", null, "coupon");
    expect(end).toBe(blocks.length);
    expect(insertionHint(blocks, end)).toEqual({ id: blocks[blocks.length - 1].id, edge: "bottom" });
  });

  it("inserts before Payment on the checkout by default, after the chosen block otherwise", () => {
    const blocks = defaultCheckoutLayout().blocks;
    const pay = blocks.findIndex((b) => b.type === "payment");
    expect(insertionIndex(blocks, "checkout", null, "faq")).toBe(pay);
    expect(insertionHint(blocks, pay)).toEqual({ id: blocks[pay].id, edge: "top" });
    expect(insertionIndex(blocks, "checkout", blocks[0].id, "faq")).toBe(1);
  });

  it("flags offers without product or price, ignoring hidden blocks", () => {
    const empty = createBlock("upsell");
    const noPrice = createBlock("upsell");
    noPrice.props = { ...noPrice.props, variantId: "123", price: 0 };
    const hidden = { ...createBlock("upsell"), hidden: true } as Block;
    const w = layoutWarnings([empty, noPrice, hidden]);
    expect(w[empty.id]).toBe("Choisir un produit");
    expect(w[noPrice.id]).toBe("Renseigner le prix de l'offre");
    expect(w[hidden.id]).toBeUndefined();
  });
});
