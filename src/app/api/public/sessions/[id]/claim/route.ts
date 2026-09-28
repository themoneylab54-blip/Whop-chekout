import { z } from "zod";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { json, readJson } from "@/lib/http";
import { route } from "@/lib/route";
import { MAX_CLAIM_BODY_BYTES, MAX_CLAIM_PHOTOS, MAX_PHOTO_BYTES, submitBuyerClaim, type ClaimPhotoInput } from "@/lib/claims";

const bodySchema = z.object({
  email: z.string().trim().email().max(200),
  reason: z.string().max(20),
  details: z.string().max(2000).nullable().optional(),
  photoUrl: z.string().max(600).nullable().optional(),
});

/**
 * Whole request cap, under Vercel's 4.5 MB function body limit (a bigger body never reaches us and
 * the buyer would get Vercel's own error page): the checkout re-encodes photos to JPEG of 1.2 MB at
 * most each and 4 MB in all. Above it: a JSON 413 the form shows in the buyer's language.
 */
const MAX_BODY_BYTES = MAX_CLAIM_BODY_BYTES;
const tooLarge = () => json({ error: "Photos trop lourdes", code: "photo_size" }, { status: 413 });

/**
 * Order status page: the buyer reports a delivery problem on a protected parcel (pending claim +
 * merchant alert). JSON, or multipart/form-data with up to 3 photos ("photos", images of 5 MB max,
 * checked on their content). The checkout shrinks photos before sending them.
 */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`claim:ip:${clientIp(req)}`, 5, 10 * 60_000)) || !(await rateLimit(`claim:s:${id}`, 5, 60 * 60_000))) {
    return json({ error: "Trop de demandes, réessayez plus tard.", code: "rate_limited" }, { status: 429 });
  }
  let raw: unknown;
  const photos: ClaimPhotoInput[] = [];
  if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return tooLarge();
    let fd: FormData;
    try {
      fd = await req.formData();
    } catch {
      return json({ error: "Requête invalide", code: "invalid" }, { status: 400 });
    }
    const files = fd.getAll("photos").filter((f): f is File => typeof f === "object" && f !== null && "arrayBuffer" in f);
    if (files.length > MAX_CLAIM_PHOTOS) return json({ error: "3 photos maximum", code: "photo_count" }, { status: 400 });
    // Without a Content-Length (chunked upload): the photos themselves are measured.
    if (files.reduce((n, f) => n + f.size, 0) > MAX_BODY_BYTES) return tooLarge();
    for (const f of files) {
      if (f.size > MAX_PHOTO_BYTES) return tooLarge();
      photos.push({ type: f.type, data: Buffer.from(await f.arrayBuffer()) });
    }
    const text = (k: string) => (typeof fd.get(k) === "string" ? (fd.get(k) as string) : null);
    raw = { email: text("email") ?? "", reason: text("reason") ?? "", details: text("details"), photoUrl: text("photoUrl") };
  } else raw = await readJson(req);
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return json({ error: "Requête invalide", code: "invalid" }, { status: 400 });
  const result = await submitBuyerClaim(id, { ...parsed.data, photos });
  if (!result.ok) return json({ error: result.error, code: result.error }, { status: result.error === "closed" ? 404 : 400 });
  return json({ ok: true });
}

export const POST = route("sessions.claim", handle);
