import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/** ILIKE pattern of a free-text term: `%`, `_` and `\` are literal, spaces match any run of spaces. */
export function likePattern(term: string): string {
  const escaped = term.trim().replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\s+/g, "%");
  return `%${escaped}%`;
}

/**
 * Checkout sessions of a store whose buyer name (shipping address, "Prénom Nom" or
 * "Nom Prénom") matches `term`, newest paid first. The name only lives in the address JSON.
 */
export async function sessionIdsByBuyerName(storeId: string, term: string, take = 8): Promise<string[]> {
  if (term.trim().length < 2) return [];
  const like = likePattern(term);
  const first = Prisma.sql`coalesce("shippingAddress"->>'firstName', '')`;
  const last = Prisma.sql`coalesce("shippingAddress"->>'lastName', '')`;
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM "CheckoutSession"
    WHERE "storeId" = ${storeId} AND "shippingAddress" IS NOT NULL
      AND ((${first} || ' ' || ${last}) ILIKE ${like} OR (${last} || ' ' || ${first}) ILIKE ${like})
    ORDER BY "paidAt" DESC NULLS LAST, "createdAt" DESC
    LIMIT ${take}`;
  return rows.map((r) => r.id);
}

/** "Prénom Nom" of a stored shipping address, or null. */
export function buyerName(address: unknown): string | null {
  if (!address || typeof address !== "object") return null;
  const a = address as { firstName?: unknown; lastName?: unknown };
  const name = [a.firstName, a.lastName].filter((v): v is string => typeof v === "string" && !!v.trim()).join(" ").trim();
  return name || null;
}
