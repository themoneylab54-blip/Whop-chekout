import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { significance, summarize } from "@/lib/experiments";
import { statementDescriptor } from "@/lib/whop";
import { buildEvidence } from "@/lib/disputes";
import { metaPayload, tiktokPayload } from "@/lib/conversions";
import { reviewReasons } from "@/lib/checkout";

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

const store = {
  id: "st1",
  name: "Ma Boutique",
  metaPixelId: "123",
  metaTestEventCode: null,
  tiktokPixelId: "TT1",
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
  lines: [{ variantId: "gid://shopify/ProductVariant/42", title: "Sweat", variantTitle: "M", quantity: 2, unitPriceCents: 2500, imageUrl: null }],
  termsAcceptedAt: new Date("2026-09-01T09:59:00Z"),
  store,
} as never;

describe("server-side conversions", () => {
  it("Meta: hashed normalized identity, dedupe id, value and contents", () => {
    const p = metaPayload(session, "Purchase");
    const e = p.data[0];
    expect(e.event_id).toBe("purchase-sess1");
    expect(e.user_data.em).toEqual([sha("alex@example.com")]);
    expect(e.user_data.ph).toEqual([sha("33600000000")]);
    expect(e.user_data.fbp).toBe("fb.1.1.1");
    expect(e.user_data.client_ip_address).toBe("1.2.3.4");
    expect(e.custom_data).toMatchObject({ currency: "EUR", value: 54.9, num_items: 2, content_ids: ["42"], order_id: "#1001" });
    expect(e.event_time).toBe(Math.floor(new Date("2026-09-01T10:00:00Z").getTime() / 1000));
  });
  it("TikTok: CompletePayment with the same dedupe id", () => {
    const p = tiktokPayload(session, "CompletePayment");
    expect(p.event_source_id).toBe("TT1");
    expect(p.data[0].event_id).toBe("purchase-sess1");
    expect(p.data[0].user.ttclid).toBe("cl1");
    expect(p.data[0].properties.value).toBe(54.9);
  });
});

describe("statementDescriptor", () => {
  it("normalizes to 5–22 plain uppercase characters", () => {
    expect(statementDescriptor("Boutique Élégance & Co!")).toBe("BOUTIQUE ELEGANCE CO");
    expect(statementDescriptor("A very long store name that goes on")).toHaveLength(22);
    expect(statementDescriptor("abc")).toBeNull();
  });
});

describe("A/B significance", () => {
  it("summarizes variants and gives high confidence for a large, clear lift", () => {
    const rows = [
      ...Array.from({ length: 1000 }, (_, i) => ({ variant: "A", status: i < 30 ? "PAID" : "OPEN", totalCents: 5000 })),
      ...Array.from({ length: 1000 }, (_, i) => ({ variant: "B", status: i < 60 ? "PAID" : "OPEN", totalCents: 5000 })),
    ];
    const [a, b] = summarize(rows);
    expect(a.cvr).toBeCloseTo(0.03);
    expect(b.rpv).toBe(300);
    const s = significance(a, b);
    expect(s.lift).toBeCloseTo(1);
    expect(s.confidence).toBeGreaterThan(0.99);
  });
  it("gives low confidence on tiny samples", () => {
    const [a, b] = summarize([
      { variant: "A", status: "PAID", totalCents: 1 },
      { variant: "A", status: "OPEN", totalCents: 1 },
      { variant: "B", status: "OPEN", totalCents: 1 },
      { variant: "B", status: "OPEN", totalCents: 1 },
    ]);
    expect(significance(a, b).confidence).toBeLessThan(0.8);
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
