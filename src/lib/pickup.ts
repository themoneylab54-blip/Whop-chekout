import "server-only";
import { extFetch } from "./ext";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Store } from "@prisma/client";
import { decrypt } from "./crypto";

/*
 * Relay-point delivery (Mondial Relay "Point Relais" / Locker), the most used delivery
 * mode in France and Belgium. Points are searched server-side with the merchant's own
 * Mondial Relay credentials (brand code + private key), then the chosen point becomes
 * the Shopify order's shipping address.
 */

export const PICKUP_COUNTRIES = ["FR", "BE", "LU", "NL", "ES", "PT", "DE", "AT", "IT", "PL"] as const;

export const pickupPointSchema = z.object({
  provider: z.literal("mondial_relay"),
  id: z.string().regex(/^[A-Z]{2}-?\d{4,8}$|^\d{4,8}$/),
  name: z.string().trim().min(1).max(120),
  address1: z.string().trim().min(1).max(200),
  zip: z.string().trim().min(2).max(12),
  city: z.string().trim().min(1).max(100),
  countryCode: z.string().length(2).toUpperCase(),
});
export type PickupPoint = z.infer<typeof pickupPointSchema> & { hours?: { day: string; slots: string[] }[]; distanceM?: number | null; lat?: number | null; lng?: number | null };

const ENDPOINT = "https://api.mondialrelay.com/Web_Services.asmx";
const DAYS: [string, string][] = [
  ["Lundi", "Lundi"],
  ["Mardi", "Mardi"],
  ["Mercredi", "Mercredi"],
  ["Jeudi", "Jeudi"],
  ["Vendredi", "Vendredi"],
  ["Samedi", "Samedi"],
  ["Dimanche", "Dimanche"],
];

export function pickupConfigured(store: Pick<Store, "mondialRelayEnseigne" | "mondialRelayKey">) {
  return !!store.mondialRelayEnseigne && !!store.mondialRelayKey;
}

/** Mondial Relay's request signature: uppercase MD5 of every parameter in order, then the private key. */
export function mondialRelaySecurity(params: string[], privateKey: string) {
  return createHash("md5").update(params.join("") + privateKey, "utf8").digest("hex").toUpperCase();
}

const esc = (v: string) => v.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
const tag = (xml: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim() ?? "";
const decode = (v: string) => v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&apos;/g, "'").replace(/&quot;/g, '"');

/** Parses a WSI4_PointRelais_Recherche answer (exported for tests). */
export function parsePointsResponse(xml: string, country: string): PickupPoint[] {
  const stat = tag(xml, "STAT");
  if (stat && stat !== "0") throw new Error(`Mondial Relay STAT ${stat}`);
  const blocks = xml.match(/<PointRelais_Details>[\s\S]*?<\/PointRelais_Details>/g) ?? [];
  return blocks.flatMap((b) => {
    const num = tag(b, "Num");
    const name = decode([tag(b, "LgAdr1"), tag(b, "LgAdr2")].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
    const address1 = decode([tag(b, "LgAdr3"), tag(b, "LgAdr4")].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim();
    if (!num || !name || !address1) return [];
    const hours = DAYS.map(([key, day]) => {
      const raw = (b.match(new RegExp(`<Horaires_${key}>[\\s\\S]*?</Horaires_${key}>`))?.[0] ?? "").match(/<string>(\d{4})<\/string>/g) ?? [];
      const times = raw.map((s) => s.replace(/<\/?string>/g, "")).filter((t) => t !== "0000");
      const slots: string[] = [];
      for (let i = 0; i + 1 < times.length; i += 2) slots.push(`${times[i].slice(0, 2)}h${times[i].slice(2)}–${times[i + 1].slice(0, 2)}h${times[i + 1].slice(2)}`);
      return { day, slots };
    });
    const num2 = (v: string) => (v ? Number(v.replace(",", ".")) : null);
    return [
      {
        provider: "mondial_relay" as const,
        id: `${(tag(b, "Pays") || country).toUpperCase()}-${num}`,
        name,
        address1,
        zip: tag(b, "CP"),
        city: decode(tag(b, "Ville")),
        countryCode: (tag(b, "Pays") || country).toUpperCase(),
        hours,
        distanceM: num2(tag(b, "Distance")),
        lat: num2(tag(b, "Latitude")),
        lng: num2(tag(b, "Longitude")),
      },
    ];
  });
}

/** The 10 nearest relay points to a postcode (and city, when given). */
export async function searchPickupPoints(
  store: Pick<Store, "mondialRelayEnseigne" | "mondialRelayKey">,
  where: { country: string; zip: string; city?: string | null },
): Promise<PickupPoint[]> {
  if (!pickupConfigured(store)) throw new Error("Mondial Relay non configuré");
  const country = where.country.toUpperCase();
  const values: [string, string][] = [
    ["Enseigne", store.mondialRelayEnseigne!],
    ["Pays", country],
    ["Ville", (where.city ?? "").toUpperCase().slice(0, 26)],
    ["CP", where.zip.replace(/\s/g, "")],
    ["Latitude", ""],
    ["Longitude", ""],
    ["Taille", ""],
    ["Poids", ""],
    ["Action", ""],
    ["DelaiEnvoi", "0"],
    ["RayonRecherche", "20"],
    ["TypeActivite", ""],
    ["NACE", ""],
    ["NombreResultats", "10"],
  ];
  const security = mondialRelaySecurity(values.map(([, v]) => v), decrypt(store.mondialRelayKey!));
  const body = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>
<WSI4_PointRelais_Recherche xmlns="http://www.mondialrelay.fr/webservice/">${values.map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join("")}<Security>${security}</Security></WSI4_PointRelais_Recherche>
</soap:Body></soap:Envelope>`;
  const res = await extFetch("mondial_relay", "point search", ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: '"http://www.mondialrelay.fr/webservice/WSI4_PointRelais_Recherche"' },
    body,
    signal: AbortSignal.timeout(8000),
    cache: "no-store",
  });
  const xml = await res.text();
  if (!res.ok) throw new Error(`Mondial Relay ${res.status}`);
  return parsePointsResponse(xml, country);
}
