import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import type { CartLine } from "@/lib/pricing";
import type { Address } from "@/lib/shopify";
import { addDays, tzOf, zonedDay, zoneLabel } from "@/lib/time";
import { drillSessionIds, hasDrill, isDay, parisDayStart, type Drill } from "@/lib/analytics";
import { blendedVatRate, splitVat } from "@/lib/vat";
import { loadVatCategories } from "@/lib/vat-categories";

export const dynamic = "force-dynamic";

/*
 * CSV exports (open in Excel FR / Google Sheets): one row per paid order (default) or one row
 * per line item (?type=lines). Same definitions as Analytics: Paris days, net of refunds,
 * HT at the delivery country's standard VAT rate, costs from the paid quote, lost disputes
 * deducted from the revenue and a dispute fee per disputed payment; refund dates from the
 * refund records (older refunds have none).
 * Params: from/to (Paris days) or days, test=1, source/country/device/method/product, ids (selection).
 */

type Num = { num: string };
/** Amounts as French numbers (64,90), unquoted, so Excel can sum them. */
const num = (cents: number): Num => ({ num: (cents / 100).toFixed(2).replace(".", ",") });
const rateCell = (r: number): Num => ({ num: (r * 100).toFixed(2).replace(".", ",") });

const cell = (v: unknown) => {
  if (v && typeof v === "object" && "num" in v) return String((v as Num).num);
  const s = v == null ? "" : String(v);
  // Quote everything; neutralise spreadsheet formulas (CSV injection).
  return `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
};

const DISPUTE_LABEL: Record<string, string> = { won: "gagné", lost: "perdu", closed: "clos" };

/** Amount lost to a dispute: the recorded loss (whole net amount when none recorded), capped at the net. Same rule as Analytics. */
function lostOf(status: string | null, lostCents: number, net: number): number {
  if (status !== "lost") return 0;
  const cap = Math.max(0, net);
  return Math.min(lostCents || cap, cap);
}

type QuoteAddOn = { title?: string; priceCents?: number; variantId?: string | null; costCents?: number | null };

export async function GET(req: Request, ctx: { params: Promise<{ storeId: string }> }) {
  await requireAdmin();
  const { storeId } = await ctx.params;
  const url = new URL(req.url);
  const sp = url.searchParams;
  const store = await db.store.findUnique({ where: { id: storeId }, select: { vatExempt: true, vatDomesticOnly: true, homeCountry: true, fulfillmentFeeCents: true, disputeFeeCents: true, timezone: true } });
  if (!store) return new Response("Boutique introuvable", { status: 404 });

  const ids = [...new Set(sp.getAll("ids").filter((x) => /^[a-z0-9]{10,40}$/i.test(x)))].slice(0, 5000);
  const includeTest = sp.get("test") === "1";
  const tz = tzOf(store);
  // Column headers name the store's zone ("heure de New York").
  const zone = zoneLabel(tz);
  const today = zonedDay(new Date(), tz);
  let from = sp.get("from");
  let to = sp.get("to");
  if (!isDay(from) || !isDay(to) || from > to) {
    const days = Math.min(365, Math.max(1, parseInt(sp.get("days") ?? "30", 10) || 30));
    to = isDay(to) ? to : today;
    from = isDay(from) && from <= to ? from : addDays(to, -(days - 1));
  }
  const since = parisDayStart(from, tz);
  const until = parisDayStart(addDays(to, 1), tz);
  const drill: Drill = {
    source: sp.get("source") || undefined,
    country: sp.get("country") || undefined,
    device: sp.get("device") === "mobile" || sp.get("device") === "desktop" ? (sp.get("device") as "mobile" | "desktop") : undefined,
    method: sp.get("method") || undefined,
    product: sp.get("product") || undefined,
    geo: /^([A-Z]{2}|inconnu)$/.test(sp.get("geo") ?? "") ? (sp.get("geo") as string) : undefined,
    lang: /^([a-z]{2,3}|inconnu)$/.test(sp.get("lang") ?? "") ? (sp.get("lang") as string) : undefined,
  };
  const drillIds = !ids.length && hasDrill(drill) ? await drillSessionIds(storeId, drill, { since, until, includeTest }) : null;

  const rows = await db.checkoutSession.findMany({
    where: ids.length
      ? { storeId, id: { in: ids } }
      : { storeId, status: "PAID", paidAt: { gte: since, lt: until }, ...(includeTest ? {} : { test: false }), ...(drillIds ? { id: { in: drillIds } } : {}) },
    orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
    include: { upsells: { where: { status: "PAID" } } },
  });
  const quoteIds = rows.map((s) => s.paidQuoteId).filter((x): x is string => !!x);
  const quotes = quoteIds.length
    ? await db.checkoutQuote.findMany({ where: { id: { in: quoteIds } }, select: { id: true, addOns: true, shippingCostCents: true, shippingRateId: true } })
    : [];
  const rateIds = [...new Set([...rows.map((s) => s.shippingRateId), ...quotes.map((q) => q.shippingRateId)].filter((x): x is string => !!x))];
  const rates = rateIds.length ? await db.shippingRate.findMany({ where: { id: { in: rateIds } }, select: { id: true, costCents: true } }) : [];
  const refundRows = rows.length
    ? await db.refundRecord.findMany({ where: { storeId, sessionId: { in: rows.map((s) => s.id) } }, orderBy: { createdAt: "asc" }, select: { sessionId: true, amountCents: true, createdAt: true } })
    : [];
  const refundsOf = new Map<string, { amountCents: number; createdAt: Date }[]>();
  for (const r of refundRows) refundsOf.set(r.sessionId, [...(refundsOf.get(r.sessionId) ?? []), r]);
  const quoteOf = new Map(quotes.map((q) => [q.id, q]));
  const rateCost = new Map(rates.map((r) => [r.id, r.costCents]));
  const vatCategories = await loadVatCategories(storeId);

  const computed = rows.map((s) => {
    const a = s.shippingAddress as Address | null;
    const lines = (Array.isArray(s.lines) ? s.lines : []) as unknown as CartLine[];
    const quote = s.paidQuoteId ? quoteOf.get(s.paidQuoteId) : undefined;
    const bumps = (Array.isArray(quote?.addOns) ? quote.addOns : []) as QuoteAddOn[];
    const paid = s.status === "PAID";
    const orderGross = paid ? s.totalCents || s.subtotalCents : 0;
    const offerGross = s.upsells.reduce((x, u) => x + u.amountCents, 0);
    const refunded = s.refundedCents + s.upsells.reduce((x, u) => x + u.refundedCents, 0);
    const lost = lostOf(s.disputeStatus, s.disputeLostCents, orderGross - s.refundedCents) + s.upsells.reduce((x, u) => x + lostOf(u.disputeStatus, u.disputeLostCents, u.amountCents - u.refundedCents), 0);
    const disputes = (s.disputed ? 1 : 0) + s.upsells.filter((u) => u.disputed).length;
    const disputeFee = disputes * store.disputeFeeCents;
    const net = orderGross + offerGross - refunded - lost;
    // Reduced-rate variants (Coûts produits › TVA): the lines' blended rate, like Analytics.
    const rate = blendedVatRate(lines, (v) => vatCategories.get(v), a?.countryCode, { vatExempt: store.vatExempt, domesticOnly: store.vatDomesticOnly, homeCountry: store.homeCountry || undefined }).rate;
    const { htCents, vatCents } = splitVat(net, rate);
    const feesKnown = s.whopFeeCents != null && s.upsells.every((u) => u.whopFeeCents != null);
    const fees = (s.whopFeeCents ?? 0) + s.upsells.reduce((x, u) => x + (u.whopFeeCents ?? 0), 0);
    const productsKnown = lines.every((l) => l.unitCostCents != null) && s.upsells.every((u) => u.costCents != null);
    const productCost = lines.reduce((x, l) => x + l.quantity * (l.unitCostCents ?? 0), 0) + s.upsells.reduce((x, u) => x + (u.costCents ?? 0) * u.quantity, 0);
    const bumpsKnown = bumps.every((b) => b.costCents != null);
    const bumpCost = bumps.reduce((x, b) => x + (b.costCents ?? 0), 0);
    const shipCostRaw = quote?.shippingCostCents ?? rateCost.get(quote?.shippingRateId ?? s.shippingRateId ?? "") ?? null;
    const ships = lines.some((l) => l.requiresShipping !== false);
    const shipKnown = shipCostRaw != null || !ships;
    const shipCost = shipCostRaw ?? 0;
    const fulfil = paid ? store.fulfillmentFeeCents : 0;
    const margin = htCents - fees - productCost - bumpCost - shipCost - fulfil - disputeFee;
    return { s, a, lines, bumps, orderGross, offerGross, refunded, lost, disputes, disputeFee, net, rate, htCents, vatCents, fees, feesKnown, productCost, productsKnown, bumpCost, bumpsKnown, shipCost, shipKnown, fulfil, margin };
  });

  const type = sp.get("type") === "lines" ? "lines" : "orders";
  const date = (s: (typeof rows)[number]) => (s.paidAt ?? s.createdAt).toLocaleString("fr-FR", { timeZone: tz });
  const name = (a: Address | null) => [a?.firstName, a?.lastName].filter(Boolean).join(" ");
  let header: string[];
  let body: unknown[][];

  if (type === "orders") {
    header = [
      `Date (${zone})`, "Commande Shopify", "Statut", "E-mail", "Nom", "Pays", "Articles", "Sous-total", "Réduction", "Code", "Livraison", "Options",
      "Total payé", "Offres post-achat", "Remboursé", `Remboursements (date ${zone} : montant)`, "Litige perdu", "Net TTC", "Taux TVA (%)", "TVA", "Net HT",
      "Frais Whop", "Coût produits", "Coût options", "Coût livraison", "Préparation", "Frais de litige", "Marge (HT − frais − coûts)", "Coûts complets",
      "Devise", "Moyen de paiement", "Paiement Whop", "Source", "Campagne", "utm_content", "utm_term", "Clic pub (fbclid/ttclid/gclid)", "Variante A/B", "Litige", "Test",
    ];
    body = computed.map((c) => {
      const s = c.s;
      const utm = (s.utm ?? {}) as Record<string, string>;
      const clickIds = ["fbclid", "ttclid", "gclid"].filter((k) => utm[k]).join(", ");
      const complete = c.feesKnown && c.productsKnown && c.bumpsKnown && c.shipKnown;
      return [
        date(s),
        s.shopifyOrderName,
        s.status === "PAID" ? "payée" : s.status.toLowerCase(),
        s.email,
        name(c.a),
        c.a?.countryCode,
        c.lines.map((l) => `${l.quantity}x ${l.title}${l.variantTitle ? ` (${l.variantTitle})` : ""}`).join(" | "),
        num(s.subtotalCents),
        num(s.discountCents),
        s.discountCode,
        num(s.shippingCents),
        num(s.addOnsCents),
        num(c.orderGross),
        num(c.offerGross),
        num(c.refunded),
        (refundsOf.get(s.id) ?? []).map((r) => `${r.createdAt.toLocaleDateString("fr-FR", { timeZone: tz })} : ${(r.amountCents / 100).toFixed(2).replace(".", ",")}`).join(" | ") ||
          (c.refunded > 0 ? "date non enregistrée" : ""),
        num(c.lost),
        num(c.net),
        rateCell(c.rate),
        num(c.vatCents),
        num(c.htCents),
        c.feesKnown ? num(c.fees) : "inconnus",
        c.productsKnown ? num(c.productCost) : "",
        c.bumps.length ? (c.bumpsKnown ? num(c.bumpCost) : "") : num(0),
        c.shipKnown ? num(c.shipCost) : "",
        num(c.fulfil),
        num(c.disputeFee),
        num(c.margin),
        complete ? "oui" : "non (coûts manquants comptés 0)",
        s.currency,
        s.paymentMethodType ?? "non précisé",
        s.whopPaymentId,
        utm.utm_source,
        utm.utm_campaign,
        utm.utm_content,
        utm.utm_term,
        clickIds ? `oui (${clickIds})` : "",
        s.variant,
        c.disputes ? `oui${s.disputeStatus ? ` (${DISPUTE_LABEL[s.disputeStatus] ?? s.disputeStatus})` : ""}` : "",
        s.test ? "oui" : "",
      ];
    });
  } else {
    header = [
      `Date (${zone})`, "Commande Shopify", "Pays", "Type", "Produit", "Variante", "SKU", "Quantité", "Prix unitaire TTC", "Total ligne TTC",
      "Remise allouée", "Remboursé + litige perdu alloué", "Net TTC", "Taux TVA (%)", "Net HT", "Coût unitaire", "Coût total", "Marge HT", "Devise", "Source", "Campagne", "Test",
    ];
    body = [];
    for (const c of computed) {
      const s = c.s;
      const utm = (s.utm ?? {}) as Record<string, string>;
      const common = { date: date(s), order: s.shopifyOrderName, country: c.a?.countryCode };
      const tail = [s.currency, utm.utm_source, utm.utm_campaign, s.test ? "oui" : ""];
      // Discount spread over the lines pro rata; order refunds spread over everything paid with the order.
      const orderLost = lostOf(s.disputeStatus, s.disputeLostCents, c.orderGross - s.refundedCents);
      const refundShare = c.orderGross > 0 ? (s.refundedCents + orderLost) / c.orderGross : 0;
      for (const l of c.lines) {
        const gross = l.quantity * l.unitPriceCents;
        const discount = s.subtotalCents > 0 ? Math.round((gross * s.discountCents) / s.subtotalCents) : 0;
        const refund = Math.round((gross - discount) * refundShare);
        const net = gross - discount - refund;
        const ht = splitVat(net, c.rate).htCents;
        const cost = l.unitCostCents == null ? null : l.unitCostCents * l.quantity;
        body.push([
          common.date, common.order, common.country, "article", l.title, l.variantTitle, l.sku, l.quantity, num(l.unitPriceCents), num(gross),
          num(discount), num(refund), num(net), rateCell(c.rate), num(ht), l.unitCostCents == null ? "" : num(l.unitCostCents), cost == null ? "" : num(cost), cost == null ? "" : num(ht - cost), ...tail,
        ]);
      }
      for (const b of c.bumps) {
        const gross = b.priceCents ?? 0;
        const refund = Math.round(gross * refundShare);
        const ht = splitVat(gross - refund, c.rate).htCents;
        body.push([
          common.date, common.order, common.country, "option", b.title, "", "", 1, num(gross), num(gross),
          num(0), num(refund), num(gross - refund), rateCell(c.rate), num(ht), b.costCents == null ? "" : num(b.costCents), b.costCents == null ? "" : num(b.costCents), b.costCents == null ? "" : num(ht - b.costCents), ...tail,
        ]);
      }
      for (const u of s.upsells) {
        const net = u.amountCents - u.refundedCents - lostOf(u.disputeStatus, u.disputeLostCents, u.amountCents - u.refundedCents);
        const ht = splitVat(net, c.rate).htCents;
        const cost = u.costCents == null ? null : u.costCents * u.quantity;
        body.push([
          common.date, u.shopifyOrderName ?? common.order, common.country, "offre post-achat", u.title, "", "", u.quantity, num(Math.round(u.amountCents / Math.max(1, u.quantity))), num(u.amountCents),
          num(0), num(u.amountCents - net), num(net), rateCell(c.rate), num(ht), u.costCents == null ? "" : num(u.costCents), cost == null ? "" : num(cost), cost == null ? "" : num(ht - cost), ...tail,
        ]);
      }
    }
  }

  // BOM + ";" so Excel (FR) opens it with the right columns and accents.
  const csv = "﻿" + [header.map(cell).join(";"), ...body.map((r) => r.map(cell).join(";"))].join("\r\n");
  const name2 = ids.length ? `selection-${ids.length}` : `${from}_${to}`;
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${type === "lines" ? "lignes" : "commandes"}-${name2}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
