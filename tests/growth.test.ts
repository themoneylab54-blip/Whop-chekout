import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { analyze, bucketOf, summarize } from "@/lib/experiments";
import { eligibleMethods, statementDescriptor } from "@/lib/whop";
import { buildEvidence, evidenceDue } from "@/lib/disputes";
import { consentAllows, e164, metaPayload, sessionEvent, tiktokPayload } from "@/lib/conversions";
import { reviewReasons } from "@/lib/checkout";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

const store = {
  id: "st1",
  name: "Ma Boutique",
  metaPixelId: "123",
  metaTestEventCode: null,
  tiktokPixelId: "TT1",
  metaContentIdFormat: "variant",
  theme: null,
} as never;

const session = {
  id: "sess1",
  currency: "EUR",
  totalCents: 5490,
  subtotalCents: 5000,
  email: " Alex@Example.com ",
  paidAt: new Date("2026-09-01T10:00:00Z"),
  createdAt: new Date("2026-09-01T09:50:00Z"),
  shopifyOrderName: "#1001",
  clientIp: "1.2.3.4",
  userAgent: "Mozilla/5.0",
  tracking: { fbp: "fb.1.1.1", fbc: "fb.1.1.abc", ttp: "ttp1", ttclid: "cl1" },
  shippingAddress: { firstName: "Alex", lastName: "Martin", address1: "1 rue X", city: "Paris", zip: "75001", countryCode: "FR", phone: "+33 6 00 00 00 00" },
  lines: [{ variantId: "gid://shopify/ProductVariant/42", productId: "gid://shopify/Product/7", title: "Sweat", variantTitle: "M", quantity: 2, unitPriceCents: 2500, imageUrl: null }],
  termsAcceptedAt: new Date("2026-09-01T09:59:00Z"),
  store,
} as never;

describe("server-side conversions", () => {
  it("Meta: hashed normalized identity, E.164 phone, dedupe id, value and contents", () => {
    const p = metaPayload(session, sessionEvent(session, "purchase"));
    const e = p.data[0];
    expect(e.event_id).toBe("purchase-sess1");
    expect(e.user_data.em).toEqual([sha("alex@example.com")]);
    expect(e.user_data.ph).toEqual([sha("33600000000")]);
    expect(e.user_data.fbp).toBe("fb.1.1.1");
    expect(e.user_data.client_ip_address).toBe("1.2.3.4");
    expect(e.custom_data).toMatchObject({ currency: "EUR", value: 54.9, num_items: 2, content_ids: ["42"], order_id: "purchase-sess1" });
    expect(e.event_time).toBe(Math.floor(new Date("2026-09-01T10:00:00Z").getTime() / 1000));
  });
  it("Meta: Shopify catalog content ids when configured", () => {
    const shopifyFormat = { ...(session as object), store: { ...(store as object), metaContentIdFormat: "shopify" } } as never;
    expect(metaPayload(shopifyFormat, sessionEvent(shopifyFormat, "purchase")).data[0].custom_data.content_ids).toEqual(["shopify_FR_7_42"]);
  });
  it("TikTok: CompletePayment with the same dedupe id and order id", () => {
    const p = tiktokPayload(session, sessionEvent(session, "purchase"));
    expect(p.event_source_id).toBe("TT1");
    expect(p.data[0].event_id).toBe("purchase-sess1");
    expect(p.data[0].properties.order_id).toBe("purchase-sess1");
    expect(p.data[0].user.ttclid).toBe("cl1");
    expect(p.data[0].user.phone).toBe(sha("+33600000000"));
    expect(p.data[0].properties.value).toBe(54.9);
  });
  it("normalizes national phone numbers to E.164", () => {
    expect(e164("06 12 34 56 78", "FR")).toBe("33612345678");
    expect(e164("+32 470 12 34 56", "FR")).toBe("32470123456");
    expect(e164("0032470123456", "BE")).toBe("32470123456");
    expect(e164("0470 12 34 56", "BE")).toBe("32470123456");
    expect(e164("0551 23 45 67", "DZ")).toBe("213551234567");
    expect(e164("", "FR")).toBeUndefined();
    expect(e164("+33 (0)6 12 34 56 78", "FR")).toBe("33612345678");
    // Italy keeps its leading 0 (landlines) and mobiles starting with 3 aren't taken for "+39".
    expect(e164("06 1234 5678", "IT")).toBe("390612345678");
    expect(e164("347 123 4567", "IT")).toBe("393471234567");
    expect(e164("39 347 123 4567", "IT")).toBe("393471234567");
    expect(e164("33612345678", "FR")).toBe("33612345678");
  });
  it("never sends test orders, respects refusals and strict consent", () => {
    const base = { tracking: {}, test: false, store: { pixelRequireConsent: false, metaTestEventCode: null } };
    expect(consentAllows(base as never)).toBe(true);
    expect(consentAllows({ ...base, test: true } as never)).toBe(false);
    expect(consentAllows({ ...base, test: true, store: { ...base.store, metaTestEventCode: "TEST1" } } as never)).toBe(true);
    expect(consentAllows({ ...base, tracking: { marketing: false } } as never)).toBe(false);
    expect(consentAllows({ ...base, store: { ...base.store, pixelRequireConsent: true } } as never)).toBe(false);
    expect(consentAllows({ ...base, tracking: { marketing: true }, store: { ...base.store, pixelRequireConsent: true } } as never)).toBe(true);
  });
});

describe("statementDescriptor", () => {
  it("builds Whop's WHOP* descriptor, 22 characters max", () => {
    expect(statementDescriptor("Boutique Élégance & Co!")).toBe("WHOP*BOUTIQUE ELEGANCE");
    expect(statementDescriptor("A very long store name that goes on")).toHaveLength(22);
    expect(statementDescriptor("WHOP*seyuna")).toBe("WHOP*SEYUNA");
    expect(statementDescriptor("123")).toBeNull();
    expect(statementDescriptor("")).toBeNull();
  });
});

describe("A/B tests", () => {
  const row = (variant: string, visitorId: string, status: string, totalCents = 5000) => ({ id: `${variant}${visitorId}${Math.random()}`, variant, visitorId, status, totalCents });
  it("assigns a visitor to the same bucket every time, and splits evenly", () => {
    expect(bucketOf("visitor-1", "exp1")).toBe(bucketOf("visitor-1", "exp1"));
    const inB = Array.from({ length: 10_000 }, (_, i) => bucketOf(`v${i}`, "exp1") < 30).filter(Boolean).length;
    expect(inB / 10_000).toBeGreaterThan(0.28);
    expect(inB / 10_000).toBeLessThan(0.32);
  });
  it("counts unique visitors, not checkout clicks", () => {
    const [a] = summarize([row("A", "v1", "OPEN"), row("A", "v1", "OPEN"), row("A", "v1", "PAID"), row("A", "v2", "OPEN")]);
    expect(a.visitors).toBe(2);
    expect(a.cvr).toBe(0.5);
    expect(a.rpv).toBe(2500);
  });
  it("finds a clear lift significant, with enough data and no sample-ratio mismatch", () => {
    const rows = [
      ...Array.from({ length: 1000 }, (_, i) => row("A", `a${i}`, i < 30 ? "PAID" : "OPEN")),
      ...Array.from({ length: 1000 }, (_, i) => row("B", `b${i}`, i < 60 ? "PAID" : "OPEN")),
    ];
    const [a, b] = summarize(rows);
    const v = analyze(a, b, 50);
    expect(v.cvrLift).toBeCloseTo(1);
    expect(v.cvrPValue).toBeLessThan(0.01);
    expect(v.rpvPValue).toBeLessThan(0.01);
    expect(v.enoughData).toBe(true);
    expect(v.sampleRatioMismatch).toBe(false);
  });
  it("flags a broken split and small samples", () => {
    const rows = [...Array.from({ length: 300 }, (_, i) => row("A", `a${i}`, "OPEN")), ...Array.from({ length: 100 }, (_, i) => row("B", `b${i}`, "OPEN"))];
    const [a, b] = summarize(rows);
    const v = analyze(a, b, 50);
    expect(v.sampleRatioMismatch).toBe(true);
    expect(v.enoughData).toBe(false);
    expect(v.cvrPValue).toBe(1);
  });
});

describe("dispute evidence", () => {
  it("includes order, tracking, consent and address", () => {
    const e = buildEvidence(session, [{ number: "6A123", company: "Colissimo", url: null }], ["https://shop.fr/cgv"]);
    expect(e.customer_name).toBe("Alex Martin");
    expect(e.notes).toContain("#1001");
    expect(e.notes).toContain("Colissimo 6A123");
    expect(e.notes).toContain("CGV");
    expect(e.product_description).toContain("2 × Sweat (M)");
    expect(e.refund_policy_disclosure).toContain("https://shop.fr/cgv");
  });
});

describe("dispute evidence", () => {
  it("describes a disputed offer on its own, without claiming it shipped with the order", () => {
    const e = buildEvidence(session, [], [], { offer: { title: "Bonnet", amountCents: 700, paidAt: new Date("2026-01-02"), shopifyOrderName: "#1002" } });
    expect(e.product_description).toBe("1 × Bonnet (offre post-achat)");
    expect(e.notes).toContain("Commande distincte #1002");
    expect(e.notes).not.toContain("expédiée avec");
    expect(e.refund_policy_disclosure).not.toContain("14 jours affichée");
  });

  it("waits for tracking, but never past the margin before the due date", () => {
    const now = Date.parse("2026-03-10T12:00:00Z");
    const base = { disputeEvidenceTries: 0, openedAt: new Date(now - 3600_000), lastTryAt: null, tracked: false };
    expect(evidenceDue({ ...base, disputeDueAt: new Date(now + 5 * 86400_000) }, now)).toBe(false);
    expect(evidenceDue({ ...base, disputeDueAt: new Date(now + 24 * 3600_000) }, now)).toBe(true);
    expect(evidenceDue({ ...base, disputeDueAt: new Date(now + 5 * 86400_000), tracked: true }, now)).toBe(true);
    expect(evidenceDue({ ...base, disputeDueAt: null, openedAt: new Date(now - 4 * 86400_000) }, now)).toBe(true);
    // Backoff after a failure, and a hard stop after 3 tries.
    expect(evidenceDue({ ...base, tracked: true, disputeDueAt: null, disputeEvidenceTries: 1, lastTryAt: new Date(now - 30 * 60_000) }, now)).toBe(false);
    expect(evidenceDue({ ...base, tracked: true, disputeDueAt: null, disputeEvidenceTries: 3 }, now)).toBe(false);
  });
});

describe("reviewReasons with presentment amounts", () => {
  const snap = { totalCents: 5490, currency: "EUR", shippingCountries: [], shippingRateId: null };
  it("checks the presentment amount when it is in the checkout currency", () => {
    expect(reviewReasons(snap, { totalCents: 6000, currency: "USD", presentmentCents: 5000, presentmentCurrency: "eur" }, null)).toHaveLength(1);
    expect(reviewReasons(snap, { totalCents: 6000, currency: "USD", presentmentCents: 5490, presentmentCurrency: "eur" }, null)).toEqual([]);
  });
});

describe("payment method eligibility", () => {
  const all = ["alma", "oney_3x", "klarna", "ideal", "bancontact", "twint", "sepa_debit", "blik"];
  it("keeps only methods usable for the country, currency and amount", () => {
    expect(eligibleMethods(all, { country: "FR", currency: "EUR", totalCents: 12_000 })).toEqual(["alma", "oney_3x", "klarna", "sepa_debit"]);
    expect(eligibleMethods(all, { country: "FR", currency: "EUR", totalCents: 3_000 })).toEqual(["klarna", "sepa_debit"]);
    expect(eligibleMethods(all, { country: "NL", currency: "EUR", totalCents: 3_000 })).toEqual(["klarna", "ideal", "sepa_debit"]);
    expect(eligibleMethods(all, { country: "CH", currency: "CHF", totalCents: 3_000 })).toEqual(["klarna", "twint"]);
  });
  it("keeps country-bound methods when the country isn't known yet", () => {
    expect(eligibleMethods(["ideal", "twint"], { country: null, currency: "EUR", totalCents: 3_000 })).toEqual(["ideal"]);
  });
});

describe("profit conversion value", async () => {
  const { profitValueCents } = await import("@/lib/conversions");
  it("sends the margin HT (VAT of the destination, Whop fee, product, bump and carrier costs, preparation fee)", () => {
    const lines = [{ quantity: 2, unitCostCents: 1000 }] as never;
    const session = { shippingAddress: { countryCode: "FR" }, store: { vatExempt: false, fulfillmentFeeCents: 200 } } as never;
    const known = { shipCostCents: 0, bumpCostCents: 0, feeCents: 0, feeRate: 0.03 };
    // 6000 TTC → 5000 HT − 2000 costs − 200 fee
    expect(profitValueCents(session, 6000, lines, known)).toBe(2800);
    // Fee not known yet: estimated at the store's rate (3 % of 6000 = 180).
    expect(profitValueCents(session, 6000, lines)).toBe(2620);
    // Recorded fee, carrier cost of the paid rate and bump costs, as Analytics counts them.
    expect(profitValueCents(session, 6000, lines, { shipCostCents: 450, bumpCostCents: 120, feeCents: 210, feeRate: 0.03 })).toBe(5000 - 210 - 2000 - 120 - 450 - 200);
    expect(profitValueCents(session, 100, lines)).toBe(0);
    // Export outside the EU: no VAT removed.
    const ch = { shippingAddress: { countryCode: "CH" }, store: { vatExempt: false, fulfillmentFeeCents: 0 } } as never;
    expect(profitValueCents(ch, 6000, [] as never, known)).toBe(6000);
  });
});
