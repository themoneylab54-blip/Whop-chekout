import { describe, expect, it } from "vitest";
import { flashBack } from "@/lib/flash-back";
import { resolveRange } from "@/lib/analytics";
import { createBlock, type Block } from "@/lib/layout";
import { arrangeCheckout, belowPaymentReason, checkoutZones, isReassuranceWidget, zoneWithPlacement } from "@/components/checkout/CheckoutView";
import { insertedZone, insertionIndex, renderedInsertionHint, zoneLabel, zoneWording } from "@/components/builder/placement";
import { LABELS } from "@/components/checkout/i18n";
import { claimTimelineLabel } from "@/components/dashboard/claimTimeline";
import { buyerName, likePattern } from "@/lib/order-search";

/*
 * UX round 12: flash redirects that keep the analytics period, the builder's rendered
 * checkout zones (block list, inspector, insertion marker), the terms-only pay hint, the
 * withdrawal contact sentence, the order timeline claim wording and the ⌘K name search helpers.
 */

describe("analytics flash redirects", () => {
  const base = "/dashboard/stores/s1/analytics";
  it("keeps the period and filters, never reuses the reserved `from` param as a marker", () => {
    const back = `${base}?range=custom&from=2026-09-01&to=2026-09-10&source=meta&tab=tests&ok=old`;
    const url = flashBack(back, base, `${base}?tab=tests`, { tab: "tests", flash: "ct", ok: "Test lancé" }, "#tests-checkout");
    const u = new URL(url, "http://x");
    expect(u.pathname).toBe(base);
    expect(u.hash).toBe("#tests-checkout");
    expect(Object.fromEntries(u.searchParams)).toEqual({ range: "custom", from: "2026-09-01", to: "2026-09-10", source: "meta", tab: "tests", ok: "Test lancé", flash: "ct" });
    // The period survives: no "Dates invalides" banner, no reset.
    const r = resolveRange({ range: u.searchParams.get("range") ?? undefined, from: u.searchParams.get("from") ?? undefined, to: u.searchParams.get("to") ?? undefined }, "2026-09-28");
    expect(r.error).toBeUndefined();
    expect([r.key, r.from, r.to]).toEqual(["custom", "2026-09-01", "2026-09-10"]);
  });
  it("drops a previous message and falls back when `back` leaves the page", () => {
    expect(flashBack(`${base}?range=7d&error=x&flash=ct`, base, `${base}?tab=tests`, { tab: "tests", ok: "ok" })).toBe(`${base}?range=7d&tab=tests&ok=ok`);
    for (const bad of ["https://evil.example/x", "//evil.example", "/dashboard/stores/other/analytics?range=7d", `${base}x?y=1`, null]) {
      expect(flashBack(bad, base, `${base}?tab=tests`, { tab: "tests", error: "e" })).toBe(`${base}?tab=tests&error=e`);
    }
  });
});

describe("builder: rendered checkout zones", () => {
  const sections = () => [createBlock("contact"), createBlock("delivery"), createBlock("shipping_method"), createBlock("payment")] as Block[];
  it("reassurance widgets go to the summary column, content under the payment, short banners above", () => {
    const [contact, delivery, method, payment] = sections();
    const reviews = createBlock("reviews") as Block;
    const text = createBlock("text") as Block;
    const a1 = createBlock("announcement") as Block;
    const a2 = createBlock("countdown") as Block;
    const a3 = createBlock("free_shipping_bar") as Block;
    const summaryText = createBlock("text", { placement: "summary" }) as Block;
    const reco = createBlock("recommendations") as Block;
    const blocks = [a1, a2, a3, contact, reviews, text, delivery, method, payment, summaryText, reco];
    const z = checkoutZones(blocks);
    expect(z[contact.id]).toBe("form");
    expect(z[a1.id]).toBe("form");
    expect(z[a2.id]).toBe("form");
    expect(z[a3.id]).toBe("after"); // third short banner: over the limit
    expect(z[reviews.id]).toBe("reassurance");
    expect(z[text.id]).toBe("after");
    expect(z[summaryText.id]).toBe("summary");
    expect(z[reco.id]).toBe("recommendations");
    // Same answer as the canvas.
    const arranged = arrangeCheckout(blocks);
    expect(arranged.side.map((b) => b.id)).toEqual([reviews.id]);
    expect(arranged.after.map((b) => b.id)).toEqual([a3.id, text.id]);
    // List hints.
    expect([zoneLabel(z[contact.id]), zoneLabel(z[text.id]), zoneLabel(z[reviews.id]), zoneLabel(z[summaryText.id])]).toEqual([null, "Sous le paiement", "Récapitulatif", "Récapitulatif"]);
    // Inspector: why it shows under the payment, what "form" means for it.
    expect(belowPaymentReason(blocks, a3.id)).toBe("compact_limit");
    expect(belowPaymentReason(blocks, text.id)).toBe("below_payment");
    expect(belowPaymentReason(blocks, a1.id)).toBeNull();
    expect(belowPaymentReason(blocks, reviews.id)).toBeNull();
    expect(zoneWithPlacement(blocks, summaryText.id, "form")).toBe("after");
    expect(isReassuranceWidget("reviews")).toBe(true);
    expect(isReassuranceWidget("text")).toBe(false);
  });
  it("a hidden block gets the zone it would take once shown", () => {
    const blocks = [...sections(), createBlock("guarantee", { hidden: true }) as Block];
    expect(checkoutZones(blocks)[blocks[4].id]).toBe("reassurance");
  });
  it("the insertion marker points where the new block really shows", () => {
    const [contact, delivery, method, payment] = sections();
    const faq = createBlock("faq") as Block;
    const trust = createBlock("trust_badges") as Block;
    const blocks = [contact, delivery, method, payment, faq, trust];
    const at = insertionIndex(blocks, "checkout", null, "reviews"); // default: before Payment
    expect(at).toBe(3);
    // A reassurance widget lands next to the other one in the summary column…
    expect(insertedZone(blocks, at, "reviews")).toBe("reassurance");
    expect(renderedInsertionHint(blocks, at, "reviews")).toEqual({ id: trust.id, edge: "top" });
    // …a content block under the payment (above the FAQ), a short banner above the payment.
    expect(insertedZone(blocks, at, "text")).toBe("after");
    expect(renderedInsertionHint(blocks, at, "text")).toEqual({ id: faq.id, edge: "top" });
    expect(renderedInsertionHint(blocks, at, "announcement")).toEqual({ id: method.id, edge: "bottom" });
    expect(zoneWording("reassurance")).toMatch(/récapitulatif/);
    // Nothing under the payment yet: right below the last block of the form column.
    const bare = sections();
    expect(renderedInsertionHint(bare, 3, "text")).toEqual({ id: bare[3].id, edge: "bottom" });
  });
});

describe("checkout copy", () => {
  it("a specific pay hint when only the terms are missing, and a linkable withdrawal contact, in every language", () => {
    for (const [lang, L] of Object.entries(LABELS)) {
      expect(L.acceptTermsToContinue, lang).toBeTruthy();
      expect(L.acceptTermsToContinue, lang).not.toMatch(/:/);
      expect(L.withdrawalContact, lang).toBeTruthy();
      expect(L.withdrawal.includes(L.withdrawalContact), lang).toBe(false);
    }
    expect(LABELS.fr.acceptTermsToContinue).toBe("Acceptez les CGV pour continuer");
  });
});

describe("order timeline: delivery protection wording", () => {
  it("says what happened on this order, not the store-wide journal sentence", () => {
    const msg = "Protection colis : le client signale « colis volé » sur la commande #1001 — « Pas reçu, le suivi dit livré » — à accepter ou refuser sur la fiche commande.";
    expect(claimTimelineLabel("protection.claim_reported", msg, { reason: "stolen" })).toBe("Le client signale un problème de livraison : colis volé — « Pas reçu, le suivi dit livré ».");
    expect(claimTimelineLabel("protection.claim_reported", "x", {})).toBe("Le client signale un problème de livraison.");
    expect(claimTimelineLabel("protection.claim_approved", "Signalement accepté (renvoi) : 18,50 € comptés en sinistre.", null)).toBe("Signalement du client accepté (renvoi) : 18,50 € comptés en sinistre.");
    expect(claimTimelineLabel("protection.claim_rejected", "", null)).toMatch(/refusé/);
    expect(claimTimelineLabel("payment.succeeded", "x", null)).toBeNull();
  });
});

describe("⌘K name search helpers", () => {
  it("escapes LIKE wildcards and joins words", () => {
    expect(likePattern("  Marie   Dupont ")).toBe("%Marie%Dupont%");
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });
  it("reads the buyer name of an address", () => {
    expect(buyerName({ firstName: "Marie", lastName: "Dupont" })).toBe("Marie Dupont");
    expect(buyerName({ firstName: "", lastName: "Dupont" })).toBe("Dupont");
    expect(buyerName(null)).toBeNull();
    expect(buyerName({ firstName: 3 })).toBeNull();
  });
});
