import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import type { CartLine } from "@/lib/pricing";
import type { Address } from "@/lib/shopify";

export const dynamic = "force-dynamic";

/** Amounts as French numbers (64,90), unquoted, so Excel can sum them. */
const num = (cents: number) => ({ num: (cents / 100).toFixed(2).replace(".", ",") });

const cell = (v: unknown) => {
  if (v && typeof v === "object" && "num" in v) return String((v as { num: string }).num);
  const s = v == null ? "" : String(v);
  // Quote everything; neutralise spreadsheet formulas (CSV injection).
  return `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

/** Paid orders of the period as CSV (opens in Excel / Google Sheets). */
export async function GET(req: Request, ctx: { params: Promise<{ storeId: string }> }) {
  await requireAdmin();
  const { storeId } = await ctx.params;
  const url = new URL(req.url);
  const days = Math.min(365, Math.max(1, parseInt(url.searchParams.get("days") ?? "30", 10) || 30));
  const includeTest = url.searchParams.get("test") === "1";
  const rows = await db.checkoutSession.findMany({
    where: { storeId, status: "PAID", paidAt: { gte: new Date(Date.now() - days * 86_400_000) }, ...(includeTest ? {} : { test: false }) },
    orderBy: { paidAt: "desc" },
    include: { upsells: { where: { status: "PAID" } } },
  });
  const header = [
    "Date (Paris)", "Commande Shopify", "E-mail", "Pays", "Articles", "Sous-total", "Réduction", "Code", "Livraison", "Options",
    "Total", "Offres post-achat", "Offres remboursées", "Frais Whop", "Remboursé", "Devise", "Moyen de paiement", "Paiement Whop", "Source", "Campagne", "Variante A/B", "Litige", "Test",
  ];
  const lines = rows.map((s) => {
    const a = s.shippingAddress as Address | null;
    const utm = (s.utm ?? {}) as Record<string, string>;
    const items = (s.lines as unknown as CartLine[]).map((l) => `${l.quantity}x ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`).join(" | ");
    return [
      s.paidAt?.toLocaleString("fr-FR", { timeZone: "Europe/Paris" }),
      s.shopifyOrderName,
      s.email,
      a?.countryCode,
      items,
      num(s.subtotalCents),
      num(s.discountCents),
      s.discountCode,
      num(s.shippingCents),
      num(s.addOnsCents),
      num(s.totalCents),
      num(s.upsells.reduce((x, u) => x + u.amountCents, 0)),
      num(s.upsells.reduce((x, u) => x + u.refundedCents, 0)),
      s.whopFeeCents != null ? num(s.whopFeeCents) : "",
      num(s.refundedCents),
      s.currency,
      s.paymentMethodType,
      s.whopPaymentId,
      utm.utm_source,
      utm.utm_campaign,
      s.variant,
      s.disputed ? "oui" : "",
      s.test ? "oui" : "",
    ]
      .map(cell)
      .join(";");
  });
  // BOM + ";" so Excel (FR) opens it with the right columns and accents.
  const body = "﻿" + [header.map(cell).join(";"), ...lines].join("\r\n");
  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="commandes-${days}j.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
