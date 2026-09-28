import "server-only";
import { stopForTime } from "./deadline";
import { Prisma } from "@prisma/client";
import { db } from "./db";
import { parseCsvAmount, splitLine } from "./adspend-csv";
import { log } from "./log";

/*
 * Product costs kept in the app ("Coûts produits"): dropshippers rarely fill Shopify's
 * "Coût par article", so the merchant types (or imports) a cost per variant, effective from a
 * date. Paid orders snapshot Shopify's cost in `lines[].unitCostCents` (and
 * `UpsellCharge.costCents`); the app cost effective at the payment date is applied at payment
 * (`applyAppCosts`, `offerCostSnapshot`), after each save/import and by the tick for recent
 * orders (`recomputeMissingCosts`). It wins over Shopify's (see "Precedence" below) and is
 * marked `unitCostSource: "app"` so a later change is re-applied. Analytics and the profit
 * conversion value read those snapshots.
 */

/** "Depuis toujours": effective date of a cost entered without a date. */
export const SINCE_ALWAYS = new Date("2000-01-01T00:00:00Z");

export const MAX_COST_CENTS = 100_000_00;

export type CostRow = { costCents: number; effectiveFrom: Date };

/** Cost effective at `at`: the latest entry whose effective date is ≤ at (rows in any order). Pure. */
export function costAt(rows: CostRow[], at: Date): number | null {
  let best: CostRow | null = null;
  for (const r of rows) if (r.effectiveFrom.getTime() <= at.getTime() && (!best || r.effectiveFrom > best.effectiveFrom)) best = r;
  return best ? best.costCents : null;
}

/** "123", "gid://shopify/ProductVariant/123" → the variant GID; null when unreadable. Pure. */
export function normalizeVariantId(v: string): string | null {
  const s = v.trim().replace(/^"|"$/g, "");
  if (/^\d{1,20}$/.test(s)) return `gid://shopify/ProductVariant/${s}`;
  const m = /^gid:\/\/shopify\/ProductVariant\/(\d{1,20})$/.exec(s);
  return m ? `gid://shopify/ProductVariant/${m[1]}` : null;
}

/** Numeric part of a variant GID (display). Pure. */
export function variantNumber(gid: string): string {
  return gid.replace(/^gid:\/\/shopify\/ProductVariant\//, "");
}

export type CostCsvRow = { line: number; variantId: string; costCents: number };
export type CostCsvError = { line: number; raw: string; message: string };
export const COST_CSV_MAX_LINES = 5000;

/**
 * "variant_id;coût" lines (";", tab or ","; header optional; "12,50" or "12.50"; numeric id or GID).
 * A variant listed twice: the last line wins. Pure.
 */
export function parseCostCsv(text: string): { rows: CostCsvRow[]; errors: CostCsvError[] } {
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const sample = lines.find((l) => l.trim()) ?? "";
  const sep = sample.includes(";") ? ";" : sample.includes("\t") ? "\t" : ",";
  const rows = new Map<string, CostCsvRow>();
  const errors: CostCsvError[] = [];
  let seen = 0;
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    let f = splitLine(raw, sep);
    if (seen === 0 && !normalizeVariantId(f[0] ?? "") && /variant|id|sku|produit/i.test(f[0] ?? "")) return;
    seen++;
    if (seen > COST_CSV_MAX_LINES) {
      if (seen === COST_CSV_MAX_LINES + 1) errors.push({ line, raw, message: `Plus de ${COST_CSV_MAX_LINES} lignes : le reste est ignoré.` });
      return;
    }
    // "12,50" split by a comma separator.
    if (sep === "," && f.length === 3 && /^\d+$/.test(f[1]) && /^\d{1,2}$/.test(f[2])) f = [f[0], `${f[1]},${f[2]}`];
    if (f.length < 2) return void errors.push({ line, raw, message: "2 colonnes attendues : variant_id ; coût." });
    const variantId = normalizeVariantId(f[0]);
    if (!variantId) return void errors.push({ line, raw, message: `Identifiant de variante invalide « ${f[0]} » (chiffres ou gid://shopify/ProductVariant/…).` });
    const costCents = parseCsvAmount(f[1]);
    if (costCents == null || costCents > MAX_COST_CENTS) return void errors.push({ line, raw, message: `Coût invalide « ${f[1]} ».` });
    if (rows.has(variantId)) errors.push({ line, raw, message: "Doublon : cette ligne remplace la précédente." });
    rows.set(variantId, { line, variantId, costCents });
  });
  return { rows: [...rows.values()], errors };
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export async function listProductCosts(storeId: string) {
  return db.productCost.findMany({ where: { storeId }, orderBy: [{ variantId: "asc" }, { effectiveFrom: "desc" }] });
}

/** Creates or replaces the cost of a variant from `effectiveFrom` (same variant + date = correction). */
export async function setProductCost(storeId: string, input: { variantId: string; costCents: number; effectiveFrom?: Date | null; title?: string | null }) {
  const effectiveFrom = input.effectiveFrom ?? SINCE_ALWAYS;
  if (!Number.isInteger(input.costCents) || input.costCents < 0 || input.costCents > MAX_COST_CENTS) throw new Error("Coût invalide");
  return db.productCost.upsert({
    where: { storeId_variantId_effectiveFrom: { storeId, variantId: input.variantId, effectiveFrom } },
    create: { storeId, variantId: input.variantId, costCents: input.costCents, effectiveFrom, title: input.title?.slice(0, 200) ?? null },
    update: { costCents: input.costCents, ...(input.title ? { title: input.title.slice(0, 200) } : {}) },
  });
}

export async function deleteProductCost(storeId: string, id: string): Promise<boolean> {
  const r = await db.productCost.deleteMany({ where: { id, storeId } });
  return r.count > 0;
}

/** Cost of a variant effective at `at` (null when none was entered for that date). */
export async function costFor(storeId: string, variantId: string, at: Date): Promise<number | null> {
  const row = await db.productCost.findFirst({ where: { storeId, variantId, effectiveFrom: { lte: at } }, orderBy: { effectiveFrom: "desc" }, select: { costCents: true } });
  return row?.costCents ?? null;
}

/** Every cost of the store, by variant (for batch lookups). */
async function costIndex(storeId: string): Promise<Map<string, CostRow[]>> {
  const map = new Map<string, CostRow[]>();
  for (const r of await db.productCost.findMany({ where: { storeId }, select: { variantId: true, costCents: true, effectiveFrom: true } })) {
    const list = map.get(r.variantId) ?? [];
    list.push({ costCents: r.costCents, effectiveFrom: r.effectiveFrom });
    map.set(r.variantId, list);
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Overview ("Coûts produits" page)                                    */
/* ------------------------------------------------------------------ */

export type CostSource = "shopify" | "app" | "missing";

export type VariantCost = {
  variantId: string;
  title: string;
  orders: number;
  units: number;
  /** Cost used for a new order today and where it comes from. */
  source: CostSource;
  currentCents: number | null;
  /** Latest Shopify cost seen on an order (null when Shopify never gave one). */
  shopifyCents: number | null;
  /** Order lines / offers of the window still without any cost. */
  missingLines: number;
  /** Costs entered in the app, newest first. */
  history: { id: string; costCents: number; effectiveFrom: Date }[];
};

/**
 * Variants sold (order lines and one-click offers of paid orders) over the last `days` days, plus
 * every variant with a cost entered in the app, with the current cost source: entered here
 * ("saisi", wins), Shopify (latest cost snapshotted on an order), or missing.
 */
export async function variantCostOverview(storeId: string, days = 90, now = new Date()): Promise<VariantCost[]> {
  const since = new Date(now.getTime() - days * 86_400_000);
  const [sold, costs] = await Promise.all([
    db.$queryRaw<Record<string, unknown>[]>`
      WITH l AS (
        SELECT x->>'variantId' AS variant_id,
               NULLIF(concat_ws(' – ', x->>'title', NULLIF(x->>'variantTitle', '')), '') AS title,
               COALESCE((x->>'quantity')::int, 1) AS qty,
               (x->>'unitCostCents')::int AS cost,
               (CASE WHEN x->>'unitCostSource' = 'app' THEN x->>'shopifyUnitCostCents' ELSE x->>'unitCostCents' END)::int AS shopify_cost,
               s."paidAt" AS at, s.id AS sid
        FROM "CheckoutSession" s,
             jsonb_array_elements(CASE WHEN jsonb_typeof(s.lines) = 'array' THEN s.lines ELSE '[]'::jsonb END) x
        WHERE s."storeId" = ${storeId} AND s.status = 'PAID' AND s."paidAt" >= ${since} AND x->>'variantId' IS NOT NULL
        UNION ALL
        SELECT u."variantId", u.title, u.quantity, u."costCents", (CASE WHEN u."costSource" = 'app' THEN u."shopifyCostCents" ELSE u."costCents" END), s."paidAt", s.id
        FROM "UpsellCharge" u JOIN "CheckoutSession" s ON s.id = u."sessionId"
        WHERE s."storeId" = ${storeId} AND u.status = 'PAID' AND s."paidAt" >= ${since}
      )
      SELECT variant_id, (array_agg(title ORDER BY at DESC))[1] AS title, count(DISTINCT sid) AS orders, sum(qty) AS units,
             (array_agg(shopify_cost ORDER BY at DESC) FILTER (WHERE shopify_cost IS NOT NULL))[1] AS shopify_cost,
             count(*) FILTER (WHERE cost IS NULL) AS missing
      FROM l GROUP BY 1 ORDER BY sum(qty) DESC, 1`,
    db.productCost.findMany({ where: { storeId }, orderBy: { effectiveFrom: "desc" } }),
  ]);
  const byVariant = new Map<string, typeof costs>();
  for (const c of costs) byVariant.set(c.variantId, [...(byVariant.get(c.variantId) ?? []), c]);
  const rows: VariantCost[] = sold.map((r) => {
    const variantId = String(r.variant_id);
    const history = byVariant.get(variantId) ?? [];
    byVariant.delete(variantId);
    const current = costAt(history, now);
    const shopify = r.shopify_cost == null ? null : Number(r.shopify_cost);
    return {
      variantId,
      title: String(r.title ?? history[0]?.title ?? variantNumber(variantId)),
      orders: Number(r.orders ?? 0),
      units: Number(r.units ?? 0),
      source: current != null ? "app" : shopify != null ? "shopify" : "missing",
      currentCents: current ?? shopify,
      shopifyCents: shopify,
      missingLines: Number(r.missing ?? 0),
      history: history.map((h) => ({ id: h.id, costCents: h.costCents, effectiveFrom: h.effectiveFrom })),
    };
  });
  // Costs entered for variants not sold in the window (kept visible so they can be edited).
  for (const [variantId, history] of byVariant) {
    const current = costAt(history, now);
    rows.push({
      variantId,
      title: history[0]?.title ?? variantNumber(variantId),
      orders: 0,
      units: 0,
      source: current != null ? "app" : "missing",
      currentCents: current,
      shopifyCents: null,
      missingLines: 0,
      history: history.map((h) => ({ id: h.id, costCents: h.costCents, effectiveFrom: h.effectiveFrom })),
    });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* Back-fill and application to new orders                             */
/* ------------------------------------------------------------------ */

/*
 * Precedence (one rule everywhere): a cost entered in the app for a variant, effective at the
 * payment date, overrides Shopify's "Coût par article" — the merchant typed it here on purpose,
 * usually because Shopify's is missing or stale. Shopify's value is kept aside
 * (`shopifyUnitCostCents` on a line, `UpsellCharge.shopifyCostCents`) and comes back if the app
 * cost is deleted. Without an app cost, Shopify's snapshot is used as is.
 */

export type RecomputeReport = {
  /** Order lines that had no cost and got one. */
  linesFilled: number;
  /** Lines whose cost changed (app cost overriding Shopify's, edited, or removed). */
  linesUpdated: number;
  /** Lines still without cost (no cost entered for that variant at that date). */
  linesMissing: number;
  sessions: number;
  chargesFilled: number;
  chargesMissing: number;
  /** Paid order bumps (Shopify variants) that got their cost from the app. */
  bumpsFilled: number;
};

type Line = Record<string, unknown> & { variantId?: unknown; unitCostCents?: unknown; unitCostSource?: unknown; shopifyUnitCostCents?: unknown };

/** Cost fields after applying `app` (the app cost at the payment date, or null) to a snapshot. Pure. */
export function applyCost(
  cur: { cost: number | null; source: string | null; shopify: number | null },
  app: number | null,
): { cost: number | null; source: "app" | null; shopify: number | null; change: "filled" | "updated" | null } {
  const shopify = cur.source === "app" ? cur.shopify : cur.cost;
  if (app != null) {
    if (cur.source === "app" && cur.cost === app) return { cost: app, source: "app", shopify, change: null };
    return { cost: app, source: "app", shopify, change: cur.cost == null ? "filled" : "updated" };
  }
  if (cur.source === "app") return { cost: shopify, source: null, shopify: null, change: "updated" };
  return { cost: cur.cost, source: null, shopify: null, change: null };
}

/**
 * New line list with the app costs (from `index`, effective at `at`) applied: they fill missing
 * costs and override Shopify's (kept in `shopifyUnitCostCents`); lines set by the app follow the
 * current entries and fall back to Shopify's cost when the entry is gone. Pure.
 */
export function fillLines(lines: Line[], index: Map<string, CostRow[]>, at: Date): { lines: Line[]; filled: number; updated: number; missing: number } {
  let filled = 0;
  let updated = 0;
  let missing = 0;
  const out = lines.map((l) => {
    const app = typeof l.variantId === "string" ? costAt(index.get(l.variantId) ?? [], at) : null;
    const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
    const r = applyCost({ cost: num(l.unitCostCents), source: l.unitCostSource === "app" ? "app" : null, shopify: num(l.shopifyUnitCostCents) }, app);
    if (r.cost == null) missing++;
    if (!r.change) return l;
    if (r.change === "filled") filled++;
    else updated++;
    const next: Line = { ...l, unitCostCents: r.cost };
    delete next.unitCostSource;
    delete next.shopifyUnitCostCents;
    if (r.source) next.unitCostSource = r.source;
    if (r.source && r.shopify != null) next.shopifyUnitCostCents = r.shopify;
    return next;
  });
  return { lines: out, filled, updated, missing };
}

type BumpSnap = Record<string, unknown> & { variantId?: unknown; costCents?: unknown; costSource?: unknown };

/**
 * Paid order bumps (quote snapshot): a bump without a cost typed on the option gets the app
 * cost of its Shopify variant (costSource "app"), and follows later edits. A cost typed on the
 * option itself is kept. Pure.
 */
export function fillBumps(addOns: BumpSnap[], index: Map<string, CostRow[]>, at: Date): { addOns: BumpSnap[]; changed: number } {
  let changed = 0;
  const out = addOns.map((a) => {
    if (typeof a.variantId !== "string" || !a.variantId) return a;
    const fromApp = a.costSource === "app";
    if (a.costCents != null && !fromApp) return a;
    const app = costAt(index.get(a.variantId) ?? [], at);
    if (app === (fromApp ? a.costCents : null)) return a;
    changed++;
    if (app == null) {
      const rest = { ...a };
      delete rest.costSource;
      return { ...rest, costCents: null };
    }
    return { ...a, costCents: app, costSource: "app" };
  });
  return { addOns: out, changed };
}

/** Costs of some variants, by variant (small batch lookups at payment time). */
async function costIndexFor(storeId: string, variantIds: string[]): Promise<Map<string, CostRow[]>> {
  const map = new Map<string, CostRow[]>();
  if (!variantIds.length) return map;
  for (const r of await db.productCost.findMany({ where: { storeId, variantId: { in: [...new Set(variantIds)] } }, select: { variantId: true, costCents: true, effectiveFrom: true } })) {
    map.set(r.variantId, [...(map.get(r.variantId) ?? []), { costCents: r.costCents, effectiveFrom: r.effectiveFrom }]);
  }
  return map;
}

/**
 * At payment (markPaid): applies the app costs to the paid lines and bumps of one checkout, so
 * a new order carries them from the start (analytics, profit conversion value). Never throws.
 */
export async function applyAppCosts(sessionId: string): Promise<boolean> {
  try {
    const s = await db.checkoutSession.findUnique({ where: { id: sessionId }, select: { storeId: true, lines: true, paidAt: true, paidQuoteId: true, status: true } });
    if (!s || s.status !== "PAID" || !s.paidAt) return false;
    const lines = Array.isArray(s.lines) ? (s.lines as Line[]) : [];
    const quote = s.paidQuoteId ? await db.checkoutQuote.findUnique({ where: { id: s.paidQuoteId }, select: { id: true, addOns: true } }) : null;
    const bumps = Array.isArray(quote?.addOns) ? (quote.addOns as BumpSnap[]) : [];
    const ids = [...lines.map((l) => l.variantId), ...bumps.map((a) => a.variantId)].filter((v): v is string => typeof v === "string" && !!v);
    const index = await costIndexFor(s.storeId, ids);
    if (!index.size) return false;
    let changed = false;
    const r = fillLines(lines, index, s.paidAt);
    if (r.filled || r.updated) {
      await db.checkoutSession.update({ where: { id: sessionId }, data: { lines: r.lines as Prisma.InputJsonValue } });
      changed = true;
    }
    const b = fillBumps(bumps, index, s.paidAt);
    if (quote && b.changed) {
      await db.checkoutQuote.update({ where: { id: quote.id }, data: { addOns: b.addOns as Prisma.InputJsonValue } });
      changed = true;
    }
    return changed;
  } catch (err) {
    log.warn("costs.apply_failed", "App costs could not be applied at payment (the tick back-fills them)", { sessionId, err });
    return false;
  }
}

/** Cost snapshot of a one-click offer at accept time: the app cost overrides Shopify's unit cost. */
export async function offerCostSnapshot(
  storeId: string,
  variantId: string,
  shopifyUnitCostCents: number | null | undefined,
  at = new Date(),
): Promise<{ costCents: number | null; costSource: "app" | null; shopifyCostCents: number | null }> {
  const app = await costFor(storeId, variantId, at).catch(() => null);
  const r = applyCost({ cost: shopifyUnitCostCents ?? null, source: null, shopify: null }, app);
  return { costCents: r.cost, costSource: r.source, shopifyCostCents: r.source ? r.shopify : null };
}

/**
 * Applies the costs entered in the app to the store's paid checkouts (`lines[].unitCostCents`),
 * paid offers (`UpsellCharge.costCents`) and paid bumps (quote snapshot), effective at the payment
 * date: they fill missing costs and override Shopify's (see the precedence above). `since`
 * limits the pass to recent payments (the tick's cheap pass).
 */
export async function recomputeMissingCosts(storeId: string, opts: { since?: Date } = {}): Promise<RecomputeReport> {
  const index = await costIndex(storeId);
  const costed = [...index.keys()];
  const since = opts.since ?? new Date(0);
  const report: RecomputeReport = { linesFilled: 0, linesUpdated: 0, linesMissing: 0, sessions: 0, chargesFilled: 0, chargesMissing: 0, bumpsFilled: 0 };
  let cursor = "";
  for (;;) {
    const batch = await db.$queryRaw<{ id: string; lines: unknown; paidAt: Date; updatedAt: Date }[]>`
      SELECT s.id, s.lines, s."paidAt", s."updatedAt" FROM "CheckoutSession" s
      WHERE s."storeId" = ${storeId} AND s.status = 'PAID' AND s."paidAt" IS NOT NULL AND s."paidAt" >= ${since} AND s.id > ${cursor}
        AND jsonb_typeof(s.lines) = 'array'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(s.lines) x
                    WHERE x->>'unitCostCents' IS NULL OR x->>'unitCostSource' = 'app' OR x->>'variantId' = ANY(${costed}::text[]))
      ORDER BY s.id LIMIT 500`;
    if (!batch.length) break;
    cursor = batch[batch.length - 1].id;
    for (const s of batch) {
      const r = fillLines(s.lines as Line[], index, s.paidAt);
      report.linesMissing += r.missing;
      if (!r.filled && !r.updated) continue;
      // Optimistic: skip a checkout changed meanwhile (the next run will pick it up).
      const done = await db.checkoutSession.updateMany({ where: { id: s.id, updatedAt: s.updatedAt }, data: { lines: r.lines as Prisma.InputJsonValue } });
      if (!done.count) continue;
      report.sessions++;
      report.linesFilled += r.filled;
      report.linesUpdated += r.updated;
    }
  }
  const charges = await db.$queryRaw<{ id: string; variantId: string; at: Date; costCents: number | null; costSource: string | null; shopifyCostCents: number | null }[]>`
    SELECT u.id, u."variantId", COALESCE(s."paidAt", u."createdAt") AS at, u."costCents", u."costSource", u."shopifyCostCents"
    FROM "UpsellCharge" u JOIN "CheckoutSession" s ON s.id = u."sessionId"
    WHERE s."storeId" = ${storeId} AND u.status = 'PAID' AND COALESCE(s."paidAt", u."createdAt") >= ${since}
      AND (u."costCents" IS NULL OR u."costSource" = 'app' OR u."variantId" = ANY(${costed}::text[]))`;
  for (const c of charges) {
    const r = applyCost({ cost: c.costCents, source: c.costSource, shopify: c.shopifyCostCents }, costAt(index.get(c.variantId) ?? [], c.at));
    if (r.cost == null) report.chargesMissing++;
    if (!r.change) continue;
    const done = await db.upsellCharge.updateMany({
      where: { id: c.id, costCents: c.costCents, costSource: c.costSource },
      data: { costCents: r.cost, costSource: r.source, shopifyCostCents: r.source ? r.shopify : null },
    });
    if (r.change === "filled") report.chargesFilled += done.count;
  }
  const quotes = await db.$queryRaw<{ id: string; addOns: unknown; at: Date }[]>`
    SELECT q.id, q."addOns", s."paidAt" AS at FROM "CheckoutSession" s JOIN "CheckoutQuote" q ON q.id = s."paidQuoteId"
    WHERE s."storeId" = ${storeId} AND s.status = 'PAID' AND s."paidAt" >= ${since} AND jsonb_typeof(q."addOns") = 'array'
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(q."addOns") a WHERE a->>'variantId' IS NOT NULL AND (a->>'costCents' IS NULL OR a->>'costSource' = 'app'))`;
  for (const q of quotes) {
    const b = fillBumps(q.addOns as BumpSnap[], index, q.at);
    if (!b.changed) continue;
    await db.checkoutQuote.update({ where: { id: q.id }, data: { addOns: b.addOns as Prisma.InputJsonValue } });
    report.bumpsFilled += b.changed;
  }
  return report;
}

/** Recent orders a pass of the tick re-checks (cheap: only the stores with app costs). */
export const RECENT_COST_DAYS = 3;

/** Tick job: applies the app costs to the orders paid in the last RECENT_COST_DAYS days (payment-time pass missed, costs edited). */
export async function fillRecentCosts(deadline: number): Promise<number> {
  const stores = await db.productCost.groupBy({ by: ["storeId"] });
  const since = new Date(Date.now() - RECENT_COST_DAYS * 86_400_000);
  let n = 0;
  for (const { storeId } of stores) {
    if (stopForTime(deadline)) break;
    const r = await recomputeMissingCosts(storeId, { since });
    n += r.linesFilled + r.linesUpdated + r.chargesFilled + r.bumpsFilled;
  }
  return n;
}
