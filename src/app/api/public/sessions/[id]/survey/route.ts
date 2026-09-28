import { z } from "zod";
import { db } from "@/lib/db";
import { json, readJson } from "@/lib/http";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/route";
import { designFor } from "@/lib/experiments";
import { loadThankYouLayout, normalizeSurveyAnswer, SURVEY_OTHER_MAX } from "@/lib/layout";

const schema = z.object({ answer: z.string().min(1).max(SURVEY_OTHER_MAX + 10) });

/**
 * Thank-you page survey ("Comment nous avez-vous connu ?"): one answer per paid order,
 * one of the options the merchant shows, or "other:<text>" (80 characters at most).
 */
async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await rateLimit(`survey:ip:${clientIp(req)}`, 20))) return json({ error: "Trop de requêtes" }, { status: 429 });
  const parsed = schema.safeParse(await readJson(req));
  if (!parsed.success) return json({ error: "Requête invalide", code: "survey_invalid" }, { status: 400 });
  const session = await db.checkoutSession.findUnique({ where: { id }, include: { store: true } });
  if (!session || session.status !== "PAID") return json({ error: "Commande introuvable", code: "survey_unavailable" }, { status: 404 });
  const design = await designFor(session.store, session);
  const block = loadThankYouLayout(design.thankYouLayout).blocks.find((b) => b.type === "survey" && !b.hidden);
  if (!block || block.type !== "survey") return json({ error: "Questionnaire indisponible", code: "survey_unavailable" }, { status: 404 });
  const answer = normalizeSurveyAnswer(parsed.data.answer, block.props.options);
  if (!answer) return json({ error: "Réponse invalide", code: "survey_invalid" }, { status: 400 });
  // Once: a second answer (another tab, a replay) never overwrites the first.
  const saved = await db.checkoutSession.updateMany({ where: { id, status: "PAID", surveyAnswer: null }, data: { surveyAnswer: answer } });
  if (!saved.count) return json({ error: "Déjà répondu", code: "survey_answered" }, { status: 409 });
  return json({ ok: true });
}

export const POST = route("sessions.survey", handle);
