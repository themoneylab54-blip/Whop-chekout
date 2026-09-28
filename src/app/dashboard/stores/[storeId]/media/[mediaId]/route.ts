import { currentAdminId } from "@/lib/auth";
import { deleteMedia, mediaUsage } from "@/lib/media";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
// JSON, not a redirect to /login: the builder calls these with fetch() and shows the message.
const expired = () => json({ error: "auth", message: "Session expirée, reconnectez-vous." }, 401);

/** Where an uploaded image is still used (published design, draft, saved versions): the builder warns first. */
export async function GET(_req: Request, ctx: { params: Promise<{ storeId: string; mediaId: string }> }) {
  if (!(await currentAdminId())) return expired();
  const { storeId, mediaId } = await ctx.params;
  return json({ usage: await mediaUsage(storeId, mediaId) });
}

/**
 * Deletes an image. 409 while the published checkout uses it (buyers would see a broken image) or a
 * saved version does (unless ?versions=1, after the merchant confirmed); an image used only by the
 * draft is removed from it (the builder clears its own copy too).
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ storeId: string; mediaId: string }> }) {
  if (!(await currentAdminId())) return expired();
  const { storeId, mediaId } = await ctx.params;
  const res = await deleteMedia(storeId, mediaId, { allowVersions: new URL(req.url).searchParams.get("versions") === "1" });
  if (res.ok) return json({ ok: true });
  if (res.error === "not_found") return json({ error: "not_found", message: "Image introuvable." }, 404);
  const message = res.usage.published
    ? "Image affichée sur le checkout publié (design, test A/B en cours ou image d'une option) : remplacez-la puis publiez avant de la supprimer."
    : `Image utilisée par ${res.usage.versions} version(s) enregistrée(s) de l'historique : les restaurer n'afficherait plus cette image.`;
  return json({ error: "in_use", usage: res.usage, message }, 409);
}
