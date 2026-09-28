import { describe, expect, it } from "vitest";
import { mondialRelaySecurity, parsePointsResponse, pickupPointSchema } from "@/lib/pickup";
import { buildOrderCreateInput } from "@/lib/shopify";

const xml = `<?xml version="1.0"?><soap:Envelope><soap:Body><WSI4_PointRelais_RechercheResponse><WSI4_PointRelais_RechercheResult>
<STAT>0</STAT><PointsRelais><PointRelais_Details>
<STAT>0</STAT><Num>020465</Num><LgAdr1>TABAC DU MARCHE</LgAdr1><LgAdr2 /><LgAdr3>12 RUE DE LA PAIX</LgAdr3><LgAdr4 />
<CP>75002</CP><Ville>PARIS</Ville><Pays>FR</Pays><Latitude>48,8698</Latitude><Longitude>2,3312</Longitude><Distance>350</Distance>
<Horaires_Lundi><string>0900</string><string>1230</string><string>1400</string><string>1900</string></Horaires_Lundi>
<Horaires_Dimanche><string>0000</string><string>0000</string><string>0000</string><string>0000</string></Horaires_Dimanche>
</PointRelais_Details></PointsRelais></WSI4_PointRelais_RechercheResult></WSI4_PointRelais_RechercheResponse></soap:Body></soap:Envelope>`;

describe("Mondial Relay pickup points", () => {
  it("signs requests with the uppercase MD5 of the parameters and the private key", () => {
    expect(mondialRelaySecurity(["BDTEST13", "FR", "", "75002"], "PrivateK")).toMatch(/^[0-9A-F]{32}$/);
    expect(mondialRelaySecurity(["A"], "k")).not.toBe(mondialRelaySecurity(["B"], "k"));
  });

  it("parses points with address, distance and opening hours", () => {
    const [p] = parsePointsResponse(xml, "FR");
    expect(p).toMatchObject({ id: "FR-020465", name: "TABAC DU MARCHE", address1: "12 RUE DE LA PAIX", zip: "75002", city: "PARIS", countryCode: "FR", distanceM: 350, lat: 48.8698 });
    expect(p.hours?.find((h) => h.day === "Lundi")?.slots).toEqual(["09h00–12h30", "14h00–19h00"]);
    expect(p.hours?.find((h) => h.day === "Dimanche")?.slots).toEqual([]);
    expect(pickupPointSchema.safeParse(p).success).toBe(true);
  });

  it("reports an API error code", () => {
    expect(() => parsePointsResponse("<STAT>97</STAT>", "FR")).toThrow(/97/);
  });

  it("ships to the relay point and bills the buyer's own address", () => {
    const order = buildOrderCreateInput({
      sessionId: "s1",
      currency: "EUR",
      email: "a@b.fr",
      acceptsMarketing: false,
      shippingAddress: { firstName: "Alex", lastName: "Martin", address1: "1 rue A", city: "Lyon", zip: "69001", countryCode: "FR" },
      pickupPoint: { provider: "mondial_relay", id: "FR-020465", name: "TABAC DU MARCHE", address1: "12 RUE DE LA PAIX", zip: "75002", city: "PARIS", countryCode: "FR" },
      lines: [],
      addOns: [],
      discount: null,
      shipping: { title: "Point Relais", priceCents: 390 },
      totalCents: 390,
      whopPaymentId: "pay_1",
      test: false,
    }) as Record<string, Record<string, unknown> & string[]>;
    expect(order.shippingAddress).toMatchObject({ address1: "12 RUE DE LA PAIX", city: "PARIS", firstName: "Alex", company: "TABAC DU MARCHE (Point Relais FR-020465)" });
    expect(order.billingAddress).toMatchObject({ address1: "1 rue A", city: "Lyon" });
    expect(order.tags).toContain("point-relais");
  });
});
