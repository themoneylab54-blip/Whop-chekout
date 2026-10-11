import { db } from "@/lib/db";
import { isForeignSessionHost } from "@/lib/checkout-domain-check";
import { isSameSiteRequest } from "@/lib/host-guard";
import { recordIncident } from "@/lib/incidents";
import { log } from "@/lib/log";
import { clientIp, rateLimit } from "@/lib/ratelimit";
import { route } from "@/lib/route";

/*
 * The checkout page reporting its payment form missing in the buyer's browser (inlineWatchdog,
 * paymentHealth): a sale lost that no one would otherwise see. Journaled as the store's
 * "checkout.form_missing" incident (one row per 5 min, no alert: the health tile shows it) with what
 * the page said, kept to its known fields and cut short; a page merely still loading after 25 s goes
 * to the logs only. Same-origin beacons only; the answer is always empty (204), even for an unknown
 * session (nothing to learn from it).
 */

const MESSAGES = {
  not_booted: "La page de paiement ne s'est pas lancée chez un client (fichiers non chargés ou en erreur)",
  still_loading: "La page de paiement chargeait encore 25 s après son ouverture chez un client",
  prepare_stuck: "Formulaire de paiement ni affiché ni en cours de chargement 12 s après le lancement de la page (redemandé)",
  form_not_ready: "Le formulaire de carte de Whop ne s'est jamais déclaré prêt (30 s)",
  page_error: "La page de paiement a rencontré une erreur chez un client (écran d'erreur affiché)",
} as const;
type Kind = keyof typeof MESSAGES;

/** Largest report read (a few hundred bytes in practice). */
const MAX_BODY = 8_192;

const text = (v: unknown, max = 160) => (typeof v === "string" ? v.slice(0, max) : undefined);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), 0), 3_600_000) : undefined);
const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
/** A short list of small records: its known fields only (strings cut short, numbers bounded). */
const records = (v: unknown, fields: readonly string[]) =>
  Array.isArray(v)
    ? v
        .slice(0, 6)
        .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
        .map((e) => Object.fromEntries(fields.map((f) => [f, typeof e[f] === "number" ? count(e[f]) : text(e[f])]).filter(([, x]) => x !== undefined)))
    : undefined;

/** What the page said, its known fields only. Null: not a report. Pure (exported for tests). */
export function healthReport(raw: unknown): { kind: Kind; data: Record<string, unknown> } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== "string" || !Object.prototype.hasOwnProperty.call(MESSAGES, r.kind)) return null;
  const data: Record<string, unknown> = {
    what: r.kind,
    t: count(r.t),
    state: text(r.state, 20),
    visible: text(r.visible, 20),
    afterReload: r.afterReload === null ? null : flag(r.afterReload),
    errors: records(r.errors, ["res", "msg", "at"]),
    failed: records(r.failed, ["res", "status"]),
    provider: text(r.provider, 20),
    quote: flag(r.quote),
    paypal: flag(r.paypal),
    waitedMs: count(r.waitedMs),
    msg: text(r.msg, 200),
    digest: text(r.digest, 40),
  };
  return { kind: r.kind as Kind, data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
}

const empty = () => new Response(null, { status: 204 });

async function handle(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // The checkout page's own beacon (same origin): never another site.
  if (!isSameSiteRequest(req)) return new Response(null, { status: 403 });
  if (!(await rateLimit(`health:ip:${clientIp(req)}`, 20))) return new Response(null, { status: 429 });
  const body = await req.text().catch(() => "");
  if (body.length > MAX_BODY) return new Response(null, { status: 413 });
  let raw: unknown = null;
  try {
    raw = JSON.parse(body);
  } catch {
    /* not JSON: not a report */
  }
  const report = healthReport(raw);
  if (!report) return new Response(null, { status: 400 });
  // A few reports per session (a page reporting each of its steps), never a flood.
  if (!(await rateLimit(`health:s:${id}`, 5, 10 * 60_000))) return empty();
  if (await isForeignSessionHost(req, id)) return empty();
  const session = await db.checkoutSession.findUnique({ where: { id }, select: { storeId: true } });
  if (!session) return empty();
  // The watchdog's one reload: done (first report), already done (this load came after it), or none
  // (the browser's storage blocked: no reload without a way to do it only once).
  const reload = report.data.afterReload === true ? " : encore après le rechargement automatique" : report.data.afterReload === false ? " : page rechargée automatiquement" : "";
  const message = report.kind === "not_booted" ? `${MESSAGES.not_booted}${reload}` : MESSAGES[report.kind];
  const data = { ...report.data, ua: text(req.headers.get("user-agent"), 200) };
  // A page still loading is a slow connection, not yet a buyer without a way to pay: in the logs only.
  if (report.kind === "still_loading") {
    log.warn("checkout.page_slow", `${message}.`, { storeId: session.storeId, sessionId: id, ...data });
    return empty();
  }
  await recordIncident({ storeId: session.storeId, sessionId: id, kind: "checkout.form_missing", message: `${message}.`, data, alert: false });
  return empty();
}

export const POST = route("sessions.health", handle);
