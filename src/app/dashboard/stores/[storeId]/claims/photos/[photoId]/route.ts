import { requireStoreAccess } from "@/lib/access";
import { db } from "@/lib/db";
import { photoDisposition } from "@/lib/claims";

/** A claim photo for the merchant (signed-in admin, photo of this store only). */
export async function GET(_req: Request, ctx: { params: Promise<{ storeId: string; photoId: string }> }) {
  const { storeId, photoId } = await ctx.params;
  await requireStoreAccess(storeId, "view");
  const photo = await db.claimPhoto.findFirst({ where: { id: photoId, storeId }, select: { mime: true, data: true } });
  if (!photo) return new Response("Photo introuvable", { status: 404 });
  return new Response(Buffer.from(photo.data), {
    headers: {
      "Content-Type": photo.mime,
      "Content-Length": String(photo.data.byteLength),
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": photoDisposition(photoId, photo.mime),
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    },
  });
}
