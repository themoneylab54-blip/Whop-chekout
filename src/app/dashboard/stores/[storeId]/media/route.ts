import { currentAdminId } from "@/lib/auth";
import { db } from "@/lib/db";
import { listMedia, MAX_MEDIA_BYTES, MEDIA_ERRORS, saveMedia } from "@/lib/media";

/*
 * Builder image uploads (signed-in admin only). A route handler rather than a server action:
 * actions cap bodies at 1 MB by default. The builder resizes images before sending (≤ 1 MB).
 */

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
// JSON, not a redirect to /login: the builder calls these with fetch() and shows the message.
const expired = () => json({ error: "auth", message: "Session expirée, reconnectez-vous." }, 401);

export async function GET(_req: Request, ctx: { params: Promise<{ storeId: string }> }) {
  if (!(await currentAdminId())) return expired();
  const { storeId } = await ctx.params;
  return json({ media: await listMedia(storeId) });
}

export async function POST(req: Request, ctx: { params: Promise<{ storeId: string }> }) {
  if (!(await currentAdminId())) return expired();
  const { storeId } = await ctx.params;
  // Multipart overhead aside, anything well over the cap is refused before being read.
  if (Number(req.headers.get("content-length") ?? 0) > MAX_MEDIA_BYTES + 64 * 1024) return json({ error: "media_size", message: MEDIA_ERRORS.media_size }, 413);
  const store = await db.store.findUnique({ where: { id: storeId }, select: { id: true } });
  if (!store) return json({ error: "store", message: "Boutique introuvable." }, 404);
  let file: File | null = null;
  try {
    const form = await req.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    file = null;
  }
  if (!file) return json({ error: "media_empty", message: "Aucun fichier reçu." }, 400);
  if (file.size > MAX_MEDIA_BYTES) return json({ error: "media_size", message: MEDIA_ERRORS.media_size }, 413);
  const saved = await saveMedia(storeId, Buffer.from(await file.arrayBuffer()), file.type);
  if (!saved.ok) {
    if (saved.error === "store") return json({ error: "store", message: "Boutique introuvable." }, 404);
    return json({ error: saved.error, message: MEDIA_ERRORS[saved.error] }, saved.error === "media_size" ? 413 : saved.error === "media_count" ? 409 : saved.error === "media_dims" ? 422 : 415);
  }
  return json({ media: saved.media }, 201);
}
