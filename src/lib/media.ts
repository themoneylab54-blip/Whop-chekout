import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { sniffImage } from "@/lib/claims";
import { clearUrl } from "@/lib/layout";

/*
 * Images the merchant uploads in the builder (logo, header banner, block images). Stored in
 * Postgres (StoreMedia) and served publicly at /api/public/media/<id> on every host, the store's
 * checkout domain included (/api/public/* is a buyer path). A stored image never changes: a new
 * upload is a new id, so the public URL is cacheable forever.
 */

/** Per image, after the builder's client-side resize (≤ 1 MB): leaves room for PNG with transparency. */
export const MAX_MEDIA_BYTES = 2 * 1024 * 1024;
/** Per store: the builder gallery stays small and the table can't grow without bound. */
export const MAX_MEDIA_PER_STORE = 50;
/** Raster images only: SVG can carry scripts, so it is refused rather than sanitized. */
export const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** Decoded size caps (a small file can still decode to a huge bitmap): width and total pixels. */
export const MAX_MEDIA_WIDTH = 6000;
export const MAX_MEDIA_PIXELS = 25_000_000;

/**
 * Interactive-transaction limits (Prisma's default is 5 s / 2 s): an upload writes up to 2 MB and
 * waits on the Store row lock; a store clone copies up to 50 images in SQL.
 */
export const MEDIA_TX = { timeout: 15_000, maxWait: 10_000 } as const;
export const CLONE_TX = { timeout: 30_000, maxWait: 10_000 } as const;

export type MediaError = "media_empty" | "media_size" | "media_type" | "media_count" | "media_dims";
export const MEDIA_ERRORS: Record<MediaError, string> = {
  media_empty: "Fichier vide.",
  media_size: "Image trop lourde (2 Mo au plus).",
  media_type: "Format non accepté : PNG, JPEG, WebP ou GIF uniquement (pas de SVG).",
  media_dims: `Image trop grande en pixels (${MAX_MEDIA_WIDTH} px de large et 25 mégapixels au plus).`,
  media_count: `Limite de ${MAX_MEDIA_PER_STORE} images atteinte : supprimez-en une dans « Mes images ».`,
};

/** Public path of a stored image (relative: it works on the app host and on any checkout domain). */
export const mediaPath = (id: string) => `/api/public/media/${id}`;
// Relative (what the builder writes) or absolute on any https host: a merchant may paste the full
// address of an upload (app host, checkout domain, preview deploy); it names the same image. A
// trailing slash and a query / fragment (?v=2, #x) still name it, as for clearUrl and the usage check.
const MEDIA_PATH = /^(?:https?:\/\/[^/?#\s]+)?\/api\/public\/media\/([a-z0-9]{10,40})\/?(?:[?#].*)?$/i;
/**
 * The media id of a stored-image path (relative or absolute URL), or null. Matched in any letter
 * case and returned lowercase: ids are lowercase (cuid / hex), as the public route serves them. Pure.
 */
export function mediaIdOf(url: string): string | null {
  return MEDIA_PATH.exec(url.trim())?.[1]?.toLowerCase() ?? null;
}
export const isMediaId = (id: string) => /^[a-z0-9]{10,40}$/i.test(id);

/**
 * An upload checked: non-empty, ≤ 2 MB, a real PNG / JPEG / WebP / GIF from its first bytes
 * (the declared type, when given, must agree; SVG, HEIC and anything else refused). Pure.
 */
export function checkMedia(data: Buffer, declaredType?: string | null): { ok: true; mime: MediaType } | { ok: false; error: MediaError } {
  if (!data.length) return { ok: false, error: "media_empty" };
  if (data.length > MAX_MEDIA_BYTES) return { ok: false, error: "media_size" };
  const sniffed = sniffImage(data);
  if (!sniffed || !(MEDIA_TYPES as readonly string[]).includes(sniffed)) return { ok: false, error: "media_type" };
  const declared = (declaredType ?? "").toLowerCase().split(";")[0].trim();
  const norm = (t: string) => (t === "image/jpg" ? "image/jpeg" : t);
  if (declared && declared !== "application/octet-stream" && norm(declared) !== sniffed) return { ok: false, error: "media_type" };
  return { ok: true, mime: sniffed as MediaType };
}

/** Pixel size read from the image header (PNG, JPEG, WebP, GIF), or null when unreadable. Pure. */
export function imageDimensions(data: Buffer, mime: string): { width: number; height: number } | null {
  const ok = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  try {
    if (mime === "image/png") return data.length >= 24 ? ok(data.readUInt32BE(16), data.readUInt32BE(20)) : null;
    if (mime === "image/gif") return data.length >= 10 ? ok(data.readUInt16LE(6), data.readUInt16LE(8)) : null;
    if (mime === "image/webp") {
      const chunk = data.subarray(12, 16).toString("latin1");
      if (chunk === "VP8X" && data.length >= 30) return ok(1 + data.readUIntLE(24, 3), 1 + data.readUIntLE(27, 3));
      if (chunk === "VP8L" && data.length >= 25) {
        const b = data.readUInt32LE(21);
        return ok((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1);
      }
      if (chunk === "VP8 " && data.length >= 30) return ok(data.readUInt16LE(26) & 0x3fff, data.readUInt16LE(28) & 0x3fff);
      return null;
    }
    if (mime === "image/jpeg") {
      let i = 2;
      while (i + 9 < data.length) {
        if (data[i] !== 0xff) return null;
        const marker = data[i + 1];
        // Fill bytes: any number of 0xFF may precede a marker.
        if (marker === 0xff) {
          i += 1;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = data.readUInt16BE(i + 2);
        // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return ok(data.readUInt16BE(i + 7), data.readUInt16BE(i + 5));
        i += 2 + len;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Within the decoded-size caps (≤ 6000 px wide, ≤ 25 megapixels). Pure. */
export function dimensionsOk(d: { width: number; height: number }): boolean {
  return d.width <= MAX_MEDIA_WIDTH && d.width * d.height <= MAX_MEDIA_PIXELS;
}

export type MediaItem = { id: string; url: string; mime: string; size: number; width: number | null; height: number | null; createdAt: string };
const toItem = (m: { id: string; mime: string; size: number; width: number | null; height: number | null; createdAt: Date }): MediaItem => ({
  id: m.id,
  url: mediaPath(m.id),
  mime: m.mime,
  size: m.size,
  width: m.width,
  height: m.height,
  createdAt: m.createdAt.toISOString(),
});
const itemSelect = { id: true, mime: true, size: true, width: true, height: true, createdAt: true } as const;

/** A store's uploaded images, newest first (never the bytes). */
export async function listMedia(storeId: string): Promise<MediaItem[]> {
  const rows = await db.storeMedia.findMany({ where: { storeId }, orderBy: { createdAt: "desc" }, select: itemSelect, take: MAX_MEDIA_PER_STORE });
  return rows.map(toItem);
}

/**
 * Stores an upload once checked. The per-store cap is enforced under a row lock on the store,
 * so two parallel uploads can't both pass at 49.
 */
export async function saveMedia(storeId: string, data: Buffer, declaredType?: string | null): Promise<{ ok: true; media: MediaItem } | { ok: false; error: MediaError | "store" }> {
  const checked = checkMedia(data, declaredType);
  if (!checked.ok) return checked;
  const dims = imageDimensions(data, checked.mime);
  // Unreadable size: refused, or a huge bitmap could slip past the pixel caps.
  if (!dims || !dimensionsOk(dims)) return { ok: false, error: "media_dims" };
  return db.$transaction(async (tx) => {
    if (!(await lockStore(tx, storeId))) return { ok: false as const, error: "store" as const };
    const count = await tx.storeMedia.count({ where: { storeId } });
    if (count >= MAX_MEDIA_PER_STORE) return { ok: false as const, error: "media_count" as const };
    const row = await tx.storeMedia.create({
      data: { storeId, mime: checked.mime, bytes: new Uint8Array(data), size: data.length, width: dims?.width ?? null, height: dims?.height ?? null },
      select: itemSelect,
    });
    return { ok: true as const, media: toItem(row) };
  }, MEDIA_TX);
}

type Tx = Prisma.TransactionClient;

/**
 * Row lock on the store, held until the transaction ends. Every write that can make an image live
 * (publish, A/B test start / promotion) and every image delete take it first, so the "is it live?"
 * check and the write can't interleave. Returns false when the store doesn't exist.
 */
export async function lockStore(tx: Tx, storeId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Store" WHERE id = ${storeId} FOR UPDATE`;
  return rows.length > 0;
}
export type MediaUsage = { published: boolean; draft: boolean; versions: number };
/** Case-insensitive (as mediaIdOf). */
const containsPath = (needle: string, ...v: unknown[]) => v.some((x) => x != null && JSON.stringify(x).toLowerCase().includes(needle.toLowerCase()));

/**
 * Where a stored image is still used: the published design (and versions a running A/B test
 * serves, and add-on images, shown on the live checkout), the draft and saved versions of this store (JSON text search on its path). An image used by the published design or a saved version
 * can't be deleted; one used only by the draft is removed from it on deletion.
 */
export async function mediaUsage(storeId: string, id: string, client: Tx | typeof db = db): Promise<MediaUsage> {
  // Lowercase on both sides (lower() in SQL, ILIKE-like): consistent with mediaIdOf / clearUrl.
  const needle = mediaPath(id).toLowerCase();
  const store = await client.store.findUnique({
    where: { id: storeId },
    select: { theme: true, checkoutLayout: true, thankYouLayout: true, draftTheme: true, draftCheckoutLayout: true, draftThankYouLayout: true },
  });
  if (!store) return { published: false, draft: false, versions: 0 };
  const versions = await client.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "LayoutVersion"
    WHERE "storeId" = ${storeId}
      AND (strpos(lower("theme"::text), ${needle}) > 0 OR strpos(lower("checkoutLayout"::text), ${needle}) > 0 OR strpos(lower("thankYouLayout"::text), ${needle}) > 0)`;
  // A running A/B test serves its variant (versionId) and pinned control (versionIdA) live: those
  // versions count as published.
  const live = await client.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "LayoutVersion" v
    WHERE v."storeId" = ${storeId}
      AND EXISTS (SELECT 1 FROM "Experiment" e WHERE e."storeId" = ${storeId} AND e."status" = 'RUNNING' AND (e."versionId" = v."id" OR e."versionIdA" = v."id"))
      AND (strpos(lower(v."theme"::text), ${needle}) > 0 OR strpos(lower(v."checkoutLayout"::text), ${needle}) > 0 OR strpos(lower(v."thankYouLayout"::text), ${needle}) > 0)`;
  // Add-ons (checkout options) show their image live too, whatever the design.
  const addOns = await client.addOn.count({ where: { storeId, imageUrl: { contains: needle, mode: "insensitive" } } });
  return {
    published: containsPath(needle, store.theme, store.checkoutLayout, store.thankYouLayout) || Number(live[0]?.n ?? 0) > 0 || addOns > 0,
    draft: containsPath(needle, store.draftTheme, store.draftCheckoutLayout, store.draftThankYouLayout),
    versions: Number(versions[0]?.n ?? 0),
  };
}

/**
 * Whether a stored image may be deleted: never while the live checkout shows it; while saved
 * versions use it only when the merchant confirmed (versions can't be deleted, so a hard block
 * would keep the image forever; restoring such a version then shows no image there).
 */
export const mediaDeletable = (u: MediaUsage, allowVersions = false) => !u.published && (allowVersions || u.versions === 0);

/**
 * Deletes one of this store's images (never another store's). Refused while the published design
 * uses it (the checkout would show a broken image), and while saved versions do unless
 * `allowVersions`; every draft field that points to it is emptied in the same transaction.
 */
export async function deleteMedia(
  storeId: string,
  id: string,
  opts: { allowVersions?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: "not_found" } | { ok: false; error: "in_use"; usage: MediaUsage }> {
  if (!isMediaId(id)) return { ok: false, error: "not_found" };
  return db.$transaction(async (tx) => {
    // Row lock on the store (as uploads take): concurrent deletes / uploads of this store serialise.
    await lockStore(tx, storeId);
    const row = await tx.storeMedia.findFirst({ where: { id, storeId }, select: { id: true } });
    if (!row) return { ok: false as const, error: "not_found" as const };
    const usage = await mediaUsage(storeId, id, tx);
    if (!mediaDeletable(usage, opts.allowVersions)) return { ok: false as const, error: "in_use" as const, usage };
    if (usage.draft) {
      const url = mediaPath(id);
      const d = await tx.store.findUniqueOrThrow({ where: { id: storeId }, select: { draftTheme: true, draftCheckoutLayout: true, draftThankYouLayout: true } });
      const data: Prisma.StoreUpdateInput = {};
      if (containsPath(url, d.draftTheme)) data.draftTheme = clearUrl(d.draftTheme, url) as Prisma.InputJsonValue;
      if (containsPath(url, d.draftCheckoutLayout)) data.draftCheckoutLayout = clearUrl(d.draftCheckoutLayout, url) as Prisma.InputJsonValue;
      if (containsPath(url, d.draftThankYouLayout)) data.draftThankYouLayout = clearUrl(d.draftThankYouLayout, url) as Prisma.InputJsonValue;
      await tx.store.update({ where: { id: storeId }, data });
    }
    await tx.storeMedia.delete({ where: { id } });
    return { ok: true as const };
  }, MEDIA_TX);
}

/** Every stored-image id a design (theme / layout JSON) points to. Pure. */
export function mediaIdsIn(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    const id = mediaIdOf(value);
    if (id) out.add(id);
  } else if (Array.isArray(value)) value.forEach((v) => mediaIdsIn(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => mediaIdsIn(v, out));
  return out;
}

/**
 * `design` with every image this store no longer has emptied: an image deleted meanwhile can come
 * back in the draft (undo in an open builder, a restored version, a publish racing a delete) and
 * must never go live. Call it under the Store row lock that deleteMedia takes.
 */
export async function withoutMissingMedia<T>(tx: Tx, storeId: string, design: T): Promise<T> {
  return (await missingMediaIds(tx, storeId, design)).reduce((d, id) => clearUrl(d, mediaPath(id)), design);
}

/** The stored-image ids `design` points to that this store no longer has (deleted, or another store's). */
export async function missingMediaIds(tx: Tx | typeof db, storeId: string, design: unknown): Promise<string[]> {
  const ids = [...mediaIdsIn(design)];
  if (!ids.length) return [];
  const found = await tx.storeMedia.findMany({ where: { storeId, id: { in: ids } }, select: { id: true } });
  const have = new Set(found.map((r) => r.id));
  return ids.filter((id) => !have.has(id));
}

/* ---------- store duplication ---------- */

/** A fresh media id (32 hex chars: matches isMediaId, never collides with the cuid ids). */
const newMediaId = () => randomUUID().replace(/-/g, "");

/** Old id → new id for every image of a store, ready for copyMedia (ids only, no bytes read). */
export async function planMediaCopy(storeId: string, client: Tx | typeof db = db): Promise<Map<string, string>> {
  const rows = await client.storeMedia.findMany({ where: { storeId }, select: { id: true } });
  return new Map(rows.map((r) => [r.id, newMediaId()]));
}

/** A JSON value with every stored-image path of `map` pointing to its copy. Pure. */
export function remapMediaIds<T>(value: T, map: Map<string, string>): T {
  if (!map.size) return value;
  if (typeof value === "string") {
    const id = mediaIdOf(value);
    const next = id ? map.get(id) : undefined;
    return (next ? mediaPath(next) : value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => remapMediaIds(v, map)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remapMediaIds(v, map)])) as T;
  return value;
}

/**
 * Copies a store's images to another store under the new ids of `map` (the duplicate's design
 * already points to them). Done in SQL: the bytes never leave Postgres.
 */
export async function copyMedia(tx: Tx, fromStoreId: string, toStoreId: string, map: Map<string, string>): Promise<number> {
  if (!map.size) return 0;
  const oldIds = [...map.keys()];
  const newIds = oldIds.map((id) => map.get(id)!);
  return tx.$executeRaw`
    INSERT INTO "StoreMedia" ("id", "storeId", "mime", "bytes", "size", "width", "height", "createdAt")
    SELECT m.new_id, ${toStoreId}, s."mime", s."bytes", s."size", s."width", s."height", s."createdAt"
    FROM unnest(${oldIds}::text[], ${newIds}::text[]) AS m(old_id, new_id)
    JOIN "StoreMedia" s ON s."id" = m.old_id AND s."storeId" = ${fromStoreId}`;
}

/** Whether an image exists (cheap: no bytes), for the public route's 304 answer. */
export async function mediaExists(id: string): Promise<boolean> {
  if (!isMediaId(id)) return false;
  return !!(await db.storeMedia.findUnique({ where: { id }, select: { id: true } }));
}

/** The bytes of a stored image, for the public route. */
export async function readMedia(id: string): Promise<{ mime: string; bytes: Uint8Array } | null> {
  if (!isMediaId(id)) return null;
  return db.storeMedia.findUnique({ where: { id }, select: { mime: true, bytes: true } });
}

/** Headers of a served image: cacheable forever (immutable id), inert (no sniffing, no scripts). */
export function mediaHeaders(id: string, mime: string, size: number): Record<string, string> {
  return {
    "Content-Type": mime,
    "Content-Length": String(size),
    // s-maxage / CDN-Cache-Control: without them Vercel's edge doesn't keep the response, and every
    // view would read the bytes from Postgres again.
    "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
    "CDN-Cache-Control": "public, max-age=31536000, immutable",
    ETag: `"${id}"`,
    "Content-Disposition": "inline",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    // Shown on the store's checkout domain and in e-mails: allowed cross-origin.
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}
