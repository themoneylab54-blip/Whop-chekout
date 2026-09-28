"use server";

import { requireAdmin } from "./auth";
import { db } from "./db";
import { shopifyGraphql } from "./shopify";

/** Shopify catalog lookups for the dashboard's product / variant picker. */

export type CatalogVariant = { id: string; title: string; price: string; imageUrl: string | null };
export type CatalogProduct = { id: string; title: string; imageUrl: string | null; images: string[]; variants: CatalogVariant[] };
export type CatalogResult<T> = { ok: true; data: T } | { ok: false; error: string };

type RawProduct = {
  id: string;
  title: string;
  featuredImage: { url: string } | null;
  media?: { nodes: { preview?: { image?: { url: string } | null } | null }[] };
  variants: { nodes: { id: string; title: string; price: string; image?: { url: string } | null }[] };
};

const PRODUCT_FIELDS = `
  id
  title
  featuredImage { url }
  media(first: 8) { nodes { preview { image { url } } } }
  variants(first: 20) { nodes { id title price image { url } } }
`;

function toProduct(p: RawProduct): CatalogProduct {
  const images = [
    ...new Set(
      [p.featuredImage?.url, ...(p.media?.nodes ?? []).map((m) => m.preview?.image?.url), ...p.variants.nodes.map((v) => v.image?.url)].filter(
        (u): u is string => !!u,
      ),
    ),
  ].slice(0, 12);
  return {
    id: p.id,
    title: p.title,
    imageUrl: p.featuredImage?.url ?? images[0] ?? null,
    images,
    variants: p.variants.nodes.map((v) => ({ id: v.id, title: v.title, price: v.price, imageUrl: v.image?.url ?? null })),
  };
}

async function connectedStore(storeId: string) {
  await requireAdmin();
  const store = await db.store.findUnique({ where: { id: storeId }, select: { shopDomain: true, shopifyAccessToken: true, shopifyConnectedAt: true } });
  if (!store?.shopifyConnectedAt || !store.shopDomain || !store.shopifyAccessToken) return null;
  return store;
}

function failure(err: unknown): { ok: false; error: string } {
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, error: /injoignable|timeout|abort/i.test(msg) ? "Shopify ne répond pas" : "Recherche Shopify indisponible" };
}

/** Up to 10 products matching `q` (title, SKU, vendor…), each with up to 20 variants. */
export async function searchCatalog(storeId: string, q: string): Promise<CatalogResult<CatalogProduct[]>> {
  const store = await connectedStore(storeId);
  if (!store) return { ok: false, error: "Connectez Shopify pour rechercher vos produits" };
  // Prefix search on the last word ("chau" finds "chaussettes"); Shopify syntax characters are neutralised.
  const clean = q.replace(/[\\"():]/g, " ").trim().slice(0, 80);
  const query = clean ? `${clean}*` : null;
  try {
    const data = await shopifyGraphql<{ products: { nodes: RawProduct[] } }>(
      store,
      `query CatalogSearch($q: String) { products(first: 10, query: $q) { nodes { ${PRODUCT_FIELDS} } } }`,
      { q: query },
    );
    return { ok: true, data: data.products.nodes.map(toProduct) };
  } catch (err) {
    return failure(err);
  }
}

/** The product owning a variant (to show what an existing order bump points to). */
export async function getCatalogVariant(
  storeId: string,
  variantId: string,
): Promise<CatalogResult<{ product: CatalogProduct; variant: CatalogVariant } | null>> {
  const store = await connectedStore(storeId);
  if (!store) return { ok: false, error: "Shopify non connecté" };
  const num = variantId.match(/(\d+)\D*$/)?.[1];
  if (!num) return { ok: true, data: null };
  try {
    const data = await shopifyGraphql<{ node: { id: string; product: RawProduct } | null }>(
      store,
      `query CatalogVariant($id: ID!) { node(id: $id) { ... on ProductVariant { id product { ${PRODUCT_FIELDS} } } } }`,
      { id: `gid://shopify/ProductVariant/${num}` },
    );
    if (!data.node?.product) return { ok: true, data: null };
    const product = toProduct(data.node.product);
    const variant = product.variants.find((v) => v.id === data.node!.id);
    return { ok: true, data: variant ? { product, variant } : null };
  } catch (err) {
    return failure(err);
  }
}

/** Up to 10 collections matching `q` (offer targeting "la commande contient un produit de la collection…"). */
export async function searchCollections(storeId: string, q: string): Promise<CatalogResult<{ id: string; title: string }[]>> {
  const store = await connectedStore(storeId);
  if (!store) return { ok: false, error: "Connectez Shopify pour rechercher vos collections" };
  const clean = q.replace(/[\\"():]/g, " ").trim().slice(0, 80);
  try {
    const data = await shopifyGraphql<{ collections: { nodes: { id: string; title: string }[] } }>(
      store,
      `query CollectionSearch($q: String) { collections(first: 10, query: $q) { nodes { id title } } }`,
      { q: clean ? `title:${clean}*` : null },
    );
    return { ok: true, data: data.collections.nodes };
  } catch (err) {
    return failure(err);
  }
}
