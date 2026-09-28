import "server-only";
import type { CheckoutSession, Store } from "@prisma/client";
import { db } from "./db";
import { log } from "./log";
import { productCollections } from "./shopify-discounts";
import { priceCart } from "./shopify";
import { productKey, type CartLine } from "./pricing";
import { upsellContextOf, type UpsellBlock, type UpsellContext } from "./upsell";

/*
 * Offer targeting that needs more than the order itself, and the "automatique" offer product.
 *
 *  - Collections of the order's products (Shopify, cached 10 min) and whether the buyer is a
 *    returning customer (a paid order on the store before this one, same e-mail): loaded only
 *    when an offer uses those conditions.
 *  - "Automatique": the product most often bought together with this order's products, from the
 *    store's paid orders of the last 180 days paid BEFORE this order (so the pick is the same on
 *    the thank-you page and when the buyer accepts), excluding what the order already contains,
 *    with at least MIN_SUPPORT orders in common and still sellable (Shopify live price and stock).
 */

const LOOKBACK_DAYS = 180;
export const MIN_SUPPORT = 2;
const CANDIDATES = 5;

type Session = Pick<CheckoutSession, "id" | "storeId" | "lines" | "subtotalCents" | "shippingAddress" | "pickupPoint" | "email" | "paidAt">;

/** The order's targeting context, with collections / customer history when an offer needs them. */
export async function upsellContextFor(store: Pick<Store, "id" | "shopDomain" | "shopifyAccessToken" | "shopCurrency">, session: Session, blocks: UpsellBlock[]): Promise<UpsellContext> {
  const ctx = upsellContextOf(session);
  const needs = (pred: (b: UpsellBlock) => boolean) => blocks.some(pred);
  if (needs((b) => !!b.props.conditions?.collectionIds?.length)) {
    try {
      const cols = await productCollections(store, ctx.productIds);
      ctx.collectionIds = [...new Set([...cols.values()].flat())];
    } catch (err) {
      log.warn("upsell.collections_failed", "Collections of the order could not be loaded: collection-targeted offers hidden", { sessionId: session.id, err });
    }
  }
  if (needs((b) => b.props.conditions?.customer === "new" || b.props.conditions?.customer === "returning") && session.email) {
    const before = await db.checkoutSession.count({
      where: {
        storeId: session.storeId,
        status: "PAID",
        id: { not: session.id },
        email: { equals: session.email.trim(), mode: "insensitive" },
        ...(session.paidAt ? { paidAt: { lt: session.paidAt } } : {}),
      },
    });
    ctx.returning = before > 0;
  }
  return ctx;
}

export type FbtCandidate = { productId: string; variantId: string; title: string; imageUrl: string | null; orders: number };

/**
 * Products most often in the same paid orders as `productIds` (store's orders paid in the
 * look-back before `before`, other checkouts only), excluding those products. Most orders first.
 */
export async function frequentlyBoughtWith(storeId: string, productIds: string[], opts: { before: Date; excludeSessionId: string; limit?: number }): Promise<FbtCandidate[]> {
  const mine = [...new Set(productIds.map(productKey))];
  if (!mine.length) return [];
  const since = new Date(opts.before.getTime() - LOOKBACK_DAYS * 86_400_000);
  const rows = await db.$queryRaw<{ pid: string; vid: string; title: string | null; img: string | null; n: bigint }[]>`
    WITH orders AS (
      SELECT s.id, s.lines FROM "CheckoutSession" s
      WHERE s."storeId" = ${storeId} AND s.status = 'PAID' AND s.test = false AND s.id <> ${opts.excludeSessionId}
        AND s."paidAt" >= ${since} AND s."paidAt" < ${opts.before} AND jsonb_typeof(s.lines) = 'array'
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(s.lines) y
          WHERE regexp_replace(y->>'productId', '^.*/', '') = ANY(${mine}::text[]) AND COALESCE((y->>'gift')::boolean, false) = false
        )
    ), items AS (
      SELECT DISTINCT ON (o.id, x->>'productId') o.id, x->>'productId' AS pid, x->>'variantId' AS vid, x->>'title' AS title, x->>'imageUrl' AS img
      FROM orders o, jsonb_array_elements(o.lines) x
      WHERE x->>'productId' IS NOT NULL AND x->>'variantId' IS NOT NULL
        AND COALESCE((x->>'gift')::boolean, false) = false
        AND NOT (regexp_replace(x->>'productId', '^.*/', '') = ANY(${mine}::text[]))
      ORDER BY o.id, x->>'productId'
    )
    SELECT pid, mode() WITHIN GROUP (ORDER BY vid) AS vid, max(title) AS title, max(img) AS img, count(*) AS n
    FROM items GROUP BY pid HAVING count(*) >= ${MIN_SUPPORT}
    ORDER BY count(*) DESC, pid LIMIT ${opts.limit ?? CANDIDATES}`;
  return rows.map((r) => ({ productId: r.pid, variantId: r.vid, title: r.title ?? "", imageUrl: r.img, orders: Number(r.n) }));
}

/** The block with the picked product in its props (arm A). Pure. */
export function withAutoProduct(block: UpsellBlock, pick: Pick<FbtCandidate, "productId" | "variantId" | "title" | "imageUrl">): UpsellBlock {
  return {
    ...block,
    props: {
      ...block.props,
      variantId: pick.variantId,
      productId: pick.productId,
      imageUrl: pick.imageUrl || block.props.imageUrl,
      title: block.props.title || pick.title,
    },
  };
}

/**
 * Offers with their automatic product resolved for this order (first candidate Shopify still
 * sells); an automatic offer without any candidate is dropped. Manual offers pass through.
 */
export async function resolveAutoOffers(store: Parameters<typeof priceCart>[0] & { id: string }, session: Session, blocks: UpsellBlock[]): Promise<UpsellBlock[]> {
  if (!blocks.some((b) => b.props.productSource === "auto")) return blocks;
  const lines = (Array.isArray(session.lines) ? session.lines : []) as unknown as CartLine[];
  let pick: FbtCandidate | null = null;
  try {
    const candidates = await frequentlyBoughtWith(
      session.storeId,
      lines.filter((l) => !l.gift).map((l) => l.productId),
      { before: session.paidAt ?? new Date(), excludeSessionId: session.id },
    );
    if (candidates.length) {
      const priced = await priceCart(store, candidates.map((c) => ({ variantId: c.variantId, quantity: 1 })));
      pick = candidates.find((c) => priced.some((l) => l.variantId === c.variantId && (l.inventory == null || l.inventory > 0))) ?? null;
      const line = pick ? priced.find((l) => l.variantId === pick!.variantId) : null;
      if (pick && line) pick = { ...pick, title: line.title, imageUrl: line.imageUrl ?? pick.imageUrl };
    }
  } catch (err) {
    log.warn("upsell.auto_pick_failed", "Automatic offer product could not be picked: offer hidden", { sessionId: session.id, err });
  }
  return blocks.flatMap((b) => (b.props.productSource !== "auto" ? [b] : pick ? [withAutoProduct(b, pick)] : []));
}
