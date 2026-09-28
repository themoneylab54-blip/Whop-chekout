import { isMediaId, mediaExists, mediaHeaders, mediaPath, readMedia } from "@/lib/media";

/**
 * An image the merchant uploaded in the builder (logo, banner, block image). Public on every host,
 * the store's checkout domain included; immutable per id, so cached for a year (ETag for revalidation).
 */
export async function GET(req: Request, ctx: { params: Promise<{ mediaId: string }> }) {
  const { mediaId } = await ctx.params;
  // A query string (?v=2, cache busters) would make every variant a CDN miss that reads the bytes
  // from Postgres, and ids are lowercase: redirect (cacheable, no DB read) to the canonical bare
  // path, the one cached copy.
  if (isMediaId(mediaId) && (new URL(req.url).search || mediaId !== mediaId.toLowerCase())) {
    return new Response(null, {
      status: 308,
      headers: { Location: mediaPath(mediaId.toLowerCase()), "Cache-Control": "public, max-age=86400", "CDN-Cache-Control": "public, max-age=31536000" },
    });
  }
  // Revalidation: a 304 only for an image that still exists (id lookup, no bytes read), so a
  // deleted image gets its 404 instead of a cached copy living on.
  if (req.headers.get("if-none-match")?.split(",").some((t) => t.trim().replace(/^W\//, "") === `"${mediaId}"`) && (await mediaExists(mediaId))) {
    const h = mediaHeaders(mediaId, "", 0);
    return new Response(null, { status: 304, headers: { ETag: h.ETag, "Cache-Control": h["Cache-Control"], "CDN-Cache-Control": h["CDN-Cache-Control"] } });
  }
  const media = await readMedia(mediaId);
  if (!media) return new Response("Image introuvable", { status: 404, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  return new Response(Buffer.from(media.bytes), { headers: mediaHeaders(mediaId, media.mime, media.bytes.byteLength) });
}
