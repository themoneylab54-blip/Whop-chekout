"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/*
 * Images the merchant uploads from the builder (any ImageField: logo, banner, block images).
 * Raster images are resized and re-encoded in the browser before upload (≤ 2400 px wide, ≤ 1 MB,
 * transparency kept through WebP); the server checks the bytes again (lib/media.ts).
 */

export type UploadedMedia = { id: string; url: string; mime: string; size: number; width: number | null; height: number | null; createdAt: string };
export type MediaUsage = { published: boolean; draft: boolean; versions: number };

// Wide enough for a sharp full-width banner on a 2× screen; the server refuses > 6000 px / 25 MP.
export const MAX_UPLOAD_WIDTH = 2400;
export const TARGET_UPLOAD_BYTES = 1024 * 1024;
/** The server's per-image cap (lib/media.ts MAX_MEDIA_BYTES): PNG with transparency may use it all. */
const SERVER_MAX_BYTES = 2 * 1024 * 1024;
/** Decoded pixels kept below the server's 25 MP cap (a very tall image at 2400 px wide would exceed it). */
export const MAX_UPLOAD_PIXELS = 16_000_000;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const UPLOAD_ACCEPT = ACCEPTED.join(",");

type MediaLibrary = {
  items: UploadedMedia[] | null;
  /** Why the list couldn't be loaded (session expired, network), else null. */
  loadError: string | null;
  load: () => void;
  upload: (file: File) => Promise<{ ok: true; media: UploadedMedia } | { ok: false; message: string }>;
  usage: (id: string) => Promise<MediaUsage | null>;
  /** `versions`: the merchant confirmed deleting an image that saved versions still use. */
  remove: (id: string, opts?: { versions?: boolean }) => Promise<RemoveResult>;
  /** True when the provider empties the draft's fields itself after a deletion (onRemoved). */
  clearsFields: boolean;
};
export type RemoveResult = { ok: true } | { ok: false; message: string; usage?: MediaUsage };
const EXPIRED = "Session expirée, reconnectez-vous.";

const Ctx = createContext<MediaLibrary | null>(null);

/** The store's image library, when the builder provides one (null elsewhere: no upload button). */
export function useMediaLibrary(): MediaLibrary | null {
  return useContext(Ctx);
}

/**
 * `onRemoved(url)`: an image was deleted; the builder empties every field of its in-memory draft
 * that points to it (the server already did so in the saved draft).
 */
export function MediaLibraryProvider({ storeId, onRemoved, children }: { storeId: string; onRemoved?: (url: string) => void; children: ReactNode }) {
  const removedRef = useRef(onRemoved);
  useEffect(() => {
    removedRef.current = onRemoved;
  });
  const [items, setItems] = useState<UploadedMedia[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loading = useRef(false);
  const base = `/dashboard/stores/${encodeURIComponent(storeId)}/media`;

  const load = useCallback(() => {
    if (loading.current) return;
    loading.current = true;
    fetch(base, { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 401) throw new Error(EXPIRED);
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((j: { media?: UploadedMedia[] }) => {
        setLoadError(null);
        setItems(j.media ?? []);
      })
      .catch((e: unknown) => {
        // Never an empty list that looks like "no images": say why instead.
        setLoadError(e instanceof Error && e.message === EXPIRED ? EXPIRED : "Impossible de charger vos images. Réessayez.");
        setItems([]);
      })
      .finally(() => {
        loading.current = false;
      });
  }, [base]);

  const upload = useCallback<MediaLibrary["upload"]>(
    async (file) => {
      const prepared = await prepareUpload(file);
      if (!prepared.ok) return prepared;
      const fd = new FormData();
      fd.append("file", prepared.file);
      try {
        const res = await fetch(base, { method: "POST", body: fd });
        const j = (await res.json().catch(() => ({}))) as { media?: UploadedMedia; message?: string };
        if (res.status === 401) return { ok: false, message: EXPIRED };
        if (!res.ok || !j.media) return { ok: false, message: j.message ?? "Envoi impossible : réessayez." };
        const media = j.media;
        setItems((cur) => [media, ...(cur ?? []).filter((m) => m.id !== media.id)]);
        return { ok: true, media };
      } catch {
        return { ok: false, message: "Envoi impossible : vérifiez votre connexion." };
      }
    },
    [base],
  );

  const usage = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`${base}/${encodeURIComponent(id)}`, { cache: "no-store" });
        return res.ok ? ((await res.json()) as { usage: MediaUsage }).usage : null;
      } catch {
        return null;
      }
    },
    [base],
  );

  const remove = useCallback<MediaLibrary["remove"]>(
    async (id, opts) => {
      try {
        const res = await fetch(`${base}/${encodeURIComponent(id)}${opts?.versions ? "?versions=1" : ""}`, { method: "DELETE" });
        if (res.status === 401) return { ok: false, message: EXPIRED };
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { message?: string; usage?: MediaUsage };
          return { ok: false, message: j.message ?? "Suppression impossible : réessayez.", usage: j.usage };
        }
        setItems((cur) => (cur ?? []).filter((m) => m.id !== id));
        removedRef.current?.(`/api/public/media/${id}`);
        return { ok: true };
      } catch {
        return { ok: false, message: "Suppression impossible : vérifiez votre connexion." };
      }
    },
    [base],
  );

  const clearsFields = !!onRemoved;
  const value = useMemo(() => ({ items, loadError, load, upload, usage, remove, clearsFields }), [items, loadError, load, upload, usage, remove, clearsFields]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** What to send for a picked file: refused types, or the file resized / re-encoded when needed. */
export async function prepareUpload(file: File): Promise<{ ok: true; file: File } | { ok: false; message: string }> {
  // Some browsers / OS pickers leave the type empty: the extension says it (the server sniffs the bytes anyway).
  const ext = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const byExt: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", svgz: "image/svg+xml" };
  const type = file.type.toLowerCase() || byExt[ext] || "";
  if (type === "image/svg+xml" || /\.svgz?$/i.test(file.name)) return { ok: false, message: "SVG non accepté : exportez votre logo en PNG (fond transparent conservé)." };
  if (!ACCEPTED.includes(type)) return { ok: false, message: "Format non accepté : PNG, JPEG, WebP ou GIF." };
  // GIF: sent as-is (re-encoding would drop the animation); the server caps it at 2 MB.
  if (type === "image/gif") return file.size <= 2 * 1024 * 1024 ? { ok: true, file } : { ok: false, message: "GIF trop lourd (2 Mo au plus)." };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { ok: false, message: "Image illisible : essayez un autre fichier." };
  }
  try {
    // Small PNG / WebP (logos): kept byte for byte, no quality loss. JPEG is always re-encoded
    // (drops EXIF data such as the GPS position of a phone photo).
    // Too many decoded pixels (e.g. a very tall screenshot) is resized here rather than refused by the server.
    const tooBig = bitmap.width > MAX_UPLOAD_WIDTH || bitmap.width * bitmap.height > MAX_UPLOAD_PIXELS;
    if (type !== "image/jpeg" && !tooBig && file.size <= TARGET_UPLOAD_BYTES) return { ok: true, file };
    const maxWidthByPixels = Math.floor(Math.sqrt((MAX_UPLOAD_PIXELS * bitmap.width) / bitmap.height));
    let width = Math.max(1, Math.min(bitmap.width, MAX_UPLOAD_WIDTH, maxWidthByPixels));
    // Browsers without a WebP encoder (older Safari) return PNG from toBlob("image/webp"): an opaque
    // image (or any JPEG source) is then re-encoded as JPEG; one with transparency stays PNG, up to
    // the server's 2 MB cap since PNG can't trade quality for size.
    let noWebp = false;
    let opaque: boolean | null = type === "image/jpeg" ? true : null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) break;
      ctx.drawImage(bitmap, 0, 0, width, height);
      const quality = [0.9, 0.82, 0.75, 0.82, 0.75, 0.7][attempt];
      const encode = (mime: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mime, quality));
      let blob = noWebp ? null : await encode("image/webp");
      let limit = TARGET_UPLOAD_BYTES;
      if (!blob || blob.type !== "image/webp") {
        noWebp = true;
        if (opaque === null) opaque = isOpaque(ctx, width, height);
        if (opaque) blob = await encode("image/jpeg");
        else {
          blob = blob?.type === "image/png" ? blob : await encode("image/png");
          limit = SERVER_MAX_BYTES;
        }
      }
      if (blob && blob.size <= limit) {
        const ext = blob.type === "image/webp" ? "webp" : blob.type === "image/jpeg" ? "jpg" : "png";
        return { ok: true, file: new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "image"}.${ext}`, { type: blob.type }) };
      }
      // Lossy formats try a lower quality first; PNG has none, so it shrinks right away.
      if (attempt >= 2 || (noWebp && !opaque)) width = Math.max(200, Math.round(width * 0.75));
    }
    return { ok: false, message: "Image trop lourde même réduite : essayez un fichier plus léger." };
  } finally {
    bitmap.close();
  }
}

/** No pixel of the drawn canvas is (even partly) transparent. Unreadable canvas: assume transparency (PNG kept). */
function isOpaque(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, width, height);
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return false;
    return true;
  } catch {
    return false;
  }
}

/** "248 Ko", "1,2 Mo". */
export function formatBytes(n: number): string {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} Ko` : `${(n / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`;
}
