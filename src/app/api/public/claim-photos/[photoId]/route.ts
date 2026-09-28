import { db } from "@/lib/db";
import { checkPhotoToken, photoDisposition } from "@/lib/claims";

/** A buyer's own claim photo, through a signed, expiring link (never listed, never guessable). */
export async function GET(req: Request, ctx: { params: Promise<{ photoId: string }> }) {
  const { photoId } = await ctx.params;
  const sp = new URL(req.url).searchParams;
  if (!/^[a-z0-9]{10,40}$/i.test(photoId) || !checkPhotoToken(photoId, sp.get("e"), sp.get("t"))) return new Response("Lien invalide ou expiré", { status: 403 });
  const photo = await db.claimPhoto.findUnique({ where: { id: photoId }, select: { mime: true, data: true } });
  if (!photo) return new Response("Photo introuvable", { status: 404 });
  return photoResponse(photoId, photo.mime, photo.data, "private, max-age=3600");
}

function photoResponse(photoId: string, mime: string, data: Uint8Array, cache: string): Response {
  return new Response(Buffer.from(data), {
    headers: {
      "Content-Type": mime,
      "Content-Length": String(data.byteLength),
      "Cache-Control": cache,
      "Content-Disposition": photoDisposition(photoId, mime),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
}
