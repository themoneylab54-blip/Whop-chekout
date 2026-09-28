import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { analyze, bucketOf, summarize } from "@/lib/experiments";
import { statementDescriptor } from "@/lib/whop";
import { buildEvidence } from "@/lib/disputes";
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

describe("reviewReasons with presentment amounts", () => {
  const snap = { totalCents: 5490, currency: "EUR", shippingCountries: [], shippingRateId: null };
  it("checks the presentment amount when it is in the checkout currency", () => {
    expect(reviewReasons(snap, { totalCents: 6000, currency: "USD", presentmentCents: 5000, presentmentCurrency: "eur" }, null)).toHaveLength(1);
    expect(reviewReasons(snap, { totalCents: 6000, currency: "USD", presentmentCents: 5490, presentmentCurrency: "eur" }, null)).toEqual([]);
  });
});
